// The text operations of the Code ribbon tab, as pure functions on the
// text and its selection, so the editor, the ribbon and the command palette share them.

/** The text of an editor with its selection (`start` ≤ `end`, offsets in UTF-16 units). */
export type Edit = { text: string; start: number; end: number };

/** The offsets of the first and of the end of the last line the selection touches. A selection
 *  that ends at the start of a line does not touch that line. */
function lineRange({ text, start, end }: Edit): { from: number; to: number } {
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const stop = text.indexOf("\n", last);
  return { from, to: stop < 0 ? text.length : stop };
}

/** Replaces the touched lines by `lines`, keeping the selection on them. */
function withLines(edit: Edit, from: number, to: number, lines: string[], mapStart: number, mapEnd: number): Edit {
  const text = edit.text.slice(0, from) + lines.join("\n") + edit.text.slice(to);
  return { text, start: Math.max(from, edit.start + mapStart), end: Math.max(from, edit.end + mapEnd) };
}

/** Toggle line comment: when every non-blank touched line starts with `prefix`, it is removed;
 *  otherwise it is added at the common indentation. */
export function toggleComment(edit: Edit, prefix = "# "): Edit {
  const { from, to } = lineRange(edit);
  const lines = edit.text.slice(from, to).split("\n");
  const code = lines.filter((line) => line.trim() !== "");
  if (code.length === 0) return edit;
  const bare = prefix.trimEnd();
  const commented = code.every((line) => line.trimStart().startsWith(bare));
  if (commented) {
    let removedBefore = 0;
    let removedTotal = 0;
    const firstLength = lines[0].length;
    const out = lines.map((line, index) => {
      const at = line.indexOf(bare);
      if (line.trim() === "" || at < 0) return line;
      const width = line.startsWith(prefix, at) ? prefix.length : bare.length;
      if (index === 0) removedBefore = width;
      removedTotal += width;
      return line.slice(0, at) + line.slice(at + width);
    });
    const startShift = edit.start - from > firstLength ? -removedBefore : -Math.min(removedBefore, Math.max(0, edit.start - from));
    return withLines(edit, from, to, out, startShift, -removedTotal);
  }
  const indent = Math.min(...code.map((line) => line.length - line.trimStart().length));
  let added = 0;
  const out = lines.map((line) => {
    if (line.trim() === "") return line;
    added += prefix.length;
    return line.slice(0, indent) + prefix + line.slice(indent);
  });
  return withLines(edit, from, to, out, edit.start - from >= indent ? prefix.length : 0, added);
}

/** Indent: four spaces before every touched line. */
export function indentLines(edit: Edit): Edit {
  const { from, to } = lineRange(edit);
  const lines = edit.text.slice(from, to).split("\n");
  return withLines(edit, from, to, lines.map((line) => `    ${line}`), 4, 4 * lines.length);
}

/** Outdent: up to four leading spaces or one tab off every touched line. */
export function outdentLines(edit: Edit): Edit {
  const { from, to } = lineRange(edit);
  const lines = edit.text.slice(from, to).split("\n");
  const cuts = lines.map((line) => line.match(/^(?: {1,4}|\t)/)?.[0].length ?? 0);
  const out = lines.map((line, index) => line.slice(cuts[index]));
  const startCut = Math.min(cuts[0], Math.max(0, edit.start - from));
  return withLines(edit, from, to, out, -startCut, -cuts.reduce((a, b) => a + b, 0));
}

/** Duplicate line: the touched lines again below, selected. */
export function duplicateLines(edit: Edit): Edit {
  const { from, to } = lineRange(edit);
  const block = edit.text.slice(from, to);
  const text = edit.text.slice(0, to) + "\n" + block + edit.text.slice(to);
  const shift = block.length + 1;
  return { text, start: edit.start + shift, end: edit.end + shift };
}

/** Move line up or down: the touched lines swap with the line above or below. */
export function moveLines(edit: Edit, direction: "up" | "down"): Edit {
  const { from, to } = lineRange(edit);
  const block = edit.text.slice(from, to);
  if (direction === "up") {
    if (from === 0) return edit;
    const above = edit.text.lastIndexOf("\n", from - 2) + 1;
    const previous = edit.text.slice(above, from - 1);
    const text = edit.text.slice(0, above) + block + "\n" + previous + edit.text.slice(to);
    const shift = -(previous.length + 1);
    return { text, start: edit.start + shift, end: edit.end + shift };
  }
  if (to >= edit.text.length) return edit;
  const below = edit.text.indexOf("\n", to + 1);
  const nextEnd = below < 0 ? edit.text.length : below;
  const next = edit.text.slice(to + 1, nextEnd);
  const text = edit.text.slice(0, from) + next + "\n" + block + edit.text.slice(nextEnd);
  const shift = next.length + 1;
  return { text, start: edit.start + shift, end: edit.end + shift };
}

/** The offset where line `line` (1-based) starts, clamped to the text's lines. */
export function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) break;
    offset = next + 1;
  }
  return offset;
}

/** The next (or previous) match of `query` from the selection, wrapping around; case-sensitive. */
export function findMatch(edit: Edit, query: string, backwards = false): { start: number; end: number } | null {
  if (query === "") return null;
  const { text } = edit;
  let at: number;
  if (backwards) {
    at = edit.start > 0 ? text.lastIndexOf(query, edit.start - 1) : -1;
    if (at < 0) at = text.lastIndexOf(query);
  } else {
    at = text.indexOf(query, edit.end);
    if (at < 0) at = text.indexOf(query);
  }
  return at < 0 ? null : { start: at, end: at + query.length };
}

/** Replace: the selection, when it is a match, becomes `replacement`; then the next match is selected. */
export function replaceMatch(edit: Edit, query: string, replacement: string): Edit {
  if (query === "") return edit;
  let current = edit;
  if (edit.text.slice(edit.start, edit.end) === query) {
    const text = edit.text.slice(0, edit.start) + replacement + edit.text.slice(edit.end);
    const caret = edit.start + replacement.length;
    current = { text, start: caret, end: caret };
  }
  const next = findMatch(current, query);
  return next ? { ...current, ...next } : current;
}

/** Replace all: every match, and how many there were. */
export function replaceAll(edit: Edit, query: string, replacement: string): { edit: Edit; count: number } {
  if (query === "") return { edit, count: 0 };
  const parts = edit.text.split(query);
  const count = parts.length - 1;
  if (count === 0) return { edit, count };
  const text = parts.join(replacement);
  const caret = Math.min(edit.start, text.length);
  return { edit: { text, start: caret, end: caret }, count };
}

/** The line comment of a file, by extension; null for files without one. */
export function commentPrefix(path: string): string | null {
  return /\.(jl|toml|ya?ml)$/i.test(path) ? "# " : null;
}
