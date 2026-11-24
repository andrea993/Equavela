import { describe, expect, it } from "vitest";
import type { PageSetup } from "../equavelaApi";
import {
  areaBodyAt,
  insertWorksheetLine,
  insertWorksheetLines,
  insertWorksheetLineInArea,
  lineInsertionPoint,
  removeWorksheetLineAboveInArea,
  removeWorksheetLineInArea,
  WORKSHEET_LINE_PT,
  type LineArea,
  type LineRegion,
} from "./lines";

// A4 with the reference application's default margins: printable y from 72 to 769.89, so the flow of a page is 697.89 pt.
const setup: PageSetup = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
};
const at = (id: string, page: number, y: number): LineRegion => ({ id, page, y });
const moved = (result: ReturnType<typeof insertWorksheetLine>, id: string) =>
  result.moves.find((move) => move.id === id);

describe("inserting several worksheet lines at once (a held Enter)", () => {
  it("gives the same places as as many single Enters, across a page break too", () => {
    const regions = [at("a", 1, 600), at("b", 1, 740), at("c", 1, 768), at("d", 2, 72)];
    for (const count of [1, 3, 12, 40]) {
      let current: LineRegion[] = regions;
      let point = { page: 1, y: 120 };
      for (let i = 0; i < count; i++) {
        const one = insertWorksheetLine(setup, current, point);
        current = current.map((region) => one.moves.find((move) => move.id === region.id) ?? region);
        point = one.crosshair;
      }
      const many = insertWorksheetLines(setup, regions, { page: 1, y: 120 }, count);
      const after = regions.map((region) => many.moves.find((move) => move.id === region.id) ?? region);
      expect(after).toEqual(current);
      expect(many.crosshair).toEqual(point);
    }
  });
});

