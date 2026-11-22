// The contextual Plot tab: every control of
// the selected plot lives here, so the plot on the page keeps only the plot and its math
// placeholders. Traces: add, remove, the trace list. Selected trace: its expressions, y axis and
// style. Axes: scales, auto scale, grid and grid spacing. All changes go through the pure edits of
// `plot/edit.ts`, the same ones the placeholders on the plot use.

import { useCallback, useState, type ReactNode } from "react";
import { PALETTE } from "../plot/adapter";
import { ColorPicker } from "./ColorPicker";
import { MATH_COLORS } from "../math/font";
import {
  axisOf,
  setAxisTitle,
  setAxisUnit,
  setGridSpacing,
  setPlotTitle,
  parseLimit,
  removeReferenceLine,
  setReferenceLine,
  setPlotType,
  setSharedX,
  setTraceExpression,
  setTraceLegendLabel,
  setTraceLegendVisibility,
  setTraceStyle,
  setYAxis,
  sharedX,
  shownAxes,
  usesRightAxis,
  withNewReferenceLine,
} from "../plot/edit";
import { bandLabel } from "../plot/PlotLabels";
import { Slot } from "../plot/PlotSlot";
import type { PlotSpec } from "../equavelaApi";
import { S } from "../strings";
import { applyPlotCommand, presentationTargets, type PlotCommand, type RibbonContext } from "../workbench/commandContext";
import { Group, Icon, ToolButton } from "./Chrome";

export type PlotTabProps = {
  context: Extract<RibbonContext, { kind: "plot" }>;
  /** Runs a Plot tab command by name (the same names as the command palette). */
  onCommand: (cmd: string) => void;
  /** Stores an edited specification: one undo step. */
  onPlotSpec: (plot: PlotSpec) => void;
  /** Selects (or clears) a trace of the plot. */
  onPlotSelectTrace: (traceId: string | null) => void;
  /** The colours the worksheet already uses, offered by the colour pickers of the traces. */
  worksheetColors?: readonly string[];
};

const LINE_STYLES = [
  ["solid", "Solid"],
  ["dash", "Dash"],
  ["dot", "Dot"],
  ["dashdot", "Dash-dot"],
] as const;
const MARKER_SHAPES = [
  ["circle", "Circle"],
  ["square", "Square"],
  ["diamond", "Diamond"],
  ["cross", "Cross"],
  ["x", "X"],
  ["triangle-up", "Triangle up"],
  ["triangle-down", "Triangle down"],
] as const;
const GRID_STEPS = [0.5, 1, 2, 5, 10];

