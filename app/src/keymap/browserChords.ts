// The chords the webview (WebView2, WebKitGTK) gives its own meaning: developer tools, reload, view
// source, the browser's print / save / open / find, its zoom, tabs and history. Equavela is an
// application, not a page: none of them may act (GitHub ). Some are also Equavela's own
// chords (Ctrl+Shift+I is Integral, Ctrl+U is Underline in a text region, Ctrl+P prints, Ctrl+F finds): the
// guard only cancels the **default** action of the webview and never stops the event, so the app's
// handlers still see it and run the app's command.

import type { KeyInput } from "./keymap";

export type BrowserChord =
  | "devtools"
  | "reload"
  | "view-source"
  | "print"
  | "save"
  | "open"
  | "find"
  | "zoom"
  | "window"
  | "history"
  | "caret-browsing"
  | "bookmarks";

/**
 * What the webview would do with this key press, or null when it does nothing of its own. A Ctrl+Alt
 * press is AltGr on the Italian layout (it types characters): it is never a browser chord. Editing keys
 * (Ctrl+A, C, V, X, Z, Y, B, I) and the keys the app owns (Ctrl+K, Ctrl+M) are not in the list.
 */
export function browserChord(ev: KeyInput): BrowserChord | null {
  const ctrl = (ev.ctrlKey ?? false) || (ev.metaKey ?? false);
  const alt = ev.altKey ?? false;
  const shift = ev.shiftKey ?? false;
  if (ev.altGraph || (ev.ctrlKey && alt)) return null;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const code = ev.code;
  if (code === "F12" || key === "F12") return "devtools";
  if (ctrl && shift && (code === "KeyI" || code === "KeyJ" || code === "KeyC")) return "devtools";
  if (ev.metaKey && alt && code === "KeyI") return "devtools";
  if (key === "F5") return "reload";
  if (ctrl && code === "KeyR") return "reload";
  if (ctrl && !shift && code === "KeyU") return "view-source";
  if (ctrl && !shift && code === "KeyP") return "print";
  if (ctrl && !shift && code === "KeyS") return "save";
  if (ctrl && !shift && code === "KeyO") return "open";
  if (key === "F3" || (ctrl && !shift && (code === "KeyF" || code === "KeyG"))) return "find";
  if (ctrl && (code === "Equal" || code === "Minus" || code === "Digit0" || code === "NumpadAdd" || code === "NumpadSubtract" || code === "Numpad0")) {
    return "zoom";
  }
  if (ctrl && (code === "KeyT" || code === "KeyW" || code === "KeyN" || code === "Tab" || code === "PageUp" || code === "PageDown")) return "window";
  if (alt && !ctrl && (code === "ArrowLeft" || code === "ArrowRight" || code === "Home")) return "history";
  if (key === "F7") return "caret-browsing";
  if (ctrl && !shift && (code === "KeyD" || code === "KeyH" || code === "KeyL" || code === "KeyE")) return "bookmarks";
  return null;
}

/**
 * A capture-phase `keydown` handler for the window: cancels the default action of every browser
 * chord and lets the event go on, so the application's own commands for the same chord still run.
 */
export function guardBrowserChords(event: KeyboardEvent): void {
  const input: KeyInput = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    altGraph: event.getModifierState?.("AltGraph") ?? false,
  };
  if (browserChord(input)) event.preventDefault();
}
