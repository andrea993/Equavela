// State of the application window: open worksheets, selection, calculation state, zoom.
// Document content (regions, undo history) is owned by the backend; this hook only mirrors
// the last view the backend returned and sends commands.

import { setRealCtrl } from "../keymap/nativeKeys";
import { fastSymbolicContext, type FastSymbolicOperation, type FastSymbolicOptions } from "../editor/fastSymbolic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Backend, BackendMode, ReferencesChange } from "../backend";
import type { EnvironmentInfo, EnvironmentMetadataFile, EnvironmentOperation, EnvironmentSwitchPreview } from "../equavelaApi";
import { storedY, withMembers } from "../layout/areas";
import { NEW_REGION_HEIGHT_PT, placeOnPage } from "../layout/insert";
import { dropImages } from "../page/ImageContext";
import { fileToBase64 } from "../page/imageFiles";
import { clampZoom, freeSpot, printableArea, snapToGrid, type FlowRect } from "../layout/geometry";
import { crosshairBeside, LINE_ABOVE_CROSSHAIR_PT, moveCrosshair as stepCrosshair, moveDraftCrosshair, regionAt, type Direction } from "../layout/crosshair";
import {
  addPageBreakShift,
  areaBodyAt,
  insertWorksheetLine,
  insertWorksheetLineInArea,
  lineInsertionPoint,
  type LineInsertion,
  pageBreakAtKey,
  removePageBreakShift,
  removeWorksheetLine,
  removeWorksheetLineAbove,
  removeWorksheetLineAboveInArea,
  removeWorksheetLineInArea,
  WORKSHEET_LINE_PT,
} from "../layout/lines";
import { S } from "../strings";
import { enterPrint, leavePrint, printReady, withPrintView } from "../print/printMode";
import { apply as applyEditor, breakWires, initialState as initialEditor, placeCaret, type Caret, type EditorState, type Side } from "../editor/model";
import { drawnParenPath, isEmptyKeywordGroup, isEmptyStatement, toEditing, toWire, withDrawnParens, withKeywordSlot, withIntegralBoundSlots, withTableUnitSlots, remapIntegralBoundHit, WireError, type Node, type Path } from "../editor/tree";
import { isEmptyText, sameText } from "../text/value";
import { loadProjectSession, relativeTo, saveProjectSession } from "./projectSession";
import { reuseEntries, reuseRegions, sameValue } from "./reuse";
import { inheritEntriesPatch, inheritRegionsPatch, regionsPatchOf } from "./patches";
import { replacementOf } from "./replace";
import { mathReplacementOf } from "./mathFind";
import {
  applyWorksheetEvents,
  type CommandError,
  type DocumentView,
  type EditResult,
  type ImportReport,
  type KernelStatus,
  type KernelStatusEvent,
  type EnvironmentSummary,
  type NewRegionKind,
  type OpenedWorksheet,
  type OpenedProject,
  type NewItemKind,
  type ProjectChange,
  type ProjectReferences,
  type ReferenceCommand,
  type TreeEntry,
  type MathBreak,
  type MathFontEdit,
  type PageSetup,
  type SavedWorksheet,
  type PlotSpec,
  type RegionEntry,
  type RegionMove,
  type RegionRewrite,
  type RichText,
  type SessionDiagnostic,
  type ViewRegion,
  type WorksheetEvent,
} from "../equavelaApi";
import { trackRunningRegion } from "./runningRegion";
import { AUTOSAVE_DEFAULT_SECONDS, DEFAULT_SETTINGS, sanitizeSettings, type AppSettings } from "../settings";
import { readRecentFiles, RECENT_PROJECTS_KEY, withRecent, writeRecentFiles } from "../recentFiles";

/** Default autosave interval: a modified worksheet is backed up this often. */
export const RECOVERY_INTERVAL_MS = AUTOSAVE_DEFAULT_SECONDS * 1000;

export type CalcMode = "auto" | "manual";
export type ViewMode = "page" | "draft";

export type Crosshair = { page: number; x: number; y: number };

export type Progress = { done: number; total: number; stopping: boolean };

/**
 * The stored point of the crosshair: the drawn crosshair is mapped to
 * the stored y and, inside an area band, to the top of the band, so a line or a page
 * break inserted there moves the band and its members together.
 */
function storedInsertionPoint(doc: DocState): { page: number; y: number } {
  const { page } = doc.crosshair;
  const stored = { page, y: storedY(doc.view.regions, doc.view.page, page, doc.crosshair.y) };
  const bands = doc.view.regions
    .filter((region) => region.kind === "area")
    .map((region) => ({ page: region.page, y: region.y, height: region.height }));
  return lineInsertionPoint(bands, stored.page, stored.y);
}

/** The crosshair as a stored position, with no snapping to an area band (`storedInsertionPoint` snaps). */
function storedCrosshair(doc: DocState): { page: number; y: number } {
  const { page } = doc.crosshair;
  return { page, y: storedY(doc.view.regions, doc.view.page, page, doc.crosshair.y) };
}

/** The expanded areas of the sheet as the line commands read them (a collapsed one has no body to be in). */
function lineAreasOf(doc: DocState): { id: string; page: number; y: number; height: number }[] {
  return doc.view.regions
    .filter((region) => region.kind === "area" && !region.collapsed)
    .map((region) => ({ id: region.id, page: region.page, y: region.y, height: region.kind === "area" ? region.height : 0 }));
}

/** The stored places the flow arithmetic of the sheet works on (`layout/lines.ts`). */
function flowRegionsOf(doc: DocState): { id: string; page: number; y: number }[] {
  return doc.view.regions.map((region) => ({ id: region.id, page: region.page, y: region.y }));
}

/** Where a click landed in a math region (for placing the caret). */
/** Id of a region that exists only in the editor until it is committed (`PageView.DRAFT_ID`). */
const DRAFT_REGION = "__new";

/** The fallback delay of a frame when the webview has no `requestAnimationFrame`. */
const FRAME_MS = 16;

export type MathHit = { path: Path; side: Side; caret: Caret | null };

/**
 * The math region being edited. `regionId` is null for a new region typed at the
 * crosshair (it exists only here until it is committed). `original` is the editing form
 * of the committed math (JSON), to skip commits that change nothing. `rejected` holds the
 * reason the last commit was refused (Escape then discards the changes).
 */
export type Editing = {
  docId: string;
  regionId: string | null;
  page: number;
  x: number;
  y: number;
  editor: EditorState;
  /** Original crosshair line for a new region, whose top starts one line above it. */
  insertionY?: number;
  original: string | null;
  /** The committed presentation breaks, to skip a commit that only opened the region. */
  originalBreaks: MathBreak[];
  rejected: string | null;
  /**
   * The region was opened by the paste that created it: with nothing to undo in the editor, Undo
   * undoes that paste.
   */
  pasted?: true;
};

/**
 * The text region being edited. `regionId` is null for a new region at the crosshair (it exists
 * only here until it is committed). `point` is the client position of the click that opened it
 * (the caret goes there). The live value and the baseline (what the editor read when it opened,
 * to skip commits that change nothing) are kept in refs by `useWorkbench`, not in state.
 */
export type TextEditing = {
  docId: string;
  regionId: string | null;
  page: number;
  x: number;
  y: number;
  initial: RichText;
  point: { x: number; y: number } | null;
  /** A new text block from margin to margin (Ctrl+Shift+T). */
  full?: boolean;
  /** Open with the caret at the start of the text (entered with an arrow key from the crosshair). */
  atStart?: boolean;
  /** Open with the caret at the end of the text. */
  atEnd?: boolean;
  /** The math draft this text box replaced: Ctrl+Z before anything is typed brings it back. */
  fromMath?: EditorState;
  /** The backend refused the text: the reason; the next Escape discards instead of committing. */
  rejected?: string | null;
};

export type DocState = {
  id: string;
  root: string;
  name: string;
  view: DocumentView;
  results: RegionEntry[];
  diagnostics: SessionDiagnostic[];
  /** The worksheet's Julia environment; `null` when the backend does not say. */
  environment: EnvironmentSummary | null;
  selection: string[];
  running: boolean;
  progress: Progress | null;
  crosshair: Crosshair;
  /** Bumped whenever calculated plot data may have changed (an edit, a finished pass): plots ask again. */
  revision: number;
  /**
   * Dirty state: `edits` counts the edit results (every edit, undo and redo) since the worksheet was
   * opened or saved-as; `savedEdits` is its value at the last save. They differ while the worksheet
   * has unsaved changes (undoing back to the saved state still counts as modified).
   */
  edits: number;
  savedEdits: number;
};

export type WorkbenchState = {
  mode: BackendMode;
  docs: DocState[];
  activeId: string | null;
  /** The last kernel status that named no environment (the shared kernel at start-up). */
  kernel: KernelStatus | null;
  /** The status of each environment's kernel, by kernel key. */
  kernels: Record<string, KernelStatus>;
  calcMode: CalcMode;
  zoom: number;
  viewMode: ViewMode;
  message: string | null;
  /** How the message bar draws `message` (success green, info blue, warning amber, error red). */
  messageLevel: MessageLevel;
  ready: boolean;
  editing: Editing | null;
  textEditing: TextEditing | null;
  /** A question to the user (confirm before close, restore a recovery file); see `ask`. */
  prompt: Prompt | null;
};

/** A modal question with one button per answer; the answer is the chosen button's id. */
export type Prompt = {
  title: string;
  message: string;
  buttons: { id: string; label: string; primary?: boolean }[];
  /** The answer of Escape and of a click outside. */
  cancel: string;
};

/** The severity of a message of the bar: what colour and role it gets. */
export type MessageLevel = "success" | "info" | "warning" | "error";

type Action =
  | { type: "ready" }
  | { type: "kernel"; status: KernelStatusEvent }
  | { type: "opened"; opened: OpenedWorksheet; modified?: boolean }
  | { type: "prompt"; prompt: Prompt | null }
  | { type: "closed"; id: string }
  | { type: "saved"; id: string; path: string; opened: OpenedWorksheet | null }
  | { type: "activate"; id: string }
  /** `clean`: a change of what the worksheet sees (its references), not of its file. */
  | { type: "edited"; id: string; result: EditResult; select?: string[]; clean?: boolean }
  | { type: "select"; id: string; selection: string[] }
  | { type: "crosshair"; id: string; crosshair: Crosshair }
  | { type: "event"; event: WorksheetEvent }
  | { type: "events"; worksheet: string; events: WorksheetEvent[] }
  | { type: "results"; id: string; results: RegionEntry[] }
  | { type: "stopping"; id: string }
  | { type: "calc-mode"; mode: CalcMode }
  | { type: "zoom"; zoom: number }
  | { type: "view-mode"; mode: ViewMode }
  | { type: "message"; text: string | null; level?: MessageLevel }
  | { type: "editing"; editing: Editing | null }
  | { type: "text-editing"; editing: TextEditing | null }
  | { type: "editor"; editor: EditorState };

/**
 * An evaluation with nothing left to fill in, numeric (`=`) or symbolic (`→`, also after a
 * definition): a unit override may stay empty, and so may a keyword slot (an empty slot means "no
 * keyword", the plain evaluation; a half-typed keyword is still incomplete).
 */
export function isLiveEvaluation(root: Node): boolean {
  const withoutEmptySlots = (keywords: Node[]) => keywords.filter((group) => !isEmptyKeywordGroup(group));
  let checked = root;
  if (root.type === "Symbolic") {
    checked = { ...root, keywords: withoutEmptySlots(root.keywords) };
  } else if (root.type === "Define" && root.tail?.type === "Sym") {
    checked = { ...root, tail: { ...root.tail, keywords: withoutEmptySlots(root.tail.keywords) } };
  } else if (!(root.type === "Evaluate" || (root.type === "Define" && root.tail?.type === "Eval"))) {
    return false;
  }
  // Optional editing slots (notably both empty integral bounds) disappear on the wire.
  // Missing binder/target names persist as empty names and are still incomplete.
  const incomplete = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(incomplete);
    if (!value || typeof value !== "object") return false;
    const node = value as Record<string, unknown>;
    if (node.type === "Placeholder") return true;
    if (Array.isArray(node.segments) && node.segments.every(segment => !segment.text)) return true;
    return Object.values(node).some(incomplete);
  };
  try {
    return !incomplete(toWire(checked));
  } catch (error) {
    if (error instanceof WireError) return false;
    throw error;
  }
}

/**
 * The statement a commit sends. When the editing tree did not change, reuse the stored statement:
 * a break-only edit must not rebuild, nor re-validate, math that is already committed.
 */
export function commitWire(root: Node, original: string | null, stored: unknown): unknown {
  if (original !== null && stored !== undefined && JSON.stringify(root) === original) return stored;
  return toWire(root);
}

/** A text or image file of the project open in a tab. */
export type FileTab = {
  /** The file's full path, which is also the tab's id. */
  id: string;
  root: string;
  /** Project-relative `/` path. */
  path: string;
  kind: "text" | "image";
  text: string;
  /** The text as last read or saved: the tab is modified while `text` differs. */
  saved: string;
  version: string;
  /** The image as a data URL (image tabs). */
  image?: string;
};

/** Where `path` is after `from` became `to` (`from` itself, or a path inside the folder `from`). */
export function relocated(path: string, moves: readonly (readonly [string, string])[]): string {
  for (const [from, to] of moves) {
    if (path === from) return to;
    if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  }
  return path;
}

