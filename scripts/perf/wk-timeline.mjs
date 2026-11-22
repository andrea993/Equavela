// WebKitGTK diagnostics for GUI performance (GitHub ): records the WebKit Timeline of the
// running app through its remote inspector, runs a list of trials separated by console.timeStamp
// markers, and prints per trial how many layout invalidations, style recalculations, layouts and
// paints it caused; it also spies DOM, CSSOM and stylesheet writes during crosshair steps.
//
// Start a debug build (devtools enabled) with the inspector server, on a copy of a worksheet:
//   cargo build -p equavela-app --features tauri/custom-protocol
//   WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9333 EQUAVELA_MULTI_INSTANCE=1 \
//     xvfb-run -a -s "-screen 0 1920x1080x24" target/debug/equavela-app /tmp/copy-of-large-1k.eqv
// then: node scripts/perf/wk-timeline.mjs ws://127.0.0.1:9333/socket/1/1/WebPage
// (DUMP=<file> also writes the raw records as JSON.) Timeline timestamps come back as 0 in this
// WebKit; the counts and the order of the records are what this tool relies on.
import * as fsModule from "node:fs";
const require_fs = () => fsModule;
const url = process.argv[2];
const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();
let pageTarget = null;
const records = [];
const log = [];

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const inner = JSON.stringify({ id, method, params });
    pending.set(id, { resolve, reject, method });
    if (pageTarget) {
      ws.send(JSON.stringify({ id: nextId++, method: "Target.sendMessageToTarget", params: { targetId: pageTarget, message: inner } }));
    } else {
      ws.send(inner);
    }
  });

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Target.targetCreated") {
    const info = msg.params.targetInfo;
    log.push(`target ${info.targetId} ${info.type}`);
    if (info.type === "page" && !pageTarget) pageTarget = info.targetId;
    return;
  }
  if (msg.method === "Target.dispatchMessageFromTarget") {
    const inner = JSON.parse(msg.params.message);
    if (inner.id && pending.has(inner.id)) {
      const p = pending.get(inner.id);
      pending.delete(inner.id);
      if (inner.error) p.reject(new Error(`${p.method}: ${JSON.stringify(inner.error)}`));
      else p.resolve(inner.result);
    } else if (inner.method === "Timeline.eventRecorded") {
      records.push(inner.params.record);
    }
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
};

