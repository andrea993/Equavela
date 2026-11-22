// Latin -> Greek map of Ctrl+G. the reference application uses the Symbol-font convention; the user
// confirmed the non-obvious letters: q -> θ, j -> φ (U+03C6),
// f -> ϕ (U+03D5), w -> ω, c -> χ, y -> ψ.

const LOWER: Record<string, string> = {
  a: "α", b: "β", c: "χ", d: "δ", e: "ε", f: "ϕ", g: "γ", h: "η", i: "ι", j: "φ",
  k: "κ", l: "λ", m: "μ", n: "ν", o: "ο", p: "π", q: "θ", r: "ρ", s: "σ", t: "τ",
  u: "υ", v: "ϖ", w: "ω", x: "ξ", y: "ψ", z: "ζ",
};

const UPPER: Record<string, string> = {
  A: "Α", B: "Β", C: "Χ", D: "Δ", E: "Ε", F: "Φ", G: "Γ", H: "Η", I: "Ι", J: "ϑ",
  K: "Κ", L: "Λ", M: "Μ", N: "Ν", O: "Ο", P: "Π", Q: "Θ", R: "Ρ", S: "Σ", T: "Τ",
  U: "Υ", V: "ς", W: "Ω", X: "Ξ", Y: "Ψ", Z: "Ζ",
};

const TO_GREEK: Record<string, string> = { ...LOWER, ...UPPER };
const TO_LATIN: Record<string, string> = Object.fromEntries(
  Object.entries(TO_GREEK).map(([latin, greek]) => [greek, latin]),
);

/** Ctrl+G toggles: Latin -> Greek, Greek -> Latin, anything else unchanged. */
export function toggleGreek(ch: string): string {
  return TO_GREEK[ch] ?? TO_LATIN[ch] ?? ch;
}
