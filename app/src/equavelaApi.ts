// Typed wrappers for the Tauri commands and events of the worksheet service
// (app/src-tauri/src/service.rs). The wire types mirror the serde output of equavela-core:
// field names are snake_case, tagged enums use `state`, `status` and `event`.
// Command arguments are camelCase here because Tauri converts them to snake_case.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { decodePlotFrame } from "./plot/frame";
import type { AppSettings } from "./settings";

// ---- values ----------------------------------------------------------------------------

/** A finite number, or the strings used for the non-finite values. */
export type WireFloat = number | "nan" | "infinity" | "-infinity";

export type DimensionComponent = {
  base: string;
  /** Reduced [numerator, denominator]. */
  power: [number, number];
};

export type KernelValue =
  | { type: "real"; value: WireFloat }
  | { type: "complex"; real: WireFloat; imag: WireFloat }
  | { type: "string"; value: string }
  | {
      type: "quantity";
      magnitude:
        | { type: "real"; value: WireFloat }
        | { type: "complex"; real: WireFloat; imag: WireFloat };
      dimension: DimensionComponent[];
    }
  | {
      type: "matrix";
      rows: number;
      cols: number;
      /**
       * Binary storage is materialized by the core before it reaches the frontend. A matrix with
       * more than 10 000 elements arrives as its first block: the elements of
       * rows `row..row+rows` and columns `col..col+cols`, column-major; read the others with
       * `resultBlock`.
       */
      storage:
        | { type: "inline"; values: KernelValue[] }
        | { type: "window"; row: number; col: number; rows: number; cols: number; values: KernelValue[] };
    }
  | { type: "handle"; id: string; julia_type: string; summary: string }
  /** A symbolic result (`→`): canonical AST (`expr`) and its canonical linear text. */
  | { type: "symbolic"; expr: unknown; text: string };

// ---- regions and results ---------------------------------------------------------------

export type Span = { start: number; end: number };

/** One region instance: a document included twice has two instances of each region. */
export type RegionKey = {
  document: string;
  region_id: string;
  instance: number;
};

export type FailureKind =
  | "evaluation"
  | "blocked"
  | "interrupted"
  | "not_trusted"
  | "kernel";

export type RegionFailure = {
  kind: FailureKind;
  message: string;
  /** Byte range in the region's math text. */
  span: Span | null;
  blocked_by: RegionKey | null;
  julia_type: string | null;
  /** The package a `MissingPackage` failure needs. */
  package?: string | null;
};

/**
 * The unit override of an evaluation (`e = ... km/hr`): a formatting instruction. `value`
 * stays in SI base units; show `value / divisor` followed by `text`.
 */
export type DisplayUnit = {
  /** The unit expression as written, in the worksheet syntax. */
  text: string;
  /** The SI value of the unit. */
  divisor: number;
  /** The SI value of the unit's zero, subtracted before dividing; absent is 0. */
  offset?: number;
};

export type RegionState =
  | { state: "pending" }
  | { state: "stale"; value: KernelValue | null; display_unit?: DisplayUnit }
  | { state: "value"; value: KernelValue | null; display_unit?: DisplayUnit }
  | { state: "error"; failure: RegionFailure };

export type TerminalSnapshot = { generation: number; sequence: number; data: number[] };

/** One REPL evaluation. */
export type ReplResult = {
  incomplete: boolean;
  output: string;
  value: string | null;
  error: string | null;
  trace: string | null;
  duration: number;
};
/** What a Julia cell's last evaluation wrote, how long it took and its trace. */
export type CellOutput = { text: string; duration_ms: number; trace?: string | null };
export type RegionEntry = { key: RegionKey; output?: CellOutput | null } & RegionState;

export type RegionText = { document: string; region_id: string; text: string };

export type SessionDiagnostic = {
  document: string;
  region_id: string;
  message: string;
};

// ---- inspection (names, references, includes, unit warnings) ---------------------------

/** A name definition of the expanded project (core/src/session/inspect.rs). */
export type DefinitionInfo = {
  name: string;
  /** `var`, `fn`, `const`, `unit`, `sys`, `kw` or `julia`. */
  label: string;
  key: RegionKey;
  version: number;
  global: boolean;
  /** The left side as written (`f(x, y)`). */
  signature: string;
  /** the Julia name in the worksheet's module (`M_smax_v1`). */
  kernel_name: string;
  /** Evaluation order of the defining region. */
  rank: number;
};

/** A use of a name; `definition` is null for units, constants, built-ins and undefined names. */
export type ReferenceInfo = {
  key: RegionKey;
  /** Byte range = the `span` of the identifier node in the region's AST. */
  start: number;
  end: number;
  name: string;
  definition: RegionKey | null;
  definition_name?: string;
  version: number | null;
  intrinsic?: { kind: "constant"; value?: WireFloat } | { kind: "system" } | { kind: "builtin" };
};

export type WarningInfo = { key: RegionKey; start: number; end: number; message: string };

export type IncludeInfo = {
  document: string;
  parent: string;
  region_id: string;
  exports: DefinitionInfo[];
  found: boolean;
};

export type Inspection = {
  root: string;
  definitions: DefinitionInfo[];
  references: ReferenceInfo[];
  warnings: WarningInfo[];
  includes: IncludeInfo[];
  ranks: [RegionKey, number][];
};

/** The value of a definition (or its size when too large, or why it has none). */
export type DefinitionValue = {
  name: string;
  version: number;
  value: KernelValue | null;
  size: [number, number] | null;
  error: string | null;
  /** The unit the worksheet shows the value in; absent is base SI. */
  display_unit?: DisplayUnit;
};

// ---- document view (page setup and regions) --------------------------------------------

export type Margins = { top: number; right: number; bottom: number; left: number };

/**
 * A header or a footer line of the page:
 * three slots drawn at the left edge, the centre and the right edge of the printable width, each
 * one line of text. `center` is spelled the American way as in the file.
 */
export type PageLine = { left: string; center: string; right: string };

/** Page size and margins in points. */
export type PageSetup = {
  /** `A4`, `Letter`, ... or `custom`. */
  size: string;
  width: number;
  height: number;
  margins: Margins;
  /** The line drawn in the top margin. */
  header: PageLine;
  /** The line drawn in the bottom margin. */
  footer: PageLine;
};

export type JuliaBlock = {
  /** False for a stopped block; absent or true when it plays. */
  playing?: boolean;
  /**
   * The size in points of the box the block is drawn in: width and height, both finite
   * and positive. Absent is a block that grows with its header and its code.
   */
  size?: [number, number];
  using: string[];
  imports: { name: string; package: string; function: string }[];
  code: string | null;
  defines: string[];
};

/** Character formatting of a text run. */
export type RunFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  sub?: boolean;
  sup?: boolean;
  /** Font size in points; absent is the region default. */
  size?: number;
  /** Text colour as #rrggbb; absent is the region default. */
  color?: string;
  /** Highlight (the background of the run) as #rrggbb; absent is none. */
  highlight?: string;
};
export type TextRun = { kind: "text"; text: string } & RunFormat;

/** A dictionary of the spelling catalogue. */
export type SpellLanguage = { id: string; locales: string[]; installed: boolean; bundled: boolean };
/** The result of a spell check: whether the language can be used, and one flag per word. */
export type SpellCheck = { available: boolean; correct: boolean[] };
/**
 * Inline math: `statement` is the canonical AST (`null` when `text` does not parse). From the editor only
 * `statement` matters; Rust prints it.
 */
