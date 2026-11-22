import { describe, expect, it } from "vitest";
import type { Inspection, ParagraphStyle, RegionEntry, RegionKey, ViewRegion } from "../equavelaApi";
import { describeName, parseSpan } from "./hover";
import { definitionsAt, fileName, includedNamesByRegion, sameKey, valueId, variablesOf } from "./inspection";
import { headingLevel, headingOf, outlineOf, outlineStatement, problemsOf } from "./outline";
import { findSpanElement, zigzag } from "../components/ProblemMarks";

const key = (id: string, document = "/w.eqv"): RegionKey => ({ document, region_id: id, instance: 0 });
const def = (name: string, version: number, id: string, rank: number, extra: Record<string, unknown> = {}) => ({
  name,
  label: "var",
  key: key(id),
  version,
  global: false,
  signature: name,
  kernel_name: `${name}_v${version}`,
  rank,
  ...extra,
});

const inspection: Inspection = {
  root: "/w.eqv",
  definitions: [
    def("a", 1, "r1", 0),
    def("f", 1, "r2", 1, { label: "fn", signature: "f(x)" }),
    def("a", 2, "r4", 3),
    def("k", 1, "r6", 5, { global: true }),
    { ...def("lib", 1, "x1", 6), key: key("x1", "/lib.eqv") },
  ],
  references: [
    { key: key("r2"), start: 10, end: 11, name: "a", definition: key("r1"), version: 1 },
    { key: key("r5"), start: 0, end: 1, name: "a", definition: key("r4"), version: 2 },
    { key: key("r5"), start: 4, end: 5, name: "zz", definition: null, version: null },
  ],
  warnings: [],
  includes: [],
  ranks: [
    [key("r1"), 0],
    [key("r2"), 1],
    [key("r3"), 2],
    [key("r4"), 3],
    [key("r5"), 4],
    [key("r6"), 5],
  ],
};

describe("inspection helpers", () => {
  it("shows the latest definition of each name visible at a region, globals always", () => {
    const names = (cursor: RegionKey | null) =>
      definitionsAt(inspection, cursor).map((d) => `${d.name}${d.version}`);
    expect(names(key("r1"))).toEqual(["a1", "k1"]);
    expect(names(key("r3"))).toEqual(["a1", "f1", "k1"]);
    expect(names(key("r5"))).toEqual(["f1", "a2", "k1"]);
    expect(names(null)).toEqual(["f1", "a2", "k1", "lib1"]);
  });

  it("lists the variables to peek, not the functions", () => {
    expect(variablesOf(definitionsAt(inspection, null))).toEqual([
      { name: "a", version: 2 },
      { name: "k", version: 1 },
      { name: "lib", version: 1 },
    ]);
    expect(valueId({ name: "a", version: 2 })).toBe("a#2");
    expect(sameKey(key("a"), key("a"))).toBe(true);
    expect(sameKey(key("a"), key("b"))).toBe(false);
    expect(fileName("C:/x/lib.eqv")).toBe("lib.eqv");
    expect(fileName(["C:", "x", "lib.eqv"].join(String.fromCharCode(92)))).toBe("lib.eqv");
  });

  it("resolves a hovered name to its definition, its own target, a unit, a built-in or nothing", () => {
    const at = (id: string, name: string, start: number, end: number, label?: string) =>
      describeName(inspection, key(id), name, start, end, label);
    const first = at("r2", "a", 10, 11);
    expect(first.kind === "definition" && first.definition.version).toBe(1);
    const second = at("r5", "a", 0, 1);
    expect(second.kind === "definition" && second.definition.key.region_id).toBe("r4");
    const own = at("r4", "a", 0, 1);
    expect(own.kind === "definition" && own.own).toBe(true);
    // Only a name drawn as a unit is one: a plain `km` is a name in a value position.
    expect(at("r5", "km", 8, 10, "unit").kind).toBe("unit");
    expect(at("r5", "km", 8, 10, "var").kind).toBe("undefined");
    expect(at("r5", "km", 8, 10).kind).toBe("undefined");
    expect(at("r5", "sin", 8, 11).kind).toBe("builtin");
    expect(at("r5", "zz", 4, 5).kind).toBe("undefined");
    expect(parseSpan("12-30")).toEqual({ start: 12, end: 30 });
    expect(parseSpan("x")).toBeNull();
    expect(parseSpan(undefined)).toBeNull();
  });

  it("uses the inspection to distinguish constants, system settings and unresolved names", () => {
    const lookup = (name: string, intrinsic?: Inspection["references"][number]["intrinsic"], label?: string) =>
      describeName({ ...inspection, references: [
        { key: key("intrinsic"), start: 0, end: 2, name, definition: null, version: null, intrinsic },
      ] }, key("intrinsic"), name, 0, 2, label);
    expect(lookup("π", { kind: "constant", value: Math.PI })).toEqual({ kind: "constant", name: "π", value: Math.PI });
    expect(lookup("μ_0", { kind: "constant" }).kind).toBe("constant");
    expect(lookup("ORIGIN", { kind: "system" }).kind).toBe("system");
    expect(lookup("sin", { kind: "builtin" }).kind).toBe("builtin");
    expect(lookup("sin", undefined, "var").kind).toBe("undefined");
    expect(lookup("not_a_unit", undefined, "unit").kind).toBe("undefined");
  });

  it("finds the definition even when the hovered occurrence uses an explicit label", () => {
    const info = describeName({ ...inspection, references: [
      { key: key("r2"), start: 10, end: 15, name: "a@var", definition_name: "a", definition: key("r1"), version: 1 },
    ] }, key("r2"), "a", 10, 15, "var");
    expect(info.kind === "definition" && info.definition.key.region_id).toBe("r1");
  });
});

