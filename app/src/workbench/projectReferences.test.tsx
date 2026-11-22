// the specification in the workbench and the explorer.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectTree } from "../components/ProjectTree";
import type { OpenedProject, ProjectReferences } from "../equavelaApi";
import { createMockBackend } from "../mock/mockBackend";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function twoProjects() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/Thermo", "Thermo"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/Thermo/worksheets/main.eqv"); });
  await act(async () => hook.result.current.actions.setProjectExport("worksheets/main.eqv", "cp", true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/Consumer", "Consumer"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/Consumer/worksheets/main.eqv"); });
  return { backend, hook };
}

it("exports a definition and lists it with the project's references", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/Thermo", "Thermo"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/Thermo/worksheets/main.eqv"); });
  await waitFor(() => expect(hook.result.current.projectReferences).not.toBeNull());
  expect(hook.result.current.projectReferences?.exports).toEqual([]);

  await act(async () => hook.result.current.actions.setProjectExport("worksheets/main.eqv", "cp", true));
  await waitFor(() => expect(hook.result.current.projectReferences?.exports.map((e) => e.region)).toEqual(["cp"]));
  expect(hook.result.current.project?.manifest.exports?.length).toBe(1);

  await act(async () => hook.result.current.actions.setProjectExport("worksheets/main.eqv", "cp", false));
  await waitFor(() => expect(hook.result.current.projectReferences?.exports).toEqual([]));
});

