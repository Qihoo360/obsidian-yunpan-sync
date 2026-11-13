import type { SkippedFile, SkippedFileSource } from "../sync/file-policy.js";
import { formatBytes } from "../account/profile.js";
import { pageItems, renderPager } from "./list-page.js";
import { formatDisplayPath, pathDisplayAttributes } from "./path-display.js";

export class SkippedFilesList {
  private page = 0;
  private query = "";
  private open = false;
  private sourceLabel(source: SkippedFileSource): string {
    return source === "local" ? "本地" : source === "remote" ? "云端" : "本地和云端";
  }
  render(container: HTMLElement, files: readonly SkippedFile[] = [], query = "", refresh: () => void): void {
    if (query !== this.query) { this.query = query; this.page = 0; }
    const matches = query ? files.filter(file => [file.path, file.reason, this.sourceLabel(file.source)].some(value => value.toLowerCase().includes(query.toLowerCase()))) : files;
    if (!matches.length) return;
    const section = container.createEl("details", { cls: "yunpan-sync-skipped-files" });
    section.open = this.open;
    section.addEventListener("toggle", () => { this.open = section.open; });
    section.createEl("summary", { text: `已跳过 ${matches.length} 项（保留原文件）`, cls: "yunpan-sync-collapsible-title" });
    const page = pageItems(matches, this.page);
    this.page = page.page;
    renderPager(section, page.page, page.pages, value => { this.page = value; refresh(); });
    for (const file of page.items) {
      const row = section.createDiv({ cls: "yunpan-sync-skipped-file" });
      row.createDiv({ text: `来源：${this.sourceLabel(file.source)}`, cls: "setting-item-description" });
      const path = row.createDiv({ cls: "yunpan-sync-skipped-file-path" });
      path.createSpan({ text: formatDisplayPath(file.path), attr: pathDisplayAttributes(file.path) });
      if (file.size !== undefined && Number.isSafeInteger(file.size) && file.size >= 0) {
        path.createSpan({ text: ` (${formatBytes(file.size)})`, cls: "yunpan-sync-skipped-file-size" });
      }
      row.createDiv({ text: `原因：${file.reason}`, cls: "setting-item-description" });
    }
  }
}
