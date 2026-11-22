// The page setup of a worksheet: the standard sizes, the
// orientation (the order of the two dimensions), the mm/pt switch of the dialog and the check of.
// Everything here is pure, so the dialog and its tests share one definition of the
// arithmetic. All the values a worksheet stores are in points.

import type { PageSetup } from "../equavelaApi";
import { pageLineProblem } from "./pageText";

/** Points per millimetre: 1 in = 25.4 mm = 72 pt. */
export const PT_PER_MM = 72 / 25.4;

/** The unit the dialog's length fields use. */
export type LengthUnit = "mm" | "pt";

/**
 * The page sizes `PageSetup::named` in `core/src/layout.rs` holds, portrait, in points. The ids
 * are the names the worksheet file stores.
 */
export const PAGE_SIZES: ReadonlyArray<{ id: string; width: number; height: number }> = [
  { id: "A4", width: 595.28, height: 841.89 },
  { id: "A3", width: 841.89, height: 1190.55 },
  { id: "A5", width: 419.53, height: 595.28 },
  { id: "Letter", width: 612, height: 792 },
  { id: "Legal", width: 612, height: 1008 },
];

/** The name a size the dialog does not know is stored under. */
export const CUSTOM_SIZE = "custom";

/** The dimensions of a standard size, portrait, or null when `id` is not one. */
export function namedSize(id: string): { width: number; height: number } | null {
  const size = PAGE_SIZES.find((entry) => entry.id === id);
  return size ? { width: size.width, height: size.height } : null;
}

/**
 * The size the dialog starts from: the stored name when its dimensions are exactly that size
 * in one of the two orientations, otherwise `custom` — the same rule `PageSetup::canonical_size`
 * applies in the core, so the dialog shows what the file will keep.
 */
export function sizeIdOf(page: PageSetup): string {
  if (page.size === CUSTOM_SIZE) return CUSTOM_SIZE;
  const named = namedSize(page.size);
  if (!named) return CUSTOM_SIZE;
  const matches =
    (page.width === named.width && page.height === named.height) ||
    (page.width === named.height && page.height === named.width);
  return matches ? page.size : CUSTOM_SIZE;
}

/** Landscape is the wider way round: the orientation is the order of the two dimensions. */
export function isLandscape(width: number, height: number): boolean {
  return width > height;
}

/**
 * The two dimensions in the orientation asked for. Portrait is the narrower side first, so
 * changing the orientation swaps them and nothing else.
 */
export function withOrientation(
  width: number,
  height: number,
  landscape: boolean,
): { width: number; height: number } {
  if (isLandscape(width, height) === landscape) return { width, height };
  return { width: height, height: width };
}

/** A length in points, rounded the way a worksheet stores one: 0.01 pt. */
export function roundPoints(points: number): number {
  return Math.round(points * 100) / 100 + 0;
}

/** A length in points as the dialog shows it in `unit`: two decimals, which round-trips. */
export function toUnit(points: number, unit: LengthUnit): number {
  const value = unit === "mm" ? points / PT_PER_MM : points;
  return Math.round(value * 100) / 100 + 0;
}

/** A length typed in `unit` as stored points. */
export function fromUnit(value: number, unit: LengthUnit): number {
  return roundPoints(unit === "mm" ? value * PT_PER_MM : value);
}

/** Why a setup cannot be stored, or null when it can. */
export type PageSetupProblem = "size" | "negative" | "no-room" | "line";

/**
 * The check of, the same rule as `PageSetup::validate` in the core: finite
 * lengths, a positive size, margins that leave room for content and a header and a footer that are
 * one line of text each.
 */
export function pageSetupProblem(page: PageSetup): PageSetupProblem | null {
  const { width, height, margins } = page;
  const lengths = [width, height, margins.top, margins.right, margins.bottom, margins.left];
  if (!lengths.every(Number.isFinite)) return "size";
  if (!(width > 0) || !(height > 0)) return "size";
  const sides = [margins.top, margins.right, margins.bottom, margins.left];
  if (sides.some((value) => value < 0)) return "negative";
  if (margins.left + margins.right >= width || margins.top + margins.bottom >= height) return "no-room";
  // The header and the footer are one line of text each.
  if (pageLineProblem(page.header) || pageLineProblem(page.footer)) return "line";
  return null;
}
