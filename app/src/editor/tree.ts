// The tree the math editor works on: the canonical AST in its Rust JSON shape
// (`core/src/ast.rs`, serde form), with a uniform child view so that a selection is a
// path of child indices (as in spike C).
//
// Editing form (`toEditing`): the wire AST with three liberties, so that every slot can
// hold a placeholder while the user types and every node has a `type`:
//  - targets (left of `:=`, `≡`, `←`, inline definitions) are expressions: `Ident`,
//    `Index`, `Column`, `Row` keep their shape, `Paren{target}` becomes `Paren{expr}`,
//    `Destructure` becomes `Matrix`, `FunctionHead` becomes `Call`;
//  - binder names (`∑ ∏ ∫ ⅆ ∂ lim` variables, `for` variables, symbolic keywords) get
//    `type: "Ident"`;
//  - `if` branches and keyword groups get `type: "Branch"` / `"KeywordGroup"`.
// `toWire` reverses this before the statement is sent to Rust, which normalizes,
// prints and parses it (the Rust side stays the authority on the syntax).

import type { Node } from "../math/ast";

export type { Node };
export type Path = readonly number[];
type Step = string | number;

// ---- constructors -------------------------------------------------------------------------

export const ph = (): Node => ({ type: "Placeholder" });
export const num = (text: string): Node => ({ type: "Num", text });
export const ident = (text: string): Node => ({
  type: "Ident",
  name: { segments: [{ text, subscript: false }], label: null },
});
export const exprStmt = (expr: Node): Node => ({ type: "ExprStmt", expr });
export const exprArg = (expr: Node): Node => ({ type: "Expr", expr });

/** A fresh math region: one placeholder. */
export const emptyStatement = (): Node => ({ type: "ExprRegion", expr: ph() });

// ---- classification -----------------------------------------------------------------------

/** Binary operators with their precedence level (math-syntax section 5). */
export const BINARY_LEVEL: Record<string, number> = {
  Or: 3,
  Xor: 3,
  And: 4,
  Eq: 6,
  Ne: 6,
  Lt: 6,
  Gt: 6,
  Le: 6,
  Ge: 6,
  In: 6,
  Add: 7,
  Sub: 7,
  Mul: 8,
  InlineDiv: 8,
  Cross: 8,
  Conv: 8,
  CircConv: 8,
  // The polar form sits between + and ·.
  Polar: 7.5,
  Juxt: 8,
};

/** Operators that may carry an equation break (`split`, N8). */
export const SPLITTABLE = new Set(["Add", "Sub", "Mul", "InlineDiv"]);

export const UNARY = new Set([
  "Paren",
  "Neg",
  "Not",
  "Factorial",
  "Percent",
  "Permille",
  "Transpose",
  "Conj",
  "RealPart",
  "ImagPart",
  "Abs",
  "Det",
  "Norm",
  "Vectorize",
]);

export const BIG_OPS = new Set(["Sum", "Prod", "Integral", "Deriv", "Partial", "Gradient", "Limit"]);

/** Region statements (the root of the tree). */
export const STATEMENTS = new Set(["Define", "GlobalDefine", "Evaluate", "Symbolic", "ExprRegion"]);

/** Program statements: the elements of a body list. */
export const STMTS = new Set([
  "LocalDef",
  "If",
  "For",
  "While",
  "Break",
  "Continue",
  "Return",
  "Try",
  "ExprStmt",
]);

const LEAVES = new Set(["Num", "Imag", "Str", "Placeholder", "Ident", "Break", "Continue"]);

export const isLeaf = (n: Node): boolean => LEAVES.has(n.type);
/** Leaves whose text is typed character by character. */
export const isText = (n: Node): boolean =>
  n.type === "Ident" || n.type === "Num" || n.type === "Str" || n.type === "Imag";

export function textParts(n: Node): string[] {
  switch (n.type) {
    case "Ident":
      return n.name.segments.map((s: { text: string }) => s.text);
    case "Num":
    case "Str":
      return [n.text];
    case "Imag":
      return [n.text + n.symbol];
    default:
      return [];
  }
}

/**
 * Nodes that look exactly like their only child: the editing lines never stop on them
 * (a selection on them is a selection on the child).
 */
