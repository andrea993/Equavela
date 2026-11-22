import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ViewRegion } from "../equavelaApi";
import { createMockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { todayIso } from "../layout/pageText";
import { ptToPx } from "../layout/geometry";
import { enterPrint, isPrinting, leavePrint, pageRuleText, printReady, withPrintView } from "./printMode";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(() => {
  leavePrint();
  cleanup();
});

const region = (id: string) => document.querySelector<HTMLElement>(`[data-region-id="${id}"]`);

async function openDemo() {
  render(<App backend={createMockBackend({ fast: true })} />);
  await waitFor(() => expect(region("m1")).not.toBeNull());
  await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
}

describe("print mode store", () => {
  it("marks the root element, keeps one @page rule and is idempotent", () => {
    enterPrint();
    enterPrint({ widthPt: 595.28, heightPt: 841.89 });
    expect(isPrinting()).toBe(true);
    expect(document.documentElement.classList.contains("print-view")).toBe(true);
    const rules = document.querySelectorAll("style[data-print-page]");
    expect(rules).toHaveLength(1);
    expect(rules[0].textContent).toBe("@page { size: 595.28pt 841.89pt; margin: 0; }");
    leavePrint();
    leavePrint();
    expect(isPrinting()).toBe(false);
    expect(document.documentElement.classList.contains("print-view")).toBe(false);
    expect(document.querySelectorAll("style[data-print-page]")).toHaveLength(0);
  });

  it("uses size: auto for the PDF adapters and always zero margins", () => {
    expect(pageRuleText(null)).toBe("@page { size: auto; margin: 0; }");
  });

  it("withPrintView leaves the view when the work fails", async () => {
    await expect(
      withPrintView(null, async () => {
        expect(isPrinting()).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isPrinting()).toBe(false);
  });

  it("printReady returns when there are no plots", async () => {
    await printReady(500);
  });
});

describe("the print view of a worksheet", () => {
  it("draws one block of exactly the page size per page, with the regions inside", async () => {
    await openDemo();
    const screenPages = document.querySelectorAll(".sheet > .page").length;
    const screenRegions = document.querySelectorAll("[data-region-id]").length;
    const m3 = region("m3")!;
    const screenLeft = m3.style.left;
    const screenPage = Number(m3.closest(".page, .sheet")?.getAttribute("data-page") ?? 0);
    expect(screenPage).toBe(0); // on screen regions are siblings of the pages

    await act(async () => enterPrint());
    const pages = [...document.querySelectorAll<HTMLElement>(".sheet > .print-page")];
    expect(pages).toHaveLength(screenPages);
    expect(document.querySelectorAll("[data-region-id]")).toHaveLength(screenRegions);
    // A4 in points, a forced break after every page but the last, nothing clipped by a zoom.
    expect(pages[0].style.width).toBe("595.28pt");
    expect(pages[0].style.height).toBe("841.89pt");
    expect(pages[0].style.breakAfter).toBe(pages.length > 1 ? "page" : "auto");
    expect(pages[pages.length - 1].style.breakAfter).toBe("auto");
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    expect(sheet.style.transform).toBe("");
    // Every region is inside a page block and keeps its horizontal offset; the gap is gone.
    for (const element of document.querySelectorAll<HTMLElement>("[data-region-id]")) {
      expect(element.closest(".print-page")).not.toBeNull();
    }
    expect(region("m3")!.style.left).toBe(screenLeft);
    // Screen-only decorations are not drawn in the print view.
    expect(document.querySelectorAll(".margin-guides")).toHaveLength(0);

    await act(async () => leavePrint());
    expect(document.querySelectorAll(".sheet > .print-page")).toHaveLength(0);
    expect(document.querySelectorAll(".sheet > .page")).toHaveLength(screenPages);
    expect(region("m3")!.style.left).toBe(screenLeft);
  });

  it("a beforeprint event enters the view and afterprint leaves it", async () => {
    await openDemo();
    await act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(isPrinting()).toBe(true);
    expect(document.querySelectorAll(".sheet > .print-page").length).toBeGreaterThan(0);
    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(isPrinting()).toBe(false);
  });

  it("prints a disabled region exactly as the sheet draws it, dimmed", async () => {
    const off: ViewRegion = {
      id: "off",
      page: 1,
      x: 54,
      y: 500,
      enabled: false,
      kind: "text",
      text: "Draft note",
      width: null,
      paragraphs: [{ runs: [{ kind: "text", text: "Draft note" }] }],
    };
    render(<App backend={createMockBackend({ fast: true, extraRegions: [off] })} />);
    await waitFor(() => expect(region("off")).not.toBeNull());
    expect(region("off")!.classList.contains("disabled")).toBe(true);
    await act(async () => enterPrint());
    // The dimming is document content, not chrome: it is not `.no-print` and survives into the PDF.
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="off"]');
    expect(printed).not.toBeNull();
    expect(printed!.classList.contains("disabled")).toBe(true);
    expect(printed!.classList.contains("no-print")).toBe(false);
    await act(async () => leavePrint());
  });

  it("prints a styled and aligned paragraph exactly as the sheet draws it", async () => {
    const styled: ViewRegion = {
      id: "styled",
      page: 1,
      x: 54,
      y: 540,
      enabled: true,
      kind: "text",
      text: "Chapter 1\n\nCentred body",
      width: 300,
      paragraphs: [
        { style: "heading1", runs: [{ kind: "text", text: "Chapter 1" }] },
        { align: "center", runs: [{ kind: "text", text: "Centred body" }] },
      ],
    };
    render(<App backend={createMockBackend({ fast: true, extraRegions: [styled] })} />);
    await waitFor(() => expect(region("styled")).not.toBeNull());
    const drawn = [...region("styled")!.querySelectorAll<HTMLElement>("p")].map((p) => p.getAttribute("style"));
    await act(async () => enterPrint());
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="styled"]');
    expect(printed).not.toBeNull();
    const inPrint = [...printed!.querySelectorAll<HTMLElement>("p")].map((p) => p.getAttribute("style"));
    // The same declarations on screen and in the print: one helper draws both.
    expect(inPrint).toEqual(drawn);
    expect(inPrint[0]).toContain("font-size: 21.333px");
    expect(inPrint[0]).toContain("font-weight: 700");
    expect(inPrint[1]).toContain("text-align: center");
    await act(async () => leavePrint());
  });

  it("prints a formatted math region exactly as the sheet draws it", async () => {
    const fonted: ViewRegion = {
      id: "fonted",
      page: 1,
      x: 54,
      y: 620,
      enabled: true,
      kind: "math",
      text: "a =",
      statement: {
        type: "Evaluate",
        expr: { type: "Ident", name: { segments: [{ text: "a", subscript: false }], label: null } },
        unit: null,
      },
      format: { "math-font.size": "18", "math-font.color": "#c00000", "math-font.highlight": "#ffff00" },
    };
    render(<App backend={createMockBackend({ fast: true, extraRegions: [fonted] })} />);
    await waitFor(() => expect(region("fonted")).not.toBeNull());
    const drawn = region("fonted")!.querySelector<HTMLElement>(".math")!.getAttribute("style");
    await act(async () => enterPrint());
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="fonted"] .math');
    expect(printed).not.toBeNull();
    // The same declarations on screen and in the print: one box draws both.
    expect(printed!.getAttribute("style")).toBe(drawn);
    // 18 pt = 24 px with 30 px of line, and the highlight is printed with the page (R3).
    expect(printed!.getAttribute("style")).toContain("--fs: 24px");
    expect(printed!.getAttribute("style")).toContain("line-height: 30px");
    expect(printed!.getAttribute("style")).toContain("--math-color: #c00000");
    expect(printed!.getAttribute("style")).toContain("background-color: rgb(255, 255, 0)");
    await act(async () => leavePrint());
  });

  it("prints a name in its label style exactly as the sheet draws it", async () => {
    render(<App backend={createMockBackend({ fast: true })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    // The worksheet's variable style: upright and dark red.
    fireEvent.click(screen.getByRole("tab", { name: "Math" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.labelStyles }));
    });
    const dialog = await screen.findByRole("dialog", { name: S.labelStyles.title });
    fireEvent.click(within(dialog).getByTestId("ls-italic"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Dark red" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("ls-apply"));
    });
    const shown = () => region("m1")!.querySelector<HTMLElement>('[data-name="L"]')!;
    await waitFor(() => expect(shown().getAttribute("data-label")).toBe("var"));
    const screenName = shown().outerHTML;
    const screenSheet = screen.getByTestId("sheet").getAttribute("style");
    await act(async () => enterPrint());
    const printed = document.querySelector<HTMLElement>('.print-page [data-region-id="m1"] [data-name="L"]');
    expect(printed).not.toBeNull();
    // The same name markup and the same declarations on screen and in the print: draws one sheet.
    expect(printed!.outerHTML).toBe(screenName);
    expect(printed!.querySelector<HTMLElement>(".id")!.style.fontStyle).toBe("normal");
    const printedSheet = document.querySelector<HTMLElement>(".sheet")!.getAttribute("style");
    expect(printedSheet).toContain("--label-var-color: #c00000");
    expect(screenSheet).toContain("--label-var-color: #c00000");
    await act(async () => leavePrint());
  });

  it("draws the header and the footer on every page and prints them identically", async () => {
    const page = {
      header: { left: "{file}", center: "Frame", right: "Page {page}" },
      footer: { left: "", center: "{date}", right: "" },
    };
    render(<App backend={createMockBackend({ fast: true, page })} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    const tokens = { file: "demo.eqv", date: todayIso() };
    const texts = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLElement>(".header-line, .footer-line")].map((line) =>
        [...line.querySelectorAll("span")].map((slot) => slot.textContent).join("|"),
      );
    // One header and one footer per page, with the tokens of that page, in the page view.
    const pageCount = document.querySelectorAll(".sheet > .page").length;
    expect(pageCount).toBeGreaterThan(1);
    const screen = texts(document.querySelector(".sheet > .page")!.parentElement!);
    expect(screen.slice(0, 2)).toEqual([
      `${tokens.file}|Frame|Page 1`,
      `|${tokens.date}|`,
    ]);
    const all = texts(document);
    expect(all).toHaveLength(pageCount * 2);
    expect(all).toContain(`${tokens.file}|Frame|Page 2`);
    // The line is document content, not chrome: it is not `.no-print` and it fills the margin band,
    // from the left margin to the right margin.
    const band = document.querySelector<HTMLElement>(".sheet > .page .header-line")!;
    expect(band.classList.contains("no-print")).toBe(false);
    expect(band.style.left).toBe(`${ptToPx(54)}px`);
    expect(band.style.width).toBe(`${ptToPx(595.28 - 54 - 54)}px`);
    expect(band.style.height).toBe(`${ptToPx(72)}px`);
    expect(band.style.top).toBe("0px");
    const footerBand = document.querySelector<HTMLElement>(".sheet > .page .footer-line")!;
    expect(footerBand.style.bottom).toBe("0px");
    // An empty slot draws nothing, and the hint of an empty line is not drawn at all.
    expect(document.querySelector(".header-placeholder")).toBeNull();
    // The print view draws the same lines at the same offsets: what the PDF gets is what the
    // screen shows.
    await act(async () => enterPrint());
    const printed = document.querySelectorAll(".sheet > .print-page");
    expect(printed).toHaveLength(pageCount);
    expect(texts(document)).toEqual(all);
    const printedBand = printed[0].querySelector<HTMLElement>(".header-line")!;
    expect(printedBand.style.left).toBe(band.style.left);
    expect(printedBand.style.width).toBe(band.style.width);
    expect(printedBand.style.height).toBe(band.style.height);
    expect(printedBand.classList.contains("no-print")).toBe(false);
    await act(async () => leavePrint());
    expect(texts(document)).toEqual(all);
  });

  it("an empty header and footer draw the screen hint, which is never printed", async () => {
    await openDemo();
    const hint = document.querySelector<HTMLElement>(".header-placeholder")!;
    expect(hint.textContent).toBe(S.page.header);
    expect(hint.classList.contains("no-print")).toBe(true);
    expect(document.querySelector(".footer-placeholder")!.textContent).toBe(`${S.page.footer} · ${S.page.pageNumber(1)}`);
    await act(async () => enterPrint());
    expect(document.querySelectorAll(".header-line, .footer-line")).toHaveLength(0);
    expect(document.querySelector(".print-page .header-placeholder")).toBeNull();
    await act(async () => leavePrint());
  });

  it("does not change the document: no dirty star, same regions", async () => {
    await openDemo();
    const before = [...document.querySelectorAll("[data-region-id]")].map((e) => e.getAttribute("data-region-id"));
    const title = document.title;
    await act(async () => enterPrint());
    await act(async () => leavePrint());
    expect([...document.querySelectorAll("[data-region-id]")].map((e) => e.getAttribute("data-region-id"))).toEqual(before);
    expect(document.title).toBe(title);
  });
});

