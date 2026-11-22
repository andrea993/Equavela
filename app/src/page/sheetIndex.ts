// The worksheet data the page view derives from the regions, kept across edits.
//
// Rebuilding these on every edit was the bulk of the render after a committed edit: a map of every
// region, the ids hidden by collapsed areas, the drawn positions of the reflow
// and a result format per region.
//
// The index of a regions array is built once and then *patched* with what the edit changed. The delta
// already says which regions it rewrote (`workbench/patches.ts`), so the work of an edit follows the
// regions it touched, not the size of the worksheet. An array nobody knows the edit of (a snapshot, a
// browser mock that sends whole results) starts over, which is always correct.

import { drawnYOf, hiddenIds } from "../layout/areas";
import {
  formatFromSettings,
  parseTableSize,
  RESULT_TABLE_SIZE_KEY,
  type ResultFormat,
} from "../results/format";
import type { PageSetup, ViewRegion } from "../equavelaApi";
import { regionsPatchOf, type RegionsPatch } from "../workbench/patches";

/** A region's own result format, applied over the worksheet settings. */
export type RegionFormat = ResultFormat;

export type SheetIndex = {
  /** The regions this index describes. */
  readonly regions: readonly ViewRegion[];
  /** The settings the formats were computed with. */
  readonly settings: Record<string, string> | undefined;
  /** The page setup the drawn positions were computed with. */
  readonly setup: PageSetup;
  /** id → region, patched like the regions themselves. */
  readonly byId: ReadonlyMap<string, ViewRegion>;
  /** The ids that are not drawn: the members of collapsed areas. Same object while unchanged. */
  readonly hidden: ReadonlySet<string>;
  /** The drawn y of a stored position. Same function while no area and no position changed. */
  readonly drawnY: (page: number, y: number) => number;
  /** The regions that set their own result format, by id. Same map while unchanged. */
  readonly formats: ReadonlyMap<string, RegionFormat>;
  /**
   * The ids the edit that produced these regions added or changed, or null when the index was built
   * from scratch (nothing says what changed, so a reader that tracks per region state must look at
   * everything).
   */
  readonly changed: readonly string[] | null;
  /**
   * A new value whenever a region may be laid out somewhere else (added, removed, moved, resized,
   * recollapsed): work that only depends on the drawn positions and sizes can skip itself while it
   * does not change. Unique across indexes, so an index built from scratch never looks like its
   * predecessor.
   */
  readonly geometry: number;
};

const INDEXES = new WeakMap<readonly ViewRegion[], SheetIndex>();

/** Counts layouts: every value is new, so a rebuild never compares equal to the index it replaces. */
let layouts = 0;
const nextLayout = (): number => ++layouts;

/**
 * What the page view lays a region out with: where it is and the size it is estimated with before the
 * measuring layer has measured it. Two shapes that are equal mean the region is drawn as before.
 */
function layoutShape(region: ViewRegion): string {
  const base = `${region.page}:${region.x}:${region.y}:${region.kind}`;
  switch (region.kind) {
    case "area":
      return `${base}:${region.height}:${region.collapsed}`;
    case "plot":
      return `${base}:${region.plot.size[0]}x${region.plot.size[1]}`;
    case "image":
      return `${base}:${region.size[0]}x${region.size[1]}`;
    case "text":
      return `${base}:${region.full_width ? "full" : String(region.width ?? "")}`;
    default:
      return base;
  }
}

/** The index of the regions of a worksheet, built once and patched by the following edits. */
export function sheetIndexOf(
  regions: readonly ViewRegion[],
  setup: PageSetup,
  settings?: Record<string, string>,
): SheetIndex {
  const known = INDEXES.get(regions);
  if (known && known.settings === settings && known.setup === setup) return known;
  const patch = known ? undefined : regionsPatchOf(regions);
  const previous = patch ? INDEXES.get(patch.base) : undefined;
  const index =
    known || !patch || !previous || previous.settings !== settings || previous.setup !== setup
      ? build(regions, setup, settings)
      : patched(previous, regions, setup, patch, settings);
  INDEXES.set(regions, index);
  return index;
}

