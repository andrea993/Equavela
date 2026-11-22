import { describe, expect, it } from "vitest";
import {
  barWidth,
  buildFigure,
  axisLimits,
  axisRange,
  fitTextWidths,
  legendEntries,
  plotlyTraces,
  traceBase,
  MARGIN,
  plotBands,
  plotMargin,
  reduceForPrint,
  renderMode,
  SVG_POINT_LIMIT,
  PALETTE,
  TITLE_BAND,
  Y2_COLUMN,
  X_ROW,
  type PlotTextWidths,
  Y_COLUMN,
  BASE_MARGIN,
  NO_RIGHT_AXIS_MARGIN,
} from "./adapter";
import { decodePlotFrame, encodePlotFrame, makeTrace, type PlotFrame } from "./frame";
import { limitText, nextTraceId, parseLimit, removeTrace, sharedX, withNewTrace } from "./PlotView";
import { setLimit } from "./edit";
import { EMPTY_X_MESSAGE, mockPlotFrame } from "../mock/mockBackend";
import type { PlotSpec } from "../equavelaApi";

const axis = { scale: "linear" as const, unit: null, min: null, max: null, show_grid: true, title: "" };
const spec = (): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [360, 220],
  axes: { x: { ...axis }, y: { ...axis } },
  traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line" }],
});
const frame = (
  traces = [makeTrace("trace-1", [0, 1, 2], [0, 1, 4])],
  limits: PlotFrame["limits"] = [],
): PlotFrame => ({
  region_id: "p",
  state: "ready",
  error: null,
  implicit_x: false,
  traces,
  limits,
  limit_errors: [],
  units: [],
  unit_errors: [],
});

describe("trace types: lines, stems, bars and steps", () => {
  const kind = (type: NonNullable<PlotSpec["traces"][number]["type"]>) => {
    const plot = spec();
    plot.traces[0] = { ...plot.traces[0], type };
    return plot;
  };
  const drawn = (plot: PlotSpec, printing = false, f: PlotFrame = frame()) =>
    buildFigure(plot, f, { width: 480, height: 293 }, printing);
  const x = (data: Record<string, unknown>) => Array.from(data.x as ArrayLike<number | null>);

  it("draws a trace with no type as one line trace, with no step shape", () => {
    const figure = drawn(spec());
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].type).toBe("scatter");
    expect(figure.data[0].mode).toBe("lines");
    expect(figure.data[0].line).not.toHaveProperty("shape");
    expect(figure.owners).toEqual([{ layer: "scatterlayer", traceId: "trace-1" }]);
  });

  it("draws a stem trace as a segment from zero to each point, plus a markers trace", () => {
    const plot = kind("stems");
    plot.traces[0].presentation = "line+markers";
    plot.traces[0].line = { style: "dash", width: 2, color: "#123ABC" };
    plot.traces[0].marker = { shape: "diamond", size: 9, color: "#ABCDEF" };
    const figure = drawn(plot);
    expect(figure.data).toHaveLength(2);
    // The segments never join two points: each one is a vertical pair and a gap.
    expect(x(figure.data[0])).toEqual([0, 0, null, 1, 1, null, 2, 2, null]);
    expect(Array.from(figure.data[0].y as ArrayLike<number | null>)).toEqual([0, 0, null, 0, 1, null, 0, 4, null]);
    expect(figure.data[0].mode).toBe("lines");
    expect(figure.data[0].line).toMatchObject({ color: "#123ABC", dash: "dash", width: 2 * 4 / 3 });
    // The markers are the trace's own, on top of the stems.
    expect(figure.data[1].mode).toBe("markers");
    expect(figure.data[1].marker).toMatchObject({ color: "#ABCDEF", size: 9, symbol: "diamond" });
    expect(x(figure.data[1])).toEqual([0, 1, 2]);
    // Both belong to the one worksheet trace, so a click on either selects it.
    expect(figure.owners).toEqual([
      { layer: "scatterlayer", traceId: "trace-1" },
      { layer: "scatterlayer", traceId: "trace-1" },
    ]);
  });

  it("draws a marker-only stem trace as the markers at the tops of the stems, with no segment", () => {
    // the reference application's `line-style="None"` with a symbol.
    const plot = kind("stems");
    plot.traces[0].presentation = "markers";
    const figure = drawn(plot);
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].mode).toBe("markers");
    expect(x(figure.data[0])).toEqual([0, 1, 2]);
  });

  it("draws a line-only stem trace as the segments, with no markers", () => {
    const figure = drawn(kind("stems"));
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].mode).toBe("lines");
  });

  it("starts a stem at the bottom of a logarithmic y axis, which has no zero", () => {
    const plot = kind("stems");
    plot.axes.y.scale = "log10";
    const data = frame([makeTrace("trace-1", [0, 1, 2], [1, 10, 100])], [{ axis: "y", min: 1, max: 100 }]);
    // The calculation resolved the limits; the lower one is log10(1) = 0, so the base is 1.
    const segments = drawn(plot, false, data).data[0];
    expect(Array.from(segments.y as ArrayLike<number | null>)).toEqual([1, 1, null, 1, 10, null, 1, 100, null]);
    // With no limit, the bottom is the smallest positive value the trace draws.
    expect(traceBase(data, "y", "log10", [Float64Array.from([1, 10, 100])])).toBe(1);
    // A linear axis starts at 0, whatever its limits are.
    expect(traceBase(data, "y", "linear", [Float64Array.from([1, 10, 100])])).toBe(0);
  });

  it("draws a bar trace as filled bars 0.8 of the smallest x step wide", () => {
    const plot = kind("bars");
    plot.traces[0].line = { color: "#123ABC" };
    const f = frame([makeTrace("trace-1", [0, 2, 5], [1, 4, 9])]);
    const figure = drawn(plot, false, f);
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].type).toBe("bar");
    expect(figure.data[0].width).toBeCloseTo(0.8 * 2);
    expect(figure.data[0].base).toBe(0);
    expect(figure.data[0].marker).toEqual({ color: "#123ABC" });
    expect(figure.owners).toEqual([{ layer: "barlayer", traceId: "trace-1" }]);
    // A bar trace with markers draws them on top of the bars.
    plot.traces[0].presentation = "line+markers";
    const withMarkers = drawn(plot, false, f);
    expect(withMarkers.data.map((trace) => trace.type ?? "scatter")).toEqual(["bar", "scatter"]);
    expect(withMarkers.data[1].mode).toBe("markers");
    expect(withMarkers.owners.map((owner) => owner.layer)).toEqual(["barlayer", "scatterlayer"]);
  });

  it("measures the bars from the neighbouring x values, in worksheet order", () => {
    expect(barWidth([0, 2, 5])).toBeCloseTo(1.6);
    // Closest neighbours in worksheet order: 5 and 2 are one step, so the 3 between 0 and 5 loses.
    expect(barWidth([0, 5, 2])).toBeCloseTo(0.8 * 3, 5);
    // A gap of is not a neighbour of anything.
    expect(barWidth([0, NaN, 5, 6])).toBeCloseTo(0.8);
    // One point, or several at the same x, has no neighbouring spacing: one data unit.
    expect(barWidth([3])).toBeCloseTo(0.8);
    expect(barWidth([3, 3])).toBeCloseTo(0.8);
  });

  it("draws a step trace as a horizontal-then-vertical line through the points", () => {
    const plot = kind("steps");
    plot.traces[0].presentation = "line+markers";
    const figure = drawn(plot);
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].mode).toBe("lines+markers");
    expect(figure.data[0].line).toMatchObject({ shape: "hv" });
    expect(x(figure.data[0])).toEqual([0, 1, 2]);
  });

  it("draws every type the same on screen and in print (WYSIWYG)", () => {
    for (const type of ["lines", "stems", "bars", "steps"] as const) {
      const plot = kind(type);
      plot.traces[0].presentation = "line+markers";
      expect(drawn(plot, true).data).toEqual(drawn(plot).data);
    }
  });

  it("draws the presentation in a polar plot whatever the stored type", () => {
    const plot = kind("bars");
    plot.type = "polar";
    const figure = drawn(plot);
    expect(figure.data).toHaveLength(1);
    expect(figure.data[0].type).toBe("scatterpolar");
    expect(figure.data[0].mode).toBe("lines");
  });

  it("lets a click on a second trace find it through the owners, past a two-trace stem trace", () => {
    const plot = spec();
    plot.traces[0] = { ...plot.traces[0], type: "stems", presentation: "line+markers" };
    plot.traces.push({ id: "trace-2", x: "x", y: "g(x)", presentation: "line" });
    const f = frame([makeTrace("trace-1", [0, 1], [1, 2]), makeTrace("trace-2", [0, 1], [2, 1])]);
    const figure = drawn(plot, false, f);
    expect(figure.owners).toEqual([
      { layer: "scatterlayer", traceId: "trace-1" },
      { layer: "scatterlayer", traceId: "trace-1" },
      { layer: "scatterlayer", traceId: "trace-2" },
    ]);
    expect(plotlyTraces(plot, f, false).map((entry) => entry.traceId)).toEqual([
      "trace-1",
      "trace-1",
      "trace-2",
    ]);
  });
});

