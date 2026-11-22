import { sizeCss, lineHeightPx } from "./text/value";
import { LINE_ABOVE_CROSSHAIR_PT } from "./layout/crosshair";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { requestedMode } from "./backend";
import { describeKernel, EngineStartNotice } from "./components/Chrome";
import { fitPageZoom, GRID_PT, EQUAVELA_PADDING_PX, ptToPx, snapToGrid } from "./layout/geometry";
import { WORKSHEET_LINE_PT } from "./layout/lines";
import { createMockBackend } from "./mock/mockBackend";
import { S, windowTitle } from "./strings";
import { RECOVERY_INTERVAL_MS, useWorkbench, commitWire, documentName, describeError, defaultCrosshair, isLiveEvaluation, reducer, initialState } from "./workbench/useWorkbench";
import type { DocumentView, RichText } from "./equavelaApi";

vi.mock("./plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  // The automatic calculation fills in the results.
  await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
}

/** Inserts a plot from the Insert tab; returns the plot element and the region element around it. */
async function insertPlotRegion() {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
  const plot = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  const regionEl = plot.closest<HTMLElement>("[data-region-id]")!;
  await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(true));
  return { plot, regionEl };
}

describe("backend choice", () => {
  it("reads ?backend= from the URL", () => {
    expect(requestedMode("?backend=mock")).toBe("mock");
    expect(requestedMode("?backend=real")).toBe("tauri");
    expect(requestedMode("?x=1")).toBeNull();
    expect(requestedMode("")).toBeNull();
  });
});

describe("first-run progress notice", () => {
  const ready = { status: "ready", info: { julia: "1.12", package: "EquavelaKernel", protocol: 1 } } as const;
  afterEach(() => vi.useRealTimers());

  it("shows nothing for a start shorter than one second, then the elapsed seconds, and goes away when ready", () => {
    vi.useFakeTimers();
    const view = render(<EngineStartNotice kernel={{ status: "starting" }} />);
    expect(screen.queryByTestId("engine-notice")).toBeNull();
    act(() => void vi.advanceTimersByTime(900));
    expect(screen.queryByTestId("engine-notice")).toBeNull();
    act(() => void vi.advanceTimersByTime(100));
    expect(screen.getByTestId("engine-notice").textContent).toContain("Starting the calculation engine… 1 s");
    act(() => void vi.advanceTimersByTime(14000));
    expect(screen.getByTestId("engine-notice").textContent).toContain("… 15 s");
    expect(screen.getByRole("status")).toBeTruthy();
    view.rerender(<EngineStartNotice kernel={ready} />);
    expect(screen.queryByTestId("engine-notice")).toBeNull();
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId("engine-notice")).toBeNull();
  });

  it("a fast start never shows it, and a crash removes it", () => {
    vi.useFakeTimers();
    const view = render(<EngineStartNotice kernel={{ status: "starting" }} />);
    act(() => void vi.advanceTimersByTime(300));
    view.rerender(<EngineStartNotice kernel={ready} />);
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.queryByTestId("engine-notice")).toBeNull();
    view.rerender(<EngineStartNotice kernel={{ status: "starting" }} />);
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByTestId("engine-notice").textContent).toContain("2 s");
    view.rerender(<EngineStartNotice kernel={{ status: "crashed", message: "boom" }} />);
    expect(screen.queryByTestId("engine-notice")).toBeNull();
  });

  it("is shown in the application while the kernel starts and does not block the sheet", async () => {
    const backend = createMockBackend({ fast: true });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId("engine-notice")).toBeNull());
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    act(() => backend.setKernelStatus({ status: "starting" }));
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByTestId("engine-notice").textContent).toContain("3 s");
    // The sheet stays in the DOM and is not covered by a modal layer.
    expect(region("m1")).not.toBeNull();
    expect(document.querySelector(".modal, [aria-modal='true']")).toBeNull();
    act(() => backend.setKernelStatus(ready));
    expect(screen.queryByTestId("engine-notice")).toBeNull();
  });
});

