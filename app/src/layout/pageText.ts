// The header and footer lines of a page: the three slots, the
// tokens they may hold, the values those tokens draw on a given page and the one-line rule of.
// Everything here is pure, so the page view, the print view, the dialog and their tests
// share one definition of the arithmetic (as pageSetup.ts does for the page setup).

import type { PageLine } from "../equavelaApi";

/** The tokens a slot may hold, spelled as they are typed and stored. */
export const TOKENS = {
  page: "{page}",
  date: "{date}",
  file: "{file}",
} as const;

/** A token's name without its braces. */
export type TokenName = keyof typeof TOKENS;

/** The tokens in the order the dialog's buttons offer them. */
export const TOKEN_NAMES: readonly TokenName[] = ["page", "date", "file"];

/** What the three tokens draw on one page. */
export type PageTextValues = {
  /** The 1-based number of the page the line is drawn on. */
  page: number;
  /** The date of the drawing, `YYYY-MM-DD`. */
  date: string;
  /** The worksheet's file name; a worksheet without a file shows its untitled name. */
  file: string;
};

/** An empty line: each of the three slots empty (`PageLine::is_empty` in the core). */
export function emptyLine(): PageLine {
  return { left: "", center: "", right: "" };
}

/** Whether the line draws nothing at all. */
export function isEmptyLine(line: PageLine | undefined): boolean {
  return !line || (!line.left && !line.center && !line.right);
}

/** The three slots of a line in the order they are drawn and stored. */
export function slotsOf(line: PageLine): { slot: "left" | "center" | "right"; text: string }[] {
  return [
    { slot: "left", text: line.left },
    { slot: "center", text: line.center },
    { slot: "right", text: line.right },
  ];
}

/** Why a line cannot be stored: a slot holds a control character, shape `"line"`. */
export type PageLineProblem = "line";

/** The check of, the same rule `PageLine::validate` applies in the core. */
export function pageLineProblem(line: PageLine): PageLineProblem | null {
  // eslint-disable-next-line no-control-regex
  return slotsOf(line).some(({ text }) => /[\u0000-\u001f\u007f-\u009f]/.test(text)) ? "line" : null;
}

/**
 * A slot with its tokens replaced. Only the three tokens of `TOKENS` are replaced: any
 * other `{...}` and a lone `{` stay exactly as they were typed, so `{x}` in a title is a title.
 */
export function renderSlot(text: string, values: PageTextValues): string {
  return text.replace(/\{(page|date|file)\}/g, (_token, name: TokenName) =>
    name === "page" ? String(values.page) : name === "date" ? values.date : values.file,
  );
}

/** A whole line with its tokens replaced, slot by slot. */
export function renderLine(line: PageLine, values: PageTextValues): PageLine {
  return {
    left: renderSlot(line.left, values),
    center: renderSlot(line.center, values),
    right: renderSlot(line.right, values),
  };
}

/** The local date of the drawing as `YYYY-MM-DD`; `now` is for the tests. */
export function todayIso(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  // The local date, not UTC: a drawing made at 01:00 in Rome is dated that day.
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The file name a `{file}` token draws: the last part of the document's path, with its
 * extension (`beam.eqv`, and `Untitled-2.eqv` for a worksheet that has no file yet).
 */
export function fileNameOf(name: string): string {
  const parts = name.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}
