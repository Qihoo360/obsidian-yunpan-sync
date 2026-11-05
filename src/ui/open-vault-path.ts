import { Modal, Notice, type App } from "obsidian";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

function relativeFilePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  // Only vault-relative segments; never pass absolute paths or traversal to the adapter.
  if (/[\x00-\x1f:]/.test(normalized) || parts.some(part => !part || part === "." || part === "..")) return;
  return normalized;
}

export async function openVaultPath(app: App, path: string): Promise<void> {
  const normalized = relativeFilePath(path);
  if (!normalized) {
    new Notice("无法打开文件：路径必须是笔记库内的相对文件路径");
    return;
  }
  try {
    const file = app.vault.getFileByPath(normalized);
    if (file) await app.workspace.getLeaf(false).openFile(file);
    else new ReadonlyFilePreviewModal(app, normalized).open();
  } catch {
    new Notice("无法打开文件，请检查文件是否存在及访问权限");
  }
}

class ReadonlyFilePreviewModal extends Modal {
  private generation = 0;

  constructor(app: App, private readonly path: string) { super(app); }

  onOpen(): void {
    const generation = ++this.generation;
    this.modalEl.addClass("yunpan-sync-file-preview");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "文件只读预览" });
    this.contentEl.createDiv({ text: this.path, cls: "yunpan-sync-file-preview-path" });
    const status = this.contentEl.createDiv({ text: "正在读取文件…", cls: "yunpan-sync-file-preview-status",
      attr: { role: "status", "aria-live": "polite" } });
    const content = this.contentEl.createEl("pre", { cls: "yunpan-sync-file-preview-text",
      attr: { tabindex: "0", "aria-label": "文件原始内容（只读）" } });
    const footer = this.contentEl.createDiv({ cls: "yunpan-sync-file-preview-footer" });
    footer.createEl("button", { text: "关闭" }).addEventListener("click", () => this.close());
    void this.loadContent(status, content, generation);
  }

  onClose(): void {
    this.generation++;
    this.contentEl.empty();
  }

  private async loadContent(status: HTMLElement, content: HTMLElement, generation: number): Promise<void> {
    const current = () => generation === this.generation;
    const message = (text: string) => { if (current()) status.setText(text); };
    try {
      const stat = await this.app.vault.adapter.stat(this.path);
      if (!current()) return;
      if (!stat) { message("文件不存在"); return; }
      if (stat.type !== "file") { message("该路径是文件夹，无法预览"); return; }
      if (stat.size > MAX_PREVIEW_BYTES) { message("不支持预览：文件超过 2 MiB"); return; }
      const bytes = await this.app.vault.adapter.readBinary(this.path);
      if (!current()) return;
      if (bytes.byteLength > MAX_PREVIEW_BYTES) { message("不支持预览：文件超过 2 MiB"); return; }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        message("不支持预览：仅支持 UTF-8 文本文件");
        return;
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
        message("不支持预览：仅支持 UTF-8 文本文件");
        return;
      }
      // Treat all contents as text, including Markdown and HTML; never render markup.
      content.setText(text);
      message("只读预览，不会修改原文件");
    } catch {
      message("无法读取文件，请检查文件是否存在及访问权限");
    }
  }
}
