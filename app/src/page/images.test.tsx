// Image regions in the window, on the mock backend.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { createMockBackend, type MockBackend } from "../mock/mockBackend";
import { S } from "../strings";
import { resizeImage } from "../layout/geometry";

vi.mock("../plot/plotlyBundle", () => ({ default: { react: vi.fn(async () => undefined), purge: vi.fn(), register: vi.fn() } }));

afterEach(cleanup);

const images = () => [...document.querySelectorAll<HTMLElement>("[data-testid=image]")];
const imageRegions = () => [...document.querySelectorAll<HTMLElement>("[data-kind=image]")];
const undoButton = () => within(screen.getByRole("toolbar", { name: S.quickAccess.label })).getByRole("button", { name: S.quickAccess.undo }) as HTMLButtonElement;

async function openEmpty(): Promise<MockBackend> {
  const backend = createMockBackend({ fast: true });
  render(<App backend={backend} />);
  await waitFor(() => expect(document.querySelector("[data-region-id=m1]")).not.toBeNull());
  return backend;
}

async function insertFromRibbon() {
  fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
  fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.image }));
  await waitFor(() => expect(imageRegions().length).toBeGreaterThan(0));
}

/** A PNG header of the given pixel size, as a File (the mock reads the size from it). */
function pngFile(width: number, height: number, name = "pasted.png"): File {
  const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const size = new Uint8Array(8);
  new DataView(size.buffer).setUint32(0, width);
  new DataView(size.buffer).setUint32(4, height);
  return new File([head, size, new Uint8Array([8, 2, 0, 0, 0])], name, { type: "image/png" });
}

