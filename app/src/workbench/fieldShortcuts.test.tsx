// the specification : window commands from the text fields of the chrome.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
vi.mock("../components/TerminalPanel", () => ({ REPL_MIN: 120, REPL_MAX: 600, TerminalPanel: () => <div className="terminal-host"><textarea aria-label="Terminal input" /></div> }));
afterEach(() => { cleanup(); window.localStorage.clear(); });

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
}

const commandSearch = () => screen.findByRole("searchbox", { name: S.commands.search });

it("leaves terminal keys alone and opens command search from Find", async () => {
  await openDemo();
  fireEvent.click(screen.getByRole("button", { name: S.repl.toggle }));
  const input = await screen.findByRole("textbox", { name: "Terminal input" });
  input.focus();
  await act(async () => { fireEvent.keyDown(input, { key: "k", code: "KeyK", ctrlKey: true }); });
  expect(screen.queryByRole("searchbox", { name: S.commands.search })).toBeNull();

  const find = screen.getByRole("searchbox", { name: S.status.find });
  find.focus();
  await act(async () => { fireEvent.keyDown(find, { key: "k", code: "KeyK", ctrlKey: true }); });
  expect(document.activeElement).toBe(await commandSearch());
});

it("leaves the editing keys with the field: Ctrl+Z in the Find field does not undo the worksheet", async () => {
  const backend = createMockBackend({ fast: true });
  const undo = vi.spyOn(backend, "undo");
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  const find = screen.getByRole("searchbox", { name: S.status.find });
  find.focus();
  await act(async () => { fireEvent.keyDown(find, { key: "z", code: "KeyZ", ctrlKey: true }); });
  expect(undo).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(find);
});
