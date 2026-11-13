import { TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import { buildConflictPath, explainIgnoredPath, joinRemotePath, normalizeVaultPath, remoteToVaultPath, shouldIgnorePath, WindowsPathError, compilePathFilter, validateWindowsPathSegment,
  type PathFilterOptions } from "../domain/paths.js";
import { planThreeWay, snapshotsEqual, type SyncSnapshot } from "../domain/planner.js";
import { OpenApiError, type OpenApiMethod } from "../net/openapi-client.js";
import type { PluginSettings } from "../settings.js";
import { SyncDatabase, type RemoteNode, type SyncTask } from "../storage/database.js";
import type { UploadMachine } from "../transfer/upload.js";
import type { DownloadMachine } from "../transfer/download.js";
import { hashSource } from "../transfer/hashes.js";
import { memorySource, openDesktopSource, openDesktopSink } from "../transfer/file-io.js";
import { WorkScheduler, cooperativeSort, type SyncDiagnostics } from "./work-scheduler.js";
import { TaskRunner } from "./task-runner.js";
import { RemoteIndexer, directorySnapshotScope } from "./remote-indexer.js";
import { TransferProgressTracker, type FileTransferProgress } from "./progress.js";
import { syncCompletionMessage } from "./outcome.js";
import { assertSyncQuota, syncRestrictionError, type SyncQuota, type SyncRestriction } from "./quota.js";
import { normalizeAccountProfile } from "../account/profile.js";
import { fileSizeExclusion, ProtectedPaths, TaskSkippedError, type SkippedFile, type SkippedFileSource } from "./file-policy.js";
import { DownloadCache } from "../transfer/download-cache.js";
import type { TaskRunnerOptions } from "./task-runner.js";
import { formatDisplayPath } from "../ui/path-display.js";

interface Api { call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> }
export interface EngineStatus { phase: string; message: string; queued: number; failed: number; completed?: number;
  operationTotal?: number; operationCompleted?: number;
  conflicts?: number; lastSuccess?: number; lastError?: string; failedTasks?: SyncTask[]; fileFailures?: SyncFileFailure[];
  warnings?: string[]; restriction?: SyncRestriction; diagnostics?: SyncDiagnostics; skippedFiles?: SkippedFile[] }
export interface SyncFileFailure { id?: string; source?: "local" | "remote"; nid?: string; path: string; error: Error & { characters?: readonly string[] } }
export interface SyncRunSummary {
  files: Array<{ path: string; size: number; destination?: string }>;
  failures: Array<{ path: string; reason: string }>;
  cancelled: boolean;
}
export type ConfirmSyncTasks = (tasks: readonly SyncTask[]) => Promise<ReadonlySet<string> | undefined>;

export class SyncCancelledError extends Error {
  constructor(message = "同步已停止") {
    super(message);
    this.name = "SyncCancelledError";
  }
}

function remoteSnapshot(node: RemoteNode): SyncSnapshot {
  return { nid: node.nid, hash: node.hash, size: node.size, mtime: node.mtime,
    kind: node.isDir ? "directory" : "file", version: node.version };
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length); copy.set(bytes); return copy.buffer;
}

interface PathSnapshot { path: string; snapshot: SyncSnapshot; sourcePath?: string; derivedFrom?: string }
function pathKey(path: string): string { return path.normalize("NFC").toLocaleLowerCase("en-US"); }
function validateTaskPath(path: string): void {
  if (!path || normalizeVaultPath(path) !== path) throw new Error("旧任务路径需要重新检测");
}

interface LocalRenamePayload {
  destination: string;
  local?: SyncSnapshot;
  remote?: SyncSnapshot;
  base?: SyncSnapshot;
  conflict?: boolean;
  basePath?: string;
  conflictPath?: string;
}

interface RemoteRenamePayload { destination: string; base?: SyncSnapshot; intermediatePath?: string }

export function isAlreadyDeletedRemoteError(error: unknown): boolean {
  if (error instanceof OpenApiError && error.errno === 3008) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /源文件不存在|source\s+(?:file\s+)?does\s+not\s+exist|source\s+not\s+found/i.test(message);
}

function isAlreadyExistingRemoteNodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already\s+exists|same\s+name|node\s+exists|已存在|重复|同名/i.test(message);
}

function parentVaultPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

export class SyncEngine {
  private running = false;
  private lastSuccess?: number;
  private lastError?: string;
  private readonly transfers = new TransferProgressTracker();
  private fileFailures: SyncFileFailure[] = [];
  private pendingValidationFailures: SyncFileFailure[] = [];
  private cancelled = false;
  private stopReason = "同步已停止";
  private idleWaiters: Array<() => void> = [];
  private completed = 0;
  private operationTotal = 0;
  private operationCompleted = 0;
  private warnings: string[] = [];
  private renameRefreshUsed = false;
  private restriction?: SyncRestriction;
  private readonly discardAfterPreflight = new Set<string>();
  private planTaskIndex = new Map<string, SyncTask>();
  private conflictPaths = new Set<string>();
  private work = new WorkScheduler(() => this.throwIfCancelled());
  private compiledFilter?: PathFilterOptions;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private lastProgressReport = 0;
  private lastTransferReport = 0;
  private diagnostic?: SyncDiagnostics;
  private stage = "";
  private stageMessage = "";
  private stageStarted = 0;
  private protectedPaths = new ProtectedPaths();
  private protectedNids = new Set<string>();
  private refreshForRetry = false;
  private runSettings?: PluginSettings;
  private cancellation?: AbortController;
  private runFiles: SyncRunSummary["files"] = [];
  private runTaskIds = new Set<string>();
  private runFailures: Array<{ path: string; reason: string }> = [];
  private lastRunSummary?: SyncRunSummary;

  constructor(
    private readonly vault: Vault,
    private readonly database: SyncDatabase,
    private readonly api: Api,
    private readonly uploader: UploadMachine,
    private readonly downloader: DownloadMachine,
    private readonly settings: () => PluginSettings,
    private readonly accountKey: string,
    private readonly report: (status: EngineStatus) => void,
    private readonly checkpoint: () => Promise<void> = async () => undefined,
    private readonly reportTransfers: (transfers: FileTransferProgress[]) => void = () => undefined,
    private readonly loadQuota?: () => Promise<SyncQuota>,
    private readonly retryOptions: Pick<TaskRunnerOptions, "maxAttempts" | "retryDelay"> = {},
  ) {
    this.lastSuccess = database.getLastSuccessfulSync();
  }

  isRunning(): boolean { return this.running; }
  cancel(message = "同步已停止"): void {
    this.cancelled = true;
    this.stopReason = message;
    this.cancellation?.abort();
  }
  getCancellationSignal(): AbortSignal | undefined { return this.cancellation?.signal; }
  getLastRunSummary(): SyncRunSummary | undefined {
    return this.lastRunSummary ? {
      files: this.lastRunSummary.files.map(file => ({ ...file })),
      failures: this.lastRunSummary.failures.map(failure => ({ ...failure })),
      cancelled: this.lastRunSummary.cancelled,
    } : undefined;
  }
  checkContinuing(): void { if (this.running) this.throwIfCancelled(); }
  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  needsInitialConfirmation(): boolean { return !this.database.isBindingConfirmed(this.accountKey); }

  clearMembershipRestriction(): void {
    if (this.running || this.restriction?.kind !== "membership") return;
    this.restriction = undefined;
    this.lastError = undefined;
  }

