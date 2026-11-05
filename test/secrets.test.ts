import { describe, expect, it } from "vitest";
import { AUTH_SECRET_ID, LEGACY_AUTH_SECRET_ID, SecretStore } from "../src/auth/secrets.js";

describe("SecretStore compatibility", () => {
  it("migrates the historical snake_case OAuth code field on read", () => {
    const storage = {
      value: JSON.stringify({ accessToken: "a", qid: "42", token: "t", expiresAt: 123, oauth_code: "legacy-code" }),
      getSecret(id: string) { expect(id).toBe(AUTH_SECRET_ID); return this.value; },
      setSecret(_id: string, value: string) { this.value = value; },
    };

    expect(new SecretStore(storage).getAuth()).toMatchObject({ oauthCode: "legacy-code" });
  });

  it("migrates credentials saved under the previous plugin id", () => {
    const legacy = JSON.stringify({ accessToken: "a", qid: "42", token: "t", expiresAt: 123, oauthCode: "code" });
    const values = new Map([[LEGACY_AUTH_SECRET_ID, legacy]]);
    const storage = {
      getSecret(id: string) { return values.get(id) ?? null; },
      setSecret(id: string, value: string) { values.set(id, value); },
    };

    expect(new SecretStore(storage).getAuth()).toMatchObject({ qid: "42", oauthCode: "code" });
    expect(values.get(AUTH_SECRET_ID)).toBe(legacy);
    expect(values.get(LEGACY_AUTH_SECRET_ID)).toBe("");
  });

  it("clears credentials stored under both plugin ids", () => {
    const values = new Map([[AUTH_SECRET_ID, "current"], [LEGACY_AUTH_SECRET_ID, "legacy"]]);
    const storage = {
      getSecret(id: string) { return values.get(id) ?? null; },
      setSecret(id: string, value: string) { values.set(id, value); },
    };

    new SecretStore(storage).clearAuth();

    expect(values.get(AUTH_SECRET_ID)).toBe("");
    expect(values.get(LEGACY_AUTH_SECRET_ID)).toBe("");
  });
});
