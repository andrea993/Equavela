// Page breaks and Add/Remove Space in the window,
// on the mock backend. The demo worksheet is used as it is: a click on empty
// page space puts the crosshair above its math, which is where the commands act.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { ptToPx } from "../layout/geometry";
import { WORKSHEET_LINE_PT } from "../layout/lines";
import { createMockBackend } from "../mock/mockBackend";
import { enterPrint, leavePrint } from "../print/printMode";
import { S } from "../strings";
import type { ViewRegion } from "../equavelaApi";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  leavePrint();
  cleanup();
  vi.restoreAllMocks();
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const top = (id: string) => parseFloat(region(id)!.style.top);
const pages = () => document.querySelectorAll(".sheet > .page");
const marks = () => document.querySelectorAll(".page-break-mark");
const undoButton = () => screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;

it("moves text shown below the crosshair after reflow for a line or page break", async () => {
  const block: ViewRegion = { id: "tall-block", page: 1, x: 300, y: 150, enabled: true, kind: "julia", block: { playing: false, size: [220, 120], using: [], imports: [], code: null, defines: [] } };
  const heading: ViewRegion = { id: "heading", page: 1, x: 300, y: 180, enabled: true, kind: "text", text: "Heading", width: null, paragraphs: [{ runs: [{ kind: "text", text: "Heading" }] }] };
  const dimensions = new Map([["tall-block", 120], ["heading", 24]]);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return dimensions.has(this.dataset.regionId ?? "") ? ptToPx(220) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return ptToPx(dimensions.get(this.dataset.regionId ?? "") ?? 0);
  });
  render(<App backend={createMockBackend({ fast: true, extraRegions: [block, heading] })} />);
  await waitFor(() => expect(region("heading")).not.toBeNull());
  const before = top("heading");
  expect(before).toBeGreaterThan(ptToPx(240));
  const page = document.querySelector<HTMLElement>('.page[data-page="1"]')!;
  await act(async () => void fireEvent.pointerDown(page, { button: 0, clientX: 100, clientY: ptToPx(240) }));
  await act(async () => void fireEvent.keyDown(window, { key: "Enter", code: "Enter" }));
  await waitFor(() => expect(top("heading")).toBeCloseTo(before + ptToPx(WORKSHEET_LINE_PT), 1));
  fireEvent.click(undoButton());
  await waitFor(() => expect(top("heading")).toBeCloseTo(before, 1));
  await act(async () => void fireEvent.pointerDown(page, { button: 0, clientX: 100, clientY: ptToPx(240) }));
  await command(S.ribbon.commands.addPageBreak);
  await waitFor(() => expect(pages().length).toBeGreaterThanOrEqual(2));
  expect(top("heading")).toBeGreaterThan(parseFloat((pages()[1] as HTMLElement).style.top));
});

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
}

/** A click on empty page space just below the two text blocks of the demo, above its math. */
async function clickAboveTheMath() {
  const page = document.querySelector<HTMLElement>('.page[data-page="1"]')!;
  await act(async () => {
    fireEvent.pointerDown(page, { button: 0, clientX: 100, clientY: 140 });
  });
}

/** A key on the sheet (nothing selected, no editor open). */
async function sheetKey(key: "Delete" | "Backspace") {
  await act(async () => {
    fireEvent.keyDown(window, { key, code: key });
  });
}

/** A click on the first worksheet line of page 2, directly below a break that ends page 1. */
async function clickTopOfPage2() {
  // The press maps through sheet coordinates (jsdom has no layout): page 2's top on the sheet plus
  // 100 px, which is 75 pt, on its first worksheet line once clamped to the top margin: the line runs
  // from 72 to 72 + WORKSHEET_LINE_PT pt, so the crosshair is "directly below" a break ending page 1.
  const page = document.querySelector<HTMLElement>('.page[data-page="2"]')!;
  await act(async () => {
    fireEvent.pointerDown(page, { button: 0, clientX: 100, clientY: parseFloat(page.style.top) + 100 });
  });
}

async function command(label: string) {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => {});
}

