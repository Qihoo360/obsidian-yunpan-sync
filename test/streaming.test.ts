import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, open, stat, readFile, writeFile, rename, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Platform } from "obsidian";
import { hashSource, cloudFileHashes, CloudHashAccumulator, CLOUD_BLOCK_SIZE } from "../src/transfer/hashes.js";
import { openDesktopSource, openDesktopSink, type BinarySource } from "../src/transfer/file-io.js";
import { DownloadMachine } from "../src/transfer/download.js";
import { UploadMachine } from "../src/transfer/upload.js";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncDatabase } from "../src/storage/database.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import initSqlJs from "sql.js";

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "obsidian-stream-test-"));
  directories.push(root);
  const adapter = {
    getBasePath: () => root,
    readBinary: vi.fn(async (path: string) => (await readFile(join(root, path))).buffer),
    writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => writeFile(join(root, path), new Uint8Array(bytes))),
    exists: async (path: string) => { try { await access(join(root, path)); return true; } catch { return false; } },
    stat: async (path: string) => {
      try { const info = await stat(join(root, path)); return { type: info.isDirectory() ? "folder" : "file",
        size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs }; } catch { return null; }
    },
    rename: async (source: string, destination: string) => rename(join(root, source), join(root, destination)),
    remove: async (path: string) => rm(join(root, path)),
  };
  return { root, adapter };
}

