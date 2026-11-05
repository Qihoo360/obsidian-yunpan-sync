import { SyncDatabase, type SyncTask, type TaskKind } from "../storage/database.js";
import { OpenApiError } from "../net/openapi-client.js";

export type TaskExecutor = (task: SyncTask) => Promise<void>;

export interface TaskRunnerOptions {
  now?: () => number;
  retryDelay?: (attempt: number) => number;
  maxAttempts?: number;
  kinds?: TaskKind[];
  propagateErrors?: boolean;
  checkpoint?: () => Promise<void>;
  shouldCancel?: () => boolean;
  concurrency?: number;
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

  constructor(
    private readonly database: SyncDatabase,
    private readonly executors: Partial<Record<TaskKind, TaskExecutor>>,
    options: TaskRunnerOptions = {},
  ) {
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
    if (this.shouldCancel()) return false;
    const task = this.database.claimNextRunnableTask(this.now(), this.kinds);
    if (!task) return false;
    const execute = this.executors[task.kind];
    if (!execute) {
      const message = `No executor registered for ${task.kind}`;
      this.database.failTask(task.id, message);
      
      await this.checkpoint();
      return true;
    }
    const startedAt = Date.now();
    
    try {
      await this.checkpoint();
      await execute(task);
      this.database.completeTask(task.id);
      
      await this.checkpoint();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextAttempt = task.attempt + 1;
      this.database.failTask(task.id, message,
        nextAttempt >= this.maxAttempts ? undefined : this.now() + this.retryDelay(nextAttempt));
      const apiError = error instanceof OpenApiError ? error : undefined;
      let destination: string | undefined;
      try {
        const payload = task.payload as { destination?: unknown };
        destination = typeof payload.destination === "string" ? payload.destination : undefined;
      } catch { /* Malformed payload is already represented by the task error. */ }
      
      await this.checkpoint();
      if (this.propagateErrors) throw error;
    }
    return true;
  }

  async drain(limit = Number.POSITIVE_INFINITY): Promise<number> {
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
    await Promise.all(Array.from({ length: this.concurrency }, () => worker()));
    return processed;
  }

  assertSettled(): void {
    const { queued, failed } = this.database.taskCounts();
    if (failed > 0) throw new Error(`${failed} sync task${failed === 1 ? "" : "s"} failed`);
    if (queued > 0) throw new Error(`${queued} sync task${queued === 1 ? " is" : "s are"} still queued`);
  }
}
