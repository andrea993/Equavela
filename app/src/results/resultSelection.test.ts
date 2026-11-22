// Selecting part of a result and the text Ctrl+C copies.

import { describe, expect, it } from "vitest";
import type { KernelValue } from "../equavelaApi";
import { drawSelection, resultDragHit, resultHit, selectedValue, selectionOf, valueText, type ResultSelection } from "./resultSelection";

const real = (value: number): KernelValue => ({ type: "real", value });
/** A matrix from its rows, stored column-major as the kernel sends it. */
const matrix = (rows: KernelValue[][]): KernelValue => {
  const values: KernelValue[] = [];
  for (let c = 0; c < rows[0].length; c++) for (const row of rows) values.push(row[c]);
  return { type: "matrix", rows: rows.length, cols: rows[0].length, storage: { type: "inline", values } };
};

describe("the text of a selected result", () => {
  it("writes numbers at full precision, complex numbers, quantities and matrices as linear math", () => {
    expect(valueText(real(3.000000000000002))).toBe("3.000000000000002");
    expect(valueText(real(1e-7))).toBe("1e-7");
    expect(valueText({ type: "complex", real: 3, imag: -4 })).toBe("3 - 4i");
    expect(valueText({ type: "complex", real: 0, imag: 2.5 })).toBe("2.5i");
    expect(
      valueText({ type: "quantity", magnitude: { type: "real", value: 9.81 }, dimension: [{ base: "m", power: [1, 1] }, { base: "s", power: [-2, 1] }] }),
    ).toBe("9.81·m@unit·s@unit^-2");
    expect(valueText(matrix([[real(1), real(2)], [real(3), real(4)]]))).toBe("[1, 2; 3, 4]");
    expect(valueText({ type: "string", value: 'a"b' })).toBe('"a\\"b"');
    expect(valueText({ type: "handle", id: "1", julia_type: "T", summary: "" })).toBeNull();
  });

  it("takes a cell, a block (a smaller matrix) or the whole matrix, also of a nested matrix", () => {
    const m = matrix([[real(1), real(2), real(3)], [real(4), real(5), real(6)]]);
    const cells = (r1: number, c1: number, r2: number, c2: number): ResultSelection => ({ regionId: "r", kind: "cells", matrix: [], r1, c1, r2, c2 });
    expect(valueText(selectedValue(m, cells(1, 2, 1, 2))!)).toBe("6");
    expect(valueText(selectedValue(m, cells(0, 1, 1, 2))!)).toBe("[2, 3; 5, 6]");
    expect(valueText(selectedValue(m, cells(0, 0, 0, 2))!)).toBe("[1, 2, 3]");
    expect(valueText(selectedValue(m, { regionId: "r", kind: "matrix", matrix: [] })!)).toBe("[1, 2, 3; 4, 5, 6]");
    const nested = matrix([[m, real(7)]]);
    expect(valueText(selectedValue(nested, { regionId: "r", kind: "matrix", matrix: [[0, 0]] })!)).toBe("[1, 2, 3; 4, 5, 6]");
    expect(valueText(selectedValue(nested, { regionId: "r", kind: "cells", matrix: [[0, 0]], r1: 1, c1: 0, r2: 1, c2: 0 })!)).toBe("4");
    // A selection that no longer fits the result (it was recalculated smaller) selects nothing.
    expect(selectedValue(m, cells(0, 0, 3, 3))).toBeNull();
  });
});

