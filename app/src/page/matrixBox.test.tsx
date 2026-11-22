// The box of a large matrix result,
// on the mock backend: the demo's 15 x 15 matrix `m22` is clipped in its box.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { pxToPt, ptToPx } from "../layout/geometry";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { enterPrint, leavePrint } from "../print/printMode";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  leavePrint();
  cleanup();
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const scroller = (id: string) => region(id)?.querySelector<HTMLElement>(".result-matrix-scroll") ?? null;
const handle = (id: string) => region(id)?.querySelector<HTMLElement>("[data-testid=table-resize-handle]") ?? null;
const undoButton = () => screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
/** The size of the box in points, as the sheet draws it (CSS px of the element divided by the scale). */
const boxPt = (id: string): [number, number] | null => {
  const element = scroller(id);
  if (!element || element.style.width === "") return null;
  return [pxToPt(parseFloat(element.style.width)), pxToPt(parseFloat(element.style.height))];
};

async function openDemo() {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  await waitFor(() => expect(region("m22")?.querySelector(".result-matrix-scroll")).not.toBeNull());
  return backend;
}

/** Selects a region with a press and a release at the same point (which opens its editor). */
async function selectRegion(id: string) {
  fireEvent.pointerDown(region(id)!, { button: 0, clientX: 200, clientY: 200 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 200, clientY: 200 }));
  await waitFor(() => expect(region(id)?.classList.contains("selected")).toBe(true));
}

/** Drags the corner handle of the box by `dx`/`dy` CSS px; returns before the release. */
async function dragHandleBy(dx: number, dy: number) {
  const corner = handle("m22")!;
  fireEvent.pointerDown(corner, { button: 0, clientX: 500, clientY: 400 });
  await act(async () => void fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 400 + dy }));
}

describe("the box of a matrix result", () => {
  it("resizes with its corner handle, one undo step per drag", async () => {
    await openDemo();
    // Nothing to grab while the region is not selected: the handle belongs to the resize gesture.
    expect(scroller("m22")).not.toBeNull();
    expect(handle("m22")).toBeNull();
    // The default box of is CSS, so the sheet draws no size of its own.
    expect(boxPt("m22")).toBeNull();
    await selectRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());

    // +30 pt on both sides (40 CSS px): the box follows the pointer while the drag is in progress.
    await dragHandleBy(40, 40);
    const during = boxPt("m22");
    expect(during).not.toBeNull();
    expect(during![0]).toBeGreaterThan(0);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Result format"));
    const stored = boxPt("m22")!;
    expect(stored).toEqual(during);

    // A second drag starts from the stored box: both sides move by the same 30 pt.
    await dragHandleBy(40, 40);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    await waitFor(() => expect(boxPt("m22")).toEqual([stored[0] + 30, stored[1] + 30]));

    // Two drags, two undo steps: the first one brings the first box back, the second the default.
    fireEvent.click(undoButton());
    await waitFor(() => expect(boxPt("m22")).toEqual(stored));
    fireEvent.click(undoButton());
    await waitFor(() => expect(boxPt("m22")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.redo }));
    await waitFor(() => expect(boxPt("m22")).toEqual(stored));
  });

  it("is stored as the region display setting result-table-size, in points", async () => {
    const backend = await openDemo();
    // The mock keeps the override on the region's `format` map, exactly where the file keeps it
    //: one edit command, so the drag is one undo step.
    const setResultFormat = vi.spyOn(backend, "setResultFormat");
    await selectRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());
    await dragHandleBy(60, 30);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 560, clientY: 430 }));
    await waitFor(() => expect(setResultFormat).toHaveBeenCalled());
    const stored = setResultFormat.mock.calls.at(-1)![2] as Record<string, string>;
    const box = boxPt("m22")!;
    expect(stored["result-table-size"]).toBe(`${box[0]},${box[1]}`);
    expect(Number.isInteger(box[0])).toBe(true);
    // The stored value is what the sheet draws, so a file written with the box reopens with it.
    expect(scroller("m22")!.style.width).toBe(`${ptToPx(box[0])}px`);
    expect(scroller("m22")!.style.height).toBe(`${ptToPx(box[1])}px`);
    expect(scroller("m22")!.classList.contains("sized")).toBe(true);
  });

  it("a drag that does not move adds no step and keeps the default box", async () => {
    await openDemo();
    await selectRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());
    const before = undoButton().getAttribute("title");
    fireEvent.pointerDown(handle("m22")!, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 500, clientY: 400 }));
    expect(undoButton().getAttribute("title")).toBe(before);
    expect(boxPt("m22")).toBeNull();
  });

  it("keeps the box when the result format is applied or reset", async () => {
    const backend = await openDemo();
    const setResultFormat = vi.spyOn(backend, "setResultFormat");
    await selectRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());
    await dragHandleBy(40, 40);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    await waitFor(() => expect(boxPt("m22")).not.toBeNull());
    const box = boxPt("m22")!;
    const size = `${box[0]},${box[1]}`;

    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.resultFormat }));
    const dialog = await screen.findByRole("dialog", { name: S.resultFormat.title });
    fireEvent.change(within(dialog).getByTestId("rf-type"), { target: { value: "percent" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("rf-apply"));
    });
    await waitFor(() => expect(boxPt("m22")).toEqual(box));
    // Apply adds the dialog's keys to the override and keeps the box beside them.
    expect(setResultFormat.mock.calls.at(-1)![2]).toMatchObject({
      "format.type": "percent",
      "result-table-size": size,
    });
    // Reset removes the `format.*` keys the dialog sets, the old display key among them, and keeps the box.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.resultFormat }));
    const again = await screen.findByRole("dialog", { name: S.resultFormat.title });
    await act(async () => {
      fireEvent.click(within(again).getByTestId("rf-reset"));
    });
    await waitFor(() => expect(boxPt("m22")).toEqual(box));
    expect(setResultFormat.mock.calls.at(-1)![2]).toEqual({ "result-table-size": size });
  });

  it("offers no handle for a result that is not a matrix", async () => {
    await openDemo();
    // m13 is a scalar: a selected math region without a matrix result.
    await selectRegion("m13");
    expect(handle("m13")).toBeNull();
    await act(async () => void fireEvent.keyDown(window, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(false));
  });

  it("prints the box at the size it has on the sheet, without the handle", async () => {
    await openDemo();
    await selectRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());
    await dragHandleBy(40, 40);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    const onSheet = [scroller("m22")!.style.width, scroller("m22")!.style.height];
    await act(async () => enterPrint());
    // The print view draws the same element: the same box, the matrix at its first row and column.
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="m22"] .result-matrix-scroll');
    expect(printed).not.toBeNull();
    expect([printed!.style.width, printed!.style.height]).toEqual(onSheet);
    expect(printed!.classList.contains("sized")).toBe(true);
    // The handle is chrome: it is in the markup with `no-print`, so the sheet and print agree.
    const printedHandle = document.querySelector('.print-page [data-region-id="m22"] [data-testid=table-resize-handle]');
    expect(printedHandle).not.toBeNull();
    expect(printedHandle!.classList.contains("no-print")).toBe(true);
    await act(async () => leavePrint());
  });
});
