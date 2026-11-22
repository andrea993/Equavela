// A callback whose identity never changes but which always calls the latest function it was given. The page
// view hands its handlers to every `RegionView`; with stable identities a memoized region re-renders only
// when its own data changes, not whenever a handler's dependencies (selection, editing) change.

import { useCallback, useLayoutEffect, useRef } from "react";

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): ((...args: A) => R) | undefined;
export function useStableCallback<A extends unknown[], R>(fn: ((...args: A) => R) | undefined) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  const stable = useCallback((...args: A) => (latest.current as (...args: A) => R)(...args), []);
  // An absent handler stays absent (some props are optional and change what a region draws).
  return fn ? stable : undefined;
}
