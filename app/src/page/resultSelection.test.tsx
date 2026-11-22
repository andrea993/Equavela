// Pointer selection of numeric matrix results, small and clipped in their box.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`)!;
const result = (id: string) => region(id).querySelector<HTMLElement>(".result")!;
const cell = (id: string, at: string) => result(id).querySelector<HTMLElement>(`[data-result-cell="${at}"]`)!;

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m6").querySelector(".result-matrix")).not.toBeNull());
  await waitFor(() => expect(region("m22").querySelector(".result-matrix-scroll")).not.toBeNull());
}

async function down(target: Element, x = 10, y = 10) {
  fireEvent.pointerDown(target, { button: 0, buttons: 1, clientX: x, clientY: y });
}

async function up(x = 10, y = 10) {
  await act(async () => fireEvent.pointerUp(window, { button: 0, buttons: 0, clientX: x, clientY: y }));
}

function rect(el: Element, left: number, top: number, width: number, height: number) {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("matrix result selection", () => {
  it("selects and drags a range of cells in a classic matrix", async () => {
    await openDemo();
    const matrix = result("m6").querySelector<HTMLElement>(".result-matrix")!;
    const grid = matrix.querySelector<HTMLElement>(".matrix-grid")!;
    rect(grid, 0, 0, 60, 60);
    rect(cell("m6", "0,0"), 0, 0, 20, 20);
    rect(cell("m6", "1,1"), 40, 40, 20, 20);

    await down(cell("m6", "0,0"), 5, 5);
    await act(async () => fireEvent.pointerMove(window, { buttons: 1, clientX: 50, clientY: 50 }));
    await up(50, 50);

    expect(cell("m6", "0,0").classList.contains("result-selected")).toBe(true);
    expect(cell("m6", "0,1").classList.contains("result-selected")).toBe(true);
    expect(cell("m6", "1,0").classList.contains("result-selected")).toBe(true);
    expect(cell("m6", "1,1").classList.contains("result-selected")).toBe(true);
  });

  it("shows the Matrix tab as soon as elements of a matrix result are selected", async () => {
    await openDemo();
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.matrix })).toBeNull();
    const grid = result("m6").querySelector<HTMLElement>(".matrix-grid")!;
    rect(grid, 0, 0, 60, 60);
    rect(cell("m6", "0,0"), 0, 0, 20, 20);
    await down(cell("m6", "0,0"), 5, 5);
    await up(5, 5);
    expect(cell("m6", "0,0").classList.contains("result-selected")).toBe(true);
    // The region is not selected, but its result is a matrix with elements selected.
    expect(region("m6").classList.contains("selected")).toBe(false);
    await waitFor(() => expect(screen.queryByRole("tab", { name: S.ribbon.tabs.matrix })).not.toBeNull());
    // Its command acts on that result: the matrix shows its indices.
    fireEvent.click(screen.getByRole("checkbox", { name: S.ribbon.commands.showIndices }));
    await waitFor(() => expect(result("m6").querySelector(".indexed-matrix")).not.toBeNull());
  });

  it("selects and drags a range of cells in a clipped matrix", async () => {
    await openDemo();
    rect(result("m22").querySelector(".result-matrix-scroll")!, 0, 0, 120, 120);
    rect(result("m22").querySelector(".matrix-grid")!, 0, 0, 120, 120);
    rect(cell("m22", "0,0"), 0, 20, 30, 20);
    rect(cell("m22", "1,1"), 60, 40, 30, 20);

    await down(cell("m22", "0,0"), 5, 25);
    await act(async () => fireEvent.pointerMove(window, { buttons: 1, clientX: 70, clientY: 50 }));
    await up(70, 50);

    expect(cell("m22", "0,0").classList.contains("result-selected")).toBe(true);
    expect(cell("m22", "1,1").classList.contains("result-selected")).toBe(true);
    expect(cell("m22", "0,1").classList.contains("result-selected")).toBe(true);
    expect(cell("m22", "1,0").classList.contains("result-selected")).toBe(true);
  });

  it("copies a selected cell of a clipped matrix as math text", async () => {
    let copied = "";
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: async (text: string) => { copied = text; }, readText: async () => copied },
    });
    await openDemo();
    await down(cell("m22", "0,0"));
    await up();
    expect(cell("m22", "0,0").classList.contains("result-selected")).toBe(true);

    await act(async () => fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true }));

    await waitFor(() => expect(copied).toBe("1"));
  });

  it("selects cells of a clipped matrix even when the result region is already selected", async () => {
    await openDemo();
    rect(result("m22").querySelector(".result-matrix-scroll")!, 0, 0, 120, 120);
    rect(result("m22").querySelector(".matrix-grid")!, 0, 0, 120, 120);
    rect(cell("m22", "0,0"), 0, 20, 30, 20);
    rect(cell("m22", "1,1"), 60, 40, 30, 20);

    fireEvent.pointerDown(region("m22"), { button: 0, buttons: 1, ctrlKey: true, clientX: 200, clientY: 200 });
    await act(async () => fireEvent.pointerUp(window, { button: 0, buttons: 0, ctrlKey: true, clientX: 200, clientY: 200 }));
    await waitFor(() => expect(region("m22").classList.contains("selected")).toBe(true));
    const position = region("m22").style.transform;

    await down(cell("m22", "0,0"), 5, 25);
    await act(async () => fireEvent.pointerMove(window, { buttons: 1, clientX: 70, clientY: 50 }));
    await up(70, 50);

    expect(cell("m22", "0,0").classList.contains("result-selected")).toBe(true);
    expect(cell("m22", "1,1").classList.contains("result-selected")).toBe(true);
    expect(region("m22").classList.contains("selected")).toBe(false);
    expect(region("m22").style.transform).toBe(position);
  });

  it("uses the nearest cell for a press or drag in matrix gaps and keeps an outside drag on the matrix", async () => {
    await openDemo();
    const matrix = result("m6").querySelector<HTMLElement>(".result-matrix")!;
    const grid = matrix.querySelector<HTMLElement>(".matrix-grid")!;
    rect(grid, 0, 0, 60, 60);
    rect(matrix, 0, 0, 60, 60);
    rect(cell("m6", "0,0"), 0, 0, 20, 20);
    rect(cell("m6", "0,1"), 40, 0, 20, 20);
    rect(cell("m6", "1,0"), 0, 40, 20, 20);
    rect(cell("m6", "1,1"), 40, 40, 20, 20);

    await down(matrix, 39, 10); // gap: nearest is row 0, column 1
    await up(39, 10);
    expect(cell("m6", "0,1").classList.contains("result-selected")).toBe(true);

    await down(cell("m6", "0,0"), 5, 5);
    await act(async () => fireEvent.pointerMove(window, { buttons: 1, clientX: 80, clientY: 30 }));
    await up(80, 30);
    expect(matrix.classList.contains("result-selected")).toBe(true);
  });

  it("leaves result selection without an editing caret when the user clicks a result while editing", async () => {
    await openDemo();
    const expression = region("m6").querySelector<HTMLElement>(".math [data-path], .math [data-cell-path]")!;
    await down(expression, 200, 200);
    await up(200, 200);
    await waitFor(() => expect(region("m6").classList.contains("editing")).toBe(true));

    await down(cell("m6", "0,0"), 5, 5);
    await up(5, 5);

    await waitFor(() => expect(cell("m6", "0,0").classList.contains("result-selected")).toBe(true));
    expect(region("m6").querySelector(".editing-lines")).toBeNull();
  });
});
