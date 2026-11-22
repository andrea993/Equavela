// Math-mode Find and Replace on the canonical form the view carries:
// the shapes below are what `core/src/syntax` serialises (spans included, as the backend sends them).

import { describe, expect, it } from "vitest";
import { ident, num, type Node } from "../editor/tree";
import type { ViewRegion } from "../equavelaApi";
import { containsMath, mathMatches, mathQueryOf, mathReplacementOf, replaceMath } from "./mathFind";

const span = (start: number, end: number) => ({ start, end });
const name = (text: string, sub?: string) => ({
  segments: sub === undefined ? [{ text, subscript: false }] : [{ text, subscript: false }, { text: sub, subscript: true }],
  label: null,
});
const id = (text: string, sub?: string, at = 0) => ({ span: span(at, at + 1), type: "Ident", name: name(text, sub) });
const n = (text: string, at = 0) => ({ span: span(at, at + 1), type: "Num", text });
const add = (left: unknown, right: unknown, split = false) => ({ span: span(0, 9), type: "Add", left, right, split });
const mul = (left: unknown, right: unknown) => ({ span: span(0, 9), type: "Mul", left, right, split: false });
const paren = (expr: unknown) => ({ span: span(0, 9), type: "Paren", expr });
const call = (fn: string, ...args: unknown[]) => ({
  span: span(0, 9),
  type: "Call",
  callee: id(fn),
  args: args.map((expr) => ({ type: "Expr", expr })),
});

/** `y := 2·(a + b) + sin(x)` */
const statement = {
  span: span(0, 20),
  type: "Define",
  target: id("y"),
  rhs: add(mul(n("2"), paren(add(id("a"), id("b")))), call("sin", id("x"))),
  tail: null,
};

const math = (stmt: unknown): ViewRegion =>
  ({ id: "m", page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "", statement: stmt }) as unknown as ViewRegion;

/** The editing tree of an expression typed in a math box. */
const typed = (expr: Node): Node => ({ type: "ExprRegion", expr });

describe("math-mode matching", () => {
  it("finds a subexpression by its tree, ignoring spans, line breaks and precedence parentheses", () => {
    expect(containsMath(statement, add(id("a", undefined, 7), id("b", undefined, 9), true))).toBe(true);
    expect(containsMath(statement, call("sin", id("x")))).toBe(true);
    expect(containsMath(statement, id("y"))).toBe(true);
    expect(containsMath(statement, n("2"))).toBe(true);
  });

  it("compares names exactly: x is not x_1, exp or max", () => {
    const other = { type: "ExprRegion", expr: add(id("x", "1"), add(call("exp", id("t")), id("max"))) };
    expect(containsMath(other, id("x"))).toBe(false);
    expect(containsMath(other, id("x", "1"))).toBe(true);
    expect(containsMath(other, id("X", "1"))).toBe(false);
  });

  it("finds a + b but not b + c in a + b + c, which is (a + b) + c", () => {
    const chain = { type: "ExprRegion", expr: add(add(id("a"), id("b")), id("c")) };
    expect(containsMath(chain, add(id("a"), id("b")))).toBe(true);
    expect(containsMath(chain, add(id("b"), id("c")))).toBe(false);
  });

  it("takes the typed expression as the query, and nothing while a placeholder is empty", () => {
    expect(mathQueryOf(typed(ident("a")))).toMatchObject({ type: "Ident" });
    expect(mathQueryOf({ type: "ExprRegion", expr: { type: "Placeholder" } })).toBeNull();
    expect(mathQueryOf(typed({ type: "Add", left: ident("a"), right: { type: "Placeholder" }, split: false }))).toBeNull();
    expect(mathMatches(math(statement), mathQueryOf(typed(num("2"))))).toBe(true);
    expect(mathMatches(math(statement), mathQueryOf(typed(num("3"))))).toBe(false);
  });

  it("matches a text region by its inline math and never another kind", () => {
    const text = {
      id: "t", page: 1, x: 0, y: 0, enabled: true, kind: "text", text: "", width: null,
      paragraphs: [{ runs: [{ kind: "text", text: "where x is" }, { kind: "math", text: "x", statement: { type: "ExprRegion", expr: id("x") } }] }],
    } as unknown as ViewRegion;
    const include = { id: "i", page: 1, x: 0, y: 0, enabled: true, kind: "include", path: "x" } as unknown as ViewRegion;
    expect(mathMatches(text, id("x"))).toBe(true);
    expect(mathMatches(text, id("is"))).toBe(false);
    expect(mathMatches(include, id("x"))).toBe(false);
  });
});

describe("math-mode replacement", () => {
  it("substitutes every match and leaves the rest of the tree as it was", () => {
    const next = replaceMath(statement, id("a"), mul(n("3"), id("k"))) as typeof statement;
    expect(containsMath(next, mul(n("3"), id("k")))).toBe(true);
    expect(containsMath(next, id("a"))).toBe(false);
    expect(containsMath(next, call("sin", id("x")))).toBe(true);
    expect(replaceMath(statement, id("zzz"), n("1"))).toBeNull();
  });

  it("rewrites the inline math runs of a text region and names the runs that changed", () => {
    const text = {
      id: "t", page: 1, x: 0, y: 0, enabled: true, kind: "text", text: "", width: null,
      paragraphs: [{ runs: [{ kind: "text", text: "x and " }, { kind: "math", text: "x", statement: { type: "ExprRegion", expr: id("x") } }] }],
    } as unknown as ViewRegion;
    const result = mathReplacementOf(text, id("x"), id("u"));
    expect(result?.kind).toBe("text");
    if (result?.kind !== "text") return;
    expect(result.changed).toEqual([[0, 1]]);
    // The plain text run is text, not math: it keeps its "x".
    expect(result.paragraphs[0].runs[0]).toEqual({ kind: "text", text: "x and " });
    expect(mathReplacementOf(math(statement), id("q"), id("u"))).toBeNull();
  });
});
