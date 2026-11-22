import { describe, expect, it } from "vitest";
import { initialState, runCommand, typeText } from "../editor/model";
import { sexpr } from "../editor/tree";
import { BUILTIN_ENTRIES } from "./builtins";
import {
  filterSections,
  MATRIX_FUNCTIONS,
  paletteSections,
  SYMBOLIC_KEYWORDS,
  SYMBOLIC_MODIFIERS,
  PALETTE_KINDS,
  type PaletteEntry,
} from "./palettes";
import { applyPaletteAction } from "./run";
import { UNIT_ENTRIES, UNIT_GROUPS } from "./units";
import { UNIT_NAMES } from "../math/units";

const entries = (kind: Parameters<typeof paletteSections>[0], prefix = ""): PaletteEntry[] =>
  paletteSections(kind, prefix).flatMap((s) => s.entries);

describe("palette catalogues", () => {
  it("lists the complete symbolic keyword and modifier sets", () => {
    const labels = entries("symbolics").map((e) => e.label);
    for (const name of [...SYMBOLIC_KEYWORDS, ...SYMBOLIC_MODIFIERS]) expect(labels).toContain(name);
    expect(SYMBOLIC_KEYWORDS).toHaveLength(27);
    expect(SYMBOLIC_MODIFIERS).toHaveLength(48);
  });

  it("lists every Vector/Matrix function of the spec, with signatures for built-ins", () => {
    expect(MATRIX_FUNCTIONS).toHaveLength(55);
    const all = entries("matrixFunctions");
    expect(all.find((e) => e.label === "stack")?.title).toContain("stack(A, B, C, …)");
    expect(all.find((e) => e.label === "convolve")?.title).toContain("convolve(S, K, [BC], [OV])");
    expect(all.find((e) => e.label === "Jacob")?.title).toContain("Jacob(F(x), x, [k])");
    // The vector sum is our own name for the reference application's `Σv` operator.
    expect(all.find((e) => e.label === "vsum")?.title).toContain("vsum(v)");
  });

  it("covers the constants, symbols and operator groups", () => {
    const constants = entries("constants").map((e) => e.label);
    for (const name of ["∞", "e", "π", "c", "e.c", "ħ", "N.A", "R∞", "ε₀", "Φ₀"]) expect(constants).toContain(name);
    const symbols = entries("symbols").map((e) => e.label);
    for (const name of ["α", "ϕ", "φ", "Ω", "ℝ", "€", "ℵ", "©"]) expect(symbols).toContain(name);
    const titles = paletteSections("operators").map((s) => s.title);
    expect(titles).toEqual([
      "Arithmetic", "Expression layout", "Calculus & series", "Logic & tests",
      "Assign & evaluate", "Complex & angles", "Arrays & indexing", "Sequences & signals",
    ]);
  });

  it("puts each palette entry under the mathematical task or notation it belongs to", () => {
    const labels = (kind: "operators" | "symbols", title: string) =>
      paletteSections(kind).find((section) => section.title === title)?.entries.map((entry) => entry.label);
    expect(labels("operators", "Complex & angles")).toEqual(["z̄", "ℜ", "ℑ", "°", "∠"]);
    expect(labels("operators", "Arithmetic")).toContain("scale");
    expect(labels("operators", "Sequences & signals")).toEqual(["1‥n", "⊛", "∗"]);
    expect(labels("symbols", "Geometry")).toEqual(expect.arrayContaining(["∡", "⌀", "⊥", "∥", "△"]));
    expect(labels("symbols", "Greek letters")).toEqual(expect.arrayContaining(["α", "ω", "Α", "Ω"]));
    expect(entries("symbols").filter((entry) => entry.label === "∐")).toHaveLength(1);
  });

  it("marks entries the editor cannot build instead of silently ignoring them", () => {
    const symbols = entries("symbols");
    expect(symbols.find((e) => e.label === "ℝ")?.disabled).toBeUndefined();
    // Symbols without an operator meaning are name characters; operator glyphs are not.
    for (const label of ["∀", "€", "©", "∩", "†"]) expect(symbols.find((e) => e.label === label)?.disabled).toBeUndefined();
    expect(symbols.find((e) => e.label === "‖")?.disabled).toBeTruthy();
    // The power operator is not offered at all, nor the membership operator; names get ∊, ∉ and ∶.
    expect(symbols.some((e) => e.label === "^" || e.label === "∈" || e.label === ":")).toBe(false);
    // Number sets, logic, arrows and the signs of names are usable in a name.
    for (const label of ["ℕ", "ℤ", "ℚ", "ℝ", "ℂ", "⌀", "⊥", "∥", "△", "∅", "≈", "≪", "ℓ", "℘", "⋆", "✓", "∀", "∃", "∄", "⇒", "∉", "∶", "⟵", "⟶", "⟷", "↔", "⇐", "⇔", "±", "∓", "˖", "˗"]) {
      expect(symbols.filter((e) => e.label === label && !e.disabled), label).toHaveLength(1);
    }
    // The operator arrows are not offered as name characters.
    expect(symbols.some((e) => e.label === "←" || e.label === "→")).toBe(false);
    // Every operator entry works now.
    expect(entries("operators").filter((e) => e.disabled)).toEqual([]);
  });

  it("offers every unit name of the shared table, grouped by dimension", () => {
    const base = UNIT_ENTRIES.map((u) => u.name);
    for (const name of base) expect(UNIT_NAMES.has(name)).toBe(true);
    expect(UNIT_GROUPS.length).toBeGreaterThan(20);
    expect(UNIT_GROUPS[0].title).toBe("Length");
    expect(UNIT_GROUPS.flatMap((g) => g.units)).toHaveLength(UNIT_ENTRIES.length);
    const prefixed = entries("units", "k").map((e) => e.label);
    expect(prefixed).toContain("km");
    expect(prefixed).toContain("min"); // not prefixable: unchanged
    expect(prefixed).not.toContain("kmin");
  });

  it("filters by label, title and keyword", () => {
    const sections = filterSections(paletteSections("operators"), "fraction");
    expect(sections.flatMap((s) => s.entries).map((e) => e.label)).toEqual(["÷"]);
    expect(filterSections(paletteSections("operators"), "zzzz")).toEqual([]);
    expect(filterSections(paletteSections("symbols"), "  ")).toHaveLength(paletteSections("symbols").length);
  });

  it("has a palette for every kind", () => {
    for (const kind of PALETTE_KINDS) expect(entries(kind).length).toBeGreaterThan(5);
    expect(BUILTIN_ENTRIES.length).toBeGreaterThan(100);
  });
});

