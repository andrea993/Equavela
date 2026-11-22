// Every shortcut of the work-plan table (section 2.3) that the editor covers, transcribed
// here independently of the JSON tables and fed as key events on both layouts.

import { describe, expect, it } from "vitest";
import { LAYOUTS, layoutFromChord, layoutFromEvent, layoutFromMap, resolve, shortcutLabel, type KeyContext, type KeyInput, type LayoutId } from "./keymap";
import { charKey, ctrl, named } from "./testKeys";

type Case = { label: string; ev: KeyInput; ctx: KeyContext; cmd: string };

const shift = (code: string, key: string) => ctrl(code, key, true);

/** Ctrl chords whose physical key is the same on both layouts. */
const SAME: Array<[string, KeyInput, KeyContext, string]> = [
  ["Ctrl+G", ctrl("KeyG", "g"), "math", "greek"],
  ["Ctrl+.", ctrl("Period", "."), "math", "symbolic"],
  ["Ctrl+L", ctrl("KeyL", "l"), "math", "limit"],
  ["Ctrl+9", ctrl("Digit9", "9"), "math", "lessEq"],
  ["Ctrl+0", ctrl("Digit0", "0"), "math", "greaterEq"],
  ["Ctrl+Shift+D", shift("KeyD", "D"), "math", "deriv"],
  ["Ctrl+D", ctrl("KeyD", "d"), "math", "partial"],
  ["Ctrl+Shift+I", shift("KeyI", "I"), "math", "integral"],
  ["Ctrl+M", ctrl("KeyM", "m"), "math", "matrix"],
  ["Ctrl+Shift+C", shift("KeyC", "C"), "math", "column"],
  ["Ctrl+Shift+R", shift("KeyR", "R"), "math", "row"],
  ["Ctrl+Shift+T (math)", shift("KeyT", "T"), "math", "transpose"],
  ["Ctrl+Shift+T (sheet)", shift("KeyT", "T"), "sheet", "insertText"],
  ["Ctrl+T (sheet)", ctrl("KeyT", "t"), "sheet", "insertTextRegion"],
  ["Ctrl+8", ctrl("Digit8", "8"), "math", "cross"],
  ["Ctrl+Shift+Z", shift("KeyZ", "Z"), "math", "infinity"],
  ["Ctrl+Q", ctrl("KeyQ", "q"), "math", "label"],
  ["Ctrl+J", ctrl("KeyJ", "j"), "math", "wordToOperator"],
  ["Ctrl+Shift+M", shift("KeyM", "M"), "sheet", "insertMath"],
  ["Ctrl+N", ctrl("KeyN", "n"), "sheet", "newDocument"],
  ["Ctrl+O", ctrl("KeyO", "o"), "math", "openDocument"],
  ["Ctrl+S", ctrl("KeyS", "s"), "sheet", "save"],
  ["Ctrl+Shift+S", shift("KeyS", "S"), "sheet", "saveAs"],
  ["Ctrl+Shift+S (math)", shift("KeyS", "S"), "math", "saveAs"],
  ["Ctrl+P", ctrl("KeyP", "p"), "sheet", "print"],
  ["Ctrl+W", ctrl("KeyW", "w"), "sheet", "closeDocument"],
  ["Ctrl+A", ctrl("KeyA", "a"), "sheet", "selectAll"],
  ["Ctrl+Z", ctrl("KeyZ", "z"), "math", "undo"],
  ["Ctrl+K", ctrl("KeyK", "k"), "math", "commandPalette"],
  ["Ctrl+K (sheet)", ctrl("KeyK", "k"), "sheet", "commandPalette"],
  ["Ctrl+Y", ctrl("KeyY", "y"), "sheet", "redo"],
  ["Ctrl+0 (sheet)", ctrl("Digit0", "0"), "sheet", "zoomReset"],
  ["Ctrl+B (text)", ctrl("KeyB", "b"), "text", "toggleBold"],
  ["Ctrl+I (text)", ctrl("KeyI", "i"), "text", "toggleItalic"],
  ["Ctrl+U (text)", ctrl("KeyU", "u"), "text", "toggleUnderline"],
  // decision: in math, Ctrl+U makes the name left of the caret a unit.
  ["Ctrl+U (math)", ctrl("KeyU", "u"), "math", "unitLabel"],
  ["Ctrl+M (text)", ctrl("KeyM", "m"), "text", "insertInlineMath"],
  ["Ctrl+Shift+M (text)", shift("KeyM", "M"), "text", "insertInlineMath"],
  ["Escape (text)", named("Escape"), "text", "leaveText"],
  ["Ctrl+C", ctrl("KeyC", "c"), "math", "copy"],
  ["Ctrl+X", ctrl("KeyX", "x"), "math", "cut"],
  ["Ctrl+V", ctrl("KeyV", "v"), "math", "paste"],
  ["Ctrl+C (sheet)", ctrl("KeyC", "c"), "sheet", "copy"],
  ["Ctrl+V (text falls back to the global binding)", ctrl("KeyV", "v"), "text", "paste"],
];

