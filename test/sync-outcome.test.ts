import { describe, expect, it } from "vitest";
import { completionNotice, syncCompletionMessage } from "../src/sync/outcome.js";

describe("sync completion copy", () => {
  it("reports an up-to-date vault when no cloud or local changes were applied", () => {
    expect(syncCompletionMessage(0)).toBe("已是最新");
    expect(completionNotice("已是最新")).toBe("本地与云端已是最新");
  });

  it("reports completion when at least one change was applied", () => {
    expect(syncCompletionMessage(1)).toBe("同步完成");
    expect(completionNotice("同步完成")).toBe("360AI 云盘同步完成");
  });
});
