// GitHub: a plot also moves by dragging the area of the region
// around its plot area — the margins where the tick labels sit and the space around the expression
// slots — while a press inside the plot area (trace selection, drag-to-zoom, pan) and a press on a
// placeholder keep their meaning. The outer area is invisible chrome: the page and the PDF draw the
// same plot. Runs on the mock backend; Plotly is mocked as in the other plot tests.

import { existsSync, readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ptToPx } from "../layout/geometry";
import { WORKSHEET_LINE_PT } from "../layout/lines";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { MARGIN, NO_RIGHT_AXIS_MARGIN } from "./adapter";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

/** `page.css` without comments: jsdom does not apply it, so the stylesheet contracts read it. */
const css = (() => {
  for (const candidate of ["src/styles/page.css", "app/src/styles/page.css"]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  throw new Error("page.css not found: run the frontend tests from `app/`");
})();

/** The declarations of every rule that names `selector`, joined. */
const declarations = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]).join(";");
};

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const plotEl = () => document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;
const undo = () => screen.getByRole("button", { name: S.quickAccess.undo });

/** Inserts a plot on the demo worksheet and returns what the tests press and check. */
async function openPlot() {
  const backend = createMockBackend({ fast: true });
  const move = vi.spyOn(backend, "moveRegions");
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
  const plot = await waitFor(() => {
    expect(plotEl()).not.toBeNull();
    return plotEl() as HTMLElement;
  });
  const regionEl = plot.closest<HTMLElement>("[data-region-id]")!;
  // The math inside each placeholder is built asynchronously.
  await waitFor(() => expect(plot.querySelectorAll("[data-testid=inline-math]")).toHaveLength(6));
  return { move, plot, regionEl };
}

/** The four strips of the outer move area, by the margin of the plot they cover. */
function strips(plot: HTMLElement) {
  const all = [...plot.querySelectorAll<HTMLElement>('[data-testid="plot-move-area"] i')];
  const named = (name: string) => all.find((strip) => strip.classList.contains(name))!;
  return { all, top: named("top"), bottom: named("bottom"), left: named("left"), right: named("right") };
}

