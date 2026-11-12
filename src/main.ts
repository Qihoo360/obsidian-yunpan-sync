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
import { MobileLoginPreparation } from "./auth/mobile-login-preparation.js";
import type { PreparedMobileOAuth } from "./auth/oauth-mobile.js";
import { AuthRefreshCoordinator, OAuthCodeUnavailableError, ReloginRequiredError } from "./auth/refresh.js";
import { SecretStore, type CloudAuth } from "./auth/secrets.js";
import {
  accountDisplayIdentity,
  formatStorageCapacity,
  normalizeAccountProfile,
  type AccountProfile,
} from "./account/profile.js";
import { OpenApiClient, OpenApiError, type HttpRequest } from "./net/openapi-client.js";
import { DEFAULT_SETTINGS, ensureDeviceId, normalizeSettings, pollIntervalMs,
  normalizeScheduledInterval, MIN_SCHEDULED_INTERVAL_MINUTES, MAX_SCHEDULED_INTERVAL_MINUTES,
  validFileSizeRange,
  type FilterRule, type PluginSettings } from "./settings.js";
import { DatabasePersistence } from "./storage/persistence.js";
import { SyncEngine, type EngineStatus } from "./sync/engine.js";
import { DownloadMachine } from "./transfer/download.js";
import { StoreClient } from "./transfer/store-client.js";
import { UploadMachine } from "./transfer/upload.js";
import { normalizeRemoteRoot, normalizeVaultPath, shouldIgnorePath, parseExcludedExtensions } from "./domain/paths.js";
import { OPENAPI_SIGNING_SECRET } from "./config/openapi.js";
import { initialStatus, restoredStatus } from "./status.js";
import { completionNotice, isSuccessfulSyncMessage } from "./sync/outcome.js";
import { overallTransferProgress, summarizeTransfers, type FileTransferProgress } from "./sync/progress.js";
import { SyncProgressModal, SyncTaskPreviewModal } from "./ui/sync-modal.js";
import { openPluginSettings } from "./ui/plugin-settings.js";
import type { SyncConflict, SyncTask } from "./storage/database.js";
import { RemoteDirectoryModal } from "./ui/remote-directory-modal.js";
import { YUNPAN_STATUS_VIEW, YunpanStatusView } from "./ui/status-view.js";
import { classifySyncError } from "./sync/error-guidance.js";
import { openFeedbackLink, openProductLink, openMembershipPayment } from "./ui/product-links.js";
import { SyncPreflightError } from "./sync/quota.js";


import { hasActiveMembership, hasExpiredMembership, membershipIcon, membershipLabel } from "./ui/account-membership.js";
import { FilterRulesModal } from "./ui/filter-rules-modal.js";
import { RELOGIN_MESSAGE, statusBarDestination } from "./ui/auth-state.js";
import { interruptSyncForDisconnect, resumeSyncAfterReconnect } from "./sync/connectivity.js";
import { PluginLifecycleTimers, settleForPause } from "./lifecycle.js";
import { openVaultPath } from "./ui/open-vault-path.js";
import { dismissKeyboardOnBlankTap } from "./ui/dismiss-keyboard.js";
import { renderFailedRecordAction } from "./ui/failed-record-action.js";
import { RequestScheduler } from "./net/request-scheduler.js";
import { DownloadCache, discardDownloads } from "./transfer/download-cache.js";

