import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

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
    constructor(public tag = "div") {}
    createEl(tag: string, options: { text?: string; cls?: string; type?: string; attr?: unknown } = {}) {
      const child = new Element(tag);
      child.text = options.text ?? "";
      child.addClass(...(options.cls ?? "").split(" ").filter(Boolean));
      child.parent = this;
      this.children.push(child);
      return child;
    }
    createDiv(options: { text?: string; cls?: string } = {}) { return this.createEl("div", options); }
    createSpan(options: { text?: string; cls?: string } = {}) { return this.createEl("span", options); }
    addClass(...names: string[]) { names.forEach(name => this.classes.add(name)); }
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
  },
  Setting: class {
    addButton() { return this; }
  },
  setIcon: () => undefined,
}));
vi.mock("../src/storage/persistence.js", () => ({ DatabasePersistence: {} }));

import YunpanSyncPlugin from "../src/main.js";
import { YunpanStatusView, type StatusViewOwner } from "../src/ui/status-view.js";
import { SyncTaskPreviewModal } from "../src/ui/sync-modal.js";

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

describe("initial sync explanation layout contract", () => {
  const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const rule = (selector: string) => [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1]!.split(",").some(value => value.trim() === selector))
    .map(match => match[2]).join("\n");

  it("assigns the initial explanation its scoped style without changing the text", () => {
    const modal = new SyncTaskPreviewModal({ app: {} } as never, [], "/Obsidian", true);
    modal.onOpen();
    const root = modal.contentEl as unknown as InstanceType<typeof Element>;
    const explanation = root.all().find(el => el.tag === "p")!;
    expect(explanation.classes.has("yunpan-sync-task-description")).toBe(true);
    expect(explanation.text).toBe("当前笔记库将与云端 /Obsidian 双向同步。同名文件若两端内容不同，将保留本地冲突副本，并以云端版本作为原文件。请确认以下操作后开始。");
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
