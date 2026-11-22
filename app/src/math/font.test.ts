// The math font of a math region.

import { describe, expect, it } from "vitest";
import {
  canStepMathSize,
  DEFAULT_MATH_COLOR,
  DEFAULT_MATH_FONT,
  DEFAULT_MATH_SIZE_PT,
  MATH_COLOR_KEY,
  MATH_COLORS,
  MATH_HIGHLIGHT_KEY,
  MATH_HIGHLIGHTS,
  MATH_SIZE_KEY,
  MATH_SIZES_PT,
  mathFontEdits,
  hasMathFont,
  mathFontOf,
  mathFontStyle,
  parseColor,
  stepMathSize,
  withMathFont,
  withoutMathFont,
} from "./font";

describe("the math font of a region", () => {
  it("reads the three keys of the display override", () => {
    expect(
      mathFontOf({
        [MATH_SIZE_KEY]: "11",
        [MATH_COLOR_KEY]: "#C00000",
        [MATH_HIGHLIGHT_KEY]: "#ffff00",
      }),
    ).toEqual({ sizePt: 11, color: "#c00000", highlight: "#ffff00" });
    expect(mathFontOf(undefined)).toEqual(DEFAULT_MATH_FONT);
    // the reference application's default math size.
    expect(DEFAULT_MATH_FONT).toEqual({ sizePt: 11, color: "#000000", highlight: null });
  });

  it("ignores what the drawing cannot use instead of failing, as a hand-written file may hold it", () => {
    expect(mathFontOf({ [MATH_SIZE_KEY]: "5" }).sizePt).toBe(DEFAULT_MATH_SIZE_PT);
    expect(mathFontOf({ [MATH_SIZE_KEY]: "12.5" }).sizePt).toBe(DEFAULT_MATH_SIZE_PT);
    // An older step outside the reference application's list is still drawn, and steps to the nearest one.
    expect(mathFontOf({ [MATH_SIZE_KEY]: "15" }).sizePt).toBe(15);
    expect(stepMathSize(15, 1)).toBe(16);
    expect(stepMathSize(15, -1)).toBe(14);
    expect(mathFontOf({ [MATH_SIZE_KEY]: "15pt" }).sizePt).toBe(DEFAULT_MATH_SIZE_PT);
    expect(mathFontOf({ [MATH_COLOR_KEY]: "red" }).color).toBe(DEFAULT_MATH_COLOR);
    expect(mathFontOf({ [MATH_HIGHLIGHT_KEY]: "#ff00" }).highlight).toBeNull();
    expect(parseColor("#ABCDEF")).toBe("#abcdef");
    expect(parseColor("abcdef")).toBeNull();
  });

  it("writes only the keys that differ from the default", () => {
    expect(mathFontEdits(DEFAULT_MATH_FONT)).toEqual({
      [MATH_SIZE_KEY]: null,
      [MATH_COLOR_KEY]: null,
      [MATH_HIGHLIGHT_KEY]: null,
    });
    expect(mathFontEdits({ sizePt: 15, color: "#c00000", highlight: "#ffff00" })).toEqual({
      [MATH_SIZE_KEY]: "15",
      [MATH_COLOR_KEY]: "#c00000",
      [MATH_HIGHLIGHT_KEY]: "#ffff00",
    });
  });

  it("keeps the result format and the result-table box of the same override", () => {
    const other = { "format.type": "percent", "result-table-size": "480,180" };
    const red = { sizePt: 18, color: "#c00000", highlight: null };
    const next = withMathFont(other, red);
    expect(next).toEqual({ ...other, [MATH_SIZE_KEY]: "18", [MATH_COLOR_KEY]: "#c00000" });
    // Formatting a region back to the default removes the font keys only.
    expect(withMathFont(next!, DEFAULT_MATH_FONT)).toEqual(other);
    // Reset removes the font keys and nothing else, and an empty override is null.
    expect(withoutMathFont(next!)).toEqual(other);
    expect(withoutMathFont({ [MATH_SIZE_KEY]: "9" })).toBeNull();
    expect(withMathFont(undefined, DEFAULT_MATH_FONT)).toBeNull();
    // A reset of regions that carry no font key changes nothing.
    expect(hasMathFont(undefined)).toBe(false);
    expect(hasMathFont({ "format.type": "percent" })).toBe(false);
    expect(hasMathFont(next!)).toBe(true);
  });

  it("steps through the size list and stays at its ends", () => {
    // the reference application's list.
    expect(MATH_SIZES_PT).toEqual([8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72]);
    // The default 11 pt has no key: Increase writes 12 and Decrease writes 10.
    expect(stepMathSize(DEFAULT_MATH_SIZE_PT, 1)).toBe(12);
    expect(stepMathSize(DEFAULT_MATH_SIZE_PT, -1)).toBe(10);
    expect(stepMathSize(72, 1)).toBe(72);
    expect(stepMathSize(8, -1)).toBe(8);
    expect(canStepMathSize(72, 1)).toBe(false);
    expect(canStepMathSize(48, 1)).toBe(true);
    expect(canStepMathSize(8, -1)).toBe(false);
  });

  it("draws the size in CSS px on a whole-px line and leaves the defaults to the stylesheet", () => {
    expect(mathFontStyle(DEFAULT_MATH_FONT)).toEqual({});
    // 15 pt = 20 px with 25 px of line; the highlight is a background colour. The text colour is
    // a variable so that the red of a failed region still wins.
    expect(mathFontStyle({ sizePt: 15, color: "#c00000", highlight: "#ffff00" })).toEqual({
      "--fs": "20px",
      lineHeight: "25px",
      "--math-color": "#c00000",
      backgroundColor: "#ffff00",
    });
    // A colour alone leaves the size of the stylesheet (11 pt: 14.667 px on 18 px of line).
    expect(mathFontStyle({ sizePt: 11, color: "#0000c0", highlight: null })).toEqual({ "--math-color": "#0000c0" });
    // Every step draws pt × 4/3 px (three decimals) on a whole-px line.
    for (const pt of MATH_SIZES_PT) {
      const style = mathFontStyle({ sizePt: pt, color: "#000000", highlight: null }) as Record<string, string>;
      if (pt === DEFAULT_MATH_SIZE_PT) continue;
      expect(Number(style["--fs"].replace("px", ""))).toBeCloseTo((pt * 4) / 3, 3);
      expect(style.lineHeight).toMatch(/^\d+px$/);
    }
  });

  it("offers a font palette with Automatic first and a highlight palette with None first", () => {
    expect(MATH_COLORS[0]).toEqual({ value: "#000000", name: "Automatic" });
    expect(MATH_HIGHLIGHTS[0]).toEqual({ value: null, name: "None" });
    for (const color of [...MATH_COLORS, ...MATH_HIGHLIGHTS]) {
      if (color.value !== null) expect(parseColor(color.value)).toBe(color.value);
    }
  });
});
