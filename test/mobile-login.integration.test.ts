import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ElementStub {
  textContent = "";
  hidden = false;
  attributes: Record<string, string> = {};
  children: ElementStub[] = [];
  parent?: ElementStub;
  classes = new Set<string>();
  empty() { this.textContent = ""; this.children = []; }
  addClass(name: string) { this.classes.add(name); }
  append(child: ElementStub) { child.parent = this; this.children.push(child); }
  appendText(text: string) { this.textContent += text; }
  setText(text: string) { this.textContent = text; }
  setAttr() {}
  toggleClass() {}
  addEventListener() {}
  createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) {
    const element = new ElementStub();
    element.textContent = options?.text ?? "";
    element.attributes = options?.attr ?? {};
    if (options?.cls) element.addClass(options.cls);
    this.append(element);
    if (tag === "a") links.push(element);
    return element;
  }
  createDiv(options?: { text?: string; cls?: string; attr?: Record<string, string> }) { return this.createEl("div", options); }
  createSpan(options?: { text?: string }) { return this.createEl("span", options); }
}

class ControlStub {
  buttonEl = new ElementStub();
  inputEl = new ElementStub();
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
  persisted: null as unknown,
  apiVersion: "1.11.4",
  databaseOpen: vi.fn(),
  secrets: new Map<string, string>(),
  protocolHandler: undefined as ((params: Record<string, string>) => void) | undefined,
}));
const rows: { name: string; descEl: ElementStub; settingEl: ElementStub; buttons: ControlStub[] }[] = [];
const tabs: { display(): void; containerEl: ElementStub }[] = [];
const links: ElementStub[] = [];

vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<object>(),
  App: class {},
  requireApiVersion: (minimum: string) => {
    const current = harness.apiVersion.split(".").map(Number);
    const required = minimum.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (current[i] !== required[i]) return current[i]! > required[i]!;
    }
    return true;
  },
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
    constructor(container: ElementStub) { container.append(this.settingEl); rows.push(this); }
    setName(name: string) { this.name = name; return this; }
    setHeading() { this.settingEl.addClass("mod-heading"); return this; }
    setDesc(text: string) { this.descEl.setText(text); return this; }
    addButton(callback: (button: ControlStub) => unknown) {
      const button = new ControlStub(); this.buttons.push(button); callback(button); return this;
    }
    addDropdown(callback: (control: ControlStub) => unknown) { callback(new ControlStub()); return this; }
    addText(callback: (control: ControlStub) => unknown) { callback(new ControlStub()); return this; }
    addToggle(callback: (control: ControlStub) => unknown) { callback(new ControlStub()); return this; }
  },
  Plugin: class {
    manifest = { id: "yunpan-sync", dir: ".obsidian/plugins/yunpan-sync", version: "0.1.0", minAppVersion: "1.11.4" };
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
    async loadData() { return harness.persisted; }
    async saveData(data: unknown) { harness.persisted = structuredClone(data); }
    addSettingTab(tab: { display(): void; containerEl: ElementStub }) { tabs.push(tab); }
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
    open: async () => { harness.databaseOpen(); return ({
      save: harness.save,
      close: vi.fn(async () => {}),
      database: {
        recoverInterruptedTasks() {}, taskCounts: () => ({ queued: 0, failed: 0 }),
        listFailedTasks: () => [], getLastSuccessfulSync: () => undefined,
      },
    }); },
  },
}));

vi.mock("../src/auth/oauth-desktop.js", () => ({
  DesktopOAuth: class { login = harness.desktopLogin; },
}));

import YunpanSyncPlugin from "../src/main.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { AUTH_SECRET_ID, LEGACY_AUTH_SECRET_ID, MOBILE_PENDING_OAUTH_SECRET_ID } from "../src/auth/secrets.js";

async function loadPlugin() {
  const plugin = new YunpanSyncPlugin({} as never, {} as never);
  await plugin.onload();
  tabs.at(-1)!.display();
  return plugin;
}

