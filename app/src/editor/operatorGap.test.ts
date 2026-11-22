import { describe, expect, it } from "vitest";
import { focusAt, runCommand, type Command } from "./model";
import { get, ident, ph, toEditing, toWire, type Node } from "./tree";

const expression = (type = "Add", left: Node = ident("a"), right: Node = ident("b")): Node =>
  ({ type: "ExprRegion", expr: { type, left, right } });
const gap = (left = ident("a"), right = ident("b")): Node =>
  ({ type: "Juxt", left: { type: "Juxt", left, right: ph() }, right });

describe("replaceable operator gaps", () => {
  for (const [command, path, side] of [["backspace", [0, 1], "L"], ["delete", [0, 0], "R"]] as const) {
    it(`${command} removes the operator while preserving both operands`, () => {
      const root = expression();
      const before = focusAt(root, [...path], side);
      const empty = runCommand(before, command);
      expect(empty.root.expr).toEqual(gap());
      expect(get(empty.root, empty.focus).type).toBe("Placeholder");
      expect(runCommand(empty, "undo").root).toEqual(root);
      expect(runCommand(runCommand(empty, "undo"), "redo").root).toEqual(empty.root);
      for (const remove of ["backspace", "delete"] as const) {
        expect(runCommand(empty, remove).root.expr).toEqual({ type: "Juxt", left: ident("a"), right: ident("b") });
      }
    });
  }

  it.each(["Add", "Sub", "Mul", "InlineDiv", "Cross", "Div", "Pow", "Lt", "Le", "Ne", "And"])(
    "removes a filled %s operator", type => {
      const empty = runCommand(focusAt(expression(type), [0, 1], "L"), "backspace");
      expect(empty.root.expr).toEqual(gap());
    },
  );

  it.each<[Command, string]>([["sub", "Sub"], ["mul", "Mul"], ["frac", "Div"], ["pow", "Pow"], ["lessEq", "Le"], ["boolEq", "Eq"]])(
    "%s replaces the entire gap", (command, type) => {
      const empty = runCommand(focusAt(expression(), [0, 1], "L"), "backspace");
      const replaced = runCommand(empty, command);
      expect(replaced.root.expr).toMatchObject({ type, left: ident("a"), right: ident("b") });
      expect(replaced.focus).toEqual([0, 1]);
    },
  );

  it("retains an incomplete gap through the worksheet wire form and allows replacement after reopening", () => {
    const empty = runCommand(focusAt(expression(), [0, 1], "L"), "backspace");
    const reopened = toEditing(toWire(empty.root));
    expect(reopened.expr).toEqual(gap());
    const replaced = runCommand(focusAt(reopened, [0, 0, 1]), "sub");
    expect(replaced.root.expr).toMatchObject({ type: "Sub", left: ident("a"), right: ident("b") });
  });

  it("does not remove an outer operator from inside a fence or an exponent", () => {
    for (const right of [{ type: "Abs", expr: ident("b") }, { type: "Neg", expr: ident("b") }]) {
      const root = expression("Add", ident("a"), right);
      expect(runCommand(focusAt(root, [0, 1, 0], "L"), "backspace").root.expr).toEqual({ type: "Add", left: ident("a"), right: ident("b") });
      expect(runCommand(focusAt(root, [0, 1], "L"), "backspace").root.expr).toEqual(gap(ident("a"), right));
    }
    const left: Node = { type: "Pow", left: ident("x"), right: ident("n") };
    const root = expression("Add", left, ident("b"));
    expect(runCommand(focusAt(root, [0, 0, 1], "R"), "delete").root).toEqual(root);
    expect(runCommand(focusAt(root, [0, 0], "R"), "delete").root.expr).toEqual(gap(left, ident("b")));
  });

  it("keeps ordinary character deletion and empty-operand deletion", () => {
    const root = expression("Add", ident("ab"), ident("cd"));
    expect(runCommand(focusAt(root, [0, 1], "R"), "backspace").root.expr.right).toEqual(ident("c"));
    expect(runCommand(focusAt(root, [0, 0], "L"), "delete").root.expr.left).toEqual(ident("b"));
    expect(runCommand(focusAt(expression("Add", ident("a"), ph()), [0, 1]), "backspace").root.expr).toEqual(ident("a"));
  });

  it("removes a selected gap as well and leaves the caret at the product joint", () => {
    const root = { type: "ExprRegion", expr: gap() };
    for (const command of ["backspace", "delete"] as const) {
      const product = runCommand(focusAt(root, [0, 0, 1], "R", true), command);
      expect(product.root.expr).toEqual({ type: "Juxt", left: ident("a"), right: ident("b") });
      expect(product.focus).toEqual([0, command === "backspace" ? 0 : 1]);
      expect(product.side).toBe(command === "backspace" ? "R" : "L");
    }
  });

  it("keeps compound operands and their explicit break anchors when deleting and replacing the operator", () => {
    const left: Node = { type: "Add", left: ident("a"), right: ident("b") };
    const right: Node = { type: "Abs", expr: ident("c") };
    const root = expression("Mul", left, right);
    const before = focusAt(root, [0, 1], "L", false, [{ node: left.right }]);
    const empty = runCommand(before, "backspace");
    expect(empty.root.expr).toEqual(gap(left, right));
    const replaced = runCommand(empty, "sub");
    expect(replaced.root.expr).toMatchObject({ type: "Sub", left, right });
    expect(replaced.breaks.map(b => b.node)).toEqual([left.right]);
  });

  it("does not delete an adjacent operator from inside a string's opening quote", () => {
    const str: Node = { type: "Str", text: "b" };
    const root = expression("Add", ident("a"), str);
    const inside = focusAt(root, [0, 1], "L");
    const outside = runCommand(inside, "backspace");
    expect(outside.root).toEqual(root);
    expect(outside.caret).toBeNull();
    expect(runCommand(outside, "backspace").root.expr).toEqual(gap(ident("a"), str));
  });

  it("does not delete an adjacent operator from inside a string's closing quote", () => {
    const str: Node = { type: "Str", text: "a" };
    const root = expression("Add", str, ident("b"));
    const inside = focusAt(root, [0, 0], "R");
    expect(runCommand(inside, "delete").root).toEqual(root);
    const outside = runCommand(inside, "right");
    expect(outside.caret).toBeNull();
    expect(runCommand(outside, "delete").root.expr).toEqual(gap(str, ident("b")));
  });
});
