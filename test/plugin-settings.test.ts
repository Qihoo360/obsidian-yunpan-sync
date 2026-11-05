import { describe, expect, it, vi } from "vitest";
import { openPluginSettings } from "../src/ui/plugin-settings.js";

describe("plugin settings navigation", () => {
  it("opens Obsidian settings and selects the cloud sync plugin tab", () => {
    const open = vi.fn();
    const openTabById = vi.fn();

    openPluginSettings({ setting: { open, openTabById } }, "yunpan-sync");

    expect(open).toHaveBeenCalledOnce();
    expect(openTabById).toHaveBeenCalledWith("yunpan-sync");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(openTabById.mock.invocationCallOrder[0]!);
  });
});
