import { describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { RemoteIndexer, directorySnapshotScope } from "../src/sync/remote-indexer.js";
import { SyncDatabase } from "../src/storage/database.js";
import { OpenApiError } from "../src/net/openapi-client.js";

async function harness(count = 205) {
  const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
  const db = new SyncDatabase(new SQL.Database());
  const nodes = Array.from({ length: count }, (_, i) => ({ nid: `f${i}`, pid: "root", name: `/Bound/file${i}.md`,
    type: "0", count_size: "10", file_hash: "hash", modify_time: "123", nv: "2" }));
  let version = "17634529471902968";
  const call = vi.fn(async (method: string, input: Record<string, unknown>): Promise<unknown> => {
    if (method === "User.getVersion") return { ver: version };
    if (method !== "File.getList" || input.path !== "/Bound/") throw new Error(`unexpected ${method} ${input.path}`);
    const offset = (Number(input.page) - 1) * Number(input.page_size);
    return { data: { has_next_page: offset + Number(input.page_size) < nodes.length, total: nodes.length,
      node_list: nodes.slice(offset, offset + Number(input.page_size)) } };
  });
  const indexer = new RemoteIndexer({ call } as never, db, "account", 200, { remoteRoot: "/Bound/" });
  return { SQL, db, nodes, call, indexer, setVersion: (value: string) => { version = value; } };
}

describe("bound-directory cloud index", () => {
  it("paginates metadata only and preserves list metadata aliases and absolute paths", async () => {
    const { db, call, indexer } = await harness();
    await indexer.update();
    expect(db.getRemoteNodes()).toHaveLength(205);
    expect(db.getRemoteNode("f0")).toMatchObject({ path: "/Bound/file0.md", name: "file0.md",
      size: 10, hash: "hash", mtime: 123, version: 2 });
    expect(call.mock.calls.filter(([method]) => method === "File.getList").map(([, input]) => input)).toEqual([
      expect.objectContaining({ path: "/Bound/", page: 1, page_size: 200, download_ext: 0 }),
      expect.objectContaining({ path: "/Bound/", page: 2, page_size: 200, download_ext: 0 }),
    ]);
    expect(call.mock.calls.some(([method]) => method.startsWith("Incr."))).toBe(false);
    db.close();
  });

  it("skips unchanged listings but distinguishes adjacent large version strings", async () => {
    const { db, call, indexer, setVersion } = await harness(1);
    await indexer.update(); call.mockClear(); await indexer.update();
    expect(call.mock.calls.map(([method]) => method)).toEqual(["User.getVersion"]);
    setVersion("17634529471902969"); call.mockClear(); await indexer.update();
    expect(call.mock.calls.filter(([method]) => method === "File.getList")).toHaveLength(1);
    db.close();
  });

  it("migrates a global snapshot without clearing confirmed bindings, baseline, or upload recovery", async () => {
    const { db, indexer } = await harness(1);
    db.setCursor({ accountKey: "account", bgsp: "global", gsp: "global", remoteVersion: 0, snapshotComplete: true });
    db.upsertRemoteNode({ nid: "outside", pid: "0", path: "/Outside", name: "Outside", isDir: true,
      version: 1, mtime: 0, size: 0 });
    db.putBase("file0.md", { kind: "file", nid: "f0", size: 10, mtime: 123, hash: "hash" });
    db.enqueue({ id: "upload", kind: "upload", path: "local.md", payload: {} });
    const session = { tid: "session", endpoint: "store", ticket: "ticket", fileHash: "hash" };
    db.saveTransferSession("upload", session);
    db.confirmBinding("account");
    const base = db.getBase("file0.md"); const tasks = db.listPendingTasks();
    await indexer.update();
    expect(db.getRemoteNode("outside")).toBeUndefined();
    expect(db.getBase("file0.md")).toEqual(base); expect(db.listPendingTasks()).toEqual(tasks);
    expect(db.getTransferSession("upload")).toEqual(session);
    expect(db.isBindingConfirmed("account")).toBe(true);
    expect(db.getCursor("account")?.bgsp).toBe(directorySnapshotScope("/Bound/"));
    db.close();
  });

  it("walks nested and empty directories using string and object-map response formats", async () => {
    const { db, call, indexer } = await harness(0);
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (method, input) => {
      if (method !== "File.getList") return original(method, input);
      if (input.path === "/Bound/") return JSON.stringify({ data: { node_list: {
        child: { nid: "dir", pid: "root", name: "/Bound/目录/", type: "1" },
      }, has_next_page: "false" } });
      if (input.path === "/Bound/目录/") return { node_list: [
        { nid: "file", pid: "dir", name: "empty.md", type: 0, count_size: 0 },
        { nid: "unknown", pid: "dir", name: "unknown.pdf", type: 0 },
        { nid: "empty", pid: "dir", name: "empty", type: 1 },
      ], has_next_page: "0" };
      if (input.path === "/Bound/目录/empty/") return { node_list: [], total: "0", has_next_page: false };
      throw new Error("unexpected path");
    });
    await indexer.update();
    expect(db.getRemoteNodes()).toHaveLength(4);
    expect(db.getRemoteNode("file")).toMatchObject({ path: "/Bound/目录/empty.md", size: 0 });
    expect(db.getRemoteNode("unknown")).toMatchObject({ size: -1 });
    expect(call.mock.calls.filter(([method]) => method === "File.getList").map(([, input]) => input.path))
      .toEqual(["/Bound/", "/Bound/目录/", "/Bound/目录/empty/"]);
    db.close();
  });

  it.each(["network", "missing-list", "missing-pagination", "duplicate", "outside", "no-progress", "missing-child"])(
    "retains the complete index and cursor after %s failure", async failure => {
      const { db, call, indexer, setVersion } = await harness();
      await indexer.update(); const snapshot = db.getRemoteNodes(); const cursor = db.getCursor("account");
      setVersion("17634529471902969");
      const original = call.getMockImplementation()!;
      call.mockImplementation(async (method, input) => {
        if (method !== "File.getList") return original(method, input);
        if (failure === "network") throw new Error("network");
        if (failure === "missing-list") return { total: 0, has_next_page: false };
        if (failure === "missing-pagination") return { node_list: [] };
        if (failure === "outside") return { node_list: [{ nid: "bad", name: "/Elsewhere/a.md", type: 0 }], total: 1 };
        if (failure === "no-progress") return { node_list: [], has_next_page: true };
        if (failure === "missing-child") {
          if (input.path !== "/Bound/") throw new OpenApiError("源文件不存在", 3008);
          return { node_list: [{ nid: "child", name: "child", type: 1 }], has_next_page: false };
        }
        if (input.page === 2) return original(method, { ...input, page: 1 });
        return original(method, input);
      });
      await expect(indexer.update()).rejects.toThrow();
      expect(db.getRemoteNodes()).toEqual(snapshot); expect(db.getCursor("account")).toEqual(cursor);
      db.close();
    });

  it("restarts pagination if the account changes while reading and publishes only a stable snapshot", async () => {
    const { db, call, indexer, setVersion, nodes } = await harness(1);
    const original = call.getMockImplementation()!;
    let reads = 0;
    call.mockImplementation(async (method, input) => {
      const response = await original(method, input);
      if (method === "File.getList" && ++reads === 1) {
        nodes[0]!.name = "/Bound/renamed.md"; setVersion("17634529471902969");
      }
      return response;
    });
    await indexer.update();
    expect(reads).toBe(2);
    expect(db.getRemoteNode("f0")?.path).toBe("/Bound/renamed.md");
    db.close();
  });

  it("keeps the old snapshot if no stable version can be read", async () => {
    const { db, call, indexer } = await harness(1);
    await indexer.update(); const cursor = db.getCursor("account");
    const original = call.getMockImplementation()!; let version = 0;
    call.mockImplementation(async (method, input) => method === "User.getVersion" ? { ver: String(++version) } : original(method, input));
    await expect(indexer.update()).rejects.toThrow("云端文件仍在变化");
    expect(db.getCursor("account")).toEqual(cursor); expect(db.getRemoteNodes()).toHaveLength(1);
    db.close();
  });

  it("stops after the current request, with no next page or partial publication", async () => {
    const { db, call } = await harness(); let stopped = false;
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (method, input) => {
      const response = await original(method, input); if (method === "File.getList") stopped = true; return response;
    });
    const indexer = new RemoteIndexer({ call } as never, db, "account", 200, { remoteRoot: "/Bound/",
      check: () => { if (stopped) throw new Error("stopped"); } });
    await expect(indexer.update()).rejects.toThrow("stopped");
    expect(call.mock.calls.filter(([method]) => method === "File.getList")).toHaveLength(1);
    expect(db.getCursor("account")).toBeUndefined(); db.close();
  });

  it("retains the previous snapshot on cancellation during staged publication and restart", async () => {
    const { SQL, db, call, indexer } = await harness();
    await indexer.update(); const cursor = db.getCursor("account");
    let stopped = false; const stage = db.stageRemoteNodes.bind(db);
    vi.spyOn(db, "stageRemoteNodes").mockImplementation(nodes => { stage(nodes); stopped = true; });
    const interrupted = new RemoteIndexer({ call } as never, db, "account", 200, { remoteRoot: "/Bound/",
      check: () => { if (stopped) throw new Error("stopped"); } });
    await expect(interrupted.rebuild()).rejects.toThrow("stopped");
    const restored = new SyncDatabase(new SQL.Database(db.export()));
    expect(restored.getRemoteNodes()).toHaveLength(205); expect(restored.getCursor("account")).toEqual(cursor);
    restored.close(); db.close();
  });

  it("queries only an exact bound prefix, treating wildcard characters literally", async () => {
    const { db } = await harness(0);
    for (const [i, path] of ["/A%_/a.md", "/Abc/b.md", "/A%_other/c.md", "/a%_/D.md"].entries()) {
      db.upsertRemoteNode({ nid: String(i), pid: "0", path, name: path.split("/").at(-1)!,
        isDir: false, version: 1, size: 1, mtime: 1 });
    }
    const paths: string[] = [];
    for await (const batch of db.remoteNodeBatches("/A%_/")) paths.push(...batch.map(node => node.path));
    expect(paths).toEqual(["/A%_/a.md", "/a%_/D.md"]); db.close();
  });
});
