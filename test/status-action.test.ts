import { describe, expect, it } from "vitest";
import { sideStatusAction } from "../src/ui/status-action.js";

describe("status sidebar action", () => {
  it("uses the persisted pause state instead of transient status phases", () => {
    expect(sideStatusAction(true, "error")).toEqual({ label: "恢复", kind: "resume" });
    expect(sideStatusAction(false, "error")).toEqual({ label: "重新同步", kind: "retry" });
    expect(sideStatusAction(false, "paused")).toEqual({ label: "重新同步", kind: "retry" });
    expect(sideStatusAction(false, "idle")).toEqual({ label: "暂停", kind: "pause" });
  });
});
