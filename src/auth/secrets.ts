export const AUTH_SECRET_ID = "yunpan-sync-auth";
export const LEGACY_AUTH_SECRET_ID = "obsidian-yunpan-sync-auth";
export const MOBILE_PENDING_OAUTH_SECRET_ID = "yunpan-sync-mobile-oauth-pending";

export interface CloudAuth {
  accessToken: string;
  qid: string;
  token: string;
  expiresAt: number;
  oauthCode?: string;
}

export interface PendingOAuth {
  state: string;
  verifier: string;
  clientId: string;
  createdAt: number;
  issuer: string;
}

export interface SecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

export class SecretStore {
  constructor(private readonly storage: SecretStorageLike) {}

  getAuth(): CloudAuth | undefined {
    const current = this.storage.getSecret(AUTH_SECRET_ID);
    if (current) return this.parseAuth(current);

    const legacy = this.storage.getSecret(LEGACY_AUTH_SECRET_ID);
    if (!legacy) return undefined;
    const auth = this.parseAuth(legacy);
    if (!auth) return undefined;
    this.storage.setSecret(AUTH_SECRET_ID, legacy);
    this.storage.setSecret(LEGACY_AUTH_SECRET_ID, "");
    return auth;
  }

  setAuth(auth: CloudAuth): void { this.storage.setSecret(AUTH_SECRET_ID, JSON.stringify(auth)); }

  clearAuth(): void {
    this.storage.setSecret(AUTH_SECRET_ID, "");
    this.storage.setSecret(LEGACY_AUTH_SECRET_ID, "");
  }

  getPendingOAuth(): PendingOAuth | undefined {
    const value = this.storage.getSecret(MOBILE_PENDING_OAUTH_SECRET_ID);
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as Partial<PendingOAuth>;
      if (typeof parsed.state !== "string" || typeof parsed.verifier !== "string" ||
        typeof parsed.clientId !== "string" || typeof parsed.issuer !== "string" ||
        !Number.isFinite(parsed.createdAt)) return undefined;
      return parsed as PendingOAuth;
    } catch { return undefined; }
  }

  setPendingOAuth(pending: PendingOAuth): void {
    this.storage.setSecret(MOBILE_PENDING_OAUTH_SECRET_ID, JSON.stringify(pending));
  }

  clearPendingOAuth(): void { this.storage.setSecret(MOBILE_PENDING_OAUTH_SECRET_ID, ""); }

  private parseAuth(value: string): CloudAuth | undefined {
    try {
      const parsed = JSON.parse(value) as CloudAuth & { oauth_code?: unknown };
      // 兼容早期构建曾使用的 snake_case 字段。
      const auth: CloudAuth = {
        accessToken: parsed.accessToken,
        qid: parsed.qid,
        token: parsed.token,
        expiresAt: parsed.expiresAt,
        oauthCode: parsed.oauthCode ?? (typeof parsed.oauth_code === "string" ? parsed.oauth_code : undefined),
      };
      if (!auth.accessToken || !auth.qid || !auth.token || !Number.isFinite(auth.expiresAt)) return undefined;
      if (auth.oauthCode !== undefined && typeof auth.oauthCode !== "string") return undefined;
      return auth;
    } catch { return undefined; }
  }
}
