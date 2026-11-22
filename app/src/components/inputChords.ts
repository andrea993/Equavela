// Ctrl chords of the math editor that also work in the app's plain `<input>` fields (find bar,
// function catalogue, palette search, command palette, variables filter):
//
// - Ctrl+G toggles the Latin letter before the caret with its Greek counterpart and back (the
//   same table as in math regions, `editor/greek.ts`);
// - Ctrl+- (literal subscript) inserts `_`, the separator of the canonical name text
//   (`nameText`: `x_max`), so the next characters are the subscript and the search matches it.
//
// The chord is resolved by the keymap itself, so it is layout-robust (`keymap.resolve` takes the
// layout from the produced punctuation: Ctrl+- is on Slash on an Italian keyboard). Neither the
// browser (Ctrl+G find, Ctrl+- zoom) nor the app's global bindings see a handled key.

import type { KeyboardEvent } from "react";
import { toggleGreek } from "../editor/greek";
import { fromDom, LAYOUTS, resolve, type LayoutId } from "../keymap/keymap";

/** Replaces `input`'s text through the native setter so React's `onChange` runs, and places the caret. */
function setValue(input: HTMLInputElement, value: string, caret: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.setSelectionRange(caret, caret);
}

/**
 * Handles Ctrl+G and Ctrl+- in a text input. Returns true when the key was a chord of this kind
 * (it is then fully handled: default action and propagation stopped), false to let the caller
 * carry on with its own keys.
 */
export function handleInputChord(event: KeyboardEvent<HTMLInputElement>): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  // The layout argument only matters for punctuation, which `resolve` re-derives from the key.
  const action = resolve(fromDom(event.nativeEvent), LAYOUTS["en-US"], "math");
  if (action?.kind !== "command" || (action.cmd !== "greek" && action.cmd !== "literalSubscript")) return false;
  event.preventDefault();
  event.stopPropagation();
  const input = event.currentTarget;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  if (action.cmd === "literalSubscript") {
    setValue(input, `${input.value.slice(0, start)}_${input.value.slice(end)}`, start + 1);
    return true;
  }
  // Greek: the letter just before a collapsed caret; an empty field, a selection or a character
  // without a counterpart is a no-op.
  if (start === end && start > 0) {
    const before = [...input.value.slice(0, start)].pop() as string;
    const toggled = toggleGreek(before);
    if (toggled !== before) {
      const head = input.value.slice(0, start - before.length);
      setValue(input, `${head}${toggled}${input.value.slice(start)}`, head.length + toggled.length);
    }
  }
  return true;
}

/**
 * Whether a key switches Find and Replace between text and math mode: the
 * chord that turns text into math in a text region (`insertInlineMath`, Ctrl+M on both layouts),
 * resolved in the text context of the layout's own table. It is a switch in both
 * directions, so in a math box it wins over the matrix chord.
 */
export function isFindModeSwitch(event: { nativeEvent: globalThis.KeyboardEvent }, layout: LayoutId): boolean {
  const native = event.nativeEvent;
  if (!native.ctrlKey && !native.metaKey) return false;
  const action = resolve(fromDom(native), LAYOUTS[layout], "text");
  return action?.kind === "command" && action.cmd === "insertInlineMath";
}