/** A small labelled control of the ribbon: the label above the control (the tab must not wrap).
 *  The compact ribbon hides the label; the tooltip still names the control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ribbon-field" title={label}>
      <span className="ribbon-field-label">{label}</span>
      {children}
    </label>
  );
}

export function PlotTab({ context, onCommand, onPlotSpec, onPlotSelectTrace, worksheetColors }: PlotTabProps) {
  const C = S.ribbon.commands;
  const P = S.plot;
  const spec = context.plot;
  const index = spec.traces.findIndex((trace) => trace.id === context.selectedTraceId);
  const trace = index >= 0 ? spec.traces[index] : null;
  const off = trace === null;
  const xShared = sharedX(spec);
  const color = (i: number) => spec.traces[i].line?.color ?? PALETTE[i % PALETTE.length];

  const command = (cmd: PlotCommand, label: string, glyph: ReactNode, active?: boolean) => (
    <ToolButton
      label={label}
      icon={<Icon>{glyph}</Icon>}
      active={active}
      disabled={active === undefined && applyPlotCommand(spec, cmd, context.selectedTraceId) === null}
      onClick={() => onCommand(cmd)}
    />
  );
  const targets = presentationTargets(spec, context.selectedTraceId);
  const all = (presentation: string) => targets.every((item) => item.presentation === presentation);
  // The trace type: pressed when every targeted trace draws that way.
  const allKinds = (kind: PlotSpec["traces"][number]["type"]) => targets.every((item) => (item.type ?? "lines") === kind);
  const style = (kind: "line" | "marker", key: string, value: string | number | null) => {
    if (index >= 0) onPlotSpec(setTraceStyle(spec, index, kind, key, value));
  };
  const commitY = useCallback(
    (text: string) => onPlotSpec(setTraceExpression(spec, index, "y", text)),
    [onPlotSpec, spec, index],
  );
  const commitX = useCallback(
    (text: string) => onPlotSpec(xShared !== null ? setSharedX(spec, text) : setTraceExpression(spec, index, "x", text)),
    [onPlotSpec, spec, index, xShared],
  );
  const gridValue = spec.grid_spacing == null ? "auto" : String(spec.grid_spacing);
  // The titles of the plot and of the axes, drafted while they are typed.
  const [titleDraft, setTitleDraft] = useState<{ key: string; value: string } | null>(null);
  const titleOf = (key: string, stored: string) => (titleDraft?.key === key ? titleDraft.value : stored);
  const commitTitle = (key: string, stored: string, commit: (text: string) => PlotSpec) => {
    if (titleDraft?.key !== key) return;
    const typed = titleDraft.value;
    setTitleDraft(null);
    if (typed !== stored) onPlotSpec(commit(typed));
  };
  const [legendLabelDraft, setLegendLabelDraft] = useState<{ traceId: string; value: string } | null>(null);
  const [referenceLegendDraft, setReferenceLegendDraft] = useState<{ lineId: string; value: string } | null>(null);
  const [referenceWidthDraft, setReferenceWidthDraft] = useState<{ lineId: string; value: string } | null>(null);
  const legendLabel = trace
    ? legendLabelDraft?.traceId === trace.id
      ? legendLabelDraft.value
      : trace.legend_label ?? ""
    : "";
  const commitLegendLabel = () => {
    if (index < 0 || !trace || legendLabelDraft?.traceId !== trace.id) return;
    if (legendLabelDraft.value !== (trace.legend_label ?? "")) {
      onPlotSpec(setTraceLegendLabel(spec, index, legendLabelDraft.value));
    }
    setLegendLabelDraft(null);
  };

  const xy = spec.type === "xy";
  return (
    <>
      <Group title={S.ribbon.groups.plotType}>
        <Field label={P.type}>
          <select
            aria-label={P.type}
            value={spec.type}
            onChange={(event) => onPlotSpec(setPlotType(spec, event.target.value as PlotSpec["type"]))}
          >
            <option value="xy">{P.xyType}</option>
            <option value="polar">{P.polarType}</option>
            <option value="contour">{P.contourType}</option>
          </select>
        </Field>
      </Group>
      <Group title={S.ribbon.groups.traces}>
        {command("plotAddTrace", C.addTrace, "+∿")}
        {command("plotRemoveTrace", C.removeTrace, "−∿")}
        <div className="plot-trace-list" role="listbox" aria-label={P.traceList}>
          {spec.traces.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={item.id === context.selectedTraceId}
              className={`plot-trace-item${item.id === context.selectedTraceId ? " selected" : ""}`}
              title={P.traceItem(i + 1, item.y)}
              onClick={() => onPlotSelectTrace(item.id)}
            >
              <span className="plot-trace-swatch" style={{ background: color(i) }} aria-hidden="true" />
              <span className="plot-trace-name">{P.traceItem(i + 1, item.y)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={P.selectedTrace}>
        {trace ? (
          <div className="ribbon-fields">
            <div className="ribbon-field-row">
              <span className="ribbon-field-label">{P.yShort}</span>
              <Slot
                key={`y-${trace.id}`}
                className="ribbon-expression" fitRow
                text={trace.y}
                label={spec.type === "polar" ? P.polarRadius : P.yExpression}
                onSelect={() => onPlotSelectTrace(trace.id)}
                onCommit={commitY}
              />
            </div>
            <div className="ribbon-field-row">
              <span className="ribbon-field-label">{P.xShort}</span>
              <Slot
                key={`x-${trace.id}`}
                className="ribbon-expression" fitRow
                text={xShared ?? trace.x}
                label={spec.type === "polar" ? P.polarAngle : P.xExpression}
                onCommit={commitX}
              />
            </div>
            {spec.type === "contour" && (
              <div className="ribbon-field-row">
                <span className="ribbon-field-label">z</span>
                <Slot key={`z-${trace.id}`} className="ribbon-expression" fitRow text={trace.z ?? ""}
                  label={P.zExpression} onSelect={() => onPlotSelectTrace(trace.id)}
                  onCommit={(text) => onPlotSpec(setTraceExpression(spec, index, "z", text))} />
              </div>
            )}
            {xy && (
              <div className="ribbon-field-row">
                <span className="ribbon-field-label">{P.yAxisSelector}</span>
                <select
                  aria-label={P.yAxisSelector}
                  value={trace.y_axis ?? "left"}
                  onChange={(event) => onPlotSpec(setYAxis(spec, index, event.target.value as "left" | "right"))}
                >
                  <option value="left">{P.yAxisLeft}</option>
                  <option value="right">{P.yAxisRight}</option>
                </select>
              </div>
            )}
          </div>
        ) : (
          <span className="ribbon-hint">{P.selectTraceHint}</span>
        )}
      </Group>
      <Group title={P.legend}>
        <div className="ribbon-fields ribbon-fields-inline" aria-disabled={off}>
          <Field label={P.showInLegend}>
            <input
              aria-label={P.showInLegend}
              type="checkbox"
              disabled={off}
              checked={trace?.show_in_legend ?? true}
              onChange={(event) => {
                if (index >= 0) onPlotSpec(setTraceLegendVisibility(spec, index, event.target.checked));
              }}
            />
          </Field>
          <Field label={P.legendLabel}>
            <input
              aria-label={P.legendLabel}
              type="text"
              disabled={off}
              value={legendLabel}
              onChange={(event) => {
                if (trace) setLegendLabelDraft({ traceId: trace.id, value: event.target.value });
              }}
              onBlur={commitLegendLabel}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </Field>
        </div>
      </Group>
      {xy && <Group title={P.referenceLines}>
        <div className="ribbon-commands">
          <ToolButton label={P.addVerticalReferenceLine} icon={<Icon>↕</Icon>} onClick={() => onPlotSpec(withNewReferenceLine(spec, "x"))} />
          <ToolButton label={P.addHorizontalReferenceLine} icon={<Icon>↔</Icon>} onClick={() => onPlotSpec(withNewReferenceLine(spec, "y"))} />
        </div>
        <div className="ribbon-fields">
          {(spec.reference_lines ?? []).map((line, i) => {
            const axisName = line.axis === "x" ? P.verticalReferenceLine(i + 1) : P.horizontalReferenceLine(i + 1);
            return <div className="ribbon-field-row" key={line.id}>
              <span className="ribbon-field-label">{axisName}</span>
              <Slot
                key={`reference-${line.id}`}
                className="ribbon-expression" fitRow
                text={String(line.value)}
                label={P.referenceLineValue}
                onCommit={(text) => {
                  const value = parseLimit(text);
                  if (value !== null) onPlotSpec(setReferenceLine(spec, line.id, { value }));
                }}
              />
              <select aria-label={`${axisName} ${P.lineStyle}`} value={line.line?.style ?? "solid"}
                onChange={(event) => onPlotSpec(setReferenceLine(spec, line.id, { line: { ...line.line, style: event.target.value as "solid" | "dash" | "dot" | "dashdot" } }))}>
                {LINE_STYLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input aria-label={`${axisName} ${P.lineWidth}`} type="number" min="0.5" max="6" step="0.5"
                value={referenceWidthDraft?.lineId === line.id ? referenceWidthDraft.value : String(line.line?.width ?? 1.5)}
                onChange={(event) => setReferenceWidthDraft({ lineId: line.id, value: event.target.value })}
                onBlur={() => {
                  if (referenceWidthDraft?.lineId === line.id) {
                    const width = Number(referenceWidthDraft.value);
                    if (Number.isFinite(width) && width !== (line.line?.width ?? 1.5)) {
                      onPlotSpec(setReferenceLine(spec, line.id, { line: { ...line.line, width } }));
                    }
                    setReferenceWidthDraft(null);
                  }
                }} />
              <ColorPicker label={`${axisName} ${P.lineColor}`} none={P.automaticColor}
                colors={MATH_COLORS.slice(1).map(({ value, name }) => ({ value, name }))} hideLabel title={P.lineColor}
                disabled={false}
                value={line.line?.color ?? PALETTE[i % PALETTE.length]} worksheetColors={worksheetColors}
                onPick={(color) => onPlotSpec(setReferenceLine(spec, line.id, { line: { ...line.line, color } }))} />
              <label><input aria-label={`${axisName} ${P.showInLegend}`} type="checkbox" checked={line.show_in_legend ?? false}
                onChange={(event) => onPlotSpec(setReferenceLine(spec, line.id, { show_in_legend: event.target.checked }))} />{P.showInLegend}</label>
              <input aria-label={`${axisName} ${P.legendLabel}`} type="text" placeholder={P.legendLabel}
                value={referenceLegendDraft?.lineId === line.id ? referenceLegendDraft.value : line.legend_label ?? ""}
                onChange={(event) => setReferenceLegendDraft({ lineId: line.id, value: event.target.value })}
                onBlur={() => {
                  if (referenceLegendDraft?.lineId === line.id) {
                    if (referenceLegendDraft.value !== (line.legend_label ?? "")) {
                      onPlotSpec(setReferenceLine(spec, line.id, { legend_label: referenceLegendDraft.value }));
                    }
                    setReferenceLegendDraft(null);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }} />
              <ToolButton label={`${P.removeReferenceLine}: ${axisName}`} icon={<Icon>×</Icon>}
                onClick={() => onPlotSpec(removeReferenceLine(spec, line.id))} />
            </div>;
          })}
        </div>
      </Group>}
      <Group title={S.ribbon.groups.labels}>
        <div className="ribbon-fields ribbon-labels">
          {([["plot", P.plotTitle, spec.title ?? ""]] as const).map(([key, label, stored]) => (
            <div className="ribbon-field-row" key={key}>
              <span className="ribbon-field-label">{label}</span>
              <input
                aria-label={label}
                type="text"
                value={titleOf(key, stored)}
                onChange={(event) => setTitleDraft({ key, value: event.target.value })}
                onBlur={() => commitTitle(key, stored, (text) => setPlotTitle(spec, text))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
            </div>
          ))}
          {shownAxes(spec).map((axis) => {
            const settings = axisOf(spec, axis);
            const label = bandLabel(axis, "title");
            return (
              <div className="ribbon-field-row" key={axis}>
                <span className="ribbon-field-label">{label}</span>
                <input
                  aria-label={label}
                  type="text"
                  value={titleOf(axis, settings.title)}
                  onChange={(event) => setTitleDraft({ key: axis, value: event.target.value })}
                  onBlur={() => commitTitle(axis, settings.title, (text) => setAxisTitle(spec, axis, text))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
                <Slot
                  key={`unit-${axis}`}
                  className="ribbon-expression" fitRow
                  text={settings.unit ?? ""}
                  label={bandLabel(axis, "unit")}
                  onCommit={(text) => onPlotSpec(setAxisUnit(spec, axis, text))}
                />
              </div>
            );
          })}
        </div>
      </Group>
      <Group title={P.traceType}>
        <div className="ribbon-commands stacked ribbon-trace-type">
          {command("plotLineTrace", C.lineTrace, "╱", allKinds("lines"))}
          {command("plotStemTrace", C.stemTrace, "┆", allKinds("stems"))}
          {command("plotBarTrace", C.barTrace, "▮", allKinds("bars"))}
          {command("plotStepTrace", C.stepTrace, "⌐", allKinds("steps"))}
        </div>
      </Group>
      <Group title={S.ribbon.groups.traceStyle}>
        {spec.type !== "contour" && <div className="ribbon-commands stacked ribbon-presentation">
          {command("plotLines", C.lines, "╱", all("line"))}
          {command("plotMarkers", C.markers, "⋰", all("markers"))}
          {command("plotLinesMarkers", C.linesMarkers, "⟋", all("line+markers"))}
        </div>}
        <div className="ribbon-fields" aria-disabled={off}>
          <div className="ribbon-field-row">
            <span className="ribbon-field-label">Line</span>
            <select
              aria-label={P.lineStyle}
              disabled={off}
              value={trace?.line?.style ?? "solid"}
              onChange={(event) => style("line", "style", event.target.value)}
            >
              {LINE_STYLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input
              aria-label={P.lineWidth}
              title={P.lineWidth}
              type="number"
              min="0.5"
              max="6"
              step="0.5"
              disabled={off}
              value={trace?.line?.width ?? 1.5}
              onChange={(event) => style("line", "width", Number(event.target.value))}
            />
            <ColorPicker
              label={P.lineColor}
              none={P.automaticColor}
              colors={MATH_COLORS.slice(1).map(({ value, name }) => ({ value, name }))}
              hideLabel
              disabled={off}
              title={P.lineColor}
              value={trace?.line?.color ?? PALETTE[Math.max(index, 0) % PALETTE.length]}
              worksheetColors={worksheetColors}
              onPick={(color) => style("line", "color", color)}
            />
          </div>
          {spec.type !== "contour" && <div className="ribbon-field-row">
            <span className="ribbon-field-label">Marker</span>
            <select
              aria-label={P.markerShape}
              disabled={off}
              value={trace?.marker?.shape ?? "circle"}
              onChange={(event) => style("marker", "shape", event.target.value)}
            >
              {MARKER_SHAPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <input
              aria-label={P.markerSize}
              title={P.markerSize}
              type="number"
              min="2"
              max="20"
              step="1"
              disabled={off}
              value={trace?.marker?.size ?? 5}
              onChange={(event) => style("marker", "size", Number(event.target.value))}
            />
            <ColorPicker
              label={P.markerColor}
              none={P.automaticColor}
              colors={MATH_COLORS.slice(1).map(({ value, name }) => ({ value, name }))}
              hideLabel
              disabled={off}
              title={P.markerColor}
              value={trace?.marker?.color ?? trace?.line?.color ?? PALETTE[Math.max(index, 0) % PALETTE.length]}
              worksheetColors={worksheetColors}
              onPick={(color) => style("marker", "color", color)}
            />
          </div>}
        </div>
      </Group>
      {spec.type !== "polar" && (
      <Group title={S.ribbon.groups.axes} stacked>
        {command("plotLogX", C.logX, "↔", spec.axes.x.scale === "log10")}
        {command("plotLogY", C.logY, "↕", spec.axes.y.scale === "log10")}
        {xy && usesRightAxis(spec) && command("plotLogY2", C.logY2, "⇅", spec.axes.y2?.scale === "log10")}
        {command("plotAutoScale", C.autoScale, "⤢")}
        {/* one toggle for the x axis and the left y axis, pressed while both cross. */}
        {command("plotToggleAxes", C.axesAtOrigin, "┼", spec.axes.x.position === "origin" && spec.axes.y.position === "origin")}
        {command("plotToggleGrid", C.showGrid, "▦", spec.axes.x.show_grid !== false && spec.axes.y.show_grid !== false)}
        <Field label={P.gridSpacing}>
          <select
            aria-label={P.gridSpacing}
            value={gridValue}
            onChange={(event) => onPlotSpec(setGridSpacing(spec, event.target.value === "auto" ? null : Number(event.target.value)))}
          >
            <option value="auto">{P.automaticGridSpacing}</option>
            {GRID_STEPS.map((step) => <option key={step} value={step}>{step}</option>)}
          </select>
        </Field>
      </Group>
      )}
      <Group title={S.ribbon.groups.region}>
        <ToolButton label={C.deleteRegion} icon={<Icon>✕</Icon>} onClick={() => onCommand("deleteRegions")} />
      </Group>
    </>
  );
}
