// Editing model: a selection over the editing tree (`tree.ts`), the reference application style
// (compatibility section 14, spike C).
//
// - `focus` is the node enclosed by the editing lines (never a transparent node).
// - `side` is where the vertical insertion line sits (left or right edge of the focus).
// - `caret` is set when the focus is a name, number or string being typed into:
//   the segment (name part or literal subscript) and the character offset.
// - `explicit` is true when the selection was made on purpose (Space, Shift+arrows, a
//   closing parenthesis): an operator then applies to exactly that node and typing
//   replaces it. While typing, an operator takes its left operand by precedence
//   climbing (`3*a+b` gives `(3·a)+b`), never leaving a box.
// - `past` / `future` are the editor's own undo history while the region is open (one
//   step per command that changes the tree); the document history (Rust side) receives
//   one step per committed edit.
//
// Every command is a pure function `EditorState -> EditorState`.

import { adjacentToken, caretGaps, gapIndex, gapSpan, type Gap } from "./gaps";
import { toggleGreek } from "./greek";
import { UNIT_NAMES } from "../math/units";
import {
  BINARY_LEVEL,
  allPaths,
  samePath,
  SPLITTABLE,
  STATEMENTS,
  STMTS,
  childListKey,
  childRefs,
  children,
  emptyKeywordGroup,
  emptyStatement,
  exprArg,
  exprStmt,
  get,
  ident,
  integralWirePath,
  isEmptyKeywordGroup,
  isLeaf,
  isPrefix,
  isText,
  isTransparent,
  lastIndex,
  leafPaths,
  num,
  parentPath,
  ph,
  set,
  tryGet,
  textParts as parts,
  withChild,
  type Node,
  type Path,
} from "./tree";

export type Side = "L" | "R";

/** A matrix selection: one whole row or column, or a rectangular range of cells. */
export type MatrixSelection = {
  path: Path;
  axis: "row" | "column" | "range";
  /** For row/column: the selected row or column. For range: the first cell in reading order. */
  index: number;
  /** For range: the last cell in reading order. */
  end?: number;
};
/**
 * Typing over several selected cells of a matrix: the matrix, the cells the typing fills
 * together, and the one the caret is in (`active`), whose content the others repeat while the caret
 * stays in it.
 */
export type CellMirror = { path: Path; cells: number[]; active: number };
/**
 * A run of consecutive call arguments: arguments `first..last` (0-based, in order) of the
 * call at `path`. A run of one argument is the ordinary selection of that argument, so a run is
 * never stored with `first === last`.
 */
export type ArgSelection = {
  path: Path;
  first: number;
  last: number;
};
/**
 * A run of consecutive terms of a chain: terms `first..last` (0-based, left to right) of the
 * chain of `+`/`−` or `·` whose top node is at `path`. A run that starts with the first term is a
 * sub-expression of its own and a run of one term is that term, so a run always has `0 < first < last`.
 */
export type TermSelection = {
  path: Path;
  first: number;
  last: number;
};
export interface Caret {
  /** Name segment (0 for numbers and strings). */
  seg: number;
  offset: number;
  /** A hit just outside the quotes of a string, not in its text: `placeCaret` puts the caret there. */
  outside?: boolean;
}

/** A presentation-only break before an editing-tree node. */
export interface BreakAnchor {
  /** The node the continuation line starts with; identity is kept across edits. */
  node: Node;
  /** Inside a string literal: the character offset in its value (UTF-16 code units). */
  offset?: number;
}

export interface Snapshot {
  root: Node;
  focus: Path;
  side: Side;
  caret: Caret | null;
  explicit: boolean;
  breaks: BreakAnchor[];
}

/**
 * A selection made with Shift+Left/Right: the anchor where it started and the free end the
 * arrows move, valid while the tree and the selection are the ones it produced.
 */
export interface ShiftDrag {
  anchor: Gap;
  end: Gap;
  root: Node;
  focus: Path;
}

export interface EditorState extends Snapshot {
  growOrigin: Path | null;
  shiftDrag?: ShiftDrag;
  matrixSelection?: MatrixSelection;
  cellMirror?: CellMirror;
  argSelection?: ArgSelection;
  termSelection?: TermSelection;
  /**
   * The whole region is the cursor but without the evaluation of its definition: `a := f` of
   * `a := f =`. Only meaningful with `focus` `[]` on a definition that has a tail.
   */
  definitionOnly?: boolean;
  past: Snapshot[];
  future: Snapshot[];
}

export type Context = "math" | "matrix" | "program" | "string";

const HISTORY_LIMIT = 200;

// ---- construction -------------------------------------------------------------------------

/** An editor on `root` (an editing-form statement) with the caret at the end. */
export function initialState(root: Node = emptyStatement(), breaks: { path: number[]; offset?: number }[] = []): EditorState {
  const base: EditorState = {
    root,
    focus: [],
    side: "R",
    caret: null,
    explicit: false,
    breaks: breaks.flatMap((lineBreak) => {
      const node = tryGet(root, lineBreak.path as Path);
      return node ? [{ node, ...(lineBreak.offset !== undefined ? { offset: lineBreak.offset } : {}) }] : [];
    }),
    growOrigin: null,
    past: [],
    future: [],
  };
  return end(base);
}

// ---- text of leaves -----------------------------------------------------------------------

function withPart(n: Node, seg: number, text: string): Node {
  if (n.type === "Ident") {
    const segments = n.name.segments.map((s: { text: string; subscript: boolean }, i: number) =>
      i === seg ? { ...s, text } : s,
    );
    return { ...n, name: { ...n.name, segments } };
  }
  return { ...n, text };
}

function caretAtEnd(n: Node): Caret | null {
  const p = parts(n);
  if (p.length === 0) return null;
  return { seg: p.length - 1, offset: p[p.length - 1].length };
}

function caretAtStart(n: Node): Caret | null {
  return parts(n).length > 0 ? { seg: 0, offset: 0 } : null;
}

const sameCaret = (a: Caret | null, b: Caret | null) =>
  !!a && !!b && a.seg === b.seg && a.offset === b.offset;

// ---- focus helpers ------------------------------------------------------------------------

function normalizeFocus(root: Node, path: Path): Path {
  let p = path;
  while (isTransparent(get(root, p))) p = [...p, 0];
  return p;
}

/** Focus a node; text leaves get a caret at the chosen end. */
export function focusAt(root: Node, path: Path, side: Side = "R", explicit = false, breaks: BreakAnchor[] = []): EditorState {
  const p = normalizeFocus(root, path);
  const n = get(root, p);
  const caret = explicit || !isText(n) ? null : side === "R" ? caretAtEnd(n) : caretAtStart(n);
  return { root, focus: p, side, caret, explicit, breaks, growOrigin: null, past: [], future: [] };
}

/** `focusAt` keeping the history and the breaks of `s`. */
function refocus(s: EditorState, root: Node, path: Path, side: Side = "R", explicit = false): EditorState {
  return { ...focusAt(root, path, side, explicit, s.breaks), past: s.past, future: s.future };
}

/** Replace the node at `at` and focus a path relative to it. */
function replaceAt(s: EditorState, at: Path, node: Node, rel: number[] | null, side: Side = "R"): EditorState {
  const replaced = get(s.root, at);
  const root = set(s.root, at, node);
  // A break at the replaced node follows the node that fills its place, unless the replacement
  // keeps that node as a child, where the identity mapping already carries it.
  const breaks = holdsNode(node, replaced) ? s.breaks : carryBreaks(s.breaks, replaced, node);
  const next = { ...s, breaks };
  if (rel === null) return refocusNode(next, root, at);
  return refocus(next, root, [...at, ...rel], side);
}

/** Whether `root` retains `target` by node identity. */
function holdsNode(root: Node, target: Node): boolean {
  if (root === target) return true;
  return children(root).some((child) => holdsNode(child, target));
}

/**
 * Carries the breaks anchored to `old` over to `next`, the node that replaces it in the same
 * position. `at` is the edited character position and `delta` the length change; an
 * offset after it moves with the text. An offset at `at` stays: text typed on the continuation
 * line starts after the break.
 */
function carryBreaks(breaks: BreakAnchor[], old: Node, next: Node, at = 0, delta = 0): BreakAnchor[] {
  if (!breaks.some((anchor) => anchor.node === old)) return breaks;
  return breaks.map((anchor) => {
    if (anchor.node !== old) return anchor;
    if (anchor.offset !== undefined && next.type === "Str") {
      const offset = anchor.offset > at ? anchor.offset + delta : anchor.offset;
      return { node: next, offset: Math.max(0, Math.min(offset, next.text.length)) };
    }
    return { node: next };
  });
}

/** Focus a composite node itself (no caret, insertion line on the right). */
function refocusNode(s: EditorState, root: Node, at: Path): EditorState {
  const n = get(root, at);
  if (isText(n)) return refocus(s, root, at, "R");
  return { ...s, root, focus: normalizeFocus(root, at), side: "R", caret: null, explicit: false, growOrigin: null };
}

/** The first placeholder at or below `at`, else `at` itself. */
function firstPlaceholder(root: Node, at: Path): number[] | null {
  for (const p of leafPaths(root, at)) {
    if (get(root, p).type === "Placeholder") return p.slice(at.length);
  }
  return null;
}

/** Nearest visible ancestor (transparent wrappers are skipped); null at the top. */
function visibleParent(root: Node, path: Path): Path | null {
  if (path.length === 0) return null;
  let p = parentPath(path);
  while (isTransparent(get(root, p))) {
    if (p.length === 0) return null;
    p = parentPath(p);
  }
  return p;
}

/** Is `n` an expression (something an operator may take as an operand)? */
function isExpr(n: Node): boolean {
  return !STATEMENTS.has(n.type) && !STMTS.has(n.type) && n.type !== "Branch" && n.type !== "KeywordGroup" && n.type !== "InlineDef";
}

export function contextOf(s: EditorState): Context {
  const n = get(s.root, s.focus);
  if (n.type === "Str" && s.caret && !s.explicit) return "string";
  for (let len = s.focus.length - 1; len >= 0; len--) {
    const t = get(s.root, s.focus.slice(0, len)).type;
    if (t === "Matrix") return "matrix";
    if (t === "Program") return "program";
  }
  return "math";
}

/**
 * Operators never apply to a statement: with the whole `x := a+b` selected, `^` applies to
 * the right-hand side; with `a+b = ■` selected, to `a+b`.
 */
function expressionPart(root: Node, path: Path): Path {
  const n = get(root, path);
  switch (n.type) {
    case "Define":
    case "GlobalDefine":
    case "LocalDef":
    case "InlineDef":
      return expressionPart(root, [...path, 1]);
    case "Evaluate":
    case "Symbolic":
    case "ExprRegion":
    case "ExprStmt":
    case "Return":
      return expressionPart(root, [...path, 0]);
    default:
      return path;
  }
}

/** The operand a prefix/postfix/wrapping operator applies to: the selection or the focus. */
function wrapTarget(s: EditorState): Path {
  const path = s.explicit ? expressionPart(s.root, s.focus) : s.focus;
  // A function name followed by its argument list is the head of one operand.
  const after = adjacentToken(s.root, { focus: path, side: "R", caret: null }, "R");
  if (after?.kind === "join" && after.slot === 1 && childRefs(get(s.root, after.owner))[0]?.[0] === "callee") {
    return after.owner;
  }
  return path;
}

/** Where a newly typed operator of level `p` takes its left operand. */
function operandTarget(s: EditorState, p: number): Path {
  let path = wrapTarget(s);
  if (s.explicit) return path;
  while (path.length > 0) {
    const parent = get(s.root, parentPath(path));
    const i = lastIndex(path);
    const lv = BINARY_LEVEL[parent.type];
    const climb =
      (lv !== undefined && i === 1 && lv >= p) ||
      (parent.type === "Neg" && 10 >= p) ||
      (parent.type === "Not" && 5 >= p);
    if (!climb) break;
    path = parentPath(path);
  }
  return path;
}

// ---- typing -------------------------------------------------------------------------------

const DIGIT = /^[0-9.]$/;
// `_` is a name character like a letter: `a_b` is one name; the literal
// subscript is Ctrl+-.
const LETTER = /^[\p{L}∞_]$/u;
/** Non-ASCII symbols with an operator meaning: never part of a name. */
const OPERATOR_GLYPHS = "∗⊛∇‰‖°×·÷√∛∜∑∏∫∂ⅆ≤≥≠¬∧∨⊕←→≡∈∠′″…⋯⋮⋱";

/**
 * Whether a character joins a name as a letter does: a letter, `∞`,
 * `_`, or a non-ASCII symbol or punctuation mark of the BMP that has no operator meaning (`€`, `∀`, `©`).
 */
export function isNameChar(ch: string): boolean {
  // ℜ and ℑ are letters, but they draw the real and imaginary part operators.
  if (ch === "ℜ" || ch === "ℑ") return false;
  if (LETTER.test(ch)) return true;
  const point = ch.codePointAt(0) ?? 0;
  return point > 0x7f && point <= 0xffff && /^[\p{S}\p{P}]$/u.test(ch) && !OPERATOR_GLYPHS.includes(ch);
}

export function typeChar(s: EditorState, ch: string): EditorState {
  const n = get(s.root, s.focus);
  // Inside a string every character is text.
  if (n.type === "Str" && s.caret && !s.explicit) return insertText(s, n, ch);
  // The apostrophe joins a name after its first character (`x'`, `x''`); it never starts one.
  // The prime derivative is the operator `′` (Ctrl+').
  if (ch === "'") return n.type === "Ident" && s.caret && !s.explicit && s.caret.offset > 0 ? insertText(s, n, ch) : s;
  const isDigit = DIGIT.test(ch);
  const isLetter = isNameChar(ch);
  const isDegree = ch === "°";
  if (!isDigit && !isLetter && !isDegree) return s;
  const leaf: Node = isDegree
    ? { type: "Ident", name: { segments: [{ text: ch, subscript: false }], label: "unit" } }
    : isDigit ? num(ch) : ident(ch);

  if (s.explicit && s.side === "L" && isDigit && n.type === "Ident") {
    const target = wrapTarget(s);
    if (!samePath(target, s.focus)) return replaceAt(s, target, binary("Juxt", leaf, get(s.root, target)), [0]);
  }

  if (n.type === "Placeholder" || s.explicit) {
    if (!isExpr(n) && s.explicit) {
      // A whole statement selected: typing starts over.
      if (s.focus.length === 0) return refocus(s, { type: "ExprRegion", expr: leaf }, [0]);
      return s;
    }
    return replaceAt(s, s.focus, leaf, []);
  }

  if (n.type === "Num" && s.caret) {
    if (isDigit) {
      if (ch === "." && s.caret.offset === n.text.length && n.text.endsWith(".")) return startRange(s, n);
      return insertText(s, n, ch);
    }
    if (s.caret.offset === n.text.length && (ch === "i" || ch === "j") && /^[0-9.]+$/.test(n.text)) {
      return replaceAt(s, s.focus, { type: "Imag", text: n.text, symbol: ch }, []);
    }
    // A number followed by a letter: implicit multiplication (`3.5 m`, D7).
    return replaceAt(s, s.focus, { type: "Juxt", left: n, right: leaf }, [1]);
  }
  if (n.type === "Imag" && s.caret && isLetter) {
    // `2in`: the letters after the number are a name (inch), not an imaginary literal.
    return replaceAt(s, s.focus, { type: "Juxt", left: num(n.text), right: ident(n.symbol + ch) }, [1]);
  }
  if (n.type === "Ident" && s.caret && !isDegree) {
    // A name cannot start with a digit: a digit typed before a name is a number in front of
    // it, the implicit product `3 I`, with the caret after the digit.
    // Before the name of a call the number goes in front of the whole call, `2 f(x)`, never `(2 f)(x)`.
    if (isDigit && s.caret.seg === 0 && s.caret.offset === 0) {
      const target = operandStartingAt(s) ?? s.focus;
      return replaceAt(s, target, binary("Juxt", leaf, get(s.root, target)), [0]);
    }
    return insertText(s, n, ch);
  }

  // After a completed operand (a closing parenthesis, a call): multiplication.
  if (!isExpr(n)) return s;
  const before = operandStartingAt(s);
  return before
    ? replaceAt(s, before, binary(isDigit ? "Juxt" : "Mul", leaf, get(s.root, before)), [0])
    : replaceAt(s, s.focus, binary("Mul", n, leaf), [1]);
}

function insertText(s: EditorState, n: Node, ch: string): EditorState {
  const caret = s.caret ?? caretAtEnd(n)!;
  const text = parts(n)[caret.seg];
  const next = withPart(n, caret.seg, text.slice(0, caret.offset) + ch + text.slice(caret.offset));
  return {
    ...s,
    root: set(s.root, s.focus, next),
    breaks: carryBreaks(s.breaks, n, next, caret.offset, ch.length),
    caret: { seg: caret.seg, offset: caret.offset + ch.length },
    side: "R",
    growOrigin: null,
  };
}

/** The palette's range: the operand under the editing lines becomes the first value of `x..□`. */
function rangeFrom(s: EditorState): EditorState {
  const t = operandTarget(s, 7);
  const root = set(s.root, t, { type: "Range", first: get(s.root, t), second: null, last: ph() });
  return refocus(s, root, [...t, 1]);
}

/** `..` after a number: a range `first..□` (or the last value of a stepped range). */
function startRange(s: EditorState, n: Node): EditorState {
  const first = { ...n, text: n.text.slice(0, -1) };
  let root = set(s.root, s.focus, first);
  const parent = s.focus.length > 0 ? get(root, parentPath(s.focus)) : null;
  if (parent?.type === "Range" && parent.second && lastIndex(s.focus) === 1) {
    return refocus(s, root, [...parentPath(s.focus), 2]);
  }
  const t = operandTarget({ ...s, root }, 7);
  const tn = get(root, t);
  root = set(root, t, { type: "Range", first: tn, second: null, last: ph() });
  return refocus(s, root, [...t, 1]);
}

// ---- operators ----------------------------------------------------------------------------

function binary(type: string, left: Node, right: Node, split = false): Node {
  return SPLITTABLE.has(type) ? { type, left, right, split } : { type, left, right };
}

