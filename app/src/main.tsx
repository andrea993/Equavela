import React, { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/fonts";
import "./styles/chrome.css";
import "./styles/page.css";
import "./styles/math.css";
import "./styles/text.css";

// GUI benchmark: `window.__equavelaPerf.run()` loads the runner on demand, and the
// first drawn region is marked for its "open" figure. Nothing else of the app depends on it.
(window as unknown as { __equavelaPerf?: unknown }).__equavelaPerf = {
  run: async (options?: import("./perf/runner").PerfOptions) => (await import("./perf/runner")).run(options),
  format: async (report: import("./perf/runner").PerfReport) => (await import("./perf/runner")).formatReport(report),
};
const firstRegion = new MutationObserver(() => {
  if (!document.querySelector("[data-region-id]")) return;
  performance.mark("equavela:first-region");
  firstRegion.disconnect();
});
firstRegion.observe(document.documentElement, { childList: true, subtree: true });

// Equavela was called MathMaster: this user's layout and recent files keep their values.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("mathmaster.")) continue;
    const current = `equavela.${key.slice("mathmaster.".length)}`;
    const value = localStorage.getItem(key);
    if (localStorage.getItem(current) === null && value !== null) localStorage.setItem(current, value);
    localStorage.removeItem(key);
  }
} catch {
  // Storage unavailable: the defaults apply.
}

// The interface has drawn: the main window is shown and the startup splash closes.
// An effect, not an animation frame: a hidden window may never get one.
let announced = false;
function Ready() {
  useEffect(() => {
    if (announced || !("__TAURI_INTERNALS__" in window)) return;
    announced = true;
    invoke("app_ready").catch(() => undefined);
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <Ready />
  </React.StrictMode>,
);
