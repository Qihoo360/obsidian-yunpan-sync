import { beforeEach, describe, expect, it, vi } from "vitest";

const { elements, notices, modals, Element } = vi.hoisted(() => {
  class Element {
    children: Element[] = [];
    text = "";
    classes = new Set<string>();
    attributes: Record<string, string> = {};
    listeners = new Map<string, () => void>();
    constructor(public tag = "div") {}
    createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      const child = new Element(tag);
      child.text = options.text ?? "";
      child.addClass(...(options.cls ?? "").split(" "));
      child.attributes = options.attr ?? {};
      this.children.push(child);
      return child;
    }
    createDiv(options = {}) { return this.createEl("div", options); }
    addClass(...classes: string[]) { classes.forEach(name => this.classes.add(name)); }
    setText(text: string) { this.text = text; }
    empty() { this.children = []; }
    addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  }
  return { Element, elements: [] as Element[], notices: [] as string[],
    modals: [] as { close(): void }[] };
});

vi.mock("obsidian", () => ({
  Notice: class { constructor(message: string) { notices.push(message); } },
  Modal: class {
    modalEl = new Element();
    contentEl = new Element();
    constructor(public app: unknown) {}
    onOpen() {}
    onClose() {}
    open() { modals.push(this); elements.push(this.contentEl); this.onOpen(); }
    close() { this.onClose(); }
  },
}));

import { openVaultPath } from "../src/ui/open-vault-path.js";
import { formatDisplayPath } from "../src/ui/path-display.js";

