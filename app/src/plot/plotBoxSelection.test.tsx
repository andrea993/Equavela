// Box selection of a plot.
// Root cause: the editing lines of the
// math editor (caret, underline) and its suggestion menu are absolutely positioned, and nothing in a plot
// slot was positioned, so they were drawn at the corner of the margin container, over the first limit box,
// whichever box was being edited. Every box must be an exact hit target that owns its own editing marks,
// and only one box may be active at a time. Runs on the mock backend.

import { existsSync, readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { HIT_TOLERANCE_PX, traceHitAt } from "./hitTest";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const plotEl = () => document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

async function insertPlot() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
  const plot = await waitFor(() => {
    expect(plotEl()).not.toBeNull();
    return plotEl() as HTMLElement;
  });
  await waitFor(() => expect(selectedTab()).toBe(S.ribbon.tabs.plot));
  // The math inside each placeholder is built asynchronously.
  await waitFor(() => expect(plot.querySelectorAll("[data-testid=inline-math]")).toHaveLength(6));
  return plot;
}

const slotNamed = (plot: HTMLElement, name: string) => within(plot).getByRole("group", { name });
const press = async (target: Element) => {
  await act(async () => {
    fireEvent.pointerDown(target, { button: 0, clientX: 5, clientY: 5 });
  });
};
/** The aria-labels of the slots whose math editor is active (the editing class and the keyboard focus). */
const editingSlots = (plot: HTMLElement) =>
  [...plot.querySelectorAll<HTMLElement>("[data-testid=plot-slot]")]
    .filter((slot) => slot.querySelector(".tx-inline.editing"))
    .map((slot) => slot.getAttribute("aria-label"));
const focusedSlot = () => document.activeElement?.closest("[data-testid=plot-slot]")?.getAttribute("aria-label") ?? null;
const key = async (target: Element, k: string) => {
  await act(async () => void fireEvent.keyDown(target, { key: k, code: k.length === 1 ? `Digit${k}` : k }));
};

const ALL = [S.plot.yMax, S.plot.yExpression, S.plot.yMin, S.plot.xMin, S.plot.xExpression, S.plot.xMax];

describe("every plot box is an exact hit target, active alone", () => {
  it("pressing each box focuses and edits that box and no other", async () => {
    const plot = await insertPlot();
    for (const name of ALL) {
      await press(slotNamed(plot, name));
      await waitFor(() => expect(editingSlots(plot)).toEqual([name]));
      expect(focusedSlot(), name).toBe(name);
    }
  });

  it("pressing the math inside a box also activates only that box", async () => {
    const plot = await insertPlot();
    for (const name of ALL) {
      const math = slotNamed(plot, name).querySelector<HTMLElement>("[data-testid=inline-math]")!;
      await press(math);
      // The math editor takes the keyboard on a real press; jsdom does not move the focus itself.
      await act(async () => math.focus());
      await waitFor(() => expect(editingSlots(plot)).toEqual([name]));
      expect(focusedSlot(), name).toBe(name);
    }
  });

  it("makes the plot the selection but selects no trace when a limit is pressed", async () => {
    const plot = await insertPlot();
    await press(slotNamed(plot, S.plot.yMin));
    expect(plot.getAttribute("data-selected-trace")).toBe("");
  });
});

describe(": editing a trace expression leaves the limits unselected", () => {
  it("keeps the focus, the editing lines and the editing state on the expression while typing", async () => {
    const plot = await insertPlot();
    const limits = [S.plot.yMax, S.plot.yMin, S.plot.xMin, S.plot.xMax];
    for (const expression of [S.plot.yExpression, S.plot.xExpression]) {
      const slot = slotNamed(plot, expression);
      await press(slot);
      const math = slot.querySelector<HTMLElement>("[data-testid=inline-math]")!;
      await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
      await key(math, "3");
      await key(math, "2");
      expect(focusedSlot()).toBe(expression);
      expect(editingSlots(plot)).toEqual([expression]);
      for (const limit of limits) {
        const box = slotNamed(plot, limit);
        expect(box.contains(document.activeElement), limit).toBe(false);
        expect(box.classList.contains("selected"), limit).toBe(false);
      }
      // The expression, once committed, is still the only thing the tab shows as selected.
      await act(async () => void fireEvent.keyDown(math, { key: "Escape", code: "Escape" }));
    }
  });

  it("does not move the focus to a limit when a trace is added with Shift+Enter or the tab", async () => {
    const plot = await insertPlot();
    await press(slotNamed(plot, S.plot.yExpression));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.addTrace }));
    await waitFor(() => expect(within(plot).getAllByRole("group", { name: S.plot.yExpression })).toHaveLength(2));
    for (const limit of [S.plot.yMax, S.plot.yMin, S.plot.xMin, S.plot.xMax]) {
      expect(slotNamed(plot, limit).contains(document.activeElement), limit).toBe(false);
      expect(slotNamed(plot, limit).querySelector(".tx-inline.editing"), limit).toBeNull();
    }
  });
});

