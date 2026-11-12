export type SyncMode = "manual" | "automatic" | "scheduled";
export type Environment = "production";
export const FILE_SIZE_MB = 1024 * 1024;
export const MOBILE_FILTER_VERSION = 1;
export const MOBILE_EXCLUDED_EXTENSIONS = (
  "dwg dxf dgn step stp iges igs stl obj fbx blend skp rvt ifc " +
  "mp4 mov mkv avi wmv webm flv m4v 3gp " +
  "mp3 wav m4a aac flac ogg opus wma amr " +
  "zip rar 7z tar gz bz2 xz exe msi dmg pkg apk aab ipa iso"
).split(" ");

export const AUTOMATIC_INTERVAL_MINUTES = 3;
export const MIN_SCHEDULED_INTERVAL_MINUTES = AUTOMATIC_INTERVAL_MINUTES + 1;
export const MAX_SCHEDULED_INTERVAL_MINUTES = 1440;

export interface FilterRule {
  id: string;
  enabled: boolean;
  pattern: string;
  action?: "exclude" | "include";
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
].map((pattern, index) => ({ id: `default-${index + 1}`, enabled: true, pattern, action: "exclude" as const, caseSensitive: false }));

export interface PluginSettings {
  environment: Environment;
  openapiBaseUrl: string;
  remoteRoot: string;
  remoteRootSelected?: boolean;
  accountDirectories?: Record<string, string>;
  mode: SyncMode;
  intervalMinutes: number;
  paused: boolean;
  deviceId: string;
  deviceName: string;
  ownerQid: string;
  syncObsidianConfig: boolean;
  excludedExtensions: string;
  filterRules: FilterRule[];
  minFileSizeMB: number;
  maxFileSizeMB: number;
  mobileFilterVersion: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  environment: "production",
  openapiBaseUrl: "https://openapi.eyun.360.cn/intf.php",
  remoteRoot: "/Obsidian/",
  remoteRootSelected: false,
  accountDirectories: {},
  mode: "automatic",
  intervalMinutes: 30,
  paused: false,
  deviceId: "",
  deviceName: "Obsidian",
  ownerQid: "0",
  syncObsidianConfig: false,
  excludedExtensions: "",
  filterRules: DEFAULT_FILTER_RULES.map((rule) => ({ ...rule })),
  minFileSizeMB: 0,
  maxFileSizeMB: 30,
  mobileFilterVersion: 0,
};

export function validFileSizeRange(min: number, max: number): boolean {
  return Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max <= 500 && min < max &&
    max * FILE_SIZE_MB <= Number.MAX_SAFE_INTEGER;
}

function normalizeFilterRules(value: unknown): FilterRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Partial<FilterRule>;
    const pattern = typeof source.pattern === "string" ? source.pattern.trim() : "";
    if (!pattern || pattern.length > 512) return [];
    const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : `rule-${index + 1}`;
    return [{ id, enabled: source.enabled !== false, pattern, action: source.action === "include" ? "include" as const : "exclude" as const,
      caseSensitive: source.caseSensitive === true }];
  });
}

function legacyExtensionRules(value: string): FilterRule[] {
  return [...new Set(value.split(/[\s,;，；]+/)
    .map((item) => item.trim().toLowerCase().replace(/^\*?\.?/, ""))
    .filter(Boolean))]
    .map((extension, index) => ({ id: `legacy-extension-${index + 1}`, enabled: true, action: "exclude" as const,
      pattern: `**/*.${extension}`, caseSensitive: false }));
}

export function normalizeSettings(input: Partial<PluginSettings> | null | undefined, mobile = false): PluginSettings {
  const environment = "production" as const;
  const mode: SyncMode = ["manual", "automatic", "scheduled"].includes(input?.mode ?? "")
    ? input!.mode! : "automatic";
  const intervalMinutes = normalizeScheduledInterval(input?.intervalMinutes);
  const excludedExtensions = typeof input?.excludedExtensions === "string" ? input.excludedExtensions : "";
  const persistedRules = normalizeFilterRules(input?.filterRules);
  let filterRules = persistedRules ?? [
    ...DEFAULT_FILTER_RULES.map((rule) => ({ ...rule })),
    ...legacyExtensionRules(excludedExtensions),
  ];
  const mobileFilterVersion = Number(input?.mobileFilterVersion) || 0;
  if (mobile && mobileFilterVersion < MOBILE_FILTER_VERSION) {
    filterRules = [...MOBILE_EXCLUDED_EXTENSIONS.map(extension => ({ id: `mobile-v1-${extension}`,
      enabled: true, action: "exclude" as const, pattern: `**/*.${extension}`, caseSensitive: false })), ...filterRules];
  }
  const min = input?.minFileSizeMB ?? DEFAULT_SETTINGS.minFileSizeMB;
  const max = input?.maxFileSizeMB ?? DEFAULT_SETTINGS.maxFileSizeMB;
  const validRange = validFileSizeRange(min, max);
  const { mobileNetworkPolicy: _legacyMobileNetworkPolicy, ...persistedSettings } = (input ?? {}) as Partial<PluginSettings> & {
    mobileNetworkPolicy?: unknown;
  };
  return {
    ...DEFAULT_SETTINGS,
    ...persistedSettings,
    environment,
    mode,
    intervalMinutes,
    accountDirectories: Object.fromEntries(Object.entries(input?.accountDirectories ?? {}).filter(
      ([key, path]) => key.length < 256 && typeof path === "string" && path.startsWith("/"))),
    remoteRootSelected: input?.remoteRootSelected ?? Boolean(input?.remoteRoot && input.remoteRoot !== DEFAULT_SETTINGS.remoteRoot),
    syncObsidianConfig: input?.syncObsidianConfig === true,
    excludedExtensions,
    filterRules,
    minFileSizeMB: validRange ? min : DEFAULT_SETTINGS.minFileSizeMB,
    maxFileSizeMB: validRange ? max : DEFAULT_SETTINGS.maxFileSizeMB,
    mobileFilterVersion: mobile ? Math.max(MOBILE_FILTER_VERSION, mobileFilterVersion) : mobileFilterVersion,
    openapiBaseUrl: "https://openapi.eyun.360.cn/intf.php",
  };
}

export function ensureDeviceId(settings: PluginSettings, createId: () => string = () => crypto.randomUUID()): boolean {
  if (settings.deviceId.trim()) return false;
  settings.deviceId = createId();
  return true;
}

export function normalizeScheduledInterval(value: unknown): number {
  const requested = Number(value ?? DEFAULT_SETTINGS.intervalMinutes);
  return Math.min(MAX_SCHEDULED_INTERVAL_MINUTES, Math.max(MIN_SCHEDULED_INTERVAL_MINUTES,
    Number.isFinite(requested) ? Math.round(requested) : DEFAULT_SETTINGS.intervalMinutes));
}

export function pollIntervalMs(settings: PluginSettings): number | undefined {
  if (settings.mode === "automatic") return AUTOMATIC_INTERVAL_MINUTES * 60_000;
  if (settings.mode === "scheduled") return settings.intervalMinutes * 60_000;
  return undefined;
}
