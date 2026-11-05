export const CLOUD_BLOCK_SIZE = 512 * 1024;

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
