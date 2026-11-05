import { requestUrl, type RequestUrlParam } from "obsidian";
import type { CloudAuth } from "./secrets.js";
import { exchangeOAuthCode } from "./oauth.js";

export const MOBILE_REDIRECT_URI = "obsidian://yunpan-sync";
export const MOBILE_PENDING_MAX_AGE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface MobilePendingOAuth {
  state: string;
  verifier: string;
  clientId: string;
  createdAt: number;
  issuer: string;
}

interface AuthorizationServerMetadata {
  authorization_endpoint?: string;
  registration_endpoint?: string;
}

function mobileBaseUrl(_environment: "production"): string {
  return "https://mcp.yunpan.com";
}

export function mobileIssuer(environment: "production"): string {
  return mobileBaseUrl(environment);
}

function randomBytes(size: number): Uint8Array {
  if (typeof crypto?.getRandomValues !== "function") throw new Error("当前环境不支持安全随机数");
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(size = 32): string { return base64Url(randomBytes(size)); }

async function challenge(verifier: string): Promise<string> {
  if (!crypto?.subtle) throw new Error("当前环境不支持 PKCE");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function json(response: { status: number; json: unknown }, stage = "OAuth 服务请求"): Record<string, unknown> {
  if (response.status < 200 || response.status >= 300) throw new Error(`${stage}失败（HTTP ${response.status}）`);
  let value: unknown;
  try { value = response.json; } catch { throw new Error(`${stage}失败：服务未返回有效 JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${stage}失败：服务未返回有效 JSON`);
  return value as Record<string, unknown>;
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export class MobileOAuth {
  private readonly issuer: string;

  constructor(private readonly environment: "production", private readonly openApiUrl: string,
    private readonly reportProgress?: (message: string) => void) {
    this.issuer = mobileIssuer(environment);
  }

  private endpoint(value: unknown, fallback: string): string {
    if (typeof value !== "string") return `${this.issuer}${fallback}`;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("OAuth 服务返回了不受信任的地址"); }
    if (url.origin !== this.issuer || url.username || url.password || url.hash) {
      throw new Error("OAuth 服务返回了不受信任的地址");
    }
    return url.toString();
  }

  private async step<T>(stage: string, operation: () => PromiseLike<T>): Promise<T> {
    this.reportProgress?.(`正在${stage}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${stage}超时，请检查 Obsidian 的网络权限后重试`)), REQUEST_TIMEOUT_MS);
    });
    try { return await Promise.race([operation(), timeout]); }
    finally { clearTimeout(timer); }
  }

  private async request(stage: string, options: RequestUrlParam): Promise<Record<string, unknown>> {
    const response = await this.step(stage, async () => {
      try { return await requestUrl(options); }
      catch (error) { throw new Error(`${stage}失败：网络请求异常，请检查 Obsidian 的网络权限`, { cause: error }); }
    });
    return json(response, stage);
  }

  async start(openBrowser: (url: string) => void): Promise<MobilePendingOAuth> {
    const metadata = await this.request("读取授权配置", {
      url: `${this.issuer}/.well-known/oauth-authorization-server`,
      method: "GET",
      headers: { Accept: "application/json" },
      throw: false,
    }) as AuthorizationServerMetadata;
    const authorizationEndpoint = this.endpoint(metadata.authorization_endpoint, "/authorize");
    const registrationEndpoint = this.endpoint(metadata.registration_endpoint, "/register");

    const registered = await this.request("注册授权客户端", {
      url: registrationEndpoint,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Obsidian 360AI 云盘",
        redirect_uris: [MOBILE_REDIRECT_URI],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "none",
      }),
      throw: false,
    });
    const clientId = typeof registered.client_id === "string" ? registered.client_id : "";
    if (!clientId) throw new Error("OAuth 客户端注册失败");

    const state = randomToken(24);
    const verifier = randomToken(32);
    const authorization = new URL(authorizationEndpoint);
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", MOBILE_REDIRECT_URI);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("login_surface", "mobile");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", await this.step("准备安全授权", () => challenge(verifier)));
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("scope", "cloud:read cloud:write");
    const pending = { state, verifier, clientId, createdAt: Date.now(), issuer: this.issuer };
    this.reportProgress?.("正在打开浏览器授权");
    openBrowser(authorization.toString());
    return pending;
  }

  async complete(params: { action?: string; code?: string; state?: string; error?: string }, pending: MobilePendingOAuth): Promise<CloudAuth> {
    if (params.action && params.action !== "yunpan-sync") throw new Error("OAuth 回调协议不匹配");
    if (pending.issuer !== this.issuer) throw new Error("OAuth 环境已切换，请重新登录");
    if (Date.now() - pending.createdAt > MOBILE_PENDING_MAX_AGE_MS) throw new Error("OAuth 授权已超时");
    if (!params.state || params.state !== pending.state) throw new Error("OAuth state 校验失败");
    if (params.error) throw new Error("OAuth 授权被取消");
    if (!params.code) throw new Error("OAuth 回调缺少授权码");
    const response = await requestUrl({
      url: `${pending.issuer}/oauth/360/mobile-exchange`,
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ client_id: pending.clientId, code: params.code, redirect_uri: MOBILE_REDIRECT_URI, code_verifier: pending.verifier }),
      throw: false,
    });
    const exchanged = json(response);
    const oauthCode = typeof exchanged.oauth_code === "string" ? exchanged.oauth_code : "";
    if (!oauthCode) throw new Error("OAuth 授权已失效");
    return exchangeOAuthCode(this.openApiUrl, oauthCode);
  }
}
