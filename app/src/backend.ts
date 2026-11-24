// The backend the UI talks to: the real Tauri commands, or an in-browser mock
// (`mock/mockBackend.ts`) so the whole UI can be developed and checked in a plain browser
// with `pnpm --dir app dev`.
//
// Selection: inside the Tauri webview the real backend is used; in a normal browser the
// mock. `?backend=mock` forces the mock (also in the Tauri webview), `?backend=real` forces
// the real one. The chosen mode is shown in the status bar.

import type { UnlistenFn } from "@tauri-apps/api/event";
import type { PlotFrame } from "./plot/frame";
import type { AppSettings } from "./settings";
import { applyEditDelta, stateFromOpened, stateFromSnapshot, type WorksheetState } from "./editDelta";
import {
  onKernelStatus,
  onKernelActivity,
  onOpenRequest,
  onFileDrop,
  onWorksheetEvent,
  equavelaApi,
  type DefinitionValue,
  type DocumentView,
  type ExportedPdf,
  type ImportedWorksheet,
  type Inspection,
  type EditResult,
  type EditResultDelta,
  type ImageAdded,
  type ImageAddedDelta,
  type KernelStatus,
  type NewRegionKind,
  type OpenedWorksheet,
  type OpenedProject,
  type NewItemKind,
  type ProjectChange,
  type ProjectManifest,
  type ProjectReferences,
  type ReferenceCommand,
  type ReferencesChangeDelta,
  type ReplResult,
  type TerminalSnapshot,
  type ProjectTextFile,
  type ProjectImageUsage,
  type ProjectTextSaved,
  type EnvironmentInfo,
  type EnvironmentSwitchPreview,
  type EnvironmentMetadataFile,
  type EnvironmentOperation,
  type KernelStatusEvent,
  type KernelActivityEvent,
  type PageSetup,
  type PlotSpec,
  type RecoveryInfo,
  type ProjectTextRecovery,
  type ProjectTextRecoveryListing,
  type RegionEntry,
  type MathBreak,
  type MathFontEdit,
  type AreaHeight,
  type RegionMove,
  type RegionRewrite,
  type RichText,
  type SavedWorksheet,
  type WarningInfo,
  type WorksheetEvent,
  type SpellCheck,
  type SpellLanguage,
  type KernelValue,
  type RegionKey,
} from "./equavelaApi";

/** A reference or export command's result, with whole edit results. */
export type ReferencesChange = { manifest: ProjectManifest; worksheets: { id: string; result: EditResult }[] };

export type BackendMode = "tauri" | "mock";

