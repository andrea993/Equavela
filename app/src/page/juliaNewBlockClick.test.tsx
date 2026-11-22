// the specification : a new block's code area takes clicks and typing as Julia.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);

it("keeps the editor of a new block open on a press in its code box, so typing goes to the block", async () => {
  const backend = createMockBackend({ fast: true });
  const setCode = vi.spyOn(backend, "setJuliaCode");
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
  await waitFor(() => expect(screen.getAllByRole("tab", { name: /Untitled/ }).length).toBeGreaterThan(0));
  const ribbon = screen.getByRole("navigation", { name: S.ribbon.label });
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click([...ribbon.querySelectorAll("button")].find((b) => b.textContent?.trim().endsWith("Julia"))!);
  const editor = (await screen.findByTestId("julia-editor")) as HTMLTextAreaElement;
  await waitFor(() => expect(document.activeElement).toBe(editor));
  // A press in the code box beside the (empty) field: the field keeps the keyboard.
  const box = editor.closest(".julia-code-box")!;
  const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => void box.querySelector(".julia-code")!.dispatchEvent(press));
  expect(press.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(editor);
  expect(screen.getByTestId("julia-editor")).toBe(editor);
  fireEvent.change(editor, { target: { value: "x = 1" } });
  fireEvent.blur(editor);
  await waitFor(() => expect(setCode).toHaveBeenCalledWith(expect.any(String), expect.any(String), "x = 1"));
  expect(document.querySelector('[data-region-id="__new"]')).toBeNull();
});

it("draws empty code one line high", () => {
  const css = readFileSync("src/styles/page.css", "utf8");
  expect(css).toMatch(/\.julia-code \{[^}]*min-height: 18px;/);
});
