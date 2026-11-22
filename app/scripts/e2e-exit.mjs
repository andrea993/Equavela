// Phase 6 exit check on the real desktop app: a the reference application user writes a ~50-region worksheet (definitions,
// units, matrices, programs, evaluations, symbolic evaluation, a text region) using only keyboard events
// from the shortcut tables, and every result is verified against an independently computed value.
// Needs a debug build (`pnpm --dir app tauri build --debug --no-bundle`).
//   node app/scripts/e2e-exit.mjs [--layout en-US|it-IT] [--fast] [outDir]
// --fast does not wait for the calculation between regions (stress: keys arrive while passes run).
// Exit code = number of failed checks.
import { mkdirSync } from "node:fs";
import { startApp, keyboard, CTRL, SHIFT } from "./real-app.mjs";
import { harness } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const layout = opt("layout", "en-US");
const out = args.filter((a, i) => !a.startsWith("--") && !["--layout"].includes(args[i - 1])).at(-1) ?? "app/scripts/out";
mkdirSync(out, { recursive: true });

const b = await startApp({ port: layout === "it-IT" ? 9693 : 9692 });
const k = keyboard(b, layout);
const h = harness(b);
const { check } = h;

// ---- the worksheet: tokens are typed text, or { chord }, { key }, { matrix } ------------------
const M = (rows, cols, values) => ({ matrix: { rows, cols, values } });
const CMD = (cmd, ctx = "math") => ({ cmd, ctx });
const KEY = (name, mod = 0) => ({ key: name, mod });
/** [tokens, expected result | RegExp | null]. A null expectation is a definition (no result shown). */
const items = [
  ["a:3", null],
  ["b:4", null],
  ["c:a*a+b*b", null],
  ["c=", "25"],
  ["a+b=", "7"],
  ["a*b=", "12"],
  ["b^a=", "64"],
  ["a/b=", "0.75"],
  ["(a+b)^2=", "49"],
  [["d:", "\\", "c"], null],
  ["d=", "5"],
  ["n:1234.5678", null],
  ["n=", "1.235·103"],
  ["w:0.000123", null],
  ["w=", "1.23·10−4"],
  ["L:2.5m", null],
  ["L=", "2.5m"],
  ["T:2s", null],
  [["v:L/T"], null],
  ["v=", "1.25m/s"],
  ["F:5kN", null],
  ["F=", "5·103N"],
  ["E:F*L", null],
  ["E=", /^(12\.5kN·m|1\.25·104J)$/],
  ["f5:5!", null],
  ["f5=", "120"],
  ["m1:mod(17,5)", null],
  ["m1=", "2"],
  ["r1:floor(2.7)", null],
  ["r1=", "2"],
  [["A:", M(2, 2, [1, 2, 3, 4])], null],
  ["A=", "1234"],
  [["B:", M(2, 2, [0, 1, 1, 0])], null],
  ["C:A*B", null],
  ["C=", "2143"],
  [["|A", KEY("ArrowRight"), "="], "−2"],
  [["At:A", CMD("transpose")], null],
  ["At=", "1324"],
  [["u:", M(2, 1, [5, 11])], null],
  ["xs:lsolve(A,u)", null],
  ["xs=", "12"],
  ["e1:A[1,0", null],
  ["e1=", "3"],
  ["rows(A)=", "2"],
  [["t1:", CMD("sum"), "i", KEY("Tab"), "1", KEY("Tab"), "10", KEY("Tab"), "i"], null],
  ["t1=", "55"],
  ["z:3+4i", null],
  ["z*z=", "−7+24i"],
  [["|z", KEY("ArrowRight"), "="], "5"],
  [["Q(n):", "]", "s{1", KEY("ArrowDown"), "s{s*n+2", KEY("Enter"), "s", KEY("Escape")], null],
  ["Q(5)=", "7"],
  [["S(n):", "]", "s{0", KEY("Enter"), "i", CMD("for"), "1..n", KEY("Tab"), "s{s+i", KEY("ArrowDown"), "s", KEY("Escape")], null],
  ["S(10)=", "55"],
  ["g(x):if(x>0,x,-x)", null],
  ["g(-3)=", "3"],
  ["cos(0)=", "1"],
  ["atan(1)*4=", "3.142"],
  [["x*x+2*x*x", CMD("symbolic"), KEY("Escape")], "3·x2"],
  [[CMD("deriv"), "x", KEY("Tab"), "x^3", CMD("symbolic"), KEY("Escape")], "3·x2"],
];

