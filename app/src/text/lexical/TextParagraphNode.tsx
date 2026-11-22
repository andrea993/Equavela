// A paragraph of the text editor that carries the two paragraph attributes of
// the specification section 7 (a style and an alignment). It draws itself with the same CSS
// helper the read-only render uses (`text/value.ts` `paragraphCss`), which is what makes the editor
// and the printed page the same picture.

import {
  $applyNodeReplacement,
  ParagraphNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedParagraphNode,
  type Spread,
} from "lexical";
import type { ParagraphAlign, ParagraphStyle } from "../../equavelaApi";
import { paragraphCss } from "../value";

type Serialized = Spread<
  { pstyle: ParagraphStyle; align: ParagraphAlign },
  SerializedParagraphNode
>;

/** Applies a paragraph's style and alignment to its DOM element. */
function applyParagraphStyle(dom: HTMLElement, style: ParagraphStyle, align: ParagraphAlign) {
  dom.setAttribute("style", paragraphCss(style, align));
  if (style !== "normal") dom.setAttribute("data-style", style);
  else dom.removeAttribute("data-style");
  dom.setAttribute("data-align", align);
}

export class TextParagraphNode extends ParagraphNode {
  __pstyle: ParagraphStyle;
  __align: ParagraphAlign;

  static getType() {
    return "text-paragraph";
  }
  static clone(node: TextParagraphNode) {
    return new TextParagraphNode(node.__pstyle, node.__align, node.__key);
  }
  static importJSON(json: Serialized): TextParagraphNode {
    return new TextParagraphNode(json.pstyle ?? "normal", json.align ?? "left");
  }
  constructor(pstyle: ParagraphStyle = "normal", align: ParagraphAlign = "left", key?: NodeKey) {
    super(key);
    this.__pstyle = pstyle;
    this.__align = align;
  }
  exportJSON(): Serialized {
    return { ...super.exportJSON(), type: "text-paragraph", pstyle: this.__pstyle, align: this.__align };
  }
  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    applyParagraphStyle(dom, this.__pstyle, this.__align);
    return dom;
  }
  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode, dom, config);
    if (prevNode.__pstyle !== this.__pstyle || prevNode.__align !== this.__align) {
      applyParagraphStyle(dom, this.__pstyle, this.__align);
    }
    return updated;
  }
  /** The style of the paragraph (`normal` when it was never set). */
  getParagraphStyle(): ParagraphStyle {
    return this.getLatest().__pstyle;
  }
  /** The alignment of the paragraph (`left` when it was never set). */
  getAlign(): ParagraphAlign {
    return this.getLatest().__align;
  }
  setParagraphStyle(style: ParagraphStyle): this {
    const writable = this.getWritable();
    writable.__pstyle = style;
    return writable;
  }
  setAlign(align: ParagraphAlign): this {
    const writable = this.getWritable();
    writable.__align = align;
    return writable;
  }
}

/** Creates a paragraph with its attributes. */
export function $createTextParagraphNode(
  pstyle: ParagraphStyle = "normal",
  align: ParagraphAlign = "left",
): TextParagraphNode {
  return $applyNodeReplacement(new TextParagraphNode(pstyle, align));
}

/** Whether a node is a paragraph of this editor; a plain Lexical paragraph is Normal and left. */
export function $isTextParagraphNode(node: LexicalNode | null | undefined): node is TextParagraphNode {
  return node instanceof TextParagraphNode;
}
