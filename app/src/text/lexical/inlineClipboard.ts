import { $createLineBreakNode, $createTextNode, $isLineBreakNode, $isTextNode, type LexicalEditor, type LexicalNode, type RangeSelection } from "lexical";
import type { Node } from "../../editor/tree";
import { $createMathNode, MathNode } from "./MathNode";

type Piece =
  | { kind: "text"; text: string; format: number; style: string }
  | { kind: "math"; tree: Node | null; fallback: string; disabled: boolean; format: Record<string, string>; plain: string }
  | { kind: "break" };

let copied: { plain: string; pieces: Piece[] } | null = null;

/** Captures the selected text fragments and complete inline equations. */
export function $copyMixedSelection(selection: RangeSelection, editor: LexicalEditor): string | null {
  const nodes = selection.getNodes();
  if (!nodes.some((node) => node instanceof MathNode)) return null;
  const start = selection.isBackward() ? selection.focus : selection.anchor;
  const end = selection.isBackward() ? selection.anchor : selection.focus;
  const pieces: Piece[] = [];
  let paragraph: string | null = null;
  for (const node of nodes) {
    if (!$isTextNode(node) && !(node instanceof MathNode) && !$isLineBreakNode(node)) continue;
    const parent = node.getTopLevelElement()?.getKey() ?? null;
    if (paragraph !== null && parent !== paragraph) pieces.push({ kind: "break" });
    paragraph = parent;
    if ($isTextNode(node)) {
      const text = node.getTextContent();
      const from = start.key === node.getKey() && start.type === "text" ? start.offset : 0;
      const to = end.key === node.getKey() && end.type === "text" ? end.offset : text.length;
      if (to > from) pieces.push({ kind: "text", text: text.slice(from, to), format: node.getFormat(), style: node.getStyle() });
    } else if (node instanceof MathNode) {
      pieces.push({ kind: "math", tree: node.__tree, fallback: node.__fallback, disabled: node.__disabled, format: { ...node.__format }, plain: node.__fallback || editor.getElementByKey(node.getKey())?.textContent || "\uFFFC" });
    } else {
      pieces.push({ kind: "break" });
    }
  }
  const plain = pieces.map((piece) => piece.kind === "break" ? "\n" : piece.kind === "math" ? piece.plain : piece.text).join("");
  copied = { plain, pieces };
  return plain;
}

/** Restores a mixed selection when the clipboard still contains the copied text. */
export function $pasteMixedSelection(selection: RangeSelection, plain: string): boolean {
  if (!copied || copied.plain !== plain) return false;
  const nodes: LexicalNode[] = copied.pieces.map((piece) => {
    if (piece.kind === "break") return $createLineBreakNode();
    if (piece.kind === "math") return $createMathNode(piece.tree, piece.fallback, false, null, { disabled: piece.disabled, format: piece.format });
    return $createTextNode(piece.text).setFormat(piece.format).setStyle(piece.style);
  });
  selection.insertNodes(nodes);
  return true;
}

export function clearMixedClipboard(): void { copied = null; }

/** Extend a text selection that ends inside inline math to the edge of the whole equation. */
export function normalizeInlineSelection(root: HTMLElement, selection: Selection | null): void {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return;
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
  const host = (node: globalThis.Node) => (node instanceof Element ? node : node.parentElement)?.closest(".tx-math-host") ?? null;
  const anchorHost = host(selection.anchorNode);
  const focusHost = host(selection.focusNode);
  if ((!anchorHost && !focusHost) || (anchorHost && anchorHost === focusHost)) return;
  const range = selection.getRangeAt(0).cloneRange();
  const backward = selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset;
  const startHost = host(range.startContainer);
  const endHost = host(range.endContainer);
  if (startHost) range.setStartBefore(startHost);
  if (endHost) range.setEndAfter(endHost);
  selection.setBaseAndExtent(
    backward ? range.endContainer : range.startContainer,
    backward ? range.endOffset : range.startOffset,
    backward ? range.startContainer : range.endContainer,
    backward ? range.startOffset : range.endOffset,
  );
}
