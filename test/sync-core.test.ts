import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";
import { cloudFileHashes } from "../src/transfer/hashes.js";
import { RemoteIndexer } from "../src/sync/remote-indexer.js";
import { SyncDatabase } from "../src/storage/database.js";
import { TaskRunner } from "../src/sync/task-runner.js";
import { OpenApiError } from "../src/net/openapi-client.js";
import { isAlreadyDeletedRemoteError, SyncEngine } from "../src/sync/engine.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

type MoveTaskExecutor = (task: {
  id: string; kind: "move"; path: string; payload: { destination: string };
  state: "queued" | "retry"; attempt: number; nextRunAt: number;
}) => Promise<void>;

type RecycleTaskExecutor = (task: {
  id: string; kind: "recycle"; path: string; nid?: string; payload: unknown;
  state: "queued" | "retry"; attempt: number; nextRunAt: number;
}) => Promise<void>;

type PlanTasksExecutor = () => Promise<void>;

type LocalRenameTaskExecutor = (task: {
  id: string; kind: "local-rename"; path: string; nid?: string;
  payload: { destination: string; local?: unknown; remote?: unknown; base?: unknown; conflict?: boolean };
  state: "queued" | "retry"; attempt: number; nextRunAt: number;
}) => Promise<void>;

type DownloadTaskExecutor = (task: {
  id: string; kind: "download"; path: string; nid?: string; payload: unknown;
  state: "queued" | "retry"; attempt: number; nextRunAt: number;
}) => Promise<void>;

function moveExecutor(engine: SyncEngine): MoveTaskExecutor {
  return (engine as unknown as { moveRemote: MoveTaskExecutor }).moveRemote.bind(engine);
}

function recycleExecutor(engine: SyncEngine): RecycleTaskExecutor {
  return (engine as unknown as { recycleRemote: RecycleTaskExecutor }).recycleRemote.bind(engine);
}

function planTasksExecutor(engine: SyncEngine): PlanTasksExecutor {
  return (engine as unknown as { planTasks: PlanTasksExecutor }).planTasks.bind(engine);
}

function localRenameExecutor(engine: SyncEngine): LocalRenameTaskExecutor {
  return (engine as unknown as { renameLocal: LocalRenameTaskExecutor }).renameLocal.bind(engine);
}

function downloadExecutor(engine: SyncEngine): DownloadTaskExecutor {
  return (engine as unknown as { download: DownloadTaskExecutor }).download.bind(engine);
}

function stubLocalScan(engine: SyncEngine, entries: Array<[string, { path: string; snapshot: unknown }]>): void {
  (engine as unknown as { scanLocal: () => Promise<Map<string, { path: string; snapshot: unknown }>> }).scanLocal =
    async () => new Map(entries);
}

describe("cloud file hashes", () => {
  it("uses 512 KiB SHA-1 blocks and hashes their lowercase hex concatenation", async () => {
    const bytes = new Uint8Array(512 * 1024 + 3);
    bytes.fill(97);
    const result = await cloudFileHashes(bytes);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((block) => block.index)).toEqual([1, 2]);
    expect(result.blocks[0]?.size).toBe(512 * 1024);
    expect(result.blocks[1]?.size).toBe(3);
    expect(result.fileHash).toMatch(/^[a-f0-9]{40}$/);
    expect(result.fileHash).not.toBe(result.blocks[0]?.hash);
  });
});

