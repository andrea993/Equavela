// The command palette's catalogue: one list over workbench commands,
// palette entries (operators, symbols, constants, programming, symbolic keywords and
// modifiers), units and built-in functions. Entries run through the same paths as the
// ribbon and the keymap, and show the shortcut of the active layout.

import type { Command } from "../editor/model";
import { shortcutLabel } from "../keymap/keymap";
import { BUILTIN_ENTRIES } from "./builtins";
import { DEGREE_ENTRY, GREEK_LOWER, GREEK_UPPER, PALETTE_KINDS, paletteSections, type PaletteAction, type PaletteKind } from "./palettes";
import { UNIT_ENTRIES, UNIT_PREFIXES } from "./units";

export type CommandRun =
  | { kind: "action"; action: PaletteAction }
  | { kind: "window"; cmd: string }
  | { kind: "palette"; palette: PaletteKind }
  | { kind: "catalogue" };

export type CommandGroup =
  | "Command"
  | "Palette"
  | "Operator"
  | "Symbol"
  | "Programming"
  | "Constant"
  | "Symbolic"
  | "Unit"
  | "Function";

export type CommandItem = {
  id: string;
  group: CommandGroup;
  /** The glyph or name shown first (operator glyph, function name, unit). */
  label: string;
  /** One line of explanation. */
  title: string;
  shortcut: string | null;
  keywords: string;
  run: CommandRun;
};

