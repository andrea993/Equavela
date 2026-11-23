// The ribbon groups worksheet commands by task and offers controls for the active object.
// At most one contextual tab appears and is selected while
// its object is active, a search field that opens the command palette, and a compact mode. It is
// `.chrome`, so it is never printed.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { shortcutLabel } from "../keymap/keymap";
import type { PaletteKind } from "../catalog/palettes";
import type { PaletteAnchor } from "../workbench/usePalettes";
import type { Command } from "../editor/model";
import type { ParagraphAlign, ParagraphStyle, PlotSpec } from "../equavelaApi";
import { parseMatrixSizeField } from "../results/format";
import { S } from "../strings";
import type { CalcMode, ViewMode } from "../workbench/useWorkbench";
import { ColorPicker } from "./ColorPicker";
import { MATH_COLORS, MATH_HIGHLIGHTS } from "../math/font";
import { MATH_SIZES_PT } from "../math/font";
import { FONT_SIZES_PT, PARAGRAPH_ALIGNS, PARAGRAPH_STYLES, type TextFormatKind, type TextFormatState } from "../text/value";
import {
  type RibbonContext,
} from "../workbench/commandContext";
import { Group, ToolButton } from "./Chrome";
import { PlotTab } from "./PlotTab";
import { RibbonIcon, type RibbonIconName } from "./RibbonIcon";

/** Simple glyph icons (our own, drawn with text so no image assets are needed). */
const Icon = ({ children }: { children: ReactNode }) => <span className="glyph">{children}</span>;

export type RibbonProps = {
  hasDoc: boolean;
  hasProject?: boolean;
  canConvertToProject?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  hasSelection: boolean;
  fastSymbolicEnabled: boolean;
  onFastSymbolic: (anchor: DOMRectReadOnly) => void;
  /** An inline equation of the open text region has the keyboard: the equation commands act on it. */
  inlineEquation?: boolean;
  /** every selected region is disabled (the button then offers Enable Region). */
  selectionDisabled: boolean;
  running: boolean;
  calcMode: CalcMode;
  viewMode: ViewMode;
  /** the active object, or null. */
  context: RibbonContext | null;
  matrixControls: { canDeleteRow: boolean; canDeleteColumn: boolean; rows?: number; cols?: number } | null;
  /** The rows and columns of the matrix the tab acts on, shown read-only; null when there is none. */
  matrixShape?: { rows: number; cols: number } | null;
  /** The matrix result whose display the Matrix tab can choose, and the choice in force. */
  /** `nested` is null for a matrix result without matrix elements. */
  matrixDisplay: { indices: boolean; nested: boolean | null } | null;
  /** The worksheet size threshold of the Matrix tab's box, `format.matrix-size`. */
  matrixSize: { rows: number; cols: number } | null;
  compact: boolean;
  /** The format at the selection of the open text region; null until the editor reports it. */
  textFormat: TextFormatState | null;
  onTextFormat: (kind: TextFormatKind) => void;
  onTextSize: (pt: number | null) => void;
  /** The colour and highlight of the selection of the open text editor; null is the default. */
  onTextColor: (color: string | null) => void;
  onTextHighlight: (color: string | null) => void;
  /** The fill of the text region the commands act on (open or selected), else null. */
  textBackground: { color: string | null } | null;
  onTextBackground: (color: string | null) => void;
  /** The style of every paragraph the selection touches. */
  onParagraphStyle: (style: ParagraphStyle) => void;
  /** The alignment of every paragraph the selection touches. */
  onTextAlign: (align: ParagraphAlign) => void;
  onInsertInlineMath: () => void;
  /** Whether one selected or edited math region can receive a result-format override. */
  canFormatResult: boolean;
  /** The colours the worksheet already uses, for the colour pickers. */
  worksheetColors?: readonly string[];
  /** Whether there is a math region the math-font commands can act on. */
  canFormatMath: boolean;
  /** The size in points of the math-font targets: one number when they agree, `"mixed"` when they do not, null with no target. */
  mathSize: number | "mixed" | null;
  /** The size chosen in the Size field: every target gets it, in one undo step. */
  onMathSize: (pt: number) => void;
  problems: number;
  panelOpen: boolean;
  /** The spell checker is on. */
  spellingOn?: boolean;
  /** A window command by name (the same names as the keymap and the command palette). */
  onCommand: (cmd: string) => void;
  onEditorCommand: (command: Command) => void;
  /** Sets the display of the matrix result: one undo step of the region override. */
  onMatrixDisplay: (indices: boolean) => void;
  /** Expands or collapses the nested arrays of the target matrix result. */
  onMatrixNested: (expand: boolean) => void;
  /** Sets the worksheet size threshold: the display setting `format.matrix-size`. */
  onMatrixSize: (rows: number, cols: number) => void;
  /** Stores an edited plot specification (Plot tab controls): one undo step. */
  onPlotSpec: (plot: PlotSpec) => void;
  /** Selects (or clears) a trace of the selected plot (Plot tab trace list). */
  onPlotSelectTrace: (traceId: string | null) => void;
  /** Opens (or closes) a palette of the insert panel under the pressed button. */
  onPalette: (kind: PaletteKind, anchor?: PaletteAnchor) => void;
  openPalettes: readonly PaletteKind[];
  /** a project file tab is in front; the ribbon shows only its Code or Image file tab. */
  file?: { kind: "text" | "image"; julia: boolean; modified: boolean; moduleLoaded: boolean | null } | null;
};

const TASK_TABS = ["File", "Edit", "Insert", "Math", "Calculate", "View", "Help"] as const;
type TaskTab = (typeof TASK_TABS)[number];

