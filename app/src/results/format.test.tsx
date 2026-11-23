import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { KernelValue } from "../equavelaApi";
import {
  clearFormatSettings,
  DEFAULT_FORMAT,
  expandsNested,
  formatComplex,
  formatFromSettings,
  formatReal,
  formatSettingEdits,
  isBoxedMatrix,
  isLargeMatrix,
  MATRIX_SIZE_KEY,
  matrixSizeSettings,
  parseMatrixSizeField,
  parseTableSize,
  partsText,
  resultUnit,
  SHOW_INDICES_KEY,
  siUnitText,
  tableSizeValue,
  unitRuns,
} from "./format";
import { ValueView } from "./ResultView";

afterEach(cleanup);

const f = DEFAULT_FORMAT;
const real = (x: number) => partsText(formatReal(x, f));

describe("General format", () => {
  it("shows 3 decimals and hides trailing zeros", () => {
    expect(real(3.14159)).toBe("3.142");
    expect(real(5)).toBe("5");
    expect(real(2.5)).toBe("2.5");
    expect(real(-0.125)).toBe("−0.125");
    expect(real(0.0123)).toBe("0.012");
  });

  it("switches to exponential at a power of ten of 3 or more, or -3 or less", () => {
    expect(real(999)).toBe("999");
    expect(real(1000)).toBe("1·10^3");
    expect(real(10895.18815)).toBe("1.09·10^4");
    expect(real(0.001)).toBe("1·10^-3");
    expect(real(0.01)).toBe("0.01");
    expect(real(1051.9722)).toBe("1.052·10^3");
    expect(real(-12345)).toBe("−1.235·10^4");
    // Rounding up to the next power of ten counts for the threshold.
    expect(real(999.9996)).toBe("1·10^3");
  });

  it("shows numbers below the zero threshold as 0", () => {
    expect(real(1e-16)).toBe("0");
    expect(real(0)).toBe("0");
    expect(real(1e-14)).toBe("1·10^-14");
  });

  it("formats the non-finite values", () => {
    expect(real(Number.NaN)).toBe("NaN");
    expect(partsText(formatReal("nan", f))).toBe("NaN");
    expect(partsText(formatReal("infinity", f))).toBe("∞");
    expect(partsText(formatReal("-infinity", f))).toBe("−∞");
  });

  it("follows the worksheet settings", () => {
    const format = formatFromSettings({
      "format.precision": "5",
      "format.exp-threshold": "6",
      "format.trailing-zeros": "true",
      "format.matrix-size": "4, 5",
      "format.imaginary": "j",
      ORIGIN: "1",
      "format.zero-threshold": "oops",
    });
    expect(format.precision).toBe(5);
    expect(partsText(formatReal(2, format))).toBe("2.00000");
    expect(partsText(formatReal(1234567.89, format))).toBe("1.23457·10^6");
    expect(partsText(formatReal(12345.6, format))).toBe("12345.60000");
    expect([format.matrixRows, format.matrixCols]).toEqual([4, 5]);
    expect(format.imaginary).toBe("j");
    expect(format.origin).toBe(1);
    // ORIGIN may be negative; the key of the old importer is not read any more.
    expect(formatFromSettings({ ORIGIN: "-2" }).origin).toBe(-2);
    expect(formatFromSettings({ "array-origin": "1" }).origin).toBe(0);
    expect(format.zeroThreshold).toBe(15);
    expect(formatFromSettings(undefined)).toEqual(DEFAULT_FORMAT);
  });

  // the built-in default, then the worksheet default, then the region override, key by key.
  it("lays the worksheet default under a region override key by key", () => {
    const settings = { "format.type": "decimal", "format.precision": "5" };
    expect(formatFromSettings(settings).kind).toBe("decimal");
    const own = { "format.precision": "1" };
    const merged = formatFromSettings({ ...settings, ...own });
    expect(merged.kind).toBe("decimal");
    expect(partsText(formatReal(12345.678, merged))).toBe("12345.7");
  });

  // only the keys that differ from the built-in default are written; the rest are removed.
  it("keeps only the worksheet settings that differ from the built-in default", () => {
    expect(formatSettingEdits(DEFAULT_FORMAT)).toEqual({
      "format.type": null,
      "format.precision": null,
      "format.radix": null,
      "format.trailing-zeros": null,
      "format.exp-threshold": null,
      "format.zero-threshold": null,
      "format.complex-threshold": null,
      "format.complex-form": null,
      "format.expand-nested": null,
    });
    expect(
      formatSettingEdits({
        ...DEFAULT_FORMAT,
        kind: "engineering",
        precision: 1,
        radix: "octal",
        trailingZeros: true,
        expThreshold: 6,
        zeroThreshold: 9,
        complexThreshold: 4,
        complexForm: "polar",
        expandNested: true,
        expandNestedSet: true,
      }),
    ).toEqual({
      "format.type": "engineering",
      "format.precision": "1",
      "format.radix": "octal",
      "format.trailing-zeros": "true",
      "format.exp-threshold": "6",
      "format.zero-threshold": "9",
      "format.complex-threshold": "4",
      "format.complex-form": "polar",
      "format.expand-nested": "true",
    });
    // A choice to collapse is kept too: without one, the automatic rule applies.
    expect(formatSettingEdits({ ...DEFAULT_FORMAT, expandNestedSet: true })["format.expand-nested"]).toBe("false");
    // Reset removes every key the dialog offers.
    expect(clearFormatSettings()).toEqual(formatSettingEdits(DEFAULT_FORMAT));
    // The edits read back as the format they came from (one round trip, no loss).
    const format = {
      ...DEFAULT_FORMAT,
      kind: "percent" as const,
      precision: 0,
      radix: "binary" as const,
      trailingZeros: true,
      expThreshold: 5,
      zeroThreshold: 12,
      complexThreshold: 8,
    };
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(formatSettingEdits(format))) if (value !== null) kept[key] = value;
    expect(formatFromSettings(kept)).toEqual(format);
  });
});