/** An empty operator uses ordinary wire nodes: the middle placeholder of `a □ b`. */
function operatorGap(s: EditorState): { path: Path; left: Node; right: Node } | null {
  if (s.focus.length < 2 || get(s.root, s.focus).type !== "Placeholder") return null;
  const innerPath = parentPath(s.focus);
  const path = parentPath(innerPath);
  const inner = get(s.root, innerPath);
  const outer = get(s.root, path);
  if (inner.type !== "Juxt" || outer.type !== "Juxt") return null;
  if (lastIndex(innerPath) === 0 && lastIndex(s.focus) === 1) return { path, left: inner.left, right: outer.right };
  if (lastIndex(innerPath) === 1 && lastIndex(s.focus) === 0) return { path, left: outer.left, right: inner.right };
  return null;
}

function fillOperatorGap(s: EditorState, type: string, split = false): EditorState | null {
  const gap = operatorGap(s);
  return gap ? replaceAt(s, gap.path, binary(type, gap.left, gap.right, split), [1], "L") : null;
}

function nameOnlySlot(root: Node, at: Path): boolean {
  if (at.length === 0) return false;
  const owner = get(root, parentPath(at));
  const field = childRefs(owner)[lastIndex(at)]?.[0];
  if (owner.type === "Sum" || owner.type === "Prod") return false;
  return field === "var" || field === "vars" || field === "keyword";
}

function insertBinary(s: EditorState, type: string, split = false): EditorState {
  const filled = fillOperatorGap(s, type, split);
  if (filled) return filled;
  const op: ChainToken = { kind: "binary", node: binary(type, ph(), ph(), split), level: BINARY_LEVEL[type], rightAssoc: false };
  // A typed operator between two factors replaces implicit multiplication.
  const between = !s.explicit && adjacentJoin(s, (node) => node.type === "Juxt");
  if (between) {
    const product = get(s.root, between);
    return spliceChain(s, between, [...chainTokens(product.left), op, ...chainTokens(product.right)], product.right, "L");
  }

  const n = get(s.root, s.focus);
  if (type === "Sub" && n.type === "Placeholder" && !s.explicit) {
    return replaceAt(s, s.focus, { type: "Neg", expr: ph() }, [0]);
  }
  const before = operandStartingAt(s);
  const target = before ?? wrapTarget(s);
  const operand = get(s.root, target);
  if (!isExpr(operand) || nameOnlySlot(s.root, target)) return s;
  if (operand.type === "Placeholder") return replaceAt(s, target, binary(type, ph(), ph(), split), [0]);

  const hole = ph();
  const missing: ChainToken = { kind: "atom", node: hole };
  const atom: ChainToken = { kind: "atom", node: operand };
  // `-` on the left of an operand reads as the same text typed in a row: a negation.
  if (type === "Sub" && !split && before) {
    const negation: ChainToken = { kind: "prefix", node: { type: "Neg", expr: ph() }, level: PREFIX_LEVEL.Neg };
    const terms = s.explicit || BINARY_LEVEL[operand.type] === undefined ? [atom] : chainTokens(operand);
    const first = terms[0]?.kind === "atom" ? terms[0].node : operand;
    return spliceChain(s, target, [negation, ...terms], first, "L");
  }
  const splitText = !s.explicit && samePath(target, s.focus) ? splitTextOperand(operand, s.caret) : null;
  if (splitText) {
    const [left, right] = splitText;
    return spliceChain(s, target, [{ kind: "atom", node: left }, op, { kind: "atom", node: right }], right, "L");
  }
  // A selection is one structural operand. A plain caret re-reads the existing tokens of its slot.
  const terms = s.explicit || (before && BINARY_LEVEL[operand.type] === undefined) ? [atom] : chainTokens(operand);
  return before
    ? spliceChain(s, target, [missing, op, ...terms], hole, "R")
    : spliceChain(s, target, [...terms, op, missing], hole, "R");
}

function adjacentJoin(s: EditorState, matches: (node: Node) => boolean): Path | null {
  for (const side of ["L", "R"] as const) {
    const token = adjacentToken(s.root, s, side);
    if (token?.kind === "join" && token.slot === 1 && matches(get(s.root, token.owner))) return token.owner;
  }
  return null;
}

/** The operand starting at a gap, including any enclosing operand sharing that left edge. */
function operandStartingAt(s: EditorState): Path | null {
  if (s.explicit) {
    if (s.side !== "L" || s.argSelection || s.termSelection || s.matrixSelection) return null;
    const path = wrapTarget(s);
    const node = get(s.root, path);
    return path.length > 0 && isExpr(node) && node.type !== "Placeholder" ? path : null;
  }
  const sequence = caretGaps(s.root);
  const index = gapIndex(sequence, s);
  if (index === undefined) return null;
  let path = sequence.positions[index].focus;
  const node = get(s.root, path);
  if (!isExpr(node) || node.type === "Placeholder") return null;
  if (gapSpan(sequence, path)?.[0] !== index) return null;
  while (path.length > 0) {
    const parent = parentPath(path);
    const node = get(s.root, parent);
    if (!isExpr(node) || BINARY_LEVEL[node.type] !== undefined || gapSpan(sequence, parent)?.[0] !== index) break;
    path = parent;
  }
  return path;
}

/** Inserting an infix operator within a text token splits it at the edit offset. */
function splitTextOperand(node: Node, caret: Caret | null): [Node, Node] | null {
  if (!caret || (node.type !== "Ident" && node.type !== "Num")) return null;
  const { seg, offset } = caret;
  const text = parts(node);
  if (seg === 0 && offset === 0 || seg === text.length - 1 && offset === text[seg].length) return null;
  if (node.type === "Num") return [num(node.text.slice(0, offset)), num(node.text.slice(offset))];
  const segments = node.name.segments;
  const part = segments[seg];
  const left = [...segments.slice(0, seg), { ...part, text: part.text.slice(0, offset) }].filter(p => p.text !== "");
  const right = [{ ...part, text: part.text.slice(offset) }, ...segments.slice(seg + 1)].filter(p => p.text !== "");
  if (!left.length || !right.length) return null;
  return [
    { ...node, name: { ...node.name, segments: left } },
    { ...node, name: { ...node.name, segments: [{ ...right[0], subscript: false }, ...right.slice(1)] } },
  ];
}

/** A relational operator typed right after `<` or `>`: `<=`, `>=`, `<>`. */
function combineRelation(s: EditorState, ch: "=" | ">"): EditorState | null {
  const n = get(s.root, s.focus);
  if (n.type !== "Placeholder" || s.focus.length === 0 || lastIndex(s.focus) !== 1) return null;
  const pp = parentPath(s.focus);
  const parent = get(s.root, pp);
  const map: Record<string, string> =
    ch === "=" ? { Lt: "Le", Gt: "Ge" } : { Lt: "Ne" };
  const type = map[parent.type];
  if (!type) return null;
  return { ...s, root: set(s.root, pp, { ...parent, type }) };
}

/**
 * Wraps the selection (or the operand under the editing lines). `make` builds the new
 * node from the operand; the focus goes to the first placeholder inside it, or to the new
 * node itself when it has none, so that the next operator applies to it.
 */
function wrapWith(s: EditorState, make: (operand: Node) => Node | null, target: Path = wrapTarget(s)): EditorState {
  const tn = get(s.root, target);
  if (!isExpr(tn)) return s;
  const node = make(tn);
  if (!node) return s;
  const root = set(s.root, target, node);
  const rel = firstPlaceholder(root, target);
  return rel === null ? refocusNode(s, root, target) : refocus(s, root, [...target, ...rel]);
}

/** `^` and `/` (and index): wrap the operand, the cursor goes to the new box. */
function wrapBox(s: EditorState, make: (operand: Node) => Node, box: number): EditorState {
  const target = wrapTarget(s);
  const tn = get(s.root, target);
  if (!isExpr(tn)) return s;
  const root = set(s.root, target, make(tn));
  return refocus(s, root, [...target, tn.type === "Placeholder" ? 0 : box]);
}

// ---- statements ---------------------------------------------------------------------------

function define(s: EditorState, type: "Define" | "GlobalDefine"): EditorState {
  const r = s.root;
  // An evaluation `e =` or a symbolic evaluation `e →` keeps what follows its expression as the tail
  // of the definition; a global definition shows no result, so it takes neither.
  const tail: Node | null =
    r.type === "Evaluate" ? { type: "Eval", unit: r.unit } : r.type === "Symbolic" ? { type: "Sym", keywords: r.keywords } : null;
  if (r.type !== "ExprRegion" && !(tail && type === "Define")) return s;
  const x = r.expr;
  const first = leafPaths(s.root, [0])[0];
  const completeSelectionAtLeft = s.explicit && s.caret === null && s.side === "L" && samePath(s.focus, [0]);
  const caretAtLeft = !s.explicit &&
    (s.caret ? s.caret.seg === 0 && s.caret.offset === 0 : s.side === "L") &&
    (samePath(s.focus, [0]) || (first !== undefined && samePath(s.focus, first)));
  const atLeft = x.type !== "Placeholder" && (completeSelectionAtLeft || caretAtLeft);
  if (tail) return atLeft ? refocus(s, { type: "Define", target: ph(), rhs: x, tail }, [0]) : s;
  if (atLeft) {
    const root: Node = type === "Define"
      ? { type, target: ph(), rhs: x, tail: null }
      : { type, target: ph(), rhs: x };
    return refocus(s, root, [0]);
  }
  const root: Node =
    type === "Define" ? { type, target: x, rhs: ph(), tail: null } : { type, target: x, rhs: ph() };
  return refocus(s, root, [x.type === "Placeholder" ? 0 : 1]);
}

/** `→`: the arrow with an empty keyword slot above it, which takes the caret. */
function symbolicArrow(s: EditorState): EditorState {
  const next = evaluate(s, true);
  if (next === s) return s;
  return refocus(next, next.root, [next.root.type === "Symbolic" ? 1 : 2, 0]);
}

function evaluate(s: EditorState, symbolic: boolean): EditorState {
  const r = s.root;
  if (r.type === "ExprRegion") {
    const root: Node = symbolic
      ? { type: "Symbolic", expr: r.expr, keywords: [emptyKeywordGroup()] }
      : { type: "Evaluate", expr: r.expr, unit: null };
    return { ...s, root, growOrigin: null };
  }
  if (r.type === "Define" && !r.tail) {
    const tail = symbolic ? { type: "Sym", keywords: [emptyKeywordGroup()] } : { type: "Eval", unit: null };
    return { ...s, root: { ...r, tail }, growOrigin: null };
  }
  return s;
}

// ---- selection growth (Space, Shift+arrows) -------------------------------------------------
//
// Space grows the group in the direction of the insertion line: the editing lines close over the
// nearest expression that extends that way, over a visible wrapper of the same terms
// (parentheses, a negation) when there is one, and over the enclosing expression when the
// selection already reaches the edge of the expression in that direction. The insertion line
// keeps its side, so the same selection grows left or right depending on where the line is, and
// the cycle ends back at the anchor it started from, on that side. Shift+arrows
// grow in the direction of the arrow and move the line to that side.

export function grow(s: EditorState): EditorState {
  const origin = s.growOrigin ?? s.focus;
  const definition = growToDefinition(s, s.side);
  if (definition) return { ...definition, growOrigin: origin };
  // After `a := f`, the whole region with its evaluation.
  if (s.definitionOnly) return { ...s, definitionOnly: undefined, growOrigin: origin };
  const terms = growTerms(s, s.side);
  if (terms) return { ...terms, side: s.side, growOrigin: origin };
  const parent = visibleParent(s.root, s.focus);
  if (parent === null) {
    // At the top: back to where the growth started, on the side the insertion line is on.
    const back = refocus(s, s.root, origin, s.side);
    return isLeaf(get(s.root, origin)) ? back : { ...back, explicit: true, caret: null };
  }
  const focus = growAncestor(s.root, s.focus, s.side) ?? parent;
  return { ...s, focus, caret: null, explicit: true, growOrigin: origin };
}

function leafRange(root: Node, path: Path): [number, number] {
  const leaves = leafPaths(root);
  const inside = leaves.map((p, i) => (isPrefix(path, p) ? i : -1)).filter((i) => i >= 0);
  return [inside[0] ?? 0, inside[inside.length - 1] ?? -1];
}

/** The numerator or the denominator of a built-up fraction: a slot growth fills before the fraction. */
/**
 * Space stops at every slot of a construct, whichever side the line is on: a fraction part,
 * a call argument, an exponent, a fence's content, the value after `←`, a program line, a block and the
 * program. Operands inside an operator chain are not slots (the chain grows by its terms), and neither
 * are the parts of a region statement.
 */
function isSlotStop(root: Node, p: Path): boolean {
  const type = get(root, p).type;
  if (STMTS.has(type) || type === "Branch" || type === "Program") return true;
  if (p.length === 0) return false;
  const parent = get(root, parentPath(p));
  // The expression of a program line is that line's content, even under its transparent wrapper.
  if (STMTS.has(parent.type)) return true;
  return BINARY_LEVEL[parent.type] === undefined && !STATEMENTS.has(parent.type) && !isTransparent(parent);
}

/** The next group around `focus`: the nearest ancestor that extends on the `dir` side, or a
 * visible wrapper over exactly the same terms (parentheses, a negation), whichever is nearer. A
 * numerator or denominator is taken whole first, and the fraction right after it, whichever side
 * they extend to: the fraction stands over and under its parts, not beside them. */
function growAncestor(root: Node, focus: Path, dir: Side): Path | null {
  const sequence = caretGaps(root);
  const [first, last] = gapSpan(sequence, focus)!;
  let p = visibleParent(root, focus);
  while (p !== null) {
    const [f, l] = gapSpan(sequence, p)!;
    if ((f === first && l === last) || (dir === "L" && f < first) || (dir === "R" && l > last)) return p;
    if (isSlotStop(root, p)) return p;
    p = visibleParent(root, p);
  }
  return null;
}



/** The subtrees at the ends of a structural selection. */
function selectionEnds(s: EditorState): [Path, Path] {
  if (s.argSelection) {
    const { path, first, last } = s.argSelection;
    return [[...path, first + 1], [...path, last + 1]];
  }
  if (s.termSelection) {
    const { path, first, last } = s.termSelection;
    const count = chainTerms(get(s.root, path)).length;
    return [termPath(path, count, first), termPath(path, count, last)];
  }
  return [s.focus, s.focus];
}

export function activeShiftDrag(s: EditorState): ShiftDrag | undefined {
  const drag = s.shiftDrag;
  return drag && drag.root === s.root && samePath(drag.focus, s.focus) ? drag : undefined;
}

/** Shift+Left/Right extends the same gap walk used by Left/Right, with a fixed anchor. */
function shiftMove(s: EditorState, dir: Side): EditorState {
  const sequence = caretGaps(s.root);
  const drag = activeShiftDrag(s);
  const [first, last] = selectionEnds(s);
  const start = s.explicit || s.argSelection || s.termSelection;
  const anchor = drag?.anchor ?? (start ? { focus: dir === "R" ? first : last, side: dir === "R" ? "L" : "R", caret: null } : s);
  const end = drag?.end ?? (start ? { focus: dir === "R" ? last : first, side: dir, caret: null } : s);
  const fixed = gapIndex(sequence, anchor);
  let moving = gapIndex(sequence, end);
  if (fixed === undefined || moving === undefined) return s;
  // The free end steps one gap, then snaps to the outer edge of what is selected on its side, so the
  // insertion line is drawn where the selection ends and the next press starts there.
  // A step that leaves the selection as it was (inside a name) goes on.
  for (;;) {
    const next: number = moving + (dir === "L" ? -1 : 1);
    const gap = sequence.positions[next];
    if (!gap) return s;
    if (next === fixed) return focusOnGap(s, gap);
    const selected = selectRange(s, sequence.positions[fixed].focus, gap.focus);
    const [head, tail] = selectionEnds(selected);
    const edge = next > fixed ? gapSpan(sequence, tail)?.[1] ?? next : gapSpan(sequence, head)?.[0] ?? next;
    moving = dir === "R" ? Math.max(next, edge) : Math.min(next, edge);
    const unchanged = (s.explicit || s.argSelection || s.termSelection) && sameSelection(selected, s);
    if (unchanged) continue;
    return {
      ...selected,
      side: next < fixed ? "L" : "R",
      shiftDrag: { anchor: sequence.positions[fixed], end: sequence.positions[moving], root: s.root, focus: selected.focus },
    };
  }
}

/** Whether two states select the same node or run. */
function sameSelection(a: EditorState, b: EditorState): boolean {
  return a.explicit === b.explicit && samePath(a.focus, b.focus) &&
    JSON.stringify(a.argSelection ?? null) === JSON.stringify(b.argSelection ?? null) &&
    JSON.stringify(a.termSelection ?? null) === JSON.stringify(b.termSelection ?? null);
}

// ---- a definition without its evaluation ---------------------------------------------

/** Whether `root` is a definition with an evaluation tail (`a := f =` or `a := f →`). */
function evaluatedDefinition(root: Node): boolean {
  return root.type === "Define" && root.tail !== null && root.tail !== undefined;
}

/**
 * The step growth takes from inside `a := f =` before the whole region: `a := f`, without the
 * evaluation. Null anywhere else, and once that step is taken (the region comes next).
 */
function growToDefinition(s: EditorState, dir: Side): EditorState | null {
  if (s.definitionOnly || !evaluatedDefinition(s.root) || s.focus.length === 0) return null;
  if (s.focus[0] !== 0 && s.focus[0] !== 1) return null;
  // Only where the next step would be the whole region (or nothing extends that way any more).
  const next = growAncestor(s.root, s.focus, dir);
  if (next !== null && next.length > 0) return null;
  return { ...s, focus: [], caret: null, explicit: true, argSelection: undefined, termSelection: undefined, definitionOnly: true };
}

/** The paths the definition-only selection covers (its target and its right-hand side), for its box. */
export function definitionOnlyPaths(s: EditorState): Path[] {
  return s.definitionOnly && evaluatedDefinition(s.root) ? [[0], [1]] : [];
}

// ---- runs of terms ------------------------------------------------------------------

/** The chain family of a node: `+`/`−` chain together, `·` chains alone. */
function chainFamily(n: Node): string | null {
  return n.type === "Add" || n.type === "Sub" ? "add" : n.type === "Mul" ? "mul" : null;
}

