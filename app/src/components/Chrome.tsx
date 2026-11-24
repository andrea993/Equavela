// Window chrome around the worksheet: title bar with quick access, document tabs, status bar
// and the dialogs. The chrome is never part
// of the printed page (rule R1: print CSS hides everything with `.chrome`).

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { stepZoom, ZOOM_MAX, ZOOM_MIN } from "../layout/geometry";
import {
  CUSTOM_SIZE,
  fromUnit,
  isLandscape,
  namedSize,
  pageSetupProblem,
  sizeIdOf,
  toUnit,
  withOrientation,
  PAGE_SIZES,
  type LengthUnit,
} from "../layout/pageSetup";
import { TOKENS } from "../layout/pageText";
import { S, windowTitle } from "../strings";
import type { EnvironmentSummary, ImportIssue, ImportReport, KernelActivity, KernelStatus, PageLine, PageSetup } from "../equavelaApi";
import { recentFileFolder, recentFileName } from "../recentFiles";

import { SHEET_CONTEXTS, shortcutSheet } from "../keymap/shortcutSheet";
import type { BackendMode } from "../backend";
import type { CalcMode, DocState, FileTab, Prompt, ViewMode } from "../workbench/useWorkbench";
import { handleInputChord, isFindModeSwitch } from "./inputChords";
import { ContextMenu } from "./ContextMenu";
import { AUTOSAVE_MAX_SECONDS, AUTOSAVE_MIN_SECONDS, clampInterval, type AppSettings } from "../settings";
import { defaultText, parseSetting } from "../calculation/settings";
import type { ResultFormat } from "../results/format";
import {
  DEFAULT_MATH_COLOR,
  MATH_COLORS,
  MATH_HIGHLIGHTS,
  MATH_SIZES_PT,
  type MathFont,
} from "../math/font";
import {
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_STYLES,
  LABEL_KINDS,
  type LabelKind,
  type LabelStyle,
  type LabelStyles,
} from "../math/labels";

// ---- shared pieces ----------------------------------------------------------------------

type ButtonProps = {
  /** Keep the keyboard focus (and the selection) where it is: the button acts on the text editor. */
  keepFocus?: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Marks the button that toggles this palette: a click on it is not an outside click. */
  paletteKind?: string;
  icon?: ReactNode;
  className?: string;
  /** no text label; the label is the tooltip and the accessible name. Needs an icon. */
  iconOnly?: boolean;
};

export function ToolButton({ label, title, disabled, active, onClick, icon, className = "", keepFocus, paletteKind, iconOnly }: ButtonProps) {
  return (
    <button
      type="button"
      onMouseDown={keepFocus ? (event) => event.preventDefault() : undefined}
      className={`tool${icon ? " has-icon" : ""}${active ? " active" : ""}${icon && iconOnly ? " icon-only" : ""} ${className}`}
      title={title ?? label}
      aria-label={icon && iconOnly ? label : undefined}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      data-palette-toggle={paletteKind}
      onClick={onClick}
    >
      {icon && <span className="tool-icon" aria-hidden="true">{icon}</span>}
      <span className="tool-label">{label}</span>
    </button>
  );
}

/** A titled group of ribbon commands. `stacked`: small buttons, icon beside the label, three per column. */
export function Group({ title, stacked, roomy, children }: { title: string; stacked?: boolean; roomy?: boolean; children: ReactNode }) {
  return (
    <div className={roomy ? "ribbon-group roomy" : "ribbon-group"} role="group" aria-label={title}>
      <div className={`ribbon-commands${stacked ? " stacked" : ""}`}>{children}</div>
      <div className="ribbon-group-title">{title}</div>
    </div>
  );
}

/** Simple glyph icons (our own, drawn with text so no image assets are needed). */
export const Icon = ({ children }: { children: ReactNode }) => <span className="glyph">{children}</span>;

// ---- title bar --------------------------------------------------------------------------

/**
 * The Recent menu of the quick access: the worksheets opened, imported or saved
 * on this machine, most recent first. It is a menu of the title bar, not a file dialog: choosing an
 * entry is the same as opening that path. A press outside, Escape or a choice closes it; the first
 * entry takes the keyboard when it opens and the arrow keys walk the list. The recent projects
 *  come first; headings appear only when both lists have entries.
 */