export function Ribbon(props: RibbonProps) {
  const contextKind = props.context?.kind ?? null;
  const [taskTab, setTaskTab] = useState<TaskTab>("Insert");
  const [contextSelection, setContextSelection] = useState({ kind: contextKind, selected: true });
  const [collapsed, setCollapsed] = useState(false);
  const tabList = useRef<HTMLDivElement>(null);
  if (contextSelection.kind !== contextKind) {
    setContextSelection({ kind: contextKind, selected: true });
  }
  const activeContext = contextSelection.kind === contextKind && contextSelection.selected ? contextKind : null;
  const file = props.file ?? null;
  const fileLabel = file?.kind === "image" ? S.code.imageTab : S.code.tab;
  const searchKeys = shortcutLabel("commandPalette");

  useEffect(() => {
    tabList.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeContext, taskTab, file?.kind]);

  return (
    <nav className={`chrome ribbon${props.compact ? " compact" : ""}`} aria-label={S.ribbon.label}>
      <div className="ribbon-tabs">
        <div className="ribbon-tablist" role="tablist" ref={tabList} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.findIndex((item) => item === event.target);
          if (current < 0) return;
          event.preventDefault();
          event.stopPropagation();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
            (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          tabs[next].focus();
          tabs[next].click();
        }}>
          {file && <button type="button" role="tab" aria-selected className="ribbon-tab active" onClick={() => setCollapsed(false)}>{fileLabel}</button>}
          {!file && TASK_TABS.map((name) => (
            <button key={name} type="button" role="tab"
              aria-selected={activeContext === null && taskTab === name}
              tabIndex={activeContext === null && taskTab === name ? 0 : -1}
              className={`ribbon-tab${activeContext === null && taskTab === name ? " active" : ""}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setTaskTab(name);
                setContextSelection({ kind: contextKind, selected: false });
                setCollapsed(false);
              }}>{name}</button>
          ))}
          {!file && contextKind && (
            <button type="button" role="tab" aria-selected={activeContext !== null} tabIndex={activeContext ? 0 : -1}
              className={`ribbon-tab contextual${activeContext ? " active" : ""}`} title={S.ribbon.contextual}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setContextSelection({ kind: contextKind, selected: true });
                setCollapsed(false);
              }}>
              {S.ribbon.tabs[contextKind]}
            </button>
          )}
        </div>
        <span className="grow" />
        {!file && <ToolButton className={props.running ? "command-stop" : "command-stop idle"} label="Stop calculation" icon={<RibbonIcon name="stop" />} iconOnly
          disabled={!props.running} keepFocus onClick={() => props.onCommand("stop")} />}
        <button
          type="button"
          className="ribbon-search"
          aria-label={S.ribbon.search}
          title={searchKeys ? `${S.ribbon.search} (${searchKeys})` : S.ribbon.search}
          onClick={() => props.onCommand("commandPalette")}
        >
          <span className="ribbon-search-icon" aria-hidden="true">⌕</span>
          <span className="ribbon-search-text">{S.ribbon.searchPlaceholder}</span>
          {searchKeys && <kbd>{searchKeys}</kbd>}
        </button>
        <button
          type="button"
          className={`ribbon-compact${props.compact ? " active" : ""}`}
          title={S.ribbon.compact}
          aria-label={S.ribbon.compact}
          aria-pressed={props.compact}
          onClick={() => props.onCommand("toggleCompactRibbon")}
        >
          ▭
        </button>
        <button
          type="button"
          className="ribbon-collapse"
          title={collapsed ? S.ribbon.expand : S.ribbon.collapse}
          aria-label={collapsed ? S.ribbon.expand : S.ribbon.collapse}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? "▾" : "▴"}
        </button>
      </div>
      {!collapsed && (
        <RibbonBody label={file ? fileLabel : activeContext ? S.ribbon.tabs[activeContext] : taskTab} task={!file && !activeContext}>
          {file ? <FileTabRibbon {...props} file={file} /> : activeContext === null ? <TaskCommands {...props} tab={taskTab} /> : (
            <>
              {activeContext === "text" && <TextTab {...props} />}
              {activeContext === "matrix" && <MatrixTab {...props} />}
              {activeContext === "plot" && props.context?.kind === "plot" && <PlotTab context={props.context} onCommand={props.onCommand} onPlotSpec={props.onPlotSpec} onPlotSelectTrace={props.onPlotSelectTrace} worksheetColors={props.worksheetColors} />}
              {activeContext === "area" && props.context?.kind === "area" && <AreaTab {...props} context={props.context} />}
              {activeContext === "image" && <ImageTab {...props} />}
            </>
          )}
        </RibbonBody>
      )}
    </nav>
  );
}

/** the label plus the chord of the first command that has one. */

/**
 * The ribbon body: it scrolls sideways when its groups do not fit, and then shows an
 * arrow at each edge with more commands past it. An arrow scrolls by most of the visible width; the
 * vertical wheel scrolls sideways too, so no horizontal wheel is needed. The arrows never take the
 * focus from the sheet.
 */
function RibbonBody({ label, task, children }: { label: string; task: boolean; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => {
      const left = element.scrollLeft > 1;
      const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setMore((current) => (current.left === left && current.right === right ? current : { left, right }));
    };
    measure();
    element.addEventListener("scroll", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    for (const child of element.children) observer?.observe(child);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [children]);
  const scroll = (direction: -1 | 1) => {
    const element = body.current;
    if (element) element.scrollBy({ left: direction * Math.max(80, element.clientWidth * 0.75), behavior: "smooth" });
  };
  return (
    <div className="ribbon-body-frame">
      <div
        ref={body}
        className={task ? "ribbon-body ribbon-task" : "ribbon-body"}
        role="tabpanel"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " ")) event.stopPropagation();
        }}
        onWheel={(event) => {
          const element = body.current;
          if (!element || event.deltaX !== 0 || element.scrollWidth <= element.clientWidth) return;
          element.scrollLeft += event.deltaY;
        }}
      >
        {children}
      </div>
      {more.left && (
        <button type="button" className="ribbon-scroll left" tabIndex={-1} aria-label={S.ribbon.scrollLeft}
          title={S.ribbon.scrollLeft} onMouseDown={(event) => event.preventDefault()} onClick={() => scroll(-1)} data-testid="ribbon-scroll-left">‹</button>
      )}
      {more.right && (
        <button type="button" className="ribbon-scroll right" tabIndex={-1} aria-label={S.ribbon.scrollRight}
          title={S.ribbon.scrollRight} onMouseDown={(event) => event.preventDefault()} onClick={() => scroll(1)} data-testid="ribbon-scroll-right">›</button>
      )}
    </div>
  );
}

function tip(label: string, ...commands: string[]): string {
  for (const cmd of commands) {
    const keys = shortcutLabel(cmd);
    if (keys) return `${label} (${keys})`;
  }
  return label;
}

/**
 * A checkbox command of a ribbon group: a real checkbox, so its state is the
 * control's own, with the label beside it. A press with the pointer does not take the keyboard from
 * the math editor; Tab still reaches it, so it can also be toggled from the keyboard.
 */
function CheckButton({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="tool check" title={label} onMouseDown={(event) => event.preventDefault()}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="tool-label">{label}</span>
    </label>
  );
}

function PaletteButton(props: RibbonProps & { kind: PaletteKind; label: string; icon: RibbonIconName }) {
  return (
    <ToolButton
      keepFocus
      label={props.label}
      icon={<RibbonIcon name={props.icon} />}
      disabled={!props.hasDoc}
      active={props.openPalettes.includes(props.kind)}
      paletteKind={props.kind}
      onClick={(event) => props.onPalette(props.kind, event.currentTarget.getBoundingClientRect())}
    />
  );
}

/** the Code tab of a project text file, or the Image file tab of an image. */
function FileTabRibbon(props: RibbonProps & { file: NonNullable<RibbonProps["file"]> }) {
  const C = S.code;
  const run = (cmd: string) => () => props.onCommand(cmd);
  const { file } = props;
  const reveal = <ToolButton label={C.showInFolder} icon={<Icon>⌂</Icon>} onClick={run("fileReveal")} />;
  const external = <ToolButton label={C.openExternal} icon={<Icon>↗</Icon>} onClick={run("fileOpenExternal")} />;
  if (file.kind === "image") return <Group title={C.groups.file}>{reveal}{external}</Group>;
  return (
    <>
      <Group title={C.groups.file}>
        <ToolButton label={C.save} title={`${C.save} (Ctrl+S)`} icon={<Icon>▣</Icon>} disabled={!file.modified} onClick={run("fileSave")} />
        <ToolButton label={C.reload} icon={<Icon>⟳</Icon>} onClick={run("fileReload")} />
        {reveal}
        {external}
      </Group>
      <Group title={C.groups.edit}>
        <div className="ribbon-commands stacked">
          <ToolButton label={C.undo} title={`${C.undo} (Ctrl+Z)`} icon={<Icon>↶</Icon>} onClick={run("codeUndo")} />
          <ToolButton label={C.redo} title={`${C.redo} (Ctrl+Y)`} icon={<Icon>↷</Icon>} onClick={run("codeRedo")} />
          <ToolButton label={C.cut} icon={<Icon>✂</Icon>} onClick={run("codeCut")} />
          <ToolButton label={C.copy} icon={<Icon>⧉</Icon>} onClick={run("codeCopy")} />
          <ToolButton label={C.paste} icon={<Icon>▤</Icon>} onClick={run("codePaste")} />
          <ToolButton label={C.find} title={`${C.find} (Ctrl+F)`} icon={<Icon>⌕</Icon>} onClick={run("codeFind")} />
          <ToolButton label={C.replace} title={`${C.replace} (Ctrl+H)`} icon={<Icon>⇄</Icon>} onClick={run("codeReplace")} />
          <ToolButton label={C.goToLine} title={`${C.goToLine} (Ctrl+G)`} icon={<Icon>#</Icon>} onClick={run("codeGoToLine")} />
        </div>
      </Group>
      <Group title={C.groups.code}>
        <div className="ribbon-commands stacked">
          <ToolButton label={C.toggleComment} title={`${C.toggleComment} (Ctrl+/)`} icon={<Icon>#!</Icon>} onClick={run("codeToggleComment")} />
          <ToolButton label={C.indent} title={`${C.indent} (Tab)`} icon={<Icon>⇥</Icon>} onClick={run("codeIndent")} />
          <ToolButton label={C.outdent} title={`${C.outdent} (Shift+Tab)`} icon={<Icon>⇤</Icon>} onClick={run("codeOutdent")} />
          <ToolButton label={C.duplicateLine} title={`${C.duplicateLine} (Shift+Alt+Down)`} icon={<Icon>⇊</Icon>} onClick={run("codeDuplicateLine")} />
          <ToolButton label={C.moveLineUp} title={`${C.moveLineUp} (Alt+Up)`} icon={<Icon>↑</Icon>} onClick={run("codeMoveLineUp")} />
          <ToolButton label={C.moveLineDown} title={`${C.moveLineDown} (Alt+Down)`} icon={<Icon>↓</Icon>} onClick={run("codeMoveLineDown")} />
        </div>
      </Group>
      {file.julia && (
        <Group title={C.groups.julia}>
          <div className="ribbon-commands stacked">
            {file.moduleLoaded !== null && (
              <CheckButton label={S.juliaModule.load} checked={file.moduleLoaded} onChange={() => props.onCommand("fileToggleModule")} />
            )}
            <ToolButton label={C.restartKernel} icon={<Icon>⟲</Icon>} onClick={run("fileRestartKernel")} />
            <ToolButton label={C.environment} icon={<Icon>⚙</Icon>} onClick={run("fileEnvironment")} />
          </div>
        </Group>
      )}
    </>
  );
}

function TaskCommands(props: RibbonProps & { tab: TaskTab }) {
  const C = S.ribbon.commands;
  const run = (cmd: string) => () => props.onCommand(cmd);
  const off = !props.hasDoc;
  const idle = off || props.running;
  return (
    <>
      {props.tab === "Insert" && <>
      <Group title="Write">
        <ToolButton keepFocus label={C.math} icon={<RibbonIcon name="mathRegion" />} title={tip(C.math, "insertMath")} disabled={off} onClick={run("insertMath")} />
        <ToolButton keepFocus label={C.text} icon={<RibbonIcon name="paragraph" />} title={tip(C.text, "insertText")} disabled={off} onClick={run("insertText")} />
        <ToolButton keepFocus label={C.textBox} icon={<RibbonIcon name="textBox" />} title={tip(C.textBox, "insertTextRegion")} disabled={off} onClick={run("insertTextRegion")} />
      </Group>
      <Group title="Build an expression" stacked roomy>
        <FormulaButton {...props} command="frac" label="Fraction" glyph="a⁄b" />
        <FormulaButton {...props} command="pow" label="Power" glyph="xʸ" />
        <FormulaButton {...props} command="sqrt" label="Square root" glyph="√x" />
      </Group>
      <Group title="Calculus and series" stacked roomy>
        <FormulaButton {...props} command="deriv" label="Derivative" glyph="d/dx" />
        <FormulaButton {...props} command="integral" label="Integral" glyph="∫" />
        <FormulaButton {...props} command="sum" label="Sum" glyph="∑" />
      </Group>
      <Group title="Data and figures">
        <ToolButton keepFocus label={C.plot} icon={<RibbonIcon name="plot" />} disabled={off} onClick={run("insertPlot")} />
        <ToolButton keepFocus label={C.insertMatrix} icon={<RibbonIcon name="matrix" />} title={tip(C.insertMatrix, "matrix")} disabled={off} onClick={run("matrixDialog")} />
        <ToolButton keepFocus label="Table" icon={<RibbonIcon name="table" />} disabled={off} onClick={run("insertTable")} />
        <ToolButton keepFocus label={C.image} icon={<RibbonIcon name="image" />} disabled={off} onClick={run("insertImage")} />
      </Group>
      <Group title="Structure and references" stacked roomy>
        <ToolButton keepFocus label={C.area} icon={<RibbonIcon name="area" />} disabled={off} onClick={run("insertArea")} />
        <ToolButton keepFocus label={C.include} icon={<RibbonIcon name="include" />} disabled={off} onClick={run("insertInclude")} />
        <ToolButton keepFocus label={C.julia} icon={<RibbonIcon name="terminal" />} disabled={off} onClick={run("insertJulia")} />
      </Group>
      </>}
      {props.tab === "Math" && <>
        <Group title="Notation" stacked roomy>
          <PaletteButton {...props} kind="operators" label={C.operators} icon="operators" />
          <PaletteButton {...props} kind="symbols" label={C.symbols} icon="symbols" />
          <ToolButton keepFocus label={C.insertSearch} icon={<RibbonIcon name="find" />} title={tip(S.commands.insertSearch, "insertSearch")} disabled={off} onClick={run("insertSearch")} />
          <ToolButton keepFocus label={C.subscript} icon={<Icon>x.y</Icon>} title={tip(C.subscript, "literalSubscript")} disabled={off} onClick={() => props.onEditorCommand("literalSubscript")} />
        </Group>
        <Group title="Quantities" stacked roomy>
          <PaletteButton {...props} kind="units" label={C.unitsPalette} icon="units" />
          <PaletteButton {...props} kind="constants" label={C.constants} icon="constants" />
          <ToolButton keepFocus label={C.labels} icon={<Icon>ℓ</Icon>} title={tip(C.labels, "label")} disabled={off} onClick={() => props.onEditorCommand("label")} />
        </Group>
        <Group title="Functions and programs" stacked roomy>
          <ToolButton keepFocus label={C.functions} icon={<Icon>ƒ</Icon>} title={tip(C.functions, "functionCatalogue")} onClick={run("functionCatalogue")} />
          <PaletteButton {...props} kind="matrixFunctions" label={C.matrixFunctions} icon="matrix" />
          <PaletteButton {...props} kind="programming" label={C.programming} icon="programming" />
        </Group>
        <Group title="Symbolic analysis" stacked>
          <PaletteButton {...props} kind="symbolics" label={C.symbolics} icon="symbolics" />
          <ToolButton keepFocus label="Fast Symbolic" title="Fast Symbolic (Alt+S)"
            icon={<Icon>ƒ↵</Icon>} disabled={!props.fastSymbolicEnabled}
            onClick={event => props.onFastSymbolic(event.currentTarget.getBoundingClientRect())} />
        </Group>
      </>}
      {props.tab === "Math" && <Group title="Line layout" stacked>
        <ToolButton keepFocus label={C.equationBreak} icon={<Icon>+↵</Icon>} title={tip(C.equationBreak, "toggleBreak")} disabled={off} onClick={() => props.onEditorCommand("toggleBreak")} />
        <ToolButton keepFocus label={C.lineBreak} icon={<Icon>↵</Icon>} title={tip(C.lineBreak, "insertLineBreak")} disabled={off} onClick={() => props.onEditorCommand("insertLineBreak")} />
      </Group>}
      {props.tab === "Edit" && <Group title={S.ribbon.groups.edit} stacked roomy>
        <ToolButton keepFocus label="Undo" title={tip("Undo", "undo")} disabled={!props.canUndo} icon={<RibbonIcon name="undo" />} onClick={run("undo")} />
        <ToolButton keepFocus label="Redo" title={tip("Redo", "redo")} disabled={!props.canRedo} icon={<RibbonIcon name="redo" />} onClick={run("redo")} />
        <ToolButton keepFocus label={C.cut} icon={<RibbonIcon name="cut" />} title={tip(C.cut, "cut")} disabled={off} onClick={run("cut")} />
        <ToolButton keepFocus label={C.copy} icon={<RibbonIcon name="copy" />} title={tip(C.copy, "copy")} disabled={off} onClick={run("copy")} />
        <ToolButton keepFocus label={C.paste} icon={<RibbonIcon name="paste" />} title={tip(C.paste, "paste")} disabled={off} onClick={run("paste")} />
        <ToolButton keepFocus label="Find…" title={tip("Find…", "find")} disabled={off} icon={<RibbonIcon name="find" />} onClick={run("find")} />
        <ToolButton keepFocus label="Replace…" title={tip("Replace…", "replace")} disabled={off} icon={<RibbonIcon name="replace" />} onClick={run("replace")} />
        <ToolButton keepFocus label={C.deleteRegion} icon={<RibbonIcon name="delete" />} title={tip(C.deleteRegion, "deleteRegions")} disabled={!props.hasSelection} onClick={run("deleteRegions")} />
        <ToolButton keepFocus label={C.selectAll} icon={<RibbonIcon name="select" />} title={tip(C.selectAll, "selectAll")} disabled={off} onClick={run("selectAll")} />
      </Group>}
      {props.tab === "Insert" && <>
      <Group title={S.ribbon.groups.page}>
        <ToolButton keepFocus label={C.pageSetup} icon={<RibbonIcon name="pageSetup" />} disabled={!props.hasDoc} onClick={run("pageSetup")} />
        <ToolButton keepFocus label={C.headerFooter} icon={<RibbonIcon name="headerFooter" />} disabled={!props.hasDoc} onClick={run("headerFooter")} />
      </Group>
      <Group title={S.ribbon.groups.spacing} stacked roomy>
        {/* they act at the crosshair; no chord on either layout. */}
        <ToolButton keepFocus label={C.addPageBreak} icon={<RibbonIcon name="pageBreak" />} disabled={!props.hasDoc} onClick={run("addPageBreak")} />
        <ToolButton keepFocus label={C.addSpace} icon={<RibbonIcon name="addSpace" />} disabled={!props.hasDoc} onClick={run("addSpace")} />
        <ToolButton keepFocus label={C.removeSpace} icon={<RibbonIcon name="removeSpace" />} disabled={!props.hasDoc} onClick={run("removeSpace")} />
      </Group>
      </>}
      {props.tab === "Math" && <>
      <Group title={S.ribbon.groups.results} stacked>
        <ToolButton
          label={C.resultFormat}
          icon={<Icon>0.00</Icon>}
          disabled={!props.canFormatResult}
          title={props.canFormatResult ? C.resultFormat : S.resultFormat.noRegion}
          onClick={run("resultFormat")}
        />
        {/* the worksheet default needs no target, only a worksheet. */}
        <ToolButton
          label={C.worksheetFormat}
          icon={<Icon>≡0.0</Icon>}
          disabled={!props.hasDoc}
          title={tip(C.worksheetFormat, "worksheetFormat")}
          onClick={run("worksheetFormat")}
        />
      </Group>
      <Group title={S.ribbon.groups.mathFormatting} stacked>
        {/* a direct size, as the text tab has; the list is the reference application's, and a size the file holds
            that is not on it (6 to 72 pt, whole) is shown as it is. */}
        <label className="size-picker" title={props.canFormatMath ? S.mathFont.size : S.mathFont.noRegion}>
          <span className="tool-label">{S.mathFont.size}</span>
          <select
            aria-label={S.mathFont.size}
            data-testid="math-size"
            disabled={!props.canFormatMath}
            value={props.mathSize === null || props.mathSize === "mixed" ? "" : props.mathSize}
            onChange={(event) => event.target.value !== "" && props.onMathSize(Number(event.target.value))}
          >
            {(props.mathSize === null || props.mathSize === "mixed") && <option value="">{props.mathSize === "mixed" ? S.mathFont.mixedSize : ""}</option>}
            {typeof props.mathSize === "number" && !(MATH_SIZES_PT as readonly number[]).includes(props.mathSize) && <option value={props.mathSize}>{props.mathSize} pt</option>}
            {MATH_SIZES_PT.map((pt) => (
              <option key={pt} value={pt}>
                {pt} pt
              </option>
            ))}
          </select>
        </label>
        <ToolButton
          label={C.mathFont}
          icon={<Icon>Aa</Icon>}
          title={props.canFormatMath ? tip(C.mathFont, "mathFont") : S.mathFont.noRegion}
          disabled={!props.canFormatMath}
          onClick={run("mathFont")}
        />
        <ToolButton
          label={C.resetMathFont}
          icon={<Icon>A</Icon>}
          title={props.canFormatMath ? tip(C.resetMathFont, "resetMathFont") : S.mathFont.noRegion}
          disabled={!props.canFormatMath}
          onClick={run("resetMathFont")}
        />
        <ToolButton
          label={C.decreaseFontSize}
          icon={<Icon>A−</Icon>}
          title={props.canFormatMath ? tip(C.decreaseFontSize, "decreaseFontSize") : S.mathFont.noRegion}
          disabled={!props.canFormatMath}
          onClick={run("decreaseFontSize")}
        />
        <ToolButton
          label={C.increaseFontSize}
          icon={<Icon>A+</Icon>}
          title={props.canFormatMath ? tip(C.increaseFontSize, "increaseFontSize") : S.mathFont.noRegion}
          disabled={!props.canFormatMath}
          onClick={run("increaseFontSize")}
        />
      </Group>
      <Group title={S.ribbon.groups.labelStyles} stacked>
        <ToolButton
          label={C.labelStyles}
          icon={<Icon>Abc</Icon>}
          title={props.hasDoc ? tip(C.labelStyles, "labelStyles") : S.labelStyles.needsWorksheet}
          disabled={!props.hasDoc}
          onClick={run("labelStyles")}
        />
      </Group>
      </>}
      {props.tab === "Calculate" && <>
      <Group title={S.ribbon.groups.calculate}>
        <ToolButton keepFocus label={C.recalculate} icon={<RibbonIcon name="run" />} title={tip(C.recalculate, "calculate")} disabled={idle} onClick={run("calculate")} />
        <ToolButton keepFocus label={C.recalculateAll} icon={<RibbonIcon name="runAll" />} title={tip(C.recalculateAll, "calculateAll")} disabled={idle} onClick={run("calculateAll")} />
        <ToolButton keepFocus label={C.automatic} icon={<RibbonIcon name="auto" />} disabled={!props.hasDoc} active={props.calcMode === "auto"} onClick={run("toggleCalculation")} />
        <ToolButton keepFocus label={C.stop} icon={<RibbonIcon name="stop" />} disabled={!props.running} onClick={run("stop")} />
        <ToolButton
          label={props.selectionDisabled ? C.enableRegion : C.disableRegion}
          icon={<Icon>⊘</Icon>}
          title={props.hasSelection || props.inlineEquation ? (props.selectionDisabled ? C.enableRegion : C.disableRegion) : S.ribbon.needsRegion}
          active={(props.hasSelection || !!props.inlineEquation) && props.selectionDisabled}
          // The press must not take the keyboard from the inline equation the command acts on.
          keepFocus
          disabled={!props.hasSelection && !props.inlineEquation}
          onClick={run("toggleRegionEnabled")}
        />
      </Group>
      <Group title={S.ribbon.groups.settings}>
        {/* one dialog for ORIGIN and the two worksheet tolerances. */}
        <ToolButton
          label={C.calculationSettings}
          icon={<RibbonIcon name="settings" />}
          disabled={!props.hasDoc}
          title={tip(C.calculationSettings, "calculationSettings")}
          onClick={run("calculationSettings")}
        />
      </Group>
      <Group title={S.ribbon.groups.problems} stacked roomy>
        <ToolButton keepFocus label={C.previousProblem} icon={<Icon>▲</Icon>} disabled={props.problems === 0} title={props.problems === 0 ? S.ribbon.noProblems : C.previousProblem} onClick={run("previousProblem")} />
        <ToolButton keepFocus label={C.nextProblem} icon={<Icon>▼</Icon>} disabled={props.problems === 0} title={props.problems === 0 ? S.ribbon.noProblems : C.nextProblem} onClick={run("nextProblem")} />
        <ToolButton keepFocus label={C.problemsPanel(props.problems)} icon={<Icon>⚠</Icon>} disabled={!props.hasDoc} onClick={run("problemsPanel")} />
      </Group>
      </>}
      {props.tab === "Edit" && <>
      <Group title={S.ribbon.groups.proofing} stacked roomy>
        <ToolButton keepFocus label={C.checkSpelling} icon={<Icon>✓</Icon>} active={props.spellingOn ?? false} onClick={run("toggleSpelling")} />
        <ToolButton keepFocus label={C.spelling} icon={<Icon>Ab</Icon>} disabled={!props.hasDoc} onClick={run("spelling")} />
      </Group>
      </>}
      {props.tab === "View" && <>
      <Group title={S.ribbon.groups.view}>
        <ToolButton keepFocus label={C.pageView} icon={<RibbonIcon name="pageView" />} active={props.viewMode === "page"} onClick={run("pageView")} />
        <ToolButton keepFocus label={C.draftView} icon={<RibbonIcon name="draftView" />} active={props.viewMode === "draft"} onClick={run("draftView")} />
        <ToolButton keepFocus label="Julia REPL" icon={<RibbonIcon name="terminal" />} onClick={run("toggleRepl")} />
        <ToolButton keepFocus label="Compact controls" active={props.compact} icon={<RibbonIcon name="compact" />} onClick={run("toggleCompactRibbon")} />
        <ToolButton keepFocus label={C.sidePanel} icon={<RibbonIcon name="panel" />} active={props.panelOpen} disabled={!props.hasDoc} onClick={run("sidePanel")} />
      </Group>
      <Group title={S.ribbon.groups.zoom} stacked roomy>
        <ToolButton keepFocus label={C.zoomOut} icon={<Icon>−</Icon>} onClick={run("zoomOut")} />
        <ToolButton keepFocus label={C.zoomIn} icon={<Icon>＋</Icon>} onClick={run("zoomIn")} />
        <ToolButton keepFocus label={C.zoomReset} icon={<Icon>1:1</Icon>} title={tip(C.zoomReset, "zoomReset")} onClick={run("zoomReset")} />
        <ToolButton keepFocus label={C.fitWidth} icon={<Icon>↔</Icon>} disabled={!props.hasDoc} onClick={run("fitWidth")} />
        <ToolButton keepFocus label={C.fitPage} icon={<RibbonIcon name="pageView" />} disabled={!props.hasDoc} onClick={run("fitPage")} />
      </Group>
      </>}
      {props.tab === "File" && <>
        <FileCommands {...props} />
      <Group title={S.ribbon.groups.io}>
        <ToolButton keepFocus label={C.importMcdx} icon={<RibbonIcon name="importFile" />} title={S.ribbon.importMcdxTitle} onClick={run("importMcdx")} />
        <ToolButton keepFocus label={C.exportPdf} icon={<RibbonIcon name="exportPdf" />} disabled={!props.hasDoc} onClick={run("exportPdf")} />
        <ToolButton keepFocus label={C.print} icon={<RibbonIcon name="print" />} title={tip(C.print, "print")} disabled={!props.hasDoc} onClick={run("print")} />
      </Group>
      <Group title={S.ribbon.groups.file} stacked>
        <ToolButton keepFocus label={C.options} icon={<RibbonIcon name="settings" />} onClick={run("options")} />
      </Group>
      </>}
      {props.tab === "Help" && <HelpTab {...props} />}
    </>
  );
}

function FormulaButton(props: RibbonProps & { command: Command; label: string; glyph: string }) {
  return <ToolButton keepFocus label={props.label} icon={<Icon>{props.glyph}</Icon>}
    title={tip(props.label, props.command)} disabled={!props.hasDoc}
    onClick={() => props.onEditorCommand(props.command)} />;
}

function FileCommands(props: RibbonProps) {
  const item = (label: string, command: string, icon: RibbonIconName, disabled = false, iconOnly = false) => (
    <ToolButton keepFocus label={label} icon={<RibbonIcon name={icon} />} iconOnly={iconOnly}
      title={tip(label, command)} disabled={disabled} onClick={() => props.onCommand(command)} />
  );
  return (
    <>
      <Group title="Worksheet">
        {item("New worksheet", "newDocument", "newSheet")}
        {item("Open worksheet…", "openDocument", "openSheet")}
        {item("Save worksheet", "save", "saveSheet", !props.hasDoc)}
        {item("Save worksheet as…", "saveAs", "saveAs", !props.hasDoc)}
        {item("Close worksheet", "closeDocument", "closeSheet", !props.hasDoc)}
      </Group>
      <Group title="Projects">
        {item("New project…", "newProject", "newProject")}
        {item("Open project…", "openProject", "openProject")}
        {item("Save project", "saveProject", "saveProject", !props.hasProject)}
      </Group>
      <Group title="Project tools" stacked roomy>
        {item("Convert worksheet to project…", "convertToProject", "convert", !props.canConvertToProject, true)}
        {item("Project settings…", "projectSettings", "settings", !props.hasProject, true)}
        {item("Julia environment…", "juliaEnvironment", "terminal", !props.hasDoc, true)}
        {item("Extract .eqvz…", "extractProject", "unpack", false, true)}
        {item("Pack project as .eqvz…", "packProject", "pack", !props.hasProject, true)}
        {item("Close project", "closeProject", "closeProject", !props.hasProject, true)}
      </Group>
    </>
  );
}

function HelpTab(props: RibbonProps) {
  const C = S.ribbon.commands;
  const run = (cmd: string) => () => props.onCommand(cmd);
  return (
    <Group title={S.ribbon.groups.help}>
      <ToolButton keepFocus label={C.commandPalette} icon={<RibbonIcon name="find" />} title={tip(C.commandPalette, "commandPalette")} onClick={run("commandPalette")} />
      <ToolButton keepFocus label={C.functionCatalogue} icon={<Icon>ƒ</Icon>} title={tip(C.functionCatalogue, "functionCatalogue")} onClick={run("functionCatalogue")} />
      <ToolButton keepFocus label={C.shortcutSheet} icon={<RibbonIcon name="keyboard" />} onClick={run("shortcutSheet")} />
      <ToolButton keepFocus label={C.functionHelp} icon={<RibbonIcon name="help" />} title={tip(C.functionHelp, "functionHelp")} onClick={run("functionHelp")} />
      <ToolButton keepFocus label={C.manual} icon={<Icon>?</Icon>} onClick={run("openManual")} />
    </Group>
  );
}

/** The labels of the Paragraph group of the Text tab. */
const ALIGN_LABEL: Record<ParagraphAlign, string> = {
  left: S.text.alignLeft,
  center: S.text.alignCenter,
  right: S.text.alignRight,
  justify: S.text.justify,
};
const ALIGN_GLYPH: Record<ParagraphAlign, ReactNode> = {
  left: "⯇",
  center: "⯈⯇",
  right: "⯈",
  justify: "☰",
};

/** The labels of the Text Styles group of the Text tab. */
const STYLE_LABEL: Record<ParagraphStyle, string> = {
  normal: S.text.styleNormal,
  title: S.text.styleTitle,
  subtitle: S.text.styleSubtitle,
  heading1: S.text.styleHeading1,
  heading2: S.text.styleHeading2,
  heading3: S.text.styleHeading3,
};
const STYLE_GLYPH: Record<ParagraphStyle, ReactNode> = {
  normal: "T",
  title: "T¹",
  subtitle: "T²",
  heading1: "H1",
  heading2: "H2",
  heading3: "H3",
};

function TextTab(props: RibbonProps) {
  const format = props.textFormat;
  const off = format === null;
  const toggle = (kind: TextFormatKind, label: string, cmd: string, glyph: ReactNode) => (
    <ToolButton
      label={label}
      title={off ? S.text.needsTextRegion : tip(label, cmd)}
      icon={<Icon>{glyph}</Icon>}
      keepFocus
      disabled={off}
      active={format ? format[kind] : false}
      onClick={() => props.onTextFormat(kind)}
    />
  );
  return (
    <>
      <Group title={S.ribbon.groups.font}>
        {toggle("bold", S.text.bold, "toggleBold", <b>B</b>)}
        {toggle("italic", S.text.italic, "toggleItalic", <i>I</i>)}
        {toggle("underline", S.text.underline, "toggleUnderline", <u>U</u>)}
        {toggle("sub", S.text.subscript, "", "x₂")}
        {toggle("sup", S.text.superscript, "", "x²")}
        <label className="size-picker" title={off ? S.text.needsTextRegion : S.text.fontSize}>
          <span className="tool-label">{S.text.fontSize}</span>
          <select
            aria-label={S.text.fontSize}
            disabled={off}
            value={format?.size ?? ""}
            onChange={(event) => props.onTextSize(event.target.value === "" ? null : Number(event.target.value))}
          >
            <option value="">{S.text.defaultSize}</option>
            {FONT_SIZES_PT.map((pt) => (
              <option key={pt} value={pt}>
                {pt} pt
              </option>
            ))}
          </select>
        </label>
      </Group>
      <Group title={S.ribbon.groups.color}>
        <ColorPicker
          label={S.text.textColor}
          none={S.text.defaultColor}
          // The first swatch of the palette is the automatic black: that is "Default" here.
          colors={MATH_COLORS.slice(1).map(({ value, name }) => ({ value, name }))}
          value={format?.color ?? null}
          disabled={off}
          title={off ? S.text.needsTextRegion : S.text.textColor}
          onPick={props.onTextColor}
        />
        <ColorPicker
          label={S.text.highlight}
          none={S.text.noColor}
          colors={MATH_HIGHLIGHTS.slice(1).map(({ value, name }) => ({ value: value as string, name }))}
          value={format?.highlight ?? null}
          disabled={off}
          title={off ? S.text.needsTextRegion : S.text.highlight}
          onPick={props.onTextHighlight}
        />
        <ColorPicker
          label={S.text.regionBackground}
          none={S.text.noColor}
          colors={MATH_HIGHLIGHTS.slice(1).map(({ value, name }) => ({ value: value as string, name }))}
          value={props.textBackground?.color ?? null}
          disabled={props.textBackground === null}
          title={props.textBackground === null ? S.text.needsRegionForBackground : S.text.regionBackground}
          onPick={props.onTextBackground}
        />
      </Group>
      <Group title={S.ribbon.groups.paragraph}>
        {PARAGRAPH_ALIGNS.map((align) => (
          <ToolButton
            key={align}
            label={ALIGN_LABEL[align]}
            // No chord on the US or the Italian layout: the tooltip names the command.
            title={off ? S.text.needsTextRegion : ALIGN_LABEL[align]}
            icon={<Icon>{ALIGN_GLYPH[align]}</Icon>}
            keepFocus
            disabled={off}
            active={format?.align === align}
            onClick={() => props.onTextAlign(align)}
          />
        ))}
      </Group>
      <Group title={S.ribbon.groups.textStyles} stacked>
        {PARAGRAPH_STYLES.map((style) => (
          <ToolButton
            key={style}
            label={STYLE_LABEL[style]}
            title={off ? S.text.needsTextRegion : STYLE_LABEL[style]}
            icon={<Icon>{STYLE_GLYPH[style]}</Icon>}
            keepFocus
            disabled={off}
            active={format?.style === style}
            onClick={() => props.onParagraphStyle(style)}
          />
        ))}
      </Group>
      <Group title={S.ribbon.groups.textInsert}>
        <ToolButton
          label={S.text.insertMath}
          title={off ? S.text.needsTextRegion : tip(S.text.insertMath, "insertInlineMath")}
          icon={<Icon>∑</Icon>}
          keepFocus
          disabled={off}
          onClick={props.onInsertInlineMath}
        />
      </Group>
    </>
  );
}

function MatrixTab(props: RibbonProps) {
  const C = S.ribbon.commands;
  const editor = (command: Command) => () => props.onEditorCommand(command);
  const controls = props.matrixControls;
  const display = props.matrixDisplay;
  const size = props.matrixSize;
  return (
    <>
      {/* the row and column commands edit the matrix the user typed, so a result matrix
          (where only the display can be chosen) does not carry them. */}
      {controls && (
        <>
          <Group title={S.ribbon.groups.rowsColumns} stacked>
            <ToolButton label={C.insertRowAbove} icon={<Icon>⤒</Icon>} keepFocus onClick={editor("addRowAbove")} />
            <ToolButton label={C.insertRowBelow} icon={<Icon>⤓</Icon>} title={tip(C.insertRowBelow, "addRow")} keepFocus onClick={editor("addRow")} />
            <ToolButton label={C.insertColumnLeft} icon={<Icon>⇤</Icon>} keepFocus onClick={editor("addColumnLeft")} />
            <ToolButton label={C.insertColumnRight} icon={<Icon>⇥</Icon>} title={tip(C.insertColumnRight, "addColumn")} keepFocus onClick={editor("addColumn")} />
            <ToolButton label={C.selectMatrixRow} icon={<Icon>☰</Icon>} keepFocus onClick={editor("selectRow")} />
            <ToolButton label={C.selectMatrixColumn} icon={<Icon>⫼</Icon>} keepFocus onClick={editor("selectColumn")} />
            <ToolButton label={C.deleteMatrixRow} icon={<Icon>⊟</Icon>} keepFocus disabled={!controls.canDeleteRow} onClick={editor("deleteRow")} />
            <ToolButton label={C.deleteMatrixColumn} icon={<Icon>⊠</Icon>} keepFocus disabled={!controls.canDeleteColumn} onClick={editor("deleteColumn")} />
            <ToolButton label={C.clearMatrixCells} icon={<Icon>⌫</Icon>} keepFocus onClick={editor("clearCells")} />
          </Group>
          <Group title={S.ribbon.groups.matrix}>
            <ToolButton label={C.insertMatrix} icon={<Icon>[ ]</Icon>} title={tip(C.insertMatrix, "matrix")} onClick={() => props.onCommand("matrixDialog")} />
            <PaletteButton {...props} kind="matrixFunctions" label={C.matrixFunctions} icon="matrix" />
          </Group>
        </>
      )}
      {props.matrixShape && (
        <Group title={S.ribbon.groups.shape}>
          <span className="ribbon-shape" data-testid="matrix-shape" title={S.matrixSize.shapeTitle}>
            {S.matrixSize.shape(props.matrixShape.rows, props.matrixShape.cols)}
          </span>
        </Group>
      )}
      {(display || size) && (
        <Group title={S.ribbon.groups.display}>
          {/* the size threshold is the worksheet's, so it needs no matrix result; the checkbox
              belongs to the target result and is shown only while there is one. */}
          {size && <MatrixSizeBox rows={size.rows} cols={size.cols} onCommit={props.onMatrixSize} />}
          {display && <CheckButton label={C.showIndices} checked={display.indices} onChange={props.onMatrixDisplay} />}
          {display && display.nested !== null && <CheckButton label={C.expandNested} checked={display.nested} onChange={props.onMatrixNested} />}
        </Group>
      )}
    </>
  );
}

/**
 * The size box of the Matrix tab: the worksheet `format.matrix-size`, the rows
 * and columns a matrix may have before the display of draws it as a table. A field commits on
 * Enter and when it loses the keyboard focus; a field that does not hold a whole number of at least
 * 1 writes nothing and goes back to the value in force, so the box never shows a threshold the sheet
 * is not drawn with.
 */
function MatrixSizeBox({
  rows,
  cols,
  onCommit,
}: {
  rows: number;
  cols: number;
  onCommit: (rows: number, cols: number) => void;
}) {
  const M = S.matrixSize;
  /** The field being typed in, so the box shows the text and not the round number behind it. */
  const [draft, setDraft] = useState<{ field: SizeField; value: string } | null>(null);
  const commit = (field: SizeField, stored: number, text: string) => {
    setDraft(null);
    const value = parseMatrixSizeField(text);
    // Nothing to write: a field the reader cannot use, or the value the sheet already has.
    if (value === null || value === stored) return;
    if (field === "rows") onCommit(value, cols);
    else onCommit(rows, value);
  };
  const field = (name: SizeField, label: string, stored: number) => (
    <label className="ribbon-field" key={name} title={M.label}>
      <span className="ribbon-field-label">{label}</span>
      <input
        aria-label={label}
        type="text"
        inputMode="numeric"
        value={draft?.field === name ? draft.value : String(stored)}
        onChange={(event) => setDraft({ field: name, value: event.target.value })}
        onBlur={(event) => commit(name, stored, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
  return (
    <div className="ribbon-size-box" role="group" aria-label={M.label}>
      {field("rows", M.rows, rows)}
      <span className="ribbon-size-times" aria-hidden="true">×</span>
      {field("columns", M.columns, cols)}
    </div>
  );
}

type SizeField = "rows" | "columns";

function ImageTab(props: RibbonProps) {
  const C = S.ribbon.commands;
  return (
    <>
      <Group title={S.ribbon.groups.image}>
        <ToolButton label={C.originalSize} icon={<Icon>1x</Icon>} onClick={() => props.onCommand("imageOriginalSize")} />
        <ToolButton label={C.replaceImage} icon={<Icon>⇄</Icon>} onClick={() => props.onCommand("imageReplace")} />
      </Group>
      <Group title={S.ribbon.groups.region}>
        <ToolButton label={C.deleteRegion} icon={<Icon>✕</Icon>} onClick={() => props.onCommand("deleteRegions")} />
      </Group>
    </>
  );
}

function AreaTab(props: RibbonProps & { context: Extract<RibbonContext, { kind: "area" }> }) {
  const C = S.ribbon.commands;
  const collapsed = props.context.collapsed;
  return (
    <>
      <Group title={S.ribbon.groups.area}>
        <ToolButton
          label={collapsed ? C.expandArea : C.collapseArea}
          icon={<Icon>{collapsed ? "▸" : "▾"}</Icon>}
          onClick={() => props.onCommand("toggleArea")}
        />
      </Group>
      <Group title={S.ribbon.groups.region}>
        <ToolButton label={C.deleteRegion} icon={<Icon>✕</Icon>} onClick={() => props.onCommand("deleteRegions")} />
      </Group>
    </>
  );
}
