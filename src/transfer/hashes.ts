export const CLOUD_BLOCK_SIZE = 512 * 1024;
import type { BinarySource } from "./file-io.js";
import { WorkScheduler } from "../sync/work-scheduler.js";

export interface CloudBlockHash {
  index: number;
  offset: number;
  size: number;
  hash: string;
}

export interface CloudFileHashes {
  fileHash: string;
  blocks: CloudBlockHash[];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha1(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-1", copy.buffer);
  return bytesToHex(new Uint8Array(digest));
}

export async function cloudFileHashes(data: Uint8Array): Promise<CloudFileHashes> {
  const blocks: CloudBlockHash[] = [];
  if (data.byteLength === 0) {
    return { fileHash: await sha1(new TextEncoder().encode("")), blocks: [] };
  }
  for (let offset = 0, index = 1; offset < data.byteLength; offset += CLOUD_BLOCK_SIZE, index++) {
    const chunk = data.subarray(offset, Math.min(offset + CLOUD_BLOCK_SIZE, data.byteLength));
    blocks.push({ index, offset, size: chunk.byteLength, hash: await sha1(chunk) });
  }
  const fileHash = await sha1(new TextEncoder().encode(blocks.map((block) => block.hash).join("")));
  return { fileHash, blocks };
}

export async function verifyCloudFileHash(data: Uint8Array, expected: string): Promise<boolean> {
  return (await cloudFileHashes(data)).fileHash.toLowerCase() === expected.toLowerCase();
}

export async function hashSource(source: BinarySource, check: () => void = () => undefined,
  progress: (bytes: number) => void = () => undefined, scheduler?: WorkScheduler): Promise<CloudFileHashes> {
  const blocks: CloudBlockHash[] = [];
  const work = scheduler ?? new WorkScheduler(check);
  for (let offset = 0, index = 1; offset < source.size; offset += CLOUD_BLOCK_SIZE, index++) {
    check();
    const size = Math.min(CLOUD_BLOCK_SIZE, source.size - offset);
    const bytes = await work.waitFor(() => source.read(offset, size));
    if (bytes.length !== size) throw new Error("Local file size changed while hashing");
    blocks.push({ index, offset, size, hash: await sha1(bytes) });
    progress(offset + size);
    await work.step();
  }
  await source.assertUnchanged();
  return { blocks, fileHash: await sha1(new TextEncoder().encode(blocks.map(block => block.hash).join(""))) };
}

/** Network chunk boundaries need not align with cloud hash block boundaries. */
export class CloudHashAccumulator {
  private readonly pending = new Uint8Array(CLOUD_BLOCK_SIZE);
  private used = 0;
  private readonly hashes: string[] = [];

  async update(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const length = Math.min(CLOUD_BLOCK_SIZE - this.used, bytes.length - offset);
      this.pending.set(bytes.subarray(offset, offset + length), this.used);
      this.used += length; offset += length;
      if (this.used === CLOUD_BLOCK_SIZE) {
        this.hashes.push(await sha1(this.pending));
        this.used = 0;
      }
    }
  }

  async finish(): Promise<string> {
    if (this.used) { this.hashes.push(await sha1(this.pending.subarray(0, this.used))); this.used = 0; }
    return sha1(new TextEncoder().encode(this.hashes.join("")));
  }
}
