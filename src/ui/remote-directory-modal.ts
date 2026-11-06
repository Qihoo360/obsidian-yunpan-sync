import { Modal, Notice, Setting, setIcon, type App } from "obsidian";

import { normalizeRemoteRoot, validateWindowsPathSegment } from "../domain/paths.js";
import type { OpenApiMethod } from "../net/openapi-client.js";
import { loadRemoteDirectories, type RemoteDirectory } from "./remote-directory.js";

interface DirectoryApi {
  call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T>;
}

export class RemoteDirectoryModal extends Modal {
  private currentPath = "/";
  private directories: RemoteDirectory[] = [];
  private loading = false;
  private resolve?: (path: string | undefined) => void;

  constructor(app: App, private readonly api: DirectoryApi, initialPath: string) {
    super(app);
    this.currentPath = normalizeRemoteRoot(initialPath);
  }

  choose(): Promise<string | undefined> {
    this.open();
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  onOpen(): void {
    this.modalEl.addClass("yunpan-sync-directory-modal");
    void this.load();
  }

  onClose(): void {
    if (this.resolve) this.finish(undefined);
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.render();
    try {
      this.directories = await loadRemoteDirectories(this.api.call.bind(this.api), this.currentPath);
    } catch (error) {
      new Notice(`加载云端目录失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "选择云端文件夹" });
    const breadcrumb = contentEl.createDiv({ cls: "yunpan-sync-directory-breadcrumb" });
    const up = breadcrumb.createEl("button", { attr: { "aria-label": "返回上一级" } });
    setIcon(up, "arrow-up");
    up.disabled = this.currentPath === "/" || this.loading;
    up.addEventListener("click", () => {
      const parts = this.currentPath.split("/").filter(Boolean); parts.pop();
      this.currentPath = parts.length ? `/${parts.join("/")}/` : "/";
      void this.load();
    });
    breadcrumb.createDiv({ text: this.currentPath, cls: "yunpan-sync-directory-path" });

    let folderName = "";
    new Setting(contentEl).setName("新建文件夹").addText((text) => text
      .setPlaceholder("文件夹名称").onChange((value) => { folderName = value; }))
      .addButton((button) => button.setButtonText("新建").onClick(async () => {
        if (!folderName.trim() || /[\\/]/.test(folderName) || folderName === "." || folderName === "..") {
          new Notice("请输入有效的文件夹名称"); return;
        }
        try {
          validateWindowsPathSegment(folderName);
          await this.api.call("File.mkdir", { fname: `${this.currentPath}${folderName}/` });
          this.currentPath = normalizeRemoteRoot(`${this.currentPath}${folderName}`);
          await this.load();
        } catch (error) {
          new Notice(`新建云端文件夹失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));

    const listHeader = contentEl.createDiv({ cls: "yunpan-sync-directory-list-header" });
    listHeader.createSpan({ text: this.loading ? "正在读取文件夹" : `${this.directories.length} 个文件夹` });
    const list = contentEl.createDiv({
      cls: "yunpan-sync-directory-list",
      attr: { role: "tree", "aria-label": "当前目录下的文件夹" },
    });
    if (this.loading) list.createDiv({ text: "正在加载...", cls: "setting-item-description" });
    else if (this.directories.length === 0) list.createDiv({ text: "当前目录没有子文件夹", cls: "setting-item-description" });
    else for (const directory of this.directories) {
      const row = list.createEl("button", {
        cls: "yunpan-sync-directory-row",
        attr: { role: "treeitem", "aria-label": `打开文件夹 ${directory.name}` },
      });
      const icon = row.createSpan(); setIcon(icon, "folder");
      row.createSpan({ text: directory.name, cls: "yunpan-sync-directory-name" });
      const disclosure = row.createSpan({ cls: "yunpan-sync-directory-disclosure" });
      setIcon(disclosure, "chevron-right");
      row.addEventListener("click", () => {
        try {
          this.currentPath = normalizeRemoteRoot(`${this.currentPath}${directory.name}`);
          void this.load();
        } catch (error) {
          new Notice(`无法打开该云端文件夹: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }

    const footer = contentEl.createDiv({ cls: "yunpan-sync-modal-footer" });
    footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.finish(undefined));
    const choose = footer.createEl("button", { text: "选择当前文件夹", cls: "mod-cta" });
    choose.disabled = this.currentPath === "/";
    choose.addEventListener("click", () => this.finish(this.currentPath));
  }

  private finish(path: string | undefined): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    this.close();
    resolve?.(path);
  }
}
