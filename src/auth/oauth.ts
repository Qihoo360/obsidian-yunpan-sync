import { assertProductionOpenApiUrl } from "../net/production-url.js";
import { requestUrl } from "obsidian";
import type { CloudAuth } from "./secrets.js";

interface OAuthEnvelope {
  errno: number;
  errmsg?: string;
  data?: { access_token?: string; qid?: string | number; token?: string; access_token_expire?: number };
  trace_id?: string;
}

export class OauthCodeExpiredError extends Error {
  constructor(message: string, readonly errno = 311, readonly traceId?: string) {
    super(message);
    this.name = "OauthCodeExpiredError";
  }
}

export async function exchangeOAuthCode(openApiUrl: string, oauthCode: string): Promise<CloudAuth> {
  const url = assertProductionOpenApiUrl(openApiUrl);
  url.searchParams.set("method", "Oauth.getAccessTokenByOauthCode");
  url.searchParams.set("oauth_code", oauthCode);
  url.searchParams.set("client_env", "obsidian");
  url.searchParams.set("client_src", "obsidian-yunpan-sync");
  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("sub_channel", "");
  const response = await requestUrl({ url: url.toString(), method: "GET", headers: { Accept: "application/json" }, throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(`OAuth token exchange failed: HTTP ${response.status}`);
  const envelope = response.json as OAuthEnvelope;
  if (envelope.errno === 311) {
    throw new OauthCodeExpiredError(envelope.errmsg || "OAuth 授权已失效", envelope.errno, envelope.trace_id);
  }
  if (envelope.errno !== 0 || !envelope.data?.access_token || !envelope.data.qid || !envelope.data.token) {
    throw new Error(`${envelope.errmsg || "OAuth token exchange failed"}${envelope.trace_id ? ` (trace_id: ${envelope.trace_id})` : ""}`);
  }
  const expiry = Number(envelope.data.access_token_expire ?? 3600);
  const now = Date.now();
  const expiresAt = expiry > 1_000_000_000_000 ? expiry : expiry > now / 1000 ? expiry * 1000 : now + expiry * 1000;
  return { accessToken: envelope.data.access_token, qid: String(envelope.data.qid), token: envelope.data.token, expiresAt, oauthCode };
}
