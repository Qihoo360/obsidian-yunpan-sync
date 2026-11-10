import { TFile, TFolder, type TAbstractFile, type Vault } from "obsidian";
import { buildConflictPath, joinRemotePath, normalizeVaultPath, remoteToVaultPath, shouldIgnorePath, WindowsPathError,
  type PathFilterOptions } from "../domain/paths.js";
import { planThreeWay, snapshotsEqual, type SyncSnapshot } from "../domain/planner.js";
import { OpenApiError, type OpenApiMethod } from "../net/openapi-client.js";
import type { PluginSettings } from "../settings.js";
import { SyncDatabase, type RemoteNode, type SyncTask } from "../storage/database.js";
import type { UploadMachine } from "../transfer/upload.js";
import type { DownloadMachine } from "../transfer/download.js";
import { cloudFileHashes } from "../transfer/hashes.js";
import { TaskRunner } from "./task-runner.js";
import { RemoteIndexer } from "./remote-indexer.js";
import { TransferProgressTracker, type FileTransferProgress } from "./progress.js";
import { syncCompletionMessage } from "./outcome.js";
import { assertSyncQuota, syncRestrictionError, type SyncQuota, type SyncRestriction } from "./quota.js";
import { normalizeAccountProfile } from "../account/profile.js";

interface Api { call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> }
export interface EngineStatus { phase: string; message: string; queued: number; failed: number; completed?: number;
  conflicts?: number; lastSuccess?: number; lastError?: string; failedTasks?: SyncTask[]; fileFailures?: SyncFileFailure[];
  warnings?: string[]; restriction?: SyncRestriction }
export interface SyncFileFailure { path: string; error: WindowsPathError }
export type ConfirmSyncTasks = (tasks: readonly SyncTask[]) => Promise<ReadonlySet<string> | undefined>;

export class SyncCancelledError extends Error {
  constructor() {
    super("同步已停止");
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
  private cancelled = false;
  private idleWaiters: Array<() => void> = [];
  private completed = 0;
  private warnings: string[] = [];
  private renameRefreshUsed = false;
  private restriction?: SyncRestriction;
  private readonly discardAfterPreflight = new Set<string>();
  private planTaskIndex = new Map<string, SyncTask>();

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
  ) {
    this.lastSuccess = database.getLastSuccessfulSync();
  }

  isRunning(): boolean { return this.running; }
  cancel(): void { this.cancelled = true; }
  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
  needsInitialConfirmation(): boolean { return !this.database.isBindingConfirmed(this.accountKey); }

