// Number and unit formatting of results.
// Display precision never affects computation: these functions only produce text.

import type { DimensionComponent, DisplayUnit, KernelValue, WireFloat } from "../equavelaApi";

/** Result format types: General is the default. */
export type NumberKind = "general" | "decimal" | "scientific" | "engineering" | "percent";
export const NUMBER_KINDS: NumberKind[] = ["general", "decimal", "scientific", "engineering", "percent"];

/** The radix of the digits of a result: decimal is the default. */
export type Radix = "decimal" | "binary" | "octal" | "hexadecimal";
export const RADIXES: Radix[] = ["decimal", "binary", "octal", "hexadecimal"];
const RADIX_BASE: Record<Radix, number> = { decimal: 10, binary: 2, octal: 8, hexadecimal: 16 };

export type ResultFormat = {
  /** Number format (`format.type`). */
  kind: NumberKind;
  /** Complex numbers as `a+bi` or as magnitude and angle in degrees. */
  complexForm: "cartesian" | "polar";
  /** Nested arrays are shown expanded; false shows `{r×c}`. */
  expandNested: boolean;
  /** Whether the worksheet or the region chose `expandNested`; without a choice, see `expandsNested`. */
  expandNestedSet?: boolean;
  /** Digits after the decimal point. */
  precision: number;
  /** The radix of the digits; another radix shows a whole number in its base. */
  radix: Radix;
  /** A power of ten at or beyond this magnitude is shown exponentially. */
  expThreshold: number;
  /** Numbers smaller than 10^-zeroThreshold show as 0. */
  zeroThreshold: number;
  /** The smaller part of a complex number is hidden below 10^-complexThreshold of the larger. */
  complexThreshold: number;
  /** Keep the digits after the point up to the precision. */
  trailingZeros: boolean;
  imaginary: "i" | "j";
  /** Arrays larger than this are clipped in a scrollable box. */
  matrixRows: number;
  matrixCols: number;
  /** Draw the row and column indices around a matrix result. */
  showIndices: boolean;
  /** Index of the first array element. */
  origin: number;
  /** The box a large matrix result is clipped in, in points; null is the default box of . */
  tableSize: [number, number] | null;
};

export const DEFAULT_FORMAT: ResultFormat = {
  kind: "general",
  complexForm: "cartesian",
  expandNested: false,
  precision: 3,
  radix: "decimal",
  expThreshold: 3,
  zeroThreshold: 15,
  complexThreshold: 10,
  trailingZeros: false,
  imaginary: "i",
  matrixRows: 12,
  matrixCols: 12,
  showIndices: false,
  origin: 0,
  tableSize: null,
};

/**
 * The worksheet settings the format dialog manages: the worksheet-wide default
 * and a region override use the same keys, and a key that is absent means the built-in default.
 */
export const FORMAT_SETTING_KEYS = [
  "format.type",
  "format.precision",
  "format.radix",
  "format.trailing-zeros",
  "format.exp-threshold",
  "format.zero-threshold",
  "format.complex-threshold",
  "format.complex-form",
  "format.expand-nested",
] as const;

/**
 * The edits that make `format` the worksheet default: a key that differs from the built-in
 * default is written, the others are removed (`null`), so applying the built-in default removes
 * every managed key and the file carries no `format.*` default at all.
 */
export function formatSettingEdits(format: ResultFormat): Record<string, string | null> {
  const keep = (changed: boolean, value: string): string | null => (changed ? value : null);
  return {
    "format.type": keep(format.kind !== DEFAULT_FORMAT.kind, format.kind),
    "format.precision": keep(format.precision !== DEFAULT_FORMAT.precision, String(format.precision)),
    "format.radix": keep(format.radix !== DEFAULT_FORMAT.radix, format.radix),
    "format.trailing-zeros": keep(
      format.trailingZeros !== DEFAULT_FORMAT.trailingZeros,
      String(format.trailingZeros),
    ),
    "format.exp-threshold": keep(format.expThreshold !== DEFAULT_FORMAT.expThreshold, String(format.expThreshold)),
    "format.zero-threshold": keep(format.zeroThreshold !== DEFAULT_FORMAT.zeroThreshold, String(format.zeroThreshold)),
    "format.complex-threshold": keep(
      format.complexThreshold !== DEFAULT_FORMAT.complexThreshold,
      String(format.complexThreshold),
    ),
    "format.complex-form": keep(format.complexForm !== DEFAULT_FORMAT.complexForm, format.complexForm),
    // Without a choice the automatic rule applies, so a choice is kept whatever its value.
    "format.expand-nested": format.expandNestedSet ? String(format.expandNested) : null,
  };
}

