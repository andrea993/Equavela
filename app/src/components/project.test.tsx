import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import type { Backend } from "../backend";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { ProjectTree, projectWorksheetPath, type ProjectTreeActions } from "./ProjectTree";
import { initialState, kernelOf, reducer, type DocState } from "../workbench/useWorkbench";

afterEach(cleanup);

/** a new project opens no worksheet; the tests open its first one from the explorer. */
/** Open project with the folder the native picker returns (`null`: Cancel). */
async function openProjectFolder(backend: Backend, folder: string | null) {
  vi.spyOn(backend, "chooseFolder").mockResolvedValueOnce(folder);
  await command("open project");
}

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

it("shows optional per-file dirty and error status without changing the active or main badges", () => {
  const project = {
    root: "/work/status",
    manifest: {
      format: "equavela-project/1" as const,
      project_id: "status",
      name: "Status",
      worksheets: [{ id: "main-id", path: "worksheets/main.eqv" }],
    },
    worksheet: null,
  };
  const actions: ProjectTreeActions = {
    open: vi.fn(), create: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(),
    import: vi.fn(), reveal: vi.fn(), openFile: vi.fn(), openExternal: vi.fn(),
  };
  const entries = [
    { path: "worksheets", kind: "folder" as const, size: 0 },
    { path: "worksheets/main.eqv", kind: "worksheet" as const, size: 10 },
    { path: "run.jl", kind: "julia" as const, size: 10 },
  ];
  const { rerender } = render(
    <ProjectTree
      project={project}
      entries={entries}
      activeRoot="/work/status/worksheets/main.eqv"
      actions={actions}
      fileStatus={{ "worksheets/main.eqv": { modified: true, missingResources: 1 }, "run.jl": { errors: 3 } }}
    />,
  );

  const activeRow = document.querySelector('[data-path="worksheets/main.eqv"]') as HTMLElement;
  expect(activeRow.getAttribute("aria-current")).toBe("page");
  expect(within(activeRow).getByLabelText(S.project.fileModified).getAttribute("title")).toBe(S.project.fileModified);
  // no worksheet is marked main.
  expect(activeRow.querySelector(".tree-badge")).toBeNull();
  expect(within(activeRow).getByLabelText(S.project.fileMissingResources(1)).textContent).toContain("1");
  const errorRow = document.querySelector('[data-path="run.jl"]') as HTMLElement;
  expect(within(errorRow).getByLabelText(S.project.fileErrors(3)).textContent).toBe("3");

  rerender(<ProjectTree project={project} entries={entries} activeRoot="/work/status/worksheets/main.eqv" actions={actions} />);
  expect(document.querySelector(".tree-dirty")).toBeNull();
  expect(document.querySelector(".tree-error-count")).toBeNull();
  expect((document.querySelector('[data-path="worksheets/main.eqv"]') as HTMLElement).getAttribute("aria-current")).toBe("page");
});

it("undoes a copied environment selection while retaining the copy", async () => {
  const backend = createMockBackend({ fast: true });
  const opened = await backend.openWorksheet("/demo/demo.eqv");
  const before = await backend.environmentInfo(opened.id);
  const copied = await backend.copyEnvironment(opened.id, "/work/copied-environment");
  expect(copied.environment?.directory).toBe("/work/copied-environment");
  expect((await backend.undo(opened.id)).environment?.directory).toBe(before.directory);
  await expect(backend.copyEnvironment(opened.id, "/work/copied-environment")).rejects.toMatchObject({ kind: "environment" });
  expect((await backend.redo(opened.id)).environment?.directory).toBe("/work/copied-environment");
});

async function command(label: string) {
  // The ribbon's search field opens the palette in every ribbon mode.
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.search }));
  const search = await screen.findByRole("searchbox", { name: S.commands.search });
  fireEvent.change(search, { target: { value: label } });
  fireEvent.keyDown(search, { key: "Enter" });
}

