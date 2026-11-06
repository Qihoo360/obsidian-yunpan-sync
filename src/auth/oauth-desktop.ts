import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudAuth } from "./secrets.js";
import { exchangeOAuthCode } from "./oauth.js";
import { loginCancelledError, withLoginCancellation } from "./cancellation.js";

type DesktopHttp = typeof import("node:http");

function loadNodeHttp(): DesktopHttp {
  const moduleName = ["node", "http"].join(String.fromCharCode(58));
  const load = Function(`return typeof require === 'function' ? require('${moduleName}') : undefined`)() as DesktopHttp | undefined;
  if (!load) throw new Error("当前环境不支持桌面 OAuth 回调服务");
  return load;
}

function randomState(): string {
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("当前环境不支持安全随机数");
}

function callbackPage(response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>360AI云盘登录成功</title><h2>授权成功</h2><p>可以关闭此页面并返回 Obsidian。</p>");
}

async function readParams(request: IncomingMessage): Promise<URLSearchParams> {
  if (request.method === "GET") return new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 64 * 1024) throw new Error("OAuth callback body too large");
  }
  return new URLSearchParams(body);
}

export class DesktopOAuth {
  constructor(private readonly environment: "production", private readonly openApiUrl: string) {}

  async login(openBrowser: (url: string) => void, timeoutMs = 180_000, signal?: AbortSignal): Promise<CloudAuth> {
    if (signal?.aborted) throw loginCancelledError();
    const state = randomState();
    const { createServer } = loadNodeHttp();
    const oauthCode = await new Promise<string>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      let server: ReturnType<typeof createServer>;
      const finish = (error?: Error, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        server.removeListener("error", onError);
        server.close();
        if (error) server.closeAllConnections();
        error ? reject(error) : resolve(code!);
      };
      const cancel = () => finish(loginCancelledError());
      const onError = (error: Error) => finish(error);
      server = createServer(async (request, response) => {
        if (settled || signal?.aborted) { response.writeHead(410); response.end(); return; }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!((request.method === "POST" && url.pathname === "/authorize/decision") || (request.method === "GET" && url.pathname === "/oauth/callback"))) {
          response.writeHead(404); response.end(); return;
        }
        try {
          const params = await readParams(request);
          if (settled || signal?.aborted) { response.writeHead(410); response.end(); return; }
          if (params.get("state") !== state) {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("OAuth state 校验失败");
            return;
          }
          const code = params.get("oauth_code") ?? params.get("code");
          if (!code) throw new Error(params.get("errmsg") ?? "OAuth 回调缺少 oauth_code");
          callbackPage(response);
          finish(undefined, code);
        } catch (error) {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : String(error));
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      timer = setTimeout(() => finish(new Error("等待云盘 OAuth 授权超时")), timeoutMs);
      server.once("error", onError);
      signal?.addEventListener("abort", cancel, { once: true });
      server.listen(0, "127.0.0.1", () => {
        if (settled || signal?.aborted) { server.close(); return; }
        const address = server.address();
        if (!address || typeof address === "string") return finish(new Error("无法启动 OAuth 回调服务"));
        const callback = `http://127.0.0.1:${address.port}/authorize/decision`;
        const authorize = new URL("https://yunpan.com/index/oauthCode");
        authorize.searchParams.set("decision_url", callback);
        authorize.searchParams.set("state", state);
        try { openBrowser(authorize.toString()); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    return withLoginCancellation(() => exchangeOAuthCode(this.openApiUrl, oauthCode), signal);
  }

  exchange(oauthCode: string): Promise<CloudAuth> {
    return exchangeOAuthCode(this.openApiUrl, oauthCode);
  }
}