describe("remote index", () => {
  it("indexes remote-only names that are not portable local paths", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 1 })
      .mockResolvedValueOnce({ node_list: [{ nid: "1", pid: "0", name: "legacy:remote.txt", type: 0, nv: 1 }], retnum: 1, gsp: "11", spnid: "1" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 1, spnid: 0 }) };

    await new RemoteIndexer(api, db, "account", 10).rebuild();

    expect(db.getRemoteNodes().map((node) => node.path)).toEqual(["/legacy:remote.txt"]);
  });

  it("retains unsafe remote names and identities for validation without blocking the snapshot", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 2 })
      .mockResolvedValueOnce({ node_list: [
        { nid: "bad", pid: "0", name: "", type: 0, nv: 1 },
        { nid: "good", pid: "0", name: "good.md", type: 0, nv: 1 },
      ], retnum: 2, gsp: "11", spnid: "good" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 1, spnid: 0 }) };

    await new RemoteIndexer(api, db, "account", 10).rebuild();

    expect(db.getRemoteNodes().map((node) => node.path)).toEqual(["/", "/good.md"]);
    expect(db.getCursor("account")).toMatchObject({ gsp: "12", snapshotComplete: true });
  });

  it("preserves case-colliding nodes outside the bound vault directory", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 2 })
      .mockResolvedValueOnce({ node_list: [
        { nid: "1", pid: "0", name: "Legacy.txt", type: 0, nv: 1 },
        { nid: "2", pid: "0", name: "legacy.txt", type: 0, nv: 1 },
      ], retnum: 2, gsp: "11", spnid: "2" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 1, spnid: 0 }) };

    await new RemoteIndexer(api, db, "account", 10).rebuild();

    expect(db.getRemoteNodes().map((node) => node.path)).toEqual(["/Legacy.txt", "/legacy.txt"]);
  });

  it("normalizes malformed numeric metadata from historical nodes", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 1 })
      .mockResolvedValueOnce({ node_list: [{
        nid: "1", pid: "0", name: "legacy.txt", type: 0, nv: "invalid",
        count_size: "invalid", modify_time: "invalid",
      }], retnum: 1, gsp: "11", spnid: "1" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 1, spnid: 0 }) };

    await new RemoteIndexer(api, db, "account", 10).rebuild();

    expect(db.getRemoteNodes()[0]).toMatchObject({ version: 0, size: -1, mtime: 0 });
  });

  it("preserves duplicate remote paths under distinct stable node ids", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 2 })
      .mockResolvedValueOnce({ node_list: [
        { nid: "1", pid: "0", name: "duplicate.txt", type: 0, nv: 1 },
        { nid: "2", pid: "0", name: "duplicate.txt", type: 0, nv: 1 },
      ], retnum: 2, gsp: "11", spnid: "2" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 1, spnid: 0 }) };

    await new RemoteIndexer(api, db, "account", 10).rebuild();

    expect(db.getRemoteNodes().map((node) => node.nid)).toEqual(["1", "2"]);
  });

  it("migrates the legacy unique-path remote index without losing nodes", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE remote_nodes (
      nid TEXT PRIMARY KEY, pid TEXT NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      is_dir INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT, size INTEGER NOT NULL,
      mtime INTEGER NOT NULL, status INTEGER
    )`);
    legacy.run(`INSERT INTO remote_nodes VALUES ('1','0','/duplicate.txt','duplicate.txt',0,1,NULL,0,0,0)`);

    const db = new SyncDatabase(legacy);
    db.upsertRemoteNode({ nid: "2", pid: "0", path: "/duplicate.txt", name: "duplicate.txt",
      isDir: false, version: 1, size: 0, mtime: 0 });

    expect(db.getRemoteNodes().map((node) => node.nid)).toEqual(["1", "2"]);
  });

  it("commits a full snapshot and cursor only after every page and catch-up increment", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 1, total: 2 })
      .mockResolvedValueOnce({ node_list: [{ nid: "1", pid: "0", name: "Root", type: 1, nv: 1 }], retnum: "1", gsp: "11", spnid: "1" })
      .mockResolvedValueOnce({ node_list: [{ nid: "2", pid: "1", name: "a.md", type: 0, file_hash: "h", count_size: 1, modify_time: 2, nv: 2 }], retnum: "1", gsp: "12", spnid: "2" })
      .mockResolvedValueOnce({ node_list: [], retnum: "0", gsp: "13", ver: 2, spnid: "0" }) };
    const indexer = new RemoteIndexer(api, db, "42:7:vault", 1);
    await indexer.rebuild();
    expect(db.getRemoteNodes().map((node) => node.path)).toEqual(["/Root", "/Root/a.md"]);
    expect(db.getCursor("42:7:vault")).toMatchObject({ bgsp: "10", gsp: "13", remoteVersion: 2, snapshotComplete: true });
  });

  it("discards an expired 3203 cursor and rebuilds the snapshot", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.setCursor({ accountKey: "account", bgsp: "1", gsp: "2", remoteVersion: 3, snapshotComplete: true });
    db.replaceRemoteSnapshot([{ nid: "old", pid: "0", path: "/old", name: "old", isDir: true, version: 3, size: 0, mtime: 0 }]);
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ ver: 4 })
      .mockRejectedValueOnce(new OpenApiError("expired", 3203, "trace"))
      .mockResolvedValueOnce({ bgsp: "10", gsp: "10", ver: 4, total: 1 })
      .mockResolvedValueOnce({ node_list: [{ nid: "new", pid: "0", name: "new", type: 1, nv: 4 }], retnum: 1, gsp: "11", spnid: "new" })
      .mockResolvedValueOnce({ node_list: [], retnum: 0, gsp: "12", ver: 4, spnid: 0 }) };
    await new RemoteIndexer(api, db, "account", 10).update();
    expect(db.getRemoteNodes().map((node) => node.nid)).toEqual(["new"]);
    expect(db.getCursor("account")?.gsp).toBe("12");
  });

  it.each([10, 30, 31, 99])("removes a remote node for deletion status %s", async (status) => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([{ nid: "old", pid: "0", path: "/old.md", name: "old.md", isDir: false,
      version: 1, size: 3, mtime: 1 }]);
    db.setCursor({ accountKey: "account", bgsp: "1", gsp: "2", remoteVersion: 1, snapshotComplete: true });
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ ver: 2 })
      .mockResolvedValueOnce({ node_list: [{ nid: "old", pid: "0", name: "old.md", type: 0, nv: 2, status }],
        retnum: 1, gsp: "3", ver: 2, spnid: "old" }) };

    await new RemoteIndexer(api, db, "account", 10).update();

    expect(db.getRemoteNodes()).toEqual([]);
  });

  it("removes descendants when a remote directory tombstone arrives", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([
      { nid: "dir", pid: "0", path: "/old", name: "old", isDir: true, version: 1, size: 0, mtime: 0 },
      { nid: "file", pid: "dir", path: "/old/a.md", name: "a.md", isDir: false, version: 1, size: 1, mtime: 1 },
    ]);
    db.setCursor({ accountKey: "account", bgsp: "1", gsp: "2", remoteVersion: 1, snapshotComplete: true });
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ ver: 2 })
      .mockResolvedValueOnce({ node_list: [{ nid: "dir", pid: "0", name: "old", type: 1, nv: 2, status: 10 }],
        retnum: 1, gsp: "3", ver: 2, spnid: "dir" }) };

    await new RemoteIndexer(api, db, "account", 10).update();

    expect(db.getRemoteNodes()).toEqual([]);
  });

  it("keeps the newest duplicate nid state in an increment", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([{ nid: "same", pid: "0", path: "/old.md", name: "old.md", isDir: false,
      version: 1, size: 3, mtime: 1 }]);
    db.setCursor({ accountKey: "account", bgsp: "1", gsp: "2", remoteVersion: 1, snapshotComplete: true });
    const api = { call: vi.fn()
      .mockResolvedValueOnce({ ver: 3 })
      .mockResolvedValueOnce({ node_list: [
        { nid: "same", pid: "0", name: "new.md", type: 0, nv: 3, status: 0 },
        { nid: "same", pid: "0", name: "old.md", type: 0, nv: 2, status: 10 },
      ], retnum: 2, gsp: "4", ver: 3, spnid: "same" }) };

    await new RemoteIndexer(api, db, "account", 10).update();

    expect(db.getRemoteNodes().map((node) => node.path)).toEqual(["/new.md"]);
  });

  it("purges a persisted tombstone even when the remote version is unchanged", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.upsertRemoteNode({ nid: "old", pid: "0", path: "/old.md", name: "old.md", isDir: false,
      version: 1, size: 3, mtime: 1, status: 10 });
    db.setCursor({ accountKey: "account", bgsp: "1", gsp: "2", remoteVersion: 2, snapshotComplete: true });
    const api = { call: vi.fn().mockResolvedValueOnce({ ver: 2 }) };

    await new RemoteIndexer(api, db, "account", 10).update();

    expect(db.getRemoteNodes()).toEqual([]);
  });
});

describe("Windows remote path compatibility", () => {
  it("reports an incompatible node inside the bound directory instead of silently skipping it", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.upsertRemoteNode({ nid: "bad", pid: "0", path: "/Obsidian/aa/CON.txt", name: "CON.txt", isDir: false,
      version: 1, size: 1, mtime: 1 });
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    expect(await (engine as unknown as { remoteMap: () => Promise<Map<unknown, unknown>> }).remoteMap()).toEqual(new Map());
    expect((engine as unknown as { fileFailures: Array<{ path: string; error: Error }> }).fileFailures)
      .toEqual([expect.objectContaining({ path: "/Obsidian/aa/CON.txt", error: expect.objectContaining({ issue: "reserved-name" }) })]);
  });

  it("continues to ignore incompatible nodes outside the bound directory", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.upsertRemoteNode({ nid: "outside", pid: "0", path: "/Other/CON.txt", name: "CON.txt", isDir: false,
      version: 1, size: 1, mtime: 1 });
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    expect(await (engine as unknown as { remoteMap: () => Promise<Map<unknown, unknown>> }).remoteMap()).toEqual(new Map());
  });
});

describe("task runner", () => {
  it("sends a trailing slash when recycling an empty remote directory", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-empty", kind: "recycle", path: "empty",
      nid: "dir", payload: { remote: { kind: "directory", size: 0, mtime: 0, nid: "dir" } },
      state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.syncRecycle", {
      fname: "/Obsidian/aa/empty/", owner_qid: "0",
    });
  });

  it("recycles a directory once instead of issuing child delete requests", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("folder", { kind: "directory", size: 0, mtime: 0, nid: "dir" });
    db.putBase("folder/note.md", { kind: "file", hash: "h", size: 1, mtime: 1, nid: "file" });
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-folder", kind: "recycle", path: "folder",
      nid: "dir", payload: { remote: { kind: "directory", size: 0, mtime: 0, nid: "dir" } },
      state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledTimes(1);
    expect(db.getBase("folder")).toBeUndefined();
    expect(db.getBase("folder/note.md")).toBeUndefined();
  });

  it("plans only the parent recycle task when a local directory tree was deleted", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([
      { nid: "dir", pid: "root", path: "/Obsidian/aa/folder", name: "folder",
        isDir: true, version: 1, size: 0, mtime: 0 },
      { nid: "file", pid: "dir", path: "/Obsidian/aa/folder/note.md", name: "note.md",
        isDir: false, version: 1, hash: "h", size: 1, mtime: 1 },
    ]);
    db.putBase("folder", { kind: "directory", size: 0, mtime: 0, nid: "dir", version: 1 });
    db.putBase("folder/note.md", { kind: "file", hash: "h", size: 1, mtime: 1, nid: "file", version: 1 });
    const vault = { getAllLoadedFiles: () => [] };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await planTasksExecutor(engine)();

    expect(db.listPendingTasks().map((task) => [task.kind, task.path, task.nid])).toEqual([
      ["recycle", "folder", "dir"],
    ]);
  });

  it("keeps file recycle paths without a trailing slash", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-file", kind: "recycle", path: "note.md",
      nid: "file", payload: { remote: { kind: "file", size: 1, mtime: 0, nid: "file" } },
      state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.syncRecycle", {
      fname: "/Obsidian/aa/note.md", owner_qid: "0",
    });
  });

  it("infers a directory path for a historical recycle task from the remote index", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.upsertRemoteNode({ nid: "dir", pid: "root", path: "/Obsidian/aa/empty", name: "empty",
      isDir: true, version: 1, size: 0, mtime: 0 });
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-legacy", kind: "recycle", path: "empty", nid: "dir",
      payload: {}, state: "retry", attempt: 1, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.syncRecycle", {
      fname: "/Obsidian/aa/empty/", owner_qid: "0",
    });
  });

  it("infers a directory path from the historical task baseline when the index entry is absent", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-legacy-base", kind: "recycle", path: "empty", nid: "dir",
      payload: { base: { kind: "directory", size: 0, mtime: 0, nid: "dir" } },
      state: "retry", attempt: 1, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.syncRecycle", {
      fname: "/Obsidian/aa/empty/", owner_qid: "0",
    });
  });

  it("does not treat a directory source-missing response as success before the remote node is absent", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.upsertRemoteNode({ nid: "dir", pid: "root", path: "/Obsidian/aa/empty", name: "empty",
      isDir: true, version: 1, size: 0, mtime: 0 });
    const api = { call: vi.fn().mockRejectedValue(new OpenApiError("源文件不存在", 3008, "trace")) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await expect(recycleExecutor(engine)({ id: "recycle-directory-error", kind: "recycle", path: "empty", nid: "dir",
      payload: { remote: { kind: "directory", size: 0, mtime: 0, nid: "dir" } },
      state: "queued", attempt: 0, nextRunAt: 0 })).rejects.toThrow("源文件不存在");
  });

  it("treats source-missing as idempotent after the remote node is absent", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("empty", { kind: "directory", size: 0, mtime: 0, nid: "dir" });
    const api = { call: vi.fn().mockRejectedValue(new OpenApiError("源文件不存在", 3008, "trace")) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await recycleExecutor(engine)({ id: "recycle-missing", kind: "recycle", path: "empty", nid: "dir",
      payload: { remote: { kind: "directory", size: 0, mtime: 0, nid: "dir" } },
      state: "retry", attempt: 1, nextRunAt: 0 });

    expect(db.getBase("empty")).toBeUndefined();
  });

  it("requeues a completed recycle task when the same remote nid still exists", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "old-recycle", kind: "recycle", path: "empty", nid: "dir",
      payload: { remote: { kind: "directory", nid: "dir", size: 0, mtime: 0 } }, nextRunAt: 0 });
    db.completeTask("old-recycle");
    db.upsertRemoteNode({ nid: "dir", pid: "root", path: "/Obsidian/aa/empty", name: "empty",
      isDir: true, version: 1, size: 0, mtime: 0 });

    expect(db.requeueStaleCompletedRecycleTasks(new Map([["empty", "dir"]]), new Set<string>())).toBe(1);
    expect(db.listPendingTasks().map((task) => [task.id, task.state])).toEqual([["old-recycle", "queued"]]);
  });

  it("does not requeue a completed recycle task for a replacement nid or restored local path", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "replaced", kind: "recycle", path: "replaced", nid: "old-dir",
      payload: { remote: { kind: "directory", nid: "old-dir", size: 0, mtime: 0 } }, nextRunAt: 0 });
    db.completeTask("replaced");
    db.enqueue({ id: "restored", kind: "recycle", path: "restored", nid: "same-dir",
      payload: { remote: { kind: "directory", nid: "same-dir", size: 0, mtime: 0 } }, nextRunAt: 0 });
    db.completeTask("restored");

    const restored = db.requeueStaleCompletedRecycleTasks(
      new Map([["replaced", "new-dir"], ["restored", "same-dir"]]), new Set(["restored"]),
    );

    expect(restored).toBe(0);
    expect(db.listPendingTasks()).toEqual([]);
  });

  it("clears a directory baseline tree after a successful recycle", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("folder", { kind: "directory", size: 0, mtime: 0 });
    db.putBase("folder/note.md", { kind: "file", hash: "h", size: 1, mtime: 1 });
    db.putBase("folder/nested/child.md", { kind: "file", hash: "h2", size: 1, mtime: 1 });

    db.deleteBaseTree("folder");

    expect([...db.getBases().keys()]).toEqual([]);
  });

  it("persists first-sync confirmation per account, vault, and remote binding", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    expect(db.isBindingConfirmed("account:vault:/one/")).toBe(false);
    db.confirmBinding("account:vault:/one/");
    expect(db.isBindingConfirmed("account:vault:/one/")).toBe(true);
    expect(db.isBindingConfirmed("account:vault:/two/")).toBe(false);
    db.unconfirmBinding("account:vault:/one/");
    expect(db.isBindingConfirmed("account:vault:/one/")).toBe(false);
  });

  it("lists every pending file transfer for progress display", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "u1", kind: "upload", path: "a.md", payload: { local: { size: 10 } }, nextRunAt: 0 });
    db.enqueue({ id: "d1", kind: "download", path: "b.bin", payload: { remote: { size: 20 } }, nextRunAt: 0 });
    db.enqueue({ id: "m1", kind: "mkdir", path: "folder", payload: {}, nextRunAt: 0 });

    expect(db.listTransferTasks().map((task) => [task.id, task.kind, task.path])).toEqual([
      ["u1", "upload", "a.md"],
      ["d1", "download", "b.bin"],
    ]);
  });

  it("lists retrying and failed tasks with their paths and original reasons", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "recycle-old", kind: "recycle", path: "old.md", payload: {}, nextRunAt: 0 });
    db.failTask("recycle-old", "源文件不存在", 1_000);
    db.enqueue({ id: "upload-failed", kind: "upload", path: "new.md", payload: {}, nextRunAt: 0 });
    db.failTask("upload-failed", "网络连接异常");

    expect(db.listFailedTasks().map((task) => [task.id, task.kind, task.path, task.state, task.lastError])).toEqual([
      ["recycle-old", "recycle", "old.md", "retry", "源文件不存在"],
      ["upload-failed", "upload", "new.md", "failed", "网络连接异常"],
    ]);
  });

  it("removes pending remote-delete tasks whose remote paths no longer exist", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "gone", kind: "recycle", path: "gone.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "present", kind: "recycle", path: "present.md", payload: {}, nextRunAt: 0 });

    expect(db.removeObsoleteRecycleTasks(new Set(["present.md"]))).toBe(1);
    expect(db.listPendingTasks().map((task) => task.id)).toEqual(["present"]);
  });

  it("removes pending local upload tasks whose source paths no longer exist", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "gone-upload", kind: "upload", path: "gone.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "gone-folder", kind: "mkdir", path: "gone-folder", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "keep-download", kind: "download", path: "remote.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "done-upload", kind: "upload", path: "done.md", payload: {}, nextRunAt: 0 });
    db.completeTask("done-upload");
    db.failTask("gone-upload", "too long", undefined);

    expect(db.removeObsoleteLocalTasks(new Set(["remote.md"]))).toBe(2);
    expect(db.listPendingTasks().map((task) => task.id)).toEqual(["keep-download"]);
    expect(db.taskCounts()).toEqual({ queued: 1, failed: 0 });
  });

  it("treats an already missing remote source as an idempotent delete", () => {
    expect(isAlreadyDeletedRemoteError(new OpenApiError("源文件不存在", 3008, "trace"))).toBe(true);
    expect(isAlreadyDeletedRemoteError(new Error("source does not exist"))).toBe(true);
    expect(isAlreadyDeletedRemoteError(new OpenApiError("permission denied", 403, "trace"))).toBe(false);
  });

  it("removes tasks deselected in the interactive preview so they can be planned again later", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "keep", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "skip", kind: "download", path: "b.md", payload: {}, nextRunAt: 0 });

    db.removeTasks(["skip"]);

    expect(db.listPendingTasks().map((task) => task.id)).toEqual(["keep"]);
  });

  it("deduplicates active tasks for the same operation and path", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());

    db.enqueue({ id: "u1", kind: "upload", path: "a.md", payload: { revision: 1 }, nextRunAt: 0 });
    db.enqueue({ id: "u2", kind: "upload", path: "a.md", payload: { revision: 2 }, nextRunAt: 0 });

    expect(db.taskCounts()).toMatchObject({ queued: 1 });
  });

  it("claims same-time tasks in stable enqueue order", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "z-parent", kind: "mkdir", path: "foldera", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "a-child", kind: "mkdir", path: "foldera/nested", payload: {}, nextRunAt: 0 });

    expect(db.claimNextRunnableTask(0)?.id).toBe("z-parent");
    expect(db.claimNextRunnableTask(0)?.id).toBe("a-child");
  });

  it("moves pending work to the normalized destination after a local rename", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());

    db.enqueue({ id: "upload-old", kind: "upload", path: "notes\\old.md", payload: { revision: 1 }, nextRunAt: 0 });
    db.relocateTasks("notes\\old.md", "notes/new.md");

    expect(db.listPendingTasks().map((task) => [task.kind, task.path])).toEqual([["upload", "notes/new.md"]]);
  });

  it("normalizes a Windows rename and keeps queued uploads on the renamed file", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const snapshot = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "10" };
    db.putBase("notes/old.md", snapshot);
    db.enqueue({ id: "upload-old", kind: "upload", path: "notes/old.md", payload: { local: snapshot }, nextRunAt: 0 });
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);

    engine.recordRename("notes\\old.md", "notes\\new.md");

    expect(db.listPendingTasks().map((task) => [task.kind, task.path, task.payload])).toEqual([
      ["upload", "notes/new.md", { local: snapshot }],
      ["rename", "notes/old.md", { destination: "notes/new.md", base: snapshot }],
    ]);
  });

  it("keeps a newly-created file upload after it is renamed before the first sync", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "upload-new", kind: "upload", path: "draft.md",
      payload: { local: { hash: "abc", size: 3, mtime: 1, kind: "file" } }, nextRunAt: 0 });
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);

    engine.recordRename("draft.md", "published.md");

    expect(db.listPendingTasks().map((task) => [task.kind, task.path])).toEqual([["upload", "published.md"]]);
  });

  it("updates a nested rename destination when its parent is renamed before syncing", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "rename-child", kind: "rename", path: "old/a.md",
      payload: { destination: "old/b.md" }, nextRunAt: 0 });

    db.relocateTasks("old", "new");

    expect(db.listPendingTasks()[0]).toMatchObject({
      kind: "rename", path: "new/a.md", payload: { destination: "new/b.md" },
    });
  });

  it("drops an obsolete structural task before enqueuing the latest rename", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "stale", kind: "rename", path: "old.md", payload: { destination: "stale.md" }, nextRunAt: 0 });

    db.relocateTasks("old.md", "new.md");

    expect(db.listPendingTasks()).toEqual([]);
  });

  it("does not rewrite a transfer that is already running", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "running", kind: "upload", path: "old.md", payload: {}, nextRunAt: 0 });
    db.markTaskRunning("running");

    db.relocateTasks("old.md", "new.md");

    expect(db.listPendingTasks()[0]).toMatchObject({ path: "old.md", state: "running" });
  });

  it("classifies a root-level rename as rename instead of move", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("old.md", { hash: "abc", size: 3, mtime: 1, kind: "file", nid: "10" });
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);

    engine.recordRename("old.md", "new.md");

    expect(db.listPendingTasks().map((task) => task.kind)).toEqual(["rename"]);
  });

  it("plans one local rename when the same remote nid moves to a new path", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const base = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "10", version: 1 };
    db.putBase("old.md", base);
    db.replaceRemoteSnapshot([{ nid: "10", pid: "root", path: "/Obsidian/new.md", name: "new.md",
      isDir: false, version: 2, hash: "abc", size: 3, mtime: 1 }]);
    const paths = new Set(["old.md"]);
    const adapter = {
      exists: vi.fn(async (path: string) => paths.has(path)),
      rename: vi.fn(async (source: string, destination: string) => { paths.delete(source); paths.add(destination); }),
    };
    const vault = { adapter, getAbstractFileByPath: () => null };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);
    stubLocalScan(engine, [["old.md", { path: "old.md", snapshot: base }]]);

    await planTasksExecutor(engine)();

    expect(db.listPendingTasks().map((task) => [task.kind, task.path, task.nid, task.payload])).toEqual([
      ["local-rename", "old.md", "10", expect.objectContaining({ destination: "new.md", conflict: false })],
    ]);
    expect(db.getBase("new.md")).toBeUndefined();
    expect(db.getBase("old.md")).toEqual(base);

    await localRenameExecutor(engine)(db.listPendingTasks()[0] as Parameters<LocalRenameTaskExecutor>[0]);

    expect(adapter.rename).toHaveBeenCalledWith("old.md", "new.md");
    expect(db.getBase("old.md")).toBeUndefined();
    expect(db.getBase("new.md")).toMatchObject({ nid: "10", version: 2 });
  });

  it("keeps delete and download planning when a remote replacement has a different nid", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const base = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "old-nid", version: 1 };
    db.putBase("old.md", base);
    db.replaceRemoteSnapshot([{ nid: "new-nid", pid: "root", path: "/Obsidian/new.md", name: "new.md",
      isDir: false, version: 2, hash: "abc", size: 3, mtime: 1 }]);
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);
    stubLocalScan(engine, [["old.md", { path: "old.md", snapshot: base }]]);

    await planTasksExecutor(engine)();

    expect(db.listPendingTasks().map((task) => [task.kind, task.path])).toEqual([
      ["download", "new.md"], ["download", "old.md"],
    ]);
  });

  it("plans only the parent local rename for an unchanged remotely renamed directory tree", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const directory = { size: 0, mtime: 0, kind: "directory" as const, nid: "dir", version: 1 };
    const file = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "file", version: 1 };
    db.putBase("old", directory);
    db.putBase("old/note.md", file);
    db.replaceRemoteSnapshot([
      { nid: "dir", pid: "root", path: "/Obsidian/new", name: "new",
        isDir: true, version: 2, size: 0, mtime: 0 },
      { nid: "file", pid: "dir", path: "/Obsidian/new/note.md", name: "note.md",
        isDir: false, version: 1, hash: "abc", size: 3, mtime: 1 },
    ]);
    const engine = new SyncEngine({} as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);
    stubLocalScan(engine, [
      ["old", { path: "old", snapshot: directory }],
      ["old/note.md", { path: "old/note.md", snapshot: file }],
    ]);

    await planTasksExecutor(engine)();

    expect(db.listPendingTasks().map((task) => [task.kind, task.path, task.payload])).toEqual([
      ["local-rename", "old", expect.objectContaining({ destination: "new", conflict: false })],
    ]);
  });

  it("protects a locally modified source before downloading its remotely renamed nid", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const base = { hash: "base", size: 4, mtime: 1, kind: "file" as const, nid: "10", version: 1 };
    const local = { hash: "local", size: 5, mtime: 2, kind: "file" as const, nid: "10", version: 1 };
    db.putBase("old.md", base);
    db.replaceRemoteSnapshot([{ nid: "10", pid: "root", path: "/Obsidian/new.md", name: "new.md",
      isDir: false, version: 2, hash: "remote", size: 6, mtime: 3 }]);
    const paths = new Set(["old.md"]);
    const adapter = {
      stat: vi.fn(async (path: string) => paths.has(path) ? { type: "file", size: 6, mtime: 3, ctime: 1 } : null),
      exists: vi.fn(async (path: string) => paths.has(path)),
      rename: vi.fn(async (source: string, destination: string) => { paths.delete(source); paths.add(destination); }),
      writeBinary: vi.fn(async (path: string) => { paths.add(path); }),
      remove: vi.fn(async (path: string) => { paths.delete(path); }),
    };
    const vault = { adapter, getAbstractFileByPath: () => null };
    const downloader = { download: vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5, 6])) };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, downloader as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);
    stubLocalScan(engine, [["old.md", { path: "old.md", snapshot: local }]]);

    await planTasksExecutor(engine)();

    expect(db.listPendingTasks().map((task) => [task.kind, task.path, task.payload])).toEqual([
      ["local-rename", "old.md", expect.objectContaining({ destination: "new.md", conflict: true })],
      ["download", "new.md", expect.objectContaining({ remote: expect.objectContaining({ nid: "10" }) })],
      ["upload", expect.stringMatching(/^old \(conflict-/), expect.objectContaining({ local, sourcePath: "old.md" })],
    ]);

    const [protect, download] = db.listPendingTasks();
    await localRenameExecutor(engine)(protect as Parameters<LocalRenameTaskExecutor>[0]);
    await downloadExecutor(engine)(download as Parameters<DownloadTaskExecutor>[0]);

    expect([...paths]).toContain("new.md");
    expect([...paths].some((path) => path.startsWith("old (conflict-") && path.endsWith(").md"))).toBe(true);
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
    expect(db.getBase("new.md")).toMatchObject({ nid: "10", hash: "remote" });
    expect(db.listPendingTasks().some((task) => task.kind === "upload" && task.path.startsWith("old (conflict-"))).toBe(true);
  });

  it("renames a local file, moves its baseline, and treats a persisted retry as idempotent", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const base = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "10", version: 1 };
    const remote = { ...base, version: 2 };
    db.putBase("old.md", base);
    const paths = new Set(["old.md"]);
    const adapter = {
      exists: vi.fn(async (path: string) => paths.has(path)),
      rename: vi.fn(async (source: string, destination: string) => { paths.delete(source); paths.add(destination); }),
    };
    const vault = { adapter, getAbstractFileByPath: () => null };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);
    const task = { id: "remote-rename", kind: "local-rename" as const, path: "old.md", nid: "10",
      payload: { destination: "new.md", local: base, remote, base, conflict: false },
      state: "queued" as const, attempt: 0, nextRunAt: 0 };

    await localRenameExecutor(engine)(task);
    await localRenameExecutor(engine)({ ...task, state: "retry", attempt: 1 });

    expect(adapter.rename).toHaveBeenCalledTimes(1);
    expect(adapter.rename).toHaveBeenCalledWith("old.md", "new.md");
    expect(db.getBase("old.md")).toBeUndefined();
    expect(db.getBase("new.md")).toEqual(remote);
    expect(engine.consumeSuppression("old.md")).toBe(true);
    expect(engine.consumeSuppression("new.md")).toBe(true);
  });

  it("does not overwrite an occupied destination during a remote rename", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const snapshot = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "10", version: 1 };
    db.putBase("old.md", snapshot);
    const adapter = { exists: vi.fn(async () => true), rename: vi.fn() };
    const vault = { adapter, getAbstractFileByPath: () => null };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);

    await expect(localRenameExecutor(engine)({ id: "occupied", kind: "local-rename", path: "old.md", nid: "10",
      payload: { destination: "new.md", local: snapshot, remote: snapshot, base: snapshot, conflict: false },
      state: "queued", attempt: 0, nextRunAt: 0 })).rejects.toThrow(/already exists/i);
    expect(adapter.rename).not.toHaveBeenCalled();
    expect(db.getBase("old.md")).toEqual(snapshot);
  });

  it("uses a temporary path for a case-only remote rename on a case-insensitive adapter", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const snapshot = { hash: "abc", size: 3, mtime: 1, kind: "file" as const, nid: "10", version: 1 };
    db.putBase("Notes.md", snapshot);
    const paths = new Set(["Notes.md"]);
    const findPath = (candidate: string): string | undefined =>
      [...paths].find((path) => path.toLocaleLowerCase("en-US") === candidate.toLocaleLowerCase("en-US"));
    const adapter = {
      exists: vi.fn(async (path: string) => Boolean(findPath(path))),
      rename: vi.fn(async (source: string, destination: string) => {
        const actual = findPath(source);
        if (!actual) throw new Error(`missing ${source}`);
        paths.delete(actual);
        paths.add(destination);
      }),
    };
    const vault = { adapter, getAbstractFileByPath: () => null };
    const engine = new SyncEngine(vault as never, db, {} as never, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/" }), "account", () => undefined);

    await localRenameExecutor(engine)({ id: "case-only", kind: "local-rename", path: "Notes.md", nid: "10",
      payload: { destination: "notes.md", local: snapshot, remote: { ...snapshot, version: 2 }, base: snapshot, conflict: false },
      state: "queued", attempt: 0, nextRunAt: 0 });

    expect(adapter.rename).toHaveBeenCalledTimes(2);
    expect(adapter.rename.mock.calls[0]?.[0]).toBe("Notes.md");
    expect(adapter.rename.mock.calls[0]?.[1]).toMatch(/^\.yunpan-sync-.*\.rename$/);
    expect(adapter.rename.mock.calls[1]?.[1]).toBe("notes.md");
    expect([...paths]).toEqual(["notes.md"]);
    expect(db.getBase("notes.md")).toMatchObject({ nid: "10", version: 2 });
  });

  it("passes the destination directory to File.move and updates cached paths", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("note.md", { hash: "abc", size: 3, mtime: 1, kind: "file", nid: "10" });
    db.replaceRemoteSnapshot([
      { nid: "10", pid: "root", path: "/Obsidian/aa/note.md", name: "note.md",
        isDir: false, version: 1, hash: "abc", size: 3, mtime: 1 },
      { nid: "20", pid: "root", path: "/Obsidian/aa/yyyy", name: "yyyy",
        isDir: true, version: 1, size: 0, mtime: 1 },
    ]);
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await moveExecutor(engine)({ id: "move-note", kind: "move", path: "note.md",
      payload: { destination: "yyyy/note.md" }, state: "retry", attempt: 1, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledOnce();
    expect(api.call).toHaveBeenCalledWith("File.move", {
      src_name: "/Obsidian/aa/note.md", new_name: "/Obsidian/aa/yyyy/",
    });
    expect(db.getRemoteNodes().map((node) => node.path)).toContain("/Obsidian/aa/yyyy/note.md");
    expect([...db.getBases().keys()]).toEqual(["yyyy/note.md"]);
  });

  it("creates a missing destination hierarchy before moving a file", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await moveExecutor(engine)({ id: "move-note", kind: "move", path: "note.md",
      payload: { destination: "yyyy/nested/note.md" }, state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call.mock.calls).toEqual([
      ["File.mkdir", { fname: "/Obsidian/aa/yyyy/" }],
      ["File.mkdir", { fname: "/Obsidian/aa/yyyy/nested/" }],
      ["File.move", { src_name: "/Obsidian/aa/note.md", new_name: "/Obsidian/aa/yyyy/nested/" }],
    ]);
  });

  it("uses the bound remote root when moving a file out of a subdirectory", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await moveExecutor(engine)({ id: "move-root", kind: "move", path: "yyyy/note.md",
      payload: { destination: "note.md" }, state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.move", {
      src_name: "/Obsidian/aa/yyyy/note.md", new_name: "/Obsidian/aa/",
    });
  });

  it("uses the parent directory when moving a directory", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([{ nid: "20", pid: "root", path: "/Obsidian/aa/yyyy", name: "yyyy",
      isDir: true, version: 1, size: 0, mtime: 1 }]);
    const api = { call: vi.fn().mockResolvedValue({}) };
    const engine = new SyncEngine({} as never, db, api, {} as never, {} as never,
      () => ({ ...DEFAULT_SETTINGS, remoteRoot: "/Obsidian/aa/" }), "account", () => undefined);

    await moveExecutor(engine)({ id: "move-dir", kind: "move", path: "notes",
      payload: { destination: "yyyy/notes" }, state: "queued", attempt: 0, nextRunAt: 0 });

    expect(api.call).toHaveBeenCalledWith("File.move", {
      src_name: "/Obsidian/aa/notes", new_name: "/Obsidian/aa/yyyy/",
    });
  });

  it("moves directory descendants in the baseline after a remote rename succeeds", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.putBase("old", { size: 0, mtime: 0, kind: "directory", nid: "1" });
    db.putBase("old/note.md", { hash: "abc", size: 3, mtime: 1, kind: "file", nid: "2" });

    db.moveBase("old", "new");

    expect([...db.getBases().keys()]).toEqual(["new", "new/note.md"]);
  });

  it("moves a renamed remote directory and its descendants in the cached index", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.replaceRemoteSnapshot([
      { nid: "1", pid: "root", path: "/Obsidian/old", name: "old", isDir: true, version: 1, size: 0, mtime: 0 },
      { nid: "2", pid: "1", path: "/Obsidian/old/note.md", name: "note.md", isDir: false, version: 1, size: 3, mtime: 1 },
    ]);

    db.moveRemoteNodes("/Obsidian/old", "/Obsidian/new");

    expect(db.getRemoteNodes().map((node) => [node.path, node.name])).toEqual([
      ["/Obsidian/new", "new"], ["/Obsidian/new/note.md", "note.md"],
    ]);
  });

  it("supports retrying one failed task without retrying other failures", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "one", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "two", kind: "upload", path: "b.md", payload: {}, nextRunAt: 0 });
    db.failTask("one", "network", undefined);
    db.failTask("two", "permission", undefined);

    expect(db.retryTask("one")).toBe(true);
    expect(db.listPendingTasks().map((task) => [task.id, task.state])).toEqual([
      ["one", "retry"], ["two", "failed"],
    ]);
  });

  it.each(["retry", "failed"])("removes one %s task and its transfer state without touching other failures", async (state) => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "one", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "two", kind: "upload", path: "b.md", payload: {}, nextRunAt: 0 });
    db.failTask("one", "source missing", undefined);
    if (state === "retry") db.retryTask("one");
    db.failTask("two", "permission", undefined);
    db.saveTransferSession("one", { tid: "tid-1", endpoint: "https://store", ticket: "ticket",
      fileHash: "hash" });
    db.completeTransferBlock("one", 1);

    expect(db.removeFailedTask("one")).toBe(true);
    expect(db.listFailedTasks().map((task) => task.id)).toEqual(["two"]);
    expect(db.getTransferSession("one")).toBeUndefined();
    expect(db.completedTransferBlocks("one")).toEqual(new Set());
    const reopened = new SyncDatabase(new SQL.Database(db.export()));
    expect(reopened.listFailedTasks().map((task) => task.id)).toEqual(["two"]);
    reopened.close();
    expect(db.removeFailedTask("one")).toBe(false);
  });

  it("rolls back task and block deletion when transfer cleanup fails", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const sql = new SQL.Database();
    const db = new SyncDatabase(sql);
    db.enqueue({ id: "one", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    db.failTask("one", "source missing");
    db.saveTransferSession("one", { tid: "tid-1", endpoint: "https://store", ticket: "ticket", fileHash: "hash" });
    db.completeTransferBlock("one", 1);
    sql.run("CREATE TRIGGER reject_transfer_delete BEFORE DELETE ON transfer_state BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END");

    expect(() => db.removeFailedTask("one")).toThrow("cleanup failed");
    expect(db.listFailedTasks().map((task) => task.id)).toEqual(["one"]);
    expect(db.getTransferSession("one")?.tid).toBe("tid-1");
    expect(db.completedTransferBlocks("one")).toEqual(new Set([1]));
  });

  it.each(["queued", "running", "done"])("does not delete %s task records or their transfers", async (state) => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "protected", kind: "upload", path: "keep.md", payload: {}, nextRunAt: 0 });
    if (state === "running") db.markTaskRunning("protected");
    if (state === "done") db.completeTask("protected");
    db.saveTransferSession("protected", { tid: "keep", endpoint: "https://store", ticket: "ticket", fileHash: "hash" });
    db.completeTransferBlock("protected", 2);
    expect(db.removeFailedTask("protected")).toBe(false);
    expect(db.getTransferSession("protected")?.tid).toBe("keep");
    expect(db.completedTransferBlocks("protected")).toEqual(new Set([2]));
  });

  it("lists unresolved conflicts and allows acknowledging them", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.recordConflict("notes/a.md", "notes/a (conflict-PC).md");

    const [conflict] = db.listUnresolvedConflicts();
    expect(conflict).toMatchObject({ originalPath: "notes/a.md", conflictPath: "notes/a (conflict-PC).md" });
    expect(db.resolveConflict(conflict!.id)).toBe(true);
    expect(db.listUnresolvedConflicts()).toEqual([]);
  });

  it("retries transient failures without losing the durable task", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "u1", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    const execute = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    const runner = new TaskRunner(db, { upload: execute }, { now: () => 100, retryDelay: () => 0 });
    await runner.runOne();
    expect(db.nextRunnableTask(100)?.state).toBe("retry");
    await runner.runOne();
    expect(db.nextRunnableTask(100)).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  

  it("does not treat a deferred retry as a completed synchronization", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "u1", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    const runner = new TaskRunner(db, { upload: vi.fn().mockRejectedValue(new Error("offline")) }, {
      now: () => 100,
      retryDelay: () => 1_000,
    });

    await runner.drain();

    expect(() => runner.assertSettled()).toThrow("1 sync task is still queued");
  });

  it("checkpoints the running state before network work and the final task state afterwards", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "u1", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    const snapshots: Uint8Array[] = [];
    const runner = new TaskRunner(db, { upload: vi.fn().mockResolvedValue(undefined) }, {
      now: () => 100,
      checkpoint: async () => { snapshots.push(db.export()); },
    });

    await runner.runOne();

    expect(snapshots).toHaveLength(2);
    const running = new SyncDatabase(new SQL.Database(snapshots[0]));
    expect(running.recoverInterruptedTasks()).toBe(1);
    const completed = new SyncDatabase(new SQL.Database(snapshots[1]));
    expect(completed.recoverInterruptedTasks()).toBe(0);
    expect(completed.nextRunnableTask(100)).toBeUndefined();
  });

  it("finishes the active task and then stops before starting the next task", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "one", kind: "upload", path: "a.md", payload: {}, nextRunAt: 0 });
    db.enqueue({ id: "two", kind: "upload", path: "b.md", payload: {}, nextRunAt: 0 });
    let cancelled = false;
    const execute = vi.fn(async () => { cancelled = true; });
    const runner = new TaskRunner(db, { upload: execute }, { now: () => 100, shouldCancel: () => cancelled });

    await runner.drain();

    expect(execute).toHaveBeenCalledOnce();
    expect(db.listPendingTasks().map((task) => [task.id, task.state])).toEqual([["two", "queued"]]);
  });

  it("stops draining on server capacity rejection without failing or consuming the pending plan", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    for (const id of ["one", "two", "three"]) db.enqueue({ id, kind: "upload", path: id, nextRunAt: 0, payload: {} });
    const upload = vi.fn(async () => { throw new OpenApiError("个人空间不足", 2007); });
    await expect(new TaskRunner(db, { upload }).drain()).rejects.toMatchObject({ kind: "capacity" });
    expect(upload).toHaveBeenCalledOnce();
    expect(db.listPendingTasks().map(t => [t.state, t.attempt])).toEqual([["queued", 0], ["queued", 0], ["queued", 0]]);
    expect(db.listFailedTasks()).toEqual([]);
    await new TaskRunner(db, { upload: async () => undefined }).drain();
    expect(db.listPendingTasks()).toEqual([]);
  });

  it("drains more than ten thousand queued tasks", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    for (let index = 0; index < 10_001; index++) {
      db.enqueue({ id: `task-${index.toString().padStart(5, "0")}`, kind: "upload", path: `files/${index}.md`, payload: {}, nextRunAt: 0 });
    }
    const execute = vi.fn().mockResolvedValue(undefined);

    await new TaskRunner(db, { upload: execute }, { now: () => 100 }).drain();

    expect(execute).toHaveBeenCalledTimes(10_001);
    expect(db.listPendingTasks()).toEqual([]);
  }, 60_000);

  it("makes persisted retry tasks runnable immediately after connectivity returns", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    db.enqueue({ id: "offline", kind: "upload", path: "offline.md", payload: {}, nextRunAt: 0 });
    db.failTask("offline", "network offline", 60_000);

    expect(db.nextRunnableTask(100)).toBeUndefined();
    expect(db.makeRetryTasksRunnable()).toBe(1);
    expect(db.nextRunnableTask(100)).toMatchObject({ id: "offline", state: "retry", nextRunAt: 0 });
  });

  it("runs at most five upload tasks concurrently", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    for (let index = 0; index < 12; index++) {
      db.enqueue({ id: `upload-${index}`, kind: "upload", path: `${index}.md`, payload: {}, nextRunAt: 0 });
    }
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    });

    await new TaskRunner(db, { upload: execute }, { now: () => 100, concurrency: 5 }).drain();

    expect(peak).toBe(5);
    expect(execute).toHaveBeenCalledTimes(12);
  });

  it("continues with later files after one task fails", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    for (const id of ["one", "bad", "three"]) {
      db.enqueue({ id, kind: "upload", path: `${id}.md`, payload: {}, nextRunAt: 0 });
    }
    const completed: string[] = [];
    const execute = vi.fn(async (task: { id: string }) => {
      if (task.id === "bad") throw new Error("file rejected");
      completed.push(task.id);
    });

    await new TaskRunner(db, { upload: execute as never }, { now: () => 100, maxAttempts: 1, concurrency: 5 }).drain();

    expect(completed.sort()).toEqual(["one", "three"]);
    expect(db.listFailedTasks()).toEqual([expect.objectContaining({ id: "bad", state: "failed" })]);
  });

  it("lets active workers finish after cancellation without claiming more work", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const db = new SyncDatabase(new SQL.Database());
    for (let index = 0; index < 10; index++) {
      db.enqueue({ id: `upload-${index}`, kind: "upload", path: `${index}.md`, payload: {}, nextRunAt: 0 });
    }
    let cancelled = false;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      started++;
      if (started === 5) cancelled = true;
      await gate;
    });
    const drain = new TaskRunner(db, { upload: execute }, {
      now: () => 100,
      concurrency: 5,
      shouldCancel: () => cancelled,
    }).drain();
    await vi.waitFor(() => expect(started).toBe(5));
    release();

    await drain;

    expect(execute).toHaveBeenCalledTimes(5);
    expect(db.listPendingTasks()).toHaveLength(5);
  });
});
