import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { initialState } from "../editor/model";
import { createMockBackend } from "../mock/mockBackend";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function worksheet(y = 180) {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => { await hook.result.current.actions.create(); });
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x: 120, y }));
  return hook;
}

it("starts math across the crosshair's bar and keeps its top through growth, commit and reopening", async () => {
  const hook = await worksheet();
  await act(async () => { await hook.result.current.actions.beginNew(); });
  expect(hook.result.current.state.editing).toMatchObject({ page: 1, x: 120, y: 171 });
  act(() => hook.result.current.actions.updateEditor(initialState({
    type: "ExprRegion", expr: { type: "Frac", num: { type: "Num", text: "1" }, den: { type: "Num", text: "2" } },
  })));
  expect(hook.result.current.state.editing!.y).toBe(171);
  await act(async () => { expect(await hook.result.current.actions.commitEdit()).toBe(true); });
  const region = hook.result.current.active!.view.regions[0];
  expect(region).toMatchObject({ kind: "math", x: 120, y: 171 });
  expect(hook.result.current.active!.crosshair).toEqual({ page: 1, x: 120, y: 195 });
  await act(async () => { await hook.result.current.actions.beginEdit(region.id, null); });
  expect(hook.result.current.state.editing!.y).toBe(171);
  await act(async () => { await hook.result.current.actions.commitEdit(); });
  expect(hook.result.current.active!.view.regions[0].y).toBe(171);
});

it("advances successive insertions by a line without stacking them at the same position", async () => {
  const hook = await worksheet();
  for (let i = 0; i < 2; i++) {
    await act(async () => { await hook.result.current.actions.beginNew(); });
    act(() => hook.result.current.actions.updateEditor(initialState({ type: "ExprRegion", expr: { type: "Num", text: "2" } })));
    await act(async () => { await hook.result.current.actions.commitEdit(); });
  }
  expect(hook.result.current.active!.view.regions.map(r => r.y)).toEqual([171, 186]);
  expect(hook.result.current.active!.crosshair.y).toBe(210);
});

it("keeps the same anchor and next insertion line when live evaluation creates the region", async () => {
  const hook = await worksheet();
  await act(async () => { await hook.result.current.actions.beginNew(); });
  act(() => hook.result.current.actions.updateEditor(initialState({ type: "Evaluate", expr: { type: "Num", text: "2" }, unit: null })));
  await waitFor(() => expect(hook.result.current.state.editing!.regionId).not.toBeNull());
  expect(hook.result.current.active!.view.regions[0].y).toBe(171);
  expect(hook.result.current.active!.crosshair.y).toBe(195);
  await act(async () => { await hook.result.current.actions.commitEdit(); });
  expect(hook.result.current.active!.view.regions).toHaveLength(1);
  expect(hook.result.current.active!.view.regions[0].y).toBe(171);
});

it("keeps text insertion unchanged and prevents a negative math position at the paper top", async () => {
  const hook = await worksheet(6);
  await act(async () => { await hook.result.current.actions.beginNew(); });
  expect(hook.result.current.state.editing!.y).toBe(0);
  act(() => hook.result.current.actions.updateEditor(initialState({ type: "ExprRegion", expr: { type: "Num", text: "2" } })));
  await act(async () => { await hook.result.current.actions.commitEdit(); });
  expect(hook.result.current.active!.crosshair.y).toBe(21);
  await act(async () => { await hook.result.current.actions.beginNewText(); });
  expect(hook.result.current.state.textEditing!.y).toBe(21);
});

it("commits a new region with the crosshair already where the caller puts it", async () => {
  // Leaving with an arrow passes its crosshair to the commit, which sets it together with closing the
  // editor: in the app a key press renders right after the commit, before the caller goes on, so
  // setting it afterwards showed the crosshair for a frame on the next line.
  const hook = await worksheet();
  await act(async () => { await hook.result.current.actions.beginNew(); });
  act(() => hook.result.current.actions.updateEditor(initialState({ type: "ExprRegion", expr: { type: "Num", text: "2" } })));
  await act(async () => { expect(await hook.result.current.actions.commitEdit({ page: 1, x: 153, y: 180 })).toBe(true); });
  expect(hook.result.current.state.editing).toBeNull();
  expect(hook.result.current.active!.crosshair).toEqual({ page: 1, x: 153, y: 180 });
});