it("creates and reopens a project, and reports existing and missing destinations", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  let dialog = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Example" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/example" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  expect(explorer.textContent).toContain("Example");
  const mainRow = () => explorer.querySelector('[data-path="worksheets/main.eqv"]') as HTMLElement;
  await waitFor(() => expect(mainRow()).toBeTruthy());
  fireEvent.click(mainRow());
  await waitFor(() => expect(mainRow().getAttribute("aria-current")).toBe("page"));

  await command("new project");
  dialog = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(dialog).getByLabelText("Project name"), { target: { value: "Again" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/example" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("already exists");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.include }));
  await waitFor(() => expect(document.querySelector(".include-region")).not.toBeNull());
  const tabs = within(screen.getByRole("tablist", { name: S.documents.label })).getAllByRole("tab").length;
  const projectTab = (screen.getByRole("tablist", { name: S.documents.label }).querySelector(`[data-path=${JSON.stringify("/work/example/worksheets/main.eqv")}]`) as HTMLElement);
  expect(projectTab.textContent).toContain("*");

  // Open project goes straight to the folder picker; a failure goes to the message bar.
  await openProjectFolder(backend, "/missing");
  await waitFor(() => expect(document.querySelector(".message-bar")?.textContent ?? "").toContain("not found"));
  expect(screen.queryByRole("dialog", { name: "Open project" })).toBeNull();
  await openProjectFolder(backend, "/work/example");
  expect(within(screen.getByRole("tablist", { name: S.documents.label })).getAllByRole("tab")).toHaveLength(tabs);
  expect((screen.getByRole("tablist", { name: S.documents.label }).querySelector(`[data-path=${JSON.stringify("/work/example/worksheets/main.eqv")}]`) as HTMLElement).textContent).toContain("*");
  expect(document.querySelector(".include-region")).not.toBeNull();
});

it("joins manifest worksheet paths with the project root's own separator", () => {
  expect(projectWorksheetPath("/work/example/", "worksheets/main.eqv")).toBe("/work/example/worksheets/main.eqv");
  expect(projectWorksheetPath("C:\\work\\example", "worksheets/main.eqv")).toBe("C:\\work\\example\\worksheets\\main.eqv");
});

it("offers New and Open project on the empty workspace", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  fireEvent.click(screen.getByRole("button", { name: `${S.documents.close} demo` }));
  // the empty workspace's Open project goes straight to the folder picker; Cancel does nothing.
  const choose = vi.spyOn(backend, "chooseFolder").mockResolvedValueOnce(null);
  fireEvent.click(await screen.findByRole("button", { name: `${S.project.openTitle}…` }));
  await waitFor(() => expect(choose).toHaveBeenCalledWith(S.project.browseProject, undefined));
  expect(screen.queryByRole("dialog", { name: S.project.openTitle })).toBeNull();
  expect(screen.queryByRole("navigation", { name: S.project.explorer })).toBeNull();
});

