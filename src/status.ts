import type { CloudAuth } from "./auth/secrets.js";
import type { SyncTask } from "./storage/database.js";
import type { EngineStatus } from "./sync/engine.js";

export function initialStatus(auth?: Pick<CloudAuth, "qid">, lastSuccess?: number): EngineStatus {
  return {
    phase: "idle",
    message: auth ? "已登录" : "未登录",
    queued: 0,
    failed: 0,
    lastSuccess,
  };
}

export function restoredStatus(
  auth: Pick<CloudAuth, "qid"> | undefined,
  lastSuccess: number | undefined,
  counts: Pick<EngineStatus, "queued" | "failed">,
  failedTasks: readonly SyncTask[],
): EngineStatus {
  if (failedTasks.length === 0) return { ...initialStatus(auth, lastSuccess), ...counts };
  return {
    ...initialStatus(auth, lastSuccess),
    ...counts,
    phase: "error",
    message: "部分文件同步失败",
    failed: failedTasks.length,
    lastError: `${failedTasks.length} sync task${failedTasks.length === 1 ? "" : "s"} failed`,
    failedTasks: [...failedTasks],
  };
}
