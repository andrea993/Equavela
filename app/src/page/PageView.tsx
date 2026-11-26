// The worksheet area: grey background, pages of real size (points) stacked vertically,
// zoom as a CSS transform on the sheet, regions,
// selection (click, Shift/Ctrl+click, rubber band), drag to move and the crosshair.

import { usePictured } from "../picture/regionPictures";
import type { JuliaChange } from "./JuliaView";
import {
  memo,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  currentPage,
  lastPageReached,
  pageCount,
  pageToSheet,
  placeRegion,
  printableArea,
  resizeImage,
  reflow,
  reflowIncremental,
  type ReflowState,
  type FlowRect,
  type FlowItem,
  ptToPx,
  pxToPt,
  sheetLayout,
  sheetLeft,
  sheetToPage,
  sheetToDraftPage,
  snapToGrid,
  EQUAVELA_PADDING_PX,
  fitResultBox,
  type BoxContent,
  type Size,
} from "../layout/geometry";
import {
  AREA_HEADER_PT,
  areaLastPage,
  areaParts,
  contentHeight,
  flowFrame,
  flowOf,
  isArea,
  memberIds,
  MIN_AREA_PT,
  storedY,
  withMembers,
  type AreaPart,
} from "../layout/areas";
import { fileNameOf, isEmptyLine, renderLine, todayIso } from "../layout/pageText";
import { formatFromSettings, RESULT_TABLE_SIZE_KEY } from "../results/format";
import { S } from "../strings";
import type { PageSetup, RegionEntry, RegionMove, ViewRegion, WarningInfo } from "../equavelaApi";
import type { NameHover } from "../components/HoverCard";
import { parseSpan } from "../inspect/hover";
import type { Crosshair, DocState, Editing, MathHit, TextEditing, ViewMode } from "../workbench/useWorkbench";
import { inlineRegionId, type TextEditBinding } from "../text/value";
import { selectInlineMath } from "../text/InlineMath";
import RegionView from "./RegionView";
import { installPrintEvents, usePrinting } from "../print/printMode";
import { breakWires } from "../editor/model";
import { mathHit, matrixDragHit, nearestMathHit } from "../editor/hit";
import { drawSelection, resultAt, resultHit, resultDragHit, selectionOf, type ResultHit, type ResultSelection } from "../results/resultSelection";
import { MathNamesContext } from "../math/render";
import { labelStyleCss, labelStylesOf, LabelStylesContext } from "../math/labels";
import { UNIT_NAMES } from "../math/units";
import type { Completion } from "../editor/autocomplete";
import type { SessionDiagnostic } from "../equavelaApi";
import { useStableCallback } from "./stableCallback";
import { createRegionEditStore, DRAFT_ID, RegionEditContext, type RegionEdit } from "./regionEdit";
import { sheetIndexOf } from "./sheetIndex";
import { boxPassingWheel, wheelPixels } from "./boxWheel";

type Props = {
  fastSymbolicBusy?: string;
  doc: DocState;
  zoom: number;
  viewMode: ViewMode;
  /** Scroll this region into view when `focus.nonce` changes. */
  focus: { id: string; nonce: number } | null;
  onSelect: (ids: string[], mode: "replace" | "toggle" | "add") => void;
  onMove: (moves: RegionMove[]) => void;
  /** A resize handle was released: the new size in points (only the fields the region kind has). */
  onResize?: (id: string, size: { w: number | null; h: number | null }) => void;
  /** Unit warnings of the root document, underlined in the math. */
  warnings?: readonly WarningInfo[];
  /** The pointer is over a name of a math region (null when it leaves). */
  onNameHover?: (hover: NameHover | null) => void;
  /** Ctrl+click on a name: true when it was handled (a definition was found). */
  onNameClick?: (regionId: string, start: number | null, end: number | null, name: string) => boolean;
  /** Receives the drawn rectangles (after reflow), for paste placement. */
  layoutRef?: MutableRefObject<FlowRect[]>;
  /** Receives a function that maps a client point to the page position under it (dropped files). */
  placeAtRef?: MutableRefObject<((clientX: number, clientY: number) => { page: number; x: number; y: number }) | null>;
  /** A click on the collapse indicator of an area: collapse or expand it. */
  onToggleArea?: (id: string) => void;
  /** The title of an area was edited in place. */
  onAreaTitle?: (id: string, title: string) => void;
  /** The path of an include region was edited in place. */
  onIncludePath?: (id: string, path: string) => void;
  /** Browse… on an include region: choose its file in the native dialog. */
  onBrowseInclude?: (id: string) => void;
  /** A Julia block's code or play/stop state. */
  onJuliaChange?: (id: string, change: JuliaChange) => void;
  /** Files dropped onto the page by the browser's drag and drop, at the drop point. */
  onDropFiles?: (files: File[], at: { page: number; x: number; y: number }) => void;
  onCrosshair: (crosshair: Crosshair) => void;
  onZoomWheel: (direction: 1 | -1) => void;
  onPageChange: (page: number, total: number) => void;
  pageNavigation?: { page: number; fit: boolean };
  onPageNavigationDone?: () => void;
  /** The region being edited, if it belongs to this document. */
  editing?: Editing | null;
  /** Autocomplete candidates for the active editor, ordered with the preferred item first. */
  completions?: readonly Completion[];
  completionIndex?: number;
  onCompletion?: (completion: Completion) => void;
  /** Click (without a drag) on a math region: edit it with the caret at the hit. */
  onEditRegion?: (id: string, hit: MathHit | null) => void;
  /** Pointer down on empty page space (leaves editing). */
  onBackground?: () => void;
  /** Mouse drag inside the math being edited, from the pressed node to the current one. */
  /** A drag inside the math being edited selects from `from` to `to`; `word` selects the name or
   *  number at `from`. */
  onMathSelect?: (from: MathHit, to: MathHit, word?: boolean) => void;
  /** The part of a result selected for copying, and its setter. */
  resultSelection?: ResultSelection | null;
  onResultSelect?: (selection: ResultSelection | null) => void;
  /** The text region being edited, and what its editor needs. */
  textEditing?: TextEditing | null;
  textBinding?: Omit<TextEditBinding, "initial" | "point"> | null;
  /** Click (without a drag) on a text region: edit it with the caret at the click. */
  onEditText?: (id: string, point: { x: number; y: number } | null) => void;
};

type InlineDrag = { region: HTMLElement; index: number; anchor: MathHit };

function nameRegionId(id: string, name: Element): string {
  const index = name.closest<HTMLElement>("[data-inline-index]")?.dataset.inlineIndex;
  return index === undefined ? id : inlineRegionId(id, Number(index));
}

type DragState = {
  ids: string[];
  startX: number;
  startY: number;
  moved: boolean;
  /** CSS px offset of the drag in sheet space. */
  dx: number;
  dy: number;
  /** Id that was pressed (a click without a drag selects only it). */
  pressed: string;
  extend: boolean;
  /** Where the press landed in a math region (a click then edits it). */
  hit: MathHit | null;
  /** The press landed in a text region (a click then edits it). */
  text: boolean;
  /** The press landed on the text of a text region: it places the caret and never moves it. */
  pinned?: boolean;
  /** A drag from the text opened the editor and now selects. */
  opened?: boolean;
  inline?: InlineDrag;
};

let selectTextTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSelectText(): void {
  if (selectTextTimer !== null) {
    clearTimeout(selectTextTimer);
    selectTextTimer = null;
  }
}

const AREA_PARTS = {
  start: { header: true, end: false },
  single: { header: true, end: true },
  middle: { header: false, end: false },
  end: { header: false, end: true },
} as const;

function areaPartOf(header: boolean, end: boolean): { header: boolean; end: boolean } {
  if (header) return end ? AREA_PARTS.single : AREA_PARTS.start;
  return end ? AREA_PARTS.end : AREA_PARTS.middle;
}

/**
 * Selects the text of the open text editor from one client point to another, as a drag does in a word
 * processor. The editor reads the DOM selection back. Nothing happens while
 * the editor is not open yet or a point has no caret position inside it.
 */
function selectTextBetween(from: { x: number; y: number }, to: { x: number; y: number }, wait = 0): void {
  cancelSelectText();
  const root = document.querySelector<HTMLElement>("[data-testid=text-editor]");
  const caret = document.caretRangeFromPoint?.bind(document);
  if (!caret) return;
  const start = root ? caret(from.x, from.y) : null;
  const end = root ? caret(to.x, to.y) : null;
  if (root && start && end && root.contains(start.startContainer) && root.contains(end.startContainer)) {
    window.getSelection()?.setBaseAndExtent(start.startContainer, start.startOffset, end.startContainer, end.startOffset);
    // The editor puts its caret at the press point when it takes the focus, which can come after this.
    if (wait > 0) selectTextTimer = setTimeout(() => selectTextBetween(from, to), 60);
    return;
  }
  // After the release the editor may not be on screen yet: look again for a moment.
  if (wait > 0) selectTextTimer = setTimeout(() => selectTextBetween(from, to, wait - 1), 30);
}

/**
 * Whether a point lies on the text of a text region (its characters or its inline math), not on the
 * empty space around and between the lines. `null` when the browser cannot
 * measure text (no layout, as in jsdom), so the caller keeps its old behaviour.
 */
function onTextAt(container: Element, clientX: number, clientY: number): boolean | null {
  const root = container.querySelector(".text-region");
  if (!root || typeof document.createRange !== "function") return null;
  const range = document.createRange();
  if (typeof range.getClientRects !== "function") return null;
  let measured = false;
  const hits = (rects: DOMRectList | DOMRect[]) =>
    [...rects].some((rect) => {
      if (rect.width > 0 || rect.height > 0) measured = true;
      return clientX >= rect.left - 1 && clientX <= rect.right + 1 && clientY >= rect.top - 1 && clientY <= rect.bottom + 1;
    });
  for (const math of root.querySelectorAll(".tx-math")) {
    if (hits(math.getClientRects())) return true;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent) continue;
    range.selectNodeContents(node);
    if (hits(range.getClientRects())) return true;
  }
  // Text that has no measured box at all means there is no layout to ask: no answer.
  return measured || root.textContent === "" ? false : null;
}

type ResizeState = {
  id: string;
  startX: number;
  startY: number;
  startWidth: number;
  min: number;
  /** No limit but the content of a result box: the margins never stop a resize. */
  max: number;
  /** Current width in points (snapped). */
  width: number;
  /**
   * Height values for regions with a height (plots, images); null for width-only regions. `flow` is
   * the flow offset of the start of an area band: its end line is placed by the flow, so the drag
   * may take it across page breaks.
   */
  height: { start: number; min: number; max: number; value: number; flow?: number } | null;
  /** An image resize: the sizes follow `resizeImage` and are not snapped to the grid. */
  image: { maxHeight: number } | null;
  /** A result box: it grows no larger than its content along each axis. */
  fit?: BoxContent;
};

/** Smallest width of a resizable region, points. */
const MIN_WIDTH_PT = 36;
/** Smallest image side, points. */
const MIN_IMAGE_PT = 12;
/** Smallest plot size, points, reused as the smallest Julia box. */
const MIN_PLOT_PT = { w: 144, h: 108 };
/** The smallest box of a Julia block: its header and one line of code, 52 px. */
const MIN_JULIA_PT = { w: 144, h: 39 };
/** Smallest result-table box, points: the index corner and one cell. */
const MIN_TABLE_PT = { w: 120, h: 60 };

type Band = { x0: number; y0: number; x1: number; y1: number; additive: boolean };

const DRAG_THRESHOLD_PX = 3;

/**
 * Virtualization: the page view mounts the regions near the visible part of the sheet
 * only. Regions within this many viewport heights above and below stay mounted.
 */
const MOUNT_MARGIN_VIEWPORTS = 1;
/** Regions measured per step by the measuring layer, the pause between steps, and how long the
 * keyboard and the mouse must have been quiet before a step. */
const PROBE_CHUNK = 60;
const PROBE_GAP_MS = 40;
const PROBE_QUIET_MS = 400;
/** Measured sizes from the measuring layer are applied (one reflow) at most this often. */
const PROBE_APPLY_MS = 250;

/** A size for a region that was never measured; the measuring layer replaces it soon. */
function estimatedSize(region: ViewRegion, setup: PageSetup): Size {
  const printable = setup.width - setup.margins.left - setup.margins.right;
  switch (region.kind) {
    case "plot":
      return { w: region.plot.size[0], h: region.plot.size[1] };
    case "image":
      return { w: region.size[0], h: region.size[1] };
    case "area":
      return { w: printable, h: region.collapsed ? 21 : region.height };
    case "text":
      return { w: region.full_width ? printable : (region.width ?? 240), h: 18 };
    case "julia":
      // A stored box is the size the block is drawn at; without one the
      // block grows with its content (`.julia-region` keeps its 300 px = 225 pt minimum width).
      return region.block.size
        ? { w: region.block.size[0], h: region.block.size[1] }
        : { w: 225, h: MIN_JULIA_PT.h };
    default:
      return { w: 120, h: 24 };
  }
}

