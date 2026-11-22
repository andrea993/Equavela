// Real-event check of mouse selection in math and of the clipboard (math sub-expressions and whole
// regions) in the app with the mock backend, in Edge via the DevTools protocol. Needs the dev
// server on port 1420. Usage: node app/scripts/e2e-clipboard.mjs [outDir]
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

const b = await launch({ tag: "app-clip", port: 9672, width: 1100, height: 760 });
const exists = (sel) => b.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
const count = (sel) => b.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const until = async (fn, ms = 4000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn()) return true;
    await b.sleep(100);
  }
  return false;
};
const clipboard = () => b.eval(`navigator.clipboard.readText()`);
const chord = (key, code, vk, extra = {}) => b.key(key, { code, vk, modifiers: CTRL, ...extra });
try {
  await b.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: "http://localhost:1420" });
  await b.goto("http://localhost:1420/?backend=mock");
  for (let i = 0; i < 60 && !(await exists("[data-region-id=m1] [data-path]")); i++) await b.sleep(250);

  // 1. open m1 (L := 3.5 m) and drag across it: the selection grows to the smallest node holding both ends
  await b.clickSel("[data-region-id=m1]");
  check("click opens the math region", await until(() => exists("[data-region-id=m1].editing")));
  const box = await b.eval(`(() => { const r = document.querySelector('[data-region-id=m1] .math').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })()`);
  const y = (box[1] + box[3]) / 2;
  await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0] + 2, y });
  await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box[0] + 2, y, button: "left", clickCount: 1 });
  await b.sleep(150);
  for (let x = box[0] + 10; x < box[2] - 2; x += 8) {
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await b.sleep(20);
  }
  await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box[2] - 3, y, button: "left", clickCount: 1 });
  await b.sleep(300);
  check("dragging inside the math shades a selection", await exists("[data-region-id=m1] .editing-lines .selection"));
  await b.shot(`${out}/1-drag.png`, { x: 0, y: 120, width: 1100, height: 480 });

  // 2. Ctrl+C copies the selection as canonical linear text
  await chord("c", "KeyC", 67);
  await b.sleep(300);
  const text = await clipboard();
  check("Ctrl+C puts canonical text on the clipboard", typeof text === "string" && text === "L := 3.5 m", JSON.stringify(text));

  // 3. Ctrl+X on the whole statement then Ctrl+V pastes it back: select all with Space growth is not
  // needed; use the drag selection again and cut
  const before = await b.eval(`document.querySelector('[data-region-id=m1] .math').textContent`);
  await chord("x", "KeyX", 88);
  await b.sleep(300);
  const afterCut = await b.eval(`document.querySelector('[data-region-id=m1] .math').textContent`);
  check("Ctrl+X removes the selection", afterCut !== before, `${before} -> ${afterCut}`);
  await chord("v", "KeyV", 86, { commands: ["paste"] });
  await b.sleep(500);
  const afterPaste = await b.eval(`document.querySelector('[data-region-id=m1] .math').textContent`);
  check("Ctrl+V pastes the clipboard text back into the box", afterPaste === before, `${afterPaste}`);
  await b.shot(`${out}/2-pasted.png`, { x: 0, y: 120, width: 1100, height: 480 });
  await b.key("Escape", { code: "Escape", vk: 27 });
  await b.sleep(400);

  // 4. regions: select all, copy, move the crosshair, paste: new regions, one undo step
  const regionsBefore = await count("[data-region-id]");
  await b.click(900, 560);
  await b.sleep(300);
  await chord("a", "KeyA", 65);
  await b.sleep(300);
  check("Ctrl+A selects the regions", (await count("[data-region-id].selected")) > 5, String(await count("[data-region-id].selected")));
  await chord("c", "KeyC", 67);
  await b.sleep(400);
  const snippet = await clipboard();
  check("Ctrl+C on regions writes a snippet of the regions list", /^- id: /.test(snippet) && snippet.includes("math:"), JSON.stringify(snippet.slice(0, 80)) + " " + (await b.eval("(document.querySelector('.message-bar') || {}).textContent ?? ''")));
  await b.click(900, 400);
  await b.sleep(300);
  await chord("v", "KeyV", 86, { commands: ["paste"] });
  const pasted = await until(async () => (await count("[data-region-id]")) > regionsBefore);
  check("Ctrl+V on the sheet pastes new regions", pasted, `${regionsBefore} -> ${await count("[data-region-id]")} ${await b.eval("(document.querySelector('.message-bar') || {}).textContent ?? ''")}`);
  await chord("z", "KeyZ", 90);
  check("one undo removes all pasted regions", await until(async () => (await count("[data-region-id]")) === regionsBefore));
  await b.shot(`${out}/3-regions.png`, { x: 0, y: 120, width: 1100, height: 480 });
} finally {
  if (b.logs.length) console.log("page logs:", b.logs.slice(0, 5));
  await b.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
