import { FastSymbolicMenu } from "./components/FastSymbolicMenu";
import { openManual } from "./manual";
import { fastSymbolicContext, type FastSymbolicOperation, type FastSymbolicOptions } from "./editor/fastSymbolic";
// The application window: chrome plus the worksheet area for the active document.

import { JuliaCompleteContext } from "./page/JuliaView";
import { ResultBlocksContext } from "./results/ResultView";
import { WINDOW_LIMIT } from "./results/largeResult";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageBar, SUCCESS_MESSAGE_MS } from "./components/MessageBar";
import { guardBrowserChords } from "./keymap/browserChords";
import { worksheetColors } from "./workbench/worksheetColors";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { contextDisabled, contextEntries, contextLabel, type ContextTarget } from "./workbench/contextMenu";
import type { Backend } from "./backend";
import {
  DocumentTabs,
  MatrixDialog,
  OptionsDialog,
  ImportReportDialog,
  ShortcutSheetDialog,
  ResultFormatDialog,
  MathFontDialog,
  LabelStylesDialog,
  PageSetupDialog,
  CalculationSettingsDialog,
  PromptDialog,
  StatusBar,
  EngineStartNotice,
  TitleBar,
} from "./components/Chrome";
import { fitPageZoom, fitWidthZoom, GRID_PT, sheetLayout, snapToGrid, stepZoom } from "./layout/geometry";
import { crosshairRepeatSteps, type Direction } from "./layout/crosshair";
import PageView from "./page/PageView";
import { enterPrint, leavePrint, printReady } from "./print/printMode";
import { PlotContext, type PlotEnv } from "./plot/PlotContext";
import { sameCursor, TextEnvContext } from "./text/InlineMath";
import { emptyStatement, exprStmt, get, ident, isEmptyStatement, toEditing, toWire, type Node } from "./editor/tree";
import { mathMatches, mathQueryOf } from "./workbench/mathFind";
import { FindMathBox } from "./components/FindMathBox";
import { S } from "./strings";
import {
  canStepMathSize,
  hasMathFont,
  mathFontOf,
  stepMathSize,
  withMathFont,
  withoutMathFont,
} from "./math/font";
import { calculationSettingEdits, calculationSettingsOf, clearCalculationSettings } from "./calculation/settings";
import { clearLabelStyle, labelStyleEdits, labelStylesOf } from "./math/labels";
import { guardWindowClose, type CloseGuard } from "./windowClose";
import { activityOf, kernelOf, useWorkbench, type DocState, type MathHit } from "./workbench/useWorkbench";
import { runningRegionOf } from "./workbench/runningRegion";
import type { Inspection, RegionEntry, RegionKey, ViewRegion } from "./equavelaApi";
import SidePanel, { PANEL_TABS, type PanelTab } from "./components/SidePanel";
import HoverCard, { type NameHover } from "./components/HoverCard";
import { includedNamesByRegion, useInspection, valueId } from "./inspect/inspection";
import { describeName } from "./inspect/hover";
import { problemsOf } from "./inspect/outline";
import {
  clearFormatSettings,
  formatFromSettings,
  formatSettingEdits,
  matrixSizeSettings,
  RESULT_TABLE_SIZE_KEY,
  SHOW_INDICES_KEY,
  EXPAND_NESTED_KEY,
  expandsNested,
  hasNestedMatrix,
  tableSizeValue,
} from "./results/format";
import { PaletteLayer } from "./components/Palettes";
import { FunctionCatalogue } from "./components/FunctionCatalogue";
import { frontModal, installModalFocus } from "./components/modalFocus";
import { CommandPalette } from "./components/CommandPalette";
import { ProjectDialog } from "./components/ProjectDialog";
import { ProjectTree } from "./components/ProjectTree";
import { ProjectExplorerFrame } from "./components/ProjectExplorerFrame";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog";
import { TerminalPanel, REPL_MAX, REPL_MIN } from "./components/TerminalPanel";
import { ProjectImageUsageDialog } from "./components/ProjectImageUsageDialog";
import { ProjectTextRecoveryDialog } from "./components/ProjectTextRecoveryDialog";
import { projectDropFolder } from "./workbench/projectDrop";
import { replProjectOf } from "./workbench/replTarget";
import { unavailableImageCount } from "./workbench/projectResources";
import { FileTabView, runCodeCommand, SheetFrame, type CodeCommand, type CodeHistory } from "./components/FileTabView";
import { EnvironmentManager } from "./components/EnvironmentManager";
import { Ribbon } from "./components/Ribbon";
import { applyPlotCommand, isPlotCommand, ribbonContext } from "./workbench/commandContext";
import { buildCommandItems, commandApplies, equationInsertionItems, REGION_INSERTIONS, type CommandItem } from "./catalog/commands";
import { usePalettes } from "./workbench/usePalettes";
import { applyPaletteAction } from "./catalog/run";
import type { PaletteAction } from "./catalog/palettes";
import { handleKey } from "./editor/controller";
import {
  insertMatrixSized,
  loneNameText,
  matrixControls,
  placeCaret,
  runCommand,
  type Command,
  type EditorState,
} from "./editor/model";
import { fromDom, resolve, shortcutLabel } from "./keymap/keymap";
import { DRAFT_ID } from "./page/regionEdit";
import {
  acceptCompletion,
  completionCatalog,
  completionPrefix,
  completions,
  nameAtFocus,
  type Completion,
} from "./editor/autocomplete";
import { definedNames, showsResult } from "./math/render";
import {
  readClipboard,
  readClipboardFromGesture,
  writeClipboard,
  writeClipboardNatively,
  writeClipboardWithPicture,
  type Pictures,
  type PictureCopy,
} from "./clipboard";
import { withMembers } from "./layout/areas";
import { ImageContext, imageEnv } from "./page/ImageContext";
import { isImageFile, isImagePath, readClipboardImage } from "./page/imageFiles";
import { copyMath, cutSelection, pasteMath } from "./editor/clipboard";
import { mathOfPaste, mathOfSnippet, rememberMathCopy } from "./mathPaste";
import { selectedValue, valueText, type ResultSelection } from "./results/resultSelection";
import { isRegionsSnippet, regionsSnippet } from "./page/regionsClipboard";
import { imagePicture } from "./page/regionPicture";
import { regionPictures } from "./picture/regionPictures";
import { selectRange } from "./editor/model";
import { ownerRegionId, type InlineActive, type MathClipboard, type MathTarget, type TextEditBinding, type TextFormatKind, type TextFormatState, type TextHandle, type TextHistory } from "./text/value";
import { isNode } from "./math/ast";
import { SpellCache } from "./spell/checker";
import { misspeltAt, misspeltWords, occurrenceOf, paint, type Misspelt } from "./spell/highlight";
import { paintFind, revealRange } from "./page/findHighlight";
import { replaceOccurrence } from "./spell/rewrite";
import { ignoreList, withIgnored } from "./spell/tokenize";
import { SpellingDialog } from "./components/SpellingDialog";
import { usePrinting } from "./print/printMode";

/** The text a region is searched by. */
function searchText(region: ViewRegion): string {
  switch (region.kind) {
    case "math":
    case "text":
      return region.text;
    case "include":
      return region.path;
    case "julia":
      return `${region.block.code ?? ""} ${region.block.using.join(" ")}`;
    case "plot":
      return region.plot.traces.map((trace) => `${trace.x} ${trace.y}`).join(" ");
    case "image":
      return "";
    case "area":
      return region.title;
  }
}

/**
 * Whether every selected region is disabled: the Calculate tab then offers
 * Enable Region and the command enables the selection instead of disabling it.
 */
function allSelectedDisabled(doc: DocState | null): boolean {
  if (!doc || doc.selection.length === 0) return false;
  const disabled = new Set<string>();
  for (const region of doc.view.regions) if (!region.enabled) disabled.add(region.id);
  return doc.selection.every((id) => disabled.has(id));
}

/**
 * The math regions a math-font command acts on: the region being edited when
 * it is a math region, and every math region of the selection, each region once. Regions of other
 * kinds are left alone, and an empty list means there is no target at all.
 */
function mathFontTargets(
  doc: DocState | null,
  editing: { regionId: string | null } | null,
): Extract<ViewRegion, { kind: "math" }>[] {
  if (!doc) return [];
  // A region being written for the first time has no id yet and is not a target.
  const wanted: string[] = editing?.regionId ? [editing.regionId] : [];
  for (const id of doc.selection) if (!wanted.includes(id)) wanted.push(id);
  const targets: Extract<ViewRegion, { kind: "math" }>[] = [];
  for (const id of wanted) {
    const region = doc.view.regions.find((candidate) => candidate.id === id);
    if (region?.kind === "math") targets.push(region);
  }
  return targets;
}

const PANEL_STORAGE_KEY = "equavela.sidePanel";
/** The ribbon's compact mode, per user. */
const RIBBON_STORAGE_KEY = "equavela.ribbon";

function readCompactSetting(): boolean {
  try {
    const stored = JSON.parse(window.localStorage.getItem(RIBBON_STORAGE_KEY) ?? "null") as { compact?: unknown } | null;
    return stored?.compact === true;
  } catch {
    return false;
  }
}

function readPanelSetting(): { open: boolean; tab: PanelTab } {
  try {
    const stored = JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) ?? "null") as { open?: unknown; tab?: unknown } | null;
    if (stored) {
      return {
        open: stored.open === true,
        tab: PANEL_TABS.includes(stored.tab as PanelTab) ? (stored.tab as PanelTab) : "variables",
      };
    }
  } catch {
    /* no storage or not JSON */
  }
  return { open: false, tab: "variables" };
}

const ARROW_DIRECTIONS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/** The plain arrow commands on the sheet (the `Far` variants keep their fixed four-step move). */
const NUDGE_DIRECTIONS: Record<string, Direction> = {
  nudgeLeft: "left",
  nudgeRight: "right",
  nudgeUp: "up",
  nudgeDown: "down",
};


/** The chrome areas whose text fields pass the window commands on. */
const CHROME_FIELDS = ".repl-panel, .statusbar, .side-panel, .ribbon, .titlebar, .math-palette";
/** The window commands that work from those fields: none of them edits text. */
const FIELD_COMMANDS = new Set(["commandPalette", "newDocument", "openDocument", "save", "saveAs", "print", "closeDocument", "calculate", "calculateAll"]);

