import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
vi.mock("../components/TerminalPanel", () => ({
  REPL_MIN: 120, REPL_MAX: 600,
  TerminalPanel: ({ height }: { height: number }) => <div data-testid="terminal" data-height={height} />,
}));
afterEach(() => { cleanup(); window.localStorage.clear(); });

it("starts hidden even with an old persisted open state, and opens at the saved height", async () => {
  window.localStorage.setItem("equavela.repl", JSON.stringify({ open: true, height: 310 }));
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(document.querySelector('[data-region-id="m1"]')).not.toBeNull());
  expect(screen.queryByTestId("terminal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: S.repl.toggle }));
  expect(screen.getByTestId("terminal").getAttribute("data-height")).toBe("310");
});
