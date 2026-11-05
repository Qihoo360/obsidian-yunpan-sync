import { describe, expect, it } from "vitest";
import { failedTaskPresentation } from "../src/ui/task-presentation.js";

describe("failed task presentation", () => {
  it("shows the operation, original path, readable error, and retry target", () => {
    const task = {
      id: "upload-1", kind: "upload" as const, path: "foldera/filea.md", payload: {},
      state: "failed" as const, attempt: 8, nextRunAt: 0, lastError: "network timeout",
    };

    expect(failedTaskPresentation(task)).toEqual({
      action: "上传",
      path: "foldera/filea.md",
      detail: "网络连接异常，请检查网络后重试。",
      retryTaskId: "upload-1",
    });
  });

  it("labels every synchronization operation", () => {
    const kinds = ["upload", "download", "mkdir", "recycle", "rename", "move", "local-rename"] as const;
    const labels = kinds.map((kind) => failedTaskPresentation({
      id: kind, kind, path: kind, payload: {}, state: "failed", attempt: 1, nextRunAt: 0,
    }).action);

    expect(labels).toEqual(["上传", "下载", "新建目录", "删除", "重命名", "移动", "重命名"]);
  });
});
