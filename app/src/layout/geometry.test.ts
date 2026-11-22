import { describe, expect, it } from "vitest";
import type { PageSetup } from "../equavelaApi";
import {
  fitResultBox,
  lastPageReached,
  ceilSize,
  clampZoom,
  crossesPageBreak,
  currentPage,
  fitWidthZoom,
  freeSpot,
  reflow,
  measuredPt,
  PAGE_GAP_PX,
  pageCount,
  pageToSheet,
  placeRegion,
  printableArea,
  ptToPx,
  pxToPt,
  sheetLayout,
  sheetLeft,
  sheetToPage,
  sheetToDraftPage,
  snapToGrid,
  stepZoom,
} from "./geometry";

const a4: PageSetup = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
};

describe("units", () => {
  it("converts between points and CSS pixels (96 dpi)", () => {
    expect(ptToPx(72)).toBe(96);
    expect(pxToPt(96)).toBe(72);
    expect(pxToPt(ptToPx(123.45))).toBeCloseTo(123.45, 10);
    expect(ptToPx(3)).toBe(4);
  });

  it("snaps to the 3 pt grid", () => {
    expect(snapToGrid(0)).toBe(0);
    expect(snapToGrid(1.4)).toBe(0);
    expect(snapToGrid(1.6)).toBe(3);
    expect(snapToGrid(54)).toBe(54);
    expect(snapToGrid(-1.4)).toBe(0);
    expect(Object.is(snapToGrid(-0.2), 0)).toBe(true);
    expect(snapToGrid(100)).toBe(99);
  });

  it("rounds sizes up to multiples of 0.75 pt", () => {
    expect(ceilSize(0)).toBe(0);
    expect(ceilSize(0.75)).toBe(0.75);
    expect(ceilSize(0.76)).toBe(1.5);
    expect(ceilSize(10)).toBe(10.5);
  });

  it("measures layout pixels independently of the zoom (R9)", () => {
    // 100 layout px are 75 pt at any zoom: the caller passes layout px, or client px with zoom.
    expect(measuredPt(100)).toBe(75);
    expect(measuredPt(200, 2)).toBe(75);
    expect(measuredPt(50, 0.5)).toBe(75);
  });
});

describe("sheet layout", () => {
  it("maps draft points past the paper edge and exactly on a page boundary", () => {
    const layout = sheetLayout(a4, 2, true);
    expect(sheetToDraftPage(layout, 1200, layout.pages[0].height)).toEqual({ page: 2, x: 900, y: 0 });
    expect(sheetToDraftPage(layout, 1200, layout.pages[0].height * 3)).toEqual({ page: 4, x: 900, y: 0 });
  });
  it("stacks pages with a gap in the page view and without one in the draft view", () => {
    const layout = sheetLayout(a4, 3);
    const height = Math.round(ptToPx(a4.height));
    expect(layout.pages.map((p) => p.top)).toEqual([
      0,
      height + PAGE_GAP_PX,
      2 * (height + PAGE_GAP_PX),
    ]);
    expect(layout.height).toBe(3 * height + 2 * PAGE_GAP_PX);
    const draft = sheetLayout(a4, 2, true);
    expect(draft.pages[1].top).toBe(height);
    expect(draft.height).toBe(2 * height);
  });

  it("counts pages from the regions", () => {
    expect(pageCount([])).toBe(1);
    expect(pageCount([{ page: 1 }, { page: 3 }])).toBe(3);
    expect(pageCount([{ page: 1 }], 2)).toBe(2);
  });

  it("places a page point in the sheet and back", () => {
    const layout = sheetLayout(a4, 2);
    const p = pageToSheet(layout, 2, 54, 72);
    expect(p.x).toBe(72);
    expect(p.y).toBe(layout.pages[1].top + 96);
    const back = sheetToPage(layout, p.x, p.y);
    expect(back.page).toBe(2);
    expect(back.x).toBeCloseTo(54, 9);
    expect(back.y).toBeCloseTo(72, 9);
  });

  it("assigns a point in the gap to the nearer page", () => {
    const layout = sheetLayout(a4, 2);
    const first = layout.pages[0];
    expect(sheetToPage(layout, 10, first.top + first.height + 3).page).toBe(1);
    expect(sheetToPage(layout, 10, layout.pages[1].top - 3).page).toBe(2);
    expect(sheetToPage(layout, 10, -50).page).toBe(1);
    expect(sheetToPage(layout, 10, 1e6).page).toBe(2);
  });

  it("snaps the rendered origin to the grid", () => {
    const layout = sheetLayout(a4, 1);
    const p = pageToSheet(layout, 1, 55.4, 73.9);
    expect(p.x).toBe(ptToPx(54));
    expect(p.y).toBe(ptToPx(75));
  });
});

