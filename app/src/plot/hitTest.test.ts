import { afterEach, describe, expect, it, vi } from "vitest";
import { HIT_TOLERANCE_PX, traceHitAt } from "./hitTest";

afterEach(() => vi.unstubAllGlobals());

const SVG = "http://www.w3.org/2000/svg";

const group = (className: string): SVGGElement => {
  const element = document.createElementNS(SVG, "g");
  element.setAttribute("class", className);
  return element;
};

/**
 * A plot host whose traces are horizontal lines at the given client y (jsdom has no SVG geometry, so
 * it is stubbed), and whose bars are rectangles.
 */
function host(
  lineYs: number[],
  markers: Array<{ trace: number; box: DOMRect }> = [],
  bars: Array<{ trace: number; box: DOMRect }> = [],
): HTMLElement {
  vi.stubGlobal(
    "DOMPoint",
    class {
      constructor(public x: number, public y: number) {}
      matrixTransform() {
        return this;
      }
    },
  );
  const element = document.createElement("div");
  const layer = group("scatterlayer");
  lineYs.forEach((lineY, trace) => {
    const traceGroup = group("trace");
    const lines = group("lines");
    const path = document.createElementNS(SVG, "path") as unknown as SVGGeometryElement;
    path.setAttribute("class", "js-line");
    Object.assign(path, {
      getScreenCTM: () => ({ inverse: () => ({}) }),
      // The stroke test uses the widened stroke width the code sets before asking.
      isPointInStroke: (point: { y: number }) => Math.abs(point.y - lineY) <= parseFloat(path.style.strokeWidth) / 2,
    });
    lines.appendChild(path);
    traceGroup.appendChild(lines);
    const points = group("points");
    for (const marker of markers.filter((item) => item.trace === trace)) {
      const point = document.createElementNS(SVG, "path");
      point.setAttribute("class", "point");
      point.getBoundingClientRect = () => marker.box;
      points.appendChild(point);
    }
    traceGroup.appendChild(points);
    layer.appendChild(traceGroup);
  });
  element.appendChild(layer);
  // The bar layer sits under the scatter layer, as Plotly's cartesian layers do.
  const barLayer = group("barlayer");
  bars.forEach((bar) => {
    const traceGroup = group("trace bars");
    const points = group("points");
    const point = group("point");
    const path = document.createElementNS(SVG, "path");
    path.getBoundingClientRect = () => bar.box;
    point.appendChild(path);
    points.appendChild(point);
    traceGroup.appendChild(points);
    barLayer.appendChild(traceGroup);
  });
  element.appendChild(barLayer);
  return element;
}

const box = (left: number, top: number, width = 8, height = 8) =>
  new DOMRect(left, top, width, height);

describe("traceHitAt (a click on a trace, through Plotly's drag rectangle)", () => {
  it("finds the trace whose line is within the tolerance of the click", () => {
    const plot = host([100, 200]);
    expect(traceHitAt(plot, 50, 100)).toEqual({ layer: "scatterlayer", index: 0 });
    expect(traceHitAt(plot, 50, 100 + HIT_TOLERANCE_PX - 1)).toEqual({ layer: "scatterlayer", index: 0 });
    expect(traceHitAt(plot, 50, 203)).toEqual({ layer: "scatterlayer", index: 1 });
    expect(traceHitAt(plot, 50, 150)).toBeNull();
  });

  it("prefers the topmost (last drawn) trace where two lines meet", () => {
    expect(traceHitAt(host([100, 102]), 50, 101)).toEqual({ layer: "scatterlayer", index: 1 });
  });

  it("finds a trace by its marker and leaves the stroke width as it was", () => {
    const plot = host([500], [{ trace: 0, box: box(10, 10) }]);
    expect(traceHitAt(plot, 12, 12)).toEqual({ layer: "scatterlayer", index: 0 });
    expect(traceHitAt(plot, 40, 12)).toBeNull();
    expect(plot.querySelector<SVGElement>("path.js-line")!.style.strokeWidth).toBe("");
  });

  it("finds a bar trace by its bars, which have no line to hit", () => {
    const plot = host([], [], [{ trace: 0, box: box(10, 20, 8, 60) }]);
    expect(traceHitAt(plot, 12, 50)).toEqual({ layer: "barlayer", index: 0 });
    expect(traceHitAt(plot, 200, 50)).toBeNull();
  });

  it("prefers the scatter layer over the bar layer under it", () => {
    // A stem or bar trace draws its markers over its bars, in a layer of its own.
    const plot = host([100], [], [{ trace: 0, box: box(0, 0, 400, 400) }]);
    expect(traceHitAt(plot, 50, 100)).toEqual({ layer: "scatterlayer", index: 0 });
    expect(traceHitAt(plot, 50, 300)).toEqual({ layer: "barlayer", index: 0 });
  });

  it("finds nothing in a plot without traces", () => {
    expect(traceHitAt(host([]), 5, 5)).toBeNull();
  });
});
