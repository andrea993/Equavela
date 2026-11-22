// What a hovered or Ctrl+clicked name stands for.

import { builtinEntry, type BuiltinEntry } from "../catalog/builtins";
import type { DefinitionInfo, Inspection, RegionKey, WireFloat } from "../equavelaApi";
import { UNIT_NAMES } from "../math/units";
import { definitionIn, definitionOf, referenceAt } from "./inspection";

export type NameInfo =
  | { kind: "definition"; definition: DefinitionInfo; /** The hovered name is the definition itself. */ own: boolean }
  | { kind: "unit"; name: string }
  | { kind: "constant"; name: string; value?: WireFloat }
  | { kind: "system"; name: string }
  | { kind: "builtin"; name: string; entry: BuiltinEntry }
  | { kind: "undefined"; name: string };

/**
 * Resolves the name at `start`..`end` of a region: its definition (the one the kernel
 * evaluates, from the backend's references), or the target of the region's own definition, or a
 * unit, a built-in function, or nothing.
 *
 * `label` is the label the name is **drawn** with (`data-label` of the sheet): only a name drawn as a
 * unit is one, because a plain name of the unit table is a name in a value position
 * . Without it the card never says "unit".
 */
export function describeName(
  inspection: Inspection,
  key: RegionKey,
  name: string,
  start: number,
  end: number,
  label?: string,
): NameInfo {
  const reference = referenceAt(inspection, key, start, end);
  if (reference) {
    const definition = definitionOf(inspection, reference);
    if (definition) return { kind: "definition", definition, own: false };
  }
  const own = definitionIn(inspection, key, name);
  if (own && !reference) return { kind: "definition", definition: own, own: true };
  if (label === "unit") return { kind: UNIT_NAMES.has(name) ? "unit" : "undefined", name };
  const source = reference?.intrinsic;
  if (source?.kind === "constant") return { kind: "constant", name, value: source.value };
  if (source?.kind === "system") return { kind: "system", name };
  const entry = !reference || source?.kind === "builtin" ? builtinEntry(name) : undefined;
  if (entry) return { kind: "builtin", name, entry };
  return { kind: "undefined", name };
}

/** Parses a `data-span` attribute (`start-end`). */
export function parseSpan(text: string | undefined | null): { start: number; end: number } | null {
  const match = /^(\d+)-(\d+)$/.exec(text ?? "");
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}
