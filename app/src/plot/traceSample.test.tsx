// Under each trace's y expression the plot draws a short line sample in the trace's colour and dash:
// it is part of the plot, so it stays while the region is
// not selected and is printed; an empty placeholder has none. A new trace is hidden from the legend
//, so the sample is what tells the traces apart.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toEditing, type Node } from "../editor/tree";
import type { PlotSpec } from "../equavelaApi";
import { createMockBackend } from "../mock/mockBackend";
import { withNewTrace } from "./edit";
import { makeTrace, type PlotFrame } from "./frame";
import { PALETTE, legendEntries } from "./adapter";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn() } }));

import { PlotContext, type PlotEnv } from "./PlotContext";
import { PlotView } from "./PlotView";

const axis = { scale: "linear" as const, unit: null, min: null, max: null, show_grid: true, title: "" };
const name = (text: string): Node => ({ type: "ExprRegion", expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } } });

const spec = (): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [360, 220],
  axes: { x: { ...axis }, y: { ...axis } },
  traces: [
    { id: "trace-1", x: "x", y: "f(x)", presentation: "line" },
    { id: "trace-2", x: "x", y: "g(x)", presentation: "line", line: { style: "dash", width: 1, color: "#aa0000" } },
    { id: "trace-3", x: "x", y: "h(x)", presentation: "markers", marker: { shape: "circle", size: 5, color: "#00aa00" } },
    { id: "trace-4", x: "x", y: "", presentation: "line" },
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
  traces: ["trace-1", "trace-2", "trace-3"].map((id) => makeTrace(id, [0, 1], [0, 1])),
};

const env: PlotEnv = {
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

/** The sample line of the y slot of `traceId`, or null. */
const sampleOf = (container: HTMLElement, traceId: string) =>
  container.querySelector(`[data-trace-id="${traceId}"] .plot-trace-sample line`);

describe("the trace sample under the y expression", () => {
  it("is drawn in the trace's colour and dash while the plot is not selected, and not under an empty slot", async () => {
    const { container } = render(
      <PlotContext.Provider value={env}>
        <PlotView region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot: spec() }} size={null} selected={false} />
      </PlotContext.Provider>,
    );
    await waitFor(() => expect(sampleOf(container, "trace-1")).not.toBeNull());
    expect(sampleOf(container, "trace-1")?.getAttribute("stroke")).toBe(PALETTE[0]);
    expect(sampleOf(container, "trace-1")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(sampleOf(container, "trace-2")?.getAttribute("stroke")).toBe("#aa0000");
    expect(sampleOf(container, "trace-2")?.getAttribute("stroke-dasharray")).toBe("6 4");
    // A marker-only trace shows its marker colour, solid.
    expect(sampleOf(container, "trace-3")?.getAttribute("stroke")).toBe("#00aa00");
    expect(sampleOf(container, "trace-3")?.getAttribute("stroke-dasharray")).toBeNull();
    expect(sampleOf(container, "trace-4")).toBeNull();
    // Not editing chrome: the plot is not selected, and the sample is not marked screen-only.
    expect(container.querySelector(".plot-region.editing")).toBeNull();
    expect(container.querySelector(".plot-trace-sample")?.closest(".no-print")).toBeNull();
  });
});

describe("a new trace is hidden from the legend", () => {
  it("a trace added to a plot, or the trace of a new plot, has no legend entry until it is shown", async () => {
    const added = withNewTrace(spec());
    expect(added.traces.at(-1)?.show_in_legend).toBe(false);
    // The traces of a worksheet that omits the field stay in the legend.
    expect(legendEntries(spec(), frame).map((entry) => entry.traceId)).toEqual(["trace-1", "trace-2", "trace-3"]);

    const backend = createMockBackend({ fast: true });
    const opened = await backend.newWorksheet();
    await backend.addRegion(opened.id, "plot", 1, 40, 400);
    const plot = (await backend.getView(opened.id)).regions.find((region) => region.kind === "plot");
    expect(plot?.kind === "plot" && plot.plot.traces[0].show_in_legend).toBe(false);
  });
});
