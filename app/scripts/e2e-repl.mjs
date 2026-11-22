// Real-backend check of the Julia REPL panel in the debug desktop app:
// sends actual keyboard input to the genuine Julia terminal.
// Needs `pnpm --dir app tauri build --debug --no-bundle` (the exe embeds the frontend).
// Usage (repository root): node app/scripts/e2e-repl.mjs [worksheet.eqv]
// It uses the system clipboard (PowerShell on Windows). Exit code = number of failed checks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, keyboard, killApp, CTRL } from "./real-app.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "equavela-repl-data-"));
// The shared environment folder exists once a package was added; with EQUAVELA_E2E_NO_SHARED=1 it is
// left missing, as in a new installation.
if (!process.env.EQUAVELA_E2E_NO_SHARED) {
  mkdirSync(join(dataDir, "environments", "standalone"), { recursive: true });
  writeFileSync(join(dataDir, "environments", "standalone", "Project.toml"), "[deps]\n");
}
const b = await startApp({
  port: 9716,
  args: process.argv.slice(2),
  env: { EQUAVELA_MULTI_INSTANCE: "1", EQUAVELA_DRIVER_DATA_DIR: dataDir, WEBVIEW2_USER_DATA_FOLDER: join(dataDir, "webview") },
});
// The window of a driven run is not the foreground window: the async clipboard API needs a focused page.
await b.send("Emulation.setFocusEmulationEnabled", { enabled: true });
const k = keyboard(b);
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const setClipboard = (text) => execFileSync("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $env:CLIP"], { env: { ...process.env, CLIP: text } });
const until = async (fn, ms = 60000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await b.sleep(250);
  }
  return false;
};
// xterm keeps the editable line in Julia, not in its hidden browser textarea.
const input = "document.querySelector('.terminal-host textarea')";
const output = () => b.eval(`(async () => {
  const snapshot = await window.__TAURI_INTERNALS__.invoke('terminal_read', { project: null, after: 0 });
  return new TextDecoder().decode(new Uint8Array(snapshot.data));
})()`);
const focusInput = () => b.eval(`${input}.focus()`);
const run = async (code) => {
  await focusInput();
  await k.type(code);
  await k.named("Enter");
};
const shows = (marker, ms = 60000) => until(async () => (await output()).includes(marker), ms);

try {
  await until(() => b.eval("!!document.querySelector('[data-testid=repl-toggle]')"));
  check("terminal starts hidden", await b.eval("!document.querySelector('.repl-panel')"));
  await b.eval("document.querySelector('[data-testid=repl-toggle]').click()");
  check("terminal frontend opens", await until(() => b.eval("!!document.querySelector('.terminal-host .xterm-screen')")));
  check("real Julia prompt appears", await shows("julia>"));

  await run('println("E2E_" * "SUM=", 1+1)');
  check("keyboard input evaluates in Julia", await shows("E2E_SUM=2"));
  await run('x = 3; println("E2E_" * "VALUE=", x^2)');
  check("Julia definitions persist", await shows("E2E_VALUE=9"));

  await focusInput();
  await k.named("Tab");
  check("empty Tab discovers Project", await shows("Project"));
  await k.type("Base.printl");
  await k.named("Tab");
  await k.type('("E2E_" * "COMPLETE")');
  await k.named("Enter");
  check("native module completion works", await shows("E2E_COMPLETE"));

  await run("?sin");
  check("help mode shows documentation", await shows("Compute sine"));
  await focusInput();
  await k.type("]status");
  await k.named("Enter");
  check("package mode targets the user environment", await shows(dataDir));
  await k.named("Backspace");

  await focusInput();
  setClipboard('println("E2E_" * "PASTE=", 77)');
  await b.key("v", { code: "KeyV", vk: 86, modifiers: CTRL, commands: ["paste"] });
  await k.named("Enter");
  check("clipboard paste reaches Julia", await shows("E2E_PASTE=77"));

  await run('println("E2E_" * "BUSY"); sleep(30)');
  check("long command starts", await shows("E2E_BUSY"));
  await b.key("c", { code: "KeyC", vk: 67, modifiers: CTRL });
  check("Ctrl+C interrupts", await shows("InterruptException", 10000));
  await run('println("E2E_" * "ALIVE=", 6*7)');
  check("kernel remains usable after Ctrl+C", await shows("E2E_ALIVE=42"));

  await b.eval("document.querySelector('[data-testid=repl-toggle]').click()");
  check("toggle hides terminal", await until(() => b.eval("!document.querySelector('.repl-panel')")));
  await b.eval("document.querySelector('[data-testid=repl-toggle]').click()");
  check("reopening preserves the Julia session", await shows("E2E_ALIVE=42"));
} catch (error) {
  failed++;
  console.log("FAIL  " + (error?.stack ?? error));
} finally {
  killApp(b);
}
process.exit(failed);
