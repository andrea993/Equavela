// The Plotly adapter's pure part: what to draw for a plot specification and its calculated
// data. Nothing here touches the DOM or Plotly itself, so the
// rendering rules (SVG or WebGL, limits, palette, gaps, print reduction) are unit-tested.
// The spec stays library-independent; only this module and `PlotCanvas.tsx` know Plotly.

import { ptToPx } from "../layout/geometry";
import type { PlotAxis, PlotSpec } from "../equavelaApi";
import { usesRightAxis } from "./edit";
import type { AxisLimits, PlotFrame, TraceFrame } from "./frame";

/** SVG scatter up to this many points per trace; WebGL above it on screen. */
export const SVG_POINT_LIMIT = 100_000;
/** What a trace is reduced to for print, which always uses SVG. */
export const PRINT_POINT_LIMIT = 4_000;

/** The bundled, deterministic palette: colours follow the trace order. */
import { PALETTE } from "./palette";
export { PALETTE };

/** Stroke of a line trace: 1.5 pt. */
export const LINE_WIDTH_PT = 1.5;

/** Axis, grid, zero and tick lines: at least 1 pt, or the PDF prints them as faint hairlines. */
export const FRAME_WIDTH_PT = 1.05;

/** Space for the axis expressions and limits (left, bottom) and the tick labels, CSS px. */
export const MARGIN = { l: 104, r: 70, t: 14, b: 52 } as const;

/**
 * The left and right placeholder columns and the gap each leaves for its axis tick labels, CSS px
 *. The bases are the historic fixed widths; a measured expression wider than its base grows
 * the column and, with it, the margin.
 */
export const Y_COLUMN = { left: 6, width: MARGIN.l - 40, gap: 34 } as const;
export const Y2_COLUMN = { right: 4, width: MARGIN.r - 14, gap: 10 } as const;

/**
 * The right margin of a plot whose right y axis is unused: no right limits to place,
 * only the half of the last x tick label that overhangs the plot area, CSS px.
 */
export const NO_RIGHT_AXIS_MARGIN = 16;

/** The margins of a plot with no title, no unit, no measured column and no right axis, CSS px. */
export const BASE_MARGIN = { ...MARGIN, r: NO_RIGHT_AXIS_MARGIN } as const;

/** The plot area a plot keeps when its expressions would take all its room, CSS px. */
export const MIN_PLOT_AREA = 48;

/** The row of the x expressions and limits: one line high, taller only for a taller expression. */
export const X_ROW = { height: 22, max: 66 } as const;

/** Vertical layout metrics of the y placeholder column, matching `page.css`, CSS px. */
export const Y_SLOT_MIN_HEIGHT = 20;
export const Y_SAMPLE_HEIGHT = 3;
export const Y_STACK_GAP = 2;
/** Minimum breathing room kept between an expanded y column and the top/bottom edge of the region box, CSS px. */
export const Y_EDGE_PAD = 4;

/** Extra vertical room added above and below the plot area when a tall y stack extends past it. */
export type PlotVerticalExpansion = { overhang: number; top: number; bottom: number };

export const NO_VERTICAL_EXPANSION: PlotVerticalExpansion = { overhang: 0, top: 0, bottom: 0 };

/**
 * Room one title band takes, CSS px: one line of the label font at the fixed plot text size
 * . A band exists only while its fields hold text, so a plot without titles and
 * units keeps the margins above.
 */
export const TITLE_BAND = 18;

/** The margins of one plot: the base margins plus a band for each title that is drawn. */
export type PlotMargin = { l: number; r: number; t: number; b: number };

/** Whether a band is drawn for one axis: it holds text, or the axis carries a unit. */
const axisBand = (axis: { title?: string; unit?: string | null } | undefined): number =>
  axis && ((axis.title ?? "").trim() !== "" || (axis.unit ?? "").trim() !== "") ? TITLE_BAND : 0;

/** The four title bands of one plot, in CSS px: 0 when the band holds no text. */
export type PlotBands = { plot: number; x: number; y: number; y2: number };

/**
 * The measured room of the placeholders: the widths of the y columns, the height of the x row,
 * and the total height of the stacked y column (expressions, trace samples and y limits).
 */
export type PlotTextWidths = { y: number; y2: number; x: number; yHeight?: number };

/** No measured placeholder: every column keeps its base width. */
export const NO_TEXT_WIDTHS: PlotTextWidths = { y: 0, y2: 0, x: 0 };

