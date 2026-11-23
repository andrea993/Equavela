import { describe, expect, it } from "vitest";
import { unionRect } from "./EditorOverlay";

const rect = (left: number, top: number, right: number, bottom: number) =>
  [{ left, top, right, bottom, width: right - left, height: bottom - top }] as unknown as DOMRectList;

/** An element whose boxes the browser would report as given (jsdom does no layout). */
function box(parent: Element | null, rects: DOMRectList, className = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.getClientRects = () => rects;
  parent?.append(el);
  return el;
}

describe("the box of an expression under the editing lines", () => {
  it("leaves out the result drawn after its operator, so a tall matrix does not stretch the lines", () => {
    const statement = box(null, rect(0, 0, 300, 20)); // the inline statement runs on over the result
    box(statement, rect(0, 0, 40, 20)); // `B =`
    const result = box(statement, rect(50, -100, 300, 200), "result");
    box(result, rect(50, -100, 300, 200)); // the table
    const r = unionRect(statement);
    expect([r?.left, r?.top, r?.right, r?.bottom]).toEqual([0, 0, 40, 20]);
  });

  it("keeps the whole element when there is no result in it", () => {
    const statement = box(null, rect(0, 0, 100, 20));
    box(statement, rect(0, 0, 60, 20));
    const r = unionRect(statement);
    expect([r?.left, r?.right]).toEqual([0, 100]);
  });

  it("stops at the edges of the box that clips a long result", () => {
    const result = box(null, rect(0, 0, 40, 240), "result");
    const clip = box(result, rect(0, 0, 40, 240), "result-matrix-scroll");
    clip.getBoundingClientRect = () => new DOMRect(0, 0, 40, 240);
    const matrix = box(clip, rect(0, 0, 40, 1260), "result-matrix"); // 60 rows, most scrolled out
    box(matrix, rect(4, 1200, 30, 1220)); // a cell far below the box
    const r = unionRect(matrix);
    expect([r?.left, r?.top, r?.right, r?.bottom]).toEqual([0, 0, 40, 240]);
    expect(unionRect(result)?.bottom).toBe(240);
  });

  it("stops at the edges of the scroll bars beside a long result, whose filler spans the whole matrix", () => {
    const result = box(null, rect(0, 0, 46, 246), "result");
    const clip = box(result, rect(0, 0, 40, 240), "result-matrix-scroll");
    clip.getBoundingClientRect = () => new DOMRect(0, 0, 40, 240);
    box(clip, rect(0, 0, 4800, 1_145_000), "result-matrix");
    const vertical = box(result, rect(40, 0, 46, 240), "matrix-scrollbar vertical");
    vertical.getBoundingClientRect = () => new DOMRect(40, 0, 6, 240);
    box(vertical, rect(40, 0, 41, 1_145_000)); // as tall as the matrix
    const horizontal = box(result, rect(0, 240, 40, 246), "matrix-scrollbar horizontal");
    horizontal.getBoundingClientRect = () => new DOMRect(0, 240, 40, 6);
    box(horizontal, rect(0, 240, 4800, 241)); // as wide as the matrix
    const r = unionRect(result);
    expect([r?.left, r?.top, r?.right, r?.bottom]).toEqual([0, 0, 46, 246]);
  });
});
