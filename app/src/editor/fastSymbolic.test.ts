import { describe, expect, it } from "vitest";
import { FAST_SYMBOLIC, fastSymbolicContext } from "./fastSymbolic";
import { focusAt } from "./model";
import { ident, type Node } from "./tree";

const x = ident("x");
const y = ident("y");
const equation = { type: "Eq", left: x, right: y };
const expression = { type: "Add", left: x, right: y, split: false };
const root = (expr: Node) => ({ type: "ExprRegion", expr });
const enabled = (editor: ReturnType<typeof focusAt>) =>
  fastSymbolicContext(editor).entries.filter(entry => entry.enabled).map(entry => entry.id);

describe("Fast Symbolic eligibility", () => {
  it("enables variable operations only for one explicitly selected identifier", () => {
    expect(enabled(focusAt(root(expression), [0], "R", true))).toEqual(["simplify", "expand", "factor", "float", "combine", "rectangular"]);
    expect(enabled(focusAt(root(expression), [0, 0], "R"))).toEqual(["simplify", "expand", "factor", "float", "combine", "rectangular"]);
    expect(enabled(focusAt(root(expression), [0, 0], "R", true))).toContain("collect");
    expect(enabled(focusAt(root(expression), [0, 0], "R", true))).not.toContain("solve");
  });

  it("offers the transforms and Series with one selected variable and unique keys", () => {
    const selected = enabled(focusAt(root(expression), [0, 0], "R", true));
    expect(selected).toEqual(expect.arrayContaining([
      "coefficients", "series", "laplace", "inverse_laplace", "fourier", "inverse_fourier",
      "z_transform", "inverse_z_transform", "continued_fraction",
    ]));
    expect(new Set(FAST_SYMBOLIC.map(entry => entry.key)).size).toBe(FAST_SYMBOLIC.length);
    expect(FAST_SYMBOLIC.some(entry => ["substitute", "rewrite", "assume"].includes(entry.id))).toBe(false);
    expect(enabled(focusAt(root({ type: "Num", text: "2" }), [0], "R"))).toContain("continued_fraction");
  });

  it("enables Solve for a selected variable in an equation or a matrix of equations", () => {
    expect(enabled(focusAt(root(equation), [0, 0], "R", true))).toEqual(["simplify", "expand", "factor", "solve", "float"]);
    const matrix = (cells: Node[]) => root({ type: "Matrix", rows: 2, cols: 1, cells });
    expect(enabled(focusAt(matrix([equation, equation]), [0, 0, 0], "R", true))).toContain("solve");
    expect(enabled(focusAt(matrix([equation, expression]), [0, 0, 0], "R", true))).not.toContain("solve");
  });
});