describe("fixed XY reference lines", () => {
  it("draws data-anchored lines across the paper area, with styles and legend entries, on screen and print", () => {
    const plot = spec();
    plot.reference_lines = [
      { id: "reference-1", axis: "x", value: 2, line: { color: "#123456", style: "dash", width: 2 }, show_in_legend: true },
      { id: "reference-2", axis: "y", value: "π", line: { color: "#654321", style: "dot" } },
    ];
    const calculated = {
      ...frame(),
      reference_lines: [{ id: "reference-1", axis: "x" as const, value: 2 }, { id: "reference-2", axis: "y" as const, value: Math.PI }],
    };
    const decoded = decodePlotFrame(encodePlotFrame(calculated));
    for (const printing of [false, true]) {
      const shapes = (buildFigure(plot, decoded, { width: 480, height: 293 }, printing).layout.shapes as Record<string, unknown>[]);
      expect(shapes).toEqual([
        expect.objectContaining({ type: "line", xref: "x domain", yref: "paper", x0: 1, x1: 1, y0: 0, y1: 1, layer: "below", line: { color: "#123456", width: expect.any(Number), dash: "dash" } }),
        expect.objectContaining({ type: "line", xref: "paper", yref: "y domain", x0: 0, x1: 1, y0: Math.PI / 4, y1: Math.PI / 4, line: { color: "#654321", width: expect.any(Number), dash: "dot" } }),
      ]);
    }
    expect(legendEntries(plot, decoded).filter((entry) => entry.referenceLineId).map((entry) => entry.label))
      .toEqual([{ kind: "math", text: "x = 2" }]);
    const zoomedShapes = buildFigure(plot, decoded, { width: 480, height: 293 }, false, null, { x: [1, 3], y: [1, 5] }).layout.shapes as Record<string, unknown>[];
    expect(zoomedShapes[0]).toMatchObject({ xref: "x domain", x0: 0.5, x1: 0.5 });
    expect(zoomedShapes[1]).toMatchObject({ yref: "y domain", y0: (Math.PI - 1) / 4, y1: (Math.PI - 1) / 4 });
  });
});

