export type SideStatusActionKind = "pause" | "resume" | "retry";

export interface SideStatusAction {
  label: string;
  kind: SideStatusActionKind;
}

export function sideStatusAction(paused: boolean, phase: string): SideStatusAction {
  if (paused) return { label: "恢复", kind: "resume" };
  if (phase === "error" || phase === "paused") return { label: "重新同步", kind: "retry" };
  return { label: "暂停", kind: "pause" };
}