describe("pressing and dragging in a result", () => {
  const dom = () => {
    const result = document.createElement("span");
    result.className = "result value";
    result.innerHTML =
      '<span class="matrix result-matrix"><svg class="fence-side left"></svg><span class="matrix-grid">' +
      '<span class="cell" data-result-cell="0,0"><span class="num">1</span></span>' +
      '<span class="cell" data-result-cell="0,1"><span class="num">2</span></span>' +
      '<span class="cell" data-result-cell="1,0"><span class="num">3</span></span>' +
      '<span class="cell" data-result-cell="1,1"><span class="num">4</span></span>' +
      "</span></span>";
    return result;
  };

  it("selects a cell, a block, and the whole matrix on its brackets or past its cells", () => {
    const result = dom();
    const num = (r: number, c: number) => result.querySelector(`[data-result-cell="${r},${c}"] .num`)!;
    const from = resultHit(result, num(0, 0));
    expect(from).toEqual({ kind: "cell", matrix: [], r: 0, c: 0 });
    expect(selectionOf("m", from, from)).toEqual({ regionId: "m", kind: "cells", matrix: [], r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(selectionOf("m", from, resultHit(result, num(1, 1)))).toMatchObject({ kind: "cells", r2: 1, c2: 1 });
    expect(selectionOf("m", from, from, true)).toEqual({ regionId: "m", kind: "matrix", matrix: [] });
    expect(resultHit(result, result.querySelector(".fence-side"))).toEqual({ kind: "matrix", matrix: [] });
  });

  it("selects the smallest sub-expression holding both ends in a symbolic result", () => {
    const result = document.createElement("span");
    result.className = "result value";
    result.innerHTML = '<span data-path=""><span data-path="0">a</span><span data-path="1"><span data-path="1.0">b</span><span data-path="1.1">c</span></span></span>';
    const at = (path: string) => resultHit(result, result.querySelector(`[data-path="${path}"]`));
    expect(selectionOf("m", at("1.0"), at("1.1"))).toEqual({ regionId: "m", kind: "symbolic", path: [1] });
    expect(selectionOf("m", at("0"), at("1.1"))).toEqual({ regionId: "m", kind: "symbolic", path: [] });
  });
});


describe("matrix result geometry and cell selection", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;

  it("selects across gaps and paints only its own cells", () => {
    const sheet = document.createElement("div");
    const cells = ["0,0", "0,1", "1,0", "1,1"];
    sheet.innerHTML = `<div data-region-id="m"><span class="result"><span class="result-matrix"><span class="matrix-grid">${cells.map((at) => `<span data-result-cell="${at}">1</span>`).join("")}</span></span></span></div>`;
    const result = sheet.querySelector(".result")!;
    const matrix = result.firstElementChild!;
    const grid = matrix.querySelector(".matrix-grid") ?? matrix;
    grid.getBoundingClientRect = () => rect(0, 0, 60, 60);
    const elements = [...matrix.querySelectorAll("[data-result-cell]")];
    elements.forEach((cell, i) => { cell.getBoundingClientRect = () => rect((i % 2) * 40, Math.floor(i / 2) * 40, 20, 20); });
    // The pointer is in the gap, with no cell in its event target.
    const from = resultHit(result, grid, 26, 10);
    expect(from).toEqual({ kind: "cell", matrix: [], r: 0, c: 0 });
    // A captured pointer still targets the first cell, while its coordinates move to the last.
    const to = resultDragHit(result, from, elements[0], 50, 50);
    const selection = selectionOf("m", from, to);
    expect(selection).toMatchObject({ kind: "cells", r1: 0, c1: 0, r2: 1, c2: 1 });
    drawSelection(sheet, selection);
    expect(matrix.querySelectorAll(".result-selected")).toHaveLength(4);
    const overlay = matrix.querySelector(".result-selection-box")!;
    expect(overlay.classList.contains("no-print")).toBe(true);
    const rectangle = overlay.querySelector("rect")!;
    expect(rectangle.getAttribute("x")).toBe("-2");
    expect(rectangle.getAttribute("y")).toBe("-2");
    expect(rectangle.getAttribute("width")).toBe("64");
    expect(rectangle.getAttribute("height")).toBe("64");
    expect(overlay.querySelectorAll("rect")).toHaveLength(1);
    expect(resultDragHit(result, from, elements[0], 65, 50)).toEqual({ kind: "matrix", matrix: [] });
    drawSelection(sheet, selectionOf("m", from, resultDragHit(result, from, grid, 50, 10)));
    expect(matrix.querySelectorAll(".result-selected")).toHaveLength(2);
    expect(matrix.querySelectorAll(".result-selection-box")).toHaveLength(1);
    expect(matrix.querySelector(".result-selection-box rect")?.getAttribute("height")).toBe("24");
    drawSelection(sheet, null);
    expect(sheet.querySelector(".result-selected")).toBeNull();
    expect(sheet.querySelector(".result-selection-box")).toBeNull();
  });

  it("keeps the filled rectangle aligned in a zoomed and scrolled matrix", () => {
    const sheet = document.createElement("div");
    sheet.innerHTML = '<div data-region-id="m"><span class="result"><span class="result-matrix"><span data-result-cell="0,0">1</span><span data-result-cell="0,1">2</span></span></span></div>';
    const table = sheet.querySelector<HTMLElement>(".result-matrix")!;
    Object.defineProperty(table, "offsetWidth", { value: 100 });
    table.getBoundingClientRect = () => rect(100, 200, 200, 100);
    table.scrollLeft = 30;
    table.scrollTop = 20;
    const cells = [...table.querySelectorAll("[data-result-cell]")];
    cells[0].getBoundingClientRect = () => rect(100, 200, 40, 40);
    cells[1].getBoundingClientRect = () => rect(180, 200, 40, 40);
    drawSelection(sheet, { regionId: "m", kind: "cells", matrix: [], r1: 0, c1: 0, r2: 0, c2: 1 });
    const rectangle = table.querySelector(".result-selection-box rect")!;
    expect(rectangle.getAttribute("x")).toBe("28");
    expect(rectangle.getAttribute("y")).toBe("18");
    expect(rectangle.getAttribute("width")).toBe("64");
    expect(rectangle.getAttribute("height")).toBe("24");
  });

  it("shades a symbolic part as one rectangle over all it draws, a fraction's numerator and denominator included", () => {
    const sheet = document.createElement("div");
    sheet.innerHTML =
      '<div data-region-id="m"><span class="result"><span data-path="0"><span class="frac"><span class="num">a</span><span class="bar"></span><span class="den">b</span></span></span></span></div>';
    const region = sheet.querySelector<HTMLElement>("[data-region-id]")!;
    Object.defineProperty(region, "offsetWidth", { value: 200 });
    region.getBoundingClientRect = () => rect(100, 100, 200, 100);
    const node = sheet.querySelector('[data-path="0"]')!;
    node.getClientRects = () => [rect(110, 140, 20, 2)] as unknown as DOMRectList;
    sheet.querySelector(".num")!.getClientRects = () => [rect(112, 120, 16, 18)] as unknown as DOMRectList;
    sheet.querySelector(".den")!.getClientRects = () => [rect(112, 144, 16, 18)] as unknown as DOMRectList;
    drawSelection(sheet, { regionId: "m", kind: "symbolic", path: [0] });
    expect(node.classList.contains("result-selected")).toBe(true);
    const shade = region.querySelectorAll(".result-selection-box rect");
    expect(shade).toHaveLength(1);
    expect([shade[0].getAttribute("x"), shade[0].getAttribute("y"), shade[0].getAttribute("width"), shade[0].getAttribute("height")]).toEqual(["10", "20", "20", "42"]);
    drawSelection(sheet, null);
    expect(region.querySelector(".result-selection-box")).toBeNull();
  });

  it("keeps a nested matrix selection distinct from its containing cell", () => {
    const sheet = document.createElement("div");
    sheet.innerHTML = '<div data-region-id="m"><span class="result"><span class="result-matrix"><span data-result-cell="0,0"><span class="result-matrix"><span data-result-cell="0,0">1</span><span data-result-cell="0,1">2</span></span></span><span data-result-cell="0,1">3</span></span></span></div>';
    const result = sheet.querySelector(".result")!;
    const inner = result.querySelector(".result-matrix .result-matrix")!;
    const from = resultHit(result, inner.firstElementChild);
    expect(from).toEqual({ kind: "cell", matrix: [[0, 0]], r: 0, c: 0 });
    drawSelection(sheet, selectionOf("m", from, resultHit(result, inner.lastElementChild)));
    expect(inner.querySelectorAll(".result-selected")).toHaveLength(2);
    expect(inner.parentElement!.classList.contains("result-selected")).toBe(false);
    drawSelection(sheet, { regionId: "m", kind: "cells", matrix: [], r1: 0, c1: 0, r2: 0, c2: 0 });
    expect(inner.parentElement!.classList.contains("result-selected")).toBe(true);
    expect(inner.querySelector(".result-selected")).toBeNull();
  });
});