const WINDOW_COMMANDS: ReadonlyArray<[string, string, string]> = [
  ["juliaEnvironment", "Julia environment…", "packages kernel julia manager"],
  ["toggleRepl", "Julia REPL", "repl console kernel julia interactive terminal"],
  ["restartRepl", "Restart REPL", "repl restart kernel julia reset terminal"],
  ["newProject", "New project…", "project folder create"],
  ["packProject", "Pack project as .eqvz…", "project archive export portable"],
  ["extractProject", "Extract project from .eqvz…", "project archive import unpack"],
  ["openProject", "Open project…", "project folder load"],
  ["closeProject", "Close project", "project folder close workspace"],
  ["projectSettings", "Project settings…", "project main worksheet environment packages configuration"],
  ["projectImageUsage", "Image resource usage…", "project assets images references missing unused owners"],
  ["textRecoveries", "Recovered text files…", "recovery backup autosave restore moved missing project source text julia"],
  ["convertToProject", "Convert to project…", "project folder worksheet portable eqvz export"],
  // the Code tab's commands, acting on the project text file in front.
  ["codeFind", "Code: Find", "text file editor search julia"],
  ["codeReplace", "Code: Replace", "text file editor search substitute julia"],
  ["codeGoToLine", "Code: Go to line", "text file editor line number jump julia"],
  ["codeToggleComment", "Code: Toggle line comment", "text file editor comment hash julia"],
  ["codeIndent", "Code: Indent", "text file editor tab spaces julia"],
  ["codeOutdent", "Code: Outdent", "text file editor tab spaces julia"],
  ["codeDuplicateLine", "Code: Duplicate line", "text file editor copy line julia"],
  ["codeMoveLineUp", "Code: Move line up", "text file editor reorder julia"],
  ["codeMoveLineDown", "Code: Move line down", "text file editor reorder julia"],
  ["fileReveal", "Code: Show file in folder", "text image file explorer reveal"],
  ["newDocument", "New worksheet", "file create"],
  ["openDocument", "Open worksheet", "file load"],
  ["save", "Save worksheet", "file write store"],
  ["saveAs", "Save worksheet as", "file write store export"],
  ["options", "Options…", "settings preferences autosave recovery backup"],
  ["shortcutSheet", "Keyboard shortcuts", "keys chords hotkeys print sheet reference"],
  ["importReport", "Show import report", "mcdx import issues not imported details"],
  ["exportPdf", "Export PDF…", "pdf print save file export"],
  ["print", "Print…", "printer paper ctrl+p"],
  ["closeDocument", "Close worksheet", "file"],
  ["undo", "Undo", "revert"],
  ["redo", "Redo", "repeat"],
  ["calculate", "Calculate", "recalculate evaluate run"],
  ["calculateAll", "Calculate worksheet", "recalculate all evaluate run"],
  ["toggleCalculation", "Toggle automatic calculation", "auto manual mode"],
  ["stop", "Stop calculation", "interrupt cancel"],
  ["toggleRegionEnabled", "Disable or enable selected regions", "calculate skip ignore stop evaluate region disable enable"],
  ["selectAll", "Select all regions", "select"],
  ["deleteRegions", "Delete selected regions", "remove"],
  ["replace", "Replace with…", "find search substitute swap edit"],
  ["insertMath", "Insert math region", "new equation"],
  ["insertText", "Insert text block (full width)", "new text block ctrl+shift+t"],
  ["insertTextRegion", "Insert text region", "new text ctrl+t"],
  ["insertImage", "Insert image…", "picture png svg jpg jpeg figure"],
  ["insertArea", "Insert area", "collapse group section band"],
  ["insertTable", "Insert table", "table data sets columns matrix"],
  ["matrixDialog", "Insert matrix…", "array table size"],
  ["resultFormat", "Result format…", "number format decimal scientific engineering percent polar complex nested"],
  // the Matrix tab's display checkbox. The palette entry toggles it; no chord on either layout.
  ["matrixShowIndices", "Matrix: show indices", "matrix indices index row column numbers display show hide toggle array"],
  // Math Formatting: no chord on either layout, so palette entries only.
  ["increaseFontSize", "Increase font size", "math font size bigger larger formatting"],
  ["decreaseFontSize", "Decrease font size", "math font size smaller formatting"],
  ["mathFont", "Math font…", "math font size color colour highlight background formatting"],
  ["resetMathFont", "Reset math style", "math font default reset formatting size color colour highlight"],
  ["labelStyles", "Label styles…", "label style bold italic underline color colour variable constant function unit system keyword formatting"],
  ["worksheetFormat", "Worksheet format…", "number format precision complex worksheet default all regions"],
  ["spelling", "Spelling…", "spelling spell check checker dictionary language download english italian ignore"],
  ["toggleSpelling", "Check spelling", "spelling spell check underline misspelt words on off toggle"],
  ["pageSetup", "Page setup…", "page size orientation margins paper layout a4 letter landscape portrait"],
  ["calculationSettings", "Calculation settings…", "tolerance tol ctol convergence constraint solve block origin"],
  ["headerFooter", "Header and footer…", "header footer page number date file name title running head"],
  ["zoomIn", "Zoom in", "magnify"],
  ["zoomOut", "Zoom out", "shrink"],
  ["zoomReset", "Zoom to 100%", "reset"],
  ["fitWidth", "Fit page width", "zoom"],
  ["fitPage", "Fit page", "zoom whole page"],
  ["pageView", "Page view", "layout"],
  ["draftView", "Draft view", "layout"],
  // Document > Spacing. No chord on either layout.
  ["addPageBreak", "Add page break", "page break spacing document new page"],
  ["addSpace", "Add space (one line)", "line space spacing document insert down"],
  ["removeSpace", "Remove space (one line)", "line space spacing document remove delete up"],
  ["functionCatalogue", "Open the function catalogue", "functions help builtin"],
  ["functionHelp", "Help for the function at the cursor", "documentation f1"],
  ["openManual", "Manual", "help documentation guide reference user manual"],
  ["insertPlot", "Insert XY plot", "graph chart trace"],
  ["insertInclude", "Insert include", "include worksheet reference library"],
  ["insertJulia", "Insert Julia block", "julia code program script package"],
  ["untrustWorksheet", "Stop trusting this worksheet", "trust julia security untrusted revoke"],
  ["importMcdx", "Import .mcdx or .xmcd worksheet…", "mcdx xmcd worksheet open convert legacy"],
  ["previousProblem", "Previous problem", "error warning tracing"],
  ["nextProblem", "Next problem", "error warning tracing"],
  ["problemsPanel", "Show problems", "errors warnings side panel"],
  ["sidePanel", "Toggle side panel", "variables outline problems includes"],
  ["toggleCompactRibbon", "Toggle compact ribbon", "icons small toolbar"],
  // Plot tab: they act on the one selected plot.
  ["plotAddTrace", "Plot: add trace", "series curve"],
  ["plotRemoveTrace", "Plot: remove selected trace", "series curve delete"],
  // The trace type of the specification : no chord on the US or the Italian layout.
  ["plotLineTrace", "Plot: line trace", "trace type lines curve join"],
  ["plotStemTrace", "Plot: stem trace", "trace type stems spectrum impulse"],
  ["plotBarTrace", "Plot: bar trace", "trace type bars histogram column"],
  ["plotStepTrace", "Plot: step trace", "trace type steps staircase"],
  ["plotLines", "Plot: lines", "trace style type line"],
  ["plotMarkers", "Plot: markers", "trace style type symbol points"],
  ["plotLinesMarkers", "Plot: lines and markers", "trace style type symbol points"],
  ["plotLogX", "Plot: logarithmic x axis", "log scale scaling"],
  ["plotLogY", "Plot: logarithmic y axis", "log scale scaling"],
  ["plotLogY2", "Plot: logarithmic right y axis", "log scale scaling second axis"],
  ["plotAutoScale", "Plot: auto scale", "axis limits range reset"],
  ["plotToggleAxes", "Plot: axes at the origin", "axis origin crossed boundary boxed position zero"],
  ["plotToggleGrid", "Plot: grid", "axis gridlines show hide"],
  // Area tab: acts on the one selected area.
  ["toggleArea", "Collapse or expand area", "area fold unfold hide show"],
  // Text tab: paragraph style and alignment. the reference application has no chord for any of them
  // on the US or the Italian layout, so they are palette entries only. They act on the open
  // text region, as the keymap's text formats do.
  ["textAlignLeft", "Text: align left", "paragraph alignment left flush text"],
  ["textAlignCenter", "Text: align centre", "paragraph alignment centre center middle text"],
  ["textAlignRight", "Text: align right", "paragraph alignment right flush text"],
  ["textAlignJustify", "Text: justify", "paragraph alignment justify both margins text"],
  ["textStyleNormal", "Text style: Normal", "paragraph style body text"],
  ["textStyleTitle", "Text style: Title", "paragraph style title document heading"],
  ["textStyleSubtitle", "Text style: Subtitle", "paragraph style subtitle document"],
  ["textStyleHeading1", "Text style: Heading 1", "paragraph style heading chapter section title level 1"],
  ["textStyleHeading2", "Text style: Heading 2", "paragraph style heading section level 2"],
  ["textStyleHeading3", "Text style: Heading 3", "paragraph style heading level 3"],
  // Image tab: acts on the one selected image. the reference application has no chord for either on US or Italian.
  ["imageOriginalSize", "Image: original size", "picture natural size reset fit 1:1"],
  ["imageReplace", "Image: replace…", "picture swap change file picture"],
  ["juliaOriginalSize", "Julia: reset to content size", "julia resize natural automatic fit"],
];

