// What one committed edit costs at worksheet scale (GitHub ). Not part of the normal suite:
// run it with `PERF=1 pnpm --dir app test -- perf/edit-render.bench`.
// It loads the 20 000 region
// fixture, opens it through the real reducer, applies one edit delta with `applyEditDelta` and times
// every derivation `Workbench` and `PageView` redo for the whole worksheet, plus a real `PageView`
// re-render with the edited document.
//
// Each step is measured with its inputs already computed, the way React runs a memo chain: the step
// is the work the component does again after one edit, not the work of the steps it depends on.
//
// The fixture is 17 MB of JSON; the render after opening is measured separately from the render after
// the edit, which is the one this issue is about.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { applyEditDelta, type WorksheetState } from "../editDelta";
import { problemsOf } from "../inspect/outline";
import { pageCount, pageToSheet, reflow, sheetLayout, type FlowItem, type Size } from "../layout/geometry";
import { hiddenIds, withMembers } from "../layout/areas";
import PageView from "../page/PageView";
import { sheetIndexOf } from "../page/sheetIndex";
import { reuseEntries, reuseRegions } from "../workbench/reuse";
import { initialState, reducer, type DocState } from "../workbench/useWorkbench";
import type {
  DocumentView,
  EditResultDelta,
  OpenedWorksheet,
  PageSetup,
  RegionEntry,
  SessionDiagnostic,
  ViewRegion,
  WarningInfo,
} from "../equavelaApi";

const PERF = process.env.PERF === "1";
// vitest runs from `app/`; `import.meta.url` is an http URL inside the jsdom environment.
const FIXTURE = resolve(process.cwd(), process.env.PERF_FIXTURE ?? "perf-fixtures/large-20k.json");

type Fixture = {
  id: string;
  root: string;
  regions: RegionEntry[];
  diagnostics: SessionDiagnostic[];
  view: DocumentView;
};

const EMPTY_WARNINGS: WarningInfo[] = [];

