// the specification : a double click in the explorer opens once and switches tabs.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));
afterEach(cleanup);

/** a new project opens no worksheet; the tests open its first one from the explorer. */
async function openCreatedSheet() {
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  // Top-level folders start open; a closed one is opened once.
  let opened = false;
  const sheet = await waitFor(() => {
    const row = explorer.querySelector<HTMLElement>('[data-path="worksheets/main.eqv"]');
    if (row) return row;
    const folder = explorer.querySelector<HTMLElement>('[data-path="worksheets"]');
    if (folder && !opened && folder.getAttribute("aria-expanded") === "false") {
      opened = true;
      fireEvent.click(folder, { detail: 1 });
    }
    throw new Error("no main.eqv");
  });
  fireEvent.click(sheet, { detail: 1 });
  await waitFor(() => expect(sheet.getAttribute("aria-current")).toBe("page"));
}

/** A double click as the browser sends it: two clicks with detail 1 and 2, then dblclick. */
function doubleClick(element: HTMLElement) {
  fireEvent.click(element, { detail: 1 });
  fireEvent.click(element, { detail: 2 });
  fireEvent.doubleClick(element, { detail: 2 });
}

it("switches with one click, opens a file once on a double click and keeps a double-clicked folder open", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.search }));
  const search = await screen.findByRole("searchbox", { name: S.commands.search });
  fireEvent.change(search, { target: { value: "new project" } });
  fireEvent.keyDown(search, { key: "Enter" });
  const created = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(created).getByLabelText("Project name"), { target: { value: "Beam" } });
  fireEvent.change(within(created).getByLabelText(S.project.newDirectory), { target: { value: "/work/beam" } });
  fireEvent.click(within(created).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  const row = (path: string) => explorer.querySelector(`[data-path="${path}"]`) as HTMLElement;
  await waitFor(() => expect(row("julia/src")).toBeTruthy());

  // A double-clicked folder ends open, not folded back.
  doubleClick(row("julia/src"));
  await waitFor(() => expect(row("julia/src/Beam.jl")).toBeTruthy());
  expect(row("julia/src").getAttribute("aria-expanded")).toBe("true");

  // A double-clicked file is read once and opens in one tab.
  const read = vi.spyOn(backend, "projectReadText");
  doubleClick(row("julia/src/Beam.jl"));
  await screen.findByRole("textbox", { name: "julia/src/Beam.jl" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole("tab").filter((tab) => tab.getAttribute("data-path") === "/work/beam/julia/src/Beam.jl")).toHaveLength(1);

  // One click on the worksheet that is already the active document brings it back in front of the
  // text tab, without opening it again.
  const sheet = explorer.querySelector<HTMLElement>('[data-path$=".eqv"]')!;
  const openSheet = vi.spyOn(backend, "openWorksheet");
  fireEvent.click(sheet, { detail: 1 });
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "julia/src/Beam.jl" })).toBeNull());
  expect(sheet.getAttribute("aria-current")).toBe("page");
  // One click on the text file brings its tab back, a double click on the worksheet switches again.
  fireEvent.click(row("julia/src/Beam.jl"), { detail: 1 });
  await screen.findByRole("textbox", { name: "julia/src/Beam.jl" });
  doubleClick(sheet);
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "julia/src/Beam.jl" })).toBeNull());
  expect(openSheet).not.toHaveBeenCalled();
});
