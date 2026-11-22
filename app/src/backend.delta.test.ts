// The Tauri backend keeps the whole state of every open worksheet and applies the deltas the
// commands return; the rest of the UI still receives whole `EditResult`s, with the objects
// of everything that did not change. A delta for another revision is repaired with a snapshot.

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }),
}));

import { createTauriBackend } from "./backend";
import type { DocumentView, EditResultDelta, OpenedWorksheet, RegionEntry, ViewRegion } from "./equavelaApi";

afterEach(() => {
  invoke.mockReset();
});

const math = (id: string, text = id): ViewRegion =>
  ({ id, kind: "math", page: 1, x: 54, y: 72, enabled: true, text, statement: null }) as unknown as ViewRegion;

const entry = (id: string, value: number): RegionEntry =>
  ({
    key: { document: "/a.eqv", region_id: id, instance: 0 },
    state: "value",
    value: { type: "real", value },
  }) as unknown as RegionEntry;

const view = (regions: ViewRegion[]): DocumentView => ({
  document: "/a.eqv",
  page: { size: "A4", width: 595.28, height: 841.89, margins: { top: 72, right: 54, bottom: 72, left: 54 } } as unknown as DocumentView["page"],
  settings: {},
  regions,
  can_undo: false,
  can_redo: false,
  undo_label: null,
  redo_label: null,
});

const opened = (): OpenedWorksheet => ({
  id: "ws1",
  root: "/a.eqv",
  revision: 0,
  view: view([math("a"), math("b")]),
  regions: [entry("a", 1), entry("b", 2)],
  texts: [],
  diagnostics: [],
});

const delta = (base: number, change: Partial<EditResultDelta> = {}): EditResultDelta => ({
  base,
  revision: base + 1,
  regions: [],
  removed: [],
  can_undo: true,
  can_redo: false,
  undo_label: "Edit math",
  redo_label: null,
  results: [],
  removed_results: [],
  created: null,
  label: "Edit math",
  ...change,
});

describe("the Tauri backend and the edit deltas", () => {
  it("rebuilds the whole result, keeping the objects of what did not change", async () => {
    const worksheet = opened();
    const changed = math("b", "b := 3");
    invoke.mockImplementation(async (command: string) => {
      if (command === "open_worksheet") return worksheet;
      if (command === "set_math") return delta(0, { regions: [changed] });
      return null;
    });
    const backend = createTauriBackend();
    const openedResult = await backend.openWorksheet("/a.eqv");
    const edited = await backend.setMath("ws1", "b", {});
    expect(edited.view.regions.map((region) => region.id)).toEqual(["a", "b"]);
    expect(edited.view.regions[0]).toBe(openedResult.view.regions[0]);
    expect(edited.view.regions[1]).toBe(changed);
    expect(edited.regions[0]).toBe(openedResult.regions[0]);
    expect(edited.view.can_undo).toBe(true);
    expect(edited.label).toBe("Edit math");
    // No snapshot was needed.
    expect(invoke.mock.calls.map((call) => call[0])).toEqual(["open_worksheet", "set_math"]);
  });

  it("asks for the whole state when the delta does not apply to the stored revision", async () => {
    const worksheet = opened();
    const snapshot = {
      revision: 9,
      view: view([math("a"), math("b", "b := 3")]),
      regions: [entry("a", 1), entry("b", 3)],
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "open_worksheet") return worksheet;
      // A delta the frontend missed a step before: it applies to revision 8, not to 0.
      if (command === "set_math") return delta(8, { regions: [math("b", "b := 3")] });
      if (command === "worksheet_snapshot") return snapshot;
      return null;
    });
    const backend = createTauriBackend();
    await backend.openWorksheet("/a.eqv");
    const edited = await backend.setMath("ws1", "b", {});
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "open_worksheet",
      "set_math",
      "worksheet_snapshot",
    ]);
    expect(edited.view).toBe(snapshot.view);
    expect(edited.regions).toBe(snapshot.regions);
    expect(edited.label).toBe("Edit math");
    // The next delta applies to the snapshot's revision.
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_math") return delta(9, { results: [entry("a", 4)] });
      return null;
    });
    const next = await backend.setMath("ws1", "a", {});
    expect(next.regions[0]).not.toBe(snapshot.regions[0]);
    expect(next.regions[1]).toBe(snapshot.regions[1]);
    expect(invoke.mock.calls.map((call) => call[0]).slice(3)).toEqual(["set_math"]);
  });

  it("counts the unsafe SVG parts of an added image next to the rebuilt result", async () => {
    const worksheet = opened();
    invoke.mockImplementation(async (command: string) => {
      if (command === "open_worksheet") return worksheet;
      if (command === "add_image") return { ...delta(0, { created: "img" }), removed_parts: 2 };
      return null;
    });
    const backend = createTauriBackend();
    const first = await backend.openWorksheet("/a.eqv");
    const added = await backend.addImage("ws1", "/pictures/p.svg", 1, 54, 72);
    expect(added.removed_parts).toBe(2);
    expect(added.created).toBe("img");
    // The regions did not change: their objects are the ones the UI already had.
    expect(added.view.regions).toHaveLength(2);
    expect(added.view.regions[0]).toBe(first.view.regions[0]);
    expect(added.view.regions[1]).toBe(first.view.regions[1]);
  });
});
