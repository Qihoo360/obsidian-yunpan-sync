import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ElementStub {
  textContent = "";
  hidden = false;
  attributes: Record<string, string> = {};
  empty() { this.textContent = ""; }
  addClass() {}
  append() {}
  appendText(text: string) { this.textContent += text; }
  setText(text: string) { this.textContent = text; }
  setAttr() {}
  toggleClass() {}
  addEventListener() {}
  createEl(tag: string, options?: { text?: string; attr?: Record<string, string> }) {
    const element = new ElementStub();
    element.textContent = options?.text ?? "";
    element.attributes = options?.attr ?? {};
    if (tag === "a") links.push(element);
    return element;
  }
  createDiv(options?: { text?: string }) { return this.createEl("div", options); }
  createSpan(options?: { text?: string }) { return this.createEl("span", options); }
}

class ControlStub {
  buttonEl = new ElementStub();
  label = "";
  disabled = false;
  click?: () => unknown;
  setButtonText(label: string) { this.label = label; return this; }
  setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
  setCta() { return this; }
  onClick(callback: () => unknown) { this.click = callback; return this; }
  addOption() { return this; }
  setValue() { return this; }
  onChange() { return this; }
}

const harness = vi.hoisted(() => ({
  platform: { isMobileApp: true, isIosApp: true, isAndroidApp: false },
  request: vi.fn(),
  notice: vi.fn(),
  modalOpen: vi.fn(),
  save: vi.fn(async () => {}),
  write: vi.fn(async (_path: string, _contents: string) => {}),
  open: vi.fn(),
  copy: vi.fn(async (_text: string) => {}),
  desktopLogin: vi.fn(),
  secrets: new Map<string, string>(),
  protocolHandler: undefined as ((params: Record<string, string>) => void) | undefined,
}));
const rows: { name: string; descEl: ElementStub; settingEl: ElementStub; buttons: ControlStub[] }[] = [];
const tabs: { display(): void }[] = [];
const links: ElementStub[] = [];

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<object>(),
  App: class {},
  apiVersion: "1.14.4",
  Platform: harness.platform,
  requestUrl: harness.request,
  normalizePath: (path: string) => path,
  Notice: class { constructor(message: string) { harness.notice(message); } },
  ItemView: class {},
  setIcon() {},
  Modal: class {
    modalEl = new ElementStub();
    contentEl = new ElementStub();
    open() { harness.modalOpen(); (this as unknown as { onOpen(): void }).onOpen(); }
  },
  PluginSettingTab: class { containerEl = new ElementStub(); },
  Setting: class {
    name = "";
    descEl = new ElementStub();
    settingEl = new ElementStub();
    controlEl = new ElementStub();
    buttons: ControlStub[] = [];
    constructor() { rows.push(this); }
    setName(name: string) { this.name = name; return this; }
    setHeading() { return this; }
    setDesc(text: string) { this.descEl.setText(text); return this; }
    addButton(callback: (button: ControlStub) => unknown) {
      const button = new ControlStub(); this.buttons.push(button); callback(button); return this;
    }
    addDropdown(callback: (control: ControlStub) => unknown) { callback(new ControlStub()); return this; }
    addToggle(callback: (control: ControlStub) => unknown) { callback(new ControlStub()); return this; }
  },
  Plugin: class {
    manifest = { id: "yunpan-sync", dir: ".obsidian/plugins/yunpan-sync", version: "0.1.0" };
    app = {
      secretStorage: {
        getSecret: (key: string) => harness.secrets.get(key) ?? null,
        setSecret: (key: string, value: string) => { harness.secrets.set(key, value); },
      },
      vault: {
        getName: () => "test-vault", on: vi.fn(),
        adapter: { exists: async () => true, write: harness.write },
      },
      workspace: { getLeavesOfType: () => [] },
    };
    async loadData() { return null; }
    async saveData() {}
    addSettingTab(tab: { display(): void }) { tabs.push(tab); }
    addStatusBarItem() { return new ElementStub(); }
    registerObsidianProtocolHandler(_action: string, callback: (params: Record<string, string>) => void) {
      harness.protocolHandler = callback;
    }
    registerView() {}
    addRibbonIcon() {}
    addCommand() {}
    registerEvent() {}
    registerDomEvent() {}
  },
}));

vi.mock("../src/storage/persistence.js", () => ({
  DatabasePersistence: {
    open: async () => ({
      save: harness.save,
      database: {
        recoverInterruptedTasks() {}, taskCounts: () => ({ queued: 0, failed: 0 }),
        listFailedTasks: () => [], getLastSuccessfulSync: () => undefined,
      },
    }),
  },
}));

vi.mock("../src/auth/oauth-desktop.js", () => ({
  DesktopOAuth: class { login = harness.desktopLogin; },
}));

import YunpanSyncPlugin from "../src/main.js";

async function loadPlugin() {
  const plugin = new YunpanSyncPlugin({} as never, {} as never);
  await plugin.onload();
  tabs[0]!.display();
  return plugin;
}

