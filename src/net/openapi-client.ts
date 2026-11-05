import { assertProductionOpenApiUrl } from "./production-url.js";
import { createSignedOpenApiParams } from "./signing.js";


export type OpenApiMethod =
  | "User.getUserDetail"
  | "User.getVersion"
  | "Enterprise.getListByUser"
  | "Incr.getBgsp"
  | "Incr.getGlobalNodes"
  | "Incr.getIncrGlobal"
  | "File.getList"
  | "File.mkdir"
  | "File.rename"
  | "File.move"
  | "File.syncRecycle"
  | "Sync.getUploadFileAddr"
  | "Sync.addFile"
  | "Sync.getDownloadInfo"
  | "Oauth.getAccessTokenByOauthCode";

const SIGNED_FIELDS: Record<OpenApiMethod, readonly string[]> = {
  "User.getUserDetail": ["qid", "method"],
  "User.getVersion": ["qid", "type", "method"],
  "Enterprise.getListByUser": ["qid", "cache_status", "method"],
  "Incr.getBgsp": ["qid", "method"],
  "Incr.getGlobalNodes": ["qid", "bgsp", "gsp", "count", "spnid", "method"],
  "Incr.getIncrGlobal": ["qid", "gsp", "count", "spnid", "uv", "method"],
  "File.getList": ["qid", "page", "page_size", "path", "method"],
  "File.mkdir": ["qid", "fname", "method"],
  "File.rename": ["qid", "src_name", "new_name", "method"],
  "File.move": ["qid", "src_name", "new_name", "method"],
  "File.syncRecycle": ["qid", "fname", "owner_qid", "method"],
  "Sync.getUploadFileAddr": ["fhash", "qid", "method", "fname", "fsize"],
  "Sync.addFile": ["qid", "tk", "is_createdir", "detail", "owner_qid", "method"],
  "Sync.getDownloadInfo": ["qid", "fpath", "nid", "feedback", "owner_qid", "method"],
  "Oauth.getAccessTokenByOauthCode": ["oauth_code", "method"],
};

export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  json: unknown;
  text?: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export class OpenApiError extends Error {
  constructor(message: string, readonly errno?: number, readonly traceId?: string, readonly status?: number) {
    super(message);
    this.name = "OpenApiError";
  }
}

interface OpenApiEnvelope<T> {
  errno: number;
  errmsg?: string;
  data?: T;
  trace_id?: string;
}

export interface OpenApiClientOptions {
  baseUrl: string;
  accessToken: () => string;
  qid: () => string;
  cloudToken?: () => string;
  accessTokenExpiresAt?: () => number;
  refreshAccessToken?: () => Promise<void>;
  signingSecret: () => string;
  transport: HttpTransport;
  retries?: number;
  
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class OpenApiClient {
  constructor(private readonly options: OpenApiClientOptions) {
    assertProductionOpenApiUrl(options.baseUrl);
  }

  async call<T>(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): Promise<T> {
    assertProductionOpenApiUrl(this.options.baseUrl);
    const retries = this.options.retries ?? 2;
    let transientAttempt = 0;
    let refreshed = false;
    const expiresAt = this.options.accessTokenExpiresAt?.() ?? 0;
    if (expiresAt > 0 && Date.now() >= expiresAt - 60_000 && this.options.refreshAccessToken) {
      await this.options.refreshAccessToken();
      refreshed = true;
    }
    while (true) {
      const startedAt = Date.now();
      let status: number | undefined;
      try {
        const request = this.createRequest(method, input);
        const response = await this.options.transport({
          url: request.url,
          method: "GET",
          headers: { "Access-Token": request.accessToken, Accept: "application/json" },
        });
        status = response.status;
        if (response.status === 401 && !refreshed && this.options.refreshAccessToken) {
          
          await this.options.refreshAccessToken();
          refreshed = true;
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          throw new OpenApiError(`OpenAPI temporary HTTP error ${response.status}`, undefined, undefined, response.status);
        }
        if (response.status < 200 || response.status >= 300) {
          throw new OpenApiError(`OpenAPI HTTP error ${response.status}`, undefined, undefined, response.status);
        }
        const envelope = response.json as OpenApiEnvelope<T>;
        if (!envelope || typeof envelope.errno !== "number") throw new OpenApiError("Invalid OpenAPI response");
        if (envelope.errno !== 0) {
          throw new OpenApiError(envelope.errmsg || `OpenAPI error ${envelope.errno}`, envelope.errno, envelope.trace_id);
        }
        
        return envelope.data as T;
      } catch (error) {
        const retryable = error instanceof OpenApiError && (error.status === 429 || (error.status ?? 0) >= 500);
        const traceId = error instanceof OpenApiError ? error.traceId : undefined;
        const errno = error instanceof OpenApiError ? error.errno : undefined;
        const errorStatus = error instanceof OpenApiError ? error.status ?? status : status;
        const terminal = !retryable || transientAttempt === retries;
        const retryInMs = terminal ? undefined : 250 * 2 ** transientAttempt;
        
        if (terminal) throw error;
        await delay(retryInMs!);
        transientAttempt++;
      }
    }
  }

  private createRequest(method: OpenApiMethod, input: Record<string, string | number | boolean | null | undefined>): { url: string; accessToken: string } {
    const accessToken = this.options.accessToken();
    const qid = this.options.qid();
    if (!accessToken) throw new OpenApiError("Missing OAuth access token");
    if (method !== "Oauth.getAccessTokenByOauthCode" && !qid) throw new OpenApiError("Missing qid");

    const source: Record<string, string> = { method, access_token: accessToken, qid, sub_channel: "" };
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) source[key] = String(value);
    }
    if (method === "Sync.getUploadFileAddr") {
      const cloudToken = this.options.cloudToken?.() ?? "";
      if (!cloudToken) throw new OpenApiError("Missing cloud token");
      source.token = cloudToken;
      source.devtype = "ecs_openapi";
    }
    const signInput: Record<string, string> = { access_token: accessToken };
    for (const field of SIGNED_FIELDS[method]) signInput[field] = source[field] ?? "";
    const signed = createSignedOpenApiParams(signInput, this.options.signingSecret());
    const query = new URLSearchParams({ ...source, sign: signed.sign! });
    return { url: `${this.options.baseUrl}?${query.toString()}`, accessToken };
  }
}
