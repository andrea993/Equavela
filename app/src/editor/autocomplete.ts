// Pure autocomplete for the structural editor. It never changes key resolution: the
// workbench asks for candidates after a key has been resolved, and Tab accepts the first
// candidate only when the caret is at the end of a non-empty identifier.

import { UNIT_NAMES } from "../math/units";
import { BUILTIN_ENTRIES } from "../catalog/builtins";
import { SYMBOLIC_KEYWORDS } from "../catalog/palettes";
import { get } from "./tree";
import { typeText, type EditorState } from "./model";

export type CompletionKind = "defined" | "builtin" | "unit";

export type Completion = {
  name: string;
  kind: CompletionKind;
  /** Function signature; absent for worksheet names and units. */
  detail?: string;
  /** One-line description (built-in functions). */
  description?: string;
};

// Names, signatures and descriptions come from the function catalogue.
export const BUILTIN_COMPLETIONS: readonly Completion[] = BUILTIN_ENTRIES.map((entry) => ({
  name: entry.name,
  detail: entry.signature,
  description: entry.description,
  kind: "builtin" as const,
}));

/** The symbolic keywords, offered (and only they) in the keyword slot above `→`. */
export const SYMBOLIC_KEYWORD_COMPLETIONS: readonly Completion[] = SYMBOLIC_KEYWORDS.map((name) => ({
  name,
  kind: "builtin" as const,
  description: "Symbolic keyword",
}));

/** Whether the caret is in the keyword of a symbolic evaluation (`simplify`, `solve`, ...). */
export function inKeywordSlot(editor: EditorState): boolean {
  const f = editor.focus;
  return f.length >= 2 && f[f.length - 1] === 0 && get(editor.root, f.slice(0, -1)).type === "KeywordGroup";
}

/** The keyword that opens a solve block: not a function, so not in the built-in catalogue. */
export const GIVEN_COMPLETION: Completion = {
  name: "Given",
  kind: "builtin",
  description: "Opens a solve block: constraints follow, then Find, Minerr, Minimize or Maximize",
};

export function completionCatalog(defined: ReadonlySet<string>): Completion[] {
  const result: Completion[] = [...defined].map((name) => ({ name, kind: "defined" }));
  result.push(...BUILTIN_COMPLETIONS, GIVEN_COMPLETION);
  for (const name of UNIT_NAMES) result.push({ name, kind: "unit" });
  return result;
}

/** The identifier prefix before the caret, or null when completion must stay inactive. */
export function completionPrefix(editor: EditorState): string | null {
  if (editor.explicit || !editor.caret) return null;
  const node = get(editor.root, editor.focus);
  if (node.type !== "Ident" || editor.caret.seg !== 0) return null;
  const text = node.name.segments[0]?.text ?? "";
  if (editor.caret.offset !== text.length || text.length === 0) return null;
  return text;
}

export function completions(editor: EditorState, catalog: readonly Completion[], limit = 8): Completion[] {
  const prefix = completionPrefix(editor);
  // One letter is not worth a list: it would swallow the arrow keys while the user types `s` or `i`
  // (found driving the real app: ArrowDown after a loop body chose a suggestion).
  if (!prefix || prefix.length < 2) return [];
  if (inKeywordSlot(editor)) catalog = SYMBOLIC_KEYWORD_COMPLETIONS;
  // The complete name stays in the list when a longer name starts with it (`vec`, `vec2str`), so its
  // signature shows; alone it is no list, so Enter and the arrows keep their meaning.
  if (!catalog.some((item) => item.name !== prefix && item.name.startsWith(prefix))) return [];
  const seen = new Set<string>();
  return catalog
    .filter((item) => item.name.startsWith(prefix))
    .sort((a, b) => {
      const aKind = a.kind === "defined" ? 0 : a.kind === "builtin" ? 1 : 2;
      const bKind = b.kind === "defined" ? 0 : b.kind === "builtin" ? 1 : 2;
      return aKind - bKind || a.name.localeCompare(b.name);
    })
    .filter((item) => !seen.has(item.name) && !!seen.add(item.name))
    .slice(0, limit);
}

/**
 * Completes the current identifier as one local undo step. A unit is inserted with its label
 * (`m@unit`), because a plain name in a value position is not a unit.
 */
export function acceptCompletion(editor: EditorState, completion: Completion): EditorState {
  const prefix = completionPrefix(editor);
  return prefix && completion.name.startsWith(prefix)
    ? typeText(editor, completion.name.slice(prefix.length), completion.kind === "unit" ? "unit" : null)
    : editor;
}

/** The function (or name) under the editor focus, for F1 help; null on anything else. */
export function nameAtFocus(editor: EditorState): string | null {
  let node = get(editor.root, editor.focus);
  if (node.type === "Call") node = node.callee;
  if (node.type !== "Ident") return null;
  const segments: { text: string }[] = node.name.segments;
  return segments.length === 1 && segments[0].text ? segments[0].text : null;
}
