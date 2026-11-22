// The recent worksheets of the title bar's Recent menu: the files opened, imported
// or saved on this machine, most recent first, at most RECENT_FILES_MAX. The list is per user and
// never part of a worksheet. It lives in the web view's localStorage next to the panel and ribbon
// layout: it is navigation state, not an option, so it is not one of the settings of .

/** The localStorage key of the list (a JSON array of absolute paths). */
export const RECENT_FILES_KEY = "equavela.recentFiles";

/** The localStorage key of the recent projects: their root folders. */
export const RECENT_PROJECTS_KEY = "equavela.recentProjects";

/** How many files the menu remembers. */
export const RECENT_FILES_MAX = 10;

/**
 * A usable list from anything: only non-empty strings, trimmed, no duplicates (the first occurrence
 * wins, so the list keeps its order) and at most RECENT_FILES_MAX entries.
 */
export function sanitizeRecentFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
    if (files.length === RECENT_FILES_MAX) break;
  }
  return files;
}

/** The list with `path` first: a path already in the list moves to the front, never repeats. */
export function withRecent(list: readonly string[], path: string): string[] {
  const trimmed = path.trim();
  if (trimmed === "") return [...list];
  return sanitizeRecentFiles([trimmed, ...list]);
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // A storage the web view refuses (private mode): the menu still works for this run.
    return null;
  }
}

/** The stored list; an empty one when nothing is stored or what is stored cannot be read. */
export function readRecentFiles(key: string = RECENT_FILES_KEY): string[] {
  const store = storage();
  if (!store) return [];
  try {
    return sanitizeRecentFiles(JSON.parse(store.getItem(key) ?? "null"));
  } catch {
    return [];
  }
}

/** Stores the list; a storage that refuses the write changes nothing on screen. */
export function writeRecentFiles(files: readonly string[], key: string = RECENT_FILES_KEY): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(sanitizeRecentFiles(files)));
  } catch {
    /* the list still works for this run */
  }
}

/** The file name of a path, with its extension. */
export function recentFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The folder of a path, without the file name; empty for a path with no folder. */
export function recentFileFolder(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0 ? "" : path.slice(0, at);
}
