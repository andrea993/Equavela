import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProjectImageUsage } from "../equavelaApi";
import { S } from "../strings";

const messageOf = (reason: unknown) => typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason);

/** A fresh, explicit snapshot of image assets and the worksheets that reference them. */
export function ProjectImageUsageDialog({ load, onOpenWorksheet, onClose }: {
  load: () => Promise<ProjectImageUsage[]>;
  onOpenWorksheet: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ProjectImageUsage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      setRows(await load());
    } catch (reason) {
      setRows(null);
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    void refresh();
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!opening) onClose();
    }
    if (event.key === "Tab") {
      const fields = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      if (!fields.length) { event.preventDefault(); return; }
      const index = fields.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && (index === -1 || index === fields.length - 1)) { event.preventDefault(); fields[0].focus(); }
    }
  };

  const openWorksheet = async (path: string) => {
    setOpening(path);
    setError("");
    try { await onOpenWorksheet(path); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setOpening(null); }
  };

  return <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => { if (!opening) onClose(); }}>
    <div ref={dialog} tabIndex={-1} className="dialog project-image-usage-dialog" role="dialog" aria-modal="true" aria-labelledby="project-image-usage-title" aria-busy={busy} onPointerDown={(event) => event.stopPropagation()} onKeyDown={keyDown}>
      <h2 id="project-image-usage-title">{S.project.imageUsageTitle}</h2>
      {error && <div className="project-error" role="alert">{error}</div>}
      {busy && <p role="status">{S.project.refreshResources}…</p>}
      {!busy && rows === null && !error && <p role="status">{S.project.noImageResources}</p>}
      {!busy && rows !== null && (rows.length === 0
        ? <p role="status">{S.project.noImageResources}</p>
        : <div className="project-image-usage-table-wrap"><table><thead><tr><th>{S.project.resourcePath}</th><th>{S.project.usedBy}</th><th>{S.project.resourceStatus}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.path}>
            <td>{row.path}</td>
            <td>{row.worksheets.length ? row.worksheets.map((path) => <button className="project-image-owner" type="button" key={path} disabled={busy || opening !== null} onClick={() => void openWorksheet(path)}>{path}</button>) : S.project.resourceUnused}</td>
            <td>{row.problem ? <><span>{S.project.resourceUnavailable}</span>: {row.problem}</> : S.project.resourceAvailable}</td>
          </tr>)}</tbody></table></div>)}
      <div className="dialog-buttons">
        <button type="button" disabled={busy || opening !== null} onClick={() => void refresh()}>{S.project.refreshResources}</button>{" "}
        <button type="button" disabled={opening !== null} onClick={onClose}>{S.environment.close}</button>
      </div>
    </div>
  </div>;
}