/** The palette title of a window or editor command, for the shortcut sheet; `null` when it has none. */
export function commandTitle(cmd: string): string | null {
  return (
    WINDOW_COMMANDS.find(([id]) => id === cmd)?.[1] ??
    MATRIX_COMMANDS.find(([id]) => id === cmd)?.[1] ??
    null
  );
}

/** Editor commands: matrix editing and math style. */
const MATRIX_COMMANDS: ReadonlyArray<[Command, string, string]> = [
  ["addRowAbove", "Insert row above", "matrix array table"],
  ["addRow", "Insert row below", "matrix array table"],
  ["addColumnLeft", "Insert column left", "matrix array table"],
  ["addColumn", "Insert column right", "matrix array table"],
  ["clearCells", "Clear cells", "matrix array table empty"],
  ["deleteRow", "Delete row", "matrix array table remove"],
  ["deleteColumn", "Delete column", "matrix array table remove"],
  ["selectRow", "Select row", "matrix array table"],
  ["selectColumn", "Select column", "matrix array table"],
  ["label", "Label", "style variable unit function constant"],
  ["unitLabel", "Make unit", "style unit label litre selection"],
  ["literalSubscript", "Literal subscript", "style index name"],
  ["toggleBreak", "Equation break", "style line wrap"],
  ["insertLineBreak", "Line break", "style line wrap new line return arrow"],
  ["toggleBoundGlyph", "Sum or product: = or := in the lower slot", "index bound define glyph sigma product"],
];

const PALETTE_TITLES: Record<PaletteKind, string> = {
  operators: "Operators palette",
  symbols: "Symbols palette",
  programming: "Programming palette",
  constants: "Constants palette",
  symbolics: "Symbolics palette",
  matrixFunctions: "Vector/Matrix functions palette",
  units: "Units palette",
};

const ENTRY_GROUP: Partial<Record<PaletteKind, CommandGroup>> = {
  operators: "Operator",
  symbols: "Symbol",
  programming: "Programming",
  constants: "Constant",
  symbolics: "Symbolic",
};

