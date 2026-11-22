// The worksheet calculation settings:
// `ORIGIN` is the index of the first array element, `TOL` the
// convergence tolerance of the numeric solvers, `CTOL` the tolerance with which a solve block
// accepts its constraints. All three are `settings:` keys of the worksheet file, and a value equal
// to the built-in default is not written, so a worksheet at the defaults carries none.

/** The built-in default of each setting. */
export const DEFAULT_CALCULATION_SETTINGS = { ORIGIN: 0, TOL: 0.001, CTOL: 0.001 } as const;

export type CalculationSettingKey = keyof typeof DEFAULT_CALCULATION_SETTINGS;

const KEYS = Object.keys(DEFAULT_CALCULATION_SETTINGS) as CalculationSettingKey[];

/** The canonical text of a default value, as a field shows it. */
export const defaultText = (key: CalculationSettingKey): string => String(DEFAULT_CALCULATION_SETTINGS[key]);

/**
 * The value a field may hold: `ORIGIN` an integer, `TOL` a positive
 * finite number, `CTOL` a non-negative finite number. `null` when the text
 * is not one of those.
 */
export function parseSetting(key: CalculationSettingKey, text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  if (key === "ORIGIN") return Number.isInteger(value) ? value : null;
  if (key === "TOL") return value > 0 ? value : null;
  return value >= 0 ? value : null;
}

/**
 * The settings a worksheet uses: the stored value when it is valid, the built-in default
 * otherwise
 * .
 */
export function calculationSettingsOf(
  settings: Record<string, string> | undefined,
): Record<CalculationSettingKey, string> {
  const read = (key: CalculationSettingKey) => {
    const stored = settings?.[key];
    const value = stored === undefined ? null : parseSetting(key, stored);
    return value === null ? defaultText(key) : String(value);
  };
  return { ORIGIN: read("ORIGIN"), TOL: read("TOL"), CTOL: read("CTOL") };
}

/**
 * The `settings:` edits of Apply: a value equal to the built-in default is removed
 * (`null`) instead of written, so a worksheet at the defaults has none of these keys.
 */
export function calculationSettingEdits(
  values: Record<CalculationSettingKey, number>,
): Record<string, string | null> {
  const edits: Record<string, string | null> = {};
  for (const key of KEYS) {
    edits[key] = values[key] === DEFAULT_CALCULATION_SETTINGS[key] ? null : String(values[key]);
  }
  return edits;
}

/** The edits of Reset: the three keys go away. */
export function clearCalculationSettings(): Record<string, string | null> {
  return Object.fromEntries(KEYS.map((key) => [key, null]));
}
