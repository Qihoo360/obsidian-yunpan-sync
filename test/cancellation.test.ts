import { describe, expect, it } from "vitest";
import { cancellable, RequestCancelledError } from "../src/net/cancellation.js";

describe("cancellable network work", () => {
  it("returns promptly when the signal aborts before the host request resolves", async () => {
    const controller = new AbortController();
    let resolveRequest!: (value: string) => void;
    const request = new Promise<string>(resolve => { resolveRequest = resolve; });
    const running = cancellable(request, controller.signal);
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(RequestCancelledError);
    resolveRequest("late response");
  });

  it("runs the cancellation check so sync cancellation keeps its normal path", async () => {
    const controller = new AbortController();
    let checked = false;
    const request = new Promise<void>(() => undefined);
    const running = cancellable(request, controller.signal, () => { checked = true; });
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(RequestCancelledError);
    expect(checked).toBe(true);
  });
});
