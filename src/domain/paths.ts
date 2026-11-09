import type { FilterRule } from "../settings.js";

const TEMP_FILE_PATTERNS = [
  /(?:^|\/)Thumbs\.db$/i,
  /(?:^|\/)desktop\.ini$/i,
  /(?:^|\/)~\$/,
  /(?:\.tmp|\.temp|\.part|\.crdownload|\.swp|\.swo|~)$/i,
];

export type WindowsPathIssue = "invalid-character" | "emoji" | "reserved-name" | "trailing-space-or-dot" | "segment-too-long";

export class WindowsPathError extends Error {
  constructor(readonly issue: WindowsPathIssue, readonly segment: string, message: string, readonly characters: readonly string[] = []) {
    super(message);
    this.name = "WindowsPathError";
  }
}

const WINDOWS_RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const EMOJI_SEQUENCE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|[0-9#*]\uFE0F?\u20E3)/u;

function normalizePathText(path: string): string {
  return path.normalize("NFC").replaceAll("\\", "/");
}

export function validateWindowsPathSegment(segment: string): void {
  if (segment.length > 255) {
    throw new WindowsPathError("segment-too-long", segment, "Windows 路径段超过 255 个字符");
  }
  if (segment.endsWith(" ") || segment.endsWith(".")) {
    throw new WindowsPathError("trailing-space-or-dot", segment, "Windows 文件名不能以空格或句点结尾");
  }
  if (WINDOWS_RESERVED_NAMES.test(segment)) {
    throw new WindowsPathError("reserved-name", segment, `Windows 不支持保留设备名：${segment}`);
  }
  const invalidCharacters = [...new Set([...segment].filter((character) => /[\\/<>:"|?*\x00-\x1f]/.test(character)))];
  if (invalidCharacters.length > 0) {
    throw new WindowsPathError("invalid-character", segment, "文件名包含 Windows 不支持的字符", invalidCharacters);
  }
  if (EMOJI_SEQUENCE.test(segment)) {
    const emoji = segment.match(/(?:\p{Extended_Pictographic}(?:\uFE0F?\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u)?.[0];
    throw new WindowsPathError("emoji", segment, "文件名不能包含 emoji 表情符号", emoji ? [emoji] : []);
  }
}

export function normalizeVaultPath(path: string): string {
  const normalized = normalizePathText(path).replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("Path escapes the vault root");
    validateWindowsPathSegment(part);
  }
  return parts.join("/");
}

export interface PathFilterOptions {
  syncObsidianConfig?: boolean;
  excludedExtensions?: readonly string[];
  filterRules?: readonly FilterRule[];
  pluginId?: string;
}

export function filterRuleAction(rule: FilterRule): "exclude" | "include" {
  return rule.action === "include" ? "include" : "exclude";
}

export function parseExcludedExtensions(value: string): string[] {
  return [...new Set(value.split(/[\s,;，；]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\*?\.?/, ""))
    .filter(Boolean))];
}

function globRegex(pattern: string, caseSensitive: boolean): RegExp | undefined {
  const normalized = pattern.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return undefined;
  let source = "";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") { index++; source += "(?:.*/)?"; }
        else source += ".*";
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  try { return new RegExp(`^${source}$`, caseSensitive ? "" : "i"); } catch { return undefined; }
}

export function matchesFilterRule(path: string, rule: FilterRule): boolean {
  if (!rule.enabled) return false;
  const expression = globRegex(rule.pattern, rule.caseSensitive);
  if (!expression) return false;
  const parts = path.split("/");
  for (let length = parts.length; length > 0; length--) {
    if (expression.test(parts.slice(0, length).join("/"))) return true;
  }
  return false;
}

export function shouldIgnorePath(path: string, options: PathFilterOptions = {}): boolean {
  let normalized: string;
  try {
    normalized = normalizeVaultPath(path);
  } catch {
    return true;
  }
  if (!normalized) return true;
  const first = (normalized.split("/", 1)[0] || "").toLowerCase();
  if (first === ".yunpan-sync") return true;
  if (first === ".obsidian") {
    if (!options.syncObsidianConfig) return true;
    const pluginId = options.pluginId ?? "yunpan-sync";
    const ownPlugins = [pluginId, "obsidian-yunpan-sync"].map((id) => `.obsidian/plugins/${id}`.toLowerCase());
    const lowerPath = normalized.toLowerCase();
    if (ownPlugins.some((plugin) => lowerPath === plugin || lowerPath.startsWith(`${plugin}/`))) return true;
  }
  const name = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  const excluded = (options.excludedExtensions ?? []).map((item) => item.toLowerCase().replace(/^\*?\.?/, "")).filter(Boolean);
  if (excluded.some((extension) => name.endsWith(`.${extension}`))) return true;
  let matched: "exclude" | "include" | undefined;
  for (const rule of options.filterRules ?? []) {
    if (matchesFilterRule(normalized, rule)) matched = filterRuleAction(rule);
  }
  if (matched === "exclude") return true;
  return TEMP_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function normalizeRemoteRoot(root: string): string {
  const raw = normalizePathText(root);
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 0) throw new Error("Remote root cannot be empty");
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error("Remote root contains an unsafe segment");
    validateWindowsPathSegment(part);
  }
  return `/${parts.join("/")}/`;
}

export function joinRemotePath(root: string, vaultPath: string): string {
  const cleanRoot = normalizeRemoteRoot(root);
  const cleanPath = normalizeVaultPath(vaultPath);
  if (!cleanPath) return cleanRoot;
  return `${cleanRoot}${cleanPath}`;
}

export function remoteToVaultPath(root: string, remotePath: string): string {
  const cleanRoot = normalizeRemoteRoot(root);
  const normalized = `/${normalizePathText(remotePath).replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  const rootKey = cleanRoot.toLocaleLowerCase("en-US");
  if (!normalized.toLocaleLowerCase("en-US").startsWith(rootKey)) throw new Error("Remote path is outside the bound root");
  return normalizeVaultPath(normalized.slice(cleanRoot.length));
}

function sanitizeDeviceName(deviceName: string): string {
  const safe = deviceName.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/\s+/g, "-");
  return safe || "device";
}

export function buildConflictPath(path: string, deviceName: string, at: Date, sequence: number): string {
  const normalized = normalizeVaultPath(path);
  const slash = normalized.lastIndexOf("/");
  const directory = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const name = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  const stamp = [
    at.getUTCFullYear().toString().padStart(4, "0"),
    (at.getUTCMonth() + 1).toString().padStart(2, "0"),
    at.getUTCDate().toString().padStart(2, "0"),
    "-",
    at.getUTCHours().toString().padStart(2, "0"),
    at.getUTCMinutes().toString().padStart(2, "0"),
    at.getUTCSeconds().toString().padStart(2, "0"),
  ].join("");
  const suffix = sequence > 0 ? `-${sequence}` : "";
  return `${directory}${stem} (conflict-${sanitizeDeviceName(deviceName)}-${stamp}${suffix})${extension}`;
}
