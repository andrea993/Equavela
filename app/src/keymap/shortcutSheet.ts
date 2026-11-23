// The printable keyboard shortcut sheet, generated from the keymap, so it can never disagree with
// what the keys do: every Ctrl chord, named key and math character is a row.

import { commandTitle } from "../catalog/commands";
import { KEYMAP, namedShortcutLabel, type KeyContext } from "./keymap";

export type ShortcutRow = { keys: string; context: KeyContext; cmd: string; label: string };

/** Where a binding works, in the order the sheet lists them. */
export const SHEET_CONTEXTS: KeyContext[] = ["global", "sheet", "math", "matrix", "program", "string", "text"];

/** `newProgramLine` → `New program line`: the name of a command without a palette title. */
function spelled(cmd: string): string {
  const words = cmd.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Every shortcut, grouped by context and in table order within a context. */
export function shortcutSheet(): ShortcutRow[] {
  const table = KEYMAP;
  const rows: ShortcutRow[] = [];
  const add = (keys: string, context: KeyContext, cmd: string) =>
    rows.push({ keys, context, cmd, label: commandTitle(cmd) ?? spelled(cmd) });
  for (const chord of table.ctrl) add(chord.label, chord.ctx, chord.cmd);
  for (const key of table.keys) {
    add(namedShortcutLabel(key), key.ctx, key.cmd);
  }
  for (const [ch, cmd] of Object.entries(table.chars)) add(ch, "math", cmd);
  return rows.sort((a, b) => SHEET_CONTEXTS.indexOf(a.context) - SHEET_CONTEXTS.indexOf(b.context));
}