export const isTransparent = (n: Node): boolean => n.type === "ExprRegion" || n.type === "ExprStmt";

// ---- uniform children ---------------------------------------------------------------------

/** Relative JSON paths of the navigable children, in reading order. */
export function childRefs(n: Node): Step[][] {
  const list = (key: string, items: unknown[] | null | undefined): Step[][] =>
    (items ?? []).map((_, i) => [key, i]);
  const args = (items: Node[]): Step[][] =>
    items.map((arg, i) => (arg.type === "Expr" ? ["args", i, "expr"] : ["args", i]));
  if (BINARY_LEVEL[n.type] !== undefined || n.type === "Div" || n.type === "Pow") {
    return [["left"], ["right"]];
  }
  if (UNARY.has(n.type)) return [["expr"]];
  switch (n.type) {
    case "Define": {
      const refs: Step[][] = [["target"], ["rhs"]];
      if (n.tail?.type === "Eval" && n.tail.unit) refs.push(["tail", "unit"]);
      if (n.tail?.type === "Sym") n.tail.keywords.forEach((_: unknown, i: number) => refs.push(["tail", "keywords", i]));
      return refs;
    }
    case "GlobalDefine":
      return [["target"], ["rhs"]];
    case "Evaluate":
      return n.unit ? [["expr"], ["unit"]] : [["expr"]];
    case "Symbolic":
      return [["expr"], ...list("keywords", n.keywords)];
    case "ExprRegion":
    case "ExprStmt":
    case "Return":
      return [["expr"]];
    // a table is edited through its grid, a matrix.
    case "Table":
      return [["grid"]];
    case "KeywordGroup":
      return [["keyword"], ...list("args", n.args)];
    case "Root":
      return n.index ? [["index"], ["radicand"]] : [["radicand"]];
    case "Call":
      return [["callee"], ...args(n.args)];
    case "JuliaCall":
      return args(n.args);
    case "InlineDef":
    case "LocalDef":
      return n.type === "InlineDef" ? [["target"], ["value"]] : [["target"], ["rhs"]];
    case "Index":
      return [["base"], ...list("indices", n.indices)];
    case "Column":
    case "Row":
      return [["base"], ["index"]];
    case "PrimeDeriv":
      return [["function"]];
    case "Matrix":
      return list("cells", n.cells);
    case "Range":
      return n.second ? [["first"], ["second"], ["last"]] : [["first"], ["last"]];
    case "Sum":
    case "Prod":
      return n.bounds ? [["var"], ["bounds", "lo"], ["bounds", "hi"], ["body"]] : [["var"], ["body"]];
    case "Integral":
      return n.bounds ? [["bounds", "lo"], ["bounds", "hi"], ["body"], ["var"]] : [["body"], ["var"]];
    case "Deriv":
    case "Partial":
      return n.order ? [["var"], ["order"], ["body"]] : [["var"], ["body"]];
    // The gradient: its variables, then the body.
    case "Gradient":
      return [...list("vars", n.vars), ["body"]];
    case "Limit":
      return [["var"], ["target"], ["body"]];
    case "Program":
      return list("body", n.body);
    case "If":
      return [...list("branches", n.branches), ...list("else", n.else)];
    case "Branch":
      return [["cond"], ...list("body", n.body)];
    case "For":
      return [["var"], ["source"], ...list("body", n.body)];
    case "While":
      return [["cond"], ...list("body", n.body)];
    case "Try":
      return [...list("body", n.body), ...list("handler", n.handler)];
    default:
      return [];
  }
}

function getRel(n: unknown, rel: Step[]): Node {
  let value = n as Record<string | number, unknown>;
  for (const step of rel) value = value[step] as Record<string | number, unknown>;
  return value as unknown as Node;
}

function setRel(n: unknown, rel: Step[], child: unknown): Node {
  if (rel.length === 0) return child as Node;
  const [step, ...rest] = rel;
  if (Array.isArray(n)) {
    const copy = n.slice();
    copy[step as number] = setRel(copy[step as number], rest, child);
    return copy as unknown as Node;
  }
  const obj = n as Record<string, unknown>;
  return { ...obj, [step]: setRel(obj[step as string], rest, child) } as Node;
}

export function children(n: Node): Node[] {
  return childRefs(n).map((rel) => getRel(n, rel));
}

