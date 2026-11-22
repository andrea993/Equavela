// Mouse hit-testing on rendered math: the deepest addressable node under the
// pointer, the side of it that was clicked and, inside a name or number, the character.

import { leafTextSpans, unionRect } from "./EditorOverlay";
import { textGapOffsets } from "./gaps";
import type { Caret, Side } from "./model";
import type { Path } from "./tree";

export type Hit = { path: Path; side: Side; caret: Caret | null };

export function parsePath(key: string | null): Path | null {
  if (key === null) return null;
  if (key === "") return [];
  const parts = key.split(".").map(Number);
  return parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
}

function caretOffset(span: HTMLElement, clientX: number): number {
  const text = span.firstChild;
  const value = text?.textContent;
  if (!text || !value) return 0;
  // jsdom has no layout for ranges; the start of the piece is the best answer there.
  if (typeof Range.prototype.getBoundingClientRect !== "function") return 0;
  // Nearest character boundary, measured with ranges.
  let best = 0;
  let bestDistance = Infinity;
  for (const i of textGapOffsets(value)) {
    const range = document.createRange();
    range.setStart(text, i);
    range.setEnd(text, i);
    const x = range.getBoundingClientRect().left;
    const distance = Math.abs(x - clientX);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

export function mathHit(container: Element, target: EventTarget | null, clientX: number, clientY: number): Hit | null {
  const targetElement = target instanceof Element ? target : null;
  // The result of a region is not its math: its nodes carry paths of the result.
  if (targetElement?.closest(".result")) return null;
  const fence = targetElement?.closest(".fence-side");
  const fenced = fence?.closest("[data-path]");
  if (fence && fenced && container.contains(fenced)) {
    const path = parsePath(fenced.getAttribute("data-path"));
    if (path) return { path, side: fence.classList.contains("left") ? "L" : "R", caret: null };
  }
  let cell = targetElement?.closest("[data-cell-path]") ?? null;
  // Cell padding and gaps within a grid keep their nearest cell. The fences have outer gaps.
  const grid = targetElement?.closest(".matrix")?.querySelector(":scope > .matrix-grid") ?? null;
  if (!cell && grid) {
    let distance = Infinity;
    for (const candidate of grid.querySelectorAll(":scope > [data-cell-path]")) {
      const r = candidate.getBoundingClientRect();
      const dx = Math.max(r.left - clientX, 0, clientX - r.right);
      const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
      const d = dx * dx + dy * dy;
      if (d < distance) { cell = candidate; distance = d; }
    }
  }
  const node = targetElement?.closest("[data-path]");
  const element = cell && (!node || !cell.contains(node)) ? cell : node;
  if (!element || !container.contains(element)) return null;
  const path = parsePath(element.getAttribute("data-cell-path") ?? element.getAttribute("data-path"));
  if (!path) return null;
  const between = cell ? null : operandBeside(element, path, targetElement, clientX);
  if (between) return between;
  const rect = unionRect(element) ?? element.getBoundingClientRect();
  const side: Side = clientX < (rect.left + rect.right) / 2 ? "L" : "R";
  let caret: Caret | null = null;
  // A string with presentation breaks is drawn as several text pieces, one per line. The
  // piece carries the offset in the string: use it, not the first text node of the whole span.
  const str = element.querySelector<HTMLElement>(":scope > .str");
  if (str) {
    const quote = targetElement?.closest<HTMLElement>(".str-quote");
    if (quote && str.contains(quote)) {
      const open = quote === str.querySelector<HTMLElement>(":scope > .str-quote:first-child");
      return { path, side: open ? "L" : "R", caret: { seg: 0, offset: 0, outside: true } };
    }
    const chunks = [...str.querySelectorAll<HTMLElement>("[data-str-offset]")];
    let chunk = targetElement?.closest<HTMLElement>("[data-str-offset]") ?? null;
    if (!chunk || !str.contains(chunk)) {
      // The break arrow and the indent between two pieces belong to the nearest piece.
      let distance = Infinity;
      for (const candidate of chunks) {
        const r = candidate.getBoundingClientRect();
        const dx = Math.max(r.left - clientX, 0, clientX - r.right);
        const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
        const d = dx * dx + dy * dy;
        if (d < distance) {
          chunk = candidate;
          distance = d;
        }
      }
    }
    if (chunk) {
      const start = Number(chunk.dataset.strOffset ?? 0);
      const local = caretOffset(chunk, clientX);
      const r = chunk.getBoundingClientRect();
      return { path, side: clientX < (r.left + r.right) / 2 ? "L" : "R", caret: { seg: 0, offset: start + local } };
    }
    return { path, side, caret: { seg: 0, offset: 0 } };
  }
  const spans = leafTextSpans(element);
  spans.forEach((span, seg) => {
    const r = span.getBoundingClientRect();
    if (clientX >= r.left - 1 && clientX <= r.right + 1 && clientY >= r.top - 4 && clientY <= r.bottom + 4) {
      const raw = caretOffset(span, clientX);
      caret = { seg, offset: raw };
    }
  });
  return { path, side, caret };
}

/**
 * : a click on an operator, a separator or the gap between two operands of `element` (not
 * inside one of its operands) puts the cursor next to the operator: at the end of the nearest
 * operand to the left when the click is left of the operator's middle, else at the start of the
 * nearest operand to the right. `null` when there is no operand on both sides of the click (an
 * outer fence, a fraction bar), so the click keeps .
 */
function operandBeside(element: Element, path: Path, target: Element | null, clientX: number): Hit | null {
  const key = element.getAttribute("data-path");
  if (key === null) return null;
  // The operands: the nearest `data-path` descendants one level below `path`.
  const operands: { path: Path; rect: DOMRect; element: Element }[] = [];
  for (const candidate of element.querySelectorAll("[data-path]")) {
    const childPath = parsePath(candidate.getAttribute("data-path"));
    if (!childPath || childPath.length !== path.length + 1) continue;
    if (!path.every((part, i) => childPath[i] === part)) continue;
    operands.push({ path: childPath, rect: unionRect(candidate) ?? candidate.getBoundingClientRect(), element: candidate });
  }
  // A click inside an operand belongs to that operand.
  if (target && operands.some((operand) => operand.element.contains(target))) return null;
  const left = operands.filter((operand) => operand.rect.right <= clientX + 0.5);
  const right = operands.filter((operand) => operand.rect.left >= clientX - 0.5);
  if (left.length === 0 || right.length === 0) return null;
  const before = left.reduce((a, b) => (b.rect.right > a.rect.right ? b : a));
  const after = right.reduce((a, b) => (b.rect.left < a.rect.left ? b : a));
  // The operator lies in the gap between the two operands; its middle decides the side.
  const middle = (before.rect.right + after.rect.left) / 2;
  return clientX < middle
    ? { path: before.path, side: "R", caret: null }
    : { path: after.path, side: "L", caret: null };
}

/**
 * A drag that started in a cell of a matrix and goes past the cells (onto the brackets or out of the
 * math) selects the whole matrix: the hit on the matrix itself, else null. The innermost
 * matrix around the anchor is the one left.
 */
export function matrixDragHit(container: Element, anchor: Path, clientX: number, clientY: number): Hit | null {
  for (let len = anchor.length; len > 0; len--) {
    const cell = container.querySelector(`[data-cell-path="${anchor.slice(0, len).join(".")}"]`);
    const grid = cell?.parentElement;
    if (!cell || !grid) continue;
    const r = grid.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    const outside = clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
    return outside ? { path: anchor.slice(0, len - 1), side: "R", caret: null } : null;
  }
  return null;
}

/**
 * A press or a drag inside the frame of the region being edited but off its math
 * : the hit on the nearest node of the expression, as if the
 * pointer were on its nearest edge. The result is not the expression and is never a candidate.
 */
export function nearestMathHit(container: Element, clientX: number, clientY: number): Hit | null {
  let nearest: Element | null = null;
  let best = { distance: Infinity, area: Infinity };
  let at = { x: clientX, y: clientY };
  for (const node of container.querySelectorAll("[data-path], [data-cell-path]")) {
    if (node.closest(".result")) continue;
    // The box of what the node draws, its result left out (the root of an evaluation holds it).
    const r = unionRect(node);
    if (!r) continue;
    const dx = Math.max(r.left - clientX, 0, clientX - r.right);
    const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
    const distance = dx * dx + dy * dy;
    const area = r.width * r.height;
    // The deepest node wins a tie: it is the smallest of the boxes the point is equally near to.
    if (distance < best.distance || (distance === best.distance && area < best.area)) {
      nearest = node;
      best = { distance, area };
      at = { x: Math.min(Math.max(clientX, r.left), r.right), y: Math.min(Math.max(clientY, r.top), r.bottom) };
    }
  }
  return nearest ? mathHit(container, nearest, at.x, at.y) : null;
}
