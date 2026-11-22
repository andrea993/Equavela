// Display of a kernel value after `=` or `→`.

import { Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { BracketSide, MathExpr } from "../math/render";
import { isNode } from "../math/ast";
import { ptToPx } from "../layout/geometry";
import { S } from "../strings";
import type { DisplayUnit, KernelValue, RegionKey, WireFloat } from "../equavelaApi";
import {
  formatComplex,
  formatReal,
  isBoxedMatrix,
  resultUnit,
  unitRuns,
  type NumberParts,
  type ResultFormat,
} from "./format";
import { elementOf, WINDOW_COLS, WINDOW_ROWS } from "./largeResult";

/**
 * Reads a block of the matrix result being drawn: rows `row..row+rows`
 * and columns `col..col+cols`, column-major. Given by the region that draws its own result.
 */
export type BlockReader = (row: number, col: number, rows: number, cols: number) => Promise<KernelValue[]>;
export const ResultBlockContext = createContext<BlockReader | null>(null);
/** Reads a block of the result of any region of the worksheet in view (given by the workbench). */
export const ResultBlocksContext = createContext<((key: RegionKey, row: number, col: number, rows: number, cols: number) => Promise<KernelValue[]>) | null>(null);

function Parts({ parts }: { parts: NumberParts }) {
  return (
    <span className="num-lit">
      {parts.mantissa}
      {parts.exponent !== null && (
        <>
          <span className="op times">·</span>
          10
          <span className="sup">{parts.exponent < 0 ? `−${-parts.exponent}` : parts.exponent}</span>
        </>
      )}
      {parts.suffix && <span className="up">{parts.suffix}</span>}
    </span>
  );
}

export function UnitText({ text }: { text: string }) {
  return (
    <span className="unit-text">
      {unitRuns(text).map((run, i) =>
        run.sup ? (
          <span key={i} className="sup">
            {run.text}
          </span>
        ) : (
          <Fragment key={i}>{run.text}</Fragment>
        ),
      )}
    </span>
  );
}

/** How an SI value is shown in a display unit: `(value - offset) / divisor`. */
type Scale = { divisor: number; offset: number };
const SI: Scale = { divisor: 1, offset: 0 };

function divide(value: WireFloat, scale: Scale, offset = scale.offset): WireFloat {
  if (typeof value !== "number" || (scale.divisor === 1 && offset === 0)) return value;
  return (value - offset) / scale.divisor;
}

type Scalar = Extract<KernelValue, { type: "real" | "complex" }>;

function scalarView(value: Scalar, scale: Scale, format: ResultFormat): ReactNode {
  if (value.type === "real") {
    return <Parts parts={formatReal(divide(value.value, scale), format)} />;
  }
  const parts = formatComplex(divide(value.real, scale), divide(value.imag, scale, 0), format);
  if (parts.polar) {
    return (
      <span className="complex polar">
        <Parts parts={parts.polar.magnitude} />
        <span className="op binary">∠</span>
        <Parts parts={parts.polar.angle} />
        <span className="up">°</span>
      </span>
    );
  }
  return (
    <span className="complex">
      {parts.real && <Parts parts={parts.real} />}
      {parts.sign && <span className="op binary">{parts.sign}</span>}
      {parts.imag && (
        <>
          <Parts parts={parts.imag} />
          <span className="up">{format.imaginary}</span>
        </>
      )}
    </span>
  );
}

type ValueProps = {
  value: KernelValue;
  displayUnit?: DisplayUnit;
  format: ResultFormat;
  /**
   * A press on the corner handle of the box of a matrix result: the page view's resize gesture. Absent
   * where a matrix cannot have a box of its own (an inline result of a text region, the probe layer).
   */
  onTableResizeStart?: (event: PointerEvent<HTMLElement>) => void;
  /**
   * Whether the region is active, selected or edited: a clipped classic matrix
   * then scrolls; at rest (false) it keeps its place and says with ellipses that it continues. Absent
   * is active.
   */
  active?: boolean;
};

/** What a clipped classic matrix at rest shows: the rows and columns wholly in its box. */
type Rest = { rowFirst: number; rowLast: number; colFirst: number; colLast: number };

/** The cells a grid draws, by their (row, column), from `data-result-cell` (a clipped matrix draws a window of them). */
function drawnCells(grid: Element | null): Map<string, Element> {
  const cells = new Map<string, Element>();
  for (const cell of grid?.children ?? []) {
    const at = cell.getAttribute("data-result-cell");
    if (at) cells.set(at, cell);
  }
  return cells;
}

/** The rows and columns wholly inside the box `scroller`, or null when every one of them is. */
function restOf(scroller: HTMLElement, rows: number, cols: number): Rest | null {
  const box = scroller.getBoundingClientRect();
  const top = box.top;
  const bottom = box.top + scroller.clientHeight;
  const left = box.left;
  const right = box.left + scroller.clientWidth;
  const inside = (low: number, high: number, from: number, to: number) => low >= from - 0.5 && high <= to + 0.5;
  // One drawn cell per row and per column is enough: the cells of a row share its track, the cells of
  // a column theirs. The window of a clipped matrix holds every row and column the box shows.
  const rowRect = new Map<number, DOMRect>();
  const colRect = new Map<number, DOMRect>();
  for (const [at, cell] of drawnCells(scroller.querySelector(".matrix-grid"))) {
    const [r, c] = at.split(",").map(Number);
    if (!rowRect.has(r) || !colRect.has(c)) {
      const rect = cell.getBoundingClientRect();
      if (!rowRect.has(r)) rowRect.set(r, rect);
      if (!colRect.has(c)) colRect.set(c, rect);
    }
  }
  const shownRows = [...rowRect].filter(([, rect]) => inside(rect.top, rect.bottom, top, bottom)).map(([r]) => r).sort((x, y) => x - y);
  const shownCols = [...colRect].filter(([, rect]) => inside(rect.left, rect.right, left, right)).map(([c]) => c).sort((x, y) => x - y);
  if (shownRows.length === 0 || shownCols.length === 0) return null;
  const rest = { rowFirst: shownRows[0], rowLast: shownRows[shownRows.length - 1], colFirst: shownCols[0], colLast: shownCols[shownCols.length - 1] };
  const whole = rest.rowFirst === 0 && rest.rowLast === rows - 1 && rest.colFirst === 0 && rest.colLast === cols - 1;
  return whole ? null : rest;
}

/** The class of cell (r, c) of a matrix at rest: hidden outside the box, or an ellipsis at its edges. */
function restClass(rest: Rest | null, r: number, c: number, rows: number, cols: number): string {
  if (!rest) return "";
  if (r < rest.rowFirst || r > rest.rowLast || c < rest.colFirst || c > rest.colLast) return " off";
  const vertical = (r === rest.rowFirst && r > 0) || (r === rest.rowLast && r < rows - 1);
  const horizontal = (c === rest.colFirst && c > 0) || (c === rest.colLast && c < cols - 1);
  if (vertical && horizontal) return " dots dots-d";
  if (vertical) return " dots dots-v";
  if (horizontal) return " dots dots-h";
  return "";
}

/** The cells each grid has marked for its rest, so the next rest clears only those. */
const MARKED = new WeakMap<Element, Element[]>();

/**
 * Marks the cells of `grid` for `rest` in place, so the cells themselves never render again for
 * it. Only the rows and columns at the edges of the box are marked: a cell further out is clipped by
 * the box anyway, and marking every cell of a large matrix cost a style pass over all of them.
 */
function applyRest(grid: Element | null, rest: Rest | null, rows: number, cols: number): void {
  if (!grid) return;
  for (const cell of MARKED.get(grid) ?? []) cell.classList.remove("off", "dots", "dots-v", "dots-h", "dots-d");
  MARKED.delete(grid);
  if (!rest) return;
  const within = (n: number, count: number) => n >= 0 && n < count;
  const edgeRows = [rest.rowFirst - 1, rest.rowFirst, rest.rowLast, rest.rowLast + 1].filter((r) => within(r, rows));
  const edgeCols = [rest.colFirst - 1, rest.colFirst, rest.colLast, rest.colLast + 1].filter((c) => within(c, cols));
  const indices = new Set<number>();
  for (const r of edgeRows) for (let c = Math.max(0, rest.colFirst - 1); c <= Math.min(cols - 1, rest.colLast + 1); c++) indices.add(r * cols + c);
  for (const c of edgeCols) for (let r = Math.max(0, rest.rowFirst - 1); r <= Math.min(rows - 1, rest.rowLast + 1); r++) indices.add(r * cols + c);
  const marked: Element[] = [];
  const drawn = drawnCells(grid);
  for (const i of indices) {
    const want = restClass(rest, Math.floor(i / cols), i % cols, rows, cols).trim();
    const cell = drawn.get(`${Math.floor(i / cols)},${i % cols}`);
    if (!want || !cell) continue;
    cell.classList.add(...want.split(" "));
    marked.push(cell);
  }
  MARKED.set(grid, marked);
}

/** The unit shared by every element of a matrix, if there is one. */
function commonUnit(values: KernelValue[], displayUnit?: DisplayUnit) {
  let shared: { text: string; divisor: number; offset: number } | null = null;
  for (const value of values) {
    if (value.type !== "quantity") return null;
    const unit = resultUnit(value.dimension, displayUnit);
    if (shared && shared.text !== unit.text) return null;
    shared = unit;
  }
  return shared;
}

function cell(value: KernelValue, scale: Scale, format: ResultFormat, withUnit: boolean): ReactNode {
  if (value.type === "quantity") {
    const unit = withUnit ? resultUnit(value.dimension) : null;
    return (
      <>
        {scalarView(value.magnitude, scale, format)}
        {unit && unit.text && (
          <>
            <span className="juxt" />
            <UnitText text={unit.text} />
          </>
        )}
      </>
    );
  }
  // Nested arrays: collapsed to their size unless `expand-nested-arrays` is on
  if (value.type === "matrix" && !format.expandNested) {
    return <span className="nested-collapsed up">{`{${value.rows}×${value.cols}}`}</span>;
  }
  return <ValueView value={value} format={format} />;
}

/**
 * The blocks of a matrix in window form read so far: `need` asks for the blocks a range of
 * rows and columns covers, `at` gives an element of one that has arrived. A new value starts over.
 */
/** Whether the block starting at (row, col) came with the value itself (its first block). */
function inWindow(value: Extract<KernelValue, { type: "matrix" }>, row: number, col: number): boolean {
  const s = value.storage;
  if (s.type !== "window") return true;
  const rowEnd = Math.min(row + WINDOW_ROWS, value.rows);
  const colEnd = Math.min(col + WINDOW_COLS, value.cols);
  return row >= s.row && col >= s.col && rowEnd <= s.row + s.rows && colEnd <= s.col + s.cols;
}

function useBlocks(value: Extract<KernelValue, { type: "matrix" }>) {
  const read = useContext(ResultBlockContext);
  const [loaded, setLoaded] = useState(() => new Map<string, KernelValue[]>());
  const asked = useRef(new Set<string>());
  const current = useRef(value);
  useEffect(() => {
    if (current.current === value) return;
    current.current = value;
    asked.current = new Set();
    setLoaded(new Map());
  }, [value]);
  const need = useCallback(
    ({ rowStart, rowEnd, colStart, colEnd }: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }) => {
      if (!read || rowEnd <= rowStart || colEnd <= colStart) return;
      for (let br = Math.floor(rowStart / WINDOW_ROWS); br * WINDOW_ROWS < rowEnd; br++) {
        for (let bc = Math.floor(colStart / WINDOW_COLS); bc * WINDOW_COLS < colEnd; bc++) {
          const key = `${br},${bc}`;
          if (asked.current.has(key) || inWindow(value, br * WINDOW_ROWS, bc * WINDOW_COLS)) continue;
          asked.current.add(key);
          const asking = value;
          read(br * WINDOW_ROWS, bc * WINDOW_COLS, WINDOW_ROWS, WINDOW_COLS).then(
            (block) => {
              if (current.current !== asking) return;
              setLoaded((before) => new Map(before).set(key, block));
            },
            // A block that could not be read is asked again when it comes into view again.
            () => asked.current.delete(key),
          );
        }
      }
    },
    [read, value],
  );
  const at = (r: number, c: number): KernelValue | undefined => {
    const br = Math.floor(r / WINDOW_ROWS);
    const bc = Math.floor(c / WINDOW_COLS);
    const block = loaded.get(`${br},${bc}`);
    if (!block) return undefined;
    const blockRows = Math.min(WINDOW_ROWS, value.rows - br * WINDOW_ROWS);
    return block[(c - bc * WINDOW_COLS) * blockRows + (r - br * WINDOW_ROWS)];
  };
  return { need, at, loaded };
}

