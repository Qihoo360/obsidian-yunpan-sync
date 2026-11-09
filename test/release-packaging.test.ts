import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProjectFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("community release packaging", () => {
  it("advertises the compiled API baseline for the new release and preserves historical requirements", () => {
    const manifest = JSON.parse(readProjectFile("manifest.json"));
    const pkg = JSON.parse(readProjectFile("package.json"));
    const versions = JSON.parse(readProjectFile("versions.json"));
    expect(manifest.minAppVersion).toBe("1.11.4");
    expect(pkg.devDependencies.obsidian).toBe(manifest.minAppVersion);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
    expect(versions["1.0.3"]).toBe("1.14.4");
    expect(manifest.isDesktopOnly).toBe(false);
  });
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

    expect(manifest.isDesktopOnly).toBe(false);
    expect(build).toContain('platform: "browser"');
    expect(build).toContain('define: { process: "undefined" }');
    expect(main).not.toContain('from "./auth/oauth-desktop.js"');
    expect(main).toContain('import("./auth/oauth-desktop.js")');
    expect(store).not.toContain('from "node:crypto"');
  });
});
