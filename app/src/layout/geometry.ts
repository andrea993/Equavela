// Page geometry in points and the rules that keep the screen identical to the
// PDF. Everything here is pure so it can be tested
// without a DOM.

import type { PageSetup } from "../equavelaApi";

/** CSS pixels per point (96 dpi / 72 pt per inch). */
export const PX_PER_PT = 4 / 3;

/** Region origins sit on a 3 pt grid = 4 CSS px (R6). */
export const GRID_PT = 3;

/** Region sizes are multiples of 0.75 pt = 1 CSS px (R6). */
export const SIZE_STEP_PT = 0.75;

/** Gap between two pages in the page view, in CSS px (whole pixels, R8). */
export const PAGE_GAP_PX = 24;

/** Distance between the sheet and the edges of the scroll area, in CSS px. */
export const EQUAVELA_PADDING_PX = 24;

export const ptToPx = (pt: number): number => pt * PX_PER_PT;
export const pxToPt = (px: number): number => px / PX_PER_PT;

/** Snaps a coordinate to the 3 pt grid. */
export function snapToGrid(value: number, grid: number = GRID_PT): number {
  // Avoid -0 and tiny floating point residue.
  return Math.round(value / grid) * grid + 0;
}

/** Rounds a measured size up to a multiple of 0.75 pt (R6). */
export function ceilSize(pt: number): number {
  return Math.ceil(pt / SIZE_STEP_PT - 1e-9) * SIZE_STEP_PT + 0;
}

/**
 * Size in points of an element measured in layout CSS px. `offsetWidth` and
 * `offsetHeight` are layout values and independent of the zoom transform and of the
 * device pixel ratio (R9); a `getBoundingClientRect()` value must be divided by the zoom
 * first.
 */
export function measuredPt(layoutPx: number, zoom = 1): number {
  return ceilSize(pxToPt(layoutPx / zoom));
}

/**
 * A region's size in points. `rise` is the part of a math region's box above its first line (a tall
 * result, a fraction, a matrix), drawn above the stored y
 * .
 */
export type Size = { w: number; h: number; rise?: number };

// ---- page stack -------------------------------------------------------------------------

export type PageRect = {
  /** 1-based page number. */
  page: number;
  /** Top-left corner in the sheet, CSS px (unzoomed). */
  top: number;
  left: number;
  width: number;
  height: number;
};

export type SheetLayout = {
  pages: PageRect[];
  /** Total size of the sheet in CSS px (unzoomed). */
  width: number;
  height: number;
};

/** Number of pages needed for the regions (at least one, at least `minimum`). */
export function pageCount(regions: { page: number }[], minimum = 1): number {
  // A loop, not `Math.max(...)` over the regions: spreading 20 000 arguments is slow.
  let pages = Math.max(minimum, 1);
  for (const region of regions) if (region.page > pages) pages = region.page;
  return pages;
}

/**
 * Page rectangles of the sheet. In the page view pages are stacked with a gap; in the
 * draft view (`draft`) they follow each other without a gap or frame.
 */
export function sheetLayout(
  setup: PageSetup,
  pages: number,
  draft = false,
): SheetLayout {
  const width = Math.round(ptToPx(setup.width));
  const height = Math.round(ptToPx(setup.height));
  const gap = draft ? 0 : PAGE_GAP_PX;
  const rects: PageRect[] = [];
  for (let i = 0; i < pages; i++) {
    rects.push({ page: i + 1, top: i * (height + gap), left: 0, width, height });
  }
  return {
    pages: rects,
    width,
    height: pages * height + Math.max(0, pages - 1) * gap,
  };
}

/** Position of a page point in sheet CSS px. Origins are snapped to the grid first. */
export function pageToSheet(
  layout: SheetLayout,
  page: number,
  xPt: number,
  yPt: number,
): { x: number; y: number } {
  const rect = layout.pages[Math.min(Math.max(page, 1), layout.pages.length) - 1];
  return {
    x: rect.left + ptToPx(snapToGrid(xPt)),
    y: rect.top + ptToPx(snapToGrid(yPt)),
  };
}

/**
 * The page and the position in points under a sheet point (CSS px, unzoomed). A point in
 * a gap belongs to the nearer page; the position is not clamped.
 */
export function sheetToPage(
  layout: SheetLayout,
  xPx: number,
  yPx: number,
): { page: number; x: number; y: number } {
  let best = layout.pages[0];
  let bestDistance = Infinity;
  for (const rect of layout.pages) {
    const distance =
      yPx < rect.top ? rect.top - yPx : yPx > rect.top + rect.height ? yPx - rect.top - rect.height : 0;
    if (distance < bestDistance) {
      best = rect;
      bestDistance = distance;
    }
  }
  return {
    page: best.page,
    x: pxToPt(xPx - best.left),
    y: pxToPt(yPx - best.top),
  };
}

