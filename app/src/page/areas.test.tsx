// Collapsible areas in the window, on the mock backend. The demo
// worksheet has no areas: one is added to it. Its page 1 holds m3 (y 210), m5 and m6 (y 250), m7 (y 320).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import type { ViewRegion } from "../equavelaApi";
import { enterPrint, leavePrint } from "../print/printMode";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  leavePrint();
  cleanup();
  vi.restoreAllMocks();
});

// y 190 to 290: the header is 190 to 211, so m5 and m6 (y 250) are members; m3 (210) is not.
const AREA: ViewRegion = { id: "ar1", page: 1, x: 54, y: 190, enabled: true, kind: "area", title: "Loads", height: 100, collapsed: false };

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const band = () => region("ar1")!.querySelector<HTMLElement>("[data-testid=area]")!;
const undoButton = () => within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;
const top = (id: string) => parseFloat(region(id)!.style.top);
const crosshair = () => screen.getByTestId("crosshair");

async function openWithArea(collapsed = false) {
  const backend = createMockBackend({ fast: true, extraRegions: [{ ...AREA, collapsed } as ViewRegion] });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("ar1")).not.toBeNull());
  return backend;
}

/** A press and release on the header: selects the area, never collapses it. */
async function clickHeader() {
  const header = region("ar1")!.querySelector(".area-header")!;
  fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 300 }));
}

/** A click on the disclosure control: the only way to collapse or expand an area. */
async function clickIndicator() {
  fireEvent.click(region("ar1")!.querySelector("[data-testid=area-indicator]")!);
}

/** A click on the collapse control of the band `id`. */
async function clickIndicatorOn(id: string) {
  const button = document.querySelector<HTMLElement>(`[data-region-id="${id}"] [data-testid=area-indicator]`);
  expect(button).not.toBeNull();
  await act(async () => void fireEvent.click(button!));
}

/** A press and release on the header of the band `id`: selects it, never collapses it. */
async function clickHeaderOn(id: string) {
  const header = document.querySelector<HTMLElement>(`[data-region-id="${id}"] .area-header`)!;
  fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 300 }));
}