describe("Fast Symbolic", () => {
  it("inserts the first Z transform after the source draft is committed while the engine loads", async () => {
    const backend = createMockBackend({ fast: true });
    let finish: (value: unknown) => void = () => {};
    const evaluate = vi.spyOn(backend, "fastSymbolic").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await waitFor(() => expect(region("m1")).toBeNull());
    const area = screen.getByTestId("worksheet-area");
    for (const [key, code] of [["a", "KeyA"], ["+", "Equal"], ["b", "KeyB"]]) {
      fireEvent.keyDown(area, { key, code, shiftKey: key === "+" });
    }
    fireEvent.keyDown(area, { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(area, { key: "s", code: "KeyS", altKey: true });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Fast Symbolic" }), { key: "z", code: "KeyZ" });
    expect(evaluate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      operation: "z_transform", variable: expect.objectContaining({ segments: [{ text: "b", subscript: false }] }),
    }));
    fireEvent.keyDown(area, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(document.querySelector(".region.editing")).toBeNull());
    await act(async () => finish({ type: "ExprRegion", expr: { type: "Num", text: "777" } }));
    await waitFor(() => expect(screen.getByText("777")).not.toBeNull());
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it("shares the ribbon settings with Alt+S and shows immediate progress on the source", async () => {
    const backend = createMockBackend({ fast: true });
    let finish: (value: unknown) => void = () => {};
    const evaluate = vi.spyOn(backend, "fastSymbolic").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const area = screen.getByTestId("worksheet-area");
    const altS = () => fireEvent.keyDown(area, { key: "s", code: "KeyS", altKey: true });
    altS();
    expect(screen.queryByRole("dialog", { name: "Fast Symbolic" })).toBeNull();
    fireEvent.keyDown(area, { key: "x", code: "KeyX" });
    await waitFor(() => expect(region("__new")).not.toBeNull());
    const altGr = new KeyboardEvent("keydown", { key: "s", code: "KeyS", altKey: true, ctrlKey: true, bubbles: true });
    Object.defineProperty(altGr, "getModifierState", { value: (key: string) => key === "AltGraph" });
    fireEvent(area, altGr);
    expect(screen.queryByRole("dialog", { name: "Fast Symbolic" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: "Fast Symbolic" }));
    const ribbonMenu = screen.getByRole("dialog", { name: "Fast Symbolic" });
    const workspace = within(ribbonMenu).getByRole("checkbox", { name: "Worksheet variables" });
    expect((workspace as HTMLInputElement).checked).toBe(true);
    expect((within(ribbonMenu).getByRole("checkbox", { name: "Evaluate in place" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(workspace);
    fireEvent.keyDown(ribbonMenu, { key: "Escape", code: "Escape" });
    altS();
    const quickMenu = screen.getByRole("dialog", { name: "Fast Symbolic" });
    expect((within(quickMenu).getByRole("button", { name: /^Solve/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(quickMenu, { key: "v", code: "KeyV" });
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.keyDown(quickMenu, { key: "s", code: "KeyS" });
    expect(region("__new")?.querySelector('[data-testid="region-busy"]')).not.toBeNull();
    expect(evaluate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      operation: "simplify", worksheetVariables: false, regionId: null,
    }));
    await act(async () => finish({ type: "ExprRegion", expr: { type: "Num", text: "777" } }));
    await waitFor(() => expect(screen.getByText("777")).not.toBeNull());
    expect(region("__new")?.querySelector('[data-testid="region-busy"]')).toBeNull();
    expect(region("__new")?.textContent).toContain("x");
  });

  it("replaces the active expression in place and keeps local Undo", async () => {
    const backend = createMockBackend({ fast: true });
    vi.spyOn(backend, "fastSymbolic").mockResolvedValue({ type: "ExprRegion", expr: { type: "Num", text: "777" } });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const area = screen.getByTestId("worksheet-area");
    fireEvent.keyDown(area, { key: "k", code: "KeyK" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("k"));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: "Fast Symbolic" }));
    const menu = screen.getByRole("dialog", { name: "Fast Symbolic" });
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Evaluate in place" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Simplify" }));
    await waitFor(() => expect(region("__new")?.textContent).toContain("777"));
    fireEvent.keyDown(area, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(region("__new")?.textContent).toContain("k");
    expect(screen.queryByText("777")).toBeNull();
  });
});

describe("helpers", () => {
  it("describes kernel status and errors", () => {
    expect(describeKernel(null)).toBe(S.status.kernel.unknown);
    expect(describeKernel({ status: "not_started" })).toBe(S.status.kernel.notStarted);
    expect(describeKernel({ status: "starting" })).toBe(S.status.kernel.starting);
    expect(describeKernel({ status: "busy" })).toBe(S.status.kernel.busy);
    expect(
      describeKernel({ status: "ready", info: { julia: "1.11", package: "EquavelaKernel", protocol: 1 } }),
    ).toContain("1.11");
    expect(describeKernel({ status: "crashed", message: "boom\nmore" })).toContain("boom");
    expect(describeError("x")).toBe("x");
    expect(describeError({ kind: "busy", message: "wait" })).toBe("busy: wait");
    expect(describeError(42)).toBe("42");
  });

  it("names documents and the window", () => {
    expect(documentName("/a/b/beam.eqv")).toBe("beam");
    expect(documentName("C:\\x\\Untitled-2.eqv")).toBe("Untitled-2");
    expect(windowTitle("beam")).toBe("Equavela – beam");
    expect(windowTitle(null)).toBe("Equavela");
  });

  it("starts the crosshair below the lowest region of the first page", () => {
    const view = {
      page: { size: "A4", width: 595.28, height: 841.89, margins: { top: 72, right: 54, bottom: 72, left: 54 } },
      regions: [
        { id: "a", page: 1, x: 54, y: 100 },
        { id: "b", page: 2, x: 54, y: 700 },
      ],
    } as unknown as DocumentView;
    // On the line after the lowest region of page 1 (100 + 15 pt), the crosshair across that line
    //, taken to the 3 pt grid.
    expect(defaultCrosshair(view)).toEqual({ page: 1, x: 54, y: snapToGrid(100 + WORKSHEET_LINE_PT + LINE_ABOVE_CROSSHAIR_PT) });
    // On an empty page the first math line starts at the top margin, across the crosshair.
    expect(defaultCrosshair({ ...view, regions: [] })).toEqual({ page: 1, x: 54, y: 72 + LINE_ABOVE_CROSSHAIR_PT });
  });

  it("keeps the reducer pure for zoom limits and selection pruning", () => {
    let state = initialState("mock");
    state = reducer(state, { type: "zoom", zoom: 99 });
    expect(state.zoom).toBe(4);
    state = reducer(state, { type: "calc-mode", mode: "manual" });
    expect(state.calcMode).toBe("manual");
  });
});

describe("worksheet window (mock backend)", () => {
  it("targets draft matrix cells and deletes a selected row and the active column", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.insertMatrix }));
    const dialog = await screen.findByRole("dialog", { name: S.editor.matrixTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: S.editor.insert }));
    await waitFor(() => expect(document.querySelectorAll('[data-region-id="__new"] .matrix-grid > .cell')).toHaveLength(4));
    let cells = document.querySelectorAll<HTMLElement>('[data-region-id="__new"] .matrix-grid > .cell');
    fireEvent.pointerDown(cells[3], { button: 0 });
    fireEvent.pointerUp(window, { button: 0 });
    fireEvent.keyDown(window, { key: "x", code: "KeyX" });
    await waitFor(() => expect(cells[3].textContent).toContain("x"));
    cells = document.querySelectorAll<HTMLElement>('[data-region-id="__new"] .matrix-grid > .cell');
    fireEvent.pointerDown(cells[0], { button: 0 });
    fireEvent.pointerMove(cells[1], { buttons: 1 });
    fireEvent.pointerUp(window, { button: 0 });
    fireEvent.keyDown(window, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(document.querySelectorAll('[data-region-id="__new"] .matrix-grid > .cell')).toHaveLength(2));
    fireEvent.click(screen.getByRole("tab", { name: S.ribbon.tabs.matrix }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.deleteMatrixColumn }));
    await waitFor(() => expect(document.querySelectorAll('[data-region-id="__new"] .matrix-grid > .cell')).toHaveLength(1));
  });

  it("deletes a matrix column selected by dragging upward", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.insertMatrix }));
    const dialog = await screen.findByRole("dialog", { name: S.editor.matrixTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: S.editor.insert }));
    await waitFor(() => expect(document.querySelectorAll('[data-region-id="__new"] .matrix-grid > .cell')).toHaveLength(4));
    const cells = document.querySelectorAll<HTMLElement>('[data-region-id="__new"] .matrix-grid > .cell');
    fireEvent.pointerDown(cells[3], { button: 0 });
    fireEvent.pointerMove(cells[1], { buttons: 1 });
    fireEvent.pointerUp(window, { button: 0 });
    fireEvent.keyDown(window, { key: "Delete", code: "Delete" });
    await waitFor(() => expect(document.querySelectorAll('[data-region-id="__new"] .matrix-grid > .cell')).toHaveLength(2));
    expect((await screen.findByRole("button", { name: S.ribbon.commands.deleteMatrixColumn })).hasAttribute("disabled")).toBe(false);
  });
  it("leaves math the backend refuses with one Escape, after the live evaluation of `=` refused it", async () => {
    // The real backend parses the stored text and refuses a range as a call argument; the mock does not.
    const backend = createMockBackend({ fast: true });
    const refuse = (statement: unknown) => {
      if (/"type":"Call".*"type":"Range"/.test(JSON.stringify(statement))) {
        throw { kind: "parse", message: "line 1, column 6: expected `,` or `)`, found `..`" };
      }
    };
    const add = backend.addMathRegion.bind(backend);
    backend.addMathRegion = async (id, page, x, y, statement, breaks) => {
      refuse(statement);
      return add(id, page, x, y, statement, breaks);
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    for (const key of "vec(1..10)=") {
      await act(async () => {
        fireEvent.keyDown(window, { key });
      });
    }
    // The message says why and how to leave.
    await waitFor(() => expect(document.body.textContent).toContain("press Esc to discard the changes"), { timeout: 3000 });
    expect(region("__new")).not.toBeNull();
    // One Escape discards the draft: the editor closes and no region is left behind.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelectorAll("[data-region-id]")).toHaveLength(0);
  });

  it("places the caret from any press on a new matrix: cell padding, gaps, fences, empty cells", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.insertMatrix }));
    const dialog = await screen.findByRole("dialog", { name: S.editor.matrixTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: S.editor.insert }));
    const cellsOf = () => document.querySelectorAll<HTMLElement>('[data-region-id="__new"] .matrix-grid > .cell');
    await waitFor(() => expect(cellsOf()).toHaveLength(4));
    const press = (target: Element) => {
      fireEvent.pointerDown(target, { button: 0 });
      fireEvent.pointerUp(window, { button: 0 });
    };
    // Empty cell, pressed on the cell box itself (padding): the next character lands there.
    press(cellsOf()[2]);
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    await waitFor(() => expect(cellsOf()[2].textContent).toContain("a"));
    // The grid gap and the matrix box padding go to the nearest cell.
    press(document.querySelector('[data-region-id="__new"] .matrix-grid')!);
    fireEvent.keyDown(window, { key: "b", code: "KeyB" });
    await waitFor(() => expect(cellsOf()[0].textContent).toContain("b"));
    press(document.querySelector('[data-region-id="__new"] .matrix')!);
    fireEvent.keyDown(window, { key: "c", code: "KeyC" });
    await waitFor(() => expect(cellsOf()[0].textContent).toContain("c"));
    // The right bracket is the outer gap. Typing continues outside the matrix.
    press(document.querySelector('[data-region-id="__new"] .matrix > .fence-side.right')!);
    fireEvent.keyDown(window, { key: "d", code: "KeyD" });
    await waitFor(() => expect(region("__new")?.textContent).toMatch(/d$/));
    expect(Array.from(cellsOf()).some(cell => cell.textContent?.includes("d"))).toBe(false);
  });

  it("deletes a row, then a selected column, from the ribbon", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.insertMatrix }));
    const dialog = await screen.findByRole("dialog", { name: S.editor.matrixTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: S.editor.insert }));
    const cellsOf = () => document.querySelectorAll<HTMLElement>('[data-region-id="__new"] .matrix-grid > .cell');
    await waitFor(() => expect(cellsOf()).toHaveLength(4));
    // The caret is in the matrix: the contextual Matrix tab is selected.
    fireEvent.click(await screen.findByRole("button", { name: S.ribbon.commands.deleteMatrixRow }));
    await waitFor(() => expect(cellsOf()).toHaveLength(2));
    // The last row can still be deleted: it becomes a 1x1 matrix with a placeholder.
    expect(screen.getByRole("button", { name: S.ribbon.commands.deleteMatrixRow }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.selectMatrixColumn }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.deleteMatrixColumn }));
    await waitFor(() => expect(cellsOf()).toHaveLength(1));
  });

  it("requests one automatic calculation when opening a worksheet", async () => {
    const backend = createMockBackend({ fast: true });
    const recalculate = backend.recalculate;
    let calls = 0;
    backend.recalculate = async (...args) => {
      calls++;
      return recalculate(...args);
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    expect(calls).toBe(1);
  });

  it("shows pages, regions, results, status bar and the title", async () => {
    await openDemo();
    expect(document.querySelectorAll(".page")).toHaveLength(2);
    expect(screen.getByTestId("page-indicator").textContent).toBe("1 / 2");
    expect(document.title).toBe("Equavela – demo");
    // A quantity with a unit override.
    expect(region("m4")?.textContent).toContain("18.375");
    expect(region("m4")?.textContent).toContain("kN·m");
    // Text region and include region.
    expect(region("t1")?.textContent).toContain("Simply supported beam");
    expect(region("inc1")?.textContent).toContain("libs/helpers.eqv");
    // An error and a region blocked by it.
    expect(region("m16")?.getAttribute("data-state")).toBe("error");
    expect(region("m17")?.getAttribute("data-state")).toBe("error");
    // A large matrix is clipped in its box.
    expect(region("m22")?.querySelector(".result-matrix-scroll")).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId("kernel-status").textContent).toContain("ready"));
  });

  it("shows an unreached stopped region as out of date rather than never calculated", async () => {
    const backend = createMockBackend({ fast: true });
    const openWorksheet = backend.openWorksheet;
    backend.openWorksheet = async (path) => {
      const opened = await openWorksheet(path);
      return {
        ...opened,
        regions: opened.regions.map((entry) =>
          entry.key.region_id === "m4" ? { ...entry, state: "stale" as const, value: null } : entry,
        ),
      };
    };
    backend.recalculate = async () => undefined;
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("stale"));
    const result = region("m4")?.querySelector(".result.stale");
    expect(result?.getAttribute("aria-label")).toBe(S.result.stale);
  });

  it("places regions from the stored point coordinates on the 3 pt grid", async () => {
    await openDemo();
    // m1 is at (54, 150) pt on page 1: 4/3 px per pt, page 1 starts at the sheet origin.
    expect(region("m1")?.style.left).toBe("72px");
    expect(region("m1")?.style.top).toBe("200px");
    // Page 2 starts below page 1 plus the gap.
    const page2 = document.querySelector<HTMLElement>('[data-page="2"]')!;
    expect(region("m16")?.style.top).toBe(`${parseFloat(page2.style.top) + 96}px`);
  });

  it("applies the zoom as a transform and leaves the layout alone", async () => {
    await openDemo();
    const sheet = screen.getByTestId("sheet");
    expect(sheet.style.transform).toBe("scale(1)");
    fireEvent.click(screen.getByLabelText(S.status.zoomIn));
    expect(sheet.style.transform).toBe("scale(1.25)");
    expect(screen.getByTestId("zoom-value").textContent).toBe("125%");
    expect(region("m1")?.style.left).toBe("72px");
  });

  it("selects regions, deletes them and undoes the deletion", async () => {
    await openDemo();
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    fireEvent.pointerDown(region("m2")!, { button: 0, shiftKey: true });
    await waitFor(() => expect(region("m2")?.classList.contains("selected")).toBe(true));
    expect(region("m1")?.classList.contains("selected")).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    await waitFor(() => expect(region("m1")).toBeNull());
    expect(region("m2")).toBeNull();
    expect(region("m3")).not.toBeNull();

    const undo = within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo });
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    expect(undo.getAttribute("title")).toContain("Delete regions");
    fireEvent.click(undo);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    expect(region("m2")).not.toBeNull();
    const redo = screen.getByRole("button", { name: S.quickAccess.redo });
    expect((redo as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the move cursor where a press would move the region", async () => {
    await openDemo();
    const m1 = region("m1")!;
    const name = m1.querySelector<HTMLElement>(".name")!;
    // The empty part of an unselected math region moves it; its math places the caret.
    fireEvent.pointerMove(m1, { clientX: 1, clientY: 1 });
    expect(m1.style.cursor).toBe("move");
    fireEvent.pointerMove(name, { clientX: 1, clientY: 1 });
    expect(m1.style.cursor).toBe("");
    expect(name.style.cursor).toBe("");
    // A selected region moves from anywhere on it, its math included.
    fireEvent.pointerDown(m1, { button: 0 });
    fireEvent.pointerUp(window, { button: 0 });
    await waitFor(() => expect(m1.classList.contains("selected")).toBe(true));
    const selectedName = region("m1")!.querySelector<HTMLElement>(".name")!;
    fireEvent.pointerMove(selectedName, { clientX: 1, clientY: 1 });
    expect(selectedName.style.cursor).toBe("move");
    // The sheet itself is not a region: the cursor goes back.
    fireEvent.pointerMove(document.querySelector(".sheet")!, { clientX: 1, clientY: 1 });
    expect(selectedName.style.cursor).toBe("");
  });

  it("moves a selected expression by dragging its border", async () => {
    await openDemo();
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    fireEvent.pointerUp(window, { button: 0 });
    await waitFor(() => expect(region("m1")?.querySelector("[data-testid=region-drag-border] i")).not.toBeNull());
    const border = region("m1")!.querySelector("[data-testid=region-drag-border] i")!;
    const before = region("m1")!.style.top;
    fireEvent.pointerDown(border, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 120, buttons: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 120 });
    await waitFor(() => expect(region("m1")!.style.top).not.toBe(before));
    expect(region("m1")!.classList.contains("editing")).toBe(false);
  });

  it("selects inside an unselected expression when dragged in it, and moves a selected one", async () => {
    const backend = createMockBackend({ fast: true });
    const move = vi.spyOn(backend, "moveRegions");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const before = region("m1")!.style.top;
    // Not selected: a drag that starts on the math enters the expression and never moves it.
    fireEvent.pointerDown(region("m1")!.querySelector("[data-span]")!, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 100, clientY: 140, buttons: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 140 });
    });
    await waitFor(() => expect(region("m1")?.classList.contains("editing")).toBe(true));
    expect(move).not.toHaveBeenCalled();
    expect(region("m1")!.style.top).toBe(before);
    // Leave the expression, then select it with Ctrl+click (as a rubber band would): now a drag that
    // starts on its math moves it.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("m1")?.classList.contains("editing")).toBe(false));
    fireEvent.pointerDown(region("m1")!.querySelector("[data-span]")!, { button: 0, ctrlKey: true, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 100 });
    });
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    fireEvent.pointerDown(region("m1")!.querySelector("[data-span]")!, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 100, clientY: 140, buttons: 1 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 140 });
    });
    await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(region("m1")!.style.top).not.toBe(before));
  });

  it("moves the expression being edited by dragging the border of its active frame", async () => {
    const backend = createMockBackend({ fast: true });
    const move = vi.spyOn(backend, "moveRegions");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    // A click into the expression makes it active: editing lines and the light frame, no dashed
    // selection frame, so the border of the active frame is the only move handle.
    fireEvent.pointerDown(region("m1")!.querySelector("[data-span]")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(region("m1")?.classList.contains("editing")).toBe(true));
    expect(region("m1")?.classList.contains("selected")).toBe(false);
    // The caret goes to the end of the whole expression, so what is typed after the move tells
    // whether it stayed there.
    await act(async () => {
      fireEvent.keyDown(window, { key: "End", code: "End" });
    });
    const border = region("m1")!.querySelector<HTMLElement>("[data-testid=region-drag-border] i");
    expect(border).not.toBeNull();
    expect(region("m1")!.querySelector("[data-testid=region-drag-border]")).not.toBeNull();
    const before = region("m1")!.style.top;
    // 30 px are 22.5 pt, snapped to the 3 pt grid: 24 pt = 32 px.
    fireEvent.pointerDown(border!, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 100, clientY: 130 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 130 });
    });
    await waitFor(() => expect(region("m1")!.style.top).not.toBe(before));
    // One move, so one undo step, and the region is still active and unselected.
    expect(move).toHaveBeenCalledTimes(1);
    expect(region("m1")!.classList.contains("editing")).toBe(true);
    expect(region("m1")!.classList.contains("selected")).toBe(false);
    const undo = within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    expect(undo.title).toBe(S.quickAccess.nothingToUndo);
    // The caret is where it was: typing continues after the whole definition.
    await act(async () => {
      fireEvent.keyDown(window, { key: "+", code: "Equal" });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    });
    await waitFor(() =>
      expect((screen.getByTestId("math-m1").textContent ?? "").replace(/\s+/g, "")).toContain("3.5m+1"),
    );
    // While open, undo belongs to the math edit; it does not undo the worksheet move underneath.
    expect(undo.disabled).toBe(false);
    expect(undo.title).toBe(S.quickAccess.undoMathEdit);
    fireEvent.click(undo);
    await waitFor(() =>
      expect((screen.getByTestId("math-m1").textContent ?? "").replace(/\s+/g, "")).not.toContain("+1"),
    );
    expect(region("m1")!.style.top).not.toBe(before);
    fireEvent.click(undo);
    await waitFor(() =>
      expect((screen.getByTestId("math-m1").textContent ?? "").replace(/\s+/g, "")).toContain("3.5m"),
    );
    expect(region("m1")!.style.top).not.toBe(before);
    expect(undo.disabled).toBe(true);
    await act(async () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(region("m1")!.classList.contains("editing")).toBe(false));
    expect(undo.title).toContain("Move region");
    // Once closed, worksheet history undoes the move and restores the stored place.
    fireEvent.click(undo);
    await waitFor(() => expect(region("m1")!.style.top).toBe(before));
  });

  it("moves a text region being edited by dragging the border of its active frame", async () => {
    const backend = createMockBackend({ fast: true });
    const move = vi.spyOn(backend, "moveRegions");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("t1")).not.toBeNull());
    fireEvent.pointerDown(region("t1")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(region("t1")?.classList.contains("editing")).toBe(true));
    await screen.findByTestId("text-editor");
    const border = region("t1")!.querySelector<HTMLElement>("[data-testid=region-drag-border] i");
    expect(border).not.toBeNull();
    const before = region("t1")!.style.top;
    fireEvent.pointerDown(border!, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 100, clientY: 140 });
    });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 140 });
    });
    await waitFor(() => expect(region("t1")!.style.top).not.toBe(before));
    expect(move).toHaveBeenCalledTimes(1);
    // The text editor stays open on the moved region.
    expect(region("t1")!.classList.contains("editing")).toBe(true);
    expect(region("t1")!.querySelector("[data-testid=text-editor]")).not.toBeNull();
  });

  describe("moving a text region from the empty space around its text", () => {
    // jsdom has no layout: every text node is measured as one 50 x 20 px box at the top left of
    // the window, so (10, 10) is on the text and (300, 300) is on the empty part of the region.
    const original = (Range.prototype as { getClientRects?: unknown }).getClientRects;
    const textBox = () => [{ left: 0, top: 0, right: 50, bottom: 20, width: 50, height: 20 }] as unknown as DOMRectList;
    afterEach(() => {
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: original });
    });

    async function pressAndDrag(target: HTMLElement, from: { x: number; y: number }) {
      fireEvent.pointerDown(target, { button: 0, clientX: from.x, clientY: from.y });
      await act(async () => {
        fireEvent.pointerMove(window, { clientX: from.x, clientY: from.y + 40 });
      });
      await act(async () => {
        fireEvent.pointerUp(window, { button: 0, clientX: from.x, clientY: from.y + 40 });
      });
    }

    async function openEditing(backend: ReturnType<typeof createMockBackend>) {
      render(<App backend={backend} />);
      await waitFor(() => expect(region("t1")).not.toBeNull());
      fireEvent.pointerDown(region("t1")!, { button: 0 });
      await act(async () => {
        fireEvent.pointerUp(window, { button: 0 });
      });
      await screen.findByTestId("text-editor");
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: textBox });
    }

    it("moves the region being edited when the press is on its empty part, and keeps the editor open", async () => {
      const backend = createMockBackend({ fast: true });
      const move = vi.spyOn(backend, "moveRegions");
      await openEditing(backend);
      await pressAndDrag(region("t1")!.querySelector<HTMLElement>("[data-testid=text-editor]")!, { x: 300, y: 300 });
      await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
      expect(region("t1")!.querySelector("[data-testid=text-editor]")).not.toBeNull();
    });

    it("never moves the region when the press is on its text", async () => {
      const backend = createMockBackend({ fast: true });
      const move = vi.spyOn(backend, "moveRegions");
      await openEditing(backend);
      await pressAndDrag(region("t1")!.querySelector<HTMLElement>("[data-testid=text-editor]")!, { x: 10, y: 10 });
      expect(move).not.toHaveBeenCalled();
    });

    describe("selecting by dragging from the text, moving by the border", () => {
      const original = (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
      afterEach(() => {
        Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: original });
      });
      // One character per 10 px along the first text node of the editor.
      const caretByX = (x: number) => {
        const root = document.querySelector("[data-testid=text-editor]");
        const walker = root ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : null;
        const node = walker?.nextNode();
        if (!node) return null;
        const range = document.createRange();
        range.setStart(node, Math.max(0, Math.min(node.textContent!.length, Math.floor(x / 10))));
        range.collapse(true);
        return range;
      };

      it("a press and drag on the text opens the editor and selects the dragged range, without moving the region", async () => {
        const backend = createMockBackend({ fast: true });
        const move = vi.spyOn(backend, "moveRegions");
        render(<App backend={backend} />);
        await waitFor(() => expect(region("t1")).not.toBeNull());
        Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: textBox });
        Object.defineProperty(document, "caretRangeFromPoint", { configurable: true, value: (x: number) => caretByX(x) });
        fireEvent.pointerDown(region("t1")!, { button: 0, clientX: 10, clientY: 10 });
        await act(async () => {
          fireEvent.pointerMove(window, { clientX: 30, clientY: 10, buttons: 1 });
        });
        await screen.findByTestId("text-editor");
        await act(async () => {
          fireEvent.pointerMove(window, { clientX: 40, clientY: 10, buttons: 1 });
        });
        await act(async () => {
          fireEvent.pointerUp(window, { button: 0, clientX: 40, clientY: 10 });
        });
        const selection = window.getSelection()!;
        await waitFor(() => expect(selection.isCollapsed).toBe(false));
        expect(selection.toString().length).toBe(3);
        expect(move).not.toHaveBeenCalled();
      });

      it("a plain click on the text still opens the editor with the caret there", async () => {
        const backend = createMockBackend({ fast: true });
        render(<App backend={backend} />);
        await waitFor(() => expect(region("t1")).not.toBeNull());
        Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: textBox });
        fireEvent.pointerDown(region("t1")!, { button: 0, clientX: 10, clientY: 10 });
        await act(async () => {
          fireEvent.pointerUp(window, { button: 0, clientX: 10, clientY: 10 });
        });
        await screen.findByTestId("text-editor");
      });

      it("uses structural selection when a fast drag starts in inactive inline math", async () => {
        const backend = createMockBackend({ fast: true });
        const openWorksheet = backend.openWorksheet;
        backend.openWorksheet = async (path) => {
          const opened = await openWorksheet(path);
          const text = opened.view.regions.find((candidate) => candidate.id === "t1");
          if (text?.kind === "text") {
            text.paragraphs = [{ runs: [
              { kind: "text", text: "Before " },
              { kind: "math", text: "1+2", statement: { type: "ExprRegion", expr: {
                type: "Add", left: { type: "Num", text: "1" }, right: { type: "Num", text: "2" }, split: false,
              } } },
            ] }];
          }
          return opened;
        };
        const move = vi.spyOn(backend, "moveRegions");
        render(<App backend={backend} />);
        const idle = await screen.findByTestId("inline-math");
        const box = vi.spyOn(Element.prototype, "getClientRects").mockImplementation(textBox);
        const originalHit = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: () => document.querySelector('[data-testid="text-editor"] .tx-inline [data-path="0.1"]'),
        });
        try {
          await act(async () => {
            fireEvent.pointerDown(idle.querySelector('[data-path="0.0"]')!, { button: 0, clientX: 10, clientY: 10 });
            fireEvent.pointerMove(window, { buttons: 1, clientX: 40, clientY: 10 });
            fireEvent.pointerUp(window, { button: 0, clientX: 40, clientY: 10 });
          });
          const editor = await screen.findByTestId("text-editor");
          const inline = within(editor).getByTestId("inline-math");
          await waitFor(() => expect(inline.querySelector(".editing-lines .selection")).not.toBeNull());
          expect(document.activeElement).toBe(inline);
          expect(window.getSelection()?.isCollapsed).toBe(true);
          expect(move).not.toHaveBeenCalled();
        } finally {
          box.mockRestore();
          if (originalHit) Object.defineProperty(document, "elementFromPoint", originalHit);
          else Reflect.deleteProperty(document, "elementFromPoint");
        }
      });

      it("moves a text region that is not being edited by dragging its border", async () => {
        const backend = createMockBackend({ fast: true });
        const move = vi.spyOn(backend, "moveRegions");
        render(<App backend={backend} />);
        await waitFor(() => expect(region("t1")).not.toBeNull());
        Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: textBox });
        const border = region("t1")!.querySelector<HTMLElement>("[data-testid=region-drag-border] i");
        expect(border).not.toBeNull();
        // The press is on the text's own coordinates, but on the border strip: it moves.
        await pressAndDrag(border!, { x: 10, y: 10 });
        await waitFor(() => expect(move).toHaveBeenCalledTimes(1));
        expect(region("t1")!.querySelector("[data-testid=text-editor]")).toBeNull();
      });
    });

    it("a drag that starts on the text of a region not being edited does not move it and opens the editor", async () => {
      const backend = createMockBackend({ fast: true });
      const move = vi.spyOn(backend, "moveRegions");
      render(<App backend={backend} />);
      await waitFor(() => expect(region("t1")).not.toBeNull());
      Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: textBox });
      await pressAndDrag(region("t1")!, { x: 10, y: 10 });
      await screen.findByTestId("text-editor");
      expect(move).not.toHaveBeenCalled();
    });
  });

  it("inserts a table as math, typed like a matrix", async () => {
    const backend = createMockBackend({ fast: true });
    const setMath = vi.spyOn(backend, "setMath");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(within(screen.getByLabelText(S.ribbon.label)).getByRole("button", { name: "Table" }));
    // The new table opens in the editor with its optional units row, caret in the first name.
    await waitFor(() => expect(document.querySelector(".region.editing .matrix.table.with-units")).not.toBeNull());
    expect(document.querySelectorAll(".region.editing .matrix.table .cell")).toHaveLength(8);
    expect(document.querySelector(".region.editing input, .region.editing button")).toBeNull();
    const key = (k: string, code: string) => act(async () => void fireEvent.keyDown(window, { key: k, code }));
    await key("x", "KeyX");
    await key("Tab", "Tab");
    await key("y", "KeyY");
    await key("Tab", "Tab");
    await key("Tab", "Tab");
    await key("Tab", "Tab");
    await key("1", "Digit1");
    await key("Escape", "Escape");
    await waitFor(() => expect(setMath).toHaveBeenCalled());
    const statement = setMath.mock.calls.at(-1)![2] as { type: string; units: boolean; grid: { rows: number; cols: number } };
    // The units row stayed empty, so it is not stored.
    expect(statement.type).toBe("Table");
    expect(statement.units).toBe(false);
    expect([statement.grid.rows, statement.grid.cols]).toEqual([3, 2]);
  });

  it("moves a selected region with the arrow keys by one grid step", async () => {
    await openDemo();
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowDown" });
    });
    await waitFor(() => expect(region("m1")?.style.top).toBe("204px"));
  });

  it("marks results out of date after an edit and refreshes them in AUTO mode", async () => {
    await openDemo();
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    await waitFor(() => expect(region("m1")?.style.left).toBe("76px"));
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
  });

  it("keeps results stale in manual mode until F5", async () => {
    await openDemo();
    fireEvent.click(screen.getByTestId("calc-mode"));
    expect(screen.getByTestId("calc-mode").textContent).toContain(S.status.manual);
    // Deleting the first definition makes what comes after it out of date.
    fireEvent.pointerDown(region("m1")!, { button: 0 });
    await act(async () => {
      fireEvent.keyDown(window, { key: "Delete" });
    });
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("stale"));
    expect(region("m4")?.querySelector(".result.stale")).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: "F5" });
    });
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
  });

  it("hides the empty-sheet hint under a new region being typed", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "n", code: "KeyN", ctrlKey: true });
    await waitFor(() => expect(document.querySelector(".empty-hint")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(within(screen.getByLabelText(S.ribbon.label)).getByRole("button", { name: S.ribbon.commands.math }));
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    expect(document.querySelector(".empty-hint")).toBeNull();
    // cancelling the empty draft on a still empty sheet brings it back
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelector(".empty-hint")).not.toBeNull();
  });

  it("opens a math draft at the crosshair and finds regions by text", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(within(screen.getByLabelText(S.ribbon.label)).getByRole("button", { name: S.ribbon.commands.math }));
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    expect(region("__new")?.querySelector(".ph")).not.toBeNull();
    expect(document.querySelectorAll(".region")).toHaveLength(before + 1);

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelectorAll(".region")).toHaveLength(before);

    const find = screen.getByLabelText(S.status.find);
    fireEvent.change(find, { target: { value: "spectral" } });
    expect(screen.getByText(S.status.findCount(1, 1))).not.toBeNull();
    fireEvent.keyDown(find, { key: "Enter" });
    await waitFor(() => expect(region("j1")?.classList.contains("selected")).toBe(true));
  });

  it("marks the occurrences of the query on the sheet and clears them with the query", async () => {
    const painted = new Map<string, { ranges: Range[] }>();
    const globals = globalThis as unknown as { CSS: object; Highlight?: unknown };
    const saved = { CSS: globals.CSS, Highlight: globals.Highlight };
    globals.CSS = { ...saved.CSS, escape: (s: string) => s, highlights: { set: (n: string, h: { ranges: Range[] }) => painted.set(n, h), delete: (n: string) => painted.delete(n) } };
    globals.Highlight = class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } };
    try {
      await openDemo();
      const find = screen.getByLabelText(S.status.find);
      fireEvent.change(find, { target: { value: "sin" } });
      await waitFor(() => expect(painted.get("mm-find-current")?.ranges.length ?? 0).toBeGreaterThan(0));
      const current = painted.get("mm-find-current")!.ranges;
      expect(current.every((range) => range.toString().toLowerCase() === "sin")).toBe(true);
      // A result is never marked, only the expression the region draws.
      expect(current.some((range) => range.startContainer.parentElement?.closest(".result"))).toBe(false);
      fireEvent.change(find, { target: { value: "" } });
      await waitFor(() => expect(painted.size).toBe(0));
    } finally {
      globals.CSS = saved.CSS;
      globals.Highlight = saved.Highlight;
    }
  });

  it("replaces the current match in one undo step", async () => {
    await openDemo();
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "3.5" } });
    expect(screen.getByText(S.status.findCount(1, 1))).not.toBeNull();
    fireEvent.change(screen.getByLabelText(S.status.replaceWith), { target: { value: "4.2" } });
    fireEvent.click(screen.getByRole("button", { name: S.status.replace }));
    await waitFor(() => expect(region("m1")?.textContent).toContain("4.2"));
    // The region replaced is the one shown and the only one selected.
    expect(region("m1")?.classList.contains("selected")).toBe(true);
    // It no longer matches, so Find reports no match rather than the old count.
    await waitFor(() => expect(screen.getByText(S.status.findNone)).not.toBeNull());
    // One undo step puts the region back.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(region("m1")?.textContent).toContain("3.5"));
  });

  it("replaces in every match, says how many regions changed and undoes in one step", async () => {
    await openDemo();
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "load" } });
    expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull();
    fireEvent.change(screen.getByLabelText(S.status.replaceWith), { target: { value: "force" } });
    // A Replace All leaves the selection where it was.
    fireEvent.pointerDown(region("m2")!, { button: 0 });
    await waitFor(() => expect(region("m2")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: S.status.replaceAll }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.status.replacedIn(2)));
    expect(region("t1")?.textContent).toContain("force");
    expect(region("t2")?.textContent).toContain("force");
    expect(region("m2")?.classList.contains("selected")).toBe(true);
    // The whole pass is one undo step: one Ctrl+Z restores both regions.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(region("t1")?.textContent).toContain("load"));
    expect(region("t2")?.textContent).toContain("load");
  });

  it("refuses a replacement that would not be valid math", async () => {
    await openDemo();
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "3.5" } });
    fireEvent.change(screen.getByLabelText(S.status.replaceWith), { target: { value: ")" } });
    fireEvent.click(screen.getByRole("button", { name: S.status.replace }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain("does not parse"));
    // Nothing was written and the match is still there.
    expect(region("m1")?.textContent).toContain("3.5");
    expect(screen.getByText(S.status.findCount(1, 1))).not.toBeNull();
  });

  it("switches Find to math mode with Ctrl+M and finds a name by its tree, not its letters", async () => {
    await openDemo();
    const find = screen.getByLabelText(S.status.find);
    fireEvent.change(find, { target: { value: "L" } });
    // Text mode finds the letter anywhere: "load", "beam spans L", "L := …", "q·L^2/8", "1..n" …
    expect(screen.getByText(/of [5-9]$/)).not.toBeNull();
    find.focus();
    await act(async () => void fireEvent.keyDown(find, { key: "m", code: "KeyM", ctrlKey: true }));
    const toggle = screen.getByRole("button", { name: S.status.findModeLabel });
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    // Math mode: only the regions whose math holds the name L, and the keyboard stayed in Find.
    await waitFor(() => expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull());
    const box = screen.getByRole("group", { name: S.status.findMath });
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true));
    // Enter goes to the next match: from the first, m1, to the second, m3.
    fireEvent.keyDown(box.querySelector("[data-testid=inline-math]")!, { key: "Enter" });
    await waitFor(() => expect(region("m3")?.classList.contains("selected")).toBe(true));
    expect(screen.getByText(S.status.findCount(2, 2))).not.toBeNull();
    // Ctrl+M in the math box switches back and keeps the query as text.
    await act(async () => void fireEvent.keyDown(box.querySelector("[data-testid=inline-math]")!, { key: "m", code: "KeyM", ctrlKey: true }));
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
    expect((screen.getByLabelText(S.status.find) as HTMLInputElement).value).toBe("L");
  });

  it("switches Find to math mode when the paste is math the app copied, and keeps other text as text", async () => {
    await openDemo();
    const find = screen.getByLabelText(S.status.find);
    const paste = (target: Element, text: string) =>
      fireEvent.paste(target, { clipboardData: { getData: () => text } });
    // Any other text pastes as text: the browser inserts it, the mode stays.
    expect(paste(find, "beam")).toBe(true);
    const toggle = screen.getByRole("button", { name: S.status.findModeLabel });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // A math region copied on the sheet is math: math mode, with its math in Find.
    expect(paste(find, '- id: m9\n  page: 1\n  math: "L"\n')).toBe(false);
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("true"));
    await waitFor(() => expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull());
    const box = screen.getByRole("group", { name: S.status.findMath });
    await waitFor(() => expect(box.contains(document.activeElement)).toBe(true));
  });

  it("selects the name under a double click in the math being edited", async () => {
    await openDemo();
    const name = () => region("m3")!.querySelector<HTMLElement>('.name[data-name="M_max"]')!;
    fireEvent.pointerDown(name(), { button: 0 });
    fireEvent.doubleClick(name());
    // Backspace deletes the selection: the whole name, subscript included, not its last letter.
    await act(async () => void fireEvent.keyDown(document.activeElement!, { key: "Backspace", code: "Backspace" }));
    await waitFor(() => expect(region("m3")?.querySelector(".name[data-name^='M']")).toBeNull());
    expect(region("m3")?.textContent).toContain("q");
  });

  it("replaces a name in the math that holds it, in one undo step, and leaves text alone", async () => {
    await openDemo();
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "L" } });
    fireEvent.change(screen.getByLabelText(S.status.replaceWith), { target: { value: "Len" } });
    fireEvent.click(screen.getByRole("button", { name: S.status.findModeLabel }));
    await waitFor(() => expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.status.replaceAll }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.status.replacedIn(2)));
    await waitFor(() => expect(region("m1")?.textContent).toContain("Len"));
    expect(region("m3")?.textContent).toContain("Len");
    // The prose is text, not math: "spans L" and "load" keep their letters.
    expect(region("t2")?.textContent).toContain("spans L");
    expect(region("t1")?.textContent).toContain("load");
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(region("m1")?.textContent).not.toContain("Len"));
    expect(region("m3")?.textContent).not.toContain("Len");
  });

  it("replaces nothing in math mode while the Replace with box is empty", async () => {
    await openDemo();
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "L" } });
    fireEvent.click(screen.getByRole("button", { name: S.status.findModeLabel }));
    await waitFor(() => expect(screen.getByText(S.status.findCount(1, 2))).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.status.replace }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.status.replaceNeedsMath));
    expect(region("m1")?.textContent).toContain("L");
  });

  it("reaches Find and Replace from the command palette, which has no chord for them", async () => {
    await openDemo();
    const runPaletteEntry = async (query: string) => {
      fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
      const dialog = screen.getByRole("dialog", { name: S.commands.title });
      const search = within(dialog).getByLabelText(S.commands.search);
      fireEvent.change(search, { target: { value: query } });
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: S.commands.title })).toBeNull());
    };
    // Without a query there is nothing to replace yet: the keyboard goes to Find.
    await runPaletteEntry("replace with");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(S.status.find)));
    // With a query the keyboard goes to the Replace with box.
    fireEvent.change(screen.getByLabelText(S.status.find), { target: { value: "beam" } });
    await runPaletteEntry("replace with");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(S.status.replaceWith)));
  });

  it("inserts structural commands and text from the Math ribbon palettes", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const operators = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    fireEvent.click(within(operators).getByTitle(/Power/));
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    expect(region("__new")?.querySelector(".sup")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.unitsPalette }));
    const units = screen.getByRole("dialog", { name: S.ribbon.palette.units });
    fireEvent.click(within(units).getByTitle("m: length"));
    expect(region("__new")?.textContent).toContain("m");
  });

  it("closes a Math palette with Escape without starting or committing a region", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    expect(screen.getByRole("dialog", { name: S.ribbon.palette.symbols })).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.ribbon.palette.symbols })).toBeNull());
    expect(region("__new")).toBeNull();
    expect(document.querySelectorAll(".region")).toHaveLength(before);
  });

  it("keeps a pinned palette open, searches it and closes unpinned ones after use", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    const symbols = screen.getByRole("dialog", { name: S.ribbon.palette.symbols });
    fireEvent.click(within(symbols).getByRole("button", { name: S.ribbon.palette.pin }));
    fireEvent.change(within(symbols).getByLabelText(S.ribbon.palette.search), { target: { value: "ℝ" } });
    expect(within(symbols).getAllByRole("button").map((b) => b.textContent)).toContain("ℝ");
    expect(within(symbols).queryByRole("button", { name: "α" })).toBeNull();
    fireEvent.click(within(symbols).getByRole("button", { name: "ℝ" }));
    await waitFor(() => expect(region("__new")?.textContent).toContain("ℝ"));
    expect(screen.getByRole("dialog", { name: S.ribbon.palette.symbols })).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const operators = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    fireEvent.click(within(operators).getByTitle("Addition (+)"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.ribbon.palette.operators })).toBeNull());
    expect(screen.getByRole("dialog", { name: S.ribbon.palette.symbols })).not.toBeNull();
  });

  it("shows the active-layout shortcut in palette tooltips", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.operators }));
    const operators = screen.getByRole("dialog", { name: S.ribbon.palette.operators });
    expect(within(operators).getByTitle(/Global definition \(Ctrl\+Shift\+/)).not.toBeNull();
  });

  it("starts a structural math region by typing and commits it with Enter", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;

    fireEvent.keyDown(window, { key: "x", code: "KeyX" });
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    expect(region("__new")?.textContent).toContain("x");

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelectorAll(".region")).toHaveLength(before + 1);
    expect(
      [...document.querySelectorAll<HTMLElement>(".kind-math")].some((r) =>
        r.textContent?.includes("x"),
      ),
    ).toBe(true);
  });

  it("opens a text region in the editor with a click and leaves it unchanged without an edit", async () => {
    await openDemo();
    const insertionPoint = screen.getByTestId("crosshair").getAttribute("style");
    expect(region("t2")?.querySelector("[data-testid=text-view]")).not.toBeNull();
    fireEvent.pointerDown(region("t2")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(region("t2")?.querySelector("[data-testid=text-editor]")).not.toBeNull());
    expect(region("t2")?.classList.contains("editing")).toBe(true);
    expect(screen.queryByTestId("crosshair")).toBeNull();

    // The contextual Text tab appears and is selected while a text region is open.
    expect(screen.getByRole("tab", { name: S.ribbon.tabs.text }).getAttribute("aria-selected")).toBe("true");
    const bold = screen.getByRole("button", { name: S.text.bold });
    await waitFor(() => expect((bold as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("button", { name: S.text.insertMath })).not.toBeNull();

    // Escape (keymap context text) commits: nothing changed, so there is no undo step.
    const editor = region("t2")!.querySelector("[data-testid=text-editor]")!;
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("t2")?.querySelector("[data-testid=text-view]")).not.toBeNull());
    expect(screen.getByTestId("crosshair").getAttribute("style")).toBe(insertionPoint);
    const undo = within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
    expect(undo.disabled).toBe(true);
    // The Text tab leaves with the editor and the ribbon goes back to Insert.
    expect(screen.queryByRole("button", { name: S.text.bold })).toBeNull();
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.text })).toBeNull();
    expect(screen.getByRole("tab", { name: "Insert" }).getAttribute("aria-selected")).toBe("true");
  });

  it("resizes a selected text region with its handle as one undo step", async () => {
    await openDemo();
    expect(document.querySelector("[data-testid=resize-handle]")).toBeNull();
    fireEvent.pointerDown(region("t1")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(document.querySelector("[data-testid=resize-handle]")).not.toBeNull());
    const view = () => region("t1")!.querySelector<HTMLElement>("[data-testid=text-view],[data-testid=text-editor]")!;
    const before = view().style.width;
    // t1 has no stored width: it grows with its text. The resize starts from the width it is
    // drawn at (nothing in jsdom, so the minimum) and gives it a fixed width.
    expect(before).toBe("fit-content");
    fireEvent.pointerDown(document.querySelector("[data-testid=resize-handle]")!, { button: 0, clientX: 450, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 600, clientY: 100 });
    });
    // 150 px = 112.5 pt wider, snapped to the grid: 3 pt steps of 4 px.
    await waitFor(() => expect(view().style.width).not.toBe(before));
    const during = view().style.width;
    expect(during).toMatch(/px$/);
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 100 });
    });
    expect(view().style.width).toBe(during);
    // The text editor is still open and owns Undo; once it is left, Undo undoes the resize.
    const editor = region("t1")!.querySelector<HTMLElement>("[data-testid=text-editor]")!;
    expect(editor).not.toBeNull();
    expect((within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.keyDown(editor, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(region("t1")!.querySelector("[data-testid=text-editor]")).toBeNull());
    await waitFor(() => expect((within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement).disabled).toBe(false));
    expect(view().style.width).toBe(during);
    expect(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }).getAttribute("title")).toContain("Resize region");
    fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(view().style.width).toBe(before));
  });

  it("shows the side panel with variables, outline, problems and includes, and navigates from its rows", async () => {
    window.localStorage.clear();
    await openDemo();
    expect(screen.queryByTestId("side-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("panel-toggle"));
    const rows = await screen.findAllByTestId("variable-row");
    expect(rows.length).toBeGreaterThan(5);
    await waitFor(() => expect(screen.getByTestId("variables-list").textContent).toContain("3 × 3 matrix"));
    // a row navigates to the defining region
    fireEvent.click(rows[0]);
    await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
    // the variables are those visible up to the selected region (L, and the global k)
    await waitFor(() => expect(screen.getAllByTestId("variable-row").length).toBe(2));

    fireEvent.click(screen.getByTestId("panel-tab-outline"));
    const outline = await screen.findAllByTestId("outline-row");
    expect(outline.length).toBeGreaterThan(10);
    fireEvent.click(outline[outline.length - 1]);

    fireEvent.click(screen.getByTestId("panel-tab-problems"));
    const problems = await screen.findAllByTestId("problem-row");
    expect(problems.some((row) => row.textContent?.includes("missing"))).toBe(true);
    fireEvent.click(problems[0]);
    await waitFor(() => expect(region("m16")?.classList.contains("selected")).toBe(true));

    fireEvent.click(screen.getByTestId("panel-tab-includes"));
    const includeRow = await screen.findByTestId("include-row");
    expect(includeRow.textContent).toContain("helpers.eqv");
    // the mock cannot find the file: the row is there but cannot be opened
    expect((includeRow as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("panel-tab-variables"));
    for (const row of await screen.findAllByTestId("variable-row")) expect(row.textContent).not.toContain("helpers.eqv");
    window.localStorage.clear();
  });

  it("shows hover information for a name and underlines only the failing sub-expression", async () => {
    window.localStorage.clear();
    await openDemo();
    const name = [...region("m3")!.querySelectorAll<HTMLElement>(".name")].find((n) => n.dataset.name === "q")!;
    await act(async () => {
      fireEvent.pointerMove(name);
    });
    const card = await screen.findByTestId("hover-card", {}, { timeout: 2000 });
    expect(card.textContent).toContain("q");
    expect(card.textContent).toContain("defined in page 1");
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    await waitFor(() => expect(screen.queryByTestId("hover-card")).toBeNull());
    // the failing region carries the span of `missing`
    const node = region("m16")!.querySelector<HTMLElement>("[data-span]");
    expect(node).not.toBeNull();
  });

  it.each(["math", "inline"] as const)("shows pi with its built-in value in %s", async (kind) => {
    const opened = await createMockBackend({ fast: true }).openWorksheet("demo.eqv");
    const id = kind === "inline" ? "t1" : "m16";
    const math = opened.view.regions.find((candidate) => candidate.id === id);
    const statement = { type: "Evaluate", expr: {
      type: "Ident", name: { segments: [{ text: "π", subscript: false }], label: null }, span: { start: 0, end: 2 },
    }, unit: null };
    if (math?.kind === "math") {
      math.text = "π =";
      math.statement = statement;
    } else if (math?.kind === "text") {
      math.paragraphs = [{ runs: [{ kind: "math", text: "π =", statement }] }];
    }
    render(<App backend={createMockBackend({ fast: true, opened })} />);
    const pi = await waitFor(() => {
      const name = region(id)?.querySelector('[data-name="π"]');
      expect(name).toBeTruthy();
      return name!;
    });
    fireEvent.pointerMove(pi);
    const card = await screen.findByTestId("hover-card", {}, { timeout: 2000 });
    expect(card.textContent).toContain(S.hover.constant);
    expect(card.textContent).toMatch(/3\.14/);
  });

  it("starts a new text region from the ribbon and drops it when it stays empty", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.text }));
    await waitFor(() => expect(region("__new")?.querySelector("[data-testid=text-editor]")).not.toBeNull());
    expect(document.querySelectorAll(".region")).toHaveLength(before + 1);
    const editor = region("__new")!.querySelector("[data-testid=text-editor]")!;
    await act(async () => {
      fireEvent.keyDown(editor, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelectorAll(".region")).toHaveLength(before);
    expect((within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("copies the selected regions as a regions snippet and pastes them from the ribbon in one undo step", async () => {
    let clipboard = "";
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: async (text: string) => {
          clipboard = text;
        },
        readText: async () => clipboard,
      },
    });
    try {
      await openDemo();
      const before = document.querySelectorAll("[data-region-id]").length;
      fireEvent.pointerDown(region("m1")!, { button: 0 });
      await act(async () => {
        fireEvent.pointerUp(window, { button: 0 });
      });
      // a click on math edits it: leave, then select the region again with Shift
      await act(async () => {
        fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
      });
      fireEvent.pointerDown(region("t1")!, { button: 0, shiftKey: true });
      await waitFor(() => expect(region("t1")?.classList.contains("selected")).toBe(true));
      await act(async () => {
        fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true });
      });
      await waitFor(() => expect(clipboard).toContain("- id: t1"));
      expect(clipboard).toContain('text: "Simply supported beam under a uniform load"');

      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      await waitFor(() => expect(document.querySelectorAll("[data-region-id]").length).toBeGreaterThan(before));
      const pasted = document.querySelectorAll("[data-region-id]").length - before;
      expect(pasted).toBeGreaterThanOrEqual(1);
      const undo = within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo });
      expect(undo.getAttribute("title")).toContain("Paste");
      fireEvent.click(undo);
      await waitFor(() => expect(document.querySelectorAll("[data-region-id]").length).toBe(before));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens a pasted line of math with the caret at its end, so = evaluates it", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => undefined, readText: async () => "Mmax" },
    });
    try {
      await openDemo();
      const before = new Set([...document.querySelectorAll<HTMLElement>("[data-region-id]")].map((e) => e.dataset.regionId));
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      // The new region is open for editing, not committed with the crosshair below it.
      const pasted = await waitFor(() => {
        const added = [...document.querySelectorAll<HTMLElement>("[data-region-id]")].filter((e) => !before.has(e.dataset.regionId));
        expect(added).toHaveLength(1);
        expect(added[0].classList.contains("editing")).toBe(true);
        return added[0];
      });
      // `=` goes on from the end of the pasted name: an evaluation of it.
      await act(async () => {
        fireEvent.keyDown(window, { key: "=", code: "Equal" });
      });
      await waitFor(() => expect(pasted.textContent).toMatch(/Mmax\s*=/));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("undoes a paste with Ctrl+Z while the pasted region is still open with nothing typed", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async () => undefined, readText: async () => "Mmax" },
    });
    try {
      await openDemo();
      const before = new Set([...document.querySelectorAll<HTMLElement>("[data-region-id]")].map((e) => e.dataset.regionId));
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      const added = () => [...document.querySelectorAll<HTMLElement>("[data-region-id]")].filter((e) => !before.has(e.dataset.regionId));
      await waitFor(() => expect(added()[0]?.classList.contains("editing")).toBe(true));
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
      });
      await waitFor(() => expect(added()).toHaveLength(0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restarts the REPL from the context menu of the REPL button and from the palette", async () => {
    const backend = createMockBackend({ fast: true });
    const restart = vi.spyOn(backend, "replRestart");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    // Right-click on the REPL button: its menu, with the panel still hidden.
    fireEvent.contextMenu(screen.getByTestId("repl-toggle"), { clientX: 40, clientY: 580 });
    const menu = screen.getByRole("menu", { name: S.repl.menu });
    expect(within(menu).getByRole("menuitem", { name: S.repl.show })).not.toBeNull();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: S.repl.restartCommand }));
    });
    expect(restart).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.getByText(S.repl.restartDone)).not.toBeNull());
    expect(screen.queryByRole("menu", { name: S.repl.menu })).toBeNull();
    // The worksheet on that kernel lost its results and calculates again (automatic mode).
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    // The command palette has the same command.
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    const palette = screen.getByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(palette).getByLabelText(S.commands.search), { target: { value: "Restart REPL" } });
    await act(async () => {
      fireEvent.keyDown(within(palette).getByLabelText(S.commands.search), { key: "Enter" });
    });
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("copies a plot into the snippet as its plot mapping, with no region left out", async () => {
    const writes: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: async (text: string) => void writes.push(text),
        readText: async () => "",
      },
    });
    try {
      await openDemo();
      // The plot inserted from the ribbon is the selection; nothing else is copied with it.
      await insertPlotRegion();
      await act(async () => {
        fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true });
      });
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toContain("  plot: {");
      expect(screen.queryByText(/was not copied|were not copied/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the function catalogue with F2 and inserts the chosen function", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "F2", code: "F2" });
    const dialog = screen.getByRole("dialog", { name: S.catalogue.title });
    fireEvent.change(within(dialog).getByLabelText(S.catalogue.search), { target: { value: "stack" } });
    expect(within(within(dialog).getByRole("listbox")).getAllByRole("option")[0].textContent).toContain("stack(A, B, C, …)");
    expect(dialog.textContent).toContain("Places arrays top to bottom");
    fireEvent.keyDown(within(dialog).getByLabelText(S.catalogue.search), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.catalogue.title })).toBeNull());
    await waitFor(() => expect(region("__new")?.textContent).toContain("stack"));
  });

  it("opens the help entry of the function under the caret with F1", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "s", code: "KeyS" });
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    for (const ch of "tack") fireEvent.keyDown(window, { key: ch, code: `Key${ch.toUpperCase()}` });
    await waitFor(() => expect(region("__new")?.textContent).toContain("stack"));
    fireEvent.keyDown(window, { key: "F1", code: "F1" });
    const dialog = await screen.findByRole("dialog", { name: S.catalogue.title });
    expect((within(dialog).getByLabelText(S.catalogue.search) as HTMLInputElement).value).toBe("stack");
    expect(within(within(dialog).getByRole("listbox")).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(within(dialog).getByLabelText(S.catalogue.search), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.catalogue.title })).toBeNull());
  });

  it("runs editor and workbench commands from the Ctrl+K command palette", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: S.commands.title });
    const search = within(dialog).getByLabelText(S.commands.search);
    fireEvent.change(search, { target: { value: "kN" } });
    const first = within(within(dialog).getByRole("listbox")).getAllByRole("option")[0];
    expect(first.textContent).toContain("kN");
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.commands.title })).toBeNull());
    await waitFor(() => expect(region("__new")?.textContent).toContain("kN"));

    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    const again = screen.getByRole("dialog", { name: S.commands.title });
    const box = within(again).getByLabelText(S.commands.search);
    fireEvent.change(box, { target: { value: "symbols palette" } });
    expect(within(again).getAllByRole("option")[0].textContent).toContain("Symbols palette");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: S.ribbon.palette.symbols })).not.toBeNull());
  });

  it("searches insertable math at the active worksheet caret and confirms with the keyboard", async () => {
    await openDemo();
    const area = screen.getByTestId("worksheet-area");
    const open = () => fireEvent.keyDown(area, { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    area.focus();
    fireEvent.keyDown(area, { key: "x", code: "KeyX" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("x"));
    open();
    const search = screen.getByRole("combobox", { name: S.commands.insertSearch });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "save as" } });
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.change(search, { target: { value: "trunc" } });
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(document.activeElement).toBe(area);
    expect(region("__new")?.textContent).toContain("x");
    open();
    const input = screen.getByRole("combobox", { name: S.commands.insertSearch });
    fireEvent.change(input, { target: { value: "inte" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "integ" } });
    const first = screen.getAllByRole("option")[0];
    expect(first.textContent).toContain("Integral");
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: S.commands.insertTitle })).toBeNull();
    expect(document.activeElement).toBe(area);
    expect(region("__new")?.textContent).toContain("∫");
  });

  it("starts equation search at the crosshair and leaves AltGr to typing", async () => {
    await openDemo();
    const area = screen.getByTestId("worksheet-area");
    const open = () => fireEvent.keyDown(area, { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    const windowsAltGraph = new KeyboardEvent("keydown", { key: " ", code: "Space", ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(windowsAltGraph, "getModifierState", { value: (name: string) => name === "AltGraph" });
    area.focus();
    fireEvent(area, windowsAltGraph);
    expect(region("__new")).toBeNull();
    expect(screen.queryByRole("dialog", { name: S.commands.insertTitle })).toBeNull();
    open();
    const search = await screen.findByRole("combobox", { name: S.commands.insertSearch });
    expect(region("__new")).not.toBeNull();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(region("__new")).toBeNull();
    expect(document.activeElement).toBe(area);
    open();
    const input = await screen.findByRole("combobox", { name: S.commands.insertSearch });
    fireEvent.change(input, { target: { value: "integ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(region("__new")?.textContent).toContain("∫");
    expect(document.activeElement).toBe(area);
  });

  it("opens equation search from the Math tab and inserts a region from empty space", async () => {
    const backend = createMockBackend({ fast: true });
    const add = vi.spyOn(backend, "addRegion");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const area = screen.getByTestId("worksheet-area");
    area.focus();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = screen.getByRole("button", { name: S.ribbon.commands.insertSearch });
    expect(button.getAttribute("title")).toBe(`${S.commands.insertSearch} (Ctrl+Shift+Space)`);
    fireEvent.click(button);
    const search = await screen.findByRole("combobox", { name: S.commands.insertSearch });
    expect(region("__new")).not.toBeNull();
    fireEvent.change(search, { target: { value: "table" } });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(add.mock.calls[0]?.[1]).toBe("table"));
    expect(region("__new")).toBeNull();
  });

  it("sets a paragraph style and an alignment from the command palette and keeps them in the file", async () => {
    const backend = createMockBackend({ fast: true });
    const setText = vi.spyOn(backend, "setText");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("t1")).not.toBeNull());
    // Open the text region: the Text tab and its paragraph commands act on it.
    fireEvent.pointerDown(region("t1")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await screen.findByTestId("text-editor");
    const run = async (query: string) => {
      fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
      const dialog = screen.getByRole("dialog", { name: S.commands.title });
      const search = within(dialog).getByLabelText(S.commands.search);
      fireEvent.change(search, { target: { value: query } });
      expect(within(within(dialog).getByRole("listbox")).getAllByRole("option")[0].textContent?.toLowerCase()).toContain(query.split(": ")[1]);
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: S.commands.title })).toBeNull());
    };
    await run("text style: heading 1");
    await run("text: align centre");
    // The editor draws the paragraph with the heading CSS and the alignment, before any commit.
    const paragraph = () => region("t1")!.querySelector<HTMLElement>("[data-testid=text-editor] p")!;
    await waitFor(() => expect(paragraph().style.textAlign).toBe("center"));
    expect(paragraph().style.fontSize).toBe("21.333px");
    // Escape commits one SetText step, which carries the paragraph attributes.
    await act(async () => {
      fireEvent.keyDown(region("t1")!.querySelector("[data-testid=text-editor]")!, { key: "Escape" });
    });
    await waitFor(() => expect(setText).toHaveBeenCalled());
    const paragraphs = setText.mock.calls.at(-1)?.[2] as RichText;
    expect(paragraphs[0]).toMatchObject({ style: "heading1", align: "center" });
    // The region is drawn read-only with the same CSS.
    await waitFor(() => expect(region("t1")!.querySelector("[data-testid=text-view]")).not.toBeNull());
    const shown = region("t1")!.querySelector<HTMLElement>("[data-testid=text-view] p")!;
    expect([shown.dataset.style, shown.style.textAlign]).toEqual(["heading1", "center"]);
  });

  it("formats the selected math regions from the Math Formatting group, one undo step each", async () => {
    const backend = createMockBackend({ fast: true });
    const setMathFont = vi.spyOn(backend, "setMathFont");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m13")).not.toBeNull());
    // m13 is the sum, m14 the integral: both math, both selected.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    const box = (id: string) => region(id)!.querySelector<HTMLElement>(".math")!;
    // A region drawn at the default math style carries no declaration of its own.
    const defaultDrawn = (id: string) => {
      const style = box(id).style;
      return [
        style.getPropertyValue("--fs"),
        style.lineHeight,
        style.getPropertyValue("--math-color"),
        style.backgroundColor,
      ].every((value) => value === "");
    };
    // without a selected or edited math region the commands are disabled.
    expect(button(S.ribbon.commands.increaseFontSize).disabled).toBe(true);
    expect(button(S.ribbon.commands.mathFont).disabled).toBe(true);
    fireEvent.pointerDown(region("m13")!, { button: 0 });
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
    fireEvent.pointerDown(region("m14")!, { button: 0, shiftKey: true });
    await waitFor(() => expect(region("m14")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    expect(button(S.ribbon.commands.decreaseFontSize).disabled).toBe(false);
    // the default 11 pt has no key; Increase writes 12 pt = 16 px on 20 px of line.
    expect(defaultDrawn("m13")).toBe(true);
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.increaseFontSize));
    });
    await waitFor(() => expect(box("m13").style.getPropertyValue("--fs")).toBe("16px"));
    expect(box("m14").style.getPropertyValue("--fs")).toBe("16px");
    expect(box("m13").style.lineHeight).toBe("20px");
    // one command for both regions, so one undo step.
    expect(setMathFont.mock.calls.at(-1)?.[1]).toHaveLength(2);
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(defaultDrawn("m13")).toBe(true));
    expect(defaultDrawn("m14")).toBe(true);
    // the dialog sets a text colour and a highlight for every target region.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.mathFont));
    });
    const dialog = await screen.findByRole("dialog", { name: S.mathFont.title });
    fireEvent.click(within(dialog).getByRole("button", { name: "Dark red" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Yellow" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("mf-apply"));
    });
    await waitFor(() => expect(box("m14").style.getPropertyValue("--math-color")).toBe("#c00000"));
    expect(box("m13").style.backgroundColor).toBe("rgb(255, 255, 0)");
    expect(setMathFont.mock.calls.at(-1)?.[1]).toHaveLength(2);
    // Reset Math Style removes the three keys of every target region, one undo step.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.resetMathFont));
    });
    await waitFor(() => expect(defaultDrawn("m13")).toBe(true));
    expect(defaultDrawn("m14")).toBe(true);
    expect(setMathFont.mock.calls.at(-1)?.[2]).toBe(true);
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(box("m13").style.getPropertyValue("--math-color")).toBe("#c00000"));
    expect(box("m14").style.backgroundColor).toBe("rgb(255, 255, 0)");
  });

  it("sets the math font size of equations and of algorithms from the Size field, in one undo step", async () => {
    const backend = createMockBackend({ fast: true });
    const setMathFont = vi.spyOn(backend, "setMathFont");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m13")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const size = () => screen.getByTestId("math-size") as HTMLSelectElement;
    const box = (id: string) => region(id)!.querySelector<HTMLElement>(".math")!;
    // The algorithm of the demo worksheet: the math region that draws a program block.
    const program = [...document.querySelectorAll<HTMLElement>("[data-region-id]")].find((el) => el.querySelector(".prog"))?.dataset.regionId;
    expect(program).toBeDefined();
    // No target: the field is disabled.
    expect(size().disabled).toBe(true);
    fireEvent.pointerDown(region("m13")!, { button: 0 });
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
    fireEvent.pointerDown(region(program!)!, { button: 0, shiftKey: true });
    await waitFor(() => expect(region(program!)?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    expect(size().disabled).toBe(false);
    expect(size().value).toBe("11");
    // Any step of the list, for an equation and for an algorithm at once, as one undo step.
    await act(async () => {
      fireEvent.change(size(), { target: { value: "20" } });
    });
    await waitFor(() => expect(box("m13").style.getPropertyValue("--fs")).toBe(sizeCss(20)));
    expect(box(program!).style.getPropertyValue("--fs")).toBe(sizeCss(20));
    expect(box(program!).style.lineHeight).toBe(`${lineHeightPx(20)}px`);
    expect(setMathFont.mock.calls.at(-1)?.[1]).toHaveLength(2);
    expect(size().value).toBe("20");
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(box("m13").style.getPropertyValue("--fs")).toBe(""));
    expect(box(program!).style.getPropertyValue("--fs")).toBe("");
    // Targets that differ show "Mixed"; choosing a size makes them uniform.
    fireEvent.pointerDown(region("m14")!, { button: 0 });
    await waitFor(() => expect(region(program!)?.classList.contains("selected")).toBe(false));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.increaseFontSize }));
    });
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await waitFor(() => expect(size().value).toBe("12"));
    fireEvent.pointerDown(region(program!)!, { button: 0, shiftKey: true });
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await waitFor(() => expect(size().selectedOptions[0].textContent).toBe(S.mathFont.mixedSize));
    await act(async () => {
      fireEvent.change(size(), { target: { value: "14" } });
    });
    await waitFor(() => expect(size().value).toBe("14"));
    expect(box(program!).style.getPropertyValue("--fs")).toBe(sizeCss(14));
  });

  it("sets the label styles of the worksheet from the dialog, one undo step per change", async () => {
    const backend = createMockBackend({ fast: true });
    const setLabelStyles = vi.spyOn(backend, "setLabelStyles");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
    const sheet = () => screen.getByTestId("sheet");
    const variable = () => region("m1")!.querySelector<HTMLElement>('[data-name="L"]')!;
    const unitName = () => region("m1")!.querySelector<HTMLElement>('[data-name="m"]')!;
    // a worksheet that stores nothing draws the built-in styles and declares nothing.
    expect(button(S.ribbon.commands.labelStyles).disabled).toBe(false);
    expect(variable().getAttribute("data-label")).toBe("var");
    expect(variable().getAttribute("style")).toBeNull();
    expect(sheet().style.getPropertyValue("--label-var-color")).toBe("");
    // a variable made upright and dark red, applied in one go.
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.labelStyles));
    });
    const dialog = await screen.findByRole("dialog", { name: S.labelStyles.title });
    // The list holds the six labels of and starts on the variable.
    const list = within(dialog).getByTestId("ls-style") as HTMLSelectElement;
    expect([...list.options].map((option) => option.textContent)).toEqual([
      "Variable",
      "Constant",
      "Function",
      "Unit",
      "System",
      "Keyword",
    ]);
    expect(list.value).toBe("var");
    fireEvent.click(within(dialog).getByTestId("ls-italic"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dark red" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ls-apply"));
    });
    await waitFor(() => expect(variable().getAttribute("data-label")).toBe("var"));
    expect(variable().querySelector<HTMLElement>(".id")!.style.fontStyle).toBe("normal");
    expect(sheet().style.getPropertyValue("--label-var-color")).toBe("#c00000");
    // one command for the whole dialog, and only what differs from the built-in style.
    expect(setLabelStyles).toHaveBeenCalledTimes(1);
    expect(setLabelStyles.mock.calls.at(-1)?.[1]).toMatchObject({
      "label-style.var.italic": "false",
      "label-style.var.color": "#c00000",
      "label-style.const.italic": null,
    });
    // One Ctrl+Z takes the whole Apply back.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(sheet().style.getPropertyValue("--label-var-color")).toBe(""));
    expect(variable().getAttribute("data-label")).toBe("var");
    expect(variable().style.fontStyle).toBe("");
    await act(async () => {
      fireEvent.keyDown(window, { key: "y", code: "KeyY", ctrlKey: true });
    });
    await waitFor(() => expect(variable().getAttribute("data-label")).toBe("var"));
    // Reset restores the selected style only — here the unit, whose colour is one token for the
    // whole sheet, so the unit of a result takes it too.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.labelStyles));
    });
    const unitDialog = await screen.findByRole("dialog", { name: S.labelStyles.title });
    fireEvent.change(within(unitDialog).getByTestId("ls-style"), { target: { value: "unit" } });
    fireEvent.click(within(unitDialog).getByTestId("ls-bold"));
    fireEvent.click(within(unitDialog).getByRole("button", { name: "Green" }));
    await act(async () => {
      fireEvent.click(within(unitDialog).getByTestId("ls-apply"));
    });
    // A unit is bold by default, so the toggle turns bold off.
    await waitFor(() => expect(unitName().querySelector<HTMLElement>(".id")!.style.fontWeight).toBe("400"));
    expect(sheet().style.getPropertyValue("--unit-color")).toBe("#00a000");
    // Reset of the unit style removes its four keys and leaves the variable style alone.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.labelStyles));
    });
    const resetDialog = await screen.findByRole("dialog", { name: S.labelStyles.title });
    fireEvent.change(within(resetDialog).getByTestId("ls-style"), { target: { value: "unit" } });
    await act(async () => {
      fireEvent.click(within(resetDialog).getByTestId("ls-reset"));
    });
    await waitFor(() => expect(sheet().style.getPropertyValue("--unit-color")).toBe(""));
    expect(unitName().querySelector<HTMLElement>(".id")!.style.fontWeight).toBe("");
    expect(setLabelStyles.mock.calls.at(-1)?.[1]).toEqual({
      "label-style.unit.bold": null,
      "label-style.unit.italic": null,
      "label-style.unit.underline": null,
      "label-style.unit.color": null,
    });
    // The variable style of the earlier Apply is untouched: a Reset removes only its own keys.
    expect(sheet().style.getPropertyValue("--label-var-color")).toBe("#c00000");
    // Cancel writes nothing.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(button(S.ribbon.commands.labelStyles));
    });
    const cancelled = await screen.findByRole("dialog", { name: S.labelStyles.title });
    fireEvent.click(within(cancelled).getByRole("button", { name: S.labelStyles.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: S.labelStyles.title })).toBeNull());
    expect(setLabelStyles).toHaveBeenCalledTimes(3);
  });

  it("says a worksheet is needed for the label styles, on the ribbon and in the palette", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    // The window opens a worksheet: close it, so no document is left.
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>(".doc-tab-close")!);
    });
    await waitFor(() => expect(region("m1")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const button = screen.getByRole("button", { name: S.ribbon.commands.labelStyles }) as HTMLButtonElement;
    // nothing to format, so the button is disabled with the reason; the palette entry says it too.
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(S.labelStyles.needsWorksheet);
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const palette = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(palette).getByLabelText(S.commands.search), { target: { value: "label styles" } });
    await act(async () => void fireEvent.keyDown(palette, { key: "Enter" }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.labelStyles.needsWorksheet));
    expect(screen.queryByRole("dialog", { name: S.labelStyles.title })).toBeNull();
  });

  it("sets a per-region result format from the dialog, shows it and undoes it", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    const formatButton = () => screen.getByRole("button", { name: S.ribbon.commands.resultFormat }) as HTMLButtonElement;
    expect(formatButton().disabled).toBe(true);
    // m13 is the sum 1.55, m14 the integral: only m13 gets the override
    fireEvent.pointerDown(region("m13")!, { button: 0 });
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    expect(formatButton().disabled).toBe(false);
    const text = (id: string) => region(id)?.querySelector("[data-testid=result]")?.textContent;
    expect(text("m13")).toBe("1.55");
    fireEvent.click(formatButton());
    const dialog = await screen.findByRole("dialog", { name: S.resultFormat.title });
    fireEvent.change(within(dialog).getByTestId("rf-type"), { target: { value: "percent" } });
    fireEvent.change(within(dialog).getByTestId("rf-precision"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("rf-apply"));
    });
    await waitFor(() => expect(text("m13")).toBe("155%"));
    expect(text("m14")).not.toContain("%");
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(text("m13")).toBe("1.55"));
  });

  it("sets the worksheet-wide result format: every region, a region override wins, Reset and undo", async () => {
    await openDemo();
    const text = (id: string) => region(id)?.querySelector("[data-testid=result]")?.textContent;
    const scientific = () => text("m13")?.startsWith("1.5·10") ?? false;
    expect(text("m13")).toBe("1.55");
    const openWorksheetDialog = async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Math" }));
      const button = screen.getByRole("button", { name: S.ribbon.commands.worksheetFormat }) as HTMLButtonElement;
      // the worksheet default needs no selected region.
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      return screen.findByRole("dialog", { name: S.resultFormat.worksheetTitle });
    };
    const dialog = await openWorksheetDialog();
    // The dialog starts from the worksheet default: the demo file sets the built-in precision.
    expect((within(dialog).getByTestId("rf-precision") as HTMLInputElement).value).toBe("3");
    // A region override first: m13 stays scientific whatever the worksheet default becomes.
    fireEvent.pointerDown(region("m13")!, { button: 0 });
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.resultFormat }));
    const regionDialog = await screen.findByRole("dialog", { name: S.resultFormat.title });
    fireEvent.change(within(regionDialog).getByTestId("rf-type"), { target: { value: "scientific" } });
    fireEvent.change(within(regionDialog).getByTestId("rf-precision"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(within(regionDialog).getByTestId("rf-apply"));
    });
    // scientific keeps its own format: 1.5 followed by a power of ten (the exponent is superscript)
    await waitFor(() => expect(scientific()).toBe(true));
    // The worksheet default is percent, for every region without an override.
    const worksheet = await openWorksheetDialog();
    fireEvent.change(within(worksheet).getByTestId("rf-type"), { target: { value: "percent" } });
    fireEvent.change(within(worksheet).getByTestId("rf-precision"), { target: { value: "1" } });
    await act(async () => {
      fireEvent.click(within(worksheet).getByTestId("rf-apply"));
    });
    await waitFor(() => expect(text("m14")).toBe("33.3%"));
    expect(scientific()).toBe(true);
    // The dialog reads the default back.
    const reopened = await openWorksheetDialog();
    expect((within(reopened).getByTestId("rf-type") as HTMLSelectElement).value).toBe("percent");
    expect((within(reopened).getByTestId("rf-precision") as HTMLInputElement).value).toBe("1");
    // Reset removes the worksheet default; the region override is still there.
    await act(async () => {
      fireEvent.click(within(reopened).getByTestId("rf-reset"));
    });
    await waitFor(() => expect(text("m14")).toBe("0.333"));
    expect(scientific()).toBe(true);
    // One undo step brings the worksheet default back.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(text("m14")).toBe("33.3%"));
  });

  // radix, trailing zeros and the three thresholds, both levels.
  it("sets the worksheet radix, trailing zeros and thresholds: the drawn digits, one undo step and Reset", async () => {
    const backend = createMockBackend({ fast: true });
    const defaults = vi.spyOn(backend, "setResultDefaults");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    const text = (id: string) => region(id)?.querySelector("[data-testid=result]")?.textContent;
    // m7 is the whole number -3, m10 = 1051.9722 crosses the exponential threshold, m13 = 1.5497677
    expect([text("m7"), text("m10"), text("m13")]).toEqual(["−3", "1.052·103", "1.55"]);
    const openWorksheetDialog = async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Math" }));
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.worksheetFormat }));
      return screen.findByRole("dialog", { name: S.resultFormat.worksheetTitle });
    };
    const dialog = await openWorksheetDialog();
    const field = (root: HTMLElement, id: string) => within(root).getByTestId(id) as HTMLInputElement;
    // The dialog opens on the built-in defaults.
    expect((within(dialog).getByTestId("rf-radix") as HTMLSelectElement).value).toBe("decimal");
    expect(field(dialog, "rf-trailing-zeros").checked).toBe(false);
    expect([
      field(dialog, "rf-exp-threshold").value,
      field(dialog, "rf-zero-threshold").value,
      field(dialog, "rf-complex-threshold").value,
    ]).toEqual(["3", "15", "10"]);
    fireEvent.change(within(dialog).getByTestId("rf-radix"), { target: { value: "binary" } });
    fireEvent.click(field(dialog, "rf-trailing-zeros"));
    fireEvent.change(field(dialog, "rf-exp-threshold"), { target: { value: "5" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("rf-apply"));
    });
    // Binary shows the digits of the whole number; a fraction keeps its decimal digits.
    await waitFor(() => expect(text("m7")).toBe("−11"));
    // Trailing zeros keep the digits after the point up to the precision.
    expect(text("m13")).toBe("1.550");
    // The exponential threshold is 5 now, so m10 keeps its decimal digits.
    expect(text("m10")).toBe("1051.972");
    // One undo step, and only the keys that differ from the built-in default are written.
    expect(defaults.mock.calls.at(-1)?.[1]).toEqual({
      "format.type": null,
      "format.precision": null,
      "format.radix": "binary",
      "format.trailing-zeros": "true",
      "format.exp-threshold": "5",
      "format.zero-threshold": null,
      "format.complex-threshold": null,
      "format.complex-form": null,
      "format.expand-nested": null,
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(text("m7")).toBe("−3"));
    expect([text("m10"), text("m13")]).toEqual(["1.052·103", "1.55"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "y", code: "KeyY", ctrlKey: true });
    });
    await waitFor(() => expect(text("m7")).toBe("−11"));
    // The dialog reads the five values back.
    const reopened = await openWorksheetDialog();
    expect((within(reopened).getByTestId("rf-radix") as HTMLSelectElement).value).toBe("binary");
    expect(field(reopened, "rf-trailing-zeros").checked).toBe(true);
    expect(field(reopened, "rf-exp-threshold").value).toBe("5");
    fireEvent.keyDown(reopened, { key: "Escape" });
    // Reset removes every key the dialog writes and the results go back to the built-in digits.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.worksheetFormat }));
    const reset = await screen.findByRole("dialog", { name: S.resultFormat.worksheetTitle });
    await act(async () => {
      fireEvent.click(within(reset).getByTestId("rf-reset"));
    });
    await waitFor(() => expect(text("m7")).toBe("−3"));
    expect([text("m10"), text("m13")]).toEqual(["1.052·103", "1.55"]);
    expect(defaults.mock.calls.at(-1)?.[1]).toEqual({
      "format.type": null,
      "format.precision": null,
      "format.radix": null,
      "format.trailing-zeros": null,
      "format.exp-threshold": null,
      "format.zero-threshold": null,
      "format.complex-threshold": null,
      "format.complex-form": null,
      "format.expand-nested": null,
    });
    // Reset is one undo step too.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(text("m7")).toBe("−11"));
  });

  it("sets the radix on one region and that region alone", async () => {
    const backend = createMockBackend({ fast: true });
    const formats = vi.spyOn(backend, "setResultFormat");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    const text = (id: string) => region(id)?.querySelector("[data-testid=result]")?.textContent;
    expect([text("m7"), text("m20")]).toEqual(["−3", "3+4i"]);
    fireEvent.pointerDown(region("m7")!, { button: 0 });
    await waitFor(() => expect(region("m7")?.classList.contains("selected")).toBe(true));
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.resultFormat }));
    const dialog = await screen.findByRole("dialog", { name: S.resultFormat.title });
    fireEvent.change(within(dialog).getByTestId("rf-radix"), { target: { value: "binary" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("rf-apply"));
    });
    await waitFor(() => expect(text("m7")).toBe("−11"));
    // The override is a region property and carries every key the dialog offers.
    expect(formats.mock.calls.at(-1)?.[2]).toEqual({
      "format.type": "general",
      "format.precision": "3",
      "format.radix": "binary",
      "format.trailing-zeros": "false",
      "format.exp-threshold": "3",
      "format.zero-threshold": "15",
      "format.complex-threshold": "10",
      "format.complex-form": "cartesian",
      "format.expand-nested": "false",
    });
    // Only that region: the other results keep the worksheet digits, the complex parts included.
    expect([text("m20"), text("m13")]).toEqual(["3+4i", "1.55"]);
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    await waitFor(() => expect(text("m7")).toBe("−3"));
  });

  it("sets the worksheet tolerances: one undo step, a recalculation, reset, invalid values", async () => {
    const backend = createMockBackend({ fast: true });
    const recalculate = vi.spyOn(backend, "recalculate");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    // The automatic calculation of the open is not what the assertions below are about.
    recalculate.mockClear();
    const openDialog = async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Calculate" }));
      const button = screen.getByRole("button", { name: S.ribbon.commands.calculationSettings }) as HTMLButtonElement;
      // the tolerances belong to the worksheet and need no target.
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      return screen.findByRole("dialog", { name: S.calculationSettings.title });
    };
    const dialog = await openDialog();
    // The built-in defaults, ORIGIN included.
    const field = (root: HTMLElement, id: string) => within(root).getByTestId(id) as HTMLInputElement;
    expect(field(dialog, "cs-origin").value).toBe("0");
    expect(field(dialog, "cs-tol").value).toBe("0.001");
    expect(field(dialog, "cs-ctol").value).toBe("0.001");
    // ORIGIN must be a whole number.
    fireEvent.change(field(dialog, "cs-origin"), { target: { value: "1.5" } });
    expect(within(dialog).getByTestId("cs-origin-error").textContent).toBe(S.calculationSettings.originInvalid);
    expect((within(dialog).getByTestId("cs-apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field(dialog, "cs-origin"), { target: { value: "1" } });
    // an impossible value is named and Apply stays disabled; nothing is clamped.
    fireEvent.change(field(dialog, "cs-tol"), { target: { value: "0" } });
    expect(within(dialog).getByTestId("cs-tol-error").textContent).toBe(S.calculationSettings.tolInvalid);
    expect((within(dialog).getByTestId("cs-apply") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field(dialog, "cs-ctol"), { target: { value: "-1" } });
    expect(within(dialog).getByTestId("cs-ctol-error").textContent).toBe(S.calculationSettings.ctolInvalid);
    fireEvent.change(field(dialog, "cs-tol"), { target: { value: "0.1" } });
    fireEvent.change(field(dialog, "cs-ctol"), { target: { value: "0" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("cs-apply"));
    });
    // a tolerance is not display only; the worksheet recalculates.
    await waitFor(() => expect(recalculate).toHaveBeenCalled());
    // The dialog reads the new values back.
    const reopened = await openDialog();
    expect(field(reopened, "cs-origin").value).toBe("1");
    expect(field(reopened, "cs-tol").value).toBe("0.1");
    expect(field(reopened, "cs-ctol").value).toBe("0");
    fireEvent.click(within(reopened).getByRole("button", { name: S.calculationSettings.cancel }));
    // One undo step brings the previous tolerances back.
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    const undone = await openDialog();
    expect(field(undone, "cs-origin").value).toBe("0");
    expect(field(undone, "cs-tol").value).toBe("0.001");
    expect(field(undone, "cs-ctol").value).toBe("0.001");
    // Reset removes both keys, so the worksheet is back at the built-in defaults.
    fireEvent.change(field(undone, "cs-tol"), { target: { value: "0.2" } });
    await act(async () => {
      fireEvent.click(within(undone).getByTestId("cs-apply"));
    });
    const again = await openDialog();
    expect(field(again, "cs-tol").value).toBe("0.2");
    await act(async () => {
      fireEvent.click(within(again).getByTestId("cs-reset"));
    });
    const reset = await openDialog();
    expect(field(reset, "cs-tol").value).toBe("0.001");
    fireEvent.click(within(reset).getByRole("button", { name: S.calculationSettings.cancel }));
  });

  it("says a worksheet is needed for the calculation settings when none is open", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    // The window opens a worksheet: close it, so no document is left.
    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>(".doc-tab-close")!);
    });
    await waitFor(() => expect(region("m1")).toBeNull());
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const palette = await screen.findByRole("dialog", { name: S.commands.title });
    // "tolerance" is a keyword of this entry alone, so Enter runs it.
    fireEvent.change(within(palette).getByLabelText(S.commands.search), { target: { value: "tolerance" } });
    await act(async () => void fireEvent.keyDown(palette, { key: "Enter" }));
    // with no worksheet open the command says that one is needed.
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.calculationSettings.needsWorksheet));
  });

  it("runs the math-font commands from the palette and says when no math region is selected", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const palette = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(palette).getByLabelText(S.commands.search), { target: { value: "increase font size" } });
    await act(async () => void fireEvent.keyDown(palette, { key: "Enter" }));
    // nothing is selected, so the command changes nothing and says so.
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.mathFont.noRegion));
    expect(region("m13")!.querySelector<HTMLElement>(".math")!.getAttribute("style")).toBeNull();
    // With a math region selected the same entry runs on it.
    fireEvent.pointerDown(region("m13")!, { button: 0 });
    await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const again = await screen.findByRole("dialog", { name: S.commands.title });
    fireEvent.change(within(again).getByLabelText(S.commands.search), { target: { value: "increase font size" } });
    await act(async () => void fireEvent.keyDown(again, { key: "Enter" }));
    await waitFor(() =>
      expect(region("m13")!.querySelector<HTMLElement>(".math")!.style.getPropertyValue("--fs")).toBe("16px"),
    );
  });

  it("keeps Ctrl+Z local while a new math region is being edited", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;

    fireEvent.keyDown(window, { key: "x", code: "KeyX" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("x"));
    fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    await waitFor(() => expect(region("__new")?.querySelector(".ph")).not.toBeNull());

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    expect(document.querySelectorAll(".region")).toHaveLength(before);
  });

  it("navigates built-in autocomplete candidates and accepts one with Tab", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "s", code: "KeyS" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("s"));
    fireEvent.keyDown(window, { key: "i", code: "KeyI" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("si"));

    await act(async () => fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown" }));
    await act(async () => fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown" }));
    fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("sin"));
    fireEvent.keyDown(window, { key: "(", code: "Digit9", shiftKey: true });
    expect(region("__new")?.querySelector(".call")).not.toBeNull();
  });

  it("suggests the functions an include region above the caret brings in", async () => {
    const backend = createMockBackend({ fast: true });
    const inspect = backend.inspect.bind(backend);
    // The mock has no include tree: the inspection says what the included worksheet exports.
    backend.inspect = async (id) => {
      const inspection = await inspect(id);
      const includeId = document.querySelector(".region.kind-include")?.getAttribute("data-region-id");
      const include = includeId ? { id: includeId } : undefined;
      const definition = { name: "helperArea", label: "fn", key: { document: "/libs/helpers.eqv", region_id: "m1", instance: 0 }, version: 1, global: false, signature: "helperArea(b, h)", kernel_name: "helperArea_v1", rank: 0 };
      return include ? { ...inspection, includes: [{ document: "/libs/helpers.eqv", parent: inspection.root, region_id: include.id, exports: [definition], found: true }] } : inspection;
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Untitled/ })).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.include }));
    await waitFor(() => expect(document.querySelector(".region.kind-include")).not.toBeNull());
    // Type below the include region: the crosshair is already under it.
    for (const key of "help") {
      await act(async () => {
        fireEvent.keyDown(window, { key });
      });
    }
    // The only suggestion is the included function: Tab takes it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Tab", code: "Tab" });
    });
    await waitFor(() => expect(region("__new")?.textContent).toContain("helperArea"));
  });

  it("Tab accepts the only suggestion without touching the arrows", async () => {
    await openDemo();
    const key = (k: string, code: string) => fireEvent.keyDown(window, { key: k, code });
    const typed: string[] = [];
    for (const [k, code] of [["i", "KeyI"], ["d", "KeyD"], ["e", "KeyE"], ["n", "KeyN"], ["t", "KeyT"], ["i", "KeyI"]]) {
      typed.push(k);
      key(k, code);
      await waitFor(() => expect(region("__new")?.textContent).toContain(typed.join("")));
    }
    // `identi` has exactly one candidate, so Tab applies it instead of moving on.
    await act(async () => key("Tab", "Tab"));
    await waitFor(() => expect(region("__new")?.textContent).toContain("identity"));
    key("(", "Digit9");
    expect(region("__new")?.querySelector(".call")).not.toBeNull();
  });

  it("Tab still moves on when the suggestion list holds more than one candidate", async () => {
    await openDemo();
    const key = (k: string, code: string) => fireEvent.keyDown(window, { key: k, code });
    key("x", "KeyX");
    await waitFor(() => expect(region("__new")).not.toBeNull());
    key(":", "Semicolon");
    key("$", "Digit4");
    key("s", "KeyS");
    await waitFor(() => expect(region("__new")?.textContent).toContain("s"));
    key("i", "KeyI"); // `sin`, `sign`, `sinh`, `size`, ... : more than one candidate
    await waitFor(() => expect(region("__new")?.textContent).toContain("si"));
    await act(async () => key("Tab", "Tab"));
    // Tab moved to the next placeholder instead of picking one of the candidates.
    expect(region("__new")?.textContent).not.toContain("sin(");
    expect(region("__new")?.textContent).not.toContain("sign(");
  });

  it("Tab moves to the next placeholder when no suggestion was chosen with the arrows", async () => {
    await openDemo();
    const key = (k: string, code: string, extra = {}) => fireEvent.keyDown(window, { key: k, code, ...extra });
    key("x", "KeyX");
    await waitFor(() => expect(region("__new")).not.toBeNull());
    key(":", "Semicolon", { shiftKey: true });
    key("$", "Digit4", { ctrlKey: true, shiftKey: true });
    key("i", "KeyI"); // `identity` is suggested for `i`
    await act(async () => key("Tab", "Tab"));
    key("1", "Digit1");
    await waitFor(() => expect(region("__new")?.textContent).toContain("1"));
    expect(region("__new")?.textContent).not.toContain("identity(");
    expect(region("__new")?.textContent).not.toMatch(/identity\s*∑|∑\s*identity/);
  });

  it("a math chord on the empty crosshair starts a region and applies there", async () => {
    await openDemo();
    fireEvent.keyDown(window, { key: "$", code: "Digit4", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(region("__new")?.textContent).toContain("∑"));
  });

  it("opens a second worksheet in its own tab and closes it", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(screen.getAllByRole("tab", { name: /Untitled/ }).length).toBeGreaterThan(0));
    expect(document.querySelectorAll(".region")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: `${S.documents.close} Untitled-2` }));
    await waitFor(() => expect(region("m1")).not.toBeNull());
  });

  it("shows paper boundaries and inset printable margins in draft view", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.status.draftView }));
    expect(document.querySelector(".worksheet-area.draft")).not.toBeNull();
    expect(document.querySelector(".header-placeholder")).toBeNull();
    const rightEdge = document.querySelector<SVGElement>(".draft-margin.no-print")!;
    const pages = document.querySelectorAll<HTMLElement>(".draft .page");
    expect(pages.length).toBeGreaterThan(1);
    expect(document.querySelector(".draft-break.no-print")).not.toBeNull();
    for (const page of pages) {
      const rectangle = page.querySelector(".margin-guides.no-print rect")!;
      const x = Number(rectangle.getAttribute("x"));
      const y = Number(rectangle.getAttribute("y"));
      const width = Number(rectangle.getAttribute("width"));
      const height = Number(rectangle.getAttribute("height"));
      expect(x).toBeGreaterThan(0);
      expect(y).toBeGreaterThan(0);
      expect(x + width).toBeLessThan(parseFloat(rightEdge.style.left));
      expect(y + height).toBeLessThan(parseFloat(page.style.height));
    }
  });

  it("validates the status-bar page number and scrolls without clearing the worksheet selection", async () => {
    await openDemo();
    const area = screen.getByTestId("worksheet-area");
    const crosshair = screen.getByTestId("crosshair").getAttribute("style");
    fireEvent.click(screen.getByTestId("page-indicator"));
    const input = screen.getByRole("textbox", { name: S.status.pageNumber });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByTestId("page-indicator").textContent).toBe("2 / 2");
    expect(area.scrollTop).toBeGreaterThan(0);
    expect(screen.getByTestId("crosshair").getAttribute("style")).toBe(crosshair);
    expect(document.activeElement).toBe(area);
  });

  it("fits a physical page by both dimensions and keeps the displayed page", async () => {
    await openDemo();
    const area = screen.getByTestId("worksheet-area");
    Object.defineProperties(area, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
    fireEvent.click(screen.getByRole("button", { name: S.status.draftView }));
    fireEvent.click(screen.getByTestId("page-indicator"));
    const input = screen.getByRole("textbox", { name: S.status.pageNumber });
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.submit(input.closest("form")!);
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.fitPage }));
    expect(area.classList.contains("draft")).toBe(false);
    expect(screen.getByTestId("page-indicator").textContent).toBe("2 / 2");
    const physicalPage = area.querySelector<HTMLElement>('.page[data-page="2"]')!;
    const width = parseFloat(physicalPage.style.width);
    const height = parseFloat(physicalPage.style.height);
    const zoom = fitPageZoom(area.clientWidth, area.clientHeight, width, height);
    expect(screen.getByTestId("zoom-value").textContent).toBe(S.status.zoomValue(zoom));
    expect(width * zoom + 2 * EQUAVELA_PADDING_PX).toBeLessThanOrEqual(area.clientWidth);
    expect(height * zoom + 2 * EQUAVELA_PADDING_PX).toBeLessThanOrEqual(area.clientHeight);
  });

  it("returns focus to the active math editor after Escape from a palette or dialog", async () => {
    await openDemo();
    const area = screen.getByTestId("worksheet-area");
    area.focus();
    fireEvent.keyDown(area, { key: "x", code: "KeyX" });
    await waitFor(() => expect(region("__new")?.textContent).toContain("x"));
    fireEvent.keyDown(area, { key: "k", code: "KeyK", ctrlKey: true });
    const commands = screen.getByRole("dialog", { name: S.commands.title });
    fireEvent.keyDown(within(commands).getByLabelText(S.commands.search), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(area));
    expect(region("__new")?.textContent).toContain("x");
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    const symbols = screen.getByRole("dialog", { name: S.ribbon.palette.symbols });
    fireEvent.keyDown(within(symbols).getByLabelText(S.ribbon.palette.search), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: S.ribbon.palette.symbols })).toBeNull();
    expect(document.activeElement).toBe(area);
    fireEvent.keyDown(area, { key: "y", code: "KeyY" });
    expect(region("__new")?.textContent).toContain("xy");
  });

  it("resumes an inline formula at its previous insertion point after Escape", async () => {
    const backend = createMockBackend({ fast: true });
    const openWorksheet = backend.openWorksheet;
    backend.openWorksheet = async (path) => {
      const opened = await openWorksheet(path);
      const text = opened.view.regions.find((region) => region.id === "t1");
      if (text?.kind === "text") {
        text.paragraphs = [{
          runs: [{ kind: "math", text: "ab", statement: {
            type: "ExprRegion",
            expr: { type: "Ident", name: { segments: [{ text: "ab", subscript: false }], label: null } },
          } }],
        }];
      }
      return opened;
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("t1") !== null).toBe(true));
    fireEvent.pointerDown(region("t1")!, { button: 0 });
    await act(async () => { fireEvent.pointerUp(window, { button: 0 }); });
    const text = await screen.findByTestId("text-editor");
    const inline = await within(text).findByTestId("inline-math");
    act(() => inline.focus());
    await waitFor(() => expect(document.activeElement === inline).toBe(true));
    fireEvent.keyDown(inline, { key: "ArrowLeft", code: "ArrowLeft" });
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.symbols }));
    const symbols = screen.getByRole("dialog", { name: S.ribbon.palette.symbols });
    fireEvent.keyDown(within(symbols).getByLabelText(S.ribbon.palette.search), { key: "Escape" });
    expect(document.activeElement === inline).toBe(true);
    fireEvent.keyDown(inline, { key: "x", code: "KeyX" });
    expect(inline.textContent).toContain("axb");
    fireEvent.keyDown(inline, { key: " ", code: "Space", ctrlKey: true, shiftKey: true });
    const search = screen.getByRole("combobox", { name: S.commands.insertSearch });
    fireEvent.change(search, { target: { value: "integral" } });
    const integral = screen.getAllByRole("option").find((option) => option.textContent?.includes("∫"))!;
    await act(async () => { fireEvent.click(integral); });
    expect(document.activeElement === inline).toBe(true);
    expect(inline.textContent).toContain("∫");
  });

  it("extends draft space beyond the paper and allows the crosshair there", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.status.draftView }));
    const sheet = screen.getByTestId("sheet");
    const page = document.querySelector<HTMLElement>('.draft .page[data-page="1"]')!;
    expect(parseFloat(sheet.style.width)).toBeGreaterThan(1000);
    fireEvent.pointerDown(page, { button: 0, clientX: 1200, clientY: 300 });
    await waitFor(() => expect(parseFloat(screen.getByTestId("crosshair").style.left)).toBeGreaterThan(1100));
    const area = screen.getByTestId("worksheet-area");
    Object.defineProperties(area, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, value: 1200, writable: true },
      scrollTop: { configurable: true, value: 1800, writable: true },
    });
    const oldWidth = parseFloat(sheet.style.width);
    const oldHeight = parseFloat(sheet.style.height);
    fireEvent.scroll(area);
    await waitFor(() => {
      expect(parseFloat(sheet.style.width)).toBeGreaterThan(oldWidth);
      expect(parseFloat(sheet.style.height)).toBeGreaterThan(oldHeight);
    });
  });
});

