/**
 * Project folder under a native file drop target, or `null` when the pointer is outside the
 * explorer. A file row imports beside that file; a folder row imports
 * into that folder. Empty tree space and the explorer header mean the project root.
 */
export function projectDropFolder(target: Element | null): string | null {
  if (!target) return null;
  if (target.closest(".project-explorer-backdrop")) return null;
  const tree = target.closest<HTMLElement>(".project-tree");
  if (!tree) return target.closest(".project-explorer-frame") ? "" : null;
  const row = target.closest<HTMLElement>("[data-path]");
  if (!row || !tree.contains(row)) return "";
  const path = row.dataset.path;
  if (path === undefined) return "";
  if (row.hasAttribute("aria-expanded")) return path;
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}