describe("image regions", () => {
  it("inserts from the Document ribbon, draws an <img> of its size, and undo and redo work", async () => {
    await openEmpty();
    const before = imageRegions().length;
    await insertFromRibbon();
    expect(imageRegions().length).toBe(before + 1);
    const view = images().at(-1)!;
    // The mock figure is 180 x 90 pt = 240 x 120 CSS px.
    expect(view.style.width).toBe("240px");
    expect(view.style.height).toBe("120px");
    await waitFor(() => expect(view.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/));
    expect(view.querySelector("img")?.getAttribute("draggable")).toBe("false");
    // The new image is selected and the undo label names it.
    expect(imageRegions().at(-1)!.classList.contains("selected")).toBe(true);
    expect(undoButton().getAttribute("title")).toContain("Add image");
    fireEvent.click(undoButton());
    await waitFor(() => expect(imageRegions().length).toBe(before));
    fireEvent.click(screen.getByRole("button", { name: S.quickAccess.redo }));
    await waitFor(() => expect(imageRegions().length).toBe(before + 1));
  });

  it("is in the command palette as Insert image", async () => {
    await openEmpty();
    fireEvent.click(screen.getByRole("tab", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.commandPalette }));
    const box = await screen.findByRole("searchbox", { name: S.commands.search });
    fireEvent.change(box, { target: { value: "insert image" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(imageRegions().length).toBeGreaterThan(0));
  });

  it("pastes a PNG from the clipboard at the crosshair", async () => {
    await openEmpty();
    await act(async () => {
      fireEvent.paste(document.body, { clipboardData: { files: [pngFile(80, 40)], items: [], getData: () => "" } });
    });
    await waitFor(() => expect(imageRegions().length).toBe(1));
    // 80 x 40 px = 60 x 30 pt = 80 x 40 CSS px.
    expect(images()[0].style.width).toBe("80px");
    await waitFor(() => expect(images()[0].querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png;base64,/));
  });

  it("copies an image region with the bytes of its picture and pastes it back", async () => {
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
      await openEmpty();
      await insertFromRibbon();
      const before = imageRegions().length;
      await act(async () => {
        fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true });
      });
      // The snippet is a region item plus the bytes of the picture, after the list.
      await waitFor(() => expect(clipboard).toContain("  image:"));
      expect(clipboard).toContain("    resource: img1");
      expect(clipboard).toContain("resources:\n  img1:\n    media: svg\n    text: ");
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      await waitFor(() => expect(imageRegions().length).toBe(before + 1));
      // The pasted region draws the picture the snippet carried: the bytes arrived with it.
      await waitFor(() =>
        expect(images().at(-1)!.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/),
      );
      expect(undoButton().getAttribute("title")).toContain("Paste");
      fireEvent.click(undoButton());
      await waitFor(() => expect(imageRegions().length).toBe(before));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copies a plot region and pastes it back with its traces", async () => {
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
    const plotRegions = () => [...document.querySelectorAll<HTMLElement>("[data-kind=plot]")];
    try {
      await openEmpty();
      fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
      fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.plot }));
      await waitFor(() => expect(plotRegions().length).toBeGreaterThan(0));
      const before = plotRegions().length;
      await act(async () => {
        fireEvent.keyDown(window, { key: "c", code: "KeyC", ctrlKey: true });
      });
      await waitFor(() => expect(clipboard).toContain("  plot: {"));
      expect(clipboard).toContain('"traces"');
      fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.paste }));
      });
      await waitFor(() => expect(plotRegions().length).toBe(before + 1));
      fireEvent.click(undoButton());
      await waitFor(() => expect(plotRegions().length).toBe(before));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops image files onto the page and reports other files", async () => {
    await openEmpty();
    const area = screen.getByTestId("worksheet-area");
    await act(async () => {
      fireEvent.drop(area, {
        clientX: 300,
        clientY: 300,
        dataTransfer: { files: [pngFile(40, 40, "a.png"), new File(["text"], "notes.txt", { type: "text/plain" })], types: ["Files"] },
      });
    });
    await waitFor(() => expect(imageRegions().length).toBe(1));
    expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.messages.notAnImage("notes.txt"));
  });

  it("adds images dropped by the native drag and drop (paths) and refuses other paths", async () => {
    const backend = await openEmpty();
    await act(async () => backend.dropFiles(["C:\\pics\\figure.svg", "C:\\pics\\readme.txt"], { x: 400, y: 300 }));
    await waitFor(() => expect(imageRegions().length).toBe(1));
    expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain(S.messages.notAnImage("readme.txt"));
  });

  it("resizes with the aspect ratio locked, Shift releases it, one undo step per drag", async () => {
    await openEmpty();
    await insertFromRibbon();
    const region = () => imageRegions().at(-1)!;
    const size = () => [parseFloat(images().at(-1)!.style.width), parseFloat(images().at(-1)!.style.height)];
    await waitFor(() => expect(region().querySelector("[data-testid=resize-handle]")).not.toBeNull());
    const handle = () => region().querySelector("[data-testid=resize-handle]")!;
    expect(size()).toEqual([240, 120]);
    // +120 CSS px wide: the height follows (ratio 2:1).
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 620, clientY: 400 }));
    expect(size()).toEqual([360, 180]);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 620, clientY: 400 }));
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Resize image"));
    expect(size()).toEqual([360, 180]);
    // Shift: the width and height are free.
    await waitFor(() => expect(region().querySelector("[data-testid=resize-handle]")).not.toBeNull());
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 500, clientY: 460, shiftKey: true }));
    expect(size()).toEqual([360, 240]);
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 500, clientY: 460 }));
    await waitFor(() => expect(size()).toEqual([360, 240]));
    fireEvent.click(undoButton());
    await waitFor(() => expect(size()).toEqual([360, 180]));
    fireEvent.click(undoButton());
    await waitFor(() => expect(size()).toEqual([240, 120]));
  });

  it("keeps the dropped size until the stored size arrives, never flashing the old one", async () => {
    const backend = await openEmpty();
    await insertFromRibbon();
    const size = () => [parseFloat(images().at(-1)!.style.width), parseFloat(images().at(-1)!.style.height)];
    await waitFor(() => expect(document.querySelector("[data-kind=image] [data-testid=resize-handle]")).not.toBeNull());
    // The stored size lands only when the test lets it: the view keeps the old one meanwhile.
    let land: () => void = () => {};
    const store = backend.setImageSize.bind(backend);
    backend.setImageSize = (...args) => new Promise((resolve) => (land = () => resolve(store(...args))));
    const handle = document.querySelector("[data-kind=image] [data-testid=resize-handle]")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 620, clientY: 400 }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 620, clientY: 400 }));
    expect(size()).toEqual([360, 180]);
    await act(async () => land());
    await waitFor(() => expect(undoButton().getAttribute("title")).toContain("Resize image"));
    expect(size()).toEqual([360, 180]);
  });

  it("a press and release on the handle without moving changes nothing", async () => {
    await openEmpty();
    await insertFromRibbon();
    await waitFor(() => expect(document.querySelector("[data-kind=image] [data-testid=resize-handle]")).not.toBeNull());
    const handle = document.querySelector("[data-kind=image] [data-testid=resize-handle]")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 500, clientY: 400 }));
    expect(undoButton().getAttribute("title")).toContain("Add image");
  });

  it("shows a message and no region when the file is not an image", async () => {
    const backend = await openEmpty();
    backend.chooseImagePath = async () => "/demo/bad.png";
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.image }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain("Could not insert the image"));
    expect(imageRegions().length).toBe(0);
  });
});

