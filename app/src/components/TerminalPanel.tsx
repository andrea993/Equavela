import { useEffect, useRef, type PointerEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Backend } from "../backend";
import type { TerminalSnapshot } from "../equavelaApi";
import { S } from "../strings";

const failureMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);

export const REPL_MIN = 120;
export const REPL_MAX = 600;

export function TerminalPanel({ target, project, backend, height, onHeight, onClose, onRestart }: {
  target: { key: string; label: string };
  project: string | null;
  backend: Backend;
  height: number;
  onHeight: (height: number) => void;
  onClose: () => void;
  /** Restart REPL. */
  onRestart?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    let active = true;
    let opened = false;
    let generation: number | undefined;
    let sequence = 0;
    let readFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let writes = Promise.resolve();
    let ready: Promise<void>;
    const terminal = new Terminal({ fontFamily: '"Noto Sans Mono", monospace', fontSize: 12, cursorStyle: "block", theme: { background: "#fbfcfe", foreground: "#1d2430", cursor: "#1d2430", cursorAccent: "#fbfcfe" }, scrollback: 5000 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    terminal.focus();
    const resize = () => {
      try { fit.fit(); } catch { return; }
      if (opened && active) void backend.terminalResize(project, terminal.cols, terminal.rows).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    const input = terminal.onData((data) => {
      writes = writes.then(() => ready).then(() => active && opened ? backend.terminalWrite(project, data) : undefined).catch((error) => {
        if (active) terminal.writeln(`\r\n${S.repl.failed(failureMessage(error))}`);
      });
    });
    const apply = (snapshot: TerminalSnapshot) => {
      if (!active) return;
      if (generation !== undefined && generation !== snapshot.generation) {
        terminal.reset();
        terminal.writeln(S.repl.restarted);
      }
      generation = snapshot.generation;
      sequence = snapshot.sequence;
      if (snapshot.data.length) terminal.write(new Uint8Array(snapshot.data));
    };
    const poll = async () => {
      try {
        let snapshot = await backend.terminalRead(project, sequence);
        if (!active) return;
        if (generation !== undefined && snapshot.generation !== generation) {
          // The old byte offset is meaningless in the new process. Fetch its retained
          // output from the beginning before resetting the display.
          const nextGeneration = snapshot.generation;
          snapshot = await backend.terminalRead(project, 0);
          if (!active) return;
          if (snapshot.generation !== nextGeneration) {
            timer = setTimeout(poll, 100);
            return;
          }
        }
        apply(snapshot);
        readFailures = 0;
      } catch (error) {
        if (active && readFailures === 0) terminal.writeln(`\r\n${S.repl.failed(failureMessage(error))}`);
        readFailures++;
      }
      if (active) timer = setTimeout(poll, Math.min(2000, 100 * 2 ** Math.min(readFailures, 5)));
    };
    ready = backend.terminalOpen(project, terminal.cols, terminal.rows).then((snapshot) => {
      if (!active) return;
      opened = true;
      apply(snapshot);
      resize();
      timer = setTimeout(poll, 100);
    }).catch((error) => { if (active) terminal.writeln(`\r\n${S.repl.failed(failureMessage(error))}`); });
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [backend, project]);

  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const startY = event.clientY;
    const move = (moved: globalThis.PointerEvent) => onHeight(Math.min(REPL_MAX, Math.max(REPL_MIN, height + startY - moved.clientY)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <section className="chrome repl-panel" aria-label={S.repl.title} style={{ height }}>
    <div className="repl-separator" role="separator" aria-orientation="horizontal" aria-label={S.repl.resize} aria-valuemin={REPL_MIN} aria-valuemax={REPL_MAX} aria-valuenow={height} tabIndex={0} onPointerDown={drag} onKeyDown={(event) => {
      if (event.key === "ArrowUp") onHeight(Math.min(REPL_MAX, height + 20));
      if (event.key === "ArrowDown") onHeight(Math.max(REPL_MIN, height - 20));
    }} />
    <div className="repl-head"><span className="repl-title">{S.repl.title}</span><span className="repl-target">{target.label}</span><span className="grow" />{onRestart && <button type="button" className="repl-restart" title={S.repl.restartTitle} onClick={onRestart}>{S.repl.restart}</button>}<button type="button" aria-label={S.repl.close} title={S.repl.close} onClick={onClose}>×</button></div>
    <div className="terminal-host" ref={host} aria-label={S.repl.output} />
  </section>;
}
