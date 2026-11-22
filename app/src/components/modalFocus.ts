// The keyboard of a modal dialog: the dialog in front owns Tab and
// Shift+Tab, takes the keyboard when it opens and gives it back to what had it when it closes.
// One handler for the whole window, so every `role="dialog"` with `aria-modal="true"` behaves alike.

const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
/** What a dialog opens outside its own box (menus, lists, pickers): it keeps the keyboard. */
const PORTALS = '[role="menu"], [role="listbox"], .color-picker, .context-menu';
const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[contenteditable=true]", '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The modal dialog in front: the last one in the document. */
export function frontModal(doc: Document): HTMLElement | null {
  const all = doc.querySelectorAll<HTMLElement>(MODAL);
  return all.length ? all[all.length - 1] : null;
}

/** The controls of a dialog that take the keyboard, in tab order. */
export function focusables(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[hidden], [inert]") && element.getAttribute("aria-hidden") !== "true",
  );
}

/** Installs the handlers on a document; returns the function that removes them. */
export function installModalFocus(doc: Document, focusWorksheetOnEscape?: () => boolean): () => void {
  // What had the keyboard before each open dialog, to give it back on close.
  const openers = new Map<HTMLElement, HTMLElement | null>();
  const dismissedWithEscape = new WeakSet<HTMLElement>();
  let front: HTMLElement | null = null;

  const enter = (dialog: HTMLElement) => {
    // a dialog that placed the keyboard itself keeps it; otherwise its first control.
    setTimeout(() => {
      if (!dialog.isConnected || dialog.contains(doc.activeElement)) return;
      (focusables(dialog)[0] ?? dialog).focus();
    }, 0);
  };
  const sync = () => {
    const next = frontModal(doc);
    if (next === front) return;
    if (next && !openers.has(next)) {
      const had = doc.activeElement instanceof HTMLElement && !next.contains(doc.activeElement) ? doc.activeElement : null;
      openers.set(next, had);
      enter(next);
    }
    for (const [dialog, opener] of [...openers]) {
      if (dialog.isConnected) continue;
      openers.delete(dialog);
      if (!next && dismissedWithEscape.has(dialog) && focusWorksheetOnEscape?.()) continue;
      // back to the opener, unless the keyboard already went somewhere on purpose.
      const lost = doc.activeElement === doc.body || doc.activeElement === null || !doc.activeElement.isConnected;
      if (opener?.isConnected && lost) opener.focus();
    }
    front = next;
  };

  const key = (event: KeyboardEvent) => {
    const dialog = frontModal(doc);
    if (!dialog) return;
    if (dialog !== front) sync();
    const target = event.target;
    const portal = target instanceof Element && target.closest(PORTALS);
    const behind = target instanceof Node && !dialog.contains(target) && !portal;
    if (behind && event.key !== "Tab") {
      // a key pressed with the keyboard behind the dialog (focus events can be late or
      // missing in a window without focus) acts on nothing there; Escape still closes the dialog.
      event.preventDefault();
      event.stopPropagation();
      (focusables(dialog)[0] ?? dialog).focus();
      if (event.key === "Escape") dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return;
    }
    if (event.key === "Escape" && !portal && focusWorksheetOnEscape) {
      event.preventDefault();
      dismissedWithEscape.add(dialog);
      // Escape may have closed a control inside the dialog, or the dialog may be busy.
      setTimeout(() => dismissedWithEscape.delete(dialog), 0);
    }
    if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
    // Tab and Shift+Tab go round the dialog's controls.
    const items = focusables(dialog);
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const at = items.indexOf(doc.activeElement as HTMLElement);
    const inside = dialog.contains(doc.activeElement);
    let next: HTMLElement | null = null;
    if (!inside) next = event.shiftKey ? items[items.length - 1] : items[0];
    else if (event.shiftKey && at <= 0) next = items[items.length - 1];
    else if (!event.shiftKey && at === items.length - 1) next = items[0];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  // a focus that lands behind the dialog (a click on the page, a script) is taken back.
  const focus = (event: FocusEvent) => {
    const dialog = frontModal(doc);
    const target = event.target;
    if (!dialog || !(target instanceof Node) || dialog.contains(target)) return;
    // Menus and pickers a dialog opens float outside it (portals): they keep the keyboard.
    if (target instanceof Element && target.closest(PORTALS)) return;
    // A dialog that closes may hand the keyboard on (the command palette to the Find box) just
    // before it leaves the document: only a dialog still in front a moment later takes it back.
    setTimeout(() => {
      if (frontModal(doc) !== dialog || dialog.contains(doc.activeElement)) return;
      if (doc.activeElement !== target) return;
      (focusables(dialog)[0] ?? dialog).focus();
    }, 0);
  };

  const observer = new MutationObserver(sync);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "role"] });
  doc.addEventListener("keydown", key, true);
  doc.addEventListener("focusin", focus);
  sync();
  return () => {
    observer.disconnect();
    doc.removeEventListener("keydown", key, true);
    doc.removeEventListener("focusin", focus);
  };
}
