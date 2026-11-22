// The measuring mirror of a plot's placeholders. The y expressions and the
// axis limits are typeset a second time, hidden, exactly as the placeholders draw them, and the width
// of the widest committed one tells the left and right margins how much room the column needs. The
// mirror reads the stored specification only, never an edit in progress, so it never changes the plot
// while a placeholder is being edited and the screen and the PDF measure the same text.
// The same typeset nodes draw both the mirror and the placeholders, from the worksheet's
// own parser, so a fraction or a subscript measures as it draws.

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Node } from "../editor/tree";
import { MathStatement } from "../math/render";
import type { PlotSpec } from "../equavelaApi";
import { NO_TEXT_WIDTHS, type PlotTextWidths } from "./adapter";
import { limitText, usesRightAxis } from "./edit";
import { PlotContext } from "./PlotContext";

/** One placeholder the mirror measures, before it is parsed. */
export type MeasureItem = { key: string; column: "y" | "y2"; text: string };

type ParsedItem = MeasureItem & { tree: Node };

/**
 * The placeholders that decide the width of the left and right margin columns: every y
 * expression (the z expression of a contour, the radius of a polar plot) and the two y limits on the
 * left, the right y limits on the right. Empty placeholders take no room, and one text measured twice
 * is measured once.
 */
export function measurementTexts(spec: PlotSpec): MeasureItem[] {
  const items: MeasureItem[] = [];
  const seen = new Set<string>();
  const add = (column: MeasureItem["column"], text: string) => {
    const key = `${column}:${text.trim()}`;
    if (text.trim() === "" || seen.has(key)) return;
    seen.add(key);
    items.push({ key, column, text });
  };
  if (spec.type !== "polar") {
    add("y", limitText(spec.axes.y.max));
    add("y", limitText(spec.axes.y.min));
  }
  for (const trace of spec.traces) add("y", spec.type === "contour" ? trace.z ?? "" : trace.y);
  // The right column exists only while a trace uses the right axis.
  if (spec.type === "xy" && usesRightAxis(spec)) {
    add("y2", limitText(spec.axes.y2?.max ?? null));
    add("y2", limitText(spec.axes.y2?.min ?? null));
  }
  return items;
}

/** What the mirror has measured: the widths and whether they belong to the current specification. */
type Measured = { key: string; parsed: boolean; items: ParsedItem[] };

/**
 * The hidden typeset mirror of one plot. It reports the measured column widths, and
 * `ready = false` from the moment the specification changes until the new text has been measured, so a
 * plot waits for its final margins before it draws (print must never capture the base ones).
 */
export function PlotMeasure({
  spec,
  onMeasured,
}: {
  spec: PlotSpec;
  /** The widest measured placeholder of each column, measured (or not yet) for this specification. */
  onMeasured: (widths: PlotTextWidths, ready: boolean) => void;
}): ReactNode {
  const env = useContext(PlotContext);
  const available = env !== null;
  const envRef = useRef(env);
  envRef.current = env;
  const items = useMemo(() => measurementTexts(spec), [spec]);
  const key = useMemo(() => items.map((item) => item.key).join("\n"), [items]);
  const [measured, setMeasured] = useState<Measured>({ key: "", parsed: false, items: [] });
  const refs = useRef(new Map<string, HTMLElement>());
  const report = useRef(onMeasured);
  report.current = onMeasured;
  const [fontEpoch, setFontEpoch] = useState(0);

  // A bundled font that finishes loading after the first layout changes the metrics: measure again.
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts) return undefined;
    let current = true;
    const again = () => {
      if (current) setFontEpoch((epoch) => epoch + 1);
    };
    void fonts.ready.then(again).catch(() => undefined);
    fonts.addEventListener?.("loadingdone", again);
    return () => {
      current = false;
      fonts.removeEventListener?.("loadingdone", again);
    };
  }, []);

  // The committed texts become the trees the mirror draws; a new specification re-measures from
  // scratch, and the plot is told its old margins are no longer the final ones.
  useEffect(() => {
    let current = true;
    report.current(NO_TEXT_WIDTHS, false);
    if (!available || items.length === 0) {
      report.current(NO_TEXT_WIDTHS, true);
      return () => {
        current = false;
      };
    }
    const toTree = envRef.current?.toTree;
    if (!toTree) return undefined;
    Promise.all(items.map(async (item) => ({ ...item, tree: await toTree(item.text) })))
      .then((parsed) => {
        if (current) setMeasured({ key, parsed: true, items: parsed });
      })
      .catch(() => {
        if (current) {
          setMeasured({ key, parsed: true, items: [] });
          report.current(NO_TEXT_WIDTHS, true);
        }
      });
    return () => {
      current = false;
    };
  }, [available, items, key]);

  useLayoutEffect(() => {
    if (!measured.parsed || measured.key !== key) return;
    const widths: PlotTextWidths = { y: 0, y2: 0 };
    for (const item of measured.items) {
      const element = refs.current.get(item.key);
      if (!element) continue;
      // `offsetWidth` is a layout value, independent of the sheet zoom; one pixel keeps
      // a fractional glyph edge from being clipped.
      const width = element.offsetWidth + 1;
      if (width > widths[item.column]) widths[item.column] = width;
    }
    report.current(widths, true);
  }, [measured, key, fontEpoch]);

  return (
    <span className="plot-measure" aria-hidden="true" data-testid="plot-measure">
      {measured.parsed &&
        measured.key === key &&
        measured.items.map((item) => (
          <span
            key={item.key}
            className="plot-measure-item"
            ref={(element) => {
              if (element) refs.current.set(item.key, element);
              else refs.current.delete(item.key);
            }}
          >
            <span className="math tx-math">
              <MathStatement statement={item.tree as never} path={[]} />
            </span>
          </span>
        ))}
    </span>
  );
}
