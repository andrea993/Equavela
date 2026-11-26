// The value of a text region and its units. Library
// independent: the Lexical adapter and the read-only render both work on `RichText`.

import type { CSSProperties } from "react";
import type { ParagraphAlign, ParagraphStyle, RichText, RunFormat } from "../equavelaApi";

/** The font sizes of the editors in points: the reference application's list. */
export const FONT_SIZES_PT = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72] as const;
/** The text default, the reference application's Normal style: 10 pt. */
export const DEFAULT_SIZE_PT = 10;

/** CSS px of a size in points (96 dpi). */
export const sizePx = (pt: number) => (pt * 4) / 3;
/** The CSS `font-size` of a size in points: its px, to three decimals (10 pt: `13.333px`). */
export const sizeCss = (pt: number) => `${Number(sizePx(pt).toFixed(3))}px`;
/** Whole-pixel line height of a size: 1.25 of the font size, rounded (12 pt: 20 px, 10 pt: 17 px). */
export const lineHeightPx = (pt: number) => Math.round((pt * 5) / 3);

/** Inline style of a size override. */
export function sizeStyle(pt: number | undefined): { fontSize: string; lineHeight: string } | undefined {
  if (!pt) return undefined;
  return { fontSize: sizeCss(pt), lineHeight: `${lineHeightPx(pt)}px` };
}

/**
 * Inline style of a run: the size override (`sizeStyle`) and its colour and highlight
 * . The same style draws the read-only view and the open editor.
 */
export function runStyle(run: Pick<RunFormat, "size" | "color" | "highlight">): CSSProperties | undefined {
  const style: CSSProperties = { ...sizeStyle(run.size) };
  if (run.color) style.color = run.color;
  if (run.highlight) style.backgroundColor = run.highlight;
  return Object.keys(style).length > 0 ? style : undefined;
}

export const emptyText = (): RichText => [{ runs: [] }];

/**
 * The width of a text region's box, CSS px: a fixed `width` (a block, or a box the user resized),
 * or `{ max }` for a box that has no stored width and grows with its text up to `max`, where it
 * wraps.
 */
export type TextWidth = number | { max: number };

/** The smallest box of a growing text region, CSS px: room for the caret of an empty box. */
const MIN_GROWING_PX = 16;

/** The CSS of a text region's width, the same for the editor and the read-only render. */
export function textWidthStyle(width: TextWidth, background?: string): CSSProperties {
  // The fill of the region is drawn on the box that has the width, by the view, the open
  // editor and the print alike.
  const fill = background ? { backgroundColor: background } : {};
  if (typeof width === "number") return { width, ...fill };
  return { width: "fit-content", minWidth: MIN_GROWING_PX, maxWidth: width.max, ...fill };
}

/** Whether the value has neither text nor math (an empty region is not kept). */
export function isEmptyText(value: RichText): boolean {
  return value.every((paragraph) => paragraph.runs.every((run) => (run.kind === "text" ? run.text === "" : false)));
}

/** The paragraph styles, in the order of the Text tab gallery. */
export const PARAGRAPH_STYLES = ["normal", "title", "subtitle", "heading1", "heading2", "heading3"] as const;
/** The paragraph alignments, in the order of the Text tab group. */
export const PARAGRAPH_ALIGNS = ["left", "center", "right", "justify"] as const;

/** The space after a paragraph of the stylesheet, in px (`.text-region .tx-p`, text.css). */
const DEFAULT_SPACE_AFTER = 0;

/** Font size in points, line height and space after, in whole px, of each style. */
const STYLE_METRICS: Record<ParagraphStyle, { pt: number; weight: number; after: number }> = {
  normal: { pt: DEFAULT_SIZE_PT, weight: 400, after: 0 },
  title: { pt: 28, weight: 700, after: 20 },
  subtitle: { pt: 18, weight: 400, after: 20 },
  heading1: { pt: 16, weight: 700, after: 12 },
  heading2: { pt: 13, weight: 700, after: 8 },
  heading3: { pt: 12, weight: 700, after: 8 },
};

/**
 * The style of a paragraph, from its style and alignment: one helper for the read-only
 * render that is printed and for the editor's own paragraph DOM, so the two are the same picture; every value
 * is a whole number of CSS px.
 */
