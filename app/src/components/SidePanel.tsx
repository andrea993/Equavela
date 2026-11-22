// The side panel: Variables, Outline, Problems and Includes.
// It is chrome around the page (screen only). Every row navigates: to a region of the worksheet,
// or, for a name or a problem inside an included worksheet, to that file (opened as a tab).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ValueView } from "../results/ResultView";
import { MathExpr, MathStatement, TargetView } from "../math/render";
import type { Expr, Stmt } from "../math/ast";
import type { ResultFormat } from "../results/format";
import { S } from "../strings";
import type {
  DefinitionInfo,
  DefinitionValue,
  IncludeInfo,
  ViewRegion,
  Inspection,
  RegionKey,
  WarningInfo,
} from "../equavelaApi";
import {
  definitionsAt,
  fileName,
  sameKey,
  valueId,
  variablesOf,
} from "../inspect/inspection";
import { outlineOf, problemsOf, type Problem } from "../inspect/outline";
import type { DocState } from "../workbench/useWorkbench";
import { handleInputChord } from "./inputChords";

export type PanelTab = "variables" | "outline" | "problems" | "includes";

export const PANEL_TABS: PanelTab[] = ["variables", "outline", "problems", "includes"];

type Props = {
  doc: DocState;
  /** The full inspection: the panel is open, so the hook keeps one current. */
  inspection: Inspection | null;
  /** The unit warnings, which travel apart from the inspection so the sheet has them always. */
  warnings: readonly WarningInfo[];
  values: ReadonlyMap<string, DefinitionValue>;
  ensureValues: (wanted: { name: string; version: number }[]) => void;
  /** The region the cursor is in (selected or being edited), in the root document. */
  cursor: RegionKey | null;
  format: ResultFormat;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onJump: (key: RegionKey) => void;
  onOpenDocument: (document: string) => void;
  /** adds a missing package to the worksheet's environment, after a confirmation. */
  onAddPackage?: (name: string) => void;
  /** opens the Julia environment manager. */
  onOpenEnvironment?: () => void;
  onClose: () => void;
  /** the name the REPL reaches this worksheet's module by. */
  moduleName?: string | null;
};

const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const WIDTH_KEY = "equavela.sidePanelWidth";
const clampWidth = (value: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value));

export default function SidePanel(props: Props) {
  const [width, setWidth] = useState(() => {
    try {
      const value = Number(window.localStorage.getItem(WIDTH_KEY));
      return value && Number.isFinite(value) ? clampWidth(value) : 300;
    } catch { return 300; }
  });
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const maxWidth = viewportWidth <= 1000 ? Math.max(0, Math.min(MAX_WIDTH, viewportWidth - 48)) : MAX_WIDTH;
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const visibleWidth = Math.min(width, maxWidth);
  const clampVisible = (value: number) => Math.max(minWidth, Math.min(maxWidth, value));
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* Storage can be unavailable. */ }
  }, [width]);
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: event.currentTarget.parentElement?.getBoundingClientRect().width || visibleWidth };
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointerId === event.pointerId) setWidth(clampVisible(active.width + active.x - event.clientX));
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const next = event.key === "ArrowLeft" ? visibleWidth + 10 : event.key === "ArrowRight" ? visibleWidth - 10 :
      event.key === "Home" ? minWidth : event.key === "End" ? maxWidth : null;
    if (next !== null) { event.preventDefault(); setWidth(clampVisible(next)); }
  };
  const { doc, warnings, tab } = props;
  const problems = useMemo(
    () => problemsOf(doc.root, doc.results, doc.diagnostics, warnings),
    [doc.root, doc.results, doc.diagnostics, warnings],
  );
  return (
    <aside className="side-panel chrome no-print" aria-label={S.panel.label} data-testid="side-panel" style={{ "--inspector-width": `${visibleWidth}px` } as React.CSSProperties}>
      <div className="side-panel-resizer" role="separator" aria-label={S.panel.resize} aria-orientation="vertical"
        aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={visibleWidth} tabIndex={0}
        onKeyDown={resizeByKey} onPointerDown={beginResize} onPointerMove={moveResize}
        onPointerUp={endResize} onPointerCancel={endResize} onLostPointerCapture={() => { drag.current = null; }} />
      <div className="side-tabs" role="tablist">
        {PANEL_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`side-tab${tab === id ? " active" : ""}`}
            onClick={() => props.onTab(id)}
            data-testid={`panel-tab-${id}`}
          >
            {S.panel.tabs[id]}
            {id === "problems" && problems.length > 0 && <span className="badge">{problems.length}</span>}
          </button>
        ))}
        <button type="button" className="side-close" aria-label={S.panel.close} title={S.panel.close} onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="side-body" role="tabpanel">
        {tab === "variables" && <VariablesTab {...props} />}
        {tab === "outline" && <OutlineTab {...props} />}
        {tab === "problems" && <ProblemsTab problems={problems} onJump={props.onJump} onAddPackage={props.onAddPackage} onOpenEnvironment={props.onOpenEnvironment} />}
        {tab === "includes" && <IncludesTab {...props} />}
      </div>
    </aside>
  );
}

