// Palette catalogues. Pure data: every entry says what it
// does through the same editor commands the keymap uses. An entry that cannot be used
//  is listed but disabled with the reason.

import { isNameChar, type Command } from "../editor/model";
import { builtinEntry } from "./builtins";
import { UNIT_GROUPS, type UnitEntry } from "./units";

export type PaletteKind =
  | "operators"
  | "symbols"
  | "programming"
  | "constants"
  | "symbolics"
  | "matrixFunctions"
  | "units";

export const PALETTE_KINDS: readonly PaletteKind[] = [
  "operators", "symbols", "programming", "constants", "symbolics", "matrixFunctions", "units",
];

export type PaletteAction =
  | { kind: "command"; command: Command }
  | { kind: "text"; text: string }
  /** A name inserted with the unit label (`m@unit`): the Units palette. */
  | { kind: "unit"; name: string }
  | { kind: "keyword"; name: string; modifier?: boolean }
  | { kind: "sequence"; steps: PaletteAction[] };

export type PaletteEntry = {
  label: string;
  title: string;
  action: PaletteAction;
  /** Extra search words. */
  keywords?: string;
  /** When set the entry is shown but cannot be used; the text says why. */
  disabled?: string;
  /** What the button draws, when it is not the label (the signs of names, drawn as + and −). */
  glyph?: string;
};

export type PaletteSection = { id: string; title: string; entries: PaletteEntry[] };

export const DEGREE_ENTRY: PaletteEntry = {
  label: "°", title: "Degree (the unit deg)", keywords: "angle",
  action: { kind: "unit", name: "°" },
};

const command = (label: string, title: string, value: Command, keywords = ""): PaletteEntry => ({
  label, title, keywords, action: { kind: "command", command: value },
});
const text = (label: string, title = label, value = label): PaletteEntry => ({
  label, title, action: { kind: "text", text: value },
});

/** A symbol is inserted into the name being typed; an operator glyph cannot be part of one. */
const symbol = (ch: string, title = ch): PaletteEntry =>
  isNameChar(ch)
    ? text(ch, title)
    : { label: ch, title, action: { kind: "text", text: ch }, disabled: "An operator, not valid in a name" };

const chars = (value: string): PaletteEntry[] => [...value].map((ch) => symbol(ch));

const section = (id: string, title: string, entries: PaletteEntry[]): PaletteSection => ({ id, title, entries });

export const GREEK_LOWER = "αβγδεζηθικλμνξοπρςστυφϕχψω";
export const GREEK_UPPER = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ";

export const SYMBOLIC_KEYWORDS = [
  "assume", "cauchy", "coeffs", "collect", "combine", "confrac", "decomp", "expand", "explicit",
  "factor", "float", "fourier", "fully", "invfourier", "invlaplace", "invztrans", "laplace",
  "parfrac", "rectangular", "rewrite", "series", "simplify", "solve", "standard", "substitute",
  "using", "ztrans",
];

export const SYMBOLIC_MODIFIERS = [
  "ALL", "acos", "acot", "arg", "asin", "atan", "atan2", "cauchy", "coeff", "complex", "cos", "cosh",
  "cot", "coth", "degree", "domain", "even", "exp", "expr", "fact", "fraction", "fully", "func",
  "gamma", "generated", "integer", "ln", "log", "matrix", "max", "nfact", "odd", "ofact", "parts",
  "power", "raw", "real", "RealRange", "sign", "signum", "sin", "sincos", "sinh", "sinhcos", "tan",
  "tanh", "using", "Φ",
];

/** the specification 2.2: the Vector/Matrix Functions palette. */
export const MATRIX_FUNCTIONS = [
  "abs", "augment", "Cholesky", "cols", "cond1", "cond2", "conde", "condi", "convolve", "crosscorr",
  "deconvolve", "det", "diag", "eigenvals", "eigenvec", "eigenvecs", "geninv", "genvals", "genvecs",
  "hlookup", "identity", "IsArray", "Jacob", "IsScalar", "kronecker", "last", "length", "logpts", "logspace",
  "lookup", "lsolve", "LU", "match", "matrix", "max", "min", "norm", "norm1", "norm2", "norme", "normi",
  "QR", "rank", "Rank", "rows", "rref", "stack", "submatrix", "svd", "svds", "tr", "vec", "vhlookup",
  "vlookup",
  // Equavela extension: the reference application's vector sum `Σv` is an operator (Matrix toolbar), not a
  // function; we name it `vsum`.
  "vsum",
];

