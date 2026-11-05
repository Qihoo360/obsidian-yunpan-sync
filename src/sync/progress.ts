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
    percent: totalBytes === 0 ? (transfers.length === 0 ? 0 : 100) : Math.round(completedBytes / totalBytes * 100),
    activePath: active?.path,
    queuedCount: transfers.filter((item) => item.state === "queued").length,
    activeCount: transfers.filter((item) => item.state === "transferring").length,
    completedCount: transfers.filter((item) => item.state === "completed").length,
    failedCount: transfers.filter((item) => item.state === "failed").length,
  };
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
