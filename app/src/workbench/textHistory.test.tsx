// the specification : quick-access Undo and Redo use the open text editor's own history.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { $getRoot, $isTextNode, getNearestEditorFromDOMNode } from "lexical";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);
// jsdom has no layout: Lexical measures the caret after an update in the DOM selection.
const box = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
beforeAll(() => {
  Range.prototype.getBoundingClientRect ??= box;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const textOf = (element: HTMLElement) => element.textContent ?? "";

it("undoes and redoes typing in a text region from the quick-access buttons, then returns to the worksheet history", async () => {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("t1")).not.toBeNull());
  fireEvent.pointerDown(region("t1")!, { button: 0 });
  await act(async () => {
    fireEvent.pointerUp(window, { button: 0 });
  });
  const root = await screen.findByTestId("text-editor");
  const editor = getNearestEditorFromDOMNode(root)!;
  const original = textOf(root);

  // A text editor with no history of its own disables Undo: nothing falls through to the worksheet.
  const undo = screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
  const redo = screen.getByRole("button", { name: S.quickAccess.redo }) as HTMLButtonElement;
  expect(undo.disabled).toBe(true);
  expect(undo.title).toBe(S.quickAccess.nothingToUndo);

  await act(async () => {
    editor.update(() => {
      const last = $getRoot().getLastDescendant();
      if ($isTextNode(last)) last.select(last.getTextContentSize(), last.getTextContentSize()).insertText(" TYPED");
    });
  });
  await waitFor(() => expect(textOf(root)).toContain("TYPED"));
  await waitFor(() => expect(undo.disabled).toBe(false));
  expect(undo.title).toBe(S.quickAccess.undoTextEdit);

  fireEvent.click(undo);
  await waitFor(() => expect(textOf(root)).toBe(original));
  expect(region("t1")!.classList.contains("editing")).toBe(true);
  await waitFor(() => expect(redo.disabled).toBe(false));
  expect(redo.title).toBe(S.quickAccess.redoTextEdit);
  expect(undo.disabled).toBe(true);

  fireEvent.click(redo);
  await waitFor(() => expect(textOf(root)).toContain("TYPED"));

  // Leaving commits one worksheet step; the buttons go back to the worksheet history.
  await act(async () => fireEvent.keyDown(root, { key: "Escape", code: "Escape" }));
  await waitFor(() => expect(region("t1")!.classList.contains("editing")).toBe(false));
  await waitFor(() => expect(undo.disabled).toBe(false));
  expect(undo.title).not.toBe(S.quickAccess.undoTextEdit);
  fireEvent.click(undo);
  await waitFor(() => expect(textOf(region("t1")!)).not.toContain("TYPED"));
});