describe("names brought in by include regions", () => {
  it("gives each include region of the root its exports and those of the worksheets it includes", () => {
    const definition = (name: string, document: string) => ({
      name,
      label: "fn",
      key: { document, region_id: "m1", instance: 0 },
      version: 1,
      global: false,
      signature: `${name}(x)`,
      kernel_name: `${name}_v1`,
      rank: 0,
    });
    const inspection = {
      root: "/main.eqv",
      definitions: [],
      references: [],
      warnings: [],
      ranks: [],
      // A child listed before its parent still lands on the root's include region.
      includes: [
        { document: "/b.eqv", parent: "/a.eqv", region_id: "i9", exports: [definition("g", "/b.eqv")], found: true },
        { document: "/a.eqv", parent: "/main.eqv", region_id: "inc1", exports: [definition("f", "/a.eqv")], found: true },
        { document: "/c.eqv", parent: "/main.eqv", region_id: "inc2", exports: [definition("h", "/c.eqv")], found: true },
      ],
    } as Inspection;
    const byRegion = includedNamesByRegion(inspection);
    expect(byRegion.get("inc1")?.sort()).toEqual(["f", "g"]);
    expect(byRegion.get("inc2")).toEqual(["h"]);
    expect(byRegion.has("i9")).toBe(false);
  });
});