/** A function-name entry: a built-in shows its signature, other names say they are missing. */
const OPERATOR_NOTES: Record<string, string> = {
  det: "det(M): determinant, written with the absolute value operator |M|",
  norm: "norm(M): norm, written with the norm operator ‖M‖",
};

export function functionEntry(name: string): PaletteEntry {
  const known = builtinEntry(name);
  return {
    label: name,
    title: known
      ? `${known.signature}: ${known.description}`
      : (OPERATOR_NOTES[name] ?? `${name}: not yet implemented by the engine`),
    keywords: known ? `${known.category} ${known.description}` : "",
    action: { kind: "text", text: name },
  };
}

/** A unit entry inserts the **labelled** name: a plain name in a value position is not a unit
 * . */
export function unitEntry(unit: UnitEntry, prefix = ""): PaletteEntry {
  const name = `${prefix}${unit.name}`;
  return {
    label: name,
    title: `${name}: ${unit.group.toLowerCase()}`,
    keywords: `${unit.group} ${unit.definition}`,
    action: { kind: "unit", name },
  };
}

const sub0 = (base: string): PaletteAction => ({
  kind: "sequence",
  steps: [{ kind: "text", text: base }, { kind: "command", command: "literalSubscript" }, { kind: "text", text: "0" }],
});

