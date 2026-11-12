/** Network type detection is intentionally absent: Obsidian mobile plugins do
 * not expose a reliable Wi-Fi/cellular API. Keep only lifecycle helpers. */

export interface ReconnectableSyncEngine {
  isRunning(): boolean;
  waitForIdle(): Promise<void>;
  resumePendingRetries(): number;
}

export interface InterruptibleSyncEngine {
  isRunning(): boolean;
  cancel(message?: string): void;
}

export function interruptSyncForDisconnect(engine: InterruptibleSyncEngine | undefined): boolean {
  if (!engine?.isRunning()) return false;
  engine.cancel("网络已断开，同步已暂停");
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
