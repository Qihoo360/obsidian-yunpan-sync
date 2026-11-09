import { requiresProductionReset } from "./production-migration.js";
import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  Platform,
  normalizePath,
  requestUrl,
  requireApiVersion,
  type RequestUrlParam,
  type ButtonComponent,
} from "obsidian";
import { exchangeOAuthCode } from "./auth/oauth.js";
import { loginCancelledError } from "./auth/cancellation.js";
import { AuthRefreshCoordinator, OAuthCodeUnavailableError, ReloginRequiredError } from "./auth/refresh.js";
import { SecretStore, type CloudAuth } from "./auth/secrets.js";
import {
  accountDisplayIdentity,
  formatStorageCapacity,
  normalizeAccountProfile,
  type AccountProfile,
} from "./account/profile.js";
import { OpenApiClient, type HttpRequest } from "./net/openapi-client.js";
import { DEFAULT_SETTINGS, ensureDeviceId, normalizeSettings, pollIntervalMs,
  type FilterRule, type PluginSettings } from "./settings.js";
import { DatabasePersistence } from "./storage/persistence.js";
import { SyncEngine, type EngineStatus } from "./sync/engine.js";
import { DownloadMachine } from "./transfer/download.js";
import { StoreClient } from "./transfer/store-client.js";
import { UploadMachine } from "./transfer/upload.js";
import { normalizeRemoteRoot, shouldIgnorePath } from "./domain/paths.js";
import { OPENAPI_SIGNING_SECRET } from "./config/openapi.js";
import { initialStatus, restoredStatus } from "./status.js";
import { completionNotice, isSuccessfulSyncMessage } from "./sync/outcome.js";
import { summarizeTransfers, type FileTransferProgress } from "./sync/progress.js";
import { SyncProgressModal, SyncTaskPreviewModal } from "./ui/sync-modal.js";
import { openPluginSettings } from "./ui/plugin-settings.js";
import type { SyncConflict, SyncTask } from "./storage/database.js";
import { RemoteDirectoryModal } from "./ui/remote-directory-modal.js";
import { YUNPAN_STATUS_VIEW, YunpanStatusView } from "./ui/status-view.js";
import { classifySyncError } from "./sync/error-guidance.js";
import { openFeedbackLink, openProductLink } from "./ui/product-links.js";


import { hasActiveMembership, membershipIcon } from "./ui/account-membership.js";
import { FilterRulesModal } from "./ui/filter-rules-modal.js";
import { RELOGIN_MESSAGE, statusBarDestination } from "./ui/auth-state.js";
import { interruptSyncForDisconnect, resumeSyncAfterReconnect } from "./sync/connectivity.js";
import { PluginLifecycleTimers, settleForPause } from "./lifecycle.js";
import { openVaultPath } from "./ui/open-vault-path.js";
import { dismissKeyboardOnBlankTap } from "./ui/dismiss-keyboard.js";

