import type { BindParams, Database } from "sql.js";
import type { SyncSnapshot } from "../domain/planner.js";
import { normalizeVaultPath } from "../domain/paths.js";


export interface SyncCursor {
  accountKey: string;
  bgsp?: string;
  gsp?: string;
  remoteVersion: number;
  snapshotComplete: boolean;
}

export interface RemoteNode {
  nid: string;
  pid: string;
  path: string;
  name: string;
  isDir: boolean;
  version: number;
  hash?: string;
  size: number;
  mtime: number;
  status?: number;
}

export type TaskKind = "mkdir" | "recycle" | "rename" | "move" | "local-rename" | "upload" | "download";
export type TaskState = "queued" | "running" | "retry" | "done" | "failed";

export interface NewSyncTask {
  id: string;
  kind: TaskKind;
  path: string;
  nid?: string;
  payload: unknown;
  expectedLocalHash?: string;
  expectedRemoteVersion?: number;
  nextRunAt?: number;
}

export interface SyncTask extends NewSyncTask {
  state: TaskState;
  attempt: number;
  nextRunAt: number;
  lastError?: string;
}

export interface SyncConflict {
  id: number;
  originalPath: string;
  conflictPath: string;
  createdAt: number;
}

function rowObject<T>(db: Database, sql: string, params: BindParams): T | undefined {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() as T : undefined;
  } finally {
    statement.free();
  }
}

export class SyncDatabase {
  private transactionDepth = 0;
  

