import { OpenApiError, type OpenApiMethod } from "../net/openapi-client.js";
import { SyncDatabase, type RemoteNode } from "../storage/database.js";
import { WorkScheduler } from "./work-scheduler.js";
import { normalizeRemoteRoot } from "../domain/paths.js";

// Use the existing cursor columns to distinguish scoped snapshots from legacy
// global cursors. Migration replaces only the index, never tasks or baselines.
export function directorySnapshotScope(root: string): string { return `directory-v1:${normalizeRemoteRoot(root)}`; }

interface RemoteApi {
  call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T>;
}

interface RawNode {
  nid?: string | number;
  pid?: string | number;
  name?: string;
  fname?: string;
  is_dir?: string | number | boolean;
  type?: string | number;
  fhash?: string;
  hash?: string;
  file_hash?: string;
  fsize?: string | number;
  size?: string | number;
  count_size?: string | number;
  fmtime?: string | number;
  mtime?: string | number;
  modify_time?: string | number;
  version?: string | number;
  ver?: string | number;
  nv?: string | number;
  status?: string | number;
}

interface PageResponse {
  nodes?: RawNode[];
  node_list?: RawNode[];
  list?: RawNode[];
  gsp?: string | number;
  bgsp?: string | number;
  version?: string | number;
  uv?: string | number;
  ver?: string | number;
  retnum?: string | number;
  total?: string | number;
  has_more?: string | number | boolean;
  spnid?: string | number;
}

function rawNodes(page: PageResponse): RawNode[] {
  const value = page.nodes ?? page.node_list ?? page.list ?? [];
  if (!Array.isArray(value)) throw new Error("Remote node page is invalid");
  return value;
}

function more(page: PageResponse, count: number, pageSize: number): boolean {
  if (page.has_more !== undefined) return page.has_more === true || Number(page.has_more) === 1;
  return Number(page.retnum ?? count) >= pageSize;
}

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
}

// Keep unknown file sizes distinct from real empty files in the persisted index.
// Quota preflight rejects this sentinel when an overwrite needs the old size.
function fileSize(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "") return -1;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : -1;
}

function directoryPage(value: unknown): { nodes: RawNode[]; hasNext: boolean; total?: number } {
  let payload = value;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload) as unknown; } catch { throw new Error("云端目录响应无效，保留上次索引"); }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) break;
    const record = payload as Record<string, unknown>;
    if ("node_list" in record || "nodes" in record || "list" in record) {
      const container = record.node_list ?? record.nodes ?? record.list;
      if (!container || typeof container !== "object") break;
      const nodes = Array.isArray(container) ? container : Object.values(container);
      if (nodes.some(node => !node || typeof node !== "object" || Array.isArray(node))) break;
      const next = record.has_next_page ?? record.hasNextPage ?? record.has_next;
      const total = record.total === undefined ? undefined : Number(record.total);
      if (total !== undefined && (!Number.isSafeInteger(total) || total < 0)) break;
      if (next !== undefined && ![true, false, 1, 0, "1", "0", "true", "false"].includes(next as string)) break;
      // Missing pagination metadata must never turn a partial directory into deletions.
      if (next === undefined && total === undefined) break;
      return { nodes: nodes as RawNode[], hasNext: next === true || next === 1 || next === "1" || next === "true", total };
    }
    payload = record.data;
  }
  throw new Error("云端目录响应不完整，保留上次索引并停止同步");
}

