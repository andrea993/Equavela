// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { FIND_CURRENT, FIND_MATCH, occurrences, paintFind } from "./findHighlight";

class FakeHighlight {
  ranges: Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}
const painted = new Map<string, FakeHighlight>();
const globals = globalThis as unknown as { CSS?: unknown; Highlight?: unknown };
let saved: { CSS?: unknown; Highlight?: unknown };

beforeEach(() => {
  saved = { CSS: globals.CSS, Highlight: globals.Highlight };
  painted.clear();
  globals.CSS = { ...(globals.CSS as object), highlights: { set: (n: string, h: FakeHighlight) => painted.set(n, h), delete: (n: string) => painted.delete(n) } };
  globals.Highlight = FakeHighlight;
  document.body.innerHTML = `
    <div class="sheet-host">
      <div data-region-id="m1" data-kind="math"><span class="math"><span class="id">mis</span><span class="id">sing</span><span class="op">+</span><span class="result">sin</span></span><div class="region-note no-print">the name sin</div></div>
      <div data-region-id="m2" data-kind="math"><span class="math"><span class="id">sin</span><span class="op">(</span>x<span class="op">)</span><span class="id">Sin</span></span></div>
      <div data-region-id="m3" data-kind="math"><span class="math"><span class="id">x</span><sup>2</sup></span></div>
    </div>`;
});
afterEach(() => {
  globals.CSS = saved.CSS;
  globals.Highlight = saved.Highlight;
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!;

it("finds an occurrence across text nodes and never in a result or a note", () => {
  expect(occurrences(region("m1"), "SIN").map((range) => range.toString())).toEqual(["sin"]);
  const found = occurrences(region("m1"), "SSI");
  expect(found.map((range) => range.toString())).toEqual(["ssi"]);
  expect(found[0].startContainer.textContent).toBe("mis");
  expect(found[0].endContainer.textContent).toBe("sing");
});

it("finds every occurrence case-insensitively", () => {
  expect(occurrences(region("m2"), "sin").map((range) => range.toString())).toEqual(["sin", "Sin"]);
  expect(occurrences(region("m3"), "x^2")).toEqual([]);
  expect(occurrences(region("m2"), "")).toEqual([]);
});

it("paints the current match apart from the others and clears with no query", () => {
  const current = paintFind(document, ["m1", "m2"], "m2", "sin");
  expect(painted.get(FIND_CURRENT)?.ranges.map((range) => range.toString())).toEqual(["sin", "Sin"]);
  expect(painted.get(FIND_MATCH)?.ranges.map((range) => range.toString())).toEqual(["sin"]);
  expect(current.map((range) => range.toString())).toEqual(["sin", "Sin"]);
  paintFind(document, [], null, null);
  expect(painted.size).toBe(0);
});
