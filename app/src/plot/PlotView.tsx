// The content of a plot region: the plot (Plotly adapter), its title and the titles and units of its
// axes in bands at the outer edge of the margins, and the editable math placeholders around
// it: the y-axis expressions and limits on the left, the x-axis expressions and limits below, the
// right y limits on the right. The region holds nothing else: trace
// selection, style, axis assignment, scales and the grid are controls of the Plot tab. Shift+Enter in
// an expression adds a trace. Each commit stores the whole specification through `PlotEnv.save`, one
// undo step. A hidden mirror typesets the committed placeholders and the margins grow by the width
// the widest y expression needs, so a long expression is never clipped.

import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import { ptToPx } from "../layout/geometry";
import { S } from "../strings";
import type { PlotSpec, ViewRegion } from "../equavelaApi";
import {
  fitTextWidths,
  NO_TEXT_WIDTHS,
  plotBands,
  plotMargin,
  traceSample,
  Y2_COLUMN,
  Y_COLUMN,
  type PlotTextWidths,
} from "./adapter";
import {
  limitText,
  setAxisTitle,
  setAxisUnit,
  setLimit as editLimit,
  setPlotTitle,
  setSharedX as editSharedX,
  setTraceExpression,
  setY2Limit as editY2Limit,
  sharedX,
  usesRightAxis,
  withNewTrace,
  type PlotAxisName,
} from "./edit";
import type { PlotFrame } from "./frame";
import { PlotCanvas } from "./PlotCanvas";
import { PlotContext } from "./PlotContext";
import { PlotLabels } from "./PlotLabels";
import { PlotLegend } from "./PlotLegend";
import { PlotMeasure } from "./measure";
import { Slot } from "./PlotSlot";
import { createViewSender, relayoutViewRange } from "./view";

// The pure edits live in `edit.ts`; they stay importable from here.
export { limitText, nextTraceId, parseLimit, removeTrace, sharedX, withNewTrace } from "./edit";

type PlotRegion = Extract<ViewRegion, { kind: "plot" }>;

/** The placeholder label of one axis end, for a limit failure note. */
function limitLabel(axis: "x" | "y" | "y2", bound: "min" | "max"): string {
  if (axis === "x") return bound === "min" ? S.plot.xMin : S.plot.xMax;
  if (axis === "y") return bound === "min" ? S.plot.yMin : S.plot.yMax;
  return bound === "min" ? S.plot.y2Min : S.plot.y2Max;
}

/** The placeholder label of one axis unit, for a unit failure note. */
function unitLabel(axis: "x" | "y" | "y2"): string {
  if (axis === "x") return S.plot.xUnit;
  if (axis === "y") return S.plot.yUnit;
  return S.plot.y2Unit;
}

