// Tab completion of the REPL input: what a Tab key press does with the text and
// the kernel's candidates. The kernel counts characters (code points); the DOM counts UTF-16 units.

export type Completion = { items: string[]; from: number; to: number };

export type TabOutcome =
  | { kind: "none" }
  /** The text with the completion in it and where the caret goes (UTF-16 offset). */
  | { kind: "edit"; text: string; caret: number }
  /** Several candidates: the pick list, and the range (characters) they replace. */
  | { kind: "list"; items: string[]; from: number; to: number };

/** The number of characters (code points) of `text` before the UTF-16 offset `offset`. */
export const charactersBefore = (text: string, offset: number) => Array.from(text.slice(0, offset)).length;

/** the caret is after only blanks on its line (or at its start): Tab indents. */
export function indents(text: string, caret: number): boolean {
  const line = text.slice(0, caret).split("\n").pop() ?? "";
  return /^[ \t]*$/.test(line);
}

export const INDENT = "    ";

/** The longest common prefix of `items`, by characters. */
export function commonPrefix(items: string[]): string {
  const first = Array.from(items[0] ?? "");
  let length = first.length;
  for (const item of items.slice(1)) {
    const other = Array.from(item);
    let at = 0;
    while (at < length && at < other.length && other[at] === first[at]) at++;
    length = at;
  }
  return first.slice(0, length).join("");
}

/** Replaces the characters `from` to `to` of `text` by `insert`; the caret goes after it. */
export function replaceCharacters(text: string, from: number, to: number, insert: string): { text: string; caret: number } {
  const characters = Array.from(text);
  const head = characters.slice(0, from).join("");
  return { text: head + insert + characters.slice(to).join(""), caret: head.length + insert.length };
}

/**
 * : one candidate completes at once; several complete their longest common prefix when that is
 * longer than what is typed, and otherwise become a pick list.
 */
export function afterTab(text: string, completion: Completion): TabOutcome {
  const { items, from, to } = completion;
  if (items.length === 0) return { kind: "none" };
  const typed = Array.from(text).slice(from, to).join("");
  if (items.length === 1) {
    if (items[0] === typed) return { kind: "none" };
    return { kind: "edit", ...replaceCharacters(text, from, to, items[0]) };
  }
  const prefix = commonPrefix(items);
  if (Array.from(prefix).length > Array.from(typed).length) {
    return { kind: "edit", ...replaceCharacters(text, from, to, prefix) };
  }
  return { kind: "list", items, from, to };
}
