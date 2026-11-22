// What the side panel, the hover card and Ctrl+click know about the names of a worksheet: pure
// helpers over the backend's `Inspection` (core/src/session/inspect.rs) and the hook that keeps it
// current for the active document.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Backend } from "../backend";
import type {
  DefinitionInfo,
  DefinitionValue,
  Inspection,
  ReferenceInfo,
  RegionKey,
  WarningInfo,
} from "../equavelaApi";
import type { DocState } from "../workbench/useWorkbench";

export const sameKey = (a: RegionKey | null | undefined, b: RegionKey | null | undefined): boolean =>
  !!a && !!b && a.document === b.document && a.region_id === b.region_id && a.instance === b.instance;

export const valueId = (definition: { name: string; version: number }): string =>
  `${definition.name}#${definition.version}`;

/** The file name of a document id (a path). */
export function fileName(document: string): string {
  return document.split(/[\\/]/).pop() ?? document;
}

/** Evaluation rank of a region instance (smaller is earlier), if it is part of the evaluation. */
export function rankOf(inspection: Inspection, key: RegionKey): number | undefined {
  return inspection.ranks.find(([k]) => sameKey(k, key))?.[1];
}

/**
 * The names a region sees: for every name its latest definition at or above the region in
 * evaluation order, plus every global (`≡`) definition. Without a region, the latest of everything.
 * The region's own definition counts (a cursor on `x := 1` sees `x`). Sorted by rank.
 */
