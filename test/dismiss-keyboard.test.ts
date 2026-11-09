import { describe, expect, it, vi } from "vitest";
import { dismissKeyboardOnBlankTap } from "../src/ui/dismiss-keyboard.js";

function fixture() {
  const doc = { activeElement: null as unknown };
  const container = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    contains: (element: unknown) => nodes.has(element),
  });
  const nodes = new Set<unknown>();
  function element(interactive = false, editable = false) {
    const node = { closest: vi.fn(() => interactive ? node : null), matches: () => editable,
      blur: vi.fn(() => { doc.activeElement = null; }) };
    nodes.add(node);
    return node;
  }
  const input = element(true, true); doc.activeElement = input;
  const blank = element(); const control = element(true);
  const emit = (type: string, target: unknown = blank, properties: Record<string, unknown> = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ target, pointerId: 1, pointerType: "touch", isPrimary: true,
      clientX: 10, clientY: 10, timeStamp: type === "pointerdown" ? 0 : 100, ...properties })) {
      Object.defineProperty(event, key, { value });
    }
    container.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };
  const stop = dismissKeyboardOnBlankTap(container as unknown as HTMLElement);
  return { doc, container, element, input, blank, control, emit, stop };
}

describe("blank tap keyboard dismissal", () => {
  it("explicitly blurs on a touch tap without canceling the event", () => {
    const f = fixture();
    f.emit("pointerdown"); f.emit("pointerup");
    expect(f.input.blur).toHaveBeenCalledOnce();
    expect(f.doc.activeElement).toBeNull(); f.stop();
  });

  it("preserves focus on interactive controls and their descendants", () => {
    const f = fixture();
    f.emit("pointerdown", f.control); f.emit("pointerup", f.control);
    f.emit("pointerdown", f.input); f.emit("pointerup", f.input);
    f.emit("pointerdown"); f.emit("pointerup", f.control);
    expect(f.input.blur).not.toHaveBeenCalled(); f.stop();
  });

  it.each(["pointermove", "pointercancel", "scroll"])("ignores scrolling and canceled gestures (%s)", event => {
    const f = fixture(); f.emit("pointerdown");
    f.emit(event, f.blank, { clientY: 50 });
    f.emit("pointerup");
    expect(f.input.blur).not.toHaveBeenCalled(); f.stop();
  });

  it("rejects drags even if no move event arrives, and ignores long presses", () => {
    const f = fixture();
    f.emit("pointerdown"); f.emit("pointerup", f.blank, { clientX: 25 });
    f.emit("pointerdown"); f.emit("pointerup", f.blank, { timeStamp: 600 });
    expect(f.input.blur).not.toHaveBeenCalled(); f.stop();
  });

  it("does not blur a new input when focus changes during the gesture", () => {
    const f = fixture(); const next = f.element(true, true);
    f.emit("pointerdown"); f.doc.activeElement = next; f.emit("pointerup");
    expect(f.input.blur).not.toHaveBeenCalled(); expect(next.blur).not.toHaveBeenCalled(); f.stop();
  });

  it("ignores mouse, secondary touches and multiple pointers", () => {
    const f = fixture();
    f.emit("pointerdown", f.blank, { pointerType: "mouse" }); f.emit("pointerup");
    f.emit("pointerdown", f.blank, { isPrimary: false }); f.emit("pointerup");
    f.emit("pointerdown"); f.emit("pointerdown", f.blank, { pointerId: 2, isPrimary: false }); f.emit("pointerup");
    expect(f.input.blur).not.toHaveBeenCalled(); f.stop();
  });

  it("limits dismissal to text editing inside the plugin surface", () => {
    const f = fixture(); const outside = { matches: () => true, blur: vi.fn() };
    f.doc.activeElement = outside;
    f.emit("pointerdown"); f.emit("pointerup");
    f.doc.activeElement = f.control;
    f.emit("pointerdown"); f.emit("pointerup");
    expect(outside.blur).not.toHaveBeenCalled(); expect(f.control.blur).not.toHaveBeenCalled(); f.stop();
  });

  it("cleans up pending gestures and permits rebinding without duplicate listeners", () => {
    const f = fixture(); f.emit("pointerdown"); f.stop(); f.emit("pointerup");
    expect(f.input.blur).not.toHaveBeenCalled();
    const stop = dismissKeyboardOnBlankTap(f.container as unknown as HTMLElement);
    f.emit("pointerdown"); f.emit("pointerup");
    expect(f.input.blur).toHaveBeenCalledOnce(); stop();
  });
});
