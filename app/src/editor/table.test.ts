// the specification: a table in the math editor.
import { describe, expect, it } from "vitest";
import { initialState, placeCaret, runCommand } from "./model";
import { ph, toWire, withTableUnitSlots, type Node } from "./tree";

const ident = (text: string): Node => ({ type: "Ident", name: { segments: [{ text, subscript: false }], label: null } });
const num = (text: string): Node => ({ type: "Num", text });
const table = (units: boolean, rows: number, cols: number, cells: Node[]): Node => ({ type: "Table", units, grid: { type: "Matrix", rows, cols, cells } });
const grid = (root: Node) => root.grid as Node & { rows: number; cols: number; cells: Node[] };

describe("tables in the editor", () => {
  it("offers the units row as optional slots and drops it again when it stays empty", () => {
    const stored = table(false, 2, 2, [ident("a"), ident("b"), num("1"), num("2")]);
    const editing = withTableUnitSlots(stored);
    expect(editing.units).toBe(true);
    expect(grid(editing).rows).toBe(3);
    expect(grid(editing).cells.slice(2, 4).every((cell) => cell.type === "Placeholder")).toBe(true);
    const wire = toWire(editing) as Node;
    expect(wire.units).toBe(false);
    expect(grid(wire).rows).toBe(2);
    // A filled unit keeps the row.
    const withUnit = { ...editing, grid: { ...grid(editing), cells: grid(editing).cells.map((cell, i) => (i === 2 ? ident("m") : cell)) } };
    expect((toWire(withUnit) as Node).units).toBe(true);
  });

  it("keeps the names and units rows and the last value row, and adds value rows below them", () => {
    const editing = table(true, 3, 2, [ident("a"), ident("b"), ph(), ph(), num("1"), num("2")]);
    const onName = placeCaret(initialState(editing), [0, 0], "L", null);
    expect(grid(runCommand(onName, "deleteRow").root).rows).toBe(3);
    const onValue = placeCaret(initialState(editing), [0, 4], "L", null);
    expect(grid(runCommand(onValue, "deleteRow").root).rows).toBe(3);
    // Insert row above on the names row inserts the first value row.
    const added = runCommand(onName, "addRowAbove").root;
    expect(grid(added).rows).toBe(4);
    expect(grid(added).cells.slice(0, 2)).toEqual([ident("a"), ident("b")]);
    expect(grid(added).cells.slice(4, 6).every((cell) => cell.type === "Placeholder")).toBe(true);
    // A new column reaches every row, the names row included.
    const column = runCommand(onValue, "addColumn").root;
    expect(grid(column).cols).toBe(3);
    expect(grid(column).cells).toHaveLength(9);
  });
});
