// a click on an operator puts the cursor next to it, not on the whole expression.
import { describe, expect, it } from "vitest";
import { mathHit, nearestMathHit } from "./hit";

function box(element: Element, left: number, right: number, top = 0, bottom = 20) {
  const rect = new DOMRect(left, top, right - left, bottom - top);
  Object.defineProperty(element, "getBoundingClientRect", { value: () => rect });
  Object.defineProperty(element, "getClientRects", { value: () => [rect] });
}

/** `a + b` at x 0–10, `+` at 14–22, `b` at 26–36. */
function sum() {
  const container = document.createElement("div");
  container.innerHTML =
    '<span class="node" data-path=""><span class="node" data-path="0"><span class="name"><span>a</span></span></span>' +
    '<span class="op">+</span><span class="node" data-path="1"><span class="name"><span>b</span></span></span></span>';
  document.body.append(container);
  const [a, b] = [container.querySelector('[data-path="0"]')!, container.querySelector('[data-path="1"]')!];
  box(a, 0, 10);
  box(a.querySelector("span span")!, 0, 10);
  box(b, 26, 36);
  box(b.querySelector("span span")!, 26, 36);
  const op = container.querySelector(".op")!;
  box(op, 14, 22);
  return { container, op, a };
}

describe("a click inside a string split by a presentation break", () => {
  function split() {
    const container = document.createElement("div");
    container.innerHTML =
      '<span class="node" data-path="0"><span class="str">' +
      '<span class="str-quote">“</span><span data-str-offset="0">he</span>' +
      '<span class="eq-break-arrow">↵</span><br><span class="eq-break-indent"></span>' +
      '<span data-str-offset="2">llo</span><span class="str-quote">”</span></span></span>';
    document.body.append(container);
    const [first, second, open, close] = [
      container.querySelector<HTMLElement>('[data-str-offset="0"]')!,
      container.querySelector<HTMLElement>('[data-str-offset="2"]')!,
      container.querySelector<HTMLElement>(".str-quote:first-child")!,
      container.querySelector<HTMLElement>(".str-quote:last-child")!,
    ];
    box(first, 0, 20, 0, 20);
    box(second, 20, 50, 24, 44);
    box(open, -4, 0, 0, 20);
    box(close, 50, 54, 24, 44);
    return { container, first, second, open, close };
  }

  it("uses the piece's offset on the continuation line", () => {
    const { container, second } = split();
    const hit = mathHit(container, second, 20, 30);
    expect(hit?.path).toEqual([0]);
    expect(hit?.caret).toEqual({ seg: 0, offset: 2 });
  });

  it("keeps a press on a quote outside the string text", () => {
    const { container, open, close } = split();
    expect(mathHit(container, open, -2, 10)).toEqual({
      path: [0],
      side: "L",
      caret: { seg: 0, offset: 0, outside: true },
    });
    expect(mathHit(container, close, 52, 30)).toEqual({
      path: [0],
      side: "R",
      caret: { seg: 0, offset: 0, outside: true },
    });
  });
});

describe("a click on an operator", () => {
  it("puts the cursor after the left operand on the left half of the operator", () => {
    const { container, op } = sum();
    expect(mathHit(container, op, 16, 10)).toEqual({ path: [0], side: "R", caret: null });
  });

  it("puts the cursor before the right operand on the right half of the operator", () => {
    const { container, op } = sum();
    expect(mathHit(container, op, 21, 10)).toEqual({ path: [1], side: "L", caret: null });
  });

  it("keeps a click inside an operand on that operand", () => {
    const { container, a } = sum();
    expect(mathHit(container, a.querySelector("span span"), 9, 10)?.path).toEqual([0]);
  });
});

describe("a press in the frame of the edited expression, off its math", () => {
  it("goes to the nearest node, and never to the result", () => {
    const { container } = sum();
    const root = container.querySelector('[data-path=""]')!;
    box(root, 0, 36);
    const result = document.createElement("span");
    result.className = "result";
    result.innerHTML = '<span class="node" data-path="0"></span>';
    root.append(result);
    box(result, 40, 80, -100, 140);
    box(result.firstElementChild!, 40, 80, -100, 140);
    // Below `a`, where the tall result leaves the frame empty: the caret goes to `a`.
    const below = nearestMathHit(container, 3, 90);
    expect([below?.path, below?.side]).toEqual([[0], "L"]);
    // Below `b`, on its right half.
    const right = nearestMathHit(container, 34, 90);
    expect([right?.path, right?.side]).toEqual([[1], "R"]);
  });
});

it("places a matrix bracket press on the corresponding outer gap", () => {
  const container = document.createElement("div");
  container.innerHTML =
    '<span class="node" data-path="0"><span class="matrix">' +
    '<svg class="fence-side left"></svg><span class="matrix-grid"><span data-cell-path="0.0"></span></span>' +
    '<svg class="fence-side right"></svg></span></span>';
  for (const [name, side] of [["left", "L"], ["right", "R"]] as const) {
    const bracket = container.querySelector(`.fence-side.${name}`)!;
    expect(mathHit(container, bracket, 0, 0)).toEqual({ path: [0], side, caret: null });
  }
});