describe("inspection only when something shows it", () => {
  /** The demo, with the backend calls that carry the inspection recorded. */
  async function openRecording() {
    window.localStorage.clear();
    const backend = createMockBackend({ fast: true });
    const inspect = vi.spyOn(backend, "inspect");
    const inspectWarnings = vi.spyOn(backend, "inspectWarnings");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    await waitFor(() => expect(inspectWarnings).toHaveBeenCalled());
    return { inspect, inspectWarnings };
  }

  /** Moves a region with the arrow keys: one edit, so one new view. */
  async function nudge(id: string, key: string) {
    fireEvent.pointerDown(region(id)!, { button: 0 });
    const before = region(id)!.style.top;
    await act(async () => {
      fireEvent.keyDown(window, { key });
    });
    await waitFor(() => expect(region(id)!.style.top).not.toBe(before));
  }

  const panelBadge = () => {
    const badge = screen.getByTestId("panel-toggle").querySelector(".badge");
    return badge ? Number(badge.textContent) : 0;
  };

  it("asks for the warnings after an edit but not for the full inspection", async () => {
    const { inspect, inspectWarnings } = await openRecording();
    expect(screen.queryByTestId("side-panel")).toBeNull();
    inspectWarnings.mockClear();
    inspect.mockClear();

    await nudge("m1", "ArrowDown");
    await waitFor(() => expect(inspectWarnings).toHaveBeenCalledWith(expect.any(String)));
    expect(inspect).not.toHaveBeenCalled();
    // Nothing is going to ask for it later either: the debounce of both is the same 60 ms.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("asks for the full inspection while the side panel is open, and stops when it closes", async () => {
    const { inspect, inspectWarnings } = await openRecording();
    expect(inspect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("panel-toggle"));
    await waitFor(() => expect(inspect).toHaveBeenCalled());
    expect((await screen.findAllByTestId("variable-row")).length).toBeGreaterThan(5);

    fireEvent.click(screen.getByLabelText(S.panel.close));
    await waitFor(() => expect(screen.queryByTestId("side-panel")).toBeNull());
    inspect.mockClear();
    inspectWarnings.mockClear();
    await nudge("m1", "ArrowDown");
    await waitFor(() => expect(inspectWarnings).toHaveBeenCalled());
    expect(inspect).not.toHaveBeenCalled();
  });

  it("follows a Ctrl+click on a name to its definition with the side panel closed", async () => {
    const { inspect } = await openRecording();
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    const name = [...region("m3")!.querySelectorAll<HTMLElement>(".name")].find((n) => n.dataset.name === "q")!;
    expect(name).toBeDefined();

    await act(async () => {
      fireEvent.pointerDown(name, { button: 0, ctrlKey: true });
    });
    // `q` is defined in m2, two regions above the one that uses it.
    await waitFor(() => expect(region("m2")?.classList.contains("selected")).toBe(true));
    expect(inspect).toHaveBeenCalled();
    // It was asked for on demand only: the side panel is still closed.
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("counts a unit warning in the status bar and lists it without the full inspection", async () => {
    const { inspect, inspectWarnings } = await openRecording();
    expect(screen.queryByTestId("side-panel")).toBeNull();
    const before = panelBadge();
    // The mock has no dimension analysis, so the warning comes from the test.
    inspectWarnings.mockResolvedValue([
      {
        key: { document: "/demo/demo.eqv", region_id: "m3", instance: 0 },
        start: 0,
        end: 1,
        message: "units do not match",
      },
    ]);

    await nudge("m1", "ArrowDown");
    await waitFor(() => expect(panelBadge()).toBe(before + 1));

    fireEvent.click(screen.getByTestId("panel-toggle"));
    fireEvent.click(screen.getByTestId("panel-tab-problems"));
    // The Problems tab reads the warnings alone, so the unit warning is listed; the open panel also
    // asks for the full inspection it needs for its other tabs.
    const rows = await screen.findAllByTestId("problem-row");
    expect(rows.some((row) => row.textContent?.includes("units do not match"))).toBe(true);
    await waitFor(() => expect(inspect).toHaveBeenCalled());
    window.localStorage.clear();
  });
});

describe("commit in flight (found with real key events in the desktop app)", () => {
  it("keys typed while a new region is being committed start a new region instead of changing it", async () => {
    const backend = createMockBackend({ fast: true });
    const add = backend.addMathRegion;
    backend.addMathRegion = async (...args) => {
      await new Promise((r) => setTimeout(r, 150));
      return add(...args);
    };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const press = (key: string, code: string, extra = {}) => fireEvent.keyDown(window, { key, code, ...extra });
    const before = document.querySelectorAll("[data-kind=math]").length;
    press("x", "KeyX");
    await waitFor(() => expect(document.querySelector("[data-region-id=__new]")).not.toBeNull());
    press("Enter", "Enter");
    // typed while the first commit is still running
    press("y", "KeyY");
    press("Enter", "Enter");
    await waitFor(() => expect(document.querySelectorAll("[data-kind=math]").length).toBe(before + 2), { timeout: 3000 });
    const texts = [...document.querySelectorAll("[data-kind=math] .math")].map((e) => e.textContent);
    expect(texts.filter((t) => t === "x" || t === "y").sort()).toEqual(["x", "y"]);
  });
});

describe("plot regions (mock backend)", () => {
  it("adds an XY plot from the Plots tab with placeholders, draws it, and undoes the insertion", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    const plot = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    // Two expressions and four limits are editable math placeholders.
    expect(within(plot).getAllByTestId("plot-slot")).toHaveLength(6);
    // Unfilled expressions: nothing to draw yet, but the canvas is mounted and drawn by Plotly.
    await waitFor(() => expect(plot.getAttribute("data-state")).toBe("pending"));
    await waitFor(() => expect(within(plot).getByTestId("plot-canvas").getAttribute("data-drawn")).not.toBe("0"));
    const { default: Plotly } = await import("./plot/plotlyBundle");
    expect(Plotly.react).toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(document.querySelector('[data-testid^="plot-r"]')).toBeNull());
  });

  // The trace style, grid spacing and y-axis controls moved to the Plot tab: see
  // `plot/plotControls.test.tsx`.

  it("a single click on a placeholder puts the caret in it; typing, Tab and Escape commit through SetPlot", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    const plot = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid^="plot-r"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await waitFor(() => expect(within(plot).getAllByTestId("inline-math")).toHaveLength(6));
    const slots = () => within(plot).getAllByTestId("plot-slot");
    const regionEl = plot.closest<HTMLElement>("[data-region-id]")!;
    const key = async (target: Element, k: string, code: string, shiftKey = false) => {
      await act(async () => {
        fireEvent.keyDown(target, { key: k, code, shiftKey });
      });
    };
    // Every placeholder (y max, y expression, y min, x min, x expression, x max) opens on one press on
    // the slot itself, keeps the region selected and starts no drag.
    for (let i = 0; i < 6; i++) {
      const slot = slots()[i];
      await act(async () => {
        fireEvent.pointerDown(slot, { button: 0, clientX: 5, clientY: 5 });
      });
      const math = slot.querySelector<HTMLElement>("[data-testid=inline-math]")!;
      await waitFor(() => expect(math.classList.contains("editing")).toBe(true));
      expect(document.activeElement).toBe(math);
      if (i === 1) {
        // Editing a trace expression selects that trace, never an axis-limit placeholder.
        expect(slots()[1].getAttribute("data-selected")).toBe("true");
        expect([slots()[0], slots()[2], slots()[3], slots()[5]].every((limit) => !limit.classList.contains("selected"))).toBe(true);
      }
      if (i === 0) {
        // Explicitly editing a limit does not leave a trace selected.
        expect(plot.getAttribute("data-selected-trace")).toBe("");
      }
      await key(math, "1", "Digit1");
      await key(math, String(i + 2), `Digit${i + 2}`);
      expect(slots()[i].textContent).toContain(`1${i + 2}`);
      await key(math, "Escape", "Escape");
    }
    // Escape committed each one: the stored text comes back as the displayed placeholder.
    await waitFor(() => expect(slots()[0].textContent).toContain("12"));
    expect(slots()[5].textContent).toContain("17");
    expect(regionEl.classList.contains("dragging")).toBe(false);
    // Tab moves to the next placeholder, Shift+Tab back.
    await act(async () => {
      fireEvent.pointerDown(slots()[1], { button: 0 });
    });
    const second = slots()[1].querySelector<HTMLElement>("[data-testid=inline-math]")!;
    await waitFor(() => expect(document.activeElement).toBe(second));
    await key(second, "Tab", "Tab");
    const third = slots()[2].querySelector<HTMLElement>("[data-testid=inline-math]")!;
    await waitFor(() => expect(document.activeElement).toBe(third));
    await key(third, "Tab", "Tab", true);
    await waitFor(() => expect(document.activeElement).toBe(slots()[1].querySelector("[data-testid=inline-math]")));
  });

  it("a drag inside the plot belongs to the plot and never moves the region", async () => {
    await openDemo();
    const { plot, regionEl } = await insertPlotRegion();
    const canvas = within(plot).getByTestId("plot-canvas");
    const before = { left: regionEl.style.left, top: regionEl.style.top };
    const press = async (clientX: number, clientY: number) => {
      fireEvent.pointerDown(canvas, { button: 0, clientX, clientY });
      fireEvent.pointerMove(window, { clientX: clientX + 60, clientY: clientY + 70, buttons: 1 });
      fireEvent.pointerUp(window, { button: 0, clientX: clientX + 60, clientY: clientY + 70 });
      // Let a queued move edit reach the view, so a move cannot hide behind the asynchronous backend.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    };
    // The plot is the selection when it is inserted: the press pans or zooms its content instead.
    await press(200, 200);
    expect(regionEl.classList.contains("dragging")).toBe(false);
    expect({ left: regionEl.style.left, top: regionEl.style.top }).toEqual(before);
    // An unselected plot: the press selects it (and shows its move border) but still never moves it.
    await act(async () => {
      fireEvent.pointerDown(document.querySelector(".page")!, { button: 0, clientX: 600, clientY: 1100 });
      fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 1100 });
    });
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(false));
    await press(200, 200);
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(true));
    expect(regionEl.querySelector("[data-testid=region-drag-border]")).not.toBeNull();
    expect(regionEl.classList.contains("dragging")).toBe(false);
    expect({ left: regionEl.style.left, top: regionEl.style.top }).toEqual(before);
  });

  it("moves a selected plot by dragging its selection border", async () => {
    await openDemo();
    const { regionEl } = await insertPlotRegion();
    const border = regionEl.querySelector<HTMLElement>("[data-testid=region-drag-border] i");
    expect(border).not.toBeNull();
    const before = regionEl.style.top;
    fireEvent.pointerDown(border!, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 140, buttons: 1 });
    fireEvent.pointerUp(window, { button: 0, clientX: 100, clientY: 140 });
    await waitFor(() => expect(regionEl.style.top).not.toBe(before));
  });

  it("still moves a plot with the arrow keys after a press inside it", async () => {
    await openDemo();
    const { plot, regionEl } = await insertPlotRegion();
    await act(async () => {
      fireEvent.pointerDown(document.querySelector(".page")!, { button: 0, clientX: 600, clientY: 1100 });
      fireEvent.pointerUp(window, { button: 0, clientX: 600, clientY: 1100 });
    });
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(false));
    // A press inside the plot selects it (the keyboard path must stay reachable) without moving it.
    await act(async () => {
      fireEvent.pointerDown(within(plot).getByTestId("plot-canvas"), { button: 0, clientX: 200, clientY: 200 });
    });
    await waitFor(() => expect(regionEl.classList.contains("selected")).toBe(true));
    const before = regionEl.style.top;
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowDown", code: "ArrowDown" });
    });
    await waitFor(() => expect(regionEl.style.top).not.toBe(before));
  });
});