/** Half the side of the crosshair mark, CSS px (it is drawn 17 px wide around its point). */
const CROSSHAIR_HALF_PX = 8;

// Shared empty props: a fresh `[]` per render would defeat the memoized `RegionView`.
const NO_DIAGNOSTICS: SessionDiagnostic[] = [];
const NO_COMPLETIONS: readonly Completion[] = [];

/** The stored size a resize handle changes, as one string to compare. */
function sizeKey(region: ViewRegion | undefined): string {
  switch (region?.kind) {
    case undefined:
      return "";
    case "plot":
      return JSON.stringify(region.plot.size ?? null);
    case "image":
      return JSON.stringify(region.size);
    case "julia":
      return JSON.stringify(region.block.size ?? null);
    case "area":
      return JSON.stringify(region.height);
    case "math":
      return JSON.stringify(region.format?.[RESULT_TABLE_SIZE_KEY] ?? null);
    case "text":
      return JSON.stringify(region.width);
    default:
      return "";
  }
}

/** Where the regions `ids` are stored (page and position), as one string to compare. */
function positionsKey(regions: readonly ViewRegion[], ids: readonly string[], setup: PageSetup): string {
  return withMembers(regions, [...ids], setup)
    .map((id) => {
      const r = regions.find((candidate) => candidate.id === id);
      return r ? `${id}:${r.page}:${r.x}:${r.y}` : id;
    })
    .join("|");
}

/**
 * Whether a pointer press at (x, y) landed on the scroll bar of `target`, or of a scrolling box of a
 * result under it, rather than on its content. Only a box that scrolls (overflow auto or scroll) has a
 * bar; an inline element reports a client size of 0 and is never one. The engine may report the press
 * on the bar with another target than the box, so the boxes of `region` are tested by position too.
 */
export function onScrollBar(target: Element, x: number, y: number, region?: Element): boolean {
  const boxes = new Set<HTMLElement>();
  for (let el: Element | null = target; el && el !== region?.parentElement; el = el.parentElement) {
    if (el instanceof HTMLElement) boxes.add(el);
    if (el === region) break;
  }
  // The bars of a clipped matrix stand outside its brackets, as elements of their own.
  region?.querySelectorAll<HTMLElement>(".matrix-scrollbar").forEach((box) => boxes.add(box));
  for (const box of boxes) {
    if (box.offsetWidth === 0 || box.offsetHeight === 0) continue;
    const style = getComputedStyle(box);
    const scrollsX = style.overflowX === "auto" || style.overflowX === "scroll";
    const scrollsY = style.overflowY === "auto" || style.overflowY === "scroll";
    if (!scrollsX && !scrollsY) continue;
    const rect = box.getBoundingClientRect();
    // The scale of a zoomed sheet applies to the bar as to everything else.
    const scale = box.offsetWidth > 0 ? rect.width / box.offsetWidth : 1;
    const bars = { x: box.offsetWidth - box.clientWidth - box.clientLeft * 2, y: box.offsetHeight - box.clientHeight - box.clientTop * 2 };
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    if (scrollsY && bars.x > 0 && x >= rect.right - (bars.x + box.clientLeft) * scale) return true;
    if (scrollsX && bars.y > 0 && y >= rect.bottom - (bars.y + box.clientTop) * scale) return true;
  }
  return false;
}