describe("Add Page Break", () => {
  it("ends the page at the caret line, moves the content below to the next page and marks the page", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = top("m1");
    const sheets = pages().length;
    await command(S.ribbon.commands.addPageBreak);
    // The page ends where the crosshair is: the math of page 1 continues on the next page (the sheet
    // grows by one) and the mark is drawn at the bottom of the page the break ends.
    await waitFor(() => expect(pages()).toHaveLength(sheets + 1));
    expect(marks()).toHaveLength(1);
    expect(marks()[0].closest(".page")?.getAttribute("data-page")).toBe("1");
    expect(top("m1")).toBeGreaterThan(before);
    // The whole gesture — the break and the moves — is one undo step.
    fireEvent.click(undoButton());
    await waitFor(() => expect(top("m1")).toBe(before));
    expect(marks()).toHaveLength(0);
    expect(pages()).toHaveLength(sheets);
  });

  it("refuses a second break on a page that already ends with one", async () => {
    await openDemo();
    await clickAboveTheMath();
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    await sheetKey("Delete");
    await waitFor(() => expect(marks()).toHaveLength(0));
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    // The same page again, without moving the crosshair: a page ends once.
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.ribbon.pageBreakExists(1)));
    expect(marks()).toHaveLength(1);
  });

  it("is drawn on the paper boundary of the draft view too", async () => {
    await openDemo();
    await clickAboveTheMath();
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.draftView }));
    await waitFor(() => expect(document.querySelector(".worksheet-area.draft")).not.toBeNull());
    // The break ends page 1, so the paper boundary at the top of page 2 carries the thick mark.
    expect(document.querySelector('[data-testid="draft-break-2"]')?.classList.contains("manual")).toBe(true);
    expect(document.querySelector('[data-testid="draft-break-3"]')?.classList.contains("manual")).toBe(false);
  });
});

describe("removing a break with the reference application's keys", () => {
  it("Delete directly above the break removes it and moves the content back up, in one undo step", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = top("m1");
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    // The crosshair is still on the break's line: Delete, with nothing selected, removes the break.
    await sheetKey("Delete");
    await waitFor(() => expect(marks()).toHaveLength(0));
    expect(Math.abs(top("m1") - before)).toBeLessThanOrEqual(2);
    fireEvent.click(undoButton());
    await waitFor(() => expect(marks()).toHaveLength(1));
  });

  it("Backspace directly below the break removes it", async () => {
    await openDemo();
    await clickAboveTheMath();
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    await clickTopOfPage2();
    await sheetKey("Backspace");
    await waitFor(() => expect(marks()).toHaveLength(0));
  });

  it("leaves the break alone elsewhere, and there is no Remove Page Break command", async () => {
    await openDemo();
    await clickAboveTheMath();
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(marks()).toHaveLength(1));
    // Backspace on the break's own page is not below the break.
    await sheetKey("Backspace");
    expect(marks()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /remove page break/i })).toBeNull();
  });
});

