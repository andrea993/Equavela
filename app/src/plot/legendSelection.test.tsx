// A plot legend entry is typeset math drawn by the app, not the drawing library's text label,
// and a press on an entry selects its trace and the plot region
//. The expression is parsed by the worksheet parser through `PlotContext`, as in
// the window (`Workbench.tsx`), so the test feeds the canonical AST the Rust parser produces for
// `v_1^2 + sin(t)/2`: a subscripted name, a superscript and a stacked fraction.

import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toEditing, type Node } from "../editor/tree";
import type { PlotSpec } from "../equavelaApi";
import { enterPrint, leavePrint } from "../print/printMode";
import { makeTrace, type PlotFrame } from "./frame";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn() } }));

import { PlotContext, type PlotEnv } from "./PlotContext";
import { PlotView } from "./PlotView";

const axis = { scale: "linear" as const, unit: null, min: null, max: null, show_grid: true, title: "" };

/** The AST of `v_1^2 + sin(t)/2` as `core/src/syntax` parses it: `Pow` with a literal subscript, and `Div`. */
const typed: Node = {
  type: "ExprRegion",
  expr: {
    type: "Add",
    split: false,
    left: {
      type: "Pow",
      left: { type: "Ident", name: { segments: [{ text: "v", subscript: false }, { text: "1", subscript: true }], label: null } },
      right: { type: "Num", text: "2" },
    },
    right: {
      type: "Div",
      left: {
        type: "Call",
        callee: { type: "Ident", name: { segments: [{ text: "sin", subscript: false }], label: null } },
        args: [{ type: "Expr", expr: { type: "Ident", name: { segments: [{ text: "t", subscript: false }], label: null } } }],
      },
      right: { type: "Num", text: "2" },
    },
  },
};

/** A single literal name, what the parser gives for text it does not understand further. */
const name = (text: string): Node => ({ type: "ExprRegion", expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } } });

const spec = (): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [360, 220],
  axes: { x: { ...axis }, y: { ...axis } },
  traces: [
    { id: "trace-1", x: "x", y: "v_1^2 + sin(t)/2", presentation: "line" },
    { id: "trace-2", x: "x", y: "g(x)", presentation: "line" },
  ],
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
  traces: [makeTrace("trace-1", [0, 1], [0, 1]), makeTrace("trace-2", [0, 1], [1, 2])],
};

type Calls = { selectTrace: string[]; selectRegion: string[] };

function env(calls: Calls, labels: Record<string, Node> = {}, drawn: PlotFrame = frame): PlotEnv {
  return {
    revision: 0,
    load: async () => drawn,
    save: () => undefined,
    // What `Workbench.tsx` does: the worksheet parser turns the stored text into the editing tree.
    toTree: async (text) => toEditing(labels[text] ?? name(text)),
    toText: async () => "",
    selectedTrace: () => null,
    view: () => undefined,
    selectTrace: (_region, traceId) => {
      if (traceId !== null) calls.selectTrace.push(traceId);
    },
    selectRegion: (regionId) => calls.selectRegion.push(regionId),
  };
}

function renderPlot(plot: PlotSpec, plotEnv: PlotEnv) {
  return render(
    <PlotContext.Provider value={plotEnv}>
      <PlotView region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot }} size={null} selected={false} />
    </PlotContext.Provider>,
  );
}

/** The legend entries in drawing order. */
const entries = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".plot-legend-entry")];

describe("legend labels are typeset math", () => {
  it("draws the trace expression with subscripts, superscripts and a fraction and no syntax characters", async () => {
    const calls: Calls = { selectTrace: [], selectRegion: [] };
    const { container } = renderPlot(spec(), env(calls, { "v_1^2 + sin(t)/2": typed }));
    await waitFor(() => expect(entries(container)).toHaveLength(2));
    const first = entries(container)[0];
    // The expression is parsed asynchronously, as every placeholder of the plot is.
    await waitFor(() => expect(first.querySelector(".math")).not.toBeNull());
    expect(first.querySelector(".math .name .sub.lit")?.textContent).toBe("1");
    expect(first.querySelector(".math .sup")).not.toBeNull();
    expect(first.querySelector(".math .frac")).not.toBeNull();
    const text = first.textContent ?? "";
    expect(text).not.toContain("_");
    expect(text).not.toContain("^");
    expect(text).not.toContain("/");
  });

  it("keeps a custom legend label and the id fallback as literal text", async () => {
    const calls: Calls = { selectTrace: [], selectRegion: [] };
    const plot = spec();
    plot.traces.push({ id: "trace-3", x: "x", y: "   ", presentation: "line" });
    plot.traces[1].legend_label = "measured v_1^2";
    const drawn: PlotFrame = { ...frame, traces: [...frame.traces, makeTrace("trace-3", [0, 1], [2, 3])] };
    const { container } = renderPlot(plot, env(calls, { "v_1^2 + sin(t)/2": typed }, drawn));
    await waitFor(() => expect(entries(container)).toHaveLength(3));
    // A literal label is not parsed: it keeps its text and draws no math.
    expect(entries(container)[1].textContent).toBe("measured v_1^2");
    expect(entries(container)[1].querySelector(".math")).toBeNull();
    // An empty expression falls back to the stable trace id.
    expect(entries(container)[2].textContent).toBe("trace-3");
  });

  it("shows an entry only for a trace that is drawn and enabled in the legend", async () => {
    const calls: Calls = { selectTrace: [], selectRegion: [] };
    const plot = spec();
    plot.traces[1].show_in_legend = false;
    const { container } = renderPlot(plot, env(calls));
    await waitFor(() => expect(entries(container)).toHaveLength(1));
    expect(entries(container)[0].dataset.legendTraceId).toBe("trace-1");
  });

  it("draws the same legend on screen and in print (WYSIWYG)", async () => {
    const calls: Calls = { selectTrace: [], selectRegion: [] };
    const { container } = renderPlot(spec(), env(calls, { "v_1^2 + sin(t)/2": typed }));
    await waitFor(() => expect(container.querySelectorAll(".plot-legend .math")).toHaveLength(2));
    const screen = container.querySelector(".plot-legend")?.outerHTML;
    enterPrint();
    try {
      await waitFor(() => expect(container.querySelector(".plot-legend")).not.toBeNull());
      expect(container.querySelector(".plot-legend")?.outerHTML).toBe(screen);
    } finally {
      leavePrint();
    }
  });
});

describe("legend selection", () => {
  it("selects the trace whose entry was pressed and the plot region, and never hides the trace", async () => {
    const calls: Calls = { selectTrace: [], selectRegion: [] };
    const { container } = renderPlot(spec(), env(calls));
    await waitFor(() => expect(entries(container)).toHaveLength(2));
    fireEvent.click(entries(container)[1]);
    expect(calls.selectTrace).toEqual(["trace-2"]);
    expect(calls.selectRegion).toEqual(["p"]);
    // A legend press never hides a trace: both entries stay, and both traces stay in the drawing.
    expect(entries(container)).toHaveLength(2);
  });
});