/** The title bands of one plot: only the fields that hold text take room. */
export function plotBands(spec: PlotSpec): PlotBands {
  return {
    plot: (spec.title ?? "").trim() === "" ? 0 : TITLE_BAND,
    x: axisBand(spec.axes.x),
    y: axisBand(spec.axes.y),
    // The right y axis has its own title and unit: an unused or unset one draws no band.
    y2: usesRightAxis(spec) ? axisBand(spec.axes.y2) : 0,
  };
}

/**
 * The margins the drawing library leaves around one plot. They depend on the stored
 * specification and the bundled fonts only — never on what is selected, focused or being edited — so
 * the screen and the PDF lay the same plot out at the same size.
 */
export function plotMargin(
  spec: PlotSpec,
  widths: PlotTextWidths = NO_TEXT_WIDTHS,
  extraY: { top?: number; bottom?: number } = NO_VERTICAL_EXPANSION,
): PlotMargin {
  const bands = plotBands(spec);
  // the left column keeps the width its widest placeholder needs, and the plot area shifts
  // right by it; the right y limits do the same to the right margin.
  const y = Math.max(Y_COLUMN.width, widths.y);
  const y2 = Math.max(Y2_COLUMN.width, widths.y2);
  return {
    l: bands.y + Y_COLUMN.left + y + Y_COLUMN.gap,
    r: usesRightAxis(spec) ? bands.y2 + Y2_COLUMN.right + y2 + Y2_COLUMN.gap : NO_RIGHT_AXIS_MARGIN,
    t: MARGIN.t + bands.plot + (extraY.top ?? 0),
    // A two-line x expression (a fraction, a unit under a subscript) lowers the title band instead
    // of running over it: the margin grows by what the row needs beyond one line.
    b: MARGIN.b + bands.x + Math.max(0, widths.x - X_ROW.height) + (extraY.bottom ?? 0),
  };
}

/**
 * Extra vertical room (CSS px) added above and/or below the plot area when the stacked y
 * expressions are taller than the plot area. The y stack stays centred on the plot area and uses
 * existing top/bottom margin room first (since the y column sits left of the x axis and title),
 * only growing the region box past what already fits so no unused space is added below the plot.
 */
export function plotVerticalExpansion(
  spec: PlotSpec,
  baseHeightPx: number,
  widths: PlotTextWidths = NO_TEXT_WIDTHS,
): PlotVerticalExpansion {
  const needed = widths.yHeight ?? 0;
  if (needed <= 0) return NO_VERTICAL_EXPANSION;
  const base = plotMargin(spec, widths);
  const available = Math.max(0, baseHeightPx - base.t - base.b);
  if (needed <= available) return NO_VERTICAL_EXPANSION;
  const overhang = Math.ceil((needed - available) / 2);
  const top = Math.max(0, overhang - Math.max(0, base.t - Y_EDGE_PAD));
  const bottom = Math.max(0, overhang - Math.max(0, base.b - Y_EDGE_PAD));
  return { overhang, top, bottom };
}

/**
 * The measured widths limited so a plot keeps `MIN_PLOT_AREA` px of plot area: a region too
 * narrow for its expressions keeps the base columns and clips them, rather than letting a margin take
 * the whole plot. The left column is served first; a right row gets what is left.
 */
export function fitTextWidths(
  spec: PlotSpec,
  widthPx: number,
  widths: PlotTextWidths,
): PlotTextWidths {
  const bands = plotBands(spec);
  const right = usesRightAxis(spec);
  let room = Math.max(0, widthPx - (MARGIN.l + bands.y) - (right ? MARGIN.r + bands.y2 : NO_RIGHT_AXIS_MARGIN) - MIN_PLOT_AREA);
  const fit = (wanted: number, base: number): number => {
    const extra = Math.min(Math.max(0, wanted - base), room);
    room -= extra;
    return base + extra;
  };
  const y = fit(widths.y, Y_COLUMN.width);
  const x = Math.min(Math.max(widths.x, X_ROW.height), X_ROW.max);
  return {
    y,
    y2: right ? fit(widths.y2, Y2_COLUMN.width) : Y2_COLUMN.width,
    x,
    ...(widths.yHeight ? { yHeight: widths.yHeight } : {}),
  };
}

export type RenderMode = "svg" | "gl";

/** SVG or WebGL for one trace of `points` points (print is always SVG). */
export function renderMode(points: number, printing: boolean): RenderMode {
  return !printing && points > SVG_POINT_LIMIT ? "gl" : "svg";
}