ws.onopen = async () => {
  try {
    for (let i = 0; i < 50 && !pageTarget; i++) await sleep(100);
    console.log(log.join("\n"));
    if (!pageTarget) throw new Error("no page target");
    // Wait for the worksheet, then put the crosshair on empty sheet in the middle of the view.
    for (let i = 0; i < 300; i++) {
      if (await evaluate(`document.querySelectorAll('[data-region-id]').length > 100`)) break;
      await sleep(500);
    }
    await sleep(8000);
    const setup = await evaluate(`(async () => {
      const key = (k) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k, bubbles: true, cancelable: true }));
      key("Escape"); await new Promise(r => setTimeout(r, 300)); key("Escape");
      const area = document.querySelector(".worksheet-area");
      area.scrollTop = (area.scrollHeight - area.clientHeight) / 2;
      await new Promise(r => setTimeout(r, 1000));
      const view = area.getBoundingClientRect();
      const y = view.top + view.height / 2;
      const page = [...document.querySelectorAll(".sheet .page")].find(p => { const r = p.getBoundingClientRect(); return r.top < y && r.bottom > y; });
      const r = page.getBoundingClientRect();
      const x = r.right - 63 * (96 / 72) * (r.width / page.offsetWidth);
      const target = document.elementFromPoint(x, y) || page;
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: "mouse" };
      target.dispatchEvent(new PointerEvent("pointerdown", init));
      window.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
      await new Promise(r => setTimeout(r, 1000));
      return { regions: document.querySelectorAll('[data-region-id]').length, editing: !!document.querySelector('.region.editing') };
    })()`);
    console.log("setup", JSON.stringify(setup));
    await evaluate(`(() => {
      window.__spy = [];
      const wrap = (proto, name, label) => {
        const original = proto[name];
        proto[name] = function (...args) {
          window.__spy.push(label + " " + String(args[0]).slice(0, 80) + " @ " + (new Error().stack || "").split("\\n").slice(1, 7).join(" < "));
          return original.apply(this, args);
        };
      };
      wrap(CSSStyleSheet.prototype, "insertRule", "insertRule");
      wrap(CSSStyleSheet.prototype, "deleteRule", "deleteRule");
      wrap(CSSStyleDeclaration.prototype, "setProperty", "setProperty");
      wrap(HTMLElement.prototype, "focus", "focus");
      wrap(Element.prototype, "scrollTo", "scrollTo");
      wrap(Element.prototype, "scrollBy", "scrollBy");
      wrap(Element.prototype, "scrollIntoView", "scrollIntoView");
      wrap(HTMLElement.prototype, "blur", "blur");
      wrap(Element.prototype, "setAttribute", "setAttribute");
      const wrapSetter = (proto, name, label) => {
        let target = proto, d = null;
        while (target && !(d = Object.getOwnPropertyDescriptor(target, name))) target = Object.getPrototypeOf(target);
        if (!d || !d.set) return;
        Object.defineProperty(target, name, { ...d, set(v) {
          const who = this instanceof Element ? this.tagName + "." + (this.getAttribute("class") || "").split(" ")[0] : (this.parentRule ? "rule" : "style");
          window.__spy.push(label + "." + name + "=" + String(v).slice(0, 60) + " on " + who + " @ " + (new Error().stack || "").split("\\n").slice(1, 4).join(" < "));
          return d.set.call(this, v);
        } });
      };
      for (const n of ["textContent", "nodeValue", "data"]) { wrapSetter(Node.prototype, n, "node"); wrapSetter(CharacterData.prototype, n, "char"); }
      for (const n of ["className", "id", "innerHTML", "scrollTop", "scrollLeft"]) wrapSetter(Element.prototype, n, "el");
      for (const n of ["type", "name", "value", "checked", "defaultValue"]) wrapSetter(HTMLInputElement.prototype, n, "input");
      wrapSetter(Document.prototype, "title", "doc");
      for (const n of Object.getOwnPropertyNames(CSSStyleDeclaration.prototype)) {
        const d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, n);
        if (d && d.set && n !== "cssText") wrapSetter(CSSStyleDeclaration.prototype, n, "css");
      }
      wrapSetter(CSSStyleDeclaration.prototype, "cssText", "css");
      const html = document.documentElement;
      new MutationObserver((l) => l.forEach((m) => window.__spy.push("html-mutation " + m.attributeName))).observe(html, { attributes: true });
      return 1;
    })()`);
    await send("Timeline.start", { maxCallStackDepth: 5 });
    await sleep(500);
    for (const k of ["ArrowDown", "ArrowUp", "ArrowDown"]) {
      const before = await evaluate(`window.__spy.length`);
      await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "${k}", code: "${k}", bubbles: true, cancelable: true })); 1`);
      await sleep(1500);
      const step = JSON.parse(await evaluate(`JSON.stringify(window.__spy.slice(${before}))`));
      const ins = step.filter((x) => x.startsWith("insertRule"));
      console.log(`STEP ${k}: ${step.length} spied calls, insertRule ${ins.length}; calls:\n    ${step.map((x) => x.slice(0, 230)).join("\n    ")}`);
    }
    const trials = {
      key: `console.timeStamp("T:key"); window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", code: "ArrowUp", bubbles: true, cancelable: true }));`,
      crosshair: `console.timeStamp("T:crosshair"); const m = document.querySelector("[data-testid=crosshair]"); m.style.top = (parseFloat(m.style.top) + 4) + "px";`,
      inputName: `console.timeStamp("T:inputName"); document.querySelectorAll("input[type=search], input[type=range]").forEach((i) => { i.name = ""; });`,
      inputType: `console.timeStamp("T:inputType"); document.querySelectorAll("input[type=search], input[type=range]").forEach((i) => { i.type = i.type; });`,
      title: `console.timeStamp("T:title"); document.title = document.title;`,
      all: `console.timeStamp("T:all"); const m2 = document.querySelector("[data-testid=crosshair]"); m2.style.top = (parseFloat(m2.style.top) - 4) + "px"; document.querySelectorAll("input[type=search], input[type=range]").forEach((i) => { i.name = ""; i.type = i.type; }); document.title = document.title;`,
      f13: `console.timeStamp("T:f13"); window.dispatchEvent(new KeyboardEvent("keydown", { key: "F13", code: "F13", bubbles: true, cancelable: true }));`,
      f13prevented: `console.timeStamp("T:f13prevented"); { const h = (e) => e.preventDefault(); window.addEventListener("keydown", h, { once: true }); window.dispatchEvent(new KeyboardEvent("keydown", { key: "F13", code: "F13", bubbles: true, cancelable: true })); }`,
      writeInKey: `console.timeStamp("T:writeInKey"); { const h = () => { const m = document.querySelector("[data-testid=crosshair]"); m.style.top = (parseFloat(m.style.top) + 4) + "px"; }; window.addEventListener("keydown", h, { once: true }); window.dispatchEvent(new KeyboardEvent("keydown", { key: "F13", code: "F13", bubbles: true, cancelable: true })); }`,
      writeInPointer: `console.timeStamp("T:writeInPointer"); { const h = () => { const m = document.querySelector("[data-testid=crosshair]"); m.style.top = (parseFloat(m.style.top) - 4) + "px"; }; window.addEventListener("pointermove", h, { once: true }); window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 })); }`,
      transformInPointer: `console.timeStamp("T:transformInPointer"); { const h = () => { const m = document.querySelector("[data-testid=crosshair]"); m.style.transform = "translate(0px, 4px)"; }; window.addEventListener("pointermove", h, { once: true }); window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 })); }`,
      transformInPointer2: `console.timeStamp("T:transformInPointer2"); { const h = () => { const m = document.querySelector("[data-testid=crosshair]"); m.style.transform = "translate(0px, 8px)"; }; window.addEventListener("pointermove", h, { once: true }); window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 })); }`,
      writeInPointer2: `console.timeStamp("T:writeInPointer2"); { const h = () => { const m = document.querySelector("[data-testid=crosshair]"); m.style.top = (parseFloat(m.style.top) + 4) + "px"; }; window.addEventListener("pointermove", h, { once: true }); window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 })); }`,
      leftWrite: `console.timeStamp("T:leftWrite"); { const m = document.querySelector("[data-testid=crosshair]"); m.style.left = (parseFloat(m.style.left) + 3) + "px"; }`,
      reactNoKey: `console.timeStamp("T:reactNoKey"); window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 5, clientY: 5 }));`,
      key2: `console.timeStamp("T:key2"); window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true, cancelable: true }));`,
    };
    for (const code of Object.values(trials)) {
      await evaluate(code + " 1");
      await sleep(1200);
    }
    await sleep(300);
    console.timeStamp;
    await send("Timeline.stop");
    const spy = await evaluate(`JSON.stringify(window.__spy)`);
    const list = JSON.parse(spy || "[]");
    console.log("SPY count", list.length);
    const counts = new Map();
    for (const x of list) { const k = x.split(" @ ")[0].slice(0, 60); counts.set(k, (counts.get(k) || 0) + 1); }
    console.log([...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => n + "x " + k).join("\n"));
    console.log("SPY samples:\n" + list.filter((x) => !x.startsWith("setAttribute")).slice(0, 6).join("\n"));
    await sleep(500);
    summarize();
  } catch (error) {
    console.error("ERROR", error.message);
  } finally {
    ws.close();
    process.exit(0);
  }
};

