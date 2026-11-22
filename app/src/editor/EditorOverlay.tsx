// The editing lines of the active math region, drawn as an SVG over the
// region from the measured boxes of the addressable nodes (`data-path`, render.tsx):
// a blue underline below the focused sub-expression and a vertical insertion line at its
// left or right edge, or at the caret inside a name, number or string. An explicit
// selection is shaded. Measurements are in layout px: client rects divided by the zoom
// (R9). Screen only (`no-print`).

import { useLayoutEffect, useState, type RefObject } from "react";
import { activeShiftDrag, definitionOnlyPaths, selectedMatrixCells, selectedTermPaths, type ArgSelection, type EditorState } from "./model";
import { get, type Path } from "./tree";
import type { Completion } from "./autocomplete";
import { S } from "../strings";

type Box = { x0: number; y0: number; x1: number; y1: number };
type Lines = { box: Box; caretX: number; caretTop: number; caretBottom: number; explicit: boolean; matrixBoxes: Box[] };

const pathKey = (path: Path) => path.join(".");

/**
 * The union of the client rects of an element and all its descendants, except the result an evaluation
 * draws after its operator (`span.result`): the editing lines belong to the expression, so a tall
 * matrix result must not stretch the insertion line and the underline of the statement over its height.
 */
// The box that clips what it holds: a part inside one
// is drawn only within its edges, so a selection box over it stops there too.
const CLIPPING = ".result-matrix-scroll";

export function unionRect(element: Element): DOMRect | null {
  let box: { l: number; t: number; r: number; b: number } | null = null;
  const add = (r: DOMRect, clip: Element | null) => {
    if (r.width === 0 && r.height === 0) return;
    if (clip) {
      const c = clip.getBoundingClientRect();
      const l = Math.max(r.left, c.left);
      const t = Math.max(r.top, c.top);
      const rr = Math.min(r.right, c.right);
      const bb = Math.min(r.bottom, c.bottom);
      if (rr <= l || bb <= t) return;
      r = new DOMRect(l, t, rr - l, bb - t);
    }
    box = box
      ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) }
      : { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  // The element's own boxes run on over an inline result that follows the expression: leave them out then.
  const clipOf = (e: Element) => e.parentElement?.closest(CLIPPING) ?? null;
  if (element.closest(".result") || !element.querySelector(".result")) {
    const clip = clipOf(element);
    for (const r of element.getClientRects()) add(r, clip);
  }
  for (const child of element.querySelectorAll("*")) {
    if (child.closest(".result") && !element.closest(".result")) continue;
    const clip = clipOf(child);
    for (const r of child.getClientRects()) add(r, clip);
  }
  if (!box) return null;
  const b = box as { l: number; t: number; r: number; b: number };
  return new DOMRect(b.l, b.t, b.r - b.l, b.b - b.t);
}

/**
 * The box that spans a run of call arguments: from the left of its first argument to the
 * right of its last, the commas and everything between them included.
 */
function runRect(root: Element, run: ArgSelection): DOMRect | null {
  return pathsRect(root, Array.from({ length: run.last - run.first + 1 }, (_, k) => [...run.path, run.first + k + 1]));
}

/** The box over the nodes at `paths` (a run of arguments or of terms), the gaps between them included. */
function pathsRect(root: Element, paths: Path[]): DOMRect | null {
  let box: DOMRect | null = null;
  for (const path of paths) {
    const element = root.querySelector(`[data-path="${pathKey(path)}"]`);
    const rect = element ? unionRect(element) : null;
    if (!rect) continue;
    box = box
      ? new DOMRect(
          Math.min(box.left, rect.left),
          Math.min(box.top, rect.top),
          Math.max(box.right, rect.right) - Math.min(box.left, rect.left),
          Math.max(box.bottom, rect.bottom) - Math.min(box.top, rect.top),
        )
      : rect;
  }
  return box;
}

/** The text spans of a leaf, one per name segment (or the single literal span). */
export function leafTextSpans(leaf: Element): HTMLElement[] {
  const name = leaf.querySelector(":scope > .name");
  if (name) return [...name.children] as HTMLElement[];
  const literal = leaf.querySelector(":scope > .num-lit, :scope > .str");
  return literal ? [literal as HTMLElement] : [];
}

function textClientX(span: HTMLElement, at: number): number | null {
  const text = span.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE) return null;
  const length = (text.textContent ?? "").length;
  const index = Math.min(Math.max(at, 0), length);
  const range = document.createRange();
  range.setStart(text, index);
  range.setEnd(text, index);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.left === 0) {
    const r = span.getBoundingClientRect();
    return index === 0 ? r.left : r.right;
  }
  return rect.left;
}

/**
 * The x of a caret inside a string that may be split over several drawn lines: pick the piece
 * that holds the character (a break at the offset means the character starts the continuation
 * line, so the piece that starts there wins), then the position inside that piece.
 */
function stringClientX(str: HTMLElement, offset: number): number | null {
  const chunks = [...str.querySelectorAll<HTMLElement>("[data-str-offset]")].map((chunk) => ({
    chunk,
    start: Number(chunk.dataset.strOffset ?? 0),
  }));
  if (chunks.length === 0) {
    // An empty string (or a break at its start and end): the caret sits between the quotes.
    const open = str.querySelector<HTMLElement>(":scope > .str-quote:first-child");
    return open ? open.getBoundingClientRect().right : null;
  }
  const end = chunks.reduce((max, { chunk, start }) => Math.max(max, start + (chunk.textContent?.length ?? 0)), 0);
  if (offset >= end) {
    const close = str.querySelector<HTMLElement>(":scope > .str-quote:last-child");
    return close ? close.getBoundingClientRect().left : null;
  }
  const chosen =
    chunks.find(({ start }) => start === offset) ??
    [...chunks].reverse().find(({ start }) => start < offset) ??
    chunks[0];
  return textClientX(chosen.chunk, offset - chosen.start);
}

