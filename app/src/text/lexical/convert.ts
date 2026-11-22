// Conversion between the text value (`RichText`) and the Lexical editor state. The only
// place that knows both; everything else in the app works on the value.

import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  createEditor,
  type ParagraphNode,
} from "lexical";
import { $patchStyleText } from "@lexical/selection";
import { isEmptyStatement, toEditing, toWire, WireError } from "../../editor/tree";
import type { MathRun, Paragraph, ParagraphAlign, ParagraphStyle, RichRun, RichText, TextRun } from "../../equavelaApi";
import { $createMathNode, MathNode } from "./MathNode";
import { $createTextParagraphNode, $isTextParagraphNode, TextParagraphNode } from "./TextParagraphNode";
import { lineHeightPx, sizeCss } from "../value";

/**
 * Value to editor state (call inside `editor.update` or an `editorState` initializer). Every math run is
 * numbered with its index in the value: that is the result key of the inline run, which the editor
 * draws while the region is open.
 */
export function $writeValue(value: RichText) {
  const root = $getRoot();
  root.clear();
  let mathIndex = 0;
  for (const paragraph of value) {
    // The style and the alignment travel with the paragraph. Every paragraph of a
    // value is one of ours so that a command can be applied to it; a paragraph the editor starts on Enter is
    // a plain Lexical one, which reads back as Normal and left and is adopted when a command touches it.
    const node = $createTextParagraphNode(paragraph.style ?? "normal", paragraph.align ?? "left");
    for (const run of paragraph.runs) {
      if (run.kind === "math") {
        const index = mathIndex++;
        const attributes = { disabled: run.disabled, format: run.format };
        node.append(
          run.statement
            ? $createMathNode(toEditing(run.statement), "", false, index, attributes)
            : $createMathNode(null, run.text, false, index, attributes),
        );
        continue;
      }
      const text = $createTextNode(run.text);
      if (run.bold) text.toggleFormat("bold");
      if (run.italic) text.toggleFormat("italic");
      if (run.underline) text.toggleFormat("underline");
      if (run.sub) text.toggleFormat("subscript");
      if (run.sup) text.toggleFormat("superscript");
      const style = [
        run.size ? `font-size: ${sizeCss(run.size)}; line-height: ${lineHeightPx(run.size)}px` : "",
        run.color ? `color: ${run.color}` : "",
        run.highlight ? `background-color: ${run.highlight}` : "",
      ].filter(Boolean);
      if (style.length > 0) text.setStyle(style.join("; "));
      node.append(text);
    }
    root.append(node);
  }
}

/**
 * A plain Lexical paragraph becomes one of ours, carrying the same children. The
 * editor starts a plain paragraph on Enter, whose attributes are the defaults; it is adopted here the moment a
 * paragraph command touches it, so a style or an alignment can always be set on the paragraph at the caret.
 */
export function $adoptParagraph(paragraph: ParagraphNode): TextParagraphNode {
  if ($isTextParagraphNode(paragraph)) return paragraph;
  return paragraph.replace($createTextParagraphNode(), true) as TextParagraphNode;
}

/**
 * The paragraphs the selection touches: the paragraph of the anchor, of the focus and of every node between
 * them. A collapsed caret touches the paragraph it sits in.
 */
export function $selectedParagraphs(): TextParagraphNode[] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return [];
  const touched = [...selection.getNodes(), selection.anchor.getNode(), selection.focus.getNode()];
  const paragraphs = new Set<TextParagraphNode>();
  for (const node of touched) {
    const top = node.getTopLevelElement();
    if ($isParagraphNode(top)) paragraphs.add($adoptParagraph(top));
  }
  return [...paragraphs];
}

/**
 * Sets the colour (or with null the default) of the selected text, as one edit of the
 * editor state: the colour is an inline style of the text node, which `$readValue` reads back.
 */
export function $setRunColor(color: string | null) {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) $patchStyleText(selection, { color });
}

