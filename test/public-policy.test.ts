import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { requestUrl } from "./obsidian.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings.js";
import { OpenApiClient } from "../src/net/openapi-client.js";
import { exchangeOAuthCode } from "../src/auth/oauth.js";
import { assertStoreUrl } from "../src/net/store-url.js";
import { productLinks } from "../src/ui/product-links.js";
import { SyncDatabase } from "../src/storage/database.js";

describe("public production policy", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("ignores persisted service overrides and always starts on production", () => {
    expect(DEFAULT_SETTINGS.environment).toBe("production");
    expect(normalizeSettings({ environment: "legacy" as never, openapiBaseUrl: "https://invalid.example" }))
      .toMatchObject({ environment: "production", openapiBaseUrl: "https://openapi.eyun.360.cn/intf.php" });
    expect(productLinks("production").renewal).toBe("https://www.yunpan.com/file/index?default_show_renew=1");
  });
  it("rejects unapproved OAuth and API URLs before sending credentials", async () => {
    for (const baseUrl of ["https://invalid.example/intf.php", "https://u:p@openapi.eyun.360.cn/intf.php",
      "https://openapi.eyun.360.cn/other", "https://openapi.eyun.360.cn:444/intf.php",
      "https://openapi.eyun.360.cn/intf.php?redirect=elsewhere"]) {
      expect(() => new OpenApiClient({ baseUrl, accessToken: () => "token", qid: () => "1",
        signingSecret: () => "public-protocol-value", transport: vi.fn() })).toThrow();
      await expect(exchangeOAuthCode(baseUrl, "code")).rejects.toThrow();
    }
    expect(requestUrl).not.toHaveBeenCalled();
    expect(() => assertStoreUrl("https://qa2dl117" + ".yunpan.360.cn/intf.php")).toThrow();
    expect(() => assertStoreUrl("https://staging-store" + ".yunpan.com/intf.php")).toThrow();
  });
  it("migrates the last successful time then removes old log storage", async () => {
    const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
    const raw = new SQL.Database();
    raw.run("CREATE TABLE logs (id INTEGER PRIMARY KEY, at INTEGER, level TEXT, phase TEXT, message TEXT, trace_id TEXT, details TEXT)");
    raw.run("INSERT INTO logs(at,level,phase,message) VALUES(100,'info','idle','同步完成'),(200,'error','error','failed'),(150,'info','idle','已是最新')");
    const database = new SyncDatabase(raw);
    expect(database.getLastSuccessfulSync()).toBe(150);
    expect(raw.exec("SELECT name FROM sqlite_master WHERE name='logs'")).toEqual([]);
    expect("log" in database).toBe(false);
    database.setLastSuccessfulSync(300);
    const restored = new SyncDatabase(new SQL.Database(database.export()));
    expect(restored.getLastSuccessfulSync()).toBe(300);
  });
  it("has no environment selector or diagnostic commands and modules", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).not.toContain('setName("环境")');
    expect(main).not.toContain("showDiagnostics");
    expect(main).not.toContain("logDiagnostic");
  });
});
