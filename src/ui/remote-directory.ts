export interface RemoteDirectory { nid: string; name: string }
export interface RemoteDirectoryPage { directories: RemoteDirectory[]; hasNext: boolean }

export interface RemoteDirectoryResponseSummary {
  responseType: string;
  levels: Array<{ depth: number; keys: string[] }>;
  nodeContainerKey?: string;
  nodeContainerType?: string;
  nodeCount: number;
  nodeKeys: string[];
  nodeTypeCounts: Record<string, number>;
  acceptedDirectoryCount: number;
}
export type RemoteDirectoryPageObserver = (page: number, summary: RemoteDirectoryResponseSummary) => void;

type DirectoryApiCall = <T>(
  method: "File.getList",
  input: Record<string, string | number | boolean | null | undefined>,
) => Promise<T>;

interface RawDirectory {
  nid?: unknown;
  name?: unknown;
  fname?: unknown;
  type?: unknown;
  is_dir?: unknown;
}

function directoryDisplayName(value: unknown): string | undefined {
  const raw = String(value ?? "");
  if (!raw || /[\\\x00-\x1f]/.test(raw)) return undefined;
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) return undefined;
  return parts.at(-1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseResponseValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

export function summarizeRemoteDirectoryResponse(value: unknown): RemoteDirectoryResponseSummary {
  const parsedValue = parseResponseValue(value);
  const levels: Array<{ depth: number; keys: string[] }> = [];
  let payload = asRecord(parsedValue);
  let depth = 0;
  while (payload && depth < 3) {
    levels.push({ depth, keys: Object.keys(payload).sort() });
    const nested = asRecord(payload.data);
    if (!nested) break;
    payload = nested;
    depth++;
  }
  const root = asRecord(parsedValue) ?? {};
  const firstPayload = asRecord(root.data) ?? root;
  const normalizedPayload = asRecord(firstPayload.data) ?? firstPayload;
  const containerKey = ["node_list", "list", "nodes"].find((key) => key in normalizedPayload);
  const rawNodes = containerKey ? normalizedPayload[containerKey] : undefined;
  const nodes = Array.isArray(rawNodes)
    ? rawNodes
    : rawNodes && typeof rawNodes === "object" ? Object.values(rawNodes) : [];
  const nodeKeys = new Set<string>();
  const nodeTypeCounts: Record<string, number> = {};
  let acceptedDirectoryCount = 0;
  for (const item of nodes.slice(0, 200)) {
    const node = asRecord(item);
    if (!node) continue;
    for (const key of Object.keys(node)) nodeKeys.add(key);
    const type = String(node.type ?? "");
    nodeTypeCounts[type] = (nodeTypeCounts[type] ?? 0) + 1;
    if (Number(node.type) === 1 && Boolean(node.nid) && Boolean(directoryDisplayName(node.name ?? node.fname))) {
      acceptedDirectoryCount++;
    }
  }
  return {
    responseType: Array.isArray(parsedValue) ? "array" : typeof parsedValue,
    levels,
    nodeContainerKey: containerKey,
    nodeContainerType: Array.isArray(rawNodes) ? "array" : rawNodes && typeof rawNodes === "object" ? "object" : rawNodes === undefined ? "missing" : typeof rawNodes,
    nodeCount: nodes.length,
    nodeKeys: [...nodeKeys].sort(),
    nodeTypeCounts,
    acceptedDirectoryCount,
  };
}

export function parseRemoteDirectoryPage(value: unknown): RemoteDirectoryPage {
  const parsedValue = parseResponseValue(value);
  const page = parsedValue && typeof parsedValue === "object" ? parsedValue as Record<string, unknown> : {};
  const firstPayload = page.data && typeof page.data === "object" ? page.data as Record<string, unknown> : page;
  const payload = firstPayload.data && typeof firstPayload.data === "object"
    ? firstPayload.data as Record<string, unknown>
    : firstPayload;
  const rawNodes = payload.node_list ?? payload.list ?? payload.nodes;
  const nodes = Array.isArray(rawNodes)
    ? rawNodes
    : rawNodes && typeof rawNodes === "object" ? Object.values(rawNodes) : [];
  const directories: RemoteDirectory[] = [];
  for (const item of nodes) {
    if (!item || typeof item !== "object") continue;
    const node = item as RawDirectory;
    const isDirectory = Number(node.type) === 1;
    const nid = String(node.nid ?? "");
    const name = directoryDisplayName(node.name ?? node.fname);
    if (!isDirectory || !nid || !name) continue;
    directories.push({ nid, name });
  }
  const hasNextValue = payload.has_next_page ?? payload.hasNextPage ?? payload.has_next;
  return { directories, hasNext: hasNextValue === true || String(hasNextValue ?? "") === "1" || String(hasNextValue ?? "").toLowerCase() === "true" };
}

export async function loadRemoteDirectories(call: DirectoryApiCall, path: string,
  observePage?: RemoteDirectoryPageObserver): Promise<RemoteDirectory[]> {
  const directories: RemoteDirectory[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await call<unknown>("File.getList", {
      page,
      page_size: 200,
      path,
      nodetype: "dir",
    });
    observePage?.(page, summarizeRemoteDirectoryResponse(response));
    const parsed = parseRemoteDirectoryPage(response);
    directories.push(...parsed.directories);
    if (!parsed.hasNext) break;
  }
  return directories.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}