describe("inserting a worksheet line at the crosshair", () => {
  it("moves the regions at or below the crosshair down one line and leaves the ones above", () => {
    const result = insertWorksheetLine(setup, [at("above", 1, 72), at("on", 1, 120), at("below", 1, 300)], {
      page: 1,
      y: 120,
    });
    expect(moved(result, "above")).toBeUndefined();
    expect(moved(result, "on")).toEqual({ id: "on", page: 1, y: 120 + WORKSHEET_LINE_PT });
    expect(moved(result, "below")).toEqual({ id: "below", page: 1, y: 300 + WORKSHEET_LINE_PT });
    // The crosshair moves onto the new line, on the same page.
    expect(result.crosshair).toEqual({ page: 1, y: 120 + WORKSHEET_LINE_PT });
  });

  it("keeps the distances between the regions when one of them continues on the next page", () => {
    // Two regions on the last lines of page 1, 12 pt apart: a wider gap no longer fits inside the
    // bottom margin (769.89 pt) once one 15 pt line pushes both of them across it.
    const result = insertWorksheetLine(setup, [at("first", 1, 756), at("second", 1, 768)], { page: 1, y: 72 });
    // Both leave the bottom of page 1 together: the gap between them survives the page break.
    expect(moved(result, "first")?.page).toBe(2);
    expect(moved(result, "second")?.page).toBe(2);
    const first = moved(result, "first")!.y;
    const second = moved(result, "second")!.y;
    // The origins snap to the 3 pt grid, so the 12 pt gap may move by up to 1.5 pt per origin.
    expect(first).toBeCloseTo(72, 0);
    expect(Math.abs(second - first - 12)).toBeLessThanOrEqual(3);
    expect(second).toBeGreaterThan(first);
  });

  it("moves content of later pages too, so nothing is left behind above the new line", () => {
    const result = insertWorksheetLine(setup, [at("page2", 2, 72), at("page3", 3, 72)], { page: 1, y: 600 });
    expect(moved(result, "page2")).toEqual({ id: "page2", page: 2, y: 72 + WORKSHEET_LINE_PT });
    expect(moved(result, "page3")).toEqual({ id: "page3", page: 3, y: 72 + WORKSHEET_LINE_PT });
  });

  it("advances the crosshair onto a new page at the end of the sheet", () => {
    // At the bottom margin the inserted line does not fit on page 1 any more: page 2 exists and the
    // crosshair is one line below the top of its printable area.
    const result = insertWorksheetLine(setup, [at("last", 1, 100)], { page: 1, y: 769.89 });
    expect(result.crosshair.page).toBe(2);
    expect(result.crosshair.y).toBeCloseTo(72 + WORKSHEET_LINE_PT, 6);
    // Nothing was at or below the crosshair: only the crosshair moves, the sheet itself is untouched.
    expect(result.moves).toEqual([]);
  });

  it("stays inside the printable area of the current page while there is room left", () => {
    const result = insertWorksheetLine(setup, [], { page: 1, y: 600 });
    expect(result.crosshair).toEqual({ page: 1, y: 600 + WORKSHEET_LINE_PT });
  });

  it("never moves content into a margin, in the draft view too", () => {
    // A region on the last line of the printable area goes on to the next page, not into the margin.
    for (const view of ["page", "draft"] as const) {
      const result = insertWorksheetLine(setup, [at("last", 1, 756)], { page: 1, y: 600 }, view);
      expect(moved(result, "last")?.page).toBe(2);
      expect(moved(result, "last")?.y).toBeCloseTo(72, 0);
    }
    // A region placed in a margin on purpose stays where it is.
    const result = insertWorksheetLine(setup, [at("note", 1, 21), at("footer", 1, 800), at("body", 1, 300)], { page: 1, y: 100 }, "draft");
    expect(moved(result, "note")).toBeUndefined();
    expect(moved(result, "footer")).toBeUndefined();
    expect(moved(result, "body")).toEqual({ id: "body", page: 1, y: 300 + WORKSHEET_LINE_PT });
  });

  it("moves a region whole to the next page when its bottom would reach into the margin", () => {
    // 60 pt tall, ending at 759: one line more and it would end at 774, past the bottom margin (769.89).
    const regions: LineRegion[] = [{ id: "tall", page: 1, y: 699, h: 60 }, { id: "after", page: 1, y: 762, h: 6 }];
    const result = insertWorksheetLine(setup, regions, { page: 1, y: 600 });
    expect(moved(result, "tall")).toEqual({ id: "tall", page: 2, y: 72 });
    // What follows keeps its distance below it.
    expect(moved(result, "after")?.page).toBe(2);
    expect(moved(result, "after")!.y).toBeCloseTo(72 + 63, 0);
    // Enter pushes it to the next page; Delete pulls it back onto page 1, never bouncing.
    const back = removeWorksheetLine(setup, [{ id: "tall", page: 2, y: 72, h: 60 }], { page: 1, y: 600 });
    const place = back.moves.find((move) => move.id === "tall")!;
    expect(place.page).toBe(1);
    expect(place.y + 60).toBeLessThanOrEqual(setup.height - setup.margins.bottom);
    expect(place.y).toBeGreaterThan(690);
    // and each further Delete pulls it up one line.
    const again = removeWorksheetLine(setup, [{ ...place, h: 60 }], { page: 1, y: 600 });
    expect(again.moves.find((move) => move.id === "tall")).toEqual({ id: "tall", page: 1, y: place.y - WORKSHEET_LINE_PT });
    // A tall image pulled up from the top of its page goes on up onto the page above, as low as it
    // fits whole, even above the crosshair; what follows it only moves by the line.
    const image: LineRegion[] = [{ id: "image", page: 2, y: 72, h: 500 }, { id: "below", page: 2, y: 600, h: 20 }];
    const pulled = removeWorksheetLine(setup, image, { page: 1, y: 600 });
    const imageAt = pulled.moves.find((move) => move.id === "image")!;
    expect(imageAt.page).toBe(1);
    expect(imageAt.y + 500).toBeLessThanOrEqual(setup.height - setup.margins.bottom);
    expect(imageAt.y).toBeLessThan(600);
    expect(pulled.moves.find((move) => move.id === "below")).toEqual({ id: "below", page: 2, y: 600 - WORKSHEET_LINE_PT });
    // Above the crosshair now, the next Delete leaves it where it is.
    const next = removeWorksheetLine(setup, [{ ...imageAt, h: 500 }, { id: "below", page: 2, y: 585, h: 20 }], { page: 1, y: 600 });
    expect(next.moves.find((move) => move.id === "image")).toBeUndefined();
    // A region only reaching into the top margin flows with the rest, so nothing passes it.
    const reaching = removeWorksheetLine(setup, [{ id: "big", page: 1, y: 60, h: 200 }, { id: "after", page: 1, y: 300, h: 20 }], { page: 1, y: 40 });
    expect(reaching.moves.find((move) => move.id === "big")).toBeDefined();
    // A region taller than the printable area starts at a top anyway.
    const huge = insertWorksheetLine(setup, [{ id: "huge", page: 1, y: 72, h: 900 }], { page: 1, y: 72 });
    expect(moved(huge, "huge")).toEqual({ id: "huge", page: 1, y: 72 + WORKSHEET_LINE_PT });
  });
});