describe("Export PDF and Print", () => {
  const openWith = async (patch: Partial<ReturnType<typeof createMockBackend>> = {}) => {
    const backend = { ...createMockBackend({ fast: true }), ...patch };
    render(<App backend={backend} />);
    await waitFor(() => expect(region("m1")).not.toBeNull());
    await waitFor(() => expect(region("m4")?.getAttribute("data-state")).toBe("value"));
    return backend;
  };
  const exportButton = () => screen.getByRole("button", { name: new RegExp(S.ribbon.commands.exportPdf) });
  const openDocumentTab = () => fireEvent.click(screen.getByRole("tab", { name: "File" }));

  it("the ribbon button exports the page setup's size from the print view and leaves it afterwards", async () => {
    const seen: { path: string; w: number; h: number; printing: boolean; blocks: number }[] = [];
    await openWith({
      choosePdfPath: vi.fn(async () => "/out/beam.pdf"),
      exportPdf: vi.fn(async (path: string, w: number, h: number) => {
        seen.push({ path, w, h, printing: isPrinting(), blocks: document.querySelectorAll(".sheet > .print-page").length });
        return { path, pages: 1, width_pt: w, height_pt: h };
      }),
    });
    openDocumentTab();
    fireEvent.click(exportButton());
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toMatchObject({ path: "/out/beam.pdf", w: 595.28, h: 841.89, printing: true });
    expect(seen[0].blocks).toBeGreaterThan(0);
    await waitFor(() => expect(isPrinting()).toBe(false));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.messages.pdfSaved("/out/beam.pdf")));
    // The PDF was saved: a green success bar, not the red of an error.
    expect(document.querySelector(".message-bar")?.className).toContain("message-success");
  });

  it("a cancelled dialog exports nothing", async () => {
    const exportPdf = vi.fn();
    await openWith({ choosePdfPath: vi.fn(async () => null), exportPdf });
    openDocumentTab();
    fireEvent.click(exportButton());
    await waitFor(() => expect(screen.getByRole("tab", { name: "File" })).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(exportPdf).not.toHaveBeenCalled();
    expect(isPrinting()).toBe(false);
  });

  it("a failing export is shown and leaves the print view", async () => {
    await openWith({
      choosePdfPath: vi.fn(async () => "/out/x.pdf"),
      exportPdf: vi.fn(async () => {
        throw { kind: "internal", message: "no engine" };
      }),
    });
    openDocumentTab();
    fireEvent.click(exportButton());
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain("no engine"));
    expect(isPrinting()).toBe(false);
  });

  it("the test hook writes to a given path without asking", async () => {
    const choosePdfPath = vi.fn(async () => "/never");
    const exportPdf = vi.fn(async (path: string, w: number, h: number) => ({ path, pages: 1, width_pt: w, height_pt: h }));
    await openWith({ choosePdfPath, exportPdf });
    const hook = (window as unknown as { __equavela: { exportPdf(path: string): Promise<string | null> } }).__equavela;
    expect(await hook.exportPdf("/tmp/hook.pdf")).toBe("/tmp/hook.pdf");
    expect(choosePdfPath).not.toHaveBeenCalled();
    expect(exportPdf).toHaveBeenCalledWith("/tmp/hook.pdf", 595.28, 841.89);
  });

  it("Ctrl+P opens the system dialog from the print view with the paper size of the page setup", async () => {
    await openWith();
    const during: { printing: boolean; rule: string | null }[] = [];
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      during.push({ printing: isPrinting(), rule: document.querySelector("style[data-print-page]")?.textContent ?? null });
      window.dispatchEvent(new Event("afterprint"));
    });
    fireEvent.keyDown(window, { key: "p", code: "KeyP", ctrlKey: true });
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(during[0]).toEqual({ printing: true, rule: "@page { size: 595.28pt 841.89pt; margin: 0; }" });
    await waitFor(() => expect(isPrinting()).toBe(false));
    print.mockRestore();
  });

  it("the command palette lists both commands", async () => {
    const { buildCommandItems } = await import("../catalog/commands");
    const items = buildCommandItems("en-US");
    expect(items.find((i) => i.id === "cmd:exportPdf")?.label).toBe("Export PDF…");
    expect(items.find((i) => i.id === "cmd:print")?.shortcut).toBe("Ctrl+P");
  });
});