export type MathRun = {
  kind: "math";
  text: string;
  statement: unknown | null;
  /** The run is not calculated and is drawn disabled. */
  disabled?: boolean;
  /** The run's own result format, `format.*` keys. */
  format?: Record<string, string>;
};
export type RichRun = TextRun | MathRun;
/** The paragraph styles of the Text tab; absent is `normal`. */
export type ParagraphStyle = "normal" | "title" | "subtitle" | "heading1" | "heading2" | "heading3";
/** The paragraph alignments of the Text tab; absent is `left`. */
export type ParagraphAlign = "left" | "center" | "right" | "justify";
/** A paragraph: its two attributes (left out when they are the default) and its runs. */
export type Paragraph = { style?: ParagraphStyle; align?: ParagraphAlign; runs: RichRun[] };
/** Paragraphs of runs. */
export type RichText = Paragraph[];

/**
 * An axis limit: a number, or a limit expression as linear math text that the
 * session calculates, or null for an automatic end.
 */
export type AxisLimit = number | string;
export type PlotAxis = {
  scale: "linear" | "log10";
  /**
   * Where the axis line is drawn: on the edge of the plot area (`boundary`, the
   * default the file omits) or through the zero of the axis it crosses (`origin`).
   */
  position?: "boundary" | "origin";
  unit: string | null;
  min: AxisLimit | null;
  max: AxisLimit | null;
  show_grid: boolean;
  title: string;
};
export type PlotSpec = {
  version: number;
  type: "xy" | "polar" | "contour";
  /** The plot title: literal text drawn above the plot area. */
  title?: string;
  size: [number, number];
  axes: { x: PlotAxis; y: PlotAxis; y2?: PlotAxis };
  grid_spacing?: number | null;
  traces: {
    id: string;
    x: string;
    y: string;
    z?: string;
    y_axis?: "left" | "right";
    presentation: "line" | "markers" | "line+markers";
    /** What the trace draws at each point; absent is `lines`. */
    type?: "lines" | "stems" | "bars" | "steps";
    line?: { style?: "solid" | "dash" | "dot" | "dashdot"; width?: number; color?: string | null };
    marker?: { shape?: "circle" | "square" | "diamond" | "cross" | "x" | "triangle-up" | "triangle-down"; size?: number; color?: string | null };
    show_in_legend?: boolean;
    legend_label?: string;
  }[];
  /** Fixed XY reference lines. */
  reference_lines?: {
    id: string;
    axis: "x" | "y";
    value: AxisLimit;
    line?: { style?: "solid" | "dash" | "dot" | "dashdot"; width?: number; color?: string | null };
    show_in_legend?: boolean;
    legend_label?: string;
  }[];
};

/** A presentation-only line break before a node of a math statement. */
export type MathBreak = {
  /** Child-index path of the node the continuation line starts with. */
  path: number[];
  /** Character offset inside a string literal; the break is visual and never changes its value. */
  offset?: number;
};

/**
 * What a region contains. `statement` is the canonical AST of the math (`core/src/ast.rs`,
 * serde form); the renderer in `math/` draws it.
 */
export type ViewContent =
  | { kind: "math"; text: string; statement: unknown; breaks?: MathBreak[]; format?: Record<string, string> }
  | { kind: "julia"; block: JuliaBlock }
  | { kind: "include"; path: string }
  | { kind: "text"; text: string; width: number | null; full_width?: boolean; background?: string; language?: string; paragraphs: RichText }
  | { kind: "plot"; plot: PlotSpec }
  /** An image: the bytes are fetched by `resource` id (`imageData`); `size` in points. */
  | { kind: "image"; resource: string; media: "png" | "jpeg" | "svg"; size: [number, number] }
  /** A collapsible area: the band; its members are ordinary regions. `height` in points. */
  | { kind: "area"; title: string; height: number; collapsed: boolean };

export type ViewRegion = {
  id: string;
  /** 1-based page. */
  page: number;
  /** Position in points, relative to the top-left corner of the page. */
  x: number;
  y: number;
  enabled: boolean;
} & ViewContent;

/**
 * A manual page break: the 1-based page that
 * ends on purpose and the y in points where the author put the break. The mark is drawn at the
 * bottom of that page; `y` records how much space the break made free.
 */
export type PageBreak = { page: number; y: number };

export type DocumentView = {
  document: string;
  page: PageSetup;
  /** Calculation and display settings of the document (`settings:` in the file). */
  settings?: Record<string, string>;
  /** The manual page breaks, sorted by page, one per page. */
  page_breaks?: PageBreak[];
  regions: ViewRegion[];
  can_undo: boolean;
  can_redo: boolean;
  undo_label: string | null;
  redo_label: string | null;
  /** Whether the worksheet is trusted; absent means trusted. */
  trusted?: boolean;
};

export type OpenedWorksheet = {
  id: string;
  root: string;
  regions: RegionEntry[];
  texts: RegionText[];
  diagnostics: SessionDiagnostic[];
  view: DocumentView;
  /** The revision of `view` and `regions` in the worksheet's edit stream; `0` for a new one. */
  revision: number;
  /** The worksheet's Julia environment. */
  environment?: EnvironmentSummary;
};

/** Where a worksheet's Julia environment comes from. */
/** where the worksheet's Julia environment comes from. */
export type EnvironmentKind = "shared" | "project" | "override" | "archive";
export type EnvironmentOperation = "instantiate" | "resolve" | "update";

/** A worksheet's Julia environment and the kernel that serves it. */
export type EnvironmentSummary = {
  kind: EnvironmentKind;
  directory: string;
  /** An override given as an absolute path: the worksheet is not portable. */
  absolute: boolean;
  /** The kernel key that `kernel-status` events carry as `environment`. */
  kernel: string;
};

/** What the environment manager shows, read from the files. */
export type EnvironmentInfo = EnvironmentSummary & {
  problems: string[];
  files: {
    project_toml: string;
    project_exists: boolean;
    manifest_toml: string;
    manifest_exists: boolean;
    dependencies: { name: string; uuid: string; compatibility: string | null; version: string | null; installed: boolean }[];
    error: string | null;
  };
  kernel_status: KernelStatus;
  can_override: boolean;
  /** The last package change, while it can be undone. */
  last_change: EnvironmentChange | null;
  /** A package change Equavela stopped during. */
  interrupted_change: EnvironmentChange | null;
};

/** A package operation recorded by an environment snapshot. */
export type EnvironmentChange = { operation: string; packages: string[]; started: number };

/** A non-mutating, source-checked worksheet environment switch plan. */
export type EnvironmentSwitchPreview = {
  token: string;
  current: EnvironmentSummary;
  target: EnvironmentSummary;
  files: EnvironmentInfo["files"];
  differences: { name: string; current: string | null; target: string | null; missing: boolean }[];
};

/** A Project.toml or Manifest.toml from the worksheet's currently selected environment. */
export type EnvironmentMetadataFile = "project" | "manifest";

/** Durable metadata of a folder project. */
export type ProjectManifest = {
  format: "equavela-project/1";
  project_id: string;
  name: string;
  worksheets: { id: string; path: string }[];
  /** Read from manifests written before and ignored. */
  main_worksheet?: string | null;
  environment?: string | null;
  /** the specification : public definitions. */
  exports?: ProjectExport[];
  /** projects used under an alias, with their locked API. */
  references?: ProjectReference[];
  /** project `.jl` files every worksheet loads. */
  julia_modules?: string[];
};

