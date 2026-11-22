// Completion in `.jl` text tabs: the words the editor offers by
// itself, at once, while the project's kernel computes Julia's own completions.

/** A list of completions and the range of characters of the text they replace. */
export type Completions = { items: string[]; from: number; to: number };

const KEYWORDS = [
  "abstract type", "baremodule", "begin", "break", "catch", "const", "continue", "do", "else", "elseif",
  "end", "export", "false", "finally", "for", "function", "global", "if", "import", "let", "local",
  "macro", "module", "mutable struct", "nothing", "primitive type", "quote", "return", "struct", "true",
  "try", "using", "while",
];

/** A character of a Julia name (letters of any script, digits, `_` and `!`). */
const NAME = /[\p{L}\p{N}_!]/u;

/** The name being typed before `position`, and where it starts. */
export function wordBefore(text: string, position: number): { word: string; from: number } {
  let from = position;
  while (from > 0 && NAME.test(text[from - 1])) from--;
  return { word: text.slice(from, position), from };
}

/** Whether a completion list should open after typing `typed` at `position`. */
export function opensCompletion(text: string, position: number): boolean {
  const before = text[position - 1] ?? "";
  // A name starts with a letter or `_`: `1.` and `12` open nothing.
  const startsName = (word: string) => /^[\p{L}_]/u.test(word);
  if (before === ".") return startsName(wordBefore(text, position - 1).word);
  return NAME.test(before) && startsName(wordBefore(text, position).word);
}

/** The editor's own words: Julia keywords and the names of the file, starting with the typed name. */
export function localCompletions(text: string, position: number): Completions {
  const { word, from } = wordBefore(text, position);
  if (word === "" || text[from - 1] === ".") return { items: [], from, to: position };
  const names = new Set<string>();
  for (const match of text.matchAll(/[\p{L}_][\p{L}\p{N}_!]*/gu)) {
    const start = match.index ?? 0;
    if (start <= position && start + match[0].length >= position && start === from) continue;
    names.add(match[0]);
  }
  const items = [...new Set([...KEYWORDS, ...[...names].sort()])]
    .filter((item) => item.startsWith(word) && item !== word);
  return { items, from, to: position };
}

/** Merges the kernel's answer after the local words, without duplicates (kernel first). */
export function mergeCompletions(local: Completions, kernel: Completions | null): Completions {
  if (!kernel) return local;
  const items = [...new Set([...kernel.items, ...local.items.filter(() => kernel.from === local.from)])];
  return { items, from: kernel.from, to: kernel.to };
}