// ---- a clipped classic matrix draws only its window -------------------------------------

/** The column widths and row heights of a classic matrix, CSS px, as its full grid lays them out. */
type Tracks = { value: KernelValue; key: string; font: string; cols: number[]; rows: number[] };
/** The rows and columns a clipped matrix draws: the ones in its box, and a margin. */
export type MatrixWindow = { rowStart: number; rowEnd: number; colStart: number; colEnd: number };

/** Tracks measured once per value and format, so a region mounted again draws its window at once. */
const TRACKS = new WeakMap<KernelValue, Map<string, Tracks>>();
/** The rows and columns drawn beyond the edges of the box. */
const WINDOW_MARGIN_ROWS = 3;
const WINDOW_MARGIN_COLS = 2;
/** The default box of a clipped matrix (`.result-matrix-scroll` max size), before it is laid out. */
const DEFAULT_BOX_PX = { width: 560, height: 240 };

/** The px sizes of a computed `grid-template-*`, or null when it is not a list of `count` lengths (no layout, jsdom). */
function trackSizes(computed: string, count: number): number[] | null {
  const sizes = computed.trim().split(/\s+/).map((part) => (part.endsWith("px") ? parseFloat(part) : NaN));
  return sizes.length === count && sizes.every(Number.isFinite) ? sizes : null;
}