describe("the margins of a plot with titles", () => {
  const titled = (): PlotSpec => {
    const plot = spec();
    plot.title = "Climb rate";
    plot.axes.x = { ...axis, title: "Time", unit: "s" };
    plot.axes.y = { ...axis, title: "Speed", unit: "m/s" };
    return plot;
  };
  const margin = (plot: PlotSpec, printing = false) =>
    (buildFigure(plot, frame(), { width: 480, height: 293 }, printing).layout as { margin: Record<string, number> }).margin;

  it("keeps the base margins while no field holds text", () => {
    expect(plotBands(spec())).toEqual({ plot: 0, x: 0, y: 0, y2: 0 });
    expect(margin(spec())).toEqual(BASE_MARGIN);
  });

  it("gives each title that holds text its own band, and the drawing library keeps that margin", () => {
    const plot = titled();
    expect(plotMargin(plot)).toEqual({
      l: MARGIN.l + TITLE_BAND,
      r: NO_RIGHT_AXIS_MARGIN,
      t: MARGIN.t + TITLE_BAND,
      b: MARGIN.b + TITLE_BAND,
    });
    // The plot area — and with it every tick and the curve — is inside the bands.
    expect(margin(plot)).toEqual(plotMargin(plot));
    // A whitespace-only title draws nothing, so it takes no room either.
    const blank = spec();
    blank.title = "   ";
    expect(margin(blank)).toEqual(BASE_MARGIN);
  });

  it("draws the same plot area on screen and in print (WYSIWYG)", () => {
    expect(margin(titled(), true)).toEqual(margin(titled()));
  });
});

describe("the measured placeholder columns", () => {
  const margin = (plot: PlotSpec, widths?: PlotTextWidths, printing = false) =>
    (
      buildFigure(plot, frame(), { width: 480, height: 293 }, printing, null, {}, widths).layout as {
        margin: Record<string, number>;
      }
    ).margin;

  it("keeps the base columns and margins while nothing is measured", () => {
    expect(plotMargin(spec())).toEqual(BASE_MARGIN);
    expect(plotMargin(spec(), { y: 0, y2: 0, x: 0 })).toEqual(BASE_MARGIN);
    expect(margin(spec())).toEqual(BASE_MARGIN);
  });

  it("shifts the plot area right by the widest y expression, keeping the tick-label gap", () => {
    const widths = { y: 240, y2: 0, x: 0 };
    // The column starts 6 px into the margin, keeps 34 px for the tick labels, and the plot area
    // follows it: the expression is not clipped, the plot is narrower and starts further right.
    expect(plotMargin(spec(), widths).l).toBe(Y_COLUMN.left + widths.y + Y_COLUMN.gap);
    expect(margin(spec(), widths).l).toBe(plotMargin(spec(), widths).l);
    // A short expression never narrows the base column.
    expect(plotMargin(spec(), { y: 12, y2: 0, x: 0 })).toEqual(BASE_MARGIN);
  });

  it("shifts the plot area left by a wide right y limit", () => {
    const right = spec();
    right.traces[0].y_axis = "right";
    const widths = { y: 0, y2: 120, x: 0 };
    expect(plotMargin(right, widths).r).toBe(Y2_COLUMN.right + widths.y2 + Y2_COLUMN.gap);
    expect(margin(right, widths).r).toBe(plotMargin(right, widths).r);
    expect(plotMargin(right, { y: 0, y2: 10, x: 0 })).toEqual(MARGIN);
  });

  it("keeps no right margin for an unused right axis, only room for the last tick label", () => {
    expect(plotMargin(spec()).r).toBe(NO_RIGHT_AXIS_MARGIN);
    expect(plotMargin(spec(), { y: 0, y2: 120, x: 0 }).r).toBe(NO_RIGHT_AXIS_MARGIN);
    expect(margin(spec()).r).toBe(NO_RIGHT_AXIS_MARGIN);
    const right = spec();
    right.traces[0].y_axis = "right";
    expect(plotMargin(right).r).toBe(MARGIN.r);
  });

  it("keeps a title band outside the measured column", () => {
    const plot = spec();
    plot.axes.y = { ...axis, title: "Speed" };
    const widths = { y: 240, y2: 0, x: 0 };
    expect(plotMargin(plot, widths)).toEqual({
      ...plotMargin(spec(), widths),
      l: plotMargin(spec(), widths).l + TITLE_BAND,
    });
  });

  it("lowers the x title band by what a tall x expression needs beyond one line", () => {
    const plot = spec();
    plot.axes.x = { ...axis, title: "Frequency" };
    const oneLine = plotMargin(plot, { y: 0, y2: 0, x: X_ROW.height });
    // A fraction under the axis is two lines high: the bottom margin grows by the difference.
    expect(plotMargin(plot, { y: 0, y2: 0, x: 40 }).b).toBe(oneLine.b + 40 - X_ROW.height);
    // A one-line expression keeps the base margin, and the measured height is kept within a cap.
    expect(plotMargin(plot, { y: 0, y2: 0, x: 12 }).b).toBe(oneLine.b);
    expect(fitTextWidths(plot, 480, { y: 0, y2: 0, x: 500 }).x).toBe(X_ROW.max);
  });

  it("limits a column so the plot area keeps its minimum size (a too narrow region clips)", () => {
    const plot = spec();
    plot.traces[0].y_axis = "right";
    expect(fitTextWidths(plot, 480, { y: 1000, y2: 1000, x: 0 })).toEqual({
      // 480 - the base left and right margins - the minimum plot area is all the room the columns get.
      y: 480 - MARGIN.l - MARGIN.r - 48 + Y_COLUMN.width,
      y2: 70 - 14,
      x: X_ROW.height,
    });
    // An unused right axis takes only its small margin, and the left column gets the rest.
    expect(fitTextWidths(spec(), 480, { y: 1000, y2: 1000, x: 0 }).y).toBe(480 - MARGIN.l - NO_RIGHT_AXIS_MARGIN - 48 + Y_COLUMN.width);
    // A roomy region fits both columns in full.
    expect(fitTextWidths(plot, 1000, { y: 240, y2: 120, x: 0 })).toEqual({ y: 240, y2: 120, x: X_ROW.height });
    // The left column is served first.
    const tight = fitTextWidths(plot, 300, { y: 400, y2: 400, x: 0 });
    expect(tight.y).toBeGreaterThan(Y_COLUMN.width);
    expect(tight.y2).toBe(Y2_COLUMN.width);
  });

  it("lays the same plot area out on screen and in print with the measured widths (WYSIWYG)", () => {
    expect(margin(spec(), { y: 240, y2: 120, x: 0 }, true)).toEqual(margin(spec(), { y: 240, y2: 120, x: 0 }));
  });
});

