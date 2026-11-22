// The label styles of a worksheet:
// how a name of each label is drawn — bold, italic, underline and colour.
// A style is worksheet-wide and display only: it lives in the worksheet `settings:` next to the
// worksheet result format (`app/src/results/format.ts`), never in a region override, and it never
// affects a value. The drawing reads it here (`app/src/math/render.tsx` uses `nameStyle`), the
// command writes it as `label-style.*` keys (`labelStyleEdits`, `clearLabelStyle`).

import { createContext, type CSSProperties } from "react";
import { parseColor } from "./font";

/** The labels a name can carry. */
export type LabelKind = "var" | "const" | "fn" | "unit" | "sys" | "kw";

/** The six styles of, in the order the dialog lists them. */
export const LABEL_KINDS: readonly LabelKind[] = ["var", "const", "fn", "unit", "sys", "kw"];

/** What a style sets: the four properties of the letters of a name. */
export type LabelStyle = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
};

/** The styles of a worksheet, one per label. */
export type LabelStyles = Record<LabelKind, LabelStyle>;

/** The unit colour of the specification (`--unit-color` in `app/src/styles/math.css`). */
export const UNIT_COLOR = "#1d3a99";

/** The constant colour of the built-in style: the reference application's olive. */
export const CONSTANT_COLOR = "#556b2f";

/** The default text colour: black, the colour of every name that has no style of its own. */
export const DEFAULT_LABEL_COLOR = "#000000";

/**
 * The built-in style of each label:
 * a variable italic, a constant italic in olive, a function upright, a unit bold italic in the
 * unit blue (the reference application's look), a system variable and a keyword upright and bold. A Greek name stays upright whatever its
 * label. the reference application draws constants bold italic too; we keep them
 * at the regular weight.
 */
export const DEFAULT_LABEL_STYLES: LabelStyles = {
  var: { bold: false, italic: true, underline: false, color: DEFAULT_LABEL_COLOR },
  const: { bold: false, italic: true, underline: false, color: CONSTANT_COLOR },
  fn: { bold: false, italic: false, underline: false, color: DEFAULT_LABEL_COLOR },
  unit: { bold: true, italic: true, underline: false, color: UNIT_COLOR },
  sys: { bold: true, italic: false, underline: false, color: DEFAULT_LABEL_COLOR },
  kw: { bold: true, italic: false, underline: false, color: DEFAULT_LABEL_COLOR },
};

/**
 * What the classes of `app/src/styles/math.css` draw for a name of each label with no declaration
 * of its own (`.id` italic, `.up` upright, `.unit` bold, `.kw` bold, the unit token). The drawing
 * declares only what differs from this, so the stylesheet stays the one source of the plain look.
 */
const CLASS_STYLES: LabelStyles = {
  var: { bold: false, italic: true, underline: false, color: DEFAULT_LABEL_COLOR },
  const: { bold: false, italic: true, underline: false, color: DEFAULT_LABEL_COLOR },
  fn: { bold: false, italic: false, underline: false, color: DEFAULT_LABEL_COLOR },
  unit: { bold: true, italic: true, underline: false, color: UNIT_COLOR },
  sys: { bold: false, italic: true, underline: false, color: DEFAULT_LABEL_COLOR },
  kw: { bold: true, italic: false, underline: false, color: DEFAULT_LABEL_COLOR },
};

/** The prefix of a label-style key of the worksheet `settings:`. */
export const LABEL_STYLE_PREFIX = "label-style.";

/** The properties of a style, as the file names them. */
export const LABEL_PROPERTIES = ["bold", "italic", "underline", "color"] as const;

export type LabelProperty = (typeof LABEL_PROPERTIES)[number];

/** The `settings:` key of one property of one style, e.g. `label-style.var.italic`. */
export function labelStyleKey(kind: LabelKind, property: LabelProperty): string {
  return `${LABEL_STYLE_PREFIX}${kind}.${property}`;
}

/** Whether `key` is a label style: `label-style.<label>.<property>` with a label and a property
 *  the model knows. */
export function isLabelStyleKey(key: string): boolean {
  const parts = key.split(".");
  return (
    parts.length === 3 &&
    parts[0] === "label-style" &&
    (LABEL_KINDS as readonly string[]).includes(parts[1]) &&
    (LABEL_PROPERTIES as readonly string[]).includes(parts[2])
  );
}