/** The terms of the chain whose top node is `n`, left to right, with the operator in front of each (none for the first). */
function chainTerms(n: Node): { op: string | null; term: Node }[] {
  const family = chainFamily(n);
  const out: { op: string | null; term: Node }[] = [];
  let node = n;
  while (family && chainFamily(node) === family) {
    out.unshift({ op: node.type, term: node.right });
    node = node.left;
  }
  out.unshift({ op: null, term: node });
  return out;
}

/** The path of term `i` of the chain of `count` terms at `top`: left operands down to it, then its right operand. */
function termPath(top: Path, count: number, i: number): Path {
  const left = (n: number): Path => new Array(n).fill(0);
  return i === 0 ? [...top, ...left(count - 1)] : [...top, ...left(count - 1 - i), 1];
}

/** The paths of the terms of the selected run, for drawing its box; empty without a run. */
export function selectedTermPaths(s: EditorState): Path[] {
  const run = s.termSelection;
  if (!run) return [];
  const count = chainTerms(get(s.root, run.path)).length;
  return Array.from({ length: run.last - run.first + 1 }, (_, k) => termPath(run.path, count, run.first + k));
}

/** The index of the term of the chain at `top` that `path` (inside the chain) lies in. */
function termIndex(top: Path, count: number, path: Path): number {
  let zeros = 0;
  while (zeros < count - 1 && path[top.length + zeros] === 0) zeros++;
  return zeros === count - 1 ? 0 : count - 1 - zeros;
}

/** The top of the chain the binary node at `p` belongs to (climbing while it is a left operand). */
function chainTop(root: Node, p: Path): Path {
  const family = chainFamily(get(root, p));
  let top = p;
  while (top.length > 0 && lastIndex(top) === 0 && chainFamily(get(root, parentPath(top))) === family) top = parentPath(top);
  return top;
}

type TermRange = { top: Path; count: number; first: number; last: number };

/** The terms `path` covers in the chain around it: one term, or the leading terms of a sub-chain. */
function termRangeAt(root: Node, path: Path, run: TermSelection | undefined): TermRange | null {
  if (run) {
    const count = chainTerms(get(root, run.path)).length;
    return { top: run.path, count, first: run.first, last: run.last };
  }
  if (path.length === 0) return null;
  const parentAt = parentPath(path);
  const family = chainFamily(get(root, parentAt));
  if (!family) return null;
  const top = chainTop(root, parentAt);
  const count = chainTerms(get(root, top)).length;
  const node = get(root, path);
  // A left operand of the same family is the sub-chain of the leading terms.
  if (lastIndex(path) === 0 && chainFamily(node) === family) {
    return { top, count, first: 0, last: chainTerms(node).length - 1 };
  }
  const i = termIndex(top, count, path);
  return { top, count, first: i, last: i };
}

/** Selects terms `first..last` of the chain at `top`: a sub-expression, one term or a run. */
function selectTerms(s: EditorState, range: TermRange, side: Side): EditorState {
  const { top, count, first, last } = range;
  const base = { ...s, caret: null, explicit: true, side, argSelection: undefined, termSelection: undefined };
  // The leading terms 0..last are the left operand reached after count - 1 - last steps down.
  if (first === 0) return { ...base, focus: [...top, ...new Array(count - 1 - last).fill(0)] };
  if (first === last) return { ...base, focus: termPath(top, count, first) };
  return { ...base, focus: termPath(top, count, side === "R" ? last : first), termSelection: { path: top, first, last } };
}

/**
 * Space or Shift+arrows on a term or a run of terms: one more term in that direction; a run
 * at the end of the chain takes the whole chain. Null when the focus is no term of a chain, or a term
 * or sub-expression already at that end.
 */
function growTerms(s: EditorState, dir: Side): EditorState | null {
  const range = termRangeAt(s.root, s.focus, s.termSelection);
  if (!range) return null;
  const { count, first, last } = range;
  const atEdge = dir === "R" ? last === count - 1 : first === 0;
  // At the end of the chain a run (no node of its own) becomes the whole chain; a term or a
  // sub-expression grows as does.
  if (atEdge) return s.termSelection ? selectTerms(s, { ...range, first: 0, last: count - 1 }, dir) : null;
  return selectTerms(s, dir === "R" ? { ...range, last: last + 1 } : { ...range, first: first - 1 }, dir);
}

/** Rebuilds a chain from its terms and operators (the first operator is ignored). */
function buildChain(terms: { op: string | null; term: Node }[]): Node {
  let chain = terms[0].term;
  for (const { op, term } of terms.slice(1)) chain = { type: op ?? "Add", left: chain, right: term };
  return chain;
}

/** The run of terms as the expression it reads: the operator in front of its first term left out. */
function selectedTerms(s: EditorState): Node | null {
  const run = s.termSelection;
  if (!run) return null;
  return buildChain(chainTerms(get(s.root, run.path)).slice(run.first, run.last + 1));
}

/** Replaces the run of terms with `term` (typing over it), or removes it (null): Delete, Backspace, cut. */
function replaceTerms(s: EditorState, term: Node | null): EditorState {
  const run = s.termSelection;
  if (!run) return s;
  const terms = chainTerms(get(s.root, run.path));
  const kept = [
    ...terms.slice(0, run.first),
    ...(term ? [{ op: terms[run.first].op, term }] : []),
    ...terms.slice(run.last + 1),
  ];
  const root = set(s.root, run.path, buildChain(kept));
  const count = kept.length;
  const at = term ? run.first : run.first - 1;
  const focus = count === 1 ? run.path : termPath(run.path, count, at);
  const next = refocus({ ...s, termSelection: undefined }, root, focus, "R");
  return term ? { ...next, explicit: false } : next;
}

/** Insert: move the insertion line to the other edge of the focus, keeping the selection. */
function flipSide(s: EditorState): EditorState {
  const side: Side = s.side === "L" ? "R" : "L";
  const n = get(s.root, s.focus);
  const caret = s.explicit || !isText(n) ? s.caret : side === "R" ? caretAtEnd(n) : caretAtStart(n);
  return { ...s, side, caret };
}

// ---- caret movement -----------------------------------------------------------------------

function focusOnGap(s: EditorState, gap: Gap): EditorState {
  return { ...refocus(s, s.root, gap.focus, gap.side), caret: gap.caret };
}

function moveH(s: EditorState, dir: Side): EditorState {
  const drag = activeShiftDrag(s);
  if (drag) {
    const gap = s.side === dir ? drag.end : drag.anchor;
    return focusOnGap(s, gap);
  }
  if (s.termSelection) {
    // Collapse the run to the term at that end.
    const run = s.termSelection;
    const count = chainTerms(get(s.root, run.path)).length;
    return { ...refocus(s, s.root, termPath(run.path, count, dir === "R" ? run.last : run.first), dir, true), termSelection: undefined };
  }
  if (s.argSelection) {
    // Collapse the run to the argument at that end.
    const run = s.argSelection;
    return refocus(s, s.root, [...run.path, (dir === "R" ? run.last : run.first) + 1], dir, true);
  }
  if (s.explicit) {
    // Collapse the selection to the edge in that direction.
    return refocus(s, s.root, s.focus, dir);
  }
  const sequence = caretGaps(s.root);
  const index = gapIndex(sequence, s);
  const next = index === undefined ? undefined : sequence.positions[index + (dir === "L" ? -1 : 1)];
  return next ? focusOnGap(s, next) : s;
}

function wordMove(s: EditorState, dir: Side): EditorState {
  const n = get(s.root, s.focus);
  if (isText(n) && !s.explicit && s.caret) {
    const atBoundary =
      dir === "L" ? s.caret.offset === 0 && s.caret.seg === 0 : sameCaret(s.caret, caretAtEnd(n));
    if (!atBoundary) return refocus(s, s.root, s.focus, dir);
  } else if (!isLeaf(n) && s.side !== dir) {
    return { ...s, side: dir };
  }
  const leaves = leafPaths(s.root);
  const [first, last] = leafRange(s.root, s.focus);
  const target = dir === "R" ? last + 1 : first - 1;
  if (target < 0 || target >= leaves.length) return s;
  return refocus(s, s.root, leaves[target], dir);
}

function home(s: EditorState): EditorState {
  // A program is drawn as separate editor lines. Home belongs to the innermost line that contains
  // the caret (a nested body included), not to the math region that contains the whole program.
  const line = enclosingLine(s);
  const first = leafPaths(s.root, line?.stmt ?? [])[0];
  return refocus(s, s.root, first, "L");
}

/**
 * End goes to the structural end of the full expression, so typing continues after it: the
 * right edge of the whole power, fraction, parenthesised group or matrix, not the inside of its
 * last slot. A trailing program keeps the old last-leaf move:
 * its lines are statements, not one expression.
 */
export function end(s: EditorState): EditorState {
  const target = expressionPart(s.root, []);
  const n = get(s.root, target);
  if (isExpr(n) && n.type !== "Program") return refocus(s, s.root, target, "R");
  const leaves = leafPaths(s.root);
  return refocus(s, s.root, leaves[leaves.length - 1], "R");
}

function nextPlaceholder(s: EditorState, dir: 1 | -1): EditorState {
  const leaves = leafPaths(s.root);
  const [first, last] = leafRange(s.root, s.focus);
  const start = dir === 1 ? last : first;
  for (let k = 1; k <= leaves.length; k++) {
    const i = (((start + dir * k) % leaves.length) + leaves.length) % leaves.length;
    if (get(s.root, leaves[i]).type === "Placeholder") return refocus(s, s.root, leaves[i]);
  }
  return s;
}

/** Click: caret before or after the clicked node, or at a character offset. */
export function placeCaret(s: EditorState, path: Path, side: Side, caret?: Caret | null): EditorState {
  // A click ends typing into several cells at once.
  const next = refocus({ ...s, cellMirror: undefined }, s.root, path, side);
  // Just outside the quotes of a string: the hit says so and the caret is the node's edge.
  if (caret?.outside && get(s.root, next.focus).type === "Str") return { ...next, caret: null };
  if (caret && next.caret) {
    const p = parts(get(s.root, next.focus));
    const seg = Math.min(Math.max(caret.seg, 0), p.length - 1);
    const offset = Math.min(Math.max(caret.offset, 0), p[seg].length);
    return { ...next, caret: { seg, offset } };
  }
  return next;
}

// ---- deletion -----------------------------------------------------------------------------

function withoutListItem(n: Node, key: string, at: number): Node {
  return { ...n, [key]: n[key].filter((_: unknown, j: number) => j !== at) };
}

/** Deletes the operator that owns the placeholder at `s.focus` (Backspace on `□`). */
function deleteOwner(s: EditorState): EditorState {
  if (s.focus.length === 0) return s;
  const pp = parentPath(s.focus);
  const parent = get(s.root, pp);
  const i = lastIndex(s.focus);
  const c = children(parent);
  const keep = (other: Node, side: Side) => replaceAt(s, pp, other, [], side);
  if (BINARY_LEVEL[parent.type] !== undefined || parent.type === "Div" || parent.type === "Pow") {
    if (parent.type === "Sub" && i === 0 && c[1].type !== "Placeholder") {
      return replaceAt(s, pp, { type: "Neg", expr: c[1] }, [0], "L");
    }
    return keep(c[1 - i], i === 1 ? "R" : "L");
  }
  switch (parent.type) {
    case "Paren":
    case "Neg":
    case "Not":
    case "Factorial":
    // the reference application's percent is a postfix operator of one operand.
    case "Percent":
    case "Permille":
    case "Transpose":
    case "Conj":
    case "RealPart":
    case "ImagPart":
    case "Abs":
    case "Det":
    case "Norm":
    case "Vectorize":
    case "PrimeDeriv":
      return keep(ph(), "R");
    case "Root":
      return parent.index && i === 0 ? replaceAt(s, pp, { ...parent, index: null }, [0]) : keep(ph(), "R");
    case "Index":
      if (i === 0) return s;
      if (parent.indices.length > 1) return replaceAt(s, pp, withoutListItem(parent, "indices", i - 1), [1]);
      return keep(parent.base, "R");
    case "Column":
    case "Row":
      return i === 1 ? keep(parent.base, "R") : s;
    case "Call": {
      if (i === 0) return s;
      if (parent.args.length > 1) return replaceAt(s, pp, withoutListItem(parent, "args", i - 1), [Math.max(1, i - 1)]);
      return keep(parent.callee, "R");
    }
    case "Range":
      if (parent.second && i === 1) return replaceAt(s, pp, { ...parent, second: null }, [0]);
      return keep(c[i === 0 ? c.length - 1 : 0], "R");
    case "Define":
    case "GlobalDefine":
      if (parent.tail) return { ...s, root: { ...parent, tail: null } };
      return refocus(s, { type: "ExprRegion", expr: c[1 - i] }, [0], i === 1 ? "R" : "L");
    case "LocalDef":
    case "InlineDef": {
      const replacement = localDefinitionAsExpression(s, pp, c[1 - i]);
      return refocus(s, replacement.root, replacement.base, i === 1 ? "R" : "L");
    }
    case "Evaluate":
    case "Symbolic":
      return refocus(s, { type: "ExprRegion", expr: parent.expr }, [0]);
    case "KeywordGroup":
      return deleteKeywordPart(s, pp, parent, i);
    case "ExprStmt":
      return deleteLine(s, pp);
    default:
      if (c.every((x) => x.type === "Placeholder")) return keep(ph(), "R");
      return s;
  }
}

/**
 * Backspace or Delete on an empty part of a symbolic keyword: an empty argument goes with
 * its comma, the caret at the end of what precedes it; an empty keyword slot goes when another keyword
 * line is left, and the last one stays as the arrow's empty slot while the caret moves on to the
 * expression, so emptying what is above the arrow never deletes the expression.
 */
function deleteKeywordPart(s: EditorState, group: Path, node: Node, i: number): EditorState {
  if (i >= 1) {
    const root = set(s.root, group, withoutListItem(node, "args", i - 1));
    const leaves = leafPaths(root, [...group, i - 1]);
    return refocus(s, root, leaves[leaves.length - 1], "R");
  }
  const owner = parentPath(group);
  const ownerNode = get(s.root, owner);
  const list = childListKey(ownerNode, lastIndex(group));
  if (node.args.length === 0 && list && ownerNode[list.key].length > 1) {
    const root = set(s.root, owner, withoutListItem(ownerNode, list.key, list.at));
    const index = lastIndex(group);
    const target = index > 0 ? [...owner, index - 1] : [...owner, index];
    const leaves = leafPaths(root, target);
    return index > 0 ? refocus(s, root, leaves[leaves.length - 1], "R") : refocus(s, root, leaves[0], "L");
  }
  return moveH(s, "L");
}

/** Removes the program line at `line` (a placeholder line). */
function deleteLine(s: EditorState, line: Path): EditorState {
  if (line.length === 0) return s;
  const owner = parentPath(line);
  const ownerNode = get(s.root, owner);
  const index = lastIndex(line);
  const list = childListKey(ownerNode, index);
  if (!list) return s;
  if (ownerNode[list.key].length > 1) {
    const root = set(s.root, owner, withoutListItem(ownerNode, list.key, list.at));
    const leaves = leafPaths(root, owner);
    // Back to the end of the previous line (or the start of the next one).
    const before = leaves.filter((p) => p[owner.length] < index);
    return before.length > 0
      ? refocus(s, root, before[before.length - 1], "R")
      : refocus(s, root, leaves[0] ?? owner, "L");
  }
  if (ownerNode.type === "Program") return replaceAt(s, owner, ph(), []);
  if (ownerNode.type === "If" && list.key === "else") return replaceAt(s, owner, { ...ownerNode, else: null }, null);
  // A control statement whose only line is empty: remove the statement when it is empty.
  if (children(ownerNode).every((x) => x.type === "Placeholder" || (x.type === "ExprStmt" && x.expr.type === "Placeholder"))) {
    return replaceAt(s, owner, exprStmt(ph()), []);
  }
  return s;
}

// ---- deleting and retyping an assignment or equality sign ---------------------------

/** The caret is at the outer left gap of the subtree at `p`. */
function atStartOf(s: EditorState, p: Path): boolean {
  if (s.explicit) return false;
  const sequence = caretGaps(s.root);
  return gapIndex(sequence, s) === gapSpan(sequence, p)?.[0];
}

/** Remove a filled operator into a focused, persistent gap without losing either operand. */
function deleteBinaryOperator(s: EditorState, side: Side, owner: Path): EditorState | null {
  const n = get(s.root, owner);
  if (n.left.type === "Placeholder" || n.right.type === "Placeholder") {
    const emptySide = n.left.type === "Placeholder" ? 0 : 1;
    return deleteOwner(refocus(s, s.root, [...owner, emptySide]));
  }
  const gap = binary("Juxt", binary("Juxt", n.left, ph()), n.right);
  return replaceAt(s, owner, gap, [0, 1], side);
}

/**
 * Removes a local-definition node while preserving the structure that contains its resulting
 * expression: a program still needs an ExprStmt, while a Call/JuliaCall still needs an Expr
 * argument wrapper. `base` is the path of the visible replacement expression; `focus` is the old
 * focus translated into that expression (LocalDef gains the transparent ExprStmt child).
 */
function localDefinitionAsExpression(
  s: EditorState,
  p: Path,
  expr: Node,
): { root: Node; base: Path; focus: Path } {
  const definition = get(s.root, p);
  if (definition.type === "LocalDef") {
    return {
      root: set(s.root, p, exprStmt(expr)),
      base: [...p, 0],
      focus: [...p, 0, ...s.focus.slice(p.length)],
    };
  }
  const owner = p.length > 0 ? get(s.root, parentPath(p)) : null;
  const replacement = owner && (owner.type === "Call" || owner.type === "JuliaCall") ? exprArg(expr) : expr;
  return { root: set(s.root, p, replacement), base: p, focus: s.focus };
}

/**
 * Backspace right after an assignment/equality sign, or Delete right before it, with an operand
 * on each side: `a := b`, `a ≡ b`, `a ← b` or Boolean `a = b` becomes `a·b`, with the
 * caret staying where it was. Null when the caret is not next to one, or a side is empty
 * (the ordinary deletion then applies).
 */
