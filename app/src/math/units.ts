// The unit names of the shared unit table. The list is the fixture that EqRuntime writes
// from `kernel/EqRuntime/src/units.tsv` and that `core/src/units.rs` checks against its own
// reading of the same file, so the view, the generator and the kernel agree on which names
// are units.

import raw from "../../../core/fixtures/unit-names.txt?raw";

export const UNIT_NAMES: ReadonlySet<string> = new Set(
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);
