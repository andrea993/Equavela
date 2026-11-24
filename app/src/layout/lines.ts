// Inserting worksheet lines at the crosshair and the
// flow shifts of the page breaks and of Add/Remove Space:
// one line, or the space a page break frees, moves everything at or
// below a point of the flow. Pure, so the page arithmetic can be tested without a DOM.

import type { PageSetup } from "../equavelaApi";
import { AREA_HEADER_PT, MIN_AREA_PT } from "./areas";
import { GRID_PT, printableArea, snapToGrid } from "./geometry";

/**
 * Height of one inserted worksheet line, points: one line of the reference application's grid. The regions of the the reference application
 * worksheet sit at whole multiples of 14.17 pt (5 mm) and consecutive math lines touch at that pitch, so a line
 * is 15 pt on our 3 pt grid.
 */
export const WORKSHEET_LINE_PT = 15;

/** A region as the line insertion needs it: its stored place in points (`page` 1-based). */
/** A region as the line commands move it; `h`, its height in points, when it is known. */
export type LineRegion = { id: string; page: number; y: number; h?: number };

/** A new stored place of a region (page 1-based, y in points). */
export type FlowPlace = { id: string; page: number; y: number };

export type FlowShift = {
  /** The new stored places of the regions at or after the shift point (the ones above keep theirs). */
  moves: FlowPlace[];
  /** Where the shift point itself ends up: a break's caret line lands on the next page's boundary. */
  at: { page: number; y: number };
};

export type LineInsertion = {
  /** The new stored places of the regions at or below the crosshair (the regions above keep theirs). */
  moves: FlowPlace[];
  /** Where the crosshair goes: one line below the inserted one, on the next page past the break. */
  crosshair: { page: number; y: number };
};

/** An area band of the sheet: the page and the vertical span it covers. */
export type LineBand = { page: number; y: number; height: number };

/**
 * Where the line goes for a crosshair at `y` of `page`: the top of the area band the crosshair is
 * inside, else the crosshair itself. Inserting the line before the area moves the band and all its
 * members together, so a member is never pushed out of its area.
 */
export function lineInsertionPoint(bands: readonly LineBand[], page: number, y: number): { page: number; y: number } {
  const band = bands.find((b) => b.page === page && y >= b.y - EPS && y < b.y + b.height - EPS);
  return band ? { page: band.page, y: band.y } : { page, y };
}

const EPS = 1e-6;

/**
 * The flow frame of the sheet: a region at `y` of `page` sits `(page - 1) * stride + (y - origin)`
 * points into it, and a flow offset maps back to a page and a y.
 *
 * `origin` and `stride` describe the page frame the coordinates use: the printable area in the page
 * view (`margins.top` and the printable height) and the whole page in the draft view (0 and the page
 * height), where regions and the crosshair may sit in the margins.
 */
function flowFrame(setup: PageSetup, _view: "page" | "draft") {
  // Both views flow through the printable area: the margins are never filled by moving lines,
  // so what is moved past the bottom margin continues on the next page in the draft view too.
  const area = printableArea(setup);
  const origin = area.top;
  const stride = area.height;
  return {
    origin,
    stride,
    /** The flow offset of a stored place. */
    flowOf: (page: number, y: number) => (Math.max(1, Math.round(page)) - 1) * stride + (y - origin),
    /**
     * The stored place of a flow offset. The origin snaps to the 3 pt grid the regions live on
     * (rule R6) and the sheet never starts above its first page, so a shift that would leave the
     * top of the worksheet stops there.
     */
    placeOf: (offset: number) => {
      const page = Math.max(1, Math.floor(offset / stride) + 1);
      return { page, y: snapToGrid(Math.max(origin, origin + (offset - (page - 1) * stride))) };
    },
  };
}

/**
 * The effect of shifting the flow by `amount` points at `at` (a stored position).
 *
 * The regions are read as one flow; everything at or after `at` moves `amount` points along it, so
 * the distances between the regions are kept and nothing is moved on top of anything else. A region
 * that no longer fits on its page continues on the next one, and pages are added as needed; a
 * negative `amount` pulls content up across page boundaries the same way. Every new origin is
 * snapped to the 3 pt grid (rule R6), so crossing a page break can change a gap by up to 1.5 pt.
 * `at` itself moves with the flow, which is how the crosshair advances onto a new line and how the
 * break of a page lands exactly on the next page's boundary.
 */
