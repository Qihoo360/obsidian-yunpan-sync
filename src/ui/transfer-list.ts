import { setIcon } from "obsidian";
import { formatBytes } from "../account/profile.js";
import { transferPresentation, type FileTransferProgress } from "../sync/progress.js";
import { classifySyncError } from "../sync/error-guidance.js";
import { pageItems, renderPager } from "./list-page.js";

export interface TransferListOwner {
  isSyncing: boolean;
  retryTask(id: string): Promise<void>;
  removeFailedTask(id: string): Promise<void>;
}

/** View state survives progress refreshes; the two lists have independent pages. */
export class TransferList {
  private pendingPage = 0;
  private completedPage = 0;
  private expanded = false;

  resetPages(): void { this.pendingPage = 0; this.completedPage = 0; }

  render(container: HTMLElement, items: readonly FileTransferProgress[], completed: boolean,
    owner: TransferListOwner, refresh: () => void, prefix: "modal" | "side"): void {
    if (!items.length) return;
    const section = container.createDiv({ cls: `yunpan-sync-${prefix}-transfer-list${completed ? " is-completed-history" : ""}` });
    if (completed) {
      section.createEl("button", { text: `已完成 ${items.length}`, cls: "yunpan-sync-completed-toggle",
        attr: { "aria-expanded": String(this.expanded) } }).addEventListener("click", () => {
        this.expanded = !this.expanded; refresh();
      });
      if (!this.expanded) return;
    } else section.createEl("h4", { text: "文件进度" });
    const page = pageItems(items, completed ? this.completedPage : this.pendingPage);
    renderPager(section, page.page, page.pages, value => {
      if (completed) this.completedPage = value; else this.pendingPage = value;
      refresh();
    });
    for (const transfer of page.items) {
      const presentation = transferPresentation(transfer);
      const row = section.createDiv({ cls: `yunpan-sync-file-row yunpan-sync-${prefix}-transfer is-${transfer.state}` });
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
        const remove = actions.createEl("button", { text: "删除记录" });
        remove.disabled = owner.isSyncing;
        remove.addEventListener("click", () => void owner.removeFailedTask(transfer.id));
      }
    }
  }
}
