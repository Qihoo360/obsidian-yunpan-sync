import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ignored = new Set(["node_modules", ".git", "coverage", ".DS_Store", ".public-sync.json"]);
const forbidden = [new RegExp(["qihoo", "net"].join("[.]"), "i"), new RegExp([ ["wis", "git"].join(""), ["qa", "open"].join(""), ["qa", "web-\\d+"].join(""), ["qa", "-mcp"].join("") ].join("|"), "i"),
  /(?:https?:\/\/|ssh:\/\/)[^\s"'<>]*(?:\.corp\b|\.internal\b|\.local\b)/i,
  /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)/i];
function walk(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!prefix && ignored.has(entry.name)) continue;
    const path = join(directory, entry.name), name = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
    if (entry.isDirectory()) { walk(path, name + "/"); continue; }
    const text = readFileSync(path, "utf8");
    if (name !== "scripts/check-public.mjs" && forbidden.some((pattern) => pattern.test(text))) throw new Error(`Non-public content: ${name}`);
    if (name.startsWith("src/") && /DiagnosticSink|emitDiagnostic|logDiagnostic|showDiagnostics|exportDiagnostics|listLogs|\.database\.log\(|"qa"/.test(text)) throw new Error(`Removed feature returned: ${name}`);
  }
}
walk(".");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const manifest = read("manifest.json"), pkg = read("package.json"), lock = read("package-lock.json");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || [pkg.version, lock.version, lock.packages[""].version].some((v) => v !== manifest.version)) throw new Error("Version files disagree");
if (read("versions.json")[manifest.version] !== manifest.minAppVersion) throw new Error("Missing compatibility version");
if (pkg.license !== "MIT" || !readFileSync("LICENSE", "utf8").includes("360AI 云盘")) throw new Error("Missing license metadata");
for (const file of ["src/diagnostics.ts", "src/ui/diagnostics-modal.ts"]) if (existsSync(file)) throw new Error(`Removed module returned: ${file}`);
if (process.argv.includes("--release")) {
  const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice(6) ?? process.env.GITHUB_REF_NAME;
  if (tag !== manifest.version) throw new Error("Release tag must equal manifest version (without a v prefix)");
  for (const file of ["main.js", "manifest.json", "styles.css"]) if (!existsSync(file) || !lstatSync(file).isFile() || !lstatSync(file).size) throw new Error(`Missing release asset: ${file}`);
}
console.log(`Public content and version checks passed (${manifest.version}).`);