/** Sets the highlight (or with null none) of the selected text. */
export function $setRunHighlight(color: string | null) {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) $patchStyleText(selection, { "background-color": color });
}

/** Sets the style of every paragraph the selection touches, as one edit of the editor state. */
export function $setParagraphStyle(style: ParagraphStyle) {
  for (const paragraph of $selectedParagraphs()) paragraph.setParagraphStyle(style);
}

/** Sets the alignment of every paragraph the selection touches. */
export function $setAlign(align: ParagraphAlign) {
  for (const paragraph of $selectedParagraphs()) paragraph.setAlign(align);
}

/** The attributes of a paragraph node; a plain paragraph is Normal, left. */
function attributesOf(paragraph: ParagraphNode): Pick<Paragraph, "style" | "align"> {
  if (!$isTextParagraphNode(paragraph)) return {};
  const style = paragraph.getParagraphStyle();
  const align = paragraph.getAlign();
  return {
    ...(style === "normal" ? {} : { style }),
    ...(align === "left" ? {} : { align }),
  };
}

/** Editor state to value (call inside `editorState.read`). Line breaks start a new paragraph. */
export function $readValue(): RichText {
  const out: RichText = [];
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isParagraphNode(paragraph)) continue;
    const attributes = attributesOf(paragraph);
    let runs: RichRun[] = [];
    for (const child of paragraph.getChildren()) {
      if ($isLineBreakNode(child)) {
        out.push({ ...attributes, runs });
        runs = [];
      } else if (child instanceof MathNode) {
        const attributes: Pick<MathRun, "disabled" | "format"> = {
          ...(child.__disabled ? { disabled: true } : {}),
          ...(Object.keys(child.__format).length > 0 ? { format: child.__format } : {}),
        };
        if (!child.__tree) {
          runs.push({ kind: "math", text: child.__fallback, statement: null, ...attributes });
        } else if (!isEmptyStatement(child.__tree)) {
          try {
            runs.push({ kind: "math", text: "", statement: toWire(child.__tree), ...attributes });
          } catch (error) {
            // Incomplete math (a placeholder is left) has no AST yet and is not kept.
            if (!(error instanceof WireError)) throw error;
          }
        }
      } else if ($isTextNode(child)) {
        const run: TextRun = { kind: "text", text: child.getTextContent() };
        if (child.hasFormat("bold")) run.bold = true;
        if (child.hasFormat("italic")) run.italic = true;
        if (child.hasFormat("underline")) run.underline = true;
        if (child.hasFormat("subscript")) run.sub = true;
        if (child.hasFormat("superscript")) run.sup = true;
        const size = /font-size:\s*([\d.]+)px/.exec(child.getStyle());
        if (size) run.size = (Number(size[1]) * 3) / 4;
        const color = COLOR_STYLE.exec(child.getStyle());
        if (color) run.color = hexOf(color[1]);
        const highlight = HIGHLIGHT_STYLE.exec(child.getStyle());
        if (highlight) run.highlight = hexOf(highlight[1]);
        runs.push(run);
      }
    }
    out.push({ ...attributes, runs });
  }
  return out.length ? out : [{ runs: [] }];
}

// The inline style of a text node carries its colour and highlight. A colour set by the
// browser or the editor may read back as `rgb(r, g, b)`, so both forms are understood.
const COLOR_STYLE = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6}|rgb\([^)]*\))/;
const HIGHLIGHT_STYLE = /background-color:\s*(#[0-9a-fA-F]{6}|rgb\([^)]*\))/;

/** `#rrggbb` (lower case) of a CSS colour in either form. */
function hexOf(css: string): string {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(css);
  if (!rgb) return css.toLowerCase();
  return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

/** Headless conversion (tests): value to Lexical to value. */
export function roundTrip(value: RichText): RichText {
  const editor = createEditor({
    namespace: "round-trip",
    nodes: [MathNode, TextParagraphNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(() => $writeValue(value), { discrete: true });
  return editor.getEditorState().read($readValue);
}
