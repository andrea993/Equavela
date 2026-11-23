// Behaviour tests of the structural editor: every sequence runs on the US and on the
// Italian layout with the key events each layout produces.

import { describe, expect, it } from "vitest";
import { type KeyInput } from "../keymap/keymap";
import { charKey, ctrl, named, typed, type LayoutId } from "../keymap/testKeys";
import { handleKey } from "./controller";
import { breakWires, focusAt, initialState, insertMatrixSized, loneNameText, insertSymbolicKeyword, placeCaret, runCommand, selectedNode, selectRange, typeCharacter, typeText, type EditorState } from "./model";
import { sameCursor } from "../text/InlineMath";
import { childRefs, get, ident, isEmptyStatement, leafPaths, withDrawnParens, drawnParenPath, remapIntegralBoundHit, set, sexpr, type Node, toEditing, toWire, withIntegralBoundSlots, WireError } from "./tree";

type Chords = Record<string, KeyInput>;

/** The Ctrl chords used below: the US characters, typed with the keys of each layout. */
const CHORDS: Record<LayoutId, Chords> = {
  "en-US": {
    greek: ctrl("KeyG", "g"),
    unit: ctrl("KeyU", "u"),
    sub: ctrl("Minus", "-"),
    symbolic: ctrl("Period", "."),
    boolEq: ctrl("Equal", "="),
    while: ctrl("BracketRight", "]"),
    for: ctrl("Quote", '"', true),
    try: ctrl("BracketLeft", "["),
    elseIf: ctrl("Semicolon", ";"),
    else: ctrl("BracketRight", "}", true),
    break: ctrl("BracketLeft", "{", true),
    return: ctrl("Backslash", "\\"),
    global: ctrl("Backquote", "~", true),
    inlineDiv: ctrl("Slash", "/"),
    sum: ctrl("Digit4", "$", true),
    deriv: ctrl("KeyD", "D", true),
    transpose: ctrl("KeyT", "T", true),
    undo: ctrl("KeyZ", "z"),
    redo: ctrl("KeyY", "y"),
    wordOp: ctrl("KeyJ", "j"),
    addBreak: ctrl("Equal", "+", true),
  },
  // The US characters, typed with the Italian keys (AltGr with the real Ctrl down, as on Windows).
  "it-IT": {
    greek: ctrl("KeyG", "g"),
    unit: ctrl("KeyU", "u"),
    sub: ctrl("Slash", "-"),
    symbolic: ctrl("Period", "."),
    boolEq: ctrl("Digit0", "=", true),
    while: { key: "]", code: "BracketRight", ctrlKey: true, altKey: true, altGraph: true, realCtrl: true },
    for: ctrl("Digit2", '"', true),
    try: { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true, altGraph: true, realCtrl: true },
    elseIf: ctrl("Comma", ";", true),
    else: { key: "}", code: "BracketRight", ctrlKey: true, altKey: true, shiftKey: true, altGraph: true, realCtrl: true },
    break: { key: "{", code: "BracketLeft", ctrlKey: true, altKey: true, shiftKey: true, altGraph: true, realCtrl: true },
    return: ctrl("Backquote", "\\"),
    // No `~` on the Windows Italian layout: Linux types it with AltGr, `ctrlKey` the real Ctrl.
    global: { key: "~", code: "Equal", ctrlKey: true, altGraph: true },
    inlineDiv: ctrl("Digit7", "/", true),
    sum: ctrl("Digit4", "$", true),
    deriv: ctrl("KeyD", "D", true),
    transpose: ctrl("KeyT", "T", true),
    undo: ctrl("KeyZ", "z"),
    redo: ctrl("KeyY", "y"),
    wordOp: ctrl("KeyJ", "j"),
    addBreak: ctrl("BracketRight", "+"),
  },
};

const SPACE = named(" ");
const ENTER = named("Enter");

/** Model invariant: no statement and no program line is a bare Placeholder (the renderer prints it as text otherwise). */
function assertNoBareStatements(root: Node, where = "root"): void {
  expect(root.type, `${where} is a bare Placeholder`).not.toBe("Placeholder");
  const walk = (value: unknown, key: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (["body", "else", "handler"].includes(key) && item?.type === "Placeholder") {
          throw new Error(`line ${i} of \`${key}\` is a bare Placeholder`);
        }
        walk(item, key);
      });
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(root, "");
}

/** `_layout` names the keyboard the keys were typed on; the keymap needs no layout. */
function run(_layout: LayoutId, keys: (KeyInput | KeyInput[])[], start: EditorState = initialState()): EditorState {
  let s = start;
  for (const k of keys.flat()) {
    s = handleKey(s, k).state;
    assertNoBareStatements(s.root);
  }
  return s;
}

const ast = (s: EditorState) => sexpr(s.root);
const selected = (s: EditorState) => sexpr(get(s.root, s.focus));

