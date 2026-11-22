import { describe, expect, it } from "vitest";
import { handleKey } from "./controller";
import { focusAt, runCommand, type EditorState } from "./model";
import { get, ident, leafPaths, type Node } from "./tree";
import { sameCursor } from "../text/InlineMath";
import type { LayoutId } from "../keymap/keymap";

const region = (expr: Node): Node => ({ type: "ExprRegion", expr });
const wrap = (type: string, expr: Node = ident("a")): Node =>
  type === "Root" ? { type, index: null, radicand: expr }
    : type === "PrimeDeriv" ? { type, function: expr, order: 1 }
      : { type, expr };

for (const layout of ["en-US", "it-IT"] satisfies LayoutId[]) {
  const arrow = (s: EditorState, key = "ArrowRight") => handleKey(s, { key, code: key }, layout).state;
  describe(`structural boundary navigation (${layout})`, () => {
    it.each(["Paren", "Abs", "Det", "Norm", "Root", "Conj", "Vectorize", "Factorial", "Percent", "Transpose", "PrimeDeriv"])(
      "stops outside %s before leaving or appending an operator", type => {
        const root = region(wrap(type));
        const inside = focusAt(root, [0, 0], "R");
        const outside = arrow(inside);
        expect(outside.focus).toEqual([0]);
        expect(outside.side).toBe("R");
        expect(sameCursor(inside, outside)).toBe(false);
        expect(sameCursor(outside, arrow(outside))).toBe(true);
        const continued = runCommand(outside, "add");
        expect(get(continued.root, [0]).type).toBe("Add");
        expect(get(continued.root, [0, 0]).type).toBe(type);
      },
    );

    it.each(["Paren", "Abs", "Det", "Norm", "Root", "Conj", "Vectorize", "Neg", "Not"])(
      "stops before the leading boundary of %s", type => {
        const inside = focusAt(region(wrap(type)), [0, 0], "L");
        const outside = arrow(inside, "ArrowLeft");
        expect(outside.focus).toEqual([0]);
        expect(outside.side).toBe("L");
        expect(sameCursor(outside, arrow(outside, "ArrowLeft"))).toBe(true);
        expect(arrow(outside).focus).toEqual([0, 0]);
      },
    );

    it("traverses nested fences one at a time in all four directions", () => {
      const root = region(wrap("Abs", wrap("Norm")));
      for (const [key, side, inwardKey] of [["ArrowRight", "R", "ArrowLeft"], ["ArrowLeft", "L", "ArrowRight"]] as const) {
        let s = focusAt(root, [0, 0, 0], side);
        s = arrow(s, key);
        expect(s.focus).toEqual([0, 0]);
        s = arrow(s, key);
        expect(s.focus).toEqual([0]);
        s = arrow(s, inwardKey);
        expect(s.focus).toEqual([0, 0]);
        s = arrow(s, inwardKey);
        expect(s.focus).toEqual([0, 0, 0]);
      }
    });

    it.each(["Sum", "Prod", "Integral", "Deriv", "Partial", "Limit"])(
      "stops outside the whole %s before leaving its operand region", type => {
        const expr: Node = { type, var: ident("x"), bounds: null, order: null, target: ident("b"), body: ident("a") };
        const root = region(expr);
        const leaves = leafPaths(root);
        for (const [key, side, leaf] of [["ArrowLeft", "L", leaves[0]], ["ArrowRight", "R", leaves[leaves.length - 1]]] as const) {
          const outside = arrow(focusAt(root, leaf, side), key);
          expect(outside.focus).toEqual([0]);
          expect(outside.side).toBe(side);
          expect(sameCursor(outside, arrow(outside, key))).toBe(true);
        }
      },
    );

    it.each(["Pow", "Div", "Matrix"])("does not skip a fence inside a %s", type => {
      const inner = wrap("Abs");
      const expr = type === "Pow" ? { type, left: ident("x"), right: inner }
        : type === "Div" ? { type, left: inner, right: ident("b") }
          : { type, rows: 2, cols: 1, cells: [inner, ident("b")] };
      const child = type === "Pow" ? 1 : 0;
      let s = focusAt(region(expr), [0, child, 0], "R");
      s = arrow(s);
      expect(s.focus).toEqual([0, child]);
      s = arrow(s);
      expect(s.focus).toEqual(type === "Pow" ? [0] : [0, 1]);
    });

    it("crosses a fence before moving to a sibling, without adding infix stops", () => {
      const root = region({ type: "Add", left: wrap("Abs"), right: ident("b") });
      let s = focusAt(root, [0, 0, 0], "R");
      s = arrow(s);
      expect(s.focus).toEqual([0, 0]);
      s = arrow(s);
      expect(s.focus).toEqual([0, 1]);
      expect(s.side).toBe("L");
      const end = focusAt(root, [0, 1], "R");
      expect(sameCursor(end, arrow(end))).toBe(true);
    });

    it("crosses matrix brackets and enters an inner cell fence without skipping either", () => {
      const root = region({ type: "Matrix", rows: 1, cols: 1, cells: [wrap("Abs")] });
      for (const [outKey, inKey, side] of [["ArrowLeft", "ArrowRight", "L"], ["ArrowRight", "ArrowLeft", "R"]] as const) {
        const matrix = arrow(focusAt(root, [0, 0], side), outKey);
        expect(matrix.focus).toEqual([0]);
        const cell = arrow(matrix, inKey);
        expect(cell.focus).toEqual([0, 0]);
        expect(arrow(cell, inKey).focus).toEqual([0, 0, 0]);
      }
    });

    it.each([false, true])("handles a zero-argument legacy Julia call (bare=%s) without a child path", bare => {
      const root = region({ type: "JuliaCall", package: "Pkg", name: "f", args: [], bare });
      for (const [key, side] of [["ArrowLeft", "R"], ["ArrowRight", "L"]] as const) {
        const inside = arrow(focusAt(root, [0], side), key);
        expect(inside.focus).toEqual([0]);
        expect(inside.side).toBe(side === "R" ? "L" : "R");
      }
    });
  });
}