function deleteAssignmentOrEquality(s: EditorState, p: Path, side: Side): EditorState | null {
  const n = get(s.root, p);
  const [left, right] = children(n);
  if (left.type === "Placeholder" || right.type === "Placeholder") return null;
  const joined = joinOperands(left, right);
  const expr = joined?.expr ?? binary("Mul", left, right);
  let root: Node;
  let base: Path;
  if (n.type === "Eq") {
    root = set(s.root, p, expr);
    base = p;
  } else if (n.type === "LocalDef" || n.type === "InlineDef") {
    const replacement = localDefinitionAsExpression(s, p, expr);
    root = replacement.root;
    base = replacement.base;
  } else {
    // A definition: the statement becomes the result, with the evaluation it had (`x := 3 =`).
    const tail = n.type === "Define" ? n.tail : null;
    root =
      tail?.type === "Eval"
        ? { type: "Evaluate", expr, unit: tail.unit }
        : tail?.type === "Sym"
          ? { type: "Symbolic", expr, keywords: tail.keywords }
          : { type: "ExprRegion", expr };
    base = [0];
  }
  if (!joined) {
    return refocus(s, root, [...base, side === "L" ? 1 : 0], side === "L" ? "L" : "R");
  }
  // The caret stays at the joint, inside the joined name or number.
  const leaves = leafPaths(root, base);
  const joinedFocus = joined.at === "first" ? leaves[0] : leaves[leaves.length - 1];
  return { ...s, root, focus: joinedFocus, side: "R", caret: joined.caret, explicit: false, growOrigin: null };
}

/** A name or number of one plain part, without a label: what can be joined to a neighbour. */
function plainText(n: Node): string | null {
  if (n.type === "Num") return n.text;
  if (n.type === "Ident" && !n.name.label && n.name.segments.length === 1 && !n.name.segments[0].subscript) {
    return n.name.segments[0].text;
  }
  return null;
}

/**
 * Joins two text leaves as typing them one after the other would: letters and digits make
 * one name (`a` `b` → `ab`, `x` `3` → `x3`), digits make one number (`2` `3` → `23`). Null when the
 * result is no single name or number (`2` `a`, a decimal point twice): the caller makes a product.
 */
function joinLeaves(a: Node, b: Node): Node | null {
  if (a.type === "Ident" && (b.type === "Ident" || b.type === "Num")) {
    const text = plainText(b);
    if (text === null || a.name.label || (b.type === "Ident" && b.name.label)) return null;
    const segments = a.name.segments.map((seg: { text: string }, i: number) =>
      i === a.name.segments.length - 1 ? { ...seg, text: seg.text + text } : seg,
    );
    return { ...a, name: { ...a.name, segments } };
  }
  if (a.type === "Num" && b.type === "Num") {
    const text = a.text + b.text;
    return /^\d+(\.\d*)?$/.test(text) ? num(text) : null;
  }
  return null;
}

/**
 * The two sides of a deleted equals sign joined into one expression when one side is a single name
 * or number and its neighbouring leaf on the other side joins with it (`a := b + c` → `ab + c`);
 * `at` says which leaf of the result holds the joint and `caret` where in it. Null: no join.
 */
function joinOperands(left: Node, right: Node): { expr: Node; at: "first" | "last"; caret: Caret } | null {
  const lefts = leafPaths(left);
  const rights = leafPaths(right);
  const lastPath = lefts[lefts.length - 1] ?? [];
  const firstPath = rights[0] ?? [];
  const last = get(left, lastPath);
  const first = get(right, firstPath);
  // Only leaves that touch the deleted sign join: the path to them may only pass along the left
  // (or right) operand of inline binary operators, never into brackets, a fraction or a script.
  const touches = (root: Node, path: Path, side: 0 | 1) =>
    path.every((index, i) => index === side && BINARY_LEVEL[get(root, path.slice(0, i)).type] !== undefined);
  if (!touches(left, lastPath, 1) || !touches(right, firstPath, 0)) return null;
  const join = joinLeaves(last, first);
  if (!join) return null;
  const caretAfter = (n: Node): Caret => caretAtEnd(n) ?? { seg: 0, offset: 0 };
  if (lefts.length === 1 && lastPath.length === 0) {
    // The left side is one leaf: it joins the first leaf of the right side.
    const lastSeg = parts(last).length - 1;
    const caret = { seg: lastSeg, offset: parts(last)[lastSeg].length };
    return { expr: firstPath.length === 0 ? join : set(right, firstPath, join), at: "first", caret: last.type === "Num" && first.type === "Num" ? { seg: 0, offset: last.text.length } : caret };
  }
  if (rights.length === 1 && firstPath.length === 0) {
    return { expr: set(left, lastPath, join), at: "last", caret: { ...caretAfter(last) } };
  }
  return null;
}

/**
 * An equals sign typed where a product's operator is — the caret right after `·` or right before
 * it — replaces the product with that equals sign: `a·b` becomes `a := b`, `a ≡ b` or
 * the Boolean `a = b`. A definition needs the product to be the whole statement. Null otherwise.
 */
function equalsForProduct(s: EditorState, type: "Define" | "GlobalDefine" | "Eq"): EditorState | null {
  const r = s.root;
  const gap = operatorGap(s);
  if (gap && type === "Eq") return fillOperatorGap(s, "Eq");
  const p = gap?.path ?? (!s.explicit ? adjacentJoin(s, (node) => node.type === "Mul") : null);
  if (p === null) return null;
  const m = gap ?? get(r, p);
  if (type === "Eq") return { ...s, root: set(r, p, binary("Eq", m.left, m.right)), growOrigin: null };
  if (!samePath(p, [0])) return null;
  let root: Node;
  if (type === "GlobalDefine") {
    if (r.type !== "ExprRegion") return null;
    root = { type, target: m.left, rhs: m.right };
  } else if (r.type === "ExprRegion") {
    root = { type, target: m.left, rhs: m.right, tail: null };
  } else if (r.type === "Evaluate") {
    root = { type, target: m.left, rhs: m.right, tail: { type: "Eval", unit: r.unit } };
  } else if (r.type === "Symbolic") {
    root = { type, target: m.left, rhs: m.right, tail: { type: "Sym", keywords: r.keywords } };
  } else {
    return null;
  }
  return refocus(s, root, leafPaths(root, [1])[0] ?? [1], "L");
}

/**
 * Backspace or Delete on an empty element of a vector (a matrix of one row or one column) removes
 * the element: Backspace goes on at the end of the element before it, Delete at the start of
 * the one after it. Null when the caret is not on an empty element of a vector of two or more.
 */
function deleteEmptyVectorElement(s: EditorState, dir: "back" | "forward"): EditorState | null {
  if (s.focus.length === 0 || get(s.root, s.focus).type !== "Placeholder") return null;
  const m = parentPath(s.focus);
  const matrix = get(s.root, m);
  if (matrix.type !== "Matrix" || (matrix.rows !== 1 && matrix.cols !== 1) || matrix.cells.length < 2) return null;
  const i = lastIndex(s.focus);
  const cells = matrix.cells.filter((_: Node, j: number) => j !== i);
  const node = matrix.rows === 1 ? { ...matrix, cols: cells.length, cells } : { ...matrix, rows: cells.length, cells };
  const root = set(s.root, m, node);
  const backwards = dir === "back" ? i > 0 : i >= cells.length;
  const j = backwards ? i - 1 : i;
  const leaves = leafPaths(root, [...m, j]);
  return refocus(s, root, (backwards ? leaves[leaves.length - 1] : leaves[0]) ?? [...m, j], backwards ? "R" : "L");
}

// ---- deleting a parenthesis ----------------------------------------------------------

/** A piece of an operator chain read again by precedence: an operand, a binary or a prefix operator. */
type ChainToken =
  | { kind: "atom"; node: Node }
  | { kind: "binary"; node: Node; level: number; rightAssoc: boolean }
  | { kind: "prefix"; node: Node; level: number }
  | { kind: "postfix"; node: Node; level: number };

/** The precedence of a prefix operator. */
const PREFIX_LEVEL: Record<string, number> = { Neg: 10, Not: 5 };
/** The precedence of `^`; its exponent is a box and never joins the chain. */
const POW_LEVEL = 12;
const POSTFIX_LEVEL = 13;
const POSTFIX_CHAIN = new Set(["Index", "Column", "Row", "Factorial", "Percent", "Permille", "Transpose", "PrimeDeriv"]);

/** Whether the child `index` of `parent` is read with its operator chain (not a box of its own). */
function inChain(parent: Node, index: number): boolean {
  return BINARY_LEVEL[parent.type] !== undefined || PREFIX_LEVEL[parent.type] !== undefined ||
    (index === 0 && (parent.type === "Pow" || POSTFIX_CHAIN.has(parent.type)));
}

/** The operators and operands of a chain in reading order; a parenthesis or a box is one operand. */
function chainTokens(n: Node, out: ChainToken[] = [], at: Path = [], splice?: { path: Path; tokens: ChainToken[] }): ChainToken[] {
  if (splice && samePath(at, splice.path)) {
    out.push(...splice.tokens);
    return out;
  }
  const binary = BINARY_LEVEL[n.type];
  if (binary !== undefined) {
    chainTokens(n.left, out, [...at, 0], splice);
    out.push({ kind: "binary", node: n, level: binary, rightAssoc: false });
    chainTokens(n.right, out, [...at, 1], splice);
  } else if (n.type === "Pow") {
    chainTokens(n.left, out, [...at, 0], splice);
    out.push({ kind: "binary", node: n, level: POW_LEVEL, rightAssoc: true });
    out.push({ kind: "atom", node: n.right });
  } else if (POSTFIX_CHAIN.has(n.type)) {
    chainTokens(children(n)[0], out, [...at, 0], splice);
    out.push({ kind: "postfix", node: n, level: POSTFIX_LEVEL });
  } else if (PREFIX_LEVEL[n.type] !== undefined) {
    out.push({ kind: "prefix", node: n, level: PREFIX_LEVEL[n.type] });
    chainTokens(n.expr, out, [...at, 0], splice);
  } else {
    out.push({ kind: "atom", node: n });
  }
  return out;
}

function chainRoot(root: Node, at: Path): Path {
  let top = at;
  while (top.length > 0 && inChain(get(root, parentPath(top)), lastIndex(top))) top = parentPath(top);
  return top;
}

/** Re-read the slot with a local edit, carrying the caret's new operand through regrouping. */
function spliceChain(s: EditorState, at: Path, tokens: ChainToken[], focus: Node, side: Side): EditorState {
  const top = chainRoot(s.root, at);
  const root = set(s.root, top, regroup(chainTokens(get(s.root, top), [], top, { path: at, tokens })));
  const target = allPaths(root, top).find(path => get(root, path) === focus) ?? top;
  return refocus(s, root, target, side);
}

/** The tree of a chain read by precedence, left to right (`^` to the right), reusing its nodes. */
function regroup(tokens: ChainToken[]): Node {
  let at = 0;
  const operand = (): Node => {
    const token = tokens[at++];
    if (token.kind === "prefix") {
      const expr = parse(token.level);
      return token.node.expr === expr ? token.node : { ...token.node, expr };
    }
    return token.kind === "atom" ? token.node : ph();
  };
  const parse = (min: number): Node => {
    let left = operand();
    while (at < tokens.length) {
      const token = tokens[at];
      if ((token.kind !== "binary" && token.kind !== "postfix") || token.level < min) break;
      at++;
      if (token.kind === "postfix") {
        left = children(token.node)[0] === left ? token.node : withChild(token.node, 0, left);
        continue;
      }
      const right = parse(token.rightAssoc ? token.level : token.level + 1);
      left = token.node.left === left && token.node.right === right ? token.node : { ...token.node, left, right };
    }
    return left;
  };
  return parse(0);
}

/** Presentation wrappers whose only operand can be recovered by removing the wrapper. */
const REMOVABLE_EDGES = new Set([
  "Paren", "Abs", "Det", "Norm", "Conj", "RealPart", "ImagPart", "Vectorize",
  "Neg", "Not", "Factorial", "Percent", "Permille", "Transpose", "PrimeDeriv",
]);

function deleteBoundary(s: EditorState, owner: Path, edge: Side): EditorState | null {
  const wrapper = get(s.root, owner);
  if (!REMOVABLE_EDGES.has(wrapper.type)) return null;
  const content = children(wrapper)[0];
  const sequence = caretGaps(s.root);
  const span = gapSpan(sequence, [...owner, 0])!;
  const gap = sequence.positions[span[edge === "L" ? 0 : 1]];
  return spliceChain(s, owner, chainTokens(content), get(s.root, gap.focus), gap.side);
}

/** Remove a comma by joining its two entries, retaining the resulting entry in the same slot list. */
function deleteComma(s: EditorState, owner: Path, slot: number): EditorState | null {
  const node = get(s.root, owner);
  const list = childListKey(node, slot);
  const previous = childListKey(node, slot - 1);
  if (!list || previous?.key !== list.key || !["args", "indices"].includes(list.key)) return null;
  if (list.key === "args" && node.type !== "KeywordGroup" &&
    (node.args[previous.at].type !== "Expr" || node.args[list.at].type !== "Expr")) return null;
  const left = get(s.root, [...owner, slot - 1]);
  const right = get(s.root, [...owner, slot]);
  const joined = joinOperands(left, right);
  const expr = joined?.expr ?? binary("Juxt", left, right);
  const updated = withChild(node, slot - 1, expr);
  const root = set(s.root, owner, withoutListItem(updated, list.key, list.at));
  const at = [...owner, slot - 1];
  if (!joined) return refocus(s, root, [...at, 1], "L");
  const leaves = leafPaths(root, at);
  const focus = joined.at === "first" ? leaves[0] : leaves[leaves.length - 1];
  return { ...refocus(s, root, focus), caret: joined.caret };
}

/**
 * Backspace with the whole expression of an evaluation `e =`, `e →` or `x := e =`, or the whole
 * region, as the cursor and the caret on its right removes the evaluation; so does Delete
 * with the caret anywhere at the end of the expression, right before the evaluation sign. Null
 * anywhere else.
 */
function deleteEvaluation(s: EditorState, dir: "back" | "forward"): EditorState | null {
  if (s.explicit) return null;
  const r = s.root;
  // The whole region is the cursor after a click on the evaluation sign.
  const region = samePath(s.focus, []) && s.side === "R" && !s.caret;
  const sequence = caretGaps(s.root);
  const before = (p: Path) => dir === "forward"
    ? gapIndex(sequence, s) === gapSpan(sequence, p)?.[1]
    : samePath(s.focus, p) && s.side === "R" && !s.caret;
  if ((r.type === "Evaluate" || r.type === "Symbolic") && (region || before([0]))) {
    return { ...s, root: { type: "ExprRegion", expr: r.expr }, growOrigin: null };
  }
  if (r.type === "Define" && r.tail && (region || before([1]))) {
    return { ...s, root: { ...r, tail: null }, growOrigin: null };
  }
  return null;
}

function backspace(s: EditorState): EditorState {
  return deleteAtGap(s, "L");
}

function deleteForward(s: EditorState): EditorState {
  return deleteAtGap(s, "R");
}

function deleteAtGap(s: EditorState, side: Side): EditorState {
  const direction = side === "L" ? "back" : "forward";
  const removedBreak = removeBreakAtCaret(s, direction) ?? (side === "L" ? joinLineAtCaret(s) : null);
  if (removedBreak) return removedBreak;

  const emptyOperator = operatorGap(s);
  if (emptyOperator) {
    return replaceAt(s, emptyOperator.path, binary("Juxt", emptyOperator.left, emptyOperator.right),
      [side === "L" ? 0 : 1], side === "L" ? "R" : "L");
  }
  const focused = get(s.root, s.focus);
  if (s.explicit) {
    if (s.focus.length === 0 || !isExpr(focused)) return refocus(s, emptyStatement(), [0]);
    return replaceAt(s, s.focus, ph(), []);
  }
  const unevaluated = deleteEvaluation(s, direction);
  if (unevaluated) return unevaluated;

  const sequence = caretGaps(s.root);
  const index = gapIndex(sequence, s);
  if (index === undefined) return s;
  const here = sequence.positions[index];
  const there = sequence.positions[index + (side === "L" ? -1 : 1)];
  const state = samePath(here.focus, s.focus) ? s : focusOnGap(s, here);
  const node = get(s.root, state.focus);
  const token = adjacentToken(s.root, state, side);

  if (node.type === "Placeholder") return deleteEmptyVectorElement(state, direction) ?? deleteOwner(state);

  if (token?.kind === "edge") {
    return deleteBoundary(state, token.owner, token.side) ?? (there ? focusOnGap(s, there) : s);
  }
  if (token?.kind === "join") {
    const owner = get(s.root, token.owner);
    if (token.slot === 1) {
      if (["Define", "GlobalDefine", "LocalDef", "InlineDef", "Eq"].includes(owner.type)) {
        const joined = deleteAssignmentOrEquality(state, token.owner, side);
        if (joined) return joined;
      } else if (owner.type !== "Juxt" && (BINARY_LEVEL[owner.type] !== undefined || owner.type === "Div" || owner.type === "Pow")) {
        const deleted = deleteBinaryOperator(state, side, token.owner);
        if (deleted) return deleted;
      }
    }
    return deleteComma(state, token.owner, token.slot) ?? (there ? focusOnGap(s, there) : s);
  }

  if (node.type === "Break" || node.type === "Continue") {
    if (there && samePath(here.focus, there.focus)) return replaceAt(state, state.focus, exprStmt(ph()), []);
    return s;
  }
  if (!here.caret || !there?.caret || !samePath(here.focus, there.focus)) return s;
  const { seg, offset } = here.caret;
  if (seg !== there.caret.seg) {
    // A name-part transition has no character. Remove an empty segment or cross the style boundary.
    if (node.type === "Ident" && parts(node)[seg] === "") {
      const segments = node.name.segments.filter((_: unknown, index: number) => index !== seg);
      return {
        ...state,
        root: set(s.root, here.focus, { ...node, name: { ...node.name, segments } }),
        caret: { seg: side === "L" ? there.caret.seg : seg, offset: there.caret.offset },
      };
    }
    return focusOnGap(s, there);
  }
  const from = Math.min(offset, there.caret.offset);
  const until = Math.max(offset, there.caret.offset);
  const text = parts(node)[seg];
  const remaining = text.slice(0, from) + text.slice(until);
  const next = node.type === "Imag"
    ? (remaining.endsWith(node.symbol) && remaining.length > 1
      ? { ...node, text: remaining.slice(0, -1) }
      : remaining === node.symbol ? ident(remaining) : remaining ? num(remaining) : ph())
    : withPart(node, seg, remaining);
  const replacement = parts(next).every(t => t === "") && next.type !== "Str" ? ph() : next;
  const root = set(s.root, here.focus, replacement);
  const breaks = carryBreaks(s.breaks, node, replacement, from, from - until);
  return {
    ...refocus({ ...state, breaks }, root, here.focus, seg === 0 && from === 0 ? "L" : "R"),
    caret: replacement.type === "Placeholder" ? null : { seg, offset: from },
  };
}

