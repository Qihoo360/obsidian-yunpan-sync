import { setIcon } from "obsidian";
import { formatBytes } from "../account/profile.js";
import { transferPresentation, type FileTransferProgress } from "../sync/progress.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { pageItems } from "./list-page.js";
import { renderIgnoreFileAction } from "./failed-record-action.js";

export interface TransferListOwner {
  isSyncing: boolean;
  retryTask(id: string): Promise<void>;
  removeFailedTask(id: string): Promise<void>;
  ignoreTask(id: string): Promise<void>;
}

interface TransferListView {
  section: HTMLElement;
  toggle?: HTMLButtonElement;
  pager: HTMLElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  label: HTMLElement;
  rows: HTMLElement;
  pages: number;
  refresh: () => void;
}

/** View state survives progress refreshes; the two lists have independent pages. */
export class TransferList {
  private pendingPage = 0;
  private completedPage = 0;
  private expanded = false;
  private readonly views = new Map<boolean, TransferListView>();

  resetPages(): void { this.pendingPage = 0; this.completedPage = 0; }

  render(container: HTMLElement, items: readonly FileTransferProgress[], completed: boolean,
    owner: TransferListOwner, refresh: () => void, prefix: "modal" | "side"): void {
    const page = pageItems(items, completed ? this.completedPage : this.pendingPage);
    if (completed) this.completedPage = page.page; else this.pendingPage = page.page;
    let view = this.views.get(completed);
    if (!view || !container.contains(view.section)) {
      if (!items.length) return;
      view = this.createView(container, completed, prefix, refresh);
      this.views.set(completed, view);
    }
    view.pages = page.pages;
    view.refresh = refresh;
    view.section.hidden = items.length === 0;
    view.previous.disabled = page.page === 0;
    view.next.disabled = page.page + 1 === page.pages;
    view.label.setText(`${page.page + 1} / ${page.pages}`);
    view.pager.hidden = page.pages <= 1 || (completed && !this.expanded);
    if (view.toggle) {
      view.toggle.setText(`已完成 ${items.length}`);
      view.toggle.setAttr("aria-expanded", String(this.expanded));
    }
    // Progress updates replace rows only, never the controls receiving a click.
    view.rows.empty();
    view.rows.hidden = completed && !this.expanded;
    if (completed && !this.expanded) return;
    for (const transfer of page.items) {
      const presentation = transferPresentation(transfer);
      const row = view.rows.createDiv({ cls: `yunpan-sync-file-row yunpan-sync-${prefix}-transfer is-${transfer.state}` });
      const heading = row.createDiv({ cls: "yunpan-sync-file-heading" });
      const icon = heading.createSpan({ cls: "yunpan-sync-file-state-icon" });
      setIcon(icon, presentation.icon);
      heading.createSpan({ text: transfer.direction === "upload" ? "上传" : "下载", cls: "yunpan-sync-file-direction" });
      heading.createSpan({ text: transfer.path, cls: "yunpan-sync-transfer-path" });
      const detail = row.createDiv({ cls: "yunpan-sync-file-detail" });
      detail.createSpan({ text: `${presentation.label} ${presentation.percent}%`, cls: "yunpan-sync-file-state" });
      detail.createSpan({ text: `${formatBytes(transfer.completedBytes)} / ${formatBytes(transfer.totalBytes)}` });
      const track = row.createDiv({ cls: "yunpan-sync-file-track", attr: { role: "progressbar", "aria-valuemin": "0",
        "aria-valuemax": "100", "aria-valuenow": String(presentation.percent), "aria-label": `${transfer.path} ${presentation.label}` } });
      track.createDiv({ cls: "yunpan-sync-file-fill" }).style.width = `${presentation.percent}%`;
      if (transfer.error) row.createDiv({ text: classifySyncError(transfer.error).detail, cls: "yunpan-sync-profile-error" });
      if (transfer.state === "failed") {
        const actions = row.createDiv({ cls: `yunpan-sync-${prefix}-failure-actions` });
        const retry = actions.createEl("button", { text: "重试此文件", attr: { "aria-label": `重试 ${transfer.path}` } });
        retry.disabled = owner.isSyncing;
        retry.addEventListener("click", () => void owner.retryTask(transfer.id));
        const remove = actions.createEl("button", { text: "删除记录",
          attr: { title: "仅清除失败记录，下次同步仍会重新检测此文件" } });
        remove.disabled = owner.isSyncing;
        remove.addEventListener("click", () => void owner.removeFailedTask(transfer.id));
        renderIgnoreFileAction(actions, transfer.id, owner);
      }
    }
  }

  private createView(container: HTMLElement, completed: boolean, prefix: "modal" | "side",
    refresh: () => void): TransferListView {
    const section = container.createDiv({ cls: `yunpan-sync-${prefix}-transfer-list${completed ? " is-completed-history" : ""}` });
    const toggle = completed ? section.createEl("button", { cls: "yunpan-sync-completed-toggle yunpan-sync-collapsible-title" }) : undefined;
    if (!completed) section.createEl("h4", { text: "文件进度" });
    const pager = section.createDiv({ cls: "yunpan-sync-pagination" });
    const previous = pager.createEl("button", { text: "上一页" });
    const label = pager.createSpan();
    const next = pager.createEl("button", { text: "下一页" });
    const view: TransferListView = { section, toggle, pager, previous, next, label,
      rows: section.createDiv(), pages: 1, refresh };
    const changePage = (delta: number) => {
      const current = completed ? this.completedPage : this.pendingPage;
      const target = Math.max(0, Math.min(current + delta, view.pages - 1));
      if (target === current) return;
      if (completed) this.completedPage = target; else this.pendingPage = target;
      view.refresh();
    };
    previous.addEventListener("click", () => changePage(-1));
    next.addEventListener("click", () => changePage(1));
    toggle?.addEventListener("click", () => { this.expanded = !this.expanded; view.refresh(); });
    return view;
  }
}
