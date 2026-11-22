// The completion list of a code editor: the
// editor's own words at once, the kernel's when they come, under the caret of a text field. Shared
// by `.jl` text tabs and the editor of a Julia block.

import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { S } from "../strings";
import type { Edit } from "./codeEdit";
import { localCompletions, mergeCompletions, opensCompletion, type Completions } from "./codeCompletion";

type Shown = Completions & { index: number; top: number; left: number };

/** The caret's box below the line at `position` of `text`, in window coordinates. */
function caretBox(field: HTMLTextAreaElement, text: string, position: number): { top: number; left: number } {
  const style = getComputedStyle(field);
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = before.length - (before.lastIndexOf("\n") + 1);
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(20);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font}`;
  document.body.append(probe);
  const charWidth = probe.getBoundingClientRect().width / 20 || 8;
  probe.remove();
  // A field drawn at a zoom (a block on the page) is measured in its own pixels: scale to the window.
  const rect = field.getBoundingClientRect();
  const scale = field.offsetWidth > 0 && rect.width > 0 ? rect.width / field.offsetWidth : 1;
  return {
    top: rect.top + (line * lineHeight + (Number.parseFloat(style.paddingTop) || 0) - field.scrollTop) * scale,
    left: rect.left + (column * charWidth + (Number.parseFloat(style.paddingLeft) || 0) - field.scrollLeft) * scale,
  };
}

export function useCodeCompletion({ area, text, enabled, complete, apply }: {
  area: RefObject<HTMLTextAreaElement | null>;
  /** The editor's text now. */
  text: string;
  enabled: boolean;
  /** The kernel's completions; rejects when the kernel cannot answer. */
  complete?: (text: string, position: number) => Promise<Completions>;
  /** Puts an edit in the editor (accepting an item). */
  apply: (edit: Edit) => void;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const request = useRef(0);

  const open = (value: string, position: number) => {
    if (!enabled) return;
    const local = localCompletions(value, position);
    const ticket = ++request.current;
    const show = (list: Completions) => {
      const field = area.current;
      if (ticket !== request.current || !field) return;
      setShown(list.items.length ? { ...list, index: 0, ...caretBox(field, value, list.from) } : null);
    };
    show(local);
    complete?.(value, position).then(
      (kernel) => {
        // A late answer for an older caret position is dropped.
        const field = area.current;
        if (!field || field.selectionStart !== position || field.value !== value) return;
        show(mergeCompletions(local, kernel));
      },
      () => undefined,
    );
  };
  const close = () => {
    request.current++;
    setShown(null);
  };
  const accept = () => {
    if (!shown) return;
    const field = area.current;
    const end = field?.selectionEnd ?? shown.to;
    const item = shown.items[shown.index];
    const caret = shown.from + item.length;
    close();
    apply({ text: text.slice(0, shown.from) + item + text.slice(end), start: caret, end: caret });
  };

  /** The keys of an open list and Ctrl+Space; true when the key was the list's. */
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (shown) {
      const move = (step: number) => setShown({ ...shown, index: (shown.index + step + shown.items.length) % shown.items.length });
      if (event.key === "ArrowDown") { event.preventDefault(); move(1); return true; }
      if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return true; }
      if (event.key === "Enter" || event.key === "Tab") {
        // An item that is just what was typed (`end`) adds nothing: Enter then starts the new line.
        const typed = text.slice(shown.from, event.currentTarget.selectionStart);
        if (event.key === "Enter" && shown.items[shown.index] === typed) { close(); return false; }
        event.preventDefault();
        accept();
        return true;
      }
      if (event.key === "Escape") { event.preventDefault(); close(); return true; }
    }
    if (enabled && (event.ctrlKey || event.metaKey) && event.key === " ") {
      event.preventDefault();
      open(text, event.currentTarget.selectionStart);
      return true;
    }
    return false;
  };

  /** After the field changed to `value`: opens the list while a name is typed, else closes it. */
  const changed = (value: string, start: number, end: number, before: string) => {
    if (start === end && value.length > before.length && opensCompletion(value, start)) open(value, start);
    else if (shown) close();
  };

  const popup: ReactNode = shown
    ? createPortal(
        <ul className="code-completion no-print" role="listbox" aria-label={S.code.completions} style={{ position: "fixed", top: shown.top, left: shown.left }}>
          {shown.items.map((item, index) => (
            <li
              key={item}
              role="option"
              aria-selected={index === shown.index}
              ref={index === shown.index ? (node) => node?.scrollIntoView?.({ block: "nearest" }) : undefined}
              onPointerDown={(event) => { event.preventDefault(); setShown({ ...shown, index }); }}
              onClick={accept}
            >{item}</li>
          ))}
        </ul>,
        document.body,
      )
    : null;

  return { shown: shown !== null, keyDown, changed, close, popup };
}