/** The edits that remove the worksheet default: every managed key goes. */
export function clearFormatSettings(): Record<string, string | null> {
  return Object.fromEntries(FORMAT_SETTING_KEYS.map((key) => [key, null]));
}

/**
 * Display settings from the `settings:` mapping of the worksheet. The keys are the ones
 * of this UI (`format.precision`, `format.radix`, `format.exp-threshold`, `format.zero-threshold`,
 * `format.complex-threshold`, `format.trailing-zeros`, `format.imaginary`,
 * `format.matrix-size` as `rows,cols`, `format.show-indices`); invalid values are ignored.
 */
export function formatFromSettings(settings?: Record<string, string>): ResultFormat {
  const format = { ...DEFAULT_FORMAT };
  if (!settings) return format;
  const int = (key: string, min: number, max: number): number | undefined => {
    const value = Number(settings[key]);
    return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  };
  format.precision = int("format.precision", 0, 15) ?? format.precision;
  format.expThreshold = int("format.exp-threshold", 1, 307) ?? format.expThreshold;
  format.zeroThreshold = int("format.zero-threshold", 1, 307) ?? format.zeroThreshold;
  format.complexThreshold = int("format.complex-threshold", 1, 307) ?? format.complexThreshold;
  format.trailingZeros = settings["format.trailing-zeros"] === "true";
  const radix = settings["format.radix"] as Radix | undefined;
  if (radix && RADIXES.includes(radix)) format.radix = radix;
  format.showIndices = settings["format.show-indices"] === "true";
  // The indices of a matrix result count from the worksheet's ORIGIN setting.
  format.origin = int("ORIGIN", -1000000, 1000000) ?? format.origin;
  const kind = settings["format.type"] as NumberKind | undefined;
  if (kind && NUMBER_KINDS.includes(kind)) format.kind = kind;
  if (settings["format.complex-form"] === "polar") format.complexForm = "polar";
  format.expandNested = settings["format.expand-nested"] === "true";
  if (settings["format.expand-nested"] === "true" || settings["format.expand-nested"] === "false") format.expandNestedSet = true;
  if (settings["format.imaginary"] === "j") format.imaginary = "j";
  const size = /^(\d+)\s*,\s*(\d+)$/.exec(settings["format.matrix-size"] ?? "");
  if (size) {
    format.matrixRows = Math.max(1, Number(size[1]));
    format.matrixCols = Math.max(1, Number(size[2]));
  }
  return format;
}

/**
 * The region display setting that holds the box of a matrix result
 * . It sits next to the `format.*` keys of the region's display override and has no
 * worksheet-wide level: a box belongs to the region's own result.
 */
export const RESULT_TABLE_SIZE_KEY = "result-table-size";

/**
 * A stored box, `"width,height"` in points. Anything that is not two positive finite
 * numbers is null, which the display reads as the default box: a hand-written file is read
 * tolerantly, exactly like an unknown `format.*` value.
 */
export function parseTableSize(text: string | undefined): [number, number] | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(text ?? "");
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return [width, height];
}

/** The value written for a box: `"width,height"` in points, no spaces, at most 3 decimals. */
export function tableSizeValue(size: [number, number]): string {
  const num = (value: number) => String(Math.round(value * 1000) / 1000);
  return `${num(size[0])},${num(size[1])}`;
}

