import { App, Modal, setIcon } from "obsidian";
import type { EngineStatus } from "../sync/engine.js";
import { summarizeTransfers, type FileTransferProgress } from "../sync/progress.js";
import type { SyncTask } from "../storage/database.js";
import { isSuccessfulSyncMessage, SYNC_UNCHANGED_MESSAGE } from "../sync/outcome.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { failedTaskPresentation, taskOperationLabel } from "./task-presentation.js";

export interface SyncModalOwner {
  app: App;
  currentStatus: EngineStatus;
  transferProgress: readonly FileTransferProgress[];
  failedTasks: readonly SyncTask[];
  isSyncing: boolean;
  cancelSync(): void;
  hideSyncProgress(modal: SyncProgressModal): void;
  retryTask(id: string): Promise<void>;
  removeFailedTask(id: string): Promise<void>;
  resolveSyncRestriction?(): Promise<void>;
}

export class SyncProgressModal extends Modal {
  private headingTitleEl?: HTMLElement;
  private iconEl?: HTMLElement;
  private bodyEl?: HTMLElement;
  private footerEl?: HTMLElement;
  private transitioning = false;

  constructor(private readonly owner: SyncModalOwner) { super(owner.app); }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-modal");
    this.contentEl.empty();
    const heading = this.contentEl.createDiv({ cls: "yunpan-sync-modal-heading" });
    this.iconEl = heading.createDiv({ cls: "yunpan-sync-modal-icon" });
    this.headingTitleEl = heading.createEl("h2");
    this.bodyEl = this.contentEl.createDiv({ cls: "yunpan-sync-modal-body" });
    this.footerEl = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    this.render();
  }

  render(): void {
    if (!this.headingTitleEl || !this.iconEl || !this.bodyEl || !this.footerEl) return;
    const status = this.owner.currentStatus;
    const completed = status.phase === "idle" && isSuccessfulSyncMessage(status.message);
    const unchanged = completed && status.message === SYNC_UNCHANGED_MESSAGE;
    const cleared = status.phase === "idle" && status.message === "失败记录已清除，可重新同步";
    const failed = status.phase === "error" || this.owner.failedTasks.length > 0;
    const stopped = status.phase === "paused";
    this.headingTitleEl.setText(completed ? status.message : failed ? "同步失败" : stopped ? "同步已停止" : status.message);
    this.iconEl.empty();
    setIcon(this.iconEl, completed ? "circle-check" : failed ? "circle-alert" : stopped ? "circle-stop" : "refresh-cw");
    this.iconEl.toggleClass("is-spinning", !completed && !failed && !stopped && !cleared);
    this.iconEl.toggleClass("is-success", completed);
    this.iconEl.toggleClass("is-error", failed);
    this.renderProgress(completed, unchanged, failed, stopped);
    if (cleared) {
      this.bodyEl.empty();
      this.bodyEl.createDiv({ text: status.message, cls: "yunpan-sync-modal-message" });
    }
    this.renderFooter(completed || failed || stopped || cleared);
  }

  hide(): void { this.close(); }
  closeForTransition(): void { this.transitioning = true; this.close(); }

  onClose(): void {
    if (!this.transitioning) this.owner.hideSyncProgress(this);
  }

  private renderProgress(completed: boolean, unchanged: boolean, failed: boolean, stopped: boolean): void {
    const body = this.bodyEl!;
    body.empty();
    if (unchanged) {
      body.createDiv({ text: "本地与云端内容一致，无需同步", cls: "yunpan-sync-modal-message is-unchanged" });
      return;
    }
    const transfers = this.owner.transferProgress;
    const summary = summarizeTransfers(transfers);
    if (summary.activePath) body.createDiv({ text: summary.activePath, cls: "yunpan-sync-modal-current" });
    const panel = body.createDiv({ cls: "yunpan-sync-modal-progress-panel" });
    panel.createDiv({ text: "同步进度", cls: "yunpan-sync-modal-label" });
    const bar = panel.createDiv({ cls: "yunpan-sync-modal-progress-track" });
    const fill = bar.createDiv({ cls: "yunpan-sync-modal-progress-fill" });
    fill.style.width = `${completed ? 100 : summary.percent}%`;
    if (transfers.length > 0) fill.createSpan({ text: `${completed ? 100 : summary.percent}%` });
    if (failed || stopped) {
      const guidance = classifySyncError(this.owner.currentStatus.lastError ?? this.owner.currentStatus.message);
      const message = body.createDiv({ cls: "yunpan-sync-modal-message is-error" });
      message.createEl("strong", { text: guidance.title });
      message.createDiv({ text: guidance.detail });
    }
    if (transfers.length > 0) {
      const list = body.createDiv({ cls: "yunpan-sync-modal-transfer-list" });
      for (const transfer of transfers) {
        const row = list.createDiv({ cls: `yunpan-sync-modal-transfer is-${transfer.state}` });
        const icon = row.createSpan({ cls: "yunpan-sync-modal-transfer-icon" });
        setIcon(icon, transfer.direction === "upload" ? "list-plus" : "list-minus");
        row.createSpan({ text: transfer.direction === "upload" ? "上传" : "下载", cls: "yunpan-sync-modal-transfer-action" });
        const detail = row.createDiv({ cls: "yunpan-sync-modal-transfer-detail" });
        detail.createSpan({ text: transfer.path, cls: "yunpan-sync-modal-transfer-path" });
        const percent = transfer.state === "completed" ? 100 : transfer.totalBytes > 0
          ? Math.min(100, Math.round(transfer.completedBytes / transfer.totalBytes * 100)) : 0;
        const progress = detail.createEl("progress", { cls: "yunpan-sync-transfer-progress",
          attr: { max: "100", value: String(percent), "aria-label": `${transfer.path} ${percent}%` } });
        progress.value = percent;
        if (transfer.state === "failed") {
          const actions = row.createDiv({ cls: "yunpan-sync-modal-failure-actions" });
          const retry = actions.createEl("button", { text: "重试此文件", cls: "yunpan-sync-modal-transfer-action-button",
            attr: { "aria-label": `重试 ${transfer.path}` } });
          retry.disabled = this.owner.isSyncing;
          const remove = actions.createEl("button", { text: "删除记录", cls: "yunpan-sync-modal-transfer-action-button" });
          remove.disabled = this.owner.isSyncing;
          remove.addEventListener("click", () => void this.owner.removeFailedTask(transfer.id));
          retry.addEventListener("click", () => void this.owner.retryTask(transfer.id));
        }
      }
    }
    if (this.owner.failedTasks.length > 0) {
      const list = body.createDiv({ cls: "yunpan-sync-modal-failure-list" });
      list.createEl("h4", { text: "失败文件" });
      for (const task of this.owner.failedTasks) {
        const presentation = failedTaskPresentation(task);
        const row = list.createDiv({ cls: `yunpan-sync-modal-failure is-${task.state}` });
        row.createSpan({ text: presentation.action, cls: "yunpan-sync-modal-transfer-action" });
        const detail = row.createDiv({ cls: "yunpan-sync-modal-transfer-detail" });
        detail.createSpan({ text: presentation.path, cls: "yunpan-sync-modal-transfer-path" });
        detail.createDiv({ text: presentation.detail,
          cls: "setting-item-description" });
        const actions = row.createDiv({ cls: "yunpan-sync-modal-failure-actions" });
        const retry = actions.createEl("button", { text: "重试此文件", cls: "yunpan-sync-modal-transfer-action-button" });
        retry.disabled = this.owner.isSyncing;
        retry.addEventListener("click", () => void this.owner.retryTask(presentation.retryTaskId));
        const remove = actions.createEl("button", { text: "删除记录", cls: "yunpan-sync-modal-transfer-action-button" });
        remove.disabled = this.owner.isSyncing;
        remove.addEventListener("click", () => void this.owner.removeFailedTask(presentation.retryTaskId));
      }
    }
    if (this.owner.currentStatus.fileFailures?.length) {
      const list = body.createDiv({ cls: "yunpan-sync-modal-failure-list" });
      if (this.owner.failedTasks.length === 0) list.createEl("h4", { text: "失败文件" });
      for (const failure of this.owner.currentStatus.fileFailures) {
        const row = list.createDiv({ cls: "yunpan-sync-modal-failure is-failed" });
        row.createSpan({ text: "扫描", cls: "yunpan-sync-modal-transfer-action" });
        const detail = row.createDiv({ cls: "yunpan-sync-modal-transfer-detail" });
        detail.createSpan({ text: failure.path, cls: "yunpan-sync-modal-transfer-path" });
        detail.createDiv({ text: classifySyncError(failure.error).detail, cls: "setting-item-description" });
      }
    }
  }

  private renderFooter(finished: boolean): void {
    const footer = this.footerEl!;
    footer.empty();
    const restriction = this.owner.currentStatus.restriction;
    if (restriction) footer.createEl("button", { cls: "mod-cta",
      text: restriction.kind === "membership" ? "去续费" : restriction.kind === "capacity" ? "去扩容" : "刷新后重试" })
      .addEventListener("click", () => void this.owner.resolveSyncRestriction?.());
    if (!finished) footer.createEl("button", { text: "停止同步", cls: "mod-warning" })
      .addEventListener("click", () => this.owner.cancelSync());
    footer.createEl("button", { text: finished ? "关闭" : "隐藏" })
      .addEventListener("click", () => this.hide());
  }
}

