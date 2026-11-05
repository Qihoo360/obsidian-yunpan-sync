import type { OpenApiMethod } from "../net/openapi-client.js";
import type { StoreClientLike } from "./store-client.js";
import { assertStoreUrl } from "../net/store-url.js";
import { cloudFileHashes } from "./hashes.js";

const DIRECT_UPLOAD_LIMIT = 512 * 1024;

interface Api { call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> }
export interface UploadInput {
  path: string;
  data: Uint8Array;
  ctime: number;
  mtime: number;
  transferId?: string;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
}
interface UploadPreflight { http?: string; https?: string; url?: string; tk?: string; autoCommit?: number | boolean; auto_commit?: number | boolean; small_file?: number | boolean; small_limit?: number }

function storeUrl(result: UploadPreflight): string | undefined {
  const value = result.https ?? result.http ?? result.url;
  if (!value) return undefined;
  return assertStoreUrl(value).toString();
}

function numberSet(value: unknown): Set<number> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value
    .filter((item) => Number((item as { found?: unknown; status?: unknown }).found ?? (item as { status?: unknown }).status) === 1)
    .map((item) => Number((item as { bidx?: unknown }).bidx)).filter(Number.isFinite));
}

export interface TransferProgress {
  getTransferSession(taskId: string): { tid: string; endpoint: string; ticket: string; fileHash: string; finalTicket?: string } | undefined;
  saveTransferSession(taskId: string, session: { tid: string; endpoint: string; ticket: string; fileHash: string; finalTicket?: string }): void;
  completedTransferBlocks(taskId: string): Set<number>;
  completeTransferBlock(taskId: string, blockIndex: number): void;
  clearTransfer(taskId: string): void;
}

export class UploadMachine {
  constructor(private readonly api: Api, private readonly makeStore: (url: string) => StoreClientLike,
    private readonly progress?: TransferProgress, private readonly ownerQid: () => string = () => "0",
    private readonly checkpoint: () => Promise<void> = async () => undefined) {}

  private async persistProgress(): Promise<void> {
    if (this.progress) await this.checkpoint();
  }