/**
 * The tracks `[from, to)` that overlap the span `[low, high)` of a grid whose tracks have `sizes` and
 * `gap` between them, widened by `margin` on each side.
 */
export function tracksIn(sizes: readonly number[], gap: number, low: number, high: number, margin: number): [number, number] {
  let start = sizes.length;
  let end = 0;
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    const next = at + sizes[i];
    if (next >= low && at <= high) {
      start = Math.min(start, i);
      end = i + 1;
    }
    at = next + gap;
  }
  if (start > end) return [0, Math.min(sizes.length, 1 + margin)];
  return [Math.max(0, start - margin), Math.min(sizes.length, end + margin)];
}

/**
 * Where `grid` starts in the scrolled content of `scroller`, CSS px. Read from the layout offsets and
 * the scroll position, not from screen rectangles: the zoom read off rounded widths is a little off,
 * and that error times the scroll of a long matrix put the drawn rows far from the box.
 */
function gridInContent(scroller: HTMLElement, grid: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let e: HTMLElement | null = grid;
  while (e && e !== scroller && e !== scroller.offsetParent) {
    x += e.offsetLeft;
    y += e.offsetTop;
    e = e.offsetParent as HTMLElement | null;
  }
  if (e === scroller.offsetParent) {
    x -= scroller.offsetLeft + scroller.clientLeft;
    y -= scroller.offsetTop + scroller.clientTop;
  }
  return { x, y };
}