// ---- names: Greek, literal subscript, label ------------------------------------------------

function greek(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type !== "Ident") return s;
  const caret = s.caret ?? caretAtEnd(n)!;
  if (caret.offset === 0) return s;
  const text = parts(n)[caret.seg];
  const next = withPart(
    n,
    caret.seg,
    text.slice(0, caret.offset - 1) + toggleGreek(text[caret.offset - 1]) + text.slice(caret.offset),
  );
  return {
    ...s,
    root: set(s.root, s.focus, next),
    breaks: carryBreaks(s.breaks, n, next),
    caret,
    explicit: false,
  };
}

function literalSubscript(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type !== "Ident") return s;
  const segments: { text: string; subscript: boolean }[] = n.name.segments;
  const caret = s.caret ?? caretAtEnd(n)!;
  const seg = caret.seg;
  const current = segments[seg];
  if (current.text === "" && seg === segments.length - 1 && seg > 0) {
    // Toggled back before anything was typed: drop the empty segment.
    const next = { ...n, name: { ...n.name, segments: segments.slice(0, -1) } };
    return {
      ...s,
      root: set(s.root, s.focus, next),
      breaks: carryBreaks(s.breaks, n, next),
      caret: { seg: seg - 1, offset: segments[seg - 1].text.length },
      explicit: false,
    };
  }
  if (seg + 1 < segments.length) return { ...s, caret: { seg: seg + 1, offset: 0 }, explicit: false };
  const next = {
    ...n,
    name: { ...n.name, segments: [...segments, { text: "", subscript: !current.subscript }] },
  };
  return {
    ...s,
    root: set(s.root, s.focus, next),
    breaks: carryBreaks(s.breaks, n, next),
    caret: { seg: seg + 1, offset: 0 },
    explicit: false,
  };
}

const LABELS = [null, "var", "unit", "fn", "const"];

function cycleLabel(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type !== "Ident") return s;
  const at = LABELS.indexOf(n.name.label ?? null);
  const label = LABELS[(at + 1) % LABELS.length];
  const next = { ...n, name: { ...n.name, label } };
  return { ...s, root: set(s.root, s.focus, next), breaks: carryBreaks(s.breaks, n, next) };
}

/** Ctrl+U toggles one name or marks all eligible names in an explicit selection. */
function unitLabel(s: EditorState): EditorState {
  let targets = selectedTermPaths(s);
  const args = s.argSelection;
  if (args) {
    targets = Array.from({ length: args.last - args.first + 1 }, (_, i) =>
      [...args.path, args.first + i + 1]);
  }
  const cells = s.matrixSelection;
  if (cells) {
    const matrix = get(s.root, cells.path);
    if (matrix.type !== "Matrix") return s;
    const firstValue = tableHeaderRows(s, cells.path) * matrix.cols;
    targets = selectedMatrixCells(matrix.rows, matrix.cols, cells)
      .filter((i) => i >= firstValue)
      .map((i) => [...cells.path, i]);
    if (targets.length === 0) return s;
  }

  const focus = get(s.root, s.focus);
  const single = targets.length === 0 && focus.type === "Ident";
  if (targets.length === 0) {
    if (!single && !s.explicit) return s;
    targets = [s.focus];
  }

  const replacements = new Map<Node, Node>();
  const visit = (node: Node, path: Path, inside: boolean): Node => {
    const selected = inside || targets.some((target) => samePath(target, path));
    if (!selected && !targets.some((target) => isPrefix(path, target))) return node;

    let next = node;
    if (node.type === "Ident") {
      const [segment] = node.name.segments;
      if (node.name.segments.length === 1 && !segment.subscript && UNIT_NAMES.has(segment.text)) {
        if (node.name.label !== "unit" || single) {
          const label = node.name.label === "unit" ? null : "unit";
          next = { ...node, name: { ...node.name, label } };
        }
      }
    } else {
      const nodes = children(node);
      childRefs(node).forEach(([key], i) => {
        // Bulk labelling applies to values, not to names that bind or identify an operation.
        if (selected && (
          key === "callee" || key === "function" || key === "var" || key === "vars" ||
          key === "tail" || key === "index" || key === "indices" || key === "order" ||
          node.type === "KeywordGroup" ||
          (node.type === "Matrix" && i < tableHeaderRows(s, path) * node.cols) ||
          (key === "target" && node.type !== "Limit") ||
          (key === "right" && node.type === "Pow")
        )) return;
        const child = visit(nodes[i], [...path, i], selected);
        if (child !== nodes[i]) next = withChild(next, i, child);
      });
    }
    if (next !== node) replacements.set(node, next);
    return next;
  };

  const root = visit(s.root, [], false);
  if (root === s.root) return s;
  const breaks = s.breaks.map((anchor) => {
    const node = replacements.get(anchor.node);
    return node ? { ...anchor, node } : anchor;
  });
  return { ...s, root, breaks };
}

// ---- parentheses, calls, arguments, strings ------------------------------------------------

function openParen(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type === "Placeholder") return replaceAt(s, s.focus, { type: "Paren", expr: ph() }, [0]);
  if (s.explicit) {
    const t = expressionPart(s.root, s.focus);
    return wrapWith({ ...s, focus: t }, (x) => ({ type: "Paren", expr: x }), t);
  }
  // A name and an element of an array both start a call: the
  // user who types `(` after `F[i]` means `F[i](x)`, while the product stays the spaced text
  // `F[i] (x)` that only the parser and the printer write (D12).
  if ((n.type === "Ident" || n.type === "Index") && s.side === "R") {
    return replaceAt(s, s.focus, { type: "Call", callee: n, args: [exprArg(ph())] }, [1]);
  }
  if (!isExpr(n)) return s;
  return replaceAt(s, s.focus, { type: "Mul", left: n, right: { type: "Paren", expr: ph() }, split: false }, [1, 0]);
}

function closeParen(s: EditorState): EditorState {
  for (let len = s.focus.length - 1; len >= 0; len--) {
    const p = s.focus.slice(0, len);
    const t = get(s.root, p).type;
    if (t === "Paren" || t === "Call" || t === "JuliaCall") return refocusNode(s, s.root, p);
  }
  return s;
}

function comma(s: EditorState): EditorState {
  for (let len = s.focus.length; len >= 1; len--) {
    const pp = s.focus.slice(0, len - 1);
    const parent = get(s.root, pp);
    const i = s.focus[len - 1];
    if (parent.type === "Call" && i >= 1) {
      // the caret at the start of an argument opens the new one before it, anywhere else after.
      // An empty argument has no start or end: the new one follows it, as before.
      const before = atStartOf(s, [...pp, i]) && get(s.root, s.focus).type !== "Placeholder";
      const args = parent.args.slice();
      args.splice(before ? i - 1 : i, 0, exprArg(ph()));
      return replaceAt(s, pp, { ...parent, args }, [before ? i : i + 1]);
    }
    if (parent.type === "Index" && i >= 1 && parent.indices.length === 1) {
      return replaceAt(s, pp, { ...parent, indices: [...parent.indices, ph()] }, [2]);
    }
    if (parent.type === "KeywordGroup") {
      return replaceAt(s, pp, { ...parent, args: [...parent.args, ph()] }, [parent.args.length + 1]);
    }
    // A comma in a variable of a gradient adds the next variable after it.
    if (parent.type === "Gradient" && i < parent.vars.length) {
      const vars = parent.vars.slice();
      vars.splice(i + 1, 0, ph());
      return replaceAt(s, pp, { ...parent, vars }, [i + 1]);
    }
    if (parent.type === "Matrix" || parent.type === "Program" || parent.type === "Branch") return s;
  }
  // A comma in the right side of a definition: a stepped range `first, second..last`.
  if (s.root.type === "Define" && s.focus[0] === 1 && s.root.rhs.type !== "Range") {
    const root = { ...s.root, rhs: { type: "Range", first: s.root.rhs, second: ph(), last: ph() } };
    return refocus(s, root, [1, 1]);
  }
  return s;
}

function startString(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type !== "Placeholder" && !s.explicit) return s;
  if (!isExpr(n)) return s;
  const root = set(s.root, s.focus, { type: "Str", text: "" });
  return { ...s, root, caret: { seg: 0, offset: 0 }, explicit: false, side: "R", growOrigin: null };
}

function endString(s: EditorState): EditorState {
  return { ...s, caret: null, side: "R", explicit: false };
}

// ---- matrices -----------------------------------------------------------------------------

/**
 * Inserts a `rows × cols` matrix. The operand under the editing lines (if any) becomes the
 * first cell. `[` and Ctrl+M on a placeholder insert one empty cell
 * .
 */
export function insertMatrix(s: EditorState, rows = 1, cols = 1): EditorState {
  return wrapWith(s, (x) => {
    const cells = Array.from({ length: rows * cols }, (_, i) => (i === 0 ? x : ph()));
    return { type: "Matrix", rows, cols, cells };
  });
}

function matrixCell(s: EditorState): { m: Path; i: number; node: Node } | null {
  for (let len = s.focus.length - 1; len >= 0; len--) {
    const m = s.focus.slice(0, len);
    const node = get(s.root, m);
    if (node.type === "Matrix") return { m, i: s.focus[len], node };
  }
  return null;
}

/**
 * The word a new math region holds when it is nothing but one plain name with the caret at its end
 * (`ciao`), else null: what a Space typed there turns into a text region.
 * A name with a label (unit, variable, function), a subscript or other math is no word.
 */
export function loneNameText(s: EditorState): string | null {
  const expr = s.root.type === "ExprRegion" || s.root.type === "ExprStmt" ? s.root.expr : null;
  if (!expr || expr.type !== "Ident" || s.explicit || !s.caret) return null;
  const { segments, label } = expr.name;
  if (label || segments.length !== 1 || segments[0].subscript) return null;
  const word: string = segments[0].text;
  if (!/^[\p{L}][\p{L}\p{N}_]*$/u.test(word)) return null;
  const at = get(s.root, s.focus);
  return at === expr && sameCaret(s.caret, caretAtEnd(at)) ? word : null;
}

export function matrixControls(
  s: EditorState,
): { canDeleteRow: boolean; canDeleteColumn: boolean; rows: number; cols: number } | null {
  const cell = matrixCell(s);
  return cell ? { canDeleteRow: true, canDeleteColumn: true, rows: cell.node.rows, cols: cell.node.cols } : null;
}

/** Shift+Enter inside a symbolic keyword: a new keyword slot after it (the reference application: a new line with a keyword placeholder). */
function addKeyword(s: EditorState): EditorState {
  for (let len = s.focus.length; len >= 1; len--) {
    const group = s.focus.slice(0, len);
    const node = get(s.root, group);
    if (node.type !== "KeywordGroup") continue;
    if (isEmptyKeywordGroup(node)) return s;
    const ownerPath = parentPath(group);
    const owner = get(s.root, ownerPath);
    const first = owner.type === "Symbolic" ? 1 : 2;
    const at = lastIndex(group) - first + 1;
    const insert = (list: Node[]) => [...list.slice(0, at), emptyKeywordGroup(), ...list.slice(at)];
    const next =
      owner.type === "Symbolic"
        ? { ...owner, keywords: insert(owner.keywords) }
        : { ...owner, tail: { ...owner.tail, keywords: insert(owner.tail.keywords) } };
    return replaceAt(s, ownerPath, next, [first + at, 0]);
  }
  return s;
}

/** Shift+Enter: a row below the current cell. */
/**
 * The rows of a table's grid that are not values: the names row and the units
 * row while the table is edited; 0 for a plain matrix.
 */
function tableHeaderRows(s: EditorState, matrix: Path): number {
  if (matrix.length === 0) return 0;
  const owner = get(s.root, matrix.slice(0, -1));
  return owner.type === "Table" ? (owner.units ? 2 : 1) : 0;
}

function addRow(s: EditorState): EditorState {
  const mc = matrixCell(s);
  if (!mc) return addKeyword(s);
  const { rows, cols, cells } = mc.node;
  // a row added on the names or units row of a table is the first value row.
  const r = Math.max(Math.floor(mc.i / cols) + 1, tableHeaderRows(s, mc.m));
  const next = cells.slice();
  next.splice(r * cols, 0, ...Array.from({ length: cols }, ph));
  return replaceAt(s, mc.m, { ...mc.node, rows: rows + 1, cells: next }, [r * cols + (mc.i % cols)]);
}

/** Insert a row above the current cell; the caret stays in the same column of the new row. */
function addRowAbove(s: EditorState): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  const { rows, cols, cells } = mc.node;
  // above the names or units row of a table is the first value row.
  const r = Math.max(Math.floor(mc.i / cols), tableHeaderRows(s, mc.m));
  const col = mc.i % cols;
  const next = cells.slice();
  next.splice(r * cols, 0, ...Array.from({ length: cols }, ph));
  return replaceAt(s, mc.m, { ...mc.node, rows: rows + 1, cells: next }, [r * cols + col]);
}

/** Shift+Space: a column right of the current cell. */
function addColumn(s: EditorState): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  const { rows, cols, cells } = mc.node;
  const at = (mc.i % cols) + 1;
  const next: Node[] = [];
  for (let r = 0; r < rows; r++) {
    const row = cells.slice(r * cols, (r + 1) * cols);
    row.splice(at, 0, ph());
    next.push(...row);
  }
  return replaceAt(s, mc.m, { ...mc.node, cols: cols + 1, cells: next }, [Math.floor(mc.i / cols) * (cols + 1) + at]);
}

/** Insert a column left of the current cell; the caret stays in the same row of the new column. */
function addColumnLeft(s: EditorState): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  const { rows, cols, cells } = mc.node;
  const at = mc.i % cols;
  const next: Node[] = [];
  for (let r = 0; r < rows; r++) {
    const row = cells.slice(r * cols, (r + 1) * cols);
    row.splice(at, 0, ph());
    next.push(...row);
  }
  return replaceAt(s, mc.m, { ...mc.node, cols: cols + 1, cells: next }, [Math.floor(mc.i / cols) * (cols + 1) + at]);
}

/** The cell indexes covered by a matrix selection, in reading order. */
export function selectedMatrixCells(rows: number, cols: number, selection: MatrixSelection): number[] {
  if (selection.axis === "row") {
    return Array.from({ length: cols }, (_, c) => selection.index * cols + c);
  }
  if (selection.axis === "column") {
    return Array.from({ length: rows }, (_, r) => r * cols + selection.index);
  }
  const first = selection.index;
  const last = selection.end ?? first;
  const r1 = Math.floor(first / cols);
  const c1 = first % cols;
  const r2 = Math.floor(last / cols);
  const c2 = last % cols;
  const cells: number[] = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) cells.push(r * cols + c);
  }
  return cells;
}

/** Replaces the selected cells with placeholders, keeping the matrix shape. */
function clearMatrixCells(s: EditorState): EditorState {
  const selection = s.matrixSelection;
  if (selection) {
    const node = get(s.root, selection.path);
    if (node.type !== "Matrix") return s;
    const cells = selectedMatrixCells(node.rows, node.cols, selection);
    if (cells.length === 0) return s;
    const next = node.cells.slice();
    for (const i of cells) next[i] = ph();
    const root = set(s.root, selection.path, { ...node, cells: next });
    return { ...refocus(s, root, [...selection.path, cells[0]], "R"), matrixSelection: undefined };
  }
  const mc = matrixCell(s);
  if (!mc) return s;
  const next = mc.node.cells.slice();
  next[mc.i] = ph();
  return replaceAt(s, mc.m, { ...mc.node, cells: next }, [mc.i]);
}

/** Remove the row or column containing the focused cell, retaining at least one of each. */
function deleteMatrixAxis(s: EditorState, axis: "row" | "column"): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  const { rows, cols, cells } = mc.node;
  // a table never loses its names or units row, its last value row or its last column.
  const header = tableHeaderRows(s, mc.m);
  if (header > 0) {
    const row = Math.floor(mc.i / cols);
    if (axis === "row" && (row < header || rows - header <= 1)) return s;
    if (axis === "column" && cols <= 1) return s;
  }
  // Deleting the last remaining row or column leaves a 1x1 matrix with a placeholder.
  if ((axis === "row" && rows <= 1) || (axis === "column" && cols <= 1)) {
    return replaceAt(s, mc.m, { ...mc.node, rows: 1, cols: 1, cells: [ph()] }, [0]);
  }
  const row = Math.floor(mc.i / cols);
  const col = mc.i % cols;
  const next = cells.filter((_: Node, i: number) => axis === "row" ? Math.floor(i / cols) !== row : i % cols !== col);
  const nextRows = rows - (axis === "row" ? 1 : 0);
  const nextCols = cols - (axis === "column" ? 1 : 0);
  const index = Math.min(row, nextRows - 1) * nextCols + Math.min(col, nextCols - 1);
  return replaceAt(s, mc.m, { ...mc.node, rows: nextRows, cols: nextCols, cells: next }, [index]);
}

/**
 * Typing with several cells of a matrix selected: every selected
 * cell is emptied, the caret goes to the first one, and the typing that follows fills them all. Null
 * when the selection is not several cells of a matrix being typed (a table keeps its own rules).
 */
function startMirror(s: EditorState): EditorState | null {
  const selection = s.matrixSelection;
  if (!selection) return null;
  const node = get(s.root, selection.path);
  if (node.type !== "Matrix" || tableHeaderRows(s, selection.path) > 0) return null;
  const cells = selectedMatrixCells(node.rows, node.cols, selection);
  if (cells.length < 2) return null;
  const cleared = clearMatrixCells(s);
  return { ...cleared, cellMirror: { path: selection.path, cells, active: cells[0] } };
}