describe("complex numbers", () => {
  it("shows both parts", () => {
    const parts = formatComplex(3, -4, f);
    expect(partsText(parts.real!)).toBe("3");
    expect(parts.sign).toBe("−");
    expect(partsText(parts.imag!)).toBe("4");
  });

  it("hides the part that is negligible next to the other", () => {
    const real = formatComplex(1, 1e-12, f);
    expect(real.imag).toBeNull();
    const imag = formatComplex(1e-12, 2, f);
    expect(imag.real).toBeNull();
    expect(partsText(imag.imag!)).toBe("2");
  });
});

describe("units", () => {
  it("names derived SI units and falls back to base units", () => {
    expect(siUnitText([])).toBe("");
    expect(
      siUnitText([
        { base: "length", power: [1, 1] },
        { base: "mass", power: [1, 1] },
        { base: "time", power: [-2, 1] },
      ]),
    ).toBe("N");
    expect(
      siUnitText([
        { base: "length", power: [1, 1] },
        { base: "time", power: [-1, 1] },
      ]),
    ).toBe("m/s");
    expect(siUnitText([{ base: "length", power: [2, 1] }])).toBe("m^2");
    expect(
      siUnitText([
        { base: "mass", power: [1, 1] },
        { base: "length", power: [-1, 1] },
        { base: "time", power: [-1, 1] },
      ]),
    ).toBe("kg/(m·s)");
  });

  it("prefers the display unit and splits exponents for rendering", () => {
    expect(resultUnit([], { text: "kN·m", divisor: 1000 })).toEqual({ text: "kN·m", divisor: 1000, offset: 0 });
    expect(unitRuns("kg·m^2/s^-2")).toEqual([
      { text: "kg·m", sup: false },
      { text: "2", sup: true },
      { text: "/s", sup: false },
      { text: "−2", sup: true },
    ]);
  });
});

