// Regression guard for GitHub . The suggestion menu of the math editor is anchored at the
// bottom edge of the expression, exactly where the error text of the region (the region note) is
// drawn: the menu must paint above it so every suggestion stays readable and selectable while
// typing, and the region being edited (and with it the menu) above its neighbours.
//
// jsdom, the test environment, does not apply the stylesheets and `?raw` imports of `.css` files
// come back empty, so the rule is read from the very source the app ships. The numbers themselves
// are free; only their order is the contract.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `page.css` from the frontend directory (the test runs with `app/` as the working directory). */
function stylesheet(): string {
  for (const candidate of ["src/styles/page.css", "app/src/styles/page.css"]) {
    // Comments are dropped so a note that mentions a z-index cannot be mistaken for a declaration.
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  throw new Error("page.css not found: run the frontend tests from `app/`");
}

const css = stylesheet();

/** The z-index a selector declares in `page.css` (the first rule of that exact selector that sets one). */
function zIndexOf(selector: string): number {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(rule)) {
    const declared = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/.exec(match[1]);
    if (declared) return Number(declared[1]);
  }
  throw new Error(`${selector} declares no z-index in page.css`);
}

describe("stacking of the plot move border", () => {
  it("keeps the corner resize handle above the move border of a selected plot", () => {
    expect(zIndexOf(".resize-handle")).toBeGreaterThan(zIndexOf(".region-drag-border"));
  });
});

describe("stacking of the plot's outer move area", () => {
  it("keeps the placeholders above the move area, so a press on a box edits it", () => {
    expect(zIndexOf(".plot-slots")).toBeGreaterThan(zIndexOf(".plot-move-area"));
  });

  it("keeps the zoom tools of the plot above the move area, so their buttons stay pressable", () => {
    expect(zIndexOf(".plot-region .modebar-container")).toBeGreaterThan(zIndexOf(".plot-move-area"));
  });
});

describe("stacking of the math editor over the region note", () => {
  it("paints the suggestion menu above the error text of the same region", () => {
    expect(zIndexOf(".math-autocomplete")).toBeGreaterThan(zIndexOf(".region-note"));
  });

  it("lifts the region being edited above its neighbours so nothing covers its menu", () => {
    expect(zIndexOf(".region.editing")).toBeGreaterThan(zIndexOf(".region"));
  });

  it("keeps the error text above the region it belongs to", () => {
    expect(zIndexOf(".region-note")).toBeGreaterThan(zIndexOf(".region"));
  });
});
