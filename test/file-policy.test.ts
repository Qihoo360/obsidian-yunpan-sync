import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, FILE_SIZE_MB, normalizeSettings, validFileSizeRange } from "../src/settings.js";
import { fileSizeExclusion, ProtectedPaths } from "../src/sync/file-policy.js";
import { shouldIgnorePath, validateWindowsPathSegment } from "../src/domain/paths.js";
const ignored = (path: string, settings: ReturnType<typeof normalizeSettings>) => shouldIgnorePath(path, { filterRules: settings.filterRules });

describe("file size policy and mobile defaults", () => {
  it.each([0, 1, 30 * FILE_SIZE_MB])("includes size boundary %s", size => {
    expect(fileSizeExclusion(size, DEFAULT_SETTINGS)).toBeUndefined();
  });
  it.each([-1, undefined, NaN, Infinity, 30 * FILE_SIZE_MB + 1])("excludes unknown or excessive size %s", size => {
    expect(fileSizeExclusion(size, DEFAULT_SETTINGS)).toBeDefined();
  });
  it("uses inclusive fractional MB ranges without treating max zero as unlimited", () => {
    const settings = { ...DEFAULT_SETTINGS, minFileSizeMB: 0.5, maxFileSizeMB: 1.25 };
    expect(fileSizeExclusion(FILE_SIZE_MB / 2, settings)).toBeUndefined();
    expect(fileSizeExclusion(FILE_SIZE_MB * 1.25, settings)).toBeUndefined();
    expect(fileSizeExclusion(FILE_SIZE_MB / 2 - 1, settings)).toBeDefined();
    expect(validFileSizeRange(0, 0)).toBe(false);
    expect(validFileSizeRange(2, 1)).toBe(false);
    expect(validFileSizeRange(-1, 30)).toBe(false);
    expect(validFileSizeRange(0, Infinity)).toBe(false);
    expect(validFileSizeRange(1, 1)).toBe(false);
    expect(validFileSizeRange(0, 500)).toBe(true);
    expect(validFileSizeRange(0, 501)).toBe(false);
    expect(validFileSizeRange(1.5, 2)).toBe(false);
    expect(validFileSizeRange(1, 500.1)).toBe(false);
    expect(normalizeSettings({ maxFileSizeMB: 0 })).toMatchObject({ minFileSizeMB: 0, maxFileSizeMB: 30 });
  });
  it("migrates mobile exclusions once before user rules and preserves desktop rules", () => {
    const input = { filterRules: [{ id: "mine", enabled: true, action: "include" as const, pattern: "**/*.mp4", caseSensitive: false }] };
    const mobile = normalizeSettings(input, true);
    expect(mobile.filterRules.at(-1)?.id).toBe("mine");
    expect(ignored("movie.mp4", mobile)).toBe(false);
    expect(ignored("model.DWG", mobile)).toBe(true);
    expect(ignored("backup.ZIP", mobile)).toBe(true);
    expect(ignored("voice.OPUS", mobile)).toBe(true);
    const disabled = { ...mobile, filterRules: mobile.filterRules.filter(rule => rule.id !== "mobile-v1-dwg") };
    expect(ignored("model.dwg", normalizeSettings(disabled, true))).toBe(false);
    expect(normalizeSettings(input, false).filterRules).toEqual(input.filterRules);
  });
  it.each(["doc", "docx", "docm", "dotx", "xls", "xlsx", "xlsm", "xltx", "ppt", "pptx", "pptm", "potx", "pdf", "md", "png", "jpg", "heic"])("retains %s on mobile", extension => {
    expect(ignored(`folder/file.${extension}`, normalizeSettings({}, true))).toBe(false);
  });
  it("protects whole subtrees and their ancestors without excluding siblings", () => {
    const paths = new ProtectedPaths();
    paths.add("folder/model", "excluded", "local");
    expect(paths.has("FOLDER/model/child")).toBe(true);
    expect(paths.has("folder", true)).toBe(true);
    expect(paths.has("folder")).toBe(false);
    expect(paths.has("folder/note.md")).toBe(false);
    expect(paths.has("folder-other", true)).toBe(false);
  });
  it("merges local and remote skip sources and ignores the vault root", () => {
    const paths = new ProtectedPaths();
    paths.add("/", "根目录不参与同步", "local");
    paths.add("docs/file.md", "本地大小限制", "local");
    paths.add("docs/file.md", "云端大小限制", "remote");
    expect(paths.entries()).toEqual([{ path: "docs/file.md", reason: "本地大小限制；云端大小限制", source: "both" }]);
    expect(paths.has("docs/file.md")).toBe(true);
    expect(paths.has("other.md")).toBe(false);
  });
  it("keeps the first known size when merging skip sources", () => {
    const paths = new ProtectedPaths();
    paths.add("docs/file.md", "本地大小限制", "local", 2048);
    paths.add("docs/file.md", "云端大小限制", "remote", 4096);
    expect(paths.entries()).toEqual([{ path: "docs/file.md", reason: "本地大小限制；云端大小限制", source: "both", size: 2048 }]);
  });
  it("fills a missing size with the first valid value, including zero", () => {
    const paths = new ProtectedPaths();
    paths.add("file.md", "unknown", "local", NaN);
    expect(paths.entries()[0]?.size).toBeUndefined();
    paths.add("file.md", "unknown", "local", -1);
    paths.add("file.md", "empty", "remote", 0);
    paths.add("file.md", "larger", "remote", 2048);
    expect(paths.entries()[0]?.size).toBe(0);
  });
  it("checks both UTF-16 length and filesystem UTF-8 bytes", () => {
    expect(() => validateWindowsPathSegment("a".repeat(255))).not.toThrow();
    expect(() => validateWindowsPathSegment("a".repeat(256))).toThrow(/255/);
    expect(() => validateWindowsPathSegment("文".repeat(85))).not.toThrow();
    expect(() => validateWindowsPathSegment("文".repeat(86))).toThrow(/255 字节/);
  });
});