describe("value display", () => {
  const quantity: KernelValue = {
    type: "quantity",
    magnitude: { type: "real", value: 18375 },
    dimension: [
      { base: "length", power: [2, 1] },
      { base: "mass", power: [1, 1] },
      { base: "time", power: [-2, 1] },
    ],
  };

  it("divides the SI value by the display unit divisor", () => {
    const { container } = render(
      <ValueView value={quantity} displayUnit={{ text: "kN·m", divisor: 1000 }} format={f} />,
    );
    expect(container.textContent).toBe("18.375kN·m");
  });

  it("takes the offset of °C and °F off before dividing", () => {
    const kelvin: KernelValue = {
      type: "quantity",
      magnitude: { type: "real", value: 293.15 },
      dimension: [{ base: "temperature", power: [1, 1] }],
    };
    const celsius = render(<ValueView value={kelvin} displayUnit={{ text: "°C", divisor: 1, offset: 273.15 }} format={f} />);
    expect(celsius.container.textContent).toBe("20°C");
    const fahrenheit = render(
      <ValueView value={kelvin} displayUnit={{ text: "°F", divisor: 5 / 9, offset: (459.67 * 5) / 9 }} format={f} />,
    );
    expect(fahrenheit.container.textContent).toBe("68°F");
  });

  it("shows SI units without an override", () => {
    const { container } = render(<ValueView value={quantity} format={f} />);
    expect(container.textContent).toContain("1.838");
    expect(container.textContent).toContain("J");
  });

  it("shows matrices in brackets, a large one as a table only when the region chooses it", () => {
    const cells = (n: number): KernelValue[] =>
      Array.from({ length: n }, (_, i) => ({ type: "real", value: i }));
    const small = render(
      <ValueView
        value={{ type: "matrix", rows: 2, cols: 2, storage: { type: "inline", values: cells(4) } }}
        format={f}
      />,
    ).container;
    expect(small.querySelectorAll(".matrix-grid .cell")).toHaveLength(4);
    // Column-major: [0 2; 1 3].
    expect([...small.querySelectorAll(".cell")].map((c) => c.textContent)).toEqual(["0", "2", "1", "3"]);
    cleanup();
    // A large matrix is a classic matrix by default, clipped in its box.
    const classic = render(
      <ValueView
        value={{ type: "matrix", rows: 15, cols: 15, storage: { type: "inline", values: cells(225) } }}
        format={f}
      />,
    ).container;
    expect(classic.querySelector(".result-matrix-scroll .matrix-grid")).not.toBeNull();
    expect(classic.querySelector(".indexed-matrix")).toBeNull();
  });

  it("a table box is two positive numbers in points and nothing else", () => {
    expect(parseTableSize("480,180")).toEqual([480, 180]);
    expect(parseTableSize(" 480 , 180 ")).toEqual([480, 180]);
    expect(parseTableSize("480.5,180.25")).toEqual([480.5, 180.25]);
    for (const bad of ["", "480", "480,", ",180", "0,180", "480,0", "wide,180", "-480,180", "480,180,9"]) {
      expect(parseTableSize(bad), bad).toBeNull();
    }
    expect(parseTableSize(undefined)).toBeNull();
    expect(tableSizeValue([480, 180])).toBe("480,180");
    expect(tableSizeValue([480.5, 180.25])).toBe("480.5,180.25");
  });

  it("draws every matrix as a classic matrix; the indices are the region's choice", () => {
    expect(SHOW_INDICES_KEY).toBe("format.show-indices");
    expect(formatFromSettings({}).showIndices).toBe(false);
    expect(formatFromSettings({ [SHOW_INDICES_KEY]: "true" }).showIndices).toBe(true);
    // The region override wins over the worksheet setting, in both directions.
    const worksheet = { [SHOW_INDICES_KEY]: "true" };
    const region = { [SHOW_INDICES_KEY]: "false" };
    expect(formatFromSettings({ ...worksheet, ...region }).showIndices).toBe(false);
    const cells = (n: number): KernelValue[] => Array.from({ length: n }, (_, i) => ({ type: "real", value: i }));
    const small = { type: "matrix", rows: 2, cols: 3, storage: { type: "inline", values: cells(6) } } as KernelValue;
    const shown = render(<ValueView value={small} format={{ ...f, showIndices: true }} />).container;
    // The matrix itself is the same; the indices stand around it, outside its brackets.
    const indexed = shown.querySelector(".indexed-matrix")!;
    expect(indexed.querySelector(".indexed-body .matrix-grid")).not.toBeNull();
    expect(indexed.querySelector(".matrix-indices.cols")).not.toBeNull();
    expect(indexed.querySelector(".matrix-indices.rows")).not.toBeNull();
    expect(shown.querySelector(".result-table")).toBeNull();
  });

  it("calls a matrix large and boxed", () => {
    const value = (rows: number, cols: number) =>
      ({ type: "matrix", rows, cols, storage: { type: "inline", values: [] } }) as unknown as KernelValue;
    const large = value(15, 15);
    const small = value(3, 3);
    expect(isLargeMatrix(large, f)).toBe(true);
    expect(isLargeMatrix(small, f)).toBe(false);
    expect(isLargeMatrix({ type: "real", value: 1 }, f)).toBe(false);
    // A large matrix is resizable.
    expect(isBoxedMatrix(large, f)).toBe(true);
    // A matrix in window form is boxed whatever the threshold.
    const windowed = { type: "matrix", rows: 300, cols: 80, storage: { type: "window", row: 0, col: 0, rows: 0, cols: 0, values: [] } } as KernelValue;
    expect(isBoxedMatrix(windowed, { ...f, matrixRows: 1000, matrixCols: 1000 })).toBe(true);
    // A stored box keeps the box and the handle when the matrix became small.
    expect(isBoxedMatrix(small, { ...f, tableSize: [480, 180] })).toBe(true);
    // Only a small classic matrix with no stored box keeps its natural size.
    expect(isBoxedMatrix(small, f)).toBe(false);
    expect(isBoxedMatrix(null, f)).toBe(false);
  });

  it("draws a classic matrix in a clipped, resizable box", () => {
    const cells = (n: number): KernelValue[] =>
      Array.from({ length: n }, (_, i) => ({ type: "real", value: i }));
    const large = { type: "matrix", rows: 15, cols: 15, storage: { type: "inline", values: cells(225) } } as KernelValue;
    const drawn = render(
      <ValueView value={large} format={f} onTableResizeStart={() => undefined} />,
    ).container;
    expect(drawn.querySelector(".matrix-grid")).not.toBeNull();
    const box = drawn.querySelector<HTMLElement>(".result-matrix-scroll")!;
    expect(box).not.toBeNull();
    expect([box.style.width, box.style.height]).toEqual(["", ""]);
    expect(box.classList.contains("sized")).toBe(false);
    // The same corner handle as the table: the box is one box per region.
    expect(drawn.querySelector("[data-testid=table-resize-handle]")).not.toBeNull();
    cleanup();
    // A stored box gives the classic matrix the same size as the table in points (480 x 180 pt).
    const sized = render(
      <ValueView
        value={large}
        format={{ ...f, tableSize: [480, 180] }}
        onTableResizeStart={() => undefined}
      />,
    ).container;
    const fitted = sized.querySelector<HTMLElement>(".result-matrix-scroll")!;
    expect([fitted.style.width, fitted.style.height]).toEqual(["640px", "240px"]);
    expect(fitted.classList.contains("sized")).toBe(true);
    cleanup();
    // A matrix that is not large keeps its natural size, with no box and no handle.
    const small = { type: "matrix", rows: 3, cols: 3, storage: { type: "inline", values: cells(9) } } as KernelValue;
    const plain = render(<ValueView value={small} format={f} onTableResizeStart={() => undefined} />).container;
    expect(plain.querySelector(".result-matrix-box")).toBeNull();
    expect(plain.querySelector(".matrix-grid")).not.toBeNull();
    expect(plain.querySelector("[data-testid=table-resize-handle]")).toBeNull();
    cleanup();
    // An inline result of a text region has no region of its own, so it gets the box of and
    // never a handle: the workbench passes no resize gesture there.
    const inline = render(<ValueView value={large} format={f} />).container;
    expect(inline.querySelector(".result-matrix-box")).not.toBeNull();
    expect(inline.querySelector("[data-testid=table-resize-handle]")).toBeNull();
  });

  it("shows complex, string, handle and symbolic values", () => {
    expect(
      render(<ValueView value={{ type: "complex", real: 3, imag: 4 }} format={f} />).container.textContent,
    ).toBe("3+4i");
    cleanup();
    expect(
      render(<ValueView value={{ type: "string", value: "hi" }} format={f} />).container.textContent,
    ).toBe("“hi”");
    cleanup();
    expect(
      render(
        <ValueView value={{ type: "handle", id: "1", julia_type: "T", summary: "s" }} format={f} />,
      ).container.textContent,
    ).toBe("T: s");
    cleanup();
    const expr = { type: "Num", text: "42" };
    expect(
      render(<ValueView value={{ type: "symbolic", expr, text: "42" }} format={f} />).container.textContent,
    ).toBe("42");
  });
});