/** The size of a region as `PageView` estimates it before the measuring layer has measured it. */
function estimatedSize(region: ViewRegion, setup: PageSetup): Size {
  const printable = setup.width - setup.margins.left - setup.margins.right;
  switch (region.kind) {
    case "plot":
      return { w: region.plot.size[0], h: region.plot.size[1] };
    case "image":
      return { w: region.size[0], h: region.size[1] };
    case "area":
      return { w: printable, h: region.collapsed ? 21 : region.height };
    case "text":
      return { w: region.full_width ? printable : (region.width ?? 240), h: 18 };
    default:
      return { w: 120, h: 24 };
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * Median of `times` runs of what `setup` returns, in milliseconds. `setup` runs untimed, so a step can
 * prepare the state it needs (a memo chain cannot be measured twice on the same objects).
 */
function measureWith(setup: () => () => void, times = 7): number {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    const run = setup();
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return Math.round(median(samples) * 100) / 100;
}

const measure = (run: () => void, times = 7): number => measureWith(() => run, times);

type Step = { name: string; ms: number };

function report(title: string, steps: Step[]): void {
  const width = Math.max(...steps.map((step) => step.name.length));
  const sum = steps.reduce((acc, step) => acc + step.ms, 0);
  console.log(
    [
      `\n${title}`,
      ...steps.map((step) => `  ${step.name.padEnd(width)}  ${step.ms.toFixed(2).padStart(7)} ms`),
      `  ${"total".padEnd(width)}  ${sum.toFixed(2).padStart(7)} ms`,
      "",
    ].join("\n"),
  );
}

/** The fixture opened as the backend returns it. */
function open(fixture: Fixture): OpenedWorksheet {
  return {
    id: fixture.id,
    root: fixture.root,
    view: fixture.view,
    regions: fixture.regions,
    diagnostics: fixture.diagnostics,
  } as OpenedWorksheet;
}

/** A delta that rewrites the text of one math region, as a committed edit of it does. */
function editDelta(fixture: Fixture, regionId: string, revision = 0): EditResultDelta {
  const region = fixture.view.regions.find((r) => r.id === regionId);
  if (!region || region.kind !== "math") throw new Error(`no math region \`${regionId}\` in the fixture`);
  const entry = fixture.regions.find((e) => e.key.region_id === regionId);
  return {
    base: revision,
    revision: revision + 1,
    regions: [{ ...region, text: `${region.text} + 0` }],
    removed: [],
    can_undo: true,
    can_redo: false,
    undo_label: "Edit",
    redo_label: null,
    results: entry ? [{ ...entry, state: "stale" } as RegionEntry] : [],
    removed_results: [],
    created: null,
    calc_needed: true,
    label: "Edit",
  };
}

// Not even registered without PERF=1: a skipped describe still runs its body when tests are
// collected, and the fixture it reads is not in the repository.
if (!PERF) describe.skip("one edit at worksheet scale (PERF=1)", () => it.skip("measures", () => undefined));
else describe("one edit at worksheet scale", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const opened = open(fixture);
  const before: WorksheetState = { revision: 0, view: fixture.view, regions: fixture.regions };

  // The window with the worksheet open, and the same after one committed edit.
  const openedState = reducer(initialState("tauri"), { type: "opened", opened });
  const rebuilt = applyEditDelta(before, editDelta(fixture, "r2"));
  const editedState = reducer(openedState, { type: "edited", id: fixture.id, result: rebuilt.result });
  const docBefore = openedState.docs[0];
  const docAfter = editedState.docs[0];
  const view = docAfter.view;
  const setup = view.page;
  const settings = view.settings;

  // The render before the edit built these: they are what the edit patches.
  const indexBefore = sheetIndexOf(docBefore.view.regions, docBefore.view.page, settings);

  it("times each step of the render after one edit", () => {
    // What React keeps across the edit and hands to the next render.
    const hidden = indexBefore.hidden;
    const shown = view.regions.filter((region) => !hidden.has(region.id));
    const items: FlowItem[] = shown.map((region) => {
      const size = region.kind === "area" ? { w: 0, h: 0 } : estimatedSize(region, setup);
      return { id: region.id, page: region.page, x: region.x, y: indexBefore.drawnY(region.page, region.y), w: size.w, h: size.h };
    });
    const flow = reflow(setup, items);
    const layout = sheetLayout(setup, Math.max(pageCount(shown, 1), ...Array.from(flow.values(), (f) => f.page)), false);
    const sizes = new Map<string, Size>(shown.map((region) => [region.id, estimatedSize(region, setup)]));

    const entriesMap = (source: DocState) => {
      const map = new Map<string, RegionEntry>();
      for (const entry of source.results) {
        if (entry.key.instance === 0 && entry.key.document === source.root) map.set(entry.key.region_id, entry);
      }
      return map;
    };

    const steps: Step[] = [
      { name: "editDelta.apply", ms: measure(() => void applyEditDelta(before, editDelta(fixture, "r2"))) },
      {
        name: "reducer.edited",
        ms: measure(() => void reducer(openedState, { type: "edited", id: fixture.id, result: rebuilt.result })),
      },
      { name: "reuse.regions", ms: measure(() => void reuseRegions(docBefore.view.regions, rebuilt.result.view.regions)) },
      { name: "reuse.entries", ms: measure(() => void reuseEntries(docBefore.results, rebuilt.result.regions)) },
      {
        // The index of the edited worksheet, patched with what the delta changed. Each sample applies a
        // fresh delta, so the index is really derived (an array's index is cached).
        name: "page.sheetIndex (patched)",
        ms: measureWith(() => {
          sheetIndexOf(docBefore.view.regions, docBefore.view.page, settings);
          const next = applyEditDelta(before, editDelta(fixture, "r2"));
          return () => void sheetIndexOf(next.state.view.regions, next.state.view.page, settings);
        }),
      },
      {
        // For reference: the same index with nothing to patch (opening a worksheet).
        name: "page.sheetIndex (from scratch)",
        ms: measureWith(() => {
          const copy = [...view.regions];
          return () => void sheetIndexOf(copy, docBefore.view.page, settings);
        }, 3),
      },
      { name: "page.shown", ms: measure(() => void view.regions.filter((region) => !hidden.has(region.id))) },
      {
        // The reflow memo of the page view: an edit that only rewrites content finds its inputs unchanged.
        name: "page.flow (nothing moved)",
        ms: measure(() => {
          const index = sheetIndexOf(view.regions, view.page, settings);
          const guard = index.geometry === indexBefore.geometry && hidden === indexBefore.hidden;
          return guard;
        }),
      },
      { name: "page.entriesMap", ms: measure(() => void entriesMap(docAfter)) },
      { name: "page.withMembers", ms: measure(() => void withMembers(view.regions, docAfter.selection, view.page)) },
      {
        name: "page.pageTotal",
        ms: measure(() => {
          const reach = (region: ViewRegion): number => {
            const placed = flow.get(region.id) ?? { page: region.page, y: region.y };
            const height = sizes.get(region.id)?.h ?? 0;
            return placed.page + Math.floor((placed.y + height) / (setup.height - setup.margins.top - setup.margins.bottom));
          };
          let total = pageCount(shown, docAfter.crosshair.page);
          for (const placed of flow.values()) if (placed.page > total) total = placed.page;
          for (const region of shown) {
            const reached = reach(region);
            if (reached > total) total = reached;
          }
          return total;
        }),
      },
      {
        name: "page.mounted",
        ms: measure(() => {
          const keep = new Set(docAfter.selection);
          const top = 0;
          const bottom = 800;
          return shown.filter((region) => {
            if (keep.has(region.id)) return true;
            const placed = flow.get(region.id) ?? { page: region.page, y: region.y };
            const at = pageToSheet(layout, placed.page, region.x, placed.y);
            return at.y + (sizes.get(region.id)?.h ?? 0) >= top && at.y <= bottom;
          });
        }),
      },
      {
        // The measuring layer: the regions the edit changed, by id, are the only ones to check.
        name: "page.probeScan",
        ms: measure(() => {
          const inWindow = new Set(shown.slice(0, 20).map((region) => region.id));
          const measured = new Set(shown.filter((region) => region.kind !== "area").map((region) => region.id));
          const index = sheetIndexOf(view.regions, view.page, settings);
          const stale: ViewRegion[] = [];
          for (const id of index.changed ?? []) {
            if (stale.length >= 40) break;
            const region = index.byId.get(id);
            if (!region || region.kind === "area" || inWindow.has(id) || measured.has(id)) continue;
            stale.push(region);
          }
          return stale;
        }),
      },
      {
        name: "workbench.problems",
        ms: measure(() => void problemsOf(docAfter.root, docAfter.results, docAfter.diagnostics, EMPTY_WARNINGS)),
      },
    ];
    report(`one edit, ${view.regions.length} regions in \`${FIXTURE.split("/").pop()}\` (median of 7 runs)`, steps);

    // The whole-worksheet passes an edit had to redo before, for the record: they now run only when
    // a region really moves (the reflow) or when a worksheet is opened (the index).
    const reference: Step[] = [
      { name: "hiddenIds (one pass per page)", ms: measure(() => void hiddenIds(view.regions, view.page)) },
      {
        name: "reflowInput + reflow (a region moved)",
        ms: measure(() => {
          const drawnYAt = indexBefore.drawnY;
          return reflow(
            setup,
            shown.map((region) => {
              const size = region.kind === "area" ? { w: 0, h: 0 } : (sizes.get(region.id) ?? estimatedSize(region, setup));
              return { id: region.id, page: region.page, x: region.x, y: drawnYAt(region.page, region.y), w: size.w, h: size.h };
            }),
          );
        }),
      },
    ];
    report("for reference", reference);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("times the render of the page view before and after the edit", () => {
    // jsdom reports no client size: give the scroll area one, so the page view virtualizes as it does
    // in the app instead of mounting all 20 000 regions.
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const size = (name: "clientWidth" | "clientHeight", value: number) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    size("clientWidth", 1200);
    size("clientHeight", 800);

    const page = (doc: DocState) => (
      <PageView
        doc={doc}
        zoom={1}
        viewMode="page"
        focus={null}
        onSelect={() => undefined}
        onMove={() => undefined}
        onCrosshair={() => undefined}
        onZoomWheel={() => undefined}
        onPageChange={() => undefined}
        warnings={EMPTY_WARNINGS}
      />
    );

    try {
      const start = performance.now();
      const rendered = render(page(docBefore));
      const openMs = performance.now() - start;
      // Going back to the document before the edit throws away every memo, so the next render after
      // the edit is the one the user waits for: it redoes the whole worksheet.
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        rendered.rerender(page(docBefore));
        const editStart = performance.now();
        rendered.rerender(page(docAfter));
        samples.push(performance.now() - editStart);
      }
      const editMs = median(samples);
      console.log(
        [
          `\npage view render, ${docAfter.view.regions.length} regions`,
          `  first render after opening  ${openMs.toFixed(2).padStart(7)} ms`,
          `  render after one edit        ${editMs.toFixed(2).padStart(7)} ms`,
          "",
        ].join("\n"),
      );
      expect(rendered.container.querySelectorAll("[data-region-id]").length).toBeLessThan(200);
    } finally {
      cleanup();
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
      if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
    }
  });
});

afterAll(cleanup);
