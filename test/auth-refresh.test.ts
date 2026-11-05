import { describe, expect, it, vi } from "vitest";
import {
  AuthRefreshCoordinator,
  OAuthCodeUnavailableError,
  ReloginRequiredError,
} from "../src/auth/refresh.js";
import { OauthCodeExpiredError } from "../src/auth/oauth.js";
import type { CloudAuth } from "../src/auth/secrets.js";

function auth(overrides: Partial<CloudAuth> = {}): CloudAuth {
  return { accessToken: "old-access", qid: "42", token: "old-cloud", expiresAt: 1, oauthCode: "oauth-code", ...overrides };
}

describe("OAuth access token refresh", () => {
  it("coalesces concurrent refreshes and persists the renewed credentials", async () => {
    let stored = auth();
    
    const exchange = vi.fn(async () => auth({ accessToken: "fresh-access", token: "fresh-cloud", expiresAt: 2 }));
    const coordinator = new AuthRefreshCoordinator(() => stored, (next) => { stored = next; }, exchange);

    await Promise.all([coordinator.refresh(), coordinator.refresh()]);

    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledWith("oauth-code");
    expect(stored.accessToken).toBe("fresh-access");
    expect(stored.oauthCode).toBe("oauth-code");
    
    
    
  });

  it("requires browser login only when oauth_code is expired", async () => {
    const expired = new AuthRefreshCoordinator(() => auth(), vi.fn(), async () => {
      throw new OauthCodeExpiredError("oauth_code expired", 311, "trace-311");
    });
    await expect(expired.refresh()).rejects.toBeInstanceOf(ReloginRequiredError);

    const networkFailure = new AuthRefreshCoordinator(() => auth(), vi.fn(), async () => {
      throw new Error("network unavailable");
    });
    await expect(networkFailure.refresh()).rejects.toThrow("network unavailable");

    const legacy = new AuthRefreshCoordinator(() => auth({ oauthCode: undefined }), vi.fn(), vi.fn());
    const legacyFailure = legacy.refresh();
    await expect(legacyFailure).rejects.toBeInstanceOf(OAuthCodeUnavailableError);
    await expect(legacyFailure).rejects.not.toBeInstanceOf(ReloginRequiredError);
  });
});
