import { DEFAULT_SETTINGS, FILE_SIZE_MB, type PluginSettings } from "../settings.js";

export function fileSizeExclusion(size: number | undefined, settings: Pick<PluginSettings, "minFileSizeMB" | "maxFileSizeMB">): string | undefined {
  if (size === undefined || !Number.isSafeInteger(size) || size < 0) return "无法确认文件大小";
  const min = settings.minFileSizeMB ?? DEFAULT_SETTINGS.minFileSizeMB;
  const max = settings.maxFileSizeMB ?? DEFAULT_SETTINGS.maxFileSizeMB;
  if (size < min * FILE_SIZE_MB || size > max * FILE_SIZE_MB) return `文件大小不在 ${min}–${max} MB 范围内`;
  return undefined;
}

export class TaskSkippedError extends Error {
  constructor(message: string) { super(message); this.name = "TaskSkippedError"; }
}

export type SkippedFileSource = "local" | "remote" | "both";
export interface SkippedFile { path: string; reason: string; source: SkippedFileSource; size?: number }

/** A blocked subtree also protects ancestors from recursive deletion/rename. */
export class ProtectedPaths {
  private paths = new Map<string, SkippedFile>();
  private ancestors = new Set<string>();
  private key(path: string): string { return path.normalize("NFC").toLocaleLowerCase("en-US").replace(/\/+$/, ""); }
  add(path: string, reason: string, source: SkippedFileSource = "local", size?: number): void {
    const key = this.key(path);
    // The vault root is an internal ancestor, never a user-visible skipped item.
    if (!key) return;
    const existing = this.paths.get(key);
    const validSize = size !== undefined && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
    if (existing) {
      const mergedSource: SkippedFileSource = existing.source === source ? source : "both";
      const reasons = new Set([existing.reason, reason].filter(Boolean));
      const mergedSize = existing.size ?? validSize;
      this.paths.set(key, { path: existing.path, reason: [...reasons].join("；"), source: mergedSource,
        ...(mergedSize === undefined ? {} : { size: mergedSize }) });
    } else this.paths.set(key, { path, reason, source,
      ...(validSize === undefined ? {} : { size: validSize }) });
    const parts = key.split("/");
    while (parts.length > 1) { parts.pop(); this.ancestors.add(parts.join("/")); }
  }
  has(path: string, recursive = false): boolean {
    const key = this.key(path);
    if (recursive && this.ancestors.has(key)) return true;
    const parts = key.split("/");
    while (parts.length) { if (this.paths.has(parts.join("/"))) return true; parts.pop(); }
    return false;
  }
  entries(): SkippedFile[] { return [...this.paths.entries()].filter(([key]) => Boolean(key)).map(([, value]) => value); }
}