async function resolveNodes(raw: RawNode[], work: WorkScheduler): Promise<RemoteNode[]> {
  const byId = new Map<string, RawNode>();
  for (const node of raw) {
    const nid = String(node.nid ?? "");
    if (!nid || byId.has(nid)) throw new Error("Remote node id is missing or duplicated");
    byId.set(nid, node);
    await work.step();
  }
  const resolved = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  const pathFor = async (nid: string): Promise<string | undefined> => {
    if (resolved.has(nid)) return resolved.get(nid);
    if (visiting.has(nid)) throw new Error("Remote node tree contains a cycle");
    const node = byId.get(nid);
    if (!node) throw new Error(`Remote node ${nid} is missing`);
    visiting.add(nid);
    const name = String(node.name ?? node.fname ?? "");
    // Retain invalid names and their stable identities. The engine reports and
    // protects them instead of interpreting absent index entries as deletion.
    const pid = String(node.pid ?? "0");
    if (pid !== "0" && pid !== "" && !byId.has(pid)) throw new Error(`Remote node ${nid} has a missing parent ${pid}`);
    await work.step();
    const parent = pid === "0" || pid === "" ? "" : await pathFor(pid);
    if (parent === undefined) {
      visiting.delete(nid);
      resolved.set(nid, undefined);
      return undefined;
    }
    const path = `${parent}/${name}`;
    visiting.delete(nid);
    resolved.set(nid, path);
    return path;
  };
  const result: RemoteNode[] = [];
  for (const node of raw) {
    await work.step();
    const path = await pathFor(String(node.nid));
    if (path === undefined) continue;
    result.push({
      nid: String(node.nid), pid: String(node.pid ?? "0"), path,
      name: String(node.name ?? node.fname), isDir: node.is_dir === true || Number(node.is_dir ?? node.type) === 1,
      version: finiteNumber(node.version ?? node.ver ?? node.nv), hash: node.fhash ?? node.hash ?? node.file_hash,
      size: node.is_dir === true || Number(node.is_dir ?? node.type) === 1 ? 0 : fileSize(node.fsize ?? node.size ?? node.count_size),
      mtime: finiteNumber(node.fmtime ?? node.mtime ?? node.modify_time),
      status: node.status === undefined ? undefined : finiteNumber(node.status),
    });
  }
  return result;
}

function isDeletedNode(node: RawNode): boolean {
  if (node.status === undefined) return false;
  const status = Number(node.status);
  return Number.isFinite(status) && status !== 0;
}

function nodeVersion(node: RawNode): number {
  return finiteNumber(node.version ?? node.ver ?? node.nv);
}

async function applyNodeChanges(initial: Map<string, RawNode>, changes: RawNode[], work: WorkScheduler): Promise<Map<string, RawNode>> {
  const nodes = new Map(initial);
  for (const node of changes) {
    await work.step();
    const nid = String(node.nid ?? "");
    if (!nid) continue;
    const current = nodes.get(nid);
    if (!current || nodeVersion(node) >= nodeVersion(current)) nodes.set(nid, node);
  }
  const children = new Map<string, string[]>();
  const removed: string[] = [];
  for (const [nid, node] of nodes) {
    await work.step();
    const pid = String(node.pid ?? "");
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid)!.push(nid);
    if (isDeletedNode(node)) removed.push(nid);
  }
  const visited = new Set<string>();
  for (let i = 0; i < removed.length; i++) {
    await work.step();
    const nid = removed[i]!;
    if (visited.has(nid)) continue;
    visited.add(nid);
    nodes.delete(nid);
    for (const child of children.get(nid) ?? []) removed.push(child);
  }
  return nodes;
}

export class RemoteIndexer {
  private readonly work: WorkScheduler;
  private fetched = 0;
  constructor(
    private readonly api: RemoteApi,
    private readonly database: SyncDatabase,
    private readonly accountKey: string,
    private readonly pageSize = 200,
    private readonly options: { check?: () => void; progress?: (stage: string, count: number) => void;
      work?: WorkScheduler; remoteRoot?: string } = {},
  ) { this.work = options.work ?? new WorkScheduler(options.check); }

  private async call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> {
    this.options.check?.();
    this.options.progress?.("remote-request", this.fetched);
    const value = await this.work.waitFor(() => this.api.call<T>(method, input));
    this.options.check?.();
    return value;
  }

  private async publish(nodes: RemoteNode[], cursor: Parameters<SyncDatabase["setCursor"]>[0]): Promise<void> {
    this.options.progress?.("remote-process", this.fetched);
    this.database.beginRemoteSnapshot();
    try {
      for (let i = 0; i < nodes.length; i += 100) {
        this.database.stageRemoteNodes(nodes.slice(i, i + 100));
        await this.work.step(true);
      }
      this.options.check?.();
      this.database.publishRemoteSnapshot(cursor);
    } finally { this.database.discardRemoteSnapshot(); }
  }