export type ProjectExport = { id: string; worksheet: string; region: string };
export type ProjectApiEntry = { id: string; name: string; kind: "value" | "function"; arity?: number | null };
export type ProjectReference = { alias: string; project_id: string; path: string; api?: ProjectApiEntry[] };

/** the specification : an export, with its current API entry. */
export type ExportInfo = { id: string; worksheet: string | null; region: string; api: ProjectApiEntry | null };
/** a reference as the explorer shows it. */
export type ProjectReferenceInfo = {
  alias: string;
  path: string;
  project_id: string;
  name: string | null;
  root: string | null;
  api: ProjectApiEntry[];
  current: ProjectApiEntry[];
  problem: string | null;
  out_of_date: boolean;
  trusted: boolean;
  /** the provider's Julia package, and whether this project's environment has it. */
  package: string | null;
  developed: boolean;
};
export type ProjectReferences = { exports: ExportInfo[]; references: ProjectReferenceInfo[] };
/** A reference or export command's result: the manifest and the change of each open project worksheet. */
export type ReferencesChangeDelta = { manifest: ProjectManifest; worksheets: { id: string; delta: EditResultDelta }[] };
export type ReferenceCommand = "update" | "remove" | "rename" | "reload" | "trust" | "untrust";

export type OpenedProject = {
  root: string;
  manifest: ProjectManifest;
  /** The worksheet a command opened with the project (Convert to project); null otherwise. */
  worksheet: OpenedWorksheet | null;
};

/** One folder or file of the project tree, by its `/` path. */
export type TreeEntry = {
  path: string;
  kind: "folder" | "worksheet" | "julia" | "image" | "other";
  /** Bytes of a file, 0 for a folder. */
  size: number;
};

/**
 * What a command of the project explorer returns: the manifest and the tree now,
 * the worksheet it opened, the open worksheets reopened in place of session `id`, the sessions it
 * closed, and the worksheet that became main because the main one's file is gone.
 */
export type ProjectChange = {
  manifest: ProjectManifest;
  entries: TreeEntry[];
  opened: OpenedWorksheet | null;
  replaced: { id: string; opened: OpenedWorksheet }[];
  closed: string[];
};

/** A text file of the project as a text tab reads it. */
export type ProjectTextFile = { text: string; version: string };
/** Project-wide image usage, including closed worksheets and unavailable references. */
export type ProjectImageUsage = { path: string; worksheets: string[]; problem: string | null };
/** What saving a text tab did. */
export type ProjectTextSaved = { version: string; restarted: boolean };

/** What New in the explorer creates. */
export type NewItemKind = "worksheet" | "julia" | "folder";

/** One thing an import did not bring over, or approximated. */
export type ImportIssue = { code: string; region: string | null; message: string };

/** What an import left out; `issues` lose content, `notes` are information only. */
export type ImportReport = {
  regions_total: number;
  regions_imported: number;
  page_breaks: number;
  issues: ImportIssue[];
  notes: ImportIssue[];
};

/** One region of a Replace All: the new statement of a math region or the new value of a text region. */
export type RegionRewrite = { regionId: string; statement?: unknown; paragraphs?: RichText };

/** What `import_mcdx` returns: a new untitled worksheet and its report. */
export type ImportedWorksheet = { opened: OpenedWorksheet; report: ImportReport };

/** What Save and Save As return. `opened` is set when Save As re-opened the worksheet at the new file. */
export type SavedWorksheet = { path: string; opened: OpenedWorksheet | null };

/** What `export_pdf` produced. */
export type ExportedPdf = { path: string; pages: number; width_pt: number; height_pt: number };

/** A recovery file that is newer than the worksheet file it belongs to. */
export type RecoveryInfo = { path: string };
/** Unsaved project text and its original disk baseline. */
export type ProjectTextRecovery = { text: string; saved: string; version: string };
export type ProjectTextRecoveryEntry = { id: string; root: string; path: string; modified_ms: number };
export type ProjectTextRecoveryListing = { entries: ProjectTextRecoveryEntry[]; unreadable: number };

/**
 * What an edit command returns on the wire: the difference between the state the worksheet
 * last sent and its state now. The frontend keeps the last full view and results list (see
 * `editDelta.ts`) and applies this to them, so an edit carries a few KiB instead of the whole
 * worksheet. A field that did not change is absent; the small scalars are always there. `base` is
 * the revision the delta applies to: when it is not the stored one, the state is fetched again
 * with `worksheetSnapshot`.
 */
export type EditResultDelta = {
  base: number;
  revision: number;
  /** The regions that are new or changed, whole. */
  regions: ViewRegion[];
  /** The ids of the regions that are gone. */
  removed: string[];
  /** The region ids in their new order; only when the order changed. */
  order?: string[];
  /** Only when it changed (Save As opens a new session). */
  document?: string;
  page?: PageSetup;
  settings?: Record<string, string>;
  /** The manual page breaks; only when they changed. */
  page_breaks?: PageBreak[];
  can_undo: boolean;
  can_redo: boolean;
  undo_label: string | null;
  redo_label: string | null;
  trusted?: boolean;
  /** The result entries that are new or changed, whole. */
  results: RegionEntry[];
  /** The `keyId`s of the results that are gone. */
  removed_results: string[];
  /** The result keys in their new order; only when the order changed. */
  results_order?: string[];
  created: string | null;
  /** This edit made an expression (a plot trace included) out of date: an automatic calculation is due. */
  calc_needed?: boolean;
  label: string | null;
  /** The structural problems of the project, only when they changed with this edit. */
  diagnostics?: SessionDiagnostic[];
  /** The worksheet's Julia environment, only when this change moved it to another one. */
  environment?: EnvironmentSummary;
};

/** The whole view and results list of a worksheet with the revision they are. */
export type WorksheetSnapshot = {
  revision: number;
  view: DocumentView;
  regions: RegionEntry[];
};

/**
 * What add, move, delete, undo and redo give the rest of the UI: the whole new state. The regions a
 * calculation has to redo are the result entries whose state is `stale`
 * .
 */
export type EditResult = {
  view: DocumentView;
  /** The whole results list (its order changes when regions move). */
  regions: RegionEntry[];
  created: string | null;
  /** This edit made an expression (a plot trace included) out of date: an automatic calculation is due. */
  calc_needed?: boolean;
  label: string | null;
  /** The new structural problems (missing include, cycle) when this edit changed them. */
  diagnostics?: SessionDiagnostic[];
  /** The worksheet's Julia environment when this edit moved it to another one. */
  environment?: EnvironmentSummary;
};

/** What adding an image returns: the edit result and how many unsafe SVG parts were removed. */
export type ImageAdded = EditResult & { removed_parts: number };

/** What adding an image returns on the wire: a delta and the count of removed SVG parts. */
export type ImageAddedDelta = EditResultDelta & { removed_parts: number };

/** A new band height of an area, applied with a line inserted or removed inside it. */
export type AreaHeight = { region_id: string; height: number };

export type RegionMove = { region_id: string; page: number; x: number; y: number };

/**
 * One region of a math-font command: the region and the whole display
 * override it should have afterwards, or `null` when it has none. The font is part of the region
 * display override.
 */
export type MathFontEdit = { region_id: string; format: Record<string, string> | null };

export type NewRegionKind = "math" | "text" | "include" | "plot" | "area" | "table" | "julia";

// ---- events ----------------------------------------------------------------------------

export type KernelInfo = { julia: string; package: string; protocol: number };

