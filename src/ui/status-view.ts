import { ItemView, Setting, setIcon, type EventRef, type WorkspaceLeaf } from "obsidian";
import { formatBytes } from "../account/profile.js";
import type { SyncConflict, SyncTask } from "../storage/database.js";
import type { EngineStatus } from "../sync/engine.js";
import { summarizeTransfers, type FileTransferProgress } from "../sync/progress.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { sideStatusAction } from "./status-action.js";
import { failedTaskPresentation } from "./task-presentation.js";

export const YUNPAN_STATUS_VIEW = "yunpan-sync-status-view";

export interface StatusViewOwner {
  currentStatus: EngineStatus;
  isPaused: boolean;
  transferProgress: readonly FileTransferProgress[];
  failedTasks: readonly SyncTask[];
  isSyncing: boolean;
  conflicts: readonly SyncConflict[];
  syncNow(): Promise<void>;
  retryFailed(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  showSyncProgress(): void;
  retryTask(id: string): Promise<void>;
  removeFailedTask(id: string): Promise<void>;
  resolveConflict(id: number): Promise<void>;
  hasVaultFile(path: string): Promise<boolean>;
  openVaultPath(path: string): Promise<void>;
}

export class YunpanStatusView extends ItemView {
  private renderVersion = 0;
  private closed = false;
  private fileEvents: EventRef[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly owner: StatusViewOwner) { super(leaf); }
  getViewType(): string { return YUNPAN_STATUS_VIEW; }
  getDisplayText(): string { return "360AI 云盘同步"; }
  getIcon(): string { return "refresh-cw"; }
  async onOpen(): Promise<void> {
    this.stopWatchingFiles();
    this.closed = false;
    const refresh = () => { if (this.owner.conflicts.length) this.render(); };
    this.fileEvents = [
      this.app.vault.on("create", refresh),
      this.app.vault.on("delete", refresh),
      this.app.vault.on("rename", refresh),
    ];
    this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.renderVersion++;
    this.stopWatchingFiles();
  }

  private stopWatchingFiles(): void {
    for (const event of this.fileEvents) this.app.vault.offref(event);
    this.fileEvents = [];
  }

