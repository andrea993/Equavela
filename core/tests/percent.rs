//! the reference application's percent operator:
//! a postfix `%`, the value divided by 100.
//!
//! The text round-trips (R1, R2, R3), the tree is `Percent{expr}`, the codegen calls the
//! runtime (`eq_percent`, never an inline division) and `%` stays out of names.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

// ---------------------------------------------------------------- form and printing

#[test]
fn percent_is_a_postfix_operator_written_without_a_space() {
    normalizes("x := 3.4%", "x := 3.4%");
    normalizes("3.4% =", "3.4% =");
    // No adjacency is needed, as for `!` and `ᵀ`: the printer writes the sign tight.
    normalizes("x := 3.4 %", "x := 3.4%");
    normalizes("3.4  %  =", "3.4% =");
    normalizes("x% + y%", "x% + y%");
    normalizes("y := (a + b)%", "y := (a + b)%");
    normalizes("y := M⟨0⟩%", "y := M⟨0⟩%");
    // A percent is a value of the tightest level, so it binds before every binary operator.
    normalizes("2·3%", "2·3%");
    normalizes("y := 2·3% + 1", "y := 2·3% + 1");
}

#[test]
fn the_tree_is_a_percent_node() {
    assert_eq!(sx("3.4%"), "(% 3.4)");
    assert_eq!(sx("x%"), "(% x)");
    assert_eq!(sx("2·3%"), "(· 2 (% 3))");
    assert_eq!(sx("(2·3)%"), "(% (paren (· 2 3)))");
    assert_eq!(sx("x := 3.4%"), "(:= x (% 3.4))");
    assert_eq!(sx("3.4% ="), "(= (% 3.4))");
    assert_eq!(sx("y := x%%"), "(:= y (% (% x)))");
    assert_eq!(sx("v[i]%"), "(% (index v i))");
}

#[test]
fn a_percent_with_an_unary_operand_round_trips() {
    normalizes("y := -x%", "y := -x%");
    normalizes("y := (-x)%", "y := (-x)%");
    normalizes("y := 2·x%ᵀ", "y := 2·x%ᵀ");
}

#[test]
fn percent_never_starts_an_operand() {
    // `%` is not a name character and not a primary: it needs an operand on its left.
    for src in ["%x", "y := %3", "3.4 + %"] {
        assert!(
            parse_expression(src).is_err() || parse_statement(src).is_err(),
            "{src} parsed"
        );
    }
    // It is not part of a name either: `x%y` is the percent of `x` and then a name.
    assert!(parse_expression("x%y").is_err());
}

// ---------------------------------------------------------------- codegen

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["a", "b", "x", "y", "A", "v"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_calls_the_runtime() {
    // A runtime function, never an inline `eq_div(x, 100)` or `0.01·x`.
    assert_eq!(code("3.4%"), "eq_percent(3.4)");
    assert_eq!(code("x%"), "eq_percent(x_v1)");
    assert_eq!(code("(a + b)%"), "eq_percent(eq_add(a_v1, b_v1))");
    assert_eq!(code("2·3%"), "eq_mul(2.0, eq_percent(3.0))");
    assert_eq!(code("x%%"), "eq_percent(eq_percent(x_v1))");
}
