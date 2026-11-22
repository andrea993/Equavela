// leaving an equation unchanged writes nothing and calculates nothing.
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const key = (k: string, code: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(async () => void fireEvent.keyDown(window, { key: k, code, ...extra }));

async function open(id: string) {
  fireEvent.pointerDown(region(id)!.querySelector("[data-span]")!, { button: 0 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0 }));
  await waitFor(() => expect(region(id)!.classList.contains("editing")).toBe(true));
}

it.each(["m1", "m2", "m3", "m9", "m11"])("leaves %s without an edit when nothing changed", async (id) => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
  const setMath = vi.spyOn(backend, "setMath");
  const recalc = vi.spyOn(backend, "recalculate");
  await open(id);
  // Caret moves, a character typed and deleted again: the math is what it was.
  await key("ArrowLeft", "ArrowLeft");
  await key("ArrowLeft", "ArrowLeft");
  await key("ArrowRight", "ArrowRight");
  await key("Home", "Home");
  await key("End", "End");
  await key("Escape", "Escape");
  await waitFor(() => expect(region(id)!.classList.contains("editing")).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(setMath).not.toHaveBeenCalled();
  expect(recalc).not.toHaveBeenCalled();
});

it.each(["m1", "m3", "m4", "m6", "m9", "m11"])("leaves %s without an edit after typing and deleting a character", async (id) => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
  const setMath = vi.spyOn(backend, "setMath");
  const recalc = vi.spyOn(backend, "recalculate");
  await open(id);
  await key("Home", "Home");
  await key("ArrowRight", "ArrowRight");
  await key("a", "KeyA");
  await key("Backspace", "Backspace");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await key("Escape", "Escape");
  await waitFor(() => expect(region(id)!.classList.contains("editing")).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(setMath.mock.calls.map((call) => JSON.stringify(call[2]).slice(0, 120))).toEqual([]);
  expect(recalc).not.toHaveBeenCalled();
});

it.each(["m1", "m4"])("leaves %s without an edit when the click goes elsewhere", async (id) => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
  const setMath = vi.spyOn(backend, "setMath");
  await open(id);
  const other = id === "m1" ? "m3" : "m1";
  fireEvent.pointerDown(region(other)!.querySelector("[data-span]")!, { button: 0 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0 }));
  await waitFor(() => expect(region(id)!.classList.contains("editing")).toBe(false));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(setMath).not.toHaveBeenCalled();
});
