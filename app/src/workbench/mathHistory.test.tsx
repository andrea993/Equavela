import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);

const cells = (root: ParentNode = document) => root.querySelectorAll<HTMLElement>(".matrix-grid > .cell");

async function insertNewMatrix(rows: number, cols: number) {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  await waitFor(() => expect(document.querySelector('[data-region-id="m4"]')?.getAttribute("data-state")).toBe("value"));
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
  await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.insertMatrix }));
  const dialog = await screen.findByRole("dialog", { name: S.editor.matrixTitle });
  fireEvent.change(within(dialog).getByLabelText(S.editor.rows), { target: { value: String(rows) } });
  fireEvent.change(within(dialog).getByLabelText(S.editor.columns), { target: { value: String(cols) } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.editor.insert }));
  await waitFor(() => expect(cells(document.querySelector('[data-region-id="__new"]')!).length).toBe(rows * cols));
}

async function commitEditor() {
  await act(async () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" }));
}

it("uses math-editor undo and redo for a reopened matrix without changing worksheet history", async () => {
  await insertNewMatrix(3, 3);
  await commitEditor();
  await waitFor(() => expect(document.querySelector('[data-region-id="__new"]')).toBeNull());
  const region = document.querySelector<HTMLElement>("[data-region-id] .matrix-grid")!.closest<HTMLElement>("[data-region-id]")!;
  const regionId = region.dataset.regionId!;

  fireEvent.pointerDown(region.querySelector(".matrix-grid > .cell")!, { button: 0 });
  fireEvent.pointerUp(window, { button: 0 });
  await waitFor(() => expect(region.classList.contains("editing")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.selectMatrixRow }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.deleteMatrixRow }));
  await waitFor(() => expect(cells(region)).toHaveLength(6));

  const undo = screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
  expect(undo.disabled).toBe(false);
  expect(undo.title).toBe(S.quickAccess.undoMathEdit);
  fireEvent.click(undo);
  await waitFor(() => expect(cells(region)).toHaveLength(9));
  expect(document.querySelector(`[data-region-id="${regionId}"]`)).not.toBeNull();

  const redo = screen.getByRole("button", { name: S.quickAccess.redo }) as HTMLButtonElement;
  expect(redo.disabled).toBe(false);
  expect(redo.title).toBe(S.quickAccess.redoMathEdit);
  fireEvent.click(redo);
  await waitFor(() => expect(cells(region)).toHaveLength(6));

  await commitEditor();
  await waitFor(() => expect(region.classList.contains("editing")).toBe(false));
  expect(undo.title).toContain("Edit math");
  fireEvent.click(undo);
  await waitFor(() => expect(cells(region)).toHaveLength(9));
  expect(document.querySelector(`[data-region-id="${regionId}"]`)).not.toBeNull();
});

it("shows local history for a new matrix draft and never undoes worksheet history underneath it", async () => {
  await insertNewMatrix(3, 3);
  const draft = document.querySelector<HTMLElement>('[data-region-id="__new"]')!;
  const undo = screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
  expect(undo.disabled).toBe(false);
  expect(undo.title).toBe(S.quickAccess.undoMathEdit);

  fireEvent.click(undo);
  await waitFor(() => expect(cells(draft)).toHaveLength(0));
  expect(document.querySelector('[data-region-id="__new"]')).not.toBeNull();
  expect(document.querySelectorAll("[data-region-id]").length).toBeGreaterThan(0);

  const redo = screen.getByRole("button", { name: S.quickAccess.redo }) as HTMLButtonElement;
  expect(redo.disabled).toBe(false);
  expect(redo.title).toBe(S.quickAccess.redoMathEdit);
  fireEvent.click(redo);
  await waitFor(() => expect(cells(draft)).toHaveLength(9));
});
