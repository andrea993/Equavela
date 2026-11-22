// Regression guard for the density of the insert panels:
// the entries of a palette are compact and borderless at rest, so a palette shows as many entries as
// its width allows, and the panel is as tall as the window allows, so a palette such as Symbols shows
// (nearly) all of its entries without scrolling.
//
// jsdom, the test environment, does not apply the stylesheets, so the rules are read from the very
// source the app ships (as `resultBox.test.ts`, `labelStyles.test.ts` and `stacking.test.ts` do).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(): string {
  for (const candidate of ["src/styles/chrome.css", "app/src/styles/chrome.css"]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("chrome.css not found: run the frontend tests from `app/`");
}

const rules = stylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule that names `selector` in its selector list, joined. */
function declarationsOf(selector: string): string {
  const found: string[] = [];
  for (const match of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = match[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) found.push(match[2]);
  }
  if (found.length === 0) throw new Error(`${selector} is not declared in chrome.css`);
  return found.join("\n");
}

describe("insert panel entries are compact", () => {
  it("keeps the smallest useful hit area: 30 x 26 px with 1 x 4 px of padding", () => {
    const button = declarationsOf(".palette-grid button");
    expect(button).toMatch(/min-width\s*:\s*30px/);
    expect(button).toMatch(/min-height\s*:\s*26px/);
    expect(button).toMatch(/padding\s*:\s*1px 4px/);
  });

  it("draws no border at rest, and the accent border on hover and keyboard focus", () => {
    // A transparent border keeps the size stable when the accent border appears.
    expect(declarationsOf(".palette-grid button")).toMatch(/border\s*:\s*1px solid transparent/);
    const hover = declarationsOf(".palette-grid button:hover");
    expect(hover).toMatch(/border-color\s*:\s*var\(--accent\)/);
    expect(hover).toMatch(/background\s*:\s*var\(--accent-soft\)/);
    // Keyboard focus must be as visible as the pointer: the same rule names both.
    expect(rules).toMatch(/\.palette-grid button:focus-visible/);
  });

  it("puts the entries 2 px apart and lets a label too wide for the panel wrap", () => {
    expect(declarationsOf(".palette-grid")).toMatch(/gap\s*:\s*2px/);
    const button = declarationsOf(".palette-grid button");
    expect(button).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(button).toMatch(/flex\s*:\s*0 1 auto/);
  });
});

describe("the panel is as large as the window allows", () => {
  it("is up to 520 px wide and never wider than the window", () => {
    expect(declarationsOf(".palette-panel")).toMatch(/width\s*:\s*min\(520px,\s*calc\(100vw - 16px\)\)/);
  });

  it("uses the window height, keeping the title bar and a 96 px margin free", () => {
    const panel = declarationsOf(".palette-panel");
    expect(panel).toMatch(/max-height\s*:\s*calc\(100vh - 96px\)/);
    // The list scrolls inside the panel; the panel itself never grows past the window.
    expect(panel).toMatch(/overflow\s*:\s*hidden/);
  });
});
