import { describe, expect, it } from "vitest";
import { TransferProgressTracker, summarizeTransfers, overallTransferProgress, groupTransfers, transferPresentation,
  type FileTransferProgress } from "../src/sync/progress.js";

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

describe("whole-run progress presentation", () => {
  const running = { phase: "transfer", message: "正在执行同步任务" };
  const transfer = (id: string, state: FileTransferProgress["state"], completedBytes = 0, totalBytes = 100): FileTransferProgress =>
    ({ id, path: `${id}.md`, state, direction: "upload", completedBytes, totalBytes });

  it("aggregates all uploads and downloads independently of list filters or active file order", () => {
    const items = [transfer("small", "completed", 10, 10),
      { ...transfer("big", "transferring", 45, 90), direction: "download" as const }, transfer("empty", "queued", 0, 0)];
    expect(overallTransferProgress(items, running).percent).toBe(55);
    expect(overallTransferProgress([...items].reverse(), running).percent).toBe(55);
  });

  it("does not show 100% before verification, saving, failures or cancellation are resolved", () => {
    for (const state of ["queued", "transferring", "failed", "completed"] as const) {
      for (const phase of ["transfer", "verify", "save", "error", "paused"]) {
        expect(overallTransferProgress([transfer("one", state, 100)], { phase, message: "working" }).percent).toBe(99);
      }
    }
    expect(overallTransferProgress([transfer("one", "completed", 100)], { phase: "idle", message: "同步完成" }).percent).toBe(100);
    expect(overallTransferProgress([transfer("one", "failed", 100)], { phase: "idle", message: "同步完成" }).percent).toBe(99);
  });

  it("uses completed file counts for all-empty files and leaves unknown totals indeterminate", () => {
    expect(overallTransferProgress([], { phase: "local-scan", message: "扫描本地" }).percent).toBeUndefined();
    expect(overallTransferProgress([], { phase: "idle", message: "已是最新" }).percent).toBe(100);
    const items = [transfer("one", "completed", 0, 0), transfer("two", "queued", 0, 0)];
    expect(overallTransferProgress(items, running).percent).toBe(50);
    expect(overallTransferProgress([items[1]!], running).percent).toBe(0);
  });

  it("keeps stable state groups and searches completed and unfinished files together", () => {
    const items = [transfer("done", "completed"), transfer("queue", "queued"), transfer("bad", "failed"),
      transfer("active1", "transferring"), transfer("active2", "transferring")];
    expect(groupTransfers(items).pending.map(item => item.id)).toEqual(["active1", "active2", "queue", "bad"]);
    expect(groupTransfers(items).completed.map(item => item.id)).toEqual(["done"]);
    expect(groupTransfers(items, "DONE")).toMatchObject({ pending: [], completed: [items[0]] });
    expect(transferPresentation(transfer("done", "completed")).label).toBe("已完成");
    expect(transferPresentation(transfer("queue", "queued", 100)).percent).toBe(0);
    expect(transferPresentation(transfer("active", "transferring", 100)).percent).toBe(99);
    expect(transferPresentation(transfer("bad", "failed", 35)).label).toBe("失败");
  });
});