/** Min/max-bucket reduction of a trace to at most about `limit` points, keeping order. */
export function reduceForPrint(x: Float64Array, y: Float64Array, limit = PRINT_POINT_LIMIT) {
  if (x.length <= limit) return { x, y };
  const buckets = Math.max(1, Math.floor(limit / 2));
  const size = Math.ceil(x.length / buckets);
  const outX: number[] = [];
  const outY: number[] = [];
  for (let start = 0; start < x.length; start += size) {
    const end = Math.min(start + size, x.length);
    let low = -1;
    let high = -1;
    let gap = false;
    for (let i = start; i < end; i++) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
        gap = true;
        continue;
      }
      if (low < 0 || y[i] < y[low]) low = i;
      if (high < 0 || y[i] > y[high]) high = i;
    }
    for (const i of [...new Set([low, high])].filter((i) => i >= 0).sort((a, b) => a - b)) {
      outX.push(x[i]);
      outY.push(y[i]);
    }
    if (gap) {
      outX.push(NaN);
      outY.push(NaN);
    }
  }
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) };
}

function extent(values: readonly Float64Array[]): [number, number] | null {
  let low = Infinity;
  let high = -Infinity;
  for (const array of values) {
    for (let i = 0; i < array.length; i++) {
      const v = array[i];
      if (Number.isFinite(v)) {
        if (v < low) low = v;
        if (v > high) high = v;
      }
    }
  }
  return low <= high ? [low, high] : null;
}

/**
 * The limits one axis draws with, from the calculated data: the number stored in the
 * worksheet or the value the session calculated for an expression limit, `null` for an automatic
 * end. The renderer never re-derives which limit to use: the calculation decided it.
 */
export function axisLimits(frame: PlotFrame | null, axis: "x" | "y" | "y2"): AxisLimits {
  const found = frame?.limits.find((limits) => limits.axis === axis);
  return { min: found?.min ?? null, max: found?.max ?? null };
}

/** Explicit limits; a single limit takes the other end from the data. `undefined` = autorange. */
export function axisRange(
  limits: AxisLimits,
  scale: PlotAxis["scale"],
  data: readonly Float64Array[],
): [number, number] | undefined {
  if (limits.min === null && limits.max === null) return undefined;
  const found = extent(data);
  const min = limits.min ?? found?.[0];
  const max = limits.max ?? found?.[1];
  if (min === undefined || max === undefined || !(min < max)) return undefined;
  if (scale === "log10") return min > 0 && max > 0 ? [Math.log10(min), Math.log10(max)] : undefined;
  return [min, max];
}

/** Whether an axis is drawn through the zero of the axis it crosses. */
export const crossesAtOrigin = (axis: PlotAxis | undefined): boolean => axis?.position === "origin";

/**
 * A drawn axis range, as the range the plot is actually showing: the ends in data units on a linear
 * axis and their base-10 exponents on a `log10` axis, which is how the drawing library reports it.
 */
export type AxisRange = [number, number];

/** The ranges one figure is drawn with, per axis. */
export type AxisRanges = { x?: AxisRange; y?: AxisRange; y2?: AxisRange };

/**
 * The paper fraction of zero on an axis drawn over `range`, clamped to the plot area: zero
 * is below a `log10` range, which has no zero at all, so it clamps to the low edge. A range that is
 * not a usable interval has no fraction and gives `0`.
 */
export function paperFraction(range: AxisRange | undefined, logarithmic: boolean): number {
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || !(range[0] < range[1])) return 0;
  const at = logarithmic ? Number.NEGATIVE_INFINITY : 0;
  const fraction = (at - range[0]) / (range[1] - range[0]);
  return Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
}

/**
 * The paper position of each axis that is drawn through the zero of the one it crosses:
 * the x axis through the zero of the left y axis and each y axis through the zero of the x axis.
 * An axis whose crossing range is not known yet, and an axis stored on the boundary, is left out:
 * the caller draws the figure once and reads the ranges it settled on before asking again.
 */