/**
 * The display setting that shows the indices of a matrix result: `true` or
 * `false`, at the worksheet level or in a region's own display override.
 */
export const SHOW_INDICES_KEY = "format.show-indices";

/**
 * The worksheet setting that holds the size threshold of a matrix result: `"rows,cols"`, the
 * rows and columns a matrix may have before it is clipped in the box of . It
 * belongs to the worksheet and not to a region, and the size box of the Matrix tab edits it.
 */
export const MATRIX_SIZE_KEY = "format.matrix-size";

/**
 * A size threshold as the box of the Matrix tab accepts it: a whole number of at least 1, the
 * rule the reader of the setting applies. Anything else is null, and
 * the box then keeps the value in force instead of writing it.
 */
export function parseMatrixSizeField(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 1 ? value : null;
}

/**
 * The edits that write the size threshold of the box: the pair as the reader stores it,
 * `"rows,cols"`, or its removal when it is the built-in `12, 12`, the canonical form of .
 */
export function matrixSizeSettings(rows: number, cols: number): Record<string, string | null> {
  const isDefault = rows === DEFAULT_FORMAT.matrixRows && cols === DEFAULT_FORMAT.matrixCols;
  return { [MATRIX_SIZE_KEY]: isDefault ? null : `${rows},${cols}` };
}

/** Whether a matrix result is large by the size threshold: more rows or columns than the setting. */
export function isLargeMatrix(value: KernelValue | null | undefined, format: ResultFormat): boolean {
  return value?.type === "matrix" && (value.rows > format.matrixRows || value.cols > format.matrixCols);
}

/**
 * Whether a matrix result is drawn in the resizable box of : one the size threshold calls
 * large, one that arrives in window form, or one whose region already stores a box. A small
 * matrix with no stored box keeps its natural size.
 */
export function isBoxedMatrix(value: KernelValue | null | undefined, format: ResultFormat): boolean {
  return (
    value?.type === "matrix" &&
    (value.storage.type === "window" || isLargeMatrix(value, format) || format.tableSize !== null)
  );
}

/** A number as text: `mantissa`, and a power of ten when it is shown exponentially. */
export type NumberParts = { mantissa: string; exponent: number | null; suffix?: string };

