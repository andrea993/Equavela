// Pure edits of a plot specification. The plot region (typed placeholders) and the Plot tab of the
// ribbon both change a plot through these functions, so a change made in
// either place has exactly the same effect. Each returns the new specification; the caller stores
// it (one undo step).

import type { AxisLimit, PlotAxis, PlotSpec } from "../equavelaApi";
import { defaultTraceColor } from "./palette";

export type PlotTraceSpec = PlotSpec["traces"][number];

/** The id of a new reference line: the smallest `reference-N` not in use. */
export function nextReferenceLineId(spec: PlotSpec): string {
  const used = new Set((spec.reference_lines ?? []).map((line) => line.id));
  let n = (spec.reference_lines ?? []).length + 1;
  while (used.has(`reference-${n}`)) n++;
  return `reference-${n}`;
}

/** Adds an empty fixed line on the requested axis, with a stable palette colour. */
export function withNewReferenceLine(spec: PlotSpec, axis: "x" | "y"): PlotSpec {
  const lines = spec.reference_lines ?? [];
  const index = lines.length;
  return {
    ...spec,
    reference_lines: [...lines, {
      id: nextReferenceLineId(spec), axis, value: 0, line: { color: defaultTraceColor(index) },
      show_in_legend: false,
    }],
  };
}

/** Updates one stored reference line. */
export function setReferenceLine(
  spec: PlotSpec,
  id: string,
  patch: Partial<NonNullable<PlotSpec["reference_lines"]>[number]>,
): PlotSpec {
  return { ...spec, reference_lines: (spec.reference_lines ?? []).map((line) => line.id === id ? { ...line, ...patch } : line) };
}

/** Removes one stored reference line. */
export function removeReferenceLine(spec: PlotSpec, id: string): PlotSpec {
  return { ...spec, reference_lines: (spec.reference_lines ?? []).filter((line) => line.id !== id) };
}

/** The id of a new trace: the smallest `trace-N` not in use. */
export function nextTraceId(spec: PlotSpec): string {
  const used = new Set(spec.traces.map((trace) => trace.id));
  let n = spec.traces.length + 1;
  while (used.has(`trace-${n}`)) n++;
  return `trace-${n}`;
}

/**
 * The x-axis expression shared by every trace. An empty string is a shared undefined x-axis.
 * Null means several traces use different x expressions, so the UI shows one slot per trace.
 */
export function sharedX(spec: PlotSpec): string | null {
  const first = spec.traces[0]?.x ?? "";
  return spec.traces.every((trace) => trace.x === first) ? first : null;
}

/**
 * The specification with one more (empty) trace; the new trace reuses the shared x if any and is
 * hidden from the legend.
 */
export function withNewTrace(spec: PlotSpec): PlotSpec {
  const x = sharedX(spec) ?? "";
  return { ...spec, traces: [...spec.traces, { id: nextTraceId(spec), x, y: "", y_axis: "left", presentation: "line", show_in_legend: false }] };
}

/**
 * The specification with the selected trace removed. Null when the trace id is not
 * in the plot, or when it is the last trace: a plot keeps at least one trace. The traces after it keep their
 * colours.
 */
export function removeTrace(spec: PlotSpec, traceId: string): PlotSpec | null {
  if (spec.traces.length <= 1 || !spec.traces.some((trace) => trace.id === traceId)) return null;
  const removed = spec.traces.findIndex((trace) => trace.id === traceId);
  // A trace with no colour of its own is drawn with the palette colour of its position, so taking a
  // trace away would repaint every trace after it: they keep the colour they had by writing it down.
  const traces = spec.traces.flatMap((trace, index) => {
    if (index === removed) return [];
    if (index < removed || trace.line?.color) return [trace];
    return [{ ...trace, line: { ...trace.line, color: defaultTraceColor(index) } }];
  });
  return { ...spec, traces };
}

/**
 * An axis limit from its edited text: `null` for an empty box (automatic), a number when
 * the text is one, otherwise the expression the session calculates. The text of an expression is
 * what the math editor committed (canonical linear math), so it is stored as it is.
 */
export function parseLimit(text: string): AxisLimit | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const numeric = trimmed.replace(/[−]/g, "-");
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(numeric)) {
    const value = Number(numeric);
    if (Number.isFinite(value)) return value;
  }
  return trimmed;
}

