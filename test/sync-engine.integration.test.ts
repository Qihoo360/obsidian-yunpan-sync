import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";
import { TAbstractFile, TFile, TFolder } from "obsidian";
import { SyncEngine } from "../src/sync/engine.js";
import { SyncDatabase } from "../src/storage/database.js";
import { DEFAULT_SETTINGS, FILE_SIZE_MB, type PluginSettings } from "../src/settings.js";
import { cloudFileHashes } from "../src/transfer/hashes.js";
import type { SyncQuota } from "../src/sync/quota.js";
import { DownloadMachine } from "../src/transfer/download.js";
import { OpenApiError } from "../src/net/openapi-client.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TestFile = TFile as unknown as new (path: string, stat: { ctime: number; mtime: number; size: number }) => TFile;
const TestFolder = TFolder as unknown as new (path: string) => TFolder;

type LocalEntry = { kind: "file"; data: Uint8Array; ctime: number; mtime: number } | { kind: "directory" };

class MemoryVault {
  readonly entries = new Map<string, LocalEntry>();
  private clock = 1_700_000_000_000;
  failAtomicReplacement = false;
  afterRename?: (source: string, destination: string) => void;

  readonly adapter: {
    exists(path: string, sensitive?: boolean): Promise<boolean>;
    stat(path: string): Promise<{ type: "file" | "folder"; size: number; ctime: number; mtime: number } | null>;
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer, options?: { mtime?: number }): Promise<void>;
    rename(source: string, destination: string): Promise<void>;
    remove(path: string): Promise<void>;
    trashLocal(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
  };

  constructor() {
    this.adapter = {
      exists: async (path) => this.entries.has(path),
      stat: async (path) => {
      const entry = this.entries.get(path);
      if (!entry) return null;
      return entry.kind === "directory"
        ? { type: "folder", size: 0, ctime: 0, mtime: 0 }
        : { type: "file", size: entry.data.byteLength, ctime: entry.ctime, mtime: entry.mtime };
      },
      readBinary: async (path) => this.entries.get(path)?.kind === "file"
        ? (this.entries.get(path) as Extract<LocalEntry, { kind: "file" }>).data.slice().buffer
        : Promise.reject(new Error(`missing file ${path}`)),
      writeBinary: async (path, data, options) => {
        const now = ++this.clock;
        this.entries.set(path, { kind: "file", data: new Uint8Array(data), ctime: now, mtime: options?.mtime ?? now });
      },
      rename: async (source, destination) => {
        if (this.failAtomicReplacement && source.includes(".yunpan-sync-") && source.endsWith(".part")) {
          this.failAtomicReplacement = false;
          throw new Error("atomic replacement failed");
        }
        this.renamePath(source, destination);
      },
      remove: async (path) => { this.removePath(path); },
      trashLocal: async (path) => { this.removePath(path); },
      mkdir: async (path) => { this.entries.set(path, { kind: "directory" }); },
      list: async (path) => {
        const prefix = `${path}/`;
        const files: string[] = [];
        const folders: string[] = [];
        for (const [candidate, entry] of this.entries) {
          if (!candidate.startsWith(prefix) || candidate.slice(prefix.length).includes("/")) continue;
          (entry.kind === "file" ? files : folders).push(candidate);
        }
        return { files, folders };
      },
    };
  }

  putFile(path: string, text: string): void {
    const now = ++this.clock;
    this.entries.set(path, { kind: "file", data: encoder.encode(text), ctime: now, mtime: now });
  }
  mkdir(path: string): void { this.entries.set(path, { kind: "directory" }); }
  delete(path: string): void { this.removePath(path); }
  text(path: string): string | undefined {
    const entry = this.entries.get(path);
    return entry?.kind === "file" ? decoder.decode(entry.data) : undefined;
  }
  paths(): string[] { return [...this.entries.keys()].sort(); }
  getAllLoadedFiles(): TAbstractFile[] {
    return [...this.entries].map(([path, entry]) => entry.kind === "directory"
      ? new TestFolder(path)
      : new TestFile(path, { ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength }));
  }
  getFileByPath(path: string): TFile | null {
    const entry = this.entries.get(path);
    return entry?.kind === "file" ? new TestFile(path, { ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength }) : null;
  }
  getAbstractFileByPath(path: string): TAbstractFile | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    return entry.kind === "file" ? this.getFileByPath(path) : new TestFolder(path);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> { return this.adapter.readBinary(file.path); }
  async createFolder(path: string): Promise<void> { this.mkdir(path); }
  async rename(file: TAbstractFile, destination: string): Promise<void> {
    const source = file.path;
    this.renamePath(source, destination);
    file.path = destination;
  }
  async trash(file: TAbstractFile): Promise<void> { this.removePath(file.path); }

  private renamePath(source: string, destination: string): void {
    const matches = [...this.entries].filter(([path]) => path === source || path.startsWith(`${source}/`));
    if (matches.length === 0) throw new Error(`missing ${source}`);
    for (const [path] of matches) this.entries.delete(path);
    for (const [path, entry] of matches) this.entries.set(`${destination}${path.slice(source.length)}`, entry);
    this.afterRename?.(source, destination);
  }
  private removePath(path: string): void {
    for (const candidate of [...this.entries.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.entries.delete(candidate);
    }
  }
}

type CloudEntry = { nid: string; pid: string; path: string; isDir: boolean; data?: Uint8Array; hash?: string; version: number; mtime: number; status?: number };

class MemoryCloud {
  omitFileSizes = false;
  quota: SyncQuota = { isVip: true, availableBytes: 1_000_000 };
  readonly entries = new Map<string, CloudEntry>();
  private changes: CloudEntry[] = [];
  private nextNid = 2;
  version = 1;
  uploadDelayMs = 0;
  failUploadPath?: string;
  activeUploads = 0;
  peakUploads = 0;
  omitUploadNid = false;
  beforeRename?: () => void;
  renameError?: string;
  readonly calls: string[] = [];
  readonly listPaths: string[] = [];

  constructor() {
    this.entries.set("/Obsidian", { nid: "1", pid: "0", path: "/Obsidian", isDir: true, version: 1, mtime: 0 });
  }

