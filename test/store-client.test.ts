import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "./obsidian.js";

import { StoreClient } from "../src/transfer/store-client.js";

const client = () => new StoreClient("https://up1.yunpan.360.cn/intf.php", {
  qid: "123",
  token: "token-value",
}, {
  deviceId: "device-1",
  deviceName: "QA-A",
});

function expectedSign(method: string): string {
  const source = [
    "devid=device-1",
    "devname=QA-A",
    "devtype=ecs_openapi",
    `method=${method}`,
    "qid=123",
    "rtick=1700000000000",
    "v=0.1.0",
  ].join("");
  return createHash("md5").update(`${source}243dcc291a9d8f31e21c9c580cfdce64`, "utf8").digest("hex");
}

describe("StoreClient common protocol fields", () => {
  beforeEach(() => {
    requestUrl.mockReset();
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  it("signs multipart Store requests with stable client metadata", async () => {
    requestUrl.mockResolvedValue({ status: 200, text: '{"errno":0,"data":{"tk":"ok"}}' });

    await client().callJson("Upload.uploadFile", { fname: "a.md" }, new Uint8Array([1, 2]));

    const request = requestUrl.mock.calls[0]?.[0] as { body: ArrayBuffer };
    const body = new TextDecoder().decode(request.body);
    for (const [name, value] of Object.entries({
      devtype: "ecs_openapi",
      v: "0.1.0",
      devid: "device-1",
      devname: "QA-A",
      rtick: "1700000000000",
      sign: expectedSign("Upload.uploadFile"),
    })) {
      expect(body).toContain(`name="${name}"\r\n\r\n${value}\r\n`);
    }
  });

  it("signs download URLs with the same client metadata", async () => {
    requestUrl.mockResolvedValue({ status: 200, arrayBuffer: new ArrayBuffer(0) });

    await client().download("Download.downloadBlockV2", { dt: "download-ticket" });

    const request = requestUrl.mock.calls[0]?.[0] as { url: string };
    const url = new URL(request.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      devtype: "ecs_openapi",
      v: "0.1.0",
      devid: "device-1",
      devname: "QA-A",
      rtick: "1700000000000",
      sign: expectedSign("Download.downloadBlockV2"),
    });
  });

  
});