/** `sizes` measured on the first rows or columns, followed by their largest up to `count`. */
function extended(sizes: number[], count: number): number[] {
  if (sizes.length >= count) return sizes;
  const largest = Math.max(0, ...sizes);
  return [...sizes, ...Array.from({ length: count - sizes.length }, () => largest)];
}

/** A `grid-template-*` of px tracks, runs of one size written once with `repeat()`. */
export function trackTemplate(sizes: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < sizes.length; ) {
    let j = i + 1;
    while (j < sizes.length && sizes[j] === sizes[i]) j++;
    parts.push(j - i > 1 ? `repeat(${j - i}, ${sizes[i]}px)` : `${sizes[i]}px`);
    i = j;
  }
  return parts.join(" ");
}

function sameWindow(a: MatrixWindow, b: MatrixWindow): boolean {
  return a.rowStart === b.rowStart && a.rowEnd === b.rowEnd && a.colStart === b.colStart && a.colEnd === b.colEnd;
}

function MatrixResult({
  value,
  displayUnit,
  format,
  onTableResizeStart,
  active,
}: ValueProps & { value: Extract<KernelValue, { type: "matrix" }> }) {
  const { rows, cols, storage } = value;
  // at rest the box keeps the part it was scrolled to and marks its edges with ellipses.
  const scroller = useRef<HTMLSpanElement>(null);
  // A press on the result gives its box the keyboard: the box is
  // active while it has it, even when the region itself is not selected.
  const [focused, setFocused] = useState(false);
  const still = active === false && !focused;
  const boxWidth = format.tableSize?.[0];
  const boxHeight = format.tableSize?.[1];
  // The rest is marked on the cells in place: selecting or leaving the region must not draw
  // every cell of a large matrix again.
  const showRest = (element: HTMLElement | null) =>
    applyRest(element?.querySelector(".matrix-grid") ?? null, still && element ? restOf(element, rows, cols) : null, rows, cols);
  const values = storage.values;
  const unit = commonUnit(values, displayUnit);
  const scale = unit ?? SI;
  const blocks = useBlocks(value);
  const at = (r: number, c: number): KernelValue | undefined => elementOf(value, r, c) ?? blocks.at(r, c);
  const render = (r: number, c: number): ReactNode => {
    const element = at(r, c);
    return element ? cell(element, scale, format, unit === null) : null;
  };
  const windowForm = storage.type === "window";
  const boxed = isBoxedMatrix(value, format);
  // The rows and columns laid out to measure the tracks: every cell, or the first block of a matrix
  // that arrives in window form, whose size the rest of its rows and columns take.
  const measureRows = storage.type === "window" ? Math.min(rows, storage.rows) : rows;
  const measureCols = storage.type === "window" ? Math.min(cols, storage.cols) : cols;
  // A clipped classic matrix draws only the cells in its box: every cell of a 100 x 100 matrix
  // in the page made each selection, edit and move lay out and restyle 10 000 cells. The full grid is
  // laid out once per value and format to learn its column widths and row heights (the same `auto`
  // tracks as before); then the grid keeps those tracks and draws a window of its cells in place.
  const trackKey = useMemo(() => JSON.stringify([{ ...format, tableSize: null, showIndices: false }, displayUnit ?? null]), [format, displayUnit]);
  const [measured, setMeasured] = useState<Tracks | null>(null);
  const tracks: Tracks | null = !boxed
    ? null
    : measured && measured.value === value && measured.key === trackKey
      ? measured
      : (TRACKS.get(value)?.get(trackKey) ?? null);
  const [cellWindow, setCellWindow] = useState<MatrixWindow>({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 });
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  /** The rows and columns in the box now, with the margin. */
  const updateWindow = (): void => {
    const element = scroller.current;
    const grid = element?.querySelector<HTMLElement>(".matrix-grid");
    if (!element || !grid || !tracks) return;
    const style = getComputedStyle(grid);
    const width = element.clientWidth || (boxWidth ? ptToPx(boxWidth) : DEFAULT_BOX_PX.width);
    const height = element.clientHeight || (boxHeight ? ptToPx(boxHeight) : DEFAULT_BOX_PX.height);
    const at = gridInContent(element, grid);
    const left = element.scrollLeft - at.x;
    const top = element.scrollTop - at.y;
    const [colStart, colEnd] = tracksIn(tracks.cols, parseFloat(style.columnGap) || 0, left, left + width, WINDOW_MARGIN_COLS);
    const [rowStart, rowEnd] = tracksIn(tracks.rows, parseFloat(style.rowGap) || 0, top, top + height, WINDOW_MARGIN_ROWS);
    const next = { rowStart, rowEnd, colStart, colEnd };
    setCellWindow((current) => (sameWindow(current, next) ? current : next));
  };
  useLayoutEffect(() => {
    if (!boxed) return;
    const grid = scroller.current?.querySelector<HTMLElement>(".matrix-grid");
    if (!grid) return;
    const style = getComputedStyle(grid);
    if (!tracks) {
      // The full grid (or the first block) is on the page: read the tracks it was laid out with.
      const colSizes = trackSizes(style.gridTemplateColumns, measureCols);
      const rowSizes = trackSizes(style.gridTemplateRows, measureRows);
      if (!colSizes || !rowSizes) return;
      const next: Tracks = { value, key: trackKey, font: style.font, cols: extended(colSizes, cols), rows: extended(rowSizes, rows) };
      // Sizes measured before the fonts arrived are used, not kept: the fonts change them.
      if (typeof document === "undefined" || document.fonts?.status !== "loading") {
        const byKey = TRACKS.get(value) ?? new Map<string, Tracks>();
        byKey.set(trackKey, next);
        TRACKS.set(value, byKey);
      } else {
        void document.fonts.ready.then(() => setMeasured(null));
      }
      setMeasured(next);
      return;
    }
    // Another math font (MF) lays the cells out at other sizes: measure again.
    if (style.font !== tracks.font) {
      TRACKS.get(value)?.delete(trackKey);
      setMeasured(null);
      return;
    }
    updateWindow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxed, tracks, value, trackKey, rows, cols, boxWidth, boxHeight]);
  // A matrix in window form reads the blocks that come into its box.
  const { need } = blocks;
  useEffect(() => {
    if (windowForm) need(cellWindow);
  }, [windowForm, need, cellWindow]);
  useLayoutEffect(() => {
    showRest(scroller.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still, value, rows, cols, boxWidth, boxHeight, cellWindow, tracks]);
  // The cells of a classic matrix depend on the value and the format only: a new selection, a drag of
  // the region or the box coming to rest renders the region again but reuses them.
  const classicGrid = useMemo(
    () =>
      tracks ? null : (
        <span className={`matrix result-matrix${boxed ? " in-box" : ""}`} data-rows={rows} data-cols={cols}>
          {!boxed && <MatrixBracket side="left" />}
          <span className="matrix-grid" style={{ gridTemplateColumns: `repeat(${measureCols}, auto)` }}>
            {Array.from({ length: measureRows * measureCols }, (_, i) => {
              const r = Math.floor(i / measureCols);
              const c = i % measureCols;
              return (
                <span key={i} className="cell" data-result-cell={`${r},${c}`}>
                  {render(r, c)}
                </span>
              );
            })}
          </span>
          {!boxed && <MatrixBracket side="right" />}
        </span>
      ),
    // `render` reads only the value, the format and the shared unit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxed, tracks !== null, value, format, displayUnit, rows, cols],
  );
  const windowGrid = useMemo(() => {
    if (!tracks) return null;
    const cells: ReactNode[] = [];
    for (let r = cellWindow.rowStart; r < cellWindow.rowEnd; r++) {
      for (let c = cellWindow.colStart; c < cellWindow.colEnd; c++) {
        cells.push(
          <span key={r * cols + c} className="cell" data-result-cell={`${r},${c}`} style={{ gridRow: r + 1, gridColumn: c + 1 }}>
            {render(r, c)}
          </span>,
        );
      }
    }
    return (
      <span className="matrix result-matrix in-box" data-rows={rows} data-cols={cols}>
        <span
          className="matrix-grid"
          style={{ gridTemplateColumns: trackTemplate(tracks.cols), gridTemplateRows: trackTemplate(tracks.rows) }}
        >
          {cells}
        </span>
      </span>
    );
    // `render` reads only the value, the format, the shared unit and the blocks read so far.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, cellWindow, value, format, displayUnit, rows, cols, blocks.loaded]);
  // A matrix in window form took the size of its first block for every row and column; a cell read
  // later that is wider or taller widens its column or its row, so no value is cut.
  useLayoutEffect(() => {
    if (!tracks || !windowForm) return;
    const grid = scroller.current?.querySelector<HTMLElement>(".matrix-grid");
    if (!grid) return;
    let next: Tracks | null = null;
    for (const element of grid.querySelectorAll<HTMLElement>(":scope > [data-result-cell]")) {
      const [r, c] = (element.dataset.resultCell ?? "").split(",").map(Number);
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const base = next ?? tracks;
      if (width > base.cols[c] + 0.5 || height > base.rows[r] + 0.5) {
        next ??= { ...tracks, cols: [...tracks.cols], rows: [...tracks.rows] };
        next.cols[c] = Math.max(next.cols[c], width);
        next.rows[r] = Math.max(next.rows[r], height);
      }
    }
    if (!next) return;
    TRACKS.get(value)?.set(trackKey, next);
    setMeasured(next);
  }, [tracks, windowForm, value, trackKey, windowGrid]);
  // the indices around the matrix, placed over the tracks of its grid as it is drawn now.
  const host = useRef<HTMLSpanElement>(null);
  const [indexLayout, setIndexLayout] = useState<IndexLayout | null>(null);
  const placeIndices = (): void => {
    if (!format.showIndices) return;
    const next = measureIndices(host.current, boxed ? scroller.current : null, tracks, rows, cols);
    setIndexLayout((current) => (sameIndexLayout(current, next) ? current : next));
  };
  useLayoutEffect(placeIndices);
  // The scroll bars of a clipped matrix stand outside its brackets: the box
  // between the brackets scrolls without bars of its own, and two bars beside it, right of the closing
  // bracket and under the box, scroll it. `extent` is what they need: the scrolled size and the view.
  const [extent, setExtent] = useState<{ w: number; h: number; cw: number; ch: number } | null>(null);
  const barX = useRef<HTMLSpanElement>(null);
  const barY = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!boxed || !element) return;
    const next = { w: element.scrollWidth, h: element.scrollHeight, cw: element.clientWidth, ch: element.clientHeight };
    setExtent((current) =>
      current && current.w === next.w && current.h === next.h && current.cw === next.cw && current.ch === next.ch ? current : next,
    );
  });
  const syncBars = (element: HTMLElement) => {
    if (barX.current && barX.current.scrollLeft !== element.scrollLeft) barX.current.scrollLeft = element.scrollLeft;
    if (barY.current && barY.current.scrollTop !== element.scrollTop) barY.current.scrollTop = element.scrollTop;
  };
  // A bar shown again starts where the box is.
  useLayoutEffect(() => {
    if (scroller.current) syncBars(scroller.current);
  });
  const classic = windowGrid ?? classicGrid;
  const unitLabel = unit?.text && (
    <>
      <span className="juxt" />
      <UnitText text={unit.text} />
    </>
  );
  const indexed = (body: ReactNode): ReactNode =>
    format.showIndices ? (
      <MatrixIndices
        layout={indexLayout}
        rows={rows}
        cols={cols}
        origin={format.origin}
        range={tracks ? cellWindow : null}
        host={host}
      >
        {body}
      </MatrixIndices>
    ) : (
      body
    );
  if (!boxed) return indexed(<>{classic}{unitLabel}</>);
  // A large classic matrix sits in the box of : the stored size, the corner handle,
  // and scroll bars on screen. A matrix that is not large keeps its natural size and has no box.
  const box = format.tableSize;
  const scrollsX = !still && extent !== null && extent.w > extent.cw + 1;
  const scrollsY = !still && extent !== null && extent.h > extent.ch + 1;
  /** A press on a bar keeps the box active, as a press on its own bar did. */
  const pressBar = () => scroller.current?.focus({ preventScroll: true });
  return indexed(
    <span className="result-matrix-wrap">
      <span className={`result-matrix-box bracketed${scrollsX ? " bar-x" : ""}${scrollsY ? " bar-y" : ""}`}>
        {/* The brackets stand at the edges of the box, whole, whatever part of the matrix is scrolled
            into it. */}
        <MatrixBracket side="left" />
        <span
          ref={scroller}
          className={`result-matrix-scroll${box ? " sized" : ""}${still ? " still" : ""}`}
          style={box ? { width: `${ptToPx(box[0])}px`, height: `${ptToPx(box[1])}px` } : undefined}
          tabIndex={0}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
          }}
          // A box at rest that scrolls all the same (a find, a script) shows its new edges.
          onScroll={(event) => {
            const element = event.currentTarget;
            cancelAnimationFrame(frame.current);
            frame.current = requestAnimationFrame(() => {
              updateWindow();
              placeIndices();
            });
            if (still) showRest(element);
            syncBars(element);
          }}
        >
          {classic}
        </span>
        <MatrixBracket side="right" />
        {scrollsY && (
          <span
            ref={barY}
            className="matrix-scrollbar vertical no-print"
            style={{ height: `${extent.ch}px` }}
            onPointerDown={pressBar}
            onScroll={(event) => {
              const element = scroller.current;
              if (element && element.scrollTop !== event.currentTarget.scrollTop) element.scrollTop = event.currentTarget.scrollTop;
            }}
          >
            <span style={{ height: `${extent.h}px` }} />
          </span>
        )}
        {scrollsX && (
          <span
            ref={barX}
            className="matrix-scrollbar horizontal no-print"
            style={{ width: `${extent.cw}px` }}
            onPointerDown={pressBar}
            onScroll={(event) => {
              const element = scroller.current;
              if (element && element.scrollLeft !== event.currentTarget.scrollLeft) element.scrollLeft = event.currentTarget.scrollLeft;
            }}
          >
            <span style={{ width: `${extent.w}px` }} />
          </span>
        )}
        {onTableResizeStart && (
          <span
            className="resize-handle corner no-print"
            role="separator"
            aria-label={S.page.resizeResultBox}
            data-testid="table-resize-handle"
            onPointerDown={onTableResizeStart}
          />
        )}
      </span>
      {unitLabel}
    </span>,
  );
}