export type KernelStatus =
  | { status: "not_started" }
  | { status: "starting" }
  | { status: "ready"; info: KernelInfo }
  | { status: "busy" }
  | { status: "crashed"; message: string };

/** A `kernel-status` event: the status of the kernel of one environment. */
export type KernelStatusEvent = KernelStatus & { environment?: string };

export type PassSummary = {
  affected: number;
  evaluated: number;
  failed: number;
  blocked: number;
  reset: boolean;
  incomplete: boolean;
};

export type WorksheetEvent = { worksheet: string } & (
  | { event: "pass_started"; affected: number; reset: boolean }
  | { event: "region_started"; key: RegionKey }
  | {
      event: "region_progress";
      key: RegionKey;
      fraction: number | null;
      message: string | null;
    }
  | { event: "region_updated"; entry: RegionEntry }
  /** The calculated data of a plot changed; ask for it again when the pass has finished. */
  | { event: "plot_updated"; document: string; region_id: string }
  | { event: "pass_finished"; summary: PassSummary }
  /** The calculation could not run at all (for example the kernel is missing). */
  | { event: "pass_failed"; message: string }
);

/** The error object of a rejected command. */
export type CommandError = {
  kind:
    | "load"
    | "parse"
    | "paste"
    | "unknown_worksheet"
    | "busy"
    | "region"
    | "internal";
  message: string;
  /** For `parse`: position of the syntax error in the submitted text. */
  line?: number;
  column?: number;
  start?: number;
  end?: number;
};

export const EVENT_KERNEL_STATUS = "kernel-status";
export const EVENT_WORKSHEET = "worksheet-event";
export const EVENT_OPEN_REQUEST = "open-request";

// ---- commands --------------------------------------------------------------------------

