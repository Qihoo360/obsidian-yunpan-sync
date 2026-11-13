import { requestUrl, type RequestUrlParam } from "obsidian";

export const RADAR_APP_KEY = "f6853fec56d04cfe940a974817cebc79";
export const RADAR_CLIENT_CHANNEL = "obsidian";
const RADAR_URL = "https://ps.s.360.cn/pstat/plog.php";
const TELEMETRY_DEFER_MS = 100;
const TELEMETRY_TIMEOUT_MS = 8_000;

export interface RadarCommonProperties {
  eid?: string;
  qid?: string;
  curPkg?: string;
  vipStatus?: string;
  registerSrc?: string;
  channel?: string;
  subchannel?: string;
  channelType?: string;
  clientChannel?: string;
  devName?: string;
  devID?: string;
}

export interface RadarContext {
  appName: string;
  appVersion: string;
  deviceId: string;
  deviceName: string;
  common: RadarCommonProperties;
  os: string;
  osVersion?: string;
  language?: string;
  country?: string;
  screen?: string;
}

export interface RadarRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  throw: false;
}

export type RadarTransport = (request: RadarRequest) => Promise<{ status: number }>;

export interface RadarEvent {
  time: number;
  key: string;
  acc: number;
  seg?: Record<string, string | number>;
}

export interface RadarPayload {
  event: RadarEvent[];
  header: {
    k: string;
    ch: string;
    n: string;
    la: string;
    co: string;
    os: string;
    ct: number;
    ov: string;
    m2: string;
    vn: string;
    sc: string;
    ext: Record<string, string | number>;
  };
}

function text(value: string | undefined): string { return value?.trim() ?? ""; }

/** Radar requires a 32-character device identifier. Keep the stored ID intact
 * for the public devID property and only normalize the protocol field. */
export function radarDeviceId(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return compact.slice(0, 32).padEnd(32, "0");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function gzipBase64(value: string): Promise<string> {
  if (typeof CompressionStream !== "function") throw new Error("gzip is unavailable");
  const stream = new CompressionStream("gzip");
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(value));
  await writer.close();
  return base64(new Uint8Array(await output));
}

export function createRadarPayload(context: RadarContext, event: RadarEvent): RadarPayload {
  const common = context.common;
  const ext: Record<string, string | number> = {
    eid: text(common.eid),
    qid: text(common.qid),
    curPkg: text(common.curPkg),
    vipStatus: text(common.vipStatus),
    registerSrc: text(common.registerSrc),
    channel: text(common.channel),
    subchannel: text(common.subchannel),
    channelType: text(common.channelType),
    clientChannel: RADAR_CLIENT_CHANNEL,
    devName: text(common.devName ?? context.deviceName),
    devID: text(common.devID ?? context.deviceId),
    timezone: String(-new Date().getTimezoneOffset() / 60),
  };
  return {
    event: [event],
    header: {
      k: RADAR_APP_KEY,
      ch: RADAR_CLIENT_CHANNEL,
      n: context.appName,
      la: text(context.language || (typeof navigator !== "undefined" ? navigator.language : "zh-CN")),
      co: text(context.country || "CN"),
      os: context.os,
      ct: Date.now(),
      ov: text(context.osVersion),
      m2: radarDeviceId(context.deviceId),
      vn: context.appVersion,
      sc: text(context.screen || (typeof screen !== "undefined" ? `${screen.width}x${screen.height}` : "0x0")),
      ext,
    },
  };
}

export class RadarAnalytics {
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly context: () => RadarContext,
    private readonly transport: RadarTransport = async (request) => {
      const response = await requestUrl(request as RequestUrlParam);
      return { status: response.status };
    },
    private readonly enabled = true,
  ) {}

  track(key: string, seg?: Record<string, string | number>): Promise<void> {
    if (this.disposed || !this.enabled) return Promise.resolve();
    this.queue = this.queue.then(async () => {
      const event = { time: Date.now(), key, acc: 1, ...(seg ? { seg } : {}) };
      try {
        // Let the host interaction finish before a telemetry request starts.
        // This also keeps click handlers independent from network scheduling.
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, TELEMETRY_DEFER_MS);
          this.timers.add(timer);
        });
        if (this.disposed) return;
        const payload = createRadarPayload(this.context(), event);
        const holder = await gzipBase64(JSON.stringify(payload));
        // Match the working ecs_openapi_v2 RadarProxy wire format: raw Base64,
        // without form URL encoding.
        const body = `p=cssdk&content=${holder}`;
        const response = await this.sendWithTimeout({
          url: RADAR_URL,
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body,
          throw: false,
        });
        if (response.status < 200 || response.status >= 300) return;
      } catch {
        // Telemetry must never affect the host plugin's business flows.
      }
    });
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private async sendWithTimeout(request: RadarRequest): Promise<{ status: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("telemetry timeout")), TELEMETRY_TIMEOUT_MS);
      this.timers.add(timer);
    });
    try {
      return await Promise.race([this.transport(request), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }
  }

}
