import { describe, expect, it, vi } from "vitest";
import { UploadMachine } from "../src/transfer/upload.js";
import type { TransferProgress } from "../src/transfer/upload.js";
import { DownloadMachine } from "../src/transfer/download.js";
import { cloudFileHashes } from "../src/transfer/hashes.js";

describe("upload state machine", () => {
  it("binds a server-side duplicate without contacting Store", async () => {
    const data = new Uint8Array(12).fill(5);
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ tk: "duplicate-ticket", autoCommit: 0 })
      .mockResolvedValueOnce({ nid: "9" }) };
    const makeStore = vi.fn(() => { throw new Error("Store must not be used for a duplicate"); });

    await expect(new UploadMachine(api, makeStore).upload({
      path: "/Root/a.bin", data, ctime: 1, mtime: 2,
    })).resolves.toMatchObject({ nid: "9" });

    expect(makeStore).not.toHaveBeenCalled();
    expect(api.call).toHaveBeenLastCalledWith("Sync.addFile", expect.objectContaining({ tk: "duplicate-ticket" }));
  });

  it("uploads only missing blocks then binds the returned ticket", async () => {
    const data = new Uint8Array(512 * 1024 + 2).fill(7);
    const hashes = await cloudFileHashes(data);
    const api = { call: vi.fn().mockResolvedValueOnce({ http: "https://up1.yunpan.360.cn/intf.php", tk: "pre" }).mockResolvedValueOnce({ nid: "9" }) };
    const store = { callJson: vi.fn()
      .mockResolvedValueOnce({ tid: "t1", block_info: [{ bidx: 1, found: 1 }, { bidx: 2, found: 0 }] })
      .mockResolvedValueOnce({ ok: 1 })
      .mockResolvedValueOnce({ tk: "final" }), download: vi.fn() };
    const progress = vi.fn();
    const uploader = new UploadMachine(api, () => store, undefined, () => "88");
    await uploader.upload({ path: "/Root/a.bin", data, ctime: 1, mtime: 2, onProgress: progress });
    expect(store.callJson.mock.calls.map((call) => call[0])).toEqual(["Upload.request", "Upload.block", "Upload.commit"]);
    expect(store.callJson.mock.calls[1]?.[1].bidx).toBe(2);
    expect(store.callJson.mock.calls[1]?.[1].bhash).toBe(hashes.blocks[1]?.hash);
    expect(api.call).toHaveBeenLastCalledWith("Sync.addFile", expect.objectContaining({ tk: "final", owner_qid: "88" }));
    expect(progress).toHaveBeenLastCalledWith(data.byteLength, data.byteLength);
  });

  it("resumes an interrupted block session and skips completed blocks", async () => {
    const data = new Uint8Array(512 * 1024 + 2).fill(9);
    let session: ReturnType<TransferProgress["getTransferSession"]>;
    const completed = new Set<number>();
    const progress: TransferProgress = {
      getTransferSession: () => session,
      saveTransferSession: (_id, value) => { session = value; },
      completedTransferBlocks: () => new Set(completed),
      completeTransferBlock: (_id, index) => { completed.add(index); },
      clearTransfer: () => { session = undefined; completed.clear(); },
    };
    const api = { call: vi.fn().mockResolvedValueOnce({ http: "https://up1.yunpan.360.cn/intf.php", tk: "pre" }).mockResolvedValueOnce({ nid: "9" }) };
    let failed = false;
    const firstStore = { download: vi.fn(), callJson: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "Upload.request") return { tid: "t1", block_info: [] };
      if (method === "Upload.block" && Number(params.bidx) === 2 && !failed) { failed = true; throw new Error("offline"); }
      return {};
    }) };
    const input = { path: "/Root/a.bin", data, ctime: 1, mtime: 2, transferId: "task" };
    await expect(new UploadMachine(api, () => firstStore, progress).upload(input)).rejects.toThrow("offline");
    expect(completed).toEqual(new Set([1]));

    const secondStore = { download: vi.fn(), callJson: vi.fn(async (method: string) => method === "Upload.commit" ? { tk: "final" } : {}) };
    await expect(new UploadMachine(api, () => secondStore, progress).upload(input)).resolves.toMatchObject({ nid: "9" });
    expect(secondStore.callJson.mock.calls.map((call) => call[0])).toEqual(["Upload.block", "Upload.commit"]);
    expect(api.call).toHaveBeenCalledTimes(2);
  });

  it("persists a small-file ticket before binding so only the binding is retried", async () => {
    const data = new Uint8Array(12).fill(4);
    let session: ReturnType<TransferProgress["getTransferSession"]>;
    const progress: TransferProgress = {
      getTransferSession: () => session,
      saveTransferSession: (_id, value) => { session = value; },
      completedTransferBlocks: () => new Set(),
      completeTransferBlock: vi.fn(),
      clearTransfer: () => { session = undefined; },
    };
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ http: "https://up1.yunpan.360.cn/intf.php", tk: "pre" })
      .mockRejectedValueOnce(new Error("binding offline"))
      .mockResolvedValueOnce({ nid: "9" }) };
    const store = { callJson: vi.fn().mockResolvedValue({ tk: "small-final" }), download: vi.fn() };
    const uploader = new UploadMachine(api, () => store, progress);
    const input = { path: "/Root/a.bin", data, ctime: 1, mtime: 2, transferId: "small-task" };

    await expect(uploader.upload(input)).rejects.toThrow("binding offline");
    expect(session?.finalTicket).toBe("small-final");
    await expect(uploader.upload(input)).resolves.toMatchObject({ nid: "9" });
    expect(store.callJson).toHaveBeenCalledTimes(1);
    expect(api.call).toHaveBeenCalledTimes(3);
  });
});

