// Collapsible areas on the page. Pure functions over the
// regions of a view: who is a member, what is hidden, and the mapping between stored positions
//  and drawn positions.
//
// A band is a range of the flow of the sheet, not a rectangle of one page: it starts at its
// stored `page` and `y`, runs to the bottom margin, continues at the top margin of the next page and
// so on, so `height` may exceed the printable height of a page. Every function here that needs the
// geometry takes the page setup, because the flow frame is derived from it (`layout/lines.ts` uses
// the same frame for the page breaks).

import type { PageSetup, ViewRegion } from "../equavelaApi";

/** Height of an area's header in points. */
export const AREA_HEADER_PT = 21;
/** Smallest area height in points. */
export const MIN_AREA_PT = 24;

type AreaRegion = Extract<ViewRegion, { kind: "area" }>;
/** The stored extent of a band: the fields the flow geometry reads. */
type Band = { page: number; y: number; height: number };

const EPS = 1e-6;
/**
 * The most parts a band is split into. A file may hold any finite height, and a corrupt one must not
 * make the page view loop for ever: this is 10 000 pages, far beyond any real worksheet.
 */
const MAX_AREA_PARTS = 10_000;

export const isArea = (region: ViewRegion): region is AreaRegion => region.kind === "area";

/**
 * The frame of the flow of the sheet: a point `y` of `page` sits
 * `(page - 1) * step + (y - top)` points into it, so the top margin of a page follows the bottom
 * margin of the one before it.
 */
export type FlowFrame = { top: number; bottom: number; step: number };

export function flowFrame(setup: PageSetup): FlowFrame {
  const top = setup.margins.top;
  const bottom = setup.height - setup.margins.bottom;
  return { top, bottom, step: bottom - top };
}

/** The flow offset of a stored point, the frame of `layout/lines.ts`. */
export function flowOf(frame: FlowFrame, page: number, y: number): number {
  return (Math.max(1, Math.round(page)) - 1) * frame.step + (y - frame.top);
}

/** A part of a band inside the printable area of one page. */
export type AreaSpan = { page: number; top: number; height: number };

/** A part of a band as it is drawn: one carries the header, one the end line. */
export type AreaPart = AreaSpan & { header: boolean; end: boolean };

/**
 * The parts of the band inside the printable area of each page it reaches: the first part
 * runs from the stored `y` down to the bottom margin, every later part from the top margin to the
 * bottom margin, and the last one to the end of the band. A band that fits on its page is one part.
 */
export function areaParts(frame: FlowFrame, band: Band): AreaPart[] {
  const parts: AreaPart[] = [];
  if (!(frame.step > EPS) || !Number.isFinite(band.y) || !Number.isFinite(band.height) || band.height <= 0) {
    return parts;
  }
  let page = Math.max(1, Math.round(band.page));
  let top = band.y;
  let left = band.height;
  // One part per page and each page takes at most its printable height, so a band of any length ends.
  while (left > EPS && parts.length < MAX_AREA_PARTS) {
    const room = frame.bottom - top;
    if (room <= EPS) {
      // The band has left the printable area of this page: it continues at the top margin of the
      // next one.
      page += 1;
      top = frame.top;
      continue;
    }
    const height = Math.min(room, left);
    parts.push({ page, top, height, header: parts.length === 0, end: false });
    left -= height;
    page += 1;
    top = frame.top;
  }
  const last = parts[parts.length - 1];
  if (last) last.end = true;
  return parts;
}

/** The parts of a band, without the drawing flags. */
export const areaSpans = (frame: FlowFrame, band: Band): AreaSpan[] => areaParts(frame, band);

/** The last page the band reaches: the page its end line is on. */
export function areaLastPage(frame: FlowFrame, band: Band): number {
  const parts = areaParts(frame, band);
  return parts.length === 0 ? Math.max(1, Math.round(band.page)) : parts[parts.length - 1].page;
}

/**
 * Whether `region` is a member of `area`: its stored top lies in the part of the band on its own
 * page, below the header. The part, not the flow offset, decides: a region in the bottom
 * margin of the page a band starts on is not a member of the part the band continues with.
 */
export function isMember(area: AreaRegion, region: ViewRegion, frame: FlowFrame): boolean {
  return region.kind !== "area" && inParts(areaParts(frame, area), region);
}

/** Whether `region` lies in one of the parts, below the header. */
function inParts(parts: readonly AreaPart[], region: ViewRegion): boolean {
  return parts.some(
    (part) =>
      part.page === region.page &&
      region.y >= part.top + (part.header ? AREA_HEADER_PT : 0) - EPS &&
      region.y < part.top + part.height - EPS,
  );
}

/** The ids of the members of `area`, on every page the band covers. */
export function memberIds(regions: readonly ViewRegion[], area: AreaRegion, frame: FlowFrame): string[] {
  const parts = areaParts(frame, area);
  return regions.filter((region) => region.kind !== "area" && inParts(parts, region)).map((region) => region.id);
}

/** The regions of a page sorted by `y`, built once per call and page. */
function sortedByPage(regions: readonly ViewRegion[]): (page: number) => ViewRegion[] {
  const cache = new Map<number, ViewRegion[]>();
  return (page) => {
    const known = cache.get(page);
    if (known) return known;
    const list = regions.filter((region) => region.page === page).sort((a, b) => a.y - b.y);
    cache.set(page, list);
    return list;
  };
}

/** Index of the first entry of `sorted` (ascending `y`) whose `y` is at least `y`. */
function firstAtOrBelow(sorted: readonly ViewRegion[], y: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle].y < y) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The length of a band that disappears on one page when the area is collapsed. */
function removedLength(part: AreaPart): number {
  return part.header ? part.height - AREA_HEADER_PT : part.height;
}