describe("collapsible areas", () => {
  it("draws the section: the title in the middle of the start line, the members over it", async () => {
    await openWithArea();
    expect(band().dataset.collapsed).toBe("false");
    expect(screen.getByTestId("area-title").textContent).toBe("Loads");
    // The title belongs to the header (the start line) and the disclosure control is a button.
    const header = band().querySelector(".area-header")!;
    expect(header.contains(screen.getByTestId("area-title"))).toBe(true);
    const indicator = band().querySelector<HTMLButtonElement>("[data-testid=area-indicator]")!;
    expect(indicator.tagName).toBe("BUTTON");
    expect(indicator.getAttribute("aria-expanded")).toBe("true");
    // 100 pt = 133.33 px high, 21 pt = 28 px header
    expect(parseFloat(band().style.height)).toBeCloseTo(133.33, 1);
    expect(region("m5")).not.toBeNull();
    expect(region("m6")).not.toBeNull();
  });

  it("a click on the indicator collapses it: members are hidden, what lies below moves up, one undo step each way", async () => {
    await openWithArea();
    const before = top("m7");
    await clickIndicator();
    await waitFor(() => expect(region("m5")).toBeNull());
    expect(region("m6")).toBeNull();
    expect(region("m3")).not.toBeNull();
    expect(band().dataset.collapsed).toBe("true");
    expect(band().querySelector("[data-testid=area-indicator]")!.getAttribute("aria-expanded")).toBe("false");
    // The 79 pt of hidden content (about 105 px) are gone from the layout.
    await waitFor(() => expect(before - top("m7")).toBeGreaterThan(95));
    expect(undoButton().getAttribute("title")).toContain("Collapse area");
    fireEvent.click(undoButton());
    await waitFor(() => expect(region("m5")).not.toBeNull());
    expect(top("m7")).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.redo }));
    await waitFor(() => expect(region("m5")).toBeNull());
    // Clicking again expands.
    await clickIndicator();
    await waitFor(() => expect(region("m5")).not.toBeNull());
    expect(undoButton().getAttribute("title")).toContain("Expand area");
  });

  it("a click on the header selects the area without collapsing it", async () => {
    await openWithArea();
    const before = top("m7");
    await clickHeader();
    await waitFor(() => expect(region("ar1")!.classList.contains("selected")).toBe(true));
    expect(band().dataset.collapsed).toBe("false");
    expect(region("m5")).not.toBeNull();
    expect(top("m7")).toBe(before);
  });

  it("a click inside the band is a sheet click: it places the crosshair there and clears the selection, so content can be added", async () => {
    await openWithArea();
    await clickHeader();
    await waitFor(() => expect(region("ar1")!.classList.contains("selected")).toBe(true));
    expect(screen.getByRole("tab", { name: S.ribbon.tabs.area })).not.toBeNull();
    const before = crosshair().style.top;
    // y 330 px of the sheet is 247.5 pt: below the 21 pt header, inside the 190..290 pt band.
    fireEvent.pointerDown(band(), { button: 0, clientX: 300, clientY: 330 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 330 }));
    // Not collapsed, its members are still drawn, the crosshair moved into the band, nothing selected.
    expect(band().dataset.collapsed).toBe("false");
    expect(region("m5")).not.toBeNull();
    expect(crosshair().style.top).not.toBe(before);
    await waitFor(() => expect(region("ar1")!.classList.contains("selected")).toBe(false));
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.area })).toBeNull();
    // Typing at that crosshair starts a region inside the area: between the header and the end line.
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(within(screen.getByLabelText(S.ribbon.label)).getByRole("button", { name: S.ribbon.commands.math }));
    await waitFor(() => expect(region("__new")).not.toBeNull());
    const bandTop = parseFloat(region("ar1")!.style.top);
    const draftTop = parseFloat(region("__new")!.style.top);
    expect(draftTop).toBeGreaterThan(bandTop + 21 * (4 / 3));
    expect(draftTop).toBeLessThan(bandTop + 100 * (4 / 3));
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
  });

  it("starts collapsed when the file says so, and its members still exist for calculation", async () => {
    const backend = await openWithArea(true);
    expect(region("m5")).toBeNull();
    // A collapsed area is only its start line with the title.
    expect(band().dataset.collapsed).toBe("true");
    expect(screen.getByTestId("area-title").textContent).toBe("Loads");
    // The hidden regions are still in the worksheet view the backend calculates from.
    const view = await backend.getView("mock1");
    expect(view.regions.some((r) => r.id === "m5")).toBe(true);
  });

  it("edits the title in place with a double-click and undoes it", async () => {
    await openWithArea();
    fireEvent.doubleClick(screen.getByTestId("area-title"));
    const input = (await screen.findByLabelText(S.page.areaTitle)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Inputs" } });
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    await waitFor(() => expect(screen.getByTestId("area-title").textContent).toBe("Inputs"));
    expect(undoButton().getAttribute("title")).toContain("Edit area");
    fireEvent.click(undoButton());
    await waitFor(() => expect(screen.getByTestId("area-title").textContent).toBe("Loads"));
    // Escape cancels
    fireEvent.doubleClick(screen.getByTestId("area-title"));
    const again = (await screen.findByLabelText(S.page.areaTitle)) as HTMLInputElement;
    fireEvent.change(again, { target: { value: "Nope" } });
    await act(async () => void fireEvent.keyDown(again, { key: "Escape" }));
    expect(screen.getByTestId("area-title").textContent).toBe("Loads");
  });

  it("inserts from the Document ribbon", async () => {
    const backend = createMockBackend({ fast: true });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    // The crosshair starts one worksheet line below the last region of page 1, at 756 pt: 13.89 pt
    // are left below it, less than the 24 pt of area the mock needs, so say so and add nothing.
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.area }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no room for an area"));
    expect(document.querySelectorAll("[data-testid=area]")).toHaveLength(0);
    // A click on free space of page 2 places the crosshair there; then the area fits.
    fireEvent.pointerDown(document.querySelector(".page[data-page='2']")!, { button: 0, clientX: 200, clientY: 1300 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0 }));
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.area }));
    await waitFor(() => expect(document.querySelectorAll("[data-testid=area]")).toHaveLength(1));
    expect(undoButton().getAttribute("title")).toContain("Add region");
  });

  it("deletes an area together with its members, as one undo step", async () => {
    await openWithArea();
    await clickHeader();
    // the press selected the area: delete it without collapsing
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.deleteRegion }));
    await waitFor(() => expect(region("ar1")).toBeNull());
    expect(region("m5")).toBeNull();
    expect(region("m6")).toBeNull();
    expect(region("m3")).not.toBeNull();
    fireEvent.click(undoButton());
    await waitFor(() => expect(region("m5")).not.toBeNull());
    expect(region("ar1")).not.toBeNull();
  });

  it("copies an area with its members and pastes them back as one undo step", async () => {
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
      await openWithArea();
      await clickHeader();
      await act(async () => {
        fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true });
      });
      // The area travels with its members: its own item plus one item per member.
      await waitFor(() => expect(clipboard).toContain("  area:"));
      expect(clipboard).toContain('    title: "Loads"');
      expect(clipboard).toContain("    height: 100");
      expect(clipboard).toContain("A := [1, 2, 3; 4, 5, 6; 7, 8, 10]");
      expect(clipboard).toContain('  math: "A ="');
      const before = document.querySelectorAll("[data-region-id]").length;
      // Free space on page 2: a click there places the crosshair, and the group fits.
      fireEvent.pointerDown(document.querySelector(".page[data-page='2']")!, { button: 0, clientX: 200, clientY: 1300 });
      await act(async () => void fireEvent.pointerUp(window, { button: 0 }));
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      // The area, its title and its two members landed.
      await waitFor(() => expect(document.querySelectorAll("[data-region-id]").length).toBe(before + 3));
      expect(document.querySelectorAll("[data-testid=area]")).toHaveLength(2);
      expect(screen.getAllByTestId("area-title").map((node) => node.textContent)).toEqual(["Loads", "Loads"]);
      // They are one undo step: the pasted area and its members go together.
      fireEvent.click(undoButton());
      await waitFor(() => expect(document.querySelectorAll("[data-region-id]").length).toBe(before));
      expect(document.querySelectorAll("[data-testid=area]")).toHaveLength(1);
      expect(region("m5")).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

});

