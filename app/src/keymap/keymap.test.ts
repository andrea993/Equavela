// Every shortcut the editor covers, transcribed here independently of the JSON table and fed as the
// key events of the US and the Italian layout: a Ctrl shortcut is the US character, typed with the
// keys each layout uses for it (AltGr included).

import { describe, expect, it } from "vitest";
import { KEYMAP, resolve, shortcutLabel, type KeyContext, type KeyInput } from "./keymap";
import { charKey, ctrl, named, type LayoutId } from "./testKeys";

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

/** On Windows with the native Ctrl state: AltGr arrives as Ctrl+Alt, and the real Ctrl is down. */
const altGr = (code: string, key: string, shiftKey = false): KeyInput => ({
  key, code, ctrlKey: true, altKey: true, shiftKey, altGraph: true, realCtrl: true,
});

/** The Italian keys of each US character. */
const IT: Array<[string, KeyInput, KeyContext, string]> = [
  ["Ctrl+- (Ctrl+-)", ctrl("Slash", "-"), "math", "literalSubscript"],
  ["Ctrl+/ (Ctrl+Shift+7)", shift("Digit7", "/"), "math", "inlineDiv"],
  ["Ctrl+= (Ctrl+Shift+0)", shift("Digit0", "="), "math", "boolEq"],
  ["Ctrl+Shift+& (Ctrl+Shift+6)", shift("Digit6", "&"), "math", "and"],
  ["Ctrl+Shift+@ (Ctrl+AltGr+ò)", altGr("Semicolon", "@"), "math", "or"],
  ["Ctrl+Shift+! (Ctrl+Shift+1)", shift("Digit1", "!"), "math", "not"],
  ["Ctrl+Shift+% (Ctrl+Shift+5)", shift("Digit5", "%"), "math", "xor"],
  ["Ctrl+' (Ctrl+')", ctrl("Minus", "'"), "math", "primeDeriv"],
  ["Ctrl+Shift+$ (Ctrl+Shift+4)", shift("Digit4", "$"), "math", "sum"],
  ["Ctrl+Shift+# (Ctrl+AltGr+à)", altGr("Quote", "#"), "math", "prod"],
  ["Ctrl+Shift+( (Ctrl+Shift+8)", shift("Digit8", "("), "math", "conj"],
  ["Ctrl+Shift+| (Ctrl+Shift+\\)", shift("Backquote", "|"), "math", "norm"],
  ["Ctrl+Shift+^ (Ctrl+Shift+ì)", shift("Equal", "^"), "math", "vectorize"],
  ["Ctrl+Shift+} (Ctrl+AltGr+Shift++)", altGr("BracketRight", "}", true), "program", "else"],
  ["Ctrl+; (Ctrl+Shift+,)", shift("Comma", ";"), "program", "elseIf"],
  ["Ctrl+Shift+) (Ctrl+Shift+9)", shift("Digit9", ")"), "program", "alsoIf"],
  ["Ctrl+] (Ctrl+AltGr++)", altGr("BracketRight", "]"), "math", "while"],
  ['Ctrl+Shift+" (Ctrl+Shift+2)', shift("Digit2", '"'), "math", "for"],
  ["Ctrl+Shift+{ (Ctrl+AltGr+Shift+è)", altGr("BracketLeft", "{", true), "program", "break"],
  ["Ctrl+Shift+: (Ctrl+Shift+.)", shift("Period", ":"), "program", "continue"],
  ["Ctrl+\\ (Ctrl+\\)", ctrl("Backquote", "\\"), "program", "return"],
  ["Ctrl+[ (Ctrl+AltGr+è)", altGr("BracketLeft", "["), "math", "try"],
  ["Ctrl+Shift++ (Ctrl++)", ctrl("BracketRight", "+"), "math", "addBreak"],
  ["Ctrl+Shift+- (Ctrl+Shift+-)", shift("Slash", "_"), "math", "subBreak"],
  ["Ctrl+Shift+* (Ctrl+Shift++)", shift("BracketRight", "*"), "math", "mulBreak"],
  ["Ctrl+Shift+/ (Ctrl+Shift+')", shift("Minus", "?"), "math", "inlineDivBreak"],
  // `~` only on Linux, where AltGr is a key of its own and `ctrlKey` the real Ctrl.
  ["Ctrl+Shift+~ (Ctrl+AltGr+ì, Linux)", { key: "~", code: "Equal", ctrlKey: true, altGraph: true }, "math", "globalDefine"],
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
    expect(resolve(c.ev, c.ctx)).toEqual({ kind: "command", cmd: c.cmd });
  });

  it("every chord of the JSON table is covered by the transcription above", () => {
    const covered = new Set(cases(layout).map((c) => `${c.ctx}:${c.cmd}`));
    for (const b of KEYMAP.ctrl) {
      expect(covered.has(`${b.ctx}:${b.cmd}`) || covered.has(`math:${b.cmd}`) || covered.has(`program:${b.cmd}`) || covered.has(`sheet:${b.cmd}`), `${b.label} ${b.cmd}`).toBe(true);
    }
  });

  it("plain letters and digits are characters; on the sheet they start a region", () => {
    expect(resolve(charKey("a", layout), "math")).toEqual({ kind: "char", ch: "a" });
    expect(resolve(charKey("7", layout), "sheet")).toEqual({ kind: "char", ch: "7" });
    expect(resolve(named(" "), "sheet")).toBeNull();
  });

  it("a string literal takes operators and Space as text", () => {
    expect(resolve(charKey("+", layout), "string")).toEqual({ kind: "char", ch: "+" });
    expect(resolve(named(" "), "string")).toEqual({ kind: "char", ch: " " });
    expect(resolve(charKey('"', layout), "string")).toEqual({ kind: "command", cmd: "endString" });
  });
});