/** The same limit as the text of its placeholder: the number, or the stored expression. */
export const limitText = (value: AxisLimit | null): string => (value === null ? "" : String(value));

/** Whether two ends of one axis can be compared here: only two numbers are ordered at edit time. */
const orderedEnds = (value: AxisLimit | null, other: AxisLimit | null, which: "min" | "max"): boolean =>
  typeof value !== "number" || typeof other !== "number" || (which === "min" ? value < other : value > other);

/** The right y axis, or its defaults while no trace has used it yet. */
export const rightAxis = (spec: PlotSpec): PlotAxis =>
  spec.axes.y2 ?? { ...spec.axes.y, min: null, max: null, title: "" };

/**
 * An axis with nothing set. The right y axis starts here: its scale, limits, title and unit
 * are its own and never come from the left axis, so writing its title cannot copy a unit.
 */
export const blankAxis = (): PlotAxis => ({
  scale: "linear",
  unit: null,
  min: null,
  max: null,
  show_grid: true,
  title: "",
});

/** Whether any trace is drawn against the right y axis. */
export const usesRightAxis = (spec: PlotSpec): boolean => spec.traces.some((trace) => trace.y_axis === "right");

/** A trace's x or y expression. An x edit that leaves one defined x makes it the shared x axis. */
export function setTraceExpression(spec: PlotSpec, index: number, axis: "x" | "y" | "z", text: string): PlotSpec {
  let traces = spec.traces.map((trace, i) => (i === index ? { ...trace, [axis]: text } : trace));
  if (axis === "x") {
    const defined = traces.filter((trace) => trace.x.trim() !== "").map((trace) => trace.x);
    if (defined.length === 1) traces = traces.map((trace) => ({ ...trace, x: defined[0] }));
  }
  return { ...spec, traces };
}

/** The x expression of every trace. */
export const setSharedX = (spec: PlotSpec, text: string): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace) => ({ ...trace, x: text })),
});

/** Moves one trace to the left or the right y axis. */
export const setYAxis = (spec: PlotSpec, index: number, y_axis: "left" | "right"): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => (i === index ? { ...trace, y_axis } : trace)),
});

/** Sets whether a trace contributes a legend entry. */
export const setTraceLegendVisibility = (spec: PlotSpec, index: number, show_in_legend: boolean): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => (i === index ? { ...trace, show_in_legend } : trace)),
});

/** Sets a trace's literal legend label; an empty label uses the expression fallback. */
export const setTraceLegendLabel = (spec: PlotSpec, index: number, legend_label: string): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => (i === index ? { ...trace, legend_label } : trace)),
});

/** One field of a trace's line or marker style. */
export const setTraceStyle = (
  spec: PlotSpec,
  index: number,
  style: "line" | "marker",
  key: string,
  value: string | number | null,
): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => (i !== index ? trace : { ...trace, [style]: { ...trace[style], [key]: value } })),
});

/**
 * What one trace draws at each point, or of every trace when `index` is null. It
 * is independent of the presentation: `lines` with markers keeps its markers.
 */
export const setTraceKind = (
  spec: PlotSpec,
  index: number | null,
  kind: NonNullable<PlotTraceSpec["type"]>,
): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => {
    if (index !== null && i !== index) return trace;
    const next: PlotTraceSpec = { ...trace, type: kind };
    // `lines` is the default and is not stored: returning to it drops the field.
    if (kind === "lines") delete next.type;
    return next;
  }),
});

/** The presentation (lines, markers, both) of one trace, or of every trace when `index` is null. */
export const setPresentation = (
  spec: PlotSpec,
  index: number | null,
  presentation: PlotTraceSpec["presentation"],
): PlotSpec => ({
  ...spec,
  traces: spec.traces.map((trace, i) => (index === null || i === index ? { ...trace, presentation } : trace)),
});

/**
 * The limit typed on the x axis or the left y axis; null when the two ends are
 * numbers and the text is not on the right side of the other one. An expression cannot be compared
 * here: the calculation reports an unordered pair on the plot.
 */
export function setLimit(spec: PlotSpec, axis: "x" | "y", which: "min" | "max", text: string): PlotSpec | null {
  const value = parseLimit(text);
  const other = spec.axes[axis][which === "min" ? "max" : "min"];
  if (!orderedEnds(value, other, which)) return null;
  return { ...spec, axes: { ...spec.axes, [axis]: { ...spec.axes[axis], [which]: value } } };
}

