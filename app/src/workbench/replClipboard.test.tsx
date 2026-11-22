// Terminal keyboard input belongs to xterm, not worksheet shortcuts.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
vi.mock("../components/TerminalPanel", () => ({ REPL_MIN: 120, REPL_MAX: 600, TerminalPanel: () => <div className="terminal-host"><textarea aria-label="Terminal input" /></div> }));
afterEach(() => { cleanup(); window.localStorage.clear(); });

it("leaves terminal control keys to xterm rather than worksheet or browser shortcuts", async () => {
  const backend = createMockBackend({ fast: true });
  const copy = vi.spyOn(backend, "printMath");
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: S.repl.toggle }));
  const input = screen.getByRole("textbox", { name: "Terminal input" });
  for (const key of ["c", "x", "a", "k", "m", "+", "ArrowUp"]) {
    const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
  }
  expect(copy).not.toHaveBeenCalled();
});
