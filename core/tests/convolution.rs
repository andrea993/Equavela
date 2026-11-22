//! The convolution operators:
//! `A ∗ B` linear and `A ⊛ B` circular, at the level of `×`.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

#[test]
fn the_operators_round_trip_with_spaces() {
    normalizes("y := a∗b", "y := a ∗ b");
    normalizes("y := a ⊛ b", "y := a ⊛ b");
    normalizes("y := a \\conv b", "y := a ∗ b");
    normalizes("y := a \\cconv b", "y := a ⊛ b");
    assert_eq!(sx("a ∗ b"), "(∗ a b)");
    assert_eq!(sx("a ⊛ b"), "(⊛ a b)");
    // The level of ×: tighter than +, left-associative.
    assert_eq!(sx("a + b ∗ c"), "(+ a (∗ b c))");
    assert_eq!(sx("a ∗ b ⊛ c"), "(⊛ (∗ a b) c)");
}

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["a", "b"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_calls_convolve() {
    assert_eq!(code("a ∗ b"), "eq_convolve(a_v1, b_v1)");
    assert_eq!(code("a ⊛ b"), "eq_convolve(a_v1, b_v1, 1)");
}
