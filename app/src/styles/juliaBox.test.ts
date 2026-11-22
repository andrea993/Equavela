// Regression guard for the box of a Julia region: the
// box is the stored size, the code scrolls inside it on screen and the print clips it, so the page
// and the PDF draw the same box at the same size.
//
// jsdom, the test environment, does not apply the stylesheets, so the rules are read from the very
// source the app ships (as `resultBox.test.ts` does).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(): string {
  for (const candidate of ["src/styles/page.css", "app/src/styles/page.css"]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("page.css not found: run the frontend tests from `app/`");
}

const rules = stylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule that names `selector` (alone or in a selector list). */
function declarationsOf(selector: string): string {
  for (const found of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = found[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return found[2];
  }
  throw new Error(`${selector} is not declared in page.css`);
}

/** The bodies of every `@media <query>` block, brace-matched. */
function mediaBlocks(query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = rules.indexOf(`@media ${query}`, from);
    if (at < 0) return blocks;
    let depth = 0;
    let end = at;
    for (let i = rules.indexOf("{", at); i < rules.length; i += 1) {
      if (rules[i] === "{") depth += 1;
      else if (rules[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push(rules.slice(at, end));
    from = end;
  }
}

describe("the box of a Julia region", () => {
  it("gives the stored size to the box and lets the code scroll inside it", () => {
    // The default box grows with its content and keeps its minimum width.
    expect(declarationsOf(".julia-region")).toMatch(/min-width\s*:\s*300px/);
    // Never shorter than a header and one line of code, a stored box and an empty block included.
    expect(declarationsOf(".julia-region")).toMatch(/min-height\s*:\s*40px/);
    expect(declarationsOf(".julia-region.sized")).toMatch(/min-height\s*:\s*52px/);
    // A stored size wins over that minimum, and the code box takes what is left and scrolls.
    expect(declarationsOf(".julia-region.sized")).toMatch(/min-width\s*:\s*0/);
    expect(declarationsOf(".julia-region.sized .julia-code-box")).toMatch(/overflow\s*:\s*auto/);
    expect(declarationsOf(".julia-region.sized .julia-code-box")).toMatch(/min-height\s*:\s*0/);
  });

  it("keeps its size while the code is edited: the code scrolls and the field scrolls with it", () => {
    // No rule lets an edited box grow or stop scrolling.
    expect(() => declarationsOf(".julia-region.sized.editing")).toThrow();
    expect(() => declarationsOf(".julia-region.sized.editing .julia-code-box")).toThrow();
    // The drawn code and the field share one inner box as large as the code, which scrolls as a whole.
    expect(declarationsOf(".julia-code-inner")).toMatch(/position\s*:\s*relative/);
    expect(declarationsOf(".julia-code-inner")).toMatch(/min-width\s*:\s*100%/);
    expect(declarationsOf(".julia-editor")).toMatch(/position\s*:\s*absolute/);
  });

  it("clips the code in print, where the scroll bars are not drawn", () => {
    const print = mediaBlocks("print").join("\n");
    expect(print).toMatch(/\.julia-region\.sized \.julia-code-box[^{]*\{[^}]*overflow\s*:\s*hidden/);
  });
});