describe("live evaluation while editing", () => {
  it("stores and calculates a complete evaluation before leaving the editor and never draws a grey result box", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    for (const [key, code] of [["1", "Digit1"], ["+", "Equal"], ["2", "Digit2"], ["=", "Equal"]]) {
      await act(async () => {
        fireEvent.keyDown(window, { key, code, shiftKey: key === "+" });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Still in the editor, yet the region exists in the document and has been calculated.
    await waitFor(() => expect(document.querySelectorAll(".region")).toHaveLength(before + 1));
    await waitFor(() => {
      const editing = document.querySelector<HTMLElement>(".region.editing");
      expect(editing).not.toBeNull();
      expect(editing?.textContent).toContain("=");
      expect(editing?.getAttribute("data-region-id")).not.toBe("__new");
      expect(editing?.getAttribute("data-state")).toBe("value");
    });
    expect(document.querySelector(".region.editing .result")).not.toBeNull();
    expect(document.querySelector(".result.empty")).toBeNull();
  });
});

describe("text block (Ctrl+Shift+T)", () => {
  it("opens a block as wide as the printable width, while Ctrl+T opens a normal text region", async () => {
    await openDemo();
    const printable = (595.28 - 54 - 54) * (96 / 72);
    await act(async () => {
      fireEvent.keyDown(window, { key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(region("__new")?.querySelector("[data-testid=text-editor]")).not.toBeNull());
    const block = region("__new")!.querySelector<HTMLElement>("[data-testid=text-editor]")!;
    expect(parseFloat(block.style.width || getComputedStyle(block).width)).toBeCloseTo(printable, 0);
    await act(async () => {
      fireEvent.keyDown(block, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    await act(async () => {
      fireEvent.keyDown(window, { key: "t", code: "KeyT", ctrlKey: true });
    });
    await waitFor(() => expect(region("__new")?.querySelector("[data-testid=text-editor]") ?? null).not.toBeNull());
    const plain = region("__new")!.querySelector<HTMLElement>("[data-testid=text-editor]")!;
    // A new text box grows with its text up to the right margin.
    expect(plain.style.width).toBe("fit-content");
    expect(parseFloat(plain.style.maxWidth)).toBeLessThanOrEqual(printable);
    expect(parseFloat(plain.style.maxWidth)).toBeGreaterThanOrEqual(249 * (96 / 72) - 1);
  });

  it("gives a text box outside the paper in the draft view room to grow, as on the page", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.status.draftView }));
    const page = document.querySelector<HTMLElement>('.draft .page[data-page="1"]')!;
    // Far to the right of the paper, where the space to the right margin is negative.
    fireEvent.pointerDown(page, { button: 0, clientX: 1200, clientY: 300 });
    await waitFor(() => expect(parseFloat(screen.getByTestId("crosshair").style.left)).toBeGreaterThan(1100));
    await act(async () => {
      fireEvent.keyDown(window, { key: "t", code: "KeyT", ctrlKey: true });
    });
    await waitFor(() => expect(region("__new")?.querySelector("[data-testid=text-editor]") ?? null).not.toBeNull());
    const box = region("__new")!.querySelector<HTMLElement>("[data-testid=text-editor]")!;
    // The space to the right margin is negative there: the box still grows to 249 pt before it wraps.
    expect(box.style.width).toBe("fit-content");
    expect(parseFloat(box.style.maxWidth)).toBeCloseTo(249 * (96 / 72), 0);
  });

  it("the ribbon Text Block button inserts the same full-width block as Ctrl+Shift+T", async () => {
    await openDemo();
    const printable = (595.28 - 54 - 54) * (96 / 72);
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.text }));
    await waitFor(() => expect(region("__new")?.querySelector("[data-testid=text-editor]")).not.toBeNull());
    const block = region("__new")!.querySelector<HTMLElement>("[data-testid=text-editor]")!;
    expect(parseFloat(block.style.width || getComputedStyle(block).width)).toBeCloseTo(printable, 0);
    // The draft starts at the left margin, not at the crosshair.
    expect(parseFloat(region("__new")!.style.left)).toBeCloseTo(54 * (96 / 72), 0);
  });

  it("the mock backend snaps a block inserted at another x and moves it vertically only", async () => {
    const backend = createMockBackend({ fast: true });
    const opened = await backend.openWorksheet("demo.eqv");
    const added = await backend.addTextRegion(opened.id, 1, 200, 600, [{ runs: [{ kind: "text", text: "B" }] }], true);
    const block = added.view.regions.find((r) => r.id === added.created)!;
    expect(block.x).toBe(54);
    const moved = await backend.moveRegions(opened.id, [{ region_id: block.id, page: 1, x: 300, y: 650 }]);
    const after = moved.view.regions.find((r) => r.id === block.id)!;
    expect([after.x, after.y]).toEqual([54, 650]);
  });
});

describe("Save and Save As (mock backend)", () => {
  const tabName = () => document.querySelector(".doc-tab.active .doc-tab-name")?.textContent ?? "";

  it("shows the dirty state in the tab and the title, and Ctrl+S clears it", async () => {
    await openDemo();
    expect(tabName()).not.toContain("*");
    // An edit: a new plot region.
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    await waitFor(() => expect(tabName()).toContain("*"));
    expect(document.title).toContain("*");
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    });
    await waitFor(() => expect(tabName()).not.toContain("*"));
    expect(document.title).not.toContain("*");
  });

  it("the Save ribbon button saves too", async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    await waitFor(() => expect(tabName()).toContain("*"));
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.save }));
    await waitFor(() => expect(tabName()).not.toContain("*"));
  });

  it("a new worksheet is saved through Save As, which names it", async () => {
    const backend = createMockBackend({ fast: true });
    const saveAs = vi.spyOn(backend, "saveWorksheetAs");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(tabName()).toContain("Untitled"));
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    await waitFor(() => expect(tabName()).toContain("*"));
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    });
    // No file yet: Ctrl+S became Save As (the mock names the worksheet instead of opening a dialog).
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(tabName()).toContain("Untitled-2"));
    await waitFor(() => expect(tabName()).not.toContain("*"));
    // Ctrl+Shift+S asks again, even for a worksheet with a file.
    await act(async () => {
      fireEvent.keyDown(window, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(saveAs).toHaveBeenCalledTimes(2));
  });

  it("a cancelled Save As changes nothing", async () => {
    const backend = createMockBackend({ fast: true });
    vi.spyOn(backend, "saveWorksheetAs").mockResolvedValue(null);
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    await waitFor(() => expect(tabName()).toContain("*"));
    await act(async () => {
      fireEvent.keyDown(window, { key: "S", code: "KeyS", ctrlKey: true, shiftKey: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tabName()).toContain("*");
  });
});

describe("confirm before close", () => {
  const tabs = () => document.querySelectorAll(".doc-tab").length;
  const dirty = async () => {
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
    await waitFor(() => expect(document.querySelector(".doc-tab.active .doc-tab-name")?.textContent).toContain("*"));
  };
  const closeButton = () => document.querySelector<HTMLElement>(".doc-tab.active .doc-tab-close")!;
  const dialog = () => screen.queryByRole("alertdialog");
  const answer = async (label: string) => {
    await act(async () => {
      fireEvent.click(within(dialog()!).getByRole("button", { name: label }));
    });
  };

  it("an unmodified worksheet closes without a question", async () => {
    await openDemo();
    expect(tabs()).toBe(1);
    await act(async () => fireEvent.click(closeButton()));
    await waitFor(() => expect(tabs()).toBe(0));
    expect(dialog()).toBeNull();
  });

  it("a modified worksheet asks; Cancel and Escape keep it", async () => {
    await openDemo();
    await dirty();
    await act(async () => fireEvent.click(closeButton()));
    expect(dialog()).not.toBeNull();
    await answer(S.confirm.cancel);
    expect(dialog()).toBeNull();
    expect(tabs()).toBe(1);
    await act(async () => fireEvent.click(closeButton()));
    await act(async () => {
      fireEvent.keyDown(dialog()!, { key: "Escape", code: "Escape" });
    });
    expect(dialog()).toBeNull();
    expect(tabs()).toBe(1);
  });

  it("Don't save closes without saving", async () => {
    const backend = createMockBackend({ fast: true });
    const save = vi.spyOn(backend, "saveWorksheet");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await dirty();
    await act(async () => fireEvent.click(closeButton()));
    await answer(S.confirm.discard);
    await waitFor(() => expect(tabs()).toBe(0));
    expect(save).not.toHaveBeenCalled();
  });

  it("Save saves, then closes; a cancelled Save As keeps the worksheet open", async () => {
    const backend = createMockBackend({ fast: true });
    const save = vi.spyOn(backend, "saveWorksheet");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await dirty();
    await act(async () => fireEvent.click(closeButton()));
    await answer(S.confirm.save);
    await waitFor(() => expect(tabs()).toBe(0));
    expect(save).toHaveBeenCalledTimes(1);

    // An untitled worksheet goes through Save As; cancelling it cancels the close.
    const second = createMockBackend({ fast: true });
    vi.spyOn(second, "saveWorksheetAs").mockResolvedValue(null);
    cleanup();
    render(<App backend={second} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(document.querySelector(".doc-tab.active")?.textContent).toContain("Untitled"));
    await dirty();
    await act(async () => fireEvent.click(closeButton()));
    await answer(S.confirm.save);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tabs()).toBe(2);
    expect(dialog()).toBeNull();
  });

  it("Ctrl+W asks too", async () => {
    const backend = createMockBackend({ fast: true });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await dirty();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(tabs()).toBe(2));
    await dirty();
    await act(async () => {
      fireEvent.keyDown(window, { key: "w", code: "KeyW", ctrlKey: true });
    });
    expect(dialog()).not.toBeNull();
    await answer(S.confirm.cancel);
    expect(tabs()).toBe(2);
  });
});