describe("result format types, polar complex form and nested arrays", () => {
  const kind = (k: string, extra: Record<string, string> = {}) =>
    formatFromSettings({ "format.type": k, ...extra });
  const text = (x: number, k: string, extra: Record<string, string> = {}) => partsText(formatReal(x, kind(k, extra)));

  it("decimal never uses an exponent", () => {
    expect(text(1234567.891, "decimal")).toBe("1234567.891");
    expect(text(0.00012, "decimal")).toBe("0");
    expect(text(0.00012, "decimal", { "format.precision": "5" })).toBe("0.00012");
    expect(text(-2.5, "decimal")).toBe("−2.5");
  });

  it("scientific always does", () => {
    expect(text(12.5, "scientific")).toBe("1.25·10^1");
    expect(text(0.000123456, "scientific")).toBe("1.235·10^-4");
    expect(text(1, "scientific")).toBe("1·10^0");
    expect(text(-3000, "scientific")).toBe("−3·10^3");
    expect(text(0, "scientific")).toBe("0");
  });

  it("engineering uses exponents that are multiples of 3", () => {
    expect(text(12345, "engineering")).toBe("12.345·10^3");
    expect(text(0.00012345, "engineering")).toBe("123.45·10^-6");
    expect(text(5, "engineering")).toBe("5·10^0");
    expect(text(999999.9, "engineering")).toBe("1·10^6");
    expect(text(-1500000, "engineering")).toBe("−1.5·10^6");
  });

  it("percent multiplies by 100 and appends %", () => {
    expect(text(0.153, "percent")).toBe("15.3%");
    expect(text(1, "percent")).toBe("100%");
    expect(text(0.00001, "percent", { "format.precision": "4" })).toBe("0.001%");
    expect(text(-0.5, "percent")).toBe("−50%");
  });

  it("reads the new settings and ignores invalid ones", () => {
    const format = formatFromSettings({ "format.type": "engineering", "format.complex-form": "polar", "format.expand-nested": "true" });
    expect([format.kind, format.complexForm, format.expandNested]).toEqual(["engineering", "polar", true]);
    const bad = formatFromSettings({ "format.type": "hex", "format.complex-form": "x" });
    expect([bad.kind, bad.complexForm, bad.expandNested]).toEqual(["general", "cartesian", false]);
  });

  it("shows complex numbers as magnitude and angle in degrees", () => {
    const polar = formatFromSettings({ "format.complex-form": "polar" });
    const parts = formatComplex(3, 4, polar);
    expect(partsText(parts.polar!.magnitude)).toBe("5");
    expect(partsText(parts.polar!.angle)).toBe("53.13");
    expect(partsText(formatComplex(-1, 0, polar).polar!.angle)).toBe("180");
    expect(partsText(formatComplex(0, -2, polar).polar!.angle)).toBe("−90");
    const { container } = render(<ValueView value={{ type: "complex", real: 3, imag: 4 }} format={polar} />);
    expect(container.textContent).toBe("5∠53.13°");
  });

  it("collapses nested arrays to {r×c} unless expansion is on", () => {
    const inner: KernelValue = {
      type: "matrix",
      rows: 2,
      cols: 3,
      storage: { type: "inline", values: Array.from({ length: 6 }, (_, i) => ({ type: "real" as const, value: i })) },
    };
    const outer: KernelValue = { type: "matrix", rows: 1, cols: 2, storage: { type: "inline", values: [inner, { type: "real", value: 7 }] } };
    expect(render(<ValueView value={outer} format={f} />).container.textContent).toBe("{2×3}7");
    cleanup();
    const expanded = formatFromSettings({ "format.expand-nested": "true" });
    const { container } = render(<ValueView value={outer} format={expanded} />);
    expect(container.querySelectorAll(".matrix").length).toBe(2);
  });
});

