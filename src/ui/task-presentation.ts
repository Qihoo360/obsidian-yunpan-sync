import type { SyncTask } from "../storage/database.js";
import { classifySyncError } from "../sync/error-guidance.js";

const OPERATION_LABELS: Record<SyncTask["kind"], string> = {
  upload: "上传",
  download: "下载",
  mkdir: "新建目录",
  recycle: "删除",
  rename: "重命名",
  move: "移动",
  "local-rename": "重命名",
};

export interface FailedTaskPresentation {
  action: string;
  path: string;
  detail: string;
  retryTaskId: string;
}

export function taskOperationLabel(kind: SyncTask["kind"]): string {
  return OPERATION_LABELS[kind];
}

export function failedTaskPresentation(task: SyncTask): FailedTaskPresentation {
  return {
    action: taskOperationLabel(task.kind),
    path: task.path,
    detail: classifySyncError(task.lastError ?? "同步失败").detail,
    retryTaskId: task.id,
  };
}