/** Map a continuous draft point to page-relative coordinates, including blank pages. */
export function sheetToDraftPage(layout: SheetLayout, xPx: number, yPx: number): Placement {
  const height = layout.pages[0].height;
  const y = Math.max(0, yPx);
  let page = Math.floor(y / height) + 1;
  let localY = snapToGrid(pxToPt(y - (page - 1) * height));
  if (ptToPx(localY) >= height) {
    page += 1;
    localY = 0;
  }
  return { page, x: Math.max(0, snapToGrid(pxToPt(xPx))), y: localY };
}

// ---- page break rule --------------------------------------------------------------------

/** The printable area of a page in points. */
export function printableArea(setup: PageSetup) {
  const { margins } = setup;
  return {
    left: margins.left,
    top: margins.top,
    right: setup.width - margins.right,
    bottom: setup.height - margins.bottom,
    width: setup.width - margins.left - margins.right,
    height: setup.height - margins.top - margins.bottom,
  };
}

/** Whether a region at `y` with height `h` reaches below the bottom margin. */
export function crossesPageBreak(setup: PageSetup, y: number, h: number): boolean {
  return snapToGrid(y) + h > printableArea(setup).bottom + 1e-6;
}

/**
 * The last page a region reaches when the print view cuts it at the bottom edge of the pages
 * : a region at `y` of `page` with height `h` that ends below the page edge continues
 * at the top of the next page, and so on. Equal to `page` for a region that ends on its page.
 */
export function lastPageReached(setup: PageSetup, page: number, y: number, h: number): number {
  const bottom = snapToGrid(y) + h;
  if (bottom <= setup.height + 1e-6) return page;
  return page + Math.ceil((bottom - setup.height) / setup.height - 1e-6);
}

export type Placement = { page: number; x: number; y: number };

/**
 * Where a dropped region ends up: the origin snaps to the
 * grid and stays inside the printable area; a region that would straddle the bottom
 * margin is pushed to the top of the next page. A region taller than the printable area
 * cannot be pushed anywhere useful and stays where it is (it is flagged instead).
 */
export function placeRegion(
  setup: PageSetup,
  page: number,
  x: number,
  y: number,
  size: Size,
): Placement {
  const area = printableArea(setup);
  const maxX = Math.max(area.left, area.right - size.w);
  let nx = Math.min(Math.max(snapToGrid(x), area.left), snapToGrid(maxX));
  nx = Math.max(nx, area.left);
  let ny = Math.max(snapToGrid(y), area.top);
  let np = Math.max(1, Math.round(page));
  if (ny + size.h > area.bottom + 1e-6 && size.h <= area.height + 1e-6) {
    np += 1;
    ny = area.top;
  }
  return { page: np, x: nx, y: ny };
}

// ---- image resize ---------------------------------------------------------------------

/** Smallest image side, points. */
export const MIN_IMAGE_PT = 12;

/**
 * The size of an image during a resize drag: `dx`, `dy` are the pointer movement in points
 * since the press. With `keepRatio` the aspect ratio of the start is kept and the axis the pointer
 * moved further (relative to the size) decides; sizes snap to 0.75 pt (one CSS px), stay at least
 * 12 pt and within `maxWidth` and `maxHeight`.
 */
export function resizeImage(
  start: Size,
  dx: number,
  dy: number,
  keepRatio: boolean,
  maxWidth: number,
  maxHeight: number,
): Size {
  const snap = (value: number) => Math.round(value / SIZE_STEP_PT) * SIZE_STEP_PT + 0;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
  if (!keepRatio) {
    return { w: clamp(snap(start.w + dx), MIN_IMAGE_PT, maxWidth), h: clamp(snap(start.h + dy), MIN_IMAGE_PT, maxHeight) };
  }
  const ratio = start.h / start.w;
  const byWidth = (start.w + dx) / start.w;
  const byHeight = (start.h + dy) / start.h;
  const scale = Math.abs(byWidth - 1) >= Math.abs(byHeight - 1) ? byWidth : byHeight;
  const minWidth = Math.max(MIN_IMAGE_PT, MIN_IMAGE_PT / ratio);
  const w = clamp(snap(start.w * scale), minWidth, Math.min(maxWidth, maxHeight / ratio));
  return { w, h: Math.max(MIN_IMAGE_PT, snap(w * ratio)) };
}

// ---- zoom -------------------------------------------------------------------------------

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
}