describe("AltGr", () => {
  it("types its character when the real Ctrl is not down", () => {
    // Windows without the native state, Windows with it saying no Ctrl, and Linux.
    for (const ev of [
      { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true },
      { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true, altGraph: true, realCtrl: false },
      { key: "[", code: "BracketLeft", altGraph: true },
    ]) {
      expect(resolve(ev, "math")).toEqual({ kind: "command", cmd: "bracket" });
    }
    expect(resolve({ key: "{", code: "BracketLeft", ctrlKey: true, altKey: true, shiftKey: true }, "program")).toEqual({ kind: "command", cmd: "localAssign" });
    expect(resolve({ key: "@", code: "Semicolon", ctrlKey: true, altKey: true }, "math")).toEqual({ kind: "char", ch: "@" });
  });

  it("is a Ctrl shortcut of its character with the real Ctrl down", () => {
    // Windows: the native hook says the real Ctrl is down. Linux: `ctrlKey` with AltGr, no Alt.
    expect(resolve({ key: "[", code: "BracketLeft", ctrlKey: true, altKey: true, altGraph: true, realCtrl: true }, "math")).toEqual({ kind: "command", cmd: "try" });
    expect(resolve({ key: "[", code: "BracketLeft", ctrlKey: true, altGraph: true }, "math")).toEqual({ kind: "command", cmd: "try" });
  });
});

describe("shortcutLabel", () => {
  it("prefers the printed chord, then the typed character, then a named key", () => {
    expect(shortcutLabel("greek")).toBe("Ctrl+G");
    expect(shortcutLabel("globalDefine")).toBe("Ctrl+Shift+~");
    expect(shortcutLabel("define")).toBe(":");
    expect(shortcutLabel("calculate")).toBe("F5");
    expect(shortcutLabel("toggleBreak")).toBe("Ctrl+Shift+Enter");
    expect(shortcutLabel("insertSearch")).toBe("Ctrl+Shift+Space");
    expect(shortcutLabel("functionCatalogue")).toBe("F2");
    expect(shortcutLabel("noSuchCommand")).toBeNull();
  });
});

describe("Ctrl+Alt on Windows, where it is also reported as AltGr", () => {
  it("leaves a real AltGr key (no Ctrl) and AltGr characters to typing", () => {
    expect(resolve(named(" ", { altGraph: true }), "math")).toEqual({ kind: "char", ch: " " });
    for (const ch of ["@", "[", "#"]) {
      const altGr = { key: ch, code: "KeyQ", ctrlKey: true, altKey: true, altGraph: true };
      expect(resolve(altGr, "math")).toEqual(resolve({ key: ch, code: "KeyQ" }, "math"));
    }
  });

  it("does not open the search on the old Ctrl+Alt+Space", () => {
    expect(resolve(named(" ", { ctrlKey: true, altKey: true }), "math")).toBeNull();
  });
});

