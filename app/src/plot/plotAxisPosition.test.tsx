// An axis drawn on the boundary or through the origin.
// The geometry is pure (`adapter.ts`); the crossing of an automatic range is corrected after
// the first draw through the layout the library settled on (`PlotCanvas.tsx`), which is what the
// mocked bundle below stands for.

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { buildFigure, crossesAtOrigin, originPositions, paperFraction } from "./adapter";
import type { PlotFrame } from "./frame";
import { makeTrace } from "./frame";

/** What a figure asks of one axis, as the mocked bundle reads it back. */
type Drawn = { range?: number[]; anchor?: string };

/** The drawing library as the tests see it: its draws, its relayouts and the layout it settled on. */
const plotly = vi.hoisted(() => ({
  // The real library applies a relayout to the layout it keeps: so does this one, so a correction
  // that changes nothing is not asked for twice.
  relayout: vi.fn(async (element: HTMLElement, changes: Record<string, number>) => {
    const layout = (element as unknown as { _fullLayout?: Record<string, Record<string, unknown>> })._fullLayout;
    for (const [key, value] of Object.entries(changes)) {
      const [axis, field] = key.split(".");
      if (layout?.[axis]) layout[axis][field] = value;
    }
  }),
  handlers: new Map<string, (event: Record<string, unknown>) => void>(),
}));

vi.mock("./plotlyBundle", () => ({
  default: {
    react: vi.fn(async (element: HTMLElement, _data: unknown, layout: { xaxis?: Drawn; yaxis?: Drawn }) => {
      // The library keeps the layout it drew with, and its emitter, on the graph div itself.
      const host = element as unknown as {
        on: (event: string, handler: (data: Record<string, unknown>) => void) => void;
        removeListener: (event: string, handler: (data: Record<string, unknown>) => void) => void;
        _fullLayout?: Record<string, { range?: number[]; position?: number }>;
      };
      host.on = (event, handler) => plotly.handlers.set(event, handler);
      host.removeListener = (event) => plotly.handlers.delete(event);
      // An automatic range is the data's own, padded as the library pads it: the tests pin that the
      // crossing is read after the draw instead of being assumed.
      host._fullLayout = {
        xaxis: { range: layout.xaxis?.range ?? [-2, 2], position: layout.xaxis?.anchor === "free" ? 0 : undefined },
        yaxis: { range: layout.yaxis?.range ?? [-6, 6], position: layout.yaxis?.anchor === "free" ? 0 : undefined },
      };
    }),
    relayout: plotly.relayout,
    purge: vi.fn(),
    register: vi.fn(),
  },
}));

import { PlotCanvas } from "./PlotCanvas";

afterEach(cleanup);

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
  size: [360, 220],
  axes: { x: axis(), y: axis() },
  traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line" }],
  ...fields,
});

const crossed = (): PlotSpec =>
  spec({ axes: { x: axis({ position: "origin" }), y: axis({ position: "origin" }) } });

const frame = (): PlotFrame => ({
  region_id: "p",
  state: "ready",
  error: null,
  implicit_x: false,
  limits: [],
  limit_errors: [],
  units: [],
  unit_errors: [],
  traces: [makeTrace("trace-1", [-2, 0, 2], [-5, 0, 5])],
});

/** The layout object of one axis of a figure. */
const layoutAxis = (plot: PlotSpec, which: "xaxis" | "yaxis" | "yaxis2", ranges = {}) => {
  const layout = buildFigure(plot, frame(), { width: 480, height: 293 }, false, null, ranges).layout as Record<
    string,
    Record<string, unknown>
  >;
  return layout[which];
};

describe("the paper fraction of a crossing", () => {
  it("puts zero where the range puts it", () => {
    expect(paperFraction([-4, 4], false)).toBe(0.5);
    expect(paperFraction([-1, 3], false)).toBe(0.25);
    expect(paperFraction([0, 8], false)).toBe(0);
  });

  it("clamps to the plot edge when zero is outside the range, and on a log axis that has no zero", () => {
    expect(paperFraction([2, 8], false)).toBe(0);
    expect(paperFraction([-9, -3], false)).toBe(1);
    // A log axis reports the exponents of its ends and cannot reach zero at all.
    expect(paperFraction([-1, 2], true)).toBe(0);
    expect(paperFraction([-2, -1], true)).toBe(0);
  });

  it("has no fraction for a range it cannot use", () => {
    expect(paperFraction(undefined, false)).toBe(0);
    expect(paperFraction([4, 4], false)).toBe(0);
    expect(paperFraction([Number.NaN, 1], false)).toBe(0);
  });
});

