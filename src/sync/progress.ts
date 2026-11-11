import { isSuccessfulSyncMessage } from "./outcome.js";

export type TransferDirection = "upload" | "download";
export type TransferState = "queued" | "transferring" | "completed" | "failed";

export interface FileTransferProgress {
  id: string;
  direction: TransferDirection;
  path: string;
  completedBytes: number;
  totalBytes: number;
  state: TransferState;
  error?: string;
}

export interface TransferSummary {
  totalBytes: number;
  completedBytes: number;
  percent: number;
  activePath?: string;
  queuedCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
}

export function summarizeTransfers(transfers: readonly FileTransferProgress[]): TransferSummary {
  const totalBytes = transfers.reduce((sum, transfer) => sum + Math.max(0, transfer.totalBytes), 0);
  const completedBytes = transfers.reduce((sum, transfer) => sum + Math.min(
    Math.max(0, transfer.completedBytes), Math.max(0, transfer.totalBytes)), 0);
  const active = transfers.find((transfer) => transfer.state === "transferring")
    ?? transfers.find((transfer) => transfer.state === "queued");
  return {
    totalBytes,
    completedBytes,
    percent: totalBytes === 0 ? (transfers.length === 0 ? 0
      : Math.round(transfers.filter(item => item.state === "completed").length / transfers.length * 100))
      : Math.round(completedBytes / totalBytes * 100),
    activePath: active?.path,
    queuedCount: transfers.filter((item) => item.state === "queued").length,
    activeCount: transfers.filter((item) => item.state === "transferring").length,
    completedCount: transfers.filter((item) => item.state === "completed").length,
    failedCount: transfers.filter((item) => item.state === "failed").length,
  };
}

/** One display value for the whole run; byte delivery alone does not finish a sync. */
export function overallTransferProgress(transfers: readonly FileTransferProgress[], status: { phase: string; message: string }):
  { summary: TransferSummary; percent: number | undefined } {
  const summary = summarizeTransfers(transfers);
  const completed = status.phase === "idle" && isSuccessfulSyncMessage(status.message) && summary.completedCount === transfers.length;
  return { summary, percent: completed ? 100 : transfers.length ? Math.min(99, summary.percent) : undefined };
}

export function transferPresentation(transfer: FileTransferProgress): { percent: number; label: string; icon: string } {
  const percent = transfer.state === "completed" ? 100 : transfer.state === "queued" || transfer.totalBytes <= 0 ? 0
    : Math.min(99, Math.max(0, Math.round(transfer.completedBytes / transfer.totalBytes * 100)));
  const labels: Record<TransferState, string> = { queued: "等待中", transferring: "同步中", failed: "失败", completed: "已完成" };
  const icons: Record<TransferState, string> = { queued: "clock", transferring: "refresh-cw", failed: "circle-alert", completed: "circle-check" };
  return { percent, label: labels[transfer.state], icon: icons[transfer.state] };
}

/** Stable linear partition: active files stay above queued/failed files and finished history. */
export function groupTransfers(transfers: readonly FileTransferProgress[], query = ""):
  { pending: FileTransferProgress[]; completed: FileTransferProgress[] } {
  const groups: Record<TransferState, FileTransferProgress[]> = { transferring: [], queued: [], failed: [], completed: [] };
  const normalized = query.trim().toLowerCase();
  for (const item of transfers) {
    if (!normalized || item.path.toLowerCase().includes(normalized)) groups[item.state].push(item);
  }
  return { pending: [...groups.transferring, ...groups.queued, ...groups.failed], completed: groups.completed };
}

export class TransferProgressTracker {
  private readonly items = new Map<string, FileTransferProgress>();

  queue(id: string, direction: TransferDirection, path: string, totalBytes: number): void {
    if (this.items.has(id)) return;
    this.items.set(id, { id, direction, path, completedBytes: 0,
      totalBytes: Math.max(0, totalBytes), state: "queued" });
  }

  start(id: string): void { this.change(id, (item) => ({ ...item, state: "transferring", error: undefined })); }

  update(id: string, completedBytes: number, totalBytes: number): void {
    this.change(id, (item) => {
      const total = Math.max(0, totalBytes);
      return { ...item, completedBytes: Math.min(Math.max(0, completedBytes), total), totalBytes: total,
        state: "transferring", error: undefined };
    });
  }

  complete(id: string): void {
    this.change(id, (item) => ({ ...item, completedBytes: item.totalBytes, state: "completed", error: undefined }));
  }

  fail(id: string, error: string): void { this.change(id, (item) => ({ ...item, state: "failed", error })); }
  remove(id: string): void { this.items.delete(id); }
  reset(): void { this.items.clear(); }
  snapshot(): FileTransferProgress[] { return [...this.items.values()].map((item) => ({ ...item })); }

  private change(id: string, update: (item: FileTransferProgress) => FileTransferProgress): void {
    const item = this.items.get(id);
    if (item) this.items.set(id, update(item));
  }
}