describe("login settings and installation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.request.mockReset();
    rows.length = 0; tabs.length = 0; links.length = 0;
    harness.secrets.clear(); harness.open.mockReset();
    harness.platform.isIosApp = true;
    harness.platform.isAndroidApp = false;
    harness.platform.isMobileApp = true;
    harness.desktopLogin.mockReset();
    harness.persisted = null;
    harness.apiVersion = "1.11.4";
    harness.protocolHandler = undefined;
    vi.stubGlobal("window", { open: harness.open });
    vi.stubGlobal("document", {});
    vi.stubGlobal("navigator", { clipboard: { writeText: harness.copy } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  const storedAuth = () => ({ accessToken: "saved-access", qid: "42", token: "saved-token",
    expiresAt: Date.now() + 3_600_000, oauthCode: "saved-code" });

  it.each(["1.10.3", "1.11.3"])("rejects API %s before settings, secrets, callbacks or storage are touched", async (version) => {
    harness.apiVersion = version;
    const plugin = new YunpanSyncPlugin({} as never, {} as never);
    const load = vi.spyOn(plugin, "loadData");
    const readSecret = vi.spyOn(plugin.app.secretStorage, "getSecret");
    const writeSecret = vi.spyOn(plugin.app.secretStorage, "setSecret");
    harness.secrets.set(AUTH_SECRET_ID, "untouched");
    await plugin.onload();
    await plugin.onunload();
    expect(harness.notice).toHaveBeenCalledWith("版本过低，请先升级 obsidian");
    expect(load).not.toHaveBeenCalled();
    expect(readSecret).not.toHaveBeenCalled();
    expect(writeSecret).not.toHaveBeenCalled();
    expect(harness.databaseOpen).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    expect(tabs).toHaveLength(0);
    expect(harness.protocolHandler).toBeUndefined();
    expect(harness.secrets.get(AUTH_SECRET_ID)).toBe("untouched");
  });

  it.each(["1.11.4", "1.12.7", "1.15.0"])("initializes normally on supported API %s", async version => {
    harness.apiVersion = version;
    const plugin = await loadPlugin();
    expect(harness.databaseOpen).toHaveBeenCalledOnce();
    expect(tabs).toHaveLength(1);
    expect(harness.notice).not.toHaveBeenCalledWith("版本过低，请先升级 obsidian");
    await plugin.onunload();
  });

  it.each([
    { mobile: false, mode: "manual", loggedIn: false },
    { mobile: true, mode: "manual", loggedIn: false },
    { mobile: false, mode: "automatic", loggedIn: true },
    { mobile: true, mode: "automatic", loggedIn: true },
    { mobile: false, mode: "scheduled", loggedIn: true },
    { mobile: true, mode: "scheduled", loggedIn: true },
  ])("groups settings with external headings (mobile=$mobile, mode=$mode, loggedIn=$loggedIn)", async ({ mobile, mode, loggedIn }) => {
    vi.stubGlobal("window", { open: harness.open, setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
    harness.platform.isMobileApp = mobile;
    harness.persisted = { ...DEFAULT_SETTINGS, mode };
    if (loggedIn) harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    const plugin = await loadPlugin();
    const container = tabs.at(-1)!.containerEl;
    const groups = container.children.filter(child => child.classes.has("yunpan-sync-settings-group"));
    expect(groups.map(group => group.attributes["aria-label"]))
      .toEqual(["账号设置", "同步设置", "过滤规则", "同步遇到问题？", "产品与支持"]);
    const headingRows = rows.filter(row => row.settingEl.classes.has("mod-heading"));
    expect(headingRows).toHaveLength(5);
    expect(headingRows.every(row => row.settingEl.parent === container)).toBe(true);
    for (const row of rows.filter(row => !row.settingEl.classes.has("mod-heading"))) {
      expect(row.settingEl.parent?.classes.has("yunpan-sync-settings-group")).toBe(true);
    }
    const syncNames = rows.filter(row => row.settingEl.parent === groups[1]).map(row => row.name);
    expect(syncNames).toContain("远程目录"); expect(syncNames).toContain("同步模式");
    expect(syncNames.includes("同步周期（分钟）")).toBe(mode === "scheduled");
    expect(syncNames.includes("同步状态")).toBe(loggedIn);
    expect(container.children[0]!.classes.has("mod-heading")).toBe(true);
    const version = container.children.at(-1)!;
    expect(version.classes.has("yunpan-sync-settings-version")).toBe(true);
    expect(version.textContent).toBe("插件版本 0.1.0");
    expect(container.children.at(-2)!.classes.has("yunpan-sync-welcome")).toBe(true);
    await plugin.onunload();
  });

  it.each([
    { platform: "desktop", mobile: false, persisted: null },
    { platform: "desktop", mobile: false, persisted: undefined },
    { platform: "mobile", mobile: true, persisted: null },
    { platform: "mobile", mobile: true, persisted: undefined },
  ])("clears orphaned secrets on $platform when settings are $persisted", async ({ mobile, persisted }) => {
    harness.platform.isMobileApp = mobile;
    harness.persisted = persisted;
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    harness.secrets.set(LEGACY_AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    harness.secrets.set(MOBILE_PENDING_OAUTH_SECRET_ID, JSON.stringify({
      state: "old-state", verifier: "old-verifier", clientId: "old-client",
      createdAt: Date.now(), issuer: "https://mcp.yunpan.com",
    }));
    harness.secrets.set("another-plugin-secret", "unrelated");
    const plugin = await loadPlugin();
    expect(plugin.auth).toBeUndefined();
    expect(plugin.currentStatus.message).toBe("未登录");
    expect(rows.some(row => row.name === "请登录 360AI 云盘账号")).toBe(true);
    for (const key of [AUTH_SECRET_ID, LEGACY_AUTH_SECRET_ID, MOBILE_PENDING_OAUTH_SECRET_ID]) {
      expect(harness.secrets.get(key)).toBe("");
    }
    expect(harness.secrets.get("another-plugin-secret")).toBe("unrelated");
    expect(harness.persisted).toMatchObject({ deviceId: expect.any(String), mode: "manual" });
    harness.protocolHandler!({ code: "old-code", state: "old-state" });
    await vi.dynamicImportSettled();
    await plugin.syncNow(false, false);
    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.desktopLogin).not.toHaveBeenCalled();
    expect(plugin.auth).toBeUndefined();
    await plugin.onunload();
  });

  it.each([false, true])("preserves an existing installation across reloads (mobile=%s)", async mobile => {
    harness.platform.isMobileApp = mobile;
    // Existing production settings without a device ID also belong to an upgrade.
    harness.persisted = { ...DEFAULT_SETTINGS };
    const auth = storedAuth();
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(auth));
    const refresh = vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    let plugin = await loadPlugin();
    expect(plugin.auth).toEqual(auth);
    expect(plugin.currentStatus.message).toBe("已登录");
    expect(refresh).toHaveBeenCalledOnce();
    for (let reload = 0; reload < 2; reload++) {
      await plugin.onunload();
      expect(harness.secrets.get(AUTH_SECRET_ID)).toBe(JSON.stringify(auth));
      plugin = await loadPlugin();
      expect(plugin.auth).toEqual(auth);
      expect(plugin.currentStatus.message).toBe("已登录");
    }
    await plugin.onunload();
  });

  it("keeps the replacement login after reinstall and another restart", async () => {
    harness.platform.isMobileApp = false;
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    const plugin = await loadPlugin();
    expect(plugin.auth).toBeUndefined();
    const auth = { ...storedAuth(), accessToken: "new-access", oauthCode: "new-code" };
    harness.desktopLogin.mockResolvedValueOnce(auth);
    vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    await plugin.login();
    expect(plugin.currentStatus.message).toBe("已登录");
    expect(plugin.auth).toEqual(auth);
    await plugin.onunload();
    const restarted = await loadPlugin();
    expect(restarted.auth).toEqual(auth);
    expect(restarted.currentStatus.message).toBe("已登录");
    await restarted.onunload();
  });

  it("requires login again after settings are manually removed", async () => {
    harness.persisted = { ...DEFAULT_SETTINGS, deviceId: "existing-id" };
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    const plugin = await loadPlugin();
    expect(plugin.auth).toBeDefined();
    await plugin.onunload();
    harness.persisted = null;
    const reinstalled = await loadPlugin();
    expect(reinstalled.auth).toBeUndefined();
    expect(reinstalled.currentStatus.message).toBe("未登录");
    expect(harness.request).not.toHaveBeenCalled();
    await reinstalled.onunload();
  });

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
    expect(authorization!.settingEl.parent?.attributes["aria-label"]).toBe("账号设置");
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
