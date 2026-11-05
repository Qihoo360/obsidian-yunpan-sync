export const SYNC_COMPLETED_MESSAGE = "同步完成";
export const SYNC_UNCHANGED_MESSAGE = "已是最新";

export function syncCompletionMessage(appliedChanges: number): string {
  return appliedChanges > 0 ? SYNC_COMPLETED_MESSAGE : SYNC_UNCHANGED_MESSAGE;
}

export function isSuccessfulSyncMessage(message: string): boolean {
  return message === SYNC_COMPLETED_MESSAGE || message === SYNC_UNCHANGED_MESSAGE;
}

export function completionNotice(message: string): string {
  return message === SYNC_UNCHANGED_MESSAGE ? "本地与云端已是最新" : "360AI 云盘同步完成";
}
