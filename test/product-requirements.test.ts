import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { classifySyncError } from "../src/sync/error-guidance.js";
import { OpenApiError } from "../src/net/openapi-client.js";
import {
  loadRemoteDirectories,
  parseRemoteDirectoryPage,
  summarizeRemoteDirectoryResponse,
} from "../src/ui/remote-directory.js";
import { feedbackUrl, openFeedbackLink, openProductLink, productLinks } from "../src/ui/product-links.js";
import { WindowsPathError } from "../src/domain/paths.js";

describe("product requirement helpers", () => {
  it("explains Windows-incompatible cloud names without exposing backend details", () => {
    const guidance = classifySyncError(new WindowsPathError("reserved-name", "CON.txt", "Windows 不支持保留设备名：CON.txt"));
    expect(guidance).toEqual({
      category: "windows-path",
      title: "文件名不兼容 Windows",
      detail: "Windows 不支持保留设备名：CON.txt",
    });
  });

  it("shows the exact invalid characters and emoji in path guidance", () => {
    expect(classifySyncError(new WindowsPathError("invalid-character", "bad:name<.md",
      "文件名包含 Windows 不支持的字符", [":", "<"]))).toMatchObject({
      detail: "文件名包含 Windows 不支持的字符：: <",
    });
    expect(classifySyncError(new WindowsPathError("emoji", "😀.md", "文件名不能包含 emoji 表情符号", ["😀"])))
      .toMatchObject({ detail: "文件名不能包含 emoji：😀" });
  });

  it("explains an occupied local rename destination as a file-use conflict", () => {
    expect(classifySyncError(new Error("Local rename destination already exists: notes/new.md"))).toEqual({
      category: "occupied",
      title: "文件正在被占用",
      detail: "文件正在被其他程序使用，请关闭占用程序后重试。",
    });
  });
  it("uses the 360AI Cloud Disk brand in user-facing plugin metadata", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const manifest = readFileSync(new URL("../manifest.json", import.meta.url), "utf8");
    const metadata = JSON.parse(manifest) as { author: string; description: string };

    expect(source).toContain("360AI 云盘");
    expect(source).not.toMatch(/360\s*云盘/);
    expect(metadata.author).toBe("360AI 云盘");
    expect(metadata.description).toBe("Sync an Obsidian vault with 360AI Cloud Disk in both directions.");
    expect(metadata.description).toContain("360AI Cloud Disk");
    expect(manifest).not.toContain("360 Cloud");
  });

  it("presents index rebuild as user-facing automatic repair", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const engineSource = readFileSync(new URL("../src/sync/engine.ts", import.meta.url), "utf8");

    expect(source).toContain('createEl("h3", { text: "同步遇到问题？" });');
    expect(source).toContain('setName("一键自动修复")');
    expect(source).toContain('重新检查云端目录和同步记录');
    expect(source).toContain('setButtonText("自动修复")');
    expect(source).not.toContain('setButtonText("重建索引")');
    expect(engineSource).toContain('rebuild ? "正在重新检查云端目录"');
    expect(engineSource).not.toContain("正在重建远端索引");
  });

  it("follows the account, sync, and filter settings prototype", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const modalSource = readFileSync(new URL("../src/ui/filter-rules-modal.ts", import.meta.url), "utf8");

    for (const label of ["账号设置", "同步设置", "过滤规则", "同步遇到问题？", "产品与支持"]) {
      expect(source).toContain(`text: "${label}"`);
    }
    expect(source).toContain('setName("请登录 360AI 云盘账号")');
    expect(source).toContain('setName("同步状态")');
    expect(source).toContain('setButtonText("编辑规则")');
    expect(source).toContain('setButtonText("前往体验")');
    expect(source).not.toContain('setButtonText("前往下载")');
    expect(source).not.toContain('setName("设备名称")');
    expect(modalSource).toContain('createEl("h2", { text: "过滤规则" })');
    expect(modalSource).toContain('setTooltip("区分大小写")');
    expect(modalSource).toContain('setTooltip("上移")');
    expect(modalSource).toContain('setTooltip("下移")');
    expect(modalSource).toContain('setTooltip("删除")');
  });

  it("keeps mobile filter editing accessible as one horizontally scrolling list", () => {
    const modalSource = readFileSync(new URL("../src/ui/filter-rules-modal.ts", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const addPosition = modalSource.indexOf('createDiv({ cls: "yunpan-sync-filter-actions" })');
    const listPosition = modalSource.indexOf('createDiv({ cls: "yunpan-sync-filter-list" })');
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 680px)"));
    const mobileListRule = mobileStyles.match(/\.yunpan-sync-filter-list\s*\{([^}]*)\}/)?.[1] ?? "";
    const mobileRule = mobileStyles.match(/\.yunpan-sync-filter-rule\s*\{([^}]*)\}/)?.[1] ?? "";
    const mobileControlRule = mobileStyles.match(/\.yunpan-sync-filter-rule \.setting-item-control\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(addPosition).toBeGreaterThanOrEqual(0);
    expect(addPosition).toBeLessThan(listPosition);
    expect(modalSource).toContain("this.rules.unshift({ id: crypto.randomUUID()");
    expect(mobileListRule).toContain("overflow-x: auto");
    expect(mobileRule).toContain("min-width: 620px");
    expect(mobileControlRule).toContain("overflow: visible");
    expect(mobileControlRule).not.toContain("overflow-x: auto");
  });

  it("keeps the remote directory guidance fully visible", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(source).toContain('remote.settingEl.addClass("yunpan-sync-remote-root-setting")');
    expect(source).toContain("remote.settingEl.append(remote.descEl)");
    const remoteLayout = styles.match(/\.yunpan-sync-remote-root-setting\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(remoteLayout).toContain("display: grid");
    expect(remoteLayout).toContain("grid-template-areas:");
    expect(styles).toMatch(/\.yunpan-sync-remote-root-setting > \.setting-item-description\s*\{[^}]*grid-area:\s*description/);
    const remoteRule = styles.match(/\.yunpan-sync-remote-root-setting > \.setting-item-description\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(remoteRule).toContain("white-space: normal");
    expect(remoteRule).toContain("overflow: visible");
    expect(remoteRule).toContain("text-overflow: clip");
    expect(remoteRule).toContain("overflow-wrap: anywhere");
    expect(remoteRule).not.toContain("nowrap");
    expect(remoteRule).not.toContain("ellipsis");
    expect(remoteRule).not.toContain("overflow: hidden");
  });

  it("renders the account membership as an accessible image instead of a text glyph", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

    expect(source).toContain('document.createElement("img")');
    expect(source).toContain("membershipIcon(profile, active)");
    expect(source).toContain("account.nameEl.append(identityEl)");
    expect(source).not.toContain("　◆ ");
  });

  it("gives the remote path its own full-width row in narrow settings", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 680px)"));
    const controlRule = mobileStyles.match(/\.yunpan-sync-remote-root-setting \.setting-item-control\s*\{([^}]*)\}/)?.[1] ?? "";

    // Obsidian makes phone buttons 100% wide; a flex row lets the button
    // consume the path input's space. Separate rows preserve both controls.
    expect(controlRule).toContain("display: grid");
    expect(controlRule).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("uses the reference purple and white labels for buttons across plugin surfaces", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const buttonRule = styles.match(/body :is\(([^)]*)\) :is\(button, \.clickable-icon, \.modal-close-button\)\s*\{([^}]*)\}/);

    expect(buttonRule).not.toBeNull();
    for (const surface of ["settings-page", "modal", "directory-modal", "filter-modal", "side-view"]) {
      expect(buttonRule![1]).toContain(`.yunpan-sync-${surface}`);
    }
    expect(buttonRule![2]).toContain("background: #8a5bf5");
    expect(buttonRule![2]).toContain("color: #fff");
    expect(styles).toContain(":not(:disabled):not([aria-disabled=\"true\"]):hover");
    expect(styles).toContain(":not(:disabled):not([aria-disabled=\"true\"]):active");
  });

  it("renders the remote directory picker as a traditional single-column tree", () => {
    const modalSource = readFileSync(new URL("../src/ui/remote-directory-modal.ts", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const listRule = styles.match(/\.yunpan-sync-directory-list\s*\{([^}]*)\}/)?.[1] ?? "";
    const rowRule = styles.match(/\.yunpan-sync-directory-row\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(modalSource).toContain('role: "tree", "aria-label": "当前目录下的文件夹"');
    expect(modalSource).toContain('role: "treeitem"');
    expect(listRule).toContain("display: block");
    expect(listRule).not.toContain("grid-template-columns");
    expect(rowRule).toContain("width: 100%");
    expect(rowRule).toContain("border-bottom:");
    expect(rowRule).toContain("border-radius: 0");
  });

  it("categorizes actionable synchronization errors", () => {
    expect(classifySyncError(new Error("ENOSPC: no space left on device"))).toEqual({
      category: "space",
      title: "存储空间不足",
      detail: "存储空间不足，请清理不需要的文件或扩容后重试。",
    });
    expect(classifySyncError(new Error("HTTP 403 permission denied")).category).toBe("permission");
    expect(classifySyncError(new Error("EBUSY file is being used")).category).toBe("occupied");
    expect(classifySyncError(new Error("network timeout")).category).toBe("network");
    expect(classifySyncError(new OpenApiError("dest node not exist", 3009, "trace"))).toEqual({
      category: "destination", title: "目标云端文件夹不存在",
      detail: "目标云端文件夹不存在，请确认目标文件夹后重试。",
    });
    expect(classifySyncError(new Error("2 sync tasks failed")).detail)
      .toBe("有 2 个文件同步失败，请检查失败文件后重试。");
    expect(classifySyncError(new Error("unknown backend exception")).detail)
      .toBe("同步过程中出现错误，请稍后重试。若问题持续出现，请稍后重试或检查同步状态。");
  });

  it("shows only real synchronization progress and aligns section titles with card content", () => {
    const modalSource = readFileSync(new URL("../src/ui/sync-modal.ts", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const headingRule = styles.match(/\.yunpan-sync-settings-page > h3\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(modalSource).not.toContain("缓存更新进度");
    expect(modalSource).not.toContain("yunpan-sync-modal-cache-panel");
    expect(headingRule).toContain("margin-left: 0");
    expect(headingRule).toContain("padding-left: 0");
  });

  it("keeps settings sections visually separated with theme-aware surfaces", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const itemRule = styles.match(/\.yunpan-sync-settings-page > \.setting-item\s*\{([^}]*)\}/)?.[1] ?? "";
    const headingRule = styles.match(/\.yunpan-sync-settings-page > h3\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(itemRule).toContain("border: 1px solid var(--background-modifier-border)");
    expect(itemRule).toContain("var(--background-secondary-alt, var(--background-secondary))");
    expect(itemRule).not.toContain("background: white");
    expect(itemRule).not.toContain("background: #fff");
    expect(headingRule).toContain("margin: 34px 0 16px");
  });

  it("offers all sync modes on mobile while keeping manual as the default", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    const settings = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");

    expect(settings).toContain('mode: "manual"');
    expect(source).toContain('dropdown.addOption("automatic", "自动同步");');
    expect(source).toContain('dropdown.addOption("scheduled", "低频自动");');
    expect(source).not.toContain('this.settings.mode = "manual"');
    expect(source).toContain('document.visibilityState === "hidden"');
  });

  it("keeps failed-file text actions visible in narrow layouts", () => {
    const modalSource = readFileSync(new URL("../src/ui/sync-modal.ts", import.meta.url), "utf8");
    const sideSource = readFileSync(new URL("../src/ui/status-view.ts", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(modalSource).toContain("yunpan-sync-modal-failure-actions");
    expect(sideSource).toContain("yunpan-sync-side-failure-actions");
    expect(styles).toMatch(/\.yunpan-sync-modal-failure-actions\s*\{[^}]*display:\s*flex/);
    expect(styles).toMatch(/\.yunpan-sync-modal-failure-actions\s+button\s*\{[^}]*width:\s*auto/);
    expect(styles).toMatch(/\.yunpan-sync-side-failure-actions\s*\{[^}]*display:\s*flex/);
  });

  it("shows the loaded plugin version and build identifier", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain("PLUGIN_BUILD_ID");
    expect(source).toContain("this.manifest.version");
    expect(source).toContain("插件版本");
  });

  it("extracts only safe cloud directories from a paged file list", () => {
    expect(parseRemoteDirectoryPage({
      has_next_page: 1,
      node_list: [
        { nid: "1", name: "Notes", type: 1 },
        { nid: "2", fname: "image.png", type: 2 },
        { nid: "3", name: "../bad", type: 1 },
        { nid: "4", name: "/Cloud/Projects/", type: 1, is_dir: 0 },
      ],
    })).toEqual({
      hasNext: true,
      directories: [
        { nid: "1", name: "Notes" },
        { nid: "4", name: "Projects" },
      ],
    });
  });

  it("loads cloud directories through folder-only File.getList pages", async () => {
    const observe = vi.fn();
    const call = vi.fn()
      .mockResolvedValueOnce({
        has_next_page: 1,
        node_list: [{ nid: "2", name: "B", type: 1 }],
      })
      .mockResolvedValueOnce({
        has_next_page: 0,
        node_list: [{ nid: "1", name: "A", type: 1 }],
      });

    await expect(loadRemoteDirectories(call, "/Notes/", observe)).resolves.toEqual([
      { nid: "1", name: "A" },
      { nid: "2", name: "B" },
    ]);
    expect(call).toHaveBeenNthCalledWith(1, "File.getList", {
      page: 1,
      page_size: 200,
      path: "/Notes/",
      nodetype: "dir",
    });
    expect(call).toHaveBeenNthCalledWith(2, "File.getList", {
      page: 2,
      page_size: 200,
      path: "/Notes/",
      nodetype: "dir",
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenNthCalledWith(1, 1, expect.objectContaining({
      nodeCount: 1,
      nodeTypeCounts: { "1": 1 },
      acceptedDirectoryCount: 1,
    }));
  });

  it("accepts the nested and string-typed File.getList response shape", () => {
    expect(parseRemoteDirectoryPage({
      data: {
        has_next: "true",
        list: [
          { nid: "9", fname: "/Cloud/Notes/", type: "1", is_dir: 0 },
          { nid: "10", fname: "/Cloud/file.md", type: 2, is_dir: 1 },
        ],
      },
    })).toEqual({ hasNext: true, directories: [{ nid: "9", name: "Notes" }] });
  });

  it("accepts a File.getList node map and still filters strictly by type", () => {
    expect(parseRemoteDirectoryPage({
      node_list: {
        "11": { nid: "11", name: "Folder", type: 1 },
        "12": { nid: "12", name: "file.md", type: 2 },
      },
    })).toEqual({ hasNext: false, directories: [{ nid: "11", name: "Folder" }] });
  });

  it("accepts the JSON-string response returned by some Obsidian requestUrl versions", () => {
    expect(parseRemoteDirectoryPage(JSON.stringify({
      data: {
        node_list: [{ nid: "13", name: "/webdav/", type: "1" }],
        has_next_page: 0,
      },
    }))).toEqual({ hasNext: false, directories: [{ nid: "13", name: "webdav" }] });
  });

  it("summarizes the File.getList response without exposing node identities", () => {
    const summary = summarizeRemoteDirectoryResponse({
      data: {
        node_list: [
          { nid: "secret-nid", name: "/private-folder/", type: "1", size: 0 },
          { nid: "secret-file", name: "/private.md", type: "2", size: 12 },
        ],
        has_next_page: 0,
      },
    });

    expect(summary).toEqual({
      responseType: "object",
      levels: [
        { depth: 0, keys: ["data"] },
        { depth: 1, keys: ["has_next_page", "node_list"] },
      ],
      nodeContainerKey: "node_list",
      nodeContainerType: "array",
      nodeCount: 2,
      nodeKeys: ["name", "nid", "size", "type"],
      nodeTypeCounts: { "1": 1, "2": 1 },
      acceptedDirectoryCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("secret-nid");
    expect(JSON.stringify(summary)).not.toContain("private-folder");
  });

  

  it("uses the confirmed production product and renewal links", () => {
    expect(productLinks("production")).toEqual({
      renewal: "https://www.yunpan.com/file/index?default_show_renew=1",
      officialSite: "https://www.yunpan.com/",
      download: "https://yunpan.360.cn/disk/download1.html",
    });
  });

  it("opens only links from the product link policy in a protected new tab", () => {
    const open = vi.fn();

    expect(openProductLink("production", "officialSite", open)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://www.yunpan.com/", "_blank", "noopener,noreferrer");
  });

  it("builds the production feedback URL with the current qid", () => {
    expect(feedbackUrl("3475")).toBe("https://www.yunpan.com/resource/html/feedback.html?qid=3475");
    expect(feedbackUrl("qid with/slash")).toBe(
      "https://www.yunpan.com/resource/html/feedback.html?qid=qid+with%2Fslash",
    );
  });

  it("opens the feedback URL in a protected new tab", () => {
    const open = vi.fn();

    expect(openFeedbackLink("42", open)).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://www.yunpan.com/resource/html/feedback.html?qid=42",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps the feedback entry below the official site and requires login", () => {
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain('setName("问题反馈")');
    expect(source).toContain('setButtonText("去反馈")');
    expect(source).toContain("登录后可提交与账号关联的反馈");
    expect(source).toContain("openFeedbackLink(this.owner.auth.qid");
    expect(source).toContain('setDisabled(!this.owner.auth)');
    expect(source.indexOf('setName("360AI 云盘官网")')).toBeLessThan(source.indexOf('setName("问题反馈")'));
  });
});