// A band across pages. A4 with the
// default 1 in margins: the printable area of a page runs from y 72 to 769.89, so a band from y 600
// of page 1 that is 400 pt long covers 600..769.89 there and 72..302.11 on page 2.
/** A `name =` statement of a math region, as the backend returns it. */
const evaluate = (name: string) =>
  ({ type: "Evaluate", expr: { type: "Ident", name: { segments: [{ text: name, subscript: false }], label: null } }, unit: null }) as never;

const crossingArea = (collapsed = false): ViewRegion[] => [
  { id: "ac", page: 1, x: 54, y: 600, enabled: true, kind: "area", title: "Across", height: 400, collapsed },
  { id: "i1", page: 1, x: 54, y: 650, enabled: true, kind: "math", text: "i1 =", statement: evaluate("i1") },
  { id: "i2", page: 2, x: 54, y: 100, enabled: true, kind: "math", text: "i2 =", statement: evaluate("i2") },
  { id: "below", page: 2, x: 54, y: 500, enabled: true, kind: "math", text: "below =", statement: evaluate("below") },
];

async function openWithCrossingArea(collapsed = false) {
  const backend = createMockBackend({ fast: true, extraRegions: crossingArea(collapsed) });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("ac")).not.toBeNull());
  return backend;
}

/** The parts the band draws, in page order. */
const parts = () => [...document.querySelectorAll<HTMLElement>("[data-testid=area]")];
const pageTop = (page: number) =>
  parseFloat(document.querySelector<HTMLElement>(`.page[data-page='${page}']`)!.style.top);