export function originPositions(
  spec: PlotSpec,
  ranges: AxisRanges,
): { xaxis?: number; yaxis?: number; yaxis2?: number } {
  // A polar plot has no numeric x or y axis to place (section 6).
  if (spec.type !== "xy") return {};
  const vertical = (axis: PlotAxis | undefined) =>
    axis && crossesAtOrigin(axis) && ranges.x
      ? paperFraction(ranges.x, spec.axes.x.scale === "log10")
      : undefined;
  const positions: { xaxis?: number; yaxis?: number; yaxis2?: number } = {};
  if (crossesAtOrigin(spec.axes.x) && ranges.y) {
    positions.xaxis = paperFraction(ranges.y, spec.axes.y.scale === "log10");
  }
  const y = vertical(spec.axes.y);
  if (y !== undefined) positions.yaxis = y;
  const y2 = vertical(spec.axes.y2);
  if (y2 !== undefined) positions.yaxis2 = y2;
  return positions;
}

const MODES = { line: "lines", markers: "markers", "line+markers": "lines+markers" } as const;
const DASHES = { solid: "solid", dash: "dash", dot: "dot", dashdot: "dashdot" } as const;

function traceStyle(spec: PlotSpec, traceId: string, index: number) {
  const trace = spec.traces.find((item) => item.id === traceId);
  const lineColor = trace?.line?.color ?? PALETTE[index % PALETTE.length];
  return {
    lineColor,
    lineStyle: trace?.line?.style ?? "solid",
    lineWidth: trace?.line?.width ?? LINE_WIDTH_PT,
    markerColor: trace?.marker?.color ?? lineColor,
    markerShape: trace?.marker?.shape ?? "circle",
    markerSize: trace?.marker?.size ?? 5,
  };
}

/** The line sample of a trace. */
export type TraceSample = { color: string; dash: keyof typeof DASHES };

/**
 * The colour and dash a trace is drawn in, for its samples: a marker-only trace shows its marker
 * colour with a solid line.
 */
export function traceSample(trace: PlotSpec["traces"][number], index: number): TraceSample {
  const lineColor = trace.line?.color ?? PALETTE[index % PALETTE.length];
  if (trace.presentation === "markers") return { color: trace.marker?.color ?? lineColor, dash: "solid" };
  return { color: lineColor, dash: trace.line?.style ?? "solid" };
}

/** One legend label: typeset math for a trace expression, literal text otherwise. */
export type LegendLabel = { kind: "math" | "text"; text: string };

/** One entry of a plot legend, in drawing order. */
export type LegendEntry = { traceId?: string; referenceLineId?: string; label: LegendLabel; color: string; dash?: string };

/**
 * The legend entries in trace order: the traces that are drawn and whose `show_in_legend`
 * is on. A label is typeset math when it is the trace's own y expression
 * ; a custom label and the trace-id fallback are literal text. A pending or
 * failed plot draws nothing, so it has no legend either.
 */
export function legendEntries(spec: PlotSpec, frame: PlotFrame | null): LegendEntry[] {
  const drawn = new Set(
    frame && frame.state !== "error" && frame.state !== "pending" ? frame.traces.map((trace) => trace.id) : [],
  );
  const entries: LegendEntry[] = [];
  spec.traces.forEach((trace, index) => {
    if (!drawn.has(trace.id) || trace.show_in_legend === false) return;
    const custom = trace.legend_label?.trim() ?? "";
    const expression = (spec.type === "contour" ? trace.z ?? "" : trace.y).trim();
    const label: LegendLabel =
      custom !== ""
        ? { kind: "text", text: custom }
        : expression === ""
          ? { kind: "text", text: trace.id }
          : { kind: "math", text: expression };
    // The sample shows the colour the trace is drawn in: a marker-only trace uses its marker colour.
    entries.push({ traceId: trace.id, label, color: traceSample(trace, index).color });
  });
  if (spec.type === "xy" && frame && frame.state !== "error" && frame.state !== "pending") {
    const resolved = new Set((frame.reference_lines ?? []).map((line) => line.id));
    for (const line of spec.reference_lines ?? []) {
      if (!line.show_in_legend || !resolved.has(line.id)) continue;
      const value = typeof line.value === "number" ? String(line.value) : line.value;
      const custom = line.legend_label?.trim() ?? "";
      entries.push({
        referenceLineId: line.id,
        label: custom ? { kind: "text", text: custom } : { kind: "math", text: `${line.axis} = ${value}` },
        color: line.line?.color ?? PALETTE[(spec.traces.length + entries.length) % PALETTE.length],
        dash: line.line?.style ?? "solid",
      });
    }
  }
  return entries;
}

const plotlyDash = (style: string | undefined): string => ({ dash: "dash", dot: "dot", dashdot: "dashdot" }[style ?? ""] ?? "solid");

