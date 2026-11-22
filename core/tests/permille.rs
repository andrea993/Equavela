//! The per mille operator:
//! a postfix `‰`, the value divided by 1000, built like the reference application's percent.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

#[test]
fn per_mille_is_a_postfix_operator_written_without_a_space() {
    normalizes("x := 2.5‰", "x := 2.5‰");
    normalizes("x := 2.5 ‰", "x := 2.5‰");
    normalizes("2.5‰ =", "2.5‰ =");
    normalizes("y := (a + b)‰", "y := (a + b)‰");
    normalizes("y := 2·3‰ + 1", "y := 2·3‰ + 1");
    // The ASCII alias reads as the sign.
    normalizes("x := 2.5\\permille", "x := 2.5‰");
}

#[test]
fn the_tree_is_a_per_mille_node() {
    assert_eq!(sx("2.5‰"), "(‰ 2.5)");
    assert_eq!(sx("2·3‰"), "(· 2 (‰ 3))");
    assert_eq!(sx("x%‰"), "(‰ (% x))");
}

#[test]
fn per_mille_never_starts_an_operand_nor_joins_a_name() {
    for src in ["‰x", "y := ‰3"] {
        assert!(
            parse_expression(src).is_err() || parse_statement(src).is_err(),
            "{src} parsed"
        );
    }
    assert!(parse_expression("x‰y").is_err());
}

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    for name in ["a", "b", "x"] {
        generator.declare_variable(name);
    }
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_calls_the_runtime() {
    assert_eq!(code("2.5‰"), "eq_permille(2.5)");
    assert_eq!(code("(a + b)‰"), "eq_permille(eq_add(a_v1, b_v1))");
}