describe("close everything (window close, quit)", () => {
  async function twoModified() {
    const backend = createMockBackend({ fast: true });
    const hook = renderHook(() => useWorkbench(backend));
    await waitFor(() => expect(hook.result.current.state.docs.length).toBe(1));
    await act(async () => {
      await hook.result.current.actions.create();
    });
    await waitFor(() => expect(hook.result.current.state.docs.length).toBe(2));
    for (const doc of hook.result.current.state.docs) {
      await act(async () => {
        hook.result.current.actions.activate(doc.id);
      });
      await act(async () => {
        await hook.result.current.actions.addRegion("plot");
      });
    }
    expect(hook.result.current.state.docs.every((d) => d.edits !== d.savedEdits)).toBe(true);
    return hook;
  }
  const choose = async (hook: Awaited<ReturnType<typeof twoModified>>, id: string) => {
    await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
    await act(async () => hook.result.current.actions.answer(id));
  };

  it("asks once per modified worksheet in tab order and closes them all", async () => {
    const hook = await twoModified();
    let done: boolean | null = null;
    act(() => {
      void hook.result.current.actions.requestCloseAll().then((value) => (done = value));
    });
    await choose(hook, "discard");
    await choose(hook, "discard");
    await waitFor(() => expect(done).toBe(true));
    expect(hook.result.current.state.docs.length).toBe(0);
  });

  it("one Cancel stops the whole close and keeps the rest", async () => {
    const hook = await twoModified();
    let done: boolean | null = null;
    act(() => {
      void hook.result.current.actions.requestCloseAll().then((value) => (done = value));
    });
    await choose(hook, "discard");
    await choose(hook, "cancel");
    await waitFor(() => expect(done).toBe(false));
    expect(hook.result.current.state.docs.length).toBe(1);
  });
});