describe("the point a line is inserted at", () => {
  const bands = [{ page: 1, y: 200, height: 120 }];

  it("is the crosshair itself outside an area", () => {
    expect(lineInsertionPoint(bands, 1, 190)).toEqual({ page: 1, y: 190 });
    expect(lineInsertionPoint(bands, 1, 320)).toEqual({ page: 1, y: 320 });
    expect(lineInsertionPoint(bands, 2, 240)).toEqual({ page: 2, y: 240 });
  });

  it("is the top of the area band the crosshair is inside, so the band and its members move together", () => {
    expect(lineInsertionPoint(bands, 1, 200)).toEqual({ page: 1, y: 200 });
    expect(lineInsertionPoint(bands, 1, 260)).toEqual({ page: 1, y: 200 });
  });
});

// ---- page breaks and space ----------------------

import {
  addPageBreakShift,
  blankSpaceAbove,
  blankSpaceBelow,
  pageBreakAtKey,
  pageBreakGap,
  removePageBreakShift,
  removeWorksheetLine,
  removeWorksheetLineAbove,
  shiftFlow,
} from "./lines";

// The page view's frame: the printable area of A4, from y = 72 to y = 769.89 (697.89 pt). The
// coordinates below are multiples of the 3 pt grid, so a shift that keeps a distance keeps it exactly.
const BOTTOM = 769.89;

const near = (value: number | undefined, expected: number) => {
  expect(value).toBeDefined();
  expect(Math.abs((value as number) - expected)).toBeLessThanOrEqual(1.5);
};
const place = (result: { moves: { id: string; page: number; y: number }[] }, id: string) =>
  result.moves.find((move) => move.id === id);

describe("shifting the flow", () => {
  it("moves the regions at or after the point and leaves the ones above", () => {
    const result = shiftFlow(setup, [at("above", 1, 102), at("on", 1, 300), at("below", 1, 396)], { page: 1, y: 300 }, 60);
    expect(place(result, "above")).toBeUndefined();
    expect(place(result, "on")).toEqual({ id: "on", page: 1, y: 360 });
    expect(place(result, "below")).toEqual({ id: "below", page: 1, y: 456 });
    // The point itself comes back with the shift, which is how a break lands on the next page.
    expect(result.at).toEqual({ page: 1, y: 360 });
  });

  it("does not move content above the top of the sheet when the shift is negative", () => {
    const result = shiftFlow(setup, [at("first", 1, 72), at("second", 1, 201)], { page: 1, y: 72 }, -1000);
    expect(place(result, "first")).toEqual({ id: "first", page: 1, y: 72 });
    expect(place(result, "second")).toEqual({ id: "second", page: 1, y: 72 });
  });

  it("moves nothing at all for a zero shift", () => {
    expect(shiftFlow(setup, [at("region", 1, 201)], { page: 1, y: 201 }, 0).moves).toEqual([]);
  });
});