export function withChild(n: Node, index: number, child: Node): Node {
  const rel = childRefs(n)[index];
  if (!rel) throw new Error(`${n.type} has no child ${index}`);
  return setRel(n, rel, child);
}

export function get(root: Node, path: Path): Node {
  let n = root;
  for (const i of path) {
    const c = children(n);
    if (i < 0 || i >= c.length) throw new Error(`bad path ${path.join(".")} at ${n.type}`);
    n = c[i];
  }
  return n;
}

export function tryGet(root: Node, path: Path): Node | null {
  try {
    return get(root, path);
  } catch {
    return null;
  }
}

export function set(root: Node, path: Path, value: Node): Node {
  if (path.length === 0) return value;
  const [i, ...rest] = path;
  return withChild(root, i, set(children(root)[i], rest, value));
}

/** The JSON key of the list a child lives in (`body`, `else`, `args`, ...), or null. */
export function childListKey(n: Node, index: number): { key: string; at: number } | null {
  const rel = childRefs(n)[index];
  if (!rel || rel.length < 2 || typeof rel[1] !== "number" || rel[0] === "tail" || rel[0] === "bounds") return null;
  return { key: rel[0] as string, at: rel[1] };
}

export const parentPath = (p: Path): Path => p.slice(0, -1);
export const lastIndex = (p: Path): number => p[p.length - 1];
export const samePath = (a: Path, b: Path): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
export const isPrefix = (prefix: Path, p: Path): boolean =>
  prefix.length <= p.length && prefix.every((x, i) => x === p[i]);

/** Leaf paths in reading order (left to right, top to bottom). */
export function leafPaths(root: Node, base: Path = []): Path[] {
  const n = get(root, base);
  if (isLeaf(n)) return [base];
  return children(n).flatMap((_, i) => leafPaths(root, [...base, i]));
}

/** Every node path, parents before children. */
export function allPaths(root: Node, base: Path = []): Path[] {
  const n = get(root, base);
  return [base, ...children(n).flatMap((_, i) => allPaths(root, [...base, i]))];
}

// ---- precedence ---------------------------------------------------------------------------

/** The operators whose operands the view wraps in parentheses by precedence (render.tsx `operand`). */
const DRAWN_PAREN_OWNERS = new Set(["Add", "Sub", "Mul", "InlineDiv", "Juxt"]);

/**
 * The editing tree with a real parenthesis wherever the view draws one by precedence alone (the right
 * operand `1 + 2·b` of `a + (1 + 2·b)`, a sum multiplied), as a tree from the core, a symbolic result or
 * an import may come without them. In the editor they then behave as typed ones: Backspace removes
 * them and the arrows stop on them. Nothing else changes: the text is the same.
 */
export function withDrawnParens(n: Node): Node {
  if (Array.isArray(n)) return n.map(withDrawnParens) as unknown as Node;
  if (!n || typeof n !== "object") return n;
  let out: Node | null = null;
  for (const [key, value] of Object.entries(n)) {
    if (!value || typeof value !== "object") continue;
    const next = withDrawnParens(value as Node);
    if (next !== value) (out ??= { ...n })[key] = next;
  }
  const node = out ?? n;
  if (!DRAWN_PAREN_OWNERS.has(node.type)) return node;
  const own = level(node);
  const wrap = (child: Node, strict: boolean): Node => {
    if (!child || typeof child !== "object" || child.type === "Paren" || child.type === "Placeholder") return child;
    if (STATEMENTS.has(child.type) || STMTS.has(child.type) || child.type === "InlineDef") return child;
    const lvl = level(child);
    return (strict ? lvl <= own : lvl < own) ? { type: "Paren", expr: child } : child;
  };
  const left = wrap(node.left, false);
  const right = wrap(node.right, true);
  return left === node.left && right === node.right ? node : { ...node, left, right };
}

/**
 * The path in `withParens` (from `withDrawnParens(plain)`) of the node at `path` in `plain`: one more
 * step into each parenthesis that was added on the way.
 */
