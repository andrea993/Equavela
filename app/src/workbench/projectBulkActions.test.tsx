import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function project() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/project", "Project"));
  return { backend, hook };
}

it("sends one batch move and rejects the whole batch when one worksheet is unsaved", async () => {
  const { backend, hook } = await project();
  await act(async () => hook.result.current.actions.createProjectItem("worksheets", "Checks.eqv", "worksheet"));
  await act(async () => hook.result.current.actions.addRegion("plot"));
  const moveMany = vi.spyOn(backend, "projectMoveMany");

  await act(async () => hook.result.current.actions.moveProjectItems(["worksheets/Checks.eqv", "worksheets/main.eqv"], ""));
  expect(moveMany).not.toHaveBeenCalled();
  expect(hook.result.current.projectEntries.map(entry => entry.path)).toContain("worksheets/Checks.eqv");
  expect(hook.result.current.state.message).toContain("Save");

  // Once the edited tab is saved, the same selection is one backend transaction.
  await act(async () => hook.result.current.actions.saveProject());
  await act(async () => hook.result.current.actions.moveProjectItems(["worksheets/Checks.eqv", "worksheets/main.eqv"], ""));
  expect(moveMany).toHaveBeenCalledTimes(1);
  expect(moveMany).toHaveBeenCalledWith("/work/project", ["worksheets/Checks.eqv", "worksheets/main.eqv"], "");
});

it("asks once for bulk delete, sends one batch on confirmation, and sends none on cancel", async () => {
  const { backend, hook } = await project();
  await act(async () => hook.result.current.actions.createProjectItem("", "notes.txt", "folder"));
  const deleteMany = vi.spyOn(backend, "projectDeleteMany");
  const items = [{ path: "notes.txt", folder: true, files: 0 }, { path: "julia/src", folder: true, files: 1 }];

  let deleting!: Promise<void>;
  act(() => { deleting = hook.result.current.actions.deleteProjectItems(items); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  expect(hook.result.current.state.prompt?.title).toContain("selected");
  expect(deleteMany).not.toHaveBeenCalled();
  await act(async () => hook.result.current.actions.answer("cancel"));
  await deleting;
  expect(deleteMany).not.toHaveBeenCalled();

  act(() => { deleting = hook.result.current.actions.deleteProjectItems(items); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => hook.result.current.actions.answer("delete"));
  await deleting;
  expect(deleteMany).toHaveBeenCalledTimes(1);
  expect(deleteMany).toHaveBeenCalledWith("/work/project", ["notes.txt", "julia/src"]);
});

it("opens selected worksheets and project text files in their normal tabs", async () => {
  const { hook } = await project();
  await act(async () => hook.result.current.actions.createProjectItem("worksheets", "Checks.eqv", "worksheet"));
  await act(async () => hook.result.current.actions.openProjectItems(["worksheets/Checks.eqv", "julia/src/Project.jl"]));

  expect(hook.result.current.state.docs.some(doc => doc.root === "/work/project/worksheets/Checks.eqv")).toBe(true);
  expect(hook.result.current.fileTabs.some(tab => tab.path === "julia/src/Project.jl" && tab.kind === "text")).toBe(true);
  expect(hook.result.current.activeFile).toBe("/work/project/julia/src/Project.jl");
});
