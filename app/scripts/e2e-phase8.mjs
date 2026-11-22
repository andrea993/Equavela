// Phase 8 checks in the real desktop app (Tauri + WebView2 + Julia kernel), driven with real key and
// mouse events through the DevTools protocol:
//   1. regions typed on a temp .eqv, Ctrl+S, the file read back, the file reopened: same regions and results;
//      the dirty star appears on an edit and clears on save;
//   2. arrow keys move the crosshair into a math region (it is edited) and out of it again;
//   3. a click on a plot placeholder puts the caret in it and typing works (no region drag);
//   4. navigator.keyboard.getLayoutMap() for BracketLeft, Semicolon, Slash and BracketRight (logged);
//   5. autosave: the recovery file appears after 30 s, the app is killed, the restart offers it, Restore
//      brings the worksheet back modified, Ctrl+S deletes the recovery file;
//   6. closing the window of a modified worksheet asks (Cancel keeps the app, Don't save quits).
// The native Save As dialog is never driven: the worksheet is a temp copy that already has a file.
// Needs a debug build (`pnpm --dir app tauri build --debug --no-bundle`), run from the repository root:
//   node app/scripts/e2e-phase8.mjs [--skip-autosave] [outDir]
// Exit code = number of failed checks.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, keyboard, SHIFT } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const args = process.argv.slice(2);
const skipAutosave = args.includes("--skip-autosave");
const out = args.filter((a) => !a.startsWith("--")).at(-1) ?? "app/scripts/out";
mkdirSync(out, { recursive: true });

const dir = mkdtempSync(join(tmpdir(), "equavela-phase8-")).replaceAll("\\", "/");
const file = `${dir}/work.eqv`;
const recovery = `${dir}/.work.eqv.recovery`;
writeFileSync(
  file,
  "format: equavela-worksheet/3\npage:\n  size: A4\n  margins: {top: 72, right: 54, bottom: 72, left: 54}\nregions: []\n",
);

let b;
let h;
let k;
let failed = 1;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};

async function launch(port) {
  b = await startApp({ port, args: [file] });
  k = keyboard(b);
  h = harness(b);
  await h.until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
}
/** Whether the process is still running (`tasklist` exits 0 either way: look at its output). */
const alive = (pid) => execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).includes(`"${pid}"`);
const tabs = () => b.eval(`[...document.querySelectorAll('.doc-tab-name')].map((e) => e.textContent)`);
const activeTab = () => b.eval(`document.querySelector('.doc-tab.active .doc-tab-name')?.textContent ?? ''`);
const star = async () => /\*/.test(await activeTab());
/** Presses the first button (or tab) whose text is `label`, with a real mouse click. */
async function clickText(selector, label) {
  const point = await b.eval(`(() => {
    const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => [x.textContent.trim(), x.getAttribute("aria-label"), x.getAttribute("title")].includes(${JSON.stringify(label)}));
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  })()`);
  if (!point) throw new Error(`no ${selector} with text ${label}`);
  await b.click(...point);
}
const snapshot = () =>
  b.eval(`[...document.querySelectorAll('[data-kind=math]')].map((e) => [e.querySelector('.math')?.textContent, e.querySelector('[data-testid=result]')?.textContent ?? null])`);
const dialog = () => b.eval(`document.querySelector('[role=alertdialog]')?.textContent ?? null`);
const editingRegions = () => b.eval(`[...document.querySelectorAll('[data-region-id].editing')].map((e) => e.dataset.regionId)`);