function trim(text: string, keep: boolean): string {
  if (keep || !text.includes(".")) return text;
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * The digits of a whole number in another radix, upper case for hexadecimal. `null` for
 * decimal, and for a fraction or a value beyond 2^53, which keep the digits of their number
 * format: how the reference application shows those in another radix is unknown, so no digit is invented or lost.
 */
function radixDigits(x: number, radix: Radix): string | null {
  const base = RADIX_BASE[radix];
  // 2^53 is the largest whole number a double holds exactly, so every digit up to it is exact.
  if (base === 10 || !Number.isInteger(x) || Math.abs(x) > 2 ** 53) return null;
  return Math.abs(x).toString(base).toUpperCase();
}

export function nonFinite(value: WireFloat): string | null {
  switch (value) {
    case "nan":
      return "NaN";
    case "infinity":
      return "∞";
    case "-infinity":
      return "−∞";
    default:
      return Number.isFinite(value) ? null : String(value);
  }
}

/** Formats a finite or non-finite wire float in the format's number type. */
export function formatReal(value: WireFloat, format: ResultFormat): NumberParts {
  const special = nonFinite(value);
  if (special !== null) return { mantissa: special, exponent: null };
  const x = value as number;
  if (format.kind === "percent") {
    const parts = formatReal(x * 100, { ...format, kind: "decimal" });
    return { ...parts, suffix: "%" };
  }
  if (x === 0 || Math.abs(x) < 10 ** -format.zeroThreshold) {
    return { mantissa: "0", exponent: null };
  }
  const sign = x < 0 ? "−" : "";
  const abs = Math.abs(x);
  // another radix shows the digits of the number, with no exponent and no precision.
  const digits = radixDigits(abs, format.radix);
  if (digits !== null) return { mantissa: sign + digits, exponent: null };
  const [mantissa, exp] = abs.toExponential(format.precision).split("e");
  const exponent = Number(exp);
  const decimal = (): NumberParts => ({ mantissa: sign + trim(abs.toFixed(format.precision), format.trailingZeros), exponent: null });
  switch (format.kind) {
    case "decimal":
      return decimal();
    case "scientific":
      return { mantissa: sign + trim(mantissa, format.trailingZeros), exponent };
    case "engineering": {
      // exponent a multiple of 3, mantissa from 1 up to 1000 (rounding can carry into the next step)
      let e3 = Math.floor(exponent / 3) * 3;
      let scaled = abs / 10 ** e3;
      if (Number(scaled.toFixed(format.precision)) >= 1000) {
        e3 += 3;
        scaled = abs / 10 ** e3;
      }
      return { mantissa: sign + trim(scaled.toFixed(format.precision), format.trailingZeros), exponent: e3 };
    }
    default:
      break;
  }
  if (exponent >= format.expThreshold || exponent <= -format.expThreshold) {
    return { mantissa: sign + trim(mantissa, format.trailingZeros), exponent };
  }
  return decimal();
}

/** Plain text of number parts (`1.09·10^4`), for tests and tooltips. */
export function partsText(parts: NumberParts): string {
  return (parts.exponent === null ? parts.mantissa : `${parts.mantissa}·10^${parts.exponent}`) + (parts.suffix ?? "");
}

export type ComplexParts = {
  /** Polar form: magnitude and angle in degrees (`r∠θ°`); the Cartesian fields are then null. */
  polar?: { magnitude: NumberParts; angle: NumberParts };
  real: NumberParts | null;
  /** Sign between the parts: `+` or `−`; null when only one part is shown. */
  sign: "+" | "−" | null;
  imag: NumberParts | null;
};

/** Cartesian form with the smaller part hidden below the complex threshold. */
export function formatComplex(re: WireFloat, im: WireFloat, format: ResultFormat): ComplexParts {
  const r = typeof re === "number" ? re : NaN;
  const i = typeof im === "number" ? im : NaN;
  const finite = Number.isFinite(r) && Number.isFinite(i);
  if (format.complexForm === "polar" && finite) {
    const degrees = (Math.atan2(i, r) * 180) / Math.PI;
    // the magnitude uses the number type; the angle is a plain number of degrees
    return {
      polar: {
        magnitude: formatReal(Math.hypot(r, i), format),
        angle: formatReal(degrees, { ...format, kind: format.kind === "percent" ? "general" : format.kind }),
      },
      real: null,
      sign: null,
      imag: null,
    };
  }
  const limit = 10 ** -format.complexThreshold;
  if (finite && Math.abs(i) < Math.abs(r) * limit) {
    return { real: formatReal(re, format), sign: null, imag: null };
  }
  if (finite && Math.abs(r) < Math.abs(i) * limit) {
    return { real: null, sign: null, imag: formatReal(im, format) };
  }
  const negative = typeof im === "number" ? im < 0 || Object.is(im, -0) : im === "-infinity";
  const magnitude: WireFloat =
    typeof im === "number" ? Math.abs(im) : im === "-infinity" ? "infinity" : im;
  return {
    real: formatReal(re, format),
    sign: negative ? "−" : "+",
    imag: formatReal(magnitude, format),
  };
}

// ---- units ------------------------------------------------------------------------------

const BASES = ["length", "mass", "time", "current", "temperature", "amount", "luminosity"];
const BASE_SYMBOL: Record<string, string> = {
  length: "m",
  mass: "kg",
  time: "s",
  current: "A",
  temperature: "K",
  amount: "mol",
  luminosity: "cd",
};

// Derived SI units by dimension vector [L, M, T, I, Theta, N, J]. against
// the reference application: whether a result such as N·m is shown as J is part of .
const DERIVED: [string, number[]][] = [
  ["N", [1, 1, -2, 0, 0, 0, 0]],
  ["Pa", [-1, 1, -2, 0, 0, 0, 0]],
  ["J", [2, 1, -2, 0, 0, 0, 0]],
  ["W", [2, 1, -3, 0, 0, 0, 0]],
  ["C", [0, 0, 1, 1, 0, 0, 0]],
  ["V", [2, 1, -3, -1, 0, 0, 0]],
  ["F", [-2, -1, 4, 2, 0, 0, 0]],
  ["Ω", [2, 1, -3, -2, 0, 0, 0]],
  ["S", [-2, -1, 3, 2, 0, 0, 0]],
  ["Wb", [2, 1, -2, -1, 0, 0, 0]],
  ["T", [0, 1, -2, -1, 0, 0, 0]],
  ["H", [2, 1, -2, -2, 0, 0, 0]],
  ["Hz", [0, 0, -1, 0, 0, 0, 0]],
];

function vector(dimension: DimensionComponent[]): number[] {
  const v = BASES.map(() => 0);
  for (const {
    base,
    power: [n, d],
  } of dimension) {
    const index = BASES.indexOf(base);
    if (index >= 0) v[index] = n / d;
  }
  return v;
}

function power(symbol: string, p: number): string {
  if (p === 1) return symbol;
  const text = Number.isInteger(p) ? String(p) : String(Math.round(p * 1000) / 1000);
  return `${symbol}^${text}`;
}

/** The SI unit of a dimension as linear text: `N`, `kg·m^2/s^2` (empty when dimensionless). */
export function siUnitText(dimension: DimensionComponent[]): string {
  const v = vector(dimension);
  if (v.every((p) => p === 0)) return "";
  const derived = DERIVED.find(([, d]) => d.every((p, i) => p === v[i]));
  if (derived) return derived[0];
  const top: string[] = [];
  const bottom: string[] = [];
  v.forEach((p, i) => {
    const symbol = BASE_SYMBOL[BASES[i]];
    if (p > 0) top.push(power(symbol, p));
    else if (p < 0) bottom.push(power(symbol, -p));
  });
  const numerator = top.length ? top.join("·") : "1";
  if (bottom.length === 0) return numerator;
  const denominator = bottom.length > 1 ? `(${bottom.join("·")})` : bottom[0];
  return `${numerator}/${denominator}`;
}

/** Splits unit text into plain runs and exponents (`m^2` gives `m` and sup `2`). */
export function unitRuns(text: string): { text: string; sup: boolean }[] {
  const runs: { text: string; sup: boolean }[] = [];
  const pattern = /\^(-?[0-9]+(?:\.[0-9]+)?)/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index), sup: false });
    runs.push({ text: match[1].replace("-", "−"), sup: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), sup: false });
  return runs;
}

