// Finding the trace under a click. Plotly puts a transparent drag rectangle
//  over the traces, so a click never lands on a trace path itself: the trace
// has to be found from the click position. A click is on a trace when it is within a few pixels of
// its line, of one of its markers, or on one of its bars. Pure DOM and geometry, no Plotly API.

/** How far from a line or a marker, CSS px, a click still counts as on the trace. */
export const HIT_TOLERANCE_PX = 6;

/**
 * The layer a click was found in, in drawing order: Plotly puts the bar layer under the scatter
 * layer (its cartesian layer classes), so a click on a marker over a bar finds the marker's trace.
 */
export type TraceHit = { layer: "scatterlayer" | "barlayer" | "contourlayer"; index: number };

type Hit = { stroke: SVGGeometryElement[]; shapes: SVGGraphicsElement[] };

const traceGroups = (host: Element, layer: TraceHit["layer"]): Element[] =>
  Array.from(host.querySelectorAll(layer === "contourlayer" ? ".contourlayer g.contour" : `.${layer} g.trace`));

/**
 * A trace group's clickable parts: the stroked paths of a line (`js-line`, one per unbroken run) and
 * the closed shapes of its markers or of its bars — a bar is one `<path>` per point, a marker one
 * `<path class="point">`.
 */
function parts(group: Element): Hit {
  return {
    stroke: Array.from(group.querySelectorAll<SVGGeometryElement>(".lines path.js-line, .contourlevel path")),
    shapes: Array.from(group.querySelectorAll<SVGGraphicsElement>(".points path.point, g.point path")),
  };
}

/** The point in the element's own coordinate system, or null when the browser cannot map it. */
function localPoint(element: SVGGraphicsElement, clientX: number, clientY: number): DOMPoint | null {
  const matrix = element.getScreenCTM?.();
  if (!matrix || typeof DOMPoint === "undefined") return null;
  return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
}

/** Whether the point is on the stroked line, widened to the click tolerance. */
function nearLine(path: SVGGeometryElement, clientX: number, clientY: number): boolean {
  const point = localPoint(path, clientX, clientY);
  if (!point || typeof path.isPointInStroke !== "function") return false;
  const previous = path.style.strokeWidth;
  // The path is scaled by the plot transform only (no zoom of the page is applied inside the SVG).
  path.style.strokeWidth = `${HIT_TOLERANCE_PX * 2}px`;
  try {
    return path.isPointInStroke(point);
  } finally {
    path.style.strokeWidth = previous;
  }
}

/** Whether the point is within the click tolerance of a marker or of a bar. */
function nearShape(shape: SVGGraphicsElement, clientX: number, clientY: number): boolean {
  const box = shape.getBoundingClientRect();
  return (
    clientX >= box.left - HIT_TOLERANCE_PX &&
    clientX <= box.right + HIT_TOLERANCE_PX &&
    clientY >= box.top - HIT_TOLERANCE_PX &&
    clientY <= box.bottom + HIT_TOLERANCE_PX
  );
}

/**
 * The trace of the plot drawn at the client position, or null when the position is on no trace: the
 * topmost one where two traces meet — the later trace of a layer, and the scatter layer over the bar
 * layer. `index` is the position of the trace within its layer, which is the order the drawing
 * library was given the traces of that layer in (`buildFigure(...).owners`).
 */
export function traceHitAt(host: Element, clientX: number, clientY: number): TraceHit | null {
  for (const layer of ["scatterlayer", "barlayer", "contourlayer"] as const) {
    const groups = traceGroups(host, layer);
    for (let index = groups.length - 1; index >= 0; index--) {
      const { stroke, shapes } = parts(groups[index]);
      if (stroke.some((path) => nearLine(path, clientX, clientY))) return { layer, index };
      if (shapes.some((shape) => nearShape(shape, clientX, clientY))) return { layer, index };
    }
  }
  return null;
}
