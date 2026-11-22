// An include region: a frame with the word Include and the path of the
// worksheet it brings in. The path is text the user can edit in place (GitHub ): a double-click on it,
// or the pencil button (the keyboard way), opens a field; Enter or leaving the field commits, Escape cancels. The
// Browse… button chooses the file in the native dialog. The two buttons are screen-only (`no-print`): the print
// draws the frame, the label and the path only, whatever the editing state.

import { useEffect, useRef, useState } from "react";
import { S } from "../strings";

type Props = {
  path: string;
  /** The included worksheet was not found, or its include is a cycle: the warning mark is drawn. */
  missing: boolean;
  /** The path was edited: the typed text, trimmed and never empty. */
  onPath?: (path: string) => void;
  /** Browse… was pressed. */
  onBrowse?: () => void;
};

export function IncludeView({ path, missing, onPath, onBrowse }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);
  const begin = () => {
    setDraft(path);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const typed = draft.trim();
    // An empty path is never a state the user can reach: the field is left as it was.
    if (typed !== "" && typed !== path) onPath?.(typed);
  };
  // The presses inside the controls belong to them: no region drag, no sheet click.
  const own = { onPointerDown: (event: React.PointerEvent) => event.stopPropagation() };
  return (
    <div className={`include-region${missing ? " missing" : ""}`} data-testid="include-region">
      <svg className="frame" width="100%" height="100%" aria-hidden="true">
        <rect x="0" y="0" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth={1.4} />
      </svg>
      <span className="label">{S.page.includeLabel}</span>
      {editing ? (
        <input
          ref={input}
          className="include-path-input"
          aria-label={S.page.includePath}
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          {...own}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") commit();
            else if (event.key === "Escape") {
              setDraft(path);
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
      ) : (
        <span className="path" data-testid="include-path" title={S.page.includeEdit} onDoubleClick={begin}>
          {path}
        </span>
      )}
      {missing && <span className="warning-mark" title={S.page.includeMissing}>!</span>}
      {!editing && (
        <span className="include-tools no-print">
          <button type="button" aria-label={S.page.includeEdit} title={S.page.includeEdit} data-testid="include-edit" onClick={begin} {...own}>
            ✎
          </button>
          <button type="button" aria-label={S.page.includeBrowse} title={S.page.includeBrowse} data-testid="include-browse" onClick={() => onBrowse?.()} {...own}>
            …
          </button>
        </span>
      )}
    </div>
  );
}