/** The next preset above (`direction` 1) or below (-1) the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > zoom + 1e-6) ?? ZOOM_MAX;
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-6) ?? ZOOM_MIN;
}

/** Zoom that makes the page fit the width of an area (CSS px). */
export function fitWidthZoom(areaWidth: number, sheetWidth: number): number {
  return clampZoom((areaWidth - 2 * EQUAVELA_PADDING_PX) / sheetWidth);
}

/** Fit both dimensions of one physical page inside the viewport, with room around its edges. */
export function fitPageZoom(areaWidth: number, areaHeight: number, pageWidth: number, pageHeight: number): number {
  const padding = 2 * EQUAVELA_PADDING_PX;
  const fit = Math.min((areaWidth - padding) / pageWidth, (areaHeight - padding) / pageHeight);
  return clampZoom(Math.floor(fit * 100) / 100);
}

/** The left offset of the sheet in its scroll area: an integer, so the page origin sits on a whole CSS px (R8). */
export function sheetLeft(areaWidth: number, sheetWidth: number, zoom: number): number {
  return Math.max(EQUAVELA_PADDING_PX, Math.floor((areaWidth - sheetWidth * zoom) / 2));
}

// ---- page indicator -----------------------------------------------------------------------

/**
 * The page shown at the middle of the viewport: `scrollTop` and `viewportHeight` in CSS
 * px of the scroll area, `sheetTop` the offset of the sheet inside it.
 */
export function currentPage(
  layout: SheetLayout,
  zoom: number,
  scrollTop: number,
  viewportHeight: number,
  sheetTop = EQUAVELA_PADDING_PX,
): number {
  const middle = (scrollTop + viewportHeight / 2 - sheetTop) / zoom;
  for (const rect of layout.pages) {
    if (middle < rect.top + rect.height + PAGE_GAP_PX / 2) return rect.page;
  }
  return layout.pages.length;
}

// ---- reflow -----------------------------------------------------------------------------

/**
 * A region with its stored position and measured size, all in points. `rise` (default 0) is how far
 * its box starts above the stored `y` (a math region's content rising over its first line).
 */
export type FlowItem = { id: string; page: number; x: number; y: number; w: number; h: number; rise?: number };

/** A drawn region rectangle in points (page, position and measured size; `rise` as in `FlowItem`). */
export type FlowRect = { id?: string; page: number; x: number; y: number; w: number; h: number; rise?: number };

/**
 * Where a region is drawn after reflow: `y` is the top of its box (the stored `y` minus its rise when
 * nothing pushed it). `pushed` is true when it moved from its stored place.
 */
export type Flowed = { page: number; y: number; pushed: boolean };

const EPS = 1e-6;

/**
 * Reflow. Stored positions are the author's intent and are never
 * rewritten by a size change; the drawn position is derived from them and the measured sizes, so
 * a region that shrinks lets the regions below it return to where they were stored.
 *
 * Regions are visited in reading order (stored page, y, x, then list order). A region is pushed
 * down to the bottom edge (rounded up to the 3 pt grid) of every region already placed that
 * overlaps it in both x and y, repeatedly until nothing overlaps it. No region is ever drawn
 * over an earlier one, and regions that do not collide never move (so a growing region moves only
 * what it would otherwise cover, and everything that is not below it stays).
 *
 * Page breaks: a region that had to be pushed and would then reach below the bottom margin moves
 * to the top of the next page (the page is added when needed). A region that was not pushed keeps
 * its stored place even when it straddles the break (it is flagged, as before); a region taller
 * than the printable height is never moved to another page.
 */