describe("page breaks", () => {
  it("knows the printable area", () => {
    const area = printableArea(a4);
    expect(area.left).toBe(54);
    expect(area.bottom).toBeCloseTo(841.89 - 72, 9);
    expect(area.height).toBeCloseTo(841.89 - 144, 9);
  });

  it("flags a region that reaches below the bottom margin", () => {
    expect(crossesPageBreak(a4, 700, 60)).toBe(false);
    expect(crossesPageBreak(a4, 700, 80)).toBe(true);
  });

  it("keeps a region that fits where it is dropped (snapped)", () => {
    expect(placeRegion(a4, 1, 100.4, 200.2, { w: 50, h: 20 })).toEqual({
      page: 1,
      x: 99,
      y: 201,
    });
  });

  it("pushes a region that would straddle the break to the top of the next page", () => {
    const placed = placeRegion(a4, 1, 100, 760, { w: 50, h: 30 });
    expect(placed).toEqual({ page: 2, x: 99, y: 72 });
  });

  it("does not push a region that ends exactly at the bottom margin", () => {
    const bottom = printableArea(a4).bottom;
    const y = snapToGrid(bottom - 30 - 3);
    expect(placeRegion(a4, 1, 100, y, { w: 50, h: bottom - y }).page).toBe(1);
  });

  it("clamps the origin into the printable area", () => {
    expect(placeRegion(a4, 1, -20, -20, { w: 50, h: 20 })).toEqual({
      page: 1,
      x: 54,
      y: 72,
    });
    const right = placeRegion(a4, 1, 590, 100, { w: 100, h: 20 });
    expect(right.x + 100).toBeLessThanOrEqual(printableArea(a4).right);
    expect(right.x % 3).toBe(0);
  });

  it("leaves a region taller than the page where it is", () => {
    const placed = placeRegion(a4, 1, 60, 300, { w: 50, h: 900 });
    expect(placed.page).toBe(1);
    expect(placed.y).toBe(300);
  });

  it("never returns a page below 1", () => {
    expect(placeRegion(a4, 0, 60, 100, { w: 10, h: 10 }).page).toBe(1);
  });
});

describe("zoom", () => {
  it("clamps and steps through presets", () => {
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(stepZoom(1.1, 1)).toBe(1.25);
  });

  it("fits the width and centres the sheet on an integer pixel", () => {
    expect(fitWidthZoom(1000, 794)).toBe(1.2);
    expect(sheetLeft(1001, 794, 1)).toBe(103);
    expect(Number.isInteger(sheetLeft(1000, 793, 1.1))).toBe(true);
    expect(sheetLeft(100, 794, 1)).toBe(24);
  });
});

describe("page indicator", () => {
  it("follows the middle of the viewport", () => {
    const layout = sheetLayout(a4, 3);
    const page = layout.pages[0].height;
    expect(currentPage(layout, 1, 0, 600)).toBe(1);
    expect(currentPage(layout, 1, page, 600)).toBe(2);
    expect(currentPage(layout, 1, 1e6, 600)).toBe(3);
    // Zoomed out, half the scroll offset reaches the same page.
    expect(currentPage(layout, 0.5, page / 2, 600)).toBe(2);
    expect(currentPage(layout, 0.5, 0, 600)).toBe(1);
  });
});

