export function isRateLimitError(error: unknown): boolean {
  const value = error instanceof Error ? error.message : String(error);
  return /request\s+frequently|too many requests|请求(?:过于)?频繁|HTTP[^\d]*429/i.test(value);
}

/** Shared by one account's OpenAPI and Store clients. File bodies keep their own slots. */
export class RequestScheduler {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private cooldownUntil = 0;
  private limitAttempt = 0;
  private lastLimitAt = 0;

  constructor(private readonly interval = 200) {}

  async wait(check: () => void = () => undefined): Promise<void> {
    while (Date.now() < this.cooldownUntil) {
      check();
      await new Promise(resolve => setTimeout(resolve, Math.min(100, this.cooldownUntil - Date.now())));
    }
    check();
  }

  coolDown(attempt: number): void {
    if (Date.now() - this.lastLimitAt > 60_000) this.limitAttempt = 0;
    this.lastLimitAt = Date.now();
    const exponent = Math.max(attempt, this.limitAttempt);
    this.limitAttempt = Math.min(5, exponent + 1);
    this.cooldownUntil = Math.max(this.cooldownUntil,
      Date.now() + Math.min(30_000, 1000 * 2 ** exponent) + Math.floor(Math.random() * 250));
  }

  async metadata<T>(request: () => Promise<T>, check: () => void = () => undefined): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      while (Date.now() < this.nextStart) {
        check();
        await new Promise(resolve => setTimeout(resolve, Math.min(100, this.nextStart - Date.now())));
      }
      await this.wait(check);
      this.nextStart = Date.now() + this.interval;
      return await request();
    } finally { release(); }
  }
}
