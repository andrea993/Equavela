//  (GitHub ): a clipped classic matrix has bracket ends at its own ends, and at rest it
// keeps the part it was scrolled to, without scroll bars, with ellipses where elements continue.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { KernelValue } from "../equavelaApi";
import { BracketSide } from "../math/render";
import { DEFAULT_FORMAT } from "./format";
import { ValueView } from "./ResultView";

/** Rows of 20 px and columns of 60 px, the box 100 px high and 130 px wide, scrolled by `offset`. */
const offset = { top: 0, left: 0 };
const ROW = 20;
const COL = 60;
const saved = {
  rect: Element.prototype.getBoundingClientRect,
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const at = this.getAttribute("data-result-cell");
    if (!at) return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    const [r, c] = at.split(",").map(Number);
    return DOMRect.fromRect({ x: c * COL - offset.left, y: r * ROW - offset.top, width: COL, height: ROW });
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return this.classList.contains("result-matrix-scroll") ? 100 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return this.classList.contains("result-matrix-scroll") ? 130 : 0; } });
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = saved.rect;
  if (saved.height) Object.defineProperty(HTMLElement.prototype, "clientHeight", saved.height);
  if (saved.width) Object.defineProperty(HTMLElement.prototype, "clientWidth", saved.width);
  offset.top = 0;
  offset.left = 0;
});

const matrix = (rows: number, cols: number): KernelValue => ({
  type: "matrix",
  rows,
  cols,
  storage: { type: "inline", values: Array.from({ length: rows * cols }, (_, i) => ({ type: "real", value: i })) },
});

const classes = (container: HTMLElement, r: number, c: number) =>
  container.querySelector(`[data-result-cell="${r},${c}"]`)!.className;

it("draws a bracket's short rules at the very ends of the matrix", () => {
  const { container } = render(<svg><BracketSide side="left" /></svg>);
  const lines = [...container.querySelectorAll("line")];
  // The stem runs over the whole height; one short rule at the top edge, one at the bottom edge.
  expect(lines[0].getAttribute("y2")).toBe("100%");
  expect(Number(lines[1].getAttribute("y1"))).toBeCloseTo(0.7);
  expect(lines[2].closest("svg")!.getAttribute("y")).toBe("100%");
});

it("scrolls while active and shows ellipses at rest", () => {
  // A 20 x 1 vector is large (more than 12 rows): it is clipped in its box.
  const active = render(<ValueView value={matrix(20, 1)} format={DEFAULT_FORMAT} active />).container;
  expect(active.querySelector(".result-matrix-scroll")!.classList.contains("still")).toBe(false);
  expect(classes(active, 4, 0)).not.toContain("dots");
  cleanup();
  // At rest from the start: rows 0 to 4 fit; row 4 says the vector continues, the rest is not drawn.
  const rest = render(<ValueView value={matrix(20, 1)} format={DEFAULT_FORMAT} active={false} />).container;
  expect(rest.querySelector(".result-matrix-scroll")!.classList.contains("still")).toBe(true);
  expect(classes(rest, 0, 0)).not.toContain("dots");
  expect(classes(rest, 3, 0)).not.toContain("dots");
  expect(classes(rest, 4, 0)).toContain("dots-v");
  expect(classes(rest, 5, 0)).toContain("off");
  cleanup();
  // Scrolled to the middle (rows 6 to 9 wholly in the box, half of rows 5 and 10 cut): dots at
  // both ends, and the cut rows are not drawn.
  offset.top = 110;
  const middle = render(<ValueView value={matrix(20, 1)} format={DEFAULT_FORMAT} active={false} />).container;
  expect(classes(middle, 5, 0)).toContain("off");
  expect(classes(middle, 6, 0)).toContain("dots-v");
  expect(classes(middle, 7, 0)).not.toContain("dots");
  expect(classes(middle, 9, 0)).toContain("dots-v");
  expect(classes(middle, 10, 0)).toContain("off");
  cleanup();
  // At the end: the last row is a value, the first one shown is the ellipsis.
  offset.top = 300;
  const end = render(<ValueView value={matrix(20, 1)} format={DEFAULT_FORMAT} active={false} />).container;
  expect(classes(end, 15, 0)).toContain("dots-v");
  expect(classes(end, 19, 0)).not.toContain("dots");
});