describe("a band across pages", () => {
  it("draws the start line on the page it starts on and the end line on the page it ends on", async () => {
    await openWithCrossingArea();
    expect(parts().map((part) => part.dataset.part)).toEqual(["start", "end"]);
    // The header — the start line, the title, the collapse control — is drawn once, on page 1.
    const [start, end] = parts();
    expect(start.querySelector(".area-header")).not.toBeNull();
    expect(start.querySelector("[data-testid=area-title]")!.textContent).toBe("Across");
    expect(end.querySelector(".area-header")).toBeNull();
    expect(end.querySelector("[data-testid=area-title]")).toBeNull();
    // Page 1's part runs from y 600 to the bottom margin (169.89 pt), page 2's from the top margin to
    // y 302.11 (230.11 pt).
    expect(parseFloat(start.style.height)).toBeCloseTo((769.89 - 600) * (4 / 3), 1);
    expect(parseFloat(end.style.height)).toBeCloseTo((302.11 - 72) * (4 / 3), 1);
    expect(parseFloat(end.closest<HTMLElement>(".region")!.style.top)).toBeCloseTo(pageTop(2) + 72 * (4 / 3), 1);
    // The members of the band are drawn on both pages; a region below its end line is not inside it.
    expect(region("i1")).not.toBeNull();
    expect(region("i2")).not.toBeNull();
    expect(region("below")).not.toBeNull();
    // The sheet is as long as the band: page 2 exists even before anything else is put there.
    expect(document.querySelector(".page[data-page='2']")).not.toBeNull();
  });

  it("collapsing hides the members of every page and lifts what lies below on each page", async () => {
    await openWithCrossingArea();
    const before = top("below");
    fireEvent.click(parts()[0].querySelector("[data-testid=area-indicator]")!);
    await waitFor(() => expect(region("i1")).toBeNull());
    expect(region("i2")).toBeNull();
    // The band is only its header now: one part, 21 pt, on page 1.
    expect(parts()).toHaveLength(1);
    expect(parts()[0].dataset.part).toBe("start");
    expect(parts()[0].dataset.collapsed).toBe("true");
    // On page 2 the whole part of the band is gone (230.11 pt), so what lies below moves up by it
    // (the reflow snaps the new place to the grid, so the distance may differ by up to a step).
    await waitFor(() => expect(before - top("below")).toBeGreaterThan(304));
    expect(before - top("below")).toBeLessThan(309);
    expect(undoButton().getAttribute("title")).toContain("Collapse area");
    // Expanding restores the members on both pages and the end line where it was.
    await clickIndicatorOn("ac");
    await waitFor(() => expect(region("i2")).not.toBeNull());
    expect(region("i1")).not.toBeNull();
    expect(parts().map((part) => part.dataset.part)).toEqual(["start", "end"]);
    expect(top("below")).toBe(before);
  });

  it("prints each part in the page block it belongs to, at the same offset as on screen", async () => {
    await openWithCrossingArea();
    const screenEnd = parseFloat(parts()[1].closest<HTMLElement>(".region")!.style.top) - pageTop(2);
    // Inside a page block the offset is measured from the page, so `below` is compared that way too.
    const screenBelow = top("below") - pageTop(2);
    await act(async () => enterPrint());
    const printed = (page: number) => document.querySelector(`.print-page[data-page="${page}"] [data-testid=area]`);
    expect(printed(1)).not.toBeNull();
    expect(printed(2)).not.toBeNull();
    expect(printed(1)!.getAttribute("data-part")).toBe("start");
    expect(printed(2)!.getAttribute("data-part")).toBe("end");
    // The end line of the band sits at the same offset inside its page as it does on screen.
    const printedEnd = printed(2)!.closest<HTMLElement>(".region")!;
    expect(parseFloat(printedEnd.style.top)).toBeCloseTo(screenEnd, 3);
    // Nothing of the band is clipped or repeated: two parts on screen, two in the print view, and
    // the band is one region (its continuation carries no region id of its own).
    expect(document.querySelectorAll(".print-page [data-testid=area]")).toHaveLength(2);
    expect(document.querySelectorAll('.print-page [data-region-id="ac"]')).toHaveLength(1);
    expect(top("below")).toBeCloseTo(screenBelow, 3);
  });

  it("is dropped where the pointer leaves it: a band that crosses the bottom margin is not moved to the next page", async () => {
    await openWithCrossingArea();
    const before = parseFloat(region("ac")!.style.top);
    // Select the band and drag it 30 CSS px (22.5 pt, snapped to the grid) down from its header: the
    // band still crosses the bottom margin of page 1, which is what a band may do.
    await clickHeaderOn("ac");
    const header = region("ac")!.querySelector<HTMLElement>(".area-header")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 300, clientY: 340 }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 340 }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Move region"));
    // 30 CSS px are 22.5 pt, snapped up to the 3 pt grid: 24 pt lower, still on page 1.
    expect(parseFloat(region("ac")!.style.top)).toBeCloseTo(before + 30 * (4 / 3), 0);
    // The band is still on page 1 (840 px is 630 pt, page 1 ends at 1122 px) and keeps both parts.
    expect(parts().map((part) => part.dataset.part)).toEqual(["start", "end"]);
  });

  it("keeps members together when the area header moves to the next page", async () => {
    const backend = await openWithCrossingArea();
    await clickHeaderOn("ac");
    const header = region("ac")!.querySelector<HTMLElement>(".area-header")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 300, clientY: 800 }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 800 }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Move region"));
    const view = await backend.getView("mock1");
    const moved = (id: string) => view.regions.find((r) => r.id === id)!;
    expect(moved("ac").page).toBe(2);
    expect(moved("i1").page).toBe(2);
    expect(moved("i2").page).toBe(2);
    expect(Math.abs(moved("i1").y - moved("ac").y - 50)).toBeLessThan(3);
    expect(Math.abs(moved("i2").y - moved("i1").y - 147.89)).toBeLessThan(3);
  });

  it("grows past the bottom margin with the end line, which moves to the next page", async () => {
    await openWithCrossingArea();
    // Select the band: a press and release on its header.
    await clickHeaderOn("ac");
    const endOf = () => parts()[parts().length - 1].closest<HTMLElement>(".region")!;
    await waitFor(() => expect(endOf().querySelector("[data-testid=resize-handle]")).not.toBeNull());
    const handle = endOf().querySelector<HTMLElement>("[data-testid=resize-handle]")!;
    // From y 600 of page 1 down to y 400 of page 2: 498 pt of flow (the pointer snaps to the grid).
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, clientY: 200 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 300, clientY: pageTop(2) + 400 * (4 / 3) }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: pageTop(2) + 400 * (4 / 3) }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Edit area"));
    const [, end] = parts();
    expect(parseFloat(end.style.height)).toBeCloseTo((400.11 - 72) * (4 / 3), 1);
    fireEvent.click(undoButton());
    await waitFor(() => expect(parseFloat(parts()[1].style.height)).toBeCloseTo(230.11 * (4 / 3), 1));
  });

  it("prints what the page shows: the section rules, no hidden members, the shifted regions", async () => {
    await openWithArea(true);
    const screenTop = top("m7");
    await act(async () => enterPrint());
    expect(region("m5")).toBeNull();
    expect(document.querySelector(".print-page [data-testid=area]")).not.toBeNull();
    // Same offset inside the page block as on screen (the print view has no zoom).
    expect(top("m7")).toBeCloseTo(screenTop, 3);
  });
});

