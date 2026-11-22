// The frontend half of the wire-level delta of edit results. The backend keeps what it last
// sent for each open worksheet and sends only the differences (see `EditResult` in
// `app/src-tauri/src/service.rs`); everything in the UI keeps working with the whole `EditResult`
// it always had. This rebuilds that whole result from the stored state and a delta, keeping the
// objects of the regions and result entries that did not change, so an edit changes only what
// it really changed.
//
// The rebuild also records which ids it touched (`workbench/patches.ts`), so the data the page view
// derives from the worksheet can be patched instead of rebuilt.
//
// A delta applies to the revision it names (`base`); a delta for another revision cannot be
// applied, and the caller fetches the whole state with `worksheetSnapshot` instead.

import {
  keyId,
  type DocumentView,
  type EditResult,
  type EditResultDelta,
  type OpenedWorksheet,
  type RegionEntry,
  type ViewRegion,
  type WorksheetSnapshot,
} from "./equavelaApi";
import { recordEntriesPatch, recordRegionsPatch, type EntriesPatch, type RegionsPatch } from "./workbench/patches";

/** What the frontend keeps of a worksheet: its whole view and results, and the revision they are. */
export type WorksheetState = {
  revision: number;
  view: DocumentView;
  regions: RegionEntry[];
};

/** A rebuilt edit result and the state the next delta applies to. */
export type RebuiltEdit = {
  result: EditResult;
  state: WorksheetState;
};

/** The state a command that returns a whole worksheet leaves behind (open, new, import, save as). */
export function stateFromOpened(opened: OpenedWorksheet): WorksheetState {
  return { revision: opened.revision, view: opened.view, regions: opened.regions };
}

/** The state of a snapshot, for a frontend that could not apply a delta. */
export function stateFromSnapshot(snapshot: WorksheetSnapshot): WorksheetState {
  return { revision: snapshot.revision, view: snapshot.view, regions: snapshot.regions };
}

/** Up to this many changes are found by scanning; more get a map of positions built once. */
const SCAN_LIMIT = 4;

/**
 * Where the item with a given id sits in `items` (-1 when it is not there). A handful of ids are found
 * by a scan each; more share one map of every position, so a delta that names many ids (a commit marks
 * every dependent result stale) stays O(N) instead of O(changes × N).
 */
function positionsIn<T>(items: readonly T[], count: number, key: (item: T) => string): (id: string) => number {
  if (count <= SCAN_LIMIT) {
    return (id) => {
      for (let i = 0; i < items.length; i++) if (key(items[i]) === id) return i;
      return -1;
    };
  }
  const at = new Map<string, number>();
  for (let i = 0; i < items.length; i++) at.set(key(items[i]), i);
  return (id) => at.get(id) ?? -1;
}

/** The regions of `before` with the delta applied, and what that changed. */
function rebuildRegions(before: readonly ViewRegion[], delta: EditResultDelta): { regions: ViewRegion[]; patch: RegionsPatch } {
  const changed: string[] = [];
  const added: string[] = [];
  const updated = new Map(delta.regions.map((region) => [region.id, region]));
  if (delta.order) {
    // A reordered worksheet has to be walked whole: the delta gives the new order.
    const known = new Map(before.map((region) => [region.id, region]));
    const regions = delta.order.map((id) => {
      const region = updated.get(id) ?? known.get(id);
      if (!region) throw new Error(`the delta names the unknown region \`${id}\``);
      return region;
    });
    for (const id of updated.keys()) (known.has(id) ? changed : added).push(id);
    return { regions, patch: { base: before, changed, added, removed: delta.removed, reordered: true } };
  }
  // The same regions in the same order, with the changed ones replaced: one copy of the array and a
  // lookup per change, not a pass over the whole worksheet for every edit.
  const regions = before.slice();
  const positionOf = positionsIn(before, updated.size, (item) => item.id);
  for (const region of updated.values()) {
    const at = positionOf(region.id);
    if (at < 0) {
      added.push(region.id);
      regions.push(region);
    } else {
      changed.push(region.id);
      regions[at] = region;
    }
  }
  if (delta.removed.length > 0) {
    const gone = new Set(delta.removed);
    for (let i = regions.length - 1; i >= 0; i--) if (gone.has(regions[i].id)) regions.splice(i, 1);
  }
  return { regions, patch: { base: before, changed, added, removed: delta.removed, reordered: false } };
}

/** The result entries, rebuilt like the regions (they are matched by `keyId`). */
function rebuildEntries(before: readonly RegionEntry[], delta: EditResultDelta): { entries: RegionEntry[]; patch: EntriesPatch } {
  const changed: string[] = [];
  const added: string[] = [];
  const updated = new Map(delta.results.map((entry) => [keyId(entry.key), entry]));
  if (delta.results_order) {
    const known = new Map(before.map((entry) => [keyId(entry.key), entry]));
    const entries = delta.results_order.map((id) => {
      const entry = updated.get(id) ?? known.get(id);
      if (!entry) throw new Error(`the delta names the unknown result \`${id}\``);
      return entry;
    });
    for (const id of updated.keys()) (known.has(id) ? changed : added).push(id);
    return { entries, patch: { base: before, changed, added, removed: delta.removed_results, reordered: true } };
  }
  const entries = before.slice();
  const positionOf = positionsIn(before, updated.size, (item) => keyId(item.key));
  for (const entry of updated.values()) {
    const at = positionOf(keyId(entry.key));
    if (at < 0) {
      added.push(keyId(entry.key));
      entries.push(entry);
    } else {
      changed.push(keyId(entry.key));
      entries[at] = entry;
    }
  }
  if (delta.removed_results.length > 0) {
    const gone = new Set(delta.removed_results);
    for (let i = entries.length - 1; i >= 0; i--) if (gone.has(keyId(entries[i].key))) entries.splice(i, 1);
  }
  return { entries, patch: { base: before, changed, added, removed: delta.removed_results, reordered: false } };
}

/**
 * The whole edit result a delta stands for, and the state to apply the next delta to. Regions,
 * result entries, the page setup, the settings and the document keep their objects when the
 * delta did not change them; the arrays recorded in `workbench/patches.ts` say which ids the edit
 * touched, for the data the page view derives from them.
 */
export function applyEditDelta(state: WorksheetState, delta: EditResultDelta): RebuiltEdit {
  if (delta.base !== state.revision) {
    throw new Error(`the delta applies to revision ${delta.base}, not ${state.revision}`);
  }
  const { regions, patch: regionsPatch } = rebuildRegions(state.view.regions, delta);
  const { entries, patch: entriesPatch } = rebuildEntries(state.regions, delta);
  recordRegionsPatch(regions, regionsPatch);
  recordEntriesPatch(entries, entriesPatch);
  const before = state.view;
  const view: DocumentView = {
    document: delta.document ?? before.document,
    page: delta.page ?? before.page,
    settings: delta.settings ?? before.settings,
    page_breaks: delta.page_breaks ?? before.page_breaks,
    regions,
    can_undo: delta.can_undo,
    can_redo: delta.can_redo,
    undo_label: delta.undo_label,
    redo_label: delta.redo_label,
    trusted: delta.trusted ?? before.trusted,
  };
  const result: EditResult = {
    view,
    regions: entries,
    created: delta.created,
    calc_needed: delta.calc_needed,
    label: delta.label,
    diagnostics: delta.diagnostics,
  };
  return { result, state: { revision: delta.revision, view, regions: entries } };
}
