// Where a new region goes when it does not fit on its page.

import type { PageSetup } from "../equavelaApi";
import { flowFrame } from "./areas";

/**
 * The height a new region of each kind is drawn with when it is created, in points: a plot
 * has PlotSpec's default size, a table its three rows with the units row being edited, a
 * Julia block one empty line. Math and text start one line high and are never moved.
 */
export const NEW_REGION_HEIGHT_PT: Partial<Record<string, number>> = { plot: 220, table: 72, julia: 42 };

/**
 * The page and y of a new region `height` tall asked for at `page`, `y`: unchanged when it fits above
 * the bottom margin, otherwise the top of the next page's printable area. A region taller than the
 * printable area, or one asked for above the top margin, stays where it was asked for.
 */
export function placeOnPage(setup: PageSetup, page: number, y: number, height: number): { page: number; y: number } {
  const frame = flowFrame(setup);
  if (y + height <= frame.bottom || height > frame.step || y < frame.top) return { page, y };
  return { page: page + 1, y: frame.top };
}
