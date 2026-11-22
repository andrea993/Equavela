// A Julia block on the page: the header, the code drawn
// with its syntax colours, an editor on that code, and the play/stop button. The look is the one
// the block always had; the editor is a
// transparent text field laid exactly over the coloured code, so the caret and the selection sit
// on the drawn letters and the print draws the same coloured code.

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Edit } from "../components/codeEdit";
import type { Completions } from "../components/codeCompletion";
import { dedentTyped, newlineIndented } from "../components/codeIndent";
import { useCodeCompletion } from "../components/useCodeCompletion";
import { ptToPx } from "../layout/geometry";
import type { CellOutput, JuliaBlock, RegionKey } from "../equavelaApi";
import { S } from "../strings";
import { useRegionRunning } from "../workbench/runningRegion";
import { juliaHeader, tokenizeJulia } from "./juliaCode";

/** The line height of the code and the space above it, CSS px (`.julia-region`, `.julia-code`). */
const JULIA_LINE_PX = 18;
const JULIA_CODE_TOP_PX = 4;

/** The advance of one character of the code's monospace font, CSS px. */
function charWidth(element: HTMLElement): number {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(20);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit";
  element.append(probe);
  const width = probe.getBoundingClientRect().width / 20;
  probe.remove();
  return width > 0 ? width : 8;
}

/**
 * The kernel's completions for the code of a block of the worksheet in front; `null` where
 * there is no kernel to ask (the editor then offers its own words only).
 */
export const JuliaCompleteContext = createContext<((text: string, position: number) => Promise<Completions>) | null>(null);

/** A change of a block: its code, its enabled state or a Run. */
export type JuliaChange = { code?: string; playing?: boolean; run?: true; insertBelow?: true };

