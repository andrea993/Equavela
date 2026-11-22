import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

async function command(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: "Help" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.commandPalette }));
  const search = await screen.findByRole("searchbox", { name: S.commands.search });
  fireEvent.change(search, { target: { value: label } });
  fireEvent.keyDown(search, { key: "Enter" });
}

async function openProject() {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  const dialog = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Drop test" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/drop-test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  await waitFor(() => expect(explorer.querySelector('[data-path="worksheets/main.eqv"]')).not.toBeNull());
  return { backend, explorer };
}

function hitTest(target: Element) {
  const descriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
  return () => descriptor
    ? Object.defineProperty(document, "elementFromPoint", descriptor)
    : Reflect.deleteProperty(document, "elementFromPoint");
}

it("imports native paths into the hovered folder or beside a hovered file", async () => {
  const { backend, explorer } = await openProject();
  const imported = vi.spyOn(backend, "projectImport");
  const folderChild = document.createElement("span");
  const folderRow = explorer.querySelector('[data-path="worksheets"]')!;
  folderRow.append(folderChild);
  let restore = hitTest(folderChild);
  try {
    await act(async () => backend.dropFiles(["/tmp/notes.csv"], { x: 20, y: 20 }));
  } finally { restore(); }
  await waitFor(() => expect(imported).toHaveBeenCalledWith("/work/drop-test", "worksheets", ["/tmp/notes.csv"]));
  await waitFor(() => expect(explorer.querySelector('[data-path="worksheets/notes.csv"]')).not.toBeNull());

  const owner = explorer.querySelector('[data-path="worksheets/main.eqv"]')!;
  const fileChild = owner.querySelector(".tree-name")!;
  restore = hitTest(fileChild);
  try {
    await act(async () => backend.dropFiles(["/tmp/other.txt"], { x: 20, y: 20 }));
  } finally { restore(); }
  await waitFor(() => expect(imported).toHaveBeenLastCalledWith("/work/drop-test", "worksheets", ["/tmp/other.txt"]));
  await waitFor(() => expect(explorer.querySelector('[data-path="worksheets/other.txt"]')).not.toBeNull());
  expect(document.querySelectorAll('[data-kind="image"]')).toHaveLength(0);
});

it("routes root and collapsed rail drops to the root, and leaves outside drops as worksheet images", async () => {
  const { backend, explorer } = await openProject();
  const imported = vi.spyOn(backend, "projectImport");
  let restore = hitTest(explorer.querySelector('[role="tree"]')!);
  try {
    await act(async () => backend.dropFiles(["/tmp/root.csv"], { x: 20, y: 20 }));
  } finally { restore(); }
  await waitFor(() => expect(imported).toHaveBeenLastCalledWith("/work/drop-test", "", ["/tmp/root.csv"]));

  const rootFile = explorer.querySelector('[data-path="root.csv"]')!;
  fireEvent.click(rootFile);
  await waitFor(() => expect(document.querySelector(".file-editor textarea")).not.toBeNull());
  const editor = document.querySelector(".file-editor textarea")!;
  restore = hitTest(editor);
  try {
    await act(async () => backend.dropFiles(["C:\\pics\\figure.svg"], { x: 400, y: 300 }));
  } finally { restore(); }
  expect(document.querySelectorAll('[data-kind="image"]')).toHaveLength(0);
  expect(imported).toHaveBeenCalledTimes(1);

  fireEvent.click((screen.getByRole("tablist", { name: S.documents.label }).querySelector(`[data-path=${JSON.stringify("/work/drop-test/worksheets/main.eqv")}]`) as HTMLElement));
  const worksheet = document.querySelector('[data-testid="worksheet-area"]')!;

  fireEvent.click(screen.getByRole("button", { name: S.project.collapseExplorer }));
  const rail = screen.getByRole("button", { name: S.project.expandExplorer });
  restore = hitTest(rail);
  try {
    await act(async () => backend.dropFiles(["/tmp/rail.csv"], { x: 20, y: 20 }));
  } finally { restore(); }
  await waitFor(() => expect(imported).toHaveBeenLastCalledWith("/work/drop-test", "", ["/tmp/rail.csv"]));

  fireEvent.click(rail);
  restore = hitTest(worksheet);
  try {
    await act(async () => backend.dropFiles(["C:\\pics\\figure.svg"], { x: 400, y: 300 }));
  } finally { restore(); }
  await waitFor(() => expect(document.querySelectorAll('[data-kind="image"]')).toHaveLength(1));
  expect(imported).toHaveBeenCalledTimes(2);
});
