import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { anchorPosition, usePalettes } from "./usePalettes";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("palette anchoring", () => {
  it("opens under the button, left-aligned, and shifts left near the right edge", () => {
    expect(anchorPosition({ left: 300, bottom: 90 }, 1200)).toEqual({ x: 300, y: 92 });
    expect(anchorPosition({ left: 1100, bottom: 90 }, 1200)).toEqual({ x: 1200 - 460 - 8, y: 92 });
    expect(anchorPosition({ left: -20, bottom: 0 }, 1200).x).toBe(8);
    // A window narrower than the panel: the panel is as wide as the window minus its edges.
    expect(anchorPosition({ left: 200, bottom: 0 }, 300).x).toBe(8);
  });

  it("opens from the button rectangle, follows a resize, but keeps a dragged position", () => {
    window.innerWidth = 1200;
    const { result } = renderHook(() => usePalettes());
    act(() => result.current.open("operators", { left: 1000, bottom: 80 }));
    expect(result.current.palettes[0]).toMatchObject({ x: 732, y: 82 });
    window.innerWidth = 900;
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(result.current.palettes[0].x).toBe(432);
    act(() => result.current.move("operators", 50, 60));
    window.innerWidth = 700;
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(result.current.palettes[0]).toMatchObject({ x: 50, y: 60 });
  });
});

describe("palette dismissal", () => {
  const press = (target: Element) =>
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

  it("closes an unpinned palette on a press outside, but not inside it or on its toggle", () => {
    document.body.innerHTML =
      '<div class="palette-panel"><button id="in"></button></div><button id="toggle" data-palette-toggle="operators"></button><div id="sheet"></div>';
    const { result } = renderHook(() => usePalettes());
    act(() => result.current.open("operators", { left: 10, bottom: 10 }));
    act(() => void press(document.getElementById("in")!));
    expect(result.current.palettes).toHaveLength(1);
    act(() => void press(document.getElementById("toggle")!));
    expect(result.current.palettes).toHaveLength(1);
    // The press still reaches the worksheet: the listener neither stops nor cancels it.
    let reached = false;
    document.getElementById("sheet")!.addEventListener("pointerdown", () => (reached = true));
    act(() => void press(document.getElementById("sheet")!));
    expect(result.current.palettes).toHaveLength(0);
    expect(reached).toBe(true);
  });

  it("keeps a pinned palette open on an outside press", () => {
    document.body.innerHTML = '<div id="sheet"></div>';
    const { result } = renderHook(() => usePalettes());
    act(() => result.current.open("symbols", { left: 10, bottom: 10 }));
    act(() => result.current.togglePin("symbols"));
    act(() => void press(document.getElementById("sheet")!));
    expect(result.current.palettes).toHaveLength(1);
  });
});
