// Spelling…: the language of the worksheet and of the selected
// text regions, the installed dictionaries with their licence, and the download of another
// LibreOffice dictionary — only after the user agreed in this dialog, never silently.

import { useEffect, useState } from "react";
import type { SpellLanguage } from "../equavelaApi";
import { S } from "../strings";

export const SPELL_SOURCE = "github.com/LibreOffice/dictionaries";

/** "Italian (Italy)": the name in English of the language of a dictionary, from its locale id. */
export function languageLabel(id: string): string {
  try {
    const tag = id.replaceAll("_", "-");
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    return name && name !== tag ? name : id;
  } catch {
    return id;
  }
}

type Props = {
  worksheetLanguage: string;
  /** The selected text regions and their common language (`null`: as the worksheet, `undefined`: mixed). */
  regions: { count: number; language: string | null | undefined } | null;
  languages: () => Promise<SpellLanguage[]>;
  install: (language: string) => Promise<void>;
  uninstall: (language: string) => Promise<void>;
  license: (language: string) => Promise<string | null>;
  onApply: (choice: { worksheet: string; region: string | null | undefined }) => void;
  onInstalled: () => void;
  onClose: () => void;
};

export function SpellingDialog(props: Props) {
  const T = S.spelling;
  const [languages, setLanguages] = useState<SpellLanguage[]>([]);
  const [worksheet, setWorksheet] = useState(props.worksheetLanguage);
  const [region, setRegion] = useState<string | null | undefined>(props.regions?.language);
  const [toDownload, setToDownload] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [licence, setLicence] = useState<{ language: string; text: string } | null>(null);

  const refresh = () =>
    props.languages().then((list) => {
      setLanguages(list);
      setToDownload((current) => current || (list.find((l) => !l.installed)?.id ?? ""));
    });
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installed = languages.filter((l) => l.installed);
  const others = languages
    .filter((l) => !l.installed)
    .sort((a, b) => languageLabel(a.id).localeCompare(languageLabel(b.id)));
  const download = async (language: string) => {
    setAsking(null);
    setBusy(language);
    setStatus(T.downloading(language));
    try {
      await props.install(language);
      setStatus(T.downloaded(language));
      props.onInstalled();
      await refresh();
    } catch (error) {
      setStatus(T.downloadFailed(language, (error as { message?: string })?.message ?? String(error)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={props.onClose}>
      <form
        className="dialog spelling-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={T.title}
        data-testid="spelling-dialog"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          props.onApply({ worksheet, region });
        }}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      >
        <h2>{T.title}</h2>
        <label>
          {T.worksheetLanguage}{" "}
          <select value={worksheet} onChange={(e) => setWorksheet(e.target.value)} data-testid="spell-worksheet">
            {installed.length === 0 && <option value={worksheet}>{worksheet}</option>}
            {installed.map((l) => (
              <option key={l.id} value={l.id}>{l.id}</option>
            ))}
          </select>
        </label>
        {props.regions && (
          <label>
            {T.regionLanguage(props.regions.count)}{" "}
            <select
              value={region === undefined ? "" : region ?? "-"}
              onChange={(e) => setRegion(e.target.value === "-" ? null : e.target.value)}
              data-testid="spell-region"
            >
              {region === undefined && <option value="">—</option>}
              <option value="-">{T.followWorksheet}</option>
              {installed.map((l) => (
                <option key={l.id} value={l.id}>{l.id}</option>
              ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>{T.installed}</legend>
          <ul className="spell-installed">
            {installed.map((l) => (
              <li key={l.id}>
                {l.id} {l.bundled && <small>({T.bundled})</small>}{" "}
                <button
                  type="button"
                  onClick={async () => setLicence({ language: l.id, text: (await props.license(l.id)) ?? "" })}
                >
                  {T.licence}
                </button>{" "}
                {!l.bundled && (
                  <button
                    type="button"
                    onClick={async () => {
                      await props.uninstall(l.id);
                      props.onInstalled();
                      await refresh();
                    }}
                  >
                    {T.remove}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
        <fieldset>
          <legend>{T.available}</legend>
          <div className="spell-download">
            <select value={toDownload} onChange={(e) => setToDownload(e.target.value)} data-testid="spell-available">
              {others.map((l) => (
                <option key={l.id} value={l.id} title={`${l.id}: ${l.locales.join(", ")}`}>{languageLabel(l.id)}</option>
              ))}
            </select>
            <button type="button" disabled={!toDownload || busy !== null} onClick={() => setAsking(toDownload)} data-testid="spell-download">
              {T.download}
            </button>
          </div>
          {asking && (
            <div className="spell-consent" role="alertdialog" data-testid="spell-consent">
              <p>{T.consent(asking, SPELL_SOURCE)}</p>
              <button type="button" className="primary" onClick={() => void download(asking)} data-testid="spell-consent-yes">
                {T.download.replace("…", "")}
              </button>{" "}
              <button type="button" onClick={() => setAsking(null)}>{S.options.cancel}</button>
            </div>
          )}
          {status && <p className="spell-status" role="status">{status}</p>}
        </fieldset>
        {licence && (
          <fieldset>
            <legend>{`${T.licence}: ${licence.language}`}</legend>
            <pre className="spell-licence" data-testid="spell-licence">{licence.text}</pre>
          </fieldset>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={props.onClose}>{T.close}</button>
          <button type="submit" className="primary" data-testid="spell-apply">{T.apply}</button>
        </div>
      </form>
    </div>
  );
}