it("shows the project's images in the tree, sorted case-insensitively", async () => {
  // the tree is read when the project opens.
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  const dialog = await screen.findByRole("dialog", { name: S.project.newTitle });
  fireEvent.change(within(dialog).getByLabelText(S.project.name), { target: { value: "Bridge" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/bridge" } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  await waitFor(() => expect(explorer.querySelector('[data-path="worksheets/main.eqv"]')).toBeTruthy());

  backend.addProjectAsset("/work/bridge", "deck.svg");
  backend.addProjectAsset("/work/bridge", "Beam.png");
  await openProjectFolder(backend, "/work/bridge");
  const row = (path: string) => explorer.querySelector(`[data-path="${path}"]`) as HTMLElement | null;
  await waitFor(() => expect(row("assets")).toBeTruthy());
  fireEvent.click(row("assets") as HTMLElement);
  await waitFor(() => expect(row("assets/images")).toBeTruthy());
  fireEvent.click(row("assets/images") as HTMLElement);
  await waitFor(() => expect(row("assets/images/Beam.png")).toBeTruthy());
  const images = [...explorer.querySelectorAll('[data-path^="assets/images/"]')].map((item) => item.textContent);
  expect(images).toEqual(["Beam.png", "deck.svg"]);
  expect(row("assets/images/Beam.png")?.getAttribute("title")).toBe("/work/bridge/assets/images/Beam.png");
});

it("shows the active worksheet's Julia environment and opens its manager", async () => {
  // the indicator names the kind; the manager reads the environment of the active worksheet.
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  const indicator = await screen.findByTestId("environment-indicator");
  expect(indicator.textContent).toBe(S.environment.indicator.shared);
  fireEvent.click(indicator);
  const manager = await screen.findByRole("dialog", { name: S.environment.title });
  expect((await within(manager).findByTestId("environment-kind")).textContent).toBe(S.environment.kinds.shared);
  expect(within(manager).getByText(S.environment.noPackages)).toBeTruthy();
  fireEvent.keyDown(manager, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: S.environment.title })).toBeNull());

  await command("new project");
  const dialog = await screen.findByRole("dialog", { name: S.project.newTitle });
  fireEvent.change(within(dialog).getByLabelText(S.project.name), { target: { value: "Env" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/env" } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  await openCreatedSheet();
  await waitFor(() => expect(screen.getByTestId("environment-indicator").textContent).toBe(S.environment.indicator.project));
  expect(screen.getByTestId("environment-indicator").getAttribute("title")).toContain("/work/env/julia");
});

it.each(["", "julia", "julia/src"])("offers Load in worksheets for Julia sources in %s", async (folder) => {
  const backend = createMockBackend({ fast: true });
  const root = "/work/Everywhere";
  await backend.newProject(root, "Everywhere", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  await backend.projectCreate(root, folder, "Utilities", "julia");
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await openProjectFolder(backend, root);
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  if (folder === "julia/src") {
    const src = await within(explorer).findByRole("treeitem", { name: /^src/ });
    if (src.getAttribute("aria-expanded") !== "true") fireEvent.click(src);
  }
  fireEvent.click(await within(explorer).findByText("Utilities.jl"));
  // The checkbox above the file; the Code ribbon tab mirrors it.
  const bar = () => document.querySelector(".file-tab .file-bar") as HTMLElement;
  const load = await waitFor(() => within(bar()).getByRole("checkbox", { name: S.juliaModule.load }));
  expect((load as HTMLInputElement).checked).toBe(false);
  fireEvent.click(load);
  await waitFor(() => expect((within(bar()).getByRole("checkbox", { name: S.juliaModule.load }) as HTMLInputElement).checked).toBe(true));
  const ribbon = screen.getByRole("navigation", { name: S.ribbon.label });
  expect((within(ribbon).getByRole("checkbox", { name: S.juliaModule.load }) as HTMLInputElement).checked).toBe(true);
  expect((await backend.openProject(root)).manifest.julia_modules).toContain(`${folder ? `${folder}/` : ""}Utilities.jl`);
});

it("shows the status of the kernel of the active worksheet's environment", () => {
  // one kernel per environment; events name it, the status bar follows the active worksheet.
  let state = initialState("mock");
  state = reducer(state, { type: "kernel", status: { status: "starting" } });
  state = reducer(state, { type: "kernel", status: { status: "busy", environment: "/env/a" } });
  const doc = (environment: DocState["environment"]) => ({ environment }) as DocState;
  expect(kernelOf(state, null)).toEqual({ status: "starting" });
  expect(kernelOf(state, doc({ kind: "override", directory: "/env/a", absolute: false, kernel: "/env/a" }))).toEqual({ status: "busy" });
  expect(kernelOf(state, doc({ kind: "override", directory: "/env/b", absolute: false, kernel: "/env/b" }))).toEqual({ status: "not_started" });
  expect(kernelOf(state, doc({ kind: "shared", directory: "/s", absolute: false, kernel: "/s" }))).toEqual({ status: "starting" });
});

it("packs a project into a .eqvz and extracts it as a new project", async () => {
  //  (the mock has no dialogs: the archive goes next to the project, extraction takes the last one).
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  const dialog = await screen.findByRole("dialog", { name: S.project.newTitle });
  fireEvent.change(within(dialog).getByLabelText(S.project.name), { target: { value: "Packed" } });
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/packed" } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  await openCreatedSheet();
  const message = () => document.querySelector(".message-bar")?.textContent ?? "";

  // Unsaved changes in a project worksheet: nothing is packed.
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.include }));
  await waitFor(() => expect(document.querySelector(".include-region")).not.toBeNull());
  await command("pack project");
  await waitFor(() => expect(message()).toContain(S.project.saveBeforePacking));
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.save }));
  await waitFor(() => expect((screen.getByRole("tablist", { name: S.documents.label }).querySelector(`[data-path=${JSON.stringify("/work/packed/worksheets/main.eqv")}]`) as HTMLElement).textContent).not.toContain("*"));

  await command("pack project");
  await waitFor(() => expect(message()).toContain(S.project.packed("/work/packed.eqvz")));
  await command("pack project");
  await waitFor(() => expect(message()).toContain("already exists"));

  await command("extract project");
  // the extracted project opens with no worksheet; its explorer shows it.
  await waitFor(() => expect(screen.getByRole("navigation", { name: S.project.explorer }).querySelector(".tree-title")?.textContent).toBe("Packed"));
  await waitFor(() => expect(screen.getByRole("navigation", { name: S.project.explorer }).querySelector('[data-path="worksheets"]')).not.toBeNull());
  await command("extract project");
  await waitFor(() => expect(message()).toContain(S.project.extractFailed("")));
});

