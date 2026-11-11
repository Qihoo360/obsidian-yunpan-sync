import type { OpenApiMethod } from "../net/openapi-client.js";
import { assertStoreUrl } from "../net/store-url.js";
import type { StoreClientLike } from "./store-client.js";
import { CloudHashAccumulator } from "./hashes.js";
import type { BinarySink } from "./file-io.js";
import { WorkScheduler } from "../sync/work-scheduler.js";

interface Api { call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> }
export interface DownloadInput {
  path: string;
  nid?: string;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
  check?: () => void;
  onStage?: (stage: "download" | "verify") => void;
  validateSize?: (size: number) => void;
}
interface DownloadInfo { http?: string; https?: string; url?: string; fhash?: string; fsize?: number; size?: number; chunk_size?: number; dt?: string; file_info?: Record<string, DownloadInfo> | DownloadInfo[] }

function unwrapDownloadInfo(response: DownloadInfo): DownloadInfo {
  if (!response.file_info) return response;
  const value = Array.isArray(response.file_info) ? response.file_info[0] : Object.values(response.file_info)[0];
  if (!value) throw new Error("Sync.getDownloadInfo returned no file_info");
  return value;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  if (offset !== size) throw new Error("Downloaded size does not match metadata");
  return result;
}

export class DownloadMachine {
  constructor(private readonly api: Api, private readonly makeStore: (url: string) => StoreClientLike,
    private readonly ownerQid: () => string = () => "0") {}

  async download(input: DownloadInput): Promise<Uint8Array> {
    return (await this.run(input))!;
  }

  async downloadTo(input: DownloadInput, sink: BinarySink): Promise<void> {
    await this.run(input, sink);
  }

  private async run(input: DownloadInput, sink?: BinarySink): Promise<Uint8Array | undefined> {
    input.check?.();
    const response = await this.api.call<DownloadInfo>("Sync.getDownloadInfo", {
      fpath: input.path, nid: input.nid ?? 0, feedback: "", owner_qid: this.ownerQid(),
    });
    const info = unwrapDownloadInfo(response);
    input.check?.();
    const endpoint = info.https ?? info.http ?? info.url;
    if (!endpoint || !info.fhash) throw new Error("Sync.getDownloadInfo returned incomplete metadata");
    const store = this.makeStore(assertStoreUrl(endpoint).toString());
    const size = Number(info.fsize ?? info.size ?? -1);
    input.validateSize?.(size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid download size");
    const chunks: Uint8Array[] = [];
    const hash = new CloudHashAccumulator();
    const work = new WorkScheduler(input.check);
    let completedBytes = 0;
    const accept = async (chunk: Uint8Array) => {
      input.check?.();
      if (completedBytes + chunk.length > size) throw new Error("Downloaded size does not match metadata");
      await hash.update(chunk);
      if (sink) await sink.write(chunk); else chunks.push(chunk);
      completedBytes += chunk.length;
      input.onProgress?.(completedBytes, size);
      await work.step();
    };
    input.onStage?.("download");
    const advertisedChunkSize = Number(info.chunk_size ?? 0);
    if (!Number.isSafeInteger(advertisedChunkSize) || advertisedChunkSize < 0) throw new Error("Invalid download chunk size");
    const chunkSize = Math.min(1024 * 1024, advertisedChunkSize);
    if (chunkSize > 0) {
      for (let start = 0; start < size; start += chunkSize) {
        input.check?.();
        const end = Math.min(size - 1, start + chunkSize - 1);
        const chunk = await store.download("Download.downloadBlockV2", { fhash: info.fhash, dt: info.dt ?? "", bsize: end - start + 1, filesize: size }, { start, end });
        if (chunk.length !== end - start + 1) throw new Error("Downloaded size does not match metadata");
        await accept(chunk);
      }
    } else if (size > 0) {
      const metadata = await store.callJson("Download.getMetaInfo", { fhash: info.fhash, nid: input.nid ?? 0, dt: info.dt ?? "" });
      input.check?.();
      const blocks = (metadata.block_info ?? metadata.bmetas) as Array<Record<string, unknown>>;
      if (!Array.isArray(blocks)) throw new Error("Download.getMetaInfo returned no block list");
      blocks.sort((left, right) => Number(left.bidx ?? 0) - Number(right.bidx ?? 0));
      for (const block of blocks) {
        input.check?.();
        const chunk = await store.download("Download.downloadBlock", { bhash: block.bhash, dt: block.dt ?? info.dt ?? "" });
        await accept(chunk);
      }
    }
    if (completedBytes !== size) throw new Error("Downloaded size does not match metadata");
    input.check?.();
    input.onStage?.("verify");
    if ((await hash.finish()).toLowerCase() !== info.fhash.toLowerCase()) throw new Error("Downloaded file hash verification failed");
    input.check?.();
    if (size === 0) input.onProgress?.(0, 0);
    return sink ? undefined : concat(chunks, size);
  }
}