export function reflow(setup: PageSetup, items: FlowItem[]): Map<string, Flowed> {
  const area = printableArea(setup);
  const order = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        a.item.page - b.item.page ||
        a.item.y - b.item.y ||
        a.item.x - b.item.x ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
  // The rectangles already placed, per page: a region can only collide with regions on its own page, so
  // it is compared with those only.
  const placed = new Map<number, { x0: number; x1: number; y0: number; y1: number }[]>();
  const result = new Map<string, Flowed>();
  /** Where `item`'s box lands from `start` down: below what it would cover, on the next page when pushed past the margin. */
  const land = (item: FlowItem, start: number): { page: number; y: number } => {
    const x0 = snapToGrid(item.x);
    const x1 = x0 + item.w;
    let page = Math.max(1, Math.round(item.page));
    let y = start;
    for (let guard = 0; guard < 10_000 && item.w > 0 && item.h > 0; guard++) {
      let bottom = -Infinity;
      for (const other of placed.get(page) ?? []) {
        if (
          other.x0 < x1 - EPS &&
          x0 < other.x1 - EPS &&
          other.y0 < y + item.h - EPS &&
          y < other.y1 - EPS
        ) {
          bottom = Math.max(bottom, other.y1);
        }
      }
      if (bottom === -Infinity) {
        if (page !== item.page && y + item.h > area.bottom + EPS && item.h <= area.height + EPS && y > area.top + EPS) {
          // Pushed onto a fresh page and still too low: continue on the next one.
          page += 1;
          y = area.top;
          continue;
        }
        break;
      }
      y = snapToGrid(Math.ceil(bottom / GRID_PT - EPS) * GRID_PT);
      if (y + item.h > area.bottom + EPS && item.h <= area.height + EPS) {
        page += 1;
        y = area.top;
      }
    }
    return { page, y };
  };
  // The top of a box with its line at the stored y: a rising result is drawn above the stored y, but
  // not above the top margin.
  const top = (item: FlowItem, anchor: number) => Math.max(anchor - (item.rise ?? 0), Math.min(anchor, area.top));
  for (let i = 0; i < order.length; ) {
    // The regions stored on one line of one page are one row: a push moves the whole row, so their
    // lines stay aligned.
    let end = i + 1;
    while (end < order.length && order[end].page === order[i].page && snapToGrid(order[end].y) === snapToGrid(order[i].y)) end++;
    const row = order.slice(i, end);
    const anchor = snapToGrid(order[i].y);
    let delta = 0;
    for (let round = 0; round < 10; round++) {
      let next = delta;
      for (const item of row) {
        if (item.w <= 0 || item.h <= 0) continue;
        const own = top(item, anchor);
        const landed = land(item, own + delta);
        // A row that a push carries onto another page is placed one region at a time.
        if (landed.page !== Math.max(1, Math.round(item.page))) continue;
        next = Math.max(next, landed.y - own);
      }
      if (next <= delta + EPS) break;
      delta = next;
    }
    for (const item of row) {
      const own = top(item, anchor);
      const { page, y } = land(item, own + delta);
      const x0 = snapToGrid(item.x);
      const rect = { x0, x1: x0 + item.w, y0: y, y1: y + item.h };
      const onPage = placed.get(page);
      if (onPage) onPage.push(rect);
      else placed.set(page, [rect]);
      result.set(item.id, { page, y, pushed: page !== item.page || y !== own });
    }
    i = end;
  }
  return result;
}

/**
 * A free spot for pasted regions: the paste point moves down below the regions it would land
 * on until a nominal one-line box fits (paste does not know the size of what it inserts; the
 * reflow keeps whatever overlap remains from covering anything).
 */
export function freeSpot(
  setup: PageSetup,
  rects: readonly FlowRect[],
  page: number,
  x: number,
  y: number,
  nominal: Size = { w: 36, h: 18 },
): Placement {
  const area = printableArea(setup);
  let p = page;
  let py = snapToGrid(y);
  for (let guard = 0; guard < 10_000; guard++) {
    let bottom = -Infinity;
    for (const r of rects) {
      if (
        r.page === p &&
        r.x < x + nominal.w - EPS &&
        x < r.x + r.w - EPS &&
        r.y < py + nominal.h - EPS &&
        py < r.y + r.h - EPS
      ) {
        bottom = Math.max(bottom, r.y + r.h);
      }
    }
    if (bottom === -Infinity) break;
    py = snapToGrid(Math.ceil(bottom / GRID_PT - EPS) * GRID_PT);
    if (py + nominal.h > area.bottom + EPS) {
      p += 1;
      py = area.top;
    }
  }
  return { page: p, x: snapToGrid(x), y: py };
}

/**
 * The least room, in points, a growing text box has before it wraps
 * : the right margin when it is further away, this otherwise — outside the paper in the draft
 * view the space to the right margin is negative. The average of the two widths a new box used to
 * take, 487.28 pt on A4 from the left margin and 12 pt outside the paper (GitHub ).
 */
export const NEW_TEXT_BOX_WIDTH_PT = 249;

/** The content of a scrolling result box and the thickness of its scroll bars, points. */
export type BoxContent = { w: number; h: number; vbar: number; hbar: number };

/**
 * The size of a result box clamped to its content: an axis that would show all of the
 * content stops there, with room for the scroll bar of the other axis while that one scrolls.
 */
export function fitResultBox(size: { w: number; h: number }, content: BoxContent): { w: number; h: number } {
  const scrollsHorizontally = size.w < content.w + (size.h < content.h ? content.vbar : 0);
  const scrollsVertically = size.h < content.h + (scrollsHorizontally ? content.hbar : 0);
  return {
    w: Math.min(size.w, content.w + (scrollsVertically ? content.vbar : 0)),
    h: Math.min(size.h, content.h + (scrollsHorizontally ? content.hbar : 0)),
  };
}
