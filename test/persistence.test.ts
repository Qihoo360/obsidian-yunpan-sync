import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("sql.js/dist/sql-wasm.wasm", () => ({
  default: new Uint8Array(readFileSync("node_modules/sql.js/dist/sql-wasm.wasm")),
}));

import { DatabasePersistence } from "../src/storage/persistence.js";

class MemoryAdapter {
  readonly files = new Map<string, Uint8Array>();
  failReplacement = false;
  activeWrites = 0;
  peakWrites = 0;
  writes = 0;

  async exists(path: string): Promise<boolean> { return this.files.has(path); }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return value.slice().buffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.writes++;
    this.activeWrites++;
    this.peakWrites = Math.max(this.peakWrites, this.activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 1));
    this.files.set(path, new Uint8Array(data));
    this.activeWrites--;
  }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async rename(source: string, destination: string): Promise<void> {
    if (this.failReplacement && source.endsWith(".tmp") && destination.endsWith("sync.sqlite")) {
      this.failReplacement = false;
      throw new Error("replacement failed");
    }
    const value = this.files.get(source);
    if (!value) throw new Error(`missing ${source}`);
    this.files.set(destination, value);
    this.files.delete(source);
  }
}

describe("database file persistence", () => {
  it("serializes concurrent saves and leaves only the database snapshot", async () => {
    const adapter = new MemoryAdapter();
    const persistence = await DatabasePersistence.open(adapter as never, ".obsidian/plugins/yunpan-sync");
    persistence.database.setLastSuccessfulSync(100);

    await Promise.all([persistence.save(), persistence.save(), persistence.save()]);

    expect(adapter.peakWrites).toBe(1);
    expect(adapter.writes).toBe(1);
    expect(adapter.files.has(".obsidian/plugins/yunpan-sync/sync.sqlite")).toBe(true);
    expect(adapter.files.has(".obsidian/plugins/yunpan-sync/sync.sqlite.tmp")).toBe(false);
    expect(adapter.files.has(".obsidian/plugins/yunpan-sync/sync.sqlite.backup")).toBe(false);
  });

  it("covers mutations requested during a write with a subsequent durable snapshot", async () => {
    const adapter = new MemoryAdapter();
    const persistence = await DatabasePersistence.open(adapter as never, ".obsidian/plugins/yunpan-sync");
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { started = resolve; });
    const write = adapter.writeBinary.bind(adapter);
    let firstWrite = true;
    adapter.writeBinary = async (path, data) => {
      if (firstWrite) { firstWrite = false; started(); await gate; }
      await write(path, data);
    };
    const first = persistence.save();
    await writing;
    persistence.database.setLastSuccessfulSync(200);
    const second = persistence.save();
    release();
    await second; await first;
    expect(adapter.writes).toBe(2);
    const restored = await DatabasePersistence.open(adapter as never, ".obsidian/plugins/yunpan-sync");
    expect(restored.database.getLastSuccessfulSync()).toBe(200);
    expect(adapter.peakWrites).toBe(1);
  });

  it("restores the previous database when atomic replacement fails", async () => {
    const adapter = new MemoryAdapter();
    const persistence = await DatabasePersistence.open(adapter as never, ".obsidian/plugins/yunpan-sync");
    persistence.database.setLastSuccessfulSync(100);
    await persistence.save();
    const original = adapter.files.get(".obsidian/plugins/yunpan-sync/sync.sqlite")!.slice();
    persistence.database.setLastSuccessfulSync(200);
    adapter.failReplacement = true;

    await expect(persistence.save()).rejects.toThrow("replacement failed");

    expect(adapter.files.get(".obsidian/plugins/yunpan-sync/sync.sqlite")).toEqual(original);
    expect(adapter.files.has(".obsidian/plugins/yunpan-sync/sync.sqlite.tmp")).toBe(false);
    expect(adapter.files.has(".obsidian/plugins/yunpan-sync/sync.sqlite.backup")).toBe(false);
  });
});