function HighlightedCode({ code }: { code: string }) {
  return (
    <>
      {tokenizeJulia(code).map((token, index) =>
        token.kind === "plain" ? token.text : (
          <span key={index} className={`jl-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
      {/* A last empty line still takes its height, as in the text field. */}
      {code.endsWith("\n") ? " " : null}
    </>
  );
}

export function JuliaView({
  block,
  size = null,
  selected,
  trusted = true,
  startEditing = false,
  state,
  failure,
  output,
  regionKey,
  onChange,
}: {
  block: JuliaBlock;
  /**
   * The box the block is drawn in, in points; `null` is a block without a
   * stored size, which grows with its header and its code.
   */
  size?: { w: number; h: number } | null;
  selected: boolean;
  /** An untrusted worksheet draws every block stopped. */
  trusted?: boolean;
  /** Open the editor at once. */
  startEditing?: boolean;
  /** The calculated state of the block and its failure message. */
  state?: "pending" | "stale" | "value" | "error";
  failure?: string;
  /** what the last evaluation wrote, how long it took and its trace. */
  output?: CellOutput | null;
  /** Subscribes only this cell to its execution events, including include instances. */
  regionKey?: RegionKey;
  onChange?: (change: JuliaChange) => void;
}) {
  const stored = block.code ?? "";
  const [draft, setDraft] = useState<string | null>(startEditing ? stored : null);
  const field = useRef<HTMLTextAreaElement>(null);
  const codeBox = useRef<HTMLDivElement>(null);
  const editing = draft !== null;
  const enabled = block.playing !== false;
  const playing = enabled && trusted;
  const running = useRegionRunning(regionKey?.region_id, regionKey?.document, regionKey?.instance);
  const complete = useContext(JuliaCompleteContext);

  /** Puts an edit in the editor: the code, then the caret once the field has it. */
  const apply = (edit: Edit) => {
    setDraft(edit.text);
    requestAnimationFrame(() => {
      const target = field.current;
      // Typing that came in before this frame owns the caret now.
      if (!target || target.value !== edit.text) return;
      target.setSelectionRange(edit.start, edit.end);
      followCaret(target);
    });
  };
  // the completion list of `.jl` tabs.
  const completion = useCodeCompletion({ area: field, text: draft ?? "", enabled: draft !== null, complete: complete ?? undefined, apply });

  useEffect(() => {
    if (editing) field.current?.focus({ preventScroll: true });
  }, [editing]);

  // in a box of a stored size the code scrolls inside it, and the line of the caret stays in
  // view: adding lines past the bottom scrolls down instead of growing the box. Called after the
  // text has been laid out (the field is as tall as the code).
  const followCaret = (target: HTMLTextAreaElement) => {
    const scroller = codeBox.current;
    if (!scroller || !size) return;
    const { value, selectionEnd } = target;
    requestAnimationFrame(() => {
      const before = value.slice(0, selectionEnd);
      const line = before.split("\n").length - 1;
      const column = before.length - (before.lastIndexOf("\n") + 1);
      const top = JULIA_CODE_TOP_PX + line * JULIA_LINE_PX;
      const bottom = top + JULIA_LINE_PX;
      if (top < scroller.scrollTop) scroller.scrollTop = top - JULIA_CODE_TOP_PX;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
      const left = column * charWidth(scroller);
      if (left < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - 12);
      else if (left + 12 > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = left + 12 - scroller.clientWidth;
    });
  };

  // leaving commits the code as one undo step; the same code writes nothing.
  const commit = () => {
    if (draft === null) return;
    if (draft !== stored) onChange?.({ code: draft });
    setDraft(null);
  };

  const requestRun = (insertBelow = false) => {
    if (!enabled || running) return;
    onChange?.({ ...(draft !== null && draft !== stored ? { code: draft } : {}), run: true, ...(insertBelow ? { insertBelow: true } : {}) });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (completion.keyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // the new line is indented for what the line before it opens.
      event.preventDefault();
      const target = event.currentTarget;
      apply(newlineIndented({ text: target.value, start: target.selectionStart, end: target.selectionEnd }));
    } else if (event.key === "Escape") {
      event.preventDefault();
      commit();
    } else if (event.key === "Enter" && ((event.ctrlKey || event.metaKey) && !event.shiftKey || event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)) {
      // One queued action commits before running; Shift+Enter also opens a cell below.
      event.preventDefault();
      requestRun(event.shiftKey);
    } else if (event.key === "Tab") {
      // A tab indents the code instead of leaving the field.
      event.preventDefault();
      const target = event.currentTarget;
      const { selectionStart, selectionEnd, value } = target;
      if (selectionStart === selectionEnd && !event.shiftKey) {
        setDraft(`${value.slice(0, selectionStart)}    ${value.slice(selectionEnd)}`);
        requestAnimationFrame(() => target.setSelectionRange(selectionStart + 4, selectionStart + 4));
      } else {
        const start = selectionStart === 0 ? 0 : value.lastIndexOf("\n", selectionStart - 1) + 1;
        const end = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
        const lineEnd = value.indexOf("\n", end);
        const stop = lineEnd < 0 ? value.length : lineEnd;
        const lines = value.slice(start, stop).split("\n");
        const changes = lines.map((line) => event.shiftKey ? (line.match(/^(?: {1,4}|\t)/)?.[0].length ?? 0) : -4);
        const updated = lines.map((line, i) => changes[i] < 0 ? `    ${line}` : line.slice(changes[i])).join("\n");
        setDraft(value.slice(0, start) + updated + value.slice(stop));
        const first = changes[0];
        const newStart = first < 0 ? selectionStart - first : Math.max(start, selectionStart - first);
        const newEnd = Math.max(newStart, selectionEnd - changes.reduce((a, b) => a + b, 0));
        requestAnimationFrame(() => target.setSelectionRange(newStart, newEnd));
      }
    }
  };

  // the output box of the last evaluation, floating below the cell.
  const [showOutput, setShowOutput] = useState(false);
  const outputBox = useRef<HTMLDivElement>(null);
  const text = output?.text ?? "";
  const trace = output?.trace ?? "";
  const hasOutput = text !== "" || trace !== "";
  const outputLines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
  useEffect(() => {
    if (!hasOutput) setShowOutput(false);
  }, [hasOutput]);
  useEffect(() => {
    if (!showOutput) return undefined;
    const press = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!outputBox.current?.contains(target) && !(target instanceof Element && target.closest('[data-testid="julia-output-toggle"]'))) setShowOutput(false);
    };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setShowOutput(false); };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [showOutput]);

  // the state in words; disabled and untrusted come before the calculated state.
  const stateKey = !enabled ? "disabled" : !trusted ? "untrusted" : running ? "running" : (state ?? "pending");

  // while the code is typed the header follows the text being typed.
  const header = editing ? juliaHeader(draft) : { using: block.using, imports: block.imports };
  const code = editing ? draft : stored;

  // a stored box is the size of the block. : while the code is edited the box grows to
  // the code, so the transparent field sits exactly on the drawn letters.
  const box = size ? { width: ptToPx(size.w), height: ptToPx(size.h) } : undefined;
  return (
    <div
      className={`julia-region${size ? " sized" : ""}${editing ? " editing" : ""}${playing ? "" : " stopped"}${selected || editing ? " active" : ""}${showOutput && hasOutput ? " output-open" : ""}`}
      style={box}
    >
      <div className="julia-head">
        <span className="label">{S.page.juliaLabel}</span>
        {header.using.length > 0 && <span className="using">using {header.using.join(", ")}</span>}
        {header.imports.map((item) => (
          <span key={item.name} className="using">
            {item.name} = {item.package}.{item.function}
          </span>
        ))}
        <span
          className={`julia-state no-print state-${stateKey}`}
          data-testid="julia-state"
          title={stateKey === "error" ? failure : undefined}
        >
          {S.page.juliaState[stateKey]}
          {output && (stateKey === "value" || stateKey === "error") && <> · {S.page.juliaDuration(output.duration_ms)}</>}
          {editing && draft !== stored && <> · {S.page.juliaState.edited}</>}
        </span>
        {hasOutput && (
          <button
            type="button"
            className="julia-output-toggle no-print"
            data-testid="julia-output-toggle"
            title={S.page.juliaOutputTitle}
            aria-expanded={showOutput}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setShowOutput((open) => !open)}
          >
            {S.page.juliaOutput(outputLines)}
          </button>
        )}
        {enabled && (
          <button
            type="button"
            className="julia-play julia-run no-print"
            data-testid="julia-run"
            aria-label={S.page.juliaRun}
            title={S.page.juliaRun}
            disabled={running}
            // the buttons never take the keyboard from the code editor.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              requestRun();
              setDraft(null);
            }}
          >
            ▶
          </button>
        )}
        <button
          type="button"
          className="julia-play no-print"
          data-testid="julia-play"
          aria-label={playing ? S.page.juliaStop : S.page.juliaPlay}
          title={playing ? S.page.juliaStop : S.page.juliaPlay}
          aria-pressed={playing}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            commit();
            onChange?.({ playing: !playing });
          }}
        >
          ⏻
        </button>
      </div>
      {(code !== "" || editing) && (
        <div
          ref={codeBox}
          className="julia-code-box"
          onClick={() => !editing && setDraft(stored)}
          // a press in the code box of a block being edited, but beside the field (past
          // the end of a line, under the last one), keeps the editor open: the field keeps the keyboard
          // and the caret goes to the end, instead of the sheet taking the keyboard.
          onMouseDown={(event) => {
            const editor = field.current;
            if (!editing || !editor || event.target === editor) return;
            event.preventDefault();
            editor.focus({ preventScroll: true });
            editor.setSelectionRange(editor.value.length, editor.value.length);
          }}
        >
          <div className="julia-code-inner">
            <pre className="julia-code" aria-hidden={editing}>
              <HighlightedCode code={code} />
            </pre>
            {editing && (
              <textarea
                ref={field}
                className="julia-editor no-print"
                data-testid="julia-editor"
                spellCheck={false}
                value={draft}
                onChange={(event) => {
                  const { value, selectionStart, selectionEnd } = event.target;
                  const before = draft ?? "";
                  // `end`, `else` or a closer typed at the start of a line goes back to its opener.
                  const typed = value.length > before.length ? dedentTyped({ text: value, start: selectionStart, end: selectionEnd }) : null;
                  if (typed && typed.text !== value) apply(typed);
                  else setDraft(value);
                  followCaret(event.target);
                  completion.changed(value, selectionStart, selectionEnd, before);
                }}
                onKeyDown={onKeyDown}
                onKeyUp={(event) => followCaret(event.currentTarget)}
                onClick={(event) => followCaret(event.currentTarget)}
                onBlur={() => {
                  completion.close();
                  commit();
                }}
              />
            )}
            {completion.popup}
          </div>
        </div>
      )}
      {code === "" && !editing && (
        <div className="julia-code-box julia-empty no-print" onClick={() => setDraft("")}>
          {S.page.juliaEmpty}
        </div>
      )}
      {showOutput && hasOutput && (
        <div ref={outputBox} className="julia-output no-print" data-testid="julia-output" role="region" aria-label={S.page.juliaOutputTitle}>
          {text !== "" && <pre className="julia-output-text">{text}</pre>}
          {trace !== "" && (
            <details className="julia-output-trace">
              <summary>{failure ? `${S.page.juliaTrace}: ${failure}` : S.page.juliaTrace}</summary>
              <pre>{trace}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