describe("radix and trailing zeros", () => {
  const withRadix = (radix: string, extra: Record<string, string> = {}) =>
    formatFromSettings({ "format.radix": radix, ...extra });
  const digits = (x: number, radix: string, extra: Record<string, string> = {}) =>
    partsText(formatReal(x, withRadix(radix, extra)));

  it("keeps the digits after the point up to the precision when trailing zeros are on", () => {
    const kept = { "format.trailing-zeros": "true", "format.precision": "4" };
    expect(partsText(formatReal(0.5, withRadix("decimal", kept)))).toBe("0.5000");
    expect(partsText(formatReal(5, withRadix("decimal", kept)))).toBe("5.0000");
    // the mantissa of Scientific and Engineering too
    const scientific = { "format.type": "scientific", "format.trailing-zeros": "true", "format.precision": "2" };
    expect(partsText(formatReal(2, withRadix("decimal", scientific)))).toBe("2.00·10^0");
    // hidden by default
    expect(partsText(formatReal(0.5, DEFAULT_FORMAT))).toBe("0.5");
  });

  it("writes the digits of a whole number in binary, octal and hexadecimal", () => {
    expect(digits(10, "binary")).toBe("1010");
    expect(digits(64, "octal")).toBe("100");
    expect(digits(255, "hexadecimal")).toBe("FF");
    expect(digits(-10, "binary")).toBe("−1010");
    expect(digits(0, "binary")).toBe("0");
    // A power of ten has no meaning in another radix: the number format leaves the digits alone.
    for (const kind of ["general", "decimal", "scientific", "engineering"]) {
      expect(digits(10, "binary", { "format.type": kind })).toBe("1010");
    }
  });

  it("leaves a fraction and a value beyond 2^53 in decimal", () => {
    expect(digits(2.5, "binary")).toBe("2.5");
    expect(digits(1e-3, "octal")).toBe("1·10^-3");
    expect(digits(2 ** 60, "hexadecimal")).toBe("1.153·10^18");
    // 2^53 is the last whole number a double holds exactly, so it is still converted.
    expect(digits(2 ** 53, "hexadecimal")).toBe("20000000000000");
    expect(digits(2 ** 53 + 2, "binary", { "format.type": "decimal" })).toBe("9007199254740994");
  });

  it("keeps the zero threshold and Percent working as in decimal", () => {
    expect(digits(1e-16, "binary")).toBe("0");
    expect(digits(0.5, "binary", { "format.type": "percent" })).toBe("110010%");
  });

  it("reads the radix and the thresholds from the settings and ignores what it cannot use", () => {
    const format = formatFromSettings({
      "format.radix": "hexadecimal",
      "format.trailing-zeros": "true",
      "format.exp-threshold": "2",
      "format.zero-threshold": "5",
      "format.complex-threshold": "4",
    });
    expect([
      format.radix,
      format.trailingZeros,
      format.expThreshold,
      format.zeroThreshold,
      format.complexThreshold,
    ]).toEqual(["hexadecimal", true, 2, 5, 4]);
    // an unknown radix and an out-of-range threshold fall back to the built-in default
    expect(formatFromSettings({ "format.radix": "base 3" }).radix).toBe("decimal");
    expect(formatFromSettings({ "format.exp-threshold": "0" }).expThreshold).toBe(3);
    expect(formatFromSettings({ "format.zero-threshold": "308" }).zeroThreshold).toBe(15);
  });

  it("draws a result in the chosen radix", () => {
    const { container } = render(<ValueView value={{ type: "real", value: 255 }} format={withRadix("hexadecimal")} />);
    expect(container.textContent).toBe("FF");
  });
});

