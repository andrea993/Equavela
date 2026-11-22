// The built-in function catalogue: signature, category and a one-line description for every
// name of `core::codegen::BUILTINS`. The fixture is generated from the specification
// (`node scripts/gen-builtin-catalogue.mjs`) and a Rust test keeps its name column equal to
// the codegen table, so autocomplete, the F2 catalogue, F1 help and the command palette
// all show exactly the functions the engine knows.

import raw from "../../../core/fixtures/builtin-catalogue.tsv?raw";

export type BuiltinEntry = {
  name: string;
  signature: string;
  category: string;
  description: string;
};

export const BUILTIN_ENTRIES: readonly BuiltinEntry[] = raw
  .split(/\r?\n/)
  .filter((line) => line.length > 0)
  .map((line) => {
    const [name, signature, category, description] = line.split("\t");
    return { name, signature, category, description };
  });

const BY_NAME = new Map(BUILTIN_ENTRIES.map((entry) => [entry.name, entry]));

export function builtinEntry(name: string): BuiltinEntry | undefined {
  return BY_NAME.get(name);
}

export const BUILTIN_CATEGORIES: readonly string[] = [...new Set(BUILTIN_ENTRIES.map((entry) => entry.category))].sort();

/** Case-insensitive search: name prefix, then name, signature, category and description. */
export function searchBuiltins(query: string, entries: readonly BuiltinEntry[] = BUILTIN_ENTRIES): BuiltinEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  const rank = (entry: BuiltinEntry): number => {
    const name = entry.name.toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    if (entry.signature.toLowerCase().includes(needle)) return 3;
    if (entry.category.toLowerCase().includes(needle)) return 4;
    if (entry.description.toLowerCase().includes(needle)) return 5;
    return -1;
  };
  return entries
    .map((entry) => ({ entry, score: rank(entry) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
    .map((x) => x.entry);
}