/** Every unit name the engine accepts: base units and their SI-prefixed forms. */
function unitItems(): CommandItem[] {
  const plain = new Set(UNIT_ENTRIES.map((u) => u.name));
  const items: CommandItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, group: string, definition: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push({
      id: `unit:${name}`,
      group: "Unit",
      label: name,
      title: group,
      shortcut: null,
      keywords: `${definition} unit`,
      run: { kind: "action", action: { kind: "text", text: name } },
    });
  };
  for (const unit of UNIT_ENTRIES) add(unit.name, unit.group, unit.definition);
  for (const unit of UNIT_ENTRIES) {
    if (!unit.prefixable) continue;
    for (const { prefix } of UNIT_PREFIXES) {
      const name = `${prefix}${unit.name}`;
      if (!plain.has(name)) add(name, `${unit.group} (${prefix} prefix)`, unit.definition);
    }
  }
  return items;
}

export function buildCommandItems(): CommandItem[] {
  const items: CommandItem[] = [];
  for (const [cmd, title, keywords] of WINDOW_COMMANDS) {
    items.push({
      id: `cmd:${cmd}`, group: "Command", label: title, title: "", shortcut: shortcutLabel(cmd),
      keywords, run: { kind: cmd === "functionCatalogue" ? "catalogue" : "window", cmd } as CommandRun,
    });
  }
  for (const [command, title, keywords] of MATRIX_COMMANDS) {
    items.push({
      id: `matrix:${command}`, group: "Command", label: title, title: "", shortcut: shortcutLabel(command),
      keywords, run: { kind: "action", action: { kind: "command", command } },
    });
  }
  for (const palette of PALETTE_KINDS) {
    items.push({
      id: `palette:${palette}`, group: "Palette", label: PALETTE_TITLES[palette], title: "", shortcut: null,
      keywords: "open show floating", run: { kind: "palette", palette },
    });
  }
  for (const palette of PALETTE_KINDS) {
    const group = ENTRY_GROUP[palette];
    if (!group) continue;
    for (const section of paletteSections(palette)) {
      section.entries.forEach((entry, index) => {
        // Both palettes expose the same degree unit, indexed once under Operators.
        if (entry.disabled || (palette === "symbols" && entry === DEGREE_ENTRY)) return;
        items.push({
          id: `${palette}:${section.id}:${index}:${entry.label}`,
          group: palette === "symbolics" && section.id === "operators" ? "Operator" : group,
          label: entry.glyph ?? entry.label,
          title: `${entry.title} (${section.title})`,
          shortcut: entry.action.kind === "command" ? shortcutLabel(entry.action.command) : null,
          keywords: entry.keywords ?? "",
          run: { kind: "action", action: entry.action },
        });
      });
    }
  }
  for (const entry of BUILTIN_ENTRIES) {
    items.push({
      id: `fn:${entry.name}`, group: "Function", label: entry.name, title: `${entry.signature}: ${entry.description}`,
      shortcut: null, keywords: `${entry.category} function builtin`,
      run: { kind: "action", action: { kind: "text", text: entry.name } },
    });
  }
  items.push(...unitItems());
  return items;
}

const TYPED_OPERATORS = new Set<Command>([
  "add", "sub", "mul", "factorial", "percent", "openParen", "comma",
  "less", "greater", "define", "evaluate",
]);

function isEquationInsertion({ run, group }: CommandItem): boolean {
  if (run.kind !== "action" || group === "Unit" || group === "Function") return false;
  const action = run.action;
  switch (action.kind) {
    case "text":
      return /[^\x00-\x7f]/u.test(action.text);
    case "sequence":
      return true;
    case "command":
      if (group === "Command") return action.command === "literalSubscript" || action.command === "insertLineBreak";
      return !TYPED_OPERATORS.has(action.command);
    default:
      return false;
  }
}

const GREEK_NAMES = [
  "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa",
  "Lambda", "Mu", "Nu", "Xi", "Omicron", "Pi", "Rho", "Sigma", "Tau", "Upsilon", "Phi", "Chi", "Psi", "Omega",
];
const GREEK_TITLES = new Map([
  ...[...GREEK_LOWER.replace(/[ςϕ]/g, "")].map((ch, i) => [ch, GREEK_NAMES[i]] as const),
  ...[...GREEK_UPPER].map((ch, i) => [ch, `${GREEK_NAMES[i]} (uppercase)`] as const),
  ["ς", "Final sigma"],
  ["ϕ", "Phi variant"],
]);