describe("a band always holds its content", () => {
  // A Julia block with a box 200 x 150 at y 220, inside ar1 (190 to 290): it ends at 370.
  const BLOCK: ViewRegion = {
    id: "jb",
    page: 1,
    x: 300,
    y: 220,
    enabled: true,
    kind: "julia",
    block: { playing: false, size: [200, 150], using: [], imports: [], code: null, defines: [] },
  } as ViewRegion;

  it("draws the band down to one grid step below its lowest member", async () => {
    render(<App backend={createMockBackend({ fast: true, extraRegions: [AREA, BLOCK] })} />);
    await waitFor(() => expect(region("ar1")).not.toBeNull());
    // The end line lies one grid step below the block's bottom, rounded up to the grid (the band
    // stores 100 pt, which would end inside the block).
    await waitFor(() => {
      const end = top("ar1") + parseFloat(band().style.height);
      const bottom = top("jb") + 150 * (4 / 3);
      expect(end).toBeGreaterThanOrEqual(bottom + 4 - 0.01);
      expect(end).toBeLessThan(bottom + 8);
    });
  });

  it("stores the grown band when a member is resized, in the same undo step", async () => {
    const small = { ...BLOCK, block: { ...(BLOCK as Extract<ViewRegion, { kind: "julia" }>).block, size: [200, 30] } } as ViewRegion;
    const backend = createMockBackend({ fast: true, extraRegions: [AREA, small] });
    render(<App backend={backend} />);
    await waitFor(() => expect(region("ar1")).not.toBeNull());
    const heightOf = async () => (await backend.getView("mock1")).regions.find((r) => r.id === "ar1") as Extract<ViewRegion, { kind: "area" }>;
    await backend.setJuliaSize("mock1", "jb", 200, 150);
    expect((await heightOf()).height).toBe(185);
    await backend.undo("mock1");
    expect((await heightOf()).height).toBe(100);
  });
});

