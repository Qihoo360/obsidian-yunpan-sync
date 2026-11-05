import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "./obsidian.js";
import { MOBILE_REDIRECT_URI, MobileOAuth, mobileIssuer } from "../src/auth/oauth-mobile.js";

function response(json: unknown, status = 200) {
  return { status, json, text: JSON.stringify(json) };
}

describe("mobile OAuth", () => {
  beforeEach(() => requestUrl.mockReset());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(["读取授权配置", "注册授权客户端"])("reports a stalled %s and never opens the browser after timeout", async (stage) => {
    vi.useFakeTimers();
    let finishRequest!: (value: ReturnType<typeof response>) => void;
    if (stage === "注册授权客户端") requestUrl.mockResolvedValueOnce(response({}));
    requestUrl.mockImplementationOnce(() => new Promise((resolve) => { finishRequest = resolve; }));
    const open = vi.fn();
    let failure: unknown;
    const operation = new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php")
      .start(open).catch((error) => { failure = error; });

    await vi.advanceTimersByTimeAsync(15_001);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`${stage}超时`);
    finishRequest(response({ client_id: "late-client" }));
    await operation;
    expect(open).not.toHaveBeenCalled();
  });

  it("reports preparation progress before opening the browser", async () => {
    requestUrl.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ client_id: "mobile-client" }));
    const progress: string[] = [];
    const oauth = new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php", (message) => progress.push(message));
    await oauth.start(() => {
      expect(progress).toEqual(["正在读取授权配置", "正在注册授权客户端", "正在准备安全授权", "正在打开浏览器授权"]);
    });
  });

  it("identifies the failed request without exposing the response body", async () => {
    requestUrl.mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({ secret: "private-server-body" }, 403));
    const open = vi.fn();
    await expect(new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php").start(open))
      .rejects.toThrow("注册授权客户端失败（HTTP 403）");
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ["registration_endpoint", "https://untrusted.example/register"],
    ["authorization_endpoint", "https://untrusted.example/authorize"],
    ["registration_endpoint", "http://mcp.yunpan.com/register"],
    ["authorization_endpoint", "https://user:password@mcp.yunpan.com/authorize"],
    ["authorization_endpoint", "javascript:alert(1)"],
  ])("rejects untrusted metadata %s=%s", async (field, url) => {
    requestUrl.mockResolvedValueOnce(response({ [field!]: url }))
      .mockResolvedValueOnce(response({ client_id: "mobile-client" }));
    await expect(new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php").start(vi.fn()))
      .rejects.toThrow("OAuth 服务返回了不受信任的地址");
    expect(requestUrl).toHaveBeenCalledTimes(1);
  });

  it("identifies a native network failure without including sensitive error content", async () => {
    requestUrl.mockRejectedValueOnce(new Error("private-native-error"));
    await expect(new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php").start(vi.fn()))
      .rejects.toThrow("读取授权配置失败：网络请求异常，请检查 Obsidian 的网络权限");
  });

  it("uses the environment issuer and starts a PKCE authorization", async () => {
    requestUrl
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://mcp.yunpan.com/authorize",
        registration_endpoint: "https://mcp.yunpan.com/register",
      }))
      .mockResolvedValueOnce(response({ client_id: "mobile-client" }, 201));

    const open = vi.fn();
    const pending = await new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php").start(open);

    expect(mobileIssuer("production")).toBe("https://mcp.yunpan.com");
    expect(pending.clientId).toBe("mobile-client");
    expect(pending.verifier.length).toBeGreaterThan(20);
    expect(open).toHaveBeenCalledOnce();
    const authorization = new URL(open.mock.calls[0]?.[0] as string);
    expect(authorization.origin).toBe("https://mcp.yunpan.com");
    expect(authorization.pathname).toBe("/authorize");
    expect(authorization.searchParams.get("login_surface")).toBe("mobile");
    expect(authorization.searchParams.get("redirect_uri")).toBe(MOBILE_REDIRECT_URI);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("checks state, exchanges the mobile code, then reuses OpenAPI OAuth exchange", async () => {
    requestUrl
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://mcp.yunpan.com/authorize",
        registration_endpoint: "https://mcp.yunpan.com/register",
      }))
      .mockResolvedValueOnce(response({ client_id: "mobile-client" }, 201))
      .mockResolvedValueOnce(response({ oauth_code: "cloud-oauth-code" }))
      .mockResolvedValueOnce(response({
        errno: 0,
        data: { access_token: "access", qid: "42", token: "cloud-token", access_token_expire: 3600 },
      }));

    const oauth = new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php");
    const open = vi.fn();
    const pending = await oauth.start(open);
    expect(new URL(open.mock.calls[0]?.[0] as string).origin).toBe("https://mcp.yunpan.com");
    expect(new URL(open.mock.calls[0]?.[0] as string).searchParams.get("login_surface")).toBe("mobile");
    const auth = await oauth.complete({ action: "yunpan-sync", code: "mcp-code", state: pending.state }, pending);

    expect(auth).toMatchObject({ accessToken: "access", qid: "42", token: "cloud-token", oauthCode: "cloud-oauth-code" });
    expect(requestUrl.mock.calls[2]?.[0]).toMatchObject({
      url: "https://mcp.yunpan.com/oauth/360/mobile-exchange",
      method: "POST",
    });
    expect(requestUrl.mock.calls[3]?.[0]).toMatchObject({ url: "https://openapi.eyun.360.cn/intf.php?method=Oauth.getAccessTokenByOauthCode&oauth_code=cloud-oauth-code&client_env=obsidian&client_src=obsidian-yunpan-sync&grant_type=authorization_code&sub_channel=" });
  });

  it("rejects a callback with the wrong state before exchanging anything", async () => {
    requestUrl
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://mcp.yunpan.com/authorize",
        registration_endpoint: "https://mcp.yunpan.com/register",
      }))
      .mockResolvedValueOnce(response({ client_id: "mobile-client" }, 201));

    const oauth = new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php");
    const pending = await oauth.start(vi.fn());
    await expect(oauth.complete({ action: "yunpan-sync", code: "mcp-code", state: "wrong" }, pending))
      .rejects.toThrow("OAuth state 校验失败");
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects expired, cancelled, and duplicate callbacks before code exchange", async () => {
    requestUrl
      .mockResolvedValueOnce(response({
        authorization_endpoint: "https://mcp.yunpan.com/authorize",
        registration_endpoint: "https://mcp.yunpan.com/register",
      }))
      .mockResolvedValueOnce(response({ client_id: "mobile-client" }, 201));
    const oauth = new MobileOAuth("production", "https://openapi.eyun.360.cn/intf.php");
    const pending = await oauth.start(vi.fn());
    await expect(oauth.complete({ action: "yunpan-sync", code: "code", state: pending.state, error: "access_denied" }, pending))
      .rejects.toThrow("OAuth 授权被取消");
    await expect(oauth.complete({ action: "yunpan-sync", code: "code", state: pending.state }, { ...pending, createdAt: 0 }))
      .rejects.toThrow("OAuth 授权已超时");
    expect(requestUrl).toHaveBeenCalledTimes(2);
  });
});
