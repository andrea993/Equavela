// What the region being edited needs and no other region does: the math editor state with its
// completions, or the text editor binding. It changes on every keystroke, so it does not travel as props
// through the page view's region list; the page
// view publishes it here and only the edited region reads it, with a selector that is null for every
// other region.

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { Completion } from "../editor/autocomplete";
import type { EditorState } from "../editor/model";
import type { MathBreak } from "../equavelaApi";
import type { TextEditBinding } from "../text/value";

/**
 * Id of a region that exists only in the editor until it is committed (the page view's draft
 * region): it has no stored position and no stored identity yet, so it cannot be moved.
 */
export const DRAFT_ID = "__new";

export type RegionEdit = {
  /** The region being edited (`DRAFT_ID` for a new one). */
  regionId: string;
  editor: EditorState | null;
  /** The editor's presentation-only line breaks, in wire form. */
  breaks: MathBreak[];
  textEdit: TextEditBinding | null;
  completions: readonly Completion[];
  completionIndex: number;
  onCompletion?: (completion: Completion) => void;
};

export type RegionEditStore = {
  get(): RegionEdit | null;
  set(edit: RegionEdit | null): void;
  subscribe(listener: () => void): () => void;
};

export function createRegionEditStore(): RegionEditStore {
  let current: RegionEdit | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(edit) {
      if (edit === current) return;
      current = edit;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The store of the page view the region belongs to; none outside a page view (nothing is edited). */
export const RegionEditContext = createContext<RegionEditStore | null>(null);

const NO_STORE: RegionEditStore = createRegionEditStore();

/** The edit state of `regionId` when it is the region being edited, otherwise null (no re-render). */
export function useRegionEdit(regionId: string | null): RegionEdit | null {
  const store = useContext(RegionEditContext) ?? NO_STORE;
  const select = useCallback(() => {
    const edit = store.get();
    return edit && regionId !== null && edit.regionId === regionId ? edit : null;
  }, [store, regionId]);
  return useSyncExternalStore(store.subscribe, select, select);
}
