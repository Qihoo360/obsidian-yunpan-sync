import { describe, expect, it } from "vitest";
import { TransferProgressTracker, summarizeTransfers } from "../src/sync/progress.js";

describe("per-file transfer progress", () => {
  it("tracks queued, transferring, completed, and failed files without exceeding their size", () => {
    const tracker = new TransferProgressTracker();
    tracker.queue("one", "download", "云端文件.docx", 100);
    tracker.queue("two", "upload", "笔记.md", 20);
    tracker.start("one");
    tracker.update("one", 40, 100);
    tracker.complete("one");
    tracker.start("two");
    tracker.update("two", 999, 20);
    tracker.fail("two", "network unavailable");

    expect(tracker.snapshot()).toEqual([
      { id: "one", direction: "download", path: "云端文件.docx", completedBytes: 100, totalBytes: 100, state: "completed" },
      { id: "two", direction: "upload", path: "笔记.md", completedBytes: 20, totalBytes: 20, state: "failed", error: "network unavailable" },
    ]);
  });

  it("starts each synchronization with an empty progress list", () => {
    const tracker = new TransferProgressTracker();
    tracker.queue("one", "download", "a.md", 10);
    tracker.reset();
    expect(tracker.snapshot()).toEqual([]);
  });

  it("removes the deleted failure without clearing other file progress", () => {
    const tracker = new TransferProgressTracker();
    tracker.queue("one", "upload", "bad.md", 10);
    tracker.queue("two", "upload", "ok.md", 20);
    tracker.fail("one", "source missing");
    tracker.complete("two");
    tracker.remove("one");
    expect(tracker.snapshot().map((item) => item.id)).toEqual(["two"]);
    expect(summarizeTransfers(tracker.snapshot())).toMatchObject({ failedCount: 0, completedCount: 1 });
  });

  it("calculates the overall progress from bytes, not file count", () => {
    const tracker = new TransferProgressTracker();
    tracker.queue("small", "upload", "small.md", 10);
    tracker.queue("large", "download", "large.bin", 90);
    tracker.update("small", 10, 10);
    tracker.complete("small");
    tracker.update("large", 45, 90);

    expect(summarizeTransfers(tracker.snapshot())).toEqual({
      totalBytes: 100,
      completedBytes: 55,
      percent: 55,
      activePath: "large.bin",
      queuedCount: 0,
      activeCount: 1,
      completedCount: 1,
      failedCount: 0,
    });
  });
});
