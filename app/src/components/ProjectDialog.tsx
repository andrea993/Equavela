import { useEffect, useRef, useState, type FormEvent } from "react";
import { S } from "../strings";

/** New and Open Project, and Convert to project, which asks what New does. */
/** `folder` joined with `name`, with the separator the folder already uses. */
function joinFolder(folder: string, name: string): string {
  const separator = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function ProjectDialog({ mode, initialName = "", initialParent, chooseFolder, onSubmit, onClose }: {
  /** New project or Convert to project; Open project uses the folder picker alone. */
  mode: "new" | "convert";
  initialName?: string;
  /** the folder the project is proposed in (the worksheet's own, for Convert). */
  initialParent?: string;
  /** the native folder dialog; `null` when cancelled. */
  chooseFolder?: (title: string, start?: string) => Promise<string | null>;
  onSubmit: (path: string, name: string) => Promise<void>;
  onClose: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus();
  }, []);
  const [name, setName] = useState(initialName);
  // a chosen or proposed folder makes the path follow the name until the path is typed.
  const [parent, setParent] = useState<string | null>(initialParent ?? null);
  const [typed, setTyped] = useState("");
  const path = parent !== null ? joinFolder(parent, name.trim()) : typed;
  const browse = async () => {
    if (!chooseFolder) return;
    const start = parent ?? (typed.trim() || undefined);
    const folder = await chooseFolder(S.project.browseParent, start);
    if (folder) setParent(folder);
  };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(path.trim(), name.trim());
      onClose();
    } catch (reason) {
      setError(typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason));
      setBusy(false);
    }
  };
  return <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => { if (!busy) onClose(); }}>
    <form ref={form} className="dialog project-dialog" onPointerDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={(event) => void submit(event)} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
      if (event.key === "Tab") {
        const fields = [...(form.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? [])];
        if (!fields.length) { event.preventDefault(); return; }
        const index = fields.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); fields[fields.length - 1].focus(); }
        else if (!event.shiftKey && (index === -1 || index === fields.length - 1)) { event.preventDefault(); fields[0].focus(); }
      }
    }}>
      <h2 id="project-dialog-title">{mode === "new" ? S.project.newTitle : S.project.convertTitle}</h2>
      <label>{S.project.name} <input autoFocus={mode === "new"} required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div className="project-path">
        <label>{S.project.newDirectory} <input autoFocus={mode !== "new"} required value={path} onChange={(event) => { setParent(null); setTyped(event.target.value); }} /></label>
        {chooseFolder && <button type="button" disabled={busy} onClick={() => void browse()}>{S.project.browse}</button>}
      </div>
      {error && <div className="project-error" role="alert">{error}</div>}
      <div className="dialog-buttons"><button className="primary" type="submit" disabled={busy}>{S.project.create}</button> <button type="button" disabled={busy} onClick={onClose}>{S.project.cancel}</button></div>
    </form>
  </div>;
}
