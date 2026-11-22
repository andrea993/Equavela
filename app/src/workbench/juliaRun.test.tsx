// the specification : Run evaluates a block now, in Manual mode too, without changing it.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { crosshairBeside, LINE_ABOVE_CROSSHAIR_PT } from "../layout/crosshair";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

it("runs an enabled block and recalculates in Manual mode, leaving the block as it was", async () => {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.addRegion("julia"));
  const doc = () => hook.result.current.state.docs.find((d) => d.id === hook.result.current.state.activeId)!;
  const block = () => doc().view.regions.find((r) => r.kind === "julia")!;
  const id = block().id;
  // Enabling a block of an untrusted worksheet asks to trust it first.
  let enabling!: Promise<unknown>;
  act(() => { enabling = hook.result.current.actions.setJulia(id, { playing: true }); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => hook.result.current.actions.answer("trust"));
  await act(async () => { await enabling; });
  expect(block().kind === "julia" && block().block.playing).not.toBe(false);
  await act(async () => hook.result.current.actions.toggleCalcMode());
  expect(hook.result.current.state.calcMode).toBe("manual");

  const run = vi.spyOn(backend, "runRegion");
  const recalculate = vi.spyOn(backend, "recalculate");
  const before = JSON.stringify(block());
  await act(async () => hook.result.current.actions.setJulia(id, { run: true }));
  expect(run).toHaveBeenCalledWith(doc().id, id);
  await waitFor(() => expect(recalculate).toHaveBeenCalled());
  expect(JSON.stringify(block())).toBe(before);
});

async function trustedEnabledJulia() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  await act(async () => hook.result.current.actions.addRegion("julia"));
  const doc = () => hook.result.current.state.docs.find((d) => d.id === hook.result.current.state.activeId)!;
  const source = () => doc().view.regions.filter((r) => r.kind === "julia").at(-1)!;
  let enabling!: Promise<unknown>;
  act(() => { enabling = hook.result.current.actions.setJulia(source().id, { playing: true }); });
  await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
  await act(async () => hook.result.current.actions.answer("trust"));
  await act(async () => { await enabling; });
  return { backend, hook, doc, source };
}

it.each(["auto", "manual"] as const)("runs then inserts one Julia block below the source in %s mode", async (mode) => {
  const { backend, hook, doc, source } = await trustedEnabledJulia();
  const original = source();
  const initialJuliaCount = doc().view.regions.filter((r) => r.kind === "julia").length;
  const add = vi.spyOn(backend, "addRegion");
  hook.result.current.layoutRef.current = [{ id: original.id, page: 1, x: 60, y: 100, w: 80, h: 36 }];
  if (mode === "manual") await act(async () => hook.result.current.actions.toggleCalcMode());

  await act(async () => hook.result.current.actions.setJulia(original.id, { run: true, insertBelow: true }));
  await waitFor(() => expect(doc().view.regions.filter((r) => r.kind === "julia")).toHaveLength(initialJuliaCount + 1));
  expect(add).toHaveBeenLastCalledWith(doc().id, "julia", 1, 60, 138);
  expect(doc().selection).toContain(doc().view.regions.filter((r) => r.kind === "julia").at(-1)!.id);
});

it("inserts below a source on its own page, clamped inside the printable bottom", async () => {
  const { backend, hook, doc, source } = await trustedEnabledJulia();
  const original = source();
  await act(async () => hook.result.current.actions.moveRegions([
    { region_id: original.id, page: 2, x: 60, y: 700 },
  ]));
  const moved = doc().view.regions.find((r) => r.id === original.id)!;
  const rect = { id: moved.id, page: moved.page, x: moved.x, y: moved.y, w: 80, h: 100 };
  hook.result.current.layoutRef.current = [rect];
  const expected = crosshairBeside(doc().view.page, rect, "down");
  const add = vi.spyOn(backend, "addRegion");
  await act(async () => hook.result.current.actions.setJulia(original.id, { run: true, insertBelow: true }));
  expect(add).toHaveBeenLastCalledWith(doc().id, "julia", 2, expected.x, expected.y - LINE_ABOVE_CROSSHAIR_PT);
});

it("does not insert after trust is declined or the code commit fails", async () => {
  const declined = await trustedEnabledJulia();
  const initialJuliaCount = declined.doc().view.regions.filter((r) => r.kind === "julia").length;
  const source = declined.source();
  await act(async () => declined.hook.result.current.actions.untrust());
  declined.hook.result.current.layoutRef.current = [{ id: source.id, page: 1, x: 60, y: 100, w: 80, h: 36 }];
  const deniedRun = vi.spyOn(declined.backend, "runRegion");
  let running!: Promise<unknown>;
  act(() => { running = declined.hook.result.current.actions.setJulia(source.id, { run: true, insertBelow: true }); });
  await waitFor(() => expect(declined.hook.result.current.state.prompt).not.toBeNull());
  await act(async () => declined.hook.result.current.actions.answer("cancel"));
  await act(async () => { await running; });
  expect(deniedRun).not.toHaveBeenCalled();
  expect(declined.doc().view.regions.filter((r) => r.kind === "julia")).toHaveLength(initialJuliaCount);

  const setCode = vi.spyOn(declined.backend, "setJuliaCode").mockRejectedValue(new Error("commit failed"));
  await act(async () => declined.hook.result.current.actions.setJulia(source.id, { code: "x = 2", run: true, insertBelow: true }));
  expect(setCode).toHaveBeenCalled();
  expect(deniedRun).not.toHaveBeenCalled();
  expect(declined.doc().view.regions.filter((r) => r.kind === "julia")).toHaveLength(initialJuliaCount);
});

it("recalculates a normal code edit, while a combined edit and Run asks for one pass", async () => {
  const { backend, hook, source, doc } = await trustedEnabledJulia();
  const recalculate = vi.spyOn(backend, "recalculate");
  await act(async () => hook.result.current.actions.setJulia(source().id, { code: "x = 2" }));
  await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
  recalculate.mockClear();
  await act(async () => hook.result.current.actions.setJulia(source().id, { code: "x = 3", run: true }));
  await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
  expect(doc().view.regions.find((r) => r.id === source().id)?.kind).toBe("julia");
});
