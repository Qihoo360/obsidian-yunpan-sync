/** Dismiss touch keyboards on a blank tap without consuming controls or scroll gestures. */
export function dismissKeyboardOnBlankTap(container: HTMLElement): () => void {
  const doc = container.ownerDocument;
  if (!doc) return () => {};
  const interactive = 'input, textarea, select, button, a, label, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="switch"], [role="checkbox"], [role="textbox"], [tabindex], .clickable-icon, .checkbox-container';
  const editable = 'textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), [contenteditable]:not([contenteditable="false"])';
  let tap: { id: number; x: number; y: number; at: number; input: HTMLElement } | undefined;
  const isBlank = (target: EventTarget | null): boolean => {
    const element = target as HTMLElement | null;
    return !!element?.closest && container.contains(element) && !element.closest(interactive);
  };
  const down = (event: PointerEvent) => {
    tap = undefined;
    if (!event.isPrimary || !["touch", "pen"].includes(event.pointerType) || !isBlank(event.target)) return;
    const input = doc.activeElement as HTMLElement | null;
    if (!input || !container.contains(input) || !input.matches(editable)) return;
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, input };
  };
  const move = (event: PointerEvent) => {
    if (tap && (event.pointerId !== tap.id || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10)) tap = undefined;
  };
  const cancel = () => { tap = undefined; };
  const up = (event: PointerEvent) => {
    const started = tap;
    tap = undefined;
    if (!started || event.pointerId !== started.id || event.timeStamp - started.at > 500 ||
      Math.hypot(event.clientX - started.x, event.clientY - started.y) > 10 ||
      doc.activeElement !== started.input || !isBlank(event.target)) return;
    // Run during the user gesture: iOS WebViews need an explicit blur and may
    // otherwise keep focus when a non-focusable element receives the tap.
    started.input.blur();
  };
  const options = { capture: true, passive: true };
  container.addEventListener("pointerdown", down, options);
  container.addEventListener("pointermove", move, options);
  container.addEventListener("pointerup", up, options);
  container.addEventListener("pointercancel", cancel, options);
  container.addEventListener("scroll", cancel, options);
  return () => {
    cancel();
    container.removeEventListener("pointerdown", down, true);
    container.removeEventListener("pointermove", move, true);
    container.removeEventListener("pointerup", up, true);
    container.removeEventListener("pointercancel", cancel, true);
    container.removeEventListener("scroll", cancel, true);
  };
}