/** The project path of `name` in `folder` (`""` is the project root). */
const inFolder = (folder: string, name: string) => (folder === "" ? name : `${folder.replace(/\/+$/, "")}/${name}`);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A path compared as the file system compares it: `/` separators, a Windows drive case-insensitive. */
function pathKey(value: string): string {
  const path = value.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

export function documentName(root: string): string {
  const base = root.split(/[\\/]/).pop() ?? root;
  return base.replace(/\.(sheet\.ya?ml|eqv|ya?ml)$/i, "") || S.untitled;
}

/** Starts below the first page's content; on an empty page the first math line fits above it. */
export function defaultCrosshair(view: DocumentView): Crosshair {
  const first = view.regions.filter((region) => region.page === 1);
  const lowest = first.reduce(
    (y, region) => Math.max(y, region.y + WORKSHEET_LINE_PT + LINE_ABOVE_CROSSHAIR_PT),
    view.page.margins.top + LINE_ABOVE_CROSSHAIR_PT,
  );
  const limit = view.page.height - view.page.margins.bottom;
  return {
    page: 1,
    x: view.page.margins.left,
    y: snapToGrid(Math.min(lowest, limit)),
  };
}

function docFromOpened(opened: OpenedWorksheet, modified = false): DocState {
  return {
    id: opened.id,
    root: opened.root,
    name: documentName(opened.root),
    view: opened.view,
    results: opened.regions,
    diagnostics: opened.diagnostics,
    environment: opened.environment ?? null,
    selection: [],
    running: false,
    progress: null,
    crosshair: defaultCrosshair(opened.view),
    revision: 0,
    // A restored recovery file is modified: it differs from what is on disk.
    edits: modified ? 1 : 0,
    savedEdits: 0,
  };
}

/**
 * The status of the kernel serving `doc`: its environment's kernel; the start-up status for
 * a worksheet of the shared environment whose kernel has not reported yet.
 */
export function kernelOf(state: WorkbenchState, doc: DocState | null): KernelStatus | null {
  const environment = doc?.environment;
  if (!environment) return state.kernel;
  return state.kernels[environment.kernel] ?? (environment.kind === "shared" ? state.kernel : { status: "not_started" });
}

export const initialState = (mode: BackendMode): WorkbenchState => ({
  mode,
  docs: [],
  activeId: null,
  kernel: null,
  kernels: {},
  calcMode: "auto",
  zoom: 1,
  viewMode: "page",
  message: null,
  messageLevel: "error",
  ready: false,
  editing: null,
  textEditing: null,
  prompt: null,
});

function updateDoc(
  state: WorkbenchState,
  id: string,
  change: (doc: DocState) => DocState,
): WorkbenchState {
  let changed = false;
  const docs = state.docs.map((doc) => {
    if (doc.id !== id) return doc;
    const next = change(doc);
    changed ||= next !== doc;
    return next;
  });
  // Nothing changed: the same state, so React skips the render.
  return changed ? { ...state, docs } : state;
}

/**
 * Advances a pass counter by one per region or plot result in a batch: the same value as one
 * event at a time, so a calculation pass reports the progress it always did.
 */
function advanceProgress(progress: Progress | null, events: WorksheetEvent[]): Progress | null {
  if (!progress) return progress;
  let done = progress.done;
  for (const event of events) {
    if (event.event === "region_updated" || event.event === "plot_updated") {
      done = Math.min(progress.total, done + 1);
    }
  }
  return done === progress.done ? progress : { ...progress, done };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The selection `ids` without the regions an edit removed. The patch of the edit names them, so
 * the 20 000 ids of the worksheet are not walked into a set on every edit; an array nobody knows the
 * edit of (the browser mock sends whole results) is checked whole, as before.
 */
function surviving(regions: readonly ViewRegion[], ids: string[]): string[] {
  if (ids.length === 0) return ids;
  const patch = regionsPatchOf(regions);
  if (patch && !patch.reordered) {
    if (patch.removed.length === 0) return ids;
    const gone = new Set(patch.removed);
    const kept = ids.filter((id) => !gone.has(id));
    return kept.length === ids.length ? ids : kept;
  }
  const known = new Set(regions.map((region) => region.id));
  return ids.filter((id) => known.has(id));
}

export function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case "ready":
      return { ...state, ready: true };
    case "kernel": {
      const { environment, ...status } = action.status;
      if (environment === undefined) return { ...state, kernel: status };
      return { ...state, kernels: { ...state.kernels, [environment]: status } };
    }
    case "opened":
      return {
        ...state,
        docs: [...state.docs, docFromOpened(action.opened, action.modified)],
        activeId: action.opened.id,
      };
    case "prompt":
      return { ...state, prompt: action.prompt };
    case "saved": {
      const { opened, path, id } = action;
      if (state.editing?.docId === id && opened) state = { ...state, editing: null };
      if (state.textEditing?.docId === id && opened) state = { ...state, textEditing: null };
      return {
        ...state,
        // Save As re-opened the worksheet: the new session takes the place of the old one.
        docs: state.docs.map((doc) =>
          doc.id !== id
            ? doc
            : opened
              ? docFromOpened(opened)
              : { ...doc, root: path, name: documentName(path), savedEdits: doc.edits },
        ),
        activeId: state.activeId === id && opened ? opened.id : state.activeId,
      };
    }
    case "closed": {
      if (state.editing?.docId === action.id) state = { ...state, editing: null };
      if (state.textEditing?.docId === action.id) state = { ...state, textEditing: null };
      const docs = state.docs.filter((doc) => doc.id !== action.id);
      const activeId =
        state.activeId === action.id ? (docs.at(-1)?.id ?? null) : state.activeId;
      return { ...state, docs, activeId };
    }
    case "activate":
      return { ...state, activeId: action.id, editing: null, textEditing: null };
    case "edited":
      return updateDoc(state, action.id, (doc) => {
        const next = action.result.view;
        const wanted = surviving(next.regions, action.select ?? doc.selection);
        // Everything the edit did not change keeps its object, so only the changed regions render
        // again. The arrays carry the ids the edit touched,
        // for the data the page view derives from them.
        const regions = reuseRegions(doc.view.regions, next.regions);
        inheritRegionsPatch(next.regions, regions);
        const results = reuseEntries(doc.results, action.result.regions);
        inheritEntriesPatch(action.result.regions, results);
        const view: DocumentView = {
          ...next,
          page: sameValue(doc.view.page, next.page) ? doc.view.page : next.page,
          settings: sameValue(doc.view.settings, next.settings) ? doc.view.settings : next.settings,
          regions,
        };
        return {
          ...doc,
          view,
          results,
          revision: doc.revision + 1,
          edits: action.clean ? doc.edits : doc.edits + 1,
          selection: sameIds(doc.selection, wanted) ? doc.selection : wanted,
          // The structural problems (a missing include) change with an include edit.
          diagnostics: action.result.diagnostics ?? doc.diagnostics,
          // "Change environment" and its undo move the worksheet to another kernel.
          environment: action.result.environment ?? doc.environment,
        };
      });
    case "select":
      return updateDoc(state, action.id, (doc) =>
        // The same selection keeps its identity: the page view rebuilds its region list when it changes.
        sameIds(doc.selection, action.selection) ? doc : { ...doc, selection: action.selection },
      );
    case "crosshair":
      return updateDoc(state, action.id, (doc) => ({ ...doc, crosshair: action.crosshair }));
    case "results":
      return updateDoc(state, action.id, (doc) => ({ ...doc, results: action.results }));
    case "stopping":
      return updateDoc(state, action.id, (doc) => ({
        ...doc,
        progress: doc.progress ? { ...doc.progress, stopping: true } : doc.progress,
      }));
    case "events": {
      // The results of one frame, in one render and one copy of the results array.
      const { worksheet, events } = action;
      return updateDoc(state, worksheet, (doc) => ({
        ...doc,
        results: applyWorksheetEvents(doc.results, events),
        progress: advanceProgress(doc.progress, events),
      }));
    }
    case "event": {
      const { event } = action;
      return updateDoc(state, event.worksheet, (doc) => {
        switch (event.event) {
          case "pass_started":
            return {
              ...doc,
              running: true,
              progress: { done: 0, total: event.affected, stopping: false },
            };
          case "pass_finished":
          case "pass_failed":
            return { ...doc, running: false, progress: null, revision: doc.revision + 1 };
          default:
            return doc;
        }
      });
    }
    case "calc-mode":
      return { ...state, calcMode: action.mode };
    case "zoom":
      return { ...state, zoom: clampZoom(action.zoom) };
    case "view-mode":
      return { ...state, viewMode: action.mode };
    case "message":
      // A message without a level is an error: every failure path dispatches it as it always did.
      return { ...state, message: action.text, messageLevel: action.level ?? "error" };
    case "editing":
      return { ...state, editing: action.editing };
    case "text-editing":
      return { ...state, textEditing: action.editing };
    case "editor":
      return state.editing ? { ...state, editing: { ...state.editing, editor: action.editor, rejected: null } } : state;
  }
}

/** The stored y of a drawn point of a document: positions the user picks are drawn positions. */
function storedAt(state: { docs: DocState[] }, docId: string, page: number, y: number): number {
  const doc = state.docs.find((d) => d.id === docId);
  return doc ? storedY(doc.view.regions, doc.view.page, page, y) : y;
}

/** What a Replace pass did: regions written, regions left alone, last refusal. */
export type ReplaceOutcome = { replaced: number; skipped: number; error: string | null };

/** Where an image comes from: a file on disk, or the content of a pasted or dropped file. */
export type ImageSource = { path: string } | { file: Blob };

/** Distance below an inserted image where the next one or the crosshair goes, points. */
const GRID_BELOW = 12;

export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const e = error as CommandError;
    return e.kind ? `${e.kind}: ${e.message}` : e.message;
  }
  return String(error);
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as CommandError).kind === "busy";
}

export type Workbench = ReturnType<typeof useWorkbench>;

