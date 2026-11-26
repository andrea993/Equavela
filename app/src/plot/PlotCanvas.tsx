// Draws one plot with the Plotly partial bundle. It mounts lazily when it comes
// near the viewport, always before print, and switches to the SVG
// print representation of every trace around `beforeprint`. All decisions about what
// to draw are in `adapter.ts`; this file only owns the DOM element and the library handle.

import { useEffect, useRef, useState } from "react";
import { isPrinting, usePrinting } from "../print/printMode";
import { S } from "../strings";
import type { PlotSpec } from "../equavelaApi";
import { buildFigure, crossesAtOrigin, NO_TEXT_WIDTHS, NO_VERTICAL_EXPANSION, originPositions, referenceLineShapes, type AxisRange, type AxisRanges, type PlotlyFigure, type PlotTextWidths } from "./adapter";
import type { PlotFrame } from "./frame";
import { traceHitAt } from "./hitTest";
import { cursorCoordinatesAt, type PlotLayout } from "./cursorCoordinates";

/** How far outside the viewport a plot starts mounting, CSS px. */
export const MOUNT_MARGIN_PX = 300;

type Props = {
  spec: PlotSpec;
  frame: PlotFrame | null;
  /** Size in CSS px. */
  width: number;
  height: number;
  /** The measured placeholder columns the plot margins keep. */
  textWidths?: PlotTextWidths;
  /** Extra vertical margin (CSS px) above and below the plot area for a tall y-expression stack. */
  extraY?: { top: number; bottom: number };
  /** Whether those widths belong to the current specification; false holds the draw. */
  measured?: boolean;
  /** The selected trace. */
  selectedTraceId?: string | null;
  /** A click on a rendered trace selects it. */
  onSelectTrace?: (traceId: string) => void;
  /**
   * The library's `plotly_relayout` payload for every navigation of the view: pan, drag-to-zoom
   * and reset-to-data-range. Absent when the plot has nothing a navigation resamples.
   */
  onRelayout?: (event: Record<string, unknown>) => void;
  /** Screen-only pointer coordinates in the current axis units. */
  onCursorCoordinates?: (coordinates: string | null) => void;
};

type Plotly = {
  react(element: HTMLElement, data: unknown[], layout: unknown, config: unknown): Promise<unknown>;
  relayout(element: HTMLElement, layout: Record<string, unknown>): Promise<unknown>;
  purge(element: HTMLElement): void;
};

/** What the library reports about one drawn axis: the range it shows and where its line is. */
type DrawnAxis = { range?: [number, number]; position?: number };

/**
 * The graph div after `react`: the library keeps its event emitter on the element itself
 * (`gd.on` / `gd.removeListener`), which is how a navigation of the view is reported, and
 * the layout it settled on, which is the only place an automatic range exists.
 */
type PlotHost = HTMLElement & {
  on?: (event: string, handler: (data: Record<string, unknown>) => void) => void;
  removeListener?: (event: string, handler: (data: Record<string, unknown>) => void) => void;
  _fullLayout?: PlotLayout & { xaxis?: DrawnAxis; yaxis?: DrawnAxis; yaxis2?: DrawnAxis };
};

/** The range one drawn axis shows; a log axis reports the exponents of its ends. */
function drawnRange(axis: DrawnAxis | undefined): AxisRange | undefined {
  const ends = axis?.range;
  if (!ends || ends.length !== 2 || !ends.every((end) => Number.isFinite(end))) return undefined;
  return [ends[0], ends[1]];
}

/** The ranges the plot is drawn with, read from the layout the library settled on. */
function drawnRanges(element: PlotHost | null): AxisRanges {
  const layout = element?._fullLayout;
  return {
    x: drawnRange(layout?.xaxis),
    y: drawnRange(layout?.yaxis),
    y2: drawnRange(layout?.yaxis2),
  };
}

/** Whether a relayout payload moves an axis range, which is the only thing a crossing follows. */
function movesRange(event: Record<string, unknown>): boolean {
  return Object.keys(event).some((key) => key.includes(".range") || key.includes(".autorange"));
}

/** Whether the plot draws any axis through the origin, so a navigation can move it. */
function hasOriginAxis(spec: PlotSpec): boolean {
  return crossesAtOrigin(spec.axes.x) || crossesAtOrigin(spec.axes.y) || crossesAtOrigin(spec.axes.y2);
}

/**
 * Puts every origin axis where the ranges it is drawn with put its crossing. The figure is
 * drawn once without knowing an automatic range, so the crossing is computed from what the library
 * settled on and, when it differs from the one drawn, the axes are moved by one relayout — the same
 * on screen and in print, which share this path. Two calls in a row settle: a relayout that only
 * moves a line changes no range.
 */
