// The rebuild of a full edit result from a delta: the backend sends only what changed since
// the last state it sent, and the frontend keeps the objects of everything that did not.

import { describe, expect, it } from "vitest";
import { applyEditDelta, stateFromOpened, stateFromSnapshot, type WorksheetState } from "./editDelta";
import {
  keyId,
  type DocumentView,
  type EditResultDelta,
  type OpenedWorksheet,
  type RegionEntry,
  type ViewRegion,
} from "./equavelaApi";

const math = (id: string, text = id): ViewRegion =>
  ({ id, kind: "math", page: 1, x: 54, y: 72, enabled: true, text, statement: null }) as unknown as ViewRegion;

const entry = (id: string, value: number): RegionEntry =>
  ({
    key: { document: "d", region_id: id, instance: 0 },
    state: "value",
    value: { type: "real", value },
  }) as unknown as RegionEntry;

const page = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
} as unknown as DocumentView["page"];

const view = (regions: ViewRegion[]): DocumentView => ({
  document: "d",
  page,
  settings: { "format.unit": "si" },
  regions,
  can_undo: true,
  can_redo: false,
  undo_label: "Edit math",
  redo_label: null,
});

const state = (regions: ViewRegion[], results: RegionEntry[], revision = 3): WorksheetState => ({
  revision,
  view: view(regions),
  regions: results,
});

/** A delta with everything that did not change left out, as the backend sends it. */
const delta = (base: number, change: Partial<EditResultDelta> = {}): EditResultDelta => ({
  base,
  revision: base + 1,
  regions: [],
  removed: [],
  can_undo: true,
  can_redo: false,
  undo_label: null,
  redo_label: null,
  results: [],
  removed_results: [],
  created: null,
  label: null,
  ...change,
});

const ids = (regions: readonly ViewRegion[]) => regions.map((region) => region.id);

