import { describe, expect, it } from "vitest";
import type { RichText, ViewRegion } from "../equavelaApi";
import { replacementOf, replaceInParagraphs, replaceOccurrences } from "./replace";

const mathRegion = (text: string) =>
  ({ id: "m1", page: 1, x: 54, y: 72, enabled: true, kind: "math", text, statement: {} }) as ViewRegion;

const textRegion = (paragraphs: RichText) =>
  ({ id: "t1", page: 1, x: 54, y: 72, enabled: true, kind: "text", text: "…", width: null, paragraphs }) as ViewRegion;

describe("replaceOccurrences", () => {
  it("replaces every occurrence, case-insensitively, and keeps the rest", () => {
    expect(replaceOccurrences("L := 3.5 m and l/2", "l", "L_total")).toBe("L_total := 3.5 m and L_total/2");
    expect(replaceOccurrences("M_max = q·L^2/8", "q", "Q")).toBe("M_max = Q·L^2/8");
  });

  it("takes the replacement literally (no $-patterns, no backslash escapes)", () => {
    expect(replaceOccurrences("x+1", "x", "$&")).toBe("$&+1");
    expect(replaceOccurrences("x+1", "x", "$1")).toBe("$1+1");
    expect(replaceOccurrences("x+1", "x", "\\n")).toBe("\\n+1");
  });

  it("changes nothing for an empty query or a query that does not occur", () => {
    expect(replaceOccurrences("x+1", "", "y")).toBe("x+1");
    expect(replaceOccurrences("x+1", "z", "y")).toBe("x+1");
    expect(replaceOccurrences("", "x", "y")).toBe("");
  });

  it("handles accented and Greek text", () => {
    expect(replaceOccurrences("α + β", "β", "γ")).toBe("α + γ");
    expect(replaceOccurrences("Però sì", "sì", "no")).toBe("Però no");
  });
});

describe("replaceInParagraphs", () => {
  it("replaces inside the text runs and keeps their formatting", () => {
    const value: RichText = [{ runs: [{ kind: "text", text: "The beam spans " }, { kind: "text", text: "L", bold: true }] }];
    expect(replaceInParagraphs(value, "L", "L_total")).toEqual([
      { runs: [{ kind: "text", text: "The beam spans " }, { kind: "text", text: "L_total", bold: true }] },
    ]);
  });

  it("leaves inline math alone", () => {
    const value: RichText = [{ runs: [{ kind: "text", text: "q = " }, { kind: "math", text: "q", statement: null }, { kind: "text", text: " kN/m" }] }];
    expect(replaceInParagraphs(value, "q", "Q")).toEqual([
      { runs: [{ kind: "text", text: "Q = " }, { kind: "math", text: "q", statement: null }, { kind: "text", text: " kN/m" }] },
    ]);
  });

  it("returns null when no run changes", () => {
    const value: RichText = [{ runs: [{ kind: "text", text: "The beam" }] }, { runs: [{ kind: "math", text: "L", statement: null }] }];
    expect(replaceInParagraphs(value, "L", "M")).toBeNull();
    // Replacing a word with itself writes nothing either: the region would not change.
    expect(replaceInParagraphs(value, "beam", "beam")).toBeNull();
  });

  it("replaces across paragraphs", () => {
    const value: RichText = [{ runs: [{ kind: "text", text: "load" }] }, { runs: [{ kind: "text", text: "load again" }] }];
    expect(replaceInParagraphs(value, "load", "force")).toEqual([
      { runs: [{ kind: "text", text: "force" }] },
      { runs: [{ kind: "text", text: "force again" }] },
    ]);
  });
});

describe("replacementOf", () => {
  it("gives the new linear text of a math region", () => {
    expect(replacementOf(mathRegion("L := 3.5 m"), "3.5", "4.2")).toEqual({ kind: "math", text: "L := 4.2 m" });
  });

  it("gives the new runs of a text region", () => {
    expect(replacementOf(textRegion([{ runs: [{ kind: "text", text: "The load q" }] }]), "q", "force")).toEqual({
      kind: "text",
      paragraphs: [{ runs: [{ kind: "text", text: "The load force" }] }],
    });
  });

  it("has nothing to write when the region is unchanged or cannot carry the query", () => {
    expect(replacementOf(mathRegion("L := 3.5 m"), "", "x")).toBeNull();
    expect(replacementOf(mathRegion("L := 3.5 m"), "9", "x")).toBeNull();
    const math = textRegion([{ runs: [{ kind: "math", text: "q·L", statement: null }] }]);
    expect(replacementOf(math, "q", "Q")).toBeNull();
  });

  it("leaves the other region kinds to their own editors", () => {
    const kinds = [
      { id: "i1", kind: "include", path: "helpers.eqv" },
      { id: "j1", kind: "julia", block: { code: "using X", using: [] } },
      { id: "a1", kind: "area", title: "Loads", height: 18, collapsed: false },
    ];
    for (const content of kinds) {
      const region = { page: 1, x: 0, y: 0, enabled: true, ...content } as unknown as ViewRegion;
      expect(replacementOf(region, "helpers", "other")).toBeNull();
    }
    const image = { id: "p1", page: 1, x: 0, y: 0, enabled: true, kind: "image", resource: "r", media: "png", size: [10, 10] } as ViewRegion;
    expect(replacementOf(image, "r", "s")).toBeNull();
  });
});
