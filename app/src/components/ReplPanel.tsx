// The Julia REPL panel at the bottom of the window: code typed here runs
// in a REPL module of its own in the kernel of the worksheet in front, never in a worksheet.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ReplResult } from "../equavelaApi";
import { S } from "../strings";
import { INDENT, afterTab, charactersBefore, indents, replaceCharacters, type Completion } from "./replComplete";

type Entry =
  | { kind: "run"; code: string; result: ReplResult }
  | { kind: "note"; text: string };

/** the panel's height, 120 to 600 CSS px. */
export const REPL_MIN = 120;
export const REPL_MAX = 600;

export function ReplPanel({ target, height, onHeight, run, complete, stop, onClose }: {
  /** The environment the REPL evaluates in, or null with no worksheet open. */
  target: { key: string; label: string } | null;
  height: number;
  onHeight: (height: number) => void;
  run: (code: string, reset?: boolean) => Promise<ReplResult>;
  /** the candidates for `text` at a character position, in the REPL module. */
  complete: (text: string, position: number) => Promise<Completion>;
  stop: () => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [code, setCode] = useState("");
  const codeRef = useRef("");
  codeRef.current = code;
  /** the open pick list. */
  const [pick, setPick] = useState<{ items: string[]; from: number; to: number; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const history = useRef<string[]>([]);
  const cursor = useRef<number | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastTarget = useRef<string | null | undefined>(undefined);

  // a switch to another environment's kernel is said in the panel.
  useEffect(() => {
    const key = target?.key ?? null;
    if (lastTarget.current !== undefined && lastTarget.current !== key) {
      setEntries((list) => [...list, { kind: "note", text: target ? S.repl.switched(target.label) : S.repl.noKernel }]);
    }
    lastTarget.current = key;
  }, [target]);
  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [entries]);

  const submit = async () => {
    if (!target || busy || code.trim() === "") return;
    setBusy(true);
    try {
      const result = await run(code);
      if (result.incomplete) {
        // an incomplete expression goes on on a new line.
        const field = input.current;
        const at = field?.selectionStart ?? code.length;
        setCode(`${code.slice(0, at)}\n${code.slice(at)}`);
        requestAnimationFrame(() => field?.setSelectionRange(at + 1, at + 1));
        return;
      }
      history.current.push(code);
      cursor.current = null;
      setEntries((list) => [...list, { kind: "run", code, result }]);
      setCode("");
    } catch (error) {
      const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
      setEntries((list) => [...list, { kind: "note", text: S.repl.failed(message) }]);
    } finally {
      setBusy(false);
    }
  };

  /** Puts `text` in the input with the caret at `caret`. */
  const setText = (text: string, caret: number) => {
    setCode(text);

    cursor.current = null;
    requestAnimationFrame(() => input.current?.setSelectionRange(caret, caret));
  };

  /** Tab. */
  const tab = async (field: HTMLTextAreaElement) => {
    if (!target || busy) return;
    const text = code;
    const caret = field.selectionStart;
    if (field.selectionEnd === caret && text.trim() !== "" && indents(text, caret)) {
      setText(`${text.slice(0, caret)}${INDENT}${text.slice(caret)}`, caret + INDENT.length);
      return;
    }
    let completion: Completion;
    try {
      completion = await complete(text, charactersBefore(text, caret));
    } catch {
      return; // no candidates: the input stays as it is
    }
    if (codeRef.current !== text) return; // typed meanwhile
    const outcome = afterTab(text, completion);
    if (outcome.kind === "edit") setText(outcome.text, outcome.caret);
    else if (outcome.kind === "list") setPick({ items: outcome.items, from: outcome.from, to: outcome.to, index: 0 });
  };

  const accept = (item: string) => {
    if (!pick) return;
    const done = replaceCharacters(code, pick.from, pick.to, item);
    setPick(null);
    setText(done.text, done.caret);
    input.current?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const before = code.slice(0, field.selectionStart);
    const after = code.slice(field.selectionEnd);
    if (pick) {
      // the pick list owns the arrows, Tab, Enter and Escape; any other key closes it.
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : pick.items.length - 1;
        setPick({ ...pick, index: (pick.index + step) % pick.items.length });
        return;
      }
      if ((event.key === "Tab" && !event.shiftKey) || event.key === "Enter") {
        event.preventDefault();
        accept(pick.items[pick.index]);
        return;
      }
      setPick(null);
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // The focus never leaves the input; Shift+Tab does nothing.
      event.preventDefault();
      if (!event.shiftKey) void tab(field);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      setEntries([]);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && field.selectionStart === field.selectionEnd && busy) {
      event.preventDefault();
      stop();
    } else if (event.key === "ArrowUp" && !before.includes("\n") && history.current.length) {
      event.preventDefault();
      const next = cursor.current === null ? history.current.length - 1 : Math.max(0, cursor.current - 1);
      cursor.current = next;
      setCode(history.current[next]);
    } else if (event.key === "ArrowDown" && !after.includes("\n") && cursor.current !== null) {
      event.preventDefault();
      const next = cursor.current + 1;
      cursor.current = next < history.current.length ? next : null;
      setCode(cursor.current === null ? "" : history.current[next]);
    }
  };

  // the separator above the panel sets its height.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    dragCleanup.current?.();
    const startY = event.clientY;
    const startHeight = height;
    const move = (moved: globalThis.PointerEvent) =>
      onHeight(Math.min(REPL_MAX, Math.max(REPL_MIN, startHeight + startY - moved.clientY)));
    const stopDrag = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      if (dragCleanup.current === stopDrag) dragCleanup.current = null;
    };
    dragCleanup.current = stopDrag;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
  };

  return (
    <section className="chrome repl-panel" aria-label={S.repl.title} style={{ height }}>
      <div
        className="repl-separator"
        role="separator"
        aria-orientation="horizontal"
        aria-label={S.repl.resize}
        aria-valuemin={REPL_MIN}
        aria-valuemax={REPL_MAX}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") onHeight(Math.min(REPL_MAX, height + 20));
          if (event.key === "ArrowDown") onHeight(Math.max(REPL_MIN, height - 20));
        }}
      />
      <div className="repl-head">
        <span className="repl-title">{S.repl.title}</span>
        <span className="repl-target">{target ? target.label : S.repl.noKernel}</span>
        <span className="grow" />
        <button type="button" disabled={!busy} onClick={stop} title={S.repl.stopTitle}>{S.repl.stop}</button>
        <button type="button" onClick={() => setEntries([])} title={S.repl.clearTitle}>{S.repl.clear}</button>
        <button type="button" aria-label={S.repl.close} title={S.repl.close} onClick={onClose}>×</button>
      </div>
      <div
        ref={log}
        className="repl-log"
        role="log"
        aria-label={S.repl.output}
        tabIndex={0}
        onKeyDown={(event) => {
          // Ctrl+A in the output selects the output, not the page; Ctrl+C copies the selection.
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && log.current) {
            event.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(log.current);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        }}
      >
        {entries.map((entry, index) =>
          entry.kind === "note" ? (
            <div key={index} className="repl-note">{entry.text}</div>
          ) : (
            <div key={index} className="repl-entry">
              <pre className="repl-input">{entry.code}</pre>
              {entry.result.output && <pre className="repl-output">{entry.result.output}</pre>}
              {entry.result.value !== null && entry.result.value !== undefined && <pre className="repl-value">{entry.result.value}</pre>}
              {entry.result.error && (
                <details className="repl-error">
                  <summary>{entry.result.error}</summary>
                  {entry.result.trace && <pre>{entry.result.trace}</pre>}
                </details>
              )}
              <div className="repl-duration">{S.page.juliaDuration(entry.result.duration * 1000)}</div>
            </div>
          ),
        )}
      </div>
      <div className="repl-prompt">
        <span aria-hidden="true">julia&gt;</span>
        <textarea
          ref={input}
          aria-label={S.repl.input}
          rows={Math.min(6, code.split("\n").length)}
          spellCheck={false}
          disabled={!target}
          value={code}
          placeholder={busy ? S.repl.running : S.repl.placeholder}
          onChange={(event) => { setCode(event.target.value); cursor.current = null; setPick(null); }}
          onKeyDown={keyDown}
          onBlur={() => setPick(null)}
        />
        {pick && (
          <ul className="repl-completions" role="listbox" aria-label={S.repl.completions}>
            {pick.items.map((item, index) => (
              <li
                key={item}
                role="option"
                aria-selected={index === pick.index}
                className={index === pick.index ? "selected" : undefined}
                // The press, not the click: the input must not lose its focus (and with it the list).
                onMouseDown={(event) => { event.preventDefault(); accept(item); }}
              >
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
