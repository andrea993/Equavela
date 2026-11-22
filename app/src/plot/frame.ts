// The binary frame that carries the calculated data of a plot.
// Layout (little-endian): u32 header length, JSON header, then the Float64 buffers the header
// points at. `core/src/plot.rs` (`PlotData::encode_frame`) is the other end of this format.

import type { DimensionComponent } from "../equavelaApi";

export type PlotDataState = "pending" | "stale" | "ready" | "error";

export type PlotDataError = {
  trace: string;
  axis: "x" | "y" | "z";
  expression: string;
  message: string;
};

export type TraceFrame = {
  id: string;
  x: Float64Array;
  y: Float64Array;
  z?: { rows: number; cols: number; values: Float64Array; dimension: DimensionComponent[] };
  x_dimension: DimensionComponent[];
  y_dimension: DimensionComponent[];
  /** Points with both coordinates finite; the others are gaps (NaN). */
  finite: number;
  /** The worksheet length when the trace was reduced for display. */
  downsampled_from: number | null;
};

/** The limits one axis draws with: a resolved value, or null for automatic. */
export type AxisLimits = { min: number | null; max: number | null };

/** A limit expression the session could not use: the end (or the axis) stays automatic. */
export type PlotLimitError = {
  axis: "x" | "y" | "y2";
  bound: "min" | "max";
  expression: string;
  message: string;
};

/** A display unit the calculation converted an axis to: the SI magnitude it divided by. */
export type PlotAxisUnit = { axis: "x" | "y" | "y2"; divisor: number };

/** A unit expression the calculation could not use: that axis keeps the SI base display. */
export type PlotUnitError = {
  axis: "x" | "y" | "y2";
  expression: string;
  message: string;
};

/** A fixed reference line resolved in its axis display unit. */
export type PlotReferenceLineData = { id: string; axis: "x" | "y"; value: number };

/** A reference line omitted while the plot's traces remain visible. */
export type PlotReferenceLineError = {
  id: string;
  axis: "x" | "y";
  expression: string;
  message: string;
};

export type PlotFrame = {
  region_id: string;
  state: PlotDataState;
  error: PlotDataError | null;
  /** A trace whose x the plot samples itself, so navigating the view resamples it. */
  implicit_x: boolean;
  traces: TraceFrame[];
  /** The limits each axis draws with, x, y and y2. */
  limits: (AxisLimits & { axis: "x" | "y" | "y2" })[];
  limit_errors: PlotLimitError[];
  /** The units the values are already expressed in, in axis order. */
  units: PlotAxisUnit[];
  unit_errors: PlotUnitError[];
  reference_lines?: PlotReferenceLineData[];
  reference_line_errors?: PlotReferenceLineError[];
};

type Buffer = { offset: number; length: number };
type Header = {
  region_id: string;
  state: PlotDataState;
  error: PlotDataError | null;
  implicit_x?: boolean;
  traces: {
    id: string;
    x: Buffer;
    y: Buffer;
    z?: { rows: number; cols: number; values: Buffer; dimension: DimensionComponent[] };
    x_dimension: DimensionComponent[];
    y_dimension: DimensionComponent[];
    finite: number;
    downsampled_from?: number | null;
  }[];
  limits?: (AxisLimits & { axis: "x" | "y" | "y2" })[];
  limit_errors?: PlotLimitError[];
  units?: PlotAxisUnit[];
  unit_errors?: PlotUnitError[];
  reference_lines?: PlotReferenceLineData[];
  reference_line_errors?: PlotReferenceLineError[];
};

/** Decodes and validates a frame; throws on a truncated or inconsistent one. */
export function decodePlotFrame(frame: ArrayBuffer | Uint8Array): PlotFrame {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 4) throw new Error("plot frame is shorter than its length prefix");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(0, true);
  const headerEnd = 4 + headerLength;
  if (headerEnd > bytes.byteLength) throw new Error("plot frame header exceeds the frame");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, headerEnd))) as Header;
  const read = (buffer: Buffer): Float64Array => {
    const start = headerEnd + buffer.offset;
    const end = start + buffer.length * 8;
    if (end > bytes.byteLength) throw new Error("plot buffer exceeds the frame payload");
    // A copy: the payload offset is not 8-byte aligned in general.
    return new Float64Array(bytes.slice(start, end).buffer);
  };
  return {
    region_id: header.region_id,
    state: header.state,
    error: header.error,
    implicit_x: header.implicit_x ?? false,
    limits: header.limits ?? [],
    limit_errors: header.limit_errors ?? [],
    units: header.units ?? [],
    unit_errors: header.unit_errors ?? [],
    reference_lines: header.reference_lines ?? [],
    reference_line_errors: header.reference_line_errors ?? [],
    traces: header.traces.map((trace) => {
      const x = read(trace.x);
      const y = read(trace.y);
      const z = trace.z ? { ...trace.z, values: read(trace.z.values) } : undefined;
      if (z && (z.rows < 2 || z.cols < 2 || z.rows !== y.length || z.cols !== x.length || z.rows * z.cols !== z.values.length)) {
        throw new Error("contour grid shape does not match its buffers");
      }
      if (!z && x.length !== y.length) throw new Error(`trace \`${trace.id}\` has unequal x and y lengths`);
      return {
        id: trace.id,
        x,
        y,
        ...(z ? { z } : {}),
        x_dimension: trace.x_dimension,
        y_dimension: trace.y_dimension,
        finite: trace.finite,
        downsampled_from: trace.downsampled_from ?? null,
      };
    }),
  };
}

/** Encodes a frame (the mock backend and the tests; the real one is produced by Rust). */
export function encodePlotFrame(frame: PlotFrame): Uint8Array {
  const buffers: Float64Array[] = [];
  let offset = 0;
  const push = (values: Float64Array): Buffer => {
    const buffer = { offset, length: values.length };
    buffers.push(values);
    offset += values.length * 8;
    return buffer;
  };
  const header: Header = {
    region_id: frame.region_id,
    state: frame.state,
    error: frame.error,
    implicit_x: frame.implicit_x,
    limits: frame.limits,
    limit_errors: frame.limit_errors,
    units: frame.units,
    unit_errors: frame.unit_errors,
    reference_lines: frame.reference_lines,
    reference_line_errors: frame.reference_line_errors,
    traces: frame.traces.map((trace) => ({
      id: trace.id,
      x: push(trace.x),
      y: push(trace.y),
      ...(trace.z ? { z: { ...trace.z, values: push(trace.z.values) } } : {}),
      x_dimension: trace.x_dimension,
      y_dimension: trace.y_dimension,
      finite: trace.finite,
      downsampled_from: trace.downsampled_from,
    })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + offset);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  let at = 4 + json.length;
  for (const values of buffers) {
    out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), at);
    at += values.byteLength;
  }
  return out;
}

/** A trace built from plain numbers (non-finite values become gaps). */
export function makeTrace(id: string, x: ArrayLike<number>, y: ArrayLike<number>): TraceFrame {
  const xs = Float64Array.from(x, (v) => (Number.isFinite(v) ? v : NaN));
  const ys = Float64Array.from(y, (v) => (Number.isFinite(v) ? v : NaN));
  let finite = 0;
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) finite++;
  return { id, x: xs, y: ys, x_dimension: [], y_dimension: [], finite, downsampled_from: null };
}
