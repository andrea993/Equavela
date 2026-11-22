// The canonical form and the validity rules of the worksheet calculation settings.

import { describe, expect, it } from "vitest";
import {
  calculationSettingEdits,
  calculationSettingsOf,
  clearCalculationSettings,
  DEFAULT_CALCULATION_SETTINGS,
  parseSetting,
} from "./settings";

describe("the calculation settings", () => {
  it("keeps TOL positive and CTOL non-negative", () => {
    expect(parseSetting("TOL", "0.25")).toBe(0.25);
    expect(parseSetting("TOL", "1e-9")).toBe(1e-9);
    expect(parseSetting("TOL", " 2 ")).toBe(2);
    // no clamping and no guessing, the field is simply not acceptable
    for (const text of ["", "  ", "0", "-1", "abc", "Infinity", "NaN"]) {
      expect(parseSetting("TOL", text), text).toBeNull();
    }
    // CTOL may be zero: "as exact as the algorithm can be"
    expect(parseSetting("CTOL", "0")).toBe(0);
    for (const text of ["", "-1", "abc", "Infinity"]) {
      expect(parseSetting("CTOL", text), text).toBeNull();
    }
  });

  it("keeps ORIGIN an integer, negative allowed", () => {
    expect(parseSetting("ORIGIN", "1")).toBe(1);
    expect(parseSetting("ORIGIN", " -2 ")).toBe(-2);
    expect(parseSetting("ORIGIN", "0")).toBe(0);
    for (const text of ["", "1.5", "abc", "Infinity"]) {
      expect(parseSetting("ORIGIN", text), text).toBeNull();
    }
  });

  it("reads the worksheet values and falls back to the built-in default", () => {
    expect(calculationSettingsOf(undefined)).toEqual({ ORIGIN: "0", TOL: "0.001", CTOL: "0.001" });
    expect(calculationSettingsOf({ ORIGIN: "1", TOL: "0.25", CTOL: "0.5" })).toEqual({ ORIGIN: "1", TOL: "0.25", CTOL: "0.5" });
    expect(calculationSettingsOf({ TOL: "0.25" })).toEqual({ ORIGIN: "0", TOL: "0.25", CTOL: "0.001" });
    // A hand-written file may hold something the setting cannot take: the default applies
    //, and the dialog shows it rather than the unusable value.
    expect(calculationSettingsOf({ ORIGIN: "0.5", TOL: "-3", CTOL: "abc" })).toEqual({ ORIGIN: "0", TOL: "0.001", CTOL: "0.001" });
  });

  it("writes only the values that differ from the built-in default", () => {
    expect(calculationSettingEdits({ ...DEFAULT_CALCULATION_SETTINGS })).toEqual({ ORIGIN: null, TOL: null, CTOL: null });
    expect(calculationSettingEdits({ ORIGIN: 1, TOL: 0.25, CTOL: 0.001 })).toEqual({ ORIGIN: "1", TOL: "0.25", CTOL: null });
    expect(calculationSettingEdits({ ORIGIN: 0, TOL: 0.25, CTOL: 0 })).toEqual({ ORIGIN: null, TOL: "0.25", CTOL: "0" });
    expect(clearCalculationSettings()).toEqual({ ORIGIN: null, TOL: null, CTOL: null });
  });
});
