import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { relocated, useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function openProjectText() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.loadProject("new", "/work/beam", "Beam"));
  await act(async () => { await hook.result.current.actions.openProjectWorksheet("/work/beam/worksheets/main.eqv"); });
  await act(async () => hook.result.current.actions.openProjectFile("julia/src/Beam.jl", "text"));
  await waitFor(() => expect(hook.result.current.activeFile).toBe("/work/beam/julia/src/Beam.jl"));
  return hook;
}

it("maps a path through renames and folder moves", () => {
  expect(relocated("a/b.jl", [["a/b.jl", "a/c.jl"]])).toBe("a/c.jl");
  expect(relocated("a/b/c.jl", [["a/b", "x/b"]])).toBe("x/b/c.jl");
  expect(relocated("a/bc.jl", [["a/b", "x/b"]])).toBe("a/bc.jl");
});

it("keeps a text tab open and in front when its file is renamed", async () => {
  const hook = await openProjectText();
  await act(async () => hook.result.current.actions.renameProjectItem("julia/src/Beam.jl", "Girder.jl"));
  const id = "/work/beam/julia/src/Girder.jl";
  expect(hook.result.current.fileTabs.map((tab) => [tab.id, tab.path])).toEqual([[id, "julia/src/Girder.jl"]]);
  expect(hook.result.current.activeFile).toBe(id);
});

it("keeps a text tab open when its folder is moved", async () => {
  const hook = await openProjectText();
  await act(async () => hook.result.current.actions.moveProjectItem("julia/src", "julia/lib"));
  expect(hook.result.current.fileTabs.map((tab) => tab.path)).toEqual(["julia/lib/src/Beam.jl"]);
  expect(hook.result.current.activeFile).toBe("/work/beam/julia/lib/src/Beam.jl");
});
