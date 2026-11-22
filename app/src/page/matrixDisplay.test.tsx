// The Matrix tab on a matrix result, on the mock backend: the demo's
// 15 x 15 matrix `m22` is clipped in its box,
// `m6` is a 3 x 3 matrix and `m13` is
// a scalar with no matrix result at all.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import demo from "../mock/demo.opened.json";
import { createMockBackend } from "../mock/mockBackend";
import type { OpenedWorksheet } from "../equavelaApi";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const indices = (id: string) => region(id)?.querySelector<HTMLElement>(".indexed-matrix") ?? null;
const classic = (id: string) => region(id)?.querySelector<HTMLElement>(".matrix.result-matrix") ?? null;
const scroller = (id: string) => region(id)?.querySelector<HTMLElement>(".result-matrix-scroll") ?? null;
const handle = (id: string) => region(id)?.querySelector<HTMLElement>("[data-testid=table-resize-handle]") ?? null;
const undoButton = () => screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
const redoButton = () => screen.getByRole("button", { name: S.quickAccess.redo }) as HTMLButtonElement;
const matrixTab = () => screen.queryByRole("tab", { name: S.ribbon.tabs.matrix });
const showIndices = () => screen.queryByRole("checkbox", { name: S.ribbon.commands.showIndices }) as HTMLInputElement | null;

async function openDemo() {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m22")).not.toBeNull());
  await waitFor(() => expect(classic("m22")).not.toBeNull());
  return backend;
}

/** Clicks a math region: the press selects it and the release opens its editor (the sheet's click). */
async function clickRegion(id: string) {
  fireEvent.pointerDown(region(id)!, { button: 0, clientX: 200, clientY: 200 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 200, clientY: 200 }));
  await waitFor(() => expect(region(id)?.classList.contains("selected")).toBe(true));
}

/** Selects a math region without opening its editor: Ctrl+click toggles the selection only. */
async function selectOnly(id: string) {
  fireEvent.pointerDown(region(id)!, { button: 0, ctrlKey: true, clientX: 200, clientY: 200 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0, ctrlKey: true, clientX: 200, clientY: 200 }));
  await waitFor(() => expect(region(id)?.classList.contains("selected")).toBe(true));
}

const storedFormat = (backend: ReturnType<typeof createMockBackend>) =>
  vi.mocked(backend.setResultFormat).mock.calls.at(-1)![2] as Record<string, string> | null;
const storedSettings = (backend: ReturnType<typeof createMockBackend>) =>
  vi.mocked(backend.setResultDefaults).mock.calls.at(-1)?.[1] ?? null;
const sizeField = (label: string) => screen.getByRole("textbox", { name: label }) as HTMLInputElement;

describe("the Matrix tab on a result matrix", () => {
  it("opens with a click on a result matrix and carries the display commands only", async () => {
    await openDemo();
    expect(matrixTab()).toBeNull();
    await clickRegion("m22");
    const tab = matrixTab();
    expect(tab).not.toBeNull();
    expect(tab!.getAttribute("aria-selected")).toBe("true");
    expect(tab!.classList.contains("contextual")).toBe(true);
    // The indices are hidden by default.
    expect(showIndices()?.checked).toBe(false);
    // On a result the tab carries no command that edits the matrix the user typed.
    for (const command of [S.ribbon.commands.insertRowAbove, S.ribbon.commands.deleteMatrixRow, S.ribbon.commands.insertMatrix, S.ribbon.commands.clearMatrixCells]) {
      expect(screen.queryByRole("button", { name: command }), command).toBeNull();
    }
  });

  it("stays on the selected matrix result when the editor is closed", async () => {
    await openDemo();
    await selectOnly("m22");
    expect(matrixTab()).not.toBeNull();
    expect(showIndices()?.checked).toBe(false);
  });

  it("is not shown for a result that is not a matrix", async () => {
    await openDemo();
    await clickRegion("m13");
    expect(matrixTab()).toBeNull();
    expect(showIndices()).toBeNull();
  });
});

