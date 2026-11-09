import { dismissKeyboardOnBlankTap } from "./dismiss-keyboard.js";

/** Keep the modal and its action bar inside the keyboard's visible viewport. */
export function trackModalViewport(modal: HTMLElement): () => void {
  const doc = modal.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};
  const viewport = win.visualViewport;
  const stopDismiss = dismissKeyboardOnBlankTap(modal);
  let frame: number | undefined;
  let closed = false;
  let layoutWidth = win.innerWidth;
  let layoutHeight = Math.max(win.innerHeight, doc.documentElement.clientHeight);
  const insets = modal.createDiv({ cls: "yunpan-sync-viewport-insets", attr: { "aria-hidden": "true" } });
  const pixels = (value: string) => Math.max(0, Number.parseFloat(value) || 0);

  const update = () => {
    frame = undefined;
    if (closed) return;
    const currentHeight = Math.max(win.innerHeight, doc.documentElement.clientHeight);
    // Retain the full layout height when the WebView itself also shrinks. This
    // lets native and browser keyboard signals describe the same occlusion.
    layoutHeight = layoutWidth === win.innerWidth ? Math.max(layoutHeight, currentHeight) : currentHeight;
    layoutWidth = win.innerWidth;
    const rootStyle = win.getComputedStyle(doc.documentElement);
    const bodyStyle = win.getComputedStyle(doc.body);
    const keyboardHeight = Math.max(pixels(rootStyle.getPropertyValue("--keyboard-height")),
      pixels(bodyStyle.getPropertyValue("--keyboard-height")));
    const safeStyle = win.getComputedStyle(insets);
    const safeTop = pixels(safeStyle.paddingTop);
    const safeBottom = keyboardHeight > 0 ? 0 : pixels(safeStyle.paddingBottom);
    const offset = Math.max(viewport?.offsetTop ?? 0, safeTop);
    const bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? win.innerHeight),
      keyboardHeight > 0 ? layoutHeight - keyboardHeight : currentHeight - safeBottom);
    const height = Math.max(0, bottom - offset);
    modal.style.setProperty("--yunpan-visible-height", `${height}px`);
    modal.style.setProperty("--yunpan-visible-center", `${offset + height / 2}px`);
    modal.toggleClass("yunpan-sync-compact-viewport", height <= 480);
    modal.toggleClass("yunpan-sync-tight-viewport", height <= 320);

    const active = doc.activeElement;
    if (!active || !modal.contains(active)) return;
    const scroller = active.closest<HTMLElement>(".yunpan-sync-filter-list, .yunpan-sync-directory-list");
    if (!scroller) return;
    const input = active.getBoundingClientRect();
    const area = scroller.getBoundingClientRect();
    // Scroll the editing area only: scrolling the document can move the footer
    // back underneath the keyboard in the Obsidian mobile settings sheet.
    if (input.bottom > area.bottom - 8) scroller.scrollTop += input.bottom - area.bottom + 8;
    else if (input.top < area.top + 8) scroller.scrollTop -= area.top + 8 - input.top;
    if (input.right > area.right - 8) scroller.scrollLeft += input.right - area.right + 8;
    else if (input.left < area.left + 8) scroller.scrollLeft -= area.left + 8 - input.left;
  };
  const schedule = () => { if (!closed && frame === undefined) frame = win.requestAnimationFrame(update); };
  const keyboardEvents = ["keyboardWillShow", "keyboardDidShow", "keyboardWillHide", "keyboardDidHide"];
  // iOS can overlay the keyboard without resizing visualViewport. Obsidian
  // updates the root CSS property and emits native keyboard events instead.
  const observer = new win.MutationObserver(schedule);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
  observer.observe(doc.body, { attributes: true, attributeFilter: ["style", "class"] });
  modal.addClass("yunpan-sync-viewport-modal");
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  keyboardEvents.forEach(event => win.addEventListener(event, schedule));
  modal.addEventListener("focusin", schedule);
  modal.addEventListener("focusout", schedule);
  update();

  return () => {
    closed = true;
    stopDismiss();
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    keyboardEvents.forEach(event => win.removeEventListener(event, schedule));
    observer.disconnect();
    insets.remove();
    modal.removeEventListener("focusin", schedule);
    modal.removeEventListener("focusout", schedule);
    modal.removeClass("yunpan-sync-viewport-modal");
    modal.removeClass("yunpan-sync-compact-viewport");
    modal.removeClass("yunpan-sync-tight-viewport");
    modal.style.removeProperty("--yunpan-visible-height");
    modal.style.removeProperty("--yunpan-visible-center");
  };
}
