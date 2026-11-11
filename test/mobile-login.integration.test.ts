import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ElementStub {
  className = "";
  src = "";
  type = "";
  min = "";
  max = "";
  textContent = "";
  hidden = false;
  attributes: Record<string, string> = {};
  children: ElementStub[] = [];
  all(): ElementStub[] { return [this, ...this.children.flatMap(child => child.all())]; }
  parent?: ElementStub;
  classes = new Set<string>();
  empty() { this.textContent = ""; this.children = []; }
  addClass(name: string) { this.classes.add(name); }
  append(child: ElementStub) { child.parent = this; this.children.push(child); }
  appendText(text: string) { this.textContent += text; }
  setText(text: string) { this.textContent = text; }
  setAttr(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  toggleClass() {}
  listeners: Record<string, ((event: Event) => void)[]> = {};
  addEventListener(type: string, listener: (event: Event) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  fire(type: string, options: Record<string, unknown> = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const listener of this.listeners[type] ?? []) listener(event as unknown as Event);
    return event;
  }
  createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) {
    const element = new ElementStub();
    element.textContent = options?.text ?? "";
    element.attributes = options?.attr ?? {};
    if (options?.cls) for (const name of options.cls.split(" ")) element.addClass(name);
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
  change?: (value: string) => unknown;
  value = "";
  icon = "";
  tooltip = "";
  setIcon(icon: string) { this.icon = icon; return this; }
  setTooltip(tooltip: string) { this.tooltip = tooltip; return this; }
  setButtonText(label: string) { this.label = label; return this; }
  setDisabled(disabled: boolean) { this.disabled = disabled; return this; }
  setCta() { return this; }
  onClick(callback: () => unknown) { this.click = callback; return this; }
  addOption() { return this; }
  setValue(value: string) { this.value = value; return this; }
  onChange(callback: (value: string) => unknown) { this.change = callback; return this; }
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
  vaultOn: vi.fn(),
  secrets: new Map<string, string>(),
  protocolHandler: undefined as ((params: Record<string, string>) => void) | undefined,
}));
const rows: { name: string; nameEl: ElementStub; descEl: ElementStub; settingEl: ElementStub; controlEl: ElementStub; buttons: ControlStub[]; controls: ControlStub[] }[] = [];
const tabs: { display(): void; refresh(): void; hide(): void; isVisible: boolean; containerEl: ElementStub }[] = [];
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
    nameEl = new ElementStub();
    descEl = new ElementStub();
    settingEl = new ElementStub();
    controlEl = new ElementStub();
    buttons: ControlStub[] = [];
    controls: ControlStub[] = [];
    constructor(container: ElementStub) { container.append(this.settingEl); rows.push(this); }
    setName(name: string) { this.name = name; return this; }
    setHeading() { this.settingEl.addClass("mod-heading"); return this; }
    setDesc(text: string) { this.descEl.setText(text); return this; }
    addButton(callback: (button: ControlStub) => unknown) {
      const button = new ControlStub(); this.buttons.push(button); callback(button); return this;
    }
    addDropdown(callback: (control: ControlStub) => unknown) {
      const control = new ControlStub(); this.controls.push(control); callback(control); return this;
    }
    addText(callback: (control: ControlStub) => unknown) {
      const control = new ControlStub(); this.controls.push(control); callback(control); return this;
    }
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
        getName: () => "test-vault", on: harness.vaultOn,
        adapter: { exists: async () => true, write: harness.write },
      },
      workspace: { getLeavesOfType: () => [] },
    };
    async loadData() { return harness.persisted; }
    async saveData(data: unknown) { harness.persisted = structuredClone(data); }
    addSettingTab(tab: { display(): void; refresh(): void; hide(): void; isVisible: boolean; containerEl: ElementStub }) { tabs.push(tab); }
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
        isBindingConfirmed: () => true,
      },
    }); },
  },
}));

vi.mock("../src/auth/oauth-desktop.js", () => ({
  DesktopOAuth: class {
    async prepare() {
      return {
        authorizationUrl: "https://mcp.yunpan.com/authorize?state=desktop-state",
        pending: { state: "desktop-state", verifier: "A".repeat(43), clientId: "desktop-client", createdAt: Date.now(), issuer: "https://mcp.yunpan.com", flow: "desktop", redirectUri: "obsidian://yunpan-sync", completionUri: "https://mcp.yunpan.com/oauth/complete" },
      };
    }
    complete = harness.desktopLogin;
  },
}));

import YunpanSyncPlugin from "../src/main.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { AUTH_SECRET_ID, LEGACY_AUTH_SECRET_ID, MOBILE_PENDING_OAUTH_SECRET_ID } from "../src/auth/secrets.js";
import { SyncPreflightError } from "../src/sync/quota.js";
import { SyncEngine } from "../src/sync/engine.js";
import { normalizeAccountProfile } from "../src/account/profile.js";

