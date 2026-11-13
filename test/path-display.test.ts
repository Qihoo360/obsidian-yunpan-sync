import { describe, expect, it } from "vitest";
import { formatDisplayPath, MAX_DISPLAY_PATH_LENGTH, pathDisplayAttributes } from "../src/ui/path-display.js";

describe("sync path display", () => {
  it("keeps short paths unchanged", () => {
    const path = "notes/readme.md";
    expect(formatDisplayPath(path)).toBe(path);
  });

  it("keeps a fixed 40-character head and tail for long paths", () => {
    const path = "a".repeat(60) + "/final-note.md";
    const displayed = formatDisplayPath(path);
    expect(displayed).toHaveLength(MAX_DISPLAY_PATH_LENGTH);
    expect(displayed).toBe(`${path.slice(0, 18)}....${path.slice(-18)}`);
    expect(displayed).toContain("....");
  });

  it("counts Unicode characters without splitting emoji or surrogate pairs", () => {
    const path = "😀中文/" + "文件".repeat(30) + ".md";
    const displayed = formatDisplayPath(path);
    expect([...displayed]).toHaveLength(MAX_DISPLAY_PATH_LENGTH);
    expect(displayed.startsWith("😀中文/"));
    expect(displayed.endsWith("件.md"));
    expect(displayed).toContain("....");
  });

  it("keeps the original path available to assistive and hover text", () => {
    const path = "a".repeat(50) + ".md";
    expect(pathDisplayAttributes(path)).toEqual({ title: path, "aria-label": path });
  });
});
