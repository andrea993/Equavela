// The plot title and the axis titles and units:
// they are drawn by the app in bands that exist only while a field holds text, a unit is typeset by
// the math renderer, the same nodes render on screen and in the PDF, and a unit the calculation
// could not use is reported on the plot.

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { toEditing, type Node } from "../editor/tree";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { enterPrint, leavePrint } from "../print/printMode";
import { BASE_MARGIN, MARGIN, NO_RIGHT_AXIS_MARGIN, plotBands, plotMargin, TITLE_BAND } from "./adapter";
import { makeTrace, type PlotFrame } from "./frame";
import { setAxisTitle, setAxisUnit, setPlotTitle } from "./edit";

vi.mock("./plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn() } }));

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

/** A single literal name, what the parser gives for a unit such as `mm` (a plain identifier). */
const name = (text: string): Node => ({
  type: "ExprRegion",
  expr: { type: "Ident", name: { segments: [{ text, subscript: false }], label: null } },
});

type Calls = { saved: PlotSpec[]; selectRegion: string[] };

function env(calls: Calls, drawn: PlotFrame = frame): PlotEnv {
  return {
    revision: 0,
    load: async () => drawn,
    save: (_region, next) => calls.saved.push(next),
    // What `Workbench.tsx` does: the worksheet parser turns the stored text into the editing tree.
    toTree: async (text) => toEditing(name(text)),
    // The unit the test types: whatever the editor holds becomes this text.
    toText: async () => "m/s",
    selectedTrace: () => null,
    view: () => undefined,
    selectTrace: () => undefined,
    selectRegion: (regionId) => calls.selectRegion.push(regionId),
  };
}

function renderPlot(plot: PlotSpec, plotEnv: PlotEnv, selected = false) {
  return render(
    <PlotContext.Provider value={plotEnv}>
      <PlotView
        region={{ id: "p", page: 1, x: 0, y: 0, enabled: true, kind: "plot", plot }}
        size={null}
        selected={selected}
      />
    </PlotContext.Provider>,
  );
}

const bands = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".plot-labels")];

