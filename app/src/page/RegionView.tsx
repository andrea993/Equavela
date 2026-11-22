// One region on the page: absolutely positioned at its stored point coordinates (snapped to
// the 3 pt grid at render time, rule R6), showing the math, text, include or Julia content
// and, for math, the result.

import { JuliaView, type JuliaChange } from "./JuliaView";
import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import ProblemMarks, { type Mark } from "../components/ProblemMarks";
import { EditorOverlay, unionRect } from "../editor/EditorOverlay";
import type { EditorState } from "../editor/model";
import type { Completion } from "../editor/autocomplete";
import { toEditing } from "../editor/tree";
import { MathExpr, MathStatement, showsResult, unitOverride } from "../math/render";
import { mathFontOf, mathFontStyle } from "../math/font";
import { isNode } from "../math/ast";
import { crossesPageBreak, measuredPt, NEW_TEXT_BOX_WIDTH_PT, ptToPx, pxToPt, snapToGrid, type Size } from "../layout/geometry";
import { PlotView } from "../plot/PlotView";
import { IncludeView } from "./IncludeView";
import { AreaView } from "./AreaView";
import { ImageView } from "./ImageView";
import { ResultBlockContext, ResultBlocksContext, ValueView, type BlockReader } from "../results/ResultView";
import { formatFromSettings, isBoxedMatrix, type ResultFormat } from "../results/format";
import { S } from "../strings";
import TextEditor from "../text/lexical/TextEditor";
import { DRAFT_ID, useRegionEdit } from "./regionEdit";
import { useRegionBusy } from "../workbench/runningRegion";
import { TextView } from "../text/TextView";
import { inlineRegionId, type InlineResult, type TextEditBinding, type TextWidth } from "../text/value";
import type {
  MathBreak,
  PageSetup,
  RegionEntry,
  SessionDiagnostic,
  ViewRegion,
  WarningInfo,
} from "../equavelaApi";

const NO_WARNINGS: WarningInfo[] = [];
const NO_COMPLETIONS: readonly Completion[] = [];

type Props = {
  fastSymbolicBusy?: boolean;
  region: ViewRegion;
  setup: PageSetup;
  /** Left and top of the region in sheet CSS px (already includes the page offset). */
  left: number;
  top: number;
  /** Extra offset while the region is being dragged, CSS px. */
  dragOffset: { x: number; y: number } | null;
  selected: boolean;
  /** Part of its result is selected: a clipped classic matrix is active. */
  resultActive?: boolean;
  /** The lower part of a region that straddles a page edge, drawn on the next page of the print view. */
  continued?: boolean;
  /**
   * The part of an area band this element draws: only the part that carries the
   * header draws the start line, the title and the collapse indicator, and only the part the band
   * ends on draws the end line. A part that is not the first one is drawn as `continued`, so it
   * never reports a size, takes no press that belongs to the band and carries no region id twice.
   */
  areaPart?: { header: boolean; end: boolean };
  /** Drawn invisibly by the page view's measuring layer only to report its size. */
  probe?: boolean;
  entry: RegionEntry | undefined;
  /** Results of the inline math of text regions, by result key region id. */
  inlineEntries?: ReadonlyMap<string, RegionEntry>;
  diagnostics: SessionDiagnostic[];
  format: ResultFormat;
  /** The worksheet display settings: an inline equation's own format is laid over them. */
  settings?: Record<string, string>;
  onPointerDown: (event: PointerEvent<HTMLElement>, id: string) => void;
  /** A double click: selects the name or number under the pointer in the math being edited. */
  onDoubleClick?: (event: MouseEvent<HTMLElement>, id: string) => void;
  onSize: (id: string, size: Size) => void;
  /** Size in points while a resize drag is in progress (`h` only for regions with a height). */
  resizing?: { w: number; h: number | null } | null;
  /** Unit warnings of this region (inspection), underlined at their spans. */
  warnings?: WarningInfo[];
  /** Present when the region shows a resize handle (a single selected, resizable region). */
  onResizeStart?: (event: PointerEvent<HTMLElement>, id: string) => void;
  /** The title of an area was edited in place. */
  onAreaTitle?: (id: string, title: string) => void;
  /** The path of an include was edited in place, or chosen with Browse…. */
  onIncludePath?: (id: string, path: string) => void;
  onBrowseInclude?: (id: string) => void;
  /** The collapse indicator of an area was clicked. */
  onToggleArea?: (id: string) => void;
  onJuliaChange?: (id: string, change: JuliaChange) => void;
  /** Whether the worksheet is trusted. */
  trusted?: boolean;
};

