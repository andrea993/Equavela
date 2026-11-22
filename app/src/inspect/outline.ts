// Pure data of the Outline and Problems tabs of the side panel.

import { S } from "../strings";
import type { RegionEntry, RichText, SessionDiagnostic, ViewRegion, WarningInfo, RegionKey } from "../equavelaApi";
import { headingLevelOf } from "../text/value";
import { fileName } from "./inspection";

export type OutlineItem = {
  id: string;
  page: number;
  kind: ViewRegion["kind"];
  /** 0 for an ordinary region, 1 to 3 for headings (a paragraph with a heading style). */
  level: 0 | 1 | 2 | 3;
  label: string;
  /** A math region's statement, drawn as math in place of `label`. */
  statement?: unknown;
};

/** Text of one paragraph: runs joined, inline math as its linear text. */
const paragraphText = (paragraph: RichText[number]): string =>
  paragraph.runs.map((run) => run.text).join("").replace(/\s+/g, " ").trim();

/**
 * The heading of a text region: its first paragraph with a heading style, with
 * that style's level, wherever the paragraph is in the region. A region whose paragraphs are all Normal
 * falls back to the guess from formatting that worksheets written before styles relied on.
 */
export function headingOf(paragraphs: RichText): { level: 1 | 2 | 3; text: string } | null {
  for (const paragraph of paragraphs) {
    const level = headingLevelOf(paragraph.style);
    if (level !== null) return { level, text: paragraphText(paragraph) };
  }
  const level = headingLevel(paragraphs);
  return level === 0 ? null : { level, text: paragraphText(paragraphs[0]) };
}

/**
 * The old guess, kept only as the fallback of `headingOf`: a first paragraph that is entirely bold or set
 * in a size above the default is a heading; 21 pt and larger is level 1, 15 pt and larger or plain bold
 * is level 2.
 */
export function headingLevel(paragraphs: RichText): 0 | 1 | 2 {
  const first = paragraphs[0]?.runs;
  if (!first || first.length === 0) return 0;
  const texts = first.filter((run) => run.kind === "text");
  if (texts.length === 0) return 0;
  const size = Math.min(...texts.map((run) => (run.kind === "text" ? (run.size ?? 12) : 12)));
  if (size >= 21) return 1;
  if (size >= 15) return 2;
  return texts.every((run) => run.kind === "text" && run.bold) ? 2 : 0;
}

type Node = { type: string } & Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** The heading of a program line: a `for`, `while`, `if` or `try` without what it holds. */
function lineHead(line: unknown): unknown {
  if (!isNode(line)) return line;
  switch (line.type) {
    case "For":
    case "While":
      return { ...line, body: [] };
    case "If":
      return { ...line, branches: (line.branches as Node[]).slice(0, 1).map((branch) => ({ ...branch, body: [] })), else: null };
    case "Try":
      return { ...line, body: [], handler: [] };
    default:
      return line;
  }
}

/**
 * A math statement as the Outline draws it: every program cut to its first
 * line, so the row stays one line high.
 */
export function outlineStatement(statement: unknown): unknown {
  if (Array.isArray(statement)) return statement.map(outlineStatement);
  if (!isNode(statement)) return statement;
  if (statement.type === "Program") {
    const body = statement.body as unknown[];
    return { ...statement, body: body.slice(0, 1).map(lineHead) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(statement)) out[key] = typeof value === "object" && value !== null ? outlineStatement(value) : value;
  return out;
}

/** The regions of a document in reading order, as outline entries. */
export function outlineOf(regions: ViewRegion[]): OutlineItem[] {
  return [...regions]
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
    .map((region): OutlineItem => {
      switch (region.kind) {
        case "text": {
          const heading = headingOf(region.paragraphs);
          const label = heading?.text || region.paragraphs.map(paragraphText).find((text) => text !== "") || S.panel.outline.empty_text;
          return { id: region.id, page: region.page, kind: "text", level: heading?.level ?? 0, label };
        }
        case "math":
          return { id: region.id, page: region.page, kind: "math", level: 0, label: region.text, statement: outlineStatement(region.statement) };
        case "include":
          return { id: region.id, page: region.page, kind: "include", level: 0, label: `${S.panel.outline.include} ${region.path}` };
        case "julia":
          return {
            id: region.id,
            page: region.page,
            kind: "julia",
            level: 0,
            label: `${S.panel.outline.julia} ${region.block.code?.split("\n")[0] ?? ""}`.trim(),
          };
        case "plot":
          return { id: region.id, page: region.page, kind: "plot", level: 0, label: S.page.plotLabel };
        case "image":
          return { id: region.id, page: region.page, kind: "image", level: 0, label: S.page.imageLabel };
        case "area":
          return { id: region.id, page: region.page, kind: "area", level: 0, label: region.title || S.page.areaLabel };
      }
    });
}

export type Problem = {
  severity: "error" | "warning";
  kind: "error" | "unit" | "diagnostic";
  message: string;
  /** The region it is about; its `document` is not the root for a problem inside an include. */
  key: RegionKey;
  /** The file name when the problem is inside an include (null for the worksheet itself). */
  file: string | null;
  /** The package a missing-package error needs, for its Add action. */
  package?: string;
};

/**
 * Every error (kernel evaluation errors; regions that merely depend on a failed region are not
 * listed again), unit warning and structural diagnostic (missing include, cycle, ...) of a
 * worksheet, in a stable order: root first, then by region.
 */
export function problemsOf(
  root: string,
  results: RegionEntry[],
  diagnostics: SessionDiagnostic[],
  warnings: readonly WarningInfo[],
): Problem[] {
  const fileOf = (document: string) => (document === root ? null : fileName(document));
  const problems: Problem[] = [];
  for (const entry of results) {
    if (entry.state !== "error" || entry.failure.kind === "blocked") continue;
    problems.push({
      severity: "error",
      kind: "error",
      message: entry.failure.message,
      key: entry.key,
      file: fileOf(entry.key.document),
      ...(entry.failure.julia_type === "MissingPackage" && entry.failure.package ? { package: entry.failure.package } : {}),
    });
  }
  for (const warning of warnings) {
    problems.push({ severity: "warning", kind: "unit", message: warning.message, key: warning.key, file: fileOf(warning.key.document) });
  }
  for (const diagnostic of diagnostics) {
    problems.push({
      severity: "warning",
      kind: "diagnostic",
      message: diagnostic.message,
      key: { document: diagnostic.document, region_id: diagnostic.region_id, instance: 0 },
      file: fileOf(diagnostic.document),
    });
  }
  const order = (problem: Problem) => (problem.file === null ? 0 : 1);
  return problems.sort(
    (a, b) =>
      order(a) - order(b) ||
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      a.key.document.localeCompare(b.key.document) ||
      a.key.region_id.localeCompare(b.key.region_id),
  );
}
