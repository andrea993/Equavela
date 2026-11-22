// the specification : the wheel over a result box.
import { describe, expect, it } from "vitest";
import { boxPassingWheel, wheelPixels } from "./boxWheel";

function sheet() {
  document.body.innerHTML = `<div class="area"><span class="result-matrix-scroll" tabindex="0"><span class="cell">1</span></span><span class="other">x</span></div>`;
  return { box: document.querySelector(".result-matrix-scroll")!, cell: document.querySelector(".cell")!, other: document.querySelector(".other")! };
}
const wheel = (target: Element, extra: Partial<WheelEvent> = {}) => ({ target, deltaX: 0, deltaY: 100, shiftKey: false, ctrlKey: false, ...extra }) as WheelEvent;

describe("the wheel over a result box", () => {
  it("passes a vertical wheel to the page while the box does not have the keyboard", () => {
    const { box, cell } = sheet();
    expect(boxPassingWheel(wheel(cell), document.body)).toBe(box);
    expect(boxPassingWheel(wheel(cell), null)).toBe(box);
  });
  it("leaves it to the box once the box has the keyboard", () => {
    const { box, cell } = sheet();
    expect(boxPassingWheel(wheel(cell), box)).toBeNull();
  });
  it("leaves horizontal, Shift and Ctrl wheels, and anything outside a box, alone", () => {
    const { cell, other } = sheet();
    expect(boxPassingWheel(wheel(cell, { deltaX: 120, deltaY: 10 }), null)).toBeNull();
    expect(boxPassingWheel(wheel(cell, { shiftKey: true }), null)).toBeNull();
    expect(boxPassingWheel(wheel(cell, { ctrlKey: true }), null)).toBeNull();
    expect(boxPassingWheel(wheel(other), null)).toBeNull();
  });
  it("turns lines and pages into pixels", () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 }, 700)).toBe(48);
    expect(wheelPixels({ deltaY: 1, deltaMode: 2 }, 700)).toBe(700);
    expect(wheelPixels({ deltaY: 53, deltaMode: 0 }, 700)).toBe(53);
  });
});
