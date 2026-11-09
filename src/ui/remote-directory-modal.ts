import { Modal, Notice, setIcon, type App } from "obsidian";

import { normalizeRemoteRoot, validateWindowsPathSegment } from "../domain/paths.js";
import type { OpenApiMethod } from "../net/openapi-client.js";
import { loadRemoteDirectories, type RemoteDirectory } from "./remote-directory.js";
import { trackModalViewport } from "./modal-viewport.js";

interface DirectoryApi {
  call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T>;
}

export class RemoteDirectoryModal extends Modal {
  private currentPath = "/";
  private directories: RemoteDirectory[] = [];
  private loading = false;
  private loadError = "";
  private newFolderOpen = false;
  private folderName = "";
  private createError = "";
  private creating = false;
  private opened = false;
  private session = 0;
  private stopViewport?: () => void;
  private resolve?: (path: string | undefined) => void;

  constructor(app: App, private readonly api: DirectoryApi) { super(app); }

  choose(): Promise<string | undefined> {
    return new Promise((resolve) => { this.resolve = resolve; this.open(); });
  }

  onOpen(): void {
    this.opened = true;
    this.session++;
    this.currentPath = "/";
    this.newFolderOpen = false;
    this.loading = false;
    this.creating = false;
    this.folderName = "";
    this.modalEl.addClass("yunpan-sync-directory-modal");
    this.stopViewport = trackModalViewport(this.modalEl);
    void this.load();
  }

  onClose(): void {
    this.opened = false;
    this.session++;
    this.stopViewport?.();
    this.stopViewport = undefined;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(undefined);
  }

