import { describe, expect, it } from "vitest";
import type { PlotSpec, ViewRegion } from "../equavelaApi";
import { worksheetColors } from "./worksheetColors";

const plot = (id: string, traces: { color?: string | null; marker?: string }[]): ViewRegion =>
  ({
    id,
    page: 1,
    x: 0,
    y: 0,
    enabled: true,
    kind: "plot",
    plot: {
      traces: traces.map((trace, i) => ({
        id: `trace-${i + 1}`, x: "x", y: "y", y_axis: "left", presentation: "line",
        ...(trace.color !== undefined || trace.marker ? { line: { color: trace.color }, marker: trace.marker ? { color: trace.marker } : undefined } : {}),
      })),
    } as unknown as PlotSpec,
  }) as unknown as ViewRegion;

describe("the colours of a worksheet", () => {
  it("lists the colour every trace is drawn in, its own or the palette colour of its position", () => {
    const regions = [plot("p1", [{}, { color: "#ABCDEF" }]), plot("p2", [{}, {}, {}])];
    // p1: blue (palette 0), #abcdef; p2: blue again (dropped), orange-red, green.
    expect(worksheetColors(regions)).toEqual(["#1f5fbf", "#abcdef", "#c8461c", "#2a8a3a"]);
  });

  it("adds the marker colours, the text colours and highlights, the text fill and the math fonts", () => {
    const regions = [
      plot("p1", [{ color: "#112233", marker: "#445566" }]),
      {
        id: "t", page: 1, x: 0, y: 0, enabled: true, kind: "text", text: "", width: null, background: "#FFFFCC",
        paragraphs: [{ runs: [{ kind: "text", text: "a", color: "#ff0000", highlight: "#00ff00" }, { kind: "math", text: "", statement: null }] }],
      },
      { id: "m", page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "", statement: null, format: { "math-font.color": "#c00000" } },
      { id: "n", page: 1, x: 0, y: 0, enabled: true, kind: "math", text: "", statement: null },
    ] as unknown as ViewRegion[];
    expect(worksheetColors(regions)).toEqual(["#112233", "#445566", "#ffffcc", "#ff0000", "#00ff00", "#c00000"]);
  });

  it("is empty for a worksheet without colours and ignores values that are not colours", () => {
    expect(worksheetColors([])).toEqual([]);
    expect(worksheetColors([plot("p", [{ color: "red" }])])).toEqual(["#1f5fbf"]);
  });
});
