// What an edit changed, for the derived data the page view keeps about a worksheet.
//
// An edit rebuilds the regions and the results from a delta (`editDelta.ts`), keeping the objects of
// everything that did not change. This module remembers which ids the rebuild really touched, keyed by
// the array it produced, so the derived data (the sheet index, the entries of the page view) can be
// patched in place instead of being rebuilt from the whole worksheet. An array without a patch is one
// that nobody knows the edit of: whoever derives from it starts over, which is always correct.

import type { RegionEntry, ViewRegion } from "../equavelaApi";

/** The regions an edit produced, and what it changed. */
export type RegionsPatch = {
  /** The array the new one was rebuilt from. */
  base: readonly ViewRegion[];
  /** Ids whose region object changed (the id is in both arrays). */
  changed: readonly string[];
  added: readonly string[];
  removed: readonly string[];
  /** The array was rebuilt in another order: only a whole pass can use it. */
  reordered: boolean;
};

/** The result entries an edit produced, and what it changed (matched by `keyId`). */
export type EntriesPatch = {
  base: readonly RegionEntry[];
  changed: readonly string[];
  added: readonly string[];
  removed: readonly string[];
  reordered: boolean;
};

const regionPatches = new WeakMap<readonly ViewRegion[], RegionsPatch>();
const entryPatches = new WeakMap<readonly RegionEntry[], EntriesPatch>();

export function recordRegionsPatch(regions: readonly ViewRegion[], patch: RegionsPatch): void {
  regionPatches.set(regions, patch);
}

export function regionsPatchOf(regions: readonly ViewRegion[]): RegionsPatch | undefined {
  return regionPatches.get(regions);
}

export function recordEntriesPatch(entries: readonly RegionEntry[], patch: EntriesPatch): void {
  entryPatches.set(entries, patch);
}

export function entriesPatchOf(entries: readonly RegionEntry[]): EntriesPatch | undefined {
  return entryPatches.get(entries);
}

/**
 * Hands the patch of `from` to `to`, the array the reducer made of it (it keeps unchanged objects but
 * may replace an equal copy with the previous one). Nothing to do when they are the same array.
 */
export function inheritRegionsPatch(from: readonly ViewRegion[], to: readonly ViewRegion[]): void {
  if (from === to) return;
  const patch = regionPatches.get(from);
  if (patch) regionPatches.set(to, patch);
}

export function inheritEntriesPatch(from: readonly RegionEntry[], to: readonly RegionEntry[]): void {
  if (from === to) return;
  const patch = entryPatches.get(from);
  if (patch) entryPatches.set(to, patch);
}
