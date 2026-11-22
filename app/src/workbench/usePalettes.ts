// Open palettes of the Math ribbon: floating panels, one per palette, each
// pinnable. An unpinned palette behaves like a drop-down (it closes after one insertion and when
// another palette opens); a pinned one stays until it is closed. A panel holds the sections of its
// palette as chips; another palette is opened from its Math tab button, not from inside the panel.

import { useCallback, useEffect, useState } from "react";
import type { PaletteKind } from "../catalog/palettes";

/** The rectangle of the button a palette was opened from (client px). */
export type PaletteAnchor = { left: number; bottom: number };

export type OpenPalette = {
  kind: PaletteKind;
  pinned: boolean;
  x: number;
  y: number;
  z: number;
  anchor: PaletteAnchor | null;
  /** The user dragged it: it keeps that position when the window changes. */
  dragged: boolean;
};

/** Width of a palette panel, px (`.palette-panel` in chrome.css, limited by the window). */
const PANEL_WIDTH = 460;
const EDGE = 8;

/** Where a palette opened from a button goes: under it, left-aligned, inside the window. */
export function anchorPosition(anchor: PaletteAnchor, viewportWidth: number): { x: number; y: number } {
  const width = Math.min(PANEL_WIDTH, viewportWidth - 2 * EDGE);
  const x = Math.max(EDGE, Math.min(anchor.left, viewportWidth - width - EDGE));
  return { x, y: anchor.bottom + 2 };
}

export type PaletteControls = {
  palettes: OpenPalette[];
  open: (kind: PaletteKind, anchor?: PaletteAnchor) => void;
  close: (kind: PaletteKind) => void;
  togglePin: (kind: PaletteKind) => void;
  move: (kind: PaletteKind, x: number, y: number) => void;
  front: (kind: PaletteKind) => void;
  /** Called after an entry was used: unpinned palettes close. */
  used: (kind: PaletteKind) => void;
};

export function usePalettes(): PaletteControls {
  const [palettes, setPalettes] = useState<OpenPalette[]>([]);
  const [top, setTop] = useState(1);

  const open = useCallback((kind: PaletteKind, anchor?: PaletteAnchor) => {
    setTop((z) => z + 1);
    setPalettes((current) => {
      if (current.some((p) => p.kind === kind)) return current.filter((p) => p.kind !== kind);
      // The new palette replaces an unpinned one and cascades beside the pinned ones.
      const kept = current.filter((p) => p.pinned);
      const slot = kept.length;
      const at = anchor
        ? anchorPosition(anchor, window.innerWidth)
        : { x: 24 + slot * 36, y: 128 + slot * 36 };
      return [...kept, { kind, pinned: false, ...at, z: top + 1, anchor: anchor ?? null, dragged: false }];
    });
  }, [top]);

  const close = useCallback((kind: PaletteKind) => setPalettes((c) => c.filter((p) => p.kind !== kind)), []);
  const togglePin = useCallback(
    (kind: PaletteKind) => setPalettes((c) => c.map((p) => (p.kind === kind ? { ...p, pinned: !p.pinned } : p))),
    [],
  );
  const move = useCallback(
    (kind: PaletteKind, x: number, y: number) =>
      setPalettes((c) =>
        c.map((p) => (p.kind === kind ? { ...p, x: Math.max(0, x), y: Math.max(0, y), dragged: true } : p)),
      ),
    [],
  );
  const front = useCallback(
    (kind: PaletteKind) => {
      setTop((z) => z + 1);
      setPalettes((c) => c.map((p) => (p.kind === kind ? { ...p, z: top + 1 } : p)));
    },
    [top],
  );
  const used = useCallback((kind: PaletteKind) => setPalettes((c) => c.filter((p) => p.kind !== kind || p.pinned)), []);

  // The window changes size: palettes that were not dragged stay under their button.
  useEffect(() => {
    const resize = () =>
      setPalettes((c) =>
        c.some((p) => p.anchor && !p.dragged)
          ? c.map((p) => (p.anchor && !p.dragged ? { ...p, ...anchorPosition(p.anchor, window.innerWidth) } : p))
          : c,
      );
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // A drop-down closes on a press anywhere outside it (the press still reaches its target, so
  // clicking into the worksheet both closes the palette and places the cursor). Its own toggle
  // button is exempt: it toggles it.
  const anyUnpinned = palettes.some((p) => !p.pinned);
  useEffect(() => {
    if (!anyUnpinned) return undefined;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".palette-panel, [data-palette-toggle]")) return;
      setPalettes((c) => (c.some((p) => !p.pinned) ? c.filter((p) => p.pinned) : c));
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [anyUnpinned]);

  return { palettes, open, close, togglePin, move, front, used };
}
