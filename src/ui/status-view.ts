import { ItemView, Setting, setIcon, type EventRef, type WorkspaceLeaf } from "obsidian";
import type { SyncConflict, SyncTask } from "../storage/database.js";
import type { EngineStatus } from "../sync/engine.js";
import { groupTransfers, overallTransferProgress, type FileTransferProgress } from "../sync/progress.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { sideStatusAction } from "./status-action.js";
import { failedTaskPresentation } from "./task-presentation.js";
import { pageItems, renderPager } from "./list-page.js";
import { TransferList } from "./transfer-list.js";
import { SkippedFilesList } from "./skipped-files.js";
import { renderFailedRecordAction } from "./failed-record-action.js";

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
  resolveSyncRestriction?(): Promise<void>;
}

export class YunpanStatusView extends ItemView {
  private renderVersion = 0;
  private closed = false;
  private fileEvents: EventRef[] = [];
  private pages = new Map<string, number>();
  private readonly transferList = new TransferList();
  private readonly skippedList = new SkippedFilesList();
  private summaryEl?: HTMLElement;
  private pendingEl?: HTMLElement;
  private recordsEl?: HTMLElement;
  private historyEl?: HTMLElement;
  private searchEl?: HTMLInputElement;
  private query = "";
  private searchTimer?: ReturnType<typeof setTimeout>;

  private paged<T>(container: HTMLElement, key: string, items: readonly T[]): readonly T[] {
    const page = pageItems(items, this.pages.get(key) ?? 0);
    this.pages.set(key, page.page);
    renderPager(container, page.page, page.pages, value => { this.pages.set(key, value); this.render(); });
    return page.items;
  }

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
    if (this.searchTimer) clearTimeout(this.searchTimer);
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
    const scrollTop = this.contentEl.scrollTop;
    if (!this.summaryEl) {
      this.contentEl.empty();
      this.contentEl.addClass("yunpan-sync-side-view");
      this.summaryEl = this.contentEl.createDiv();
      this.searchEl = this.contentEl.createEl("input", { type: "search", placeholder: "按传输路径搜索...",
        attr: { "aria-label": "搜索传输文件" } });
      this.searchEl.addEventListener("input", () => {
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.query = this.searchEl!.value.trim().toLowerCase(); this.transferList.resetPages(); this.render();
        }, 150);
      });
      this.pendingEl = this.contentEl.createDiv();
      this.recordsEl = this.contentEl.createDiv();
      this.historyEl = this.contentEl.createDiv();
    }
    this.searchEl!.hidden = this.owner.transferProgress.length === 0;
    this.pendingEl!.empty(); this.recordsEl!.empty(); this.historyEl!.empty();
    let container = this.summaryEl;
    container.empty();
    const heading = container.createDiv({ cls: "yunpan-sync-side-heading" });
    heading.createEl("h3", { text: "360AI 云盘同步" });
    const open = heading.createEl("button", { attr: { "aria-label": "查看同步详情" } });
    setIcon(open, "list"); open.addEventListener("click", () => this.owner.showSyncProgress());

    const status = this.owner.currentStatus;
    const membershipExpired = status.restriction?.kind === "membership";
    if (!membershipExpired) container.createDiv({ text: status.message, cls: `yunpan-sync-side-state is-${status.phase}` });
    const { summary, percent } = overallTransferProgress(this.owner.transferProgress, status);
    const groups = groupTransfers(this.owner.transferProgress, this.query);
    if (percent !== undefined) container.createDiv({ text: `总进度 ${percent}%`, cls: "yunpan-sync-total-percent" });
    const metrics = container.createDiv({ cls: "yunpan-sync-side-metrics" });
    for (const [label, value] of [["待同步", status.queued], ["成功", summary.completedCount],
      ["失败", status.failed], ["冲突", this.owner.conflicts.length]] as const) {
      const metric = metrics.createDiv(); metric.createSpan({ text: String(value) });
      metric.createEl("small", { text: label });
    }
    if (status.lastSuccess) container.createDiv({ text: `最近同步 ${new Date(status.lastSuccess).toLocaleString()}`,
      cls: "setting-item-description" });
    const errorMessage = membershipExpired ? status.restriction?.message : status.lastError;
    if (errorMessage) {
      const error = container.createDiv({ cls: "yunpan-sync-status-error" });
      error.createSpan({ text: classifySyncError(errorMessage).detail, cls: "yunpan-sync-profile-error" });
      if (!status.restriction) renderFailedRecordAction(error, this.owner.failedTasks, this.owner);
    }
    if (status.restriction) container.createEl("button", { cls: "mod-cta",
      text: status.restriction.kind === "membership" ? "去续费" : status.restriction.kind === "capacity" ? "去扩容" : "刷新后重试" })
      .addEventListener("click", () => void this.owner.resolveSyncRestriction?.());

    const action = sideStatusAction(this.owner.isPaused, status.phase);
    new Setting(container).addButton((button) => button.setButtonText("立即同步").setCta()
      .onClick(() => void this.owner.syncNow()))
      .addButton((button) => button.setButtonText(action.label).onClick(() => {
        if (action.kind === "resume") void this.owner.setPaused(false);
        else if (action.kind === "pause") void this.owner.setPaused(true);
        else if (status.failed > 0) void this.owner.retryFailed();
        else void this.owner.syncNow();
      }));

    this.transferList.render(this.pendingEl!, groups.pending, false, this.owner, () => this.render(), "side");
    container = this.recordsEl!;

    const transferIds = new Set(this.owner.transferProgress.map(item => item.id));
    const otherFailures = this.owner.failedTasks.filter(task => !transferIds.has(task.id));
    if (otherFailures.length) {
      container.createEl("h4", { text: "失败文件" });
      for (const task of this.paged(container, "failures", otherFailures)) {
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
      if (!otherFailures.length) container.createEl("h4", { text: "失败文件" });
      for (const failure of this.paged(container, "scan", status.fileFailures)) {
        const row = container.createDiv({ cls: "yunpan-sync-side-failure is-failed" });
        row.createDiv({ text: "扫描", cls: "yunpan-sync-transfer-path" });
        row.createDiv({ text: failure.path });
        row.createDiv({ text: classifySyncError(failure.error).detail, cls: "yunpan-sync-profile-error" });
        if (failure.id) {
          const retry = row.createEl("button", { text: "重新检测" });
          retry.disabled = this.owner.isSyncing;
          retry.addEventListener("click", () => void this.owner.retryTask(failure.id!));
        }
      }
    }
    this.skippedList.render(container, status.skippedFiles, this.query, () => this.render());

    if (this.owner.conflicts.length) {
      container.createEl("h4", { text: "待处理冲突" });
      for (const conflict of this.paged(container, "conflicts", this.owner.conflicts)) {
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
    this.transferList.render(this.historyEl!, groups.completed, true, this.owner, () => this.render(), "side");
    this.contentEl.scrollTop = scrollTop;
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
