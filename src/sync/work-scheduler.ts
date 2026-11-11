/** Cooperative work slices shared by scanning, indexing and planning. */
export class WorkScheduler {
  private started = performance.now();
  private count = 0;
  private waitingMs = 0;
  longestBatchMs = 0;

  constructor(private readonly check: () => void = () => undefined) {}

  /** Exclude network/disk waits from the CPU batch measurement. */
  async waitFor<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const started = performance.now();
    try { return await operation(); }
    finally { this.waitingMs += performance.now() - started; }
  }

  async step(force = false): Promise<void> {
    this.check();
    const elapsed = performance.now() - this.started - this.waitingMs;
    if (!force && ++this.count < 100 && elapsed < 8) return;
    this.longestBatchMs = Math.max(this.longestBatchMs, elapsed);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.started = performance.now();
    this.count = 0;
    this.waitingMs = 0;
    this.check();
  }
}

export interface SyncDiagnostics {
  startedAt: number;
  durationMs: number;
  stages: Record<string, number>;
  remoteNodes: number;
  matchedNodes: number;
  localFiles: number;
  localBytes: number;
  longestBatchMs: number;
}

export async function cooperativeSort<T>(items: T[], compare: (left: T, right: T) => number,
  work: WorkScheduler): Promise<T[]> {
  let source = items;
  let target = new Array<T>(items.length);
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + width * 2, source.length);
      let left = start, right = middle;
      for (let i = start; i < end; i++) {
        target[i] = right >= end || (left < middle && compare(source[left]!, source[right]!) <= 0)
          ? source[left++]! : source[right++]!;
        await work.step();
      }
    }
    [source, target] = [target, source];
  }
  return source;
}