export const equavelaApi = {
  coreVersion: () => invoke<string>("core_version"),

  /** The current kernel status; changes arrive through `onKernelStatus`. */
  kernelStatus: () => invoke<KernelStatus>("kernel_status"),

  /** Starts the kernel in the background (also done by `openWorksheet`). */
  startKernel: () => invoke<void>("start_kernel"),

  /** Loads a worksheet YAML file and the files it includes. */
  openWorksheet: (path: string) =>
    invoke<OpenedWorksheet>("open_worksheet", { path }),

  closeWorksheet: (worksheet: string) =>
    invoke<void>("close_worksheet", { worksheet }),

  /**
   * Replaces the math text of a region. Resolves to the regions that became stale;
   * rejects with a `CommandError` (`parse` carries line, column and the span).
   */
  editRegion: (
    worksheet: string,
    document: string,
    regionId: string,
    text: string,
  ) =>
    invoke<RegionKey[]>("edit_region", { worksheet, document, regionId, text }),

  /**
   * Starts a calculation and returns immediately; progress arrives through
   * `onWorksheetEvent`. `all: false` is F5 (what is out of date), `all: true` is
   * Ctrl+F5 (reset and recalculate everything).
   */
  recalculate: (worksheet: string, all = false) =>
    invoke<void>("recalculate", { worksheet, all }),

  /** Interrupts the running calculation. Resolves to whether a kernel request was hit. */
  interrupt: (worksheet: string) => invoke<boolean>("interrupt", { worksheet }),

  getResults: (worksheet: string) =>
    invoke<RegionEntry[]>("get_results", { worksheet }),
  /** A block of a large matrix result, column-major, clipped to the matrix. */
  resultBlock: (worksheet: string, key: RegionKey, row: number, col: number, rows: number, cols: number) =>
    invoke<KernelValue[]>("result_block", { worksheet, key, row, col, rows, cols }),

  /** Creates an empty, unsaved worksheet. */
  newWorksheet: () => invoke<OpenedWorksheet>("new_worksheet"),
  /** Creates a folder project; identifiers are stable caller-generated UUIDs. */
  newProject: (destination: string, name: string, projectId: string, worksheetId: string) =>
    invoke<OpenedProject>("new_project", { destination, name, projectId, worksheetId }),
  /** Convert to project: the worksheet becomes the main worksheet of a new project, opened in its place. */
  convertToProject: (worksheet: string, destination: string, name: string, projectId: string, worksheetId: string) =>
    invoke<OpenedProject>("convert_to_project", { worksheet, destination, name, projectId, worksheetId }),
  /** the project tree and its manifest, brought in step with the tree. */
  projectTree: (root: string) => invoke<ProjectChange>("project_tree", { root }),
  /** a new worksheet (opened), Julia file or folder in `folder` (`""`: the root). */
  projectCreate: (root: string, folder: string, name: string, kind: NewItemKind) =>
    invoke<ProjectChange>("project_create", { root, folder, name, kind }),
  /** renames a file or folder in place (`name`: the whole file name). */
  projectRename: (root: string, path: string, name: string) => invoke<ProjectChange>("project_rename", { root, path, name }),
  /** moves a file or folder into `folder`. */
  projectMove: (root: string, path: string, folder: string) => invoke<ProjectChange>("project_move", { root, path, folder }),
  projectMoveMany: (root: string, paths: string[], folder: string) => invoke<ProjectChange>("project_move_many", { root, paths, folder }),
  /** moves a file or folder to the system trash. */
  projectDelete: (root: string, path: string) => invoke<ProjectChange>("project_delete", { root, path }),
  projectDeleteMany: (root: string, paths: string[]) => invoke<ProjectChange>("project_delete_many", { root, paths }),
  /** copies files into `folder`; without `sources` the native Open dialog asks. `null`: cancelled. */
  projectImport: (root: string, folder: string, sources?: string[]) =>
    invoke<ProjectChange | null>("project_import", { root, folder, sources: sources ?? null }),
  /** the text of a file of the project and its version. */
  projectReadText: (root: string, path: string) => invoke<ProjectTextFile>("project_read_text", { root, path }),
  projectImageUsage: (root: string) => invoke<ProjectImageUsage[]>("project_image_usage", { root }),
  /** saves a text tab when the file is still `version`; may restart the project's kernel. */
  projectWriteText: (root: string, path: string, text: string, version: string) =>
    invoke<ProjectTextSaved>("project_write_text", { root, path, text, version }),
  /** an image of the project as a data URL. */
  projectImage: (root: string, path: string) => invoke<string>("project_image", { root, path }),
  /** hands a file of the project to the system's default application. */
  projectOpenExternal: (root: string, path: string) => invoke<void>("project_open_external", { root, path }),
  /** shows a file or folder in the system file manager. */
  projectReveal: (root: string, path: string) => invoke<void>("project_reveal", { root, path }),
  /** runs code in the REPL module of a worksheet's environment. */
  terminalOpen: (project: string | null, cols: number, rows: number) => invoke<TerminalSnapshot>("terminal_open", { project, cols, rows }),
  terminalRead: (project: string | null, after: number) => invoke<TerminalSnapshot>("terminal_read", { project, after }),
  terminalWrite: (project: string | null, data: string) => invoke<void>("terminal_write", { project, data }),
  terminalResize: (project: string | null, cols: number, rows: number) => invoke<void>("terminal_resize", { project, cols, rows }),
  replEval: (project: string | null, code: string, reset?: boolean) => invoke<ReplResult>("repl_eval", { project, code, reset: reset ?? null }),
  /** the module name of every open worksheet, by worksheet id. */
  worksheetModuleNames: () => invoke<Record<string, string>>("worksheet_module_names"),
  /** interrupts the REPL evaluation. */
  replInterrupt: (project: string | null) => invoke<boolean>("repl_interrupt", { project }),
  /** restarts the kernel the REPL runs in; the key of that kernel (`EnvironmentSummary.kernel`). */
  replRestart: (project: string | null) => invoke<string>("repl_restart", { project }),
  /** Tab in the REPL input; completions in the REPL module of a worksheet's environment (characters). */
  replComplete: (project: string | null, text: string, position: number) =>
    invoke<{ items: string[]; from: number; to: number }>("repl_complete", { project, text, position }),
  /** Julia's completions of `text` at `position`, from a worksheet's running kernel. */
  completeCode: (worksheet: string, text: string, position: number) =>
    invoke<{ items: string[]; from: number; to: number }>("complete_code", { worksheet, text, position }),
  /** shows an open document's file in the system file manager. */
  revealFile: (path: string) => invoke<void>("reveal_file", { path }),
  /** the native folder dialog; `null` when cancelled. */
  chooseFolder: (title: string, start?: string) => invoke<string | null>("choose_folder", { title, start: start ?? null }),
  /** Load in worksheets for a project `.jl` file. */
  projectSetJuliaModule: (root: string, path: string, loaded: boolean) =>
    invoke<ReferencesChangeDelta>("project_set_julia_module", { root, path, loaded }),
  /** the project's exports and references. */
  projectReferences: (root: string) => invoke<ProjectReferences>("project_references", { root }),
  /** exports a definition region, or stops exporting it. */
  projectSetExport: (root: string, path: string, region: string, exported: boolean) =>
    invoke<ReferencesChangeDelta>("project_set_export", { root, path, region, exported }),
  /** references a project; without `folder` the native folder dialog asks. `null`: cancelled. */
  projectAddReference: (root: string, folder?: string, alias?: string) =>
    invoke<ReferencesChangeDelta | null>("project_add_reference", { root, folder: folder ?? null, alias: alias ?? null }),
  /** update, rename, remove, reload or trust references. */
  projectReferenceCommand: (root: string, command: ReferenceCommand, alias?: string, value?: string) =>
    invoke<ReferencesChangeDelta>("project_reference_command", { root, command, alias: alias ?? null, value: value ?? null }),
  /** makes a worksheet the main one. */
  /** Opens project metadata and the declared main worksheet. */
  openProject: (root: string) => invoke<OpenedProject>("open_project", { root }),
  /** The worksheet's Julia environment, its files and its kernel. */
  environmentInfo: (worksheet: string) => invoke<EnvironmentInfo>("environment_info", { worksheet }),
  /** Reads the currently selected environment metadata as UTF-8 text. */
  readEnvironmentMetadata: (worksheet: string, file: EnvironmentMetadataFile) =>
    invoke<string>("read_environment_metadata", { worksheet, file }),
  /** Sets (a directory) or removes (`null`) a standalone worksheet's environment. */
  setWorksheetEnvironment: (worksheet: string, environment: string | null) =>
    invoke<EditResultDelta>("set_worksheet_environment", { worksheet, environment }),
  /** Copies environment metadata to a new directory and selects it for the worksheet. */
  copyEnvironment: (worksheet: string, destination: string) =>
    invoke<EditResultDelta>("copy_worksheet_environment", { worksheet, destination }),
  /** The native folder chooser, then the chosen folder as the worksheet's environment; `null` when cancelled. */
  chooseWorksheetEnvironment: (worksheet: string) =>
    invoke<EditResultDelta | null>("choose_worksheet_environment", { worksheet }),
  /** Previews a switch to an explicit environment directory (or shared environment when null). */
  previewEnvironmentSwitch: (worksheet: string, target: string | null) =>
    invoke<EnvironmentSwitchPreview>("preview_environment_switch", { worksheet, target }),
  /** Opens the native chooser and previews the selected directory; `null` when cancelled. */
  chooseEnvironmentSwitch: (worksheet: string) =>
    invoke<EnvironmentSwitchPreview | null>("choose_environment_switch", { worksheet }),
  /** Commits a previously confirmed preview. */
  commitEnvironmentSwitch: (worksheet: string, token: string) =>
    invoke<EditResultDelta>("commit_environment_switch", { worksheet, token }),
  /** Adds or removes packages in the worksheet's environment; returns the environment afterwards. */
  /** develops a referenced project's Julia package into the worksheet's environment. */
  developReferencePackage: (worksheet: string, alias: string) =>
    invoke<EnvironmentInfo>("develop_reference_package", { worksheet, alias }),
  changePackages: (worksheet: string, packages: string[], remove: boolean) =>
    invoke<EnvironmentInfo>("change_packages", { worksheet, packages, remove }),
  /** Instantiates, resolves or updates the worksheet's Julia environment. */
  manageEnvironment: (worksheet: string, operation: EnvironmentOperation) =>
    invoke<EnvironmentInfo>("manage_environment", { worksheet, operation }),
  /** Restarts the kernel of the worksheet's environment. */
  restartEnvironmentKernel: (worksheet: string) => invoke<EnvironmentInfo>("restart_environment_kernel", { worksheet }),
  /** Undoes the last package change or settles an interrupted one. */
  revertEnvironmentChange: (worksheet: string, interrupted: boolean, restore: boolean) =>
    invoke<EnvironmentInfo>("revert_environment_change", { worksheet, interrupted, restore }),
  /** Sets or clears the compatibility bound for a direct package dependency. */
  setCompatibility: (worksheet: string, packageName: string, compatibility: string) =>
    invoke<EnvironmentInfo>("set_compatibility", { worksheet, packageName, compatibility }),
  /** Packs the project into a new `.eqvz`; without `destination` the Save dialog asks. `null`: cancelled. */
  packProjectArchive: (root: string, destination?: string) =>
    invoke<string | null>("pack_project_archive", { root, destination: destination ?? null }),
  /** Extracts a project `.eqvz` into a new folder; missing paths are asked for. The root, or `null`: cancelled. */
  extractProjectArchive: (source?: string, destination?: string) =>
    invoke<string | null>("extract_project_archive", { source: source ?? null, destination: destination ?? null }),
  /** The image files of the project's `assets/images/`. */
  listProjectAssets: (root: string) => invoke<string[]>("list_project_assets", { root }),
  /** Saves to the worksheet's own file; the error kind `untitled` means Save As is needed. */
  saveWorksheet: (worksheet: string) => invoke<SavedWorksheet>("save_worksheet", { worksheet }),
  /** Save As: `path` omitted opens the native dialog (`.eqv` filter); `null` when it is cancelled. */
  saveWorksheetAs: (worksheet: string, path?: string, suggested?: string) =>
    invoke<SavedWorksheet | null>("save_worksheet_as", { worksheet, path, suggested }),
  /** The application settings: defaults when nothing is stored. */
  getSettings: () => invoke<AppSettings>("get_settings"),
  /** Stores the settings (validated by the backend) and returns what was stored. */
  setSettings: (settings: AppSettings) => invoke<AppSettings>("set_settings", { settings }),
  /** Open: the native file dialog (`.eqv` and `.eqvz`, `.mcdx` and `.xmcd`, all files; multi-select); `[]` when cancelled. `importMode` starts on the reference application filter. */
  chooseOpenPaths: (worksheet?: string, importMode?: boolean) =>
    invoke<string[]>("choose_open_paths", { worksheet, import: importMode }),
  /** Imports a reference application `.mcdx` or `.xmcd` as a new untitled worksheet. */
  importMcdx: (path: string) => invoke<ImportedWorksheet>("import_mcdx", { path }),
  /** Insert include: the native Open dialog; the path as the region stores it, `null` when cancelled. */
  chooseIncludePath: (worksheet?: string) => invoke<string | null>("choose_include_path", { worksheet }),
  /** Insert image: the native Open dialog (svg, png, jpg, jpeg); `null` when it is cancelled. */
  chooseImagePath: (worksheet?: string) => invoke<string | null>("choose_image_path", { worksheet }),
  /** Adds an image region from a file; one undo step. */
  addImage: (worksheet: string, path: string, page: number, x: number, y: number) =>
    invoke<ImageAddedDelta>("add_image", { worksheet, path, page, x, y }),
  /** Adds an image region from the base64 content of a file (paste, drop); one undo step. */
  addImageData: (worksheet: string, data: string, page: number, x: number, y: number) =>
    invoke<ImageAddedDelta>("add_image_data", { worksheet, data, page, x, y }),
  /** Sets the size in points of an image region; one undo step. */
  setImageSize: (worksheet: string, regionId: string, width: number, height: number) =>
    invoke<EditResultDelta>("set_image_size", { worksheet, regionId, width, height }),
  /** Sets the size of an image region back to the size of its picture; one undo step. */
  originalImageSize: (worksheet: string, regionId: string) =>
    invoke<EditResultDelta>("original_image_size", { worksheet, regionId }),
  /** Replaces the picture of an image region with a file, keeping its position; one undo step. */
  replaceImage: (worksheet: string, regionId: string, path: string) =>
    invoke<ImageAddedDelta>("replace_image", { worksheet, regionId, path }),
  /** Sets the title, height (points) and collapsed flag of an area region; one undo step. */
  setArea: (worksheet: string, regionId: string, title: string, height: number, collapsed: boolean) =>
    invoke<EditResultDelta>("set_area", { worksheet, regionId, title, height, collapsed }),
  /** An image resource as a `data:` URL. */
  imageData: (worksheet: string, resource: string) => invoke<string>("image_data", { worksheet, resource }),
  /** Export PDF: the native Save dialog (`*.pdf`); `null` when it is cancelled. */
  choosePdfPath: (worksheet: string, suggested?: string) =>
    invoke<string | null>("choose_pdf_path", { worksheet, suggested }),
  /** Prints the web view (already in the print view) to `path`; every page is exactly the given size. */
  exportPdf: (path: string, widthPt: number, heightPt: number) =>
    invoke<ExportedPdf>("export_pdf", { path, widthPt, heightPt }),
  /** Text, a PNG (base64) and an SVG on the system clipboard, written natively. */
  writeClipboardPicture: (text: string, png: string, svg: string | null) =>
    invoke<void>("write_clipboard_picture", { text, png, svg }),

  /**
   * Autosave: writes the recovery file of a worksheet. Resolves with the file written, or
   * `null` when nothing was written (a calculation is running: ask again later).
   */
  writeRecovery: (worksheet: string) => invoke<string | null>("write_recovery", { worksheet }),
  writeProjectTextRecovery: (root: string, path: string, text: string, saved: string, version: string) =>
    invoke<void>("write_project_text_recovery", { root, path, text, saved, version }),
  projectTextRecoveryFor: (root: string, path: string) =>
    invoke<ProjectTextRecovery | null>("project_text_recovery_for", { root, path }),
  discardProjectTextRecovery: (root: string, path: string) =>
    invoke<void>("discard_project_text_recovery", { root, path }),
  listProjectTextRecoveries: () => invoke<ProjectTextRecoveryListing>("list_project_text_recoveries"),
  readProjectTextRecovery: (id: string) => invoke<ProjectTextRecovery>("read_project_text_recovery", { id }),
  exportProjectTextRecovery: (id: string) => invoke<string | null>("export_project_text_recovery", { id }),
  discardProjectTextRecoveryEntry: (id: string) => invoke<void>("discard_project_text_recovery_entry", { id }),
  /** The recovery file of a worksheet file when it is newer than the file, else `null`. */
  recoveryFor: (path: string) => invoke<RecoveryInfo | null>("recovery_for", { path }),
  /** Deletes a recovery file (the user discarded it). */
  discardRecoveryFile: (path: string) => invoke<void>("discard_recovery_file", { path }),
  /** The recovery files of worksheets without a file left by a previous run. */
  pendingRecoveries: () => invoke<string[]>("pending_recoveries"),
  /**
   * Opens a recovery file. With `original` the worksheet takes that file's name; without, it is a
   * new untitled worksheet. The caller shows it as modified.
   */
  openRecovery: (recovery: string, original?: string) =>
    invoke<OpenedWorksheet>("open_recovery", { recovery, original }),

  /** The worksheet file named on the command line, if any. */
  initialWorksheet: () => invoke<string | null>("initial_worksheet"),

  /** Paths that other launches of the application asked this instance to open; drains the queue. */
  takeOpenRequests: () => invoke<string[]>("take_open_requests"),

  getView: (worksheet: string) => invoke<DocumentView>("get_view", { worksheet }),

  /**
   * The whole view and results list of a worksheet, and the revision they now are: what the
   * frontend asks for when it cannot apply a delta. The backend's baseline is reset to it.
   */
  worksheetSnapshot: (worksheet: string) =>
    invoke<WorksheetSnapshot>("worksheet_snapshot", { worksheet }),

  /** Adds a region at a page position (points). `text` is the math or text content. */
  addRegion: (
    worksheet: string,
    kind: NewRegionKind,
    page: number,
    x: number,
    y: number,
    text?: string,
    plotSize?: [number, number],
  ) => invoke<EditResultDelta>("add_region", {
    worksheet,
    kind,
    page,
    x,
    y,
    text,
    ...(plotSize ? { plotSize } : {}),
  }),

  /**
   * Adds a math region from the math editor's AST (wire form of `ast::Statement`); Rust
   * normalizes, prints and parses it. One undo step.
   */
  fastSymbolic: (worksheet: string, input: import("./editor/fastSymbolic").FastSymbolicInput) =>
    invoke<unknown>("fast_symbolic", { worksheet, input }),
  addMathRegion: (worksheet: string, page: number, x: number, y: number, statement: unknown, breaks: MathBreak[] = []) =>
    invoke<EditResultDelta>("add_math_region", { worksheet, page, x, y, statement, breaks }),

  /** Replaces a region's math with the math editor's AST and its presentation line breaks; one undo step per commit. */
  setMath: (worksheet: string, regionId: string, statement: unknown, breaks: MathBreak[] = []) =>
    invoke<EditResultDelta>("set_math", { worksheet, regionId, statement, breaks }),

  /** Adds a text region from the text editor's value (math runs carry their AST); one undo step. */
  addTextRegion: (worksheet: string, page: number, x: number, y: number, paragraphs: RichText, fullWidth = false) =>
    invoke<EditResultDelta>("add_text_region", { worksheet, page, x, y, paragraphs, fullWidth }),

  /** Replaces a text region's content with the editor's value; one undo step per commit. */
  setText: (worksheet: string, regionId: string, paragraphs: RichText) =>
    invoke<EditResultDelta>("set_text", { worksheet, regionId, paragraphs }),

  /** Rewrites several regions in one undo step. */
  replaceRegions: (worksheet: string, rewrites: RegionRewrite[]) =>
    invoke<EditResultDelta>("replace_regions", { worksheet, rewrites }),

  /** The canonical linear text of a statement (AST, wire form): the clipboard form of math. */
  printMath: (statement: unknown) => invoke<string>("print_math", { statement }),

  /** Parses linear math text (pasted) to the canonical AST; rejects with a `parse` error. */
  parseMath: (text: string) => invoke<unknown>("parse_math", { text }),

  /** The canonical text of a list of call arguments (`a, b`): the clipboard form of a run. */
  printMathArgs: (args: unknown[]) => invoke<string>("print_math_args", { args }),

  /** Parses linear math text as a list of call arguments; rejects with a `parse` error. */
  parseMathArgs: (text: string) => invoke<unknown[]>("parse_math_args", { text }),

  /**
   * Pastes regions from a clipboard snippet (a piece of the worksheet `regions:` list): fresh ids,
   * the group's top-left corner at the position, one undo step. Rejects with `paste` when the text
   * is not such a snippet.
   */
  pasteRegions: (worksheet: string, page: number, x: number, y: number, snippet: string) =>
    invoke<EditResultDelta>("paste_regions", { worksheet, page, x, y, snippet }),

  /**
   * Moves regions; one undo step. `areaHeights` resizes the band of an area in the same step, for a
   * line inserted or removed inside it.
   */
  moveRegions: (worksheet: string, moves: RegionMove[], areaHeights?: AreaHeight[]) =>
    invoke<EditResultDelta>("move_regions", { worksheet, moves, areaHeights }),

  /** Replaces the page setup; one undo step. */
  setPageSetup: (worksheet: string, page: PageSetup) =>
    invoke<EditResultDelta>("set_page_setup", { worksheet, page }),

  /**
   * Ends the page at `y` and moves the content below the caret line onto the next page
   * ; one undo step for the break and `moves` together.
   */
  addPageBreak: (worksheet: string, page: number, y: number, moves: RegionMove[]) =>
    invoke<EditResultDelta>("add_page_break", { worksheet, page, y, moves }),

  /** Removes the break of `page` and moves the content at or after it back up; one undo step. */
  removePageBreak: (worksheet: string, page: number, moves: RegionMove[]) =>
    invoke<EditResultDelta>("remove_page_break", { worksheet, page, moves }),

  /** Sets the width in points of a text region (`null` resets it); one undo step. */
  setResultFormat: (worksheet: string, regionId: string, format: Record<string, string> | null) =>
    invoke<EditResultDelta>("set_result_format", { worksheet, regionId, format }),
  /**
   * Sets the math font of the math regions: one command for all of them, so one undo
   * step, labelled `Math font` or, for a reset, `Reset math style`.
   */
  setMathFont: (worksheet: string, edits: MathFontEdit[], reset: boolean) =>
    invoke<EditResultDelta>("set_math_font", { worksheet, edits, reset }),
  setRegionWidth: (worksheet: string, regionId: string, width: number | null) =>
    invoke<EditResultDelta>("set_region_width", { worksheet, regionId, width }),

  /** Sets (or with null clears) the fill of a text region as #rrggbb; one undo step. */
  setTextBackground: (worksheet: string, regionId: string, background: string | null) =>
    invoke<EditResultDelta>("set_text_background", { worksheet, regionId, background }),
  /** Sets (or with null clears) the spelling language of a text region; one undo step. */
  setTextLanguage: (worksheet: string, regionId: string, language: string | null) =>
    invoke<EditResultDelta>("set_text_language", { worksheet, regionId, language }),
  /** Sets (`string`) or removes (`null`) the worksheet spelling keys; one undo step. */
  setSpelling: (worksheet: string, values: Record<string, string | null>) =>
    invoke<EditResultDelta>("set_spelling", { worksheet, values }),
  /** The dictionaries of the catalogue. */
  spellLanguages: () => invoke<SpellLanguage[]>("spell_languages"),
  /** One flag per word, true when it is spelled correctly. */
  spellCheck: (language: string, words: string[]) => invoke<SpellCheck>("spell_check", { language, words }),
  /** The corrections of a word. */
  spellSuggest: (language: string, word: string) => invoke<string[]>("spell_suggest", { language, word }),
  /** Adds a word to the user's dictionary. */
  spellAddWord: (word: string) => invoke<void>("spell_add_word", { word }),
  /** The licence text of an installed dictionary. */
  spellLicense: (language: string) => invoke<string | null>("spell_license", { language }),
  /** Downloads a dictionary from LibreOffice; called only after the user agreed. */
  spellInstall: (language: string) => invoke<void>("spell_install", { language }),
  /** Removes a downloaded dictionary. */
  spellUninstall: (language: string) => invoke<void>("spell_uninstall", { language }),
  /** Disables regions (they are no longer calculated) or enables them again; one undo step. */
  setRegionsEnabled: (worksheet: string, regionIds: string[], enabled: boolean) =>
    invoke<EditResultDelta>("set_regions_enabled", { worksheet, regionIds, enabled }),

  /** Sets (`string`) or removes (`null`) the worksheet result-format defaults; one undo step. */
  setResultDefaults: (worksheet: string, values: Record<string, string | null>) =>
    invoke<EditResultDelta>("set_result_defaults", { worksheet, values }),

  /**
   * Sets (`string`) or removes (`null`) the worksheet label styles:
   * `label-style.*` keys of the worksheet `settings:`, one undo step labelled `Label styles`.
   */
  setLabelStyles: (worksheet: string, values: Record<string, string | null>) =>
    invoke<EditResultDelta>("set_label_styles", { worksheet, values }),

  /** Replaces the code of a Julia block; one undo step. */
  setJuliaCode: (worksheet: string, region: string, code: string) =>
    invoke<EditResultDelta>("set_julia_code", { worksheet, region, code }),

  /** Trusts a worksheet or takes the trust back; no undo step. */
  setWorksheetTrusted: (worksheet: string, trusted: boolean) =>
    invoke<EditResultDelta>("set_worksheet_trusted", { worksheet, trusted }),

  /** Plays or stops a Julia block; one undo step. */
  /** evaluates a Julia block and its dependents again on the next pass. */
  runRegion: (worksheet: string, region: string) => invoke<EditResultDelta>("run_region", { worksheet, region }),
  setJuliaPlaying: (worksheet: string, region: string, playing: boolean) =>
    invoke<EditResultDelta>("set_julia_playing", { worksheet, region, playing }),

  /**
   * Sets the size in points of the box a Julia block is drawn in,
   * or `null` for a block that grows with its code; one undo step.
   */
  setJuliaSize: (worksheet: string, regionId: string, width: number | null, height: number | null) =>
    invoke<EditResultDelta>("set_julia_size", { worksheet, regionId, width, height }),

  /**
   * Sets (`string`) or removes (`null`) the worksheet calculation settings `TOL` and `CTOL`
   * ; one undo step and a recalculation of the whole worksheet.
   */
  setCalculationSettings: (worksheet: string, values: Record<string, string | null>) =>
    invoke<EditResultDelta>("set_calculation_settings", { worksheet, values }),

  /** Names, references, include tree and unit warnings; rejects with `busy` during a calculation. */
  inspect: (worksheet: string) => invoke<Inspection>("inspect", { worksheet }),

  /**
   * Only the unit warnings of `inspect` (the underlines in the math and the Problems count), so the
   * UI can ask for them after every edit without parsing the whole inspection.
   */
  inspectWarnings: (worksheet: string) => invoke<WarningInfo[]>("inspect_warnings", { worksheet }),

  /** Current values of definitions (a kernel read, no re-evaluation). */
  definitionValues: (worksheet: string, items: { name: string; version: number }[]) =>
    invoke<DefinitionValue[]>("definition_values", { worksheet, items }),

  /** The calculated data of a plot region, one binary frame (see `plot/frame.ts`). */
  plotData: async (worksheet: string, regionId: string) =>
    decodePlotFrame(await invoke<ArrayBuffer>("get_plot_data", { worksheet, regionId })),

  /** Replaces a plot region's specification (expressions, axes, size); one undo step. */
  setPlot: (worksheet: string, regionId: string, plot: PlotSpec) =>
    invoke<EditResultDelta>("set_plot", { worksheet, regionId, plot }),
  /** Replaces the path of an include region with the text the user typed; one undo step. */
  setIncludePath: (worksheet: string, regionId: string, path: string) =>
    invoke<EditResultDelta>("set_include_path", { worksheet, regionId, path }),

  /**
   * The x range the plot is showing on screen, which is the sample interval of its implicit x
   * trace; `null` ends are reset-to-data-range. Screen-only state: no undo step
   * and nothing written to the worksheet. `true` when the plot has something new to draw.
   */
  setPlotView: (worksheet: string, regionId: string, xMin: number | null, xMax: number | null) =>
    invoke<boolean>("set_plot_view", { worksheet, regionId, xMin, xMax }),

  /** Deletes regions; one undo step. */
  removeRegions: (worksheet: string, regionIds: string[]) =>
    invoke<EditResultDelta>("remove_regions", { worksheet, regionIds }),

  undo: (worksheet: string) => invoke<EditResultDelta>("undo", { worksheet }),

  redo: (worksheet: string) => invoke<EditResultDelta>("redo", { worksheet }),
};

