// The page setup arithmetic of the dialog, with no DOM:
// the standard sizes, the orientation, the mm/pt switch and the check that keeps a file and the
// dialog in step.

import { describe, expect, it } from "vitest";
import type { PageSetup } from "../equavelaApi";
import { emptyLine } from "./pageText";
import {
  CUSTOM_SIZE,
  fromUnit,
  isLandscape,
  namedSize,
  pageSetupProblem,
  roundPoints,
  sizeIdOf,
  toUnit,
  withOrientation,
} from "./pageSetup";

const setup = (width: number, height: number, margins: [number, number, number, number] = [72, 54, 72, 54]): PageSetup => ({
  size: "custom",
  width,
  height,
  margins: { top: margins[0], right: margins[1], bottom: margins[2], left: margins[3] },
  header: emptyLine(),
  footer: emptyLine(),
});

describe("page sizes", () => {
  it("holds the standard sizes in points, portrait, under the names the file stores", () => {
    expect(namedSize("A4")).toEqual({ width: 595.28, height: 841.89 });
    expect(namedSize("Letter")).toEqual({ width: 612, height: 792 });
    expect(namedSize("Legal")).toEqual({ width: 612, height: 1008 });
    expect(namedSize("Tabloid")).toBeNull();
    expect(namedSize(CUSTOM_SIZE)).toBeNull();
  });

  it("shows a standard name only when the dimensions are that size, as the core stores it", () => {
    expect(sizeIdOf(setup(595.28, 841.89))).toBe(CUSTOM_SIZE);
    expect(sizeIdOf({ ...setup(595.28, 841.89), size: "A4" })).toBe("A4");
    // Landscape A4 is still A4, and a name the dimensions do not match is custom.
    expect(sizeIdOf({ ...setup(841.89, 595.28), size: "A4" })).toBe("A4");
    expect(sizeIdOf({ ...setup(600, 841.89), size: "A4" })).toBe(CUSTOM_SIZE);
    expect(sizeIdOf({ ...setup(612, 792), size: "Tabloid" })).toBe(CUSTOM_SIZE);
    expect(sizeIdOf({ ...setup(612, 792), size: CUSTOM_SIZE })).toBe(CUSTOM_SIZE);
  });

  it("reads the orientation from the order of the two dimensions and swaps only when it changes", () => {
    expect(isLandscape(612, 792)).toBe(false);
    expect(isLandscape(792, 612)).toBe(true);
    // A named size picked while the dialog is in landscape keeps that orientation.
    expect(withOrientation(612, 792, true)).toEqual({ width: 792, height: 612 });
    expect(withOrientation(612, 792, false)).toEqual({ width: 612, height: 792 });
    expect(withOrientation(792, 612, true)).toEqual({ width: 792, height: 612 });
  });
});

describe("millimetres and points", () => {
  it("converts at 25.4 mm per inch and comes back to the same value", () => {
    expect(roundPoints(1 * (72 / 25.4))).toBe(2.83);
    expect(fromUnit(20, "mm")).toBe(56.69);
    expect(fromUnit(595.28, "pt")).toBe(595.28);
    // What the dialog shows after typing 20 mm is 20 mm again.
    expect(toUnit(fromUnit(20, "mm"), "mm")).toBe(20);
    // The standard sizes survive the round trip through the fields.
    for (const points of [595.28, 841.89, 612, 792, 54, 72]) {
      expect(fromUnit(toUnit(points, "mm"), "mm")).toBe(points);
      expect(fromUnit(toUnit(points, "pt"), "pt")).toBe(points);
    }
    expect(toUnit(612, "mm")).toBe(215.9);
  });
});

describe("what the dialog refuses", () => {
  it("accepts a usable setup and names what is wrong", () => {
    expect(pageSetupProblem(setup(595.28, 841.89))).toBeNull();
    expect(pageSetupProblem(setup(595.28, 841.89, [0, 0, 0, 0]))).toBeNull();
    expect(pageSetupProblem(setup(0, 841.89))).toBe("size");
    expect(pageSetupProblem(setup(Number.NaN, 841.89))).toBe("size");
    expect(pageSetupProblem(setup(595.28, 841.89, [-1, 0, 0, 0]))).toBe("negative");
    expect(pageSetupProblem(setup(595.28, 841.89, [72, 54, 72, 600]))).toBe("no-room");
    expect(pageSetupProblem(setup(595.28, 841.89, [500, 54, 500, 54]))).toBe("no-room");
  });

  it("refuses a header or a footer that is not one line of text", () => {
    const page = setup(595.28, 841.89);
    expect(pageSetupProblem(page)).toBeNull();
    expect(pageSetupProblem({ ...page, footer: { left: "one\ntwo", center: "", right: "" } })).toBe("line");
    expect(pageSetupProblem({ ...page, header: { left: "", center: "", right: "a\tb" } })).toBe("line");
    // The lengths are still checked first, as the core checks them.
    expect(pageSetupProblem({ ...setup(0, 841.89), header: { left: "a\nb", center: "", right: "" } })).toBe("size");
  });
});