  async putFile(path: string, text: string): Promise<string> {
    const normalized = path.replace(/\/$/, "");
    const current = this.entries.get(normalized);
    const data = encoder.encode(text);
    const hash = (await cloudFileHashes(data)).fileHash;
    const entry: CloudEntry = { nid: current?.nid ?? String(this.nextNid++), pid: this.parentNid(normalized), path: normalized,
      isDir: false, data, hash, version: ++this.version, mtime: this.version };
    this.entries.set(normalized, entry);
    this.changes.push(entry);
    return entry.nid;
  }
  mkdir(path: string): string {
    const normalized = path.replace(/\/$/, "");
    const current = this.entries.get(normalized);
    if (current) return current.nid;
    const entry: CloudEntry = { nid: String(this.nextNid++), pid: this.parentNid(normalized), path: normalized,
      isDir: true, version: ++this.version, mtime: 0 };
    this.entries.set(normalized, entry);
    this.changes.push(entry);
    return entry.nid;
  }
  remove(path: string): void {
    const normalized = path.replace(/\/$/, "");
    const removed = [...this.entries.values()].filter((entry) => entry.path === normalized || entry.path.startsWith(`${normalized}/`));
    for (const entry of removed) this.entries.delete(entry.path);
    const root = removed.find((entry) => entry.path === normalized);
    if (root) this.changes.push({ ...root, version: ++this.version, status: 10 });
  }
  rename(source: string, destination: string): void {
    const matches = [...this.entries.values()].filter((entry) => entry.path === source || entry.path.startsWith(`${source}/`));
    if (matches.length === 0) throw new Error("源文件不存在");
    if (source !== destination && this.entries.has(destination)) throw new Error("目标已存在");
    for (const entry of matches) this.entries.delete(entry.path);
    for (const entry of matches) {
      const moved = { ...entry, path: `${destination}${entry.path.slice(source.length)}`, version: ++this.version };
      moved.pid = this.parentNid(moved.path);
      this.entries.set(moved.path, moved);
      this.changes.push(moved);
    }
  }
  text(path: string): string | undefined { const data = this.entries.get(path)?.data; return data ? decoder.decode(data) : undefined; }
  paths(): string[] { return [...this.entries.keys()].filter((path) => path !== "/Obsidian").map((path) => path.slice("/Obsidian/".length)).sort(); }

  readonly api = { call: async <T>(method: string, input: Record<string, unknown>): Promise<T> => {
    this.calls.push(method);
    if (method === "User.getUserDetail") return { is_vip: 1, available_size: this.quota.availableBytes } as T;
    if (method === "Enterprise.getListByUser") return {} as T;
    if (method === "User.getVersion") return { ver: this.version } as T;
    if (method === "File.getList") {
      const path = String(input.path).replace(/\/$/, "");
      this.listPaths.push(String(input.path));
      if (!this.entries.get(path)?.isDir) throw new OpenApiError("源文件不存在", 3008);
      const children = [...this.entries.values()].filter(entry => entry.path.slice(0, entry.path.lastIndexOf("/")) === path)
        .sort((a, b) => a.path.localeCompare(b.path));
      const offset = (Number(input.page) - 1) * Number(input.page_size);
      return { node_list: await this.raw(children.slice(offset, offset + Number(input.page_size))),
        total: children.length, has_next_page: offset + Number(input.page_size) < children.length } as T;
    }
    if (method === "Incr.getBgsp") return { bgsp: "1", gsp: "1", ver: this.version, total: this.entries.size } as T;
    if (method === "Incr.getGlobalNodes") return { node_list: await this.raw([...this.entries.values()]), retnum: this.entries.size, gsp: "1", spnid: "0" } as T;
    if (method === "Incr.getIncrGlobal") {
      const changes = this.changes.splice(0);
      return { node_list: await this.raw(changes), retnum: changes.length, gsp: String(this.version), ver: this.version, spnid: "0" } as T;
    }
    if (method === "File.mkdir") return { nid: this.mkdir(String(input.fname)) } as T;
    if (method === "File.syncRecycle") { this.remove(String(input.fname)); return {} as T; }
    if (method === "File.rename") {
      this.beforeRename?.();
      if (this.renameError) throw new Error(this.renameError);
      const source = String(input.src_name);
      const slash = source.lastIndexOf("/");
      this.rename(source, `${source.slice(0, slash + 1)}${String(input.new_name)}`);
      return {} as T;
    }
    if (method === "File.move") {
      const source = String(input.src_name);
      this.rename(source, `${String(input.new_name).replace(/\/$/, "")}/${source.slice(source.lastIndexOf("/") + 1)}`);
      return {} as T;
    }
    throw new Error(`unexpected method ${method}`);
  } };

  readonly uploader = { upload: async (input: { path: string; data: Uint8Array }): Promise<Record<string, unknown>> => {
    this.activeUploads++;
    this.peakUploads = Math.max(this.peakUploads, this.activeUploads);
    try {
      if (this.uploadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.uploadDelayMs));
      if (input.path === this.failUploadPath) throw new Error("simulated upload failure");
      const nid = await this.putFile(input.path, decoder.decode(input.data));
      return this.omitUploadNid ? {} : { nid };
    } finally {
      this.activeUploads--;
    }
  } };
  readonly downloader = { download: async (input: { path: string; nid?: string }): Promise<Uint8Array> => {
    const entry = input.nid ? [...this.entries.values()].find((candidate) => candidate.nid === input.nid) : this.entries.get(input.path);
    if (!entry?.data) throw new Error(`missing remote file ${input.path}`);
    return entry.data.slice();
  } };

  private parentNid(path: string): string {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/Obsidian";
    return this.entries.get(parent)?.nid ?? "1";
  }
  private async raw(entries: CloudEntry[]): Promise<Record<string, unknown>[]> {
    return entries.map((entry) => ({ nid: entry.nid, pid: entry.pid, name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
      is_dir: entry.isDir ? 1 : 0, fhash: entry.hash, fsize: this.omitFileSizes && !entry.isDir ? undefined : entry.data?.byteLength ?? 0,
      fmtime: entry.mtime, nv: entry.version, status: entry.status }));
  }
}

async function harness(paused = false): Promise<{ vault: MemoryVault; cloud: MemoryCloud; engine: SyncEngine; db: SyncDatabase; settings: PluginSettings; statuses: import("../src/sync/engine.js").EngineStatus[] }> {
  const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
  const vault = new MemoryVault();
  const cloud = new MemoryCloud();
  const db = new SyncDatabase(new SQL.Database());
  const statuses: import("../src/sync/engine.js").EngineStatus[] = [];
  const settings = { ...DEFAULT_SETTINGS, paused, remoteRoot: "/Obsidian/", ownerQid: "42" };
  const engine = new SyncEngine(vault as never, db, cloud.api as never, cloud.uploader as never, cloud.downloader as never,
    () => settings, "42:vault", (status) => statuses.push(status), undefined, undefined, async () => cloud.quota);
  return { vault, cloud, engine, db, settings, statuses };
}

async function synchronize(engine: SyncEngine): Promise<void> {
  await engine.synchronize(false, async (tasks) => new Set(tasks.map((task) => task.id)));
}

