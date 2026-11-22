// The Page Setup dialog in the window, on the mock backend:
// the dialog writes one undo step, the regions that would sit in the new margins move with it, a
// setup the core would refuse cannot be applied, and the print view and the PDF follow.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend, type MockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { ptToPx, snapToGrid } from "../layout/geometry";
import { enterPrint, isPrinting, leavePrint } from "../print/printMode";
import { TOKENS } from "../layout/pageText";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  leavePrint();
  cleanup();
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);
const firstPage = () => document.querySelector<HTMLElement>(".sheet > .page")!;
/** A region offset in CSS px: positions snap to the 3 pt grid. */
const at = (pt: number) => `${ptToPx(snapToGrid(pt))}px`;
const undoButton = () => screen.getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;

async function openDemo(patch: Partial<MockBackend> = {}): Promise<MockBackend> {
  const backend = { ...createMockBackend({ fast: true }), ...patch };
  render(<App backend={backend} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  return backend;
}

async function openDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.pageSetup }));
  return screen.findByRole("dialog", { name: S.pageSetup.title });
}

const field = (dialog: HTMLElement, name: string) => within(dialog).getByTestId(`ps-${name}`) as HTMLInputElement;

/** Header and Footer… in the Document tab opens the same dialog at its header/footer section. */
async function openChromeDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.headerFooter }));
  return screen.findByRole("dialog", { name: S.pageSetup.title });
}

/** The slots of the header and the footer lines of the first page, as drawn (`[]` when empty). */
const drawnLines = () =>
  [...document.querySelectorAll<HTMLElement>(".sheet > .page")][0]
    ? [
        ...document.querySelectorAll<HTMLElement>(".sheet > .page")[0].querySelectorAll(".header-line, .footer-line"),
      ].map((line) => [...line.querySelectorAll("span")].map((slot) => slot.textContent).join("|"))
    : [];

