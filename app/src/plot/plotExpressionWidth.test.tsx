//  (GitHub ): a y expression is measured as it is typeset and the plot area shifts
// right by the width it needs, so a long expression such as `T_cell(X_sim1[0, k], X_sim1[1, k])` is
// fully readable on the page. The margins still come from the stored specification and the bundled
// fonts only — never from an edit in progress — and the screen and the print view use the same ones.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toEditing, type Node } from "../editor/tree";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { BASE_MARGIN, MARGIN, Y2_COLUMN, Y_COLUMN } from "./adapter";
import { makeTrace, type PlotFrame } from "./frame";
import { PlotContext, type PlotEnv } from "./PlotContext";
import { PlotView } from "./PlotView";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn() } }));
import plotly from "./plotlyBundle";

const drawn = vi.mocked(plotly.react);

const axis = (fields: Partial<PlotAxis> = {}): PlotAxis => ({
  scale: "linear",
  unit: null,
  min: null,
  max: null,
  show_grid: true,
  title: "",
  ...fields,
});

const spec = (fields: Partial<PlotSpec> = {}): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [480, 220],
  axes: { x: axis(), y: axis() },
  traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line", show_in_legend: true }],
  ...fields,
});

const frame: PlotFrame = {
  region_id: "p",
  state: "ready",
  error: null,
  implicit_x: false,
  limits: [],
  limit_errors: [],
  units: [],
  unit_errors: [],
  traces: [makeTrace("trace-1", [0, 1], [0, 1])],
};

/** A single name: the parser's tree for the expression, drawn as its text (what `toTree` gives). */
const name = (text: string): Node => ({
  type: "ExprRegion",
  expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } },
});

function env(): PlotEnv {
  return {
    revision: 0,
    load: async () => frame,
    save: () => undefined,
    toTree: async (text) => toEditing(name(text)),
    toText: async () => "",
    selectedTrace: () => null,
    view: () => undefined,
    selectTrace: () => undefined,
    selectRegion: () => undefined,
  };
}

/** The measured width of a text: the test's stand-in for the webview's layout, 8 px per character. */
const widthOf = (text: string) => text.length * 8 + 1;

function renderPlot(plot: PlotSpec) {
  return render(
    <PlotContext.Provider value={env()}>
      <PlotView
        region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot }}
        size={null}
        selected={false}
      />
    </PlotContext.Provider>,
  );
}

/** jsdom lays nothing out: give the measuring mirror its width from the text it holds. */
function measureLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      const element = this as HTMLElement;
      // The mirror's items, and the typeset expression of a placeholder being edited.
      const edited = element.parentElement?.matches('[data-testid="inline-math"].editing') ?? false;
      if (!element.classList?.contains("plot-measure-item") && !edited) return 0;
      return widthOf(element.textContent ?? "") - 1;
    },
  });
}

let original: PropertyDescriptor | undefined;
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  measureLayout();
});
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetWidth", original);
  cleanup();
  drawn.mockClear();
});

const plotOf = (container: HTMLElement) => container.querySelector<HTMLElement>(".plot-region")!;
const lastMargin = () =>
  (drawn.mock.calls.at(-1)?.[2] as { margin: { l: number; r: number; t: number; b: number } }).margin;