/** Insert-tab commands that add a region of their own, listed by a search on empty space. */
export const REGION_INSERTIONS: ReadonlySet<string> = new Set([
  "insertText", "insertTextRegion", "insertPlot", "insertTable", "insertImage",
  "insertArea", "insertInclude", "insertJulia", "addPageBreak",
]);

function isInsertion(item: CommandItem, atCrosshair: boolean): boolean {
  if (item.run.kind !== "window") return isEquationInsertion(item);
  return item.run.cmd === "matrixDialog" || (atCrosshair && REGION_INSERTIONS.has(item.run.cmd));
}

/**
 * Special glyphs and structural insertions for the caret-local search, and the matrix dialog. On
 * empty worksheet space (`atCrosshair`) it also lists the Insert-tab regions.
 */
export function equationInsertionItems(items: readonly CommandItem[], atCrosshair = false): CommandItem[] {
  return items.filter((item) => isInsertion(item, atCrosshair)).map((item) => {
    const name = item.group === "Symbol" ? GREEK_TITLES.get(item.label) : undefined;
    return name ? { ...item, title: `${name} (Greek letters)` } : item;
  });
}

/** What is in front when the palette opens: commands that cannot act on it are left out. */
export type CommandScope = {
  /** The kind of the project file tab in front, or null for a worksheet. */
  fileTab: "text" | "image" | null;
  project: boolean;
  /** The ribbon's contextual object (the plot, image, matrix, area or text being edited). */
  object: "text" | "matrix" | "plot" | "area" | "image" | null;
  /** The kind of the one selected region, if exactly one is selected. */
  selectedKind: string | null;
  mathEditing: boolean;
  inMatrix: boolean;
};

const PROJECT_ONLY = new Set(["closeProject", "projectSettings", "projectImageUsage", "packProject"]);
const MATRIX_EDIT = new Set<string>(["addRowAbove", "addRow", "addColumnLeft", "addColumn", "clearCells", "deleteRow", "deleteColumn", "selectRow", "selectColumn"]);
const MATH_EDIT = new Set<string>(["label", "unitLabel", "literalSubscript", "toggleBreak", "insertLineBreak", "toggleBoundGlyph"]);

/** Whether the command of a palette item can act in this scope. */
export function commandApplies(item: CommandItem, scope: CommandScope): boolean {
  const run = item.run;
  if (run.kind === "action" && run.action.kind === "command") {
    const command: string = run.action.command;
    if (item.id.startsWith("matrix:") && MATRIX_EDIT.has(command)) return scope.mathEditing && scope.inMatrix;
    if (item.id.startsWith("matrix:") && MATH_EDIT.has(command)) return scope.mathEditing;
    return true;
  }
  if (run.kind !== "window") return true;
  const cmd = run.cmd;
  if (cmd === "fileReveal") return scope.fileTab !== null;
  if (cmd.startsWith("code")) return scope.fileTab === "text";
  if (PROJECT_ONLY.has(cmd)) return scope.project;
  if (cmd.startsWith("plot")) return scope.object === "plot";
  if (cmd.startsWith("image")) return scope.object === "image";
  if (cmd === "matrixShowIndices") return scope.object === "matrix";
  if (cmd === "juliaOriginalSize") return scope.selectedKind === "julia";
  return true;
}

/** Ranked search: every word must occur; exact and prefix matches of the label rank first. */
export function searchCommands(items: readonly CommandItem[], query: string, limit = 60, insertion = false): CommandItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return (insertion ? items : items.filter((item) => item.group === "Command" || item.group === "Palette")).slice(0, limit);
  const typed = query.trim();
  const normalized = words.join(" ");
  const scored: Array<{ item: CommandItem; score: number; exactCase: number; order: number }> = [];
  items.forEach((item, order) => {
    const label = item.label.toLowerCase();
    const text = `${item.label} ${item.title} ${item.keywords} ${item.group}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) return;
    const first = words[0];
    // In an equation, a typed name should find its operator even when the displayed label is a glyph.
    const operatorName = insertion && item.group === "Operator" && item.title.toLowerCase().startsWith(normalized);
    const score = label === typed.toLowerCase() ? 0 : operatorName ? 1 : label.startsWith(first) ? 2 : label.includes(first) ? 3 : 4;
    // Among equally good matches the one spelled exactly as typed wins (`kN` the unit, not `Kn`).
    scored.push({ item, score, exactCase: item.label === typed ? 0 : 1, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.exactCase - b.exactCase || a.order - b.order).slice(0, limit).map((s) => s.item);
}