// ---- events ----------------------------------------------------------------------------

export function onKernelStatus(
  handler: (status: KernelStatusEvent) => void,
): Promise<UnlistenFn> {
  return listen<KernelStatusEvent>(EVENT_KERNEL_STATUS, (event) =>
    handler(event.payload),
  );
}

/** The physical Ctrl key on Windows, sent by the native keyboard hook whenever it changes. */
export function onRealCtrl(handler: (down: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("real-ctrl", (event) => handler(event.payload));
}

/** A second launch queued files to open: the handler should call `takeOpenRequests`. */
export function onOpenRequest(handler: () => void): Promise<UnlistenFn> {
  return listen<null>(EVENT_OPEN_REQUEST, () => handler());
}

/**
 * Files dropped onto the window (the webview's native drag and drop gives paths, not File objects):
 * `position` is in CSS px from the window's top-left corner (the native event is in physical px).
 */
export function onFileDrop(
  handler: (paths: string[], position: { x: number; y: number }) => void,
): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop") return;
    const scale = window.devicePixelRatio || 1;
    handler(event.payload.paths, { x: event.payload.position.x / scale, y: event.payload.position.y / scale });
  });
}

export function onWorksheetEvent(
  handler: (event: WorksheetEvent) => void,
): Promise<UnlistenFn> {
  return listen<WorksheetEvent>(EVENT_WORKSHEET, (event) =>
    handler(event.payload),
  );
}