describe("complete in-memory two-way synchronization", () => {
  it("ignores 20,000 unrelated account nodes on first and subsequent scoped scans", async () => {
    const { vault, cloud, engine, db } = await harness();
    for (let i = 0; i < 20_000; i++) {
      cloud.entries.set(`/Unrelated/file${i}`, { nid: `outside${i}`, pid: "outside", path: `/Unrelated/file${i}`,
        isDir: false, version: 1, mtime: 1 });
    }
    cloud.mkdir("/Obsidian/notes");
    for (let i = 0; i < 100; i++) await cloud.putFile(`/Obsidian/notes/file${i}.md`, "note");
    await synchronize(engine);
    expect(vault.paths().filter(path => path.endsWith(".md"))).toHaveLength(100);
    expect(cloud.listPaths).toEqual(["/Obsidian/", "/Obsidian/notes/"]);
    expect(db.getRemoteNodes()).toHaveLength(101);
    const before = cloud.listPaths.length;
    await synchronize(engine);
    expect(cloud.listPaths).toHaveLength(before);
    cloud.version++; // An unrelated account change may invalidate the cheap version check.
    await synchronize(engine);
    expect(cloud.listPaths.slice(before)).toEqual(["/Obsidian/", "/Obsidian/notes/"]);
    expect(cloud.calls.some(method => method.startsWith("Incr."))).toBe(false);
    expect(db.getDiagnostics()).toMatchObject({ remoteNodes: 101, matchedNodes: 101 });
  });

  it("preserves local files and baseline when an existing bound root disappears", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "keep"); await synchronize(engine);
    const base = db.getBase("note.md");
    const snapshot = db.getRemoteNodes();
    cloud.remove("/Obsidian");
    await expect(synchronize(engine)).rejects.toThrow("源文件不存在");
    expect(vault.text("note.md")).toBe("keep");
    expect(db.getBase("note.md")).toEqual(base);
    expect(db.getRemoteNodes()).toEqual(snapshot);
  });

  it("can create a new missing bound directory without enumerating account parents", async () => {
    const { vault, cloud, engine, settings } = await harness();
    settings.remoteRoot = "/New/Nested/"; vault.putFile("note.md", "new");
    await synchronize(engine);
    expect(cloud.text("/New/Nested/note.md")).toBe("new");
    expect(cloud.listPaths).toEqual(["/New/Nested/"]);
    expect(cloud.calls.some(method => method.startsWith("Incr."))).toBe(false);
  });

  it("does not confirm a binding or transfer files if stopped while awaiting initial confirmation", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("local.md", "local");
    await cloud.putFile("/Obsidian/remote.md", "remote");
    const upload = vi.spyOn(cloud.uploader, "upload");
    const download = vi.spyOn(cloud.downloader, "download");
    expect(await engine.synchronize(false, async tasks => {
      engine.cancel();
      return new Set(tasks.map(task => task.id));
    })).toBe(false);
    expect(db.isBindingConfirmed("42:vault")).toBe(false);
    expect(upload).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(vault.text("remote.md")).toBeUndefined();
  });

  it("recovers a persisted illegal task name by node identity after restart", async () => {
    const { vault, cloud, engine, settings, db } = await harness();
    const nid = await cloud.putFile("/Obsidian/bad:name.md", "content"); await synchronize(engine);
    db.enqueue({ id: "legacy", kind: "download", path: "placeholder.md", nid,
      payload: { remote: { nid, kind: "file", size: 7 } } });
    db.failTask("legacy", "ENAMETOOLONG");
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const raw = new SQL.Database(db.export());
    raw.run("UPDATE tasks SET path=$path WHERE id='legacy'", { $path: "bad:name.md" });
    const restored = new SyncDatabase(new SQL.Database(raw.export()));
    expect(restored.listFailedTasks()[0]?.path).toBe("bad:name.md");
    cloud.rename("/Obsidian/bad:name.md", "/Obsidian/fixed.md");
    const restarted = new SyncEngine(vault as never, restored, cloud.api as never, cloud.uploader as never, cloud.downloader as never,
      () => settings, "42:vault", () => undefined, undefined, undefined, async () => cloud.quota);
    expect(restarted.retryFailed()).toBe(1); await synchronize(restarted);
    expect(vault.text("fixed.md")).toBe("content");
    expect(restored.taskCounts()).toEqual({ queued: 0, failed: 0 });
  });

  it("does not let a deleted node's old retry overwrite its replacement or local original", async () => {
    const { vault, cloud, engine, db, statuses } = await harness();
    const nid = await cloud.putFile("/Obsidian/note.md", "original"); await synchronize(engine);
    const base = db.getBase("note.md");
    db.enqueue({ id: "old", kind: "download", path: "note.md", nid, payload: { local: base, remote: base, base } });
    db.failTask("old", "文件名不合法");
    cloud.remove("/Obsidian/note.md"); await cloud.putFile("/Obsidian/note.md", "replacement");
    expect(engine.retryFailed()).toBe(1); await synchronize(engine);
    expect(vault.text("note.md")).toBe("original"); expect(cloud.text("/Obsidian/note.md")).toBe("replacement");
    expect(db.getBase("note.md")).toEqual(base);
    expect(statuses.at(-1)?.skippedFiles).toContainEqual(expect.objectContaining({ path: "note.md", reason: expect.stringContaining("不存在") }));
  });

  it("validates changed download metadata before moving a local conflict copy", async () => {
    const { vault, cloud, engine, db, settings } = await harness();
    vault.putFile("note.md", "b"); await synchronize(engine);
    vault.putFile("note.md", "LL"); await cloud.putFile("/Obsidian/note.md", "RR");
    settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    const store = { download: vi.fn(), callJson: vi.fn() };
    const downloader = new DownloadMachine({ call: vi.fn().mockResolvedValue({
      http: "https://dl1.yunpan.360.cn/intf.php", fhash: "a".repeat(40), fsize: 50,
    }) }, () => store);
    const guarded = new SyncEngine(vault as never, db, cloud.api as never, cloud.uploader as never, downloader,
      () => settings, "42:vault", () => undefined, undefined, undefined, async () => cloud.quota);
    await synchronize(guarded);
    expect(vault.paths()).toEqual(["note.md"]); expect(vault.text("note.md")).toBe("LL");
    expect(cloud.text("/Obsidian/note.md")).toBe("RR");
    expect(db.unresolvedConflictCount()).toBe(0); expect(db.taskCounts()).toEqual({ queued: 0, failed: 0 });
    expect(store.download).not.toHaveBeenCalled(); expect(store.callJson).not.toHaveBeenCalled();
  });

  it("excludes both directions before reading contents and resumes after expanding the range", async () => {
    const { vault, cloud, engine, settings, statuses, db } = await harness();
    settings.minFileSizeMB = 2 / FILE_SIZE_MB; settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    vault.putFile("too-small.md", "x"); vault.putFile("too-large.pdf", "12345");
    await cloud.putFile("/Obsidian/remote.pdf", "12345");
    vault.putFile("boundary.docx", "1234");
    const read = vi.spyOn(vault.adapter, "readBinary");
    await synchronize(engine);
    expect(read.mock.calls.map(call => call[0])).toEqual(["boundary.docx", "boundary.docx"]);
    expect(cloud.text("/Obsidian/too-large.pdf")).toBeUndefined();
    expect(vault.text("remote.pdf")).toBeUndefined();
    expect(db.listFailedTasks()).toEqual([]);
    expect(statuses.at(-1)?.skippedFiles).toHaveLength(3);
    expect(statuses.at(-1)?.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "too-small.md", source: "local", size: 1 }),
      expect.objectContaining({ path: "too-large.pdf", source: "local", size: 5 }),
      expect.objectContaining({ path: "remote.pdf", source: "remote", size: 5 }),
    ]));
    settings.minFileSizeMB = 0; settings.maxFileSizeMB = 30;
    await synchronize(engine);
    expect(vault.text("remote.pdf")).toBe("12345");
    expect(cloud.text("/Obsidian/too-large.pdf")).toBe("12345");
  });

  it.each(["local", "remote"])("retains an excluded %s file and baseline when the other side is missing", async side => {
    const { vault, cloud, engine, settings, db } = await harness();
    vault.putFile("large.pdf", "12345"); await synchronize(engine);
    const base = db.getBase("large.pdf");
    settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    if (side === "local") cloud.remove("/Obsidian/large.pdf"); else vault.delete("large.pdf");
    await synchronize(engine);
    expect(side === "local" ? vault.text("large.pdf") : cloud.text("/Obsidian/large.pdf")).toBe("12345");
    expect(db.getBase("large.pdf")).toEqual(base);
    expect(db.listPendingTasks()).toEqual([]);
  });

  it("protects a recursive cloud delete containing an excluded descendant", async () => {
    const { vault, cloud, engine, settings, db } = await harness();
    vault.mkdir("folder"); vault.putFile("folder/large.pdf", "12345"); vault.putFile("folder/small.md", "x");
    await synchronize(engine);
    const base = db.getBase("folder/large.pdf");
    vault.delete("folder"); settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    await synchronize(engine);
    expect(cloud.text("/Obsidian/folder/large.pdf")).toBe("12345");
    expect(cloud.entries.get("/Obsidian/folder")?.isDir).toBe(true);
    expect(db.getBase("folder/large.pdf")).toEqual(base);
  });

  it("does not move an excluded descendant with a remotely renamed directory", async () => {
    const { vault, cloud, engine, settings, db } = await harness();
    vault.mkdir("folder"); vault.putFile("folder/large.pdf", "12345"); await synchronize(engine);
    const base = db.getBase("folder/large.pdf");
    settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    cloud.rename("/Obsidian/folder", "/Obsidian/renamed");
    await synchronize(engine);
    expect(vault.text("folder/large.pdf")).toBe("12345");
    expect(vault.text("renamed/large.pdf")).toBeUndefined();
    expect(db.getBase("folder/large.pdf")).toEqual(base);
  });

  it("retires excluded historical queued work without turning it into a failure", async () => {
    const { vault, engine, db, settings, cloud } = await harness();
    vault.putFile("large.pdf", "12345"); settings.maxFileSizeMB = 4 / FILE_SIZE_MB;
    db.enqueue({ id: "old-upload", kind: "upload", path: "large.pdf", payload: { local: { kind: "file", size: 5 } } });
    await synchronize(engine);
    expect(db.listPendingTasks()).toEqual([]); expect(db.listFailedTasks()).toEqual([]);
    expect(cloud.text("/Obsidian/large.pdf")).toBeUndefined(); expect(vault.text("large.pdf")).toBe("12345");
  });

  it("skips a file that grows after confirmation and releases its running task", async () => {
    const { vault, cloud, engine, settings, db, statuses } = await harness();
    settings.maxFileSizeMB = 4 / FILE_SIZE_MB; vault.putFile("growing.md", "x");
    await engine.synchronize(false, async tasks => {
      vault.putFile("growing.md", "12345"); return new Set(tasks.map(task => task.id));
    });
    expect(db.taskCounts()).toEqual({ queued: 0, failed: 0 });
    expect(cloud.text("/Obsidian/growing.md")).toBeUndefined();
    expect(statuses.at(-1)?.skippedFiles).toContainEqual(expect.objectContaining({ path: "growing.md" }));
  });

  it.each(["bad:name.pdf", "CON.pdf", "a".repeat(256), "文".repeat(86), "emoji😀.md"])("refreshes scan-only errors after remotely renaming %s", async bad => {
    const { vault, cloud, engine, statuses } = await harness();
    const nid = await cloud.putFile(`/Obsidian/${bad}`, "content");
    await synchronize(engine);
    const failure = statuses.at(-1)?.fileFailures?.[0];
    expect(failure).toMatchObject({ nid, source: "remote" });
    expect(vault.paths()).toEqual([]);
    const oldVersion = cloud.version;
    cloud.rename(`/Obsidian/${bad}`, "/Obsidian/fixed.pdf");
    cloud.version = oldVersion; // Proves retry bypasses the unchanged-version fast path.
    expect(engine.retryTask(failure!.id!)).toBe(true);
    const start = cloud.calls.length;
    await synchronize(engine);
    expect(cloud.calls.slice(start)).toContain("File.getList");
    expect(vault.text("fixed.pdf")).toBe("content");
    expect(statuses.at(-1)?.fileFailures).toEqual([]);
  });

  it("protects baseline identity under an invalid parent and retries after the parent is fixed", async () => {
    const { vault, cloud, engine, db, statuses } = await harness();
    vault.mkdir("folder"); vault.putFile("folder/note.md", "base"); await synchronize(engine);
    const base = db.getBase("folder/note.md");
    cloud.rename("/Obsidian/folder", "/Obsidian/bad:folder");
    await synchronize(engine);
    expect(vault.text("folder/note.md")).toBe("base");
    expect(db.getBase("folder/note.md")).toEqual(base);
    cloud.rename("/Obsidian/bad:folder", "/Obsidian/fixed");
    expect(engine.retryFailed()).toBeGreaterThan(0);
    await synchronize(engine);
    expect(vault.text("fixed/note.md")).toBe("base");
    expect(statuses.at(-1)?.fileFailures).toEqual([]);
  });

  it("keeps scan failures actionable if retry metadata refresh fails", async () => {
    const { cloud, engine, statuses } = await harness();
    await cloud.putFile("/Obsidian/bad:name.md", "x"); await synchronize(engine);
    expect(engine.retryFailed()).toBe(1);
    const call = cloud.api.call;
    vi.spyOn(cloud.api, "call").mockImplementation(async (method, input) => {
      if (method === "File.getList") throw new Error("network unavailable");
      return call(method, input);
    });
    await expect(synchronize(engine)).rejects.toThrow("network unavailable");
    expect(statuses.at(-1)?.fileFailures).toHaveLength(1);
    expect(engine.retryFailed()).toBe(1);
  });

  it("preflights before any file operations, preserves pending tasks and resumes after expansion", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("new.md", "12345");
    cloud.quota.availableBytes = 4;
    await expect(synchronize(engine)).rejects.toMatchObject({ kind: "capacity", remainingBytes: 4, requiredBytes: 5 });
    expect(cloud.paths()).toEqual([]);
    expect(cloud.calls.filter(method => method.startsWith("File.") && method !== "File.getList")).toEqual([]);
    expect(db.getLastSuccessfulSync()).toBeUndefined();
    expect(db.listPendingTasks()).toHaveLength(1);
    expect(db.listFailedTasks()).toHaveLength(0);
    cloud.quota.availableBytes = 5;
    await synchronize(engine);
    expect(cloud.text("/Obsidian/new.md")).toBe("12345");
  });

  it("refreshes membership for every run and blocks downloads, deletes and repair when expired", async () => {
    const { vault, cloud, engine, db, statuses } = await harness();
    vault.putFile("note.md", "base"); await synchronize(engine);
    await vault.trash(vault.getFileByPath("note.md")!);
    await cloud.putFile("/Obsidian/remote.md", "download");
    cloud.quota = { isVip: false, expiresAt: Date.now() - 1, availableBytes: 100 };
    const before = cloud.paths(); const callCount = cloud.calls.length;
    await expect(engine.synchronize(true)).rejects.toMatchObject({ kind: "membership" });
    expect(cloud.calls.slice(callCount)).toEqual([]);
    expect(cloud.paths()).toEqual(before); expect(vault.paths()).toEqual([]);
    expect(statuses.at(-1)?.restriction?.kind).toBe("membership");
    cloud.quota = { isVip: true, availableBytes: 100 };
    await synchronize(engine);
    expect(vault.text("remote.md")).toBe("download");
    expect(db.listPendingTasks()).toEqual([]);
  });

  it("checks only confirmed uploads, retains all tasks if blocked, and allows pure downloads without quota", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("small", "12"); vault.putFile("large", "123456789");
    cloud.quota.availableBytes = 1;
    const chooseSmall = async (tasks: readonly import("../src/storage/database.js").SyncTask[]) => new Set(tasks.filter(t => t.path === "small").map(t => t.id));
    await expect(engine.synchronize(false, chooseSmall)).rejects.toMatchObject({ kind: "capacity", requiredBytes: 2 });
    expect(db.listPendingTasks().map(t => t.path).sort()).toEqual(["large", "small"]);
    expect(engine.needsInitialConfirmation()).toBe(true);
    cloud.quota.availableBytes = 2;
    await engine.synchronize(false, chooseSmall);
    expect(cloud.paths()).toEqual(["small"]);

    const other = await harness();
    other.cloud.quota = { isVip: false };
    await other.cloud.putFile("/Obsidian/download", "data");
    await synchronize(other.engine);
    expect(other.vault.text("download")).toBe("data");
  });

  it("uses current retry sizes, counts growth only and blocks missing capacity before any file operation", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note", "base"); await synchronize(engine);
    vault.putFile("note", "12345"); cloud.quota.availableBytes = 0;
    await expect(synchronize(engine)).rejects.toMatchObject({ requiredBytes: 1 });
    const pending = db.listPendingTasks().find(t => t.kind === "upload")!;
    db.failTask(pending.id, "retry", 0);
    vault.putFile("note", "12345678"); cloud.quota.availableBytes = 3;
    await expect(synchronize(engine)).rejects.toMatchObject({ requiredBytes: 4 });
    expect(db.listPendingTasks().filter(t => t.kind === "upload")).toHaveLength(1);
    expect(cloud.text("/Obsidian/note")).toBe("base");
    cloud.quota.availableBytes = 4; await synchronize(engine);
    vault.putFile("note", "1"); cloud.quota = { isVip: true };
    const callCount = cloud.calls.length;
    await expect(synchronize(engine)).rejects.toMatchObject({ kind: "unknown" });
    expect(cloud.calls.slice(callCount).filter(c => c.startsWith("File.") && c !== "File.getList")).toEqual([]);
    cloud.quota.availableBytes = 0; await synchronize(engine);
    expect(cloud.text("/Obsidian/note")).toBe("1");
  });

  it("does not guess an overwrite size when the remote index omits file metadata", async () => {
    const { vault, cloud, engine, statuses, db } = await harness();
    vault.putFile("note", "base"); await synchronize(engine);
    const base = db.getBase("note");
    vault.putFile("note", "growth"); cloud.omitFileSizes = true;
    const callCount = cloud.calls.length;
    await expect(engine.synchronize(true)).resolves.toBe(true);
    expect(cloud.calls.slice(callCount).filter(c => c.startsWith("File.") && c !== "File.getList")).toEqual([]);
    expect(cloud.text("/Obsidian/note")).toBe("base");
    expect(vault.text("note")).toBe("growth");
    expect(db.getBase("note")).toEqual(base);
    expect(statuses.at(-1)?.skippedFiles).toContainEqual(expect.objectContaining({ path: "note" }));
  });

  it("budgets a conflict copy once before preserving it", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    vault.putFile("note.md", "local"); await cloud.putFile("/Obsidian/note.md", "remote");
    cloud.quota.availableBytes = 4;
    await expect(synchronize(engine)).rejects.toMatchObject({ requiredBytes: 5 });
    expect(vault.text("note.md")).toBe("local");
    cloud.quota.availableBytes = 5; await synchronize(engine);
    expect(cloud.paths()).toEqual(vault.paths());
  });

  it("replaces an obsolete upload retry with conflict work without double counting its bytes", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note", "base"); await synchronize(engine);
    vault.putFile("note", "local-data"); cloud.quota.availableBytes = 0;
    await expect(synchronize(engine)).rejects.toMatchObject({ kind: "capacity" });
    await cloud.putFile("/Obsidian/note", "remote"); cloud.quota.availableBytes = 9;
    await expect(synchronize(engine)).rejects.toMatchObject({ requiredBytes: 10 });
    cloud.quota.availableBytes = 10; await synchronize(engine);
    expect(cloud.paths()).toEqual(vault.paths());
    expect(vault.text("note")).toBe("remote");
  });

  it.each([true, false])("preflights file/directory conflicts and preserves the complete local version (localDirectory=%s)", async localDirectory => {
    const { vault, cloud, engine } = await harness();
    if (localDirectory) { vault.mkdir("same"); vault.putFile("same/child", "child"); await cloud.putFile("/Obsidian/same", "remote"); }
    else { vault.putFile("same", "local"); cloud.mkdir("/Obsidian/same"); await cloud.putFile("/Obsidian/same/child", "remote"); }
    cloud.quota.availableBytes = 4;
    await expect(synchronize(engine)).rejects.toMatchObject({ requiredBytes: 5 });
    cloud.quota.availableBytes = 5;
    await synchronize(engine);
    expect(cloud.paths()).toEqual(vault.paths());
    const protectedPath = vault.paths().find(path => path.startsWith("same (conflict-") && !path.includes("/"))!;
    expect(vault.text(localDirectory ? `${protectedPath}/child` : protectedPath)).toBe(localDirectory ? "child" : "local");
    expect(vault.text(localDirectory ? "same" : "same/child")).toBe("remote");
  });

  it("counts the entire protected directory before performing a divergent rename", async () => {
    const { vault, cloud, engine } = await harness();
    vault.mkdir("folder"); vault.putFile("folder/note.md", "base");
    cloud.mkdir("/Obsidian/folder"); await cloud.putFile("/Obsidian/folder/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getAbstractFileByPath("folder")!, "local-folder");
    engine.recordRename("folder", "local-folder");
    vault.putFile("local-folder/new.md", "new");
    cloud.rename("/Obsidian/folder", "/Obsidian/remote-folder");
    cloud.quota.availableBytes = 6;
    const beforeLocal = vault.paths(); const beforeRemote = cloud.paths();
    await expect(synchronize(engine)).rejects.toMatchObject({ kind: "capacity", requiredBytes: 7 });
    expect(vault.paths()).toEqual(beforeLocal);
    expect(cloud.paths()).toEqual(beforeRemote);
    cloud.quota.availableBytes = 7;
    await synchronize(engine);
    expect(cloud.paths()).toEqual(vault.paths());
  });
  it("preserves a whole directory tree when both sides rename it differently", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.mkdir("folder"); vault.putFile("folder/note.md", "base");
    cloud.mkdir("/Obsidian/folder"); await cloud.putFile("/Obsidian/folder/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getAbstractFileByPath("folder")!, "local-folder");
    engine.recordRename("folder", "local-folder");
    vault.putFile("local-folder/new.md", "new local child");
    cloud.rename("/Obsidian/folder", "/Obsidian/remote-folder");
    await synchronize(engine);
    const conflict = vault.paths().find(p => p.startsWith("local-folder (conflict-") && !p.includes("/"))!;
    expect(conflict).toBeDefined();
    expect(vault.text(`${conflict}/note.md`)).toBe("base");
    expect(vault.text(`${conflict}/new.md`)).toBe("new local child");
    expect(vault.text("remote-folder/note.md")).toBe("base");
    expect(cloud.paths()).toEqual(vault.paths());
    await synchronize(engine);
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
  });

  it("recovers after shutdown between protecting the local file and recording its conflict", async () => {
    const { vault, cloud, engine, db, settings } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md");
    engine.recordRename("note.md", "local.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/remote.md");
    vault.afterRename = (_source, destination) => {
      if (destination.includes("(conflict-")) { vault.afterRename = undefined; throw new Error("simulated shutdown"); }
    };
    await expect(synchronize(engine)).rejects.toThrow("simulated shutdown");
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const reopened = new SyncDatabase(new SQL.Database(db.export()));
    reopened.recoverInterruptedTasks(); reopened.makeRetryTasksRunnable();
    const restarted = new SyncEngine(vault as never, reopened, cloud.api as never, cloud.uploader as never,
      cloud.downloader as never, () => settings, "42:vault", () => undefined);
    await synchronize(restarted);
    expect(vault.paths().filter(p => p.includes("(conflict-"))).toHaveLength(1);
    expect(reopened.listUnresolvedConflicts()).toHaveLength(1);
    expect(vault.text("remote.md")).toBe("base");
    expect(cloud.paths()).toEqual(vault.paths());
    await synchronize(restarted);
    expect(reopened.listUnresolvedConflicts()).toHaveLength(1);
  });

  it("refreshes once when the remote source changes after indexing", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md");
    engine.recordRename("note.md", "local.md");
    cloud.beforeRename = () => { cloud.beforeRename = undefined; cloud.rename("/Obsidian/note.md", "/Obsidian/remote.md"); };
    await synchronize(engine);
    expect(vault.text("remote.md")).toBe("base");
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
    expect(cloud.calls.filter(c => c === "File.rename")).toHaveLength(1);
  });

  it("does not swallow permission errors or rename a replacement object", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); const nid = await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md"); engine.recordRename("note.md", "local.md");
    cloud.renameError = "permission denied";
    await expect(synchronize(engine)).rejects.toThrow("permission denied");
    expect(cloud.entries.get("/Obsidian/note.md")?.nid).toBe(nid);
    cloud.renameError = undefined;
    cloud.remove("/Obsidian/note.md"); await cloud.putFile("/Obsidian/note.md", "replacement");
    await expect(synchronize(engine)).rejects.toThrow("云端原路径已被其他对象占用");
    expect(cloud.text("/Obsidian/note.md")).toBe("replacement");
    expect(vault.text("local.md")).toBe("base");
  });

  it("does not overwrite an occupied local destination in a divergent rename", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md"); engine.recordRename("note.md", "local.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/remote.md");
    vault.putFile("remote.md", "unrelated local file");
    await expect(synchronize(engine)).rejects.toThrow("destination already exists");
    expect(vault.text("remote.md")).toBe("unrelated local file");
    expect(vault.text("local.md")).toBe("base");
  });

  it("rejects a file-directory replacement even when both sides choose the same name", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "same.md"); engine.recordRename("note.md", "same.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/same.md");
    vault.delete("same.md"); vault.mkdir("same.md");
    await expect(synchronize(engine)).rejects.toThrow("重命名对象类型冲突");
    expect(vault.getAbstractFileByPath("same.md")).toBeInstanceOf(TFolder);
    expect(cloud.text("/Obsidian/same.md")).toBe("base");
  });

  it("keeps known identity when a content upload does not return nid", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base"); const nid = await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    cloud.omitUploadNid = true;
    vault.putFile("note.md", "edit"); await synchronize(engine);
    expect(db.getBase("note.md")?.nid).toBe(nid);
  });

  it("still compares content after equal rename targets", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "same.md"); engine.recordRename("note.md", "same.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/same.md");
    vault.putFile("same.md", "local edit"); await cloud.putFile("/Obsidian/same.md", "remote edit");
    await synchronize(engine);
    const conflict = vault.paths().find(p => p.includes("(conflict-"))!;
    expect(vault.text(conflict)).toBe("local edit");
    expect(vault.text("same.md")).toBe("remote edit");
  });

  it("preserves identity on a local move and resolves a divergent remote move", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base"); const nid = await cloud.putFile("/Obsidian/note.md", "base");
    vault.mkdir("local"); cloud.mkdir("/Obsidian/remote");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local/note.md"); engine.recordRename("note.md", "local/note.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/remote/note.md");
    await synchronize(engine);
    expect(cloud.entries.get("/Obsidian/remote/note.md")?.nid).toBe(nid);
    expect(vault.text("remote/note.md")).toBe("base");
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
  });

  it("preserves identity when consecutive renames also change directory and basename", async () => {
    const { vault, cloud, engine } = await harness();
    vault.mkdir("folder"); vault.putFile("note.md", "base");
    const nid = await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "middle.md"); engine.recordRename("note.md", "middle.md");
    await vault.rename(vault.getFileByPath("middle.md")!, "folder/final.md"); engine.recordRename("middle.md", "folder/final.md");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["folder", "folder/final.md"]);
    expect(cloud.entries.get("/Obsidian/folder/final.md")?.nid).toBe(nid);
  });

  it("retries only the rename step after a partially completed move", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.mkdir("folder"); vault.putFile("note.md", "base");
    const nid = await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "folder/final.md"); engine.recordRename("note.md", "folder/final.md");
    cloud.renameError = "permission denied";
    await expect(synchronize(engine)).rejects.toThrow("permission denied");
    expect(cloud.entries.get("/Obsidian/folder/note.md")?.nid).toBe(nid);
    cloud.renameError = undefined;
    expect(engine.retryTask(db.listFailedTasks()[0]!.id)).toBe(true);
    await synchronize(engine);
    expect(cloud.entries.get("/Obsidian/folder/final.md")?.nid).toBe(nid);
    expect(db.listUnresolvedConflicts()).toEqual([]);
    expect(cloud.calls.filter(c => c === "File.move")).toHaveLength(1);
  });

  it("backfills missing upload identity only at its known original path", async () => {
    const { vault, cloud, engine, db } = await harness();
    cloud.omitUploadNid = true; vault.putFile("note.md", "base");
    await synchronize(engine);
    const nid = cloud.entries.get("/Obsidian/note.md")?.nid;
    expect(db.getBase("note.md")?.nid).toBeUndefined();
    await vault.rename(vault.getFileByPath("note.md")!, "renamed.md"); engine.recordRename("note.md", "renamed.md");
    await synchronize(engine);
    expect(cloud.entries.get("/Obsidian/renamed.md")?.nid).toBe(nid);
  });

  it("does not retry indefinitely when a source error cannot be reconciled", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base"); await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md"); engine.recordRename("note.md", "local.md");
    cloud.renameError = "源文件不存在";
    await expect(synchronize(engine)).rejects.toThrow("源文件不存在");
    expect(cloud.calls.filter(c => c === "File.rename")).toHaveLength(1);
    expect(vault.text("local.md")).toBe("base");
  });

  it.each(["queued", "retry", "failed"])("uses the remote name and preserves local content for a %s divergent rename", async (state) => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "local.md");
    engine.recordRename("note.md", "local.md");
    if (state !== "queued") db.failTask(db.listPendingTasks().find(task => task.kind === "rename")!.id,
      "源文件不存在", state === "retry" ? Date.now() + 60_000 : undefined);
    vault.putFile("local.md", "local edit");
    cloud.rename("/Obsidian/note.md", "/Obsidian/middle.md");
    cloud.rename("/Obsidian/middle.md", "/Obsidian/remote.md");
    await cloud.putFile("/Obsidian/remote.md", "remote edit");

    await synchronize(engine);
    const conflict = vault.paths().find((path) => path.startsWith("local (conflict-"));
    expect(conflict).toBeDefined();
    expect(vault.text(conflict!)).toBe("local edit");
    expect(vault.text("remote.md")).toBe("remote edit");
    expect(cloud.paths()).toEqual([conflict, "remote.md"].sort());
    expect(db.listFailedTasks()).toEqual([]);
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
    await synchronize(engine);
    expect(vault.paths()).toEqual([conflict, "remote.md"].sort());
    expect(db.listUnresolvedConflicts()).toHaveLength(1);
  });

  it("converges equal rename targets without creating a conflict", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "same.md");
    engine.recordRename("note.md", "same.md");
    cloud.rename("/Obsidian/note.md", "/Obsidian/same.md");
    await synchronize(engine);
    expect(vault.paths()).toEqual(["same.md"]);
    expect(cloud.paths()).toEqual(["same.md"]);
    expect(db.listUnresolvedConflicts()).toEqual([]);
  });

  it("keeps the original identity through consecutive local renames", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base");
    const nid = await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await vault.rename(vault.getFileByPath("note.md")!, "middle.md");
    engine.recordRename("note.md", "middle.md");
    await vault.rename(vault.getFileByPath("middle.md")!, "final.md");
    engine.recordRename("middle.md", "final.md");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["final.md"]);
    expect(cloud.entries.get("/Obsidian/final.md")?.nid).toBe(nid);
  });

  it.each(["queued", "retry", "failed"])("retires legacy %s rename intent without guessing remote identity", async (state) => {
    const { vault, cloud, engine, db, statuses } = await harness();
    await synchronize(engine);
    vault.putFile("local.md", "same bytes");
    vault.putFile("other.md", "other");
    await cloud.putFile("/Obsidian/remote.md", "same bytes");
    db.putBase("old.md", {kind:"file", size:10, mtime:0, hash:"old"});
    db.enqueue({id:"legacy",kind:"rename",path:"old.md",payload:{destination:"local.md"},nextRunAt:0});
    if (state !== "queued") db.failTask("legacy", "源文件不存在", state === "retry" ? Date.now() + 60_000 : undefined);
    db.saveTransferSession("legacy", {tid:"old",endpoint:"https://store",ticket:"old",fileHash:"old"});
    db.completeTransferBlock("legacy", 1);
    await synchronize(engine);
    expect(vault.paths()).toEqual(["local.md", "other.md", "remote.md"]);
    expect(cloud.paths()).toEqual(vault.paths());
    expect(db.listFailedTasks()).toEqual([]);
    expect(db.listUnresolvedConflicts()).toEqual([]);
    expect(db.getTransferSession("legacy")).toBeUndefined();
    expect(db.completedTransferBlocks("legacy")).toEqual(new Set());
    expect(statuses.some(s => s.warnings?.includes("旧改名任务已失效，无法确认云端对应文件，已保留两端文件并重新比较。"))).toBe(true);
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const reopened = new SyncDatabase(new SQL.Database(db.export()));
    expect(reopened.listPendingTasks().some(task => task.id === "legacy")).toBe(false);
    await synchronize(engine);
    expect(statuses.at(-1)?.warnings).toEqual([]);
  });

  it("clears a source-missing rename record so the next sync can compare and upload other files", async () => {
    const { vault, cloud, engine, db, statuses } = await harness();
    await synchronize(engine);
    db.enqueue({ id: "old-rename", kind: "rename", path: "missing.canvas", payload: { destination: "renamed.canvas" }, nextRunAt: 0 });
    db.failTask("old-rename", "源文件不存在");
    vault.putFile("new.md", "new note");

    expect(engine.removeFailedTask("old-rename")).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ phase: "idle", failed: 0,
      message: "失败记录已清除，可重新同步", lastError: undefined, failedTasks: [] });
    expect(cloud.paths()).toEqual([]);
    expect(vault.text("new.md")).toBe("new note");
    await synchronize(engine);
    expect(cloud.text("/Obsidian/new.md")).toBe("new note");
    expect(statuses.at(-1)?.phase).toBe("idle");
  });

  it("refuses failure deletion during synchronization", async () => {
    const { vault, engine, db } = await harness();
    vault.putFile("note.md", "note");
    vault.putFile("failed.md", "keep source present");
    db.enqueue({ id: "bad", kind: "upload", path: "failed.md", payload: {}, nextRunAt: 0 });
    db.failTask("bad", "network");
    const syncing = engine.synchronize(false, async () => {
      expect(engine.removeFailedTask("bad")).toBe(false);
      expect(db.listFailedTasks().some((task) => task.id === "bad")).toBe(true);
      return undefined;
    });
    await syncing;
    expect(engine.removeFailedTask("bad")).toBe(true);
  });

  it("keeps other failure details after deleting only one failed task", async () => {
    const { engine, db, statuses } = await harness();
    for (const id of ["one", "two"]) {
      db.enqueue({ id, kind: "upload", path: `${id}.md`, payload: {}, nextRunAt: 0 });
      db.failTask(id, "network");
    }
    engine.removeFailedTask("one");
    expect(statuses.at(-1)).toMatchObject({ phase: "error", failed: 1, message: "部分文件同步失败" });
    expect(statuses.at(-1)?.failedTasks?.map((task) => task.id)).toEqual(["two"]);
  });

  it("propagates local create, update, rename, delete, and nested folders without extras", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "one");
    vault.mkdir("foldera");
    vault.putFile("foldera/filea", "nested");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["foldera", "foldera/filea", "note.md"]);
    expect(cloud.text("/Obsidian/note.md")).toBe("one");

    vault.putFile("note.md", "two");
    await synchronize(engine);
    expect(cloud.text("/Obsidian/note.md")).toBe("two");

    const file = vault.getFileByPath("note.md")!;
    await vault.rename(file, "renamed.md");
    engine.recordRename("note.md", "renamed.md");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["foldera", "foldera/filea", "renamed.md"]);

    vault.delete("renamed.md");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["foldera", "foldera/filea"]);
  });

  it("drops a stale failed upload after the local source disappears", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("gone.md", "one");
    await synchronize(engine);
    expect(cloud.paths()).toEqual(["gone.md"]);

    db.enqueue({ id: "stale-upload", kind: "upload", path: "gone.md", payload: {}, nextRunAt: 0 });
    db.failTask("stale-upload", "previous upload failed", undefined);
    vault.delete("gone.md");

    await synchronize(engine);

    expect(cloud.paths()).toEqual([]);
    expect(db.listPendingTasks().map((task) => task.id)).not.toContain("stale-upload");
    expect(db.taskCounts()).toEqual({ queued: 0, failed: 0 });
  });

  it("propagates remote create, update, rename, delete, and nested folders without extras", async () => {
    const { vault, cloud, engine } = await harness();
    await cloud.putFile("/Obsidian/note.md", "one");
    cloud.mkdir("/Obsidian/foldera");
    await cloud.putFile("/Obsidian/foldera/filea", "nested");
    await synchronize(engine);
    expect(vault.paths()).toEqual(["foldera", "foldera/filea", "note.md"]);
    expect(vault.text("note.md")).toBe("one");

    await cloud.putFile("/Obsidian/note.md", "two");
    await synchronize(engine);
    expect(vault.text("note.md")).toBe("two");

    cloud.rename("/Obsidian/note.md", "/Obsidian/renamed.md");
    await synchronize(engine);
    expect(vault.paths()).toEqual(["foldera", "foldera/filea", "renamed.md"]);

    cloud.remove("/Obsidian/renamed.md");
    await synchronize(engine);
    expect(vault.paths()).toEqual(["foldera", "foldera/filea"]);
  });

  it("does not inspect or change either side while synchronization is paused", async () => {
    const { vault, cloud, engine, settings } = await harness(true);
    vault.putFile("local.md", "local");
    await cloud.putFile("/Obsidian/remote.md", "remote");

    await expect(engine.synchronize()).resolves.toBe(false);
    expect(vault.paths()).toEqual(["local.md"]);
    expect(cloud.paths()).toEqual(["remote.md"]);

    settings.paused = false;
    await synchronize(engine);
    expect(vault.paths()).toEqual(["local.md", "remote.md"]);
    expect(cloud.paths()).toEqual(["local.md", "remote.md"]);
  });

  it("reports invalid local names while continuing valid files", async () => {
    const { vault, cloud, engine, statuses } = await harness();
    vault.putFile("😀.md", "invalid");
    vault.putFile("bad:name.md", "invalid");
    vault.putFile("valid.md", "valid");

    await expect(synchronize(engine)).resolves.toBeUndefined();
    expect(cloud.paths()).toEqual(["valid.md"]);
    const status = statuses.at(-1)!;
    expect(status.failed).toBe(2);
    expect(status.fileFailures?.map((failure) => failure.path).sort()).toEqual(["bad:name.md", "😀.md"]);
    expect(status.fileFailures?.map((failure) => failure.error.characters)).toEqual([["😀"], [":"]]);
  });

  it("shows all invalid characters for one local file", async () => {
    const { vault, cloud, engine, statuses } = await harness();
    vault.putFile("bad:name<file>.md", "invalid");

    await expect(synchronize(engine)).resolves.toBeUndefined();
    expect(cloud.paths()).toEqual([]);
    expect(statuses.at(-1)?.fileFailures?.[0]?.error.characters).toEqual([":", "<", ">"]);
  });

  it("preserves the local version and converges after both sides modify a file", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    vault.putFile("note.md", "local");
    await cloud.putFile("/Obsidian/note.md", "remote");

    await synchronize(engine);

    const conflict = vault.paths().find((path) => path.startsWith("note (conflict-"));
    expect(vault.text("note.md")).toBe("remote");
    expect(conflict).toBeDefined();
    expect(vault.text(conflict!)).toBe("local");
    expect(cloud.text(`/Obsidian/${conflict}`)).toBe("local");
    expect(db.listUnresolvedConflicts()).toEqual([expect.objectContaining({ originalPath: "note.md", conflictPath: conflict })]);

    await synchronize(engine);
    expect(vault.paths()).toEqual([conflict, "note.md"].sort());
    expect(cloud.paths()).toEqual([conflict, "note.md"].sort());
    expect(vault.text("note.md")).toBe("remote");
    expect(vault.text(conflict!)).toBe("local");
  });

  it("preserves a local modification when the remote file was deleted", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    vault.putFile("note.md", "local");
    cloud.remove("/Obsidian/note.md");

    await synchronize(engine);

    const conflict = vault.paths().find((path) => path.startsWith("note (conflict-"));
    expect(vault.paths()).toEqual([conflict]);
    expect(vault.text(conflict!)).toBe("local");
    expect(cloud.paths()).toEqual([conflict]);

    await synchronize(engine);
    expect(vault.paths()).toEqual([conflict]);
    expect(cloud.paths()).toEqual([conflict]);
  });

  it("preserves a local modification when the same remote nid is renamed", async () => {
    const { vault, cloud, engine } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    vault.putFile("note.md", "local");
    cloud.rename("/Obsidian/note.md", "/Obsidian/renamed.md");

    await synchronize(engine);

    const conflict = vault.paths().find((path) => path.startsWith("note (conflict-"));
    expect(vault.text("renamed.md")).toBe("base");
    expect(vault.text(conflict!)).toBe("local");
    expect(cloud.paths().sort()).toEqual([conflict, "renamed.md"].sort());

    await synchronize(engine);
    expect(vault.paths()).toEqual([conflict, "renamed.md"].sort());
    expect(cloud.paths()).toEqual([conflict, "renamed.md"].sort());
  });

  it("restores the original local file when download replacement fails", async () => {
    const { vault, cloud, engine, db } = await harness();
    vault.putFile("note.md", "base");
    await cloud.putFile("/Obsidian/note.md", "base");
    await synchronize(engine);
    await cloud.putFile("/Obsidian/note.md", "remote");
    vault.failAtomicReplacement = true;

    await expect(synchronize(engine)).rejects.toThrow(/sync task.*still queued|sync task.*failed/i);

    expect(vault.text("note.md")).toBe("base");
    expect(vault.paths()).toEqual(["note.md"]);
    expect(db.listFailedTasks()).toEqual([expect.objectContaining({ kind: "download", path: "note.md" })]);
  });

  it("uploads at most five local files concurrently through the sync engine", async () => {
    const { vault, cloud, engine } = await harness();
    cloud.uploadDelayMs = 5;
    for (let index = 0; index < 12; index++) vault.putFile(`${index}.md`, String(index));

    await synchronize(engine);

    expect(cloud.peakUploads).toBe(5);
    expect(cloud.paths()).toHaveLength(12);
  });

  it("continues uploading later files when one upload fails", async () => {
    const { vault, cloud, engine, db, statuses } = await harness();
    cloud.uploadDelayMs = 2;
    cloud.failUploadPath = "/Obsidian/4.md";
    for (let index = 0; index < 9; index++) vault.putFile(`${index}.md`, String(index));

    await expect(synchronize(engine)).rejects.toThrow(/sync task.*still queued/i);

    expect(cloud.paths()).toEqual(["0.md", "1.md", "2.md", "3.md", "5.md", "6.md", "7.md", "8.md"]);
    expect(db.listFailedTasks()).toEqual([expect.objectContaining({ kind: "upload", path: "4.md", state: "retry" })]);
    expect(statuses.at(-1)?.failed).toBe(1);
  });
});