async function loadPlugin() {
  const plugin = new YunpanSyncPlugin({} as never, {} as never);
  await plugin.onload();
  tabs.at(-1)!.display();
  return plugin;
}

describe("login settings and installation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.request.mockReset().mockImplementation(() => new Promise(() => {}));
    rows.length = 0; tabs.length = 0; links.length = 0;
    harness.secrets.clear(); harness.open.mockReset();
    harness.platform.isIosApp = true;
    harness.platform.isAndroidApp = false;
    harness.platform.isMobileApp = true;
    harness.desktopLogin.mockReset();
    // Lifecycle tests opt into manual mode; the product default for a fresh
    // installation is covered by settings tests and is automatic.
    harness.persisted = { ...DEFAULT_SETTINGS, mode: "manual" };
    harness.apiVersion = "1.11.4";
    harness.protocolHandler = undefined;
    vi.stubGlobal("window", { open: harness.open, setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
      clearInterval: (...args: Parameters<typeof clearInterval>) => clearInterval(...args),
      setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
      clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args) });
    vi.stubGlobal("document", { createElement: () => new ElementStub() });
    vi.stubGlobal("navigator", { clipboard: { writeText: harness.copy }, onLine: true, connection: { type: "wifi" } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  const storedAuth = () => ({ accessToken: "saved-access", qid: "42", token: "saved-token",
    expiresAt: Date.now() + 3_600_000, oauthCode: "saved-code" });

  it("deletes the displayed failed task from the settings error summary", async () => {
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    const plugin = await loadPlugin();
    Object.assign(plugin, { status: { phase: "error", message: "同步失败", queued: 0, failed: 1,
      lastError: "具体原因：具体原因：ENOENT: missing",
      failedTasks: [{ id: "missing-file", kind: "upload", path: "missing.md", state: "failed" }] } });
    const remove = vi.spyOn(plugin, "removeFailedTask").mockResolvedValue(undefined);
    tabs.at(-1)!.refresh();
    const status = rows.filter(row => row.name === "同步状态").at(-1)!;
    expect(status.descEl.textContent).toContain("具体原因：ENOENT: missing");
    expect(status.descEl.textContent).not.toContain("具体原因：具体原因：");
    const action = status.descEl.all().find(el => el.classes.has("yunpan-sync-status-error-action"))!;
    action.fire("click");
    expect(remove).toHaveBeenCalledExactlyOnceWith("missing-file");
  });

  const expiredDetails = () => ({ is_vip: 1, vip_desc: "高级会员", expire: Math.floor(Date.now() / 1000) - 60,
    name: "test-account", used_size: 10, total_size: 100 });
  const renewedDetails = () => ({ ...expiredDetails(), expire: Math.floor(Date.now() / 1000) + 86400 });
  async function expiredProfileFixture() {
    const plugin = await loadPlugin();
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    const api = { call: vi.fn() };
    const engine = { isRunning: () => false, clearMembershipRestriction: vi.fn() };
    Object.assign(plugin, { api, engine, accountProfile: normalizeAccountProfile(expiredDetails(), "42"),
      status: { phase: "error", queued: 2, failed: 0, message: "您的会员套餐已过期", lastError: "您的会员套餐已过期",
        restriction: { kind: "membership", message: "您的会员套餐已过期" } } });
    const tab = tabs.at(-1)!;
    const accountRows = () => rows.filter(row => row.settingEl.parent?.attributes["aria-label"] === "账号设置");
    const refreshButton = () => accountRows().at(-1)?.buttons.find(button => button.tooltip === "刷新会员状态");
    const membershipLabelEl = () => accountRows().at(-1)?.nameEl.all()
      .find(el => el.className.split(" ").includes("yunpan-sync-membership-label"));
    const membershipIconEl = () => accountRows().at(-1)?.nameEl.all()
      .find(el => el.className === "yunpan-sync-membership-icon");
    return { plugin, api, engine, tab, refreshButton, accountRows, membershipLabelEl, membershipIconEl };
  }

  it.each([false, true])("reloads personal details on each settings entry without requesting again on redraw (mobile=%s)", async mobile => {
    harness.platform.isMobileApp = mobile;
    const { plugin, api, engine, tab, refreshButton, membershipLabelEl, membershipIconEl } = await expiredProfileFixture();
    let complete!: (data: unknown) => void;
    api.call.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    tab.display();
    expect(api.call).toHaveBeenCalledExactlyOnceWith("User.getUserDetail", {});
    expect(refreshButton()).toMatchObject({ icon: "refresh-cw", disabled: true });
    expect(membershipLabelEl()).toMatchObject({ textContent: "会员已过期", hidden: true });
    expect(refreshButton()!.buttonEl.classes.has("clickable-icon")).toBe(true);
    expect(refreshButton()!.buttonEl.classes.has("yunpan-sync-membership-refresh")).toBe(true);
    expect(refreshButton()!.buttonEl.parent).toBe(membershipLabelEl()!.parent);
    expect(membershipLabelEl()!.parent!.children).toEqual([membershipLabelEl(), refreshButton()!.buttonEl]);
    const sameRequest = plugin.refreshAccountProfile(false);
    expect(api.call).toHaveBeenCalledTimes(1);
    complete(renewedDetails()); await sameRequest;
    expect(plugin.profile?.expiresAt).toBeGreaterThan(Date.now());
    expect(refreshButton()).toBeUndefined();
    expect(membershipLabelEl()).toMatchObject({ textContent: "高级会员", hidden: false });
    expect(membershipIconEl()?.src).toMatch(/^data:image\/png;base64,/);
    expect(plugin.currentStatus).toMatchObject({ phase: "idle", queued: 2, failed: 0,
      message: "会员状态已更新，可继续同步", restriction: undefined, lastError: undefined });
    expect(engine.clearMembershipRestriction).toHaveBeenCalledOnce();
    tab.refresh(); await plugin.saveSettings();
    expect(api.call).toHaveBeenCalledTimes(1);
    api.call.mockResolvedValue(renewedDetails());
    tab.hide(); tab.display(); await plugin.refreshAccountProfile(false);
    expect(api.call).toHaveBeenCalledTimes(2);
    await plugin.onunload();
  });

  it("retains the expired profile and refresh action on failure, then updates after an explicit retry", async () => {
    const { plugin, api, tab, refreshButton, accountRows, membershipLabelEl } = await expiredProfileFixture();
    api.call.mockRejectedValueOnce(new Error("network unavailable"));
    tab.display(); await plugin.refreshAccountProfile(false);
    expect(plugin.currentStatus.restriction?.kind).toBe("membership");
    expect(refreshButton()).toMatchObject({ disabled: false });
    expect(membershipLabelEl()).toMatchObject({ textContent: "会员已过期", hidden: false });
    expect(accountRows().at(-1)!.descEl.children[0]?.textContent).toContain("network unavailable");
    let complete!: (data: unknown) => void;
    api.call.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const retry = refreshButton()!.click!();
    expect(refreshButton()?.disabled).toBe(true);
    expect(membershipLabelEl()?.hidden).toBe(true);
    complete(renewedDetails()); await retry;
    expect(plugin.profileError).toBeUndefined();
    expect(refreshButton()).toBeUndefined();
    expect(api.call).toHaveBeenCalledTimes(2);
    await plugin.onunload();
  });

  it("keeps the refresh icon when the server still reports expiry and does not auto-start synchronization", async () => {
    const { plugin, api, tab, refreshButton, engine, membershipLabelEl } = await expiredProfileFixture();
    const sync = vi.spyOn(plugin, "syncNow");
    api.call.mockResolvedValue(expiredDetails());
    tab.display();
    expect(membershipLabelEl()?.hidden).toBe(true);
    await plugin.refreshAccountProfile(false);
    expect(refreshButton()?.disabled).toBe(false);
    expect(membershipLabelEl()).toMatchObject({ textContent: "会员已过期", hidden: false });
    expect(plugin.currentStatus.restriction?.kind).toBe("membership");
    expect(engine.clearMembershipRestriction).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    await plugin.onunload();
  });

  it("does not reopen hidden settings after a request completes", async () => {
    const { plugin, api, tab } = await expiredProfileFixture();
    let complete!: (data: unknown) => void;
    api.call.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    tab.display();
    const pending = plugin.refreshAccountProfile(false);
    tab.hide(); const count = rows.length;
    complete(renewedDetails()); await pending;
    expect(tab.isVisible).toBe(false);
    expect(rows).toHaveLength(count);
    await plugin.onunload();
  });

  it("ignores a previous account's late response without clearing the replacement request's loading state", async () => {
    const { plugin, api, tab } = await expiredProfileFixture();
    let oldComplete!: (data: unknown) => void;
    api.call.mockImplementationOnce(() => new Promise(resolve => { oldComplete = resolve; }));
    tab.display(); const oldRequest = plugin.refreshAccountProfile(false);
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify({ ...storedAuth(), qid: "99" }));
    let newComplete!: (data: unknown) => void;
    const replacementApi = { call: vi.fn(() => new Promise(resolve => { newComplete = resolve; })) };
    Object.assign(plugin, { api: replacementApi, accountProfile: undefined });
    const replacementRequest = plugin.refreshAccountProfile(false);
    oldComplete(renewedDetails()); await oldRequest;
    expect(plugin.profile).toBeUndefined(); expect(plugin.profileLoading).toBe(true);
    newComplete({ ...renewedDetails(), name: "new-account" }); await replacementRequest;
    expect(plugin.profile).toMatchObject({ qid: "99", displayName: "new-account" });
    expect(plugin.profileLoading).toBe(false);
    await plugin.onunload();
  });

  it("preserves a user's pause switch and unrelated capacity restrictions", async () => {
    const { plugin, api, tab } = await expiredProfileFixture();
    plugin.settings.paused = true;
    api.call.mockResolvedValue(renewedDetails());
    tab.display(); await plugin.refreshAccountProfile(false);
    expect(plugin.isPaused).toBe(true); expect(plugin.currentStatus.phase).toBe("paused");
    Object.assign(plugin, { status: { phase: "error", message: "套餐容量不足", restriction: { kind: "capacity" }, queued: 2, failed: 1 } });
    await plugin.refreshAccountProfile(false);
    expect(plugin.currentStatus).toMatchObject({ phase: "error", restriction: { kind: "capacity" }, failed: 1 });
    await plugin.onunload();
  });

  it.each([false, true])("starts initial detection without a click in automatic mode (mobile=%s)", async mobile => {
    vi.useFakeTimers();
    harness.platform.isMobileApp = mobile;
    harness.persisted = { ...DEFAULT_SETTINGS, mode: "automatic" };
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    vi.spyOn(SyncEngine.prototype, "needsInitialConfirmation").mockReturnValue(true);
    const synchronize = vi.spyOn(SyncEngine.prototype, "synchronize").mockResolvedValue(true);
    const plugin = await loadPlugin();
    await vi.advanceTimersByTimeAsync(1499);
    expect(synchronize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(synchronize).toHaveBeenCalledExactlyOnceWith(false, expect.any(Function));
    await plugin.onunload();
  });

  it("offers initial confirmation on an automatic trigger, suppresses repeats after cancel, and allows manual retry", async () => {
    const plugin = await loadPlugin();
    const confirm = vi.spyOn(plugin as unknown as { confirmSyncTasks(): Promise<undefined> }, "confirmSyncTasks")
      .mockResolvedValue(undefined);
    vi.spyOn(plugin, "showSyncProgress").mockImplementation(() => {});
    const synchronize = vi.fn(async (_rebuild: boolean, choose?: (tasks: []) => Promise<unknown>) => {
      await choose?.([]); return false;
    });
    Object.assign(plugin, { engine: { synchronize, needsInitialConfirmation: () => true, isRunning: () => false } });
    await plugin.syncNow(false, false);
    expect(confirm).toHaveBeenCalledOnce();
    await plugin.syncNow(false, false);
    expect(synchronize).toHaveBeenCalledOnce();
    expect(plugin.currentStatus.message).toBe("等待首次同步确认");
    await plugin.syncNow();
    expect(confirm).toHaveBeenCalledTimes(2);
    await plugin.onunload();
  });

  it("validates size settings as a pair, waits for a running sync and preserves existing records", async () => {
    const plugin = await loadPlugin();
    const order: string[] = [];
    const engine = { isRunning: () => true, cancel: () => { order.push("cancel"); }, waitForIdle: async () => { order.push("idle"); } };
    Object.assign(plugin, { engine });
    expect(await plugin.setFileSizeRange(0, 0)).toBe(false);
    expect(await plugin.setFileSizeRange(5, 1)).toBe(false);
    expect(order).toEqual([]);
    expect(plugin.settings.maxFileSizeMB).toBe(30);
    expect(await plugin.setFileSizeRange(0.5, 12.5)).toBe(false);
    expect(await plugin.setFileSizeRange(5, 12)).toBe(true);
    expect(order).toEqual(["cancel", "idle"]);
    expect(harness.persisted).toMatchObject({ minFileSizeMB: 5, maxFileSizeMB: 12 });
    await plugin.setFilterRules([{ id: "mine", enabled: true, action: "exclude", pattern: "**/*.log", caseSensitive: false }]);
    expect(plugin.settings.filterRules[0]?.id).toBe("mine");
    // The test database deliberately has no reset method: filter edits must preserve it.
    await plugin.onunload();
  });

  it.each([false, true])("saves integer size limits only on blur without replacing the controls (mobile=%s)", async mobile => {
    harness.platform.isMobileApp = mobile; harness.platform.isIosApp = mobile;
    const plugin = await loadPlugin();
    const row = rows.find(item => item.name === "单文件大小范围")!;
    const [lower, upper] = row.controls;
    expect(row.buttons).toHaveLength(0);
    const saves = vi.spyOn(plugin, "saveData");
    lower!.inputEl.fire("blur");
    await vi.waitFor(() => expect(plugin.settings.maxFileSizeMB).toBe(30));
    upper!.change!("500");
    expect(plugin.settings.maxFileSizeMB).toBe(30);
    upper!.inputEl.fire("blur");
    await vi.waitFor(() => expect(saves).toHaveBeenCalledOnce());
    expect(harness.persisted).toMatchObject({ minFileSizeMB: 0, maxFileSizeMB: 500 });
    expect(rows.filter(item => item.name === "单文件大小范围")).toEqual([row]);
    for (const value of ["", "1.5", "501", "-1", "0"]) {
      upper!.change!(value); upper!.inputEl.fire("blur");
    }
    await vi.waitFor(() => expect(harness.notice).toHaveBeenCalledTimes(5));
    expect(saves).toHaveBeenCalledOnce();
    expect(plugin.settings.maxFileSizeMB).toBe(500);
    await plugin.onunload();
  });

  it.each([true, false])("updates repeated automatic restrictions quietly and opens payment only on action (mobile=%s)", async mobile => {
    harness.platform.isMobileApp = mobile;
    const plugin = await loadPlugin();
    const synchronize = vi.fn(async () => { throw new SyncPreflightError("capacity", "套餐容量不足，剩余 1 B，本次同步预计新增占用 2 B。", 1, 2); });
    Object.assign(plugin, { engine: { synchronize, needsInitialConfirmation: () => false, isRunning: () => false } });
    harness.notice.mockClear();
    await plugin.syncNow(false, false);
    synchronize.mockImplementation(async () => { throw new SyncPreflightError("capacity", "套餐容量不足，剩余 0 B，本次同步预计新增占用 3 B。", 0, 3); });
    await plugin.syncNow(false, false);
    expect(harness.notice).toHaveBeenCalledTimes(1);
    expect(plugin.currentStatus.restriction).toMatchObject({ remainingBytes: 0, requiredBytes: 3 });
    expect(harness.open).not.toHaveBeenCalled();
    await plugin.resolveSyncRestriction();
    expect(harness.open).toHaveBeenCalledWith(mobile ? "https://www.yunpan.com/mapp/pay" : "https://www.yunpan.com/file/index?default_show_renew=1", "_blank", "noopener,noreferrer");
    await plugin.onunload();
  });

  it.each([false, true])("replaces actual sync timers on mode and interval changes (mobile=%s)", async mobile => {
    vi.useFakeTimers();
    harness.platform.isMobileApp = mobile;
    vi.stubGlobal("window", { open: harness.open, setInterval, clearInterval, setTimeout, clearTimeout });
    const plugin = await loadPlugin();
    const sync = vi.spyOn(plugin, "syncNow").mockResolvedValue();
    const modeControl = () => rows.filter(row => row.name === "同步模式").at(-1)!.controls[0]!;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sync).not.toHaveBeenCalled(); // Manual mode has no timer.
    await modeControl().change!("automatic");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(179_999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledExactlyOnceWith(false, false);

    await modeControl().change!("scheduled");
    expect(vi.getTimerCount()).toBe(1);
    const intervalRow = rows.filter(row => row.name === "同步周期（分钟）").at(-1)!;
    expect(intervalRow.descEl.textContent).toBe("4 至 1440 分钟");
    expect(intervalRow.controls[0]!.inputEl).toMatchObject({ type: "number", min: "4", max: "1440" });
    expect(intervalRow.controls[0]!.value).toBe("30");
    await intervalRow.controls[0]!.change!("3");
    expect(plugin.settings.intervalMinutes).toBe(4);
    expect(harness.persisted).toMatchObject({ mode: "scheduled", intervalMinutes: 4 });
    expect(rows.filter(row => row.name === "同步周期（分钟）").at(-1)!.controls[0]!.value).toBe("4");
    expect(vi.getTimerCount()).toBe(1);
    sync.mockClear();
    await vi.advanceTimersByTimeAsync(239_999);
    expect(sync).not.toHaveBeenCalled(); // The old three-minute timer is gone.
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledExactlyOnceWith(false, false);
    await modeControl().change!("manual");
    expect(vi.getTimerCount()).toBe(0);
    await plugin.onunload();
  });

  it("keeps local file change debounce at 1.5 seconds and suppresses it in the mobile background", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { open: harness.open, setInterval, clearInterval, setTimeout, clearTimeout });
    const doc = { visibilityState: "visible" };
    vi.stubGlobal("document", doc);
    harness.persisted = { ...DEFAULT_SETTINGS, mode: "automatic" };
    const plugin = await loadPlugin();
    const sync = vi.spyOn(plugin, "syncNow").mockResolvedValue();
    const onModify = harness.vaultOn.mock.calls.find(call => call[0] === "modify")![1];
    onModify({ path: "note.md" });
    await vi.advanceTimersByTimeAsync(1000);
    onModify({ path: "note.md" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledExactlyOnceWith(false, false);
    sync.mockClear();
    doc.visibilityState = "hidden";
    onModify({ path: "note.md" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sync).not.toHaveBeenCalled();
    await plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });

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
    expect(harness.persisted).toMatchObject({ deviceId: expect.any(String), mode: "automatic" });
    harness.protocolHandler!({ code: "old-code", state: "old-state" });
    await vi.dynamicImportSettled();
    await plugin.syncNow(false, false);
    expect(harness.request.mock.calls.every(([request]) => !request.url.includes("mobile-exchange"))).toBe(true);
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
    expect(refresh).toHaveBeenCalledTimes(2); // Startup and explicit settings entry.
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
    harness.persisted = null;
    harness.secrets.set(AUTH_SECRET_ID, JSON.stringify(storedAuth()));
    const plugin = await loadPlugin();
    expect(plugin.auth).toBeUndefined();
    const auth = { ...storedAuth(), accessToken: "new-access", oauthCode: "new-code" };
    harness.desktopLogin.mockResolvedValueOnce(auth);
    vi.spyOn(YunpanSyncPlugin.prototype, "refreshAccountProfile").mockResolvedValue();
    const login = plugin.login();
    await vi.dynamicImportSettled();
    harness.protocolHandler!({ code: "returned-code", state: "desktop-state" });
    await login;
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


  const latestRow = (name: string) => rows.filter(row => row.name === name).at(-1)!;
  const loginLink = (name = "请登录 360AI 云盘账号") =>
    latestRow(name).controlEl.children.find(child => child.classes.has("yunpan-sync-login-link"))!;
  const pending = () => JSON.parse(harness.secrets.get(MOBILE_PENDING_OAUTH_SECRET_ID)!) as { state: string };
  function mockPreparation() {
    harness.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) return { status: 200, json: {} };
      if (url.endsWith("/register")) return { status: 201, json: { client_id: "mobile-client" } };
      if (url.endsWith("/oauth/360/mobile-exchange")) return { status: 200, json: { oauth_code: "new-oauth-code" } };
      return { status: 200, json: { errno: 0,
        data: { access_token: "new-access", qid: "42", token: "cloud-token", access_token_expire: 3600 } } };
    });
  }
  async function preparedPlugin() {
    mockPreparation();
    const plugin = await loadPlugin();
    await plugin.prepareMobileLogin();
    return plugin;
  }

  it("prepares on settings display, shares both links and reuses work across renders", async () => {
    mockPreparation();
    const plugin = await loadPlugin();
    expect(loginLink().textContent).toBe("准备登录…");
    expect(loginLink().attributes["aria-disabled"]).toBe("true");
    tabs.at(-1)!.display();
    tabs.at(-1)!.display();
    await plugin.prepareMobileLogin();
    const account = loginLink(); const remote = loginLink("远程目录");
    expect(account.textContent).toBe("登录");
    expect(account.attributes.href).toBe(remote.attributes.href);
    expect(new URL(account.attributes.href!).searchParams.get("code_challenge")).toBeTruthy();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.secrets.get(MOBILE_PENDING_OAUTH_SECRET_ID) ?? "").toBe("");
    expect(plugin.currentStatus.phase).toBe("idle");
    tabs.at(-1)!.display();
    await plugin.prepareMobileLogin();
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.open).not.toHaveBeenCalled();
    await plugin.onunload();
  });

  it.each([
    ["iPhone", "请登录 360AI 云盘账号"], ["iPhone", "远程目录"],
    ["Android", "请登录 360AI 云盘账号"], ["Android", "远程目录"],
  ])("lets the real link navigate synchronously on %s from %s", async (platform, rowName) => {
    vi.useFakeTimers();
    harness.platform.isIosApp = platform === "iPhone";
    harness.platform.isAndroidApp = platform === "Android";
    const plugin = await preparedPlugin();
    const link = loginLink(rowName);
    const url = link.attributes.href!;
    const containerChildren = [...tabs.at(-1)!.containerEl.children];
    const event = link.fire("click");
    // These assertions run before any microtask or timer, just as native navigation does.
    expect(event.defaultPrevented).toBe(false);
    expect(link.attributes.href).toBe(url);
    expect(tabs.at(-1)!.containerEl.children).toEqual(containerChildren);
    expect(plugin.pendingAuthorizationUrl).toBe(url);
    expect(new URL(url).searchParams.get("state")).toBe(pending().state);
    expect(link.attributes.target).toBe("_blank");
    expect(link.attributes.rel).toBe("noopener noreferrer");
    expect(harness.request).toHaveBeenCalledTimes(2);
    expect(harness.open).not.toHaveBeenCalled();
    // A second click on the consumed link cannot start another authorization.
    expect(link.fire("click").defaultPrevented).toBe(true);
    expect(plugin.pendingAuthorizationUrl).toBe(url);
    await vi.advanceTimersByTimeAsync(0);
    await plugin.prepareMobileLogin();
    expect(loginLink().textContent).toBe("重新登录");
    expect(loginLink().attributes.href).not.toBe(url);
    const fallback = links.filter(entry => entry.textContent === "打开授权页面").at(-1)!;
    expect(fallback.attributes.href).toBe(url);
    expect(latestRow("请登录 360AI 云盘账号").buttons[0]!.buttonEl.hidden).toBe(false);
    tabs.at(-1)!.hide();
    plugin.cancelLogin();
    await plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts an immediate callback and ignores duplicates without requiring a second tap", async () => {
    const plugin = await preparedPlugin();
    vi.spyOn(plugin, "refreshAccountProfile").mockResolvedValue();
    const link = loginLink();
    expect(link.fire("click").defaultPrevented).toBe(false);
    const state = pending().state;
    harness.protocolHandler!({ action: "yunpan-sync", code: "returned-code", state });
    harness.protocolHandler!({ action: "yunpan-sync", code: "returned-code", state });
    await vi.waitFor(() => expect(plugin.currentStatus.message).toBe("已登录"));
    expect(plugin.auth).toMatchObject({ accessToken: "new-access", oauthCode: "new-oauth-code" });
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(harness.secrets.get(MOBILE_PENDING_OAUTH_SECRET_ID)).toBe("");
    expect(harness.request.mock.calls.filter(([request]) => request.url.includes("mobile-exchange"))).toHaveLength(1);
    expect(harness.notice).not.toHaveBeenCalledWith("请点击“打开授权页面”继续授权");
    expect(harness.open).not.toHaveBeenCalled();
    expect(plugin.mobileLoginPreparation.ready).toBeUndefined();
    await plugin.onunload();
  });

  it("does not activate a link whose click has already been prevented", async () => {
    const plugin = await preparedPlugin();
    loginLink().fire("click", { defaultPrevented: true });
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(plugin.mobileLoginPreparation.ready).toBeDefined();
    await plugin.onunload();
  });

  it.each(["click", "display"])("replaces an expired preparation on %s without navigating automatically", async trigger => {
    vi.useFakeTimers();
    const plugin = await preparedPlugin();
    const oldLink = loginLink(); const oldUrl = oldLink.attributes.href;
    vi.setSystemTime(Date.now() + 5 * 60_000);
    if (trigger === "click") expect(oldLink.fire("click").defaultPrevented).toBe(true);
    else tabs.at(-1)!.display();
    expect(loginLink().hasAttribute("href")).toBe(false);
    await plugin.prepareMobileLogin();
    expect(loginLink().attributes.href).not.toBe(oldUrl);
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.request).toHaveBeenCalledTimes(4);
    await plugin.onunload();
  });

  it("shows preparation timeout, disables both links and retries only on request", async () => {
    vi.useFakeTimers();
    const plugin = await loadPlugin();
    await vi.dynamicImportSettled();
    expect(harness.request).toHaveBeenCalledOnce();
    expect(loginLink().fire("click").defaultPrevented).toBe(true);
    expect(loginLink("远程目录").attributes["aria-disabled"]).toBe("true");
    await vi.advanceTimersByTimeAsync(15_001);
    expect(latestRow("请登录 360AI 云盘账号").descEl.textContent).toContain("读取授权配置超时");
    expect(loginLink().textContent).toBe("重试准备");
    expect(loginLink().attributes.tabindex).toBe("0");
    tabs.at(-1)!.display();
    await plugin.prepareMobileLogin();
    expect(harness.request).toHaveBeenCalledOnce();
    mockPreparation();
    expect(loginLink().fire("keydown", { key: "Enter" }).defaultPrevented).toBe(true);
    await plugin.prepareMobileLogin();
    expect(loginLink().textContent).toBe("登录");
    expect(plugin.currentStatus.phase).toBe("idle");
    expect(harness.open).not.toHaveBeenCalled();
    await plugin.onunload();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows registration failure and lets either login entry retry preparation", async () => {
    harness.request.mockResolvedValueOnce({ status: 200, json: {} })
      .mockResolvedValueOnce({ status: 503, json: {} });
    const plugin = await loadPlugin();
    await plugin.prepareMobileLogin();
    expect(latestRow("请登录 360AI 云盘账号").descEl.textContent).toContain("注册授权客户端失败（HTTP 503）");
    mockPreparation();
    expect(loginLink("远程目录").fire("click").defaultPrevented).toBe(true);
    await plugin.prepareMobileLogin();
    expect(loginLink().textContent).toBe("登录");
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    await plugin.onunload();
  });

  it("ignores a late preparation after unload and refuses clicks from detached UI", async () => {
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const plugin = await loadPlugin();
    await vi.dynamicImportSettled();
    const operation = plugin.prepareMobileLogin();
    const link = loginLink();
    await plugin.onunload();
    await operation;
    resolve({ status: 200, json: {} });
    await vi.dynamicImportSettled();
    expect(plugin.mobileLoginPreparation.ready).toBeUndefined();
    expect(link.fire("click").defaultPrevented).toBe(true);
    expect(harness.request).toHaveBeenCalledOnce();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it("cancels the active authorization and next preparation while preserving existing credentials", async () => {
    vi.useFakeTimers();
    const plugin = await preparedPlugin();
    const existing = JSON.stringify(storedAuth());
    harness.secrets.set(AUTH_SECRET_ID, existing);
    // Simulate the next preparation stalling after the first authorization is activated.
    harness.secrets.delete(AUTH_SECRET_ID);
    const operation = plugin.login();
    harness.request.mockImplementation(() => new Promise(() => {}));
    await vi.dynamicImportSettled();
    const nextPreparation = plugin.prepareMobileLogin();
    harness.secrets.set(AUTH_SECRET_ID, existing);
    tabs.at(-1)!.hide();
    plugin.cancelLogin();
    await Promise.all([operation, nextPreparation]);
    expect(plugin.currentStatus.message).toBe("登录已取消");
    expect(harness.secrets.get(AUTH_SECRET_ID)).toBe(existing);
    expect(harness.secrets.get(MOBILE_PENDING_OAUTH_SECRET_ID)).toBe("");
    expect(plugin.mobileLoginPreparation.ready).toBeUndefined();
    expect(plugin.mobileLoginPreparation.preparing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await plugin.onunload();
  });

  it("restarts with fresh state and rejects old callbacks without consuming the current state", async () => {
    const plugin = await preparedPlugin();
    const first = plugin.login(); const oldState = pending().state;
    await plugin.prepareMobileLogin();
    const second = plugin.relogin();
    await first;
    const newState = pending().state;
    expect(newState).not.toBe(oldState);
    harness.protocolHandler!({ code: "old-code", state: oldState });
    await vi.dynamicImportSettled();
    expect(pending().state).toBe(newState);
    expect(harness.request.mock.calls.filter(([request]) => request.url.includes("mobile-exchange"))).toHaveLength(0);
    tabs.at(-1)!.hide();
    plugin.cancelLogin(); await second;
    harness.protocolHandler!({ code: "late-code", state: newState });
    await vi.dynamicImportSettled();
    expect(plugin.auth).toBeUndefined();
    await plugin.onunload();
  });

  it("does not let a cancelled token exchange resolve the replacement login", async () => {
    const plugin = await preparedPlugin();
    const first = plugin.login(); const oldState = pending().state;
    await plugin.prepareMobileLogin();
    let resolve!: (value: unknown) => void;
    harness.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    harness.protocolHandler!({ code: "old-code", state: oldState });
    await vi.dynamicImportSettled();
    const second = plugin.relogin(); const newState = pending().state;
    await first; await plugin.prepareMobileLogin();
    resolve({ status: 200, json: { oauth_code: "cancelled-oauth-code" } });
    await vi.dynamicImportSettled();
    expect(plugin.auth).toBeUndefined();
    expect(pending().state).toBe(newState);
    harness.request.mockResolvedValueOnce({ status: 403, json: {} });
    harness.protocolHandler!({ code: "new-code", state: newState });
    await second;
    expect(plugin.currentStatus.message).toContain("HTTP 403");
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(latestRow("浏览器授权").settingEl.hidden).toBe(true);
    await plugin.onunload();
  });

  it.each(["iPhone", "Android"])("retains the manual link and copying on %s, then clears them on timeout", async platform => {
    vi.useFakeTimers();
    harness.platform.isIosApp = platform === "iPhone";
    harness.platform.isAndroidApp = platform === "Android";
    const plugin = await preparedPlugin();
    const operation = plugin.login();
    const url = plugin.pendingAuthorizationUrl!;
    const authorization = latestRow("浏览器授权");
    const fallback = links.filter(entry => entry.textContent === "打开授权页面").at(-1)!;
    expect(fallback.attributes).toMatchObject({ href: url, target: "_blank", rel: "noopener noreferrer" });
    expect(authorization.settingEl.parent?.attributes["aria-label"]).toBe("账号设置");
    await authorization.buttons[0]!.click!();
    expect(harness.copy).toHaveBeenCalledWith(url);
    harness.copy.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await authorization.buttons[0]!.click!();
    expect(harness.notice).toHaveBeenCalledWith("无法自动复制，请长按“打开授权页面”链接复制");
    await plugin.prepareMobileLogin();
    await vi.advanceTimersByTimeAsync(180_001);
    await operation;
    expect(plugin.currentStatus.message).toContain("授权超时");
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(authorization.settingEl.hidden).toBe(true);
    expect(harness.secrets.get(MOBILE_PENDING_OAUTH_SECRET_ID)).toBe("");
    expect(harness.open).not.toHaveBeenCalled();
    await plugin.onunload();
  });

  it("only prepares when login is called without a ready authorization", async () => {
    mockPreparation();
    const plugin = await loadPlugin();
    await plugin.login();
    expect(plugin.mobileLoginPreparation.ready).toBeDefined();
    expect(plugin.pendingAuthorizationUrl).toBeUndefined();
    expect(harness.open).not.toHaveBeenCalled();
    await plugin.onunload();
  });

  it("supports restart and cancel from desktop settings", async () => {
    harness.platform.isMobileApp = false;
    const plugin = await loadPlugin();
    const first = plugin.login();
    await vi.dynamicImportSettled();
    const account = rows.find(row => row.name === "请登录 360AI 云盘账号")!;
    expect(account.buttons[0]!.label).toBe("重新登录");
    const second = account.buttons[0]!.click!();
    await vi.dynamicImportSettled();
    await first;
    account.buttons[1]!.click!();
    await second;
    expect(account.buttons[0]!.label).toBe("重新登录");
    expect(plugin.currentStatus.message).toBe("登录已取消");
    expect(harness.open).toHaveBeenCalledTimes(2);
  });
});
