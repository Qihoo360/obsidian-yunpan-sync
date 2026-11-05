import esbuild from "esbuild";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", "fs", "path", "crypto", "node:*"],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  loader: { ".wasm": "binary" },
  // sql.js selects its Node loader when it sees a global process object. Obsidian's
  // mobile WebView has no Node loader, so force the browser branch in the bundle.
  define: { process: "undefined" },
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