describe("adding a page break", () => {
  it("frees the rest of the page, so content at or below the caret line continues on the next page", () => {
    const result = addPageBreakShift(
      setup,
      [at("above", 1, 201), at("on", 1, 300), at("later", 1, 396), at("onPage2", 2, 72)],
      { page: 1, y: 300 },
    );
    // Everything above the line stays; the break makes the space from 300 to the bottom margin blank,
    // so the line itself becomes the top of the next page and what follows keeps its distance.
    expect(place(result, "above")).toBeUndefined();
    expect(place(result, "on")).toEqual({ id: "on", page: 2, y: 72 });
    expect(place(result, "later")).toEqual({ id: "later", page: 2, y: 168 });
    // The content of page 2 moves down by the same space: the distances in the flow are kept.
    expect(place(result, "onPage2")?.page).toBe(2);
    near(place(result, "onPage2")?.y, 541.89);
  });

  it("keeps the gap between two regions that continue on the next page", () => {
    const result = addPageBreakShift(setup, [at("a", 1, 396), at("b", 1, 495)], { page: 1, y: 300 });
    const a = place(result, "a")!;
    const b = place(result, "b")!;
    expect(a.page).toBe(2);
    expect(b.page).toBe(2);
    expect(b.y - a.y).toBe(99);
  });

  it("frees the whole page height in the draft view and nothing on the bottom margin", () => {
    expect(pageBreakGap(setup, { page: 1, y: 300 })).toBeCloseTo(BOTTOM - 300, 9);
    expect(pageBreakGap(setup, { page: 1, y: 300 }, "draft")).toBeCloseTo(841.89 - 300, 9);
    expect(pageBreakGap(setup, { page: 1, y: BOTTOM })).toBe(0);
    expect(pageBreakGap(setup, { page: 1, y: 828 }, "draft")).toBeCloseTo(13.89, 9);
  });

  it("moves nothing when the caret line is already the bottom margin", () => {
    const result = addPageBreakShift(setup, [at("region", 1, 768)], { page: 1, y: BOTTOM });
    expect(result.moves).toEqual([]);
  });
});

describe("removing a page break", () => {
  it("is the inverse of adding it", () => {
    const regions = [at("above", 1, 201), at("below", 1, 351), at("page2", 2, 72)];
    const added = addPageBreakShift(setup, regions, { page: 1, y: 300 });
    const moved = regions.map((region) => place(added, region.id) ?? region);
    const removed = removePageBreakShift(setup, moved, { page: 1, y: 300 });
    for (const region of regions.slice(1)) {
      const back = place(removed, region.id);
      expect(back?.page).toBe(region.page);
      near(back?.y, region.y);
    }
    // Nothing above the break moved when it was removed.
    expect(place(removed, "above")).toBeUndefined();
  });

  it("is removed by Delete directly above it or Backspace directly below it, nowhere else", () => {
    const breaks = [{ page: 1, y: 300 }, { page: 2, y: 402 }];
    // Delete: on the page the break ends, at or below its line (where Add Page Break left the crosshair).
    expect(pageBreakAtKey(setup, breaks, { page: 1, y: 300 }, "Delete")).toEqual({ page: 1, y: 300 });
    expect(pageBreakAtKey(setup, breaks, { page: 1, y: 501 }, "Delete")).toEqual({ page: 1, y: 300 });
    expect(pageBreakAtKey(setup, breaks, { page: 1, y: 270 }, "Delete")).toBeNull();
    expect(pageBreakAtKey(setup, breaks, { page: 3, y: 72 }, "Delete")).toBeNull();
    // Backspace: the first worksheet line of the next page (72 + WORKSHEET_LINE_PT pt in the page view).
    expect(pageBreakAtKey(setup, breaks, { page: 2, y: 72 }, "Backspace")).toEqual({ page: 1, y: 300 });
    expect(pageBreakAtKey(setup, breaks, { page: 3, y: 72 + WORKSHEET_LINE_PT - 3 }, "Backspace")).toEqual({ page: 2, y: 402 });
    // One whole worksheet line below the page's top margin is no longer "directly below" the break.
    expect(pageBreakAtKey(setup, breaks, { page: 2, y: 72 + WORKSHEET_LINE_PT }, "Backspace")).toBeNull();
    expect(pageBreakAtKey(setup, breaks, { page: 1, y: 72 }, "Backspace")).toBeNull();
    // The draft view flows through the printable area as the page view does.
    expect(pageBreakAtKey(setup, breaks, { page: 2, y: 72 }, "Backspace", "draft")).toEqual({ page: 1, y: 300 });
  });

});