const US: Array<[string, KeyInput, KeyContext, string]> = [
  ["Ctrl+-", ctrl("Minus", "-"), "math", "literalSubscript"],
  ["Ctrl+Shift+~", shift("Backquote", "~"), "math", "globalDefine"],
  ["Ctrl+/", ctrl("Slash", "/"), "math", "inlineDiv"],
  ["Ctrl+=", ctrl("Equal", "="), "math", "boolEq"],
  ["Ctrl+Shift+&", shift("Digit7", "&"), "math", "and"],
  ["Ctrl+Shift+@", shift("Digit2", "@"), "math", "or"],
  ["Ctrl+Shift+!", shift("Digit1", "!"), "math", "not"],
  ["Ctrl+Shift+%", shift("Digit5", "%"), "math", "xor"],
  ["Ctrl+'", ctrl("Quote", "'"), "math", "primeDeriv"],
  ["Ctrl+Shift+$", shift("Digit4", "$"), "math", "sum"],
  ["Ctrl+Shift+#", shift("Digit3", "#"), "math", "prod"],
  ["Ctrl+Shift+(", shift("Digit9", "("), "math", "conj"],
  ["Ctrl+Shift+|", shift("Backslash", "|"), "math", "norm"],
  ["Ctrl+Shift+^", shift("Digit6", "^"), "math", "vectorize"],
  ["Ctrl+Shift+}", shift("BracketRight", "}"), "program", "else"],
  ["Ctrl+;", ctrl("Semicolon", ";"), "program", "elseIf"],
  ["Ctrl+Shift+)", shift("Digit0", ")"), "program", "alsoIf"],
  ["Ctrl+]", ctrl("BracketRight", "]"), "math", "while"],
  ['Ctrl+Shift+"', shift("Quote", '"'), "math", "for"],
  ["Ctrl+Shift+{", shift("BracketLeft", "{"), "program", "break"],
  ["Ctrl+Shift+:", shift("Semicolon", ":"), "program", "continue"],
  ["Ctrl+\\", ctrl("Backslash", "\\"), "program", "return"],
  ["Ctrl+[", ctrl("BracketLeft", "["), "math", "try"],
  ["Ctrl+Shift++", shift("Equal", "+"), "math", "addBreak"],
  ["Ctrl+Shift+-", shift("Minus", "_"), "math", "subBreak"],
  ["Ctrl+Shift+*", shift("Digit8", "*"), "math", "mulBreak"],
  ["Ctrl+Shift+/", shift("Slash", "?"), "math", "inlineDivBreak"],
];