function harness(text = '{ "original": true }\n') {
  const bytes = new TextEncoder().encode(text).buffer;
  const adapter = {
    stat: vi.fn(async (): Promise<{ type: string; size: number } | null> => ({ type: "file", size: bytes.byteLength })),
    readBinary: vi.fn(async (): Promise<ArrayBuffer> => bytes),
    mkdir: vi.fn(), write: vi.fn(), writeBinary: vi.fn(), remove: vi.fn(),
  };
  const openFile = vi.fn(async () => undefined);
  const openLinkText = vi.fn(async () => undefined);
  const app = {
    vault: { getFileByPath: vi.fn<(...args: unknown[]) => unknown>(() => null), adapter },
    workspace: { getLeaf: vi.fn(() => ({ openFile })), openLinkText },
  };
  const open = async (path: string) => { await openVaultPath(app as never, path); await settle(); };
  const find = (cls: string) => elements.at(-1)?.all().find(el => el.classes.has(cls));
  return { app, adapter, openFile, openLinkText, open, find };
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

beforeEach(() => { elements.length = 0; notices.length = 0; modals.length = 0; });

describe("openVaultPath", () => {
  it("continues opening an indexed file using Obsidian", async () => {
    const { app, open, openFile, openLinkText, adapter } = harness();
    const file = { path: "notes/hello.md" };
    app.vault.getFileByPath.mockReturnValue(file);
    await open(file.path);
    expect(openFile).toHaveBeenCalledWith(file);
    expect(openLinkText).not.toHaveBeenCalled();
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(modals).toHaveLength(0);
  });

  it.each([
    ".obsidian/workspace.json",
    ".obsidian/workspace (conflict-Obsidian-20261023-070211).json",
    "笔记/.隐藏目录/嵌套 文件.md",
    ".hidden\\nested\\note.txt",
  ])("previews an unindexed existing file at %s without creating anything", async path => {
    const text = '{ "value": "<script>alert(1)</script>" }\r\n# 原始内容\n';
    const { app, adapter, open, openLinkText, find } = harness(text);
    await open(path);
    const normalized = path.replaceAll("\\", "/");
    expect(find("yunpan-sync-file-preview-path")?.text).toBe(formatDisplayPath(normalized));
    expect(find("yunpan-sync-file-preview-path")?.attributes.title).toBe(normalized);
    expect(find("yunpan-sync-file-preview-text")?.text).toBe(text);
    expect(find("yunpan-sync-file-preview-text")?.tag).toBe("pre");
    expect(find("yunpan-sync-file-preview-text")?.children).toEqual([]);
    expect(find("yunpan-sync-file-preview-text")?.attributes.contenteditable).toBeUndefined();
    expect(adapter.readBinary).toHaveBeenCalledWith(normalized);
    expect(app.workspace.getLeaf).not.toHaveBeenCalled();
    expect(openLinkText).not.toHaveBeenCalled();
    for (const write of [adapter.mkdir, adapter.write, adapter.writeBinary, adapter.remove]) expect(write).not.toHaveBeenCalled();
  });

  it("displays empty files without treating them as missing", async () => {
    const { open, find } = harness("");
    await open(".hidden/empty.txt");
    expect(find("yunpan-sync-file-preview-text")?.text).toBe("");
    expect(find("yunpan-sync-file-preview-status")?.text).toBe("只读预览，不会修改原文件");
  });

  it("preserves a UTF-8 BOM and whitespace in the original text", async () => {
    const text = '\ufeff{\r\n\t"原文": true\r\n}\r\n';
    const { open, find } = harness(text);
    await open(".hidden/config.json");
    expect(find("yunpan-sync-file-preview-text")?.text).toBe(text);
  });

  it.each([
    { name: "missing", stat: null, message: "文件不存在" },
    { name: "folder", stat: { type: "folder", size: 0 }, message: "该路径是文件夹，无法预览" },
    { name: "oversized", stat: { type: "file", size: 2 * 1024 * 1024 + 1 }, message: "不支持预览：文件超过 2 MiB" },
  ])("reports a $name path without link fallback or reading", async ({ stat, message }) => {
    const { adapter, open, openLinkText, find } = harness();
    adapter.stat.mockResolvedValue(stat);
    await open(".obsidian/workspace.json");
    expect(find("yunpan-sync-file-preview-status")?.text).toBe(message);
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(openLinkText).not.toHaveBeenCalled();
  });

  it.each(["stat", "readBinary"] as const)("handles %s failures without an unhandled rejection", async operation => {
    const { adapter, open, find } = harness();
    adapter[operation].mockRejectedValue(new Error("permission denied"));
    await open(".obsidian/workspace.json");
    expect(find("yunpan-sync-file-preview-status")?.text).toBe("无法读取文件，请检查文件是否存在及访问权限");
  });

  it.each([
    { name: "invalid UTF-8", bytes: new Uint8Array([0xff, 0xfe]) },
    { name: "binary", bytes: new Uint8Array([65, 0, 66]) },
  ])("rejects $name without displaying corrupted contents", async ({ bytes }) => {
    const { adapter, open, find } = harness();
    adapter.readBinary.mockResolvedValue(bytes.buffer);
    await open(".hidden/file.bin");
    expect(find("yunpan-sync-file-preview-status")?.text).toBe("不支持预览：仅支持 UTF-8 文本文件");
    expect(find("yunpan-sync-file-preview-text")?.text).toBe("");
  });

  it("supports exactly 2 MiB and rejects a file that grows past the limit while reading", async () => {
    const { adapter, open, find } = harness("a".repeat(2 * 1024 * 1024));
    await open(".hidden/large.txt");
    expect(find("yunpan-sync-file-preview-text")?.text.length).toBe(2 * 1024 * 1024);
    adapter.readBinary.mockResolvedValue(new ArrayBuffer(2 * 1024 * 1024 + 1));
    await open(".hidden/large.txt");
    expect(find("yunpan-sync-file-preview-status")?.text).toBe("不支持预览：文件超过 2 MiB");
  });

  it.each(["readBinary", "stat"] as const)("discards a %s result after closing the preview", async operation => {
    const { adapter, open, find } = harness();
    let release!: () => void;
    if (operation === "readBinary") adapter.readBinary.mockImplementation(() => new Promise(resolve => {
      release = () => resolve(new TextEncoder().encode("late content").buffer);
    }));
    else adapter.stat.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ type: "file", size: 1 });
    }));
    await open(".hidden/file.txt");
    const status = find("yunpan-sync-file-preview-status")!;
    const content = find("yunpan-sync-file-preview-text")!;
    const oldText = status.text;
    modals.at(-1)!.close();
    release();
    await settle();
    expect(content.text).toBe("");
    expect(status.text).toBe(oldText);
    if (operation === "stat") expect(adapter.readBinary).not.toHaveBeenCalled();
  });

  it.each(["", "/etc/passwd", "C:\\Users\\test.txt", "../outside.txt", ".hidden/../outside.txt", "a/./b", "a//b", "a\u0000b"])(
    "rejects paths outside the relative-file contract: %j", async path => {
      const { open, app, adapter, openLinkText } = harness();
      await open(path);
      expect(notices).toEqual(["无法打开文件：路径必须是笔记库内的相对文件路径"]);
      expect(app.vault.getFileByPath).not.toHaveBeenCalled();
      expect(adapter.stat).not.toHaveBeenCalled();
      expect(openLinkText).not.toHaveBeenCalled();
    },
  );

  it("reports an indexed-file opening failure", async () => {
    const { app, openFile, open } = harness();
    app.vault.getFileByPath.mockReturnValue({ path: "note.md" });
    openFile.mockRejectedValue(new Error("no view"));
    await open("note.md");
    expect(notices).toEqual(["无法打开文件，请检查文件是否存在及访问权限"]);
  });

  it("closes the preview using its close button", async () => {
    const { open } = harness();
    await open(".hidden/file.txt");
    const close = vi.spyOn(modals.at(-1)!, "close");
    elements.at(-1)!.all().find(el => el.tag === "button" && el.text === "关闭")!.listeners.get("click")!();
    expect(close).toHaveBeenCalledOnce();
  });
});
