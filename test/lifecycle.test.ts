import { describe, expect, it, vi } from "vitest";
import { PluginLifecycleTimers, settleForPause } from "../src/lifecycle.js";

describe("plugin synchronization lifecycle", () => {
  it("cancels an active synchronization and waits for its safe boundary when paused", async () => {
    const order: string[] = [];
    const engine = {
      isRunning: () => true,
      cancel: vi.fn(() => { order.push("cancel"); }),
      waitForIdle: vi.fn(async () => { order.push("idle"); }),
    };

    await settleForPause(true, engine);

    expect(order).toEqual(["cancel", "idle"]);
  });

  it("does not cancel work when synchronization is resumed", async () => {
    const engine = { isRunning: () => true, cancel: vi.fn(), waitForIdle: vi.fn() };

    await settleForPause(false, engine);

    expect(engine.cancel).not.toHaveBeenCalled();
    expect(engine.waitForIdle).not.toHaveBeenCalled();
  });

  it("replaces polling schedules and disposes polling and debounced work", () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 0;
    const timers = {
      setTimeout: vi.fn((callback: () => void) => { callbacks.set(++nextId, callback); return nextId; }),
      clearTimeout: vi.fn((id: number) => { callbacks.delete(id); }),
      setInterval: vi.fn((callback: () => void) => { callbacks.set(++nextId, callback); return nextId; }),
      clearInterval: vi.fn((id: number) => { callbacks.delete(id); }),
    };
    const lifecycle = new PluginLifecycleTimers(timers);
    const poll = vi.fn();
    const sync = vi.fn();

    lifecycle.configurePolling(30_000, poll);
    lifecycle.configurePolling(60_000, poll);
    lifecycle.debounce(1_500, sync);
    lifecycle.debounce(1_500, sync);

    expect(timers.clearInterval).toHaveBeenCalledWith(1);
    expect(timers.clearTimeout).toHaveBeenCalledWith(3);
    lifecycle.dispose();
    expect(timers.clearInterval).toHaveBeenCalledWith(2);
    expect(timers.clearTimeout).toHaveBeenCalledWith(4);
    expect(callbacks).toEqual(new Map());
  });

  it("runs only the latest debounced callback once", () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 0;
    const timers = {
      setTimeout: (callback: () => void) => { callbacks.set(++nextId, callback); return nextId; },
      clearTimeout: (id: number) => { callbacks.delete(id); },
      setInterval: () => 0,
      clearInterval: () => undefined,
    };
    const lifecycle = new PluginLifecycleTimers(timers);
    const first = vi.fn();
    const latest = vi.fn();

    lifecycle.debounce(1_500, first);
    lifecycle.debounce(1_500, latest);
    callbacks.get(2)?.();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    lifecycle.dispose();
  });
});