const DEBOUNCE_MS = 1500;

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export default class YunpanSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private secrets!: SecretStore;
  private persistence?: DatabasePersistence;
  private engine?: SyncEngine;
  private status: EngineStatus = initialStatus();
  private statusBar?: HTMLElement;
  private settingTab?: YunpanSyncSettingTab;
  private api?: OpenApiClient;
  private authRefresh?: AuthRefreshCoordinator;
  private accountProfile?: AccountProfile;
  private accountProfileLoading = false;
  private accountProfileError?: string;
  private transfers: FileTransferProgress[] = [];
  private syncModal?: SyncProgressModal;
  private syncUiHidden = false;
  private removingFailure = false;
  private displayedSyncWarnings = new Set<string>();
  private expiredAuthQid?: string;
  private readonly lifecycle = new PluginLifecycleTimers();
  private mobileLoginWaiter?: { resolve: (auth: CloudAuth) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private mobileCallbackState?: string;
  private mobileAuthorizationUrl?: string;
  private loginAttempt?: AbortController;
  private loginGeneration = 0;

  async onload(): Promise<void> {
    if (!requireApiVersion(this.manifest.minAppVersion)) {
      new Notice("版本过低，请先升级 obsidian", 10000);
      return;
    }
    const persisted = await this.loadData() as Partial<PluginSettings> | null | undefined;
    this.settings = normalizeSettings(persisted);
    const createdDeviceId = ensureDeviceId(this.settings);
    this.secrets = new SecretStore(this.app.secretStorage);
    // Obsidian removes plugin settings on uninstall but retains Secret Storage.
    // Clear orphaned authorization only on a fresh install, not on every unload.
    if (persisted == null) {
      this.secrets.clearAuth();
      this.secrets.clearPendingOAuth();
    }
    this.registerObsidianProtocolHandler("yunpan-sync", (params) => {
      void this.handleMobileOAuthCallback(params as Record<string, string>);
    });
    this.authRefresh = new AuthRefreshCoordinator(
      () => this.secrets.getAuth(),
      (auth) => this.secrets.setAuth(auth),
      (oauthCode) => exchangeOAuthCode(this.settings.openapiBaseUrl, oauthCode),
    );
    const pluginDir = this.manifest.dir;
    if (!pluginDir) throw new Error("Plugin directory is unavailable");
    this.persistence = await DatabasePersistence.open(this.app.vault.adapter, normalizePath(pluginDir));
    if (requiresProductionReset(persisted)) {
      this.secrets.clearAuth();
      this.secrets.clearPendingOAuth();
      this.persistence.database.clearProductionBinding();
      await this.persistence.save();
      await this.saveData(this.settings);
      new Notice("服务已更新为生产环境，请重新登录并确认同步目录");
    } else if (createdDeviceId) await this.saveData(this.settings);
    this.persistence.database.recoverInterruptedTasks();
    
    await this.persistence.save();
    const restoredCounts = this.persistence.database.taskCounts();
    const restoredFailures = this.persistence.database.listFailedTasks();
    this.status = restoredStatus(this.auth, this.persistence.database.getLastSuccessfulSync(), restoredCounts, restoredFailures);
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass("yunpan-sync-status");
    this.statusBar.setAttr("aria-label", "打开 360AI 云盘同步状态");
    this.statusBar.addEventListener("click", () => this.handleStatusBarClick());
    this.registerView(YUNPAN_STATUS_VIEW, (leaf) => new YunpanStatusView(leaf, this));
    this.addRibbonIcon("refresh-cw", "立即同步 360AI 云盘", () => void this.syncNow());
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow() });
    this.addCommand({ id: "pause", name: "暂停同步", callback: () => void this.setPaused(true) });
    this.addCommand({ id: "resume", name: "恢复同步", callback: () => void this.setPaused(false) });
    this.addCommand({ id: "retry-failed", name: "重试失败任务", callback: () => void this.retryFailed() });
    this.addCommand({ id: "rebuild-index", name: "自动修复同步状态", callback: () => void this.syncNow(true) });
    this.addCommand({ id: "show-sync-progress", name: "显示同步进度", callback: () => this.showSyncProgress() });
    this.addCommand({ id: "show-sync-status", name: "打开同步状态侧边栏", callback: () => void this.openStatusView() });
    
    this.settingTab = new YunpanSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultEvent(file.path)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onVaultRename(oldPath, file.path)));
    this.registerDomEvent(window, "offline", () => { interruptSyncForDisconnect(this.engine); });
    this.registerDomEvent(window, "online", () => void resumeSyncAfterReconnect(
      () => this.settings.paused || this.isMobileBackgrounded || this.settings.mode === "manual",
      this.engine,
      () => this.syncNow(false, false),
    ));
    this.registerDomEvent(document, "visibilitychange", () => void this.handleVisibilityChange());
    await this.configureEngine();
    this.configureSchedule();
    this.renderStatus();
    if (this.auth) void this.refreshAccountProfile(false);
  }

  async onunload(): Promise<void> {
    this.settingTab?.hide();
    this.endLoginAttempt();
    this.lifecycle.dispose();
    if (this.isMobileDevice) await settleForPause(true, this.engine);
    await this.persistence?.close();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.configureSchedule();
    this.settingTab?.display();
  }

  get currentStatus(): EngineStatus { return this.status; }
  get failedTasks(): readonly SyncTask[] { return this.status.failedTasks ?? []; }
  get auth(): CloudAuth | undefined { return this.secrets.getAuth(); }
  get profile(): AccountProfile | undefined { return this.accountProfile; }
  get profileLoading(): boolean { return this.accountProfileLoading; }
  get profileError(): string | undefined { return this.accountProfileError; }
  get isPaused(): boolean { return this.settings.paused; }
  get isSyncing(): boolean { return this.removingFailure || (this.engine?.isRunning() ?? false); }
  get transferProgress(): readonly FileTransferProgress[] { return this.transfers; }
  get conflicts(): readonly SyncConflict[] { return this.persistence?.database.listUnresolvedConflicts() ?? []; }
  get isMobileDevice(): boolean { return Platform.isMobileApp; }
  private get isMobileBackgrounded(): boolean {
    return this.isMobileDevice && document.visibilityState === "hidden";
  }
  get pendingAuthorizationUrl(): string | undefined {
    return this.status.phase === "login" ? this.mobileAuthorizationUrl : undefined;
  }

  async copyMobileAuthorizationLink(): Promise<void> {
    const url = this.pendingAuthorizationUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      new Notice("授权链接已复制，请在手机浏览器中粘贴打开");
    } catch {
      new Notice("无法自动复制，请长按“打开授权页面”链接复制");
    }
  }

  private endLoginAttempt(): void {
    const attempt = this.loginAttempt;
    this.loginAttempt = undefined;
    this.loginGeneration++;
    this.mobileAuthorizationUrl = undefined;
    this.mobileCallbackState = undefined;
    this.secrets?.clearPendingOAuth();
    if (this.mobileLoginWaiter) {
      clearTimeout(this.mobileLoginWaiter.timer);
      this.mobileLoginWaiter.reject(loginCancelledError());
      this.mobileLoginWaiter = undefined;
    }
    attempt?.abort();
  }

  cancelLogin(): void {
    if (!this.loginAttempt && this.status.phase !== "login") return;
    this.endLoginAttempt();
    this.updateStatus({ phase: "idle", message: "登录已取消", queued: 0, failed: 0 });
    this.settingTab?.renderLogin();
  }

  async relogin(): Promise<void> {
    this.endLoginAttempt();
    await this.login();
  }

  async login(): Promise<void> {
    if (this.loginAttempt) return;
    // Also invalidate a restored mobile callback that may still be exchanging tokens.
    this.endLoginAttempt();
    const attempt = new AbortController();
    this.loginAttempt = attempt;
    const generation = this.loginGeneration;
    const current = () => this.loginAttempt === attempt && !attempt.signal.aborted;
    try {
      const previousQid = this.auth?.qid ?? this.expiredAuthQid;
      this.updateStatus({ phase: "login", message: "等待浏览器授权", queued: 0, failed: 0 });
      let auth: CloudAuth;
      if (this.isMobileDevice) {
        const { MobileOAuth } = await import("./auth/oauth-mobile.js");
        if (!current()) return;
        const oauth = new MobileOAuth(this.settings.environment, this.settings.openapiBaseUrl, (message) => {
          if (current()) this.updateStatus({ phase: "login", message, queued: 0, failed: 0 });
        }, attempt.signal);
        let authorizationUrl = "";
        const pending = await oauth.start((url) => { authorizationUrl = url; });
        if (!current()) return;
        this.secrets.setPendingOAuth(pending);
        this.mobileAuthorizationUrl = authorizationUrl;
        // Install the callback waiter before handing control to the browser.
        const authorization = new Promise<CloudAuth>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!current() || this.mobileLoginWaiter?.timer !== timer) return;
            this.mobileLoginWaiter = undefined;
            this.secrets.clearPendingOAuth();
            reject(new Error("等待云盘 OAuth 授权超时"));
          }, 180_000);
          this.mobileLoginWaiter = { resolve, reject, timer };
        });
        this.updateStatus({ phase: "login", message: "等待浏览器授权；若未自动打开，请点击下方“打开授权页面”", queued: 0, failed: 0 });
        this.settingTab?.display();
        // Mobile WebViews can silently ignore scripted popups after async work.
        // Keep a native link in settings so a direct user gesture can navigate.
        try {
          window.open(authorizationUrl);
          
        } catch {
          
          new Notice("请点击“打开授权页面”继续授权");
        }
        auth = await authorization;
      } else {
        const { DesktopOAuth } = await import("./auth/oauth-desktop.js");
        if (!current()) return;
        const oauth = new DesktopOAuth(this.settings.environment, this.settings.openapiBaseUrl);
        auth = await oauth.login((url) => window.open(url, "_blank"), 180_000, attempt.signal);
      }
      if (!current()) return;
      if (previousQid && previousQid !== auth.qid) this.persistence?.database.resetSyncState();
      this.secrets.setAuth(auth);
      
      this.expiredAuthQid = undefined;
      await this.configureEngine();
      if (!current()) return;
      this.updateStatus({ phase: "idle", message: "已登录", queued: 0, failed: 0 });
      this.settingTab?.display();
      new Notice("360AI 云盘登录成功");
      await this.refreshAccountProfile(false);
    } catch (error) {
      if (!current()) return;
      this.updateStatus({ phase: "error", message: messageOf(error), queued: 0, failed: 0, lastError: messageOf(error) });
      new Notice(`登录失败: ${messageOf(error)}`);
    } finally {
      if (current()) {
        this.loginAttempt = undefined;
        this.mobileAuthorizationUrl = undefined;
        this.secrets.clearPendingOAuth();
        this.settingTab?.renderLogin();
        try { await this.persistence?.save(); }
        catch { if (this.loginGeneration === generation) new Notice("登录状态保存失败，请重试"); }
      }
    }
  }

  async logout(): Promise<void> {
    this.endLoginAttempt();
    if (this.engine?.isRunning()) {
      this.engine.cancel();
      await this.engine.waitForIdle();
    }
    this.unconfirmCurrentBinding();
    this.secrets.clearAuth();
    this.expiredAuthQid = undefined;
    this.accountProfile = undefined;
    this.accountProfileError = undefined;
    this.updateTransfers([]);
    this.api = undefined;
    this.persistence?.database.resetSyncState();
    await this.persistence?.save();
    this.engine = undefined;
    this.updateStatus({ phase: "idle", message: "未登录", queued: 0, failed: 0 });
    this.settingTab?.display();
  }

  private async handleMobileOAuthCallback(params: Record<string, string>): Promise<void> {
    const pending = this.secrets.getPendingOAuth();
    // Ignore old browser pages before consuming the current authorization state.
    if (!pending || params.state !== pending.state || this.mobileCallbackState === pending.state) return;
    const generation = this.loginGeneration;
    const attempt = this.loginAttempt;
    const waiter = this.mobileLoginWaiter;
    const current = () => this.loginGeneration === generation && !attempt?.signal.aborted;
    this.mobileCallbackState = pending.state;
    this.mobileAuthorizationUrl = undefined;
    this.settingTab?.renderLogin();
    this.secrets.clearPendingOAuth();
    try {
      const { MobileOAuth } = await import("./auth/oauth-mobile.js");
      if (!current()) return;
      const oauth = new MobileOAuth(this.settings.environment, this.settings.openapiBaseUrl, undefined, attempt?.signal);
      const auth = await oauth.complete(params, pending);
      if (!current()) return;
      if (waiter) {
        if (this.mobileLoginWaiter !== waiter) return;
        clearTimeout(waiter.timer);
        this.mobileLoginWaiter = undefined;
        waiter.resolve(auth);
      } else {
        this.secrets.setAuth(auth);
        await this.configureEngine();
        if (!current()) return;
        new Notice("360AI 云盘登录成功");
        this.settingTab?.display();
        await this.refreshAccountProfile(false);
      }
    } catch (error) {
      if (!current()) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      if (waiter) {
        if (this.mobileLoginWaiter !== waiter) return;
        clearTimeout(waiter.timer);
        this.mobileLoginWaiter = undefined;
        waiter.reject(failure);
      } else {
        new Notice(`登录失败: ${failure.message}`);
      }
    } finally {
      if (this.mobileCallbackState === pending.state) this.mobileCallbackState = undefined;
    }
  }

  

  async setRemoteRoot(value: string): Promise<void> {
    const root = normalizeRemoteRoot(value);
    if (root === normalizeRemoteRoot(this.settings.remoteRoot)) return;
    this.persistence?.database.resetSyncState();
    this.settings.remoteRoot = root;
    await this.persistence?.save();
    await this.saveSettings();
    await this.configureEngine();
    this.updateStatus({ phase: "idle", message: "远端目录已变更，将在下次同步重建基线", queued: 0, failed: 0 });
  }

  async syncNow(rebuild = false, interactive = true): Promise<void> {
    if (this.isMobileBackgrounded) return;
    if (this.removingFailure) {
      if (interactive) new Notice("正在保存失败记录，请稍后同步");
      return;
    }
    if (!this.engine) {
      if (interactive) {
        new Notice("请先登录 360AI 云盘");
        openPluginSettings(this.app as App & { setting: { open(): void; openTabById(id: string): void } }, this.manifest.id);
      }
      return;
    }
    if (this.settings.paused) {
      if (interactive) new Notice("同步已暂停，请先恢复同步");
      return;
    }
    if (interactive && !this.engine.isRunning()) {
      this.syncUiHidden = false;
      this.updateStatus({ ...this.status, phase: "prepare", message: "准备同步", lastError: undefined });
    }
    if (interactive) this.showSyncProgress();
    try {
      const initialConfirmation = this.engine.needsInitialConfirmation();
      if (initialConfirmation && !interactive) {
        this.updateStatus({ ...this.status, phase: "paused", message: "等待首次同步确认" });
        return;
      }
      await this.engine.synchronize(rebuild, initialConfirmation
        ? (tasks) => this.confirmSyncTasks(tasks, true) : undefined);
      await this.persistence?.save();
      if (this.status.phase === "idle" && isSuccessfulSyncMessage(this.status.message)) {
        new Notice(completionNotice(this.status.message));
        if (this.conflicts.length > 0) new Notice(`检测到 ${this.conflicts.length} 个冲突，已保留双方文件`);
      }
    } catch (error) {
      await this.persistence?.save();
      if (this.handleAuthError(error)) return;
      const guidance = classifySyncError(error);
      this.updateStatus({ ...this.status, phase: "error", message: guidance.title, lastError: guidance.detail });
      new Notice(`${guidance.title}: ${guidance.detail}`);
    } finally {
      this.syncModal?.render();
      this.refreshStatusViews();
    }
  }

  async refreshAccountProfile(showFailureNotice = true): Promise<void> {
    if (!this.auth || !this.api || this.accountProfileLoading) return;
    this.accountProfileLoading = true;
    this.accountProfileError = undefined;
    this.settingTab?.display();
    try {
      const data = await this.api.call<Record<string, unknown>>("User.getUserDetail", {});
      const qid = this.auth?.qid;
      if (!qid) return;
      this.accountProfile = normalizeAccountProfile(data ?? {}, qid);
      if (this.status.phase === "idle" && this.status.message.startsWith("已登录")) {
        this.updateStatus({ ...this.status, message: `已登录 ${accountDisplayIdentity(this.accountProfile)}` });
      }
      
    } catch (error) {
      if (this.handleAuthError(error)) return;
      this.accountProfileError = messageOf(error);
      
      if (showFailureNotice) new Notice(`账户信息刷新失败: ${this.accountProfileError}`);
    } finally {
      this.accountProfileLoading = false;
      this.settingTab?.display();
    }
  }

  async retryFailed(): Promise<void> {
    if (this.removingFailure) { new Notice("正在保存失败记录，请稍后重试"); return; }
    const count = this.engine?.retryFailed() ?? 0;
    await this.persistence?.save();
    new Notice(`已重新排队 ${count} 个任务`);
    if (count) await this.syncNow();
  }

  async retryTask(id: string): Promise<void> {
    if (this.removingFailure) { new Notice("正在保存失败记录，请稍后重试"); return; }
    if (!this.engine?.retryTask(id)) { new Notice("该任务当前不可重试"); return; }
    await this.persistence?.save();
    await this.syncNow();
  }

  async removeFailedTask(id: string): Promise<void> {
    if (this.isSyncing) {
      new Notice("同步进行中，暂时不能删除失败记录");
      return;
    }
    if (!this.engine) { new Notice("同步引擎尚未就绪，请先登录后重试"); return; }
    this.removingFailure = true;
    let removed = false;
    try {
      if (!this.engine.removeFailedTask(id)) {
        new Notice("该失败记录已不存在或不可删除");
        return;
      }
      removed = true;
      await this.persistence?.save();
      new Notice(this.status.failed === 0 ? "失败记录已清除，可重新同步" : "失败记录已删除");
    } catch (error) {
      new Notice(removed ? `记录已从当前会话移除，但保存失败，重启后可能恢复：${messageOf(error)}`
        : `删除失败记录失败：${messageOf(error)}`);
    } finally {
      this.removingFailure = false;
      this.syncModal?.render();
      this.refreshStatusViews();
    }
  }

  async resolveConflict(id: number): Promise<void> {
    if (this.persistence?.database.resolveConflict(id)) await this.persistence.save();
    this.refreshStatusViews();
    this.settingTab?.display();
  }

  async setPaused(paused: boolean): Promise<void> {
    this.settings.paused = paused;
    await settleForPause(paused, this.engine);
    await this.saveSettings();
    this.updateStatus({ ...this.status, phase: paused ? "paused" : "idle", message: paused ? "同步已暂停" : "同步已恢复" });
  }

  cancelSync(): void {
    this.engine?.cancel();
    new Notice("将在当前文件安全结束后停止同步");
  }

  showSyncProgress(): void {
    this.syncUiHidden = false;
    this.syncModal?.closeForTransition();
    this.syncModal = new SyncProgressModal(this);
    this.syncModal.open();
  }

  async chooseRemoteRoot(): Promise<void> {
    if (!this.api) { new Notice("请先登录 360AI 云盘"); return; }
    const selected = await new RemoteDirectoryModal(this.app, this.api).choose();
    if (selected) await this.setRemoteRoot(selected);
  }

  async setSyncObsidianConfig(enabled: boolean): Promise<void> {
    if (enabled === this.settings.syncObsidianConfig) return;
    this.settings.syncObsidianConfig = enabled;
    await this.resetSyncScope("Obsidian 配置同步范围已变更");
  }

  async setExcludedExtensions(value: string): Promise<void> {
    if (value === this.settings.excludedExtensions) return;
    this.settings.excludedExtensions = value;
    await this.resetSyncScope("过滤规则已变更");
  }

  async setFilterRules(rules: FilterRule[]): Promise<void> {
    this.settings.filterRules = rules.map((rule) => ({ ...rule }));
    this.settings.excludedExtensions = "";
    await this.resetSyncScope("过滤规则已变更");
  }

  showFilterRules(): void {
    new FilterRulesModal(this.app, this.settings.filterRules,
      (rules) => this.setFilterRules(rules)).open();
  }

  async openStatusView(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(YUNPAN_STATUS_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      await leaf?.setViewState({ type: YUNPAN_STATUS_VIEW, active: true });
    }
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }

  async openVaultPath(path: string): Promise<void> {
    await openVaultPath(this.app, path);
  }

  async hasVaultFile(path: string): Promise<boolean> {
    try {
      const normalized = normalizePath(path);
      if (this.app.vault.getFileByPath(normalized)) return true;
      return (await this.app.vault.adapter.stat(normalized))?.type === "file";
    } catch {
      return false;
    }
  }

  

  

  

  hideSyncProgress(modal: SyncProgressModal): void {
    if (this.syncModal !== modal) return;
    this.syncUiHidden = true;
    this.syncModal = undefined;
  }

  private async configureEngine(): Promise<void> {
    const auth = this.auth;
    if (!auth || !this.persistence) { this.api = undefined; this.engine = undefined; return; }
    const api = new OpenApiClient({
      baseUrl: this.settings.openapiBaseUrl,
      accessToken: () => this.secrets.getAuth()?.accessToken ?? "",
      qid: () => this.secrets.getAuth()?.qid ?? "",
      cloudToken: () => this.secrets.getAuth()?.token ?? "",
      accessTokenExpiresAt: () => this.secrets.getAuth()?.expiresAt ?? 0,
      refreshAccessToken: () => this.authRefresh!.refresh(),
      signingSecret: () => OPENAPI_SIGNING_SECRET,
      transport: async (request: HttpRequest) => {
        const options: RequestUrlParam = { url: request.url, method: request.method, headers: request.headers, body: request.body, throw: false };
        const response = await requestUrl(options);
        let json: unknown;
        try { json = response.json; } catch { json = undefined; }
        return { status: response.status, json, text: response.text };
      },
    });
    this.api = api;
    const makeStore = (url: string) => {
      const current = this.secrets.getAuth();
      if (!current) throw new ReloginRequiredError("登录凭据已失效，请重新登录");
      return new StoreClient(url, { qid: current.qid, token: current.token }, {
        deviceId: this.settings.deviceId,
        deviceName: this.settings.deviceName,
        version: this.manifest.version,
      });
    };
    const ownerQid = () => this.settings.ownerQid;
    const checkpoint = () => this.persistence!.save();
    this.engine = new SyncEngine(this.app.vault, this.persistence.database, api,
      new UploadMachine(api, makeStore, this.persistence.database, ownerQid, checkpoint),
      new DownloadMachine(api, makeStore, ownerQid), () => this.settings,
      `${auth.qid}:${this.app.vault.getName()}:${normalizeRemoteRoot(this.settings.remoteRoot)}`,
      (status) => this.updateStatus(status), checkpoint,
      (transfers) => this.updateTransfers(transfers));
  }

  private handleReloginRequired(error: unknown): boolean {
    if (!(error instanceof ReloginRequiredError)) return false;
    this.requireInteractiveLogin(error);
    return true;
  }

  private requireInteractiveLogin(error: OAuthCodeUnavailableError | ReloginRequiredError): void {
    this.expiredAuthQid = this.auth?.qid ?? this.expiredAuthQid;
    
    this.secrets.clearAuth();
    this.api = undefined;
    this.engine = undefined;
    this.accountProfile = undefined;
    this.accountProfileError = undefined;
    this.updateTransfers([]);
    this.updateStatus({ phase: "error", message: RELOGIN_MESSAGE, queued: 0, failed: 0 });
    this.settingTab?.display();
    new Notice("请重新登录 360AI 云盘");
  }

  private handleAuthError(error: unknown): boolean {
    if (error instanceof OAuthCodeUnavailableError) {
      this.requireInteractiveLogin(error);
      return true;
    }
    return this.handleReloginRequired(error);
  }

  private handleStatusBarClick(): void {
    if (statusBarDestination(Boolean(this.auth), this.status.message) === "settings") {
      openPluginSettings(this.app as App & { setting: { open(): void; openTabById(id: string): void } }, this.manifest.id);
      return;
    }
    void this.openStatusView();
  }

  private configureSchedule(): void {
    this.lifecycle.configurePolling(this.isMobileBackgrounded ? undefined : pollIntervalMs(this.settings),
      () => void this.syncNow(false, false));
  }

  private async handleVisibilityChange(): Promise<void> {
    if (!this.isMobileDevice) return;
    this.configureSchedule();
    if (document.visibilityState === "hidden") {
      await settleForPause(true, this.engine);
      await this.persistence?.save();
    }
  }

  private onVaultEvent(path: string): void {
    const filter = { syncObsidianConfig: this.settings.syncObsidianConfig,
      filterRules: this.settings.filterRules, pluginId: this.manifest.id };
    if (this.isMobileBackgrounded || this.settings.mode !== "automatic" || this.settings.paused || shouldIgnorePath(path, filter) || this.engine?.consumeSuppression(path)) return;
    this.scheduleDebouncedSync();
  }

  private async onVaultRename(source: string, destination: string): Promise<void> {
    this.engine?.recordRename(source, destination);
    await this.persistence?.save();
    if (!this.isMobileBackgrounded && this.settings.mode === "automatic" && !this.settings.paused) this.scheduleDebouncedSync();
  }

  private scheduleDebouncedSync(): void {
    this.lifecycle.debounce(DEBOUNCE_MS, () => void this.syncNow(false, false));
  }

  private updateStatus(status: EngineStatus): void {
    this.status = status;
    for (const warning of status.warnings ?? []) {
      if (!this.displayedSyncWarnings.has(warning)) new Notice(warning);
    }
    this.displayedSyncWarnings = new Set(status.warnings ?? []);
    this.renderStatus();
    this.settingTab?.renderStatus();
    this.settingTab?.renderLogin();
    this.syncModal?.render();
    this.refreshStatusViews();
  }

  

  private updateTransfers(transfers: FileTransferProgress[]): void {
    this.transfers = transfers;
    this.renderStatus();
    this.settingTab?.renderTransfers();
    this.syncModal?.render();
    this.refreshStatusViews();
  }

  private renderStatus(): void {
    if (!this.statusBar) return;
    const queue = this.status.queued ? ` · 队列 ${this.status.queued}` : "";
    const active = this.transfers.find((transfer) => transfer.state === "transferring");
    const transfer = active
      ? ` · ${active.direction === "upload" ? "上传" : "下载"} ${this.transferPercent(active)}%`
      : "";
    this.statusBar.setText(`360AI云盘: ${this.status.message}${queue}${transfer}`);
    this.statusBar.toggleClass("yunpan-sync-error", this.status.phase === "error");
  }
  private transferPercent(transfer: FileTransferProgress): number {
    if (transfer.state === "completed") return 100;
    if (transfer.totalBytes <= 0) return 0;
    return Math.min(100, Math.round(transfer.completedBytes / transfer.totalBytes * 100));
  }

  private async confirmSyncTasks(tasks: readonly SyncTask[], initial = false): Promise<ReadonlySet<string> | undefined> {
    this.syncModal?.closeForTransition();
    this.syncModal = undefined;
    if (this.syncUiHidden && !initial) return new Set(tasks.map((task) => task.id));
    const selected = await new SyncTaskPreviewModal(this, tasks, this.settings.remoteRoot, initial).choose();
    if (selected?.size) this.showSyncProgress();
    return selected;
  }

  private refreshStatusViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(YUNPAN_STATUS_VIEW)) {
      const view = leaf.view;
      if (view instanceof YunpanStatusView) view.render();
    }
  }

  private async resetSyncScope(message: string): Promise<void> {
    this.unconfirmCurrentBinding();
    this.persistence?.database.resetSyncState();
    await this.persistence?.save();
    await this.saveSettings();
    await this.configureEngine();
    this.updateStatus({ phase: "idle", message: `${message}，首次同步前需要确认`, queued: 0, failed: 0 });
  }

  private unconfirmCurrentBinding(): void {
    const auth = this.auth;
    if (!auth) return;
    this.persistence?.database.unconfirmBinding(
      `${auth.qid}:${this.app.vault.getName()}:${normalizeRemoteRoot(this.settings.remoteRoot)}`);
  }
}

