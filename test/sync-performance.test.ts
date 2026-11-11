import { describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { TFile } from "obsidian";
import { RemoteIndexer } from "../src/sync/remote-indexer.js";
import { SyncDatabase } from "../src/storage/database.js";
import { SyncEngine } from "../src/sync/engine.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { WorkScheduler } from "../src/sync/work-scheduler.js";

async function database() {
  const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
  return { SQL, db: new SyncDatabase(new SQL.Database()) };
}

function remoteApi(count: number) {
  const nodes = Array.from({ length: count }, (_, i) => ({ nid: String(i + 2), pid: "1", name: `file${i}.mp4`,
    is_dir: 0, nv: 1, fsize: 1024 * 1024 * 1024, fhash: "a".repeat(40) }));
  nodes.unshift({ nid: "1", pid: "0", name: "Obsidian", is_dir: 1, nv: 1, fsize: 0, fhash: "" });
  const call = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "User.getUserDetail") return { is_vip: 1 };
    if (method === "User.getVersion") return { ver: 1 };
    if (method === "File.getList") {
      if (input.path !== "/Obsidian/") throw new Error("requested an unrelated directory");
      const offset = (Number(input.page) - 1) * Number(input.page_size);
      const children = nodes.slice(1);
      return { node_list: children.slice(offset, offset + Number(input.page_size)), total: children.length,
        has_next_page: offset + Number(input.page_size) < children.length };
    }
    if (method === "Incr.getBgsp") return { bgsp: "b", total: nodes.length, ver: 1 };
    if (method === "Incr.getIncrGlobal") return { nodes: [], gsp: "done", ver: 1, has_more: 0 };
    if (method === "Incr.getGlobalNodes") {
      const offset = input.spnid ? nodes.findIndex(node => node.nid === input.spnid) + 1 : 0;
      const page = nodes.slice(offset, offset + Number(input.count));
      return { nodes: page, gsp: `g${offset}`, spnid: page.at(-1)?.nid, has_more: offset + page.length < nodes.length };
    }
    throw new Error(`unexpected ${method}`);
  });
  return { call };
}

