import { assertStoreUrl } from "../net/store-url.js";
import { md5 } from "../net/signing.js";
import { requestUrl } from "obsidian";
import { OpenApiError } from "../net/openapi-client.js";


export interface StoreRange { start: number; end: number }

export interface StoreClientLike {
  callJson(method: string, params: Record<string, unknown>, file?: Uint8Array): Promise<Record<string, unknown>>;
  download(method: string, params: Record<string, unknown>, range?: StoreRange): Promise<Uint8Array>;
}

export interface StoreCredentials { qid: string; token: string }
export interface StoreClientMetadata { deviceId: string; deviceName: string; version?: string }

// Store validates this against the devtype embedded by ecs_openapi_v2 in upload tickets.
const STORE_DEVICE_TYPE = "ecs_openapi";
const STORE_CLIENT_VERSION = "0.1.0";
const STORE_SIGNATURE_SALT = "243dcc291a9d8f31e21c9c580cfdce64";

function storeProtocolFields(method: string, qid: string, metadata: StoreClientMetadata): Record<string, string> {
  const fields: Record<string, string> = {
    method,
    qid,
    devtype: STORE_DEVICE_TYPE,
    v: metadata.version ?? STORE_CLIENT_VERSION,
    devid: metadata.deviceId,
    devname: metadata.deviceName,
    rtick: String(Date.now()),
  };
  const source = Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("");
  return {
    ...fields,
    sign: md5(`${source}${STORE_SIGNATURE_SALT}`),
  };
}

function multipart(values: Record<string, unknown>, file?: Uint8Array): { body: ArrayBuffer; contentType: string } {
  const boundary = `----obsidian-yunpan-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n`));
  }
  if (file) {
    chunks.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(file);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return { body: output.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

export class StoreClient implements StoreClientLike {
  private readonly endpoint: URL;

  constructor(endpoint: string, private readonly credentials: StoreCredentials,
    private readonly metadata: StoreClientMetadata) {
    this.endpoint = assertStoreUrl(endpoint);
  }

  async callJson(method: string, params: Record<string, unknown>, file?: Uint8Array): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const common = storeProtocolFields(method, this.credentials.qid, this.metadata);
    const values = { ...params, ...common, token: this.credentials.token, ofmt: "json" };
    const encoded = multipart(values, file);
    let status: number | undefined;
    try {
      const response = await requestUrl({ url: this.endpoint.toString(), method: "POST",
        headers: { "Content-Type": encoded.contentType, Accept: "application/json" }, body: encoded.body, throw: false });
      status = response.status;
      const text = response.text;
      if (response.status < 200 || response.status >= 300) throw new Error(`Store ${method} failed: HTTP ${response.status}`);
      let envelope: { errno?: number; errmsg?: string; data?: Record<string, unknown> };
      try { envelope = JSON.parse(text) as typeof envelope; } catch { throw new Error(`Store ${method} returned invalid JSON`); }
      if (Number(envelope.errno ?? 0) !== 0) throw new OpenApiError(envelope.errmsg || `Store ${method} error ${envelope.errno}`, Number(envelope.errno));
      
      return envelope.data ?? envelope as Record<string, unknown>;
    } catch (error) {
      
      throw error;
    }
  }

  async download(method: string, params: Record<string, unknown>, range?: StoreRange): Promise<Uint8Array> {
    const startedAt = Date.now();
    const url = new URL(this.endpoint);
    const common = storeProtocolFields(method, this.credentials.qid, this.metadata);
    const values = { ...params, ...common, token: this.credentials.token };
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    let status: number | undefined;
    try {
      const response = await requestUrl({ url: url.toString(), method: "GET", headers, throw: false });
      status = response.status;
      if ((response.status < 200 || response.status >= 300) && response.status !== 206) throw new Error(`Store ${method} failed: HTTP ${response.status}`);
      const bytes = new Uint8Array(response.arrayBuffer);
      if (range && bytes.length !== range.end - range.start + 1) throw new Error(`Store ${method} returned an invalid range length`);
      
      return bytes;
    } catch (error) {
      
      throw error;
    }
  }
}