describe("outline and problems", () => {
  const text = (
    id: string,
    y: number,
    runs: { text: string; bold?: boolean; size?: number }[],
    style?: ParagraphStyle,
  ): ViewRegion => ({
    id,
    page: 1,
    x: 54,
    y,
    enabled: true,
    kind: "text",
    text: "",
    width: null,
    paragraphs: [{ runs: runs.map((run) => ({ kind: "text" as const, ...run })), ...(style ? { style } : {}) }],
  });

  it("finds headings by bold or size, as the fallback of a region without styles", () => {
    expect(headingLevel([{ runs: [{ kind: "text", text: "T", size: 24 }] }])).toBe(1);
    expect(headingLevel([{ runs: [{ kind: "text", text: "T", size: 15 }] }])).toBe(2);
    expect(headingLevel([{ runs: [{ kind: "text", text: "T", bold: true }] }])).toBe(2);
    expect(headingLevel([{ runs: [{ kind: "text", text: "T", bold: true }, { kind: "text", text: " rest" }] }])).toBe(0);
    expect(headingLevel([{ runs: [] }])).toBe(0);
    const items = outlineOf([
      { id: "m", page: 1, x: 54, y: 200, enabled: true, kind: "math", text: "a := 1", statement: {} },
      text("t2", 100, [{ text: "Body" }]),
      text("t1", 50, [{ text: "Beam", size: 21 }]),
      { id: "i", page: 2, x: 54, y: 10, enabled: true, kind: "include", path: "lib.eqv" },
    ]);
    expect(items.map((i) => [i.id, i.level, i.label])).toEqual([
      ["t1", 1, "Beam"],
      ["t2", 0, "Body"],
      ["m", 0, "a := 1"],
      ["i", 0, "Include lib.eqv"],
    ]);
  });

  it("takes the heading level from the paragraph style, wherever the heading paragraph is", () => {
    // A heading in the middle of a region is that region's heading, with its own text as the label.
    const region: ViewRegion = {
      id: "t3",
      page: 1,
      x: 54,
      y: 10,
      enabled: true,
      kind: "text",
      text: "",
      width: null,
      paragraphs: [
        { runs: [{ kind: "text", text: "Intro" }] },
        { style: "heading2", runs: [{ kind: "text", text: "Loads" }] },
        { runs: [{ kind: "text", text: "More" }] },
      ],
    };
    expect(headingOf(region.paragraphs)).toEqual({ level: 2, text: "Loads" });
    expect(outlineOf([region]).map((i) => [i.level, i.label])).toEqual([[2, "Loads"]]);
    // Title and Subtitle are paragraph styles but not headings.
    expect(headingOf([{ style: "title", runs: [{ kind: "text", text: "Report" }] }])).toBeNull();
    // The style wins over the old guess: a bold first paragraph under a Heading 3 is not level 2.
    expect(
      headingOf([
        { runs: [{ kind: "text", text: "Bold body", bold: true }] },
        { style: "heading3", runs: [{ kind: "text", text: "Detail" }] },
      ]),
    ).toEqual({ level: 3, text: "Detail" });
    // Without any heading style the guess still applies (worksheets written before styles).
    expect(headingOf([{ runs: [{ kind: "text", text: "Beam", size: 21 }] }])).toEqual({ level: 1, text: "Beam" });
  });

  it("lists errors (not the regions blocked by them), unit warnings and diagnostics, with files for includes", () => {
    const entry = (id: string, document: string, kind: "evaluation" | "blocked", message: string): RegionEntry => ({
      key: key(id, document),
      state: "error",
      failure: { kind, message, span: null, blocked_by: null, julia_type: null },
    });
    const problems = problemsOf(
      "/w.eqv",
      [
        entry("a", "/w.eqv", "evaluation", "x is undefined"),
        entry("b", "/w.eqv", "blocked", "depends on a"),
        entry("c", "/lib.eqv", "evaluation", "boom"),
      ],
      [{ document: "/w.eqv", region_id: "inc", message: "included worksheet `x` was not found" }],
      [{ key: key("w"), start: 0, end: 3, message: "units do not match" }],
    );
    expect(problems.map((p) => [p.kind, p.file, p.message])).toEqual([
      ["error", null, "x is undefined"],
      ["diagnostic", null, "included worksheet `x` was not found"],
      ["unit", null, "units do not match"],
      ["error", "lib.eqv", "boom"],
    ]);
  });
});

describe("problem marks", () => {
  it("finds the deepest element with the span, else the smallest one containing it", () => {
    document.body.innerHTML = `
      <div id="root">
        <span data-span="0-17" id="stmt"><span data-span="0-5" id="a"></span>
          <span data-span="6-17" id="sum"><span data-span="6-13" id="miss"></span><span data-span="6-13" id="missInner"></span></span>
        </span>
      </div>`;
    const root = document.getElementById("root")!;
    expect(findSpanElement(root, { start: 6, end: 13 })?.id).toBe("missInner");
    expect(findSpanElement(root, { start: 7, end: 9 })?.id).toBe("missInner");
    expect(findSpanElement(root, { start: 0, end: 17 })?.id).toBe("stmt");
    expect(findSpanElement(root, { start: 40, end: 50 })).toBeNull();
    expect(zigzag(0, 4, 10).split(" ").length).toBe(3);
  });
});

it("cuts a program to its first line in the Outline", () => {
  const n = (text: string) => ({ type: "Num", text });
  const program = {
    type: "Program",
    body: [
      { type: "For", var: "i", range: n("1"), body: [{ type: "ExprStmt", expr: n("2") }] },
      { type: "ExprStmt", expr: n("3") },
    ],
  };
  const statement = { type: "Define", target: { type: "Ident" }, rhs: program, tail: null };
  expect(outlineStatement(statement)).toEqual({
    ...statement,
    rhs: { type: "Program", body: [{ type: "For", var: "i", range: n("1"), body: [] }] },
  });
  // anything else is unchanged
  const plain = { type: "Evaluate", expr: n("1"), unit: null };
  expect(outlineStatement(plain)).toEqual(plain);
});
