// The legend of a plot: every entry is the trace's own
// expression drawn as typeset math, so a legend entry looks exactly like the same expression in a
// math region. It is drawn here and not by the drawing library, whose legend can only show text and
// a small HTML subset and therefore cannot typeset a fraction. Because it lives in the page, the
// same nodes render on screen and in the PDF, and because it is part of the plot it is
// never editing chrome and holds no control.

import { useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { ptToPx } from "../layout/geometry";
import { isNode, type Expr } from "../math/ast";
import { MathExpr } from "../math/render";
import type { PlotSpec } from "../equavelaApi";
import { S } from "../strings";
import { legendEntries, type PlotMargin } from "./adapter";
import type { PlotFrame } from "./frame";
import { PlotContext } from "./PlotContext";

/** The expression of a parsed plot axis: the parser returns a statement tree with `expr`. */
function statementExpr(tree: unknown): Expr | null {
  if (!isNode(tree)) return null;
  return isNode(tree.expr) ? tree.expr : null;
}

/**
 * One label drawn as math. The stored expression is parsed by the worksheet's parser, the same one
 * the trace's expression slot uses, so both draw the same tree; the stored text is shown only when
 * no parser is available or the parser refuses the expression.
 */
function MathLabel({ text }: { text: string }) {
  const context = useContext(PlotContext);
  // The parser is stable: a changed context (a new revision) must not parse the same text again.
  const env = useRef(context);
  env.current = context;
  const available = context !== null;
  const [expr, setExpr] = useState<Expr | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let current = true;
    const parse = env.current?.toTree;
    if (!parse) {
      setRefused(true);
      return undefined;
    }
    setExpr(null);
    setRefused(false);
    parse(text).then(
      (tree) => {
        if (!current) return;
        const next = statementExpr(tree);
        setExpr(next);
        setRefused(next === null);
      },
      () => {
        if (current) setRefused(true);
      },
    );
    return () => {
      current = false;
    };
  }, [available, text]);

  if (expr) {
    return (
      <span className="math plot-legend-label">
        <MathExpr expr={expr} />
      </span>
    );
  }
  // Nothing is drawn while the parser works, so no linear syntax character ever flashes in a label.
  return refused ? <span className="plot-legend-text">{text}</span> : null;
}

export function PlotLegend({
  spec,
  margin,
  frame,
  onSelect,
}: {
  spec: PlotSpec;
  /** The margins the plot area keeps: the legend sits inside the plot area. */
  margin: PlotMargin;
  frame: PlotFrame | null;
  /** A press on an entry selects its trace and the plot region. */
  onSelect: (traceId: string) => void;
}) {
  const entries = legendEntries(spec, frame);
  if (entries.length === 0) return null;
  const position = spec.legend_position ?? "top-right";
  const isBottom = position.startsWith("bottom");
  const isLeft = position.endsWith("left");
  const fontPx = spec.legend_font_size != null ? ptToPx(spec.legend_font_size) : undefined;
  const style: CSSProperties = {
    ...(isBottom ? { bottom: margin.b } : { top: margin.t }),
    left: margin.l,
    right: margin.r,
    alignItems: isLeft ? "flex-start" : "flex-end",
    ...(fontPx !== undefined ? ({ "--legend-fs": `${fontPx}px`, "--fs": `${fontPx}px` } as CSSProperties) : {}),
  };
  return (
    <div
      className="plot-legend"
      data-testid="plot-legend"
      data-position={position}
      role="list"
      aria-label={S.plot.legend}
      // Inside the plot area, between the margins the drawing library leaves for the axes
      // (adapter.ts MARGIN): over the data, in the chosen corner, in trace order.
      style={style}
    >
      {entries.map((entry) => (
        <span
          key={entry.traceId ?? `reference-${entry.referenceLineId}`}
          className="plot-legend-entry"
          role="listitem"
          {...(entry.traceId ? { "data-legend-trace-id": entry.traceId, onClick: () => onSelect(entry.traceId!) } : { "data-legend-reference-id": entry.referenceLineId })}
        >
          <span className="plot-legend-swatch" style={{ background: "transparent", borderBottom: `2px ${entry.dash ?? "solid"} ${entry.color}` }} aria-hidden="true" />
          {entry.label.kind === "math" ? (
            <MathLabel text={entry.label.text} />
          ) : (
            <span className="plot-legend-text">{entry.label.text}</span>
          )}
        </span>
      ))}
    </div>
  );
}
