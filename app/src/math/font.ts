// The math font of a math region:
// a size, a text colour and a highlight colour. Display only, stored in
// the region display override (`app/src/results/format.ts` holds the `format.*` keys and the
// result-table box of the same override).

import type { CSSProperties } from "react";
import { FONT_SIZES_PT, lineHeightPx, sizeCss } from "../text/value";

/** The size steps of, in points: the text sizes, the reference application's list. */
export const MATH_SIZES_PT = FONT_SIZES_PT;
/** The size of a math region that carries no size key: 11 pt, the reference application's default math size. */
export const DEFAULT_MATH_SIZE_PT = 11;

/** The region display override keys of the math font. */
export const MATH_SIZE_KEY = "math-font.size";
export const MATH_COLOR_KEY = "math-font.color";
export const MATH_HIGHLIGHT_KEY = "math-font.highlight";

/** The default text colour: black, written as no key at all. */
export const DEFAULT_MATH_COLOR = "#000000";

/** The font of a math region: its size in points, its text colour and its highlight (null: none). */
export type MathFont = {
  sizePt: number;
  color: string;
  highlight: string | null;
};

/** The default math font: 11 pt, black, no highlight. */
export const DEFAULT_MATH_FONT: MathFont = {
  sizePt: DEFAULT_MATH_SIZE_PT,
  color: DEFAULT_MATH_COLOR,
  highlight: null,
};

/** `#rrggbb`, either case: the form the file stores. */
const COLOR = /^#[0-9a-f]{6}$/i;

/** The colour of a stored value, lower case, or null when it is not a colour. */
export function parseColor(text: string | undefined): string | null {
  return text !== undefined && COLOR.test(text) ? text.toLowerCase() : null;
}

/**
 * The math font a region display override holds. A value the drawing cannot use is
 * ignored, so a hand-written file never fails: a size that is not a step keeps the default and a
 * colour that is not `#rrggbb` keeps the default colour (or no highlight).
 */
export function mathFontOf(override?: Record<string, string>): MathFont {
  if (!override) return DEFAULT_MATH_FONT;
  const size = Number(override[MATH_SIZE_KEY]);
  // Any whole size from 6 to 72 pt is drawn, so a file written with the older steps (15, 21, 30 pt)
  // keeps its sizes; the editor offers the reference application's list.
  const sizePt = Number.isInteger(size) && size >= 6 && size <= 72 ? size : DEFAULT_MATH_SIZE_PT;
  return {
    sizePt,
    color: parseColor(override[MATH_COLOR_KEY]) ?? DEFAULT_MATH_COLOR,
    highlight: parseColor(override[MATH_HIGHLIGHT_KEY]),
  };
}

/**
 * The display-override keys of a font: a value equal to its default is written as `null`,
 * so it is removed and a worksheet whose math looks default carries no key.
 */
export function mathFontEdits(font: MathFont): Record<string, string | null> {
  return {
    [MATH_SIZE_KEY]: font.sizePt === DEFAULT_MATH_SIZE_PT ? null : String(font.sizePt),
    [MATH_COLOR_KEY]: font.color.toLowerCase() === DEFAULT_MATH_COLOR ? null : font.color.toLowerCase(),
    [MATH_HIGHLIGHT_KEY]: font.highlight === null ? null : font.highlight.toLowerCase(),
  };
}

/** The keys of the math font, for the commands that keep them. */
const FONT_KEYS = [MATH_SIZE_KEY, MATH_COLOR_KEY, MATH_HIGHLIGHT_KEY];

/** Whether the override carries any of the three font keys. */
export function hasMathFont(override: Record<string, string> | undefined): boolean {
  return FONT_KEYS.some((key) => override?.[key] !== undefined);
}

/** The override without the math-font keys, keeping every other key: null when empty. */
export function withoutMathFont(override: Record<string, string> | undefined): Record<string, string> | null {
  const kept = Object.entries(override ?? {}).filter(([key]) => !FONT_KEYS.includes(key));
  return kept.length > 0 ? Object.fromEntries(kept) : null;
}

