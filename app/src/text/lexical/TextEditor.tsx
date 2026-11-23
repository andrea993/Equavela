// The text region editor: Lexical behind the adapter of . Nothing outside
// `text/lexical/` imports Lexical. The adapter takes a `RichText`, reports a `RichText`, and
// offers a handle for the Text Formatting tab; the region is committed by the workbench (one
// `set_text` edit, one document undo step), the editor's own history is local while it is open.

import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelectionStyleValueForProperty, $patchStyleText } from "@lexical/selection";
import {
  $getRoot,
  $getAdjacentNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  COPY_COMMAND,
  DELETE_CHARACTER_COMMAND,
  FORMAT_TEXT_COMMAND,
  INDENT_CONTENT_COMMAND,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
  PASTE_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type BaseSelection,
  type RangeSelection,
  type LexicalEditor,
} from "lexical";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { fromDom, resolve } from "../../keymap/keymap";
import { emptyStatement } from "../../editor/tree";
import { mathOfPaste } from "../../mathPaste";
import { S } from "../../strings";
import { readClipboard, readClipboardFromGesture, writeClipboard } from "../../clipboard";
import type { ParagraphAlign, ParagraphStyle, RichText } from "../../equavelaApi";
import { enterInlineMath, TextEnvContext } from "../InlineMath";
import { isEmptyText, lineHeightPx, NO_FORMAT, sizeCss, textWidthStyle, type InlineActive, type InlineResult, type TextWidth, type MathClipboard, type MathTarget, type TextFormatKind, type TextFormatState, type TextHandle, type TextHistory } from "../value";
import { $readValue, $setAlign, $setParagraphStyle, $setRunColor, $setRunHighlight, $writeValue } from "./convert";
import { $createMathNode, MathNode } from "./MathNode";
import { $isTextParagraphNode, TextParagraphNode } from "./TextParagraphNode";

export type TextEditorProps = {
  initial: RichText;
  /** Client coordinates of the click that opened the editor: the caret goes there. */
  point: { x: number; y: number } | null;
  /** The value as the editor reads it right after opening (the baseline for "unchanged"). */
  onReady: (value: RichText) => void;
  onChange: (value: RichText) => void;
  /** Escape: leave the region. */
  onLeave: () => void;
  /** Open with the caret at the start of the text. */
  atStart?: boolean;
  atEnd?: boolean;
  /** An arrow key had nothing more to do inside the text (see `atEdge`): leave on that side. */
  onEdge?: (direction: "left" | "right" | "up" | "down") => void;
  onHandle: (handle: TextHandle | null) => void;
  onFormat: (state: TextFormatState) => void;
  /** The editor's own history changed. */
  onHistory?: (history: TextHistory) => void;
  /** Where the inline math editor that has the keyboard registers for the ribbon palettes. */
  mathTarget: MutableRefObject<MathTarget | null>;
  /** Copy, cut and paste for the inline math editor. */
  clipboard: MathClipboard | null;
  /** The result or error mark of an inline run: the same renderer the read-only view uses. */
  inlineResult?: InlineResult;
  /** The inline equation being edited. */
  onInline?: (active: InlineActive | null) => void;
  width: TextWidth;
  /** The fill of the whole region as #rrggbb. */
  background?: string;
};

const FORMATS: Record<TextFormatKind, "bold" | "italic" | "underline" | "subscript" | "superscript"> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  sub: "subscript",
  sup: "superscript",
};

type Direction = "left" | "right" | "up" | "down";
const ARROWS: Record<string, Direction> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/**
 * The inline math right before (`backward`) or right after a collapsed caret, or null. The browser's caret
 * decides when it is in a text node of the editor: next to an isolated decorator Lexical's selection can
 * lag one character behind it after an arrow, so the arrow that reaches the math would otherwise not enter.
 */
function $mathNextToCaret(editor: LexicalEditor, backward: boolean): MathNode | null {
  const dom = typeof window === "undefined" ? null : window.getSelection();
  const root = editor.getRootElement();
  if (dom?.isCollapsed && dom.anchorNode instanceof Text && root?.contains(dom.anchorNode)) {
    const text = $getNearestNodeFromDOMNode(dom.anchorNode);
    if ($isTextNode(text)) {
      const offset = dom.anchorOffset;
      const edge = backward ? offset === 0 : offset >= dom.anchorNode.data.length;
      const next = edge ? (backward ? text.getPreviousSibling() : text.getNextSibling()) : null;
      return next instanceof MathNode ? next : null;
    }
  }
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const next = $getAdjacentNode(selection.focus, backward);
  return next instanceof MathNode ? next : null;
}

/**
 * Whether an arrow key has nothing more to do inside the text: a collapsed caret at the very start
 * (Left) or end (Right) of the content, or on the first (Up) or last (Down) line of the first or last
 * paragraph. Line position uses the caret rectangle against the editor box; without layout (no
 * rectangles) the paragraph test alone decides.
 */