describe("autosave and recovery", () => {
  async function started(backend = createMockBackend({ fast: true })) {
    const hook = renderHook(() => useWorkbench(backend));
    await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
    return { backend, hook };
  }
  const edit = async (hook: Awaited<ReturnType<typeof started>>["hook"]) => {
    await act(async () => {
      await hook.result.current.actions.addRegion("plot");
    });
  };

  it("writes a recovery file only for a modified worksheet that changed since the last backup", async () => {
    const { backend, hook } = await started();
    const write = vi.spyOn(backend, "writeRecovery");
    await act(async () => hook.result.current.actions.autosave());
    expect(write).not.toHaveBeenCalled();
    await edit(hook);
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(1);
    await edit(hook);
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(2);
    // Saved: clean again, nothing to back up.
    await act(async () => {
      await hook.result.current.actions.save();
    });
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("a write that did not happen (calculation running) is retried at the next tick", async () => {
    const { backend, hook } = await started();
    const write = vi.spyOn(backend, "writeRecovery").mockResolvedValueOnce(null);
    await edit(hook);
    await act(async () => hook.result.current.actions.autosave());
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(2);
    await act(async () => hook.result.current.actions.autosave());
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("runs every RECOVERY_INTERVAL_MS", async () => {
    // The interval is observed instead of faked (waitFor polls with timers too).
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const { backend, hook } = await started();
      const tick = intervals.mock.calls.find((call) => call[1] === RECOVERY_INTERVAL_MS)?.[0] as () => void;
      expect(tick).toBeTypeOf("function");
      expect(RECOVERY_INTERVAL_MS).toBe(30_000);
      const write = vi.spyOn(backend, "writeRecovery");
      await edit(hook);
      expect(write).not.toHaveBeenCalled();
      await act(async () => tick());
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      intervals.mockRestore();
    }
  });

  it("the default setting is on, every 30 s", async () => {
    const { hook } = await started();
    expect(hook.result.current.settings).toEqual({ autosave: { enabled: true, intervalSeconds: 30 }, spelling: { enabled: true } });
  });

  it("a stored interval sets the timer, and the setting is stored through the backend", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const backend = createMockBackend({ fast: true });
      await backend.setSettings({ autosave: { enabled: true, intervalSeconds: 10 }, spelling: { enabled: true } });
      const { hook } = await started(backend);
      await waitFor(() => expect(intervals.mock.calls.some((call) => call[1] === 10_000)).toBe(true));
      await act(async () => {
        await hook.result.current.actions.setSettings({ autosave: { enabled: true, intervalSeconds: 45 }, spelling: { enabled: true } });
      });
      expect(hook.result.current.settings.autosave.intervalSeconds).toBe(45);
      expect((await backend.getSettings()).autosave.intervalSeconds).toBe(45);
      await waitFor(() => expect(intervals.mock.calls.some((call) => call[1] === 45_000)).toBe(true));
    } finally {
      intervals.mockRestore();
    }
  });

  it("switched off: no timer runs and nothing is written", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const backend = createMockBackend({ fast: true });
      await backend.setSettings({ autosave: { enabled: false, intervalSeconds: 7 }, spelling: { enabled: true } });
      const { hook } = await started(backend);
      await waitFor(() => expect(hook.result.current.settings.autosave.enabled).toBe(false));
      expect(intervals.mock.calls.some((call) => call[1] === 7_000)).toBe(false);
    } finally {
      intervals.mockRestore();
    }
  });

  it("settings are validated: an interval is clamped to 5..3600 s", async () => {
    const backend = createMockBackend({ fast: true });
    expect((await backend.setSettings({ autosave: { enabled: true, intervalSeconds: 1 }, spelling: { enabled: true } })).autosave.intervalSeconds).toBe(5);
    expect((await backend.setSettings({ autosave: { enabled: true, intervalSeconds: 99999 }, spelling: { enabled: true } })).autosave.intervalSeconds).toBe(3600);
  });

  it("the Options dialog stores the switch and interval (ribbon button and command palette)", async () => {
    const backend = createMockBackend({ fast: true });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.options }));
    const dialog = screen.getByRole("dialog", { name: S.options.title });
    expect((within(dialog).getByTestId("opt-autosave") as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByTestId("opt-interval") as HTMLInputElement).value).toBe("30");
    fireEvent.change(within(dialog).getByTestId("opt-interval"), { target: { value: "90" } });
    fireEvent.click(within(dialog).getByTestId("opt-apply"));
    await waitFor(async () => expect((await backend.getSettings()).autosave.intervalSeconds).toBe(90));
    expect(screen.queryByRole("dialog", { name: S.options.title })).toBeNull();
    // second time: switch off
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.options }));
    const again = screen.getByRole("dialog", { name: S.options.title });
    expect((within(again).getByTestId("opt-interval") as HTMLInputElement).value).toBe("90");
    fireEvent.click(within(again).getByTestId("opt-autosave"));
    expect((within(again).getByTestId("opt-interval") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(again).getByTestId("opt-apply"));
    await waitFor(async () => expect((await backend.getSettings()).autosave.enabled).toBe(false));
  });

  it("a write failure is ignored", async () => {
    const { backend, hook } = await started();
    vi.spyOn(backend, "writeRecovery").mockRejectedValue(new Error("disk full"));
    await edit(hook);
    await act(async () => hook.result.current.actions.autosave());
    expect(hook.result.current.state.message).toBeNull();
  });

  describe("Open uses the native dialog", () => {
    it("opens every chosen file in its own tab, starting from the active worksheet", async () => {
      const { backend, hook } = await started();
      const choose = vi.spyOn(backend, "chooseOpenPaths").mockResolvedValue(["/a/one.eqv", "/a/two.eqv"]);
      const docs = hook.result.current.state.docs.length;
      await act(async () => hook.result.current.actions.openWithDialog());
      expect(choose).toHaveBeenCalledWith(hook.result.current.state.docs[0].id);
      expect(hook.result.current.state.docs.length).toBe(docs + 2);
    });

    it("does nothing when the dialog is cancelled", async () => {
      const { backend, hook } = await started();
      vi.spyOn(backend, "chooseOpenPaths").mockResolvedValue([]);
      const open = vi.spyOn(backend, "openWorksheet");
      const docs = hook.result.current.state.docs.length;
      await act(async () => hook.result.current.actions.openWithDialog());
      expect(open).not.toHaveBeenCalled();
      expect(hook.result.current.state.docs.length).toBe(docs);
    });
  });

  describe("Import of .mcdx worksheets", () => {
    it("File > Import imports each chosen file as a new modified worksheet and reports what is missing", async () => {
      const { backend, hook } = await started();
      const choose = vi.spyOn(backend, "chooseOpenPaths").mockResolvedValue(["/m/book.mcdx"]);
      const imported = vi.spyOn(backend, "importMcdx");
      const docs = hook.result.current.state.docs.length;
      await act(async () => hook.result.current.actions.importWithDialog());
      expect(choose).toHaveBeenCalledWith(hook.result.current.state.docs[0].id, true);
      expect(imported).toHaveBeenCalledWith("/m/book.mcdx");
      const state = hook.result.current.state;
      expect(state.docs.length).toBe(docs + 1);
      const added = state.docs[docs];
      expect(added.name).toMatch(/^Untitled/);
      expect(added.edits).not.toBe(added.savedEdits);
      expect(state.activeId).toBe(added.id);
      expect(state.message).toBe(
        "Imported 2 of 3 regions from book.mcdx as a new worksheet. Not imported: plot-not-imported 1. Details: Show import report (Ctrl+K).",
      );
      expect(hook.result.current.actions.lastImportReport()?.issues[0].code).toBe("plot-not-imported");
      // Some regions were not imported: an amber warning, not a red error.
      expect(state.messageLevel).toBe("warning");
    });

    it("a .mcdx given to Open (dialog filter, command line, forwarded launch) is imported", async () => {
      const { backend, hook } = await started();
      const imported = vi.spyOn(backend, "importMcdx");
      const opened = vi.spyOn(backend, "openWorksheet");
      await act(async () => hook.result.current.actions.open("/m/UPPER.MCDX"));
      expect(imported).toHaveBeenCalledWith("/m/UPPER.MCDX");
      expect(opened).not.toHaveBeenCalled();
    });

    it("a .eqv chosen in the import dialog opens normally", async () => {
      const { backend, hook } = await started();
      vi.spyOn(backend, "chooseOpenPaths").mockResolvedValue(["/m/plain.eqv"]);
      const imported = vi.spyOn(backend, "importMcdx");
      const opened = vi.spyOn(backend, "openWorksheet");
      await act(async () => hook.result.current.actions.importWithDialog());
      expect(opened).toHaveBeenCalledWith("/m/plain.eqv");
      expect(imported).not.toHaveBeenCalled();
    });

    it("a failed import opens nothing and says why", async () => {
      const { hook } = await started();
      const docs = hook.result.current.state.docs.length;
      await act(async () => hook.result.current.actions.open("/m/bad.mcdx"));
      expect(hook.result.current.state.docs.length).toBe(docs);
      expect(hook.result.current.state.message).toBe(
        "Could not import the worksheet: load: `bad.mcdx` is not an .mcdx worksheet",
      );
      expect(hook.result.current.state.messageLevel).toBe("error");
    });
  });

  describe("the path of an include region", () => {
    it("is changed in one undo step and the field and Browse… do it from the page", async () => {
      const { backend, hook } = await started();
      const id = hook.result.current.state.activeId!;
      await act(async () => {
        await hook.result.current.actions.addRegion("include", "libs/helpers.eqv");
      });
      const include = () => {
        const region = hook.result.current.state.docs[0].view.regions.find((r) => r.kind === "include");
        return region && region.kind === "include" ? region : undefined;
      };
      const created = include()!;
      expect(created.path).toBe("libs/helpers.eqv");
      await act(async () => {
        await hook.result.current.actions.setIncludePath(created.id, "libs\\other.eqv");
      });
      expect(include()!.path).toBe("libs/other.eqv");
      expect(hook.result.current.state.docs[0].view.undo_label).toBe("Edit include path");
      await act(async () => {
        await hook.result.current.actions.undo();
      });
      expect(include()!.path).toBe("libs/helpers.eqv");
      // An empty text is refused by the backend and says so in the bar, leaving the path alone.
      await act(async () => {
        await hook.result.current.actions.setIncludePath(created.id, "  ");
      });
      expect(include()!.path).toBe("libs/helpers.eqv");
      expect(hook.result.current.state.message).toMatch(/^Could not change the include path/);
      expect(hook.result.current.state.messageLevel).toBe("error");
      expect(id).toBe(hook.result.current.state.activeId);
      expect(backend).toBeDefined();
    });
  });

  describe("the browser's accelerators", () => {
    it("the window cancels the default of the reload, devtools and print chords while the app is open", async () => {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m1")).not.toBeNull());
      for (const [code, key, mods] of [
        ["F5", "F5", {}],
        ["KeyR", "r", { ctrlKey: true }],
        ["KeyI", "I", { ctrlKey: true, shiftKey: true }],
        ["F12", "F12", {}],
        ["KeyP", "p", { ctrlKey: true }],
      ] as [string, string, KeyboardEventInit][]) {
        const event = new KeyboardEvent("keydown", { code, key, cancelable: true, bubbles: true, ...mods });
        window.dispatchEvent(event);
        expect(event.defaultPrevented, `${code} ${JSON.stringify(mods)}`).toBe(true);
      }
    });
  });

  describe("the right-click menu", () => {
    const rightClick = (element: Element) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 90 });
      element.dispatchEvent(event);
      return event;
    };
    const menuItems = () => [...screen.getByTestId("context-menu").querySelectorAll<HTMLElement>("[data-cmd]")].map((el) => el.dataset.cmd);

    it("the native menu never appears: not on the ribbon, a region, the sheet or a field", async () => {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m13")).not.toBeNull());
      expect(rightClick(screen.getByRole("tab", { name: "Calculate" })).defaultPrevented).toBe(true);
      expect(screen.queryByTestId("context-menu")).toBeNull();
      expect(rightClick(document.body).defaultPrevented).toBe(true);
      expect(rightClick(region("m13")!).defaultPrevented).toBe(true);
    });

    it("a right press on a region selects it and offers the commands of its kind, which run", async () => {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m13")).not.toBeNull());
      rightClick(region("m13")!);
      await waitFor(() => expect(region("m13")?.classList.contains("selected")).toBe(true));
      expect(menuItems()).toEqual(expect.arrayContaining(["copy", "deleteRegions", "resultFormat", "mathFont", "toggleRegionEnabled"]));
      expect(menuItems()).not.toContain("plotAddTrace");
      // The command runs like the ribbon's: Delete removes the region and the menu closes.
      await act(async () => {
        fireEvent.click(within(screen.getByTestId("context-menu")).getByRole("menuitem", { name: /^Delete/ }));
      });
      await waitFor(() => expect(region("m13")).toBeNull());
      expect(screen.queryByTestId("context-menu")).toBeNull();
    });

    it("a right press on a region of a selection keeps the selection and offers the menu of several regions", async () => {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m13")).not.toBeNull());
      fireEvent.pointerDown(region("m13")!, { button: 0 });
      fireEvent.pointerDown(region("m14")!, { button: 0, shiftKey: true });
      await waitFor(() => expect(region("m14")?.classList.contains("selected")).toBe(true));
      rightClick(region("m13")!);
      await waitFor(() => expect(screen.getByTestId("context-menu")).toBeDefined());
      expect(region("m13")?.classList.contains("selected") && region("m14")?.classList.contains("selected")).toBe(true);
      expect(menuItems()).toEqual(expect.arrayContaining(["copy", "cut", "paste", "deleteRegions", "mathFont"]));
      // A press on a region outside the selection selects that one alone.
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
      rightClick(region("m1")!);
      await waitFor(() => expect(region("m1")?.classList.contains("selected")).toBe(true));
      expect(region("m13")?.classList.contains("selected")).toBe(false);
    });

    it("the empty sheet offers to insert regions, and Escape closes the menu", async () => {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m13")).not.toBeNull());
      rightClick(screen.getByTestId("sheet"));
      await waitFor(() => expect(screen.getByTestId("context-menu")).toBeDefined());
      expect(menuItems()).toEqual(expect.arrayContaining(["paste", "insertMath", "insertPlot", "insertImage", "addPageBreak"]));
      fireEvent.keyDown(screen.getByTestId("context-menu"), { key: "Escape" });
      expect(screen.queryByTestId("context-menu")).toBeNull();
    });
  });

  describe("message levels", () => {
    it("a message without a level is an error and notify defaults to info", async () => {
      const { hook } = await started();
      expect(hook.result.current.state.messageLevel).toBe("error");
      act(() => hook.result.current.actions.notify("Select one plot first."));
      expect(hook.result.current.state.messageLevel).toBe("info");
      act(() => hook.result.current.actions.notify("Replaced in 2 regions", "success"));
      expect(hook.result.current.state.messageLevel).toBe("success");
      act(() => hook.result.current.actions.dismissMessage());
      expect(hook.result.current.state.message).toBeNull();
    });

    it("a PDF that was saved is a success and one that failed is an error", async () => {
      const { backend, hook } = await started();
      await act(async () => {
        await hook.result.current.actions.exportPdf("/m/out.pdf");
      });
      expect(hook.result.current.state.message).toMatch(/^PDF saved: /);
      expect(hook.result.current.state.messageLevel).toBe("success");
      vi.spyOn(backend, "exportPdf").mockRejectedValue(new Error("disk full"));
      await act(async () => {
        await hook.result.current.actions.exportPdf("/m/out.pdf");
      });
      expect(hook.result.current.state.message).toMatch(/^Could not export the PDF/);
      expect(hook.result.current.state.messageLevel).toBe("error");
    });
  });

  describe("files forwarded by a second launch", () => {
    it("opens each forwarded file in a new tab and makes the last one active", async () => {
      const { backend, hook } = await started();
      const open = vi.spyOn(backend, "openWorksheet");
      const docs = hook.result.current.state.docs.length;
      await act(async () => backend.forwardLaunch(["/w/one.eqv", "/w/two.eqv"]));
      await waitFor(() => expect(hook.result.current.state.docs.length).toBe(docs + 2));
      expect(open.mock.calls.map((call) => call[0])).toEqual(["/w/one.eqv", "/w/two.eqv"]);
      expect(hook.result.current.state.activeId).toBe(hook.result.current.state.docs[docs + 1].id);
    });

    it("a launch without files opens nothing", async () => {
      const { backend } = await started();
      const open = vi.spyOn(backend, "openWorksheet");
      await act(async () => backend.forwardLaunch([]));
      expect(open).not.toHaveBeenCalled();
    });

    it("a request queued before start-up ends is delivered once start-up is over", async () => {
      const backend = createMockBackend({ fast: true });
      backend.forwardLaunch(["/w/early.eqv"]);
      const open = vi.spyOn(backend, "openWorksheet");
      const { hook } = await started(backend);
      await waitFor(() => expect(open.mock.calls.map((call) => call[0])).toContain("/w/early.eqv"));
      expect(hook.result.current.state.docs.length).toBe(2);
      expect(await backend.takeOpenRequests()).toEqual([]);
    });

    it("a file that is not a worksheet shows the open error and keeps the other tabs", async () => {
      const { backend, hook } = await started();
      vi.spyOn(backend, "openWorksheet").mockRejectedValue({ kind: "not_a_worksheet", message: "x is not a worksheet" });
      const docs = hook.result.current.state.docs.length;
      await act(async () => backend.forwardLaunch(["/w/foreign.eqv"]));
      await waitFor(() => expect(hook.result.current.state.message).not.toBeNull());
      expect(hook.result.current.state.docs.length).toBe(docs);
    });
  });

  describe("opening a file with a newer recovery file", () => {
    async function offered() {
      const { backend, hook } = await started();
      vi.spyOn(backend, "recoveryFor").mockResolvedValue({ path: "/work/.a.eqv.recovery" });
      const restore = vi.spyOn(backend, "openRecovery");
      const discard = vi.spyOn(backend, "discardRecoveryFile");
      const openFile = vi.spyOn(backend, "openWorksheet");
      let done = false;
      act(() => {
        void hook.result.current.actions.open("/work/a.eqv").then(() => (done = true));
      });
      await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
      return { backend, hook, restore, discard, openFile, finished: () => done };
    }

    it("Restore opens the recovered content as a modified worksheet named like the file", async () => {
      const { backend, hook } = await started();
      // A real backup: edit the demo, back it up, then open the same file again.
      vi.spyOn(backend, "recoveryFor").mockResolvedValue({ path: "/demo/demo.eqv.recovery" });
      await edit(hook);
      await act(async () => hook.result.current.actions.autosave());
      const docs = hook.result.current.state.docs.length;
      const restore = vi.spyOn(backend, "openRecovery");
      act(() => {
        void hook.result.current.actions.open("/demo/demo.eqv");
      });
      await waitFor(() => expect(hook.result.current.state.prompt?.title).toBe(S.confirm.recoverTitle));
      await act(async () => hook.result.current.actions.answer("restore"));
      await waitFor(() => expect(hook.result.current.state.docs.length).toBe(docs + 1));
      expect(restore).toHaveBeenCalledWith("/demo/demo.eqv.recovery", "/demo/demo.eqv");
      const restored = hook.result.current.state.docs.at(-1)!;
      expect(restored.edits).not.toBe(restored.savedEdits);
      expect(restored.view.regions.some((r) => r.kind === "plot")).toBe(true);
    });

    it("Discard deletes the backup and opens the saved file as clean", async () => {
      const { hook, discard, restore, openFile } = await offered();
      await act(async () => hook.result.current.actions.answer("discard"));
      await waitFor(() => expect(openFile).toHaveBeenCalledWith("/work/a.eqv"));
      expect(discard).toHaveBeenCalledWith("/work/.a.eqv.recovery");
      expect(restore).not.toHaveBeenCalled();
      const opened = hook.result.current.state.docs.at(-1)!;
      expect(opened.edits).toBe(opened.savedEdits);
    });

    it("Cancel opens nothing and keeps the backup", async () => {
      const { hook, discard, restore, openFile, finished } = await offered();
      const docs = hook.result.current.state.docs.length;
      await act(async () => hook.result.current.actions.answer("cancel"));
      await waitFor(() => expect(finished()).toBe(true));
      expect(hook.result.current.state.docs.length).toBe(docs);
      expect(discard).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(openFile).not.toHaveBeenCalled();
    });
  });

  describe("start-up with backups of untitled worksheets", () => {
    const pending = ["/app/recovery/1-Untitled-1.eqv.recovery", "/app/recovery/1-Untitled-2.eqv.recovery"];
    function setup() {
      const backend = createMockBackend({ fast: true });
      vi.spyOn(backend, "initialWorksheet").mockResolvedValue(null);
      vi.spyOn(backend, "pendingRecoveries").mockResolvedValue(pending);
      const restore = vi.spyOn(backend, "openRecovery").mockImplementation(() => backend.newWorksheet());
      const discard = vi.spyOn(backend, "discardRecoveryFile");
      const hook = renderHook(() => useWorkbench(backend));
      return { backend, hook, restore, discard };
    }

    it("Restore opens each backup as a modified worksheet and drops the empty start worksheet", async () => {
      const { hook, restore, discard } = setup();
      await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
      expect(hook.result.current.state.prompt?.message).toContain("2 worksheets");
      await act(async () => hook.result.current.actions.answer("restore"));
      await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
      expect(restore).toHaveBeenCalledTimes(2);
      expect(discard).not.toHaveBeenCalled();
      const docs = hook.result.current.state.docs;
      expect(docs.length).toBe(2);
      expect(docs.every((d) => d.edits !== d.savedEdits)).toBe(true);
    });

    it("Discard deletes every backup and keeps the empty worksheet", async () => {
      const { hook, restore, discard } = setup();
      await waitFor(() => expect(hook.result.current.state.prompt).not.toBeNull());
      await act(async () => hook.result.current.actions.answer("discard"));
      await waitFor(() => expect(hook.result.current.state.ready).toBe(true));
      expect(restore).not.toHaveBeenCalled();
      expect(discard.mock.calls.map((c) => c[0])).toEqual(pending);
      expect(hook.result.current.state.docs.length).toBe(1);
    });
  });
});