describe("plot frame", () => {
  it("round-trips Float64 buffers and keeps NaN gaps", () => {
    const decoded = decodePlotFrame(encodePlotFrame(frame([makeTrace("t", [1, 2, 3], [4, NaN, Infinity])])));
    expect(Array.from(decoded.traces[0].x)).toEqual([1, 2, 3]);
    expect(Number.isNaN(decoded.traces[0].y[1])).toBe(true);
    expect(decoded.traces[0].finite).toBe(1);
  });
  it("draws axis, grid, zero and tick lines at least 1 pt wide so the PDF does not print hairlines", () => {
    const layout = buildFigure(spec(), frame(), { width: 480, height: 293 }, true).layout as {
      xaxis: Record<string, number>;
      yaxis: Record<string, number>;
    };
    for (const axis of [layout.xaxis, layout.yaxis]) {
      for (const key of ["linewidth", "gridwidth", "zerolinewidth", "tickwidth"]) {
        expect(axis[key]).toBeGreaterThanOrEqual(4 / 3 - 1e-9);
      }
    }
  });
  it("rejects truncated frames", () => {
    const bytes = encodePlotFrame(frame());
    expect(() => decodePlotFrame(bytes.slice(0, bytes.length - 1))).toThrow();
    expect(() => decodePlotFrame(bytes.slice(0, 2))).toThrow();
  });
});

