// The occurrences of the Find query on the sheet. They are marked with the CSS
// Custom Highlight API over the text each region already draws, as spelling is (spell/highlight.ts): no
// element is added, the layout never moves and nothing reaches the print or the PDF.

export const FIND_MATCH = "mm-find-match";
export const FIND_CURRENT = "mm-find-current";

/** What a region draws that Find never searches: a math region's result and its screen-only notes. */
const SKIP = ".result, .result-matrix-wrap, .region-note, .no-print";

function drawnText(region: HTMLElement): Text[] {
  const walker = region.ownerDocument.createTreeWalker(region, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/** Every occurrence of `query` in the text a region draws, case-insensitively; one may span nodes. */
export function occurrences(region: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const nodes = drawnText(region);
  const starts: number[] = [];
  let text = "";
  for (const node of nodes) {
    starts.push(text.length);
    text += node.data;
  }
  const haystack = text.toLowerCase();
  // The node holding the character at `offset` of the joined text, and the offset inside it.
  const at = (offset: number, end: boolean): [Text, number] => {
    let i = nodes.length - 1;
    while (i > 0 && (end ? starts[i] >= offset : starts[i] > offset)) i -= 1;
    return [nodes[i], offset - starts[i]];
  };
  const ranges: Range[] = [];
  for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
    const range = region.ownerDocument.createRange();
    range.setStart(...at(from, false));
    range.setEnd(...at(from + needle.length, true));
    ranges.push(range);
  }
  return ranges;
}

/** Scrolls the worksheet so that `range` is in view, a third of the way down, when it is not. */
export function revealRange(range: Range): void {
  const area = range.startContainer.parentElement?.closest<HTMLElement>(".worksheet-area");
  if (!area || typeof range.getBoundingClientRect !== "function") return;
  const box = range.getBoundingClientRect();
  const view = area.getBoundingClientRect();
  if (box.top < view.top || box.bottom > view.bottom) area.scrollTop += box.top - view.top - view.height / 3;
  if (box.left < view.left || box.right > view.right) area.scrollLeft += box.left - view.left - view.width / 3;
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };

function paintRanges(registry: HighlightRegistry, name: string, ranges: Range[]): void {
  const HighlightClass = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (ranges.length === 0 || !HighlightClass) registry.delete(name);
  else registry.set(name, new HighlightClass(...ranges));
}

/**
 * Paints the occurrences of `query` in the matching regions under `root`, those of `current` apart,
 * and returns the latter. A null query clears the marks. A webview without the API shows none.
 */
export function paintFind(root: ParentNode, matches: readonly string[], current: string | null, query: string | null): Range[] {
  const registry = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const others: Range[] = [];
  const mine: Range[] = [];
  if (query) {
    for (const id of matches) {
      const region = root.querySelector<HTMLElement>(`[data-region-id="${CSS.escape(id)}"]`);
      if (region) (id === current ? mine : others).push(...occurrences(region, query));
    }
  }
  if (registry) {
    paintRanges(registry, FIND_MATCH, others);
    paintRanges(registry, FIND_CURRENT, mine);
  }
  return mine;
}