/**
 * Repeats the cell the caret is in over the other cells typed together. The typing together
 * ends, and nothing is copied, once the caret leaves that cell or the matrix changes shape.
 */
function mirror(s: EditorState, m: CellMirror | undefined): EditorState {
  if (!m) return s.cellMirror ? { ...s, cellMirror: undefined } : s;
  let node: Node;
  try {
    node = get(s.root, m.path);
  } catch {
    return { ...s, cellMirror: undefined };
  }
  if (node.type !== "Matrix") return { ...s, cellMirror: undefined };
  const inActive = m.path.every((i, k) => s.focus[k] === i) && s.focus[m.path.length] === m.active;
  if (!inActive || m.cells.some((i) => i >= node.cells.length)) return { ...s, cellMirror: undefined };
  const source = node.cells[m.active];
  if (m.cells.every((i) => node.cells[i] === source)) return { ...s, cellMirror: m };
  const cells = node.cells.slice();
  for (const i of m.cells) cells[i] = source;
  return { ...s, root: set(s.root, m.path, { ...node, cells }), cellMirror: m };
}

/** Delete or Backspace on a matrix selection: row/column are removed; a cell range is cleared. */
function deleteMatrixSelection(s: EditorState): EditorState {
  const selection = s.matrixSelection;
  if (!selection) return s;
  if (selection.axis === "range") return clearMatrixCells(s);
  return deleteMatrixAxis(s, selection.axis);
}

// ---- a run of call arguments -------------------------------------------------------

/** The call at `path`, when it is still a call. */
function runCall(root: Node, path: Path): Node | null {
  const call = get(root, path);
  return call.type === "Call" ? call : null;
}

/** Sets the argument list of the call at `path` and focuses the argument `at` (0-based). */
function withArgs(s: EditorState, path: Path, args: Node[], at: number, explicit = false): EditorState {
  const call = runCall(s.root, path);
  if (!call) return s;
  const root = set(s.root, path, { ...call, args });
  const focus = Math.max(0, Math.min(at, args.length - 1));
  return refocus(s, root, [...path, focus + 1], "R", explicit);
}

/** The arguments of the selected run, `first..last` included, as `Call` stores them (`Expr` or `InlineDef`). */
export function selectedArgs(s: EditorState): Node[] {
  const run = s.argSelection;
  const call = run ? runCall(s.root, run.path) : null;
  return run && call ? call.args.slice(run.first, run.last + 1) : [];
}

/**
 * The run an edit applies to at `path`: the call that encloses it and the index of the argument the
 * path reaches. Null when no call encloses the path, or when it reaches the callee (child 0 is the
 * callee, so it is no argument of a call).
 */
function argRunAt(root: Node, path: Path): ArgSelection | null {
  for (let at = path.length - 1; at >= 1; at--) {
    const owner = path.slice(0, at);
    if (get(root, owner).type !== "Call") continue;
    const index = path[at] - 1;
    return index < 0 ? null : { path: owner, first: index, last: index };
  }
  return null;
}

/** Is the caret or the selection inside an argument of a call? */
export function inCallArgument(s: EditorState): boolean {
  return s.argSelection !== undefined || argRunAt(s.root, s.focus) !== null;
}

/** Deletes the arguments of the run (Delete, Backspace, cut); a call keeps at least one argument. */
function deleteRun(s: EditorState): EditorState {
  const run = s.argSelection;
  const call = run ? runCall(s.root, run.path) : null;
  if (!run || !call) return s;
  const kept = call.args.filter((_: Node, i: number) => i < run.first || i > run.last);
  return withArgs(s, run.path, kept.length > 0 ? kept : [exprArg(ph())], run.first);
}

/** Replaces the run with one argument. */
function replaceRun(s: EditorState, arg: Node): EditorState {
  const run = s.argSelection;
  const call = run ? runCall(s.root, run.path) : null;
  if (!run || !call) return s;
  const args = [...call.args.slice(0, run.first), arg, ...call.args.slice(run.last + 1)];
  return withArgs(s, run.path, args, run.first);
}

/**
 * Paste of a list of call arguments: with a run selected the run is replaced, with the
 * caret or the selection inside an argument that argument is replaced, and the pasted arguments go
 * in at that position, in order. Anywhere else there is no target (null): a run of arguments has
 * no meaning outside a call, and the caller says so.
 */
export function pasteArgs(s: EditorState, args: Node[]): EditorState | null {
  if (args.length === 0) return null;
  const at = s.argSelection ?? argRunAt(s.root, s.focus);
  const call = at ? runCall(s.root, at.path) : null;
  if (!at || !call) return null;
  const next = [...call.args.slice(0, at.first), ...args, ...call.args.slice(at.last + 1)];
  return apply(s, (x) => withArgs(x, at.path, next, at.first));
}

/** Selects the whole row or column containing the focused cell (shown selected; Delete removes it). */
function selectMatrixAxis(s: EditorState, axis: "row" | "column"): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  return selectMatrixAxisAt(s, mc.m, mc.i, axis);
}

/** Selects the row or column of cell `index` of the matrix at `matrix`; the caret goes to that cell. */
export function selectMatrixAxisAt(s: EditorState, matrix: Path, index: number, axis: "row" | "column"): EditorState {
  const node = get(s.root, matrix);
  if (node.type !== "Matrix") return s;
  const selected = refocus(s, s.root, [...matrix, index], "R");
  return { ...selected, matrixSelection: { path: matrix, axis, index: axis === "row" ? Math.floor(index / node.cols) : index % node.cols } };
}

/**
 * Moves to cell `index + d` (reading order). With `grow`, a step past the last cell adds a row of
 * placeholders below and puts the caret in its first cell;
 * that is one command, so one undo step.
 */
function moveCell(s: EditorState, d: number, grow = false): EditorState {
  const mc = matrixCell(s);
  if (!mc) return s;
  const j = mc.i + d;
  if (grow && j >= mc.node.cells.length) {
    const { rows, cols, cells } = mc.node;
    const next = cells.concat(Array.from({ length: cols }, ph));
    return replaceAt(s, mc.m, { ...mc.node, rows: rows + 1, cells: next }, [rows * cols]);
  }
  if (j < 0 || j >= mc.node.cells.length) return s;
  return refocus(s, s.root, [...mc.m, j], "R");
}

function moveVertical(s: EditorState, d: 1 | -1): EditorState {
  const mc = matrixCell(s);
  if (mc) return moveCell(s, d * mc.node.cols);
  // The next / previous line, leaving nested bodies when they end.
  let line = enclosingLine(s);
  while (line) {
    const owner = get(s.root, line.owner);
    const j = line.index + d;
    if (j >= 0 && j < children(owner).length && childListKey(owner, j)) {
      const leaves = leafPaths(s.root, [...line.owner, j]);
      return refocus(s, s.root, leaves[0], "L");
    }
    line = enclosingLine({ ...s, focus: line.owner });
  }
  return s;
}

// ---- programs -----------------------------------------------------------------------------

type Line = { stmt: Path; owner: Path; index: number; key: string; at: number };

/** The innermost program line containing the focus. */
function enclosingLine(s: EditorState): Line | null {
  for (let len = s.focus.length; len >= 1; len--) {
    const p = s.focus.slice(0, len);
    if (!STMTS.has(get(s.root, p).type)) continue;
    const owner = parentPath(p);
    const index = lastIndex(p);
    const list = childListKey(get(s.root, owner), index);
    if (list) return { stmt: p, owner, index, key: list.key, at: list.at };
  }
  return null;
}

function isPlaceholderLine(root: Node, line: Line): boolean {
  const n = get(root, line.stmt);
  return n.type === "ExprStmt" && n.expr.type === "Placeholder";
}

function insertLineAfter(s: EditorState, line: Line, stmt: Node, rel: number[] | null): EditorState {
  const owner = get(s.root, line.owner);
  const list = owner[line.key].slice();
  list.splice(line.at + 1, 0, stmt);
  const root = set(s.root, line.owner, { ...owner, [line.key]: list });
  const at = [...line.owner, line.index + 1];
  if (rel === null) {
    const first = firstPlaceholder(root, at);
    return first === null ? refocusNode(s, root, at) : refocus(s, root, [...at, ...first]);
  }
  return refocus(s, root, [...at, ...rel]);
}

/**
 * Inserts a program statement built from the current line's expression (`]`-style
 * operators: `{`, `}`, while, for, try, return). Outside a program, a program is created
 * at the placeholder (or around the region's expression).
 */
function lineStatement(s: EditorState, make: (expr: Node | null) => { stmt: Node; rel: number[] }): EditorState {
  const line = enclosingLine(s);
  if (line) {
    if (get(s.root, line.stmt).type === "ExprStmt") {
      const expr = get(s.root, [...line.stmt, 0]);
      const { stmt, rel } = make(expr.type === "Placeholder" ? null : expr);
      return refocus(s, set(s.root, line.stmt, stmt), [...line.stmt, ...rel]);
    }
    const { stmt, rel } = make(null);
    return insertLineAfter(s, line, stmt, rel);
  }
  const n = get(s.root, s.focus);
  const at = n.type === "Placeholder" ? s.focus : expressionPart(s.root, []);
  const tn = get(s.root, at);
  if (!isExpr(tn)) return s;
  const { stmt, rel } = make(tn.type === "Placeholder" ? null : tn);
  return refocus(s, set(s.root, at, { type: "Program", body: [stmt] }), [...at, 0, ...rel]);
}

/** `]`: a new line in a program, or a program around the selection. */
function programLine(s: EditorState): EditorState {
  const line = enclosingLine(s);
  if (line && !s.explicit) return insertLineAfter(s, line, exprStmt(ph()), [0]);
  const target = wrapTarget(s);
  const tn = get(s.root, target);
  if (!isExpr(tn)) return s;
  if (tn.type === "Placeholder") {
    return replaceAt(s, target, { type: "Program", body: [exprStmt(ph()), exprStmt(ph())] }, [0]);
  }
  return replaceAt(s, target, { type: "Program", body: [exprStmt(tn), exprStmt(ph())] }, [1]);
}

/**
 * The program statement or branch whose line `path` starts: `path` is on the left edge of it (its first
 * leaf is the statement's first leaf), so nothing of that line comes before it. Null otherwise.
 */
function lineStartedBy(root: Node, path: Path): Path | null {
  const sequence = caretGaps(root);
  const first = gapSpan(sequence, path)?.[0];
  if (first === undefined) return null;
  for (let len = path.length; len >= 1; len--) {
    const statement = path.slice(0, len);
    const node = get(root, statement);
    if (!STMTS.has(node.type) && node.type !== "Branch") continue;
    // A header's first editable slot follows its keyword and is also a line start.
    const outer = gapSpan(sequence, statement)?.[0];
    const editable = gapSpan(sequence, [...statement, 0])?.[0];
    return first === outer || first === editable ? statement : null;
  }
  return null;
}

/**
 * Shift+Enter in a program: with the caret at the start
 * of a line that is not empty, a new empty line is inserted above it; anywhere else, and on an empty
 * line, below it. The caret goes to the new line. The start of a line is the left edge of its first
 * token, or of a whole block statement; before an `else if` head the line goes at the end
 * of the branch above it.
 */
function programLineAround(s: EditorState): EditorState {
  const line = enclosingLine(s);
  if (!line) return s;
  const atLeft = s.caret ? s.caret.seg === 0 && s.caret.offset === 0 : s.side === "L";
  const started = atLeft ? lineStartedBy(s.root, s.focus) : null;
  const atStart = started !== null;
  if (started && get(s.root, started).type === "Branch" && lastIndex(started) > 0 && isPrefix(line.stmt, started)) {
    const previous = [...parentPath(started), lastIndex(started) - 1];
    const branch = get(s.root, previous);
    const body = [...branch.body, exprStmt(ph())];
    return refocus(s, set(s.root, previous, { ...branch, body }), [...previous, body.length, 0]);
  }
  if (!atStart || isPlaceholderLine(s.root, line)) return insertLineAfter(s, line, exprStmt(ph()), [0]);
  const owner = get(s.root, line.owner);
  const list = owner[line.key].slice();
  list.splice(line.at, 0, exprStmt(ph()));
  const root = set(s.root, line.owner, { ...owner, [line.key]: list });
  return refocus(s, root, [...line.owner, line.index, 0]);
}

function newProgramLine(s: EditorState): EditorState {
  const line = enclosingLine(s);
  return line ? insertLineAfter(s, line, exprStmt(ph()), [0]) : s;
}

function localAssign(s: EditorState): EditorState {
  const line = enclosingLine(s);
  // A parenthesis holding an expression becomes a parenthesised local definition
  // `(A ← e)`: selected as a whole or with the caret in it. A
  // parenthesis that is a whole program line keeps the statement form below.
  const focused = get(s.root, s.focus);
  const lineExpression = line !== null && s.focus.length === line.stmt.length + 1;
  if (!lineExpression && focused.type === "Paren" && focused.expr.type !== "InlineDef") {
    return parenDefinition(s, s.focus, focused.expr);
  }
  // In a call argument: an inline definition `f(A ← e)`.
  for (let len = s.focus.length; len >= 1; len--) {
    if (line && len <= line.stmt.length) break;
    const pp = s.focus.slice(0, len - 1);
    const parent = get(s.root, pp);
    const i = s.focus[len - 1];
    if (parent.type === "Call" && i >= 1 && parent.args[i - 1].type === "Expr") {
      const arg = parent.args[i - 1].expr;
      const args = parent.args.slice();
      args[i - 1] = { type: "InlineDef", target: arg, value: ph() };
      return refocus(s, set(s.root, pp, { ...parent, args }), [...pp, i, arg.type === "Placeholder" ? 0 : 1]);
    }
    if (parent.type === "Paren" && i === 0 && parent.expr.type !== "InlineDef") {
      return parenDefinition(s, pp, parent.expr);
    }
  }
  return lineStatement(s, (e) => ({ stmt: { type: "LocalDef", target: e ?? ph(), rhs: ph() }, rel: [e ? 1 : 0] }));
}

/** `(target ← □)` in the parenthesis at `at`: the definition is the parenthesis's content. */
function parenDefinition(s: EditorState, at: Path, target: Node): EditorState {
  const definition = { type: "InlineDef", target, value: ph() };
  return refocus(s, set(s.root, at, { type: "Paren", expr: definition }), [
    ...at,
    0,
    target.type === "Placeholder" ? 0 : 1,
  ]);
}

function ifStatement(s: EditorState): EditorState {
  return lineStatement(s, (e) => ({
    stmt: {
      type: "If",
      branches: [{ type: "Branch", kind: "if", cond: e ?? ph(), body: [exprStmt(ph())] }],
      else: null,
    },
    rel: e ? [0, 1] : [0, 0],
  }));
}

function whileStatement(s: EditorState): EditorState {
  return lineStatement(s, (e) => ({
    stmt: { type: "While", cond: e ?? ph(), body: [exprStmt(ph())] },
    rel: [e ? 1 : 0],
  }));
}

function forStatement(s: EditorState): EditorState {
  return lineStatement(s, (e) => {
    const variable = e && e.type === "Ident" ? e : null;
    return {
      stmt: { type: "For", var: variable ?? ph(), source: ph(), body: [exprStmt(ph())] },
      rel: [variable ? 1 : 0],
    };
  });
}

function tryStatement(s: EditorState): EditorState {
  return lineStatement(s, (e) => ({
    stmt: { type: "Try", body: [exprStmt(e ?? ph())], handler: [exprStmt(ph())] },
    rel: [e ? 1 : 0],
  }));
}

function returnStatement(s: EditorState): EditorState {
  return lineStatement(s, (e) => ({ stmt: { type: "Return", expr: e ?? ph() }, rel: [0] }));
}

function jumpStatement(s: EditorState, type: "Break" | "Continue"): EditorState {
  const line = enclosingLine(s);
  if (line && isPlaceholderLine(s.root, line)) return refocus(s, set(s.root, line.stmt, { type }), line.stmt);
  if (line) return insertLineAfter(s, line, { type }, []);
  return lineStatement(s, () => ({ stmt: { type }, rel: [] }));
}

/** else, else if, also if: a branch of the `if` before the current (empty) line or around it. */
function addBranch(s: EditorState, kind: "else" | "elseif" | "alsoif"): EditorState {
  let root = s.root;
  let ifPath: Path | null = null;
  const line = enclosingLine(s);
  if (line && isPlaceholderLine(root, line) && line.at > 0) {
    const previous = [...line.owner, line.index - 1];
    if (get(root, previous).type === "If") {
      ifPath = previous;
      const owner = get(root, line.owner);
      if (owner[line.key].length > 1) root = set(root, line.owner, withoutListItem(owner, line.key, line.at));
    }
  }
  if (!ifPath) {
    for (let len = s.focus.length; len >= 0; len--) {
      const p = s.focus.slice(0, len);
      if (get(root, p).type === "If") {
        ifPath = p;
        break;
      }
    }
    // An empty line just opened inside one of its bodies is where the user typed the
    // branch: it goes away.
    if (ifPath && line && isPlaceholderLine(root, line) && isPrefix(ifPath, line.owner)) {
      const owner = get(root, line.owner);
      if (owner[line.key].length > 1) root = set(root, line.owner, withoutListItem(owner, line.key, line.at));
    }
  }
  if (!ifPath) return s;
  const node = get(root, ifPath);
  const branches: Node[] = node.branches;
  if (kind === "else") {
    if (node.else) return refocus(s, root, leafPaths(root, [...ifPath, branches.length])[0]);
    root = set(root, ifPath, { ...node, else: [exprStmt(ph())] });
    return refocus(s, root, [...ifPath, branches.length, 0]);
  }
  // N6: after the first branch all are `else if` or all are `also if`.
  if (branches.slice(1).some((b) => b.kind !== kind)) return s;
  const branch = { type: "Branch", kind, cond: ph(), body: [exprStmt(ph())] };
  root = set(root, ifPath, { ...node, branches: [...branches, branch] });
  return refocus(s, root, [...ifPath, branches.length, 0]);
}

const PROGRAM_WORDS: Record<string, Command> = {
  if: "if",
  while: "while",
  for: "for",
  try: "try",
  return: "return",
  break: "break",
  continue: "continue",
  else: "else",
  otherwise: "else",
};