/** Domain-relative shapes never participate in Plotly autorange; their fractions follow the shown range. */
export function referenceLineShapes(spec: PlotSpec, frame: PlotFrame | null, ranges: AxisRanges = {}): Record<string, unknown>[] {
  if (spec.type !== "xy" || !frame || frame.state === "error" || frame.state === "pending") return [];
  const resolved = new Map((frame.reference_lines ?? []).map((line) => [line.id, line]));
  const axisRangeFor = (axis: "x" | "y"): AxisRange | undefined => {
    const setting = spec.axes[axis];
    const values = frame.traces
      .filter((trace) => axis === "x" || spec.traces.find((item) => item.id === trace.id)?.y_axis !== "right")
      .map((trace) => trace[axis]);
    const stored = axisRange(axisLimits(frame, axis), setting.scale, values);
    if (ranges[axis]) return ranges[axis];
    if (stored) return stored;
    if (setting.scale === "log10") {
      const positive = values.map((array) => Float64Array.from([...array].filter((value) => value > 0), Math.log10));
      return extent(positive) ?? undefined;
    }
    return extent(values) ?? undefined;
  };
  const fraction = (axis: "x" | "y", value: number): number => {
    const range = axisRangeFor(axis);
    const scale = spec.axes[axis].scale;
    const coordinate = scale === "log10" ? (value > 0 ? Math.log10(value) : NaN) : value;
    if (!range || !Number.isFinite(coordinate) || !(range[0] < range[1])) return 0;
    return (coordinate - range[0]) / (range[1] - range[0]);
  };
  return (frame.reference_lines ?? []).flatMap((item) => {
    const line = spec.reference_lines?.find((candidate) => candidate.id === item.id);
    if (!line || !resolved.has(item.id)) return [];
    const color = line.line?.color ?? PALETTE[(spec.traces.length + (spec.reference_lines?.indexOf(line) ?? 0)) % PALETTE.length];
    const at = fraction(item.axis, item.value);
    return [{
      type: "line",
      ...(item.axis === "x"
        ? { xref: "x domain", yref: "paper", x0: at, x1: at, y0: 0, y1: 1 }
        : { xref: "paper", yref: "y domain", x0: 0, x1: 1, y0: at, y1: at }),
      line: { color, width: ptToPx(line.line?.width ?? 1.5), dash: plotlyDash(line.line?.style) },
      layer: "below",
    }];
  });
}

/**
 * One drawing-library trace and the worksheet trace it belongs to: a stem trace is its
 * segments plus its markers, so one worksheet trace is more than one library trace and a click has
 * to find its way back.
 */
export type PlotlyTrace = {
  /** The library layer the trace is drawn in, which a click looks into first to last. */
  layer: "scatterlayer" | "barlayer" | "contourlayer";
  traceId: string;
  data: Record<string, unknown>;
};

export type PlotlyFigure = {
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
  config: Record<string, unknown>;
  /** `owners[i]` is the worksheet trace `data[i]` draws. */
  owners: { layer: PlotlyTrace["layer"]; traceId: string }[];
};

/** The fraction of the smallest x step a bar leaves empty on each side. */
export const BAR_FILL = 0.8;

/**
 * The width of the bars of one trace: 0.8 of the smallest spacing between neighbouring x values,
 * in worksheet order. A trace whose points share one x value has no neighbouring spacing
 * and draws one data unit wide bars; the reference application's own width is unverified.
 */
