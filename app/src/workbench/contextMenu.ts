// What the right-click menu offers for each kind of thing under the pointer.
// Every entry is a window command (`catalog/commands.ts`): the menu runs the same command as the ribbon, the
// command palette and the keymap, so there is one source of what a command does and what it is called.

import { commandTitle } from "../catalog/commands";
import type { ViewRegion } from "../equavelaApi";

/** What was pressed: a region of this kind, several selected regions, a field being edited, or the empty sheet. */
export type ContextTarget = ViewRegion["kind"] | "multiple" | "field" | "sheet";

/** The entries of a menu: a command name or `-` for a separator. */
export type ContextEntry = string;

const REGION = ["copy", "cut", "paste", "deleteRegions"] as const;
const FONT = ["mathFont", "increaseFontSize", "decreaseFontSize", "resetMathFont"] as const;

/** The entries of the menu of a target, in order. */
export function contextEntries(target: ContextTarget): ContextEntry[] {
  switch (target) {
    case "math":
      return [...REGION, "-", "toggleRegionEnabled", "resultFormat", "-", ...FONT];
    case "text":
      return [
        ...REGION, "-", "textAlignLeft", "textAlignCenter", "textAlignRight", "textAlignJustify", "-",
        "textStyleNormal", "textStyleHeading1", "textStyleHeading2", "textStyleHeading3",
      ];
    case "plot":
      return [
        ...REGION, "-", "plotAddTrace", "plotRemoveTrace", "-", "plotAutoScale", "plotToggleGrid", "plotToggleAxes", "-",
        "plotLogX", "plotLogY",
      ];
    case "image":
      return [...REGION, "-", "imageReplace", "imageOriginalSize"];
    case "area":
      return ["toggleArea", "-", "copy", "cut", "paste", "deleteRegions"];
    case "include":
    case "julia":
      return [...REGION, "-", "toggleRegionEnabled"];
    case "multiple":
      return [...REGION, "-", "toggleRegionEnabled", "-", ...FONT];
    case "field":
      return ["fieldCut", "fieldCopy", "fieldPaste", "-", "fieldSelectAll"];
    case "sheet":
      return [
        "paste", "selectAll", "-", "insertMath", "insertTextRegion", "insertPlot", "insertImage", "insertTable", "insertInclude",
        "insertJulia", "insertArea", "-", "addPageBreak", "addSpace",
      ];
  }
}

/** The text of the app's own field commands (the ones that are not window commands). */
export const FIELD_COMMANDS: Record<string, string> = {
  fieldCut: "Cut",
  fieldCopy: "Copy",
  fieldPaste: "Paste",
  fieldSelectAll: "Select all",
};

const EXTRA_TITLES: Record<string, string> = {
  copy: "Copy",
  cut: "Cut",
  paste: "Paste",
  selectAll: "Select all",
  deleteRegions: "Delete",
};

/**
 * The label of a command in the menu: the plain word for the edit commands, else the palette title.
 * The disable toggle names what it will do to the pressed regions, as in the reference application:
 * `allDisabled` says they are all disabled already.
 */
export function contextLabel(cmd: string, allDisabled = false): string {
  if (cmd === "toggleRegionEnabled") return allDisabled ? "Enable evaluation" : "Disable evaluation";
  return FIELD_COMMANDS[cmd] ?? EXTRA_TITLES[cmd] ?? commandTitle(cmd) ?? cmd;
}

/**
 * The commands a menu leaves greyed out for the state of the worksheet: the font commands need a math region
 * to act on and the edit commands need something selected.
 */
export function contextDisabled(cmd: string, state: { selected: number; canFormatMath: boolean; kind: ContextTarget }): boolean {
  if (cmd === "mathFont" || cmd === "increaseFontSize" || cmd === "decreaseFontSize" || cmd === "resetMathFont") return !state.canFormatMath;
  if (state.kind === "sheet" || state.kind === "field") return false;
  if (cmd === "copy" || cmd === "cut" || cmd === "deleteRegions" || cmd === "toggleRegionEnabled") return state.selected === 0;
  return false;
}
