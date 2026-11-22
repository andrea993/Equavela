// Floating, pinnable palettes of the Math ribbon, each with a search box
// and a row of chips holding the sections of its own list. They are not modal: buttons never
// take keyboard focus from the math editor, so a pinned palette can be used while typing. An
// unpinned palette closes after one insertion.

import { useEffect, useMemo, useRef, useState } from "react";
import { shortcutLabel, type LayoutId } from "../keymap/keymap";
import {
  filterSections,
  PALETTE_KINDS,
  paletteSections,
  type PaletteAction,
  type PaletteEntry,
  type PaletteKind,
  type PaletteSection,
} from "../catalog/palettes";
import { UNIT_PREFIXES } from "../catalog/units";
import { S } from "../strings";
import type { OpenPalette, PaletteControls } from "../workbench/usePalettes";
import { handleInputChord } from "./inputChords";

/**
 * : the sections a panel shows. Without a query, its own palette; with one, the matches of
 * every palette, its own first, the others' sections titled with their palette.
 */
export function panelSections(kind: PaletteKind, prefix: string, query: string): PaletteSection[] {
  const own = filterSections(paletteSections(kind, prefix), query);
  if (!query.trim()) return own;
  const others = PALETTE_KINDS.filter((other) => other !== kind).flatMap((other) =>
    filterSections(paletteSections(other), query).map((section) => ({
      ...section,
      id: `${other}:${section.id}`,
      title: `${S.ribbon.paletteShort[other]}: ${section.title}`,
    })),
  );
  return [...own, ...others];
}

/** px of slack for a fractional scroll offset, inside which a heading counts as at the top. */
const TOP_TOLERANCE = 1;

/**
 * : the section at the top of the list for a scroll offset — the last one whose heading has
 * passed the top — so a chip stays highlighted until the next section reaches the top.
 */
export function topSection(tops: readonly number[], scrollTop: number): number {
  let index = 0;
  tops.forEach((top, at) => {
    if (top < scrollTop + TOP_TOLERANCE) index = at;
  });
  return index;
}

/**
 * : the scroll offset a chip asks for: the top of its section, or as far as the list goes when
 * the section is too near the end to reach the top.
 */
export function scrollTarget(tops: readonly number[], index: number, maxScroll: number): number {
  return Math.max(0, Math.min(tops[index] ?? 0, maxScroll));
}

/**
 * The top of `el` measured from the top of the scrolling list's content, px: the offsets of both
 * chains of offset parents, which are equal above the list.
 */