describe("plot adapter", () => {
  it("renders polar traces from radian theta and radius vectors", () => {
    const s = spec();
    s.type = "polar";
    const figure = buildFigure(s, frame(), { width: 480, height: 293 }, false);
    expect(figure.data[0]).toMatchObject({ type: "scatterpolar", mode: "lines", thetaunit: "radians" });
    expect(Array.from(figure.data[0].theta as Float64Array)).toEqual([0, 1, 2]);
    expect(Array.from(figure.data[0].r as Float64Array)).toEqual([0, 1, 4]);
    expect(figure.data[0]).not.toHaveProperty("x");
    expect(figure.layout.polar).toMatchObject({
      angularaxis: { thetaunit: "radians", direction: "counterclockwise", rotation: 0 },
    });
  });
  it("uses SVG up to the limit and WebGL above it on screen, SVG for print", () => {
    expect(renderMode(SVG_POINT_LIMIT, false)).toBe("svg");
    expect(renderMode(SVG_POINT_LIMIT + 1, false)).toBe("gl");
    expect(renderMode(SVG_POINT_LIMIT + 1, true)).toBe("svg");
  });
  it("enables interactive zoom and preserves its UI revision through resize and print", () => {
    const s = spec();
    const screen = buildFigure(s, frame(), { width: 480, height: 293 }, false);
    const resized = buildFigure(s, frame(), { width: 600, height: 400 }, false);
    const printed = buildFigure(s, frame(), { width: 480, height: 293 }, true);
    expect(screen.layout).toMatchObject({ dragmode: "zoom" });
    expect(screen.config).toMatchObject({ staticPlot: false, displayModeBar: true, scrollZoom: false });
    expect(screen.config.modeBarButtonsToAdd).toEqual(["zoom2d", "pan2d", "resetScale2d"]);
    expect(resized.layout.uirevision).toBe(screen.layout.uirevision);
    expect(printed.layout.uirevision).toBe(screen.layout.uirevision);
    expect(printed.config).toMatchObject({ staticPlot: true, displayModeBar: false, scrollZoom: false });
    // A navigation resamples the trace over the visible interval with the same
    // specification and limits: the redraw must keep the zoom the user chose.
    const resampled = buildFigure(s, frame([makeTrace("trace-1", [-15, 5], [1, 2])]), { width: 480, height: 293 }, false);
    expect(resampled.layout.uirevision).toBe(screen.layout.uirevision);
    s.axes.x.min = 0;
    expect(buildFigure(s, frame(), { width: 600, height: 400 }, false).layout.uirevision).not.toBe(screen.layout.uirevision);
  });
  it("reduces long traces by min/max buckets, keeping spikes and order", () => {
    const n = 20000;
    const x = Float64Array.from({ length: n }, (_, i) => i);
    const y = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50));
    y[777] = 9;
    const reduced = reduceForPrint(x, y, 1000);
    expect(reduced.x.length).toBeLessThanOrEqual(1010);
    expect(reduced.y).toContain(9);
    expect(reduced.x.every((v, i, a) => i === 0 || v > a[i - 1])).toBe(true);
  });
  it("assigns traces to an independent right y axis for screen and print", () => {
    const s = spec();
    s.axes.y.min = -2;
    s.axes.y.max = 2;
    s.axes.y2 = { ...axis, scale: "log10", min: 1, max: 100, show_grid: false };
    s.traces[0].y_axis = "right";
    // The limits to draw with come from the calculation, not from the specification.
    const f = frame([makeTrace("trace-1", [0, 1], [1, 10])], [
      { axis: "x", min: null, max: null },
      { axis: "y", min: -2, max: 2 },
      { axis: "y2", min: 1, max: 100 },
    ]);
    for (const printing of [false, true]) {
      const figure = buildFigure(s, f, { width: 480, height: 293 }, printing);
      expect(figure.data[0].yaxis).toBe("y2");
      expect(figure.layout.yaxis).toMatchObject({ range: [-2, 2], type: "linear" });
      expect(figure.layout.yaxis2).toMatchObject({ range: [0, 2], type: "log", side: "right" });
    }
  });

  it("builds a deterministic figure with palette colours, gaps and explicit limits", () => {
    const s = spec();
    s.axes.x.min = 0;
    s.axes.x.max = 10;
    s.axes.y.scale = "log10";
    s.axes.y.min = 1;
    s.axes.y.max = 100;
    const f = frame(
      [makeTrace("trace-1", [0, 1, 2], [1, NaN, 4]), makeTrace("trace-2", [0, 1], [1, 2])],
      [
        { axis: "x", min: 0, max: 10 },
        { axis: "y", min: 1, max: 100 },
        { axis: "y2", min: null, max: null },
      ],
    );
    const figure = buildFigure(s, f, { width: 480, height: 293 }, false);
    expect(figure.data).toHaveLength(2);
    expect((figure.data[0].line as { color: string }).color).toBe(PALETTE[0]);
    expect((figure.data[1].line as { color: string }).color).toBe(PALETTE[1]);
    expect(figure.data[0].mode).toBe("lines");
    expect((figure.layout.xaxis as { range: number[] }).range).toEqual([0, 10]);
    expect((figure.layout.yaxis as { range: number[]; type: string; dtick: number }).range).toEqual([0, 2]);
    expect((figure.layout.yaxis as { dtick: number }).dtick).toBe(1);
    expect(JSON.stringify(buildFigure(s, f, { width: 480, height: 293 }, false))).toBe(JSON.stringify(figure));
  });
  it("labels legend entries with the trace expressions in trace order, as math, and never toggles a trace from the legend", () => {
    const s = spec();
    s.traces.push({ ...s.traces[0], id: "trace-2", y: "g(x)" });
    s.traces.push({ ...s.traces[0], id: "trace-3", y: "   " });
    const f = frame([
      makeTrace("trace-1", [0, 1], [0, 1]),
      makeTrace("trace-2", [0, 1], [1, 2]),
      makeTrace("trace-3", [0, 1], [2, 3]),
    ]);
    expect(legendEntries(s, f).map((entry) => entry.label)).toEqual([
      { kind: "math", text: "f(x)" },
      { kind: "math", text: "g(x)" },
      { kind: "text", text: "trace-3" },
    ]);
    s.traces[1].legend_label = "measured response";
    s.traces[2].legend_label = "   ";
    expect(legendEntries(s, f).map((entry) => entry.label)).toEqual([
      { kind: "math", text: "f(x)" },
      { kind: "text", text: "measured response" },
      { kind: "text", text: "trace-3" },
    ]);
    expect(legendEntries(s, f).map((entry) => entry.traceId)).toEqual(["trace-1", "trace-2", "trace-3"]);
    expect(legendEntries(s, f).map((entry) => entry.color)).toEqual([PALETTE[0], PALETTE[1], PALETTE[2]]);
    // The sample follows the colour the trace is drawn in: a custom line colour, or a marker-only
    // trace's marker colour.
    s.traces[0].line = { color: "#123ABC" };
    s.traces[1].presentation = "markers";
    s.traces[1].marker = { color: "#ABCDEF" };
    expect(legendEntries(s, f).map((entry) => entry.color).slice(0, 2)).toEqual(["#123ABC", "#ABCDEF"]);
    for (const printing of [false, true]) {
      const figure = buildFigure(s, f, { width: 480, height: 293 }, printing);
      // The app draws the legend, so the drawing library is asked for none: its own labels
      // are plain text and a click on them would hide the trace.
      expect(figure.data.map((trace) => trace.showlegend)).toEqual([undefined, undefined, undefined]);
      expect(figure.layout).toMatchObject({ showlegend: false });
      expect(figure.layout).not.toHaveProperty("legend");
    }
  });
  it("lists an entry only for a drawn trace whose Show in legend is on", () => {
    const s = spec();
    s.traces.push({ ...s.traces[0], id: "trace-2", y: "g(x)", show_in_legend: false });
    const f = frame([makeTrace("trace-1", [0, 1], [0, 1]), makeTrace("trace-2", [0, 1], [1, 2])]);
    expect(legendEntries(s, f).map((entry) => entry.traceId)).toEqual(["trace-1"]);
    // Hiding an entry never hides the trace itself.
    expect(buildFigure(s, f, { width: 480, height: 293 }, false).data).toHaveLength(2);
    s.traces[0].show_in_legend = false;
    expect(legendEntries(s, f)).toEqual([]);
    s.traces[0].show_in_legend = true;
    // Nothing is drawn while the plot is pending or failed, so there is nothing to label.
    expect(
      legendEntries(s, {
        region_id: "p",
        state: "pending",
        error: null,
        implicit_x: false,
        traces: [],
        limits: [],
        limit_errors: [],
        units: [],
        unit_errors: [],
      }),
    ).toEqual([]);
    expect(legendEntries(s, { ...f, state: "error" })).toEqual([]);
  });
  it("preserves per-trace line and marker styles in screen and print output", () => {
    const s = spec();
    s.traces[0] = {
      ...s.traces[0],
      presentation: "line+markers",
      line: { style: "dashdot", width: 2, color: "#123ABC" },
      marker: { shape: "diamond", size: 9, color: "#ABCDEF" },
    };
    for (const printing of [false, true]) {
      const trace = buildFigure(s, frame(), { width: 480, height: 293 }, printing).data[0];
      expect(trace.line).toMatchObject({ color: "#123ABC", dash: "dashdot", width: 2 * 4 / 3 });
      expect(trace.marker).toMatchObject({ color: "#ABCDEF", size: 9, symbol: "diamond" });
    }
  });
  it("draws the selected trace with a stronger screen-only style and never in print", () => {
    const s = spec();
    s.traces.push({ id: "trace-2", x: "x", y: "f(x)", presentation: "line" });
    const f = frame([makeTrace("trace-1", [0, 1], [0, 1]), makeTrace("trace-2", [0, 1], [1, 2])]);
    const screen = buildFigure(s, f, { width: 480, height: 293 }, false, "trace-2");
    const normal = (buildFigure(s, f, { width: 480, height: 293 }, false).data[1].line as { width: number }).width;
    const selected = (screen.data[1].line as { width: number }).width;
    expect(selected).toBeGreaterThan(normal);
    expect((screen.data[1].marker as { size: number }).size).toBe(8);
    const printed = buildFigure(s, f, { width: 480, height: 293 }, true, "trace-2");
    expect((printed.data[1].line as { width: number }).width).toBe(normal);
    expect((printed.data[1].marker as { size: number }).size).toBe(5);
  });
  it("draws nothing while pending or failed, and one limit takes the other from the data", () => {
    const pending: PlotFrame = {
      region_id: "p",
      state: "pending",
      error: null,
      implicit_x: false,
      traces: [],
      limits: [],
      limit_errors: [],
      units: [],
      unit_errors: [],
    };
    expect(buildFigure(spec(), pending, { width: 1, height: 1 }, false).data).toEqual([]);
    expect(axisRange({ min: 1, max: null }, "linear", [Float64Array.of(0, 5)])).toEqual([1, 5]);
    expect(axisRange({ min: -1, max: 5 }, "log10", [])).toBeUndefined();
    expect(axisRange({ min: null, max: null }, "linear", [])).toBeUndefined();
  });
  it("draws with the limits the calculation resolved, expression limits included", () => {
    const s = spec();
    // The specification stores an expression; the value it draws with is the calculated one.
    s.axes.x.min = "-π/ω_0";
    const f = frame([makeTrace("trace-1", [0, 1, 2], [0, 1, 4])], [{ axis: "x", min: -2.5, max: null }]);
    expect(axisLimits(f, "x")).toEqual({ min: -2.5, max: null });
    const layout = buildFigure(s, f, { width: 480, height: 293 }, false).layout as { xaxis: { range: number[] } };
    expect(layout.xaxis.range).toEqual([-2.5, 2]);
    // A failed limit leaves the end automatic, and a plot without data has no limits at all.
    expect(axisLimits(frame(undefined, [{ axis: "x", min: null, max: null }]), "x")).toEqual({ min: null, max: null });
    expect(axisLimits(null, "x")).toEqual({ min: null, max: null });
  });
  it("applies a chosen grid spacing to every visible axis and uses automatic ticks when cleared", () => {
    const s = spec();
    s.axes.y2 = { ...axis };
    s.traces[0].y_axis = "right";
    s.grid_spacing = 2;
    const layout = buildFigure(s, frame(), { width: 480, height: 293 }, false).layout as {
      xaxis: { dtick: number };
      yaxis: { dtick: number };
      yaxis2: { dtick: number };
    };
    expect(layout.xaxis.dtick).toBe(2);
    expect(layout.yaxis.dtick).toBe(2);
    expect(layout.yaxis2.dtick).toBe(2);
    s.grid_spacing = null;
    const automatic = buildFigure(s, frame(), { width: 480, height: 293 }, false).layout as { xaxis: { dtick?: number } };
    expect(automatic.xaxis.dtick).toBeUndefined();
  });
  it("turns the grid off from the stored plot property", () => {
    const s = spec();
    s.axes.x.show_grid = false;
    s.axes.y.show_grid = false;
    const layout = buildFigure(s, frame(), { width: 480, height: 293 }, false).layout as {
      xaxis: { showgrid: boolean };
      yaxis: { showgrid: boolean };
    };
    expect(layout.xaxis.showgrid).toBe(false);
    expect(layout.yaxis.showgrid).toBe(false);
  });
});