/** The limit typed on the right y axis; null when two numbers are not ordered. */
export function setY2Limit(spec: PlotSpec, which: "min" | "max", text: string): PlotSpec | null {
  const value = parseLimit(text);
  const axis = rightAxis(spec);
  const other = axis[which === "min" ? "max" : "min"];
  if (!orderedEnds(value, other, which)) return null;
  return { ...spec, axes: { ...spec.axes, y2: { ...axis, [which]: value } } };
}

/** Toggles the logarithmic scale of the right y axis. */
export function toggleY2Scale(spec: PlotSpec): PlotSpec {
  const axis = rightAxis(spec);
  return { ...spec, axes: { ...spec.axes, y2: { ...axis, scale: axis.scale === "log10" ? "linear" : "log10" } } };
}

/** The grid spacing shared by the axes: a positive number, or null for automatic ticks. */
export const setGridSpacing = (spec: PlotSpec, spacing: number | null): PlotSpec => ({ ...spec, grid_spacing: spacing });

/** The three numeric axes of a plot. */
export type PlotAxisName = "x" | "y" | "y2";

/** The axes whose titles and units the plot draws: the right y axis only while a trace uses it. */
export const shownAxes = (spec: PlotSpec): PlotAxisName[] =>
  usesRightAxis(spec) ? ["x", "y", "y2"] : ["x", "y"];

/** The title or unit text of one axis; an absent right axis has none of its own. */
export const axisOf = (spec: PlotSpec, axis: PlotAxisName): PlotAxis =>
  axis === "y2" ? (spec.axes.y2 ?? blankAxis()) : spec.axes[axis];

/**
 * The plot title: literal text drawn above the plot area, one line. An empty title
 * removes the field, so a file written before it reads the same and a new plot stores nothing.
 */
export const setPlotTitle = (spec: PlotSpec, title: string): PlotSpec => ({ ...spec, title: oneLine(title) });

/** One axis title; an empty title removes it. */
export const setAxisTitle = (spec: PlotSpec, axis: PlotAxisName, title: string): PlotSpec =>
  setAxis(spec, axis, { title: oneLine(title) });

/** One axis display unit; an empty unit returns the axis to the SI base display. */
export const setAxisUnit = (spec: PlotSpec, axis: PlotAxisName, unit: string): PlotSpec => {
  const text = unit.trim();
  return setAxis(spec, axis, { unit: text === "" ? null : text });
};

/** A title is drawn on one line: a line break typed into the field becomes a space. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/**
 * The right y axis as an edit starts it, while no trace has used it: the scale and the grid of the
 * left axis, which is what an unset right axis is drawn with, and its own limits, title
 * and unit. Writing its title therefore never copies the left axis's unit onto it.
 */
const y2Start = (spec: PlotSpec): PlotAxis => spec.axes.y2 ?? { ...rightAxis(spec), unit: null };

/** One axis of the specification with some fields replaced. */
const setAxis = (spec: PlotSpec, axis: PlotAxisName, fields: Partial<PlotAxis>): PlotSpec =>
  axis === "y2"
    ? { ...spec, axes: { ...spec.axes, y2: { ...y2Start(spec), ...fields } } }
    : { ...spec, axes: { ...spec.axes, [axis]: { ...spec.axes[axis], ...fields } } };

/** The plot type (XY or polar); the traces keep their expressions (a polar trace reads x as the angle, y as the radius). */
export const setPlotType = (spec: PlotSpec, type: PlotSpec["type"]): PlotSpec => ({ ...spec, type });

/** Legend corner inside the plot area; default (`top-right`) is omitted from the spec. */
export function setLegendPosition(
  spec: PlotSpec,
  position: NonNullable<PlotSpec["legend_position"]>,
): PlotSpec {
  const next: PlotSpec = { ...spec };
  if (position === "top-right") delete next.legend_position;
  else next.legend_position = position;
  return next;
}

/** Legend font size in points (6..36); `null` or the default 12 pt restores the default size. */
export function setLegendFontSize(spec: PlotSpec, sizePt: number | null): PlotSpec {
  const next: PlotSpec = { ...spec };
  if (sizePt === null || !Number.isFinite(sizePt)) {
    delete next.legend_font_size;
    return next;
  }
  const clamped = Math.min(36, Math.max(6, sizePt));
  if (clamped === 12) delete next.legend_font_size;
  else next.legend_font_size = clamped;
  return next;
}
