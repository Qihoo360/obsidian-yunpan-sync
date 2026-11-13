import { describe, expect, it } from "vitest";
import { syncAnalyticsAttributes, syncAnalyticsType } from "../src/analytics/events.js";

describe("analytics event mapping", () => {
  it.each([
    ["manual", true, "manual"],
    ["automatic", true, "manual"],
    ["scheduled", true, "manual"],
    ["automatic", false, "auto"],
    ["scheduled", false, "lowAuto"],
  ] as const)("maps %s runs to %s", (mode, interactive, expected) => {
    expect(syncAnalyticsType(mode, interactive)).toBe(expected);
  });

  it("serializes file names, failures, and config state for sync results", () => {
    const attrs = syncAnalyticsAttributes({
      files: [{ path: "notes/a.md", size: 3 * 1024 * 1024 }, { path: "b.md", size: 4.2 * 1024 * 1024 }],
      failures: [{ path: "bad.md", reason: "HTTP 500" }, { path: "other.md", reason: "HTTP 500" }],
      cancelled: false,
    }, "manual", true);
    expect(attrs).toMatchObject({ syncType: "manual", obConfig: "true", failFileNum: "2" });
    expect(JSON.parse(attrs.fileName!)).toEqual(["a.md 3072KB", "b.md 4300.8KB"]);
    expect(JSON.parse(attrs.failReason!)).toEqual(["网络连接异常"]);
  });

  it("formats KB and rename destinations, limiting the event to ten entries", () => {
    const attrs = syncAnalyticsAttributes({
      files: [
        { path: "notes/small.md", size: 14 },
        { path: "one.md", size: 1024 },
        { path: "notes/old.md", destination: "archive/new.md", size: 1536 },
        { path: "empty.md", size: 0 },
        ...Array.from({ length: 8 }, (_, i) => ({ path: `extra${i}.md`, size: 2048 })),
      ], failures: [], cancelled: false,
    }, "auto", false);
    const files = JSON.parse(attrs.fileName!);
    expect(files).toHaveLength(10);
    expect(files.slice(0, 4)).toEqual(["small.md 0.01KB", "one.md 1KB", "notes/old.md -> archive/new.md 1.5KB", "empty.md 0KB"]);
    expect(files.at(-1)).toBe("extra5.md 2KB");
  });

  it("keeps cancelled runs available to the caller without changing the payload shape", () => {
    const attrs = syncAnalyticsAttributes({ files: [], failures: [], cancelled: true }, "auto", false);
    expect(attrs).toEqual({ syncType: "auto", obConfig: "false", fileName: "[]", failFileNum: "0", failReason: "[]" });
  });
});