describe("plot editing helpers", () => {
  it("adds traces with stable unique ids", () => {
    const s = withNewTrace(withNewTrace(spec()));
    expect(s.traces.map((t) => t.id)).toEqual(["trace-1", "trace-2", "trace-3"]);
    expect(nextTraceId({ ...s, traces: s.traces.slice(1) })).toBe("trace-4");
  });
  it("keeps one shared x expression only while every trace has the same x", () => {
    const s = withNewTrace(spec());
    expect(sharedX(s)).toBe("x");
    s.traces[1].x = "";
    expect(sharedX(s)).toBeNull();
    s.traces[0].x = "";
    expect(sharedX(s)).toBe("");
    s.traces[0].x = "a";
    s.traces[1].x = "b";
    expect(sharedX(s)).toBeNull();
  });
  it("removes the selected trace and never the last one", () => {
    const two = withNewTrace(spec());
    expect(removeTrace(two, "trace-1")?.traces.map((t) => t.id)).toEqual(["trace-2"]);
    expect(removeTrace(two, "trace-2")?.traces.map((t) => t.id)).toEqual(["trace-1"]);
    expect(removeTrace(two, "missing")).toBeNull();
    expect(removeTrace(spec(), "trace-1")).toBeNull();
  });
  it("the traces after a removed one keep the colours they were drawn with", () => {
    const three = withNewTrace(withNewTrace(spec()));
    // Before: blue, orange-red and green by position. After removing the first, the second stays orange-red
    // and the third green: the colour is written into the trace, since the position changed.
    const rest = removeTrace(three, "trace-1")!;
    expect(rest.traces.map((t) => t.line?.color)).toEqual(["#c8461c", "#2a8a3a"]);
    // A trace with a colour of its own keeps it, and the ones before the removed trace are not touched.
    const own = { ...three, traces: three.traces.map((t, i) => (i === 1 ? { ...t, line: { color: "#123456" } } : t)) };
    const without = removeTrace(own, "trace-3")!;
    expect(without.traces[0].line).toBeUndefined();
    expect(without.traces[1].line?.color).toBe("#123456");
    // The last trace removed leaves the others as they were, with no colour written.
    expect(removeTrace(three, "trace-3")!.traces.map((t) => t.line)).toEqual([undefined, undefined]);
  });
  it("parses axis limits into a number or an expression", () => {
    expect(parseLimit("")).toBeNull();
    expect(parseLimit("-1.5e2")).toBe(-150);
    expect(parseLimit("−2")).toBe(-2);
    // Anything else is the expression the session calculates; it keeps its math text.
    expect(parseLimit("abc")).toBe("abc");
    expect(parseLimit("-π/ω_0")).toBe("-π/ω_0");
    expect(parseLimit(" 2t ")).toBe("2t");
    expect(limitText(null)).toBe("");
    expect(limitText(3)).toBe("3");
    expect(limitText("-π/ω_0")).toBe("-π/ω_0");
  });
  it("stores a limit expression as math text and only orders two numbers", () => {
    const s = spec();
    const expression = setLimit(s, "x", "max", "-π/ω_0")!;
    expect(expression.axes.x.max).toBe("-π/ω_0");
    expect(limitText(expression.axes.x.max)).toBe("-π/ω_0");
    // An empty box is an automatic end again.
    expect(setLimit(expression, "x", "max", "")!.axes.x.max).toBeNull();
    // Two numbers are ordered here; an expression is checked by the calculation instead.
    const withMinimum = { ...s, axes: { ...s.axes, x: { ...s.axes.x, min: 5 } } };
    expect(setLimit(withMinimum, "x", "max", "3")).toBeNull();
    expect(setLimit(withMinimum, "x", "max", "L/2")?.axes.x.max).toBe("L/2");
    // A number typed into a box stays a number.
    expect(setLimit(s, "y", "min", "2.5")!.axes.y.min).toBe(2.5);
  });
  it("the mock evaluates a limit expression and reports one it cannot read", () => {
    const s = spec();
    s.axes.y.max = "2*pi";
    const ready = mockPlotFrame("p", s, "ready");
    expect(ready.limits.find((limits) => limits.axis === "y")?.max).toBeCloseTo(2 * Math.PI);
    expect(ready.limit_errors).toEqual([]);
    // An expression the toy evaluator cannot read is a limit failure, never a made-up value.
    s.axes.y.max = "L/2";
    const broken = mockPlotFrame("p", s, "ready");
    expect(broken.limits.find((limits) => limits.axis === "y")?.max).toBeNull();
    expect(broken.limit_errors).toEqual([
      { axis: "y", bound: "max", expression: "L/2", message: "the expression could not be calculated" },
    ]);
    // A number is carried as it is, and nothing is reported while the plot is pending.
    s.axes.y.max = 4;
    expect(mockPlotFrame("p", s, "ready").limits.find((limits) => limits.axis === "y")?.max).toBe(4);
    s.axes.y.max = "L/2";
    expect(mockPlotFrame("p", s, "pending").limit_errors).toEqual([]);
  });
  it("the mock calculates the data the real session would send", () => {
    const s = spec();
    s.traces[0].x = "0..3";
    s.traces[0].y = "x^2";
    const ready = mockPlotFrame("p", s, "ready");
    expect(Array.from(ready.traces[0].y)).toEqual([0, 1, 4, 9]);
    expect(mockPlotFrame("p", s, "pending").traces).toEqual([]);
  });
  it("the mock samples an undefined x axis from -10 to 10 or the selected x limits", () => {
    const s = spec();
    s.traces[0].x = "t";
    s.traces[0].y = "sin(t)";
    const ready = mockPlotFrame("p", s, "ready");
    expect(ready.traces[0].x[0]).toBe(-10);
    expect(ready.traces[0].x[ready.traces[0].x.length - 1]).toBe(10);
    expect(ready.traces[0].y[ready.traces[0].y.length - 1]).toBeCloseTo(Math.sin(10));
    s.axes.x.min = 0;
    s.axes.x.max = 2;
    const selected = mockPlotFrame("p", s, "ready");
    expect(selected.traces[0].x[0]).toBe(0);
    expect(selected.traces[0].x[selected.traces[0].x.length - 1]).toBe(2);
  });
  it("the mock reports a y expression with an empty x slot instead of drawing a line", () => {
    // decision: `x` in the y slot of a new plot drew `y = x` before an x axis was chosen.
    const s = spec();
    s.traces[0].x = "";
    s.traces[0].y = "x";
    const frame = mockPlotFrame("p", s, "ready");
    expect(frame.state).toBe("error");
    expect(frame.traces).toEqual([]);
    expect(frame.error).toEqual({ trace: "trace-1", axis: "x", expression: "", message: EMPTY_X_MESSAGE });
    // A new plot, with both placeholders empty, is pending and shows no error.
    s.traces[0].y = "";
    const blank = mockPlotFrame("p", s, "ready");
    expect(blank.state).toBe("pending");
    expect(blank.error).toBeNull();
  });
  it("the mock treats an x slot naming x as the plot variable (the core trace_x rule)", () => {
    const s = spec();
    s.traces[0].x = "x";
    s.traces[0].y = "3x";
    const ready = mockPlotFrame("p", s, "ready");
    expect(ready.traces[0].x[0]).toBe(-10);
    expect(ready.traces[0].x[ready.traces[0].x.length - 1]).toBe(10);
    expect(ready.traces[0].y[0]).toBeCloseTo(-30);
  });
  it("the mock samples x exactly like any other variable name", () => {
    // `x` is a name like any other: the sampled axis and the y values are identical for every
    // name, so `y = name` draws y = x whatever the name is.
    const names = ["x", "t", "tt", "xx", "θ", "ψ", "t_1"];
    const frames = names.map((name) => {
      const s = spec();
      s.traces[0].x = name;
      s.traces[0].y = name;
      return mockPlotFrame("p", s, "ready");
    });
    const reference = frames[0];
    expect(reference.state).toBe("ready");
    expect(Array.from(reference.traces[0].x)).toEqual(Array.from(frames[1].traces[0].x));
    expect(reference.traces[0].x[0]).toBe(-10);
    expect(reference.traces[0].x[reference.traces[0].x.length - 1]).toBe(10);
    expect(reference.traces[0].y[0]).toBe(-10);
    expect(reference.traces[0].y[reference.traces[0].y.length - 1]).toBe(10);
    for (const [index, name] of names.slice(1).entries()) {
      expect(Array.from(frames[index + 1].traces[0].y), name).toEqual(Array.from(reference.traces[0].y));
      expect(frames[index + 1].state, name).toBe(reference.state);
    }
    // The sampled name inside a longer expression, a Greek name included.
    const s = spec();
    s.traces[0].x = "ψ";
    s.traces[0].y = "3ψ";
    expect(mockPlotFrame("p", s, "ready").traces[0].y[0]).toBeCloseTo(-30);
  });
  it("the mock does not invent a sine for a y expression it cannot read", () => {
    // The old toy evaluator knew only `x` and fell back to `Math.sin(x)` for everything else,
    // so a constant or an undefined name drew a sine. Now a value is a value and an unknown
    // name is a gap, exactly for every name.
    const constant = spec();
    constant.traces[0].x = "x";
    constant.traces[0].y = "5";
    expect(mockPlotFrame("p", constant, "ready").traces[0].y[0]).toBe(5);
    const undefined = spec();
    undefined.traces[0].x = "x";
    undefined.traces[0].y = "sin(t)";
    const gaps = mockPlotFrame("p", undefined, "ready").traces[0];
    expect(gaps.finite).toBe(0);
    expect(Array.from(gaps.y).every((value) => Number.isNaN(value))).toBe(true);
  });
});

