// Find and Replace act on the regions Find matches: a replacement
// rewrites the content of a matched region and touches nothing else of it. Math regions are
// rewritten through their linear text (the backend parses it again); text regions are rewritten
// run by run, so their formatting survives.

import type { RichText, ViewRegion } from "../equavelaApi";

/** `query` as a pattern that matches case-insensitively, the way Find compares (`String#toLowerCase`). */
const pattern = (query: string) => new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

/**
 * `text` with every occurrence of `query` replaced by `replacement`: case-insensitive like
 * Find, the replacement taken literally (no `$&` patterns), and an empty query changes nothing.
 */
export function replaceOccurrences(text: string, query: string, replacement: string): string {
  if (query === "" || text === "") return text;
  return text.replace(pattern(query), () => replacement);
}

/**
 * The runs of a text region with the query replaced inside their text; null when no run changes.
 * Formatting (bold, italic, underline, sub and superscript, size) is kept as it is, and inline math
 * runs are not touched: a replacement there would have to be math again, not text.
 */
export function replaceInParagraphs(paragraphs: RichText, query: string, replacement: string): RichText | null {
  if (query === "") return null;
  let changed = false;
  const next = paragraphs.map((paragraph) => ({
    ...paragraph,
    runs: paragraph.runs.map((run) => {
      if (run.kind !== "text") return run;
      const text = replaceOccurrences(run.text, query, replacement);
      if (text === run.text) return run;
      changed = true;
      return { ...run, text };
    }),
  }));
  return changed ? next : null;
}

/** What a replacement writes back to a region: new linear math, or new runs of a text region. */
export type RegionReplacement = { kind: "math"; text: string } | { kind: "text"; paragraphs: RichText };

/**
 * The content `region` takes after replacing the query with the replacement text; null when the
 * region cannot carry the replacement at all: no occurrence in the part of it a replacement
 * may write, or a region kind whose content is structured (include, Julia, plot, area, table).
 */
export function replacementOf(region: ViewRegion, query: string, replacement: string): RegionReplacement | null {
  if (query === "") return null;
  switch (region.kind) {
    case "math": {
      const text = replaceOccurrences(region.text, query, replacement);
      return text === region.text ? null : { kind: "math", text };
    }
    case "text": {
      const paragraphs = replaceInParagraphs(region.paragraphs, query, replacement);
      return paragraphs ? { kind: "text", paragraphs } : null;
    }
    default:
      return null;
  }
}