function topInList(el: HTMLElement, list: HTMLElement): number {
  const fromViewport = (node: HTMLElement | null): number => {
    let top = 0;
    for (; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
    return top;
  };
  return fromViewport(el) - fromViewport(list);
}

export function entryTitle(entry: PaletteEntry, layout: LayoutId): string {
  if (entry.disabled) return `${entry.title} (${entry.disabled})`;
  const shortcut = entry.action.kind === "command" ? shortcutLabel(layout, entry.action.command) : null;
  return shortcut ? `${entry.title} (${shortcut})` : entry.title;
}

function PalettePanel({
  palette,
  layout,
  controls,
  onRun,
  onEscape,
}: {
  palette: OpenPalette;
  layout: LayoutId;
  controls: PaletteControls;
  onRun: (action: PaletteAction) => void;
  onEscape: () => void;
}) {
  const { kind, pinned } = palette;
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState("");
  /** The chip of the section at the top of the list. */
  const [current, setCurrent] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** The chip pressed last: a section the list cannot bring to the top keeps its highlight. */
  const pressed = useRef<{ index: number; scrollTop: number } | null>(null);
  const title = S.ribbon.palette[kind];
  const sections = useMemo(() => panelSections(kind, prefix, query), [kind, prefix, query]);

  useEffect(() => {
    if (!pinned) search.current?.focus();
  }, [pinned]);

  // A new list starts at its top, with its first chip highlighted.
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    pressed.current = null;
    setCurrent(0);
  }, [query, prefix]);

  // An unpinned palette is a drop-down: Escape closes it, wherever the focus is.
  useEffect(() => {
    if (pinned) return undefined;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      controls.close(kind);
      onEscape();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pinned, kind, controls.close, onEscape]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (entry: PaletteEntry) => {
    if (entry.disabled) return;
    onRun(entry.action);
    controls.used(kind);
  };

  /** The top of each shown section, measured from the top of the list's content. */
  const tops = (): number[] => {
    const body = list.current;
    if (!body) return sections.map(() => 0);
    return [...body.querySelectorAll<HTMLElement>(".palette-section")].map((section) => topInList(section, body));
  };

  /** a chip scrolls its section to the top of the list and becomes the highlighted one. */
  const show = (index: number) => {
    setCurrent(index);
    const body = list.current;
    if (!body) return;
    body.scrollTop = scrollTarget(tops(), index, body.scrollHeight - body.clientHeight);
    pressed.current = { index, scrollTop: body.scrollTop };
  };

  /** the highlight follows the scroll of the list. */
  const spied = () => {
    const body = list.current;
    if (!body) return;
    const held = pressed.current;
    let next: number;
    if (held && Math.abs(body.scrollTop - held.scrollTop) <= 1) {
      // The section never reached the top (the list ends first): its chip stays highlighted.
      next = held.index;
    } else {
      pressed.current = null;
      next = topSection(tops(), body.scrollTop);
    }
    // The list is long (a unit per entry): a scroll that changes no chip redraws nothing.
    setCurrent((was) => (was === next ? was : next));
  };

  const dragStart = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const origin = { x: event.clientX - palette.x, y: event.clientY - palette.y };
    const move = (e: PointerEvent) => controls.move(kind, e.clientX - origin.x, e.clientY - origin.y);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section
      className="chrome math-palette palette-panel"
      role="dialog"
      aria-label={title}
      data-pinned={pinned}
      // Never past the bottom of the window, wherever the panel is: the list scrolls inside.
      style={{ left: palette.x, top: palette.y, zIndex: 40 + palette.z, maxHeight: `calc(100vh - ${Math.max(0, palette.y) + 8}px)` }}
      onPointerDown={() => controls.front(kind)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        controls.close(kind);
        onEscape();
      }}
    >
      <header onPointerDown={dragStart}>
        <h2>{title}</h2>
        <button
          type="button"
          className="palette-pin"
          aria-pressed={pinned}
          aria-label={pinned ? S.ribbon.palette.unpin : S.ribbon.palette.pin}
          title={pinned ? S.ribbon.palette.unpin : S.ribbon.palette.pin}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            search.current?.blur();
            controls.togglePin(kind);
          }}
        >
          {pinned ? "◉" : "○"}
        </button>
        <button
          type="button"
          aria-label={S.ribbon.palette.close}
          title={S.ribbon.palette.close}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => controls.close(kind)}
        >
          ×
        </button>
      </header>
      <div className="palette-sections" role="group" aria-label={S.ribbon.palette.sections}>
        {sections.map((group, index) => (
          <button
            type="button"
            key={group.id}
            aria-current={index === current ? "true" : undefined}
            title={S.ribbon.palette.goToSection(group.title)}
            className={index === current ? "active" : ""}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => show(index)}
          >
            {group.title}
          </button>
        ))}
      </div>
      <input
        ref={search}
        className="palette-search"
        type="search"
        aria-label={S.ribbon.palette.search}
        placeholder={S.ribbon.palette.searchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (handleInputChord(event)) return;
          if (event.key === "Enter") {
            event.preventDefault();
            const first = sections.flatMap((s) => s.entries).find((e) => !e.disabled);
            if (first) run(first);
          }
        }}
      />
      {kind === "units" && (
        <div className="palette-prefixes" role="group" aria-label={S.ribbon.palette.prefixes}>
          {[{ prefix: "", power: 0 }, ...UNIT_PREFIXES].map((p) => (
            <button
              type="button"
              key={p.prefix || "none"}
              aria-pressed={prefix === p.prefix}
              className={prefix === p.prefix ? "active" : ""}
              title={p.prefix ? `${p.prefix}: 10^${p.power}` : S.ribbon.palette.noPrefix}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setPrefix(p.prefix)}
            >
              {p.prefix || "–"}
            </button>
          ))}
        </div>
      )}
      <div className="palette-body" ref={list} onScroll={spied}>
        {sections.length === 0 && <p className="palette-empty">{S.ribbon.palette.noResults}</p>}
        {sections.map((group) => (
          <div className="palette-section" key={group.id}>
            <h3>{group.title}</h3>
            <div className="palette-grid">
              {group.entries.map((entry, index) => (
                <button
                  type="button"
                  key={`${entry.label}-${index}`}
                  title={entryTitle(entry, layout)}
                  disabled={!!entry.disabled}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run(entry)}
                >
                  {entry.glyph ?? entry.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PaletteLayer({
  controls,
  layout,
  onRun,
  onEscape,
}: {
  controls: PaletteControls;
  layout: LayoutId;
  onRun: (action: PaletteAction) => void;
  onEscape: () => void;
}) {
  return (
    <>
      {controls.palettes.map((palette) => (
        <PalettePanel key={palette.kind} palette={palette} layout={layout} controls={controls} onRun={onRun} onEscape={onEscape} />
      ))}
    </>
  );
}
