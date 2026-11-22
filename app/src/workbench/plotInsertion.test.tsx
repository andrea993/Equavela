import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createMockBackend } from "../mock/mockBackend";
import { snapToGrid } from "../layout/geometry";
import { useWorkbench } from "./useWorkbench";

afterEach(cleanup);

async function blankWorkbench() {
  const backend = createMockBackend({ fast: true });
  const hook = renderHook(() => useWorkbench(backend));
  await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
  const doc = () => hook.result.current.state.docs.find((d) => d.id === hook.result.current.state.activeId)!;
  return { backend, hook, doc };
}

it("keeps a new default plot inside the right printable edge in page view in one undo step", async () => {
  const { hook, doc } = await blankWorkbench();
  const page = doc().view.page;
  const x = page.width - page.margins.right - 6;
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x, y: 180 }));

  await act(async () => hook.result.current.actions.addRegion("plot"));

  const plot = doc().view.regions.find((region) => region.kind === "plot");
  expect(plot?.kind).toBe("plot");
  if (plot?.kind !== "plot") throw new Error("plot was not inserted");
  expect(plot.x).toBe(page.width - page.margins.right - 360);
  expect(plot.x + plot.plot.size[0]).toBe(page.width - page.margins.right);
  expect(plot.y).toBe(snapToGrid(180));
  expect(doc().view.can_undo).toBe(true);

  await act(async () => hook.result.current.actions.undo());
  expect(doc().view.regions.some((region) => region.kind === "plot")).toBe(false);
});

it("fits a new plot to a narrow printable width without a second undoable edit", async () => {
  const { hook, doc } = await blankWorkbench();
  await act(async () => hook.result.current.actions.setPageSetup(doc().id, {
    ...doc().view.page,
    size: "custom",
    width: 420,
    margins: { ...doc().view.page.margins, left: 40, right: 40 },
  }));
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x: 370, y: 180 }));

  await act(async () => hook.result.current.actions.addRegion("plot"));

  const plot = doc().view.regions.find((region) => region.kind === "plot");
  expect(plot?.kind).toBe("plot");
  if (plot?.kind !== "plot") throw new Error("plot was not inserted");
  expect(plot.x).toBe(40);
  expect(plot.plot.size).toEqual([340, 220]);
  expect(plot.x + plot.plot.size[0]).toBe(380);
  expect(doc().view.can_undo).toBe(true);
  await act(async () => hook.result.current.actions.undo());
  expect(doc().view.regions.some((region) => region.kind === "plot")).toBe(false);
});

it("declines only when the printable width is below the renderer minimum", async () => {
  const { hook, doc } = await blankWorkbench();
  await act(async () => hook.result.current.actions.setPageSetup(doc().id, {
    ...doc().view.page,
    size: "custom",
    width: 260,
    margins: { ...doc().view.page.margins, left: 60, right: 60 },
  }));
  await act(async () => hook.result.current.actions.addRegion("plot"));
  expect(doc().view.regions.some((region) => region.kind === "plot")).toBe(false);
  expect(hook.result.current.state.message).toMatch(/too narrow.*144 pt required/i);
});

it("preserves free x placement in Draft view and leaves other page-view region kinds alone", async () => {
  const { hook, doc } = await blankWorkbench();
  const page = doc().view.page;
  const x = page.width - page.margins.right - 6;
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x, y: 180 }));
  expect(doc().crosshair.x).toBe(x);
  await act(async () => hook.result.current.actions.addRegion("text"));
  const text = doc().view.regions.filter((region) => region.kind === "text").at(-1);
  expect(text?.x).toBe(snapToGrid(x));

  act(() => hook.result.current.actions.setViewMode("draft"));
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x, y: 300 }));
  await act(async () => hook.result.current.actions.addRegion("plot"));
  const plot = doc().view.regions.filter((region) => region.kind === "plot").at(-1);
  expect(plot?.x).toBe(snapToGrid(x));
});

it("starts a plot, table or Julia block that does not fit above the bottom margin on the next page", async () => {
  const { hook, doc } = await blankWorkbench();
  const page = doc().view.page;
  const bottom = page.height - page.margins.bottom;
  for (const kind of ["plot", "table", "julia"] as const) {
    act(() => hook.result.current.actions.setCrosshair({ page: 1, x: 72, y: bottom - 30 }));
    const before = doc().view.regions.length;
    await act(async () => hook.result.current.actions.addRegion(kind));
    const added = doc().view.regions.at(-1)!;
    expect(doc().view.regions.length).toBe(before + 1);
    expect([kind, added.page, added.y]).toEqual([kind, 2, page.margins.top]);
    expect(doc().crosshair.page).toBe(2);
  }
  // one undo step removes the last one
  const count = doc().view.regions.length;
  await act(async () => hook.result.current.actions.undo());
  expect(doc().view.regions.length).toBe(count - 1);
  // a math region is never moved
  act(() => hook.result.current.actions.setCrosshair({ page: 1, x: 72, y: bottom - 6 }));
  await act(async () => hook.result.current.actions.addRegion("math"));
  expect(doc().view.regions.at(-1)!.page).toBe(1);
});
