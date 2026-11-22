// The message bar under the document tabs: one style per level. The level is
// told by colour, by a leading symbol (so colour is not the only cue) and by the live-region role: errors
// and warnings interrupt (`alert`), successes and hints do not (`status`).

import type { MessageLevel } from "../workbench/useWorkbench";
import { S } from "../strings";

/** The symbol drawn before a message. */
export const MESSAGE_MARKS: Record<MessageLevel, string> = { success: "✓", info: "i", warning: "!", error: "✕" };

/** How long a success message stays before it dismisses itself; the others stay until dismissed. */
export const SUCCESS_MESSAGE_MS = 6000;

export function MessageBar({ text, level, onDismiss }: { text: string; level: MessageLevel; onDismiss: () => void }) {
  return (
    <div
      className={`chrome message-bar message-${level}`}
      role={level === "error" || level === "warning" ? "alert" : "status"}
      data-level={level}
    >
      <span className="message-text">
        <span className="message-mark" aria-hidden="true">{MESSAGE_MARKS[level]}</span>
        {text}
      </span>
      <button type="button" onClick={onDismiss} aria-label={S.messages.dismiss}>
        ×
      </button>
    </div>
  );
}
