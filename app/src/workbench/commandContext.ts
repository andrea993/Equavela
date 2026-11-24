// The command UI's context and the commands of the contextual tabs
// that change a region (Plot, Area). Pure: the ribbon and the command palette both use them.

import type { PlotSpec, ViewRegion } from "../equavelaApi";
import { hasDerivative, solvingFunction, type NumericOptions, type SolvingFunction } from "./numeric";
import { removeTrace, setPresentation, setTraceKind, toggleY2Scale, usesRightAxis, withNewTrace } from "../plot/edit";

export type RibbonContext =
  | { kind: "text" }
  | { kind: "matrix" }
  | { kind: "plot"; regionId: string; plot: PlotSpec; selectedTraceId: string | null }
  | { kind: "area"; regionId: string; collapsed: boolean }
  | { kind: "image"; regionId: string }
  | { kind: "solver"; regionId: string; fn: SolvingFunction; numeric: NumericOptions }
  | { kind: "derivative"; regionId: string; numeric: NumericOptions };

export type ContextKind = RibbonContext["kind"];

/**
 * : text editing > the matrix caret or a matrix result > one selected plot, area or image
 * (nothing edited) > none. `matrixResult` is about the caller's matrix target: the region being
 * edited while a math editor is open, else the single selected region.
 */
export function ribbonContext(input: {
  textEditing: boolean;
  mathEditing: boolean;
  inMatrix: boolean;
  matrixResult: boolean;
  selection: readonly string[];
  regions: readonly ViewRegion[];
  /** The selected trace id of each plot region. */
  plotTraceSelections: Readonly<Record<string, string>>;
  /** The math region being edited, when a math editor is open. */
  mathRegionId?: string | null;
}): RibbonContext | null {
  if (input.textEditing) return { kind: "text" };
  if (input.mathEditing) {
    if (input.inMatrix || input.matrixResult) return { kind: "matrix" };
    const edited = input.regions.find((r) => r.id === input.mathRegionId);
    return edited ? numericContext(edited) : null;
  }
  // Elements of a matrix result selected without the region: the Matrix tab on that result.
  // With no region selected, `matrixResult` comes from that selection only.
  if (input.selection.length === 0 && input.matrixResult) return { kind: "matrix" };
  if (input.selection.length !== 1) return null;
  const region = input.regions.find((r) => r.id === input.selection[0]);
  // A selected math region whose result is a matrix shows the Matrix tab too: the tab then
  // carries the display commands only, so the selection is a target of its own.
  if (region?.kind === "math") return input.matrixResult ? { kind: "matrix" } : numericContext(region);
  if (region?.kind === "plot") {
    return {
      kind: "plot",
      regionId: region.id,
      plot: region.plot,
      selectedTraceId: input.plotTraceSelections[region.id] ?? null,
    };
  }
  if (region?.kind === "area") return { kind: "area", regionId: region.id, collapsed: region.collapsed };
  if (region?.kind === "image") return { kind: "image", regionId: region.id };
  return null;
}

/** The Solver tab of a solving region, the Differentiation tab of a region with derivatives. */
function numericContext(region: ViewRegion): RibbonContext | null {
  if (region.kind !== "math") return null;
  const numeric = region.numeric ?? {};
  const fn = solvingFunction(region.statement);
  if (fn) return { kind: "solver", regionId: region.id, fn, numeric };
  return hasDerivative(region.statement) ? { kind: "derivative", regionId: region.id, numeric } : null;
}

export const PLOT_COMMANDS = [
  "plotAddTrace",
  "plotRemoveTrace",
  "plotLineTrace",
  "plotStemTrace",
  "plotBarTrace",
  "plotStepTrace",
  "plotLines",
  "plotMarkers",
  "plotLinesMarkers",
  "plotLogX",
  "plotLogY",
  "plotLogY2",
  "plotAutoScale",
  "plotToggleAxes",
  "plotToggleGrid",
] as const;
export type PlotCommand = (typeof PLOT_COMMANDS)[number];

