// The unit catalogue, grouped by dimension. It reads the same table as core and EqRuntime
// (`kernel/EqRuntime/src/units.tsv`), so the palette, the command palette and autocomplete
// can only offer names the engine accepts.

import raw from "../../../kernel/EqRuntime/src/units.tsv?raw";

export type UnitEntry = {
  name: string;
  /** Exponents of length, mass, time, current, temperature, amount, luminous intensity. */
  dimension: string;
  /** Also exists with every SI prefix (`km`, `kN`). */
  prefixable: boolean;
  definition: string;
  group: string;
};

export type UnitGroup = { title: string; units: UnitEntry[] };

// Dimension exponents to a readable group title, in display order.
const GROUPS: ReadonlyArray<[string, string]> = [
  ["1,0,0,0,0,0,0", "Length"],
  ["2,0,0,0,0,0,0", "Area"],
  ["3,0,0,0,0,0,0", "Volume"],
  ["0,1,0,0,0,0,0", "Mass"],
  ["0,0,1,0,0,0,0", "Time"],
  ["0,0,-1,0,0,0,0", "Frequency"],
  ["1,0,-1,0,0,0,0", "Velocity"],
  ["1,1,-2,0,0,0,0", "Force"],
  ["-1,1,-2,0,0,0,0", "Pressure"],
  ["2,1,-2,0,0,0,0", "Energy"],
  ["2,1,-3,0,0,0,0", "Power"],
  ["0,0,0,1,0,0,0", "Electric current"],
  ["0,0,1,1,0,0,0", "Electric charge"],
  ["2,1,-3,-1,0,0,0", "Voltage"],
  ["2,1,-3,-2,0,0,0", "Resistance"],
  ["-2,-1,3,2,0,0,0", "Conductance"],
  ["-2,-1,4,2,0,0,0", "Capacitance"],
  ["2,1,-2,-2,0,0,0", "Inductance"],
  ["2,1,-2,-1,0,0,0", "Magnetic flux"],
  ["0,1,-2,-1,0,0,0", "Magnetic flux density"],
  ["0,0,0,0,1,0,0", "Temperature"],
  ["0,0,0,0,0,1,0", "Amount of substance"],
  ["0,0,0,0,0,0,1", "Luminous intensity"],
  ["-2,0,0,0,0,0,1", "Illuminance"],
  ["2,0,-2,0,0,0,0", "Absorbed dose"],
  ["0,0,0,0,0,0,0", "Dimensionless (angles)"],
];
const GROUP_TITLE = new Map(GROUPS);

const prefixes: { prefix: string; power: number }[] = [];
const entries: UnitEntry[] = [];

for (const line of raw.split(/\r?\n/)) {
  const text = line.trim();
  if (!text || text.startsWith("#")) continue;
  const fields = text.split(/\s+/);
  if (fields[0] === "@prefix") {
    prefixes.push({ prefix: fields[1], power: Number(fields[2]) });
    continue;
  }
  const [name, dimension, flag, ...definition] = fields;
  entries.push({
    name,
    dimension,
    prefixable: flag === "p",
    definition: definition.join(" "),
    group: GROUP_TITLE.get(dimension) ?? dimension,
  });
}
export const UNIT_PREFIXES: ReadonlyArray<{ prefix: string; power: number }> = prefixes;

export const UNIT_ENTRIES: readonly UnitEntry[] = entries;

export const UNIT_GROUPS: readonly UnitGroup[] = (() => {
  const byTitle = new Map<string, UnitEntry[]>();
  for (const entry of entries) byTitle.set(entry.group, [...(byTitle.get(entry.group) ?? []), entry]);
  const ordered = GROUPS.map(([, title]) => title).filter((title) => byTitle.has(title));
  const rest = [...byTitle.keys()].filter((title) => !ordered.includes(title));
  return [...ordered, ...rest].map((title) => ({ title, units: byTitle.get(title)! }));
})();