function RecentMenu({
  files,
  projects,
  onOpen,
  onOpenProject,
}: {
  files: string[];
  projects: string[];
  onOpen: (path: string) => void;
  onOpenProject: (root: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    // The press still reaches its target, so pressing into the worksheet also closes the menu.
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".recent")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [open]);

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const all = items();
      if (all.length === 0) return;
      const at = all.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? all.length - 1
            : event.key === "ArrowDown"
              ? (at + 1) % all.length
              : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    }
  };

  const headings = files.length > 0 && projects.length > 0;
  const entry = (path: string, className: string, choose: (path: string) => void) => {
    const folder = recentFileFolder(path);
    return (
      <button
        key={`${className}:${path}`}
        type="button"
        role="menuitem"
        className={className}
        title={path}
        onClick={() => {
          close();
          choose(path);
        }}
      >
        <span className="recent-file-name">{recentFileName(path)}</span>
        {folder !== "" && <span className="recent-file-folder">{folder}</span>}
      </button>
    );
  };

  return (
    <span
      className="recent"
      onKeyDown={keyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="tool has-icon"
        aria-label={S.quickAccess.recent}
        aria-haspopup="menu"
        aria-expanded={open}
        title={files.length + projects.length > 0 ? S.quickAccess.recentFiles : S.quickAccess.noRecentFiles}
        disabled={files.length + projects.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tool-icon" aria-hidden="true">◷</span>
      </button>
      {open && (
        <div className="recent-menu" role="menu" aria-label={S.quickAccess.recentFiles} ref={menu}>
          {headings && <div className="recent-heading" role="presentation">{S.quickAccess.recentProjects}</div>}
          {projects.map((root) => entry(root, "recent-file recent-project", onOpenProject))}
          {headings && <div className="recent-heading" role="presentation">{S.quickAccess.recentWorksheets}</div>}
          {files.map((path) => entry(path, "recent-file", onOpen))}
        </div>
      )}
    </span>
  );
}

export function TitleBar({
  doc,
  file,
  modified,
  recentFiles,
  recentProjects,
  onNew,
  onOpen,
  onOpenRecent,
  onOpenRecentProject,
  onSave,
  onSaveAs,
  onUndo,
  onRedo,
  history,
  saveTitle,
  projectActions,
}: {
  doc: DocState | null;
  file?: { name: string; modified: boolean };
  modified: boolean;
  /** The recent worksheets of the Recent menu, most recent first. */
  recentFiles: string[];
  /** The recent project roots, most recent first. */
  recentProjects: string[];
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onOpenRecentProject: (root: string) => void;
  onSave: () => void;
  onSaveAs: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Local math-editor history takes precedence while its region is open. */
  history?: { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string };
  /** The Save button's tooltip: `Save project` while a project is open. */
  saveTitle?: string;
  /** the project commands, in a group of their own on the right of the title bar.
   * `onConvert` is null unless a standalone worksheet is in front. */
  projectActions?: { onNew: () => void; onOpen: () => void; onConvert: (() => void) | null };
}) {
  const view = doc?.view;
  const canUndo = history?.canUndo ?? (view?.can_undo ?? false);
  const canRedo = history?.canRedo ?? (view?.can_redo ?? false);
  const undoTitle = canUndo
    ? (history?.undoLabel ?? (view?.undo_label ? `${S.quickAccess.undo} ${view.undo_label}` : S.quickAccess.undo))
    : S.quickAccess.nothingToUndo;
  const redoTitle = canRedo
    ? (history?.redoLabel ?? (view?.redo_label ? `${S.quickAccess.redo} ${view.redo_label}` : S.quickAccess.redo))
    : S.quickAccess.nothingToRedo;
  const title = windowTitle(file ? `${file.name}${file.modified ? " *" : ""}` : doc ? `${doc.name}${modified ? " *" : ""}` : null);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <header className="chrome titlebar" role="banner">
      <div className="quick-access" role="toolbar" aria-label={S.quickAccess.label}>
        <ToolButton label={S.quickAccess.new} icon={<Icon>＋</Icon>} onClick={onNew} />
        <ToolButton label={S.quickAccess.open} icon={<Icon>▤</Icon>} onClick={onOpen} />
        <RecentMenu files={recentFiles} projects={recentProjects} onOpen={onOpenRecent} onOpenProject={onOpenRecentProject} />
        <ToolButton
          label={S.quickAccess.save}
          icon={<Icon>▣</Icon>}
          disabled={!doc && !file}
          title={saveTitle ?? `${S.quickAccess.save} (Ctrl+S)`}
          onClick={onSave}
        />
        <ToolButton
          label={S.quickAccess.saveAs}
          icon={<Icon>▣…</Icon>}
          disabled={!doc}
          title={`${S.quickAccess.saveAs} (Ctrl+Shift+S)`}
          onClick={onSaveAs}
        />
        <span className="separator" />
        <ToolButton
          label={S.quickAccess.undo}
          icon={<Icon>↶</Icon>}
          disabled={!canUndo}
          title={undoTitle}
          keepFocus
          onClick={onUndo}
        />
        <ToolButton
          label={S.quickAccess.redo}
          icon={<Icon>↷</Icon>}
          disabled={!canRedo}
          title={redoTitle}
          keepFocus
          onClick={onRedo}
        />
      </div>
      <div className="window-title">{title}</div>
      {projectActions && (
        <div className="project-access" role="toolbar" aria-label={S.quickAccess.projectLabel}>
          <ToolButton label={S.project.newTitle} title={`${S.project.newTitle}…`} icon={<Icon>⊞</Icon>} onClick={projectActions.onNew} />
          <ToolButton label={S.project.openTitle} title={`${S.project.openTitle}…`} icon={<Icon>⊡</Icon>} onClick={projectActions.onOpen} />
          {projectActions.onConvert && (
            <ToolButton label={S.project.convertTitle} title={`${S.project.convertTitle}…`} icon={<Icon>⇪</Icon>} onClick={projectActions.onConvert} />
          )}
        </div>
      )}
    </header>
  );
}

// ---- document tabs ----------------------------------------------------------------------

/** an absolute path (a file of the disk), not a bare untitled name. */
const isFilePath = (path: string) => /^(?:[A-Za-z]:[\\/]|\/)/.test(path);