afterEach(async () => {
  Platform.isDesktopApp = true;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("bounded desktop file IO", () => {
  it("hashes and uploads a sparse file over 500 MiB with reads limited to 512 KiB", async () => {
    const { root, adapter } = await fixture();
    const size = 501 * 1024 * 1024 + 13;
    const file = await open(join(root, "video.mp4"), "w");
    await file.truncate(size); await file.close();
    const source = (await openDesktopSource(adapter as never, "video.mp4"))!;
    let maxRead = 0, reads = 0;
    const monitored: BinarySource = { ...source, read: async (offset, length) => {
      maxRead = Math.max(maxRead, length); reads++; return source.read(offset, length);
    } };
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    try {
      const hashes = await hashSource(monitored);
      const firstHash = (await cloudFileHashes(new Uint8Array(CLOUD_BLOCK_SIZE))).blocks[0]!.hash;
      const lastHash = (await cloudFileHashes(new Uint8Array(13))).blocks[0]!.hash;
      const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(firstHash.repeat(Math.floor(size / CLOUD_BLOCK_SIZE)) + lastHash));
      expect(hashes.fileHash).toBe(Buffer.from(digest).toString("hex"));
      expect(hashes.blocks).toHaveLength(Math.ceil(size / CLOUD_BLOCK_SIZE));
      const api = { call: vi.fn(async () => ({ autoCommit: 1, nid: "video" })) };
      const makeStore = vi.fn();
      await new UploadMachine(api as never, makeStore).upload({ path: "/Vault/video.mp4", source: monitored,
        ctime: 0, mtime: 0, expectedHash: hashes.fileHash });
      expect(api.call).toHaveBeenCalledWith("Sync.getUploadFileAddr", expect.objectContaining({ fsize: size, fhash: hashes.fileHash }));
      expect(makeStore).not.toHaveBeenCalled();
      expect(maxRead).toBe(CLOUD_BLOCK_SIZE);
      expect(reads).toBe(hashes.blocks.length * 2);
      let uploaded = 0;
      const store = { callJson: async (method: string, _params: unknown, bytes?: Uint8Array) => {
        if (method === "Upload.request") return { tid: "session", block_info: [] };
        if (method === "Upload.block") {
          expect(bytes!.length).toBeLessThanOrEqual(CLOUD_BLOCK_SIZE);
          uploaded += bytes!.length;
          return {};
        }
        if (method === "Upload.commit") return { tk: "done" };
        throw new Error(`Unexpected ${method}`);
      } };
      const blockApi = { call: async (method: string) => method === "Sync.getUploadFileAddr"
        ? { https: "https://up1.yunpan.360.cn/intf.php", tk: "ticket" } : { nid: "video" } };
      await new UploadMachine(blockApi as never, () => store as never).upload({ path: "/Vault/video.mp4",
        source: monitored, ctime: 0, mtime: 0, expectedHash: hashes.fileHash });
      expect(uploaded).toBe(size);
      expect(maxRead).toBe(CLOUD_BLOCK_SIZE);
      expect(heartbeats).toBeGreaterThan(5);
      expect(adapter.readBinary).not.toHaveBeenCalled();
    } finally { clearInterval(timer); await source.close(); }
  }, 60_000);

  it("downloads over 500 MiB straight to disk with ranges capped at 1 MiB", async () => {
    const { root, adapter } = await fixture();
    const size = 501 * 1024 * 1024 + 13;
    const firstHash = (await cloudFileHashes(new Uint8Array(CLOUD_BLOCK_SIZE))).blocks[0]!.hash;
    const lastHash = (await cloudFileHashes(new Uint8Array(13))).blocks[0]!.hash;
    const hash = Buffer.from(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(
      firstHash.repeat(Math.floor(size / CLOUD_BLOCK_SIZE)) + lastHash))).toString("hex");
    const sink = (await openDesktopSink(adapter as never, "video.part"))!;
    let received = 0, written = 0, maxRetained = 0, requests = 0;
    const api = { call: async () => ({ http: "https://dl1.yunpan.360.cn/intf.php", fhash: hash, fsize: size, chunk_size: size }) };
    const store = { callJson: vi.fn(), download: async (_method: string, _params: unknown, range?: { start: number; end: number }) => {
      expect(received).toBe(written);
      const length = range!.end - range!.start + 1;
      expect(length).toBeLessThanOrEqual(1024 * 1024);
      received += length; requests++;
      maxRetained = Math.max(maxRetained, received - written);
      return new Uint8Array(length);
    } };
    try {
      await new DownloadMachine(api as never, () => store).downloadTo({ path: "/Vault/video.mp4" }, {
        write: async bytes => { await sink.write(bytes); written += bytes.length; },
      });
    } finally { await sink.close(); }
    expect((await stat(join(root, "video.part"))).size).toBe(size);
    expect(written).toBe(size);
    expect(requests).toBe(Math.ceil(size / (1024 * 1024)));
    expect(maxRetained).toBeLessThanOrEqual(1024 * 1024);
    expect(adapter.writeBinary).not.toHaveBeenCalled();
  }, 60_000);

  it("matches the original cloud hash across unaligned network chunks and empty files", async () => {
    const bytes = new Uint8Array(CLOUD_BLOCK_SIZE * 2 + 17).map((_, i) => i % 251);
    const accumulator = new CloudHashAccumulator();
    for (let i = 0; i < bytes.length; i += 300_001) await accumulator.update(bytes.subarray(i, i + 300_001));
    expect(await accumulator.finish()).toBe((await cloudFileHashes(bytes)).fileHash);
    expect(await new CloudHashAccumulator().finish()).toBe((await cloudFileHashes(new Uint8Array())).fileHash);
  });

  it("detects local mutation and never opens Node files when using the mobile adapter", async () => {
    const { root, adapter } = await fixture();
    await writeFile(join(root, "note.md"), "old");
    const source = (await openDesktopSource(adapter as never, "note.md"))!;
    try {
      await writeFile(join(root, "note.md"), "changed");
      await expect(source.assertUnchanged()).rejects.toThrow("changed while reading");
    } finally { await source.close(); }
    Platform.isDesktopApp = false;
    const getBasePath = vi.fn(() => { throw new Error("mobile must not access Node"); });
    expect(await openDesktopSource({ getBasePath } as never, "note.md")).toBeUndefined();
    expect(await openDesktopSink({ getBasePath } as never, "note.part")).toBeUndefined();
    expect(getBasePath).not.toHaveBeenCalled();
  });

  it.each(["hash", "disk", "cancel", "changed", "replace"])("keeps the target and removes temporary data after %s failure", async failure => {
    const { root, adapter } = await fixture();
    await writeFile(join(root, "note.md"), "original");
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const database = new SyncDatabase(new SQL.Database());
    if (failure === "disk") {
      const probe = await open(join(root, "note.md"), "r");
      const prototype = Object.getPrototypeOf(probe);
      await probe.close();
      vi.spyOn(prototype, "write").mockRejectedValue(new Error("ENOSPC"));
    }
    const downloader = { downloadTo: async (_input: unknown, sink: { write(bytes: Uint8Array): Promise<void> }) => {
      await sink.write(new TextEncoder().encode("new"));
      if (failure === "hash") throw new Error("hash mismatch");
      if (failure === "cancel") engine.cancel();
      if (failure === "changed") await writeFile(join(root, "note.md"), "edited during download");
    } };
    const engine = new SyncEngine({ adapter, getAbstractFileByPath: () => null } as never,
      database, {} as never, {} as never, downloader as never, () => DEFAULT_SETTINGS, "account", () => undefined);
    if (failure === "replace") {
      const original = adapter.rename;
      adapter.rename = async (source, destination) => {
        if (source.endsWith(".part")) throw new Error("replacement failed");
        return original(source, destination);
      };
    }
    const originalStat = await adapter.stat("note.md");
    const task = { id: "download", kind: "download", path: "note.md", payload: {
      local: { kind: "file", size: originalStat!.size, mtime: originalStat!.mtime }, remote: { kind: "file", size: 3, mtime: 1 } } };
    await expect((engine as unknown as { download(task: unknown): Promise<void> }).download(task)).rejects.toThrow();
    expect(await readFile(join(root, "note.md"), "utf8")).toBe(failure === "changed" ? "edited during download" : "original");
    const fs = await import("node:fs/promises");
    expect(await fs.readdir(root)).toEqual(["note.md"]);
    expect(database.getBase("note.md")).toBeUndefined();
    database.close();
  });

  it("publishes a verified desktop download through the adapter and preserves its mtime", async () => {
    const { root, adapter } = await fixture();
    await writeFile(join(root, "note.md"), "original");
    const before = (await adapter.stat("note.md"))!;
    const bytes = new TextEncoder().encode("# Downloaded\n");
    const hash = (await cloudFileHashes(bytes)).fileHash;
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const database = new SyncDatabase(new SQL.Database());
    const downloader = new DownloadMachine({ call: async () => ({ https: "https://dl1.yunpan.360.cn/intf.php",
      fhash: hash, fsize: bytes.length, chunk_size: 1024 }) } as never,
      () => ({ download: async () => bytes } as never));
    const engine = new SyncEngine({ adapter, getAbstractFileByPath: () => null } as never,
      database, {} as never, {} as never, downloader, () => DEFAULT_SETTINGS, "account", () => undefined);
    const remote = { kind: "file", size: bytes.length, hash, mtime: 1_700_000_000 };
    const task = { id: "download", path: "note.md", payload: { remote,
      local: { kind: "file", size: before.size, mtime: before.mtime } } };
    await (engine as unknown as { download(task: unknown): Promise<void> }).download(task);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("# Downloaded\n");
    expect((await adapter.stat("note.md"))!.mtime).toBe(remote.mtime * 1000);
    expect(database.getBase("note.md")).toMatchObject(remote);
    expect(adapter.writeBinary).not.toHaveBeenCalled();
    database.close();
  });

  it("refuses an upload whose current hash differs from the confirmed plan", async () => {
    const api = { call: vi.fn() };
    await expect(new UploadMachine(api as never, vi.fn()).upload({ path: "/Vault/note.md",
      data: new TextEncoder().encode("edited"), ctime: 0, mtime: 0, expectedHash: "0".repeat(40) }))
      .rejects.toThrow("changed since sync planning");
    expect(api.call).not.toHaveBeenCalled();
  });
});
