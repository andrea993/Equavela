// The tabs of project files that are not worksheets:
// a text editor with line numbers, Julia files coloured like Julia blocks, and a read-only image view.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { tokenizeJulia } from "../page/juliaCode";
import { S } from "../strings";
import { Icon, ToolButton } from "./Chrome";
import type { FileTab } from "../workbench/useWorkbench";
import {
  commentPrefix,
  duplicateLines,
  findMatch,
  indentLines,
  lineOffset,
  moveLines,
  outdentLines,
  replaceAll,
  replaceMatch,
  toggleComment,
  type Edit,
} from "./codeEdit";
import type { Completions } from "./codeCompletion";
import { dedentTyped, newlineIndented } from "./codeIndent";
import { useCodeCompletion } from "./useCodeCompletion";

/** The coloured text behind the editor: Julia tokens for `.jl`, plain text otherwise. */
function Highlighted({ text, julia }: { text: string; julia: boolean }) {
  // A trailing newline needs a line of its own, or the last line of the textarea has no twin.
  const shown = text.endsWith("\n") ? `${text} ` : text;
  if (!julia) return <>{shown}</>;
  return <>{tokenizeJulia(shown).map((token, index) =>
    token.kind === "plain" ? token.text : <span key={index} className={`jl-${token.kind}`}>{token.text}</span>,
  )}</>;
}

/** The Code tab's commands that act on the editor in front. */
export type CodeCommand =
  | "undo" | "redo" | "cut" | "copy" | "paste" | "find" | "replace" | "goToLine"
  | "toggleComment" | "indent" | "outdent" | "duplicateLine" | "moveLineUp" | "moveLineDown";

/** The editor in front, for the ribbon and the command palette. */
let activeCodeEditor: ((command: CodeCommand) => void) | null = null;

/** Runs a Code command on the text tab in front; false when there is none. */
export function runCodeCommand(command: CodeCommand): boolean {
  if (!activeCodeEditor) return false;
  activeCodeEditor(command);
  return true;
}

type Bar = { mode: "find" | "replace" | "line"; query: string; replacement: string; note: string };

/** Whether the text tab's own history can step back or forward. */
export type CodeHistory = { canUndo: boolean; canRedo: boolean };

