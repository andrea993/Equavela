// a project has no main worksheet. Opening or creating one opens no worksheet,
// opening restores its last session, and the environment manager needs no particular worksheet.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { useWorkbench } from "./useWorkbench";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function workbench() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  return { backend, hook };
}

it("creates a project without opening a worksheet: the window keeps what it had", async () => {
  const { hook } = await workbench();
  const before = hook.result.current.state.docs.map((doc) => doc.id);
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  expect(hook.result.current.project?.root).toBe("/work/beam");
  expect(hook.result.current.state.docs.map((doc) => doc.id)).toEqual(before);
  expect(hook.result.current.project?.manifest.main_worksheet).toBeUndefined();
});

it("restores the tabs of the project's last session when it opens again", async () => {
  const { hook } = await workbench();
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/beam/worksheets/main.eqv"); });
  await act(async () => { await hook.result.current.actions.openProjectFile("julia/src/Beam.jl", "text"); });
  const sheet = hook.result.current.state.docs.find((doc) => doc.root === "/work/beam/worksheets/main.eqv")!;
  await act(async () => { expect(await hook.result.current.actions.closeProject()).not.toBe(false); });
  expect(hook.result.current.state.docs.some((doc) => doc.id === sheet.id)).toBe(false);
  await act(async () => hook.result.current.actions.loadProject("open", "/work/beam", ""));
  await waitFor(() => expect(hook.result.current.state.docs.some((doc) => doc.root === "/work/beam/worksheets/main.eqv")).toBe(true));
  await waitFor(() => expect(hook.result.current.fileTabs.map((tab) => tab.path)).toEqual(["julia/src/Beam.jl"]));
  // The text tab was in front when the session ended, so it is in front again.
  expect(hook.result.current.activeFile).toBe("/work/beam/julia/src/Beam.jl");
});

it("opens the environment manager through a project worksheet even when none is open", async () => {
  const { backend, hook } = await workbench();
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  await act(async () => { await hook.result.current.actions.openProjectFile("julia/src/Beam.jl", "text"); });
  expect(hook.result.current.activeFile).not.toBeNull();
  await act(async () => hook.result.current.actions.openProjectEnvironment());
  expect(hook.result.current.activeFile).toBeNull();
  expect(hook.result.current.active?.root).toBe("/work/beam/worksheets/main.eqv");
  const environment = await backend.environmentInfo(hook.result.current.active!.id);
  expect(environment.kind).toBe("project");
  expect(hook.result.current.fileTabs).toHaveLength(1);
});
