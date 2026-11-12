import type { DataAdapter } from "obsidian";
import type { SyncDatabase } from "../storage/database.js";
import { md5 } from "../net/signing.js";

export interface DownloadResume {
  prepare(identity: string): Promise<void>;
  read(index: number): Promise<Uint8Array | undefined>;
  write(index: number, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** Kept in diagnostics/task records; UI must classify this before displaying it. */
export class DownloadCacheError extends Error {
  constructor(cause: unknown) {
    super(`Download cache recovery failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "DownloadCacheError";
  }
}

async function checksum(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    value => value.toString(16).padStart(2, "0")).join("");
}

function isMissingPathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:enoent|no such file|not found)/i.test(message);
}

function isCacheStructureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingPathError(error) || /(?:enotdir|not a directory|eisdir|is a directory|rm returned)/i.test(message);
}

/** Only generated block paths are ever read or removed; no persisted path is trusted. */
export class DownloadCache implements DownloadResume {
  private readonly directory: string;
  private identity?: string;
  private recoveryAttempted = false;
  constructor(private readonly adapter: DataAdapter, private readonly database: SyncDatabase,
    private readonly binding: string, private readonly taskId: string,
    private readonly checkpoint: () => Promise<void>) {
    this.directory = `.yunpan-sync/downloads/${md5(`${binding}\n${taskId}`)}`;
  }

  async prepare(identity: string): Promise<void> {
    this.identity = identity;
    const old = this.database.downloadStates().find(state => state.taskId === this.taskId);
    if (old && (old.binding !== this.binding || old.identity !== identity)) {
      await new DownloadCache(this.adapter, this.database, old.binding, this.taskId, this.checkpoint).clear();
      // Never reuse another account's or cloud file's blocks, even if cleanup failed.
      this.database.clearDownload(this.taskId);
    }
    await this.withRecovery(() => this.ensureDirectories());
    this.database.setDownloadState({ taskId: this.taskId, binding: this.binding, identity });
    await this.checkpoint();
  }

  async read(index: number): Promise<Uint8Array | undefined> {
    const path = this.blockPath(index);
    const record = this.database.downloadBlock(this.taskId, index);
    if (!record) return undefined;
    try {
      const bytes = new Uint8Array(await this.adapter.readBinary(path));
      if (bytes.length === record.size && await checksum(bytes) === record.hash) return bytes;
    } catch { /* Missing, malformed or truncated blocks are downloaded again. */ }
    this.database.removeDownloadBlock(this.taskId, index);
    await this.checkpoint();
    return undefined;
  }

  async write(index: number, bytes: Uint8Array): Promise<void> {
    const path = this.blockPath(index);
    await this.withRecovery(async () => {
      if ((await this.stat(path))?.type === "folder") throw new Error("EISDIR: download block is a directory");
      await this.adapter.writeBinary(path, new Uint8Array(bytes).buffer);
    });
    this.database.saveDownloadBlock(this.taskId, index, await checksum(bytes), bytes.length);
    await this.checkpoint();
  }

  async clear(): Promise<void> {
    if (!this.database.downloadStates().some(state => state.taskId === this.taskId && state.binding === this.binding)) return;
    try { await this.clearGeneratedDirectory(); }
    catch (error) {
      // Retain state for a later sweep, without blocking completed transfers,
      // logout, directory selection or account changes.
      console.warn("[360AI Cloud Sync] Download cache cleanup deferred", error);
      return;
    }
    this.database.clearDownload(this.taskId);
    // Database persistence is critical, unlike disposable cache cleanup.
    await this.checkpoint();
  }

  private blockPath(index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid download block index");
    return `${this.directory}/${index}.part`;
  }

  private async stat(path: string): Promise<{ type: "file" | "folder" } | undefined> {
    try { return await this.adapter.stat(path) ?? undefined; }
    catch (error) { if (isMissingPathError(error)) return undefined; throw error; }
  }

  private async ensureDirectories(repair = false): Promise<void> {
    for (const path of [".yunpan-sync", ".yunpan-sync/downloads", this.directory]) {
      const info = await this.stat(path);
      if (info?.type === "folder") continue;
      if (info?.type === "file") {
        if (!repair) throw new Error("ENOTDIR: download cache directory is a file");
        // These exact paths are generated by the plugin, never loaded from DB.
        await this.adapter.remove(path);
      }
      try { await this.adapter.mkdir(path); }
      catch (error) { if ((await this.stat(path))?.type !== "folder") throw error; }
    }
  }

  private async withRecovery(operation: () => Promise<void>): Promise<void> {
    try { await operation(); return; }
    catch (error) {
      if (!isCacheStructureError(error)) throw error;
      if (this.recoveryAttempted) throw new DownloadCacheError(error);
      this.recoveryAttempted = true;
      console.warn("[360AI Cloud Sync] Rebuilding download cache", error);
    }
    // Invalidate before disk repair so interrupted recovery cannot reuse old blocks.
    this.database.clearDownload(this.taskId);
    if (this.identity !== undefined) this.database.setDownloadState({ taskId: this.taskId, binding: this.binding, identity: this.identity });
    await this.checkpoint();
    try {
      // Repair the shared parent paths before examining this task directory.
      // stat() on a child may itself throw ENOTDIR while a parent is a file.
      await this.ensureDirectories(true);
      await this.clearGeneratedDirectory();
      await this.ensureDirectories();
      await operation();
    } catch (error) { throw new DownloadCacheError(error); }
  }

  private async clearGeneratedDirectory(): Promise<void> {
    const info = await this.stat(this.directory);
    if (!info) return;
    if (info.type === "file") { await this.adapter.remove(this.directory); return; }
    const listed = await this.adapter.list(this.directory);
    for (const path of new Set([...listed.files, ...listed.folders])) {
      const name = path.slice(this.directory.length + 1);
      if (path.startsWith(`${this.directory}/`) && /^\d+\.part$/.test(name)) {
        await this.removeGeneratedTree(path, path, 0);
      }
    }
    // Preserve unexpected content; never recursively remove the cache root.
    await this.removeEmptyDirectory(this.directory);
  }

  private async removeEmptyDirectory(path: string): Promise<void> {
    const remaining = await this.adapter.list(path);
    if (remaining.files.length || remaining.folders.length) return;
    try { await this.adapter.rmdir(path, false); }
    catch (error) {
      if (!isCacheStructureError(error)) throw error;
      if (!await this.stat(path)) return;
      // Some adapters use file removal for nonrecursive rmdir (EISDIR).
      // Retry via the directory API only after rechecking this path is empty.
      const checked = await this.adapter.list(path);
      if (checked.files.length || checked.folders.length) throw error;
      await this.adapter.rmdir(path, true);
    }
  }

  private async removeGeneratedTree(path: string, root: string, depth: number): Promise<void> {
    if (depth > 32 || (path !== root && !path.startsWith(`${root}/`))) throw new Error("Unsafe download cache entry");
    const info = await this.stat(path);
    if (!info) return;
    if (info.type === "file") { await this.adapter.remove(path); return; }
    const listed = await this.adapter.list(path);
    for (const child of new Set([...listed.files, ...listed.folders])) {
      const name = child.slice(path.length + 1);
      if (!child.startsWith(`${path}/`) || !name || /[/\\\x00]/.test(name) || name === "." || name === "..") {
        throw new Error("Unsafe download cache entry");
      }
      await this.removeGeneratedTree(child, root, depth + 1);
    }
    await this.removeEmptyDirectory(path);
  }
}

export async function discardDownloads(adapter: DataAdapter, database: SyncDatabase, checkpoint: () => Promise<void>): Promise<void> {
  for (const state of database.downloadStates()) {
    await new DownloadCache(adapter, database, state.binding, state.taskId, checkpoint).clear();
  }
}
