// Navigating the view of an XY plot resamples the traces whose x the plot samples itself:
// the library reports the new x range, the app sends it to the
// session, debounced, and only for a plot that has such a trace. The mapping and the debounce are
// pure (`view.ts`); the wiring is exercised through the real `PlotView` and `PlotCanvas`.

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toEditing } from "../editor/tree";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { createMockBackend, type MockBackend } from "../mock/mockBackend";
import { makeTrace, type PlotFrame } from "./frame";
import { createViewSender, relayoutViewRange, sameViewRange, VIEW_DEBOUNCE_MS, type ViewRange } from "./view";

/** What the mocked drawing library keeps: the handlers registered on the graph div. */
const plotly = vi.hoisted(() => ({
  handlers: new Map<string, (event: Record<string, unknown>) => void>(),
}));

vi.mock("./plotlyBundle", () => ({
  default: {
    // The library attaches its emitter to the graph div while it draws, as the real one does.
    react: vi.fn(async (element: HTMLElement) => {
      const host = element as unknown as {
        on: (event: string, handler: (data: Record<string, unknown>) => void) => void;
        removeListener: (event: string, handler: (data: Record<string, unknown>) => void) => void;
      };
      host.on = (event, handler) => plotly.handlers.set(event, handler);
      host.removeListener = (event) => plotly.handlers.delete(event);
    }),
    purge: vi.fn(),
    register: vi.fn(),
  },
}));

import { PlotContext, type PlotEnv } from "./PlotContext";
import { PlotView } from "./PlotView";

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
  traces: [{ id: "trace-1", x: "x", y: "sin(x)", presentation: "line" }],
  ...fields,
});

const frame = (implicit_x: boolean): PlotFrame => ({
  region_id: "p",
  state: "ready",
  error: null,
  implicit_x,
  limits: [],
  limit_errors: [],
  units: [],
  unit_errors: [],
  traces: [makeTrace("trace-1", [0, 1], [0, 1])],
});

type Calls = { views: (ViewRange | null)[] };

function env(calls: Calls, drawn: PlotFrame): PlotEnv {
  return {
    revision: 0,
    load: async () => drawn,
    save: () => undefined,
    toTree: async (text) => toEditing({
      type: "ExprRegion",
      expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } },
    }),
    toText: async () => "",
    selectedTrace: () => null,
    view: (_region, range) => calls.views.push(range),
    selectTrace: () => undefined,
    selectRegion: () => undefined,
  };
}

function renderPlot(plot: PlotSpec, plotEnv: PlotEnv) {
  return render(
    <PlotContext.Provider value={plotEnv}>
      <PlotView region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot }} size={null} selected={false} />
    </PlotContext.Provider>,
  );
}

/** Reports a navigation of the view, as the library does. */
async function navigate(event: Record<string, unknown>) {
  await waitFor(() => expect(plotly.handlers.has("plotly_relayout")).toBe(true));
  act(() => plotly.handlers.get("plotly_relayout")?.(event));
}

describe("the x range a plotly_relayout event means", () => {
  it("reads both shapes of a range the library reports", () => {
    expect(relayoutViewRange({ "xaxis.range[0]": -15, "xaxis.range[1]": 5 })).toEqual({ min: -15, max: 5 });
    expect(relayoutViewRange({ "xaxis.range": [-15, 5] })).toEqual({ min: -15, max: 5 });
    // A pan reports both axes; only the x range moves a sample.
    expect(relayoutViewRange({ "xaxis.range[0]": 0, "xaxis.range[1]": 2, "yaxis.range[0]": 1 })).toEqual({
      min: 0,
      max: 2,
    });
  });

  it("is reset-to-data-range for an autorange, and nothing at all for an unrelated event", () => {
    expect(relayoutViewRange({ "xaxis.autorange": true })).toBeNull();
    expect(relayoutViewRange({ "yaxis.range[0]": 1, "yaxis.range[1]": 2 })).toBeUndefined();
    expect(relayoutViewRange({ dragmode: "pan" })).toBeUndefined();
    expect(relayoutViewRange({ "xaxis.range[0]": 1 })).toBeUndefined();
  });

  it("reads the range of a logarithmic axis as exponents, and refuses what is not an interval", () => {
    // The library reports the ends of a log axis as their exponents: -1…1 is 0.1…10.
    expect(relayoutViewRange({ "xaxis.range": [-1, 1] }, true)).toEqual({ min: 0.1, max: 10 });
    expect(relayoutViewRange({ "xaxis.range": [3, 3] })).toBeUndefined();
    expect(relayoutViewRange({ "xaxis.range": [5, -5] })).toBeUndefined();
    expect(relayoutViewRange({ "xaxis.range": [Number.NaN, 1] })).toBeUndefined();
  });

  it("compares ranges by value", () => {
    expect(sameViewRange({ min: -15, max: 5 }, { min: -15, max: 5 })).toBe(true);
    expect(sameViewRange(null, null)).toBe(true);
    expect(sameViewRange(null, { min: 0, max: 1 })).toBe(false);
    expect(sameViewRange({ min: 0, max: 1 }, { min: 0, max: 2 })).toBe(false);
  });
});

