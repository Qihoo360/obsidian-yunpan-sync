import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, ensureDeviceId, normalizeSettings, pollIntervalMs } from "../src/settings.js";

describe("plugin settings", () => {
  it("defaults fresh installs to automatic production sync", () => {
    expect(DEFAULT_SETTINGS.mode).toBe("automatic");
    expect(DEFAULT_SETTINGS.openapiBaseUrl).toBe("https://openapi.eyun.360.cn/intf.php");
    expect(pollIntervalMs(DEFAULT_SETTINGS)).toBe(3 * 60_000);
  });

  it.each([undefined, null, {}, { mode: "invalid" }, { mode: "" }])("falls back to automatic for absent or invalid settings %j", input => {
    expect(normalizeSettings(input as never).mode).toBe("automatic");
  });

  it.each(["manual", "automatic", "scheduled"])("preserves a saved valid %s mode", mode => {
    expect(normalizeSettings({ mode } as never).mode).toBe(mode);
  });

  it("allows only the supported scheduled intervals", () => {
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 13 })).toMatchObject({ intervalMinutes: 13 });
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 0 })).toMatchObject({ intervalMinutes: 4 });
    expect(normalizeSettings({ mode: "scheduled", intervalMinutes: 5000 })).toMatchObject({ intervalMinutes: 1440 });
    expect(pollIntervalMs(normalizeSettings({ mode: "automatic" }))).toBe(180_000);
  });

  it.each([
    [1, 4], [3, 4], [4, 4], [13, 13], [1440, 1440], [5000, 1440],
    [4.6, 5], [undefined, 30], [NaN, 30], [Infinity, 30],
  ])("normalizes saved scheduled interval %s to %s minutes", (value, expected) => {
    const settings = normalizeSettings({ mode: "scheduled", intervalMinutes: value });
    expect(settings.intervalMinutes).toBe(expected);
    expect(pollIntervalMs(settings)).toBe(expected * 60_000);
  });

  it("keeps the scheduled default at thirty minutes", () => {
    expect(DEFAULT_SETTINGS.intervalMinutes).toBe(30);
    expect(pollIntervalMs(normalizeSettings({ mode: "scheduled" }))).toBe(1_800_000);
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
      { id: "custom", enabled: false, pattern: "**/*.PDF", action: "exclude", caseSensitive: true },
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