describe("running palette actions on the editor", () => {
  const run = (kind: Parameters<typeof paletteSections>[0], label: string, state = initialState()) =>
    applyPaletteAction(state, entries(kind).find((e) => e.label === label)!.action);

  it("inserts text, commands, subscripted constants and keywords", () => {
    expect(sexpr(run("symbols", "ℝ").root)).toContain("ℝ");
    // Percent and per mille apply to the operand before the caret.
    expect(sexpr(run("operators", "%", typeText(initialState(), "x")).root)).toBe("(% x)");
    expect(sexpr(run("operators", "‰", typeText(initialState(), "x")).root)).toBe("(‰ x)");
    expect(sexpr(run("operators", "ℜ", typeText(initialState(), "z")).root)).toBe("(Re z)");
    // The convolutions.
    expect(sexpr(run("operators", "∗", typeText(initialState(), "a")).root)).toBe("(∗ a □)");
    expect(sexpr(run("operators", "⊛", typeText(initialState(), "a")).root)).toBe("(⊛ a □)");
    // The gradient: the variable first, the operand as the body.
    expect(sexpr(run("operators", "∇", typeText(initialState(), "f")).root)).toBe("(∇ □ f)");
    // The polar operator.
    expect(sexpr(run("operators", "∠", typeText(initialState(), "r")).root)).toBe("(∠ r □)");
    // Not equal, range and scaling.
    expect(sexpr(run("operators", "≠", typeText(initialState(), "a")).root)).toBe("(≠ a □)");
    expect(sexpr(run("operators", "1‥n", typeText(initialState(), "1")).root)).toBe("(range 1 □)");
    expect(sexpr(run("operators", "scale", typeText(initialState(), "5")).root)).toBe("(juxt 5 □)");
    expect(sexpr(run("operators", "ℑ", typeText(initialState(), "z")).root)).toBe("(Im z)");
    expect(sexpr(run("symbols", "€", typeText(initialState(), "c")).root)).toBe("c€");
    expect(sexpr(run("constants", "e.c").root)).toContain("e.c");
    const mu0 = run("constants", "μ₀").root;
    expect(JSON.stringify(mu0)).toContain('"subscript":true');
    expect(sexpr(run("operators", "xʸ").root)).toContain("^");
    const typed = typeText(initialState(), "x");
    const symbolic = run("symbolics", "simplify", typed);
    expect(symbolic.root.type).toBe("Symbolic");
    expect(run("symbolics", "real", symbolic).root).toBeTruthy();
  });

  it("inserts a unit with its label, as one undo step", () => {
    const inserted = run("units", "m");
    // The label is written in the tree: a plain name in a value position is not a unit.
    expect(sexpr(inserted.root)).toBe("m@unit");
    expect(inserted.past).toHaveLength(1);
    const undone = applyPaletteAction(runCommand(inserted, "undo"), { kind: "text", text: "" });
    expect(sexpr(undone.root)).not.toContain("@unit");
    for (const kind of ["operators", "symbols"] as const) {
      expect(entries(kind).find((entry) => entry.label === "°")?.disabled).toBeUndefined();
      expect(sexpr(run(kind, "°").root)).toBe("°@unit");
      expect(sexpr(run(kind, "°", typeText(initialState(), "90")).root)).toBe("(juxt 90 °@unit)");
    }
    // A prefixed entry is labelled too (`km`, not `k` and `m`).
    const prefixed = applyPaletteAction(initialState(), {
      kind: "unit",
      name: entries("units", "k").find((e) => e.label === "km")!.label,
    });
    expect(sexpr(prefixed.root)).toBe("km@unit");
  });
});