export function drawnParenPath(plain: Node, withParens: Node, path: Path): Path {
  const out: number[] = [];
  let a = plain;
  let b = withParens;
  for (const index of path) {
    const left = children(a)[index];
    let right = children(b)[index];
    if (left === undefined || right === undefined) return path;
    out.push(index);
    if (right.type === "Paren" && left.type !== "Paren") {
      out.push(0);
      right = right.expr;
    }
    a = left;
    b = right;
  }
  return out;
}

/** Precedence level of a node (math-syntax section 5; higher binds tighter). */
export function level(n: Node): number {
  const binary = BINARY_LEVEL[n.type];
  if (binary !== undefined) return binary;
  switch (n.type) {
    case "Range":
    case "Program":
      return 2;
    case "Not":
      return 5;
    case "Sum":
    case "Prod":
    case "Integral":
    case "Deriv":
    case "Partial":
    case "Gradient":
    case "Limit":
      return 9;
    case "Neg":
      return 10;
    case "Div":
      return 11;
    case "Pow":
      return 12;
    case "Call":
    case "JuliaCall":
    case "Index":
    case "Column":
    case "Row":
    case "Transpose":
    case "Factorial":
    case "Percent":
    case "Permille":
    case "PrimeDeriv":
      return 13;
    default:
      return STATEMENTS.has(n.type) || STMTS.has(n.type) ? 1 : 14;
  }
}

// ---- editing form <-> wire form -----------------------------------------------------------

const BINDERS = new Set(["Sum", "Prod", "Integral", "Deriv", "Partial", "Limit", "For"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function targetToExpr(t: Node): Node {
  switch (t.type) {
    case "Ident":
      return (t.name.segments ?? []).every((s: { text: string }) => s.text === "") ? ph() : t;
    case "Index":
      return { ...t, base: targetToExpr(t.base) };
    case "Column":
    case "Row":
      return { ...t, base: targetToExpr(t.base) };
    case "Paren": {
      const { target, ...rest } = t;
      return { ...rest, type: "Paren", expr: targetToExpr(target) };
    }
    case "Destructure":
      return { type: "Matrix", rows: t.rows, cols: t.cols, cells: t.cells.map(targetToExpr) };
    case "FunctionHead":
      return {
        type: "Call",
        callee: targetToExpr({ type: "Ident", name: t.name.name }),
        args: t.params.map((p: Node) => exprArg(targetToExpr({ type: "Ident", name: p.name }))),
      };
    default:
      return t;
  }
}

/**
 * Byte ranges of the wire nodes in the region's math text, by editing node. They are not part of the
 * editing form (so they never reach Rust): the renderer reads them to find a node by the span of a
 * kernel error, a unit warning or a name reference (`data-span`).
 */
const SPANS = new WeakMap<object, { start: number; end: number }>();

export function spanOf(node: unknown): { start: number; end: number } | undefined {
  return typeof node === "object" && node !== null ? SPANS.get(node) : undefined;
}

/** The editing form of a wire statement (see the header). Spans are kept aside (`spanOf`). */
export function toEditing(value: unknown): Node {
  const walk = (v: unknown, key?: string, owner?: Record<string, unknown>): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, owner));
    if (!isObject(v)) return v;
    const span = isObject(v.span) && typeof v.span.start === "number" && typeof v.span.end === "number"
      ? { start: v.span.start, end: v.span.end }
      : null;
    const keep = <T extends object>(node: T): T => {
      if (span) SPANS.set(node, span);
      return node;
    };
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "span") continue;
      out[k] = walk(x, k, v);
    }
    const ownerType = owner?.type as string | undefined;
    if (!("type" in out)) {
      if ("cond" in out && "body" in out && "kind" in out) out.type = "Branch";
      else if ("keyword" in out && "args" in out) out.type = "KeywordGroup";
      else if ("name" in out && (key === "var" || key === "keyword")) out.type = "Ident";
    }
    if (key === "var" && ownerType && BINDERS.has(ownerType) && out.type !== "Placeholder") out.type = "Ident";
    // The variables of a gradient are binders too; an empty one is a placeholder.
    if (key === "vars" && ownerType === "Gradient") {
      const name = out.name as { segments?: { text: string }[] } | undefined;
      return keep(name && (name.segments ?? []).every((s) => s.text === "") ? ph() : { ...out, type: "Ident" });
    }
    // An empty binder is represented on the wire by an empty name, which is not
    // a legal user name. Keep it as an actual editable placeholder, not an empty identifier.
    if (BINDERS.has(out.type as string) && isObject(out.var)) {
      const name = out.var.name as { segments?: { text: string }[] } | undefined;
      if (name && (name.segments ?? []).every((s) => s.text === "")) out.var = ph();
    }
    if (out.type === "KeywordGroup" && isObject(out.keyword)) {
      const name = out.keyword.name as { segments?: { text: string }[] } | undefined;
      if (name && (name.segments ?? []).every((s) => s.text === "")) out.keyword = ph();
    }
    // The free lower slot of a sum or product is the editing form's `var`: the slot
    // holds any expression.
    if ((out.type === "Sum" || out.type === "Prod") && "index" in out) {
      if (out.index) out.var = out.index;
      delete out.index;
    }
    if (key === "target" && ownerType && ["Define", "GlobalDefine", "LocalDef", "InlineDef"].includes(ownerType)) {
      return keep(targetToExpr(out as Node));
    }
    // a `julia.` reference is edited as it is typed, a name (`julia.k`) or a call of that
    // name (`julia.f(a, b)`), so the caret, the mouse and the selection treat it as any name. The
    // commit parses it back into the Julia reference.
    if (out.type === "JuliaCall" && out.package === "julia" && typeof out.name === "string") {
      const name: Node = { type: "Ident", name: { segments: [{ text: `julia.${out.name}`, subscript: false }], label: null } };
      const args = Array.isArray(out.args) ? (out.args as Node[]) : [];
      if (out.bare) return keep(name);
      if (args.length > 0) return keep({ type: "Call", callee: name, args });
    }
    return keep(out);
  };
  return walk(value) as Node;
}

