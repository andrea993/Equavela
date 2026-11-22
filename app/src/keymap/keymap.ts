// Keymap: explicit per-layout tables, context-scoped.
//
// Resolution order for a keydown:
//  1. AltGr (Windows sends Ctrl+Alt): if the produced character is one the layout makes
//     with AltGr (or `getModifierState("AltGraph")` is true), it is a plain character and
//     Ctrl bindings are never consulted.
//  2. Ctrl (without AltGr): named keys with Ctrl (Ctrl+arrows, Ctrl+F5), then the layout's
//     Ctrl table matched on the physical key (`code`).
//  3. Named keys (Space, Enter, Tab, arrows, ...), matched on `key`.
//  4. Printable characters, matched on the produced character (`key`).
//
// Contexts form a chain: the most specific context that has a binding wins.
// `matrix` and `program` fall back to `math`; every context falls back to `global`.
// In the `string` context (typing a string literal) every printable key is text.

import common from "./common.json";
import enUS from "./en-US.json";
import itIT from "./it-IT.json";

export type LayoutId = "en-US" | "it-IT";
export const LAYOUT_IDS: LayoutId[] = ["en-US", "it-IT"];

export type KeyContext = "global" | "sheet" | "text" | "math" | "matrix" | "program" | "string";

/** The subset of KeyboardEvent the keymap needs (tests build these by hand). */
export interface KeyInput {
  key: string;
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  /** KeyboardEvent.getModifierState("AltGraph") when available. */
  altGraph?: boolean;
}

export interface CtrlBinding {
  code: string;
  shift?: boolean;
  alt?: boolean;
  ctx: KeyContext;
  cmd: string;
  /** The combination as printed in the vendor's shortcut reference. */
  pdf: string;
}

export interface KeyBinding {
  key: string;
  /** Physical fallback when a letter chord is pressed on a non-Latin layout. */
  code?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  ctx: KeyContext;
  cmd: string;
}

export interface LayoutTable {
  id: LayoutId;
  altGrChars: string[];
  ctrl: CtrlBinding[];
  keys: KeyBinding[];
  chars: Record<string, string>;
}

export type Action = { kind: "command"; cmd: string } | { kind: "char"; ch: string };

function table(t: { id: string; altGrChars: string[]; ctrl: unknown[] }): LayoutTable {
  return {
    id: t.id as LayoutId,
    altGrChars: t.altGrChars,
    ctrl: t.ctrl as CtrlBinding[],
    keys: common.keys as KeyBinding[],
    chars: common.chars as Record<string, string>,
  };
}

export const LAYOUTS: Record<LayoutId, LayoutTable> = {
  "en-US": table(enUS),
  "it-IT": table(itIT),
};

export function contextChain(ctx: KeyContext): KeyContext[] {
  switch (ctx) {
    case "matrix":
    case "program":
      return [ctx, "math", "global"];
    case "string":
      return ["string", "math", "global"];
    case "global":
      return ["global"];
    default:
      return [ctx, "global"];
  }
}

const inMath = (ctx: KeyContext) => ctx === "math" || ctx === "matrix" || ctx === "program" || ctx === "string";

function pick<T extends { ctx: KeyContext }>(candidates: T[], ctx: KeyContext): T | undefined {
  for (const c of contextChain(ctx)) {
    const hit = candidates.find((b) => b.ctx === c);
    if (hit) return hit;
  }
  return undefined;
}

export function isAltGr(ev: KeyInput, layout: LayoutTable): boolean {
  if (ev.altGraph) return true;
  return !!ev.ctrlKey && !!ev.altKey && layout.altGrChars.includes(ev.key);
}

function character(ch: string, layout: LayoutTable, ctx: KeyContext): Action | null {
  if (ctx === "string") return ch === '"' ? { kind: "command", cmd: "endString" } : { kind: "char", ch };
  if (inMath(ctx)) {
    const cmd = layout.chars[ch];
    return cmd ? { kind: "command", cmd } : { kind: "char", ch };
  }
  // On the sheet a printable character starts a math region at the crosshair.
  if (ctx === "sheet" && ch !== " ") return { kind: "char", ch };
  return null;
}