function TextEditor({ tab, onEdit, onSave, onReload, onClose, module, complete, onHistory }: {
  tab: FileTab;
  onEdit: (text: string) => void;
  onSave: () => void;
  onReload: () => void;
  onClose: () => void;
  /** Load in worksheets, for a `.jl` file of the project. */
  module?: { loaded: boolean; onToggle: (loaded: boolean) => void };
  /** the kernel's completions; rejects when the kernel cannot answer. */
  complete?: (text: string, position: number) => Promise<Completions>;
  onHistory?: (history: CodeHistory | null) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const back = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = tab.text.split("\n").length;
  const julia = tab.path.toLowerCase().endsWith(".jl");
  const modified = tab.text !== tab.saved;
  const sync = () => {
    const field = area.current;
    if (!field) return;
    if (back.current) {
      back.current.scrollTop = field.scrollTop;
      back.current.scrollLeft = field.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = field.scrollTop;
  };
  useLayoutEffect(sync, [tab.text]);

  // the editor's own undo history. Typing within half a second is one step.
  const history = useRef<{ undo: Edit[]; redo: Edit[]; last: number; tab: string }>({ undo: [], redo: [], last: 0, tab: tab.id });
  if (history.current.tab !== tab.id) history.current = { undo: [], redo: [], last: 0, tab: tab.id };
  const current = (): Edit => {
    const field = area.current;
    return { text: tab.text, start: field?.selectionStart ?? 0, end: field?.selectionEnd ?? 0 };
  };
  const select = (start: number, end: number, text?: string) => requestAnimationFrame(() => {
    const field = area.current;
    // Typing that came in before this frame owns the caret now.
    if (!field || (text !== undefined && field.value !== text)) return;
    field.focus();
    field.setSelectionRange(start, end);
  });
  const apply = (next: Edit, typing = false) => {
    if (next.text !== tab.text) {
      const now = Date.now();
      const steps = history.current;
      if (!typing || now - steps.last > 500 || steps.undo.length === 0) steps.undo.push(current());
      steps.last = typing ? now : 0;
      steps.redo = [];
      onEdit(next.text);
    }
    select(next.start, next.end, next.text);
  };
  const step = (from: "undo" | "redo") => {
    const steps = history.current;
    const target = steps[from].pop();
    if (!target) return;
    steps[from === "undo" ? "redo" : "undo"].push(current());
    steps.last = 0;
    onEdit(target.text);
    select(target.start, target.end);
  };
  // quick-access Undo and Redo follow this history; every step changes the text.
  const reportHistory = useRef(onHistory);
  reportHistory.current = onHistory;
  useEffect(() => {
    reportHistory.current?.({ canUndo: history.current.undo.length > 0, canRedo: history.current.redo.length > 0 });
  }, [tab.id, tab.text]);
  useEffect(() => () => reportHistory.current?.(null), []);

  // Find, Replace and Go to line share one bar at the top of the tab.
  const [bar, setBar] = useState<Bar | null>(null);
  const barField = useRef<HTMLInputElement>(null);
  const openBar = (mode: Bar["mode"]) => {
    const { text, start, end } = current();
    const selected = start !== end && !text.slice(start, end).includes("\n") ? text.slice(start, end) : "";
    setBar((old) => ({ mode, query: mode === "line" ? "" : selected || (old?.query ?? ""), replacement: old?.replacement ?? "", note: "" }));
    requestAnimationFrame(() => { barField.current?.focus(); barField.current?.select(); });
  };
  const find = (backwards = false) => {
    if (!bar) return;
    const match = findMatch(current(), bar.query, backwards);
    setBar({ ...bar, note: match ? "" : S.code.noMatch });
    if (match) select(match.start, match.end);
  };
  const goToLine = () => {
    if (!bar) return;
    const line = Number.parseInt(bar.query, 10);
    if (!Number.isFinite(line) || line < 1) return;
    const offset = lineOffset(tab.text, line);
    setBar(null);
    select(offset, offset);
  };

  // the completion list under the caret, local words first, the kernel's when they come.
  const completion = useCodeCompletion({ area, text: tab.text, enabled: julia, complete, apply: (edit) => apply(edit) });

  const prefix = commentPrefix(tab.path);
  const run = (command: CodeCommand) => {
    const field = area.current;
    switch (command) {
      case "undo": return step("undo");
      case "redo": return step("redo");
      case "cut":
      case "copy":
      case "paste":
        field?.focus();
        document.execCommand(command);
        return;
      case "find": return openBar("find");
      case "replace": return openBar("replace");
      case "goToLine": return openBar("line");
      case "toggleComment": return prefix ? apply(toggleComment(current(), prefix)) : undefined;
      case "indent": return apply(indentLines(current()));
      case "outdent": return apply(outdentLines(current()));
      case "duplicateLine": return apply(duplicateLines(current()));
      case "moveLineUp": return apply(moveLines(current(), "up"));
      case "moveLineDown": return apply(moveLines(current(), "down"));
    }
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const handler = (command: CodeCommand) => runRef.current(command);
    activeCodeEditor = handler;
    return () => { if (activeCodeEditor === handler) activeCodeEditor = null; };
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The worksheet's shortcuts never see the editor's keys.
    event.stopPropagation();
    if (completion.keyDown(event)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    const command: CodeCommand | null =
      mod && !event.shiftKey && key === "z" ? "undo"
      : mod && (key === "y" || (event.shiftKey && key === "z")) ? "redo"
      : mod && key === "f" ? "find"
      : mod && key === "h" ? "replace"
      : mod && key === "g" ? "goToLine"
      // The key that types `/`: Shift+7 on the Italian layout, so Shift is allowed.
      : mod && (event.key === "/" || event.code === "Slash") ? "toggleComment"
      : event.altKey && event.shiftKey && event.key === "ArrowDown" ? "duplicateLine"
      : event.altKey && !event.shiftKey && event.key === "ArrowUp" ? "moveLineUp"
      : event.altKey && !event.shiftKey && event.key === "ArrowDown" ? "moveLineDown"
      : event.key === "Tab" && event.shiftKey ? "outdent"
      : null;
    if (mod && key === "s") {
      event.preventDefault();
      onSave();
    } else if (mod && key === "w") {
      event.preventDefault();
      onClose();
    } else if (command) {
      event.preventDefault();
      run(command);
    } else if (event.key === "Enter" && !mod && !event.altKey) {
      // the new line is indented for what the line before it opens.
      event.preventDefault();
      apply(newlineIndented(current(), julia), true);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const edit = current();
      // Tab indents a selection of lines, or inserts four spaces at the caret.
      if (edit.start !== edit.end && tab.text.slice(edit.start, edit.end).includes("\n")) apply(indentLines(edit));
      else apply({ text: `${edit.text.slice(0, edit.start)}    ${edit.text.slice(edit.end)}`, start: edit.start + 4, end: edit.start + 4 });
    }
  };
  const barKey = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      setBar(null);
      area.current?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (bar?.mode === "line") goToLine();
      else find(event.shiftKey);
    }
  };
  return <div className="file-tab text">
    <div className="file-bar chrome no-print">
      <span className="file-path" title={tab.id}>{tab.path}{modified && <span aria-label={S.documents.modified}> *</span>}</span>
      <span className="file-tools">
        {module && <label className="file-module" title={S.juliaModule.loadTitle}>
          <input type="checkbox" checked={module.loaded} onChange={(event) => module.onToggle(event.target.checked)} />
          {S.juliaModule.load}
        </label>}
        {/* The same glyphs and buttons as the title bar's quick access. */}
        <ToolButton label={S.quickAccess.save} title={`${S.quickAccess.save} (Ctrl+S)`} icon={<Icon>▣</Icon>} iconOnly disabled={!modified} onClick={onSave} />
        <ToolButton label={S.project.reload} icon={<Icon>⟳</Icon>} iconOnly onClick={onReload} />
      </span>
    </div>
    {bar && <div className="code-bar chrome no-print" role="search" aria-label={bar.mode === "line" ? S.code.goToLine : S.code.find}>
      <input
        ref={barField}
        aria-label={bar.mode === "line" ? S.code.lineNumber : S.code.find}
        placeholder={bar.mode === "line" ? S.code.lineNumber : S.code.find}
        inputMode={bar.mode === "line" ? "numeric" : undefined}
        value={bar.query}
        onChange={(event) => setBar({ ...bar, query: event.target.value, note: "" })}
        onKeyDown={barKey}
      />
      {bar.mode === "replace" && <input
        aria-label={S.code.replaceWith}
        placeholder={S.code.replaceWith}
        value={bar.replacement}
        onChange={(event) => setBar({ ...bar, replacement: event.target.value })}
        onKeyDown={barKey}
      />}
      {bar.mode !== "line" && <>
        <button type="button" onClick={() => find(true)} title={S.code.previous} aria-label={S.code.previous}>↑</button>
        <button type="button" onClick={() => find()} title={S.code.next} aria-label={S.code.next}>↓</button>
      </>}
      {bar.mode === "replace" && <>
        <button type="button" onClick={() => apply(replaceMatch(current(), bar.query, bar.replacement))}>{S.code.replace}</button>
        <button type="button" onClick={() => {
          const { edit, count } = replaceAll(current(), bar.query, bar.replacement);
          apply(edit);
          setBar({ ...bar, note: S.code.replaced(count) });
        }}>{S.code.replaceAll}</button>
      </>}
      {bar.mode === "line" && <button type="button" onClick={goToLine}>{S.code.go}</button>}
      {bar.note && <span className="code-bar-note" role="status">{bar.note}</span>}
      <button type="button" className="code-bar-close" aria-label={S.code.closeBar} title={S.code.closeBar} onClick={() => { setBar(null); area.current?.focus(); }}>×</button>
    </div>}
    <div className="file-editor">
      <div className="file-gutter" ref={gutter} aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => <div key={index}>{index + 1}</div>)}
      </div>
      <div className="file-code">
        <pre ref={back} aria-hidden="true"><Highlighted text={tab.text} julia={julia} /></pre>
        {completion.popup}
        <textarea
          ref={area}
          aria-label={tab.path}
          spellCheck={false}
          wrap="off"
          value={tab.text}
          onChange={(event) => {
            const { value, selectionStart, selectionEnd } = event.target;
            const typed = { text: value, start: selectionStart, end: selectionEnd };
            // `end`, `else` or a closer typed at the start of a line goes back to its opener.
            apply(julia && value.length > tab.text.length ? dedentTyped(typed) : typed, true);
            completion.changed(value, selectionStart, selectionEnd, tab.text);
          }}
          onClick={() => { if (completion.shown) completion.close(); }}
          onBlur={() => { if (completion.shown) completion.close(); }}
          onScroll={sync}
          onKeyDown={keyDown}
        />
      </div>
    </div>
  </div>;
}