  constructor(private readonly db: Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS cursors (
        account_key TEXT PRIMARY KEY, bgsp TEXT, gsp TEXT, remote_version INTEGER NOT NULL,
        snapshot_complete INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remote_nodes (
        nid TEXT PRIMARY KEY, pid TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
        is_dir INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT, size INTEGER NOT NULL,
        mtime INTEGER NOT NULL, status INTEGER
      );
      CREATE INDEX IF NOT EXISTS remote_nodes_path ON remote_nodes(path);
      CREATE TABLE IF NOT EXISTS sync_base (
        path TEXT PRIMARY KEY, nid TEXT, hash TEXT, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
        kind TEXT NOT NULL, version INTEGER
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, nid TEXT, state TEXT NOT NULL,
        expected_local_hash TEXT, expected_remote_version INTEGER, attempt INTEGER NOT NULL,
        next_run_at INTEGER NOT NULL, payload TEXT NOT NULL, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_runnable ON tasks(state, next_run_at);
      CREATE TABLE IF NOT EXISTS suppressions (
        path TEXT PRIMARY KEY, operation TEXT NOT NULL, expected_hash TEXT, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_state (
        task_id TEXT PRIMARY KEY, tid TEXT NOT NULL, endpoint TEXT NOT NULL, ticket TEXT NOT NULL,
        file_hash TEXT NOT NULL, final_ticket TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfer_blocks (
        task_id TEXT NOT NULL, block_index INTEGER NOT NULL, completed INTEGER NOT NULL,
        PRIMARY KEY(task_id, block_index)
      );
      CREATE TABLE IF NOT EXISTS conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, original_path TEXT NOT NULL, conflict_path TEXT NOT NULL,
        created_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS confirmed_bindings (
        account_key TEXT PRIMARY KEY, confirmed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
    const schemaVersion = Number(this.db.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0);
    if (schemaVersion < 1) {
      this.db.run(`
        BEGIN IMMEDIATE;
        CREATE TABLE remote_nodes_v1 (
          nid TEXT PRIMARY KEY, pid TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL,
          is_dir INTEGER NOT NULL, version INTEGER NOT NULL, hash TEXT, size INTEGER NOT NULL,
          mtime INTEGER NOT NULL, status INTEGER
        );
        INSERT INTO remote_nodes_v1(nid,pid,path,name,is_dir,version,hash,size,mtime,status)
          SELECT nid,pid,path,name,is_dir,version,hash,size,mtime,status FROM remote_nodes;
        DROP TABLE remote_nodes;
        ALTER TABLE remote_nodes_v1 RENAME TO remote_nodes;
        CREATE INDEX remote_nodes_path ON remote_nodes(path);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    // Preserve the previous successful time before retiring legacy storage.
    if (this.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").length) {
      this.db.run("INSERT OR IGNORE INTO sync_state(key,value) SELECT 'last_success',MAX(at) FROM logs WHERE level='info' AND phase='idle' AND message IN ('同步完成','已是最新') HAVING MAX(at) IS NOT NULL");
      this.db.run("DROP TABLE logs");
    }
  }

  transaction<T>(work: () => T): T {
    const outermost = this.transactionDepth === 0;
    if (outermost) this.db.run("BEGIN IMMEDIATE");
    this.transactionDepth++;
    try {
      const result = work();
      this.transactionDepth--;
      if (outermost) this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.transactionDepth--;
      if (outermost) this.db.run("ROLLBACK");
      throw error;
    }
  }

  setCursor(cursor: SyncCursor): void {
    this.db.run(`INSERT INTO cursors(account_key,bgsp,gsp,remote_version,snapshot_complete)
      VALUES($accountKey,$bgsp,$gsp,$version,$complete)
      ON CONFLICT(account_key) DO UPDATE SET bgsp=excluded.bgsp,gsp=excluded.gsp,
      remote_version=excluded.remote_version,snapshot_complete=excluded.snapshot_complete`, {
      $accountKey: cursor.accountKey, $bgsp: cursor.bgsp ?? null, $gsp: cursor.gsp ?? null,
      $version: cursor.remoteVersion, $complete: cursor.snapshotComplete ? 1 : 0,
    });
  }

  getCursor(accountKey: string): SyncCursor | undefined {
    const row = rowObject<Record<string, unknown>>(this.db, "SELECT * FROM cursors WHERE account_key=$key", { $key: accountKey });
    if (!row) return undefined;
    return { accountKey: String(row.account_key), bgsp: row.bgsp == null ? undefined : String(row.bgsp),
      gsp: row.gsp == null ? undefined : String(row.gsp), remoteVersion: Number(row.remote_version),
      snapshotComplete: Number(row.snapshot_complete) === 1 };
  }

  clearRemoteIndex(accountKey: string): void {
    this.transaction(() => {
      this.db.run("DELETE FROM remote_nodes");
      this.db.run("DELETE FROM cursors WHERE account_key=$key", { $key: accountKey });
    });
  }

  resetSyncState(): void {
    this.transaction(() => {
      for (const table of ["cursors", "remote_nodes", "sync_base", "tasks", "suppressions", "transfer_blocks", "transfer_state"]) {
        this.db.run(`DELETE FROM ${table}`);
      }
    });
  }

  isBindingConfirmed(accountKey: string): boolean {
    return Boolean(rowObject(this.db, "SELECT account_key FROM confirmed_bindings WHERE account_key=$key", { $key: accountKey }));
  }

  confirmBinding(accountKey: string): void {
    this.db.run(`INSERT INTO confirmed_bindings(account_key,confirmed_at) VALUES($key,$at)
      ON CONFLICT(account_key) DO UPDATE SET confirmed_at=excluded.confirmed_at`, { $key: accountKey, $at: Date.now() });
  }

  unconfirmBinding(accountKey: string): void {
    this.db.run("DELETE FROM confirmed_bindings WHERE account_key=$key", { $key: accountKey });
  }

  replaceRemoteSnapshot(nodes: RemoteNode[]): void {
    this.transaction(() => {
      this.db.run("DELETE FROM remote_nodes");
      for (const node of nodes) this.upsertRemoteNode(node);
    });
  }

  upsertRemoteNode(node: RemoteNode): void {
    this.db.run(`INSERT INTO remote_nodes(nid,pid,path,name,is_dir,version,hash,size,mtime,status)
      VALUES($nid,$pid,$path,$name,$dir,$version,$hash,$size,$mtime,$status)
      ON CONFLICT(nid) DO UPDATE SET pid=excluded.pid,path=excluded.path,name=excluded.name,
      is_dir=excluded.is_dir,version=excluded.version,hash=excluded.hash,size=excluded.size,
      mtime=excluded.mtime,status=excluded.status`, {
      $nid: node.nid, $pid: node.pid, $path: node.path, $name: node.name, $dir: node.isDir ? 1 : 0,
      $version: node.version, $hash: node.hash ?? null, $size: node.size, $mtime: node.mtime,
      $status: node.status ?? null,
    });
  }

  getRemoteNodes(): RemoteNode[] {
    const result = this.db.exec("SELECT * FROM remote_nodes ORDER BY path");
    if (!result[0]) return [];
    const { columns, values } = result[0];
    return values.map((valuesRow) => {
      const row = Object.fromEntries(columns.map((column, index) => [column, valuesRow[index]]));
      return { nid: String(row.nid), pid: String(row.pid), path: String(row.path), name: String(row.name),
        isDir: Number(row.is_dir) === 1, version: Number(row.version), hash: row.hash == null ? undefined : String(row.hash),
        size: Number(row.size), mtime: Number(row.mtime), status: row.status == null ? undefined : Number(row.status) };
    });
  }

  /** Remove remote tombstones left by older indexer versions without touching local state. */
  purgeDeletedRemoteNodes(): number {
    const nodes = this.getRemoteNodes();
    const removed = new Set(nodes
      .filter((node) => node.status !== undefined && node.status !== 0)
      .map((node) => node.nid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (removed.has(node.pid) && !removed.has(node.nid)) {
          removed.add(node.nid);
          changed = true;
        }
      }
    }
    if (removed.size === 0) return 0;
    this.transaction(() => {
      for (const nid of removed) this.db.run("DELETE FROM remote_nodes WHERE nid=$nid", { $nid: nid });
    });
    return removed.size;
  }

  moveRemoteNodes(source: string, destination: string): void {
    const normalize = (path: string): string => `/${path.normalize("NFC").replaceAll("\\", "/").split("/").filter(Boolean).join("/")}`;
    const normalizedSource = normalize(source);
    const normalizedDestination = normalize(destination);
    const sourceKey = normalizedSource.toLocaleLowerCase("en-US");
    const nodes = this.getRemoteNodes().filter((node) => {
      const key = normalize(node.path).toLocaleLowerCase("en-US");
      return key === sourceKey || key.startsWith(`${sourceKey}/`);
    });
    if (nodes.length === 0) return;
    const rootName = normalizedDestination.slice(normalizedDestination.lastIndexOf("/") + 1);
    const parentPath = normalizedDestination.slice(0, normalizedDestination.lastIndexOf("/")) || "/";
    const parent = this.getRemoteNodes().find((node) => node.isDir &&
      normalize(node.path).toLocaleLowerCase("en-US") === parentPath.toLocaleLowerCase("en-US"));
    this.transaction(() => {
      for (const node of nodes) {
        const nodePath = normalize(node.path);
        const suffix = nodePath.length === normalizedSource.length ? "" : nodePath.slice(normalizedSource.length);
        this.db.run("UPDATE remote_nodes SET path=$path,name=$name,pid=$pid WHERE nid=$nid", {
          $path: `${normalizedDestination}${suffix}`,
          $name: suffix ? node.name : rootName,
          $pid: suffix || !parent ? node.pid : parent.nid,
          $nid: node.nid,
        });
      }
    });
  }

  putBase(path: string, snapshot: SyncSnapshot): void {
    const normalizedPath = normalizeVaultPath(path);
    this.db.run(`INSERT INTO sync_base(path,nid,hash,size,mtime,kind,version)
      VALUES($path,$nid,$hash,$size,$mtime,$kind,$version)
      ON CONFLICT(path) DO UPDATE SET nid=excluded.nid,hash=excluded.hash,size=excluded.size,
      mtime=excluded.mtime,kind=excluded.kind,version=excluded.version`, {
      $path: normalizedPath, $nid: snapshot.nid ?? null, $hash: snapshot.hash ?? null, $size: snapshot.size,
      $mtime: snapshot.mtime, $kind: snapshot.kind, $version: snapshot.version ?? null,
    });
  }

  getBase(path: string): SyncSnapshot | undefined {
    const normalizedPath = normalizeVaultPath(path);
    const row = rowObject<Record<string, unknown>>(this.db,
      "SELECT * FROM sync_base WHERE lower(path)=lower($path) LIMIT 1", { $path: normalizedPath });
    if (!row) return undefined;
    return { nid: row.nid == null ? undefined : String(row.nid), hash: row.hash == null ? undefined : String(row.hash),
      size: Number(row.size), mtime: Number(row.mtime), kind: row.kind as "file" | "directory",
      version: row.version == null ? undefined : Number(row.version) };
  }

  getBases(): Map<string, SyncSnapshot> {
    const result = new Map<string, SyncSnapshot>();
    const query = this.db.exec("SELECT * FROM sync_base ORDER BY path")[0];
    if (!query) return result;
    for (const values of query.values) {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      result.set(normalizeVaultPath(String(row.path)), {
        nid: row.nid == null ? undefined : String(row.nid), hash: row.hash == null ? undefined : String(row.hash),
        size: Number(row.size), mtime: Number(row.mtime), kind: row.kind as "file" | "directory",
        version: row.version == null ? undefined : Number(row.version),
      });
    }
    return result;
  }

  deleteBase(path: string): void {
    const normalizedPath = normalizeVaultPath(path);
    this.db.run("DELETE FROM sync_base WHERE lower(path)=lower($path)", { $path: normalizedPath });
  }

  deleteBaseTree(path: string): void {
    const normalizedPath = normalizeVaultPath(path);
    const key = normalizedPath.toLocaleLowerCase("en-US");
    const paths = [...this.getBases().keys()].filter((candidate) => {
      const candidateKey = candidate.toLocaleLowerCase("en-US");
      return candidateKey === key || candidateKey.startsWith(`${key}/`);
    });
    this.transaction(() => {
      for (const candidate of paths) this.deleteBase(candidate);
    });
  }

  moveBase(source: string, destination: string): void {
    const normalizedSource = normalizeVaultPath(source);
    const normalizedDestination = normalizeVaultPath(destination);
    const query = this.db.exec("SELECT path FROM sync_base")[0];
    if (!query) return;
    const sourceKey = normalizedSource.toLocaleLowerCase("en-US");
    const mappings = query.values.map((row) => {
      const oldPath = normalizeVaultPath(String(row[0]));
      const oldKey = oldPath.toLocaleLowerCase("en-US");
      return { oldPath, oldKey };
    }).filter(({ oldKey }) => oldKey === sourceKey || oldKey.startsWith(`${sourceKey}/`)).map(({ oldPath }) => {
      const suffix = oldPath.length === normalizedSource.length ? "" : oldPath.slice(normalizedSource.length);
      return { oldPath, newPath: `${normalizedDestination}${suffix}` };
    });
    const token = `.__yunpan_sync_move_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.transaction(() => {
      mappings.forEach(({ oldPath }, index) => this.db.run(
        "UPDATE sync_base SET path=$temporary WHERE lower(path)=lower($path)",
        { $temporary: `${token}_${index}`, $path: oldPath },
      ));
      mappings.forEach(({ newPath }, index) => this.db.run(
        "UPDATE sync_base SET path=$destination WHERE path=$temporary",
        { $destination: newPath, $temporary: `${token}_${index}` },
      ));
    });
  }

  relocateTasks(source: string, destination: string): void {
    const normalizedSource = normalizeVaultPath(source);
    const normalizedDestination = normalizeVaultPath(destination);
    const query = this.db.exec("SELECT id,kind,path,payload FROM tasks WHERE state IN ('queued','retry','failed')")[0];
    if (!query) return;
    const sourceKey = normalizedSource.toLocaleLowerCase("en-US");
    for (const values of query.values) {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      const taskPath = normalizeVaultPath(String(row.path));
      const taskKey = taskPath.toLocaleLowerCase("en-US");
      if (taskKey !== sourceKey && !taskKey.startsWith(`${sourceKey}/`)) continue;
      const suffix = taskPath.length === normalizedSource.length ? "" : taskPath.slice(normalizedSource.length);
      const nextPath = `${normalizedDestination}${suffix}`;
      if ((row.kind === "rename" || row.kind === "move") && taskPath === normalizedSource) {
        this.clearTransfer(String(row.id));
        this.db.run("DELETE FROM tasks WHERE id=$id", { $id: String(row.id) });
      } else if ((row.kind === "rename" || row.kind === "move") && taskPath !== normalizedSource) {
        let payload: Record<string, unknown> | undefined;
        try { payload = JSON.parse(String(row.payload)) as Record<string, unknown>; } catch { payload = undefined; }
        const taskDestination = typeof payload?.destination === "string" ? normalizeVaultPath(payload.destination) : undefined;
        const destinationKey = taskDestination?.toLocaleLowerCase("en-US");
        const nextDestination = destinationKey && (destinationKey === sourceKey || destinationKey.startsWith(`${sourceKey}/`))
          ? `${normalizedDestination}${taskDestination!.slice(normalizedSource.length)}` : taskDestination;
        this.db.run("UPDATE tasks SET path=$path,payload=$payload WHERE id=$id", {
          $path: nextPath, $payload: JSON.stringify(nextDestination ? { ...payload, destination: nextDestination } : payload ?? {}), $id: String(row.id),
        });
      } else {
        this.db.run("UPDATE tasks SET path=$path WHERE id=$id", { $path: nextPath, $id: String(row.id) });
      }
    }
  }

  suppress(path: string, operation: string, expectedHash: string | undefined, expiresAt: number): void {
    const normalizedPath = normalizeVaultPath(path);
    this.db.run(`INSERT INTO suppressions(path,operation,expected_hash,expires_at) VALUES($path,$operation,$hash,$expires)
      ON CONFLICT(path) DO UPDATE SET operation=excluded.operation,expected_hash=excluded.expected_hash,expires_at=excluded.expires_at`, {
      $path: normalizedPath, $operation: operation, $hash: expectedHash ?? null, $expires: expiresAt,
    });
  }

  consumeSuppression(path: string, now = Date.now()): boolean {
    const normalizedPath = normalizeVaultPath(path);
    this.db.run("DELETE FROM suppressions WHERE expires_at<$now", { $now: now });
    const row = rowObject<Record<string, unknown>>(this.db,
      "SELECT path FROM suppressions WHERE lower(path)=lower($path)", { $path: normalizedPath });
    if (!row) return false;
    this.db.run("DELETE FROM suppressions WHERE path=$path", { $path: String(row.path) });
    return true;
  }

  taskCounts(): { queued: number; failed: number } {
    const queued = rowObject<Record<string, unknown>>(this.db,
      "SELECT COUNT(*) AS count FROM tasks WHERE state IN ('queued','running','retry')", {})?.count ?? 0;
    const failed = rowObject<Record<string, unknown>>(this.db,
      "SELECT COUNT(*) AS count FROM tasks WHERE state='failed'", {})?.count ?? 0;
    return { queued: Number(queued), failed: Number(failed) };
  }

  retryFailedTasks(): number {
    this.db.run("UPDATE tasks SET state='retry',next_run_at=0 WHERE state='failed'");
    return this.db.getRowsModified();
  }

  makeRetryTasksRunnable(): number {
    this.db.run("UPDATE tasks SET next_run_at=0 WHERE state='retry'");
    return this.db.getRowsModified();
  }

  retryTask(id: string): boolean {
    this.db.run("UPDATE tasks SET state='retry',next_run_at=0 WHERE id=$id AND state IN ('retry','failed')", { $id: id });
    return this.db.getRowsModified() === 1;
  }

  removeFailedTask(id: string): boolean {
    return this.transaction(() => {
      this.db.run("DELETE FROM tasks WHERE id=$id AND state IN ('retry','failed')", { $id: id });
      if (this.db.getRowsModified() !== 1) return false;
      this.clearTransfer(id);
      return true;
    });
  }

  replacePendingTask(id: string, replacement: NewSyncTask): boolean {
    return this.transaction(() => {
      this.db.run("DELETE FROM tasks WHERE id=$id AND state IN ('queued','retry','failed')", { $id: id });
      if (this.db.getRowsModified() !== 1) return false;
      this.clearTransfer(id);
      this.enqueue(replacement);
      return true;
    });
  }

  updateTaskPayload(id: string, payload: unknown): void {
    this.db.run("UPDATE tasks SET payload=$payload WHERE id=$id", { $id: id, $payload: JSON.stringify(payload) });
  }

  updateTaskPlan(id: string, nid: string | undefined, payload: unknown): void {
    this.db.run("UPDATE tasks SET nid=$nid,payload=$payload WHERE id=$id", {
      $id: id, $nid: nid ?? null, $payload: JSON.stringify(payload),
    });
  }

  retargetRunningRename(id: string, replacement: NewSyncTask): void {
    this.db.run(`UPDATE tasks SET kind='local-rename',path=$path,nid=$nid,payload=$payload
      WHERE id=$id AND state='running' AND kind IN ('rename','move')`, {
      $id: id, $path: normalizeVaultPath(replacement.path), $nid: replacement.nid ?? null,
      $payload: JSON.stringify(replacement.payload),
    });
  }

  getTransferSession(taskId: string): { tid: string; endpoint: string; ticket: string; fileHash: string; finalTicket?: string } | undefined {
    const row = rowObject<Record<string, unknown>>(this.db, "SELECT * FROM transfer_state WHERE task_id=$id", { $id: taskId });
    if (!row) return undefined;
    return { tid: String(row.tid), endpoint: String(row.endpoint), ticket: String(row.ticket), fileHash: String(row.file_hash),
      finalTicket: row.final_ticket == null ? undefined : String(row.final_ticket) };
  }

  saveTransferSession(taskId: string, session: { tid: string; endpoint: string; ticket: string; fileHash: string; finalTicket?: string }): void {
    this.db.run(`INSERT INTO transfer_state(task_id,tid,endpoint,ticket,file_hash,final_ticket,updated_at)
      VALUES($id,$tid,$endpoint,$ticket,$hash,$final,$at)
      ON CONFLICT(task_id) DO UPDATE SET tid=excluded.tid,endpoint=excluded.endpoint,ticket=excluded.ticket,
      file_hash=excluded.file_hash,final_ticket=excluded.final_ticket,updated_at=excluded.updated_at`, {
      $id: taskId, $tid: session.tid, $endpoint: session.endpoint, $ticket: session.ticket,
      $hash: session.fileHash, $final: session.finalTicket ?? null, $at: Date.now(),
    });
  }

  completedTransferBlocks(taskId: string): Set<number> {
    const query = this.db.exec("SELECT block_index FROM transfer_blocks WHERE task_id=$id AND completed=1", { $id: taskId })[0];
    return new Set(query?.values.map((row) => Number(row[0])) ?? []);
  }

  completeTransferBlock(taskId: string, blockIndex: number): void {
    this.db.run(`INSERT INTO transfer_blocks(task_id,block_index,completed) VALUES($id,$index,1)
      ON CONFLICT(task_id,block_index) DO UPDATE SET completed=1`, { $id: taskId, $index: blockIndex });
  }

  clearTransfer(taskId: string): void {
    this.transaction(() => {
      this.db.run("DELETE FROM transfer_blocks WHERE task_id=$id", { $id: taskId });
      this.db.run("DELETE FROM transfer_state WHERE task_id=$id", { $id: taskId });
    });
  }

  recordConflict(originalPath: string, conflictPath: string): void {
    this.db.run(`INSERT INTO conflicts(original_path,conflict_path,created_at,resolved)
      SELECT $original,$conflict,$at,0 WHERE NOT EXISTS (SELECT 1 FROM conflicts WHERE conflict_path=$conflict)`, {
      $original: originalPath, $conflict: conflictPath, $at: Date.now(),
    });
  }

  listUnresolvedConflicts(): SyncConflict[] {
    const query = this.db.exec("SELECT id,original_path,conflict_path,created_at FROM conflicts WHERE resolved=0 ORDER BY created_at DESC,id DESC")[0];
    if (!query) return [];
    return query.values.map((values) => {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      return { id: Number(row.id), originalPath: String(row.original_path),
        conflictPath: String(row.conflict_path), createdAt: Number(row.created_at) };
    });
  }

  unresolvedConflictCount(): number {
    return Number(rowObject<Record<string, unknown>>(this.db,
      "SELECT COUNT(*) AS count FROM conflicts WHERE resolved=0", {})?.count ?? 0);
  }

  resolveConflict(id: number): boolean {
    this.db.run("UPDATE conflicts SET resolved=1 WHERE id=$id AND resolved=0", { $id: id });
    return this.db.getRowsModified() === 1;
  }

  enqueue(task: NewSyncTask): void {
    const normalizedPath = normalizeVaultPath(task.path);
    const existing = rowObject<Record<string, unknown>>(this.db,
      "SELECT id FROM tasks WHERE kind=$kind AND path=$path AND state IN ('queued','running','retry','failed') LIMIT 1",
      { $kind: task.kind, $path: normalizedPath });
    if (existing) return;
    this.db.run(`INSERT INTO tasks(id,kind,path,nid,state,expected_local_hash,expected_remote_version,attempt,next_run_at,payload)
      VALUES($id,$kind,$path,$nid,'queued',$hash,$version,0,$next,$payload)
      ON CONFLICT(id) DO NOTHING`, {
      $id: task.id, $kind: task.kind, $path: normalizedPath, $nid: task.nid ?? null,
      $hash: task.expectedLocalHash ?? null, $version: task.expectedRemoteVersion ?? null,
      $next: task.nextRunAt ?? Date.now(), $payload: JSON.stringify(task.payload ?? {}),
    });
  }

  markTaskRunning(id: string): void {
    this.db.run("UPDATE tasks SET state='running' WHERE id=$id AND state IN ('queued','retry')", { $id: id });
  }

  claimNextRunnableTask(now = Date.now(), kinds?: TaskKind[]): SyncTask | undefined {
    const kindClause = kinds?.length ? ` AND kind IN (${kinds.map((_, index) => `$kind${index}`).join(",")})` : "";
    const params: Record<string, string | number> = { $now: now };
    kinds?.forEach((kind, index) => { params[`$kind${index}`] = kind; });
    return this.transaction(() => {
      const row = rowObject<Record<string, unknown>>(this.db,
        `SELECT id FROM tasks WHERE state IN ('queued','retry') AND next_run_at<=$now${kindClause}
         ORDER BY next_run_at,rowid LIMIT 1`, params);
      if (!row) return undefined;
      this.db.run("UPDATE tasks SET state='running' WHERE id=$id AND state IN ('queued','retry')", { $id: String(row.id) });
      if (this.db.getRowsModified() !== 1) return undefined;
      const claimed = rowObject<Record<string, unknown>>(this.db, "SELECT * FROM tasks WHERE id=$id", { $id: String(row.id) });
      return claimed ? this.taskFromRow(claimed) : undefined;
    });
  }

  completeTask(id: string): void { this.db.run("UPDATE tasks SET state='done',last_error=NULL WHERE id=$id", { $id: id }); }

  deferTask(id: string, message: string): void {
    this.db.run("UPDATE tasks SET state='queued',next_run_at=0,last_error=$error WHERE id=$id AND state='running'",
      { $id: id, $error: message });
  }

  requeueStaleCompletedRecycleTasks(
    remoteNidsByPath: ReadonlyMap<string, string>,
    localPaths: ReadonlySet<string>,
  ): number {
    const remote = new Map([...remoteNidsByPath].map(([path, nid]) => [
      normalizeVaultPath(path).toLocaleLowerCase("en-US"), nid,
    ]));
    const local = new Set([...localPaths].map((path) => normalizeVaultPath(path).toLocaleLowerCase("en-US")));
    const query = this.db.exec("SELECT * FROM tasks WHERE kind='recycle' AND state='done' ORDER BY rowid")[0];
    if (!query) return 0;
    const tasks = query.values.map((values) => {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      return this.taskFromRow(row);
    });
    let restored = 0;
    this.transaction(() => {
      for (const task of tasks) {
        const key = normalizeVaultPath(task.path).toLocaleLowerCase("en-US");
        if (!task.nid || remote.get(key) !== task.nid || local.has(key)) continue;
        const payload = task.payload as { remote?: SyncSnapshot; base?: SyncSnapshot };
        const snapshot = payload.remote ?? payload.base;
        if (snapshot?.kind !== "file" && snapshot?.kind !== "directory") continue;
        this.putBase(task.path, snapshot);
        this.db.run("UPDATE tasks SET state='queued',next_run_at=0,last_error=NULL WHERE id=$id", { $id: task.id });
        restored++;
      }
    });
    return restored;
  }

  failTask(id: string, error: string, retryAt?: number): void {
    this.db.run("UPDATE tasks SET state=$state,attempt=attempt+1,next_run_at=$next,last_error=$error WHERE id=$id", {
      $state: retryAt === undefined ? "failed" : "retry", $next: retryAt ?? Date.now(), $error: error.slice(0, 1000), $id: id,
    });
  }

  recoverInterruptedTasks(): number {
    this.db.run("UPDATE tasks SET state='retry',attempt=attempt+1,next_run_at=0,last_error='Interrupted by shutdown' WHERE state='running'");
    return this.db.getRowsModified();
  }

  listTransferTasks(): SyncTask[] {
    const query = this.db.exec(`SELECT * FROM tasks
      WHERE kind IN ('upload','download') AND state IN ('queued','running','retry','failed')
      ORDER BY rowid`)[0];
    if (!query) return [];
    return query.values.map((values) => {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      return this.taskFromRow(row);
    });
  }

  listPendingTasks(): SyncTask[] {
    const query = this.db.exec(`SELECT * FROM tasks
      WHERE state IN ('queued','running','retry','failed') ORDER BY rowid`)[0];
    if (!query) return [];
    return query.values.map((values) => {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      return this.taskFromRow(row);
    });
  }

  listFailedTasks(): SyncTask[] {
    const query = this.db.exec(`SELECT * FROM tasks
      WHERE state IN ('retry','failed') ORDER BY rowid`)[0];
    if (!query) return [];
    return query.values.map((values) => {
      const row = Object.fromEntries(query.columns.map((column, index) => [column, values[index]]));
      return this.taskFromRow(row);
    });
  }

  removeObsoleteRecycleTasks(existingRemotePaths: ReadonlySet<string>): number {
    const existing = new Set([...existingRemotePaths].map((path) => normalizeVaultPath(path).toLocaleLowerCase("en-US")));
    const query = this.db.exec("SELECT id,path FROM tasks WHERE kind='recycle' AND state IN ('queued','retry','failed')")[0];
    if (!query) return 0;
    const ids = query.values.filter((row) => !existing.has(normalizeVaultPath(String(row[1])).toLocaleLowerCase("en-US")))
      .map((row) => String(row[0]));
    if (ids.length > 0) this.removeTasks(ids);
    return ids.length;
  }

  removeObsoleteLocalTasks(existingLocalPaths: ReadonlySet<string>): number {
    const existing = new Set([...existingLocalPaths].map((path) => normalizeVaultPath(path).toLocaleLowerCase("en-US")));
    const query = this.db.exec("SELECT id,path FROM tasks WHERE kind IN ('upload','mkdir') AND state IN ('queued','retry','failed')")[0];
    if (!query) return 0;
    const ids = query.values.filter((row) => !existing.has(normalizeVaultPath(String(row[1])).toLocaleLowerCase("en-US")))
      .map((row) => String(row[0]));
    this.removeTasks(ids);
    return ids.length;
  }

  removeTasks(ids: readonly string[]): void {
    this.transaction(() => {
      for (const id of ids) {
        this.clearTransfer(id);
        this.db.run("DELETE FROM tasks WHERE id=$id AND state IN ('queued','retry','failed')", { $id: id });
      }
    });
  }

  nextRunnableTask(now = Date.now(), kinds?: TaskKind[]): SyncTask | undefined {
    const kindClause = kinds?.length ? ` AND kind IN (${kinds.map((_, index) => `$kind${index}`).join(",")})` : "";
    const params: Record<string, string | number> = { $now: now };
    kinds?.forEach((kind, index) => { params[`$kind${index}`] = kind; });
    const row = rowObject<Record<string, unknown>>(this.db,
      `SELECT * FROM tasks WHERE state IN ('queued','retry') AND next_run_at<=$now${kindClause} ORDER BY next_run_at,rowid LIMIT 1`, params);
    if (!row) return undefined;
    return this.taskFromRow(row);
  }

  private taskFromRow(row: Record<string, unknown>): SyncTask {
    return { id: String(row.id), kind: row.kind as TaskKind, path: normalizeVaultPath(String(row.path)),
      nid: row.nid == null ? undefined : String(row.nid), state: row.state as TaskState,
      expectedLocalHash: row.expected_local_hash == null ? undefined : String(row.expected_local_hash),
      expectedRemoteVersion: row.expected_remote_version == null ? undefined : Number(row.expected_remote_version),
      attempt: Number(row.attempt), nextRunAt: Number(row.next_run_at), payload: JSON.parse(String(row.payload)),
      lastError: row.last_error == null ? undefined : String(row.last_error) };
  }

  

  

  

  getLastSuccessfulSync(): number | undefined {
    const row = rowObject<Record<string, unknown>>(this.db, "SELECT value FROM sync_state WHERE key='last_success'", {});
    return row ? Number(row.value) : undefined;
  }

  setLastSuccessfulSync(at: number): void {
    if (!Number.isFinite(at) || at < 0) throw new Error("Invalid synchronization timestamp");
    this.db.run("INSERT INTO sync_state(key,value) VALUES('last_success',$at) ON CONFLICT(key) DO UPDATE SET value=excluded.value", { $at: at });
  }

  clearProductionBinding(): void {
    this.transaction(() => {
      this.resetSyncState();
      this.db.run("DELETE FROM confirmed_bindings");
      this.db.run("DELETE FROM sync_state");
    });
  }

  export(): Uint8Array { return this.db.export(); }
  close(): void { this.db.close(); }
}