describe("the size threshold of the Matrix tab", () => {
  it("writes the pair as the worksheet setting, and removes it at the built-in 12, 12", () => {
    expect(MATRIX_SIZE_KEY).toBe("format.matrix-size");
    expect(matrixSizeSettings(20, 8)).toEqual({ "format.matrix-size": "20,8" });
    // The canonical form of : the built-in pair is not stored.
    expect(matrixSizeSettings(12, 12)).toEqual({ "format.matrix-size": null });
    // One threshold moved, the other left at the default, is a value that has to be stored.
    expect(matrixSizeSettings(12, 13)).toEqual({ "format.matrix-size": "12,13" });
    // What it writes is what the reader reads back.
    expect(formatFromSettings(matrixSizeSettings(20, 8) as Record<string, string>)).toMatchObject({
      matrixRows: 20,
      matrixCols: 8,
    });
    // The threshold is not one of the format dialog's keys, so its Reset leaves it alone.
    expect(clearFormatSettings()["format.matrix-size"]).toBeUndefined();
  });

  it("reads a typed field with the rule the display reader applies", () => {
    expect(parseMatrixSizeField("20")).toBe(20);
    expect(parseMatrixSizeField(" 8 ")).toBe(8);
    expect(parseMatrixSizeField("000007")).toBe(7);
    for (const bad of ["", " ", "0", "-3", "2.5", "twelve", "12,12", "1e3"]) {
      expect(parseMatrixSizeField(bad), bad).toBeNull();
    }
  });
});

describe("nested arrays", () => {
  const real = (value: number): KernelValue => ({ type: "real", value });
  const matrix = (values: KernelValue[]): KernelValue => ({ type: "matrix", rows: values.length, cols: 1, storage: { type: "inline", values } });
  const several = matrix([matrix([real(1)]), matrix([real(2), real(3)])]);
  const mixed = matrix([real(1), matrix([real(2)])]);

  it("expand a result made only of matrices, and collapse a mixed one, without a choice", () => {
    const format = formatFromSettings({});
    expect(expandsNested(format, several)).toBe(true);
    expect(expandsNested(format, mixed)).toBe(false);
  });

  it("follow the worksheet's or the region's choice", () => {
    expect(expandsNested(formatFromSettings({ "format.expand-nested": "false" }), several)).toBe(false);
    expect(expandsNested(formatFromSettings({ "format.expand-nested": "true" }), mixed)).toBe(true);
  });
});
