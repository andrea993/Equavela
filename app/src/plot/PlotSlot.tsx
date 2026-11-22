// One editable math placeholder of a plot: an axis expression or an axis limit. It is used on the
// plot region and, for the selected trace's expressions, on the Plot tab of the ribbon.
// It reuses the structural math editor (`InlineMath`) exactly as inline
// math in a text region does, and stores nothing itself: `onCommit` receives the new stored text.

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { isClipboardBox } from "../clipboard";
import { InlineMath } from "../text/InlineMath";
import { emptyStatement, type Node } from "../editor/tree";
import { MathNamesContext } from "../math/render";
import { PlotContext } from "./PlotContext";
import type { TraceSample } from "./adapter";

export type SlotProps = {
  text: string;
  label: string;
  /** Called with the new stored text when the edit is committed and changed something. */
  onCommit: (text: string) => void;
  /** Shift+Enter inside the expression. */
  onShiftEnter?: () => void;
  autoFocus?: boolean;
  className?: string;
  /** The trace this expression slot belongs to; absent for the four axis-limit slots. */
  traceId?: string;
  /** Whether the trace is selected. */
  selected?: boolean;
  /** Selects this slot's trace when it is pressed or focused. */
  onSelect?: () => void;
  /** Called on every press on the slot: the plot region becomes the selection. */
  onActivate?: () => void;
  /** The trace's line sample, drawn under a filled y expression on the plot. */
  sample?: TraceSample;
  /**
   * Whether this slot is a **unit context** — the display unit of an axis, where every plain name is a
   * unit. An axis expression is a value
   * position and leaves this false.
   */
  unitContext?: boolean;
  /**
   * While the slot is being edited, the width the typeset expression needs, on every change; null when
   * the edit ends. The plot column follows it so the expression stays readable.
   */
  onLiveWidth?: (px: number | null) => void;
  /**
   * A field of the Plot tab, one ribbon row high: a taller expression is drawn scaled down to the
   * row, and while it is edited it opens full size in a box over the ribbon, which clips its groups.
   */
  fitRow?: boolean;
};

/** Plotly's dash patterns at the sample's line width (adapter.ts DASHES). */
const SAMPLE_DASHES: Record<TraceSample["dash"], string | undefined> = {
  solid: undefined,
  dot: "2 2",
  dash: "6 4",
  dashdot: "6 2 2 2",
};

/** The line sample under a trace's y expression: part of the plot, printed, no control. */
function TraceSampleLine({ sample }: { sample: TraceSample }) {
  return (
    <svg className="plot-trace-sample" aria-hidden="true" preserveAspectRatio="none" height="3">
      <line x1="0" y1="1.5" x2="100%" y2="1.5" stroke={sample.color} strokeWidth="2" strokeDasharray={SAMPLE_DASHES[sample.dash]} />
    </svg>
  );
}

/** Puts the keyboard into the math placeholder of a slot (its caret starts at the end). */
function focusSlot(slot: HTMLElement) {
  slot.querySelector<HTMLElement>('[data-testid="inline-math"]')?.focus();
}