export function barWidth(x: ArrayLike<number>): number {
  let step = Infinity;
  for (let i = 1; i < x.length; i++) {
    const previous = x[i - 1];
    const current = x[i];
    if (!Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const gap = Math.abs(current - previous);
    if (gap > 0 && gap < step) step = gap;
  }
  return BAR_FILL * (Number.isFinite(step) ? step : 1);
}

/**
 * The y a stem and a bar start from: 0 on a linear axis; on a log10 axis, where there is
 * no zero, the bottom of the visible range — the lower limit the calculation resolved, or
 * the smallest positive value drawn on that axis. `values` are the y arrays of the traces drawn
 * against the axis.
 */
export function traceBase(
  frame: PlotFrame | null,
  axis: "y" | "y2",
  scale: PlotAxis["scale"],
  values: readonly Float64Array[],
): number {
  if (scale !== "log10") return 0;
  const range = axisRange(axisLimits(frame, axis), scale, values);
  if (range) return 10 ** range[0];
  let low = Infinity;
  for (const array of values) {
    for (let i = 0; i < array.length; i++) {
      const value = array[i];
      if (Number.isFinite(value) && value > 0 && value < low) low = value;
    }
  }
  return Number.isFinite(low) ? low : 1;
}

/**
 * The drawing-library traces of one plot: a line trace is one of them, a stem trace its
 * segments and, when it draws markers, a second one for the markers on top, a bar trace its bars
 * and the same markers. Print and the screen use this one builder, so what renders is the same in
 * both.
 */
export function plotlyTraces(
  spec: PlotSpec,
  frame: PlotFrame | null,
  printing: boolean,
  selectedTraceId: string | null = null,
): PlotlyTrace[] {
  const traces: TraceFrame[] = frame && frame.state !== "error" && frame.state !== "pending" ? frame.traces : [];
  const onAxis = (which: "y" | "y2") =>
    traces
      .filter((trace) => {
        const assignment = spec.traces.find((item) => item.id === trace.id)?.y_axis;
        return which === "y2" ? assignment === "right" : assignment !== "right";
      })
      .map((trace) => trace.y);
  return traces.flatMap((trace, index) => {
    const traceSpec = spec.traces.find((item) => item.id === trace.id);
    const presentation = traceSpec?.presentation ?? "line";
    const assignment = traceSpec?.y_axis === "right" ? "y2" : "y";
    // The trace type is an XY drawing rule: a polar plot draws the presentation.
    const kind: NonNullable<PlotSpec["traces"][number]["type"]> =
      spec.type === "polar" ? "lines" : (traceSpec?.type ?? "lines");
    const mode = spec.type === "polar" ? "svg" : renderMode(trace.x.length, printing);
    const reduced = printing && spec.type !== "contour" ? reduceForPrint(trace.x, trace.y) : trace;
    const style = traceStyle(spec, trace.id, index);
    // The trace selection is screen-only: print always uses the normal style.
    const selected = !printing && selectedTraceId === trace.id;
    const lineWidth = ptToPx(selected ? style.lineWidth + 1.5 : style.lineWidth);
    const markerSize = selected ? style.markerSize + 3 : style.markerSize;
    // The presentation of : which parts of the trace are drawn, whatever its type.
    const drawsLine = presentation !== "markers";
    const drawsMarkers = presentation !== "line";
    const yaxis = spec.type === "xy" ? { yaxis: assignment } : {};
    const line = { color: style.lineColor, width: lineWidth, dash: DASHES[style.lineStyle] };
    const marker = { color: style.markerColor, size: markerSize, symbol: style.markerShape };
    const points = { x: reduced.x, y: reduced.y };
    const scatter = mode === "gl" ? "scattergl" : "scatter";
    // Markers drawn on top of a stem or a bar are the same trace, so they select it too.
    const markers = (): PlotlyTrace => ({
      layer: "scatterlayer",
      traceId: trace.id,
      data: { type: scatter, mode: "markers", ...points, ...yaxis, marker, hoverinfo: "skip" },
    });
    if (spec.type === "contour") {
      // An explicit-grid contour: z is column-major with `rows` = length(y) and `cols` =
      // length(x); a non-finite entry is a hole. Screen and print draw the same complete grid.
      const grid = trace.z;
      const z = grid
        ? Array.from({ length: grid.rows }, (_, row) =>
            Array.from({ length: grid.cols }, (_, col) => {
              const value = grid.values[row + col * grid.rows];
              return Number.isFinite(value) ? value : null;
            }),
          )
        : [];
      return [
        {
          layer: "contourlayer",
          traceId: trace.id,
          data: {
            type: "contour",
            x: trace.x,
            y: trace.y,
            z,
            contours: { coloring: "lines" },
            colorscale: [[0, style.lineColor], [1, style.lineColor]],
            showscale: false,
            connectgaps: false,
            line,
            hoverinfo: "skip",
          },
        },
      ];
    }
    if (spec.type === "polar") {
      return [
        {
          layer: "scatterlayer",
          traceId: trace.id,
          data: {
            type: "scatterpolar",
            mode: MODES[presentation],
            theta: reduced.x,
            r: reduced.y,
            thetaunit: "radians",
            connectgaps: false,
            line,
            marker,
            hoverinfo: "skip",
          },
        },
      ];
    }
    if (kind === "stems") {
      const base = traceBase(frame, assignment, spec.axes[assignment]?.scale ?? "linear", onAxis(assignment));
      const out: PlotlyTrace[] = [];
      if (drawsLine) {
        // One polyline of vertical segments with a gap between them: the stems never join up.
        const xs: (number | null)[] = [];
        const ys: (number | null)[] = [];
        for (let i = 0; i < reduced.x.length; i++) {
          const x = reduced.x[i];
          const y = reduced.y[i];
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          xs.push(x, x, null);
          ys.push(base, y, null);
        }
        out.push({
          layer: "scatterlayer",
          traceId: trace.id,
          data: {
            type: scatter,
            mode: "lines",
            x: xs,
            y: ys,
            ...yaxis,
            connectgaps: false,
            line,
            hoverinfo: "skip",
          },
        });
      }
      if (drawsMarkers || !drawsLine) out.push(markers());
      return out;
    }
    if (kind === "bars") {
      const base = traceBase(frame, assignment, spec.axes[assignment]?.scale ?? "linear", onAxis(assignment));
      return [
        {
          layer: "barlayer",
          traceId: trace.id,
          data: {
            type: "bar",
            ...points,
            ...yaxis,
            width: barWidth(reduced.x),
            base,
            orientation: "v",
            // One colour per trace: the bars are filled in the line colour.
            marker: {
              color: style.lineColor,
              // The selection is screen-only: a bar has no stroke to thicken, so the
              // selected trace's bars take an outline in the frame colour instead.
              ...(selected ? { line: { color: "#1d2330", width: ptToPx(1.5) } } : {}),
            },
            hoverinfo: "skip",
          },
        },
        ...(drawsMarkers ? [markers()] : []),
      ];
    }
    return [
      {
        layer: "scatterlayer",
        traceId: trace.id,
        data: {
          type: scatter,
          mode: MODES[presentation],
          ...points,
          ...yaxis,
          connectgaps: false,
          // A step line runs horizontally to the next x and then vertically to its y.
          line: kind === "steps" ? { ...line, shape: "hv" } : line,
          marker,
          hoverinfo: "skip",
        },
      },
    ];
  });
}

/**
 * Plain, deterministic Plotly configuration for a plot: same input, same figure.
 *
 * `ranges` are the ranges the plot is drawn with, as the previous draw left them: a stored
 * limit gives them, an automatic range only exists after a draw, so `PlotCanvas` passes what it read
 * from the last one and corrects the crossing once the new draw has settled.
 */
export function buildFigure(
  spec: PlotSpec,
  frame: PlotFrame | null,
  size: { width: number; height: number },
  printing: boolean,
  selectedTraceId: string | null = null,
  ranges: AxisRanges = {},
  textWidths: PlotTextWidths = NO_TEXT_WIDTHS,
  extraY: { top?: number; bottom?: number } = NO_VERTICAL_EXPANSION,
): PlotlyFigure {
  const traces: TraceFrame[] = frame && frame.state !== "error" && frame.state !== "pending" ? frame.traces : [];
  const drawn = plotlyTraces(spec, frame, printing, selectedTraceId);
  const data = drawn.map((entry) => entry.data);
  /** The settings of one axis: the right y axis is its own once a trace uses it. */
  const settingsOf = (which: "x" | "y" | "y2") =>
    which === "y2" ? spec.axes.y2 ?? spec.axes.y : spec.axes[which];
  /** The calculated traces one axis draws. */
  const tracesOf = (which: "x" | "y" | "y2") => {
    if (which === "x") return traces;
    return traces.filter((trace) => {
      const assignment = spec.traces.find((item) => item.id === trace.id)?.y_axis;
      return which === "y2" ? assignment === "right" : assignment !== "right";
    });
  };
  /** The range an axis draws with because its limits are stored; `undefined` is autorange. */
  const storedRange = (which: "x" | "y" | "y2") => {
    const settings = settingsOf(which);
    return axisRange(axisLimits(frame, which), settings.scale, tracesOf(which).map((t) => t[which === "y2" ? "y" : which]));
  };
  /**
   * The range an axis is showing: the stored limits, else the range the last draw settled
   * on. Only the crossing of an origin axis reads it; `range` in the layout below stays the stored
   * one, so an automatic axis keeps autoscaling.
   */
  const shownRange = (which: "x" | "y" | "y2") => storedRange(which) ?? ranges[which];
  /** Whether the plot keeps its plot-area frame: only when no axis crosses at the origin. */
  const framed = ![spec.axes.x, spec.axes.y, spec.axes.y2].some((settings) => crossesAtOrigin(settings));
  const axis = (which: "x" | "y" | "y2") => {
    const settings = settingsOf(which);
    const range = storedRange(which);
    // an origin axis is drawn through the zero of the axis it crosses — the x axis through
    // the zero of the left y axis, each y axis through the zero of the x axis — with the range that
    // axis is showing, clamped to the plot area. Its line already is the other axis' zero line, so
    // that zero line and the mirrored plot frame are both left off: nothing is drawn twice.
    const crossed = which === "x" ? spec.axes.y : spec.axes.x;
    const origin = crossesAtOrigin(settings);
    const position = origin ? paperFraction(shownRange(which === "x" ? "y" : "x"), crossed.scale === "log10") : undefined;
    return {
      type: settings.scale === "log10" ? "log" : "linear",
      ...(range ? { range, autorange: false } : { autorange: true }),
      // A boundary axis keeps the frame and the zero line it had; an origin axis draws the line
      // once, where it crosses, with its ticks and tick labels along it, and no mirrored copy on
      // the far side of the plot area.
      // A plot with any origin axis has no frame at all: a boundary axis then draws only its
      // own line, so no lone mirrored line is left on the far edge.
      ...(origin ? { anchor: "free", position, showline: true, mirror: false } : framed ? { mirror: true } : { showline: true, mirror: false }),
      ...(settings.scale === "log10" ? { dtick: spec.grid_spacing ?? 1 } : spec.grid_spacing != null ? { dtick: spec.grid_spacing } : {}),
      // No `title`: the axis title is drawn by the app, so the library draws none.
      showgrid: settings.show_grid !== false,
      zeroline: !crossesAtOrigin(crossed),
      ticks: "outside",
      showticklabels: true,
      automargin: false,
      linecolor: "#4a5160",
      gridcolor: "#e3e6ec",
      zerolinecolor: "#9aa1b0",
      linewidth: ptToPx(FRAME_WIDTH_PT),
      gridwidth: ptToPx(FRAME_WIDTH_PT),
      zerolinewidth: ptToPx(FRAME_WIDTH_PT),
      tickwidth: ptToPx(FRAME_WIDTH_PT),
    };
  };
  return {
    data,
    // Which worksheet trace each library trace draws, for the click that selects it.
    owners: drawn.map(({ layer, traceId }) => ({ layer, traceId })),
    layout: {
      width: size.width,
      height: size.height,
      margin: plotMargin(spec, textWidths, extraY),
      paper_bgcolor: "#ffffff",
      plot_bgcolor: "#ffffff",
      // The legend is drawn by the app as typeset math: the library's own legend shows
      // plain text labels and a click on it would toggle the trace.
      showlegend: false,
      shapes: referenceLineShapes(spec, frame, ranges),
      font: { family: "Noto Sans, sans-serif", size: 11, color: "#1d2330" },
      // Plotly preserves user-driven axis ranges across react() calls (including region resizes
      // and the screen/print transition) while this key stays stable. Print uses the same view.
      // The resolved limits are part of it: a limit that changes value re-ranges the axis even
      // when the expression text did not change.
      uirevision: JSON.stringify([spec.axes, frame?.limits ?? []]),
      dragmode: "zoom",
      ...(spec.type === "polar"
        ? {
            polar: {
              angularaxis: { thetaunit: "radians", direction: "counterclockwise", rotation: 0, showgrid: true },
              radialaxis: { showgrid: true, ticks: "outside", showticklabels: true },
            },
          }
        : { xaxis: axis("x"), yaxis: axis("y") }),
      ...(spec.type === "xy" && spec.traces.some((trace) => trace.y_axis === "right")
        ? {
            yaxis2: {
              ...axis("y2"),
              overlaying: "y",
              side: "right",
              // The right y axis keeps its own side of the plot area unless the plot
              // stores it at the origin, which is the crossing gives it.
              ...(crossesAtOrigin(spec.axes.y2) ? {} : { anchor: "free", position: 1 }),
            },
          }
        : {}),
    },
    config: {
      staticPlot: printing,
      displayModeBar: !printing,
      displaylogo: false,
      responsive: false,
      // The wheel belongs to the page: a scroll gesture over a plot scrolls the document, never
      // zooms the plot. Zoom stays on drag-to-zoom and the mode bar.
      scrollZoom: false,
      modeBarButtonsToAdd: ["zoom2d", "pan2d", "resetScale2d"],
    },
  };
}