export function resolve(ev: KeyInput, layout: LayoutTable, ctx: KeyContext): Action | null {
  if (/^(Control|Alt|AltGraph|Shift|Meta|CapsLock|Dead|Process|Unidentified)$/.test(ev.key)) return null;

  if (isAltGr(ev, layout)) {
    // Windows reports Ctrl+Alt as AltGr too, so an explicit Ctrl+Alt binding wins over typing.
    if (ev.ctrlKey && ev.altKey) {
      const shift = !!ev.shiftKey;
      const chord = pick(layout.keys.filter((b) => b.ctrl && b.alt && !!b.shift === shift && b.key === ev.key), ctx);
      if (chord) return { kind: "command", cmd: chord.cmd };
    }
    return ev.key.length === 1 ? character(ev.key, layout, ctx) : null;
  }

  const shift = !!ev.shiftKey;
  const alt = !!ev.altKey;
  if (ev.ctrlKey || ev.metaKey) {
    const named = pick(layout.keys.filter((b) => {
      if (!b.ctrl || !!b.shift !== shift || !!b.alt !== alt) return false;
      if (!b.code) return b.key === ev.key;
      return b.key.toLowerCase() === ev.key.toLowerCase() ||
        (b.code === ev.code && !/\p{Script=Latin}/u.test(ev.key));
    }), ctx);
    if (named) return { kind: "command", cmd: named.cmd };
    // The character the key produced is ground truth for the layout (Chromium and WebView2 keep it
    // in `key` under Ctrl): a chord that contradicts the detected layout uses the layout it proves.
    const proven = layoutFromChord(ev);
    if (proven) layout = LAYOUTS[proven];
    const b = pick(layout.ctrl.filter((b) => b.code === ev.code && !!b.shift === shift && !!b.alt === alt), ctx);
    return b ? { kind: "command", cmd: b.cmd } : null;
  }
  if (alt) return null;

  if (ctx === "string" && ev.key.length === 1) return character(ev.key, layout, ctx);
  const named = pick(layout.keys.filter((b) => !b.ctrl && b.key === ev.key && !!b.shift === shift), ctx);
  if (named) return { kind: "command", cmd: named.cmd };

  if (ev.key.length === 1) return character(ev.key, layout, ctx);
  return null;
}

/**
 * The shortcut of `cmd` on `layout`, for tooltips and the command palette: the chord as
 * printed in the vendor's shortcut reference, else the character that triggers it in a math
 * region, else a named key (`F5`, `Ctrl+Shift+Enter`). Null when the command has none.
 */
export function shortcutLabel(layout: LayoutId, cmd: string): string | null {
  const table = LAYOUTS[layout];
  const shared = table.keys.find((b) => b.code && b.cmd === cmd);
  if (shared) return namedShortcutLabel(shared);
  const chord = table.ctrl.find((b) => b.cmd === cmd);
  if (chord) return chord.pdf;
  const char = Object.entries(table.chars).find(([, command]) => command === cmd);
  if (char) return char[0];
  const key = table.keys.find((b) => b.cmd === cmd);
  return key ? namedShortcutLabel(key) : null;
}

export function namedShortcutLabel(key: KeyBinding): string {
  const name = key.key === " " ? "Space" : key.key.replace(/^Arrow/, "");
  return `${key.ctrl ? "Ctrl+" : ""}${key.alt ? "Alt+" : ""}${key.shift ? "Shift+" : ""}${name}`;
}

/** Converts a DOM KeyboardEvent to the keymap's input shape. */
export function fromDom(e: KeyboardEvent): KeyInput {
  return {
    key: e.key,
    code: e.code,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    altGraph: typeof e.getModifierState === "function" ? e.getModifierState("AltGraph") : false,
  };
}

// ---- layout detection ---------------------------------------------------------------------

/** Layout from a Keyboard Map (`navigator.keyboard.getLayoutMap()`), or null. */
export function layoutFromMap(map: { get(code: string): string | undefined }): LayoutId | null {
  const bracket = map.get("BracketLeft");
  if (bracket === "è" || map.get("Semicolon") === "ò") return "it-IT";
  if (bracket === "[") return "en-US";
  return null;
}

/**
 * Best-effort OS layout detection through the Keyboard Map API (Chromium / WebView2).
 * Returns null when the API is unavailable (WebKitGTK on Linux): the layout is then
 * learned from key events (`layoutFromEvent`) or set by the user.
 */
export async function detectLayout(): Promise<LayoutId | null> {
  const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
  if (!kb?.getLayoutMap) return null;
  try {
    return layoutFromMap(await kb.getLayoutMap());
  } catch {
    return null;
  }
}

/**
 * Punctuation whose physical key (`code`) differs between the layouts: the produced character
 * and the key it sits on, per layout (unshifted).
 */
