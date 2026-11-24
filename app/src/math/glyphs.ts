// Operator glyphs. Operators that differ in meaning never share a glyph:
// definition, global definition, evaluation, symbolic evaluation, Boolean
// equality (bold) and local assignment are six distinct renderings.

export const GLYPH = {
  define: ":=",
  globalDefine: "≡",
  evaluate: "=",
  symbolic: "→",
  local: "←",
  /** Boolean equality is drawn (two heavy bars), not typeset: see `BooleanEquals`. */
  booleanEquals: "=",
  notEqual: "≠",
  less: "<",
  greater: ">",
  lessEqual: "≤",
  greaterEqual: "≥",
  element: "∈",
  and: "∧",
  or: "∨",
  xor: "⊕",
  /** A blank space between two parts of a formula: drawn empty; `␣` in the text. */
  gap: "\u2002",
  not: "¬",
  minus: "−",
  times: "·",
  cross: "×",
  inlineDivide: "/",
  range: "..",
  /** the reference application's postfix percent. */
  percent: "%",
  /** The per mille, built like the percent. */
  permille: "‰",
  prime: "′",
  integral: "∫",
  sum: "∑",
  product: "∏",
  differential: "ⅆ",
  partial: "∂",
  infinity: "∞",
} as const;

/**
 * The glyphs of a display-only ellipsis cell of a matrix, by the
 * form the AST stores: one meaning, three directions, each kept as typed.
 */
export const ELLIPSIS_GLYPH: Record<string, string> = {
  horizontal: "⋯",
  vertical: "⋮",
  diagonal: "⋱",
};

/** Binary operators drawn as a single glyph between the operands. */
export const BINARY_GLYPH: Record<string, string> = {
  Add: "+",
  Sub: GLYPH.minus,
  Mul: GLYPH.times,
  InlineDiv: GLYPH.inlineDivide,
  Cross: GLYPH.cross,
  Conv: "∗",
  CircConv: "⊛",
  Polar: "∠",
  Ne: GLYPH.notEqual,
  Lt: GLYPH.less,
  Gt: GLYPH.greater,
  Le: GLYPH.lessEqual,
  Ge: GLYPH.greaterEqual,
  In: GLYPH.element,
  And: GLYPH.and,
  Or: GLYPH.or,
  Xor: GLYPH.xor,
};

/** Binding strength of expressions; used for safety parentheses. */
export function level(type: string): number {
  switch (type) {
    case "Or":
    case "Xor":
    case "Gap":
      return 3;
    case "And":
      return 4;
    case "Not":
      return 5;
    case "Eq":
    case "Ne":
    case "Lt":
    case "Gt":
    case "Le":
    case "Ge":
    case "In":
      return 6;
    case "Add":
    case "Sub":
      return 7;
    // Between + and ·.
    case "Polar":
      return 7.5;
    case "Mul":
    case "InlineDiv":
    case "Juxt":
    case "Cross":
    case "Conv":
    case "CircConv":
      return 8;
    case "Sum":
    case "Prod":
    case "Integral":
    case "Deriv":
    case "Partial":
    case "Gradient":
    case "Limit":
      return 9;
    case "Neg":
      return 10;
    case "Div":
      return 11;
    case "Pow":
      return 12;
    case "Range":
    case "Program":
      return 2;
    case "InlineDef":
      // A parenthesised local definition binds looser than every operand position allows;
      // the pair of its own form is always there.
      return 1;
    case "Factorial":
    case "Percent":
    case "Permille":
    case "Transpose":
    case "Call":
    case "JuliaCall":
    case "Index":
    case "Column":
    case "Row":
    case "PrimeDeriv":
      return 13;
    default:
      return 14;
  }
}