const INITIAL_SYNC_DELAY_MS = 1500;
const FILE_EVENT_DEBOUNCE_MS = 10_000;

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
  private accountProfileRequest?: { api: OpenApiClient; promise: Promise<void> };
  private accountProfileError?: string;
  private transfers: FileTransferProgress[] = [];
  private syncModal?: SyncProgressModal;
  private syncUiHidden = false;
  private backgroundSync = false;
  private removingFailure = false;
  private displayedSyncWarnings = new Set<string>();
  private lastRestrictionWarning?: string;
  private expiredAuthQid?: string;
  private readonly lifecycle = new PluginLifecycleTimers();
  private mobileLoginWaiter?: { resolve: (auth: CloudAuth) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  private mobileCallbackState?: string;
  private mobileAuthorizationUrl?: string;
  private loginAttempt?: AbortController;
  private loginGeneration = 0;
  private unloading = false;
  private uiTimer?: ReturnType<typeof setTimeout>;
  private lastUiRender = 0;
  private readonly dismissedInitialConfirmations = new WeakSet<SyncEngine>();
  private taskPreview?: SyncTaskPreviewModal;
  private pauseTransition: Promise<void> = Promise.resolve();
  private pauseGeneration = 0;
  private stoppingRequested = false;
  private directoryChoice?: Promise<boolean>;
  private directoryModal?: RemoteDirectoryModal;
  private syncStarting?: object;
  private readonly syncRuns = new Set<object>();
  private interruptionGeneration = 0;
  private recoveryRequest?: { engine: SyncEngine; api: OpenApiClient | undefined; pauseGeneration: number; interruptionGeneration: number };
  private recoveryRunning = false;
  private directoryChoiceDismissed = false;
  private validatedDirectory?: string;
  readonly mobileLoginPreparation = new MobileLoginPreparation(async (signal, progress) => {
    const { MobileOAuth } = await import("./auth/oauth-mobile.js");
    if (signal.aborted) throw loginCancelledError();
    return new MobileOAuth(this.settings.environment, this.settings.openapiBaseUrl, progress, signal).prepare();
  }, () => this.settingTab?.renderLogin());

  async onload(): Promise<void> {
    if (!requireApiVersion(this.manifest.minAppVersion)) {
      new Notice("版本过低，请先升级 obsidian", 10000);
      return;
    }
    const persisted = await this.loadData() as Partial<PluginSettings> | null | undefined;
    this.settings = normalizeSettings(persisted, this.isMobileDevice);
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
    } else if (createdDeviceId || JSON.stringify(persisted) !== JSON.stringify(this.settings)) await this.saveData(this.settings);
    this.persistence.database.recoverInterruptedTasks();
    
    await this.persistence.save();
    const restoredCounts = this.persistence.database.taskCounts();
    const restoredFailures = this.persistence.database.listFailedTasks().filter(task => task.state === "failed");
    this.status = restoredStatus(this.auth, this.persistence.database.getLastSuccessfulSync(), restoredCounts, restoredFailures);
    if (this.settings.paused) this.status = { ...this.status, phase: "paused", message: "同步已暂停", lastError: undefined };
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
    this.registerDomEvent(window, "offline", () => this.handleDisconnect());
    this.registerDomEvent(window, "online", () => void this.requestAutomaticResume());
    this.registerDomEvent(document, "visibilitychange", () => void this.handleVisibilityChange());
    await this.configureEngine();
    this.configureSchedule();
    this.renderStatus();
    if (this.auth) void this.refreshAccountProfile(false);
  }

  async onunload(): Promise<void> {
    this.unloading = true;
    this.directoryModal?.close();
    this.taskPreview?.cancel();
    if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = undefined; }
    this.settingTab?.hide();
    this.endLoginAttempt();
    this.lifecycle.dispose();
    await settleForPause(true, this.engine);
    await this.persistence?.close();
  }

  async saveSettings(): Promise<void> {
    if (this.settings.mode === "manual") this.recoveryRequest = undefined;
    await this.saveData(this.settings);
    this.configureSchedule();
    this.settingTab?.refresh();
  }

  get currentStatus(): EngineStatus { return this.status; }
  get failedTasks(): readonly SyncTask[] { return this.status.failedTasks ?? []; }
  get auth(): CloudAuth | undefined { return this.secrets.getAuth(); }
  get profile(): AccountProfile | undefined { return this.accountProfile; }
  get profileLoading(): boolean { return this.accountProfileLoading; }
  get profileError(): string | undefined { return this.accountProfileError; }
  get isPaused(): boolean { return this.settings.paused; }
  get remoteRootSelected(): boolean { return this.settings.remoteRootSelected === true; }
  get isSyncing(): boolean { return this.removingFailure || (Boolean(this.syncStarting) && this.remoteRootSelected) || (this.engine?.isRunning() ?? false); }
  get transferProgress(): readonly FileTransferProgress[] { return this.transfers; }
  get conflicts(): readonly SyncConflict[] { return this.persistence?.database.listUnresolvedConflicts() ?? []; }
  get isMobileDevice(): boolean { return Platform.isMobileApp; }
  private get isMobileBackgrounded(): boolean {
    return this.isMobileDevice && document.visibilityState === "hidden";
  }
  get pendingAuthorizationUrl(): string | undefined {
    return this.status.phase === "login" ? this.mobileAuthorizationUrl : undefined;
  }

  prepareMobileLogin(retry = false): Promise<void> {
    if (!this.isMobileDevice || this.auth || this.unloading) return Promise.resolve();
    return this.mobileLoginPreparation.ensure(retry);
  }

  /** Called on the real link click, before its native default navigation. */
  activateMobileLogin(url: string | null): boolean {
    const prepared = this.mobileLoginPreparation.ready;
    if (this.unloading || !prepared || prepared.authorizationUrl !== url) {
      void this.prepareMobileLogin(true);
      return false;
    }
    if (this.status.phase === "login") void this.relogin();
    else void this.login();
    return this.pendingAuthorizationUrl === url;
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
    this.mobileLoginPreparation.clear();
  }

  cancelLogin(): void {
    if (!this.loginAttempt && this.status.phase !== "login") return;
    this.endLoginAttempt();
    this.updateStatus({ phase: "idle", message: "登录已取消", queued: 0, failed: 0 });
    this.settingTab?.renderLogin();
    if (this.settingTab?.isVisible) void this.prepareMobileLogin();
  }

  async relogin(): Promise<void> {
    const prepared = this.mobileLoginPreparation.ready;
    if (this.isMobileDevice && !prepared) { await this.prepareMobileLogin(true); return; }
    this.endLoginAttempt();
    await this.login(prepared);
  }

  async login(prepared: PreparedMobileOAuth | undefined = this.mobileLoginPreparation.ready): Promise<void> {
    if (this.loginAttempt) return;
    if (this.isMobileDevice && !prepared) { await this.prepareMobileLogin(true); return; }
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
        const { pending, authorizationUrl } = prepared!;
        this.secrets.setPendingOAuth(pending);
        this.mobileAuthorizationUrl = authorizationUrl;
        // No await or browser call here: the trusted link click opens its href.
        const authorization = new Promise<CloudAuth>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!current() || this.mobileLoginWaiter?.timer !== timer) return;
            this.mobileLoginWaiter = undefined;
            this.secrets.clearPendingOAuth();
            reject(new Error("等待云盘 OAuth 授权超时"));
          }, 180_000);
          this.mobileLoginWaiter = { resolve, reject, timer };
        });
        this.updateStatus({ phase: "login", message: "等待浏览器授权；若浏览器未打开，可使用下方授权链接", queued: 0, failed: 0 });
        this.settingTab?.refresh();
        auth = await authorization;
      } else {
        const { DesktopOAuth } = await import("./auth/oauth-desktop.js");
        if (!current()) return;
        const oauth = new DesktopOAuth(this.settings.environment, this.settings.openapiBaseUrl);
        const preparedDesktop = await oauth.prepare(attempt.signal);
        if (!current()) return;
        this.secrets.setPendingOAuth(preparedDesktop.pending);
        this.mobileAuthorizationUrl = preparedDesktop.authorizationUrl;
        const authorization = new Promise<CloudAuth>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!current() || this.mobileLoginWaiter?.timer !== timer) return;
            this.mobileLoginWaiter = undefined;
            this.secrets.clearPendingOAuth();
            reject(new Error("等待云盘 OAuth 授权超时"));
          }, 180_000);
          this.mobileLoginWaiter = { resolve, reject, timer };
        });
        this.updateStatus({ phase: "login", message: "等待浏览器授权", queued: 0, failed: 0 });
        this.settingTab?.refresh();
        try { window.open(preparedDesktop.authorizationUrl, "_blank"); }
        catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
        auth = await authorization;
      }
      if (!current()) return;
      if (previousQid && previousQid !== auth.qid) {
        // The remote root belongs to the account, so never carry the previous
        // account's selected folder into a replacement login.
        await settleForPause(true, this.engine);
        if (this.persistence) await discardDownloads(this.app.vault.adapter, this.persistence.database, () => this.persistence!.save());
        if (!current()) return;
        this.rememberAccountDirectory();
        this.persistence?.database.resetSyncState();
        this.settings.remoteRoot = DEFAULT_SETTINGS.remoteRoot;
        this.settings.remoteRootSelected = false;
        await this.saveSettings();
      }
      this.secrets.setAuth(auth);
      this.restoreAccountDirectory();
      await this.saveData(this.settings);
      this.mobileLoginPreparation.clear();
      
      this.expiredAuthQid = undefined;
      await this.configureEngine();
      if (!current()) return;
      this.updateStatus({ phase: "idle", message: "已登录", queued: 0, failed: 0 });
      this.settingTab?.refresh();
      this.scheduleInitialSync();
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
        if (this.mobileLoginWaiter) clearTimeout(this.mobileLoginWaiter.timer);
        this.mobileLoginWaiter = undefined;
        this.settingTab?.renderLogin();
        try { await this.persistence?.save(); }
        catch { if (this.loginGeneration === generation) new Notice("登录状态保存失败，请重试"); }
      }
    }
  }

  async logout(): Promise<void> {
    this.endLoginAttempt();
    this.directoryModal?.close();
    this.taskPreview?.cancel();
    if (this.engine?.isRunning()) {
      this.engine.cancel();
      await this.engine.waitForIdle();
    }
    if (this.persistence) await discardDownloads(this.app.vault.adapter, this.persistence.database, () => this.persistence!.save());
    this.unconfirmCurrentBinding();
    this.rememberAccountDirectory();
    this.secrets.clearAuth();
    this.expiredAuthQid = undefined;
    this.accountProfile = undefined;
    this.accountProfileError = undefined;
    this.updateTransfers([]);
    this.api = undefined;
    // A selected remote folder is account-specific. Restore the safe default
    // on logout so the next login cannot inherit the previous account's path.
    this.settings.remoteRoot = DEFAULT_SETTINGS.remoteRoot;
    this.settings.remoteRootSelected = false;
    this.directoryChoiceDismissed = false;
    await this.saveSettings();
    this.persistence?.database.resetSyncState();
    await this.persistence?.save();
    this.engine = undefined;
    this.updateStatus({ phase: "idle", message: "未登录", queued: 0, failed: 0 });
    this.settingTab?.refresh();
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
      if (!current()) return;
      let auth: CloudAuth;
      if (pending.flow === "desktop") {
        const { DesktopOAuth } = await import("./auth/oauth-desktop.js");
        auth = await new DesktopOAuth(this.settings.environment, this.settings.openapiBaseUrl)
          .complete(params, pending as import("./auth/oauth-desktop.js").DesktopPendingOAuth, attempt?.signal);
      } else {
        const { MobileOAuth } = await import("./auth/oauth-mobile.js");
        auth = await new MobileOAuth(this.settings.environment, this.settings.openapiBaseUrl, undefined, attempt?.signal).complete(params, pending);
      }
      if (!current()) return;
      if (waiter) {
        if (this.mobileLoginWaiter !== waiter) return;
        clearTimeout(waiter.timer);
        this.mobileLoginWaiter = undefined;
        waiter.resolve(auth);
      } else {
        this.secrets.setAuth(auth);
        this.restoreAccountDirectory();
        await this.saveData(this.settings);
        this.mobileLoginPreparation.clear();
        await this.configureEngine();
        if (!current()) return;
        new Notice("360AI 云盘登录成功");
        this.settingTab?.refresh();
        this.scheduleInitialSync();
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
    if (root === normalizeRemoteRoot(this.settings.remoteRoot) && this.settings.remoteRootSelected) return;
    await settleForPause(true, this.engine);
    if (this.persistence) await discardDownloads(this.app.vault.adapter, this.persistence.database, () => this.persistence!.save());
    this.persistence?.database.resetSyncState();
    this.settings.remoteRoot = root;
    this.settings.remoteRootSelected = true;
    this.directoryChoiceDismissed = false;
    this.rememberAccountDirectory();
    await this.persistence?.save();
    await this.saveSettings();
    await this.configureEngine();
    this.updateStatus({ phase: "idle", message: "远端目录已变更，将在下次同步重建基线", queued: 0, failed: 0 });
    this.scheduleInitialSync();
  }

  async syncNow(rebuild = false, interactive = true, live = false): Promise<void> {
    if (this.syncStarting) return;
    const start = {};
    this.syncStarting = start;
    this.syncRuns.add(start);
    try { await this.startSync(rebuild, interactive, start, live); }
    finally {
      if (this.syncStarting === start) this.syncStarting = undefined;
      this.syncRuns.delete(start);
      if (interactive || live || this.status.phase === "error" || this.status.phase === "paused") this.scheduleUi(true);
      void this.drainAutomaticResume();
    }
  }

  private async startSync(rebuild: boolean, interactive: boolean, start: object, live = false): Promise<void> {
    const interruptionGeneration = this.interruptionGeneration;
    if (this.unloading || this.isMobileBackgrounded || this.engine?.isRunning()) return;
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
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.updateStatus({ ...this.status, phase: "paused", message: "网络已断开，同步已暂停", lastError: undefined });
      return;
    }
    if (!this.settings.remoteRootSelected) {
      if (!interactive && this.directoryChoiceDismissed) return;
      this.directoryChoice ??= this.chooseInitialDirectory().finally(() => { this.directoryChoice = undefined; });
      if (!await this.directoryChoice || this.settings.paused || this.unloading || this.isMobileBackgrounded ||
        interruptionGeneration !== this.interruptionGeneration) return;
      // Another caller may have started while the chooser was open.
      if (this.engine?.isRunning()) return;
    }
    const refreshInterruptedStatus = this.status.phase === "paused";
    if ((interactive || live || refreshInterruptedStatus) && !this.engine.isRunning()) {
      if (interactive) this.syncUiHidden = false;
      this.updateStatus({ ...this.status, phase: "prepare", message: "正在准备同步…", lastError: undefined });
    }
    if (interactive) this.showSyncProgress();
    this.backgroundSync = !(interactive || live);
    const engine = this.engine;
    const api = this.api;
    const pauseGeneration = this.pauseGeneration;
    const current = () => !this.unloading && !this.isMobileBackgrounded && !this.settings.paused &&
      this.engine === engine && this.api === api && pauseGeneration === this.pauseGeneration &&
      interruptionGeneration === this.interruptionGeneration &&
      !(typeof navigator !== "undefined" && navigator.onLine === false);
    try {
      const directoryKey = `${this.auth?.qid}:${this.settings.ownerQid}:${this.settings.remoteRoot}`;
      if (this.api && this.validatedDirectory !== directoryKey) {
        try {
          await this.api.call("File.getList", { path: this.settings.remoteRoot, page: 1, page_size: 1 });
          if (!current()) return;
          this.validatedDirectory = directoryKey;
        } catch (error) {
          if (!current()) return;
          if (!(error instanceof OpenApiError) || ![3008, 3009].includes(error.errno ?? 0)) throw error;
          this.settings.remoteRootSelected = false;
          const key = `${this.auth?.qid}:${this.settings.ownerQid}`;
          delete this.settings.accountDirectories?.[key];
          await this.saveData(this.settings);
          this.updateStatus({ ...this.status, phase: "paused", message: "原云端目录已不存在，请重新选择同步目录", lastError: undefined });
          this.directoryChoice ??= this.chooseInitialDirectory().finally(() => { this.directoryChoice = undefined; });
          if (await this.directoryChoice) this.scheduleInitialSync();
          return;
        }
      }
      if (!current()) return;
      const initialConfirmation = engine.needsInitialConfirmation();
      if (initialConfirmation && !interactive && this.dismissedInitialConfirmations.has(engine)) {
        this.updateStatus({ ...this.status, phase: "paused", message: "等待首次同步确认" });
        return;
      }
      // synchronize takes ownership synchronously; a later resume may start as
      // soon as this engine becomes idle, even while this call saves its UI state.
      if (this.syncStarting === start) this.syncStarting = undefined;
      await engine.synchronize(rebuild, initialConfirmation
        ? async (tasks) => {
          if (!current()) return undefined;
          const selected = await this.confirmSyncTasks(tasks, true);
          // Lifecycle interruptions close the preview too; only a user dismissal
          // should suppress future automatic confirmation prompts.
          if (!current()) return undefined;
          if (!selected || (tasks.length > 0 && selected.size === 0)) this.dismissedInitialConfirmations.add(engine);
          return selected;
        } : undefined);
      if (!current()) return;
      await this.persistence?.save();
      if (refreshInterruptedStatus) this.scheduleUi(true);
      if (interactive && this.status.phase === "idle" && isSuccessfulSyncMessage(this.status.message)) {
        this.displayedSyncWarnings.clear();
        this.lastRestrictionWarning = undefined;
        new Notice(completionNotice(this.status.message));
        if (this.conflicts.length > 0) new Notice(`检测到 ${this.conflicts.length} 个冲突，已保留双方文件`);
      }
    } catch (error) {
      if (!current()) return;
      await this.persistence?.save();
      this.validatedDirectory = undefined;
      if (error instanceof SyncPreflightError) {
        this.updateStatus({ ...this.status, phase: "error", message: error.message, lastError: error.message, restriction: error });
        const warningKey = `${this.auth?.qid ?? ""}:${error.kind}`;
        const firstWarning = this.lastRestrictionWarning !== warningKey;
        if (interactive || firstWarning) new Notice(error.message);
        this.lastRestrictionWarning = warningKey;
        return;
      }
      if (this.handleAuthError(error)) return;
      const guidance = classifySyncError(error);
      this.updateStatus({ ...this.status, phase: "error", message: guidance.title, lastError: guidance.detail });
      new Notice(`${guidance.title}: ${guidance.detail}`);
    } finally {
      if (interactive || live || !this.backgroundSync || this.status.phase === "error" || this.status.phase === "paused") {
        this.syncModal?.render();
        this.refreshStatusViews();
      }
      this.backgroundSync = false;
    }
  }

  async resolveSyncRestriction(): Promise<void> {
    if (this.status.restriction?.kind === "unknown") {
      await this.refreshAccountProfile(false);
      await this.syncNow();
    } else if (this.status.restriction) {
      openMembershipPayment(this.settings.environment, this.isMobileDevice);
    }
  }

  async refreshAccountProfile(showFailureNotice = true): Promise<void> {
    const api = this.api;
    const qid = this.auth?.qid;
    if (!qid || !api || this.unloading) return;
    if (this.accountProfileRequest?.api === api) return this.accountProfileRequest.promise;
    const request = { api, promise: Promise.resolve() };
    this.accountProfileRequest = request;
    this.accountProfileLoading = true;
    this.accountProfileError = undefined;
    const current = () => !this.unloading && this.api === api && this.auth?.qid === qid;
    request.promise = (async () => {
      this.settingTab?.refresh();
      try {
        const data = await api.call<Record<string, unknown>>("User.getUserDetail", {});
        if (!current()) return;
        this.accountProfile = normalizeAccountProfile(data ?? {}, qid);
        if (!hasExpiredMembership(this.accountProfile) && this.status.restriction?.kind === "membership" && !this.isSyncing) {
          this.engine?.clearMembershipRestriction();
          this.lastRestrictionWarning = undefined;
          this.updateStatus({ ...this.status, phase: this.isPaused ? "paused" : "idle",
            message: "会员状态已更新，可继续同步", lastError: undefined, restriction: undefined });
        } else if (this.status.phase === "idle" && this.status.message.startsWith("已登录")) {
          this.updateStatus({ ...this.status, message: `已登录 ${accountDisplayIdentity(this.accountProfile)}` });
        }
      } catch (error) {
        if (!current() || this.handleAuthError(error)) return;
        this.accountProfileError = messageOf(error);
        if (showFailureNotice) new Notice(`账户信息刷新失败: ${this.accountProfileError}`);
      } finally {
        if (this.accountProfileRequest === request) {
          this.accountProfileRequest = undefined;
          this.accountProfileLoading = false;
          if (current()) this.settingTab?.refresh();
        }
      }
    })();
    return request.promise;
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
      const state = this.persistence?.database.downloadStates().find(state => state.taskId === id);
      if (state && this.persistence) await new DownloadCache(this.app.vault.adapter, this.persistence.database,
        state.binding, id, () => this.persistence!.save()).clear();
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
      this.settingTab?.renderStatus();
      this.syncModal?.render();
      this.refreshStatusViews();
    }
  }

  async ignoreTask(id: string): Promise<void> {
    if (this.isSyncing) { new Notice("同步进行中，请结束本轮同步后再忽略文件"); return; }
    const persistence = this.persistence;
    const engine = this.engine;
    const task = persistence?.database.listFailedTasks().find(task => task.id === id && task.state === "failed");
    if (!persistence || !engine || !task) { new Notice("该失败记录已不存在，请刷新后重试"); return; }
    this.removingFailure = true;
    let saved = false;
    try {
      const path = normalizeVaultPath(task.path);
      const pattern = `/${path}`;
      if (!path || pattern.length > 512) throw new Error("路径过长或无效，请在过滤规则中手动设置排除范围");
      // Valid sync paths cannot contain glob wildcards. Anchor to the full vault
      // path and append last so an earlier include rule cannot override this choice.
      const rules = this.settings.filterRules.filter(rule => !(rule.id.startsWith("ignored-file:") &&
        rule.pattern.toLocaleLowerCase("en-US") === pattern.toLocaleLowerCase("en-US")));
      rules.push({ id: `ignored-file:${crypto.randomUUID()}`, enabled: true, action: "exclude", pattern, caseSensitive: false });
      await this.saveData({ ...this.settings, filterRules: rules });
      this.settings.filterRules = rules;
      saved = true;
      const state = persistence.database.downloadStates().find(state => state.taskId === id);
      if (state) await new DownloadCache(this.app.vault.adapter, persistence.database,
        state.binding, id, () => persistence.save()).clear();
      engine.removeFailedTask(id);
      await persistence.save();
      new Notice(`已忽略 ${path}，后续不再上传或下载；可在“过滤规则”中删除或停用对应规则`);
    } catch (error) {
      new Notice(saved ? `忽略规则已保存，但清理失败记录失败：${messageOf(error)}` : `忽略文件失败：${messageOf(error)}`);
    } finally {
      this.removingFailure = false;
      this.settingTab?.refresh();
      this.scheduleUi(true);
    }
  }

  async resolveConflict(id: number): Promise<void> {
    if (this.persistence?.database.resolveConflict(id)) await this.persistence.save();
    this.refreshStatusViews();
    this.settingTab?.refresh();
  }

  async setPaused(paused: boolean): Promise<void> {
    const generation = ++this.pauseGeneration;
    const stopping = paused && this.stoppingRequested;
    if (paused) {
      this.settings.paused = true;
      this.syncStarting = undefined;
      this.directoryModal?.close();
      this.taskPreview?.cancel();
      this.engine?.cancel();
      this.updateStatus({ ...this.status, phase: "stopping", message: "正在停止同步…", lastError: undefined });
    }
    const transition = this.pauseTransition.catch(() => undefined).then(async () => {
      if (paused) await this.saveData(this.settings);
      await this.engine?.waitForIdle();
      if (generation !== this.pauseGeneration || this.unloading) return;
      this.settings.paused = paused;
      await this.saveData(this.settings);
      await this.persistence?.save();
      this.configureSchedule();
      this.stoppingRequested = false;
      this.updateStatus({ ...this.status,
        phase: paused ? "paused" : "prepare",
        message: paused ? stopping ? "同步已停止" : "同步已暂停" : "正在准备同步…",
        lastError: undefined });
      this.settingTab?.refresh();
    });
    this.pauseTransition = transition;
    await transition;
    if (!paused && generation === this.pauseGeneration && !this.unloading) {
      this.engine?.resumePendingRetries();
      await this.syncNow(false, false, true);
    }
  }

  cancelSync(): void {
    this.stoppingRequested = true;
    void this.setPaused(true);
    new Notice("正在停止同步…");
  }

  resumeSync(): void {
    void this.setPaused(false);
  }

  showSyncProgress(): void {
    // Explicitly opening progress opts the user into live updates for the
    // current run, including one that started in the background.
    this.backgroundSync = false;
    this.syncUiHidden = false;
    this.syncModal?.closeForTransition();
    this.syncModal = new SyncProgressModal(this);
    this.syncModal.open();
  }

  async chooseRemoteRoot(): Promise<void> {
    if (!this.api) { new Notice("请先登录 360AI 云盘"); return; }
    if (this.directoryModal) return;
    const api = this.api;
    const generation = this.loginGeneration;
    const modal = new RemoteDirectoryModal(this.app, api);
    this.directoryModal = modal;
    try {
      const selected = await modal.choose();
      if (selected && !this.unloading && this.api === api && this.loginGeneration === generation) await this.setRemoteRoot(selected);
    } finally {
      if (this.directoryModal === modal) this.directoryModal = undefined;
      this.scheduleUi(true);
    }
  }

  private rememberAccountDirectory(): void {
    if (!this.auth || !this.settings.remoteRootSelected) return;
    this.settings.accountDirectories = { ...this.settings.accountDirectories,
      [`${this.auth.qid}:${this.settings.ownerQid}`]: normalizeRemoteRoot(this.settings.remoteRoot) };
  }

  private restoreAccountDirectory(): void {
    this.directoryChoiceDismissed = false;
    const root = this.auth && this.settings.accountDirectories?.[`${this.auth.qid}:${this.settings.ownerQid}`];
    if (root) {
      this.settings.remoteRoot = normalizeRemoteRoot(root);
      this.settings.remoteRootSelected = true;
    }
  }

  private async chooseInitialDirectory(): Promise<boolean> {
    this.updateStatus({ ...this.status, phase: "paused", message: "请先选择云端同步目录", lastError: undefined });
    await this.chooseRemoteRoot();
    this.directoryChoiceDismissed = !this.settings.remoteRootSelected;
    return Boolean(this.settings.remoteRootSelected);
  }

  async setSyncObsidianConfig(enabled: boolean): Promise<void> {
    if (enabled === this.settings.syncObsidianConfig) return;
    await settleForPause(true, this.engine);
    this.settings.syncObsidianConfig = enabled;
    await this.saveSettings();
    this.updateStatus({ ...this.status, phase: "paused", message: "配置同步范围已保存，下次同步生效" });
  }

  async setExcludedExtensions(value: string): Promise<void> {
    if (value === this.settings.excludedExtensions) return;
    await settleForPause(true, this.engine);
    this.settings.excludedExtensions = value;
    this.settings.filterRules = [...this.settings.filterRules.filter(rule => !rule.id.startsWith("legacy-extension-")),
      ...parseExcludedExtensions(value).map((extension, index) => ({ id: `legacy-extension-${index + 1}`,
        enabled: true, action: "exclude" as const, pattern: `**/*.${extension}`, caseSensitive: false }))];
    await this.saveSettings();
  }

  async setFilterRules(rules: FilterRule[]): Promise<void> {
    await settleForPause(true, this.engine);
    this.settings.filterRules = rules.map((rule) => ({ ...rule }));
    this.settings.excludedExtensions = "";
    await this.saveSettings();
    this.updateStatus({ ...this.status, phase: "paused", message: "过滤规则已保存，下次同步生效" });
  }

  async setFileSizeRange(min: number, max: number): Promise<boolean> {
    if (!validFileSizeRange(min, max)) {
      new Notice("请输入 0–500 的整数，下限必须小于上限（单位：MB）");
      return false;
    }
    if (min === this.settings.minFileSizeMB && max === this.settings.maxFileSizeMB) return true;
    await settleForPause(true, this.engine);
    const previous = { minFileSizeMB: this.settings.minFileSizeMB, maxFileSizeMB: this.settings.maxFileSizeMB };
    this.settings.minFileSizeMB = min;
    this.settings.maxFileSizeMB = max;
    try {
      // Size edits do not change scheduling. Preserve the input currently being
      // edited instead of redrawing the settings page on every blur.
      await this.saveData(this.settings);
    } catch (error) {
      Object.assign(this.settings, previous);
      throw error;
    }
    this.updateStatus({ ...this.status, phase: "paused", message: "文件大小限制已保存，下次同步生效" });
    return true;
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
    const scheduler = new RequestScheduler();
    const api = new OpenApiClient({
      scheduler,
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
    const syncApi = { call: <T>(method: import("./net/openapi-client.js").OpenApiMethod,
      input: Record<string, string | number | boolean | null | undefined>) =>
      api.call<T>(method, input, () => this.engine?.checkContinuing(), this.engine?.getCancellationSignal()) };
    const makeStore = (url: string, signal?: AbortSignal) => {
      const current = this.secrets.getAuth();
      if (!current) throw new ReloginRequiredError("登录凭据已失效，请重新登录");
      return new StoreClient(url, { qid: current.qid, token: current.token }, {
        deviceId: this.settings.deviceId,
        deviceName: this.settings.deviceName,
        version: this.manifest.version,
      }, scheduler, () => this.engine?.checkContinuing(), signal);
    };
    const ownerQid = () => this.settings.ownerQid;
    const checkpoint = () => this.persistence!.save();
    this.engine = new SyncEngine(this.app.vault, this.persistence.database, syncApi,
      new UploadMachine(syncApi, makeStore, this.persistence.database, ownerQid, checkpoint),
      new DownloadMachine(syncApi, makeStore, ownerQid), () => this.settings,
      `${auth.qid}:${this.app.vault.getName()}:${normalizeRemoteRoot(this.settings.remoteRoot)}`,
      (status) => this.updateStatus(status), checkpoint,
      (transfers) => this.updateTransfers(transfers), async () => {
        const data = await syncApi.call<Record<string, unknown>>("User.getUserDetail", {});
        const qid = this.auth?.qid;
        if (!qid) throw new Error("登录状态已失效，请重新登录");
        // User detail carries the current personal and enterprise (e_*) quotas.
        // An arbitrary enterprise-list row may belong to a different space.
        const profile = normalizeAccountProfile(data ?? {}, qid);
        this.accountProfile = profile;
        this.settingTab?.refresh();
        return {
          isVip: profile.isVip,
          expiresAt: profile.expiresAt,
          availableBytes: profile.availableBytes,
          usedBytes: profile.usedBytes,
          totalBytes: profile.totalBytes,
          enterpriseAvailableBytes: profile.enterpriseAvailableBytes,
          enterpriseUsedBytes: profile.enterpriseUsedBytes,
          enterpriseTotalBytes: profile.enterpriseTotalBytes,
        };
      });
    if (!this.settings.remoteRootSelected && !this.engine.needsInitialConfirmation()) {
      this.settings.remoteRootSelected = true;
    }
    this.rememberAccountDirectory();
    await this.saveData(this.settings);
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
    this.settingTab?.refresh();
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
    if (this.auth && !this.remoteRootSelected) {
      void this.chooseRemoteRoot();
      return;
    }
    void this.openStatusView();
  }

  private configureSchedule(): void {
    this.lifecycle.configurePolling(this.isMobileBackgrounded ? undefined : pollIntervalMs(this.settings),
      () => void this.syncNow(false, false));
    this.scheduleInitialSync();
  }

  private scheduleInitialSync(): void {
    const engine = this.engine;
    if (this.unloading || this.isMobileBackgrounded || this.settings.paused || this.settings.mode !== "automatic" ||
      !engine || engine.isRunning() || this.directoryChoiceDismissed || this.dismissedInitialConfirmations.has(engine) ||
      (!engine.needsInitialConfirmation() && !(this.persistence?.database.taskCounts().queued))) return;
    // Keep startup detection responsive; file events use a longer debounce
    // once the vault is already running.
    this.lifecycle.debounce(INITIAL_SYNC_DELAY_MS, () => void this.syncNow(false, false));
  }

  private handleDisconnect(): void {
    this.interruptionGeneration++;
    this.recoveryRequest = undefined;
    this.taskPreview?.cancel();
    interruptSyncForDisconnect(this.engine);
    if (!this.settings.paused) this.updateStatus({ ...this.status, phase: "paused",
      message: "网络已断开，同步已暂停", lastError: undefined });
  }

  private canAutomaticallyResume(): boolean {
    return !this.unloading && !this.settings.paused && !this.isMobileBackgrounded &&
      this.settings.mode !== "manual" && !(typeof navigator !== "undefined" && navigator.onLine === false);
  }

  private async requestAutomaticResume(): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.canAutomaticallyResume()) return;
    // Keep the request until the entire old plugin call (including preflight
    // and persistence) exits. Engine idle alone does not cover those stages.
    if (!this.recoveryRequest || this.recoveryRequest.engine !== engine || this.recoveryRequest.api !== this.api ||
      this.recoveryRequest.pauseGeneration !== this.pauseGeneration ||
      this.recoveryRequest.interruptionGeneration !== this.interruptionGeneration) {
      this.recoveryRequest = { engine, api: this.api, pauseGeneration: this.pauseGeneration,
        interruptionGeneration: this.interruptionGeneration };
    }
    await this.drainAutomaticResume();
  }

  private async drainAutomaticResume(): Promise<void> {
    const request = this.recoveryRequest;
    if (!request || this.recoveryRunning || this.syncRuns.size > 0) return;
    this.recoveryRunning = true;
    try {
      await resumeSyncAfterReconnect(() => this.recoveryRequest !== request || !this.canAutomaticallyResume() ||
        this.engine !== request.engine || this.api !== request.api || this.pauseGeneration !== request.pauseGeneration ||
        this.interruptionGeneration !== request.interruptionGeneration,
      request.engine, () => this.syncNow(false, false));
    } finally {
      if (this.recoveryRequest === request) this.recoveryRequest = undefined;
      this.recoveryRunning = false;
      if (this.recoveryRequest) void this.drainAutomaticResume();
    }
  }

  private async handleVisibilityChange(): Promise<void> {
    if (!this.isMobileDevice) return;
    this.configureSchedule();
    if (document.visibilityState === "hidden") {
      this.interruptionGeneration++;
      this.recoveryRequest = undefined;
      this.taskPreview?.cancel();
      await settleForPause(true, this.engine);
      await this.persistence?.save();
    } else await this.requestAutomaticResume();
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
    this.lifecycle.debounce(FILE_EVENT_DEBOUNCE_MS, () => void this.syncNow(false, false));
  }

  private updateStatus(status: EngineStatus): void {
    this.status = status;
    const silentBackgroundProgress = this.backgroundSync && status.phase !== "error" && status.phase !== "paused" && status.phase !== "stopping";
    if (silentBackgroundProgress) {
      this.displayedSyncWarnings = new Set(status.warnings ?? []);
      return;
    }
    for (const warning of status.warnings ?? []) {
      if (!this.displayedSyncWarnings.has(warning)) new Notice(warning);
    }
    this.displayedSyncWarnings = new Set(status.warnings ?? []);
    this.scheduleUi(["idle", "error", "paused", "stopping"].includes(status.phase));
  }

  

  private updateTransfers(transfers: FileTransferProgress[]): void {
    this.transfers = transfers;
    if (!this.backgroundSync) this.scheduleUi();
  }

  private scheduleUi(immediate = false): void {
    if (this.unloading) return;
    const remaining = 200 - (Date.now() - this.lastUiRender);
    if (!immediate && remaining > 0) {
      this.uiTimer ??= setTimeout(() => { this.uiTimer = undefined; this.scheduleUi(true); }, remaining);
      return;
    }
    if (this.uiTimer) { clearTimeout(this.uiTimer); this.uiTimer = undefined; }
    this.lastUiRender = Date.now();
    this.renderStatus();
    this.settingTab?.renderStatus();
    this.settingTab?.renderLogin();
    this.settingTab?.renderTransfers();
    this.syncModal?.render();
    this.refreshStatusViews();
  }

  private renderStatus(): void {
    if (!this.statusBar) return;
    if (this.status.restriction?.kind === "membership") {
      this.statusBar.setText("360AI云盘");
      this.statusBar.toggleClass("yunpan-sync-error", false);
      return;
    }
    const queue = this.status.queued ? ` · 队列 ${this.status.queued}` : "";
    const { percent, operationTotal, operationCompleted } = overallTransferProgress(this.transfers, this.status);
    const transfer = percent === undefined ? "" : ` · 总进度 ${percent}%`;
    const operations = operationTotal > 0 ? ` · 已完成 ${operationCompleted} / ${operationTotal} 项` : "";
    this.statusBar.setText(`360AI云盘: ${this.status.message}${queue}${transfer}${operations}`);
    this.statusBar.toggleClass("yunpan-sync-error", this.status.phase === "error");
  }

  private async confirmSyncTasks(tasks: readonly SyncTask[], initial = false): Promise<ReadonlySet<string> | undefined> {
    this.syncModal?.closeForTransition();
    this.syncModal = undefined;
    if (this.syncUiHidden && !initial) return new Set(tasks.map((task) => task.id));
    const preview = new SyncTaskPreviewModal(this, tasks, this.settings.remoteRoot, initial);
    this.taskPreview = preview;
    try {
      const selected = await preview.choose();
      if (selected?.size) this.showSyncProgress();
      return selected;
    } finally {
      if (this.taskPreview === preview) this.taskPreview = undefined;
    }
  }

  private refreshStatusViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(YUNPAN_STATUS_VIEW)) {
      const view = leaf.view;
      if (view instanceof YunpanStatusView) view.render();
    }
  }

  private async resetSyncScope(message: string): Promise<void> {
    this.unconfirmCurrentBinding();
    if (this.persistence) await discardDownloads(this.app.vault.adapter, this.persistence.database, () => this.persistence!.save());
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
  private mobileLoginLinks: HTMLAnchorElement[] = [];
  private cancelLoginButton?: ButtonComponent;
  private visible = false;
  private navigationPending = false;
  private navigationRefresh?: ReturnType<typeof setTimeout>;
  get isVisible(): boolean { return this.visible; }
  constructor(app: App, private readonly owner: YunpanSyncPlugin) { super(app, owner); }

  display(): void {
    if (this.navigationPending) return;
    this.render();
    // Only entry from Obsidian requests fresh data. Internal redraws must not
    // turn each completed profile request into another network request.
    void this.owner.refreshAccountProfile(false);
  }

  refresh(): void {
    if (this.visible) this.render();
  }

  private render(): void {
    // Preserve the clicked href until the browser has performed its default
    // action. Replacing this element inside the click handler can cancel it.
    if (this.navigationPending) return;
    this.hide();
    this.visible = true;
    const { containerEl } = this;
    containerEl.empty();
    this.loginButtons = [];
    this.mobileLoginLinks = [];
    this.cancelLoginButton = undefined;
    this.loginStatusEl = undefined;
    this.authorizationEl = undefined;
    containerEl.addClass("yunpan-sync-settings-page");
    if (this.owner.isMobileDevice) containerEl.addClass("yunpan-sync-mobile-settings");
    if (Platform.isAndroidApp) containerEl.addClass("yunpan-sync-android-settings");
    
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
    else this.addLoginControl(remote);

    new Setting(syncGroup).setName("同步模式")
      .setDesc(this.owner.isMobileDevice ? "移动端自动同步仅在前台运行，切到后台会暂停" : "自动同步会实时为您同步文件")
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
      .setDesc(`${MIN_SCHEDULED_INTERVAL_MINUTES} 至 ${MAX_SCHEDULED_INTERVAL_MINUTES} 分钟`).addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_SCHEDULED_INTERVAL_MINUTES);
        text.inputEl.max = String(MAX_SCHEDULED_INTERVAL_MINUTES);
        text.setValue(String(this.owner.settings.intervalMinutes)).onChange(async (value) => {
          this.owner.settings.intervalMinutes = normalizeScheduledInterval(value);
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
    let minSize = String(this.owner.settings.minFileSizeMB);
    let maxSize = String(this.owner.settings.maxFileSizeMB);
    const sizeSetting = new Setting(filterGroup).setName("单文件大小范围");
    sizeSetting.settingEl.addClass("yunpan-sync-size-setting");
    const sizeRange = sizeSetting.controlEl.createDiv({ cls: "yunpan-sync-size-range" });
    let savingRange = Promise.resolve();
    const saveRange = () => {
      const min = minSize.trim() ? Number(minSize) : NaN;
      const max = maxSize.trim() ? Number(maxSize) : NaN;
      savingRange = savingRange.then(async () => { await this.owner.setFileSizeRange(min, max); })
        .catch(error => { new Notice(`文件大小限制保存失败：${messageOf(error)}`); });
      return savingRange;
    };
    const lowerBound = sizeRange.createDiv({ cls: "yunpan-sync-size-bound yunpan-sync-size-lower" });
    lowerBound.createSpan({ text: "下限" });
    sizeSetting.addText(text => {
      text.inputEl.type = "number"; text.inputEl.min = "0"; text.inputEl.max = "500"; text.inputEl.step = "1";
      text.inputEl.ariaLabel = "单文件大小下限（MB）";
      text.setValue(minSize).onChange(value => { minSize = value; });
      lowerBound.append(text.inputEl);
      text.inputEl.addEventListener("blur", () => { void saveRange(); });
    });
    lowerBound.createSpan({ text: "MB" });
    sizeRange.createSpan({ text: "～", cls: "yunpan-sync-size-separator" });
    const upperBound = sizeRange.createDiv({ cls: "yunpan-sync-size-bound yunpan-sync-size-upper" });
    upperBound.createSpan({ text: "上限" });
    sizeSetting.addText(text => {
      text.inputEl.type = "number"; text.inputEl.min = "0"; text.inputEl.max = "500"; text.inputEl.step = "1";
      text.inputEl.ariaLabel = "单文件大小上限（MB）";
      text.setValue(maxSize).onChange(value => { maxSize = value; });
      upperBound.append(text.inputEl);
      text.inputEl.addEventListener("blur", () => { void saveRange(); });
    });
    upperBound.createSpan({ text: "MB" });
    new Setting(filterGroup).setName("同步 obsidian 配置")
      .setDesc(".obsidian 为笔记仓库的系统配置，默认关闭，开启后迁移笔记时会自动同步笔记软件配置")
      .addToggle((toggle) => toggle.setValue(this.owner.settings.syncObsidianConfig)
        .onChange((value) => void this.owner.setSyncObsidianConfig(value)));
    new Setting(filterGroup).setName("同步过滤的文件格式")
      .setDesc(this.owner.isMobileDevice
        ? "手机默认排除工程建模、音视频、压缩包和安装包；保留 Office、PDF、笔记和图片。规则可修改，仍受大小范围限制。"
        : "可按文件名、目录或通配符设置不参与同步的内容")
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
    void this.owner.prepareMobileLogin();
  }

  hide(): void {
    this.visible = false;
    this.navigationPending = false;
    clearTimeout(this.navigationRefresh);
    this.navigationRefresh = undefined;
    this.stopDismiss?.();
    this.stopDismiss = undefined;
  }

  renderLogin(): void {
    if (!this.visible || this.navigationPending) return;
    const status = this.owner.currentStatus;
    const pending = status.phase === "login";
    for (const button of this.loginButtons) button.setDisabled(false).setButtonText(pending ? "重新登录" : "登录");
    const preparation = this.owner.mobileLoginPreparation;
    const ready = preparation.ready;
    for (const link of this.mobileLoginLinks) {
      link.setText(ready ? (pending ? "重新登录" : "登录") : preparation.error ? "重试准备" : "准备登录…");
      link.setAttr("aria-disabled", String(!ready && !preparation.error));
      link.setAttr("tabindex", ready || preparation.error ? "0" : "-1");
      if (ready) link.setAttr("href", ready.authorizationUrl);
      else link.removeAttribute("href");
    }
    if (this.cancelLoginButton) this.cancelLoginButton.buttonEl.hidden = !pending;
    const loginMessage = pending || status.phase === "error" || status.message === "登录已取消" ? status.message : "";
    this.loginStatusEl?.setText([loginMessage, this.owner.isMobileDevice
      ? preparation.error || preparation.progress : ""].filter(Boolean).join("\n"));
    if (this.authorizationEl) this.authorizationEl.hidden = !this.owner.pendingAuthorizationUrl;
  }

  renderStatus(): void {
    if (!this.statusEl) return;
    const status = this.owner.currentStatus;
    const summary = summarizeTransfers(this.owner.transferProgress);
    const last = status.lastSuccess ? new Date(status.lastSuccess).toLocaleString() : "尚未完成同步";
    const completed = status.operationCompleted ?? status.completed ?? summary.completedCount;
    const readableError = status.lastError
      ? classifySyncError(status.lastError).detail
      : undefined;
    this.statusEl.setText(`${status.message}\n最新同步时间：${last}（${completed} 项同步成功，${status.failed} 项同步失败）${readableError ? `\n最近错误：${readableError}` : ""}`);
    this.statusEl.toggleClass("yunpan-sync-error", status.phase === "error");
    if (readableError && !status.restriction) renderFailedRecordAction(this.statusEl, this.owner.failedTasks, this.owner);
    if (status.restriction) this.statusEl.createEl("button", {
      text: status.restriction.kind === "membership" ? "去续费" : status.restriction.kind === "capacity" ? "去扩容" : "刷新后重试",
      cls: "mod-cta",
    }).addEventListener("click", () => void this.owner.resolveSyncRestriction());
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
      const account = new Setting(container).setName("请登录 360AI 云盘账号");
      this.addLoginControl(account);
      account.addButton((button) => {
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
      const account = new Setting(container)
        .setName(this.owner.profileLoading ? "正在加载账户信息..." : "账号：已登录")
        .setDesc(this.owner.profileError ? `账户信息加载失败：${this.owner.profileError}` : "");
      if (this.owner.profileError || this.owner.currentStatus.restriction?.kind === "membership") this.addProfileRefresh(account);
      account.addButton((button) => button.setButtonText("退出登录").onClick(() => void this.owner.logout()));
      return;
    }
    const active = hasActiveMembership(profile);
    const expired = hasExpiredMembership(profile);
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
    label.className = `yunpan-sync-membership-label${expired ? " is-expired" : ""}`;
    label.textContent = membershipLabel(profile);
    label.hidden = expired && this.owner.profileLoading;
    const membershipStatus = identityEl.createSpan({ cls: "yunpan-sync-membership-status" });
    membershipStatus.append(label);
    if (!active) {
      const purchase = identityEl.createEl("button", { text: membershipLabel(profile) === "会员已过期" ? "续费会员" : "购买会员", cls: "yunpan-sync-inline-purchase" });
      purchase.addEventListener("click", () => openMembershipPayment(this.owner.settings.environment, this.owner.isMobileDevice));
    }
    const usedBytes = profile.usedBytes ?? profile.enterpriseUsedBytes;
    const totalBytes = profile.totalBytes ?? profile.enterpriseTotalBytes;
    const storage = totalBytes === undefined
      ? formatStorageCapacity(usedBytes)
      : `${formatStorageCapacity(usedBytes)}/${formatStorageCapacity(totalBytes)}`;
    const account = new Setting(container).setDesc(`存储空间：${storage}`);
    if (expired || this.owner.currentStatus.restriction?.kind === "membership") {
      this.addProfileRefresh(account, membershipStatus);
    }
    account.addButton((button) => button.setButtonText("退出登录").onClick(() => void this.owner.logout()));
    if (this.owner.profileError) account.descEl.createDiv({
      text: `账户信息刷新失败：${this.owner.profileError}，当前显示上次信息，请重试。`, cls: "yunpan-sync-profile-error" });
    account.nameEl.empty();
    account.nameEl.append(identityEl);
  }

  private addProfileRefresh(account: Setting, inline?: HTMLElement): void {
    account.addButton(button => {
      button.setIcon("refresh-cw").setTooltip("刷新会员状态")
        .setDisabled(this.owner.profileLoading).onClick(() => this.owner.refreshAccountProfile());
      button.buttonEl.addClass("clickable-icon");
      button.buttonEl.addClass("yunpan-sync-membership-refresh");
      button.buttonEl.toggleClass("is-loading", this.owner.profileLoading);
      button.buttonEl.setAttr("aria-label", "刷新会员状态");
      button.buttonEl.setAttr("aria-busy", String(this.owner.profileLoading));
      inline?.append(button.buttonEl);
    });
  }

  private startLogin(): Promise<void> {
    return this.owner.currentStatus.phase === "login" ? this.owner.relogin() : this.owner.login();
  }

  private addLoginControl(setting: Setting): void {
    if (!this.owner.isMobileDevice) {
      setting.addButton((button) => {
        this.loginButtons.push(button);
        button.setButtonText("登录").setCta().onClick(() => void this.startLogin());
      });
      return;
    }
    const link = setting.controlEl.createEl("a", {
      text: "准备登录…", cls: "external-link yunpan-sync-login-link mod-cta",
      attr: { target: "_blank", rel: "noopener noreferrer", "aria-disabled": "true", tabindex: "-1" },
    });
    this.mobileLoginLinks.push(link);
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented) return;
      this.navigationPending = true;
      if (!this.owner.activateMobileLogin(link.getAttribute("href"))) {
        event.preventDefault();
        this.navigationPending = false;
        this.renderLogin();
        return;
      }
      // A new task runs after native link navigation, rather than during the
      // event's microtask checkpoint. Never synthesize another click.
      this.navigationRefresh = setTimeout(() => {
        this.navigationRefresh = undefined;
        this.navigationPending = false;
        this.refresh();
      }, 0);
    });
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !link.hasAttribute("href") && this.owner.mobileLoginPreparation.error) {
        event.preventDefault();
        void this.owner.prepareMobileLogin(true);
      }
    });
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