/** A stored flag: `true`, `false`, or the built-in value when the file holds something else. */
function flag(text: string | undefined, builtIn: boolean): boolean {
  if (text === "true") return true;
  if (text === "false") return false;
  return builtIn;
}

/**
 * The styles a worksheet uses: the stored value when the drawing can use it, the built-in style of
 *  otherwise, so a hand-written file never fails and never draws something impossible.
 */
export function labelStylesOf(settings?: Record<string, string>): LabelStyles {
  const styles = {} as LabelStyles;
  for (const kind of LABEL_KINDS) {
    const builtIn = DEFAULT_LABEL_STYLES[kind];
    const read = (property: LabelProperty) => settings?.[labelStyleKey(kind, property)];
    styles[kind] = {
      bold: flag(read("bold"), builtIn.bold),
      italic: flag(read("italic"), builtIn.italic),
      underline: flag(read("underline"), builtIn.underline),
      color: parseColor(read("color")) ?? builtIn.color,
    };
  }
  return styles;
}

/**
 * The `settings:` edits of Apply: a value equal to the built-in style is removed (`null`)
 * instead of written, so a worksheet whose names look default carries no label-style key.
 */
export function labelStyleEdits(styles: LabelStyles): Record<string, string | null> {
  const edits: Record<string, string | null> = {};
  for (const kind of LABEL_KINDS) {
    const style = styles[kind];
    const builtIn = DEFAULT_LABEL_STYLES[kind];
    for (const property of LABEL_PROPERTIES) {
      const value =
        property === "color" ? style.color.toLowerCase() : String(style[property]);
      const same = property === "color" ? value === builtIn.color : style[property] === builtIn[property];
      edits[labelStyleKey(kind, property)] = same ? null : value;
    }
  }
  return edits;
}

/** The edits of Reset: the four keys of one style go away, no other style is touched. */
export function clearLabelStyle(kind: LabelKind): Record<string, string | null> {
  return Object.fromEntries(LABEL_PROPERTIES.map((property) => [labelStyleKey(kind, property), null]));
}

/**
 * The custom properties a label style puts on the sheet: a colour that differs from the
 * built-in one, named after its label. The unit colour is one token for the whole sheet, so a unit
 * style colour also paints the unit of a result; every other label colours its names only. A style
 * at its built-in value declares nothing, so a default worksheet carries no declaration.
 */
export function labelStyleCss(styles: LabelStyles): CSSProperties {
  const css: Record<string, string> = {};
  for (const kind of LABEL_KINDS) {
    const color = styles[kind].color;
    if (color.toLowerCase() === DEFAULT_LABEL_STYLES[kind].color) continue;
    css[`--label-${kind}-color`] = color;
    if (kind === "unit") css["--unit-color"] = color;
  }
  return css as CSSProperties;
}

/**
 * The label styles the drawing uses. The context carries the styles of the worksheet
 * whose sheet is being drawn; without a provider it is the built-in style of every label, which is
 * what a worksheet that stores nothing draws (`app/src/page/PageView.tsx` provides the worksheet's).
 */
export const LabelStylesContext = createContext<LabelStyles>(DEFAULT_LABEL_STYLES);

/** The declarations a name of one label carries. */
export type NameStyle = {
  /** The letter declarations that differ from the built-in style; empty when nothing differs. */
  style: CSSProperties;
  /** The label whose colour rule of the stylesheet paints the name (its built-in colour is the
   *  rule's fallback, a stored one a custom property of the sheet). */
  label: LabelKind;
};

/**
 * What a name of `kind` carries: only the properties the worksheet stores a value for that
 * differs from the built-in style, so a name of a worksheet with no stored style draws exactly what
 * the classes of `math.css` drew before. The colour is not an inline declaration (that would beat
 * the red of a failed region): it is the attribute that selects the stylesheet rule of .
 */
export function nameStyle(styles: LabelStyles, kind: LabelKind): NameStyle {
  const style = styles[kind];
  const builtIn = CLASS_STYLES[kind];
  const declarations: CSSProperties = {};
  if (style.italic !== builtIn.italic) declarations.fontStyle = style.italic ? "italic" : "normal";
  if (style.bold !== builtIn.bold) declarations.fontWeight = style.bold ? "700" : "400";
  if (style.underline !== builtIn.underline) declarations.textDecoration = style.underline ? "underline" : "none";
  return { style: declarations, label: kind };
}