  async rebuild(): Promise<void> {
    if (this.options.remoteRoot !== undefined) return this.rebuildDirectory();
    this.fetched = 0;
    const start = await this.call<PageResponse>("Incr.getBgsp", {});
    const bgsp = String(start.bgsp ?? start.gsp ?? "");
    if (!bgsp) throw new Error("Incr.getBgsp did not return a cursor");
    let gsp = String(start.gsp ?? bgsp);
    let spnid = "";
    const raw: RawNode[] = [];
    const total = Number(start.total ?? Number.POSITIVE_INFINITY);
    do {
      const page = await this.call<PageResponse>("Incr.getGlobalNodes", { bgsp, gsp, count: this.pageSize, spnid });
      const nodes = rawNodes(page);
      raw.push(...nodes);
      this.fetched += nodes.length;
      this.options.progress?.("remote-process", this.fetched);
      await this.work.step(true);
      gsp = String(page.gsp ?? gsp);
      spnid = String(page.spnid ?? nodes.at(-1)?.nid ?? "");
      if (raw.length >= total) break;
      if (!more(page, nodes.length, this.pageSize)) break;
    } while (true);

    const catchup = await this.fetchIncrementPages(gsp);
    gsp = catchup.gsp;
    this.options.progress?.("remote-process", this.fetched);
    const merged = await applyNodeChanges(new Map(), raw, this.work);
    const current = await applyNodeChanges(merged, catchup.nodes, this.work);
    const nodes = await resolveNodes([...current.values()], this.work);
    const remoteVersion = Number(catchup.version ?? start.version ?? start.ver ?? start.uv ?? 0);
    await this.publish(nodes, { accountKey: this.accountKey, bgsp, gsp, remoteVersion, snapshotComplete: true });
  }

  async update(): Promise<void> {
    if (this.options.remoteRoot !== undefined) {
      const cursor = this.database.getCursor(this.accountKey);
      const version = await this.directoryVersion();
      if (cursor?.snapshotComplete && cursor.bgsp === directorySnapshotScope(this.options.remoteRoot) &&
        cursor.gsp === `exists:${version}` && !this.database.hasRemoteTombstones()) return;
      return this.rebuildDirectory(version);
    }
    const cursor = this.database.getCursor(this.accountKey);
    if (!cursor?.snapshotComplete || !cursor.gsp) return this.rebuild();
    try {
      const version = await this.call<{ ver?: string | number }>("User.getVersion", { type: 0 });
      const unchanged = Number(version.ver ?? 0) <= cursor.remoteVersion;
      if (unchanged && !this.database.hasRemoteTombstones()) return;
      const change = unchanged ? { nodes: [] as RawNode[], gsp: cursor.gsp, version: cursor.remoteVersion }
        : await this.fetchIncrementPages(cursor.gsp);
      const rawCurrent: RawNode[] = [];
      for await (const batch of this.database.remoteNodeBatches()) {
        for (const node of batch) rawCurrent.push({ ...node, is_dir: node.isDir ? 1 : 0,
          fhash: node.hash, fsize: node.size, fmtime: node.mtime, nv: node.version });
        await this.work.step(true);
      }
      this.options.progress?.("remote-process", this.fetched);
      const merged = await applyNodeChanges(new Map(rawCurrent.map((node) => [String(node.nid), node])), change.nodes, this.work);
      const resolved = await resolveNodes([...merged.values()], this.work);
      await this.publish(resolved, { ...cursor, gsp: change.gsp, remoteVersion: Number(change.version ?? cursor.remoteVersion) });
    } catch (error) {
      if (!(error instanceof OpenApiError) || error.errno !== 3203) throw error;
      await this.rebuild();
    }
  }

  private async directoryVersion(): Promise<string> {
    const response = await this.call<{ ver?: string | number }>("User.getVersion", { type: 0 });
    const version = String(response.ver ?? "");
    if (!/^\d+$/.test(version)) throw new Error("无法确认云端目录版本，请稍后重试");
    return version;
  }

