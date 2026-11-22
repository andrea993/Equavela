// Selecting part of a result to copy it: a cell,
// a block of cells or a whole matrix of a numeric result, or a sub-expression of a symbolic one.
// The selection is screen-only state of the window, drawn by a class on the result's own elements
// (never printed), and Ctrl+C puts its value on the clipboard as math in linear text, at full
// precision and in SI units.

import type { DimensionComponent, KernelValue, WireFloat } from "../equavelaApi";
import { elementOf } from "./largeResult";
import { unionRect } from "../editor/EditorOverlay";

/** Where a matrix sits in a result: the cells (row, column) that lead to it, outermost first. */
export type MatrixPath = readonly (readonly [number, number])[];

export type ResultSelection =
  | { regionId: string; kind: "value" }
  | { regionId: string; kind: "matrix"; matrix: MatrixPath }
  | { regionId: string; kind: "cells"; matrix: MatrixPath; r1: number; c1: number; r2: number; c2: number }
  | { regionId: string; kind: "symbolic"; path: readonly number[] };

/** What a press or a drag inside a result lands on. */
export type ResultHit =
  | { kind: "cell"; matrix: MatrixPath; r: number; c: number }
  | { kind: "matrix"; matrix: MatrixPath }
  | { kind: "symbolic"; path: readonly number[] }
  | { kind: "value" };

const cellOf = (element: Element): [number, number] | null => {
  const text = element.getAttribute("data-result-cell");
  if (!text) return null;
  const [r, c] = text.split(",").map(Number);
  return Number.isInteger(r) && Number.isInteger(c) ? [r, c] : null;
};

/** The cells around `element` up to the result, outermost first. */
function cellsAround(element: Element | null, result: Element): [number, number][] {
  const out: [number, number][] = [];
  for (let e = element; e && e !== result; e = e.parentElement) {
    const cell = e.hasAttribute("data-result-cell") ? cellOf(e) : null;
    if (cell) out.unshift(cell);
  }
  return out;
}

/** The result element of a region a press landed in, else null. */
export function resultAt(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest(".result") : null;
}

const MATRIX = ".result-matrix";

function matrixCells(matrix: Element): Element[] {
  return [...matrix.querySelectorAll("[data-result-cell]")].filter((cell) => cell.closest(MATRIX) === matrix);
}

function nearestCell(matrix: Element, x: number, y: number): Element | null {
  let nearest: Element | null = null;
  let distance = Infinity;
  for (const cell of matrixCells(matrix)) {
    const r = cell.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + dy * dy;
    if (d < distance) {
      nearest = cell;
      distance = d;
    }
  }
  return nearest;
}

function matrixElement(result: Element, path: MatrixPath): Element | undefined {
  return [...result.querySelectorAll(MATRIX)].find((matrix) => samePath(cellsAround(matrix, result), path));
}

/** What a press hits, including the gaps and padding around a matrix's cells. */
export function resultHit(result: Element, target: EventTarget | null, clientX?: number, clientY?: number): ResultHit {
  const element = target instanceof Element ? target : null;
  const node = element?.closest("[data-path]");
  if (node && result.contains(node)) {
    const text = node.getAttribute("data-path") ?? "";
    return { kind: "symbolic", path: text === "" ? [] : text.split(".").map(Number) };
  }
  const matrix = element?.closest(MATRIX);
  const cell = element?.closest("[data-result-cell]");
  if (matrix && result.contains(matrix) && cell?.closest(MATRIX) !== matrix && clientX !== undefined && clientY !== undefined) {
    const nearest = nearestCell(matrix, clientX, clientY);
    if (nearest) return resultHit(result, nearest);
  }
  const cells = cellsAround(element, result);
  if (cells.length > 0) {
    // A press on the brackets of a nested matrix is that matrix, not the cell around it.
    if (matrix && result.contains(matrix) && cell?.closest(MATRIX) !== matrix) {
      return { kind: "matrix", matrix: cellsAround(matrix, result) };
    }
    const [r, c] = cells[cells.length - 1];
    return { kind: "cell", matrix: cells.slice(0, -1), r, c };
  }
  if (matrix && result.contains(matrix)) return { kind: "matrix", matrix: [] };
  return { kind: "value" };
}

/** Keep a drag anchored to its matrix, using the nearest cell across gaps as in the editor. */
export function resultDragHit(result: Element, from: ResultHit, target: EventTarget | null, x: number, y: number): ResultHit {
  if (from.kind !== "cell") return resultHit(result, target, x, y);
  const matrix = matrixElement(result, from.matrix);
  if (!matrix) return from;
  const grid = matrix.querySelector(":scope > .matrix-grid") ?? matrix;
  const bounds = grid.getBoundingClientRect();
  const viewport = matrix.closest(".result-matrix-scroll")?.getBoundingClientRect();
  if (viewport && viewport.width > 0 && viewport.height > 0 &&
      (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom)) {
    return { kind: "matrix", matrix: from.matrix };
  }
  if (bounds.width === 0 && bounds.height === 0) return resultHit(result, target, x, y);
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
    return { kind: "matrix", matrix: from.matrix };
  }
  const nearest = nearestCell(matrix, x, y);
  return nearest ? resultHit(result, nearest) : from;
}

