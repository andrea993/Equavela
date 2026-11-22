// The region a calculation pass is evaluating now. It lives outside React
// state on purpose: a pass reports one `region_started` per region and a dispatch per region would
// render the whole worksheet each time. Only the region that is running subscribes to a
// change of its own flag, through `useSyncExternalStore`.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { RegionKey, WorksheetEvent } from "../equavelaApi";

/** A region that has been calculating for this long shows the wait symbol. */
export const BUSY_AFTER_MS = 1000;

const running = new Map<string, RegionKey>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(worksheet: string, key: RegionKey | null) {
  const current = running.get(worksheet) ?? null;
  if (current === key) return;
  if (
    current &&
    key &&
    current.document === key.document &&
    current.region_id === key.region_id &&
    current.instance === key.instance
  ) {
    return;
  }
  if (key) running.set(worksheet, key);
  else running.delete(worksheet);
  emit();
}

/** Follows the evaluation events: a region starting is the running one, any ending clears it. */
export function trackRunningRegion(event: WorksheetEvent): void {
  switch (event.event) {
    case "region_started":
      set(event.worksheet, event.key);
      break;
    case "region_updated": {
      const current = running.get(event.worksheet);
      if (current && current.document === event.entry.key.document && current.region_id === event.entry.key.region_id && current.instance === event.entry.key.instance) {
        set(event.worksheet, null);
      }
      break;
    }
    case "pass_started":
    case "pass_finished":
    case "pass_failed":
      set(event.worksheet, null);
      break;
    default:
      break;
  }
}

/** The region being evaluated in a worksheet, or null. */
export function runningRegionOf(worksheet: string): RegionKey | null {
  return running.get(worksheet) ?? null;
}

/** Forgets everything (tests). */
export function resetRunningRegions(): void {
  running.clear();
  emit();
}

/** Whether this region is being evaluated now; unchanged subscriptions do not rerender. */
export function useRegionRunning(regionId: string | undefined, document: string | undefined, instance?: number): boolean {
  return useSyncExternalStore(
    subscribe,
    () =>
      document !== undefined &&
      [...running.values()].some((key) => key.region_id === regionId && key.document === document && (instance === undefined || key.instance === instance)),
    () => false,
  );
}

/** A region that finishes within BUSY_AFTER_MS never shows the wait symbol. */
export function useRegionBusy(regionId: string, document: string | undefined): boolean {
  const isRunning = useRegionRunning(regionId, document);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isRunning) {
      setBusy(false);
      return undefined;
    }
    const timer = setTimeout(() => setBusy(true), BUSY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [isRunning]);
  return busy && isRunning;
}
