import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const observers = new Set<Observer>();
  class Observer {
    targets = new Set<unknown>();
    constructor(public callback: () => void) { observers.add(this); }
    observe(target: unknown) { this.targets.add(target); }
    disconnect() { this.targets.clear(); observers.delete(this); }
  }
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  const win = Object.assign(new EventTarget(), {
    visualViewport: viewport as typeof viewport | undefined, innerHeight: 800, innerWidth: 390,
    MutationObserver: Observer,
    getComputedStyle: (element: Element) => ({
      getPropertyValue: (name: string) => element.properties.get(name) ?? "",
      paddingTop: element.classes.has("yunpan-sync-viewport-insets") ? doc.documentElement.properties.get("--safe-area-inset-top") ?? "0px" : "0px",
      paddingBottom: element.classes.has("yunpan-sync-viewport-insets") ? doc.documentElement.properties.get("--safe-area-inset-bottom") ?? "0px" : "0px",
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  });
  const doc = { defaultView: win, activeElement: null as Element | null,
    documentElement: null as unknown as Element, body: null as unknown as Element };
  class Element extends EventTarget {
    children: Element[] = [];
    parent?: Element;
    classes = new Set<string>();
    attributes: Record<string, string> = {};
    text = "";
    value = "";
    disabled = false;
    scrollTop = 0;
    scrollLeft = 0;
    clientHeight = 800;
    ownerDocument = doc;
    rect = { top: 0, bottom: 200, left: 0, right: 300 };
    properties = new Map<string, string>();
    style = {
      setProperty: (name: string, value: string) => {
        this.properties.set(name, value);
        observers.forEach(observer => { if (observer.targets.has(this)) observer.callback(); });
      },
      removeProperty: (name: string) => this.properties.delete(name),
    };
    constructor(public tag = "div") { super(); }
    createEl(tag: string, options: { text?: string; cls?: string; attr?: Record<string, string> } = {}) {
      const child = new Element(tag);
      child.text = options.text ?? "";
      child.attributes = options.attr ?? {};
      child.addClass(...(options.cls ?? "").split(" ").filter(Boolean));
      this.append(child);
      return child;
    }
    createDiv(options = {}) { return this.createEl("div", options); }
    createSpan(options = {}) { return this.createEl("span", options); }
    append(child: Element) { child.parent = this; this.children.push(child); }
    addClass(...names: string[]) { names.forEach(name => this.classes.add(name)); }
    removeClass(name: string) { this.classes.delete(name); }
    toggleClass(name: string, enabled: boolean) { if (enabled) this.addClass(name); else this.removeClass(name); }
    setText(text: string) { this.text = text; }
    empty() { this.children.forEach(child => { child.parent = undefined; }); this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    contains(child: Element): boolean { return child === this || this.children.some(item => item.contains(child)); }
    closest(selector: string): Element | null {
      if (selector.split(", ").some(name => this.classes.has(name.slice(1)))) return this;
      return this.parent?.closest(selector) ?? null;
    }
    getBoundingClientRect() { return this.rect; }
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
    querySelectorAll() { return this.all().filter(child => ["input", "button", "select"].includes(child.tag)); }
    focus() {
      doc.activeElement = this;
      for (let node: Element | undefined = this; node; node = node.parent) node.dispatchEvent(new Event("focusin"));
    }
    click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
    input(value: string) { this.value = value; this.dispatchEvent(new Event("input")); }
  }
  doc.documentElement = new Element("html"); doc.body = new Element("body");
  const flushFrames = () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  return { Element, doc, win, viewport, frames, flushFrames, observers };
});

vi.mock("obsidian", () => ({
  Notice: class {}, setIcon() {},
  Modal: class {
    modalEl = new ui.Element();
    contentEl = new ui.Element();
    constructor() { this.modalEl.append(this.contentEl); }
    open() { (this as unknown as { onOpen(): void }).onOpen(); }
    close() { (this as unknown as { onClose(): void }).onClose(); }
  },
  Setting: class {
    settingEl: InstanceType<typeof ui.Element>;
    infoEl: InstanceType<typeof ui.Element>;
    controlEl: InstanceType<typeof ui.Element>;
    constructor(container: InstanceType<typeof ui.Element>) {
      this.settingEl = container.createDiv();
      this.infoEl = this.settingEl.createDiv();
      this.controlEl = this.settingEl.createDiv();
    }
    setClass(name: string) { this.settingEl.addClass(name); return this; }
    control(tag: string, callback: (control: unknown) => void) {
      const el = this.controlEl.createEl(tag);
      const control = {
        extraSettingsEl: el,
        setValue: (value: string) => { el.value = value; return control; },
        setDisabled: (value: boolean) => { el.disabled = value; return control; },
        setTooltip: () => control, setPlaceholder: () => control, setIcon: () => control,
        addOption: () => control,
        onChange: (fn: (value: string) => void) => { el.addEventListener("input", () => fn(el.value)); return control; },
        onClick: (fn: () => void) => { el.addEventListener("click", fn); return control; },
      };
      callback(control); return this;
    }
    addText(fn: (control: unknown) => void) { return this.control("input", fn); }
    addToggle(fn: (control: unknown) => void) { return this.control("input", fn); }
    addDropdown(fn: (control: unknown) => void) { return this.control("select", fn); }
    addExtraButton(fn: (control: unknown) => void) { return this.control("button", fn); }
  },
}));

import { FilterRulesModal } from "../src/ui/filter-rules-modal.js";
import { RemoteDirectoryModal } from "../src/ui/remote-directory-modal.js";
import { trackModalViewport } from "../src/ui/modal-viewport.js";

type Element = InstanceType<typeof ui.Element>;
const root = (modal: { contentEl: HTMLElement }) => modal.contentEl as unknown as Element;
const byClass = (element: Element, name: string) => element.all().find(el => el.classes.has(name))!;
const button = (element: Element, text: string) => element.all().find(el => el.tag === "button" && el.text === text)!;
const editorInput = (element: Element) => byClass(element, "yunpan-sync-directory-create").all().find(el => el.tag === "input")!;
const page = (...names: string[]) => ({ node_list: names.map((name, i) => ({ nid: String(i + 1), name, type: 1 })) });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

beforeEach(() => {
  ui.frames.clear(); ui.doc.activeElement = null;
  ui.observers.clear();
  ui.doc.documentElement.properties.clear(); ui.doc.body.properties.clear();
  ui.doc.documentElement.clientHeight = 800; ui.win.innerHeight = 800; ui.win.innerWidth = 390;
  ui.viewport.height = 800; ui.viewport.offsetTop = 0; ui.win.visualViewport = ui.viewport;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("directory picker interactions", () => {
  it("starts at root on each opening, navigates, and selects only on final confirmation", async () => {
    const call = vi.fn().mockResolvedValueOnce(page("Notes")).mockResolvedValueOnce(page("Child"))
      .mockResolvedValueOnce(page("Notes")).mockResolvedValueOnce(page("Notes"));
    const modal = new RemoteDirectoryModal({} as never, { call });
    const selected = modal.choose(); await settle();
    const el = root(modal);
    expect(call.mock.calls[0]![1]).toMatchObject({ path: "/" });
    expect(button(el, "返回上一层").disabled).toBe(true);
    expect(button(el, "确定").disabled).toBe(true);
    byClass(el, "yunpan-sync-directory-row").click(); await settle();
    expect(byClass(el, "yunpan-sync-directory-path").text).toBe("当前路径：/Notes/");
    button(el, "确定").click();
    await expect(selected).resolves.toBe("/Notes/");
    const reopened = modal.choose(); await settle();
    expect(call.mock.calls.at(-1)![1]).toMatchObject({ path: "/" });
    byClass(el, "yunpan-sync-directory-row").click(); await settle();
    // Returning goes to the parent, not the initially configured sync folder.
    call.mockResolvedValueOnce(page("Notes"));
    button(el, "返回上一层").click(); await settle();
    expect(byClass(el, "yunpan-sync-directory-path").text).toBe("当前路径：/");
    modal.close(); await expect(reopened).resolves.toBeUndefined();
  });

  it("creates inline once, stays in the parent, and lists the new folder", async () => {
    const creation = deferred<unknown>();
    const call = vi.fn().mockResolvedValueOnce(page("Notes")).mockResolvedValueOnce(page("Child"))
      .mockImplementationOnce(() => creation.promise).mockResolvedValueOnce(page("Child", "New"));
    const modal = new RemoteDirectoryModal({} as never, { call });
    const selection = modal.choose(); await settle(); const el = root(modal);
    byClass(el, "yunpan-sync-directory-row").click(); await settle();
    button(el, "新建文件夹").click();
    expect(byClass(el, "yunpan-sync-directory-list").children[0]!.classes.has("yunpan-sync-directory-create")).toBe(true);
    expect(button(byClass(el, "yunpan-sync-directory-selection"), "确定").disabled).toBe(true);
    expect(button(el, "返回上一层").disabled).toBe(true);
    expect(byClass(el, "yunpan-sync-directory-row").disabled).toBe(true);
    editorInput(el).input(" New ");
    const confirm = button(byClass(el, "yunpan-sync-directory-create"), "确定");
    confirm.click(); confirm.click(); await settle();
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenLastCalledWith("File.mkdir", { fname: "/Notes/New/" });
    creation.resolve({}); await settle();
    expect(byClass(el, "yunpan-sync-directory-path").text).toBe("当前路径：/Notes/");
    expect(el.all().some(item => item.text === "New")).toBe(true);
    expect(el.all().some(item => item.classes.has("yunpan-sync-directory-create"))).toBe(false);
    button(byClass(el, "yunpan-sync-directory-selection"), "取消").click();
    await expect(selection).resolves.toBeUndefined();
  });

  it("validates names, retains failed input, retries, and cancels only the inline editor", async () => {
    const call = vi.fn().mockResolvedValueOnce(page("Notes")).mockRejectedValueOnce(new Error("already exists"))
      .mockResolvedValueOnce({}).mockResolvedValueOnce(page("Notes", "New"));
    const modal = new RemoteDirectoryModal({} as never, { call });
    void modal.choose(); await settle(); const el = root(modal);
    button(el, "新建文件夹").click();
    editorInput(el).input("../bad"); button(el, "确定").click(); await settle();
    expect(call).toHaveBeenCalledOnce();
    expect(byClass(el, "yunpan-sync-editor-error").text).toContain("有效");
    editorInput(el).input("New"); button(el, "确定").click(); await settle();
    expect(editorInput(el).value).toBe("New");
    expect(byClass(el, "yunpan-sync-editor-error").text).toContain("already exists");
    button(el, "确定").click(); await settle();
    expect(call).toHaveBeenCalledTimes(4);
    button(el, "新建文件夹").click(); editorInput(el).input("Unsaved");
    button(byClass(el, "yunpan-sync-directory-create"), "取消").click();
    expect(byClass(el, "yunpan-sync-directory-row").disabled).toBe(false);
    expect(call).toHaveBeenCalledTimes(4);
    modal.close();
  });

  it("clears stale entries after a failed navigation and allows retry", async () => {
    const child = deferred<unknown>();
    const call = vi.fn().mockResolvedValueOnce(page("Notes")).mockImplementationOnce(() => child.promise)
      .mockResolvedValueOnce(page("Child"));
    const modal = new RemoteDirectoryModal({} as never, { call });
    void modal.choose(); await settle(); const el = root(modal);
    byClass(el, "yunpan-sync-directory-row").click();
    expect(button(el, "确定").disabled).toBe(true);
    expect(el.all().some(item => item.text === "Notes")).toBe(false);
    child.reject(new Error("offline")); await settle();
    expect(button(el, "确定").disabled).toBe(true);
    expect(el.all().some(item => item.text === "Notes")).toBe(false);
    button(el, "重试").click(); await settle();
    expect(button(el, "确定").disabled).toBe(false);
    expect(el.all().some(item => item.text === "Child")).toBe(true);
    modal.close();
  });

  it.each(["load", "create"])("ignores a late %s response after closing and reopening", async operation => {
    const pending = deferred<unknown>();
    const call = operation === "load"
      ? vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(page("Fresh"))
      : vi.fn().mockResolvedValueOnce(page("Notes")).mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(page("Fresh"));
    const modal = new RemoteDirectoryModal({} as never, { call });
    const first = modal.choose(); await settle(); const el = root(modal);
    if (operation === "create") {
      button(el, "新建文件夹").click(); editorInput(el).input("New"); button(el, "确定").click();
    }
    modal.close(); await expect(first).resolves.toBeUndefined();
    const next = modal.choose(); await settle();
    pending.resolve(page("Stale")); await settle();
    expect(el.all().some(item => item.text === "Fresh")).toBe(true);
    expect(el.all().some(item => item.text === "Stale")).toBe(false);
    expect(call).toHaveBeenCalledTimes(operation === "load" ? 2 : 3);
    modal.close(); await next;
  });
});

describe("keyboard-aware editing", () => {
  it("responds to native keyboard height alone and restores after hiding without replacing inputs", () => {
    const modal = new ui.Element(); const list = modal.createDiv({ cls: "yunpan-sync-filter-list" });
    const input = list.createEl("input"); input.value = "**/.DS_Store"; input.focus();
    const stop = trackModalViewport(modal as unknown as HTMLElement);
    ui.doc.documentElement.style.setProperty("--keyboard-height", "450px");
    ui.win.dispatchEvent(new Event("keyboardWillShow")); ui.flushFrames();
    expect(ui.viewport.height).toBe(800); expect(ui.win.innerHeight).toBe(800);
    expect(modal.properties.get("--yunpan-visible-height")).toBe("350px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("175px");
    expect(modal.classes.has("yunpan-sync-compact-viewport")).toBe(true);
    const nextInput = list.createEl("input"); nextInput.focus(); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("350px");
    ui.doc.documentElement.style.setProperty("--keyboard-height", "0px");
    ui.win.dispatchEvent(new Event("keyboardDidHide")); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("800px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("400px");
    expect(input.value).toBe("**/.DS_Store"); expect(list.children[0]).toBe(input);
    stop(); expect(ui.observers.size).toBe(0);
    ui.doc.documentElement.style.setProperty("--keyboard-height", "400px");
    for (const event of ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"]) {
      ui.win.dispatchEvent(new Event(event));
    }
    expect(ui.frames.size).toBe(0);
  });

  it.each([false, true])("intersects native and browser keyboard bounds without double subtraction (webview resize=%s)", resize => {
    const modal = new ui.Element(); const stop = trackModalViewport(modal as unknown as HTMLElement);
    ui.viewport.height = 350;
    if (resize) { ui.win.innerHeight = 350; ui.doc.documentElement.clientHeight = 350; }
    ui.doc.documentElement.style.setProperty("--keyboard-height", "450px");
    ui.viewport.dispatchEvent(new Event("resize")); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("350px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("175px"); stop();
  });

  it("combines safe areas, viewport offsets, body style changes and rotation", () => {
    ui.doc.documentElement.style.setProperty("--safe-area-inset-top", "44px");
    ui.doc.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    const modal = new ui.Element(); const stop = trackModalViewport(modal as unknown as HTMLElement);
    expect(modal.properties.get("--yunpan-visible-height")).toBe("722px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("405px");
    ui.doc.body.style.setProperty("--keyboard-height", "400px");
    ui.viewport.height = 370; ui.viewport.offsetTop = 60; ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("340px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("230px");
    ui.win.innerWidth = 800; ui.win.innerHeight = 390; ui.doc.documentElement.clientHeight = 390;
    ui.viewport.height = 390; ui.viewport.offsetTop = 0;
    ui.doc.body.style.setProperty("--keyboard-height", "190px"); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("156px");
    expect(modal.classes.has("yunpan-sync-tight-viewport")).toBe(true);
    stop();
  });

  it("tracks keyboard height and offset, reveals the input without replacing it, and cleans up", () => {
    const modal = new ui.Element(); const scroller = modal.createDiv({ cls: "yunpan-sync-filter-list" });
    const input = scroller.createEl("input"); input.value = "**/*.tmp";
    const stop = trackModalViewport(modal as unknown as HTMLElement);
    input.rect = { top: 220, bottom: 250, left: 320, right: 500 }; input.focus();
    ui.viewport.height = 320; ui.viewport.offsetTop = 70;
    ui.viewport.dispatchEvent(new Event("resize")); ui.viewport.dispatchEvent(new Event("scroll"));
    expect(ui.frames.size).toBe(1); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-height")).toBe("320px");
    expect(modal.properties.get("--yunpan-visible-center")).toBe("230px");
    expect(scroller.scrollTop).toBe(58); expect(scroller.scrollLeft).toBe(208);
    expect(ui.doc.activeElement).toBe(input); expect(input.value).toBe("**/*.tmp");
    ui.viewport.height = 800; ui.viewport.offsetTop = 0;
    ui.viewport.dispatchEvent(new Event("resize")); ui.flushFrames();
    expect(modal.classes.has("yunpan-sync-compact-viewport")).toBe(false);
    input.focus(); expect(ui.frames.size).toBe(1); stop();
    expect(ui.frames.size).toBe(0); expect(modal.properties.size).toBe(0);
    input.focus(); ui.viewport.dispatchEvent(new Event("resize")); ui.win.dispatchEvent(new Event("resize"));
    expect(ui.frames.size).toBe(0);
    expect(ui.observers.size).toBe(0);
  });

  it("falls back to window resize when visualViewport is unavailable", () => {
    ui.win.visualViewport = undefined; ui.win.innerHeight = 500;
    const modal = new ui.Element(); const stop = trackModalViewport(modal as unknown as HTMLElement);
    expect(modal.properties.get("--yunpan-visible-height")).toBe("500px");
    ui.win.innerHeight = 300; ui.win.dispatchEvent(new Event("resize")); ui.flushFrames();
    expect(modal.properties.get("--yunpan-visible-center")).toBe("150px"); stop();
  });

  it("preserves filter edits during resize and save failure, and prevents duplicate saves", async () => {
    const pending = deferred<void>(); const save = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(undefined);
    const original = [{ id: "1", enabled: true, pattern: "old", caseSensitive: false }];
    const modal = new FilterRulesModal({} as never, original, save); modal.open(); const el = root(modal);
    const list = byClass(el, "yunpan-sync-filter-list");
    const input = list.all().filter(item => item.tag === "input").at(-1)!;
    input.input(" **/*.tmp "); input.focus();
    ui.viewport.height = 320; ui.viewport.dispatchEvent(new Event("resize")); ui.flushFrames();
    expect(list.all()).toContain(input); expect(input.value).toBe(" **/*.tmp ");
    button(el, "保存").click(); button(el, "保存").click();
    expect(save).toHaveBeenCalledOnce(); expect(save.mock.calls[0]![0][0].pattern).toBe("**/*.tmp");
    expect(original[0]!.pattern).toBe("old");
    pending.reject(new Error("disk full")); await settle();
    expect(byClass(el, "yunpan-sync-editor-error").text).toContain("disk full");
    expect(input.value).toBe(" **/*.tmp "); expect(button(el, "保存").disabled).toBe(false);
    button(el, "保存").click(); await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect((modal.modalEl as unknown as Element).properties.size).toBe(0);
    expect(ui.frames.size).toBe(0);
  });
});
