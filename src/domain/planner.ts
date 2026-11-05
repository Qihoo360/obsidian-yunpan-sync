export interface SyncSnapshot {
  hash?: string;
  size: number;
  mtime: number;
  kind: "file" | "directory";
  nid?: string;
  version?: number;
}

export type SyncAction =
  | "none"
  | "upload"
  | "download"
  | "conflict"
  | "delete-local"
  | "delete-remote"
  | "drop-base";

export interface SyncDecision {
  action: SyncAction;
  reason: string;
}

export function snapshotsEqual(left: SyncSnapshot | undefined, right: SyncSnapshot | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  if (left.kind === "directory") return true;
  if (left.hash && right.hash) return left.hash.toLowerCase() === right.hash.toLowerCase();
  return left.size === right.size && left.mtime === right.mtime;
}

export function planThreeWay(
  base: SyncSnapshot | undefined,
  local: SyncSnapshot | undefined,
  remote: SyncSnapshot | undefined,
): SyncDecision {
  if (!base) {
    if (local && remote) {
      return snapshotsEqual(local, remote)
        ? { action: "none", reason: "Both sides contain the same untracked item" }
        : { action: "conflict", reason: "Both sides independently created the path" };
    }
    if (local) return { action: "upload", reason: "Local item is new" };
    if (remote) return { action: "download", reason: "Remote item is new" };
    return { action: "none", reason: "Path does not exist" };
  }

  if (!local && !remote) return { action: "drop-base", reason: "Both sides deleted the item" };
  if (!local && remote) {
    return snapshotsEqual(base, remote)
      ? { action: "delete-remote", reason: "Local item was deleted" }
      : { action: "conflict", reason: "Local deletion conflicts with a remote modification" };
  }
  if (local && !remote) {
    return snapshotsEqual(base, local)
      ? { action: "delete-local", reason: "Remote item was deleted" }
      : { action: "conflict", reason: "Remote deletion conflicts with a local modification" };
  }

  const localChanged = !snapshotsEqual(base, local);
  const remoteChanged = !snapshotsEqual(base, remote);
  if (!localChanged && !remoteChanged) return { action: "none", reason: "Path is unchanged" };
  if (localChanged && !remoteChanged) return { action: "upload", reason: "Only local changed" };
  if (!localChanged && remoteChanged) return { action: "download", reason: "Only remote changed" };
  return { action: "conflict", reason: "Both sides changed" };
}