const IT: Array<[string, KeyInput, KeyContext, string]> = [
  ["Ctrl+-", ctrl("Slash", "-"), "math", "literalSubscript"],
  ["Ctrl+Shift+ò", shift("Semicolon", "ç"), "math", "globalDefine"],
  ["Ctrl+ù", ctrl("Backslash", "ù"), "math", "inlineDiv"],
  ["Ctrl++", ctrl("BracketRight", "+"), "math", "boolEq"],
  ["Ctrl+Shift+7", shift("Digit7", "/"), "math", "and"],
  ["Ctrl+Shift+2", shift("Digit2", '"'), "math", "or"],
  ["Ctrl+Shift+1", shift("Digit1", "!"), "math", "not"],
  ["Ctrl+Shift+5", shift("Digit5", "%"), "math", "xor"],
  ["Ctrl+à", ctrl("Quote", "à"), "math", "primeDeriv"],
  ["Ctrl+Shift+4", shift("Digit4", "$"), "math", "sum"],
  ["Ctrl+Shift+3", shift("Digit3", "£"), "math", "prod"],
  ["Ctrl+Shift+9", shift("Digit9", ")"), "math", "conj"],
  ["Ctrl+Shift+\\", shift("Backquote", "|"), "math", "norm"],
  ["Ctrl+Shift+6", shift("Digit6", "&"), "math", "vectorize"],
  ["Ctrl+è", ctrl("BracketLeft", "è"), "program", "elseIf"],
  ["Ctrl+Shift+0", shift("Digit0", "="), "program", "alsoIf"],
  ["Ctrl+ì", ctrl("Equal", "ì"), "math", "while"],
  ["Ctrl+Shift+à", shift("Quote", "°"), "math", "for"],
  ["Ctrl+Shift+'", shift("Minus", "?"), "program", "break"],
  ["Ctrl+Shift+è", shift("BracketLeft", "é"), "program", "continue"],
  ["Ctrl+\\", ctrl("Backquote", "\\"), "program", "return"],
  ["Ctrl+'", ctrl("Minus", "'"), "math", "try"],
  ["Ctrl+Shift++", shift("BracketRight", "*"), "math", "addBreak"],
  ["Ctrl+Shift+-", shift("Slash", "_"), "math", "subBreak"],
  ["Ctrl+Shift+8", shift("Digit8", "("), "math", "mulBreak"],
  ["Ctrl+Shift+ù", shift("Backslash", "§"), "math", "inlineDivBreak"],
];

/** Characters and named keys (same meaning on both layouts, produced differently). */
const CHARS: Array<[string, KeyContext, string]> = [
  [":", "math", "define"],
  ["=", "math", "evaluate"],
  ["+", "math", "add"],
  ["-", "math", "sub"],
  ["*", "math", "mul"],
  ["/", "math", "frac"],
  ["^", "math", "pow"],
  ["!", "math", "factorial"],
  ["<", "math", "less"],
  [">", "math", "greater"],
  ["|", "math", "abs"],
  ["\\", "math", "sqrt"],
  ["[", "math", "bracket"],
  ["]", "math", "programLine"],
  ["{", "program", "localAssign"],
  ["}", "program", "if"],
  ["(", "math", "openParen"],
  [")", "math", "closeParen"],
  [",", "math", "comma"],
  ['"', "math", "string"],
];

const NAMED: Array<[string, KeyInput, KeyContext, string]> = [
  ["Space", named(" "), "math", "grow"],
  ["Ctrl+Shift+Space", named(" ", { ctrlKey: true, shiftKey: true }), "math", "insertSearch"],
  ["Ctrl+Shift+A", { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true }, "math", "sum"],
  ["Ctrl+Shift+A on AZERTY", { key: "A", code: "KeyQ", ctrlKey: true, shiftKey: true }, "math", "sum"],
  ["Ctrl+Shift+A physical fallback", { key: "Ф", code: "KeyA", ctrlKey: true, shiftKey: true }, "math", "sum"],
  ["Shift+Space", named(" ", { shiftKey: true }), "matrix", "addColumn"],
  ["Enter", named("Enter"), "math", "exitRegion"],
  ["Enter (program)", named("Enter"), "program", "newProgramLine"],
  ["Shift+Enter", named("Enter", { shiftKey: true }), "matrix", "addRow"],
  ["Ctrl+Shift+Enter", named("Enter", { ctrlKey: true, shiftKey: true }), "math", "toggleBreak"],
  ["Tab", named("Tab"), "math", "nextPlaceholder"],
  ["Shift+Tab", named("Tab", { shiftKey: true }), "math", "prevPlaceholder"],
  ["Tab (matrix)", named("Tab"), "matrix", "nextCell"],
  ["Shift+Tab (matrix)", named("Tab", { shiftKey: true }), "matrix", "prevCell"],
  ["Home", named("Home"), "math", "home"],
  ["End", named("End"), "math", "end"],
  ["←", named("ArrowLeft"), "math", "left"],
  ["→", named("ArrowRight"), "math", "right"],
  ["Shift+←", named("ArrowLeft", { shiftKey: true }), "math", "growLeft"],
  ["Shift+→", named("ArrowRight", { shiftKey: true }), "math", "growRight"],
  ["Insert", named("Insert"), "math", "flipSide"],
  ["Ctrl+←", named("ArrowLeft", { ctrlKey: true }), "math", "wordLeft"],
  ["Ctrl+→", named("ArrowRight", { ctrlKey: true }), "math", "wordRight"],
  ["Ctrl+← (matrix)", named("ArrowLeft", { ctrlKey: true }), "matrix", "prevCell"],
  ["Ctrl+→ (matrix)", named("ArrowRight", { ctrlKey: true }), "matrix", "nextCell"],
  ["Ctrl+F7", named("F7", { ctrlKey: true }), "math", "element"],
  ["F5", named("F5"), "math", "calculate"],
  ["F1", named("F1"), "math", "functionHelp"],
  ["F2", named("F2"), "sheet", "functionCatalogue"],
  ["Ctrl+F5", named("F5", { ctrlKey: true }), "sheet", "calculateAll"],
  ["Enter (sheet)", named("Enter"), "sheet", "insertLine"],
  ["Delete (sheet)", named("Delete"), "sheet", "deleteRegions"],
];