export function definitionsAt(inspection: Inspection, cursor: RegionKey | null): DefinitionInfo[] {
  const limit = cursor ? rankOf(inspection, cursor) : undefined;
  const latest = new Map<string, DefinitionInfo>();
  for (const definition of inspection.definitions) {
    if (limit !== undefined && definition.rank > limit && !definition.global) continue;
    const id = `${definition.label === "fn" ? "fn" : "var"}:${definition.name}`;
    const current = latest.get(id);
    if (!current || definition.version > current.version) latest.set(id, definition);
  }
  return [...latest.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/** The reference recorded for a node of a region (the `data-span` of its element). */
export function referenceAt(
  inspection: Inspection,
  key: RegionKey,
  start: number,
  end: number,
): ReferenceInfo | undefined {
  return inspection.references.find((r) => r.start === start && r.end === end && sameKey(r.key, key));
}

/** The definition a reference resolves to. */
export function definitionOf(inspection: Inspection, reference: ReferenceInfo): DefinitionInfo | undefined {
  if (!reference.definition) return undefined;
  return inspection.definitions.find(
    (d) =>
      sameKey(d.key, reference.definition) && d.name === (reference.definition_name ?? reference.name) && d.version === reference.version,
  );
}

/** The definition a region makes under `name` (hovering the target of `x := …`). */
export function definitionIn(inspection: Inspection, key: RegionKey, name: string): DefinitionInfo | undefined {
  return inspection.definitions.find((d) => sameKey(d.key, key) && d.name === name);
}

export function warningsOf(inspection: Inspection | null, key: RegionKey): WarningInfo[] {
  return inspection ? inspection.warnings.filter((w) => sameKey(w.key, key)) : [];
}

/** The (name, version) pairs of the variable definitions among `definitions`. */
export function variablesOf(definitions: DefinitionInfo[]): { name: string; version: number }[] {
  return definitions.filter((d) => d.label === "var").map((d) => ({ name: d.name, version: d.version }));
}

export type InspectionState = {
  /**
   * The full inspection: present only while something wants it (`want`) or until the next change
   * of the view. Consumers that need it for a one-off question use `ensure` instead.
   */
  inspection: Inspection | null;
  /** The unit warnings of the document: fetched after every change of the view, always current. */
  warnings: readonly WarningInfo[];
  /** Peeked values by `valueId`. */
  values: ReadonlyMap<string, DefinitionValue>;
  /** Asks the kernel for the values that are not known yet (batched); a busy kernel is retried later. */
  ensureValues: (wanted: { name: string; version: number }[]) => void;
  /**
   * Says whether the full inspection is wanted (the side panel shows its names, includes and
   * ranks). While wanted it is fetched after every change of the view, as the warnings are; when
   * it stops being wanted it is dropped, so a stale one is never shown.
   */
  want: (wanted: boolean) => void;
  /**
   * The full inspection now, for one-off needs (a hover card, a Ctrl+click, an include row):
   * the one already wanted, the one fetched for the current view, or a fresh one. `null` when it
   * cannot be had right now (no document, a calculation running, a backend problem).
   */
  ensure: () => Promise<Inspection | null>;
};

/**
 * The unit warnings of the active document, fetched after every edit and once a calculation has
 * finished (the session answers `busy` while it runs), and its full inspection — definitions,
 * references, includes and ranks — only while something shows it
 * . Values are read lazily with `ensureValues` and
 * forgotten whenever the results change.
 */
export function useInspection(backend: Backend, doc: DocState | undefined): InspectionState {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [warnings, setWarnings] = useState<readonly WarningInfo[]>([]);
  const [values, setValues] = useState<ReadonlyMap<string, DefinitionValue>>(new Map());
  const [wanted, setWanted] = useState(false);
  const id = doc?.id ?? null;
  const running = doc?.running ?? false;
  const view = doc?.view;
  const results = doc?.results;
  // The warnings and the full inspection have a token each: a newer answer of one must not discard
  // an answer of the other.
  const warningsToken = useRef(0);
  const fullToken = useRef(0);
  const asked = useRef(new Set<string>());
  /** A full inspection fetched on demand and the view it is about (nothing keeps it current). */
  const onDemand = useRef<{ view: unknown; inspection: Inspection } | null>(null);
  /** The view the inspection state was fetched for: an older one is not handed out by `ensure`. */
  const fullFor = useRef<unknown>(null);
  // What `ensure` answers from, read through a ref so that its identity stays the same (the hover
  // card and Ctrl+click depend on it).
  const latest = useRef({ id, running, view, inspection });
  useEffect(() => {
    latest.current = { id, running, view, inspection };
  });

  useEffect(() => {
    warningsToken.current++;
    fullToken.current++;
    asked.current = new Set();
    onDemand.current = null;
    fullFor.current = null;
    setInspection(null);
    setWarnings([]);
    setValues(new Map());
  }, [id]);

  // The warnings are always wanted: the sheet underlines them and the status bar counts them.
  useEffect(() => {
    if (!id || running) return;
    const mine = ++warningsToken.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      backend
        .inspectWarnings(id)
        .then((next) => {
          if (!cancelled && mine === warningsToken.current) setWarnings(next);
        })
        .catch(() => undefined);
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, id, running, view]);

  // The full inspection only while something wants it, refreshed after every change of the view.
  useEffect(() => {
    if (!id || running || !wanted) return;
    const mine = ++fullToken.current;
    let cancelled = false;
    const timer = setTimeout(() => {
      backend
        .inspect(id)
        .then((next) => {
          if (cancelled || mine !== fullToken.current) return;
          fullFor.current = view;
          setInspection(next);
        })
        .catch(() => undefined);
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backend, id, running, view, wanted]);

  // Values belong to one state of the results.
  useEffect(() => {
    if (running) return;
    asked.current = new Set();
    setValues(new Map());
  }, [results, running, view]);

  const want = useCallback((on: boolean) => {
    setWanted(on);
    if (on) return;
    // Nothing shows the inspection any more: drop it instead of keeping a stale copy around.
    fullToken.current++;
    onDemand.current = null;
    fullFor.current = null;
    setInspection(null);
  }, []);

  const ensure = useCallback(async (): Promise<Inspection | null> => {
    const current = latest.current;
    if (!current.id || current.running) return null;
    // The one something wants, as long as it is about this view (it is at most one debounce old,
    // which is how fresh it always was).
    if (current.inspection && fullFor.current === current.view) return current.inspection;
    const cached = onDemand.current;
    if (cached && cached.view === current.view) return cached.inspection;
    try {
      const next = await backend.inspect(current.id);
      // The document or its view changed while the answer was on its way: it describes another
      // worksheet, or another state of this one.
      if (latest.current.id !== current.id || latest.current.view !== current.view) return null;
      onDemand.current = { view: current.view, inspection: next };
      return next;
    } catch {
      // busy, or a backend problem: the caller shows nothing
      return null;
    }
  }, [backend]);

  const ensureValues = useCallback(
    (wanted: { name: string; version: number }[]) => {
      if (!id || running) return;
      const fresh = wanted.filter((w) => !asked.current.has(valueId(w)));
      if (fresh.length === 0) return;
      for (const w of fresh) asked.current.add(valueId(w));
      void backend
        .definitionValues(id, fresh)
        .then((got) => {
          setValues((previous) => {
            const next = new Map(previous);
            for (const value of got) next.set(valueId(value), value);
            return next;
          });
        })
        .catch(() => {
          // busy or a kernel problem: ask again next time
          for (const w of fresh) asked.current.delete(valueId(w));
        });
    },
    [backend, id, running],
  );

  return { inspection, warnings, values, ensureValues, want, ensure };
}

/**
 * The names each include region of the root worksheet brings in
 * : its exported definitions and, transitively, those of the worksheets it includes, by the id of
 * the include region in the root worksheet.
 */
export function includedNamesByRegion(inspection: Inspection): Map<string, string[]> {
  const rootRegionOf = new Map<string, string>();
  const names = new Map<string, Set<string>>();
  // Parents come before their children in the include tree; repeat until every include is placed.
  let pending = [...inspection.includes];
  while (pending.length > 0) {
    const next = pending.filter((include) => {
      const region = include.parent === inspection.root ? include.region_id : rootRegionOf.get(include.parent);
      if (region === undefined) return true;
      rootRegionOf.set(include.document, region);
      const set = names.get(region) ?? new Set<string>();
      for (const definition of include.exports) set.add(definition.name);
      names.set(region, set);
      return false;
    });
    if (next.length === pending.length) break;
    pending = next;
  }
  return new Map([...names].map(([region, set]) => [region, [...set]]));
}