/** A press, a drag and a release on `handle`, then a turn of the event loop for a queued move edit. */
async function drag(handle: Element, dx: number, dy: number) {
  await act(async () => {
    fireEvent.pointerDown(handle, { button: 0, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: 200 + dx, clientY: 200 + dy, buttons: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 200 + dx, clientY: 200 + dy });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** A press and a release in the same place: a click, which never drags. */
const click = (handle: Element) => drag(handle, 0, 0);

/** Clicking the empty page, as a user clicks outside the plot. */
async function clickOutside() {
  await act(async () => {
    fireEvent.pointerDown(document.querySelector(".page")!, { button: 0, clientX: 600, clientY: 1100 });
    fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 1100 });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("the outer area that moves a plot", () => {
  it("covers the region box up to the plot area, and is invisible chrome", async () => {
    const { plot } = await openPlot();
    const { all, top, bottom, left, right } = strips(plot);
    expect(all).toHaveLength(4);
    // The strips stop where the plot area starts: the margins the drawing library keeps for the axis
    // labels and titles (adapter.ts MARGIN), so a press on the data is never a move.
    expect(top.style.height).toBe(`${MARGIN.t}px`);
    expect(bottom.style.height).toBe(`${MARGIN.b}px`);
    expect(left.style.width).toBe(`${MARGIN.l}px`);
    expect(right.style.width).toBe(`${NO_RIGHT_AXIS_MARGIN}px`);
    // It is a hit target only: no control, no tab stop, nothing drawn, nothing printed.
    const area = plot.querySelector<HTMLElement>('[data-testid="plot-move-area"]')!;
    expect(area.getAttribute("aria-hidden")).toBe("true");
    expect(area.classList.contains("no-print")).toBe(true);
    expect(area.querySelectorAll("button, input, select, textarea, [tabindex]")).toHaveLength(0);
  });

  it("moves the plot by dragging that area, on the 3 pt grid and as one undo step", async () => {
    const { move, plot, regionEl } = await openPlot();
    const before = { left: regionEl.style.left, top: regionEl.style.top };
    expect(move).not.toHaveBeenCalled();
    // 13 px are 9.75 pt, which snaps to the 3 pt grid: the plot moves 9 pt, 12 px.
    await drag(strips(plot).bottom, 13, 0);
    await waitFor(() => expect(regionEl.style.left).not.toBe(before.left));
    expect(parseFloat(regionEl.style.left) - parseFloat(before.left)).toBeCloseTo(ptToPx(9), 6);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move.mock.calls[0][1].map((item) => item.region_id)).toEqual([regionEl.dataset.regionId]);
    expect(move.mock.calls[0][1][0].x % 3).toBe(0);
    expect(undo().getAttribute("title")).toContain("Move region");
    // One drag is one undo step, and it puts the plot back where it was.
    fireEvent.click(undo());
    await waitFor(() => expect(regionEl.style.left).toBe(before.left));
    expect(regionEl.style.top).toBe(before.top);
  });

  it("moves a plot that is not selected yet with one press-and-drag", async () => {
    const { move, plot, regionEl } = await openPlot();
    await clickOutside();
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(false));
    // Without a selection there is no move border: the outer area is the only handle.
    expect(regionEl.querySelector("[data-testid=region-drag-border]")).toBeNull();
    const before = regionEl.style.top;
    // The plot was inserted on the crosshair, one worksheet line below the lowest region of page 1
    // (its top at 756 pt), so a drag of one worksheet line (15 pt = 20 px) takes it to 771 pt, past
    // the bottom margin of 769.89 pt.
    await drag(strips(plot).left, 0, ptToPx(WORKSHEET_LINE_PT));
    await waitFor(() => expect(regionEl.style.top).not.toBe(before));
    expect(move).toHaveBeenCalledTimes(1);
    // The plot sits at the bottom of page 1, so the drop rule of every region applies: it continues
    // on the next page.
    expect(move.mock.calls[0][1][0].page).toBe(2);
    // The press also makes the plot the selection, so the border and the Plot tab come up with it.
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(true));
    expect(selectedTab()).toBe(S.ribbon.tabs.plot);
  });

  it("selects the plot on a click in that area, without moving it", async () => {
    const { move, plot, regionEl } = await openPlot();
    await clickOutside();
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(false));
    const before = { left: regionEl.style.left, top: regionEl.style.top };
    await click(strips(plot).right);
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(true));
    expect(selectedTab()).toBe(S.ribbon.tabs.plot);
    expect(regionEl.querySelector("[data-testid=region-drag-border]")).not.toBeNull();
    expect({ left: regionEl.style.left, top: regionEl.style.top }).toEqual(before);
    expect(move).not.toHaveBeenCalled();
  });

  it("never moves the plot from a drag inside the plot area", async () => {
    const { move, plot, regionEl } = await openPlot();
    const before = { left: regionEl.style.left, top: regionEl.style.top };
    // The plot area belongs to the plot: a drag there is a drag-to-zoom or a pan.
    await drag(within(plot).getByTestId("plot-canvas"), 40, 12);
    expect(move).not.toHaveBeenCalled();
    expect({ left: regionEl.style.left, top: regionEl.style.top }).toEqual(before);
  });

  it("never moves the plot from a press on an expression slot or a limit placeholder", async () => {
    const { move, plot, regionEl } = await openPlot();
    const before = { left: regionEl.style.left, top: regionEl.style.top };
    for (const name of [S.plot.yExpression, S.plot.yMax, S.plot.xExpression, S.plot.xMin]) {
      await drag(within(plot).getByRole("group", { name }), 40, 12);
      expect(move, name).not.toHaveBeenCalled();
      expect({ left: regionEl.style.left, top: regionEl.style.top }, name).toEqual(before);
    }
    // The presses edited the placeholders instead, so the plot is still the selection.
    expect(regionEl.classList.contains("selected")).toBe(true);
  });
});

describe("the move cursor and the passes of the outer area (stylesheet contract; jsdom does not apply the stylesheet)", () => {
  it("shows the move cursor over the outer area and the plot's own cursors inside the plot", () => {
    expect(declarations(".plot-move-area i")).toMatch(/cursor\s*:\s*move/);
    expect(declarations(".region.selected .plot-region")).toMatch(/cursor\s*:\s*default/);
    expect(declarations(".plot-region .plot-slot")).toMatch(/cursor\s*:\s*text/);
  });

  it("lets a press in the space around the placeholders reach the outer area, not a margin container", () => {
    // The margin containers are as wide as their whole margin: a press between two placeholders must
    // not be swallowed by the container, so only the boxes themselves take the pointer.
    expect(declarations(".plot-slots")).toMatch(/pointer-events\s*:\s*none/);
    expect(declarations(".plot-slot")).toMatch(/pointer-events\s*:\s*auto/);
  });
});

describe("the cursor-coordinate overlay", () => {
  it("passes pointer gestures through and is omitted from print", () => {
    expect(declarations(".plot-coordinate-readout")).toMatch(/pointer-events\s*:\s*none/);
    expect(css).toMatch(/\.chrome,\s*\.no-print\s*\{\s*display:\s*none\s*!important/s);
  });
});

describe("a plot draws no frame around its region", () => {
  it("draws no border on the plot region: the axes, grid and zero lines are its only lines", () => {
    expect(declarations(".plot-region")).toMatch(/border\s*:\s*0/);
  });
});
