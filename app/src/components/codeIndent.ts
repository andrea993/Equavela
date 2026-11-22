// Automatic indentation of Julia code: the
// indentation of the line Enter opens, and of a line that starts with `end` or a closing bracket.
// Pure functions on the text and its selection, shared by Julia blocks and `.jl` text tabs.

import { tokenizeJulia } from "../page/juliaCode";
import type { Edit } from "./codeEdit";

const UNIT = "    ";

/** The keywords whose construct `end` closes. */
const OPENERS = new Set([
  "function", "for", "while", "if", "begin", "let", "struct", "module", "baremodule", "macro", "quote",
  "try", "do", "abstract", "primitive",
]);
/** The keywords that continue a construct: their own line goes back, the next one goes in. */
const MIDDLES = new Set(["else", "elseif", "catch", "finally"]);
const CLOSER: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(CLOSER));

/** An open construct: a keyword or a bracket, with the indentation of the line that opened it. */
type Open = { kind: string; indent: string; line: number };

const lineStartOf = (text: string, at: number) => (at === 0 ? 0 : text.lastIndexOf("\n", at - 1) + 1);
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

/**
 * The constructs still open at `stop`, innermost last, and those that the line holding `stop`
 * closed (up to `stop`) although an earlier line opened them. Keywords count only outside
 * brackets, so `a[end]` and the `for` of a comprehension change nothing; strings and comments
 * never count.
 */
function scan(text: string, stop: number): { open: Open[]; closedEarlier: Open[] } {
  const open: Open[] = [];
  const closedEarlier: Open[] = [];
  const lastLine = text.slice(0, lineStartOf(text, stop)).split("\n").length - 1;
  let line = 0;
  let lineIndent = indentOf(text);
  let offset = 0;
  const inBracket = () => open.length > 0 && open[open.length - 1].kind in CLOSER;
  const close = () => {
    const entry = open.pop();
    if (entry && line === lastLine && entry.line < lastLine) closedEarlier.push(entry);
  };
  const newline = (at: number) => {
    line++;
    lineIndent = indentOf(text.slice(at + 1));
  };
  for (const token of tokenizeJulia(text.slice(0, stop))) {
    if (token.kind === "keyword") {
      if (token.text === "end") {
        if (!inBracket() && open.length > 0) close();
      } else if (OPENERS.has(token.text) && !inBracket()) {
        open.push({ kind: token.text, indent: lineIndent, line });
      }
    } else {
      for (let i = 0; i < token.text.length; i++) {
        const char = token.text[i];
        if (char === "\n") newline(offset + i);
        else if (token.kind !== "plain") continue;
        else if (char in CLOSER) open.push({ kind: char, indent: lineIndent, line });
        else if (CLOSERS.has(char) && CLOSER[open[open.length - 1]?.kind] === char) close();
      }
    }
    offset += token.text.length;
  }
  return { open, closedEarlier };
}

/** The first word of a line, or its first character when that is not part of a word. */
function lead(line: string): string {
  const body = line.trimStart();
  return /^[A-Za-z_]+/.exec(body)?.[0] ?? body.charAt(0);
}

/**
 * The indentation a line that starts with `end`, `else`, `elseif`, `catch`, `finally` or a closing
 * bracket takes: that of the line that opened its construct. `null` for any other line, or when
 * nothing open matches.
 */
function dedentTarget(text: string, lineStart: number): string | null {
  const line = text.slice(lineStart, text.indexOf("\n", lineStart) < 0 ? text.length : text.indexOf("\n", lineStart));
  const word = lead(line);
  if (word !== "end" && !MIDDLES.has(word) && !CLOSERS.has(word)) return null;
  const { open } = scan(text, lineStart);
  const top = open[open.length - 1];
  if (!top) return null;
  if (CLOSERS.has(word)) return CLOSER[top.kind] === word ? top.indent : null;
  return top.kind in CLOSER ? null : top.indent;
}

/** Gives the line starting at `lineStart` the indentation `indent`, keeping the caret on its text. */
function reindent(edit: Edit, lineStart: number, indent: string): Edit {
  const current = indentOf(edit.text.slice(lineStart));
  if (current === indent) return edit;
  const shift = indent.length - current.length;
  const move = (at: number) => (at <= lineStart ? at : Math.max(lineStart + indent.length, at + shift));
  return {
    text: edit.text.slice(0, lineStart) + indent + edit.text.slice(lineStart + current.length),
    start: move(edit.start),
    end: move(edit.end),
  };
}

/**
 * Enter: replaces the selection by a new line indented for what the line before it
 * opens or closes. `julia` false keeps the indentation of the line only.
 */
export function newlineIndented(edit: Edit, julia = true): Edit {
  const { text, start, end } = edit;
  const lineStart = lineStartOf(text, start);
  const before = text.slice(lineStart, start);
  const base = indentOf(before);
  // The rest of the line moves down without the spaces in front of it.
  const rest = text.slice(end);
  const restLine = rest.slice(0, rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n"));
  const trimmed = restLine.length - restLine.trimStart().length;
  const after = rest.slice(trimmed);
  if (!julia) {
    const caret = start + 1 + base.length;
    return { text: `${text.slice(0, start)}\n${base}${after}`, start: caret, end: caret };
  }
  // The line left behind keeps no spaces at its end (an all-blank line becomes empty).
  const head = text.slice(0, lineStart) + before.replace(/[ \t]+$/, "");
  const { open: opened, closedEarlier } = scan(head, head.length);
  const { open: before0 } = scan(head, lineStart);
  let indent = base;
  if (MIDDLES.has(lead(before)) || opened.length > before0.length) indent = base + UNIT;
  else if (closedEarlier.length > 0) indent = closedEarlier.reduce((least, entry) => (entry.indent.length < least.length ? entry.indent : least), closedEarlier[0].indent);
  // Between an opening bracket and its closer: the closer goes to a line of its own.
  const left = head[head.length - 1];
  const caret = head.length + 1 + indent.length;
  if (left in CLOSER && after.startsWith(CLOSER[left])) {
    return { text: `${head}\n${indent}\n${base}${after}`, start: caret, end: caret };
  }
  const next = { text: `${head}\n${indent}${after}`, start: caret, end: caret };
  // A rest that starts with `end` or a closer takes its own indentation.
  const target = dedentTarget(next.text, head.length + 1);
  return target === null ? next : reindent(next, head.length + 1, target);
}

/**
 * After typing: a line that now starts with `end`, `else`, `elseif`, `catch`, `finally` or
 * a closing bracket, with the caret at the end of that first word, moves to the indentation of the
 * line that opened its construct. Returns the edit unchanged otherwise.
 */
export function dedentTyped(edit: Edit): Edit {
  if (edit.start !== edit.end) return edit;
  const lineStart = lineStartOf(edit.text, edit.start);
  const typed = edit.text.slice(lineStart, edit.start);
  if (!/^[ \t]*(?:end|else|elseif|catch|finally|[)\]}])$/.test(typed)) return edit;
  const target = dedentTarget(edit.text, lineStart);
  return target === null ? edit : reindent(edit, lineStart, target);
}
