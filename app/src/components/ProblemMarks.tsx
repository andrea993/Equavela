// Inline problem marks: the kernel error span or a unit warning
// span is mapped to the DOM node of the rendered math (`data-span`, render.tsx) and only that
// sub-expression gets a wavy underline, drawn as an SVG over the region from the measured box of
// the node (layout px: client rects divided by the zoom, R9). Screen only.

import { useLayoutEffect, useState, type RefObject } from "react";
import { unionRect } from "../editor/EditorOverlay";
import { parseSpan } from "../inspect/hover";
import type { Span } from "../equavelaApi";

export type Mark = { span: Span; kind: "error" | "warning"; message: string };

/**
 * The element a span stands for: the deepest element whose span equals it; failing that the
 * smallest span that contains it (an error located in a piece the renderer draws as part of a
 * larger node). `null` when no element has a span covering it.
 */
export function findSpanElement(root: ParentNode, span: Span): HTMLElement | null {
  let exact: HTMLElement | null = null;
  let best: { element: HTMLElement; size: number } | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-span]")) {
    const found = parseSpan(element.dataset.span);
    if (!found) continue;
    if (found.start === span.start && found.end === span.end) {
      // later in document order = deeper
      exact = element;
    } else if (found.start <= span.start && found.end >= span.end) {
      const size = found.end - found.start;
      if (!best || size <= best.size) best = { element, size };
    }
  }
  return exact ?? best?.element ?? null;
}

type Placed = { kind: Mark["kind"]; x0: number; x1: number; y: number; message: string };

/** Points of a zigzag line from `x0` to `x1` at height `y` (2 px period). */
export function zigzag(x0: number, x1: number, y: number): string {
  const points: string[] = [];
  let up = false;
  for (let x = x0; x < x1; x += 2) {
    points.push(`${x.toFixed(1)},${(up ? y - 1.5 : y).toFixed(1)}`);
    up = !up;
  }
  points.push(`${x1.toFixed(1)},${y.toFixed(1)}`);
  return points.join(" ");
}

export default function ProblemMarks({
  container,
  marks,
  dependency,
  onResolved,
}: {
  container: RefObject<HTMLElement | null>;
  marks: readonly Mark[];
  /** Changes whenever the rendered math may have changed. */
  dependency: unknown;
  /** Reports whether an error mark found its node (the region then drops its whole-statement styling). */
  onResolved?: (errorFound: boolean) => void;
}) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  useLayoutEffect(() => {
    const root = container.current;
    if (!root || marks.length === 0) {
      setPlaced([]);
      onResolved?.(false);
      return;
    }
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const zoom = root.offsetWidth > 0 ? origin.width / root.offsetWidth : 1;
      const next: Placed[] = [];
      for (const mark of marks) {
        const element = findSpanElement(root, mark.span);
        const rect = element ? unionRect(element) : null;
        if (!rect) continue;
        next.push({
          kind: mark.kind,
          x0: (rect.left - origin.left) / zoom,
          x1: (rect.right - origin.left) / zoom,
          y: (rect.bottom - origin.top) / zoom + 2,
          message: mark.message,
        });
      }
      setPlaced(next);
      onResolved?.(next.some((p) => p.kind === "error"));
    };
    measure();
    void document.fonts?.ready.then(measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, marks, dependency]);
  if (placed.length === 0) return null;
  return (
    <svg className="problem-marks no-print" aria-hidden="true" data-testid="problem-marks">
      {placed.map((p, index) => (
        <polyline key={index} className={p.kind} points={zigzag(p.x0, p.x1, p.y)} data-message={p.message} />
      ))}
    </svg>
  );
}