describe("removing one line of space", () => {
  it("moves the content below up by one line", () => {
    const result = removeWorksheetLine(setup, [at("above", 1, 102), at("below", 1, 261)], { page: 1, y: 201 });
    expect(place(result, "above")).toBeUndefined();
    expect(place(result, "below")).toEqual({ id: "below", page: 1, y: 261 - WORKSHEET_LINE_PT });
  });

  it("never closes more space than there is, so nothing overlaps what is above", () => {
    // A region 9 pt below the crosshair has less blank space below it than one 15 pt line: only that
    // blank space goes, and the region lands exactly on the caret line, not above it.
    const result = removeWorksheetLine(setup, [at("close", 1, 210)], { page: 1, y: 201 });
    expect(place(result, "close")).toEqual({ id: "close", page: 1, y: 201 });
    // Content on the caret line itself has no space below it.
    expect(removeWorksheetLine(setup, [at("on", 1, 201)], { page: 1, y: 201 }).moves).toEqual([]);
    // Nothing below: nothing to remove, and no undo step.
    expect(removeWorksheetLine(setup, [at("above", 1, 102)], { page: 1, y: 201 }).moves).toEqual([]);
  });

  it("counts the blank space across a page break", () => {
    // The caret is 99 pt above the bottom margin and the next region is 102 pt into page 2.
    expect(blankSpaceBelow(setup, [at("page2", 2, 174)], { page: 1, y: BOTTOM - 99 })).toBeCloseTo(201, 6);
    expect(blankSpaceBelow(setup, [], { page: 1, y: 201 })).toBeNull();
  });
});

describe("removing one line of space above the crosshair", () => {
  const sized = (id: string, page: number, y: number, h: number) => ({ id, page, y, h });

  it("moves the crosshair and the content below up by one line", () => {
    const result = removeWorksheetLineAbove(setup, [sized("above", 1, 102, 24), sized("below", 1, 261, 24)], { page: 1, y: 201 });
    expect(place(result, "above")).toBeUndefined();
    expect(place(result, "below")).toEqual({ id: "below", page: 1, y: 261 - WORKSHEET_LINE_PT });
    expect(result.at).toEqual({ page: 1, y: 201 - WORKSHEET_LINE_PT });
  });

  it("never closes more space than there is above, measured from the bottom edge of the region above", () => {
    // The region above ends at 102 + 90 = 192: 9 pt of blank space above the line at 201.
    expect(blankSpaceAbove(setup, [sized("tall", 1, 102, 90)], { page: 1, y: 201 })).toBeCloseTo(9, 6);
    const result = removeWorksheetLineAbove(setup, [sized("tall", 1, 102, 90), sized("below", 1, 261, 24)], { page: 1, y: 201 });
    expect(place(result, "below")).toEqual({ id: "below", page: 1, y: 252 });
    expect(result.at).toEqual({ page: 1, y: 192 });
    // A region that reaches down to the line, or past it, leaves no space: nothing moves.
    const touching = removeWorksheetLineAbove(setup, [sized("touch", 1, 102, 120), sized("below", 1, 261, 24)], { page: 1, y: 201 });
    expect(touching.moves).toEqual([]);
    expect(touching.at).toEqual({ page: 1, y: 201 });
  });

  it("stops at the top of the sheet, and moves only the crosshair when nothing is below", () => {
    const top = setup.margins.top;
    expect(removeWorksheetLineAbove(setup, [], { page: 1, y: top }).at).toEqual({ page: 1, y: top });
    const empty = removeWorksheetLineAbove(setup, [], { page: 1, y: top + 60 });
    expect(empty.moves).toEqual([]);
    expect(empty.at.y).toBeCloseTo(top + 60 - WORKSHEET_LINE_PT, 0);
  });
});