export class WireError extends Error {}

/**
 * : a table is edited with its units row, like the optional bounds of an integral: a
 * table stored without units gets a row of placeholders, which `toWire` drops again if left empty.
 */
export function withTableUnitSlots(value: Node): Node {
  if (value.type !== "Table" || value.units) return value;
  const grid = value.grid as Node;
  const cols = grid.cols as number;
  const cells = grid.cells as Node[];
  const units = Array.from({ length: cols }, () => ph());
  return { ...value, units: true, grid: { ...grid, rows: (grid.rows as number) + 1, cells: [...cells.slice(0, cols), ...units, ...cells.slice(cols)] } };
}

/** Offer bounds when editing an indefinite integral; empty slots serialize as no bounds. */
export function withIntegralBoundSlots(value: Node): Node {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObject(v)) return v;
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    if (out.type === "Integral" && !out.bounds) out.bounds = { lo: ph(), hi: ph() };
    const span = SPANS.get(v);
    if (span) SPANS.set(out, span);
    return out;
  };
  return walk(value) as Node;
}

/** Translate a hit in the committed tree into the tree with editable integral bounds. */
export function remapIntegralBoundHit(root: Node, path: Path): number[] {
  let node = root;
  return path.map((index) => {
    const mapped = node.type === "Integral" && !node.bounds ? index + 2 : index;
    node = children(node)[index];
    return mapped;
  });
}

/** Translate an editing path to the committed tree after empty integral bounds disappear. */
export function integralWirePath(root: Node, path: Path): Path | null {
  let node = root;
  const result: number[] = [];
  for (const index of path) {
    let mapped = index;
    if (node.type === "Integral" && node.bounds && isEmptySlot(node.bounds.lo) && isEmptySlot(node.bounds.hi)) {
      if (index < 2) return null;
      mapped -= 2;
    }
    result.push(mapped);
    node = children(node)[index];
  }
  return result;
}