class YunpanSyncSettingTab extends PluginSettingTab {
  private stopDismiss?: () => void;
  private statusEl?: HTMLElement;
  private transfersEl?: HTMLElement;
  private loginStatusEl?: HTMLElement;
  private authorizationEl?: HTMLElement;
  private loginButtons: ButtonComponent[] = [];
  private cancelLoginButton?: ButtonComponent;
  constructor(app: App, private readonly owner: YunpanSyncPlugin) { super(app, owner); }

  display(): void {
    this.hide();
    const { containerEl } = this;
    containerEl.empty();
    this.loginButtons = [];
    this.cancelLoginButton = undefined;
    this.loginStatusEl = undefined;
    this.authorizationEl = undefined;
    containerEl.addClass("yunpan-sync-settings-page");
    
    new Setting(containerEl).setName("账号设置").setHeading();
    this.renderAccount(this.createGroup("账号设置"));

    new Setting(containerEl).setName("同步设置").setHeading();
    const syncGroup = this.createGroup("同步设置");
    const remote = new Setting(syncGroup).setName("远程目录")
      .setDesc("请选择云端已有的文件夹，或在选择器中创建新文件夹");
    remote.settingEl.addClass("yunpan-sync-remote-root-setting");
    remote.settingEl.append(remote.descEl);
    if (this.owner.auth) remote
      .addText((text) => { text.setValue(this.owner.settings.remoteRoot); text.inputEl.readOnly = true; })
      .addButton((button) => button.setButtonText("选择").onClick(() => void this.owner.chooseRemoteRoot()));
    else remote.addButton((button) => {
      this.loginButtons.push(button);
      button.setButtonText("登录").setCta().onClick(() => void this.startLogin());
    });

    new Setting(syncGroup).setName("同步模式")
      .setDesc(this.owner.isMobileDevice ? "移动端自动同步仅在前台运行，切到后台会暂停；默认手动" : "建议选择自动同步模式，可以实时自动为您同步")
      .addDropdown((dropdown) => {
        dropdown.addOption("manual", "手动");
        dropdown.addOption("automatic", "自动同步");
        dropdown.addOption("scheduled", "低频自动");
        dropdown.setValue(this.owner.settings.mode).onChange(async (value) => {
          this.owner.settings.mode = value as PluginSettings["mode"];
          await this.owner.saveSettings();
        });
      });
    if (this.owner.settings.mode === "scheduled") new Setting(syncGroup).setName("同步周期（分钟）")
      .setDesc("1 至 1440 分钟").addText((text) => {
        text.inputEl.type = "number"; text.inputEl.min = "1"; text.inputEl.max = "1440";
        text.setValue(String(this.owner.settings.intervalMinutes)).onChange(async (value) => {
          this.owner.settings.intervalMinutes = Math.min(1440, Math.max(1, Math.round(Number(value) || 1)));
          await this.owner.saveSettings();
        });
      });
    if (this.owner.auth) {
      const status = new Setting(syncGroup).setName("同步状态");
      this.statusEl = status.descEl;
      if (this.owner.currentStatus.failed > 0) status.addButton((button) => button
        .setButtonText("重试失败任务").onClick(() => void this.owner.retryFailed()));
      this.renderStatus();
    } else this.statusEl = undefined;

    new Setting(containerEl).setName("过滤规则").setHeading();
    const filterGroup = this.createGroup("过滤规则");
    new Setting(filterGroup).setName("同步 obsidian 配置")
      .setDesc(".obsidian 为笔记仓库的系统配置，默认关闭，开启后迁移笔记时会自动同步笔记软件配置")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.syncObsidianConfig)
        .onChange((value) => void this.owner.setSyncObsidianConfig(value)));
    new Setting(filterGroup).setName("同步过滤的文件格式")
      .setDesc("可按文件名、目录或通配符设置不参与同步的内容")
      .addButton((button) => button.setButtonText("编辑规则").onClick(() => this.owner.showFilterRules()));

    new Setting(containerEl).setName("同步遇到问题？").setHeading();
    
    new Setting(this.createGroup("同步遇到问题？")).setName("一键自动修复")
      .setDesc("重新检查云端目录和同步记录，用于修复云端文件未显示或同步状态异常。")
      .addButton((button) => button.setButtonText("自动修复").onClick(() => void this.owner.syncNow(true)));

    this.transfersEl = undefined;
    this.renderProductLinks();
    const welcome = containerEl.createDiv({ cls: "yunpan-sync-welcome" });
    welcome.appendText("欢迎使用 ");
    welcome.createEl("strong", { text: "360AI 云盘" });
    welcome.appendText("，让您的笔记永远随身！");
    containerEl.createDiv({ cls: "yunpan-sync-settings-version",
      text: `插件版本 ${this.owner.manifest.version}` });
    this.renderLogin();
    this.stopDismiss = dismissKeyboardOnBlankTap(containerEl);
  }

  hide(): void {
    this.stopDismiss?.();
    this.stopDismiss = undefined;
  }

  renderLogin(): void {
    const status = this.owner.currentStatus;
    const pending = status.phase === "login";
    for (const button of this.loginButtons) button.setDisabled(false).setButtonText(pending ? "重新登录" : "登录");
    if (this.cancelLoginButton) this.cancelLoginButton.buttonEl.hidden = !pending;
    this.loginStatusEl?.setText(pending || status.phase === "error" || status.message === "登录已取消" ? status.message : "");
    if (this.authorizationEl) this.authorizationEl.hidden = !this.owner.pendingAuthorizationUrl;
  }

  renderStatus(): void {
    if (!this.statusEl) return;
    const status = this.owner.currentStatus;
    const summary = summarizeTransfers(this.owner.transferProgress);
    const last = status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : "尚未完成同步";
    const completed = status.completed ?? summary.completedCount;
    const readableError = status.lastError ? classifySyncError(status.lastError).detail : undefined;
    this.statusEl.setText(`最新同步时间：${last}（${completed} 项同步成功，${status.failed} 项同步失败）${readableError ? `\n最近错误：${readableError}` : ""}`);
    this.statusEl.toggleClass("yunpan-sync-error", status.phase === "error");
  }

  renderTransfers(): void {
    if (!this.transfersEl) return;
  }

  private createGroup(label: string): HTMLElement {
    return this.containerEl.createDiv({ cls: "yunpan-sync-settings-group",
      attr: { role: "group", "aria-label": label } });
  }

  private renderAccount(container: HTMLElement): void {
    if (!this.owner.auth) {
      const account = new Setting(container).setName("请登录 360AI 云盘账号")
        .addButton((button) => {
          this.loginButtons.push(button);
          button.setButtonText("登录").setCta().onClick(() => void this.startLogin());
        })
        .addButton((button) => {
          this.cancelLoginButton = button;
          button.setButtonText("取消登录").onClick(() => this.owner.cancelLogin());
          button.buttonEl.addClass("yunpan-sync-cancel-login");
        });
      account.settingEl.addClass("yunpan-sync-login-setting");
      this.loginStatusEl = account.descEl;
      const url = this.owner.pendingAuthorizationUrl;
      if (url) {
        const authorization = new Setting(container).setName("浏览器授权")
          .setDesc("浏览器未自动打开时，点击授权链接；也可复制到 Chrome 或 Safari 中打开。完成授权后请返回 Obsidian。");
        authorization.controlEl.createEl("a", {
          text: "打开授权页面", cls: "external-link",
          attr: { href: url, target: "_blank", rel: "noopener noreferrer" },
        });
        authorization.addButton((button) => button.setButtonText("复制授权链接")
          .onClick(() => this.owner.copyMobileAuthorizationLink()));
        this.authorizationEl = authorization.settingEl;
      }
      return;
    }
    const profile = this.owner.profile;
    if (!profile) {
      new Setting(container)
        .setName(this.owner.profileLoading ? "正在加载账户信息..." : "账号：已登录")
        .setDesc(this.owner.profileError ? `账户信息加载失败：${this.owner.profileError}` : "")
        .addButton((button) => button.setButtonText("退出登录").onClick(() => void this.owner.logout()));
      return;
    }
    const active = hasActiveMembership(profile);
    const identityEl = document.createElement("span");
    identityEl.appendText(`账号：${accountDisplayIdentity(profile)}　`);
    const icon = membershipIcon(profile, active);
    if (icon) {
      const image = document.createElement("img");
      image.className = "yunpan-sync-membership-icon";
      image.src = icon.src;
      image.alt = icon.alt;
      image.referrerPolicy = "no-referrer";
      identityEl.append(image);
    }
    const label = document.createElement("span");
    label.className = "yunpan-sync-membership-label";
    label.textContent = active ? profile.vipLabel : "普通用户";
    identityEl.append(label);
    if (!active) {
      const purchase = identityEl.createEl("button", { text: "购买会员", cls: "yunpan-sync-inline-purchase" });
      purchase.addEventListener("click", () => openProductLink(this.owner.settings.environment, "renewal"));
    }
    const storage = profile.totalBytes === undefined
      ? formatStorageCapacity(profile.usedBytes)
      : `${formatStorageCapacity(profile.usedBytes)}/${formatStorageCapacity(profile.totalBytes)}`;
    const account = new Setting(container).setDesc(`存储空间：${storage}`)
      .addButton((button) => button.setButtonText("退出登录").onClick(() => void this.owner.logout()));
    account.nameEl.empty();
    account.nameEl.append(identityEl);
  }

  private startLogin(): Promise<void> {
    return this.owner.currentStatus.phase === "login" ? this.owner.relogin() : this.owner.login();
  }

  private renderProductLinks(): void {
    new Setting(this.containerEl).setName("产品与支持").setHeading();
    const group = this.createGroup("产品与支持");
    new Setting(group).setName("360AI 云盘官网")
      .setDesc("任何设备、随时随地，让文件都实时同步")
      .addButton((button) => button.setButtonText("前往体验").setCta()
        .onClick(() => openProductLink(this.owner.settings.environment, "officialSite")));
    new Setting(group).setName("问题反馈")
      .setDesc(this.owner.auth ? "欢迎反馈使用问题和改进建议" : "登录后可提交与账号关联的反馈")
      .addButton((button) => button.setButtonText("去反馈")
        .setDisabled(!this.owner.auth)
        .onClick(() => { if (this.owner.auth) openFeedbackLink(this.owner.auth.qid); }));
  }
}
