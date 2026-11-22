//! One test per row of the precedence table (math-syntax section 5): the parsed tree and
//! the canonical text, which prints back unchanged.

mod common;
use common::*;

fn check(src: &str, expected: &str) {
    assert_eq!(sx(src), expected, "tree of {src:?}");
    assert_fixed_point(src);
}

#[test]
fn level_01_statements_and_tails() {
    // `:=`, `≡` and the tails bind loosest: the whole expression is the right side.
    check(
        "f(x) := a ∨ b →[simplify]",
        "(:= (fn f x) (∨ a b) (→ (simplify)))",
    );
    check("x ≡ a + b", "(≡ x (+ a b))");
    check("a ∧ b =", "(= (∧ a b))");
    check("x := a == b =", "(:= x (== a b) (=))");
    check("a + b = … m/s", "(= (+ a b) (/ m s))");
}

#[test]
fn level_02_range() {
    check(
        "i := a + 1, a + 2..b·c",
        "(:= i (range (+ a 1) (+ a 2) (· b c)))",
    );
    check("for_i := N - 1..0", "(:= for_i (range (- N 1) 0))");
    // Non-associative and not an expression: a second `..` and a comparison bound fail.
    assert!(equavela_core::parse_statement("x := 1..2..3").is_err());
    assert!(equavela_core::parse_statement("x := a < b..c").is_err());
    check("x := (a < b)..c", "(:= x (range (paren (< a b)) c))");
}

#[test]
fn level_03_or_xor_left() {
    check("a ∨ b ⊕ c", "(⊕ (∨ a b) c)");
    check("a ⊕ b ∨ c", "(∨ (⊕ a b) c)");
    check("a ∨ (b ∨ c)", "(∨ a (paren (∨ b c)))");
    check("a ∨ b ∧ c", "(∨ a (∧ b c))");
}

#[test]
fn level_04_and_left() {
    check("a ∧ b ∧ c", "(∧ (∧ a b) c)");
    check("a ∧ (b ∧ c)", "(∧ a (paren (∧ b c)))");
    check("¬a ∧ b", "(∧ (¬ a) b)");
}

#[test]
fn level_05_not_prefix() {
    check("¬a < b", "(¬ (< a b))");
    check("¬¬a", "(¬ (¬ a))");
    check("¬(a ∧ b)", "(¬ (paren (∧ a b)))");
}

#[test]
fn level_06_comparisons_left() {
    check("a < b < c", "(< (< a b) c)");
    check("a + b == c - d", "(== (+ a b) (- c d))");
    check("x ∈ v ≠ 0", "(≠ (∈ x v) 0)");
    check("a ≤ (b ≥ c)", "(≤ a (paren (≥ b c)))");
}

#[test]
fn level_07_additive_left() {
    check("a - b - c", "(- (- a b) c)");
    check("a - (b - c)", "(- a (paren (- b c)))");
    check("a + b·c", "(+ a (· b c))");
    check("a + -b", "(+ a (neg b))");
}

#[test]
fn level_08_multiplicative_left() {
    check("a·b÷c × d e", "(juxt (× (÷ (· a b) c) d) e)");
    check("3.5 m·s", "(· (juxt 3.5 m) s)");
    check("12 kN/m", "(juxt 12 (/ kN m))");
    check("a·(b·c)", "(· a (paren (· b c)))");
    check("a·-b", "(· a (neg b))");
    // A following `-` is always binary; the right operand of juxtaposition cannot be `-x`.
    check("a - b", "(- a b)");
    assert_eq!(sx("a -b"), "(- a b)");
    check("a (-b)", "(juxt a (paren (neg b)))");
}

#[test]
fn level_09_big_operators() {
    check("∑[k ∈ 0..n] a·b + c", "(+ (∑ k 0 n (· a b)) c)");
    check("∑[k ∈ 0..n] (a + b)", "(∑ k 0 n (paren (+ a b)))");
    check("(∑[k ∈ 0..n] a)·b", "(· (paren (∑ k 0 n a)) b)");
    check("-∑[i] a", "(neg (∑ i a))");
    check("c·∏[i] a b", "(· c (∏ i (juxt a b)))");
    check("ⅆ[x^2] f(x) - ∂[y] g", "(- (ⅆ x 2 (call f x)) (∂ y g))");
    check("\\lim[x, 0, +] x·y", "(lim x 0 + (· x y))");
}

#[test]
fn level_10_unary_minus() {
    check("-x^2", "(neg (^ x 2))");
    check("-a/b", "(neg (/ a b))");
    check("-a·b", "(· (neg a) b)");
    check("--a", "(neg (neg a))");
    check("(-a)^2", "(^ (paren (neg a)) 2)");
}

#[test]
fn level_11_stacked_fraction() {
    check("a/b/c", "(/ (/ a b) c)");
    check("a/(b/c)", "(/ a (/ b c))");
    check("a/b^2", "(/ a (^ b 2))");
    check("(a + b)/(c + d)", "(/ (+ a b) (+ c d))");
    check("((a + b))/c", "(/ (paren (+ a b)) c)");
    check("(-a)/b", "(/ (neg a) b)");
}

#[test]
fn level_12_power_right() {
    check("a^b^c", "(^ a (^ b c))");
    check("(a^b)^c", "(^ (paren (^ a b)) c)");
    check("x^-1", "(^ x (neg 1))");
    check("x^(n - 1)", "(^ x (- n 1))");
    check("x^(-a/b)", "(^ x (neg (/ a b)))");
    check("(a/b)^2", "(^ (paren (/ a b)) 2)");
}

#[test]
fn level_13_postfix_left() {
    check("X⟨0⟩ᵀ", "(ᵀ (col X 0))");
    check("f(x)[i]!", "(! (index (call f x) i))");
    check("M⟪i⟫′", "(′ (row M i) 1)");
    // A range is the whole index of the postfix operators.
    check("M⟪0..n - 1⟫", "(row M (range 0 (- n 1)))");
    check("M⟨1..3⟩", "(col M (range 1 3))");
    check("v[2..5]", "(index v (range 2 5))");
    check("v[2..5][0]", "(index (index v (range 2 5)) 0)");
    check("M⟪0, 2..4⟫ᵀ", "(ᵀ (row M (range 0 2 4)))");
    check("f′′(x)", "(call (′ f 2) x)");
    check("(2·n - 2·m)!", "(! (paren (- (· 2 n) (· 2 m))))");
    // the reference application's percent is postfix and binds like the other postfix operators.
    check("2·3%", "(· 2 (% 3))");
    check("(2·3)%", "(% (paren (· 2 3)))");
    check("x%%", "(% (% x))");
    check("-x%", "(neg (% x))");
    // Without adjacency, brackets are operands of a juxtaposition (D12).
    check("v [i]", "(juxt v (matrix 1×1 i))");
    check("f (x)", "(juxt f (paren x))");
}

#[test]
fn level_14_primaries() {
    check("|a| + ‖b‖ + √x·y", "(+ (+ (abs a) (norm b)) (· (√ x) y))");
    check("√x[i]", "(√ (index x i))");
    check("(√x)[i]", "(index (paren (√ x)) i)");
    check("\\vec(a·b)·\\det(M)", "(· (vec (· a b)) (det M))");
    check("\\conj(z)ᵀ", "(ᵀ (conj z))");
    check("[1, 2; 3, 4]", "(matrix 2×2 1 2 3 4)");
    check("program { a; b }·2", "(· (program a b) 2)");
    check("\"s\"", "\"s\"");
    check("□ + □", "(+ □ □)");
}