// ---- Variables ---------------------------------------------------------------------------

function ValueCell({ value, format }: { value: DefinitionValue | undefined; format: ResultFormat }): ReactNode {
  if (!value) return <span className="muted">…</span>;
  if (value.error) return <span className="muted">{value.error === "not calculated yet" ? S.panel.variables.notCalculated : value.error}</span>;
  if (value.size) return <span>{S.hover.matrix(value.size[0], value.size[1])}</span>;
  if (!value.value) return null;
  if (value.value.type === "matrix") return <span>{S.hover.matrix(value.value.rows, value.value.cols)}</span>;
  return (
    <span className="math value-cell">
      <ValueView value={value.value} displayUnit={value.display_unit} format={format} />
    </span>
  );
}

const isNode = (value: unknown): value is { type: string } & Record<string, unknown> =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/**
 * A defined name drawn as math: the left side of its definition when the
 * defining region is on this page list, otherwise the name itself with its literal subscript typeset.
 */
function DefinitionName({ definition, regions }: { definition: DefinitionInfo; regions: readonly ViewRegion[] }): ReactNode {
  const region = regions.find((r) => r.id === definition.key.region_id);
  const statement = region?.kind === "math" ? region.statement : null;
  if (isNode(statement) && (statement.type === "Define" || statement.type === "GlobalDefine") && isNode(statement.target)) {
    return <TargetView target={statement.target as Stmt} />;
  }
  const [base, ...subscript] = definition.name.split("_");
  const segments = [{ text: base, subscript: false }, ...(subscript.length ? [{ text: subscript.join("_"), subscript: true }] : [])];
  return <MathExpr expr={{ type: "Ident", name: { segments, label: null } } as Expr} />;
}