describe("the trace hit test does not take presses meant for boxes", () => {
  it("keeps the boxes outside the element that listens for trace clicks", async () => {
    const plot = await insertPlot();
    const canvas = plot.querySelector<HTMLElement>(".plot-canvas")!;
    expect(canvas).not.toBeNull();
    for (const slot of plot.querySelectorAll("[data-testid=plot-slot]")) {
      expect(canvas.contains(slot), slot.getAttribute("aria-label") ?? "").toBe(false);
    }
  });

  it("finds no trace at a box position, only at a marker or line", () => {
    const host = document.createElementNS("http://www.w3.org/2000/svg", "g");
    host.innerHTML = '<g class="scatterlayer"><g class="trace"><g class="points"><path class="point"/></g></g></g>';
    const marker = host.querySelector(".point") as SVGGraphicsElement;
    marker.getBoundingClientRect = () => ({ left: 100, right: 110, top: 100, bottom: 110, width: 10, height: 10, x: 100, y: 100, toJSON: () => ({}) });
    expect(traceHitAt(host, 105, 105)).toEqual({ layer: "scatterlayer", index: 0 });
    expect(traceHitAt(host, 110 + HIT_TOLERANCE_PX, 105)).toEqual({ layer: "scatterlayer", index: 0 });
    // A box sits in the margin, further than the click tolerance from every drawn trace.
    expect(traceHitAt(host, 110 + HIT_TOLERANCE_PX + 1, 105)).toBeNull();
    expect(traceHitAt(host, 20, 300)).toBeNull();
    expect(traceHitAt(document.createElementNS("http://www.w3.org/2000/svg", "g"), 20, 300)).toBeNull();
  });
});

describe("box geometry (stylesheet contract; jsdom does not apply the stylesheet)", () => {
  const css = (() => {
    for (const candidate of ["src/styles/page.css", "app/src/styles/page.css"]) {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    }
    throw new Error("page.css not found: run the frontend tests from `app/`");
  })();
  const declarations = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))].map((match) => match[1]).join(";");
  };

  it("anchors the editing lines and the suggestion menu to the box, not to the margin container", () => {
    expect(declarations(".plot-slot .tx-inline")).toMatch(/position\s*:\s*relative/);
    // The containers are positioned too, which is exactly why the lines used to land on their corner.
    expect(declarations(".plot-slots")).toMatch(/position\s*:\s*absolute/);
  });

  it("draws every filled limit whole, over the plot, as soon as the plot is in edit mode", () => {
    expect(declarations(".plot-region.editing .plot-slots:has(.plot-slot.limit:not(.empty))")).toMatch(/overflow\s*:\s*visible/);
    expect(declarations(".plot-region.editing .plot-slots:has(.plot-slot.limit:not(.empty))")).toMatch(/z-index\s*:\s*4/);
    const limit = declarations(".plot-region.editing .plot-slots .plot-slot.limit:not(.empty)");
    expect(limit).toMatch(/max-width\s*:\s*none/);
    expect(limit).toMatch(/overflow\s*:\s*visible/);
    expect(limit).toMatch(/background\s*:\s*#fff/);
  });

  it("makes every box at least 24 px wide and 20 px high, filled by its math, so an empty box is a usable target", () => {
    const box = declarations(".plot-slot");
    expect(Number(/min-width\s*:\s*(\d+)px/.exec(box)?.[1])).toBeGreaterThanOrEqual(24);
    expect(Number(/min-width\s*:\s*(\d+)px/.exec(declarations(".plot-slots .plot-slot.limit"))?.[1])).toBeGreaterThanOrEqual(24);
    const inline = declarations(".plot-slot .tx-inline");
    expect(inline).toMatch(/display\s*:\s*block/);
    expect(Number(/min-height\s*:\s*(\d+)px/.exec(inline)?.[1])).toBeGreaterThanOrEqual(20);
  });
});