function cases(layout: LayoutId): Case[] {
  const list = [...SAME, ...(layout === "en-US" ? US : IT), ...NAMED].map(([label, ev, ctx, cmd]) => ({ label, ev, ctx, cmd }));
  for (const [ch, ctx, cmd] of CHARS) list.push({ label: ch, ev: charKey(ch, layout), ctx, cmd });
  return list;
}

describe.each(["en-US", "it-IT"] as const)("keymap %s", (layout) => {
  it.each(cases(layout).map((c) => [c.label, c] as const))("%s", (_label, c) => {
    expect(resolve(c.ev, LAYOUTS[layout], c.ctx)).toEqual({ kind: "command", cmd: c.cmd });
  });

  it("every chord of the JSON table is covered by the transcription above", () => {
    const covered = new Set(cases(layout).map((c) => `${c.ctx}:${c.cmd}`));
    for (const b of LAYOUTS[layout].ctrl) {
      expect(covered.has(`${b.ctx}:${b.cmd}`) || covered.has(`math:${b.cmd}`) || covered.has(`program:${b.cmd}`) || covered.has(`sheet:${b.cmd}`), `${b.pdf} ${b.cmd}`).toBe(true);
    }
  });

  it("plain letters and digits are characters; on the sheet they start a region", () => {
    expect(resolve(charKey("a", layout), LAYOUTS[layout], "math")).toEqual({ kind: "char", ch: "a" });
    expect(resolve(charKey("7", layout), LAYOUTS[layout], "sheet")).toEqual({ kind: "char", ch: "7" });
    expect(resolve(named(" "), LAYOUTS[layout], "sheet")).toBeNull();
  });

  it("a string literal takes operators and Space as text", () => {
    expect(resolve(charKey("+", layout), LAYOUTS[layout], "string")).toEqual({ kind: "char", ch: "+" });
    expect(resolve(named(" "), LAYOUTS[layout], "string")).toEqual({ kind: "char", ch: " " });
    expect(resolve(charKey('"', layout), LAYOUTS[layout], "string")).toEqual({ kind: "command", cmd: "endString" });
  });
});

describe("AltGr and layout detection", () => {
  it("AltGr characters on Italian never reach the Ctrl table", () => {
    const it_ = LAYOUTS["it-IT"];
    expect(resolve({ key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }, it_, "math")).toEqual({ kind: "command", cmd: "bracket" });
    expect(resolve({ key: "{", code: "BracketLeft", ctrlKey: true, altKey: true, shiftKey: true }, it_, "program")).toEqual({ kind: "command", cmd: "localAssign" });
    expect(resolve({ key: "}", code: "BracketRight", ctrlKey: true, altKey: true, shiftKey: true }, it_, "program")).toEqual({ kind: "command", cmd: "if" });
    expect(resolve({ key: "@", code: "Semicolon", ctrlKey: true, altKey: true }, it_, "math")).toEqual({ kind: "char", ch: "@" });
  });

  it("detects the layout from a keyboard map and from key events", () => {
    expect(layoutFromMap(new Map([["BracketLeft", "è"]]))).toBe("it-IT");
    expect(layoutFromMap(new Map([["BracketLeft", "["]]))).toBe("en-US");
    expect(layoutFromMap(new Map())).toBeNull();
    expect(layoutFromEvent({ key: "è", code: "BracketLeft" })).toBe("it-IT");
    expect(layoutFromEvent({ key: "[", code: "BracketLeft" })).toBe("en-US");
    expect(layoutFromEvent({ key: "a", code: "KeyA" })).toBeNull();
  });
});