function VariablesTab({ doc, inspection, values, ensureValues, cursor, format, onJump }: Props) {
  const [filter, setFilter] = useState("");
  // The list is for the current worksheet; what an included file defines is under Includes.
  const definitions = useMemo(
    () => (inspection ? definitionsAt(inspection, cursor).filter((d) => d.key.document === doc.root) : []),
    [inspection, cursor, doc.root],
  );
  const shown = useMemo(
    () => definitions.filter((d) => d.signature.toLowerCase().includes(filter.trim().toLowerCase())),
    [definitions, filter],
  );
  // one row per name (the last definition visible here), with the REPL names of every
  // definition of that name up to it, in order.
  const rows = useMemo(() => shown.map((last) => ({
    last,
    versions: (inspection?.definitions ?? [])
      .filter((d) => d.name === last.name && d.label === last.label && d.key.document === last.key.document && d.version <= last.version)
      .sort((a, b) => a.version - b.version),
  })), [shown, inspection]);
  useEffect(() => {
    ensureValues(variablesOf(rows.slice(0, 200).map((row) => row.last)));
  }, [rows, ensureValues, values]);
  const cursorPage = cursor ? doc.view.regions.find((r) => r.id === cursor.region_id)?.page ?? null : null;
  return (
    <div className="side-variables">
      <input
        type="search"
        className="side-filter"
        placeholder={S.panel.variables.filter}
        aria-label={S.panel.variables.filter}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => void handleInputChord(event)}
      />
      <div className="side-note">{cursorPage !== null && cursor && cursor.document === doc.root ? S.panel.variables.upTo(cursorPage) : S.panel.variables.all}</div>
      {shown.length === 0 ? (
        <p className="side-empty">{S.panel.variables.empty}</p>
      ) : (
        <ul className="side-list" data-testid="variables-list">
          {rows.map(({ last, versions }) => (
            <VariableRow
              key={`${last.name}#${last.key.document}`}
              definition={last}
              replNames={versions.map((d) => d.kernel_name)}
              value={values.get(valueId(last))}
              format={format}
              regions={doc.view.regions}
              page={doc.view.regions.find((r) => r.id === last.key.region_id)?.page ?? 1}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function VariableRow({
  definition,
  replNames,
  value,
  format,
  regions,
  page,
  onJump,
}: {
  definition: DefinitionInfo;
  regions: readonly ViewRegion[];
  /** the names the REPL reads each definition of this name by, in order. */
  replNames: string[];
  value: DefinitionValue | undefined;
  format: ResultFormat;
  page: number;
  onJump: (key: RegionKey) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="side-row variable"
        onClick={() => onJump(definition.key)}
        title={`${definition.signature} · ${S.panel.variables.source(page, null)}`}
        data-testid="variable-row"
      >
        <span className="row-name">
          <span className="math name-cell"><DefinitionName definition={definition} regions={regions} /></span>
          {definition.label === "fn" && <span className="tag">{S.panel.variables.function}</span>}
          {definition.global && <span className="tag">{S.panel.variables.global}</span>}
        </span>
        <span className="row-value">
          {definition.label === "var" ? <ValueCell value={value} format={format} /> : null}
        </span>
        <span className="row-repl" title={S.panel.variables.replNames} data-testid="variable-repl">{replNames.join(", ")}</span>
        <span className="row-source">
          {S.panel.variables.source(page, null)}
        </span>
      </button>
    </li>
  );
}

// ---- Outline -----------------------------------------------------------------------------

function OutlineTab({ doc, cursor, onJump }: Props) {
  const items = useMemo(() => outlineOf(doc.view.regions), [doc.view.regions]);
  if (items.length === 0) return <p className="side-empty">{S.panel.outline.empty}</p>;
  let page = 0;
  return (
    <ul className="side-list outline" data-testid="outline-list">
      {items.map((item) => {
        const header = item.page !== page ? <li className="side-group">{S.panel.outline.page(item.page)}</li> : null;
        page = item.page;
        const active = cursor !== null && cursor.document === doc.root && cursor.region_id === item.id;
        return (
          <FragmentRow key={item.id} header={header}>
            <li>
              <button
                type="button"
                className={`side-row outline-row kind-${item.kind} level-${item.level}${active ? " active" : ""}`}
                onClick={() => onJump({ document: doc.root, region_id: item.id, instance: 0 })}
                title={isNode(item.statement) ? undefined : item.label}
                data-testid="outline-row"
              >
                <span className={`row-kind ${item.kind}`} aria-hidden="true" />
                {isNode(item.statement) ? (
                  <span className="math row-label row-math">
                    {/* one inline box: the flex row must not turn superscripts into flex items */}
                    <span>
                      <MathStatement statement={item.statement as Stmt} />
                    </span>
                  </span>
                ) : (
                  <span className="row-label">{item.label}</span>
                )}
              </button>
            </li>
          </FragmentRow>
        );
      })}
    </ul>
  );
}

function FragmentRow({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <>
      {header}
      {children}
    </>
  );
}

// ---- Problems ----------------------------------------------------------------------------

function ProblemsTab({ problems, onJump, onAddPackage, onOpenEnvironment }: {
  problems: Problem[];
  onJump: (key: RegionKey) => void;
  onAddPackage?: (name: string) => void;
  onOpenEnvironment?: () => void;
}) {
  if (problems.length === 0) return <p className="side-empty">{S.panel.problems.empty}</p>;
  return (
    <>
      <div className="side-note">{S.panel.problems.count(problems.length)}</div>
      <ul className="side-list" data-testid="problems-list">
        {problems.map((problem, index) => (
          <li key={`${problem.kind}-${problem.key.document}-${problem.key.region_id}-${index}`}>
            <button
              type="button"
              className={`side-row problem ${problem.severity}`}
              onClick={() => onJump(problem.key)}
              data-testid="problem-row"
            >
              <span className="row-kind severity" aria-hidden="true" />
              <span className="row-label">
                <span className="problem-kind">
                  {problem.kind === "error" ? S.panel.problems.error : problem.kind === "unit" ? S.panel.problems.warning : S.panel.problems.diagnostic}
                </span>{" "}
                {problem.message}
                {problem.file && <span className="problem-file"> {S.panel.problems.inFile(problem.file)}</span>}
              </span>
            </button>
            {problem.package && (onAddPackage || onOpenEnvironment) && (
              <div className="problem-actions">
                {onAddPackage && (
                  <button type="button" onClick={() => onAddPackage(problem.package as string)}>
                    {S.panel.problems.addPackage(problem.package)}
                  </button>
                )}{" "}
                {onOpenEnvironment && (
                  <button type="button" onClick={onOpenEnvironment}>
                    {S.panel.problems.openEnvironment}
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Includes ----------------------------------------------------------------------------

function IncludesTab({ doc, inspection, onJump, onOpenDocument }: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const [searchExpanded, setSearchExpanded] = useState(new Map<string, boolean>());
  const byParent = useMemo(() => {
    const map = new Map<string, IncludeInfo[]>();
    for (const include of inspection?.includes ?? []) {
      const siblings = map.get(include.parent);
      if (siblings) siblings.push(include);
      else map.set(include.parent, [include]);
    }
    return map;
  }, [inspection]);
  if (!inspection) return null;
  const normalize = (text: string) => text.toLowerCase().replaceAll("\\", "/");
  const query = normalize(filter.trim());
  const render = (parent: string, trail: string[], path: string): ReactNode[] =>
    (byParent.get(parent) ?? []).flatMap((include) => {
      const id = `${path}/${include.region_id}`;
      const nested = trail.includes(include.document) || trail.length > 8
        ? []
        : render(include.document, [...trail, include.document], id);
      const fileMatches = normalize(include.document).includes(query);
      const matchingExports = query
        ? include.exports.filter((definition) => [definition.name, definition.signature].some((name) => normalize(name).includes(query)))
        : [];
      if (!fileMatches && matchingExports.length === 0 && nested.length === 0) return [];
      const saved = expanded.get(id) ?? false;
      const open = query
        ? searchExpanded.get(id) ?? (saved || matchingExports.length > 0 || nested.length > 0)
        : saved;
      return [(
        <IncludeNode
          key={id}
          include={include}
          visibleExports={fileMatches ? include.exports : matchingExports}
          open={open}
          onToggle={() => (query ? setSearchExpanded : setExpanded)((was) => new Map(was).set(id, !open))}
          onJump={onJump}
          onOpenDocument={onOpenDocument}
        >
          {nested.length > 0 && nested}
        </IncludeNode>
      )];
    });
  const rows = render(doc.root, [doc.root], doc.root);
  return (
    <>
      <input
        type="search"
        className="side-filter"
        placeholder={S.panel.includes.filter}
        aria-label={S.panel.includes.filter}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
          setSearchExpanded(new Map());
        }}
        onKeyDown={(event) => void handleInputChord(event)}
      />
      {rows.length === 0 ? (
        <p className="side-empty">{byParent.has(doc.root) ? S.panel.includes.noMatches : S.panel.includes.empty}</p>
      ) : (
        <ul className="side-list includes" data-testid="includes-list">{rows}</ul>
      )}
    </>
  );
}

function IncludeNode({
  include,
  visibleExports,
  open,
  onToggle,
  onJump,
  onOpenDocument,
  children,
}: {
  include: IncludeInfo;
  visibleExports: IncludeInfo["exports"];
  open: boolean;
  onToggle: () => void;
  onJump: (key: RegionKey) => void;
  onOpenDocument: (document: string) => void;
  children: ReactNode;
}) {
  const expandable = include.found;
  return (
    <li className="include-node">
      <div className="side-row include-head">
        <button
          type="button"
          className="include-toggle"
          onClick={onToggle}
          disabled={!expandable}
          aria-expanded={expandable ? open : undefined}
          title={include.found ? (open ? S.panel.includes.collapse : S.panel.includes.expand) : S.panel.includes.missing}
          data-testid="include-row"
        >
          <span className={`include-chevron${open ? " open" : ""}`} aria-hidden="true" />
          <span className="row-kind include" aria-hidden="true" />
          <span className="row-label">{fileName(include.document)}</span>
          {!include.found && <span className="tag warn">{S.panel.includes.missing}</span>}
        </button>
        {include.found && (
          <button
            type="button"
            className="include-open"
            onClick={() => onOpenDocument(include.document)}
            title={S.panel.includes.open}
            aria-label={`${S.panel.includes.open}: ${fileName(include.document)}`}
            data-testid="include-open"
          >
            {S.panel.includes.openShort}
          </button>
        )}
      </div>
      {open && include.found && include.exports.length === 0 && <div className="side-note indent">{S.panel.includes.noExports}</div>}
      {open && visibleExports.length > 0 && (
        <ul className="side-list exports">
          {visibleExports.map((definition) => (
            <li key={`${definition.name}#${definition.version}`}>
              <button
                type="button"
                className="side-row export-row"
                onClick={() => onJump(definition.key)}
                data-testid="export-row"
              >
                <span className="math name-cell">{definition.signature}</span>
                {definition.label === "fn" && <span className="tag">{S.panel.variables.function}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && children && <ul className="side-list nested">{children}</ul>}
    </li>
  );
}

export { sameKey };
