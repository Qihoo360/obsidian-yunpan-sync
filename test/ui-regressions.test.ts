import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Only emulate the Obsidian element/event boundary. Render the production views.
const { Element, vaultEvents, makeVault } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    parent?: Element;
    classes = new Set<string>();
    listeners = new Map<string, () => void>();
    text = "";
    value = "";
    disabled = false;
    checked = false;
    indeterminate = false;
    hidden = false;
    scrollTop = 0;
    attributes: Record<string, string> = {};
    style = { width: "" };
    constructor(public tag = "div") {}
    createEl(tag: string, options: { text?: string; cls?: string; type?: string; attr?: Record<string, string> } = {}) {
      const child = new Element(tag);
      child.text = options.text ?? "";
      child.attributes = options.attr ?? {};
      child.addClass(...(options.cls ?? "").split(" ").filter(Boolean));
      child.parent = this;
      this.children.push(child);
      return child;
    }
    createDiv(options: { text?: string; cls?: string } = {}) { return this.createEl("div", options); }
    createSpan(options: { text?: string; cls?: string } = {}) { return this.createEl("span", options); }
    addClass(...names: string[]) { names.forEach(name => this.classes.add(name)); }
    toggleClass(name: string, enabled: boolean) { enabled ? this.classes.add(name) : this.classes.delete(name); }
    addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener); }
    setText(text: string) { this.text = text; }
    empty() { this.children.forEach(child => { child.parent = undefined; }); this.children = []; }
    prepend(child: Element) {
      child.parent!.children = child.parent!.children.filter(item => item !== child);
      child.parent = this;
      this.children.unshift(child);
    }
    contains(child: Element): boolean { return child === this || this.children.some(item => item.contains(child)); }
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  }
  type Event = { name: string; callback: () => void };
  const vaultEvents = new Set<Event>();
  const makeVault = () => ({
    on(name: string, callback: () => void) { const ref = { name, callback }; vaultEvents.add(ref); return ref; },
    offref(ref: Event) { vaultEvents.delete(ref); },
  });
  return { Element, vaultEvents, makeVault };
});

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  Plugin: class { constructor(public app: unknown) {} },
  PluginSettingTab: class {},
  Notice: class {},
  normalizePath: (path: string) => path.replace(/\\/g, "/"),
  ItemView: class {
    contentEl = new Element();
    app: unknown;
    constructor(leaf: { app: unknown }) { this.app = leaf.app; }
  },
  Modal: class {
    modalEl = new Element();
    contentEl = new Element();
    open() { (this as unknown as { onOpen(): void }).onOpen(); }
    close() { (this as unknown as { onClose(): void }).onClose(); }
  },
  Setting: class {
    addButton() { return this; }
  },
  setIcon: (element: InstanceType<typeof Element>, name: string) => {
    element.empty(); element.createEl("svg", { attr: { "data-icon": name } });
  },
}));
vi.mock("../src/storage/persistence.js", () => ({ DatabasePersistence: {} }));

import YunpanSyncPlugin from "../src/main.js";
import { YunpanStatusView, type StatusViewOwner } from "../src/ui/status-view.js";
import { SyncTaskPreviewModal, SyncProgressModal } from "../src/ui/sync-modal.js";
import type { SyncTask } from "../src/storage/database.js";
import type { EngineStatus } from "../src/sync/engine.js";
import type { FileTransferProgress } from "../src/sync/progress.js";
import { SkippedFilesList } from "../src/ui/skipped-files.js";
import { WindowsPathError } from "../src/domain/paths.js";