function summarize() {
  {
    let current = null;
    const per = new Map();
    for (const r of records) {
      if (r.type === "TimeStamp" && String(r.data?.message || "").startsWith("T:")) { current = r.data.message; per.set(current, { inv: 0, style: 0, layout: 0, paint: 0 }); continue; }
      if (!current) continue;
      const e = per.get(current);
      if (r.type === "InvalidateLayout") e.inv++;
      if (r.type === "RecalculateStyles") e.style++;
      if (r.type === "Layout") e.layout++;
      if (r.type === "Paint") e.paint++;
    }
    for (const [k, v] of per) console.log("TRIAL", k, JSON.stringify(v));
    let on = false; let shown = 0;
    for (const r of records) {
      if (r.type === "TimeStamp" && r.data?.message === "T:key") { on = true; continue; }
      if (r.type === "TimeStamp" && on) break;
      if (!on) continue;
      if (["ScheduleStyleRecalculation", "InvalidateLayout", "RecalculateStyles", "ScheduleLayout"].includes(r.type) && shown < 6) {
        console.log("REC", r.type, JSON.stringify(r).slice(0, 900));
        shown++;
      }
    }
  }
  const fs = require_fs();
  fs.writeFileSync(process.env.DUMP || "/dev/null", JSON.stringify(records));
  const sample = records.find((r) => r.type === "Layout") || records[0];
  console.log("sample", JSON.stringify(sample).slice(0, 600));
  const inv = records.filter((r) => r.type === "InvalidateLayout");
  console.log("invalidate sample", JSON.stringify(inv[0]).slice(0, 400));
  // Flatten with depth; sum self time per type, and list the longest top-level records.
  const byType = new Map();
  const top = [];
  const walk = (record, depth) => {
    const duration = record.endTime && record.startTime ? (record.endTime - record.startTime) * 1000 : 0;
    const childTime = (record.children || []).reduce((sum, c) => sum + (c.endTime && c.startTime ? (c.endTime - c.startTime) * 1000 : 0), 0);
    const self = Math.max(0, duration - childTime);
    const entry = byType.get(record.type) || { count: 0, total: 0, self: 0, max: 0 };
    entry.count++;
    entry.total += duration;
    entry.self += self;
    entry.max = Math.max(entry.max, duration);
    byType.set(record.type, entry);
    if (depth === 0) top.push({ type: record.type, duration, data: record.data, children: record.children });
    for (const child of record.children || []) walk(child, depth + 1);
  };
  for (const r of records) walk(r, 0);
  console.log(`records ${records.length}`);
  console.log("type                        count   total ms    self ms     max ms");
  for (const [type, e] of [...byType].sort((a, b) => b[1].self - a[1].self).slice(0, 25)) {
    console.log(`${type.padEnd(26)}${String(e.count).padStart(7)}${e.total.toFixed(1).padStart(11)}${e.self.toFixed(1).padStart(11)}${e.max.toFixed(1).padStart(11)}`);
  }
  console.log("longest top-level records:");
  for (const t of top.sort((a, b) => b.duration - a.duration).slice(0, 12)) {
    const kids = (t.children || []).map((c) => `${c.type}:${((c.endTime - c.startTime) * 1000).toFixed(0)}`).slice(0, 8).join(" ");
    console.log(`  ${t.type} ${t.duration.toFixed(1)} ms ${JSON.stringify(t.data || {}).slice(0, 160)} | ${kids}`);
  }
}
