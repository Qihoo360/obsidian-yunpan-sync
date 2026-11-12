import { App, Modal, setIcon } from "obsidian";
import type { EngineStatus } from "../sync/engine.js";
import { groupTransfers, overallTransferProgress, type FileTransferProgress } from "../sync/progress.js";
import { formatBytes } from "../account/profile.js";
import type { SyncTask } from "../storage/database.js";
import { isSuccessfulSyncMessage, SYNC_UNCHANGED_MESSAGE } from "../sync/outcome.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { failedTaskPresentation, taskOperationLabel } from "./task-presentation.js";
import { pageItems, renderPager } from "./list-page.js";
import { TransferList } from "./transfer-list.js";
import { SkippedFilesList } from "./skipped-files.js";
import { renderIgnoreFileAction } from "./failed-record-action.js";

export interface SyncModalOwner {
  app: App;
  currentStatus: EngineStatus;
  transferProgress: readonly FileTransferProgress[];
  failedTasks: readonly SyncTask[];
  isSyncing: boolean;
  cancelSync(): void;
  resumeSync(): void;
  hideSyncProgress(modal: SyncProgressModal): void;
  retryTask(id: string): Promise<void>;
  removeFailedTask(id: string): Promise<void>;
  ignoreTask(id: string): Promise<void>;
  resolveSyncRestriction?(): Promise<void>;
}

