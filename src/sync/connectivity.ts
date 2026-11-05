export interface ReconnectableSyncEngine {
  isRunning(): boolean;
  waitForIdle(): Promise<void>;
  resumePendingRetries(): number;
}

export interface InterruptibleSyncEngine {
  isRunning(): boolean;
  cancel(): void;
}

export function interruptSyncForDisconnect(engine: InterruptibleSyncEngine | undefined): boolean {
  if (!engine?.isRunning()) return false;
  engine.cancel();
  return true;
}

export async function resumeSyncAfterReconnect(
  isPaused: () => boolean,
  engine: ReconnectableSyncEngine | undefined,
  synchronize: () => Promise<void>,
): Promise<boolean> {
  if (!engine || isPaused()) return false;
  if (engine.isRunning()) await engine.waitForIdle();
  if (isPaused()) return false;
  engine.resumePendingRetries();
  await synchronize();
  return true;
}
