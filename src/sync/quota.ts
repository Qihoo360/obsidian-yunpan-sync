import type { SyncTask } from "../storage/database.js";
import { formatBytes } from "../account/profile.js";
import { OpenApiError } from "../net/openapi-client.js";

export interface SyncQuota {
  isVip: boolean;
  expiresAt?: number;
  availableBytes?: number;
  usedBytes?: number;
  totalBytes?: number;
  enterpriseAvailableBytes?: number;
  enterpriseUsedBytes?: number;
  enterpriseTotalBytes?: number;
}

export type QuotaFailureKind = "membership" | "capacity" | "unknown";
export interface SyncRestriction { kind: QuotaFailureKind; message: string; remainingBytes?: number; requiredBytes?: number }

/** A server rejection can race the local preflight when another device uploads. */
export function syncRestrictionError(error: unknown): SyncPreflightError | undefined {
  if (error instanceof SyncPreflightError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/套餐.*过期|会员.*过期|vip.*expired/i.test(message)) {
    return new SyncPreflightError("membership", "您的会员套餐已过期，暂时无法同步。请前往官网续费后重试。");
  }
  if (/套餐容量不足|云盘.*空间不足|个人空间不足|企业空间不足|cloud.*quota|quota.*exceed/i.test(message) ||
    (error instanceof OpenApiError && /空间不足|容量不足|space|quota/i.test(message))) {
    return new SyncPreflightError("capacity", /剩余 .*本次同步预计新增占用/.test(message)
      ? message : "套餐容量不足，云端可用容量可能已变化。请前往官网扩容后重试。");
  }
  return undefined;
}

export class SyncPreflightError extends Error {
  constructor(
    readonly kind: QuotaFailureKind,
    message: string,
    readonly remainingBytes?: number,
    readonly requiredBytes?: number,
  ) {
    super(message);
    this.name = "SyncPreflightError";
  }
}

function snapshotSize(value: unknown): number | undefined {
  const snapshot = value as { size?: unknown; kind?: string } | undefined;
  if (snapshot?.kind === "directory") return undefined;
  const size = snapshot?.size;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined;
}

function runnable(task: SyncTask, now: number): boolean {
  return task.state === "running" || ((task.state === "queued" || task.state === "retry") && task.nextRunAt <= now);
}

function uploadCandidate(task: SyncTask, now: number, tasks: readonly SyncTask[]): boolean {
  if (!runnable(task, now)) return false;
  const parentId = (task.payload as { derivedFrom?: string }).derivedFrom;
  const parent = parentId ? tasks.find(t => t.id === parentId) : undefined;
  if (parent && !runnable(parent, now)) return false;
  const payload = task.payload as { conflict?: boolean; conflictPlanned?: boolean };
  return task.kind === "upload" || ((task.kind === "download" || task.kind === "local-rename") && payload.conflict === true && !payload.conflictPlanned);
}

/** Estimate only the cloud capacity growth caused by pending upload work. */
export function pendingUploadBytes(tasks: readonly SyncTask[], now = Date.now()): { bytes: number; reliable: boolean } {
  let reliable = true;
  const growth = new Map<string, number>();
  for (const task of tasks) {
    if (!uploadCandidate(task, now, tasks)) continue;
    const payload = task.payload as { local?: unknown; remote?: unknown; conflict?: boolean; remoteDeleted?: boolean; conflictPlanned?: boolean };
    const next = snapshotSize(payload.local);
    const previous = payload.conflict || !payload.remote ? 0 : snapshotSize(payload.remote);
    if (next === undefined || previous === undefined) { reliable = false; continue; }
    const key = task.path.normalize("NFC").toLocaleLowerCase("en-US");
    growth.set(key, Math.max(growth.get(key) ?? 0, Math.max(next - previous, 0)));
  }
  return { bytes: [...growth.values()].reduce((sum, size) => sum + size, 0), reliable };
}

export function availableQuotaBytes(quota: SyncQuota): number | undefined {
  const values: number[] = [];
  const valid = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (valid(quota.availableBytes)) values.push(quota.availableBytes);
  if (valid(quota.totalBytes) && valid(quota.usedBytes)) values.push(quota.totalBytes - quota.usedBytes);
  if (valid(quota.enterpriseAvailableBytes)) values.push(quota.enterpriseAvailableBytes);
  if (valid(quota.enterpriseTotalBytes) && valid(quota.enterpriseUsedBytes)) {
    values.push(quota.enterpriseTotalBytes - quota.enterpriseUsedBytes);
  }
  return values.length ? Math.max(0, Math.min(...values)) : undefined;
}

export function assertSyncQuota(quota: SyncQuota, tasks: readonly SyncTask[], now = Date.now()): void {
  if (quota.expiresAt !== undefined && Number.isFinite(quota.expiresAt) && quota.expiresAt > 0 && quota.expiresAt <= now) {
    throw new SyncPreflightError("membership", "您的会员套餐已过期，暂时无法同步。请前往官网续费后重试。");
  }
  const upload = pendingUploadBytes(tasks, now);
  if (!upload.reliable) {
    throw new SyncPreflightError("unknown", "无法确认本次同步的容量变化，请刷新账户信息后重试。");
  }
  const remaining = availableQuotaBytes(quota);
  if (remaining === undefined && tasks.some(task => uploadCandidate(task, now, tasks))) {
    throw new SyncPreflightError("unknown", "无法确认云盘剩余容量，请刷新账户信息后重试。");
  }
  if (remaining !== undefined && upload.bytes > remaining) {
    throw new SyncPreflightError("capacity",
      `套餐容量不足，剩余 ${formatBytes(remaining)}，本次同步预计新增占用 ${formatBytes(upload.bytes)}。请前往官网扩容后重试。`,
      remaining, upload.bytes);
  }
}
