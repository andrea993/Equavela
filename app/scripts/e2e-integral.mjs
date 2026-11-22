// Real-backend check of Ctrl+Shift+I: in the debug desktop app it inserts the
// integral in a math region, on the layouts of the tables (the chord is the physical key I with
// Ctrl and Shift on both; the app takes the layout from the key events, so the run uses each layout's
// table entry for `integral`). The native key press and the developer tools are checked by
// e2e-devtools-windows.ps1.
// Usage (repository root): node app/scripts/e2e-integral.mjs. Exit code = number of failed checks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, keyboard, killApp } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "equavela-integral-data-"));
const b = await startApp({
  port: 9719,
  env: { EQUAVELA_MULTI_INSTANCE: "1", EQUAVELA_DRIVER_DATA_DIR: dataDir, WEBVIEW2_USER_DATA_FOLDER: join(dataDir, "webview") },
});
const h = harness(b);
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

try {
  await h.until(() => h.q("[data-testid=kernel-status]"), 60000);
  await b.sleep(3000);
  for (const layout of ["en-US", "it-IT"]) {
    const k = keyboard(b, layout);
    await b.eval("document.activeElement?.blur?.()");
    // On the empty crosshair a math chord starts a region and applies there.
    await k.cmd("integral", "math");
    const opened = await h.until(() => b.eval("!!document.querySelector('.editing .math')"), 8000);
    const text = await b.eval("[...document.querySelectorAll('.editing .math')].map((e) => e.textContent).join('|')");
    check(`${layout}: Ctrl+Shift+I inserts the integral`, opened && text.includes("∫"), JSON.stringify(text));
    await k.named("Escape");
    await b.sleep(500);
    // the region stays; the next layout starts another one on the crosshair beside it
  }
} catch (error) {
  failed++;
  console.log("FAIL  " + (error?.stack ?? error));
} finally {
  killApp(b);
}
process.exit(failed);