export function shiftFlow(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  amount: number,
  view: "page" | "draft" = "page",
): FlowShift {
  const { flowOf, placeOf } = flowFrame(setup, view);
  const insertion = flowOf(at.page, at.y);
  // A zero shift moves nothing at all: a page break on the bottom margin only marks the page, and
  // snapping the regions there would quietly tidy them onto the grid.
  if (amount === 0) return { moves: [], at: { page: Math.max(1, Math.round(at.page)), y: snapToGrid(at.y) } };
  const area = printableArea(setup);
  // A region wholly in a margin is there on purpose and stays; one that only reaches into a margin
  // flows with the rest, or the content below would pass it.
  const inMargin = (region: LineRegion) =>
    region.y > area.bottom - EPS || (region.y < area.top - EPS && region.y + (region.h ?? 0) <= area.top + EPS);
  const moving = regions
    .filter((region) => !inMargin(region) && flowOf(region.page, region.y) >= insertion - EPS)
    .sort((a, b) => flowOf(a.page, a.y) - flowOf(b.page, b.y));
  const moves: FlowPlace[] = [];
  // How far the content after a region that jumped to the next page goes on with it.
  let extra = 0;
  for (const region of moving) {
    let offset = flowOf(region.page, region.y) + amount + extra;
    let place = placeOf(offset);
    // A region that would reach into the bottom margin never does, unless it is taller than a
    // page and has to start at a top anyway.
    const h = region.h ?? 0;
    if (h > 0 && h <= area.height + EPS && place.y + h > area.bottom + EPS && place.y > area.top + EPS) {
      const original = flowOf(region.page, region.y);
      if (amount >= 0) {
        // Pushed down, it continues whole on the next page, and what follows keeps its distance.
        const next = place.page * area.height;
        extra += next - offset;
        offset = next;
      } else {
        // Pulled up past the top of its page, it goes on up onto the page above, as low as it fits
        // whole (its bottom on the bottom margin), even above the crosshair: from there it is no
        // longer below the crosshair and stops. What follows it only moves by the line.
        const lowest = (place.page - 1) * area.height + Math.floor((area.bottom - h - area.top) / GRID_PT + EPS) * GRID_PT;
        if (lowest < original - EPS) {
          offset = lowest;
        } else {
          // No place above where it was: it stays, and what follows stays below it.
          extra += original - offset;
          offset = original;
        }
      }
      place = placeOf(offset);
    }
    moves.push({ id: region.id, ...place });
  }
  return { moves, at: placeOf(insertion + amount) };
}

/**
 * The effect of inserting one worksheet line at `at` (a crosshair position, points): the regions at
 * or below it move `WORKSHEET_LINE_PT` down and the crosshair follows onto the new line, on the next
 * page when the line falls past the bottom margin (GitHub ).
 */
export function insertWorksheetLine(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): LineInsertion {
  const shifted = shiftFlow(setup, regions, at, WORKSHEET_LINE_PT, view);
  return { moves: shifted.moves, crosshair: shifted.at };
}

/**
 * `count` worksheet lines inserted one after the other, as `count` presses of Enter: each line goes
 * where the crosshair moved to after the previous one. One set of moves, the final places.
 */
export function insertWorksheetLines(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  count: number,
  view: "page" | "draft" = "page",
): LineInsertion {
  return repeatInsertion(regions, at, count, (current, point) => insertWorksheetLine(setup, current, point, view));
}

/** Applies `step` `count` times, each on the places the previous step left, and merges the moves. */
function repeatInsertion(
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  count: number,
  step: (regions: readonly LineRegion[], at: { page: number; y: number }) => LineInsertion,
): LineInsertion {
  let current = regions;
  let point = at;
  const moved = new Map<string, FlowPlace>();
  for (let i = 0; i < Math.max(1, count); i++) {
    const insertion = step(current, point);
    for (const move of insertion.moves) moved.set(move.id, move);
    current = current.map((region) => moved.get(region.id) ?? region);
    point = insertion.crosshair;
  }
  return { moves: [...moved.values()], crosshair: point };
}

/**
 * The blank space below `at`, in points: the distance along the flow to the nearest region at or
 * after it, or `null` when there is nothing below
 * . Never negative.
 */