  async synchronize(rebuild = false, confirmTasks?: ConfirmSyncTasks): Promise<boolean> {
    if (this.running || this.settings().paused) return false;
    this.running = true;
    this.cancelled = false;
    this.lastError = undefined;
    this.fileFailures = [];
    this.warnings = [];
    this.restriction = undefined;
    this.discardAfterPreflight.clear();
    this.renameRefreshUsed = false;
    this.transfers.reset();
    this.publishTransfers();
    const runId = crypto.randomUUID();
    
    
    try {
      this.throwIfCancelled();
      if (!this.database.getCursor(this.accountKey) && this.database.getBases().size > 0) {
        this.database.resetSyncState();
      }
      this.emit("account", "正在检查会员状态与云盘容量");
      const quota = await this.currentQuota();
      assertSyncQuota(quota, []);
      this.throwIfCancelled();
      this.bindKnownRenameIdentities();
      this.emit("remote-index", rebuild ? "正在重新检查云端目录" : "正在检查远端变化");
      const indexer = new RemoteIndexer(this.api, this.database, this.accountKey);
      if (rebuild) {
        this.database.clearRemoteIndex(this.accountKey);
        await indexer.rebuild();
      } else await indexer.update();
      this.throwIfCancelled();
      await this.reconcileLocalRenames();
      const structural = new TaskRunner(this.database, {
        "local-rename": (task) => this.renameLocal(task),
        rename: (task) => this.renameRemote(task), move: (task) => this.moveRemote(task),
      }, { kinds: ["local-rename", "rename", "move"], propagateErrors: true, checkpoint: this.checkpoint });
      let appliedChanges = 0;
      this.emit("compare", "正在比较本地、远端和同步基线");
      await this.planTasks();
      const planned = this.pendingPlanTasks();
      const initialConfirmation = this.needsInitialConfirmation();
      let selectedTasks = planned;
      if (confirmTasks && (planned.length > 0 || initialConfirmation)) {
        const selected = await confirmTasks(planned);
        if (!selected || (planned.length > 0 && selected.size === 0)) throw new SyncCancelledError();
        selectedTasks = planned.filter((task) => selected.has(task.id));
        selectedTasks = selectedTasks.filter(task => {
          const parent = (task.payload as { derivedFrom?: string }).derivedFrom;
          return !parent || selected.has(parent);
        });
      }
      await this.checkQuota(quota, selectedTasks);
      this.database.removeTasks([...this.discardAfterPreflight,
        ...planned.filter(task => !selectedTasks.some(selected => selected.id === task.id)).map(task => task.id)]);
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
      if (blockedStructure.length) throw new Error(`${blockedStructure.length} sync tasks are still queued`);
      appliedChanges += await this.ensureRemoteRoot();
      this.queueTransferProgress();
      this.emit("transfer", "正在执行同步任务");
      const preparation = new TaskRunner(this.database, {
        mkdir: (task) => this.createRemoteDirectory(task),
        recycle: (task) => this.recycleRemote(task),
      }, { kinds: ["mkdir", "recycle"], checkpoint: this.checkpoint, shouldCancel: () => this.cancelled });
      appliedChanges += await preparation.drain();
      this.throwIfCancelled();
      appliedChanges += await new TaskRunner(this.database, {
        download: (task) => this.download(task),
      }, { kinds: ["download"], checkpoint: this.checkpoint, shouldCancel: () => this.cancelled }).drain();
      this.throwIfCancelled();
      const runner = new TaskRunner(this.database, {
        upload: (task) => this.upload(task),
      }, { kinds: ["upload"], concurrency: 5, checkpoint: this.checkpoint, shouldCancel: () => this.cancelled });
      appliedChanges += await runner.drain();
      this.throwIfCancelled();
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
      if (error instanceof SyncCancelledError) {
        this.emit("paused", "同步已停止");
        
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
      
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private async currentQuota(): Promise<SyncQuota> {
    if (this.loadQuota) return this.loadQuota();
    return normalizeAccountProfile(await this.api.call<Record<string, unknown>>("User.getUserDetail", {}), this.settings().ownerQid);
  }

  private pendingPlanTasks(): SyncTask[] {
    return this.database.listPendingTasks().filter(task => !this.discardAfterPreflight.has(task.id));
  }

  private async checkQuota(quota: SyncQuota, tasks: readonly SyncTask[]): Promise<void> {
    const current = await Promise.all(tasks.map(async task => {
      const payload = task.payload as { sourcePath?: string; local?: SyncSnapshot };
      if (task.kind !== "upload") return task;
      const stat = await this.vault.adapter.stat(payload.sourcePath ?? task.path);
      return { ...task, payload: { ...payload, local: stat?.type === "file"
        ? { ...payload.local, kind: "file", size: stat.size } : undefined } };
    }));
    assertSyncQuota(quota, current);
  }

  retryFailed(): number { return this.database.retryFailedTasks(); }
  retryTask(id: string): boolean { return this.database.retryTask(id); }
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

  private bindKnownRenameIdentities(): void {
    const remote = this.remoteMap();
    for (const task of this.database.listPendingTasks()) {
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
    this.bindKnownRenameIdentities();
    for (const task of this.database.listPendingTasks()) {
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
    const remote = this.remoteMap();
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
    if (this.destinationOccupied(local, pathKey(destination), pathKey(current.path))) {
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
    const counts = this.database.taskCounts();
    const failedTasks = this.database.listFailedTasks();
    const failureCount = this.failureCount(failedTasks);
    const displayMessage = phase === "error" && failureCount > 0 && !this.restriction ? "部分文件同步失败" : message;
    
    this.report({ phase, message: displayMessage, queued: counts.queued, failed: failureCount, completed: this.completed,
      conflicts: this.database.unresolvedConflictCount(), lastSuccess: this.lastSuccess, lastError: this.lastError,
      failedTasks, fileFailures: [...this.fileFailures], warnings: [...this.warnings], restriction: this.restriction });
  }

  private failureCount(failedTasks = this.database.listFailedTasks()): number {
    return new Set([...failedTasks.map((task) => pathKey(task.path)), ...this.fileFailures.map((failure) => pathKey(failure.path))]).size;
  }

  private fileFailureCount(): number { return this.failureCount([]); }

  private pathFilter(): PathFilterOptions {
    const settings = this.settings();
    return { syncObsidianConfig: settings.syncObsidianConfig,
      filterRules: settings.filterRules, pluginId: "yunpan-sync" };
  }

  private async scanLocal(): Promise<Map<string, PathSnapshot>> {
    const result = new Map<string, PathSnapshot>();
    const filter = this.pathFilter();
    const entries = this.vault.getAllLoadedFiles().filter((entry) => Boolean(entry.path));
    entries.sort((left, right) => left.path.localeCompare(right.path));
    for (const entry of entries) {
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
      if (shouldIgnorePath(entry.path, filter)) continue;
      if (entry instanceof TFolder) {
        if (result.has(pathKey(entry.path))) throw new Error(`Local vault contains a case-insensitive path collision: ${entry.path}`);
        result.set(pathKey(entry.path), { path: entry.path, snapshot: { size: 0, mtime: 0, kind: "directory" } });
      } else if (entry instanceof TFile) {
        if (result.has(pathKey(entry.path))) throw new Error(`Local vault contains a case-insensitive path collision: ${entry.path}`);
        const bytes = new Uint8Array(await this.vault.readBinary(entry));
        result.set(pathKey(entry.path), { path: entry.path, snapshot: { hash: (await cloudFileHashes(bytes)).fileHash,
          size: entry.stat.size, mtime: entry.stat.mtime, kind: "file" } });
      }
    }
    if (filter.syncObsidianConfig) await this.scanObsidianConfig(result, filter);
    return result;
  }

  private recordFileFailure(path: string, error: WindowsPathError, prefix?: string): void {
    const wrapped = new WindowsPathError(error.issue, error.segment,
      prefix ? `${prefix}：${path}。${error.message}` : error.message, error.characters);
    if (!this.fileFailures.some((failure) => pathKey(failure.path) === pathKey(path))) {
      this.fileFailures.push({ path, error: wrapped });
    }
  }

  private async scanObsidianConfig(result: Map<string, PathSnapshot>, filter: PathFilterOptions): Promise<void> {
    if (!await this.vault.adapter.exists(".obsidian", false)) return;
    result.set(pathKey(".obsidian"), { path: ".obsidian", snapshot: { size: 0, mtime: 0, kind: "directory" } });
    const walk = async (directory: string): Promise<void> => {
      const listed = await this.vault.adapter.list(directory);
      for (const rawPath of listed.folders) {
        const path = rawPath.replaceAll("\\", "/");
        try { normalizeVaultPath(path); }
        catch (error) {
          if (error instanceof WindowsPathError) { this.recordFileFailure(path, error, "本地路径不支持同步"); continue; }
          throw error;
        }
        if (shouldIgnorePath(path, filter)) continue;
        result.set(pathKey(path), { path, snapshot: { size: 0, mtime: 0, kind: "directory" } });
        await walk(path);
      }
      for (const rawPath of listed.files) {
        const path = rawPath.replaceAll("\\", "/");
        try { normalizeVaultPath(path); }
        catch (error) {
          if (error instanceof WindowsPathError) { this.recordFileFailure(path, error, "本地路径不支持同步"); continue; }
          throw error;
        }
        if (shouldIgnorePath(path, filter)) continue;
        const stat = await this.vault.adapter.stat(path);
        if (!stat || stat.type !== "file") continue;
        const bytes = new Uint8Array(await this.vault.adapter.readBinary(path));
        result.set(pathKey(path), { path, snapshot: { hash: (await cloudFileHashes(bytes)).fileHash,
          size: stat.size, mtime: stat.mtime, kind: "file" } });
      }
    };
    await walk(".obsidian");
  }

  private remoteMap(): Map<string, PathSnapshot> {
    const result = new Map<string, PathSnapshot>();
    for (const node of this.database.getRemoteNodes()) {
      let path: string | undefined;
      try {
        path = remoteToVaultPath(this.settings().remoteRoot, node.path);
      } catch (error) {
        if (error instanceof Error && error.message === "Remote path is outside the bound root") continue;
        if (error instanceof WindowsPathError) {
          this.recordFileFailure(node.path, error, "远端路径不兼容 Windows");
          continue;
        }
        throw error;
      }
      if (!path || shouldIgnorePath(path, this.pathFilter())) continue;
      const key = pathKey(path);
      if (result.has(key)) throw new Error(`Bound remote directory contains a case-insensitive path collision: ${path}`);
      result.set(key, { path, snapshot: remoteSnapshot(node) });
    }
    return result;
  }

  private async ensureRemoteRoot(): Promise<number> {
    const existing = new Set(this.database.getRemoteNodes().filter((node) => node.isDir).map((node) => node.path.replace(/\/$/, "")));
    const segments = this.settings().remoteRoot.split("/").filter(Boolean);
    let current = "";
    let created = 0;
    for (const segment of segments) {
      current += `/${segment}`;
      if (existing.has(current)) continue;
      try {
        await this.api.call("File.mkdir", { fname: `${current}/` });
        existing.add(current);
        created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/exist|already|已存在|重复|同名/i.test(message)) throw error;
      }
    }
    return created;
  }

  private async planTasks(): Promise<void> {
    this.planTaskIndex = new Map(this.database.listPendingTasks().map(task => [`${task.kind}:${pathKey(task.path)}`, task]));
    const local = await this.scanLocal();
    const remote = this.remoteMap();
    this.database.requeueStaleCompletedRecycleTasks(
      new Map([...remote].map(([key, entry]) => [key, entry.snapshot.nid ?? ""])),
      new Set(local.keys()),
    );
    for (const task of this.pendingPlanTasks()) {
      if (task.kind === "recycle" && !remote.has(pathKey(task.path))) this.discardAfterPreflight.add(task.id);
    }
    const base = new Map<string, PathSnapshot>();
    for (const [path, snapshot] of this.database.getBases()) {
      if (base.has(pathKey(path))) throw new Error(`Sync baseline contains a case-insensitive path collision: ${path}`);
      base.set(pathKey(path), { path, snapshot });
    }
    const deferredBaseKeys = this.projectStructuralTasks(local, remote, base);
    for (const key of this.planRemoteRenames(local, remote, base)) deferredBaseKeys.add(key);
    for (const task of this.pendingPlanTasks()) {
      if ((task.kind === "upload" || task.kind === "mkdir") && !local.has(pathKey(task.path)) &&
        !(task.payload as { derivedFrom?: string }).derivedFrom) this.discardAfterPreflight.add(task.id);
    }
    const paths = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
    const ordered = [...paths].sort((left, right) => {
      const directoryDifference = Number(local.get(right)?.snapshot.kind === "directory") - Number(local.get(left)?.snapshot.kind === "directory");
      return directoryDifference || left.split("/").length - right.split("/").length || left.localeCompare(right);
    });
    const recycledDirectories: string[] = [];
    const protectedDirectories: string[] = [];
    for (const key of ordered) {
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
          this.planConflictUploads(task, local, conflictPath);
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
      if (local.has(pathKey(path)) || remote.has(pathKey(path)) || this.database.listPendingTasks().some(t =>
        (t.payload as LocalRenamePayload).conflictPath === path)) continue;
      payload.conflictPath = path;
      this.database.updateTaskPayload(task.id, payload);
      return path;
    }
    throw new Error(`Unable to allocate conflict path for ${task.path}`);
  }

  private planConflictUploads(task: SyncTask, local: Map<string, PathSnapshot>, destination: string): void {
    const sourceKey = pathKey(task.path);
    for (const [key, entry] of local) {
      if (key !== sourceKey && !key.startsWith(`${sourceKey}/`)) continue;
      this.enqueuePlan({ id: crypto.randomUUID(), kind: entry.snapshot.kind === "directory" ? "mkdir" : "upload",
        path: `${destination}${entry.path.slice(task.path.length)}`,
        payload: { local: { ...entry.snapshot, nid: undefined }, sourcePath: entry.sourcePath ?? entry.path,
          derivedFrom: task.id } });
    }
    this.database.updateTaskPayload(task.id, { ...task.payload as object, conflictPlanned: true });
  }

  /** Project structural intents onto snapshots; no local or cloud files change here. */
  private projectStructuralTasks(local: Map<string, PathSnapshot>, remote: Map<string, PathSnapshot>, base: Map<string, PathSnapshot>): Set<string> {
    const deferred = new Set<string>();
    for (const task of this.pendingPlanTasks()) {
      if (task.kind === "rename" || task.kind === "move") {
        const payload = task.payload as RemoteRenamePayload;
        this.relocateSnapshotTree(remote, payload.intermediatePath ?? task.path, payload.destination);
        for (const key of this.relocateSnapshotTree(base, task.path, payload.destination)) deferred.add(key);
      } else if (task.kind === "local-rename") {
        const payload = task.payload as LocalRenamePayload;
        if (payload.conflict) {
          const destination = this.allocateConflictPath(task, local, remote);
          this.relocateSnapshotTree(local, task.path, destination, true, task.id);
          this.removeSnapshotTree(base, pathKey(payload.basePath ?? task.path));
          this.removeSnapshotTree(base, pathKey(task.path));
          this.database.updateTaskPayload(task.id, { ...payload, conflictPlanned: true });
        } else {
          this.relocateSnapshotTree(local, task.path, payload.destination, true, task.id);
          for (const key of this.relocateSnapshotTree(base, task.path, payload.destination)) deferred.add(key);
        }
      }
    }
    return deferred;
  }

  private planRemoteRenames(
    local: Map<string, PathSnapshot>,
    remote: Map<string, PathSnapshot>,
    base: Map<string, PathSnapshot>,
  ): Set<string> {
    const remoteByNid = new Map<string, PathSnapshot>();
    for (const entry of remote.values()) {
      if (entry.snapshot.nid) remoteByNid.set(entry.snapshot.nid, entry);
    }
    const candidates = [...base.values()].map((baseEntry) => ({
      baseEntry,
      remoteEntry: baseEntry.snapshot.nid ? remoteByNid.get(baseEntry.snapshot.nid) : undefined,
    })).filter(({ baseEntry, remoteEntry }) => remoteEntry && baseEntry.path !== remoteEntry.path &&
      baseEntry.snapshot.kind === remoteEntry.snapshot.kind)
      .sort((left, right) => left.baseEntry.path.split("/").length - right.baseEntry.path.split("/").length);
    const claimedSources: string[] = [];
    const deferredBaseKeys = new Set<string>();
    for (const { baseEntry, remoteEntry: matchedRemote } of candidates) {
      const remoteEntry = matchedRemote!;
      const nid = baseEntry.snapshot.nid;
      const sourceKey = pathKey(baseEntry.path);
      const destinationKey = pathKey(remoteEntry.path);
      if (!nid || claimedSources.some((prefix) => sourceKey.startsWith(prefix))) continue;
      const localEntry = local.get(sourceKey);
      if (!localEntry || this.destinationOccupied(local, sourceKey, destinationKey)) continue;
      const localChanged = !this.localTreeMatchesBase(baseEntry.path, local, base);

      const task = this.enqueuePlan({
        id: crypto.randomUUID(), kind: "local-rename", path: baseEntry.path, nid,
        payload: { destination: remoteEntry.path, local: localEntry.snapshot, base: baseEntry.snapshot,
          remote: remoteEntry.snapshot, conflict: localChanged },
      });
      if (localChanged) {
        const destination = this.allocateConflictPath(task, local, remote);
        this.relocateSnapshotTree(local, baseEntry.path, destination, true, task.id);
        this.removeSnapshotTree(base, sourceKey);
        this.database.updateTaskPayload(task.id, { ...task.payload as object, conflictPlanned: true });
      } else {
        this.relocateSnapshotTree(local, baseEntry.path, remoteEntry.path, true, task.id);
        for (const key of this.relocateSnapshotTree(base, baseEntry.path, remoteEntry.path)) deferredBaseKeys.add(key);
      }
      claimedSources.push(`${sourceKey}/`);
    }
    return deferredBaseKeys;
  }

  private localTreeMatchesBase(
    source: string,
    local: Map<string, PathSnapshot>,
    base: Map<string, PathSnapshot>,
  ): boolean {
    const sourceKey = pathKey(source);
    const sourcePrefix = `${sourceKey}/`;
    for (const [key, candidate] of base) {
      if (key !== sourceKey && !key.startsWith(sourcePrefix)) continue;
      const localEntry = local.get(key);
      if (!localEntry || !snapshotsEqual(candidate.snapshot, localEntry.snapshot)) return false;
    }
    for (const key of local.keys()) {
      if ((key === sourceKey || key.startsWith(sourcePrefix)) && !base.has(key)) return false;
    }
    return true;
  }

  private destinationOccupied(local: Map<string, PathSnapshot>, sourceKey: string, destinationKey: string): boolean {
    if (sourceKey === destinationKey) return false;
    const sourcePrefix = `${sourceKey}/`;
    const destinationPrefix = `${destinationKey}/`;
    for (const key of local.keys()) {
      if ((key === destinationKey || key.startsWith(destinationPrefix)) &&
          key !== sourceKey && !key.startsWith(sourcePrefix)) return true;
    }
    return false;
  }

  private removeSnapshotTree(map: Map<string, PathSnapshot>, sourceKey: string): void {
    const prefix = `${sourceKey}/`;
    for (const key of [...map.keys()]) if (key === sourceKey || key.startsWith(prefix)) map.delete(key);
  }

  private relocateSnapshotTree(map: Map<string, PathSnapshot>, source: string, destination: string, trackSource = false, derivedFrom?: string): string[] {
    const sourceKey = pathKey(source);
    const prefix = `${sourceKey}/`;
    const entries = [...map].filter(([key]) => key === sourceKey || key.startsWith(prefix));
    for (const [key] of entries) map.delete(key);
    const relocated: string[] = [];
    for (const [, entry] of entries) {
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
    try {
      await this.api.call("File.mkdir", { fname: joinRemotePath(this.settings().remoteRoot, task.path) });
    } catch (error) {
      if (!isAlreadyExistingRemoteNodeError(error)) throw error;
    }
    this.database.putBase(task.path, this.payload(task).local!);
  }

  private async recycleRemote(task: SyncTask): Promise<void> {
    const payload = this.payload(task);
    const indexedNode = task.nid ? this.database.getRemoteNodes().find((node) => node.nid === task.nid) : undefined;
    const kind = payload.remote?.kind ?? (indexedNode ? indexedNode.isDir ? "directory" : "file" : undefined)
      ?? payload.base?.kind;
    const joinedPath = joinRemotePath(this.settings().remoteRoot, task.path).replace(/\/+$/, "");
    const remotePath = kind === "directory" ? `${joinedPath}/` : joinedPath;
    
    try {
      await this.api.call("File.syncRecycle", { fname: remotePath, owner_qid: this.settings().ownerQid });
    } catch (error) {
      if (!isAlreadyDeletedRemoteError(error)) throw error;
      if (task.nid && this.database.getRemoteNodes().some((node) => node.nid === task.nid)) throw error;
      
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
    const indexed = task.nid ? this.database.getRemoteNodes().find(node => node.nid === task.nid) : undefined;
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
      await new RemoteIndexer(this.api, this.database, this.accountKey).update();
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

  private async ensureRemoteMoveDestination(destination: string): Promise<string> {
    const parent = parentVaultPath(destination);
    const root = this.settings().remoteRoot;
    if (!parent) return joinRemotePath(root, "");

    const knownDirectories = new Set(this.database.getRemoteNodes()
      .filter((node) => node.isDir)
      .map((node) => node.path.replace(/\/+$/, "")));
    const segments = parent.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const remotePath = joinRemotePath(root, current).replace(/\/+$/, "");
      if (knownDirectories.has(remotePath)) continue;
      try {
        await this.api.call("File.mkdir", { fname: `${remotePath}/` });
      } catch (error) {
        if (!isAlreadyExistingRemoteNodeError(error)) throw error;
      }
      knownDirectories.add(remotePath);
    }
    return `${joinRemotePath(root, parent).replace(/\/+$/, "")}/`;
  }

  private async upload(task: SyncTask): Promise<void> {
    const file = this.vault.getFileByPath(task.path);
    const adapterStat = file ? undefined : await this.vault.adapter.stat(task.path);
    const stat = file?.stat ?? adapterStat;
    if (!stat || (!file && adapterStat?.type !== "file")) throw new Error(`Local file disappeared: ${task.path}`);
    const bytes = new Uint8Array(file ? await this.vault.readBinary(file) : await this.vault.adapter.readBinary(task.path));
    this.transfers.queue(task.id, "upload", task.path, bytes.byteLength);
    this.transfers.start(task.id);
    this.publishTransfers();
    try {
      const before = { size: stat.size, mtime: stat.mtime };
      const response = await this.uploader.upload({ path: joinRemotePath(this.settings().remoteRoot, task.path), data: bytes,
        ctime: stat.ctime, mtime: stat.mtime, transferId: task.id,
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
    }
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
    if (existsInAdapter && payload.conflict) await this.preserveConflict(task.path, payload.local, task);
    if (payload.remote?.kind === "directory") {
      if (!existsInAdapter || payload.conflict) await this.createLocalDirectory(task.path);
      this.database.putBase(task.path, payload.remote);
      return;
    }
    this.transfers.queue(task.id, "download", task.path, payload.remote?.size ?? 0);
    this.transfers.start(task.id);
    this.publishTransfers();
    try {
      const bytes = await this.downloader.download({ path: joinRemotePath(this.settings().remoteRoot, task.path), nid: task.nid,
        onProgress: (completed, total) => this.updateTransfer(task.id, completed, total) });
      await this.atomicWrite(task.path, bytes, payload.remote?.mtime);
      if (payload.remote) this.database.putBase(task.path, payload.remote);
      this.transfers.complete(task.id);
      this.publishTransfers();
    } catch (error) {
      this.failTransfer(task.id, error);
      throw error;
    }
  }

  private queueTransferProgress(): void {
    for (const task of this.database.listTransferTasks()) {
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
    this.transfers.fail(id, error instanceof Error ? error.message : String(error));
    this.publishTransfers();
  }

  private publishTransfers(): void { this.reportTransfers(this.transfers.snapshot()); }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new SyncCancelledError();
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

  private async atomicWrite(path: string, bytes: Uint8Array, mtime?: number): Promise<void> {
    await this.ensureFolder(path);
    const temporary = `${path}.yunpan-sync-${crypto.randomUUID()}.part`;
    this.database.suppress(path, "write", undefined, Date.now() + 30_000);
    const normalizedMtime = mtime === undefined ? undefined : mtime < 1_000_000_000_000 ? mtime * 1000 : mtime;
    await this.vault.adapter.writeBinary(temporary, bytesBuffer(bytes), { mtime: normalizedMtime });
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
