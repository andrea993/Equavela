// The label styles of a worksheet:
// the six labels, their built-in values, the canonical keys, the tolerant
// read of a hand-written file and the declarations of the drawing.

import { describe, expect, it } from "vitest";
import {
  clearLabelStyle,
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_STYLES,
  isLabelStyleKey,
  LABEL_KINDS,
  labelStyleCss,
  labelStyleEdits,
  labelStyleKey,
  labelStylesOf,
  nameStyle,
  UNIT_COLOR,
} from "./labels";

describe("the label styles of a worksheet", () => {
  it("has one style per label of the math model, in the order of the dialog", () => {
    expect(LABEL_KINDS).toEqual(["var", "const", "fn", "unit", "sys", "kw"]);
  });

  it("draws a worksheet that stores nothing with the built-in styles: variable italic, unit bold italic blue, keyword bold", () => {
    const styles = labelStylesOf(undefined);
    expect(styles.var).toEqual({ bold: false, italic: true, underline: false, color: DEFAULT_LABEL_COLOR });
    expect(styles.fn.italic).toBe(false);
    expect(styles.unit).toEqual({ bold: true, italic: true, underline: false, color: UNIT_COLOR });
    expect(styles.kw.bold).toBe(true);
    expect(labelStylesOf({})).toEqual(DEFAULT_LABEL_STYLES);
  });
});

describe("the keys of a label style", () => {
  it("names every property of every label", () => {
    expect(labelStyleKey("var", "italic")).toBe("label-style.var.italic");
    expect(labelStyleKey("kw", "color")).toBe("label-style.kw.color");
    for (const kind of LABEL_KINDS) {
      for (const property of ["bold", "italic", "underline", "color"] as const) {
        expect(isLabelStyleKey(labelStyleKey(kind, property))).toBe(true);
      }
    }
  });

  it("refuses a key that is not a label style of the model", () => {
    for (const key of [
      "format.type",
      "label-style",
      "label-style.var",
      "label-style.var.strikeout",
      "label-style.keyword.bold",
      "label-style.var.bold.extra",
      "",
    ]) {
      expect(isLabelStyleKey(key)).toBe(false);
    }
  });
});

describe("reading the styles of a worksheet", () => {
  it("takes the stored value of every property", () => {
    const styles = labelStylesOf({
      "label-style.var.color": "#C00000",
      "label-style.var.italic": "false",
      "label-style.var.underline": "true",
      "label-style.unit.bold": "false",
    });
    expect(styles.var).toEqual({ bold: false, italic: false, underline: true, color: "#c00000" });
    expect(styles.unit.bold).toBe(false);
    // A property nobody stored keeps the built-in value.
    expect(styles.unit.color).toBe(UNIT_COLOR);
  });

  it("ignores a value the drawing cannot use instead of failing the load", () => {
    const styles = labelStylesOf({
      "label-style.const.italic": "maybe",
      "label-style.const.color": "not-a-colour",
      "label-style.sys.bold": "TRUE",
      "label-style.sys.underline": "",
    });
    expect(styles.const).toEqual(DEFAULT_LABEL_STYLES.const);
    expect(styles.sys).toEqual(DEFAULT_LABEL_STYLES.sys);
  });
});

describe("writing the styles of a worksheet", () => {
  it("writes only what differs from the built-in style", () => {
    const styles = labelStylesOf({ "label-style.var.color": "#c00000" });
    styles.var.italic = false;
    styles.unit.bold = false;
    expect(labelStyleEdits(styles)).toEqual({
      "label-style.var.bold": null,
      "label-style.var.italic": "false",
      "label-style.var.underline": null,
      "label-style.var.color": "#c00000",
      "label-style.const.bold": null,
      "label-style.const.italic": null,
      "label-style.const.underline": null,
      "label-style.const.color": null,
      "label-style.fn.bold": null,
      "label-style.fn.italic": null,
      "label-style.fn.underline": null,
      "label-style.fn.color": null,
      "label-style.unit.bold": "false",
      "label-style.unit.italic": null,
      "label-style.unit.underline": null,
      // The unit colour is the built-in one: it stays out of the file, not written as `#1d3a99`.
      "label-style.unit.color": null,
      "label-style.sys.bold": null,
      "label-style.sys.italic": null,
      "label-style.sys.underline": null,
      "label-style.sys.color": null,
      "label-style.kw.bold": null,
      "label-style.kw.italic": null,
      "label-style.kw.underline": null,
      "label-style.kw.color": null,
    });
  });

  it("writes a style equal to the built-in one as no key at all, and reads it back unchanged", () => {
    const edits = labelStyleEdits(labelStylesOf(undefined));
    expect(Object.values(edits).every((value) => value === null)).toBe(true);
    const stored = Object.fromEntries(
      Object.entries(edits).filter((entry): entry is [string, string] => entry[1] !== null),
    );
    expect(stored).toEqual({});
    expect(labelStylesOf(stored)).toEqual(DEFAULT_LABEL_STYLES);
  });

  it("resets the four keys of one style and no other", () => {
    expect(clearLabelStyle("unit")).toEqual({
      "label-style.unit.bold": null,
      "label-style.unit.italic": null,
      "label-style.unit.underline": null,
      "label-style.unit.color": null,
    });
  });
});

describe("what a name carries when it is drawn", () => {
  it("declares nothing for a worksheet that stores nothing, so the stylesheet draws as before", () => {
    const styles = labelStylesOf(undefined);
    for (const kind of LABEL_KINDS) {
      // A system variable is bold and upright by default, which the classes of the
      // stylesheet do not draw, so it declares that; every other label declares nothing.
      const style = kind === "sys" ? { fontStyle: "normal", fontWeight: "700" } : {};
      expect(nameStyle(styles, kind)).toEqual({ style, label: kind });
    }
  });

  it("declares only what differs, and colours the name through its label", () => {
    const styles = labelStylesOf({
      "label-style.var.italic": "false",
      "label-style.var.color": "#c00000",
      "label-style.fn.bold": "true",
      "label-style.fn.underline": "true",
      "label-style.kw.bold": "false",
    });
    expect(nameStyle(styles, "var")).toEqual({
      style: { fontStyle: "normal" },
      label: "var",
    });
    expect(nameStyle(styles, "fn")).toEqual({
      style: { fontWeight: "700", textDecoration: "underline" },
      label: "fn",
    });
    // A keyword is bold by default, so turning bold off says so explicitly.
    expect(nameStyle(styles, "kw")).toEqual({ style: { fontWeight: "400" }, label: "kw" });
  });

  it("puts a colour that differs on the sheet, and the unit colour on the unit token too", () => {
    expect(labelStyleCss(labelStylesOf(undefined))).toEqual({});
    const css = labelStyleCss(
      labelStylesOf({
        "label-style.var.color": "#c00000",
        "label-style.unit.color": "#008000",
      }),
    ) as Record<string, string>;
    expect(css["--label-var-color"]).toBe("#c00000");
    expect(css["--label-unit-color"]).toBe("#008000");
    // One colour for one meaning: the unit names and the unit of a result (`--unit-color`).
    expect(css["--unit-color"]).toBe("#008000");
    // A style back at its built-in colour declares nothing.
    const back = labelStyleCss(labelStylesOf({ "label-style.unit.color": UNIT_COLOR }));
    expect(back).toEqual({});
  });
});