describe("mobile login settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.request.mockReset();
    rows.length = 0; tabs.length = 0; links.length = 0;
    harness.secrets.clear(); harness.open.mockReset();
    harness.platform.isIosApp = true;
    harness.platform.isAndroidApp = false;
    harness.platform.isMobileApp = true;
    harness.desktopLogin.mockReset();
    vi.stubGlobal("window", { open: harness.open });
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { clipboard: { writeText: harness.copy } });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  

  it("shows the stalled login stage, prevents repeated starts, and allows retry after timeout", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin();
    harness.request.mockImplementation(() => new Promise(() => {}));
    const operation = plugin.login();
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
    void plugin.login();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.request).toHaveBeenCalledOnce();
    const account = rows.find((row) => row.name === "请登录 360AI 云盘账号")!;
    const remote = rows.find((row) => row.name === "远程目录")!;
    expect(account.descEl.textContent).toContain("正在读取授权配置");
    expect(account.buttons[0]!.disabled).toBe(false);
    expect(account.buttons[0]!.label).toBe("重新登录");
    expect(account.buttons[1]!.buttonEl.hidden).toBe(false);
    expect(remote.buttons[0]!.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_001);
    await operation;
    expect(account.descEl.textContent).toContain("读取授权配置超时");
    expect(account.buttons[0]!.disabled).toBe(false);
    expect(remote.buttons[0]!.disabled).toBe(false);
    expect(account.buttons[1]!.buttonEl.hidden).toBe(true);
    expect(harness.save.mock.calls.length).toBeGreaterThan(1);
    harness.request.mockResolvedValueOnce({ status: 503, json: {} });
    await plugin.login();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(account.descEl.textContent).toContain("读取授权配置失败（HTTP 503）");
  });

  it("cancels immediately during configuration loading and ignores its late response", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin();
    const existingAuth = JSON.stringify({ accessToken: "existing", qid: "42", token: "token", expiresAt: Date.now() + 60_000 });
    harness.secrets.set("yunpan-sync-auth", existingAuth);
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const operation = plugin.login();
    await vi.dynamicImportSettled();
    const account = rows.find(row => row.name === "请登录 360AI 云盘账号")!;
    await account.buttons[1]!.click!();
    await operation;
    expect(plugin.currentStatus).toMatchObject({ phase: "idle", message: "登录已取消" });
    expect(account.buttons[0]!.label).toBe("登录");
    expect(account.buttons[1]!.buttonEl.hidden).toBe(true);
    expect(harness.secrets.get("yunpan-sync-auth")).toBe(existingAuth);
    expect(vi.getTimerCount()).toBe(0);
    resolve({ status: 200, json: {} });
    await vi.dynamicImportSettled();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.notice).not.toHaveBeenCalledWith(expect.stringContaining("登录失败"));
  });

  it("keeps only the latest attempt when restart is clicked repeatedly", async () => {
    const plugin = await loadPlugin();
    harness.request.mockImplementation(() => new Promise(() => {}));
    const attempts = [plugin.login(), plugin.relogin(), plugin.relogin()];
    await vi.dynamicImportSettled();
    expect(harness.request).toHaveBeenCalledOnce();
    plugin.cancelLogin();
    await Promise.all(attempts);
    expect(plugin.currentStatus.message).toBe("登录已取消");
  });

  it("restarts with fresh state and ignores an old callback without consuming the new state", async () => {
    const plugin = await loadPlugin();
    harness.request.mockResolvedValue({ status: 200, json: { client_id: "mobile-client" } });
    const first = plugin.login();
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1));
    const oldPending = JSON.parse(harness.secrets.get("yunpan-sync-mobile-oauth-pending")!);
    const account = rows.filter(row => row.name === "请登录 360AI 云盘账号").at(-1)!;
    const second = account.buttons[0]!.click!();
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(2));
    await first;
    const pending = harness.secrets.get("yunpan-sync-mobile-oauth-pending")!;
    expect(JSON.parse(pending).state).not.toBe(oldPending.state);
    harness.protocolHandler!({ code: "old-code", state: oldPending.state });
    await vi.dynamicImportSettled();
    expect(harness.secrets.get("yunpan-sync-mobile-oauth-pending")).toBe(pending);
    expect(plugin.pendingAuthorizationUrl).toBe(harness.open.mock.calls[1]![0]);
    expect(harness.request).toHaveBeenCalledTimes(4);
    plugin.cancelLogin();
    await second;
    harness.protocolHandler!({ code: "late-code", state: JSON.parse(pending).state });
    await vi.dynamicImportSettled();
    expect(harness.request).toHaveBeenCalledTimes(4);
    expect(plugin.auth).toBeUndefined();
  });

  it("does not let a cancelled token exchange resolve a new mobile login", async () => {
    const plugin = await loadPlugin();
    harness.request.mockResolvedValue({ status: 200, json: { client_id: "mobile-client" } });
    const first = plugin.login();
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(1));
    const pending = JSON.parse(harness.secrets.get("yunpan-sync-mobile-oauth-pending")!);
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    harness.protocolHandler!({ code: "old-code", state: pending.state });
    await vi.waitFor(() => expect(harness.request).toHaveBeenCalledTimes(3));
    const second = plugin.relogin();
    await first;
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledTimes(2));
    const newPending = harness.secrets.get("yunpan-sync-mobile-oauth-pending");
    resolve({ status: 200, json: { oauth_code: "cancelled-oauth-code" } });
    await vi.dynamicImportSettled();
    expect(harness.request).toHaveBeenCalledTimes(5);
    expect(plugin.currentStatus.phase).toBe("login");
    expect(plugin.auth).toBeUndefined();
    expect(harness.secrets.get("yunpan-sync-mobile-oauth-pending")).toBe(newPending);
    // The cancelled callback must not block callbacks for the replacement attempt.
    harness.request.mockResolvedValueOnce({ status: 403, json: {} });
    harness.protocolHandler!({ code: "new-code", state: JSON.parse(newPending!).state });
    await second;
    expect(plugin.currentStatus).toMatchObject({ phase: "error", message: expect.stringContaining("HTTP 403") });
  });

  it("supports restart and cancel from desktop settings", async () => {
    harness.platform.isMobileApp = false;
    const signals: AbortSignal[] = [];
    harness.desktopLogin.mockImplementation((_open, _timeout, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("登录已取消"))));
    });
    const plugin = await loadPlugin();
    const first = plugin.login();
    await vi.dynamicImportSettled();
    const account = rows.find(row => row.name === "请登录 360AI 云盘账号")!;
    expect(account.buttons[0]!.label).toBe("重新登录");
    const second = account.buttons[0]!.click!();
    await vi.dynamicImportSettled();
    await first;
    expect(signals).toHaveLength(2);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    account.buttons[1]!.click!();
    await second;
    expect(signals[1]!.aborted).toBe(true);
    expect(account.buttons[0]!.label).toBe("登录");
    expect(plugin.currentStatus.message).toBe("登录已取消");
  });

  it.each([["iPhone", "silent"], ["iPhone", "throws"], ["Android", "silent"], ["Android", "throws"]])("provides a mobile authorization link on %s when browser opening %s", async (platform, behavior) => {
    vi.useFakeTimers();
    harness.platform.isIosApp = platform === "iPhone";
    harness.platform.isAndroidApp = platform === "Android";
    const plugin = await loadPlugin();
    harness.request.mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ status: 201, json: { client_id: "mobile-client" } });
    let stateWasSavedBeforeOpening = false;
    harness.open.mockImplementation(() => {
      stateWasSavedBeforeOpening = Boolean(harness.secrets.get("yunpan-sync-mobile-oauth-pending"));
      if (behavior === "throws") throw new Error("Native browser unavailable");
      return null;
    });
    const operation = plugin.login();
    await vi.dynamicImportSettled();
    // WebCrypto runs outside the fake timer queue.
    await vi.waitFor(() => expect(harness.open).toHaveBeenCalledOnce());
    expect(stateWasSavedBeforeOpening).toBe(true);
    expect(harness.open.mock.calls[0]).toHaveLength(1);
    const link = links.find((entry) => entry.textContent === "打开授权页面");
    expect(link).toBeDefined();
    const url = link!.attributes.href!;
    expect(new URL(url).origin).toBe("https://mcp.yunpan.com");
    expect(new URL(url).searchParams.get("login_surface")).toBe("mobile");
    expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
    expect(link!.attributes.target).toBe("_blank");
    expect(link!.attributes.rel).toBe("noopener noreferrer");
    expect(harness.open).toHaveBeenCalledWith(url);
    const authorization = rows.find((row) => row.name === "浏览器授权");
    expect(authorization).toBeDefined();
    await authorization!.buttons.find((button) => button.label === "复制授权链接")!.click!();
    expect(harness.copy).toHaveBeenCalledWith(url);
    expect(harness.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(180_001);
    await operation;
    expect(harness.secrets.get("yunpan-sync-mobile-oauth-pending")).toBe("");
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(authorization!.settingEl.hidden).toBe(true);
    harness.request.mockResolvedValueOnce({ status: 503, json: {} });
    await plugin.login();
    expect(plugin.currentStatus.message).toContain("HTTP 503");
  });

  it("handles an immediate browser callback and removes the fallback link on exchange failure", async () => {
    const plugin = await loadPlugin();
    harness.request.mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ status: 201, json: { client_id: "mobile-client" } })
      .mockResolvedValueOnce({ status: 403, json: {} });
    harness.open.mockImplementation(() => {
      const pending = JSON.parse(harness.secrets.get("yunpan-sync-mobile-oauth-pending")!) as { state: string };
      harness.protocolHandler!({ action: "yunpan-sync", code: "returned-code", state: pending.state });
      return null;
    });
    await plugin.login();
    expect(plugin.currentStatus.phase).toBe("error");
    expect(plugin.currentStatus.message).toContain("HTTP 403");
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(harness.secrets.get("yunpan-sync-mobile-oauth-pending")).toBe("");
    expect(rows.find((row) => row.name === "浏览器授权")!.settingEl.hidden).toBe(true);
  });
});