  async synchronize(rebuild = false, confirmTasks?: ConfirmSyncTasks): Promise<boolean> {
    if (this.running || this.settings().paused) return false;
    this.running = true;
    this.cancellation = new AbortController();
    this.pendingValidationFailures = [...this.fileFailures];
    this.runSettings = { ...this.settings(), filterRules: this.settings().filterRules.map(rule => ({ ...rule })) };
    this.runFiles = [];
    this.runTaskIds.clear();
    this.runFailures = [];
    this.lastRunSummary = undefined;
    this.protectedPaths = new ProtectedPaths();
    this.protectedNids.clear();
    this.completed = 0;
    this.operationTotal = 0;
    this.operationCompleted = 0;
    this.compiledFilter = undefined;
    this.work = new WorkScheduler(() => this.throwIfCancelled());
    this.diagnostic = { startedAt: Date.now(), durationMs: 0, stages: {}, remoteNodes: 0,
      matchedNodes: 0, localFiles: 0, localBytes: 0, longestBatchMs: 0 };
    this.stage = "";
    this.stageStarted = performance.now();
    this.cancelled = false;
    this.stopReason = "同步已停止";
    this.lastError = undefined;
    this.warnings = [];
    this.restriction = undefined;
    this.discardAfterPreflight.clear();
    this.renameRefreshUsed = false;
    this.transfers.reset();
    this.publishTransfers();
    const runId = crypto.randomUUID();
    
    
    try {
      this.throwIfCancelled();
      if (!this.database.getCursor(this.accountKey) && this.database.hasBases()) {
        this.database.resetSyncState();
      }
      this.emit("account", "正在检查会员状态与云盘容量");
      const quota = await this.work.waitFor(() => this.currentQuota());
      assertSyncQuota(quota, []);
      this.throwIfCancelled();
      rebuild ||= this.refreshForRetry;
      if (!rebuild) await this.bindKnownRenameIdentities();
      this.emit("remote-index", "正在检查云端文件变化…");
      const indexer = new RemoteIndexer(this.api, this.database, this.accountKey, 200, {
        check: () => this.throwIfCancelled(), work: this.work, remoteRoot: this.runSettings.remoteRoot,
        progress: (stage, count) => {
          if (this.diagnostic) this.diagnostic.remoteNodes = count;
          this.progress(stage, `正在获取云端文件信息…${count > 0 ? `（已读取 ${count.toLocaleString("en-US")} 项）` : ""}`);
        },
      });
      if (rebuild) {
        await indexer.rebuild();
      } else await indexer.update();
      this.throwIfCancelled();
      this.refreshForRetry = false;
      this.fileFailures = [];
      this.protectedPaths = new ProtectedPaths();
      this.protectedNids.clear();
      for (const failure of indexer.failures) this.recordFileFailure(failure.path, failure.error, "远端目录暂不可同步", failure.nid);
      if (indexer.failures.length) {
        const blocked = new Set(indexer.failures.map(failure => failure.nid));
        for await (const batch of this.database.baseBatches()) for (const [path, snapshot] of batch) {
          // Uploads may be newer than the cached index. Protect the old name by
          // baseline identity too; legacy directories without identity are ambiguous.
          if (snapshot.kind === "directory" && (!snapshot.nid || blocked.has(snapshot.nid))) {
            this.protectedPaths.add(path, "对应云端目录无法读取，已保留本地目录与同步基线", "both");
          }
        }
      }
      const structural = new TaskRunner(this.database, {
        "local-rename": (task) => this.executeChecked(task, () => this.renameLocal(task)),
        rename: (task) => this.executeChecked(task, () => this.renameRemote(task)),
        move: (task) => this.executeChecked(task, () => this.moveRemote(task)),
      }, { ...this.retryOptions, kinds: ["local-rename", "rename", "move"], waitForRetries: true,
        onRetryWait: () => this.emit("retry-wait", "正在等待结构任务重试"),
        checkpoint: this.checkpoint, shouldCancel: () => this.cancelled,
        onTaskSettled: () => this.reportTaskSettled() });
      let appliedChanges = 0;
      this.emit("compare", "正在检查需要同步的文件…");
      await this.planTasks();
      this.pendingValidationFailures = [];
      const planned = this.pendingPlanTasks();
      const initialConfirmation = this.needsInitialConfirmation();
      let selectedTasks = planned;
      if (confirmTasks && (planned.length > 0 || initialConfirmation)) {
        const selected = await confirmTasks(planned);
        this.throwIfCancelled();
        if (!selected || (planned.length > 0 && selected.size === 0)) throw new SyncCancelledError();
        selectedTasks = planned.filter((task) => selected.has(task.id));
        selectedTasks = selectedTasks.filter(task => {
          const parent = (task.payload as { derivedFrom?: string }).derivedFrom;
          return !parent || selected.has(parent);
        });
      }
      await this.checkQuota(quota, selectedTasks);
      this.operationTotal = selectedTasks.length;
      this.operationCompleted = 0;
      this.runTaskIds = new Set(selectedTasks.map(task => task.id));
      this.runFiles = selectedTasks.map(task => this.summarizeTaskFile(task));
      const selectedIds = new Set(selectedTasks.map(task => task.id));
      this.database.removeTasks([...this.discardAfterPreflight,
        ...planned.filter(task => !selectedIds.has(task.id)).map(task => task.id)]);
      this.discardAfterPreflight.clear();
      await this.checkpoint();
      if (this.needsInitialConfirmation()) {
        if (!confirmTasks && planned.length > 0) throw new Error("首次同步需要用户确认");
        this.database.confirmBinding(this.accountKey);
        await this.checkpoint();
      }
      appliedChanges += await structural.drain();
      this.throwIfCancelled();
      const blockedStructure = this.database.listPendingTasks().filter(task => ["local-rename", "rename", "move"].includes(task.kind));
      if (blockedStructure.length) throw new Error(blockedStructure.find(task => task.lastError)?.lastError ?? `${blockedStructure.length} sync tasks failed`);
      appliedChanges += await this.ensureRemoteRoot();
      await this.queueTransferProgress();
      this.emit("transfer", "正在执行同步任务");
      // Local directories, deletions and directory conflicts are structural work.
      const localStructure = this.database.listTransferTasks().filter(task => task.kind === "download" &&
        (this.payload(task).remote?.kind === "directory" || this.payload(task).remoteDeleted ||
          (this.payload(task).conflict && this.payload(task).local?.kind === "directory"))).map(task => task.id);
      appliedChanges += await new TaskRunner(this.database, {
        download: task => this.executeChecked(task, () => this.download(task)),
      }, { ...this.retryOptions, kinds: ["download"], taskIds: localStructure, dependencies: true, waitForRetries: true,
        onRetryWait: () => this.emit("retry-wait", "正在等待目录任务重试"),
        checkpoint: this.checkpoint, shouldCancel: () => this.cancelled,
        onTaskSettled: () => this.reportTaskSettled() }).drain();
      this.throwIfCancelled();
      const preparation = new TaskRunner(this.database, {
        mkdir: (task) => this.executeChecked(task, () => this.createRemoteDirectory(task)),
        recycle: (task) => this.executeChecked(task, () => this.recycleRemote(task)),
      }, { ...this.retryOptions, kinds: ["mkdir", "recycle"], dependencies: true, waitForRetries: true,
        onRetryWait: () => this.emit("retry-wait", "请求暂未成功，正在等待自动重试"),
        checkpoint: this.checkpoint, shouldCancel: () => this.cancelled,
        onTaskSettled: () => this.reportTaskSettled() });
      appliedChanges += await preparation.drain();
      this.throwIfCancelled();
      const runner = new TaskRunner(this.database, {
        upload: (task) => this.executeChecked(task, () => this.upload(task)),
        download: (task) => this.executeChecked(task, () => this.download(task)),
      }, { ...this.retryOptions, kinds: ["upload", "download"], dependencies: true, waitForRetries: true,
        onRetryWait: () => this.emit("retry-wait", "正在等待重试，其他文件将继续同步"),
        concurrency: 5, checkpoint: this.checkpoint, shouldCancel: () => this.cancelled,
        onTaskSettled: () => this.reportTaskSettled() });
      appliedChanges += await runner.drain();
      this.throwIfCancelled();
      this.database.failBlockedTasks();
      for (const task of this.database.listFailedTasks()) if (task.state === "failed") this.transfers.fail(task.id, task.lastError ?? "同步失败");
      runner.assertSettled();
      this.completed = appliedChanges;
      if (this.fileFailures.length > 0) {
        this.lastError = `${this.fileFailureCount()} sync files failed`;
        this.emit("error", this.lastError);
        
        return false;
      }
      this.lastSuccess = Date.now();
      this.database.setLastSuccessfulSync(this.lastSuccess);
      this.emit("idle", syncCompletionMessage(appliedChanges));
      
      return true;
    } catch (error) {
      this.fileFailures = this.visibleFileFailures();
      this.pendingValidationFailures = [];
      if (this.cancelled) error = new SyncCancelledError(this.stopReason);
      if (error instanceof SyncCancelledError) {
        // A task-selection dismissal is also a user cancellation even though
        // it happens before the engine's explicit cancel() method is called.
        // Keep the run summary from being reported as a completed result.
        this.cancelled = true;
        this.emit("paused", error.message);
        
        return false;
      }
      const restriction = syncRestrictionError(error);
      this.restriction = restriction;
      const message = restriction?.message ?? (error instanceof Error ? error.message : String(error));
      const traceId = error instanceof OpenApiError ? error.traceId : undefined;
      const failedTasks = this.database.listFailedTasks();
      this.lastError = !restriction && this.failureCount(failedTasks) > 0
        ? `${this.failureCount(failedTasks)} sync files failed`
        : traceId ? `${message} (trace_id: ${traceId})` : message;
      this.emit("error", this.lastError, traceId);
      
      throw restriction ?? error;
    } finally {
      try {
        const failedTasks = this.database.listFailedTasks().filter(task => task.state === "failed" && this.runTaskIds.has(task.id));
        const failures = [...failedTasks.map(task => ({ path: task.path, reason: task.lastError ?? "同步失败" })),
          ...this.fileFailures.map(failure => ({ path: failure.path, reason: failure.error.message }))];
        this.runFailures = [...new Map(failures.map(failure => [pathKey(failure.path), failure])).values()];
        this.lastRunSummary = {
          files: this.runFiles.map(file => ({ ...file })),
          failures: this.runFailures.map(failure => ({ ...failure })),
          cancelled: this.cancelled,
        };
        const pendingIds = new Set(this.database.listPendingTasks().map(task => task.id));
        for (const state of this.database.downloadStates()) {
          if (!pendingIds.has(state.taskId)) await new DownloadCache(this.vault.adapter, this.database,
            state.binding, state.taskId, this.checkpoint).clear();
        }
        const pendingTransferIds = new Set(this.database.listTransferTasks().map(task => task.id));
        for (const transfer of this.transfers.snapshot()) {
          if (transfer.state !== "completed" && !pendingTransferIds.has(transfer.id)) this.transfers.remove(transfer.id);
        }
        this.publishTransfers(true);
        this.finishStage();
        if (this.diagnostic) {
          this.diagnostic.durationMs = Date.now() - this.diagnostic.startedAt;
          this.diagnostic.longestBatchMs = this.work.longestBatchMs;
          this.database.saveDiagnostics(this.diagnostic);
        }
        await this.checkpoint();
      } finally {
        this.running = false;
        this.cancellation = undefined;
        this.runSettings = undefined;
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private async currentQuota(): Promise<SyncQuota> {
    if (this.loadQuota) return this.loadQuota();
    return normalizeAccountProfile(await this.api.call<Record<string, unknown>>("User.getUserDetail", {}), this.settings().ownerQid);
  }

  private pendingPlanTasks(): SyncTask[] {
    const tasks = this.database.listPendingTasks();
    if (this.discardAfterPreflight.size) {
      const children = new Map<string, string[]>();
      for (const task of tasks) {
        const parent = (task.payload as { derivedFrom?: string }).derivedFrom;
        if (parent) { const group = children.get(parent) ?? []; group.push(task.id); children.set(parent, group); }
      }
      const queue = [...this.discardAfterPreflight];
      for (let index = 0; index < queue.length; index++) {
        for (const id of children.get(queue[index]!) ?? []) {
          if (!this.discardAfterPreflight.has(id)) { this.discardAfterPreflight.add(id); queue.push(id); }
        }
      }
    }
    return tasks.filter(task => !this.discardAfterPreflight.has(task.id));
  }

  private async checkQuota(quota: SyncQuota, tasks: readonly SyncTask[]): Promise<void> {
    const current: SyncTask[] = [];
    for (const task of tasks) {
      await this.work.step();
      const payload = task.payload as { sourcePath?: string; local?: SyncSnapshot };
      if (task.kind !== "upload") { current.push(task); continue; }
      const stat = await this.vault.adapter.stat(payload.sourcePath ?? task.path);
      current.push({ ...task, payload: { ...payload, local: stat?.type === "file"
        ? { ...payload.local, kind: "file", size: stat.size } : undefined } });
    }
    assertSyncQuota(quota, current);
  }

  retryFailed(): number {
    if (this.running) return 0;
    this.refreshForRetry = true;
    return this.database.retryFailedTasks() + this.fileFailures.length;
  }
  retryTask(id: string): boolean {
    if (this.running) return false;
    const scan = this.fileFailures.some(failure => failure.id === id);
    const retried = scan || this.database.retryTask(id);
    if (retried) this.refreshForRetry = true;
    return retried;
  }
  removeFailedTask(id: string): boolean {
    if (this.running) return false;
    const removed = this.database.removeFailedTask(id);
    if (!removed) return false;
    this.transfers.remove(id);
    this.publishTransfers();
    const failures = this.failureCount();
    this.lastError = failures > 0 ? `${failures} sync files failed` : undefined;
    this.emit(failures > 0 ? "error" : "idle", failures > 0 ? "部分文件同步失败" : "失败记录已清除，可重新同步");
    return true;
  }
  resumePendingRetries(): number { return this.database.makeRetryTasksRunnable(); }

  recordRename(source: string, destination: string): void {
    const normalizedSource = normalizeVaultPath(source);
    const normalizedDestination = normalizeVaultPath(destination);
    const filter = this.pathFilter();
    if (shouldIgnorePath(normalizedSource, filter) || shouldIgnorePath(normalizedDestination, filter) ||
      this.database.consumeSuppression(normalizedSource)) return;
    const previous = this.database.listPendingTasks().find(task =>
      (task.kind === "rename" || task.kind === "move") &&
      pathKey((task.payload as RemoteRenamePayload).destination) === pathKey(normalizedSource));
    const base = previous ? (previous.payload as RemoteRenamePayload).base ?? this.database.getBase(previous.path)
      : this.database.getBase(normalizedSource);
    this.database.transaction(() => {
      this.database.relocateTasks(normalizedSource, normalizedDestination);
      if (!base && !previous) return;
      const original = previous?.path ?? normalizedSource;
      const task = { id: previous?.id ?? crypto.randomUUID(),
        kind: parentVaultPath(original) === parentVaultPath(normalizedDestination) ? "rename" as const : "move" as const,
        path: original, nid: previous?.nid ?? base?.nid, payload: { destination: normalizedDestination, base } };
      if (previous) this.database.replacePendingTask(previous.id, task);
      else this.database.enqueue(task);
    });
  }

  consumeSuppression(path: string): boolean { return this.database.consumeSuppression(normalizeVaultPath(path)); }

  private async bindKnownRenameIdentities(): Promise<void> {
    const tasks = this.database.listPendingTasks().filter(task => task.kind === "rename" || task.kind === "move");
    if (!tasks.length) return;
    const remote = await this.remoteMap();
    for (const task of tasks) {
      await this.work.step();
      if (this.discardAfterPreflight.has(task.id) || this.taskProtected(task)) continue;
      if (task.kind !== "rename" && task.kind !== "move") continue;
      const payload = task.payload as RemoteRenamePayload;
      const base = payload.base ?? this.database.getBase(task.path);
      const source = remote.get(pathKey(task.path));
      const nid = task.nid ?? base?.nid ?? (base && source && snapshotsEqual(base, source.snapshot) ? source.snapshot.nid : undefined);
      if (!nid || (task.nid === nid && payload.base)) continue;
      this.database.replacePendingTask(task.id, { ...task, nid, payload: { ...payload, base } });
    }
  }

  private async reconcileLocalRenames(): Promise<void> {
    await this.bindKnownRenameIdentities();
    for (const task of this.database.listPendingTasks()) {
      if (this.discardAfterPreflight.has(task.id) || this.taskProtected(task)) continue;
      if (task.kind !== "rename" && task.kind !== "move") continue;
      const resolution = await this.renameResolution(task);
      if (resolution === "execute") continue;
      if (resolution) this.database.replacePendingTask(task.id, resolution);
      else this.discardAfterPreflight.add(task.id);
      await this.checkpoint();
    }
  }

  private async renameResolution(task: SyncTask): Promise<SyncTask | "execute" | undefined> {
    const payload = task.payload as RemoteRenamePayload;
    const destination = normalizeVaultPath(payload.destination);
    const remote = await this.remoteMap();
    const source = remote.get(pathKey(task.path));
    const base = payload.base ?? this.database.getBase(task.path);
    const nid = task.nid ?? base?.nid;
    const current = nid ? [...remote.values()].find(entry => entry.snapshot.nid === nid) : source;
    if (source && nid && source.snapshot.nid !== nid) throw new Error(`云端原路径已被其他对象占用，不能重命名: ${task.path}`);
    if (!current) {
      const warning = "旧改名任务已失效，无法确认云端对应文件，已保留两端文件并重新比较。";
      if (!this.warnings.includes(warning)) this.warnings.push(warning);
      
      return undefined;
    }
    if (!nid && (!base || !snapshotsEqual(base, current.snapshot))) {
      throw new Error(`无法确认云端原路径的对象身份，不能重命名: ${task.path}`);
    }
    const stat = await this.vault.adapter.stat(destination);
    const localKind = stat?.type === "folder" ? "directory" : stat?.type === "file" ? "file" : undefined;
    if ((base && base.kind !== current.snapshot.kind) || (localKind && localKind !== current.snapshot.kind)) {
      throw new Error(`重命名对象类型冲突: ${destination}`);
    }
    if (current.path === task.path || current.path === payload.intermediatePath) return "execute";
    if (pathKey(current.path) === pathKey(destination)) {
      this.database.moveBase(task.path, destination);
      if (base) this.database.putBase(destination, { ...base, nid: current.snapshot.nid });
      return undefined;
    }
    const local = await this.scanLocal();
    const localEntry = local.get(pathKey(destination));
    if (!localEntry) throw new Error(`本地重命名目标不存在: ${destination}`);
    if (await this.destinationOccupied(local, pathKey(destination), pathKey(current.path))) {
      throw new Error(`Local rename destination already exists: ${current.path}`);
    }
    if ((base && localEntry.snapshot.kind !== base.kind) || localEntry.snapshot.kind !== current.snapshot.kind) {
      throw new Error(`重命名对象类型冲突: ${destination}`);
    }
    return { ...task, kind: "local-rename", path: destination, nid: current.snapshot.nid, nextRunAt: 0,
      payload: { destination: current.path, basePath: task.path, base,
        local: localEntry.snapshot, remote: current.snapshot, conflict: true } satisfies LocalRenamePayload };
  }

  private emit(phase: string, message: string, traceId?: string): void {
    if (["idle", "paused", "error"].includes(phase)) this.publishTransfers(true);
    if (phase !== this.stage) { this.finishStage(); this.stage = phase; this.stageStarted = performance.now(); }
    const counts = this.database.taskCounts();
    const failedTasks = this.database.listFailedTasks().filter(task => task.state === "failed");
    const failureCount = this.failureCount(failedTasks);
    const displayMessage = phase === "error" && failureCount > 0 && !this.restriction ? "部分文件同步失败" : message;
    this.stageMessage = displayMessage;
    
    this.report({ phase, message: displayMessage, queued: counts.queued, failed: failureCount, completed: this.completed,
      operationTotal: this.operationTotal, operationCompleted: this.operationCompleted,
      conflicts: this.database.unresolvedConflictCount(), lastSuccess: this.lastSuccess, lastError: this.lastError,
      failedTasks, fileFailures: this.visibleFileFailures(), warnings: [...this.warnings], restriction: this.restriction,
      skippedFiles: this.protectedPaths.entries(),
      diagnostics: this.diagnostic });
  }

  private reportTaskSettled(): void {
    this.operationCompleted++;
    this.emit(this.stage || "transfer", this.stageMessage || "正在执行同步任务");
  }

  private finishStage(): void {
    if (this.diagnostic && this.stage) this.diagnostic.stages[this.stage] =
      (this.diagnostic.stages[this.stage] ?? 0) + performance.now() - this.stageStarted;
    this.stageStarted = performance.now();
  }

  private progress(phase: string, message: string): void {
    if (phase !== this.stage) { this.finishStage(); this.stage = phase; }
    if (Date.now() - this.lastProgressReport < 200) return;
    this.lastProgressReport = Date.now();
    this.emit(phase, message);
  }

  private failureCount(failedTasks = this.database.listFailedTasks().filter(task => task.state === "failed")): number {
    return new Set([...failedTasks.map((task) => pathKey(task.path)), ...this.visibleFileFailures().map((failure) => pathKey(failure.path))]).size;
  }

  private visibleFileFailures(): SyncFileFailure[] {
    return [...new Map([...this.pendingValidationFailures, ...this.fileFailures]
      .map(failure => [failure.id ?? pathKey(failure.path), failure])).values()];
  }

  private fileFailureCount(): number { return this.failureCount([]); }

  private pathFilter(): PathFilterOptions {
    if (this.compiledFilter && this.running) return this.compiledFilter;
    const settings = this.runSettings ?? this.settings();
    const filter = compilePathFilter({ syncObsidianConfig: settings.syncObsidianConfig,
      filterRules: settings.filterRules, pluginId: "yunpan-sync" });
    if (this.running) this.compiledFilter = filter;
    return filter;
  }

  private async localSnapshot(path: string, read: () => Promise<ArrayBuffer>, stat: { size: number; mtime: number }): Promise<SyncSnapshot> {
    const current = await this.work.waitFor(() => this.vault.adapter.stat(path));
    if (current?.type === "file" && this.excludeSize(path, current.size, "local")) throw new TaskSkippedError("本地文件大小不在同步范围内");
    const before = { size: stat.size, mtime: stat.mtime };
    const source = await this.work.waitFor(() => openDesktopSource(this.vault.adapter, path))
      ?? memorySource(new Uint8Array(await this.work.waitFor(read)));
    try {
      if (this.excludeSize(path, source.size, "local")) throw new TaskSkippedError("本地文件大小不在同步范围内");
      const hashed = await hashSource(source, () => this.throwIfCancelled(), () => {
        this.progress("local-scan", `正在检查本地文件：${formatDisplayPath(path)}`);
      }, this.work);
      const after = await this.work.waitFor(() => this.vault.adapter.stat(path));
      if (!after || after.type !== "file" || after.size !== before.size || after.mtime !== before.mtime || source.size !== before.size) {
        throw new Error(`Local file changed while scanning: ${path}`);
      }
      if (this.diagnostic) { this.diagnostic.localFiles++; this.diagnostic.localBytes += source.size; }
      return { hash: hashed.fileHash, ...before, kind: "file" };
    } finally { await source.close(); }
  }

  private async scanLocal(): Promise<Map<string, PathSnapshot>> {
    this.progress("local-scan", "正在检查本地文件…");
    const result = new Map<string, PathSnapshot>();
    const filter = this.pathFilter();
    const entries = await cooperativeSort(this.vault.getAllLoadedFiles().filter((entry) => Boolean(entry.path)),
      (left, right) => left.path.localeCompare(right.path), this.work);
    for (const entry of entries) {
      await this.work.step();
      this.progress("local-scan", `正在检查本地文件：${formatDisplayPath(entry.path)}`);
      try {
        if (entry.path.includes("\\")) {
          throw new WindowsPathError("invalid-character", "\\", "文件名包含 Windows 不支持的字符", ["\\"]);
        }
        normalizeVaultPath(entry.path);
      } catch (error) {
        if (error instanceof WindowsPathError) {
          this.recordFileFailure(entry.path, error, "本地路径不支持同步");
          continue;
        }
        throw error;
      }
      if (shouldIgnorePath(entry.path, filter)) { this.protectedPaths.add(entry.path, explainIgnoredPath(entry.path, filter) ?? "路径过滤规则", "local"); continue; }
      if (this.protectedPaths.has(entry.path)) continue;
      if (entry instanceof TFolder) {
        if (result.has(pathKey(entry.path))) throw new Error(`Local vault contains a case-insensitive path collision: ${entry.path}`);
        result.set(pathKey(entry.path), { path: entry.path, snapshot: { size: 0, mtime: 0, kind: "directory" } });
      } else if (entry instanceof TFile) {
        if (this.excludeSize(entry.path, entry.stat.size, "local")) continue;
        if (result.has(pathKey(entry.path))) throw new Error(`Local vault contains a case-insensitive path collision: ${entry.path}`);
        try {
          result.set(pathKey(entry.path), { path: entry.path,
            snapshot: await this.localSnapshot(entry.path, () => this.vault.readBinary(entry), entry.stat) });
        } catch (error) { if (!(error instanceof TaskSkippedError)) throw error; }
      }
    }
    if (filter.syncObsidianConfig) await this.scanObsidianConfig(result, filter);
    return result;
  }

  private recordFileFailure(path: string, error: Error, prefix?: string, nid?: string): void {
    const message = prefix ? `${prefix}：${path}。${error.message}` : error.message;
    const wrapped = error instanceof WindowsPathError
      ? new WindowsPathError(error.issue, error.segment, message, error.characters) : new Error(message);
    if (!this.fileFailures.some((failure) => pathKey(failure.path) === pathKey(path))) {
      this.fileFailures.push({ id: `scan:${nid ? `remote:${nid}` : `local:${path}`}`, source: nid ? "remote" : "local", nid, path, error: wrapped });
    }
    if (nid) this.protectedNids.add(nid);
    const root = this.settings().remoteRoot;
    const relative = nid && path.toLowerCase().startsWith(root.toLowerCase()) ? path.slice(root.length) : path;
    this.protectedPaths.add(relative, wrapped.message, nid ? "remote" : "local");
  }

  private async scanObsidianConfig(result: Map<string, PathSnapshot>, filter: PathFilterOptions): Promise<void> {
    if (!await this.vault.adapter.exists(".obsidian", false)) return;
    result.set(pathKey(".obsidian"), { path: ".obsidian", snapshot: { size: 0, mtime: 0, kind: "directory" } });
    const walk = async (directory: string): Promise<void> => {
      const listed = await this.vault.adapter.list(directory);
      for (const rawPath of listed.folders) {
        await this.work.step();
        const path = rawPath.replaceAll("\\", "/");
        try { normalizeVaultPath(path); }
        catch (error) {
          if (error instanceof WindowsPathError) { this.recordFileFailure(path, error, "本地路径不支持同步"); continue; }
          throw error;
        }
        if (shouldIgnorePath(path, filter)) { this.protectedPaths.add(path, explainIgnoredPath(path, filter) ?? "路径过滤规则", "local"); continue; }
        if (this.protectedPaths.has(path)) continue;
        result.set(pathKey(path), { path, snapshot: { size: 0, mtime: 0, kind: "directory" } });
        await walk(path);
      }
      for (const rawPath of listed.files) {
        await this.work.step();
        const path = rawPath.replaceAll("\\", "/");
        try { normalizeVaultPath(path); }
        catch (error) {
          if (error instanceof WindowsPathError) { this.recordFileFailure(path, error, "本地路径不支持同步"); continue; }
          throw error;
        }
        if (shouldIgnorePath(path, filter)) { this.protectedPaths.add(path, explainIgnoredPath(path, filter) ?? "路径过滤规则", "local"); continue; }
        if (this.protectedPaths.has(path)) continue;
        const stat = await this.vault.adapter.stat(path);
        if (!stat || stat.type !== "file") continue;
        if (this.excludeSize(path, stat.size, "local")) continue;
        try {
          result.set(pathKey(path), { path, snapshot: await this.localSnapshot(path, () => this.vault.adapter.readBinary(path), stat) });
        } catch (error) { if (!(error instanceof TaskSkippedError)) throw error; }
      }
    };
    await walk(".obsidian");
  }

  private async remoteMap(): Promise<Map<string, PathSnapshot>> {
    const result = new Map<string, PathSnapshot>();
    const nameIssues = new Map<string, WindowsPathError | null>();
    const nameIssue = (node: RemoteNode): WindowsPathError | undefined => {
      const chain: RemoteNode[] = [];
      let current: RemoteNode | undefined = node;
      const seen = new Set<string>();
      let issue: WindowsPathError | undefined;
      while (current && !seen.has(current.nid)) {
        seen.add(current.nid);
        if (nameIssues.has(current.nid)) { issue = nameIssues.get(current.nid) ?? undefined; break; }
        chain.push(current);
        try { validateWindowsPathSegment(current.name); }
        catch (error) { if (error instanceof WindowsPathError) { issue = error; break; } throw error; }
        current = this.database.getRemoteNode(current.pid);
      }
      for (const part of chain) nameIssues.set(part.nid, issue ?? null);
      return issue;
    };
    let total = 0;
    let matched = 0;
    for await (const batch of this.database.remoteNodeBatches(this.settings().remoteRoot)) {
      for (const node of batch) {
        total++;
        await this.work.step();
        if (node.path.toLowerCase().startsWith(this.settings().remoteRoot.toLowerCase())) matched++;
        if (this.diagnostic) { this.diagnostic.remoteNodes = total; this.diagnostic.matchedNodes = matched; }
        this.progress("remote-map", `正在检查需要同步的文件…（已检查 ${total.toLocaleString("en-US")} 项）`);
        let path: string | undefined;
        try {
          const root = this.settings().remoteRoot.toLowerCase();
          if (node.path.toLowerCase().startsWith(root)) {
            const issue = nameIssue(node);
            if (issue) throw issue;
          }
          path = remoteToVaultPath(this.settings().remoteRoot, node.path);
        } catch (error) {
          if (error instanceof Error && error.message === "Remote path is outside the bound root") continue;
          if (error instanceof WindowsPathError) {
            this.recordFileFailure(node.path, error, "远端路径不支持同步", node.nid);
            continue;
          }
          throw error;
        }
        if (!path) continue;
        if (shouldIgnorePath(path, this.pathFilter())) {
          this.protectedPaths.add(path, explainIgnoredPath(path, this.pathFilter()) ?? "路径过滤规则", "remote"); this.protectedNids.add(node.nid); continue;
        }
        if (!node.isDir && this.excludeSize(path, node.size, "remote")) { this.protectedNids.add(node.nid); continue; }
        const key = pathKey(path);
        if (result.has(key)) throw new Error(`Bound remote directory contains a case-insensitive path collision: ${path}`);
        result.set(key, { path, snapshot: remoteSnapshot(node) });
      }
    }
    if (this.diagnostic) this.diagnostic.matchedNodes = matched;
    return result;
  }

  private async ensureRemoteRoot(force = false): Promise<number> {
    const cursor = this.database.getCursor(this.accountKey);
    if (!force && cursor?.bgsp === directorySnapshotScope(this.settings().remoteRoot) && cursor.gsp?.startsWith("exists:")) return 0;
    const segments = this.settings().remoteRoot.split("/").filter(Boolean);
    let current = "";
    let created = 0;
    for (const segment of segments) {
      this.throwIfCancelled();
      current += `/${segment}`;
      if (!force && this.database.hasRemoteDirectory(current)) continue;
      try {
        await this.api.call("File.mkdir", { fname: `${current}/` });
        this.throwIfCancelled();
        created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isAlreadyExistingRemoteNodeError(error)) throw error;
      }
    }
    return created;
  }

  private async planTasks(): Promise<void> {
    this.planTaskIndex = new Map(this.database.listPendingTasks().map(task => [`${task.kind}:${pathKey(task.path)}`, task]));
    const remote = await this.remoteMap();
    const base = new Map<string, PathSnapshot>();
    for await (const batch of this.database.baseBatches()) {
      for (const [path, snapshot] of batch) {
        await this.work.step();
        if (base.has(pathKey(path))) throw new Error(`Sync baseline contains a case-insensitive path collision: ${path}`);
        base.set(pathKey(path), { path, snapshot });
        if (shouldIgnorePath(path, this.pathFilter())) {
          this.protectedPaths.add(path, explainIgnoredPath(path, this.pathFilter()) ?? "路径过滤规则", snapshot.nid ? "remote" : "local");
        } else if (snapshot.nid && this.protectedNids.has(snapshot.nid)) {
          const failure = this.fileFailures.find(item => item.nid === snapshot.nid);
          this.protectedPaths.add(path, failure?.error.message ?? "云端文件名不合法，已保留原文件", "remote");
        } else if (snapshot.kind === "file") this.excludeSize(path, snapshot.size, snapshot.nid ? "remote" : "local");
      }
    }
    const local = await this.scanLocal();
    // Protect both identities when an excluded file was renamed remotely.
    const protectedBaseNids = new Set([...base.values()].filter(entry => this.protectedPaths.has(entry.path))
      .map(entry => entry.snapshot.nid).filter(Boolean));
    for (const entry of remote.values()) {
      await this.work.step();
      if (entry.snapshot.nid && protectedBaseNids.has(entry.snapshot.nid)) {
        this.protectedPaths.add(entry.path, "对应文件不参与同步", "both");
      }
    }
    for (const task of this.database.listPendingTasks()) {
      await this.work.step();
      const node = task.nid ? this.database.getRemoteNode(task.nid) : undefined;
      let invalid = false;
      try {
        validateTaskPath(task.path);
        const payload = task.payload as { destination?: string; sourcePath?: string };
        if (payload.destination) validateTaskPath(payload.destination);
        if (payload.sourcePath) normalizeVaultPath(payload.sourcePath);
      } catch { invalid = true; }
      const staleRemote = node && ["download", "recycle"].includes(task.kind) &&
        node.path.replace(/\/+$/, "") !== `${this.settings().remoteRoot}${task.path}`.replace(/\/+$/, "");
      if (!node && task.nid && ["download", "recycle"].includes(task.kind)) {
        this.protectedPaths.add(task.path, "旧任务对应的云端文件已不存在，已保留原文件", "both");
      }
      if (invalid || staleRemote || this.taskProtected(task)) {
        this.discardAfterPreflight.add(task.id);
        if (invalid && !node) this.protectedPaths.add(task.path, "旧文件名任务已失效，请重新检测", "both");
      }
    }
    await this.reconcileLocalRenames();
    for (const task of this.pendingPlanTasks()) {
      if (this.taskProtected(task)) this.discardAfterPreflight.add(task.id);
    }
    // Excluded subtrees and their ancestors cannot be rewritten as a side effect.
    for (const map of [local, remote, base]) {
      for (const [key, entry] of map) {
        await this.work.step();
        if (this.protectedPaths.has(entry.path, true)) map.delete(key);
      }
    }
    this.conflictPaths = new Set(this.pendingPlanTasks().flatMap(task => {
      const path = (task.payload as LocalRenamePayload).conflictPath;
      return path ? [pathKey(path)] : [];
    }));
    this.database.requeueStaleCompletedRecycleTasks(
      new Map([...remote].map(([key, entry]) => [key, entry.snapshot.nid ?? ""])),
      new Set(local.keys()),
    );
    for (const task of this.pendingPlanTasks()) {
      if (task.kind === "recycle" && !remote.has(pathKey(task.path))) this.discardAfterPreflight.add(task.id);
    }
    const deferredBaseKeys = await this.projectStructuralTasks(local, remote, base);
    for (const key of await this.planRemoteRenames(local, remote, base)) deferredBaseKeys.add(key);
    for (const task of this.pendingPlanTasks()) {
      if ((task.kind === "upload" || task.kind === "mkdir") && !local.has(pathKey(task.path)) &&
        !(task.payload as { derivedFrom?: string }).derivedFrom) this.discardAfterPreflight.add(task.id);
    }
    const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
    const ordered = await cooperativeSort([...paths], (left, right) => {
      const directoryDifference = Number(local.get(right)?.snapshot.kind === "directory") - Number(local.get(left)?.snapshot.kind === "directory");
      return directoryDifference || left.split("/").length - right.split("/").length || left.localeCompare(right);
    }, this.work);
    const recycledDirectories: string[] = [];
    const protectedDirectories: string[] = [];
    const conflictUploads: Array<{ task: SyncTask; destination: string }> = [];
    let offset = 0;
    while (offset < ordered.length) {
      const started = performance.now();
      this.database.taskBatch(() => {
        let processed = 0;
        while (offset < ordered.length && processed++ < 100 && (processed === 1 || performance.now() - started < 8)) {
          const key = ordered[offset++]!;
          if (protectedDirectories.some(prefix => key.startsWith(prefix))) continue;
          const localEntry = local.get(key);
          const remoteEntry = remote.get(key);
          const baseEntry = base.get(key);
          const path = localEntry?.path ?? remoteEntry?.path ?? baseEntry!.path;
          if (recycledDirectories.some((prefix) => key.startsWith(prefix))) {
            if (baseEntry) this.database.deleteBase(baseEntry.path);
            continue;
          }
          if (baseEntry && baseEntry.path !== path) {
            this.database.deleteBase(baseEntry.path);
            this.database.putBase(path, baseEntry.snapshot);
            baseEntry.path = path;
          }
          const decision = planThreeWay(baseEntry?.snapshot, localEntry?.snapshot, remoteEntry?.snapshot);
          const nextKind = decision.action === "upload" ? localEntry?.snapshot.kind === "directory" ? "mkdir" : "upload"
            : decision.action === "delete-remote" ? "recycle"
            : ["download", "delete-local", "conflict"].includes(decision.action) ? "download" : undefined;
          for (const kind of ["upload", "download", "mkdir", "recycle"] as const) {
            const pending = this.planTaskIndex.get(`${kind}:${key}`);
            if (pending && kind !== nextKind) this.discardAfterPreflight.add(pending.id);
          }
          const id = crypto.randomUUID();
          const payload = { local: localEntry?.snapshot, sourcePath: localEntry?.sourcePath,
            derivedFrom: localEntry?.derivedFrom,
            remote: remoteEntry?.snapshot, base: baseEntry?.snapshot,
            conflict: decision.action === "conflict", remoteDeleted: decision.action === "conflict" && !remoteEntry };
          if (decision.action === "upload") this.enqueuePlan({ id, kind: localEntry?.snapshot.kind === "directory" ? "mkdir" : "upload", path, payload });
          else if (decision.action === "download") this.enqueuePlan({ id, kind: "download", path, nid: remoteEntry?.snapshot.nid, payload });
          else if (decision.action === "delete-remote") {
            this.database.enqueue({ id, kind: "recycle", path, nid: remoteEntry?.snapshot.nid, payload });
            if (remoteEntry?.snapshot.kind === "directory") recycledDirectories.push(`${key}/`);
          }
          else if (decision.action === "delete-local") this.enqueuePlan({ id, kind: "download", path, payload: { ...payload, remoteDeleted: true } });
          else if (decision.action === "conflict") {
            const task = this.enqueuePlan({ id, kind: "download", path, nid: remoteEntry?.snapshot.nid, payload });
            if (localEntry) {
              const conflictPath = this.allocateConflictPath(task, local, remote);
              conflictUploads.push({ task, destination: conflictPath });
              if (localEntry.snapshot.kind === "directory") {
                protectedDirectories.push(`${key}/`);
                for (const pending of this.pendingPlanTasks()) {
                  if (pathKey(pending.path).startsWith(`${key}/`)) this.discardAfterPreflight.add(pending.id);
                }
              }
            }
          }
          else if (decision.action === "drop-base") this.database.deleteBase(path);
          else if (decision.action === "none" && remoteEntry && !deferredBaseKeys.has(key)) {
            this.database.putBase(path, remoteEntry.snapshot);
          }
        }
      });
      this.progress("plan", "正在准备同步…");
      await this.work.step(true);
    }
    for (const { task, destination } of conflictUploads) await this.planConflictUploads(task, local, destination);
  }

  /** Refresh snapshots without resetting a pending task's retry state. */
  private enqueuePlan(task: Parameters<SyncDatabase["enqueue"]>[0]): SyncTask {
    const key = `${task.kind}:${pathKey(task.path)}`;
    const existing = this.planTaskIndex.get(key);
    this.discardAfterPreflight.delete(existing?.id ?? "");
    if (existing) {
      const previous = existing.payload as { conflictPath?: string };
      const payload = { ...task.payload as object, ...(previous.conflictPath ? { conflictPath: previous.conflictPath } : {}) };
      this.database.updateTaskPlan(existing.id, task.nid, payload);
      const refreshed = { ...existing, nid: task.nid, payload };
      this.planTaskIndex.set(key, refreshed);
      return refreshed;
    }
    this.database.enqueue(task);
    const queued: SyncTask = { ...task, state: "queued", attempt: 0, nextRunAt: task.nextRunAt ?? Date.now() };
    this.planTaskIndex.set(key, queued);
    return queued;
  }

  private allocateConflictPath(task: SyncTask, local: Map<string, PathSnapshot>, remote: Map<string, PathSnapshot>): string {
    const payload = task.payload as LocalRenamePayload;
    if (payload.conflictPath) return payload.conflictPath;
    for (let sequence = 0; sequence < 10_000; sequence++) {
      const path = buildConflictPath(task.path, this.settings().deviceName, new Date(), sequence);
      if (local.has(pathKey(path)) || remote.has(pathKey(path)) || this.conflictPaths.has(pathKey(path))) continue;
      this.conflictPaths.add(pathKey(path));
      payload.conflictPath = path;
      this.database.updateTaskPayload(task.id, payload);
      return path;
    }
    throw new Error(`Unable to allocate conflict path for ${task.path}`);
  }

  private async planConflictUploads(task: SyncTask, local: Map<string, PathSnapshot>, destination: string): Promise<void> {
    const sourceKey = pathKey(task.path);
    const file = local.get(sourceKey);
    const entries = file?.snapshot.kind === "file" ? [[sourceKey, file] as const] : local;
    for (const [key, entry] of entries) {
      await this.work.step();
      if (key !== sourceKey && !key.startsWith(`${sourceKey}/`)) continue;
      this.enqueuePlan({ id: crypto.randomUUID(), kind: entry.snapshot.kind === "directory" ? "mkdir" : "upload",
        path: `${destination}${entry.path.slice(task.path.length)}`,
        payload: { local: { ...entry.snapshot, nid: undefined }, sourcePath: entry.sourcePath ?? entry.path,
          derivedFrom: task.id } });
    }
    this.database.updateTaskPayload(task.id, { ...task.payload as object, conflictPlanned: true });
  }

  /** Project structural intents onto snapshots; no local or cloud files change here. */
  private async projectStructuralTasks(local: Map<string, PathSnapshot>, remote: Map<string, PathSnapshot>, base: Map<string, PathSnapshot>): Promise<Set<string>> {
    const deferred = new Set<string>();
    for (const task of this.pendingPlanTasks()) {
      await this.work.step();
      if (task.kind === "rename" || task.kind === "move") {
        const payload = task.payload as RemoteRenamePayload;
        await this.relocateSnapshotTree(remote, payload.intermediatePath ?? task.path, payload.destination);
        for (const key of await this.relocateSnapshotTree(base, task.path, payload.destination)) deferred.add(key);
      } else if (task.kind === "local-rename") {
        const payload = task.payload as LocalRenamePayload;
        if (payload.conflict) {
          const destination = this.allocateConflictPath(task, local, remote);
          await this.relocateSnapshotTree(local, task.path, destination, true, task.id);
          await this.removeSnapshotTree(base, pathKey(payload.basePath ?? task.path));
          await this.removeSnapshotTree(base, pathKey(task.path));
          this.database.updateTaskPayload(task.id, { ...payload, conflictPlanned: true });
        } else {
          await this.relocateSnapshotTree(local, task.path, payload.destination, true, task.id);
          for (const key of await this.relocateSnapshotTree(base, task.path, payload.destination)) deferred.add(key);
        }
      }
    }
    return deferred;
  }

  private excludeSize(path: string, size: number | undefined, source: SkippedFileSource = "both"): boolean {
    const reason = fileSizeExclusion(size, this.runSettings ?? this.settings());
    if (!reason) return false;
    this.protectedPaths.add(path, reason, source, size);
    return true;
  }

  private taskProtected(task: SyncTask): boolean {
    const payload = task.payload as LocalRenamePayload & { sourcePath?: string };
    const paths = [task.path, payload.destination, payload.sourcePath].filter((path): path is string => Boolean(path));
    return paths.some(path => this.protectedPaths.has(path, true) || shouldIgnorePath(path, this.pathFilter())) ||
      [payload.local, payload.remote, payload.base].some(snapshot => snapshot?.kind === "file" &&
        this.excludeSize(task.path, snapshot.size, snapshot.nid ? "remote" : "local"));
  }

  private summarizeTaskFile(task: SyncTask): SyncRunSummary["files"][number] {
    const payload = task.payload as LocalRenamePayload & { remoteDeleted?: boolean };
    const snapshots = task.kind === "download" && !payload.remoteDeleted
      ? [payload.remote, payload.local, payload.base] : [payload.local, payload.remote, payload.base];
    const snapshot = snapshots.find(value => value !== undefined);
    const size = Number(snapshot?.size ?? 0);
    const destination = ["rename", "move", "local-rename"].includes(task.kind)
      ? payload.conflictPath ?? payload.destination : undefined;
    return { path: task.path, size: Number.isFinite(size) ? Math.max(0, size) : 0,
      ...(destination ? { destination } : {}) };
  }

  private async executeChecked(task: SyncTask, execute: () => Promise<void>): Promise<void> {
    this.throwIfCancelled();
    // Conflict recovery can enqueue derived work after task selection. Include
    // it once, even if the executor is retried in this run.
    if (!this.runTaskIds.has(task.id)) {
      this.runTaskIds.add(task.id);
      this.runFiles.push(this.summarizeTaskFile(task));
    }
    validateTaskPath(task.path);
    const payload = task.payload as LocalRenamePayload & { sourcePath?: string };
    if (payload.destination) validateTaskPath(payload.destination);
    if (payload.sourcePath) normalizeVaultPath(payload.sourcePath);
    const checkLocal = async (path: string, recursive: boolean): Promise<void> => {
      const stat = await this.vault.adapter.stat(path);
      if (stat?.type === "file") this.excludeSize(path, stat.size, "local");
      else if (stat?.type === "folder" && recursive) {
        const listed = await this.vault.adapter.list(path);
        for (const child of [...listed.files, ...listed.folders]) {
          await this.work.step();
          if (shouldIgnorePath(child, this.pathFilter())) this.protectedPaths.add(child, explainIgnoredPath(child, this.pathFilter()) ?? "路径过滤规则", "local");
          else await checkLocal(child, true);
        }
      }
    };
    const recursive = task.kind === "recycle" || task.kind === "local-rename" || task.kind === "rename" || task.kind === "move" ||
      (task.kind === "download" && Boolean((task.payload as { remoteDeleted?: boolean }).remoteDeleted || payload.conflict));
    await checkLocal(payload.sourcePath ?? task.path, recursive);
    if (payload.destination) await checkLocal(payload.destination, recursive);
    const current = task.nid ? this.database.getRemoteNode(task.nid) : undefined;
    if (current && !current.isDir) this.excludeSize(task.path, current.size, "remote");
    if (this.taskProtected(task)) {
      this.transfers.remove(task.id);
      this.publishTransfers(true);
      throw new TaskSkippedError("文件或目录包含不参与同步的内容，已保留两端文件");
    }
    this.throwIfCancelled();
    await execute();
  }

  private async planRemoteRenames(
    local: Map<string, PathSnapshot>,
    remote: Map<string, PathSnapshot>,
    base: Map<string, PathSnapshot>,
  ): Promise<Set<string>> {
    const remoteByNid = new Map<string, PathSnapshot>();
    for (const entry of remote.values()) {
      await this.work.step();
      if (entry.snapshot.nid) remoteByNid.set(entry.snapshot.nid, entry);
    }
    const candidates: Array<{ baseEntry: PathSnapshot; remoteEntry: PathSnapshot }> = [];
    for (const baseEntry of base.values()) {
      await this.work.step();
      const remoteEntry = baseEntry.snapshot.nid ? remoteByNid.get(baseEntry.snapshot.nid) : undefined;
      if (remoteEntry && baseEntry.path !== remoteEntry.path && baseEntry.snapshot.kind === remoteEntry.snapshot.kind) {
        candidates.push({ baseEntry, remoteEntry });
      }
    }
    const orderedCandidates = await cooperativeSort(candidates,
      (left, right) => left.baseEntry.path.split("/").length - right.baseEntry.path.split("/").length, this.work);
    const claimedSources: string[] = [];
    const deferredBaseKeys = new Set<string>();
    for (const { baseEntry, remoteEntry: matchedRemote } of orderedCandidates) {
      await this.work.step();
      const remoteEntry = matchedRemote!;
      const nid = baseEntry.snapshot.nid;
      const sourceKey = pathKey(baseEntry.path);
      const destinationKey = pathKey(remoteEntry.path);
      if (!nid || claimedSources.some((prefix) => sourceKey.startsWith(prefix))) continue;
      const localEntry = local.get(sourceKey);
      if (!localEntry || await this.destinationOccupied(local, sourceKey, destinationKey)) continue;
      const localChanged = !await this.localTreeMatchesBase(baseEntry.path, local, base);

      const task = this.enqueuePlan({
        id: crypto.randomUUID(), kind: "local-rename", path: baseEntry.path, nid,
        payload: { destination: remoteEntry.path, local: localEntry.snapshot, base: baseEntry.snapshot,
          remote: remoteEntry.snapshot, conflict: localChanged },
      });
      if (localChanged) {
        const destination = this.allocateConflictPath(task, local, remote);
        await this.relocateSnapshotTree(local, baseEntry.path, destination, true, task.id);
        await this.removeSnapshotTree(base, sourceKey);
        this.database.updateTaskPayload(task.id, { ...task.payload as object, conflictPlanned: true });
      } else {
        await this.relocateSnapshotTree(local, baseEntry.path, remoteEntry.path, true, task.id);
        for (const key of await this.relocateSnapshotTree(base, baseEntry.path, remoteEntry.path)) deferredBaseKeys.add(key);
      }
      claimedSources.push(`${sourceKey}/`);
    }
    return deferredBaseKeys;
  }

  private async localTreeMatchesBase(
    source: string,
    local: Map<string, PathSnapshot>,
    base: Map<string, PathSnapshot>,
  ): Promise<boolean> {
    const sourceKey = pathKey(source);
    const sourcePrefix = `${sourceKey}/`;
    for (const [key, candidate] of base) {
      await this.work.step();
      if (key !== sourceKey && !key.startsWith(sourcePrefix)) continue;
      const localEntry = local.get(key);
      if (!localEntry || !snapshotsEqual(candidate.snapshot, localEntry.snapshot)) return false;
    }
    for (const key of local.keys()) {
      await this.work.step();
      if ((key === sourceKey || key.startsWith(sourcePrefix)) && !base.has(key)) return false;
    }
    return true;
  }

  private async destinationOccupied(local: Map<string, PathSnapshot>, sourceKey: string, destinationKey: string): Promise<boolean> {
    if (sourceKey === destinationKey) return false;
    const sourcePrefix = `${sourceKey}/`;
    const destinationPrefix = `${destinationKey}/`;
    for (const key of local.keys()) {
      await this.work.step();
      if ((key === destinationKey || key.startsWith(destinationPrefix)) &&
          key !== sourceKey && !key.startsWith(sourcePrefix)) return true;
    }
    return false;
  }

  private async removeSnapshotTree(map: Map<string, PathSnapshot>, sourceKey: string): Promise<void> {
    const prefix = `${sourceKey}/`;
    for (const key of [...map.keys()]) {
      await this.work.step();
      if (key === sourceKey || key.startsWith(prefix)) map.delete(key);
    }
  }

  private async relocateSnapshotTree(map: Map<string, PathSnapshot>, source: string, destination: string, trackSource = false, derivedFrom?: string): Promise<string[]> {
    const sourceKey = pathKey(source);
    const prefix = `${sourceKey}/`;
    const entries: Array<[string, PathSnapshot]> = [];
    for (const entry of map) {
      await this.work.step();
      if (entry[0] === sourceKey || entry[0].startsWith(prefix)) entries.push(entry);
    }
    for (const [key] of entries) map.delete(key);
    const relocated: string[] = [];
    for (const [, entry] of entries) {
      await this.work.step();
      const suffix = entry.path.length === source.length ? "" : entry.path.slice(source.length);
      const path = `${destination}${suffix}`;
      const key = pathKey(path);
      map.set(key, { path, snapshot: entry.snapshot, sourcePath: entry.sourcePath ?? (trackSource ? entry.path : undefined), derivedFrom: derivedFrom ?? entry.derivedFrom });
      relocated.push(key);
    }
    return relocated;
  }

  private payload(task: SyncTask): { local?: SyncSnapshot; remote?: SyncSnapshot; base?: SyncSnapshot;
    conflict?: boolean; remoteDeleted?: boolean } {
    return task.payload as { local?: SyncSnapshot; remote?: SyncSnapshot; base?: SyncSnapshot;
      conflict?: boolean; remoteDeleted?: boolean };
  }

  private async renameLocal(task: SyncTask): Promise<void> {
    const payload = task.payload as LocalRenamePayload;
    const source = normalizeVaultPath(task.path);
    const destination = normalizeVaultPath(payload.destination);
    const sourceFile = this.vault.getAbstractFileByPath(source);
    const destinationFile = this.vault.getAbstractFileByPath(destination);
    const sourceExists = Boolean(sourceFile) || await this.vault.adapter.exists(source, false);
    const destinationExists = Boolean(destinationFile) || await this.vault.adapter.exists(destination, false);
    if (payload.conflict && payload.basePath) {
      if (destinationExists) throw new Error(`Local rename destination already exists: ${destination}`);
      await this.preserveConflict(source, payload.local, task, destination);
      this.database.deleteBaseTree(payload.basePath);
      this.database.deleteBaseTree(source);
      return;
    }
    if (!sourceExists) {
      if (destinationExists && !payload.conflict) {
        this.database.moveBase(source, destination);
        if (payload.remote) this.database.putBase(destination, payload.remote);
        return;
      }
      throw new Error(`本地重命名源文件不存在: ${source}`);
    }
    const caseOnlyRename = source !== destination && pathKey(source) === pathKey(destination);
    if (destinationExists && !caseOnlyRename) throw new Error(`Local rename destination already exists: ${destination}`);
    this.database.suppress(source, "rename", undefined, Date.now() + 30_000);
    this.database.suppress(destination, "rename", undefined, Date.now() + 30_000);
    if (payload.conflict) {
      await this.preserveConflict(source, payload.local, task);
      this.database.deleteBaseTree(source);
      
      return;
    }
    if (caseOnlyRename) await this.renameLocalCaseOnly(source, destination, sourceFile);
    else if (sourceFile) await this.vault.rename(sourceFile, destination);
    else await this.vault.adapter.rename(source, destination);
    this.database.moveBase(source, destination);
    if (payload.remote) this.database.putBase(destination, payload.remote);
    
  }

  private async renameLocalCaseOnly(source: string, destination: string, sourceFile: TAbstractFile | null): Promise<void> {
    const slash = source.lastIndexOf("/");
    const parent = slash < 0 ? "" : source.slice(0, slash + 1);
    const temporary = `${parent}.yunpan-sync-${crypto.randomUUID()}.rename`;
    this.database.suppress(temporary, "rename", undefined, Date.now() + 30_000);
    if (sourceFile) {
      await this.vault.rename(sourceFile, temporary);
      try { await this.vault.rename(sourceFile, destination); }
      catch (error) {
        await this.vault.rename(sourceFile, source).catch(() => undefined);
        throw error;
      }
      return;
    }
    await this.vault.adapter.rename(source, temporary);
    try { await this.vault.adapter.rename(temporary, destination); }
    catch (error) {
      await this.vault.adapter.rename(temporary, source).catch(() => undefined);
      throw error;
    }
  }

  private async createRemoteDirectory(task: SyncTask): Promise<void> {
    const path = `${joinRemotePath(this.settings().remoteRoot, task.path).replace(/\/+$/, "")}/`;
    let response: Record<string, unknown> | undefined;
    try {
      response = await this.api.call("File.mkdir", { fname: path });
    } catch (error) {
      if (!isAlreadyExistingRemoteNodeError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        if (/父节点不存在|parent.*(?:not exist|not found)/i.test(message)) {
          // Repair only children of an existing binding, never recreate a deleted root.
          await this.api.call("File.getList", { path: this.settings().remoteRoot, page: 1, page_size: 1 });
          await this.ensureRemoteMoveDestination(task.path, true);
          response = await this.api.call("File.mkdir", { fname: path });
        } else throw error;
      }
    }
    const nid = String(response?.nid ?? response?.id ?? "") || this.database.getBase(task.path)?.nid;
    this.database.putBase(task.path, { ...this.payload(task).local!, ...(nid ? { nid } : {}) });
  }

  private async recycleRemote(task: SyncTask): Promise<void> {
    const payload = this.payload(task);
    const indexedNode = task.nid ? this.database.getRemoteNode(task.nid) : undefined;
    const kind = payload.remote?.kind ?? (indexedNode ? indexedNode.isDir ? "directory" : "file" : undefined)
      ?? payload.base?.kind;
    const joinedPath = joinRemotePath(this.settings().remoteRoot, task.path).replace(/\/+$/, "");
    const remotePath = kind === "directory" ? `${joinedPath}/` : joinedPath;
    
    try {
      await this.api.call("File.syncRecycle", { fname: remotePath, owner_qid: this.settings().ownerQid });
    } catch (error) {
      if (!isAlreadyDeletedRemoteError(error)) throw error;
      if (task.nid && this.database.getRemoteNode(task.nid)) throw error;
      
    }
    if (kind === "directory") this.database.deleteBaseTree(task.path);
    else this.database.deleteBase(task.path);
  }

  private async renameRemote(task: SyncTask): Promise<void> {
    const payload = task.payload as { destination: string };
    const source = joinRemotePath(this.settings().remoteRoot, task.path);
    const destination = joinRemotePath(this.settings().remoteRoot, payload.destination);
    if (await this.recoverRenameRace(task, () => this.api.call("File.rename", {
      src_name: source, new_name: payload.destination.split("/").at(-1) }))) return;
    this.database.moveRemoteNodes(source, destination);
    this.database.moveBase(task.path, payload.destination);
  }

  private async moveRemote(task: SyncTask): Promise<void> {
    const payload = task.payload as RemoteRenamePayload;
    const source = joinRemotePath(this.settings().remoteRoot, task.path);
    const destination = joinRemotePath(this.settings().remoteRoot, payload.destination);
    const destinationDirectory = await this.ensureRemoteMoveDestination(payload.destination);
    const parent = parentVaultPath(payload.destination);
    const intermediate = normalizeVaultPath(`${parent ? `${parent}/` : ""}${task.path.split("/").at(-1)}`);
    const intermediateRemote = joinRemotePath(this.settings().remoteRoot, intermediate);
    // Persist the intermediate endpoint before sending either request so a retry
    // can distinguish a partially completed move from an independent remote rename.
    payload.intermediatePath = intermediate;
    this.database.updateTaskPayload(task.id, payload);
    await this.checkpoint();
    const indexed = task.nid ? this.database.getRemoteNode(task.nid) : undefined;
    if (indexed?.path !== intermediateRemote) {
      if (await this.recoverRenameRace(task, () => this.api.call("File.move", { src_name: source, new_name: destinationDirectory }))) return;
      this.database.moveRemoteNodes(source, intermediateRemote);
      await this.checkpoint();
    }
    if (intermediate !== payload.destination) {
      if (await this.recoverRenameRace(task, () => this.api.call("File.rename", {
        src_name: intermediateRemote, new_name: payload.destination.split("/").at(-1) }))) return;
      this.database.moveRemoteNodes(intermediateRemote, destination);
    }
    this.database.moveBase(task.path, payload.destination);
  }

  private async recoverRenameRace(task: SyncTask, execute: () => Promise<unknown>): Promise<boolean> {
    try { await execute(); return false; }
    catch (error) {
      if (!isAlreadyDeletedRemoteError(error) || this.renameRefreshUsed) throw error;
      this.renameRefreshUsed = true;
      await new RemoteIndexer(this.api, this.database, this.accountKey, 200, {
        remoteRoot: this.settings().remoteRoot, check: () => this.throwIfCancelled(), work: this.work,
      }).rebuild();
      const resolution = await this.renameResolution(task);
      if (resolution === "execute") throw error;
      if (resolution) {
        // Persist the recovery intent before changing the local filesystem. A shutdown
        // recovers this running task with its new local-rename executor.
        this.database.retargetRunningRename(task.id, resolution);
        await this.planTasks();
        await this.checkQuota(await this.currentQuota(), this.pendingPlanTasks());
        this.database.removeTasks([...this.discardAfterPreflight]);
        this.discardAfterPreflight.clear();
        await this.checkpoint();
        await this.renameLocal(resolution);
      }
      return true;
    }
  }

  private async ensureRemoteMoveDestination(destination: string, force = false): Promise<string> {
    const parent = parentVaultPath(destination);
    const root = this.settings().remoteRoot;
    if (!parent) return joinRemotePath(root, "");

    const segments = parent.split("/");
    let current = "";
    for (const segment of segments) {
      this.throwIfCancelled();
      current = current ? `${current}/${segment}` : segment;
      const remotePath = joinRemotePath(root, current).replace(/\/+$/, "");
      if (!force && this.database.hasRemoteDirectory(remotePath)) continue;
      try {
        await this.api.call("File.mkdir", { fname: `${remotePath}/` });
        this.throwIfCancelled();
      } catch (error) {
        if (!isAlreadyExistingRemoteNodeError(error)) throw error;
      }
    }
    return `${joinRemotePath(root, parent).replace(/\/+$/, "")}/`;
  }

  private async upload(task: SyncTask): Promise<void> {
    const file = this.vault.getFileByPath(task.path);
    const adapterStat = await this.vault.adapter.stat(task.path);
    const stat = adapterStat ?? file?.stat;
    if (!stat || (!file && adapterStat?.type !== "file")) throw new Error(`Local file disappeared: ${task.path}`);
    if (this.excludeSize(task.path, stat.size, "local")) throw new TaskSkippedError("上传文件大小不在同步范围内");
    const before = { size: stat.size, mtime: stat.mtime };
    this.transfers.queue(task.id, "upload", task.path, stat.size);
    this.transfers.start(task.id);
    this.publishTransfers();
    const source = await openDesktopSource(this.vault.adapter, task.path);
    if (source && this.excludeSize(task.path, source.size, "local")) {
      await source.close();
      this.transfers.remove(task.id);
      throw new TaskSkippedError("上传文件大小已变化，不在同步范围内");
    }
    const bytes = source ? undefined : new Uint8Array(file ? await this.vault.readBinary(file) : await this.vault.adapter.readBinary(task.path));
    if (source && source.size !== stat.size) this.transfers.updatePreparing(task.id, 0, source.size);
    try {
      const response = await this.uploader.upload({ path: joinRemotePath(this.settings().remoteRoot, task.path), data: bytes, source,
        ctime: stat.ctime, mtime: stat.mtime, transferId: task.id,
        expectedHash: this.payload(task).local?.hash,
        check: () => this.throwIfCancelled(),
        signal: this.cancellation?.signal,
        onHashProgress: completed => {
          this.transfers.updatePreparing(task.id, completed, source?.size ?? bytes!.byteLength);
          this.publishTransfers();
          this.progress("hash", `正在校验上传文件：${formatDisplayPath(task.path)}（${completed}/${stat.size} 字节）`);
        },
        onProgress: (completed, total) => this.updateTransfer(task.id, completed, total) });
      const currentFile = this.vault.getFileByPath(task.path);
      const currentAdapterStat = currentFile ? undefined : await this.vault.adapter.stat(task.path);
      const current = currentFile?.stat ?? currentAdapterStat;
      if (!current || (!currentFile && currentAdapterStat?.type !== "file") ||
        current.size !== before.size || current.mtime !== before.mtime) {
        throw new Error(`Local file changed during upload: ${task.path}`);
      }
      const snapshot = this.payload(task).local!;
      snapshot.nid = (String(response.nid ?? response.id ?? "") || snapshot.nid
        || this.payload(task).remote?.nid || this.payload(task).base?.nid || this.database.getBase(task.path)?.nid);
      this.database.putBase(task.path, snapshot);
      this.transfers.complete(task.id);
      this.publishTransfers();
    } catch (error) {
      this.failTransfer(task.id, error);
      throw error;
    } finally { await source?.close(); }
  }

  private async download(task: SyncTask): Promise<void> {
    const payload = this.payload(task);
    const existing = this.vault.getAbstractFileByPath(task.path);
    const existsInAdapter = existing ? true : await this.vault.adapter.exists(task.path, false);
    if (payload.remoteDeleted) {
      if (existsInAdapter && payload.conflict) await this.preserveConflict(task.path, payload.local, task);
      else if (existing) await this.vault.trash(existing, false);
      else if (existsInAdapter) await this.vault.adapter.trashLocal(task.path);
      this.database.deleteBase(task.path);
      return;
    }
    if (payload.remote?.kind === "directory") {
      if (existsInAdapter && payload.conflict) await this.preserveConflict(task.path, payload.local, task);
      if (!existsInAdapter || payload.conflict) await this.createLocalDirectory(task.path);
      this.database.putBase(task.path, payload.remote);
      return;
    }
    this.transfers.queue(task.id, "download", task.path, payload.remote?.size ?? 0);
    this.transfers.start(task.id);
    this.publishTransfers();
    const before = await this.vault.adapter.stat(task.path);
    if (!payload.conflict && payload.local && (!before || before.type !== "file" ||
      before.size !== payload.local.size || before.mtime !== payload.local.mtime)) {
      throw new Error(`Local file changed since sync planning: ${task.path}`);
    }
    if (!payload.local && !payload.conflict && before) {
      throw new Error(`Local file appeared since sync planning: ${task.path}`);
    }
    const checkTarget = async () => {
      this.throwIfCancelled();
      const after = await this.vault.adapter.stat(task.path);
      if (Boolean(before) !== Boolean(after) || (before && after &&
        (before.type !== after.type || before.size !== after.size || before.mtime !== after.mtime || before.ctime !== after.ctime))) {
        throw new Error(`Local file changed during download: ${task.path}`);
      }
    };
    const prepareTarget = async () => {
      await checkTarget();
      if (existsInAdapter && payload.conflict) await this.preserveConflict(task.path, payload.local, task);
    };
    const checkCommit = async () => {
      if (!payload.conflict) return checkTarget();
      this.throwIfCancelled();
      if (await this.vault.adapter.exists(task.path, false)) throw new Error(`Local file appeared during conflict download: ${task.path}`);
    };
    let temporary: string | undefined;
    let downloadedHash = payload.remote?.hash;
    const cache = new DownloadCache(this.vault.adapter, this.database, this.accountKey, task.id, this.checkpoint);
    let sink: Awaited<ReturnType<typeof openDesktopSink>>;
    try {
      await this.ensureFolder(task.path);
      temporary = `${task.path}.yunpan-sync-${crypto.randomUUID()}.part`;
      sink = await openDesktopSink(this.vault.adapter, temporary);
      const input = { path: joinRemotePath(this.settings().remoteRoot, task.path), nid: task.nid,
        resume: cache,
        onMetadata: (metadata: { hash: string; size: number }) => { downloadedHash = metadata.hash; },
        check: () => this.throwIfCancelled(),
        validateSize: (size: number) => {
          if (this.excludeSize(task.path, size, "remote")) throw new TaskSkippedError("云端文件大小不在同步范围内");
          if (payload.remote && size !== payload.remote.size) throw new Error("云端文件在检测后已变化，请重新检测");
        },
        onStage: (stage: "download" | "verify") => {
          this.transfers.stage(task.id, stage === "verify" ? "verifying" : "transferring");
          this.publishTransfers();
          this.progress(stage, `${stage === "verify" ? "正在校验下载文件" : "正在下载"}：${formatDisplayPath(task.path)}`);
        },
        onProgress: (completed: number, total: number) => this.updateTransfer(task.id, completed, total),
        signal: this.cancellation?.signal };
      if (sink) {
        await this.downloader.downloadTo(input, sink);
        const normalizedMtime = payload.remote?.mtime === undefined ? undefined : payload.remote.mtime < 1_000_000_000_000
          ? payload.remote.mtime * 1000 : payload.remote.mtime;
        await sink.close(normalizedMtime);
        await prepareTarget();
        this.progress("save", `正在保存文件：${formatDisplayPath(task.path)}`);
        await this.commitTemporary(task.path, temporary, checkCommit);
      } else {
        const bytes = await this.downloader.download(input);
        await prepareTarget();
        await this.atomicWrite(task.path, bytes, payload.remote?.mtime, checkCommit);
      }
      if (payload.remote) this.database.putBase(task.path, { ...payload.remote, hash: downloadedHash });
      await cache.clear();
      this.transfers.complete(task.id);
      this.publishTransfers();
    } catch (error) {
      if (error instanceof TaskSkippedError) { this.transfers.remove(task.id); this.publishTransfers(true); }
      else this.failTransfer(task.id, error);
      throw error;
    } finally {
      try { await sink?.close(); }
      finally {
        if (temporary && await this.vault.adapter.exists(temporary, false)) await this.vault.adapter.remove(temporary);
      }
    }
  }

  private async queueTransferProgress(): Promise<void> {
    for (const task of this.database.listTransferTasks()) {
      await this.work.step();
      const payload = this.payload(task);
      if (task.kind === "upload" && payload.local?.kind !== "directory") {
        this.transfers.queue(task.id, "upload", task.path, payload.local?.size ?? 0);
      } else if (task.kind === "download" && !payload.remoteDeleted && payload.remote?.kind !== "directory") {
        this.transfers.queue(task.id, "download", task.path, payload.remote?.size ?? 0);
      }
      if (task.state === "failed") this.transfers.fail(task.id, task.lastError ?? "传输失败");
    }
    this.publishTransfers();
  }

  private updateTransfer(id: string, completed: number, total: number): void {
    this.transfers.update(id, completed, total);
    this.publishTransfers();
  }

  private failTransfer(id: string, error: unknown): void {
    // The runner decides whether an error is terminal. Interruption/retry is waiting work.
    this.transfers.suspend(id);
    this.publishTransfers();
  }

  private publishTransfers(immediate = false): void {
    if (!immediate && Date.now() - this.lastTransferReport < 200) {
      this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined; this.publishTransfers(true); }, 200);
      return;
    }
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = undefined; }
    this.lastTransferReport = Date.now();
    this.reportTransfers(this.transfers.snapshot());
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new SyncCancelledError(this.stopReason);
  }

  private async ensureFolder(path: string): Promise<void> {
    const segments = path.split("/");
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!await this.vault.adapter.exists(current, false)) {
        if (current.startsWith(".obsidian")) await this.vault.adapter.mkdir(current);
        else await this.vault.createFolder(current);
      }
    }
  }

  private async createLocalDirectory(path: string): Promise<void> {
    await this.ensureFolder(`${path}/child`);
    if (await this.vault.adapter.exists(path, false)) return;
    if (path.startsWith(".obsidian")) await this.vault.adapter.mkdir(path);
    else await this.vault.createFolder(path);
  }

  private async preserveConflict(path: string, snapshot?: SyncSnapshot, renameTask?: SyncTask, originalPath = path): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    const exists = Boolean(file) || await this.vault.adapter.exists(path, false);
    const payload = renameTask?.payload as LocalRenamePayload | undefined;
    if (payload?.conflictPath) payload.conflictPath = normalizeVaultPath(payload.conflictPath);
    const finish = (destination: string) => {
      this.database.recordConflict(originalPath, destination);
      if (snapshot && !(renameTask?.payload as { conflictPlanned?: boolean } | undefined)?.conflictPlanned) this.database.enqueue({ id: crypto.randomUUID(),
        kind: snapshot.kind === "directory" ? "mkdir" : "upload", path: destination,
        payload: { local: { ...snapshot, nid: undefined } } });
    };
    if (!exists) {
      if (!payload?.conflictPath || !await this.vault.adapter.exists(payload.conflictPath, false)) {
        if (renameTask) throw new Error(`本地冲突源文件不存在: ${path}`);
        return;
      }
      finish(payload.conflictPath);
      return;
    }
    for (let sequence = 0; sequence < 10_000; sequence++) {
      const destination = payload?.conflictPath ?? buildConflictPath(path, this.settings().deviceName, new Date(), sequence);
      if (!await this.vault.adapter.exists(destination, false)) {
        if (renameTask && payload && !payload.conflictPath) {
          payload.conflictPath = destination;
          this.database.updateTaskPayload(renameTask.id, payload);
          await this.checkpoint();
        }
        this.database.suppress(path, "rename", undefined, Date.now() + 30_000);
        this.database.suppress(destination, "rename", undefined, Date.now() + 30_000);
        if (file) await this.vault.rename(file, destination);
        else await this.vault.adapter.rename(path, destination);
        finish(destination);
        return;
      }
      if (payload?.conflictPath) throw new Error(`Local conflict destination already exists: ${destination}`);
    }
    throw new Error(`Unable to allocate conflict path for ${path}`);
  }

  private async atomicWrite(path: string, bytes: Uint8Array, mtime?: number, check?: () => Promise<void>): Promise<void> {
    await this.ensureFolder(path);
    const temporary = `${path}.yunpan-sync-${crypto.randomUUID()}.part`;
    const normalizedMtime = mtime === undefined ? undefined : mtime < 1_000_000_000_000 ? mtime * 1000 : mtime;
    try {
      await this.vault.adapter.writeBinary(temporary, bytesBuffer(bytes), { mtime: normalizedMtime });
      await this.commitTemporary(path, temporary, check);
    } finally {
      if (await this.vault.adapter.exists(temporary, false)) await this.vault.adapter.remove(temporary);
    }
  }

  private async commitTemporary(path: string, temporary: string, check?: () => Promise<void>): Promise<void> {
    await check?.();
    this.database.suppress(path, "write", undefined, Date.now() + 30_000);
    const existing = await this.vault.adapter.exists(path, false);
    const backup = `${temporary}.backup`;
    try {
      if (existing) await this.vault.adapter.rename(path, backup);
      await this.vault.adapter.rename(temporary, path);
      if (existing && await this.vault.adapter.exists(backup, false)) await this.vault.adapter.remove(backup);
    } catch (error) {
      if (await this.vault.adapter.exists(temporary, false)) await this.vault.adapter.remove(temporary);
      if (await this.vault.adapter.exists(backup, false) && !await this.vault.adapter.exists(path, false)) await this.vault.adapter.rename(backup, path);
      throw error;
    }
  }
}
