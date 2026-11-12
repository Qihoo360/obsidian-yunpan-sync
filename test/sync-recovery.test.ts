import { afterEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { SyncDatabase } from "../src/storage/database.js";
import { TaskRunner, isRetryableTaskError } from "../src/sync/task-runner.js";
import { DownloadCache, DownloadCacheError, discardDownloads } from "../src/transfer/download-cache.js";
import { DownloadMachine } from "../src/transfer/download.js";
import { cloudFileHashes } from "../src/transfer/hashes.js";
import { OpenApiClient, OpenApiError } from "../src/net/openapi-client.js";
import { RequestScheduler } from "../src/net/request-scheduler.js";
import { classifySyncError } from "../src/sync/error-guidance.js";

async function database(bytes?: Uint8Array) {
  const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
  return new SyncDatabase(new SQL.Database(bytes));
}

function adapterFixture() {
  const files = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  return { files, folders, adapter: {
    exists: async (path: string) => files.has(path) || folders.has(path),
    stat: async (path: string) => files.has(path) ? { type: "file", size: files.get(path)!.byteLength, ctime: 0, mtime: 0 }
      : folders.has(path) ? { type: "folder", size: 0, ctime: 0, mtime: 0 } : null,
    mkdir: async (path: string) => {
      if (files.has(path)) throw new Error("ENOTDIR");
      folders.add(path);
    },
    rmdir: async (path: string, recursive = false) => {
      if (!recursive && ([...files.keys(), ...folders].some(entry => entry.startsWith(`${path}/`)))) throw new Error("not empty");
      if (recursive) {
        for (const entry of [...files.keys()]) if (entry === path || entry.startsWith(`${path}/`)) files.delete(entry);
        for (const entry of [...folders]) if (entry === path || entry.startsWith(`${path}/`)) folders.delete(entry);
      } else folders.delete(path);
    },
    remove: async (path: string) => {
      if (folders.has(path)) throw new Error("EISDIR");
      files.delete(path);
    },
    writeBinary: async (path: string, bytes: ArrayBuffer) => {
      if (folders.has(path)) throw new Error("EISDIR");
      if (!folders.has(path.slice(0, path.lastIndexOf("/")))) throw new Error("ENOENT");
      files.set(path, new Uint8Array(bytes).slice());
    },
    readBinary: async (path: string) => {
      if (!files.has(path)) throw new Error("missing");
      return files.get(path)!.slice().buffer;
    },
    list: async (path: string) => ({
      files: [...files.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")),
      folders: [...folders].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")),
    }),
  } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("durable synchronization recovery", () => {
  it("waits for a delayed retry and finishes without a queued-task error", async () => {
    const db = await database();
    db.enqueue({ id: "file", kind: "upload", path: "a.md", payload: {} });
    const upload = vi.fn().mockRejectedValueOnce(new Error("network timeout")).mockResolvedValue(undefined);
    const waiting = vi.fn();
    const runner = new TaskRunner(db, { upload }, { waitForRetries: true, retryDelay: () => 10, onRetryWait: waiting });
    await runner.drain();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(waiting).toHaveBeenCalled();
    expect(() => runner.assertSettled()).not.toThrow();
  });

  it("can stop during retry backoff without spending another attempt", async () => {
    const db = await database();
    db.enqueue({ id: "file", kind: "upload", path: "a.md", payload: {} });
    let cancelled = false;
    const upload = vi.fn(async () => { throw new Error("offline"); });
    const runner = new TaskRunner(db, { upload }, { waitForRetries: true, retryDelay: () => 60_000,
      shouldCancel: () => cancelled, onRetryWait: () => { cancelled = true; } });
    await runner.drain();
    expect(upload).toHaveBeenCalledOnce();
    expect(db.listPendingTasks()[0]).toMatchObject({ state: "retry", attempt: 1 });
  });

  it("restores interrupted tasks without a failure or an extra attempt and keeps upload sessions", async () => {
    const db = await database();
    db.enqueue({ id: "file", kind: "upload", path: "a.md", payload: {} });
    db.markTaskRunning("file");
    db.saveTransferSession("file", { tid: "session", endpoint: "https://up1.yunpan.360.cn/", ticket: "ticket", fileHash: "hash" });
    const restored = await database(db.export());
    restored.recoverInterruptedTasks();
    expect(restored.listFailedTasks()).toEqual([]);
    expect(restored.listPendingTasks()[0]).toMatchObject({ state: "queued", attempt: 0, lastError: undefined });
    expect(restored.getTransferSession("file")?.tid).toBe("session");
  });

  it("does not execute children before their parent succeeds and continues independent work", async () => {
    const db = await database();
    for (const path of ["parent/child", "independent", "parent"]) db.enqueue({ id: path, kind: "mkdir", path, payload: {} });
    let parentAttempts = 0;
    const order: string[] = [];
    await new TaskRunner(db, { mkdir: async task => {
      order.push(task.path);
      if (task.path === "parent" && ++parentAttempts === 1) throw new Error("request frequently,please retry");
      if (task.path === "parent/child") expect(parentAttempts).toBe(2);
    } }, { dependencies: true, waitForRetries: true, retryDelay: () => 5 }).drain();
    expect(order).toEqual(["independent", "parent", "parent", "parent/child"]);
  });

  it("uses a shared five-file limit for both transfer directions", async () => {
    const db = await database();
    for (let i = 0; i < 12; i++) db.enqueue({ id: String(i), path: `${i}.md`, kind: i % 2 ? "upload" : "download", payload: {} });
    let active = 0, peak = 0;
    const directions = new Set<string>();
    const execute = async (task: { kind: string }) => {
      active++; peak = Math.max(peak, active); directions.add(task.kind);
      await new Promise(resolve => setTimeout(resolve, 3)); active--;
    };
    await new TaskRunner(db, { upload: execute, download: execute }, { kinds: ["upload", "download"], concurrency: 5 }).drain();
    expect(peak).toBe(5);
    expect(directions).toEqual(new Set(["upload", "download"]));
  });

  it.each(["restart", "corruption", "changed", "account"])("resumes verified download blocks after %s", async scenario => {
    const { adapter, files } = adapterFixture();
    let db = await database();
    const bytes = new Uint8Array(150_000).fill(7);
    let hash = (await cloudFileHashes(bytes)).fileHash;
    let first = true;
    const reads: number[] = [];
    const store = { callJson: vi.fn(), download: vi.fn(async (_method: string, _params: unknown, range?: { start: number; end: number }) => {
      reads.push(range!.start);
      if (first && range!.start === 50_000) { first = false; throw new Error("offline"); }
      return bytes.slice(range!.start, range!.end + 1);
    }) };
    const api = { call: vi.fn(async () => ({ https: "https://down1.yunpan.360.cn/intf.php", fhash: hash, fsize: bytes.length, chunk_size: 50_000 })) };
    const input = { path: "/Root/a.bin", nid: "node", resume: new DownloadCache(adapter as never, db, "account-A", "task", async () => {}) };
    await expect(new DownloadMachine(api as never, () => store).download(input)).rejects.toThrow("offline");
    expect(reads).toEqual([0, 50_000]);
    db = await database(db.export());
    if (scenario === "corruption") {
      const path = [...files.keys()].find(path => path.endsWith("/0.part"))!;
      files.set(path, new Uint8Array(50_000).fill(99));
    }
    if (scenario === "changed") { bytes.fill(8); hash = (await cloudFileHashes(bytes)).fileHash; }
    const resume = new DownloadCache(adapter as never, db, scenario === "account" ? "account-B" : "account-A", "task", async () => {});
    reads.length = 0;
    expect(await new DownloadMachine(api as never, () => store).download({ ...input, resume })).toEqual(bytes);
    expect(reads).toEqual(scenario === "restart" ? [50_000, 100_000] : [0, 50_000, 100_000]);
    await discardDownloads(adapter as never, db, async () => {});
    expect(db.downloadStates()).toEqual([]);
    expect(files.size).toBe(0);
  });

  it("persists no block checkpoint when writing a block fails", async () => {
    const { adapter } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    vi.spyOn(adapter, "writeBinary").mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(cache.write(0, new Uint8Array([1]))).rejects.toThrow("ENOSPC");
    expect(db.downloadBlock("task", 0)).toBeUndefined();
  });

  it("does not fail synchronization when a stale cache directory is reported as a file", async () => {
    const { adapter, folders } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    const directory = [...folders].find(path => path.startsWith(".yunpan-sync/downloads/"))!;
    const originalList = adapter.list;
    vi.spyOn(adapter, "list").mockImplementation(async path => {
      const listed = await originalList(path);
      return path === directory ? { files: [directory], folders: [] } : listed;
    });
    vi.spyOn(adapter, "remove").mockRejectedValue(new Error("Path is a directory: rm returned EISDIR (is a directory)"));
    await expect(cache.clear()).resolves.toBeUndefined();
  });

  it.each([".yunpan-sync", ".yunpan-sync/downloads", "task"])("repairs a cache directory replaced by a file: %s", async target => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, files, folders } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    await cache.write(0, new Uint8Array([1]));
    const directory = [...folders].find(path => path.startsWith(".yunpan-sync/downloads/"))!;
    const replaced = target === "task" ? directory : target;
    for (const path of [...folders]) if (path === replaced || path.startsWith(`${replaced}/`)) folders.delete(path);
    for (const path of [...files.keys()]) if (path.startsWith(`${replaced}/`)) files.delete(path);
    files.set(replaced, new Uint8Array([9]));

    const restarted = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await restarted.prepare("identity");
    expect(folders.has(replaced)).toBe(true);
    expect(files.has(replaced)).toBe(false);
    expect(db.downloadBlock("task", 0)).toBeUndefined();
    await restarted.write(0, new Uint8Array([2]));
    expect(await restarted.read(0)).toEqual(new Uint8Array([2]));
  });

  it("repairs a block replaced by a directory, preserves unknown content and finishes the real download", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, files, folders } = adapterFixture();
    const db = await database();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = (await cloudFileHashes(bytes)).fileHash;
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    const identity = JSON.stringify(["/Root/a.bin", "node", hash, bytes.length, 2]);
    await cache.prepare(identity);
    await cache.write(0, bytes.slice(0, 2));
    const directory = [...folders].find(path => path.startsWith(".yunpan-sync/downloads/"))!;
    files.delete(`${directory}/0.part`);
    folders.add(`${directory}/0.part`);
    folders.add(`${directory}/0.part/nested`);
    files.set(`${directory}/0.part/nested/stale`, new Uint8Array([0]));
    files.set(`${directory}/keep.txt`, new Uint8Array([9]));
    files.set("note.md", new Uint8Array([8]));
    const store = { callJson: vi.fn(), download: vi.fn(async (_method, _params, range) => bytes.slice(range.start, range.end + 1)) };
    const api = { call: vi.fn(async () => ({ https: "https://down1.yunpan.360.cn/intf.php", fhash: hash, fsize: bytes.length, chunk_size: 2 })) };

    expect(await new DownloadMachine(api as never, () => store).download({ path: "/Root/a.bin", nid: "node", resume: cache })).toEqual(bytes);
    expect(store.download).toHaveBeenCalledTimes(2);
    expect(folders.has(`${directory}/0.part`)).toBe(false);
    expect([...files.keys()]).not.toContain(`${directory}/0.part/nested/stale`);
    expect(files.get(`${directory}/keep.txt`)).toEqual(new Uint8Array([9]));
    expect(files.get("note.md")).toEqual(new Uint8Array([8]));
    expect(db.downloadBlock("task", 0)?.size).toBe(2);
    expect(db.downloadBlock("task", 1)?.size).toBe(2);
    await cache.clear();
    expect(db.downloadStates()).toEqual([]);
    expect(files.has(`${directory}/keep.txt`)).toBe(true);
  });

  it("rebuilds once when a write races with a directory type change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    const write = vi.spyOn(adapter, "writeBinary").mockRejectedValueOnce(new Error("Path is a directory: rm returned EISDIR"));
    await cache.write(0, new Uint8Array([1]));
    expect(write).toHaveBeenCalledTimes(2);
    expect(await cache.read(0)).toEqual(new Uint8Array([1]));
    expect(db.downloadStates()).toMatchObject([{ taskId: "task", identity: "identity" }]);
  });

  it("removes only the invalid block checkpoint when a cached block is corrupt", async () => {
    const { adapter, files, folders } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    await cache.write(0, new Uint8Array([1]));
    await cache.write(1, new Uint8Array([2]));
    const directory = [...folders].find(path => path.startsWith(".yunpan-sync/downloads/"))!;
    files.set(`${directory}/0.part`, new Uint8Array([9]));
    expect(await cache.read(0)).toBeUndefined();
    expect(db.downloadBlock("task", 0)).toBeUndefined();
    expect(await cache.read(1)).toEqual(new Uint8Array([2]));
  });

  it("retains failed cleanup for the next sweep without blocking other caches", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, files } = adapterFixture();
    const db = await database();
    const first = new DownloadCache(adapter as never, db, "account", "first", async () => {});
    const second = new DownloadCache(adapter as never, db, "account", "second", async () => {});
    await first.prepare("one"); await first.write(0, new Uint8Array([1]));
    await second.prepare("two"); await second.write(0, new Uint8Array([2]));
    const remove = vi.spyOn(adapter, "remove").mockRejectedValueOnce(new Error("EACCES /private/cache"));
    await expect(discardDownloads(adapter as never, db, async () => {})).resolves.toBeUndefined();
    expect(db.downloadStates().map(state => state.taskId)).toEqual(["first"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("cleanup deferred"), expect.any(Error));
    expect(files.size).toBe(1);
    remove.mockRestore();
    await discardDownloads(adapter as never, db, async () => {});
    expect(files.size).toBe(0);
    expect(db.downloadStates()).toEqual([]);
  });

  it("recovers from an adapter that removes empty directories with the file API", async () => {
    const { adapter, folders } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    const rmdir = adapter.rmdir;
    const removeDirectory = vi.spyOn(adapter, "rmdir").mockImplementation(async (path, recursive) => {
      if (!recursive) throw new Error("Path is a directory: rm returned EISDIR");
      await rmdir(path, recursive);
    });
    await cache.clear();
    expect(removeDirectory.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect([...folders].filter(path => path.startsWith(".yunpan-sync/downloads/"))).toEqual([]);
    expect(db.downloadStates()).toEqual([]);
  });

  it("limits failed recovery to one retry and retains raw diagnostics without exposing paths", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    const raw = "EISDIR: /Users/private/.yunpan-sync/downloads/cache/0.part";
    const write = vi.spyOn(adapter, "writeBinary").mockRejectedValue(new Error(raw));
    db.enqueue({ id: "task", kind: "download", path: "a.md", payload: {} });
    await new TaskRunner(db, { download: () => cache.write(0, new Uint8Array([1])) }, { waitForRetries: true }).drain();
    expect(write).toHaveBeenCalledTimes(2);
    expect(db.listFailedTasks()[0]).toMatchObject({ state: "failed", attempt: 1, lastError: expect.stringContaining(raw) });
    expect(classifySyncError(db.listFailedTasks()[0]!.lastError)).toEqual({
      category: "unknown", title: "同步失败", detail: "同步失败，请点击重试。",
    });
    expect(classifySyncError(classifySyncError(db.listFailedTasks()[0]!.lastError).detail).detail).toBe("同步失败，请点击重试。");
    expect(isRetryableTaskError(new DownloadCacheError(new Error(raw)))).toBe(false);
  });

  it("refuses escaped directory entries and invalid block indexes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, files, folders } = adapterFixture();
    const db = await database();
    const cache = new DownloadCache(adapter as never, db, "account", "task", async () => {});
    await cache.prepare("identity");
    const directory = [...folders].find(path => path.startsWith(".yunpan-sync/downloads/"))!;
    folders.add(`${directory}/0.part`);
    files.set("note.md", new Uint8Array([5]));
    const list = adapter.list;
    vi.spyOn(adapter, "list").mockImplementation(async path => path.endsWith("/0.part")
      ? { files: ["note.md", `${path}/../note.md`], folders: [] } : list(path));
    await expect(cache.write(0, new Uint8Array([1]))).rejects.toBeInstanceOf(DownloadCacheError);
    expect(files.get("note.md")).toEqual(new Uint8Array([5]));
    await expect(cache.write(-1, new Uint8Array([1]))).rejects.toThrow("Invalid download block index");
    await expect(cache.read(0.5)).rejects.toThrow("Invalid download block index");
  });

  it("does not hide database persistence failures during cleanup or recovery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter } = adapterFixture();
    const db = await database();
    const save = vi.fn(async () => {});
    const cache = new DownloadCache(adapter as never, db, "account", "task", save);
    await cache.prepare("identity");
    save.mockRejectedValueOnce(new Error("database save failed"));
    await expect(cache.clear()).rejects.toThrow("database save failed");
    await cache.prepare("identity");
    vi.spyOn(adapter, "writeBinary").mockRejectedValue(new Error("EISDIR"));
    save.mockRejectedValueOnce(new Error("database save failed"));
    await expect(cache.write(0, new Uint8Array([1]))).rejects.toThrow("database save failed");
  });

  it("keeps backend references in persisted failures and Chinese guidance", async () => {
    const db = await database();
    db.enqueue({ id: "file", kind: "upload", path: "a.md", payload: {} });
    await new TaskRunner(db, { upload: async () => { throw new OpenApiError("request frequently", 12345, "trace-42"); } },
      { maxAttempts: 1 }).drain();
    const detail = classifySyncError(db.listFailedTasks()[0]!.lastError).detail;
    expect(detail).toContain("错误码 12345");
    expect(detail).toContain("追踪编号 trace-42");
    expect(classifySyncError(detail).detail).toContain("追踪编号 trace-42");
  });

  it("records rejected names immediately instead of retrying them", async () => {
    const db = await database();
    db.enqueue({ id: "invalid", kind: "upload", path: "蜡笔小.jpg", payload: {} });
    const upload = vi.fn(async () => { throw new OpenApiError("文件名不合规", 4001, "trace-name"); });
    await new TaskRunner(db, { upload }, { waitForRetries: true }).drain();
    expect(upload).toHaveBeenCalledOnce();
    expect(db.listFailedTasks()[0]).toMatchObject({ state: "failed", attempt: 1, lastError: expect.stringContaining("文件名不合规") });
    expect(isRetryableTaskError(new OpenApiError("文件名不合规", 4001))).toBe(false);
    expect(isRetryableTaskError(new Error("network timeout"))).toBe(true);
  });
});