export interface Backend {
  readonly mode: BackendMode;
  coreVersion(): Promise<string>;
  kernelStatus(): Promise<KernelStatus>;
  startKernel(): Promise<void>;
  openWorksheet(path: string): Promise<OpenedWorksheet>;
  newWorksheet(): Promise<OpenedWorksheet>;
  newProject(destination: string, name: string, projectId: string, worksheetId: string): Promise<OpenedProject>;
  openProject(root: string): Promise<OpenedProject>;
  /** the project explorer; a result's sessions replace or close the listed ones. */
  projectTree(root: string): Promise<ProjectChange>;
  projectCreate(root: string, folder: string, name: string, kind: NewItemKind): Promise<ProjectChange>;
  projectRename(root: string, path: string, name: string): Promise<ProjectChange>;
  projectMove(root: string, path: string, folder: string): Promise<ProjectChange>;
  projectMoveMany(root: string, paths: string[], folder: string): Promise<ProjectChange>;
  projectDelete(root: string, path: string): Promise<ProjectChange>;
  projectDeleteMany(root: string, paths: string[]): Promise<ProjectChange>;
  projectImport(root: string, folder: string, sources?: string[]): Promise<ProjectChange | null>;
  projectReveal(root: string, path: string): Promise<void>;
  /** files of the tree in text and image tabs, or in the system's app. */
  projectReadText(root: string, path: string): Promise<ProjectTextFile>;
  projectImageUsage(root: string): Promise<ProjectImageUsage[]>;
  projectWriteText(root: string, path: string, text: string, version: string): Promise<ProjectTextSaved>;
  projectImage(root: string, path: string): Promise<string>;
  projectOpenExternal(root: string, path: string): Promise<void>;
  /** the specification: exports and references of a project. */
  projectReferences(root: string): Promise<ProjectReferences>;
  /** shows an open document's file in the system file manager. */
  revealFile(path: string): Promise<void>;
  /** the REPL of a worksheet's environment. */
  /** the REPL of the project at `project`, or of the generic environment (`null`). */
  terminalOpen(project: string | null, cols: number, rows: number): Promise<TerminalSnapshot>;
  terminalRead(project: string | null, after: number): Promise<TerminalSnapshot>;
  terminalWrite(project: string | null, data: string): Promise<void>;
  terminalResize(project: string | null, cols: number, rows: number): Promise<void>;
  replEval(project: string | null, code: string, reset?: boolean): Promise<ReplResult>;
  replInterrupt(project: string | null): Promise<boolean>;
  /** restarts the kernel the REPL runs in; resolves to that kernel's key. */
  replRestart(project: string | null): Promise<string>;
  /** the module name of every open worksheet, by worksheet id. */
  worksheetModuleNames(): Promise<Record<string, string>>;
  /** completions in the REPL module of a worksheet's environment (positions in characters). */
  replComplete(project: string | null, text: string, position: number): Promise<{ items: string[]; from: number; to: number }>;
  /** Julia's completions from a worksheet's running kernel; rejects when it cannot answer. */
  completeCode(worksheet: string, text: string, position: number): Promise<{ items: string[]; from: number; to: number }>;
  /** the native folder dialog of the project dialogs; `null` when cancelled. */
  chooseFolder(title: string, start?: string): Promise<string | null>;
  /** Load in worksheets for a project `.jl` file. */
  projectSetJuliaModule(root: string, path: string, loaded: boolean): Promise<ReferencesChange>;
  projectSetExport(root: string, path: string, region: string, exported: boolean): Promise<ReferencesChange>;
  projectAddReference(root: string, folder?: string, alias?: string): Promise<ReferencesChange | null>;
  projectReferenceCommand(root: string, command: ReferenceCommand, alias?: string, value?: string): Promise<ReferencesChange>;
  /** Convert to project; the worksheet's session is replaced by the project's. */
  convertToProject(worksheet: string, destination: string, name: string, projectId: string, worksheetId: string): Promise<OpenedProject>;
  /** The image files of the project's `assets/images/`. */
  listProjectAssets(root: string): Promise<string[]>;
  /** Packs the project into a new `.eqvz`; the Save dialog asks when `destination` is omitted. `null`: cancelled. */
  packProjectArchive(root: string, destination?: string): Promise<string | null>;
  /** Extracts a project `.eqvz` into a new folder; dialogs ask for missing paths. The root, or `null`: cancelled. */
  extractProjectArchive(source?: string, destination?: string): Promise<string | null>;
  /** The worksheet's Julia environment, its files and its kernel. */
  environmentInfo(worksheet: string): Promise<EnvironmentInfo>;
  /** Reads a Project.toml or Manifest.toml from the currently selected environment. */
  readEnvironmentMetadata(worksheet: string, file: EnvironmentMetadataFile): Promise<string>;
  /** Sets (a directory) or removes (`null`) a standalone worksheet's environment. */
  setWorksheetEnvironment(worksheet: string, environment: string | null): Promise<EditResult>;
  /** Copies environment metadata to a new directory and selects it for the standalone worksheet. */
  copyEnvironment(worksheet: string, destination: string): Promise<EditResult>;
  /** The native folder chooser, then that folder as the worksheet's environment; `null` when cancelled. */
  chooseWorksheetEnvironment(worksheet: string): Promise<EditResult | null>;
  /** Previews an environment switch; choosing a directory may be cancelled. */
  previewEnvironmentSwitch(worksheet: string, target: string | null): Promise<EnvironmentSwitchPreview>;
  chooseEnvironmentSwitch(worksheet: string): Promise<EnvironmentSwitchPreview | null>;
  commitEnvironmentSwitch(worksheet: string, token: string): Promise<EditResult>;
  /** Adds (`remove` false) or removes packages in the worksheet's environment. */
  changePackages(worksheet: string, packages: string[], remove: boolean): Promise<EnvironmentInfo>;
  /** develops a referenced project's Julia package into the worksheet's environment. */
  developReferencePackage(worksheet: string, alias: string): Promise<EnvironmentInfo>;
  /** Instantiates, resolves or updates the worksheet's Julia environment. */
  manageEnvironment(worksheet: string, operation: EnvironmentOperation): Promise<EnvironmentInfo>;
  /** Restarts the kernel of the worksheet's environment. */
  restartEnvironmentKernel(worksheet: string): Promise<EnvironmentInfo>;
  /** Undoes the last package change or settles an interrupted one. */
  revertEnvironmentChange(worksheet: string, interrupted: boolean, restore: boolean): Promise<EnvironmentInfo>;
  /** Sets or clears a direct package's Julia Pkg compatibility bound. */
  setCompatibility(worksheet: string, packageName: string, compatibility: string): Promise<EnvironmentInfo>;
  /** Saves to the worksheet's own file (error kind `untitled`: use `saveWorksheetAs`). */
  saveWorksheet(worksheet: string): Promise<SavedWorksheet>;
  /** Save As (native dialog when `path` is omitted); `null` when cancelled. */
  saveWorksheetAs(worksheet: string, path?: string, suggested?: string): Promise<SavedWorksheet | null>;
  /** The application settings: defaults when nothing is stored. */
  getSettings(): Promise<AppSettings>;
  /** Stores the settings durably; resolves with what was stored (validated). */
  setSettings(settings: AppSettings): Promise<AppSettings>;
  /** Open: the native file dialog (multi-select); the paths chosen, empty when cancelled. `worksheet` sets the start folder. */
  chooseOpenPaths(worksheet?: string, importMode?: boolean): Promise<string[]>;
  /** Imports a reference application `.mcdx` or `.xmcd` as a new untitled worksheet; the file is only read. */
  importMcdx(path: string): Promise<ImportedWorksheet>;
  /** Insert include: asks for a worksheet (native Open dialog); the path to store, `null` when cancelled. */
  chooseIncludePath(worksheet?: string): Promise<string | null>;
  /** Insert image: asks for a file (native Open dialog); `null` when cancelled. */
  chooseImagePath(worksheet?: string): Promise<string | null>;
  addImage(worksheet: string, path: string, page: number, x: number, y: number): Promise<ImageAdded>;
  /** From the base64 content of a file (paste and drop). */
  addImageData(worksheet: string, data: string, page: number, x: number, y: number): Promise<ImageAdded>;
  setImageSize(worksheet: string, regionId: string, width: number, height: number): Promise<EditResult>;
  /** Sets the size of an image region back to the size of its picture; one undo step. */
  originalImageSize(worksheet: string, regionId: string): Promise<EditResult>;
  /** Replaces the picture of an image region with a file, keeping its position. */
  replaceImage(worksheet: string, regionId: string, path: string): Promise<ImageAdded>;
  /** Sets the title, height (points) and collapsed flag of an area region; one undo step. */
  setArea(worksheet: string, regionId: string, title: string, height: number, collapsed: boolean): Promise<EditResult>;
  /** Disables regions (they are no longer calculated) or enables them again; one undo step. */
  setRegionsEnabled(worksheet: string, regionIds: string[], enabled: boolean): Promise<EditResult>;
  /** An image resource as a data URL. */
  imageData(worksheet: string, resource: string): Promise<string>;
  /** Export PDF: asks where to write the file (native Save dialog); `null` when cancelled. */
  choosePdfPath(worksheet: string, suggested?: string): Promise<string | null>;
  /** Prints the print view to `path`; each page is exactly the page setup's size (points). */
  exportPdf(path: string, widthPt: number, heightPt: number): Promise<ExportedPdf>;
  /** Puts text, a PNG (base64) and an SVG on the system clipboard natively; Linux only. */
  writeClipboardPicture(text: string, png: string, svg: string | null): Promise<void>;
  /** Autosave: writes the recovery file; `null` when nothing was written (retry later). */
  writeRecovery(worksheet: string): Promise<string | null>;
  writeProjectTextRecovery(root: string, path: string, text: string, saved: string, version: string): Promise<void>;
  projectTextRecoveryFor(root: string, path: string): Promise<ProjectTextRecovery | null>;
  discardProjectTextRecovery(root: string, path: string): Promise<void>;
  listProjectTextRecoveries(): Promise<ProjectTextRecoveryListing>;
  readProjectTextRecovery(id: string): Promise<ProjectTextRecovery>;
  exportProjectTextRecovery(id: string): Promise<string | null>;
  discardProjectTextRecoveryEntry(id: string): Promise<void>;
  /** The recovery file of a worksheet file when it is newer than the file. */
  recoveryFor(path: string): Promise<RecoveryInfo | null>;
  discardRecoveryFile(path: string): Promise<void>;
  /** Recovery files of worksheets without a file from a previous run. */
  pendingRecoveries(): Promise<string[]>;
  /** Opens a recovery file as the worksheet `original`, or as a new untitled one. */
  openRecovery(recovery: string, original?: string): Promise<OpenedWorksheet>;
  /** A worksheet to open at start-up (command line argument, or the mock demo). */
  initialWorksheet(): Promise<string | null>;
  /** Files other launches asked this instance to open; drains the queue. */
  takeOpenRequests(): Promise<string[]>;
  /** A second launch queued files: call `takeOpenRequests`. */
  onOpenRequest(handler: () => void): Promise<UnlistenFn>;
  /** Files dropped onto the window (native drag and drop: paths and the drop point in CSS px). */
  onFileDrop(handler: (paths: string[], position: { x: number; y: number }) => void): Promise<UnlistenFn>;
  closeWorksheet(worksheet: string): Promise<void>;
  recalculate(worksheet: string, all: boolean): Promise<void>;
  interrupt(worksheet: string): Promise<boolean>;
  getResults(worksheet: string): Promise<RegionEntry[]>;
  /** A block of a large matrix result, column-major. */
  resultBlock(worksheet: string, key: RegionKey, row: number, col: number, rows: number, cols: number): Promise<KernelValue[]>;
  getView(worksheet: string): Promise<DocumentView>;
  addRegion(
    worksheet: string,
    kind: NewRegionKind,
    page: number,
    x: number,
    y: number,
    text?: string,
    plotSize?: [number, number],
  ): Promise<EditResult>;
  fastSymbolic(worksheet: string, input: import("./editor/fastSymbolic").FastSymbolicInput): Promise<unknown>;
  addMathRegion(worksheet: string, page: number, x: number, y: number, statement: unknown, breaks?: MathBreak[]): Promise<EditResult>;
  setMath(worksheet: string, regionId: string, statement: unknown, breaks?: MathBreak[]): Promise<EditResult>;
  /** `fullWidth`: a text block from margin to margin (Ctrl+Shift+T). */
  addTextRegion(worksheet: string, page: number, x: number, y: number, paragraphs: RichText, fullWidth?: boolean): Promise<EditResult>;
  setText(worksheet: string, regionId: string, paragraphs: RichText): Promise<EditResult>;
  /** Several regions rewritten in one undo step (Replace All). */
  replaceRegions(worksheet: string, rewrites: RegionRewrite[]): Promise<EditResult>;
  printMath(statement: unknown): Promise<string>;
  parseMath(text: string): Promise<unknown>;
  /** The canonical text of a list of call arguments. */
  printMathArgs(args: unknown[]): Promise<string>;
  parseMathArgs(text: string): Promise<unknown[]>;
  pasteRegions(worksheet: string, page: number, x: number, y: number, snippet: string): Promise<EditResult>;
  /** Moves regions; `areaHeights` resizes an area band in the same undo step. */
  moveRegions(worksheet: string, moves: RegionMove[], areaHeights?: AreaHeight[]): Promise<EditResult>;
  /**
   * Ends the page at `y` and moves the content below the caret line onto the next page
   * ; one undo step for the break and the moves together.
   */
  addPageBreak(worksheet: string, page: number, y: number, moves: RegionMove[]): Promise<EditResult>;
  /** Removes the break of `page` and moves the content at or after it back up; one undo step. */
  removePageBreak(worksheet: string, page: number, moves: RegionMove[]): Promise<EditResult>;
  inspect(worksheet: string): Promise<Inspection>;
  /** The unit warnings of `inspect` alone: what the sheet underlines and the Problems count lists. */
  inspectWarnings(worksheet: string): Promise<WarningInfo[]>;
  definitionValues(worksheet: string, items: { name: string; version: number }[]): Promise<DefinitionValue[]>;
  setRegionWidth(worksheet: string, regionId: string, width: number | null): Promise<EditResult>;
  /** Sets (or clears) the fill of a text region as #rrggbb. */
  setTextBackground(worksheet: string, regionId: string, background: string | null): Promise<EditResult>;
  /** Sets (or clears) the spelling language of a text region. */
  setTextLanguage(worksheet: string, regionId: string, language: string | null): Promise<EditResult>;
  /** Sets (or with `null` removes) the worksheet spelling keys `spelling.language`, `spelling.ignore`. */
  setSpelling(worksheet: string, values: Record<string, string | null>): Promise<EditResult>;
  /** The spelling dictionaries. */
  spellLanguages(): Promise<SpellLanguage[]>;
  spellCheck(language: string, words: string[]): Promise<SpellCheck>;
  spellSuggest(language: string, word: string): Promise<string[]>;
  spellAddWord(word: string): Promise<void>;
  spellLicense(language: string): Promise<string | null>;
  spellInstall(language: string): Promise<void>;
  spellUninstall(language: string): Promise<void>;
  /** Sets (or with `null`s clears) the box of a Julia block; one undo step. */
  setJuliaSize(worksheet: string, regionId: string, width: number | null, height: number | null): Promise<EditResult>;
  /** Replaces the page setup; one undo step. */
  setPageSetup(worksheet: string, page: PageSetup): Promise<EditResult>;
  /** Result-format override of a math region; `null` or an empty map clears it. */
  setResultFormat(worksheet: string, regionId: string, format: Record<string, string> | null): Promise<EditResult>;
  setNumericOptions(worksheet: string, regionId: string, options: Record<string, string> | null): Promise<EditResult>;
  /**
   * The math font of the given math regions: each region and the
   * display override it should have afterwards. One undo step for the whole command.
   */
  setMathFont(worksheet: string, edits: MathFontEdit[], reset: boolean): Promise<EditResult>;
  /**
   * Worksheet-wide result-format defaults: `format.*` keys of the
   * worksheet `settings:`, a key set to `null` removed. One undo step; display only.
   */
  setResultDefaults(worksheet: string, values: Record<string, string | null>): Promise<EditResult>;
  /**
   * Worksheet-wide label styles: `label-style.*` keys of the
   * worksheet `settings:`, a key set to `null` removed. One undo step; display only.
   */
  setLabelStyles(worksheet: string, values: Record<string, string | null>): Promise<EditResult>;
  /** Julia blocks. */
  setJuliaCode(worksheet: string, regionId: string, code: string): Promise<EditResult>;
  setJuliaPlaying(worksheet: string, regionId: string, playing: boolean): Promise<EditResult>;
  /** evaluates a Julia block and its dependents again on the next pass. */
  runRegion(worksheet: string, regionId: string): Promise<EditResult>;
  /** Trusts a worksheet or takes the trust back. */
  setWorksheetTrusted(worksheet: string, trusted: boolean): Promise<EditResult>;
  /**
   * Worksheet calculation settings: the tolerances `TOL` and `CTOL`
   * of the worksheet `settings:`, a key set to `null` removed. One undo step, and every result
   * becomes out of date: the worksheet is recalculated.
   */
  setCalculationSettings(worksheet: string, values: Record<string, string | null>): Promise<EditResult>;
  /** The calculated data of a plot region (binary frame, decoded). */
  plotData(worksheet: string, regionId: string): Promise<PlotFrame>;
  setPlot(worksheet: string, regionId: string, plot: PlotSpec): Promise<EditResult>;
  /** Replaces the path of an include region with the typed text; the new target is read. */
  setIncludePath(worksheet: string, regionId: string, path: string): Promise<EditResult>;
  /**
   * The x range an XY plot is showing on screen, which resamples its implicit x trace
   * ; `null` ends are reset-to-data-range. Screen-only: not an undo step and not
   * a change to the worksheet. `true` when the range moved.
   */
  setPlotView(worksheet: string, regionId: string, xMin: number | null, xMax: number | null): Promise<boolean>;
  removeRegions(worksheet: string, regionIds: string[]): Promise<EditResult>;
  undo(worksheet: string): Promise<EditResult>;
  redo(worksheet: string): Promise<EditResult>;
  onKernelStatus(handler: (status: KernelStatusEvent) => void): Promise<UnlistenFn>;
  /** Slow, one-time kernel work (installing, compiling, preparing the symbolic engine). */
  onKernelActivity?(handler: (activity: KernelActivityEvent) => void): Promise<UnlistenFn>;
  onWorksheetEvent(handler: (event: WorksheetEvent) => void): Promise<UnlistenFn>;
}

