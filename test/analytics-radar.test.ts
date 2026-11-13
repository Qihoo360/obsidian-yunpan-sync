import { describe, expect, it, vi } from "vitest";
import { createRadarPayload, RadarAnalytics, RADAR_APP_KEY, RADAR_CLIENT_CHANNEL, radarDeviceId, type RadarRequest } from "../src/analytics/radar.js";

const context = {
  appName: "360AI Cloud Sync",
  appVersion: "1.0.8",
  deviceId: "12345678-1234-1234-1234-123456789abc",
  deviceName: "Obsidian",
  os: "macos",
  common: {
    eid: "eid-1", qid: "qid-1", curPkg: "210", vipStatus: "true",
    registerSrc: "src", channel: "channel", subchannel: "sub", channelType: "type",
    devName: "Obsidian", devID: "12345678-1234-1234-1234-123456789abc",
  },
};

async function decodeBody(body: string): Promise<Record<string, unknown>> {
  // Radar's working server implementation appends raw Base64. A form parser
  // would turn its '+' characters into spaces and corrupt the compressed data.
  const encoded = body.match(/^p=cssdk&content=([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encoded) throw new Error("missing content");
  const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  const stream = new DecompressionStream("gzip");
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  return JSON.parse(new TextDecoder().decode(await output)) as Record<string, unknown>;
}

describe("Radar analytics", () => {
  it("builds the shared header with the Obsidian client channel", () => {
    const payload = createRadarPayload(context, { time: 1, key: "obPlugin_start", acc: 1 });
    expect(RADAR_CLIENT_CHANNEL).toBe("obsidian");
    expect(payload.header.k).toBe(RADAR_APP_KEY);
    expect(payload.header.ch).toBe(RADAR_CLIENT_CHANNEL);
    expect(payload.header.m2).toBe(radarDeviceId(context.deviceId));
    expect(payload.header.m2).toHaveLength(32);
    expect(payload.header.ext).toMatchObject({
      eid: "eid-1", qid: "qid-1", curPkg: "210", vipStatus: "true",
      clientChannel: RADAR_CLIENT_CHANNEL, devID: context.deviceId,
    });
    expect(payload.header.ext.clientChannel).toBe("obsidian");
    expect(typeof payload.header.ext.timezone).toBe("string");
  });

  it("matches the working OpenAPI POST protocol and preserves UTF-8 event attributes", async () => {
    const requests: RadarRequest[] = [];
    const analytics = new RadarAnalytics(() => context, async request => {
      requests.push(request);
      return { status: 200 };
    });
    await analytics.track("obPlugin_sync_result", { syncType: "manual", failFileNum: "1", failReason: "网络连接异常" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://ps.s.360.cn/pstat/plog.php",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const payload = await decodeBody(requests[0]!.body);
    expect(payload.event).toEqual([{ time: expect.any(Number), key: "obPlugin_sync_result", acc: 1,
      seg: { syncType: "manual", failFileNum: "1", failReason: "网络连接异常" } }]);
  });

  it("serializes events in order and swallows transport failures", async () => {
    const order: string[] = [];
    const transport = vi.fn(async (request: { body: string }) => {
      const payload = await decodeBody(request.body);
      order.push(String((payload.event as Array<{ key: string }>)[0]!.key));
      if (order.length === 1) throw new Error("offline");
      return { status: 204 };
    });
    const analytics = new RadarAnalytics(() => context, transport);
    await expect(Promise.all([
      analytics.track("obPlugin_install"),
      analytics.track("obPlugin_start"),
      analytics.track("obPlugin_login_click"),
    ])).resolves.toEqual([undefined, undefined, undefined]);
    expect(order).toEqual(["obPlugin_install", "obPlugin_start", "obPlugin_login_click"]);
  });
});