describe("a long y expression shifts the plot area right", () => {
  it("grows the left column to the measured expression and keeps the tick-label gap", async () => {
    const expression = "T_cell(X_sim1[0, k], X_sim1[1, k])";
    const plot = spec({ traces: [{ id: "trace-1", x: "t_sim[k]", y: expression, presentation: "line" }] });
    const { container } = renderPlot(plot);
    const plotEl = plotOf(container);
    const column = plotEl.querySelector<HTMLElement>(".plot-slots.y")!;
    // Until the stored expressions have been measured the plot does not draw with a guessed margin.
    expect(column.style.width).toBe(`${Y_COLUMN.width}px`);
    await waitFor(() => expect(lastMargin().l).toBeGreaterThan(MARGIN.l));
    const measured = widthOf(expression);
    // The column is the measured expression, and the plot area starts after it and its tick labels.
    expect(column.style.width).toBe(`${measured}px`);
    expect(column.style.left).toBe(`${Y_COLUMN.left}px`);
    expect(lastMargin().l).toBe(Y_COLUMN.left + measured + Y_COLUMN.gap);
    // The area that moves the plot follows the new margin.
    const left = plotEl.querySelector<HTMLElement>('[data-testid="plot-move-area"] i.left')!;
    expect(left.style.width).toBe(`${lastMargin().l}px`);
  });

  it("keeps the base margins for an expression that fits the base column", async () => {
    const { container } = renderPlot(spec());
    await waitFor(() => expect(lastMargin()).toEqual(BASE_MARGIN));
    expect(container.querySelector<HTMLElement>(".plot-slots.y")!.style.width).toBe(`${Y_COLUMN.width}px`);
  });

  it("measures the placeholders of one plot independently, one text once", async () => {
    const long = "X_sim1[0, k] + X_sim1[1, k] + X_sim1[2, k]";
    const plot = spec({
      traces: [
        { id: "trace-1", x: "x", y: long, presentation: "line" },
        { id: "trace-2", x: "x", y: long, presentation: "line" },
      ],
    });
    const { container } = renderPlot(plot);
    await waitFor(() => expect(lastMargin().l).toBeGreaterThan(MARGIN.l));
    // The mirror typesets the shared text once, not once per trace.
    expect(container.querySelectorAll(".plot-measure-item")).toHaveLength(1);
  });
});

describe("the column follows a y expression while it is edited", () => {
  it("grows the left column with every key and keeps the stored width after the edit is abandoned", async () => {
    const { container } = renderPlot(spec());
    const plotEl = plotOf(container);
    const column = plotEl.querySelector<HTMLElement>(".plot-slots.y")!;
    await waitFor(() => expect(lastMargin()).toEqual(BASE_MARGIN));
    const math = plotEl.querySelector<HTMLElement>('.plot-slots.y .expressions [data-testid="inline-math"]')!;
    act(() => {
      math.focus();
    });
    await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
    const typed = "_long_trace_name";
    for (const ch of typed) {
      act(() => {
        math.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      });
    }
    // The edited text is wider than the base column: the column and the plot area follow it.
    const wanted = widthOf(math.firstElementChild!.textContent ?? "");
    expect(wanted).toBeGreaterThan(Y_COLUMN.width);
    await waitFor(() => expect(column.style.width).toBe(`${wanted}px`));
    expect(lastMargin().l).toBe(Y_COLUMN.left + wanted + Y_COLUMN.gap);
    // The slot being edited is drawn over the plot, never clipped.
    expect(math.closest(".plot-slot")!.classList.contains("editing")).toBe(true);
    // Leaving without a committed change (toText gives "" here) returns to the stored width.
    act(() => {
      math.blur();
    });
    await waitFor(() => expect(column.style.width).toBe(`${Y_COLUMN.width}px`));
  });
});

describe("a wide right y limit shifts the plot area left", () => {
  it("grows the right margin to the measured right limit", async () => {
    const limit = "p_discharge_upper_limit";
    const plot = spec({
      axes: { x: axis(), y: axis(), y2: axis({ max: limit }) },
      traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line", y_axis: "right" }],
    });
    const { container } = renderPlot(plot);
    await waitFor(() => expect(lastMargin().r).toBeGreaterThan(MARGIN.r));
    const measured = widthOf(limit);
    expect(container.querySelector<HTMLElement>(".plot-slots.y2")!.style.width).toBe(`${measured}px`);
    expect(lastMargin().r).toBe(Y2_COLUMN.right + measured + Y2_COLUMN.gap);
  });
});
