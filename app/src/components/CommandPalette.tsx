// The command palette: one search over commands, operators,
// symbols, constants, units and built-in functions. It shows each entry's shortcut on the
// active layout, so it also teaches the keyboard.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchCommands, type CommandItem } from "../catalog/commands";
import { S } from "../strings";
import { handleInputChord } from "./inputChords";

export function CommandPalette({
  items,
  onRun,
  onClose,
  anchor,
}: {
  items: readonly CommandItem[];
  onRun: (item: CommandItem) => void;
  onClose: () => void;
  anchor?: Pick<DOMRectReadOnly, "left" | "top" | "bottom">;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const activeRow = useRef<HTMLLIElement>(null);
  const listId = useId();
  const results = useMemo(() => searchCommands(items, query, 60, anchor !== undefined), [anchor, items, query]);
  const selectedIndex = Math.min(index, results.length - 1);
  const selected = results[selectedIndex] ?? null;
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));

  useEffect(() => {
    if (!anchor) return;
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [anchor]);

  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    activeRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [index, results]);

  const position = anchor ? (() => {
    const margin = 8;
    const width = Math.min(470, viewport.width - 2 * margin);
    const above = Math.max(0, Math.min(anchor.top - 4, viewport.height - margin) - margin);
    const below = Math.max(0, viewport.height - margin - Math.max(margin, anchor.bottom + 4));
    const showBelow = below >= 260 || below >= above;
    return {
      width,
      left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)),
      maxHeight: Math.max(0, showBelow ? below : above),
      ...(showBelow ? { top: viewport.height - margin - below } : { bottom: viewport.height - margin - above }),
    };
  })() : undefined;
  return (
    <div className={`dialog-backdrop chrome${anchor ? " insertion-backdrop" : ""}`} role="presentation" onPointerDown={onClose}>
      <section
        className="dialog commands-dialog"
        style={position}
        role="dialog"
        aria-modal="true"
        aria-label={anchor ? S.commands.insertTitle : S.commands.title}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            if (results.length > 0) setIndex((i) => (Math.min(i, results.length - 1) + delta + results.length) % results.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            if (selected) onRun(selected);
          }
        }}
      >
        <input
          ref={input}
          type="search"
          role={anchor ? "combobox" : undefined}
          aria-label={anchor ? S.commands.insertSearch : S.commands.search}
          aria-expanded={anchor ? true : undefined}
          aria-autocomplete={anchor ? "list" : undefined}
          aria-controls={anchor ? listId : undefined}
          aria-activedescendant={anchor && selected ? `${listId}-${selectedIndex}` : undefined}
          placeholder={anchor ? S.commands.insertPlaceholder : S.commands.placeholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => void handleInputChord(event)}
        />
        <ul id={listId} className="commands-list" role="listbox" aria-label={S.commands.results}>
          {results.length === 0 && <li className="catalogue-empty">{S.commands.noResults}</li>}
          {results.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-${i}`}
              ref={item === selected ? activeRow : undefined}
              role="option"
              aria-selected={item === selected}
              className={item === selected ? "active" : ""}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onRun(item)}
              onMouseMove={() => setIndex(i)}
            >
              <span className={item.group === "Command" || item.group === "Palette" ? "command-label" : "command-label glyph"}>{item.label}</span>
              <span className="command-title">{item.title}</span>
              <span className="command-group">{item.group}</span>
              {item.shortcut && <kbd className="command-shortcut">{item.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