/** Ctrl+J: a program word typed as a name becomes the operator. */
function wordToOperator(s: EditorState): EditorState {
  const n = get(s.root, s.focus);
  if (n.type !== "Ident" || n.name.segments.length !== 1) return s;
  const cmd = PROGRAM_WORDS[n.name.segments[0].text];
  if (!cmd) return s;
  return runCommand(replaceAt(s, s.focus, ph(), []), cmd);
}

/**
 * The breakable operator whose right operand starts at the caret, the
 * innermost one: its path, or null. "Starts at the caret" means the caret is on the left edge of
 * the operand's first leaf (an empty placeholder counts), or the whole operand is the cursor with
 * the caret on its left.
 */
export function operatorBeforeCaret(s: EditorState): Path | null {
  if (s.explicit) return null;
  const token = adjacentToken(s.root, s, "L");
  return token?.kind === "join" && token.slot === 1 && SPLITTABLE.has(get(s.root, token.owner).type)
    ? token.owner : null;
}

/**
 * Enter right after a breakable operator breaks the line there: the operator gets its
 * equation break and the caret stays. Null when Enter is not after such an operator, or that
 * operator is already broken: Enter then leaves the region as usual.
 */
export function breakLineAtCaret(s: EditorState): EditorState | null {
  const p = operatorBeforeCaret(s);
  if (p === null) return null;
  const n = get(s.root, p);
  return n.split ? null : { ...s, root: set(s.root, p, { ...n, split: true }) };
}

/** Backspace at the start of a continuation line removes that break; null otherwise. */
export function joinLineAtCaret(s: EditorState): EditorState | null {
  const p = operatorBeforeCaret(s);
  if (p === null) return null;
  const n = get(s.root, p);
  return n.split ? { ...s, root: set(s.root, p, { ...n, split: false }) } : null;
}

// ---- presentation line breaks ------------------------------------------

/** Every node of the editing tree with its path, for serializing the break anchors. */
function pathsOf(root: Node): Map<Node, Path> {
  const paths = new Map<Node, Path>();
  for (const path of allPaths(root)) paths.set(get(root, path), path);
  return paths;
}

/** The wire form of the editor's break anchors, for the view and the commit. */
export function breakWires(root: Node, breaks: BreakAnchor[], forWire = true): { path: number[]; offset?: number }[] {
  const paths = pathsOf(root);
  const out: { path: number[]; offset?: number }[] = [];
  for (const anchor of breaks) {
    const path = paths.get(anchor.node);
    if (!path || path.length === 0) continue;
    const wirePath = forWire ? integralWirePath(root, path) : path;
    if (!wirePath) continue;
    out.push({ path: [...wirePath], ...(anchor.offset !== undefined ? { offset: anchor.offset } : {}) });
  }
  return out;
}

const sameBreakAnchor = (a: BreakAnchor, b: BreakAnchor): boolean => a.node === b.node && a.offset === b.offset;

/**
 * Keeps the breaks of an edit: a break is anchored to the node it precedes, and an
 * edit inside that node replaces it with a new one at the same place. A break whose node is gone moves
 * to the node now at its old path when that node is of the same kind and a line may start there.
 */
function followBreaks(prev: EditorState, next: EditorState): EditorState {
  if (prev.root === next.root || next.breaks.length === 0) return next;
  const now = pathsOf(next.root);
  if (next.breaks.every((anchor) => now.has(anchor.node))) return next;
  const before = pathsOf(prev.root);
  let moved = false;
  const breaks = next.breaks.map((anchor) => {
    if (now.has(anchor.node)) return anchor;
    const path = before.get(anchor.node);
    if (!path || path.length === 0) return anchor;
    let node: Node;
    try {
      node = get(next.root, path);
    } catch {
      return anchor;
    }
    if (node.type !== anchor.node.type || !canBreakBefore(next.root, path)) return anchor;
    moved = true;
    return anchor.offset !== undefined && node.type === "Str"
      ? { node, offset: Math.min(anchor.offset, node.text.length) }
      : { node };
  });
  return moved ? { ...next, breaks } : next;
}

/** The node a break may precede: not a statement, a target, a program line or a tail. */
function canBreakBefore(root: Node, path: Path): boolean {
  if (path.length === 0) return false;
  const node = get(root, path);
  if (
    STATEMENTS.has(node.type) ||
    STMTS.has(node.type) ||
    node.type === "Branch" ||
    node.type === "KeywordGroup" ||
    node.type === "InlineDef" ||
    node.type === "Eval" ||
    node.type === "Sym"
  ) {
    return false;
  }
  const parent = get(root, path.slice(0, -1));
  // The first token of a program line starts that line: no continuation line before it.
  if (lineStartedBy(root, path)) return false;
  // A definition's target is not a place for a continuation line.
  if ((parent.type === "Define" || parent.type === "GlobalDefine" || parent.type === "LocalDef") && lastIndex(path) === 0) {
    return false;
  }
  // An operator's own equation break already starts a new line at its right operand.
  if (lastIndex(path) === 1 && "split" in parent && parent.split) return false;
  return true;
}

/** A presentation break anchors before the node at the gap, or at a text offset in a string. */
export function breakTargetAtCaret(s: EditorState): BreakAnchor | null {
  const node = get(s.root, s.focus);
  if (node.type === "Str" && s.caret) return { node, offset: s.caret.offset };
  if (atStartOf({ ...s, explicit: false }, s.focus)) {
    return canBreakBefore(s.root, s.focus) ? { node } : null;
  }
  const token = adjacentToken(s.root, s, "R");
  if (token?.kind !== "join") return null;
  const next = [...token.owner, token.slot];
  return canBreakBefore(s.root, next) ? { node: get(s.root, next) } : null;
}

function applyBreak(s: EditorState, breaks: BreakAnchor[]): EditorState {
  return {
    ...s,
    breaks,
    past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
    future: [],
  };
}

/** The state with the explicit break at the caret added, or null when none can start there or it exists. */
export function explicitBreakAtCaret(s: EditorState): EditorState | null {
  if (s.matrixSelection || s.argSelection) return null;
  const target = breakTargetAtCaret(s);
  if (!target || s.breaks.some((anchor) => sameBreakAnchor(anchor, target))) return null;
  return applyBreak(s, [...s.breaks, target]);
}

/** Shift+Enter: a presentation-only line break at the caret. */
export function insertLineBreak(s: EditorState): EditorState {
  // Shift+Enter keeps its meaning in a symbolic keyword: a new keyword slot.
  const keyword = addKeyword(s);
  if (keyword !== s) return keyword;
  // Above the arrow Shift+Enter only adds keyword lines: an empty slot takes no break.
  if (s.focus.some((_, i) => get(s.root, s.focus.slice(0, i + 1)).type === "KeywordGroup")) return s;
  if (s.matrixSelection || s.argSelection) return s;
  const target = breakTargetAtCaret(s);
  if (!target || s.breaks.some((anchor) => sameBreakAnchor(anchor, target))) return s;
  return applyBreak(s, [...s.breaks, target]);
}

/**
 * Removes the break at the caret, for Backspace at the start of a continuation line or Delete at
 * the end of the line before it. Null when the caret is not on a break. The two directions look at
 * opposite edges of the break, so Backspace at the end of the previous line deletes math instead
 * of joining the lines.
 */
function removeBreakAtCaret(s: EditorState, direction: "back" | "forward"): EditorState | null {
  if (!s.breaks.length) return null;
  const focus = get(s.root, s.focus);
  const target = direction === "forward" ? breakTargetAtCaret(s) : null;
  const paths = direction === "back" ? pathsOf(s.root) : null;
  const onBreak = (anchor: BreakAnchor): boolean => {
    if (anchor.offset !== undefined) {
      return anchor.node === focus && !!s.caret && s.caret.offset === anchor.offset;
    }
    if (direction === "back") {
      const path = paths?.get(anchor.node);
      return !!path && atStartOf({ ...s, explicit: false }, path);
    }
    return !!target && target.node === anchor.node && target.offset === undefined;
  };
  const keep = s.breaks.filter((anchor) => !onBreak(anchor));
  return keep.length === s.breaks.length ? null : applyBreak(s, keep);
}

function toggleBreak(s: EditorState): EditorState {
  for (let len = s.focus.length; len >= 0; len--) {
    const p = s.focus.slice(0, len);
    const n = get(s.root, p);
    if (SPLITTABLE.has(n.type)) return { ...s, root: set(s.root, p, { ...n, split: !n.split }) };
  }
  return s;
}

/**
 * Toggles the glyph between the lower-slot index and its first value of the sum or product around
 * the caret: `i = lo` becomes `i := lo` and back. A sum
 * over a range variable has no bounds and is left alone.
 */
function toggleBoundGlyph(s: EditorState): EditorState {
  for (let len = s.focus.length; len >= 0; len--) {
    const p = s.focus.slice(0, len);
    const n = get(s.root, p);
    if ((n.type === "Sum" || n.type === "Prod") && n.bounds) {
      const bounds = n.bounds as Node;
      const glyph = bounds.glyph === "define" ? "equals" : "define";
      return { ...s, root: set(s.root, p, { ...n, bounds: { ...bounds, glyph } }) };
    }
  }
  return s;
}

// ---- calculus templates -------------------------------------------------------------------

const bounds = () => ({ lo: ph(), hi: ph() });

// ---- dispatch -----------------------------------------------------------------------------

export type Command =
  | "define" | "globalDefine" | "evaluate" | "symbolic"
  | "add" | "sub" | "mul" | "inlineDiv" | "cross" | "conv" | "circConv" | "polar" | "frac" | "pow"
  | "factorial" | "percent" | "permille" | "transpose" | "primeDeriv" | "abs" | "norm" | "conj" | "realPart" | "imagPart" | "vectorize" | "sqrt"
  | "less" | "greater" | "lessEq" | "greaterEq" | "notEq" | "range" | "scale" | "boolEq" | "element" | "and" | "or" | "not" | "xor"
  | "addBreak" | "subBreak" | "mulBreak" | "inlineDivBreak" | "toggleBreak" | "toggleBoundGlyph"
  | "insertLineBreak"
  | "bracket" | "matrix" | "column" | "row"
  | "sum" | "prod" | "integral" | "deriv" | "partial" | "gradient" | "limit" | "infinity"
  | "openParen" | "closeParen" | "comma" | "string" | "endString"
  | "greek" | "literalSubscript" | "label" | "unitLabel"
  | "grow" | "growLeft" | "growRight" | "flipSide" | "left" | "right" | "up" | "down" | "wordLeft" | "wordRight"
  | "home" | "end" | "nextPlaceholder" | "prevPlaceholder" | "backspace" | "delete"
  | "addRow" | "addRowAbove" | "addColumn" | "addColumnLeft" | "clearCells"
  | "deleteRow" | "deleteColumn" | "selectRow" | "selectColumn" | "nextCell" | "prevCell"
  | "programLine" | "newProgramLine" | "programLineAround" | "localAssign" | "if" | "else" | "elseIf" | "alsoIf"
  | "while" | "for" | "break" | "continue" | "return" | "try" | "wordToOperator"
  | "undo" | "redo";

/** Commands that the model runs; everything else in the keymap is for the window. */
export const MODEL_COMMANDS = new Set<string>([
  "define", "globalDefine", "evaluate", "symbolic", "add", "sub", "mul", "inlineDiv", "cross", "conv", "circConv", "polar", "frac", "pow",
  "factorial", "percent", "permille", "transpose", "primeDeriv", "abs", "norm", "conj", "realPart", "imagPart", "vectorize", "sqrt", "less", "greater",
  "lessEq", "greaterEq", "notEq", "range", "scale", "boolEq", "element", "and", "or", "not", "xor", "addBreak", "subBreak", "mulBreak",
  "inlineDivBreak", "toggleBreak", "insertLineBreak", "toggleBoundGlyph", "bracket", "matrix", "column", "row", "sum", "prod", "integral", "deriv",
  "partial", "gradient", "limit", "infinity", "openParen", "closeParen", "comma", "string", "endString", "greek",
  "literalSubscript", "label", "unitLabel", "grow", "growLeft", "growRight", "flipSide", "left", "right", "up", "down", "wordLeft",
  "wordRight", "home", "end", "nextPlaceholder", "prevPlaceholder", "backspace", "delete", "addRow",
  "addRowAbove", "addColumn", "addColumnLeft", "clearCells", "deleteRow", "deleteColumn", "selectRow", "selectColumn", "nextCell", "prevCell", "programLine", "newProgramLine", "programLineAround", "localAssign", "if", "else", "elseIf",
  "alsoIf", "while", "for", "break", "continue", "return", "try", "wordToOperator", "undo", "redo",
]);

/**
 * Drops empty name segments (left by Ctrl+- toggles) from every name except the one being
 * typed into, so that the tree stays normalized (N3) once the caret leaves a name.
 */
function cleanNames(s: EditorState): EditorState {
  let root = s.root;
  for (const p of allPaths(root)) {
    const n = get(root, p);
    if (n.type !== "Ident") continue;
    const segments: { text: string }[] = n.name.segments;
    if (segments.length < 2 || !segments.some((x, i) => i > 0 && x.text === "")) continue;
    if (samePath(p, s.focus) && s.caret) continue;
    const kept = segments.filter((x, i) => i === 0 || x.text !== "");
    root = set(root, p, { ...n, name: { ...n.name, segments: kept } });
  }
  return root === s.root ? s : { ...s, root };
}

function snapshot(s: EditorState): Snapshot {
  return { root: s.root, focus: s.focus, side: s.side, caret: s.caret, explicit: s.explicit, breaks: s.breaks };
}

function restore(s: EditorState, snap: Snapshot): EditorState {
  return { ...s, ...snap, growOrigin: null, matrixSelection: undefined, cellMirror: undefined, argSelection: undefined, termSelection: undefined, definitionOnly: undefined };
}

/**
 * Invariant: a statement (the root) and a program line are never a bare Placeholder, which the
 * renderer has no view for. A bare one (what deleting the last operand can leave) becomes the
 * normal wrapper, `ExprRegion` / `ExprStmt` around the placeholder; both are transparent, so the
 * focus lands on the placeholder itself.
 */
function fixStatements(s: EditorState): EditorState {
  let root = s.root;
  let focus = s.focus;
  if (root.type === "Placeholder") {
    root = emptyStatement();
    focus = focus.length === 0 ? [0] : focus;
  } else {
    for (const path of leafPaths(root)) {
      if (path.length === 0 || get(root, path).type !== "Placeholder") continue;
      const key = childListKey(get(root, parentPath(path)), lastIndex(path))?.key;
      if (key !== "body" && key !== "else" && key !== "handler") continue;
      root = set(root, path, exprStmt(ph()));
      if (samePath(focus, path)) focus = [...path, 0];
    }
  }
  return root === s.root ? s : { ...s, root, focus: normalizeFocus(root, focus) };
}

/** Runs one command and records an undo step when the tree changed. */
export function apply(s: EditorState, run: (s: EditorState) => EditorState): EditorState {
  const next = followBreaks(s, fixStatements(cleanNames(run(s))));
  if (next.root === s.root) return next;
  return { ...next, past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT), future: [] };
}

function undo(s: EditorState): EditorState {
  const previous = s.past[s.past.length - 1];
  if (!previous) return s;
  return { ...restore(s, previous), past: s.past.slice(0, -1), future: [...s.future, snapshot(s)] };
}

function redo(s: EditorState): EditorState {
  const next = s.future[s.future.length - 1];
  if (!next) return s;
  return { ...restore(s, next), past: [...s.past, snapshot(s)], future: s.future.slice(0, -1) };
}

