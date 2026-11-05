export interface SyncControl {
  isRunning(): boolean;
  cancel(): void;
  waitForIdle(): Promise<void>;
}

export async function settleForPause(paused: boolean, engine?: SyncControl): Promise<void> {
  if (!paused || !engine?.isRunning()) return;
  engine.cancel();
  await engine.waitForIdle();
}

export interface LifecycleTimerApi {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

const browserTimers: LifecycleTimerApi = {
  setTimeout: (callback, delay) => window.setTimeout(callback, delay),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (callback, delay) => window.setInterval(callback, delay),
  clearInterval: (id) => window.clearInterval(id),
};

export class PluginLifecycleTimers {
  private debounceId?: number;
  private pollingId?: number;

  constructor(private readonly timers: LifecycleTimerApi = browserTimers) {}

  configurePolling(interval: number | undefined, callback: () => void): void {
    if (this.pollingId !== undefined) this.timers.clearInterval(this.pollingId);
    this.pollingId = interval === undefined ? undefined : this.timers.setInterval(callback, interval);
  }

  debounce(delay: number, callback: () => void): void {
    if (this.debounceId !== undefined) this.timers.clearTimeout(this.debounceId);
    this.debounceId = this.timers.setTimeout(() => {
      this.debounceId = undefined;
      callback();
    }, delay);
  }

  dispose(): void {
    if (this.debounceId !== undefined) this.timers.clearTimeout(this.debounceId);
    if (this.pollingId !== undefined) this.timers.clearInterval(this.pollingId);
    this.debounceId = undefined;
    this.pollingId = undefined;
  }
}