it("converts the active worksheet to a project that takes its tab", async () => {
  window.localStorage.clear();
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  const tabs = () => screen.getAllByRole("tab").filter((tab) => tab.closest('[aria-label="Open worksheets"]'));
  await waitFor(() => expect(tabs()).toHaveLength(1));
  await command("convert to project");
  const dialog = await screen.findByRole("dialog", { name: S.project.convertTitle });
  const name = within(dialog).getByLabelText(S.project.name) as HTMLInputElement;
  expect(name.value).toBe("demo");
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "relative" } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("absolute");
  fireEvent.change(within(dialog).getByLabelText(S.project.newDirectory), { target: { value: "/work/converted" } });
  fireEvent.click(within(dialog).getByRole("button", { name: S.project.create }));
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  expect(explorer.textContent).toContain("demo");
  await waitFor(() => expect(explorer.querySelector('[data-path="worksheets/demo.eqv"]')).toBeTruthy());
  expect(screen.queryByRole("dialog", { name: S.project.convertTitle })).toBeNull();
  await waitFor(() => expect(tabs()).toHaveLength(1));
  expect(tabs()[0].getAttribute("data-path")).toBe("/work/converted/worksheets/demo.eqv");
  expect(JSON.parse(window.localStorage.getItem("equavela.recentProjects") ?? "[]")).toEqual(["/work/converted"]);

  // A worksheet of a project is refused, and the dialog says why.
  await command("convert to project");
  const again = await screen.findByRole("dialog", { name: S.project.convertTitle });
  fireEvent.change(within(again).getByLabelText(S.project.newDirectory), { target: { value: "/work/other" } });
  fireEvent.click(within(again).getByRole("button", { name: S.project.create }));
  expect((await within(again).findByRole("alert")).textContent).toContain("already belongs");
});

it("adds a missing package from the Problems panel after a confirmation", async () => {
  const backend = createMockBackend({ fast: true });
  const served = backend.openWorksheet.bind(backend);
  let worksheet = "";
  vi.spyOn(backend, "openWorksheet").mockImplementation(async (path) => {
    const opened = await served(path);
    worksheet = opened.id;
    return opened;
  });
  render(<App backend={backend} />);
  await waitFor(() => expect(worksheet).not.toBe(""));
  await screen.findAllByRole("tab");
  const changePackages = vi.spyOn(backend, "changePackages");
  backend.setRegionState(worksheet, "m1", {
    state: "error",
    failure: { kind: "evaluation", message: "package Plots is not installed in the worksheet environment", span: null, blocked_by: null, julia_type: "MissingPackage", package: "Plots" },
  });
  if (screen.getByTestId("panel-toggle").getAttribute("aria-pressed") !== "true") {
    fireEvent.click(screen.getByTestId("panel-toggle"));
  }
  fireEvent.click(screen.getByTestId("panel-tab-problems"));
  const add = await screen.findByRole("button", { name: S.panel.problems.addPackage("Plots") });
  expect(screen.getByRole("button", { name: S.panel.problems.openEnvironment })).toBeTruthy();
  fireEvent.click(add);
  const prompt = await screen.findByRole("alertdialog", { name: S.environment.addTitle });
  expect(prompt.textContent).toContain("Add Plots to");
  fireEvent.click(within(prompt).getByRole("button", { name: S.environment.addPackage }));
  await waitFor(() => expect(changePackages).toHaveBeenCalledWith(worksheet, ["Plots"], false));
});


