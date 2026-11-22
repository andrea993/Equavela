import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { initialState as editorState } from "../editor/model";
import { get, toEditing, type Node } from "../editor/tree";
import { isLiveEvaluation, useWorkbench } from "./useWorkbench";

afterEach(cleanup);

it("treats optional empty bounds as complete but missing names as incomplete", () => {
  const x: Node = { type: "Ident", name: { segments: [{ text: "x", subscript: false }], label: null } };
  const empty: Node = { type: "Placeholder" };
  const integral: Node = { type: "Integral", var: x, body: x, algorithm: null, bounds: { lo: empty, hi: empty } };
  const symbolic: Node = { type: "Symbolic", expr: integral, keywords: [] };
  expect(isLiveEvaluation(symbolic)).toBe(true);
  expect(isLiveEvaluation({ ...symbolic, expr: { ...integral, var: empty } })).toBe(false);
  expect(isLiveEvaluation({ ...symbolic, expr: { ...integral, bounds: { lo: x, hi: empty } } })).toBe(false);
  expect(isLiveEvaluation({ type: "Define", target: empty, rhs: x, tail: { type: "Eval", unit: null } })).toBe(false);
});

it("leaves a fresh empty integral, then reopens its variable and bound slots", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  const previous = new Set(hook.result.current.active!.view.regions.map(r => r.id));
  await act(async () => { await hook.result.current.actions.beginNew(); });
  const empty: Node = { type: "Placeholder" };
  const root: Node = { type: "ExprRegion", expr: { type: "Integral", var: empty, bounds: { lo: empty, hi: empty }, algorithm: null, body: empty } };
  act(() => hook.result.current.actions.updateEditor(editorState(root)));
  await act(async () => { await hook.result.current.actions.leaveEditing("down"); });
  expect(hook.result.current.state.editing).toBeNull();
  const region = hook.result.current.active!.view.regions.find(r => r.kind === "math" && !previous.has(r.id));
  expect(region).toBeTruthy();
  await act(async () => { await hook.result.current.actions.beginEdit(region!.id, null); });
  const reopened = hook.result.current.state.editing!.editor.root;
  expect(get(reopened, [0, 0]).type).toBe("Placeholder");
  expect(get(reopened, [0, 1]).type).toBe("Placeholder");
  expect(get(reopened, [0, 3]).type).toBe("Placeholder");
  await act(async () => { await hook.result.current.actions.commitEdit(); });
  expect(hook.result.current.state.editing).toBeNull();
});

it("keeps a body click on the body when an indefinite integral gains editing slots", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  const integral = { type: "Integral", var: { name: { segments: [{ text: "x", subscript: false }], label: null } }, bounds: null, algorithm: null, body: { type: "Ident", name: { segments: [{ text: "x", subscript: false }], label: null } } };
  await act(async () => { await hook.result.current.actions.beginEdit("m14", null); });
  act(() => hook.result.current.actions.updateEditor(editorState(toEditing({ type: "Evaluate", expr: integral, unit: null }))));
  await act(async () => { expect(await hook.result.current.actions.commitEdit()).toBe(true); });
  await act(async () => { await hook.result.current.actions.beginEdit("m14", { path: [0, 0], side: "L", caret: null }); });
  expect(hook.result.current.state.editing!.editor.focus).toEqual([0, 2]);
});

it("leaves an empty assignment target and restores its editable placeholder", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  const previous = new Set(hook.result.current.active!.view.regions.map(r => r.id));
  await act(async () => { await hook.result.current.actions.beginNew(); });
  const root: Node = { type: "Define", target: { type: "Placeholder" }, rhs: { type: "Num", text: "2" }, tail: null };
  act(() => hook.result.current.actions.updateEditor(editorState(root)));
  await act(async () => { await hook.result.current.actions.leaveEditing("down"); });
  expect(hook.result.current.state.editing).toBeNull();
  const region = hook.result.current.active!.view.regions.find(r => r.kind === "math" && !previous.has(r.id));
  expect(region).toBeTruthy();
  await act(async () => { await hook.result.current.actions.beginEdit(region!.id, null); });
  expect(get(hook.result.current.state.editing!.editor.root, [0]).type).toBe("Placeholder");
});
