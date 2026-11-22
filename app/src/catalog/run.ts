// Runs a palette entry's action on the editor state: the same editor operations as the
// keymap and the ribbon (pure, one undo step per entry).

import { insertSymbolicKeyword, runCommand, typeText, type EditorState } from "../editor/model";
import type { PaletteAction } from "./palettes";

export function applyPaletteAction(editor: EditorState, action: PaletteAction): EditorState {
  switch (action.kind) {
    case "command":
      return runCommand(editor, action.command);
    case "text":
      return typeText(editor, action.text);
    case "unit":
      // The Units palette inserts the labelled name.
      return typeText(editor, action.name, "unit");
    case "keyword":
      return insertSymbolicKeyword(editor, action.name, action.modifier ?? false);
    case "sequence":
      return action.steps.reduce(applyPaletteAction, editor);
  }
}
