// The Julia environment manager: which
// environment the active worksheet uses, what its Project.toml and Manifest.toml say, the state of
// its kernel, choosing another environment and adding or removing packages.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { EnvironmentInfo, EnvironmentMetadataFile, EnvironmentOperation, EnvironmentSwitchPreview } from "../equavelaApi";
import { S } from "../strings";
import { describeKernel } from "./Chrome";

const messageOf = (reason: unknown) =>
  typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason);
const isStaleSwitchError = (reason: unknown) => {
  const kind = typeof reason === "object" && reason !== null && "kind" in reason ? String(reason.kind) : "";
  return /stale|preview/i.test(`${kind} ${messageOf(reason)}`);
};

type PendingChange =
  | { kind: "packages"; names: string[]; remove: boolean }
  | { kind: "environment"; operation: EnvironmentOperation }
  | { kind: "copy"; destination: string }
  | { kind: "compatibility"; packageName: string; compatibility: string }
  | { kind: "undo" }
  | { kind: "restart" };

export function EnvironmentManager({ load, onReadEnvironmentMetadata, onPreviewEnvironment, onCommitEnvironment, onCopyEnvironment, onChangePackages, onManageEnvironment, onSetCompatibility, onRevertChange, onRestartKernel, onClose }: {
  /** Reads the environment of the active worksheet. */
  load: () => Promise<EnvironmentInfo>;
  /** Reads metadata from the worksheet's currently selected environment. */
  onReadEnvironmentMetadata: (file: EnvironmentMetadataFile) => Promise<string>;
  /** Another environment (`choose`: the folder chooser) or the shared one. */
  onPreviewEnvironment: (choose: boolean) => Promise<EnvironmentSwitchPreview | null>;
  onCommitEnvironment: (token: string) => Promise<void>;
  /** Copies environment metadata to a new absolute directory and selects it. */
  onCopyEnvironment: (destination: string) => Promise<void>;
  /** Adds or removes packages; the environment afterwards. */
  onChangePackages: (names: string[], remove: boolean) => Promise<EnvironmentInfo>;
  /** Instantiates, resolves or updates the environment; the resulting environment info. */
  onManageEnvironment: (operation: EnvironmentOperation) => Promise<EnvironmentInfo>;
  /** Sets or clears one direct dependency's compatibility bound. */
  onSetCompatibility: (packageName: string, compatibility: string) => Promise<EnvironmentInfo>;
  /** Undoes the last package change or settles an interrupted one; absent: not offered. */
  onRevertChange?: (interrupted: boolean, restore: boolean) => Promise<EnvironmentInfo>;
  /** Restarts the environment's kernel; absent: not offered. */
  onRestartKernel?: () => Promise<EnvironmentInfo>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<EnvironmentInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [toAdd, setToAdd] = useState("");
  const [copyDestination, setCopyDestination] = useState("");
  const [showCopyInput, setShowCopyInput] = useState(false);
  const [editingPackage, setEditingPackage] = useState<string | null>(null);
  const [compatibilityDraft, setCompatibilityDraft] = useState("");
  /** A package or environment change waiting for explicit confirmation. */
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [switchPreview, setSwitchPreview] = useState<EnvironmentSwitchPreview | null>(null);
  const [staleSwitch, setStaleSwitch] = useState(false);
  const [metadataFile, setMetadataFile] = useState<EnvironmentMetadataFile | null>(null);
  const [metadataText, setMetadataText] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const actionsDisabled = busy || pending !== null || switchPreview !== null;
  useLayoutEffect(() => {
    setMetadataFile(null);
    setMetadataText(null);
    setMetadataError("");
  }, [info]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);
  const reload = useCallback(() => load().then((nextInfo) => {
    setInfo(nextInfo);
    setSwitchPreview(null);
    setStaleSwitch(false);
  }, (reason) => setError(messageOf(reason))), [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const work = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };
  const previewEnvironment = (choose: boolean) => work(async () => {
    setSwitchPreview(await onPreviewEnvironment(choose));
  });
  const viewMetadata = async (file: EnvironmentMetadataFile) => {
    setMetadataFile(file);
    setMetadataText(null);
    setMetadataError("");
    setBusy(true);
    setError("");
    try {
      setMetadataText(await onReadEnvironmentMetadata(file));
    } catch (reason) {
      setMetadataError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  };
  const confirm = () => {
    if (!pending) return;
    const change = pending;
    if (change.kind === "compatibility") {
      setBusy(true);
      setError("");
      void onSetCompatibility(change.packageName, change.compatibility).then((nextInfo) => {
        setInfo(nextInfo);
        setEditingPackage(null);
        setCompatibilityDraft("");
        setPending(null);
      }, (reason) => setError(messageOf(reason))).finally(() => setBusy(false));
      return;
    }
    setPending(null);
    void work(async () => {
      if (change.kind === "packages") {
        setInfo(await onChangePackages(change.names, change.remove));
        if (!change.remove) setToAdd("");
      } else if (change.kind === "environment") {
        setInfo(await onManageEnvironment(change.operation));
      } else if (change.kind === "undo" && onRevertChange) {
        setInfo(await onRevertChange(false, true));
      } else if (change.kind === "restart" && onRestartKernel) {
        setInfo(await onRestartKernel());
      }
    });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (actionsDisabled) return;
    const names = toAdd.split(/[\s,]+/).filter(Boolean);
    if (names.length > 0) setPending({ kind: "packages", names, remove: false });
  };
  const startCopy = (event: FormEvent) => {
    event.preventDefault();
    if (actionsDisabled) return;
    const destination = copyDestination;
    if (destination && /^([a-zA-Z]:)?[\\/]/.test(destination)) setPending({ kind: "copy", destination });
  };
  const files = info?.files;
  const lastChange = info?.last_change ? S.environment.describeChange(info.last_change.operation, info.last_change.packages) : "";
  const interrupted = info?.interrupted_change ? S.environment.describeChange(info.interrupted_change.operation, info.interrupted_change.packages) : "";
  return <div className="dialog-backdrop chrome" role="presentation" onPointerDown={() => { if (!actionsDisabled) onClose(); }}>
    <div
      ref={dialog}
      tabIndex={-1}
      className="dialog environment-manager"
      role="dialog"
      aria-modal="true"
      aria-labelledby="environment-title"
      aria-busy={busy}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!actionsDisabled) onClose(); }
      }}
    >
      <h2 id="environment-title">{S.environment.title}</h2>
      {info && files && <>
        <dl>
          <dt>{S.environment.kindLabel}</dt>
          <dd data-testid="environment-kind">{S.environment.kinds[info.kind]}</dd>
          <dt>{S.environment.directory}</dt>
          <dd className="environment-path">{info.directory}{info.absolute && <span className="environment-warning"> {S.environment.notPortable}</span>}</dd>
          <dt>Project.toml</dt>
          <dd className="environment-path">{files.project_exists ? <>{files.project_toml} <button type="button" disabled={actionsDisabled} onClick={() => void viewMetadata("project")}>{S.environment.viewProject}</button></> : S.environment.notCreated}</dd>
          <dt>Manifest.toml</dt>
          <dd className="environment-path">{files.manifest_exists ? <>{files.manifest_toml} <button type="button" disabled={actionsDisabled} onClick={() => void viewMetadata("manifest")}>{S.environment.viewManifest}</button></> : S.environment.notCreated}</dd>
          <dt>{S.environment.kernel}</dt>
          <dd>{describeKernel(info.kernel_status)}{onRestartKernel && <> <button type="button" disabled={actionsDisabled} onClick={() => setPending({ kind: "restart" })}>{S.environment.restartKernel}</button></>}</dd>
        </dl>
        {metadataFile && <section className="environment-metadata" aria-labelledby="environment-metadata-title">
          <h3 id="environment-metadata-title">{metadataFile === "project" ? S.environment.projectMetadata : S.environment.manifestMetadata}</h3>
          <button type="button" disabled={actionsDisabled} onClick={() => { setMetadataFile(null); setMetadataText(null); setMetadataError(""); }}>{S.environment.closeMetadata}</button>
          {metadataError && <div className="environment-error" role="alert">{metadataError}</div>}
          {metadataText !== null && <pre aria-label={metadataFile === "project" ? "Project.toml contents" : "Manifest.toml contents"}>{metadataText}</pre>}
        </section>}
        {interrupted && onRevertChange && <div className="environment-confirm" role="alertdialog" aria-label={S.environment.restorePrevious}>
          <p>{S.environment.interrupted(interrupted)}</p>
          <button type="button" className="primary" disabled={actionsDisabled} onClick={() => void work(async () => setInfo(await onRevertChange(true, true)))}>{S.environment.restorePrevious}</button>{" "}
          <button type="button" disabled={actionsDisabled} onClick={() => void work(async () => setInfo(await onRevertChange(true, false)))}>{S.environment.keepCurrent}</button>
        </div>}
        <div className="environment-choice">
          {lastChange && onRevertChange && !interrupted && <button type="button" disabled={actionsDisabled} onClick={() => setPending({ kind: "undo" })}>{S.environment.undoLastChange(lastChange)}</button>}
          {(["instantiate", "resolve", "update"] as const).map((operation) => (
            <button key={operation} type="button" disabled={actionsDisabled} onClick={() => setPending({ kind: "environment", operation })}>
              {S.environment[operation]}
            </button>
          ))}
          {info.can_override && <>
            <button type="button" disabled={actionsDisabled} onClick={() => void previewEnvironment(true)}>{S.environment.useAnother}</button>
            <button type="button" disabled={actionsDisabled} onClick={() => setShowCopyInput(true)}>{S.environment.copy}</button>
            {info.kind === "override" && <button type="button" disabled={actionsDisabled} onClick={() => void previewEnvironment(false)}>{S.environment.useShared}</button>}
          </>}
        </div>
        {showCopyInput && !pending && <form className="environment-add" onSubmit={startCopy}>
          <input aria-label={S.environment.destination} value={copyDestination} disabled={actionsDisabled} onChange={(event) => setCopyDestination(event.target.value)} />
          <button type="submit" disabled={actionsDisabled || !/^([a-zA-Z]:)?[\\/]/.test(copyDestination)}>{S.environment.copyDestination}</button>
          <button type="button" disabled={actionsDisabled} onClick={() => setShowCopyInput(false)}>{S.environment.cancel}</button>
        </form>}
        {info.problems.map((problem) => <div key={problem} className="environment-error" role="alert">{problem}</div>)}
        {files.error && <div className="environment-error" role="alert">{files.error}</div>}
        {switchPreview && <div className="environment-confirm" role="alertdialog" aria-label={S.environment.switchPreview}>
          <h3>{S.environment.switchPreview}</h3>
          <dl>
            <dt>{S.environment.switchSource}</dt><dd className="environment-path">{switchPreview.current.directory}</dd>
            <dt>{S.environment.switchTargetDirectory}</dt><dd className="environment-path">{switchPreview.target.directory}</dd>
            <dt>Project.toml</dt><dd className="environment-path">{switchPreview.files.project_exists ? switchPreview.files.project_toml : S.environment.notCreated}</dd>
            <dt>Manifest.toml</dt><dd className="environment-path">{switchPreview.files.manifest_exists ? switchPreview.files.manifest_toml : S.environment.notCreated}</dd>
          </dl>
          {switchPreview.differences.some((difference) => difference.missing) &&
            <p className="environment-warning" role="status">{S.environment.switchMissingWarning}</p>}
          <p>{S.environment.switchNoInstall}</p>
          <table aria-label={S.environment.switchPackages}>
            <thead><tr><th>{S.environment.packageName}</th><th>{S.environment.switchCurrent}</th><th>{S.environment.switchTarget}</th></tr></thead>
            <tbody>{switchPreview.differences.length === 0
              ? <tr><td colSpan={3}>{S.environment.noPackages}</td></tr>
              : switchPreview.differences.map((difference) => <tr key={difference.name}>
                <td>{difference.name}</td><td>{difference.current ?? "—"}</td>
                <td>{difference.target ?? (difference.missing ? S.environment.notInstalled : "—")}</td>
              </tr>)}</tbody>
          </table>
          <button type="button" className="primary" disabled={busy} onClick={() => {
            const token = switchPreview.token;
            setBusy(true);
            setError("");
            setStaleSwitch(false);
            void onCommitEnvironment(token).then(async () => {
              setSwitchPreview(null);
              await reload();
            }, (reason) => {
              setError(messageOf(reason));
              setStaleSwitch(isStaleSwitchError(reason));
            }).finally(() => setBusy(false));
          }}>{S.environment.switchAndRecalculate}</button>{" "}
          <button type="button" disabled={busy} onClick={() => setSwitchPreview(null)}>{S.environment.cancel}</button>
        </div>}
        <h3 id="environment-packages">{S.environment.packages}</h3>
        {files.dependencies.length === 0
          ? <p className="environment-empty">{S.environment.noPackages}</p>
          : <table aria-labelledby="environment-packages">
            <thead><tr><th>{S.environment.packageName}</th><th>{S.environment.packageCompatibility}</th><th>{S.environment.installedVersion}</th><th /></tr></thead>
            <tbody>
              {files.dependencies.map((dependency) => <tr key={dependency.uuid || dependency.name}>
                <td>{dependency.name}</td>
                <td>{editingPackage === dependency.name
                  ? <form className="environment-add" onSubmit={(event) => {
                    event.preventDefault();
                    if (actionsDisabled) return;
                    setPending({ kind: "compatibility", packageName: dependency.name, compatibility: compatibilityDraft.trim() });
                  }}>
                    <input aria-label={`${S.environment.compatibilityBound} ${dependency.name}`} value={compatibilityDraft} disabled={actionsDisabled} onChange={(event) => setCompatibilityDraft(event.target.value)} />
                    <button type="submit" disabled={actionsDisabled}>{S.environment.setCompatibility}</button>
                    <button type="button" disabled={actionsDisabled} onClick={() => { setEditingPackage(null); setCompatibilityDraft(""); }}>{S.environment.cancel}</button>
                  </form>
                  : dependency.compatibility ?? "—"}</td>
                <td>{dependency.installed ? dependency.version ?? S.environment.standardLibrary : S.environment.notInstalled}</td>
                <td>{editingPackage !== dependency.name && <button type="button" disabled={actionsDisabled} aria-label={`${S.environment.editCompatibility} ${dependency.name}`} onClick={() => { setEditingPackage(dependency.name); setCompatibilityDraft(dependency.compatibility ?? ""); }}>{S.environment.editCompatibility}</button>} <button type="button" disabled={actionsDisabled} aria-label={`${S.environment.remove} ${dependency.name}`} onClick={() => setPending({ kind: "packages", names: [dependency.name], remove: true })}>{S.environment.remove}</button></td>
              </tr>)}
            </tbody>
          </table>}
        <form className="environment-add" onSubmit={add}>
          <input aria-label={S.environment.packageToAdd} value={toAdd} disabled={actionsDisabled} onChange={(event) => setToAdd(event.target.value)} />
          <button type="submit" disabled={actionsDisabled || toAdd.trim() === ""}>{S.environment.addPackage}</button>
        </form>
        {pending && <div className="environment-confirm" role="alertdialog" aria-label={S.environment.confirm}>
          <p>{pending.kind === "packages"
            ? S.environment.confirmChange(info.kind, pending.remove, pending.names, info.directory)
            : pending.kind === "copy"
              ? S.environment.confirmCopy(info.directory, pending.destination)
              : pending.kind === "compatibility"
                ? S.environment.confirmCompatibility(info.directory, info.kind, pending.packageName, pending.compatibility)
                : pending.kind === "undo"
                  ? S.environment.confirmUndo(lastChange, info.directory, info.kind)
                  : pending.kind === "restart"
                    ? S.environment.confirmRestart(info.directory, info.kind)
                  : S.environment.confirmEnvironmentOperation(pending.operation, info.directory, info.kind)}</p>
          {pending.kind === "environment" && pending.operation === "instantiate" && !files.manifest_exists &&
            <p>{S.environment.instantiateWithoutManifest}</p>}
          <button type="button" className="primary" disabled={busy} onClick={() => {
            if (pending.kind === "compatibility") confirm();
            else if (pending.kind === "copy") {
              const destination = pending.destination;
              setPending(null);
              void work(async () => {
                await onCopyEnvironment(destination);
                await reload();
                setCopyDestination("");
                setShowCopyInput(false);
              });
            } else confirm();
          }}>{pending.kind === "copy" ? S.environment.copyAsOverride : pending.kind === "compatibility" ? S.environment.setCompatibility : S.environment.confirm}</button>{" "}
          <button type="button" disabled={busy} onClick={() => setPending(null)}>{S.environment.cancel}</button>
        </div>}
      </>}
      {busy && <p className="environment-busy" role="status">{S.environment.working}</p>}
      {error && <div className="environment-error" role="alert">{error}{staleSwitch && <> {S.environment.switchReloadNeeded} <button type="button" disabled={busy} onClick={() => { setStaleSwitch(false); void reload(); }}>{S.environment.switchReload}</button></>}</div>}
      <div className="dialog-buttons"><button type="button" disabled={actionsDisabled} onClick={onClose}>{S.environment.close}</button></div>
    </div>
  </div>;
}
