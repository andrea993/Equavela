// The tabs a project had open: with no main worksheet, opening a project
// restores the worksheets and files of its last session, and the tab that was in front.
// Kept per viewer in localStorage; a read or write that fails changes nothing.

export type ProjectSession = {
  /** Project-relative `/` paths of the open worksheets, in tab order. */
  sheets: string[];
  /** The open text and image files. */
  files: { path: string; kind: "text" | "image" }[];
  /** The project-relative path of the tab in front, or null. */
  active: string | null;
};

const PREFIX = "equavela.projectSession:";

/** A root as the file system compares it: `/` separators, a Windows drive case-insensitive. */
function rootKey(root: string): string {
  const path = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

/** The project-relative path of `path` inside `root`, or null when it is outside. */
export function relativeTo(root: string, path: string): string | null {
  const base = `${rootKey(root)}/`;
  const full = path.replace(/\\/g, "/");
  const key = /^[A-Za-z]:\//.test(full) ? full.toLowerCase() : full;
  return key.startsWith(base) ? full.slice(base.length) : null;
}

export function saveProjectSession(root: string, session: ProjectSession): void {
  try {
    localStorage.setItem(PREFIX + rootKey(root), JSON.stringify(session));
  } catch {
    /* no storage: the next open restores nothing */
  }
}

export function loadProjectSession(root: string): ProjectSession | null {
  try {
    const raw = localStorage.getItem(PREFIX + rootKey(root));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ProjectSession>;
    const sheets = Array.isArray(value.sheets) ? value.sheets.filter((s): s is string => typeof s === "string") : [];
    const files = Array.isArray(value.files)
      ? value.files.filter((f): f is ProjectSession["files"][number] =>
          !!f && typeof f.path === "string" && (f.kind === "text" || f.kind === "image"))
      : [];
    return { sheets, files, active: typeof value.active === "string" ? value.active : null };
  } catch {
    return null;
  }
}