describe("applyEditDelta", () => {
  it("keeps the object of every region and result that did not change", () => {
    const a = math("a");
    const b = math("b");
    const resultA = entry("a", 1);
    const resultB = entry("b", 2);
    const before = state([a, b], [resultA, resultB]);
    const changed = math("b", "b := 2");
    const { result, state: next } = applyEditDelta(
      before,
      delta(3, { regions: [changed], results: [entry("b", 5)] }),
    );
    expect(result.view.regions[0]).toBe(a);
    expect(result.view.regions[1]).toBe(changed);
    expect(result.regions[0]).toBe(resultA);
    expect(result.regions[1].key).toEqual(resultB.key);
    // The page setup and the settings kept their objects too; the scalars come from the delta.
    expect(result.view.page).toBe(before.view.page);
    expect(result.view.settings).toBe(before.view.settings);
    expect(result.view.undo_label).toBeNull();
    expect(next.revision).toBe(4);
    expect(next.view).toBe(result.view);
    expect(next.regions).toBe(result.regions);
  });

  it("applies a delta that changes many regions and results (a commit marks every dependent stale)", () => {
    const regions = Array.from({ length: 50 }, (_, i) => math(`r${i}`));
    const results = regions.map((region, i) => entry(region.id, i));
    const before = state(regions, results);
    // More changes than the scan handles, plus one new region and result at the end.
    const changedRegions = [math("r7", "r7 := 1"), math("r30", "r30 := 2"), ...[1, 2, 3, 4, 5].map((i) => math(`r${i * 9}`, "x")), math("new")];
    const changedResults = [...regions.filter((_, i) => i % 3 === 0).map((region) => entry(region.id, -1)), entry("new", 9)];
    const { result } = applyEditDelta(before, delta(3, { regions: changedRegions, results: changedResults }));
    expect(ids(result.view.regions)).toEqual([...ids(regions), "new"]);
    for (const region of changedRegions) expect(result.view.regions.find((r) => r.id === region.id)).toBe(region);
    expect(result.view.regions[1]).toBe(regions[1]);
    expect(result.regions).toHaveLength(51);
    for (const changed of changedResults) {
      expect(result.regions.find((e) => e.key.region_id === changed.key.region_id)).toBe(changed);
    }
    expect(result.regions[1]).toBe(results[1]);
  });

  it("drops the removed regions and results and adds the new ones", () => {
    const a = math("a");
    const b = math("b");
    const resultA = entry("a", 1);
    const resultB = entry("b", 2);
    const before = state([a, b], [resultA, resultB]);
    const c = math("c");
    const added = applyEditDelta(before, delta(3, { regions: [c], results: [entry("c", 3)] }));
    expect(ids(added.result.view.regions)).toEqual(["a", "b", "c"]);
    expect(added.result.view.regions[2]).toBe(c);
    expect(added.result.regions.map((e) => e.key.region_id)).toEqual(["a", "b", "c"]);

    const removed = applyEditDelta(
      before,
      delta(3, { removed: ["a"], removed_results: [keyId(resultA.key)] }),
    );
    expect(ids(removed.result.view.regions)).toEqual(["b"]);
    expect(removed.result.view.regions[0]).toBe(b);
    expect(removed.result.regions).toEqual([resultB]);
    expect(removed.result.regions[0]).toBe(resultB);
  });

  it("follows the order the delta gives and keeps the objects it moves", () => {
    const a = math("a");
    const b = math("b");
    const resultA = entry("a", 1);
    const resultB = entry("b", 2);
    const before = state([a, b], [resultA, resultB]);
    const c = math("c");
    const { result } = applyEditDelta(
      before,
      delta(3, {
        regions: [c],
        order: ["c", "b", "a"],
        results: [entry("c", 3)],
        results_order: [keyId(entry("c", 3).key), keyId(resultB.key), keyId(resultA.key)],
      }),
    );
    expect(ids(result.view.regions)).toEqual(["c", "b", "a"]);
    expect(result.view.regions[0]).toBe(c);
    expect(result.view.regions[1]).toBe(b);
    expect(result.view.regions[2]).toBe(a);
    expect(result.regions.map((e) => e.key.region_id)).toEqual(["c", "b", "a"]);
    expect(result.regions[2]).toBe(resultA);
  });

  it("takes the fields that changed and the whole result's own ones", () => {
    const before = state([math("a")], []);
    const nextPage = { ...page, size: "Letter" } as DocumentView["page"];
    const { result } = applyEditDelta(
      before,
      delta(3, {
        page: nextPage,
        settings: { "format.unit": "km" },
        document: "other.eqv",
        can_undo: false,
        can_redo: true,
        undo_label: null,
        redo_label: "Delete region",
        created: "b",
        calc_needed: true,
        label: "Delete region",
      }),
    );
    expect(result.view.page).toBe(nextPage);
    expect(result.view.settings).toEqual({ "format.unit": "km" });
    expect(result.view.document).toBe("other.eqv");
    expect(result.view.can_undo).toBe(false);
    expect(result.view.can_redo).toBe(true);
    expect(result.view.redo_label).toBe("Delete region");
    expect(result.created).toBe("b");
    expect(result.calc_needed).toBe(true);
    expect(result.label).toBe("Delete region");
  });

  it("refuses a delta that does not apply to the stored revision", () => {
    const before = state([math("a")], [], 5);
    expect(() => applyEditDelta(before, delta(4))).toThrow(/revision 4, not 5/);
  });

  it("refuses an order that names a region it does not know", () => {
    const before = state([math("a")], [], 5);
    expect(() => applyEditDelta(before, delta(5, { order: ["a", "ghost"] }))).toThrow(
      /unknown region `ghost`/,
    );
  });

  it("carries on from a state a command or a snapshot left behind", () => {
    const opened = {
      id: "ws1",
      root: "d",
      revision: 9,
      view: view([math("a")]),
      regions: [entry("a", 1)],
      texts: [],
      diagnostics: [],
    } as unknown as OpenedWorksheet;
    const fromOpen = stateFromOpened(opened);
    expect(fromOpen.revision).toBe(9);
    const fromSnapshot = stateFromSnapshot({ revision: 9, view: view([math("a")]), regions: [] });
    expect(fromSnapshot.revision).toBe(9);
    const { result, state: next } = applyEditDelta(fromOpen, delta(9, { regions: [math("a", "b := 1")] }));
    expect(result.view.regions.map((r) => r.id)).toEqual(["a"]);
    expect(result.view.regions[0]).not.toBe(fromOpen.view.regions[0]);
    expect(next.revision).toBe(10);
  });
});
