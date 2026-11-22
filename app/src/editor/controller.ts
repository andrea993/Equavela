// The editor's only entry point for keys: `handleKey(state, event, layout)`, pure and used
// by both the UI and the tests.

import { LAYOUTS, resolve, type Action, type KeyInput, type LayoutId } from "../keymap/keymap";
import {
  MODEL_COMMANDS,
  contextOf,
  enterInMath,
  runCommand,
  typeCharacter,
  type Command,
  type EditorState,
} from "./model";

export interface KeyResult {
  state: EditorState;
  /** What the key resolved to; null when the keymap has no binding. */
  action: Action | null;
  /**
   * True when the model consumed the key. A resolved action that is not handled is a
   * window command (Enter = leave the region, Ctrl+M = matrix size dialog, F5, ...).
   */
  handled: boolean;
}

export function handleKey(state: EditorState, ev: KeyInput, layout: LayoutId): KeyResult {
  const action = resolve(ev, LAYOUTS[layout], contextOf(state));
  if (!action) return { state, action, handled: false };
  if (action.kind === "char") return { state: typeCharacter(state, action.ch), action, handled: true };
  // Enter right after a breakable operator breaks the line instead of leaving.
  // The same in a program line, where Enter would otherwise start the next line.
  if (action.cmd === "exitRegion" || action.cmd === "newProgramLine") {
    const broken = enterInMath(state);
    if (broken) return { state: broken, action, handled: true };
  }
  if (!MODEL_COMMANDS.has(action.cmd)) return { state, action, handled: false };
  return { state: runCommand(state, action.cmd as Command), action, handled: true };
}