  render(): void {
    if (this.closed) return;
    const version = ++this.renderVersion;
    const container = this.contentEl;
    container.empty();
    container.addClass("yunpan-sync-side-view");
    const heading = container.createDiv({ cls: "yunpan-sync-side-heading" });
    heading.createEl("h3", { text: "360AI 云盘同步" });
    const open = heading.createEl("button", { attr: { "aria-label": "查看同步详情" } });
    setIcon(open, "list"); open.addEventListener("click", () => this.owner.showSyncProgress());

    const status = this.owner.currentStatus;
    container.createDiv({ text: status.message, cls: `yunpan-sync-side-state is-${status.phase}` });
    const summary = summarizeTransfers(this.owner.transferProgress);
    const metrics = container.createDiv({ cls: "yunpan-sync-side-metrics" });
    for (const [label, value] of [["待同步", status.queued], ["成功", summary.completedCount],
      ["失败", status.failed], ["冲突", this.owner.conflicts.length]] as const) {
      const metric = metrics.createDiv(); metric.createSpan({ text: String(value) });
      metric.createEl("small", { text: label });
    }
    if (status.lastSuccess) container.createDiv({ text: `最近同步 ${new Date(status.lastSuccess).toLocaleString()}`,
      cls: "setting-item-description" });
    if (status.lastError) container.createDiv({ text: classifySyncError(status.lastError).detail,
      cls: "yunpan-sync-profile-error" });

    const action = sideStatusAction(this.owner.isPaused, status.phase);
    new Setting(container).addButton((button) => button.setButtonText("立即同步").setCta()
      .onClick(() => void this.owner.syncNow()))
      .addButton((button) => button.setButtonText(action.label).onClick(() => {
        if (action.kind === "resume") void this.owner.setPaused(false);
        else if (action.kind === "pause") void this.owner.setPaused(true);
        else if (status.failed > 0) void this.owner.retryFailed();
        else void this.owner.syncNow();
      }));

    if (this.owner.transferProgress.length) {
      container.createEl("h4", { text: "文件进度" });
      for (const transfer of this.owner.transferProgress) {
        const row = container.createDiv({ cls: `yunpan-sync-side-transfer is-${transfer.state}` });
        row.createDiv({ text: transfer.path, cls: "yunpan-sync-transfer-path" });
        const percent = transfer.state === "completed" ? 100
          : transfer.totalBytes ? Math.round(transfer.completedBytes / transfer.totalBytes * 100) : 0;
        row.createDiv({ text: `${formatBytes(transfer.completedBytes)} / ${formatBytes(transfer.totalBytes)} · ${percent}%`,
          cls: "setting-item-description" });
        if (transfer.error) row.createDiv({ text: classifySyncError(transfer.error).detail,
          cls: "yunpan-sync-profile-error" });
        if (transfer.state === "failed") {
          const actions = row.createDiv({ cls: "yunpan-sync-side-failure-actions" });
          const retry = actions.createEl("button", { text: "重试此文件" });
          retry.disabled = this.owner.isSyncing;
          retry.addEventListener("click", () => void this.owner.retryTask(transfer.id));
          const remove = actions.createEl("button", { text: "删除记录" });
          remove.disabled = this.owner.isSyncing;
          remove.addEventListener("click", () => void this.owner.removeFailedTask(transfer.id));
        }
      }
    }

    if (this.owner.failedTasks.length) {
      container.createEl("h4", { text: "失败文件" });
      for (const task of this.owner.failedTasks) {
        const presentation = failedTaskPresentation(task);
        const row = container.createDiv({ cls: `yunpan-sync-side-failure is-${task.state}` });
        row.createDiv({ text: presentation.action, cls: "yunpan-sync-transfer-path" });
        row.createDiv({ text: presentation.path });
        row.createDiv({ text: presentation.detail, cls: "yunpan-sync-profile-error" });
        const actions = row.createDiv({ cls: "yunpan-sync-side-failure-actions" });
        const retry = actions.createEl("button", { text: "重试此文件" });
        retry.disabled = this.owner.isSyncing;
        retry.addEventListener("click", () => void this.owner.retryTask(presentation.retryTaskId));
        const remove = actions.createEl("button", { text: "删除记录" });
        remove.disabled = this.owner.isSyncing;
        remove.addEventListener("click", () => void this.owner.removeFailedTask(presentation.retryTaskId));
      }
    }
    if (status.fileFailures?.length) {
      if (!this.owner.failedTasks.length) container.createEl("h4", { text: "失败文件" });
      for (const failure of status.fileFailures) {
        const row = container.createDiv({ cls: "yunpan-sync-side-failure is-failed" });
        row.createDiv({ text: "扫描", cls: "yunpan-sync-transfer-path" });
        row.createDiv({ text: failure.path });
        row.createDiv({ text: classifySyncError(failure.error).detail, cls: "yunpan-sync-profile-error" });
      }
    }

    if (this.owner.conflicts.length) {
      container.createEl("h4", { text: "待处理冲突" });
      for (const conflict of this.owner.conflicts) {
        const row = container.createDiv({ cls: "yunpan-sync-conflict" });
        row.createDiv({ text: conflict.originalPath });
        row.createDiv({ text: `已保留副本：${conflict.conflictPath}`, cls: "setting-item-description" });
        const actions = row.createDiv({ cls: "yunpan-sync-conflict-actions" });
        void this.renderOriginalAction(actions, conflict.originalPath, version);
        actions.createEl("button", { text: "打开冲突副本" })
          .addEventListener("click", () => void this.owner.openVaultPath(conflict.conflictPath));
        actions.createEl("button", { text: "标记已处理" })
          .addEventListener("click", () => void this.owner.resolveConflict(conflict.id));
      }
    }
  }

  private async renderOriginalAction(actions: HTMLElement, path: string, version: number): Promise<void> {
    try {
      if (!await this.owner.hasVaultFile(path)) return;
      if (this.closed || version !== this.renderVersion || !this.contentEl.contains(actions)) return;
      const button = actions.createEl("button", { text: "打开原文件" });
      button.addEventListener("click", () => void this.owner.openVaultPath(path));
      actions.prepend(button);
    } catch {
      // An unavailable local file must not expose an action that could create a new note.
    }
  }
}
