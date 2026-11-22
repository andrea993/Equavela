// The faces a copied picture outlines its text with: the browser's choice, read back from
// the `@font-face` rules.

import { describe, expect, it } from "vitest";
import { candidates, familyList, parseUnicodeRange, woffUrl, type FaceRule } from "./fontFaces";
import { paintOf, presentationAttributes, viewportTransform } from "./regionSvg";

const face = (family: string, style: FaceRule["style"], weight: number, ranges: [number, number][] = []): FaceRule => ({
  family,
  style,
  weight: [weight, weight],
  ranges,
  url: `${family}-${style}-${weight}.woff`,
});

describe("bundled faces", () => {
  it("reads unicode ranges, single points and wildcards", () => {
    expect(parseUnicodeRange("U+0460-052F, U+20B4, U+2D??")).toEqual([
      [0x460, 0x52f],
      [0x20b4, 0x20b4],
      [0x2d00, 0x2dff],
    ]);
    expect(parseUnicodeRange("")).toEqual([]);
  });

  it("splits a font-family list and unquotes it", () => {
    expect(familyList(`"STIX Two Text", "MC Math"`)).toEqual(["STIX Two Text", "MC Math"]);
    expect(familyList(`'Noto Sans', sans-serif`)).toEqual(["Noto Sans", "sans-serif"]);
  });

  it("takes the WOFF source of a face, never its WOFF2", () => {
    expect(woffUrl(`url("a.woff2") format("woff2"), url("a.woff") format("woff")`)).toBe("a.woff");
    expect(woffUrl(`url(/assets/x.woff2) format("woff2")`)).toBeNull();
    expect(woffUrl(`url(/assets/x.woff)`)).toBe("/assets/x.woff");
  });

  it("chooses the face by range, then style, then the nearest weight", () => {
    const faces = [
      face("STIX Two Text", "normal", 400, [[0x20, 0x7e]]),
      face("STIX Two Text", "italic", 400, [[0x20, 0x7e]]),
      face("STIX Two Text", "normal", 700, [[0x20, 0x7e]]),
      face("STIX Two Text", "normal", 400, [[0x370, 0x3ff]]),
    ];
    expect(candidates(faces, "stix two text", 0x61, "italic", 400)[0].style).toBe("italic");
    expect(candidates(faces, "STIX Two Text", 0x61, "normal", 600)[0].weight).toEqual([700, 700]);
    // Greek is only in the Greek subset; a character no face covers has none.
    expect(candidates(faces, "STIX Two Text", 0x3b1, "normal", 400)).toHaveLength(1);
    expect(candidates(faces, "STIX Two Text", 0x2200, "normal", 400)).toHaveLength(0);
  });

  it("writes colors as SVG 1.1 paint, and nothing for a transparent one", () => {
    expect(paintOf("rgb(31, 95, 191)")).toEqual({ fill: "#1f5fbf", opacity: 1 });
    expect(paintOf("rgba(0, 0, 0, 0.5)", 0.5)).toEqual({ fill: "#000000", opacity: 0.25 });
    expect(paintOf("rgba(0, 0, 0, 0)")).toBeNull();
  });

  it("copies SVG paint without rgba(), which Inkscape draws black", () => {
    const style: Record<string, string> = {
      fill: "rgba(0, 0, 0, 0)",
      "fill-opacity": "1",
      stroke: "rgba(68, 68, 68, 0.5)",
      "stroke-opacity": "0.5",
      "stroke-width": "1px",
    };
    const attributes = Object.fromEntries(presentationAttributes((name) => style[name] ?? ""));
    expect(attributes.fill).toBe("none");
    expect(attributes.stroke).toBe("#444444");
    expect(attributes["stroke-opacity"]).toBe("0.25");
    expect(attributes["fill-opacity"]).toBeUndefined();
    expect(Object.values(attributes).some((value) => value.includes("rgba"))).toBe(false);
    expect(Object.fromEntries(presentationAttributes((name) => (name === "fill" ? 'url("#grad")' : "")))).toMatchObject({ fill: "url(#grad)" });
  });

  it("writes a nested viewport as a group transform, as preserveAspectRatio places it", () => {
    const box = { x: 10, y: 20, w: 12, h: 100 };
    // A stretched delimiter: viewBox 0 0 6 100, preserveAspectRatio none (1).
    expect(viewportTransform(box, { x: 0, y: 0, width: 6, height: 100 }, 1, 1)).toBe("translate(10 20) scale(2 1)");
    // The default xMidYMid meet (6, 1) centers the uniform scale.
    expect(viewportTransform({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, width: 10, height: 10 }, 6, 1)).toBe("translate(50 0) scale(10 10)");
    expect(viewportTransform(box, null, 6, 1)).toBe("translate(10 20)");
    expect(viewportTransform(box, { x: 5, y: 0, width: 12, height: 100 }, 1, 1)).toBe("translate(10 20) scale(1 1) translate(-5 0)");
  });
});