/** The traces the presentation buttons act on: the selected trace, else all of them. */
export function presentationTargets(spec: PlotSpec, selectedTraceId: string | null): PlotSpec["traces"] {
  const selected = spec.traces.filter((trace) => trace.id === selectedTraceId);
  return selected.length > 0 ? selected : spec.traces;
}

const PRESENTATION ={ plotLines: "line", plotMarkers: "markers", plotLinesMarkers: "line+markers" } as const;
const TRACE_KIND = { plotLineTrace: "lines", plotStemTrace: "stems", plotBarTrace: "bars", plotStepTrace: "steps" } as const;

/**
 * The plot after a Plot tab command; null when the command changes nothing.
 * `selectedTraceId` is required by Remove Trace, which removes the selected trace.
 */
export function applyPlotCommand(spec: PlotSpec, command: PlotCommand, selectedTraceId: string | null = null): PlotSpec | null {
  switch (command) {
    case "plotAddTrace":
      return withNewTrace(spec);
    case "plotRemoveTrace":
      return selectedTraceId ? removeTrace(spec, selectedTraceId) : null;
    case "plotLineTrace":
    case "plotStemTrace":
    case "plotBarTrace":
    case "plotStepTrace": {
      // The trace type: the selected trace, or every trace when none is selected,
      // exactly like the presentation commands of .
      const kind = TRACE_KIND[command];
      const targets = presentationTargets(spec, selectedTraceId);
      if (targets.every((trace) => (trace.type ?? "lines") === kind)) return null;
      const index = spec.traces.findIndex((trace) => trace.id === selectedTraceId);
      return setTraceKind(spec, index >= 0 ? index : null, kind);
    }
    case "plotLines":
    case "plotMarkers":
    case "plotLinesMarkers": {
      const presentation = PRESENTATION[command];
      // The selected trace, or every trace when none is selected.
      const index = spec.traces.findIndex((trace) => trace.id === selectedTraceId);
      if (presentationTargets(spec, selectedTraceId).every((trace) => trace.presentation === presentation)) return null;
      return setPresentation(spec, index >= 0 ? index : null, presentation);
    }
    case "plotLogY2":
      return usesRightAxis(spec) ? toggleY2Scale(spec) : null;
    case "plotLogX":
    case "plotLogY": {
      const axis = command === "plotLogX" ? "x" : "y";
      const scale = spec.axes[axis].scale === "log10" ? "linear" : "log10";
      return { ...spec, axes: { ...spec.axes, [axis]: { ...spec.axes[axis], scale } } };
    }
    case "plotAutoScale": {
      const { x, y, y2 } = spec.axes;
      const typed = [x, y, y2].some((axis) => axis && (axis.min !== null || axis.max !== null));
      if (!typed) return null;
      return {
        ...spec,
        axes: {
          x: { ...x, min: null, max: null },
          y: { ...y, min: null, max: null },
          ...(y2 ? { y2: { ...y2, min: null, max: null } } : {}),
        },
      };
    }
    case "plotToggleAxes": {
      // one toggle for the x axis and the left y axis. It leaves the right y axis alone —
      // that axis belongs to its own side of the plot area.
      const crossed = spec.axes.x.position === "origin" && spec.axes.y.position === "origin";
      const position = crossed ? "boundary" : "origin";
      return {
        ...spec,
        axes: {
          ...spec.axes,
          x: { ...spec.axes.x, position },
          y: { ...spec.axes.y, position },
        },
      };
    }
    case "plotToggleGrid": {
      const show = spec.axes.x.show_grid !== false && spec.axes.y.show_grid !== false;
      return {
        ...spec,
        axes: {
          ...spec.axes,
          x: { ...spec.axes.x, show_grid: !show },
          y: { ...spec.axes.y, show_grid: !show },
        },
      };
    }
  }
}

export const isPlotCommand = (cmd: string): cmd is PlotCommand => (PLOT_COMMANDS as readonly string[]).includes(cmd);
