// The backend sends an edit as a delta and the Tauri backend rebuilds the whole view and results
// list from it, keeping the objects of what did not change (see `editDelta.ts`). This reducer is the
// last line of defence for the cases the rebuild cannot keep identical: a result that arrived as a
// `region_updated` event and comes back in a delta as an equal copy, and the browser mock, which still
// returns whole results. It keeps the previous object of everything that equals what came before, so an
// edit renders only the regions it really changed.

import { keyId, type RegionEntry, type ViewRegion } from "../equavelaApi";

/** Structural equality of JSON-like values (what the backend sends). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** How many differing items the aligned fast path compares in depth before it gives up. */
const ALIGNED_LIMIT = 64;

/**
 * `next`, with every element that equals the element of `previous` with the same key replaced by that
 * previous object; `previous` itself when nothing changed (same keys, same order, same values).
 *
 * An edit gives the same array with a few objects replaced, so the common case is a cheap pass: the
 * arrays line up one for one and only a handful of positions differ, and only those are compared in
 * depth.
 */
function reuse<T>(previous: readonly T[], next: T[], key: (item: T) => string): T[] {
  if (previous.length === next.length) {
    let changed: number[] | null = null;
    let aligned = true;
    for (let i = 0; i < next.length; i++) {
      if (previous[i] === next[i]) continue;
      if (key(previous[i]) !== key(next[i]) || (changed?.length ?? 0) >= ALIGNED_LIMIT) {
        aligned = false;
        break;
      }
      (changed ??= []).push(i);
    }
    if (aligned) {
      if (changed === null) return previous as T[];
      let out: T[] | null = null;
      for (const index of changed) {
        if (!sameValue(previous[index], next[index])) continue;
        out ??= next.slice();
        out[index] = previous[index];
      }
      if (out === null) return next;
      // Every new object equals the one it replaces: the array itself is what nothing changed in.
      for (let i = 0; i < out.length; i++) if (out[i] !== previous[i]) return out;
      return previous as T[];
    }
  }
  const old = new Map<string, T>();
  for (const item of previous) old.set(key(item), item);
  let unchanged = previous.length === next.length;
  const out = next.map((item, index) => {
    const before = old.get(key(item));
    const kept = before !== undefined && sameValue(before, item) ? before : item;
    if (kept !== previous[index]) unchanged = false;
    return kept;
  });
  return unchanged ? (previous as T[]) : out;
}

export const reuseRegions = (previous: readonly ViewRegion[], next: ViewRegion[]): ViewRegion[] =>
  reuse(previous, next, (region) => region.id);

export const reuseEntries = (previous: readonly RegionEntry[], next: RegionEntry[]): RegionEntry[] =>
  reuse(previous, next, (entry) => keyId(entry.key));
