// The index the page view derives from the regions: what one edit patches must be what a pass
// over the whole worksheet would give, and what it did not touch must keep its identity.

import { describe, expect, it } from "vitest";
import { applyEditDelta, type WorksheetState } from "../editDelta";
import { drawnYOf, hiddenIds } from "../layout/areas";
import { formatFromSettings } from "../results/format";
import { initialState, reducer } from "../workbench/useWorkbench";
import { entriesPatchOf, inheritEntriesPatch } from "../workbench/patches";
import type { DocumentView, EditResultDelta, OpenedWorksheet, RegionEntry, ViewRegion } from "../equavelaApi";
import { sheetIndexOf } from "./sheetIndex";

const SETTINGS = { "format.precision": "3" };

const page = {
  size: "A4",
  width: 595.28,
  height: 841.89,
  margins: { top: 72, right: 54, bottom: 72, left: 54 },
} as unknown as DocumentView["page"];

const view = (regions: ViewRegion[]): DocumentView => ({
  document: "sheet.eqv",
  page,
  settings: SETTINGS,
  regions,
  can_undo: true,
  can_redo: false,
  undo_label: "Edit",
  redo_label: null,
});

const definition = (name: string) => ({
  type: "Define",
  target: { type: "Ident", name: { segments: [{ text: name, subscript: false }], label: null } },
  rhs: null,
});

const math = (id: string, y: number, defined?: string, format?: Record<string, string>): ViewRegion =>
  ({
    id,
    page: 1,
    x: 54,
    y,
    enabled: true,
    kind: "math",
    text: `${defined ?? id} := 1`,
    statement: defined ? definition(defined) : null,
    ...(format ? { format } : {}),
  }) as unknown as ViewRegion;

const text = (id: string, y: number, width: number | null): ViewRegion =>
  ({ id, page: 1, x: 54, y, enabled: true, kind: "text", text: id, width, paragraphs: [] }) as unknown as ViewRegion;

const area = (id: string, y: number, height: number, collapsed: boolean): ViewRegion =>
  ({ id, page: 1, x: 54, y, enabled: true, kind: "area", title: id, height, collapsed }) as unknown as ViewRegion;

const initial: ViewRegion[] = [
  math("a", 72, "a"),
  area("a1", 100, 120, true),
  math("b", 130, "b"),
  math("c", 160, "b"),
  math("d", 240, "d", { "format.precision": "2" }),
  text("t", 260, 240),
  area("a2", 300, 60, false),
  math("f", 330, "f"),
];

const delta = (base: number, over: Partial<EditResultDelta>): EditResultDelta => ({
  base,
  revision: base + 1,
  regions: [],
  removed: [],
  can_undo: true,
  can_redo: false,
  undo_label: "Edit",
  redo_label: null,
  results: [],
  removed_results: [],
  created: null,
  label: "Edit",
  ...over,
});

/** Everything the index says, computed from the whole worksheet as the app did before. */
function expectIndexToMatch(index: ReturnType<typeof sheetIndexOf>, regions: ViewRegion[]): void {
  expect(index.byId.size).toBe(regions.length);
  for (const region of regions) expect(index.byId.get(region.id)).toBe(region);
  expect([...index.hidden].sort()).toEqual([...hiddenIds(regions, page)].sort());
  const formats = regions
    .filter((r) => r.kind === "math" && r.format)
    .map((r) => {
      const format = (r as { format?: Record<string, string> }).format;
      return [r.id, formatFromSettings({ ...SETTINGS, ...format })] as const;
    });
  const byId = (a: readonly [string, unknown], b: readonly [string, unknown]) => a[0].localeCompare(b[0]);
  expect([...index.formats].sort(byId)).toEqual([...formats].sort(byId));
  const drawnY = drawnYOf(regions, page);
  expect(regions.map((r) => index.drawnY(r.page, r.y))).toEqual(regions.map((r) => drawnY(r.page, r.y)));
}

describe("the box of a result table", () => {
  it("comes from the region's display override, never from the worksheet settings", () => {
    const boxed = math("t", 72, "t", { "result-table-size": "480,180" });
    const plain = math("u", 96, "u", { "format.precision": "5" });
    const index = sheetIndexOf([boxed, plain], page, SETTINGS);
    expect(index.formats.get("t")?.tableSize).toEqual([480, 180]);
    expect(index.formats.get("u")?.tableSize).toBeNull();
    // A box belongs to one region's result: a value in `settings:` is not a default box.
    const withSetting = sheetIndexOf([plain], page, { ...SETTINGS, "result-table-size": "300,120" });
    expect(withSetting.formats.get("u")?.tableSize).toBeNull();
    // A value the reader cannot read as two numbers falls back to the default box of .
    const broken = sheetIndexOf([math("w", 120, "w", { "result-table-size": "wide,180" })], page, SETTINGS);
    expect(broken.formats.get("w")?.tableSize).toBeNull();
  });
});