export function useWorkbench(backend: Backend) {
  const [state, dispatch] = useReducer(reducer, backend.mode, initialState);
  const stateRef = useRef(state);
  /** Drawn rectangles (points) of the active worksheet, reported by the page view (reflow). */
  const layoutRef = useRef<FlowRect[]>([]);
  const pageCountRef = useRef(1);
  stateRef.current = state;
  // Promises waiting for the next commit of the window, resolved after it renders (`rendered`).
  const renderWaiters = useRef<Array<() => void>>([]);
  useEffect(() => {
    for (const resolve of renderWaiters.current.splice(0)) resolve();
  });
  // The line commands of the sheet in flight (`inLineOrder`).
  const lineQueue = useRef<Promise<unknown>>(Promise.resolve());
  const idleWaiters = useRef(new Map<string, Array<(finished: boolean) => void>>());

  const active = useMemo(
    () => state.docs.find((doc) => doc.id === state.activeId) ?? null,
    [state.docs, state.activeId],
  );

  // The text of the last failure: read by a caller right after `edit` returned null, before the
  // state that carries the message has been rendered (`stateRef` still holds the previous one).
  const lastFailure = useRef("");
  const fail = useCallback((text: (message: string) => string, error: unknown) => {
    lastFailure.current = text(describeError(error));
    dispatch({ type: "message", text: lastFailure.current });
  }, []);

  // ---- recent files ----------------------------------------------------

  const [project, setProject] = useState<OpenedProject | null>(null);
  const [projectEntries, setProjectEntries] = useState<TreeEntry[]>([]);
  /** Bumped by every Open Project, so reopening the same project reads its tree again. */
  const [projectLoads, setProjectLoads] = useState(0);
  const projectRef = useRef(project);
  projectRef.current = project;
  const [recentFiles, setRecentFiles] = useState<string[]>(readRecentFiles);
  const recentRef = useRef(recentFiles);
  recentRef.current = recentFiles;

  /** Puts a file first in the Recent menu and stores the list; a path already there moves forward. */
  const rememberRecent = useCallback((path: string) => {
    const next = withRecent(recentRef.current, path);
    // Nothing changed (the same list in the same order): keep the state, skip the render and the write.
    if (next.length === recentRef.current.length && next.every((item, i) => item === recentRef.current[i])) return;
    recentRef.current = next;
    setRecentFiles(next);
    writeRecentFiles(next);
  }, []);

  // The recent projects: roots of the projects that opened successfully.
  const [recentProjects, setRecentProjects] = useState<string[]>(() => readRecentFiles(RECENT_PROJECTS_KEY));
  const recentProjectsRef = useRef(recentProjects);
  recentProjectsRef.current = recentProjects;
  const rememberProject = useCallback((root: string) => {
    const next = withRecent(recentProjectsRef.current, root);
    if (next.length === recentProjectsRef.current.length && next.every((item, i) => item === recentProjectsRef.current[i])) return;
    recentProjectsRef.current = next;
    setRecentProjects(next);
    writeRecentFiles(next, RECENT_PROJECTS_KEY);
  }, []);

  // ---- calculation -----------------------------------------------------------------------

  const recalculate = useCallback(
    async (all = false, id?: string) => {
      const target = id ?? stateRef.current.activeId;
      if (!target) return false;
      try {
        await backend.recalculate(target, all);
        return true;
      } catch (error) {
        if (!isBusy(error)) fail(S.messages.calculationFailed, error);
        return false;
      }
    },
    [backend, fail],
  );

  const stop = useCallback(async () => {
    const target = stateRef.current.activeId;
    if (!target) return;
    dispatch({ type: "stopping", id: target });
    await backend.interrupt(target).catch(() => false);
  }, [backend]);

  /** Whether any region of the document still needs calculation. */
  const needsCalculation = (doc: DocState) =>
    doc.results.some((entry) => entry.state !== "value");

  // ---- edits -----------------------------------------------------------------------------

  const waitIdle = useCallback((id: string) => {
    return new Promise<boolean>((resolve) => {
      const list = idleWaiters.current.get(id) ?? [];
      const onIdle = (finished: boolean) => {
        clearTimeout(timer);
        resolve(finished);
      };
      const timer = setTimeout(() => {
        const remaining = (idleWaiters.current.get(id) ?? []).filter((waiter) => waiter !== onIdle);
        if (remaining.length) idleWaiters.current.set(id, remaining);
        else idleWaiters.current.delete(id);
        resolve(false);
      }, 8000);
      list.push(onIdle);
      idleWaiters.current.set(id, list);
    });
  }, []);

  /**
   * Runs an edit command. While a calculation is running the backend refuses edits
   * (`busy`): the calculation is stopped, the edit is retried once, and the automatic
   * calculation then picks the result up again.
   */
  const edit = useCallback(
    async (
      id: string,
      run: () => Promise<EditResult>,
      select?: (r: EditResult) => string[],
      failure: (message: string) => string = S.messages.commandFailed,
      autoCalculate = true,
    ) => {
      let result: EditResult;
      try {
        try {
          result = await run();
        } catch (error) {
          if (!isBusy(error)) throw error;
          dispatch({ type: "message", text: S.messages.editWhileBusy, level: "warning" });
          const idle = waitIdle(id);
          await backend.interrupt(id).catch(() => false);
          await idle;
          result = await run();
        }
      } catch (error) {
        fail(failure, error);
        return null;
      }
      dispatch({ type: "edited", id, result, select: select?.(result) });
      if (
        autoCalculate && stateRef.current.calcMode === "auto" &&
        (result.calc_needed ?? result.regions.some((r) => r.state !== "value"))
      ) {
        void recalculate(false, id);
      }
      return result;
    },
    [backend, fail, recalculate, waitIdle],
  );

  /** Previews a switch to a selected environment or the shared environment. */
  const previewEnvironmentSwitch = useCallback(
    (id: string, choose: boolean): Promise<EnvironmentSwitchPreview | null> =>
      choose ? backend.chooseEnvironmentSwitch(id) : backend.previewEnvironmentSwitch(id, null),
    [backend],
  );

  /** Commits the exact preview after confirmation, then applies the edit and existing recalc behavior. */
  const commitEnvironmentSwitch = useCallback(async (id: string, token: string) => {
    const result = await backend.commitEnvironmentSwitch(id, token);
    dispatch({ type: "edited", id, result });
    if (stateRef.current.calcMode === "auto" && result.calc_needed) void recalculate(false, id);
  }, [backend, recalculate]);

  const readEnvironmentMetadata = useCallback(
    (id: string, file: EnvironmentMetadataFile) => backend.readEnvironmentMetadata(id, file),
    [backend],
  );

  /** Copies a standalone worksheet's environment metadata and selects the new override. */
  const copyEnvironment = useCallback(async (id: string, destination: string) => {
    const result = await backend.copyEnvironment(id, destination);
    dispatch({ type: "edited", id, result });
    if (stateRef.current.calcMode === "auto" && result.calc_needed) void recalculate(false, id);
  }, [backend, recalculate]);

  const refreshEnvironmentUsers = useCallback(async (info: EnvironmentInfo) => {
    const sharing = stateRef.current.docs.filter((doc) => doc.environment?.kernel === info.kernel);
    for (const doc of sharing) {
      dispatch({ type: "results", id: doc.id, results: await backend.getResults(doc.id) });
      if (stateRef.current.calcMode === "auto") void recalculate(false, doc.id);
    }
  }, [backend, recalculate]);

  const changePackages = useCallback(async (id: string, names: string[], remove: boolean) => {
    const info = await backend.changePackages(id, names, remove);
    await refreshEnvironmentUsers(info);
    return info;
  }, [backend, refreshEnvironmentUsers]);

  const manageEnvironment = useCallback(async (id: string, operation: EnvironmentOperation) => {
    const info = await backend.manageEnvironment(id, operation);
    await refreshEnvironmentUsers(info);
    return info;
  }, [backend, refreshEnvironmentUsers]);

  /** restart the environment's kernel; the worksheets using it recalculate. */
  const restartEnvironmentKernel = useCallback(async (id: string) => {
    const info = await backend.restartEnvironmentKernel(id);
    await refreshEnvironmentUsers(info);
    return info;
  }, [backend, refreshEnvironmentUsers]);

  /**
   * : restart the kernel the REPL runs in (the open project's environment, else the generic
   * one); the worksheets on that kernel take their new results and recalculate, as for .
   */
  const restartRepl = useCallback(async (project: string | null) => {
    try {
      const kernel = await backend.replRestart(project);
      for (const doc of stateRef.current.docs.filter((d) => d.environment?.kernel === kernel)) {
        dispatch({ type: "results", id: doc.id, results: await backend.getResults(doc.id) });
        if (stateRef.current.calcMode === "auto") void recalculate(false, doc.id);
      }
      dispatch({ type: "message", text: S.repl.restartDone, level: "success" });
    } catch (error) {
      const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
      dispatch({ type: "message", text: S.repl.restartFailed(message), level: "error" });
    }
  }, [backend, recalculate]);

  /** undo the last package change, or settle an interrupted one. */
  const revertEnvironmentChange = useCallback(async (id: string, interrupted: boolean, restore: boolean) => {
    const info = await backend.revertEnvironmentChange(id, interrupted, restore);
    if (restore) await refreshEnvironmentUsers(info);
    return info;
  }, [backend, refreshEnvironmentUsers]);

  const setCompatibility = useCallback(async (id: string, packageName: string, compatibility: string) => {
    const info = await backend.setCompatibility(id, packageName, compatibility);
    await refreshEnvironmentUsers(info);
    return info;
  }, [backend, refreshEnvironmentUsers]);

  const addRegion = useCallback(
    async (kind: NewRegionKind, text?: string) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      if (!doc) return;
      const { x } = doc.crosshair;
      let regionX = snapToGrid(x);
      let plotSize: [number, number] | undefined;
      if (kind === "plot" && stateRef.current.viewMode === "page") {
        // `PlotSpec::new_xy()` in core/src/plot.rs defaults to 360 pt. Fit that default plot at
        // the right printable edge before asking the backend to add it (one undoable command). A
        // narrower page gets a smaller initial plot, down to the renderer's 144 pt minimum.
        const defaultPlotWidth = 360;
        const minimumPlotWidth = 144; // PageView's MIN_PLOT_PT.w and core MIN_PLOT_WIDTH.
        const left = doc.view.page.margins.left;
        const right = doc.view.page.width - doc.view.page.margins.right;
        const printableWidth = right - left;
        if (printableWidth < minimumPlotWidth) {
          dispatch({
            type: "message",
            text: S.messages.commandFailed(`the printable page width is too narrow for a new plot (${minimumPlotWidth} pt required)`),
            level: "warning",
          });
          return;
        }
        const plotWidth = Math.min(defaultPlotWidth, printableWidth);
        if (plotWidth < defaultPlotWidth) plotSize = [plotWidth, 220]; // Keep PlotSpec's default height.
        regionX = Math.max(left, Math.min(regionX, right - plotWidth));
      }
      // a region that does not fit above the bottom margin starts on the next page.
      const height = plotSize?.[1] ?? NEW_REGION_HEIGHT_PT[kind] ?? 0;
      const { page, y } = placeOnPage(doc.view.page, doc.crosshair.page, snapToGrid(doc.crosshair.y), height);
      const result = await edit(
        doc.id,
        () => plotSize
          ? backend.addRegion(doc.id, kind, page, regionX, storedY(doc.view.regions, doc.view.page, page, snapToGrid(y)), text, plotSize)
          : backend.addRegion(doc.id, kind, page, regionX, storedY(doc.view.regions, doc.view.page, page, snapToGrid(y)), text),
        (r) => (r.created ? [r.created] : []),
      );
      if (result) {
        // The crosshair moves below the new region, as in the reference application.
        dispatch({
          type: "crosshair",
          id: doc.id,
          crosshair: { page, x, y: y + WORKSHEET_LINE_PT },
        });
      }
      return result;
    },
    [backend, edit],
  );

  const moveRegions = useCallback(
    async (moves: RegionMove[]) => {
      const id = stateRef.current.activeId;
      if (!id || moves.length === 0) return;
      await edit(id, () => backend.moveRegions(id, moves));
    },
    [backend, edit],
  );

  /** Sets (or with null clears) the result-format override of a math region. One undo step. */
  const setResultFormat = useCallback(
    async (id: string, regionId: string, format: Record<string, string> | null) => {
      await edit(id, () => backend.setResultFormat(id, regionId, format));
    },
    [backend, edit],
  );

  /**
   * Sets the math font of the math regions: each region with the
   * display override it should have afterwards. One undo step for the whole command, labelled
   * `Math font` or, for a reset, `Reset math style`.
   */
  const setMathFont = useCallback(
    async (id: string, edits: MathFontEdit[], reset: boolean) => {
      if (edits.length === 0) return;
      await edit(id, () => backend.setMathFont(id, edits, reset));
    },
    [backend, edit],
  );

  /**
   * Sets the worksheet-wide result format: `format.*` keys of the worksheet
   * `settings:`, a key at `null` removed. One undo step, display only.
   */
  const setResultDefaults = useCallback(
    async (id: string, values: Record<string, string | null>) => {
      await edit(id, () => backend.setResultDefaults(id, values));
    },
    [backend, edit],
  );

  /**
   * Sets the worksheet-wide label styles: `label-style.*` keys of the
   * worksheet `settings:`, a key at `null` removed. One undo step, display only.
   */
  const setLabelStyles = useCallback(
    async (id: string, values: Record<string, string | null>) => {
      await edit(id, () => backend.setLabelStyles(id, values));
    },
    [backend, edit],
  );

  /** The worksheet spelling keys; one undo step. */
  const setSpelling = useCallback(
    async (id: string, values: Record<string, string | null>) => {
      await edit(id, () => backend.setSpelling(id, values));
    },
    [backend, edit],
  );

  /** The spelling language of text regions, `null` to follow the worksheet; one undo step each. */
  const setTextLanguage = useCallback(
    async (regionIds: readonly string[], language: string | null) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      for (const regionId of regionIds) await edit(id, () => backend.setTextLanguage(id, regionId, language));
    },
    [backend, edit],
  );

  /** Replaces the paragraphs of one text region; one undo step. */
  const rewriteText = useCallback(
    async (regionId: string, paragraphs: RichText) => {
      const id = stateRef.current.activeId;
      if (!id) return false;
      return edit(id, () => backend.replaceRegions(id, [{ regionId, paragraphs }]));
    },
    [backend, edit],
  );

  /**
   * Replaces the page setup of the active worksheet. One undo step. The crosshair
   * follows the new printable area, so typing right after the change does not start a region in a
   * margin.
   */
  const setPageSetup = useCallback(
    async (id: string, page: PageSetup) => {
      const result = await edit(id, () => backend.setPageSetup(id, page));
      const doc = result ? stateRef.current.docs.find((state) => state.id === id) : undefined;
      if (!doc) return;
      const printable = printableArea(page);
      const crosshair = {
        page: doc.crosshair.page,
        x: Math.max(doc.crosshair.x, printable.left),
        y: Math.min(Math.max(doc.crosshair.y, printable.top), printable.bottom),
      };
      if (crosshair.x !== doc.crosshair.x || crosshair.y !== doc.crosshair.y) {
        dispatch({ type: "crosshair", id, crosshair });
      }
    },
    [backend, edit],
  );

  /**
   * Sets the worksheet calculation settings: `TOL` and `CTOL` of
   * the worksheet `settings:`, a key at `null` removed. One undo step; unlike the result format
   * it recalculates the worksheet, which `edit` starts in Automatic mode.
   */
  const setCalculationSettings = useCallback(
    async (id: string, values: Record<string, string | null>) => {
      await edit(id, () => backend.setCalculationSettings(id, values));
    },
    [backend, edit],
  );

  const setTextBackground = useCallback(
    async (regionId: string, background: string | null) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setTextBackground(id, regionId, background));
    },
    [backend, edit],
  );

  const setRegionWidth = useCallback(
    async (regionId: string, width: number | null) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setRegionWidth(id, regionId, width));
    },
    [backend, edit],
  );

  /**
   * Find and Replace: rewrites every region of `regionIds` that can
   * carry the replacement, one edit per region, in reading order. A region is left alone when it has
   * no occurrence on the part a replacement may write, and a math region whose new text does
   * not parse is refused with that parse error: nothing is guessed at.
   */
  const replaceInRegions = useCallback(
    async (regionIds: readonly string[], query: string, replacement: string): Promise<ReplaceOutcome> => {
      const id = stateRef.current.activeId;
      const doc = stateRef.current.docs.find((d) => d.id === id);
      if (!doc || query === "" || regionIds.length === 0) return { replaced: 0, skipped: 0, error: null };
      // The regions are read once, before the first edit: their ids keep pointing at them.
      const targets = doc.view.regions.filter((region) => regionIds.includes(region.id));
      let skipped = 0;
      let error: string | null = null;
      const rewrites: RegionRewrite[] = [];
      for (const region of targets) {
        const next = replacementOf(region, query, replacement);
        if (!next) {
          skipped += 1;
          continue;
        }
        if (next.kind === "text") {
          rewrites.push({ regionId: region.id, paragraphs: next.paragraphs });
          continue;
        }
        try {
          rewrites.push({ regionId: region.id, statement: await backend.parseMath(next.text) });
        } catch (failure) {
          // a replacement that is not valid math writes nothing.
          error = describeError(failure);
          skipped += 1;
        }
      }
      if (rewrites.length === 0) return { replaced: 0, skipped, error };
      // every region of one Replace or Replace All is one undo step. No `select`: the selection
      // is left as it is; Replace one selects its region itself.
      const done = await edit(doc.id, () => backend.replaceRegions(doc.id, rewrites), undefined, S.messages.replaceFailed);
      if (!done) return { replaced: 0, skipped: skipped + rewrites.length, error };
      const replaced = rewrites.length;
      return { replaced, skipped, error };
    },
    [backend, edit],
  );

  /**
   * Find and Replace in math mode: every subexpression of the matched regions
   * that has the query's tree becomes the replacement. The new math is printed and parsed again, so
   * it is stored like any edited math, and a result that is not valid math is refused. One
   * undo step for the whole pass, like text mode.
   */
  const replaceMathInRegions = useCallback(
    async (regionIds: readonly string[], query: unknown, replacement: unknown): Promise<ReplaceOutcome> => {
      const id = stateRef.current.activeId;
      const doc = stateRef.current.docs.find((d) => d.id === id);
      if (!doc || regionIds.length === 0) return { replaced: 0, skipped: 0, error: null };
      const targets = doc.view.regions.filter((region) => regionIds.includes(region.id));
      // Printed and parsed again: the canonical form gets the parentheses the new tree needs.
      const reparse = async (statement: unknown) => backend.parseMath(await backend.printMath(statement));
      let skipped = 0;
      let error: string | null = null;
      const rewrites: RegionRewrite[] = [];
      for (const region of targets) {
        const next = mathReplacementOf(region, query, replacement);
        if (!next) {
          skipped += 1;
          continue;
        }
        try {
          if (next.kind === "math") {
            rewrites.push({ regionId: region.id, statement: await reparse(next.statement) });
          } else {
            const paragraphs = next.paragraphs.map((paragraph) => ({ ...paragraph, runs: [...paragraph.runs] }));
            for (const [p, r] of next.changed) {
              const run = paragraphs[p].runs[r];
              if (run.kind !== "math") continue;
              const text = await backend.printMath(run.statement);
              paragraphs[p].runs[r] = { ...run, text, statement: await backend.parseMath(text) };
            }
            rewrites.push({ regionId: region.id, paragraphs });
          }
        } catch (failure) {
          error = describeError(failure);
          skipped += 1;
        }
      }
      if (rewrites.length === 0) return { replaced: 0, skipped, error };
      const done = await edit(doc.id, () => backend.replaceRegions(doc.id, rewrites), undefined, S.messages.replaceFailed);
      if (!done) return { replaced: 0, skipped: skipped + rewrites.length, error };
      return { replaced: rewrites.length, skipped, error };
    },
    [backend, edit],
  );

  /** Replaces the path of an include region with the typed text; one undo step. */
  const setIncludePath = useCallback(
    async (regionId: string, path: string) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setIncludePath(id, regionId, path), undefined, S.messages.includePathFailed);
    },
    [backend, edit],
  );

  /** Replaces the specification of a plot region (expressions, axes, size); one undo step. */
  const setPlot = useCallback(
    async (regionId: string, plot: PlotSpec) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setPlot(id, regionId, plot));
    },
    [backend, edit],
  );

  /**
   * Reports the x range an XY plot is showing on screen, the sample interval of its implicit x
   * trace. Screen-only: no undo step, no edit and no "modified"
   * marker; the plot is recalculated in automatic mode like after an edit. A failed report is
   * dropped: navigating a plot must never interrupt the user.
   */
  const setPlotView = useCallback(
    (regionId: string, range: { min: number; max: number } | null) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      void backend
        .setPlotView(id, regionId, range?.min ?? null, range?.max ?? null)
        .then((changed) => {
          if (changed && stateRef.current.calcMode === "auto") void recalculate(false, id);
        })
        .catch(() => undefined);
    },
    [backend, recalculate],
  );


  // Julia block edits run one after another, in the order they were asked for.
  const juliaEditQueue = useRef<Promise<unknown>>(Promise.resolve());
  // A Julia block's code or enabled state: one undo step each;
  // or a Run, which changes nothing in the worksheet.
  const setJulia = useCallback(
    (regionId: string, change: { code?: string; playing?: boolean; run?: true; insertBelow?: true }) => {
      const id = stateRef.current.activeId;
      if (!id) return Promise.resolve();
      const next = juliaEditQueue.current.then(async () => {
        if (change.code !== undefined) {
          const saved = await edit(id, () => backend.setJuliaCode(id, regionId, change.code!), undefined, undefined, !change.run);
          if (!saved) return;
        }
        if (change.run) {
          // Run asks to trust an untrusted worksheet first, and calculates now whatever
          // the calculation mode; it never changes the enabled state.
          const doc = stateRef.current.docs.find((d) => d.id === id);
          const source = doc?.view.regions.find((r) => r.id === regionId);
          if (source?.kind !== "julia" || source.block.playing === false) return;
          if (doc && doc.view.trusted === false) {
            const choice = await ask({
              title: S.confirm.trustTitle,
              message: S.confirm.trustMessage(documentName(doc.view.document)),
              buttons: [
                { id: "trust", label: S.confirm.trust, primary: true },
                { id: "cancel", label: S.confirm.cancel },
              ],
              cancel: "cancel",
            });
            if (choice !== "trust") return;
            const trusted = await edit(id, () => backend.setWorksheetTrusted(id, true), undefined, undefined, false);
            if (!trusted) return;
          }
          const result = await edit(id, () => backend.runRegion(id, regionId), undefined, undefined, false);
          if (!result) return;
          // Start exactly one pass after the explicit Run request and wait for its boundary before
          // editing the worksheet again; an edit during the pass would interrupt the requested run.
          const finished = waitIdle(id);
          if (!(await recalculate(false, id))) return;
          await finished;
          // A pass still running (its end event not seen yet) is waited for; an idle worksheet
          // never blocks the queue of Julia edits.
          while (stateRef.current.docs.find((d) => d.id === id)?.running) {
            await waitIdle(id);
          }
          if (!change.insertBelow || stateRef.current.activeId !== id) return;
          const current = stateRef.current.docs.find((d) => d.id === id);
          if (!current) return;
          const rect = layoutRef.current.find((item) => item.id === regionId);
          const regionNow = current.view.regions.find((r) => r.id === regionId);
          if (!rect || !regionNow || regionNow.kind !== "julia") return;
          const editedLines = change.code === undefined ? 0 : change.code.split("\n").length;
          const codeHeight = editedLines ? 15 + editedLines * 13.5 : rect.h;
          // The new block starts where a line typed below the source would.
          const below = crosshairBeside(current.view.page, { ...rect, h: Math.max(rect.h, codeHeight) }, "down");
          const y = snapToGrid(below.y - LINE_ABOVE_CROSSHAIR_PT);
          await edit(
            id,
            () => backend.addRegion(id, "julia", below.page, below.x, storedY(current.view.regions, current.view.page, below.page, y)),
            (added) => (added.created ? [added.created] : []),
          );
          return;
        }
        if (change.playing === undefined) return;
        const doc = stateRef.current.docs.find((d) => d.id === id);
        // Section 6: playing a block of an untrusted worksheet asks to trust it first; the
        // answer is remembered for the file. A block the file already plays then just plays.
        if (change.playing && doc && doc.view.trusted === false) {
          const choice = await ask({
            title: S.confirm.trustTitle,
            message: S.confirm.trustMessage(documentName(doc.view.document)),
            buttons: [
              { id: "trust", label: S.confirm.trust, primary: true },
              { id: "cancel", label: S.confirm.cancel },
            ],
            cancel: "cancel",
          });
          if (choice !== "trust") return;
          await edit(id, () => backend.setWorksheetTrusted(id, true));
          const region = doc.view.regions.find((r) => r.id === regionId);
          if (region?.kind === "julia" && region.block.playing !== false) return;
        }
        await edit(id, () => backend.setJuliaPlaying(id, regionId, change.playing!));
      });
      juliaEditQueue.current = next.catch(() => undefined);
      return next;
    },
    [backend, edit, recalculate, waitIdle],
  );

  /** The box of a Julia block: one undo step per drag. */
  const setJuliaSize = useCallback(
    async (regionId: string, width: number | null, height: number | null) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setJuliaSize(id, regionId, width, height));
    },
    [backend, edit],
  );

  // Section 6: forget the trust of the active worksheet; its blocks are drawn stopped again.
  const untrust = useCallback(async () => {
    const id = stateRef.current.activeId;
    if (id) await edit(id, () => backend.setWorksheetTrusted(id, false));
  }, [backend, edit]);

  const deleteSelection = useCallback(async () => {
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc || doc.selection.length === 0) return;
    // Deleting an area deletes its members with it.
    const ids = withMembers(doc.view.regions, doc.selection, doc.view.page);
    await edit(doc.id, () => backend.removeRegions(doc.id, ids), () => []);
  }, [backend, edit]);

  /** Sets the title, height and collapsed flag of an area; one undo step. */
  const setArea = useCallback(
    async (regionId: string, change: { title?: string; height?: number; collapsed?: boolean }) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      const area = doc?.view.regions.find((r) => r.id === regionId);
      if (!doc || area?.kind !== "area") return;
      await edit(doc.id, () =>
        backend.setArea(doc.id, regionId, change.title ?? area.title, change.height ?? area.height, change.collapsed ?? area.collapsed),
      );
    },
    [backend, edit],
  );

  /**
   * Disables the regions or enables
   * them again; one undo step for the whole selection.
   */
  const setRegionsEnabled = useCallback(
    async (regionIds: readonly string[], enabled: boolean) => {
      const id = stateRef.current.activeId;
      if (!id || regionIds.length === 0) return;
      await edit(id, () => backend.setRegionsEnabled(id, [...regionIds], enabled));
    },
    [backend, edit],
  );

  /** A click on an area header: collapse or expand it. */
  const toggleArea = useCallback(
    async (regionId: string) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      const area = doc?.view.regions.find((r) => r.id === regionId);
      if (area?.kind === "area") await setArea(regionId, { collapsed: !area.collapsed });
    },
    [setArea],
  );

  // Undo and redo can drop or bring back image resources, so the cached data URLs are forgotten.
  const undo = useCallback(async () => {
    const id = stateRef.current.activeId;
    if (!id) return;
    dropImages(id);
    await edit(id, () => backend.undo(id));
  }, [backend, edit]);

  const redo = useCallback(async () => {
    const id = stateRef.current.activeId;
    if (!id) return;
    dropImages(id);
    await edit(id, () => backend.redo(id));
  }, [backend, edit]);

  /**
   * Adds one image region per source: the first at `at` (default: the crosshair),
   * the next ones below it; the crosshair ends below the last. Each is one undo step. A source
   * that is not an image is reported and skipped.
   */
  const addImages = useCallback(
    async (sources: ImageSource[], at?: { page: number; x: number; y: number }) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      if (!doc || sources.length === 0) return;
      let { page, x, y } = at ?? doc.crosshair;
      x = snapToGrid(x);
      y = snapToGrid(y);
      for (const source of sources) {
        // A new resource id may be one that undo dropped before: forget what is cached.
        dropImages(doc.id);
        let removed = 0;
        let height = 0;
        const result = await edit(
          doc.id,
          async () => {
            const added =
              "path" in source
                ? await backend.addImage(doc.id, source.path, page, x, storedY(doc.view.regions, doc.view.page, page, y))
                : await backend.addImageData(doc.id, await fileToBase64(source.file), page, x, storedY(doc.view.regions, doc.view.page, page, y));
            removed = added.removed_parts;
            const created = added.view.regions.find((r) => r.id === added.created);
            if (created?.kind === "image") {
              height = created.size[1];
              // an image that does not fit above the bottom margin went to the next page.
              if (created.page !== page) ({ page, y } = created);
            }
            return added;
          },
          (r) => (r.created ? [r.created] : []),
          S.messages.imageFailed,
        );
        if (!result) continue;
        if (removed > 0) dispatch({ type: "message", text: S.messages.imageSanitized(removed), level: "warning" });
        y = snapToGrid(y + height + GRID_BELOW);
      }
      if (!at) dispatch({ type: "crosshair", id: doc.id, crosshair: { page, x, y } });
    },
    [backend, edit],
  );

  /** Ribbon and palette: the native dialog, then the image at the crosshair. */
  const addImageWithDialog = useCallback(async () => {
    const id = stateRef.current.activeId;
    if (!id) return;
    let path: string | null;
    try {
      path = await backend.chooseImagePath(id);
    } catch (error) {
      fail(S.messages.imageFailed, error);
      return;
    }
    if (path) await addImages([{ path }]);
  }, [addImages, backend, fail]);

  /** Sets the size in points of an image region; one undo step. */
  const setImageSize = useCallback(
    async (regionId: string, width: number, height: number) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.setImageSize(id, regionId, width, height));
    },
    [backend, edit],
  );

  /** Image tab: back to the size of the picture itself; one undo step unless it is that. */
  const originalImageSize = useCallback(
    async (regionId: string) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      await edit(id, () => backend.originalImageSize(id, regionId), undefined, S.messages.imageOriginalSizeFailed);
    },
    [backend, edit],
  );

  /** Image tab: the native dialog, then the new picture in place of the old one. */
  const replaceImageWithDialog = useCallback(
    async (regionId: string) => {
      const id = stateRef.current.activeId;
      if (!id) return;
      let path: string | null;
      try {
        path = await backend.chooseImagePath(id);
      } catch (error) {
        fail(S.messages.imageReplaceFailed, error);
        return;
      }
      if (!path) return;
      // The resource id of the region may now mean other bytes: forget the cached data URLs.
      dropImages(id);
      let removed = 0;
      const result = await edit(
        id,
        async () => {
          const replaced = await backend.replaceImage(id, regionId, path);
          removed = replaced.removed_parts;
          return replaced;
        },
        undefined,
        S.messages.imageReplaceFailed,
      );
      if (result && removed > 0) dispatch({ type: "message", text: S.messages.imageSanitized(removed), level: "warning" });
    },
    [backend, edit, fail],
  );

  // ---- text editing ----------------------------------------------------------------------

  const textValue = useRef<RichText | null>(null);
  const textBaseline = useRef<RichText | null>(null);

  /** The editor opened: what it read is the baseline for "unchanged". */
  const textReady = useCallback((value: RichText) => {
    textBaseline.current = value;
    textValue.current = value;
  }, []);
  /** The live value (kept out of state: the editor owns it while open). */
  const textChanged = useCallback((value: RichText) => {
    textValue.current = value;
    // A change after a refusal is a new attempt: Escape commits it again.
    const now = stateRef.current.textEditing;
    if (now?.rejected) dispatch({ type: "text-editing", editing: { ...now, rejected: null } });
  }, []);

  /**
   * Commits the text region being edited: one committed edit is one undo step (`set_text` /
   * `add_text_region`); the editor's own history is dropped. An emptied region is deleted (a new
   * one is not created); an unchanged one is left alone.
   */
  const commitText = useCallback(async (after?: Crosshair): Promise<boolean> => {
    const editing = stateRef.current.textEditing;
    if (!editing) return true;
    const value = textValue.current ?? editing.initial;
    const baseline = textBaseline.current ?? editing.initial;
    dispatch({ type: "text-editing", editing: null });
    // Where the crosshair goes is set in the same render that closes the editor (no stray frame).
    if (after) dispatch({ type: "crosshair", id: editing.docId, crosshair: after });
    textValue.current = null;
    textBaseline.current = null;
    const regionId = editing.regionId;
    if (isEmptyText(value)) {
      if (regionId) await edit(editing.docId, () => backend.removeRegions(editing.docId, [regionId]), () => []);
      return true;
    }
    if (regionId && sameText(baseline, value)) return true;
    const result = await edit(
      editing.docId,
      () =>
        regionId
          ? backend.setText(editing.docId, regionId, value)
          : backend.addTextRegion(editing.docId, editing.page, snapToGrid(editing.x), storedAt(stateRef.current, editing.docId, editing.page, snapToGrid(editing.y)), value, editing.full === true),
      (r) => (regionId ? [] : r.created ? [r.created] : []),
      S.editor.textRejected,
    );
    if (!result) {
      // Refused: the editor opens again with the text as typed (it was closed for the commit,
      // so nothing is lost), and the next Escape discards it.
      if (!stateRef.current.textEditing && !stateRef.current.editing) {
        textValue.current = value;
        textBaseline.current = baseline;
        dispatch({
          type: "text-editing",
          editing: { ...editing, initial: value, point: null, atEnd: true, rejected: lastFailure.current || S.messages.commandFailed("") },
        });
      }
      return false;
    }
    if (result && !regionId && !after) {
      // The crosshair moves below the new region, as in the reference application.
      dispatch({
        type: "crosshair",
        id: editing.docId,
        crosshair: { page: editing.page, x: editing.x, y: editing.y + WORKSHEET_LINE_PT },
      });
    }
    return result !== null;
  }, [backend, edit]);

  // ---- math editing ----------------------------------------------------------------------

  /**
   * Commits the region being edited: one committed edit is one undo step in the document
   * (Rust side); the editor's own history is dropped. An emptied region is deleted (a new
   * one is simply not created). Resolves to false when the math was refused: the editor
   * stays open with the reason.
   */
  const commitEditNow = useCallback(async (after?: Crosshair): Promise<boolean> => {
    if (stateRef.current.textEditing) return commitText(after);
    const editing = stateRef.current.editing;
    if (!editing) return true;
    // `after`: where the crosshair goes, set in the same render that closes the editor, so it never
    // shows for a frame at the place a commit alone would give it.
    const close = () => {
      if (stateRef.current.editing?.docId === editing.docId && stateRef.current.editing?.regionId === editing.regionId) {
        dispatch({ type: "editing", editing: null });
      }
      if (after) dispatch({ type: "crosshair", id: editing.docId, crosshair: after });
    };
    const root = editing.editor.root;
    if (isEmptyStatement(root)) {
      close();
      if (editing.regionId) {
        const regionId = editing.regionId;
        await edit(editing.docId, () => backend.removeRegions(editing.docId, [regionId]), () => []);
      }
      return true;
    }
    const breaks = breakWires(root, editing.editor.breaks);
    if (
      editing.regionId &&
      JSON.stringify(root) === editing.original &&
      JSON.stringify(breaks) === JSON.stringify(editing.originalBreaks)
    ) {
      close();
      return true;
    }
    const doc = stateRef.current.docs.find((d) => d.id === editing.docId);
    const region = doc?.view.regions.find((r) => r.id === editing.regionId);
    const stored = region?.kind === "math" ? region.statement : undefined;
    let wire: unknown;
    try {
      wire = commitWire(root, editing.original, stored);
    } catch (error) {
      if (!(error instanceof WireError)) throw error;
      dispatch({ type: "editing", editing: { ...editing, rejected: error.message } });
      dispatch({ type: "message", text: S.editor.rejected(error.message) });
      return false;
    }
    const regionId = editing.regionId;
    const result = await edit(
      editing.docId,
      () =>
        regionId
          ? backend.setMath(editing.docId, regionId, wire, breaks)
          : backend.addMathRegion(editing.docId, editing.page, snapToGrid(editing.x), storedAt(stateRef.current, editing.docId, editing.page, snapToGrid(editing.y)), wire, breaks),
      () => [],
      S.editor.rejected,
    );
    if (!result) {
      // Never empty: an empty reason would read as "not rejected" and Escape would commit again.
      const reason = lastFailure.current || S.messages.commandFailed("");
      if (stateRef.current.editing) dispatch({ type: "editing", editing: { ...stateRef.current.editing, rejected: reason } });
      return false;
    }
    close();
    if (!regionId && !after) {
      // The crosshair moves below the new region, as in the reference application.
      dispatch({
        type: "crosshair",
        id: editing.docId,
        crosshair: { page: editing.page, x: editing.x, y: (editing.insertionY ?? editing.y) + WORKSHEET_LINE_PT },
      });
    }
    return true;
  }, [backend, commitText, edit]);

  /**
   * One commit at a time: a second request (a double Enter, a background click) joins the one in
   * flight instead of committing the same draft twice (found with real key events: the crosshair
   * draft was committed again with the characters typed while the first commit ran).
   */
  const commitInFlight = useRef<Promise<boolean> | null>(null);
  const commitEdit = useCallback((after?: Crosshair): Promise<boolean> => {
    if (commitInFlight.current) return commitInFlight.current;
    const run = commitEditNow(after).finally(() => {
      commitInFlight.current = null;
    });
    commitInFlight.current = run;
    return run;
  }, [commitEditNow]);
  const commitPending = useCallback(() => commitInFlight.current, []);

  /**
   * Live evaluation: an evaluation (`e =`, `x := e =`) that is complete is stored and calculated
   * without leaving the editor, so its result shows while the caret is still in the region (as in
   * the reference application). It reuses the commit path (`setMath` / `addMathRegion`), so each preview is
   * an undo step of its own; the final commit adds none when nothing changed since.
   */
  const lastPreview = useRef<string | null>(null);
  const preview = useCallback(async () => {
    const editing = stateRef.current.editing;
    if (!editing || stateRef.current.textEditing || commitInFlight.current) return;
    const root = editing.editor.root;
    if (!isLiveEvaluation(root)) return;
    const key = JSON.stringify(root);
    if (key === editing.original || key === lastPreview.current) return;
    const breaks = breakWires(root, editing.editor.breaks);
    let wire: unknown;
    try {
      wire = toWire(root);
    } catch {
      return;
    }
    lastPreview.current = key;
    const regionId = editing.regionId;
    const result = await edit(
      editing.docId,
      () =>
        regionId
          ? backend.setMath(editing.docId, regionId, wire, breaks)
          : backend.addMathRegion(editing.docId, editing.page, snapToGrid(editing.x), storedAt(stateRef.current, editing.docId, editing.page, snapToGrid(editing.y)), wire, breaks),
      () => [],
      S.editor.rejected,
    );
    const now = stateRef.current.editing;
    if (!result) {
      // Refused: the editor stays with the math as typed, and the first Escape discards it
      // instead of trying to store it again.
      if (now && now.docId === editing.docId && now.regionId === regionId && JSON.stringify(now.editor.root) === key) {
        dispatch({ type: "editing", editing: { ...now, rejected: lastFailure.current || S.messages.commandFailed("") } });
      }
      return;
    }
    if (!now || now.docId !== editing.docId || now.regionId !== regionId) return;
    dispatch({ type: "editing", editing: { ...now, regionId: regionId ?? result.created, original: key, originalBreaks: breaks, rejected: null } });
    if (!regionId) {
      dispatch({ type: "crosshair", id: editing.docId, crosshair: { page: editing.page, x: editing.x, y: (editing.insertionY ?? editing.y) + WORKSHEET_LINE_PT } });
    }
  }, [backend, edit]);
  const editedRoot = state.editing?.editor.root;
  useEffect(() => {
    if (!editedRoot) return undefined;
    const timer = setTimeout(() => void preview(), 200);
    return () => clearTimeout(timer);
  }, [editedRoot, preview]);

  /** Leaves editing without committing (the region keeps its committed math or text). */
  const cancelEdit = useCallback(() => {
    if (stateRef.current.editing) dispatch({ type: "editing", editing: null });
    if (stateRef.current.textEditing) dispatch({ type: "text-editing", editing: null });
    dispatch({ type: "message", text: null });
  }, []);

  /** Escape in a text region: commits, or discards the change when the text was refused. */
  const leaveText = useCallback(() => {
    if (stateRef.current.textEditing?.rejected) cancelEdit();
    else void commitEdit();
  }, [cancelEdit, commitEdit]);

  /** Starts editing a math region, with the caret where it was clicked. */
  const beginEdit = useCallback(
    async (regionId: string, hit: MathHit | null, pasted = false) => {
      const current = stateRef.current.editing;
      if (current && current.regionId === regionId) {
        if (hit) {
          try {
            dispatch({ type: "editor", editor: placeCaret(current.editor, hit.path, hit.side, hit.caret) });
          } catch {
            /* a stale path */
          }
        }
        return;
      }
      if ((current || stateRef.current.textEditing) && !(await commitEdit())) return;
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      const region = doc?.view.regions.find((r) => r.id === regionId);
      if (!doc || !region || region.kind !== "math") return;
      // Parentheses drawn by precedence become real ones in the editor; the paths of the
      // view (the click, the stored breaks) are mapped onto them.
      const drawn = withKeywordSlot(toEditing(region.statement));
      const base = withDrawnParens(drawn);
      const viewPath = (path: Path) => remapIntegralBoundHit(base, drawnParenPath(drawn, base, path));
      const tree = withTableUnitSlots(withIntegralBoundSlots(base));
      const breaks = region.breaks ?? [];
      const editingBreaks = breaks.map(anchor => ({ ...anchor, path: viewPath(anchor.path) }));
      let editor = initialEditor(tree, editingBreaks);
      if (hit) {
        try {
          editor = placeCaret(editor, viewPath(hit.path), hit.side, hit.caret);
        } catch {
          /* a stale path: keep the caret at the end */
        }
      }
      dispatch({ type: "select", id: doc.id, selection: [] });
      dispatch({
        type: "editing",
        editing: {
          docId: doc.id,
          regionId,
          page: region.page,
          x: region.x,
          y: region.y,
          editor,
          original: JSON.stringify(tree),
          originalBreaks: breaks,
          rejected: null,
          ...(pasted ? { pasted: true as const } : {}),
        },
      });
    },
    [commitEdit],
  );

  /**
   * Opens a region that an edit just created as soon as it is in the state:
   * the edit's result reaches the state with a later render, how much later depends on the backend.
   */
  const beginEditWhenPresent = useCallback(
    async (regionId: string, hit: MathHit | null, pasted = false) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
        if (doc?.view.regions.some((region) => region.id === regionId)) {
          await beginEdit(regionId, hit, pasted);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    [beginEdit],
  );

  /** Starts a new math region at the crosshair. */
  const beginNew = useCallback(async (): Promise<EditorState | null> => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return null;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return null;
    const { page, x, y } = doc.crosshair;
    const editor = initialEditor();
    dispatch({ type: "select", id: doc.id, selection: [] });
    dispatch({
      type: "editing",
      // The crosshair's vertical bar is the text cursor: the first line is drawn across it.
      // Keep this top fixed as taller constructs are entered; positions remain on the 3 pt grid.
      editing: { docId: doc.id, regionId: null, page, x, y: Math.max(0, y - LINE_ABOVE_CROSSHAIR_PT), insertionY: y, editor, original: null, originalBreaks: [], rejected: null },
    });
    return editor;
  }, [commitEdit]);

  const updateEditor = useCallback((editor: EditorState) => dispatch({ type: "editor", editor }), []);

  /** Starts editing a text region; the caret goes to `point` (client coordinates) when given. */
  const beginText = useCallback(
    async (regionId: string, point: { x: number; y: number } | null, atStart = false) => {
      const current = stateRef.current.textEditing;
      if (current && current.regionId === regionId) return;
      if ((current || stateRef.current.editing) && !(await commitEdit())) return;
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      const region = doc?.view.regions.find((r) => r.id === regionId);
      if (!doc || !region || region.kind !== "text") return;
      dispatch({ type: "select", id: doc.id, selection: [] });
      textValue.current = null;
      textBaseline.current = null;
      dispatch({
        type: "text-editing",
        editing: {
          docId: doc.id,
          regionId,
          page: region.page,
          x: region.x,
          y: region.y,
          initial: region.paragraphs,
          point,
          ...(atStart ? { atStart: true } : {}),
        },
      });
    },
    [commitEdit],
  );

  /**
   * Activates the region under the crosshair after an arrow key moved onto it, as the reference application does: a
   * math region is edited with the insertion line at the left edge of the whole expression, a text
   * region with the caret at its start; other regions (plot, include, julia) are selected.
   */
  const enterRegion = useCallback(
    async (regionId: string) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      const region = doc?.view.regions.find((r) => r.id === regionId);
      if (!doc || !region) return;
      if (region.kind === "math") await beginEdit(regionId, { path: [], side: "L", caret: null });
      else if (region.kind === "text") await beginText(regionId, null, true);
      else dispatch({ type: "select", id: doc.id, selection: [regionId] });
    },
    [beginEdit, beginText],
  );

  /**
   * Moves the crosshair with an arrow key on the sheet (nothing edited): `steps` grid steps, inside the
   * printable area, over page breaks. A region it lands on is entered (`enterRegion`).
   */
  const moveCrosshair = useCallback(
    (direction: Direction, steps = 1) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      if (!doc) return;
      const draft = stateRef.current.viewMode === "draft";
      const next = draft
        ? moveDraftCrosshair(doc.view.page, doc.crosshair, direction, steps)
        : stepCrosshair(doc.view.page, doc.crosshair, direction, steps);
      if (!draft && next.page > doc.crosshair.page && next.page > pageCountRef.current) {
        // Room above the crosshair for the first math line, as on a new worksheet.
        const area = printableArea(doc.view.page);
        next.y = Math.min(snapToGrid(area.top + LINE_ABOVE_CROSSHAIR_PT), area.bottom);
      }
      dispatch({ type: "crosshair", id: doc.id, crosshair: next });
      const hit = regionAt(layoutRef.current, next);
      if (hit) void enterRegion(hit);
    },
    [enterRegion],
  );

  /**
   * Runs a line command of the sheet (Enter, Remove Space, Backspace on space) after the ones before
   * it have been applied and drawn. Each one reads the crosshair and
   * the regions from the window: run as fast as a key repeats, a command read the regions from before
   * the last move had arrived while the crosshair had already advanced, and the crosshair passed
   * over the regions it should have pushed down.
   */
  const inLineOrder = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    // The next commit, or a short wait when the command changed nothing to draw.
    const rendered = () =>
      new Promise<void>((resolve) => {
        renderWaiters.current.push(resolve);
        setTimeout(resolve, 100);
      });
    const next = lineQueue.current.then(async () => {
      const result = await run();
      await rendered();
      return result;
    });
    lineQueue.current = next.catch(() => undefined);
    return next;
  }, []);

  /**
   * Enter on empty worksheet space inserts one worksheet line at the crosshair (GitHub ):
   * every region at or below it moves down one line in one undo step, and the crosshair follows onto
   * the new line — past the bottom margin it continues on the next page, which the view then shows.
   * One line, not an empty region: typing afterwards starts a math region there, as anywhere else on
   * the sheet.
   */
  const insertLine = useCallback(() => inLineOrder(async () => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    const { x } = doc.crosshair;
    const setup = doc.view.page;
    const view = stateRef.current.viewMode;
    // Inside the body of an area the line stays there and the band grows with it; anywhere
    // else it goes before the area the crosshair is in, so a member is never pushed out of its band.
    const raw = storedCrosshair(doc);
    const area = areaBodyAt(setup, lineAreasOf(doc), raw, view);
    const insertion: LineInsertion & { area?: { id: string; height: number } } = area
      ? insertWorksheetLineInArea(setup, flowRegionsOf(doc), area, raw, view)
      : insertWorksheetLine(setup, flowRegionsOf(doc), storedInsertionPoint(doc), view);
    dispatch({ type: "crosshair", id: doc.id, crosshair: { page: insertion.crosshair.page, x, y: insertion.crosshair.y } });
    const resize = areaHeightsOf(insertion.area ?? null);
    if (insertion.moves.length === 0 && !resize) return;
    const moves: RegionMove[] = insertion.moves.map((move) => ({
      region_id: move.id,
      page: move.page,
      x: doc.view.regions.find((region) => region.id === move.id)?.x ?? x,
      y: move.y,
    }));
    await edit(doc.id, () => backend.moveRegions(doc.id, moves, resize));
  }), [backend, commitEdit, edit, inLineOrder]);

  /** The band change of a line command inside an area, in the form the backend takes. */
  const areaHeightsOf = (change: { id: string; height: number } | null) =>
    change ? [{ region_id: change.id, height: change.height }] : undefined;

  /** The moves of a flow shift, with the x each region keeps (`layout/lines.ts` gives only page and y). */
  const movesOf = (doc: DocState, places: readonly { id: string; page: number; y: number }[]): RegionMove[] =>
    places.map((place) => ({
      region_id: place.id,
      page: place.page,
      x: doc.view.regions.find((region) => region.id === place.id)?.x ?? 0,
      y: place.y,
    }));

  /**
   * Add Page Break: the page the crosshair is on ends at the
   * caret line and everything at or below it continues on the next page, its distances kept. The break
   * and the moves are one undo step, and the crosshair stays where it is. A page ends once, so a page
   * that already has a break is refused with a message.
   */
  const addPageBreak = useCallback(async () => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    const at = storedInsertionPoint(doc);
    const existing = doc.view.page_breaks ?? [];
    if (existing.some((entry) => entry.page === at.page)) {
      dispatch({ type: "message", text: S.ribbon.pageBreakExists(at.page), level: "info" });
      return;
    }
    const shift = addPageBreakShift(doc.view.page, flowRegionsOf(doc), at, stateRef.current.viewMode);
    const y = snapToGrid(at.y);
    await edit(doc.id, () => backend.addPageBreak(doc.id, at.page, y, movesOf(doc, shift.moves)));
  }, [backend, commitEdit, edit]);

  /**
   * Removes a page break with the reference application's keys: Delete directly above it, Backspace directly below
   * it. The content at or after it moves back up by the space the break had made free — the inverse
   * of Add Page Break, in one undo step. False, and nothing changed, when the crosshair is not next
   * to a break.
   */
  const removePageBreakAtKey = useCallback(async (key: "Delete" | "Backspace"): Promise<boolean> => {
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return false;
    const at = storedInsertionPoint(doc);
    const found = pageBreakAtKey(doc.view.page, doc.view.page_breaks ?? [], at, key, stateRef.current.viewMode);
    if (!found) return false;
    const shift = removePageBreakShift(doc.view.page, flowRegionsOf(doc), found, stateRef.current.viewMode);
    await edit(doc.id, () => backend.removePageBreak(doc.id, found.page, movesOf(doc, shift.moves)));
    return true;
  }, [backend, edit]);

  /**
   * Remove Space removes one line of the blank space below the caret line: the content at or
   * after the crosshair moves up by one line, less when there is less blank space, and nothing at all
   * (with no undo step) when it already touches the line or there is nothing below.
   */
  const removeSpace = useCallback(() => inLineOrder(async () => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    const setup = doc.view.page;
    const view = stateRef.current.viewMode;
    const raw = storedCrosshair(doc);
    const area = areaBodyAt(setup, lineAreasOf(doc), raw, view);
    const shift = area
      ? removeWorksheetLineInArea(setup, flowRegionsOf(doc), area, raw, view)
      : { ...removeWorksheetLine(setup, flowRegionsOf(doc), storedInsertionPoint(doc), view), area: null };
    if (shift.moves.length === 0 && !shift.area) return;
    await edit(doc.id, () => backend.moveRegions(doc.id, movesOf(doc, shift.moves), areaHeightsOf(shift.area)));
  }), [backend, commitEdit, edit, inLineOrder]);

  /**
   * Backspace on empty worksheet space: one line of the blank space above the caret line goes
   * away, as Backspace on an empty line of a text editor. The crosshair and everything at or after it
   * move up together, by less when there is less blank space; nothing moves, and no undo step is
   * made, when a region reaches down to the line or the crosshair is at the top of the sheet. The
   * crosshair moves even when there is no content below, as a text caret would.
   */
  const removeSpaceAbove = useCallback(() => inLineOrder(async () => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    const heights = new Map(layoutRef.current.map((rect) => [rect.id, rect.h]));
    const regions = flowRegionsOf(doc).map((region) => ({ ...region, h: heights.get(region.id) ?? 0 }));
    const setup = doc.view.page;
    const view = stateRef.current.viewMode;
    const raw = storedCrosshair(doc);
    const area = areaBodyAt(setup, lineAreasOf(doc), raw, view);
    const at = area ? raw : storedInsertionPoint(doc);
    const shift = area
      ? removeWorksheetLineAboveInArea(setup, regions, area, raw, view)
      : { ...removeWorksheetLineAbove(setup, regions, at, view), area: null };
    if (shift.at.page === at.page && shift.at.y === at.y) return;
    dispatch({ type: "crosshair", id: doc.id, crosshair: { page: shift.at.page, x: doc.crosshair.x, y: shift.at.y } });
    if (shift.moves.length === 0 && !shift.area) return;
    await edit(doc.id, () => backend.moveRegions(doc.id, movesOf(doc, shift.moves), areaHeightsOf(shift.area)));
  }), [backend, commitEdit, edit, inLineOrder]);

  /**
   * An arrow key had nothing more to do inside the region being edited: the region is committed exactly
   * as a click outside does, and the crosshair appears just outside it on that side.
   */
  const leaveEditing = useCallback(
    async (direction: Direction) => {
      const state = stateRef.current;
      const editing = state.editing ?? state.textEditing;
      if (!editing) return;
      const doc = state.docs.find((d) => d.id === editing.docId);
      if (!doc) return;
      const regionId = editing.regionId ?? DRAFT_REGION;
      const known = layoutRef.current.find((r) => r.id === regionId) ?? layoutRef.current.find((r) => r.id === DRAFT_REGION);
      const rect = known ?? { page: editing.page, x: editing.x, y: editing.y, w: 0, h: 0 };
      const crosshair = crosshairBeside(doc.view.page, rect, direction, state.viewMode);
      if (!(await commitEdit(crosshair))) return;
      // Again for a commit that was already in flight, which does not know `crosshair`.
      dispatch({ type: "crosshair", id: doc.id, crosshair });
    },
    [commitEdit],
  );

  /**
   * : the new math region being typed is one word and a Space was typed: the draft goes and a
   * text box with the word and the space takes its place, the caret at its end.
   */
  const convertDraftToText = useCallback((word: string) => {
    const draft = stateRef.current.editing;
    if (!draft || draft.regionId !== null) return;
    textValue.current = null;
    textBaseline.current = null;
    dispatch({ type: "editing", editing: null });
    dispatch({
      type: "text-editing",
      editing: {
        docId: draft.docId,
        regionId: null,
        page: draft.page,
        x: draft.x,
        y: draft.y,
        initial: [{ runs: [{ kind: "text", text: `${word} ` }] }],
        point: null,
        atEnd: true,
        fromMath: draft.editor,
      },
    });
  }, []);

  /**
   * Ctrl+Z on the text box a Space made, while it still holds exactly the converted text:
   * the text box goes and the math draft comes back. False when the text was changed (or is not such a box).
   */
  const revertTextToMath = useCallback((): boolean => {
    const text = stateRef.current.textEditing;
    if (!text?.fromMath || text.regionId !== null) return false;
    const now = textValue.current ?? text.initial;
    const plain = now.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
    const first = text.initial[0]?.runs[0];
    if (!first || plain !== first.text) return false;
    textValue.current = null;
    textBaseline.current = null;
    dispatch({ type: "text-editing", editing: null });
    dispatch({
      type: "editing",
      editing: { docId: text.docId, regionId: null, page: text.page, x: text.x, y: text.y, editor: text.fromMath, original: null, originalBreaks: [], rejected: null },
    });
    return true;
  }, []);

  /** Starts a new text region at the crosshair (Ctrl+T), or with `full` a full-width block (Ctrl+Shift+T). */
  const beginNewText = useCallback(async (full = false) => {
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return;
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    const { page, y } = doc.crosshair;
    // A full-width block always starts at the left margin; only y comes from the crosshair.
    const x = full ? doc.view.page.margins.left : doc.crosshair.x;
    dispatch({ type: "select", id: doc.id, selection: [] });
    textValue.current = null;
    textBaseline.current = null;
    dispatch({
      type: "text-editing",
      editing: { docId: doc.id, regionId: null, page, x, y, initial: [{ runs: [] }], point: null, ...(full ? { full: true } : {}) },
    });
  }, [commitEdit]);


  const applyFastSymbolic = useCallback(async (operation: FastSymbolicOperation, options: FastSymbolicOptions) => {
    const current = stateRef.current;
    const source = current.editing;
    const doc = current.docs.find(d => d.id === current.activeId);
    if (!source || !doc || source.docId !== doc.id) return;
    const { entries, variable } = fastSymbolicContext(source.editor);
    const entry = entries.find(item => item.id === operation);
    if (!entry?.enabled) return;
    const sourceRect = layoutRef.current.find(r => r.id === (source.regionId ?? DRAFT_REGION));
    const unchanged = () => {
      const now = stateRef.current;
      return now.activeId === source.docId && now.editing?.regionId === source.regionId &&
        now.editing.editor.root === source.editor.root && now.editing.docId === source.docId;
    };
    try {
      const statement = toWire(source.editor.root);
      const output = await backend.fastSymbolic(doc.id, {
        statement, operation, variable: entry.needs === "expression" || entry.needs === "scalar" ? null : variable,
        worksheetVariables: options.worksheetVariables, regionId: source.regionId,
        page: source.page, x: source.x, y: storedAt(current, doc.id, source.page, source.y),
      });
      if (options.inPlace) {
        if (!unchanged()) {
          if (stateRef.current.activeId === doc.id) {
            fail(message => `Fast Symbolic: ${message}`, "the source is no longer being edited or has changed");
          }
          return;
        }
        const previous = source.editor.root;
        const result = toEditing(output as Node);
        const root = previous.type === "Define" || previous.type === "GlobalDefine"
          ? { ...previous, rhs: result.expr }
          : result;
        const restored = initialEditor(withDrawnParens(root));
        dispatch({ type: "editor", editor: applyEditor(stateRef.current.editing!.editor,
          editor => ({ ...restored, past: editor.past, future: editor.future })) });
        return;
      }
      // The request captured the source expression. Committing it or moving the caret while the
      // symbolic engine loads must not cancel a result destined for a separate region.
      const committing = commitInFlight.current;
      if (committing) await committing;
      const latest = stateRef.current;
      const destination = latest.docs.find(d => d.id === doc.id);
      if (!destination || latest.activeId !== doc.id) return;
      const rect = (source.regionId || unchanged()
        ? layoutRef.current.find(r => r.id === (source.regionId ?? DRAFT_REGION))
        : undefined) ?? sourceRect;
      const y = (rect?.y ?? source.y) + (rect?.h ?? WORKSHEET_LINE_PT) + WORKSHEET_LINE_PT;
      const proposed = latest.viewMode === "draft" ? { page: rect?.page ?? source.page, y }
        : placeOnPage(destination.view.page, rect?.page ?? source.page, y, WORKSHEET_LINE_PT);
      const spot = freeSpot(destination.view.page, layoutRef.current, proposed.page, source.x, proposed.y);
      await edit(doc.id, () => backend.addMathRegion(doc.id, spot.page, spot.x,
        storedAt(stateRef.current, doc.id, spot.page, spot.y), output));
    } catch (error) {
      if (stateRef.current.activeId === doc.id) fail(message => `Fast Symbolic: ${message}`, error);
    }
  }, [backend, edit, fail]);

  // ---- clipboard (regions on the sheet) ------------------------------------------------------

  /**
   * Pastes clipboard text at the crosshair, as one undo step: a snippet of regions (what Copy puts
   * there) becomes those regions; one line of math becomes a math region; any other text becomes a
   * text region (paragraphs at blank lines).
   */
  const pasteText = useCallback(
    async (text: string) => {
      const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
      if (!doc) return;
      // Pasted regions never land on top of existing ones: the paste point moves to a free spot.
      const spot = freeSpot(doc.view.page, layoutRef.current, doc.crosshair.page, doc.crosshair.x, doc.crosshair.y);
      const { page, x, y } = { page: spot.page, x: spot.x, y: spot.y };
      const px = snapToGrid(x);
      const py = storedY(doc.view.regions, doc.view.page, page, snapToGrid(y));
      const clean = text.replace(/\r\n?/g, "\n").trim();
      if (!clean) {
        dispatch({ type: "message", text: S.clipboard.empty, level: "info" });
        return;
      }
      // A pasted image may bring a resource under an id undo dropped before: forget what is cached.
      dropImages(doc.id);
      const run = async (): Promise<EditResult> => {
        try {
          return await backend.pasteRegions(doc.id, page, px, py, `${clean}\n`);
        } catch (error) {
          if ((error as CommandError | null)?.kind !== "paste") throw error;
        }
        if (!clean.includes("\n")) {
          let wire: unknown = null;
          try {
            wire = await backend.parseMath(clean);
          } catch {
            /* not math: it is text */
          }
          if (wire) return backend.addMathRegion(doc.id, page, px, py, wire);
        }
        const paragraphs: RichText = clean
          .split(/\n[ \t]*\n/)
          .map((paragraph) => ({ runs: [{ kind: "text" as const, text: paragraph.replace(/\s*\n\s*/g, " ") }] }));
        return backend.addTextRegion(doc.id, page, px, py, paragraphs);
      };
      const before = new Set(doc.view.regions.map((region) => region.id));
      const result = await edit(doc.id, run, (r) => (r.created ? [r.created] : []));
      if (result) {
        const bottom = result.view.regions
          .filter((region) => region.page === page && region.id === result.created)
          .reduce((max, region) => Math.max(max, region.y), y);
        dispatch({ type: "crosshair", id: doc.id, crosshair: { page, x, y: Math.max(y, bottom) + WORKSHEET_LINE_PT } });
        // one pasted math region opens with the caret at the end of its math, so `=` typed
        // next evaluates what was pasted.
        const added = result.view.regions.filter((region) => !before.has(region.id));
        if (added.length === 1 && added[0].kind === "math") await beginEditWhenPresent(added[0].id, null, true);
      }
    },
    [backend, beginEditWhenPresent, edit],
  );

  const notify = useCallback((text: string, level: MessageLevel = "info") => dispatch({ type: "message", text, level }), []);

  // ---- documents -------------------------------------------------------------------------

  const adopt = useCallback(
    (opened: OpenedWorksheet, modified = false) => {
      dispatch({ type: "opened", opened, modified });
      if (stateRef.current.calcMode === "auto") void recalculate(false, opened.id);
    },
    [recalculate],
  );

  // ---- questions ----------------------------------------------------------------------------

  const promptResolver = useRef<((answer: string) => void) | null>(null);

  /** Shows a modal question and resolves with the id of the button chosen (Escape: `cancel`). */
  const ask = useCallback((prompt: Prompt) => {
    return new Promise<string>((resolve) => {
      // A question that is still open is answered with its cancel answer.
      promptResolver.current?.(stateRef.current.prompt?.cancel ?? prompt.cancel);
      promptResolver.current = resolve;
      dispatch({ type: "prompt", prompt });
    });
  }, []);

  // ---- the project explorer -----------------

  /** Applies what an explorer command did: tabs follow moved worksheets, deleted ones close. */
  /**
   * `moves` are the renames and moves the change made (`[from, to]`, project paths): a file tab
   * follows its file to the new path.
   */
  const applyProjectChange = useCallback((change: ProjectChange, moves: readonly (readonly [string, string])[] = []) => {
    for (const { id, opened } of change.replaced) dispatch({ type: "saved", id, path: opened.root, opened });
    for (const id of change.closed) dispatch({ type: "closed", id });
    if (change.opened) adopt(change.opened);
    setProject((current) => current && { ...current, manifest: change.manifest });
    setProjectEntries(change.entries);
    // A file tab whose file was renamed or moved follows it; one whose file went to the trash
    // closes (it had no unsaved edits).
    const present = new Set(change.entries.map((entry) => entry.path));
    const follow = (tab: FileTab): FileTab | null => {
      const path = relocated(tab.path, moves);
      if (!present.has(path)) return null;
      return path === tab.path ? tab : { ...tab, path, id: `${tab.root}/${path}` };
    };
    const renamed = new Map(fileTabsRef.current.map((tab) => [tab.id, follow(tab)?.id ?? null]));
    setFileTabs((tabs) => tabs.flatMap((tab) => follow(tab) ?? []));
    setActiveFile((id) => (id === null ? null : renamed.get(id) ?? null));
  }, [adopt]);

  // ---- text and image tabs of project files ------------------------------

  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const fileTabsRef = useRef(fileTabs);
  fileTabsRef.current = fileTabs;
  const textBackups = useRef(new Map<string, string>());
  const textBackupWrites = useRef(new Map<string, Promise<void>>());
  const textBackupFailures = useRef(new Set<string>());
  const textFilesBusy = useRef(new Set<string>());
  const discardRecoveredTextEntry = useCallback(async (id: string) => {
    await backend.discardProjectTextRecoveryEntry(id);
    // Open dirty buffers still need autosave protection after a browser-level discard.
    textBackups.current.clear();
  }, [backend]);
  const discardTextRecovery = useCallback(async (tab: FileTab) => {
    textFilesBusy.current.add(tab.id);
    try {
      await textBackupWrites.current.get(tab.id)?.catch(() => undefined);
      await backend.discardProjectTextRecovery(tab.root, tab.path);
      textBackups.current.delete(tab.id);
    } finally {
      textFilesBusy.current.delete(tab.id);
    }
  }, [backend]);
  /** The file tab shown instead of the active worksheet, or none. */
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // Bringing a worksheet to the front hides the file tab.
  // A restored project session keeps its file tab in front through the change of active
  // document its own worksheets cause (within a moment); any other change clears the file tab.
  const restoredFront = useRef<{ file: string; until: number } | null>(null);
  useEffect(() => {
    const restored = restoredFront.current;
    restoredFront.current = null;
    setActiveFile(restored && Date.now() <= restored.until ? restored.file : null);
  }, [state.activeId]);

  /** opens a text or image file of the project in its tab, or brings that tab to the front. */
  // one opening per file at a time; a second request (the second click of a double
  // click) joins the one in flight instead of reading and adding the file twice.
  const opening = useRef(new Map<string, Promise<boolean>>());
  const once = useCallback((key: string, run: () => Promise<boolean>): Promise<boolean> => {
    const pending = opening.current.get(key);
    if (pending) return pending;
    const started = run().finally(() => opening.current.delete(key));
    opening.current.set(key, started);
    return started;
  }, []);
  const openProjectFileNow = useCallback(async (path: string, kind: "text" | "image"): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return false;
    const id = `${current.root}/${path}`;
    if (fileTabsRef.current.some((tab) => tab.id === id)) {
      setActiveFile(id);
      return true;
    }
    try {
      const tab: FileTab = kind === "text"
        ? { id, root: current.root, path, kind, ...(await backend.projectReadText(current.root, path)), saved: "" }
        : { id, root: current.root, path, kind, text: "", version: "", saved: "", image: await backend.projectImage(current.root, path) };
      tab.saved = tab.text;
      if (kind === "text") {
        const recovered = await backend.projectTextRecoveryFor(current.root, path).catch(error => {
          fail(S.project.textRecoveryFailed, error);
          return null;
        });
        if (recovered) {
          const choice = await ask({
            title: S.project.recoverTextTitle,
            message: S.project.recoverTextMessage(path),
            buttons: [
              { id: "recover", label: S.confirm.restore, primary: true },
              { id: "discard", label: S.confirm.discardRecovery },
              { id: "cancel", label: S.confirm.cancel },
            ],
            cancel: "cancel",
          });
          if (choice === "cancel") return false;
          if (choice === "recover") {
            Object.assign(tab, recovered);
            textBackups.current.set(id, JSON.stringify([tab.text, tab.saved, tab.version]));
          }
          else await discardTextRecovery(tab);
        }
      }
      setFileTabs((tabs) => [...tabs, tab]);
      setActiveFile(id);
      return true;
    } catch (error) {
      fail(S.project.openFileFailed, error);
      return false;
    }
  }, [ask, backend, discardTextRecovery, fail]);
  const openProjectFile = useCallback((path: string, kind: "text" | "image"): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return Promise.resolve(false);
    return once(`file:${current.root}/${path}`, () => openProjectFileNow(path, kind));
  }, [once, openProjectFileNow]);

  const editFile = useCallback((id: string, text: string) => {
    setFileTabs((tabs) => tabs.map((tab) => (tab.id === id ? { ...tab, text } : tab)));
  }, []);

  /** saves a text tab; a file changed on disk is refused and offers Reload. */
  const saveFile = useCallback(async (id: string): Promise<boolean> => {
    const tab = fileTabsRef.current.find((item) => item.id === id);
    if (!tab || tab.kind !== "text") return true;
    textFilesBusy.current.add(id);
    try {
      await textBackupWrites.current.get(id)?.catch(() => undefined);
      const saved = await backend.projectWriteText(tab.root, tab.path, tab.text, tab.version);
      setFileTabs((tabs) => tabs.map((item) => (item.id === id ? { ...item, version: saved.version, saved: tab.text } : item)));
      dispatch({ type: "message", text: saved.restarted ? S.project.savedAndRestarted(tab.path) : null, level: "info" });
      // A queued backup can contain an older edit than the text just saved. Autosave is paused
      // for this file until cleanup finishes, so it cannot recreate that obsolete recovery.
      try {
        await backend.discardProjectTextRecovery(tab.root, tab.path);
        textBackups.current.delete(id);
      } catch (error) {
        fail(S.project.discardTextRecoveryFailed, error);
      }
      return true;
    } catch (error) {
      fail(S.project.saveFileFailed, error);
      return false;
    } finally {
      textFilesBusy.current.delete(id);
    }
  }, [backend, fail]);

  /** Save (defined further down), for Save project. */
  const saveRef = useRef<(asNew?: boolean, targetId?: string) => Promise<string | null>>(async () => null);

  /**
   *  Save project: every modified worksheet of the open project and every modified text tab
   * of it, in tab order; stops at the first failure (its message stays in the bar).
   */
  const saveProject = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const base = `${current.root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    const docs = stateRef.current.docs.filter(
      (doc) => doc.root.replace(/\\/g, "/").startsWith(base) && (
        doc.edits !== doc.savedEdits || stateRef.current.editing?.docId === doc.id || stateRef.current.textEditing?.docId === doc.id
      ),
    );
    let saved = 0;
    for (const doc of docs) {
      if ((await saveRef.current(false, doc.id)) === null) return;
      saved++;
    }
    for (const tab of fileTabsRef.current.filter((item) => item.root === current.root && item.text !== item.saved)) {
      if (!(await saveFile(tab.id))) return;
      saved++;
    }
    if (saved > 0) dispatch({ type: "message", text: S.project.projectSaved(saved), level: "info" });
  }, [saveFile]);

  /** Reads the file again, dropping the tab's edits. */
  const reloadFile = useCallback(async (id: string) => {
    const tab = fileTabsRef.current.find((item) => item.id === id);
    if (!tab) return;
    try {
      const file = await backend.projectReadText(tab.root, tab.path);
      await discardTextRecovery(tab);
      setFileTabs((tabs) => tabs.map((item) => (item.id === id ? { ...item, ...file, saved: file.text } : item)));
      dispatch({ type: "message", text: null });
    } catch (error) {
      fail(S.project.openFileFailed, error);
    }
  }, [backend, discardTextRecovery, fail]);

  /** Closes a file tab; a modified one asks Save, Don't save or Cancel. */
  const closeFile = useCallback(async (id: string): Promise<boolean> => {
    const tab = fileTabsRef.current.find((item) => item.id === id);
    if (!tab) return true;
    if (tab.text !== tab.saved) {
      const choice = await ask({
        title: S.confirm.closeTitle,
        message: S.confirm.closeMessage(tab.path.split("/").pop() ?? tab.path),
        buttons: [
          { id: "save", label: S.confirm.save, primary: true },
          { id: "discard", label: S.confirm.discard },
          { id: "cancel", label: S.confirm.cancel },
        ],
        cancel: "cancel",
      });
      if (choice === "cancel") return false;
      if (choice === "save") {
        if (!(await saveFile(id))) return false;
        // Typing can continue while the disk write runs. Keep any newer buffer open.
        if (fileTabsRef.current.find(item => item.id === id)?.text !== tab.text) return false;
      }
    }
    if (tab.kind === "text" && (tab.text !== tab.saved || textBackups.current.has(id))) {
      try { await discardTextRecovery(tab); }
      catch (error) { fail(S.project.discardTextRecoveryFailed, error); return false; }
    }
    setFileTabs((tabs) => tabs.filter((item) => item.id !== id));
    setActiveFile((current) => (current === id ? null : current));
    return true;
  }, [ask, discardTextRecovery, fail, saveFile]);

  const openFileExternally = useCallback(async (path: string) => {
    const current = projectRef.current;
    if (!current) return;
    try {
      await backend.projectOpenExternal(current.root, path);
    } catch (error) {
      fail(S.project.openFileFailed, error);
    }
  }, [backend, fail]);

  /** The open tabs of `path` (a file, or a folder and everything in it) of the project. */
  const projectDocs = useCallback((path: string) => {
    const current = projectRef.current;
    if (!current) return [];
    const normalize = (value: string) => {
      const slashed = value.replace(/\\/g, "/");
      return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed;
    };
    const target = normalize(`${current.root.replace(/[\\/]+$/, "")}/${path}`);
    return stateRef.current.docs.filter((doc) => {
      const root = normalize(doc.root);
      return root === target || root.startsWith(`${target}/`);
    });
  }, []);
  const hasUnsaved = useCallback(
    (path: string) =>
      projectDocs(path).some((doc) => doc.edits !== doc.savedEdits) ||
      fileTabsRef.current.some((tab) => (tab.path === path || tab.path.startsWith(`${path}/`)) && tab.text !== tab.saved),
    [projectDocs],
  );

  /** errors are thrown to the inline name field, which stays open. */
  const createProjectItem = useCallback(async (folder: string, name: string, kind: NewItemKind) => {
    const current = projectRef.current;
    if (!current) return;
    applyProjectChange(await backend.projectCreate(current.root, folder, name, kind));
  }, [applyProjectChange, backend]);

  /**  rename: refused while an affected worksheet has unsaved changes; errors go to the field. */
  const renameProjectItem = useCallback(async (path: string, name: string) => {
    const current = projectRef.current;
    if (!current) return;
    if (hasUnsaved(path)) throw { message: S.project.saveBeforeChanging };
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    applyProjectChange(await backend.projectRename(current.root, path, name), [[path, inFolder(folder, name)]]);
  }, [applyProjectChange, backend, hasUnsaved]);

  /** Explorer commands whose errors go to the message bar. */
  const projectCommand = useCallback(async (
    run: (root: string) => Promise<ProjectChange | null>,
    moves: readonly (readonly [string, string])[] = [],
  ) => {
    const current = projectRef.current;
    if (!current) return;
    try {
      const change = await run(current.root);
      if (change) applyProjectChange(change, moves);
    } catch (error) {
      fail(S.project.worksheetFailed, error);
    }
  }, [applyProjectChange, fail]);

  /**  move (drag onto a folder). */
  const moveProjectItem = useCallback(async (path: string, folder: string) => {
    if (hasUnsaved(path)) {
      dispatch({ type: "message", text: S.project.saveBeforeChanging, level: "warning" });
      return;
    }
    await projectCommand((root) => backend.projectMove(root, path, folder), [[path, inFolder(folder, baseName(path))]]);
  }, [backend, hasUnsaved, projectCommand]);

  const moveProjectItems = useCallback(async (paths: string[], folder: string) => {
    if (paths.some(hasUnsaved)) {
      dispatch({ type: "message", text: S.project.saveBeforeChanging, level: "warning" });
      return;
    }
    await projectCommand(root => backend.projectMoveMany(root, paths, folder), paths.map((path) => [path, inFolder(folder, baseName(path))] as const));
  }, [backend, hasUnsaved, projectCommand]);

  /** to the trash after a confirmation naming it (and its file count for a folder). */
  const deleteProjectItem = useCallback(async (path: string, folder: boolean, files: number) => {
    if (hasUnsaved(path)) {
      dispatch({ type: "message", text: S.project.saveBeforeChanging, level: "warning" });
      return;
    }
    const choice = await ask({
      title: S.project.deleteTitle,
      message: S.project.deleteMessage(path, folder, files),
      buttons: [
        { id: "delete", label: S.project.moveToTrash, primary: true },
        { id: "cancel", label: S.project.cancel },
      ],
      cancel: "cancel",
    });
    if (choice === "delete") await projectCommand((root) => backend.projectDelete(root, path));
  }, [ask, backend, hasUnsaved, projectCommand]);

  const deleteProjectItems = useCallback(async (items: { path: string; folder: boolean; files: number }[]) => {
    const roots = items.filter((item, index) => items.findIndex(other => other.path === item.path) === index && !items.some(other => other.path !== item.path && item.path.startsWith(`${other.path}/`)));
    if (roots.length === 0) return;
    if (roots.some(item => hasUnsaved(item.path))) {
      dispatch({ type: "message", text: S.project.saveBeforeChanging, level: "warning" });
      return;
    }
    const choice = await ask({
      title: S.project.deleteSelected,
      message: S.project.deleteManyMessage(roots.map(item => item.path), roots.reduce((sum, item) => sum + (item.folder ? item.files : 1), 0)),
      buttons: [{ id: "delete", label: S.project.moveToTrash, primary: true }, { id: "cancel", label: S.project.cancel }],
      cancel: "cancel",
    });
    if (choice === "delete") await projectCommand(root => backend.projectDeleteMany(root, roots.map(item => item.path)));
  }, [ask, backend, hasUnsaved, projectCommand]);

  /** the native Open dialog chooses the files. */
  const importProjectFiles = useCallback(
    (folder: string, sources?: string[]) => projectCommand((root) => backend.projectImport(root, folder, sources)),
    [backend, projectCommand],
  );

  const revealProjectItem = useCallback(async (path: string) => {
    const current = projectRef.current;
    if (!current) return;
    try {
      await backend.projectReveal(current.root, path);
    } catch (error) {
      fail(S.project.worksheetFailed, error);
    }
  }, [backend, fail]);


  /**
   * : the Add action of a missing-package error. The confirmation names the environment and
   * who shares it; on success the worksheet recalculates, a failure goes to the message bar.
   */
  const addMissingPackage = useCallback(async (id: string, name: string) => {
    try {
      const info = await backend.environmentInfo(id);
      const choice = await ask({
        title: S.environment.addTitle,
        message: S.environment.confirmChange(info.kind, false, [name], info.directory),
        buttons: [
          { id: "add", label: S.environment.addPackage, primary: true },
          { id: "cancel", label: S.environment.cancel },
        ],
        cancel: "cancel",
      });
      if (choice !== "add") return;
      await changePackages(id, [name], false);
      if (stateRef.current.calcMode !== "auto") void recalculate(false, id);
    } catch (error) {
      fail(S.environment.addFailed, error);
    }
  }, [ask, backend, changePackages, fail, recalculate]);

  const answer = useCallback((id: string) => {
    const resolve = promptResolver.current;
    promptResolver.current = null;
    dispatch({ type: "prompt", prompt: null });
    resolve?.(id);
  }, []);

  /**
   * Opens a worksheet file. A recovery file newer than the file is offered first: Restore
   * opens the recovered content under the file's name as a modified worksheet, Discard deletes the
   * backup and opens the file, Cancel opens nothing. Resolves with whether a worksheet was opened.
   */
  const openFile = useCallback(
    async (path: string): Promise<boolean> => {
      const info = await backend.recoveryFor(path).catch(() => null);
      if (info) {
        const choice = await ask({
          title: S.confirm.recoverTitle,
          message: S.confirm.recoverMessage(documentName(path)),
          buttons: [
            { id: "restore", label: S.confirm.restore, primary: true },
            { id: "discard", label: S.confirm.discardRecovery },
            { id: "cancel", label: S.confirm.cancel },
          ],
          cancel: "cancel",
        });
        if (choice === "cancel") return false;
        if (choice === "restore") {
          const opened = await backend.openRecovery(info.path, path);
          adopt(opened, true);
          rememberRecent(opened.root || path);
          return true;
        }
        await backend.discardRecoveryFile(info.path).catch(() => undefined);
      }
      const opened = await backend.openWorksheet(path);
      adopt(opened);
      rememberRecent(opened.root || path);
      return true;
    },
    [adopt, ask, backend, rememberRecent],
  );

  /** The report of the latest import: the full list behind the notice. */
  const importReport = useRef<ImportReport | null>(null);

  /**
   * Imports an .mcdx or .xmcd file: a new untitled worksheet, shown as modified so that
   * closing asks and autosave guards it. The imported file is never written. The notice counts what
   * was not imported by code.
   */
  const importFile = useCallback(
    async (path: string) => {
      const { opened, report } = await backend.importMcdx(path);
      importReport.current = report;
      adopt(opened, true);
      // The file the user chose is what the Recent menu reopens, not the untitled copy it produced.
      rememberRecent(path);
      const counts = new Map<string, number>();
      for (const issue of report.issues) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
      const byCode = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      dispatch({
        type: "message",
        text: S.messages.imported(documentName(path), report.regions_imported, report.regions_total, byCode),
        level: byCode.length > 0 ? "warning" : "success",
      });
    },
    [adopt, backend, rememberRecent],
  );

  const open = useCallback(
    async (path: string): Promise<boolean> => {
      const isImport = /\.(mcdx|xmcdz?)$/i.test(path);
      try {
        if (isImport) {
          await importFile(path);
          return true;
        }
        return await openFile(path);
      } catch (error) {
        fail(isImport ? S.messages.importFailed : S.messages.openFailed, error);
        return false;
      }
    },
    [fail, importFile, openFile],
  );

  /**
   * Opens a file from the Recent menu. A worksheet already open in a tab is
   * brought to the front instead of opening it twice.
   */
  const openRecent = useCallback(
    async (path: string) => {
      const openDoc = stateRef.current.docs.find((doc) => doc.root === path);
      if (openDoc) {
        dispatch({ type: "activate", id: openDoc.id });
        return;
      }
      await open(path);
    },
    [open],
  );

  /**
   * : a worksheet of the project chosen in the explorer. Already open, it comes to the
   * front, in front of a file tab too; being opened, the request joins the opening in flight.
   */
  const openProjectWorksheet = useCallback((path: string): Promise<boolean> => {
    const existing = stateRef.current.docs.find((doc) => pathKey(doc.root) === pathKey(path));
    if (existing) {
      dispatch({ type: "activate", id: existing.id });
      setActiveFile(null);
      return Promise.resolve(true);
    }
    return once(`sheet:${pathKey(path)}`, async () => {
      const opened = await open(path);
      if (opened) setActiveFile(null);
      return opened;
    });
  }, [once, open]);

  const openProjectItems = useCallback(async (paths: string[]) => {
    const current = projectRef.current;
    if (!current) return;
    for (const path of [...new Set(paths)]) {
      const entry = projectEntries.find(item => item.path === path);
      if (!entry || entry.kind === "folder") continue;
      if (entry.kind === "worksheet") {
        const full = `${current.root.replace(/\\/g, "/").replace(/\/+$/, "")}/${path}`;
        const existing = stateRef.current.docs.find(doc => doc.root.replace(/\\/g, "/") === full);
        if (existing) dispatch({ type: "activate", id: existing.id });
        else if (!(await open(full))) break;
        setActiveFile(null);
      } else if (!(await openProjectFile(path, entry.kind === "image" ? "image" : "text"))) break;
    }
  }, [open, openProjectFile, projectEntries]);

  /** Open (Ctrl+O, ribbon, palette): the native file dialog; every chosen file opens in its own tab. Cancel does nothing. */
  const openWithDialog = useCallback(async () => {
    let paths: string[];
    try {
      paths = await backend.chooseOpenPaths(stateRef.current.activeId ?? undefined);
    } catch (error) {
      fail(S.messages.openFailed, error);
      return;
    }
    for (const path of paths) await open(path);
  }, [backend, fail, open]);

  /** File > Import: the same dialog, starting on the reference application filter; each file opens as an import (a `.eqv` opens normally). */
  const importWithDialog = useCallback(async () => {
    let paths: string[];
    try {
      paths = await backend.chooseOpenPaths(stateRef.current.activeId ?? undefined, true);
    } catch (error) {
      fail(S.messages.importFailed, error);
      return;
    }
    for (const path of paths) await open(path);
  }, [backend, fail, open]);

  /** Start-up: offers the backups of worksheets that never had a file. Resolves with whether any was restored. */
  const recoverUntitled = useCallback(async (): Promise<boolean> => {
    const pending = await backend.pendingRecoveries().catch(() => [] as string[]);
    if (pending.length === 0) return false;
    const choice = await ask({
      title: S.confirm.recoverTitle,
      message: S.confirm.recoverUntitledMessage(pending.length),
      buttons: [
        { id: "restore", label: S.confirm.restoreAll, primary: true },
        { id: "discard", label: S.confirm.discardRecovery },
      ],
      cancel: "discard",
    });
    let restored = false;
    for (const path of pending) {
      if (choice === "restore") {
        try {
          adopt(await backend.openRecovery(path), true);
          restored = true;
          continue;
        } catch (error) {
          fail(S.messages.openFailed, error);
        }
      }
      await backend.discardRecoveryFile(path).catch(() => undefined);
    }
    return restored;
  }, [adopt, ask, backend, fail]);

  // ---- autosave ---------------------------------------------------------------------

  /** The `edits` value of each worksheet at its last recovery write. */
  const backedUp = useRef(new Map<string, number>());

  /**
   * Writes the recovery file of every worksheet that is modified and changed since its last
   * backup. A write that did not happen (a calculation holds the worksheet) is retried at the next
   * tick; failures are ignored, the autosave is a safety net.
   */
  const autosave = useCallback(async () => {
    for (const doc of stateRef.current.docs) {
      if (doc.edits === doc.savedEdits || backedUp.current.get(doc.id) === doc.edits) continue;
      try {
        if ((await backend.writeRecovery(doc.id)) !== null) backedUp.current.set(doc.id, doc.edits);
      } catch {
        /* ignored */
      }
    }
    for (const queued of [...fileTabsRef.current]) {
      // Earlier files may have awaited I/O; another tab can have saved or closed meanwhile.
      const tab = fileTabsRef.current.find(current => current.id === queued.id);
      if (!tab) continue;
      if (tab.kind !== "text" || textFilesBusy.current.has(tab.id) || textBackupWrites.current.has(tab.id)) continue;
      const snapshot = JSON.stringify([tab.text, tab.saved, tab.version]);
      if (tab.text === tab.saved) {
        if (textBackups.current.has(tab.id)) await discardTextRecovery(tab).catch(() => undefined);
        continue;
      }
      if (textBackups.current.get(tab.id) === snapshot) continue;
      const pending = backend.writeProjectTextRecovery(tab.root, tab.path, tab.text, tab.saved, tab.version);
      textBackupWrites.current.set(tab.id, pending);
      try {
        await pending;
        textBackups.current.set(tab.id, snapshot);
        textBackupFailures.current.delete(tab.id);
      } catch (error) {
        // Retry next tick, but show the failure once until a backup succeeds.
        if (!textBackupFailures.current.has(tab.id)) fail(S.project.textAutosaveFailed, error);
        textBackupFailures.current.add(tab.id);
      } finally {
        textBackupWrites.current.delete(tab.id);
      }
    }
  }, [backend, discardTextRecovery, fail]);

  // ---- settings ------------------------------------------------------------------

  const [settings, setSettingsState] = useState<AppSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    let cancelled = false;
    backend
      .getSettings()
      .then((stored) => !cancelled && setSettingsState(sanitizeSettings(stored)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [backend]);

  /** Stores the settings (the dialog's OK). A failure keeps the old ones and says so. */
  const setSettings = useCallback(
    async (next: AppSettings): Promise<boolean> => {
      try {
        setSettingsState(sanitizeSettings(await backend.setSettings(next)));
        return true;
      } catch (error) {
        fail(S.messages.settingsFailed, error);
        return false;
      }
    },
    [backend, fail],
  );

  // the switch and the interval come from the settings (default on, 30 s).
  const autosaveEnabled = settings.autosave.enabled;
  const autosaveMs = settings.autosave.intervalSeconds * 1000;
  useEffect(() => {
    if (!autosaveEnabled) return;
    const timer = setInterval(() => void autosave(), autosaveMs);
    return () => clearInterval(timer);
  }, [autosave, autosaveEnabled, autosaveMs]);

  const loadProject = useCallback(async (mode: "new" | "open", path: string, name: string) => {
    const opened = mode === "new"
      ? await backend.newProject(path, name, crypto.randomUUID(), crypto.randomUUID())
      : await backend.openProject(path);
    // no worksheet opens with a project; the window keeps what it had, and an
    // opened project brings back the tabs of its last session.
    setProject(opened);
    // The session's file tabs open below, before React renders the new project.
    projectRef.current = opened;
    setProjectLoads((count) => count + 1);
    rememberProject(opened.root);
    const session = mode === "open" ? loadProjectSession(opened.root) : null;
    if (!session) return;
    const base = opened.root.replace(/\\/g, "/").replace(/\/+$/, "");
    const existing = new Set(opened.manifest.worksheets.map((sheet) => sheet.path));
    for (const sheet of session.sheets) {
      if (existing.has(sheet)) await openProjectWorksheet(`${base}/${sheet}`);
    }
    for (const file of session.files) await openProjectFile(file.path, file.kind).catch(() => false);
    if (session.active) {
      const doc = stateRef.current.docs.find((d) => relativeTo(opened.root, d.root) === session.active);
      if (doc) {
        dispatch({ type: "activate", id: doc.id });
        setActiveFile(null);
      } else if (session.files.some((file) => file.path === session.active)) {
        const file = `${opened.root}/${session.active}`;
        restoredFront.current = { file, until: Date.now() + 1000 };
        setActiveFile(file);
      }
    }
  }, [backend, openProjectFile, openProjectWorksheet, rememberProject]);

  // the project's tabs are remembered as they change, for the next opening; not
  // while Close project takes them down one by one (the session is the one it closed).
  const sessionFrozen = useRef(false);
  useEffect(() => {
    if (!project || sessionFrozen.current) return;
    const sheets = state.docs.map((doc) => relativeTo(project.root, doc.root)).filter((path): path is string => path !== null);
    const files = fileTabs.filter((tab) => tab.root === project.root).map((tab) => ({ path: tab.path, kind: tab.kind }));
    const front = activeFile
      ? fileTabs.find((tab) => tab.id === activeFile)?.path ?? null
      : (() => {
          const doc = state.docs.find((d) => d.id === state.activeId);
          return doc ? relativeTo(project.root, doc.root) : null;
        })();
    saveProjectSession(project.root, { sheets, files, active: front });
  }, [project, state.docs, state.activeId, fileTabs, activeFile]);

  /**
   * Convert to project: the active worksheet becomes the main worksheet of a new project,
   * which takes its tab. Errors are thrown to the dialog, which stays open.
   */
  const convertToProject = useCallback(async (path: string, name: string) => {
    const id = stateRef.current.activeId;
    if (!id) throw { message: S.project.noWorksheet };
    const opened = await backend.convertToProject(id, path, name, crypto.randomUUID(), crypto.randomUUID());
    if (!opened.worksheet) throw { message: S.project.noWorksheet };
    dispatch({ type: "saved", id, path: opened.worksheet.root, opened: opened.worksheet });
    setProject(opened);
    rememberProject(opened.root);
  }, [backend, rememberProject]);

  /** Opens a project from the Recent menu; a failure goes to the message bar and the entry stays. */
  const openRecentProject = useCallback(async (root: string) => {
    try {
      await loadProject("open", root, "");
    } catch (error) {
      fail(S.project.openFailed, error);
    }
  }, [fail, loadProject]);

  // The project tree: read when a project opens and after each revision of the active
  // worksheet, since inserting an image into a project worksheet may add a file.
  const activeRevision = state.docs.find((doc) => doc.id === state.activeId)?.revision;
  const projectRoot = project?.root ?? null;
  useEffect(() => {
    if (!projectRoot) {
      setProjectEntries([]);
      return;
    }
    let current = true;
    backend.projectTree(projectRoot).then(
      (change) => {
        if (!current) return;
        setProjectEntries((old) => (JSON.stringify(old) === JSON.stringify(change.entries) ? old : change.entries));
        setProject((open) => (open && JSON.stringify(open.manifest) !== JSON.stringify(change.manifest) ? { ...open, manifest: change.manifest } : open));
      },
      () => { if (current) setProjectEntries([]); },
    );
    return () => { current = false; };
  }, [backend, projectRoot, activeRevision, projectLoads]);

  // ---- project references ------------------------------

  const [projectReferences, setProjectReferences] = useState<ProjectReferences | null>(null);
  const projectManifestKey = project ? JSON.stringify(project.manifest) : "";
  const [referencesLoads, setReferencesLoads] = useState(0);
  useEffect(() => {
    if (!projectRoot) {
      setProjectReferences(null);
      return;
    }
    let current = true;
    backend.projectReferences(projectRoot).then(
      (references) => { if (current) setProjectReferences(references); },
      () => { if (current) setProjectReferences(null); },
    );
    return () => { current = false; };
  }, [backend, projectRoot, projectManifestKey, projectLoads, referencesLoads]);

  /** What a reference command did: the manifest, and each open project worksheet's change. */
  const applyReferencesChange = useCallback((change: ReferencesChange) => {
    setProject((open) => open && { ...open, manifest: change.manifest });
    for (const { id, result } of change.worksheets) {
      if (!stateRef.current.docs.some((doc) => doc.id === id)) continue;
      // Reloading references changes no file: the worksheet stays saved.
      dispatch({ type: "edited", id, result, clean: true });
      if (stateRef.current.calcMode === "auto" && result.calc_needed) void recalculate(false, id);
    }
    setReferencesLoads((count) => count + 1);
  }, [recalculate]);

  const referencesCommand = useCallback(async (run: (root: string) => Promise<ReferencesChange | null>) => {
    const current = projectRef.current;
    if (!current) return;
    try {
      const change = await run(current.root);
      if (change) applyReferencesChange(change);
    } catch (error) {
      fail(S.references.failed, error);
    }
  }, [applyReferencesChange, fail]);

  /** Load in worksheets, the checkbox above a project `.jl` file. */
  const setJuliaModule = useCallback(
    (path: string, loaded: boolean) => referencesCommand((root) => backend.projectSetJuliaModule(root, path, loaded)),
    [backend, referencesCommand],
  );

  /** exports a definition region of a project worksheet, or stops exporting it. */
  const setProjectExport = useCallback(
    (path: string, region: string, exported: boolean) =>
      referencesCommand((root) => backend.projectSetExport(root, path, region, exported)),
    [backend, referencesCommand],
  );

  /** the native folder dialog chooses the project to reference. */
  const addProjectReference = useCallback(
    (folder?: string) => referencesCommand((root) => backend.projectAddReference(root, folder)),
    [backend, referencesCommand],
  );

  /** Remove and Trust ask first. */
  const projectReferenceCommand = useCallback(async (command: ReferenceCommand, alias?: string, value?: string) => {
    if (command === "remove" || command === "trust") {
      const name = alias ?? "";
      const choice = await ask({
        title: command === "remove" ? S.references.removeTitle : S.references.trustTitle,
        message: command === "remove" ? S.references.removeMessage(name) : S.references.trustMessage(name),
        buttons: [
          { id: "go", label: command === "remove" ? S.references.remove : S.references.trust, primary: true },
          { id: "cancel", label: S.project.cancel },
        ],
        cancel: "cancel",
      });
      if (choice !== "go") return;
    }
    await referencesCommand((root) => backend.projectReferenceCommand(root, command, alias, value));
  }, [ask, backend, referencesCommand]);

  /** develops a referenced project's Julia package into the project's environment, after asking. */
  const developReferencePackage = useCallback(async (alias: string, name: string) => {
    const current = projectRef.current;
    if (!current) return;
    const base = `${current.root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    const worksheet = stateRef.current.docs.find((doc) => doc.root.replace(/\\/g, "/").startsWith(base));
    if (!worksheet) {
      dispatch({ type: "message", text: S.project.noWorksheet, level: "warning" });
      return;
    }
    try {
      const info = await backend.environmentInfo(worksheet.id);
      const choice = await ask({
        title: S.references.developTitle,
        message: S.references.developMessage(alias, name, info.directory),
        buttons: [
          { id: "go", label: S.references.developPackage(name), primary: true },
          { id: "cancel", label: S.project.cancel },
        ],
        cancel: "cancel",
      });
      if (choice !== "go") return;
      await refreshEnvironmentUsers(await backend.developReferencePackage(worksheet.id, alias));
      setReferencesLoads((count) => count + 1);
    } catch (error) {
      fail(S.references.failed, error);
    }
  }, [ask, backend, fail, refreshEnvironmentUsers]);

  /** Pack Project as .eqvz: only with every project worksheet saved, since it reads the disk. */
  const packProject = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    const inProject = (doc: DocState) => doc.root.replace(/\\/g, "/").startsWith(`${current.root.replace(/\\/g, "/").replace(/\/+$/, "")}/`);
    if (stateRef.current.docs.some((doc) => inProject(doc) && doc.edits !== doc.savedEdits)) {
      dispatch({ type: "message", text: S.project.saveBeforePacking, level: "warning" });
      return;
    }
    try {
      const path = await backend.packProjectArchive(current.root);
      if (path) dispatch({ type: "message", text: S.project.packed(path), level: "info" });
    } catch (error) {
      fail(S.project.packFailed, error);
    }
  }, [backend, fail]);

  /** Extract Project from .eqvz: the extracted project opens as with Open Project. */
  const extractProject = useCallback(async () => {
    try {
      const root = await backend.extractProjectArchive();
      if (root) await loadProject("open", root, "");
    } catch (error) {
      fail(S.project.extractFailed, error);
    }
  }, [backend, fail, loadProject]);

  const create = useCallback(async () => {
    try {
      adopt(await backend.newWorksheet());
    } catch (error) {
      fail(S.messages.openFailed, error);
    }
  }, [adopt, backend, fail]);

  /**
   * Save (Ctrl+S) and Save As (Ctrl+Shift+S). The edit in progress is committed first and a running
   * calculation is waited for (the backend refuses to save while one runs). A worksheet without a
   * file, or `asNew`, goes through Save As (native dialog; the user may cancel).
   */
  const save = useCallback(
    async (asNew = false, targetId?: string): Promise<string | null> => {
      const doc = stateRef.current.docs.find((d) => d.id === (targetId ?? stateRef.current.activeId));
      if (!doc) return null;
      if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return null;
      const target = stateRef.current.docs.find((d) => d.id === doc.id);
      if (target?.running) await waitIdle(doc.id);
      const untitled = !/^([a-zA-Z]:)?[\/]/.test(stateRef.current.docs.find((d) => d.id === doc.id)?.root ?? doc.root);
      const attempt = async () =>
        asNew || untitled
          ? backend.saveWorksheetAs(doc.id, undefined, doc.name)
          : backend.saveWorksheet(doc.id);
      try {
        let saved: SavedWorksheet | null;
        try {
          saved = await attempt();
        } catch (error) {
          if (!isBusy(error)) throw error;
          await waitIdle(doc.id);
          saved = await attempt();
        }
        if (!saved) return null;
        rememberRecent(saved.path);
        dispatch({ type: "saved", id: doc.id, path: saved.path, opened: saved.opened });
        if (saved.opened && stateRef.current.calcMode === "auto") void recalculate(false, saved.opened.id);
        dispatch({ type: "message", text: null });
        return saved.opened?.id ?? doc.id;
      } catch (error) {
        fail(S.messages.saveFailed, error);
        return null;
      }
    },
    [backend, commitEdit, fail, recalculate, rememberRecent, waitIdle],
  );
  saveRef.current = save;

  // ---- printing ---------------------------------------------

  /** The active worksheet after an edit in progress has been committed; null when there is none or the commit failed. */
  const readyToPrint = useCallback(async (): Promise<DocState | null> => {
    if (!stateRef.current.docs.some((d) => d.id === stateRef.current.activeId)) return null;
    if ((stateRef.current.editing || stateRef.current.textEditing) && !(await commitEdit())) return null;
    return stateRef.current.docs.find((d) => d.id === stateRef.current.activeId) ?? null;
  }, [commitEdit]);

  /**
   * Export PDF…: `path` omitted asks with the native Save dialog; a test passes a path and no
   * dialog opens. Resolves with the file written, or null (cancelled or failed; a failure is shown).
   */
  const exportPdf = useCallback(
    async (path?: string): Promise<string | null> => {
      const doc = await readyToPrint();
      if (!doc) return null;
      try {
        const target = path ?? (await backend.choosePdfPath(doc.id, doc.name));
        if (!target) return null;
        const { width, height } = doc.view.page;
        const exported = await withPrintView(null, () => backend.exportPdf(target, width, height));
        dispatch({ type: "message", text: S.messages.pdfSaved(exported.path), level: "success" });
        return exported.path;
      } catch (error) {
        fail(S.messages.exportFailed, error);
        return null;
      }
    },
    [backend, fail, readyToPrint],
  );

  /** Print…: the system print dialog of the web view, with the print view in place. */
  const printDialog = useCallback(async (): Promise<void> => {
    const doc = await readyToPrint();
    if (!doc) return;
    const { width, height } = doc.view.page;
    enterPrint({ widthPt: width, heightPt: height });
    try {
      await printReady();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      window.addEventListener("afterprint", finish);
      try {
        window.print();
        // print() blocks while the dialog is open in Chromium; if no `afterprint` follows, do not stay in the print view.
        setTimeout(finish, 5000);
        await finished;
      } finally {
        window.removeEventListener("afterprint", finish);
      }
    } catch (error) {
      fail(S.messages.printFailed, error);
    } finally {
      leavePrint();
    }
  }, [fail, readyToPrint]);

  const close = useCallback(
    async (id: string) => {
      dispatch({ type: "closed", id });
      await backend.closeWorksheet(id).catch(() => undefined);
    },
    [backend],
  );

  // ---- confirm before close ---------------------------------------------------------

  /**
   * Closes a worksheet; a modified one asks first: Save (an untitled worksheet goes through Save
   * As; a failed or cancelled save keeps the worksheet open), Don't save, or Cancel. Resolves with
   * whether the worksheet was closed.
   */
  const requestClose = useCallback(
    async (id: string): Promise<boolean> => {
      const current = () => stateRef.current.docs.find((d) => d.id === id);
      if (!current()) return true;
      const state = stateRef.current;
      // An edit in progress belongs to the modified state: commit it before judging.
      if ((state.editing?.docId === id || state.textEditing?.docId === id) && !(await commitEdit())) {
        return false;
      }
      const doc = current();
      if (!doc) return true;
      if (doc.edits === doc.savedEdits) {
        await close(id);
        return true;
      }
      dispatch({ type: "activate", id });
      const choice = await ask({
        title: S.confirm.closeTitle,
        message: S.confirm.closeMessage(doc.name),
        buttons: [
          { id: "save", label: S.confirm.save, primary: true },
          { id: "discard", label: S.confirm.discard },
          { id: "cancel", label: S.confirm.cancel },
        ],
        cancel: "cancel",
      });
      if (choice === "discard") {
        await close(id);
        return true;
      }
      if (choice !== "save") return false;
      const saved = await save(false, id);
      if (!saved) return false;
      await close(saved);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ask, close, commitEdit],
  );

  /** Window close and quit: text files first, then worksheets; stops on Cancel or failed save. */
  const requestCloseAll = useCallback(async (): Promise<boolean> => {
    for (const tab of [...fileTabsRef.current]) {
      if (!(await closeFile(tab.id))) return false;
    }
    for (const doc of [...stateRef.current.docs]) {
      if (!(await requestClose(doc.id))) return false;
    }
    return true;
  }, [closeFile, requestClose]);

  /** Closes only the open project's tabs; unrelated standalone worksheets stay open. */
  const closeProject = useCallback(async (): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return true;
    const normalize = (path: string) => {
      const value = path.replace(/\\/g, "/");
      return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
    };
    const root = normalize(current.root).replace(/\/+$/, "");
    sessionFrozen.current = true;
    try {
      for (const tab of [...fileTabsRef.current].filter(tab => normalize(tab.root).replace(/\/+$/, "") === root)) {
        if (!(await closeFile(tab.id))) return false;
      }
      for (const doc of [...stateRef.current.docs].filter(doc => normalize(doc.root).startsWith(`${root}/`))) {
        if (!(await requestClose(doc.id))) return false;
      }
      setProject(null);
      setProjectEntries([]);
      return true;
    } finally {
      sessionFrozen.current = false;
    }
  }, [closeFile, requestClose]);

  /**
   * The project's environment manager. The manager works through a worksheet session of
   * the project's environment: the worksheet in front when it is the project's, else an open one
   * of the project, else the first in the tree, opened.
   */
  const openProjectEnvironment = useCallback(async () => {
    const current = projectRef.current;
    if (!current) throw { message: S.project.noWorksheet };
    if (!(await commitEdit())) throw { message: S.project.finishEdit };
    const inProject = (root: string) => relativeTo(current.root, root) !== null;
    const active = stateRef.current.docs.find((doc) => doc.id === stateRef.current.activeId);
    const existing = active && inProject(active.root) ? active : stateRef.current.docs.find((doc) => inProject(doc.root));
    if (existing) dispatch({ type: "activate", id: existing.id });
    else {
      const first = current.manifest.worksheets[0];
      if (!first) throw { message: S.project.noWorksheet };
      const path = `${current.root.replace(/\\/g, "/").replace(/\/+$/, "")}/${first.path}`;
      if (!(await open(path))) throw { message: S.project.openFailed(first.path) };
    }
    setActiveFile(null);
  }, [commitEdit, open]);

  const select = useCallback((ids: string[], mode: "replace" | "toggle" | "add" = "replace") => {
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (!doc) return;
    let next: string[];
    if (mode === "replace") next = ids;
    else if (mode === "add") next = [...new Set([...doc.selection, ...ids])];
    else {
      const current = new Set(doc.selection);
      for (const id of ids) {
        if (current.has(id)) current.delete(id);
        else current.add(id);
      }
      next = [...current];
    }
    dispatch({ type: "select", id: doc.id, selection: next });
  }, []);

  const selectAll = useCallback(() => {
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (doc) select(doc.view.regions.map((region) => region.id));
  }, [select]);

  const setCrosshair = useCallback((crosshair: Crosshair) => {
    const id = stateRef.current.activeId;
    if (id) dispatch({ type: "crosshair", id, crosshair });
  }, []);

  const toggleCalcMode = useCallback(() => {
    const next: CalcMode = stateRef.current.calcMode === "auto" ? "manual" : "auto";
    dispatch({ type: "calc-mode", mode: next });
    const doc = stateRef.current.docs.find((d) => d.id === stateRef.current.activeId);
    if (next === "auto" && doc && needsCalculation(doc)) void recalculate(false, doc.id);
  }, [recalculate]);

  // ---- start-up and events ---------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const track = (promise: Promise<() => void>) =>
      promise.then((fn) => (cancelled ? fn() : unlisten.push(fn)));
    track(backend.onKernelStatus((status) => dispatch({ type: "kernel", status })));
    // The real Ctrl key, where the system reports it (Windows, where AltGr arrives as Ctrl+Alt).
    if (backend.onRealCtrl) track(backend.onRealCtrl(setRealCtrl));
    // A calculation pass reports one event per region: the results are queued per worksheet and
    // applied together once per frame, so a pass costs one render per frame instead of one per
    // region. Every other event flushes what is queued first, so nothing is reordered.
    const queued = new Map<string, WorksheetEvent[]>();
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancelFlush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
      frame = null;
      timer = null;
    };
    const flush = () => {
      cancelFlush();
      if (queued.size === 0) return;
      for (const [worksheet, events] of queued) dispatch({ type: "events", worksheet, events });
      queued.clear();
    };
    const schedule = () => {
      if (frame !== null || timer !== null) return;
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      } else {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, FRAME_MS);
      }
    };
    track(
      backend.onWorksheetEvent((event) => {
        trackRunningRegion(event);
        if (event.event === "region_updated" || event.event === "plot_updated") {
          const events = queued.get(event.worksheet);
          if (events) events.push(event);
          else queued.set(event.worksheet, [event]);
          schedule();
          return;
        }
        // A region starting or reporting progress changes nothing the window shows (the reducer ignores
        // it), yet a dispatch would still render the whole worksheet once per region: skip it.
        if (event.event === "region_started" || event.event === "region_progress") return;
        // The pass boundaries keep their order: what is queued belongs before them.
        flush();
        dispatch({ type: "event", event });
        if (event.event === "pass_finished" || event.event === "pass_failed") {
          const waiters = idleWaiters.current.get(event.worksheet) ?? [];
          idleWaiters.current.delete(event.worksheet);
          waiters.forEach((resolve) => resolve(true));
        }
        if (event.event === "pass_failed") {
          dispatch({ type: "message", text: S.messages.calculationFailed(event.message) });
        }
      }),
    );
    // Files that a second launch of the application asked this instance to open: they open
    // in new tabs once start-up is over; the queue lives in the backend, so none is lost before.
    let startedUp = false;
    const drainOpenRequests = async () => {
      const paths = await backend.takeOpenRequests().catch(() => [] as string[]);
      for (const path of paths) if (!cancelled) await open(path);
    };
    track(
      backend.onOpenRequest(() => {
        if (startedUp) void drainOpenRequests();
      }),
    );
    backend
      .kernelStatus()
      .then((status) => !cancelled && dispatch({ type: "kernel", status }))
      .catch(() => undefined);
    (async () => {
      try {
        const initial = await backend.initialWorksheet();
        if (cancelled) return;
        let blank: OpenedWorksheet | null = null;
        if (initial) await openFile(initial);
        else adopt((blank = await backend.newWorksheet()));
        if (cancelled) return;
        // Backups of unsaved worksheets of an earlier run; the empty worksheet made for this
        // start is then not needed (it is untouched: the question is modal).
        if ((await recoverUntitled()) && blank) {
          dispatch({ type: "closed", id: blank.id });
          await backend.closeWorksheet(blank.id).catch(() => undefined);
        }
      } catch (error) {
        if (!cancelled) fail(S.messages.openFailed, error);
      } finally {
        if (!cancelled) dispatch({ type: "ready" });
      }
      startedUp = true;
      await drainOpenRequests();
    })();
    return () => {
      cancelled = true;
      // The worksheet state goes away with this hook, so queued results are dropped and no frame
      // or timer is left behind.
      cancelFlush();
      queued.clear();
      unlisten.forEach((fn) => fn());
    };
    // Start-up runs once per backend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  // The actions keep one identity for the life of the window: a new object per render made
  // everything that depends on them (the plot context, clipboard and text bindings) change on every
  // crosshair step and keystroke, and every plot ran Plotly again. Each method calls the latest one.
  const latest = {
    recalculate,
    stop,
    addRegion,
    moveRegions,
    setRegionWidth,
    setTextBackground,
    setSpelling,
    setTextLanguage,
    rewriteText,
    setPageSetup,
    replaceInRegions,
    replaceMathInRegions,
    setPlot,
    setIncludePath,
    setPlotView,
    setJulia,
    setJuliaSize,
    untrust,
    setArea,
    toggleArea,
    setRegionsEnabled,
    addImages,
    addImageWithDialog,
    setImageSize,
    originalImageSize,
    replaceImageWithDialog,
    setResultFormat,
    setMathFont,
    setResultDefaults,
    setLabelStyles,
    setCalculationSettings,
    deleteSelection,
    undo,
    redo,
    open,
    loadProject,
    setProjectExport,
    setJuliaModule,
    addProjectReference,
    projectReferenceCommand,
    developReferencePackage,
    convertToProject,
    createProjectItem,
    renameProjectItem,
    moveProjectItem,
    moveProjectItems,
    deleteProjectItem,
    deleteProjectItems,
    importProjectFiles,
    revealProjectItem,
    openProjectFile,
    openProjectItems,
    editFile,
    saveFile,
    saveProject,
    reloadFile,
    closeFile,
    discardRecoveredTextEntry,
    openFileExternally,
    setActiveFile,
    openRecentProject,
    packProject,
    extractProject,
    previewEnvironmentSwitch,
    commitEnvironmentSwitch,
    readEnvironmentMetadata,
    copyEnvironment,
    changePackages,
    manageEnvironment,
    revertEnvironmentChange,
    restartEnvironmentKernel,
    restartRepl,
    addMissingPackage,
    setCompatibility,
    create,
    close,
    requestClose,
    requestCloseAll,
    closeProject,
    openProjectEnvironment,
    autosave,
    answer,
    select,
    selectAll,
    setCrosshair,
    toggleCalcMode,
    commitEdit,
    commitPending,
    cancelEdit,
    leaveText,
    beginEdit,
    applyFastSymbolic,
    beginEditWhenPresent,
    beginNew,
    beginText,
    beginNewText,
    convertDraftToText,
    revertTextToMath,
    moveCrosshair,
    insertLine,
    /** Add Space is the worksheet line of Enter on the sheet. */
    addSpace: insertLine,
    addPageBreak,
    removePageBreakAtKey,
    removeSpace,
    removeSpaceAbove,
    leaveEditing,
    textReady,
    textChanged,
    pasteText,
    notify,
    updateEditor,
    save: () => save(false),
    /** Saves one worksheet by id. */
    saveWorksheet: (id: string) => save(false, id),
    saveAs: () => save(true),
    exportPdf,
    printDialog,
    setSettings,
    activate: (id: string) => dispatch({ type: "activate", id }),
    setZoom: (zoom: number) => dispatch({ type: "zoom", zoom }),
    setViewMode: (mode: ViewMode) => dispatch({ type: "view-mode", mode }),
    dismissMessage: () => dispatch({ type: "message", text: null }),
    openWithDialog,
    openRecent,
    openProjectWorksheet,
    importWithDialog,
    lastImportReport: () => importReport.current,
  };
  const latestActions = useRef(latest);
  latestActions.current = latest;
  const actions = useMemo(() => stableActions(latestActions), []);

  return {
    settings,
    state,
    project,
    projectEntries,
    projectReferences,
    fileTabs,
    activeFile,
    active,
    dispatch,
    layoutRef,
    pageCountRef,
    recentFiles,
    recentProjects,
    actions,
  };
}

/** Methods with one identity that forward to the current `latest` object's methods of the same name. */
function stableActions<T extends Record<string, (...args: never[]) => unknown>>(latest: { current: T }): T {
  const stable: Record<string, unknown> = {};
  for (const name of Object.keys(latest.current)) {
    stable[name] = (...args: unknown[]) => (latest.current[name] as (...a: unknown[]) => unknown)(...args);
  }
  return stable as T;
}