describe("the Image tab", () => {
  const selectedTabLabel = () =>
    screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

  it("appears while one image is selected and carries Delete, Original Size and Replace…", async () => {
    await openEmpty();
    expect(screen.queryByRole("tab", { name: S.ribbon.tabs.image })).toBeNull();
    await insertFromRibbon();
    await waitFor(() => expect(selectedTabLabel()).toBe(S.ribbon.tabs.image));
    for (const label of [S.ribbon.commands.originalSize, S.ribbon.commands.replaceImage, S.ribbon.commands.deleteRegion]) {
      expect(screen.getByRole("button", { name: label })).not.toBeNull();
    }
    // The tab leaves with the selection: Escape clears it and Insert comes back.
    await act(async () => void fireEvent.keyDown(window, { key: "Escape", code: "Escape" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: S.ribbon.tabs.image })).toBeNull());
    expect(screen.getByRole("tab", { name: "Insert" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Original Size brings a resized image back to its own size as one undo step", async () => {
    await openEmpty();
    await insertFromRibbon();
    const size = () => [parseFloat(images().at(-1)!.style.width), parseFloat(images().at(-1)!.style.height)];
    const handle = () => imageRegions().at(-1)!.querySelector("[data-testid=resize-handle]")!;
    await waitFor(() => expect(handle()).not.toBeNull());
    // The mock drawing is 180 x 90 pt = 240 x 120 CSS px; +120 px wide keeps the ratio.
    expect(size()).toEqual([240, 120]);
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500, clientY: 400 });
    await act(async () => void fireEvent.pointerMove(window, { clientX: 620, clientY: 400 }));
    await act(async () => void fireEvent.pointerUp(window, { button: 0, clientX: 620, clientY: 400 }));
    await waitFor(() => expect(size()).toEqual([360, 180]));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.originalSize }));
    await waitFor(() => expect(size()).toEqual([240, 120]));
    expect(undoButton().getAttribute("title")).toContain("Original size");
    fireEvent.click(undoButton());
    await waitFor(() => expect(size()).toEqual([360, 180]));
  });

  it("Replace keeps the position, swaps the picture and is one undo step", async () => {
    await openEmpty();
    await act(async () => {
      fireEvent.paste(document.body, { clipboardData: { files: [pngFile(80, 40)], items: [], getData: () => "" } });
    });
    await waitFor(() => expect(imageRegions().length).toBe(1));
    const region = () => imageRegions()[0];
    const picture = () => images()[0].querySelector("img")?.getAttribute("src") ?? "";
    await waitFor(() => expect(picture()).toMatch(/^data:image\/png;base64,/));
    // 80 x 40 px = 60 x 30 pt = 80 x 40 CSS px.
    expect(images()[0].style.width).toBe("80px");
    const left = region().style.left;
    const top = region().style.top;
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.replaceImage }));
    // The dialog is the same one Insert uses; the mock "chooses" its drawing.
    await waitFor(() => expect(picture()).toMatch(/^data:image\/svg\+xml;base64,/));
    expect(images()[0].style.width).toBe("240px");
    expect(images()[0].style.height).toBe("120px");
    expect(region().style.left).toBe(left);
    expect(region().style.top).toBe(top);
    expect(undoButton().getAttribute("title")).toContain("Replace image");
    fireEvent.click(undoButton());
    await waitFor(() => expect(picture()).toMatch(/^data:image\/png;base64,/));
    expect(images()[0].style.width).toBe("80px");
  });

  it("says a file that is not an image leaves the region as it was", async () => {
    const backend = await openEmpty();
    await insertFromRibbon();
    const picture = () => images().at(-1)!.querySelector("img")?.getAttribute("src") ?? "";
    await waitFor(() => expect(picture()).toMatch(/^data:image\/svg\+xml;base64,/));
    backend.chooseImagePath = async () => "/demo/bad.png";
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.replaceImage }));
    await waitFor(() => expect((document.querySelector(".message-bar")?.textContent ?? "")).toContain("Could not replace the image"));
    expect(imageRegions().length).toBe(1);
    expect(picture()).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("Delete in the Image tab removes the image and the tab leaves with it", async () => {
    await openEmpty();
    await insertFromRibbon();
    await waitFor(() => expect(selectedTabLabel()).toBe(S.ribbon.tabs.image));
    fireEvent.click(screen.getByRole("button", { name: S.ribbon.commands.deleteRegion }));
    await waitFor(() => expect(imageRegions().length).toBe(0));
    await waitFor(() => expect(screen.queryByRole("tab", { name: S.ribbon.tabs.image })).toBeNull());
  });
});