describe("excluded files and scan retry UI", () => {
  it("limits skipped rows, preserves expansion and pagination, and searches reasons independently of failures", () => {
    const root = new Element();
    const list = new SkippedFilesList();
    const files = Array.from({ length: 1000 }, (_, i) => ({ path: `folder/${i}.pdf`, reason: "文件大小不在 0–30 MB 范围内", source: "local" as const }));
    let query = "";
    const refresh = () => { root.empty(); list.render(root as never, files, query, refresh); };
    refresh();
    const details = () => root.all().find(el => el.tag === "details")! as InstanceType<typeof Element> & { open: boolean };
    expect(details().open).toBe(false);
    expect(root.all().filter(el => el.classes.has("yunpan-sync-skipped-file"))).toHaveLength(100);
    details().open = true; details().listeners.get("toggle")!();
    root.all().find(el => el.text === "下一页")!.listeners.get("click")!();
    expect(details().open).toBe(true); expect(root.all().some(el => el.text === "folder/100.pdf")).toBe(true);
    refresh(); expect(root.all().some(el => el.text === "2 / 10")).toBe(true);
    query = "999.pdf"; refresh();
    expect(root.all().filter(el => el.classes.has("yunpan-sync-skipped-file"))).toHaveLength(1);
    expect(root.all().some(el => el.text === "已跳过 1 项（保留原文件）")).toBe(true);
    expect(root.all().some(el => el.text === "来源：本地")).toBe(true);
    expect(root.all().some(el => el.text === "原因：文件大小不在 0–30 MB 范围内")).toBe(true);
  });
  it("shows a known skipped-file size after the path", () => {
    const root = new Element();
    new SkippedFilesList().render(root as never, [{ path: "folder/file.pdf", reason: "文件大小不在 0–30 MB 范围内", source: "local", size: 2048 }], "", () => undefined);
    expect(root.all().some(el => el.text === " (2KB)" && el.classes.has("yunpan-sync-skipped-file-size"))).toBe(true);
  });
  it.each([undefined, NaN, Infinity, -1])("omits invalid skipped-file size %s", size => {
    const root = new Element();
    new SkippedFilesList().render(root as never, [{ path: "file.pdf", reason: "unknown", source: "remote", size }], "", () => undefined);
    expect(root.all().some(el => el.classes.has("yunpan-sync-skipped-file-size"))).toBe(false);
  });
  it("displays empty skipped files as zero bytes", () => {
    const root = new Element();
    new SkippedFilesList().render(root as never, [{ path: "empty.pdf", reason: "too small", source: "local", size: 0 }], "", () => undefined);
    expect(root.all().some(el => el.text === " (0B)")).toBe(true);
  });
  it("offers deletion beside a single failure summary", async () => {
    const removeFailedTask = vi.fn(async () => undefined);
    const task = { id: "bad", kind: "upload" as const, path: "notes/bad.md", payload: {}, state: "failed" as const, attempt: 1, nextRunAt: 0,
      lastError: "具体原因：ENOENT: no such file or directory" };
    const fixture = harness();
    Object.assign(fixture.owner, { currentStatus: { phase: "error", message: "部分文件同步失败", queued: 0, failed: 1, lastError: task.lastError }, failedTasks: [task], removeFailedTask });
    await fixture.view.onOpen();
    const button = fixture.root.all().find(el => el.classes.has("yunpan-sync-status-error-action"))!;
    button.listeners.get("click")!();
    expect(removeFailedTask).toHaveBeenCalledExactlyOnceWith("bad");
  });
  it.each([true, false])("keeps summary deletion disabled during sync (%s)", async isSyncing => {
    const fixture = harness();
    const removeFailedTask = vi.fn(async () => undefined);
    Object.assign(fixture.owner, { isSyncing, removeFailedTask, conflicts: [],
      failedTasks: [{ id: "one", kind: "upload", path: "one.md", state: "failed" }, { id: "two", kind: "upload", path: "two.md", state: "failed" }],
      currentStatus: { phase: "error", message: "部分文件同步失败", queued: 0, failed: 2, lastError: "2 sync files failed" } });
    await fixture.view.onOpen();
    const button = fixture.root.all().find(el => el.classes.has("yunpan-sync-status-error-action"))!;
    expect(button.disabled).toBe(isSyncing);
    button.listeners.get("click")!();
    await settle();
    expect(removeFailedTask.mock.calls).toEqual(isSyncing ? [] : [["one"], ["two"]]);
    await fixture.view.onClose();
  });
  it.each(["modal", "sidebar"])("provides a stable scan-only retry action in the %s", async surface => {
    const retryTask = vi.fn(async () => undefined);
    const currentStatus: EngineStatus = { phase: "error", message: "部分文件同步失败", queued: 0, failed: 1,
      fileFailures: [{ id: "scan:remote:42", nid: "42", source: "remote", path: "/Obsidian/bad:name.md",
        error: new WindowsPathError("invalid-character", "bad:name.md", "文件名不合法", [":"]) }] };
    let root: InstanceType<typeof Element>;
    if (surface === "modal") {
      const modal = new SyncProgressModal({ app: {}, currentStatus, transferProgress: [], failedTasks: [], isSyncing: false, retryTask } as never);
      modal.onOpen(); root = modal.contentEl as never;
    } else {
      const fixture = harness();
      Object.assign(fixture.owner, { currentStatus, retryTask, conflicts: [] });
      await fixture.view.onOpen(); root = fixture.root;
    }
    root.all().find(el => el.text === "重新检测")!.listeners.get("click")!();
    expect(retryTask).toHaveBeenCalledExactlyOnceWith("scan:remote:42");
  });
});