const isFormatted = (region: ViewRegion | undefined): boolean =>
  region !== undefined && region.kind === "math" && region.format !== undefined;

/** The result format of a region when it sets one over the worksheet settings. */
function formatOf(region: ViewRegion, settings: Record<string, string> | undefined): RegionFormat | null {
  if (!isFormatted(region) || region.kind !== "math") return null;
  const format = formatFromSettings({ ...settings, ...region.format });
  // The box of a result table belongs to the region, not to the worksheet default: it is
  // only ever read from the region's own display override.
  format.tableSize = parseTableSize(region.format?.[RESULT_TABLE_SIZE_KEY]);
  return format;
}

function build(
  regions: readonly ViewRegion[],
  setup: PageSetup,
  settings: Record<string, string> | undefined,
): SheetIndex {
  const byId = new Map<string, ViewRegion>();
  const formats = new Map<string, RegionFormat>();
  for (const region of regions) {
    byId.set(region.id, region);
    const format = formatOf(region, settings);
    if (format) formats.set(region.id, format);
  }
  return {
    regions,
    settings,
    setup,
    byId,
    hidden: hiddenIds(regions, setup),
    drawnY: drawnYOf(regions, setup),
    formats,
    changed: null,
    geometry: nextLayout(),
  };
}

/** The index of `regions`, from the index of the array the edit rebuilt it from. */
function patched(
  previous: SheetIndex,
  regions: readonly ViewRegion[],
  setup: PageSetup,
  patch: RegionsPatch,
  settings: Record<string, string> | undefined,
): SheetIndex {
  const wanted = new Set([...patch.changed, ...patch.added]);
  const updated = new Map<string, ViewRegion>();
  if (wanted.size > 0) for (const region of regions) if (wanted.has(region.id)) updated.set(region.id, region);
  // The patch does not describe these regions: start over (a stale patch must never corrupt the index).
  if (updated.size !== wanted.size || regions.length !== patch.base.length + patch.added.length - patch.removed.length) {
    return build(regions, setup, settings);
  }

  // What the edit replaced, with the objects of both sides (the previous index is left untouched).
  const replaced: { before: ViewRegion | undefined; after: ViewRegion | undefined }[] = [];
  for (const id of patch.changed) replaced.push({ before: previous.byId.get(id), after: updated.get(id) });
  for (const id of patch.added) replaced.push({ before: undefined, after: updated.get(id) });
  for (const id of patch.removed) replaced.push({ before: previous.byId.get(id), after: undefined });

  let moved = patch.added.length > 0 || patch.removed.length > 0 || patch.reordered;
  let membership = moved;
  for (const { before, after } of replaced) {
    if (!before || !after) moved = membership = true;
    else {
      if (layoutShape(before) !== layoutShape(after)) moved = true;
      if (before.kind !== after.kind || before.page !== after.page || before.y !== after.y) membership = true;
      else if (before.kind === "area" && after.kind === "area" && (before.height !== after.height || before.collapsed !== after.collapsed)) {
        membership = true;
      }
    }
  }

  // Only a region that sets a result format (or stops setting one) touches the formats.
  let formats = previous.formats;
  if (replaced.some(({ before, after }) => isFormatted(before) || isFormatted(after))) {
    const next = new Map(previous.formats);
    for (const { before, after } of replaced) {
      const id = after?.id ?? before?.id;
      if (id === undefined) continue;
      const format = after ? formatOf(after, settings) : null;
      if (format) next.set(id, format);
      else next.delete(id);
    }
    formats = next;
  }

  const byId = new Map(previous.byId);
  for (const id of patch.removed) byId.delete(id);
  for (const region of updated.values()) byId.set(region.id, region);
  return {
    regions,
    settings,
    setup,
    byId,
    hidden: membership ? hiddenIds(regions, setup) : previous.hidden,
    drawnY: membership ? drawnYOf(regions, setup) : previous.drawnY,
    formats,
    changed: [...patch.changed, ...patch.added],
    geometry: moved ? nextLayout() : previous.geometry,
  };
}
