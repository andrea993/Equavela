import { describe, expect, it } from "vitest";
import type { PlotSpec } from "../equavelaApi";
import { cursorCoordinatesAt, formatCoordinate } from "./cursorCoordinates";

const axis = (unit: string | null = null) => ({
  scale: "linear" as const, unit, min: null, max: null, show_grid: true, title: "",
});
const plot = (): PlotSpec => ({
  version: 1,
  type: "xy",
  size: [360, 220],
  axes: { x: axis(), y: axis() },
  traces: [{ id: "trace-1", x: "x", y: "f(x)", presentation: "line" }],
});

describe("cursor coordinate readout", () => {
  it("uses pixel-to-data transforms for linear, logarithmic and right axes, with their units", () => {
    const spec = plot();
    spec.axes.x.unit = "s";
    spec.axes.y.unit = "m";
    spec.axes.y2 = axis("mm");
    spec.traces.push({ ...spec.traces[0], id: "trace-2", y: "g(x)", y_axis: "right" });
    const text = cursorCoordinatesAt(spec, {
      xaxis: { _offset: 10, _length: 100, _tickround: 2, p2d: (pixel) => pixel / 10 + 0.123 },
      yaxis: { _offset: 20, _length: 80, p2d: (pixel) => 10 - pixel / 8 },
      yaxis2: { _offset: 20, _length: 80, p2d: (pixel) => 100 - pixel },
    }, 60, 60);
    expect(text).toBe("x = 5.12 s; y = 5 m; y₂ = 60 mm");
    // Plotly's p2d transform converts a log-axis pixel to its data value before formatting.
    expect(cursorCoordinatesAt(plot(), {
      xaxis: { _offset: 0, _length: 10, p2d: () => 100 },
      yaxis: { _offset: 0, _length: 10, p2d: () => 1 },
    }, 5, 5)).toBe("x = 100; y = 1");
  });

  it("clears outside the plot data area and formats polar angle and radius", () => {
    const spec = plot();
    expect(cursorCoordinatesAt(spec, {
      xaxis: { _offset: 10, _length: 100, p2d: (pixel) => pixel },
      yaxis: { _offset: 10, _length: 100, p2d: (pixel) => pixel },
    }, 111, 30)).toBeNull();

    spec.type = "polar";
    spec.axes.x.unit = "rad";
    spec.axes.y.unit = "m";
    expect(cursorCoordinatesAt(spec, { polar: { _subplot: {
      cx: 50, cy: 50, radius: 40, innerRadius: 0,
      radialAxis: { _rl: [0, 10], l2c: (value) => value },
      angularAxis: { g2c: (value) => value, c2d: (value) => value },
    } } }, 70, 50)).toBe("θ = 0 rad; r = 5 m");
    expect(cursorCoordinatesAt(spec, { polar: { _subplot: {
      cx: 50, cy: 50, radius: 40, innerRadius: 0,
      radialAxis: { _rl: [0, 10], l2c: (value) => value },
      angularAxis: { g2c: (value) => value, c2d: (value) => value },
    } } }, 50, 30)).toBe("θ = π/2 rad; r = 5 m");
  });

  it("uses compact finite six-significant-digit values", () => {
    expect(formatCoordinate(-0)).toBe("0");
    expect(formatCoordinate(1.23456789)).toBe("1.23457");
    expect(formatCoordinate(1.23456789, 2)).toBe("1.23");
    expect(formatCoordinate(10, 0)).toBe("10");
    expect(formatCoordinate(Infinity)).toBe("");
  });
});
