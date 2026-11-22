// Find and Replace in math mode: the query is a typed expression and a
// match is a subexpression with the same tree, compared on the canonical (wire) form the view
// carries for math regions and inline math runs. Source spans, line breaks (`split`) and the
// parentheses the canonical form adds for precedence (`Paren`) are not compared.

import { isEmptyStatement, toWire, type Node } from "../editor/tree";
import type { RichText, ViewRegion } from "../equavelaApi";

type Json = unknown;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys that say where or how the math is drawn, not what it is. */
const PRESENTATION = new Set(["span", "split"]);

/** The canonical form without presentation: no spans or line breaks, and `Paren` unwrapped. */
export function normalizeMath(value: Json): Json {
  if (Array.isArray(value)) return value.map(normalizeMath);
  if (!isObject(value)) return value;
  if (value.type === "Paren" && "expr" in value) return normalizeMath(value.expr);
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    if (!PRESENTATION.has(key)) out[key] = normalizeMath(value[key]);
  }
  return out;
}

const keyOf = (value: Json) => JSON.stringify(normalizeMath(value));

/**
 * A test for "this subtree is the query": the node type is compared first, so the whole subtree is
 * serialised only for candidates (Find runs on every keystroke over every region).
 */
function sameAs(query: Json): (node: Record<string, unknown>) => boolean {
  const normal = normalizeMath(query);
  const key = JSON.stringify(normal);
  const type = isObject(normal) ? normal.type : undefined;
  return (node) => (node.type === type || node.type === "Paren") && keyOf(node) === key;
}

/** Whether the typed math still holds an empty placeholder: an incomplete query matches nothing. */
function hasPlaceholder(value: Json): boolean {
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (!isObject(value)) return false;
  return value.type === "Placeholder" || Object.values(value).some(hasPlaceholder);
}

/**
 * The query of a math box: the typed expression in wire form, or the whole statement when a
 * definition or an evaluation was typed; null when nothing complete was typed. It is also the form
 * a replacement is inserted in.
 */
export function mathQueryOf(tree: Node): Json | null {
  if (isEmptyStatement(tree)) return null;
  let wire: Node;
  try {
    wire = toWire(tree);
  } catch {
    return null;
  }
  const query = wire.type === "ExprRegion" ? wire.expr : wire;
  return query === undefined || hasPlaceholder(query) ? null : query;
}

/** Whether `value` has a subtree equal to `query` (both compared without presentation). */
export function containsMath(value: Json, query: Json): boolean {
  const matches = sameAs(query);
  const walk = (node: Json): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!isObject(node)) return false;
    if (matches(node)) return true;
    return Object.entries(node).some(([field, child]) => !PRESENTATION.has(field) && walk(child));
  };
  return walk(value);
}

/**
 * `value` with every subtree equal to `query` replaced by `replacement` (wire form, inserted as it
 * is), outermost first: a replaced subtree is not searched again. Null when nothing matched.
 */
export function replaceMath(value: Json, query: Json, replacement: Json): Json | null {
  const matches = sameAs(query);
  let changed = false;
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    if (matches(node)) {
      changed = true;
      return replacement;
    }
    const out: Record<string, Json> = {};
    for (const [field, child] of Object.entries(node)) out[field] = PRESENTATION.has(field) ? child : walk(child);
    return out;
  };
  const next = walk(value);
  return changed ? next : null;
}

/** Whether a region matches the math query: a math region, or a text region by its inline math. */
export function mathMatches(region: ViewRegion, query: Json): boolean {
  switch (region.kind) {
    case "math":
      return containsMath(region.statement, query);
    case "text":
      return region.paragraphs.some((paragraph) =>
        paragraph.runs.some((run) => run.kind === "math" && run.statement != null && containsMath(run.statement, query)),
      );
    default:
      return false;
  }
}

/**
 * What a math-mode replacement writes: the new canonical statement of a math region, or the
 * runs of a text region whose changed inline math still has to be printed (`changed` lists them by
 * paragraph and run index); null when the region holds no match.
 */
export type MathReplacement =
  | { kind: "math"; statement: Json }
  | { kind: "text"; paragraphs: RichText; changed: [number, number][] };

export function mathReplacementOf(region: ViewRegion, query: Json, replacement: Json): MathReplacement | null {
  if (region.kind === "math") {
    const statement = replaceMath(region.statement, query, replacement);
    return statement === null ? null : { kind: "math", statement };
  }
  if (region.kind !== "text") return null;
  const changed: [number, number][] = [];
  const paragraphs = region.paragraphs.map((paragraph, p) => ({
    ...paragraph,
    runs: paragraph.runs.map((run, r) => {
      if (run.kind !== "math" || run.statement == null) return run;
      const statement = replaceMath(run.statement, query, replacement);
      if (statement === null) return run;
      changed.push([p, r]);
      return { ...run, statement };
    }),
  }));
  return changed.length === 0 ? null : { kind: "text", paragraphs, changed };
}