/** One editable math placeholder. */
export function Slot({
  text,
  label,
  onCommit,
  onShiftEnter,
  autoFocus = false,
  className = "",
  traceId,
  selected = false,
  onSelect,
  onActivate,
  sample,
  unitContext = false,
  onLiveWidth,
  fitRow = false,
}: SlotProps) {
  const context = useContext(PlotContext);
  // A unit context reads every plain name as a unit: the axis display unit does.
  const outerNames = useContext(MathNamesContext);
  const names = unitContext ? { units: outerNames.units, unitContext: true } : outerNames;
  // The conversions are stable; the revision in the context changes with every calculation and must
  // not reset a slot that is being edited.
  const env = useRef(context);
  env.current = context;
  const available = context !== null;
  const [tree, setTree] = useState<Node>(() => emptyStatement());
  const [ready, setReady] = useState(false);
  const edited = useRef<Node | null>(null);
  const committed = useRef(text);
  committed.current = text;
  // The slot has the keyboard: it is drawn over the plot and reports its width.
  const [editing, setEditing] = useState(false);
  const slot = useRef<HTMLSpanElement>(null);
  const reportWidth = useRef(onLiveWidth);
  reportWidth.current = onLiveWidth;

  // While editing, the typeset expression is measured on every change, as the mirror measures a
  // committed one (`measure.tsx`: the layout width and one pixel for a fractional glyph edge).
  useLayoutEffect(() => {
    const element = slot.current;
    if (!editing || !element || !reportWidth.current) return undefined;
    const measure = () => {
      const math = element.querySelector<HTMLElement>('[data-testid="inline-math"] > :first-child');
      if (math) reportWidth.current?.(math.offsetWidth + 1);
    };
    measure();
    const observer = new MutationObserver(measure);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      reportWidth.current?.(null);
    };
  }, [editing]);

  // a ribbon field fits its row when idle and floats full size over the ribbon while edited.
  useLayoutEffect(() => {
    const element = slot.current;
    const math = element?.querySelector<HTMLElement>('[data-testid="inline-math"]');
    if (!fitRow || !element || !math) return undefined;
    const content = math.firstElementChild instanceof HTMLElement ? math.firstElementChild : null;
    if (content) content.style.zoom = "";
    if (editing) {
      const box = element.getBoundingClientRect();
      math.classList.add("floating");
      Object.assign(math.style, { left: `${box.left}px`, top: `${box.top}px`, minWidth: `${box.width}px` });
      return () => {
        math.classList.remove("floating");
        Object.assign(math.style, { left: "", top: "", minWidth: "" });
      };
    }
    const room = element.clientHeight - 2;
    const height = content?.offsetHeight ?? 0;
    if (content && room > 0 && height > room) content.style.zoom = String(room / height);
    return undefined;
  }, [fitRow, editing, ready, tree]);

  // The committed text becomes the tree to show (and to start editing from).
  useEffect(() => {
    let current = true;
    if (!available) return undefined;
    void env.current?.toTree(text).then((next) => {
      if (current) {
        setTree(next);
        edited.current = null;
        setReady(true);
      }
    });
    return () => {
      current = false;
    };
  }, [available, text]);

  const commit = useCallback(async () => {
    const tree = edited.current;
    edited.current = null;
    if (!tree || !env.current) return;
    let next: string;
    try {
      next = await env.current.toText(tree);
    } catch {
      // Incomplete: the stored expression stays, and the slot shows it again.
      setTree((previous) => ({ ...previous }));
      return;
    }
    if (next !== committed.current) onCommit(next);
  }, [onCommit]);

  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Tab") {
      // Tab and Shift+Tab walk through the placeholders of the plot (y max, y expressions, y min,
      // x min, x expressions, x max), committing the one that is left.
      const slots = Array.from(
        event.currentTarget.closest(".plot-region")?.querySelectorAll<HTMLElement>('[data-testid="plot-slot"]') ?? [],
      );
      const target = slots[slots.indexOf(event.currentTarget) + (event.shiftKey ? -1 : 1)];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        void commit();
        focusSlot(target);
      } else {
        // Outside a plot region (the Plot tab) or past the last placeholder: Tab leaves the field.
        void commit();
      }
      return;
    }
    if (event.key === "Enter" && event.shiftKey && onShiftEnter) {
      event.preventDefault();
      event.stopPropagation();
      void commit().then(onShiftEnter);
    }
  };

  return (
    <span
      ref={slot}
      className={`plot-slot ${className}${text === "" ? " empty" : ""}${selected ? " selected" : ""}${editing ? " editing" : ""}`}
      role="group"
      aria-label={label}
      data-testid="plot-slot"
      {...(traceId ? { "data-trace-id": traceId } : {})}
      {...(traceId ? { "data-selected": selected ? "true" : "false" } : {})}
      onKeyDownCapture={keyDown}
      // A press anywhere on the slot (its padding and the empty placeholder included) edits it. The
      // press must neither start a drag of the region nor change the selection, so it stops here.
      onPointerDown={(event) => {
        event.stopPropagation();
        onActivate?.();
        onSelect?.();
        if (!(event.target as Element).closest('[data-testid="inline-math"]')) {
          event.preventDefault();
          focusSlot(event.currentTarget);
        }
      }}
      onBlur={(event) => {
        // A paste reads the clipboard through a hidden textarea and the focus comes straight back:
        // that is not leaving the slot, which would commit the expression without the paste.
        if (isClipboardBox(event.relatedTarget)) return;
        if (!event.currentTarget.contains(event.relatedTarget as Element | null)) {
          setEditing(false);
          void commit();
        }
      }}
    >
      {ready && (
        <MathNamesContext.Provider value={names}>
          <InlineMath
            tree={tree}
            autoFocus={autoFocus}
            onTree={(next) => {
              edited.current = next;
            }}
            onLeave={() => void commit()}
            onEmpty={() => undefined}
            onFocused={() => {
              setEditing(true);
              onActivate?.();
              onSelect?.();
            }}
          />
        </MathNamesContext.Provider>
      )}
      {sample && text !== "" && <TraceSampleLine sample={sample} />}
    </span>
  );
}
