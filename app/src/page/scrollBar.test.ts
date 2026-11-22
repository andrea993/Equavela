import { describe, expect, it } from "vitest";
import { onScrollBar } from "./PageView";

/** A scrolling box of 200 x 100 with 15 px scroll bars, at (10, 20), as the browser would measure it. */
function box(bars: { x: number; y: number }): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowX = "auto";
  el.style.overflowY = "auto";
  document.body.append(el);
  const define = (name: string, value: number) => Object.defineProperty(el, name, { value, configurable: true });
  define("offsetWidth", 200);
  define("offsetHeight", 100);
  define("clientWidth", 200 - bars.x);
  define("clientHeight", 100 - bars.y);
  define("clientLeft", 0);
  define("clientTop", 0);
  el.getBoundingClientRect = () => ({ left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100, x: 10, y: 20, toJSON: () => ({}) });
  return el;
}

describe("a press on the scroll bar of a scrolling box", () => {
  it("is told from a press on its content", () => {
    const both = box({ x: 15, y: 15 });
    expect(onScrollBar(both, 100, 112)).toBe(true); // horizontal bar
    expect(onScrollBar(both, 205, 60)).toBe(true); // vertical bar
    expect(onScrollBar(both, 100, 60)).toBe(false); // content
  });

  it("is found by position when the engine names another target, and never for an inline element", () => {
    const region = document.createElement("div");
    const scroller = box({ x: 15, y: 15 });
    scroller.className = "matrix-scrollbar";
    region.append(scroller);
    document.body.append(region);
    expect(onScrollBar(region, 100, 112, region)).toBe(true);
    expect(onScrollBar(region, 100, 60, region)).toBe(false);
    // An inline span reports a client size of 0 and no overflow: a click on a name is no bar press.
    const name = document.createElement("span");
    Object.defineProperty(name, "offsetWidth", { value: 40 });
    Object.defineProperty(name, "offsetHeight", { value: 14 });
    expect(onScrollBar(name, 5, 5)).toBe(false);
  });

  it("is never a scroll bar press for a box without bars", () => {
    expect(onScrollBar(box({ x: 0, y: 0 }), 209, 119)).toBe(false);
  });
});