describe("lines inside an area", () => {
  // The band starts at 102 and is 120 pt tall: header 102-123, body 123-222, end line at 222. Every
  // place is on the 3 pt grid, as the stored places of the regions are.
  const area: LineArea = { id: "ar", page: 1, y: 102, height: 120 };
  const regions = [at("ar", 1, 102), at("a", 1, 132), at("b", 1, 162), at("under", 1, 300)];

  it("finds the area only for a point in its body, not on the header or on the end line", () => {
    expect(areaBodyAt(setup, [area], { page: 1, y: 132 })?.id).toBe("ar");
    expect(areaBodyAt(setup, [area], { page: 1, y: 111 })).toBeNull();
    expect(areaBodyAt(setup, [area], { page: 1, y: 222 })).toBeNull();
    expect(areaBodyAt(setup, [area], { page: 2, y: 132 })).toBeNull();
  });

  it("grows the band by one line and moves the content at or below the point, members included", () => {
    const result = insertWorksheetLineInArea(setup, regions, area, { page: 1, y: 147 });
    expect(result.area).toEqual({ id: "ar", height: 120 + WORKSHEET_LINE_PT });
    expect(moved(result, "ar")).toBeUndefined();
    expect(moved(result, "a")).toBeUndefined();
    expect(moved(result, "b")).toEqual({ id: "b", page: 1, y: 162 + WORKSHEET_LINE_PT });
    expect(moved(result, "under")).toEqual({ id: "under", page: 1, y: 300 + WORKSHEET_LINE_PT });
    expect(result.crosshair).toEqual({ page: 1, y: 147 + WORKSHEET_LINE_PT });
  });

  it("grows the band even when nothing is below the point", () => {
    const result = insertWorksheetLineInArea(setup, [at("ar", 1, 102)], area, { page: 1, y: 150 });
    expect(result.moves).toEqual([]);
    expect(result.area.height).toBe(135);
  });

  it("shrinks the band by the line removed, less when a member is near", () => {
    const free = removeWorksheetLineInArea(setup, [at("ar", 1, 102), at("under", 1, 300)], area, { page: 1, y: 150 });
    expect(free.area).toEqual({ id: "ar", height: 120 - WORKSHEET_LINE_PT });
    expect(free.moves).toEqual([{ id: "under", page: 1, y: 300 - WORKSHEET_LINE_PT }]);
    // A member 6 pt below the point leaves 6 pt of blank space: the band loses 6 pt only.
    const near = removeWorksheetLineInArea(setup, regions, area, { page: 1, y: 156 });
    expect(near.area?.height).toBe(120 - 6);
    expect(near.moves.find((move) => move.id === "b")).toEqual({ id: "b", page: 1, y: 156 });
  });

  it("does nothing when a member touches the point or the band is at its minimum", () => {
    expect(removeWorksheetLineInArea(setup, regions, area, { page: 1, y: 162 }).area).toBeNull();
    const small: LineArea = { id: "ar", page: 1, y: 102, height: 24 };
    const result = removeWorksheetLineInArea(setup, [at("ar", 1, 102)], small, { page: 1, y: 126 });
    expect(result.area).toBeNull();
    expect(result.moves).toEqual([]);
  });

  it("removes the space above the point inside the band, the header and the members above counting as content", () => {
    const sized = [
      { id: "ar", page: 1, y: 102, h: 120 },
      { id: "a", page: 1, y: 132, h: 15 },
      { id: "b", page: 1, y: 192, h: 15 },
    ];
    // Point at 177: the member above ends at 147, so there are 30 pt of blank space above it.
    const result = removeWorksheetLineAboveInArea(setup, sized, area, { page: 1, y: 177 });
    expect(result.area).toEqual({ id: "ar", height: 120 - WORKSHEET_LINE_PT });
    expect(result.at).toEqual({ page: 1, y: 177 - WORKSHEET_LINE_PT });
    expect(result.moves).toEqual([{ id: "b", page: 1, y: 192 - WORKSHEET_LINE_PT }]);
    // Right under the header there is no blank space above the point.
    expect(removeWorksheetLineAboveInArea(setup, sized.slice(0, 1), area, { page: 1, y: 123 }).area).toBeNull();
  });
});
