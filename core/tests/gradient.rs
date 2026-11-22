//! The gradient operator:
//! `∇[x, y] e`, the column of the partial derivatives of `e`.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

#[test]
fn the_gradient_is_a_binder_with_a_list_of_variables() {
    normalizes("g := ∇[x, y] f(x, y)", "g := ∇[x, y] f(x, y)");
    normalizes("g := ∇[x,y] x·y", "g := ∇[x, y] x·y");
    normalizes("g := \\nabla[x] x^2", "g := ∇[x] x^2");
    assert_eq!(sx("∇[x, y] x·y"), "(∇ [x y] (· x y))");
    // The body is the level-8 chain, as for ∂.
    assert_eq!(sx("∇[x] x + 1"), "(+ (∇ [x] x) 1)");
}

#[test]
fn the_list_is_required() {
    assert!(parse_expression("∇ f(x, y)").is_err());
    assert!(parse_expression("∇[] f(x)").is_err());
}

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["x", "y"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_is_the_column_of_partial_derivatives() {
    let generated = code("∇[x, y] x·y");
    assert!(
        generated.starts_with("eq_matrix(2, 1, eq_derivative("),
        "{generated}"
    );
    assert_eq!(
        generated.matches("eq_derivative(").count(),
        2,
        "{generated}"
    );
}