/**
 * The whole state of every open worksheet, with the revision it is. An edit command sends
 * only the differences (see `EditResultDelta`); this applies them to the state it keeps and hands
 * the UI the whole `EditResult` it has always used, with the objects of everything that did not
 * change. A delta whose `base` is not the stored revision cannot be applied: the whole state is
 * fetched with `worksheetSnapshot` instead, at the revision the backend is at now.
 */
class WorksheetStates {
  private readonly states = new Map<string, WorksheetState>();
  /** One running application per worksheet, so deltas are not applied out of order. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Remembers the whole state a command that opens a worksheet just returned. */
  opened<T extends OpenedWorksheet>(opened: T): T {
    this.states.set(opened.id, stateFromOpened(opened));
    return opened;
  }

  /** Drops what is known of a worksheet that was closed (its id is not used again). */
  forget(worksheet: string): void {
    this.states.delete(worksheet);
    this.queues.delete(worksheet);
  }

  /** The whole edit result a delta stands for. */
  apply(worksheet: string, delta: EditResultDelta): Promise<EditResult> {
    const previous = this.queues.get(worksheet) ?? Promise.resolve();
    const next = previous.then(() => this.applyNow(worksheet, delta));
    // A failed edit must not stop the ones after it.
    this.queues.set(
      worksheet,
      next.catch(() => undefined),
    );
    return next;
  }