export function atEdge(editor: LexicalEditor, direction: Direction): boolean {
  const forward = direction === "right" || direction === "down";
  const inContent = editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
    const root = $getRoot();
    const anchor = selection.anchor;
    const node = anchor.getNode();
    if (direction === "up" || direction === "down") {
      const edge = forward ? root.getLastChild() : root.getFirstChild();
      return !edge || node.getTopLevelElement() === edge || node === edge;
    }
    const edgeLeaf = forward ? root.getLastDescendant() : root.getFirstDescendant();
    if (!edgeLeaf) return true;
    const size = $isTextNode(node) ? node.getTextContentSize() : $isElementNode(node) ? node.getChildrenSize() : 0;
    if (node.is(edgeLeaf) || (!forward && $isElementNode(node) && node.getFirstDescendant()?.is(edgeLeaf))) {
      return forward ? anchor.offset >= size : anchor.offset === 0;
    }
    return $isElementNode(node) && node.getKey() === (forward ? root.getLastChild() : root.getFirstChild())?.getKey()
      ? forward
        ? anchor.offset >= size
        : anchor.offset === 0
      : false;
  });
  if (!inContent || (direction !== "up" && direction !== "down")) return inContent;
  // Vertical: also on the first / last visual line of that paragraph.
  const root = editor.getRootElement();
  const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
  const caret = range?.getClientRects?.()[0] ?? range?.getBoundingClientRect?.();
  const box = root?.getBoundingClientRect?.();
  if (!caret || !box || (caret.height === 0 && caret.top === 0) || box.height === 0) return true;
  const line = Math.max(caret.height, 12);
  return forward ? caret.bottom >= box.bottom - line * 0.75 : caret.top <= box.top + line * 0.75;
}

/** The colour a style property has at the selection as #rrggbb, or null when it has none or it is mixed. */
function colorAt(selection: BaseSelection, property: "color" | "background-color"): string | null {
  const value = $getSelectionStyleValueForProperty(selection as never, property, "");
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function insertMath(editor: LexicalEditor) {
  editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertNodes([$createMathNode(emptyStatement(), "", true)]);
  });
}