describe("where the axes of a plot cross", () => {
  it("leaves every boundary axis where it was: no crossing at all", () => {
    expect(originPositions(spec(), { x: [-2, 2], y: [-4, 4] })).toEqual({});
    expect(crossesAtOrigin(spec().axes.x)).toBe(false);
  });

  it("crosses both axes at the zero of the other", () => {
    expect(originPositions(crossed(), { x: [-2, 2], y: [-4, 4] })).toEqual({ xaxis: 0.5, yaxis: 0.5 });
    // The x axis is drawn at the zero of the left y axis, the y axis at the zero of the x axis.
    expect(originPositions(crossed(), { x: [0, 4], y: [-4, 4] })).toEqual({ xaxis: 0.5, yaxis: 0 });
  });

  it("moves only the axis whose position is origin", () => {
    const plot = spec({ axes: { x: axis({ position: "origin" }), y: axis() } });
    expect(originPositions(plot, { x: [-2, 2], y: [-4, 4] })).toEqual({ xaxis: 0.5 });
  });

  it("waits for the range of the axis it crosses", () => {
    expect(originPositions(crossed(), {})).toEqual({});
    expect(originPositions(crossed(), { x: [-2, 2] })).toEqual({ yaxis: 0.5 });
  });

  it("has no cartesian axis to cross in a polar plot", () => {
    expect(originPositions({ ...crossed(), type: "polar" }, { x: [-2, 2], y: [-4, 4] })).toEqual({});
  });
});

describe("the layout object of an origin axis", () => {
  it("keeps the frame and the zero line of a boundary axis", () => {
    const x = layoutAxis(spec(), "xaxis");
    expect(x.mirror).toBe(true);
    expect(x.zeroline).toBe(true);
    expect(x.anchor).toBeUndefined();
    expect(x.position).toBeUndefined();
    expect(x.showline).toBeUndefined();
  });

  it("draws the line once, where it crosses, with ticks and labels along it", () => {
    const ranges = { x: [-2, 2], y: [-4, 4] };
    const x = layoutAxis(crossed(), "xaxis", ranges);
    const y = layoutAxis(crossed(), "yaxis", ranges);
    expect(x).toMatchObject({ anchor: "free", position: 0.5, showline: true });
    expect(y).toMatchObject({ anchor: "free", position: 0.5, showline: true });
    // Nothing at the plot edge: the mirrored frame of the boxed plot is off, and the axis line
    // already is the other axis' zero line.
    expect(x.mirror).toBe(false);
    expect(y.mirror).toBe(false);
    expect(x.zeroline).toBe(false);
    expect(y.zeroline).toBe(false);
    // Ticks and their labels stay on, on the side they have on a boundary axis.
    expect(x.ticks).toBe("outside");
    expect(y.ticks).toBe("outside");
    expect(x.showticklabels).toBe(true);
    expect(y.showticklabels).toBe(true);
  });

  it("moves one axis alone and keeps the other on its boundary", () => {
    const plot = spec({ axes: { x: axis({ position: "origin" }), y: axis() } });
    const ranges = { x: [-2, 2], y: [-4, 4] };
    expect(layoutAxis(plot, "xaxis", ranges)).toMatchObject({ anchor: "free", position: 0.5 });
    const y = layoutAxis(plot, "yaxis", ranges);
    // The y axis stays on its edge with its own line, and the crossed plot has no frame: no lone
    // mirrored line on the right edge.
    expect(y.anchor).toBeUndefined();
    expect(y.showline).toBe(true);
    expect(y.mirror).toBe(false);
    // The x axis line takes the place of the y axis' zero line, so that one is not drawn twice.
    expect(y.zeroline).toBe(false);
  });

  it("takes the crossing from the range the plot last drew, so screen and print agree", () => {
    // No stored limits: the range only exists after a draw, and the figure is built from the one
    // `PlotCanvas` read back.
    expect(layoutAxis(crossed(), "xaxis", { x: [-2, 2], y: [-1, 1] })).toMatchObject({ position: 0.5 });
    expect(layoutAxis(crossed(), "xaxis", { x: [-2, 2], y: [0.2, 2] })).toMatchObject({ position: 0 });
  });

  it("crosses at a limit the calculation resolved, without waiting for a draw", () => {
    // The session resolves the stored limits and sends them with the data: an axis that has
    // them crosses at their zero at once. The x axis has none, so it stays automatic.
    const drawn = { ...frame(), limits: [{ axis: "y" as const, min: -2, max: 2 }] };
    const layout = buildFigure(crossed(), drawn, { width: 480, height: 293 }, false).layout as Record<
      string,
      Record<string, unknown>
    >;
    // The x axis keeps its own range: it stores none, so it stays automatic.
    expect(layout.xaxis).toMatchObject({ autorange: true, position: 0.5 });
    // The y axis draws the resolved limits, and its crossing still waits for the x range.
    expect(layout.yaxis).toMatchObject({ range: [-2, 2], autorange: false, position: 0 });
  });

  it("leaves the right y axis on its own side unless the plot stores it at the origin", () => {
    const right = (position?: "boundary" | "origin") =>
      spec({
        axes: { x: axis(), y: axis(), y2: axis({ position }) },
        traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line", y_axis: "right" }],
      });
    expect(layoutAxis(right(), "yaxis2")).toMatchObject({ anchor: "free", position: 1, side: "right" });
    expect(layoutAxis(right("origin"), "yaxis2", { x: [-2, 2] })).toMatchObject({
      anchor: "free",
      position: 0.5,
      side: "right",
    });
  });
});