const samePath = (a: MatrixPath, b: MatrixPath) => a.length === b.length && a.every(([r, c], i) => r === b[i][0] && c === b[i][1]);

/** The selection a press (`from`) and the current pointer (`to`) make. */
export function selectionOf(regionId: string, from: ResultHit, to: ResultHit, outside = false): ResultSelection {
  if (from.kind === "symbolic") {
    if (to.kind !== "symbolic") return { regionId, kind: "value" };
    let common = 0;
    while (common < from.path.length && common < to.path.length && from.path[common] === to.path[common]) common++;
    return { regionId, kind: "symbolic", path: from.path.slice(0, common) };
  }
  if (from.kind === "cell") {
    // A drag past the cells of the matrix selects the whole matrix.
    if (outside) return { regionId, kind: "matrix", matrix: from.matrix };
    if (to.kind === "cell" && samePath(to.matrix, from.matrix)) {
      return {
        regionId,
        kind: "cells",
        matrix: from.matrix,
        r1: Math.min(from.r, to.r),
        c1: Math.min(from.c, to.c),
        r2: Math.max(from.r, to.r),
        c2: Math.max(from.c, to.c),
      };
    }
    return { regionId, kind: "matrix", matrix: from.matrix };
  }
  if (from.kind === "matrix") return { regionId, kind: "matrix", matrix: from.matrix };
  return { regionId, kind: "value" };
}

// ---- the value of a selection ------------------------------------------------------------------

type Matrix = Extract<KernelValue, { type: "matrix" }>;

// A matrix in window form has only its first block here: a cell outside it is undefined.
const element = (m: Matrix, r: number, c: number): KernelValue | undefined => elementOf(m, r, c);

function matrixAt(value: KernelValue, path: MatrixPath): Matrix | null {
  let current: KernelValue | undefined = value;
  for (const [r, c] of path) {
    if (current?.type !== "matrix") return null;
    current = element(current, r, c);
  }
  return current?.type === "matrix" ? current : null;
}

/** The value a numeric selection stands for, else null (a symbolic selection, a stale path). */
export function selectedValue(value: KernelValue, selection: ResultSelection): KernelValue | null {
  if (selection.kind === "value") return value;
  if (selection.kind === "symbolic") return null;
  const matrix = matrixAt(value, selection.matrix);
  if (!matrix) return null;
  if (selection.kind === "matrix") return matrix.storage.type === "window" ? null : matrix;
  const { r1, c1, r2, c2 } = selection;
  if (r2 >= matrix.rows || c2 >= matrix.cols) return null;
  if (r1 === r2 && c1 === c2) return element(matrix, r1, c1) ?? null;
  const rows = r2 - r1 + 1;
  const cols = c2 - c1 + 1;
  const values: KernelValue[] = [];
  for (let c = c1; c <= c2; c++) {
    for (let r = r1; r <= r2; r++) {
      const cell = element(matrix, r, c);
      if (!cell) return null;
      values.push(cell);
    }
  }
  return { type: "matrix", rows, cols, storage: { type: "inline", values } };
}

// ---- linear text --------------------------------------------------------------

/** A number at full precision: the shortest text that reads back as the same double. */
function numberText(value: WireFloat): string {
  if (value === "nan") return "NaN";
  if (value === "infinity") return "∞";
  if (value === "-infinity") return "-∞";
  return String(value);
}

function complexText(re: WireFloat, im: WireFloat): string {
  const imag = typeof im === "number" ? im : NaN;
  if (imag === 0) return numberText(re);
  const sign = imag < 0 ? "-" : "+";
  const magnitude = `${numberText(typeof im === "number" ? Math.abs(im) : im)}i`;
  return re === 0 ? `${imag < 0 ? "-" : ""}${magnitude}` : `${numberText(re)} ${sign} ${magnitude}`;
}

function unitsText(dimension: DimensionComponent[]): string {
  return dimension
    .filter((d) => d.power[0] !== 0)
    .map(({ base, power: [n, d] }) => {
      const unit = `${base}@unit`;
      if (d === 1) return n === 1 ? unit : `${unit}^${n}`;
      return `${unit}^(${n}/${d})`;
    })
    .join("·");
}