describe.each(["en-US", "it-IT"] as const)("editor on %s", (layout) => {
  const t = (text: string) => typed(text, layout);
  const c = CHORDS[layout];

  it("inserts an assignment target before an expression at its left edge", () => {
    const expression = run(layout, [t("a+b")]);
    const left = runCommand(expression, "home");
    const result = run(layout, [t(":")], left);
    expect(ast(result)).toBe("(:= □ (+ a b))");
    expect(ast(run(layout, [t("x")], result))).toBe("(:= x (+ a b))");
  });

  it("inserts a definition target before a complete selection whose insertion line is on the left", () => {
    // Home puts the line before the callee; Space selects the complete call without moving it.
    const selectedCall = run(layout, [t("f(x)"), named("Home"), SPACE]);
    expect(selected(selectedCall)).toBe("(call f x)");
    expect(selectedCall).toMatchObject({ focus: [0], side: "L", explicit: true });
    expect(ast(run(layout, [t(":")], selectedCall))).toBe("(:= □ (call f x))");

    // The edge is significant: a right-oriented selection remains the definition target.
    const right = run(layout, [t("f(x)"), SPACE]);
    expect(right).toMatchObject({ focus: [0], side: "R", explicit: true });
    expect(ast(run(layout, [t(":")], right))).toBe("(:= (call f x) □)");

    // Selecting only a nested call is not the left edge of the complete region expression.
    const partial = { ...run(layout, [t("f(x)+y")]), focus: [0, 0], side: "L" as const, caret: null, explicit: true };
    expect(ast(run(layout, [t(":")], partial))).toBe("(:= (+ (call f x) y) □)");
  });

  it("a digit before a name is a number in front of it, and an operator typed there replaces the implicit product", () => {
    const HOME = named("Home");
    const name = run(layout, [t("I")]);
    // A name cannot start with a digit: the digit is a factor, `3 I`, and more digits extend it.
    expect(ast(run(layout, [HOME, t("3")], name))).toBe("(juxt 3 I)");
    expect(ast(run(layout, [HOME, t("35")], name))).toBe("(juxt 35 I)");
    // An operator between the two factors takes the place of the implicit product.
    expect(ast(run(layout, [HOME, t("3*")], name))).toBe("(· 3 I)");
    expect(ast(run(layout, [HOME, t("2+")], name))).toBe("(+ 2 I)");
    expect(ast(run(layout, [HOME, t("2-")], name))).toBe("(- 2 I)");
    // Typed in order, `3x*` is still a product of `3 x` and a new operand.
    expect(ast(run(layout, [t("3x*")]))).toBe("(· (juxt 3 x) □)");
    // A letter before a name is still part of the name.
    expect(ast(run(layout, [HOME, t("x")], name))).toBe("xI");
  });

  it("inserts a definition target before an evaluation or a symbolic evaluation, keeping its tail", () => {
    const HOME = named("Home");
    // `vec(2..5) =`, caret before `v`, then `:` and `v`.
    const evaluation = run(layout, [t("vec(2..5)=")]);
    const defined = run(layout, [HOME, t(":")], evaluation);
    expect(ast(defined)).toBe("(:= □ (call vec (range 2 5)) (=))");
    expect(ast(run(layout, [t("v")], defined))).toBe("(:= v (call vec (range 2 5)) (=))");
    // The symbolic arrow keeps its keyword slot.
    const symbolic = run(layout, [t("x+x"), c.symbolic]);
    expect(ast(run(layout, [HOME, t(":")], symbolic))).toMatch(/^\(:= □ \(\+ x x\) \(→\)\)$/);
    // A global definition shows no result: `≡` before `e =` is not inserted.
    expect(ast(runCommand(run(layout, [HOME], evaluation), "globalDefine"))).toBe(ast(evaluation));
  });

  it("deletes an equals sign: plain names and numbers join, anything else becomes a product", () => {
    const BS = named("Backspace");
    const LEFT = named("ArrowLeft");
    // Backspace right after `:=`: the two names join and the caret stays at the joint.
    let s = run(layout, [t("a:b"), LEFT, BS]);
    expect(ast(s)).toBe("ab");
    expect(ast(run(layout, [t("c")], s))).toBe("acb");
    // Delete right before it does the same.
    s = run(layout, [t("a:b"), LEFT, LEFT, named("Delete")]);
    expect(ast(s)).toBe("ab");
    // A name and a number make a name, two numbers a number, a number and a name a product.
    expect(ast(run(layout, [t("x:3"), LEFT, BS]))).toBe("x3");
    expect(ast(run(layout, [t("2"), c.boolEq, t("3"), LEFT, BS]))).toBe("23");
    expect(ast(run(layout, [t("2"), c.boolEq, t("a"), LEFT, BS]))).toBe("(· 2 a)");
    // Only the touching leaves join: `x := a + b` gives `xa + b`.
    expect(ast(run(layout, [t("x:a+b"), LEFT, LEFT, LEFT, BS]))).toBe("(+ xa b)");
    // The evaluation of a definition stays.
    expect(ast(run(layout, [t("a:b"), LEFT, t("="), BS]))).toBe("(= ab)");
    // An empty side is the ordinary deletion: the definition goes, the target stays.
    expect(ast(run(layout, [t("a:"), BS]))).toBe("a");
  });

  it("deletes a local-assignment arrow in program lines, parentheses and call arguments", () => {
    const LOCAL = charKey("{", layout);
    const BS = named("Backspace");
    const DEL = named("Delete");
    const LEFT = named("ArrowLeft");

    // An empty value uses ordinary operator deletion and leaves a valid expression statement.
    expect(ast(run(layout, [t("a"), LOCAL, BS]))).toBe("(program a)");
    // With both sides filled, Backspace after or Delete before the arrow joins touching names.
    const joined = run(layout, [t("a"), LOCAL, t("b"), LEFT, BS]);
    expect(ast(joined)).toBe("(program ab)");
    expect(ast(run(layout, [t("c")], joined))).toBe("(program acb)");
    expect(ast(run(layout, [t("a"), LOCAL, t("b"), LEFT, LEFT, DEL]))).toBe("(program ab)");
    expect(ast(run(layout, [t("2"), LOCAL, t("a"), LEFT, BS]))).toBe("(program (· 2 a))");

    // The same operation removes an InlineDef without losing its parenthesis or argument slot.
    expect(ast(run(layout, [t("(a"), LOCAL, BS]))).toBe("(paren a)");
    expect(ast(run(layout, [t("(a"), LOCAL, t("b"), LEFT, BS]))).toBe("(paren ab)");
    expect(ast(run(layout, [t("(a"), LOCAL, t("b"), LEFT, LEFT, DEL]))).toBe("(paren ab)");
    expect(ast(run(layout, [t("f(a"), LOCAL, BS]))).toBe("(call f a)");
    const call = run(layout, [t("f(a"), LOCAL, t("b"), LEFT, BS]);
    expect(ast(call)).toBe("(call f ab)");
    expect(() => toWire(call.root)).not.toThrow();
    expect(ast(run(layout, [t("f(a"), LOCAL, t("b"), LEFT, LEFT, DEL]))).toBe("(call f ab)");

    // A missing target is the mirror image: Delete keeps the value side.
    const emptyTarget: Node = {
      type: "ExprRegion",
      expr: { type: "Paren", expr: { type: "InlineDef", target: { type: "Placeholder" }, value: ident("b") } },
    };
    expect(ast(run(layout, [DEL], focusAt(emptyTarget, [0, 0, 0], "R")))).toBe("(paren b)");
    const emptyProgramTarget: Node = {
      type: "ExprRegion",
      expr: { type: "Program", body: [{ type: "LocalDef", target: { type: "Placeholder" }, rhs: ident("b") }] },
    };
    expect(ast(run(layout, [DEL], focusAt(emptyProgramTarget, [0, 0, 0], "R")))).toBe("(program b)");
  });

  it("a scalar and a matrix become a product, and an equals sign typed there comes back", () => {
    const BS = named("Backspace");
    const root: Node = {
      type: "Define",
      target: ident("x"),
      rhs: { type: "Matrix", rows: 1, cols: 2, cells: [ident("p"), ident("q")] },
      tail: null,
    };
    let s = focusAt(root, [1], "L");
    s = run(layout, [BS], s);
    expect(ast(s)).toMatch(/^\(· x \(matrix/);
    // `:` where the product's operator is: the definition again.
    const defined = run(layout, [t(":")], s);
    expect(ast(defined)).toMatch(/^\(:= x \(matrix/);
    // Or the Boolean equality.
    expect(ast(run(layout, [c.boolEq], s))).toMatch(/^\(== x \(matrix/);
    // A product typed by the user takes an equals sign the same way: `a·b`, `:` after `a`.
    expect(ast(run(layout, [t("a*b"), named("ArrowLeft"), t(":")]))).toBe("(:= a b)");
  });

  it("Backspace or Delete on an empty element of a vector removes it", () => {
    const vector = (cells: Node[]): Node => ({ type: "ExprRegion", expr: { type: "Matrix", rows: cells.length, cols: 1, cells } });
    const root = vector([ident("a"), { type: "Placeholder" }, ident("c")]);
    let s = run(layout, [named("Backspace")], focusAt(root, [0, 1]));
    expect(ast(s)).toBe(sexpr(vector([ident("a"), ident("c")])));
    expect(selected(s)).toBe("a");
    s = run(layout, [named("Delete")], focusAt(root, [0, 1]));
    expect(ast(s)).toBe(sexpr(vector([ident("a"), ident("c")])));
    expect(selected(s)).toBe("c");
    // A row vector the same way; a full element is not removed.
    const row: Node = { type: "ExprRegion", expr: { type: "Matrix", rows: 1, cols: 2, cells: [{ type: "Placeholder" }, ident("b")] } };
    expect(ast(run(layout, [named("Delete")], focusAt(row, [0, 0])))).toBe(sexpr({ type: "ExprRegion", expr: { type: "Matrix", rows: 1, cols: 1, cells: [ident("b")] } }));
    expect(ast(run(layout, [named("Backspace")], focusAt(root, [0, 2], "L")))).toContain("c");
  });

  it("builds a definition with precedence climbing: x:3*a+b", () => {
    const s = run(layout, [t("x:3*a+b")]);
    expect(ast(s)).toBe("(:= x (+ (· 3 a) b))");
    expect(selected(s)).toBe("b");
    expect(s.caret).toEqual({ seg: 0, offset: 1 });
  });

  it("keeps a fraction typed while typing in its operand (the reference application: / takes the operand)", () => {
    expect(ast(run(layout, [t("a+b/c")]))).toBe("(+ a (/ b c))");
  });

  it("Right at the end of an exponent leaves it: x^2, Right, +1 is x^2+1, not x^(2+1)", () => {
    let s = run(layout, [t("x^23")]);
    expect(ast(s)).toBe("(^ x 23)");
    s = run(layout, [named("ArrowRight"), t("+1")], s);
    expect(ast(s)).toBe("(+ (^ x 23) 1)");
    // Without Right the sum stays in the exponent.
    expect(ast(run(layout, [t("x^23+1")]))).toBe("(^ x (+ 23 1))");
  });

  it("each Right leaves one level of nested exponents", () => {
    let s = run(layout, [t("x^y^2")]);
    expect(ast(s)).toBe("(^ x (^ y 2))");
    s = run(layout, [named("ArrowRight"), t("+1")], s);
    // One press: out of the inner exponent, still in the outer one.
    expect(ast(s)).toBe("(^ x (+ (^ y 2) 1))");
    s = run(layout, [t("x^y^2"), named("ArrowRight"), named("ArrowRight"), t("+1")]);
    expect(ast(s)).toBe("(+ (^ x (^ y 2)) 1)");
  });

  it("Right leaves an index subscript and the end of a sum inside an exponent", () => {
    const s = run(layout, [t("x^a+b"), named("ArrowRight"), t("+1")]);
    expect(ast(s)).toBe("(+ (^ x (+ a b)) 1)");
    // A base is not a slot: Right at the end of `x` in `x^2` moves into the exponent as before.
    const base = run(layout, [t("x^2"), named("ArrowLeft"), named("ArrowLeft"), named("ArrowRight")]);
    expect(selected(base)).toBe("2");
  });

  it("Left crosses the fraction bar from the denominator to the numerator", () => {
    const s = run(layout, [t("a/b")]);
    const beforeB = placeCaret(s, [0, 1], "L");
    const a = run(layout, [named("ArrowLeft")], beforeB);
    expect(a).toMatchObject({ focus: [0, 0], side: "R" });
    expect(run(layout, [named("ArrowRight")], a)).toMatchObject({ focus: [0, 1], side: "L" });
  });

  it("Left at the start of a numerator leaves to the left of the fraction, and never goes back in", () => {
    const def = run(layout, [t("A:a/b")]);
    const a = leafPaths(def.root).find((path) => sexpr(get(def.root, path)) === "a")!;
    let s = placeCaret(def, a, "L", { seg: 0, offset: 0 });
    s = run(layout, [named("ArrowLeft")], s);
    expect(selected(s)).toBe("(/ a b)");
    expect(s.side).toBe("L");
    expect(s.explicit).toBe(false);
    // the next Left is the ordinary move, to the name on the left
    s = run(layout, [named("ArrowLeft")], s);
    expect(selected(s)).toBe("A");
  });

  it("Right crosses the fraction bar and respects a fence inside the numerator", () => {
    const s = run(layout, [t("(a+b)/c")]);
    const b = placeCaret(s, [0, 0, 0, 1], "R");
    const fence = run(layout, [named("ArrowRight")], b);
    expect(fence).toMatchObject({ focus: [0, 0], side: "R" });
    const denominator = run(layout, [named("ArrowRight")], fence);
    expect(denominator).toMatchObject({ focus: [0, 1], side: "L" });
    expect(ast(run(layout, [t("+1")], denominator))).toBe("(/ (paren (+ a b)) (+ 1 c))");
    expect(ast(run(layout, [named("ArrowRight"), named("ArrowRight"), t("+1")], denominator))).toBe("(+ (/ (paren (+ a b)) c) 1)");
  });

  it("Right at the end of a denominator goes to the right of the whole fraction, the next Right goes on", () => {
    let s = run(layout, [t("a/b"), named("ArrowRight")]);
    expect(selected(s)).toBe("(/ a b)");
    expect(s.side).toBe("R");
    // typing continues the expression after the fraction, inside the region
    expect(ast(run(layout, [t("+1")], s))).toBe("(+ (/ a b) 1)");
    // the next Right is the ordinary move, not back into the denominator: here the fraction is
    // last, so the state does not change and the workbench leaves the region (arrow-exit rule)
    const again = run(layout, [named("ArrowRight")], s);
    expect(selected(again)).toBe("(/ a b)");
    expect(again.focus).toEqual(s.focus);
    // the end of a denominator that is a sum: the whole fraction too
    s = run(layout, [t("a/(b+c)"), named("ArrowRight"), named("ArrowRight")]);
    expect(selected(s)).toBe("(/ a (paren (+ b c)))");
    // not the last element of the denominator: it moves to the next one on the right
    const sum = run(layout, [t("a/b+c"), named("ArrowLeft"), named("ArrowLeft")]);
    expect(selected(sum)).toBe("b");
    expect(selected(run(layout, [named("ArrowRight")], sum))).toBe("c");
    // nested: one fraction per press
    s = run(layout, [t("a/"), t("b/c"), named("ArrowRight")]);
    expect(selected(s)).toBe("(/ b c)");
    s = run(layout, [named("ArrowRight")], s);
    expect(selected(s)).toBe("(/ a (/ b c))");
    // a fraction that is the last operand of an exponent: the fraction, then the exponent
    s = run(layout, [t("x^"), t("a/b"), named("ArrowRight"), named("ArrowRight"), t("+1")]);
    expect(ast(s)).toBe("(+ (^ x (/ a b)) 1)");
  });

  it("Right crosses from the nth-root index into the radicand", () => {
    const root = { type: "ExprRegion", expr: { type: "Root", index: ident("n"), radicand: ident("x") } };
    const atIndex = focusAt(root, [0, 0], "R");
    expect(run(layout, [named("ArrowRight")], atIndex)).toMatchObject({ focus: [0, 1], side: "L" });
    const afterRadicand = focusAt(root, [0, 1], "R");
    expect(ast(run(layout, [named("ArrowRight"), t("+1")], afterRadicand))).toBe("(+ (√ n x) 1)");
  });

  it("Insert moves the insertion line to the other side and keeps the selection", () => {
    let s = run(layout, [t("a+b"), SPACE]);
    expect(selected(s)).toBe("(+ a b)");
    expect(s.side).toBe("R");
    s = run(layout, [named("Insert")], s);
    expect(selected(s)).toBe("(+ a b)");
    expect(s.side).toBe("L");
    s = run(layout, [named("Insert")], s);
    expect(s.side).toBe("R");
    // On a text leaf the caret jumps to the start: the next character goes before the text.
    s = run(layout, [t("a+bc"), named("Insert"), t("x")]);
    expect(ast(s)).toBe("(+ a xbc)");
  });

  it("never climbs out of a box: the denominator keeps 2+c", () => {
    expect(ast(run(layout, [t("a/2+c")]))).toBe("(/ a (+ 2 c))");
    expect(ast(run(layout, [t("x^2+1")]))).toBe("(^ x (+ 2 1))");
  });

  it("The % key applies the percent; the per mille is a palette command", () => {
    expect(ast(run(layout, [t("3.4%")]))).toBe("(% 3.4)");
    expect(ast(run(layout, [t("x%+1")]))).toBe("(+ (% x) 1)");
    expect(ast(runCommand(typeText(initialState(), "x"), "permille"))).toBe("(‰ x)");
    // `‰` is an operator, never part of a name.
    expect(ast(typeText(initialState(), "a‰"))).toBe("a");
  });

  it("The gradient takes its variables, a comma adds the next one", () => {
    let s = runCommand(typeText(initialState(), "f"), "gradient");
    s = typeText(s, "x");
    s = runCommand(s, "comma");
    s = typeText(s, "y");
    expect(ast(s)).toBe("(∇ x y f)");
  });

  it("The real and imaginary part wrap the operand", () => {
    expect(ast(runCommand(typeText(initialState(), "z"), "realPart"))).toBe("(Re z)");
    expect(ast(runCommand(typeText(initialState(), "z"), "imagPart"))).toBe("(Im z)");
    // ℜ and ℑ are the operators' glyphs, never name characters.
    expect(ast(typeText(initialState(), "aℜ"))).toBe("a");
    // The convolution and gradient glyphs are operators too.
    for (const glyph of ["∗", "⊛", "∇", "∠"]) expect(ast(typeText(initialState(), `a${glyph}`))).toBe("a");
  });

  it("An apostrophe joins a name after its first character", () => {
    expect(ast(typeText(initialState(), "x'"))).toBe("x'");
    expect(ast(typeText(initialState(), "x''"))).toBe("x''");
    expect(ast(typeText(initialState(), "v'0"))).toBe("v'0");
    // It never starts a name, and it is not the prime derivative.
    expect(ast(typeText(initialState(), "'"))).toBe("□");
    expect(ast(runCommand(typeText(initialState(), "f"), "primeDeriv"))).toBe("(PrimeDeriv f 1)");
  });

  it("the apostrophe typed on the Italian layout joins the name", () => {
    const s = run("it-IT", [typed("y'", "it-IT")]);
    expect(ast(s)).toBe("y'");
  });

  it("Symbols without an operator meaning join a name", () => {
    expect(ast(typeText(initialState(), "c€"))).toBe("c€");
    expect(ast(typeText(initialState(), "€r"))).toBe("€r");
    expect(ast(typeText(initialState(), "A∩B"))).toBe("A∩B");
    expect(ast(typeText(initialState(), "x©2"))).toBe("x©2");
    // Operator glyphs and ASCII punctuation never do.
    expect(ast(typeText(initialState(), "a#"))).toBe("a");
    expect(ast(typeText(initialState(), "a≤"))).toBe("a");
    // The signs of names are not the operators: `V˖` is one name, `V+` a sum.
    expect(ast(typeText(initialState(), "V˖"))).toBe("V˖");
    expect(ast(typeText(initialState(), "V±⇒⟶"))).toBe("V±⇒⟶");
    expect(ast(typeText(initialState(), "A∉B∶C"))).toBe("A∉B∶C");
  });

  it("types the degree sign as an angle unit and preserves the literal sign in strings", () => {
    const degreeKey = { key: "°", code: "Quote", shiftKey: true };
    const result = handleKey(typeText(initialState(), "90"), degreeKey);
    expect(ast(result.state)).toBe("(juxt 90 °@unit)");
    expect(result.state.caret?.offset).toBe(1);
    expect(ast(runCommand(result.state, "undo"))).toBe("90");
    const name = handleKey(typeText(initialState(), "a"), degreeKey);
    expect(ast(name.state)).toBe("(· a °@unit)");
    expect(ast(typeText(initialState(), "20°C"))).toBe("(juxt 20 °C@unit)");
    const string = runCommand(initialState(), "string");
    expect(ast(handleKey(string, degreeKey).state)).toBe('"°"');
  });

  it("Backspace at the end of an evaluated expression removes the evaluation", () => {
    const BS = named("Backspace");
    const END = named("End");
    // `a/b =`: End makes the whole fraction the cursor; Backspace drops `=`, not the denominator.
    let s = run(layout, [t("a/b="), END, BS]);
    expect(ast(s)).toBe("(/ a b)");
    expect(s).toMatchObject({ focus: [0], side: "R", explicit: false });
    // A second Backspace edits the expression again.
    expect(ast(run(layout, [BS, BS], s))).toBe("(/ a □)");
    s = run(layout, [t("a+b"), c.symbolic]);
    s = run(layout, [BS], { ...s, focus: [0], side: "R", caret: null, explicit: false });
    expect(ast(s)).toBe("(+ a b)");
    // The evaluation tail of a definition.
    const def = run(layout, [t("x:a/b=")]);
    s = run(layout, [BS], { ...def, focus: [1], side: "R", caret: null, explicit: false });
    expect(ast(s)).toBe("(:= x (/ a b))");
    // Inside a name the last character still goes.
    expect(ast(run(layout, [t("xy="), BS]))).toBe("(= x)");
    // A click on the evaluation sign makes the whole region the cursor: `v =` loses its `=`, not its `v`.
    const region = (st: EditorState): EditorState => ({ ...st, focus: [], side: "R", caret: null, explicit: false });
    expect(ast(run(layout, [BS], region(run(layout, [t("v=")]))))).toBe("v");
    expect(ast(run(layout, [BS], region(run(layout, [t("a+b=")]))))).toBe("(+ a b)");
    expect(ast(run(layout, [BS], region(def)))).toBe("(:= x (/ a b))");
    // Delete right before the evaluation sign removes it too.
    const DEL = named("Delete");
    expect(ast(run(layout, [t("v="), DEL]))).toBe("v");
    expect(ast(run(layout, [t("a+b="), DEL]))).toBe("(+ a b)");
    expect(ast(run(layout, [t("a/b="), END, DEL]))).toBe("(/ a b)");
    expect(ast(run(layout, [DEL], region(run(layout, [t("v=")]))))).toBe("v");
    expect(ast(run(layout, [t("x:a+b="), DEL]))).toBe("(:= x (+ a b))");
    // Not inside the expression: `xy` with the caret after `x` loses its `y`.
    expect(ast(run(layout, [t("xy="), named("ArrowLeft"), DEL]))).toBe("(= x)");
  });

  it("selects a definition without its evaluation before the whole region", () => {
    const def = run(layout, [t("a:x+y=")]);
    expect(ast(def)).toBe("(:= a (+ x y) (=))");
    const rhs: EditorState = { ...def, focus: [1], side: "R", caret: null, explicit: true };
    let s = run(layout, [SPACE], rhs);
    expect(s.definitionOnly).toBe(true);
    expect(sexpr(selectedNode(s))).toBe("(:= a (+ x y))");
    s = run(layout, [SPACE], s);
    expect(s.definitionOnly).toBeUndefined();
    expect(s.focus).toEqual([]);
    expect(sexpr(selectedNode(s))).toBe("(:= a (+ x y) (=))");
    // Shift+← from the name, and a drag from the name to the right-hand side, either way.
    expect(runCommand({ ...def, focus: [0], side: "R", caret: null, explicit: true }, "growRight").definitionOnly).toBe(true);
    expect(selectRange(def, [0], [1, 1]).definitionOnly).toBe(true);
    expect(selectRange(def, [1, 0], [0]).definitionOnly).toBe(true);
    // An edit acts on the whole region again.
    expect(run(layout, [named("ArrowLeft")], s).definitionOnly).toBeUndefined();
  });

  it("Space at the end of a numerator selects the numerator before the fraction", () => {
    // `(a + b + c) / d`, the line on the right of `c`: nothing in the numerator lies to its right.
    const sum = run(layout, [t("a+b+c")]);
    const fraction = run(layout, [t("/d")], { ...sum, focus: [0], side: "R", caret: null, explicit: true });
    expect(ast(fraction)).toBe("(/ (+ (+ a b) c) d)");
    let s: EditorState = { ...fraction, focus: [0, 0, 1], side: "R", caret: null, explicit: true };
    expect(selected(s)).toBe("c");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ (+ a b) c)");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(/ (+ (+ a b) c) d)");
    // From the caret typed at the end of `c` (no selection yet) the numerator comes before the fraction too.
    const typed = { ...fraction, focus: [0, 0, 1], side: "R" as const, caret: { seg: 0, offset: 1 }, explicit: false };
    const grown = [1, 2, 3].map((n) => selected(run(layout, new Array(n).fill(SPACE), typed)));
    expect(grown.indexOf("(+ (+ a b) c)")).toBeGreaterThanOrEqual(0);
    expect(grown.indexOf("(+ (+ a b) c)")).toBeLessThan(grown.indexOf("(/ (+ (+ a b) c) d)"));
    // The same for the denominator with the line on the left of its first term.
    const below = run(layout, [t("d/a+b+c")]);
    s = { ...below, focus: [0, 1, 0, 0], side: "L" as const, caret: null, explicit: true };
    expect(selected(s)).toBe("a");
    expect(selected(run(layout, [SPACE], s))).toBe("(+ (+ a b) c)");
  });

  it("Space in a one-term numerator or denominator takes the fraction next, whichever side the line is on", () => {
    // `A := a/b` with the caret in `a`: the fraction, not the whole definition.
    const def = run(layout, [t("A:a/b")]);
    expect(ast(def)).toBe("(:= A (/ a b))");
    const leaf = (name: string) => leafPaths(def.root).find((path) => sexpr(get(def.root, path)) === name)!;
    for (const side of ["L", "R"] as const) {
      const inA = placeCaret(def, leaf("a"), side, { seg: 0, offset: side === "L" ? 0 : 1 });
      const grown = [1, 2].map((n) => selected(run(layout, new Array(n).fill(SPACE), inA)));
      expect(grown).toContain("(/ a b)");
      expect(grown.indexOf("(/ a b)")).toBeLessThan(grown.indexOf("(:= A (/ a b))") === -1 ? 9 : grown.indexOf("(:= A (/ a b))"));
      const inB = placeCaret(def, leaf("b"), side, { seg: 0, offset: side === "L" ? 0 : 1 });
      expect([1, 2].map((n) => selected(run(layout, new Array(n).fill(SPACE), inB)))).toContain("(/ a b)");
    }
  });

  it("Space at the end of a program line takes the value, then the line, then the program", () => {
    const base = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("a+b")]);
    expect(ast(base)).toBe("(:= (call f n) (program (← s (+ a b)) □))");
    const b = leafPaths(base.root).find((path) => sexpr(get(base.root, path)) === "b")!;
    for (const side of ["R", "L"] as const) {
      const start = placeCaret(base, b, side, { seg: 0, offset: side === "R" ? 1 : 0 });
      const grown = [1, 2, 3, 4, 5].map((n) => selected(run(layout, new Array(n).fill(SPACE), start)));
      const order = ["(+ a b)", "(← s (+ a b))", "(program (← s (+ a b)) □)"].map((step) => grown.indexOf(step));
      expect(order.every((at) => at >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
    // The last line of a program as well.
    const last = run(layout, [t("g(n):"), charKey("]", layout), t("1"), named("ArrowDown"), t("c+d")]);
    const d = leafPaths(last.root).find((path) => sexpr(get(last.root, path)) === "d")!;
    const end = placeCaret(last, d, "R", { seg: 0, offset: 1 });
    const steps = [1, 2, 3, 4].map((n) => selected(run(layout, new Array(n).fill(SPACE), end)));
    expect(steps.indexOf("(+ c d)")).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf("(+ c d)")).toBeLessThan(steps.findIndex((step) => step.startsWith("(program")));
  });

  it("Space stops at every slot of a construct, whichever side the line is on", () => {
    const grown = (state: EditorState, presses: number) => [...Array(presses).keys()].map((n) => selected(run(layout, new Array(n + 1).fill(SPACE), state)));
    const at = (state: EditorState, name: string, side: "L" | "R") =>
      placeCaret(state, leafPaths(state.root).find((path) => sexpr(get(state.root, path)) === name)!, side, { seg: 0, offset: side === "R" ? 1 : 0 });
    // A call argument before the call.
    const call = run(layout, [t("y:f(a+b)")]);
    for (const side of ["L", "R"] as const) {
      const steps = grown(at(call, "b", side), 3);
      expect(steps.indexOf("(+ a b)")).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf("(+ a b)")).toBeLessThan(steps.indexOf("(call f (+ a b))"));
    }
    // A fraction part before the fraction and a program line before the program are the same rule.
    const fraction = run(layout, [t("A:a/b")]);
    expect(grown(at(fraction, "a", "L"), 2)).toEqual(["(/ a b)", "(:= A (/ a b))"]);
  });

  it("typing before a call acts on the whole call; - is a negation, as typed in a row", () => {
    const base = run(layout, [t("(f(x))")]);
    expect(ast(base)).toBe("(paren (call f x))");
    const f = leafPaths(base.root).find((path) => sexpr(get(base.root, path)) === "f")!;
    const atF = placeCaret(base, f, "L", { seg: 0, offset: 0 });
    // A number goes in front of the whole call, and an operator after it makes `1 - f(x)`.
    expect(ast(run(layout, [t("2")], atF))).toBe("(paren (juxt 2 (call f x)))");
    expect(ast(run(layout, [t("1-")], atF))).toBe("(paren (- 1 (call f x)))");
    // `-` alone reads as `-f(x)`: the negation of the call, the caret after the sign.
    const minus = run(layout, [t("-")], atF);
    expect(ast(minus)).toBe("(paren (neg (call f x)))");
    // The same before a plain name, and after an operator: `a + -g`.
    const g = run(layout, [t("g"), named("ArrowLeft")]);
    expect(ast(run(layout, [t("-")], g))).toBe("(neg g)");
    const sum = run(layout, [t("a+g"), named("ArrowLeft")]);
    expect(ast(run(layout, [t("-")], sum))).toBe("(+ a (neg g))");
    // Removing the emptied first term of an existing subtraction still leaves the negation.
    const difference = run(layout, [t("a-g")]);
    const a = leafPaths(difference.root).find((path) => sexpr(get(difference.root, path)) === "a")!;
    const emptied = run(layout, [named("Backspace")], placeCaret(difference, a, "R", { seg: 0, offset: 1 }));
    expect(ast(emptied)).toBe("(- □ g)");
    expect(ast(run(layout, [named("Backspace")], emptied))).toBe("(neg g)");
  });


  it("a run of terms grows the way it is extended, by Space, Shift+arrows and drag", () => {
    const sum = run(layout, [t("a+b+c+d")]);
    // The expression is child 0 of the region: in `((a + b) + c) + d` b is [0, 0, 0, 1], c is [0, 0, 1].
    const at = (path: number[], side: "L" | "R") => ({ ...sum, focus: path, side, caret: null, explicit: true });
    const shown = (st: EditorState) => sexpr(selectedNode(st));
    let s = runCommand(at([0, 0, 0, 1], "R"), "grow");
    expect(shown(s)).toBe("(+ b c)");
    expect(s.termSelection).toEqual({ path: [0], first: 1, last: 2 });
    s = runCommand(s, "grow");
    expect(shown(s)).toBe("(+ (+ b c) d)");
    // At the end of the chain: the whole chain, then goes on.
    s = runCommand(s, "grow");
    expect(shown(s)).toBe("(+ (+ (+ a b) c) d)");
    expect(s.termSelection).toBeUndefined();
    // To the left from c: b + c, then the leading terms a + b + c (a sub-expression).
    s = runCommand(at([0, 0, 1], "L"), "grow");
    expect(shown(s)).toBe("(+ b c)");
    s = runCommand(s, "grow");
    expect(sexpr(get(s.root, s.focus))).toBe("(+ (+ a b) c)");
    expect(s.termSelection).toBeUndefined();
    // Shift+arrows grow the same way and turn the insertion line.
    s = runCommand(at([0, 0, 0, 1], "L"), "growRight");
    expect(shown(s)).toBe("(+ b c)");
    expect(s.side).toBe("R");
    // A drag from b to c, either way, selects b + c.
    expect(shown(selectRange(sum, [0, 0, 0, 1], [0, 0, 1]))).toBe("(+ b c)");
    expect(shown(selectRange(sum, [0, 0, 1], [0, 0, 0, 1]))).toBe("(+ b c)");
    // Operators of the chain are kept; a product chains alone.
    const mixed = run(layout, [t("a-b+c-d")]);
    const r = runCommand({ ...mixed, focus: [0, 0, 0, 1], side: "R", caret: null, explicit: true }, "grow");
    expect(sexpr(selectedNode(r))).toBe("(+ b c)");
    expect(sexpr(runCommand(r, "backspace").root)).toBe("(- a d)");
    const product = run(layout, [t("a*b*c*d")]);
    expect(sexpr(selectedNode(selectRange(product, [0, 0, 0, 1], [0, 0, 1])))).toBe("(· b c)");
    // Delete removes the run with its operators; typing replaces it; arrows collapse it.
    const bc = selectRange(sum, [0, 0, 0, 1], [0, 0, 1]);
    expect(sexpr(runCommand(bc, "delete").root)).toBe("(+ a d)");
    expect(sexpr(typeCharacter(bc, "x").root)).toBe("(+ (+ a x) d)");
    const left = runCommand(bc, "left");
    expect(left.termSelection).toBeUndefined();
    expect(sexpr(get(left.root, left.focus))).toBe("b");
    // One undo step brings the run's terms back.
    expect(sexpr(runCommand(runCommand(bc, "delete"), "undo").root)).toBe(sexpr(sum.root));
  });

  it("deletion at the expression edge crosses an intervening slot boundary before deleting text", () => {
    const whole = (s: EditorState, side: "L" | "R"): EditorState => ({ ...s, focus: [0], side, caret: null, explicit: false });
    let s = whole(run(layout, [t("a+bc")]), "R");
    expect(selected(s)).toBe("(+ a bc)");
    s = run(layout, [named("Backspace")], s);
    expect(ast(s)).toBe("(+ a b)");
    expect(selected(s)).toBe("b");
    s = whole(run(layout, [t("x^2")]), "R");
    s = run(layout, [named("Backspace"), named("Backspace")], s);
    expect(ast(s)).toBe("(^ x □)");
    s = whole(run(layout, [t("ab+c")]), "L");
    s = run(layout, [named("Delete")], s);
    expect(ast(s)).toBe("(+ b c)");
  });

  it("the arrow has a keyword slot that takes the caret: type a keyword, add more with Shift+Enter, the stored form is unchanged", () => {
    let s = run(layout, [t("x+1"), c.symbolic]);
    expect(get(s.root, s.focus).type).toBe("Placeholder");
    // An untouched slot is not stored: a plain arrow.
    expect(toWire(s.root)).toEqual({ type: "Symbolic", expr: toWire(run(layout, [t("x+1")]).root).expr, keywords: [] });
    s = run(layout, [t("simplify")], s);
    expect(ast(s)).toBe("(→ (+ x 1) (kw simplify))");
    expect((toWire(s.root) as unknown as { keywords: unknown[] }).keywords).toHaveLength(1);
    s = run(layout, [named("Enter", { shiftKey: true }), t("assume,real")], s);
    expect(ast(s)).toBe("(→ (+ x 1) (kw simplify) (kw assume real))");
    // Shift+Enter on an empty slot adds nothing, not even an invisible break.
    const empty = run(layout, [t("x"), c.symbolic, named("Enter", { shiftKey: true })]);
    expect(ast(empty)).toBe("(→ x (kw □))");
    expect(empty.breaks).toHaveLength(0);
    // A definition with a symbolic tail gets the slot too.
    const defined = run(layout, [t("y:2"), c.symbolic, t("float")]);
    expect(ast(defined)).toBe("(:= y 2 (→))");
    expect(sexpr(defined.root.tail.keywords[0])).toBe("(kw float)");
  });

  it("Backspace removes a keyword's empty argument with its comma and never deletes the expression", () => {
    const BS = named("Backspace");
    let s = run(layout, [t("x+1"), c.symbolic, t("solve,x")]);
    expect(ast(s)).toBe("(→ (+ x 1) (kw solve x))");
    s = run(layout, [BS], s);
    expect(ast(s)).toBe("(→ (+ x 1) (kw solve □))");
    // The empty argument goes with its comma; the caret is at the end of the keyword.
    s = run(layout, [BS], s);
    expect(ast(s)).toBe("(→ (+ x 1) (kw solve))");
    expect(selected(s)).toBe("solve");
    // Emptying the keyword leaves the arrow's empty slot; Backspace goes on into the expression.
    s = run(layout, [BS, BS, BS, BS, BS], s);
    expect(ast(s)).toBe("(→ (+ x 1) (kw □))");
    const past = run(layout, [BS], s);
    expect(ast(past)).toBe("(→ (+ x 1) (kw □))");
    expect(selected(past)).toBe("1");
    // A second, empty keyword line goes, the caret back at the end of the first.
    const two = run(layout, [t("x"), c.symbolic, t("expand"), named("Enter", { shiftKey: true })]);
    expect(ast(two)).toBe("(→ x (kw expand) (kw □))");
    const one = run(layout, [BS], two);
    expect(ast(one)).toBe("(→ x (kw expand))");
    expect(selected(one)).toBe("expand");
  });

  it("a palette keyword fills the empty slot instead of adding one", () => {
    let s = run(layout, [t("x+1"), c.symbolic]);
    s = insertSymbolicKeyword(s, "expand");
    expect(ast(s)).toBe("(→ (+ x 1) (kw expand))");
    s = insertSymbolicKeyword(s, "real", true);
    expect(ast(s)).toBe("(→ (+ x 1) (kw expand real))");
    expect(ast(insertSymbolicKeyword(run(layout, [t("x+1")]), "solve"))).toBe("(→ (+ x 1) (kw solve))");
  });

  it("Space grows the selection one term at a time and cycles back at the top", () => {
    let s = run(layout, [t("a+b*c")]);
    expect(selected(s)).toBe("c");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(· b c)");
    expect(s.explicit).toBe(true);
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ a (· b c))");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("c");
  });

  it("Space grows in the direction of the insertion line: to the left of a term or to its right", () => {
    // `a` is the left operand of the product and the sum extends to its left: with the line on
    // the left the group grows over the sum, with the line on the right over the product.
    const left = run(layout, [t("x+a*b"), named("Home"), named("ArrowRight"), named("ArrowRight")]);
    expect(selected(left)).toBe("a");
    expect(left.side).toBe("L");
    let s = run(layout, [SPACE], left);
    expect(selected(s)).toBe("(+ x (· a b))");
    expect(s.side).toBe("L");
    const right = run(layout, [named("Insert")], left);
    expect(right.side).toBe("R");
    s = run(layout, [SPACE], right);
    expect(selected(s)).toBe("(· a b)");
    expect(s.side).toBe("R");
  });

  it("Space keeps the insertion line on its side through the growth and returns to the anchor", () => {
    // The line starts on the left of `c`: the group takes the product (which extends to the
    // left), then the sum, then it cycles back to `c`, still on the left.
    let s = run(layout, [t("a+b*c"), named("Insert")]);
    expect(selected(s)).toBe("c");
    expect(s.side).toBe("L");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(· b c)");
    expect(s.side).toBe("L");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ a (· b c))");
    expect(s.side).toBe("L");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("c");
    expect(s.side).toBe("L");
    expect(s.explicit).toBe(false);
    expect(s.caret).toEqual({ seg: 0, offset: 0 });
    // The same cycle with the line on the left of `a`: the anchor keeps its side and caret.
    s = run(layout, [t("a+b*c"), named("Home")]);
    expect(selected(s)).toBe("a");
    expect(s.side).toBe("L");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ a (· b c))");
    expect(s.side).toBe("L");
    expect(s.explicit).toBe(true);
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("a");
    expect(s.side).toBe("L");
    expect(s.caret).toEqual({ seg: 0, offset: 0 });
  });

  it("Space at the edge of an expression still encloses the enclosing expression", () => {
    // Nothing extends to the right of the last element, so the group takes the product and then
    // the sum (the reference application: the whole denominator, then the whole expression).
    let s = run(layout, [t("a+b*c")]);
    expect(selected(s)).toBe("c");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(· b c)");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ a (· b c))");
  });

  it("Space grows over the parentheses that wrap a group, in both directions", () => {
    // `a+b` inside the parentheses grows over `(a+b)` before the product, with the line on the
    // right of the sum as well as on its left.
    let s = run(layout, [t("(a+b)*c"), named("Home"), named("Insert")]);
    expect(selected(s)).toBe("a");
    expect(s.side).toBe("R");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(+ a b)");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(paren (+ a b))");
    s = run(layout, [SPACE], s);
    expect(selected(s)).toBe("(· (paren (+ a b)) c)");
    expect(s.side).toBe("R");
  });

  it("an operator applies to the explicit selection: (a+b)^2 and (a+b)/2", () => {
    expect(ast(run(layout, [t("a+b"), SPACE, t("^2")]))).toBe("(^ (+ a b) 2)");
    expect(ast(run(layout, [t("a+b"), SPACE, t("/2")]))).toBe("(/ (+ a b) 2)");
    expect(ast(run(layout, [t("a+b"), SPACE, t("*c")]))).toBe("(· (+ a b) c)");
  });

  it("typing over an explicit selection replaces it", () => {
    expect(ast(run(layout, [t("a+b*c"), SPACE, t("z")]))).toBe("(+ a z)");
  });

  it("operators on a selected statement apply to its expression", () => {
    const s = run(layout, [t("x:a+b"), SPACE, SPACE]);
    expect(get(s.root, s.focus).type).toBe("Define");
    expect(ast(run(layout, [t("^2")], s))).toBe("(:= x (^ (+ a b) 2))");
  });

  it("evaluation, symbolic evaluation and definition with evaluation", () => {
    expect(ast(run(layout, [t("x+1=")]))).toBe("(= (+ x 1))");
    expect(ast(run(layout, [t("x+1"), c.symbolic]))).toBe("(→ (+ x 1) (kw □))");
    expect(ast(run(layout, [t("y:2="),]))).toBe("(:= y 2 (=))");
    expect(ast(run(layout, [t("y"), c.global, t("2")]))).toBe("(≡ y 2)");
  });

  it("Boolean equality and the relational pairs <= >= <>", () => {
    expect(ast(run(layout, [t("a"), c.boolEq, t("b")]))).toBe("(== a b)");
    expect(ast(run(layout, [t("a<=b")]))).toBe("(≤ a b)");
    expect(ast(run(layout, [t("a>=b")]))).toBe("(≥ a b)");
    expect(ast(run(layout, [t("a<>b")]))).toBe("(≠ a b)");
  });

  it("unary minus on a placeholder, binary minus otherwise", () => {
    expect(ast(run(layout, [t("-x^2")]))).toBe("(neg (^ x 2))");
    expect(ast(run(layout, [t("-a*b")]))).toBe("(· (neg a) b)");
    expect(ast(run(layout, [t("a-b-c")]))).toBe("(- (- a b) c)");
  });

  it("applies operators to the full call when the function name is selected", () => {
    const call = run(layout, [t("funz(a,b)")]);
    const callee = focusAt(call.root, [0, 0], "L", true);
    // `-` negates the call, as `-funz(a, b)` typed in a row reads.
    const negated = run(layout, [t("-")], callee);
    expect(ast(negated)).toBe("(neg (call funz a b))");
    expect(ast(run(layout, [c.undo], negated))).toBe("(call funz a b)");
    expect(ast(run(layout, [named("Home"), t("-")], call))).toBe("(neg (call funz a b))");
    expect(ast(run(layout, [named("Home"), SPACE, t("-")], call))).toBe("(neg (call funz a b))");
    expect(ast(run(layout, [t("+")], callee))).toBe("(+ □ (call funz a b))");
    expect(ast(run(layout, [t("^2")], callee))).toBe("(^ (call funz a b) 2)");
    expect(ast(run(layout, [t("-z")], focusAt(call.root, [0, 0], "R", true)))).toBe("(- (call funz a b) z)");
    expect(ast(run(layout, [t("^2")], focusAt(call.root, [0, 1], "R", true)))).toBe("(call funz (^ a 2) b)");
    expect(get(runCommand(callee, "primeDeriv").root, [0, 0]).type).toBe("PrimeDeriv");
  });

  it("numbers followed by letters: implicit multiplication, imaginary literals, ranges", () => {
    expect(ast(run(layout, [t("3.5m")]))).toBe("(juxt 3.5 m)");
    expect(ast(run(layout, [t("2j")]))).toBe("2j");
    expect(ast(run(layout, [t("2in")]))).toBe("(juxt 2 in)");
    expect(ast(run(layout, [t("i:0..n")]))).toBe("(:= i (range 0 n))");
    expect(ast(run(layout, [t("i:0,0.5..n")]))).toBe("(:= i (range 0 0.5 n))");
  });

  it("Ctrl+G toggles the letter before the caret", () => {
    expect(ast(run(layout, [t("p"), c.greek]))).toBe("π");
    expect(ast(run(layout, [t("j"), c.greek]))).toBe("φ");
    expect(ast(run(layout, [t("f"), c.greek]))).toBe("ϕ");
    expect(ast(run(layout, [t("q"), c.greek, c.greek]))).toBe("q");
  });

  it("types an underscore into a name, as a name character", () => {
    expect(ast(run(layout, [t("a_b")]))).toBe("a_b");
    expect(get(run(layout, [t("a_b")]).root, [0]).name.segments).toEqual([{ text: "a_b", subscript: false }]);
    expect(ast(run(layout, [t("_x:1")]))).toBe("(:= _x 1)");
  });

  it("Left from after a call crosses its closing parenthesis in one step", () => {
    const typedDef = run(layout, [t("f(x,y):x*y")]);
    const head = placeCaret(typedDef, [0], "R");
    const left = run(layout, [named("ArrowLeft")], head);
    expect(left).toMatchObject({ focus: [0, 2], side: "R" });
    expect(sameCursor(head, left)).toBe(false);
    expect(run(layout, [named("ArrowRight")], left)).toMatchObject({ focus: [0], side: "R" });

    // An enclosing expression shares the right edge of its last operand.
    const product = run(layout, [t("a*(x+y)")]);
    expect(selected(run(layout, [named("ArrowLeft")], placeCaret(product, [0], "R")))).toBe("y");
    // Conversely the left edge of the product shares the opening edge of the first operand.
    const mirrored = run(layout, [t("(x+y)*a")]);
    expect(selected(run(layout, [named("ArrowRight")], placeCaret(mirrored, [0], "L")))).toBe("x");
  });

  it("Right from the end of f(a,b) stops after the closing parenthesis before leaving", () => {
    const typed = run(layout, [t("f(a,b)")]);
    const atB = placeCaret(typed, [0, 2], "R");
    const rightOfB = run(layout, [named("ArrowRight")], atB);
    // Not the same cursor: the window must not leave the region on this press.
    expect(sameCursor(atB, rightOfB)).toBe(false);
    expect(rightOfB.focus).toEqual([0]);
    expect(rightOfB.side).toBe("R");
    // The next Right has nowhere to go: the cursor is unchanged and the window leaves the region.
    expect(sameCursor(rightOfB, run(layout, [named("ArrowRight")], rightOfB))).toBe(true);
    // Nested calls stop after each parenthesis, and `(x+y)` stops after its `)` too.
    const nested = run(layout, [t("f(g(a))")]);
    const inner = run(layout, [named("ArrowRight")], placeCaret(nested, [0, 1, 1], "R"));
    expect(selected(inner)).toBe("(call g a)");
    const paren = run(layout, [named("ArrowRight")], placeCaret(run(layout, [t("(x+y)*a")]), [0, 0, 0, 1], "R"));
    expect(selected(paren)).toBe("(paren (+ x y))");
    // The mirror image: Left from the start of `(x+y)` stops before its `(`.
    const atX = placeCaret(run(layout, [t("(x+y)*a")]), [0, 0, 0, 0], "L");
    const before = run(layout, [named("ArrowLeft")], atX);
    expect(selected(before)).toBe("(paren (+ x y))");
    expect(before.side).toBe("L");
  });

  it("a new region that is one plain name with the caret at its end is a word a Space turns into text", () => {
    expect(loneNameText(run(layout, [t("ciao")]))).toBe("ciao");
    expect(loneNameText(run(layout, [t("x")]))).toBe("x");
    // Not a word: other math, an empty region, the caret inside the name, a labelled name.
    expect(loneNameText(run(layout, [t("a+b")]))).toBeNull();
    expect(loneNameText(run(layout, [t("f(x)")]))).toBeNull();
    expect(loneNameText(run(layout, [t("2")]))).toBeNull();
    expect(loneNameText(initialState())).toBeNull();
    expect(loneNameText(run(layout, [t("ciao"), named("ArrowLeft")]))).toBeNull();
    expect(loneNameText(run(layout, [t("L"), c.unit]))).toBeNull();
  });

  it("the arrows pass just outside the quotes of a string, so a comma can follow it", () => {
    const inside = run(layout, [t('f("a')]);
    expect(inside.focus).toEqual([0, 1]);
    expect(inside.caret).not.toBeNull();
    // Right at the end of the text: just outside the closing quote, still in the argument list.
    const after = run(layout, [named("ArrowRight")], inside);
    expect(after.focus).toEqual([0, 1]);
    expect(after.caret).toBeNull();
    expect(after.side).toBe("R");
    expect(sameCursor(inside, after)).toBe(false);
    // A comma typed there starts the next argument: f("a", "b").
    expect(ast(run(layout, [t(',"b')], after))).toBe('(call f "a" "b")');
    // The next Right goes on, out of the argument.
    expect(run(layout, [named("ArrowRight")], after).focus).toEqual([0]);
    // The mirror image: Left from the start of the text stops outside the opening quote, and Left from
    // there is the way back into the text.
    const start = run(layout, [named("ArrowLeft")], run(layout, [t('x+"a')]));
    expect(start.caret).toEqual({ seg: 0, offset: 0 });
    const before = run(layout, [named("ArrowLeft")], start);
    expect(before.caret).toBeNull();
    expect(before.side).toBe("L");
    expect(run(layout, [named("ArrowRight")], before).caret).toEqual({ seg: 0, offset: 0 });
    // Left from just outside the closing quote goes back into the text, at its end.
    expect(run(layout, [named("ArrowLeft")], after).caret).toEqual({ seg: 0, offset: 1 });
  });

  it("Delete and Backspace on a parenthesis remove the pair and regroup by precedence", () => {
    // (a + b)·c, the caret at the end.
    const product = run(layout, [t("(a+b"), named("ArrowRight"), t("*c")]);
    expect(ast(product)).toBe("(· (paren (+ a b)) c)");
    const regrouped = "(+ a (· b c))";
    // Backspace just after `(`.
    const afterOpen = run(layout, [named("Backspace")], focusAt(product.root, [0, 0, 0, 0], "L"));
    expect(ast(afterOpen)).toBe(regrouped);
    // The caret stays where it was: on the left of `a`.
    expect(selected(afterOpen)).toBe("a");
    expect(afterOpen.side).toBe("L");
    // Delete just before `)`.
    const beforeClose = run(layout, [named("Delete")], focusAt(product.root, [0, 0, 0, 1], "R"));
    expect(ast(beforeClose)).toBe(regrouped);
    expect(selected(beforeClose)).toBe("b");
    // Delete just before `(`.
    expect(ast(run(layout, [named("Delete")], focusAt(product.root, [0, 0], "L")))).toBe(regrouped);
    // Backspace just after `)`.
    const afterClose = focusAt(product.root, [0, 0], "R");
    expect(ast(run(layout, [named("Backspace")], afterClose))).toBe(regrouped);
    // One undo step brings the pair back.
    expect(ast(runCommand(afterOpen, "undo"))).toBe("(· (paren (+ a b)) c)");
    // Other neighbours: a power, a sum that keeps its meaning.
    const power = run(layout, [t("(a+b"), named("ArrowRight"), t("^2")]);
    expect(ast(power)).toBe("(^ (paren (+ a b)) 2)");
    expect(ast(run(layout, [named("Delete")], focusAt(power.root, [0, 0], "L")))).toBe("(+ a (^ b 2))");
    const sum = run(layout, [t("x+(a+b")]);
    expect(ast(sum)).toBe("(+ x (paren (+ a b)))");
    expect(ast(run(layout, [named("Delete")], focusAt(sum.root, [0, 1], "L")))).toBe("(+ (+ x a) b)");
    // A minus in front binds tighter than +: -(a + b) becomes -a + b.
    const negated = run(layout, [t("-(a+b")]);
    expect(ast(negated)).toBe("(neg (paren (+ a b)))");
    expect(ast(run(layout, [named("Delete")], focusAt(negated.root, [0, 0], "L")))).toBe("(+ (neg a) b)");
    // An argument is a box: the regrouping stays inside it.
    const call = run(layout, [t("f((a+b"), named("ArrowRight"), t("*c")]);
    expect(ast(call)).toBe("(call f (· (paren (+ a b)) c))");
    expect(ast(run(layout, [named("Delete")], focusAt(call.root, [0, 1, 0], "L")))).toBe("(call f (+ a (· b c)))");
  });

  it("a comma between two arguments opens a new one there, moving the next one right", () => {
    const typedIn = run(layout, [t("f(a,b")]);
    // The caret just after the comma, at the start of `b`: the new argument goes before `b`.
    const startOfB = run(layout, [named("ArrowLeft")], typedIn);
    const before = run(layout, [t(",")], startOfB);
    expect(ast(before)).toBe("(call f a □ b)");
    expect(ast(run(layout, [t("c")], before))).toBe("(call f a c b)");
    // At the end of `a` it goes after `a`: the same place.
    const endOfA = run(layout, [named("ArrowLeft"), named("ArrowLeft")], typedIn);
    expect(ast(run(layout, [t(",c")], endOfA))).toBe("(call f a c b)");
    // At the start of the first argument it goes first; at the end of the last, last.
    const startOfA = run(layout, [named("ArrowLeft"), named("ArrowLeft"), named("ArrowLeft")], typedIn);
    expect(ast(run(layout, [t(",c")], startOfA))).toBe("(call f c a b)");
    expect(ast(run(layout, [t(",c")], typedIn))).toBe("(call f a b c)");
    // A longer argument: the start of `bc + 1` is the start of its first name.
    const sum = run(layout, [t("g(a,bc+1")]);
    const atStart = run(layout, Array.from({ length: 4 }, () => named("ArrowLeft")), sum);
    expect(ast(run(layout, [t(",c")], atStart))).toBe("(call g a c (+ bc 1))");
    // The start of `1` inside it is not the start of the argument: the new one follows it.
    const inside = run(layout, [named("ArrowLeft")], sum);
    expect(ast(run(layout, [t(",c")], inside))).toBe("(call g a (+ bc 1) c)");
  });

  it("Ctrl+U makes a unit name left of the caret a unit, and does nothing to another name", () => {
    expect(ast(run(layout, [t("L"), c.unit]))).toBe("L@unit");
    expect(ast(run(layout, [t("L"), c.unit, c.unit]))).toBe("L");
    expect(ast(run(layout, [t("3*kN"), c.unit]))).toBe("(· 3 kN@unit)");
    expect(ast(run(layout, [t("xyz"), c.unit]))).toBe("xyz");
  });

  it("Ctrl+U labels all units in a selected quotient with one undo step", () => {
    const typed = run(layout, [t("kg*s/W")]);
    const s = focusAt(typed.root, [0], "R", true);
    const marked = run(layout, [c.unit], s);
    expect(ast(marked)).toBe("(· kg@unit (/ s@unit W@unit))");
    expect(marked).toMatchObject({ focus: s.focus, explicit: true, side: "R" });
    expect(marked.past).toHaveLength(1);
    expect(run(layout, [c.unit], marked).root).toBe(marked.root);
    expect(ast(run(layout, [c.undo], marked))).toBe(ast(s));
  });

  it("Ctrl+U keeps existing units, user names, bindings and line breaks in a selection", () => {
    const typed = run(layout, [t("s:min(kg"), c.unit, t(",factor)+W")]);
    const s = focusAt(typed.root, [], "L", true, [{ node: get(typed.root, [1]) }]);
    const marked = run(layout, [c.unit], s);
    expect(ast(marked)).toBe("(:= s (+ (call min kg@unit factor) W@unit))");
    expect(breakWires(marked.root, marked.breaks)).toEqual([{ path: [1] }]);
  });

  it("Ctrl+U respects a selection of consecutive terms or arguments", () => {
    const sum = run(layout, [t("kg+s+W+factor")]);
    const terms = selectRange(sum, [0, 0, 0, 1], [0, 0, 1]);
    expect(terms.termSelection).toBeDefined();
    expect(ast(run(layout, [c.unit], terms))).toBe("(+ (+ (+ kg s@unit) W@unit) factor)");

    const call = run(layout, [t("f(kg,s,W)")]);
    const args = selectRange(call, [0, 2], [0, 3]);
    expect(args.argSelection).toBeDefined();
    expect(ast(run(layout, [c.unit], args))).toBe("(call f kg s@unit W@unit)");
  });

  it("Ctrl+U applies only to the selected matrix cells and skips exponents", () => {
    let matrix = insertMatrixSized(initialState(), 1, 3);
    matrix = typeText(matrix, "kg");
    matrix = run(layout, [t("m^s")], runCommand(matrix, "nextCell"));
    matrix = typeText(runCommand(matrix, "nextCell"), "W");
    const cells = selectRange(matrix, [0, 1], [0, 2]);
    expect(ast(run(layout, [c.unit], cells))).toBe("(matrix 1×3 kg (^ m@unit s) W@unit)");
  });

  it("Ctrl+- toggles a literal subscript", () => {
    const s = run(layout, [t("F"), c.sub, t("max")]);
    expect(ast(s)).toBe("F_max");
    expect(ast(run(layout, [c.sub, t("+1")], s))).toBe("(+ F_max 1)");
  });

  it("[ after an operand is an index, on a placeholder a matrix; comma adds a second index", () => {
    expect(ast(run(layout, [t("v[i")]))).toBe("(index v i)");
    expect(ast(run(layout, [t("M[i,j")]))).toBe("(index M i j)");
    expect(ast(run(layout, [t("[")]))).toBe("(matrix 1×1 □)");
  });

  it("function calls, arguments and closing parenthesis", () => {
    const s = run(layout, [t("f(x,y)")]);
    expect(ast(s)).toBe("(call f x y)");
    expect(get(s.root, s.focus).type).toBe("Call");
    expect(ast(run(layout, [t("^2")], s))).toBe("(^ (call f x y) 2)");
    expect(ast(run(layout, [t("(a+b)*c")]))).toBe("(· (paren (+ a b)) c)");
  });

  it("a local assignment inside a parenthesis is a parenthesised local definition", () => {
    // GitHub : `(`, the target, then `←` puts the definition inside the pair the user
    // typed, and the value takes the caret so the next character goes into it.
    let s = run(layout, [t("(z"), charKey("{", layout), t("3")]);
    expect(ast(s)).toBe("(paren (← z 3))");
    s = run(layout, [t("(v[i"), named("ArrowRight"), charKey("{", layout), t("2")]);
    expect(ast(s)).toBe("(paren (← (index v i) 2))");
    // An empty parenthesis leaves the caret on the target slot.
    const empty = run(layout, [t("("), charKey("{", layout)]);
    expect(ast(empty)).toBe("(paren (← □ □))");
    expect(get(empty.root, empty.focus).type).toBe("Placeholder");
    // The parenthesis is an operand like any other, so the postfix operators and the arithmetic
    // apply to the whole definition.
    expect(ast(run(layout, [t("(v[i"), named("ArrowRight"), charKey("{", layout), t("2"), charKey(")", layout), t("+1")]))).toBe(
      "(+ (paren (← (index v i) 2)) 1)",
    );
    expect(ast(run(layout, [t("(z"), charKey("{", layout), t("3"), charKey(")", layout), c.transpose]))).toBe(
      "(ᵀ (paren (← z 3)))",
    );
    // The wire form keeps the pair and the definition, with the target as a target.
    const wire = toWire(s.root) as unknown as {
      expr: { type: string; expr: { type: string; target: { type: string } } };
    };
    expect(wire.expr.type).toBe("Paren");
    expect(wire.expr.expr.type).toBe("InlineDef");
    expect(wire.expr.expr.target.type).toBe("Index");
    // Selecting the whole pair and pressing `←` takes its content as the target.
    const whole = run(layout, [t("(v[i"), named("ArrowRight"), charKey(")", layout), charKey("{", layout)]);
    expect(ast(whole)).toBe("(paren (← (index v i) □))");
  });

  it("a parenthesis on an element starts a call of the element", () => {
    // GitHub : Right leaves the index, so `(` acts on the element `F[i]` and starts
    // a call — not the product `F[i]·(x)` the printer would write with a space.
    const s = run(layout, [t("F[i"), named("ArrowRight"), t("(x")]);
    expect(ast(s)).toBe("(call (index F i) x)");
    // Two indices and two arguments, as for a call of a name.
    let two = run(layout, [t("M[i,j"), named("ArrowRight"), t("(2")]);
    expect(ast(two)).toBe("(call (index M i j) 2)");
    two = run(layout, [t(",3")], two);
    expect(ast(two)).toBe("(call (index M i j) 2 3)");
    // `(` on an element inside parenthesis wraps it instead (unchanged).
    const inner = run(layout, [t("(F[i"), named("ArrowRight"), t("(")]);
    expect(ast(inner)).toBe("(paren (call (index F i) □))");
  });

  it("matrices: columns to the right, rows below, Tab between cells", () => {
    let s = run(layout, [t("[1"), named(" ", { shiftKey: true }), t("2")]);
    expect(ast(s)).toBe("(matrix 1×2 1 2)");
    s = run(layout, [named("Enter", { shiftKey: true }), t("4")], s);
    expect(ast(s)).toBe("(matrix 2×2 1 2 □ 4)");
    s = run(layout, [named("Tab", { shiftKey: true }), t("3")], s);
    expect(ast(s)).toBe("(matrix 2×2 1 2 3 4)");
    s = run(layout, [named("ArrowUp")], s);
    expect(selected(s)).toBe("1");
  });

  it("Tab walks the cells in reading order and, on the last one, adds a row", () => {
    let s = insertMatrixSized(initialState(), 2, 2);
    s = run(layout, [t("1"), named("Tab"), t("2"), named("Tab"), t("3"), named("Tab"), t("4")], s);
    expect(ast(s)).toBe("(matrix 2×2 1 2 3 4)");
    expect(s.focus).toEqual([0, 3]);
    // the last element: one new row of placeholders, caret in its first cell, one undo step
    const grown = run(layout, [named("Tab")], s);
    expect(ast(grown)).toBe("(matrix 3×2 1 2 3 4 □ □)");
    expect(grown.focus).toEqual([0, 4]);
    expect(ast(runCommand(grown, "undo"))).toBe("(matrix 2×2 1 2 3 4)");
    // Shift+Tab goes back; on the first element it does nothing
    let back = run(layout, [named("Tab", { shiftKey: true })], grown);
    expect(back.focus).toEqual([0, 3]);
    back = run(layout, [named("Tab", { shiftKey: true }), named("Tab", { shiftKey: true }), named("Tab", { shiftKey: true })], back);
    expect(back.focus).toEqual([0, 0]);
    expect(ast(run(layout, [named("Tab", { shiftKey: true })], back))).toBe("(matrix 3×2 1 2 3 4 □ □)");
    expect(run(layout, [named("Tab", { shiftKey: true })], back).focus).toEqual([0, 0]);
  });

  it("Right after the final cell leaves the matrix to its right", () => {
    const fill = (start: EditorState, digits: string) => [...digits].reduce((x, d) => run(layout, [t(d), named("Tab")], x), start);
    let square = fill(insertMatrixSized(initialState(), 2, 2), "123");
    square = run(layout, [t("4")], square);
    expect(square.focus).toEqual([0, 3]);
    const right = run(layout, [named("ArrowRight")], square);
    // The insertion line is at the right edge of the whole matrix, still inside the region.
    expect(right.focus).toEqual([0]);
    expect(right.side).toBe("R");
    expect(get(right.root, right.focus).type).toBe("Matrix");
    expect(ast(run(layout, [t("+1")], right))).toBe("(+ (matrix 2×2 1 2 3 4) 1)");

    // A row vector: Right on its last cell leaves it.
    let row = fill(insertMatrixSized(initialState(), 1, 3), "12");
    row = run(layout, [t("3")], row);
    expect(run(layout, [named("ArrowRight")], row).focus).toEqual([0]);

    // A column vector visits each row before leaving the matrix.
    const column = run(layout, [t("1")], insertMatrixSized(initialState(), 3, 1));
    expect(column.focus).toEqual([0, 0]);
    expect(run(layout, [named("ArrowRight")], column).focus).toEqual([0, 1]);

    // Inside a cell the caret moves first: only the Right at its right edge leaves the matrix.
    let single = run(layout, [t("12")], insertMatrixSized(initialState(), 1, 1));
    single = run(layout, [named("Home"), named("ArrowRight")], single);
    expect(single.focus).toEqual([0, 0]);
    expect(single.caret).toEqual({ seg: 0, offset: 1 });
    single = run(layout, [named("ArrowRight")], single);
    expect(single.caret).toEqual({ seg: 0, offset: 2 });
    expect(run(layout, [named("ArrowRight")], single).focus).toEqual([0]);

    // A cell that is not in the last column keeps the ordinary move to the next cell.
    const first = placeCaret(square, [0, 0], "R");
    expect(run(layout, [named("ArrowRight")], first).focus).toEqual([0, 1]);
  });

  it("continues the same expression after a matrix or vector", () => {
    const filled = (rows: number, cols: number, digits: string) => {
      let x = insertMatrixSized(initialState(), rows, cols);
      [...digits].forEach((d, i) => {
        x = run(layout, [t(d)], x);
        if (i + 1 < digits.length) x = run(layout, [named("Tab")], x);
      });
      return x;
    };
    const after = (x: EditorState) => run(layout, [named("ArrowRight")], x);

    // An operator extends the surrounding expression; the matrix is its left operand.
    const matrix = after(filled(2, 2, "1234"));
    expect(ast(run(layout, [t("+1")], matrix))).toBe("(+ (matrix 2×2 1 2 3 4) 1)");
    expect(ast(run(layout, [t("*2")], matrix))).toBe("(· (matrix 2×2 1 2 3 4) 2)");

    // A name (here a unit) is implicit multiplication with the whole matrix as the operand.
    expect(ast(run(layout, [t("N")], matrix))).toBe("(· (matrix 2×2 1 2 3 4) N)");

    // A matrix inside a larger expression keeps its place: `2*M` then `+1` after the matrix.
    let product = insertMatrixSized(run(layout, [t("2*")], initialState()), 1, 2);
    expect(ast(product)).toBe("(· 2 (matrix 1×2 □ □))");
    product = run(layout, [t("3"), named("Tab"), t("4"), named("ArrowRight")], product);
    expect(product.focus).toEqual([0, 1]);
    expect(ast(run(layout, [t("+1")], product))).toBe("(+ (· 2 (matrix 1×2 3 4)) 1)");

    // In a definition the continuation stays on the right-hand side.
    let definition = insertMatrixSized(run(layout, [t("M:")], initialState()), 1, 2);
    definition = run(layout, [t("5"), named("Tab"), t("6"), named("ArrowRight")], definition);
    expect(definition.focus).toEqual([1]);
    expect(ast(run(layout, [t("+1")], definition))).toBe("(:= M (+ (matrix 1×2 5 6) 1))");
  });

  it("Tab on the last element of a column vector and of a row vector adds a row", () => {
    const column = run(layout, [named("Tab"), named("Tab")], insertMatrixSized(initialState(), 3, 1));
    expect(column.focus).toEqual([0, 2]);
    const grownColumn = run(layout, [named("Tab")], column);
    expect(ast(grownColumn)).toBe("(matrix 4×1 □ □ □ □)");
    expect(grownColumn.focus).toEqual([0, 3]);
    const row = run(layout, [named("Tab"), named("Tab")], insertMatrixSized(initialState(), 1, 3));
    expect(row.focus).toEqual([0, 2]);
    const grownRow = run(layout, [named("Tab")], row);
    expect(ast(grownRow)).toBe("(matrix 2×3 □ □ □ □ □ □)");
    expect(grownRow.focus).toEqual([0, 3]);
  });

  it("Tab inside a cell with a sub-expression still goes to the next cell", () => {
    const inner = run(layout, [t("a/")], insertMatrixSized(initialState(), 2, 2));
    expect(inner.focus.length).toBeGreaterThan(2);
    const next = run(layout, [named("Tab")], inner);
    expect(next.focus).toEqual([0, 1]);
    // the placeholder of the denominator was skipped, not removed
    expect(ast(next)).toContain("(/ a □)");
  });

  it("Ctrl+M inserts a matrix of the chosen size", () => {
    const s = insertMatrixSized(run(layout, [t("A:")]), 2, 3);
    expect(ast(s)).toBe("(:= A (matrix 2×3 □ □ □ □ □ □))");
    expect(s.focus).toEqual([1, 0]);
  });

  it("deletes a selected matrix row or column and undoes it", () => {
    let s = insertMatrixSized(initialState(), 2, 3);
    for (const digit of "123456") {
      s = typeText(s, digit);
      if (digit !== "6") s = runCommand(s, "nextCell");
    }
    const row = selectRange(s, [0, 0], [0, 2]);
    expect(row.matrixSelection?.axis).toBe("row");
    const deletedRow = runCommand(row, "delete");
    expect(ast(deletedRow)).toBe("(matrix 1×3 4 5 6)");
    expect(ast(runCommand(deletedRow, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");
    const column = selectRange(s, [0, 1], [0, 4]);
    expect(column.matrixSelection?.axis).toBe("column");
    expect(ast(runCommand(column, "delete"))).toBe("(matrix 2×2 1 3 4 6)");
    expect(ast(runCommand(placeCaret(s, [0, 4], "R"), "deleteRow"))).toBe("(matrix 1×3 1 2 3)");
    expect(ast(runCommand(placeCaret(s, [0, 4], "R"), "deleteColumn"))).toBe("(matrix 2×2 1 3 4 6)");
    const lastRow = runCommand(placeCaret(s, [0, 3], "R"), "deleteRow");
    expect(ast(lastRow)).toBe("(matrix 1×3 1 2 3)");
    // Deleting the last remaining row leaves a 1x1 matrix with a placeholder, one undo step.
    const oneByOne = runCommand(lastRow, "deleteRow");
    expect(ast(oneByOne)).toBe("(matrix 1×1 □)");
    expect(ast(runCommand(oneByOne, "undo"))).toBe(ast(lastRow));
    let singleColumn = runCommand(placeCaret(s, [0, 0], "R"), "deleteColumn");
    singleColumn = runCommand(singleColumn, "deleteColumn");
    expect(ast(singleColumn)).toBe("(matrix 2×1 3 6)");
    expect(ast(runCommand(singleColumn, "deleteColumn"))).toBe("(matrix 1×1 □)");
  });

  it("selects the row or column of the active cell by command, then Delete removes it (one undo step)", () => {
    let s = insertMatrixSized(initialState(), 2, 3);
    for (const digit of "123456") {
      s = typeText(s, digit);
      if (digit !== "6") s = runCommand(s, "nextCell");
    }
    const row = runCommand(placeCaret(s, [0, 4], "R"), "selectRow");
    expect(row.matrixSelection).toMatchObject({ axis: "row", index: 1 });
    expect(ast(row)).toBe(ast(s));
    expect(row.past.length).toBe(s.past.length);
    const after = runCommand(row, "delete");
    expect(ast(after)).toBe("(matrix 1×3 1 2 3)");
    expect(after.matrixSelection).toBeUndefined();
    expect(after.past.length).toBe(s.past.length + 1);
    expect(ast(runCommand(after, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");
    const column = runCommand(placeCaret(s, [0, 4], "R"), "selectColumn");
    expect(column.matrixSelection).toMatchObject({ axis: "column", index: 1 });
    expect(ast(runCommand(column, "backspace"))).toBe("(matrix 2×2 1 3 4 6)");
    // Any other command or typing drops the selection, so Delete then edits normally.
    expect(runCommand(column, "right").matrixSelection).toBeUndefined();
    expect(typeText(column, "9").matrixSelection).toBeUndefined();
    // A click (caret placement) elsewhere clears it too.
    expect(placeCaret(column, [0, 0], "R").matrixSelection).toBeUndefined();
    // A 1x1 matrix stays 1x1: deleting its row or column empties the cell to a placeholder.
    let one = insertMatrixSized(initialState(), 1, 1);
    one = typeText(one, "7");
    expect(ast(runCommand(runCommand(one, "selectRow"), "delete"))).toBe("(matrix 1×1 □)");
    expect(ast(runCommand(one, "deleteColumn"))).toBe("(matrix 1×1 □)");
  });

  it("inserts rows above and columns left, and clears selected cells", () => {
    let s = insertMatrixSized(initialState(), 2, 3);
    for (const digit of "123456") {
      s = typeText(s, digit);
      if (digit !== "6") s = runCommand(s, "nextCell");
    }

    const above = runCommand(placeCaret(s, [0, 4], "R"), "addRowAbove");
    expect(ast(above)).toBe("(matrix 3×3 1 2 3 □ □ □ 4 5 6)");
    expect(above.focus).toEqual([0, 4]);
    expect(ast(runCommand(above, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");

    const left = runCommand(placeCaret(s, [0, 4], "R"), "addColumnLeft");
    expect(ast(left)).toBe("(matrix 2×4 1 □ 2 3 4 □ 5 6)");
    expect(left.focus).toEqual([0, 5]);
    expect(ast(runCommand(left, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");

    const row = runCommand(placeCaret(s, [0, 4], "R"), "selectRow");
    const clearedRow = runCommand(row, "clearCells");
    expect(ast(clearedRow)).toBe("(matrix 2×3 1 2 3 □ □ □)");
    expect(clearedRow.focus).toEqual([0, 3]);
    expect(clearedRow.matrixSelection).toBeUndefined();
    expect(ast(runCommand(clearedRow, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");

    const column = runCommand(placeCaret(s, [0, 4], "R"), "selectColumn");
    expect(ast(runCommand(column, "clearCells"))).toBe("(matrix 2×3 1 □ 3 4 □ 6)");

    const range = selectRange(s, [0, 0], [0, 4]);
    expect(range.matrixSelection).toMatchObject({ axis: "range", index: 0, end: 4 });
    const clearedRange = runCommand(range, "clearCells");
    expect(ast(clearedRange)).toBe("(matrix 2×3 □ □ 3 □ □ 6)");
    expect(clearedRange.focus).toEqual([0, 0]);
    expect(ast(runCommand(clearedRange, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");
    expect(ast(runCommand(range, "delete"))).toBe("(matrix 2×3 □ □ 3 □ □ 6)");

    const reversed = selectRange(s, [0, 4], [0, 0]);
    expect(reversed.matrixSelection).toMatchObject({ axis: "range", index: 0, end: 4 });
    expect(ast(runCommand(reversed, "clearCells"))).toBe("(matrix 2×3 □ □ 3 □ □ 6)");
  });

  it("typing over several selected cells fills them all while the caret stays in the first", () => {
    let s = insertMatrixSized(initialState(), 2, 3);
    for (const digit of "123456") {
      s = typeText(s, digit);
      if (digit !== "6") s = runCommand(s, "nextCell");
    }
    // A range: every selected cell takes what is typed, and keeps following it.
    let typing = typeCharacter(selectRange(s, [0, 0], [0, 4]), "7");
    expect(ast(typing)).toBe("(matrix 2×3 7 7 3 7 7 6)");
    expect(typing.focus.slice(0, 2)).toEqual([0, 0]);
    typing = run(layout, [t("+x")], typing);
    expect(ast(typing)).toBe("(matrix 2×3 (+ 7 x) (+ 7 x) 3 (+ 7 x) (+ 7 x) 6)");
    typing = runCommand(typing, "backspace");
    expect(ast(typing)).toBe("(matrix 2×3 (+ 7 □) (+ 7 □) 3 (+ 7 □) (+ 7 □) 6)");
    // Palette text is repeated too.
    typing = typeText(typing, "y");
    expect(ast(typing)).toBe("(matrix 2×3 (+ 7 y) (+ 7 y) 3 (+ 7 y) (+ 7 y) 6)");
    // One undo step per key brings every cell back with it.
    expect(ast(runCommand(typing, "undo"))).toBe("(matrix 2×3 (+ 7 □) (+ 7 □) 3 (+ 7 □) (+ 7 □) 6)");
    // Leaving the first cell ends it: the cells keep what they hold and the next cell is typed alone.
    const next = typeCharacter(runCommand(typing, "nextCell"), "0");
    expect(next.cellMirror).toBeUndefined();
    const cell = (state: EditorState, i: number) => sexpr(get(state.root, [0, i]));
    expect([cell(next, 0), cell(next, 3), cell(next, 4)]).toEqual(["(+ 7 y)", "(+ 7 y)", "(+ 7 y)"]);
    expect(cell(next, 1)).not.toBe("(+ 7 y)");
    // A click ends it too.
    const clicked = typeCharacter(placeCaret(typing, [0, 2], "R"), "9");
    expect(ast(clicked)).toBe("(matrix 2×3 (+ 7 y) (+ 7 y) 39 (+ 7 y) (+ 7 y) 6)");
    // A row, a column: the same.
    const row = typeCharacter(runCommand(placeCaret(s, [0, 4], "R"), "selectRow"), "0");
    expect(ast(row)).toBe("(matrix 2×3 1 2 3 0 0 0)");
    const column = typeCharacter(runCommand(placeCaret(s, [0, 4], "R"), "selectColumn"), "a");
    expect(ast(column)).toBe("(matrix 2×3 1 a 3 4 a 6)");
    // The first key and the emptying are one undo step.
    expect(ast(runCommand(row, "undo"))).toBe("(matrix 2×3 1 2 3 4 5 6)");
  });

  it("a drag between two arguments selects the run between them, not the whole call", () => {
    const s = run(layout, [t("f(a,b,c)")]);
    expect(ast(s)).toBe("(call f a b c)");
    // [0] is the call (the region is transparent); child 0 is the callee, children 1..3 the arguments.
    const selectedRun = selectRange(s, [0, 1], [0, 3]);
    expect(selectedRun.argSelection).toEqual({ path: [0], first: 0, last: 2 });
    expect(ast(selectedRun)).toBe("(call f a b c)");
    expect(selected(selectedRun)).toBe("a");
    expect(selectedRun.explicit).toBe(true);
    expect(selectedRun.caret).toBeNull();
    expect(selectedRun.past.length).toBe(s.past.length); // a selection is no undo step

    // The other way round is the same run, in reading order.
    expect(selectRange(s, [0, 3], [0, 2]).argSelection).toEqual({ path: [0], first: 1, last: 2 });

    // Both ends inside arguments' sub-expressions: the arguments that hold them.
    const inner = run(layout, [t("f(a+b,c*d,e)")]);
    expect(selectRange(inner, [0, 1, 0], [0, 2, 1]).argSelection).toEqual({ path: [0], first: 0, last: 1 });
    // A nested call counts as one argument.
    const nested = run(layout, [t("f(g(x),y)")]);
    expect(selectRange(nested, [0, 1, 1], [0, 2]).argSelection).toEqual({ path: [0], first: 0, last: 1 });

    // A drag that also covers the callee selects the whole call, as before.
    const whole = selectRange(s, [0, 0], [0, 2]);
    expect(whole.argSelection).toBeUndefined();
    expect(whole.explicit).toBe(true);
    expect(whole.focus).toEqual([0]);
    // A run of one argument is the ordinary selection of that argument.
    const one = selectRange(s, [0, 1], [0, 1]);
    expect(one.argSelection).toBeUndefined();
    expect(selected(one)).toBe("a");

    // The call need not be the whole region: the run's path is the call's own.
    const defined = run(layout, [t("y:f(a,b,c)")]);
    const inDefinition = selectRange(defined, [1, 1], [1, 2]);
    expect(inDefinition.argSelection).toEqual({ path: [1], first: 0, last: 1 });
    expect(ast(runCommand(inDefinition, "delete"))).toBe("(:= y (call f c))");
  });

  it("Shift+arrows extend a run by one argument, then grow as", () => {
    const s = run(layout, [t("f(a,b,c)")]);
    const shiftRight = named("ArrowRight", { shiftKey: true });
    const shiftLeft = named("ArrowLeft", { shiftKey: true });
    const firstTwo = selectRange(s, [0, 1], [0, 2]); // a, b
    expect(firstTwo.argSelection).toEqual({ path: [0], first: 0, last: 1 });
    const all = run(layout, [shiftRight], firstTwo);
    expect(all.argSelection).toEqual({ path: [0], first: 0, last: 2 });
    expect(ast(all)).toBe("(call f a b c)");
    // At the last argument the run grows as does: the whole call is selected.
    const out = run(layout, [shiftRight], all);
    expect(out.argSelection).toBeUndefined();
    expect(out.focus).toEqual([0]);
    expect(out.explicit).toBe(true);
    // And to the left, from the last two arguments.
    const lastTwo = selectRange(s, [0, 2], [0, 3]); // b, c
    expect(run(layout, [shiftLeft], lastTwo).argSelection).toEqual({ path: [0], first: 0, last: 2 });
    const leftOut = run(layout, [shiftLeft], firstTwo);
    expect(leftOut.argSelection).toBeUndefined();
    expect(leftOut.focus).toEqual([0]);
  });

  it("Left and Right collapse a run to its first or last argument", () => {
    const s = selectRange(run(layout, [t("f(a,b,c)")]), [0, 1], [0, 3]);
    const right = run(layout, [named("ArrowRight")], s);
    expect(right.argSelection).toBeUndefined();
    expect(right.focus).toEqual([0, 3]);
    expect(right.explicit).toBe(true);
    const left = run(layout, [named("ArrowLeft")], s);
    expect(left.argSelection).toBeUndefined();
    expect(left.focus).toEqual([0, 1]);
  });

  it("Delete, typing and operators on a run: the arguments go, one empty argument stays", () => {
    const s = run(layout, [t("f(a,b,c)")]);
    const lastTwo = selectRange(s, [0, 2], [0, 3]); // b, c
    const deleted = runCommand(lastTwo, "delete");
    expect(ast(deleted)).toBe("(call f a)");
    expect(deleted.argSelection).toBeUndefined();
    expect(deleted.past.length).toBe(lastTwo.past.length + 1);
    expect(ast(runCommand(deleted, "undo"))).toBe("(call f a b c)");
    // Backspace: the same, and a call never loses its last argument.
    const emptied = runCommand(selectRange(s, [0, 1], [0, 3]), "backspace");
    expect(ast(emptied)).toBe("(call f □)");
    expect(ast(runCommand(emptied, "undo"))).toBe("(call f a b c)");
    // Typing replaces the run with one argument, in one undo step.
    const typedOver = run(layout, [t("z")], selectRange(s, [0, 1], [0, 2]));
    expect(ast(typedOver)).toBe("(call f z c)");
    expect(typedOver.past.length).toBe(s.past.length + 1);
    expect(ast(typeText(selectRange(s, [0, 1], [0, 2]), "ab"))).toBe("(call f ab c)");
    // Any other command drops the run and acts on its first argument.
    const operator = run(layout, [t("+1")], selectRange(s, [0, 1], [0, 2]));
    expect(ast(operator)).toBe("(call f (+ a 1) b c)");
  });

  it("programs: ] { } and Enter build lines; while and for by chord", () => {
    let s = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("0")]);
    expect(ast(s)).toBe("(:= (call f n) (program (← s 0) □))");
    s = run(layout, [named("ArrowDown")], s);
    s = run(layout, [t("n>0"), charKey("}", layout), t("s")], s);
    expect(ast(s)).toBe("(:= (call f n) (program (← s 0) (if (if (> n 0) s))))");
    let w = run(layout, [t("x:"), charKey("]", layout), t("k<3"), c.while]);
    expect(ast(w)).toBe("(:= x (program (while (< k 3) □) □))");
    w = run(layout, [t("x:"), charKey("]", layout), t("i"), c.for, t("1..n")]);
    expect(ast(w)).toBe("(:= x (program (for i (range 1 n) □) □))");
  });

  it("Shift+Enter in a program adds a line above at the start of a line, else below", () => {
    const shiftEnter = named("Enter", { shiftKey: true });
    const base = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("0")]);
    expect(ast(base)).toBe("(:= (call f n) (program (← s 0) □))");
    // The caret after `0`, not at the start: a new line below.
    expect(ast(run(layout, [shiftEnter], base))).toBe("(:= (call f n) (program (← s 0) □ □))");
    // The caret before `s`, at the start of the line: a new line above, and the caret goes to it.
    const sPath = leafPaths(base.root).find((path) => sexpr(get(base.root, path)) === "s")!;
    const atStart = placeCaret(base, sPath, "L", { seg: 0, offset: 0 });
    const above = run(layout, [shiftEnter], atStart);
    expect(ast(above)).toBe("(:= (call f n) (program □ (← s 0) □))");
    expect(get(above.root, above.focus).type).toBe("Placeholder");
    // On an empty line: below.
    const empty = run(layout, [named("ArrowDown")], base);
    expect(ast(run(layout, [shiftEnter], empty))).toBe("(:= (call f n) (program (← s 0) □ □))");
  });

  it("Shift+Enter at the start of a block header or an expression line adds a line above", () => {
    const shiftEnter = named("Enter", { shiftKey: true });
    let s = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("0"), named("ArrowDown")]);
    s = run(layout, [t("n>0"), charKey("}", layout), t("s")], s);
    expect(ast(s)).toBe("(:= (call f n) (program (← s 0) (if (if (> n 0) s))))");
    const leaf = (state: EditorState, name: string, nth = 0) => leafPaths(state.root).filter((path) => sexpr(get(state.root, path)) === name)[nth];
    // The caret before the condition, at the start of the `if` line: a line above the whole `if`.
    const beforeCond = placeCaret(s, leaf(s, "n", 1), "L", { seg: 0, offset: 0 });
    const above = handleKey(beforeCond, shiftEnter).state;
    expect(ast(above)).toBe("(:= (call f n) (program (← s 0) □ (if (if (> n 0) s))))");
    expect(above.breaks).toHaveLength(0);
    expect(get(above.root, above.focus).type).toBe("Placeholder");
    // The whole `if` block with the caret on its left: above it as well.
    const ifPath = leaf(s, "n", 1).slice(0, -3);
    expect(get(s.root, ifPath).type).toBe("If");
    expect(ast(handleKey(placeCaret(s, ifPath, "L"), shiftEnter).state)).toBe("(:= (call f n) (program (← s 0) □ (if (if (> n 0) s))))");
    // An expression line that starts with an operand: above, not a continuation break before it.
    const sum = run(layout, [t("x:"), charKey("]", layout), t("a+b")]);
    const beforeA = placeCaret(sum, leaf(sum, "a"), "L", { seg: 0, offset: 0 });
    const sumAbove = handleKey(beforeA, shiftEnter).state;
    expect(ast(sumAbove)).toBe("(:= x (program □ (+ a b) □))");
    expect(sumAbove.breaks).toHaveLength(0);
  });

  it("Shift+Enter at the start of an else if head adds a line at the end of the branch above", () => {
    const shiftEnter = named("Enter", { shiftKey: true });
    let s = run(layout, [t("x:"), charKey("]", layout), t("a"), charKey("}", layout), t("1"), named("ArrowDown")]);
    s = run(layout, [c.elseIf, t("b"), named("Tab"), t("2")], s);
    expect(ast(s)).toBe("(:= x (program (if (if a 1) (elseif b 2))))");
    const b = leafPaths(s.root).find((path) => sexpr(get(s.root, path)) === "b")!;
    const above = handleKey(placeCaret(s, b, "L", { seg: 0, offset: 0 }), shiftEnter).state;
    expect(ast(above)).toBe("(:= x (program (if (if a 1 □) (elseif b 2))))");
    expect(get(above.root, above.focus).type).toBe("Placeholder");
  });

  it("turns the parentheses drawn for precedence into real ones, so Backspace and Left treat them as such", () => {
    // `a + (1 + 2·b)` as a tree with no Paren node: the view draws the parentheses itself.
    const n = (text: string): Node => ({ type: "Num", text });
    const bin = (type: string, left: Node, right: Node): Node => ({ type, left, right });
    const bare: Node = { type: "ExprRegion", expr: bin("Add", ident("a"), bin("Add", n("1"), bin("Mul", n("2"), ident("b")))) };
    const tree = withDrawnParens(bare);
    expect(sexpr(tree)).toBe("(+ a (paren (+ 1 (· 2 b))))");
    // Only where the view draws them: no parentheses for a left operand of the same level.
    expect(sexpr(withDrawnParens({ type: "ExprRegion", expr: bin("Add", bin("Add", ident("a"), n("1")), ident("b")) }))).toBe("(+ (+ a 1) b)");
    expect(sexpr(withDrawnParens({ type: "ExprRegion", expr: bin("Mul", bin("Add", ident("a"), n("1")), ident("b")) }))).toBe("(· (paren (+ a 1)) b)");
    const s = initialState(tree);
    const one = leafPaths(s.root).find((path) => sexpr(get(s.root, path)) === "1")!;
    const atOne = placeCaret(s, one, "L", { seg: 0, offset: 0 });
    // Backspace removes the parentheses, not the `+` before them.
    expect(ast(run(layout, [named("Backspace")], atOne))).toBe("(+ (+ a 1) (· 2 b))");
    // A path of the view (no parentheses) maps onto the editing tree.
    expect(drawnParenPath(bare, tree, [0, 1, 0])).toEqual([0, 1, 0, 0]);
    expect(drawnParenPath(bare, tree, [0, 0])).toEqual([0, 0]);
    // Left stops on the parentheses before going on to `a`.
    const left = run(layout, [named("ArrowLeft")], atOne);
    expect(selected(left)).toBe("(paren (+ 1 (· 2 b)))");
  });

  it("an operator typed on the left of an operand goes before it, with an empty place", () => {
    const num = (text: string): Node => ({ type: "Num", text });
    const bin = (type: string, left: Node, right: Node): Node => ({ type, left, right });
    const integral: Node = { type: "Integral", var: ident("t"), lower: num("0"), upper: ident("m"), body: ident("f") };
    const region = (expr: Node) => initialState({ type: "ExprRegion", expr });
    const plus = (s: EditorState) => run(layout, [t("+")], s);
    // `a + ∫…`: the integral selected with the line on its left, or the caret on its left.
    const sum = region(bin("Add", ident("a"), integral));
    for (const explicit of [true, false]) {
      const typed = plus(focusAt(sum.root, [0, 1], "L", explicit));
      expect(ast(typed)).toBe("(+ (+ a □) (∫ f t))");
      expect(selected(typed)).toBe("□");
    }
    // A power and a call the caret is in front of; after a product, the product takes the place.
    const power = region(bin("Add", ident("a"), bin("Pow", ident("b"), num("2"))));
    const b = leafPaths(power.root).find((path) => sexpr(get(power.root, path)) === "b")!;
    expect(ast(plus(placeCaret(power, b, "L", { seg: 0, offset: 0 })))).toBe("(+ (+ a □) (^ b 2))");
    const product = region(bin("Mul", ident("a"), integral));
    expect(ast(plus(focusAt(product.root, [0, 1], "L", true)))).toBe("(+ (· a □) (∫ f t))");
    // Inside an equation the sum on its right side only.
    const equation = region(bin("Eq", ident("x"), bin("Add", ident("a"), integral)));
    expect(ast(plus(focusAt(equation.root, [0, 1, 1], "L", true)))).toBe("(== x (+ (+ a □) (∫ f t)))");
    // At the start of a numerator it stays inside the fraction.
    const fraction = region(bin("Div", ident("a"), ident("b")));
    const a = leafPaths(fraction.root).find((path) => sexpr(get(fraction.root, path)) === "a")!;
    expect(ast(plus(placeCaret(fraction, a, "L", { seg: 0, offset: 0 })))).toBe("(/ (+ □ a) b)");
  });

  it("crosses the minus before the integral before entering its bounds", () => {
    const number = (text: string) => ({ type: "Num", text });
    const bin = (type: string, left: Node, right: Node) => ({ type, left, right });
    const paren = (expr: Node) => ({ type: "Paren", expr });
    const f = () => ({ type: "Call", callee: ident("f"), args: ["θ", "μ"].map(name => ({ type: "Expr", expr: ident(name) })) });
    const current = { type: "Ident", name: { segments: [{ text: "I", subscript: false }, { text: "DC", subscript: true }], label: null } };
    const integral: Node = {
      type: "Integral", bounds: { lo: number("0"), hi: ident("μ") }, var: ident("θ"),
      body: bin("Mul", f(), paren(bin("Sub", number("1"), f()))),
    };
    // I_DC²/π·((2/3·π − μ)² + μ − ∫₀^μ f(θ,μ)·(1 − f(θ,μ)) dθ)
    const power = bin("Pow", paren(bin("Sub", bin("Mul", bin("Div", number("2"), number("3")), ident("π")), ident("μ"))), number("2"));
    const expr = bin("Mul", bin("Div", bin("Pow", current, number("2")), ident("π")),
      paren(bin("Sub", bin("Add", power, ident("μ")), integral)));
    const owner = [0, 1, 0, 1];
    for (const root of [
      { type: "ExprRegion", expr },
      { type: "Symbolic", expr, keywords: [{ type: "KeywordGroup", keyword: ident("simplify"), args: [] }] },
    ]) {
      const atMu = focusAt(root, [0, 1, 0, 0, 1], "R");
      const before = run(layout, [named("ArrowRight")], atMu);
      expect(before).toMatchObject({ focus: owner, side: "L", caret: null });
      expect(run(layout, [named("ArrowRight")], before)).toMatchObject({ focus: [...owner, 0], side: "L" });
      expect(run(layout, [named("ArrowLeft")], before)).toMatchObject({ focus: atMu.focus, side: atMu.side, caret: atMu.caret });
    }
  });

  describe("reading-order edit goldens", () => {
    const a = ident("a"), b = ident("b"), c = ident("c"), d = ident("d");
    const empty = () => ({ type: "Placeholder" });
    const plus = (left: Node, right: Node) => ({ type: "Add", left, right, split: false });
    const juxt = (left: Node, right: Node) => ({ type: "Juxt", left, right });
    const fraction = { type: "Div", left: a, right: b };
    const power = { type: "Pow", left: a, right: b };
    const index = { type: "Index", base: a, indices: [b] };
    const call = { type: "Call", callee: a, args: [b, c].map(expr => ({ type: "Expr", expr })) };
    const bounds = { lo: a, hi: b };
    const fixtures: { expr: Node; left?: boolean; right?: boolean; names?: number[]; paths?: number[][]; unwrap?: boolean }[] = [
      { expr: { type: "Paren", expr: a }, unwrap: true },
      { expr: { type: "Abs", expr: a }, unwrap: true },
      { expr: { type: "Neg", expr: a }, right: false, unwrap: true },
      { expr: { type: "Factorial", expr: a }, left: false, unwrap: true },
      { expr: fraction },
      { expr: power, left: false },
      { expr: index, left: false },
      { expr: call, left: false },
      { expr: { type: "Root", index: a, radicand: b } },
      { expr: { type: "Matrix", rows: 2, cols: 1, cells: [a, b] } },
      { expr: { type: "Integral", bounds, body: c, var: d }, names: [3] },
      { expr: { type: "Sum", var: a, bounds: { lo: b, hi: c, glyph: "equals" }, body: d } },
      { expr: { type: "Prod", var: a, bounds: null, body: b } },
      { expr: { type: "Deriv", var: a, order: b, body: c }, names: [0] },
      { expr: { type: "Partial", var: a, order: null, body: b }, names: [0] },
      { expr: { type: "Gradient", vars: [a, b], body: c }, names: [0, 1] },
      { expr: { type: "Limit", var: a, target: b, side: "both", body: c }, names: [0] },
      { expr: { type: "Program", body: [a, b].map(expr => ({ type: "ExprStmt", expr })) }, paths: [[0, 0], [1, 0]] },
    ];
    it.each(fixtures)("walks and edits every gap of $expr.type", ({ expr, left = true, right = true, names = [], paths, unwrap }) => {
      const root = { type: "ExprRegion", expr };
      const slots = paths ?? childRefs(expr).map((_, i) => [i]);
      type Case = { path: number[]; side: "L" | "R"; plus: Node; back: Node; del: Node };
      const steps: Case[] = [];
      if (left) steps.push({ path: [], side: "L", plus: plus(empty(), expr), back: expr, del: unwrap ? a : expr });
      slots.forEach((path, i) => {
        const value = get(expr, path);
        const erased = set(expr, path, empty());
        let leftEdit = !left && i === 0 ? plus(empty(), expr)
          : names.includes(i) ? expr : set(expr, path, plus(empty(), value));
        let rightEdit = names.includes(i) ? expr : set(expr, path, plus(value, empty()));
        if (expr.type === "Neg") leftEdit = plus({ ...expr, expr: empty() }, a);
        if (expr.type === "Factorial") rightEdit = plus(a, { ...expr, expr: empty() });
        if (expr === power && i === 0) rightEdit = plus(a, { ...power, left: empty() });
        if (expr === index && i === 0) rightEdit = plus(a, { ...index, base: empty() });
        if ((expr === call && i === 0) || expr.type === "Neg") rightEdit = plus(expr, empty());
        const binaryGap = (expr === fraction || expr === power) ? juxt(juxt(a, empty()), b) : null;
        const mergedCall = { ...call, args: [{ type: "Expr", expr: ident("bc") }] };
        const back = left && unwrap && i === 0 ? a
          : binaryGap && i === 1 ? binaryGap : expr === call && i === 2 ? mergedCall : expr;
        const del = right && unwrap && i === slots.length - 1 ? a
          : binaryGap && i === 0 ? binaryGap : expr === call && i === 1 ? mergedCall : expr;
        steps.push({ path, side: "L", plus: leftEdit, back, del: erased });
        steps.push({ path, side: "R", plus: rightEdit, back: erased, del });
      });
      if (right) steps.push({ path: [], side: "R", plus: plus(expr, empty()), back: unwrap ? a : expr, del: expr });

      const address = (step: Case) => ({ focus: [0, ...step.path], side: step.side });
      let state = focusAt(root, address(steps[0]).focus, "L");
      steps.forEach((step, i) => {
        expect(state).toMatchObject(address(step));
        const position = `${expr.type} gap ${i} (${step.side} of ${step.path})`;
        expect(run(layout, [t("+")], state).root.expr, position + " +").toMatchObject(step.plus);
        expect(run(layout, [named("Backspace")], state).root.expr, position + " Backspace").toMatchObject(step.back);
        expect(run(layout, [named("Delete")], state).root.expr, position + " Delete").toMatchObject(step.del);
        if (i + 1 < steps.length) state = run(layout, [named("ArrowRight")], state);
      });
      expect(sameCursor(run(layout, [named("ArrowRight")], state), state)).toBe(true);
      for (let i = steps.length - 1; i >= 0; i--) {
        expect(state).toMatchObject(address(steps[i]));
        if (i > 0) state = run(layout, [named("ArrowLeft")], state);
      }
      expect(sameCursor(run(layout, [named("ArrowLeft")], state), state)).toBe(true);
    });

    it("moves and deletes the same grapheme inside a string", () => {
      const root = { type: "ExprRegion", expr: { type: "Str", text: "é👩‍🔬" } };
      const end = focusAt(root, [0], "R");
      const beforeEmoji = run(layout, [named("ArrowLeft")], end);
      expect(beforeEmoji.caret).toEqual({ seg: 0, offset: 1 });
      expect(run(layout, [named("Delete")], beforeEmoji).root.expr.text).toBe("é");
      expect(run(layout, [named("Backspace")], end).root.expr.text).toBe("é");
    });

    it("re-reads both sides of an infix splice and splits text at the caret", () => {
      const sum = run(layout, [t("a*b+c")]);
      const beforeMultiply = focusAt(sum.root, [0, 0, 0], "R");
      expect(ast(run(layout, [t("+")], beforeMultiply))).toBe("(+ (+ a (· □ b)) c)");
      const name = run(layout, [t("ab"), named("ArrowLeft"), t("+")]);
      expect(ast(name)).toBe("(+ a b)");
    });
  });

  it("keeps a stored break before a whole right side while that side is edited", () => {
    // A region reopened with its break before `a + b`: the break precedes the compound node.
    const committed = run(layout, [t("x:a+b")]);
    expect(ast(committed)).toBe("(:= x (+ a b))");
    const reopened = initialState(committed.root, [{ path: [1] }]);
    const b = leafPaths(reopened.root).find((path) => sexpr(get(reopened.root, path)) === "b")!;
    const atB = placeCaret(reopened, b, "R", { seg: 0, offset: 1 });
    const typedZ = run(layout, [t("z")], atB);
    expect(ast(typedZ)).toBe("(:= x (+ a bz))");
    expect(breakWires(typedZ.root, typedZ.breaks)).toEqual([{ path: [1] }]);
    const erased = run(layout, [named("Backspace")], atB);
    expect(breakWires(erased.root, erased.breaks)).toEqual([{ path: [1] }]);
    const product = run(layout, [t("*2")], atB);
    expect(ast(product)).toBe("(:= x (+ a (· b 2)))");
    expect(breakWires(product.root, product.breaks)).toEqual([{ path: [1] }]);
  });

  it("Enter after an operator breaks a program line; Shift+Enter is always a new program line", () => {
    const shiftEnter = named("Enter", { shiftKey: true });
    const base = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("a+")]);
    expect(ast(base)).toBe("(:= (call f n) (program (← s (+ a □)) □))");
    // Enter right after the operator breaks the line, it does not start a program line.
    const entered = handleKey(base, named("Enter")).state;
    expect(ast(entered)).toBe("(:= (call f n) (program (← s (+↵ a □)) □))");
    // Backspace at the start of the continuation joins the line again.
    expect(ast(handleKey(entered, named("Backspace")).state)).toBe("(:= (call f n) (program (← s (+ a □)) □))");
    // Shift+Enter between two tokens is a new program line below, not an explicit break; the ribbon's
    // Line Break still breaks there.
    const withB = run(layout, [t("b")], base);
    const afterA = placeCaret(withB, leafPaths(withB.root).find((path) => sexpr(get(withB.root, path)) === "a")!, "R");
    const below = handleKey(afterA, shiftEnter).state;
    expect(ast(below)).toBe("(:= (call f n) (program (← s (+ a b)) □ □))");
    expect(below.breaks).toHaveLength(0);
    const broken = runCommand(afterA, "insertLineBreak");
    expect(ast(broken)).toBe("(:= (call f n) (program (← s (+ a b)) □))");
    expect(broken.breaks).toHaveLength(1);
    // At the end of the line it is still a new program line.
    const end = handleKey(withB, shiftEnter).state;
    expect(ast(end)).toBe("(:= (call f n) (program (← s (+ a b)) □ □))");
    expect(end.breaks).toHaveLength(0);
  });

  it("programs: else if and else attach to the preceding if; try, break, return", () => {
    let s = run(layout, [t("x:"), charKey("]", layout), t("a"), charKey("}", layout), t("1"), named("ArrowDown")]);
    expect(ast(s)).toBe("(:= x (program (if (if a 1)) □))");
    s = run(layout, [c.elseIf, t("b"), named("Tab"), t("2")], s);
    expect(ast(s)).toBe("(:= x (program (if (if a 1) (elseif b 2))))");
    const withElse =
      layout === "en-US"
        ? run(layout, [named("End"), ENTER, c.else, t("3")], s)
        : run(layout, [named("End"), ENTER, t("else"), c.wordOp, t("3")], s);
    // End is inside the elseif body; Enter adds a line there, else then attaches to the if.
    expect(ast(withElse)).toBe("(:= x (program (if (if a 1) (elseif b 2) (else 3))))");
    expect(ast(run(layout, [t("x:"), charKey("]", layout), t("g(a)"), c.try, t("0")]))).toBe(
      "(:= x (program (try ((call g a)) (0)) □))",
    );
    expect(ast(run(layout, [t("x:"), charKey("]", layout), c.break]))).toBe("(:= x (program break □))");
    expect(ast(run(layout, [t("x:"), charKey("]", layout), t("y"), c.return]))).toBe("(:= x (program (return y) □))");
  });

  it("navigation: Home, End, arrows, Tab, Shift+arrows", () => {
    let s = run(layout, [t("ab+cd")]);
    s = run(layout, [named("Home")], s);
    expect(selected(s)).toBe("ab");
    expect(s.caret).toEqual({ seg: 0, offset: 0 });
    s = run(layout, [named("ArrowRight"), named("ArrowRight"), named("ArrowRight")], s);
    expect(selected(s)).toBe("cd");
    s = run(layout, [named("End")], s);
    // End puts the insertion line after the whole expression, not inside its last operand.
    expect(selected(s)).toBe("(+ ab cd)");
    expect(s.side).toBe("R");
    expect(s.caret).toBeNull();
    const p = run(layout, [t("a+"), named("Tab")]);
    expect(selected(p)).toBe("□");
    // Shift+Left moves as Left does, selecting: first `c`, then `b·c`.
    const g = run(layout, [t("a+b*c"), named("ArrowLeft", { shiftKey: true })]);
    expect(selected(g)).toBe("c");
    expect(selected(run(layout, [named("ArrowLeft", { shiftKey: true })], g))).toBe("(· b c)");
  });

  it("draws the free end of a Shift selection at the edge of what it selects and collapses at its anchor", () => {
    const start = run(layout, [t("abcd")]);
    const extend = named("ArrowLeft", { shiftKey: true });
    const retract = named("ArrowRight", { shiftKey: true });
    // One press selects the whole name; the insertion line is at its left edge, not inside it.
    const one = run(layout, [extend], start);
    expect(selected(one)).toBe("abcd");
    expect(one.shiftDrag?.end.caret?.offset).toBe(0);
    expect(one.shiftDrag?.anchor.caret?.offset).toBe(4);
    // Nothing more to the left: the selection stays.
    expect(sameCursor(run(layout, [extend], one), one)).toBe(true);
    // Back the other way the selection collapses to the caret at the anchor.
    expect(sameCursor(run(layout, [retract], one), start)).toBe(true);
    // In a sum the free end jumps whole operands, drawn at the edge of the selection.
    const sum = run(layout, [t("a+bc+d")]);
    const two = run(layout, [extend, extend], sum);
    expect(sexpr(selectedNode(two))).toBe("(+ bc d)");
    const first = run(layout, [extend], sum);
    expect(selected(first)).toBe("d");
    expect(first.shiftDrag?.end.focus).toEqual(first.focus);
  });


  it("Home inside a program goes to the start of the current line", () => {
    const HOME = named("Home");
    const DOWN = named("ArrowDown");

    // On a local-definition line Home goes to that line's target, not the worksheet definition.
    const local = run(layout, [t("f(n):"), charKey("]", layout), t("s"), charKey("{", layout), t("0")]);
    let atHome = run(layout, [HOME], local);
    expect(selected(atHome)).toBe("s");
    expect(atHome.caret).toEqual({ seg: 0, offset: 0 });

    // The following ordinary expression line has its own start.
    const expressionLine = run(layout, [DOWN, t("x+y"), HOME], local);
    expect(selected(expressionLine)).toBe("x");
    expect(expressionLine.caret).toEqual({ seg: 0, offset: 0 });

    // In a nested body the innermost line wins.
    const nested = run(layout, [t("z:"), charKey("]", layout), t("a+b"), charKey("}", layout), t("p+q")]);
    atHome = run(layout, [HOME], nested);
    expect(selected(atHome)).toBe("p");
    expect(atHome.caret).toEqual({ seg: 0, offset: 0 });

    // In the control header Home goes to its first editable token, not to the outer definition.
    const conditionB = leafPaths(nested.root).find((path) => sexpr(get(nested.root, path)) === "b")!;
    const inHeader = placeCaret(nested, conditionB, "R");
    atHome = run(layout, [HOME], inHeader);
    expect(selected(atHome)).toBe("a");
    expect(atHome.caret).toEqual({ seg: 0, offset: 0 });
  });

  it("End goes to the structural end of the full expression", () => {
    const ended = (start: EditorState) => run(layout, [named("Home"), named("End")], start);

    // A plain expression: the whole sum is at the end, so typing continues after it.
    const sum = ended(run(layout, [t("ab+cd")]));
    expect(selected(sum)).toBe("(+ ab cd)");
    expect(sum.side).toBe("R");
    expect(ast(run(layout, [t("+1")], sum))).toBe("(+ (+ ab cd) 1)");

    // An exponent: after the whole power, not inside the exponent slot.
    const power = ended(run(layout, [t("x^2")]));
    expect(selected(power)).toBe("(^ x 2)");
    expect(ast(run(layout, [t("+1")], power))).toBe("(+ (^ x 2) 1)");

    // A fraction: after the denominator, not inside it.
    const fraction = ended(run(layout, [t("a/b")]));
    expect(selected(fraction)).toBe("(/ a b)");
    expect(ast(run(layout, [t("+1")], fraction))).toBe("(+ (/ a b) 1)");

    // Parentheses: after the closing parenthesis, so the product applies to the whole group.
    const paren = ended(run(layout, [t("(a+b)")]));
    expect(selected(paren)).toBe("(paren (+ a b))");
    expect(ast(run(layout, [t("+1")], paren))).toBe("(+ (paren (+ a b)) 1)");

    // A definition: the end of its right-hand side, not of the name.
    const definition = ended(run(layout, [t("x:1+2")]));
    expect(definition.focus).toEqual([1]);
    expect(ast(run(layout, [t("+1")], definition))).toBe("(:= x (+ (+ 1 2) 1))");

    // A matrix: the right edge of the whole matrix, so typing continues after it.
    let matrix = insertMatrixSized(initialState(), 1, 2);
    matrix = run(layout, [t("1"), named("Tab"), t("2"), named("End")], matrix);
    expect(matrix.focus).toEqual([0]);
    expect(matrix.side).toBe("R");
    expect(ast(run(layout, [t("+1")], matrix))).toBe("(+ (matrix 1×2 1 2) 1)");

    // A single name is a leaf: End keeps the caret at its end.
    const name = ended(run(layout, [t("ab")]));
    expect(selected(name)).toBe("ab");
    expect(name.caret).toEqual({ seg: 0, offset: 2 });
  });

  it("Backspace deletes characters, then the operator owning an empty placeholder", () => {
    let s = run(layout, [t("ab+c")]);
    s = run(layout, [named("Backspace")], s);
    expect(ast(s)).toBe("(+ ab □)");
    s = run(layout, [named("Backspace")], s);
    expect(ast(s)).toBe("ab");
    expect(selected(s)).toBe("ab");
    expect(ast(run(layout, [t("x:"), named("Backspace")]))).toBe("x");
  });

  it("in-editor undo and redo", () => {
    let s = run(layout, [t("a+b")]);
    s = run(layout, [c.undo], s);
    expect(ast(s)).toBe("(+ a □)");
    s = run(layout, [c.undo], s);
    expect(ast(s)).toBe("a");
    s = run(layout, [c.redo], s);
    expect(ast(s)).toBe("(+ a □)");
  });

  it("inserts palette text as one undo step", () => {
    let s = typeText(initialState(), "mol");
    expect(ast(s)).toBe("mol");
    s = run(layout, [c.undo], s);
    expect(isEmptyStatement(s.root)).toBe(true);
  });

  it("calculus templates and postfix operators", () => {
    expect(ast(run(layout, [c.sum, t("k"), named("Tab"), t("1"), named("Tab"), t("n"), named("Tab"), t("k")]))).toBe(
      "(∑ k 1 n k)",
    );
    expect(ast(run(layout, [t("x^2"), SPACE, c.deriv, t("x")]))).toBe("(ⅆ x (^ x 2))");
    expect(ast(run(layout, [t("M"), c.transpose]))).toBe("(ᵀ M)");
    expect(ast(run(layout, [t("n!")]))).toBe("(! n)");
    expect(ast(run(layout, [t("a"), c.inlineDiv, t("b")]))).toBe("(÷ a b)");
    expect(ast(run(layout, [t("a"), c.addBreak, t("b")]))).toBe("(+↵ a b)");
  });

  it("keeps an index-only sum and the conditions of the lower slot", () => {
    // Both bounds left empty: no bounds at all, the sum over the range variable.
    // While editing they stay as the grey placeholders to fill, but the wire form the region is
    // committed from carries no bounds, so the saved linear text is `∑[i] i`.
    const indexOnly = run(layout, [c.sum, t("i"), named("Tab"), named("Tab"), named("Tab"), t("i")]);
    expect(ast(indexOnly)).toBe("(∑ i □ □ i)");
    const indexWire = (toWire(indexOnly.root) as unknown as { expr: { bounds: unknown } }).expr;
    expect(indexWire.bounds).toBeNull();
    // One bound filled keeps the bounded form, the other slot still a placeholder.
    const bounded = run(layout, [c.sum, t("k"), named("Tab"), t("1")]);
    const boundedWire = (toWire(bounded.root) as unknown as { expr: { bounds: { lo: Node; hi: Node } } }).expr;
    expect(boundedWire.bounds.lo.type).toBe("Num");
    expect(boundedWire.bounds.hi.type).toBe("Placeholder");
    // A condition is any relation typed in the slot; it is kept as typed.
    const conditions: [string, string, string][] = [
      ["j<>k", "(≠ j k)", "Ne"],
      ["j<=k", "(≤ j k)", "Le"],
      ["j>=k", "(≥ j k)", "Ge"],
      ["j<k", "(< j k)", "Lt"],
      ["j>k", "(> j k)", "Gt"],
    ];
    for (const [keys, shown, head] of conditions) {
      const s = run(layout, [c.sum, t(keys), named("Tab"), named("Tab"), named("Tab"), t("j")]);
      expect(ast(s)).toBe(`(∑ ${shown} □ □ j)`);
      const wire = (
        toWire(s.root) as unknown as {
          expr: { bounds: unknown; index: { type: string }; var: { name: { segments: { text: string }[] } } };
        }
      ).expr;
      expect(wire.index.type).toBe(head);
      expect(wire.var.name.segments[0].text).toBe("");
      // With both bounds empty the condition has no bounds either: `∑[j ≠ k] j`.
      expect(wire.bounds).toBeNull();
    }
  });

  it("an integral with both bounds empty is the indefinite integral", () => {
    const integral = (lo: Node, hi: Node): Node => ({
      type: "ExprRegion",
      expr: { type: "Integral", var: ident("x"), bounds: { lo, hi }, algorithm: null, body: ident("f") },
    });
    const empty: Node = { type: "Placeholder" };
    const wire = (root: Node) => (toWire(root) as unknown as { expr: { bounds: unknown } }).expr;
    // A new integral from the command starts with both bounds empty: committed as is, it is indefinite.
    const fresh = runCommand(run(layout, [t("f")]), "integral");
    expect(get(fresh.root, [0]).type).toBe("Integral");
    expect(wire(integral(empty, empty)).bounds).toBeNull();
    expect(wire(integral(ident("a"), ident("b"))).bounds).not.toBeNull();
    // One bound filled and the other empty keeps its bounds: the region stays incomplete.
    expect(wire(integral(ident("a"), empty)).bounds).not.toBeNull();
  });

  it("preserves an empty integral variable and offers bounds again when reopened", () => {
    const empty: Node = { type: "Placeholder" };
    const draft: Node = { type: "ExprRegion", expr: { type: "Integral", var: empty, bounds: { lo: empty, hi: empty }, algorithm: null, body: empty } };
    const wire = toWire(draft);
    const reopened = withIntegralBoundSlots(toEditing(wire));
    expect(get(reopened, [0, 3]).type).toBe("Placeholder");
    expect(get(reopened, [0, 0]).type).toBe("Placeholder");
    expect(toWire(reopened)).toEqual(wire);
    const withBounds: Node = { ...reopened, expr: { ...reopened.expr, var: ident("x"), bounds: { lo: ident("a"), hi: ident("b") } } };
    expect((toWire(withBounds).expr as Node).bounds).not.toBeNull();
    const removed: Node = { ...withBounds, expr: { ...withBounds.expr, bounds: { lo: empty, hi: empty } } };
    expect((toWire(removed).expr as Node).bounds).toBeNull();
  });

  it("round-trips empty binders in other incomplete constructs", () => {
    const empty: Node = { type: "Placeholder" };
    for (const type of ["Sum", "Prod", "Deriv", "Partial", "Limit", "For"]) {
      const construct: Node = type === "For"
        ? { type, var: empty, source: empty, body: [{ type: "ExprStmt", expr: empty }] }
        : { type, var: empty, bounds: null, body: empty, ...(type === "Limit" ? { target: empty, side: "both" } : {}) };
      const root: Node = { type: "ExprRegion", expr: type === "For" ? { type: "Program", body: [construct] } : construct };
      const wire = toWire(root);
      const reopened = toEditing(wire);
      const restored = type === "For" ? reopened.expr.body[0] : reopened.expr;
      expect(restored.var.type, type).toBe("Placeholder");
    }
    const symbolic: Node = { type: "Symbolic", expr: ident("x"), keywords: [{ type: "KeywordGroup", keyword: empty, args: [ident("x")] }] };
    expect(toEditing(toWire(symbolic)).keywords[0].keyword.type).toBe("Placeholder");
  });

  it("round-trips placeholder targets and function parameter slots", () => {
    const empty: Node = { type: "Placeholder" };
    const targets: Node[] = [empty, { type: "Matrix", rows: 1, cols: 2, cells: [ident("x"), empty] },
      { type: "Call", callee: ident("f"), args: [{ type: "Expr", expr: empty }] },
      { type: "Call", callee: empty, args: [{ type: "Expr", expr: ident("x") }] }];
    for (const target of targets) {
      const root: Node = { type: "Define", target, rhs: ident("x"), tail: null };
      expect(toEditing(toWire(root))).toEqual(root);
    }
  });

  it("remaps hits through nested indefinite integrals when bounds are made editable", () => {
    const integral = (body: Node, v: string): Node => ({ type: "Integral", var: ident(v), bounds: null, algorithm: null, body });
    const root: Node = { type: "ExprRegion", expr: integral(integral(ident("f"), "y"), "x") };
    const expanded = withIntegralBoundSlots(root);
    for (const path of [[0, 0, 0], [0, 0, 1], [0, 1]]) {
      const mapped = remapIntegralBoundHit(root, path);
      expect(get(expanded, mapped)).toEqual(get(root, path));
    }
    expect(remapIntegralBoundHit(root, [0, 0, 0])).toEqual([0, 2, 2]);
    expect(remapIntegralBoundHit(root, [0, 0, 1])).toEqual([0, 2, 3]);
    expect(remapIntegralBoundHit(root, [0, 1])).toEqual([0, 3]);
    const wireBreak = { path: [0, 0, 0], offset: 1 };
    const editor = initialState(expanded, [{ ...wireBreak, path: [...remapIntegralBoundHit(root, wireBreak.path)] }]);
    expect(breakWires(editor.root, editor.breaks)).toEqual([wireBreak]);
  });

  it("strings take every character until the closing quote", () => {
    const s = run(layout, [charKey('"', layout), t("a b+c"), charKey('"', layout)]);
    expect(ast(s)).toBe('"a b+c"');
    expect(s.caret).toBeNull();
  });

  it("Enter and Escape are window commands (leave the region)", () => {
    const s = run(layout, [t("x")]);
    const enter = handleKey(s, ENTER);
    expect(enter.handled).toBe(false);
    expect(enter.action).toEqual({ kind: "command", cmd: "exitRegion" });
    expect(handleKey(s, named("Escape")).action).toEqual({ kind: "command", cmd: "leaveRegion" });
  });

  it("Ctrl+M inserts a 1×1 matrix of one placeholder at the caret, wrapping an operand as its first cell", () => {
    const CTRL_M = ctrl("KeyM", "m");
    const empty = run(layout, [CTRL_M]);
    expect(ast(empty)).toBe("(matrix 1×1 □)");
    expect(get(empty.root, empty.focus).type).toBe("Placeholder");
    const grown = run(layout, [named("Enter", { shiftKey: true })], empty);
    expect(ast(grown)).toBe("(matrix 2×1 □ □)");
    expect(ast(run(layout, [t("x"), CTRL_M]))).toBe("(matrix 1×1 x)");
    expect(ast(run(layout, [t("a+b"), CTRL_M]))).toBe("(+ a (matrix 1×1 b))");
  });
});

describe("Italian-specific keys", () => {
  it("AltGr+è gives [ (index) and never fires the Ctrl+è binding (else if)", () => {
    const s = run("it-IT", [typed("v", "it-IT"), { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true }, typed("i", "it-IT")]);
    expect(ast(s)).toBe("(index v i)");
  });

  it("honours getModifierState('AltGraph')", () => {
    const s = run("it-IT", [typed("v", "it-IT"), { key: "[", code: "BracketLeft", ctrlKey: true, altKey: true, altGraph: true }]);
    expect(ast(s)).toBe("(index v □)");
  });

  it("the same physical key means the action of the character it types", () => {
    const s = run("en-US", [typed("x:", "en-US")]);
    expect(handleKey(s, ctrl("BracketRight", "]")).action).toEqual({ kind: "command", cmd: "while" });
    expect(handleKey(s, ctrl("BracketRight", "+")).action).toEqual({ kind: "command", cmd: "addBreak" });
    expect(handleKey(s, ctrl("Minus", "-")).action).toEqual({ kind: "command", cmd: "literalSubscript" });
    expect(handleKey(s, ctrl("Minus", "'")).action).toEqual({ kind: "command", cmd: "primeDeriv" });
  });
});

describe("clicks and the wire form", () => {
  it("a click places the caret before or after the clicked name", () => {
    const s = run("en-US", [typed("ab+cd", "en-US")]);
    const left = placeCaret(s, [0, 0], "L");
    expect(left.caret).toEqual({ seg: 0, offset: 0 });
    expect(placeCaret(s, [0, 1], "R", { seg: 0, offset: 1 }).caret).toEqual({ seg: 0, offset: 1 });
  });

  it("converts targets and binders to the editing form and back", () => {
    const wire = {
      type: "Define",
      span: { start: 0, end: 9 },
      target: { type: "FunctionHead", name: { name: { segments: [{ text: "f", subscript: false }] } }, params: [{ name: { segments: [{ text: "x", subscript: false }] } }] },
      rhs: {
        type: "Sum",
        var: { name: { segments: [{ text: "k", subscript: false }] } },
        bounds: { lo: { type: "Num", text: "0" }, hi: { type: "Ident", name: { segments: [{ text: "x", subscript: false }] } } },
        body: { type: "Ident", name: { segments: [{ text: "k", subscript: false }] } },
      },
      tail: null,
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(:= (call f x) (∑ k 0 x k))");
    const back = toWire(editing);
    expect(back.target.type).toBe("FunctionHead");
    expect(back.rhs.var).toEqual({ name: { segments: [{ text: "k", subscript: false }] } });
  });

  it("converts a program's local function definition to the editing form and back", () => {
    // A local definition may define a function, so its target converts
    // like the left side of a worksheet definition instead of being refused.
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const wire = {
      type: "Define",
      target: { type: "FunctionHead", name: { name: name("Z") }, params: [] },
      rhs: {
        type: "Program",
        body: [
          {
            type: "LocalDef",
            target: { type: "FunctionHead", name: { name: name("g") }, params: [{ name: name("x") }] },
            rhs: { type: "Add", left: { type: "Ident", name: name("x") }, right: { type: "Num", text: "1" }, split: false },
          },
          { type: "ExprStmt", expr: { type: "Call", callee: { type: "Ident", name: name("g") }, args: [{ type: "Expr", expr: { type: "Num", text: "2" } }] } },
        ],
      },
      tail: null,
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(:= (call Z) (program (← (call g x) (+ x 1)) (call g 2)))");
    const back = toWire(editing) as unknown as {
      rhs: { body: { target: { type: string; params: { name: { segments: { text: string }[] } }[] } }[] };
    };
    expect(back.rhs.body[0].target.type).toBe("FunctionHead");
    expect(back.rhs.body[0].target.params[0].name.segments[0].text).toBe("x");
  });

  it("keeps a nested destructuring target through the editing form", () => {
    // A cell of a destructuring matrix may itself be a matrix, so the
    // editor holds it as a matrix inside a matrix and gives the target back on the way out.
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const cell = (text: string) => ({ type: "Ident", name: name(text) });
    const wire = {
      type: "Define",
      target: {
        type: "Destructure",
        rows: 2,
        cols: 2,
        cells: [
          cell("A11"),
          { type: "Destructure", rows: 2, cols: 1, cells: [cell("A211"), cell("A212")] },
          cell("A12"),
          cell("A22"),
        ],
      },
      rhs: {
        type: "Call",
        callee: { type: "Ident", name: name("f") },
        args: [{ type: "Expr", expr: cell("x") }],
      },
      tail: null,
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(:= (matrix 2×2 A11 (matrix 2×1 A211 A212) A12 A22) (call f x))");
    const back = toWire(editing) as unknown as { target: { type: string; cells: { type: string }[] } };
    expect(back.target.type).toBe("Destructure");
    expect(back.target.cells[1].type).toBe("Destructure");
  });

  it("keeps a destructuring inline argument through the editing form", () => {
    // The target of an inline argument definition is a target, a matrix included; its
    // value is the argument, so nothing is bound and the value passes through untouched.
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const wire = {
      type: "ExprRegion",
      expr: {
        type: "Call",
        callee: { type: "Ident", name: name("f") },
        args: [
          { type: "Expr", expr: { type: "Ident", name: name("a") } },
          {
            type: "InlineDef",
            target: {
              type: "Destructure",
              rows: 1,
              cols: 2,
              cells: [{ type: "Ident", name: name("x") }, { type: "Ident", name: name("y") }],
            },
            value: {
              type: "Matrix",
              rows: 1,
              cols: 2,
              cells: [{ type: "Num", text: "1" }, { type: "Num", text: "2" }],
            },
          },
        ],
      },
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(call f a (← (matrix 1×2 x y) (matrix 1×2 1 2)))");
    const back = toWire(editing) as unknown as {
      expr: { args: { type: string; target?: { type: string } }[] };
    };
    expect(back.expr.args[1].type).toBe("InlineDef");
    expect(back.expr.args[1].target?.type).toBe("Destructure");
  });

  it("keeps an imported matrix ellipsis cell through the editing form", () => {
    const wire = {
      type: "ExprRegion",
      expr: {
        type: "Matrix",
        rows: 1,
        cols: 2,
        cells: [{ type: "Num", text: "1" }, { type: "EllipsisCell", form: "horizontal" }],
      },
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(matrix 1×2 1 (⋯))");
    // The cell holds no slot to type into and keeps its direction on the way back.
    const back = toWire(editing) as unknown as { expr: { cells: { type: string; form?: string }[] } };
    expect(back.expr.cells[1]).toEqual({ type: "EllipsisCell", form: "horizontal" });
  });

  it("keeps an imported percent through the editing form", () => {
    const wire = {
      type: "ExprRegion",
      expr: { type: "Percent", expr: { type: "Num", text: "3.4" } },
    };
    const editing = toEditing(wire);
    expect(sexpr(editing)).toBe("(% 3.4)");
    // The operand is a slot to type into and the sign comes back with it.
    expect(childRefs(editing.expr).length).toBe(1);
    const back = toWire(editing) as unknown as { expr: { type: string; expr: { type: string } } };
    expect(back.expr).toEqual({ type: "Percent", expr: { type: "Num", text: "3.4" } });
  });

  it("keeps any expression typed in the index slot of a sum, as a free slot", () => {
    const keys = (slot: string) => [CHORDS["en-US"].sum, typed(slot, "en-US"), named("Tab"), typed("1", "en-US"), named("Tab"), typed("n", "en-US"), named("Tab"), typed("j", "en-US")];
    for (const [slot, shown] of [["j!", "(! j)"], ["j<k", "(< j k)"]] as const) {
      const s = run("en-US", keys(slot));
      expect(sexpr(s.root)).toBe(`(∑ ${shown} 1 n j)`);
      const wire = (toWire(s.root) as unknown as { expr: { index: unknown; var: { name: { segments: { text: string }[] } } } }).expr;
      expect(wire.index).toBeTruthy();
      expect(wire.var.name.segments[0].text).toBe("");
    }
    // A plain name is still the variable, with no free slot.
    const plain = (toWire(run("en-US", keys("k")).root) as unknown as { expr: { index?: unknown } }).expr;
    expect(plain.index).toBeUndefined();
  });

  it("converts a free slot and the := glyph between the wire and the editing form", () => {
    const name = (text: string) => ({ segments: [{ text, subscript: false }], label: null });
    const wire = {
      type: "ExprRegion",
      expr: {
        type: "Sum",
        var: { name: name("") },
        index: { type: "Factorial", expr: { type: "Ident", name: name("j") } },
        bounds: { lo: { type: "Ident", name: name("k") }, hi: { type: "Placeholder" }, glyph: "define" },
        body: { type: "Ident", name: name("j") },
      },
    };
    const editing = toEditing(wire) as unknown as { expr: { var: { type: string }; index?: unknown } };
    expect(editing.expr.var.type).toBe("Factorial");
    expect(editing.expr.index).toBeUndefined();
    const back = toWire(editing as never) as unknown as { expr: { index: { type: string }; bounds: { glyph: string } } };
    expect(back.expr.index.type).toBe("Factorial");
    expect(back.expr.bounds.glyph).toBe("define");
  });

  it("rejects an incomplete definition with a user message", () => {
    const s = run("en-US", [typed("a+b:", "en-US")]);
    expect(() => toWire(s.root)).toThrow(WireError);
    expect(isEmptyStatement(initialState().root)).toBe(true);
  });
});

describe("symbolic keywords from the palette", () => {
  it("turns an expression into a symbolic evaluation and appends keywords and modifiers", () => {
    let s = typeText(initialState(), "x");
    s = insertSymbolicKeyword(s, "simplify");
    expect(sexpr(s.root)).toContain("simplify");
    expect(s.root.type).toBe("Symbolic");
    s = insertSymbolicKeyword(s, "assume");
    s = insertSymbolicKeyword(s, "real", true);
    const keywords = (s.root as unknown as { keywords: { keyword: { name: { segments: { text: string }[] } }; args: unknown[] }[] }).keywords;
    expect(keywords.map((k) => k.keyword.name.segments[0].text)).toEqual(["simplify", "assume"]);
    expect(keywords[1].args).toHaveLength(1);
  });

  it("ignores a modifier without a keyword and is one undo step", () => {
    let s = typeText(initialState(), "x");
    expect(insertSymbolicKeyword(s, "real", true).root.type).toBe("ExprRegion");
    s = insertSymbolicKeyword(s, "solve");
    s = runCommand(s, "undo");
    expect(s.root.type).toBe("ExprRegion");
  });
});

describe("the glyph of a sum's lower slot", () => {
  /** The glyph of the first `Sum` or `Prod` bounds in the wire form of the state. */
  const glyph = (s: EditorState): unknown => {
    const find = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return undefined;
      const node = value as Record<string, unknown>;
      if ((node.type === "Sum" || node.type === "Prod") && node.bounds) return (node.bounds as { glyph?: unknown }).glyph ?? "equals";
      for (const child of Object.values(node)) {
        const found = find(child);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return find(s.root);
  };

  it("toggles = and := between the index and its first value, one undo step each", () => {
    for (const template of ["sum", "prod"] as const) {
      let s = runCommand(typeText(initialState(), "x"), template);
      expect(glyph(s)).toBe("equals");
      s = runCommand(s, "toggleBoundGlyph");
      expect(glyph(s)).toBe("define");
      s = runCommand(s, "toggleBoundGlyph");
      expect(glyph(s)).toBe("equals");
      s = runCommand(s, "undo");
      expect(glyph(s)).toBe("define");
    }
  });

  it("does nothing outside a sum or product", () => {
    const s = typeText(initialState(), "x+1");
    expect(runCommand(s, "toggleBoundGlyph").root).toBe(s.root);
  });
});

describe.each(["en-US", "it-IT"] as const)("no bare Placeholder statement on %s", (layout) => {
  const c = CHORDS[layout];
  // Deterministic pseudo-random key sequences over programs, deletion and structure keys.
  const keys: KeyInput[] = [
    ...typed("ab1+", layout),
    named("Backspace"), named("Backspace"), named("Backspace"), named("Delete"), named("Delete"),
    named("Enter"), named("ArrowLeft"), named("ArrowRight"), named("ArrowUp"), named("ArrowDown"),
    named("Home"), named("End"), ENTER, SPACE, named("Tab"),
    c.while, c.for, c.try, c.elseIf, c.break, c.return, c.inlineDiv, c.sub, c.symbolic, c.boolEq,
    ctrl("KeyM", "m"), ctrl("KeyZ", "z"), ctrl("KeyX", "x"),
  ];
  it("holds after every key of 400 random sequences", () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 400; round++) {
      let s = initialState();
      const log: string[] = [];
      for (let step = 0; step < 14; step++) {
        const key = keys[Math.floor(next() * keys.length)];
        log.push(`${key.code}${key.ctrlKey ? "+ctrl" : ""}`);
        try {
          s = handleKey(s, key).state;
        } catch (error) {
          throw new Error(`key ${log.join(" ")} threw: ${String(error)}`);
        }
        try {
          assertNoBareStatements(s.root);
        } catch (error) {
          throw new Error(`after ${log.join(" ")}: ${String(error)}`);
        }
      }
    }
  });
});

describe("Enter breaks the line after an operator", () => {
  const layout: LayoutId = "en-US";
  const t = (text: string) => typed(text, layout);
  const LEFT = named("ArrowLeft");
  const BACKSPACE = named("Backspace");
  const press = (s: EditorState, key: KeyInput) => handleKey(s, key);

  it("right after + the operator gets its break and the editor stays open", () => {
    const s = run(layout, [t("a+")]);
    const enter = press(s, ENTER);
    expect(enter.handled).toBe(true);
    expect(ast(run(layout, [t("b")], enter.state))).toBe("(+↵ a b)");
  });

  it("works for -, · and in-line ÷, and before an operand already typed", () => {
    expect(ast(press(run(layout, [t("a-")]), ENTER).state)).toBe("(-↵ a □)");
    expect(ast(press(run(layout, [t("a*")]), ENTER).state)).toBe("(·↵ a □)");
    expect(ast(press(run(layout, [t("a"), CHORDS[layout].inlineDiv]), ENTER).state)).toBe("(÷↵ a □)");
    // The caret moved back to the start of `b`: still directly after the operator.
    const before = run(layout, [t("a+b"), LEFT]);
    const enter = press(before, ENTER);
    expect(enter.handled).toBe(true);
    expect(ast(enter.state)).toBe("(+↵ a b)");
  });

  it("Enter anywhere else leaves the region, and so does a second Enter after a broken operator", () => {
    const end = press(run(layout, [t("a+b")]), ENTER);
    expect(end.handled).toBe(false);
    expect(end.action).toEqual({ kind: "command", cmd: "exitRegion" });
    const broken = press(run(layout, [t("a+")]), ENTER).state;
    expect(press(broken, ENTER).handled).toBe(false);
  });

  it("Backspace at the start of the continuation line removes the break and keeps the operator", () => {
    const typedB = run(layout, [t("b"), LEFT], press(run(layout, [t("a+")]), ENTER).state);
    expect(ast(typedB)).toBe("(+↵ a b)");
    expect(ast(press(typedB, BACKSPACE).state)).toBe("(+ a b)");
  });

  it("breaks the innermost operator whose right operand starts at the caret", () => {
    // a + b·c with the caret before b: the right operand of + starts there, not of ·.
    const s = run(layout, [t("a+b*c"), LEFT, LEFT, LEFT]);
    const enter = press(s, ENTER);
    expect(enter.handled).toBe(true);
    expect(ast(enter.state)).toBe("(+↵ a (· b c))");
  });

  it("is one undo step", () => {
    const broken = press(run(layout, [t("a+")]), ENTER).state;
    expect(ast(runCommand(broken, "undo"))).toBe("(+ a □)");
  });
});

describe("Shift+Enter inserts a presentation line break", () => {
  const layout: LayoutId = "en-US";
  const t = (text: string) => typed(text, layout);
  const SHIFT_ENTER = named("Enter", { shiftKey: true });
  const press = (s: EditorState, key: KeyInput) => handleKey(s, key);

  it("breaks before the next token: a + b, caret after a", () => {
    const s = run(layout, [t("a+b")]);
    const afterA = placeCaret(s, [0, 0], "R");
    const broken = press(afterA, SHIFT_ENTER);
    expect(broken.handled).toBe(true);
    expect(ast(broken.state)).toBe("(+ a b)");
    expect(breakWires(broken.state.root, broken.state.breaks)).toEqual([{ path: [0, 1] }]);
  });

  it("breaks after an operator and after a comma", () => {
    const afterOperator = press(placeCaret(run(layout, [t("a+b")]), [0, 1], "L"), SHIFT_ENTER);
    expect(breakWires(afterOperator.state.root, afterOperator.state.breaks)).toEqual([{ path: [0, 1] }]);
    const afterComma = press(placeCaret(run(layout, [t("f(a,b)")]), [0, 2], "L"), SHIFT_ENTER);
    expect(breakWires(afterComma.state.root, afterComma.state.breaks)).toEqual([{ path: [0, 2] }]);
  });

  it("breaks after an assignment operator", () => {
    const s = placeCaret(run(layout, [t("x:y")]), [1], "L");
    const broken = press(s, SHIFT_ENTER);
    expect(breakWires(broken.state.root, broken.state.breaks)).toEqual([{ path: [1] }]);
    expect(ast(broken.state)).toBe("(:= x y)");
  });

  it("breaks inside a string without changing its value", () => {
    const s = placeCaret(run(layout, [t('"hello"')]), [0], "R", { seg: 0, offset: 2 });
    const broken = press(s, SHIFT_ENTER);
    expect(breakWires(broken.state.root, broken.state.breaks)).toEqual([{ path: [0], offset: 2 }]);
    expect((toWire(broken.state.root) as unknown as { expr: { text: string } }).expr.text).toBe("hello");
  });

  it("Backspace at the start of the continuation and Delete at the end of the previous line remove it", () => {
    const afterA = placeCaret(run(layout, [t("a+b")]), [0, 0], "R");
    const broken = press(afterA, SHIFT_ENTER).state;
    const b = placeCaret(broken, [0, 1], "L");
    expect(press(b, named("Backspace")).state.breaks).toHaveLength(0);
    const a = placeCaret(broken, [0, 0], "R");
    expect(press(a, named("Delete")).state.breaks).toHaveLength(0);
    // Backspace at the end of the previous line deletes math, not the break.
    expect(press(a, named("Backspace")).state.breaks).toHaveLength(1);
  });

  it("Backspace at the start of a continuation line that starts with a compound operand removes the break", () => {
    // a + b·c with the break before b·c: the caret at the start of the line is on the first leaf, b.
    const onMul = placeCaret(run(layout, [t("a+b*c")]), [0, 1], "L");
    const brokenMul = press(onMul, SHIFT_ENTER).state;
    expect(brokenMul.breaks).toHaveLength(1);
    const atStart = placeCaret(brokenMul, [0, 1, 0], "L");
    const joined = press(atStart, named("Backspace")).state;
    expect(joined.breaks).toHaveLength(0);
    expect(ast(joined)).toBe("(+ a (· b c))");
  });

  it("survives typing after the break: a := 5 + Shift+Enter, then 3", () => {
    const broken = press(run(layout, [t("a:5+")]), SHIFT_ENTER);
    expect(ast(broken.state)).toBe("(:= a (+ 5 □))");
    expect(breakWires(broken.state.root, broken.state.breaks)).toEqual([{ path: [1, 1] }]);
    // Typing fills the placeholder: the break must follow the node that takes its place.
    const typed = run(layout, [t("3")], broken.state);
    expect(ast(typed)).toBe("(:= a (+ 5 3))");
    expect(breakWires(typed.root, typed.breaks)).toEqual([{ path: [1, 1] }]);
  });

  it("keeps a string break while the rest of the string is typed", () => {
    const broken = press(run(layout, [t('"he')]), SHIFT_ENTER);
    expect(breakWires(broken.state.root, broken.state.breaks)).toEqual([{ path: [0], offset: 2 }]);
    const typed = run(layout, [t("llo")], broken.state);
    expect(breakWires(typed.root, typed.breaks)).toEqual([{ path: [0], offset: 2 }]);
    expect((toWire(typed.root) as unknown as { expr: { text: string } }).expr.text).toBe("hello");
    // Closing the string keeps the break too.
    const closed = run(layout, [t('"')], typed);
    expect(breakWires(closed.root, closed.breaks)).toEqual([{ path: [0], offset: 2 }]);
  });

  it("keeps a string break in place when typing on the continuation line, and moves it with text before it", () => {
    const broken = press(placeCaret(run(layout, [t('"hello"')]), [0], "R", { seg: 0, offset: 2 }), SHIFT_ENTER);
    // Typing at the break keeps the new character on the continuation line.
    const atBreak = run(layout, [t("X")], broken.state);
    expect(breakWires(atBreak.root, atBreak.breaks)).toEqual([{ path: [0], offset: 2 }]);
    expect((toWire(atBreak.root) as unknown as { expr: { text: string } }).expr.text).toBe("heXllo");
    // Typing before the break moves it with the text it now precedes.
    const before = run(layout, [t("X")], placeCaret(broken.state, [0], "R", { seg: 0, offset: 1 }));
    expect(breakWires(before.root, before.breaks)).toEqual([{ path: [0], offset: 3 }]);
    expect((toWire(before.root) as unknown as { expr: { text: string } }).expr.text).toBe("hXello");
  });

  it("keeps a break through a symbolic solve: a + Shift+Enter 5 = 8, solve for a", () => {
    const s = run(layout, [
      t("a+"),
      SHIFT_ENTER,
      t("5"),
      CHORDS[layout].boolEq,
      t("8"),
      CHORDS[layout].symbolic,
      t("solve"),
      t(","),
      t("a"),
    ]);
    expect(ast(s)).toBe("(→ (== (+ a 5) 8) (kw solve a))");
    expect(breakWires(s.root, s.breaks)).toEqual([{ path: [0, 0, 1] }]);
    // The break is presentation only: the wire statement is exactly the one without it.
    expect(toWire(s.root)).toEqual(toWire(run(layout, [t("a+5"), CHORDS[layout].boolEq, t("8"), CHORDS[layout].symbolic, t("solve"), t(","), t("a")]).root));
  });

  it("does not add a second break where the operator's equation break already breaks", () => {
    const split = runCommand(placeCaret(run(layout, [t("a+b")]), [0], "L"), "toggleBreak");
    const broken = press(placeCaret(split, [0, 1], "L"), SHIFT_ENTER);
    expect(broken.state.breaks).toHaveLength(0);
  });

  it("is one undo step and redo restores it", () => {
    const afterA = placeCaret(run(layout, [t("a+b")]), [0, 0], "R");
    const broken = press(afterA, SHIFT_ENTER).state;
    const undone = runCommand(broken, "undo");
    expect(undone.breaks).toHaveLength(0);
    expect(runCommand(undone, "redo").breaks).toHaveLength(1);
  });

  it("Shift+Enter in a symbolic keyword still adds a keyword slot", () => {
    const s = run(layout, [t("x+1"), CHORDS[layout].symbolic, t("simplify")]);
    const next = run(layout, [SHIFT_ENTER, t("assume,real")], s);
    expect((toWire(next.root) as unknown as { keywords: unknown[] }).keywords).toHaveLength(2);
  });
});

describe("a julia. name in a reopened region", () => {
  // The committed forms, as the core parses them (ast.rs JuliaCall).
  const bare = { type: "JuliaCall", package: "julia", name: "x", args: [], bare: true };
  const call = {
    type: "JuliaCall",
    package: "julia",
    name: "X.f",
    args: [{ type: "Expr", expr: { type: "Ident", name: { segments: [{ text: "a", subscript: false }], label: null } } }],
  };
  const region = (expr: unknown) => toEditing({ type: "ExprRegion", expr: { type: "Add", left: expr, right: { type: "Num", text: "1" } } });

  it("is the name, or the call of the name, it is while typed", () => {
    expect(sexpr(region(bare))).toBe("(+ julia.x 1)");
    expect(sexpr(region(call))).toBe("(+ (call julia.X.f a) 1)");
    // A legacy package call keeps its own node.
    expect(toEditing({ type: "ExprRegion", expr: { ...call, package: "Pkg" } }).expr.type).toBe("JuliaCall");
  });

  it("takes the caret and the selection as any name", () => {
    const opened = focusAt(region(bare), [0, 0], "R");
    // The caret is in the name's text, at its end: it can be edited.
    expect(opened.caret).toEqual({ seg: 0, offset: "julia.x".length });
    const typedOn = typeText(opened, "2");
    expect(sexpr(typedOn.root)).toBe("(+ julia.x2 1)");
    // Shift+Left and Space grow the selection from it, as from `xyz` in `xyz + 1`.
    const grown = handleKey(opened, named("ArrowLeft", { shiftKey: true } as never)).state;
    expect(grown.explicit).toBe(true);
    const plain = focusAt(toEditing({ type: "ExprRegion", expr: { type: "Add", left: ident("xyz"), right: { type: "Num", text: "1" } } }), [0, 0], "R");
    const plainGrown = handleKey(plain, named("ArrowLeft", { shiftKey: true } as never)).state;
    expect(grown.focus).toEqual(plainGrown.focus);
  });
});
