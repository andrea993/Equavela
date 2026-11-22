// Regression guard for GitHub : the chips of an insert panel are the sections of the
// open palette, and they wrap onto several lines instead of scrolling sideways — the Units palette
// has one section per dimension, so its row is the longest.
//
// jsdom, the test environment, does not apply the stylesheets, so the rule is read from the very
// source the app ships (as `stacking.test.ts` does).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** `chrome.css` from the frontend directory (the test runs with `app/` as the working directory). */
function stylesheet(): string {
  for (const candidate of ["src/styles/chrome.css", "app/src/styles/chrome.css"]) {
    // Comments are dropped so a note that mentions a declaration cannot be mistaken for it.
    if (existsSync(candidate)) return readFileSync(candidate, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  throw new Error("chrome.css not found: run the frontend tests from `app/`");
}

const css = stylesheet();

/** The declarations of the first rule of `selector` in `chrome.css`. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!found) throw new Error(`${selector} is not declared in chrome.css`);
  return found[1];
}

describe("the chip row of an insert panel", () => {
  it("wraps the chips onto several lines and never scrolls sideways", () => {
    const row = declarationsOf(".palette-sections");
    expect(row).toMatch(/(?:^|;)\s*display\s*:\s*flex/);
    expect(row).toMatch(/(?:^|;)\s*flex-wrap\s*:\s*wrap/);
    expect(row).not.toMatch(/overflow-x/);
    expect(row).not.toMatch(/white-space\s*:\s*nowrap/);
  });

  it("marks the chip of the section at the top with the active class", () => {
    expect(declarationsOf(".palette-sections button.active")).toMatch(/background/);
  });
});

describe("the list of an insert panel", () => {
  it("shrinks inside the panel and scrolls, so the end of a long palette can be reached", () => {
    const body = declarationsOf(".palette-body");
    expect(body).toMatch(/(?:^|;)\s*min-height\s*:\s*0/);
    expect(body).toMatch(/(?:^|;)\s*overflow\s*:\s*auto/);
    expect(declarationsOf(".palette-panel")).toMatch(/(?:^|;)\s*flex-direction\s*:\s*column/);
  });
});
