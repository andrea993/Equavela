// Minimal Chrome DevTools Protocol driver for Edge (Chromium 156, same engine as WebView2). Node 22+ (global WebSocket).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

export async function launch({ port = 9650, width = 440, height = 300, tag = "g" } = {}) {
  const profile = join(tmpdir(), "edge-cdp-" + tag);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const proc = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error("Edge did not start");
  return connect(target, proc, port);
}

/** Attaches to a CDP page target (Edge, or a WebView2 started with --remote-debugging-port). `proc` is the
 * process this script started, killed as a tree on close. */
export async function connect(target, proc) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === "Runtime.exceptionThrown") logs.push("exception: " + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text));
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") logs.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      pending.set(++id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = {
    logs,
    send,
    sleep,
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(1500);
      await api.eval("document.fonts.ready.then(() => true)");
      await sleep(300);
    },
    async eval(expr) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
    async shot(file, clip = { x: 0, y: 0, width: 440, height: 200 }) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } });
      writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    async click(x, y, hold = 120) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
        if (type === "mousePressed") await sleep(hold);
      }
      await sleep(200);
    },
    async clickSel(sel) {
      const r = await api.eval(
        `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`,
      );
      if (!r) throw new Error("no element " + sel);
      await api.click(r[0], r[1]);
    },
    /** One key press with proper keydown/keyup (and char for printable keys). */
    async key(key, { code = "", text, modifiers = 0, vk = 0, commands } = {}) {
      const printable = key.length === 1 || text !== undefined;
      await send("Input.dispatchKeyEvent", {
        type: printable ? "keyDown" : "rawKeyDown",
        key,
        code,
        text: printable ? (text ?? key) : undefined,
        modifiers,
        windowsVirtualKeyCode: vk,
        commands,
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: vk });
      await sleep(40);
    },
    async type(s) {
      for (const ch of s) await api.key(ch);
    },
    async close() {
      try {
        await send("Browser.close");
      } catch {
        /* closing */
      }
      ws.close();
      // the headless browser has child processes: kill the tree of the process this driver started
      try {
        execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        proc.kill();
      }
    },
  };
  return api;
}