try {
  await launch(9694);
  check("kernel ready", await h.idle(240000), await h.kernelStatus());
  check("the temp worksheet is open", (await activeTab()).startsWith("work"), await activeTab());
  check("a freshly opened worksheet is not modified", !(await star()));

  // ---- 1. typing, saving, reopening ---------------------------------------------------------
  await b.click(...(await h.blankPoint(1, 0)));
  for (const text of ["a:3", "b:a+4", "b=", "a*b="]) {
    await k.type(text);
    await k.named("Enter");
    await b.sleep(250);
    await h.idle();
  }
  const typed = await snapshot();
  console.log("typed:", JSON.stringify(typed));
  check("four regions typed, results shown", typed.length === 4 && typed[2][1] === "7" && typed[3][1] === "21", JSON.stringify(typed));
  check("the dirty star appears after an edit", await h.until(star, 3000), await activeTab());
  await b.shot(`${out}/phase8-typed.png`, { x: 0, y: 0, width: 1280, height: 800 });
  await k.chord("s");
  check("Ctrl+S clears the dirty star", await h.until(async () => !(await star()), 8000), await activeTab());
  const saved = readFileSync(file, "utf8");
  check("the file holds the typed regions in canonical form", /math: "a := 3"/.test(saved) && /math: "b := a \+ 4"/.test(saved) && /math: "b ="/.test(saved) && /math: "a·b ="/.test(saved), saved.split("\n").filter((l) => /math:/.test(l)).join(" | "));
  check("no recovery file after a save", !existsSync(recovery));

  // reopen the file through the test hook (the Open command shows the native dialog, which a driver cannot drive): same regions and results
  await b.eval(`void window.__equavela.openPath(${JSON.stringify(file)})`);
  check("the file opens as a second tab", await h.until(async () => (await tabs()).length === 2, 20000), JSON.stringify(await tabs()));
  await h.idle(240000);
  const reopened = await snapshot();
  check("the reopened worksheet equals the saved one (regions and results)", JSON.stringify(reopened) === JSON.stringify(typed), JSON.stringify(reopened));
  check("the reopened worksheet is not modified", !(await star()));
  // closing a clean tab asks nothing
  await k.chord("w");
  check("Ctrl+W closes a clean tab without a question", (await h.until(async () => (await tabs()).length === 1, 5000)) && (await dialog()) === null);

  // ---- 2. arrow keys and the crosshair --------------------------------------------------------
  await b.sleep(300);
  const crosshairBox = () =>
    b.eval(`(() => { const r = document.querySelector('[data-testid=crosshair]')?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top)] : null; })()`);
  const start = await crosshairBox();
  await k.named("ArrowUp");
  const up = await crosshairBox();
  check("ArrowUp moves the crosshair up by one grid step", !!start && !!up && up[1] < start[1] && up[0] === start[0], `${start} -> ${up}`);
  await k.named("ArrowDown");
  const down = await crosshairBox();
  check("ArrowDown moves it back", !!down && down[1] === start[1], `${down}`);
  let entered = [];
  for (let i = 0; i < 40 && entered.length === 0; i++) {
    await k.named("ArrowUp", SHIFT);
    entered = await editingRegions();
  }
  check("walking up enters the lowest math region (it is edited)", entered.length === 1, JSON.stringify(entered));
  await b.shot(`${out}/phase8-entered.png`, { x: 0, y: 0, width: 1280, height: 800 });
  await k.named("ArrowLeft");
  await b.sleep(300);
  check("ArrowLeft at the left edge leaves the region: not edited, crosshair back", (await editingRegions()).length === 0 && !!(await crosshairBox()));
  const outside = await crosshairBox();
  await k.named("ArrowRight");
  const moved = await crosshairBox();
  check("the next arrow moves the crosshair again (no new region entered from outside)", !!moved && moved[0] > outside[0], `${outside} -> ${moved}`);
  await k.named("ArrowLeft");
  await k.named("ArrowLeft");
  check("the star is still clear: moving around does not modify", !(await star()));

  // ---- 3. a click on a plot placeholder -----------------------------------------------------
  await clickText(".ribbon-tabs [role=tab]", "Plots");
  await b.sleep(300);
  await clickText(".ribbon button", "XY Plot");
  check("XY Plot adds a plot region", await h.until(() => h.q("[data-kind=plot]"), 5000));
  await h.idle();
  const plotId = await b.eval(`document.querySelector('[data-kind=plot]')?.dataset.regionId`);
  const before = await b.eval(`(() => { const r = document.querySelector('[data-kind=plot]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`);
  const slots = await b.eval(`document.querySelectorAll('[data-region-id="${plotId}"] [data-testid=plot-slot]').length`);
  check("the plot has six placeholder slots", slots === 6, String(slots));
  // press the first slot (y max): a real mouse click
  const slot = await b.eval(`(() => { const r = document.querySelector('[data-region-id="${plotId}"] [data-testid=plot-slot]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await b.click(...slot);
  check("the click puts the caret in the slot (an inline math has the focus)", await b.eval(`document.activeElement?.closest('[data-testid=inline-math]') !== null || document.activeElement?.matches('[data-testid=inline-math]')`));
  await k.type("2");
  await b.sleep(200);
  const typedSlot = await b.eval(`document.querySelector('[data-region-id="${plotId}"] [data-testid=plot-slot] [data-testid=inline-math]')?.textContent ?? ''`);
  check("typing goes into the slot", typedSlot.includes("2"), JSON.stringify(typedSlot));
  const after = await b.eval(`(() => { const r = document.querySelector('[data-kind=plot]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; })()`);
  check("the region did not move (no drag)", before[0] === after[0] && before[1] === after[1], `${before} -> ${after}`);
  await k.named("Escape");
  await b.sleep(300);
  await b.shot(`${out}/phase8-plot-slot.png`, { x: 0, y: 0, width: 1280, height: 800 });
  check("the slot keeps its text after Escape", (await b.eval(`document.querySelector('[data-region-id="${plotId}"] [data-testid=plot-slot]')?.textContent ?? ''`)).includes("2"));

  // ---- 4. the keyboard layout map -------------------------------------------------------------
  const layout = await b.eval(`(async () => {
    const map = await navigator.keyboard.getLayoutMap();
    const out = {};
    for (const code of ["BracketLeft", "Semicolon", "Slash", "BracketRight"]) out[code] = map.get(code) ?? null;
    return { map: out, size: map.size, language: navigator.language };
  })()`);
  console.log("getLayoutMap:", JSON.stringify(layout));
  check("navigator.keyboard.getLayoutMap() answers", !!layout && layout.size > 0, JSON.stringify(layout));

  // ---- 5. autosave and recovery ---------------------------------------------------------------
  if (!skipAutosave) {
    check("modified before the autosave", await star(), await activeTab());
    check("no recovery file yet", !existsSync(recovery));
    check("the recovery file appears within the autosave interval (30 s)", await h.until(async () => existsSync(recovery), 45000));
    const backup = existsSync(recovery) ? readFileSync(recovery, "utf8") : "";
    check("the recovery file holds the edit and the worksheet file is untouched", /plot:/.test(backup) && !/plot:/.test(readFileSync(file, "utf8")));
    check("the star is still there (autosave does not save)", await star());
    await b.close(); // the process is killed: a crash
    await new Promise((r) => setTimeout(r, 1500));
    check("the recovery file survives the crash", existsSync(recovery));
    await launch(9695);
    check("restart: the app asks about the newer recovery file", await h.until(async () => (await dialog()) !== null, 20000), String(await dialog()));
    await b.shot(`${out}/phase8-restore-prompt.png`, { x: 0, y: 0, width: 1280, height: 800 });
    await clickText("[role=alertdialog] button", "Restore");
    check("Restore opens the recovered worksheet", await h.until(() => h.q("[data-kind=plot]"), 20000));
    check("the restored worksheet is modified", await star(), await activeTab());
    check("it keeps the file's name", (await activeTab()).startsWith("work"), await activeTab());
    await h.idle(240000);
    await k.chord("s");
    check("Ctrl+S clears the star", await h.until(async () => !(await star()), 8000));
    check("Save deleted the recovery file", await h.until(async () => !existsSync(recovery), 3000));
    check("the file now holds the plot", /plot:/.test(readFileSync(file, "utf8")));
  }

  // ---- 6. closing the window with a modified worksheet ------------------------------------------
  await b.click(...(await h.blankPoint(1, 0)));
  await k.type("q:1");
  await k.named("Enter");
  check("modified again", await h.until(star, 3000));
  const pid = b.pid;
  const closeWindow = () =>
    execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).CloseMainWindow() | Out-Null`], { stdio: "ignore" });
  closeWindow();
  check("closing the window asks first", await h.until(async () => (await dialog()) !== null, 10000), String(await dialog()));
  await clickText("[role=alertdialog] button", "Cancel");
  await b.sleep(800);
  check("Cancel keeps the app and the worksheet", alive(pid) && (await dialog()) === null && (await star()));
  closeWindow();
  await h.until(async () => (await dialog()) !== null, 10000);
  await clickText("[role=alertdialog] button", "Don't save");
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await new Promise((r) => setTimeout(r, 250));
    gone = !alive(pid);
  }
  check("Don't save closes the window and the app exits", gone);
  check("the unsaved region is not in the file", !/q := 1/.test(readFileSync(file, "utf8")));
  check("no recovery file is left after a discarded close", !existsSync(recovery));
  failed = 0;
} catch (error) {
  console.log("ERROR", error.stack ?? error);
} finally {
  const failedChecks = results.filter((x) => !x).length;
  console.log(`\n${results.length - failedChecks}/${results.length} checks passed`);
  if (b?.logs?.length) console.log("page errors:", b.logs);
  try {
    // The app may be gone already (a closed window): do not wait for a socket that is dead.
    await Promise.race([b?.close(), new Promise((r) => setTimeout(r, 4000))]);
    if (b?.pid && alive(b.pid)) execFileSync("taskkill", ["/PID", String(b.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(failed || failedChecks);
}