describe("resizeImage", () => {
  const start = { w: 240, h: 120 };
  it("keeps the ratio and follows the axis that moved further", () => {
    expect(resizeImage(start, 60, 0, true, 500, 700)).toEqual({ w: 300, h: 150 });
    expect(resizeImage(start, 0, 60, true, 500, 700)).toEqual({ w: 360, h: 180 });
  });
  it("releases the ratio without the lock", () => {
    expect(resizeImage(start, 60, 30, false, 500, 700)).toEqual({ w: 300, h: 150 });
    expect(resizeImage(start, 60, -30, false, 500, 700)).toEqual({ w: 300, h: 90 });
  });
  it("snaps to 0.75 pt, stays at least 12 pt and within the maxima", () => {
    expect(resizeImage(start, 10.2, 0, true, 500, 700).w).toBeCloseTo(250.5, 5);
    expect(resizeImage(start, -1000, 0, true, 500, 700)).toEqual({ w: 24, h: 12 });
    expect(resizeImage(start, 1000, 0, true, 400, 700).w).toBe(400);
    expect(resizeImage(start, 1000, 0, true, 5000, 100).h).toBeLessThanOrEqual(100.75);
    expect(resizeImage(start, -1000, -1000, false, 500, 700)).toEqual({ w: 12, h: 12 });
  });
});

describe("image loading while the worksheet is busy", () => {
  it("asks again until the resource can be read", async () => {
    const { imageEnv } = await import("./ImageContext");
    let calls = 0;
    const env = imageEnv("busy-test", async () => {
      if (++calls < 3) throw { kind: "busy", message: "a calculation is running" };
      return "data:image/png;base64,AA==";
    });
    await expect(env.load("img1")).resolves.toBe("data:image/png;base64,AA==");
    expect(calls).toBe(3);
    // Cached afterwards; another error is not retried and not remembered.
    await env.load("img1");
    expect(calls).toBe(3);
    const failing = imageEnv("busy-test", async () => {
      throw { kind: "region", message: "no such resource" };
    });
    await expect(failing.load("other")).rejects.toMatchObject({ kind: "region" });
  });
});
