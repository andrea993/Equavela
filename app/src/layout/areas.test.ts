import { describe, expect, it } from "vitest";
import type { PageSetup, ViewRegion } from "../equavelaApi";
import {
  areaLastPage,
  areaParts,
  contentHeight,
  drawnShift,
  drawnY,
  flowFrame,
  flowOf,
  hiddenIds,
  memberIds,
  storedY,
  withMembers,
} from "./areas";

// A4 with the default 1 in top and bottom margins: the printable area of every page runs from y 72
// to 769.89, so a band that starts at y 600 of page 1 and ends on page 2 continues at y 72 there.
const setup: PageSetup = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
};

const math = (id: string, page: number, y: number): ViewRegion => ({
  id,
  page,
  x: 54,
  y,
  enabled: true,
  kind: "math",
  text: id,
  statement: null,
});
const area = (id: string, page: number, y: number, height: number, collapsed: boolean): ViewRegion => ({
  id,
  page,
  x: 54,
  y,
  enabled: true,
  kind: "area",
  title: id,
  height,
  collapsed,
});

// a1: page 1, y 100 to 220 (collapsed): members b (130) and c (160); the header is y 100 to 121.
const regions: ViewRegion[] = [
  math("a", 1, 72),
  area("a1", 1, 100, 120, true),
  math("b", 1, 130),
  math("c", 1, 160),
  math("header", 1, 110),
  math("d", 1, 240),
  area("a2", 1, 300, 60, true),
  math("f", 1, 330),
  math("g", 1, 400),
  math("e", 2, 130),
];

describe("area membership", () => {
  const a1 = regions[1] as Extract<ViewRegion, { kind: "area" }>;
  it("is the regions of the page whose top is below the header and above the end line", () => {
    expect(memberIds(regions, a1, flowFrame(setup))).toEqual(["b", "c"]);
    // a region at the end line, one in the header and one on another page are not members
    expect(memberIds([...regions, math("end", 1, 220), math("other", 2, 150)], a1, flowFrame(setup))).toEqual(["b", "c"]);
  });
  it("hides the members of collapsed areas only", () => {
    expect([...hiddenIds(regions, setup)].sort()).toEqual(["b", "c", "f"]);
    const expanded = regions.map((r) => (r.kind === "area" ? { ...r, collapsed: false } : r));
    expect(hiddenIds(expanded, setup).size).toBe(0);
  });
  it("carries the members of an area with it, once", () => {
    expect(withMembers(regions, ["a1", "b"], setup).sort()).toEqual(["a1", "b", "c"]);
    expect(withMembers(regions, ["d"], setup)).toEqual(["d"]);
  });
});

describe("drawn and stored positions", () => {
  it("moves what lies at or below the end line up by the hidden part of each collapsed area above it", () => {
    expect(drawnShift(regions, setup, 1, 72)).toBe(0);
    expect(drawnShift(regions, setup, 1, 219)).toBe(0);
    expect(drawnShift(regions, setup, 1, 240)).toBe(99);
    expect(drawnY(regions, setup, 1, 240)).toBe(141);
    // g is below both collapsed areas: 99 + 39
    expect(drawnShift(regions, setup, 1, 400)).toBe(138);
    // other pages do not move
    expect(drawnShift(regions, setup, 2, 400)).toBe(0);
  });
  it("converts a drawn point back: header and above are themselves, below the header adds the hidden part", () => {
    expect(storedY(regions, setup, 1, 90)).toBe(90);
    expect(storedY(regions, setup, 1, 110)).toBe(110);
    // the drawn point just under the first header (y 121) is stored at 121 + 99 = 220, the end line
    expect(storedY(regions, setup, 1, 121)).toBe(220);
    expect(storedY(regions, setup, 1, 141)).toBe(240);
    // under the second collapsed area: its header is drawn at 300 - 99 = 201
    expect(storedY(regions, setup, 1, 205)).toBe(205 + 99);
    expect(storedY(regions, setup, 1, 262)).toBe(262 + 99 + 39);
    expect(storedY(regions, setup, 2, 130)).toBe(130);
  });
  it("round-trips the stored positions of the regions that are drawn", () => {
    for (const region of regions.filter((r) => r.kind !== "area" && !hiddenIds(regions, setup).has(r.id))) {
      expect(storedY(regions, setup, region.page, drawnY(regions, setup, region.page, region.y))).toBe(region.y);
    }
  });
});

