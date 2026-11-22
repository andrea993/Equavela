// Shared helpers for the real-backend drivers: start the debug desktop app (Tauri + WebView2 + Julia
// kernel), attach through the DevTools protocol and type with real key events from the shortcut tables.
// Needs a debug build: `pnpm --dir app tauri build --debug --no-bundle`. Only the process started here is
// killed (as a tree); nothing of the user's Edge is touched.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./cdp.mjs";

// EQUAVELA_APP_EXE points the driver at another build, for example an installed app.
export const EXE = process.env.EQUAVELA_APP_EXE || "target/debug/equavela-app.exe";
export const CTRL = 2;
export const SHIFT = 8;
export const ALT = 1;

export async function startApp({ port = 9690, args = [], env = {} } = {}) {
  if (!existsSync(EXE)) throw new Error(`missing ${EXE}; run pnpm --dir app tauri build --debug --no-bundle`);
  // The window must not appear on the user's desktop or take focus: it is parked off-screen and cannot be
  // focused (EQUAVELA_DRIVER_OFFSCREEN), and the run has its own data folder (EQUAVELA_DRIVER_DATA_DIR, which also
  // keeps it away from the user's recovery files). EQUAVELA_DRIVER_VISIBLE=1 turns this off to watch a run.
  const quiet = process.env.EQUAVELA_DRIVER_VISIBLE ? {} : {
    EQUAVELA_DRIVER_OFFSCREEN: "1",
    EQUAVELA_DRIVER_DATA_DIR: mkdtempSync(join(tmpdir(), "equavela-driver-data-")),
  };
  const proc = spawn(EXE, args, {
    env: { ...process.env, ...quiet, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, ...env },
    stdio: "ignore",
  });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* not up yet */
    }
  }
  if (!target) {
    proc.kill();
    throw new Error("the app window did not appear");
  }
  const b = await connect(target, proc);
  if (process.env.EQUAVELA_DRIVER_VISIBLE) await b.send("Page.bringToFront").catch(() => {});
  b.pid = proc.pid;
  return b;
}

// US layout: character -> [code, shift, vk]
const US = {};
for (const ch of "abcdefghijklmnopqrstuvwxyz") US[ch] = [`Key${ch.toUpperCase()}`, false, ch.toUpperCase().charCodeAt(0)];
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") US[ch] = [`Key${ch}`, true, ch.charCodeAt(0)];
for (const ch of "0123456789") US[ch] = [`Digit${ch}`, false, ch.charCodeAt(0)];
Object.assign(US, {
  ")": ["Digit0", true, 48], "!": ["Digit1", true, 49], "@": ["Digit2", true, 50], "#": ["Digit3", true, 51],
  "$": ["Digit4", true, 52], "%": ["Digit5", true, 53], "^": ["Digit6", true, 54], "&": ["Digit7", true, 55],
  "*": ["Digit8", true, 56], "(": ["Digit9", true, 57],
  " ": ["Space", false, 32], ".": ["Period", false, 190], ",": ["Comma", false, 188], ";": ["Semicolon", false, 186],
  ":": ["Semicolon", true, 186], "=": ["Equal", false, 187], "+": ["Equal", true, 187], "-": ["Minus", false, 189],
  "_": ["Minus", true, 189], "/": ["Slash", false, 191], "?": ["Slash", true, 191], "[": ["BracketLeft", false, 219],
  "{": ["BracketLeft", true, 219], "]": ["BracketRight", false, 221], "}": ["BracketRight", true, 221],
  "\\": ["Backslash", false, 220], "|": ["Backslash", true, 220], "'": ["Quote", false, 222], '"': ["Quote", true, 222],
  "<": ["Comma", true, 188], ">": ["Period", true, 190], "`": ["Backquote", false, 192], "~": ["Backquote", true, 192],
});
const NAMED = {
  Enter: ["Enter", 13], Escape: ["Escape", 27], Tab: ["Tab", 9], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
  ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
  Home: ["Home", 36], End: ["End", 35], F1: ["F1", 112], F2: ["F2", 113], F5: ["F5", 116], F7: ["F7", 118],
};

