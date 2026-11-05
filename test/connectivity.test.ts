import { describe, expect, it, vi } from "vitest";
import { interruptSyncForDisconnect, resumeSyncAfterReconnect } from "../src/sync/connectivity.js";

describe("online synchronization recovery", () => {
  it("stops task intake when the network disconnects", () => {
    const engine = { isRunning: () => true, cancel: vi.fn() };

    expect(interruptSyncForDisconnect(engine)).toBe(true);

    expect(engine.cancel).toHaveBeenCalledOnce();
  });

  it("does nothing on disconnect when synchronization is idle", () => {
    const engine = { isRunning: () => false, cancel: vi.fn() };

    expect(interruptSyncForDisconnect(engine)).toBe(false);

    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it("waits for an interrupted run, releases retries, and starts synchronization", async () => {
    const order: string[] = [];
    const engine = {
      isRunning: () => true,
      waitForIdle: vi.fn(async () => { order.push("idle"); }),
      resumePendingRetries: vi.fn(() => { order.push("retry"); return 2; }),
    };
    const synchronize = vi.fn(async () => { order.push("sync"); });

    await expect(resumeSyncAfterReconnect(() => false, engine, synchronize)).resolves.toBe(true);

    expect(order).toEqual(["idle", "retry", "sync"]);
  });

  it("does not resume tasks or synchronize while paused", async () => {
    const engine = {
      isRunning: () => false,
      waitForIdle: vi.fn(),
      resumePendingRetries: vi.fn(),
    };
    const synchronize = vi.fn();

    await expect(resumeSyncAfterReconnect(() => true, engine, synchronize)).resolves.toBe(false);

    expect(engine.resumePendingRetries).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });

  it("honors a pause requested while waiting for the active run to stop", async () => {
    let paused = false;
    const engine = {
      isRunning: () => true,
      waitForIdle: vi.fn(async () => { paused = true; }),
      resumePendingRetries: vi.fn(),
    };
    const synchronize = vi.fn();

    await expect(resumeSyncAfterReconnect(() => paused, engine, synchronize)).resolves.toBe(false);

    expect(engine.resumePendingRetries).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });
});