/**
 * How far the content of a math region rises above the line of its expression, in points: a result,
 * a fraction or a matrix taller than the line is drawn above the stored y, so the line stays where it
 * was typed. The line is the inline box of the statement's first line.
 */
function lineRise(element: HTMLElement): number {
  const root = element.querySelector<HTMLElement>('.math [data-path=""]');
  const line = root?.getClientRects()[0];
  if (!root || !line || element.offsetHeight === 0) return 0;
  // The highest drawn part: the expression and, outside it for unionRect, the results.
  const parts = [unionRect(root), ...[...root.querySelectorAll(".result")].map((result) => unionRect(result))];
  const top = Math.min(...parts.map((rect) => rect?.top ?? Infinity));
  if (!Number.isFinite(top)) return 0;
  // Client rects carry the zoom; the measure is in layout px (R9).
  const zoom = element.getBoundingClientRect().height / element.offsetHeight;
  // A one-line region has the half-leading of its line above the line's inline box: only what
  // reaches above that rises.
  const lineHeight = parseFloat(getComputedStyle(root).lineHeight);
  const leading = Number.isFinite(lineHeight) ? Math.max(0, (lineHeight - line.height / zoom) / 2) : 0;
  const px = Math.round((line.top - top) / zoom - leading);
  return px > 0 ? pxToPt(px) : 0;
}