function positionAxes(plotly: Plotly, element: PlotHost, spec: PlotSpec, ranges: AxisRanges): Promise<unknown> {
  const wanted = originPositions(spec, ranges);
  const moved: Record<string, number> = {};
  for (const [axis, position] of Object.entries(wanted)) {
    const current = element._fullLayout?.[axis as "xaxis" | "yaxis" | "yaxis2"]?.position;
    if (current === undefined || Math.abs(current - position) > 1e-9) moved[`${axis}.position`] = position;
  }
  return Object.keys(moved).length > 0 ? plotly.relayout(element, moved) : Promise.resolve();
}

/** Repositions domain-relative reference lines after Plotly settles or changes the visible range. */
function positionReferenceLines(plotly: Plotly, element: PlotHost, spec: PlotSpec, frame: PlotFrame | null, ranges: AxisRanges): Promise<unknown> {
  const shapes = referenceLineShapes(spec, frame, ranges);
  const update: Record<string, number> = {};
  shapes.forEach((shape, index) => {
    for (const key of ["x0", "x1", "y0", "y1"] as const) {
      const value = shape[key];
      if (typeof value === "number") update[`shapes[${index}].${key}`] = value;
    }
  });
  return Object.keys(update).length ? plotly.relayout(element, update) : Promise.resolve();
}

/** Loads the Plotly bundle once. */
let loading: Promise<Plotly> | null = null;
export function loadPlotly(): Promise<Plotly> {
  loading ??= import("./plotlyBundle").then((module) => module.default as Plotly);
  return loading;
}