describe("Add Space and Remove Space", () => {
  it("Add Space inserts one worksheet line below the caret line, as Enter does", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = top("m1");
    await command(S.ribbon.commands.addSpace);
    // One line is WORKSHEET_LINE_PT = 15 pt = 20 CSS px at 100 percent.
    await waitFor(() => expect(top("m1")).toBe(before + ptToPx(WORKSHEET_LINE_PT)));
  });

  it("Enter pressed faster than the moves arrive still pushes the content down, one line each", async () => {
    render(<App backend={createMockBackend()} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await clickAboveTheMath();
    const before = top("m1");
    const crosshair = () => parseFloat(screen.getByTestId("crosshair").style.top) + 8;
    // Five Enters as a held key sends them: none waits for the previous move.
    await act(async () => {
      for (let i = 0; i < 5; i++) fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(top("m1")).toBe(before + 5 * ptToPx(WORKSHEET_LINE_PT)), { timeout: 5000 });
    // The crosshair never passes the content it pushes.
    expect(crosshair()).toBeLessThanOrEqual(top("m1"));
  });

  it("a held Enter keeps pace with the key and stops when it is released", async () => {
    const backend = createMockBackend();
    const moveRegions = vi.spyOn(backend, "moveRegions");
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await clickAboveTheMath();
    const before = top("m1");
    moveRegions.mockClear();
    // One press and twenty auto-repeats, all before the first move has reached the backend.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "Enter", code: "Enter", repeat: true });
    });
    // Every repeat counts, but the twenty that came during the first move go in one move.
    await waitFor(() => expect(top("m1")).toBe(before + 21 * ptToPx(WORKSHEET_LINE_PT)), { timeout: 5000 });
    // Two moves: the first line, then the twenty repeats together.
    const moves = () => new Set(moveRegions.mock.calls.map((call) => JSON.stringify(call[1]))).size;
    expect(moves()).toBe(2);
    // Released: nothing is left to do.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(top("m1")).toBe(before + 21 * ptToPx(WORKSHEET_LINE_PT));
    expect(moves()).toBe(2);
  });

  it("Remove Space closes one line of the blank space below the caret line", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = top("m1");
    await command(S.ribbon.commands.addSpace);
    await waitFor(() => expect(top("m1")).toBe(before + ptToPx(WORKSHEET_LINE_PT)));
    await command(S.ribbon.commands.removeSpace);
    await waitFor(() => expect(top("m1")).toBe(before));
    // One undo step each way.
    fireEvent.click(undoButton());
    await waitFor(() => expect(top("m1")).toBe(before + ptToPx(WORKSHEET_LINE_PT)));
    fireEvent.click(undoButton());
    await waitFor(() => expect(top("m1")).toBe(before));
  });

  it("closes only the blank space there is, never moving content above the caret line", async () => {
    await openDemo();
    await clickAboveTheMath();
    // The crosshair box is drawn 8 px above and left of its point.
    const line = parseFloat(screen.getByTestId("crosshair").style.top) + 8;
    const before = top("m1");
    for (let i = 0; i < 20; i++) await command(S.ribbon.commands.removeSpace);
    const after = top("m1");
    expect(after).toBeLessThan(before);
    // It stops where the content meets the caret line (within one grid step) and goes no further,
    // so nothing ends up above the line.
    expect(after).toBeGreaterThanOrEqual(line - 2);
    await command(S.ribbon.commands.removeSpace);
    expect(top("m1")).toBe(after);
  });

  it("Delete on empty space removes one line below the caret line", async () => {
    await openDemo();
    await clickAboveTheMath();
    const before = top("m1");
    await sheetKey("Delete");
    // The demo has blank space between the crosshair and its math: one line (15 pt = 20 px) goes.
    await waitFor(() => expect(top("m1")).toBe(before - ptToPx(WORKSHEET_LINE_PT)));
    fireEvent.click(undoButton());
    await waitFor(() => expect(top("m1")).toBe(before));
  });

  it("Backspace on empty space removes one line above, and the crosshair moves up with the content", async () => {
    await openDemo();
    await clickAboveTheMath();
    // Make one line of blank space above the caret line: Enter-like Add Space moves the crosshair
    // down with the content, so the line it leaves behind is blank.
    await act(async () => void fireEvent.keyDown(window, { key: "Enter", code: "Enter" }));
    const crosshair = () => parseFloat(screen.getByTestId("crosshair").style.top);
    const before = top("m1");
    const caret = crosshair();
    await sheetKey("Backspace");
    await waitFor(() => expect(top("m1")).toBe(before - ptToPx(WORKSHEET_LINE_PT)));
    expect(crosshair()).toBe(caret - ptToPx(WORKSHEET_LINE_PT));
    fireEvent.click(undoButton());
    await waitFor(() => expect(top("m1")).toBe(before));
  });

  it("is in the command palette with the same names", async () => {
    await openDemo();
    await act(async () => void fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true }));
    const dialog = await screen.findByRole("dialog", { name: S.commands.title });
    for (const label of ["Add page break", "Add space (one line)", "Remove space (one line)"]) {
      fireEvent.change(within(dialog).getByLabelText(S.commands.search), { target: { value: label } });
      const option = within(dialog)
        .getAllByRole("option")
        .find((row) => row.querySelector(".command-label")?.textContent === label);
      expect(option, label).toBeDefined();
      // No chord on either layout: the entry shows no keys.
      expect(option!.querySelector("kbd")).toBeNull();
    }
  });
});

describe("the print view puts the break where the page view shows it", () => {
  it("prints the pages of the page view, with the content that the break moved on the second one", async () => {
    await openDemo();
    await clickAboveTheMath();
    const sheets = pages().length;
    await command(S.ribbon.commands.addPageBreak);
    await waitFor(() => expect(pages()).toHaveLength(sheets + 1));
    expect(marks()).toHaveLength(1);

    await act(async () => enterPrint());
    const printed = [...document.querySelectorAll<HTMLElement>(".sheet > .print-page")];
    // Exactly as many pages as the page view, each of the page setup's size, and the mark is
    // screen-only.
    expect(printed).toHaveLength(sheets + 1);
    expect(printed[0].style.height).toBe("841.89pt");
    expect(document.querySelectorAll(".page-break-mark")).toHaveLength(0);
    // The math that the break put on page 2 is inside the second printed page.
    expect(region("m1")!.closest(".print-page")).toBe(printed[1]);
    await act(async () => leavePrint());
    expect(pages()).toHaveLength(sheets + 1);
  });
});