// ---- helpers ---------------------------------------------------------------------------

export function keyId(key: RegionKey): string {
  return `${key.document}#${key.region_id}#${key.instance}`;
}

/**
 * Applies the results that a batch of worksheet events carries (immutable). The positions are
 * found through an index built once for the whole batch, so a calculation pass costs O(N + events)
 * instead of one scan of the results per event; a later event for the same key wins.
 * `results` itself is returned when no event replaces an entry.
 */
/**
 * Where each result entry sits, by `keyId`, for the arrays `applyWorksheetEvents` worked on. A pass
 * sends its results in batches, one per frame, and each batch only replaces entries in place: the
 * copy it makes has the same positions, so it shares the index instead of building one again
 * .
 */
const resultIndexes = new WeakMap<readonly RegionEntry[], ReadonlyMap<string, number>>();

function resultIndex(results: readonly RegionEntry[]): ReadonlyMap<string, number> {
  let index = resultIndexes.get(results);
  if (!index) {
    const built = new Map<string, number>();
    results.forEach((entry, at) => built.set(keyId(entry.key), at));
    resultIndexes.set(results, built);
    index = built;
  }
  return index;
}

export function applyWorksheetEvents(
  results: RegionEntry[],
  events: WorksheetEvent[],
): RegionEntry[] {
  let index: ReadonlyMap<string, number> | null = null;
  let next: RegionEntry[] | null = null;
  for (const event of events) {
    if (event.event !== "region_updated") continue;
    index ??= resultIndex(results);
    const at = index.get(keyId(event.entry.key));
    if (at === undefined || (next ?? results)[at] === event.entry) continue;
    // The array is copied once per batch, on the first entry that really changes.
    next ??= results.slice();
    next[at] = event.entry;
  }
  if (next && index) resultIndexes.set(next, index);
  return next ?? results;
}