const PUNCTUATION: { key: string; code: string; layout: LayoutId; shift?: boolean }[] = [
  { key: "-", code: "Minus", layout: "en-US" },
  { key: "-", code: "Slash", layout: "it-IT" },
  { key: "/", code: "Slash", layout: "en-US" },
  { key: "'", code: "Quote", layout: "en-US" },
  { key: "'", code: "Minus", layout: "it-IT" },
  { key: "[", code: "BracketLeft", layout: "en-US" },
  { key: "è", code: "BracketLeft", layout: "it-IT" },
  { key: ";", code: "Semicolon", layout: "en-US" },
  { key: "ò", code: "Semicolon", layout: "it-IT" },
  { key: "\\", code: "Backslash", layout: "en-US" },
  { key: "ù", code: "Backslash", layout: "it-IT" },
  { key: "=", code: "Equal", layout: "en-US" },
  { key: "ì", code: "Equal", layout: "it-IT" },
  { key: "]", code: "BracketRight", layout: "en-US" },
  { key: "+", code: "BracketRight", layout: "it-IT" },
  { key: "à", code: "Quote", layout: "it-IT" },
  { key: "`", code: "Backquote", layout: "en-US" },
  { key: "\\", code: "Backquote", layout: "it-IT" },
  // Shifted: Ctrl+Shift chords report the shifted character.
  { key: "_", code: "Minus", layout: "en-US", shift: true },
  { key: "?", code: "Minus", layout: "it-IT", shift: true },
  { key: "?", code: "Slash", layout: "en-US", shift: true },
  { key: "_", code: "Slash", layout: "it-IT", shift: true },
  { key: ":", code: "Semicolon", layout: "en-US", shift: true },
  { key: "ç", code: "Semicolon", layout: "it-IT", shift: true },
  { key: "{", code: "BracketLeft", layout: "en-US", shift: true },
  { key: "é", code: "BracketLeft", layout: "it-IT", shift: true },
  { key: "}", code: "BracketRight", layout: "en-US", shift: true },
  { key: "*", code: "BracketRight", layout: "it-IT", shift: true },
  { key: "+", code: "Equal", layout: "en-US", shift: true },
  { key: "^", code: "Equal", layout: "it-IT", shift: true },
  { key: "|", code: "Backslash", layout: "en-US", shift: true },
  { key: "§", code: "Backslash", layout: "it-IT", shift: true },
  { key: '"', code: "Quote", layout: "en-US", shift: true },
  { key: "°", code: "Quote", layout: "it-IT", shift: true },
  { key: "~", code: "Backquote", layout: "en-US", shift: true },
  { key: "|", code: "Backquote", layout: "it-IT", shift: true },
];

/**
 * The layout proved by a punctuation key (with or without Ctrl, shifted or not): the character
 * that `key` reports against the physical `code`. Null for letters, digits and everything else.
 */
export function layoutFromChord(ev: KeyInput): LayoutId | null {
  if (ev.key.length !== 1) return null;
  const shift = !!ev.shiftKey;
  return PUNCTUATION.find((p) => p.key === ev.key && p.code === ev.code && !!p.shift === shift)?.layout ?? null;
}

/** A key event that reveals the layout (the key left of `]`/`+`, `-`, `/`), or null. */
export function layoutFromEvent(ev: KeyInput): LayoutId | null {
  if (ev.altKey || ev.metaKey) return null;
  const proven = layoutFromChord(ev);
  if (proven) return proven;
  if (ev.ctrlKey) return null;
  if (ev.code === "BracketLeft") {
    if (ev.key === "è" || ev.key === "é") return "it-IT";
    if (ev.key === "[" || ev.key === "{") return "en-US";
  }
  if (ev.code === "Semicolon") {
    if (ev.key === "ò" || ev.key === "ç") return "it-IT";
    if (ev.key === ";" || ev.key === ":") return "en-US";
  }
  return null;
}

/**
 * The app always follows the system keyboard layout: there is no user setting. An older version
 * stored a choice under this key; it is ignored and removed so a stale value cannot override the
 * detected layout. The literal is the *pre-rename* spelling on purpose: it must name the key that
 * earlier build actually wrote.
 */
const LEGACY_SETTING_KEY = "sheet.keyboardLayout";

export function clearLegacyLayoutSetting(): void {
  try {
    localStorage.removeItem(LEGACY_SETTING_KEY);
  } catch {
    /* storage unavailable */
  }
}
