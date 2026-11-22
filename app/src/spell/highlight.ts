// The red wavy line under a misspelt word. The words are
// marked with the CSS Custom Highlight API: ranges painted over the text, so the DOM, the layout and the
// print never change (WYSIWYG: the PDF is the same with the checker on or off). Only the prose of text
// regions is read; inline math, math regions, Julia blocks, names and strings are never checked.

import type { SpellCache } from "./checker";
import { tokenize } from "./tokenize";

export const HIGHLIGHT_NAME = "mm-spelling";

/** A misspelt word in the DOM. */
export type Misspelt = { node: Text; start: number; end: number; word: string; regionId: string; language: string };

/** What the checker needs to know of the worksheet. */
export type SpellContext = {
  cache: SpellCache;
  /** The language of a text region: its own or the worksheet's. */
  languageOf: (regionId: string) => string;
  /** The words the worksheet ignores. */
  ignore: ReadonlySet<string>;
};

/** Text regions of the page: the region itself, not its continuation on the next page or a probe. */
function textRegions(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-region-id][data-kind="text"]')];
}

const SKIP = ".tx-math, .tx-math-host, .math, [data-no-spell]";

/** The text nodes of a region's prose, in reading order. */
export function proseNodes(region: HTMLElement): Text[] {
  const walker = region.ownerDocument.createTreeWalker(region, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** Every misspelt word under `root` that the cache already knows; unknown words are asked for. */
export function misspeltWords(root: ParentNode, context: SpellContext): Misspelt[] {
  const found: Misspelt[] = [];
  for (const region of textRegions(root)) {
    const regionId = region.dataset.regionId!;
    const language = context.languageOf(regionId);
    for (const node of proseNodes(region)) {
      for (const token of tokenize(node.data)) {
        if (context.ignore.has(token.word)) continue;
        if (context.cache.status(language, token.word) === false) {
          found.push({ node, start: token.start, end: token.end, word: token.word, regionId, language });
        }
      }
    }
  }
  return found;
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

/** Paints the words (or clears the marks with an empty list). A webview without the API shows none. */
export function paint(words: readonly Misspelt[]): void {
  const highlights = registry();
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!highlights) return;
  if (words.length === 0 || !HighlightClass) {
    highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  const ranges = words.map((word) => {
    const range = word.node.ownerDocument.createRange();
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
    return range;
  });
  highlights.set(HIGHLIGHT_NAME, new HighlightClass(...ranges));
}

/** The text position under a point of the window, or null. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** The misspelt word under a point, or null. */
export function misspeltAt(x: number, y: number, words: readonly Misspelt[]): Misspelt | null {
  const caret = caretAt(x, y);
  if (!caret) return null;
  return words.find((word) => word.node === caret.node && word.start <= caret.offset && caret.offset <= word.end) ?? null;
}

/**
 * Which occurrence of the word, counted in the region's prose before it, a misspelt word is: the
 * view draws the text runs in their stored order, one text node per run, so the k-th whole-word
 * occurrence in the DOM is the k-th in the stored text.
 */
export function occurrenceOf(word: Misspelt, region: HTMLElement): number {
  let index = 0;
  for (const node of proseNodes(region)) {
    for (const token of tokenize(node.data)) {
      if (node === word.node && token.start === word.start) return index;
      if (token.word === word.word) index += 1;
    }
  }
  return index;
}