describe("Ctrl chords are matched on the typed character", () => {
  const ctrl = (key: string, code: string, shiftKey = false): KeyInput => ({ key, code, ctrlKey: true, shiftKey });

  it("Ctrl+- is the literal subscript wherever the layout has its '-'", () => {
    expect(resolve(ctrl("-", "Minus"), "math")).toEqual({ kind: "command", cmd: "literalSubscript" });
    expect(resolve(ctrl("-", "Slash"), "math")).toEqual({ kind: "command", cmd: "literalSubscript" });
  });

  it("Ctrl+-, Ctrl++ and Ctrl+= have no sheet binding (they start a math region), Ctrl+0 still resets the zoom", () => {
    for (const ev of [ctrl("-", "Minus"), ctrl("-", "Slash"), ctrl("=", "Equal"), ctrl("+", "BracketRight")]) {
      expect(resolve(ev, "sheet"), `${ev.key}/${ev.code}`).toBeNull();
    }
    expect(resolve(ctrl("0", "Digit0"), "sheet")).toEqual({ kind: "command", cmd: "zoomReset" });
  });

  it("a character no shortcut uses does nothing", () => {
    for (const key of ["è", "ò", "à", "ù", "ì", "£", "§", "°", "ç", "é"]) {
      expect(resolve(ctrl(key, "KeyQ"), "math"), key).toBeNull();
    }
  });
});

describe("letter chords beside the chords Windows takes as Ctrl+Shift+0", () => {
  const cases: Array<[string, KeyInput, string]> = [
    ["Ctrl+Shift+E", shift("KeyE", "E"), "boolEq"],
    ["Ctrl+Shift+F", shift("KeyF", "F"), "alsoIf"],
    ["Ctrl+Shift+G", shift("KeyG", "G"), "greaterEq"],
    // A Cyrillic layout types another letter on the same key.
    ["Ctrl+Shift+E (Cyrillic)", shift("KeyE", "У"), "boolEq"],
    ["Ctrl+Shift+F (Cyrillic)", shift("KeyF", "А"), "alsoIf"],
    ["Ctrl+Shift+G (Cyrillic)", shift("KeyG", "П"), "greaterEq"],
  ];
  for (const [label, ev, cmd] of cases) {
    it(`${label} is ${cmd} in math, in a matrix and in a program`, () => {
      for (const ctx of ["math", "matrix", "program"] as KeyContext[]) {
        expect(resolve(ev, ctx), ctx).toEqual({ kind: "command", cmd });
      }
    });
  }

  it("keeps the first chords of the three commands", () => {
    expect(resolve(ctrl("Equal", "="), "math")).toEqual({ kind: "command", cmd: "boolEq" });
    expect(resolve(shift("Digit0", "="), "math")).toEqual({ kind: "command", cmd: "boolEq" });
    expect(resolve(shift("Digit0", ")"), "math")).toEqual({ kind: "command", cmd: "alsoIf" });
    expect(resolve(shift("Digit9", ")"), "math")).toEqual({ kind: "command", cmd: "alsoIf" });
    expect(resolve(ctrl("Digit0", "0"), "math")).toEqual({ kind: "command", cmd: "greaterEq" });
  });

  it("leaves Ctrl+E, Ctrl+F and Ctrl+G without Shift as they were", () => {
    expect(resolve(ctrl("KeyE", "e"), "math")).toBeNull();
    expect(resolve(ctrl("KeyF", "f"), "math")).toBeNull();
    expect(resolve(ctrl("KeyG", "g"), "math")).toEqual({ kind: "command", cmd: "greek" });
  });

  it("does nothing with the letter chords outside math", () => {
    for (const ev of [shift("KeyE", "E"), shift("KeyF", "F"), shift("KeyG", "G")]) {
      expect(resolve(ev, "sheet"), ev.key).toBeNull();
      expect(resolve(ev, "text"), ev.key).toBeNull();
    }
  });

  it("shows every chord of a command, the first one first", () => {
    expect(shortcutLabel("boolEq")).toBe("Ctrl+= or Ctrl+Shift+E");
    expect(shortcutLabel("alsoIf")).toBe("Ctrl+Shift+) or Ctrl+Shift+F");
    expect(shortcutLabel("greaterEq")).toBe("Ctrl+0 or Ctrl+Shift+G");
    expect(shortcutLabel("sum")).toBe("Ctrl+Shift+A or Ctrl+Shift+$");
    expect(shortcutLabel("lessEq")).toBe("Ctrl+9");
  });
});
