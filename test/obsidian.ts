import { vi } from "vitest";

export const Platform = { isMobileApp: false, isIosApp: false, isAndroidApp: false, isDesktopApp: true };

export const requestUrl = vi.fn();

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  constructor(path: string, public stat: { ctime: number; mtime: number; size: number }) { super(path); }
}

export class TFolder extends TAbstractFile {}
