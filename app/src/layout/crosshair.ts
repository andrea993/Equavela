// The crosshair (red cursor) on the page, moved with the arrow keys when nothing is edited:
// stepping, clamping to the printable area, page breaks, entering regions and the place just
// outside a region that was left with an arrow.

import { GRID_PT, snapToGrid, type FlowRect } from "./geometry";
import { WORKSHEET_LINE_PT } from "./lines";

export type CrosshairPoint = { page: number; x: number; y: number };
export type Direction = "left" | "right" | "up" | "down";

/** The printable area the crosshair lives in (points, per page). */
export type PageBox = { width: number; height: number; margins: { top: number; right: number; bottom: number; left: number } };

/** One arrow press: one grid step (3 pt, the grid the regions snap to). */
export const CROSSHAIR_STEP_PT = GRID_PT;

/**
 * How far above the crosshair point a math line typed there starts: the
 * vertical bar of the crosshair is the text cursor, so the line's insertion bar (2 pt below the top
 * of the line, 12.6 pt tall) covers the bar (12.75 pt centred on the point), within the 3 pt grid.
 */
export const LINE_ABOVE_CROSSHAIR_PT = 9;

/**
 * Acceleration while an arrow key is held. The first press stays
 * one grid step, so a quick tap is precise; each pair of key-repeat events adds one step, up to
 * `CROSSHAIR_MAX_REPEAT_STEPS`, so a sustained hold travels farther and faster without running away.
 */
export const CROSSHAIR_REPEAT_PER_STEP = 2;
export const CROSSHAIR_MAX_REPEAT_STEPS = 8;

/** Grid steps for the `repeats`-th key-repeat event of one hold (0 is the initial press). */
export function crosshairRepeatSteps(repeats: number): number {
  return Math.min(CROSSHAIR_MAX_REPEAT_STEPS, 1 + Math.floor(Math.max(0, repeats) / CROSSHAIR_REPEAT_PER_STEP));
}

/** Move freely on the continuous draft surface, retaining page-relative coordinates. */
export function moveDraftCrosshair(box: PageBox, from: CrosshairPoint, dir: Direction, steps = 1): CrosshairPoint {
  const step = CROSSHAIR_STEP_PT * steps;
  const x = Math.max(0, from.x + (dir === "right" ? step : dir === "left" ? -step : 0));
  const absoluteY = Math.max(0, (from.page - 1) * box.height + from.y + (dir === "down" ? step : dir === "up" ? -step : 0));
  const page = Math.floor(absoluteY / box.height) + 1;
  return { page, x: snapToGrid(x), y: absoluteY - (page - 1) * box.height };
}

/**
 * The crosshair after one arrow press of `steps` grid steps. It stays inside the printable area; Down
 * past the bottom margin continues at the top of the next page, including past the last page with
 * content. Up past the top continues at the bottom of the previous page and stops on page one.
 */
export function moveCrosshair(box: PageBox, from: CrosshairPoint, dir: Direction, steps = 1): CrosshairPoint {
  const step = CROSSHAIR_STEP_PT * steps;
  const { margins } = box;
  const left = margins.left;
  const right = box.width - margins.right;
  const top = margins.top;
  const bottom = box.height - margins.bottom;
  let { page, x, y } = from;
  switch (dir) {
    case "left":
      x = Math.max(left, x - step);
      break;
    case "right":
      x = Math.min(right, x + step);
      break;
    case "up":
      y -= step;
      if (y < top) {
        if (page > 1) {
          page -= 1;
          y = bottom;
        } else {
          y = top;
        }
      }
      break;
    case "down":
      y += step;
      if (y > bottom) {
        page += 1;
        y = top;
      }
      break;
  }
  return { page, x: snapToGrid(x), y: snapToGrid(y) };
}

/** The id of the region drawn under the crosshair, if any (the topmost of the list wins). */
export function regionAt(rects: readonly FlowRect[], point: CrosshairPoint): string | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (r.id && r.page === point.page && point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) {
      return r.id;
    }
  }
  return null;
}

/**
 * Where the crosshair goes when a region is left with an arrow: outside the region on that
 * side, where typing starts a line next to it. Left and right keep the region's first line (below its
 * `rise`), one grid step from its edge; up and down put the next line one grid step above or below its
 * box. Page view keeps the point inside the printable area; draft view continues on the next page.
 */
export function crosshairBeside(
  box: PageBox,
  rect: { page: number; x: number; y: number; w: number; h: number; rise?: number },
  dir: Direction,
  view: "page" | "draft" = "page",
): CrosshairPoint {
  const { margins } = box;
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
  let x = rect.x;
  let y = rect.y + (rect.rise ?? 0) + LINE_ABOVE_CROSSHAIR_PT;
  if (dir === "left") x = rect.x - CROSSHAIR_STEP_PT;
  if (dir === "right") x = rect.x + rect.w + CROSSHAIR_STEP_PT;
  if (dir === "up") y = rect.y - CROSSHAIR_STEP_PT - (WORKSHEET_LINE_PT - LINE_ABOVE_CROSSHAIR_PT);
  if (dir === "down") y = rect.y + rect.h + CROSSHAIR_STEP_PT + LINE_ABOVE_CROSSHAIR_PT;
  if (view === "draft") {
    const absoluteY = Math.max(0, (rect.page - 1) * box.height + y);
    const page = Math.floor(absoluteY / box.height) + 1;
    return { page, x: snapToGrid(Math.max(0, x)), y: absoluteY - (page - 1) * box.height };
  }
  return {
    page: rect.page,
    x: snapToGrid(clamp(x, margins.left, box.width - margins.right)),
    y: snapToGrid(clamp(y, margins.top, box.height - margins.bottom)),
  };
}
