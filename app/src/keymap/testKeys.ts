// Test helpers: keydown inputs exactly as Windows/Chromium reports them for the US and
// Italian layouts (key = produced character, code = physical key, AltGr = Ctrl+Alt with
// `altGraph` left false on purpose, the worst case the keymap must handle).

import type { KeyInput, LayoutId } from "./keymap";

type Phys = [code: string, shift?: boolean, altGr?: boolean];

const US: Record<string, Phys> = {
  ":": ["Semicolon", true], ";": ["Semicolon"], "=": ["Equal"], "+": ["Equal", true], "-": ["Minus"],
  "*": ["Digit8", true], "/": ["Slash"], "^": ["Digit6", true], "(": ["Digit9", true], ")": ["Digit0", true],
  "[": ["BracketLeft"], "]": ["BracketRight"], "{": ["BracketLeft", true], "}": ["BracketRight", true],
  ",": ["Comma"], ".": ["Period"], "<": ["Comma", true], ">": ["Period", true], "!": ["Digit1", true], "%": ["Digit5", true],
  "|": ["Backslash", true], "\\": ["Backslash"], "\"": ["Quote", true], "'": ["Quote"], " ": ["Space"], "_": ["Minus", true],
};

const IT: Record<string, Phys> = {
  ":": ["Period", true], ";": ["Comma", true], "=": ["Digit0", true], "+": ["BracketRight"], "-": ["Slash"],
  "*": ["BracketRight", true], "/": ["Digit7", true], "^": ["Equal", true], "(": ["Digit8", true],
  ")": ["Digit9", true], "[": ["BracketLeft", false, true], "]": ["BracketRight", false, true],
  "{": ["BracketLeft", true, true], "}": ["BracketRight", true, true], ",": ["Comma"], ".": ["Period"],
  "<": ["IntlBackslash"], ">": ["IntlBackslash", true], "!": ["Digit1", true], "%": ["Digit5", true], "|": ["Backquote", true],
  "\\": ["Backquote"], "\"": ["Digit2", true], "'": ["Minus"], " ": ["Space"], "è": ["BracketLeft"],
  "ò": ["Semicolon"], "à": ["Quote"], "ù": ["Backslash"], "ì": ["Equal"], "_": ["Slash", true],
};

/** keydown for one produced character on the given layout. */
export function charKey(ch: string, layout: LayoutId): KeyInput {
  const table = layout === "en-US" ? US : IT;
  let phys: Phys | undefined = table[ch];
  if (!phys && /^[a-z]$/.test(ch)) phys = [`Key${ch.toUpperCase()}`];
  if (!phys && /^[A-Z]$/.test(ch)) phys = [`Key${ch}`, true];
  if (!phys && /^[0-9]$/.test(ch)) phys = [`Digit${ch}`];
  if (!phys) throw new Error(`no key for ${ch} on ${layout}`);
  const [code, shift = false, altGr = false] = phys;
  return { key: ch, code, shiftKey: shift, ctrlKey: altGr, altKey: altGr, altGraph: false };
}

export const named = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  code: key === " " ? "Space" : key,
  ...mods,
});

/** A Ctrl chord: physical key, the character the key produces with Ctrl held, Shift. */
export const ctrl = (code: string, key: string, shift = false): KeyInput => ({
  key,
  code,
  ctrlKey: true,
  shiftKey: shift,
});

export const typed = (text: string, layout: LayoutId): KeyInput[] => [...text].map((c) => charKey(c, layout));