export function PlotView({
  region,
  size,
  selected,
}: {
  region: PlotRegion;
  /** Size in points while a resize drag is in progress. */
  size: { w: number; h: number } | null;
  /** The plot region is the active sheet selection (editing chrome is shown). */
  selected: boolean;
}) {
  const env = useContext(PlotContext);
  const spec = region.plot;
  const width = ptToPx(size?.w ?? spec.size[0]);
  const height = ptToPx(size?.h ?? spec.size[1]);
  const [frame, setFrame] = useState<PlotFrame | null>(null);
  const [cursorCoordinates, setCursorCoordinates] = useState<string | null>(null);
  const [focusTrace, setFocusTrace] = useState<string | null>(null);
  const [limitError, setLimitError] = useState(false);
  const [editing, setEditing] = useState(false);
  // the widths the hidden mirror measured for the committed placeholders, and whether they
  // belong to the current specification (a plot draws only once they do).
  const [measured, setMeasured] = useState<{ widths: PlotTextWidths; ready: boolean }>({
    widths: NO_TEXT_WIDTHS,
    ready: false,
  });
  // the width the expression being edited in the left or the right column needs. The column
  // follows it while the edit lasts, so a long expression never runs under the plot area.
  const [live, setLive] = useState<PlotTextWidths>(NO_TEXT_WIDTHS);
  const liveWidth = useCallback(
    (column: "y" | "y2") => (px: number | null) =>
      setLive((previous) => (previous[column] === (px ?? 0) ? previous : { ...previous, [column]: px ?? 0 })),
    [],
  );
  const onMeasured = useCallback((widths: PlotTextWidths, ready: boolean) => {
    setMeasured((previous) =>
      previous.ready === ready && previous.widths.y === widths.y && previous.widths.y2 === widths.y2
        ? previous
        : { widths, ready },
    );
  }, []);

  const revision = env?.revision ?? 0;
  // Selection changes recreate the context value, but they must not re-fetch the plot data.
  const envRef = useRef(env);
  envRef.current = env;
  useEffect(() => {
    let current = true;
    const plotEnv = envRef.current;
    if (!plotEnv) return undefined;
    // A busy backend (a calculation is running) is asked again when the pass finishes.
    plotEnv.load(region.id).then(
      (next) => {
        if (current) setFrame(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [region.id, revision]);

  // navigating the plot (pan, drag-to-zoom, reset) resamples every trace whose x the plot
  // samples itself. The library reports the new range; it is sent once the gesture is over (the
  // debounce in `view.ts`), and only for a plot that has such a trace.
  const viewSender = useMemo(
    () => createViewSender((range) => envRef.current?.view(region.id, range)),
    [region.id],
  );
  useEffect(() => () => viewSender.cancel(), [viewSender]);
  const xScale = spec.axes.x.scale;
  const reportView = useCallback(
    (event: Record<string, unknown>) => {
      const range = relayoutViewRange(event, xScale === "log10");
      // An event about the y axis alone (or a mode-bar click) changes no sample.
      if (range === undefined) return;
      viewSender.push(range);
    },
    [viewSender, xScale],
  );

  const save = useCallback(
    (next: PlotSpec) => {
      setLimitError(false);
      env?.save(region.id, next);
    },
    [env, region.id],
  );
  const selectedTrace = env?.selectedTrace(region.id) ?? null;
  const selectTrace = useCallback(
    (traceId: string | null) => env?.selectTrace(region.id, traceId),
    [env, region.id],
  );
  // Any press on the plot or its placeholders makes the plot region the selection, which brings up
  // the Plot tab.
  const activate = useCallback(() => {
    if (!selected) env?.selectRegion(region.id);
  }, [env, region.id, selected]);
  const refused = (next: PlotSpec | null) => {
    if (next === null) setLimitError(true);
    else save(next);
  };
  const setTrace = (index: number, axis: "x" | "y" | "z", text: string) => save(setTraceExpression(spec, index, axis, text));
  const setSharedX = (text: string) => save(editSharedX(spec, text));
  const setY2Limit = (which: "min" | "max", text: string) => refused(editY2Limit(spec, which, text));
  const setLimit = (axis: "x" | "y", which: "min" | "max", text: string) => refused(editLimit(spec, axis, which, text));
  // the titles and the units of the plot, committed like every other placeholder.
  const setTitle = (axis: "plot" | PlotAxisName, text: string) =>
    save(axis === "plot" ? setPlotTitle(spec, text) : setAxisTitle(spec, axis, text));
  const setUnit = (axis: PlotAxisName, text: string) => save(setAxisUnit(spec, axis, text));
  // The margins the plot area keeps: they depend on the stored specification, the bundled fonts and
  // the measured placeholders only, so the screen and the PDF lay the same plot out at the same size
  //. An expression wider than its base column shifts the plot area right, a wide right y
  // limit shifts it left, and a region too narrow for both keeps a minimum plot area.
  const textWidths = fitTextWidths(spec, width, {
    y: Math.max(measured.widths.y, live.y),
    y2: Math.max(measured.widths.y2, live.y2),
    x: measured.widths.x,
  });
  const margin = plotMargin(spec, textWidths);
  const bands = plotBands(spec);
  // The placeholder columns sit in the inner edge of their margin: next to the tick labels, which
  // start at the plot area. A title band takes the outer edge, so a column moves in by its band.
  const yColumn = { left: Y_COLUMN.left + bands.y, width: textWidths.y };
  const y2Column = { right: Y2_COLUMN.right + bands.y2, width: textWidths.y2 };
  const addTrace = () => {
    const next = withNewTrace(spec);
    const traceId = next.traces[next.traces.length - 1].id;
    setFocusTrace(traceId);
    selectTrace(traceId);
    save(next);
  };

  const first = frame?.traces[0];
  const reduced = frame?.traces.find((trace) => trace.downsampled_from !== null);
  const xShared = sharedX(spec);
  // while the plot is not selected and nothing in it has the keyboard focus, only the plot is drawn.
  const showEditingChrome = selected || editing;
  const classes = ["plot-region", frame?.state === "stale" ? "stale" : "", frame?.state === "error" ? "failed" : "", showEditingChrome ? "editing" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      // The zoom tools and the title bands are positioned from the same margins as the plot area.
      style={
        {
          width,
          height,
          "--plot-title-band": `${bands.plot}px`,
          "--plot-left-margin": `${margin.l}px`,
        } as CSSProperties
      }
      role="img"
      aria-label={S.page.plotLabel}
      data-testid={`plot-${region.id}`}
      data-state={frame?.state ?? "loading"}
      data-selected-trace={showEditingChrome ? (selectedTrace ?? "") : ""}
      data-editing={showEditingChrome ? "true" : "false"}
      onFocusCapture={() => {
        setEditing(true);
        // The one-shot autofocus of a freshly added trace is spent once something is focused, so a
        // later remount of a slot can never pull the focus back into it.
        setFocusTrace(null);
      }}
      onBlurCapture={(event: FocusEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setEditing(false);
      }}
    >
      <PlotCanvas
        spec={spec}
        frame={frame}
        width={width}
        height={height}
        // the same measured margins PlotView lays its placeholders out with, and no draw
        // until the committed expressions have been measured (print waits for the final layout).
        textWidths={textWidths}
        measured={measured.ready}
        selectedTraceId={showEditingChrome ? selectedTrace : null}
        // A navigation only has samples to move when the plot samples an x itself.
        onRelayout={frame?.implicit_x ? reportView : undefined}
        onCursorCoordinates={setCursorCoordinates}
        onSelectTrace={(traceId) => {
          activate();
          selectTrace(traceId);
        }}
      />
      {cursorCoordinates && (
        <div
          className="plot-coordinate-readout no-print"
          role="note"
          aria-label={S.plot.cursorCoordinates}
          data-testid="plot-cursor-coordinates"
          style={{ top: margin.t + 6, left: margin.l + 6 }}
        >
          {cursorCoordinates}
        </div>
      )}
      {/* The hidden mirror that measures the placeholders and shifts the plot area by their width. It draws nothing and takes no pointer or keyboard. */}
      <PlotMeasure spec={spec} onMeasured={onMeasured} />
      {/* The area of the region around the plot area — the margins where the tick labels sit and the
          space around the expression slots — moves the region when it is dragged, exactly as the
          strips of the selection border do. It is
          invisible and print-free, so the page and the PDF draw the same plot; the placeholders are
          above it and keep their own presses, and the plot area is left to the plot. */}
      <span className="plot-move-area no-print" data-testid="plot-move-area" aria-hidden="true">
        <i className="top" style={{ height: margin.t }} />
        <i className="bottom" style={{ height: margin.b }} />
        <i className="left" style={{ top: margin.t, bottom: margin.b, width: margin.l }} />
        <i className="right" style={{ top: margin.t, bottom: margin.b, width: margin.r }} />
      </span>
      {/* The plot title and the axis titles and units are part of the plot. */}
      <PlotLabels spec={spec} margin={margin} onTitle={setTitle} onUnit={setUnit} onActivate={activate} />
      {/* The legend is part of the plot, not editing chrome. */}
      <PlotLegend
        spec={spec}
        margin={margin}
        frame={frame}
        onSelect={(traceId) => {
          activate();
          selectTrace(traceId);
        }}
      />
      <div className="plot-slots y" style={{ ...yColumn, top: margin.t, bottom: margin.b }}>
        {spec.type !== "polar" && (
          <Slot
            onLiveWidth={liveWidth("y")}
            className="limit"
            text={limitText(spec.axes.y.max)}
            label={S.plot.yMax}
            onActivate={activate}
            onCommit={(text) => setLimit("y", "max", text)}
          />
        )}
        <div className="expressions">
          {spec.traces.map((trace, index) => (
            <Slot
            onLiveWidth={liveWidth("y")}
              key={trace.id}
              traceId={trace.id}
              selected={showEditingChrome && selectedTrace === trace.id}
              onSelect={() => selectTrace(trace.id)}
              onActivate={activate}
              text={spec.type === "contour" ? trace.z ?? "" : trace.y}
              sample={traceSample(trace, index)}
              label={spec.type === "contour" ? S.plot.zExpression : spec.type === "polar" ? S.plot.polarRadius : S.plot.yExpression}
              onCommit={(text) => setTrace(index, spec.type === "contour" ? "z" : "y", text)}
              onShiftEnter={addTrace}
            />
          ))}
        </div>
        {spec.type !== "polar" && (
          <Slot
            onLiveWidth={liveWidth("y")}
            className="limit"
            text={limitText(spec.axes.y.min)}
            label={S.plot.yMin}
            onActivate={activate}
            onCommit={(text) => setLimit("y", "min", text)}
          />
        )}
      </div>
      {spec.type === "xy" && usesRightAxis(spec) && (
        <div className="plot-slots y2" style={{ ...y2Column, top: margin.t, bottom: margin.b }}>
          <Slot onLiveWidth={liveWidth("y2")} className="limit" text={limitText(spec.axes.y2?.max ?? null)} label={S.plot.y2Max} onActivate={activate} onCommit={(text) => setY2Limit("max", text)} />
          <Slot onLiveWidth={liveWidth("y2")} className="limit" text={limitText(spec.axes.y2?.min ?? null)} label={S.plot.y2Min} onActivate={activate} onCommit={(text) => setY2Limit("min", text)} />
        </div>
      )}
      <div className="plot-slots x" style={{ left: margin.l, right: margin.r, bottom: 2 + bands.x, height: textWidths.x }}>
        {spec.type !== "polar" && (
          <Slot
            className="limit"
            text={limitText(spec.axes.x.min)}
            label={S.plot.xMin}
            onActivate={activate}
            onCommit={(text) => setLimit("x", "min", text)}
          />
        )}
        <div className="expressions">
          {xShared !== null ? (
            <Slot
              className={xShared === "" ? "unused" : ""}
              text={xShared}
              label={spec.type === "polar" ? S.plot.polarAngle : S.plot.xExpression}
              autoFocus={focusTrace !== null}
              onActivate={activate}
              onCommit={setSharedX}
              onShiftEnter={addTrace}
            />
          ) : (
            spec.traces.map((trace, index) => (
              <Slot
                key={trace.id}
                className={trace.x === "" ? "unused" : ""}
                traceId={trace.id}
                selected={showEditingChrome && selectedTrace === trace.id}
                onSelect={() => selectTrace(trace.id)}
                onActivate={activate}
                text={trace.x}
                label={spec.type === "polar" ? S.plot.polarAngle : S.plot.xExpression}
                autoFocus={focusTrace === trace.id}
                onCommit={(text) => setTrace(index, "x", text)}
                onShiftEnter={addTrace}
              />
            ))
          )}
          {spec.type === "contour" && spec.traces.map((trace, index) => (
            <Slot key={`y-${trace.id}`} traceId={trace.id} text={trace.y}
              label={S.plot.yExpression} onActivate={activate} onSelect={() => selectTrace(trace.id)}
              onCommit={(text) => setTrace(index, "y", text)} onShiftEnter={addTrace} />
          ))}
        </div>
        {spec.type !== "polar" && (
          <Slot
            className="limit"
            text={limitText(spec.axes.x.max)}
            label={S.plot.xMax}
            onActivate={activate}
            onCommit={(text) => setLimit("x", "max", text)}
          />
        )}
      </div>
      {frame?.state === "error" && frame.error && (
        <div className="plot-note error-text no-print" role="status">
          {S.plot.error(frame.error.trace, frame.error.axis, frame.error.expression, frame.error.message)}
        </div>
      )}
      {/* A limit expression the calculation could not use: the traces still draw and the
          axis end falls back to automatic range. */}
      {(frame?.limit_errors ?? []).map((error) => (
        <div
          className="plot-note error-text no-print"
          role="status"
          key={`${error.axis}-${error.bound}`}
          data-testid="plot-limit-error"
        >
          {S.plot.limitError(limitLabel(error.axis, error.bound), error.expression, error.message)}
        </div>
      ))}
      {/* An axis unit the calculation could not use: the traces still draw and that axis
          keeps the SI base display. */}
      {(frame?.unit_errors ?? []).map((error) => (
        <div
          className="plot-note error-text no-print"
          role="status"
          key={`unit-${error.axis}`}
          data-testid="plot-unit-error"
        >
          {S.plot.unitError(unitLabel(error.axis), error.expression, error.message)}
        </div>
      ))}
      {(frame?.reference_line_errors ?? []).map((error) => (
        <div className="plot-note error-text no-print" role="status" key={`reference-${error.id}`} data-testid="plot-reference-line-error">
          {S.plot.referenceLineError(error.axis, error.expression, error.message)}
        </div>
      ))}
      {frame?.state === "stale" && <span className="plot-badge no-print">{S.plot.stale}</span>}
      {reduced && first && (
        <span className="plot-badge no-print">{S.plot.downsampled(reduced.x.length, reduced.downsampled_from ?? 0)}</span>
      )}
      {showEditingChrome && limitError && (
        <div className="plot-note warning-text no-print" role="status">
          {S.plot.badLimit}
        </div>
      )}
    </div>
  );
}