export function paletteSections(kind: PaletteKind, prefix = ""): PaletteSection[] {
  switch (kind) {
    case "operators":
      return [
        section("arithmetic", "Arithmetic", [
          command("+", "Addition", "add"), command("−", "Subtraction", "sub"),
          command("·", "Multiplication", "mul"), command("÷", "Stacked division", "frac", "fraction divide"),
          command("/", "Inline division", "inlineDiv", "slash"), command("xʸ", "Power", "pow", "exponent"),
          command("√x", "Square root", "sqrt", "root"), command("|x|", "Absolute value", "abs", "magnitude determinant"),
          command("x!", "Factorial", "factorial"), command("%", "Percent", "percent"),
          command("‰", "Parts per thousand", "permille", "per mille permil thousandth"),
          command("scale", "Scaling (implicit product)", "scale", "implicit multiply"),
        ]),
        section("layout", "Expression layout", [
          command("( )", "Parentheses", "openParen", "brackets"), command(",", "Comma", "comma", "separator"),
          command("a␣b", "Space (for writing only)", "gap", "blank gap quad spacing"),
          command("+↵", "Addition with equation break", "addBreak"),
          command("−↵", "Subtraction with equation break", "subBreak"),
          command("·↵", "Multiplication with equation break", "mulBreak"),
          command("÷↵", "Division with equation break", "inlineDivBreak"),
        ]),
        section("calculus", "Calculus & series", [
          command("d/dx", "Derivative", "deriv", "differentiate"), command("∇", "Gradient (nabla)", "gradient", "nabla grad"),
          command("∫", "Integral", "integral", "integrate"), command("lim", "Limit", "limit"),
          command("∂/∂x", "Partial derivative", "partial"), command("x′", "Derivative (prime)", "primeDeriv"),
          command("∏", "Product", "prod"), command("∑", "Sum", "sum", "summation"),
        ]),
        section("comparison", "Logic & tests", [
          command("∈", "Element of", "element", "member"), command("=", "Boolean equality", "boolEq", "equal compare"),
          command("⊕", "Logical xor", "xor", "exclusive or"), command(">", "Greater than", "greater"),
          command("≥", "Greater than or equal", "greaterEq"), command("<", "Less than", "less"),
          command("≤", "Less than or equal", "lessEq"), command("∧", "Logical and", "and"),
          command("¬", "Logical not", "not"), command("∨", "Logical or", "or"), command("≠", "Not equal", "notEq", "different"),
        ]),
        section("definition", "Assign & evaluate", [
          command(":=", "Definition", "define", "assign"), command("=", "Evaluation", "evaluate", "result"),
          command("≡", "Global definition", "globalDefine"), command("→", "Symbolic evaluation", "symbolic"),
        ]),
        section("complex", "Complex & angles", [
          command("z̄", "Complex conjugate", "conj", "conjugate"),
          command("ℜ", "Real part", "realPart", "re real"), command("ℑ", "Imaginary part", "imagPart", "im imaginary"),
          DEGREE_ENTRY,
          command("∠", "Polar form (magnitude∠angle)", "polar", "angle complex"),
        ]),
        section("vector", "Arrays & indexing", [
          command("×", "Cross product", "cross"), command("‖x‖", "Norm", "norm", "length"),
          command("[ ]", "Matrix", "matrix", "array"), command("M⟨i⟩", "Column", "column"),
          command("Mᵢ", "Index", "bracket", "subscript"), command("Mᵢᵀ", "Row", "row"),
          command("Mᵀ", "Transpose", "transpose"), command("v⃗", "Vectorize", "vectorize", "elementwise"),
        ]),
        section("sequences", "Sequences & signals", [
          command("1‥n", "Range (or type two periods after the first value)", "range", "range variable"),
          command("⊛", "Circular convolution", "circConv", "convolve"), command("∗", "Linear convolution", "conv", "convolve"),
        ]),
      ];
    case "symbols":
      return [
        section("greek", "Greek letters", [
          ...chars(GREEK_LOWER), ...chars(GREEK_UPPER),
        ]),
        section("numberSystems", "Number systems", [
          symbol("ℕ", "Natural numbers"), symbol("ℤ", "Integers"), symbol("ℚ", "Rational numbers"),
          symbol("ℝ", "Real numbers"), symbol("ℂ", "Complex numbers"),
        ]),
        section("logic", "Logic & arrows", [
          symbol("∀", "For all"), symbol("∃", "There exists"), symbol("∄", "There does not exist"),
          symbol("⇒", "Implies"),
          // Belonging is the operator ∈ (Operators palette); not belonging is a name character.
          symbol("∉", "Does not belong to"),
          ...chars("∴∵"),
          // Arrows for names, distinct from the assignment and evaluation operators.
          symbol("⟵", "Left arrow"), symbol("⟶", "Right arrow"), symbol("⟷", "Left right arrow"),
          symbol("↔", "Short left right arrow"), symbol("⇐", "Double left arrow"), symbol("⇔", "If and only if"),
        ]),
        section("geometry", "Geometry", [
          ...chars("∡∢"), DEGREE_ENTRY,
          symbol("⌀", "Diameter"), symbol("⊥", "Perpendicular"), symbol("∥", "Parallel"),
          symbol("△", "Triangle"), symbol("▽", "Down triangle"), symbol("≅", "Congruent"), symbol("∼", "Similar"),
        ]),
        section("relations", "Sets & relations", [
          symbol("∅", "Empty set"), symbol("⊂", "Subset"), symbol("⊃", "Superset"), symbol("∖", "Set minus"),
          ...chars("∐∩∪⊆⊇∍∝"),
          symbol("≈", "Approximately"), symbol("≃", "Asymptotically equal"),
          symbol("≪", "Much less"), symbol("≫", "Much greater"),
        ]),
        section("letters", "Letter forms", [
          symbol("ı", "Dotless i"), symbol("ℓ", "Script l"), symbol("℘", "Weierstrass p"), ...chars("ℵℶℷℸ"),
        ]),
        section("notation", "Numeric notation", [
          ...chars("‖∞"),
          // A colon in a name: the ratio sign, since the : key types a definition.
          symbol("∶", "Colon"),
          // The plus and minus of a name (V_+), drawn as + and −.
          { ...symbol("˖", "Plus in a name (V₊)"), glyph: "+" }, { ...symbol("˗", "Minus in a name (V₋)"), glyph: "−" },
          symbol("±", "Plus-minus"), symbol("∓", "Minus-plus"),
        ]),
        section("money", "Currency", chars("¢£¤¥€")),
        section("marks", "Annotation marks", [
          symbol("⋆", "Star (x⋆)"), symbol("★", "Black star"), symbol("✓", "Check mark"), ...chars("⁋©®†※"),
        ]),
      ];
    case "programming":
      return [
        section("flow", "Program flow", [
          command("program", "Program block", "programLine", "add line"),
          command("←", "Local assignment", "localAssign"),
          command("if", "If", "if"), command("else if", "Else if", "elseIf"), command("else", "Else", "else"),
          command("also if", "Also if", "alsoIf"), command("while", "While", "while", "loop"),
          command("for", "For", "for", "loop"), command("try", "Try / on error", "try", "catch"),
          command("return", "Return", "return"), command("break", "Break", "break"),
          command("continue", "Continue", "continue"),
        ]),
      ];
    case "constants":
      return [
        section("math", "Math", [
          { label: "∞", title: "Infinity", action: { kind: "command", command: "infinity" } },
          text("e", "Euler's number"),
          text("π", "Pi"),
        ]),
        section("physics", "Physics", [
          text("c", "Speed of light, 299 792 458 m/s"),
          text("e.c", "Elementary charge, 1.602 176 634e-19 C"),
          text("h", "Planck constant, 6.626 070 15e-34 J·s"),
          text("ħ", "Reduced Planck constant h/2π, 1.054 571 8e-34 J·s"),
          text("k", "Boltzmann constant, 1.380 649e-23 J/K"),
          text("m.u", "Atomic mass unit, 1.660 539 07e-27 kg"),
          text("N.A", "Avogadro constant, 6.022 140 76e23 1/mol"),
          text("R", "Molar gas constant, 8.314 462 6 J/(mol·K)"),
          text("R∞", "Rydberg constant, 10 973 731.568 157 1/m"),
          text("α", "Fine-structure constant, 7.297 352 564 3e-3"),
          text("γ", "Euler-Mascheroni constant"),
          { label: "ε₀", title: "Vacuum permittivity, 8.854 187 818 8e-12 F/m", action: sub0("ε") },
          { label: "μ₀", title: "Vacuum permeability, 1.256 637 061 27e-6 N/A²", action: sub0("μ") },
          text("σ", "Stefan-Boltzmann constant, 5.670 374 42e-8 W/(m²·K⁴)"),
          { label: "Φ₀", title: "Magnetic flux quantum, 2.067 833 848e-15 Wb", action: sub0("Φ") },
        ]),
      ];
    case "symbolics":
      return [
        section("operators", "Operators", [command("→", "Symbolic evaluation", "symbolic"), command("lim", "Limit", "limit")]),
        section("keywords", "Keywords", SYMBOLIC_KEYWORDS.map((name) => ({
          label: name, title: `Symbolic keyword ${name}`, keywords: "keyword", action: { kind: "keyword" as const, name },
        }))),
        section("modifiers", "Modifiers", SYMBOLIC_MODIFIERS.map((name) => ({
          label: name, title: `Modifier ${name} (of the last keyword)`, keywords: "modifier",
          action: { kind: "keyword" as const, name, modifier: true },
        }))),
      ];
    case "matrixFunctions":
      return [section("functions", "Vector and matrix functions", MATRIX_FUNCTIONS.map(functionEntry))];
    case "units":
      return UNIT_GROUPS.map((group) =>
        section(
          `unit-${group.title}`,
          group.title,
          group.units.map((unit) => unitEntry(unit, unit.prefixable ? prefix : "")),
        ),
      );
  }
}

/** Entries of a section list that match a search text (label, title, keywords, section). */
export function filterSections(sections: PaletteSection[], query: string): PaletteSection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections
    .map((s) => ({
      ...s,
      entries: s.entries.filter((e) =>
        `${e.label} ${e.title} ${e.keywords ?? ""} ${s.title}`.toLowerCase().includes(needle)),
    }))
    .filter((s) => s.entries.length > 0);
}