describe("reflow", () => {
  const setup = { size: "A4", width: 595, height: 842, margins: { top: 72, right: 72, bottom: 72, left: 72 } } as never;
  const item = (id: string, y: number, h: number, extra: Partial<{ page: number; x: number; w: number }> = {}) => ({
    id,
    page: 1,
    x: 72,
    y,
    w: 200,
    h,
    ...extra,
  });

  it("draws a rising result above the stored y, within the top margin and below the region above", () => {
    const rising = (id: string, y: number, h: number, rise: number) => ({ ...item(id, y, h), rise });
    // Free space above: the box starts `rise` above the stored y, which stays the expression's top.
    expect(reflow(setup, [rising("a", 150, 60, 24)]).get("a")).toEqual({ page: 1, y: 126, pushed: false });
    // Never above the top margin.
    expect(reflow(setup, [rising("a", 84, 60, 24)]).get("a")).toEqual({ page: 1, y: 72, pushed: false });
    // A region above stops it: the box is pushed below that region, the expression with it.
    expect(reflow(setup, [item("a", 72, 60), rising("b", 141, 60, 24)]).get("b")).toEqual({ page: 1, y: 132, pushed: true });
  });

  it("leaves regions that do not collide where they are", () => {
    const flow = reflow(setup, [item("a", 72, 30), item("b", 120, 30)]);
    expect(flow.get("b")).toEqual({ page: 1, y: 120, pushed: false });
  });

  it("pushes a collided region below the growing one, then lets it return when it shrinks", () => {
    const grown = reflow(setup, [item("a", 72, 60), item("b", 100, 30)]);
    expect(grown.get("b")).toEqual({ page: 1, y: 132, pushed: true });
    const shrunk = reflow(setup, [item("a", 72, 20), item("b", 100, 30)]);
    expect(shrunk.get("b")?.pushed).toBe(false);
  });

  it("pushes in a chain and ignores regions beside it", () => {
    const flow = reflow(setup, [
      item("a", 72, 60),
      item("b", 100, 30),
      item("c", 130, 30),
      item("side", 106, 30, { x: 400, w: 50 }),
    ]);
    expect(flow.get("b")?.y).toBe(132);
    expect(flow.get("c")?.y).toBe(162);
    expect(flow.get("side")?.pushed).toBe(false);
  });

  it("pushes a row of regions stored on one line as one, so their lines stay aligned", () => {
    // `b` meets `a` above it; `side`, on the same line beside it, comes down with it.
    const flow = reflow(setup, [item("a", 72, 60), item("b", 100, 30), item("side", 100, 30, { x: 400, w: 50 })]);
    expect(flow.get("b")?.y).toBe(132);
    expect(flow.get("side")).toEqual({ page: 1, y: 132, pushed: true });
    // With content rising over their line, the lines (box top + rise) stay level.
    const rising = reflow(setup, [item("a", 72, 60), { ...item("b", 150, 40), rise: 24 }, item("side", 150, 30, { x: 400, w: 50 })]);
    const b = rising.get("b")!;
    const side = rising.get("side")!;
    expect(b.y + 24).toBe(side.y);
    expect(b.y).toBe(132);
  });

  it("moves an overlapped duplicate below, keeping the page break rule", () => {
    const flow = reflow(setup, [item("a", 700, 40), item("b", 700, 40)]);
    expect(flow.get("b")).toEqual({ page: 2, y: 72, pushed: true });
    const same = reflow(setup, [item("a", 100, 40), item("b", 100, 40)]);
    expect(same.get("b")?.y).toBe(141);
  });

  it("finds a free spot below the regions under the paste point", () => {
    const rects = [{ page: 1, x: 72, y: 72, w: 200, h: 60 }];
    expect(freeSpot(setup, rects, 1, 100, 90)).toEqual({ page: 1, x: 99, y: 132 });
    expect(freeSpot(setup, rects, 1, 300, 90)).toEqual({ page: 1, x: 300, y: 90 });
  });
});

describe("lastPageReached", () => {
  const setup = {
    size: "A4",
    width: 595.28,
    height: 841.89,
    margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
    footer: { left: "", center: "", right: "" },
  };
  it("is the page itself for a region that ends on it, also inside the bottom margin", () => {
    expect(lastPageReached(setup, 1, 474, 220)).toBe(1);
    expect(lastPageReached(setup, 2, 780, 60)).toBe(2);
  });
  it("counts the pages a region continues onto", () => {
    expect(lastPageReached(setup, 1, 800, 100)).toBe(2);
    expect(lastPageReached(setup, 1, 800, 900)).toBe(3);
    expect(lastPageReached(setup, 3, 0, 2000)).toBe(5);
  });
});

describe("result box fit", () => {
  const bar = 9;
  it("a tall vector grows no wider than its column and the vertical scroll bar", () => {
    const content = { w: 60, h: 900, vbar: bar, hbar: bar };
    expect(fitResultBox({ w: 300, h: 240 }, content)).toEqual({ w: 69, h: 240 });
    // Tall enough to show every row: no scroll bar, the box stops at the content.
    expect(fitResultBox({ w: 300, h: 1200 }, content)).toEqual({ w: 60, h: 900 });
  });
  it("a wide row vector grows no taller than its row and the horizontal scroll bar", () => {
    const content = { w: 900, h: 30, vbar: bar, hbar: bar };
    expect(fitResultBox({ w: 300, h: 240 }, content)).toEqual({ w: 300, h: 39 });
  });
  it("a box smaller than its content keeps its size", () => {
    expect(fitResultBox({ w: 300, h: 200 }, { w: 900, h: 900, vbar: bar, hbar: bar })).toEqual({ w: 300, h: 200 });
  });
});
