import { readFile } from "node:fs/promises";
import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";
import { OpenApiClient, OpenApiError, type HttpRequest, type HttpResponse } from "../src/net/openapi-client.js";
import { SyncDatabase } from "../src/storage/database.js";

describe("OpenAPI client", () => {
  it("sends the exact public method, signed fields, and access token", async () => {
    const transport = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => ({
      status: 200,
      json: { errno: 0, errmsg: "", data: { bgsp: "10" }, trace_id: "trace-ok" },
    }));
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => "access",
      qid: () => "42",
      cloudToken: () => "cloud-token",
      signingSecret: () => "secret",
      transport,
    });

    await expect(client.call("Incr.getBgsp", {})).resolves.toEqual({ bgsp: "10" });
    const request = transport.mock.calls[0]?.[0];
    expect(request?.headers["Access-Token"]).toBe("access");
    expect(new URL(request!.url).searchParams.get("method")).toBe("Incr.getBgsp");
    expect(new URL(request!.url).searchParams.get("qid")).toBe("42");
    expect(new URL(request!.url).searchParams.get("token")).toBeNull();
    expect(new URL(request!.url).searchParams.get("sign")).toMatch(/^[a-f0-9]{32}$/);
  });

  it("passes the folder-only filter without changing the File.getList signature", async () => {
    const transport = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => ({
      status: 200,
      json: { errno: 0, data: { node_list: [] } },
    }));
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => "access",
      qid: () => "42",
      signingSecret: () => "secret",
      transport,
    });

    await client.call("File.getList", { page: 1, page_size: 200, path: "/", nodetype: "dir" });

    const params = new URL(transport.mock.calls[0]![0].url).searchParams;
    expect(params.get("nodetype")).toBe("dir");
    expect(params.get("sign")).toBe("bf3ea55d5326eb773decb2b876727f83");
  });

  it("binds upload tickets to the same cloud token used for Store", async () => {
    const transport = vi.fn(async (_request: HttpRequest): Promise<HttpResponse> => ({
      status: 200,
      json: { errno: 0, data: { tk: "ticket", http: "up1.yunpan.360.cn" } },
    }));
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => "access",
      qid: () => "42",
      cloudToken: () => "cloud-token",
      signingSecret: () => "secret",
      transport,
    });

    await client.call("Sync.getUploadFileAddr", { fname: "/a.md", fhash: "hash", fsize: 1 });

    const params = new URL(transport.mock.calls[0]![0].url).searchParams;
    expect(params.get("token")).toBe("cloud-token");
    expect(params.get("devtype")).toBe("ecs_openapi");
  });

  it("preserves backend errno and trace_id", async () => {
    
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => "access",
      qid: () => "42",
      signingSecret: () => "secret",
      transport: async () => ({ status: 200, json: { errno: 3203, errmsg: "cursor expired", trace_id: "trace-3203" } }),
    });
    await expect(client.call("Incr.getIncrGlobal", { gsp: "9" }))
      .rejects.toMatchObject({ errno: 3203, traceId: "trace-3203" } satisfies Partial<OpenApiError>);
    
    
  });

  it("refreshes an expired access token once and rebuilds the signed request", async () => {
    let accessToken = "expired-access";
    const refreshAccessToken = vi.fn(async () => { accessToken = "fresh-access"; });
    const transport = vi.fn(async (request: HttpRequest): Promise<HttpResponse> => {
      if (request.headers["Access-Token"] === "expired-access") return { status: 401, json: {} };
      return { status: 200, json: { errno: 0, data: { bgsp: "12" } } };
    });
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => accessToken,
      qid: () => "42",
      signingSecret: () => "secret",
      refreshAccessToken,
      transport,
    });

    await expect(client.call("Incr.getBgsp", {})).resolves.toEqual({ bgsp: "12" });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(new URL(transport.mock.calls[0]![0].url).searchParams.get("access_token")).toBe("expired-access");
    expect(new URL(transport.mock.calls[1]![0].url).searchParams.get("access_token")).toBe("fresh-access");
  });

  it("does not silently use an expired legacy credential", async () => {
    const refreshAccessToken = vi.fn(async () => { throw new Error("oauth_code migration required"); });
    const transport = vi.fn(async (): Promise<HttpResponse> => ({ status: 200, json: { errno: 0, data: {} } }));
    const client = new OpenApiClient({
      baseUrl: "https://openapi.eyun.360.cn/intf.php",
      accessToken: () => "legacy-access",
      qid: () => "42",
      accessTokenExpiresAt: () => 1,
      refreshAccessToken,
      signingSecret: () => "secret",
      transport,
    });

    await expect(client.call("Incr.getBgsp", {})).rejects.toThrow("oauth_code migration required");
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("sync database", () => {
  it("ignores completed deletion records whose names fail newer path validation", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const raw = new SQL.Database();
    const database = new SyncDatabase(raw);
    database.enqueue({ id: "legacy-done", kind: "recycle", path: "old.md", nid: "1", payload: { remote: { kind: "file", size: 1 } } });
    database.completeTask("legacy-done");
    raw.run("UPDATE tasks SET path=$path WHERE id='legacy-done'", { $path: `${"文".repeat(86)}.md` });
    expect(database.requeueStaleCompletedRecycleTasks(new Map(), new Set())).toBe(0);
  });
  it("stores cursors, nodes, baselines, and recovers running tasks", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const database = new SyncDatabase(new SQL.Database());
    database.setCursor({ accountKey: "42:7:vault", bgsp: "1", gsp: "2", remoteVersion: 3, snapshotComplete: true });
    database.replaceRemoteSnapshot([
      { nid: "1", pid: "0", path: "/Root/a.md", name: "a.md", isDir: false, version: 3, hash: "h", size: 1, mtime: 2 },
    ]);
    database.putBase("a.md", { hash: "h", size: 1, mtime: 2, kind: "file", nid: "1", version: 3 });
    database.enqueue({ id: "task-1", kind: "upload", path: "a.md", payload: { offset: 0 } });
    database.markTaskRunning("task-1");

    const bytes = database.export();
    const restored = new SyncDatabase(new SQL.Database(bytes));
    expect(restored.getCursor("42:7:vault")?.gsp).toBe("2");
    expect(restored.getRemoteNodes()).toHaveLength(1);
    expect(restored.getBase("a.md")?.hash).toBe("h");
    expect(restored.recoverInterruptedTasks()).toBe(1);
    expect(restored.nextRunnableTask(10)?.state).toBe("retry");
  });

  it("ships the sql.js wasm needed by the plugin build", async () => {
    await expect(readFile("node_modules/sql.js/dist/sql-wasm.wasm")).resolves.toBeInstanceOf(Buffer);
  });

  

  
});
