import type { OpenApiMethod } from "../net/openapi-client.js";
import { assertStoreUrl } from "../net/store-url.js";
import type { StoreClientLike } from "./store-client.js";
import { verifyCloudFileHash } from "./hashes.js";

interface Api { call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> }
export interface DownloadInput {
  path: string;
  nid?: string;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
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
    const response = await this.api.call<DownloadInfo>("Sync.getDownloadInfo", {
      fpath: input.path, nid: input.nid ?? 0, feedback: "", owner_qid: this.ownerQid(),
    });
    const info = unwrapDownloadInfo(response);
    const endpoint = info.https ?? info.http ?? info.url;
    if (!endpoint || !info.fhash) throw new Error("Sync.getDownloadInfo returned incomplete metadata");
    const store = this.makeStore(assertStoreUrl(endpoint).toString());
    const size = Number(info.fsize ?? info.size ?? 0);
    if (size === 0) { input.onProgress?.(0, 0); return new Uint8Array(); }
    const chunks: Uint8Array[] = [];
    let completedBytes = 0;
    const chunkSize = Number(info.chunk_size ?? 0);
    if (chunkSize > 0) {
      for (let start = 0; start < size; start += chunkSize) {
        const end = Math.min(size - 1, start + chunkSize - 1);
        const chunk = await store.download("Download.downloadBlockV2", { fhash: info.fhash, dt: info.dt ?? "", bsize: end - start + 1, filesize: size }, { start, end });
        chunks.push(chunk);
        completedBytes += chunk.byteLength;
        input.onProgress?.(completedBytes, size);
      }
    } else {
      const metadata = await store.callJson("Download.getMetaInfo", { fhash: info.fhash, nid: input.nid ?? 0, dt: info.dt ?? "" });
      const blocks = (metadata.block_info ?? metadata.bmetas) as Array<Record<string, unknown>>;
      if (!Array.isArray(blocks)) throw new Error("Download.getMetaInfo returned no block list");
      blocks.sort((left, right) => Number(left.bidx ?? 0) - Number(right.bidx ?? 0));
      for (const block of blocks) {
        const chunk = await store.download("Download.downloadBlock", { bhash: block.bhash, dt: block.dt ?? info.dt ?? "" });
        chunks.push(chunk);
        completedBytes += chunk.byteLength;
        input.onProgress?.(completedBytes, size);
      }
    }
    const result = concat(chunks, size);
    if (!await verifyCloudFileHash(result, info.fhash)) throw new Error("Downloaded file hash verification failed");
    return result;
  }
}