// ---- the indices of a matrix result ----------------------------------------

/**
 * Where the indices go, in CSS px of the matrix's own box (`host`): the tracks of its grid, where the
 * grid starts (scrolled, in a clipped matrix), and the part of the host the cells are seen in.
 */
type IndexLayout = {
  cols: number[];
  rows: number[];
  colGap: number;
  rowGap: number;
  x: number;
  y: number;
  clip: { left: number; top: number; right: number; bottom: number };
};

function measureIndices(
  host: HTMLElement | null,
  scroller: HTMLElement | null,
  tracks: Tracks | null,
  rows: number,
  cols: number,
): IndexLayout | null {
  const grid = host?.querySelector<HTMLElement>(".matrix-grid");
  if (!host || !grid) return null;
  const style = getComputedStyle(grid);
  const colSizes = tracks?.cols ?? trackSizes(style.gridTemplateColumns, cols);
  const rowSizes = tracks?.rows ?? trackSizes(style.gridTemplateRows, rows);
  if (!colSizes || !rowSizes) return null;
  const origin = host.getBoundingClientRect();
  const zoom = host.offsetWidth > 0 ? origin.width / host.offsetWidth : 1;
  const seen = (scroller ?? grid).getBoundingClientRect();
  // In a clipped matrix the grid is far off the screen once scrolled: place it from the scroll
  // position, which has no rounding (`gridInContent`).
  const at = scroller
    ? (() => {
        const inner = gridInContent(scroller, grid);
        return {
          left: (seen.left - origin.left) / zoom + scroller.clientLeft + inner.x - scroller.scrollLeft,
          top: (seen.top - origin.top) / zoom + scroller.clientTop + inner.y - scroller.scrollTop,
        };
      })()
    : { left: (grid.getBoundingClientRect().left - origin.left) / zoom, top: (grid.getBoundingClientRect().top - origin.top) / zoom };
  return {
    cols: colSizes,
    rows: rowSizes,
    colGap: parseFloat(style.columnGap) || 0,
    rowGap: parseFloat(style.rowGap) || 0,
    x: at.left,
    y: at.top,
    clip: {
      left: (seen.left - origin.left) / zoom,
      top: (seen.top - origin.top) / zoom,
      right: (origin.right - seen.right) / zoom,
      bottom: (origin.bottom - seen.bottom) / zoom,
    },
  };
}