describe("axis limits are fixed when typed and automatic when cleared", () => {
  it("a typed limit is a number and an emptied box is null (automatic)", () => {
    expect(parseLimit("2.5")).toBe(2.5);
    expect(parseLimit("  ")).toBeNull();
  });
});

it("draws the asymmetric contour golden grid identically on screen and in print", () => {
  const s = spec();
  s.type = "contour";
  s.traces[0].z = "zs";
  const t = { ...makeTrace("trace-1", [0, 2, 5], [0, 4]),
    z: { rows: 2, cols: 3, values: Float64Array.from([1, 10, 2, 20, 3, 30]), dimension: [] } };
  const f = decodePlotFrame(encodePlotFrame(frame([t])));
  const screen = buildFigure(s, f, { width: 480, height: 293 }, false);
  const print = buildFigure(s, f, { width: 480, height: 293 }, true);
  expect(screen.data[0]).toMatchObject({ type: "contour", z: [[1, 2, 3], [10, 20, 30]], connectgaps: false });
  expect(print.data).toEqual(screen.data);
  expect(print.layout).toEqual(screen.layout);
});

it("renders the asymmetric contour golden in the same orientation on screen and print", () => {
  const s = spec();
  s.type = "contour";
  s.traces[0] = { ...s.traces[0], x: "[1, 3, 7]", y: "[10, 20]", z: "Z" };
  const t = { ...makeTrace("trace-1", [1, 3, 7], [10, 20]),
    z: { rows: 2, cols: 3, values: Float64Array.from([11, 21, 12, 22, 13, 23]), dimension: [] } };
  const f = decodePlotFrame(encodePlotFrame(frame([t])));
  const screen = buildFigure(s, f, { width: 480, height: 293 }, false);
  const print = buildFigure(s, f, { width: 480, height: 293 }, true);
  expect(screen.data[0].type).toBe("contour");
  expect(screen.data[0].z).toEqual([[11, 12, 13], [21, 22, 23]]);
  expect(screen.data).toEqual(print.data);
  expect(legendEntries(s, f)[0].label).toEqual({ kind: "math", text: "Z" });
});

it("rejects malformed contour shapes and renders non-finite z as holes", () => {
  const t = { ...makeTrace("trace-1", [1, 3, 7], [10, 20]),
    z: { rows: 2, cols: 3, values: Float64Array.from([11, 21, NaN, 22, 13, 23]), dimension: [] } };
  const s = { ...spec(), type: "contour" as const };
  const figure = buildFigure(s, frame([t]), { width: 480, height: 293 }, false);
  expect(figure.data[0].z).toEqual([[11, null, 13], [21, 22, 23]]);
  expect(figure.data[0].connectgaps).toBe(false);
  t.z.rows = 3;
  expect(() => decodePlotFrame(encodePlotFrame(frame([t])))).toThrow("contour grid shape");
});