  private async rebuildDirectory(initialVersion?: string): Promise<void> {
    const root = normalizeRemoteRoot(this.options.remoteRoot!);
    let version = initialVersion ?? await this.directoryVersion();
    // Offset pagination needs a stable version. Never publish a mixed snapshot
    // that could mistake an item moving between pages for a deletion.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.fetched = 0;
      const nodes: RemoteNode[] = [];
      const seen = new Set<string>();
      const directories: Array<{ path: string; nid?: string }> = [{ path: root }];
      let rootExists = true;
      for (let index = 0; index < directories.length; index++) {
        const directory = directories[index]!;
        let count = 0;
        let total: number | undefined;
        for (let page = 1; ; page++) {
          let response: unknown;
          try {
            response = await this.call<unknown>("File.getList", {
              path: directory.path, page, page_size: this.pageSize,
              field: "file_name", order: "asc", thumb: 0, download_ext: 0,
            });
          } catch (error) {
            if (index === 0 && page === 1 && error instanceof OpenApiError && error.errno === 3008 &&
              !this.database.hasBases() && !this.database.isBindingConfirmed(this.accountKey)) {
              rootExists = false;
              break;
            }
            throw error;
          }
          const result = directoryPage(response);
          if (total !== undefined && result.total !== total) throw new Error("云端目录在分页期间发生变化，请重试");
          total = result.total;
          for (const raw of result.nodes) {
            await this.work.step();
            const nid = String(raw.nid ?? "");
            let name = String(raw.name ?? raw.fname ?? "");
            const isDir = raw.is_dir === true || Number(raw.is_dir ?? raw.type) === 1;
            // File.getList can return either basenames or absolute cloud paths.
            if (isDir) name = name.replace(/\/$/, "");
            if (name.startsWith("/")) {
              if (!name.toLowerCase().startsWith(directory.path.toLowerCase())) throw new Error("云端目录返回了绑定范围外的路径");
              name = name.slice(directory.path.length);
            }
            if (!nid || seen.has(nid) || !name || name === "." || name === ".." || /[\/\\\x00-\x1f]/.test(name)) {
              throw new Error("云端目录包含重复节点或不安全路径，保留上次索引");
            }
            if (directory.nid && raw.pid !== undefined && String(raw.pid) !== directory.nid) throw new Error("云端目录父节点发生变化，请重试");
            if (raw.is_dir === undefined && raw.type === undefined) throw new Error("云端文件类型缺失，保留上次索引");
            if (isDeletedNode(raw)) throw new Error("云端目录包含已删除节点，请重试");
            seen.add(nid);
            const path = `${directory.path}${name}`;
            nodes.push({ nid, pid: String(raw.pid ?? directory.nid ?? "0"), path, name, isDir,
              version: nodeVersion(raw), hash: raw.fhash ?? raw.hash ?? raw.file_hash,
              size: isDir ? 0 : fileSize(raw.fsize ?? raw.size ?? raw.count_size),
              mtime: finiteNumber(raw.fmtime ?? raw.modify_time ?? raw.mtime), status: 0 });
            if (isDir) directories.push({ path: `${path}/`, nid });
          }
          count += result.nodes.length;
          this.fetched += result.nodes.length;
          this.options.progress?.("remote-process", this.fetched);
          await this.work.step(true);
          if (total !== undefined && (count > total || (!result.hasNext && count < total && result.nodes.length === 0))) {
            throw new Error("云端目录分页不完整，保留上次索引");
          }
          const hasNext = result.hasNext || (total !== undefined && count < total);
          if (!hasNext) break;
          if (result.nodes.length === 0) throw new Error("云端目录分页没有前进，保留上次索引");
        }
      }
      const latestVersion = await this.directoryVersion();
      if (latestVersion !== version) { version = latestVersion; continue; }
      await this.publish(nodes, { accountKey: this.accountKey, bgsp: directorySnapshotScope(root),
        gsp: `${rootExists ? "exists" : "missing"}:${version}`, remoteVersion: Number(version), snapshotComplete: true });
      return;
    }
    throw new Error("云端文件仍在变化，本轮保留上次完整索引，请稍后重试");
  }

  private async fetchIncrementPages(initialGsp: string): Promise<{ nodes: RawNode[]; gsp: string; version?: string | number }> {
    let gsp = initialGsp;
    let spnid = "";
    let version: string | number | undefined;
    const result: RawNode[] = [];
    do {
      const page = await this.call<PageResponse>("Incr.getIncrGlobal", { gsp, count: this.pageSize, spnid, uv: version ?? "" });
      const nodes = rawNodes(page);
      result.push(...nodes);
      this.fetched += nodes.length;
      this.options.progress?.("remote-process", this.fetched);
      await this.work.step(true);
      gsp = String(page.gsp ?? gsp);
      version = page.version ?? page.ver ?? page.uv ?? version;
      spnid = String(page.spnid ?? nodes.at(-1)?.nid ?? "");
      if (!more(page, nodes.length, this.pageSize)) break;
    } while (true);
    return { nodes: result, gsp, version };
  }
}
