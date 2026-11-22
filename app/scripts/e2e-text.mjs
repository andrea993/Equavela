// Real-key check of the text region editor in the app (mock backend) in Edge via the DevTools
// protocol (driver: spikes/g-text-editor/scripts/cdp.mjs). Needs the dev server on port 1420
// (`pnpm --dir app dev`). Usage: node app/scripts/e2e-text.mjs [outDir]
import { mkdirSync } from "node:fs";
import { launch } from "./cdp.mjs";

const out = process.argv[2] ?? "app/scripts/out";
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const CTRL = 2;
const SHIFT = 8;

const b = await launch({ tag: "app-text", port: 9671, width: 1100, height: 760 });
await b.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: "http://localhost:1420" });
const text = (sel) => b.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent ?? null`);
const exists = (sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
const until = async (fn, ms = 4000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await b.sleep(100);
  }
  return false;
};
const shot = (name) => b.shot(`${out}/${name}.png`, { x: 0, y: 120, width: 1100, height: 520 });
try {
  await b.goto("http://localhost:1420/?backend=mock");
  for (let i = 0; i < 60 && !(await exists("[data-region-id=t2] [data-testid=text-view]")); i++) await b.sleep(250);
  // the paragraph region of the demo (second text region)
  const sel = `[data-kind=text][data-region-id=t2]`;
  check("demo text region is rendered by TextView", await exists(`${sel} [data-testid=text-view]`));


  // 1. open it with a click (press, short hold, release)
  await b.clickSel(sel);
  check("click opens the text editor", await until(() => exists(`${sel} [data-testid=text-editor]`)));
  check("the editor has the keyboard", await b.eval(`document.activeElement.matches('[data-testid=text-editor]')`));

  // 2. text, bold
  await b.key("End", { code: "End", vk: 35, modifiers: CTRL });
  await b.type(" Z");
  await b.key("b", { code: "KeyB", vk: 66, modifiers: CTRL });
  await b.type("bold");
  await b.key("b", { code: "KeyB", vk: 66, modifiers: CTRL });
  check("typed text and Ctrl+B bold", (await b.eval(`document.querySelector('${sel} .tx-b')?.textContent`)) === "bold");

  // 3. inline math with Ctrl+M, filled with x^2 on the keyboard, left with Escape
  await b.key("m", { code: "KeyM", vk: 77, modifiers: CTRL });
  await b.sleep(250);
  check("Ctrl+M inserts inline math that has the keyboard", await b.eval(`document.activeElement.matches('.tx-inline')`));
  await b.key("x", { code: "KeyX", vk: 88 });
  await b.key("^", { code: "Digit6", vk: 54, modifiers: SHIFT });
  await b.key("2", { code: "Digit2", vk: 50 });
  check("typing reaches the structural math editor (superscript drawn)", await exists(`${sel} .tx-inline sup, ${sel} .tx-inline .sup, ${sel} .tx-inline [data-path]`));
  await shot("2-math-open");
  // copy, cut and paste inside the inline math (the exponent 2 is selected)
  await b.key("c", { code: "KeyC", vk: 67, modifiers: CTRL });
  await b.sleep(300);
  check("Ctrl+C in the inline math copies the node as text", (await b.eval("navigator.clipboard.readText()")) === "2");
  await b.key("x", { code: "KeyX", vk: 88, modifiers: CTRL });
  await b.sleep(300);
  check("Ctrl+X cuts it (a box is left)", (await text(`${sel} .tx-inline`)) !== null && !(await text(`${sel} .tx-inline`)).includes("2"));
  await b.key("v", { code: "KeyV", vk: 86, modifiers: CTRL, commands: ["paste"] });
  await b.sleep(600);
  check("Ctrl+V pastes it back and the inline math keeps the keyboard", (await text(`${sel} .tx-inline`)).includes("2") && (await b.eval(`document.activeElement.matches('.tx-inline')`)), (await text(`${sel} .tx-inline`)) + " | " + (await b.eval("(document.querySelector('.message-bar') || {}).textContent ?? ''")));
  await b.key("Escape", { code: "Escape", vk: 27 });
  await b.sleep(250);
  check("Escape returns the keyboard to the text", await b.eval(`document.activeElement.matches('[data-testid=text-editor]')`));
  await b.type("Q");
  await shot("3-after-math");

  // 4. leave by clicking the page background: one commit, the region shows the TextView again
  await b.click(850, 420);
  check("leaving commits: the read-only render is back", await until(async () => (await exists(`${sel} [data-testid=text-view]`)) && !(await exists(`[data-testid=text-editor]`))));
  const html = await b.eval(`document.querySelector('${sel} [data-testid=text-view]').innerHTML`);
  check("committed text has bold and inline math", html.includes("tx-b") && html.includes("tx-math") && html.includes("Q"), "");
  await shot("4-committed");

  // 5. one document undo step restores the original text
  await b.key("z", { code: "KeyZ", vk: 90, modifiers: CTRL });
  await b.sleep(400);
  const undone = await b.eval(`document.querySelector('${sel} [data-testid=text-view]').innerHTML`);
  check("document undo reverts the whole text edit", !undone.includes("tx-math") && !undone.includes("tx-b"));
  await b.key("y", { code: "KeyY", vk: 89, modifiers: CTRL });
  await b.sleep(400);
  check("redo brings it back", (await b.eval(`document.querySelector('${sel} [data-testid=text-view]').innerHTML`)).includes("tx-math"));

  // 6. Text Formatting tab: select all text in the editor and set a size
  await b.clickSel(sel);
  await until(() => exists(`${sel} [data-testid=text-editor]`));
  await b.key("a", { code: "KeyA", vk: 65, modifiers: CTRL });
  await b.eval(`[...document.querySelectorAll('[role=tab]')].find(t => t.textContent === 'Text Formatting').click()`);
  await b.sleep(200);
  await b.eval(`(() => { const s = document.querySelector('.size-picker select'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, '18'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await b.sleep(300);
  const sized = await b.eval(`[...document.querySelectorAll('${sel} [data-testid=text-editor] span[style]')].map(e => e.style.fontSize + '/' + e.style.lineHeight).join(',')`);
  check("size 18 pt from the ribbon: 24px / 30px", sized.includes("24px/30px"), sized);
  await shot("5-formatting");
  await b.click(850, 420);
  await b.sleep(300);
} finally {
  await b.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