describe("the indices", () => {
  it("are shown and hidden per region in one undo step, and undo, redo and the default come back", async () => {
    const backend = await openDemo();
    const setResultFormat = vi.spyOn(backend, "setResultFormat");
    await clickRegion("m6");
    expect(indices("m6")).toBeNull();
    // A small matrix keeps its natural size: no box, no handle.
    expect(handle("m6")).toBeNull();

    fireEvent.click(showIndices()!);
    await waitFor(() => expect(indices("m6")).not.toBeNull());
    expect(setResultFormat).toHaveBeenCalled();
    expect(storedFormat(backend)).toEqual({ "format.show-indices": "true" });
    expect(showIndices()?.checked).toBe(true);
    // The matrix itself is unchanged, and no other region shows indices.
    expect(classic("m6")).not.toBeNull();
    expect(indices("m22")).toBeNull();
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Result format"));

    fireEvent.click(undoButton());
    await waitFor(() => expect(indices("m6")).toBeNull());
    expect(showIndices()?.checked).toBe(false);
    fireEvent.click(redoButton());
    await waitFor(() => expect(indices("m6")).not.toBeNull());

    // Hidden again: the default, so the key is removed instead of written.
    fireEvent.click(showIndices()!);
    await waitFor(() => expect(indices("m6")).toBeNull());
    expect(storedFormat(backend)).toBeNull();
  });

  it("draws a large matrix classic, clipped in its box, whatever it stored before", async () => {
    await openDemo();
    // m22 still carries `format.matrix-display: table`: it is ignored.
    expect(region("m22")?.querySelector(".result-table")).toBeNull();
    expect(scroller("m22")).not.toBeNull();
    // Without the old key the drawing is the same.
    const regions = (demo.view.regions as { id: string; format?: unknown }[]).map((r) => (r.id === "m22" ? { ...r, format: undefined } : r));
    const opened = { ...demo, view: { ...demo.view, regions } } as unknown as OpenedWorksheet;
    cleanup();
    render(<App backend={createMockBackend({ fast: true, opened })} />);
    await waitFor(() => expect(classic("m22")).not.toBeNull());
    expect(scroller("m22")).not.toBeNull();
  });
});

describe("the command palette entry", () => {
  it("toggles the indices of the selected matrix result", async () => {
    await openDemo();
    await selectOnly("m22");
    expect(indices("m22")).toBeNull();
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: "show indices" } });
    await act(async () => void fireEvent.keyDown(dialog, { key: "Enter" }));
    await waitFor(() => expect(indices("m22")).not.toBeNull());
    expect(document.querySelector(".message-bar")).toBeNull();
  });

  it("is not listed when there is no matrix result to act on", async () => {
    await openDemo();
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: "show indices" } });
    expect(within(dialog).queryByText("Matrix: show indices")).toBeNull();
  });
});

describe("the box of a large classic matrix", () => {
  it("is clipped in its box and resizes with the corner handle", async () => {
    const backend = await openDemo();
    vi.spyOn(backend, "setResultFormat");
    await clickRegion("m22");
    expect(scroller("m22")).not.toBeNull();
    expect(handle("m22")).not.toBeNull();
    fireEvent.pointerDown(handle("m22")!, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 540, clientY: 440 }));
    const during = [scroller("m22")!.style.width, scroller("m22")!.style.height];
    expect(during[0]).not.toBe("");
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    await waitFor(() => expect(scroller("m22")!.classList.contains("sized")).toBe(true));
    // The box is one key per region, beside what the override already carries.
    expect(storedFormat(backend)!["result-table-size"]).toMatch(/^\d+(\.\d+)?,\d+(\.\d+)?$/);
    expect([scroller("m22")!.style.width, scroller("m22")!.style.height]).toEqual(during);
  });

  it("draws the same box in print, without the handle (WYSIWYG)", async () => {
    const { enterPrint, leavePrint } = await import("../print/printMode");
    await openDemo();
    await clickRegion("m22");
    await waitFor(() => expect(handle("m22")).not.toBeNull());
    fireEvent.pointerDown(handle("m22")!, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 540, clientY: 440 }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 540, clientY: 440 }));
    const onSheet = [scroller("m22")!.style.width, scroller("m22")!.style.height];
    await act(async () => enterPrint());
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="m22"] .result-matrix-scroll');
    expect(printed).not.toBeNull();
    expect([printed!.style.width, printed!.style.height]).toEqual(onSheet);
    expect(printed!.classList.contains("sized")).toBe(true);
    const printedHandle = document.querySelector('.print-page [data-region-id="m22"] [data-testid=table-resize-handle]');
    expect(printedHandle).not.toBeNull();
    expect(printedHandle!.classList.contains("no-print")).toBe(true);
    await act(async () => leavePrint());
  });
});