export class SyncTaskPreviewModal extends Modal {
  private selected = new Set<string>();
  private resolve?: (selected: ReadonlySet<string> | undefined) => void;

  constructor(owner: SyncModalOwner, private readonly tasks: readonly SyncTask[], private readonly remoteRoot: string,
    private readonly initial = false) {
    super(owner.app);
    this.selected = new Set(tasks.map((task) => task.id));
  }

  choose(): Promise<ReadonlySet<string> | undefined> {
    this.open();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-modal", "yunpan-sync-task-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.initial ? "确认首次同步" : "同步任务列表" });
    if (this.initial) this.contentEl.createEl("p", {
      text: `当前笔记库将与云端 ${this.remoteRoot} 双向同步。同名文件若两端内容不同，将保留本地冲突副本，并以云端版本作为原文件。请确认以下操作后开始。`,
      cls: "setting-item-description yunpan-sync-task-description",
    });
    const toolbar = this.contentEl.createDiv({ cls: "yunpan-sync-task-toolbar" });
    const count = toolbar.createEl("button", { text: `全部 (${this.tasks.length})`, cls: "is-active" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "按路径搜索..." });
    const table = this.contentEl.createDiv({ cls: "yunpan-sync-task-table" });
    const footer = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    const continueButton = footer.createEl("button", { cls: "mod-cta" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(undefined));

    const render = () => {
      count.setText(`全部 (${this.tasks.length})`);
      continueButton.setText(`继续 (${this.selected.size})`);
      continueButton.disabled = this.tasks.length > 0 && this.selected.size === 0;
      table.empty();
      const query = search.value.trim().toLocaleLowerCase("zh-CN");
      const visible = this.tasks.filter((item) => !query || item.path.toLocaleLowerCase("zh-CN").includes(query));
      const header = table.createDiv({ cls: "yunpan-sync-task-row yunpan-sync-task-header" });
      const selectAll = header.createEl("input", { type: "checkbox" });
      const selectedVisible = visible.filter((task) => this.selected.has(task.id)).length;
      selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
      selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
      selectAll.addEventListener("change", () => {
        for (const task of visible) selectAll.checked ? this.selected.add(task.id) : this.selected.delete(task.id);
        render();
      });
      header.createSpan({ text: "操作" });
      header.createSpan({ text: "本地路径" });
      header.createSpan({ text: "远程路径" });
      for (const task of visible) {
        const row = table.createDiv({ cls: "yunpan-sync-task-row" });
        const checkbox = row.createEl("input", { type: "checkbox" });
        checkbox.checked = this.selected.has(task.id);
        checkbox.addEventListener("change", () => { checkbox.checked ? this.selected.add(task.id) : this.selected.delete(task.id); render(); });
        const conflict = Boolean((task.payload as { conflict?: boolean }).conflict);
        const destination = (task.payload as { destination?: unknown }).destination;
        const remotePath = task.kind === "local-rename" && typeof destination === "string" ? destination : task.path;
        row.createSpan({ text: conflict ? "保留冲突副本" : taskOperationLabel(task.kind), cls: "yunpan-sync-task-action" });
        row.createSpan({ text: task.path, cls: "yunpan-sync-task-path" });
        row.createSpan({ text: `${this.remoteRoot.replace(/\/$/, "")}/${remotePath}`, cls: "yunpan-sync-task-remote" });
      }
    };
    search.addEventListener("input", render);
    continueButton.addEventListener("click", () => this.finish(new Set(this.selected)));
    render();
  }

  onClose(): void {
    if (this.resolve) this.finish(undefined);
  }

  private finish(selected: ReadonlySet<string> | undefined): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    this.close();
    resolve?.(selected);
  }
}