function ImageViewer({ tab }: { tab: FileTab }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  return <div className="file-tab image">
    <div className="file-bar chrome no-print">
      <span className="file-path" title={tab.id}>{tab.path}</span>
      {size && <span className="file-size">{S.project.imageSize(size.width, size.height)}</span>}
    </div>
    <div className="file-image">
      <img
        src={tab.image}
        alt={tab.path}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      />
    </div>
  </div>;
}

/** The view of the active file tab. */
export function FileTabView({ tab, onEdit, onSave, onReload, onClose, module, complete, onHistory }: {
  tab: FileTab;
  onEdit: (text: string) => void;
  onSave: () => void;
  onReload: () => void;
  onClose: () => void;
  module?: { loaded: boolean; onToggle: (loaded: boolean) => void };
  complete?: (text: string, position: number) => Promise<Completions>;
  /** the text editor's history, null when there is none (an image, or the tab closed). */
  onHistory?: (history: CodeHistory | null) => void;
}) {
  return tab.kind === "image"
    ? <ImageViewer tab={tab} />
    : <TextEditor tab={tab} onEdit={onEdit} onSave={onSave} onReload={onReload} onClose={onClose} module={module} complete={complete} onHistory={onHistory} />;
}

/**
 * A project worksheet's sheet under a file bar: its project-relative path, `*` while
 * modified, and a Save icon for this file alone. Other worksheets show the sheet as it is.
 */
export function SheetFrame({ path, modified, pendingEdit = false, onSave, children }: {
  path: string | null;
  modified: boolean;
  pendingEdit?: boolean;
  onSave: () => void;
  children: ReactNode;
}) {
  if (path === null) return <>{children}</>;
  return <div className="file-tab sheet-frame">
    <div className="file-bar chrome no-print">
      <span className="file-path">{path}{modified && <span aria-label={S.documents.modified}> *</span>}</span>
      <span className="file-tools">
        <ToolButton label={S.project.saveFile} title={`${S.project.saveFile} (Ctrl+S)`} icon={<Icon>▣</Icon>} iconOnly disabled={!modified && !pendingEdit} onClick={onSave} />
      </span>
    </div>
    <div className="sheet-under-bar">{children}</div>
  </div>;
}
