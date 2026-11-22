// A dragged region stays where the pointer let go until its move reaches the view: it never springs
// back to its old place and then jumps to the new one.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
/** Where the region is drawn, whichever way the offset is applied (position or transform). */
const where = (el: HTMLElement) => `${el.style.left}|${el.style.top}|${el.style.transform}`;

describe("dropping a dragged region", () => {
  it("keeps it at the drop point while the move is on its way, then at the stored place", async () => {
    const backend = createMockBackend({ fast: true });
    const slow = backend.moveRegions.bind(backend);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    backend.moveRegions = async (...args) => {
      await gate;
      return slow(...args);
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const start = where(region("m1")!);
    await act(async () => {
      fireEvent.pointerDown(region("m1")!, { button: 0, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(window, { clientX: 260, clientY: 240, buttons: 1 });
    });
    const during = where(region("m1")!);
    expect(during).not.toBe(start);
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 260, clientY: 240 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // The move has not landed: the region is still where the pointer let go.
    expect(where(region("m1")!)).toBe(during);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await waitFor(() => expect(where(region("m1")!)).not.toBe(start));
    expect(screen.getByRole("tab", { name: "Insert" })).not.toBeNull();
  });
});