  private async load(): Promise<void> {
    if (this.loading || !this.opened) return;
    const session = this.session;
    this.loading = true;
    this.loadError = "";
    this.directories = [];
    this.render();
    try {
      const directories = await loadRemoteDirectories(this.api.call.bind(this.api), this.currentPath);
      if (!this.opened || session !== this.session) return;
      this.directories = directories;
    } catch (error) {
      if (!this.opened || session !== this.session) return;
      this.loadError = `加载云端目录失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (this.opened && session === this.session) {
        this.loading = false;
        this.render();
      }
    }
  }

  private async createFolder(): Promise<void> {
    if (this.creating || !this.newFolderOpen || !this.opened) return;
    const name = this.folderName.trim();
    try {
      if (!name || /[\\/]/.test(name) || name === "." || name === "..") throw new Error("请输入有效的文件夹名称");
      validateWindowsPathSegment(name);
    } catch (error) {
      this.createError = error instanceof Error ? error.message : String(error);
      this.render(true);
      return;
    }
    const session = this.session;
    this.creating = true;
    this.createError = "";
    this.render();
    try {
      await this.api.call("File.mkdir", { fname: `${this.currentPath}${name}/` });
      if (!this.opened || session !== this.session) return;
      this.newFolderOpen = false;
      this.creating = false;
      this.folderName = "";
      await this.load();
    } catch (error) {
      if (!this.opened || session !== this.session) return;
      this.creating = false;
      this.createError = `新建云端文件夹失败：${error instanceof Error ? error.message : String(error)}`;
      this.render(true);
    }
  }

  private render(focusName = false): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "选择云端文件夹" });
    const listHeader = contentEl.createDiv({ cls: "yunpan-sync-directory-list-header" });
    listHeader.createSpan({ text: this.loading ? "正在读取文件夹" : `${this.directories.length} 个文件夹` });
    const list = contentEl.createDiv({ cls: "yunpan-sync-directory-list" });

    if (this.newFolderOpen) this.renderNewFolder(list, focusName);
    if (this.loading) list.createDiv({ text: "正在加载...", cls: "setting-item-description" });
    else if (this.loadError) {
      const error = list.createDiv({ cls: "yunpan-sync-directory-load-error", attr: { role: "alert" } });
      error.createDiv({ text: this.loadError, cls: "yunpan-sync-editor-error" });
      error.createEl("button", { text: "重试" }).addEventListener("click", () => void this.load());
    } else {
      const tree = list.createDiv({ attr: { role: "tree", "aria-label": "当前目录下的文件夹" } });
      if (this.directories.length === 0) tree.createDiv({ text: "当前目录没有子文件夹", cls: "setting-item-description" });
      for (const directory of this.directories) {
        const row = tree.createEl("button", {
          cls: "yunpan-sync-directory-row",
          attr: { role: "treeitem", "aria-label": `打开文件夹 ${directory.name}` },
        });
        row.disabled = this.newFolderOpen;
        const icon = row.createSpan(); setIcon(icon, "folder");
        row.createSpan({ text: directory.name, cls: "yunpan-sync-directory-name" });
        const disclosure = row.createSpan({ cls: "yunpan-sync-directory-disclosure" });
        setIcon(disclosure, "chevron-right");
        row.addEventListener("click", () => {
          if (this.loading || this.newFolderOpen || !this.opened) return;
          try {
            this.currentPath = normalizeRemoteRoot(`${this.currentPath}${directory.name}`);
            void this.load();
          } catch (error) {
            new Notice(`无法打开该云端文件夹：${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
    }

    contentEl.createDiv({ text: `当前路径：${this.currentPath}`, cls: "yunpan-sync-directory-path",
      attr: { "aria-live": "polite" } });
    const footer = contentEl.createDiv({ cls: "yunpan-sync-modal-footer yunpan-sync-directory-footer" });
    const navigation = footer.createDiv({ cls: "yunpan-sync-directory-navigation" });
    const up = navigation.createEl("button", { text: "返回上一层" });
    up.disabled = this.currentPath === "/" || this.loading || this.newFolderOpen;
    up.addEventListener("click", () => {
      if (up.disabled || this.loading || this.newFolderOpen || !this.opened) return;
      const parts = this.currentPath.split("/").filter(Boolean); parts.pop();
      this.currentPath = parts.length ? `/${parts.join("/")}/` : "/";
      void this.load();
    });
    const create = navigation.createEl("button", { text: "新建文件夹" });
    create.disabled = this.loading || !!this.loadError || this.newFolderOpen;
    create.addEventListener("click", () => {
      if (create.disabled || !this.opened) return;
      this.newFolderOpen = true;
      this.folderName = "";
      this.createError = "";
      this.render(true);
    });
    const selection = footer.createDiv({ cls: "yunpan-sync-directory-selection" });
    selection.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(undefined));
    const choose = selection.createEl("button", { text: "确定", cls: "mod-cta" });
    choose.disabled = this.currentPath === "/" || this.loading || !!this.loadError || this.newFolderOpen;
    choose.addEventListener("click", () => { if (!choose.disabled) this.finish(this.currentPath); });
  }

  private renderNewFolder(list: HTMLElement, focusName: boolean): void {
    const editor = list.createDiv({ cls: "yunpan-sync-directory-create" });
    const row = editor.createDiv({ cls: "yunpan-sync-directory-create-row" });
    setIcon(row.createSpan(), "folder");
    const input = row.createEl("input", { type: "text", placeholder: "文件夹名称",
      attr: { "aria-label": "新文件夹名称" } });
    input.value = this.folderName;
    input.disabled = this.creating;
    input.addEventListener("input", () => { this.folderName = input.value; });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void this.createFolder(); }
    });
    const confirm = row.createEl("button", { text: this.creating ? "创建中…" : "确定", cls: "mod-cta" });
    confirm.disabled = this.creating;
    confirm.addEventListener("click", () => void this.createFolder());
    const cancel = row.createEl("button", { text: "取消" });
    cancel.disabled = this.creating;
    cancel.addEventListener("click", () => {
      if (this.creating) return;
      this.newFolderOpen = false;
      this.folderName = "";
      this.createError = "";
      this.render();
    });
    editor.createDiv({ text: this.createError, cls: "yunpan-sync-editor-error", attr: { role: "alert" } });
    if (focusName) input.focus({ preventScroll: true });
  }

  private finish(path: string | undefined): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    this.close();
    resolve?.(path);
  }
}
