import type { SyncMode } from "../settings.js";
import { classifySyncError } from "../sync/error-guidance.js";
import type { SyncRunSummary } from "../sync/engine.js";

export type SyncAnalyticsType = "auto" | "lowAuto" | "manual";

export function syncAnalyticsType(mode: SyncMode, interactive: boolean): SyncAnalyticsType {
  if (interactive) return "manual";
  return mode === "scheduled" ? "lowAuto" : "auto";
}

export function syncAnalyticsAttributes(summary: SyncRunSummary, syncType: SyncAnalyticsType,
  syncObsidianConfig: boolean): Record<string, string> {
  const fileName = summary.files.slice(0, 10).map(file => {
    const name = file.destination ? file.path : file.path.split("/").pop() || file.path;
    const size = Math.round((file.size / 1024) * 100) / 100;
    return `${name}${file.destination ? ` -> ${file.destination}` : ""} ${size}KB`;
  });
  const failReason = [...new Set(summary.failures.map(failure => classifySyncError(failure.reason).title))].slice(0, 20);
  return {
    syncType,
    obConfig: String(syncObsidianConfig),
    fileName: JSON.stringify(fileName),
    failFileNum: String(summary.failures.length),
    failReason: JSON.stringify(failReason),
  };
}