describe("Page Setup dialog", () => {
  it("shows the setup in force, edits size and orientation, and applies them as one undo step", async () => {
    await openDemo();
    // A4 portrait, in millimetres.
    expect(firstPage().style.width).toBe(`${Math.round(ptToPx(595.28))}px`);
    const dialog = await openDialog();
    expect(field(dialog, "size").value).toBe("A4");
    expect(field(dialog, "orientation").value).toBe("portrait");
    expect(field(dialog, "unit").value).toBe("mm");
    expect(field(dialog, "width").value).toBe("210");
    expect(field(dialog, "height").value).toBe("297");
    expect(field(dialog, "left").value).toBe("19.05");
    // A named size is not typed into: only a custom one is.
    expect(field(dialog, "width").disabled).toBe(true);
    // Letter, then landscape: the orientation swaps the two dimensions.
    fireEvent.change(field(dialog, "size"), { target: { value: "Letter" } });
    expect(field(dialog, "width").value).toBe("215.9");
    fireEvent.change(field(dialog, "orientation"), { target: { value: "landscape" } });
    expect(field(dialog, "width").value).toBe("279.4");
    expect(field(dialog, "height").value).toBe("215.9");
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ps-apply"));
    });
    await waitFor(() => expect(firstPage().style.width).toBe(`${Math.round(ptToPx(792))}px`));
    expect(firstPage().style.height).toBe(`${Math.round(ptToPx(612))}px`);
    expect(screen.queryByRole("dialog", { name: S.pageSetup.title })).toBeNull();
    // One Ctrl+Z brings back the old page.
    expect(undoButton().getAttribute("title")).toContain("Page setup");
    await act(async () => {
      fireEvent.click(undoButton());
    });
    await waitFor(() => expect(firstPage().style.width).toBe(`${Math.round(ptToPx(595.28))}px`));
  });

  it("moves the regions that would sit in the new margins, and undo brings back their place too", async () => {
    await openDemo();
    // m1 is at 54, 150 pt; the new margins put it in both of them.
    expect(region("m1")!.style.left).toBe(at(54));
    const dialog = await openDialog();
    fireEvent.change(field(dialog, "unit"), { target: { value: "pt" } });
    expect(field(dialog, "left").value).toBe("54");
    fireEvent.change(field(dialog, "left"), { target: { value: "96" } });
    fireEvent.change(field(dialog, "top"), { target: { value: "108" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ps-apply"));
    });
    await waitFor(() => expect(region("m1")!.style.left).toBe(at(96)));
    expect(region("m1")!.style.top).toBe(at(150));
    // t1 was at 54, 72: inside both new margins.
    expect(region("t1")!.style.left).toBe(at(96));
    expect(region("t1")!.style.top).toBe(at(108));
    // The regions that are inside keep their place, and the one on the right does not move.
    expect(region("m4")!.style.left).toBe(at(260));
    // The crosshair follows the new left margin, so typing does not start a region in a margin.
    expect(document.querySelector<SVGElement>("[data-testid=crosshair]")!.style.left).toBe(`${ptToPx(snapToGrid(96)) - 8}px`);
    await act(async () => {
      fireEvent.click(undoButton());
    });
    await waitFor(() => expect(region("m1")!.style.left).toBe(at(54)));
    expect(region("t1")!.style.top).toBe(at(72));
  });

  it("refuses a setup the core would refuse and writes nothing", async () => {
    await openDemo();
    const dialog = await openDialog();
    fireEvent.change(field(dialog, "unit"), { target: { value: "pt" } });
    fireEvent.change(field(dialog, "left"), { target: { value: "560" } });
    expect(within(dialog).getByTestId("ps-problem").textContent).toBe(S.pageSetup.problems["no-room"]);
    expect((within(dialog).getByTestId("ps-apply") as HTMLButtonElement).disabled).toBe(true);
    // An empty size is not a size either.
    fireEvent.change(field(dialog, "left"), { target: { value: "54" } });
    fireEvent.change(field(dialog, "size"), { target: { value: "custom" } });
    fireEvent.change(field(dialog, "width"), { target: { value: "0" } });
    expect(within(dialog).getByTestId("ps-problem").textContent).toBe(S.pageSetup.problems.size);
    fireEvent.click(within(dialog).getByRole("button", { name: S.pageSetup.cancel }));
    expect(screen.queryByRole("dialog", { name: S.pageSetup.title })).toBeNull();
    expect(firstPage().style.width).toBe(`${Math.round(ptToPx(595.28))}px`);
  });

  it("edits the header and the footer next to the page setup, in the same undo step", async () => {
    await openDemo();
    // Page Setup… reaches the header and footer section too, and there no slot has the focus yet, so
    // a token has nowhere to go.
    const fromPageSetup = await openDialog();
    expect(within(fromPageSetup).getByText(S.pageSetup.chrome)).toBeTruthy();
    const page = within(fromPageSetup).getByTestId("ps-insert-page") as HTMLButtonElement;
    expect(page.disabled).toBe(true);
    fireEvent.focus(field(fromPageSetup, "header-center"));
    expect(page.disabled).toBe(false);
    fireEvent.click(within(fromPageSetup).getByRole("button", { name: S.pageSetup.cancel }));
    // Header and Footer… opens the same dialog with the first header slot focused.
    const dialog = await openChromeDialog();
    // The dialog takes the focus in an effect after it mounts: wait for it rather than reading it at
    // once, which a loaded machine can race. The slot that gets it is still checked.
    await waitFor(() => expect(document.activeElement).toBe(field(dialog, "header-left")));
    fireEvent.change(field(dialog, "header-center"), { target: { value: "Frame" } });
    fireEvent.focus(field(dialog, "footer-right"));
    fireEvent.click(within(dialog).getByTestId("ps-insert-page"));
    // The field shows the token, not the value it will draw.
    expect(field(dialog, "footer-right").value).toBe(TOKENS.page);
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ps-apply"));
    });
    // Drawn on the page with the number of the page it lands on, and the hint is gone.
    // `{page}` draws the number alone: the "Page" of a footer is the user's text.
    await waitFor(() => expect(drawnLines()).toEqual(["|Frame|", "||1"]));
    expect(document.querySelector(".header-placeholder")).toBeNull();
    expect(document.querySelector(".footer-placeholder")).toBeNull();
    // One Ctrl+Z takes the two lines away: they travelled in the page setup edit.
    expect(undoButton().getAttribute("title")).toContain("Page setup");
    await act(async () => {
      fireEvent.click(undoButton());
    });
    await waitFor(() => expect(drawnLines()).toEqual([]));
    expect(document.querySelector(".header-placeholder")).not.toBeNull();
  });

  it("the print view draws the same header and footer", async () => {
    const backend = await openDemo();
    const dialog = await openChromeDialog();
    fireEvent.change(field(dialog, "footer-left"), { target: { value: "Beam {page}" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ps-apply"));
    });
    await waitFor(() => expect(drawnLines()).toEqual(["Beam 1||"]));
    expect(backend.setPageSetup).toBeDefined();
    await act(async () => enterPrint());
    const printed = [...document.querySelectorAll<HTMLElement>(".print-page .footer-line")].map(
      (line) => [...line.querySelectorAll("span")].map((slot) => slot.textContent).join("|"),
    );
    expect(printed).toHaveLength(document.querySelectorAll(".sheet > .print-page").length);
    expect(printed[0]).toBe("Beam 1||");
    expect(printed[1]).toBe("Beam 2||");
    await act(async () => leavePrint());
  });

  it("the print view and the PDF take the size from the edited setup", async () => {
    const seen: number[] = [];
    await openDemo({
      choosePdfPath: vi.fn(async () => "/out/page.pdf"),
      exportPdf: vi.fn(async (path: string, w: number, h: number) => {
        seen.push(w, h);
        return { path, pages: 1, width_pt: w, height_pt: h };
      }),
    });
    const dialog = await openDialog();
    fireEvent.change(field(dialog, "size"), { target: { value: "Letter" } });
    fireEvent.change(field(dialog, "orientation"), { target: { value: "landscape" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ps-apply"));
    });
    await waitFor(() => expect(firstPage().style.width).toBe(`${Math.round(ptToPx(792))}px`));
    // The print view draws a block of exactly the edited page size.
    await act(async () => enterPrint());
    const block = document.querySelector<HTMLElement>(".sheet > .print-page")!;
    expect(block.style.width).toBe("792pt");
    expect(block.style.height).toBe("612pt");
    await act(async () => leavePrint());
    expect(isPrinting()).toBe(false);
    // Export PDF… hands the same size to the adapter.
    fireEvent.click(screen.getByRole("tab", { name: "File" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(S.ribbon.commands.exportPdf) }));
    await waitFor(() => expect(seen).toEqual([792, 612]));
  });
});