function exprToTarget(e: Node, functionHead: boolean): Node {
  switch (e.type) {
    case "Placeholder":
      return { type: "Ident", name: { segments: [], label: null } };
    case "Ident":
      return { type: "Ident", name: e.name };
    case "Index":
      return { type: "Index", base: exprToTarget(e.base, false), indices: e.indices.map(toWireExpr) };
    case "Column":
    case "Row":
      return { type: e.type, base: exprToTarget(e.base, false), index: toWireExpr(e.index) };
    case "Paren":
      return { type: "Paren", target: exprToTarget(e.expr, false) };
    case "Matrix":
      return { type: "Destructure", rows: e.rows, cols: e.cols, cells: e.cells.map((c: Node) => exprToTarget(c, false)) };
    case "Call":
      if (
        functionHead &&
        (e.callee.type === "Ident" || e.callee.type === "Placeholder") &&
        e.args.every((a: Node) => a.type === "Expr" && (a.expr.type === "Ident" || a.expr.type === "Placeholder"))
      ) {
        return {
          type: "FunctionHead",
          name: binderIdent(e.callee, "function name"),
          params: e.args.map((a: Node) => binderIdent(a.expr, "function parameter")),
        };
      }
      break;
  }
  throw new WireError(
    "The left side of a definition must be a name, an indexed name, a function name with parameters, or a matrix of names.",
  );
}

/** An empty slot: a placeholder the user has not filled in. */
function isEmptySlot(v: unknown): boolean {
  return isObject(v) && (v as Node).type === "Placeholder";
}

function binderIdent(v: Node, what: string): Node {
  if (v.type === "Placeholder") return { name: { segments: [], label: null } } as unknown as Node;
  if (v.type !== "Ident") throw new WireError(`Fill in the variable of the ${what}.`);
  return { name: v.name } as unknown as Node;
}

function toWireExpr(e: Node): Node {
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(e)) {
    if (Array.isArray(x)) out[k] = x.map((item) => (isObject(item) ? toWireAny(item as Node) : item));
    else if (isObject(x) && k !== "name" && k !== "bounds") out[k] = toWireAny(x as Node);
    else if (k === "bounds" && isObject(x)) {
      out[k] = { lo: toWireExpr(x.lo as Node), hi: toWireExpr(x.hi as Node), ...(x.glyph ? { glyph: x.glyph } : {}) };
    }
    else out[k] = x;
  }
  switch (e.type) {
    case "Sum":
    case "Prod": {
      const what = e.type === "Sum" ? "sum" : "product";
      if (e.var.type === "Ident" || e.var.type === "Placeholder") {
        out.var = binderIdent(e.var, what);
        delete out.index;
      } else {
        // Any other expression in the index slot is kept as typed.
        out.index = toWireAny(e.var);
        out.var = { name: { segments: [{ text: "", subscript: false }], label: null } };
      }
      // Both bounds still empty: a placeholder bound is no bound, so the region
      // is committed as the index-only form `∑[i]` that iterates over the range variable
      // instead of a bounded sum with nothing in its bounds.
      if (isObject(e.bounds) && isEmptySlot(e.bounds.lo) && isEmptySlot(e.bounds.hi)) out.bounds = null;
      break;
    }
    case "Integral":
      out.var = binderIdent(e.var, "integral");
      // Both bounds still empty: the indefinite integral `∫[x] body`, as for a sum.
      if (isObject(e.bounds) && isEmptySlot(e.bounds.lo) && isEmptySlot(e.bounds.hi)) out.bounds = null;
      break;
    case "Deriv":
    case "Partial":
      out.var = binderIdent(e.var, "derivative");
      break;
    case "Gradient":
      out.vars = (e.vars as Node[]).map((v) => binderIdent(v, "gradient"));
      break;
    case "Limit":
      out.var = binderIdent(e.var, "limit");
      break;
  }
  return out as Node;
}

function toWireAny(n: Node): Node {
  switch (n.type) {
    case "Branch":
      return { kind: n.kind, cond: toWireExpr(n.cond), body: n.body.map(toWireAny) } as unknown as Node;
    case "KeywordGroup":
      return { keyword: binderIdent(n.keyword, "symbolic keyword"), args: n.args.map(toWireExpr) } as unknown as Node;
    case "LocalDef":
      // A program's local definition may define a function, so its target
      // is a function head like a worksheet definition's.
      return { type: "LocalDef", target: exprToTarget(n.target, true), rhs: toWireExpr(n.rhs) };
    case "InlineDef":
      return { type: "InlineDef", target: exprToTarget(n.target, false), value: toWireExpr(n.value) };
    case "For":
      return {
        type: "For",
        var: binderIdent(n.var, "for loop"),
        source: toWireExpr(n.source),
        body: n.body.map(toWireAny),
      };
    case "If":
      return {
        type: "If",
        branches: n.branches.map(toWireAny),
        else: n.else ? n.else.map(toWireAny) : null,
      };
    case "While":
      return { type: "While", cond: toWireExpr(n.cond), body: n.body.map(toWireAny) };
    case "Try":
      return { type: "Try", body: n.body.map(toWireAny), handler: n.handler.map(toWireAny) };
    case "Return":
    case "ExprStmt":
      return { type: n.type, expr: toWireExpr(n.expr) };
    case "Break":
    case "Continue":
      return { type: n.type };
    default:
      return toWireExpr(n);
  }
}