  private async applyNow(worksheet: string, delta: EditResultDelta): Promise<EditResult> {
    const state = this.states.get(worksheet);
    if (state && delta.base === state.revision) {
      try {
        const rebuilt = applyEditDelta(state, delta);
        this.states.set(worksheet, rebuilt.state);
        return delta.environment ? { ...rebuilt.result, environment: delta.environment } : rebuilt.result;
      } catch {
        // The delta does not fit what we hold; the whole state below is the answer (and is
        // already past this edit: the backend applied it before sending the delta).
      }
    }
    const snapshot = await equavelaApi.worksheetSnapshot(worksheet);
    this.states.set(worksheet, stateFromSnapshot(snapshot));
    return {
      view: snapshot.view,
      regions: snapshot.regions,
      created: delta.created,
      calc_needed: delta.calc_needed,
      label: delta.label,
      ...(delta.environment ? { environment: delta.environment } : {}),
    };
  }
}

export function createTauriBackend(): Backend {
  const states = new WorksheetStates();
  /** Each open project worksheet's delta becomes the whole edit result it stands for. */
  const referencesChange = async (change: ReferencesChangeDelta): Promise<ReferencesChange> => ({
    manifest: change.manifest,
    worksheets: await Promise.all(change.worksheets.map(async ({ id, delta }) => ({ id, result: await states.apply(id, delta) }))),
  });
  /** The sessions a project command opened are tracked; the ones it replaced are forgotten. */
  const projectChange = (change: ProjectChange): ProjectChange => {
    for (const { id } of change.replaced) states.forget(id);
    for (const id of change.closed) states.forget(id);
    return {
      ...change,
      opened: change.opened && states.opened(change.opened),
      replaced: change.replaced.map(({ id, opened }) => ({ id, opened: states.opened(opened) })),
    };
  };
  const edit = async (worksheet: string, delta: Promise<EditResultDelta>) =>
    states.apply(worksheet, await delta);
  const image = async (worksheet: string, added: Promise<ImageAddedDelta>) => {
    const delta = await added;
    return { ...(await states.apply(worksheet, delta)), removed_parts: delta.removed_parts };
  };
  return {
    mode: "tauri",
    coreVersion: equavelaApi.coreVersion,
    kernelStatus: equavelaApi.kernelStatus,
    startKernel: equavelaApi.startKernel,
    openWorksheet: async (path) => states.opened(await equavelaApi.openWorksheet(path)),
    newWorksheet: async () => states.opened(await equavelaApi.newWorksheet()),
    newProject: async (destination, name, projectId, worksheetId) => {
      const project = await equavelaApi.newProject(destination, name, projectId, worksheetId);
      return { ...project, worksheet: project.worksheet ? states.opened(project.worksheet) : null };
    },
    openProject: async (root) => {
      const project = await equavelaApi.openProject(root);
      return { ...project, worksheet: project.worksheet ? states.opened(project.worksheet) : null };
    },
    projectTree: async (root) => projectChange(await equavelaApi.projectTree(root)),
    projectCreate: async (root, folder, name, kind) => projectChange(await equavelaApi.projectCreate(root, folder, name, kind)),
    projectRename: async (root, path, name) => projectChange(await equavelaApi.projectRename(root, path, name)),
    projectMove: async (root, path, folder) => projectChange(await equavelaApi.projectMove(root, path, folder)),
    projectMoveMany: async (root, paths, folder) => projectChange(await equavelaApi.projectMoveMany(root, paths, folder)),
    projectDelete: async (root, path) => projectChange(await equavelaApi.projectDelete(root, path)),
    projectDeleteMany: async (root, paths) => projectChange(await equavelaApi.projectDeleteMany(root, paths)),
    projectImport: async (root, folder, sources) => {
      const change = await equavelaApi.projectImport(root, folder, sources);
      return change && projectChange(change);
    },
    projectReveal: equavelaApi.projectReveal,
    projectReadText: equavelaApi.projectReadText,
    projectImageUsage: equavelaApi.projectImageUsage,
    projectWriteText: equavelaApi.projectWriteText,
    projectImage: equavelaApi.projectImage,
    projectOpenExternal: equavelaApi.projectOpenExternal,
    chooseFolder: equavelaApi.chooseFolder,
    revealFile: equavelaApi.revealFile,
    completeCode: equavelaApi.completeCode,
    terminalOpen: equavelaApi.terminalOpen,
    terminalRead: equavelaApi.terminalRead,
    terminalWrite: equavelaApi.terminalWrite,
    terminalResize: equavelaApi.terminalResize,
    replEval: equavelaApi.replEval,
    replInterrupt: equavelaApi.replInterrupt,
    replRestart: equavelaApi.replRestart,
    worksheetModuleNames: equavelaApi.worksheetModuleNames,
    replComplete: equavelaApi.replComplete,
    projectReferences: equavelaApi.projectReferences,
    projectSetJuliaModule: async (root, path, loaded) =>
      referencesChange(await equavelaApi.projectSetJuliaModule(root, path, loaded)),
    projectSetExport: async (root, path, region, exported) =>
      referencesChange(await equavelaApi.projectSetExport(root, path, region, exported)),
    projectAddReference: async (root, folder, alias) => {
      const change = await equavelaApi.projectAddReference(root, folder, alias);
      return change && referencesChange(change);
    },
    projectReferenceCommand: async (root, command, alias, value) =>
      referencesChange(await equavelaApi.projectReferenceCommand(root, command, alias, value)),
    convertToProject: async (worksheet, destination, name, projectId, worksheetId) => {
      const project = await equavelaApi.convertToProject(worksheet, destination, name, projectId, worksheetId);
      states.forget(worksheet);
      return { ...project, worksheet: project.worksheet ? states.opened(project.worksheet) : null };
    },
    listProjectAssets: equavelaApi.listProjectAssets,
    packProjectArchive: equavelaApi.packProjectArchive,
    extractProjectArchive: equavelaApi.extractProjectArchive,
    environmentInfo: equavelaApi.environmentInfo,
    readEnvironmentMetadata: equavelaApi.readEnvironmentMetadata,
    setWorksheetEnvironment: (worksheet, environment) => edit(worksheet, equavelaApi.setWorksheetEnvironment(worksheet, environment)),
    copyEnvironment: (worksheet, destination) => edit(worksheet, equavelaApi.copyEnvironment(worksheet, destination)),
    chooseWorksheetEnvironment: async (worksheet) => {
      const delta = await equavelaApi.chooseWorksheetEnvironment(worksheet);
      return delta ? states.apply(worksheet, delta) : null;
    },
    previewEnvironmentSwitch: equavelaApi.previewEnvironmentSwitch,
    chooseEnvironmentSwitch: equavelaApi.chooseEnvironmentSwitch,
    commitEnvironmentSwitch: (worksheet, token) => edit(worksheet, equavelaApi.commitEnvironmentSwitch(worksheet, token)),
    changePackages: equavelaApi.changePackages,
    developReferencePackage: equavelaApi.developReferencePackage,
    manageEnvironment: equavelaApi.manageEnvironment,
    revertEnvironmentChange: equavelaApi.revertEnvironmentChange,
    restartEnvironmentKernel: equavelaApi.restartEnvironmentKernel,
    setCompatibility: equavelaApi.setCompatibility,
    saveWorksheet: equavelaApi.saveWorksheet,
    saveWorksheetAs: async (worksheet, path, suggested) => {
      const saved = await equavelaApi.saveWorksheetAs(worksheet, path, suggested);
      if (saved?.opened) {
        // Save As re-opens the worksheet at the new file, under a new id.
        states.forget(worksheet);
        states.opened(saved.opened);
      }
      return saved;
    },
    chooseOpenPaths: equavelaApi.chooseOpenPaths,
    importMcdx: async (path) => {
      const imported = await equavelaApi.importMcdx(path);
      states.opened(imported.opened);
      return imported;
    },
    chooseIncludePath: equavelaApi.chooseIncludePath,
    chooseImagePath: equavelaApi.chooseImagePath,
    addImage: (worksheet, path, page, x, y) =>
      image(worksheet, equavelaApi.addImage(worksheet, path, page, x, y)),
    addImageData: (worksheet, data, page, x, y) =>
      image(worksheet, equavelaApi.addImageData(worksheet, data, page, x, y)),
    setImageSize: (worksheet, regionId, width, height) =>
      edit(worksheet, equavelaApi.setImageSize(worksheet, regionId, width, height)),
    originalImageSize: (worksheet, regionId) =>
      edit(worksheet, equavelaApi.originalImageSize(worksheet, regionId)),
    replaceImage: (worksheet, regionId, path) =>
      image(worksheet, equavelaApi.replaceImage(worksheet, regionId, path)),
    imageData: equavelaApi.imageData,
    setArea: (worksheet, regionId, title, height, collapsed) =>
      edit(worksheet, equavelaApi.setArea(worksheet, regionId, title, height, collapsed)),
    setRegionsEnabled: (worksheet, regionIds, enabled) =>
      edit(worksheet, equavelaApi.setRegionsEnabled(worksheet, regionIds, enabled)),
    choosePdfPath: equavelaApi.choosePdfPath,
    exportPdf: equavelaApi.exportPdf,
    writeClipboardPicture: equavelaApi.writeClipboardPicture,
    getSettings: equavelaApi.getSettings,
    setSettings: equavelaApi.setSettings,
    writeRecovery: equavelaApi.writeRecovery,
    writeProjectTextRecovery: equavelaApi.writeProjectTextRecovery,
    projectTextRecoveryFor: equavelaApi.projectTextRecoveryFor,
    discardProjectTextRecovery: equavelaApi.discardProjectTextRecovery,
    listProjectTextRecoveries: equavelaApi.listProjectTextRecoveries,
    readProjectTextRecovery: equavelaApi.readProjectTextRecovery,
    exportProjectTextRecovery: equavelaApi.exportProjectTextRecovery,
    discardProjectTextRecoveryEntry: equavelaApi.discardProjectTextRecoveryEntry,
    recoveryFor: equavelaApi.recoveryFor,
    discardRecoveryFile: equavelaApi.discardRecoveryFile,
    pendingRecoveries: equavelaApi.pendingRecoveries,
    openRecovery: async (recovery, original) =>
      states.opened(await equavelaApi.openRecovery(recovery, original)),
    initialWorksheet: equavelaApi.initialWorksheet,
    takeOpenRequests: equavelaApi.takeOpenRequests,
    onOpenRequest,
    onFileDrop,
    closeWorksheet: async (worksheet) => {
      states.forget(worksheet);
      return equavelaApi.closeWorksheet(worksheet);
    },
    recalculate: equavelaApi.recalculate,
    interrupt: equavelaApi.interrupt,
    getResults: equavelaApi.getResults,
    resultBlock: equavelaApi.resultBlock,
    getView: equavelaApi.getView,
    addRegion: (worksheet, kind, page, x, y, text, plotSize) =>
      edit(worksheet, plotSize
        ? equavelaApi.addRegion(worksheet, kind, page, x, y, text, plotSize)
        : equavelaApi.addRegion(worksheet, kind, page, x, y, text)),
    fastSymbolic: equavelaApi.fastSymbolic,
    addMathRegion: (worksheet, page, x, y, statement, breaks) =>
      edit(worksheet, equavelaApi.addMathRegion(worksheet, page, x, y, statement, breaks)),
    setMath: (worksheet, regionId, statement, breaks) =>
      edit(worksheet, equavelaApi.setMath(worksheet, regionId, statement, breaks)),
    addTextRegion: (worksheet, page, x, y, paragraphs, fullWidth) =>
      edit(worksheet, equavelaApi.addTextRegion(worksheet, page, x, y, paragraphs, fullWidth)),
    setText: (worksheet, regionId, paragraphs) =>
      edit(worksheet, equavelaApi.setText(worksheet, regionId, paragraphs)),
    replaceRegions: (worksheet, rewrites) => edit(worksheet, equavelaApi.replaceRegions(worksheet, rewrites)),
    printMath: equavelaApi.printMath,
    parseMath: equavelaApi.parseMath,
    printMathArgs: equavelaApi.printMathArgs,
    parseMathArgs: equavelaApi.parseMathArgs,
    pasteRegions: (worksheet, page, x, y, snippet) =>
      edit(worksheet, equavelaApi.pasteRegions(worksheet, page, x, y, snippet)),
    moveRegions: (worksheet, moves, areaHeights) =>
      edit(worksheet, equavelaApi.moveRegions(worksheet, moves, areaHeights)),
    addPageBreak: (worksheet, page, y, moves) =>
      edit(worksheet, equavelaApi.addPageBreak(worksheet, page, y, moves)),
    removePageBreak: (worksheet, page, moves) =>
      edit(worksheet, equavelaApi.removePageBreak(worksheet, page, moves)),
    inspect: equavelaApi.inspect,
    inspectWarnings: equavelaApi.inspectWarnings,
    definitionValues: equavelaApi.definitionValues,
    setRegionWidth: (worksheet, regionId, width) =>
      edit(worksheet, equavelaApi.setRegionWidth(worksheet, regionId, width)),
    setTextBackground: (worksheet, regionId, background) =>
      edit(worksheet, equavelaApi.setTextBackground(worksheet, regionId, background)),
    setTextLanguage: (worksheet, regionId, language) =>
      edit(worksheet, equavelaApi.setTextLanguage(worksheet, regionId, language)),
    setSpelling: (worksheet, values) => edit(worksheet, equavelaApi.setSpelling(worksheet, values)),
    spellLanguages: equavelaApi.spellLanguages,
    spellCheck: equavelaApi.spellCheck,
    spellSuggest: equavelaApi.spellSuggest,
    spellAddWord: equavelaApi.spellAddWord,
    spellLicense: equavelaApi.spellLicense,
    spellInstall: equavelaApi.spellInstall,
    spellUninstall: equavelaApi.spellUninstall,
    setJuliaSize: (worksheet, regionId, width, height) =>
      edit(worksheet, equavelaApi.setJuliaSize(worksheet, regionId, width, height)),
    setPageSetup: (worksheet, page) => edit(worksheet, equavelaApi.setPageSetup(worksheet, page)),
    setResultFormat: (worksheet, regionId, format) =>
      edit(worksheet, equavelaApi.setResultFormat(worksheet, regionId, format)),
    setNumericOptions: (worksheet, regionId, options) =>
      edit(worksheet, equavelaApi.setNumericOptions(worksheet, regionId, options)),
    setMathFont: (worksheet, edits, reset) => edit(worksheet, equavelaApi.setMathFont(worksheet, edits, reset)),
    setResultDefaults: (worksheet, values) =>
      edit(worksheet, equavelaApi.setResultDefaults(worksheet, values)),
    setLabelStyles: (worksheet, values) =>
      edit(worksheet, equavelaApi.setLabelStyles(worksheet, values)),
    setJuliaCode: (worksheet, regionId, code) =>
      edit(worksheet, equavelaApi.setJuliaCode(worksheet, regionId, code)),
    setJuliaPlaying: (worksheet, regionId, playing) =>
      edit(worksheet, equavelaApi.setJuliaPlaying(worksheet, regionId, playing)),
    runRegion: (worksheet, regionId) => edit(worksheet, equavelaApi.runRegion(worksheet, regionId)),
    setWorksheetTrusted: (worksheet, trusted) =>
      edit(worksheet, equavelaApi.setWorksheetTrusted(worksheet, trusted)),
    setCalculationSettings: (worksheet, values) =>
      edit(worksheet, equavelaApi.setCalculationSettings(worksheet, values)),
    plotData: equavelaApi.plotData,
    setPlot: (worksheet, regionId, plot) => edit(worksheet, equavelaApi.setPlot(worksheet, regionId, plot)),
    setIncludePath: (worksheet, regionId, path) => edit(worksheet, equavelaApi.setIncludePath(worksheet, regionId, path)),
    setPlotView: equavelaApi.setPlotView,
    removeRegions: (worksheet, regionIds) =>
      edit(worksheet, equavelaApi.removeRegions(worksheet, regionIds)),
    undo: (worksheet) => edit(worksheet, equavelaApi.undo(worksheet)),
    redo: (worksheet) => edit(worksheet, equavelaApi.redo(worksheet)),
    onKernelStatus,
    onKernelActivity,
    onWorksheetEvent,
  };
}

/** Whether the page runs inside the Tauri webview. */
export function insideTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The mode requested by the URL (`?backend=mock` or `?backend=real`), if any. */
export function requestedMode(search: string): BackendMode | null {
  const value = new URLSearchParams(search).get("backend");
  if (value === "mock") return "mock";
  if (value === "real") return "tauri";
  return null;
}

/** Picks the backend for this page (see the header comment). */
export async function chooseBackend(): Promise<Backend> {
  const mode =
    requestedMode(typeof window === "undefined" ? "" : window.location.search) ??
    (insideTauri() ? "tauri" : "mock");
  if (mode === "tauri") return createTauriBackend();
  const { createMockBackend } = await import("./mock/mockBackend");
  // `?fixture=<url>` serves that `open_worksheet` JSON instead of the demo.
  const fixture = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("fixture");
  if (fixture) return createMockBackend({ opened: await (await fetch(fixture)).json() });
  return createMockBackend();
}
