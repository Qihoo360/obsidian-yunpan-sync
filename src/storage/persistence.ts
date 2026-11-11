import type { DataAdapter } from "obsidian";
import initSqlJs from "sql.js";
import sqlWasmBinary from "sql.js/dist/sql-wasm.wasm";
import { SyncDatabase } from "./database.js";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class DatabasePersistence {
  private saving?: Promise<void>;
  private requested = 0;
  private persisted = 0;

  private constructor(
    readonly database: SyncDatabase,
    private readonly adapter: DataAdapter,
    private readonly path: string,
  ) {}

  static async open(adapter: DataAdapter, pluginDir: string): Promise<DatabasePersistence> {
    const SQL = await initSqlJs({ wasmBinary: arrayBuffer(sqlWasmBinary) });
    const path = `${pluginDir}/sync.sqlite`;
    const database = await adapter.exists(path, false)
      ? new SQL.Database(new Uint8Array(await adapter.readBinary(path)))
      : new SQL.Database();
    return new DatabasePersistence(new SyncDatabase(database), adapter, path);
  }

  async save(): Promise<void> {
    const version = ++this.requested;
    while (this.persisted < version) {
      if (!this.saving) {
        this.saving = Promise.resolve().then(async () => {
          const covered = this.requested;
          await this.writeSnapshot();
          this.persisted = covered;
        }).finally(() => { this.saving = undefined; });
      }
      await this.saving;
    }
  }

  private async writeSnapshot(): Promise<void> {
    const temporary = `${this.path}.tmp`;
    const backup = `${this.path}.backup`;
    await this.adapter.writeBinary(temporary, arrayBuffer(this.database.export()));
    const existed = await this.adapter.exists(this.path, false);
    try {
      if (await this.adapter.exists(backup, false)) await this.adapter.remove(backup);
      if (existed) await this.adapter.rename(this.path, backup);
      await this.adapter.rename(temporary, this.path);
      if (existed && await this.adapter.exists(backup, false)) await this.adapter.remove(backup);
    } catch (error) {
      if (await this.adapter.exists(temporary, false)) await this.adapter.remove(temporary);
      if (await this.adapter.exists(backup, false) && !await this.adapter.exists(this.path, false)) await this.adapter.rename(backup, this.path);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.save();
    this.database.close();
  }
}