/**
 * The wire form of a list of call arguments, as `Call` stores them in the editing tree (`Expr`
 * wrappers kept): the clipboard form of a run of arguments.
 */
export function toWireArgs(args: Node[]): Node[] {
  return args.map((arg) => (arg.type === "Expr" ? { type: "Expr", expr: toWireExpr(arg.expr) } : toWireAny(arg)));
}

/** The editing form of a list of wire call arguments (what `parse_math_args` returns). */
export function toEditingArgs(args: unknown[]): Node[] {
  // `toEditing` walks any JSON value; a list of arguments is walked element by element.
  return toEditing(args) as unknown as Node[];
}

/** The wire form of an editing-form statement; throws `WireError` with a user message. */
export function toWire(statement: Node): Node {
  switch (statement.type) {
    case "Define":
      return {
        type: "Define",
        target: exprToTarget(statement.target, true),
        rhs: toWireExpr(statement.rhs),
        tail: statement.tail ? toWireTail(statement.tail) : null,
      };
    case "GlobalDefine":
      return { type: "GlobalDefine", target: exprToTarget(statement.target, true), rhs: toWireExpr(statement.rhs) };
    case "Evaluate":
      return { type: "Evaluate", expr: toWireExpr(statement.expr), unit: statement.unit ? toWireExpr(statement.unit) : null };
    case "Symbolic":
      return { type: "Symbolic", expr: toWireExpr(statement.expr), keywords: keywordGroups(statement.keywords).map(toWireAny) };
    case "ExprRegion":
      return { type: "ExprRegion", expr: toWireExpr(statement.expr) };
    // a units row with no unit filled is neither drawn nor stored.
    case "Table": {
      const grid = statement.grid as Node;
      const cols = grid.cols as number;
      const cells = grid.cells as Node[];
      const unitsEmpty = statement.units && cells.slice(cols, 2 * cols).every((cell) => cell.type === "Placeholder");
      const kept = unitsEmpty ? [...cells.slice(0, cols), ...cells.slice(2 * cols)] : cells;
      return {
        type: "Table",
        units: Boolean(statement.units) && !unitsEmpty,
        grid: toWireExpr({ ...grid, rows: kept.length / cols, cells: kept }),
      };
    }
    default:
      throw new WireError(`A ${statement.type} cannot be the content of a math region.`);
  }
}

function toWireTail(tail: Node): Node {
  if (tail.type === "Eval") return { type: "Eval", unit: tail.unit ? toWireExpr(tail.unit) : null };
  return { type: "Sym", keywords: keywordGroups(tail.keywords).map(toWireAny) };
}

/** A keyword slot nothing was typed in: the editor's placeholder above the arrow. */
export const emptyKeywordGroup = (): Node => ({ type: "KeywordGroup", keyword: ph(), args: [] });
export const isEmptyKeywordGroup = (n: Node): boolean =>
  n.type === "KeywordGroup" && n.keyword.type === "Placeholder" && n.args.length === 0;

/** The keyword groups that are stored: an empty slot is not (a plain `→` has no keyword). */
const keywordGroups = (groups: Node[]): Node[] => groups.filter((g) => !isEmptyKeywordGroup(g));

/**
 * The editing form of a symbolic evaluation without keywords gets the empty keyword slot above
 * its arrow, so the user can type a keyword there; every other statement is returned unchanged.
 */
export function withKeywordSlot(root: Node): Node {
  if (root.type === "Symbolic" && root.keywords.length === 0) return { ...root, keywords: [emptyKeywordGroup()] };
  if (root.type === "Define" && root.tail?.type === "Sym" && root.tail.keywords.length === 0) {
    return { ...root, tail: { ...root.tail, keywords: [emptyKeywordGroup()] } };
  }
  return root;
}

