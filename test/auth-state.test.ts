import { describe, expect, it } from "vitest";
import { RELOGIN_MESSAGE, statusBarDestination } from "../src/ui/auth-state.js";

describe("authentication user state", () => {
  it("shows only a concise relogin message", () => {
    expect(RELOGIN_MESSAGE).toBe("请重新登录");
    expect(RELOGIN_MESSAGE).not.toContain("OAuth");
    expect(RELOGIN_MESSAGE).not.toContain("access_token");
  });

  it("opens settings when logged out or relogin is required", () => {
    expect(statusBarDestination(false, "未登录")).toBe("settings");
    expect(statusBarDestination(false, RELOGIN_MESSAGE)).toBe("settings");
    expect(statusBarDestination(true, RELOGIN_MESSAGE)).toBe("settings");
  });

  it("keeps normal authenticated status clicks on the sync view", () => {
    expect(statusBarDestination(true, "同步完成")).toBe("status");
  });
});