describe("a band across pages", () => {
  const frame = flowFrame(setup);
  type Area = Extract<ViewRegion, { kind: "area" }>;
  // 600 to the bottom margin of page 1 (169.89 pt), then 72 to 302.11 on page 2 (230.11 pt).
  const crossing = area("ac", 1, 600, 400, false) as Area;
  const sheet: ViewRegion[] = [
    crossing,
    math("in-header", 1, 605),
    math("first", 1, 650),
    math("top", 2, 72),
    math("second", 2, 200),
    math("below", 2, 400),
  ];

  it("is one part per page, from the bottom margin to the top margin of the next page", () => {
    const parts = areaParts(frame, crossing);
    expect(parts).toHaveLength(2);
    expect(parts[0].page).toBe(1);
    expect(parts[0].top).toBe(600);
    expect(parts[0].height).toBeCloseTo(169.89, 5);
    expect(parts[1].page).toBe(2);
    expect(parts[1].top).toBe(72);
    expect(parts[1].height).toBeCloseTo(230.11, 5);
    // Only the first part carries the header, only the last the end line.
    expect(parts.map((part) => [part.header, part.end])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(areaLastPage(frame, crossing)).toBe(2);
  });

  it("crosses two page breaks in three parts", () => {
    const long = area("al", 1, 100, 1400, false) as Area;
    const parts = areaParts(frame, long);
    expect(parts.map((part) => part.page)).toEqual([1, 2, 3]);
    expect(parts[1].height).toBeCloseTo(697.89, 5);
    expect(parts[2].height).toBeCloseTo(32.22, 5);
    expect(areaLastPage(frame, long)).toBe(3);
  });

  it("holds the regions of the next page as members, below its own header", () => {
    const band = crossing;
    expect(memberIds(sheet, band, frame)).toEqual(["first", "top", "second"]);
    // A region above the top margin of page 2, and one below the end line, are not members.
    expect(memberIds([...sheet, math("above", 2, 60), math("past", 2, 320)], band, frame)).toEqual(["first", "top", "second"]);
  });

  it("hides the members of both pages when collapsed, and shifts what lies below on each page", () => {
    const collapsed = { ...crossing, collapsed: true } as ViewRegion;
    const withBand = [collapsed, ...sheet.slice(1)];
    expect([...hiddenIds(withBand, setup)].sort()).toEqual(["first", "second", "top"]);
    // On page 1 the removable length is 169.89 - 21 = 148.89; on page 2 it is the whole 230.11.
    // What lies at or below the band on page 1 is what sits in its bottom margin (y 800).
    expect(drawnShift(withBand, setup, 1, 800)).toBeCloseTo(148.89, 5);
    expect(drawnShift(withBand, setup, 2, 400)).toBeCloseTo(230.11, 5);
    expect(drawnShift(withBand, setup, 3, 400)).toBe(0);
    // The inverse mapping of the page 2 point: below the header of the first part of that page,
    // which stays where the band starts there.
    expect(storedY(withBand, setup, 2, 400 - 230.11)).toBe(400);
    // Round trip of what is drawn.
    for (const region of [math("below", 2, 400), math("d", 1, 800)]) {
      expect(storedY(withBand, setup, region.page, drawnY(withBand, setup, region.page, region.y))).toBeCloseTo(region.y, 5);
    }
  });

  it("is drawn on its last page even when nothing else is there", () => {
    const long = area("al", 1, 100, 1400, false) as Area;
    expect(areaLastPage(frame, long)).toBe(3);
    // A band of the second page starts there.
    expect(areaParts(frame, area("p2", 2, 72, 100, false) as Area)).toHaveLength(1);
  });

  it("is one part when it ends inside its page, as before", () => {
    const parts = areaParts(frame, area("short", 1, 100, 120, false) as Area);
    expect(parts).toEqual([{ page: 1, top: 100, height: 120, header: true, end: true }]);
  });
});

describe("a band holds its content", () => {
  const frame = flowFrame(setup);
  const band = { page: 1, y: 100, height: 60 };
  it("ends one grid step below the lowest member, on the page grid", () => {
    // A member drawn from 130 to 230: the end line goes to 234 (233 is off the grid).
    expect(contentHeight(frame, band, [flowOf(frame, 1, 230)])).toBe(134);
    expect(contentHeight(frame, band, [flowOf(frame, 1, 150), flowOf(frame, 1, 230)])).toBe(134);
  });
  it("needs nothing without members and stops at the next area", () => {
    expect(contentHeight(frame, band, [])).toBe(0);
    expect(contentHeight(frame, band, [flowOf(frame, 1, 500)], flowOf(frame, 1, 400))).toBe(300);
  });
  it("continues on the next page when a member reaches past the bottom margin", () => {
    // A member that ends 20 pt into page 2's printable part.
    const height = contentHeight(frame, { page: 1, y: 600, height: 60 }, [flowOf(frame, 2, 92)]);
    expect(areaParts(frame, { page: 1, y: 600, height }).at(-1)?.page).toBe(2);
  });
});