function harness(hasFile: () => Promise<boolean> = async () => false) {
  const owner = {
    currentStatus: { phase: "idle", message: "已是最新", queued: 0, failed: 0 },
    isPaused: false, isSyncing: false, transferProgress: [], failedTasks: [],
    conflicts: [{ id: 1, originalPath: "notes/file.md", conflictPath: "notes/file (conflict).md", createdAt: 1 }],
    hasVaultFile: vi.fn(hasFile),
    openVaultPath: vi.fn(async () => undefined),
    resolveConflict: vi.fn(async () => undefined),
  };
  const view = new YunpanStatusView({ app: { vault: makeVault() } } as never, owner as unknown as StatusViewOwner);
  const root = view.contentEl as unknown as InstanceType<typeof Element>;
  const buttons = () => root.all().filter(el => el.tag === "button").map(el => el.text);
  return { owner, view, root, buttons };
}

// Flush file queries and their rendering continuations without timers.
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

describe("conflict original file actions", () => {
  it("omits the original action when the local file is absent and preserves the other actions", async () => {
    const { view, root, buttons, owner } = harness();
    await view.onOpen();
    await settle();
    expect(buttons()).toEqual(["", "打开冲突副本", "标记已处理"]);
    root.all().find(el => el.text === "打开冲突副本")!.listeners.get("click")!();
    root.all().find(el => el.text === "标记已处理")!.listeners.get("click")!();
    expect(owner.openVaultPath).toHaveBeenCalledWith("notes/file (conflict).md");
    expect(owner.resolveConflict).toHaveBeenCalledWith(1);
    await view.onClose();
  });

  it("waits for existence confirmation, then opens the exact original path", async () => {
    let resolve!: (exists: boolean) => void;
    const { view, buttons, root, owner } = harness(() => new Promise(done => { resolve = done; }));
    await view.onOpen();
    expect(buttons()).not.toContain("打开原文件");
    resolve(true);
    await settle();
    expect(buttons()).toEqual(["", "打开原文件", "打开冲突副本", "标记已处理"]);
    root.all().find(el => el.text === "打开原文件")!.listeners.get("click")!();
    expect(owner.openVaultPath).toHaveBeenCalledWith("notes/file.md");
    await view.onClose();
  });

  it("keeps the original action absent if an existence query fails", async () => {
    const { view, buttons } = harness(async () => { throw new Error("unavailable"); });
    await view.onOpen();
    await settle();
    expect(buttons()).not.toContain("打开原文件");
    await view.onClose();
  });

  it("ignores an older existence result after the list is rendered again", async () => {
    let resolve!: (exists: boolean) => void;
    const { view, root, buttons, owner } = harness(() => new Promise(done => { resolve = done; }));
    await view.onOpen();
    const oldActions = root.all().find(el => el.classes.has("yunpan-sync-conflict-actions"))!;
    owner.hasVaultFile.mockImplementation(async () => false);
    view.render();
    resolve(true);
    await settle();
    expect(buttons()).not.toContain("打开原文件");
    expect(oldActions.all().some(el => el.text === "打开原文件")).toBe(false);
    await view.onClose();
  });

  it("ignores pending results when the view closes and removes its file listeners", async () => {
    let resolve!: (exists: boolean) => void;
    const before = vaultEvents.size;
    const { view, buttons } = harness(() => new Promise(done => { resolve = done; }));
    await view.onOpen();
    expect(vaultEvents.size).toBe(before + 3);
    await view.onClose();
    resolve(true);
    await settle();
    expect(buttons()).not.toContain("打开原文件");
    expect(vaultEvents.size).toBe(before);
  });

  it.each(["create", "delete", "rename"])("refreshes file availability on vault %s events", async event => {
    let exists = true;
    const before = new Set(vaultEvents);
    const { view, buttons } = harness(async () => exists);
    await view.onOpen();
    await settle();
    expect(buttons()).toContain("打开原文件");
    const ref = [...vaultEvents].find(ref => !before.has(ref) && ref.name === event)!;
    exists = false;
    ref?.callback();
    await settle();
    expect(buttons()).not.toContain("打开原文件");
    exists = true;
    ref?.callback();
    await settle();
    expect(buttons()).toContain("打开原文件");
    await view.onClose();
  });
});

