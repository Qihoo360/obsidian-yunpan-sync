import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_PREPARATION_MAX_AGE_MS, MobileLoginPreparation } from "../src/auth/mobile-login-preparation.js";
import type { PreparedMobileOAuth } from "../src/auth/oauth-mobile.js";

const prepared = (state = "state"): PreparedMobileOAuth => ({
  authorizationUrl: `https://mcp.yunpan.com/authorize?state=${state}`,
  pending: { state, verifier: "verifier", clientId: "client", issuer: "https://mcp.yunpan.com", createdAt: Date.now() },
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("mobile authorization preparation", () => {
  it("deduplicates in-flight work, reports progress and reuses the prepared authorization", async () => {
    let resolve!: (value: PreparedMobileOAuth) => void;
    const changed = vi.fn();
    const prepare = vi.fn((_signal: AbortSignal, progress: (message: string) => void) => {
      progress("正在注册授权客户端");
      return new Promise<PreparedMobileOAuth>(done => { resolve = done; });
    });
    const preparation = new MobileLoginPreparation(prepare, changed);
    const first = preparation.ensure();
    expect(preparation.ensure()).toBe(first);
    expect(preparation.preparing).toBe(true);
    expect(preparation.progress).toBe("正在注册授权客户端");
    const value = prepared(); resolve(value); await first;
    await preparation.ensure();
    expect(prepare).toHaveBeenCalledOnce();
    expect(preparation.ready).toBe(value);
    expect(preparation.preparing).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it("expires unused authorizations at five minutes and prepares a new state", async () => {
    vi.useFakeTimers();
    const prepare = vi.fn(async () => prepared()).mockImplementationOnce(async () => prepared("first"));
    const preparation = new MobileLoginPreparation(prepare, vi.fn());
    await preparation.ensure();
    vi.setSystemTime(Date.now() + MOBILE_PREPARATION_MAX_AGE_MS - 1);
    expect(preparation.ready?.pending.state).toBe("first");
    vi.setSystemTime(Date.now() + 1);
    expect(preparation.ready).toBeUndefined();
    await preparation.ensure();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(preparation.ready?.pending.state).toBe("state");
  });

  it("requires an explicit retry after failure", async () => {
    const prepare = vi.fn(async () => prepared()).mockRejectedValueOnce(new Error("network failure"));
    const preparation = new MobileLoginPreparation(prepare, vi.fn());
    await preparation.ensure();
    expect(preparation.error).toBe("network failure");
    await preparation.ensure();
    expect(prepare).toHaveBeenCalledOnce();
    await preparation.ensure(true);
    expect(preparation.error).toBeUndefined();
    expect(preparation.ready).toBeDefined();
  });

  it.each(["resolve", "reject"])("ignores a stale %s and progress after cancellation and replacement", async outcome => {
    let resolve!: (value: PreparedMobileOAuth) => void;
    let reject!: (reason: Error) => void;
    let oldProgress!: (message: string) => void;
    let oldSignal!: AbortSignal;
    const prepare = vi.fn(async (_signal: AbortSignal, _progress: (message: string) => void) => prepared("new"))
      .mockImplementationOnce((signal, progress) => {
        oldSignal = signal; oldProgress = progress;
        return new Promise<PreparedMobileOAuth>((done, fail) => { resolve = done; reject = fail; });
      });
    const preparation = new MobileLoginPreparation(prepare, vi.fn());
    const old = preparation.ensure();
    preparation.clear();
    expect(oldSignal.aborted).toBe(true);
    await preparation.ensure();
    oldProgress("stale");
    if (outcome === "resolve") resolve(prepared("old"));
    else reject(new Error("old failure"));
    await old;
    expect(preparation.ready?.pending.state).toBe("new");
    expect(preparation.error).toBeUndefined();
    expect(preparation.progress).toBe("");
  });
});
