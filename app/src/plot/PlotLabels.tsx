// The plot title and the titles and units of the three axes.
// They are drawn by the app and not by the drawing library, exactly like the legend: a
// title in the bundled text font and a unit typeset by the same math renderer as a math region, so
// the same nodes render on screen and in the PDF.
//
// A band exists only while its fields hold text, so the margins of the plot — and with
// them the plot area — depend on the stored specification alone: they never change with the
// selection, the focus or an edit in progress. A field with text is also edited where it is drawn;
// an empty one is started in the Plot tab's Labels group, because there is no band to press.

import { useState, type KeyboardEvent } from "react";
import { S } from "../strings";
import type { PlotSpec } from "../equavelaApi";
import { axisOf, type PlotAxisName } from "./edit";
import { TITLE_BAND, type PlotMargin } from "./adapter";
import { Slot } from "./PlotSlot";

/** The accessibility label of one band. */
export function bandLabel(kind: "plot" | "x" | "y" | "y2", field: "title" | "unit"): string {
  if (kind === "plot") return S.plot.plotTitle;
  if (field === "unit") return kind === "x" ? S.plot.xUnit : kind === "y" ? S.plot.yUnit : S.plot.y2Unit;
  return kind === "x" ? S.plot.xTitle : kind === "y" ? S.plot.yTitle : S.plot.y2Title;
}

/**
 * One title drawn as literal text and edited in place. The text is drawn as a plain span whenever no
 * edit is in progress, which is what the page and the PDF show; the input exists only while the
 * author is typing in it and is never printed.
 */
function TitleField({
  text,
  label,
  className,
  onCommit,
  onActivate,
}: {
  text: string;
  label: string;
  className: string;
  /** Stores the new title: one undo step. */
  onCommit: (text: string) => void;
  /** A press selects the plot region. */
  onActivate: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== text) onCommit(draft);
  };
  if (draft !== null) {
    return (
      <input
        className={`plot-label-input ${className}`}
        aria-label={label}
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            // The stored title is drawn again: nothing was committed.
            event.preventDefault();
            setDraft(null);
          }
          event.stopPropagation();
        }}
      />
    );
  }
  return (
    <span
      className={`plot-label ${className}`}
      role="textbox"
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        // A press on a title edits it and selects the plot; it never moves the region.
        event.stopPropagation();
        onActivate();
        setDraft(text);
      }}
    >
      {text}
    </span>
  );
}

/** One axis band: the title text, then the unit in parentheses as typeset math. */
function AxisBand({
  spec,
  axis,
  onTitle,
  onUnit,
  onActivate,
}: {
  spec: PlotSpec;
  axis: PlotAxisName;
  onTitle: (text: string) => void;
  onUnit: (text: string) => void;
  onActivate: () => void;
}) {
  const settings = axisOf(spec, axis);
  const unit = settings.unit ?? "";
  return (
    <>
      {settings.title !== "" && (
        <TitleField
          text={settings.title}
          label={bandLabel(axis, "title")}
          className={`axis-title ${axis}`}
          onCommit={onTitle}
          onActivate={onActivate}
        />
      )}
      {unit !== "" && (
        <span className="plot-label unit">
          <span aria-hidden="true">(</span>
          <Slot
            className="plot-unit"
            text={unit}
            label={bandLabel(axis, "unit")}
            onActivate={onActivate}
            onCommit={onUnit}
            unitContext
          />
          <span aria-hidden="true">)</span>
        </span>
      )}
    </>
  );
}

export function PlotLabels({
  spec,
  margin,
  onTitle,
  onUnit,
  onActivate,
}: {
  spec: PlotSpec;
  /** The margins the plot area keeps, so a band sits outside it and never over the data. */
  margin: PlotMargin;
  /** The plot title or one axis title, committed: one undo step. */
  onTitle: (axis: "plot" | PlotAxisName, text: string) => void;
  /** One axis display unit, committed: one undo step. */
  onUnit: (axis: PlotAxisName, text: string) => void;
  onActivate: () => void;
}) {
  const plotTitle = (spec.title ?? "").trim();
  const bands = { x: spec.axes.x, y: spec.axes.y, y2: axisOf(spec, "y2") };
  // The right y axis is drawn only while a trace uses it.
  const right = spec.traces.some((trace) => trace.y_axis === "right") && hasBand(bands.y2);
  const style = { height: TITLE_BAND };
  return (
    <>
      {plotTitle !== "" && (
        <div className="plot-labels title" style={{ ...style, left: margin.l, right: margin.r }}>
          <TitleField
            text={spec.title ?? ""}
            label={bandLabel("plot", "title")}
            className="plot-title"
            onCommit={(text) => onTitle("plot", text)}
            onActivate={onActivate}
          />
        </div>
      )}
      {hasBand(bands.x) && (
        <div className="plot-labels x" style={{ ...style, left: margin.l, right: margin.r }}>
          <AxisBand
            spec={spec}
            axis="x"
            onTitle={(text) => onTitle("x", text)}
            onUnit={(text) => onUnit("x", text)}
            onActivate={onActivate}
          />
        </div>
      )}
      {hasBand(bands.y) && (
        <div className="plot-labels y" style={{ width: TITLE_BAND, top: margin.t, bottom: margin.b }}>
          <AxisBand
            spec={spec}
            axis="y"
            onTitle={(text) => onTitle("y", text)}
            onUnit={(text) => onUnit("y", text)}
            onActivate={onActivate}
          />
        </div>
      )}
      {right && (
        <div className="plot-labels y2" style={{ width: TITLE_BAND, top: margin.t, bottom: margin.b }}>
          <AxisBand
            spec={spec}
            axis="y2"
            onTitle={(text) => onTitle("y2", text)}
            onUnit={(text) => onUnit("y2", text)}
            onActivate={onActivate}
          />
        </div>
      )}
    </>
  );
}

/** Whether a band of one axis is drawn: it holds a title or a unit. */
function hasBand(axis: { title?: string; unit?: string | null }): boolean {
  return (axis.title ?? "").trim() !== "" || (axis.unit ?? "").trim() !== "";
}
