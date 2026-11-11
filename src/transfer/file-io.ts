import { Platform, type DataAdapter } from "obsidian";
import { normalizeVaultPath } from "../domain/paths.js";

export interface BinarySource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export interface BinarySink {
  write(bytes: Uint8Array): Promise<void>;
}

export function memorySource(bytes: Uint8Array): BinarySource {
  return { size: bytes.byteLength, read: async (offset, length) => bytes.subarray(offset, offset + length),
    assertUnchanged: async () => undefined, close: async () => undefined };
}

type NodeFileSystem = typeof import("node:fs/promises");
type NodePath = typeof import("node:path");

interface NodeModules {
  fs: NodeFileSystem;
  paths: NodePath;
}

/**
 * Obsidian desktop plugins run in a CommonJS Electron wrapper.  Loading these
 * modules with a dynamic `import("node:...")` makes the WebView try to fetch
 * them as browser modules and triggers an app:// CORS error.  Keep the
 * CommonJS path for the real plugin and retain an ESM fallback for tests and
 * other non-Electron callers.
 */
let nodeModules: Promise<NodeModules> | undefined;
function loadNodeModules(): Promise<NodeModules> {
  if (nodeModules) return nodeModules;
  const commonJsRequire = (globalThis as typeof globalThis & {
    require?: (id: string) => unknown;
  }).require ?? (typeof require === "function" ? require : undefined);
  if (commonJsRequire) {
    nodeModules = Promise.resolve({
      fs: commonJsRequire("fs/promises") as NodeFileSystem,
      paths: commonJsRequire("path") as NodePath,
    });
  } else {
    // Vitest executes this source as ESM. This branch is never used by the
    // bundled desktop plugin, but keeps the file directly testable.
    nodeModules = Promise.all([import("node:fs/promises"), import("node:path")])
      .then(([fs, paths]) => ({ fs, paths }));
  }
  return nodeModules;
}

/** Node is loaded only on desktop, and never by the mobile adapter. */
async function desktopPath(adapter: DataAdapter, path: string): Promise<string | undefined> {
  const getBasePath = (adapter as DataAdapter & { getBasePath?: () => string }).getBasePath;
  if (!Platform.isDesktopApp || !getBasePath) return undefined;
  const { fs, paths } = await loadNodeModules();
  const root = await fs.realpath(getBasePath.call(adapter));
  const candidate = paths.resolve(root, normalizeVaultPath(path));
  const parent = await fs.realpath(paths.dirname(candidate));
  const relative = paths.relative(root, parent);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    throw new Error("File path escapes the vault root");
  }
  return paths.join(parent, paths.basename(candidate));
}

export async function openDesktopSource(adapter: DataAdapter, path: string): Promise<BinarySource | undefined> {
  const target = await desktopPath(adapter, path);
  if (!target) return undefined;
  const { fs, paths } = await loadNodeModules();
  const root = await fs.realpath((adapter as DataAdapter & { getBasePath(): string }).getBasePath());
  const relative = paths.relative(root, await fs.realpath(target));
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new Error("File path escapes the vault root");
  const handle = await fs.open(target, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Not a file: ${path}`);
    const assertUnchanged = async () => {
      const current = await fs.stat(target);
      if (current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || current.ino !== before.ino) {
        throw new Error(`Local file changed while reading: ${path}`);
      }
    };
    return { size: before.size, assertUnchanged, close: () => handle.close(),
      read: async (offset, length) => {
        const bytes = new Uint8Array(length);
        let read = 0;
        while (read < length) {
          const result = await handle.read(bytes, read, length - read, offset + read);
          if (!result.bytesRead) throw new Error(`Local file changed while reading: ${path}`);
          read += result.bytesRead;
        }
        return bytes;
      } };
  } catch (error) { await handle.close(); throw error; }
}

export async function openDesktopSink(adapter: DataAdapter, path: string): Promise<(BinarySink & { close(mtime?: number): Promise<void> }) | undefined> {
  const target = await desktopPath(adapter, path);
  if (!target) return undefined;
  const { fs } = await loadNodeModules();
  const handle = await fs.open(target, "wx");
  let closed = false;
  return { write: async bytes => {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset);
      if (!result.bytesWritten) throw new Error("Unable to write download block");
      offset += result.bytesWritten;
    }
  }, close: async mtime => {
    if (!closed) {
      closed = true;
      try { if (mtime !== undefined) await handle.utimes(new Date(), new Date(mtime)); }
      finally { await handle.close(); }
    }
  } };
}
