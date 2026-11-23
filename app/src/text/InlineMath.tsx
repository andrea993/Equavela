// Inline math inside a text region: idle it is drawn like any math; with the keyboard it is
// the structural math editor (`editor/`) on its own local state, exactly as in a math region
// (same keymap, same model, same editing lines). It owns the keyboard natively (the text
// editor listens natively on an ancestor, spike G): Escape and Enter leave to the right, an
// arrow that cannot move any further leaves to that side. The tree is reported on every
// change; the text editor stores it in its node. An idle run also draws the result or the error
// mark of the last committed text, after its operator.

import { useCallback, useContext, useEffect, useRef, useState, createContext, type MutableRefObject } from "react";
import { EditorOverlay } from "../editor/EditorOverlay";
import { handleKey } from "../editor/controller";
import { mathHit, matrixDragHit, nearestMathHit, type Hit } from "../editor/hit";
import { initialState, placeCaret, runCommand, selectRange, type EditorState } from "../editor/model";
import { isEmptyStatement, type Node } from "../editor/tree";
import { fromDom } from "../keymap/keymap";
import { mathFontOf, mathFontStyle } from "../math/font";
import { MathStatement } from "../math/render";
import { S } from "../strings";
import { readClipboardFromGesture } from "../clipboard";
import type { InlineActive, InlineResult, MathClipboard, MathTarget } from "./value";

/** What the text editor gives its inline math: the palette target and its results. */
export type TextEnv = {
  mathTarget: MutableRefObject<MathTarget | null> | null;
  clipboard: MathClipboard | null;
  /** The result or error mark after the operator of a run, by index in the committed text. */
  inlineResult?: InlineResult;
  /** The run that has the keyboard, for the equation commands of the ribbon. */
  onInline?: (active: InlineActive | null) => void;
};
export const TextEnvContext = createContext<TextEnv>({ mathTarget: null, clipboard: null });

export type Leave = "left" | "right";

/** The event the text editor sends to an idle inline math to give it the keyboard from an arrow. */
const ENTER = "mm-enter-inline-math";
const SELECT = "mm-select-inline-math";
type Entry = "start" | "end" | { x: number; y: number };
type SelectionDrag = { from: Hit; to: { x: number; y: number }; target: EventTarget | null };

/** Finishes or extends a structural drag that began before the inline editor was mounted. */
export function selectInlineMath(element: HTMLElement, drag: SelectionDrag): boolean {
  return !element.dispatchEvent(new CustomEvent(SELECT, { detail: drag, cancelable: true }));
}
/**
 * Gives the keyboard to an inline math (its element, or the text editor's host of it), with its caret at the
 * start, the end, or where a click at that point lands.
 */
export function enterInlineMath(element: HTMLElement, at: Entry): void {
  const math = element.matches('[data-testid="inline-math"]') ? element : element.querySelector('[data-testid="inline-math"]');
  math?.dispatchEvent(new CustomEvent(ENTER, { detail: at }));
}

const NO_ATTRIBUTE_FORMAT: Record<string, string> = {};

const STOPPED = ["keyup", "keypress", "beforeinput", "input", "compositionstart", "compositionend", "paste", "cut", "copy"];

/** Whether a key left the editor exactly as it was (the caret had nowhere to go). */
export const sameCursor = (a: EditorState, b: EditorState) =>
  a.root === b.root &&
  a.explicit === b.explicit &&
  a.side === b.side &&
  a.focus.join(".") === b.focus.join(".") &&
  a.caret?.seg === b.caret?.seg &&
  a.caret?.offset === b.caret?.offset;

