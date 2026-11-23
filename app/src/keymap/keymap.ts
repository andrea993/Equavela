// Keymap: one table for every keyboard layout, context-scoped.
//
// A Ctrl shortcut is the US character it types: `Ctrl+[` is Ctrl and the character `[`, typed on any
// layout with the keys that layout uses for it (`Ctrl+AltGr+è` on the Italian one). A layout that
// cannot type a character has no shortcut for it; the command stays in the ribbon and the palette.
//
// Resolution order for a keydown:
//  1. An explicit Ctrl+Alt binding.
//  2. AltGr (`getModifierState("AltGraph")`, or Ctrl+Alt with a character, as Windows sends it): the
//     typed character is a Ctrl shortcut when the real Ctrl key is down too (`realCtrl`, read from
//     the key events: Windows synthesizes a Ctrl for AltGr), otherwise it is a plain character.
//  3. Ctrl: named keys with Ctrl (Ctrl+arrows, Ctrl+F5), then the Ctrl table matched on the typed
//     character (a letter of another script falls back to the physical letter key).
//  4. Named keys (Space, Enter, Tab, arrows, ...), matched on `key`.
//  5. Printable characters, matched on the produced character (`key`).
//
// Contexts form a chain: the most specific context that has a binding wins.
// `matrix` and `program` fall back to `math`; every context falls back to `global`.
// In the `string` context (typing a string literal) every printable key is text.

import common from "./common.json";
import shortcuts from "./shortcuts.json";
import { realCtrlDown } from "./nativeKeys";

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
  /**
   * Whether a Ctrl key the user pressed is down, read from the key events (`nativeKeys.ts`);
   * undefined where it is unknown. With AltGr, Windows presses a Ctrl of its own, which does not count.
   */
  realCtrl?: boolean;
}

export interface CtrlBinding {
  /** The character typed with Ctrl: a letter in lower case (with `shift` for its upper case). */
  key: string;
  shift?: boolean;
  alt?: boolean;
  ctx: KeyContext;
  cmd: string;
  /** The US combination, shown in menus and tooltips. */
  label: string;
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

export interface KeymapTable {
  ctrl: CtrlBinding[];
  keys: KeyBinding[];
  chars: Record<string, string>;
}

export type Action = { kind: "command"; cmd: string } | { kind: "char"; ch: string };

export const KEYMAP: KeymapTable = {
  ctrl: shortcuts.ctrl as CtrlBinding[],
  keys: common.keys as KeyBinding[],
  chars: common.chars as Record<string, string>,
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

/** A key typed with AltGr: reported as such, or as Ctrl+Alt with a character (Windows). */
export function isAltGr(ev: KeyInput): boolean {
  if (ev.altGraph) return true;
  return !!ev.ctrlKey && !!ev.altKey && ev.key.length === 1 && ev.key !== " ";
}

/** Whether a Ctrl key the user pressed is down while AltGr is, read from the key events. */
function realCtrlWithAltGr(ev: KeyInput): boolean {
  if (ev.realCtrl !== undefined) return ev.realCtrl;
  // Linux reports AltGr as a key of its own: `ctrlKey` is the real Ctrl, and Alt is not down.
  return !!ev.altGraph && !!ev.ctrlKey && !ev.altKey;
}

function character(ch: string, ctx: KeyContext): Action | null {
  if (ctx === "string") return ch === '"' ? { kind: "command", cmd: "endString" } : { kind: "char", ch };
  if (inMath(ctx)) {
    const cmd = KEYMAP.chars[ch];
    return cmd ? { kind: "command", cmd } : { kind: "char", ch };
  }
  // On the sheet a printable character starts a math region at the crosshair.
  if (ctx === "sheet" && ch !== " ") return { kind: "char", ch };
  return null;
}

/** The Ctrl shortcut of the character `ev` typed, in `ctx`. */
function ctrlShortcut(ev: KeyInput, ctx: KeyContext, alt: boolean): Action | null {
  let key = ev.key;
  // A letter of another script (a Cyrillic layout) is the Latin letter of its physical key.
  if (/^\p{L}$/u.test(key) && !/\p{Script=Latin}/u.test(key) && /^Key[A-Z]$/.test(ev.code)) key = ev.code.slice(3);
  const letter = /^[a-zA-Z]$/.test(key);
  const shift = !!ev.shiftKey;
  const b = pick(
    KEYMAP.ctrl.filter((b) =>
      !!b.alt === alt && (letter ? b.key === key.toLowerCase() && !!b.shift === shift : b.key === key),
    ),
    ctx,
  );
  return b ? { kind: "command", cmd: b.cmd } : null;
}

export function resolve(ev: KeyInput, ctx: KeyContext): Action | null {
  if (/^(Control|Alt|AltGraph|Shift|Meta|CapsLock|Dead|Process|Unidentified)$/.test(ev.key)) return null;

  const shift = !!ev.shiftKey;
  if (ev.ctrlKey && ev.altKey) {
    // An explicit Ctrl+Alt binding wins over typing with AltGr.
    const chord = pick(KEYMAP.keys.filter((b) => b.ctrl && b.alt && !!b.shift === shift && b.key === ev.key), ctx);
    if (chord) return { kind: "command", cmd: chord.cmd };
  }
  if (isAltGr(ev)) {
    if (realCtrlWithAltGr(ev) && ev.key.length === 1) return ctrlShortcut(ev, ctx, false);
    return ev.key.length === 1 ? character(ev.key, ctx) : null;
  }

  const alt = !!ev.altKey;
  if (ev.ctrlKey || ev.metaKey) {
    const named = pick(KEYMAP.keys.filter((b) => {
      if (!b.ctrl || !!b.shift !== shift || !!b.alt !== alt) return false;
      if (!b.code) return b.key === ev.key;
      return b.key.toLowerCase() === ev.key.toLowerCase() ||
        (b.code === ev.code && !/\p{Script=Latin}/u.test(ev.key));
    }), ctx);
    if (named) return { kind: "command", cmd: named.cmd };
    return ctrlShortcut(ev, ctx, alt);
  }
  if (alt) return null;

  if (ctx === "string" && ev.key.length === 1) return character(ev.key, ctx);
  const named = pick(KEYMAP.keys.filter((b) => !b.ctrl && b.key === ev.key && !!b.shift === shift), ctx);
  if (named) return { kind: "command", cmd: named.cmd };

  if (ev.key.length === 1) return character(ev.key, ctx);
  return null;
}

/**
 * The shortcut of `cmd`, for tooltips and the command palette: the US Ctrl combination, else the
 * character that triggers it in a math region, else a named key (`F5`, `Ctrl+Shift+Enter`). Null
 * when the command has none.
 */
export function shortcutLabel(cmd: string): string | null {
  const shared = KEYMAP.keys.find((b) => b.code && b.cmd === cmd);
  if (shared) return namedShortcutLabel(shared);
  const chord = KEYMAP.ctrl.find((b) => b.cmd === cmd);
  if (chord) return chord.label;
  const char = Object.entries(KEYMAP.chars).find(([, command]) => command === cmd);
  if (char) return char[0];
  const key = KEYMAP.keys.find((b) => b.cmd === cmd);
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
    realCtrl: realCtrlDown(),
  };
}