export function blankSpaceBelow(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): number | null {
  const { flowOf } = flowFrame(setup, view);
  const insertion = flowOf(at.page, at.y);
  let blank = Infinity;
  for (const region of regions) {
    const flow = flowOf(region.page, region.y);
    if (flow < insertion - EPS) continue;
    blank = Math.min(blank, flow - insertion);
  }
  return blank === Infinity ? null : Math.max(0, blank);
}

/**
 * The effect of removing one worksheet line of space at `at`: the content at
 * or after the point moves up by one line, and by less when there is less blank space below it, so
 * nothing ends up above the point or on top of what is above it. Nothing moves — and no undo step is
 * made — when the content already touches the point or when there is nothing below.
 */
export function removeWorksheetLine(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): FlowShift {
  const blank = blankSpaceBelow(setup, regions, at, view);
  const amount = Math.min(WORKSHEET_LINE_PT, blank ?? 0);
  if (amount <= 0) return { moves: [], at };
  return shiftFlow(setup, regions, at, -amount, view);
}

/** A region as the space above the crosshair needs it: its stored place and its height, points. */
export type SizedLineRegion = LineRegion & { h: number };

/**
 * The blank space above `at`, in points: the distance along the flow from the
 * lowest bottom edge of the regions that start above it, or from the top of the sheet when none does.
 * Never negative: a region that reaches down to the line, or past it, leaves no space.
 */
export function blankSpaceAbove(
  setup: PageSetup,
  regions: readonly SizedLineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): number {
  const { flowOf } = flowFrame(setup, view);
  const insertion = flowOf(at.page, at.y);
  let bottom = 0;
  for (const region of regions) {
    const flow = flowOf(region.page, region.y);
    if (flow >= insertion - EPS) continue;
    bottom = Math.max(bottom, flow + region.h);
  }
  return Math.max(0, insertion - bottom);
}

/**
 * The effect of Backspace on empty worksheet space: one line of the blank
 * space above `at` goes away, as Backspace on an empty line of a text editor. The point and everything
 * at or after it move up by one line, and by less when there is less blank space above, so nothing
 * ends up on what is above it. `at` is where the crosshair goes; it equals the input when there is no
 * blank space above.
 */
export function removeWorksheetLineAbove(
  setup: PageSetup,
  regions: readonly SizedLineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): FlowShift {
  const amount = Math.min(WORKSHEET_LINE_PT, blankSpaceAbove(setup, regions, at, view));
  if (amount <= 0) return { moves: [], at };
  return shiftFlow(setup, regions, at, -amount, view);
}

// ---- lines inside an area ---------------------------------------

/** An area as the line commands need it: its start in the flow and its band height, points. */
export type LineArea = { id: string; page: number; y: number; height: number };

/** The new band height of an area, which travels with the moves in one undo step. */
export type AreaChange = { id: string; height: number };

/** A flow shift that also resizes the band of the area the point is in. */
export type AreaFlowShift = FlowShift & { area: AreaChange | null };

/**
 * The area whose body holds `at` (a stored position): below its header and above its end line. A
 * point on the header or outside every band is not inside an area, and a line there goes before the
 * area (`lineInsertionPoint`).
 */