it("moves area members across the page boundary without moving an unrelated plot", async () => {
  const area: ViewRegion = { id: "moving", page: 1, x: 54, y: 90, enabled: true, kind: "area", title: "Moving", height: 720, collapsed: false };
  const member: ViewRegion = { id: "last", page: 1, x: 54, y: 756, enabled: true, kind: "math", text: "last =", statement: evaluate("last") };
  const plot: ViewRegion = {
    id: "unrelated-plot", page: 2, x: 300, y: 300, enabled: true, kind: "plot",
    plot: { version: 1, type: "xy", size: [240, 160], axes: {
      x: { scale: "linear", unit: null, min: null, max: null, show_grid: true, title: "" },
      y: { scale: "linear", unit: null, min: null, max: null, show_grid: true, title: "" },
    }, traces: [{ id: "trace", x: "t", y: "t", presentation: "line" }] },
  };
  const backend = createMockBackend({ fast: true, extraRegions: [area, member, plot] });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("moving")).not.toBeNull());
  const plotTop = top("unrelated-plot");
  await clickHeaderOn("moving");
  const header = region("moving")!.querySelector<HTMLElement>(".area-header")!;
  fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
  await act(async () => void fireEvent.pointerMove(window, { clientX: 300, clientY: 340 }));
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 340 }));
  await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Move region"));
  const view = await backend.getView("mock1");
  const movedMember = view.regions.find((r) => r.id === "last")!;
  expect(movedMember.page).toBe(2);
  expect(movedMember.y).toBeGreaterThanOrEqual(72);
  expect(movedMember.y).toBeLessThan(120);
  expect(top("unrelated-plot")).toBeCloseTo(plotTop, 1);
  expect(view.regions.find((r) => r.id === "unrelated-plot")).toMatchObject({ page: 2, y: 300 });
});

it("does not pull a displaced plot upward when an area moves away", async () => {
  const area: ViewRegion = { id: "moving", page: 1, x: 54, y: 90, enabled: true, kind: "area", title: "Moving", height: 650, collapsed: false };
  const block = (id: string, y: number, height: number): ViewRegion => ({
    id, page: 1, x: 54, y, enabled: true, kind: "julia",
    block: { playing: false, size: [220, height], using: [], imports: [], code: null, defines: [] },
  });
  const plot: ViewRegion = {
    id: "outside-plot", page: 2, x: 54, y: 130, enabled: true, kind: "plot",
    plot: { version: 1, type: "xy", size: [240, 160], axes: {
      x: { scale: "linear", unit: null, min: null, max: null, show_grid: true, title: "" },
      y: { scale: "linear", unit: null, min: null, max: null, show_grid: true, title: "" },
    }, traces: [{ id: "trace", x: "t", y: "t", presentation: "line" }] },
  };
  const sizes = [[611,131], [697,101], [287,107], [133,41], [155,155], [349,57], [627,143], [681,57]];
  const heights = new Map([["outside", 200], ["outside-plot", 160], ...sizes.map(([, h], i): [string, number] => [`member-${i}`, h])]);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return heights.has(this.dataset.regionId ?? "") ? 220 * (4 / 3) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return (heights.get(this.dataset.regionId ?? "") ?? 0) * (4 / 3);
  });
  const backend = createMockBackend({ fast: true, extraRegions: [area, block("outside", 90, 200), ...sizes.map(([y, h], i) => block(`member-${i}`, y, h)), plot] });
  render(<App backend={backend} />);
  await waitFor(() => expect(region("outside-plot")).not.toBeNull());
  const before = top("outside-plot");
  expect(before).toBeGreaterThan(pageTop(2) + 400 * (4 / 3));
  await clickHeaderOn("moving");
  const header = region("moving")!.querySelector<HTMLElement>(".area-header")!;
  fireEvent.pointerDown(header, { button: 0, clientX: 300, clientY: 300 });
  await act(async () => void fireEvent.pointerMove(window, { clientX: 300, clientY: 340 }));
  await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 300, clientY: 340 }));
  await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Move region"));
  expect(top("outside-plot")).toBeCloseTo(before, 1);
  fireEvent.click(undoButton());
  await waitFor(() => expect(top("outside-plot")).toBeCloseTo(before, 1));
  const undone = await backend.getView("mock1");
  expect(undone.regions.find((r) => r.id === "outside-plot")?.page).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: S.quickAccess.redo }));
  await waitFor(() => expect(top("outside-plot")).toBeCloseTo(before, 1));
});