describe("responsive first synchronization", () => {
  it("reads 10,000 bound-directory nodes in 200-node pages while the event loop remains available", async () => {
    const { db } = await database();
    const api = remoteApi(10_000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await new RemoteIndexer(api as never, db, "account", 200, { remoteRoot: "/Obsidian/" }).rebuild();
      expect(db.getRemoteNodes()).toHaveLength(10_000);
      const pages = api.call.mock.calls.filter(([method]) => method === "File.getList");
      expect(pages).toHaveLength(50);
      expect(pages.every(([, input]) => input.page_size === 200 && input.path === "/Obsidian/")).toBe(true);
      expect(api.call.mock.calls.some(([method]) => method.startsWith("Incr."))).toBe(false);
      expect(api.call.mock.calls.at(-1)?.[0]).toBe("User.getVersion");
      expect(ticks).toBeGreaterThan(50);
      expect(db.getCursor("account")).toMatchObject({ gsp: "exists:1", snapshotComplete: true });
    } finally { clearInterval(timer); db.close(); }
  }, 60_000);

  it("retains the previous snapshot and cursor when canceled during staged writes", async () => {
    const { SQL, db } = await database();
    const old = { nid: "old", pid: "0", path: "/old", name: "old", isDir: true, size: 0, mtime: 0, version: 1 };
    db.replaceRemoteSnapshot([old]);
    db.setCursor({ accountKey: "account", gsp: "old", remoteVersion: 1, snapshotComplete: true });
    let canceled = false;
    const stage = db.stageRemoteNodes.bind(db);
    const writes = vi.spyOn(db, "stageRemoteNodes").mockImplementation(nodes => { stage(nodes); canceled = true; });
    const indexer = new RemoteIndexer(remoteApi(300) as never, db, "account", 200, {
      check: () => { if (canceled) throw new Error("canceled"); },
    });
    await expect(indexer.rebuild()).rejects.toThrow("canceled");
    expect(writes).toHaveBeenCalledOnce();
    expect(db.getRemoteNodes()).toEqual([old]);
    expect(db.getCursor("account")?.gsp).toBe("old");
    // Even a snapshot saved while staging is ignored after restart.
    db.beginRemoteSnapshot(); db.stageRemoteNodes([old]);
    const restored = new SyncDatabase(new SQL.Database(db.export()));
    expect(restored.getRemoteNodes()).toEqual([old]);
    restored.beginRemoteSnapshot(); restored.discardRemoteSnapshot();
    restored.close(); db.close();
  });

  it("stops after the current remote request without requesting another page", async () => {
    const { db } = await database();
    const api = remoteApi(500);
    let canceled = false;
    const original = api.call.getMockImplementation()!;
    api.call.mockImplementation(async (method, input) => {
      const result = await original(method, input);
      if (method === "Incr.getGlobalNodes") canceled = true;
      return result;
    });
    await expect(new RemoteIndexer(api as never, db, "account", 200, {
      check: () => { if (canceled) throw new Error("canceled"); },
    }).rebuild()).rejects.toThrow("canceled");
    expect(api.call.mock.calls.filter(([method]) => method === "Incr.getGlobalNodes")).toHaveLength(1);
    expect(db.getCursor("account")).toBeUndefined();
    db.close();
  });

  it("never reads cloud-only video bytes before initial confirmation", async () => {
    const { db } = await database();
    const api = remoteApi(20);
    const readBinary = vi.fn();
    const download = vi.fn();
    const statuses: unknown[] = [];
    const engine = new SyncEngine({ getAllLoadedFiles: () => [], adapter: { readBinary } } as never,
      db, api as never, {} as never, { download } as never, () => ({ ...DEFAULT_SETTINGS, maxFileSizeMB: 2048 }), "account",
      status => statuses.push(status), undefined, undefined, async () => ({ isVip: true, availableBytes: 0 }));
    const confirm = vi.fn(async tasks => {
      expect(tasks).toHaveLength(20);
      expect(readBinary).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
      return undefined;
    });
    expect(await engine.synchronize(false, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
    expect(db.getDiagnostics()).toMatchObject({ remoteNodes: 20, matchedNodes: 20, localFiles: 0,
      stages: expect.objectContaining({ "remote-request": expect.any(Number), plan: expect.any(Number) }) });
    expect(JSON.stringify(db.getDiagnostics())).not.toContain("http");
    db.close();
  });

  it("scans and plans 10,000 local files without blocking timers and can stop at a batch boundary", async () => {
    const { db } = await database();
    const makeFile = TFile as unknown as new (path: string, stat: unknown) => TFile;
    const files = Array.from({ length: 10_000 }, (_, i) => new makeFile(`file${i}.md`, { size: 0, mtime: 1, ctime: 1 }));
    const readBinary = vi.fn(async () => new ArrayBuffer(0));
    const vault = { getAllLoadedFiles: () => files, readBinary, adapter: {
      stat: async () => ({ type: "file", size: 0, mtime: 1, ctime: 1 }),
    } };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const engine = new SyncEngine(vault as never, db, remoteApi(0) as never, {} as never, {} as never,
      () => DEFAULT_SETTINGS, "account", () => undefined, undefined, undefined, async () => ({ isVip: true, availableBytes: 1 }));
    try {
      await engine.synchronize(false, async tasks => { expect(tasks).toHaveLength(10_000); return undefined; });
      expect(ticks).toBeGreaterThan(100);
      expect(db.getDiagnostics()).toMatchObject({ localFiles: 10_000, localBytes: 0 });
      const plan = (engine as unknown as { planTasks(): Promise<void> }).planTasks();
      setTimeout(() => engine.cancel(), 0);
      await expect(plan).rejects.toThrow("同步已停止");
    } finally { clearInterval(timer); db.close(); }
  }, 60_000);

  it("yields after 100 items even when each item is fast", async () => {
    const scheduler = new WorkScheduler();
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    for (let i = 0; i < 100; i++) await scheduler.step();
    expect(ticked).toBe(true);
  });
});