/** True when the statement is nothing but a placeholder (an empty region). */
export function isEmptyStatement(statement: Node): boolean {
  return statement.type === "ExprRegion" && statement.expr.type === "Placeholder";
}

// ---- s-expressions (tests and debugging), heads of math-syntax section 11 ------------------

const HEAD: Record<string, string> = {
  Add: "+",
  Sub: "-",
  Mul: "·",
  InlineDiv: "÷",
  Juxt: "juxt",
  Cross: "×",
  Conv: "∗",
  CircConv: "⊛",
  Polar: "∠",
  Div: "/",
  Pow: "^",
  Eq: "==",
  Ne: "≠",
  Lt: "<",
  Gt: ">",
  Le: "≤",
  Ge: "≥",
  In: "∈",
  And: "∧",
  Or: "∨",
  Xor: "⊕",
  Paren: "paren",
  Neg: "neg",
  Not: "¬",
  Factorial: "!",
  Percent: "%",
  Permille: "‰",
  Transpose: "ᵀ",
  Conj: "conj",
  RealPart: "Re",
  ImagPart: "Im",
  Abs: "abs",
  Det: "det",
  Norm: "norm",
  Vectorize: "vec",
  Root: "√",
  Call: "call",
  InlineDef: "←",
  Index: "index",
  Column: "col",
  Row: "row",
  Range: "range",
  Sum: "∑",
  Prod: "∏",
  Integral: "∫",
  Deriv: "ⅆ",
  Partial: "∂",
  Gradient: "∇",
  Limit: "lim",
  Program: "program",
  LocalDef: "←",
  For: "for",
  While: "while",
  Return: "return",
  Try: "try",
  Define: ":=",
  GlobalDefine: "≡",
  KeywordGroup: "kw",
};

export function nameString(name: Node["name"]): string {
  return (name.segments as { text: string; subscript: boolean }[])
    .map((s, i) => (s.subscript ? `_${s.text}` : i > 0 ? `·${s.text}` : s.text))
    .join("");
}

export function sexpr(n: Node): string {
  switch (n.type) {
    case "Placeholder":
      return "□";
    case "Num":
      return n.text;
    case "Imag":
      return `${n.text}${n.symbol}`;
    case "Str":
      return JSON.stringify(n.text);
    case "Ident":
      return nameString(n.name) + (n.name.label ? `@${n.name.label}` : "");
    case "Break":
    case "Continue":
      return n.type.toLowerCase();
    case "ExprRegion":
    case "ExprStmt":
      return sexpr(n.expr);
    case "Matrix":
      return `(matrix ${n.rows}×${n.cols} ${n.cells.map(sexpr).join(" ")})`;
    // A display-only matrix cell: the S-expression is its glyph.
    case "EllipsisCell":
      return n.form === "vertical" ? "(⋮)" : n.form === "diagonal" ? "(⋱)" : "(⋯)";
    case "Evaluate":
      return n.unit ? `(= ${sexpr(n.expr)} ${sexpr(n.unit)})` : `(= ${sexpr(n.expr)})`;
    case "Symbolic":
      return `(→ ${[n.expr, ...n.keywords].map(sexpr).join(" ")})`;
    case "Define": {
      const tail = n.tail ? (n.tail.type === "Eval" ? " (=)" : " (→)") : "";
      return `(:= ${sexpr(n.target)} ${sexpr(n.rhs)}${tail})`;
    }
    case "If": {
      const parts = n.branches.map((b: Node) => `(${b.kind} ${[b.cond, ...b.body].map(sexpr).join(" ")})`);
      if (n.else) parts.push(`(else ${n.else.map(sexpr).join(" ")})`);
      return `(if ${parts.join(" ")})`;
    }
    case "Try":
      return `(try (${n.body.map(sexpr).join(" ")}) (${n.handler.map(sexpr).join(" ")}))`;
    default: {
      const head = HEAD[n.type] ?? n.type;
      const kids = children(n).map(sexpr);
      const extra = n.type === "PrimeDeriv" ? ` ${n.order}` : "";
      const split = n.split ? "↵" : "";
      return `(${head}${split} ${kids.join(" ")}${extra})`;
    }
  }
}