/** The unit text shown after a result and the divisor applied to the SI value. */
export function resultUnit(
  dimension: DimensionComponent[],
  displayUnit?: DisplayUnit,
): { text: string; divisor: number; offset: number } {
  if (displayUnit) return { text: displayUnit.text, divisor: displayUnit.divisor, offset: displayUnit.offset ?? 0 };
  return { text: siUnitText(dimension), divisor: 1, offset: 0 };
}

/** The key of the choice to expand nested arrays, in the worksheet default and a region override. */
export const EXPAND_NESTED_KEY = "format.expand-nested";

/**
 * Whether a matrix result draws its matrix elements expanded. The worksheet's or the region's choice
 * wins; without one, a result made only of matrices (the several results of `svd`, `eigenvecs` and
 * the like) is expanded, and a matrix that mixes matrices with other elements shows them as `{r×c}`.
 */
export function expandsNested(format: ResultFormat, value: KernelValue): boolean {
  if (format.expandNestedSet) return format.expandNested;
  if (value.type !== "matrix") return false;
  const elements = value.storage.values;
  return elements.length > 0 && elements.every((element) => element.type === "matrix");
}

/** Whether a matrix result has a matrix among its elements. */
export function hasNestedMatrix(value: KernelValue): boolean {
  return value.type === "matrix" && value.storage.values.some((element) => element.type === "matrix");
}
