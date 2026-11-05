import { describe, expect, it } from "vitest";
import { initialStatus, restoredStatus } from "../src/status.js";

describe("plugin status restoration", () => {
  it("shows the persisted account immediately after reload", () => {
    expect(initialStatus({ qid: "3475" }, 1_700_000_000_000)).toMatchObject({
      phase: "idle",
      message: "已登录",
      queued: 0,
      failed: 0,
      lastSuccess: 1_700_000_000_000,
    });
  });

  it("shows logged out when no persisted account exists", () => {
    expect(initialStatus()).toMatchObject({ phase: "idle", message: "未登录" });
  });

  it("restores retrying tasks as visible synchronization failures", () => {
    const failedTask = {
      id: "retry-upload", kind: "upload" as const, path: "notes/offline.md", payload: {},
      state: "retry" as const, attempt: 1, nextRunAt: 1_700_000_010_000, lastError: "network timeout",
    };

    expect(restoredStatus({ qid: "3475" }, 1_700_000_000_000, { queued: 1, failed: 0 }, [failedTask]))
      .toMatchObject({
        phase: "error",
        message: "部分文件同步失败",
        queued: 1,
        failed: 1,
        lastError: "1 sync task failed",
        failedTasks: [failedTask],
      });
  });
});