describe("shortcutLabel", () => {
  it("prefers the printed chord, then the typed character, then a named key", () => {
    expect(shortcutLabel("en-US", "greek")).toBe("Ctrl+G");
    expect(shortcutLabel("it-IT", "globalDefine")).toBe("Ctrl+Shift+ò");
    expect(shortcutLabel("en-US", "define")).toBe(":");
    expect(shortcutLabel("en-US", "calculate")).toBe("F5");
    expect(shortcutLabel("en-US", "toggleBreak")).toBe("Ctrl+Shift+Enter");
    expect(shortcutLabel("it-IT", "insertSearch")).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("en-US", "functionCatalogue")).toBe("F2");
    expect(shortcutLabel("en-US", "noSuchCommand")).toBeNull();
  });
});

describe("Ctrl+Alt on Windows, where it is also reported as AltGr", () => {
  it.each(["en-US", "it-IT"] as const)("honors an explicit Ctrl+Alt chord on %s", (layout) => {
    const windows = named(" ", { ctrlKey: true, altKey: true, altGraph: true });
    const table = {
      ...LAYOUTS[layout],
      keys: [...LAYOUTS[layout].keys, { key: " ", ctrl: true, alt: true, ctx: "math" as const, cmd: "example" }],
    };
    expect(resolve(windows, table, "math")).toEqual({ kind: "command", cmd: "example" });
  });

  it("leaves a real AltGr key (no Ctrl) and AltGr characters to typing", () => {
    expect(resolve(named(" ", { altGraph: true }), LAYOUTS["it-IT"], "math")).toEqual({ kind: "char", ch: " " });
    for (const ch of ["@", "[", "#"]) {
      const altGr = { key: ch, code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true };
      expect(resolve(altGr, LAYOUTS["it-IT"], "math")).toEqual(resolve({ key: ch, code: "KeyQ" }, LAYOUTS["it-IT"], "math"));
    }
  });

  it("does not open the search on the old Ctrl+Alt+Space", () => {
    expect(resolve(named(" ", { ctrlKey: true, altKey: true }), LAYOUTS["en-US"], "math")).toBeNull();
  });
});