const KEYS = ["Enter"];
let failed = 1;
const typeToken = async (t) => {
  if (typeof t === "string") return k.type(t);
  if (t.cmd) return k.cmd(t.cmd, t.ctx);
  if (t.key) return k.named(t.key, t.mod);
  if (t.matrix) {
    const { rows, cols, values } = t.matrix;
    // Ctrl+M inserts a 1x1 matrix; Shift+Space adds a column, Shift+Enter a row, Shift+Tab walks back.
    await k.cmd("matrix");
    for (let c = 1; c < cols; c++) await b.key(" ", { code: "Space", vk: 32, modifiers: SHIFT });
    for (let r = 1; r < rows; r++) await k.named("Enter", SHIFT);
    for (let i = 1; i < rows * cols; i++) await k.named("Tab", SHIFT);
    await b.sleep(300);
    for (let i = 0; i < values.length; i++) {
      if (i > 0) await k.named("Tab");
      await k.type(String(values[i]));
    }
  }
};
try {
  await h.until(async () => (await b.eval("location.href")).includes("tauri.localhost") && (await h.q("[data-testid=kernel-status]")), 30000);
  check("kernel ready", await h.idle(240000), await h.kernelStatus());
  await h.useLayout(layout);
  await b.sleep(300);
  const start = await h.blankPoint(1, 0);
  await b.click(...start);

  // a text region first (Ctrl+Shift+T): title with inline math
  await k.cmd("insertText", "sheet");
  await b.sleep(400);
  await k.type("Exit check: ");
  await k.cmd("insertInlineMath", "text");
  await b.sleep(300);
  await k.type("a");
  await k.named("Escape");
  await k.type(" is defined first");
  await k.named("Escape");
  await b.sleep(300);
  await b.click(...(await h.blankPoint(1, 0)));
  await b.sleep(500);

  const created = [];
  for (const [tokens, expected] of items) {
    for (const t of Array.isArray(tokens) ? tokens : [tokens]) await typeToken(t);
    // leave the region: Escape / Enter as the item ended it
    const last = (Array.isArray(tokens) ? tokens : [tokens]).at(-1);
    if (!(last && last.key === "Escape")) await k.named("Enter");
    await b.sleep(250);
    if (!flag("fast")) await h.idle();
    created.push({ tokens, expected });
  }
  await h.idle(240000);
  await b.shot(`${out}/exit-last-${layout}.png`, { x: 0, y: 0, width: 1280, height: 800 });

  const ids = await h.mathIds();
  check(`worksheet has ${items.length} math regions (one per item) plus a text region`, ids.length === items.length && (await h.count("[data-kind=text]")) === 1, `${ids.length} math, ${await h.count("[data-kind=text]")} text`);
  // regions are in typing order (the crosshair moves down), so item i is region i; with --fast the
  // regions appear while later keys are already being typed, so they are matched at the end
  created.forEach((c, i) => (c.id = ids[i]));
  let bad = 0;
  for (const c of created) {
    if (c.expected === null) {
      const state = await b.eval(`document.querySelector('[data-region-id="${c.id}"]')?.dataset.state`);
      if (state !== "value") {
        bad++;
        check(`definition ${JSON.stringify(c.tokens)} is evaluated`, false, `state=${state} text=${await h.mathText(c.id)}`);
      }
      continue;
    }
    const got = await h.result(c.id);
    const ok = c.expected instanceof RegExp ? c.expected.test(got ?? "") : got === c.expected;
    if (!ok) bad++;
    check(`${await h.mathText(c.id)}  expected ${c.expected}`, ok, `got ${got}`);
  }
  check("all definitions and evaluations are correct", bad === 0, `${bad} wrong`);
  // the whole worksheet as the user sees it
  const regionsText = await b.eval(`[...document.querySelectorAll('[data-kind=math]')].map((e) => e.querySelector('.math')?.textContent).join(' | ')`);
  console.log("worksheet:", regionsText.slice(0, 600));
} catch (error) {
  console.log("ERROR", error.stack ?? error);
} finally {
  failed = h.done();
  if (b.logs.length) console.log("page errors:", b.logs);
  await b.close();
}
process.exit(failed);