  async upload(input: UploadInput): Promise<Record<string, unknown>> {
    const hashes = await cloudFileHashes(input.data);
    const saved = input.transferId ? this.progress?.getTransferSession(input.transferId) : undefined;
    if (saved?.fileHash === hashes.fileHash && saved.finalTicket) {
      const result = await this.api.call<Record<string, unknown>>("Sync.addFile", {
        tk: saved.finalTicket, is_createdir: 1, detail: 1, owner_qid: this.ownerQid(),
      });
      this.progress?.clearTransfer(input.transferId!);
      await this.persistProgress();
      input.onProgress?.(input.data.byteLength, input.data.byteLength);
      return result;
    }
    const preflight: UploadPreflight = saved?.fileHash === hashes.fileHash
      ? { http: saved.endpoint, tk: saved.ticket }
      : await this.api.call<UploadPreflight>("Sync.getUploadFileAddr", {
        fname: input.path, fsize: input.data.byteLength, fhash: hashes.fileHash,
        fctime: Math.floor(input.ctime / 1000), fmtime: Math.floor(input.mtime / 1000), fattr: 0, is_createdir: 1,
      });
    if (preflight.autoCommit === true || Number(preflight.autoCommit ?? preflight.auto_commit) === 1) {
      input.onProgress?.(input.data.byteLength, input.data.byteLength);
      return preflight as Record<string, unknown>;
    }
    const endpoint = saved?.fileHash === hashes.fileHash ? saved.endpoint : storeUrl(preflight);
    const metadata = { tk: preflight.tk ?? "", fname: input.path, fhash: hashes.fileHash,
      fsize: input.data.byteLength, fctime: Math.floor(input.ctime / 1000), fmtime: Math.floor(input.mtime / 1000), fattr: 0 };

    let ticket = preflight.tk ?? "";
    if (!endpoint) {
      if (!ticket) throw new Error("Sync.getAddr returned neither a Store endpoint nor a ticket");
      if (input.transferId) this.progress?.saveTransferSession(input.transferId,
        { tid: "", endpoint: "", ticket, fileHash: hashes.fileHash, finalTicket: ticket });
      await this.persistProgress();
      const result = await this.api.call<Record<string, unknown>>("Sync.addFile", {
        tk: ticket, is_createdir: 1, detail: 1, owner_qid: this.ownerQid(),
      });
      if (input.transferId) this.progress?.clearTransfer(input.transferId);
      await this.persistProgress();
      input.onProgress?.(input.data.byteLength, input.data.byteLength);
      return result;
    }
    const store = this.makeStore(endpoint);
    const smallLimit = Number(preflight.small_limit ?? DIRECT_UPLOAD_LIMIT);
    if (input.data.byteLength <= smallLimit) {
      const response = await store.callJson("Upload.uploadFile", metadata, input.data);
      input.onProgress?.(input.data.byteLength, input.data.byteLength);
      ticket = String(response.tk ?? ticket);
      if (input.transferId) this.progress?.saveTransferSession(input.transferId,
        { tid: "", endpoint, ticket: String(preflight.tk ?? ""), fileHash: hashes.fileHash, finalTicket: ticket });
      await this.persistProgress();
    } else {
      const blockInfo = hashes.blocks.map((block) => ({ bidx: block.index, boffset: block.offset, bsize: block.size, bhash: block.hash }));
      let tid = saved?.fileHash === hashes.fileHash ? saved.tid : "";
      const existing = input.transferId ? this.progress?.completedTransferBlocks(input.transferId) ?? new Set<number>() : new Set<number>();
      if (!tid) {
        const requestBody = new TextEncoder().encode(JSON.stringify({ request: { block_info: blockInfo } }));
        const request = await store.callJson("Upload.request", metadata, requestBody);
        tid = String(request.tid ?? "");
        if (!tid) throw new Error("Upload.request did not return tid");
        for (const index of numberSet(request.block_info)) {
          existing.add(index);
          if (input.transferId) this.progress?.completeTransferBlock(input.transferId, index);
        }
        if (input.transferId) this.progress?.saveTransferSession(input.transferId,
          { tid, endpoint, ticket: String(preflight.tk ?? ""), fileHash: hashes.fileHash });
        await this.persistProgress();
      }
      let completedBytes = hashes.blocks
        .filter((block) => existing.has(block.index))
        .reduce((total, block) => total + block.size, 0);
      if (completedBytes > 0) input.onProgress?.(completedBytes, input.data.byteLength);
      for (const block of hashes.blocks) {
        if (existing.has(block.index)) continue;
        await store.callJson("Upload.block", { qid: "", tid, bhash: block.hash, bidx: block.index,
          boffset: block.offset, bsize: block.size }, input.data.subarray(block.offset, block.offset + block.size));
        if (input.transferId) this.progress?.completeTransferBlock(input.transferId, block.index);
        completedBytes += block.size;
        input.onProgress?.(completedBytes, input.data.byteLength);
        await this.persistProgress();
      }
      const committed = await store.callJson("Upload.commit", { tid });
      ticket = String(committed.tk ?? ticket);
      if (input.transferId) this.progress?.saveTransferSession(input.transferId,
        { tid, endpoint, ticket: String(preflight.tk ?? ""), fileHash: hashes.fileHash, finalTicket: ticket });
      await this.persistProgress();
    }
    if (!ticket) throw new Error("Upload did not return a ticket");
    const result = await this.api.call<Record<string, unknown>>("Sync.addFile", {
      tk: ticket, is_createdir: 1, detail: 1, owner_qid: this.ownerQid(),
    });
    if (input.transferId) this.progress?.clearTransfer(input.transferId);
    await this.persistProgress();
    return result;
  }
}