export default function PageView({
  doc,
  zoom,
  viewMode,
  focus,
  onSelect,
  onMove,
  onResize,
  warnings,
  onNameHover,
  onNameClick,
  layoutRef,
  placeAtRef,
  onDropFiles,
  onToggleArea,
  onAreaTitle,
  onIncludePath,
  onBrowseInclude,
  onJuliaChange,
  onCrosshair,
  fastSymbolicBusy,
  onZoomWheel,
  onPageChange,
  pageNavigation,
  onPageNavigationDone,
  editing = null,
  completions = [],
  completionIndex = 0,
  onCompletion,
  onEditRegion,
  onBackground,
  onMathSelect,
  resultSelection = null,
  onResultSelect,
  textEditing = null,
  textBinding = null,
  onEditText,
}: Props) {
  const areaRef = useRef<HTMLDivElement>(null);
  /** The worksheet area's scroll position as of the last scroll event (reading it may force a layout). */
  const scrollPosition = useRef({ top: 0, left: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const scrollFrame = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(1000);
  const [areaHeight, setAreaHeight] = useState(800);
  const sizes = useRef(new Map<string, Size>());
  // What each size was measured for: the region object and its result entry at that time. Unchanged
  // regions keep their objects (reuse.ts), so a different object means the size may be stale and the
  // measuring layer measures the region again while it is not mounted.
  const measuredFor = useRef(new Map<string, { region: ViewRegion | undefined; entry: RegionEntry | undefined }>());
  const latest = useRef<{ regions: ReadonlyMap<string, ViewRegion>; entries: ReadonlyMap<string, RegionEntry> }>({
    regions: new Map(),
    entries: new Map(),
  });
  const [sizeVersion, bump] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // The offset of a drag that has just ended, kept until the move lands in the view (or a moment has
  // passed): the region stays where the pointer let go instead of springing back to its old place and
  // then jumping to the new one. `key` is where the moved regions were stored when the drag ended.
  const [dropped, setDropped] = useState<{ ids: string[]; dx: number; dy: number; key: string } | null>(null);
  const [band, setBand] = useState<Band | null>(null);
  // While a rubber band is drawn or regions are moved, no native text selection starts: one
  // listener, so the gesture restyles nothing on the sheet.
  const blocksTextSelection = band !== null || (drag !== null && !drag.text);
  useEffect(() => {
    if (!blocksTextSelection) return undefined;
    const prevent = (event: Event) => event.preventDefault();
    document.addEventListener("selectstart", prevent, true);
    return () => document.removeEventListener("selectstart", prevent, true);
  }, [blocksTextSelection]);
  const bandRef = useRef<Band | null>(null);
  // A press inside the math being edited: a drag from here selects (the anchor and its region).
  const selectPress = useRef<{ container: HTMLElement; anchor: MathHit } | null>(null);
  const inlineDrag = useRef<InlineDrag | null>(null);
  /** A press in a result that selects part of it: its region, result and hit. */
  const resultPress = useRef<{ regionId: string; result: Element; from: ResultHit } | null>(null);

  const [resize, setResize] = useState<ResizeState | null>(null);
  // A finished resize whose size has not reached the view yet: drawn at the dropped size meanwhile.
  const [resized, setResized] = useState<{ id: string; w: number; h: number | null; key: string } | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const draft = viewMode === "draft";
  const printing = usePrinting();
  const pictured = usePictured();
  const [draftExtent, setDraftExtent] = useState({ width: 1600, height: 2200 });
  useEffect(() => installPrintEvents(), []);
  const { view } = doc;
  const setup = view.page;
  // The values the header and the footer tokens draw. The date is taken once, when
  // the page view is first drawn, so the screen and the print view of the same run always agree.
  const pageDate = useMemo(() => todayIso(), []);
  const pageFile = useMemo(() => fileNameOf(doc.root), [doc.root]);
  // What the page view derives from the regions (a map of them, the hidden members of collapsed areas,
  // the drawn positions, the result formats and the defined names) is kept across edits and patched
  // with what one edit changed: rebuilding it all was the bulk of the render after an edit.
  const index = sheetIndexOf(view.regions, view.page, view.settings);
  // The members of a collapsed area are not drawn and take no space; what lies below the band is drawn
  // higher. Positions below are drawn positions unless said otherwise.
  const hidden = index.hidden;
  const shown = useMemo(() => view.regions.filter((region) => !hidden.has(region.id)), [view.regions, hidden]);
  // Reflow: regions drawn from stored positions and measured sizes. The
  // measured sizes live in a ref; `bump` re-renders when one changes.
  const lastFlow = useRef<{
    state: ReflowState;
    flow: ReturnType<typeof reflow>;
    /** What the placement was computed from: the index's layout counter, sizes, page setup, hidden set. */
    layout: number;
    sizes: number;
    setup: PageSetup;
    hidden: ReadonlySet<string>;
  } | null>(null);
  const flow = useMemo(() => {
    const previous = lastFlow.current;
    // An edit that only rewrites the content of a region (typing, a result arriving) lays nothing out
    // again: the positions depend on the index's layout counter, the measured sizes, the page setup and
    // the hidden regions, and none of them changed.
    if (
      previous &&
      previous.layout === index.geometry &&
      previous.sizes === sizeVersion &&
      previous.setup === setup &&
      previous.hidden === hidden
    ) {
      return previous.flow;
    }
    const drawnYAt = index.drawnY;
    const items: FlowItem[] = shown.map((region) => {
      // An area band is drawn behind its members and never pushes them, so it has no size here.
      const size = region.kind === "area" ? { w: 0, h: 0 } : (sizes.current.get(region.id) ?? estimatedSize(region, setup));
      return {
        id: region.id,
        page: region.page,
        x: region.x,
        y: drawnYAt(region.page, region.y),
        w: size.w,
        h: size.h,
        rise: size.rise,
      };
    });
    const state = reflowIncremental(setup, items, previous?.state);
    const next = state.flow;
    // A size change that moves nothing (typing widens the edited region) keeps the previous placement:
    // the region list is rebuilt only when a region really moves.
    if (previous && previous.flow.size === next.size) {
      let same = true;
      for (const [id, placed] of next) {
        const old = previous.flow.get(id);
        if (!old || old.page !== placed.page || old.y !== placed.y || old.pushed !== placed.pushed) {
          same = false;
          break;
        }
      }
      if (same) {
        lastFlow.current = { state, flow: previous.flow, layout: index.geometry, sizes: sizeVersion, setup, hidden };
        return previous.flow;
      }
    }
    lastFlow.current = { state, flow: next, layout: index.geometry, sizes: sizeVersion, setup, hidden };
    return next;
    // `sizeVersion` is the dependency that stands for the measured sizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.regions, shown, setup, sizeVersion, index, hidden]);
  const placedOf = useCallback(
    (region: ViewRegion): { page: number; y: number } =>
      flow.get(region.id) ?? { page: region.page, y: region.y },
    [flow],
  );
  // The height each expanded band needs to hold its members as they are drawn: a
  // member that grows (typing, a result, a resize) carries the end line down with it, on screen and in
  // print, whatever height the file stores. The band never stops below the next area's start line.
  const heldHeights = useMemo(() => {
    const frame = flowFrame(setup);
    const areas = view.regions.filter(isArea);
    const held = new Map<string, number>();
    for (const area of areas) {
      if (area.collapsed) continue;
      const members = new Set(memberIds(view.regions, area, frame));
      const bottoms = view.regions
        .filter((member) => members.has(member.id))
        .map((member) => {
          const placed = flow.get(member.id);
          // A stored size is the drawn one (a plot, an image, a Julia block's box); the rest is measured.
          const stored = member.kind === "plot" || member.kind === "image" || (member.kind === "julia" && member.block.size);
          const h = (stored ? undefined : sizes.current.get(member.id))?.h ?? estimatedSize(member, setup).h;
          return placed ? flowOf(frame, placed.page, placed.y + h) : -Infinity;
        })
        .filter(Number.isFinite);
      const drawn = flow.get(area.id) ?? { page: area.page, y: area.y };
      const start = flowOf(frame, drawn.page, drawn.y);
      const limit = areas
        .map((other) => {
          const at = flow.get(other.id) ?? other;
          return flowOf(frame, at.page, at.y);
        })
        .filter((offset) => offset > start + 1e-6)
        .reduce((nearest, offset) => Math.min(nearest, offset), Infinity);
      const needed = contentHeight(frame, { page: drawn.page, y: drawn.y, height: area.height }, bottoms, limit);
      if (needed > 0) held.set(area.id, needed);
    }
    return held;
    // `sizeVersion` is the dependency that stands for the measured sizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.regions, flow, setup, sizeVersion]);
  /** The height a band is drawn with: the stored one, or more when its content needs it. */
  const bandHeight = (region: ViewRegion & { kind: "area" }): number =>
    Math.max(region.height, heldHeights.get(region.id) ?? 0);
  // A region that ends below the bottom edge of its page continues on the next page in print, so
  // the page count includes the pages such a region reaches (the page view shows the same pages). An
  // area band is not clipped at the page edge: it continues at the top margin of the next pages,
  // so the last page is the one its end line is on.
  const reach = (region: ViewRegion): number => {
    const placed = flow.get(region.id) ?? { page: region.page, y: region.y };
    if (region.kind === "area") {
      return areaLastPage(flowFrame(setup), { page: placed.page, y: placed.y, height: bandHeight(region) });
    }
    return lastPageReached(setup, placed.page, placed.y, sizes.current.get(region.id)?.h ?? 0);
  };
  // The pages that end with a manual break: the mark is drawn at the bottom of
  // each of them, in the page view and on the paper boundary of the draft view.
  const breakPages = useMemo(() => new Set((view.page_breaks ?? []).map((entry) => entry.page)), [view.page_breaks]);
  // Show the page the crosshair reaches through Enter or ArrowDown even when there is no region
  // on it yet. A loop, not three spreads of 20 000 values.
  let total = pageCount(shown, doc.crosshair.page);
  for (const page of breakPages) if (page > total) total = page;
  for (const placed of flow.values()) if (placed.page > total) total = placed.page;
  for (const region of shown) {
    const reached = reach(region);
    if (reached > total) total = reached;
  }
  // The print view has no gap between pages; every page is its own block (below).
  // The page view's layout depends on the page count only; the draft view's also follows the crosshair
  // and the content. Kept apart so that a crosshair step does not make a new page layout, which would
  // render the whole region layer again.
  const pageLayout = useMemo(() => sheetLayout(setup, total, printing), [setup, total, printing]);
  const draftLayout = useMemo(() => {
    if (!draft || printing) return null;
    const pageHeight = Math.round(ptToPx(setup.height));
    const furthestX = Math.max(doc.crosshair.x, ...view.regions.map((r) => r.x + (sizes.current.get(r.id)?.w ?? 0)), setup.width);
    const pages = Math.max(total, doc.crosshair.page, Math.ceil(Math.max(draftExtent.height, areaHeight / zoom + 400) / pageHeight));
    const base = sheetLayout(setup, pages, true);
    const width = Math.max(base.width * 2, draftExtent.width, areaWidth / zoom + 400, ptToPx(furthestX) + 400);
    return { ...base, width, pages: base.pages.map((page) => ({ ...page, width })) };
  }, [setup, total, draft, printing, draftExtent, doc.crosshair, view.regions, sizeVersion, areaWidth, areaHeight, zoom]);
  const layout = draftLayout ?? pageLayout;
  const format = useMemo(() => formatFromSettings(view.settings), [view.settings]);
  // A region's own result format is applied over the worksheet settings.
  const regionFormats = index.formats;
  const names = useMemo(() => ({ units: UNIT_NAMES }), []);
  // The worksheet's label styles: how a name of each label is drawn.
  const labelStyles = useMemo(() => labelStylesOf(view.settings), [view.settings]);
  const labelCss = useMemo(() => labelStyleCss(labelStyles), [labelStyles]);
  const left = draft && !printing ? 0 : sheetLeft(areaWidth, layout.width, zoom);
  const entries = useMemo(() => {
    const map = new Map<string, (typeof doc.results)[number]>();
    for (const entry of doc.results) {
      if (entry.key.instance === 0 && entry.key.document === doc.root) {
        map.set(entry.key.region_id, entry);
      }
    }
    return map;
  }, [doc.results, doc.root]);
  const regionById = index.byId;
  latest.current = { regions: regionById, entries };

  // ---- measuring ---------------------------------------------------------------------------

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    setAreaWidth(area.clientWidth);
    setAreaHeight(area.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setAreaWidth(area.clientWidth);
      setAreaHeight(area.clientHeight);
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const onSize = useCallback((id: string, size: Size) => {
    const region = latest.current.regions.get(id);
    const entry = latest.current.entries.get(id);
    const previous = sizes.current.get(id);
    const was = measuredFor.current.get(id);
    measuredFor.current.set(id, { region, entry });
    if (previous && previous.w === size.w && previous.h === size.h && previous.rise === size.rise && was?.region === region && was?.entry === entry) return;
    sizes.current.set(id, size);
    bump((n) => n + 1);
  }, []);

  const sizeOf = useCallback(
    (id: string): Size => {
      const measured = sizes.current.get(id);
      if (measured) return measured;
      const region = latest.current.regions.get(id);
      return region ? estimatedSize(region, setup) : { w: 0, h: 0 };
    },
    [setup],
  );

  // Fonts change the metrics when they finish loading (R4): measure again then.
  useEffect(() => {
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        measuredFor.current.clear();
        bump((n) => n + 1);
      });
    }
  }, []);

  // ---- page indicator ----------------------------------------------------------------------

  // Reading the scroll position forces a layout of the whole sheet when the DOM has just changed (about
  // 190 ms on a 1k-region worksheet in WebKitGTK): the page indicator is updated only when what it
  // depends on changes, not after every render.
  const pageChange = useStableCallback(onPageChange);
  const reportPage = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    pageChange(Math.min(total, currentPage(layout, zoom, area.scrollTop, area.clientHeight, draft && !printing ? 0 : EQUAVELA_PADDING_PX)), total);
  }, [layout, zoom, total, draft, printing, pageChange]);

  useEffect(() => {
    reportPage();
  }, [reportPage]);

  const appliedNavigation = useRef<typeof pageNavigation>(undefined);
  useLayoutEffect(() => {
    if (!pageNavigation || appliedNavigation.current === pageNavigation) return;
    const viewport = areaRef.current;
    const rect = layout.pages[Math.min(pageNavigation.page, total) - 1];
    if (!viewport || !rect) return;
    appliedNavigation.current = pageNavigation;
    const padding = draft && !printing ? 0 : EQUAVELA_PADDING_PX;
    const gap = Math.max(0, (viewport.clientHeight - rect.height * zoom) / 2);
    viewport.scrollTop = Math.max(0, padding + rect.top * zoom - gap);
    if (pageNavigation.fit) viewport.scrollLeft = 0;
    scrollPosition.current = { top: viewport.scrollTop, left: viewport.scrollLeft };
    setScrollTop(viewport.scrollTop);
    reportPage();
    onPageNavigationDone?.();
  }, [draft, layout, onPageNavigationDone, pageNavigation, printing, reportPage, total, zoom]);

  // Scroll a region into view (Find).
  useEffect(() => {
    if (!focus) return;
    const region = view.regions.find((r) => r.id === focus.id);
    const area = areaRef.current;
    if (!region || !area) return;
    const placed = placedOf(region);
    const at = pageToSheet(layout, placed.page, region.x, placed.y);
    const top = EQUAVELA_PADDING_PX + at.y * zoom;
    if (top < area.scrollTop + 40 || top > area.scrollTop + area.clientHeight - 80) {
      area.scrollTop = Math.max(0, top - area.clientHeight / 3);
    }
    // Only a new focus request scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Drawn rectangles for paste placement (Workbench).
  useEffect(() => {
    if (!layoutRef) return;
    layoutRef.current = shown.map((region) => {
      const placed = placedOf(region);
      const size = sizeOf(region.id);
      return { id: region.id, page: placed.page, x: snapToGrid(region.x), y: placed.y, w: size.w, h: size.h, ...(size.rise ? { rise: size.rise } : {}) };
    });
  }, [layoutRef, placedOf, shown, sizeOf, sizeVersion]);

  // ---- pointer handling --------------------------------------------------------------------

  /** Client coordinates to sheet CSS px (unzoomed). */
  const toSheet = useCallback(
    (clientX: number, clientY: number) => {
      const rect = sheetRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  const regionRect = useCallback(
    (region: ViewRegion) => {
      const placed = placedOf(region);
      const at = pageToSheet(layout, placed.page, region.x, placed.y);
      const size = sizeOf(region.id);
      return { x0: at.x, y0: at.y, x1: at.x + ptToPx(size.w), y1: at.y + ptToPx(size.h) };
    },
    [layout, placedOf, sizeOf],
  );

  /**
   * A press on empty sheet space, or inside an area band: a band is sheet for this purpose, so the
   * crosshair goes where the press landed and a region can be typed into the area.
   * The selection clears and a rubber band starts, exactly as on the page itself.
   */
  const pressBackground = useCallback(
    (clientX: number, clientY: number, additive: boolean) => {
      onBackground?.();
      const point = toSheet(clientX, clientY);
      const target = draft ? sheetToDraftPage(layout, point.x, point.y) : sheetToPage(layout, point.x, point.y);
      const printable = printableArea(setup);
      onCrosshair({
        page: target.page,
        x: draft ? Math.max(0, snapToGrid(target.x)) : Math.min(Math.max(snapToGrid(target.x), printable.left), printable.right),
        y: draft ? Math.max(0, snapToGrid(target.y)) : Math.min(Math.max(snapToGrid(target.y), printable.top), printable.bottom),
      });
      // The rubber band is the only selection of the gesture: a native text selection that starts here
      // would run on over every text between the press and the pointer, the header included.
      const next: Band = { x0: point.x, y0: point.y, x1: point.x, y1: point.y, additive };
      bandRef.current = next;
      setBand(next);
      if (!additive) onSelect([], "replace");
      areaRef.current?.focus({ preventScroll: true });
      window.getSelection()?.removeAllRanges();
    },
    [draft, layout, onBackground, onCrosshair, onSelect, setup, toSheet],
  );

  const finishDrag = useCallback(
    (state: DragState) => {
      if (!state.moved) return;
      const moves: RegionMove[] = [];
      // The members of a dragged area move with it by the area's own displacement, whether they are
      // drawn or hidden; they are not placed one by one.
      for (const id of state.ids) {
        const region = view.regions.find((r) => r.id === id);
        if (!region) continue;
        const drawn = placedOf(region);
        // A math region is placed by its first line, below what rises over it: the
        // line snaps to the grid and is what is stored.
        const size = region.kind === "area" ? { w: 0, h: AREA_HEADER_PT } : sizeOf(id);
        const rise = region.kind === "area" ? 0 : (size.rise ?? 0);
        const from = pageToSheet(layout, drawn.page, region.x, drawn.y + rise);
        // A full-width block or an area moves only vertically.
        const dx = (region.kind === "text" && region.full_width) || region.kind === "area" ? 0 : state.dx;
        const target = draft ? sheetToDraftPage(layout, from.x + dx, from.y + state.dy) : sheetToPage(layout, from.x + dx, from.y + state.dy);
        // A band is dropped where the pointer leaves it: it may cross the bottom margin and continue
        // on the next page, so only its header has to fit on the page it starts on.
        // Every other region that would straddle the bottom margin moves to the next page.
        const placed = draft
          ? { page: target.page, x: Math.max(0, snapToGrid(target.x)), y: Math.max(0, snapToGrid(target.y)) }
          : placeRegion(setup, target.page, target.x, target.y, { w: size.w, h: size.h - rise });
        // The drawn point goes back to a stored position.
        const stored = { ...placed, y: storedY(view.regions, setup, placed.page, placed.y) };
        if (stored.page !== region.page || stored.x !== region.x || stored.y !== region.y) {
          moves.push({ region_id: id, ...stored });
          if (isArea(region)) {
            const frame = flowFrame(setup);
            const distance = flowOf(frame, stored.page, stored.y) - flowOf(frame, region.page, region.y);
            for (const memberId of withMembers(view.regions, [id], setup)) {
              const member = view.regions.find((r) => r.id === memberId);
              if (!member || memberId === id || state.ids.includes(memberId)) continue;
              const offset = Math.max(0, flowOf(frame, member.page, member.y) + distance);
              const page = Math.floor(offset / frame.step) + 1;
              const y = snapToGrid(frame.top + offset - (page - 1) * frame.step);
              moves.push({ region_id: memberId, page, x: member.x, y });
            }
          }
        }
      }
      if (moves.some((move) => view.regions.some((region) => region.id === move.region_id && isArea(region)))) {
        // Keep unrelated regions at their drawn position if releasing an area would otherwise
        // pull them upward merely because an earlier collision no longer pushes them.
        const planned = new Map(moves.map((move) => [move.region_id, move]));
        const futureRegions = view.regions.map((region) => {
          const move = planned.get(region.id);
          return move ? { ...region, page: move.page, x: move.x, y: move.y } : region;
        });
        const futureIndex = sheetIndexOf(futureRegions, view.page, view.settings);
        const future = reflow(setup, futureRegions.filter((region) => !futureIndex.hidden.has(region.id)).map((region) => {
          const size = region.kind === "area" ? { w: 0, h: 0 } : (sizes.current.get(region.id) ?? estimatedSize(region, setup));
          return { id: region.id, page: region.page, x: region.x, y: futureIndex.drawnY(region.page, region.y), ...size };
        }));
        const frame = flowFrame(setup);
        for (const region of view.regions) {
          if (planned.has(region.id) || isArea(region)) continue;
          const old = flow.get(region.id);
          const next = future.get(region.id);
          if (!old?.pushed || !next || flowOf(frame, next.page, next.y) >= flowOf(frame, old.page, old.y) - 1e-6) continue;
          const rise = sizes.current.get(region.id)?.rise ?? 0;
          moves.push({ region_id: region.id, page: old.page, x: region.x, y: storedY(futureRegions, setup, old.page, old.y + rise) });
        }
      }
      if (moves.length > 0) onMove(moves);
    },
    [draft, flow, layout, onMove, placedOf, setup, sizeOf, view],
  );

  const onRegionPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>, id: string) => {
      if (event.button !== 0) return;
      // A table fills its region with cells: a press on a cell, a column name, a unit field or an
      // action button belongs to that field (focus, caret, text selection). Every other press on the
      // table — its selection border, the strip above it, its frame — starts a move like it does on
      // every other region.
      const target = event.target as Element;
      // A press on the scroll bar of a scrolling box is the scroll bar's: it
      // neither selects the region nor opens it for editing, whatever the position of its thumb.
      if (onScrollBar(target, event.clientX, event.clientY, event.currentTarget)) {
        event.stopPropagation();
        return;
      }
      // A Julia block's code and its play/stop button belong to the block: a press
      // there opens the code editor or toggles, and never moves the region; its header and frame
      // move it like any other region.
      if (
        target.closest?.(".julia-region") && target.closest?.(".julia-code-box, .julia-play")
      ) {
        event.stopPropagation();
        if (!doc.selection.includes(id)) onSelect([id], "replace");
        return;
      }
      event.stopPropagation();
      const extend = event.shiftKey || event.ctrlKey || event.metaKey;
      const region = view.regions.find((r) => r.id === id);
      // Inside the band of an area (not its header, not the indicator: those stop the press): the
      // band is sheet, so the press places the crosshair there and a region can be typed into the
      // area. Clicking an area never collapses it.
      if (region?.kind === "area" && !target.closest?.(".area-header")) {
        event.preventDefault();
        pressBackground(event.clientX, event.clientY, extend);
        return;
      }
      const border = (event.target as Element).closest?.(".region-drag-border") !== null;
      const hit =
        !border && (region?.kind === "math" || (id === DRAFT_ID && editing?.regionId === null)) && !extend
          ? mathHit(event.currentTarget, event.target, event.clientX, event.clientY)
          : null;
      // The border of the active frame of the region being edited is a move handle: the
      // press starts a move of that one region and leaves the edit open, so the caret stays where it
      // was. A press inside the frame keeps its meaning (the branches below).
      // A press on the empty part of the text region being edited — around or between its lines, not
      // on its text — is a move handle too.
      const emptyOfEditedText =
        !border && textEditing?.regionId === id && onTextAt(event.currentTarget, event.clientX, event.clientY) === false;
      if ((border && (editing?.regionId === id || textEditing?.regionId === id)) || emptyOfEditedText) {
        event.preventDefault();
        const state: DragState = {
          ids: [id],
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
          dx: 0,
          dy: 0,
          pressed: id,
          extend: false,
          hit: null,
          text: false,
        };
        dragRef.current = state;
        setDrag(state);
        window.getSelection()?.removeAllRanges();
        // The press must not take the focus from the text editor (that is what `preventDefault`
        // above is for); the math editor is driven by the sheet, which takes the focus as on any
        // other press.
        if (!textEditing) areaRef.current?.focus({ preventScroll: true });
        return;
      }
      // A result press selects content to copy and finishes an active edit.
      // The region border remains the handle for moving it.
      const result = resultAt(event.target);
      if (result && region?.kind === "math" && !extend && !border && onResultSelect) {
        event.preventDefault();
        if (editing?.regionId === id) onBackground?.();
        if (doc.selection.includes(id)) onSelect([], "replace");
        const from = resultHit(result, event.target, event.clientX, event.clientY);
        resultPress.current = { regionId: id, result, from };
        onResultSelect(selectionOf(id, from, from));
        areaRef.current?.focus({ preventScroll: true });
        return;
      }
      onResultSelect?.(null);
      if (textEditing && (textEditing.regionId === id || id === DRAFT_ID)) {
        // The text editor owns clicks inside its region (caret, selection).
        event.stopPropagation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && id !== DRAFT_ID && onNameClick) {
        const name = (event.target as Element).closest?.<HTMLElement>(".name");
        const span = parseSpan(name?.closest<HTMLElement>(".node")?.dataset.span);
        const editingThis = !!(editing && editing.regionId === id);
        if (name && (span || editingThis) && onNameClick(nameRegionId(id, name), span?.start ?? null, span?.end ?? null, name.dataset.name ?? "")) {
          event.preventDefault();
          return;
        }
      }
      if (editing && (editing.regionId === id || id === DRAFT_ID)) {
        // A click inside the region being edited moves the caret; off the math but inside its frame it
        // goes to the nearest point of the expression, and a drag from there selects.
        event.preventDefault();
        const at = hit ?? (border || extend ? null : nearestMathHit(event.currentTarget, event.clientX, event.clientY));
        if (at) {
          onEditRegion?.(editing.regionId ?? DRAFT_ID, at);
          selectPress.current = { container: event.currentTarget, anchor: at };
        }
        return;
      }
      // A press on the math of a math region that is not selected is a press into the expression:
      // the caret goes where it
      // landed and a drag selects inside the math. Only a selected region moves from its interior.
      if (hit && region?.kind === "math" && !doc.selection.includes(id) && onEditRegion) {
        event.preventDefault();
        onEditRegion(id, hit);
        selectPress.current = { container: event.currentTarget, anchor: hit };
        areaRef.current?.focus({ preventScroll: true });
        return;
      }
      let ids = doc.selection;
      if (extend) {
        onSelect([id], "toggle");
        ids = ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id];
      } else if (!ids.includes(id)) {
        onSelect([id], "replace");
        ids = [id];
      }
      if (ids.length === 0) return;
      // A plot's interior belongs to the plot: a drag there is a drag-to-zoom or a pan of its
      // content and must never move the region. The rest of the region —
      // the area around the plot area, outside the expression slots (the move area of `PlotView`) —
      // moves it with the same rules as the strips of its selection border and the arrow keys, so it
      // falls through to the drag below. The press has already selected the plot above, so one
      // press-and-drag moves a plot that was not selected yet.
      if ((event.target as Element).closest?.(".plot-region") && !(event.target as Element).closest?.(".plot-move-area")) {
        areaRef.current?.focus({ preventScroll: true });
        return;
      }
      const pressOnText = region?.kind === "text" && !extend && !border;
      const readOnlyMath = pressOnText ? target.closest<HTMLElement>('[data-testid="inline-math"]') : null;
      const anchor = readOnlyMath ? mathHit(readOnlyMath, target, event.clientX, event.clientY) : null;
      const inline = anchor && readOnlyMath ? {
        region: event.currentTarget,
        index: [...event.currentTarget.querySelectorAll('[data-testid="inline-math"]')].indexOf(readOnlyMath),
        anchor,
      } : undefined;
      const state: DragState = {
        ids,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        dx: 0,
        dy: 0,
        pressed: id,
        extend,
        hit: region?.kind === "math" && !extend ? hit : null,
        text: pressOnText,
        // On the text itself the press is a click into the text, never a move; a drag from it
        // selects. The border always moves.
        pinned: pressOnText && ids.length === 1 && (inline !== undefined || onTextAt(event.currentTarget, event.clientX, event.clientY) === true),
        inline,
      };
      inlineDrag.current = inline ?? null;
      dragRef.current = state;
      setDrag(state);
      // A move selects nothing as text, like the rubber band: a native selection
      // would run on over every text between the press and the pointer, the header included. A press on
      // a text region keeps the browser's selection, which a drag from its text uses.
      if (!state.text || inline) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
      }
      areaRef.current?.focus({ preventScroll: true });
    },
    [doc.selection, editing, onEditRegion, onMathSelect, onNameClick, onResultSelect, onBackground, onSelect, pressBackground, textEditing, view.regions],
  );

  /**
   * Pointer down on a resize handle: the width of a text region, width and height of a plot, the
   * box of a matrix result — the table or the clipped classic matrix.
   */
  const onResizeStart = useCallback(
    (event: PointerEvent<HTMLElement>, id: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const region = view.regions.find((r) => r.id === id);
      if (
        !region ||
        (region.kind !== "text" &&
          region.kind !== "plot" &&
          region.kind !== "image" &&
          region.kind !== "area" &&
          region.kind !== "math" &&
          region.kind !== "julia")
      ) {
        return;
      }
      const area = printableArea(setup);
      const right = area.right;
      if (region.kind === "math") {
        // The box of a matrix result: both sides follow the pointer, in grid steps.
        // The start is the stored box or, without one, the box the sheet is drawing right now,
        // whichever display it draws (the table or the clipped classic matrix).
        const stored = regionFormats.get(id)?.tableSize ?? null;
        const drawn = (event.currentTarget as HTMLElement)
          .closest(".result-matrix-box")
          ?.querySelector<HTMLElement>(".result-matrix-scroll");
        const startWidth = stored?.[0] ?? Math.max(MIN_TABLE_PT.w, pxToPt(drawn?.offsetWidth ?? 0));
        const startHeight = stored?.[1] ?? Math.max(MIN_TABLE_PT.h, pxToPt(drawn?.offsetHeight ?? 0));
        // The content and the scroll bars as drawn now, borders included in the content;
        // nothing to fit to without a layout.
        const fit = drawn && drawn.scrollWidth > 0 && drawn.scrollHeight > 0
          ? {
              w: pxToPt(drawn.scrollWidth + 2 * drawn.clientLeft),
              h: pxToPt(drawn.scrollHeight + 2 * drawn.clientTop),
              vbar: pxToPt(Math.max(0, drawn.offsetWidth - drawn.clientWidth - 2 * drawn.clientLeft)),
              hbar: pxToPt(Math.max(0, drawn.offsetHeight - drawn.clientHeight - 2 * drawn.clientTop)),
            }
          : undefined;
        const state: ResizeState = {
          id,
          startX: event.clientX,
          startY: event.clientY,
          startWidth,
          min: MIN_TABLE_PT.w,
          max: Infinity,
          width: Math.max(MIN_TABLE_PT.w, snapToGrid(startWidth)),
          height: {
            start: startHeight,
            min: MIN_TABLE_PT.h,
            max: Infinity,
            value: Math.max(MIN_TABLE_PT.h, snapToGrid(startHeight)),
          },
          image: null,
          fit,
        };
        resizeRef.current = state;
        setResize(state);
        return;
      }
      if (region.kind === "area") {
        // The end line: only the height changes, in grid steps, up to the start of the next
        // area in the flow of the sheet. The band may grow past the bottom margin, where it continues
        // at the top margin of the next page, so the limit is a length of the flow, not of
        // one page.
        const frame = flowFrame(setup);
        const start = flowOf(frame, region.page, region.y);
        const next = view.regions
          .filter((r) => isArea(r) && r.id !== id)
          .map((r) => flowOf(frame, r.page, r.y))
          .filter((offset) => offset > start + 1e-6)
          .reduce((nearest, offset) => Math.min(nearest, offset), Infinity);
        const limit = Math.floor((next - start) / 3) * 3;
        const state: ResizeState = {
          id,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: area.width,
          min: area.width,
          max: area.width,
          width: area.width,
          // The end line never goes above the content of the band.
          height: {
            start: bandHeight(region),
            min: Math.max(MIN_AREA_PT, heldHeights.get(region.id) ?? 0),
            max: Math.max(MIN_AREA_PT, limit, heldHeights.get(region.id) ?? 0),
            value: bandHeight(region),
            flow: start,
          },
          image: null,
        };
        resizeRef.current = state;
        setResize(state);
        return;
      }
      if (region.kind === "image") {
        const [w, h] = region.size;
        const state: ResizeState = {
          id,
          startX: event.clientX,
          startY: event.clientY,
          startWidth: w,
          min: MIN_IMAGE_PT,
          max: Infinity,
          width: w,
          height: { start: h, min: MIN_IMAGE_PT, max: Infinity, value: h },
          image: { maxHeight: Infinity },
        };
        resizeRef.current = state;
        setResize(state);
        return;
      }
      if (region.kind === "julia") {
        // The box of a Julia block: both sides follow the pointer in
        // whole 3 pt steps, from the smallest box up, past the margins when dragged there. The
        // drag starts at the stored size or, without one, at the size the block is drawn at, so the
        // first drag does not jump.
        const stored = region.block.size ?? null;
        const drawn = sizeOf(id);
        const startWidth = Math.max(MIN_JULIA_PT.w, snapToGrid(stored?.[0] ?? drawn.w));
        const startHeight = Math.max(MIN_JULIA_PT.h, snapToGrid(stored?.[1] ?? drawn.h));
        const state: ResizeState = {
          id,
          startX: event.clientX,
          startY: event.clientY,
          startWidth,
          min: MIN_JULIA_PT.w,
          max: Infinity,
          width: startWidth,
          height: {
            start: startHeight,
            min: MIN_JULIA_PT.h,
            max: Infinity,
            value: startHeight,
          },
          image: null,
        };
        resizeRef.current = state;
        setResize(state);
        return;
      }
      const plot = region.kind === "plot" ? region.plot.size : null;
      const minWidth = plot ? MIN_PLOT_PT.w : MIN_WIDTH_PT;
      // A text box that grows with its text starts the resize from the width it is drawn at; the resize
      // then gives it a stored width, which it keeps.
      const growing = region.kind === "text" && region.width == null;
      const startWidth = plot
        ? plot[0]
        : ((region.kind === "text" ? region.width : null) ??
          (growing ? Math.max(MIN_WIDTH_PT, sizeOf(id).w) : Math.max(MIN_WIDTH_PT, right - snapToGrid(region.x))));
      const state: ResizeState = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        startWidth,
        min: minWidth,
        max: Infinity,
        width: snapToGrid(startWidth),
        height: plot
          ? {
              start: plot[1],
              min: MIN_PLOT_PT.h,
              max: Infinity,
              value: snapToGrid(plot[1]),
            }
          : null,
        image: null,
      };
      resizeRef.current = state;
      setResize(state);
    },
    [regionFormats, setup, sizeOf, view.regions],
  );

  /**
   * Whether a press at `target` would start a move of its region: the
   * rules of `onRegionPointerDown`, asked on hover so the pointer can show the move cursor there.
   */
  const movesFrom = useCallback(
    (target: Element, x: number, y: number): boolean => {
      // Fields, buttons and handles have their own cursor; the strips and an area's header show `move`.
      const cursor = getComputedStyle(target).cursor;
      if (cursor !== "" && cursor !== "auto" && cursor !== "default") return false;
      const element = target.closest<HTMLElement>("[data-region-id]");
      const id = element?.dataset.regionId;
      const region = id === undefined ? undefined : view.regions.find((r) => r.id === id);
      if (!element || !id || !region || region.kind === "area") return false;
      if (onScrollBar(target, x, y, element)) return false;
      if (target.closest(".julia-region") && target.closest(".julia-code-box, .julia-play")) return false;
      if (textEditing?.regionId === id) return onTextAt(element, x, y) === false;
      if (editing?.regionId === id) return false;
      if (region.kind === "math" && resultAt(target)) return false;
      const selected = doc.selection.includes(id);
      if (region.kind === "math" && !selected && mathHit(element, target, x, y)) return false;
      if (target.closest(".plot-region") && !target.closest(".plot-move-area")) return false;
      // The text of a text region selects unless the region moves with others.
      if (region.kind === "text" && onTextAt(element, x, y) === true) return selected && doc.selection.length > 1;
      return true;
    },
    [doc.selection, editing?.regionId, textEditing?.regionId, view.regions],
  );
  // The one element whose cursor shows `move`.
  const moveCursor = useRef<HTMLElement | SVGElement | null>(null);
  const showMoveCursor = useCallback((element: HTMLElement | SVGElement | null) => {
    if (moveCursor.current === element) return;
    if (moveCursor.current) moveCursor.current.style.cursor = "";
    moveCursor.current = element;
    if (element) element.style.cursor = "move";
  }, []);

  // A new selection or edit changes what a press means: the next pointer move decides again.
  useEffect(() => showMoveCursor(null), [movesFrom, showMoveCursor]);

  // Hover information: the name under the pointer (a `.name` whose node carries a span).
  const hoveredName = useRef<Element | null>(null);
  const onSheetMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const busy = dragRef.current || bandRef.current || resizeRef.current || event.buttons !== 0;
      const target = event.target as Element;
      if (!busy && (target instanceof HTMLElement || target instanceof SVGElement)) {
        if (target !== moveCursor.current) {
          showMoveCursor(null);
          if (movesFrom(target, event.clientX, event.clientY)) showMoveCursor(target);
        }
      } else if (!busy) showMoveCursor(null);
      if (!onNameHover) return;
      const name = busy ? null : ((event.target as Element).closest?.(".name") ?? null);
      if (name === hoveredName.current) return;
      hoveredName.current = name;
      const regionElement = name?.closest<HTMLElement>("[data-region-id]") ?? null;
      const span = parseSpan(name?.closest<HTMLElement>(".node")?.dataset.span);
      if (!name || !regionElement || !span || regionElement.classList.contains("editing")) {
        onNameHover(null);
        return;
      }
      const rect = name.getBoundingClientRect();
      onNameHover({
        regionId: nameRegionId(regionElement.dataset.regionId ?? "", name),
        start: span.start,
        end: span.end,
        name: (name as HTMLElement).dataset.name ?? "",
        label: (name as HTMLElement).dataset.label,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      });
    },
    [movesFrom, onNameHover, showMoveCursor],
  );
  const onSheetLeave = useCallback(() => {
    showMoveCursor(null);
    hoveredName.current = null;
    onNameHover?.(null);
  }, [onNameHover, showMoveCursor]);

  const warningsByRegion = useMemo(() => {
    const map = new Map<string, WarningInfo[]>();
    for (const warning of warnings ?? []) {
      if (warning.key.document !== doc.root || warning.key.instance !== 0) continue;
      const list = map.get(warning.key.region_id) ?? [];
      list.push(warning);
      map.set(warning.key.region_id, list);
    }
    return map;
  }, [warnings, doc.root]);
  // The diagnostics of the root document grouped by region once, not filtered per region per render.
  const diagnosticsByRegion = useMemo(() => {
    const map = new Map<string, SessionDiagnostic[]>();
    for (const diagnostic of doc.diagnostics) {
      if (diagnostic.document !== doc.root) continue;
      const list = map.get(diagnostic.region_id) ?? [];
      list.push(diagnostic);
      map.set(diagnostic.region_id, list);
    }
    return map;
  }, [doc.diagnostics, doc.root]);

  const onPagePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      onResultSelect?.(null);
      pressBackground(event.clientX, event.clientY, event.shiftKey || event.ctrlKey || event.metaKey);
    },
    [onResultSelect, pressBackground],
  );

  const inlineTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearInlineTimer = () => {
    if (inlineTimer.current !== null) {
      clearTimeout(inlineTimer.current);
      inlineTimer.current = null;
    }
  };
  useEffect(() => {
    const resetInlineDrag = () => {
      inlineDrag.current = null;
      clearInlineTimer();
    };
    const selectInline = (drag: InlineDrag, point: globalThis.PointerEvent, attempts = 0) => {
      clearInlineTimer();
      if (inlineDrag.current !== drag || !drag.region.isConnected) return;
      const math = drag.region.querySelectorAll<HTMLElement>('[data-testid="text-editor"] .tx-inline')[drag.index];
      if (math && selectInlineMath(math, { from: drag.anchor, to: { x: point.clientX, y: point.clientY }, target: point.target })) return;
      // A rapid release can precede the mounting of the Lexical decorator.
      if (attempts > 0) inlineTimer.current = setTimeout(() => selectInline(drag, point, attempts - 1), 30);
    };
    // Always attached (the handlers ignore events without a press): attaching them after the press
    // rendered could miss a quick release.
    const move = (event: globalThis.PointerEvent) => {
      const inResult = resultPress.current;
      if (inResult && event.buttons === 1) {
        const to = resultDragHit(inResult.result, inResult.from, event.target, event.clientX, event.clientY);
        onResultSelect?.(selectionOf(inResult.regionId, inResult.from, to));
      }
      const press = selectPress.current;
      if (press && event.buttons === 1) {
        const to =
          matrixDragHit(press.container, press.anchor.path, event.clientX, event.clientY) ??
          mathHit(press.container, event.target, event.clientX, event.clientY) ??
          nearestMathHit(press.container, event.clientX, event.clientY);
        if (to) onMathSelect?.(press.anchor, to);
      }
      const current = dragRef.current;
      if (current) {
        const dxClient = event.clientX - current.startX;
        const dyClient = event.clientY - current.startY;
        const moved =
          !current.pinned && (current.moved || Math.hypot(dxClient, dyClient) > DRAG_THRESHOLD_PX);
        // The drag follows the pointer smoothly; the drop snaps to the 3 pt grid.
        const dx = dxClient / zoom;
        const dy = dyClient / zoom;
        // A drag that starts on the text of a text region opens the editor at the press point and then
        // selects from there to the pointer, live.
        const selecting =
          current.pinned && (current.opened || Math.hypot(dxClient, dyClient) > DRAG_THRESHOLD_PX) && onEditText !== undefined;
        if (selecting && !current.opened) onEditText(current.pressed, current.inline ? null : { x: current.startX, y: current.startY });
        const next = { ...current, moved, dx: moved ? dx : 0, dy: moved ? dy : 0, opened: current.opened || selecting };
        dragRef.current = next;
        setDrag(next);
        if (selecting) {
          if (current.inline) selectInline(current.inline, event);
          else selectTextBetween({ x: current.startX, y: current.startY }, { x: event.clientX, y: event.clientY });
        }
      }
      const sizing = resizeRef.current;
      if (sizing?.image && sizing.height) {
        const next = resizeImage(
          { w: sizing.startWidth, h: sizing.height.start },
          pxToPt((event.clientX - sizing.startX) / zoom),
          pxToPt((event.clientY - sizing.startY) / zoom),
          !event.shiftKey,
          sizing.max,
          sizing.image.maxHeight,
        );
        if (next.w !== sizing.width || next.h !== sizing.height.value) {
          const updated = { ...sizing, width: next.w, height: { ...sizing.height, value: next.h } };
          resizeRef.current = updated;
          setResize(updated);
        }
      } else if (sizing) {
        const dxPt = pxToPt((event.clientX - sizing.startX) / zoom);
        let width = Math.min(
          sizing.max,
          Math.max(sizing.min, snapToGrid(sizing.startWidth + dxPt)),
        );
        let height = sizing.height;
        if (height) {
          let value: number;
          if (height.flow !== undefined && !draft) {
            // The end line of a band is placed by the flow, so a drag past the bottom margin carries
            // it to the top margin of the next page.
            const point = toSheet(event.clientX, event.clientY);
            const target = sheetToPage(layout, point.x, point.y);
            value = snapToGrid(flowOf(flowFrame(setup), target.page, target.y)) - height.flow;
          } else {
            const dyPt = pxToPt((event.clientY - sizing.startY) / zoom);
            value = height.start + dyPt;
          }
          height = { ...height, value: Math.min(height.max, Math.max(height.min, snapToGrid(value))) };
        }
        if (sizing.fit && height) {
          const fitted = fitResultBox({ w: width, h: height.value }, sizing.fit);
          width = fitted.w;
          height = { ...height, value: fitted.h };
        }
        if (width !== sizing.width || height?.value !== sizing.height?.value) {
          const next = { ...sizing, width, height };
          resizeRef.current = next;
          setResize(next);
        }
      }
      const currentBand = bandRef.current;
      if (currentBand) {
        const point = toSheet(event.clientX, event.clientY);
        const next = { ...currentBand, x1: point.x, y1: point.y };
        bandRef.current = next;
        setBand(next);
      }
    };
    const up = (event: globalThis.PointerEvent) => {
      resultPress.current = null;
      selectPress.current = null;
      const sizing = resizeRef.current;
      if (sizing) {
        resizeRef.current = null;
        setResize(null);
        // An image keeps its stored size until the pointer really moved it (no grid snap).
        const base = (value: number) => (sizing.image ? value : snapToGrid(value));
        const widthChanged = sizing.width !== base(sizing.startWidth);
        const heightChanged = sizing.height !== null && sizing.height.value !== base(sizing.height.start);
        if (widthChanged || heightChanged) {
          const key = sizeKey(view.regions.find((r) => r.id === sizing.id));
          setResized({ id: sizing.id, w: sizing.width, h: sizing.height?.value ?? null, key });
          onResize?.(sizing.id, { w: sizing.width, h: sizing.height?.value ?? null });
        }
      }
      const current = dragRef.current;
      if (current) {
        if (current.moved) {
          // Until the move lands the regions wait at the grid step the drop snaps to.
          const step = (value: number) => ptToPx(snapToGrid(pxToPt(value)));
          setDropped({ ids: current.ids, dx: step(current.dx), dy: step(current.dy), key: positionsKey(view.regions, current.ids, setup) });
          finishDrag(current);
        }
        else if (current.hit && onEditRegion) onEditRegion(current.pressed, current.hit);
        else if (current.opened) {
          if (current.inline) selectInline(current.inline, event, 30);
          else selectTextBetween({ x: current.startX, y: current.startY }, { x: event.clientX, y: event.clientY }, 30);
        }
        else if (current.text && onEditText) onEditText(current.pressed, { x: event.clientX, y: event.clientY });
        else if (!current.extend && current.ids.length > 1) onSelect([current.pressed], "replace");
        dragRef.current = null;
        setDrag(null);
      }
      const currentBand = bandRef.current;
      if (currentBand) {
        const x0 = Math.min(currentBand.x0, currentBand.x1);
        const x1 = Math.max(currentBand.x0, currentBand.x1);
        const y0 = Math.min(currentBand.y0, currentBand.y1);
        const y1 = Math.max(currentBand.y0, currentBand.y1);
        if (x1 - x0 > DRAG_THRESHOLD_PX || y1 - y0 > DRAG_THRESHOLD_PX) {
          const hit = shown
            .filter((region) => {
              const r = regionRect(region);
              return r.x0 < x1 && r.x1 > x0 && r.y0 < y1 && r.y1 > y0;
            })
            .map((region) => region.id);
          onSelect(hit, currentBand.additive ? "add" : "replace");
        }
        bandRef.current = null;
        setBand(null);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        resizeRef.current = null;
        setResize(null);
        dragRef.current = null;
        bandRef.current = null;
        setDrag(null);
        setBand(null);
      }
    };
    window.addEventListener("pointerdown", resetInlineDrag, true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", resetInlineDrag, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [draft, finishDrag, layout, onEditRegion, onEditText, onMathSelect, onResize, onResultSelect, onSelect, regionRect, setup, toSheet, shown, view.regions, zoom]); // eslint-disable-line react-hooks/exhaustive-deps

  // The selected part of a result is drawn on the result's own elements, again after
  // every new result, which renders them anew.
  useLayoutEffect(() => {
    const sheet = areaRef.current;
    if (!sheet) return;
    let active = true;
    const draw = () => { if (active) drawSelection(sheet, resultSelection); };
    draw();
    void document.fonts?.ready.then(draw);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(draw) : null;
    if (resultSelection) {
      const region = sheet.querySelector(`[data-region-id="${CSS.escape(resultSelection.regionId)}"]`);
      for (const matrix of region?.querySelectorAll(".result-matrix") ?? []) observer?.observe(matrix);
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [resultSelection, doc.results, view]);

  // Where a client point lands on the page, snapped to the grid and kept inside the printable area.
  const placeAt = useCallback(
    (clientX: number, clientY: number) => {
      const point = toSheet(clientX, clientY);
      const target = draft ? sheetToDraftPage(layout, point.x, point.y) : sheetToPage(layout, point.x, point.y);
      const printable = printableArea(setup);
      return {
        page: target.page,
        x: draft ? Math.max(0, snapToGrid(target.x)) : Math.min(Math.max(snapToGrid(target.x), printable.left), printable.right),
        y: draft ? Math.max(0, snapToGrid(target.y)) : Math.min(Math.max(snapToGrid(target.y), printable.top), printable.bottom),
      };
    },
    [draft, layout, setup, toSheet],
  );
  useEffect(() => {
    if (!placeAtRef) return;
    placeAtRef.current = placeAt;
    return () => {
      placeAtRef.current = null;
    };
  }, [placeAt, placeAtRef]);

  const zoomAnchor = useRef<{ x: number; y: number; offsetX: number; offsetY: number; zoom: number } | null>(null);
  const zoomAnchorTimer = useRef<number | null>(null);
  const clearZoomAnchorTimer = () => {
    if (zoomAnchorTimer.current !== null) {
      window.clearTimeout(zoomAnchorTimer.current);
      zoomAnchorTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      clearZoomAnchorTimer();
      clearInlineTimer();
      cancelSelectText();
      if (scrollFrame.current) {
        cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = 0;
      }
    },
    [],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (!event.ctrlKey) return;
      // The sheet point under the pointer stays under it: it is noted here, with the pointer's offset
      // in the viewport, and the scroll position is corrected once the new zoom is drawn. Wheel events
      // that arrive before that keep the first point, so a fast spin does not drift.
      const area = areaRef.current;
      if (area && !zoomAnchor.current) {
        const box = area.getBoundingClientRect();
        const at = toSheet(event.clientX, event.clientY);
        zoomAnchor.current = { ...at, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top, zoom };
        // A wheel that changes nothing (the zoom is at its limit) must not leave a stale point behind.
        clearZoomAnchorTimer();
        zoomAnchorTimer.current = window.setTimeout(() => {
          zoomAnchor.current = null;
          zoomAnchorTimer.current = null;
        }, 250);
      }
      onZoomWheel(event.deltaY < 0 ? 1 : -1);
    },
    [onZoomWheel, toSheet, zoom],
  );

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const area = areaRef.current;
    if (!anchor || !area || anchor.zoom === zoom) return;
    zoomAnchor.current = null;
    clearZoomAnchorTimer();
    const padding = draft && !printing ? 0 : EQUAVELA_PADDING_PX;
    area.scrollTop = Math.max(0, padding + anchor.y * zoom - anchor.offsetY);
    area.scrollLeft = Math.max(0, left + anchor.x * zoom - anchor.offsetX);
  }, [zoom, left, draft, printing]);

  // Ctrl+wheel must be able to call preventDefault, which React's passive listener cannot; so must
  // the wheel over a result box without the keyboard, which scrolls the page instead.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const handler = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        return;
      }
      if (boxPassingWheel(event, document.activeElement)) {
        event.preventDefault();
        area.scrollTop += wheelPixels(event, area.clientHeight);
      }
    };
    area.addEventListener("wheel", handler, { passive: false });
    return () => area.removeEventListener("wheel", handler);
  }, []);

  // ---- render ------------------------------------------------------------------------------

  const selected = useMemo(() => new Set(doc.selection), [doc.selection]);
  const editingHere = editing && editing.docId === doc.id ? editing : null;
  const textEditingHere = textEditing && textEditing.docId === doc.id ? textEditing : null;
  // The region being typed at the crosshair, so that leaving it with an arrow knows its box.
  useEffect(() => {
    const drafts = draftRegions(editingHere, textEditingHere);
    if (drafts.length === 0) sizes.current.delete(DRAFT_ID);
    if (!layoutRef) return;
    const placed = layoutRef.current.filter((rect) => rect.id !== DRAFT_ID);
    for (const draft of drafts) {
      const size = sizeOf(draft.id);
      const rise = draft.kind === "math" ? (size.rise ?? 0) : 0;
      const anchor = snapToGrid(draft.y);
      const y = draft.kind === "math" ? Math.max(anchor - rise, Math.min(anchor, setup.margins.top)) : draft.y;
      placed.push({ id: draft.id, page: draft.page, x: snapToGrid(draft.x), y, w: size.w, h: size.h, ...(rise ? { rise } : {}) });
    }
    layoutRef.current = placed;
  }, [setup.margins.top, layoutRef, shown, editingHere, textEditingHere, sizeOf, sizeVersion]);
  const dragMoved = drag !== null && drag.moved;
  // A finished drag whose move has not reached the view yet: same stored positions as at the drop.
  const settling = dropped && !drag && positionsKey(view.regions, dropped.ids, setup) === dropped.key ? dropped : null;
  const dragOffset = useMemo(
    () => (dragMoved && drag ? { x: drag.dx, y: drag.dy } : settling ? { x: settling.dx, y: settling.dy } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dragMoved, drag?.dx, drag?.dy, settling?.dx, settling?.dy, settling?.key],
  );
  const verticalDragOffset = useMemo(
    () => (dragOffset ? { x: 0, y: dragOffset.y } : null),
    [dragOffset],
  );
  // The regions that follow the pointer during a drag: the members of a dragged area move with it
  //, and the region being edited is moved from the border of its active frame while it stays
  // unselected, so the drag's own ids say what moves, not the selection.
  const dragged = useMemo(
    () => new Set(withMembers(view.regions, drag ? drag.ids : settling ? settling.ids : doc.selection, setup)),
    [view.regions, doc.selection, drag?.ids, settling?.ids, setup],
  );
  // Likewise a resize keeps its dropped size until the stored size changes, so the region never
  // flashes back to its old size in between.
  const sizeSettling =
    resized && !resize && sizeKey(view.regions.find((r) => r.id === resized.id)) === resized.key ? resized : null;
  useEffect(() => {
    if (!resized) return undefined;
    if (!sizeSettling) {
      setResized(null);
      return undefined;
    }
    const timer = setTimeout(() => setResized(null), 1500);
    return () => clearTimeout(timer);
  }, [resized, sizeSettling]);
  // The settling offset goes away once the move has landed, or when it never does (a refused move).
  useEffect(() => {
    if (!dropped) return undefined;
    if (!settling) {
      setDropped(null);
      return undefined;
    }
    const timer = setTimeout(() => setDropped(null), 1500);
    return () => clearTimeout(timer);
  }, [dropped, settling]);
  const crosshair = pageToSheet(layout, doc.crosshair.page, doc.crosshair.x, doc.crosshair.y);
  const area = printableArea(setup);
  // The view follows the crosshair when it is moved (arrow keys): it scrolls just enough to show it. The
  // scroll is computed from the known geometry and the last scroll position seen by `onScroll`, not with
  // `scrollIntoView`, which forces a layout of the whole sheet on every step.
  const crosshairRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const viewport = areaRef.current;
    if (!viewport) return;
    const reach = (CROSSHAIR_HALF_PX + 1) * zoom;
    const centerY = (draft && !printing ? 0 : EQUAVELA_PADDING_PX) + crosshair.y * zoom;
    const centerX = left + crosshair.x * zoom;
    const seen = scrollPosition.current;
    const nearest = (start: number, size: number, center: number) =>
      center - reach < start ? center - reach : center + reach > start + size ? center + reach - size : start;
    const top = Math.max(0, nearest(seen.top, areaHeight, centerY));
    const leftEdge = Math.max(0, nearest(seen.left, areaWidth, centerX));
    if (top !== seen.top || leftEdge !== seen.left) {
      scrollPosition.current = { top, left: leftEdge };
      viewport.scrollTo?.({ top, left: leftEdge });
    }
    // Only a crosshair move scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.crosshair.page, doc.crosshair.x, doc.crosshair.y]);

  /** A double click in the math being edited selects the name or number under the pointer. */
  const onRegionDoubleClick = (event: MouseEvent<HTMLElement>, id: string) => {
    if (!editing || (editing.regionId ?? DRAFT_ID) !== id || event.shiftKey || event.ctrlKey || event.metaKey) return;
    if ((event.target as Element).closest?.(".region-drag-border")) return;
    const hit = mathHit(event.currentTarget, event.target, event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    selectPress.current = null;
    onMathSelect?.(hit, hit, true);
  };

  // Handlers handed to every region keep one identity across renders: `RegionView` is memoized
  // and must not render again because the selection or the editing state changed elsewhere.
  const regionPointerDown = useStableCallback(onRegionPointerDown);
  const regionDoubleClick = useStableCallback(onRegionDoubleClick);
  const regionCompletion = useStableCallback(onCompletion);
  const regionAreaTitle = useStableCallback(onAreaTitle);
  const regionIncludePath = useStableCallback(onIncludePath);
  const regionBrowseInclude = useStableCallback(onBrowseInclude);
  const regionJuliaChange = useStableCallback(onJuliaChange);
  const regionResizeStart = useStableCallback(onResizeStart);
  const regionToggleArea = useStableCallback((id: string) => {
    // A pending region edit is committed first, like any click outside its region; then the
    // area changes. The indicator is a button, so the sheet takes the focus back: typing
    // right after the click starts a region, not an activation of the button again.
    onBackground?.();
    onToggleArea?.(id);
    areaRef.current?.focus({ preventScroll: true });
  });
  // The drawn region (stored region at its reflowed page and y) is cached, so a region that did not move
  // and did not change keeps the very same object and its memoized view does not render again.
  const placedRegions = useRef(new Map<string, { source: ViewRegion; region: ViewRegion }>());
  useEffect(() => {
    const ids = new Set(view.regions.map((r) => r.id));
    for (const id of placedRegions.current.keys()) if (!ids.has(id)) placedRegions.current.delete(id);
  }, [view.regions]);

  // The height a band is drawn with: the stored one, or the one its end line is being dragged to
  //, so the parts it is split into follow the pointer across the page breaks it crosses.
  const areaHeightOf = (id: string, height: number): number =>
    resize && resize.id === id && resize.height ? resize.height.value : height;

  // The parts an area draws. A collapsed band is only its header, on the page
  // it starts on.
  const partsOf = (region: ViewRegion & { kind: "area" }): AreaPart[] => {
    const drawn = placedOf(region);
    const height = areaHeightOf(region.id, bandHeight(region));
    const parts = areaParts(flowFrame(setup), { page: drawn.page, y: drawn.y, height });
    if (!region.collapsed) return parts;
    // The header stays on the page the band starts on, at its stored `y`.
    const start = parts[0] ?? { page: drawn.page, top: drawn.y };
    return [{ page: start.page, top: start.top, height: AREA_HEADER_PT, header: true, end: false }];
  };

  /** The stored height of a band, `undefined` for every other region. */
  const heightOf = (region: ViewRegion): number | undefined => (region.kind === "area" ? region.height : undefined);

  // One region at its drawn place; `origin` is the sheet position of the container (zero in the page
  // view, the page's corner in the print view). `part` draws one part of a band instead of the whole
  // region, at that part's page and y.
  const renderRegion = (
    source: ViewRegion,
    origin: { x: number; y: number },
    continued = false,
    part?: AreaPart,
  ) => {
      const drawn = part ? { page: part.page, y: part.top } : placedOf(source);
      let region = source;
      if (source.id === DRAFT_ID) {
        if (source.kind === "math") {
          const rise = sizes.current.get(DRAFT_ID)?.rise ?? 0;
          if (rise > 0) {
            const anchor = snapToGrid(source.y);
            region = { ...source, y: Math.max(anchor - rise, Math.min(anchor, area.top)) };
          }
        }
      } else {
        // A part of a band keeps a key of its own, so two parts of one area never share a cached view.
        const key = part
          ? `${source.id}#${part.page}:${part.header ? "start" : part.end ? "end" : "middle"}`
          : source.id;
        const cached = placedRegions.current.get(key);
        if (
          cached &&
          cached.source === source &&
          cached.region.page === drawn.page &&
          cached.region.y === drawn.y &&
          (!part || heightOf(cached.region) === part.height)
        ) {
          region = cached.region;
        } else {
          // Only a band is drawn part by part, so the part fields are those of an area region.
          region = part
            ? ({ ...source, page: part.page, y: part.top, height: part.height } as ViewRegion)
            : { ...source, page: drawn.page, y: drawn.y };
          placedRegions.current.set(key, { source, region });
        }
      }
      const sheetAt = pageToSheet(layout, region.page, region.x, region.y);
      const at = { x: sheetAt.x - origin.x, y: sheetAt.y - origin.y };
      return (
        <RegionView
          key={part ? `${region.id}:part:${part.page}:${part.header ? "start" : part.end ? "end" : "middle"}` : continued ? `${region.id}:continued` : region.id}
          continued={continued}
          areaPart={part ? areaPartOf(part.header, part.end) : undefined}
          region={region}
          fastSymbolicBusy={fastSymbolicBusy === region.id}
          setup={setup}
          left={at.x}
          top={at.y}
          dragOffset={
            dragged.has(region.id) && dragOffset && (!part || part.header)
              ? (region.kind === "text" && region.full_width) || region.kind === "area"
                ? verticalDragOffset
                : dragOffset
              : null
          }
          selected={selected.has(region.id)}
          resultActive={resultSelection?.regionId === region.id}
          entry={entries.get(region.id)}
          inlineEntries={region.kind === "text" ? entries : undefined}
          diagnostics={diagnosticsByRegion.get(region.id) ?? NO_DIAGNOSTICS}
          format={regionFormats.get(region.id) ?? format}
      settings={view.settings}
          onPointerDown={regionPointerDown}
          onDoubleClick={regionDoubleClick}
          onSize={onSize}
          resizing={
            resize && resize.id === region.id
              ? { w: resize.width, h: resize.height?.value ?? null }
              : sizeSettling?.id === region.id ? sizeSettling : null
          }
          warnings={warningsByRegion.get(region.id)}
          onAreaTitle={regionAreaTitle}
          onIncludePath={regionIncludePath}
          onBrowseInclude={regionBrowseInclude}
          onToggleArea={regionToggleArea}
          onJuliaChange={regionJuliaChange}
          trusted={view.trusted !== false}
          onResizeStart={
            !dragOffset &&
            (!part || part.end) &&
            ((doc.selection.length === 1 && selected.has(region.id)) ||
              (textEditingId !== null && textEditingId === region.id))
              ? regionResizeStart
              : undefined
          }
        />
      );
  };

  // The edit state goes to the edited region through the edit store, not through the region list
  //: a keystroke renders that region only.
  const [editStore] = useState(createRegionEditStore);
  const textEditingId = textEditingHere?.regionId ?? null;
  const edit = useMemo<RegionEdit | null>(() => {
    if (editingHere) {
      return {
        regionId: editingHere.regionId ?? DRAFT_ID,
        editor: editingHere.editor,
        breaks: breakWires(editingHere.editor.root, editingHere.editor.breaks, false),
        textEdit: null,
        completions,
        completionIndex,
        onCompletion: regionCompletion,
      };
    }
    if (textEditingHere && textBinding) {
      return {
        regionId: textEditingHere.regionId ?? DRAFT_ID,
        editor: null,
        breaks: [],
        textEdit: { ...textBinding, initial: textEditingHere.initial, point: textEditingHere.point, atStart: textEditingHere.atStart, atEnd: textEditingHere.atEnd },
        completions: NO_COMPLETIONS,
        completionIndex: 0,
      };
    }
    return null;
  }, [editingHere, textEditingHere, textBinding, completions, completionIndex, regionCompletion]);
  useLayoutEffect(() => editStore.set(edit), [editStore, edit]);

  // ---- virtualization ---------------------------------------------------------
  // In the page view with a real layout (not the print view, not jsdom), only the regions whose drawn
  // rectangle is near the visible part of the sheet are mounted; the region being edited and the
  // selected ones always are. Their positions come from measured sizes, or estimates until the
  // measuring layer below has measured them.
  const virtual = !printing && !draft && areaHeight > 0;
  const editingId = editingHere ? (editingHere.regionId ?? DRAFT_ID) : null;
  // The mounted band of the sheet, in sheet px (unzoomed).
  const mountBand = useMemo(() => {
    const reach = areaHeight * MOUNT_MARGIN_VIEWPORTS;
    return {
      top: (scrollTop - EQUAVELA_PADDING_PX - reach) / zoom,
      bottom: (scrollTop - EQUAVELA_PADDING_PX + areaHeight + reach) / zoom,
    };
  }, [scrollTop, areaHeight, zoom]);
  // The page backgrounds (frame, margin guides, header and footer placeholders) of the band only.
  const shownPages = useMemo(
    () => (virtual ? layout.pages.filter((rect) => rect.top + rect.height >= mountBand.top && rect.top <= mountBand.bottom) : layout.pages),
    [virtual, layout, mountBand],
  );
  const mounted = useMemo(() => {
    if (!virtual) return shown;
    const { top, bottom } = mountBand;
    // The regions being pictured for the clipboard stay mounted while their selection is aside.
    const keep = new Set<string>([...doc.selection, ...pictured]);
    if (editingId) keep.add(editingId);
    if (textEditingId) keep.add(textEditingId);
    return shown.filter((region) => {
      if (keep.has(region.id)) return true;
      // A band is drawn on every page it reaches, so it is not left out because the
      // page it starts on is above the view.
      if (region.kind === "area") return true;
      const placed = placedOf(region);
      const at = pageToSheet(layout, placed.page, region.x, placed.y);
      const height = ptToPx(sizeOf(region.id).h);
      return at.y + height >= top && at.y <= bottom;
    });
    // `sizeVersion` stands for the sizes behind `sizeOf`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtual, shown, placedOf, layout, mountBand, doc.selection, pictured, editingId, textEditingId, sizeOf, sizeVersion]);

  // The measuring layer: regions that are not mounted and were never measured, or changed since, are
  // drawn invisibly in small chunks when the main thread is idle, so their sizes (and so the reflow
  // and the page count) become exact without mounting the whole worksheet.
  const [probing, setProbing] = useState<ViewRegion[]>([]);
  // Where the next search for unmeasured regions starts, so the whole list is not scanned per chunk.
  const probeCursor = useRef(0);
  // The last key press, click or wheel: measuring pauses while the user is working.
  const lastInput = useRef(0);
  useEffect(() => {
    const note = () => {
      lastInput.current = performance.now();
    };
    window.addEventListener("keydown", note, true);
    window.addEventListener("pointerdown", note, true);
    window.addEventListener("wheel", note, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", note, true);
      window.removeEventListener("pointerdown", note, true);
      window.removeEventListener("wheel", note, true);
    };
  }, []);
  // Probed sizes are applied together at most every PROBE_APPLY_MS: each application reflows the sheet.
  const probeApply = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onProbeSize = useCallback((id: string, size: Size) => {
    measuredFor.current.set(id, { region: latest.current.regions.get(id), entry: latest.current.entries.get(id) });
    const previous = sizes.current.get(id);
    if (previous && previous.w === size.w && previous.h === size.h) return;
    sizes.current.set(id, size);
    if (probeApply.current === null) {
      probeApply.current = setTimeout(() => {
        probeApply.current = null;
        anchorNext.current = true;
        bump((n) => n + 1);
      }, PROBE_APPLY_MS);
    }
  }, []);
  useEffect(() => () => {
    if (probeApply.current !== null) clearTimeout(probeApply.current);
  }, []);
  /** The result entries the measuring layer last measured against (a changed result can resize a region). */
  const measuredEntries = useRef(entries);
  /**
   * The last pass over the whole worksheet that found nothing to measure, and the layout it was for:
   * while nothing moved and no result changed there is nothing left to look for, and an edit only has
   * to look at the regions it changed.
   */
  const cleanSweep = useRef<{ complete: boolean; layout: number }>({ complete: false, layout: 0 });
  useEffect(() => {
    if (!virtual) return;
    if (probing.length > 0) {
      const done = probing.every((region) => {
        const was = measuredFor.current.get(region.id);
        return was && was.region === region;
      });
      if (done) setProbing([]);
      else {
        // A region that never reports a size (an empty one) must not stall the layer.
        const timer = setTimeout(() => setProbing([]), 1000);
        return () => clearTimeout(timer);
      }
      return;
    }
    const inWindow = new Set(mounted.map((region) => region.id));
    const stale: ViewRegion[] = [];
    // A region the patch names may also be found by the sweep below: one probe per region, or the
    // list gets two children with the same key and the region is drawn twice.
    const staleIds = new Set<string>();
    const isStale = (region: ViewRegion): boolean => {
      const was = measuredFor.current.get(region.id);
      return !was || was.region !== region || was.entry !== entries.get(region.id);
    };
    const addStale = (region: ViewRegion) => {
      if (staleIds.has(region.id)) return;
      staleIds.add(region.id);
      stale.push(region);
    };
    // The regions the last edit added or rewrote are the only ones whose measurement can be stale, so
    // they are checked by id instead of walking the whole worksheet on every edit.
    const changed = index.changed;
    for (const id of changed ?? []) {
      if (stale.length >= PROBE_CHUNK) break;
      const region = index.byId.get(id);
      if (!region || region.kind === "area" || inWindow.has(id)) continue;
      if (isStale(region)) addStale(region);
    }
    // The rest of the worksheet is searched only when something may have changed without the patch
    // saying so: an index built from scratch (nothing says what changed), a result that changed (any
    // region may be resized), a layout that moved, or a pass that never found the worksheet measured.
    const resized = measuredEntries.current !== entries;
    measuredEntries.current = entries;
    const clean = cleanSweep.current;
    const searchWhole =
      changed === null || resized || changed.length > PROBE_CHUNK || !clean.complete || clean.layout !== index.geometry;
    const count = shown.length;
    for (let seen = 0; searchWhole && seen < count && stale.length < PROBE_CHUNK; seen++) {
      const at = (probeCursor.current + seen) % count;
      const region = shown[at];
      if (region.kind === "area" || inWindow.has(region.id)) continue;
      if (isStale(region)) {
        addStale(region);
        probeCursor.current = at + 1;
      }
    }
    if (searchWhole) cleanSweep.current = { complete: stale.length === 0, layout: index.geometry };
    if (stale.length === 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const start = () => {
      // Not while the user types or clicks: try again once the input has been quiet for a moment.
      const quiet = performance.now() - lastInput.current;
      if (quiet < PROBE_QUIET_MS) timer = setTimeout(start, PROBE_QUIET_MS - quiet);
      else setProbing(stale);
    };
    timer = setTimeout(start, PROBE_GAP_MS);
    return () => clearTimeout(timer);
  }, [virtual, probing, shown, mounted, entries, sizeVersion, index]);
  // Scroll anchoring: when measured sizes replace estimates, regions above the
  // view may move; the first region visible at the top keeps its place on the screen. Only for sizes
  // from the measuring layer: an edit moves what it moves.
  const anchorNext = useRef(false);
  const anchor = useRef<{ id: string; y: number } | null>(null);
  useLayoutEffect(() => {
    const viewport = areaRef.current;
    if (!virtual || !viewport) return;
    const drawnTop = (id: string) => {
      const region = regionById.get(id);
      if (!region) return null;
      const placed = placedOf(region);
      return pageToSheet(layout, placed.page, region.x, placed.y).y;
    };
    if (anchorNext.current && anchor.current) {
      const now = drawnTop(anchor.current.id);
      if (now !== null && Math.abs(now - anchor.current.y) > 0.5) {
        const top = Math.max(0, scrollPosition.current.top + (now - anchor.current.y) * zoom);
        scrollPosition.current = { ...scrollPosition.current, top };
        viewport.scrollTop = top;
      }
    }
    anchorNext.current = false;
    // The anchor for the next correction: the first mounted region whose top is in the view.
    const viewTop = (scrollPosition.current.top - EQUAVELA_PADDING_PX) / zoom;
    let best: { id: string; y: number } | null = null;
    for (const region of mounted) {
      const y = drawnTop(region.id);
      if (y === null || y < viewTop) continue;
      if (!best || y < best.y) best = { id: region.id, y };
    }
    anchor.current = best;
  }, [virtual, mounted, layout, placedOf, regionById, zoom]);
  const probeElements = probing.map((region) => (
    <RegionView
      key={`probe:${region.id}`}
      probe
      region={region}
      setup={setup}
      left={0}
      top={0}
      dragOffset={null}
      selected={false}
      entry={entries.get(region.id)}
      inlineEntries={region.kind === "text" ? entries : undefined}
      diagnostics={diagnosticsByRegion.get(region.id) ?? NO_DIAGNOSTICS}
      format={regionFormats.get(region.id) ?? format}
      onPointerDown={ignorePointer}
      onSize={onProbeSize}
      warnings={warningsByRegion.get(region.id)}
    />
  ));

  // The elements of one region inside one page block of the print view: an area draws the part
  // of its band that belongs to that page, every other region the part of itself the
  // page shows.
  const renderOnPage = (source: ViewRegion, rect: { page: number; left: number; top: number }) => {
    const origin = { x: rect.left, y: rect.top };
    if (source.kind === "area") {
      // Each page carries one part of the band: only the part with the header is the region's own
      // element, the others are drawn as its continuation (one `data-region-id` for the whole band).
      return partsOf(source)
        .filter((part) => part.page === rect.page)
        .map((part) => renderRegion(source, origin, !part.header, part));
    }
    const placed = placedOf(source);
    if (placed.page === rect.page) return [renderRegion(source, origin)];
    if (placed.page < rect.page && rect.page <= reach(source)) return [renderRegion(source, origin, true)];
    return [];
  };

  // The regions of the page view, built again only when what they show changes: not on a crosshair
  // step, not on a keystroke. `RegionLayer` then skips the whole list when it is the same.
  const regionElements = useMemo(
    () =>
      mounted.flatMap((source) =>
        source.kind === "area"
          ? partsOf(source).map((part, index) => renderRegion(source, { x: 0, y: 0 }, index > 0, part))
          : [renderRegion(source, { x: 0, y: 0 })],
      ),
    // `renderRegion` reads exactly these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted, placedOf, layout, selected, resultSelection, dragged, dragOffset, resize, sizeSettling, entries, regionFormats, format, view.settings, diagnosticsByRegion, warningsByRegion, setup, textEditingId, onSize, fastSymbolicBusy],
  );

  return (
    <div
      className={`worksheet-area${draft ? " draft" : ""}`}
      ref={areaRef}
      tabIndex={0}
      onScroll={() => {
        const scrolled = areaRef.current;
        if (scrolled) scrollPosition.current = { top: scrolled.scrollTop, left: scrolled.scrollLeft };
        // The render window follows the scroll once per frame.
        if (!scrollFrame.current) {
          scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = 0;
            setScrollTop(scrollPosition.current.top);
          });
        }
        reportPage();
        const viewport = areaRef.current;
        if (draft && viewport) {
          const right = (viewport.scrollLeft + viewport.clientWidth) / zoom;
          const bottom = (viewport.scrollTop + viewport.clientHeight) / zoom;
          setDraftExtent((extent) => {
            const width = right > extent.width - 400 ? Math.max(extent.width, right + 800) : extent.width;
            const height = bottom > extent.height - 400 ? Math.max(extent.height, bottom + 800) : extent.height;
            return width === extent.width && height === extent.height ? extent : { width, height };
          });
        }
        hoveredName.current = null;
        onNameHover?.(null);
      }}
      onWheel={onWheel}
      onDragOver={(event) => {
        if (onDropFiles && event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!onDropFiles || files.length === 0) return;
        event.preventDefault();
        onDropFiles(files, placeAt(event.clientX, event.clientY));
      }}
      data-testid="worksheet-area"
      aria-label={doc.name}
    >
      <div
        className="sheet-box"
        style={
          printing
            ? { width: `${setup.width}pt` }
            : {
                marginLeft: left,
                marginTop: draft ? 0 : EQUAVELA_PADDING_PX,
                width: layout.width * zoom,
                height: layout.height * zoom,
              }
        }
      >
        <div
          ref={sheetRef}
          className={`sheet${band ? " banding" : ""}${drag && !drag.text ? " dragging" : ""}`}
          data-testid="sheet"
          onPointerMove={onSheetMove}
          onPointerLeave={onSheetLeave}
          style={{
            ...(printing
              ? { width: `${setup.width}pt` }
              : {
                  width: layout.width,
                  height: layout.height,
                  transform: `scale(${zoom})`,
                }),
            // The label styles of the worksheet: a name takes its colour from a custom property
            // of the sheet, which holds the same declarations in the page view and in the print view.
            ...labelCss,
          }}
        >
          {!printing && shownPages.map((rect) => (
            <div
              key={rect.page}
              className="page"
              data-page={rect.page}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
              onPointerDown={onPagePointerDown}
            >
              <PageGuides setup={setup} />
              {!draft && <PageChrome setup={setup} page={rect.page} file={pageFile} date={pageDate} hint />}
              {!draft && breakPages.has(rect.page) && <div className="page-break-mark no-print" data-testid={`page-break-${rect.page}`} />}
              {draft && rect.page > 1 && (
                <div className={`draft-break no-print${breakPages.has(rect.page - 1) ? " manual" : ""}`} data-testid={`draft-break-${rect.page}`} />
              )}
            </div>
          ))}
          {draft && (
            <svg
              className="draft-margin no-print"
              style={{ left: ptToPx(setup.width), top: 0, height: layout.height }}
              width={2}
              height={layout.height}
              aria-hidden="true"
            >
              <line x1="1" y1="0" x2="1" y2={layout.height} stroke="currentColor" strokeWidth={1.5} strokeDasharray="1 3" />
            </svg>
          )}
          {/* Hidden under a new region being typed, which would draw over it. */}
          {view.regions.length === 0 && draftRegions(editingHere, textEditingHere).length === 0 && (
            <div className="empty-hint no-print" style={{ left: ptToPx(area.left), top: ptToPx(area.top) + 40 }}>
              {S.page.emptyHint}
            </div>
          )}
          <RegionEditContext.Provider value={editStore}>
          <LabelStylesContext.Provider value={labelStyles}>
          <MathNamesContext.Provider value={names}>
          {printing
            ? layout.pages.map((rect) => (
                <div
                  key={rect.page}
                  className="page print-page"
                  data-page={rect.page}
                  style={{
                    width: `${setup.width}pt`,
                    height: `${setup.height}pt`,
                    breakAfter: rect.page === layout.pages.length ? "auto" : "page",
                  }}
                >
                  {/* The header and the footer of this page: the same component as the page view
                      draws them, so the PDF and the screen agree. */}
                  <PageChrome setup={setup} page={rect.page} file={pageFile} date={pageDate} hint={false} />
                  {/* Every region the page shows, at exactly the offset it has on screen. An
                      area band draws here the part that belongs to this page. */}
                  {shown.flatMap((source) => renderOnPage(source, rect))}
                </div>
              ))
            : (
                <>
                  <RegionLayer elements={regionElements} />
                  {probeElements.length > 0 && (
                    <div className="measure-layer" aria-hidden="true">
                      {probeElements}
                    </div>
                  )}
                  {draftRegions(editingHere, textEditingHere).map((source) => renderRegion(source, { x: 0, y: 0 }))}
                </>
              )}
          </MathNamesContext.Provider>
          </LabelStylesContext.Provider>
          </RegionEditContext.Provider>
          {!dragOffset && !(editingHere && editingHere.regionId === null) && !textEditingHere && (
            <svg
              ref={crosshairRef}
              className="crosshair no-print"
              style={{ left: crosshair.x - 8, top: crosshair.y - 8 }}
              width={17}
              height={17}
              aria-hidden="true"
              data-testid="crosshair"
            >
              <line x1="8.5" y1="0" x2="8.5" y2="17" stroke="currentColor" strokeWidth={1.4} />
              <line x1="0" y1="8.5" x2="17" y2="8.5" stroke="currentColor" strokeWidth={1.4} />
            </svg>
          )}
          {band && (
            <div
              className="band no-print"
              style={{
                left: Math.min(band.x0, band.x1),
                top: Math.min(band.y0, band.y1),
                width: Math.abs(band.x1 - band.x0),
                height: Math.abs(band.y1 - band.y0),
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const ignorePointer = () => undefined;

/** The page view's regions: skipped as a whole when the list is the same. */
const RegionLayer = memo(function RegionLayer({ elements }: { elements: ReactNode[] }) {
  return <>{elements}</>;
});

function draftRegions(editing: Editing | null, text: TextEditing | null): ViewRegion[] {
  if (text && text.regionId === null) {
    return [
      {
        id: DRAFT_ID,
        page: text.page,
        x: text.x,
        y: text.y,
        enabled: true,
        kind: "text",
        text: "",
        // A new box has no stored width: it grows with its text.
        width: null,
        ...(text.full ? { full_width: true } : {}),
        paragraphs: text.initial,
      },
    ];
  }
  if (!editing || editing.regionId !== null) return [];
  return [
    {
      id: DRAFT_ID,
      page: editing.page,
      x: editing.x,
      y: editing.y,
      enabled: true,
      kind: "math",
      text: "",
      statement: editing.editor.root,
    },
  ];
}

/**
 * The margin guides of one page: screen only, so the print view does not draw them.
 */
function PageGuides({ setup }: { setup: DocState["view"]["page"] }) {
  const area = printableArea(setup);
  const x = ptToPx(area.left);
  const y = ptToPx(area.top);
  const w = ptToPx(area.width);
  const h = ptToPx(area.height);
  return (
    <svg className="margin-guides no-print" width="100%" height="100%" aria-hidden="true">
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="2 4"
      />
    </svg>
  );
}

/**
 * The header and the footer of one page: document content, drawn by this
 * component in the page view and in the print-view page block alike, so the screen and the PDF
 * agree.
 */
function PageChrome({
  setup,
  page,
  file,
  date,
  hint,
}: {
  setup: DocState["view"]["page"];
  page: number;
  file: string;
  date: string;
  /** Draw the hint of an empty line: the page view does, the print view does not. */
  hint: boolean;
}) {
  const values = { page, date, file };
  return (
    <>
      <PageLine kind="header" line={setup.header} values={values} setup={setup} hint={hint} />
      <PageLine kind="footer" line={setup.footer} values={values} setup={setup} hint={hint} />
    </>
  );
}

/**
 * The header band or the footer band of one page: the top margin and the
 * bottom margin, from the left margin to the right margin, with the three slots drawn at the left
 * edge, the middle and the right edge and their tokens replaced. A line whose three slots
 * are empty draws the screen-only hint instead, and nothing is printed for it.
 */
function PageLine({
  kind,
  line,
  values,
  setup,
  hint,
}: {
  kind: "header" | "footer";
  line: DocState["view"]["page"]["header"];
  values: { page: number; date: string; file: string };
  setup: DocState["view"]["page"];
  hint: boolean;
}) {
  const band = {
    left: ptToPx(setup.margins.left),
    width: ptToPx(setup.width - setup.margins.left - setup.margins.right),
    height: ptToPx(kind === "header" ? setup.margins.top : setup.margins.bottom),
    ...(kind === "header" ? { top: 0 } : { bottom: 0 }),
  };
  if (isEmptyLine(line)) {
    // The hint is screen state, never printed; the page number still shows where the
    // footer will be, so `{page}` has something to point at. The print view does not draw it at all.
    if (!hint) return null;
    return (
      <div className={`${kind}-placeholder no-print`} style={band}>
        {kind === "header" ? S.page.header : `${S.page.footer} · ${S.page.pageNumber(values.page)}`}
      </div>
    );
  }
  const drawn = renderLine(line, values);
  return (
    <div className={`${kind}-line`} style={band} data-testid={`page-${kind}`} data-page={values.page}>
      <span className="page-line-left">{drawn.left}</span>
      <span className="page-line-center">{drawn.center}</span>
      <span className="page-line-right">{drawn.right}</span>
    </div>
  );
}
