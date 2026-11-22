// Phase 7 exit check in the real app: an XY plot of x^g over a range variable updates when the
// definition g changes (data frame and rendered SVG path), the change is one undo step, and the
// plot is drawn with Plotly inside WebView2. Needs `pnpm --dir app tauri build --debug --no-bundle`.
// Usage (repository root): node app/scripts/e2e-plot.mjs [outDir]
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { startApp, keyboard } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const out = process.argv[2] ?? "app/scripts/out";
mkdirSync(out, { recursive: true });
const fixtures = resolve("app/scripts/fixtures/real-smoke").replaceAll("\\", "/");
const b = await startApp({ port: 9692, args: [`${fixtures}/plot.eqv`] });
const k = keyboard(b);
const h = harness(b);
const { check, until } = h;
const path = () =>
  b.eval(`document.querySelector('[data-region-id=p1] .scatterlayer path.js-line')?.getAttribute('d') ?? null`);
const plotState = () => b.eval(`document.querySelector('[data-region-id=p1] [data-testid=plot-canvas]')?.dataset.state ?? null`);
const points = () => b.eval(`Number(document.querySelector('[data-region-id=p1] [data-testid=plot-canvas]')?.dataset.points ?? 0)`);
let failed = 1;
try {
  await until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
  check("kernel ready", await h.idle(240000), await h.kernelStatus());
  check("the plot is calculated (state ready)", await until(async () => (await plotState()) === "ready", 60000), await plotState());
  check("5 points from the range x := 0..4", (await points()) === 5, String(await points()));
  check("Plotly drew an SVG line path", await until(async () => !!(await path()), 20000));
  const before = await path();
  await b.shot(`${out}/plot-1.png`, { x: 0, y: 0, width: 1280, height: 800 });

  // Change the definition g := 2 to g := 3: the plot recalculates and the path changes.
  await b.clickSel("[data-region-id=d2]");
  await b.sleep(300);
  await k.named("End");
  for (let i = 0; i < 12 && !/^g:=$/.test((await h.mathText("d2")) ?? ""); i++) {
    await k.named("Backspace");
    await b.sleep(150);
  }
  await k.type("3");
  await k.named("Enter");
  check("g := 3 recalculates", await h.idle(), await h.kernelStatus());
  check("the plot is ready again", await until(async () => (await plotState()) === "ready", 60000), await plotState());
  const after = await path();
  check("the rendered path changed", !!after && after !== before, `${before} -> ${after}`);
  await b.shot(`${out}/plot-2.png`, { x: 0, y: 0, width: 1280, height: 800 });

  // One undo step restores g := 2 and the original path.
  await k.chord("z");
  await h.idle();
  await until(async () => (await path()) === before, 60000);
  check("Ctrl+Z restores the first path", (await path()) === before);
  failed = 0;
} catch (error) {
  console.error(error);
} finally {
  const summary = h.done();
  await b.close();
  process.exit(failed || summary);
}
