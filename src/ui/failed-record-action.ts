import type { SyncTask } from "../storage/database.js";

interface FailedRecordOwner {
  isSyncing: boolean;
  removeFailedTask(id: string): Promise<void>;
}

export function renderIgnoreFileAction(container: HTMLElement, id: string,
  owner: { isSyncing: boolean; ignoreTask(id: string): Promise<void> }): void {
  const ignore = container.createEl("button", { text: "忽略此文件",
    attr: { title: "以后不再上传或下载此路径，保留两端文件；可在过滤规则中取消忽略" } });
  ignore.disabled = owner.isSyncing;
  ignore.addEventListener("click", () => {
    if (owner.isSyncing || ignore.disabled) return;
    ignore.disabled = true;
    void owner.ignoreTask(id).finally(() => { ignore.disabled = owner.isSyncing; });
  });
}

/** Capture the displayed records so a status refresh cannot change the targets. */
export function renderFailedRecordAction(container: HTMLElement, tasks: readonly SyncTask[], owner: FailedRecordOwner): void {
  if (!tasks.length) return;
  const ids = tasks.map(task => task.id);
  const remove = container.createEl("button", { text: "删除记录", cls: "yunpan-sync-status-error-action",
    attr: { title: `删除 ${ids.length} 条失败任务记录，保留两端文件` } });
  remove.disabled = owner.isSyncing;
  remove.addEventListener("click", () => {
    if (owner.isSyncing || remove.disabled) return;
    remove.disabled = true;
    void (async () => {
      for (const id of ids) await owner.removeFailedTask(id);
    })().finally(() => { remove.disabled = owner.isSyncing; });
  });
}