export function areaBodyAt(
  setup: PageSetup,
  areas: readonly LineArea[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): LineArea | null {
  const { flowOf } = flowFrame(setup, view);
  const point = flowOf(at.page, at.y);
  return (
    areas.find((area) => {
      const start = flowOf(area.page, area.y);
      return point >= start + AREA_HEADER_PT - EPS && point < start + area.height - EPS;
    }) ?? null
  );
}

/** Whole grid steps: a band height is one, so a line removed in an area is rounded down to it. */
const wholeSteps = (amount: number): number => Math.floor(amount / GRID_PT + EPS) * GRID_PT;

/**
 * A worksheet line inserted inside the body of `area`: the content at or below the point moves one
 * line down, as anywhere else, and the band grows by the same line so its members stay inside it
 *. The crosshair follows onto the new line.
 */
export function insertWorksheetLineInArea(
  setup: PageSetup,
  regions: readonly LineRegion[],
  area: LineArea,
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
  count = 1,
): LineInsertion & { area: AreaChange } {
  const lines = Math.max(1, count);
  const insertion = repeatInsertion(regions, at, lines, (current, point) => {
    const shifted = shiftFlow(setup, current, point, WORKSHEET_LINE_PT, view);
    return { moves: shifted.moves, crosshair: shifted.at };
  });
  return { ...insertion, area: { id: area.id, height: area.height + lines * WORKSHEET_LINE_PT } };
}

/**
 * Remove Space inside the body of `area`: the content after the point moves up by one line and
 * the band gets shorter by the same amount. The amount is less when the blank space below the point
 * is less, when the end line is nearer, or when the band would go under its minimum height.
 */
export function removeWorksheetLineInArea(
  setup: PageSetup,
  regions: readonly LineRegion[],
  area: LineArea,
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): AreaFlowShift {
  const { flowOf } = flowFrame(setup, view);
  const room = flowOf(area.page, area.y) + area.height - flowOf(at.page, at.y);
  const blank = blankSpaceBelow(setup, regions, at, view) ?? Infinity;
  const amount = wholeSteps(Math.min(WORKSHEET_LINE_PT, blank, room, area.height - MIN_AREA_PT));
  if (amount <= 0) return { moves: [], at, area: null };
  const shifted = shiftFlow(setup, regions, at, -amount, view);
  return { moves: shifted.moves, at: shifted.at, area: { id: area.id, height: area.height - amount } };
}

/**
 * Backspace on empty space inside the body of `area`: one line of the blank space above the
 * point goes away. The header stands for the area itself, and the members above the point count by
 * their own height, so the band is not a wall; the band gets shorter by the same amount.
 */
export function removeWorksheetLineAboveInArea(
  setup: PageSetup,
  regions: readonly SizedLineRegion[],
  area: LineArea,
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): AreaFlowShift {
  const others = regions.filter((region) => region.id !== area.id);
  const header = { id: area.id, page: area.page, y: area.y, h: AREA_HEADER_PT };
  const blank = blankSpaceAbove(setup, [...others, header], at, view);
  const amount = wholeSteps(Math.min(WORKSHEET_LINE_PT, blank, area.height - MIN_AREA_PT));
  if (amount <= 0) return { moves: [], at, area: null };
  const shifted = shiftFlow(setup, regions, at, -amount, view);
  return { moves: shifted.moves, at: shifted.at, area: { id: area.id, height: area.height - amount } };
}

/**
 * The space a page break at `at` makes free: from the caret line to the end
 * of the page, `printable bottom - y` in the page view and `page height - y` in the draft view. Never
 * negative, so a break on the bottom margin only marks the page.
 */
export function pageBreakGap(setup: PageSetup, at: { page: number; y: number }, view: "page" | "draft" = "page"): number {
  const area = printableArea(setup);
  const bottom = view === "page" ? area.bottom : setup.height;
  return Math.max(0, bottom - snapToGrid(at.y));
}

/**
 * The effect of adding a page break at `at`: the content at or after the caret line continues on the
 * next page, its distances kept. The break makes the rest of the page blank, so the flow moves
 * down by exactly that space.
 */
export function addPageBreakShift(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): FlowShift {
  return shiftFlow(setup, regions, at, pageBreakGap(setup, at, view), view);
}

/**
 * The effect of removing the page break stored at `at`: the content at or after it moves back up by
 * the space the break had made free, which is the inverse of {@link addPageBreakShift}.
 */
export function removePageBreakShift(
  setup: PageSetup,
  regions: readonly LineRegion[],
  at: { page: number; y: number },
  view: "page" | "draft" = "page",
): FlowShift {
  return shiftFlow(setup, regions, at, -pageBreakGap(setup, at, view), view);
}

/**
 * The page break a key on the sheet removes, or `null`: **Delete** with the
 * crosshair directly above a break — on the page the break ends, at or below its line — and
 * **Backspace** with the crosshair directly below one — on the first worksheet line of the page after
 * a page that ends with a break.
 */
export function pageBreakAtKey(
  setup: PageSetup,
  breaks: readonly { page: number; y: number }[],
  at: { page: number; y: number },
  key: "Delete" | "Backspace",
  view: "page" | "draft" = "page",
): { page: number; y: number } | null {
  const found =
    key === "Delete"
      ? breaks.find((entry) => entry.page === at.page && at.y >= entry.y - EPS)
      : at.y < flowFrame(setup, view).origin + WORKSHEET_LINE_PT - EPS
        ? breaks.find((entry) => entry.page === at.page - 1)
        : undefined;
  return found ? { page: found.page, y: found.y } : null;
}
