// The function catalogue and local function help (F1): every
// built-in with its signature, category and description, searchable. F1 on a function name
// opens the same dialog on that entry.

import { useEffect, useMemo, useRef, useState } from "react";
import { BUILTIN_CATEGORIES, searchBuiltins, type BuiltinEntry } from "../catalog/builtins";
import { functionManualPath, openManual } from "../manual";
import { S } from "../strings";
import { handleInputChord } from "./inputChords";

export function FunctionCatalogue({
  initialQuery,
  help,
  canInsert,
  onInsert,
  onClose,
}: {
  initialQuery: string;
  /** Opened by F1 on a name: say so when the name has no entry. */
  help: boolean;
  canInsert: boolean;
  onInsert: (entry: BuiltinEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [category, setCategory] = useState("");
  const [index, setIndex] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const selectedRow = useRef<HTMLLIElement>(null);
  const results = useMemo(
    () => searchBuiltins(query).filter((entry) => !category || entry.category === category),
    [query, category],
  );
  const selected = results[Math.min(index, results.length - 1)] ?? null;

  useEffect(() => {
    search.current?.select();
  }, []);
  useEffect(() => {
    setIndex(0);
  }, [query, category]);
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [index, results]);

  const insert = (entry: BuiltinEntry | null) => {
    if (entry && canInsert) onInsert(entry);
  };

  return (
    <div className="dialog-backdrop chrome" role="presentation" onPointerDown={onClose}>
      <section
        className="dialog catalogue-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={S.catalogue.title}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            if (results.length > 0) setIndex((i) => (Math.min(i, results.length - 1) + delta + results.length) % results.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            insert(selected);
          }
        }}
      >
        <h2>{S.catalogue.title}</h2>
        <div className="catalogue-controls">
          <input
            ref={search}
            type="search"
            aria-label={S.catalogue.search}
            placeholder={S.catalogue.searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => void handleInputChord(event)}
          />
          <select aria-label={S.catalogue.category} value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">{S.catalogue.allCategories}</option>
            {BUILTIN_CATEGORIES.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        {help && initialQuery && !searchBuiltins(initialQuery).some((e) => e.name === initialQuery) && (
          <p className="catalogue-note" role="status">{S.catalogue.noHelp(initialQuery)}</p>
        )}
        <div className="catalogue-body">
          <ul className="catalogue-list" role="listbox" aria-label={S.catalogue.results}>
            {results.length === 0 && <li className="catalogue-empty">{S.catalogue.noResults}</li>}
            {results.map((entry, i) => (
              <li
                key={entry.name}
                ref={entry === selected ? selectedRow : undefined}
                role="option"
                aria-selected={entry === selected}
                className={entry === selected ? "active" : ""}
                onClick={() => setIndex(i)}
                onDoubleClick={() => insert(entry)}
              >
                <span className="catalogue-name">{entry.name}</span>
                <span className="catalogue-signature">{entry.signature}</span>
              </li>
            ))}
          </ul>
          <article className="catalogue-detail" aria-live="polite">
            {selected ? (
              <>
                <h3>{selected.signature}</h3>
                <p>{selected.description}</p>
                <p className="catalogue-category">{selected.category}</p>
                <button type="button" className="link" onClick={() => void openManual(functionManualPath(selected))}>
                  {S.catalogue.manual}
                </button>
              </>
            ) : null}
          </article>
        </div>
        <div className="dialog-buttons">
          <span className="catalogue-count">{S.catalogue.count(results.length)}</span>
          <button type="button" onClick={onClose}>{S.catalogue.close}</button>
          <button type="button" className="primary" disabled={!selected || !canInsert} onClick={() => insert(selected)}>
            {S.catalogue.insert}
          </button>
        </div>
      </section>
    </div>
  );
}
