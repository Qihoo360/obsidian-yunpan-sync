export type SyncMode = "manual" | "automatic" | "scheduled";
export type Environment = "production";

export interface FilterRule {
  id: string;
  enabled: boolean;
  pattern: string;
  caseSensitive: boolean;
}

export const DEFAULT_FILTER_RULES: readonly FilterRule[] = [
  "**/*.nutstore-sync-*.download",
  "**/__MACOSX",
  "**/.DS_Store",
  "**/.env",
  "**/.nomedia",
  "**/.env.*",
  "**/.git",
  "**/.github",
  "**/.gitlab",
  "**/.idea",
  "**/.svn",
  "**/.trash",
  "**/.vscode",
  "**/.codex",
  "**/.opencode",
  "**/.claude",
].map((pattern, index) => ({ id: `default-${index + 1}`, enabled: true, pattern, caseSensitive: false }));

export interface PluginSettings {
  environment: Environment;
  openapiBaseUrl: string;
  remoteRoot: string;
  mode: SyncMode;
  intervalMinutes: number;
  paused: boolean;
  deviceId: string;
  deviceName: string;
  ownerQid: string;
  syncObsidianConfig: boolean;
  excludedExtensions: string;
  filterRules: FilterRule[];
}

export const DEFAULT_SETTINGS: PluginSettings = {
  environment: "production",
  openapiBaseUrl: "https://openapi.eyun.360.cn/intf.php",
  remoteRoot: "/Obsidian/",
  mode: "manual",
  intervalMinutes: 30,
  paused: false,
  deviceId: "",
  deviceName: "Obsidian",
  ownerQid: "0",
  syncObsidianConfig: false,
  excludedExtensions: "",
  filterRules: DEFAULT_FILTER_RULES.map((rule) => ({ ...rule })),
};

function normalizeFilterRules(value: unknown): FilterRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Partial<FilterRule>;
    const pattern = typeof source.pattern === "string" ? source.pattern.trim() : "";
    if (!pattern || pattern.length > 512) return [];
    const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : `rule-${index + 1}`;
    return [{ id, enabled: source.enabled !== false, pattern,
      caseSensitive: source.caseSensitive === true }];
  });
}

function legacyExtensionRules(value: string): FilterRule[] {
  return [...new Set(value.split(/[\s,;，；]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\*?\.?/, ""))
    .filter(Boolean))]
    .map((extension, index) => ({ id: `legacy-extension-${index + 1}`, enabled: true,
      pattern: `**/*.${extension}`, caseSensitive: false }));
}

export function normalizeSettings(input: Partial<PluginSettings> | null | undefined): PluginSettings {
  const environment = "production" as const;
  const mode: SyncMode = ["manual", "automatic", "scheduled"].includes(input?.mode ?? "")
    ? input!.mode! : "manual";
  const requested = Number(input?.intervalMinutes ?? 30);
  const intervalMinutes = Math.min(1440, Math.max(1, Number.isFinite(requested) ? Math.round(requested) : 30));
  const excludedExtensions = typeof input?.excludedExtensions === "string" ? input.excludedExtensions : "";
  const persistedRules = normalizeFilterRules(input?.filterRules);
  const filterRules = persistedRules ?? [
    ...DEFAULT_FILTER_RULES.map((rule) => ({ ...rule })),
    ...legacyExtensionRules(excludedExtensions),
  ];
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    environment,
    mode,
    intervalMinutes,
    syncObsidianConfig: input?.syncObsidianConfig === true,
    excludedExtensions,
    filterRules,
    openapiBaseUrl: "https://openapi.eyun.360.cn/intf.php",
  };
}

export function ensureDeviceId(settings: PluginSettings, createId: () => string = () => crypto.randomUUID()): boolean {
  if (settings.deviceId.trim()) return false;
  settings.deviceId = createId();
  return true;
}

export function pollIntervalMs(settings: PluginSettings): number | undefined {
  if (settings.mode === "automatic") return 30_000;
  if (settings.mode === "scheduled") return settings.intervalMinutes * 60_000;
  return undefined;
}
