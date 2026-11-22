// A math box of the status bar's Find and Replace: the structural
// math editor of inline math (`InlineMath`), with the keys of a math region except two. Ctrl+M
// switches Find and Replace back to text mode and Enter is the box's own action.
// It is chrome like the text boxes: no document state, never printed.

import { type ReactNode } from "react";
import type { Node } from "../editor/tree";
import type { LayoutId } from "../keymap/keymap";
import { InlineMath, TextEnvContext } from "../text/InlineMath";
import type { MathClipboard } from "../text/value";
import { isFindModeSwitch } from "./inputChords";

export function FindMathBox({
  tree,
  label,
  layout,
  autoFocus,
  clipboard = null,
  onTree,
  onEnter,
  onToggleMode,
}: {
  /** The tree the box opens with; the parent remounts the box (a `key`) to put a new one in. */
  tree: Node;
  label: string;
  layout: LayoutId;
  autoFocus: boolean;
  /** Copy and paste of math: the math editors' clipboard. */
  clipboard?: MathClipboard | null;
  onTree: (tree: Node) => void;
  /** Enter (`backwards` with Shift). */
  onEnter: (backwards: boolean) => void;
  onToggleMode: () => void;
}): ReactNode {
  return (
    <span
      className="find-math"
      role="group"
      aria-label={label}
      onKeyDownCapture={(event) => {
        if (isFindModeSwitch(event, layout)) {
          event.preventDefault();
          event.stopPropagation();
          onToggleMode();
        } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          onEnter(event.shiftKey);
        }
      }}
    >
      <TextEnvContext.Provider value={{ layout, mathTarget: null, clipboard }}>
        <InlineMath tree={tree} autoFocus={autoFocus} onTree={onTree} onLeave={() => undefined} onEmpty={() => undefined} onFocused={() => undefined} />
      </TextEnvContext.Provider>
    </span>
  );
}