function RegionView({
  region,
  fastSymbolicBusy,
  setup,
  left,
  top,
  dragOffset,
  selected,
  resultActive = false,
  continued = false,
  areaPart,
  probe = false,
  entry,
  inlineEntries,
  diagnostics,
  format,
  settings,
  onPointerDown,
  onDoubleClick,
  onSize,
  resizing = null,
  warnings = NO_WARNINGS,
  onResizeStart,
  onAreaTitle,
  onIncludePath,
  onBrowseInclude,
  onToggleArea,
  onJuliaChange,
  trusted,
}: Props) {
  // The math or text editor when this region is the one being edited (or a new region): read from the
  // page view's edit store, so a keystroke renders this region only.
  const edit = useRegionEdit(continued || probe ? null : region.id);
  const editor = edit?.editor ?? null;
  const textEdit = edit?.textEdit ?? null;
  /** The region is the active one: the math editor or the text editor is open on it. */
  const active = editor !== null || textEdit !== null;
  const ref = useRef<HTMLDivElement>(null);
  const sizeRef = useRef<Size | null>(null);

  // Measure in layout px (not affected by the zoom transform or the device pixel ratio, R9).
  useEffect(() => {
    const element = ref.current;
    // The continuation of a straddling region copies the size of the region itself, it never reports one.
    if (!element || continued) return;
    const measure = () => {
      const size: Size = {
        w: measuredPt(element.offsetWidth),
        h: measuredPt(element.offsetHeight),
      };
      const rise = lineRise(element);
      if (rise > 0) size.rise = rise;
      const previous = sizeRef.current;
      if (!previous || previous.w !== size.w || previous.h !== size.h || previous.rise !== size.rise) {
        sizeRef.current = size;
        onSize(region.id, size);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [region.id, onSize, continued]);

  const [marked, setMarked] = useState(false);
  const size = sizeRef.current;
  const crosses = size !== null && crossesPageBreak(setup, region.y - (size.rise ?? 0), size.h);
  const state = entry?.state;
  // The wait symbol of a region that has been calculating for a second.
  const busy = useRegionBusy(region.id, entry?.key.document);
  const failure = entry && entry.state === "error" ? entry.failure : null;
  const own = useMemo(() => diagnostics.filter((d) => d.region_id === region.id), [diagnostics, region.id]);
  // The error stays readable while the region is edited: an edit makes the entry pending or stale
  // (no failure), so the last failure is remembered until the region calculates again (it is then
  // resolved) or a newer failure replaces it. Until then it is shown faded.
  const remembered = useRef<typeof failure>(null);
  if (failure) remembered.current = failure;
  else if (state === "value") remembered.current = null;
  const shownFailure = failure ?? remembered.current;
  const failureIsOld = !failure && shownFailure !== null;

  // A drag moves the region by a transform: moving `left`/`top` laid out its content again on every
  // pointer move (a large matrix made the drag lag).
  const x = left;
  const y = top;
  const shift = dragOffset ? `translate(${dragOffset.x}px, ${dragOffset.y}px)` : undefined;

  // The strips that move the region with the mouse. A region being edited shows the border of its
  // active frame as the handle; otherwise the selection border carries it. A new region
  // still in the editor has no stored position yet, so it gets no handle.
  const moveHandle =
    !continued &&
    region.id !== DRAFT_ID &&
    (active
      ? region.kind === "math" || region.kind === "text"
      : // A text region always has its border to move it by; a press on its text selects.
        region.kind === "text" || (selected && (region.kind === "math" || region.kind === "plot")));

  // The corner handle of the result box: only when the page view offers the resize gesture
  // (a single selected region), the region's result is a matrix large enough for a box — drawn as a
  // table or as a classic matrix — and the region is not the continuation of a
  // straddling one.
  const shownValue =
    entry && (entry.state === "value" || entry.state === "stale") ? entry.value : null;
  const boxed = onResizeStart !== undefined && !continued && region.kind === "math" && isBoxedMatrix(shownValue, format);
  // One identity across renders, so the memoized content (and a large matrix in it) is not drawn again
  // by a drag or a selection change.
  const startTableResize = useCallback(
    (event: PointerEvent<HTMLElement>) => onResizeStart?.(event, region.id),
    [onResizeStart, region.id],
  );
  const tableResizeStart = boxed ? startTableResize : undefined;

  const marks = useMemo<Mark[]>(() => {
    if (region.kind !== "math") return [];
    const list: Mark[] = [];
    if (failure?.span) list.push({ span: failure.span, kind: "error", message: failure.message });
    for (const warning of warnings) {
      list.push({ span: { start: warning.start, end: warning.end }, kind: "warning", message: warning.message });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region.kind, failure?.span?.start, failure?.span?.end, failure?.message, warnings]);
  const markDependency = useMemo(
    () => ({}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [region.kind === "math" ? region.statement : null, state, size?.w, size?.h, editor],
  );

  const classes = [
    "region",
    marked && failure ? "marked" : "",
    `kind-${region.kind}`,
    selected ? "selected" : "",
    dragOffset ? "dragging" : "",
    state ? `state-${state}` : "",
    failure ? `failure-${failure.kind}` : "",
    crosses ? "crosses-break" : "",
    region.enabled ? "" : "disabled",
    editor || textEdit ? "editing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={ref}
      className={classes}
      data-region-id={continued || probe ? undefined : region.id}
      data-probe={probe ? region.id : undefined}
      data-continued-of={continued ? region.id : undefined}
      aria-hidden={continued ? true : undefined}
      data-kind={region.kind}
      data-state={state ?? "none"}
      style={{
        left: x,
        top: y,
        transform: shift,
        // Wide results (tables) stay inside the printable width.
        ["--region-max-w" as string]: `${Math.max(120, ptToPx(setup.width - setup.margins.right - snapToGrid(region.x)))}px`,
      }}
      onPointerDown={(event) => onPointerDown(event, region.id)}
      onDoubleClick={onDoubleClick && ((event) => onDoubleClick(event, region.id))}
    >
      {/* The move targets over the frame: the selection border for a selected region
           and the
          border of the active frame for the region being edited. */}
      {moveHandle && (
        <span className="region-drag-border no-print" data-testid="region-drag-border" aria-hidden="true">
          <i /><i /><i /><i />
        </span>
      )}
      <MemoRegionContent
        region={region}
        entry={entry}
        inlineEntries={inlineEntries}
        format={format}
        settings={settings}
        setup={setup}
        diagnostics={own}
        editor={editor}
        breaks={region.kind === "math" ? (editor ? (edit?.breaks ?? NO_BREAKS) : (region.breaks ?? NO_BREAKS)) : undefined}
        textEdit={textEdit}
        resizing={resizing}
        selected={selected || resultActive}
        areaPart={areaPart}
        onTableResizeStart={tableResizeStart}
        onAreaTitle={onAreaTitle}
        onIncludePath={onIncludePath}
        onBrowseInclude={onBrowseInclude}
        onToggleArea={onToggleArea}
        onJuliaChange={onJuliaChange}
        trusted={trusted}
      />
      {(busy || fastSymbolicBusy) && !continued && !probe && (
        <span className="region-busy no-print" role="img" aria-label={S.page.busy} data-testid="region-busy" />
      )}
      {onResizeStart &&
        (region.kind === "plot" || region.kind === "image" || region.kind === "julia") && (
          <div
            className="resize-handle corner no-print"
            role="separator"
            aria-label={
              region.kind === "image"
                ? S.page.resizeImage
                : region.kind === "julia"
                  ? S.page.resizeJulia
                  : S.page.resizePlot
            }
            data-testid="resize-handle"
            onPointerDown={(event) => onResizeStart(event, region.id)}
          />
        )}
      {onResizeStart && region.kind === "text" && !region.full_width && (
        <div
          className="resize-handle east no-print"
          role="separator"
          aria-orientation="vertical"
          aria-label={S.page.resizeWidth}
          data-testid="resize-handle"
          onPointerDown={(event) => onResizeStart(event, region.id)}
        />
      )}
      {onResizeStart && region.kind === "area" && !region.collapsed && (areaPart?.end ?? true) && (
        <div
          className="resize-handle south no-print"
          role="separator"
          aria-orientation="horizontal"
          aria-label={S.page.resizeArea}
          data-testid="resize-handle"
          onPointerDown={(event) => onResizeStart(event, region.id)}
        />
      )}
      {region.kind === "math" && !editor && (
        <ProblemMarks container={ref} marks={marks} dependency={markDependency} onResolved={setMarked} />
      )}
      {editor && (
        <EditorOverlay
          editor={editor}
          container={ref}
          completions={edit?.completions ?? NO_COMPLETIONS}
          completionIndex={edit?.completionIndex ?? 0}
          onCompletion={edit?.onCompletion}
        />
      )}
      {(selected || editor || textEdit) && (shownFailure || own.length > 0 || crosses) && (
        <div className="region-note no-print" role="status">
          {shownFailure && (
            <span className={`error-text${failureIsOld ? " old" : ""}`} data-testid="region-error">
              {describeFailure(shownFailure.kind, shownFailure.message)}
            </span>
          )}
          {own.map((d, i) => (
            <span key={i} className="warning-text">{d.message}</span>
          ))}
          {crosses && <span className="warning-text">{S.page.crossesBreak}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Memoized: a region whose props did not change must not render again when the page view renders
 *. The page view keeps the props of an unchanged region identical (stable handlers, cached
 * placement, shared empties); the edit state of the edited region comes from `useRegionEdit`.
 */
export default memo(RegionView);

/** Shared empty list, so an unbroken region keeps one `breaks` identity (the content is memoized). */
const NO_BREAKS: never[] = [];

export function describeFailure(kind: string, message: string): string {
  const label =
    S.result.error[kind as keyof typeof S.result.error] ?? S.result.errorFallback;
  return message ? `${label}: ${message}` : label;
}


// The content draws again only when what it shows changes: a drag (the region's offset) or the move
// border does not reach it.
const MemoRegionContent = memo(RegionContent);

function RegionContent({
  region,
  entry,
  inlineEntries,
  format,
  settings,
  setup,
  diagnostics,
  editor,
  breaks,
  textEdit,
  resizing,
  selected,
  areaPart,
  onTableResizeStart,
  onAreaTitle,
  onIncludePath,
  onBrowseInclude,
  onToggleArea,
  onJuliaChange,
  trusted,
}: {
  onTableResizeStart?: (event: PointerEvent<HTMLElement>) => void;
  onAreaTitle?: (id: string, title: string) => void;
  onIncludePath?: (id: string, path: string) => void;
  onBrowseInclude?: (id: string) => void;
  onToggleArea?: (id: string) => void;
  onJuliaChange?: (id: string, change: JuliaChange) => void;
  /** Whether the worksheet is trusted. */
  trusted?: boolean;
  resizing: { w: number; h: number | null } | null;
  /** The part of a band this element draws. */
  areaPart?: { header: boolean; end: boolean };
  region: ViewRegion;
  entry: RegionEntry | undefined;
  inlineEntries?: ReadonlyMap<string, RegionEntry>;
  format: ResultFormat;
  settings?: Record<string, string>;
  setup: PageSetup;
  diagnostics: SessionDiagnostic[];
  editor: EditorState | null;
  breaks?: MathBreak[];
  textEdit: TextEditBinding | null;
  selected: boolean;
}): ReactNode {
  switch (region.kind) {
    case "math": {
      // While the table's handle is dragged the box follows the pointer: the size in progress is
      // applied over the stored one, so the sheet and the print both read `format.tableSize`.
      const shown =
        resizing && resizing.h !== null ? { ...format, tableSize: [resizing.w, resizing.h] as [number, number] } : format;
      return (
        <MathContent
          region={region}
          entry={entry}
          format={shown}
          editor={editor}
          breaks={breaks}
          active={selected || editor !== null}
          onTableResizeStart={onTableResizeStart}
        />
      );
    }
    case "text": {
      // A block takes the printable width; a box the user resized keeps that width; a box without a
      // stored width grows with its text up to the right margin (at least NEW_TEXT_BOX_WIDTH_PT, so it
      // has the same room outside the paper in the draft view) and wraps there.
      const fixed = region.full_width ? setup.width - setup.margins.left - setup.margins.right : (resizing?.w ?? region.width);
      const width: TextWidth =
        fixed != null
          ? ptToPx(Math.max(fixed, 12))
          : { max: ptToPx(Math.max(setup.width - setup.margins.right - snapToGrid(region.x), NEW_TEXT_BOX_WIDTH_PT)) };
      // What is drawn after an inline run, by its index among the math runs of the text: the same
      // mark-up in the read-only view, in the print and in the editor that is open on the region.
      const inlineResult: InlineResult | undefined = inlineEntries
        ? (index, statement, own) => {
            if (!isNode(statement) || !showsResult(statement)) return undefined;
            const inline = inlineEntries.get(inlineRegionId(region.id, index));
            if (inline?.state === "error") {
              return (
                <span className="result error" data-testid="inline-error" title={describeFailure(inline.failure.kind, inline.failure.message)}>
                  {"\u26A0"}
                </span>
              );
            }
            // The run's own format over the worksheet's, key by key.
            const shown = own && Object.keys(own).length > 0 ? formatFromSettings({ ...settings, ...own }) : format;
            return <ResultSlot entry={inline} format={shown} statement={statement} />;
          }
        : undefined;
      if (textEdit) return <TextEditor {...textEdit} width={width} background={region.background} inlineResult={inlineResult} />;
      return <TextView paragraphs={region.paragraphs} width={width} background={region.background} inlineResult={inlineResult} />;
    }
    case "include":
      return (
        <IncludeView
          path={region.path}
          missing={diagnostics.length > 0}
          onPath={(path) => onIncludePath?.(region.id, path)}
          onBrowse={() => onBrowseInclude?.(region.id)}
        />
      );
    case "plot":
      return <PlotView region={region} size={resizing && resizing.h !== null ? { w: resizing.w, h: resizing.h } : null} selected={selected} />;
    case "area":
      return (
        <AreaView
          title={region.title}
          collapsed={region.collapsed}
          height={region.height}
          width={setup.width - setup.margins.left - setup.margins.right}
          header={areaPart?.header ?? true}
          end={areaPart?.end ?? true}
          onTitle={(title) => onAreaTitle?.(region.id, title)}
          onToggle={() => onToggleArea?.(region.id)}
        />
      );
    case "image":
      return (
        <ImageView
          resource={region.resource}
          size={resizing && resizing.h !== null ? [resizing.w, resizing.h] : region.size}
        />
      );
    case "julia": {
      // The size in progress while the corner handle is dragged, then the stored box; a
      // block without one is `null` and grows with its header and its code.
      const size =
        resizing && resizing.h !== null
          ? { w: resizing.w, h: resizing.h }
          : region.block.size
            ? { w: region.block.size[0], h: region.block.size[1] }
            : null;
      return (
        <JuliaView
          block={region.block}
          size={size}
          selected={selected}
          trusted={trusted}
          startEditing={selected && !region.block.code}
          state={entry?.state}
          regionKey={entry?.key}
          output={entry?.output}
          failure={entry && entry.state === "error" ? entry.failure.message : undefined}
          onChange={(change) => onJuliaChange?.(region.id, change)}
        />
      );
    }
  }
}

/**
 * The math of a region, always in the editor's tree form with addressable nodes (so a
 * click can place the caret); while editing, the editor's tree with the unit override
 * drawn as its own (editable) slot.
 */
function MathContent({
  region,
  entry,
  format,
  editor,
  breaks,
  active,
  onTableResizeStart,
}: {
  region: Extract<ViewRegion, { kind: "math" }>;
  entry: RegionEntry | undefined;
  format: ResultFormat;
  editor: EditorState | null;
  breaks?: MathBreak[];
  /** The region is selected or edited: a clipped classic matrix scrolls; at rest it shows ellipses. */
  active: boolean;
  onTableResizeStart?: (event: PointerEvent<HTMLElement>) => void;
}) {
  const committed = useMemo(() => toEditing(region.statement), [region.statement]);
  const statement = editor ? editor.root : committed;
  let result: ReactNode = undefined;
  if (isNode(statement) && showsResult(statement)) {
    // While editing the result is shown too (the statement is evaluated as soon as it is
    // complete); the unit override is then drawn by the editor's own unit slot.
    result = (
      <ResultSlot
        entry={entry}
        format={format}
        statement={statement}
        editing={editor !== null}
        active={active}
        onTableResizeStart={onTableResizeStart}
      />
    );
  }
  return (
    // The region's math font: the size in whole CSS px,
    // the text colour and the highlight, on the box that holds the math and its result. A region
    // without a font of its own gets no declaration at all, so the stylesheet draws what it always did.
    <div className="math" data-testid={`math-${region.id}`} style={mathFontStyle(mathFontOf(region.format))}>
      <MathStatement statement={statement as never} result={result} path={[]} unitSlot={editor !== null} breaks={breaks} />
    </div>
  );
}

/** What is drawn after `=` or `→`, depending on the state of the region. */
function ResultSlot({
  entry,
  format,
  statement,
  editing = false,
  active,
  onTableResizeStart,
}: {
  entry: RegionEntry | undefined;
  format: ResultFormat;
  statement: unknown;
  editing?: boolean;
  /** whether a clipped classic matrix scrolls (absent: it does). */
  active?: boolean;
  onTableResizeStart?: (event: PointerEvent<HTMLElement>) => void;
}) {
  const readAny = useContext(ResultBlocksContext);
  const key = entry?.key;
  // The blocks of a large matrix are read from this region's result as its box scrolls.
  const read = useMemo<BlockReader | null>(
    () => (readAny && key ? (row, col, rows, cols) => readAny(key, row, col, rows, cols) : null),
    [readAny, key],
  );
  if (entry && (entry.state === "value" || entry.state === "stale") && entry.value) {
    return (
      <span className={`result ${entry.state}`} data-testid="result">
        <ResultBlockContext.Provider value={read}>
          <ValueView
            value={entry.value}
            displayUnit={entry.display_unit}
            format={format}
            active={active}
            onTableResizeStart={onTableResizeStart}
          />
        </ResultBlockContext.Provider>
      </span>
    );
  }
  if (entry?.state === "stale") {
    const unit = editing ? null : unitOverride(statement);
    return unit ? (
      <span className="result stale" aria-label={S.result.stale}>
        <MathExpr expr={unit} />
      </span>
    ) : (
      // Nothing to show (never a box that looks like an insertion placeholder).
      <span className="result stale" aria-label={S.result.stale} />
    );
  }
  // Not calculated yet (or an error): show the unit override that was asked for, faintly.
  const unit = editing ? null : unitOverride(statement);
  if (unit) {
    return (
      <span className="result pending">
        <MathExpr expr={unit} />
      </span>
    );
  }
  return <span className="result pending" aria-label={S.result.pending} />;
}
