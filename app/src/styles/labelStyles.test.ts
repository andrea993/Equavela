// Regression guard for the drawing of the label styles:
// a name takes the colour of its label through a custom property of the sheet, never
// through an inline `color` and never with `!important`, so the red of a failed region still
// wins; and a worksheet that stores no style writes no declaration at all.
//
// jsdom, the test environment, does not apply the stylesheets, so the rules are read from the very
// source the app ships (as `paletteSections.test.ts` and `stacking.test.ts` do).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { labelStylesOf, labelStyleCss } from "../math/labels";

/** `math.css` from the frontend directory (the test runs with `app/` as the working directory). */
function stylesheet(): string {
  for (const candidate of ["src/styles/math.css", "app/src/styles/math.css"]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("math.css not found: run the frontend tests from `app/`");
}

const css = stylesheet();
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule that names `selector` (alone or in a selector list). */
function declarationsOf(selector: string): string {
  for (const found of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = found[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return found[2];
  }
  throw new Error(`${selector} is not declared in math.css`);
}

/** The weight of a compound selector: how many classes (and attributes) it tests. */
const weight = (selector: string): number => (selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length;

describe("the colour of a label style", () => {
  it("declares one rule per label, taking the colour of the sheet", () => {
    for (const kind of ["var", "const", "fn", "unit", "sys", "kw"]) {
      const declarations = declarationsOf(`.name[data-label="${kind}"]`);
      // The fallback is the built-in colour: the text colour, olive for a constant, the
      // unit token for a unit.
      const fallback = kind === "const" ? "#556b2f" : kind === "unit" ? "var\\(--unit-color\\)" : "currentColor";
      expect(declarations).toMatch(new RegExp(`color\\s*:\\s*var\\(--label-${kind}-color,\\s*${fallback}\\)`));
      expect(declarations).not.toMatch(/!important/);
    }
  });

  it("leaves the red of a failed region in front of every label colour", () => {
    // The failure rule tests the region state, the math box and the name: one class more than a
    // label colour, so it wins whatever the order of the two rules.
    const failure = ".region.state-error .math .id";
    expect(weight(failure)).toBeGreaterThan(weight('.name[data-label="var"]'));
    expect(declarationsOf(failure)).toMatch(/color\s*:\s*var\(--error\)/);
    // A unit name keeps its own rule (`.unit`), and the failure still beats it.
    expect(weight(failure)).toBeGreaterThan(weight(".unit"));
  });
});

describe("a worksheet that stores no label style", () => {
  it("puts no custom property on the sheet and no attribute on a name", () => {
    expect(labelStyleCss(labelStylesOf(undefined))).toEqual({});
  });
});