it("manages the project tree like a code editor's explorer", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  const created = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(created).getByLabelText("Project name"), { target: { value: "Beam design" } });
  fireEvent.change(within(created).getByLabelText(S.project.newDirectory), { target: { value: "/work/beam" } });
  fireEvent.click(within(created).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  const tree = within(explorer).getByRole("tree", { name: "Beam design" });
  const rows = () => within(tree).queryAllByRole("treeitem").map((row) => row.getAttribute("data-path"));
  const row = (path: string) => within(tree).getAllByRole("treeitem").find((item) => item.getAttribute("data-path") === path) as HTMLElement;
  // Top-level folders start open; the active worksheet is marked.
  await waitFor(() => expect(rows()).toEqual(["julia", "julia/src", "julia/Project.toml", "worksheets", "worksheets/main.eqv"]));
  expect(row("worksheets/main.eqv").getAttribute("aria-current")).toBe("page");

  // A folder opens and closes with a click; the keyboard walks the rows.
  fireEvent.click(row("julia/src"));
  await waitFor(() => expect(rows()).toContain("julia/src/BeamDesign.jl"));
  fireEvent.click(row("julia"));
  await waitFor(() => expect(rows()).not.toContain("julia/src"));

  // The header's New folder works in the selected folder, typed in place; Escape cancels.
  fireEvent.click(within(explorer).getByRole("button", { name: S.project.newFolder }));
  let field = within(tree).getByLabelText(S.project.itemName);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(within(tree).queryByLabelText(S.project.itemName)).toBeNull();
  // The context menu of the empty area creates at the root.
  fireEvent.contextMenu(tree);
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: S.project.newFolder }));
  field = within(tree).getByLabelText(S.project.itemName);
  fireEvent.change(field, { target: { value: "data" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(rows()).toContain("data"));

  // New worksheet in a folder, from the context menu: it opens in a tab.
  fireEvent.contextMenu(row("worksheets"));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: S.project.newWorksheet }));
  field = within(tree).getByLabelText(S.project.itemName);
  fireEvent.change(field, { target: { value: "Loads" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(rows()).toContain("worksheets/Loads.eqv"));
  await waitFor(() => expect(screen.getAllByRole("tab").some((t) => t.getAttribute("data-path") === "/work/beam/worksheets/Loads.eqv")).toBe(true));

  // F2 renames in place; a taken name is refused inside the field, which stays.
  fireEvent.click(row("worksheets/Loads.eqv"));
  fireEvent.keyDown(row("worksheets/Loads.eqv"), { key: "F2" });
  field = within(tree).getByLabelText(S.project.itemName);
  expect((field as HTMLInputElement).value).toBe("Loads.eqv");
  fireEvent.change(field, { target: { value: "main.eqv" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect((await within(tree).findByRole("alert")).textContent).toContain("already exists");
  fireEvent.change(within(tree).getByLabelText(S.project.itemName), { target: { value: "Loads v2.eqv" } });
  fireEvent.keyDown(within(tree).getByLabelText(S.project.itemName), { key: "Enter" });
  await waitFor(() => expect(rows()).toContain("worksheets/Loads v2.eqv"));
  await waitFor(() => expect(screen.getAllByRole("tab").some((t) => t.getAttribute("data-path") === "/work/beam/worksheets/Loads v2.eqv")).toBe(true));

  // Delete asks first, then the worksheet leaves the tree and its tab closes.
  fireEvent.keyDown(row("worksheets/Loads v2.eqv"), { key: "Delete" });
  const confirm = await screen.findByRole("alertdialog", { name: S.project.deleteTitle });
  expect(confirm.textContent).toContain("worksheets/Loads v2.eqv");
  fireEvent.click(within(confirm).getByRole("button", { name: S.project.moveToTrash }));
  await waitFor(() => expect(rows()).not.toContain("worksheets/Loads v2.eqv"));
  expect(screen.getAllByRole("tab").some((t) => t.getAttribute("data-path") === "/work/beam/worksheets/Loads v2.eqv")).toBe(false);

  // The last worksheet cannot go; the message bar says why.
  fireEvent.keyDown(row("worksheets/main.eqv"), { key: "Delete" });
  fireEvent.click(within(await screen.findByRole("alertdialog", { name: S.project.deleteTitle })).getByRole("button", { name: S.project.moveToTrash }));
  await waitFor(() => expect(document.body.textContent).toContain("last one"));
  expect(rows()).toContain("worksheets/main.eqv");

  // Dragging a file onto a folder moves it.
  const data = new Map<string, string>();
  const dataTransfer = { types: ["application/x-equavela-path"], setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "", dropEffect: "" };
  if (row("julia").getAttribute("aria-expanded") !== "true") fireEvent.click(row("julia"));
  await waitFor(() => expect(rows()).toContain("julia/src"));
  fireEvent.dragStart(row("julia/src"), { dataTransfer });
  fireEvent.dragOver(row("data"), { dataTransfer });
  fireEvent.drop(row("data"), { dataTransfer });
  await waitFor(() => expect(rows()).not.toContain("julia/src"));
  fireEvent.click(row("data"));
  await waitFor(() => expect(rows()).toContain("data/src"));
});

it("opens text files and images of the tree in their own tabs", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  await command("new project");
  const created = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(created).getByLabelText("Project name"), { target: { value: "Beam" } });
  fireEvent.change(within(created).getByLabelText(S.project.newDirectory), { target: { value: "/work/beam" } });
  fireEvent.click(within(created).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });
  const row = (path: string) => explorer.querySelector(`[data-path="${path}"]`) as HTMLElement;
  await waitFor(() => expect(row("julia/src")).toBeTruthy());
  fireEvent.click(row("julia/src"));
  await waitFor(() => expect(row("julia/src/Beam.jl")).toBeTruthy());

  // A Julia file opens in a text tab beside the worksheets, coloured.
  if (screen.getByTestId("panel-toggle").getAttribute("aria-pressed") !== "true") {
    fireEvent.click(screen.getByTestId("panel-toggle"));
  }
  expect(screen.getByTestId("side-panel")).toBeTruthy();
  fireEvent.click(row("julia/src/Beam.jl"));
  const editor = (await screen.findByRole("textbox", { name: "julia/src/Beam.jl" })) as HTMLTextAreaElement;
  expect(editor.value).toBe("module Beam\n\nend\n");
  expect(document.querySelector(".file-code .jl-keyword")?.textContent).toBe("module");
  const fileTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("data-path") === "/work/beam/julia/src/Beam.jl") as HTMLElement;
  expect(fileTab().getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByTestId("side-panel")).toBeNull();
  await waitFor(() => expect(document.title).toContain("julia/src/Beam.jl"));
  expect(row("julia/src/Beam.jl").getAttribute("aria-current")).toBe("page");
  // the ribbon shows the Code tab instead of the worksheet tabs.
  expect(screen.queryByRole("tab", { name: "Insert" })).toBeNull();
  expect(screen.getByRole("tab", { name: S.code.tab })).toBeTruthy();
  const add = vi.spyOn(backend, "addRegion");
  const calculate = vi.spyOn(backend, "recalculate");
  await command("Insert Julia block");
  expect(add).not.toHaveBeenCalled();
  expect(calculate).not.toHaveBeenCalled();

  // Editing marks it modified; Ctrl+S saves; a project Julia source restarts the kernel.
  fireEvent.change(editor, { target: { value: "module Beam\nf() = 1\nend\n" } });
  expect(fileTab().textContent).toContain("*");
  expect(document.title).toContain("Beam.jl *");
  expect(within(row("julia/src/Beam.jl")).getByLabelText(S.project.fileModified)).toBeTruthy();
  const leavingWithEdits = new Event("beforeunload", { cancelable: true });
  fireEvent(window, leavingWithEdits);
  expect(leavingWithEdits.defaultPrevented).toBe(true);
  const write = vi.spyOn(backend, "projectWriteText");
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  await waitFor(() => expect(write).toHaveBeenCalledWith("/work/beam", "julia/src/Beam.jl", "module Beam\nf() = 1\nend\n", "v1"));
  await waitFor(() => expect(fileTab().textContent).not.toContain("*"));
  expect(within(row("julia/src/Beam.jl")).queryByLabelText(S.project.fileModified)).toBeNull();
  const leavingAfterSave = new Event("beforeunload", { cancelable: true });
  fireEvent(window, leavingAfterSave);
  expect(leavingAfterSave.defaultPrevented).toBe(false);
  expect(document.body.textContent).toContain("kernel restarted");

  // A worksheet tab brings the sheet back; the file tab stays.
  const worksheetTab = screen.getAllByRole("tab").find((tab) => tab.getAttribute("data-path") === "/work/beam/worksheets/main.eqv") as HTMLElement;
  fireEvent.click(worksheetTab);
  await waitFor(() => expect(document.title).not.toContain(".jl"));
  expect(screen.getByTestId("side-panel")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "julia/src/Beam.jl" })).toBeNull();
  fireEvent.click(fileTab());
  const again = (await screen.findByRole("textbox", { name: "julia/src/Beam.jl" })) as HTMLTextAreaElement;

  // Closing a modified file asks; Cancel keeps it.
  fireEvent.change(again, { target: { value: "changed" } });
  fireEvent.keyDown(again, { key: "w", ctrlKey: true });
  const ask = await screen.findByRole("alertdialog", { name: S.confirm.closeTitle });
  fireEvent.click(within(ask).getByRole("button", { name: S.confirm.cancel }));
  expect(fileTab()).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `${S.documents.close} Beam.jl` }));
  fireEvent.click(within(await screen.findByRole("alertdialog", { name: S.confirm.closeTitle })).getByRole("button", { name: S.confirm.discard }));
  await waitFor(() => expect(screen.getAllByRole("tab").some((tab) => tab.getAttribute("data-path") === "/work/beam/julia/src/Beam.jl")).toBe(false));

  // An image opens read-only; another file goes to the system's app on a double click.
  backend.addProjectAsset("/work/beam", "deck.svg");
  await openProjectFolder(backend, "/work/beam");
  await waitFor(() => expect(row("assets")).toBeTruthy());
  fireEvent.click(row("assets"));
  await waitFor(() => expect(row("assets/images")).toBeTruthy());
  fireEvent.click(row("assets/images"));
  await waitFor(() => expect(row("assets/images/deck.svg")).toBeTruthy());
  fireEvent.click(row("assets/images/deck.svg"));
  expect(((await screen.findByRole("img", { name: "assets/images/deck.svg" })) as HTMLImageElement).src).toMatch(/^data:image\/svg\+xml/);
  const external = vi.spyOn(backend, "projectOpenExternal");
  fireEvent.contextMenu(row("julia/Project.toml"));
  fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: S.project.openExternal }));
  await waitFor(() => expect(external).toHaveBeenCalledWith("/work/beam", "julia/Project.toml"));
  backend.seedProjectImageUsage("/work/beam", [{ path: "assets/images/deck.svg", worksheets: ["worksheets/main.eqv"], problem: null }]);
  await command("Image resource usage");
  const usage = await screen.findByRole("dialog", { name: S.project.imageUsageTitle });
  expect(await within(usage).findByText("assets/images/deck.svg")).toBeTruthy();
  fireEvent.click(within(usage).getByRole("button", { name: "worksheets/main.eqv" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: S.project.imageUsageTitle })).toBeNull());
  expect(screen.getByText("worksheets/main.eqv", { selector: ".file-path" })).toBeTruthy();
  const imageTab = screen.getAllByRole("tab").find(tab => tab.getAttribute("data-path") === "/work/beam/assets/images/deck.svg")!;
  fireEvent.click(imageTab);
  await command("Project settings");
  const settings = await screen.findByRole("dialog", { name: S.project.settingsTitle });
  expect(settings.textContent).toContain("/work/beam");
  fireEvent.click(within(settings).getByRole("button", { name: S.project.manageEnvironment }));
  const manager = await screen.findByRole("dialog", { name: S.environment.title });
  // The dialog opens before the environment it describes has been read.
  await waitFor(() => expect(manager.textContent).toContain(S.environment.kinds.project));
  fireEvent.click(within(manager).getByRole("button", { name: S.environment.close }));
  await command("Close project");
  await waitFor(() => expect(screen.queryByRole("navigation", { name: S.project.explorer })).toBeNull());
  expect(screen.queryByRole("img", { name: "assets/images/deck.svg" })).toBeNull();
});