describe("Ctrl chords resolve the layout from the produced character", () => {
  const ctrl = (key: string, code: string, shiftKey = false): KeyInput => ({ key, code, ctrlKey: true, shiftKey });

  it("Ctrl+- is the literal subscript on both layouts, whatever layout was detected", () => {
    for (const detected of ["en-US", "it-IT"] as const) {
      // US keyboard: '-' is on Minus. Italian keyboard: '-' is on Slash.
      expect(resolve(ctrl("-", "Minus"), LAYOUTS[detected], "math")).toEqual({ kind: "command", cmd: "literalSubscript" });
      expect(resolve(ctrl("-", "Slash"), LAYOUTS[detected], "math")).toEqual({ kind: "command", cmd: "literalSubscript" });
    }
  });

  it("Ctrl+/ on US and Ctrl+ù on IT are the inline division, whatever layout was detected", () => {
    for (const detected of ["en-US", "it-IT"] as const) {
      expect(resolve(ctrl("/", "Slash"), LAYOUTS[detected], "math")).toEqual({ kind: "command", cmd: "inlineDiv" });
      expect(resolve(ctrl("ù", "Backslash"), LAYOUTS[detected], "math")).toEqual({ kind: "command", cmd: "inlineDiv" });
    }
  });

  it("Ctrl+-, Ctrl++ and Ctrl+= have no sheet binding (they start a math region), Ctrl+0 still resets the zoom", () => {
    for (const layout of ["en-US", "it-IT"] as const) {
      for (const ev of [ctrl("-", "Minus"), ctrl("-", "Slash"), ctrl("=", "Equal"), ctrl("+", "BracketRight")]) {
        expect(resolve(ev, LAYOUTS[layout], "sheet"), `${layout} ${ev.key}/${ev.code}`).toBeNull();
      }
      expect(resolve(ctrl("0", "Digit0"), LAYOUTS[layout], "sheet")).toEqual({ kind: "command", cmd: "zoomReset" });
    }
    // What they do in the math context (so on the empty crosshair): literal subscript and Boolean equality.
    expect(resolve(ctrl("=", "Equal"), LAYOUTS["en-US"], "math")).toEqual({ kind: "command", cmd: "boolEq" });
    expect(resolve(ctrl("+", "BracketRight"), LAYOUTS["it-IT"], "math")).toEqual({ kind: "command", cmd: "boolEq" });
  });

  it("every punctuation chord of the two tables resolves the same on either detected layout", () => {
    // Each chord of a layout, typed with the key that layout produces (the PDF label's character), must
    // resolve to that layout's command whichever table was detected.
    const chords: [LayoutId, KeyInput, KeyContext, string][] = [
      ["it-IT", ctrl("+", "BracketRight"), "math", "boolEq"],
      ["en-US", ctrl("]", "BracketRight"), "math", "while"],
      ["it-IT", ctrl("ì", "Equal"), "math", "while"],
      ["en-US", ctrl("=", "Equal"), "math", "boolEq"],
      ["it-IT", ctrl("è", "BracketLeft"), "math", "elseIf"],
      ["en-US", ctrl("[", "BracketLeft"), "math", "try"],
      ["it-IT", ctrl("'", "Minus"), "math", "try"],
      ["en-US", ctrl(";", "Semicolon"), "math", "elseIf"],
      ["it-IT", ctrl("ù", "Backslash"), "math", "inlineDiv"],
      ["en-US", ctrl("\\", "Backslash"), "math", "return"],
      ["it-IT", ctrl("\\", "Backquote"), "math", "return"],
      ["it-IT", ctrl("?", "Minus", true), "program", "break"],
      ["en-US", ctrl("{", "BracketLeft", true), "program", "break"],
      ["it-IT", ctrl("é", "BracketLeft", true), "program", "continue"],
      ["en-US", ctrl(":", "Semicolon", true), "program", "continue"],
      ["it-IT", ctrl("ç", "Semicolon", true), "math", "globalDefine"],
      ["it-IT", ctrl("°", "Quote", true), "program", "for"],
      ["en-US", ctrl('"', "Quote", true), "program", "for"],
    ];
    for (const [real, ev, ctx, cmd] of chords) {
      for (const detected of ["en-US", "it-IT"] as const) {
        expect(resolve(ev, LAYOUTS[detected], ctx), `${real} ${ev.key}/${ev.code} detected ${detected}`).toEqual({ kind: "command", cmd });
      }
    }
  });

  it("Ctrl++ on an Italian keyboard is Boolean equality even when the layout was detected as US", () => {
    expect(resolve(ctrl("+", "BracketRight"), LAYOUTS["en-US"], "math")).toEqual({ kind: "command", cmd: "boolEq" });
  });

  it("key events prove the layout even when the Keyboard Map said US", () => {
    // The map says US, the keys say Italian: the events win.
    expect(layoutFromMap(new Map([["BracketLeft", "["]]))).toBe("en-US");
    expect(layoutFromEvent({ key: "-", code: "Slash" })).toBe("it-IT");
    expect(layoutFromEvent({ key: "'", code: "Minus" })).toBe("it-IT");
    expect(layoutFromEvent({ key: "è", code: "BracketLeft" })).toBe("it-IT");
    expect(layoutFromEvent({ key: "ò", code: "Semicolon" })).toBe("it-IT");
    expect(layoutFromEvent({ key: "-", code: "Minus" })).toBe("en-US");
    expect(layoutFromEvent({ key: "/", code: "Slash" })).toBe("en-US");
    expect(layoutFromEvent(ctrl("-", "Slash"))).toBe("it-IT");
    expect(layoutFromEvent({ key: "_", code: "Slash", shiftKey: true })).toBe("it-IT");
    expect(layoutFromEvent({ key: "_", code: "Minus", shiftKey: true })).toBe("en-US");
    expect(layoutFromChord({ key: "a", code: "KeyA" })).toBeNull();
  });
});
