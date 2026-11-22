// Large matrix results: the window form a large matrix reaches the
// frontend in, and the blocks read as its box scrolls. The core does the same in
// `KernelValue::display_form` and `KernelValue::block`; the mock backend uses these.

import type { KernelValue, RegionState } from "../equavelaApi";

/** A matrix with more elements than this arrives as its first block. */
export const WINDOW_LIMIT = 10_000;
/** The rows and columns of that first block, and of every block the table reads. */
export const WINDOW_ROWS = 100;
export const WINDOW_COLS = 50;

export type Matrix = Extract<KernelValue, { type: "matrix" }>;

/** The elements of rows `row..row+rows` and columns `col..col+cols` of an inline matrix, column-major. */
export function blockOf(value: KernelValue, row: number, col: number, rows: number, cols: number): KernelValue[] | null {
  if (value.type !== "matrix" || value.storage.type !== "inline") return null;
  const rowEnd = Math.min(row + rows, value.rows);
  const colEnd = Math.min(col + cols, value.cols);
  const out: KernelValue[] = [];
  for (let c = col; c < colEnd; c++) {
    for (let r = row; r < rowEnd; r++) out.push(value.storage.values[c * value.rows + r]);
  }
  return out;
}

/** The form the frontend receives: a large inline matrix becomes its first block. */
export function displayForm(value: KernelValue): KernelValue {
  if (value.type !== "matrix" || value.storage.type !== "inline" || value.rows * value.cols <= WINDOW_LIMIT) return value;
  const rows = Math.min(value.rows, WINDOW_ROWS);
  const cols = Math.min(value.cols, WINDOW_COLS);
  return {
    ...value,
    storage: { type: "window", row: 0, col: 0, rows, cols, values: blockOf(value, 0, 0, rows, cols)! },
  };
}

/** A result state in the form the frontend receives. */
export function displayState<T extends RegionState>(state: T): T {
  if ((state.state === "value" || state.state === "stale") && state.value) {
    return { ...state, value: displayForm(state.value) };
  }
  return state;
}

/** The element (r, c) of a matrix in either form, or undefined when its block is not here. */
export function elementOf(m: Matrix, r: number, c: number): KernelValue | undefined {
  const storage = m.storage;
  if (storage.type === "inline") return storage.values[c * m.rows + r];
  if (r < storage.row || c < storage.col || r >= storage.row + storage.rows || c >= storage.col + storage.cols) return undefined;
  return storage.values[(c - storage.col) * storage.rows + (r - storage.row)];
}