it("saves one file from its bar and the whole project from the title bar", async () => {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await screen.findByRole("button", { name: S.quickAccess.new });
  // Without a project, Save keeps its tooltip and the sheet has no file bar.
  expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.save }).getAttribute("title")).toBe(`${S.quickAccess.save} (Ctrl+S)`);
  expect(document.querySelector(".sheet-frame")).toBeNull();
  await command("new project");
  const created = await screen.findByRole("dialog", { name: "New project" });
  fireEvent.change(within(created).getByLabelText("Project name"), { target: { value: "Beam" } });
  fireEvent.change(within(created).getByLabelText(S.project.newDirectory), { target: { value: "/work/beam" } });
  fireEvent.click(within(created).getByRole("button", { name: "Create" }));
  await openCreatedSheet();
  const explorer = await screen.findByRole("navigation", { name: S.project.explorer });

  // A project worksheet sits under its file bar: path and its own Save, disabled while unchanged.
  const frame = await waitFor(() => {
    const found = document.querySelector(".sheet-frame");
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(frame.querySelector(".file-path")?.textContent).toBe("worksheets/main.eqv");
  expect((within(frame).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.save }).getAttribute("title")).toBe(S.project.saveProject);

  // The worksheet's own Save must leave other modified project files alone.
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.julia }));
  await waitFor(() => expect((within(frame).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(false));

  // Leave a text file modified too, then save only the worksheet from its bar.
  const row = (path: string) => explorer.querySelector(`[data-path="${path}"]`) as HTMLElement;
  await waitFor(() => expect(row("julia/src")).toBeTruthy());
  fireEvent.click(row("julia/src"));
  await waitFor(() => expect(row("julia/src/Beam.jl")).toBeTruthy());
  fireEvent.click(row("julia/src/Beam.jl"));
  const editor = await screen.findByRole("textbox", { name: "julia/src/Beam.jl" });
  fireEvent.change(editor, { target: { value: "module Beam\nend\n" } });
  const write = vi.spyOn(backend, "projectWriteText");
  const saveWorksheet = vi.spyOn(backend, "saveWorksheet");
  const worksheetTab = screen.getAllByRole("tab").find(tab => tab.getAttribute("data-path") === "/work/beam/worksheets/main.eqv") as HTMLElement;
  fireEvent.click(worksheetTab);
  const sheet = document.querySelector(".sheet-frame") as HTMLElement;
  fireEvent.click(within(sheet).getByRole("button", { name: S.project.saveFile }));
  await waitFor(() => expect(saveWorksheet).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((within(sheet).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(true));
  expect(write).not.toHaveBeenCalled();
  expect(within(row("julia/src/Beam.jl")).getByLabelText(S.project.fileModified)).toBeTruthy();

  // Save project includes the remaining modified text tab, even in the background.
  fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.save }));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(document.body.textContent).toContain(S.project.projectSaved(1)));

  // Both Save buttons include an edit not yet committed by leaving the region.
  fireEvent.keyDown(window, { key: "2", code: "Digit2" });
  expect((within(sheet).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(within(sheet).getByRole("button", { name: S.project.saveFile }));
  await waitFor(() => expect(saveWorksheet).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((within(sheet).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.keyDown(window, { key: "3", code: "Digit3" });
  fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.save }));
  await waitFor(() => expect(saveWorksheet).toHaveBeenCalledTimes(3));
  await waitFor(() => expect((within(sheet).getByRole("button", { name: S.project.saveFile }) as HTMLButtonElement).disabled).toBe(true));
});
