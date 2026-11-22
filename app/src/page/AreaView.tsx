// A collapsible area: a section drawn as two horizontal rules, with the title
// in the middle of the start rule and the collapse indicator at the left end of that rule.
// The members are ordinary regions drawn over the band; a collapsed area is only its start rule.
// The indicator toggles the area; a double-click on the title edits it in place.
// Pressing inside the band is a press on the sheet (PageView): it places the crosshair there, so a
// region can be typed into the area instead of collapsing it.
//
// A band that crosses page breaks is drawn part by part: one element per page it reaches.
// Only the part that carries the header draws the start line, the title and the indicator; only the
// part the band ends on draws the end line; a part in between draws nothing at all, because an area
// is a section and not a box.

import { useEffect, useRef, useState } from "react";
import { AREA_HEADER_PT } from "../layout/areas";
import { ptToPx } from "../layout/geometry";
import { S } from "../strings";

type Props = {
  title: string;
  collapsed: boolean;
  /** Height of this part of the band in points (the stored height for a band on one page). */
  height: number;
  /** Width in points: the printable width. */
  width: number;
  /** What this part draws: the header (start line, title, indicator) and the end line. */
  header: boolean;
  end: boolean;
  onTitle?: (title: string) => void;
  /** The collapse indicator was clicked. */
  onToggle?: () => void;
};

export function AreaView({ title, collapsed, height, width, header, end, onTitle, onToggle }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    if (draft !== title) onTitle?.(draft);
  };
  const label = collapsed ? S.page.areaExpand : S.page.areaCollapse;
  return (
    <div
      className={`area-band${collapsed ? " collapsed" : ""}${header ? " start" : ""}${end && !collapsed ? " end" : ""}`}
      data-testid="area"
      data-collapsed={collapsed ? "true" : "false"}
      data-part={header ? "start" : end ? "end" : "middle"}
      style={{ width: ptToPx(width), height: ptToPx(height) }}
    >
      {header && (
        <div className="area-header" style={{ height: ptToPx(AREA_HEADER_PT) }}>
          {/* The disclosure control: the only thing in an area that toggles it. A drawn
              triangle, not a text glyph: the bundled fonts have no such character (print uses only
              them). It stops the press so that the band does not start a drag or a sheet click. */}
          <button
            type="button"
            className="area-indicator"
            aria-expanded={!collapsed}
            aria-label={label}
            title={label}
            data-testid="area-indicator"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d={collapsed ? "M3 1.5 L9.5 6 L3 10.5 Z" : "M1.5 3 L10.5 3 L6 9.5 Z"} fill="currentColor" />
            </svg>
          </button>
          {editing ? (
            <input
              ref={input}
              className="area-title-input"
              aria-label={S.page.areaTitle}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              // Keys and presses inside the field belong to it: no drag, no sheet shortcut.
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commit();
                else if (event.key === "Escape") {
                  setDraft(title);
                  setEditing(false);
                }
              }}
              onBlur={commit}
            />
          ) : (
            <span
              className="area-title"
              data-testid="area-title"
              title={title || S.page.areaTitle}
              onDoubleClick={() => {
                setDraft(title);
                setEditing(true);
              }}
            >
              {title}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
