import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, ensureDeviceId, normalizeSettings, pollIntervalMs } from "../src/settings.js";

describe("plugin settings", () => {
  it("defaults fresh installs to manual production sync", () => {
    expect(DEFAULT_SETTINGS.mode).toBe("manual");
    expect(DEFAULT_SETTINGS.openapiBaseUrl).toBe("https://openapi.eyun.360.cn/intf.php");
    expect(pollIntervalMs(DEFAULT_SETTINGS)).toBeUndefined();
  });

  it("allows only the supported scheduled intervals", () => {
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 13 })).toMatchObject({ intervalMinutes: 13 });
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 0 })).toMatchObject({ intervalMinutes: 1 });
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 5000 })).toMatchObject({ intervalMinutes: 1440 });
    expect(pollIntervalMs(normalizeSettings({ mode: "automatic" }))).toBe(30_000);
  });

  it("defaults Obsidian configuration syncing off and accepts extension filters", () => {
    expect(DEFAULT_SETTINGS.syncObsidianConfig).toBe(false);
    const migrated = normalizeSettings({ syncObsidianConfig: true, excludedExtensions: ".log, tmp" });
    expect(migrated).toMatchObject({
      syncObsidianConfig: true,
      excludedExtensions: ".log, tmp",
    });
    expect(migrated.filterRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "**/*.log", enabled: true, caseSensitive: false }),
      expect.objectContaining({ pattern: "**/*.tmp", enabled: true, caseSensitive: false }),
    ]));
    expect(DEFAULT_SETTINGS.filterRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "**/.git" }),
      expect.objectContaining({ pattern: "**/.DS_Store" }),
    ]));
  });

  it("normalizes persisted filter rules without sharing mutable defaults", () => {
    const normalized = normalizeSettings({ filterRules: [
      { id: "custom", enabled: false, pattern: "  **/*.PDF  ", caseSensitive: true },
      { id: "invalid", enabled: true, pattern: "", caseSensitive: false },
    ] });

    expect(normalized.filterRules).toEqual([
      { id: "custom", enabled: false, pattern: "**/*.PDF", caseSensitive: true },
    ]);
    expect(normalized.filterRules).not.toBe(DEFAULT_SETTINGS.filterRules);
  });

  it("creates a device id once and preserves it across settings loads", () => {
    const fresh = normalizeSettings({});
    expect(ensureDeviceId(fresh, () => "generated-id")).toBe(true);
    expect(fresh.deviceId).toBe("generated-id");

    const existing = normalizeSettings(fresh);
    expect(ensureDeviceId(existing, () => "replacement-id")).toBe(false);
    expect(existing.deviceId).toBe("generated-id");
  });
});
