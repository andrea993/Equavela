// A rubber band selects regions and nothing else: no native text selection runs
// on over the texts between the press and the pointer, the header included.

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";

afterEach(cleanup);

/** Whether a native text selection starting on the sheet is refused now. */
function selectStartPrevented(): boolean {
  const event = new Event("selectstart", { bubbles: true, cancelable: true });
  document.querySelector("[data-region-id]")!.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("the rubber band", () => {
  it("makes the sheet unselectable as text while it is drawn, and clears a native selection at the press", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(document.querySelector("[data-region-id]")).not.toBeNull());
    const sheet = document.querySelector<HTMLElement>('[data-testid="sheet"]')!;
    // A native selection that was there before the press.
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("[data-region-id]")!);
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.rangeCount).toBe(1);
    expect(sheet.classList.contains("banding")).toBe(false);
    await act(async () => {
      fireEvent.pointerDown(document.querySelector(".page")!, { button: 0, clientX: 900, clientY: 300 });
    });
    expect(sheet.classList.contains("banding")).toBe(true);
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(selectStartPrevented()).toBe(true);
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 400, clientY: 700, buttons: 1 });
      fireEvent.pointerUp(window, { button: 0, clientX: 400, clientY: 700 });
    });
    expect(sheet.classList.contains("banding")).toBe(false);
    expect(selectStartPrevented()).toBe(false);
  });

  it("keeps the sheet unselectable as text while regions are dragged", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(document.querySelector("[data-region-id] .math")).not.toBeNull());
    const sheet = document.querySelector<HTMLElement>('[data-testid="sheet"]')!;
    const region = document.querySelector("[data-region-id] .math")!.closest<HTMLElement>("[data-region-id]")!;
    // Ctrl+click selects the region; a press on a selected region then moves it.
    await act(async () => {
      fireEvent.pointerDown(region, { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(window, { button: 0, ctrlKey: true, clientX: 10, clientY: 10 });
    });
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".page")!);
    window.getSelection()?.addRange(range);
    await act(async () => {
      fireEvent.pointerDown(region, { button: 0, clientX: 10, clientY: 10 });
    });
    expect(sheet.classList.contains("dragging")).toBe(true);
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(selectStartPrevented()).toBe(true);
    // The region follows the pointer by a transform, so its content is not laid out again on each move;
    // `left` changes only when the move lands.
    const left = region.style.left;
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 15, clientY: 17, buttons: 1 });
    });
    expect(region.style.transform).toMatch(/^translate\(/);
    expect(region.style.left).toBe(left);
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 60, clientY: -40, buttons: 1 });
      fireEvent.pointerUp(window, { button: 0, clientX: 60, clientY: -40 });
    });
    expect(sheet.classList.contains("dragging")).toBe(false);
    expect(selectStartPrevented()).toBe(false);
  });
});