describe("local file availability through the plugin", () => {
  it.each([
    { name: "indexed file", indexed: { path: "notes/file.md" }, stat: null, expected: true },
    { name: "hidden file", indexed: null, stat: { type: "file" }, expected: true },
    { name: "missing file", indexed: null, stat: null, expected: false },
    { name: "directory", indexed: null, stat: { type: "folder" }, expected: false },
  ])("recognizes $name", async ({ indexed, stat, expected }) => {
    const vault = { getFileByPath: vi.fn(() => indexed), adapter: { stat: vi.fn(async () => stat) } };
    const plugin = new YunpanSyncPlugin({ vault } as never, {} as never);
    // Runtime assertion also expresses the required owner interface before implementation.
    const owner = plugin as unknown as { hasVaultFile(path: string): Promise<boolean> };
    expect(await owner.hasVaultFile(".obsidian\\workspace.json")).toBe(expected);
    expect(vault.getFileByPath).toHaveBeenCalledWith(".obsidian/workspace.json");
    if (indexed) expect(vault.adapter.stat).not.toHaveBeenCalled();
    else expect(vault.adapter.stat).toHaveBeenCalledWith(".obsidian/workspace.json");
  });

  it("treats an adapter failure as unavailable", async () => {
    const plugin = new YunpanSyncPlugin({ vault: {
      getFileByPath: () => null,
      adapter: { stat: async () => { throw new Error("permission denied"); } },
    } } as never, {} as never);
    const owner = plugin as unknown as { hasVaultFile(path: string): Promise<boolean> };
    expect(await owner.hasVaultFile("notes/file.md")).toBe(false);
  });
});

describe("sync restriction actions", () => {
  it.each([true, false])("shows expiry only beside renewal, including without lastError (%s)", async withLastError => {
    const { view, root, owner } = harness();
    const message = "您的会员套餐已过期，暂时无法同步。请前往官网续费后重试。";
    const currentStatus: EngineStatus = { phase: "error", message, queued: 0, failed: 0,
      lastError: withLastError ? message : undefined, restriction: { kind: "membership", message } };
    Object.assign(owner, { currentStatus, conflicts: [] });
    await view.onOpen();
    expect(root.all().filter(el => el.text === message)).toHaveLength(1);
    expect(root.all().some(el => el.classes.has("yunpan-sync-side-state"))).toBe(false);
    const renewal = root.all().find(el => el.text === "去续费")!;
    const warning = root.all().find(el => el.text === message)!;
    expect(renewal.parent!.contains(warning)).toBe(true);

    const plugin = new YunpanSyncPlugin({} as never, {} as never);
    const statusBar = new Element();
    const renderStatus = () => (plugin as unknown as { renderStatus(): void }).renderStatus();
    Object.assign(plugin, { status: currentStatus, transfers: [], statusBar });
    renderStatus();
    expect(statusBar.text).toBe("360AI云盘");
    expect(statusBar.classes.has("yunpan-sync-error")).toBe(false);

    Object.assign(owner, { currentStatus: { phase: "idle", message: "已是最新", queued: 0, failed: 0 } });
    view.render();
    expect(root.all().some(el => el.text === message || el.text === "去续费")).toBe(false);
    expect(root.all().some(el => el.text === "已是最新")).toBe(true);
    Object.assign(plugin, { status: owner.currentStatus });
    renderStatus();
    expect(statusBar.text).toContain("已是最新");
    Object.assign(plugin, { status: { phase: "error", message: "网络连接异常", queued: 0, failed: 0 } });
    renderStatus();
    expect(statusBar.text).toContain("网络连接异常");
    expect(statusBar.classes.has("yunpan-sync-error")).toBe(true);
    await view.onClose();
  });
  it.each([["membership", "去续费"], ["capacity", "去扩容"], ["unknown", "刷新后重试"]] as const)("renders an explicit %s action in the sidebar", async (kind, label) => {
    const { view, root, owner } = harness();
    const resolveSyncRestriction = vi.fn(async () => undefined);
    Object.assign(owner, { resolveSyncRestriction });
    const currentStatus: EngineStatus = { phase: "error", message: "blocked", queued: 1, failed: 0,
      restriction: { kind, message: "blocked", remainingBytes: 1, requiredBytes: 2 } };
    Object.assign(owner, { currentStatus, conflicts: [] });
    await view.onOpen();
    const button = root.all().find(el => el.tag === "button" && el.text === label)!;
    expect(button).toBeDefined();
    expect(resolveSyncRestriction).not.toHaveBeenCalled();
    button.listeners.get("click")!();
    expect(resolveSyncRestriction).toHaveBeenCalledOnce();
    await view.onClose();
  });
});