export default function Workbench({ backend }: { backend: Backend }) {
  const { settings, state, project, projectEntries, projectReferences, fileTabs, activeFile, active: activeWorksheet, actions, layoutRef, pageCountRef, recentFiles, recentProjects } = useWorkbench(backend);
  const activeProjectFile = fileTabs.find((tab) => tab.id === activeFile) ?? null;
  const active = activeProjectFile ? null : activeWorksheet;
  /** The project-relative path of a worksheet of the open project, or null. */
  const projectPathOf = (root: string): string | null => {
    if (!project) return null;
    const base = `${project.root.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
    const file = root.replace(/\\/g, "/");
    return file.startsWith(base) ? file.slice(base.length) : null;
  };

  // The webview's own accelerators (developer tools, reload, view source, the browser's print and find, its zoom,
  // tabs and history) never act: their default is cancelled at the window, before any handler.
  useEffect(() => {
    const guard = (event: KeyboardEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.(".terminal-host")) guardBrowserChords(event);
    };
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, []);

  // A success message goes by itself; a newer message restarts the timer.
  useEffect(() => {
    if (!state.message || state.messageLevel !== "success") return;
    const timer = window.setTimeout(actions.dismissMessage, SUCCESS_MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [state.message, state.messageLevel, actions.dismissMessage]);

  // Test hook of the print regression driver: `exportPdf(path)` writes the PDF without
  // the Save dialog; `enterPrint` / `leavePrint` / `printReady` show the print view for screenshots.
  useEffect(() => {
    (window as unknown as { __equavela?: unknown }).__equavela = {
      exportPdf: (path?: string) => actions.exportPdf(path),
      openPath: (path: string) => actions.open(path),
      // what Open project does with the folder the native picker returns (the driver cannot
      // answer a native dialog).
      openProjectAt: (root: string) => actions.openRecentProject(root),
      lastImportReport: () => actions.lastImportReport(),
      enterPrint,
      leavePrint,
      printReady,
    };
  });
  // Where a client point lands on the page (set by PageView), for dropped files.
  const placeAtRef = useRef<((clientX: number, clientY: number) => { page: number; x: number; y: number }) | null>(null);
  /** A dropped file that is not an image is reported and skipped. */
  const imageOrReport = (file: { name: string; type: string }) => {
    if (isImageFile(file)) return true;
    actions.notify(S.messages.notAnImage(file.name));
    return false;
  };
  // Paste of an image: the browser's paste event carries the clipboard files; the key press
  // path pastes into a hidden textarea, which raises the same event.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) &&
        target.getAttribute("aria-hidden") !== "true";
      if (typing) return;
      // A regions snippet wins over a picture that came with it.
      if (isRegionsSnippet(event.clipboardData?.getData("text/plain"))) return;
      const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile);
      if (files.length === 0) return;
      event.preventDefault();
      void actions.addImages(files.map((file) => ({ file })));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [actions]);
  // Files dropped by the native drag and drop of the desktop app.
  const nativeDropHandler = useRef<((paths: string[], position: { x: number; y: number }) => void) | null>(null);
  nativeDropHandler.current = (paths, position) => {
    const folder = projectDropFolder(document.elementFromPoint?.(position.x, position.y) ?? null);
    if (folder !== null) {
      void (async () => {
        if (await actions.commitEdit()) await actions.importProjectFiles(folder, paths);
      })();
      return;
    }
    if (activeFile) {
      actions.notify(S.project.dropOnWorksheet);
      return;
    }
    const at = placeAtRef.current?.(position.x, position.y);
    const images = paths.filter((path) => isImagePath(path) || (actions.notify(S.messages.notAnImage(path.split(/[\/]/).pop() ?? path)), false));
    if (images.length > 0) void actions.addImages(images.map((path) => ({ path })), at);
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    backend
      .onFileDrop((paths, position) => nativeDropHandler.current?.(paths, position))
      .then((unlisten) => (gone ? unlisten() : (off = unlisten)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, [backend]);
  const [page, setPage] = useState({ current: 1, total: 1 });
  const [pageNavigation, setPageNavigation] = useState<{ docId: string; page: number; fit: boolean } | null>(null);
  // Find and Replace share one match list and one cursor.
  const [find, setFind] = useState({ query: "", replacement: "", index: 0 });
  // Math mode: the typed math of both boxes, and which box takes the keyboard when the
  // boxes are drawn again (`key` remounts them after a switch).
  const [findMath, setFindMath] = useState<{ on: boolean; query: Node; replacement: Node; key: number; focus: "find" | "replace" | null }>(
    () => ({ on: false, query: emptyStatement(), replacement: emptyStatement(), key: 0, focus: null }),
  );
  const findInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);
  const [matrixDialog, setMatrixDialog] = useState(false);
  // The part of a result selected for copying: screen-only window state.
  const [resultSelection, setResultSelection] = useState<ResultSelection | null>(null);
  const [optionsDialog, setOptionsDialog] = useState(false);
  // The page setup dialog and its header/footer section: both commands open this one dialog.
  const [pageSetupDialog, setPageSetupDialog] = useState<false | "page" | "chrome">(false);
  const [importReportDialog, setImportReportDialog] = useState(false);
  const [shortcutSheetDialog, setShortcutSheetDialog] = useState(false);
  // The result-format dialog: one region, or the worksheet default when `regionId` is
  // null.
  const [formatDialog, setFormatDialog] = useState<{ docId: string; regionId: string | null } | null>(null);
  // The math font dialog: the worksheet whose regions it formats.
  const [mathFontDialog, setMathFontDialog] = useState<string | null>(null);
  // The inline equation of the open text region that has the keyboard: the
  // equation commands (Disable Region, Result Format, Math Font) act on it. The dialogs keep the run they
  // were opened for, because opening one takes the keyboard away from the run.
  const [inlineActive, setInlineActive] = useState<InlineActive | null>(null);
  const [inlineDialog, setInlineDialog] = useState<{ kind: "format" | "font"; run: InlineActive } | null>(null);
  const [labelStylesDialog, setLabelStylesDialog] = useState<string | null>(null);
  // Spelling: the dialog, the cache of checked words and the words underlined now.
  const [spellingDialog, setSpellingDialog] = useState(false);
  const spellCache = useMemo(() => new SpellCache((language, words) => backend.spellCheck(language, words)), [backend]);
  const misspelt = useRef<Misspelt[]>([]);
  const printing = usePrinting();
  const spellingOn = settings.spelling.enabled && !printing;
  const worksheetLanguage = active?.view.settings?.["spelling.language"] ?? "en_US";
  const ignoredWords = active?.view.settings?.["spelling.ignore"];
  useEffect(() => {
    if (!spellingOn || !active) {
      misspelt.current = [];
      paint([]);
      return undefined;
    }
    const languages = new Map(active.view.regions.flatMap((r) => (r.kind === "text" && r.language ? [[r.id, r.language] as const] : [])));
    const context = {
      cache: spellCache,
      languageOf: (regionId: string) => languages.get(regionId) ?? worksheetLanguage,
      ignore: ignoreList(ignoredWords),
    };
    const root = document.querySelector(".sheet-host") ?? document.body;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // the page is read again a moment after it changes, never on every keystroke.
    const run = () => {
      timer = null;
      misspelt.current = misspeltWords(root, context);
      paint(misspelt.current);
    };
    const later = () => {
      if (timer === null) timer = setTimeout(run, 150);
    };
    run();
    const observer = new MutationObserver(later);
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    const unsubscribe = spellCache.subscribe(later);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
      unsubscribe();
      paint([]);
    };
  }, [spellingOn, active, spellCache, worksheetLanguage, ignoredWords]);
  // The calculation settings dialog: the worksheet whose tolerances it edits.
  const [calculationSettingsDialog, setCalculationSettingsDialog] = useState<string | null>(null);
  // Screen-only selected traces of the plots of the active document.
  const [plotTraceSelections, setPlotTraceSelections] = useState<Record<string, string>>({});
  const selectPlotTrace = useCallback((regionId: string, traceId: string | null) => {
    setPlotTraceSelections((previous) => {
      const next = { ...previous };
      if (traceId === null) delete next[regionId];
      else next[regionId] = traceId;
      return next;
    });
  }, []);
  useEffect(() => {
    setPlotTraceSelections({});
  }, [active?.id]);
  // A trace selection is forgotten when its plot leaves the selection.
  const selectedRegions = active?.selection;
  useEffect(() => {
    setPlotTraceSelections((previous) => {
      const kept = Object.entries(previous).filter(([id]) => selectedRegions?.includes(id));
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
    });
  }, [selectedRegions]);
  // The arrow key currently held on the sheet and how many repeat events it has produced: the
  // crosshair accelerates with the hold and keeps a quick tap precise (GitHub ).
  const crosshairHold = useRef<{ direction: Direction; repeats: number } | null>(null);
  const replayQueue = useRef<KeyboardEvent[]>([]);
  const replayed = useRef(new WeakSet<Event>());
  // The action a key press started while it is still running: a held key's repeats wait for it.
  const repeatBusy = useRef<Promise<unknown> | null>(null);
  // Repeats of a held Enter on the sheet that came while a line insertion was running: inserted
  // together as soon as it ends, so the sheet keeps pace with the key.
  const pendingLines = useRef(0);
  // Keys still queued for replay when the window goes away are dropped: replaying them later would send
  // them to whatever listens on `window` then (another worksheet view, the next test).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      replayQueue.current = [];
    };
  }, []);
  const palettes = usePalettes();
  const [catalogue, setCatalogue] = useState<{ query: string; help: boolean } | null>(null);
  const [commandPalette, setCommandPalette] = useState(false);
  const [fastMenu, setFastMenu] = useState<{ anchor: DOMRectReadOnly; quick: boolean } | null>(null);
  const [fastOptions, setFastOptions] = useState<FastSymbolicOptions>({ inPlace: false, worksheetVariables: true });
  const [fastBusy, setFastBusy] = useState<{ doc: string; region: string } | null>(null);
  const [insertSearch, setInsertSearch] = useState<{ anchor: DOMRectReadOnly; newDraft: boolean } | null>(null);
  const [projectDialog, setProjectDialog] = useState<"new" | "convert" | null>(null);
  const [environmentManager, setEnvironmentManager] = useState(false);
  const [projectSettings, setProjectSettings] = useState(false);
  const [imageUsage, setImageUsage] = useState(false);
  const [textRecoveries, setTextRecoveries] = useState(false);
  const projectRoot = project?.root;
  const loadImageUsage = useCallback(() => backend.projectImageUsage(projectRoot ?? ""), [backend, projectRoot]);
  const [completionIndex, setCompletionIndex] = useState(0);
  // Tab accepts a suggestion after the arrows chose one, or at once when it is the only one offered
  //; otherwise it moves to the next placeholder (found driving the real app: `i`, Tab in a
  // sum accepted `identity`).
  const completionPicked = useRef(false);
  // An unpinned palette is a drop-down: it owns the keyboard (search box) until it closes.
  const ribbonModal = palettes.palettes.some((p) => !p.pinned) || catalogue !== null || commandPalette || insertSearch !== null || fastMenu !== null || projectDialog !== null || projectSettings || imageUsage || textRecoveries || environmentManager;
  const activeId = active?.id;
  const loadEnvironment = useCallback(() => backend.environmentInfo(activeId ?? ""), [backend, activeId]);
  const editing = activeProjectFile ? null : state.editing;
  const textEditing = activeProjectFile ? null : state.textEditing;
  // The text editor in use: its handle (Text Formatting tab), the format at its selection, and the
  // inline math editor that has the keyboard (target of the ribbon palettes).
  const textHandle = useRef<TextHandle | null>(null);
  const focusWorksheet = useCallback(() => {
    const area = document.querySelector<HTMLElement>(".worksheet-area");
    if (!area) return false;
    const inline = area.querySelector<HTMLElement>(".tx-root .tx-inline.editing");
    if (inline) {
      inline.focus({ preventScroll: true });
    } else if (textHandle.current && area.querySelector('[contenteditable="true"]')) {
      textHandle.current.focus();
    } else {
      area.focus({ preventScroll: true });
    }
    return true;
  }, []);
  // A modal dialog owns the keyboard.
  useEffect(() => installModalFocus(document, focusWorksheet), [focusWorksheet]);
  const mathTarget = useRef<MathTarget | null>(null);
  const [textFormat, setTextFormat] = useState<TextFormatState | null>(null);
  // The open text editor's own history, for quick-access Undo and Redo.
  const [textHistory, setTextHistory] = useState<TextHistory | null>(null);
  // The project text tab's own history, for the same buttons.
  const [codeHistory, setCodeHistory] = useState<CodeHistory | null>(null);
  useEffect(() => {
    if (!textEditing) setTextFormat(null);
  }, [textEditing]);
  // Copy, cut and paste of math (a math region in the editor, or an inline math in a text region).
  const mathClipboard = useMemo<MathClipboard>(() => {
    // Printing and parsing go through Rust, statement by statement and argument list by argument
    // list.
    const io = {
      print: (statement: unknown) => backend.printMath(statement),
      parse: (text: string) => backend.parseMath(text),
      printArgs: (args: unknown[]) => backend.printMathArgs(args),
      parseArgs: (text: string) => backend.parseMathArgs(text),
    };
    return {
      copy: async (editor, cut) => {
        const copied = await copyMath(io, editor);
        if ("error" in copied) {
          actions.notify(copied.error, "error");
          return null;
        }
        if (!(await writeClipboard(copied.text))) {
          actions.notify(S.clipboard.writeFailed, "error");
          return null;
        }
        rememberMathCopy(copied.text);
        return cut ? cutSelection(editor) : editor;
      },
      statement: async (source) => {
        try {
          return toEditing(await backend.parseMath(source));
        } catch {
          return null;
        }
      },
      paste: async (editor, pending) => {
        const text = await pending;
        if (text === null) {
          actions.notify(S.clipboard.denied, "error");
          return null;
        }
        const pasted = await pasteMath(io, editor, text);
        if ("error" in pasted) {
          actions.notify(pasted.error, "error");
          return null;
        }
        return pasted.state;
      },
    };
  }, [actions, backend]);
  // What the plots of the active worksheet need: calculated data, saving and expression conversion.
  const plotEnv = useMemo<PlotEnv | null>(() => {
    if (!active) return null;
    const docId = active.id;
    return {
      revision: active.revision,
      load: (regionId) => backend.plotData(docId, regionId),
      save: (regionId, plot) => void actions.setPlot(regionId, plot),
      view: (regionId, range) => actions.setPlotView(regionId, range),
      toTree: async (text) => {
        if (text.trim() === "") return emptyStatement();
        try {
          // A plot axis admits a top-level range, which only a definition's right side does.
          const parsed = (await backend.parseMath(`plot_axis := ${text}`)) as { rhs: unknown };
          return toEditing({ type: "ExprRegion", expr: parsed.rhs });
        } catch {
          return exprStmt(ident(text));
        }
      },
      toText: async (tree) => (isEmptyStatement(tree) ? "" : backend.printMath(toWire(tree))),
      selectedTrace: (regionId) => plotTraceSelections[regionId] ?? null,
      selectTrace: selectPlotTrace,
      selectRegion: (regionId) => actions.select([regionId]),
    };
  }, [active?.id, active?.revision, actions, backend, plotTraceSelections, selectPlotTrace]); // eslint-disable-line react-hooks/exhaustive-deps
  // The data URLs of the images of the active worksheet (cached per resource).
  const images = useMemo(
    () => (active ? imageEnv(active.id, (resource) => backend.imageData(active.id, resource)) : null),
    [active?.id, backend], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // the completions of a Julia block, from the kernel of its worksheet's environment.
  const completingSheet = active?.id ?? null;
  const juliaComplete = useMemo(
    () => (completingSheet ? (text: string, position: number) => backend.completeCode(completingSheet, text, position) : null),
    [completingSheet, backend],
  );
  // the blocks of a large matrix result, read from the worksheet in view as its box scrolls.
  const resultBlocks = useMemo(
    () =>
      completingSheet
        ? (key: RegionKey, row: number, col: number, rows: number, cols: number) =>
            backend.resultBlock(completingSheet, key, row, col, rows, cols)
        : null,
    [completingSheet, backend],
  );
  const textEnv = useMemo(
    () => ({ mathTarget, clipboard: mathClipboard }),
    [mathClipboard],
  );
  const textBinding = useMemo<Omit<TextEditBinding, "initial" | "point">>(
    () => ({
      mathTarget,
      clipboard: mathClipboard,
      onReady: actions.textReady,
      onChange: actions.textChanged,
      onLeave: () => actions.leaveText(),
      onEdge: (direction) => void actions.leaveEditing(direction),
      onHandle: (handle) => {
        textHandle.current = handle;
        if (!handle) setTextHistory(null);
      },
      onHistory: setTextHistory,
      onFormat: (format) => setTextFormat((previous) => (JSON.stringify(previous) === JSON.stringify(format) ? previous : format)),
      onInline: setInlineActive,
    }),
    [actions, mathClipboard],
  );
  // The editor state the next key applies to: keys can arrive faster than React renders.
  const liveEditor = useRef<EditorState | null>(null);
  useEffect(() => {
    liveEditor.current = editing?.editor ?? null;
  }, [editing]);

  // the search opens at what has the keyboard (`target`): the equation being edited, else the
  // crosshair on empty space. False when neither, so the key goes on to its usual handling.
  const openInsertSearch = useCallback((target: EventTarget | null): boolean => {
    if (!activeId || ribbonModal) return false;
    if (!(target instanceof HTMLElement) || frontModal(document) || actions.commitPending()) return false;
    const area = target.closest(".worksheet-area");
    if (!area) return false;
    const inline = target.closest(".tx-root .tx-inline.editing");
    const edit = inline ?? (target === area && editing?.docId === activeId ? area.querySelector(".region.editing") : null);
    const crosshair = target === area && !editing && !textEditing && active?.selection.length === 0
      ? area.querySelector(".crosshair")
      : null;
    if (!edit && !crosshair) return false;
    if (edit) {
      setInsertSearch({ anchor: (edit.querySelector(".insertion") ?? edit).getBoundingClientRect(), newDraft: false });
    } else if (crosshair) {
      const box = crosshair.getBoundingClientRect();
      const anchor = new DOMRect(box.left + box.width / 2, box.top + box.height / 2);
      void actions.beginNew().then((editor) => {
        if (!editor) return;
        liveEditor.current = editor;
        setInsertSearch({ anchor, newDraft: true });
      });
    }
    return true;
  }, [actions, activeId, active?.selection.length, editing, textEditing, ribbonModal]);
  // Capture also sees inline math keystrokes, which that editor keeps from the window key handler.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || !event.ctrlKey || event.key !== " ") return;
      const action = resolve(fromDom(event), "math");
      if (action?.kind !== "command" || action.cmd !== "insertSearch") return;
      if (!openInsertSearch(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openInsertSearch]);

  const fastAvailable = !!editing && editing.docId === activeId && !fastBusy;
  const closeFastMenu = useCallback((restore: boolean) => {
    setFastMenu(null);
    if (restore) focusWorksheet();
  }, [focusWorksheet]);
  useEffect(() => {
    if (!fastAvailable) setFastMenu(null);
  }, [fastAvailable, editing?.regionId, activeId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!fastAvailable || ribbonModal || frontModal(document) || actions.commitPending() ||
          !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.repeat ||
          event.getModifierState("AltGraph") || event.key.toLowerCase() !== "s") return;
      const area = document.querySelector(".worksheet-area");
      const target = event.target;
      if (!(target instanceof HTMLElement) || !area?.contains(target) ||
          target.closest("input, textarea, select, [contenteditable=true]")) return;
      const region = area.querySelector(".region.editing");
      if (!region) return;
      setFastMenu({ anchor: (region.querySelector(".insertion") ?? region).getBoundingClientRect(), quick: true });
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [actions, fastAvailable, ribbonModal]);
  const runFastSymbolic = (operation: FastSymbolicOperation) => {
    if (!editing || !fastAvailable) return;
    closeFastMenu(true);
    setFastBusy({ doc: editing.docId, region: editing.regionId ?? DRAFT_ID });
    void actions.applyFastSymbolic(operation, fastOptions).finally(() => setFastBusy(null));
  };

  const modified = (doc: DocState) => doc.edits !== doc.savedEdits;

  // Closing the window or quitting asks about every modified worksheet.
  const closeGuard = useRef<CloseGuard>({ confirm: async () => true, hasUnsaved: () => false });
  closeGuard.current = {
    confirm: actions.requestCloseAll,
    hasUnsaved: () => state.docs.some(modified) || fileTabs.some(tab => tab.text !== tab.saved),
  };
  useEffect(() => guardWindowClose(() => closeGuard.current), []);

  const mathQuery = useMemo(() => (findMath.on ? mathQueryOf(findMath.query) : null), [findMath.on, findMath.query]);
  const matches = useMemo(() => {
    if (!active) return [];
    // math mode matches by tree, text mode by text.
    if (findMath.on) return mathQuery === null ? [] : active.view.regions.filter((region) => mathMatches(region, mathQuery)).map((region) => region.id);
    if (!find.query) return [];
    const needle = find.query.toLowerCase();
    return active.view.regions
      .filter((region) => searchText(region).toLowerCase().includes(needle))
      .map((region) => region.id);
  }, [active, find.query, findMath.on, mathQuery]);

  /**
   * Switches Find and Replace between text and math mode, keeping what is typed: text that
   * parses becomes math, math becomes its linear text. The keyboard stays in the box it was in.
   */
  const findTree = useCallback(
    async (text: string): Promise<Node> => {
      if (text.trim() === "") return emptyStatement();
      try {
        return toEditing(await backend.parseMath(text));
      } catch {
        return emptyStatement();
      }
    },
    [backend],
  );
  const toggleFindMode = useCallback(async () => {
    const inBox = document.activeElement?.closest(".status-item.find, .status-item.replace");
    const focus = inBox ? (inBox.classList.contains("replace") ? "replace" : "find") : null;
    if (!findMath.on) {
      const [query, replacement] = await Promise.all([findTree(find.query), findTree(find.replacement)]);
      setFindMath((f) => ({ on: true, query, replacement, key: f.key + 1, focus }));
      setFind((f) => ({ ...f, index: 0 }));
      return;
    }
    // The whole typed statement is printed: `printMath` takes a statement, not an expression.
    const toText = async (tree: Node): Promise<string> => {
      if (mathQueryOf(tree) === null) return "";
      try {
        return await backend.printMath(toWire(tree));
      } catch {
        return "";
      }
    };
    const [query, replacement] = await Promise.all([toText(findMath.query), toText(findMath.replacement)]);
    setFindMath((f) => ({ ...f, on: false, focus: null }));
    setFind((f) => ({ ...f, query, replacement, index: 0 }));
    if (focus) requestAnimationFrame(() => (focus === "replace" ? replaceInput : findInput).current?.focus());
  }, [backend, find.query, find.replacement, findMath, findTree]);

  /**
   * A paste into a text box of Find and Replace: math the app copied (a math editor's copy,
   * or one math region copied on the sheet) switches to math mode with it in that box; the other
   * box keeps what is typed, as Ctrl+M does. Any other text pastes as text (false).
   */
  const pasteIntoFind = useCallback(
    (box: "find" | "replace", text: string): boolean => {
      const math = mathOfPaste(text);
      if (math === null) return false;
      void (async () => {
        const pasted = await findTree(math);
        const other = await findTree(box === "find" ? find.replacement : find.query);
        setFindMath((f) => ({
          on: true,
          query: box === "find" ? pasted : other,
          replacement: box === "replace" ? pasted : other,
          key: f.key + 1,
          focus: box,
        }));
        setFind((f) => ({ ...f, index: 0 }));
      })();
      return true;
    },
    [find.query, find.replacement, findTree],
  );
  /** The math clipboard of the Find and Replace math boxes: a copied math region pastes as its math. */
  const findClipboard = useMemo<MathClipboard>(
    () => ({
      ...mathClipboard,
      paste: (editor, pending) => mathClipboard.paste(editor, pending.then((text) => (text === null ? null : mathOfSnippet(text) ?? text))),
    }),
    [mathClipboard],
  );

  // The names each include region brings in, read from the inspection while a region is edited.
  const [includedNames, setIncludedNames] = useState<{ doc: string; byRegion: Map<string, string[]> } | null>(null);
  const completionItems = useMemo<Completion[]>(() => {
    if (!active || !editing || editing.docId !== active.id) return [];
    const beforeEditor = (region: ViewRegion) =>
      region.page < editing.page ||
      (region.page === editing.page && (region.y < editing.y || (region.y === editing.y && region.x <= editing.x)));
    const names = definedNames(active.view.regions.map((region) =>
      region.kind === "math" && (isNode(region.statement) && region.statement.type === "GlobalDefine" || beforeEditor(region))
        ? region.statement
        : null,
    ));
    // The names an include region above the caret brings in.
    if (includedNames?.doc === active.id) {
      for (const region of active.view.regions) {
        if (region.kind !== "include" || !beforeEditor(region)) continue;
        for (const name of includedNames.byRegion.get(region.id) ?? []) names.add(name);
      }
    }
    return completionCatalog(names);
  }, [active, editing?.docId, editing?.page, editing?.x, editing?.y, includedNames]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentCompletions = useMemo(
    () => editing && editing.docId === active?.id ? completions(editing.editor, completionItems) : [],
    [active?.id, completionItems, editing],
  );
  const currentCompletionPrefix = editing ? completionPrefix(editing.editor) : null;
  useEffect(() => {
    setCompletionIndex(0);
    completionPicked.current = false;
  }, [editing?.regionId, currentCompletionPrefix]);

  const findStep = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      const index = (find.index + direction + matches.length) % matches.length;
      setFind((f) => ({ ...f, index }));
      actions.select([matches[index]]);
      setFocus({ id: matches[index], nonce: Date.now() });
      revealFind.current = true;
    },
    [actions, find.index, matches],
  );

  const onFind = useCallback(
    (query: string) => {
      setFind((f) => ({ ...f, query, index: 0 }));
    },
    [],
  );

  const onReplace = useCallback((replacement: string) => {
    setFind((f) => ({ ...f, replacement }));
  }, []);

  /** The region under the Find cursor: the one Replace acts on. */
  const currentMatch = matches.length === 0 ? null : matches[Math.min(find.index, matches.length - 1)];

  // the occurrences of the text query are marked on the sheet, again whenever the page changes.
  const revealFind = useRef(false);
  const findMarks = !printing && !findMath.on && find.query ? find.query : null;
  useEffect(() => {
    const root = document.querySelector(".sheet-host") ?? document.body;
    if (findMarks === null) {
      paintFind(root, [], null, null);
      return undefined;
    }
    let frame = 0;
    const run = () => {
      frame = 0;
      const current = paintFind(root, matches, currentMatch, findMarks);
      // A step of the cursor brings its first occurrence into view, past the region's own scroll.
      if (revealFind.current && current.length > 0) revealRange(current[0]);
      revealFind.current = false;
    };
    run();
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(run);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      paintFind(root, [], null, null);
    };
  }, [currentMatch, findMarks, matches]);

  /** Replace: rewrites the region under the cursor and leaves the cursor there. */
  const replaceOne = useCallback(async () => {
    if (!currentMatch || (!findMath.on && !find.query)) return;
    const mathReplacement = findMath.on ? mathQueryOf(findMath.replacement) : null;
    if (findMath.on && mathReplacement === null) {
      actions.notify(S.status.replaceNeedsMath);
      return;
    }
    // An open editor is committed first, as every other command does; a refused commit keeps it open.
    if (!(await actions.commitEdit())) return;
    const target = currentMatch;
    const outcome = findMath.on
      ? await actions.replaceMathInRegions([target], mathQuery, mathReplacement)
      : await actions.replaceInRegions([target], find.query, find.replacement);
    if (outcome.replaced === 0) {
      // a parse error of the new math is the reason, otherwise this match holds nothing to write.
      actions.notify(outcome.error === null ? S.status.replaceNothing : S.status.replaceInvalid(outcome.error), outcome.error === null ? "info" : "error");
      return;
    }
    actions.select([target]);
    setFocus({ id: target, nonce: Date.now() });
  }, [actions, currentMatch, find.query, find.replacement, findMath, mathQuery]);

  /** Replace All: every match, in reading order, then the cursor goes back to the first. */
  const replaceAll = useCallback(async () => {
    if (matches.length === 0 || (!findMath.on && !find.query)) return;
    const mathReplacement = findMath.on ? mathQueryOf(findMath.replacement) : null;
    if (findMath.on && mathReplacement === null) {
      actions.notify(S.status.replaceNeedsMath);
      return;
    }
    if (!(await actions.commitEdit())) return;
    const outcome = findMath.on
      ? await actions.replaceMathInRegions(matches, mathQuery, mathReplacement)
      : await actions.replaceInRegions(matches, find.query, find.replacement);
    setFind((f) => ({ ...f, index: 0 }));
    if (outcome.replaced === 0) {
      actions.notify(outcome.error === null ? S.status.replaceNothing : S.status.replaceInvalid(outcome.error), outcome.error === null ? "info" : "error");
    } else if (outcome.skipped === 0) {
      actions.notify(S.status.replacedIn(outcome.replaced), "success");
    } else {
      actions.notify(S.status.replacedSome(outcome.replaced, outcome.skipped, outcome.error), "warning");
    }
  }, [actions, find.query, find.replacement, findMath, mathQuery, matches]);

  // ---- side panel, hover information and navigation ----------------

  const inspector = useInspection(backend, active ?? undefined);
  // while math is edited in a worksheet with include regions, the names they bring in are read
  // from the inspection (once per view: `ensure` answers from the one it already has).
  const editingDoc = editing?.docId ?? null;
  const ensureForNames = inspector.ensure;
  const hasIncludes = !!active?.view.regions.some((region) => region.kind === "include");
  useEffect(() => {
    if (!active || editingDoc !== active.id || !hasIncludes) return undefined;
    let current = true;
    void ensureForNames().then((inspection) => {
      if (current && inspection) setIncludedNames({ doc: active.id, byRegion: includedNamesByRegion(inspection) });
    });
    return () => {
      current = false;
    };
  }, [active?.id, active?.view, editingDoc, ensureForNames, hasIncludes]); // eslint-disable-line react-hooks/exhaustive-deps
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab }>(readPanelSetting);
  const changePanel = useCallback((change: Partial<{ open: boolean; tab: PanelTab }>) => {
    setPanel((current) => {
      const next = { ...current, ...change };
      try {
        window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage is a convenience only */
      }
      return next;
    });
  }, []);
  // The side panel reads definitions, includes and ranks: while it is open the full inspection is
  // kept current, and dropped as soon as it closes.
  const { want: wantInspection, ensure: ensureInspection } = inspector;
  const panelWantsInspection = panel.open && !!active;
  useEffect(() => {
    wantInspection(panelWantsInspection);
  }, [wantInspection, panelWantsInspection]);
  // The text region the Text tab's background acts on: the one being edited, else the one selected.
  const textBackgroundRegion = useMemo(() => {
    if (!active) return null;
    const id = textEditing && textEditing.docId === active.id ? textEditing.regionId : active.selection.length === 1 ? active.selection[0] : null;
    const region = id ? active.view.regions.find((r) => r.id === id) : undefined;
    return region?.kind === "text" ? { id: region.id, background: region.background } : null;
  }, [active, textEditing]);
  const cursorKey = useMemo<RegionKey | null>(() => {
    if (!active) return null;
    const id =
      editing && editing.docId === active.id
        ? editing.regionId
        : textEditing && textEditing.docId === active.id
          ? textEditing.regionId
          : active.selection.length === 1
            ? active.selection[0]
            : null;
    return id ? { document: active.root, region_id: id, instance: 0 } : null;
  }, [active, editing, textEditing]);
  const problems = useMemo(
    () => (active ? problemsOf(active.root, active.results, active.diagnostics, inspector.warnings) : []),
    [active, inspector.warnings],
  );
  const problemCount = problems.length;
  /** The problem the Previous/Next Problem commands are on. */
  const problemIndex = useRef(-1);
  const [compactRibbon, setCompactRibbon] = useState(readCompactSetting);
  const toggleCompactRibbon = useCallback(() => {
    setCompactRibbon((current) => {
      try {
        window.localStorage.setItem(RIBBON_STORAGE_KEY, JSON.stringify({ compact: !current }));
      } catch {
        /* storage is a convenience only */
      }
      return !current;
    });
  }, []);

  const pendingJump = useRef<RegionKey | null>(null);
  const jumpInActive = useCallback(
    (regionId: string) => {
      const id = ownerRegionId(regionId);
      actions.select([id]);
      setFocus({ id, nonce: Date.now() });
    },
    [actions],
  );
  /** Goes to a region; one of an included worksheet opens (or activates) that file as a tab first. */
  const jump = useCallback(
    (key: RegionKey) => {
      if (!active) return;
      if (key.document === active.root) {
        jumpInActive(key.region_id);
        return;
      }
      pendingJump.current = key;
      const open = state.docs.find((d) => d.root === key.document);
      if (!open) void actions.open(key.document);
      else if (open.id !== active.id) actions.activate(open.id);
      else jumpInActive(key.region_id);
    },
    [actions, active, jumpInActive, state.docs],
  );
  useEffect(() => {
    const pending = pendingJump.current;
    if (pending && active && active.root === pending.document) {
      pendingJump.current = null;
      jumpInActive(pending.region_id);
    }
  }, [active?.id, active?.root]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Ctrl+click on the progress bar: the region being calculated is selected and brought into view. */
  const showRunningRegion = useCallback(() => {
    if (!active) return;
    const key = runningRegionOf(active.id);
    if (key && key.document === active.root) jumpInActive(key.region_id);
  }, [active, jumpInActive]);
  const openDocument = useCallback(
    (document: string) => {
      const open = state.docs.find((d) => d.root === document);
      if (open) actions.activate(open.id);
      else void actions.open(document);
    },
    [actions, state.docs],
  );

  const [hover, setHover] = useState<NameHover | null>(null);
  const [hoverShown, setHoverShown] = useState<NameHover | null>(null);
  const onNameHover = useCallback((next: NameHover | null) => setHover(next), []);
  useEffect(() => {
    if (!hover) {
      setHoverShown(null);
      return;
    }
    const timer = setTimeout(() => setHoverShown(hover), 350);
    return () => clearTimeout(timer);
  }, [hover]);
  useEffect(() => {
    const hide = () => setHover(null);
    window.addEventListener("pointerdown", hide);
    return () => window.removeEventListener("pointerdown", hide);
  }, []);
  /** A full inspection fetched for the hover card alone, and the view it describes. */
  const [hoverInspection, setHoverInspection] = useState<{ view: unknown; inspection: Inspection } | null>(null);
  useEffect(() => {
    setHover(null);
    setHoverInspection(null);
  }, [active?.id]);
  useEffect(() => {
    if (!hoverShown || !active) return;
    const view = active.view;
    let cancelled = false;
    void ensureInspection().then((next) => {
      if (!cancelled && next) setHoverInspection({ view, inspection: next });
    });
    return () => {
      cancelled = true;
    };
  }, [hoverShown, ensureInspection]); // eslint-disable-line react-hooks/exhaustive-deps
  // An edit moved the text under the pointer: the copy fetched for the old view is not used.
  const shownInspection =
    inspector.inspection ??
    (hoverInspection && hoverInspection.view === active?.view ? hoverInspection.inspection : null);
  const hoverInfo = useMemo(
    () =>
      active && shownInspection && hoverShown
        ? describeName(
            shownInspection,
            { document: active.root, region_id: hoverShown.regionId, instance: 0 },
            hoverShown.name,
            hoverShown.start,
            hoverShown.end,
            hoverShown.label,
          )
        : null,
    [active, hoverShown, shownInspection],
  );
  const hoverDefinition = hoverInfo?.kind === "definition" && hoverInfo.definition.label === "var" ? hoverInfo.definition : null;
  const { ensureValues, values: peeked } = inspector;
  useEffect(() => {
    if (hoverDefinition) ensureValues([{ name: hoverDefinition.name, version: hoverDefinition.version }]);
  }, [hoverDefinition, ensureValues, peeked]);
  const onNameClick = useCallback(
    (regionId: string, start: number, end: number, name: string): boolean => {
      if (!active) return false;
      const at = { document: active.root, region_id: regionId, instance: 0 };
      const jumpToDefinition = (inspection: Inspection | null): boolean => {
        if (!inspection) return false;
        const info = describeName(inspection, at, name, start, end);
        if (info.kind !== "definition") return false;
        jump(info.definition.key);
        return true;
      };
      if (inspector.inspection) return jumpToDefinition(inspector.inspection);
      // The side panel is closed and nothing keeps the inspection: ask for it, then jump. The click
      // over a name is a navigation gesture, so it is consumed here rather than moving the selection.
      void inspector.ensure().then((next) => {
        if (next) jumpToDefinition(next);
        // The session refuses an inspection while a calculation runs: the jump waits for its end.
        else if (runningRef.current) pendingNameJump.current = { regionId, start, end, name };
      });
      return true;
    },
    [active, inspector.inspection, inspector.ensure, jump],
  );
  const pendingNameJump = useRef<{ regionId: string; start: number; end: number; name: string } | null>(null);
  const activeRunning = active?.running ?? false;
  const runningRef = useRef(false);
  runningRef.current = activeRunning;
  useEffect(() => {
    const waiting = pendingNameJump.current;
    if (!waiting || activeRunning) return;
    pendingNameJump.current = null;
    onNameClick(waiting.regionId, waiting.start, waiting.end, waiting.name);
  }, [activeRunning, onNameClick]);
  const resultFormat = useMemo(() => formatFromSettings(active?.view.settings), [active?.view.settings]);
  // The result entries of the active worksheet, by region id (the instance of the root document).
  const resultEntries = useMemo(() => {
    const map = new Map<string, RegionEntry>();
    for (const entry of active?.results ?? []) {
      if (entry.key.instance === 0 && entry.key.document === active?.root) map.set(entry.key.region_id, entry);
    }
    return map;
  }, [active?.results, active?.root]);

  /**
   * The target of the Matrix tab's display command: the math region
   * being edited, else the single selected one, when it draws a result whose value is a matrix. The
   * choice it stores is `format.show-indices`; `inherited` is what the region shows without the key
   * (the worksheet setting), which is removed instead of written when the user returns to it.
   */
  const matrixDisplay = useMemo<{
    docId: string;
    regionId: string;
    indices: boolean;
    inherited: boolean;
    nested: boolean | null;
    nestedInherited: boolean;
    format: Record<string, string> | undefined;
  } | null>(() => {
    if (!active) return null;
    // While a math editor is open the target is its region and nothing else: a new region has no
    // region yet, and an unrelated selection must not lend the tab its commands.
    const editingHere = editing !== null && editing.docId === active.id;
    // A selection of elements in a result does not select the region; it is a target too.
    const regionId = editingHere
      ? editing.regionId
      : active.selection.length === 1
        ? active.selection[0]
        : resultSelection?.kind !== "symbolic" && resultSelection?.kind !== undefined
          ? resultSelection.regionId
          : null;
    if (!regionId) return null;
    const region = active.view.regions.find((candidate) => candidate.id === regionId);
    if (region?.kind !== "math") return null;
    const entry = resultEntries.get(regionId);
    const value = entry && (entry.state === "value" || entry.state === "stale") ? entry.value : null;
    const statement = editingHere && editing ? editing.editor.root : region.statement;
    // A result the region does not draw, or one that is not a matrix, has no display to choose.
    if (!value || value.type !== "matrix" || !showsResult(statement)) return null;
    const own = formatFromSettings({ ...active.view.settings, ...region.format });
    return {
      docId: active.id,
      regionId,
      indices: own.showIndices,
      inherited: resultFormat.showIndices,
      // Only a matrix with a matrix among its elements has nested arrays to expand.
      nested: hasNestedMatrix(value) ? expandsNested(own, value) : null,
      nestedInherited: expandsNested(resultFormat, value),
      format: region.format,
    };
  }, [active, editing, resultEntries, resultFormat, resultSelection]);

  /** The rows and columns shown read-only in the Matrix tab: the matrix being typed, else the target result. */
  const matrixShape = useMemo<{ rows: number; cols: number } | null>(() => {
    const typed = editing ? matrixControls(editing.editor) : null;
    if (typed) return { rows: typed.rows, cols: typed.cols };
    if (!matrixDisplay) return null;
    const entry = resultEntries.get(matrixDisplay.regionId);
    const value = entry && (entry.state === "value" || entry.state === "stale") ? entry.value : null;
    return value?.type === "matrix" ? { rows: value.rows, cols: value.cols } : null;
  }, [editing, matrixDisplay, resultEntries]);

  /**
   * Writes the worksheet size threshold of the Matrix tab's box: the display
   * setting `format.matrix-size` through the command the worksheet format uses, which is
   * display only — nothing is recalculated. A pair the sheet already has, and the built-in
   * `12,12`, write nothing or remove the key, and the core then adds no undo step.
   */
  const setMatrixSize = useCallback(
    (rows: number, cols: number) => {
      if (!active) return;
      const stored = formatFromSettings(active.view.settings);
      if (stored.matrixRows === rows && stored.matrixCols === cols) return;
      void actions.setResultDefaults(active.id, matrixSizeSettings(rows, cols));
    },
    [actions, active],
  );

  /** Shows or hides the indices of the target matrix result: one undo step of the region override. */
  const setMatrixDisplay = useCallback(
    (indices: boolean) => {
      const target = matrixDisplay;
      if (!target) return;
      const next: Record<string, string> = { ...(target.format ?? {}) };
      // A choice equal to what the region shows without it is not stored.
      if (indices === target.inherited) delete next[SHOW_INDICES_KEY];
      else next[SHOW_INDICES_KEY] = String(indices);
      if ((target.format?.[SHOW_INDICES_KEY] ?? null) === (next[SHOW_INDICES_KEY] ?? null)) return;
      void actions.setResultFormat(target.docId, target.regionId, Object.keys(next).length > 0 ? next : null);
    },
    [actions, matrixDisplay],
  );

  /** Expands or collapses the nested arrays of the target matrix result: one undo step of the region override. */
  const setMatrixNested = useCallback(
    (expand: boolean) => {
      const target = matrixDisplay;
      if (!target) return;
      const next: Record<string, string> = { ...(target.format ?? {}) };
      // A choice equal to what the region shows without it is not stored.
      if (expand === target.nestedInherited) delete next[EXPAND_NESTED_KEY];
      else next[EXPAND_NESTED_KEY] = String(expand);
      if ((target.format?.[EXPAND_NESTED_KEY] ?? null) === (next[EXPAND_NESTED_KEY] ?? null)) return;
      void actions.setResultFormat(target.docId, target.regionId, Object.keys(next).length > 0 ? next : null);
    },
    [actions, matrixDisplay],
  );

  const fitWidth = useCallback(() => {
    const area = document.querySelector<HTMLElement>(".worksheet-area");
    if (!area || !active) return;
    const layout = sheetLayout(active.view.page, 1);
    actions.setZoom(fitWidthZoom(area.clientWidth, layout.width));
  }, [actions, active]);

  const fitPage = useCallback(() => {
    const area = document.querySelector<HTMLElement>(".worksheet-area");
    if (!area || !active) return;
    const rect = sheetLayout(active.view.page, 1).pages[0];
    actions.setViewMode("page");
    actions.setZoom(fitPageZoom(area.clientWidth, area.clientHeight, rect.width, rect.height));
    setPageNavigation({ docId: active.id, page: page.current, fit: true });
  }, [actions, active, page.current]);

  // Window commands of the keymap: what a key resolves to when the math
  // editor does not consume it, or when no region is being edited (worksheet context).
  /** Copies (or cuts) the selected regions as a snippet of the worksheet `regions:` list. */
  const copyRegions = useCallback(
    async (cut: boolean) => {
      if (!active || active.selection.length === 0) return;
      // An area travels with its members, as it does for move and delete.
      const carried = withMembers(active.view.regions, active.selection, active.view.page);
      const chosen = active.view.regions.filter((region) => carried.includes(region.id));
      const work = regionsSnippet(
        chosen,
        (statement) => backend.printMath(statement),
        (resource) => backend.imageData(active.id, resource),
      );
      // The regions also go on the clipboard as pictures, an SVG and a PNG, beside the snippet
      //; one image region is its own picture. The clipboard item is made now,
      // inside the key press; its content follows.
      const single = chosen.length === 1 ? chosen[0] : null;
      const picture: Promise<Pictures> =
        single?.kind === "image"
          ? backend.imageData(active.id, single.resource).then(async (url) => ({ png: await imagePicture(single, url), svg: null }))
          : regionPictures(carried, active.selection, (ids) => actions.select(ids), state.zoom);
      picture.catch(() => undefined);
      const withSvg = single?.kind !== "image";
      // Windows: the web view's clipboard item carries both, made now inside the key press. Linux: the
      // clipboard is written natively once the snippet and the picture are ready.
      const native = !(navigator.userAgent ?? "").includes("Windows");
      const written =
        !native ? writeClipboardWithPicture(work.then((result) => result.snippet || null), picture, withSvg) : null;
      const { snippet, skipped } = await work;
      if (skipped > 0) actions.notify(S.clipboard.notCopied(skipped), "warning");
      if (!snippet) return;
      const outcome: PictureCopy = written
        ? await written
        : await writeClipboardNatively(snippet, picture, backend.writeClipboardPicture);
      if (outcome.written === "failed") {
        actions.notify(S.clipboard.writeFailed, "error");
        return;
      }
      if (outcome.written === "text") actions.notify(S.clipboard.pictureNotCopied(outcome.reason), "warning");
      // A cut that could not take every selected region is only a copy: nothing is lost.
      if (cut && skipped === 0) await actions.deleteSelection();
    },
    [actions, active, backend, state.zoom],
  );

  /** Copies the selected part of a result as math, at full precision. */
  const copyResult = useCallback(
    async (selection: ResultSelection) => {
      if (!active) return;
      const entry = active.results.find(
        (e) => e.key.region_id === selection.regionId && e.key.instance === 0 && e.key.document === active.root,
      );
      const value = entry && (entry.state === "value" || entry.state === "stale") ? entry.value : null;
      if (!value) return;
      let text: string | null = null;
      if (selection.kind === "symbolic") {
        if (value.type !== "symbolic") return;
        if (selection.path.length === 0) text = value.text;
        else {
          try {
            text = await backend.printMath({ type: "ExprRegion", expr: get(value.expr as Node, selection.path) });
          } catch {
            text = null;
          }
        }
      } else {
        let part = selectedValue(value, selection);
        // A large matrix holds only the blocks read so far: the cells of a selection of up
        // to 10 000 of them are read from the calculation; a larger one cannot be copied.
        const large = value.type === "matrix" && value.storage.type === "window";
        if (!part && large && selection.kind === "cells" && selection.matrix.length === 0) {
          const { r1, c1, r2, c2 } = selection;
          const rows = r2 - r1 + 1;
          const cols = c2 - c1 + 1;
          if (rows * cols <= WINDOW_LIMIT) {
            try {
              const values = await backend.resultBlock(active.id, entry!.key, r1, c1, rows, cols);
              part = values.length === 1 ? values[0] : { type: "matrix", rows, cols, storage: { type: "inline", values } };
            } catch {
              part = null;
            }
          }
        }
        if (!part && large) {
          actions.notify(S.result.notLoaded, "error");
          return;
        }
        text = part && valueText(part);
      }
      if (text === null) {
        actions.notify(S.clipboard.nothingToCopy, "error");
        return;
      }
      if (!(await writeClipboard(text))) {
        actions.notify(S.clipboard.writeFailed, "error");
        return;
      }
      rememberMathCopy(text);
    },
    [actions, active, backend],
  );

  // Open project goes straight to the native folder picker; the chosen
  // folder opens, Cancel does nothing, and a failure goes to the message bar.
  const openProjectFolder = useCallback(async () => {
    if (!(await actions.commitEdit())) return;
    let folder: string | null;
    try {
      folder = await backend.chooseFolder(S.project.browseProject, project?.root);
    } catch (error) {
      actions.notify(S.project.openFailed(String((error as { message?: string })?.message ?? error)), "error");
      return;
    }
    if (folder) await actions.openRecentProject(folder);
  }, [actions, backend, project?.root]);

  const windowCommand = useCallback(
    async (cmd: string, pending?: Promise<string | null>) => {
      if (activeProjectFile) {
        if (cmd === "closeDocument") { void actions.closeFile(activeProjectFile.id); return; }
        if (cmd === "save" || cmd === "fileSave") { void actions.saveFile(activeProjectFile.id); return; }
        // the Code tab acts on the editor in front, and on its file.
        const code: Record<string, CodeCommand> = {
          // quick-access Undo and Redo act on the tab in front, never on a worksheet.
          undo: "undo", redo: "redo",
          codeUndo: "undo", codeRedo: "redo", codeCut: "cut", codeCopy: "copy", codePaste: "paste",
          codeFind: "find", codeReplace: "replace", codeGoToLine: "goToLine", codeToggleComment: "toggleComment",
          codeIndent: "indent", codeOutdent: "outdent", codeDuplicateLine: "duplicateLine",
          codeMoveLineUp: "moveLineUp", codeMoveLineDown: "moveLineDown",
        };
        if (code[cmd]) { runCodeCommand(code[cmd]); return; }
        if (cmd === "fileReload") { void actions.reloadFile(activeProjectFile.id); return; }
        if (cmd === "fileReveal") {
          void backend.revealFile(activeProjectFile.id).catch((error) => actions.notify(S.documents.revealFailed(error?.message ?? String(error)), "error"));
          return;
        }
        if (cmd === "fileOpenExternal") { void actions.openFileExternally(activeProjectFile.path); return; }
        if (cmd === "fileToggleModule") {
          const module = juliaModuleOf(activeProjectFile.path);
          if (module) module.onToggle(!module.loaded);
          return;
        }
        if (cmd === "fileRestartKernel") {
          const base = project ? `${project.root.replace(/\\/g, "/").replace(/\/+$/, "")}/` : null;
          const sheet = base ? state.docs.find((doc) => doc.root.replace(/\\/g, "/").startsWith(base)) : undefined;
          if (sheet) void actions.restartEnvironmentKernel(sheet.id);
          else actions.notify(S.project.noWorksheet, "warning");
          return;
        }
        if (cmd === "fileEnvironment") {
          void (async () => {
            try {
              await actions.openProjectEnvironment();
              setEnvironmentManager(true);
            } catch (error) {
              actions.notify(String((error as { message?: string })?.message ?? error), "warning");
            }
          })();
          return;
        }
        const globalCommands = new Set(["toggleRepl", "restartRepl", "newDocument", "openDocument", "newProject", "openProject", "closeProject", "projectSettings", "projectImageUsage", "textRecoveries", "packProject", "extractProject", "importMcdx", "options", "shortcutSheet", "openManual", "commandPalette", "toggleCompactRibbon", "importReport"]);
        if (!globalCommands.has(cmd)) return;
      }
      if ((cmd === "undo" || cmd === "redo") && editing && editing.docId === active?.id) {
        // The open math editor owns its local history until it commits. Even with an empty local
        // stack, never let this command fall through and undo a worksheet edit underneath it.
        const editor = liveEditor.current ?? editing.editor;
        const available = cmd === "undo" ? editor.past.length > 0 : editor.future.length > 0;
        // a region the paste opened has the paste as its first step.
        if (!available && cmd === "undo" && editing.pasted) {
          if (await actions.commitEdit()) await actions.undo();
          return;
        }
        if (available) {
          const next = runCommand(editor, cmd);
          liveEditor.current = next;
          actions.updateEditor(next);
        }
        return;
      }
      if ((cmd === "undo" || cmd === "redo") && textEditing && textEditing.docId === active?.id) {
        // the open text editor owns its history, an inline equation in it first; an empty
        // history does nothing rather than undo the worksheet underneath.
        if (inlineActive) {
          if (cmd === "undo" ? inlineActive.canUndo : inlineActive.canRedo) inlineActive[cmd]();
        } else if (cmd === "undo" ? textHistory?.canUndo : textHistory?.canRedo) {
          textHandle.current?.[cmd]();
        }
        return;
      }
      const nudge = (dx: number, dy: number, far = false) => {
        if (!active) return;
        // Nothing selected: the arrows move the crosshair (one grid step, Shift four); with a
        // selection they nudge the selected regions.
        if (active.selection.length === 0) {
          actions.moveCrosshair(dx < 0 ? "left" : dx > 0 ? "right" : dy < 0 ? "up" : "down", far ? 4 : 1);
          return;
        }
        const carried = withMembers(active.view.regions, active.selection, active.view.page);
        const moves = active.view.regions
          .filter((region) => carried.includes(region.id))
          .map((region) => ({
            region_id: region.id,
            page: region.page,
            x: Math.max(0, region.x + dx),
            y: Math.max(0, region.y + dy),
          }));
        void actions.moveRegions(moves);
      };
      /** The one selected region of a kind (the target of the Plot and Area tab commands). */
      const selectedOne = (kind: ViewRegion["kind"]) => {
        if (!active || active.selection.length !== 1) return null;
        const region = active.view.regions.find((r) => r.id === active.selection[0]);
        return region?.kind === kind ? region : null;
      };
      if (isPlotCommand(cmd)) {
        const region = selectedOne("plot");
        if (region?.kind !== "plot") {
          actions.notify(S.ribbon.needsPlot);
          return;
        }
        const selectedTraceId = plotTraceSelections[region.id] ?? null;
        const next = applyPlotCommand(region.plot, cmd, selectedTraceId);
        if (next) {
          if (cmd === "plotAddTrace") selectPlotTrace(region.id, next.traces[next.traces.length - 1]?.id ?? null);
          if (cmd === "plotRemoveTrace") selectPlotTrace(region.id, null);
          await actions.setPlot(region.id, next);
        }
        return;
      }
      switch (cmd) {
        case "toggleRegionEnabled": {
          // The inline equation being edited: only that run.
          if (inlineActive) {
            inlineActive.setDisabled(!inlineActive.disabled);
            return;
          }
          // disable the selected regions, or enable them all when they are all disabled.
          const selection = active?.selection ?? [];
          if (!active || selection.length === 0) {
            actions.notify(S.ribbon.needsRegion);
            return;
          }
          // All selected regions disabled: enable them; otherwise disable them all.
          await actions.setRegionsEnabled(selection, allSelectedDisabled(active));
          return;
        }
        case "textAlignLeft":
        case "textAlignCenter":
        case "textAlignRight":
        case "textAlignJustify":
        case "textStyleNormal":
        case "textStyleTitle":
        case "textStyleSubtitle":
        case "textStyleHeading1":
        case "textStyleHeading2":
        case "textStyleHeading3": {
          // The Text tab's paragraph commands: they act on the open text
          // region, so the palette entry says so when there is none.
          if (!textHandle.current) {
            actions.notify(S.text.needsParagraph);
            return;
          }
          const align = { textAlignLeft: "left", textAlignCenter: "center", textAlignRight: "right", textAlignJustify: "justify" } as const;
          const style = {
            textStyleNormal: "normal",
            textStyleTitle: "title",
            textStyleSubtitle: "subtitle",
            textStyleHeading1: "heading1",
            textStyleHeading2: "heading2",
            textStyleHeading3: "heading3",
          } as const;
          if (cmd in align) textHandle.current.setAlign(align[cmd as keyof typeof align]);
          else textHandle.current.setParagraphStyle(style[cmd as keyof typeof style]);
          return;
        }
        case "toggleArea": {
          const region = selectedOne("area");
          if (!region) actions.notify(S.ribbon.needsArea);
          else await actions.toggleArea(region.id);
          return;
        }
        case "insertPlot":
          await actions.addRegion("plot");
          return;
        case "insertInclude":
          {
            // the file is asked for first; nothing is inserted when the dialog is cancelled.
            const path = await backend.chooseIncludePath(active?.id);
            if (path) await actions.addRegion("include", path);
          }
          return;
        case "insertJulia":
          await actions.addRegion("julia");
          return;
        case "untrustWorksheet":
          await actions.untrust();
          return;
        case "importMcdx":
          if (await actions.commitEdit()) void actions.importWithDialog();
          return;
        case "previousProblem":
        case "nextProblem": {
          if (problems.length === 0) {
            actions.notify(S.ribbon.noProblems, "success");
            return;
          }
          const step = cmd === "nextProblem" ? 1 : -1;
          const current = Math.min(problemIndex.current, problems.length - 1);
          const index = current < 0 ? (step > 0 ? 0 : problems.length - 1) : (current + step + problems.length) % problems.length;
          problemIndex.current = index;
          jump(problems[index].key);
          return;
        }
        case "problemsPanel":
          changePanel({ open: true, tab: "problems" });
          return;
        case "sidePanel":
          changePanel({ open: !panel.open });
          return;
        case "toggleCompactRibbon":
          toggleCompactRibbon();
          return;
        case "toggleRepl":
          setRepl((current) => ({ ...current, open: !current.open }));
          return;
        case "restartRepl":
          void actions.restartRepl(project?.root ?? null);
          return;
        case "copy":
        case "cut": {
          if (resultSelection && active) {
            // A result is never cut: Ctrl+X copies the selected part like Ctrl+C.
            await copyResult(resultSelection);
            return;
          }
          if (editing && liveEditor.current) {
            const next = await mathClipboard.copy(liveEditor.current, cmd === "cut");
            if (next) {
              liveEditor.current = next;
              actions.updateEditor(next);
            }
            return;
          }
          await copyRegions(cmd === "cut");
          return;
        }
        case "paste": {
          // From a key press `pending` is the paste read through the hidden textarea; from the
          // ribbon it is the async clipboard API.
          const source = pending ?? readClipboard();
          if (editing && liveEditor.current) {
            const next = await mathClipboard.paste(liveEditor.current, source);
            if (next) {
              liveEditor.current = next;
              actions.updateEditor(next);
            }
            return;
          }
          const text = await source;
          if (!text && !pending) {
            // Nothing as text from a ribbon press: an image on the clipboard becomes an image region.
            const image = await readClipboardImage();
            if (image) {
              await actions.addImages([{ file: image }]);
              return;
            }
          }
          if (text === null) actions.notify(S.clipboard.denied, "error");
          else await actions.pasteText(text);
          return;
        }
        case "exitRegion":
          await actions.commitEdit();
          return;
        case "leaveRegion":
          if (editing?.rejected) actions.cancelEdit();
          else await actions.commitEdit();
          return;
        case "matrixDialog":
          setMatrixDialog(true);
          return;
        case "increaseFontSize":
        case "decreaseFontSize": {
          // every target region moves one step of the list; the ends stay put.
          if (!active) {
            actions.notify(S.mathFont.needsWorksheet);
            return;
          }
          const direction = cmd === "increaseFontSize" ? 1 : -1;
          const targets = mathFontTargets(active, editing);
          if (targets.length === 0) {
            actions.notify(S.mathFont.noRegion);
            return;
          }
          const edits = targets.flatMap((region) => {
            const font = mathFontOf(region.format);
            if (!canStepMathSize(font.sizePt, direction)) return [];
            return [
              {
                region_id: region.id,
                format: withMathFont(region.format, { ...font, sizePt: stepMathSize(font.sizePt, direction) }),
              },
            ];
          });
          // Nothing to change: no edit, no undo step, and the command says why.
          if (edits.length === 0) {
            actions.notify(direction > 0 ? S.mathFont.largest : S.mathFont.smallest);
            return;
          }
          void actions.setMathFont(active.id, edits, false);
          return;
        }
        case "mathFont": {
          if (inlineActive) {
            setInlineDialog({ kind: "font", run: inlineActive });
            return;
          }
          if (!active) {
            actions.notify(S.mathFont.needsWorksheet);
            return;
          }
          if (mathFontTargets(active, editing).length === 0) {
            actions.notify(S.mathFont.noRegion);
            return;
          }
          setMathFontDialog(active.id);
          return;
        }
        case "resetMathFont": {
          // the three font keys go, the result format and the table box stay.
          if (!active) {
            actions.notify(S.mathFont.needsWorksheet);
            return;
          }
          const targets = mathFontTargets(active, editing);
          if (targets.length === 0) {
            actions.notify(S.mathFont.noRegion);
            return;
          }
          const edits = targets.flatMap((region) =>
            hasMathFont(region.format) ? [{ region_id: region.id, format: withoutMathFont(region.format) }] : [],
          );
          if (edits.length === 0) return;
          void actions.setMathFont(active.id, edits, true);
          return;
        }
        case "matrixShowIndices": {
          // the palette entry toggles the choice of the same target as the checkbox.
          if (!active) {
            actions.notify(S.matrixDisplay.needsWorksheet);
            return;
          }
          if (!matrixDisplay) {
            actions.notify(S.matrixDisplay.noMatrix);
            return;
          }
          setMatrixDisplay(!matrixDisplay.indices);
          return;
        }
        case "resultFormat": {
          if (inlineActive) {
            setInlineDialog({ kind: "format", run: inlineActive });
            return;
          }
          // the region being edited, else the single selected math region
          const regionId = editing?.regionId ?? (active?.selection.length === 1 ? active.selection[0] : null);
          const target = active?.view.regions.find((r) => r.id === regionId);
          if (!active || !regionId || target?.kind !== "math") {
            actions.notify(S.resultFormat.noRegion);
            return;
          }
          setFormatDialog({ docId: active.id, regionId });
          return;
        }
        case "worksheetFormat":
          // The worksheet default needs no target, only an open worksheet.
          if (active) setFormatDialog({ docId: active.id, regionId: null });
          else actions.notify(S.resultFormat.needsWorksheet);
          return;
        case "calculationSettings":
          // The tolerances belong to the worksheet and need no target.
          if (active) setCalculationSettingsDialog(active.id);
          else actions.notify(S.calculationSettings.needsWorksheet);
          return;
        case "spelling":
          // the language of the worksheet and of the selected text regions, and the dictionaries.
          if (active) setSpellingDialog(true);
          else actions.notify(S.spelling.needsWorksheet);
          return;
        case "toggleSpelling":
          void actions.setSettings({ ...settings, spelling: { enabled: !settings.spelling.enabled } });
          return;
        case "labelStyles":
          // the label styles belong to the worksheet and need no target, only a worksheet.
          if (active) setLabelStylesDialog(active.id);
          else actions.notify(S.labelStyles.needsWorksheet);
          return;
        case "commandPalette":
          setCommandPalette(true);
          return;
        case "insertSearch":
          openInsertSearch(document.activeElement);
          return;
        case "toggleCalculation":
          actions.toggleCalcMode();
          return;
        case "stop":
          void actions.stop();
          return;
        case "pageView":
        case "draftView":
          actions.setViewMode(cmd === "pageView" ? "page" : "draft");
          return;
        case "fitWidth":
          fitWidth();
          return;
        case "fitPage":
          fitPage();
          return;
        case "functionCatalogue":
          setCatalogue({ query: "", help: false });
          return;
        case "openManual":
          void openManual();
          return;
        case "functionHelp":
          setCatalogue({ query: (editing && liveEditor.current ? nameAtFocus(liveEditor.current) : null) ?? "", help: true });
          return;
        case "calculate":
        case "calculateAll":
          if (await actions.commitEdit()) void actions.recalculate(cmd === "calculateAll");
          return;
        case "undo":
          void actions.undo();
          return;
        case "redo":
          void actions.redo();
          return;
        case "juliaEnvironment":
          if (active) setEnvironmentManager(true);
          return;
        case "packProject":
          if (await actions.commitEdit()) void actions.packProject();
          return;
        case "extractProject":
          if (await actions.commitEdit()) void actions.extractProject();
          return;
        case "newProject":
          if (await actions.commitEdit()) setProjectDialog("new");
          return;
        case "closeProject":
          void actions.closeProject();
          return;
        case "projectSettings":
          if (project && await actions.commitEdit()) setProjectSettings(true);
          return;
        case "projectImageUsage":
          if (project && await actions.commitEdit()) setImageUsage(true);
          return;
        case "textRecoveries":
          setTextRecoveries(true);
          return;
        case "openProject":
          void openProjectFolder();
          return;
        case "convertToProject":
          if (active && (await actions.commitEdit())) setProjectDialog("convert");
          return;
        case "newDocument":
          if (await actions.commitEdit()) void actions.create();
          return;
        case "openDocument":
          if (await actions.commitEdit()) void actions.openWithDialog();
          return;
        case "saveProject":
          if (project) void actions.saveProject();
          return;
        case "save":
          // Save while a text tab is in front saves that file.
          if (activeFile) void actions.saveFile(activeFile);
          else void actions.save();
          return;
        case "saveAs":
          void actions.saveAs();
          return;
        case "closeDocument":
          if (active) void actions.requestClose(active.id);
          return;
        case "selectAll":
          actions.selectAll();
          return;
        case "deleteRegions":
          // Delete acts on the selection; with nothing selected, directly above a page break it
          // removes the break, and elsewhere one line of the blank space below.
          if (active && active.selection.length > 0) void actions.deleteSelection();
          else if (active && !(await actions.removePageBreakAtKey("Delete"))) await actions.removeSpace();
          return;
        case "deleteBack":
          // Backspace on the sheet: the selection, else directly below a page break the break,
          // else one line of the blank space above, as in a text editor.
          if (active && active.selection.length > 0) void actions.deleteSelection();
          else if (active && !(await actions.removePageBreakAtKey("Backspace"))) await actions.removeSpaceAbove();
          return;
        case "insertLine":
          // Enter on the sheet: one worksheet line at the crosshair, the regions at or below it move
          // down and the crosshair follows onto the new line (GitHub ).
          await actions.insertLine();
          return;
        case "addSpace":
          // Document > Spacing: the same worksheet line as Enter.
          await actions.addSpace();
          return;
        case "removeSpace":
          // One line of the blank space below the caret line.
          await actions.removeSpace();
          return;
        case "addPageBreak":
          // The page ends at the caret line and the content below continues on the next page.
          await actions.addPageBreak();
          return;
        case "clearSelection":
          actions.select([]);
          return;
        case "insertMath":
          await actions.beginNew();
          return;
        case "insertText":
          await actions.beginNewText(true);
          return;
        case "insertTextRegion":
          await actions.beginNewText();
          return;
        case "insertImage":
          await actions.addImageWithDialog();
          return;
        case "imageOriginalSize": {
          // Image tab and palette: the one selected image.
          const region = selectedOne("image");
          if (region?.kind !== "image") {
            actions.notify(S.ribbon.needsImage);
            return;
          }
          await actions.originalImageSize(region.id);
          return;
        }
        case "imageReplace": {
          const region = selectedOne("image");
          if (region?.kind !== "image") {
            actions.notify(S.ribbon.needsImage);
            return;
          }
          await actions.replaceImageWithDialog(region.id);
          return;
        }
        case "juliaOriginalSize": {
          const region = selectedOne("julia");
          if (region?.kind !== "julia") {
            actions.notify(S.ribbon.needsJulia);
            return;
          }
          await actions.setJuliaSize(region.id, null, null);
          return;
        }
        case "insertArea":
          await actions.addRegion("area");
          return;
        case "insertTable": {
          // the new table opens with the caret in its first name cell (grid cell 0).
          const added = await actions.addRegion("table");
          if (added?.created) await actions.beginEditWhenPresent(added.created, { path: [0, 0], side: "L", caret: null });
          return;
        }
        case "zoomIn":
          actions.setZoom(stepZoom(state.zoom, 1));
          return;
        case "zoomOut":
          actions.setZoom(stepZoom(state.zoom, -1));
          return;
        case "zoomReset":
          actions.setZoom(1);
          return;
        case "nudgeLeft":
        case "nudgeRight":
        case "nudgeUp":
        case "nudgeDown":
        case "nudgeLeftFar":
        case "nudgeRightFar":
        case "nudgeUpFar":
        case "nudgeDownFar": {
          const step = GRID_PT * (cmd.endsWith("Far") ? 4 : 1);
          const dir = cmd.replace("nudge", "").replace("Far", "");
          nudge(dir === "Left" ? -step : dir === "Right" ? step : 0, dir === "Up" ? -step : dir === "Down" ? step : 0, cmd.endsWith("Far"));
          return;
        }
        case "find":
          if (findMath.on) document.querySelector<HTMLElement>('.status-item.find [data-testid="inline-math"]')?.focus();
          else {
            findInput.current?.focus();
            findInput.current?.select();
          }
          return;
        case "replace": {
          // with no query there is nothing to replace yet, so the keyboard goes to Find.
          if (findMath.on) {
            const box = mathQuery === null ? ".status-item.find" : ".status-item.replace";
            document.querySelector<HTMLElement>(`${box} [data-testid="inline-math"]`)?.focus();
            return;
          }
          const field = find.query === "" ? findInput.current : replaceInput.current;
          field?.focus();
          field?.select();
          return;
        }
        case "options":
          setOptionsDialog(true);
          return;
        case "pageSetup":
        case "headerFooter":
          // both open the same dialog, the second one at its header/footer section. The
          // change applies to the document, so an edit in progress is committed first.
          if (await actions.commitEdit()) setPageSetupDialog(cmd === "headerFooter" ? "chrome" : "page");
          return;
        case "importReport":
          setImportReportDialog(true);
          return;
        case "shortcutSheet":
          setShortcutSheetDialog(true);
          return;
        case "exportPdf":
          void actions.exportPdf();
          return;
        case "print":
          void actions.printDialog();
          return;
        default:
          return;
      }
    },
    [actions, active, activeFile, activeProjectFile, backend, project, state.docs, openProjectFolder, changePanel, copyRegions, copyResult, editing, inlineActive, textEditing, textHistory, find.query, findMath.on, fitPage, fitWidth, jump, mathClipboard, mathQuery, matrixDisplay, panel.open, plotTraceSelections, problems, resultSelection, selectPlotTrace, setMatrixDisplay, state.zoom, toggleCompactRibbon],
  );

  // Every key goes through the keymap: to the math editor while a region is edited,
  // otherwise to the sheet (a printable character starts a math region at the crosshair).
  useEffect(() => {
    const busy = (action: Promise<unknown>) => {
      const tracked: Promise<unknown> = action.finally(() => {
        if (repeatBusy.current !== tracked) return;
        repeatBusy.current = null;
        const lines = pendingLines.current;
        pendingLines.current = 0;
        if (lines > 0) busy(actions.insertLine(lines));
      });
      repeatBusy.current = tracked;
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".terminal-host")) return;
      if (event.key === "Escape" && event.defaultPrevented) return;
      // The webview's own zoom (Ctrl with +, -, =) never fires: these chords are math commands now
      // (a new math region on the empty crosshair); zoom is the status bar control, Ctrl+wheel, Ctrl+0.
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ["+", "-", "=", "_"].includes(event.key)) {
        event.preventDefault();
      }
      const target = event.target as HTMLElement | null;
      // The REPL's output is text to select and copy: keys pressed in it stay with the panel.
      const typing =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable || target.closest?.(".repl-log") != null);
      // The project explorer keeps its own keys: F2 renames a file there, Delete trashes one.
      const inExplorer = target?.closest?.(".project-explorer-frame, .tree-menu") != null;
      if (inExplorer || matrixDialog || optionsDialog || pageSetupDialog || formatDialog || mathFontDialog || inlineDialog || labelStylesDialog || calculationSettingsDialog || ribbonModal || state.prompt) return;
      if (typing) {
        // a field of the window's chrome (REPL, Find, side panel filter, ribbon fields) keeps the
        // editing keys, and the window commands that edit nothing still work from it.
        const inChrome = target?.closest?.(CHROME_FIELDS) != null;
        const action = inChrome ? resolve(fromDom(event), "global") : null;
        if (action?.kind === "command" && FIELD_COMMANDS.has(action.cmd)) {
          event.preventDefault();
          void windowCommand(action.cmd);
        }
        return;
      }
      // A held key repeats faster than an edit reaches the backend and is drawn: a repeat is dropped
      // while the action of the previous press is still running, so the key acts for as long as it
      // is held and stops when it is released, instead of working through a backlog of repeats.
      if (event.repeat && repeatBusy.current) {
        event.preventDefault();
        // A held Enter on the sheet counts its repeats instead: they become one insertion of that
        // many lines when the running one ends, so it is as fast as the key and stops with it.
        const onSheet = !(editing && editing.docId === active?.id);
        const sheetAction = onSheet ? resolve(fromDom(event), "sheet") : null;
        if (sheetAction?.kind === "command" && sheetAction.cmd === "insertLine") {
          pendingLines.current += 1;
        }
        return;
      }
      // A commit is on its way to the backend: keys typed meanwhile must not reach the editor that is
      // being committed. They are replayed in order once it has finished.
      const pending = actions.commitPending();
      if (!replayed.current.has(event) && (pending || replayQueue.current.length > 0) && !event.repeat && !["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(event.key)) {
        event.preventDefault();
        const copy = new KeyboardEvent("keydown", {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          bubbles: true,
          cancelable: true,
        });
        const draining = replayQueue.current.length > 0;
        replayQueue.current.push(copy);
        if (!draining) {
          // Replayed one by one, each after React has applied the previous one.
          void (async () => {
            await pending?.catch(() => undefined);
            while (mounted.current && replayQueue.current.length > 0) {
              await new Promise((r) => setTimeout(r, 30));
              if (!mounted.current) break;
              const next = replayQueue.current.shift() as KeyboardEvent;
              replayed.current.add(next);
              window.dispatchEvent(next);
              // a replayed key may itself start a commit: the rest waits for it
              await new Promise((r) => setTimeout(r, 30));
              await actions.commitPending()?.catch(() => undefined);
            }
          })();
        }
        return;
      }
      const ev = fromDom(event);
      if (editing && editing.docId === active?.id) {
        const editor = liveEditor.current ?? editing.editor;
        const suggestions = completions(editor, completionItems);
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length > 0) {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          completionPicked.current = true;
          setCompletionIndex((index) => (index + delta + suggestions.length) % suggestions.length);
          return;
        }
        // A single candidate needs no arrow: `identi` + Tab completes `identity`. With a
        // longer list Tab keeps moving between placeholders, because there the arrows choose.
        const chosen = completionPicked.current || suggestions.length === 1;
        if (event.key === "Tab" && !event.shiftKey && suggestions.length > 0 && chosen) {
          event.preventDefault();
          const next = acceptCompletion(editor, suggestions[Math.min(completionIndex, suggestions.length - 1)]);
          liveEditor.current = next;
          actions.updateEditor(next);
          return;
        }
        // Backspace or Delete on an empty expression removes the region (a new one is simply dropped).
        if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isEmptyStatement(editor.root)) {
          event.preventDefault();
          busy(actions.commitEdit());
          return;
        }
        // a Space after one plain word in a new region makes a text box of the word.
        if (event.key === " " && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && editing.regionId === null) {
          const word = loneNameText(editor);
          if (word) {
            event.preventDefault();
            actions.convertDraftToText(word);
            return;
          }
        }
        const result = handleKey(editor, ev);
        // An arrow with nothing left to do inside the region leaves it (inner movement - cells, lines,
        // exponents, the caret - has priority): the region is committed and the crosshair goes beside it.
        const arrow = ARROW_DIRECTIONS[event.key];
        if (arrow && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && result.handled && sameCursor(editor, result.state)) {
          event.preventDefault();
          busy(actions.leaveEditing(arrow));
          return;
        }
        // Ctrl+Z with nothing to undo in a region the paste opened undoes the paste.
        if (result.action?.kind === "command" && result.action.cmd === "undo" && editor.past.length === 0 && editing.pasted) {
          event.preventDefault();
          busy(windowCommand("undo"));
          return;
        }
        const isPaste = result.action?.kind === "command" && result.action.cmd === "paste";
        // The browser's own paste must happen (it lands in a hidden textarea): no preventDefault.
        if (result.action && !isPaste) event.preventDefault();
        if (result.handled) {
          liveEditor.current = result.state;
          actions.updateEditor(result.state);
        }
        else if (result.action?.kind === "command") {
          busy(windowCommand(result.action.cmd, isPaste ? readClipboardFromGesture() : undefined));
        }
        return;
      }
      const action = resolve(ev, "sheet");
      if (!action) {
        // A math chord on the empty crosshair (Ctrl+Shift+D, Ctrl+Shift+4, Ctrl+M, ...) starts a region
        // and applies there, as in the reference application (found driving the real app: the chord was ignored).
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
          const math = resolve(ev, "math");
          if (math && math.kind === "command" && math.cmd !== "insertSearch") {
            event.preventDefault();
            busy(actions.beginNew().then((editor) => {
              if (!editor) return;
              const next = handleKey(editor, ev).state;
              liveEditor.current = next;
              actions.updateEditor(next);
            }));
          }
        }
        return;
      }
      const nudge = action.kind === "command" ? NUDGE_DIRECTIONS[action.cmd] : undefined;
      if (nudge && active && active.selection.length === 0) {
        // Nothing is selected: the arrows move the crosshair, accelerating while the key is held.
        const repeats =
          event.repeat && crosshairHold.current?.direction === nudge ? crosshairHold.current.repeats + 1 : 0;
        crosshairHold.current = { direction: nudge, repeats };
        event.preventDefault();
        actions.moveCrosshair(nudge, crosshairRepeatSteps(repeats));
        return;
      }
      if (action.kind === "command" && action.cmd === "paste") {
        busy(windowCommand("paste", readClipboardFromGesture()));
        return;
      }
      event.preventDefault();
      if (action.kind === "char") {
        busy(actions.beginNew().then((editor) => {
          if (!editor) return;
          const next = handleKey(editor, ev).state;
          liveEditor.current = next;
          actions.updateEditor(next);
        }));
      } else {
        busy(windowCommand(action.cmd));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, active, calculationSettingsDialog, completionIndex, completionItems, editing, matrixDialog, optionsDialog, pageSetupDialog, formatDialog, labelStylesDialog, mathFontDialog, ribbonModal, state.prompt, windowCommand]);

  // Ctrl+Z straight after a Space made a text box of a word brings the math back. Capture
  // phase, so it comes before the text editor's own undo; any other Ctrl+Z is left to it.
  useEffect(() => {
    if (!textEditing?.fromMath) return undefined;
    const onUndo = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.(".terminal-host")) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "z") return;
      if (actions.revertTextToMath()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onUndo, true);
    return () => window.removeEventListener("keydown", onUndo, true);
  }, [actions, textEditing?.fromMath]);

  // A mouse drag inside the math being edited: the smallest node that contains both ends.
  const onMathSelect = useCallback(
    (from: MathHit, to: MathHit, word = false) => {
      const editor = liveEditor.current;
      if (!editor) return;
      const same = from.path.join(".") === to.path.join(".");
      const next = word
        ? selectRange(editor, from.path, from.path)
        : same && from.caret?.offset === to.caret?.offset && from.caret?.seg === to.caret?.seg
          ? placeCaret(editor, from.path, from.side, from.caret)
          : selectRange(editor, from.path, to.path);
      liveEditor.current = next;
      actions.updateEditor(next);
    },
    [actions],
  );

  const onEditRegion = useCallback(
    (id: string, hit: MathHit | null) => {
      if (id === DRAFT_ID) {
        if (editing && editing.regionId === null && hit) {
          try {
            actions.updateEditor(placeCaret(editing.editor, hit.path, hit.side, hit.caret));
          } catch {
            /* stale path */
          }
        }
        return;
      }
      void actions.beginEdit(id, hit);
    },
    [actions, editing],
  );

  const updateFromRibbon = useCallback(
    async (change: (editor: EditorState) => EditorState) => {
      if (!active) return;
      // An inline math editor inside a text region has the keyboard: palettes act on it.
      if (mathTarget.current) {
        mathTarget.current.update(change);
        return;
      }
      let editor = liveEditor.current ?? editing?.editor ?? null;
      if (!editor) editor = await actions.beginNew();
      if (!editor) return;
      const next = change(editor);
      liveEditor.current = next;
      actions.updateEditor(next);
    },
    [actions, editing, active],
  );

  const editorCommand = useCallback(
    (command: Command) => void updateFromRibbon((editor) => runCommand(editor, command)),
    [updateFromRibbon],
  );

  const runPaletteAction = useCallback(
    (action: PaletteAction) => void updateFromRibbon((editor) => applyPaletteAction(editor, action)),
    [updateFromRibbon],
  );

  const acceptEditorCompletion = useCallback(
    (completion: Completion) => void updateFromRibbon((editor) => acceptCompletion(editor, completion)),
    [updateFromRibbon],
  );

  const commandItems = useMemo(() => buildCommandItems(), []);
  const insertionItems = useMemo(
    () => equationInsertionItems(commandItems, insertSearch?.newDraft ?? false),
    [commandItems, insertSearch?.newDraft],
  );
  const closeInsertSearch = useCallback((cancel: boolean) => {
    if (cancel && insertSearch?.newDraft) actions.cancelEdit();
    setInsertSearch(null);
    focusWorksheet();
  }, [actions, focusWorksheet, insertSearch?.newDraft]);
  const runCommandItem = useCallback(
    (item: CommandItem) => {
      setCommandPalette(false);
      switch (item.run.kind) {
        case "window":
          void windowCommand(item.run.cmd);
          return;
        case "action":
          runPaletteAction(item.run.action);
          return;
        case "palette":
          palettes.open(item.run.palette);
          return;
        case "catalogue":
          setCatalogue({ query: "", help: false });
          return;
      }
    },
    [palettes, runPaletteAction, windowCommand],
  );

  const running = active?.running ?? false;
  const formatRegionId = editing?.regionId ?? (active?.selection.length === 1 ? active.selection[0] : null);
  const canFormatResult = active?.view.regions.some(
    (region) => region.id === formatRegionId && region.kind === "math",
  ) ?? false;
  // the math-font commands need one math region, selected or edited.
  // The colours already in the worksheet: the pickers offer them.
  const worksheetColorList = useMemo(() => worksheetColors(active?.view.regions ?? []), [active?.view.regions]);
  const mathTargets = mathFontTargets(active, editing);
  const canFormatMath = mathTargets.length > 0;
  // the size of the targets for the Size field, or "mixed" when they differ.
  const mathSizes = new Set(mathTargets.map((region) => mathFontOf(region.format).sizePt));
  const mathSize: number | "mixed" | null = mathSizes.size === 0 ? null : mathSizes.size === 1 ? [...mathSizes][0] : "mixed";
  const docs = state.docs.map((doc) => ({ ...doc, modified: modified(doc) }));
  const projectFileStatus: Record<string, { modified?: boolean; errors?: number; missingResources?: number }> = {};
  const errorRegions = new Map<string, Set<string>>();
  for (const doc of state.docs) {
    const path = projectPathOf(doc.root);
    if (path) projectFileStatus[path] = { modified: modified(doc), missingResources: unavailableImageCount(doc.root, doc.view.regions, doc.diagnostics) };
    for (const result of doc.results) {
      if (result.state !== "error") continue;
      const target = projectPathOf(result.key.document);
      if (!target) continue;
      const ids = errorRegions.get(target) ?? new Set<string>();
      ids.add(result.key.region_id);
      errorRegions.set(target, ids);
    }
  }
  for (const [path, ids] of errorRegions) projectFileStatus[path] = { ...projectFileStatus[path], errors: ids.size };
  for (const tab of fileTabs) {
    if (tab.root === project?.root) projectFileStatus[tab.path] = { modified: tab.text !== tab.saved };
  }

  // The right-click menu: the webview's own menu never appears; where there is
  // something to do the app's menu opens, with the commands of the kind of thing under the pointer.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    target: ContextTarget;
    /** The one region pressed, for the project's Export command. */
    region?: string;
    /** A misspelt word under the pointer and its corrections, shown at the end of the menu. */
    spell?: { word: Misspelt; suggestions: string[] | null };
  } | null>(null);
  const contextField = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onContext = (event: MouseEvent) => {
      event.preventDefault();
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (!element || element.closest(".context-menu")) return;
      // a misspelt word under the pointer adds its corrections at the end of the menu.
      const wrong = misspeltAt(event.clientX, event.clientY, misspelt.current);
      if (wrong) {
        void backend.spellSuggest(wrong.language, wrong.word).then(
          (suggestions) => setContextMenu((menu) => (menu?.spell?.word === wrong ? { ...menu, spell: { word: wrong, suggestions } } : menu)),
          () => setContextMenu((menu) => (menu?.spell?.word === wrong ? { ...menu, spell: { word: wrong, suggestions: [] } } : menu)),
        );
      }
      const spell = wrong ? { word: wrong, suggestions: null } : undefined;
      const field = element.closest<HTMLElement>('input, textarea, [contenteditable="true"]');
      if (field) {
        const type = field instanceof HTMLInputElement ? field.type : "text";
        // A colour, range or checkbox field has no text to cut or paste: no menu at all.
        if (["color", "range", "checkbox", "radio", "button", "file"].includes(type)) return;
        contextField.current = field;
        setContextMenu({ x: event.clientX, y: event.clientY, target: "field", spell });
        return;
      }
      if (!active) return;
      const host = element.closest<HTMLElement>("[data-region-id]");
      const region = host ? active.view.regions.find((candidate) => candidate.id === host.dataset.regionId) : undefined;
      if (region) {
        // A right press on a region that is not selected selects it first; on one that is part of a
        // selection it leaves the selection as it is.
        if (!active.selection.includes(region.id)) actions.select([region.id]);
        const multiple = active.selection.includes(region.id) && active.selection.length > 1;
        setContextMenu({ x: event.clientX, y: event.clientY, target: multiple ? "multiple" : region.kind, region: multiple ? undefined : region.id, spell });
        return;
      }
      if (element.closest('[data-testid="sheet"]')) {
        const at = placeAtRef.current?.(event.clientX, event.clientY);
        if (at) actions.setCrosshair({ page: at.page, x: snapToGrid(at.x), y: snapToGrid(at.y) });
        setContextMenu({ x: event.clientX, y: event.clientY, target: "sheet" });
      }
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, [active, actions, backend]);

  /** The spelling entries of the menu: a correction, Ignore or Add to dictionary. */
  const runSpellCommand = useCallback(
    async (cmd: string, word: Misspelt, suggestions: readonly string[]) => {
      if (cmd === "spell:add") {
        try {
          await backend.spellAddWord(word.word);
          spellCache.accept(word.word);
        } catch (error) {
          actions.notify(String((error as { message?: string })?.message ?? error), "error");
        }
        return;
      }
      if (!active) return;
      if (cmd === "spell:ignore") {
        await actions.setSpelling(active.id, { "spelling.ignore": withIgnored(active.view.settings?.["spelling.ignore"], word.word) });
        return;
      }
      const replacement = suggestions[Number(cmd.slice("spell:replace:".length))];
      if (replacement === undefined) return;
      // The text being edited takes the correction as typing (the editor's own undo step); the
      // page view rewrites the stored text of the region (one undo step of the worksheet).
      const editable = word.node.parentElement?.closest<HTMLElement>('[contenteditable="true"]');
      if (editable) {
        editable.focus();
        const range = document.createRange();
        range.setStart(word.node, word.start);
        range.setEnd(word.node, word.end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("insertText", false, replacement);
        return;
      }
      const host = word.node.parentElement?.closest<HTMLElement>("[data-region-id]");
      const region = active.view.regions.find((r) => r.id === word.regionId);
      if (!host || !region || region.kind !== "text") return;
      const next = replaceOccurrence(region.paragraphs, word.word, occurrenceOf(word, host), replacement);
      if (next) await actions.rewriteText(region.id, next);
    },
    [active, actions, backend, spellCache],
  );
  /** every `.jl` file of the open project can be loaded in its worksheets. */
  const juliaModuleOf = (path: string) => {
    if (!project || !path.endsWith(".jl")) return undefined;
    const loaded = (project.manifest.julia_modules ?? []).includes(path);
    return { loaded, onToggle: (next: boolean) => void actions.setJuliaModule(path, next) };
  };

  /** The math definition the context menu was opened on, in a worksheet of the open project. */
  const exportTarget = (() => {
    if (!contextMenu || contextMenu.target !== "math" || !contextMenu.region || !active) return null;
    const path = projectPathOf(active.root);
    const region = active.view.regions.find((candidate) => candidate.id === contextMenu.region);
    if (!path || !region || region.kind !== "math" || !/:=|≡/.test(region.text)) return null;
    const exported = (projectReferences?.exports ?? []).some((e) => e.worksheet === path && e.region === region.id);
    return { path, region: region.id, exported };
  })();

  // The Julia REPL starts hidden; retain the panel height between launches.
  const [repl, setRepl] = useState<{ open: boolean; height: number }>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("equavela.repl") ?? "null") as { height?: unknown } | null;
      const height = typeof stored?.height === "number" ? Math.min(REPL_MAX, Math.max(REPL_MIN, stored.height)) : 220;
      return { open: false, height };
    } catch {
      return { open: false, height: 220 };
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem("equavela.repl", JSON.stringify({ height: repl.height })); } catch { /* per-user convenience only */ }
  }, [repl]);
  const replProject = replProjectOf(project?.root ?? null, active);
  // the module names of the open worksheets, asked again when the documents, the project
  // or a calculation change (a save renames, a new file can number another one).
  const [moduleNames, setModuleNames] = useState<Record<string, string>>({});
  const moduleNamesKey = `${state.docs.map((doc) => `${doc.id}=${doc.root}`).join("|")}#${replProject ?? ""}#${active?.running ? 1 : 0}`;
  useEffect(() => {
    let current = true;
    backend.worksheetModuleNames().then((names) => { if (current) setModuleNames(names); }).catch(() => undefined);
    return () => { current = false; };
  }, [backend, moduleNamesKey]);
  const replTarget = replProject
    ? { key: `project:${replProject}`, label: S.repl.projectEnvironment(project?.manifest.name ?? replProject) }
    : { key: "generic", label: S.repl.genericEnvironment };

  const runContextCommand = useCallback(
    async (cmd: string) => {
      const field = contextField.current;
      if (cmd.startsWith("field")) {
        field?.focus();
        if (cmd === "fieldCut") document.execCommand("cut");
        else if (cmd === "fieldCopy") document.execCommand("copy");
        else if (cmd === "fieldSelectAll") {
          if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.select();
          else document.execCommand("selectAll");
        } else if (cmd === "fieldPaste") {
          const text = await readClipboard();
          if (text) document.execCommand("insertText", false, text);
          else if (text === null) actions.notify(S.clipboard.denied, "error");
        }
        return;
      }
      await windowCommand(cmd);
    },
    [actions, windowCommand],
  );

  const commandHistory = activeProjectFile ? {
    canUndo: codeHistory?.canUndo ?? false,
    canRedo: codeHistory?.canRedo ?? false,
    undoLabel: S.quickAccess.undoTextEdit,
    redoLabel: S.quickAccess.redoTextEdit,
  } : editing && editing.docId === active?.id ? {
    canUndo: (liveEditor.current ?? editing.editor).past.length > 0 || editing.pasted === true,
    canRedo: (liveEditor.current ?? editing.editor).future.length > 0,
    undoLabel: S.quickAccess.undoMathEdit,
    redoLabel: S.quickAccess.redoMathEdit,
  } : textEditing && textEditing.docId === active?.id ? (inlineActive ? {
    canUndo: inlineActive.canUndo,
    canRedo: inlineActive.canRedo,
    undoLabel: S.quickAccess.undoMathEdit,
    redoLabel: S.quickAccess.redoMathEdit,
  } : {
    canUndo: textHistory?.canUndo ?? false,
    canRedo: textHistory?.canRedo ?? false,
    undoLabel: S.quickAccess.undoTextEdit,
    redoLabel: S.quickAccess.redoTextEdit,
  }) : undefined;

  return (
    <div className="app" data-backend={state.mode}>
      <TitleBar
        doc={active}
        file={activeProjectFile ? { name: activeProjectFile.path, modified: activeProjectFile.text !== activeProjectFile.saved } : undefined}
        modified={active ? modified(active) : false}
        recentFiles={recentFiles}
        recentProjects={recentProjects}
        history={commandHistory}
        onNew={() => void actions.create()}
        onOpen={() => void actions.openWithDialog()}
        onOpenRecent={(path) => void actions.openRecent(path)}
        onOpenRecentProject={(root) => void actions.openRecentProject(root)}
        onSave={() => void (project ? actions.saveProject() : activeFile ? actions.saveFile(activeFile) : actions.save())}
        saveTitle={project ? S.project.saveProject : undefined}
        onSaveAs={() => void actions.saveAs()}
        onUndo={() => void windowCommand("undo")}
        onRedo={() => void windowCommand("redo")}
        projectActions={{
          onNew: () => void windowCommand("newProject"),
          onOpen: () => void openProjectFolder(),
          // only a standalone worksheet can become a project.
          onConvert: active && projectPathOf(active.root) === null ? () => void windowCommand("convertToProject") : null,
        }}
      />
      <PlotContext.Provider value={plotEnv}>
      <Ribbon
        hasProject={!!project}
        canConvertToProject={active !== null && projectPathOf(active.root) === null}
        canUndo={commandHistory?.canUndo ?? active?.view.can_undo}
        canRedo={commandHistory?.canRedo ?? active?.view.can_redo}
        file={activeProjectFile ? {
          kind: activeProjectFile.kind === "image" ? "image" : "text",
          julia: activeProjectFile.path.toLowerCase().endsWith(".jl"),
          modified: activeProjectFile.text !== activeProjectFile.saved,
          moduleLoaded: juliaModuleOf(activeProjectFile.path)?.loaded ?? null,
        } : null}
        hasDoc={active !== null}
        hasSelection={(active?.selection.length ?? 0) > 0}
        fastSymbolicEnabled={fastAvailable}
        onFastSymbolic={anchor => setFastMenu({ anchor, quick: false })}
        inlineEquation={active !== null && inlineActive !== null}
        selectionDisabled={inlineActive ? inlineActive.disabled : allSelectedDisabled(active)}
        running={running}
        calcMode={state.calcMode}
        viewMode={state.viewMode}
        context={ribbonContext({
          textEditing: textEditing !== null && textEditing.docId === active?.id,
          mathEditing: editing !== null && editing.docId === active?.id,
          inMatrix: editing !== null && matrixControls(editing.editor) !== null,
          matrixResult: matrixDisplay !== null,
          selection: active?.selection ?? [],
          regions: active?.view.regions ?? [],
          plotTraceSelections,
          mathRegionId: editing?.regionId ?? null,
        })}
        onNumericOptions={(regionId, options) => active && void actions.setNumericOptions(active.id, regionId, options)}
        matrixControls={editing ? matrixControls(editing.editor) : null}
        matrixShape={matrixShape}
        matrixDisplay={matrixDisplay ? { indices: matrixDisplay.indices, nested: matrixDisplay.nested } : null}
        // the size threshold is the worksheet's, so the box is there whenever one is open.
        matrixSize={active ? { rows: resultFormat.matrixRows, cols: resultFormat.matrixCols } : null}
        compact={compactRibbon}
        textFormat={textFormat}
        onTextFormat={(kind: TextFormatKind) => textHandle.current?.toggle(kind)}
        onTextSize={(pt: number | null) => textHandle.current?.setSize(pt)}
        onTextColor={(color) => textHandle.current?.setColor(color)}
        onTextHighlight={(color) => textHandle.current?.setHighlight(color)}
        textBackground={textBackgroundRegion ? { color: textBackgroundRegion.background ?? null } : null}
        onTextBackground={(color) => textBackgroundRegion && void actions.setTextBackground(textBackgroundRegion.id, color)}
        onParagraphStyle={(style) => textHandle.current?.setParagraphStyle(style)}
        onTextAlign={(align) => textHandle.current?.setAlign(align)}
        onInsertInlineMath={() => textHandle.current?.insertMath()}
        canFormatResult={canFormatResult}
        canFormatMath={canFormatMath}
        worksheetColors={worksheetColorList}
        mathSize={mathSize}
        onMathSize={(pt) => {
          // the size field gives every target region this size, in one undo step.
          if (!active) return;
          const edits = mathTargets.flatMap((region) => {
            const font = mathFontOf(region.format);
            return font.sizePt === pt ? [] : [{ region_id: region.id, format: withMathFont(region.format, { ...font, sizePt: pt }) }];
          });
          if (edits.length > 0) void actions.setMathFont(active.id, edits, false);
        }}
        problems={problemCount}
        panelOpen={panel.open}
        spellingOn={settings.spelling.enabled}
        onCommand={(cmd) => void windowCommand(cmd)}
        onEditorCommand={editorCommand}
        onMatrixDisplay={setMatrixDisplay}
        onMatrixNested={setMatrixNested}
        onMatrixSize={setMatrixSize}
        onPlotSpec={(plot) => {
          const regionId = active?.selection.length === 1 ? active.selection[0] : null;
          if (regionId) void actions.setPlot(regionId, plot);
        }}
        onPlotSelectTrace={(traceId) => {
          const regionId = active?.selection.length === 1 ? active.selection[0] : null;
          if (regionId) selectPlotTrace(regionId, traceId);
        }}
        onPalette={palettes.open}
        openPalettes={palettes.palettes.map((p) => p.kind)}
      />
      </PlotContext.Provider>
      <DocumentTabs
        docs={docs}
        activeId={state.activeId}
        onActivate={(id) => { actions.setActiveFile(null); actions.activate(id); }}
        onClose={(id) => void actions.requestClose(id)}
        files={fileTabs}
        activeFile={activeFile}
        onActivateFile={(id) => void (async () => { if (await actions.commitEdit()) actions.setActiveFile(id); })()}
        onCloseFile={(id) => void actions.closeFile(id)}
        onReveal={(path) => void backend.revealFile(path).catch((error) => actions.notify(S.documents.revealFailed(error?.message ?? String(error)), "error"))}
        onCopyPath={(path) => void writeClipboard(path)}
        moduleNames={moduleNames}
        />
      <EngineStartNotice kernel={kernelOf(state, active)} activity={activityOf(state, active)} />
      {state.message && <MessageBar text={state.message} level={state.messageLevel} onDismiss={actions.dismissMessage} />}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={S.contextMenu.title}
          items={[
            ...contextEntries(contextMenu.target).map((cmd): ContextMenuItem =>
              cmd === "-"
                ? { kind: "separator" }
                : {
                    kind: "item",
                    id: cmd,
                    label: contextLabel(cmd, allSelectedDisabled(active)),
                    shortcut: shortcutLabel(cmd),
                    disabled: contextDisabled(cmd, { selected: active?.selection.length ?? 0, canFormatMath, kind: contextMenu.target }),
                  },
            ),
            // a definition of a project worksheet can be exported for other projects.
            ...(exportTarget
              ? [
                  { kind: "separator" } as ContextMenuItem,
                  { kind: "item", id: "project:export", label: exportTarget.exported ? S.references.stopExporting : S.references.exportFromProject } as ContextMenuItem,
                ]
              : []),
            // the corrections of the misspelt word under the pointer close the menu.
            ...(contextMenu.spell
              ? [
                  { kind: "separator" } as ContextMenuItem,
                  ...(contextMenu.spell.suggestions === null || contextMenu.spell.suggestions.length === 0
                    ? [{ kind: "item", id: "spell:none", label: contextMenu.spell.suggestions === null ? "…" : S.spelling.noSuggestions, disabled: true } as ContextMenuItem]
                    : contextMenu.spell.suggestions.map(
                        (suggestion, index): ContextMenuItem => ({ kind: "item", id: `spell:replace:${index}`, label: suggestion, strong: true }),
                      )),
                  { kind: "item", id: "spell:ignore", label: S.spelling.ignore } as ContextMenuItem,
                  { kind: "item", id: "spell:add", label: S.spelling.addToDictionary } as ContextMenuItem,
                ]
              : []),
          ]}
          onChoose={(cmd) => {
            const spell = contextMenu.spell;
            if (cmd === "project:export" && exportTarget) void (async () => {
              if (await actions.commitEdit()) await actions.setProjectExport(exportTarget.path, exportTarget.region, !exportTarget.exported);
            })();
            else if (cmd.startsWith("spell:") && spell) void runSpellCommand(cmd, spell.word, spell.suggestions ?? []);
            else void runContextCommand(cmd);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {environmentManager && active && (
        <EnvironmentManager
          load={loadEnvironment}
          onReadEnvironmentMetadata={(file) => actions.readEnvironmentMetadata(activeId ?? "", file)}
          onPreviewEnvironment={(choose) => actions.previewEnvironmentSwitch(activeId ?? "", choose)}
          onCommitEnvironment={(token) => actions.commitEnvironmentSwitch(activeId ?? "", token)}
          onCopyEnvironment={(destination) => actions.copyEnvironment(activeId ?? "", destination)}
          onChangePackages={(names, remove) => actions.changePackages(activeId ?? "", names, remove)}
          onManageEnvironment={(operation) => actions.manageEnvironment(activeId ?? "", operation)}
          onRevertChange={(interrupted, restore) => actions.revertEnvironmentChange(activeId ?? "", interrupted, restore)}
          onRestartKernel={() => actions.restartEnvironmentKernel(activeId ?? "")}
          onSetCompatibility={(packageName, compatibility) => actions.setCompatibility(activeId ?? "", packageName, compatibility)}
          onClose={() => setEnvironmentManager(false)}
        />
      )}
      {projectSettings && project && (
        <ProjectSettingsDialog
          project={project}
          exports={projectReferences?.exports}
          onStopExporting={(path, region) => actions.setProjectExport(path, region, false)}
          onGoToExport={async (path, region) => {
            if (!(await actions.commitEdit())) throw { message: S.project.finishEdit };
            const full = `${project.root.replace(/\\/g, "/").replace(/\/+$/, "")}/${path}`;
            const existing = state.docs.find(doc => doc.root.replace(/\\/g, "/") === full);
            if (existing) actions.activate(existing.id);
            else if (!(await actions.open(full))) throw { message: S.project.openFailed(path) };
            actions.setActiveFile(null);
            actions.select([region]);
            setProjectSettings(false);
          }}
          onEnvironment={async () => {
            await actions.openProjectEnvironment();
            setProjectSettings(false);
            setEnvironmentManager(true);
          }}
          onReveal={() => void actions.revealProjectItem("")}
          onUsage={() => { setProjectSettings(false); setImageUsage(true); }}
          onClose={() => setProjectSettings(false)}
        />
      )}
      {textRecoveries && (
        <ProjectTextRecoveryDialog
          load={backend.listProjectTextRecoveries}
          read={backend.readProjectTextRecovery}
          exportCopy={backend.exportProjectTextRecovery}
          discard={actions.discardRecoveredTextEntry}
          onClose={() => setTextRecoveries(false)}
        />
      )}
      {imageUsage && project && (
        <ProjectImageUsageDialog
          load={loadImageUsage}
          onOpenWorksheet={async path => {
            if (!(await actions.commitEdit())) throw { message: S.project.finishEdit };
            const full = `${project.root.replace(/\\/g, "/").replace(/\/+$/, "")}/${path}`;
            const existing = state.docs.find(doc => doc.root.replace(/\\/g, "/") === full);
            if (existing) actions.activate(existing.id);
            else if (!(await actions.open(full))) throw { message: S.project.openFailed(path) };
            actions.setActiveFile(null);
            setImageUsage(false);
          }}
          onClose={() => setImageUsage(false)}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          mode={projectDialog}
          initialName={projectDialog === "convert" ? (active?.name ?? "").replace(/\.eqvz$/i, "") : ""}
          initialParent={projectDialog === "convert" && active && /^(?:[A-Za-z]:[\\/]|\/)/.test(active.root) ? active.root.replace(/[\\/][^\\/]*$/, "") : undefined}
          chooseFolder={backend.chooseFolder}
          onClose={() => setProjectDialog(null)}
          onSubmit={(path, name) => (projectDialog === "convert" ? actions.convertToProject(path, name) : actions.loadProject(projectDialog, path, name))}
        />
      )}
      <main className="workspace">
        {project && (
          <ProjectExplorerFrame inspectorOpen={panel.open && !!active} onOpen={() => changePanel({ open: false })}>
          <ProjectTree
            project={project}
            entries={projectEntries}
            activeRoot={activeProjectFile?.id ?? active?.root ?? null}
            fileStatus={projectFileStatus}
            actions={{
              open: (path) => void (async () => { if (await actions.commitEdit()) await actions.openProjectWorksheet(path); })(),
              openMany: (paths) => void (async () => { if (await actions.commitEdit()) await actions.openProjectItems(paths); })(),
              create: async (folder, name, kind) => { if (await actions.commitEdit()) await actions.createProjectItem(folder, name, kind); },
              rename: async (path, name) => { if (await actions.commitEdit()) await actions.renameProjectItem(path, name); },
              move: (path, folder) => void (async () => { if (await actions.commitEdit()) await actions.moveProjectItem(path, folder); })(),
              moveMany: (paths, folder) => void (async () => { if (await actions.commitEdit()) await actions.moveProjectItems(paths, folder); })(),
              delete: (path, folder, files) => void (async () => { if (await actions.commitEdit()) await actions.deleteProjectItem(path, folder, files); })(),
              deleteMany: (items) => void (async () => { if (await actions.commitEdit()) await actions.deleteProjectItems(items); })(),
              import: (folder) => void (async () => { if (await actions.commitEdit()) await actions.importProjectFiles(folder); })(),
              reveal: (path) => void actions.revealProjectItem(path),
              openFile: (path, kind) => void (async () => { if (await actions.commitEdit()) await actions.openProjectFile(path, kind); })(),
              openExternal: (path) => void actions.openFileExternally(path),
              addReference: () => void actions.addProjectReference(),
              referenceCommand: (command, alias, value) => actions.projectReferenceCommand(command, alias, value),
              openReferencedProject: (root) => void actions.openRecentProject(root),
              developReferencePackage: (alias, name) => void actions.developReferencePackage(alias, name),
            }}
            references={projectReferences}
          />
          </ProjectExplorerFrame>
        )}
        <div className="sheet-host">
        {activeFile && fileTabs.some((tab) => tab.id === activeFile) ? (
          (() => {
            const tab = fileTabs.find((item) => item.id === activeFile) as (typeof fileTabs)[number];
            return <FileTabView
              tab={tab}
              onEdit={(text) => actions.editFile(tab.id, text)}
              onSave={() => void actions.saveFile(tab.id)}
              onReload={() => void actions.reloadFile(tab.id)}
              onClose={() => void actions.closeFile(tab.id)}
              module={juliaModuleOf(tab.path)}
              onHistory={setCodeHistory}
              complete={(text, position) => {
                // the kernel of the project's environment, through one of its open worksheets.
                const base = project ? `${project.root.replace(/\\/g, "/").replace(/\/+$/, "")}/` : null;
                const sheet = base ? state.docs.find((doc) => doc.root.replace(/\\/g, "/").startsWith(base)) : undefined;
                return sheet ? backend.completeCode(sheet.id, text, position) : Promise.reject(new Error("no worksheet"));
              }}
            />;
          })()
        ) : active ? (
          <SheetFrame
            path={projectPathOf(active.root)}
            modified={active.edits !== active.savedEdits}
            pendingEdit={editing?.docId === active.id || textEditing?.docId === active.id}
            onSave={() => void actions.saveWorksheet(active.id)}
          >
          <PlotContext.Provider value={plotEnv}>
          <ImageContext.Provider value={images}>
          <TextEnvContext.Provider value={textEnv}>
          {/* a block's completions come from the kernel of the worksheet's environment. */}
          <JuliaCompleteContext.Provider value={juliaComplete}>
          <ResultBlocksContext.Provider value={resultBlocks}>
          <PageView
            key={active.id}
            fastSymbolicBusy={fastBusy?.doc === active.id ? fastBusy.region : undefined}
            doc={active}
            zoom={state.zoom}
            viewMode={state.viewMode}
            focus={focus}
            onSelect={actions.select}
            onMove={(moves) => void actions.moveRegions(moves)}
            onJuliaChange={(id, change) => void actions.setJulia(id, change)}
            onResize={(id, size) => {
              const region = active.view.regions.find((r) => r.id === id);
              if (region?.kind === "plot" && size.w !== null && size.h !== null) {
                void actions.setPlot(id, { ...region.plot, size: [size.w, size.h] });
              } else if (region?.kind === "area" && size.h !== null) {
                void actions.setArea(id, { height: size.h });
              } else if (region?.kind === "image" && size.w !== null && size.h !== null) {
                void actions.setImageSize(id, size.w, size.h);
              } else if (region?.kind === "julia" && size.w !== null && size.h !== null) {
                // The box of a Julia block: one undo step per drag.
                void actions.setJuliaSize(id, size.w, size.h);
              } else if (region?.kind === "math" && size.w !== null && size.h !== null) {
                // The box of the result table is a region display setting: the same edit
                // command as the format dialog, so one drag is one undo step.
                void actions.setResultFormat(active.id, region.id, {
                  ...region.format,
                  [RESULT_TABLE_SIZE_KEY]: tableSizeValue([size.w, size.h]),
                });
              } else {
                void actions.setRegionWidth(id, size.w);
              }
            }}
            warnings={inspector.warnings}
            onNameHover={onNameHover}
            onNameClick={onNameClick}
            layoutRef={layoutRef}
            placeAtRef={placeAtRef}
            onToggleArea={(id) => void actions.toggleArea(id)}
            onAreaTitle={(id, title) => void actions.setArea(id, { title })}
            onIncludePath={(id, path) => void actions.setIncludePath(id, path)}
            onBrowseInclude={(id) =>
              void backend.chooseIncludePath(active?.id).then((path) => (path ? actions.setIncludePath(id, path) : undefined))
            }
            onDropFiles={(files, at) => void actions.addImages(files.filter(imageOrReport).map((file) => ({ file })), at)}
            onCrosshair={actions.setCrosshair}
            onZoomWheel={(direction) => actions.setZoom(stepZoom(state.zoom, direction))}
            onPageChange={(current, total) => {
              pageCountRef.current = total;
              setPage((p) => (p.current === current && p.total === total ? p : { current, total }));
            }}
            pageNavigation={pageNavigation?.docId === active.id ? pageNavigation : undefined}
            onPageNavigationDone={() => setPageNavigation(null)}
            editing={editing}
            completions={currentCompletions}
            completionIndex={completionIndex}
            onCompletion={acceptEditorCompletion}
            onEditRegion={onEditRegion}
            onMathSelect={onMathSelect}
            resultSelection={resultSelection}
            onResultSelect={setResultSelection}
            onBackground={() => void actions.commitEdit()}
            textEditing={textEditing}
            textBinding={textBinding}
            onEditText={(id, point) => void actions.beginText(id, point)}
          />
          </ResultBlocksContext.Provider>
          </JuliaCompleteContext.Provider>
          </TextEnvContext.Provider>
          </ImageContext.Provider>
          </PlotContext.Provider>
          </SheetFrame>
        ) : (
          state.ready && (
            <div className="no-document chrome">
              <p>{S.documents.empty}</p>
              <p className="hint">{S.documents.emptyHint}</p>
              <p className="project-actions">
                <button type="button" onClick={() => setProjectDialog("new")}>{S.project.newTitle}…</button>{" "}
                <button type="button" onClick={() => void openProjectFolder()}>{S.project.openTitle}…</button>{" "}
                <button type="button" onClick={() => void actions.extractProject()}>{S.project.extract}</button>
              </p>
            </div>
          )
        )}
        </div>
        {panel.open && active && (
          <>
          <button className="inspector-backdrop no-print" aria-label={S.panel.closeDrawer} onClick={() => changePanel({ open: false })} />
          <SidePanel
            doc={active}
            inspection={inspector.inspection}
            warnings={inspector.warnings}
            values={inspector.values}
            ensureValues={inspector.ensureValues}
            cursor={cursorKey}
            format={resultFormat}
            tab={panel.tab}
            onTab={(tab) => changePanel({ tab })}
            onJump={jump}
            onOpenDocument={openDocument}
            onAddPackage={(name) => void actions.addMissingPackage(active.id, name)}
            onOpenEnvironment={() => setEnvironmentManager(true)}
            onClose={() => changePanel({ open: false })}
            moduleName={moduleNames[active.id] ?? null}
          />
          </>
        )}
      </main>
      {repl.open && (
        <TerminalPanel
          target={replTarget}
          height={repl.height}
          onHeight={(height) => setRepl((current) => ({ ...current, height }))}
          backend={backend}
          project={replProject}
          onClose={() => setRepl((current) => ({ ...current, open: false }))}
          onRestart={() => void actions.restartRepl(replProject)}
        />
      )}
      {hoverShown && hoverInfo && active && (
        <HoverCard
          hover={hoverShown}
          info={hoverInfo}
          value={hoverDefinition ? inspector.values.get(valueId(hoverDefinition)) : undefined}
          root={active.root}
          pageOf={(regionId) => active.view.regions.find((r) => r.id === ownerRegionId(regionId))?.page ?? null}
          format={resultFormat}
          moduleName={moduleNames[active.id] ?? null}
        />
      )}
      <StatusBar
        mode={state.mode}
        kernel={kernelOf(state, active)}
        environment={active?.environment ? { summary: active.environment, onOpen: () => setEnvironmentManager(true) } : undefined}
        doc={active}
        repl={{
          open: repl.open,
          onToggle: () => setRepl((current) => ({ ...current, open: !current.open })),
          onRestart: () => void actions.restartRepl(replProject),
        }}
        page={page}
        onGoToPage={active && !activeProjectFile ? (number) => {
          focusWorksheet();
          setPageNavigation({ docId: active.id, page: number, fit: false });
        } : undefined}
        onCancelPageNavigation={focusWorksheet}
        calcMode={state.calcMode}
        zoom={state.zoom}
        viewMode={state.viewMode}
        find={{ query: find.query, replacement: find.replacement, index: find.index, total: matches.length }}
        onFind={onFind}
        onReplace={onReplace}
        onFindStep={findStep}
        onReplaceOne={() => void replaceOne()}
        onReplaceAll={() => void replaceAll()}
        findRef={findInput}
        replaceRef={replaceInput}
        findMode={{
          math: findMath.on,
          onToggle: () => void toggleFindMode(),
          hasQuery: mathQuery !== null,
          onPaste: pasteIntoFind,
          findBox: (
            <FindMathBox
              key={`find-${findMath.key}`}
              tree={findMath.query}
              label={S.status.findMath}
              autoFocus={findMath.focus === "find"}
              clipboard={findClipboard}
              onTree={(query) => {
                setFindMath((f) => ({ ...f, query }));
                setFind((f) => ({ ...f, index: 0 }));
              }}
              onEnter={(backwards) => findStep(backwards ? -1 : 1)}
              onToggleMode={() => void toggleFindMode()}
            />
          ),
          replaceBox: (
            <FindMathBox
              key={`replace-${findMath.key}`}
              tree={findMath.replacement}
              label={S.status.replaceWithMath}
              autoFocus={findMath.focus === "replace"}
              clipboard={findClipboard}
              onTree={(replacement) => setFindMath((f) => ({ ...f, replacement }))}
              onEnter={() => void replaceOne()}
              onToggleMode={() => void toggleFindMode()}
            />
          ),
        }}
        onToggleCalc={actions.toggleCalcMode}
        onStop={() => void actions.stop()}
        onShowRunning={showRunningRegion}
        onZoom={actions.setZoom}
        onViewMode={actions.setViewMode}
        panel={{ open: panel.open, problems: problemCount, onToggle: () => changePanel({ open: !panel.open }) }}
      />
      {commandPalette && (
        <CommandPalette
          // only the commands that can act on what is in front.
          items={commandItems.filter((item) => commandApplies(item, {
            fileTab: activeProjectFile ? (activeProjectFile.kind === "image" ? "image" : "text") : null,
            project: project !== null,
            object: activeProjectFile ? null : ribbonContext({
              textEditing: textEditing !== null && textEditing.docId === active?.id,
              mathEditing: editing !== null && editing.docId === active?.id,
              inMatrix: editing !== null && matrixControls(editing.editor) !== null,
              matrixResult: matrixDisplay !== null,
              selection: active?.selection ?? [],
              regions: active?.view.regions ?? [],
              plotTraceSelections,
              mathRegionId: editing?.regionId ?? null,
            })?.kind ?? null,
            selectedKind: !activeProjectFile && active?.selection.length === 1
              ? active.view.regions.find((region) => region.id === active.selection[0])?.kind ?? null
              : null,
            mathEditing: !activeProjectFile && editing !== null && editing.docId === active?.id,
            inMatrix: !activeProjectFile && editing !== null && matrixControls(editing.editor) !== null,
          }))}
          onRun={runCommandItem}
          onClose={() => setCommandPalette(false)}
        />
      )}
      {fastMenu && editing && <FastSymbolicMenu {...fastMenu}
        entries={fastSymbolicContext(editing.editor).entries} options={fastOptions}
        onOptions={setFastOptions} onClose={closeFastMenu} onRun={runFastSymbolic} />}
      {insertSearch && (
        <CommandPalette
          items={insertionItems}
          anchor={insertSearch.anchor}
          onClose={() => closeInsertSearch(true)}
          onRun={(item) => {
            if (item.run.kind === "action") runPaletteAction(item.run.action);
            // a region insertion replaces the empty draft with its region at the crosshair.
            const region = item.run.kind === "window" && REGION_INSERTIONS.has(item.run.cmd);
            closeInsertSearch(region);
            if (item.run.kind === "window") void windowCommand(item.run.cmd);
          }}
        />
      )}
      {catalogue && (
        <FunctionCatalogue
          initialQuery={catalogue.query}
          help={catalogue.help}
          canInsert={active !== null}
          onInsert={(entry) => {
            setCatalogue(null);
            runPaletteAction({ kind: "text", text: entry.name });
          }}
          onClose={() => setCatalogue(null)}
        />
      )}
      <PaletteLayer controls={palettes} onRun={runPaletteAction} onEscape={focusWorksheet} />
      {formatDialog && active && (() => {
        const region =
          formatDialog.regionId === null ? undefined : active.view.regions.find((r) => r.id === formatDialog.regionId);
        const own = region?.kind === "math" ? region.format : undefined;
        // the built-in default, the worksheet default and the region override, key by key.
        const current = formatFromSettings({ ...active.view.settings, ...own });
        // Two levels, one dialog: a region override or the worksheet default.
        if (formatDialog.regionId === null) {
          return (
            <ResultFormatDialog
              initial={current}
              worksheet
              onApply={(format) => {
                setFormatDialog(null);
                void actions.setResultDefaults(formatDialog.docId, formatSettingEdits(formatFromSettings(format)));
              }}
              onReset={() => {
                setFormatDialog(null);
                void actions.setResultDefaults(formatDialog.docId, clearFormatSettings());
              }}
              onCancel={() => setFormatDialog(null)}
            />
          );
        }
        const regionId = formatDialog.regionId;
        return (
          <ResultFormatDialog
            initial={current}
            onApply={(format) => {
              setFormatDialog(null);
              // The dialog writes its `format.*` keys into the region's display override and
              // leaves what the override carries beside them alone — the result-table box.
              const next: Record<string, string> = { ...own, ...format };
              // No choice of nested arrays: the region follows the worksheet.
              if (next[EXPAND_NESTED_KEY] === "") delete next[EXPAND_NESTED_KEY];
              void actions.setResultFormat(formatDialog.docId, regionId, next);
            }}
            onReset={() => {
              setFormatDialog(null);
              // Reset removes the region's `format.*` keys and keeps the other display
              // settings the same override carries — the result-table box and the indices
              // choice of the Matrix tab, which the dialog does not set.
              const kept = Object.fromEntries(
                Object.entries(own ?? {}).filter(([key]) => !key.startsWith("format.") || key === SHOW_INDICES_KEY),
              );
              void actions.setResultFormat(
                formatDialog.docId,
                regionId,
                Object.keys(kept).length > 0 ? kept : null,
              );
            }}
            onCancel={() => setFormatDialog(null)}
          />
        );
      })()}
      {inlineDialog?.kind === "format" && active && (
        <ResultFormatDialog
          initial={formatFromSettings({ ...active.view.settings, ...inlineDialog.run.format })}
          onApply={(format) => {
            const run = inlineDialog.run;
            setInlineDialog(null);
            run.setFormat({ ...run.format, ...format });
          }}
          onReset={() => {
            const run = inlineDialog.run;
            setInlineDialog(null);
            const kept = Object.fromEntries(Object.entries(run.format).filter(([key]) => !key.startsWith("format.")));
            run.setFormat(Object.keys(kept).length > 0 ? kept : null);
          }}
          onCancel={() => setInlineDialog(null)}
        />
      )}
      {inlineDialog?.kind === "font" && (
        <MathFontDialog
          initial={mathFontOf(inlineDialog.run.format)}
          onApply={(font) => {
            const run = inlineDialog.run;
            setInlineDialog(null);
            run.setFormat(withMathFont(run.format, font));
          }}
          onReset={() => {
            const run = inlineDialog.run;
            setInlineDialog(null);
            const next = withoutMathFont(run.format);
            run.setFormat(next && Object.keys(next).length > 0 ? next : null);
          }}
          onCancel={() => setInlineDialog(null)}
        />
      )}
      {mathFontDialog && active && (() => {
        // the dialog shows the font of the first target region and Apply gives it to all.
        const targets = mathFontTargets(active, editing);
        const first = targets[0];
        if (!first) return null;
        return (
          <MathFontDialog
            initial={mathFontOf(first.format)}
            onApply={(font) => {
              setMathFontDialog(null);
              const edits = targets.map((region) => ({
                region_id: region.id,
                format: withMathFont(region.format, font),
              }));
              void actions.setMathFont(mathFontDialog, edits, false);
            }}
            onReset={() => {
              setMathFontDialog(null);
              const edits = targets.flatMap((region) =>
                hasMathFont(region.format) ? [{ region_id: region.id, format: withoutMathFont(region.format) }] : [],
              );
              if (edits.length > 0) void actions.setMathFont(mathFontDialog, edits, true);
            }}
            onCancel={() => setMathFontDialog(null)}
          />
        );
      })()}
      {calculationSettingsDialog && active && (
        <CalculationSettingsDialog
          initial={calculationSettingsOf(active.view.settings)}
          onApply={(values) => {
            setCalculationSettingsDialog(null);
            void actions.setCalculationSettings(calculationSettingsDialog, calculationSettingEdits(values));
          }}
          onReset={() => {
            setCalculationSettingsDialog(null);
            void actions.setCalculationSettings(calculationSettingsDialog, clearCalculationSettings());
          }}
          onCancel={() => setCalculationSettingsDialog(null)}
        />
      )}
      {spellingDialog && active && (
        <SpellingDialog
          worksheetLanguage={worksheetLanguage}
          regions={(() => {
            const texts = active.view.regions.filter((r) => r.kind === "text" && active.selection.includes(r.id));
            if (texts.length === 0) return null;
            const values = new Set(texts.map((r) => (r.kind === "text" ? r.language ?? null : null)));
            return { count: texts.length, language: values.size === 1 ? [...values][0] : undefined };
          })()}
          languages={() => backend.spellLanguages()}
          install={(language) => backend.spellInstall(language)}
          uninstall={(language) => backend.spellUninstall(language)}
          license={(language) => backend.spellLicense(language)}
          onInstalled={() => spellCache.clear()}
          onClose={() => setSpellingDialog(false)}
          onApply={async ({ worksheet, region }) => {
            setSpellingDialog(false);
            if (worksheet !== worksheetLanguage) {
              await actions.setSpelling(active.id, { "spelling.language": worksheet === "en_US" ? null : worksheet });
            }
            if (region !== undefined) {
              const ids = active.view.regions.filter((r) => r.kind === "text" && active.selection.includes(r.id)).map((r) => r.id);
              await actions.setTextLanguage(ids, region);
            }
          }}
        />
      )}
      {labelStylesDialog && active && (
        <LabelStylesDialog
          initial={labelStylesOf(active.view.settings)}
          onApply={(styles) => {
            setLabelStylesDialog(null);
            // every style the dialog shows goes in one undo step, a default value as no key.
            void actions.setLabelStyles(labelStylesDialog, labelStyleEdits(styles));
          }}
          onReset={(kind) => {
            setLabelStylesDialog(null);
            // the four keys of the selected style go, no other style is touched.
            void actions.setLabelStyles(labelStylesDialog, clearLabelStyle(kind));
          }}
          onCancel={() => setLabelStylesDialog(null)}
        />
      )}
      {matrixDialog && (
        <MatrixDialog
          onInsert={(rows, cols) => {
            setMatrixDialog(false);
            // also on the empty crosshair: the matrix starts a new region there
            void updateFromRibbon((editor) => insertMatrixSized(editor, rows, cols));
          }}
          onCancel={() => setMatrixDialog(false)}
        />
      )}
      {pageSetupDialog && active && (
        <PageSetupDialog
          initial={active.view.page}
          focus={pageSetupDialog}
          onApply={(page) => {
            setPageSetupDialog(false);
            void actions.setPageSetup(active.id, page);
          }}
          onCancel={() => setPageSetupDialog(false)}
        />
      )}
      {optionsDialog && (
        <OptionsDialog
          initial={settings}
          onApply={(next) => {
            setOptionsDialog(false);
            void actions.setSettings(next);
          }}
          onCancel={() => setOptionsDialog(false)}
        />
      )}
      {shortcutSheetDialog && (
        <ShortcutSheetDialog onClose={() => setShortcutSheetDialog(false)} />
      )}
      {importReportDialog && (
        <ImportReportDialog report={actions.lastImportReport()} onClose={() => setImportReportDialog(false)} />
      )}
      {state.prompt && <PromptDialog prompt={state.prompt} onAnswer={actions.answer} />}
    </div>
  );
}