describe("the bands of a plot title and of the axis titles", () => {
  it("takes no room and draws nothing while no field holds text", () => {
    const bare = spec();
    expect(plotBands(bare)).toEqual({ plot: 0, x: 0, y: 0, y2: 0 });
    expect(plotMargin(bare)).toEqual(BASE_MARGIN);
    const calls: Calls = { saved: [], selectRegion: [] };
    const { container } = renderPlot(bare, env(calls));
    expect(bands(container)).toHaveLength(0);
    expect(container.querySelector(".plot-label")).toBeNull();
  });

  it("reserves one band per field that holds text, and only in its own margin", () => {
    const plot = spec({
      title: "Climb rate",
      axes: {
        x: axis({ title: "Time", unit: "s" }),
        y: axis({ title: "Speed", unit: "m/s" }),
      },
    });
    expect(plotBands(plot)).toEqual({ plot: TITLE_BAND, x: TITLE_BAND, y: TITLE_BAND, y2: 0 });
    expect(plotMargin(plot)).toEqual({
      l: MARGIN.l + TITLE_BAND,
      r: NO_RIGHT_AXIS_MARGIN,
      t: MARGIN.t + TITLE_BAND,
      b: MARGIN.b + TITLE_BAND,
    });
    // The bands depend on the stored specification only, never on a selection or an edit.
    expect(plotMargin(plot)).toEqual(plotMargin({ ...plot }));
  });

  it("draws a band for the right y axis only while a trace uses it", () => {
    const right = [{ id: "t1", x: "x", y: "y", presentation: "line" as const, y_axis: "right" as const }];
    const axes = { x: axis(), y: axis(), y2: axis({ title: "Torque" }) };
    expect(plotBands(spec({ axes })).y2).toBe(0);
    expect(plotBands(spec({ axes, traces: right })).y2).toBe(TITLE_BAND);
    // The right axis has its own title and unit: the left axis's are never drawn twice.
    const leftOnly = { x: axis(), y: axis({ title: "Speed", unit: "m/s" }) };
    expect(plotBands(spec({ axes: leftOnly, traces: right })).y2).toBe(0);
  });

  it("draws the plot title above the plot area and an axis title in its own band", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const plot = spec({
      title: "Climb rate",
      axes: { x: axis({ title: "Time" }), y: axis({ title: "Speed" }) },
    });
    const { container } = renderPlot(plot, env(calls));
    const [title, x, y] = bands(container);
    expect(title.className).toContain("title");
    expect(title.textContent).toBe("Climb rate");
    expect(x.className).toContain("x");
    expect(x.textContent).toBe("Time");
    expect(y.className).toContain("y");
    expect(y.textContent).toBe("Speed");
    // A title is literal text: it is never typeset as math.
    expect(container.querySelector(".plot-labels .math")).toBeNull();
    // The bands sit in the margins the plot area keeps, so they never cover the data.
    expect(title.style.left).toBe(`${MARGIN.l + TITLE_BAND}px`);
    expect(title.style.right).toBe(`${NO_RIGHT_AXIS_MARGIN}px`);
    // The x band takes the outer edge of the bottom margin (page.css), one band tall.
    expect(x.style.height).toBe(`${TITLE_BAND}px`);
    expect(y.style.width).toBe(`${TITLE_BAND}px`);
    expect(y.style.top).toBe(`${MARGIN.t + TITLE_BAND}px`);
    expect(y.style.bottom).toBe(`${MARGIN.b + TITLE_BAND}px`);
  });

  it("draws a unit in drawn parentheses as typeset math after its axis title", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const plot = spec({ axes: { x: axis(), y: axis({ title: "Speed", unit: "m/s" }) } });
    const { container } = renderPlot(plot, env(calls));
    const band = container.querySelector<HTMLElement>(".plot-labels.y")!;
    // The unit goes through the math renderer, like every placeholder of the plot; the title is
    // literal text in front of it.
    await waitFor(() => expect(band.querySelector(".plot-slot .math")).not.toBeNull());
    expect(band.textContent?.replace(/\s/g, "")).toBe("Speedm/s");
    // The unit sits between the drawn parentheses of math, not between text parentheses.
    expect(band.querySelectorAll(".unit-fence.paren > .fence-side")).toHaveLength(2);
    // Its title, the literal text, is not math.
    expect(band.querySelector(".axis-title")?.querySelector(".math")).toBeNull();
  });

  it("draws the names of an axis unit as units, because the axis unit is a unit context", async () => {
    // A value position would draw a plain `m` as a variable; the
    // axis display unit is a slot that can only hold a unit, so its names stay units.
    const calls: Calls = { saved: [], selectRegion: [] };
    const plot = spec({ axes: { x: axis(), y: axis({ unit: "m" }) } });
    const { container } = renderPlot(plot, env(calls));
    const band = container.querySelector<HTMLElement>(".plot-labels.y")!;
    await waitFor(() => expect(band.querySelector(".plot-unit [data-name]")).not.toBeNull());
    expect(band.querySelector<HTMLElement>(".plot-unit [data-name]")!.dataset.label).toBe("unit");
  });

  it("draws a unit whose axis has no title as (unit) alone", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const { container } = renderPlot(spec({ axes: { x: axis({ unit: "s" }), y: axis() } }), env(calls));
    const band = container.querySelector<HTMLElement>(".plot-labels.x")!;
    await waitFor(() => expect(band.querySelector(".plot-slot .math")).not.toBeNull());
    expect(band.textContent?.replace(/\s/g, "")).toBe("s");
    expect(band.querySelectorAll(".unit-fence.paren > .fence-side")).toHaveLength(2);
  });

  it("draws the same labels on screen and in print (WYSIWYG)", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const plot = spec({
      title: "Climb rate",
      axes: { x: axis({ title: "Time", unit: "s" }), y: axis({ title: "Speed", unit: "m/s" }) },
    });
    const { container } = renderPlot(plot, env(calls));
    await waitFor(() => expect(container.querySelectorAll(".plot-labels .math")).toHaveLength(2));
    const drawn = bands(container).map((band) => band.outerHTML);
    enterPrint();
    try {
      await waitFor(() => expect(bands(container)).toHaveLength(3));
      expect(bands(container).map((band) => band.outerHTML)).toEqual(drawn);
      // Nothing of the editor is printed: a title is drawn as text, never as an input field.
      expect(container.querySelector(".plot-label-input")).toBeNull();
    } finally {
      leavePrint();
    }
  });
});

