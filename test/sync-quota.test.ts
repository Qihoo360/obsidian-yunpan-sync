import { describe, expect, it } from "vitest";
import { assertSyncQuota, availableQuotaBytes, pendingUploadBytes, SyncPreflightError } from "../src/sync/quota.js";
import type { SyncTask } from "../src/storage/database.js";

const task = (kind: SyncTask["kind"], path: string, localSize: number, remoteSize = 0, extra: Record<string, unknown> = {}): SyncTask => ({
  id: path + kind,
  kind,
  path,
  payload: { local: { kind: "file", size: localSize }, remote: { kind: "file", size: remoteSize }, ...extra },
  state: "queued",
  attempt: 0,
  nextRunAt: 0,
});

describe("sync quota preflight", () => {
  it("counts new files and only growth for overwrites", () => {
    expect(pendingUploadBytes([
      task("upload", "new.md", 100),
      task("upload", "grow.md", 150, 100),
      task("upload", "shrink.md", 50, 100),
    ])).toEqual({ bytes: 150, reliable: true });
  });

  it("counts conflict copies fully and ignores downloads, renames, and directories", () => {
    expect(pendingUploadBytes([
      task("download", "copy.md", 80, 120, { conflict: true }),
      task("local-rename", "original.md", 60, 0, { conflict: true }),
      task("download", "remote.md", 500),
      task("rename", "renamed.md", 1),
      task("mkdir", "folder", 0),
    ])).toEqual({ bytes: 140, reliable: true });
  });

  it("uses the smallest reliable personal and enterprise quota", () => {
    expect(availableQuotaBytes({ isVip: true, availableBytes: 90, totalBytes: 200, usedBytes: 100, enterpriseTotalBytes: 500, enterpriseUsedBytes: 450 })).toBe(50);
  });

  it("allows exact capacity and rejects only an overage", () => {
    expect(() => assertSyncQuota({ isVip: true, availableBytes: 100 }, [task("upload", "a", 100)])).not.toThrow();
    expect(() => assertSyncQuota({ isVip: true, availableBytes: 99 }, [task("upload", "a", 100)])).toThrowError(SyncPreflightError);
  });

  it("rejects expired members and missing capacity information without guessing", () => {
    expect(() => assertSyncQuota({ isVip: false, availableBytes: 1 }, [task("upload", "a", 1)])).not.toThrow();
    expect(() => assertSyncQuota({ isVip: true, expiresAt: 1000 }, [task("upload", "a", 1)], 2000)).toThrow("会员套餐已过期");
    expect(() => assertSyncQuota({ isVip: true }, [task("upload", "a", 1)])).toThrow("无法确认云盘剩余容量");
  });

  it("does not guess missing or invalid file sizes, including zero-growth uploads without quota", () => {
    for (const size of [undefined, null, -1, NaN, Infinity]) {
      const upload = task("upload", "bad", 0);
      (upload.payload as { local: { size: unknown } }).local.size = size;
      expect(() => assertSyncQuota({ isVip: true, availableBytes: 100 }, [upload])).toThrow("无法确认本次同步");
    }
    expect(() => assertSyncQuota({ isVip: true }, [task("upload", "shrink", 1, 10)])).toThrow("无法确认云盘剩余容量");
    const unknownRemote = task("upload", "remote", 5);
    (unknownRemote.payload as { remote: object }).remote = { kind: "file" };
    expect(() => assertSyncQuota({ isVip: true, availableBytes: 100 }, [unknownRemote])).toThrow("无法确认本次同步");
  });

  it("deduplicates using the largest current estimate and ignores non-runnable retry work", () => {
    const future = { ...task("upload", "future", 200), state: "retry" as const, nextRunAt: Date.now() + 60_000 };
    const failed = { ...task("upload", "failed", 200), state: "failed" as const };
    expect(pendingUploadBytes([task("upload", "note", 3), task("upload", "NOTE", 7), future, failed])).toEqual({ bytes: 7, reliable: true });
  });

  it("ignores invalid quota values, clamps exhausted space and never credits deletes", () => {
    expect(availableQuotaBytes({ isVip: true, availableBytes: NaN, totalBytes: 100, usedBytes: 120 })).toBe(0);
    expect(availableQuotaBytes({ isVip: true, availableBytes: Infinity })).toBeUndefined();
    expect(pendingUploadBytes([task("recycle", "deleted", 0, 200), task("upload", "new", 10)])).toEqual({ bytes: 10, reliable: true });
  });
});