describe("drawing a crossed plot corrects the crossing after the first draw", () => {
  beforeEach(() => {
    plotly.relayout.mockClear();
    plotly.handlers.clear();
  });

  it("moves both axes once the library has settled on a range", async () => {
    const { getByTestId } = render(<PlotCanvas spec={crossed()} frame={frame()} width={480} height={293} />);
    await waitFor(() => expect(plotly.relayout).toHaveBeenCalled());
    // The mocked layout draws −2…2 and −6…6, so both zeros are in the middle.
    expect(plotly.relayout).toHaveBeenLastCalledWith(expect.anything(), {
      "xaxis.position": 0.5,
      "yaxis.position": 0.5,
    });
    // The plot counts as drawn once the crossing is in place: a print export waits for this.
    await waitFor(() => expect(getByTestId("plot-canvas").dataset.drawn).toBe("1"));
    // The correction moves lines only, so its own event asks for nothing more.
    plotly.relayout.mockClear();
    plotly.handlers.get("plotly_relayout")?.({ "xaxis.position": 0.5, "yaxis.position": 0.5 });
    await Promise.resolve();
    expect(plotly.relayout).not.toHaveBeenCalled();
  });

  it("does not move anything for a plot whose axes are on the boundary", async () => {
    const { getByTestId } = render(<PlotCanvas spec={spec()} frame={frame()} width={480} height={293} />);
    await waitFor(() => expect(getByTestId("plot-canvas").dataset.drawn).toBe("1"));
    expect(plotly.relayout).not.toHaveBeenCalled();
  });

  it("follows a navigated view, which moves the zero of an axis", async () => {
    const { getByTestId } = render(<PlotCanvas spec={crossed()} frame={frame()} width={480} height={293} />);
    await waitFor(() => expect(plotly.handlers.has("plotly_relayout")).toBe(true));
    // The library zooms the x axis to 0…4: zero is now at the left edge of the plot area.
    const element = getByTestId("plot-canvas") as HTMLElement & { _fullLayout: Record<string, { range?: number[] }> };
    element._fullLayout.xaxis.range = [0, 4];
    plotly.relayout.mockClear();
    plotly.handlers.get("plotly_relayout")?.({ "xaxis.range[0]": 0, "xaxis.range[1]": 4 });
    await waitFor(() => expect(plotly.relayout).toHaveBeenCalled());
    // Only the y axis moves: the x axis still crosses the y range in the middle.
    expect(plotly.relayout).toHaveBeenLastCalledWith(expect.anything(), { "yaxis.position": 0 });
  });
});
