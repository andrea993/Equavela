import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProjectTextRecovery, ProjectTextRecoveryListing } from "../equavelaApi";
import { S } from "../strings";

function message(reason: unknown): string {
  return typeof reason === "object" && reason !== null && "message" in reason
    ? String(reason.message) : String(reason);
}

function dateLabel(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function dateTime(value: number): string | undefined {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Browses project text backups without opening or changing their original source files. */
export function ProjectTextRecoveryDialog({ load, read, exportCopy, discard, onClose }: {
  load: () => Promise<ProjectTextRecoveryListing>;
  read: (id: string) => Promise<ProjectTextRecovery>;
  exportCopy: (id: string) => Promise<string | null>;
  discard: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [listing, setListing] = useState<ProjectTextRecoveryListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProjectTextRecovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const refresh = async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    setListing(null);
    setSelected(null);
    setPreview(null);
    setSavedPath("");
    setConfirmDiscard(false);
    try {
      const result = await load();
      if (generation.current === request) setListing(result);
    } catch (reason) {
      if (generation.current === request) setError(message(reason));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    void refresh();
    dialog.current?.focus();
    return () => { generation.current++; previous?.focus(); };
  }, []);

  const select = async (id: string) => {
    const request = ++generation.current;
    setSelected(id);
    setPreview(null);
    setError("");
    setSavedPath("");
    setConfirmDiscard(false);
    setLoading(true);
    try {
      const result = await read(id);
      if (generation.current === request) setPreview(result);
    } catch (reason) {
      if (generation.current === request) setError(message(reason));
    } finally {
      if (generation.current === request) setLoading(false);
    }
  };

  const saveCopy = async () => {
    if (!selected) return;
    setBusy(true); setError(""); setSavedPath("");
    try {
      const path = await exportCopy(selected);
      if (path) setSavedPath(path);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  const discardBackup = async () => {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      await discard(selected);
      setSelected(null); setPreview(null); setConfirmDiscard(false);
      await refresh();
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key === "Tab") {
      const fields = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? [])];
      if (!fields.length) { event.preventDefault(); return; }
      const index = fields.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && (index === -1 || index === fields.length - 1)) { event.preventDefault(); fields[0].focus(); }
    }
  };

  const current = listing?.entries.find((entry) => entry.id === selected);
  return <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => { if (!busy) onClose(); }}>
    <div ref={dialog} className="dialog project-text-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="project-text-recovery-title" aria-busy={busy || loading} tabIndex={-1} onPointerDown={(event) => event.stopPropagation()} onKeyDown={keyDown}>
      <h2 id="project-text-recovery-title">{S.project.recoveryBrowserTitle}</h2>
      <p className="project-settings-hint">{S.project.recoveryLiveHint}</p>
      {error && <div className="project-error" role="alert">{error}</div>}
      {listing && listing.unreadable > 0 && <p role="status">{S.project.recoveryUnreadable(listing.unreadable)}</p>}
      <div className="project-text-recovery-layout">
        <section aria-label={S.project.recoveryFile} className="project-text-recovery-list">
          {loading && <p role="status">{S.project.refreshResources}…</p>}
          {!loading && listing && listing.entries.length === 0 && <p role="status">{S.project.recoveryEmpty}</p>}
          {listing && <ul>{listing.entries.map((entry) => <li key={entry.id}>
            <button type="button" aria-pressed={selected === entry.id} disabled={busy} onClick={() => void select(entry.id)}>
              <span>{entry.root}</span><span>{entry.path}</span><time dateTime={dateTime(entry.modified_ms)}>{dateLabel(entry.modified_ms)}</time>
            </button>
          </li>)}</ul>}
        </section>
        <section className="project-text-recovery-preview" aria-label={S.project.recoveryPreview}>
          {current && <><h3>{S.project.recoveryOriginalProject}</h3><p>{current.root}</p><p>{current.path}</p></>}
          {preview && <pre aria-label={S.project.recoveryPreview} tabIndex={0}>{preview.text}</pre>}
        </section>
      </div>
      {savedPath && <p role="status">{S.project.recoverySavedCopy(savedPath)}</p>}
      {confirmDiscard && <div className="project-error" role="group" aria-label={S.project.recoveryDiscardConfirm}>
        <span>{S.project.recoveryDiscardConfirm}</span>{" "}
        <button type="button" disabled={busy} onClick={() => void discardBackup()}>{S.project.recoveryDiscard}</button>{" "}
        <button type="button" disabled={busy} onClick={() => setConfirmDiscard(false)}>{S.project.cancel}</button>
      </div>}
      <div className="dialog-buttons">
        <button type="button" disabled={busy || loading || !preview} onClick={() => void saveCopy()}>{S.project.recoverySaveCopy}</button>{" "}
        <button type="button" disabled={busy || loading || !preview} onClick={() => { setError(""); setConfirmDiscard(true); }}>{S.project.recoveryDiscard}</button>{" "}
        <button type="button" disabled={busy} onClick={() => void refresh()}>{S.project.refreshResources}</button>{" "}
        <button type="button" disabled={busy} onClick={onClose}>{S.environment.close}</button>
      </div>
    </div>
  </div>;
}
