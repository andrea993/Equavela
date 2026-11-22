// The right-click menu: a popup of the app's own commands under the
// pointer. It is chrome (never printed), keyboard operable (arrows, Home, End, Enter, Escape) and closes on a
// press outside or when the window loses the pointer's context. The webview's own menu (Back, Reload, Save as,
// Inspect, ...) is never shown anywhere in the window.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextMenuItem =
  | { kind: "separator" }
  | { kind: "item"; id: string; label: string; shortcut?: string | null; disabled?: boolean; strong?: boolean };

type Props = {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
  label: string;
  onChoose: (id: string) => void;
  onClose: () => void;
};

export function ContextMenu({ x, y, items, label, onChoose, onClose }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const enabled = items.flatMap((item, index) => (item.kind === "item" && !item.disabled ? [index] : []));
  const [active, setActive] = useState<number | null>(enabled[0] ?? null);

  // Keep the menu inside the window: flip it left or up when it would leave it.
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const left = Math.max(0, x + box.width > window.innerWidth ? x - box.width : x);
    const top = Math.max(0, y + box.height > window.innerHeight ? y - box.height : y);
    setPosition({ left, top });
  }, [x, y]);

  useEffect(() => {
    root.current?.focus();
    // A press outside, the wheel, a resize or another context menu close it.
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("contextmenu", outside, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("contextmenu", outside, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const move = (step: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = active === null ? -1 : enabled.indexOf(active);
    setActive(enabled[(at + step + enabled.length) % enabled.length]);
  };
  const choose = (index: number | null) => {
    const item = index === null ? undefined : items[index];
    if (item?.kind === "item" && !item.disabled) {
      onClose();
      onChoose(item.id);
    }
  };

  return (
    <div
      ref={root}
      className="chrome context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-testid="context-menu"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => {
        // The keys of the menu are the menu's: nothing reaches the sheet behind it.
        event.stopPropagation();
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else if (event.key === "Home") setActive(enabled[0] ?? null);
        else if (event.key === "End") setActive(enabled[enabled.length - 1] ?? null);
        else if (event.key === "Enter" || event.key === " ") choose(active);
        else if (event.key === "Escape" || event.key === "Tab") onClose();
        else return;
        event.preventDefault();
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item.kind === "separator" ? (
          <div key={`s${index}`} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`context-menu-item${active === index ? " active" : ""}${item.strong ? " strong" : ""}`}
            disabled={item.disabled}
            data-cmd={item.id}
            onPointerEnter={() => !item.disabled && setActive(index)}
            onClick={() => choose(index)}
          >
            <span className="context-menu-label">{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