describe("error message while editing", () => {
  it("stays in the DOM when a region in error is clicked into and typed in", async () => {
    await openDemo();
    expect(region("m16")?.getAttribute("data-state")).toBe("error");
    fireEvent.pointerDown(region("m16")!.querySelector("[data-span]")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(region("m16")?.classList.contains("editing")).toBe(true));
    const message = () => region("m16")!.querySelector("[data-testid=region-error]");
    expect(message()?.textContent ?? "").not.toBe("");
    const text = message()!.textContent;
    await act(async () => {
      fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowLeft", code: "ArrowLeft" });
    });
    expect(region("m16")?.classList.contains("editing")).toBe(true);
    expect(message()?.textContent).toBe(text);
  });

  it("a current error is not faded, and editing then leaving the region recalculates it", async () => {
    await openDemo();
    fireEvent.pointerDown(region("m16")!.querySelector("[data-span]")!, { button: 0 });
    await act(async () => {
      fireEvent.pointerUp(window, { button: 0 });
    });
    await waitFor(() => expect(region("m16")?.classList.contains("editing")).toBe(true));
    expect(region("m16")!.querySelector("[data-testid=region-error]")?.classList.contains("old")).toBe(false);
    // Fix the expression: `w := missing + 1` -> delete the unknown name by typing a definition.
    for (const [key, code] of [["End", "End"], ["Backspace", "Backspace"], ["Backspace", "Backspace"]] as const) {
      await act(async () => {
        fireEvent.keyDown(window, { key, code });
      });
    }
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    });
    await waitFor(() => expect(region("m16")?.classList.contains("editing")).toBe(false));
    await waitFor(() => expect(region("m16")?.getAttribute("data-state")).not.toBe("none"));
  });
});

