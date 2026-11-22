//! The polar operator:
//! `r∠θ`, looser than `·` and juxtaposition, tighter than `+`, non-associative.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

#[test]
fn the_operator_binds_between_addition_and_multiplication() {
    assert_eq!(sx("5∠θ"), "(∠ 5 θ)");
    assert_eq!(sx("5∠30 deg"), "(∠ 5 (juxt 30 deg))");
    assert_eq!(sx("a + 5∠θ"), "(+ a (∠ 5 θ))");
    assert_eq!(sx("5∠θ + a"), "(+ (∠ 5 θ) a)");
    assert_eq!(sx("2·5∠θ"), "(∠ (· 2 5) θ)");
    normalizes("z := 5∠30 deg", "z := 5∠30 deg");
    normalizes("z := a + 5 ∠ θ", "z := a + 5∠θ");
    normalizes("z := (5∠θ)·2", "z := (5∠θ)·2");
    normalizes("z := 5\\polar θ", "z := 5∠θ");
}

#[test]
fn the_operator_does_not_chain() {
    assert!(parse_expression("a∠b∠c").is_err());
}

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["r", "θ"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_calls_the_runtime() {
    assert_eq!(code("r∠θ"), "eq_polar(r_v1, θ_v1)");
}