export function DocumentTabs({
  docs,
  activeId,
  onActivate,
  onClose,
  files = [],
  activeFile = null,
  onActivateFile,
  onCloseFile,
  onReveal,
  onCopyPath,
  moduleNames = {},
}: {
  docs: (DocState & { modified: boolean })[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** The project files open in text and image tabs, after the worksheets. */
  files?: FileTab[];
  activeFile?: string | null;
  onActivateFile?: (id: string) => void;
  onCloseFile?: (id: string) => void;
  /** Show in folder and Copy path of a tab's file. */
  onReveal?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  /** the module name of each worksheet tab, shown after its path. */
  moduleNames?: Record<string, string>;
}) {
  const worksheetActive = (id: string) => activeFile === null && id === activeId;
  // the full path, shown after the pointer rests on a tab.
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<{ path: string; close: () => void; x: number; y: number } | null>(null);
  useEffect(() => () => { if (tipTimer.current) clearTimeout(tipTimer.current); }, []);
  const hover = (path: string, module?: string) => ({
    onPointerEnter: (event: { currentTarget: HTMLElement }) => {
      const box = event.currentTarget.getBoundingClientRect();
      if (tipTimer.current) clearTimeout(tipTimer.current);
      const where = isFilePath(path) ? path : S.documents.noFile;
      const text = module ? `${where}\n${S.documents.module(module)}` : where;
      tipTimer.current = setTimeout(() => setTip({ text, x: box.left, y: box.bottom + 4 }), 400);
    },
    onPointerLeave: () => {
      if (tipTimer.current) clearTimeout(tipTimer.current);
      setTip(null);
    },
  });
  const openMenu = (path: string, close: () => void) => (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if ("key" in event && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    if (tipTimer.current) clearTimeout(tipTimer.current);
    setTip(null);
    const box = event.currentTarget.getBoundingClientRect();
    const x = "clientX" in event ? event.clientX : box.left;
    const y = "clientY" in event ? event.clientY : box.bottom;
    setMenu({ path, close, x, y });
  };
  return (
    <div className="chrome doc-tabs" role="tablist" aria-label={S.documents.label}>
      {docs.map((doc) => (
        <div key={doc.id} className={`doc-tab ${worksheetActive(doc.id) ? "active" : ""}`} role="presentation">
          <button
            type="button"
            role="tab"
            aria-selected={worksheetActive(doc.id)}
            aria-description={isFilePath(doc.root) ? doc.root : S.documents.noFile}
            data-path={doc.root}
            className="doc-tab-name"
            onClick={() => onActivate(doc.id)}
            onContextMenu={openMenu(doc.root, () => onClose(doc.id))}
            onKeyDown={openMenu(doc.root, () => onClose(doc.id))}
            {...hover(doc.root, moduleNames[doc.id])}
          >
            {doc.name}
            {doc.modified && <span className="modified" aria-label={S.documents.modified}> *</span>}
          </button>
          <button
            type="button"
            className="doc-tab-close"
            aria-label={`${S.documents.close} ${doc.name}`}
            title={S.documents.close}
            onClick={() => onClose(doc.id)}
          >
            ×
          </button>
        </div>
      ))}
      {files.map((file) => {
        const name = file.path.split("/").pop() ?? file.path;
        return (
          <div key={file.id} className={`doc-tab file ${file.id === activeFile ? "active" : ""}`} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={file.id === activeFile}
              aria-description={file.id}
              data-path={file.id}
              className="doc-tab-name"
              onClick={() => onActivateFile?.(file.id)}
              onContextMenu={openMenu(file.id, () => onCloseFile?.(file.id))}
              onKeyDown={openMenu(file.id, () => onCloseFile?.(file.id))}
              {...hover(file.id)}
            >
              {name}
              {file.text !== file.saved && <span className="modified" aria-label={S.documents.modified}> *</span>}
            </button>
            <button
              type="button"
              className="doc-tab-close"
              aria-label={`${S.documents.close} ${name}`}
              title={S.documents.close}
              onClick={() => onCloseFile?.(file.id)}
            >
              ×
            </button>
          </div>
        );
      })}
      {tip && <div className="doc-tab-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={S.documents.menu}
          items={[
            { kind: "item", id: "reveal", label: S.documents.showInFolder, disabled: !isFilePath(menu.path) || !onReveal },
            { kind: "item", id: "copy", label: S.documents.copyPath, disabled: !isFilePath(menu.path) || !onCopyPath },
            { kind: "separator" },
            { kind: "item", id: "close", label: S.documents.close },
          ]}
          onChoose={(id) => {
            const current = menu;
            setMenu(null);
            if (id === "reveal") onReveal?.(current.path);
            else if (id === "copy") onCopyPath?.(current.path);
            else if (id === "close") current.close();
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// ---- status bar -------------------------------------------------------------------------

export function describeKernel(status: KernelStatus | null): string {
  if (status === null) return S.status.kernel.unknown;
  switch (status.status) {
    case "not_started":
      return S.status.kernel.notStarted;
    case "starting":
      return S.status.kernel.starting;
    case "ready":
      return S.status.kernel.ready(status.info.julia);
    case "busy":
      return S.status.kernel.busy;
    case "crashed":
      return S.status.kernel.crashed(status.message.split("\n")[0]);
  }
}

/** The first-run notice: shown after 1 s of `starting`, counts the elapsed seconds, never blocks input. */
export const ENGINE_NOTICE_DELAY_MS = 1000;

export function EngineStartNotice(props: { kernel: KernelStatus | null; activity?: KernelActivity | null }) {
  const starting = props.kernel?.status === "starting";
  // What the user waits for: the start of the engine, or slow work of a running kernel
  // (installing packages, compiling them, preparing the symbolic engine).
  const waiting = starting ? "starting" : props.activity?.kind ?? null;
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const began = Date.now();
    const tick = () => setSeconds(Math.floor((Date.now() - began) / 1000));
    const timer = setInterval(tick, ENGINE_NOTICE_DELAY_MS);
    return () => {
      clearInterval(timer);
      setSeconds(null);
    };
  }, [waiting]);
  if (!waiting || seconds === null) return null;
  const A = S.status.activity;
  const H = S.status.activityHint;
  const [title, hint] =
    waiting === "starting" ? [S.status.engineStarting(seconds), S.status.engineStartingHint]
    : waiting === "packages" ? [A.packages(seconds), H.packages]
    : waiting === "compiling" ? [A.compiling(seconds), H.compiling(props.activity?.message ?? null)]
    : [A.symbolic(seconds), H.symbolic];
  return (
    <div className="chrome engine-notice" role="status" data-testid="engine-notice">
      <span className="engine-spinner" aria-hidden="true" />
      <span className="engine-notice-title">{title}</span>
      <span className="engine-notice-hint">{hint}</span>
    </div>
  );
}

export type StatusBarProps = {
  mode: BackendMode;
  kernel: KernelStatus | null;
  doc: DocState | null;
  page: { current: number; total: number };
  onGoToPage?: (page: number) => void;
  onCancelPageNavigation?: () => void;
  calcMode: CalcMode;
  zoom: number;
  viewMode: ViewMode;
  find: { query: string; replacement: string; index: number; total: number };
  onFind: (query: string) => void;
  onReplace: (replacement: string) => void;
  onFindStep: (direction: 1 | -1) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  /** The Find and Replace with fields, so the command palette can put the keyboard in them. */
  findRef?: RefObject<HTMLInputElement | null>;
  replaceRef?: RefObject<HTMLInputElement | null>;
  /** Math mode: the toggle, and the two math boxes drawn in place of the text fields. */
  findMode?: {
    math: boolean;
    onToggle: () => void;
    findBox: ReactNode;
    replaceBox: ReactNode;
    /** Math mode has a complete query to count matches of. */
    hasQuery?: boolean;
    /** A paste into a text box: true when it was math, which switches to math mode. */
    onPaste?: (box: "find" | "replace", text: string) => boolean;
  };
  onToggleCalc: () => void;
  /** the Julia REPL panel's toggle; : its context menu restarts the REPL. */
  repl?: { open: boolean; onToggle: () => void; onRestart?: () => void };
  onStop: () => void;
  /** Ctrl+click on the progress bar: show the region being calculated. */
  onShowRunning?: () => void;
  onZoom: (zoom: number) => void;
  onViewMode: (mode: ViewMode) => void;
  /** The side panel toggle (absent: no button). */
  panel?: { open: boolean; problems: number; onToggle: () => void };
  /** The active worksheet's Julia environment and opening its manager. */
  environment?: { summary: EnvironmentSummary; onOpen: () => void };
};

export function StatusBar(props: StatusBarProps) {
  const { doc, findMode } = props;
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [pageInvalid, setPageInvalid] = useState(false);
  useEffect(() => {
    setPageDraft(null);
    setPageInvalid(false);
  }, [doc?.id]);
  /** Ctrl+M in a text field of Find and Replace switches to math mode. */
  const switchesMode = (event: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!findMode || !isFindModeSwitch(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    findMode.onToggle();
    return true;
  };
  /** Pasting math the app copied into a text box switches to math mode with it. */
  const pastesMath = (event: ClipboardEvent<HTMLInputElement>, box: "find" | "replace") => {
    if (findMode?.onPaste?.(box, event.clipboardData.getData("text/plain"))) event.preventDefault();
  };
  const progress = doc?.progress ?? null;
  // right-click, the Menu key or Shift+F10 on the REPL button opens its menu.
  const [replMenu, setReplMenu] = useState<{ x: number; y: number } | null>(null);
  const openReplMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    if ("key" in event && event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    setReplMenu({ x: "clientX" in event ? event.clientX : box.left, y: "clientY" in event ? event.clientY : box.top });
  };
  return (
    <footer className="chrome statusbar" role="contentinfo" aria-label={S.status.label}>
      {pageDraft !== null && doc && props.onGoToPage ? (
        <form className="status-item page-jump" onSubmit={(event) => {
          event.preventDefault();
          const page = Number(pageDraft);
          if (!/^\d+$/.test(pageDraft.trim()) || page < 1 || page > props.page.total) {
            setPageInvalid(true);
            return;
          }
          setPageDraft(null);
          props.onGoToPage?.(page);
        }}>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            aria-label={S.status.pageNumber}
            aria-invalid={pageInvalid}
            title={S.status.pageRange(props.page.total)}
            value={pageDraft}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setPageDraft(null)}
            onChange={(event) => { setPageDraft(event.target.value); setPageInvalid(false); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setPageDraft(null);
              props.onCancelPageNavigation?.();
            }}
          />
          <span aria-hidden="true">/ {props.page.total}</span>
          {pageInvalid && <span className="page-jump-error" role="alert">{S.status.pageRange(props.page.total)}</span>}
        </form>
      ) : (
        <button
          className="status-item"
          type="button"
          aria-label={`${S.status.goToPage} (${S.status.page(props.page.current, props.page.total)})`}
          title={S.status.goToPage}
          data-testid="page-indicator"
          disabled={!doc || !props.onGoToPage}
          onClick={() => { setPageInvalid(false); setPageDraft(String(props.page.current)); }}
        >
          {S.status.page(props.page.current, props.page.total)}
        </button>
      )}
      <button
        type="button"
        className={`status-item calc-mode ${props.calcMode}`}
        disabled={!doc}
        title={props.calcMode === "auto" ? S.status.autoTitle : S.status.manualTitle}
        onClick={props.onToggleCalc}
        data-testid="calc-mode"
      >
        <span className="dot" aria-hidden="true" />
        {props.calcMode === "auto" ? S.status.auto : S.status.manual}
      </button>
      {props.repl && (
        <button
          type="button"
          className={`status-item repl-toggle${props.repl.open ? " active" : ""}`}
          aria-pressed={props.repl.open}
          title={S.repl.toggleTitle}
          onClick={props.repl.onToggle}
          onContextMenu={openReplMenu}
          onKeyDown={openReplMenu}
          data-testid="repl-toggle"
        >
          {S.repl.toggle}
        </button>
      )}
      {replMenu && props.repl && (
        <ContextMenu
          x={replMenu.x}
          y={replMenu.y}
          label={S.repl.menu}
          items={[
            { kind: "item", id: "toggle", label: props.repl.open ? S.repl.hide : S.repl.show },
            { kind: "item", id: "restart", label: S.repl.restartCommand, disabled: !props.repl.onRestart },
          ]}
          onChoose={(id) => {
            setReplMenu(null);
            if (id === "toggle") props.repl?.onToggle();
            else if (id === "restart") props.repl?.onRestart?.();
          }}
          onClose={() => setReplMenu(null)}
        />
      )}
      <span className="status-item find">
        {findMode && (
          <button
            type="button"
            className="find-mode"
            aria-pressed={findMode.math}
            aria-label={S.status.findModeLabel}
            title={findMode.math ? S.status.findMathMode : S.status.findTextMode}
            onClick={findMode.onToggle}
          >
            {findMode.math ? "∑" : "T"}
          </button>
        )}
        {findMode?.math ? findMode.findBox : <input
          ref={props.findRef}
          type="search"
          aria-label={S.status.find}
          disabled={!doc}
          placeholder={S.status.findPlaceholder}
          value={props.find.query}
          onChange={(e) => props.onFind(e.target.value)}
          onPaste={(e) => pastesMath(e, "find")}
          onKeyDown={(e) => {
            if (switchesMode(e)) return;
            if (handleInputChord(e)) return;
            if (e.key === "Enter") props.onFindStep(e.shiftKey ? -1 : 1);
          }}
        />}
        <button type="button" title={S.status.findPrevious} aria-label={S.status.findPrevious} disabled={props.find.total === 0} onClick={() => props.onFindStep(-1)}>
          ▲
        </button>
        <button type="button" title={S.status.findNext} aria-label={S.status.findNext} disabled={props.find.total === 0} onClick={() => props.onFindStep(1)}>
          ▼
        </button>
        {(findMode?.math ? findMode.hasQuery : props.find.query) && (
          <span className="find-count">
            {props.find.total === 0 ? S.status.findNone : S.status.findCount(props.find.index + 1, props.find.total)}
          </span>
        )}
      </span>
      <span className="status-item replace">
        {findMode?.math ? findMode.replaceBox : <input
          ref={props.replaceRef}
          type="search"
          aria-label={S.status.replaceWith}
          disabled={!doc}
          placeholder={S.status.replaceWithPlaceholder}
          value={props.find.replacement}
          onChange={(e) => props.onReplace(e.target.value)}
          onPaste={(e) => pastesMath(e, "replace")}
          onKeyDown={(e) => {
            if (switchesMode(e)) return;
            if (handleInputChord(e)) return;
            if (e.key === "Enter") props.onReplaceOne();
          }}
        />}
        <button type="button" title={S.status.replaceTitle} aria-label={S.status.replace} disabled={props.find.total === 0} onClick={props.onReplaceOne}>
          {S.status.replace}
        </button>
        <button type="button" title={S.status.replaceAllTitle} aria-label={S.status.replaceAll} disabled={props.find.total === 0} onClick={props.onReplaceAll}>
          {S.status.replaceAll}
        </button>
      </span>
      <span className="grow" />
      {progress && (
        <span
          className="status-item progress"
          data-testid="progress"
          title={props.onShowRunning ? S.status.progressTitle : undefined}
          onClick={(event) => {
            if (event.ctrlKey) props.onShowRunning?.();
          }}
        >
          <span className="progress-text">
            {progress.stopping ? S.status.stopping : S.status.calculating(progress.done, progress.total)}
          </span>
          <progress max={Math.max(progress.total, 1)} value={progress.done} />
          <button type="button" className="stop" title={S.status.stopTitle} onClick={props.onStop} disabled={progress.stopping}>
            ■ {S.status.stop}
          </button>
        </span>
      )}
      {props.environment && (
        <button
          type="button"
          className="status-item environment"
          data-testid="environment-indicator"
          title={S.environment.indicatorTitle(props.environment.summary.directory)}
          onClick={props.environment.onOpen}
        >
          {S.environment.indicator[props.environment.summary.kind]}
        </button>
      )}
      <span className={`status-item kernel ${props.kernel?.status ?? "unknown"}`} data-testid="kernel-status">
        <span className="dot" aria-hidden="true" />
        {describeKernel(props.kernel)}
      </span>
      {props.mode === "mock" && (
        <span className="status-item mock-badge" title={S.status.mockTitle}>
          {S.status.mock}
        </span>
      )}
      <span className="status-item zoom-controls">
        <button type="button" title={S.status.zoomOut} aria-label={S.status.zoomOut} onClick={() => props.onZoom(stepZoom(props.zoom, -1))}>
          −
        </button>
        <input
          type="range"
          aria-label={S.status.zoom}
          min={Math.round(ZOOM_MIN * 100)}
          max={Math.round(ZOOM_MAX * 100)}
          step={5}
          value={Math.round(props.zoom * 100)}
          onChange={(e) => props.onZoom(Number(e.target.value) / 100)}
        />
        <button type="button" title={S.status.zoomIn} aria-label={S.status.zoomIn} onClick={() => props.onZoom(stepZoom(props.zoom, 1))}>
          ＋
        </button>
        <span className="zoom-value" data-testid="zoom-value">{S.status.zoomValue(props.zoom)}</span>
      </span>
      {props.panel && (
        <button
          type="button"
          className={`status-item panel-toggle${props.panel.open ? " active" : ""}`}
          title={S.panel.toggleTitle}
          aria-pressed={props.panel.open}
          onClick={props.panel.onToggle}
          data-testid="panel-toggle"
          disabled={!doc}
        >
          {S.panel.toggle}
          {props.panel.problems > 0 && <span className="badge">{props.panel.problems}</span>}
        </button>
      )}
      <span className="status-item view-toggle">
        <button
          type="button"
          className={props.viewMode === "page" ? "active" : ""}
          title={S.status.pageView}
          aria-label={S.status.pageView}
          aria-pressed={props.viewMode === "page"}
          onClick={() => props.onViewMode("page")}
        >
          ▯
        </button>
        <button
          type="button"
          className={props.viewMode === "draft" ? "active" : ""}
          title={S.status.draftView}
          aria-label={S.status.draftView}
          aria-pressed={props.viewMode === "draft"}
          onClick={() => props.onViewMode("draft")}
        >
          ≡
        </button>
      </span>
    </footer>
  );
}

/** A modal question (confirm before close, restore a recovery file): one button per answer. */
export function PromptDialog({
  prompt,
  onAnswer,
}: {
  prompt: Prompt;
  onAnswer: (id: string) => void;
}) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => primary.current?.focus(), [prompt]);
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => onAnswer(prompt.cancel)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={prompt.title}
        aria-describedby="prompt-message"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onAnswer(prompt.cancel);
          }
        }}
      >
        <h2>{prompt.title}</h2>
        <p id="prompt-message">{prompt.message}</p>
        <div className="dialog-buttons">
          {prompt.buttons.map((button) => (
            <button
              key={button.id}
              type="button"
              className={button.primary ? "primary" : undefined}
              ref={button.primary ? primary : undefined}
              onClick={() => onAnswer(button.id)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Result format: of one region or, with `worksheet`, the worksheet-wide default
 * . The nine options and the keys are the same
 * ; only the title, the hint and the Reset label
 * differ.
 */
export function ResultFormatDialog({
  initial,
  worksheet = false,
  onApply,
  onReset,
  onCancel,
}: {
  initial: ResultFormat;
  /** The dialog edits the worksheet default instead of a region override. */
  worksheet?: boolean;
  onApply: (format: Record<string, string>) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [format, setFormat] = useState(initial);
  const R = S.resultFormat;
  const title = worksheet ? R.worksheetTitle : R.title;
  const set = <K extends keyof ResultFormat>(key: K, value: ResultFormat[K]) =>
    setFormat((current) => ({ ...current, [key]: value }));
  // A field out of its range is clamped to the nearer end on Apply, as the precision always was
  //: a threshold takes 1 to 307, a precision 0 to 15.
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(value) || 0));
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog result-format"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onApply({
            "format.type": format.kind,
            "format.precision": String(clamp(format.precision, 0, 15)),
            "format.radix": format.radix,
            "format.trailing-zeros": String(format.trailingZeros),
            "format.exp-threshold": String(clamp(format.expThreshold, 1, 307)),
            "format.zero-threshold": String(clamp(format.zeroThreshold, 1, 307)),
            "format.complex-threshold": String(clamp(format.complexThreshold, 1, 307)),
            "format.complex-form": format.complexForm,
            // Empty: no choice, the automatic rule (`expandsNested`).
            "format.expand-nested": format.expandNestedSet ? String(format.expandNested) : "",
          });
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{title}</h2>
        {worksheet && <p className="hint">{R.worksheetHint}</p>}
        <label>
          {R.type}
          <select value={format.kind} onChange={(e) => set("kind", e.target.value as ResultFormat["kind"])} data-testid="rf-type">
            {Object.entries(R.types).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          {R.precision}
          <input
            type="number"
            min={0}
            max={15}
            value={format.precision}
            onChange={(e) => set("precision", Number(e.target.value))}
            data-testid="rf-precision"
          />
        </label>
        <label>
          {R.radix}
          <select value={format.radix} onChange={(e) => set("radix", e.target.value as ResultFormat["radix"])} data-testid="rf-radix">
            {Object.entries(R.radixes).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={format.trailingZeros}
            onChange={(e) => set("trailingZeros", e.target.checked)}
            data-testid="rf-trailing-zeros"
          />{" "}
          {R.trailingZeros}
        </label>
        <p className="hint">{R.thresholdsHint}</p>
        <label>
          {R.expThreshold}
          <input
            type="number"
            min={1}
            max={307}
            value={format.expThreshold}
            onChange={(e) => set("expThreshold", Number(e.target.value))}
            data-testid="rf-exp-threshold"
          />
        </label>
        <label>
          {R.zeroThreshold}
          <input
            type="number"
            min={1}
            max={307}
            value={format.zeroThreshold}
            onChange={(e) => set("zeroThreshold", Number(e.target.value))}
            data-testid="rf-zero-threshold"
          />
        </label>
        <label>
          {R.complexThreshold}
          <input
            type="number"
            min={1}
            max={307}
            value={format.complexThreshold}
            onChange={(e) => set("complexThreshold", Number(e.target.value))}
            data-testid="rf-complex-threshold"
          />
        </label>
        <label>
          {R.complexForm}
          <select
            value={format.complexForm}
            onChange={(e) => set("complexForm", e.target.value as ResultFormat["complexForm"])}
            data-testid="rf-complex"
          >
            {Object.entries(R.complexForms).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          {R.expandNested}
          <select
            value={format.expandNestedSet ? (format.expandNested ? "expanded" : "collapsed") : "auto"}
            onChange={(e) =>
              setFormat((current) => ({
                ...current,
                expandNested: e.target.value === "expanded",
                expandNestedSet: e.target.value !== "auto",
              }))
            }
            data-testid="rf-expand-nested"
          >
            {Object.entries(R.nestedChoices).map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
        </label>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{R.cancel}</button>
          <button type="button" onClick={onReset} data-testid="rf-reset">
            {worksheet ? R.resetWorksheet : R.reset}
          </button>
          <button type="submit" className="primary" data-testid="rf-apply">{R.apply}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * The math font of the selected math regions: the size steps of,
 * the font and highlight palettes of, and Apply, Reset and Cancel. Apply writes one font for
 * every target region; Reset removes the three keys of the override.
 */
export function MathFontDialog({
  initial,
  onApply,
  onReset,
  onCancel,
}: {
  /** The font of the first target region in worksheet order. */
  initial: MathFont;
  onApply: (font: MathFont) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [font, setFont] = useState(initial);
  const F = S.mathFont;
  const set = <K extends keyof MathFont>(key: K, value: MathFont[K]) =>
    setFont((current) => ({ ...current, [key]: value }));
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog math-font"
        role="dialog"
        aria-modal="true"
        aria-label={F.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onApply(font);
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{F.title}</h2>
        <p className="hint">{F.hint}</p>
        <label>
          {F.size}
          <select
            value={font.sizePt}
            onChange={(e) => set("sizePt", Number(e.target.value))}
            data-testid="mf-size"
          >
            {MATH_SIZES_PT.map((pt) => (
              <option key={pt} value={pt}>
                {F.sizeStep(pt)}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">{F.defaultSizeHint}</p>
        <div className="swatch-field">
          <span className="swatch-label">{F.fontColor}</span>
          <div className="swatches" role="group" aria-label={F.fontColor}>
            {MATH_COLORS.map((color) => (
              <button
                key={color.value}
                type="button"
                className={`swatch${font.color.toLowerCase() === color.value ? " active" : ""}${
                  color.value === DEFAULT_MATH_COLOR ? " automatic" : ""
                }`}
                style={{ backgroundColor: color.value }}
                title={color.name}
                aria-label={color.name}
                aria-pressed={font.color.toLowerCase() === color.value}
                onClick={() => set("color", color.value)}
                data-testid={`mf-color-${color.value.slice(1)}`}
              />
            ))}
          </div>
        </div>
        <div className="swatch-field">
          <span className="swatch-label">{F.highlight}</span>
          <div className="swatches" role="group" aria-label={F.highlight}>
            {MATH_HIGHLIGHTS.map((highlight) => (
              <button
                key={highlight.value ?? "none"}
                type="button"
                className={`swatch${highlight.value === null ? " none" : ""}${
                  font.highlight === highlight.value ? " active" : ""
                }`}
                style={highlight.value === null ? undefined : { backgroundColor: highlight.value }}
                title={highlight.name}
                aria-label={highlight.name}
                aria-pressed={font.highlight === highlight.value}
                onClick={() => set("highlight", highlight.value)}
                data-testid={`mf-highlight-${highlight.value === null ? "none" : highlight.value.slice(1)}`}
              />
            ))}
          </div>
        </div>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{F.cancel}</button>
          <button type="button" onClick={onReset} data-testid="mf-reset">{F.reset}</button>
          <button type="submit" className="primary" data-testid="mf-apply">{F.apply}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * The label styles of the worksheet: the list of the six styles and, for
 * the selected one, its bold, italic, underline and colour. Apply writes every style in one undo step
 *; Reset restores the selected style to the built-in values; the first swatch of the
 * colour row is the built-in colour of that style, so picking it removes the key.
 */
export function LabelStylesDialog({
  initial,
  onApply,
  onReset,
  onCancel,
}: {
  /** The styles the worksheet has now, the built-in ones where it stores nothing. */
  initial: LabelStyles;
  onApply: (styles: LabelStyles) => void;
  /** Reset of the selected style only. */
  onReset: (kind: LabelKind) => void;
  onCancel: () => void;
}) {
  const [styles, setStyles] = useState(initial);
  const [selected, setSelected] = useState<LabelKind>("var");
  const L = S.labelStyles;
  const style = styles[selected];
  const builtIn = DEFAULT_LABEL_STYLES[selected];
  const set = <K extends keyof LabelStyle>(key: K, value: LabelStyle[K]) =>
    setStyles((current) => ({ ...current, [selected]: { ...current[selected], [key]: value } }));
  // The automatic swatch is the built-in colour of the selected style: blue for a unit, black for the
  // rest. The other swatches are the font palette, without its own first (black) entry.
  const automaticName = `${L.automatic} (${S.labelStyles.kinds[selected]})`;
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog label-styles"
        role="dialog"
        aria-modal="true"
        aria-label={L.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onApply(styles);
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{L.title}</h2>
        <p className="hint">{L.hint}</p>
        <label>
          {L.style}
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value as LabelKind)}
            data-testid="ls-style"
          >
            {LABEL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {L.kinds[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={style.bold}
            onChange={(e) => set("bold", e.target.checked)}
            data-testid="ls-bold"
          />{" "}
          {L.bold}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={style.italic}
            onChange={(e) => set("italic", e.target.checked)}
            data-testid="ls-italic"
          />{" "}
          {L.italic}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={style.underline}
            onChange={(e) => set("underline", e.target.checked)}
            data-testid="ls-underline"
          />{" "}
          {L.underline}
        </label>
        <div className="swatch-field">
          <span className="swatch-label">{L.color}</span>
          <div className="swatches" role="group" aria-label={L.color}>
            <button
              type="button"
              className={`swatch automatic${style.color.toLowerCase() === builtIn.color ? " active" : ""}`}
              style={{ backgroundColor: builtIn.color }}
              title={automaticName}
              aria-label={automaticName}
              aria-pressed={style.color.toLowerCase() === builtIn.color}
              onClick={() => set("color", builtIn.color)}
              data-testid={`ls-color-default-${selected}`}
            />
            {MATH_COLORS.filter((color) => color.value !== DEFAULT_LABEL_COLOR).map((color) => (
              <button
                key={color.value}
                type="button"
                className={`swatch${style.color.toLowerCase() === color.value ? " active" : ""}`}
                style={{ backgroundColor: color.value }}
                title={color.name}
                aria-label={color.name}
                aria-pressed={style.color.toLowerCase() === color.value}
                onClick={() => set("color", color.value)}
                data-testid={`ls-color-${color.value.slice(1)}`}
              />
            ))}
          </div>
        </div>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{L.cancel}</button>
          <button type="button" onClick={() => onReset(selected)} data-testid="ls-reset">{L.reset}</button>
          <button type="submit" className="primary" data-testid="ls-apply">{L.apply}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * Calculation settings: the worksheet's `ORIGIN` and its
 * two tolerances `TOL` and `CTOL`. Apply refuses a value the setting cannot take instead of
 * clamping it; Reset removes the three keys.
 */
export function CalculationSettingsDialog({
  initial,
  onApply,
  onReset,
  onCancel,
}: {
  /** The worksheet's current tolerances, as text (the built-in default when a key is absent). */
  initial: { ORIGIN: string; TOL: string; CTOL: string };
  onApply: (values: { ORIGIN: number; TOL: number; CTOL: number }) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [origin, setOrigin] = useState(initial.ORIGIN);
  const [tol, setTol] = useState(initial.TOL);
  const [ctol, setCtol] = useState(initial.CTOL);
  const C = S.calculationSettings;
  const originValue = parseSetting("ORIGIN", origin);
  const tolValue = parseSetting("TOL", tol);
  const ctolValue = parseSetting("CTOL", ctol);
  const valid = originValue !== null && tolValue !== null && ctolValue !== null;
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={C.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (originValue !== null && tolValue !== null && ctolValue !== null) {
            onApply({ ORIGIN: originValue, TOL: tolValue, CTOL: ctolValue });
          }
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{C.title}</h2>
        <p className="hint">{C.hint}</p>
        <label>
          {C.origin}
          <input
            type="text"
            inputMode="numeric"
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            aria-invalid={originValue === null}
            data-testid="cs-origin"
          />
        </label>
        {originValue === null && <small className="error" data-testid="cs-origin-error">{C.originInvalid}</small>}
        <label>
          {C.tol}
          <input
            type="text"
            inputMode="decimal"
            value={tol}
            onChange={(e) => setTol(e.target.value)}
            aria-invalid={tolValue === null}
            data-testid="cs-tol"
          />
        </label>
        {tolValue === null && <small className="error" data-testid="cs-tol-error">{C.tolInvalid}</small>}
        <label>
          {C.ctol}
          <input
            type="text"
            inputMode="decimal"
            value={ctol}
            onChange={(e) => setCtol(e.target.value)}
            aria-invalid={ctolValue === null}
            data-testid="cs-ctol"
          />
        </label>
        {ctolValue === null && <small className="error" data-testid="cs-ctol-error">{C.ctolInvalid}</small>}
        <small>{C.defaultHint(defaultText("TOL"))}</small>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{C.cancel}</button>
          <button type="button" onClick={onReset} data-testid="cs-reset">{C.reset}</button>
          <button type="submit" className="primary" disabled={!valid} data-testid="cs-apply">{C.apply}</button>
        </div>
      </form>
    </div>
  );
}

/** Options: the autosave switch and interval. */
export function OptionsDialog({
  initial,
  onApply,
  onCancel,
}: {
  initial: AppSettings;
  onApply: (settings: AppSettings) => void;
  onCancel: () => void;
}) {
  const [enabled, setEnabled] = useState(initial.autosave.enabled);
  const [seconds, setSeconds] = useState(String(initial.autosave.intervalSeconds));
  const [spelling, setSpelling] = useState(initial.spelling.enabled);
  const O = S.options;
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={O.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onApply({ autosave: { enabled, intervalSeconds: clampInterval(Number(seconds)) }, spelling: { enabled: spelling } });
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{O.title}</h2>
        <fieldset>
          <legend>{O.autosaveGroup}</legend>
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="opt-autosave" />{" "}
            {O.autosaveEnabled}
          </label>
          <label>
            {O.autosaveInterval}
            <input
              type="number"
              min={AUTOSAVE_MIN_SECONDS}
              max={AUTOSAVE_MAX_SECONDS}
              value={seconds}
              disabled={!enabled}
              onChange={(e) => setSeconds(e.target.value)}
              data-testid="opt-interval"
            />
          </label>
          <small>{O.autosaveHint(AUTOSAVE_MIN_SECONDS, AUTOSAVE_MAX_SECONDS)}</small>
        </fieldset>
        <fieldset>
          <legend>{O.spellingGroup}</legend>
          <label className="check">
            <input type="checkbox" checked={spelling} onChange={(e) => setSpelling(e.target.checked)} data-testid="opt-spelling" />{" "}
            {O.spellingEnabled}
          </label>
        </fieldset>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{O.cancel}</button>
          <button type="submit" className="primary" data-testid="opt-apply">{O.apply}</button>
        </div>
      </form>
    </div>
  );
}

/** Help > Keyboard Shortcuts: the sheet of one layout, generated from the keymap tables. */
export function ShortcutSheetDialog({ onClose }: { onClose: () => void }) {
  const K = S.shortcutSheet;
  const rows = shortcutSheet();
  const contexts = SHEET_CONTEXTS.filter((context) => rows.some((row) => row.context === context));
  // While the sheet prints, the print stylesheet hides the window and the dialog chrome.
  const print = () => {
    document.body.classList.add("printing-shortcut-sheet");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing-shortcut-sheet"), { once: true });
    window.print();
  };
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onClose}>
      <div
        className="dialog shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={K.title}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2>{K.title}</h2>
        <p className="hint">{K.anyLayout}</p>
        {contexts.map((context) => (
          <section key={context} aria-label={K.contexts[context]}>
            <h3>{K.contexts[context]}</h3>
            <table className="shortcut-table">
              <thead>
                <tr>
                  <th>{K.keys}</th>
                  <th>{K.command}</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((row) => row.context === context)
                  .map((row, at) => (
                    <tr key={at}>
                      <td>
                        <kbd>{row.keys}</kbd>
                      </td>
                      <td>{row.label}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ))}
        <div className="dialog-buttons">
          <button type="button" onClick={print}>{K.print}</button>
          <button type="button" className="primary" autoFocus onClick={onClose}>{K.close}</button>
        </div>
      </div>
    </div>
  );
}

/** The full report of the last `.mcdx` import: every issue and note. */
export function ImportReportDialog({ report, onClose }: { report: ImportReport | null; onClose: () => void }) {
  const R = S.importReport;
  const rows = (items: ImportIssue[]) => (
    <table className="import-report-table">
      <thead>
        <tr>
          <th>{R.code}</th>
          <th>{R.region}</th>
          <th>{R.message}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, at) => (
          <tr key={at}>
            <td>{item.code}</td>
            <td>{item.region ?? ""}</td>
            <td>{item.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const includes = report?.issues.some((issue) => issue.code === "include-not-imported") ?? false;
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onClose}>
      <div
        className="dialog import-report"
        role="dialog"
        aria-modal="true"
        aria-label={R.title}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2>{R.title}</h2>
        {!report ? (
          <p>{R.none}</p>
        ) : (
          <>
            <p>{R.summary(report.regions_imported, report.regions_total)}</p>
            {report.issues.length === 0 ? (
              <p>{R.nothingLeftOut}</p>
            ) : (
              <section aria-label={R.issues}>
                <h3>{R.issues}</h3>
                {rows(report.issues)}
                {includes && <p className="hint">{R.includeHint}</p>}
              </section>
            )}
            {report.notes.length > 0 && (
              <section aria-label={R.notes}>
                <h3>{R.notes}</h3>
                {rows(report.notes)}
              </section>
            )}
          </>
        )}
        <div className="dialog-buttons">
          <button type="button" className="primary" autoFocus onClick={onClose}>{R.close}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Page setup and, in its own section, the header and the footer
 *: the page size, the orientation, the four margins and the six header/footer
 * slots, in millimetres or points. The fields keep the text being typed, so a half-typed decimal
 * does not jump; Apply converts it to points and is refused, with the reason, when the setup cannot
 * be stored. One Apply is one undo step in `Workbench`, whatever it changes.
 */
export function PageSetupDialog({
  initial,
  focus = "page",
  onApply,
  onCancel,
}: {
  initial: PageSetup;
  /** `chrome` opens the dialog at its header and footer section, with the first slot focused. */
  focus?: "page" | "chrome";
  onApply: (page: PageSetup) => void;
  onCancel: () => void;
}) {
  const P = S.pageSetup;
  const [size, setSize] = useState(() => sizeIdOf(initial));
  const [landscape, setLandscape] = useState(isLandscape(initial.width, initial.height));
  const [unit, setUnit] = useState<LengthUnit>("mm");
  const [fields, setFields] = useState(() => fieldsOf(initial, "mm"));
  const [lines, setLines] = useState<PageLines>(() => ({ header: initial.header, footer: initial.footer }));
  // a token goes into the slot that was last focused, at its caret.
  const [active, setActive] = useState<{ line: PageKey; slot: keyof PageLine } | null>(null);
  const lastField = useRef<HTMLInputElement | null>(null);
  const firstSlot = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (focus === "chrome") firstSlot.current?.focus();
  }, [focus]);
  const page = pageOf(size, fields, unit, lines);
  const problem = pageSetupProblem(page);
  const insertToken = (token: string) => {
    if (!active) return;
    const input = lastField.current;
    const value = lines[active.line][active.slot];
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const next = value.slice(0, start) + token + value.slice(end);
    setLines({ ...lines, [active.line]: { ...lines[active.line], [active.slot]: next } });
    // The caret goes after the token once React has written the new value.
    setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(start + token.length, start + token.length);
    }, 0);
  };
  const slotField = (line: PageKey, slot: keyof PageLine, label: string) => (
    <label>
      {label}
      <input
        type="text"
        ref={line === "header" && slot === "left" ? firstSlot : undefined}
        value={lines[line][slot]}
        onChange={(e) => setLines({ ...lines, [line]: { ...lines[line], [slot]: e.target.value } })}
        onFocus={(e) => {
          lastField.current = e.target;
          setActive({ line, slot });
        }}
        data-testid={`ps-${line}-${slot}`}
      />
    </label>
  );
  const write = (name: keyof typeof fields) => (event: { target: { value: string } }) =>
    setFields({ ...fields, [name]: event.target.value });
  const pickSize = (id: string) => {
    setSize(id);
    const named = namedSize(id);
    if (!named) return;
    // A standard size in the orientation on screen.
    const dimensions = withOrientation(named.width, named.height, landscape);
    setFields({ ...fields, width: String(toUnit(dimensions.width, unit)), height: String(toUnit(dimensions.height, unit)) });
  };
  const pickOrientation = (value: string) => {
    const want = value === "landscape";
    if (want === landscape) return;
    setLandscape(want);
    // The orientation is the order of the two dimensions: changing it swaps them.
    setFields({ ...fields, width: fields.height, height: fields.width });
  };
  const pickUnit = (next: LengthUnit) => {
    setUnit(next);
    const current = withOrientation(page.width, page.height, landscape);
    setFields(fieldsOf({ ...page, ...current }, next));
  };
  const custom = size === CUSTOM_SIZE;
  const field = (name: keyof typeof fields, label: string, disabled = false) => (
    <label>
      {label}
      <input
        type="number"
        step="any"
        value={fields[name]}
        disabled={disabled}
        onChange={write(name)}
        data-testid={`ps-${name}`}
      />
    </label>
  );
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog page-setup"
        role="dialog"
        aria-modal="true"
        aria-label={P.title}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) onApply(page);
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{P.title}</h2>
        <div className="dialog-row">
          <label>
            {P.size}
            <select value={size} onChange={(e) => pickSize(e.target.value)} data-testid="ps-size">
              {PAGE_SIZES.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.id}</option>
              ))}
              <option value={CUSTOM_SIZE}>{P.sizeCustom}</option>
            </select>
          </label>
          <label>
            {P.orientation}
            <select
              value={landscape ? "landscape" : "portrait"}
              onChange={(e) => pickOrientation(e.target.value)}
              data-testid="ps-orientation"
            >
              <option value="portrait">{P.portrait}</option>
              <option value="landscape">{P.landscape}</option>
            </select>
          </label>
          {field("width", P.width, !custom)}
          {field("height", P.height, !custom)}
          <label>
            {P.unit}
            <select value={unit} onChange={(e) => pickUnit(e.target.value as LengthUnit)} data-testid="ps-unit">
              <option value="mm">{P.unitMm}</option>
              <option value="pt">{P.unitPt}</option>
            </select>
          </label>
        </div>
        <h3>{P.margins}</h3>
        <div className="dialog-row">
          {field("top", P.top)}
          {field("right", P.right)}
          {field("bottom", P.bottom)}
          {field("left", P.left)}
        </div>
        <h3>{P.chrome}</h3>
        <p className="dialog-help" data-testid="ps-slot-hint">{P.slotHint}</p>
        <div className="dialog-row chrome-row">
          <span className="dialog-label">{P.headerLine}</span>
          {slotField("header", "left", P.slotLeft)}
          {slotField("header", "center", P.slotCenter)}
          {slotField("header", "right", P.slotRight)}
        </div>
        <div className="dialog-row chrome-row">
          <span className="dialog-label">{P.footerLine}</span>
          {slotField("footer", "left", P.slotLeft)}
          {slotField("footer", "center", P.slotCenter)}
          {slotField("footer", "right", P.slotRight)}
        </div>
        <div className="dialog-row chrome-row" role="group" aria-label={P.insert}>
          <span className="dialog-label">{P.insert}</span>
          {/* the buttons act on the slot that was last focused, disabled while there is none. */}
          <button type="button" disabled={!active} data-testid="ps-insert-page" onClick={() => insertToken(TOKENS.page)}>
            {P.insertPage}
          </button>
          <button type="button" disabled={!active} data-testid="ps-insert-date" onClick={() => insertToken(TOKENS.date)}>
            {P.insertDate}
          </button>
          <button type="button" disabled={!active} data-testid="ps-insert-file" onClick={() => insertToken(TOKENS.file)}>
            {P.insertFile}
          </button>
        </div>
        {problem && (
          <p className="dialog-problem" data-testid="ps-problem">
            {P.problems[problem]}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{P.cancel}</button>
          <button type="submit" className="primary" disabled={problem !== null} data-testid="ps-apply">
            {P.apply}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The two lines the dialog edits: the header and the footer of the page. */
type PageLines = { header: PageLine; footer: PageLine };
type PageKey = keyof PageLines;

/** The dialog's length fields for a page setup, as the text they show in `unit`. */
function fieldsOf(page: PageSetup, unit: LengthUnit) {
  return {
    width: String(toUnit(page.width, unit)),
    height: String(toUnit(page.height, unit)),
    top: String(toUnit(page.margins.top, unit)),
    right: String(toUnit(page.margins.right, unit)),
    bottom: String(toUnit(page.margins.bottom, unit)),
    left: String(toUnit(page.margins.left, unit)),
  };
}

/** The page setup the fields describe, in points (`0` for an empty field). */
function pageOf(size: string, fields: ReturnType<typeof fieldsOf>, unit: LengthUnit, lines: { header: PageLine; footer: PageLine }): PageSetup {
  return {
    size,
    header: lines.header,
    footer: lines.footer,
    width: fromUnit(Number(fields.width), unit),
    height: fromUnit(Number(fields.height), unit),
    margins: {
      top: fromUnit(Number(fields.top), unit),
      right: fromUnit(Number(fields.right), unit),
      bottom: fromUnit(Number(fields.bottom), unit),
      left: fromUnit(Number(fields.left), unit),
    },
  };
}

/** Ctrl+M: the size of a new matrix (the reference application's Insert Matrix). */
export function MatrixDialog({ onInsert, onCancel }: { onInsert: (rows: number, cols: number) => void; onCancel: () => void }) {
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const clamp = (n: number) => Math.min(100, Math.max(1, Math.round(n) || 1));
  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onCancel}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={S.editor.matrixTitle}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onInsert(clamp(rows), clamp(cols));
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>{S.editor.matrixTitle}</h2>
        <label>
          {S.editor.rows}
          <input ref={input} type="number" min={1} max={100} value={rows} onChange={(e) => setRows(Number(e.target.value))} />
        </label>
        <label>
          {S.editor.columns}
          <input type="number" min={1} max={100} value={cols} onChange={(e) => setCols(Number(e.target.value))} />
        </label>
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>{S.editor.cancel}</button>
          <button type="submit" className="primary">{S.editor.insert}</button>
        </div>
      </form>
    </div>
  );
}