describe("the size box of the Display group", () => {
  /** Types a threshold into one field and commits it: Enter and leaving the field both do. */
  async function typeSize(label: string, value: string) {
    fireEvent.change(sizeField(label), { target: { value } });
    fireEvent.blur(sizeField(label));
    await waitFor(() => expect(sizeField(label).value).toBe(value));
  }

  it("writes the worksheet threshold, one undo step per field, and redraws without recalculating", async () => {
    const backend = await openDemo();
    const setResultDefaults = vi.spyOn(backend, "setResultDefaults");
    await clickRegion("m22");
    // The threshold says which matrix is large and boxed.
    await waitFor(() => expect(scroller("m22")).not.toBeNull());
    const recalculate = vi.spyOn(backend, "recalculate");
    // The box shows the threshold the sheet is drawn with: the built-in 12 by 12.
    expect(sizeField(S.matrixSize.rows).value).toBe("12");
    expect(sizeField(S.matrixSize.columns).value).toBe("12");

    // 20 rows: the 15 columns still pass the 12 of the columns field, so it stays large and boxed.
    await typeSize(S.matrixSize.rows, "20");
    await waitFor(() => expect(storedSettings(backend)).toEqual({ "format.matrix-size": "20,12" }));
    expect(scroller("m22")).not.toBeNull();

    // 20 columns too: the 15 x 15 result is no longer large, so it keeps its natural size, no box.
    await typeSize(S.matrixSize.columns, "20");
    await waitFor(() => expect(scroller("m22")).toBeNull());
    expect(classic("m22")).not.toBeNull();
    expect(storedSettings(backend)).toEqual({ "format.matrix-size": "20,20" });
    // Display only: the worksheet does not recalculate.
    expect(recalculate).not.toHaveBeenCalled();
    // One undo step per commit, labelled like the worksheet display defaults it uses.
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Worksheet format"));

    // Undo walks the two commits back and then leaves the worksheet at the default with no key.
    fireEvent.click(undoButton());
    await waitFor(() => expect(sizeField(S.matrixSize.columns).value).toBe("12"));
    expect(sizeField(S.matrixSize.rows).value).toBe("20");
    fireEvent.click(undoButton());
    await waitFor(() => expect(scroller("m22")).not.toBeNull());
    expect([sizeField(S.matrixSize.rows).value, sizeField(S.matrixSize.columns).value]).toEqual(["12", "12"]);
    // Two commits, one per field, and nothing else written on the way back.
    expect(setResultDefaults).toHaveBeenCalledTimes(2);
  });

  it("removes the key when the pair goes back to the built-in 12, 12", async () => {
    const backend = await openDemo();
    const setResultDefaults = vi.spyOn(backend, "setResultDefaults");
    await clickRegion("m22");
    await waitFor(() => expect(scroller("m22")).not.toBeNull());
    await typeSize(S.matrixSize.rows, "16");
    await typeSize(S.matrixSize.columns, "16");
    await waitFor(() => expect(scroller("m22")).toBeNull());
    expect(storedSettings(backend)).toEqual({ "format.matrix-size": "16,16" });
    // Back to the default: the key is removed instead of written.
    await typeSize(S.matrixSize.rows, "12");
    await typeSize(S.matrixSize.columns, "12");
    await waitFor(() => expect(storedSettings(backend)).toEqual({ "format.matrix-size": null }));
    await waitFor(() => expect(scroller("m22")).not.toBeNull());
    expect(setResultDefaults).toHaveBeenCalled();
  });

  it("writes nothing for a field the display cannot read", async () => {
    const backend = await openDemo();
    const setResultDefaults = vi.spyOn(backend, "setResultDefaults");
    await clickRegion("m22");
    for (const bad of ["", "0", "2.5", "abc", "-4"]) {
      fireEvent.change(sizeField(S.matrixSize.rows), { target: { value: bad } });
      fireEvent.blur(sizeField(S.matrixSize.rows));
      expect(sizeField(S.matrixSize.rows).value, bad).toBe("12");
    }
    // The value in force typed again is no edit either.
    fireEvent.change(sizeField(S.matrixSize.rows), { target: { value: "12" } });
    fireEvent.blur(sizeField(S.matrixSize.rows));
    expect(setResultDefaults).not.toHaveBeenCalled();
    expect(scroller("m22")).not.toBeNull();
  });
});
