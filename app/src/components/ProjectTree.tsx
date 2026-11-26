// The project explorer: the project folder
// as a code editor shows it. Folders open and close, worksheets open in tabs, and files are created,
// renamed, moved (drag onto a folder), imported and sent to the trash from here. What it shows is
// what a project `.eqvz` holds.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { NewItemKind, OpenedProject, ProjectReferenceInfo, ProjectReferences, ReferenceCommand, TreeEntry } from "../equavelaApi";
import { S } from "../strings";

/** A project-relative path joined to the root with the separator the root already uses. */
export function projectWorksheetPath(root: string, path: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${path.split("/").join(separator)}`;
}

const sameFile = (a: string, b: string) => {
  const normalize = (value: string) => {
    const path = value.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
  };
  return normalize(a) === normalize(b);
};

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const depthOf = (path: string) => path.split("/").length - 1;

/** What the explorer's commands do; the promises reject with the reason shown in the name field. */
export type ProjectTreeActions = {
  open: (path: string) => void;
  create: (folder: string, name: string, kind: NewItemKind) => Promise<void>;
  rename: (path: string, name: string) => Promise<void>;
  move: (path: string, folder: string) => void;
  delete: (path: string, folder: boolean, files: number) => void;
  openMany?: (paths: string[]) => void;
  moveMany?: (paths: string[], folder: string) => void | Promise<boolean>;
  copyFiles?: (paths: string[], folder: string) => void;
  deleteMany?: (items: { path: string; folder: boolean; files: number }[]) => void;
  import: (folder: string) => void;
  reveal: (path: string) => void;
  /** a text file in a text tab, an image in an image tab. */
  openFile: (path: string, kind: "text" | "image") => void;
  /** hands a file to the system's default application. */
  openExternal: (path: string) => void;
  /** the specification : the References section. */
  addReference?: () => void;
  referenceCommand?: (command: ReferenceCommand, alias?: string, value?: string) => Promise<void>;
  openReferencedProject?: (root: string) => void;
  /** develops the referenced project's Julia package into this project's environment. */
  developReferencePackage?: (alias: string, name: string) => void;
};

/** Transient editor status for one project-relative file path. */
export type ProjectFileStatus = { modified?: boolean; errors?: number; missingResources?: number };

/** A small icon by kind, drawn in the current text colour. */
function ItemIcon({ kind, open }: { kind: TreeEntry["kind"]; open?: boolean }) {
  const paths: Record<TreeEntry["kind"], ReactNode> = {
    folder: open
      ? <path d="M1.5 4.5h4l1.5 1.5h7.5v1.5H4.5L2 13H1.5z M4.5 7.5H15l-2.5 5.5H2z" />
      : <path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" />,
    worksheet: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M5.5 7h5M5.5 9.5h5M5.5 12h3" className="stroke" /></>,
    julia: <><circle cx="8" cy="4.5" r="2.2" /><circle cx="4.5" cy="10.5" r="2.2" /><circle cx="11.5" cy="10.5" r="2.2" /></>,
    image: <><path d="M1.5 2.5h13v11h-13z" /><path d="M2.5 12l3.5-4 2.5 3 2-2 3 3z" className="fill" /></>,
    other: <path d="M3.5 1.5h6l3 3v10h-9z" />,
    link: <><path d="M3.5 1.5h6l3 3v10h-9z" /><path d="M5 10h6M8 7l3 3-3 3" className="stroke" /></>,
  };
  return <svg className={`tree-icon ${kind}`} viewBox="0 0 16 16" aria-hidden="true">{paths[kind]}</svg>;
}

type Editing =
  | { kind: "rename"; path: string }
  | { kind: "new"; folder: string; item: NewItemKind };

type Menu = { path: string; x: number; y: number };

/** The inline name field of a rename or a new item: Enter or leaving it applies, Escape cancels. */
function NameField({ initial, selectStem, depth, onDone, onCancel }: {
  initial: string;
  selectStem: boolean;
  depth: number;
  onDone: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const busy = useRef(false);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    const dot = initial.lastIndexOf(".");
    field.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);
  const apply = async () => {
    if (busy.current) return;
    const name = value.trim();
    if (name === "" || name === initial) {
      onCancel();
      return;
    }
    busy.current = true;
    try {
      await onDone(name);
    } catch (reason) {
      setError(typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message) : String(reason));
      busy.current = false;
      input.current?.focus();
    }
  };
  return <div className="tree-edit" style={{ paddingLeft: 8 + depth * 12 + 16 }}>
    <input
      ref={input}
      aria-label={S.project.itemName}
      value={value}
      onChange={(event) => { setValue(event.target.value); setError(""); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") { event.preventDefault(); void apply(); }
        if (event.key === "Escape") { event.preventDefault(); onCancel(); }
      }}
      onBlur={() => { if (!error) void apply(); }}
    />
    {error && <div className="tree-error" role="alert">{error}</div>}
  </div>;
}

export function ProjectTree({ project, entries, activeRoot, actions, fileStatus, references }: {
  project: OpenedProject;
  entries: readonly TreeEntry[];
  activeRoot: string | null;
  actions: ProjectTreeActions;
  fileStatus?: Record<string, ProjectFileStatus>;
  references?: ProjectReferences | null;
}) {
  const { manifest, root } = project;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // The top-level folders start open, once the tree has arrived.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || entries.length === 0) return;
    opened.current = true;
    setExpanded((current) => new Set([...current, ...entries.filter((e) => e.kind === "folder" && !e.path.includes("/") && !e.path.startsWith(".")).map((e) => e.path)]));
  }, [entries]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [lead, setLead] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    x: number;
    y: number;
    label: string;
    kind: TreeEntry["kind"];
    count: number;
    copy: boolean;
    paths: readonly string[];
  } | null>(null);
  const pointerDrag = useRef<{ id: number; x: number; y: number; paths: string[]; active: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [clipboard, setClipboard] = useState<{ paths: string[]; cut: boolean } | null>(null);
  useEffect(() => setClipboard(null), [root]);
  const tree = useRef<HTMLDivElement>(null);
  const kinds = useMemo(() => new Map(entries.map((entry) => [entry.path, entry.kind])), [entries]);
  const activePath = entries.find((entry) => entry.kind !== "folder" && activeRoot !== null && sameFile(activeRoot, projectWorksheetPath(root, entry.path)))?.path ?? null;

  // The active worksheet's folders open, so its row can be seen.
  useEffect(() => {
    if (!activePath) return;
    setExpanded((open) => {
      const next = new Set(open);
      let changed = false;
      for (let folder = parentOf(activePath); folder !== ""; folder = parentOf(folder)) {
        if (!next.has(folder)) { next.add(folder); changed = true; }
      }
      return changed ? next : open;
    });
  }, [activePath]);

  const visible = useMemo(() => entries.filter((entry) => {
    for (let folder = parentOf(entry.path); folder !== ""; folder = parentOf(folder)) if (!expanded.has(folder)) return false;
    return true;
  }), [entries, expanded]);
  const visiblePaths = useMemo(() => new Set(visible.map((entry) => entry.path)), [visible]);
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((path) => visiblePaths.has(path)));
      return next.size === current.size ? current : next;
    });
    if (lead && !visiblePaths.has(lead)) setLead(null);
    if (anchor.current && !visiblePaths.has(anchor.current)) anchor.current = null;
  }, [visiblePaths, lead]);
  const toggle = (path: string, open?: boolean) => setExpanded((current) => {
    const next = new Set(current);
    if (open ?? !next.has(path)) next.add(path);
    else next.delete(path);
    return next;
  });
  /** The folder a New or Import works in: the selected folder, the folder of the selected file, or the root. */
  const targetFolder = (path: string | null) => (path === null ? "" : kinds.get(path) === "folder" ? path : parentOf(path));
  const filesIn = (path: string) => entries.filter((entry) => entry.kind !== "folder" && entry.path.startsWith(`${path}/`)).length;

  const startNew = (path: string | null, item: NewItemKind) => {
    const folder = targetFolder(path);
    if (folder) toggle(folder, true);
    setEditing({ kind: "new", folder, item });
  };
  const selectOnly = (path: string) => {
    setSelected(new Set([path]));
    setLead(path);
    anchor.current = path;
  };
  const choose = (entry: TreeEntry) => {
    selectOnly(entry.path);
    tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(entry.path)}"]`)?.focus();
    if (entry.kind === "folder") toggle(entry.path);
    else if (entry.kind === "worksheet") actions.open(projectWorksheetPath(root, entry.path));
    else if (entry.kind === "image") actions.openFile(entry.path, "image");
    else actions.openFile(entry.path, "text");
  };
  const isSupportedOpen = (entry: TreeEntry) => entry.kind !== "folder";
  const selectedInOrder = () => visible.filter((entry) => selected.has(entry.path));
  const compactPaths = (paths: string[]) => paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`) && kinds.get(other) === "folder"));
  const remove = (path: string) => actions.delete(path, kinds.get(path) === "folder", filesIn(path));
  const removeSelection = () => {
    const paths = compactPaths(selectedInOrder().map((entry) => entry.path));
    if (selected.size <= 1) {
      const path = paths[0];
      if (path) remove(path);
      return;
    }
    if (!actions.deleteMany) return;
    actions.deleteMany(paths.map((path) => ({ path, folder: kinds.get(path) === "folder", files: filesIn(path) })));
  };
  const openSelection = () => {
    const paths = selectedInOrder().filter(isSupportedOpen).map((entry) => entry.path);
    if (paths.length) actions.openMany?.(paths);
  };
  const remember = (cut: boolean) => {
    const paths = compactPaths(selectedInOrder().map((entry) => entry.path));
    if (paths.length && paths.every((path) => kinds.get(path) !== "link") && (cut || paths.every((path) => kinds.get(path) !== "folder"))) setClipboard({ paths, cut });
  };
  const paste = (target: string | null) => {
    if (!clipboard) return;
    const folder = targetFolder(target);
    if (clipboard.cut) {
      if (clipboard.paths.some((path) => path === folder || (kinds.get(path) === "folder" && folder.startsWith(`${path}/`)))) return;
      const paths = clipboard.paths.filter((path) => parentOf(path) !== folder);
      if (paths.length && actions.moveMany) {
        void Promise.resolve(actions.moveMany(paths, folder)).then((moved) => {
          if (moved !== false) setClipboard((current) => current === clipboard ? null : current);
        });
      }
    } else {
      actions.copyFiles?.(clipboard.paths, folder);
    }
    if (folder) toggle(folder, true);
  };
  const rangeTo = (path: string, union: boolean) => {
    const anchorPath = anchor.current && visiblePaths.has(anchor.current) ? anchor.current : (lead ?? path);
    const anchorIndex = visible.findIndex((entry) => entry.path === anchorPath);
    const end = visible.findIndex((entry) => entry.path === path);
    const start = anchorIndex < 0 ? end : anchorIndex;
    const range = visible.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => entry.path);
    setSelected((current) => new Set(union ? [...current, ...range] : range));
    setLead(path);
  };
  const toggleSelection = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
    setLead(path);
    anchor.current = path;
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    // The worksheet's shortcuts never see the explorer's keys (F2, Delete, arrows).
    event.stopPropagation();
    // The row that has the keyboard, else the selected one.
    const focused = (event.target as HTMLElement).closest?.("[data-path]")?.getAttribute("data-path") ?? lead;
    const at = focused === null ? -1 : visible.findIndex((entry) => entry.path === focused);
    const current = at >= 0 ? visible[at] : null;
    const select = (index: number, extend = false, union = false) => {
      const entry = visible[Math.max(0, Math.min(visible.length - 1, index))];
      if (!entry) return;
      if (extend) rangeTo(entry.path, union);
      else selectOnly(entry.path);
    };
    const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.getModifierState("AltGraph");
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); select(at + 1, event.shiftKey, modifier); break;
      case "ArrowUp": event.preventDefault(); select(at < 0 ? 0 : at - 1, event.shiftKey, modifier); break;
      case "Home": event.preventDefault(); select(0, event.shiftKey, modifier); break;
      case "End": event.preventDefault(); select(visible.length - 1, event.shiftKey, modifier); break;
      case "a":
      case "A": if (modifier) { event.preventDefault(); setSelected(new Set(visible.map((entry) => entry.path))); if (lead === null && visible[0]) { setLead(visible[0].path); anchor.current = visible[0].path; } } break;
      case "c": case "C": if (modifier) { event.preventDefault(); remember(false); } break;
      case "x": case "X": if (modifier) { event.preventDefault(); remember(true); } break;
      case "v": case "V": if (modifier) { event.preventDefault(); paste(current?.path ?? null); } break;
      case "Escape": if (selected.size > 1) { event.preventDefault(); setSelected(lead ? new Set([lead]) : new Set()); anchor.current = lead; } break;
      case "ArrowRight":
        event.preventDefault();
        if (current?.kind === "folder") {
          if (!expanded.has(current.path)) toggle(current.path, true);
          else select(at + 1);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (current?.kind === "folder" && expanded.has(current.path)) toggle(current.path, false);
        else if (current && parentOf(current.path)) selectOnly(parentOf(current.path));
        break;
      case "Enter": if (selected.size > 1) { event.preventDefault(); openSelection(); } else if (current) { event.preventDefault(); choose(current); } break;
      case "F2": if (current && selected.size <= 1) { event.preventDefault(); setEditing({ kind: "rename", path: current.path }); } break;
      case "Delete": if (current) { event.preventDefault(); if (selected.has(current.path)) removeSelection(); else remove(current.path); } break;
      case "F10":
      case "ContextMenu":
        if (event.key === "ContextMenu" || event.shiftKey) {
          event.preventDefault();
          const row = tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(current?.path ?? "")}"]`)?.getBoundingClientRect();
          setMenu({ path: current?.path ?? "", x: row ? row.left + 24 : 24, y: row ? row.bottom : 24 });
        }
        break;
    }
  };

  // The tree keeps the keyboard on its selected row.
  useEffect(() => {
    if (!lead || editing || menu) return;
    const row = tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(lead)}"]`);
    if (row && tree.current?.contains(document.activeElement)) row.focus();
  }, [lead, editing, menu]);

  const dragOver = (folder: string) => (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("application/x-equavela-path") && !event.dataTransfer.types.includes("application/x-equavela-paths")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? "copy" : "move";
    setDropTarget(folder);
  };
  const drop = (folder: string) => (event: DragEvent) => {
    const rawPaths = event.dataTransfer.getData("application/x-equavela-paths");
    const legacyPath = event.dataTransfer.getData("application/x-equavela-path");
    let paths: string[] = [];
    try { paths = rawPaths ? JSON.parse(rawPaths) as string[] : legacyPath ? [legacyPath] : []; } catch { paths = legacyPath ? [legacyPath] : []; }
    setDropTarget(null);
    if (!paths.length) return;
    event.preventDefault();
    event.stopPropagation();
    paths = compactPaths(paths);
    transferPaths(paths, folder, event.ctrlKey || event.metaKey, !!rawPaths);
  };

  const transferPaths = (source: string[], folder: string, copy: boolean, group: boolean) => {
    let paths = compactPaths(source);
    if (paths.some((path) => path === folder || (kinds.get(path) === "folder" && folder.startsWith(`${path}/`)))) return;
    if (copy) {
      if (paths.every((path) => kinds.get(path) !== "folder" && kinds.get(path) !== "link")) actions.copyFiles?.(paths, folder);
    } else {
      paths = paths.filter((path) => parentOf(path) !== folder);
      if (!paths.length) return;
      if (group || paths.length > 1) actions.moveMany?.(paths, folder);
      else actions.move(paths[0], folder);
    }
    if (folder) toggle(folder, true);
  };

  const folderAt = (x: number, y: number): string | null => {
    const target = document.elementFromPoint(x, y);
    if (!target || !tree.current?.contains(target)) return null;
    const row = target.closest<HTMLElement>(".tree-row[data-path]");
    if (!row) return "";
    const path = row.dataset.path ?? "";
    return kinds.get(path) === "folder" ? path : parentOf(path);
  };

  const newField = (folder: string) => editing?.kind === "new" && editing.folder === folder && (
    <NameField
      key={`new-${folder}`}
      initial=""
      selectStem={false}
      depth={folder === "" ? 0 : depthOf(folder) + 1}
      onCancel={() => setEditing(null)}
      onDone={async (name) => {
        await actions.create(folder, name, editing.item);
        setEditing(null);
      }}
    />
  );

  const rows: ReactNode[] = [];
  const rootField = newField("");
  if (rootField) rows.push(rootField);
  for (const entry of visible) {
    const depth = depthOf(entry.path);
    const folder = entry.kind === "folder";
    const open = folder && expanded.has(entry.path);
    const path = projectWorksheetPath(root, entry.path);
    if (editing?.kind === "rename" && editing.path === entry.path) {
      rows.push(<NameField
        key={`rename-${entry.path}`}
        initial={nameOf(entry.path)}
        selectStem={!folder}
        depth={depth}
        onCancel={() => setEditing(null)}
        onDone={async (name) => {
          await actions.rename(entry.path, name);
          setEditing(null);
          selectOnly(parentOf(entry.path) ? `${parentOf(entry.path)}/${name}` : name);
        }}
      />);
    } else {
      const status = entry.kind === "folder" ? undefined : fileStatus?.[entry.path];
      const modified = status?.modified === true;
      const errors = Number.isFinite(status?.errors) ? Math.max(0, Math.floor(status?.errors ?? 0)) : 0;
      const missingResources = Number.isFinite(status?.missingResources) ? Math.max(0, Math.floor(status?.missingResources ?? 0)) : 0;
      rows.push(<div
        key={entry.path}
        role="treeitem"
        data-path={entry.path}
        title={path}
        aria-level={depth + 1}
        aria-expanded={folder ? open : undefined}
        aria-selected={selected.has(entry.path)}
        aria-current={entry.path === activePath ? "page" : undefined}
        tabIndex={lead === entry.path || (lead === null && entry === visible[0]) ? 0 : -1}
        className={`tree-row${dropTarget === entry.path ? " drop" : ""}${dragGhost?.paths.includes(entry.path) ? " dragging" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        draggable={false}
        onPointerDown={(event) => {
          if (event.button !== 0 || entry.kind === "link") return;
          pointerDrag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, paths: selected.has(entry.path) ? compactPaths(selectedInOrder().map((item) => item.path)) : [entry.path], active: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = pointerDrag.current;
          if (!drag || drag.id !== event.pointerId) return;
          if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
          drag.active = true;
          setDropTarget(folderAt(event.clientX, event.clientY));
          const firstPath = drag.paths[0] ?? entry.path;
          setDragGhost({
            x: event.clientX,
            y: event.clientY,
            label: nameOf(firstPath),
            kind: kinds.get(firstPath) ?? entry.kind,
            count: drag.paths.length,
            copy: event.ctrlKey || event.metaKey,
            paths: drag.paths,
          });
        }}
        onPointerUp={(event) => {
          const drag = pointerDrag.current;
          if (!drag || drag.id !== event.pointerId) return;
          pointerDrag.current = null;
          if (!drag.active) return;
          const folder = folderAt(event.clientX, event.clientY);
          setDropTarget(null);
          setDragGhost(null);
          suppressClick.current = true;
          setTimeout(() => { suppressClick.current = false; }, 0);
          if (folder !== null) transferPaths(drag.paths, folder, event.ctrlKey || event.metaKey, drag.paths.length > 1);
        }}
        onPointerCancel={() => { pointerDrag.current = null; setDropTarget(null); setDragGhost(null); }}
        onDragStart={(event) => {
          const paths = selected.has(entry.path) ? compactPaths(selectedInOrder().map((item) => item.path)) : [entry.path];
          if (selected.has(entry.path) && selected.size > 1) event.dataTransfer.setData("application/x-equavela-paths", JSON.stringify(paths));
          else event.dataTransfer.setData("application/x-equavela-path", paths[0] ?? entry.path);
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={folder ? dragOver(entry.path) : undefined}
        onDragLeave={() => setDropTarget((target) => (target === entry.path ? null : target))}
        onDrop={folder ? drop(entry.path) : undefined}
        onClick={(event) => {
          if (suppressClick.current) { event.preventDefault(); return; }
          // the first click of a double click already toggled the folder; the second
          // must not fold it back. A file takes every click: a repeated one joins its opening.
          if (folder && event.detail > 1 && !event.shiftKey && !event.ctrlKey && !event.metaKey) return;
          if (event.shiftKey) rangeTo(entry.path, event.ctrlKey || event.metaKey);
          else if (event.ctrlKey || event.metaKey) toggleSelection(entry.path);
          else choose(entry);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!selected.has(entry.path)) selectOnly(entry.path);
          setMenu({ path: entry.path, x: event.clientX, y: event.clientY });
        }}
      >
        <span className={`tree-chevron${folder ? (open ? " open" : "") : " none"}`} aria-hidden="true" />
        <ItemIcon kind={entry.kind} open={open} />
        <span className="tree-name">{nameOf(entry.path)}</span>
        {modified && <span className="tree-dirty" title={S.project.fileModified} aria-label={S.project.fileModified}>●</span>}
        {errors > 0 && <span className="tree-error-count" title={S.project.fileErrors(errors)} aria-label={S.project.fileErrors(errors)}>{errors}</span>}
        {missingResources > 0 && <span className="tree-resource-count" title={S.project.fileMissingResources(missingResources)} aria-label={S.project.fileMissingResources(missingResources)}>▧ {missingResources}</span>}
      </div>);
      if (folder && open) {
        const field = newField(entry.path);
        if (field) rows.push(field);
      }
    }
  }

  const menuTarget = menu ? (menu.path === "" ? null : menu.path) : null;
  const menuSelection = menuTarget && selected.has(menuTarget) ? selectedInOrder() : menuTarget ? [entries.find((entry) => entry.path === menuTarget)!].filter(Boolean) : [];
  const menuIsGroup = menuSelection.length > 1;
  const menuKind = menuTarget === null ? "folder" : kinds.get(menuTarget);
  const command = (run: () => void) => () => { setMenu(null); run(); };

  return <nav aria-label={S.project.explorer} className="project-tree chrome">
    <div className="tree-header">
      <span className="tree-title" title={root}>{manifest.name}</span>
      <span className="tree-tools">
        <button type="button" title={S.project.newWorksheet} aria-label={S.project.newWorksheet} onClick={() => startNew(lead, "worksheet")}><ItemIcon kind="worksheet" /></button>
        <button type="button" title={S.project.newJulia} aria-label={S.project.newJulia} onClick={() => startNew(lead, "julia")}><ItemIcon kind="julia" /></button>
        <button type="button" title={S.project.newFolder} aria-label={S.project.newFolder} onClick={() => startNew(lead, "folder")}><ItemIcon kind="folder" /></button>
        <button type="button" title={S.project.importFiles} aria-label={S.project.importFiles} onClick={() => actions.import(targetFolder(lead))}>⤓</button>
        <button type="button" title={S.project.collapseAll} aria-label={S.project.collapseAll} onClick={() => setExpanded(new Set())}>⊟</button>
      </span>
    </div>
    <div
      ref={tree}
      role="tree"
      aria-label={manifest.name}
      aria-multiselectable="true"
      className={`tree-body${dropTarget === "" ? " drop" : ""}`}
      onKeyDown={keyDown}
      onDragOver={dragOver("")}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDropTarget(null); }}
      onDrop={drop("")}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ path: "", x: event.clientX, y: event.clientY });
      }}
    >
      {rows}
    </div>
    {dragGhost && (
      <div
        className="tree-drag-ghost no-print"
        data-testid="tree-drag-ghost"
        aria-hidden="true"
        style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
      >
        <ItemIcon kind={dragGhost.kind} />
        <span className="tree-drag-label">{dragGhost.label}</span>
        {dragGhost.count > 1 && <span className="tree-drag-count">{dragGhost.count}</span>}
        {dragGhost.copy && <span className="tree-drag-copy">+</span>}
      </div>
    )}
    {selected.size > 1 && <div className="tree-selection-summary" role="status">{S.project.selectedCount(selected.size)}</div>}
    {references && <ReferencesSection references={references.references} actions={actions} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      {menuIsGroup && <>
        <button type="button" role="menuitem" disabled={!actions.openMany || !menuSelection.some(isSupportedOpen)} onClick={command(openSelection)}>{S.project.openSelected}</button>
        <button type="button" role="menuitem" disabled={!actions.deleteMany} onClick={command(removeSelection)}>{S.project.deleteSelected}</button>
        <hr />
      </>}
      <button type="button" role="menuitem" onClick={command(() => startNew(menuTarget, "worksheet"))}>{S.project.newWorksheet}</button>
      <button type="button" role="menuitem" onClick={command(() => startNew(menuTarget, "julia"))}>{S.project.newJulia}</button>
      <button type="button" role="menuitem" onClick={command(() => startNew(menuTarget, "folder"))}>{S.project.newFolder}</button>
      <button type="button" role="menuitem" onClick={command(() => actions.import(targetFolder(menuTarget)))}>{S.project.importFiles}</button>
      <hr />
      <button type="button" role="menuitem" disabled={!menuSelection.length || menuSelection.some((entry) => entry.kind === "folder" || entry.kind === "link") || !actions.copyFiles} onClick={command(() => remember(false))}>{S.project.copyFiles}</button>
      <button type="button" role="menuitem" disabled={!menuSelection.length || menuSelection.some((entry) => entry.kind === "link") || !actions.moveMany} onClick={command(() => remember(true))}>{S.project.cutFiles}</button>
      <button type="button" role="menuitem" disabled={!clipboard} onClick={command(() => paste(menuTarget))}>{S.project.pasteFiles}</button>
      {menuTarget !== null && <>
        <hr />
        {!menuIsGroup && menuKind !== "folder" && <button type="button" role="menuitem" onClick={command(() => actions.openExternal(menuTarget))}>{S.project.openExternal}</button>}
        {!menuIsGroup && <button type="button" role="menuitem" onClick={command(() => setEditing({ kind: "rename", path: menuTarget }))}>{S.project.rename}</button>}
        {!menuIsGroup && <button type="button" role="menuitem" onClick={command(() => remove(menuTarget))}>{S.project.delete}</button>}
      </>}
      <hr />
      <button type="button" role="menuitem" onClick={command(() => actions.reveal(menuTarget ?? ""))}>{S.project.reveal}</button>
    </ContextMenu>}
  </nav>;
}

/** the project's references, each expandable to its locked exports. */
function ReferencesSection({ references, actions }: { references: ProjectReferenceInfo[]; actions: ProjectTreeActions }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<{ alias: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const run = (command: ReferenceCommand, alias?: string, value?: string) => actions.referenceCommand?.(command, alias, value) ?? Promise.resolve();
  const target = menu ? references.find((reference) => reference.alias === menu.alias) : undefined;
  const close = () => setMenu(null);
  return <section className="tree-references" aria-label={S.references.title}>
    <div className="tree-header">
      <span className="tree-title">{S.references.title}</span>
      <span className="tree-tools">
        {actions.addReference && <button type="button" title={S.references.add} aria-label={S.references.add} onClick={actions.addReference}>+</button>}
        <button type="button" title={S.references.reload} aria-label={S.references.reload} onClick={() => void run("reload")}>⟳</button>
      </span>
    </div>
    <div role="tree" aria-label={S.references.title} className="tree-body">
      {references.length === 0 && <div className="tree-empty">{S.references.none}</div>}
      {references.map((reference) => {
        const expanded = open.has(reference.alias);
        const status = reference.problem ? S.references.missing : reference.out_of_date ? S.references.outOfDate : !reference.trusted ? S.references.untrusted : null;
        if (renaming === reference.alias) {
          return <NameField
            key={reference.alias}
            initial={reference.alias}
            selectStem={false}
            depth={0}
            onDone={async (name) => { await actions.referenceCommand?.("rename", reference.alias, name); setRenaming(null); }}
            onCancel={() => setRenaming(null)}
          />;
        }
        return <div key={reference.alias} role="none">
          <div
            role="treeitem"
            tabIndex={0}
            aria-level={1}
            aria-expanded={expanded}
            data-reference={reference.alias}
            title={reference.problem ?? (reference.root ?? reference.path)}
            className={`tree-row reference${reference.problem ? " missing" : ""}`}
            style={{ paddingLeft: 8 }}
            onClick={() => setOpen((current) => {
              const next = new Set(current);
              if (next.has(reference.alias)) next.delete(reference.alias); else next.add(reference.alias);
              return next;
            })}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "F2") { event.preventDefault(); setRenaming(reference.alias); }
              if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ alias: reference.alias, x: box.left + 16, y: box.bottom });
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setMenu({ alias: reference.alias, x: event.clientX, y: event.clientY });
            }}
          >
            <span className={`tree-chevron${expanded ? " open" : ""}`} aria-hidden="true" />
            <span className="tree-name"><strong>{reference.alias}</strong>{reference.name && reference.name !== reference.alias && <span className="tree-muted"> — {reference.name}</span>}</span>
            {status && <span className="tree-badge" title={reference.problem ?? status}>{reference.problem ? "!" : reference.out_of_date ? "↻" : "⚠"}</span>}
          </div>
          {expanded && <div role="group">
            {reference.api.length === 0 && <div className="tree-empty" style={{ paddingLeft: 32 }}>{S.references.noExports}</div>}
            {reference.api.map((entry) => <div key={entry.id} role="treeitem" aria-level={2} className="tree-row export" style={{ paddingLeft: 36 }}>
              <span className="tree-name">{S.references.signature(`${reference.alias}.${entry.name}`, entry.kind, entry.arity)}</span>
            </div>)}
          </div>}
        </div>;
      })}
    </div>
    {menu && target && <ContextMenu x={menu.x} y={menu.y} onClose={close}>
      <button type="button" role="menuitem" disabled={!target.root || !actions.openReferencedProject} onClick={() => { close(); if (target.root) actions.openReferencedProject?.(target.root); }}>{S.references.openProject}</button>
      <button type="button" role="menuitem" disabled={!!target.problem} onClick={() => { close(); void run("update", target.alias); }}>{S.references.update}</button>
      <button type="button" role="menuitem" onClick={() => { close(); setRenaming(target.alias); }}>{S.references.rename}</button>
      <button type="button" role="menuitem" disabled={!!target.problem} onClick={() => { close(); void run(target.trusted ? "untrust" : "trust", target.alias); }}>{target.trusted ? S.references.untrust : S.references.trust}</button>
      {target.package && !target.developed && actions.developReferencePackage && <button type="button" role="menuitem" onClick={() => { close(); actions.developReferencePackage?.(target.alias, target.package as string); }}>{S.references.developPackage(target.package)}</button>}
      <hr />
      <button type="button" role="menuitem" onClick={() => { close(); void run("remove", target.alias); }}>{S.references.remove}</button>
    </ContextMenu>}
  </section>;
}

/** A context menu at a point: the first item takes the keyboard, arrows walk it, Escape or a press outside closes it. */
function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
  useEffect(() => {
    items()[0]?.focus();
    const press = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [onClose]);
  return <div
    ref={menu}
    className="tree-menu"
    role="menu"
    aria-label={S.project.explorer}
    style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 260) }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const all = items();
        const at = all.indexOf(document.activeElement as HTMLElement);
        all[(at + (event.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      }
    }}
  >{children}</div>;
}