export function InlineMath({
  tree,
  resultIndex = null,
  disabled = false,
  format = NO_ATTRIBUTE_FORMAT,
  onAttributes,
  autoFocus,
  keepOnChromeFocus = false,
  onTree,
  onLeave,
  onEmpty,
  onFocused,
}: {
  tree: Node;
  /**
   * The index of the run among the math runs of the text the editor opened with, whose result it draws
   *; null when it is a new run or its math changed.
   */
  resultIndex?: number | null;
  /** The run is disabled and may carry its own result format. */
  disabled?: boolean;
  format?: Record<string, string>;
  onAttributes?: (change: { disabled?: boolean; format?: Record<string, string> | null }) => void;
  /** A newly inserted math takes the keyboard when it is first drawn. */
  autoFocus: boolean;
  keepOnChromeFocus?: boolean;
  /** The editing tree changed (every keystroke). */
  onTree: (tree: Node) => void;
  onLeave: (direction: Leave) => void;
  /** Leaving with nothing typed: the text editor removes the node. */
  onEmpty: () => void;
  onFocused: () => void;
}) {
  const env = useContext(TextEnvContext);
  const ref = useRef<HTMLSpanElement>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const live = useRef<EditorState | null>(null);
  const props = useRef({ onTree, onLeave, onEmpty, clipboard: env.clipboard });
  props.current = { onTree, onLeave, onEmpty, clipboard: env.clipboard };
  // True while a paste is being read through the hidden textarea (the focus is away for a moment).
  const pasting = useRef(false);
  // The press that may become a mouse selection (anchor of the drag).
  const press = useRef<ReturnType<typeof mathHit>>(null);
  // An arrow from the text is giving the keyboard to this math: where its caret starts.
  const entering = useRef<Entry | null>(null);

  const change = useCallback((next: EditorState) => {
    live.current = next;
    setEditor(next);
    if (next.root !== editor?.root) props.current.onTree(next.root);
  }, [editor?.root]);

  const begin = useCallback(
    (hit: ReturnType<typeof mathHit> = null) => {
      if (live.current) {
        if (hit) {
          try {
            change(placeCaret(live.current, hit.path, hit.side, hit.caret));
          } catch {
            /* a stale path */
          }
        }
        return;
      }
      let next = initialState(tree);
      if (entering.current === "start") next = runCommand(next, "home");
      entering.current = null;
      if (hit) {
        try {
          next = placeCaret(next, hit.path, hit.side, hit.caret);
        } catch {
          /* keep the caret at the end */
        }
      }
      live.current = next;
      setEditor(next);
      onFocused();
    },
    [change, onFocused, tree],
  );

  // Native key handling (see the header). `live` is the state the next key applies to.
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const stop = (event: Event) => event.stopPropagation();
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      const current = live.current;
      if (!current) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          begin();
        }
        return;
      }
      const result = handleKey(current, fromDom(event));
      // Enter leaves inline math even right after an operator: the equation break of Enter is a math
      // region's, and one-line math has no second line.
      if (result.action?.kind === "command" && result.action.cmd === "exitRegion") {
        event.preventDefault();
        props.current.onLeave("right");
        return;
      }
      // The browser's own paste must reach the hidden textarea (see below): no preventDefault for it.
      if (result.action && !(result.action.kind === "command" && result.action.cmd === "paste")) event.preventDefault();
      if (result.handled) {
        // An arrow that cannot move any further leaves the math towards that side.
        if (sameCursor(current, result.state) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          props.current.onLeave(event.key === "ArrowLeft" ? "left" : "right");
          return;
        }
        change(result.state);
      } else if (result.action?.kind === "command") {
        const { cmd } = result.action;
        const clipboard = props.current.clipboard;
        if (cmd === "leaveRegion" || cmd === "exitRegion") props.current.onLeave("right");
        else if ((cmd === "copy" || cmd === "cut") && clipboard) {
          void clipboard.copy(current, cmd === "cut").then((next) => next && change(next));
        } else if (cmd === "paste" && clipboard) {
          // The browser's own paste must reach the hidden textarea: no preventDefault.
          pasting.current = true;
          const pending = readClipboardFromGesture();
          void clipboard.paste(current, pending).then((next) => {
            if (next) change(next);
            // The text editor may take the focus back while the tree is stored: take it again.
            setTimeout(() => {
              ref.current?.focus();
              pasting.current = false;
            }, 0);
          });
        }
      }
    };
    const onEnter = (event: Event) => {
      if (live.current) return;
      const at = (event as CustomEvent<Entry>).detail;
      const hit = typeof at === "object" ? mathHit(element, document.elementFromPoint(at.x, at.y), at.x, at.y) : null;
      entering.current = at;
      element.focus();
      if (!live.current) begin();
      if (hit) begin(hit);
    };
    const onSelect = (event: Event) => {
      const { from, to, target } = (event as CustomEvent<SelectionDrag>).detail;
      const hit = matrixDragHit(element, from.path, to.x, to.y) ??
        mathHit(element, target, to.x, to.y) ??
        mathHit(element, document.elementFromPoint?.(to.x, to.y) ?? null, to.x, to.y) ??
        nearestMathHit(element, to.x, to.y);
      if (!hit) return;
      event.preventDefault();
      element.focus({ preventScroll: true });
      if (!live.current) begin(from);
      const current = live.current;
      if (!current) return;
      const same = from.path.join(".") === hit.path.join(".") &&
        from.caret?.offset === hit.caret?.offset && from.caret?.seg === hit.caret?.seg;
      change(same ? placeCaret(current, from.path, from.side, from.caret) : selectRange(current, from.path, hit.path));
    };
    element.addEventListener(ENTER, onEnter);
    element.addEventListener(SELECT, onSelect);
    element.addEventListener("keydown", onKey);
    for (const type of STOPPED) element.addEventListener(type, stop);
    return () => {
      element.removeEventListener(ENTER, onEnter);
      element.removeEventListener(SELECT, onSelect);
      element.removeEventListener("keydown", onKey);
      for (const type of STOPPED) element.removeEventListener(type, stop);
    };
  }, [begin, change]);

  // A new math takes the keyboard, after the text editor has finished placing its own selection
  // (it would take the focus back otherwise).
  useEffect(() => {
    if (!autoFocus) return undefined;
    const timer = setTimeout(() => {
      ref.current?.focus();
      begin();
    }, 0);
    return () => clearTimeout(timer);
    // Only when first drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While editing, the ribbon palettes act on this editor.
  useEffect(() => {
    if (!editor || !env.mathTarget) return undefined;
    const target: MathTarget = {
      update: (apply) => {
        if (live.current) change(apply(live.current));
      },
    };
    const slot = env.mathTarget;
    slot.current = target;
    return () => {
      if (slot.current === target) slot.current = null;
    };
  }, [change, editor !== null, env.mathTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // While editing, the equation commands of the ribbon (Disable Region, Result Format) act on this run.
  // So do quick-access Undo and Redo, with this editor's own history.
  const editingNow = editor !== null;
  const canUndo = (editor?.past.length ?? 0) > 0;
  const canRedo = (editor?.future.length ?? 0) > 0;
  const attributes = useRef(onAttributes);
  attributes.current = onAttributes;
  const liveChange = useRef(change);
  liveChange.current = change;
  useEffect(() => {
    if (!editingNow || !env.onInline) return undefined;
    const step = (cmd: "undo" | "redo") => {
      if (live.current) liveChange.current(runCommand(live.current, cmd));
    };
    env.onInline({
      disabled,
      format,
      setDisabled: (next) => attributes.current?.({ disabled: next }),
      setFormat: (next) => attributes.current?.({ format: next }),
      canUndo,
      canRedo,
      undo: () => step("undo"),
      redo: () => step("redo"),
    });
    return () => env.onInline?.(null);
  }, [editingNow, disabled, format, canUndo, canRedo, env]);

  const finish = useCallback(() => {
    const current = live.current;
    live.current = null;
    setEditor(null);
    if (current && isEmptyStatement(current.root)) props.current.onEmpty();
  }, []);

  // While a ribbon control, palette or dialog has the keyboard, keep the inline editor alive.
  // A return to another part of the worksheet ends the edit as a normal blur would.
  const inChrome = (target: EventTarget | null) =>
    target instanceof Element && target.closest(".chrome, [aria-modal=true]") !== null;
  useEffect(() => {
    if (!editingNow || !keepOnChromeFocus) return undefined;
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) || inChrome(event.target) || pasting.current) return;
      if (live.current) finish();
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, [editingNow, finish, keepOnChromeFocus]);

  const shown = editor ? editor.root : tree;
  // The result or the error mark of the last committed text, as the read-only view draws it: only while this
  // run is not the one being edited, and only for a run the committed text had. A run that is
  // changed loses its index until the next commit, so the result never belongs to other math.
  const result = editor === null && resultIndex !== null ? (Object.keys(format).length > 0 ? env.inlineResult?.(resultIndex, tree, format) : env.inlineResult?.(resultIndex, tree)) : undefined;
  return (
    <span
      ref={ref}
      className={`math tx-math tx-inline${editor ? " editing" : ""}${disabled ? " tx-disabled" : ""}`}
      style={format === NO_ATTRIBUTE_FORMAT ? undefined : mathFontStyle(mathFontOf(format))}
      data-testid="inline-math"
      tabIndex={0}
      contentEditable={false}
      aria-label={S.text.inlineMath}
      onFocus={() => {
        if (!live.current) begin();
      }}
      onBlur={(event) => {
        if (pasting.current) return;
        if (event.currentTarget.contains(event.relatedTarget as Element | null)) return;
        if (!keepOnChromeFocus || !inChrome(event.relatedTarget)) finish();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        const hit = mathHit(event.currentTarget, event.target, event.clientX, event.clientY);
        press.current = hit;
        if (live.current) {
          event.preventDefault();
          begin(hit);
        } else {
          // Focus follows the press; place the caret where it landed.
          queueMicrotask(() => begin(hit));
        }
      }}
      onPointerMove={(event) => {
        // Dragging with the button down selects: the smallest node containing both ends.
        const from = press.current;
        if (!from || event.buttons !== 1 || !live.current) return;
        const to =
          matrixDragHit(event.currentTarget, from.path, event.clientX, event.clientY) ??
          mathHit(event.currentTarget, event.target, event.clientX, event.clientY);
        if (!to) return;
        const same = from.path.join(".") === to.path.join(".");
        if (same && from.caret?.offset === to.caret?.offset && from.caret?.seg === to.caret?.seg) return;
        change(selectRange(live.current, from.path, to.path));
      }}
      onPointerUp={() => {
        press.current = null;
      }}
      onDoubleClick={(event) => {
        // A double click selects the name or number under the pointer.
        const hit = mathHit(event.currentTarget, event.target, event.clientX, event.clientY);
        if (!hit || !live.current) return;
        event.preventDefault();
        event.stopPropagation();
        change(selectRange(live.current, hit.path, hit.path));
      }}
    >
      <MathStatement statement={shown as never} result={result} path={[]} />
      {editor && <EditorOverlay editor={editor} container={ref} />}
    </span>
  );
}