/** Handle, keymap, structure rules and format state; renders nothing. */
function Behaviour({ props }: { props: TextEditorProps }) {
  const [editor] = useLexicalComposerContext();
  const live = useRef(props);
  live.current = props;

  // The handle for the Text Formatting tab.
  useEffect(() => {
    const handle: TextHandle = {
      toggle: (kind) => {
        editor.focus();
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, FORMATS[kind]);
      },
      setSize: (pt) => {
        editor.focus();
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          $patchStyleText(
            selection,
            pt === null
              ? { "font-size": null, "line-height": null }
              : { "font-size": sizeCss(pt), "line-height": `${lineHeightPx(pt)}px` },
          );
        });
      },
      setColor: (color) => {
        editor.focus();
        editor.update(() => $setRunColor(color));
      },
      setHighlight: (color) => {
        editor.focus();
        editor.update(() => $setRunHighlight(color));
      },
      setParagraphStyle: (style: ParagraphStyle) => {
        // One update, so one step of the editor's history.
        editor.focus();
        editor.update(() => $setParagraphStyle(style));
      },
      setAlign: (align: ParagraphAlign) => {
        editor.focus();
        editor.update(() => $setAlign(align));
      },
      insertMath: () => {
        editor.focus();
        insertMath(editor);
      },
      undo: () => {
        editor.focus();
        editor.dispatchCommand(UNDO_COMMAND, undefined);
      },
      redo: () => {
        editor.focus();
        editor.dispatchCommand(REDO_COMMAND, undefined);
      },
      focus: () => editor.focus(),
    };
    live.current.onHandle(handle);
    return () => live.current.onHandle(null);
  }, [editor]);

  // The history's availability, for quick-access Undo and Redo.
  useEffect(() => {
    const history: TextHistory = { canUndo: false, canRedo: false };
    live.current.onHistory?.({ ...history });
    const report = (key: keyof TextHistory) => (can: boolean) => {
      if (history[key] !== can) {
        history[key] = can;
        live.current.onHistory?.({ ...history });
      }
      return false;
    };
    const offUndo = editor.registerCommand(CAN_UNDO_COMMAND, report("canUndo"), COMMAND_PRIORITY_LOW);
    const offRedo = editor.registerCommand(CAN_REDO_COMMAND, report("canRedo"), COMMAND_PRIORITY_LOW);
    return () => {
      offUndo();
      offRedo();
    };
  }, [editor]);

  // The keymap of the `text` context, before Lexical's own shortcuts; and the
  // structure rules of the value: one paragraph per line, no indent, no tabs.
  useEffect(() => {
    const offKeys = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        const arrow = ARROWS[event.key];
        // Left or Right next to an inline math enters it at the near edge; a math that did not
        // parse has no editor and is stepped over.
        if ((arrow === "left" || arrow === "right") && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
          // `editor.read`: finding the node of a DOM node needs the active editor.
          const math = editor.read(() => {
            const next = $mathNextToCaret(editor, arrow === "left");
            return next ? { key: next.getKey(), parsed: next.__tree !== null } : null;
          });
          if (math) {
            event.preventDefault();
            const host = editor.getElementByKey(math.key);
            if (math.parsed && host) enterInlineMath(host, arrow === "right" ? "start" : "end");
            else
              editor.update(() => {
                const node = $getNodeByKey(math.key);
                if (!node) return;
                if (arrow === "right") {
                  if (node.getNextSibling()) node.selectNext(0, 0);
                  else node.getParentOrThrow().selectEnd();
                } else if (node.getPreviousSibling()) node.selectPrevious();
                else node.getParentOrThrow().selectStart();
              });
            return true;
          }
        }
        if (arrow && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && live.current.onEdge && atEdge(editor, arrow)) {
          event.preventDefault();
          live.current.onEdge(arrow);
          return true;
        }
        // Backspace in a text box with nothing in it removes the box (leaving it empties it away).
        if (event.key === "Backspace" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && isEmptyText(editor.getEditorState().read($readValue))) {
          event.preventDefault();
          live.current.onLeave();
          return true;
        }
        const action = resolve(fromDom(event), "text");
        if (!action || action.kind !== "command") return false;
        switch (action.cmd) {
          case "toggleBold":
          case "toggleItalic":
          case "toggleUnderline": {
            event.preventDefault();
            const kind = action.cmd === "toggleBold" ? "bold" : action.cmd === "toggleItalic" ? "italic" : "underline";
            editor.dispatchCommand(FORMAT_TEXT_COMMAND, FORMATS[kind]);
            return true;
          }
          case "insertInlineMath":
            event.preventDefault();
            insertMath(editor);
            return true;
          case "leaveText":
            event.preventDefault();
            live.current.onLeave();
            return true;
          default:
            return false;
        }
      },
      COMMAND_PRIORITY_HIGH,
    );
    const offBreak = editor.registerCommand(
      INSERT_LINE_BREAK_COMMAND,
      () => editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined),
      COMMAND_PRIORITY_HIGH,
    );
    // Backspace right after an inline math and Delete right before it remove it. Lexical keeps an
    // isolated decorator when deleting a character (it is deleted only when it is not isolated), and the
    // math is isolated so that its own editor keeps the keys inside it.
    const offDelete = editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      (isBackward) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const next = $getAdjacentNode(selection.focus, isBackward);
        if (!(next instanceof MathNode)) return false;
        next.remove();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const offCopy = editor.registerCommand(
      COPY_COMMAND,
      (event) => {
        let text: string | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed() || selection.getNodes().some((node) => node instanceof MathNode)) return;
          text = selection.getTextContent();
        });
        if (text === null) return false;
        if (event && "clipboardData" in event && event.clipboardData) {
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
        }
        void writeClipboard(text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    // the caret is the one the user had when pressing paste. Reading the clipboard from a
    // key press moves the focus to a hidden box and back (`readClipboardFromGesture`), and a browser
    // that gets the focus back puts the caret at the start of the editable; the statement is also parsed
    // asynchronously. So the selection is taken when the paste starts and put back before inserting.
    const currentSelection = (): RangeSelection | null =>
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        return $isRangeSelection(selection) ? selection.clone() : null;
      });
    const insertAtCaret = (saved: RangeSelection | null, insert: (selection: RangeSelection) => void) =>
      editor.update(() => {
        if (saved && saved.anchor.getNode().isAttached() && saved.focus.getNode().isAttached()) $setSelection(saved.clone());
        const selection = $getSelection();
        if ($isRangeSelection(selection)) insert(selection);
      });
    const pasteText = (source: string, saved: RangeSelection | null) => {
      const math = mathOfPaste(source);
      const statement = live.current.clipboard?.statement;
      if (math !== null && statement) {
        void statement(math).then((tree) =>
          insertAtCaret(saved, (selection) => {
            if (tree) selection.insertNodes([$createMathNode(tree, "", false)]);
            else selection.insertText(math);
          }),
        );
      } else {
        insertAtCaret(saved, (selection) => selection.insertText(source));
      }
    };
    const offKeyboardPaste = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        const action = resolve(fromDom(event), "text");
        if (!action || action.kind !== "command" || action.cmd !== "paste") return false;
        // Keep the browser's paste action alive: the hidden textarea receives its event on WebKitGTK,
        // where Lexical's contenteditable paste event can be missing. The async clipboard API is a fallback.
        const saved = currentSelection();
        const pending = readClipboardFromGesture();
        void pending.then(async (text) => text ?? (await readClipboard())).then((text) => text !== null && pasteText(text, saved));
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    // math copied from a math editor or a math region pastes as an inline math region at
    // the caret, with its structure; any other text pastes as text.
    const offPaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const data = (event as ClipboardEvent).clipboardData;
        const source = data ? mathOfPaste(data.getData("text/plain") ?? "") : null;
        const statement = live.current.clipboard?.statement;
        if (source === null || !statement) return false;
        event.preventDefault();
        const saved = currentSelection();
        void statement(source).then((tree) =>
          insertAtCaret(saved, (selection) => {
            // A text that does not parse as math is still what the user pasted: it goes in as text.
            if (tree) selection.insertNodes([$createMathNode(tree, "", false)]);
            else selection.insertText(source);
          }),
        );
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const offTab = editor.registerCommand(KEY_TAB_COMMAND, (event) => (event.preventDefault(), true), COMMAND_PRIORITY_HIGH);
    const offIndent = editor.registerCommand(INDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_HIGH);
    const offOutdent = editor.registerCommand(OUTDENT_CONTENT_COMMAND, () => true, COMMAND_PRIORITY_HIGH);
    return () => {
      offKeys();
      offBreak();
      offDelete();
      offCopy();
      offKeyboardPaste();
      offPaste();
      offTab();
      offIndent();
      offOutdent();
    };
  }, [editor]);

  // Format state at the selection, for the ribbon.
  useEffect(
    () =>
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const size = /([\d.]+)px/.exec($getSelectionStyleValueForProperty(selection, "font-size", ""));
          // The paragraph at the selection shows its style and alignment in the Text tab.
          const top = selection.anchor.getNode().getTopLevelElement();
          const paragraph = $isTextParagraphNode(top) ? top : null;
          live.current.onFormat({
            ...NO_FORMAT,
            bold: selection.hasFormat("bold"),
            italic: selection.hasFormat("italic"),
            underline: selection.hasFormat("underline"),
            sub: selection.hasFormat("subscript"),
            sup: selection.hasFormat("superscript"),
            size: size ? (Number(size[1]) * 3) / 4 : null,
            color: colorAt(selection, "color"),
            highlight: colorAt(selection, "background-color"),
            style: paragraph?.getParagraphStyle() ?? "normal",
            align: paragraph?.getAlign() ?? "left",
          });
        });
      }),
    [editor],
  );

  // Take the keyboard; the caret goes where the region was clicked.
  useEffect(() => {
    live.current.onReady(editor.getEditorState().read($readValue));
    editor.focus(() => {
      if (live.current.atStart) {
        editor.update(() => $getRoot().selectStart());
        return;
      }
      if (live.current.atEnd) {
        editor.update(() => $getRoot().selectEnd());
        return;
      }
      const point = live.current.point;
      if (!point) return;
      // A click on an inline math enters it there, once the editor has drawn it.
      setTimeout(() => {
        const math = document.elementFromPoint?.(point.x, point.y)?.closest<HTMLElement>('[data-testid="inline-math"]');
        if (math && editor.getRootElement()?.contains(math)) enterInlineMath(math, point);
      }, 0);
      const range = document.caretRangeFromPoint?.(point.x, point.y);
      const root = editor.getRootElement();
      if (!range || !root?.contains(range.startContainer)) return;
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    return undefined;
  }, [editor]);

  return null;
}

export default function TextEditor(props: TextEditorProps) {
  const initial = useRef(props.initial);
  const env = useMemo(
    () => ({ mathTarget: props.mathTarget, clipboard: props.clipboard, inlineResult: props.inlineResult, onInline: props.onInline }),
    [props.mathTarget, props.clipboard, props.inlineResult, props.onInline],
  );
  return (
    <TextEnvContext.Provider value={env}>
      <LexicalComposer
        initialConfig={{
          namespace: "text-region",
          nodes: [MathNode, TextParagraphNode],
          theme: {
            paragraph: "tx-p",
            text: { bold: "tx-b", italic: "tx-i", underline: "tx-u" },
          },
          editorState: () => $writeValue(initial.current),
          onError: (error) => {
            throw error;
          },
        }}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="tx-root text-region"
              style={textWidthStyle(props.width, props.background)}
              spellCheck={false}
              aria-label={S.text.editorLabel}
              data-testid="text-editor"
            />
          }
          placeholder={null}
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <Behaviour props={props} />
        <OnChangePlugin ignoreSelectionChange ignoreHistoryMergeTagChange={false} onChange={(state) => props.onChange(state.read($readValue))} />
      </LexicalComposer>
    </TextEnvContext.Provider>
  );
}
