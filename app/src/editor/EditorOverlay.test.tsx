// The editing lines over a run of call arguments: one selection box that spans the run,
// from the left of its first argument to the right of its last, commas included. jsdom has no
// layout, so every node is measured at the box the test gives it by its `data-path`.

import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MathStatement } from "../math/render";
import { mockParse } from "../mock/mockMath";
import { EditorOverlay } from "./EditorOverlay";
import { focusAt, initialState, selectRange, type EditorState } from "./model";
import { ident, toEditing } from "./tree";

afterEach(cleanup);

/** The box of each addressable node: `f(a, b, c)` on one line, 10 px per argument. */
const BOXES: Record<string, [number, number]> = { "0.1": [10, 20], "0.2": [30, 40], "0.3": [50, 60], "0.0": [10, 200], "0.0.0": [10, 50] };
type Measure = { getBoundingClientRect: () => DOMRect; getClientRects: () => DOMRectList };
const proto = Element.prototype as unknown as Measure;
const original = { getBoundingClientRect: proto.getBoundingClientRect, getClientRects: proto.getClientRects };
const restore = () => {
  proto.getBoundingClientRect = original.getBoundingClientRect;
  proto.getClientRects = original.getClientRects;
};

/** Measures every element at the box of its `data-path`; every other node is 0 x 0 (and skipped). */
function stubGeometry(): void {
  const rect = (element: Element) => {
    const box = BOXES[element.getAttribute("data-path") ?? ""];
    return box ? new DOMRect(box[0], 0, box[1] - box[0], 10) : new DOMRect(0, 0, 0, 0);
  };
  proto.getBoundingClientRect = function (this: Element) {
    return rect(this);
  };
  proto.getClientRects = function (this: Element) {
    return [rect(this)] as unknown as DOMRectList;
  };
}

function Harness({ editor }: { editor: EditorState }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="math" ref={ref}>
      <MathStatement statement={editor.root as never} path={[]} />
      <EditorOverlay editor={editor} container={ref} />
    </div>
  );
}

/** Renders the editing lines of `editor`: the drawn selection rectangle and the lines. */
function draw(editor: EditorState) {
  stubGeometry();
  try {
    const { container, rerender } = render(<Harness editor={editor} />);
    // The overlay measures in a layout effect, which runs before the ref of the container it
    // measures is attached: a second update is the one that draws, exactly as in the app.
    rerender(<Harness editor={{ ...editor }} />);
    const number = (element: Element | null, attribute: string) =>
      element ? Number(element.getAttribute(attribute)) : null;
    const rect = container.querySelector("rect.selection");
    return {
      selection: rect ? { x: number(rect, "x"), width: number(rect, "width") } : null,
      underline: container.querySelector("line.underline")
        ? {
            x1: number(container.querySelector("line.underline"), "x1"),
            x2: number(container.querySelector("line.underline"), "x2"),
          }
        : null,
      insertion: number(container.querySelector("line.insertion"), "x1"),
    };
  } finally {
    restore();
  }
}

const call = (text: string) => initialState(toEditing(mockParse(text)));

describe("the editing lines of a run of call arguments", () => {
  it("draws one box from the left of the first argument to the right of the last, commas included", () => {
    const all = draw(selectRange(call("f(a,b,c)"), [0, 1], [0, 3]));
    expect(all.selection).toEqual({ x: 10, width: 50 });
    expect(all.underline).toEqual({ x1: 10, x2: 60 });
    expect(all.insertion).toBe(60);

    const lastTwo = draw(selectRange(call("f(a,b,c)"), [0, 2], [0, 3]));
    expect(lastTwo.selection).toEqual({ x: 30, width: 30 });
    expect(lastTwo.underline).toEqual({ x1: 30, x2: 60 });
  });

  it("draws the ordinary box of one argument when the selection is one argument", () => {
    const one = draw(selectRange(call("f(a,b,c)"), [0, 1], [0, 1]));
    expect(one.selection).toEqual({ x: 10, width: 10 });
    expect(one.underline).toEqual({ x1: 10, x2: 20 });
  });
});

it("underlines only the content of a short program instruction", () => {
  const root = { type: "ExprRegion", expr: { type: "Program", body: [
    { type: "Return", expr: ident("x") },
    { type: "ExprStmt", expr: ident("longer") },
  ] } };
  const line = draw(focusAt(root, [0, 0], "R", true));
  expect(line.underline).toEqual({ x1: 10, x2: 50 });
  expect(line.insertion).toBe(50);
  expect(line.selection).toEqual({ x: 10, width: 40 });
});
