// Regression guard for the box of a matrix result:
// a large matrix is clipped inside its box with scroll bars outside its
// brackets, the print hides them, so the sheet and the PDF draw the same box (WYSIWYG), a scroll
// repaints nothing but the content of the box, and the indices are plain text.
//
// jsdom, the test environment, does not apply the stylesheets, so the rules are read from the very
// source the app ships (as `labelStyles.test.ts` and `stacking.test.ts` do).
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function stylesheet(): string {
  for (const candidate of ["src/styles/math.css", "app/src/styles/math.css"]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error("math.css not found: run the frontend tests from `app/`");
}

const rules = stylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule that names `selector` (alone or in a selector list). */
function declarationsOf(selector: string): string {
  for (const found of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = found[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) return found[2];
  }
  throw new Error(`${selector} is not declared in math.css`);
}

/** The declarations of every rule that names `selector`, joined: a later rule may add to an
 * earlier one. */
function allDeclarationsOf(selector: string): string {
  const declarations: string[] = [];
  for (const found of rules.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = found[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) declarations.push(found[2]);
  }
  if (declarations.length === 0) throw new Error(`${selector} is not declared in math.css`);
  return declarations.join("\n");
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

describe("a large classic matrix sits in the result box", () => {
  it("clips it inside its maxima", () => {
    const scroll = declarationsOf(".result-matrix-scroll");
    expect(scroll).toMatch(/overflow\s*:\s*auto/);
    expect(scroll).toMatch(/max-width\s*:\s*var\(--region-max-w/);
    expect(scroll).toMatch(/max-height\s*:\s*240px/);
    // A stored box sets its own width and height: neither default maximum applies.
    expect(declarationsOf(".result-matrix-scroll.sized")).toMatch(/max-width\s*:\s*none/);
    expect(declarationsOf(".result-matrix-scroll.sized")).toMatch(/max-height\s*:\s*none/);
  });

  it("puts the handle against the box", () => {
    expect(declarationsOf(".result-matrix-box")).toMatch(/position\s*:\s*relative/);
    expect(declarationsOf(".result-matrix-wrap")).toMatch(/display\s*:\s*inline-block/);
  });
});

describe("the print draws the same box", () => {
  it("hides the scroll bars of the clipped matrix", () => {
    const print = mediaBlocks("print").join("\n");
    expect(print).toMatch(/\.result-matrix-scroll[^{}]*\{[^}]*overflow\s*:\s*hidden/);
  });
});

describe("nothing of a result is painted outside its box", () => {
  it("draws no frame around the box", () => {
    expect(allDeclarationsOf(".result-matrix-box")).not.toMatch(/outline\s*:/);
  });

  it("clips the painting of the scroll box, so a scroll leaves no rectangle behind", () => {
    expect(declarationsOf(".result-matrix-scroll")).toMatch(/contain\s*:\s*paint/);
  });

  it("keeps the scroll bars outside the brackets", () => {
    // The box between the brackets shows no bar of its own ...
    expect(allDeclarationsOf(".result-matrix-scroll")).toMatch(/scrollbar-width\s*:\s*none/);
    expect(allDeclarationsOf(".result-matrix-scroll::-webkit-scrollbar")).toMatch(/display\s*:\s*none/);
    // ... the vertical bar stands right of the box (and its closing bracket), the horizontal one under it.
    expect(allDeclarationsOf(".matrix-scrollbar.vertical")).toMatch(/left\s*:\s*100%/);
    expect(allDeclarationsOf(".matrix-scrollbar.horizontal")).toMatch(/top\s*:\s*100%/);
    // The box keeps room for them, so they never cover what follows.
    expect(allDeclarationsOf(".result-matrix-box.bar-y")).toMatch(/margin-right\s*:/);
    expect(allDeclarationsOf(".result-matrix-box.bar-x")).toMatch(/margin-bottom\s*:/);
  });
});

describe("the indices of a matrix", () => {
  it("are plain grey text, with no box, frame or background", () => {
    const indices = allDeclarationsOf(".matrix-indices");
    expect(indices).toMatch(/color\s*:\s*#8a9099/);
    expect(indices).not.toMatch(/(border|outline|background)\s*:/);
    expect(allDeclarationsOf(".matrix-indices .index-strip")).not.toMatch(/(border|outline|background)\s*:/);
  });
});

describe("no focus ring on a scrolling result box", () => {
  it("a press on the scroll bar focuses the box without the engine drawing a ring around it", () => {
    for (const selector of [".result-matrix-scroll:focus", ".result-matrix-scroll:focus-visible"]) {
      expect(rules).toMatch(new RegExp(`${selector.replace(/[.:-]/g, "\\$&")}[^{]*\\{[^}]*outline:\\s*none`));
    }
  });
});
