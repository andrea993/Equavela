// Close requests of the application window: the window X button, Alt+F4 and quitting.
//
// Inside the Tauri webview the window's `close-requested` event is intercepted: the close is
// always prevented first, `confirm` asks about modified worksheets and project text files, and the window is
// destroyed only when it resolves true. In a plain browser (the mock backend) the browser's own
// "leave this page?" prompt is used while `hasUnsaved()` says something is modified.

import { insideTauri } from "./backend";

export type CloseGuard = {
  /** Resolves true when the application may close (everything saved or discarded). */
  confirm: () => Promise<boolean>;
  /** Whether any worksheet or project text file is modified (browser fallback only). */
  hasUnsaved: () => boolean;
};

/** Installs the guard; the returned function removes it. */
export function guardWindowClose(guard: () => CloseGuard): () => void {
  if (!insideTauri()) {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!guard().hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }
  let removed = false;
  let inFlight = false;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
    const current = getCurrentWindow();
    const off = await current.onCloseRequested(async (event) => {
      event.preventDefault();
      if (inFlight) return;
      inFlight = true;
      try {
        if (await guard().confirm()) await current.destroy();
      } finally {
        inFlight = false;
      }
    });
    if (removed) off();
    else unlisten = off;
  });
  return () => {
    removed = true;
    unlisten?.();
  };
}