/**
 * The override with the font keys of `font`: a key at its default is removed and the other
 * keys of the override are left alone, so formatting a region does not throw its result format or
 * its result-table box away. Null when the override becomes empty.
 */
export function withMathFont(override: Record<string, string> | undefined, font: MathFont): Record<string, string> | null {
  const next: Record<string, string> = { ...(withoutMathFont(override) ?? {}) };
  for (const [key, value] of Object.entries(mathFontEdits(font))) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : null;
}

/** The step of the list after `pt` going up (1) or down (-1), or null at an end. A size
 * that is not a step (an older file's 15 pt) moves to the nearest step on that side. */
function nextStep(pt: number, direction: 1 | -1): number | null {
  const steps = MATH_SIZES_PT as readonly number[];
  const found = direction === 1 ? steps.find((step) => step > pt) : [...steps].reverse().find((step) => step < pt);
  return found ?? null;
}

/** Whether Increase (1) or Decrease (-1) can move `pt`: the ends of the list stay put. */
export function canStepMathSize(pt: number, direction: 1 | -1): boolean {
  return nextStep(pt, direction) !== null;
}

/** The next step up (1) or down (-1) of a size; an end of the list stays where it is. */
export function stepMathSize(pt: number, direction: 1 | -1): number {
  return nextStep(pt, direction) ?? pt;
}

/**
 * The CSS of a region's math box: the size in CSS px and the line height in whole px (the
 * conversion of `text/value.ts`, so 12 pt is 16 px on 20 px of line) and the two colours. A
 * property at its default is left out, so a default region carries no declaration at all and the
 * stylesheet draws what it always drew.
 */
export function mathFontStyle(font: MathFont): CSSProperties {
  const style: Record<string, string> = {};
  if (font.sizePt !== DEFAULT_MATH_SIZE_PT) {
    style["--fs"] = sizeCss(font.sizePt);
    style.lineHeight = `${lineHeightPx(font.sizePt)}px`;
  }
  // The text colour is the custom property `--math-color` of the stylesheet, not the `color`
  // declaration: an inline `color` would also beat the red of a region whose calculation failed,
  // and the error mark must stay readable.
  if (font.color.toLowerCase() !== DEFAULT_MATH_COLOR) style["--math-color"] = font.color;
  if (font.highlight !== null) style.backgroundColor = font.highlight;
  return style as CSSProperties;
}

/** A colour of the two swatch rows of the dialog, with the name its tooltip shows. */
export type MathColor = { value: string; name: string };

/** The font-colour palette. The first swatch is **Automatic**: the default black. */
export const MATH_COLORS: readonly MathColor[] = [
  { value: "#000000", name: "Automatic" },
  { value: "#404040", name: "Dark gray" },
  { value: "#808080", name: "Gray" },
  { value: "#c00000", name: "Dark red" },
  { value: "#ff0000", name: "Red" },
  { value: "#ff7f00", name: "Orange" },
  { value: "#ffbf00", name: "Amber" },
  { value: "#808000", name: "Olive" },
  { value: "#00a000", name: "Green" },
  { value: "#00c0c0", name: "Cyan" },
  { value: "#0000c0", name: "Blue" },
  { value: "#8000c0", name: "Violet" },
  { value: "#ff00ff", name: "Magenta" },
];

/** A swatch whose value may be the default of its palette (`null`: no highlight). */
export type MathSwatch = { value: string | null; name: string };

/** The highlight palette. The first swatch is **None**: no background. */
export const MATH_HIGHLIGHTS: readonly MathSwatch[] = [
  { value: null, name: "None" },
  { value: "#ffff00", name: "Yellow" },
  { value: "#c6efce", name: "Light green" },
  { value: "#b7e1f5", name: "Light blue" },
  { value: "#f8c6f0", name: "Light magenta" },
  { value: "#ffd8a8", name: "Light orange" },
  { value: "#ffc7c7", name: "Light red" },
  { value: "#e0e0e0", name: "Light gray" },
];
