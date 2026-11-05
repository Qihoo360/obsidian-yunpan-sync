import { describe, expect, it } from "vitest";
import { buildConflictPath, normalizeRemoteRoot, normalizeVaultPath, remoteToVaultPath, shouldIgnorePath,
  validateWindowsPathSegment, WindowsPathError } from "../src/domain/paths.js";
import { planThreeWay } from "../src/domain/planner.js";
import { createOpenApiSign } from "../src/net/signing.js";
import { assertStoreUrl } from "../src/net/store-url.js";

describe("sync domain contracts", () => {
  it("excludes Obsidian and temporary state", () => {
    expect(shouldIgnorePath(".obsidian/plugins/x/data.json")).toBe(true);
    expect(shouldIgnorePath("notes/a.md~")).toBe(true);
    expect(shouldIgnorePath("notes/a.md")).toBe(false);
    expect(shouldIgnorePath(".obsidian/app.json", { syncObsidianConfig: true })).toBe(false);
    expect(shouldIgnorePath(".obsidian/plugins/yunpan-sync/data.json", { syncObsidianConfig: true })).toBe(true);
    expect(shouldIgnorePath(".obsidian/plugins/obsidian-yunpan-sync/sync.sqlite", { syncObsidianConfig: true })).toBe(true);
    expect(shouldIgnorePath("notes/a.log", { excludedExtensions: [".log"] })).toBe(true);
    expect(shouldIgnorePath("notes/a.md", { excludedExtensions: ["log"] })).toBe(false);
    expect(shouldIgnorePath("notes/.DS_Store", { filterRules: [] })).toBe(false);
    expect(shouldIgnorePath(".trash/recovered.md", { filterRules: [] })).toBe(false);
  });

  it("applies ordered path filter rules with glob and case controls", () => {
    const filterRules = [
      { id: "git", enabled: true, pattern: "**/.git", caseSensitive: false },
      { id: "tmp", enabled: true, pattern: "**/*.tmp", caseSensitive: false },
      { id: "pdf", enabled: true, pattern: "Private/*.PDF", caseSensitive: true },
      { id: "off", enabled: false, pattern: "**/*.md", caseSensitive: false },
    ];

    expect(shouldIgnorePath("project/.git/config", { filterRules })).toBe(true);
    expect(shouldIgnorePath("draft/cache.TMP", { filterRules })).toBe(true);
    expect(shouldIgnorePath("Private/report.PDF", { filterRules })).toBe(true);
    expect(shouldIgnorePath("private/report.pdf", { filterRules })).toBe(false);
    expect(shouldIgnorePath("notes/readme.md", { filterRules })).toBe(false);
  });

  it("normalizes a bound remote root", () => {
    expect(normalizeRemoteRoot("Obsidian\\Work")).toBe("/Obsidian/Work/");
    expect(() => normalizeRemoteRoot("../../escape")).toThrow();
    expect(() => remoteToVaultPath("/Obsidian/", "/Obsidian/bad:name.md")).toThrow();
  });

  it.each(["CON", "CON.txt", "COM1.md", "LPT9"])("rejects Windows reserved device names: %s", (name) => {
    expect(() => normalizeVaultPath(`notes/${name}`)).toThrow(WindowsPathError);
  });

  it.each(["notes/readme ", "notes/readme."])("rejects Windows trailing spaces and dots: %s", (path) => {
    expect(() => normalizeVaultPath(path)).toThrow(WindowsPathError);
  });

  it("rejects an overlong Windows path segment and normalizes Unicode", () => {
    expect(normalizeVaultPath("x".repeat(210))).toBe("x".repeat(210));
    expect(normalizeVaultPath("x".repeat(255))).toBe("x".repeat(255));
    expect(() => normalizeVaultPath("x".repeat(256))).toThrow(/255/);
    expect(normalizeVaultPath("cafe\u0301.md")).toBe("café.md");
  });

  it.each(["\\", "/", ":", "*", "?", "\"", "<", ">", "|"])(
    "rejects the ASCII filename character: %s",
    (character) => {
      try { validateWindowsPathSegment(`note${character}name.md`); }
      catch (error) {
        expect(error).toBeInstanceOf(WindowsPathError);
        expect((error as WindowsPathError).characters).toEqual([character]);
        return;
      }
      throw new Error("expected WindowsPathError");
    },
  );

  it("reports all distinct invalid filename characters in source order", () => {
    expect(() => validateWindowsPathSegment("backup!@<>!?.md")).toThrowError(
      expect.objectContaining({ characters: ["<", ">", "?"] }),
    );
  });

  it.each(["😀", "🇨🇳", "1️⃣"])("rejects emoji filename sequences: %s", (emoji) => {
    expect(() => normalizeVaultPath(`notes/${emoji}.md`)).toThrowError(
      expect.objectContaining({ issue: "emoji", characters: [emoji] }),
    );
  });

  it("accepts portable Chinese punctuation", () => {
    expect(normalizeVaultPath("notes/！@#￥%……&.md")).toBe("notes/！@#￥%……&.md");
  });

  it("normalizes remote roots and vault paths to NFC before comparison", () => {
    expect(normalizeRemoteRoot("/cafe\u0301")).toBe("/café/");
    expect(remoteToVaultPath("/Obsidian/cafe\u0301/", "/Obsidian/café/Notes.md")).toBe("Notes.md");
    expect(remoteToVaultPath("/Obsidian/AA/", "/obsidian/aa/Notes.md")).toBe("Notes.md");
  });

  it("plans all primary three-way outcomes", () => {
    const same = { hash: "a", size: 1, mtime: 1, kind: "file" as const };
    const changed = { hash: "b", size: 1, mtime: 2, kind: "file" as const };
    expect(planThreeWay(undefined, same, undefined).action).toBe("upload");
    expect(planThreeWay(undefined, undefined, same).action).toBe("download");
    expect(planThreeWay(same, changed, same).action).toBe("upload");
    expect(planThreeWay(same, same, changed).action).toBe("download");
    expect(planThreeWay(same, changed, changed).action).toBe("conflict");
    expect(planThreeWay(same, undefined, same).action).toBe("delete-remote");
    expect(planThreeWay(same, same, undefined).action).toBe("delete-local");
  });

  it("creates stable unique conflict names", () => {
    expect(buildConflictPath("docs/a.md", "Mac", new Date("2026-10-20T01:02:03Z"), 0))
      .toBe("docs/a (conflict-Mac-20261020-010203).md");
    expect(buildConflictPath("docs/a.md", "Mac", new Date("2026-10-20T01:02:03Z"), 2))
      .toBe("docs/a (conflict-Mac-20261020-010203-2).md");
  });

  it("matches PHP-style OpenAPI signing", () => {
    expect(createOpenApiSign({ method: "Incr.getBgsp", qid: "12", access_token: "a b" }, "secret"))
      .toBe("88e05fb396dd2ba73c714c38e1a67a52");
  });

  it("accepts only approved HTTPS Store endpoints", () => {
    expect(assertStoreUrl("https://dl117.yunpan.360.cn/intf.php").hostname)
      .toBe("dl117.yunpan.360.cn");
    expect(assertStoreUrl("up117.yunpan.360.cn").toString())
      .toBe("https://up117.yunpan.360.cn/intf.php");
    expect(() => assertStoreUrl("http://127.0.0.1/intf.php")).toThrow();
    expect(() => assertStoreUrl("https://evil.example/intf.php")).toThrow();
  });
});
