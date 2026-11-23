// The box of a Julia region in the window: a single
// selected block shows the corner handle of an image and a plot, one drag stores the size of the
// box in points as one undo step, and a block with no stored size grows with its code.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { createMockBackend, type MockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(cleanup);

const juliaRegions = () => [...document.querySelectorAll<HTMLElement>("[data-kind=julia]")];
const box = () => juliaRegions().at(-1)!.querySelector<HTMLElement>(".julia-region")!;
const handle = () => juliaRegions().at(-1)!.querySelector("[data-testid=resize-handle]");
const undoButton = () => screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;

async function openEmpty(): Promise<MockBackend> {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).not.toBeNull());
  // A new worksheet: its crosshair sits at the top margin, where a block inserted from the ribbon
  // lands.
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).toBeNull());
  return backend;
}

async function insertJulia() {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.julia }));
  await waitFor(() => expect(juliaRegions().length).toBeGreaterThan(0));
  await waitFor(() => expect(handle()).not.toBeNull());
}

describe("the box of a Julia region", () => {
  it("resizes with the corner handle in 3 pt steps, one undo step per drag", async () => {
    await openEmpty();
    await insertJulia();
    // A new block has no stored box: it grows with its header and its code.
    expect(box().classList.contains("sized")).toBe(false);
    expect(box().style.width).toBe("");
    // The drag starts at the size the block is drawn at — here the minimum of the box, because the
    // test window measures no text — and follows the pointer in whole 3 pt steps.
    fireEvent.pointerDown(handle()!, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 620, clientY: 460 }));
    // 144 + 90 = 234 pt and 39 + 45 = 84 pt (the smallest box, a header and one line of code), drawn
    // as CSS px (1 pt = 4/3 px).
    expect(box().style.width).toBe("312px");
    expect(box().style.height).toBe("112px");
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 620, clientY: 460 }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Resize Julia block"));
    expect(box().classList.contains("sized")).toBe(true);
    expect(box().style.width).toBe("312px");
    // One undo takes the stored box away and the block grows again; redo brings it back.
    fireEvent.click(undoButton());
    await waitFor(() => expect(box().style.width).toBe(""));
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.redo }));
    await waitFor(() => expect(box().style.width).toBe("312px"));
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: S.commands.title });
    const search = within(dialog).getByLabelText(S.commands.search);
    fireEvent.change(search, { target: { value: "Julia: reset to content size" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(box().style.width).toBe(""));
    fireEvent.click(undoButton());
    await waitFor(() => expect(box().style.width).toBe("312px"));
  });

  it("grows past the printable margins when dragged there", async () => {
    await openEmpty();
    await insertJulia();
    fireEvent.pointerDown(handle()!, { button: 0, clientX: 500, clientY: 400 });
    // 1600 x 2000 CSS px = 1200 x 1500 pt: far past the right and the bottom margin of an A4 page.
    await act(async () => void fireEvent.pointerMove(window, { clientX: 2100, clientY: 2400 }));
    // 144 + 1200 = 1344 pt and 39 + 1500 = 1539 pt, as CSS px.
    expect(box().style.width).toBe("1792px");
    expect(box().style.height).toBe("2052px");
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 2100, clientY: 2400 }));
    await waitFor(() => expect(box().style.width).toBe("1792px"));
  });

  it("a press and release on the handle without moving changes nothing", async () => {
    await openEmpty();
    await insertJulia();
    fireEvent.pointerDown(handle()!, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 500, clientY: 400 }));
    expect(undoButton().getAttribute("title")).toContain("Add region");
    expect(box().style.width).toBe("");
  });

  it("shows the handle of a corner on a single selected block, screen only", async () => {
    await openEmpty();
    await insertJulia();
    expect(handle()!.getAttribute("aria-label")).toBe(S.page.resizeJulia);
    expect(handle()!.classList.contains("no-print")).toBe(true);
    // The box itself is document content: it is printed, unlike the handle.
    expect(box().classList.contains("no-print")).toBe(false);
    expect(box().querySelector(".julia-code-box")).not.toBeNull();
  });
});