describe("account request scheduling", () => {
  it("serializes metadata and spaces request starts by 200 milliseconds", async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler();
    const starts: number[] = [];
    let active = 0, peak = 0;
    const jobs = Array.from({ length: 3 }, () => scheduler.metadata(async () => {
      starts.push(Date.now()); peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 20)); active--;
    }));
    await vi.runAllTimersAsync(); await Promise.all(jobs);
    expect(peak).toBe(1);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(200);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(200);
  });

  it("retries a business rate limit after shared cooldown and checks cancellation", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValueOnce({ status: 200, json: { errno: 12345, errmsg: "request frequently,please retry" } })
      .mockResolvedValue({ status: 200, json: { errno: 0, data: { ok: true } } });
    const client = new OpenApiClient({ baseUrl: "https://openapi.eyun.360.cn/intf.php", accessToken: () => "access", qid: () => "42",
      signingSecret: () => "test", transport });
    const pending = client.call("User.getVersion", {});
    await vi.advanceTimersByTimeAsync(999);
    expect(transport).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(transport).toHaveBeenCalledTimes(2);
    await expect(client.call("User.getVersion", {}, () => { throw new Error("停止"); })).rejects.toThrow("停止");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("applies cooldown before releasing an already queued metadata request", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const transport = vi.fn(async () => {
      starts.push(Date.now());
      if (starts.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { status: 200, json: { errno: 12345, errmsg: "request frequently" } };
      }
      return { status: 200, json: { errno: 0, data: {} } };
    });
    const client = new OpenApiClient({ baseUrl: "https://openapi.eyun.360.cn/intf.php", accessToken: () => "access", qid: () => "42",
      signingSecret: () => "test", transport });
    const requests = Promise.all([client.call("User.getVersion", {}), client.call("User.getVersion", {})]);
    await vi.advanceTimersByTimeAsync(1299);
    expect(starts).toHaveLength(1);
    await vi.runAllTimersAsync(); await requests;
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1300);
  });

  it("shares exponential backoff across calls and caps it at thirty seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const scheduler = new RequestScheduler();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const start = Date.now();
      scheduler.coolDown(0);
      const waiting = scheduler.wait();
      await vi.runAllTimersAsync(); await waiting;
      expect(Date.now() - start).toBe(delay);
    }
  });

  it.each(["73 sync tasks are still queued", "Interrupted by shutdown", "request frequently,please retry"])("explains %s in Chinese", text => {
    expect(classifySyncError(text).detail).toMatch(/[\u3400-\u9fff]/);
    expect(classifySyncError(text).detail).not.toContain(text);
  });
});
