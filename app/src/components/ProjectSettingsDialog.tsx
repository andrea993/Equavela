import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ExportInfo, OpenedProject } from "../equavelaApi";
import { S } from "../strings";

/** The project settings that are safe to change without renaming its Julia package or environment. */
export function ProjectSettingsDialog({ project, exports, onStopExporting, onGoToExport, onEnvironment, onReveal, onUsage, onClose }: {
  project: OpenedProject;
  /** the specification : the project's exports, when known. */
  exports?: ExportInfo[];
  onStopExporting?: (path: string, region: string) => Promise<void>;
  onGoToExport?: (path: string, region: string) => Promise<void>;
  onEnvironment: () => Promise<void>;
  onReveal: () => void;
  onUsage?: () => void;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    // nothing here is edited any more (no main worksheet): OK closes.
    onClose();
  };

  const act = async (run: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await run();
    } catch (reason) {
      setError(typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const manageEnvironment = async () => {
    setError("");
    setBusy(true);
    try {
      await onEnvironment();
    } catch (reason) {
      setError(typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    }
    if (event.key === "Tab") {
      const fields = [...(form.current?.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)") ?? [])];
      if (fields.length === 0) { event.preventDefault(); return; }
      const index = fields.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); fields[fields.length - 1].focus(); }
      else if (!event.shiftKey && (index === -1 || index === fields.length - 1)) { event.preventDefault(); fields[0].focus(); }
    }
  };

  const environment = project.manifest.environment ?? S.project.sharedEnvironment;
  return <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => { if (!busy) onClose(); }}>
    <form
      ref={form}
      className="dialog project-settings-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-settings-title"
      aria-busy={busy}
      onPointerDown={(event) => event.stopPropagation()}
      onSubmit={(event) => void submit(event)}
      onKeyDown={keyDown}
    >
      <h2 id="project-settings-title">{S.project.settingsTitle}</h2>
      <dl>
        <dt>{S.project.name}</dt><dd>{project.manifest.name}</dd>
        <dt>{S.project.directory}</dt><dd className="environment-path">{project.root}</dd>
        <dt>{S.project.projectId}</dt><dd>{project.manifest.project_id}</dd>
        <dt>{S.project.environmentSetting}</dt><dd className="environment-path">{environment}</dd>
      </dl>
      <p className="project-settings-hint">{S.project.environmentScope}</p>
      {exports && <section className="project-exports" aria-label={S.references.exports}>
        <h3>{S.references.exports}</h3>
        {exports.length === 0 ? <p className="project-settings-hint">{S.references.noExports}</p> : <ul>
          {exports.map((entry) => <li key={entry.id}>
            <span className="project-export-name">{entry.api ? S.references.signature(entry.api.name, entry.api.kind, entry.api.arity) : entry.region}</span>{" "}
            <span className="project-settings-hint">{entry.worksheet ?? "?"}{!entry.api && ` — ${S.references.broken}`}</span>{" "}
            {onGoToExport && entry.api && entry.worksheet && <button type="button" disabled={busy} onClick={() => void act(() => onGoToExport(entry.worksheet as string, entry.region))}>{S.references.goTo}</button>}{" "}
            {onStopExporting && entry.worksheet && <button type="button" disabled={busy} onClick={() => void act(() => onStopExporting(entry.worksheet as string, entry.region))}>{S.references.stopExporting}</button>}
          </li>)}
        </ul>}
      </section>}
      {error && <div className="project-error" role="alert">{error}</div>}
      <div className="dialog-buttons">
        <button type="button" disabled={busy} onClick={() => void manageEnvironment()}>{S.project.manageEnvironment}</button>{" "}
        <button type="button" disabled={busy} onClick={onReveal}>{S.project.revealFolder}</button>{" "}
        {onUsage && <button type="button" disabled={busy} onClick={onUsage}>{S.project.imageUsageTitle}</button>}
        <button className="primary" type="submit" disabled={busy}>{S.project.applySettings}</button>{" "}
        <button type="button" disabled={busy} onClick={onClose}>{S.project.cancel}</button>
      </div>
    </form>
  </div>;
}