describe("large sync lists", () => {
  const tasks = Array.from({ length: 10_000 }, (_, i) => ({ id: String(i), kind: "upload", path: `${i % 2 ? "other" : "match"}/${i}.md`,
    state: "queued", payload: {} } as SyncTask));
  const rows = (root: InstanceType<typeof Element>) => root.all().filter(el =>
    el.classes.has("yunpan-sync-task-row") && !el.classes.has("yunpan-sync-task-header"));

  it("renders only 100 tasks and preserves selection across pages", async () => {
    const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian");
    const choice = modal.choose();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    expect(rows(root)).toHaveLength(100);
    const first = rows(root)[0]!.children[0]!;
    first.checked = false; first.listeners.get("change")!();
    root.all().find(el => el.text === "下一页")!.listeners.get("click")!();
    expect(rows(root)).toHaveLength(100);
    expect(rows(root)[0]!.children[1]!.text).toBe("上传");
    root.all().find(el => el.text === "上一页")!.listeners.get("click")!();
    expect(rows(root)[0]!.children[0]!.checked).toBe(false);
    root.all().find(el => el.text === "继续 (9999)")!.listeners.get("click")!();
    const selected = await choice;
    expect(selected?.size).toBe(9999); expect(selected?.has("0")).toBe(false);
  });

  it("debounces search for 150ms and applies select-all to every matching page", async () => {
    vi.useFakeTimers();
    try {
      const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian");
      const choice = modal.choose();
      const root = modal.contentEl as unknown as InstanceType<typeof Element>;
      const search = root.all().find(el => el.tag === "input")!;
      search.value = "match/"; search.listeners.get("input")!();
      await vi.advanceTimersByTimeAsync(149);
      expect(root.all().some(el => el.text === "1 / 100")).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(root.all().some(el => el.text === "1 / 50")).toBe(true);
      const all = root.all().find(el => el.classes.has("yunpan-sync-task-header"))!.children[0]!;
      all.checked = false; all.listeners.get("change")!();
      root.all().find(el => el.text === "继续 (5000)")!.listeners.get("click")!();
      const selected = await choice;
      expect(selected?.size).toBe(5000);
      expect(selected?.has("9998")).toBe(false); expect(selected?.has("9999")).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("limits transfer detail rendering to 100 rows while retaining all transfers", () => {
    const transferProgress = tasks.map(task => ({ id: task.id, path: task.path, direction: "upload", state: "queued",
      completedBytes: 0, totalBytes: 10 }));
    const modal = new SyncProgressModal({ app: {}, currentStatus: { phase: "transfer", message: "同步中", queued: 10_000, failed: 0 },
      transferProgress, failedTasks: [], isSyncing: true } as never);
    modal.onOpen();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    expect(root.all().filter(el => el.classes.has("yunpan-sync-modal-transfer"))).toHaveLength(100);
    root.all().find(el => el.text === "下一页")!.listeners.get("click")!();
    expect(root.all().some(el => el.text === tasks[100]!.path)).toBe(true);
    expect(transferProgress).toHaveLength(10_000);
  });
});

describe("whole-run sync progress UI", () => {
  const file = (id: string, state: FileTransferProgress["state"], bytes = 0, total = 100): FileTransferProgress => ({
    id, path: `${id}.md`, direction: "download", state, completedBytes: bytes, totalBytes: total,
  });
  function progressHarness(items: FileTransferProgress[]) {
    const owner = { app: {}, currentStatus: { phase: "transfer", message: "正在执行同步任务", queued: items.length, failed: 0 },
      transferProgress: items, failedTasks: [] as SyncTask[], isSyncing: true, cancelSync: vi.fn(), hideSyncProgress: vi.fn(),
      retryTask: vi.fn(async () => undefined), removeFailedTask: vi.fn(async () => undefined) };
    const modal = new SyncProgressModal(owner as never);
    modal.onOpen();
    return { owner, modal, root: modal.contentEl as unknown as InstanceType<typeof Element> };
  }
  const find = (root: InstanceType<typeof Element>, cls: string) => root.all().find(el => el.classes.has(cls))!;
  const rows = (root: InstanceType<typeof Element>) => root.all().filter(el => el.classes.has("yunpan-sync-file-row"));

  it.each([0, 1, 9, 100])("keeps the entire %s%% label outside the fill and agrees with the status bar", percent => {
    const { owner, modal, root } = progressHarness([file("one", percent === 100 ? "completed" : "transferring", percent)]);
    if (percent === 100) { owner.currentStatus = { phase: "idle", message: "同步完成", queued: 0, failed: 0 }; modal.render(); }
    const label = find(root, "yunpan-sync-total-percent");
    expect(label.text).toBe(`${percent}%`);
    expect(find(root, "yunpan-sync-modal-progress-fill").contains(label)).toBe(false);
    expect(find(root, "yunpan-sync-modal-progress-fill").style.width).toBe(`${percent}%`);
    const plugin = new YunpanSyncPlugin({} as never, {} as never);
    const statusBar = new Element();
    Object.assign(plugin, { status: owner.currentStatus, transfers: owner.transferProgress, statusBar });
    (plugin as unknown as { renderStatus(): void }).renderStatus();
    expect(statusBar.text).toContain(`总进度 ${percent}%`);
    expect(statusBar.text).not.toContain("下载");
  });

  it("keeps a single rotating SVG during file updates and partial failure, then stops at the run outcome", () => {
    const { owner, modal, root } = progressHarness([file("one", "transferring", 1), file("two", "queued")]);
    const icon = find(root, "yunpan-sync-modal-icon");
    const svg = icon.children[0];
    for (let i = 0; i < 5; i++) {
      owner.transferProgress = [file("one", "failed", 10), file("two", "transferring", i)];
      owner.failedTasks = [{ id: "one" } as SyncTask];
      modal.render();
      expect(icon.children[0]).toBe(svg);
      expect(icon.classes.has("is-spinning")).toBe(true);
      expect(root.all().some(el => el.text === "停止同步")).toBe(true);
    }
    owner.currentStatus = { phase: "paused", message: "同步已停止", queued: 1, failed: 1 }; modal.render();
    expect(icon.classes.has("is-spinning")).toBe(false);
    expect(icon.children[0]!.attributes["data-icon"]).toBe("circle-stop");
    owner.currentStatus = { phase: "error", message: "失败", queued: 1, failed: 1 }; modal.render();
    expect(icon.children[0]!.attributes["data-icon"]).toBe("circle-alert");
    owner.currentStatus = { phase: "idle", message: "同步完成", queued: 0, failed: 0 }; modal.render();
    expect(icon.children[0]!.attributes["data-icon"]).toBe("circle-check");
  });

  it("sorts unfinished files, folds completed history, preserves scroll and shows state, bytes and errors", () => {
    const { owner, modal, root } = progressHarness([file("done", "completed", 100), file("queue", "queued"),
      { ...file("bad", "failed", 20), error: "network unavailable" }, file("active", "transferring", 30)]);
    expect(rows(root).map(row => find(row, "yunpan-sync-transfer-path").text)).toEqual(["active.md", "queue.md", "bad.md"]);
    expect(root.all().some(el => el.text === "同步中 30%")).toBe(true);
    expect(root.all().some(el => el.text === "等待中 0%")).toBe(true);
    expect(root.all().some(el => el.text === "失败 20%")).toBe(true);
    expect(root.all().some(el => el.text === "30B / 100B")).toBe(true);
    find(root, "yunpan-sync-completed-toggle").listeners.get("click")!();
    expect(rows(root).at(-1)!.classes.has("is-completed")).toBe(true);
    const body = find(root, "yunpan-sync-modal-body"); body.scrollTop = 150;
    owner.transferProgress[3]!.completedBytes = 50; modal.render();
    expect(body.scrollTop).toBe(150);
    expect(find(root, "yunpan-sync-completed-toggle").attributes["aria-expanded"]).toBe("true");
    expect(rows(root).at(-1)!.classes.has("is-completed")).toBe(true);
    owner.isSyncing = false;
    owner.currentStatus = { phase: "error", message: "部分文件同步失败", queued: 0, failed: 1 };
    owner.failedTasks = [{ id: "bad" } as SyncTask]; modal.render();
    const retry = root.all().filter(el => el.text === "重试此文件");
    expect(retry).toHaveLength(1); expect(retry[0]!.disabled).toBe(false);
    retry[0]!.listeners.get("click")!();
    root.all().find(el => el.text === "删除记录")!.listeners.get("click")!();
    expect(owner.retryTask).toHaveBeenCalledWith("bad");
    expect(owner.removeFailedTask).toHaveBeenCalledWith("bad");
  });

  it("keeps separate history and unfinished pages, and searches both sections after 150ms", async () => {
    vi.useFakeTimers();
    try {
      const { modal, root } = progressHarness([
        ...Array.from({ length: 205 }, (_, i) => file(`queue${i}`, "queued")),
        ...Array.from({ length: 205 }, (_, i) => file(`done${i}`, "completed", 100)),
      ]);
      const pending = () => root.all().find(el => el.classes.has("yunpan-sync-modal-transfer-list") && !el.classes.has("is-completed-history"))!;
      const history = () => find(root, "is-completed-history");
      pending().all().find(el => el.text === "下一页")!.listeners.get("click")!();
      find(root, "yunpan-sync-completed-toggle").listeners.get("click")!();
      history().all().find(el => el.text === "下一页")!.listeners.get("click")!();
      modal.render();
      expect(rows(pending())).toHaveLength(100); expect(rows(history())).toHaveLength(100);
      expect(find(rows(pending())[0]!, "yunpan-sync-transfer-path").text).toBe("queue100.md");
      expect(find(rows(history())[0]!, "yunpan-sync-transfer-path").text).toBe("done100.md");
      const search = root.all().find(el => el.tag === "input")!;
      search.value = "0.md"; search.listeners.get("input")!();
      await vi.advanceTimersByTimeAsync(149); expect(rows(pending())).toHaveLength(100);
      await vi.advanceTimersByTimeAsync(1);
      expect(rows(pending())).toHaveLength(21); expect(rows(history())).toHaveLength(21);
      expect(find(root, "yunpan-sync-completed-toggle").attributes["aria-expanded"]).toBe("true");
      modal.onClose();
    } finally { vi.useRealTimers(); }
  });

  it("does not invent a percentage while scanning an unknown total", () => {
    const { owner, modal, root } = progressHarness([]);
    owner.currentStatus = { phase: "local-scan", message: "正在扫描本地", queued: 0, failed: 0 }; modal.render();
    expect(root.all().some(el => el.classes.has("yunpan-sync-total-percent"))).toBe(false);
  });

  it("uses the same states and folding in the sidebar and retains search focus and scroll", async () => {
    const { owner, view, root } = harness();
    Object.assign(owner, { conflicts: [], isSyncing: true, currentStatus: { phase: "transfer", message: "正在执行同步任务", queued: 2, failed: 0 },
      transferProgress: [file("done", "completed", 100), file("queued", "queued"), file("active", "transferring", 50)] });
    await view.onOpen();
    expect(rows(root)).toHaveLength(2);
    expect(find(rows(root)[0]!, "yunpan-sync-transfer-path").text).toBe("active.md");
    const search = root.all().find(el => el.tag === "input")!;
    find(root, "yunpan-sync-completed-toggle").listeners.get("click")!();
    root.scrollTop = 100; view.render();
    expect(root.scrollTop).toBe(100);
    expect(root.all().find(el => el.tag === "input")).toBe(search);
    expect(rows(root).at(-1)!.classes.has("is-completed")).toBe(true);
    expect(root.all().some(el => el.text === "同步中 50%")).toBe(true);
    await view.onClose();
  });
});

describe("initial sync countdown", () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const tasks = [{ id: "upload", path: "note.md", kind: "upload", payload: {} }] as SyncTask[];

  it("shows ten seconds and confirms only at the timeout", async () => {
    vi.useFakeTimers();
    const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian/", true);
    const result = vi.fn();
    const choice = modal.choose().then(result);
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    expect(root.all().some(el => el.text === "继续 (1) · 10s 后自动确认")).toBe(true);
    await vi.advanceTimersByTimeAsync(9000);
    expect(result).not.toHaveBeenCalled();
    expect(root.all().some(el => el.text === "继续 (1) · 1s 后自动确认")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await choice;
    expect(result).toHaveBeenCalledExactlyOnceWith(new Set(["upload"]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "close", "continue"])("cleans up the countdown after %s", async action => {
    vi.useFakeTimers();
    const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian/", true);
    const choice = modal.choose();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    await vi.advanceTimersByTimeAsync(3000);
    if (action === "close") modal.close();
    else if (action === "cancel") modal.cancel();
    else root.all().find(el => el.text.startsWith("继续 ("))!.listeners.get("click")!();
    expect(await choice).toEqual(action === "continue" ? new Set(["upload"]) : undefined);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the current selection and allows an empty vault", async () => {
    vi.useFakeTimers();
    const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian/", true);
    const choice = modal.choose();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    const checkbox = root.all().filter(el => el.tag === "input" && el.listeners.has("change"))[1]!;
    checkbox.checked = false; checkbox.listeners.get("change")!();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await choice).toEqual(new Set());
    const empty = new SyncTaskPreviewModal({ app: {} } as never, [], "/Obsidian/", true);
    const emptyChoice = empty.choose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(await emptyChoice).toEqual(new Set());
  });

  it("does not auto-confirm ordinary task previews", async () => {
    vi.useFakeTimers();
    const modal = new SyncTaskPreviewModal({ app: {} } as never, tasks, "/Obsidian/");
    const result = vi.fn();
    const choice = modal.choose().then(result);
    await vi.advanceTimersByTimeAsync(20000);
    expect(result).not.toHaveBeenCalled();
    modal.cancel(); await choice;
  });
});

describe("initial sync explanation layout contract", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rule = (selector: string) => [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1]!.split(",").some(value => value.trim() === selector))
    .map(match => match[2]).join("\n");

  it("assigns the initial explanation its scoped style and explains automatic confirmation", () => {
    const modal = new SyncTaskPreviewModal({ app: {} } as never, [], "/Obsidian", true);
    modal.onOpen();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    const explanation = root.all().find(el => el.tag === "p")!;
    expect(explanation.classes.has("yunpan-sync-task-description")).toBe(true);
    expect(explanation.text).toContain("10 秒后将按当前勾选项自动开始；不想同步请点击取消。");
    modal.close();
  });

  it("wraps the full explanation and keeps it from shrinking", () => {
    const description = rule(".yunpan-sync-task-description");
    expect(description).toMatch(/white-space:\s*normal/);
    expect(description).toMatch(/overflow-wrap:\s*anywhere/);
    expect(description).toMatch(/overflow:\s*visible/);
    expect(description).toMatch(/flex-shrink:\s*0/);
  });

  it("preserves fixed controls while allowing the table and short window to scroll", () => {
    for (const selector of [".yunpan-sync-task-modal h2", ".yunpan-sync-task-toolbar",
      ".yunpan-sync-task-modal .yunpan-sync-modal-footer"]) {
      expect(rule(selector)).toMatch(/flex-shrink:\s*0/);
    }
    expect(rule(".yunpan-sync-task-table")).toMatch(/overflow:\s*auto/);
    expect(rule(".yunpan-sync-task-modal .modal-content")).toMatch(/overflow-y:\s*auto/);
  });
});