describe("a region that straddles a page edge is printed split", () => {
  it("draws its lower part at the top of the next page, once, without a data-region-id", async () => {
    // jsdom has no layout: m15 (y 740 on page 1) is 300 CSS px (225 pt) high, so it reaches below the
    // edge of page 1; every other region is 20 px high.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.regionId === "m15" ? 300 : 20;
    });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    try {
      render(<App backend={createMockBackend({ fast: true })} />);
      await waitFor(() => expect(region("m1")).not.toBeNull());
      const regions = document.querySelectorAll("[data-region-id]").length;
      expect(document.querySelectorAll("[data-continued-of]")).toHaveLength(0);
      await act(async () => enterPrint());
      const pages = [...document.querySelectorAll<HTMLElement>(".sheet > .print-page")];
      const continued = [...document.querySelectorAll<HTMLElement>("[data-continued-of]")];
      expect(continued.length).toBeGreaterThan(0);
      // Each region keeps exactly one element with its id (the first part); the continuation has none.
      expect(document.querySelectorAll("[data-region-id]")).toHaveLength(regions);
      for (const part of continued) {
        const owner = region(part.dataset.continuedOf!)!;
        expect(pages.indexOf(part.closest(".print-page") as HTMLElement)).toBeGreaterThan(pages.indexOf(owner.closest(".print-page") as HTMLElement));
        // Its top is above the page block (a negative offset): the block clips the part that was already printed.
        expect(parseFloat(part.style.top)).toBeLessThan(0);
        expect(part.getAttribute("aria-hidden")).toBe("true");
      }
      leavePrint();
      await waitFor(() => expect(document.querySelectorAll("[data-continued-of]")).toHaveLength(0));
    } finally {
      height.mockRestore();
      width.mockRestore();
    }
  });
});