// Italian layout: character -> [code, shift, altGr]. Letters and digits are as on the US layout.
const IT = { ...US };
Object.assign(IT, {
  "!": ["Digit1", true, 49], '"': ["Digit2", true, 50], "$": ["Digit4", true, 52], "%": ["Digit5", true, 53],
  "&": ["Digit6", true, 54], "/": ["Digit7", true, 55], "(": ["Digit8", true, 56], ")": ["Digit9", true, 57],
  "=": ["Digit0", true, 48], "'": ["Minus", false, 189], "?": ["Minus", true, 189], "^": ["Equal", true, 187],
  "+": ["BracketRight", false, 221], "*": ["BracketRight", true, 221], "-": ["Slash", false, 191], "_": ["Slash", true, 191],
  ":": ["Period", true, 190], ";": ["Comma", true, 188], "<": ["IntlBackslash", false, 226], ">": ["IntlBackslash", true, 226],
  "\\": ["Backquote", false, 220], "|": ["Backquote", true, 220],
  "[": ["BracketLeft", false, 219, true], "{": ["BracketLeft", true, 219, true],
  "]": ["BracketRight", false, 221, true], "}": ["BracketRight", true, 221, true],
  "@": ["Semicolon", false, 186, true], "#": ["Quote", false, 222, true],
});
delete IT["`"];
delete IT["~"];
const TABLES = { "en-US": US, "it-IT": IT };

const CODE_KEY = { Period: ".", Comma: ",", Semicolon: ";", Equal: "=", Minus: "-", Slash: "/", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Quote: "'", Backquote: "`" };
const codeKey = (code) => (/^Key/.test(code) ? code.slice(3).toLowerCase() : /^Digit/.test(code) ? code.slice(5) : (CODE_KEY[code] ?? code));
const codeVk = (code) => (/^Key/.test(code) ? code.charCodeAt(3) : /^Digit/.test(code) ? code.charCodeAt(5) : 0);
const keymapTables = {};
async function layoutTable(layout) {
  if (!keymapTables[layout]) {
    const { readFileSync } = await import("node:fs");
    keymapTables[layout] = JSON.parse(readFileSync(`app/src/keymap/${layout}.json`, "utf8"));
  }
  return keymapTables[layout];
}

/**
 * Typing helpers on top of the CDP driver for one keyboard layout: `type` writes plain characters (the
 * physical key, shift and AltGr of that layout), `named` presses a named key, `cmd` presses the Ctrl chord
 * that the layout table (app/src/keymap/<layout>.json) assigns to a command, `chord` Ctrl+<US key>.
 */
export function keyboard(b, layout = "en-US") {
  const table = TABLES[layout];
  const type = async (s) => {
    for (const ch of s) {
      const e = table[ch];
      if (!e) throw new Error(`no ${layout} key for ${JSON.stringify(ch)}`);
      // AltGr arrives as Ctrl+Alt on Windows
      const modifiers = (e[1] ? SHIFT : 0) | (e[3] ? CTRL | ALT : 0);
      await b.key(ch, { code: e[0], vk: e[2], modifiers });
    }
  };
  const named = async (name, modifiers = 0) => {
    const [code, vk] = NAMED[name];
    // Enter also carries its character, as a real key press does: implicit form submission needs it.
    await b.key(name, { code, vk, modifiers, ...(name === "Enter" ? { text: String.fromCharCode(13) } : {}) });
  };
  /** Ctrl+<character of the US layout>, e.g. chord("m"), chord("T", SHIFT). */
  const chord = async (ch, extra = 0) => {
    const e = US[ch];
    if (!e) throw new Error(`no US key for ${JSON.stringify(ch)}`);
    await b.key(ch.length === 1 && extra & SHIFT ? ch.toUpperCase() : ch, { code: e[0], vk: e[2], modifiers: CTRL | extra | (e[1] ? SHIFT : 0) });
  };
  /** The Ctrl chord of command `cmd` in context `ctx` from the layout table. */
  const cmd = async (name, ctx = "math") => {
    const t = await layoutTable(layout);
    const e = t.ctrl.find((x) => x.cmd === name && x.ctx === ctx);
    if (!e) throw new Error(`${layout} has no Ctrl chord for ${name} (${ctx})`);
    await b.key(codeKey(e.code), { code: e.code, vk: codeVk(e.code), modifiers: CTRL | (e.shift ? SHIFT : 0) | (e.alt ? ALT : 0) });
  };
  return { type, named, chord, cmd };
}

export function killApp(b) {
  return b.close();
}

export function pidAlive(pid) {
  try {
    execFileSync("tasklist", ["/FI", `PID eq ${pid}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
