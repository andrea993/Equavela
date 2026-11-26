// The inline math node of the text editor: an atomic, inline Lexical decorator that holds the
// math in the structural editor's tree form and draws `InlineMath` (the structural editor).

import {
  $applyNodeReplacement,
  $getNodeByKey,
  DecoratorNode,
  HISTORY_MERGE_TAG,
  SKIP_DOM_SELECTION_TAG,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ReactNode } from "react";
import type { Node } from "../../editor/tree";
import { InlineMath, type Leave } from "../InlineMath";

type Serialized = Spread<
  { tree: Node | null; fallback: string; resultIndex: number | null; disabled?: boolean; format?: Record<string, string> },
  SerializedLexicalNode
>;

export class MathNode extends DecoratorNode<ReactNode> {
  /** The math as an editing tree; null for math whose text did not parse (shown as text). */
  __tree: Node | null;
  /** The text of unparsed math, kept as typed. */
  __fallback: string;
  /** Just inserted: takes the keyboard when first drawn. */
  __fresh: boolean;
  /**
   * The index of this run among the math runs of the text the editor opened with, whose result it
   * draws; null when the run was inserted while the text is edited, or its math changed, so no result of the
   * last committed text belongs to it.
   */
  __resultIndex: number | null;
  /** The run is disabled and carries its own result format. */
  __disabled: boolean;
  __format: Record<string, string>;

  static getType() {
    return "inline-math";
  }
  static clone(node: MathNode) {
    return new MathNode(node.__tree, node.__fallback, node.__fresh, node.__resultIndex, node.__key, node.__disabled, node.__format);
  }
  static importJSON(json: Serialized) {
    return new MathNode(json.tree, json.fallback, false, json.resultIndex ?? null, undefined, json.disabled ?? false, json.format ?? {});
  }
  constructor(
    tree: Node | null,
    fallback = "",
    fresh = false,
    resultIndex: number | null = null,
    key?: NodeKey,
    disabled = false,
    format: Record<string, string> = {},
  ) {
    super(key);
    this.__disabled = disabled;
    this.__format = format;
    this.__tree = tree;
    this.__fallback = fallback;
    this.__fresh = fresh;
    this.__resultIndex = resultIndex;
  }
  exportJSON(): Serialized {
    return {
      ...super.exportJSON(),
      type: "inline-math",
      version: 2,
      tree: this.__tree,
      fallback: this.__fallback,
      resultIndex: this.__resultIndex,
      ...(this.__disabled ? { disabled: true } : {}),
      ...(Object.keys(this.__format).length > 0 ? { format: this.__format } : {}),
    };
  }
  createDOM(_config: EditorConfig) {
    const host = document.createElement("span");
    host.className = "tx-math-host";
    return host;
  }
  updateDOM() {
    return false;
  }
  isInline() {
    return true;
  }
  isIsolated() {
    return true;
  }
  getTextContent() {
    return "";
  }
  /** The math changed: the result of the last committed text no longer belongs to this run. */
  setTree(tree: Node) {
    const writable = this.getWritable();
    writable.__tree = tree;
    writable.__resultIndex = null;
  }
  /** Disables or enables the run, and sets its own result format (null: none): . */
  setAttributes(change: { disabled?: boolean; format?: Record<string, string> | null }) {
    const writable = this.getWritable();
    if (change.disabled !== undefined) writable.__disabled = change.disabled;
    if (change.format !== undefined) writable.__format = change.format ?? {};
  }
  setFresh(fresh: boolean) {
    this.getWritable().__fresh = fresh;
  }

  decorate(editor: LexicalEditor): ReactNode {
    const key = this.getKey();
    if (!this.__tree) {
      return (
        <span className={`tx-math tx-bad${this.__disabled ? " tx-disabled" : ""}`} data-testid="inline-math-bad">
          {this.__fallback}
        </span>
      );
    }
    const withNode = (run: (node: MathNode) => void, tag?: string | string[]) =>
      editor.update(
        () => {
          const node = $getNodeByKey(key);
          if (node instanceof MathNode) run(node);
        },
        tag ? { tag } : undefined,
      );
    return (
      <InlineMath
        tree={this.__tree}
        resultIndex={this.__resultIndex}
        disabled={this.__disabled}
        format={this.__format}
        onAttributes={(change) => withNode((node) => node.setAttributes(change))}
        autoFocus={this.__fresh}
        keepOnChromeFocus
        deleteOnEmpty
        onFocused={() => withNode((node) => node.setFresh(false), HISTORY_MERGE_TAG)}
        // Keep the edit in the insertion's history step and leave selection to the math editor.
        onTree={(tree) => withNode((node) => node.setTree(tree), [HISTORY_MERGE_TAG, SKIP_DOM_SELECTION_TAG])}
        onEmpty={(focusText) => {
          editor.update(() => {
            const node = $getNodeByKey(key);
            if (!(node instanceof MathNode)) return;
            const prev = node.getPreviousSibling();
            const next = node.getNextSibling();
            const parent = node.getParent();
            node.remove();
            if (focusText) {
              if (prev) prev.selectEnd();
              else if (next) next.selectStart();
              else parent?.selectEnd();
            }
          });
          if (focusText) editor.getRootElement()?.focus({ preventScroll: true });
        }}
        onLeave={(direction: Leave) => {
          // The caret goes to the text just past the math. A decorator at the edge of its paragraph has no
          // sibling to select: select the paragraph edge instead (spike G finding). The caret is placed after
          // the text editor has the focus again: a browser that gives an editable the focus back puts its
          // caret at the start.
          const place = () =>
            editor.update(() => {
              const node = $getNodeByKey(key);
              if (!node) return;
              if (direction === "right") {
                if (node.getNextSibling()) node.selectNext(0, 0);
                else node.getParentOrThrow().selectEnd();
              } else if (node.getPreviousSibling()) node.selectPrevious();
              else node.getParentOrThrow().selectStart();
            });
          // Focus moves straight to the text, so the region never sees the keyboard leave it.
          place();
          editor.getRootElement()?.focus({ preventScroll: true });
          editor.focus(place);
        }}
      />
    );
  }
}

export const $createMathNode = (
  tree: Node | null,
  fallback = "",
  fresh = false,
  resultIndex: number | null = null,
  attributes: { disabled?: boolean; format?: Record<string, string> } = {},
) => $applyNodeReplacement(new MathNode(tree, fallback, fresh, resultIndex, undefined, attributes.disabled ?? false, attributes.format ?? {}));
