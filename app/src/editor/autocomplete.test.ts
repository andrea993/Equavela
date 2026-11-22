import { describe, expect, it } from "vitest";
import { runCommand, typeText, initialState } from "./model";
import {
  acceptCompletion,
  completionCatalog,
  completionPrefix,
  GIVEN_COMPLETION,
  completions,
  type Completion,
} from "./autocomplete";
import { sexpr } from "./tree";

const catalog: Completion[] = [
  { name: "span", kind: "defined" },
  { name: "sin", kind: "builtin", detail: "sin(x)" },
  { name: "sinh", kind: "builtin", detail: "sinh(x)" },
  { name: "slug", kind: "unit" },
];

describe("math autocomplete", () => {
  it("offers case-preserving prefix matches with worksheet names first", () => {
    const editor = typeText(initialState(), "s");
    // a single letter offers nothing (it would swallow the arrow keys of the real app)
    expect(completions(editor, catalog)).toEqual([]);
    expect(completions(typeText(initialState(), "sl"), catalog).map((x) => x.name)).toEqual(["slug"]);
    expect(completions(typeText(initialState(), "si"), catalog).map((x) => x.name)).toEqual(["sin", "sinh"]);
  });

  it("keeps a complete name in the list when a longer one starts with it, and alone shows no list", () => {
    // `sin` typed in full still shows itself (its signature) beside `sinh`.
    expect(completions(typeText(initialState(), "sin"), catalog).map((x) => x.name)).toEqual(["sin", "sinh"]);
    // `sinh` has no longer match: no list, so Enter and the arrows keep their meaning.
    expect(completions(typeText(initialState(), "sinh"), catalog)).toEqual([]);
    expect(completions(typeText(initialState(), "vec"), completionCatalog(new Set())).map((x) => x.name)).toEqual(["vec", "vec2str"]);
  });

  it("stays inactive on placeholders, explicit selections and literal subscripts", () => {
    expect(completionPrefix(initialState())).toBeNull();
    let editor = typeText(initialState(), "si");
    editor = { ...editor, explicit: true, caret: null };
    expect(completionPrefix(editor)).toBeNull();
    editor = runCommand(typeText(initialState(), "x"), "literalSubscript");
    expect(completionPrefix(editor)).toBeNull();
  });

  it("accepts a candidate as one undo step", () => {
    let editor = typeText(initialState(), "si");
    editor = acceptCompletion(editor, catalog[1]);
    expect(sexpr(editor.root)).toBe("sin");
    editor = runCommand(editor, "undo");
    expect(sexpr(editor.root)).toBe("si");
  });

  it("inserts an accepted unit with its label", () => {
    const all = completionCatalog(new Set());
    const editor = typeText(initialState(), "km");
    const unit = completions(editor, all).find((x) => x.name === "km") ?? { name: "km", kind: "unit" as const };
    const accepted = acceptCompletion(editor, unit);
    // A plain name in a value position is not a unit, so the label is part of the inserted name.
    expect(sexpr(accepted.root)).toBe("km@unit");
    // Accepting is one undo step, whatever the history held before.
    expect(accepted.past.length).toBe(editor.past.length + 1);
    // A built-in stays a plain name.
    const sin = acceptCompletion(typeText(initialState(), "si"), all.find((x) => x.name === "sin")!);
    expect(sexpr(sin.root)).toBe("sin");
  });

  it("builds a de-duplicated catalogue from worksheet names, built-ins and units", () => {
    const result = completionCatalog(new Set(["sin", "span"]));
    expect(result.filter((x) => x.name === "sin")).toHaveLength(2);
    expect(completions(typeText(initialState(), "si"), result).filter((x) => x.name === "sin")).toHaveLength(1);
    expect(result.some((x) => x.name === "m" && x.kind === "unit")).toBe(true);
  });
});

describe("built-in catalogue in autocomplete", () => {
  it("carries a signature and a description for every built-in", () => {
    const sin = completionCatalog(new Set()).find((x) => x.name === "sin" && x.kind === "builtin");
    expect(sin?.detail).toMatch(/^sin\(/);
    expect(sin?.description).toBeTruthy();
  });
});

describe("keyword slot autocomplete", () => {
  it("offers only symbolic keywords above the arrow", () => {
    const arrow = runCommand(typeText(initialState(), "x"), "symbolic");
    const editor = typeText(arrow, "si");
    expect(completions(editor, catalog).map((x) => x.name)).toEqual(["simplify"]);
    expect(completions(typeText(arrow, "fa"), catalog).map((x) => x.name)).toEqual(["factor"]);
    // Elsewhere the ordinary catalogue applies.
    expect(completions(typeText(initialState(), "si"), catalog).map((x) => x.name)).toEqual(["sin", "sinh"]);
  });
});

describe("the Given keyword", () => {
  it("is offered while typing it, and accepting it types the keyword", () => {
    const all = completionCatalog(new Set());
    expect(all).toContainEqual(GIVEN_COMPLETION);
    const editor = typeText(initialState(), "Gi");
    const offered = completions(editor, all);
    expect(offered.map((x) => x.name)).toContain("Given");
    const accepted = acceptCompletion(editor, GIVEN_COMPLETION);
    expect(sexpr(accepted.root)).toBe("Given");
  });
});
