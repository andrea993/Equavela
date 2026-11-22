//! The real and imaginary part operators:
//! backslash words `\Re(z)` and `\Im(z)`, drawn ℜ(z) and ℑ(z), built like
//! the conjugate `\conj(z)`.

mod common;
use common::*;
use equavela_core::syntax::*;

fn normalizes(input: &str, canonical: &str) {
    assert_eq!(canon(input), canonical, "canonical form of {input:?}");
    assert_fixed_point(canonical);
}

#[test]
fn the_operators_are_backslash_words_with_their_parentheses() {
    normalizes("x := \\Re(z)", "x := \\Re(z)");
    normalizes("y := \\Im(a + b)", "y := \\Im(a + b)");
    normalizes("\\Re(z)^2 + \\Im(z)^2 =", "\\Re(z)^2 + \\Im(z)^2 =");
    assert_eq!(sx("\\Re(z)"), "(Re z)");
    assert_eq!(sx("\\Im(2·z)"), "(Im (· 2 z))");
    // The plain names stay names: `Re(z)` is the built-in function, a call.
    assert_eq!(sx("Re(z)"), "(call Re z)");
}

#[test]
fn the_parentheses_are_required() {
    assert!(parse_expression("\\Re z").is_err());
}

fn code(src: &str) -> String {
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e}"));
    let mut generator = equavela_core::codegen::Generator::default();
    generator.declare_variable("z");
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

#[test]
fn the_codegen_calls_the_runtime_parts() {
    assert_eq!(code("\\Re(z)"), "eq_re(z_v1)");
    assert_eq!(code("\\Im(z)"), "eq_im(z_v1)");
}