export function paragraphStyle(style: ParagraphStyle = "normal", align: ParagraphAlign = "left"): CSSProperties {
  const metrics = STYLE_METRICS[style];
  return {
    fontSize: sizeCss(metrics.pt),
    fontWeight: metrics.weight,
    lineHeight: `${lineHeightPx(metrics.pt)}px`,
    // Normal has no space after, which is the
    // stylesheet's default (`text.css`); a style with a space after states it here, and the `:last-child`
    // rule of the stylesheet drops it on the last paragraph of a region.
    ...(metrics.after === DEFAULT_SPACE_AFTER ? {} : { marginBottom: `${metrics.after}px` }),
    textAlign: align,
  };
}

/** The same declarations as a CSS string, for the editor's paragraph element. */
export function paragraphCss(style: ParagraphStyle = "normal", align: ParagraphAlign = "left"): string {
  return Object.entries(paragraphStyle(style, align))
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`)
    .join("; ");
}

/** The Outline level of a paragraph style: 1 to 3, null for Normal, Title and Subtitle. */
export function headingLevelOf(style: ParagraphStyle | undefined): 1 | 2 | 3 | null {
  switch (style) {
    case "heading1":
      return 1;
    case "heading2":
      return 2;
    case "heading3":
      return 3;
    default:
      return null;
  }
}

const FLAGS = ["bold", "italic", "underline", "sub", "sup"] as const;

/** The flags, size, colour and highlight of a text run in a canonical key (a missing one equals a false flag or no colour). */
const formatKey = (run: RunFormat) => `${FLAGS.map((f) => (run[f] ? 1 : 0)).join("")}:${run.size ?? 0}:${run.color ?? ""}:${run.highlight ?? ""}`;

/** Runs without empty text, equal neighbours merged, trailing empty paragraphs dropped. */
function canonical(value: RichText): unknown[] {
  const paragraphs = value.map((paragraph) => {
    const out: unknown[] = [];
    let last: { key: string; text: string; at: number } | null = null;
    for (const run of paragraph.runs) {
      if (run.kind === "math") {
        out.push(["math", run.statement, run.disabled === true, run.format ?? null]);
        last = null;
      } else if (run.text !== "") {
        const key = formatKey(run);
        if (last && last.key === key) {
          last.text += run.text;
          out[last.at] = [key, last.text];
        } else {
          last = { key, text: run.text, at: out.length };
          out.push([key, run.text]);
        }
      }
    }
    // The paragraph attributes are part of the value: an alignment change is a change.
    return [paragraph.style ?? "normal", paragraph.align ?? "left", out];
  });
  while (paragraphs.length > 1 && paragraphs[paragraphs.length - 1][2].length === 0) paragraphs.pop();
  return paragraphs;
}

/** Whether two values are the same text (ignoring how runs are split and empty runs). */
export const sameText = (a: RichText, b: RichText) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export type TextFormatState = Required<Pick<RunFormat, "bold" | "italic" | "underline" | "sub" | "sup">> & {
  /** The size at the selection in points; null when it is the region default or mixed. */
  size: number | null;
  /** The text colour and the highlight at the selection; null when default, none or mixed. */
  color: string | null;
  highlight: string | null;
  /** The style of the paragraph at the selection (a mixed selection shows the first paragraph's). */
  style: ParagraphStyle;
  /** The alignment of the paragraph at the selection. */
  align: ParagraphAlign;
};

export const NO_FORMAT: TextFormatState = {
  bold: false,
  italic: false,
  underline: false,
  sub: false,
  sup: false,
  size: null,
  color: null,
  highlight: null,
  style: "normal",
  align: "left",
};

/** Format commands of the Text Formatting tab and the keymap. */
export type TextFormatKind = "bold" | "italic" | "underline" | "sub" | "sup";

/**
 * What a text region draws after `=` or `→` of its `index`-th math run: the value, an error mark,
 * or nothing. `statement` is the run's math in the editing form (what the renderer draws), so the read-only
 * view and the editor that is open on the region share one renderer.
 */
export type InlineResult = (
  index: number,
  statement: unknown,
  /** The run's own result format, laid over the region's. */
  format?: Record<string, string>,
) => import("react").ReactNode;

/**
 * The inline equation that has the keyboard, for the commands of the equations: its
 * state and what changes it. The text editor reports it while the run is edited and null when it is left.
 */
export interface InlineActive {
  disabled: boolean;
  format: Record<string, string>;
  setDisabled(disabled: boolean): void;
  setFormat(format: Record<string, string> | null): void;
  /** The equation editor's own history, for quick-access Undo and Redo. */
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  copy(): Promise<void>;
  cut(): Promise<void>;
  paste(source?: Promise<string | null>): Promise<void>;
  remove(): void;
}

/** Whether the text editor's own history can step back or forward. */
export type TextHistory = { canUndo: boolean; canRedo: boolean };

/** What the workbench can ask of the active text editor (a handle given by the adapter). */
export interface TextHandle {
  toggle(kind: TextFormatKind): void;
  /** A size from `FONT_SIZES_PT`, or null for the region default. */
  setSize(pt: number | null): void;
  /** The text colour of the selection as #rrggbb, or null for the region default. */
  setColor(color: string | null): void;
  /** The highlight of the selection as #rrggbb, or null for none. */
  setHighlight(color: string | null): void;
  /** The style of every paragraph the selection touches. */
  setParagraphStyle(style: ParagraphStyle): void;
  /** The alignment of every paragraph the selection touches. */
  setAlign(align: ParagraphAlign): void;
  insertMath(): void;
  /** One step of the editor's own history; the editor keeps the keyboard. */
  undo(): void;
  redo(): void;
  focus(): void;
}

/** What a region needs to show the text editor instead of the read-only render. */
export interface TextEditBinding {
  initial: import("../equavelaApi").RichText;
  point: { x: number; y: number } | null;
  /** Open with the caret at the start of the text (entered with an arrow key from the crosshair). */
  atStart?: boolean;
  /** Open with the caret at the end of the text. */
  atEnd?: boolean;
  /** An arrow key had nothing more to do inside the text: leave the region on that side. */
  onEdge?: (direction: "left" | "right" | "up" | "down") => void;
  mathTarget: import("react").MutableRefObject<MathTarget | null>;
  clipboard: MathClipboard | null;
  onReady: (value: import("../equavelaApi").RichText) => void;
  onChange: (value: import("../equavelaApi").RichText) => void;
  onLeave: () => void;
  onHandle: (handle: TextHandle | null) => void;
  onFormat: (state: TextFormatState) => void;
  /** The editor's own history changed. */
  onHistory?: (history: TextHistory) => void;
  /** Undo was triggered while the text editor's local history is empty (fall back to worksheet). */
  onEmptyUndo?: () => void;
  /** Redo was triggered while the text editor's local history is empty (fall back to worksheet). */
  onEmptyRedo?: () => void;
  /** The inline equation being edited, or null. */
  onInline?: (active: InlineActive | null) => void;
}

/** The math region key for an inline run (core `richtext::inline_region_id`). */
export const inlineRegionId = (id: string, index: number): string => `${id}\u001einline${index}`;
export const ownerRegionId = (id: string): string => id.replace(/\u001einline\d+$/, "");

/**
 * Copy, cut and paste of math for an editor that has the keyboard (a math region or an inline math
 * in a text region). They report problems to the user themselves and resolve to the new editor
 * state, or null when nothing changed.
 */
export interface MathClipboard {
  copy(state: import("../editor/model").EditorState, cut: boolean): Promise<import("../editor/model").EditorState | null>;
  paste(
    state: import("../editor/model").EditorState,
    pending: Promise<string | null>,
  ): Promise<import("../editor/model").EditorState | null>;
  /**
   * The editing tree of a math text that a paste into a text region turns into an inline math
   * region, or null when it does not parse.
   */
  statement?(source: string): Promise<import("../editor/tree").Node | null>;
}

/** A target for the ribbon palettes: the inline math editor that has the keyboard. */
export interface MathTarget {
  update(change: (editor: import("../editor/model").EditorState) => import("../editor/model").EditorState): void;
}