describe("download state machine", () => {
  it("downloads ranges and verifies the cloud file hash", async () => {
    const data = new Uint8Array(600_000).fill(3);
    const { fileHash } = await cloudFileHashes(data);
    const api = { call: vi.fn().mockResolvedValue({ file_info: { "9": { http: "https://dl1.yunpan.360.cn/intf.php", fhash: fileHash, fsize: data.length, chunk_size: 300_000, dt: "d" } } }) };
    const store = { download: vi.fn(async (_method: string, _params: Record<string, unknown>, range?: { start: number; end: number }) => data.slice(range!.start, range!.end + 1)), callJson: vi.fn() };
    const downloader = new DownloadMachine(api, () => store, () => "88");
    const progress = vi.fn();
    await expect(downloader.download({ path: "/Root/a.bin", nid: "9", onProgress: progress })).resolves.toEqual(data);
    expect(api.call).toHaveBeenCalledWith("Sync.getDownloadInfo", expect.objectContaining({ owner_qid: "88" }));
    expect(store.download).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls).toEqual([[300_000, 600_000], [600_000, 600_000]]);
  });

  it("downloads legacy blocks in index order and verifies the assembled file", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4, 5]);
    const data = new Uint8Array([...first, ...second]);
    const { fileHash } = await cloudFileHashes(data);
    const api = { call: vi.fn().mockResolvedValue({ http: "https://dl1.yunpan.360.cn/intf.php", fhash: fileHash, fsize: data.length, dt: "d" }) };
    const store = {
      callJson: vi.fn().mockResolvedValue({ block_info: [
        { bidx: 2, bhash: "second", dt: "b" },
        { bidx: 1, bhash: "first", dt: "a" },
      ] }),
      download: vi.fn(async (_method: string, params: Record<string, unknown>) => params.bhash === "first" ? first : second),
    };

    await expect(new DownloadMachine(api, () => store).download({ path: "/Root/a.bin", nid: "9" })).resolves.toEqual(data);
    expect(store.download.mock.calls.map((call) => call[1].bhash)).toEqual(["first", "second"]);
  });

  it("rejects a response whose downloaded size differs from metadata", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const { fileHash } = await cloudFileHashes(expected);
    const api = { call: vi.fn().mockResolvedValue({ http: "https://dl1.yunpan.360.cn/intf.php", fhash: fileHash, fsize: 3, chunk_size: 3 }) };
    const store = { callJson: vi.fn(), download: vi.fn().mockResolvedValue(new Uint8Array([1, 2])) };

    await expect(new DownloadMachine(api, () => store).download({ path: "/Root/a.bin" }))
      .rejects.toThrow("Downloaded size does not match metadata");
  });

  it("rejects downloaded bytes whose cloud hash does not match", async () => {
    const expected = new Uint8Array([1, 2, 3]);
    const { fileHash } = await cloudFileHashes(expected);
    const api = { call: vi.fn().mockResolvedValue({ http: "https://dl1.yunpan.360.cn/intf.php", fhash: fileHash, fsize: 3, chunk_size: 3 }) };
    const store = { callJson: vi.fn(), download: vi.fn().mockResolvedValue(new Uint8Array([3, 2, 1])) };

    await expect(new DownloadMachine(api, () => store).download({ path: "/Root/a.bin" }))
      .rejects.toThrow("Downloaded file hash verification failed");
  });
});
