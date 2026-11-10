import { describe, expect, it, vi } from "vitest";

const requestUrl = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (importOriginal) => ({ ...await importOriginal<object>(), requestUrl }));
vi.mock("../src/auth/oauth.js", () => ({ exchangeOAuthCode: vi.fn() }));

import { DesktopOAuth } from "../src/auth/oauth-desktop.js";
import { exchangeOAuthCode } from "../src/auth/oauth.js";

const auth = { accessToken: "access", qid: "42", token: "token", expiresAt: 1234 };

describe("desktop HTTPS OAuth", () => {
  it("registers a native callback and requests the desktop HTTPS page with PKCE", async () => {
    requestUrl.mockReset()
      .mockResolvedValueOnce({ status: 200, json: {
        authorization_endpoint: "https://mcp.yunpan.com/authorize",
        registration_endpoint: "https://mcp.yunpan.com/register",
      } })
      .mockResolvedValueOnce({ status: 201, json: { client_id: "client-1" } });
    const prepared = await new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php").prepare();
    const url = new URL(prepared.authorizationUrl);
    expect(url.searchParams.get("completion_mode")).toBe("page");
    expect(url.searchParams.get("redirect_uri")).toBe("obsidian://yunpan-sync");
    expect(url.searchParams.has("completion_redirect_uri")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("login_surface")).toBe("desktop");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prepared.pending.verifier));
    expect(url.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
    expect(prepared.pending.flow).toBe("desktop");
  });

  it("checks state and exchanges the HTTPS completion code", async () => {
    requestUrl.mockReset().mockResolvedValue({ status: 200, json: { oauth_code: "cloud-code" } });
    vi.mocked(exchangeOAuthCode).mockResolvedValue(auth);
    const pending = { state: "state", verifier: "A".repeat(43), clientId: "client", createdAt: Date.now(), issuer: "https://mcp.yunpan.com", flow: "desktop" as const };
    await expect(new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php").complete({ state: "wrong", code: "code" }, pending)).rejects.toThrow("state");
    await expect(new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php").complete({ state: "state", code: "code" }, pending)).resolves.toEqual(auth);
    expect(exchangeOAuthCode).toHaveBeenCalledWith("https://openapi.eyun.360.cn/intf.php", "cloud-code");
    expect(requestUrl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: "https://mcp.yunpan.com/oauth/360/exchange",
      body: new URLSearchParams({ client_id: "client", code: "code", redirect_uri: "obsidian://yunpan-sync", code_verifier: pending.verifier }).toString() }));
  });

  it("does not expose a local HTTP callback path", async () => {
    const controller = new AbortController();
    controller.abort();
    requestUrl.mockClear();
    await expect(new DesktopOAuth("production", "https://openapi.eyun.360.cn/intf.php").prepare(controller.signal)).rejects.toThrow("登录已取消");
    expect(requestUrl).not.toHaveBeenCalled();
  });
});