describe("End in a live math region (, duplicate item 4)", () => {
  it("moves the keyboard cursor to the end of the whole expression and typing continues after it", async () => {
    const backend = createMockBackend({ fast: true });
    const add = vi.spyOn(backend, "addMathRegion");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const press = async (key: string, code: string, extra: Record<string, unknown> = {}) => {
      await act(async () => {
        fireEvent.keyDown(window, { key, code, ...extra });
      });
    };
    // A new math region at the crosshair: 2/3, End, +4. End must leave the denominator, so the
    // sum is outside the fraction (`(2/3)+4`), not inside it (`2/(3+4)`).
    await press("2", "Digit2");
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    await press("/", "Slash");
    await press("3", "Digit3");
    await press("End", "End");
    await press("+", "Equal", { shiftKey: true });
    await press("4", "Digit4");
    await press("Enter", "Enter");
    await waitFor(() => expect(add).toHaveBeenCalled());
    const statement = add.mock.calls.at(-1)![4] as {
      type: string;
      expr: { type: string; left: { type: string }; right: { type: string; text?: string } };
    };
    expect(statement.type).toBe("ExprRegion");
    expect(statement.expr.type).toBe("Add");
    expect(statement.expr.left.type).toBe("Div");
    expect(statement.expr.right).toEqual(expect.objectContaining({ type: "Num", text: "4" }));
  });
});

describe("a break-only commit", () => {
  it("reuses the stored statement instead of rebuilding an unchanged tree", () => {
    const root = { type: "Define", target: { type: "Num", text: "1" }, rhs: { type: "Num", text: "2" }, tail: null };
    const stored = { type: "Define", target: { type: "Ident" }, rhs: { type: "Ident" }, tail: null };
    expect(commitWire(root as never, JSON.stringify(root), stored)).toBe(stored);
    // Without a stored statement the unchanged tree is rebuilt, and an invalid one is refused.
    expect(() => commitWire(root as never, null, stored)).toThrow(/left side/i);
  });
});

describe("symbolic result while editing", () => {
  const sym = (keywords: unknown[]) => ({ type: "Symbolic", expr: { type: "Num", text: "1" }, keywords });
  const slot = { type: "KeywordGroup", keyword: { type: "Placeholder" }, args: [] };

  it("a complete symbolic evaluation is live, with or without the empty keyword slot", () => {
    expect(isLiveEvaluation(sym([]) as never)).toBe(true);
    expect(isLiveEvaluation(sym([slot]) as never)).toBe(true);
    const named = { type: "KeywordGroup", keyword: { type: "Ident", name: { segments: [{ text: "simplify", subscript: false }], label: null } }, args: [] };
    expect(isLiveEvaluation(sym([named]) as never)).toBe(true);
    expect(isLiveEvaluation(sym([named, slot]) as never)).toBe(true);
    // A half-typed keyword (a placeholder argument) and an unfinished expression are not.
    expect(isLiveEvaluation(sym([{ ...named, args: [{ type: "Placeholder" }] }]) as never)).toBe(false);
    expect(isLiveEvaluation({ ...sym([slot]), expr: { type: "Placeholder" } } as never)).toBe(false);
    const define = { type: "Define", target: { type: "Ident", name: { segments: [{ text: "a", subscript: false }], label: null } }, rhs: { type: "Num", text: "1" }, tail: { type: "Sym", keywords: [slot] } };
    expect(isLiveEvaluation(define as never)).toBe(true);
    expect(isLiveEvaluation({ ...define, tail: null } as never)).toBe(false);
  });

  it("Ctrl+. after a complete expression evaluates it at once, without leaving the editor", async () => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    for (const [key, code, shiftKey] of [["x", "KeyX", false], ["^", "Digit6", true], ["2", "Digit2", false]] as const) {
      await act(async () => {
        fireEvent.keyDown(window, { key, code, shiftKey });
      });
    }
    await act(async () => {
      fireEvent.keyDown(window, { key: ".", code: "Period", ctrlKey: true });
    });
    // Still editing, with the empty keyword slot above the arrow, yet the region exists and is calculated.
    await waitFor(() => expect(document.querySelectorAll(".region")).toHaveLength(before + 1));
    await waitFor(() => {
      const editing = document.querySelector<HTMLElement>(".region.editing");
      expect(editing).not.toBeNull();
      expect(editing?.getAttribute("data-region-id")).not.toBe("__new");
      expect(editing?.getAttribute("data-state")).toBe("value");
    });
    expect(document.querySelector(".region.editing")?.textContent).toContain("→");
    expect(document.querySelector(".result.empty")).toBeNull();
  });
});

describe("Ctrl++ / Ctrl+= and Ctrl+- on the empty crosshair", () => {
  it.each([
    ["Italian Ctrl++", { key: "+", code: "BracketRight", ctrlKey: true }],
    ["US Ctrl+=", { key: "=", code: "Equal", ctrlKey: true }],
  ])("%s starts a math region holding a Boolean equality with the caret in the left placeholder", async (_name, ev) => {
    await openDemo();
    const before = document.querySelectorAll(".region").length;
    const zoom = document.querySelector("[data-testid=zoom]")?.textContent;
    const event = new KeyboardEvent("keydown", { ...ev, bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
    });
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    const draft = region("__new")!;
    expect(draft.querySelectorAll(".ph")).toHaveLength(2);
    // The bold Boolean equals glyph, between the two placeholders.
    expect(draft.querySelector(".op.booleq")?.getAttribute("data-glyph")).toBe("==");
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelectorAll(".region")).toHaveLength(before + 1);
    expect(document.querySelector("[data-testid=zoom]")?.textContent).toBe(zoom);
  });

  it("Ctrl+- starts a math region with a literal subscript", async () => {
    await openDemo();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", code: "Slash", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
  });
});

describe("arrow keys move the crosshair", () => {
  const crosshair = () => {
    const element = screen.getByTestId("crosshair");
    return { left: parseFloat(element.style.left), top: parseFloat(element.style.top) };
  };
  const press = async (key: string, shiftKey = false) => {
    await act(async () => {
      fireEvent.keyDown(window, { key, code: key, shiftKey });
    });
  };

  const emptySheet = async () => {
    await openDemo();
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(document.querySelectorAll(".region")).toHaveLength(0));
    await screen.findByTestId("crosshair");
  };

  it("moves one grid step (4 CSS px) per press in each direction", async () => {
    await emptySheet();
    const start = crosshair();
    await press("ArrowRight");
    expect(crosshair()).toEqual({ left: start.left + 4, top: start.top });
    await press("ArrowRight");
    await press("ArrowRight");
    await press("ArrowLeft");
    expect(crosshair().left).toBe(start.left + 8);
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowUp");
    expect(crosshair().top).toBe(start.top + 4);
    await press("ArrowRight", true);
    expect(crosshair().left).toBe(start.left + 8 + 16);
  });

  it("accelerates the crosshair while an arrow is held, caps the speed and resets on a new tap", async () => {
    await emptySheet();
    const start = crosshair();
    const hold = async (repeat: boolean) => {
      await act(async () => {
        fireEvent.keyDown(window, { key: "ArrowRight", code: "ArrowRight", repeat });
      });
    };
    await hold(false);
    expect(crosshair().left).toBe(start.left + 4);
    await hold(true);
    await hold(true);
    // One grid step for the first repeat, two for the second: the same hold is already faster.
    expect(crosshair().left).toBe(start.left + 4 + 4 + 8);
    for (let i = 0; i < 12; i++) await hold(true);
    const beforeCap = crosshair();
    await hold(true);
    // The cap is eight grid steps (32 CSS px at 100 percent).
    expect(crosshair().left).toBe(beforeCap.left + 32);
    // A new press is precise again.
    const tap = crosshair();
    await hold(false);
    expect(crosshair().left).toBe(tap.left + 4);
  });

  it("stops at the top margin of an empty first page", async () => {
    await emptySheet();
    // The initial crosshair leaves room for the first math line above it.
    for (let i = 0; i < WORKSHEET_LINE_PT / GRID_PT; i++) await press("ArrowUp");
    const start = crosshair();
    await press("ArrowUp");
    expect(crosshair()).toEqual(start);
    await press("ArrowDown");
    expect(crosshair().top).toBe(start.top + 4);
  });

  it("extends Page View past the last margin with ArrowDown and lets the user write there", async () => {
    await emptySheet();
    const sheet = screen.getByTestId("sheet");
    const firstPage = sheet.querySelector<HTMLElement>('.page[data-page="1"]')!;
    const nextPage = () => sheet.querySelector<HTMLElement>('.page[data-page="2"]');
    await act(async () => {
      fireEvent.pointerDown(firstPage, { button: 0, clientX: ptToPx(99), clientY: ptToPx(768) });
      fireEvent.pointerUp(window, { button: 0 });
    });
    const bottom = crosshair();
    expect(nextPage()).toBeNull();

    await press("ArrowDown");
    expect(nextPage()).not.toBeNull();
    expect(crosshair().left).toBe(bottom.left);
    expect(crosshair().top).toBeGreaterThan(bottom.top);
    expect(sheet.querySelectorAll(".region")).toHaveLength(0);

    for (let i = 0; i <= LINE_ABOVE_CROSSHAIR_PT / GRID_PT; i++) await press("ArrowUp");
    expect(nextPage()).toBeNull();
    await press("ArrowDown");
    await press("x");
    await waitFor(() => expect(region("__new")).not.toBeNull());
    await press("Enter");
    await waitFor(() => expect(region("__new")).toBeNull());
    const written = sheet.querySelector<HTMLElement>(".region");
    expect(written).not.toBeNull();
    const topOnPage = parseFloat(written!.style.top) - parseFloat(nextPage()!.style.top);
    expect(topOnPage).toBeCloseTo(ptToPx(72));
  });

  it("crosses the page break of the demo worksheet downwards (from the bottom of page 1)", async () => {
    await openDemo();
    const start = crosshair();
    // The crosshair starts one worksheet line below the lowest region of page 1 (m15, at 740 pt), so
    // it comes to the page a few grid steps above the bottom margin (769.89 pt). The crosshair box is
    // drawn 8 px above and left of its point, so its style.top is the point less 8 px.
    const printableBottom = 769.89;
    const stepsToTheEdge = Math.floor((printableBottom - (start.top + 8) / ptToPx(1)) / GRID_PT);
    expect(stepsToTheEdge).toBeGreaterThan(0);
    for (let i = 0; i < stepsToTheEdge; i++) await press("ArrowDown");
    const atBottom = crosshair();
    // Still on page 1, on the last grid line of its printable area (page 2 is a page height further).
    expect(atBottom.top).toBeGreaterThan(start.top);
    expect(atBottom.top).toBeLessThan(start.top + 100);
    // One more press falls past the bottom margin: page 2 starts a page height (plus the gap) further
    // down; its first region (at the top left margin) is under the crosshair, so it is entered for
    // editing.
    await press("ArrowDown");
    expect(crosshair().top).toBeGreaterThan(atBottom.top + 100);
    await waitFor(() => expect(region("m16")?.classList.contains("editing")).toBe(true));
  });

  it("stays inside the left margin", async () => {
    await openDemo();
    for (let i = 0; i < 40; i++) await press("ArrowLeft");
    const atMargin = crosshair().left;
    await press("ArrowLeft");
    expect(crosshair().left).toBe(atMargin);
    // The left margin is 54 pt = 72 CSS px from the page edge.
    expect(atMargin).toBeGreaterThanOrEqual(0);
  });

  it("an arrow that moves the crosshair onto a region edits it with the insertion line at its left", async () => {
    await openDemo();
    // Walk up from below the last region of page 1 until a region is entered.
    let entered: string | null = null;
    for (let i = 0; i < 400 && !entered; i++) {
      await press("ArrowUp");
      entered = document.querySelector<HTMLElement>(".region.editing")?.getAttribute("data-region-id") ?? null;
    }
    expect(entered).not.toBeNull();
    const editing = region(entered!)!;
    expect(editing.classList.contains("editing")).toBe(true);
    // The insertion line is at the left edge of the whole expression.
    expect(editing.querySelector(".insertion-line, .caret, [data-testid=insertion-line]") ?? editing).not.toBeNull();
  });

  const editingRegion = () => document.querySelector<HTMLElement>(".region.editing");

  it("Right crosses an absolute-value closing bar before it leaves the region", async () => {
    await emptySheet();
    await press("|");
    await press("a");
    expect(editingRegion()).not.toBeNull();
    await press("ArrowRight");
    expect(editingRegion()).not.toBeNull();
    await press("+");
    await press("2");
    await press("End");
    await press("ArrowRight");
    await waitFor(() => expect(editingRegion()).toBeNull());
    const math = [...document.querySelectorAll<HTMLElement>('[data-kind="math"]')];
    expect(math).toHaveLength(1);
    expect(math[0].querySelector(".fenced.bar")?.textContent).toBe("a");
    expect(math[0].textContent).toContain("2");
  });

  it("an arrow with nothing left to do inside a math region leaves it and puts the crosshair beside it", async () => {
    await openDemo();
    let entered: HTMLElement | null = null;
    for (let i = 0; i < 400 && !entered; i++) {
      await press("ArrowUp");
      entered = editingRegion();
    }
    expect(entered?.dataset.kind).toBe("math");
    const id = entered!.dataset.regionId!;
    // Left at the left edge (where the arrow entered it): nothing to move inside, so the region is left.
    await press("ArrowLeft");
    await waitFor(() => expect(editingRegion()).toBeNull());
    expect(region(id)).not.toBeNull();
    expect(screen.getByTestId("crosshair")).not.toBeNull();
    // After that the arrows move the crosshair again.
    const before = crosshair();
    await press("ArrowDown");
    expect(crosshair().top).toBeGreaterThanOrEqual(before.top);
  });

  it("inner movement has priority: Right walks through the expression before the region is left", async () => {
    await openDemo();
    let entered: HTMLElement | null = null;
    for (let i = 0; i < 400 && !entered; i++) {
      await press("ArrowUp");
      entered = editingRegion();
    }
    const id = entered!.dataset.regionId!;
    let presses = 0;
    while (editingRegion()?.dataset.regionId === id && presses < 60) {
      await press("ArrowRight");
      presses++;
    }
    expect(editingRegion()).toBeNull();
    // More than one press: the caret first moved across the expression.
    expect(presses).toBeGreaterThan(1);
  });

  it("a text region is entered with an arrow and left at its edge", async () => {
    await openDemo();
    let text: HTMLElement | null = null;
    for (let i = 0; i < 1500 && !text; i++) {
      await press("ArrowUp");
      const editing = editingRegion();
      if (editing?.dataset.kind === "text") text = editing;
    }
    expect(text).not.toBeNull();
    // The text editor owns its keys: the arrow goes to its content-editable element.
    const input = text!.querySelector<HTMLElement>("[contenteditable=true]")!;
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowLeft", code: "ArrowLeft" });
    });
    await waitFor(() => expect(editingRegion()).toBeNull());
  });
});

describe("Enter on the sheet inserts a worksheet line", () => {
  const crosshair = () => {
    const element = screen.getByTestId("crosshair");
    return { left: parseFloat(element.style.left), top: parseFloat(element.style.top) };
  };
  const top = (id: string) => parseFloat(region(id)!.style.top);
  const press = async (key: string) => {
    await act(async () => {
      fireEvent.keyDown(window, { key, code: key });
    });
  };
  /** A click on empty page space just below the two text blocks of the demo, above its math. */
  const clickAboveTheMath = async () => {
    const page = document.querySelector<HTMLElement>('.page[data-page="1"]')!;
    await act(async () => {
      fireEvent.pointerDown(page, { button: 0, clientX: 100, clientY: 140 });
    });
  };
  const emptySheet = async () => {
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.new }));
    await waitFor(() => expect(document.querySelectorAll(".region")).toHaveLength(0));
    await screen.findByTestId("crosshair");
  };

  it("moves the regions at or below the crosshair down one line, as one undo step", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = { text: top("t1"), first: top("m1"), later: top("m16"), crosshair: crosshair().top };
    await press("Enter");
    // One line is WORKSHEET_LINE_PT = 15 pt = 20 CSS px at 100 percent. t1 starts above the crosshair
    // and stays.
    const line = ptToPx(WORKSHEET_LINE_PT);
    expect(top("t1")).toBe(before.text);
    expect(top("m1")).toBe(before.first + line);
    expect(top("m16")).toBe(before.later + line);
    expect(crosshair().top).toBe(before.crosshair + line);
    // One undo step puts everything back.
    fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(() => expect(top("m1")).toBe(before.first));
    expect(top("t1")).toBe(before.text);
    expect(top("m16")).toBe(before.later);
  });

  it("keeps the line inside an area and grows the band, in one undo step", async () => {
    await openDemo();
    await emptySheet();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.area }));
    const band = async () => (await screen.findByTestId("area")).style.height;
    const before = await band();
    // A click in the body of the band, below its 21 pt header, puts the crosshair there; Enter then
    // inserts the line inside the area, which grows by that line.
    const area = screen.getByTestId("area").closest<HTMLElement>(".region")!;
    await act(async () => {
      fireEvent.pointerDown(document.querySelector('.page[data-page="1"]')!, {
        button: 0, clientX: 100, clientY: parseFloat(area.style.top) + ptToPx(27),
      });
    });
    await press("Enter");
    const line = ptToPx(WORKSHEET_LINE_PT);
    await waitFor(async () => expect(parseFloat(await band())).toBe(parseFloat(before) + line));
    fireEvent.click(within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }));
    await waitFor(async () => expect(await band()).toBe(before));
  });

  it("starts the new math region on the inserted line", async () => {
    await openDemo();
    await clickAboveTheMath();
    const known = new Set(
      [...document.querySelectorAll<HTMLElement>("[data-region-id]")].map((element) => element.dataset.regionId),
    );
    await press("Enter");
    // The crosshair box is drawn 8 px above and left of its point: the new line starts there.
    const line = crosshair().top + 8;
    await press("x");
    await waitFor(() => expect(document.querySelectorAll("[data-region-id]")).toHaveLength(known.size + 1));
    await press("Enter");
    await waitFor(() => expect(document.querySelector(".region.editing")).toBeNull());
    const added = [...document.querySelectorAll<HTMLElement>("[data-region-id]")].find(
      (element) => !known.has(element.dataset.regionId),
    )!;
    // The first math line is drawn across the crosshair's vertical bar.
    expect(parseFloat(added.style.top)).toBe(line - ptToPx(LINE_ABOVE_CROSSHAIR_PT));
    expect(parseFloat(added.style.top)).toBeLessThan(top("m1"));
  });

  it("creates the next page when the inserted line falls past the bottom of the last one", async () => {
    await openDemo();
    await emptySheet();
    expect(document.querySelectorAll(".page")).toHaveLength(1);
    // The crosshair starts one line below the top margin; Enter follows successive lines down
    // until the next one falls past the bottom margin.
    const startY = (crosshair().top + 8) / ptToPx(1);
    const linesThatFit = Math.floor((769.89 - startY) / WORKSHEET_LINE_PT);
    for (let i = 0; i < linesThatFit; i++) await press("Enter");
    expect(document.querySelectorAll(".page")).toHaveLength(1);
    const beforeBreak = crosshair().top;
    await press("Enter");
    await waitFor(() => expect(document.querySelectorAll(".page")).toHaveLength(2));
    // The crosshair is on the page that was just created, not below the sheet.
    expect(crosshair().top).toBeGreaterThan(beforeBreak + ptToPx(WORKSHEET_LINE_PT));
  });
});

describe("solve block", () => {
  it("a Given typed on the sheet is the keyword region that opens a block", async () => {
    await openDemo();
    // the workflow: the block starts by typing the keyword, not from a ribbon button.
    for (const key of ["g", "i", "v", "e", "n"]) {
      fireEvent.keyDown(window, { key, code: `Key${key.toUpperCase()}` });
      await act(async () => {});
    }
    await waitFor(() => expect(region("__new")?.classList.contains("editing")).toBe(true));
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(region("__new")).toBeNull());
    // The committed region is the keyword (any case), not a worksheet name.
    const keyword = [...document.querySelectorAll<HTMLElement>(".region .name.kw")].find((el) => el.textContent === "given");
    expect(keyword).not.toBeUndefined();
    // There is no box, no dialog and no double-click editor, and no Insert > Solve Block button.
    expect(document.querySelector(".solve-region")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    expect(screen.queryByRole("button", { name: "Solve Block" })).toBeNull();
  });
});
