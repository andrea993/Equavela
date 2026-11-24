// The user manual: the static site of the submodule at docs/manual, served by the app at
// /manual/ (app/scripts/manual-site.mjs). The anchors follow the manual's generator.

import { invoke } from "@tauri-apps/api/core";
import type { BuiltinEntry } from "./catalog/builtins";

/** The page of a category: its title in lowercase words joined by hyphens. */
export function manualSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The anchor of a function entry: letters and digits as they are, any other character as `_<hex>`. */
export function manualAnchor(name: string): string {
  return "f-" + [...name].map((c) => (/[A-Za-z0-9]/.test(c) ? c : `_${c.codePointAt(0)!.toString(16)}`)).join("");
}

/** The manual page of a built-in function, relative to the app root. */
export function functionManualPath(entry: Pick<BuiltinEntry, "name" | "category">): string {
  return `manual/functions/${manualSlug(entry.category)}.html#${manualAnchor(entry.name)}`;
}

/** Opens a page of the manual in its own window (desktop) or a new browser tab. */
export async function openManual(page = "manual/index.html"): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("open_manual", { page });
  } else {
    window.open(`/${page}`, "_blank", "noopener");
  }
}
