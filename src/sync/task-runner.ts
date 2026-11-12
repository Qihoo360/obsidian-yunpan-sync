import { SyncDatabase, type SyncTask, type TaskKind } from "../storage/database.js";
import { OpenApiError } from "../net/openapi-client.js";
import { syncRestrictionError } from "./quota.js";
import { TaskSkippedError } from "./file-policy.js";
import { DownloadCacheError } from "../transfer/download-cache.js";

export type TaskExecutor = (task: SyncTask) => Promise<void>;

/** Only network/server throttling is safe to replay automatically. A rejected
 * name, permission, quota, or local mutation will not become valid by waiting. */
export function isRetryableTaskError(error: unknown): boolean {
  // Cache recovery already retried once; avoid another eight repair cycles.
  if (error instanceof DownloadCacheError) return false;
  if (error instanceof OpenApiError) {
    if (error.status !== undefined) return error.status === 429 || error.status >= 500;
    if (error.errno !== undefined && error.errno >= 400 && error.errno < 500) return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/WindowsPathError|文件名|文件不合规|名称不合规|invalid\s+(?:file\s*)?name|name\s+(?:is\s+)?(?:not\s+allowed|invalid)|permission|forbidden|无权限|权限不足|quota|容量不足|套餐|会员|local file (?:changed|appeared|disappeared)|本地文件.*(?:变化|不存在)/i.test(message)) return false;
  return /request\s+frequent|too many requests|请求频繁|HTTP\s*429|HTTP\s*5\d\d|network|timeout|timed out|offline|econn|dns|网络|连接/i.test(message) ||
    !(error instanceof OpenApiError);
}

export interface TaskRunnerOptions {
  now?: () => number;
  retryDelay?: (attempt: number) => number;
  maxAttempts?: number;
  kinds?: TaskKind[];
  propagateErrors?: boolean;
  checkpoint?: () => Promise<void>;
  shouldCancel?: () => boolean;
  concurrency?: number;
  waitForRetries?: boolean;
  dependencies?: boolean;
  onRetryWait?: (until: number) => void;
  taskIds?: readonly string[];
  onTaskSettled?: (task: SyncTask, outcome: "completed" | "skipped") => void;
}

export class TaskRunner {
  private readonly now: () => number;
  private readonly retryDelay: (attempt: number) => number;
  private readonly maxAttempts: number;
  private readonly kinds?: TaskKind[];
  private readonly propagateErrors: boolean;
  private readonly checkpoint: () => Promise<void>;
  private readonly shouldCancel: () => boolean;
  private readonly concurrency: number;
  private stopped = false;
  private skipped = 0;
  private readonly options: TaskRunnerOptions;

  constructor(
    private readonly database: SyncDatabase,
    private readonly executors: Partial<Record<TaskKind, TaskExecutor>>,
    options: TaskRunnerOptions = {},
  ) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.retryDelay = options.retryDelay ?? ((attempt) => Math.min(60_000, 1000 * 2 ** attempt));
    this.maxAttempts = options.maxAttempts ?? 8;
    this.kinds = options.kinds;
    this.propagateErrors = options.propagateErrors ?? false;
    this.checkpoint = options.checkpoint ?? (async () => undefined);
    this.shouldCancel = options.shouldCancel ?? (() => false);
    this.concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 1)));
  }

  async runOne(): Promise<boolean> {
    if (this.stopped || this.shouldCancel()) return false;
    const task = this.database.claimNextRunnableTask(this.now(), this.kinds, this.options.dependencies, this.options.taskIds);
    if (!task) return false;
    const execute = this.executors[task.kind];
    if (!execute) {
      const message = `No executor registered for ${task.kind}`;
      this.database.failTask(task.id, message);
      
      await this.checkpoint();
      return true;
    }
    try {
      await this.checkpoint();
      await execute(task);
      this.database.completeTask(task.id);
      this.options.onTaskSettled?.(task, "completed");
      
      await this.checkpoint();
    } catch (error) {
      if (error instanceof TaskSkippedError) {
        this.database.skipRunningTask(task.id);
        this.skipped++;
        this.options.onTaskSettled?.(task, "skipped");
        await this.checkpoint();
        return true;
      }
      if (this.shouldCancel()) {
        this.stopped = true;
        this.database.deferTask(task.id);
        await this.checkpoint();
        return true;
      }
      const restriction = syncRestrictionError(error);
      if (restriction) {
        this.stopped = true;
        this.database.deferTask(task.id, restriction.message);
        await this.checkpoint();
        throw restriction;
      }
      const message = (error instanceof Error ? error.message : String(error)) +
        (error instanceof OpenApiError ? `${error.errno === undefined ? "" : ` (errno: ${error.errno})`}${error.traceId ? ` (trace_id: ${error.traceId})` : ""}` : "");
      const nextAttempt = task.attempt + 1;
      const retryAt = isRetryableTaskError(error) && nextAttempt < this.maxAttempts
        ? this.now() + this.retryDelay(nextAttempt) : undefined;
      this.database.failTask(task.id, message, retryAt);
      await this.checkpoint();
      if (this.propagateErrors) throw error;
    }
    return true;
  }

  async drain(limit = Number.POSITIVE_INFINITY): Promise<number> {
    this.stopped = false;
    const skippedBefore = this.skipped;
    let reserved = 0;
    let processed = 0;
    const worker = async (): Promise<void> => {
      while (reserved < limit) {
        reserved++;
        if (!await this.runOne()) {
          reserved--;
          return;
        }
        processed++;
      }
    };
    while (true) {
      const outcomes = await Promise.allSettled(Array.from({ length: this.concurrency }, () => worker()));
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
      if (!this.options.waitForRetries || this.stopped || this.shouldCancel() || reserved >= limit) break;
      const next = this.database.nextTaskTime(this.kinds, this.options.dependencies, this.options.taskIds);
      if (next === undefined) break;
      this.options.onRetryWait?.(next);
      while (this.now() < next && !this.shouldCancel() && !this.stopped) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, next - this.now()))));
      }
    }
    return processed - (this.skipped - skippedBefore);
  }

  assertSettled(): void {
    const { queued, failed } = this.database.taskCounts();
    if (failed > 0) throw new Error(`${failed} sync task${failed === 1 ? "" : "s"} failed`);
    if (queued > 0) throw new Error(`${queued} sync task${queued === 1 ? " is" : "s are"} still queued`);
  }
}