function sameIndexLayout(a: IndexLayout | null, b: IndexLayout | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The matrix with its indices: the column indices in a row above it, the row indices in a
 * column on its left, outside the opening bracket, plain grey text. The row under the matrix is as
 * tall as the row of column indices, so the matrix stays centred on the line of its expression.
 */
function MatrixIndices({
  layout,
  rows,
  cols,
  origin,
  range,
  host,
  children,
}: {
  layout: IndexLayout | null;
  rows: number;
  cols: number;
  origin: number;
  range: MatrixWindow | null;
  host: React.RefObject<HTMLSpanElement | null>;
  children: ReactNode;
}) {
  const [rowStart, rowEnd] = range ? [range.rowStart, range.rowEnd] : [0, rows];
  const [colStart, colEnd] = range ? [range.colStart, range.colEnd] : [0, cols];
  const clip = layout?.clip;
  return (
    <span className="indexed-matrix">
      <span
        className="matrix-indices cols"
        style={clip ? { clipPath: `inset(0 ${clip.right}px 0 ${clip.left}px)` } : undefined}
      >
        <span className="index-sizer">0</span>
        {layout && (
          <span
            className="index-strip"
            style={{ left: `${layout.x}px`, gridTemplateColumns: trackTemplate(layout.cols), columnGap: `${layout.colGap}px` }}
          >
            {Array.from({ length: Math.max(0, colEnd - colStart) }, (_, k) => (
              <span key={colStart + k} style={{ gridColumn: colStart + k + 1 }}>
                {colStart + k + origin}
              </span>
            ))}
          </span>
        )}
      </span>
      <span
        className="matrix-indices rows"
        style={clip ? { clipPath: `inset(${clip.top}px 0 ${clip.bottom}px 0)` } : undefined}
      >
        <span className="index-sizer">{rows - 1 + origin}</span>
        {layout && (
          <span
            className="index-strip"
            style={{ top: `${layout.y}px`, gridTemplateRows: trackTemplate(layout.rows), rowGap: `${layout.rowGap}px` }}
          >
            {Array.from({ length: Math.max(0, rowEnd - rowStart) }, (_, k) => (
              <span key={rowStart + k} style={{ gridRow: rowStart + k + 1 }}>
                {rowStart + k + origin}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="indexed-body" ref={host}>
        {children}
      </span>
      <span className="matrix-indices under" aria-hidden="true">
        <span className="index-sizer">0</span>
      </span>
    </span>
  );
}

function MatrixBracket({ side }: { side: "left" | "right" }) {
  return <BracketSide side={side} />;
}

export function ValueView({ value, displayUnit, format, onTableResizeStart, active }: ValueProps): ReactNode {
  switch (value.type) {
    case "real":
    case "complex":
      return scalarView(value, SI, format);
    case "string":
      return <span className="str">{`“${value.value}”`}</span>;
    case "quantity": {
      const unit = resultUnit(value.dimension, displayUnit);
      return (
        <>
          {scalarView(value.magnitude, unit, format)}
          {unit.text && (
            <>
              <span className="juxt" />
              <UnitText text={unit.text} />
            </>
          )}
        </>
      );
    }
    case "matrix":
      return (
        <MatrixResult
          value={value}
          displayUnit={displayUnit}
          format={format}
          onTableResizeStart={onTableResizeStart}
          active={active}
        />
      );
    case "handle":
      return <span className="handle">{S.result.handle(value.julia_type, value.summary)}</span>;
    case "symbolic":
      return isNode(value.expr) ? (
        // Paths on the nodes let a press select a sub-expression to copy.
        <MathExpr expr={value.expr} path={[]} />
      ) : (
        <span className="up">{value.text}</span>
      );
  }
}
