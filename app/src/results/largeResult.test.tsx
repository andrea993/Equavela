// A large matrix result: the window form, the blocks, and a table that
// draws only the part in view and reads the blocks it needs as it scrolls.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelValue } from "../equavelaApi";
import { DEFAULT_FORMAT } from "./format";
import { blockOf, displayForm, elementOf, type Matrix } from "./largeResult";
import { ResultBlockContext, ValueView } from "./ResultView";
import { selectedValue } from "./resultSelection";

afterEach(cleanup);

/** A matrix whose element (r, c) is 1000 r + c, column-major. */
function numbered(rows: number, cols: number): Matrix {
  const values: KernelValue[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) values.push({ type: "real", value: 1000 * r + c });
  return { type: "matrix", rows, cols, storage: { type: "inline", values } };
}

const number = (value: KernelValue | undefined) => (value?.type === "real" ? value.value : null);

describe("the window form", () => {
  it("sends the first 100 x 50 block of a matrix of more than 10 000 elements", () => {
    const sent = displayForm(numbered(300, 80)) as Matrix;
    expect([sent.rows, sent.cols]).toEqual([300, 80]);
    expect(sent.storage).toMatchObject({ type: "window", row: 0, col: 0, rows: 100, cols: 50 });
    expect(sent.storage.values).toHaveLength(5000);
    expect(number(elementOf(sent, 7, 3))).toBe(7003);
    expect(elementOf(sent, 150, 3)).toBeUndefined();
    // At the limit the matrix stays whole.
    expect(displayForm(numbered(100, 100)).type === "matrix" && (displayForm(numbered(100, 100)) as Matrix).storage.type).toBe("inline");
  });

  it("slices a block column-major and clips it to the matrix", () => {
    expect(blockOf(numbered(5, 4), 3, 2, 10, 10)!.map(number)).toEqual([3002, 4002, 3003, 4003]);
  });

  it("copies nothing it does not hold", () => {
    const sent = displayForm(numbered(300, 80));
    expect(selectedValue(sent, { regionId: "m", kind: "matrix", matrix: [] })).toBeNull();
    expect(selectedValue(sent, { regionId: "m", kind: "cells", matrix: [], r1: 0, c1: 0, r2: 1, c2: 0 })).not.toBeNull();
    expect(selectedValue(sent, { regionId: "m", kind: "cells", matrix: [], r1: 99, c1: 0, r2: 100, c2: 0 })).toBeNull();
  });
});

/** Lays a classic matrix grid out with 60 px columns and 20 px rows (jsdom has no grid layout). */
function withGridLayout<T>(run: () => Promise<T>): Promise<T> {
  const real = window.getComputedStyle;
  window.getComputedStyle = ((element: Element) => {
    const style = real(element);
    if (!element.classList.contains("matrix-grid")) return style;
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
  return run().finally(() => {
    window.getComputedStyle = real;
  });
}

describe("a large result drawn as a classic matrix", () => {
  it("lays out the first block only, then draws the part in view and reads blocks as it scrolls", () =>
    withGridLayout(async () => {
      const whole = numbered(1000, 200);
      const read = vi.fn(async (row: number, col: number, rows: number, cols: number) => blockOf(whole, row, col, rows, cols)!);
      const { container } = render(
        <ResultBlockContext.Provider value={read}>
          <ValueView value={displayForm(whole)} format={DEFAULT_FORMAT} />
        </ResultBlockContext.Provider>,
      );
      // A classic matrix in its box, never a table; the whole size is announced.
      expect(container.querySelector(".result-table")).toBeNull();
      const box = container.querySelector<HTMLElement>(".result-matrix-scroll")!;
      expect(box.querySelector(".result-matrix")?.getAttribute("data-rows")).toBe("1000");
      // Every row and column takes the size of the first block's.
      const grid = box.querySelector<HTMLElement>(".matrix-grid")!;
      expect(grid.style.gridTemplateColumns).toBe("repeat(200, 60px)");
      expect(grid.style.gridTemplateRows).toBe("repeat(1000, 20px)");
      expect(container.querySelectorAll("[data-result-cell]").length).toBeLessThan(200);
      // The first block came with the value: nothing is read for the top-left corner.
      expect(read).not.toHaveBeenCalled();
      expect(container.querySelector('[data-result-cell="0,5"]')?.textContent).toBe("5");
      // Scrolled to row 500: the block of rows 500 to 599 is read and drawn.
      Object.defineProperty(box, "scrollTop", { configurable: true, value: 500 * 23 });
      await act(async () => {
        fireEvent.scroll(box);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });
      await waitFor(() => expect(container.querySelector('[data-result-cell="505,3"]')?.textContent).toBe("5.05·105"));
      expect(read).toHaveBeenCalledWith(500, 0, 100, 50);
      expect(container.querySelectorAll("[data-result-cell]").length).toBeLessThan(200);
    }));
});