/**
 * The ids that are not drawn: the members of the collapsed areas, on every page their band reaches
 *. Every part of a band cuts a contiguous run of the regions of its page sorted by `y`, so the
 * cost follows the pages a collapsed band covers.
 */
export function hiddenIds(regions: readonly ViewRegion[], setup: PageSetup): Set<string> {
  const hidden = new Set<string>();
  const areas = regions.filter((region): region is AreaRegion => region.kind === "area" && region.collapsed);
  if (areas.length === 0) return hidden;
  const frame = flowFrame(setup);
  const sorted = sortedByPage(regions);
  for (const area of areas) {
    for (const part of areaParts(frame, area)) {
      const list = sorted(part.page);
      if (list.length === 0) continue;
      const end = part.top + part.height - EPS;
      const from = part.top + (part.header ? AREA_HEADER_PT : 0) - EPS;
      for (let i = firstAtOrBelow(list, from); i < list.length && list[i].y < end; i++) {
        if (list[i].kind !== "area") hidden.add(list[i].id);
      }
    }
  }
  return hidden;
}

/**
 * `ids` plus the members of every area among them
 * , on every page the band covers.
 */
export function withMembers(regions: readonly ViewRegion[], ids: readonly string[], setup: PageSetup): string[] {
  // Nothing selected (every edit of a worksheet with no selection): nothing to carry, no pass over the
  // regions.
  if (ids.length === 0) return [];
  const out = new Set(ids);
  let frame: FlowFrame | null = null;
  for (const area of regions.filter(isArea)) {
    if (!out.has(area.id)) continue;
    frame ??= flowFrame(setup);
    for (const id of memberIds(regions, area, frame)) out.add(id);
  }
  return [...out];
}

/**
 * A length a collapsed band removes on one page: what lies at or below `bottom` on that page
 * is drawn `removed` points higher. The part that carries the header keeps it (`header`).
 */
type Cut = { top: number; bottom: number; removed: number; header: boolean };

/** The cuts of the collapsed bands of a worksheet, by the page they are removed from. */
function cutsOf(regions: readonly ViewRegion[], frame: FlowFrame): Map<number, Cut[]> {
  const byPage = new Map<number, Cut[]>();
  for (const area of regions.filter(isArea)) {
    if (!area.collapsed) continue;
    for (const part of areaParts(frame, area)) {
      const removed = removedLength(part);
      if (removed <= EPS) continue;
      const cut: Cut = { top: part.top, bottom: part.top + part.height, removed, header: part.header };
      const list = byPage.get(part.page);
      if (list) list.push(cut);
      else byPage.set(part.page, [cut]);
    }
  }
  return byPage;
}

/**
 * How much higher a region at stored `y` of `page` is drawn when areas are collapsed: the
 * lengths that disappear above it on that page. Regions on other pages do not move.
 */
export function drawnShift(regions: readonly ViewRegion[], setup: PageSetup, page: number, y: number): number {
  let shift = 0;
  for (const cut of cutsOf(regions, flowFrame(setup)).get(page) ?? []) {
    if (y >= cut.bottom - EPS) shift += cut.removed;
  }
  return shift;
}

/**
 * `drawnY` for many regions of the same worksheet: the collapsed bands are grouped by page once,
 * instead of being searched among all regions for every region
 * .
 */
export function drawnYOf(regions: readonly ViewRegion[], setup: PageSetup): (page: number, y: number) => number {
  const byPage = cutsOf(regions, flowFrame(setup));
  return (page, y) => {
    let shift = 0;
    for (const cut of byPage.get(page) ?? []) {
      if (y >= cut.bottom - EPS) shift += cut.removed;
    }
    return y - shift;
  };
}

/** The drawn y of a region at stored `y`. */
export function drawnY(regions: readonly ViewRegion[], setup: PageSetup, page: number, y: number): number {
  return y - drawnShift(regions, setup, page, y);
}

/**
 * The stored y for a point at drawn `y` of `page`: a point below the hidden part of a
 * collapsed band is shifted back by the lengths that disappear above it on that page; a point in a
 * header or above it is its own stored y.
 */
export function storedY(regions: readonly ViewRegion[], setup: PageSetup, page: number, y: number): number {
  let extra = 0;
  const frame = flowFrame(setup);
  const cuts = (cutsOf(regions, frame).get(page) ?? []).slice().sort((a, b) => a.top - b.top);
  for (const cut of cuts) {
    // The header of the band stays where it is: only what lies below it disappears on this page.
    const hiddenTop = cut.top + (cut.header ? AREA_HEADER_PT : 0) - extra;
    if (y >= hiddenTop - EPS) extra += cut.removed;
    else break;
  }
  return y + extra;
}

/** The grid step, points: the end line of a band that holds its content lies on it. */
const GRID_PT = 3;

/**
 * The height a band needs to hold its content: from its start line to one grid step
 * below the lowest bottom of its members, on the page grid, but never past `limit` (the flow offset
 * of the next area's start line). `bottoms` are the drawn bottoms of the members as flow offsets.
 * 0 when the band has no members.
 */
export function contentHeight(frame: FlowFrame, band: Band, bottoms: readonly number[], limit = Infinity): number {
  if (bottoms.length === 0) return 0;
  const start = flowOf(frame, band.page, band.y);
  const lowest = Math.max(...bottoms);
  // The grid is drawn from the top of the page, so the end line is snapped in page points.
  const end = Math.ceil((lowest + GRID_PT + frame.top) / GRID_PT - EPS) * GRID_PT - frame.top;
  return Math.max(0, Math.min(end, limit) - start);
}
