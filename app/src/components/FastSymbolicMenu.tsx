import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FAST_SYMBOLIC, type FastSymbolicOperation, type FastSymbolicOptions } from "../editor/fastSymbolic";

export function FastSymbolicMenu({ anchor, quick, entries, options, onOptions, onRun, onClose }: {
  anchor: DOMRectReadOnly;
  quick: boolean;
  entries: readonly ((typeof FAST_SYMBOLIC)[number] & { enabled: boolean })[];
  options: FastSymbolicOptions;
  onOptions: (options: FastSymbolicOptions) => void;
  onRun: (operation: FastSymbolicOperation) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(8);
  useLayoutEffect(() => {
    const place = () => {
      const height = Math.min(panel.current?.scrollHeight ?? 0, window.innerHeight - 16);
      const below = anchor.bottom + 5;
      const above = anchor.top - height - 5;
      const best = below + height <= window.innerHeight - 8 ? below : above;
      setTop(Math.max(8, Math.min(best, window.innerHeight - height - 8)));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) onClose(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 258));
  return (
    <div ref={panel} role="dialog" aria-label="Fast Symbolic" tabIndex={-1}
      className="fast-symbolic-menu" style={{ left, top }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(true); return; }
        if (!quick || event.ctrlKey || event.altKey || event.metaKey || event.nativeEvent.isComposing) return;
        const item = entries.find(entry => entry.key === event.key.toLowerCase());
        if (!item) return;
        event.preventDefault();
        if (item.enabled) onRun(item.id);
      }}>
      {!quick && <div className="fast-symbolic-options">
        <label><input type="checkbox" checked={options.inPlace}
          onChange={event => onOptions({ ...options, inPlace: event.target.checked })} /> Evaluate in place</label>
        <label><input type="checkbox" checked={options.worksheetVariables}
          onChange={event => onOptions({ ...options, worksheetVariables: event.target.checked })} /> Worksheet variables</label>
      </div>}
      {entries.map(item => <button key={item.id} type="button" disabled={!item.enabled} onClick={() => onRun(item.id)}>
        <span>{item.label}</span>{quick && <kbd>{item.key.toUpperCase()}</kbd>}
      </button>)}
    </div>
  );
}
