// The words of a piece of prose: letters with the apostrophes and hyphens
// inside a word, positions in UTF-16 units as the DOM counts them. A token with a digit (`2nd`,
// `x1`) is never checked, nor is a part of a web or e-mail address.

export type Token = { start: number; end: number; word: string };

const WORD = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const start = match.index ?? 0;
    const end = start + word.length;
    if (/\p{N}/u.test(word)) continue;
    // Addresses: a word glued to `@`, `/`, `.x` or `://` belongs to an address, not to the prose.
    const before = text[start - 1] ?? "";
    const after = text[end] ?? "";
    if (before === "@" || after === "@" || before === "/" || after === "/" || (after === "." && /\w/.test(text[end + 1] ?? ""))) continue;
    if (before === "." && /\w/.test(text[start - 2] ?? "")) continue;
    tokens.push({ start, end, word });
  }
  return tokens;
}

/** The words of the worksheet ignore list. */
export function ignoreList(value: string | undefined): Set<string> {
  return new Set((value ?? "").split(/\s+/).filter(Boolean));
}

/** The ignore list with one more word, as it is stored: sorted, one space between words. */
export function withIgnored(value: string | undefined, word: string): string {
  const words = ignoreList(value);
  words.add(word);
  return [...words].sort((a, b) => a.localeCompare(b)).join(" ");
}