/** The linear text of a value, for the clipboard; null when it has none (a Julia handle). */
export function valueText(value: KernelValue): string | null {
  switch (value.type) {
    case "real":
      return numberText(value.value);
    case "complex":
      return complexText(value.real, value.imag);
    case "string":
      return JSON.stringify(value.value);
    case "quantity": {
      const m = value.magnitude;
      const magnitude = m.type === "real" ? numberText(m.value) : `(${complexText(m.real, m.imag)})`;
      const units = unitsText(value.dimension);
      return units ? `${magnitude}·${units}` : magnitude;
    }
    case "matrix": {
      const rows: string[] = [];
      for (let r = 0; r < value.rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < value.cols; c++) {
          const cell = element(value, r, c);
          const text = cell ? valueText(cell) : null;
          if (text === null) return null;
          cells.push(text);
        }
        rows.push(cells.join(", "));
      }
      return `[${rows.join("; ")}]`;
    }
    case "symbolic":
      return value.text;
    case "handle":
      return null;
  }
}

// ---- drawing -----------------------------------------------------------------------------------

/** One shaded rectangle over everything `target` draws, in the coordinates of `region`. */
function shadeBox(region: HTMLElement, target: Element): void {
  const box = unionRect(target);
  if (!box) return;
  const origin = region.getBoundingClientRect();
  const zoom = region.offsetWidth > 0 ? origin.width / region.offsetWidth : 1;
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.setAttribute("class", "result-selection-box no-print");
  overlay.setAttribute("aria-hidden", "true");
  const rectangle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rectangle.setAttribute("class", "selection");
  rectangle.setAttribute("x", String((box.left - origin.left) / zoom));
  rectangle.setAttribute("y", String((box.top - origin.top) / zoom));
  rectangle.setAttribute("width", String(box.width / zoom));
  rectangle.setAttribute("height", String(box.height / zoom));
  rectangle.setAttribute("rx", "2");
  overlay.append(rectangle);
  region.append(overlay);
}

const SELECTED = "result-selected";

/** Marks the selected part of the result inside `region` (screen only); clears earlier marks. */
export function drawSelection(sheet: Element, selection: ResultSelection | null): void {
  for (const overlay of sheet.querySelectorAll(".result-selection-box")) overlay.remove();
  for (const element of sheet.querySelectorAll(`.${SELECTED}`)) element.classList.remove(SELECTED);
  if (!selection) return;
  const region = sheet.querySelector(`[data-region-id="${CSS.escape(selection.regionId)}"]`);
  const result = region?.querySelector(".result");
  if (!result) return;
  const mark = (e: Element | null | undefined) => e?.classList.add(SELECTED);
  if (selection.kind === "value" || selection.kind === "symbolic") {
    const target = selection.kind === "value" ? result : result.querySelector(`[data-path="${selection.path.join(".")}"]`);
    mark(target);
    // An inline span's own background covers one line box (a fraction showed only its bar): shade the
    // box over everything the part draws instead.
    if (target && region instanceof HTMLElement) shadeBox(region, target);
    return;
  }
  const matrix = matrixElement(result, selection.matrix);
  if (!matrix) return;
  if (selection.kind === "matrix") {
    mark(matrix);
    if (region instanceof HTMLElement) shadeBox(region, matrix);
    return;
  }
  const cells = matrixCells(matrix).filter((cell) => {
    const at = cellOf(cell);
    return at && at[0] >= selection.r1 && at[0] <= selection.r2 && at[1] >= selection.c1 && at[1] <= selection.c2;
  });
  cells.forEach(mark);
  if (cells.length === 0 || !(matrix instanceof HTMLElement)) return;
  // Match the editor's single filled rectangle, including the space between selected cells.
  const origin = matrix.getBoundingClientRect();
  const zoom = matrix.offsetWidth > 0 ? origin.width / matrix.offsetWidth : 1;
  const boxes = cells.map((cell) => cell.getBoundingClientRect());
  const pad = cells.length > 1 ? 2 : 0;
  const left = (Math.min(...boxes.map((box) => box.left)) - origin.left) / zoom + matrix.scrollLeft - pad;
  const top = (Math.min(...boxes.map((box) => box.top)) - origin.top) / zoom + matrix.scrollTop - pad;
  const width = (Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.left))) / zoom + 2 * pad;
  const height = (Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top))) / zoom + 2 * pad;
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.setAttribute("class", "result-selection-box no-print");
  overlay.setAttribute("aria-hidden", "true");
  const rectangle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rectangle.setAttribute("class", "selection matrix-selection");
  rectangle.setAttribute("x", String(left));
  rectangle.setAttribute("y", String(top));
  rectangle.setAttribute("width", String(width));
  rectangle.setAttribute("height", String(height));
  overlay.append(rectangle);
  matrix.append(overlay);
}