describe("the debounced view report", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the last range of a gesture once, after the delay", () => {
    const sent: (ViewRange | null)[] = [];
    const sender = createViewSender((range) => sent.push(range), 150);
    sender.push({ min: -11, max: 9 });
    vi.advanceTimersByTime(100);
    sender.push({ min: -13, max: 7 });
    vi.advanceTimersByTime(100);
    sender.push({ min: -15, max: 5 });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(VIEW_DEBOUNCE_MS);
    expect(sent).toEqual([{ min: -15, max: 5 }]);
  });

  it("does not send the range the plot already has, and sends a reset once", () => {
    const sent: (ViewRange | null)[] = [];
    const sender = createViewSender((range) => sent.push(range), 150);
    sender.push({ min: -15, max: 5 });
    vi.advanceTimersByTime(150);
    // The redraw of the same range (data → figure → relayout) must not ask for another pass.
    sender.push({ min: -15, max: 5 });
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ min: -15, max: 5 }]);
    // Reset-to-data-range clears the view.
    sender.push(null);
    vi.advanceTimersByTime(150);
    expect(sent).toEqual([{ min: -15, max: 5 }, null]);
  });

  it("drops what is waiting when the plot goes away", () => {
    const sent: (ViewRange | null)[] = [];
    const sender = createViewSender((range) => sent.push(range), 150);
    sender.push({ min: -15, max: 5 });
    sender.cancel();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
  });
});

describe("navigating a plot region", () => {
  beforeEach(() => plotly.handlers.clear());

  it("sends the new x range of a plot that samples its own x", async () => {
    const calls: Calls = { views: [] };
    renderPlot(spec(), env(calls, frame(true)));
    await navigate({ "xaxis.range[0]": -15, "xaxis.range[1]": 5 });
    await waitFor(() => expect(calls.views).toEqual([{ min: -15, max: 5 }]));
  });

  it("clears the view on reset-to-data-range", async () => {
    const calls: Calls = { views: [] };
    renderPlot(spec(), env(calls, frame(true)));
    await navigate({ "xaxis.autorange": true });
    await waitFor(() => expect(calls.views).toEqual([null]));
  });

  it("sends nothing for a plot whose x is a worksheet expression, or for a y-only navigation", async () => {
    const explicit: Calls = { views: [] };
    renderPlot(spec(), env(explicit, frame(false)));
    // A plot with no implicit x trace registers no listener at all.
    await waitFor(() => expect(document.querySelector(".plot-canvas")?.getAttribute("data-mounted")).toBe("true"));
    expect(plotly.handlers.has("plotly_relayout")).toBe(false);

    const yOnly: Calls = { views: [] };
    renderPlot(spec(), env(yOnly, frame(true)));
    await navigate({ "yaxis.range[0]": -1, "yaxis.range[1]": 1 });
    // Nothing is reported, so nothing is sent: wait for the debounce to have had its chance.
    await new Promise((resolve) => setTimeout(resolve, VIEW_DEBOUNCE_MS * 2));
    expect(yOnly.views).toEqual([]);
  });
});

/** Resolves when the next calculation pass of the mock backend finishes. */
async function nextPass(backend: MockBackend): Promise<() => Promise<void>> {
  const waiters: (() => void)[] = [];
  await backend.onWorksheetEvent((event) => {
    if (event.event === "pass_finished") waiters.splice(0).forEach((done) => done());
  });
  return () => new Promise<void>((resolve) => waiters.push(resolve));
}

describe("the demo backend resamples a navigated plot", () => {
  it("draws the trace over the visible interval and keeps the view out of the undo history", async () => {
    const backend = createMockBackend({ fast: true });
    const opened = await backend.openWorksheet("/demo/demo.eqv");
    const added = await backend.addRegion(opened.id, "plot", 1, 54, 620);
    const plotId = added.created!;
    const region = added.view.regions.find((r) => r.id === plotId);
    if (!region || region.kind !== "plot") throw new Error("no plot region");
    await backend.setPlot(opened.id, plotId, {
      ...region.plot,
      traces: [{ ...region.plot.traces[0], x: "t", y: "sin(t)" }],
    });
    let finished = await nextPass(backend);
    await backend.recalculate(opened.id, false);
    await finished();
    const drawn = await backend.plotData(opened.id, plotId);
    expect(drawn.state).toBe("ready");
    expect(drawn.implicit_x).toBe(true);
    expect(drawn.traces[0].x[0]).toBe(-10);
    expect(drawn.traces[0].x[drawn.traces[0].x.length - 1]).toBe(10);
    expect(drawn.traces[0].x).toHaveLength(501);

    // Panning to -15..5 resamples the trace; the same range again asks for nothing.
    const undoBefore = (await backend.getView(opened.id)).undo_label;
    expect(await backend.setPlotView(opened.id, plotId, -15, 5)).toBe(true);
    expect(await backend.setPlotView(opened.id, plotId, -15, 5)).toBe(false);
    finished = await nextPass(backend);
    await backend.recalculate(opened.id, false);
    await finished();
    const panned = await backend.plotData(opened.id, plotId);
    expect(panned.state).toBe("ready");
    expect(panned.traces[0].x[0]).toBe(-15);
    expect(panned.traces[0].x[panned.traces[0].x.length - 1]).toBe(5);
    expect(panned.traces[0].y[0]).toBeCloseTo(Math.sin(-15), 12);
    // Screen-only: no undo step was added (the label is still the one of the last edit).
    expect((await backend.getView(opened.id)).undo_label).toBe(undoBefore);

    // Reset-to-data-range goes back to the default interval.
    expect(await backend.setPlotView(opened.id, plotId, null, null)).toBe(true);
    finished = await nextPass(backend);
    await backend.recalculate(opened.id, false);
    await finished();
    const reset = await backend.plotData(opened.id, plotId);
    expect(reset.traces[0].x[0]).toBe(-10);
    expect(reset.traces[0].x[reset.traces[0].x.length - 1]).toBe(10);
  });
});
