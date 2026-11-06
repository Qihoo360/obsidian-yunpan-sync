import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopOAuth } from "../src/auth/oauth-desktop.js";
import { exchangeOAuthCode } from "../src/auth/oauth.js";

vi.mock("../src/auth/oauth.js", () => ({ exchangeOAuthCode: vi.fn() }));

const auth = { accessToken: "access", qid: "42", token: "token", expiresAt: 1234 };
const controllers: AbortController[] = [];

function start() {
  const controller = new AbortController();
  controllers.push(controller);
  let opened!: (url: string) => void;
  const url = new Promise<string>(resolve => { opened = resolve; });
  const operation = new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php")
    .login(opened, 180_000, controller.signal);
  return { controller, url, operation };
}

function callbackUrl(authorization: string): string {
  const url = new URL(authorization);
  const callback = new URL(url.searchParams.get("decision_url")!);
  callback.pathname = "/oauth/callback";
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "returned-code");
  return callback.toString();
}

describe("desktop OAuth cancellation", () => {
  beforeEach(() => {
    vi.stubGlobal("require", createRequire(import.meta.url));
    vi.mocked(exchangeOAuthCode).mockReset().mockResolvedValue(auth);
  });
  afterEach(() => {
    controllers.splice(0).forEach(controller => controller.abort());
    vi.unstubAllGlobals();
  });

  it("closes the callback server immediately when cancelled", async () => {
    const { controller, url, operation } = start();
    const authorization = await url;
    const rejected = expect(operation).rejects.toThrow("登录已取消");
    controller.abort();
    await rejected;
    await expect(fetch(callbackUrl(authorization))).rejects.toThrow();
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it("rejects a pre-cancelled login without opening a browser", async () => {
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn();
    await expect(new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php")
      .login(open, 180_000, controller.signal)).rejects.toThrow("登录已取消");
    expect(open).not.toHaveBeenCalled();
  });

  it("discards token exchange results after cancellation", async () => {
    let resolve!: (value: typeof auth) => void;
    vi.mocked(exchangeOAuthCode).mockImplementation(() => new Promise(done => { resolve = done; }));
    const { controller, url, operation } = start();
    const response = await fetch(callbackUrl(await url));
    expect(response.status).toBe(200);
    expect(exchangeOAuthCode).toHaveBeenCalledOnce();
    const rejected = expect(operation).rejects.toThrow("登录已取消");
    controller.abort();
    await rejected;
    resolve(auth);
    await Promise.resolve();
    expect(exchangeOAuthCode).toHaveBeenCalledOnce();
  });

  it("settles successful callbacks once even when cancelled afterwards", async () => {
    const { controller, url, operation } = start();
    expect((await fetch(callbackUrl(await url))).status).toBe(200);
    await expect(operation).resolves.toEqual(auth);
    controller.abort();
    await expect(operation).resolves.toEqual(auth);
    expect(exchangeOAuthCode).toHaveBeenCalledOnce();
  });

  it("ignores a stale state without ending the current authorization", async () => {
    const { url, operation } = start();
    const validCallback = callbackUrl(await url);
    const staleCallback = new URL(validCallback);
    staleCallback.searchParams.set("state", "old-browser-state");
    expect((await fetch(staleCallback)).status).toBe(400);
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
    expect((await fetch(validCallback)).status).toBe(200);
    await expect(operation).resolves.toEqual(auth);
    expect(exchangeOAuthCode).toHaveBeenCalledOnce();
  });
});
