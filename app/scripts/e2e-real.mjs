// Real-backend smoke scenario: the debug desktop app (Tauri + WebView2 + Julia kernel + SymPy) driven
// through the DevTools protocol with real key and mouse events. Needs `pnpm --dir app tauri build --debug
// --no-bundle` (the exe embeds the frontend, rebuild after changing app/src). Usage (repository root):
//   node app/scripts/e2e-real.mjs [outDir]
// Exit code = number of failed checks. Everything it starts is killed at the end.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startApp, keyboard, CTRL, SHIFT } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const out = process.argv[2] ?? "app/scripts/out";
mkdirSync(out, { recursive: true });
const fixtures = resolve("app/scripts/fixtures/real-smoke").replaceAll("\\", "/");
const b = await startApp({ port: 9691, args: [`${fixtures}/main.eqv`] });
const k = keyboard(b);
const h = harness(b);
const { check, until } = h;
const shot = (name) => b.shot(`${out}/${name}.png`, { x: 0, y: 0, width: 1280, height: 800 });
const typed = async (s) => {
  await k.type(s);
  await k.named("Enter");
  await b.sleep(400);
};
const scrollEnd = async () => {
  await b.eval("document.querySelector('[data-testid=worksheet-area]').scrollTo(0, 1e6)");
  await b.sleep(300);
};
let failed = 1;
try {
  // 1. open: kernel ready, results of every kind
  await until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
  check("real backend (tauri.localhost, no mock badge)", (await b.eval("location.href")).includes("tauri.localhost") && !(await h.q(".mock-badge")));
  check("kernel becomes ready and every region has a result", await h.idle(240000), await h.kernelStatus());
  await h.useLayout("en-US");
  check("M_max = 18.375 kN·m (units with display unit)", (await h.result("m4")) === "18.375kN·m", await h.result("m4"));
  check("A = is a 3x3 matrix", await h.q("[data-region-id=m6] .result-matrix[data-rows='3'][data-cols='3']"));
  check("|A| = −3", (await h.result("m7")) === "−3", await h.result("m7"));
  check("S(10) program = 1.052·10³", (await h.result("m10")) === "1.052·103", await h.result("m10"));
  check("symbolic derivative has a result with cos", /cos/.test((await h.result("m12")) ?? ""), await h.result("m12"));
  check("sum = 1.55", (await h.result("m13")) === "1.55", await h.result("m13"));
  check("integral = 0.333", (await h.result("m14")) === "0.333", await h.result("m14"));
  check("z = 3+4i", (await h.result("m20")) === "3+4i", await h.result("m20"));
  check("B = identity(15) is a scrollable table", await h.q("[data-region-id=m22] .result-table"));
  check("undefined name gives an error region", await h.q("[data-region-id=m17].state-error, [data-region-id=m16].state-error"));
  check("include file: kk·2 = 14", (await h.result("u1")) === "14", await h.result("u1"));
  await shot("1-opened");

  // 2. edit a definition: dependents recalc
  await b.clickSel("[data-region-id=m1]");
  await b.sleep(300);
  await k.named("End");
  for (let i = 0; i < 12 && !/^L:=$/.test((await h.mathText("m1")) ?? ""); i++) {
    await k.named("Backspace");
    await b.sleep(150);
  }
  await k.type("4m");
  await k.named("Enter");
  await h.idle();
  check("L := 4 m gives M_max = 24 kN·m", (await h.result("m4")) === "24kN·m", await h.result("m4"));

  // 3. F5 and Ctrl+F5
  await k.named("F5");
  check("F5 keeps the value", (await h.idle()) && (await h.result("m4")) === "24kN·m");
  await k.named("F5", CTRL);
  check("Ctrl+F5 recalculates everything", (await h.idle()) && (await h.result("m4")) === "24kN·m" && (await h.result("m7")) === "−3");

  // 4. undo / redo of the document
  await k.chord("z");
  await h.idle();
  check("Ctrl+Z restores L := 3.5 m and the dependents", (await h.result("m4")) === "18.375kN·m", await h.result("m4"));
  await k.chord("y");
  await h.idle();
  check("Ctrl+Y redoes it", (await h.result("m4")) === "24kN·m", await h.result("m4"));

  // 4b. per-region result format through the command palette and the dialog
  await b.eval("document.querySelector('[data-testid=worksheet-area]').scrollTo(0, 0)");
  await b.sleep(300);
  await b.clickSel("[data-region-id=m13] .math");
  await b.sleep(300);
  await k.named("Escape");
  await b.eval("document.querySelector('[data-region-id=m13]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))");
  await b.sleep(300);
  await k.chord("k");
  await until(() => h.q("[role=dialog] input"));
  await b.eval(`(() => { const i = document.querySelector('[role=dialog] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'result format'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.sleep(300);
  await k.named("Enter");
  check("Result format dialog opens for the selected region", await until(() => h.q("[data-testid=rf-type]")));
  await b.eval(`(() => { const s = document.querySelector('[data-testid=rf-type]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'scientific'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await b.eval("document.querySelector('[data-testid=rf-apply]').click()");
  await until(async () => (await h.result("m13")) !== "1.55");
  check("sum shows 1.55 as scientific after the override", (await h.result("m13")) === "1.55·100", await h.result("m13"));
  await k.chord("z");
  await h.idle();
  check("undo removes the override", (await h.result("m13")) === "1.55", await h.result("m13"));

  // 5. create regions by typing (definition, evaluation), a matrix with Ctrl+M, a program
  await scrollEnd();
  const blank = await h.blankPoint(2, 120);
  check("an empty spot on the sheet exists", !!blank, JSON.stringify(blank));
  await b.click(...blank);
  const before = (await h.mathIds()).length;
  await typed("zz:7");
  await typed("zz*2=");
  await h.idle();
  let ids = await h.mathIds();
  check("typing creates two regions", ids.length === before + 2);
  check("zz*2 = 14", (await h.result(ids.at(-1))) === "14", await h.result(ids.at(-1)));

  await k.type("M:");
  await k.chord("m");
  check("Ctrl+M opens the matrix dialog", await h.until(() => h.q("[role=dialog]")));
  await k.type("2");
  await k.named("Tab");
  await k.type("3");
  await k.named("Enter");
  await b.sleep(300);
  await k.type("1");
  for (const v of ["2", "3", "4", "5", "6"]) {
    await k.named("Tab");
    await k.type(v);
  }
  await k.named("Enter");
  await b.sleep(400);
  await typed("M=");
  await typed("M[1,2=");
  await h.idle();
  ids = await h.mathIds();
  check("matrix result is 2x3", await h.q(`[data-region-id=${ids.at(-2)}] .result-matrix[data-rows='2'][data-cols='3']`), await h.result(ids.at(-2)));
  check("M[1,2] = 6 (row 1, column 2, origin 0)", (await h.result(ids.at(-1))) === "6", await h.result(ids.at(-1)));

  await k.type("Q(n):");
  await k.type("]");
  await k.type("s{1");
  await k.named("ArrowDown"); // `]` starts a program with two lines: fill the second, then add a third
  await k.type("s{s*n+2");
  await k.named("Enter");
  await k.type("s");
  await k.named("Escape"); // Enter would add a program line; Escape leaves and commits the region
  await b.sleep(500);
  await typed("Q(5)=");
  await h.idle();
  ids = await h.mathIds();
  check("program Q(5) = 7", (await h.result(ids.at(-1))) === "7", `${await h.result(ids.at(-1))} / ${await h.mathText(ids.at(-2))} / ${await b.eval(`document.querySelector('[data-region-id=${ids.at(-1)}]').outerHTML.slice(0, 300)`)}`);
  await shot("2-typed");

  // 6. text region with inline math (Ctrl+Shift+T, Ctrl+M inside the text)
  await scrollEnd();
  const spot = await h.blankPoint(await h.count(".sheet .page"), 120);
  if (spot) await b.click(...spot);
  const textsBefore = await h.count("[data-kind=text]");
  await k.chord("T", SHIFT);
  await b.sleep(400);
  await k.type("Load is ");
  await k.chord("m");
  await b.sleep(300);
  await k.type("q");
  await k.named("Escape");
  await k.type(" ok");
  await k.named("Escape");
  await b.sleep(300);
  await b.click(...(await h.blankPoint(await h.count(".sheet .page"), 120)));
  await b.sleep(800);
  check("text region with inline math is committed", (await h.count("[data-kind=text]")) === textsBefore + 1, `${await h.count("[data-kind=text]")}`);
  check("inline math is part of the text region", await b.eval(`!![...document.querySelectorAll('[data-kind=text]')].at(-1)?.querySelector('.tx-inline, .math')`), await b.eval(`[...document.querySelectorAll('[data-kind=text]')].at(-1)?.outerHTML.slice(0, 400)`));

  // 7. side panel with real data, hover card
  // the open state persists in localStorage between runs: only click when it is closed
  if (!(await h.q("[data-testid=side-panel]"))) await b.eval("document.querySelector('[data-testid=panel-toggle]').click()");
  await until(() => h.q("[data-testid=panel-tab-variables]"));
  await b.eval("document.querySelector('[data-testid=panel-tab-variables]').click()");
  check("side panel lists definitions with values", await until(() => h.count("[data-testid=variable-row]").then((n) => n > 5)), `${await h.count("[data-testid=variable-row]")} rows`);
  const panelText = (await h.text("[data-testid=variables-list]")) ?? "";
  check("variables panel shows L and kk", /L/.test(panelText) && /kk/.test(panelText), panelText.slice(0, 80));
  await shot("3-panel");
  if (await h.q("[data-testid=side-panel]")) await b.eval("document.querySelector('[data-testid=panel-toggle]').click()");
  await b.eval("document.querySelector('[data-testid=worksheet-area]').scrollTo(0, 0)");
  await b.sleep(300);
  const nameBox = await b.eval(`(() => { const e = document.querySelector('[data-region-id=m3] .name'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  if (nameBox) {
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: nameBox[0], y: nameBox[1] });
    await b.sleep(900);
  }
  check("hovering a name shows the hover card with the real value", (await h.q("[data-testid=hover-card]")) && /kN|24|M/.test((await h.text("[data-testid=hover-card]")) ?? ""), await h.text("[data-testid=hover-card]"));

  // 8. interrupt a long loop with Stop (second worksheet opened from the Open dialog)
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 400 });
  await k.chord("o");
  check("Ctrl+O opens the Open dialog", await until(() => h.q("[role=dialog] input")));
  await b.eval(`(() => { const i = document.querySelector('[role=dialog] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(fixtures + "/long.eqv")}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await k.named("Enter");
  check("the long calculation shows progress and Stop", await until(() => h.q("[data-testid=progress] .stop"), 60000));
  // wait until the function definition is done: the loop region is then the one that runs
  check("the definition before the loop is evaluated", await until(() => h.q("[data-region-id=p1].state-value"), 120000));
  await b.sleep(1500);
  await b.eval("document.querySelector('[data-testid=progress] .stop').click()");
  check("Stop ends the calculation", await h.idle(60000) || (await h.count("[data-testid=progress]")) === 0);
  check("the loop region is marked as an error (interrupted or kernel stopped)", await until(() => h.q("[data-region-id=p2].state-error"), 15000), `p2=${await b.eval("document.querySelector('[data-region-id=p2]')?.className")}`);
  // the app recovers: delete the loop region (Backspace until it is empty), the rest recalculates
  await b.clickSel("[data-region-id=p2]");
  await b.sleep(300);
  await k.named("End");
  for (let i = 0; i < 80 && (await h.mathText("p2")); i++) {
    await k.named("Backspace");
    await b.sleep(40);
  }
  await k.named("Enter");
  check("the kernel restarts and the rest of the worksheet calculates", (await h.idle(180000)) && (await h.result("a2")) === "2", `a2=${await h.result("a2")} ${await h.kernelStatus()}`);
  await shot("4-stopped");
  await k.chord("w");
  await b.sleep(500);
} catch (error) {
  console.log("ERROR", error.stack ?? error);
} finally {
  failed = h.done();
  if (b.logs.length) console.log("page errors:", b.logs);
  await b.close();
}
process.exit(failed);
