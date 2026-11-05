import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("community release packaging", () => {
  it("uses the community-compatible plugin id", () => {
    const manifest = JSON.parse(readProjectFile("manifest.json")) as { id?: string };

    expect(manifest.id).toBe("yunpan-sync");
  });

  it("embeds sql.js WebAssembly into main.js", () => {
    const build = readProjectFile("esbuild.config.mjs");
    const persistence = readProjectFile("src/storage/persistence.ts");

    expect(build).toContain('".wasm": "binary"');
    expect(build).not.toContain("copyFile");
    expect(persistence).toContain('import sqlWasmBinary from "sql.js/dist/sql-wasm.wasm"');
    expect(persistence).toContain("initSqlJs({ wasmBinary: arrayBuffer(sqlWasmBinary) })");
    expect(persistence).not.toContain("readBinary(wasmPath)");
  });

  

  

  

  it("builds a mobile-loadable browser bundle without static Node-only imports", () => {
    const manifest = JSON.parse(readProjectFile("manifest.json")) as { isDesktopOnly?: boolean };
    const build = readProjectFile("esbuild.config.mjs");
    const main = readProjectFile("src/main.ts");
    const store = readProjectFile("src/transfer/store-client.ts");

    expect(manifest.isDesktopOnly).toBeUndefined();
    expect(build).toContain('platform: "browser"');
    expect(build).toContain('define: { process: "undefined" }');
    expect(main).not.toContain('from "./auth/oauth-desktop.js"');
    expect(main).toContain('import("./auth/oauth-desktop.js")');
    expect(store).not.toContain('from "node:crypto"');
  });
});