/** Applies one worksheet event to a results list (immutable). */
export function applyWorksheetEvent(
  results: RegionEntry[],
  event: WorksheetEvent,
): RegionEntry[] {
  return applyWorksheetEvents(results, [event]);
}

function formatFloat(value: WireFloat): string {
  switch (value) {
    case "nan":
      return "NaN";
    case "infinity":
      return "∞";
    case "-infinity":
      return "-∞";
    default:
      return String(value);
  }
}

function formatComplex(real: WireFloat, imag: WireFloat): string {
  const negative =
    typeof imag === "number" ? imag < 0 || Object.is(imag, -0) : imag === "-infinity";
  const magnitude = negative
    ? formatFloat(typeof imag === "number" ? -imag : "infinity")
    : formatFloat(imag);
  return `${formatFloat(real)} ${negative ? "-" : "+"} ${magnitude}i`;
}

/** A plain-text rendering of a value (the real result display is a later phase). */
export function formatValue(value: KernelValue | null): string {
  if (value === null) return "";
  switch (value.type) {
    case "real":
      return formatFloat(value.value);
    case "complex":
      return formatComplex(value.real, value.imag);
    case "string":
      return JSON.stringify(value.value);
    case "quantity": {
      const magnitude =
        value.magnitude.type === "real"
          ? formatFloat(value.magnitude.value)
          : formatComplex(value.magnitude.real, value.magnitude.imag);
      const dimension = value.dimension
        .map(({ base, power: [n, d] }) =>
          d === 1 ? (n === 1 ? base : `${base}^${n}`) : `${base}^${n}/${d}`,
        )
        .join("·");
      return `${magnitude} [SI: ${dimension}]`;
    }
    case "matrix": {
      const { rows, cols, storage } = value;
      if (rows * cols > 36 || storage.type !== "inline") return `${rows}×${cols} matrix`;
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) {
          // Column-major storage.
          cells.push(formatValue(storage.values[c * rows + r] ?? null));
        }
        lines.push(cells.join("  "));
      }
      return lines.join("\n");
    }
    case "handle":
      return `${value.julia_type}: ${value.summary}`;
    case "symbolic":
      return `→ ${value.text}`;
  }
}

/** One-line text for the state of a region (used by the development screen). */
export function describeState(state: RegionState): string {
  switch (state.state) {
    case "pending":
      return "pending";
    case "stale":
      return `stale ${formatValue(state.value)}`.trim();
    case "value":
      return state.value === null ? "defined" : formatValue(state.value);
    case "error":
      return `error: ${state.failure.message}`;
  }
}
