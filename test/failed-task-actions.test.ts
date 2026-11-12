import { describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { SyncDatabase } from "../src/storage/database.js";
import { SyncEngine } from "../src/sync/engine.js";
import { DEFAULT_SETTINGS, normalizeSettings, type PluginSettings } from "../src/settings.js";
import { shouldIgnorePath } from "../src/domain/paths.js";

const notices = vi.hoisted(() => [] as string[]);
vi.mock("obsidian", async (importOriginal) => ({
  ...await importOriginal<typeof import("obsidian")>(),
  Plugin: class { constructor(public app: unknown) {} },
  PluginSettingTab: class {},
  Modal: class {},
  ItemView: class {},
  Notice: class { constructor(message: string) { notices.push(message); } },
}));
vi.mock("../src/storage/persistence.js", () => ({ DatabasePersistence: {} }));
import YunpanSyncPlugin from "../src/main.js";

async function harness(save: () => Promise<void> = async () => undefined) {
  const SQL = await initSqlJs({ locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm" });
  const sql = new SQL.Database();
  const database = new SyncDatabase(sql);
  const plugin = new YunpanSyncPlugin({ workspace: { getLeavesOfType: () => [] } } as never, {} as never);
  const engine = new SyncEngine({} as never, database, {} as never, {} as never, {} as never,
    () => DEFAULT_SETTINGS, "test", (status) => {
      (plugin as unknown as { updateStatus(status: unknown): void }).updateStatus(status);
    });
  Object.assign(plugin, { engine, persistence: { database, save } });
  database.enqueue({ id: "bad", kind: "upload", path: "note.md", payload: {}, nextRunAt: 0 });
  database.failTask("bad", "源文件不存在");
  return { plugin, database, engine, sql };
}

describe("failed record actions through the plugin", () => {
  it("persists a full-path exclusion before clearing the failure and lets filters undo it", async () => {
    const { plugin, database } = await harness();
    plugin.settings.filterRules = [{ id: "include", pattern: "**/*.md", enabled: true, action: "include", caseSensitive: false }];
    let saved!: PluginSettings;
    Object.assign(plugin, { saveData: vi.fn(async (settings: PluginSettings) => { saved = structuredClone(settings); }) });
    await plugin.ignoreTask("bad");
    const restored = normalizeSettings(saved);
    expect(restored.filterRules.at(-1)).toMatchObject({ pattern: "/note.md", action: "exclude", enabled: true });
    expect(shouldIgnorePath("note.md", { filterRules: restored.filterRules })).toBe(true);
    expect(shouldIgnorePath("other/note.md", { filterRules: restored.filterRules })).toBe(false);
    expect(shouldIgnorePath("notes.md", { filterRules: restored.filterRules })).toBe(false);
    expect(database.listFailedTasks()).toEqual([]);
    expect(plugin.currentStatus.failed).toBe(0);
    expect(notices.at(-1)).toContain("后续不再上传或下载");
    restored.filterRules.at(-1)!.enabled = false;
    expect(shouldIgnorePath("note.md", { filterRules: normalizeSettings(restored).filterRules })).toBe(false);
  });

  it("keeps the failure and old rules if saving the exclusion fails", async () => {
    const { plugin, database } = await harness();
    const before = plugin.settings.filterRules;
    Object.assign(plugin, { saveData: vi.fn(async () => { throw new Error("disk full"); }) });
    await plugin.ignoreTask("bad");
    expect(plugin.settings.filterRules).toBe(before);
    expect(database.listFailedTasks().map(task => task.id)).toEqual(["bad"]);
    expect(notices.at(-1)).toBe("忽略文件失败：disk full");
    expect(plugin.isSyncing).toBe(false);
  });

  it("blocks repeated ignores and sync starts while saving an exclusion", async () => {
    const { plugin, database } = await harness();
    let release!: () => void;
    const saving = new Promise<void>(resolve => { release = resolve; });
    const saveData = vi.fn(() => saving);
    Object.assign(plugin, { saveData });
    const ignoring = plugin.ignoreTask("bad");
    expect(plugin.isSyncing).toBe(true);
    await plugin.ignoreTask("bad");
    await plugin.syncNow();
    expect(saveData).toHaveBeenCalledOnce();
    expect(database.listFailedTasks()).toHaveLength(1);
    release(); await ignoring;
    expect(database.listFailedTasks()).toEqual([]);
    expect(plugin.isSyncing).toBe(false);
  });

  it("shows a rename recovery warning once across progress updates", async () => {
    const { plugin } = await harness();
    const update = (plugin as unknown as {updateStatus(status: unknown): void}).updateStatus.bind(plugin);
    const warning = "旧改名任务已失效，无法确认云端对应文件，已保留两端文件并重新比较。";
    const before = notices.filter(message => message === warning).length;
    update({phase:"compare",message:"正在比较",queued:0,failed:0,warnings:[warning]});
    update({phase:"transfer",message:"正在同步",queued:0,failed:0,warnings:[warning]});
    update({phase:"idle",message:"同步完成",queued:0,failed:0,warnings:[warning]});
    expect(notices.filter(message => message === warning)).toHaveLength(before + 1);
  });

  it("persists deletion and immediately clears failure status without starting synchronization", async () => {
    const snapshots: Uint8Array[] = [];
    const { plugin, database } = await harness(async () => { snapshots.push(database.export()); });
    await plugin.removeFailedTask("bad");
    expect(plugin.failedTasks).toEqual([]);
    expect(plugin.currentStatus).toMatchObject({ phase: "idle", failed: 0,
      message: "失败记录已清除，可重新同步", lastError: undefined });
    expect(snapshots).toHaveLength(1);
    
    expect(plugin.isSyncing).toBe(false);
    await plugin.removeFailedTask("bad");
    expect(notices.at(-1)).toBe("该失败记录已不存在或不可删除");
    expect(snapshots).toHaveLength(1);
  });

  it("blocks new synchronization and repeated deletion while the record is being saved", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { plugin, database } = await harness(() => gate);
    const removing = plugin.removeFailedTask("bad");
    expect(plugin.isSyncing).toBe(true);
    await plugin.syncNow();
    await plugin.removeFailedTask("bad");
    
    release();
    await removing;
    expect(plugin.isSyncing).toBe(false);
  });

  it("reports a save failure and releases the action guard", async () => {
    const { plugin } = await harness(async () => { throw new Error("disk full"); });
    await plugin.removeFailedTask("bad");
    expect(notices.at(-1)).toContain("保存失败，重启后可能恢复");
    expect(plugin.isSyncing).toBe(false);
  });

  it("does not report removal when the database rejects the deletion", async () => {
    const { plugin, database, sql } = await harness();
    sql.run("CREATE TRIGGER reject_task_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'database locked'); END");
    await plugin.removeFailedTask("bad");
    expect(database.listFailedTasks().map((task) => task.id)).toEqual(["bad"]);
    expect(notices.at(-1)).toBe("删除失败记录失败：database locked");
    expect(plugin.isSyncing).toBe(false);
  });
});