describe("the indices of a matrix result", () => {
  it("come from the region's override over the worksheet setting, in both directions", () => {
    const shown = math("s", 72, "s", { "format.show-indices": "true" });
    const hidden = math("h", 96, "h", { "format.show-indices": "false" });
    const plain = math("p", 120, "p", { "format.precision": "5" });
    const index = sheetIndexOf([shown, hidden, plain], page, SETTINGS);
    expect(index.formats.get("s")?.showIndices).toBe(true);
    expect(index.formats.get("h")?.showIndices).toBe(false);
    expect(index.formats.get("p")?.showIndices).toBe(false);
    const worksheet = sheetIndexOf([hidden, plain], page, { ...SETTINGS, "format.show-indices": "true" });
    expect(worksheet.formats.get("h")?.showIndices).toBe(false);
    expect(worksheet.formats.get("p")?.showIndices).toBe(true);
    // A key written before 2026-11-20 is kept in the file and draws nothing different.
    const old = sheetIndexOf([math("t", 144, "t", { "format.matrix-display": "table" })], page, SETTINGS);
    expect(old.formats.get("t")).toEqual(formatFromSettings({ ...SETTINGS, "format.matrix-display": "table" }));
  });
});

describe("the sheet index of an edited worksheet", () => {
  const start = (): WorksheetState => ({ revision: 0, view: view(initial), regions: [] });
  const regionsOf = (state: WorksheetState) => state.view.regions;
  const idOf = (state: WorksheetState, id: string) => state.view.regions.find((r) => r.id === id)!;

  it("matches a pass over the whole worksheet after every kind of edit", () => {
    let state = start();
    let index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    // Nothing is known about the edits of an array built from scratch: a reader must look at everything.
    expect(index.changed).toBeNull();

    // 1. a text edit that moves nothing: the hidden members, the drawn positions and the formats stay
    const hidden = index.hidden;
    const drawnY = index.drawnY;
    const formats = index.formats;
    const edited = state.view.regions.map((r) => (r.id === "b" ? { ...r, text: "b := 2" } : r));
    state = applyEditDelta(state, delta(0, { regions: [edited[2]] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.hidden).toBe(hidden);
    expect(index.drawnY).toBe(drawnY);
    expect(index.formats).toBe(formats);
    expect(index.changed).toEqual(["b"]);

    // 2. an area expanded: its members are drawn again, everything below moves up
    const expanded = { ...(idOf(state, "a1") as Extract<ViewRegion, { kind: "area" }>), collapsed: false };
    state = applyEditDelta(state, delta(1, { regions: [expanded] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.hidden.size).toBe(0);

    // 3. a region moved into the second area, which is then collapsed
    const moved = { ...idOf(state, "c"), y: 340 };
    state = applyEditDelta(state, delta(2, { regions: [moved] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    const collapsed = { ...(idOf(state, "a2") as Extract<ViewRegion, { kind: "area" }>), collapsed: true };
    state = applyEditDelta(state, delta(3, { regions: [collapsed] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect([...index.hidden].sort()).toEqual(["c", "f"]);

    // 4. a definition renamed: one name goes, another comes
    const renamed = { ...idOf(state, "b"), statement: definition("z") };
    state = applyEditDelta(state, delta(4, { regions: [renamed] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));

    // 5. a format set on a region, then taken away
    const formatted = { ...idOf(state, "a"), format: { "format.precision": "5" } };
    state = applyEditDelta(state, delta(5, { regions: [formatted] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.formats.has("a")).toBe(true);
    const plain = { ...idOf(state, "a"), format: undefined };
    state = applyEditDelta(state, delta(6, { regions: [plain] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.formats.has("a")).toBe(false);

    // 6. a region removed and one added
    state = applyEditDelta(state, delta(7, { removed: ["f"] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.byId.has("f")).toBe(false);
    const added = math("g", 400, "g");
    state = applyEditDelta(state, delta(8, { regions: [added] })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
    expect(index.byId.get("g")).toBe(regionsOf(state).find((r) => r.id === "g"));

    // 7. a reordered worksheet (a delta with `order`): the index starts over
    const order = regionsOf(state).map((r) => r.id).reverse();
    state = applyEditDelta(state, delta(9, { order })).state;
    index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
  });

  it("says when a region may have been laid out somewhere else", () => {
    // The page view reflows again only when this changes, so it must follow everything the reflow reads:
    // positions, the size a region is estimated with, and the regions that exist.
    let state = start();
    let index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    const rewrite = (source: WorksheetState, id: string, over: Partial<ViewRegion>) => {
      const region = source.view.regions.find((r) => r.id === id)!;
      return [{ ...region, ...over } as ViewRegion];
    };

    // Content only: nothing is laid out again.
    const text = { ...idOf(state, "b"), text: "b := 7" } as ViewRegion;
    state = applyEditDelta(state, delta(0, { regions: [text] })).state;
    const afterText = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expect(afterText.geometry).toBe(index.geometry);

    // A moved region, a resized one and an added one all lay the sheet out again.
    for (const [revision, regions] of [
      [1, rewrite(state, "b", { y: 500 })],
      [2, rewrite(state, "t", { width: 320 } as Partial<ViewRegion>)],
      [3, [math("h", 600, "h")]],
    ] as const) {
      const previous = sheetIndexOf(regionsOf(state), page, SETTINGS);
      state = applyEditDelta(state, delta(revision, { regions: [...regions] })).state;
      const next = sheetIndexOf(regionsOf(state), page, SETTINGS);
      expect(next.geometry).not.toBe(previous.geometry);
    }

    // A collapsed area changes where everything below it is drawn.
    const collapsed = { ...(idOf(state, "a2") as Extract<ViewRegion, { kind: "area" }>), collapsed: true };
    state = applyEditDelta(state, delta(4, { regions: [collapsed] })).state;
    const afterCollapse = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expect(afterCollapse.geometry).not.toBe(index.geometry);
    index = afterCollapse;
    expect(sheetIndexOf(regionsOf(state), page, SETTINGS)).toBe(index);
  });

  it("starts over when an edit was not seen (no index for the array it rebuilt)", () => {
    let state = start();
    const rewrite = (state: WorksheetState, text: string) =>
      state.view.regions.map((r) => (r.id === "b" ? ({ ...r, text } as ViewRegion) : r))[2];
    state = applyEditDelta(state, delta(0, { regions: [rewrite(state, "b := 3")] })).state;
    state = applyEditDelta(state, delta(1, { regions: [rewrite(state, "b := 4")] })).state;
    const index = sheetIndexOf(regionsOf(state), page, SETTINGS);
    expectIndexToMatch(index, regionsOf(state));
  });

  it("is patched through the reducer, which keeps the previous objects of what equals them", () => {
    const opened = {
      id: "w1",
      root: "sheet.eqv",
      view: view(initial),
      regions: [],
      diagnostics: [],
    } as unknown as OpenedWorksheet;
    let state = reducer(initialState("tauri"), { type: "opened", opened });
    const first = sheetIndexOf(state.docs[0].view.regions, page, SETTINGS);
    const edited = state.docs[0].view.regions.map((r) => (r.id === "b" ? { ...r, text: "b := 9" } : r));
    const result = applyEditDelta(
      { revision: 0, view: state.docs[0].view, regions: [] },
      delta(0, { regions: [edited[2]], results: [] }),
    );
    state = reducer(state, { type: "edited", id: "w1", result: result.result });
    const index = sheetIndexOf(state.docs[0].view.regions, page, SETTINGS);
    expectIndexToMatch(index, state.docs[0].view.regions);
    expect(index.hidden).toBe(first.hidden);
    expect(index.byId.get("b")).toBe(state.docs[0].view.regions.find((r) => r.id === "b"));
  });

  it("records the result entries an edit touched, for the page view to patch", () => {
    const entry = (id: string): RegionEntry =>
      ({ key: { document: "sheet.eqv", region_id: id, instance: 0 }, state: "pending" }) as unknown as RegionEntry;
    const start: WorksheetState = { revision: 0, view: view(initial), regions: [entry("a"), entry("b")] };
    const rebuilt = applyEditDelta(start, delta(0, { regions: [math("b", 130, "b")], results: [entry("b")] }));
    expect(entriesPatchOf(rebuilt.result.regions)).toMatchObject({ base: start.regions, changed: ["sheet.eqv#b#0"], added: [], removed: [] });
    // The reducer may hand the same patch to the array it made of it.
    const kept = [...rebuilt.result.regions];
    inheritEntriesPatch(rebuilt.result.regions, kept);
    expect(entriesPatchOf(kept)).toBe(entriesPatchOf(rebuilt.result.regions));
    expect(entriesPatchOf(start.regions)).toBeUndefined();
  });
});
