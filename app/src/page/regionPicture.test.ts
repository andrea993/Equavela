// Copied regions go on the clipboard as pictures beside the regions snippet.

import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardNatively, writeClipboardWithPicture } from "../clipboard";
import { isRegionsSnippet } from "./regionsClipboard";
import { imagePicture, pngBlob } from "./regionPicture";

const PNG_BASE64 = "iVBORw0KGgo=";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const picture = (svg = true) =>
  Promise.resolve({ png: pngBlob(PNG_BASE64), svg: svg ? new Blob([SVG], { type: "image/svg+xml" }) : null });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function clipboard(write: (items: unknown[]) => Promise<void>) {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { write, writeText } });
  return writeText;
}

class FakeItem {
  constructor(readonly parts: Record<string, Promise<Blob>>) {}
}

describe("the picture beside the snippet", () => {
  it("writes the snippet, the PNG and the SVG in one clipboard item", async () => {
    vi.stubGlobal("ClipboardItem", FakeItem);
    const items: FakeItem[] = [];
    const writeText = clipboard(async (written) => {
      items.push(...(written as FakeItem[]));
    });
    expect((await writeClipboardWithPicture(Promise.resolve("- id: p1\n"), picture(), true)).written).toBe("both");
    expect(Object.keys(items[0].parts).sort()).toEqual(["image/png", "image/svg+xml", "text/plain"]);
    expect(await (await items[0].parts["text/plain"]).text()).toBe("- id: p1\n");
    expect((await items[0].parts["image/png"]).type).toBe("image/png");
    expect(await (await items[0].parts["image/svg+xml"]).text()).toBe(SVG);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes the item again without the SVG when the web view refuses that type", async () => {
    vi.stubGlobal("ClipboardItem", FakeItem);
    const items: FakeItem[] = [];
    clipboard(async (written) => {
      const item = (written as FakeItem[])[0];
      if ("image/svg+xml" in item.parts) throw new Error("type not supported");
      items.push(item);
    });
    expect((await writeClipboardWithPicture(Promise.resolve("- id: p1\n"), picture(), true)).written).toBe("both");
    expect(Object.keys(items[0].parts).sort()).toEqual(["image/png", "text/plain"]);
  });

  it("copies the snippet alone when the picture fails or the item is refused", async () => {
    vi.stubGlobal("ClipboardItem", FakeItem);
    const writeText = clipboard(async () => {
      throw new Error("refused");
    });
    const outcome = await writeClipboardWithPicture(Promise.resolve("- id: p1\n"), Promise.reject(new Error("no picture")), true);
    expect(outcome).toEqual({ written: "text", reason: "no picture" });
    expect(writeText).toHaveBeenCalledWith("- id: p1\n");
  });

  it("copies the snippet alone where the web view has no clipboard items", async () => {
    const writeText = clipboard(async () => undefined);
    expect((await writeClipboardWithPicture(Promise.resolve("- id: p1\n"), picture(), true)).written).toBe("text");
    expect(writeText).toHaveBeenCalledWith("- id: p1\n");
  });

  it("on Linux writes both natively, and the snippet alone with the reason when that fails", async () => {
    const writeText = clipboard(async () => undefined);
    const native = vi.fn(async () => undefined);
    expect(await writeClipboardNatively("- id: p1\n", picture(), native)).toEqual({ written: "both" });
    expect(native).toHaveBeenCalledWith("- id: p1\n", PNG_BASE64, SVG);
    const failing = vi.fn(async () => {
      throw new Error("the clipboard could not be taken");
    });
    expect(await writeClipboardNatively("- id: p1\n", picture(), failing)).toEqual({
      written: "text",
      reason: "the clipboard could not be taken",
    });
    expect(writeText).toHaveBeenCalledWith("- id: p1\n");
  });

  it("gives a stored PNG as its own bytes", async () => {
    const region = { kind: "image", media: "png", size: [10, 10] } as never;
    const blob = await imagePicture(region, `data:image/png;base64,${PNG_BASE64}`);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("recognises a regions snippet, which wins over a picture on paste", () => {
    expect(isRegionsSnippet("- id: r1\n  page: 1\n")).toBe(true);
    expect(isRegionsSnippet("  - id: r1")).toBe(true);
    expect(isRegionsSnippet("x + 1")).toBe(false);
    expect(isRegionsSnippet("")).toBe(false);
    expect(isRegionsSnippet(null)).toBe(false);
  });
});