export function PlotCanvas({
  spec,
  frame,
  width,
  height,
  textWidths = NO_TEXT_WIDTHS,
  extraY = NO_VERTICAL_EXPANSION,
  measured = true,
  selectedTraceId = null,
  onSelectTrace,
  onRelayout,
  onCursorCoordinates,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  // The ranges the plot drew with, kept so a redraw starts from the crossing it had.
  const ranges = useRef<AxisRanges>({});
  // The figure currently drawn: a click maps its library trace back to its worksheet trace through
  // `owners`, so a trace drawn as two library traces still selects one trace.
  const figure = useRef<PlotlyFigure | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === "undefined" || isPrinting());
  const printing = usePrinting();
  const [failed, setFailed] = useState(false);
  const [drawn, setDrawn] = useState(0);
  const cursorCoordinates = useRef(onCursorCoordinates);
  cursorCoordinates.current = onCursorCoordinates;

  useEffect(() => {
    const element = host.current;
    if (!near || !element || !onCursorCoordinates || printing) {
      cursorCoordinates.current?.(null);
      return undefined;
    }
    let pending: string | null = null;
    let request = 0;
    const publish = (value: string | null) => {
      pending = value;
      if (request !== 0) return;
      request = window.requestAnimationFrame(() => {
        request = 0;
        cursorCoordinates.current?.(pending);
      });
    };
    const move = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      publish(cursorCoordinatesAt(
        spec,
        (element as PlotHost)._fullLayout,
        event.clientX - rect.left,
        event.clientY - rect.top,
      ));
    };
    const leave = () => {
      if (request !== 0) window.cancelAnimationFrame(request);
      request = 0;
      pending = null;
      cursorCoordinates.current?.(null);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerleave", leave);
    return () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", leave);
      if (request !== 0) window.cancelAnimationFrame(request);
      cursorCoordinates.current?.(null);
    };
  }, [near, onCursorCoordinates, printing, spec]);

  // Lazy mounting: the plot is drawn once it is near the viewport and stays mounted.
  useEffect(() => {
    const element = host.current;
    if (near || !element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: `${MOUNT_MARGIN_PX}px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  // Every plot is mounted before print and drawn as SVG. The print view is a shared
  // state (`print/printMode.ts`); `PageView` wires `beforeprint` / `afterprint` to it (`installPrintEvents`).
  useEffect(() => {
    if (printing) setNear(true);
  }, [printing]);
  useEffect(() => {
    const element = host.current;
    if (!near || !element || !measured) return undefined;
    let current = true;
    const drawn = buildFigure(spec, frame, { width, height }, printing, selectedTraceId, ranges.current, textWidths, extraY);
    figure.current = drawn;
    loadPlotly()
      .then(async (plotly) => {
        if (!current) return;
        await plotly.react(element, drawn.data, drawn.layout, drawn.config);
        if (!current) return;
        // an origin axis is drawn at the crossing of a range the library has just settled
        // on. The plot counts as drawn once the crossing is in place, so a print export waits for it.
        ranges.current = drawnRanges(element);
        await positionReferenceLines(plotly, element, spec, frame, ranges.current);
        await positionAxes(plotly, element, spec, ranges.current);
        if (current) setDrawn((count) => count + 1);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [near, measured, spec, frame, width, height, printing, selectedTraceId, textWidths.y, textWidths.y2, textWidths.x, extraY.top, extraY.bottom]);

  // A click on a rendered SVG trace selects it; the legend is the app's own overlay and handles its
  // own clicks. The plot is a static image, so the native SVG element is the
  // reliable hit target.
  useEffect(() => {
    const element = host.current;
    if (!element || !onSelectTrace) return undefined;
    // The worksheet trace a library trace draws: the figure says which one.
    const owned = (layer: string, index: number) => {
      const owners = figure.current?.owners ?? [];
      const inLayer = owners.filter((owner) => owner.layer === layer);
      const owner = inLayer[index];
      if (!owner) return undefined;
      return frame?.traces.find((trace) => trace.id === owner.traceId) ?? spec.traces.find((trace) => trace.id === owner.traceId);
    };
    const traceAt = (target: Element | null) => {
      const traceGroup = target?.closest?.(".scatterlayer g.trace, .barlayer g.trace, .contourlayer g.contour");
      if (!traceGroup || !element.contains(traceGroup)) return undefined;
      const layer = traceGroup.closest(".barlayer") ? "barlayer" : traceGroup.closest(".contourlayer") ? "contourlayer" : "scatterlayer";
      const selector = layer === "contourlayer" ? ".contourlayer g.contour" : `.${layer} g.trace`;
      const index = Array.from(element.querySelectorAll(selector)).indexOf(traceGroup as Element);
      return owned(layer, index);
    };
    // A press on a trace also selects the plot region (it bubbles to the region), which brings up
    // the Plot tab with this trace selected.
    // Plotly's transparent drag rectangle covers the traces, so a click is mapped to a trace by
    // its position (`hitTest.ts`). A drag (zoom box, pan) is not a click on a trace.
    let pressed: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      pressed = { x: event.clientX, y: event.clientY };
    };
    const onClick = (event: MouseEvent) => {
      const moved = pressed !== null && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4;
      pressed = null;
      let trace = traceAt(event.target as Element | null);
      if (!trace && !moved) {
        const hit = traceHitAt(element, event.clientX, event.clientY);
        if (hit) trace = owned(hit.layer, hit.index);
      }
      if (!trace) return;
      event.stopPropagation();
      onSelectTrace(trace.id);
    };
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("click", onClick);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("click", onClick);
    };
  }, [frame, onSelectTrace, spec.traces]);

  // A navigation of the view (pan, drag-to-zoom, reset) is reported by the library as a
  // `plotly_relayout` event. The handler reads the latest callback, so a new range does
  // not need the listener to be installed again, and it is registered after the first draw, when
  // the library has attached its emitter to the element.
  const relayout = useRef(onRelayout);
  relayout.current = onRelayout;
  const reportsView = onRelayout !== undefined;
  // A navigation also moves the zero of an axis, and with it the crossing of an origin axis
  //: the axis is put back where the new range puts it, before anything is reported.
  const origin = hasOriginAxis(spec);
  const reposition = useRef<() => void>(() => undefined);
  reposition.current = () => {
    const element = host.current as PlotHost | null;
    if (!element) return;
    void loadPlotly()
      .then(async (plotly) => {
        const ranges = drawnRanges(element);
        await positionReferenceLines(plotly, element, spec, frame, ranges);
        await positionAxes(plotly, element, spec, ranges);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    const element = host.current as PlotHost | null;
    if (!near || !element?.on || (!reportsView && !origin)) return undefined;
    const handler = (event: Record<string, unknown>) => {
      // Only a range moves a crossing; the line-only relayout that put an axis in place therefore
      // never comes back here, so two calls settle and nothing loops.
      if (movesRange(event)) reposition.current();
      relayout.current?.(event);
    };
    element.on("plotly_relayout", handler);
    return () => element.removeListener?.("plotly_relayout", handler);
  }, [near, drawn, reportsView, origin]);

  // Release the library's DOM and listeners when the plot goes away.
  useEffect(() => {
    const element = host.current;
    return () => {
      if (element && loading) {
        void loading.then((plotly) => plotly.purge(element)).catch(() => undefined);
      }
    };
  }, []);

  return (
    <div
      ref={host}
      className="plot-canvas"
      style={{ width, height }}
      data-testid="plot-canvas"
      data-mounted={near ? "true" : "false"}
      // A draw with margins the current specification no longer owns does not count as drawn: the
      // print view waits for the measured margins.
      data-drawn={measured ? drawn : 0}
      data-printing={printing ? "true" : "false"}
      data-state={frame?.state ?? "loading"}
      data-points={frame?.traces.reduce((sum, trace) => sum + trace.x.length, 0) ?? 0}
    >
      {failed && <span className="plot-unavailable">{S.plot.unavailable}</span>}
    </div>
  );
}