describe("editing a title and a unit", () => {
  it("edits a filled title where it is drawn, as one undo step", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const { container } = renderPlot(spec({ title: "Climb" }), env(calls));
    const title = container.querySelector<HTMLElement>(".plot-labels.title .plot-label")!;
    await act(async () => {
      fireEvent.pointerDown(title, { button: 0 });
    });
    expect(calls.selectRegion).toEqual(["p"]);
    const input = container.querySelector<HTMLInputElement>(".plot-label-input")!;
    expect(input.value).toBe("Climb");
    fireEvent.change(input, { target: { value: "Climb rate" } });
    fireEvent.blur(input);
    expect(calls.saved).toHaveLength(1);
    expect(calls.saved[0].title).toBe("Climb rate");
    // The edit is over: the field is drawn as text again (the app re-renders with the saved
    // specification, which this test records rather than applies).
    expect(container.querySelector(".plot-label-input")).toBeNull();
  });

  it("leaves the stored title alone when the edit is cancelled or unchanged", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const { container } = renderPlot(spec({ title: "Climb" }), env(calls));
    const open = () => {
      const title = container.querySelector<HTMLElement>(".plot-labels.title .plot-label")!;
      fireEvent.pointerDown(title, { button: 0 });
      return container.querySelector<HTMLInputElement>(".plot-label-input")!;
    };
    // Escape throws the draft away.
    fireEvent.keyDown(open(), { key: "Escape" });
    expect(container.querySelector(".plot-label-input")).toBeNull();
    expect(calls.saved).toHaveLength(0);
    // Confirming the same text stores nothing.
    fireEvent.blur(open());
    expect(calls.saved).toHaveLength(0);
  });

  it("edits a unit with the math editor and stores its canonical text", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const { container } = renderPlot(spec({ axes: { x: axis(), y: axis({ unit: "mm" }) } }), env(calls));
    const slot = container.querySelector<HTMLElement>(".plot-labels.y .plot-slot")!;
    await waitFor(() => expect(slot.querySelector(".math")).not.toBeNull());
    // Pressing a filled unit edits it and selects the plot region; it never moves the region.
    await act(async () => {
      fireEvent.pointerDown(slot, { button: 0 });
    });
    expect(calls.selectRegion).toContain("p");
    // Pressing it and leaving it without typing stores nothing: an untouched placeholder is not an
    // edit, so it never becomes an undo step.
    await act(async () => {
      fireEvent.blur(slot);
    });
    expect(calls.saved).toHaveLength(0);
  });

  it("sets a plot title, an axis title and a unit as pure edits, one line each", () => {
    const base = spec({ axes: { x: axis(), y: axis(), y2: axis() } });
    expect(setPlotTitle(base, "  Climb\nrate ").title).toBe("Climb rate");
    // An empty title removes the field, so nothing is written for it.
    expect(setPlotTitle({ ...base, title: "Climb" }, "   ").title).toBe("");
    expect(setAxisTitle(base, "x", "Time").axes.x.title).toBe("Time");
    expect(setAxisTitle(base, "y2", "Torque").axes.y2?.title).toBe("Torque");
    expect(setAxisUnit(base, "y", " m/s ").axes.y.unit).toBe("m/s");
    expect(setAxisUnit({ ...base, axes: { ...base.axes, y: axis({ unit: "mm" }) } }, "y", "  ").axes.y.unit).toBeNull();
    // The right y axis keeps its own limits while its title changes.
    const withRight = { ...base, axes: { ...base.axes, y2: axis({ max: 5 }) } };
    expect(setAxisTitle(withRight, "y2", "Torque").axes.y2).toMatchObject({ max: 5, title: "Torque" });
    // A right axis that no trace has used yet keeps the scale it is drawn with (the left axis's)
    // and starts with its own limits, title and unit: writing its title never copies the left
    // axis's unit onto it.
    const left = { ...base, axes: { x: axis(), y: axis({ unit: "m/s", scale: "log10" as const }) } };
    expect(setAxisTitle(left, "y2", "Torque").axes.y2).toEqual({
      scale: "log10",
      unit: null,
      min: null,
      max: null,
      show_grid: true,
      title: "Torque",
    });
  });
});

describe("a unit the calculation could not use", () => {
  it("is reported on the plot while the traces stay drawn in SI", async () => {
    const calls: Calls = { saved: [], selectRegion: [] };
    const drawn: PlotFrame = {
      ...frame,
      unit_errors: [{ axis: "y", expression: "zz", message: "zz is not a unit" }],
    };
    const { container } = renderPlot(spec({ axes: { x: axis(), y: axis({ unit: "zz" }) } }), env(calls, drawn));
    const note = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-testid="plot-unit-error"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(note.textContent).toContain("zz is not a unit");
    // The note names the axis it belongs to.
    expect(note.textContent).toContain("Y-axis unit");
    // The data and the traces are untouched: only the note is added.
    expect(container.querySelector(".plot-region")).not.toBeNull();
  });
});