function runRaw(s: EditorState, cmd: Command): EditorState {
  switch (cmd) {
    case "define": return equalsForProduct(s, "Define") ?? define(s, "Define");
    case "globalDefine": return equalsForProduct(s, "GlobalDefine") ?? define(s, "GlobalDefine");
    case "evaluate": return combineRelation(s, "=") ?? evaluate(s, false);
    case "symbolic": return symbolicArrow(s);
    case "add": return insertBinary(s, "Add");
    case "sub": return insertBinary(s, "Sub");
    case "mul": return insertBinary(s, "Mul");
    case "inlineDiv": return insertBinary(s, "InlineDiv");
    case "cross": return insertBinary(s, "Cross");
    // the reference application's convolution operators, from the palette.
    case "conv": return insertBinary(s, "Conv");
    case "circConv": return insertBinary(s, "CircConv");
    // the reference application's polar operator, from the palette.
    case "polar": return insertBinary(s, "Polar");
    case "addBreak": return insertBinary(s, "Add", true);
    case "subBreak": return insertBinary(s, "Sub", true);
    case "mulBreak": return insertBinary(s, "Mul", true);
    case "inlineDivBreak": return insertBinary(s, "InlineDiv", true);
    case "toggleBreak": return toggleBreak(s);
    case "insertLineBreak": return insertLineBreak(s);
    case "toggleBoundGlyph": return toggleBoundGlyph(s);
    case "less": return insertBinary(s, "Lt");
    case "greater": return combineRelation(s, ">") ?? insertBinary(s, "Gt");
    case "lessEq": return insertBinary(s, "Le");
    // Not equal, range and the reference application's scaling operator (the implicit product), from the palette.
    case "notEq": return insertBinary(s, "Ne");
    case "range": return rangeFrom(s);
    case "scale": return insertBinary(s, "Juxt");
    case "greaterEq": return insertBinary(s, "Ge");
    case "boolEq": return equalsForProduct(s, "Eq") ?? insertBinary(s, "Eq");
    case "element": return insertBinary(s, "In");
    case "and": return insertBinary(s, "And");
    case "or": return insertBinary(s, "Or");
    case "xor": return insertBinary(s, "Xor");
    case "not": return wrapWith(s, (x) => ({ type: "Not", expr: x }));
    case "pow": return fillOperatorGap(s, "Pow") ?? wrapBox(s, (x) => ({ type: "Pow", left: x, right: ph() }), 1);
    case "frac": return fillOperatorGap(s, "Div") ?? wrapBox(s, (x) => ({ type: "Div", left: x, right: ph() }), 1);
    case "factorial": return wrapWith(s, (x) => ({ type: "Factorial", expr: x }));
    // The % key and the palette apply the percent, the palette the per mille.
    case "percent": return wrapWith(s, (x) => ({ type: "Percent", expr: x }));
    case "permille": return wrapWith(s, (x) => ({ type: "Permille", expr: x }));
    case "transpose": return wrapWith(s, (x) => ({ type: "Transpose", expr: x }));
    case "primeDeriv":
      // The prime differentiates a function before it is called: f′(x) (MX-CALL).
      return wrapWith(s, (x) =>
        x.type === "PrimeDeriv" ? { ...x, order: x.order + 1 } : { type: "PrimeDeriv", function: x, order: 1 },
        s.explicit ? expressionPart(s.root, s.focus) : s.focus,
      );
    case "abs": return wrapWith(s, (x) => ({ type: "Abs", expr: x }));
    case "norm": return wrapWith(s, (x) => ({ type: "Norm", expr: x }));
    case "conj": return wrapWith(s, (x) => ({ type: "Conj", expr: x }));
    // The real and imaginary part operators, from the Operators palette.
    case "realPart": return wrapWith(s, (x) => ({ type: "RealPart", expr: x }));
    case "imagPart": return wrapWith(s, (x) => ({ type: "ImagPart", expr: x }));
    case "vectorize": return wrapWith(s, (x) => ({ type: "Vectorize", expr: x }));
    case "sqrt": return wrapWith(s, (x) => ({ type: "Root", index: null, radicand: x }));
    case "bracket":
      return get(s.root, s.focus).type === "Placeholder"
        ? insertMatrix(s)
        : wrapBox(s, (x) => ({ type: "Index", base: x, indices: [ph()] }), 1);
    case "matrix": return insertMatrix(s);
    case "column": return wrapBox(s, (x) => ({ type: "Column", base: x, index: ph() }), 1);
    case "row": return wrapBox(s, (x) => ({ type: "Row", base: x, index: ph() }), 1);
    case "sum": return wrapWith(s, (x) => ({ type: "Sum", var: ph(), bounds: bounds(), body: x }));
    case "prod": return wrapWith(s, (x) => ({ type: "Prod", var: ph(), bounds: bounds(), body: x }));
    case "integral":
      return wrapWith(s, (x) => ({ type: "Integral", var: ph(), bounds: bounds(), algorithm: null, body: x }));
    case "deriv": return wrapWith(s, (x) => ({ type: "Deriv", var: ph(), order: null, body: x }));
    case "partial": return wrapWith(s, (x) => ({ type: "Partial", var: ph(), order: null, body: x }));
    // The gradient, from the palette: the variable first, the operand as its body.
    case "gradient": return wrapWith(s, (x) => ({ type: "Gradient", vars: [ph()], body: x }));
    case "limit": return wrapWith(s, (x) => ({ type: "Limit", var: ph(), target: ph(), side: "both", body: x }));
    case "infinity": return typeChar(s, "∞");
    case "openParen": return openParen(s);
    case "closeParen": return closeParen(s);
    case "comma": return comma(s);
    case "string": return startString(s);
    case "endString": return endString(s);
    case "greek": return greek(s);
    case "literalSubscript": return literalSubscript(s);
    case "label": return cycleLabel(s);
    case "unitLabel": return unitLabel(s);
    case "grow": return grow(s);
    case "growLeft": return shiftMove(s, "L");
    case "growRight": return shiftMove(s, "R");
    case "flipSide": return flipSide(s);
    case "left": return moveH(s, "L");
    case "right": return moveH(s, "R");
    case "up": return moveVertical(s, -1);
    case "down": return moveVertical(s, 1);
    case "wordLeft": return wordMove(s, "L");
    case "wordRight": return wordMove(s, "R");
    case "home": return home(s);
    case "end": return end(s);
    case "nextPlaceholder": return nextPlaceholder(s, 1);
    case "prevPlaceholder": return nextPlaceholder(s, -1);
    case "backspace":
      return s.matrixSelection ? deleteMatrixSelection(s) : s.argSelection ? deleteRun(s) : s.termSelection ? replaceTerms(s, null) : backspace(s);
    case "delete":
      return s.matrixSelection ? deleteMatrixSelection(s) : s.argSelection ? deleteRun(s) : s.termSelection ? replaceTerms(s, null) : deleteForward(s);
    case "addRow": return addRow(s);
    case "addRowAbove": return addRowAbove(s);
    case "addColumn": return addColumn(s);
    case "addColumnLeft": return addColumnLeft(s);
    case "clearCells": return clearMatrixCells(s);
    case "deleteRow": return deleteMatrixAxis(s, "row");
    case "deleteColumn": return deleteMatrixAxis(s, "column");
    case "selectRow": return selectMatrixAxis(s, "row");
    case "selectColumn": return selectMatrixAxis(s, "column");
    case "nextCell": return moveCell(s, 1, true);
    case "prevCell": return moveCell(s, -1);
    case "programLine": return programLine(s);
    case "newProgramLine": return newProgramLine(s);
    case "programLineAround": return programLineAround(s);
    case "localAssign": return localAssign(s);
    case "if": return ifStatement(s);
    case "else": return addBranch(s, "else");
    case "elseIf": return addBranch(s, "elseif");
    case "alsoIf": return addBranch(s, "alsoif");
    case "while": return whileStatement(s);
    case "for": return forStatement(s);
    case "try": return tryStatement(s);
    case "return": return returnStatement(s);
    case "break": return jumpStatement(s, "Break");
    case "continue": return jumpStatement(s, "Continue");
    case "wordToOperator": return wordToOperator(s);
    case "undo": return undo(s);
    case "redo": return redo(s);
  }
}

/** Commands that act on the selection itself, so they still see it; every other one drops it. */
const KEEPS_MATRIX_SELECTION = new Set<Command>(["delete", "backspace", "clearCells", "unitLabel"]);
/** `Shift+←/→` extend a run and `←/→` collapse it; Backspace and Delete remove its arguments. */
const KEEPS_ARG_SELECTION = new Set<Command>(["delete", "backspace", "growLeft", "growRight", "left", "right", "unitLabel"]);
const KEEPS_TERM_SELECTION = new Set<Command>(["delete", "backspace", "grow", "growLeft", "growRight", "left", "right", "unitLabel"]);

export function runCommand(s: EditorState, cmd: Command): EditorState {
  if (cmd === "undo" || cmd === "redo") return runRaw(s, cmd);
  const current: EditorState = {
    ...s,
    matrixSelection: KEEPS_MATRIX_SELECTION.has(cmd) ? s.matrixSelection : undefined,
    argSelection: KEEPS_ARG_SELECTION.has(cmd) ? s.argSelection : undefined,
    termSelection: KEEPS_TERM_SELECTION.has(cmd) ? s.termSelection : undefined,
    shiftDrag: cmd === "left" || cmd === "right" || cmd === "growLeft" || cmd === "growRight" ? s.shiftDrag : undefined,
    definitionOnly: cmd === "grow" || cmd === "growLeft" || cmd === "growRight" || cmd === "unitLabel"
      ? s.definitionOnly : undefined,
  };
  return apply(current, (x) => mirror(runRaw(x, cmd), x.cellMirror));
}

/**
 * Enter in a math region: right after a breakable operator it breaks the line there, as
 * one undo step; null when Enter should leave the region instead.
 */
export function enterInMath(s: EditorState): EditorState | null {
  return breakLineAtCaret(s) ? apply(s, (x) => breakLineAtCaret(x) ?? x) : null;
}

/** Types one character (with an undo step). */
export function typeCharacter(s: EditorState, ch: string): EditorState {
  return apply({ ...s, shiftDrag: undefined }, (start) => {
    const x = startMirror(start) ?? { ...start, matrixSelection: undefined };
    return mirror(x.argSelection ? typeChar(replaceRun(x, exprArg(ph())), ch) : x.termSelection ? typeChar(replaceTerms(x, ph()), ch) : typeChar(x, ch), x.cellMirror);
  });
}

/**
 * Inserts palette/autocomplete text as one local undo step. With a `label`, the name the typing ends
 * on carries it: the Units palette and the unit autocomplete insert `m@unit`, because a plain name in
 * a value position is a name and never a unit. A selected run of call
 * arguments is replaced by one argument first.
 */
export function typeText(s: EditorState, text: string, label: string | null = null): EditorState {
  return apply(s, (before) => {
    const current = startMirror(before) ?? { ...before, matrixSelection: undefined };
    const start = current.argSelection ? replaceRun(current, exprArg(ph())) : current.termSelection ? replaceTerms(current, ph()) : current;
    const typed = [...text].reduce(typeChar, start);
    if (!label) return mirror(typed, current.cellMirror);
    const n = get(typed.root, typed.focus);
    return mirror(
      n.type === "Ident"
        ? { ...typed, root: set(typed.root, typed.focus, { ...n, name: { ...n.name, label } }) }
        : typed,
      current.cellMirror,
    );
  });
}

/** Inserts a matrix of a chosen size (Ctrl+M dialog), with an undo step. */
export function insertMatrixSized(s: EditorState, rows: number, cols: number): EditorState {
  return apply(s, (x) => insertMatrix(x, rows, cols));
}

/**
 * Adds a symbolic keyword (`simplify`, `solve`, ...) or, with `modifier`, a modifier
 * (`ALL`, `real`, ...) to the keyword list of the statement's `→`; a plain expression or
 * definition is first turned into a symbolic evaluation. A modifier needs an existing
 * keyword and is appended to the last one. One undo step.
 */
export function insertSymbolicKeyword(s: EditorState, name: string, modifier = false): EditorState {
  return apply(s, (x) => {
    let cur = x;
    if (cur.root.type === "ExprRegion" || (cur.root.type === "Define" && !cur.root.tail)) {
      cur = evaluate(cur, true);
    }
    const r = cur.root;
    let list: Node[];
    let first: number;
    if (r.type === "Symbolic") {
      list = r.keywords;
      first = 1;
    } else if (r.type === "Define" && r.tail?.type === "Sym") {
      list = r.tail.keywords;
      first = 2;
    } else {
      return x;
    }
    let keywords: Node[];
    let path: Path;
    const slot = list.length > 0 && isEmptyKeywordGroup(list[list.length - 1]);
    if (modifier) {
      if (list.length === 0 || slot) return x;
      const last = list[list.length - 1];
      keywords = [...list.slice(0, -1), { ...last, args: [...last.args, ident(name)] }];
      path = [first + list.length - 1, last.args.length + 1];
    } else if (slot) {
      // The empty slot above the arrow takes the keyword.
      keywords = [...list.slice(0, -1), { type: "KeywordGroup", keyword: ident(name), args: [] }];
      path = [first + list.length - 1, 0];
    } else {
      keywords = [...list, { type: "KeywordGroup", keyword: ident(name), args: [] }];
      path = [first + list.length, 0];
    }
    const root: Node = r.type === "Symbolic" ? { ...r, keywords } : { ...r, tail: { ...r.tail, keywords } };
    return refocus(cur, root, path);
  });
}

// ---- clipboard and mouse selection ---------------------------------------------------------

/**
 * What copy takes: the node enclosed by the editing lines (the selection, or the node at the caret).
 * Selected cells of a matrix are the smaller matrix they form, in their own rows and columns.
 */
export function selectedNode(s: EditorState): Node {
  const terms = selectedTerms(s);
  if (terms) return terms;
  if (s.definitionOnly && s.focus.length === 0 && evaluatedDefinition(s.root)) return { ...s.root, tail: null };
  const selection = s.matrixSelection;
  if (selection) {
    const matrix = get(s.root, selection.path);
    if (matrix.type === "Matrix") {
      const cells = selectedMatrixCells(matrix.rows, matrix.cols, selection);
      const rows = new Set(cells.map((i) => Math.floor(i / matrix.cols))).size;
      return { type: "Matrix", rows, cols: cells.length / rows, cells: cells.map((i) => matrix.cells[i]) };
    }
  }
  return get(s.root, s.focus);
}

/**
 * Whether the selected node can be copied on its own as an expression, a whole statement, or program
 * lines: a program statement (an `if`, `for`, `while` or `try` block, a line) or one branch of an `if`
 * travels as a program holding it.
 */
export function copyKind(s: EditorState): "statement" | "expr" | "program" | null {
  const n = selectedNode(s);
  if (s.focus.length === 0 && STATEMENTS.has(n.type)) return "statement";
  if (STMTS.has(n.type) || n.type === "Branch") return isPlaceholderStmt(n) ? null : "program";
  if (isExpr(n) && n.type !== "Placeholder") return "expr";
  return null;
}

const isPlaceholderStmt = (n: Node): boolean => n.type === "ExprStmt" && n.expr.type === "Placeholder";

/**
 * The selected program statement as a program of one line. A branch is copied as an `if` block: the
 * first branch on its own; an `else if` (or `also if`) keeps its kind under an empty `if` to be filled
 * in, since it cannot stand alone.
 */
export function selectedProgram(s: EditorState): Node {
  const n = selectedNode(s);
  if (n.type !== "Branch") return { type: "Program", body: [n] };
  const branches = n.kind === "if" ? [n] : [{ type: "Branch", kind: "if", cond: ph(), body: [exprStmt(ph())] }, n];
  return { type: "Program", body: [{ type: "If", branches, else: null }] };
}

/**
 * Paste of program lines (a pasted program) on a line of a program: they replace an empty line, or
 * go below the line of the caret. Null outside a program, where the program is pasted as an
 * expression instead.
 */
export function pasteProgramLines(s: EditorState, program: Node): EditorState | null {
  const line = enclosingLine(s);
  if (!line || program.type !== "Program" || program.body.length === 0) return null;
  return apply(s, (x) => {
    const owner = get(x.root, line.owner);
    const list = owner[line.key].slice();
    const empty = isPlaceholderLine(x.root, line);
    list.splice(empty ? line.at : line.at + 1, empty ? 1 : 0, ...program.body);
    const root = set(x.root, line.owner, { ...owner, [line.key]: list });
    const last = [...line.owner, line.index + (empty ? 0 : 1) + program.body.length - 1];
    const leaves = leafPaths(root, last);
    return refocus(x, root, leaves[leaves.length - 1], "R");
  });
}

/**
 * Paste of an expression: it replaces the selection or an empty placeholder; a plain name or
 * number is typed into the name or number at the caret. Anywhere else there is no target
 * (null): the caller tells the user to select something first.
 */
export function pasteExpr(s: EditorState, expr: Node): EditorState | null {
  const n = get(s.root, s.focus);
  if (n.type === "Placeholder" || (s.explicit && isExpr(n))) {
    return apply(s, (x) => replaceAt(x, x.focus, expr, null));
  }
  if (isText(n) && s.caret && (expr.type === "Num" || (expr.type === "Ident" && expr.name.segments.length === 1))) {
    const text = expr.type === "Num" ? expr.text : expr.name.segments[0].text;
    return typeText(s, text);
  }
  return null;
}

/** Paste of a whole statement: only into an empty region. */
export function pasteStatement(s: EditorState, statement: Node): EditorState | null {
  if (s.root.type !== "ExprRegion" || s.root.expr.type !== "Placeholder") return null;
  return apply(s, (x) => refocus(x, statement, [], "R"));
}

/**
 * Mouse drag from `from` to `to` (paths of the pressed and the current node): the selection is
 * the smallest node that contains both ends; the same node (or a click) is a selection of that
 * node, so dragging inside a name selects the name.
 */
export function selectRange(s: EditorState, from: Path, to: Path): EditorState {
  s = { ...s, cellMirror: undefined };
  const common: number[] = [];
  for (let i = 0; i < Math.min(from.length, to.length) && from[i] === to[i]; i++) common.push(from[i]);
  const owner = get(s.root, common);
  if (owner.type === "Matrix" && from.length > common.length && to.length > common.length) {
    const a = from[common.length];
    const b = to[common.length];
    const rowA = Math.floor(a / owner.cols);
    const colA = a % owner.cols;
    const rowB = Math.floor(b / owner.cols);
    const colB = b % owner.cols;
    const firstRow = Math.min(rowA, rowB);
    const firstColumn = Math.min(colA, colB);
    const lastRow = Math.max(rowA, rowB);
    const lastColumn = Math.max(colA, colB);
    const first = firstRow * owner.cols + firstColumn;
    const last = lastRow * owner.cols + lastColumn;
    const isRow = owner.cols > 1 && firstRow === lastRow && firstColumn === 0 && lastColumn === owner.cols - 1;
    const isColumn = owner.rows > 1 && firstColumn === lastColumn && firstRow === 0 && lastRow === owner.rows - 1;
    const selected = refocus(s, s.root, [...common, first], "R");
    if (isRow || isColumn) {
      return { ...selected, matrixSelection: { path: common, axis: isRow ? "row" : "column", index: isRow ? firstRow : firstColumn } };
    }
    return { ...selected, matrixSelection: { path: common, axis: "range", index: first, end: last } };
  }
  if (owner.type === "Call" && from.length > common.length && to.length > common.length) {
    const a = from[common.length];
    const b = to[common.length];
    // Both ends inside arguments (child 0 is the callee): the run between them, not the whole call
    //. A drag that starts or ends in the callee keeps the whole call, below.
    if (a >= 1 && b >= 1) {
      const first = Math.min(a, b) - 1;
      const last = Math.max(a, b) - 1;
      const selected = withArgs(s, common, owner.args, first, true);
      return { ...selected, argSelection: { path: common, first, last } };
    }
  }
  // From the target to the right-hand side of `a := f =`: the definition without its evaluation.
  if (common.length === 0 && evaluatedDefinition(s.root) && from.length > 0 && to.length > 0 && (from[0] === 0 || from[0] === 1) && (to[0] === 0 || to[0] === 1)) {
    return { ...refocus(s, s.root, [], "R", true), definitionOnly: true };
  }
  // Both ends in different terms of a chain: the terms between them.
  if (chainFamily(owner) && from.length > common.length && to.length > common.length) {
    const top = chainTop(s.root, common);
    const count = chainTerms(get(s.root, top)).length;
    const a = termIndex(top, count, from);
    const b = termIndex(top, count, to);
    if (a !== b) return selectTerms(s, { top, count, first: Math.min(a, b), last: Math.max(a, b) }, b >= a ? "R" : "L");
  }
  return refocus(s, s.root, common, "R", true);
}