it("marks columns with ⋯ and the corner where both continue with ⋱", () => {
  // 20 x 20: two columns fit in 130 px; rows 0 to 4 fit in 100 px.
  const { container } = render(<ValueView value={matrix(20, 20)} format={DEFAULT_FORMAT} active={false} />);
  expect(classes(container, 0, 1)).toContain("dots-h");
  expect(classes(container, 4, 0)).toContain("dots-v");
  expect(classes(container, 4, 1)).toContain("dots-d");
  expect(classes(container, 0, 2)).toContain("off");
});

it("draws only the window of a clipped matrix once its tracks are known, the tracks of the whole matrix kept", () => {
  // Layout stand-in: the full grid lays out 60 px columns and 20 px rows (jsdom has no grid layout).
  const real = window.getComputedStyle;
  window.getComputedStyle = ((element: Element) => {
    const style = real(element);
    if (!element.classList.contains("matrix-grid")) return style;
    // The columns the grid is laid out with (`repeat(n, auto)`), and as many rows as its cells fill.
    const cols = Number(/^repeat\((\d+), auto\)$/.exec((element as HTMLElement).style.gridTemplateColumns)?.[1] ?? 0);
    const rows = cols > 0 ? element.children.length / cols : 0;
    const fixed: Record<string, string> = {
      gridTemplateColumns: Array(cols).fill("60px").join(" "),
      gridTemplateRows: Array(rows).fill("20px").join(" "),
      columnGap: "12px",
      rowGap: "3px",
      font: "11pt MC Math",
    };
    return new Proxy(style, { get: (target, key) => (typeof key === "string" && key in fixed ? fixed[key] : Reflect.get(target, key)) });
  }) as typeof window.getComputedStyle;
  try {
    const value = matrix(100, 100);
    const { container } = render(<ValueView value={value} format={DEFAULT_FORMAT} active />);
    // The 130 x 100 px box shows columns 0 and 1 and rows 0 to 4; two more columns and three more rows are drawn.
    const drawn = container.querySelectorAll("[data-result-cell]");
    expect(drawn.length).toBe(4 * 8);
    expect(container.querySelector('[data-result-cell="0,0"]')).not.toBeNull();
    expect(container.querySelector('[data-result-cell="7,3"]')).not.toBeNull();
    expect(container.querySelector('[data-result-cell="50,50"]')).toBeNull();
    // The grid keeps the tracks of the whole matrix, and each cell its own place in it.
    const grid = container.querySelector<HTMLElement>(".matrix-grid")!;
    expect(grid.style.gridTemplateColumns).toBe("repeat(100, 60px)");
    expect(container.querySelector<HTMLElement>('[data-result-cell="7,3"]')!.style.gridRow).toBe("8");
    // Mounted again (a region scrolled back into view), the window is drawn at once from the kept tracks.
    cleanup();
    const again = render(<ValueView value={value} format={DEFAULT_FORMAT} active={false} />).container;
    expect(again.querySelectorAll("[data-result-cell]").length).toBe(4 * 8);
    // At rest the ellipses still mark the edges of the box.
    expect(classes(again, 4, 0)).toContain("dots-v");
    expect(classes(again, 0, 1)).toContain("dots-h");
  } finally {
    window.getComputedStyle = real;
  }
});

it("finds the tracks a span overlaps, with a margin", async () => {
  const { tracksIn } = await import("./ResultView");
  // Tracks of 60 with gaps of 12: 0–60, 72–132, 144–204, …
  expect(tracksIn([60, 60, 60, 60, 60], 12, 0, 130, 0)).toEqual([0, 2]);
  expect(tracksIn([60, 60, 60, 60, 60], 12, 140, 150, 1)).toEqual([1, 4]);
  expect(tracksIn([60, 60, 60], 12, 0, 1000, 2)).toEqual([0, 3]);
});
