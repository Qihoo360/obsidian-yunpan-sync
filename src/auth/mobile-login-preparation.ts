import type { PreparedMobileOAuth } from "./oauth-mobile.js";

export const MOBILE_PREPARATION_MAX_AGE_MS = 5 * 60_000;

type Prepare = (signal: AbortSignal, progress: (message: string) => void) => Promise<PreparedMobileOAuth>;

/** Unused authorizations stay in memory and never open a browser by themselves. */
export class MobileLoginPreparation {
  private prepared?: PreparedMobileOAuth;
  private attempt?: { controller: AbortController; task: Promise<void> };
  error?: string;
  progress = "";

  constructor(private readonly prepare: Prepare, private readonly changed: () => void) {}

  get ready(): PreparedMobileOAuth | undefined {
    if (this.prepared && Date.now() - this.prepared.pending.createdAt < MOBILE_PREPARATION_MAX_AGE_MS) {
      return this.prepared;
    }
    return undefined;
  }

  get preparing(): boolean { return !!this.attempt; }

  ensure(retry = false): Promise<void> {
    if (this.attempt) return this.attempt.task;
    if (this.ready || (this.error && !retry)) return Promise.resolve();
    this.prepared = undefined;
    this.error = undefined;
    this.progress = "正在准备登录";
    const attempt = { controller: new AbortController(), task: Promise.resolve() };
    this.attempt = attempt;
    const current = () => this.attempt === attempt && !attempt.controller.signal.aborted;
    attempt.task = (async () => {
      try {
        const prepared = await this.prepare(attempt.controller.signal, (message) => {
          if (!current()) return;
          this.progress = message;
          this.changed();
        });
        if (current()) this.prepared = prepared;
      } catch (error) {
        if (current()) this.error = error instanceof Error ? error.message : String(error);
      } finally {
        if (current()) {
          this.attempt = undefined;
          this.progress = "";
          this.changed();
        }
      }
    })();
    this.changed();
    return attempt.task;
  }

  clear(): void {
    const attempt = this.attempt;
    this.attempt = undefined;
    this.prepared = undefined;
    this.error = undefined;
    this.progress = "";
    attempt?.controller.abort();
    this.changed();
  }
}
