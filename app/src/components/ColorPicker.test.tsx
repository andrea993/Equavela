// The colour conversions and the pointer areas of the RGB picker.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S } from "../strings";
import { ColorDialog, ColorPicker, hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from "./ColorPicker";

afterEach(cleanup);

describe("colour conversion", () => {
  it("goes between hex, rgb and hsv", () => {
    expect(hexToRgb("#12ab56")).toEqual([0x12, 0xab, 0x56]);
    expect(rgbToHex(255, 0, 128)).toBe("#ff0080");
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]);
    expect(rgbToHsv(0, 0, 255)[0]).toBe(240);
    expect(rgbToHsv(128, 128, 128)).toEqual([0, 0, 128 / 255]);
    for (const hex of ["#c00000", "#00a000", "#8000c0", "#ffbf00", "#404040"]) {
      expect(rgbToHex(...hsvToRgb(...rgbToHsv(...hexToRgb(hex))))).toBe(hex);
    }
  });
});

describe("the RGB picker", () => {
  // jsdom has no layout: the areas get a 200 px box so a pointer position maps to a fraction.
  const box = { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) };

  it("takes a colour from the area and the hue bar with the mouse", () => {
    const onOk = vi.fn();
    render(<ColorDialog title="Text color" initial="#000000" onOk={onOk} onCancel={() => {}} />);
    const area = screen.getByTestId("color-area");
    const hue = screen.getByTestId("color-hue");
    area.getBoundingClientRect = () => box as DOMRect;
    hue.getBoundingClientRect = () => box as DOMRect;
    // Hue bar at the top: red. Area at the top right: full saturation and value, so pure red.
    fireEvent.pointerDown(hue, { clientX: 5, clientY: 0, buttons: 1 });
    fireEvent.pointerDown(area, { clientX: 200, clientY: 0, buttons: 1 });
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText(S.text.hexCode) as HTMLInputElement).value).toBe("#ff0000");
    // Dragging to the middle of the hue bar turns the same point to cyan, and halfway down the area darkens it.
    fireEvent.pointerMove(hue, { clientX: 5, clientY: 100, buttons: 1 });
    expect((within(dialog).getByLabelText(S.text.hexCode) as HTMLInputElement).value).toBe("#00ffff");
    fireEvent.pointerMove(area, { clientX: 200, clientY: 100, buttons: 1 });
    expect((within(dialog).getByLabelText(S.text.hexCode) as HTMLInputElement).value).toBe("#008080");
    fireEvent.click(within(dialog).getByRole("button", { name: S.text.ok }));
    expect(onOk).toHaveBeenCalledWith("#008080");
  });

  it("Cancel and Escape apply nothing", () => {
    const onOk = vi.fn();
    const onCancel = vi.fn();
    render(<ColorDialog title="Text color" initial="#336699" onOk={onOk} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: S.text.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onOk).not.toHaveBeenCalled();
  });
});

describe("the colours of the worksheet and the eyedropper", () => {
  const picker = (onPick = vi.fn(), worksheetColors: readonly string[] = ["#1f5fbf", "#abcdef"]) => {
    render(
      <ColorPicker label="Line color" none="Automatic" colors={[{ value: "#c00000", name: "Dark red" }]} value="#1f5fbf" disabled={false} title="Line color" onPick={onPick} worksheetColors={worksheetColors} hideLabel />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Line color" }));
    return onPick;
  };
  afterEach(() => {
    delete (window as unknown as { EyeDropper?: unknown }).EyeDropper;
  });

  it("offers the colours the worksheet already uses and a click takes one", () => {
    const onPick = picker();
    const row = screen.getByTestId("worksheet-colors");
    expect(screen.getByText(S.text.worksheetColors)).toBeDefined();
    expect([...row.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["#1f5fbf", "#abcdef"]);
    fireEvent.click(within(row).getByLabelText("#abcdef"));
    expect(onPick).toHaveBeenCalledWith("#abcdef");
  });

  it("has no row when the worksheet has no colours, and the label can stay out of the ribbon", () => {
    picker(vi.fn(), []);
    expect(screen.queryByTestId("worksheet-colors")).toBeNull();
    expect(screen.queryByText(S.text.worksheetColors)).toBeNull();
    // `hideLabel`: the button has its accessible name but the label is not drawn next to it.
    expect(document.querySelector(".color-picker > .tool-label")).toBeNull();
  });

  it("Automatic hands back null", () => {
    const onPick = picker();
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("the eyedropper button shows only where the webview has the API, and hands back the colour it took", async () => {
    // WebKitGTK: no EyeDropper, no button.
    picker();
    expect(screen.queryByTestId("eyedropper")).toBeNull();
    cleanup();
    (window as unknown as { EyeDropper: unknown }).EyeDropper = class {
      open() {
        return Promise.resolve({ sRGBHex: "#12AB34" });
      }
    };
    const onPick = picker();
    fireEvent.click(screen.getByTestId("eyedropper"));
    await vi.waitFor(() => expect(onPick).toHaveBeenCalledWith("#12ab34"));
  });
});
