// One title per axis. The axis titles are drawn by the
// app in their bands; the drawing library must draw none of its own, or each title shows twice
// and one copy sits under the placeholders and the tick labels.

import { readFileSync } from "node:fs";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toEditing, type Node } from "../editor/tree";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { buildFigure } from "./adapter";
import { makeTrace, type PlotFrame } from "./frame";

const react = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock("./plotlyBundle", () => ({ default: { react, purge: vi.fn() } }));

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

const trace = (id: string, fields: Partial<PlotSpec["traces"][number]> = {}) => ({
  id,
  x: "x",
  y: "f(x)",
  presentation: "line" as const,
  show_in_legend: true,
  ...fields,
});

const spec = (fields: Partial<PlotSpec> = {}): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [420, 260],
  axes: { x: axis({ title: "current (A)" }), y: axis({ title: "voltage (V)" }) },
  traces: [trace("trace-1")],
  ...fields,
});

const CASES: Record<string, PlotSpec> = {
  "one trace": spec(),
  "several traces": spec({ traces: [trace("trace-1"), trace("trace-2", { y: "g(x)" }), trace("trace-3", { y: "h(x)" })] }),
  "a second y axis": spec({
    axes: { x: axis({ title: "current (A)" }), y: axis({ title: "voltage (V)" }), y2: axis({ title: "power (W)" }) },
    traces: [trace("trace-1"), trace("trace-2", { y: "g(x)", y_axis: "right" })],
  }),
  "a polar plot": spec({ type: "polar", traces: [trace("trace-1", { x: "t", y: "r(t)" })] }),
};

const frameOf = (plot: PlotSpec): PlotFrame => ({
  region_id: "p",
  state: "ready",
  error: null,
  implicit_x: false,
  limits: [],
  limit_errors: [],
  units: [],
  unit_errors: [],
  traces: plot.traces.map((t) => makeTrace(t.id, [0, 1], [0, 1])),
});

const name = (text: string): Node => ({
  type: "ExprRegion",
  expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } },
});

const env = (plot: PlotSpec): PlotEnv => ({
  revision: 0,
  load: async () => frameOf(plot),
  save: () => undefined,
  toTree: async (text) => toEditing(name(text)),
  toText: async () => "x",
  selectedTrace: () => null,
  view: () => undefined,
  selectTrace: () => undefined,
  selectRegion: () => undefined,
});

/** The titles the figure hands the library, wherever the figure could carry one. */
function figureTitles(layout: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  const visit = (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key === "title") found.push(inner);
      else visit(inner);
    }
  };
  visit(layout);
  return found;
}

describe("one title per axis", () => {
  for (const [label, plot] of Object.entries(CASES)) {
    it(`hands the library no axis title: ${label}`, () => {
      const { layout } = buildFigure(plot, frameOf(plot), { width: 420, height: 260 }, false);
      expect(figureTitles(layout)).toEqual([]);
    });

    it(`draws each title once, as the app's band text: ${label}`, async () => {
      react.mockClear();
      const { container } = render(
        <PlotContext.Provider value={env(plot)}>
          <PlotView region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot }} size={null} selected={false} />
        </PlotContext.Provider>,
      );
      // What the library receives when it draws the plot.
      await waitFor(() => expect(react).toHaveBeenCalled());
      const layout = react.mock.calls.at(-1)?.[2] as Record<string, unknown>;
      expect(figureTitles(layout)).toEqual([]);
      // Exactly one element per axis title.
      expect(container.querySelectorAll(".axis-title.x")).toHaveLength(1);
      expect(container.querySelectorAll(".axis-title.y")).toHaveLength(1);
      expect(container.querySelectorAll(".axis-title.y2")).toHaveLength(label === "a second y axis" ? 1 : 0);
      expect(container.querySelector(".axis-title.x")?.textContent).toBe("current (A)");
      expect(container.querySelector(".axis-title.y")?.textContent).toBe("voltage (V)");
    });
  }
});

describe("where the single title sits", () => {
  const css = readFileSync(`${process.cwd()}/src/styles/page.css`, "utf8");
  const rule = (selector: string) => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
    expect(match, selector).not.toBeNull();
    return match![1];
  };

  it("sizes the axis bands at the plot text size and keeps the plot title larger", () => {
    expect(rule(".plot-labels")).toMatch(/font-size:\s*11px/);
    expect(rule(".plot-labels.title")).toMatch(/font-size:\s*16px/);
  });

  it("puts the x title 8 px off the bottom edge and the y title at the left edge", () => {
    expect(rule(".plot-labels.x")).toMatch(/bottom:\s*8px/);
    expect(rule(".plot-labels.y")).toMatch(/left:\s*0/);
  });
});