function caretClientX(leaf: Element, seg: number, offset: number, quoted: boolean): number | null {
  if (quoted) {
    const str = leaf.querySelector<HTMLElement>(":scope > .str");
    const x = str ? stringClientX(str, offset) : null;
    if (x !== null) return x;
  }
  const span = leafTextSpans(leaf)[seg];
  if (!span) return null;
  return textClientX(span, offset);
}

export function EditorOverlay({
  editor,
  container,
  completions = [],
  completionIndex = 0,
  onCompletion,
}: {
  editor: EditorState;
  container: RefObject<HTMLElement | null>;
  completions?: readonly Completion[];
  completionIndex?: number;
  onCompletion?: (completion: Completion) => void;
}) {
  const [lines, setLines] = useState<Lines | null>(null);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const measure = () => {
      const element = root.querySelector(`[data-path="${pathKey(editor.focus)}"]`);
      const selectedRun = editor.argSelection
        ? runRect(root, editor.argSelection)
        : editor.termSelection
          ? pathsRect(root, selectedTermPaths(editor))
          : editor.definitionOnly
            ? pathsRect(root, definitionOnlyPaths(editor))
            : null;
      const rect = selectedRun ?? (element ? unionRect(element) : null);
      if (!element || !rect) {
        setLines(null);
        return;
      }
      const origin = root.getBoundingClientRect();
      const zoom = root.offsetWidth > 0 ? origin.width / root.offsetWidth : 1;
      const toX = (x: number) => (x - origin.left) / zoom;
      const toY = (y: number) => (y - origin.top) / zoom;
      const box = { x0: toX(rect.left), y0: toY(rect.top), x1: toX(rect.right), y1: toY(rect.bottom) };
      const moving = activeShiftDrag(editor)?.end;
      const caretElement = moving ? root.querySelector(`[data-path="${pathKey(moving.focus)}"]`) : element;
      const caretRect = moving && caretElement ? unionRect(caretElement) ?? rect : rect;
      const caret = moving ? moving.caret : editor.explicit ? null : editor.caret;
      let caretX = toX((moving?.side ?? editor.side) === "L" ? caretRect.left : caretRect.right);
      if (caret && caretElement) {
        const quoted = caretElement.querySelector(":scope > .str") !== null;
        const x = caretClientX(caretElement, caret.seg, caret.offset, quoted);
        if (x !== null) caretX = toX(x);
      }
      const matrixBoxes: Box[] = [];
      if (editor.matrixSelection) {
        const selection = editor.matrixSelection;
        const matrix = get(editor.root, selection.path);
        if (matrix.type === "Matrix") {
          for (const i of selectedMatrixCells(matrix.rows, matrix.cols, selection)) {
            const cell = root.querySelector(`[data-cell-path="${pathKey([...selection.path, i])}"]`);
            const r = cell?.getBoundingClientRect();
            if (r) matrixBoxes.push({ x0: toX(r.left), y0: toY(r.top), x1: toX(r.right), y1: toY(r.bottom) });
          }
        }
      }
      if (matrixBoxes.length > 1) {
        const bounds = {
          x0: Math.min(...matrixBoxes.map((r) => r.x0)) - 2,
          y0: Math.min(...matrixBoxes.map((r) => r.y0)) - 2,
          x1: Math.max(...matrixBoxes.map((r) => r.x1)) + 2,
          y1: Math.max(...matrixBoxes.map((r) => r.y1)) + 2,
        };
        matrixBoxes.splice(0, matrixBoxes.length, bounds);
      }
      setLines({ box, caretX, caretTop: toY(caretRect.top), caretBottom: toY(caretRect.bottom), explicit: editor.explicit, matrixBoxes });
    };
    measure();
    // Fonts finishing to load change the metrics.
    void document.fonts?.ready.then(measure);
  }, [editor, container]);

  if (!lines) return null;
  const { box, caretX, caretTop, caretBottom, explicit, matrixBoxes } = lines;
  const pad = 1;
  return (
    <>
      <svg className="editing-lines no-print" aria-hidden="true" data-testid="editing-lines">
        {matrixBoxes.map((cell, i) => (
          <rect key={i} className="selection matrix-selection" x={cell.x0} y={cell.y0} width={Math.max(0, cell.x1 - cell.x0)} height={Math.max(0, cell.y1 - cell.y0)} />
        ))}
        {explicit && (
          <rect className="selection" x={box.x0} y={box.y0} width={Math.max(0, box.x1 - box.x0)} height={Math.max(0, box.y1 - box.y0)} />
        )}
        <line className="underline" x1={box.x0} y1={box.y1 + pad} x2={box.x1} y2={box.y1 + pad} />
        <line className="insertion" x1={caretX} y1={caretTop - pad} x2={caretX} y2={caretBottom + pad} />
      </svg>
      {completions.length > 0 && (
        <div
          className="math-autocomplete no-print"
          role="listbox"
          aria-label={S.editor.autocomplete.label}
          style={{ left: box.x0, top: box.y1 + 5 }}
        >
          {completions.map((completion, index) => (
            <div
              className={index === completionIndex ? "active" : ""}
              role="option"
              aria-selected={index === completionIndex}
              key={`${completion.kind}:${completion.name}`}
              title={completion.description}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onCompletion?.(completion);
              }}
            >
              <span className="completion-name">{completion.name}</span>
              <span className="completion-detail">
                {completion.detail ?? S.editor.autocomplete[completion.kind]}
              </span>
              {index === completionIndex && <span className="completion-accept">{S.editor.autocomplete.accept}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
