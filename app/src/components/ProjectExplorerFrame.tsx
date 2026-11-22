import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { S } from "../strings";
import "../styles/projectExplorer.css";

const STORAGE_KEY = "equavela.projectExplorer";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 160;
const MAX_WIDTH = 420;
const RAIL_WIDTH = 36;

type Settings = { open: boolean; width: number };

function readSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: true, width: DEFAULT_WIDTH };
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return { open: true, width: DEFAULT_WIDTH };
    const candidate = value as Record<string, unknown>;
    return {
      open: typeof candidate.open === "boolean" ? candidate.open : true,
      width: typeof candidate.width === "number" && Number.isFinite(candidate.width)
        ? clamp(candidate.width)
        : DEFAULT_WIDTH,
    };
  } catch {
    return { open: true, width: DEFAULT_WIDTH };
  }
}

const clamp = (width: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));

export function ProjectExplorerFrame({ children, inspectorOpen, onOpen }: {
  children: ReactNode;
  inspectorOpen: boolean;
  onOpen: () => void;
}) {
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const narrow = viewportWidth <= 1000;
  const maxWidth = narrow ? Math.max(0, Math.min(MAX_WIDTH, viewportWidth - 48)) : MAX_WIDTH;
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const visibleWidth = Math.min(settings.width, maxWidth);
  const clampVisible = (width: number) => Math.max(minWidth, Math.min(maxWidth, width));
  const frame = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const setOpen = useCallback((open: boolean) => {
    if (!open && frame.current?.contains(document.activeElement)) toggle.current?.focus();
    setSettings((current) => ({ ...current, open }));
  }, []);

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* Storage can be unavailable. */ }
  }, [settings]);

  useEffect(() => {
    if (narrow && inspectorOpen && settings.open) setOpen(false);
  }, [inspectorOpen, narrow, settings.open, setOpen]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!settings.open || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: frame.current?.getBoundingClientRect().width || visibleWidth };
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setSettings((current) => ({ ...current, width: clampVisible(active.width + event.clientX - active.x) }));
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    let width: number | undefined;
    if (event.key === "ArrowLeft") width = visibleWidth - 10;
    if (event.key === "ArrowRight") width = visibleWidth + 10;
    if (event.key === "Home") width = minWidth;
    if (event.key === "End") width = maxWidth;
    if (width !== undefined) {
      event.preventDefault();
      setSettings((current) => ({ ...current, width: clampVisible(width!) }));
    }
  };
  const open = () => {
    if (narrow) onOpen();
    setOpen(true);
  };

  return <div
    ref={frame}
    className="project-explorer-frame chrome no-print"
    data-open={settings.open}
    data-narrow={narrow}
    style={{ "--project-explorer-width": `${settings.open ? visibleWidth : RAIL_WIDTH}px` } as CSSProperties}
    onKeyDown={(event) => {
      if (event.key === "Escape" && narrow && settings.open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    }}
  >
    {narrow && settings.open && <button className="project-explorer-backdrop" aria-label={S.project.closeExplorer} onClick={() => setOpen(false)} />}
    <div className="project-explorer-panel" aria-hidden={!settings.open} inert={!settings.open}>
      {children}
    </div>
    {settings.open && <div
      className="project-explorer-resizer"
      role="separator"
      aria-label={S.project.resizeExplorer}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={visibleWidth}
      tabIndex={0}
      onKeyDown={resizeByKey}
      onPointerDown={beginResize}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onLostPointerCapture={() => { drag.current = null; }}
    />}
    <button
      ref={toggle}
      className="project-explorer-toggle"
      aria-label={settings.open ? S.project.collapseExplorer : S.project.expandExplorer}
      title={settings.open ? S.project.collapseExplorer : S.project.expandExplorer}
      onClick={() => settings.open ? setOpen(false) : open()}
    >
      <span aria-hidden="true">{settings.open ? "‹" : "›"}</span>
    </button>
  </div>;
}
