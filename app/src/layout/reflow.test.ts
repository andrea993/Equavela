// The page-indexed reflow must place every region exactly as a naive implementation of the same
// rules does, one that compares each region with every region already placed. That implementation is kept here as
// the reference, and both run on random layouts: several pages, overlaps, pushes onto the next page,
// regions taller than the printable area and empty ones.

import { describe, expect, it } from "vitest";
import type { PageSetup, ViewRegion } from "../equavelaApi";
import { printableArea, reflow, reflowIncremental, snapToGrid, GRID_PT, type FlowItem, type Flowed } from "./geometry";
import { drawnY, drawnYOf } from "./areas";

const EPS = 1e-6;

function referenceReflow(setup: PageSetup, items: FlowItem[]): Map<string, Flowed> {
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
  const placed: { page: number; x0: number; x1: number; y0: number; y1: number }[] = [];
  const result = new Map<string, Flowed>();
  const land = (item: FlowItem, start: number) => {
    const x0 = snapToGrid(item.x);
    const x1 = x0 + item.w;
    let page = Math.max(1, Math.round(item.page));
    let y = start;
    for (let guard = 0; guard < 10_000 && item.w > 0 && item.h > 0; guard++) {
      let bottom = -Infinity;
      for (const other of placed) {
        if (
          other.page === page &&
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
  // A row (the regions stored on one line of one page) is pushed as one, by its largest push.
  for (let i = 0; i < order.length; ) {
    let end = i + 1;
    while (end < order.length && order[end].page === order[i].page && snapToGrid(order[end].y) === snapToGrid(order[i].y)) end++;
    const row = order.slice(i, end);
    const own = snapToGrid(order[i].y);
    let delta = 0;
    for (let round = 0; round < 10; round++) {
      let next = delta;
      for (const item of row) {
        if (item.w <= 0 || item.h <= 0) continue;
        const landed = land(item, own + delta);
        if (landed.page !== Math.max(1, Math.round(item.page))) continue;
        next = Math.max(next, landed.y - own);
      }
      if (next <= delta + EPS) break;
      delta = next;
    }
    for (const item of row) {
      const { page, y } = land(item, own + delta);
      const x0 = snapToGrid(item.x);
      placed.push({ page, x0, x1: x0 + item.w, y0: y, y1: y + item.h });
      result.set(item.id, { page, y, pushed: page !== item.page || y !== own });
    }
    i = end;
  }
  return result;
}


const a4: PageSetup = {
  size: "A4",
  orientation: "portrait",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
  header: { left: "", center: "", right: "" },
  footer: { left: "", center: "", right: "" },
} as PageSetup;

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layout(seed: number, count: number): FlowItem[] {
  const next = random(seed);
  const pages = 1 + Math.floor(next() * 6);
  return Array.from({ length: count }, (_, i) => {
    const tall = next() < 0.03;
    return {
      id: `r${i}`,
      page: 1 + Math.floor(next() * pages),
      x: 54 + Math.floor(next() * 120) * 3,
      y: 72 + Math.floor(next() * 230) * 3,
      w: next() < 0.05 ? 0 : 12 + Math.floor(next() * 300),
      h: next() < 0.05 ? 0 : tall ? 700 + next() * 200 : 9 + Math.floor(next() * 120),
    };
  });
}

describe("reflow with a per-page index", () => {
  it("places every region exactly as the reference implementation", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const items = layout(seed, 5 + (seed % 60));
      const actual: Map<string, Flowed> = reflow(a4, items);
      const expected: Map<string, Flowed> = referenceReflow(a4, items);
      expect([...actual.entries()]).toEqual([...expected.entries()]);
    }
  });

  it("is not slower than the reference on a large worksheet", () => {
    const items = layout(7, 1500);
    const started = performance.now();
    reflow(a4, items);
    const indexed = performance.now() - started;
    const t0 = performance.now();
    referenceReflow(a4, items);
    const reference = performance.now() - t0;
    // Informative only: timings vary with the machine; the indexed version must not be slower.
    expect(indexed).toBeLessThan(reference * 1.5 + 5);
  }, 60_000);
});

describe("incremental reflow from the changed page", () => {
  it("matches the reference implementation across 200 random edit sequences (resize, move, insert, delete)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed + 10_000);
      let items = layout(seed, 10 + (seed % 50));
      let state = reflowIncremental(a4, items);
      for (let step = 0; step < 5; step++) {
        const op = Math.floor(next() * 4);
        const copy = items.map((item) => ({ ...item }));
        if (op === 0 && copy.length > 0) {
          // Resize one region (grow or shrink, potentially causing or removing a page spill).
          const idx = Math.floor(next() * copy.length);
          copy[idx].h = next() < 0.2 ? 300 : 9 + Math.floor(next() * 120);
          copy[idx].w = 12 + Math.floor(next() * 250);
        } else if (op === 1 && copy.length > 0) {
          // Move one region to another page or y.
          const idx = Math.floor(next() * copy.length);
          copy[idx].page = 1 + Math.floor(next() * 6);
          copy[idx].y = 72 + Math.floor(next() * 230) * 3;
        } else if (op === 2) {
          // Insert a new region.
          copy.push({
            id: `ins-${seed}-${step}`,
            page: 1 + Math.floor(next() * 6),
            x: 54 + Math.floor(next() * 100) * 3,
            y: 72 + Math.floor(next() * 230) * 3,
            w: 40 + Math.floor(next() * 150),
            h: 15 + Math.floor(next() * 100),
          });
        } else if (copy.length > 1) {
          // Delete a region (possibly emptying its page).
          copy.splice(Math.floor(next() * copy.length), 1);
        }
        items = copy;
        state = reflowIncremental(a4, items, state);
        const expected = referenceReflow(a4, items);
        expect(state.flow.size).toBe(expected.size);
        for (const [id, want] of expected) {
          expect(state.flow.get(id)).toEqual(want);
        }
      }
    }
  });

  it("recomputes only the touched page when a size change does not spill onto later pages", () => {
    // 20 pages, 10 well-spaced regions per page.
    const items: FlowItem[] = [];
    for (let page = 1; page <= 20; page++) {
      for (let row = 0; row < 10; row++) {
        items.push({ id: `p${page}-r${row}`, page, x: 54, y: 72 + row * 60, w: 120, h: 24 });
      }
    }
    const initial = reflowIncremental(a4, items);
    expect(initial.pagesRecomputed).toBe(20);

    // Grow one region on page 12 by 12 pt: stays on page 12, no spill onto page 13.
    const edited = items.map((item) => (item.id === "p12-r3" ? { ...item, h: 36 } : item));
    const after = reflowIncremental(a4, edited, initial);
    expect(after.pagesRecomputed).toBe(1);
    expect(after.flow.get("p12-r3")).toEqual(referenceReflow(a4, edited).get("p12-r3"));

    // No-op pass recomputes 0 pages and keeps the same flow map.
    const noop = reflowIncremental(a4, edited, after);
    expect(noop.pagesRecomputed).toBe(0);
    expect(noop.flow).toBe(after.flow);
  });
});

describe("drawnYOf", () => {
  it("gives the same drawn y as drawnY for every region", () => {
    const setup: PageSetup = {
      size: "A4",
      width: 595.28,
      height: 841.89,
      margins: { top: 72, right: 54, bottom: 72, left: 54 },
      header: { left: "", center: "", right: "" },
      footer: { left: "", center: "", right: "" },
    };
    const next = random(3);
    const regions = Array.from({ length: 80 }, (_, i) => {
      const area = i % 7 === 0;
      return {
        id: `r${i}`,
        kind: area ? "area" : "math",
        page: 1 + Math.floor(next() * 3),
        x: 54,
        y: 72 + Math.floor(next() * 200) * 3,
        enabled: true,
        ...(area ? { collapsed: next() < 0.6, height: 24 + Math.floor(next() * 60) * 3, title: "" } : {}),
      } as unknown as ViewRegion;
    });
    const at = drawnYOf(regions, setup);
    for (const region of regions) {
      for (const y of [region.y, region.y + 50, 72, 760]) {
        expect(at(region.page, y)).toBe(drawnY(regions, setup, region.page, y));
      }
    }
  });
});