it("adds a reference with its locked API, and asks before trusting or removing it", async () => {
  const { backend, hook } = await twoProjects();
  await act(async () => hook.result.current.actions.addProjectReference("/work/Thermo"));
  await waitFor(() => expect(hook.result.current.projectReferences?.references.length).toBe(1));
  const reference = hook.result.current.projectReferences!.references[0];
  expect(reference.alias).toBe("Thermo");
  expect(reference.api.map((entry) => entry.name)).toEqual(["cp"]);
  expect(reference.trusted).toBe(false);

  const command = vi.spyOn(backend, "projectReferenceCommand");
  let running!: Promise<void>;
  act(() => { running = hook.result.current.actions.projectReferenceCommand("trust", "Thermo"); });
  await waitFor(() => expect(hook.result.current.state.prompt?.title).toBe("Trust referenced project"));
  await act(async () => hook.result.current.actions.answer("cancel"));
  await running;
  expect(command).not.toHaveBeenCalled();

  act(() => { running = hook.result.current.actions.projectReferenceCommand("trust", "Thermo"); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => hook.result.current.actions.answer("go"));
  await running;
  await waitFor(() => expect(hook.result.current.projectReferences?.references[0].trusted).toBe(true));

  // Rename needs no confirmation; a bad alias reaches the message bar.
  await act(async () => hook.result.current.actions.projectReferenceCommand("rename", "Thermo", "julia"));
  expect(hook.result.current.state.message).toContain("not a valid alias");
  await act(async () => hook.result.current.actions.projectReferenceCommand("rename", "Thermo", "Th"));
  await waitFor(() => expect(hook.result.current.projectReferences?.references[0].alias).toBe("Th"));

  act(() => { running = hook.result.current.actions.projectReferenceCommand("remove", "Th"); });
  await waitFor(() => expect(hook.result.current.state.prompt?.title).toBe("Remove reference"));
  await act(async () => hook.result.current.actions.answer("go"));
  await running;
  await waitFor(() => expect(hook.result.current.projectReferences?.references).toEqual([]));
});

const consumer: OpenedProject = {
  root: "/work/Consumer",
  manifest: {
    format: "equavela-project/1",
    project_id: "22222222-2222-4222-8222-222222222222",
    name: "Consumer",
    worksheets: [{ id: "22222222-2222-4222-8222-2222222222aa", path: "worksheets/main.eqv" }],
    main_worksheet: "22222222-2222-4222-8222-2222222222aa",
  },
  worksheet: {} as OpenedProject["worksheet"],
};

const references: ProjectReferences = {
  exports: [],
  references: [
    {
      alias: "Thermo",
      path: "../Thermo",
      project_id: "11111111-1111-4111-8111-111111111111",
      name: "Thermodynamics",
      root: "/work/Thermo",
      api: [{ id: "a", name: "c_p", kind: "function", arity: 2 }, { id: "b", name: "ρ", kind: "value" }],
      current: [],
      problem: null,
      out_of_date: true,
      trusted: false,
      package: "Thermodynamics",
      developed: false,
    },
    {
      alias: "Steam",
      path: "../Steam",
      project_id: "33333333-3333-4333-8333-333333333333",
      name: null,
      root: null,
      api: [],
      current: [],
      problem: "the project folder `../Steam` was not found",
      out_of_date: false,
      trusted: false,
      package: null,
      developed: false,
    },
  ],
};

it("shows each reference with its status and its exports under the alias", async () => {
  const referenceCommand = vi.fn(async () => undefined);
  const openReferencedProject = vi.fn();
  const developReferencePackage = vi.fn();
  render(<ProjectTree
    project={consumer}
    entries={[]}
    activeRoot={null}
    references={references}
    actions={{
      open: vi.fn(), create: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(), import: vi.fn(), reveal: vi.fn(), openFile: vi.fn(), openExternal: vi.fn(), addReference: vi.fn(), referenceCommand, openReferencedProject,
      developReferencePackage,
    }}
  />);
  const section = screen.getByRole("region", { name: "References" });
  const thermo = within(section).getByText("Thermo").closest("[data-reference]") as HTMLElement;
  expect(thermo.textContent).toContain("Thermodynamics");
  expect(within(thermo).getByTitle("API out of date: update the reference")).toBeTruthy();
  const steam = within(section).getByText("Steam").closest("[data-reference]") as HTMLElement;
  expect(steam.className).toContain("missing");

  fireEvent.click(thermo);
  expect(within(section).getByText("Thermo.c_p(·, ·)")).toBeTruthy();
  expect(within(section).getByText("Thermo.ρ")).toBeTruthy();

  fireEvent.contextMenu(thermo);
  fireEvent.click(screen.getByRole("menuitem", { name: "Update reference" }));
  expect(referenceCommand).toHaveBeenCalledWith("update", "Thermo", undefined);
  fireEvent.contextMenu(thermo);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open project" }));
  expect(openReferencedProject).toHaveBeenCalledWith("/work/Thermo");
  fireEvent.contextMenu(thermo);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add its Julia package Thermodynamics" }));
  expect(developReferencePackage).toHaveBeenCalledWith("Thermo", "Thermodynamics");

  // An unavailable project can be removed or renamed, not updated, trusted or developed.
  fireEvent.contextMenu(steam);
  expect(screen.queryByRole("menuitem", { name: /Add its Julia package/ })).toBeNull();
  expect((screen.getByRole("menuitem", { name: "Update reference" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "Trust its Julia code" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename alias" }));
  const field = screen.getByRole("textbox");
  fireEvent.change(field, { target: { value: "Vapour" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(referenceCommand).toHaveBeenCalledWith("rename", "Steam", "Vapour"));
});

it("develops the referenced project's Julia package after asking", async () => {
  const { backend, hook } = await twoProjects();
  await act(async () => hook.result.current.actions.addProjectReference("/work/Thermo"));
  await waitFor(() => expect(hook.result.current.projectReferences?.references[0]?.package).toBe("Thermo"));
  expect(hook.result.current.projectReferences!.references[0].developed).toBe(false);
  const develop = vi.spyOn(backend, "developReferencePackage");
  let running!: Promise<void>;
  act(() => { running = hook.result.current.actions.developReferencePackage("Thermo", "Thermo"); });
  await waitFor(() => expect(hook.result.current.state.prompt?.title).toBe("Add referenced Julia package"));
  await act(async () => hook.result.current.actions.answer("go"));
  await running;
  expect(develop).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(hook.result.current.projectReferences?.references[0].developed).toBe(true));
});

it("refreshing references leaves the project's worksheets saved", async () => {
  const { backend, hook } = await twoProjects();
  const id = hook.result.current.state.activeId!;
  const result = await backend.setWorksheetTrusted(id, false);
  vi.spyOn(backend, "projectReferenceCommand").mockResolvedValue({ manifest: hook.result.current.project!.manifest, worksheets: [{ id, result }] });
  await act(async () => hook.result.current.actions.projectReferenceCommand("reload"));
  const doc = hook.result.current.state.docs.find((item) => item.id === id)!;
  expect(doc.edits).toBe(doc.savedEdits);
});

it("Load in worksheets lists a project .jl file in the manifest", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/Thermo", "Thermo"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/Thermo/worksheets/main.eqv"); });
  await act(async () => hook.result.current.actions.setJuliaModule("julia/src/Thermo.jl", true));
  expect(hook.result.current.project?.manifest.julia_modules).toEqual(["julia/src/Thermo.jl"]);
  await act(async () => hook.result.current.actions.setJuliaModule("julia/src/Thermo.jl", false));
  expect(hook.result.current.project?.manifest.julia_modules).toEqual([]);
});