export class SyncProgressModal extends Modal {
  private headingTitleEl?: HTMLElement;
  private iconEl?: HTMLElement;
  private bodyEl?: HTMLElement;
  private summaryEl?: HTMLElement;
  private pendingEl?: HTMLElement;
  private recordsEl?: HTMLElement;
  private historyEl?: HTMLElement;
  private footerEl?: HTMLElement;
  private stopButton?: HTMLButtonElement;
  private resumeButton?: HTMLButtonElement;
  private hideButton?: HTMLButtonElement;
  private restrictionButton?: HTMLButtonElement;
  private transitioning = false;
  private readonly transferList = new TransferList();
  private readonly skippedList = new SkippedFilesList();
  private iconName?: string;
  private failurePage = 0;
  private scanPage = 0;
  private query = "";
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly owner: SyncModalOwner) { super(owner.app); }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-modal");
    this.contentEl.empty();
    const heading = this.contentEl.createDiv({ cls: "yunpan-sync-modal-heading" });
    this.iconEl = heading.createDiv({ cls: "yunpan-sync-modal-icon" });
    this.iconName = undefined;
    this.headingTitleEl = heading.createEl("h2");
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "按传输路径搜索...",
      attr: { "aria-label": "搜索传输文件" } });
    search.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.query = search.value.trim().toLowerCase(); this.transferList.resetPages(); this.render(); }, 150);
    });
    this.bodyEl = this.contentEl.createDiv({ cls: "yunpan-sync-modal-body" });
    this.summaryEl = this.bodyEl.createDiv();
    this.pendingEl = this.bodyEl.createDiv();
    this.recordsEl = this.bodyEl.createDiv();
    this.historyEl = this.bodyEl.createDiv();
    this.footerEl = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    this.restrictionButton = this.footerEl.createEl("button", { cls: "mod-cta yunpan-sync-restriction-action" });
    this.restrictionButton.addEventListener("click", () => void this.owner.resolveSyncRestriction?.());
    this.resumeButton = this.footerEl.createEl("button", { text: "恢复同步", cls: "mod-cta" });
    this.resumeButton.addEventListener("click", () => {
      if (!this.resumeButton!.disabled && !this.resumeButton!.hidden) this.owner.resumeSync();
    });
    this.stopButton = this.footerEl.createEl("button", { text: "停止同步", cls: "mod-warning" });
    this.stopButton.addEventListener("click", () => {
      if (this.stopButton!.disabled || this.stopButton!.hidden) return;
      this.stopButton!.disabled = true;
      this.stopButton!.setText("正在停止…");
      this.owner.cancelSync();
    });
    this.hideButton = this.footerEl.createEl("button", { text: "隐藏" });
    this.hideButton.addEventListener("click", () => this.hide());
    this.render();
  }

  render(): void {
    if (!this.headingTitleEl || !this.iconEl || !this.bodyEl || !this.footerEl) return;
    const status = this.owner.currentStatus;
    const completed = status.phase === "idle" && isSuccessfulSyncMessage(status.message);
    const unchanged = completed && status.message === SYNC_UNCHANGED_MESSAGE;
    const cleared = status.phase === "idle" && status.message === "失败记录已清除，可重新同步";
    const failed = status.phase === "error" || (status.phase === "idle" && !completed && this.owner.failedTasks.length > 0);
    const stopped = status.phase === "paused";
    this.headingTitleEl.setText(completed ? status.message : failed ? "同步失败" : stopped ? "同步已停止" : status.message);
    const iconName = completed ? "circle-check" : failed ? "circle-alert" : stopped ? "circle-stop" : "refresh-cw";
    if (this.iconName !== iconName) { setIcon(this.iconEl, iconName); this.iconName = iconName; }
    this.iconEl.toggleClass("is-spinning", status.phase !== "idle" && !completed && !failed && !stopped && !cleared);
    this.iconEl.toggleClass("is-success", completed);
    this.iconEl.toggleClass("is-error", failed);
    const scrollTop = this.bodyEl.scrollTop;
    this.renderProgress(unchanged, failed, stopped, cleared);
    this.renderFooter(completed || failed || cleared, stopped);
    this.bodyEl.scrollTop = scrollTop;
  }

  hide(): void { this.close(); }
  closeForTransition(): void { this.transitioning = true; this.close(); }

  onClose(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (!this.transitioning) this.owner.hideSyncProgress(this);
  }

  private renderProgress(unchanged: boolean, failed: boolean, stopped: boolean, cleared: boolean): void {
    // Keep transfer containers mounted across every progress refresh so native
    // pointer and keyboard clicks retain their original pagination targets.
    const body = this.summaryEl!;
    body.empty();
    this.recordsEl!.empty();
    this.pendingEl!.hidden = unchanged || cleared;
    this.historyEl!.hidden = unchanged || cleared;
    if (cleared) {
      body.createDiv({ text: this.owner.currentStatus.message, cls: "yunpan-sync-modal-message" });
      return;
    }
    this.skippedList.render(body, this.owner.currentStatus.skippedFiles, this.query, () => this.render());
    if (unchanged) {
      body.createDiv({ text: "本地与云端内容一致，无需同步", cls: "yunpan-sync-modal-message is-unchanged" });
      return;
    }
    const transfers = this.owner.transferProgress;
    const { summary, percent, operationTotal, operationCompleted } = overallTransferProgress(transfers, this.owner.currentStatus);
    const groups = groupTransfers(transfers, this.query);
    if (summary.activePath) body.createDiv({ text: summary.activePath, cls: "yunpan-sync-modal-current" });
    if (operationTotal > 0) {
      const panel = body.createDiv({ cls: "yunpan-sync-modal-progress-panel" });
      const label = panel.createDiv({ cls: "yunpan-sync-total-heading" });
      label.createSpan({ text: "总进度", cls: "yunpan-sync-modal-label" });
      if (percent !== undefined) label.createSpan({ text: `${percent}%`, cls: "yunpan-sync-total-percent" });
      if (percent !== undefined) {
        const bar = panel.createDiv({ cls: "yunpan-sync-modal-progress-track", attr: { role: "progressbar",
          "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent), "aria-label": "同步总进度" } });
        bar.createDiv({ cls: "yunpan-sync-modal-progress-fill" }).style.width = `${percent}%`;
      }
      const quantity = `已完成 ${operationCompleted} / ${operationTotal} 项`;
      const bytes = summary.totalBytes > 0 ? ` · ${formatBytes(summary.completedBytes)} / ${formatBytes(summary.totalBytes)}` : "";
      panel.createDiv({ text: `${quantity}${bytes}`, cls: "yunpan-sync-total-detail" });
    } else body.createDiv({ text: this.owner.currentStatus.message, cls: "yunpan-sync-total-detail" });
    if (failed || stopped) {
      const guidance = classifySyncError(this.owner.currentStatus.lastError ?? this.owner.currentStatus.message);
      const message = body.createDiv({ cls: "yunpan-sync-modal-message is-error" });
      message.createEl("strong", { text: guidance.title });
      message.createDiv({ text: guidance.detail });
    }
    this.transferList.render(this.pendingEl!, groups.pending, false, this.owner, () => this.render(), "modal");
    const transferIds = new Set(transfers.map(item => item.id));
    const otherFailures = this.owner.failedTasks.filter(task => !transferIds.has(task.id));
    if (otherFailures.length > 0) {
      const list = this.recordsEl!.createDiv({ cls: "yunpan-sync-modal-failure-list" });
      list.createEl("h4", { text: "失败文件" });
      const page = pageItems(otherFailures, this.failurePage);
      this.failurePage = page.page;
      renderPager(list, page.page, page.pages, value => { this.failurePage = value; this.render(); });
      for (const task of page.items) {
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
        const remove = actions.createEl("button", { text: "删除记录", cls: "yunpan-sync-modal-transfer-action-button",
          attr: { title: "仅清除失败记录，下次同步仍会重新检测此文件" } });
        remove.disabled = this.owner.isSyncing;
        remove.addEventListener("click", () => void this.owner.removeFailedTask(presentation.retryTaskId));
        renderIgnoreFileAction(actions, presentation.retryTaskId, this.owner);
      }
    }
    if (this.owner.currentStatus.fileFailures?.length) {
      const list = this.recordsEl!.createDiv({ cls: "yunpan-sync-modal-failure-list" });
      if (otherFailures.length === 0) list.createEl("h4", { text: "失败文件" });
      const page = pageItems(this.owner.currentStatus.fileFailures, this.scanPage);
      this.scanPage = page.page;
      renderPager(list, page.page, page.pages, value => { this.scanPage = value; this.render(); });
      for (const failure of page.items) {
        const row = list.createDiv({ cls: "yunpan-sync-modal-failure is-failed" });
        row.createSpan({ text: "扫描", cls: "yunpan-sync-modal-transfer-action" });
        const detail = row.createDiv({ cls: "yunpan-sync-modal-transfer-detail" });
        detail.createSpan({ text: failure.path, cls: "yunpan-sync-modal-transfer-path" });
        detail.createDiv({ text: classifySyncError(failure.error).detail, cls: "setting-item-description" });
        if (failure.id) {
          const retry = row.createEl("button", { text: "重新检测" });
          retry.disabled = this.owner.isSyncing;
          retry.addEventListener("click", () => void this.owner.retryTask(failure.id!));
        }
      }
    }
    this.transferList.render(this.historyEl!, groups.completed, true, this.owner, () => this.render(), "modal");
  }

  private renderFooter(finished: boolean, stopped: boolean): void {
    // Keep the same native click targets while progress updates. Replacing a
    // button between mouse-down and mouse-up prevents the browser's click event.
    const restriction = this.owner.currentStatus.restriction;
    this.restrictionButton!.hidden = !restriction;
    if (restriction) this.restrictionButton!.setText(
      restriction.kind === "membership" ? "去续费" : restriction.kind === "capacity" ? "去扩容" : "刷新后重试");
    const stopping = this.owner.currentStatus.phase === "stopping";
    this.resumeButton!.hidden = !stopped;
    this.resumeButton!.disabled = !stopped;
    this.stopButton!.hidden = finished || stopped;
    this.stopButton!.disabled = stopping || finished;
    this.stopButton!.setText(stopping ? "正在停止…" : "停止同步");
    this.hideButton!.setText(finished || stopped ? "关闭" : "隐藏");
  }
}

export class SyncTaskPreviewModal extends Modal {
  private selected = new Set<string>();
  private resolve?: (selected: ReadonlySet<string> | undefined) => void;
  private page = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor(owner: SyncModalOwner, private readonly tasks: readonly SyncTask[], private readonly remoteRoot: string,
    private readonly initial = false) {
    super(owner.app);
    this.selected = new Set(tasks.map((task) => task.id));
  }

  choose(): Promise<ReadonlySet<string> | undefined> {
    return new Promise((resolve) => { this.resolve = resolve; this.open(); });
  }

  private countdownTimer?: ReturnType<typeof setInterval>;
  cancel(): void { this.finish(undefined); }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-modal", "yunpan-sync-task-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.initial ? "确认首次同步" : "同步任务列表" });
    if (this.initial) this.contentEl.createEl("p", {
      text: `当前笔记库将与云端 ${this.remoteRoot} 双向同步。同名文件若两端内容不同，将保留本地冲突副本，并以云端版本作为原文件。10 秒后将按当前勾选项自动开始；不想同步请点击取消。`,
      cls: "setting-item-description yunpan-sync-task-description",
    });
    const toolbar = this.contentEl.createDiv({ cls: "yunpan-sync-task-toolbar" });
    const count = toolbar.createEl("button", { text: `全部 (${this.tasks.length})`, cls: "is-active" });
    const search = toolbar.createEl("input", { type: "search", placeholder: "按路径搜索..." });
    const table = this.contentEl.createDiv({ cls: "yunpan-sync-task-table" });
    const pagination = this.contentEl.createDiv();
    const footer = this.contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    const continueButton = footer.createEl("button", { cls: "mod-cta" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(undefined));

    let remaining = this.initial ? 10 : undefined;
    const updateContinueButton = () => {
      continueButton.setText(`继续 (${this.selected.size})${remaining === undefined ? "" : ` · ${remaining}s 后自动确认`}`);
      continueButton.disabled = this.tasks.length > 0 && this.selected.size === 0;
    };

    const render = () => {
      count.setText(`全部 (${this.tasks.length})`);
      updateContinueButton();
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
      const page = pageItems(visible, this.page);
      this.page = page.page;
      pagination.empty();
      renderPager(pagination, page.page, page.pages, value => { this.page = value; render(); });
      for (const task of page.items) {
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
    search.addEventListener("input", () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { this.page = 0; render(); }, 150);
    });
    continueButton.addEventListener("click", () => this.finish(new Set(this.selected)));
    render();
    if (this.initial) this.countdownTimer = setInterval(() => {
      remaining = Math.max(0, remaining! - 1);
      updateContinueButton();
      if (remaining === 0) {
        // Empty vaults can be confirmed too. An explicitly empty selection
        // cancels the run rather than transferring any unselected files.
        this.finish(new Set(this.selected));
      }
    }, 1000);
  }

  onClose(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = undefined; }
    if (this.resolve) this.finish(undefined);
  }

  private finish(selected: ReadonlySet<string> | undefined): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    this.close();
    resolve?.(selected);
  }
}
