import { OpenApiError, type OpenApiMethod } from "../net/openapi-client.js";
import { SyncDatabase, type RemoteNode } from "../storage/database.js";

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

function resolveNodes(raw: RawNode[]): RemoteNode[] {
  const byId = new Map<string, RawNode>();
  for (const node of raw) {
    const nid = String(node.nid ?? "");
    if (!nid || byId.has(nid)) throw new Error("Remote node id is missing or duplicated");
    byId.set(nid, node);
  }
  const resolved = new Map<string, string | undefined>();
  const visiting = new Set<string>();
  const pathFor = (nid: string): string | undefined => {
    if (resolved.has(nid)) return resolved.get(nid);
    if (visiting.has(nid)) throw new Error("Remote node tree contains a cycle");
    const node = byId.get(nid);
    if (!node) throw new Error(`Remote node ${nid} is missing`);
    visiting.add(nid);
    const name = String(node.name ?? node.fname ?? "");
    if (!name || /[\\/\x00-\x1f]/.test(name) || name === "." || name === "..") {
      visiting.delete(nid);
      resolved.set(nid, undefined);
      return undefined;
    }
    const pid = String(node.pid ?? "0");
    if (pid !== "0" && pid !== "" && !byId.has(pid)) throw new Error(`Remote node ${nid} has a missing parent ${pid}`);
    const parent = pid === "0" || pid === "" ? "" : pathFor(pid);
    if (parent === undefined) {
      visiting.delete(nid);
      resolved.set(nid, undefined);
      return undefined;
    }
    const path = `${parent}/${name}`.replace(/\/{2,}/g, "/");
    visiting.delete(nid);
    resolved.set(nid, path);
    return path;
  };
  const result = raw.flatMap((node) => {
    const path = pathFor(String(node.nid));
    if (path === undefined) return [];
    return [{
      nid: String(node.nid), pid: String(node.pid ?? "0"), path,
      name: String(node.name ?? node.fname), isDir: node.is_dir === true || Number(node.is_dir ?? node.type) === 1,
      version: finiteNumber(node.version ?? node.ver ?? node.nv), hash: node.fhash ?? node.hash ?? node.file_hash,
      size: node.is_dir === true || Number(node.is_dir ?? node.type) === 1 ? 0 : fileSize(node.fsize ?? node.size ?? node.count_size),
      mtime: finiteNumber(node.fmtime ?? node.mtime ?? node.modify_time),
      status: node.status === undefined ? undefined : finiteNumber(node.status),
    }];
  });
  return result;
}

function deleteNodeTree(nodes: Map<string, RawNode>, nid: string): void {
  const removed = new Set([nid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [candidateId, candidate] of nodes) {
      if (removed.has(String(candidate.pid ?? "")) && !removed.has(candidateId)) {
        removed.add(candidateId);
        changed = true;
      }
    }
  }
  for (const id of removed) nodes.delete(id);
}

function isDeletedNode(node: RawNode): boolean {
  if (node.status === undefined) return false;
  const status = Number(node.status);
  return Number.isFinite(status) && status !== 0;
}

function nodeVersion(node: RawNode): number {
  return finiteNumber(node.version ?? node.ver ?? node.nv);
}

function applyNodeChanges(initial: Map<string, RawNode>, changes: RawNode[]): Map<string, RawNode> {
  const nodes = new Map(initial);
  for (const node of changes) {
    const nid = String(node.nid ?? "");
    if (!nid) continue;
    const current = nodes.get(nid);
    if (!current || nodeVersion(node) >= nodeVersion(current)) nodes.set(nid, node);
  }
  for (const [nid, node] of [...nodes]) {
    if (isDeletedNode(node)) deleteNodeTree(nodes, nid);
  }
  return nodes;
}

export class RemoteIndexer {
  constructor(
    private readonly api: RemoteApi,
    private readonly database: SyncDatabase,
    private readonly accountKey: string,
    private readonly pageSize = 500,
  ) {}

  async rebuild(): Promise<void> {
    const start = await this.api.call<PageResponse>("Incr.getBgsp", {});
    const bgsp = String(start.bgsp ?? start.gsp ?? "");
    if (!bgsp) throw new Error("Incr.getBgsp did not return a cursor");
    let gsp = String(start.gsp ?? bgsp);
    let spnid = "";
    const raw: RawNode[] = [];
    const total = Number(start.total ?? Number.POSITIVE_INFINITY);
    do {
      const page = await this.api.call<PageResponse>("Incr.getGlobalNodes", { bgsp, gsp, count: this.pageSize, spnid });
      const nodes = rawNodes(page);
      raw.push(...nodes);
      gsp = String(page.gsp ?? gsp);
      spnid = String(page.spnid ?? nodes.at(-1)?.nid ?? "");
      if (raw.length >= total) break;
      if (!more(page, nodes.length, this.pageSize)) break;
    } while (true);

    const catchup = await this.fetchIncrementPages(gsp);
    gsp = catchup.gsp;
    const merged = applyNodeChanges(new Map(), raw);
    const current = applyNodeChanges(merged, catchup.nodes);
    const nodes = resolveNodes([...current.values()]);
    const remoteVersion = Number(catchup.version ?? start.version ?? start.ver ?? start.uv ?? 0);
    this.database.transaction(() => {
      this.database.replaceRemoteSnapshot(nodes);
      this.database.setCursor({ accountKey: this.accountKey, bgsp, gsp, remoteVersion, snapshotComplete: true });
    });
  }

  async update(): Promise<void> {
    const cursor = this.database.getCursor(this.accountKey);
    if (!cursor?.snapshotComplete || !cursor.gsp) return this.rebuild();
    try {
      this.database.purgeDeletedRemoteNodes();
      const version = await this.api.call<{ ver?: string | number }>("User.getVersion", { type: 0 });
      if (Number(version.ver ?? 0) <= cursor.remoteVersion) return;
      const change = await this.fetchIncrementPages(cursor.gsp);
      const current = new Map(this.database.getRemoteNodes().map((node) => [node.nid, node]));
      const rawCurrent: RawNode[] = [...current.values()].map((node) => ({ ...node, is_dir: node.isDir ? 1 : 0,
        fhash: node.hash, fsize: node.size, fmtime: node.mtime, nv: node.version }));
      const resolved = resolveNodes([...applyNodeChanges(new Map(rawCurrent.map((node) => [String(node.nid), node])), change.nodes).values()]);
      this.database.transaction(() => {
        this.database.replaceRemoteSnapshot(resolved);
        this.database.setCursor({ ...cursor, gsp: change.gsp, remoteVersion: Number(change.version ?? cursor.remoteVersion) });
      });
    } catch (error) {
      if (!(error instanceof OpenApiError) || error.errno !== 3203) throw error;
      this.database.clearRemoteIndex(this.accountKey);
      await this.rebuild();
    }
  }

  private async fetchIncrementPages(initialGsp: string): Promise<{ nodes: RawNode[]; gsp: string; version?: string | number }> {
    let gsp = initialGsp;
    let spnid = "";
    let version: string | number | undefined;
    const result: RawNode[] = [];
    do {
      const page = await this.api.call<PageResponse>("Incr.getIncrGlobal", { gsp, count: this.pageSize, spnid, uv: version ?? "" });
      const nodes = rawNodes(page);
      result.push(...nodes);
      gsp = String(page.gsp ?? gsp);
      version = page.version ?? page.ver ?? page.uv ?? version;
      spnid = String(page.spnid ?? nodes.at(-1)?.nid ?? "");
      if (!more(page, nodes.length, this.pageSize)) break;
    } while (true);
    return { nodes: result, gsp, version };
  }
}
