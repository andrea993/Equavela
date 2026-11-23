//! Snapshot tests of the Julia generator (`equavela_core::codegen`) and, when `julia` is on
//! PATH, end-to-end tests that run the generated code against `kernel/EqRuntime`.
//!
//! The expected strings are the contract of the generated code: every reference application semantic is
//! a `eq_*` helper call, control flow follows `kernel/EqRuntime/src/programs.jl`.

use equavela_core::ast::{Name, Segment};
use equavela_core::codegen::{
    demangle_ident, generate_expression, generate_worksheet, julia_string, local_ident,
    worksheet_ident, GenOptions, GeneratedRegion, Generator, JuliaImport, BUILTINS,
};
use equavela_core::graph::{Region, Worksheet};
use equavela_core::{parse_expression, parse_statement, print_expression};

fn expr_with(vars: &[&str], src: &str) -> String {
    let mut generator = Generator::default();
    for var in vars {
        generator.declare_variable(var);
    }
    let parsed = parse_expression(src).unwrap_or_else(|e| panic!("parse `{src}`: {e:?}"));
    generator
        .expression(&parsed)
        .unwrap_or_else(|e| panic!("generate `{src}`: {e}"))
}

fn expr(src: &str) -> String {
    expr_with(&["x", "y", "z", "A", "B", "v", "n"], src)
}

#[test]
fn builtin_catalogue_matches_the_codegen_authority() {
    // `the specification` is generated from the specification by
    // `node scripts/gen-builtin-catalogue.mjs`; the name column must be exactly BUILTINS.
    let fixture = include_str!("../fixtures/builtin-catalogue.tsv")
        .lines()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let names = fixture
        .iter()
        .map(|line| line.split('\t').next().unwrap())
        .collect::<Vec<_>>();
    let actual = BUILTINS.iter().map(|(name, _)| *name).collect::<Vec<_>>();
    assert_eq!(names, actual);
    for line in &fixture {
        let columns = line.split('\t').collect::<Vec<_>>();
        assert_eq!(
            columns.len(),
            4,
            "name, signature, category, description: {line}"
        );
        assert!(columns.iter().all(|c| !c.is_empty()), "{line}");
        assert!(columns[1].starts_with(columns[0]), "signature of {line}");
    }
}

/// Generates statements in order with one generator (versions accumulate).
fn regions(sources: &[&str]) -> Vec<GeneratedRegion> {
    let mut generator = Generator::default();
    sources
        .iter()
        .enumerate()
        .map(|(index, src)| {
            let statement = parse_statement(src).unwrap_or_else(|e| panic!("parse `{src}`: {e:?}"));
            generator.region(&format!("r{index}"), &statement)
        })
        .collect()
}

fn code(src: &str) -> String {
    regions(&[src]).remove(0).code
}

// ---------------------------------------------------------------------------- literals

#[test]
fn numbers_are_float_literals() {
    assert_eq!(expr("1"), "1.0");
    assert_eq!(expr("1.50"), "1.50");
    assert_eq!(expr(".5"), ".5");
    assert_eq!(expr("1.5e-3"), "1.5e-3");
    assert_eq!(expr("1E5"), "1e5");
    assert_eq!(expr("-2"), "-2.0");
    assert_eq!(expr("-x"), "eq_neg(x_v1)");
}

#[test]
fn imaginary_literals_and_strings() {
    assert_eq!(expr("2.5i"), "ComplexF64(0.0, 2.5)");
    assert_eq!(expr("1j"), "ComplexF64(0.0, 1.0)");
    assert_eq!(
        expr("1j π"),
        "eq_mul(ComplexF64(0.0, 1.0), 3.141592653589793)"
    );
    assert_eq!(expr(r#""abc""#), r#""abc""#);
    assert_eq!(
        julia_string("a\"b\\c$d\n\u{1}é"),
        "\"a\\\"b\\\\c\\$d\\n\\u0001é\""
    );
}

#[test]
fn constants() {
    assert_eq!(expr("π"), "3.141592653589793");
    assert_eq!(expr("e"), "2.718281828459045");
    assert_eq!(expr("∞"), "Inf");
    assert_eq!(expr("ORIGIN"), "origin()");
    assert_eq!(expr("TOL"), "tol()");
    assert_eq!(expr("2·TOL"), "eq_mul(2.0, tol())");
    // CTOL is the same kind of name
    assert_eq!(expr("CTOL"), "ctol()");
    assert_eq!(expr("TOL + CTOL"), "eq_add(tol(), ctol())");
}

#[test]
fn physical_constants_are_runtime_lookups_and_a_definition_wins() {
    assert_eq!(expr("c"), r#"eq_constant("c")"#);
    assert_eq!(expr("e.c"), r#"eq_constant("e.c")"#);
    assert_eq!(expr("R∞"), r#"eq_constant("R∞")"#);
    // the subscript form and the plain spelling are the same constant
    assert_eq!(expr("ε_0"), r#"eq_constant("ε_0")"#);
    assert_eq!(expr("ε0"), r#"eq_constant("ε_0")"#);
    assert_eq!(expr("h·c"), r#"eq_mul(eq_constant("h"), eq_constant("c"))"#);
    // a definition of the name hides the constant; another subscript is another name
    assert_eq!(expr_with(&["c"], "c"), "c_v1");
    assert!(expr("c_x").contains("is undefined"));
    // `mu` and `NA` are ordinary (undefined) names, not constants
    assert!(expr("mu").contains("mu is undefined"));
    assert!(expr("NA").contains("NA is undefined"));
    // an explicit variable label is never a constant; an explicit constant label is
    assert!(expr("c@var").contains("is undefined"));
    assert_eq!(expr("c@const"), r#"eq_constant("c")"#);
}

// --------------------------------------------------------------------------- operators

#[test]
fn arithmetic_operators_call_eq_helpers() {
    assert_eq!(expr("x + y"), "eq_add(x_v1, y_v1)");
    assert_eq!(expr("x - y"), "eq_sub(x_v1, y_v1)");
    assert_eq!(expr("x·y"), "eq_mul(x_v1, y_v1)");
    assert_eq!(expr("x y"), "eq_mul(x_v1, y_v1)");
    assert_eq!(expr("x/y"), "eq_div(x_v1, y_v1)");
    assert_eq!(expr("x÷y"), "eq_div(x_v1, y_v1)");
    assert_eq!(expr("x^y"), "eq_pow(x_v1, y_v1)");
    assert_eq!(expr("A^-1"), "eq_pow(A_v1, -1.0)");
    assert_eq!(expr("A × B"), "eq_cross(A_v1, B_v1)");
    assert_eq!(expr("n!"), "eq_factorial(n_v1)");
    assert_eq!(expr("(x + y)·z"), "eq_mul(eq_add(x_v1, y_v1), z_v1)");
}

#[test]
fn unary_and_postfix_operators() {
    assert_eq!(expr("Aᵀ"), "eq_transpose(A_v1)");
    assert_eq!(expr("\\conj(z)"), "eq_conj(z_v1)");
    assert_eq!(expr("|x|"), "eq_abs(x_v1)");
    assert_eq!(expr("\\det(A)"), "eq_det(A_v1)");
    assert_eq!(expr("‖v‖"), "eq_norm(v_v1)");
    assert_eq!(expr("¬x"), "eq_not(x_v1)");
    assert_eq!(expr("√x"), "eq_sqrt(x_v1)");
    assert_eq!(expr("√[3](x)"), "eq_nthroot(x_v1, 3.0)");
}

#[test]
fn comparisons_and_chains() {
    assert_eq!(expr("x == y"), "eq_eq(x_v1, y_v1)");
    assert_eq!(expr("x ≠ y"), "eq_ne(x_v1, y_v1)");
    assert_eq!(expr("x < y"), "eq_lt(x_v1, y_v1)");
    assert_eq!(expr("x ≤ y"), "eq_le(x_v1, y_v1)");
    assert_eq!(expr("x ≥ y"), "eq_ge(x_v1, y_v1)");
    assert_eq!(expr("x > y"), "eq_gt(x_v1, y_v1)");
    assert_eq!(expr("x ∈ v"), "eq_in(x_v1, v_v1)");
    assert_eq!(
        expr("0 < x < 1"),
        "eq_chain((eq_lt, eq_lt), 0.0, x_v1, 1.0)"
    );
    assert_eq!(
        expr("0 ≤ x < y ≤ 5"),
        "eq_chain((eq_le, eq_lt, eq_le), 0.0, x_v1, y_v1, 5.0)"
    );
    // A parenthesised comparison is a value, not a chain.
    assert_eq!(expr("(0 < x) < 1"), "eq_lt(eq_lt(0.0, x_v1), 1.0)");
}

#[test]
fn boolean_operators_short_circuit() {
    assert_eq!(expr("x ∧ y"), "eq_and(x_v1, () -> y_v1)");
    assert_eq!(expr("x ∨ y"), "eq_or(x_v1, () -> y_v1)");
    assert_eq!(expr("x ⊕ y"), "eq_xor(x_v1, y_v1)");
    assert_eq!(
        expr("x ∧ y ∨ z"),
        "eq_or(eq_and(x_v1, () -> y_v1), () -> z_v1)"
    );
}

#[test]
fn if_is_lazy() {
    assert_eq!(
        expr("if(x > 0, x, -x)"),
        "eq_if(eq_gt(x_v1, 0.0), () -> x_v1, () -> eq_neg(x_v1))"
    );
    let mut generator = Generator::default();
    let parsed = parse_expression("if(1, 2)").unwrap();
    let text = generator.expression(&parsed).unwrap();
    assert_eq!(text, "eq_error(\"if needs three arguments\")");
    assert_eq!(generator.diagnostics().len(), 1);
}

// ------------------------------------------------------------------- arrays and indexing

#[test]
fn indexing_columns_rows_and_matrices() {
    assert_eq!(expr("v[2]"), "eq_index(v_v1, 2.0)");
    assert_eq!(
        expr("A[x, y + 1]"),
        "eq_index(A_v1, x_v1, eq_add(y_v1, 1.0))"
    );
    assert_eq!(expr("A⟨0⟩"), "eq_col(A_v1, 0.0)");
    assert_eq!(expr("A⟪1⟫"), "eq_row(A_v1, 1.0)");
    assert_eq!(expr("A⟨0⟩ᵀ"), "eq_transpose(eq_col(A_v1, 0.0))");
    assert_eq!(expr("[1, 2; 3, 4]"), "eq_matrix(2, 2, 1.0, 2.0, 3.0, 4.0)");
    assert_eq!(expr("[1; 2; 3]"), "eq_matrix(3, 1, 1.0, 2.0, 3.0)");
    assert_eq!(expr("[0]"), "eq_matrix(1, 1, 0.0)");
    assert_eq!(
        expr("[[A], [B]]"),
        "eq_matrix(1, 2, eq_matrix(1, 1, A_v1), eq_matrix(1, 1, B_v1))"
    );
    assert_eq!(expr("(A[0])[1]"), "eq_index(eq_index(A_v1, 0.0), 1.0)");
}

#[test]
fn a_call_of_an_element_passes_the_element_and_its_text() {
    //  to 3 (GitHub ): the callee is the index and the call is `eq_call`,
    // which reports an element that is not a function by the name written in the worksheet.
    let vars = ["F", "i", "j", "x"];
    assert_eq!(
        expr_with(&vars, "F[0](x)"),
        r#"eq_call(eq_index(F_v1, 0.0), "F[0]", x_v1)"#
    );
    assert_eq!(
        expr_with(&vars, "F[i](x, 2)"),
        r#"eq_call(eq_index(F_v1, i_v1), "F[i]", x_v1, 2.0)"#
    );
    assert_eq!(
        expr_with(&vars, "F[i, j](x)"),
        r#"eq_call(eq_index(F_v1, i_v1, j_v1), "F[i, j]", x_v1)"#
    );
    let chain = ["t", "ord", "x"];
    assert_eq!(
        expr_with(&chain, "t[ord](x)"),
        r#"eq_call(eq_index(t_v1, ord_v1), "t[ord]", x_v1)"#
    );
    // A name is still called directly: `eq_call` is the element form only.
    assert_eq!(expr_with(&["f", "x"], "f(x)"), "f_v1(x_v1)");
    assert_eq!(expr_with(&["f", "x"], "(f)(x)"), "(f_v1)(x_v1)");
}

#[test]
fn vectorize_captures_free_names() {
    assert_eq!(
        expr("\\vec(x·y + 1)"),
        "eq_vectorize((x_v1, y_v1) -> eq_add(eq_mul(x_v1, y_v1), 1.0), x_v1, y_v1)"
    );
    assert_eq!(
        expr("\\vec(|v|)"),
        "eq_vectorize((v_v1) -> eq_abs(v_v1), v_v1)"
    );
    assert_eq!(expr("\\vec(2 + 3)"), "eq_vectorize(() -> eq_add(2.0, 3.0))");
}

#[test]
fn root_solver_forms() {
    // guess form: the expression becomes a lambda of the unknown, the guess is the value
    assert_eq!(
        expr("root(x^2 - 2, x)"),
        "eq_root(x -> eq_sub(eq_pow(x, 2.0), 2.0), x_v1)"
    );
    // interval form: the unknown is bound, it need not be defined
    assert_eq!(
        expr_with(&["a", "b"], "root(a·x - b, x, 0, 10)"),
        "eq_root(x -> eq_sub(eq_mul(a_v1, x), b_v1), 0.0, 10.0)"
    );
    assert_eq!(
        expr_with(&["a"], "root(a·x - 1, x, -5, 5)"),
        "eq_root(x -> eq_sub(eq_mul(a_v1, x), 1.0), -5.0, 5.0)"
    );
    // calls of worksheet functions and built-ins inside the expression
    let mut generator = Generator::default();
    generator.declare_function("f");
    generator.declare_variable("g");
    let parsed = parse_expression("root(f(t) + cos(t), t, g, 2·g)").unwrap();
    assert_eq!(
        generator.expression(&parsed).unwrap(),
        "eq_root(t -> eq_add(f_v1(t), eq_cos(t)), g_v1, eq_mul(2.0, g_v1))"
    );
    // a sum inside the expression keeps its own binder
    assert_eq!(
        expr_with(&["c"], "root(∑[k ∈ 0..3] c·x^k, x, 0, 1)"),
        "eq_root(x -> eq_sum(k -> eq_mul(c_v1, eq_pow(x, k)), 0.0, 3.0), 0.0, 1.0)"
    );
    // the unknown shadows a sheet variable of the same name inside the expression only
    assert_eq!(
        expr_with(&["x", "y"], "root(x - y, x, 0, y)"),
        "eq_root(x -> eq_sub(x, y_v1), 0.0, y_v1)"
    );
    // with no defined guess the 2-argument form reports the undefined unknown
    assert_eq!(
        expr_with(&[], "root(x - 1, x)"),
        "eq_root(x -> eq_sub(x, 1.0), eq_error(\"x is undefined\"))"
    );
}

#[test]
fn root_is_always_the_solver_and_the_nth_root_is_the_operator() {
    // `root(z, n)` is not the n-th root: a 2-argument call is the guess form
    assert_eq!(
        expr_with(&["x"], "root(x + 1, x)"),
        "eq_root(x -> eq_add(x, 1.0), x_v1)"
    );
    assert_eq!(
        expr_with(&["y", "n"], "root(y, n)"),
        "eq_root(n -> y_v1, n_v1)"
    );
    // a binder inside the first argument does not make the call an n-th root either
    assert_eq!(
        expr_with(&["n"], "root(∑[n ∈ 1..3] n, n)"),
        "eq_root(n -> eq_sum(n -> n, 1.0, 3.0), n_v1)"
    );
    // the n-th root is the operator
    assert_eq!(expr("√[3](x)"), "eq_nthroot(x_v1, 3.0)");
}

#[test]
fn definite_integrals_bind_their_variable() {
    assert_eq!(
        expr("∫[t ∈ 0..1] t^2"),
        "eq_integral(t -> eq_pow(t, 2.0), 0.0, 1.0)"
    );
    assert_eq!(
        expr("∫[t ∈ 0..∞] e^(-t/x)"),
        "eq_integral(t -> eq_pow(2.718281828459045, eq_neg(eq_div(t, x_v1))), 0.0, Inf)"
    );
    // nested: the inner variable is bound inside the outer lambda
    assert_eq!(
        expr("∫[t ∈ 0..x] ∫[s ∈ 0..t] s"),
        "eq_integral(t -> eq_integral(s -> s, 0.0, t), 0.0, x_v1)"
    );
    // the algorithm slot is ignored
    assert_eq!(
        expr("∫[t ∈ 0..1; adaptive] t"),
        "eq_integral(t -> t, 0.0, 1.0)"
    );
}

#[test]
fn derivatives_read_the_variable_outside_and_bind_it_inside() {
    assert_eq!(expr("ⅆ[x] x^2"), "eq_derivative(x -> eq_pow(x, 2.0), x_v1)");
    assert_eq!(
        expr("∂[x] sin(x)·y"),
        "eq_derivative(x -> eq_mul(eq_sin(x), y_v1), x_v1)"
    );
    assert_eq!(
        expr("ⅆ[x^3] x^5"),
        "eq_derivative(x -> eq_pow(x, 5.0), x_v1, 3.0)"
    );
    assert_eq!(
        expr_with(&["n"], "ⅆ[x^n] x^5"),
        "eq_derivative(x -> eq_pow(x, 5.0), eq_error(\"x is undefined\"), n_v1)"
    );
}

#[test]
fn prime_derivatives_call_the_function_value() {
    let generated = regions(&["f(t) := t^2", "f′(3) =", "f′′(x) =", "sin′(x) ="]);
    assert_eq!(
        generated[1].value.as_deref(),
        Some("eq_derivative(f_v1, 3.0, 1.0)")
    );
    assert_eq!(
        generated[2].value.as_deref(),
        Some("eq_derivative(f_v1, eq_error(\"x is undefined\"), 2.0)")
    );
    assert_eq!(
        generated[3].value.as_deref(),
        Some("eq_derivative(eq_sin, eq_error(\"x is undefined\"), 1.0)")
    );
    let code = expr("g′(1, 2)");
    assert!(
        code.contains("needs one argument") || code.contains("undefined"),
        "{code}"
    );
}

#[test]
fn derivative_of_a_function_parameter_inside_a_program() {
    let code = code(
        "Newton(f, x) := program
  x ← x - f(x)/f′(x)
  x
",
    );
    assert!(code.contains("eq_derivative(f, x, 1.0)"), "{code}");
}

#[test]
fn a_dead_source_is_moved_not_copied() {
    // Buffer swap: each source is assigned anew before it is read again.
    let swap = code(
        "Swap(v) := program
  a ← v
  b ← v
  t ← a
  a ← b
  b ← t
  a[0] ← 9
  b[0] + a[0]
",
    );
    assert!(
        swap.contains("a = eq_val(v)") && swap.contains("b = eq_val(v)"),
        "{swap}"
    );
    for line in ["t = a", "a = b", "b = t"] {
        assert!(swap.contains(&format!("({line})")), "{swap}");
    }
    // A source read later is copied.
    let kept = code(
        "Keep(v) := program
  a ← v
  b ← a
  b[0] ← 5
  a[0]
",
    );
    assert!(kept.contains("b = eq_val(a)"), "{kept}");
    // A parameter is never moved, and neither is a variable that escapes into a call.
    let parameter = code(
        "Param(v) := program
  b ← v
  b[0] ← 5
  v[0]
",
    );
    assert!(parameter.contains("b = eq_val(v)"), "{parameter}");
    let escaping = code(
        "Escape(v) := program
  a ← v
  w ← identity(rows(a))
  b ← a
  b[0] ← 5
  a ← w
  b[0]
",
    );
    assert!(escaping.contains("b = eq_val(a)"), "{escaping}");
}

#[test]
fn root_argument_errors() {
    for (src, message) in [
        ("root(x)", "root takes (expression, unknown)"),
        ("root(x, y, z)", "root takes (expression, unknown)"),
        ("root(x, y, z, A, B)", "root takes (expression, unknown)"),
        ("root(8, 3)", "the second argument must be the unknown"),
        (
            "root(x + 1, 2·n)",
            "the second argument must be the unknown",
        ),
        (
            "root(x - 1, 2, 0, 1)",
            "the second argument must be the unknown",
        ),
        (
            "root(x - 1, x + 1, 0, 1)",
            "the second argument must be the unknown",
        ),
    ] {
        let code = expr(src);
        assert!(
            code.starts_with("eq_error(") && code.contains(message),
            "{src}: {code}"
        );
    }
}

#[test]
fn root_defined_by_the_worksheet_takes_precedence() {
    let generated = regions(&["root(a, b) := a + b", "root(1, 2) ="]);
    assert!(generated[0].diagnostics.is_empty());
    assert_eq!(generated[1].value.as_deref(), Some("root_v1(1.0, 2.0)"));
}

#[test]
fn root_inside_a_program_uses_the_local_as_guess() {
    let code = code(
        "Improve(L, w) := program
  w ← root(|L(w)| - 1, w)
  w
",
    );
    assert!(
        code.contains("w = eq_root(w -> eq_sub(eq_abs(L(w)), 1.0), w)"),
        "{code}"
    );
}

#[test]
fn sums_and_products() {
    assert_eq!(
        expr("∑[k ∈ 0..n] k^2"),
        "eq_sum(k -> eq_pow(k, 2.0), 0.0, n_v1)"
    );
    assert_eq!(
        expr("∏[k ∈ 1..n] x[k]"),
        "eq_prod(k -> eq_index(x_v1, k), 1.0, n_v1)"
    );
    let mut generator = Generator::default();
    generator.declare_range("i");
    let parsed = parse_expression("∑[i] i^2").unwrap();
    assert_eq!(
        generator.expression(&parsed).unwrap(),
        "eq_sum(i -> eq_pow(i, 2.0), i_v1)"
    );
}

// ----------------------------------------------------------------------------- calls

#[test]
fn builtin_and_user_calls() {
    assert_eq!(expr("rows(A)"), "eq_rows(A_v1)");
    assert_eq!(expr("Re(z)"), "eq_re(z_v1)");
    assert_eq!(expr("IsScalar(x)"), "eq_isscalar(x_v1)");
    assert_eq!(expr("atan2(x, y)"), "eq_atan2(x_v1, y_v1)");
    assert_eq!(expr("error(\"boom\")"), "eq_error(\"boom\")");
    assert_eq!(
        expr("lookup(1, A, B, \"near\")"),
        "eq_lookup(1.0, A_v1, B_v1, \"near\")"
    );
    assert_eq!(expr("norm2(A)"), "eq_norm2(A_v1)");
    assert_eq!(expr("qr(A)"), "eq_qr(A_v1)");
    assert_eq!(expr("IsNaN(x)"), "eq_isnan(x_v1)");
    assert_eq!(expr("sign(x)"), "eq_sign(x_v1)");
    assert_eq!(expr("δ(1, 2)"), "eq_δ(1.0, 2.0)");
    assert_eq!(expr("svd(A)"), "eq_svd(A_v1)");
    assert_eq!(expr("linterp(A, B, 2)"), "eq_linterp(A_v1, B_v1, 2.0)");
    assert_eq!(expr("gcd(12, 18)"), "eq_gcd(12.0, 18.0)");
    assert_eq!(expr("rnorm(5, 0, 1)"), "eq_rnorm(5.0, 0.0, 1.0)");
    assert_eq!(expr("convolve(v, A)"), "eq_convolve(v_v1, A_v1)");
    assert_eq!(expr("convol(v, A)"), "eq_convolve(v_v1, A_v1)");
    assert_eq!(expr("crosscorr(v, A, 2)"), "eq_crosscorr(v_v1, A_v1, 2.0)");
    assert_eq!(expr("deconvolve(v, z)"), "eq_deconvolve(v_v1, z_v1)");
    // The vector sum.
    assert_eq!(expr("vsum(v)"), "eq_vsum(v_v1)");
    // Reading an OpenDocument spreadsheet.
    assert_eq!(expr("READODS(\"data.ods\")"), "eq_READODS(\"data.ods\")");
    assert_eq!(
        expr("READODS(\"data.ods\", \"Data!A1:B2\", 0)"),
        "eq_READODS(\"data.ods\", \"Data!A1:B2\", 0.0)"
    );
    // READEXCEL is not implemented and says what to use instead; a worksheet
    // definition of the name still wins.
    assert_eq!(
        expr("READEXCEL(\"data.xlsx\")"),
        "eq_error(\"READEXCEL is not supported: Equavela reads OpenDocument spreadsheets with READODS\")"
    );
    let mut generator = Generator::default();
    generator.declare_function("READEXCEL");
    let parsed = parse_expression("READEXCEL(\"data.xlsx\")").unwrap();
    assert_eq!(
        generator.expression(&parsed).unwrap(),
        "READEXCEL_v1(\"data.xlsx\")"
    );
    assert_eq!(
        expr("vsum([1, 2, 3])"),
        "eq_vsum(eq_matrix(1, 3, 1.0, 2.0, 3.0))"
    );
    assert_eq!(expr("vsum(v) + 1"), "eq_add(eq_vsum(v_v1), 1.0)");
    let mut generator = Generator::default();
    generator.declare_function("f");
    generator.declare_variable("x");
    let parsed = parse_expression("f(x, 2)").unwrap();
    assert_eq!(generator.expression(&parsed).unwrap(), "f_v1(x_v1, 2.0)");
}

#[test]
fn inline_definition_arguments_are_their_value() {
    assert_eq!(
        expr("max(A ← [1, 2], 3)"),
        "eq_max(eq_matrix(1, 2, 1.0, 2.0), 3.0)"
    );
}

#[test]
fn undefined_names_and_unsupported_features_generate_error_nodes() {
    let mut generator = Generator::default();
    for (src, message) in [
        ("q", "q is undefined"),
        ("q(1)", "q is undefined"),
        ("q@unit", "q is not a unit"),
        ("foo_unit_missing@unit", "foo_unit_missing is not a unit"),
        (
            "∫[t] t",
            "indefinite (symbolic) integration is not supported yet",
        ),
        ("\\lim[t, 0] t", "limits is not supported yet"),
        ("□", "an empty placeholder cannot be evaluated"),
        ("[]", "an empty matrix cannot be evaluated"),
    ] {
        let parsed = parse_expression(src).unwrap_or_else(|e| panic!("{src}: {e:?}"));
        let text = generator.expression(&parsed).unwrap();
        assert!(
            text.contains(&format!("eq_error(\"{message}\")")),
            "{src}: {text}"
        );
    }
    assert!(generate_expression(&parse_expression("1 + 2").unwrap()).is_ok());
}

#[test]
fn julia_calls_use_the_conversion_layer() {
    // Only registered Julia functions are called: a direct package call is an error.
    assert!(expr("ControlSystems::lqr(A, B)").contains("is not registered on the worksheet"));
    let mut options = GenOptions::default();
    options.julia_imports.insert(
        "lqr".to_string(),
        JuliaImport {
            package: "ControlSystems".to_string(),
            function: "lqr".to_string(),
        },
    );
    let mut generator = Generator::new(options);
    let a = generator.declare_variable("A");
    // A Julia-qualified name can be called directly; a plain worksheet name
    // still needs a definition of its own.
    let parsed = parse_expression("julia.lqr(A)").unwrap();
    assert_eq!(
        generator.expression(&parsed).unwrap(),
        format!("eq_julia_call(ControlSystems.lqr, {a})")
    );
    let plain = parse_expression("lqr(A)").unwrap();
    assert!(generator.expression(&plain).unwrap().contains("eq_error"));
    let sheet = Worksheet {
        regions: vec![region("a", 0.0, "LQR(A, B) := julia.lqr")],
    };
    let mut options = GenOptions::default();
    options.julia_imports.insert(
        "lqr".to_string(),
        JuliaImport {
            package: "ControlSystems".to_string(),
            function: "lqr".to_string(),
        },
    );
    let generated = generate_worksheet(&sheet, options).unwrap();
    assert_eq!(
        generated.regions[0].code,
        "LQR_v1 = let\n    LQR_v1(A, B) = eq_julia_call(ControlSystems.lqr, A, B)\n    LQR_v1\nend"
    );
    assert!(generated
        .script()
        .starts_with("using EqRuntime\nimport ControlSystems\n"));
}

// ----------------------------------------------------------------------------- names

#[test]
fn mangling_is_reversible() {
    let names = [
        Name::plain("x"),
        Name::plain("η"),
        Name::sub("F", "max"),
        Name::sub("η", "p.max"),
        Name::plain("indici_colonne"),
        Name::plain(".5x"),
        Name::plain("⊗"),
        Name::plain("end"),
        Name::plain("mc"),
        Name {
            segments: vec![
                Segment {
                    text: "H".into(),
                    subscript: false,
                },
                Segment {
                    text: "2".into(),
                    subscript: true,
                },
                Segment {
                    text: "SO".into(),
                    subscript: false,
                },
                Segment {
                    text: "4".into(),
                    subscript: true,
                },
            ],
            label: None,
        },
        Name::plain("µ"),
        Name::plain("3d"),
        Name::sub("mc", "sort"),
    ];
    for name in &names {
        let ident = local_ident(name);
        assert!(!ident.contains("__"), "{ident}");
        let (segments, version) = demangle_ident(&ident).unwrap_or_else(|| panic!("{ident}"));
        assert_eq!(segments, name.segments, "{ident}");
        assert_eq!(version, None);
        let sheet = worksheet_ident(name, 7);
        let (segments, version) = demangle_ident(&sheet).unwrap();
        assert_eq!(segments, name.segments, "{sheet}");
        assert_eq!(version, Some(7));
    }
    assert_eq!(local_ident(&Name::sub("F", "max")), "F_smax");
    assert_eq!(local_ident(&Name::plain("a_b")), "a_5f_b");
    assert_eq!(local_ident(&Name::plain("end")), "end_k");
    // The runtime names the generator reads as calls cannot be Julia locals either.
    assert_eq!(local_ident(&Name::plain("tol")), "tol_k");
    assert_eq!(local_ident(&Name::plain("ctol")), "ctol_k");
    assert_eq!(local_ident(&Name::plain("origin")), "origin_k");
    assert_eq!(local_ident(&Name::sub("eq", "sort")), "eq_ssort_k");
    assert_eq!(local_ident(&Name::plain("3d")), "_33_d");
    // Distinct names stay distinct.
    let mut seen = std::collections::HashSet::new();
    for name in &names {
        assert!(seen.insert(local_ident(name)), "{name:?}");
    }
}

#[test]
fn subscripted_and_unicode_names() {
    assert_eq!(expr_with(&["σ"], "σ + 1"), "eq_add(σ_v1, 1.0)");
    let mut generator = Generator::default();
    let statement = parse_statement("F_max := 3").unwrap();
    let region = generator.region("a", &statement);
    assert_eq!(region.code, "F_smax_v1 = 3.0");
    assert_eq!(region.defined, ["F_smax_v1"]);
}

// ------------------------------------------------------------------ region statements

#[test]
fn definitions_version_redefined_names() {
    let regions = regions(&["x := 1", "y := x + 1", "x := x + 10", "z := x + y"]);
    assert_eq!(regions[0].code, "x_v1 = 1.0");
    assert_eq!(regions[1].code, "y_v1 = eq_add(x_v1, 1.0)");
    assert_eq!(regions[2].code, "x_v2 = eq_add(x_v1, 10.0)");
    assert_eq!(regions[3].code, "z_v1 = eq_add(x_v2, y_v1)");
}

#[test]
fn evaluations_are_values() {
    let regions = regions(&["x := 1", "x + 1 =", "y := x·2 =", "x + 1"]);
    assert_eq!(regions[1].code, "");
    assert_eq!(regions[1].value.as_deref(), Some("eq_add(x_v1, 1.0)"));
    assert_eq!(regions[2].code, "y_v1 = eq_mul(x_v1, 2.0)");
    assert_eq!(regions[2].value.as_deref(), Some("y_v1"));
    assert_eq!(regions[3].code, "");
    assert_eq!(regions[3].value, None);
}

#[test]
fn aliasing_definitions_copy_the_array() {
    let regions = regions(&["A := [1, 2]", "B := A", "C := A + 1", "D := A[0]"]);
    assert_eq!(regions[1].code, "B_v1 = eq_val(A_v1)");
    assert_eq!(regions[2].code, "C_v1 = eq_add(A_v1, 1.0)");
    assert_eq!(regions[3].code, "D_v1 = eq_val(eq_index(A_v1, 0.0))");
}

#[test]
fn function_definitions() {
    let regions = regions(&[
        "k := 2",
        "f(a, b) := a·k + b",
        "f(1, 2) =",
        "g(n) := if(n < 1, 1, n·g(n - 1))",
    ]);
    assert_eq!(
        regions[1].code,
        "f_v1 = let\n    f_v1(a, b) = eq_add(eq_mul(a, k_v1), b)\n    f_v1\nend"
    );
    assert_eq!(regions[2].value.as_deref(), Some("f_v1(1.0, 2.0)"));
    // Recursion refers to the function being defined.
    assert_eq!(
        regions[3].code,
        "g_v1 = let\n    g_v1(n) = eq_if(eq_lt(n, 1.0), () -> 1.0, () -> eq_mul(n, g_v1(eq_sub(n, 1.0))))\n    g_v1\nend"
    );
}

#[test]
fn indexed_worksheet_assignment_copies_and_uses_the_worksheet_setter() {
    let regions = regions(&[
        "x := [1; 2; 3]",
        "x[1] := 10",
        "x⟨0⟩ := [4; 5; 6]",
        "[p, q] := [1, 2]",
        "w[2] := 5",
    ]);
    assert_eq!(
        regions[1].code,
        "x_v2 = eq_sheet_setindex!(eq_val(x_v1), 10.0, 1.0)"
    );
    assert_eq!(
        regions[2].code,
        "x_v3 = eq_setcol!(eq_val(x_v2), eq_matrix(3, 1, 4.0, 5.0, 6.0), 0.0)"
    );
    assert_eq!(
        regions[3].code,
        "__t1, __t2 = eq_unpack(eq_matrix(1, 2, 1.0, 2.0), 1, 2)\np_v1 = __t1\nq_v1 = __t2"
    );
    // An undefined array grows from `nothing`.
    assert_eq!(
        regions[4].code,
        "w_v1 = eq_sheet_setindex!(nothing, 5.0, 2.0)"
    );
}

#[test]
fn destructuring_into_elements_of_one_name_creates_one_version() {
    let regions = regions(&["X := [0; 0; 0]", "[X[0], X[1]] := [7, 8]"]);
    assert_eq!(
        regions[1].code,
        "__t1, __t2 = eq_unpack(eq_matrix(1, 2, 7.0, 8.0), 1, 2)\n\
         X_v2 = eq_sheet_setindex!(eq_val(X_v1), __t1, 0.0)\n\
         X_v2 = eq_sheet_setindex!(X_v2, __t2, 1.0)"
    );
}

#[test]
fn a_destructuring_cell_that_is_a_matrix_unpacks_one_level() {
    //  (GitHub ): each level is one `eq_unpack`, the inner one on the value the
    // outer level handed to the cell, in reading order.
    let regions = regions(&["M := [[1, 2], [3; 4]]", "[a, [b, c]; d, [e, [f]]] := M"]);
    assert_eq!(
        regions[1].code,
        "__t1, __t2, __t3, __t4 = eq_unpack(eq_val(M_v1), 2, 2)\n\
         a_v1 = __t1\n\
         __t5, __t6 = eq_unpack(__t2, 1, 2)\n\
         b_v1 = __t5\n\
         c_v1 = __t6\n\
         d_v1 = __t3\n\
         __t7, __t8 = eq_unpack(__t4, 1, 2)\n\
         e_v1 = __t7\n\
         (__t9,) = eq_unpack(__t8, 1, 1)\n\
         f_v1 = __t9"
    );
    // In a program, the last cell in reading order carries the value of the statement.
    let text = code("S(M) := program\n  [x, [y, z]] ← M\n  x");
    assert!(
        text.contains(
            "            __t1, __t2 = eq_unpack(eq_val(M), 1, 2)\n            x = __t1\n            \
             __t3, __t4 = eq_unpack(__t2, 1, 2)\n            y = __t3\n            __v = (z = __t4)\n"
        ),
        "{text}"
    );
    // The target of an inline argument definition is its value and binds nothing.
    assert_eq!(
        expr_with(&["f", "x"], "f(x, [A, B] ← [1, 2])"),
        "f_v1(x_v1, eq_matrix(1, 2, 1.0, 2.0))"
    );
    assert_eq!(expr_with(&["f", "v"], "f([x, [y, z]] ← v)"), "f_v1(v_v1)");
}

#[test]
fn ranges_and_iterated_assignment() {
    let regions = regions(&[
        "i := 0..3",
        "k := 0, 0.5..2",
        "i =",
        "i^2 =",
        "y[i] := y[i - 1] + 1",
        "z⟨i⟩ := i",
    ]);
    assert_eq!(regions[0].code, "i_v1 = eq_range(0.0, 3.0)");
    assert_eq!(regions[1].code, "k_v1 = eq_range(0.0, 0.5, 2.0)");
    assert_eq!(regions[2].value.as_deref(), Some("eq_collect(i_v1)"));
    assert_eq!(
        regions[3].value.as_deref(),
        Some("eq_map_range(i_v1 -> eq_pow(i_v1, 2.0), i_v1)")
    );
    assert_eq!(
        regions[4].code,
        "y_v1 = eq_iter_setindex(eq_val(nothing), i_v1, (y_v1, i_v1) -> eq_add(eq_index(y_v1, eq_sub(i_v1, 1.0)), 1.0))"
    );
    assert_eq!(
        regions[5].code,
        "z_v1 = eq_iter_setcol(eq_val(nothing), i_v1, (z_v1, i_v1) -> eq_val(i_v1))"
    );
}

#[test]
fn unsupported_regions_generate_error_nodes_and_diagnostics() {
    let regions = regions(&["x := 2", "x →", "s := x →[simplify]", "ORIGIN := 1"]);
    // Symbolic regions run through the `symbolic` request: no Julia, no diagnostics.
    assert!(regions[1].code.is_empty());
    assert_eq!(regions[1].value, None);
    assert!(regions[1].diagnostics.is_empty());
    // A name defined by a symbolic result is a placeholder until the session has the
    // result; the region records the identifier to redefine.
    assert_eq!(regions[2].code, "s_v1 = nothing");
    let target = regions[2].symbolic_target.as_ref().unwrap();
    assert_eq!(target.ident, "s_v1");
    assert!(target.params.is_none());
    assert!(regions[3]
        .code
        .contains("ORIGIN is set in Calculate > Calculation Settings"));
}

// ------------------------------------------------------------------------------- units

#[test]
fn unit_names_go_through_eq_unit() {
    // a unit is a labelled name, so the text carries `@unit`
    assert_eq!(expr("3.5 m@unit"), "eq_mul(3.5, eq_unit(\"m\"))");
    let degrees = parse_expression("90 °@unit").unwrap();
    assert_eq!(print_expression(&degrees), "90 °@unit");
    assert_eq!(expr("90 °@unit"), "eq_mul(90.0, eq_unit(\"°\"))");
    // the sign of a temperature belongs to the number in front of °C or °F.
    assert_eq!(expr("20 °C@unit"), "eq_mul(20.0, eq_unit(\"°C\"))");
    assert_eq!(expr("-300 °C@unit"), "eq_mul(-300.0, eq_unit(\"°C\"))");
    assert_eq!(
        expr("-(300) °C@unit"),
        "eq_mul(eq_neg(300.0), eq_unit(\"°C\"))"
    );
    assert_eq!(
        expr("9.81 m@unit/s@unit^2"),
        "eq_mul(9.81, eq_div(eq_unit(\"m\"), eq_pow(eq_unit(\"s\"), 2.0)))"
    );
    assert_eq!(
        expr("kg@unit·m@unit/s@unit^2"),
        "eq_mul(eq_unit(\"kg\"), eq_div(eq_unit(\"m\"), eq_pow(eq_unit(\"s\"), 2.0)))"
    );
    assert_eq!(
        expr("12 kN@unit/m@unit"),
        "eq_mul(12.0, eq_div(eq_unit(\"kN\"), eq_unit(\"m\")))"
    );
    assert_eq!(expr("0·m@unit"), "eq_mul(0.0, eq_unit(\"m\"))");
    assert_eq!(expr("m@unit"), "eq_unit(\"m\")");
    assert_eq!(expr("5 deg@unit"), "eq_mul(5.0, eq_unit(\"deg\"))");
    // an expression of units and variables
    assert_eq!(expr("x·km@unit"), "eq_mul(x_v1, eq_unit(\"km\"))");
    // no unit table in the generated code: only names reach EqRuntime
    assert!(!expr("3 ft@unit + 2 yd@unit").contains("u\""));
    // an unlabelled name is never a unit: it is an ordinary name, here undefined
    assert!(expr("3.5 m").contains("m is undefined"));
    assert!(expr("km").contains("km is undefined"));
}

#[test]
fn only_the_explicit_label_makes_a_unit() {
    // a plain name is a name (a definition wins, as before, because it is a name),
    // and the labelled name is the unit
    let regions = regions(&["m := 5", "m =", "m@unit =", "3 m =", "3 m@unit ="]);
    assert_eq!(regions[1].value.as_deref(), Some("m_v1"));
    assert_eq!(regions[2].value.as_deref(), Some("eq_unit(\"m\")"));
    assert_eq!(regions[3].value.as_deref(), Some("eq_mul(3.0, m_v1)"));
    assert_eq!(
        regions[4].value.as_deref(),
        Some("eq_mul(3.0, eq_unit(\"m\"))")
    );
    // constants are not units: `e` is Euler's number, `h` is not the hour
    assert_eq!(expr("e"), "2.718281828459045");
    assert_eq!(expr("h"), "eq_constant(\"h\")");
    assert!(expr("foo").contains("foo is undefined"));
    // a spelling that is both a built-in function and a unit reads as the function, so the
    // minute is `min@unit`; a call still reaches the function
    assert_eq!(expr("min(1, 2)"), "eq_min(1.0, 2.0)");
    assert_eq!(expr("60 min"), "eq_mul(60.0, eq_min)");
    assert_eq!(expr("60 min@unit"), "eq_mul(60.0, eq_unit(\"min\"))");
    assert_eq!(expr("5 sec@unit"), "eq_mul(5.0, eq_unit(\"sec\"))");
    // neither a unit nor a function is callable through a plain name
    assert!(expr("m(2)").contains("m is undefined"));
    // a local and a parameter hide the unit of the same spelling; the label still reaches it
    assert!(code("f(m) := 2·m").contains("eq_mul(2.0, m)"));
    assert!(code("f(m) := 2·m@unit").contains("eq_mul(2.0, eq_unit(\"m\"))"));
}

#[test]
fn unit_override_is_a_display_unit_and_leaves_the_value_alone() {
    // the value position carries the label, the unit context (after `…`) stays plain
    let regions = regions(&[
        "x := 3 m@unit",
        "x + 1 m@unit = … km",
        "x = … m/s",
        "y := 8 m@unit/s@unit = … km/hr",
        "m := 2",
        "x = … m/min",
    ]);
    // the value expression is exactly the one without the override
    assert_eq!(
        regions[1].value.as_deref(),
        Some("eq_add(x_v1, eq_mul(1.0, eq_unit(\"m\")))")
    );
    let unit = regions[1].display_unit.as_ref().unwrap();
    assert_eq!(unit.code, "eq_unit(\"km\")");
    assert_eq!(unit.text, "km");
    let unit = regions[2].display_unit.as_ref().unwrap();
    assert_eq!(unit.code, "eq_div(eq_unit(\"m\"), eq_unit(\"s\"))");
    assert_eq!(unit.text, "m/s");
    // define and show with an override: the value is the definition, the unit is separate
    assert_eq!(regions[3].value.as_deref(), Some("y_v1"));
    assert_eq!(
        regions[3].display_unit.as_ref().unwrap().code,
        "eq_div(eq_unit(\"km\"), eq_unit(\"hr\"))"
    );
    assert!(regions[0].display_unit.is_none());
    // every plain name of a unit context is a unit, even when a variable `m` exists (and the
    // builtin `min` is a function)
    let unit = regions[5].display_unit.as_ref().unwrap();
    assert_eq!(unit.code, "eq_div(eq_unit(\"m\"), eq_unit(\"min\"))");
    assert!(regions.iter().all(|r| r.diagnostics.is_empty()));
    // a label inside a unit context means the same as no label
    let labelled = self::regions(&["x := 3 m@unit", "x = … m@unit/s@unit"]);
    let unit = labelled[1].display_unit.as_ref().unwrap();
    assert_eq!(unit.code, "eq_div(eq_unit(\"m\"), eq_unit(\"s\"))");
    let unit = regions[2].display_unit.as_ref().unwrap();
    assert_eq!(unit.text, "m/s");
    // a plain name in a unit context that is not a unit is the error of the slot
    let bad = self::regions(&["x = … foo"]);
    let unit = bad[0].display_unit.as_ref().unwrap();
    assert!(unit.code.contains("foo is not a unit"), "{}", unit.code);
    // the unit does not leak into the next region
    let next = self::regions(&["z := 1 = … m", "w := 2 ="]);
    assert!(next[1].display_unit.is_none());
}

#[test]
fn unit_override_with_a_failing_value_has_no_unit_and_an_error_value() {
    let regions = regions(&["q = … m"]);
    assert!(regions[0]
        .value
        .as_deref()
        .unwrap()
        .contains("q is undefined"));
}

#[test]
fn structural_errors_become_error_regions_that_still_define_their_names() {
    let mut generator = Generator::default();
    let statement = parse_statement("f(x) := program\n  □\n").unwrap();
    let region = generator.region("bad", &statement);
    // A placeholder statement is an evaluation error, not a generator failure.
    assert!(region
        .code
        .contains("eq_error(\"an empty placeholder cannot be evaluated\")"));
}

// ----------------------------------------------------------------------------- programs

const SUM_PROGRAM: &str = "S(n) := program
  s ← 0
  for i ∈ 0..n
    if i == 2
      continue
    s ← s + i
  s
";

#[test]
fn program_with_loop_and_continue() {
    assert_eq!(
        code(SUM_PROGRAM),
        "\
S_v1 = let
    function S_v1(n)
        local s = nothing
        local i = nothing
        local __v = nothing
        local __s = 0
        try
            __s = 1
            __v = (s = 0.0)
            __s = 2
            for __i in eq_for_items(eq_range(0.0, n))
                i = __i
                __s = 3
                if eq_true(eq_eq(i, 2.0))
                    continue
                end
                __s = 4
                __v = (s = eq_add(s, i))
            end
            __s = 5
            __v = s
            return eq_result(__v)
        catch __e
            throw(eq_locate(__e, __s))
        end
    end
    S_v1
end"
    );
}

#[test]
fn statement_locations_map_ids_to_spans() {
    let sheet = Worksheet {
        regions: vec![Region {
            id: "p".into(),
            page: 0,
            x: 0.0,
            y: 0.0,
            enabled: true,
            statement: std::sync::Arc::new(parse_statement(SUM_PROGRAM).unwrap()),
        }],
    };
    let generated = generate_worksheet(&sheet, GenOptions::default()).unwrap();
    assert_eq!(generated.statements.len(), 5);
    let first = &generated.statements[0];
    assert_eq!((first.id, first.region_id.as_str()), (1, "p"));
    let text = &SUM_PROGRAM[first.span.range()];
    assert_eq!(text, "s ← 0");
}

#[test]
fn program_if_else_and_also_if() {
    let text = code(
        "h(x) := program
  if x > 1
    y ← 1
  else if x > 0
    y ← 2
  else
    y ← 3
  y
",
    );
    assert!(text.contains(
        "if eq_true(eq_gt(x, 1.0))\n                __s = 2\n                __v = (y = 1.0)\n            elseif eq_true(eq_gt(x, 0.0))\n"
    ), "{text}");
    assert!(
        text.contains(
            "            else\n                __s = 4\n                __v = (y = 3.0)\n            end\n"
        ),
        "{text}"
    );
    // `y` is assigned on every path, so the final read is plain.
    assert!(text.contains("__v = y\n"), "{text}");

    let text = code(
        "h(x) := program
  if x > 1
    y ← 1
  also if x > 2
    y ← 2
  else
    y ← 3
  y
",
    );
    assert!(text.contains("local __ran1 = false"), "{text}");
    assert!(text.contains("            __ran1 = true\n"), "{text}");
    assert!(text.contains("if !__ran1\n"), "{text}");
}

#[test]
fn program_reads_that_may_precede_assignment_use_eq_local() {
    let text = code(
        "h(x) := program
  if x > 1
    y ← 1
  y
",
    );
    assert!(text.contains("__v = eq_local(y, \"y\")"), "{text}");
}

#[test]
fn local_named_like_a_sheet_variable_is_initialised_from_it() {
    let text = regions(&["X := 5", "f(n) := program\n  X ← X + n\n  X\n"])
        .remove(1)
        .code;
    // the read before the assignment sees the sheet value; the local starts empty.
    assert!(text.contains("local X = nothing"), "{text}");
    assert!(
        text.contains("__v = (X = eq_add(eq_local_or(X, X_v1), n))"),
        "{text}"
    );
}

/// an element assignment to a local that has the name of a sheet array starts a new
/// array; it does not copy the sheet array.
#[test]
fn element_assignment_to_a_sheet_name_starts_a_new_local() {
    let text = regions(&["ND := [1; 2; 3]", "f(n) := program\n  ND[0] ← n\n  ND\n"])
        .remove(1)
        .code;
    assert!(text.contains("local ND = nothing"), "{text}");
    assert!(!text.contains("eq_val(ND_v1)"), "{text}");
    // A read after an assignment that may not have run (inside a loop) is the local once
    // assigned, the sheet value before.
    let text = regions(&[
        "ND := [1; 2; 3]",
        "f(n) := program\n  for k ∈ 0..n\n    ND[k] ← k\n  ND\n",
    ])
    .remove(1)
    .code;
    assert!(text.contains("local ND = nothing"), "{text}");
    assert!(text.contains("eq_local_or(ND, ND_v1)"), "{text}");
}

#[test]
fn program_assignments_into_arrays_and_parameters() {
    let text = code(
        "f(L, n) := program
  L[1, 2] ← n
  w⟨1⟩ ← [1; 2]
  v⟪0⟫ ← [3, 4]
  (L[0])[1] ← n
  [a, b[0]] ← L
  L
",
    );
    assert!(
        text.contains("        L = eq_val(L)\n        local __o = origin()\n"),
        "{text}"
    );
    assert!(
        text.contains("__v = (L = eq_setindex_o!(L, eq_val(n), 1.0, 2.0, __o))"),
        "{text}"
    );
    assert!(
        text.contains("__v = (w = eq_setcol!(w, eq_matrix(2, 1, 1.0, 2.0), 1.0))"),
        "{text}"
    );
    assert!(
        text.contains("__v = (v = eq_setrow!(v, eq_matrix(1, 2, 3.0, 4.0), 0.0))"),
        "{text}"
    );
    assert!(
        text.contains(
            "__t1 = eq_val(eq_index(L, 0.0))\n            __t1 = eq_setindex_o!(__t1, eq_val(n), 1.0, __o)\n            __v = (L = eq_setindex_o!(L, __t1, 0.0, __o))"
        ),
        "{text}"
    );
    assert!(
        text.contains("__t2, __t3 = eq_unpack(eq_val(L), 1, 2)\n            a = __t2\n            __v = (b = eq_setindex_o!(b, __t3, 0.0, __o))"),
        "{text}"
    );
}

#[test]
fn program_while_break_and_return() {
    let text = code(
        "f(n) := program
  k ← 0
  while k < n
    k ← k + 1
    if k > 10
      break
  if k > 100
    return \"big\"
  k
",
    );
    assert!(text.contains("while eq_true(eq_lt(k, n))"), "{text}");
    assert!(text.contains("            break\n"), "{text}");
    assert!(text.contains("return \"big\"\n"), "{text}");
}

#[test]
fn break_outside_a_loop_is_an_error_statement() {
    let text = code("f(n) := program\n  break\n  n\n");
    assert!(
        text.contains("eq_error(\"break outside a loop\")"),
        "{text}"
    );
}

#[test]
fn try_forms() {
    // Expression-only bodies use eq_try.
    let text = code("f(n) := program\n  try\n    error(\"boom\")\n  on error\n    n\n  n\n");
    assert!(
        text.contains("__v = eq_try(() -> eq_error(\"boom\"), () -> n)"),
        "{text}"
    );
    // Control flow in the handler needs the inline form.
    let text = code(
        "Inside(a, A) := program
  try
    match(a, A)
  on error
    return 0
  1
",
    );
    assert!(
        text.contains(
            "try\n                __s = 2\n                __v = eq_match(a, A)\n            catch __e\n                eq_caught(__e)\n                __s = 3\n                return 0.0\n            end"
        ),
        "{text}"
    );
}

#[test]
fn a_local_function_is_a_closure_of_the_program() {
    // the name is a local of the program
    // and its body becomes a closure assigned to it, so the body runs only when it is called.
    assert_eq!(
        code(
            "Z(A, Q, T) := program
  g(x) ← x^2 + Q
  g(A)
"
        ),
        "\
Z_v1 = let
    function Z_v1(A, Q, T)
        local g = nothing
        local __v = nothing
        local __s = 0
        try
            __s = 1
            g = (x) -> eq_add(eq_pow(x, 2.0), Q)
            __s = 2
            __v = g(A)
            return eq_result(__v)
        catch __e
            throw(eq_locate(__e, __s))
        end
    end
    Z_v1
end"
    );
}

#[test]
fn a_local_function_body_may_be_a_program_and_calls_itself() {
    let text = code(
        "F(n) := program
  g(x) ← program
    if x ≤ 1
      1
    else
      x·g(x - 1)
  g(n)
",
    );
    // The parameters of the head are the locals the body program starts with.
    assert!(text.contains("        g = function (x)\n"), "{text}");
    assert!(text.contains("                __v = 1.0\n"), "{text}");
    // The recursive call is a call of the same local.
    assert!(
        text.contains("__v = eq_mul(x, g(eq_sub(x, 1.0)))"),
        "{text}"
    );
    assert!(text.contains("        __v = g(n)\n"), "{text}");
}

#[test]
fn a_local_function_is_declared_once_and_contributes_no_value() {
    // The definition statement evaluates nothing: it neither sets `__v` nor the program's value.
    let text = code("h(x) := program\n  f(y) ← y + 1\n  x\n");
    assert_eq!(text.matches("local f = nothing").count(), 1, "{text}");
    assert!(
        text.contains("__s = 1\n            f = (y) -> eq_add(y, 1.0)\n"),
        "{text}"
    );
    assert!(!text.contains("__v = (f ="), "{text}");
    // One local per name: a value definition of the same name reuses the declaration.
    let text = code("h(x) := program\n  z ← 2\n  z(n) ← n + 1\n  z(x)\n");
    assert_eq!(text.matches("local z = nothing").count(), 1, "{text}");
    assert!(text.contains("__v = (z = 2.0)\n"), "{text}");
    assert!(text.contains("z = (n) -> eq_add(n, 1.0)\n"), "{text}");
}

#[test]
fn a_local_function_shadowing_a_sheet_function_is_a_local_call() {
    let generated = regions(&["f(y) := y·10", "h(x) := program\n  f(y) ← y + 1\n  f(x)\n"]);
    let text = &generated[1].code;
    assert!(text.contains("local f = nothing"), "{text}");
    assert!(text.contains("__v = f(x)\n"), "{text}");
}

#[test]
fn nested_programs_are_closures() {
    let text = code(
        "z := program
  if a < 3
    for i ∈ 0..10
      x[i] ← 3 + i
  x
",
    );
    assert!(text.starts_with("z_v1 = (() -> begin\n"), "{text}");
    assert!(text.ends_with("end)()"), "{text}");
    assert!(text.contains("local x = nothing"), "{text}");
    assert!(text.contains("__v = eq_local(x, \"x\")"), "{text}");
}

#[test]
fn empty_program_bodies_are_errors() {
    let mut generator = Generator::default();
    let region = generator.region(
        "e",
        &parse_statement("f(x) := program\n  if x\n    1\n").unwrap(),
    );
    assert!(region.code.contains("f_v1"), "{}", region.code);
    // Build an empty body by hand: the parser never produces one.
    use equavela_core::ast::*;
    let empty = Statement::synth(StatementKind::Define {
        target: Target::synth(TargetKind::FunctionHead {
            name: Ident::new(Name::plain("g")),
            params: vec![],
        }),
        rhs: Expr::synth(ExprKind::Program { body: vec![] }),
        tail: None,
    });
    let region = generator.region("empty", &empty);
    assert!(region
        .code
        .contains("g_v1 = eq_error(\"a program needs at least one statement\")"));
    assert_eq!(region.diagnostics.len(), 1);
}

// --------------------------------------------------------------------------- worksheets

fn region(id: &str, y: f64, math: &str) -> Region {
    Region {
        id: id.to_string(),
        page: 0,
        x: 0.0,
        y,
        enabled: true,
        statement: std::sync::Arc::new(parse_statement(math).unwrap()),
    }
}

#[test]
fn worksheet_orders_regions_and_installs_globals_first() {
    let sheet = Worksheet {
        regions: vec![
            region("use", 0.0, "y := g + 1"),
            region("def", 1.0, "g ≡ 5"),
            region("local", 2.0, "g := 7"),
            region("after", 3.0, "h := g"),
        ],
    };
    let generated = generate_worksheet(&sheet, GenOptions::default()).unwrap();
    let codes: Vec<(&str, &str)> = generated
        .regions
        .iter()
        .map(|r| (r.id.as_str(), r.code.as_str()))
        .collect();
    assert_eq!(
        codes,
        [
            ("def", "g_v1 = 5.0"),
            ("use", "y_v1 = eq_add(g_v1, 1.0)"),
            ("local", "g_v2 = 7.0"),
            ("after", "h_v1 = eq_val(g_v2)"),
        ]
    );
}

#[test]
fn script_collects_values() {
    let sheet = Worksheet {
        regions: vec![region("a", 0.0, "x := 2"), region("b", 1.0, "x + 1 =")],
    };
    let script = generate_worksheet(&sheet, GenOptions::default())
        .unwrap()
        .script();
    assert!(script.starts_with("using EqRuntime\n"), "{script}");
    assert!(script.contains("x_v1 = 2.0\n"));
    assert!(
        script.contains("__results[\"b\"] = try\n    eq_add(x_v1, 1.0)\ncatch __e\n    __e\nend\n")
    );
}

// ------------------------------------------------------------------------------ end to end

mod end_to_end {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf()
    }

    fn julia_available() -> bool {
        Command::new("julia")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Runs the generated script and returns `id -> printed value` (`ERROR: ...` for errors).
    fn run(
        sources: &[&str],
    ) -> Option<(
        Vec<(String, String)>,
        equavela_core::codegen::GeneratedWorksheet,
    )> {
        run_with_units(sources).map(|(results, _, generated)| (results, generated))
    }

    /// Like [`run`], also returning the printed display units (`id -> unit`).
    #[allow(clippy::type_complexity)]
    fn run_with_units(
        sources: &[&str],
    ) -> Option<(
        Vec<(String, String)>,
        Vec<(String, String)>,
        equavela_core::codegen::GeneratedWorksheet,
    )> {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return None;
        }
        let sheet = Worksheet {
            regions: sources
                .iter()
                .enumerate()
                .map(|(i, src)| region(&format!("r{i:03}"), i as f64, src))
                .collect(),
        };
        let generated = generate_worksheet(&sheet, GenOptions::default()).unwrap();
        let mut script = generated.script();
        script.push_str(
            "for (k, v) in sort(collect(__results); by=first)\n\
             \x20   println(k, \"\\t\", v isa Exception ? \"ERROR: \" * sprint(showerror, v) : repr(v))\n\
             end\n\
             for (k, v) in sort(collect(__units); by=first)\n\
             \x20   println(\"unit:\", k, \"\\t\", v isa Exception ? \"ERROR: \" * sprint(showerror, v) : repr(v))\n\
             end\n",
        );
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = repo_root().join("target").join("codegen-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!(
            "case-{}-{}.jl",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::write(&path, &script).unwrap();
        let output = Command::new("julia")
            .arg(format!(
                "--project={}",
                repo_root().join("kernel/EqRuntime").display()
            ))
            .arg(&path)
            .output()
            .expect("run julia");
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        assert!(
            output.status.success(),
            "julia failed:\n{}\n--- script ---\n{script}",
            String::from_utf8_lossy(&output.stderr)
        );
        let _ = std::fs::remove_file(&path);
        let all: Vec<(String, String)> = stdout
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let (units, results): (Vec<_>, Vec<_>) = all
            .into_iter()
            .partition(|(key, _)| key.starts_with("unit:"));
        let units = units
            .into_iter()
            .map(|(key, value)| (key["unit:".len()..].to_string(), value))
            .collect();
        Some((results, units, generated))
    }

    /// The printed value of the last displayed region.
    fn last(sources: &[&str]) -> Option<String> {
        run(sources).map(|(results, _)| results.last().unwrap().1.clone())
    }

    /// Parses a printed Julia number or matrix (`[1.0 2.0; 3.0 4.0]`) into rows.
    fn numbers(text: &str) -> Vec<Vec<f64>> {
        let inner = text.trim().trim_start_matches('[').trim_end_matches(']');
        inner
            .trim_end_matches(';')
            .split(';')
            .map(|row| {
                row.split_whitespace()
                    .map(|n| {
                        n.parse::<f64>()
                            .unwrap_or_else(|_| panic!("number `{n}` in `{text}`"))
                    })
                    .collect()
            })
            .collect()
    }

    fn assert_close(text: &str, expected: &[&[f64]], rtol: f64) {
        let got = numbers(text);
        assert_eq!(got.len(), expected.len(), "{text}");
        for (got_row, expected_row) in got.iter().zip(expected) {
            assert_eq!(got_row.len(), expected_row.len(), "{text}");
            for (g, e) in got_row.iter().zip(*expected_row) {
                assert!(
                    (g - e).abs() <= 1e-12 + rtol * e.abs(),
                    "{g} != {e} in {text}"
                );
            }
        }
    }

    #[test]
    fn expression_type_worksheet_calls() {
        let Some((results, _)) = run(&[
            "IsFunction(sin) =",
            "IsFunction(1) =",
            "IsRange(2) =",
            "IsRange([0,1,2,3]) =",
            "SIUnitsOf(2*km@unit)/m@unit =",
        ]) else {
            return;
        };
        for (result, expected) in results.iter().zip([1.0, 0.0, 0.0, 0.0, 1.0]) {
            assert_close(&result.1, &[&[expected]], 1e-12);
        }
        if let Some(value) = last(&["i := 0..3", "IsRange((i)) ="]) {
            assert_eq!(value, "1.0");
        }
        if let Some(value) = last(&["i := 0..3", "IsFunction(i) ="]) {
            assert_eq!(value, "0.0");
        }
    }

    #[test]
    fn fourier_and_special_functions_worksheet_calls() {
        let Some((results, _)) = run(&[
            "Re(idft(dft([1,2;3,4]))) =",
            "idftr(dftr([1,2,3,4])) =",
            "Re(icfft(cfft([1,2,3,4]))) =",
            "iwave(wave([1;2;3;4])) =",
            "Jn(0,1) =",
            "J0.sc(1) =",
            "Γ(5) =",
            "Γ(2,1) =",
            "lnΓ(5) =",
            "ibeta(0.5,2,3) =",
            "mhyper(1,1,1) =",
            "Jac(2,0,0,0.5) =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[1.0, 2.0], &[3.0, 4.0]], 1e-11);
        for result in &results[1..3] {
            assert_close(&result.1, &[&[1.0, 2.0, 3.0, 4.0]], 1e-11);
        }
        assert_close(&results[3].1, &[&[1.0], &[2.0], &[3.0], &[4.0]], 1e-11);
        for (result, expected) in results[4..].iter().zip([
            0.7651976865579666,
            0.7651976865579666,
            24.0,
            2.0 / 1.0f64.exp(),
            24.0f64.ln(),
            0.6875,
            1.0f64.exp(),
            -0.125,
        ]) {
            assert_close(&result.1, &[&[expected]], 1e-11);
        }
    }

    #[test]
    fn ods_file_worksheet_round_trip() {
        let path = std::env::temp_dir().join(format!("equavela-ods-{}.ods", std::process::id()));
        let quoted = serde_json::to_string(path.to_str().unwrap()).unwrap();
        let written = format!("WRITEODS({quoted}, [1,2;3,4]) =");
        let read = format!("READFILE({quoted}, \"ODS\") =");
        let evaluated = run(&[&written, &read]);
        let _ = std::fs::remove_file(path);
        if let Some((results, _)) = evaluated {
            assert_close(&results[0].1, &[&[0.0]], 1e-12);
            assert_close(&results[1].1, &[&[1.0, 2.0], &[3.0, 4.0]], 1e-12);
        }
    }

    #[test]
    fn data_analysis_worksheet_calls() {
        let Some((results, _)) = run(&[
            "hist([0,1,2], [0,1,2]) =",
            "histogram([0,1,2], [0,1,2]) =",
            "boxplot([1,2,3,4,100]) =",
            "pareto([10,1;20,3]) =",
            "qqplot([3,1,2], [3,1,2]) =",
            "cols(boxplotgraph([1,2;3,4;100,5])[0]) =",
            "filterNaN([1,2;NaN,3]) =",
            "cols(scores(Nipals([1,3;2,1;4,2;5,6;8,4],1,1000,\"noscale\",0.00000001))) =",
            "movavg([1,2,3],2) =",
            "localmax([0,1;1,3;2,1;3,4;4,2]) =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[1.0], &[2.0]], 1e-12);
        assert_close(&results[1].1, &[&[0.5, 1.0], &[1.5, 2.0]], 1e-12);
        assert_close(
            &results[2].1,
            &[&[2.0], &[3.0], &[4.0], &[1.0], &[4.0], &[100.0]],
            1e-12,
        );
        assert_close(
            &results[3].1,
            &[&[20.0, 3.0, 75.0], &[10.0, 1.0, 100.0]],
            1e-12,
        );
        assert_close(
            &results[4].1,
            &[&[1.0, 1.0], &[2.0, 2.0], &[3.0, 3.0]],
            1e-12,
        );
        assert_close(&results[5].1, &[&[1.0]], 1e-12);
        assert_close(&results[6].1, &[&[1.0, 2.0]], 1e-12);
        assert_close(&results[7].1, &[&[1.0]], 1e-12);
        assert_close(&results[8].1, &[&[1.0, 1.5, 2.5]], 1e-12);
        assert_close(&results[9].1, &[&[1.0, 3.0], &[3.0, 4.0]], 1e-12);
    }

    #[test]
    fn interpolation_and_regression_worksheet_calls() {
        let Some((results, _)) = run(&[
            "x := [0;1;2;3;4;5;6;7]",
            "y := [1;3;2;5;4;6;8;7]",
            "f(t, u) := [u[0]*exp(-u[1]*t); exp(-u[1]*t); -u[0]*t*exp(-u[1]*t)]",
            "g(t) := [1; t]",
            "p := polyfit(x, [0;1;4;9;16;25;36;49], 2)",
            "line(x, y) =",
            "slope(x, y) + intercept(x, y) =",
            "genfit([0;1;2;3], [3;3*exp(-0.7);3*exp(-1.4);3*exp(-2.1)], [1;1], f) =",
            "p(2.5) =",
            "polyint([0;1;2;3], [0;1;8;27], 1.5) =",
            "linfit(x, [1;3;5;7;9;11;13;15], g) =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[1.25], &[0.928_571_428_571_428_6]], 1e-9);
        assert_close(&results[1].1, &[&[2.178_571_428_571_428_5]], 1e-9);
        assert_close(&results[2].1, &[&[3.0], &[0.7]], 1e-6);
        assert_close(&results[3].1, &[&[6.25]], 1e-9);
        // polyint is Numerical Recipes' polint: the error estimate keeps its sign (verified against the reference application).
        assert_close(&results[4].1, &[&[3.375], &[-0.375]], 1e-6);
        assert_close(&results[5].1, &[&[1.0], &[2.0]], 1e-9);
    }

    #[test]
    fn differential_equation_solvers_worksheet_calls() {
        let Some((results, _)) = run(&[
            "D(x, y) := [y[1]; -y[0]]",
            "AJ(x, y) := [0, 0, 1]",
            "rkfixed([0;1], 0, 3.141592653589793, 4, D) =",
            "Radau([0;1], 0, 3.141592653589793, 2, D)[2,2] =",
            "rows(Rkadapt([0;1], 0, 1, 10, D)) =",
            "statespace([0;1], 0, 3.141592653589793, 2, [0, 1; -1, 0])[2,2] =",
            "relax(identity(3), identity(3), identity(3), identity(3), -4*identity(3), 0*identity(3), identity(3), 0.5)[1,1] =",
        ]) else {
            return;
        };
        assert_eq!(results.len(), 5);
        // rkfixed with four steps over half a period; the first row is the initial state.
        let table = numbers(&results[0].1);
        assert_eq!(table.len(), 5);
        assert_eq!(table[0], vec![0.0, 0.0, 1.0]);
        assert!((table[4][1]).abs() < 0.05, "{table:?}");
        assert_close(&results[1].1, &[&[-1.0]], 1e-6);
        assert_close(&results[2].1, &[&[11.0]], 1e-12);
        assert_close(&results[3].1, &[&[-1.0]], 1e-6);
        assert!(numbers(&results[4].1)[0][0].abs() < 1e-9);
    }

    #[test]
    fn moved_copies_keep_value_semantics() {
        let Some((results, _)) = run(&[
            "Swap(v) := program
  a ← v
  b ← v
  t ← a
  a ← b
  b ← t
  a[0] ← 9
  b[0] + a[0]
",
            "Keep(v) := program
  a ← v
  b ← a
  b[0] ← 5
  a[0]
",
            "Param(v) := program
  b ← v
  b[0] ← 5
  v[0]
",
            "Loop(v) := program
  a ← v
  b ← v
  for k ∈ 0..3
    t ← a
    a ← b
    b ← t
    a[0] ← a[0] + 1
  a[0] * 100 + b[0] * 10 + v[0]
",
            "x := [1; 2]",
            "Swap(x) =",
            "Keep(x) =",
            "Param(x) =",
            "Loop(x) =",
            "x[0] =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[10.0]], 1e-12);
        assert_close(&results[1].1, &[&[1.0]], 1e-12);
        assert_close(&results[2].1, &[&[1.0]], 1e-12);
        // Four rounds on two separate buffers that trade places; each round adds 1 to the one in `a`.
        assert_close(&results[3].1, &[&[331.0]], 1e-12);
        assert_close(&results[4].1, &[&[1.0]], 1e-12);
    }

    #[test]
    fn statistical_functions_worksheet_calls() {
        let Some((results, _)) = run(&[
            "Seed(123) =",
            "Seed(42) =",
            "Ftest([1,2,3], [2,4,6]) =",
            "Spear([1,2,3], [1,2,3]) =",
            "kendltau([1,2,3], [1,2,3]) =",
            "kendltau2([0,2,13,4;2,5,7,10;3,2,1,0]) =",
            "contingtbl([1,1;1,1]) =",
        ]) else {
            return;
        };
        assert_close(&results[1].1, &[&[123.0]], 1e-12);
        assert_close(&results[2].1, &[&[0.25], &[0.4]], 1e-12);
        assert_close(
            &results[3].1,
            &[
                &[0.0],
                &[-2.0f64.sqrt()],
                &[0.15729920705028513],
                &[1.0],
                &[0.0],
            ],
            1e-12,
        );
        assert_close(
            &results[4].1,
            &[&[1.0], &[1.5666989036012806], &[0.11718508719813801]],
            1e-12,
        );
        assert_close(
            &results[5].1,
            &[
                &[-0.2326626443580524],
                &[-2.358484155989168],
                &[0.018349743085664866],
            ],
            1e-12,
        );
        assert_close(
            &results[6].1,
            &[&[0.0], &[1.0], &[1.0], &[0.0], &[0.0]],
            1e-12,
        );
    }

    #[test]
    fn probability_distribution_worksheet_calls() {
        let Some((results, _)) = run(&[
            "dnorm(0, 0, 1) =",
            "pgamma(1, 1) =",
            "dhypergeom(1, 3, 2, 2) =",
            "rows(rbeta(3, 2, 3)) =",
        ]) else {
            return;
        };
        assert_close(
            &results[0].1,
            &[&[1.0 / (2.0 * std::f64::consts::PI).sqrt()]],
            1e-12,
        );
        assert_close(&results[1].1, &[&[1.0 - (-1.0f64).exp()]], 1e-12);
        assert_close(&results[2].1, &[&[0.6]], 1e-12);
        assert_close(&results[3].1, &[&[3.0]], 1e-12);
    }

    #[test]
    fn scalars_operators_and_lazy_forms() {
        let Some((results, _)) = run(&[
            "a := 2",
            "b := a + 3·a^2 =",
            "1 < 2 < 3 =",
            "3 > 2 < 1 =",
            "0 ∧ (1/0) =",
            "1 ∨ (1/0) =",
            "if(1, 2, 1/0) =",
            "∑[k ∈ 1..4] k =",
            "∑[k ∈ 4..1] k =",
            "∏[k ∈ 1..4] k =",
            "5! =",
            "1/0 =",
            "x_undefined + 1 =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert_eq!(value(0), "14.0");
        assert_eq!(value(1), "1.0");
        assert_eq!(value(2), "0.0");
        assert_eq!(value(3), "0.0");
        assert_eq!(value(4), "1.0");
        assert_eq!(value(5), "2.0");
        assert_eq!(value(6), "10.0");
        assert_eq!(value(7), "10.0");
        assert_eq!(value(8), "24.0");
        assert_eq!(value(9), "120.0");
        assert!(
            value(10).starts_with("ERROR: EqError: can't divide by zero"),
            "{}",
            value(10)
        );
        assert!(
            value(11).contains("x_undefined is undefined"),
            "{}",
            value(11)
        );
    }

    #[test]
    fn arrays_indexed_assignment_and_ranges() {
        let Some((results, _)) = run(&[
            "x := [1; 2; 3]",
            "y := x",
            "x[1] := 10",
            "x =",
            "y =",
            "i := 0..3",
            "w[i] := i^2",
            "w =",
            "i =",
            "i^2 + 1 =",
            "[p, q] := [4, 5]",
            "p + q =",
            "M := [1, 2; 3, 4]",
            "M⟨1⟩ =",
            "Mᵀ =",
        ]) else {
            return;
        };
        let get = |i: usize| results[i].1.clone();
        assert_close(&get(0), &[&[1.0], &[10.0], &[3.0]], 0.0);
        assert_close(&get(1), &[&[1.0], &[2.0], &[3.0]], 0.0);
        assert_close(&get(2), &[&[0.0], &[1.0], &[4.0], &[9.0]], 0.0);
        assert_close(&get(3), &[&[0.0], &[1.0], &[2.0], &[3.0]], 0.0);
        assert_close(&get(4), &[&[1.0], &[2.0], &[5.0], &[10.0]], 0.0);
        assert_eq!(get(5), "9.0");
        assert_close(&get(6), &[&[2.0], &[4.0]], 0.0);
        assert_close(&get(7), &[&[1.0, 3.0], &[2.0, 4.0]], 0.0);
    }

    #[test]
    fn a_range_selects_rows_columns_and_elements() {
        // GitHub : the result follows the order of the range.
        let Some((results, _)) = run(&[
            "M := [1, 2, 3; 4, 5, 6; 7, 8, 9]",
            "v := [10; 20; 30; 40]",
            "n := 3",
            "M\u{27ea}0..1\u{27eb} =",
            "M\u{27ea}2..1\u{27eb} =",
            "M\u{27e8}1..2\u{27e9} =",
            "M\u{27ea}0, 2..2\u{27eb} =",
            "v[1..3] =",
            "v[3..1] =",
            "M\u{27ea}0..n\u{27eb} =",
        ]) else {
            return;
        };
        let get = |i: usize| results[i].1.clone();
        assert_close(&get(0), &[&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]], 0.0);
        assert_close(&get(1), &[&[7.0, 8.0, 9.0], &[4.0, 5.0, 6.0]], 0.0);
        assert_close(&get(2), &[&[2.0, 3.0], &[5.0, 6.0], &[8.0, 9.0]], 0.0);
        assert_close(&get(3), &[&[1.0, 2.0, 3.0], &[7.0, 8.0, 9.0]], 0.0);
        assert_close(&get(4), &[&[20.0], &[30.0], &[40.0]], 0.0);
        assert_close(&get(5), &[&[40.0], &[30.0], &[20.0]], 0.0);
        // One value past the last row is the operator's error, not a shorter selection.
        assert!(
            get(6).starts_with("ERROR: EqError: row index out of range"),
            "{}",
            get(6)
        );
    }

    #[test]
    fn percent_divides_by_hundred_through_the_runtime() {
        // `x%` is x/100 and the codegen calls `eq_percent`, never an inline
        // division.
        let Some((results, _)) = run(&[
            "a := 1",
            "b := 2",
            "3.4% =",
            "x := 3.4%",
            "x =",
            "y := (a + b)·50%",
            "y =",
            "M := [10, 20; 30, 40]",
            "M% =",
        ]) else {
            return;
        };
        let get = |i: usize| results[i].1.clone();
        assert_eq!(get(0), "0.034");
        assert_eq!(get(1), "0.034");
        // `5%` is 0.05 and `3·0.05` is 0.15000000000000002 in binary floating point, so the
        // case that must be exact is the one with a step that is a power of two.
        assert_eq!(get(2), "1.5");
        assert_close(&get(3), &[&[0.1, 0.2], &[0.3, 0.4]], 0.0);
    }

    #[test]
    fn program_with_continue_break_while_and_return() {
        let Some((results, _)) = run(&[
            "S(n) := program\n  s ← 0\n  for i ∈ 0..n\n    if i == 2\n      continue\n    if i > 5\n      break\n    s ← s + i\n  while s < 20\n    s ← s + 5\n  if s > 100\n    return \"big\"\n  s + i\n",
            "S(4) =",
            "S(10) =",
        ]) else {
            return;
        };
        // n = 4: s = 0+1+3+4 = 8, then 8 -> 13 -> 18 -> 23, i = 4: 27
        assert_eq!(results[0].1, "27.0");
        // n = 10: i stops at 6 (break), s = 0+1+3+4+5 = 13 -> 18 -> 23, 23 + 6 = 29
        assert_eq!(results[1].1, "29.0");
    }

    #[test]
    fn a_program_local_function_runs_recurses_and_copies_its_arguments() {
        // a local function of a program (GitHub ).
        let Some((results, _)) = run(&[
            // It reads the program's locals …
            "Z(A, Q, T) := program\n  g(x) ← x^2 + Q\n  g(A) + T\n",
            "Z(3, 1, 2) =",
            // … a program body may call itself …
            "F(n) := program\n  g(x) ← program\n    if x ≤ 1\n      1\n    else\n      x·g(x - 1)\n  g(n)\n",
            "F(5) =",
            // … the definition statement evaluates nothing, so a program of only definitions is
            // an error …
            "E(n) := program\n  g(x) ← x\n",
            "E(1) =",
            // … a call before the definition fails at run time …
            "B(n) := program\n  g(n)\n  g(x) ← x + 1\n",
            "B(1) =",
            // … it shadows the worksheet function of the same name, which keeps its own value …
            "f(y) := y·10",
            "h(x) := program\n  f(y) ← y + 1\n  f(x)\n",
            "h(2) =",
            "f(2) =",
            // … and its argument is copied like any other parameter the body writes into.
            "keep(L) := program\n  fill(v) ← program\n    v[0] ← 99\n    v\n  fill(L)\n  L\n",
            "keep([1; 2]) =",
            "copy(L) := program\n  fill(v) ← program\n    v[0] ← 99\n    v\n  fill(L)\n",
            "copy([1; 2]) =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert_eq!(value(0), "12.0");
        assert_eq!(value(1), "120.0");
        assert!(
            value(2).contains("the program did not evaluate any expression"),
            "{}",
            value(2)
        );
        assert!(value(3).starts_with("ERROR: "), "{}", value(3));
        assert_eq!(value(4), "3.0");
        assert_eq!(value(5), "20.0");
        assert_close(value(6), &[&[1.0], &[2.0]], 0.0);
        assert_close(value(7), &[&[99.0], &[2.0]], 0.0);
    }

    ///  (GitHub ): a nested cell destructures the array the right side
    /// holds there, in a worksheet definition and in a program, and a matrix target of an inline
    /// argument definition leaves the argument's value alone.
    #[test]
    fn nested_destructuring_evaluates() {
        let Some((results, _)) = run(&[
            // A 1×2 matrix whose cells are a 1×2 and a 2×1 nested array.
            "M := [[1, 2], [3; 4]]",
            "[[a, b], [c; d]] := M",
            "a =",
            "b =",
            "c =",
            "d =",
            "f(x) := [x, [x + 1; x + 2]]",
            "S(x) := program\n  [p, [q; r]] ← f(x)\n  p + q + r",
            "S(10) =",
            "g(v) := v[0, 1]",
            "g([x, y] ← [3, 4]) =",
            // the errors of a nested cell are those of an ordinary destructuring, so a
            // `try` catches them like any other region error.
            "T(M) := program\n  try\n    [p, [u; w]] ← M\n  on error\n    -1",
            "T([[1, 2], [3; 4]]) =",
            // A nested cell that is not an array.
            "T([1, 2]) =",
            // A nested array of the wrong shape.
            "T([[1, 2], [3; 4; 5]]) =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert_eq!(value(0), "1.0");
        assert_eq!(value(1), "2.0");
        assert_eq!(value(2), "3.0");
        assert_eq!(value(3), "4.0");
        assert_eq!(value(4), "33.0");
        assert_eq!(value(5), "4.0");
        assert_eq!(value(6), "4.0");
        assert_eq!(value(7), "-1.0");
        assert_eq!(value(8), "-1.0");
    }

    ///  (GitHub ): a call of a function an array holds evaluates,
    /// the element is evaluated once, and an element that is not a function is an error naming it
    /// (caught by `try`, so it is an `EqError` and not a Julia `MethodError`).
    #[test]
    fn an_element_of_an_array_is_called() {
        let Some((results, _)) = run(&[
            "f(x) := x + 1",
            "g(x) := 2·x",
            "F := [f; g]",
            "F[0](3) =",
            "F[1](3) =",
            // The index may be an expression and the arguments may be several.
            "k := 1",
            "F[k](3) =",
            "h(x, y) := x·y + 1",
            "H := [h]",
            "H[0](2, 3) =",
            // A matrix of two indices.
            "M := [f, g; g, f]",
            "M[1, 0](4) =",
            // An element that is not a function, caught as a region error.
            "V := [1; 2]",
            "T(v) := program\n  try\n    v[0](1)\n  on error\n    -1",
            "T(V) =",
            // Uncaught, the error message itself names the element as written.
            "V[1](1) =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert_eq!(value(0), "4.0");
        assert_eq!(value(1), "6.0");
        assert_eq!(value(2), "6.0");
        assert_eq!(value(3), "7.0");
        assert_eq!(value(4), "8.0");
        assert_eq!(value(5), "-1.0");
        assert_eq!(value(6), "ERROR: EqError: V[1] is not a function");
    }

    #[test]
    fn nested_element_assignment_and_workworksheet_variable_capture() {
        let Some((results, _)) = run(&[
            "X := 5",
            "f(n) := program\n  X ← X + n\n  X\n",
            "f(1) =",
            "X =",
            "g(A) := program\n  B ← A\n  B[0, 0] ← 99\n  [A, B]\n",
            "M := [1, 2; 3, 4]",
            "g(M) =",
            "M =",
        ]) else {
            return;
        };
        assert_eq!(results[0].1, "6.0");
        assert_eq!(results[1].1, "5.0");
        // The matrix argument is unchanged.
        assert_close(&results[3].1, &[&[1.0, 2.0], &[3.0, 4.0]], 0.0);
    }

    #[test]
    fn nested_arrays_and_vectorize() {
        let Some((results, _)) = run(&[
            "f(S) := program
  s[0] ← S
  s[1] ← [10; 20]
  (s[1])[1] ← 99
  s[1]
",
            "f(5) =",
            "v := [-1; 2]",
            "\\vec(|v|) =",
            "\\vec(v^2 + v) =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[10.0], &[99.0]], 0.0);
        assert_close(&results[1].1, &[&[1.0], &[2.0]], 0.0);
        assert_close(&results[2].1, &[&[0.0], &[6.0]], 0.0);
    }

    #[test]
    fn errors_carry_the_statement_location() {
        let Some((results, generated)) = run(&[
            "bad(x) := program\n  y ← 1\n  error(\"boom\")\n  y\n",
            "bad(1) =",
            "bad(1) + 1 =",
        ]) else {
            return;
        };
        assert!(
            results[0].1.starts_with("ERROR: EqError: boom (statement "),
            "{}",
            results[0].1
        );
        let id: i64 = results[0]
            .1
            .trim_end_matches(')')
            .rsplit(' ')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let location = generated.statements.iter().find(|s| s.id == id).unwrap();
        assert_eq!(location.region_id, "r000");
        let source = "bad(x) := program\n  y ← 1\n  error(\"boom\")\n  y\n";
        assert_eq!(&source[location.span.range()], "error(\"boom\")");
    }
    #[test]
    fn integrals_and_derivatives_evaluate() {
        let Some((results, _)) = run(&[
            "f(x) := sin(3·x) + ln(x)",
            "a := 0.01",
            "b := 10",
            "I_mcd := ∫[x ∈ a..b] f(x)",
            "I_ref := (-4/3)·cos(b)^3 + cos(b) + b·ln(b) - b - ((-4/3)·cos(a)^3 + cos(a) + a·ln(a) - a)",
            "I_mcd - I_ref =",
            "τ := 2.5",
            "∫[t ∈ 0..∞] e^(-t/τ) =",
            "x := 2",
            "ⅆ[x] x^3 =",
            "ⅆ[x^2] f(x) =",
            "f′(x) =",
            "f′′(x) =",
            "g(p) := program
  p ← ∫[u ∈ 0..p] u
  p
",
            "g(4) =",
            "∫[u ∈ 0..1] ⅆ[u] u^2 =",
        ]) else {
            return;
        };
        let value: f64 = results[0]
            .1
            .parse()
            .unwrap_or_else(|_| panic!("{}", results[0].1));
        assert!(value.abs() < 1e-6, "{value}");
        assert_close(&results[1].1, &[&[2.5]], 1e-7);
        assert_close(&results[2].1, &[&[12.0]], 1e-6);
        let d2 = -9.0 * (6.0f64).sin() - 0.25;
        assert_close(&results[3].1, &[&[d2]], 1e-5);
        let d1 = 3.0 * (6.0f64).cos() + 0.5;
        assert_close(&results[4].1, &[&[d1]], 1e-6);
        assert_close(&results[5].1, &[&[d2]], 1e-5);
        assert_close(&results[6].1, &[&[8.0]], 1e-8);
        assert_close(&results[7].1, &[&[1.0]], 1e-6);
    }

    #[test]
    fn root_finds_zeros_by_guess_and_by_interval() {
        let Some((results, _)) = run(&[
            "f(x) := x^3 - x - 2",
            "x := 1",
            "root(f(x), x) =",
            "root(f(x), x, 1, 2) =",
            "root(f(t), t, 2, 1) =",
            "root(cos(x) - x, x) =",
            "a := 4",
            "root(x^2 - a, x, 0, 10) =",
            "√[3](27) =",
            "root(x^2 + 1, x, -1, 1) =",
            "root(x^2 + 1, x) =",
            "g(p) := program
  p ← root(p^2 - 9, p)
  p
",
            "g(2) =",
        ]) else {
            return;
        };
        assert_close(&results[0].1, &[&[1.5213797068045676]], 1e-12);
        assert_close(&results[1].1, &[&[1.5213797068045676]], 1e-12);
        assert_close(&results[2].1, &[&[1.5213797068045676]], 1e-12);
        assert_close(&results[3].1, &[&[0.7390851332151607]], 1e-12);
        assert_close(&results[4].1, &[&[2.0]], 1e-12);
        assert_close(&results[5].1, &[&[3.0]], 1e-12);
        assert!(
            results[6]
                .1
                .starts_with("ERROR: EqError: root: the expression has the same sign"),
            "{}",
            results[6].1
        );
        assert!(
            results[7]
                .1
                .starts_with("ERROR: EqError: root did not converge"),
            "{}",
            results[7].1
        );
        assert_close(&results[8].1, &[&[3.0]], 1e-12);
    }

    // -------------------------------------------------------------------- units

    #[test]
    fn units_end_to_end_phase_4_exit_and_operators() {
        // every unit of a value position carries its label
        let Some((results, _)) = run(&[
            "x := 3 m@unit",
            "y := x^2",
            "y =",
            "1 m@unit + 1 s@unit =",
            "5 km@unit / (2 m@unit) =",
            "90 deg@unit =",
            "sin(30 deg@unit) =",
            "2 km@unit + 500 m@unit =",
            "1 m@unit < 1 km@unit =",
            "1 m@unit == 1 s@unit =",
            "9.81 m@unit/s@unit^2 =",
            "119 kW@unit =",
            "√(9 m@unit^2) =",
            "sin(2 m@unit) =",
            "0·m@unit =",
            "m := 5",
            "3 m =",
            "3 m@unit =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert_eq!(value(0), "9.0 m^2");
        assert!(value(1).starts_with("ERROR: EqError: the units in this expression do not match"));
        assert_eq!(value(2), "2500.0");
        assert_close(value(3), &[&[std::f64::consts::FRAC_PI_2]], 1e-15);
        assert_close(value(4), &[&[0.5]], 1e-15);
        assert_eq!(value(5), "2500.0 m");
        assert_eq!(value(6), "1.0");
        assert!(value(7).starts_with("ERROR: EqError: the units in this comparison do not match"));
        assert_eq!(value(8), "9.81 m s^-2");
        assert_eq!(value(9), "119000.0 kg m^2 s^-3");
        assert_eq!(value(10), "3.0 m");
        assert!(
            value(11).starts_with("ERROR: EqError: sin needs a unitless value"),
            "{}",
            value(11)
        );
        assert_eq!(value(12), "0.0 m");
        // a visible definition of `m` is the variable (it is a name like any other), and the
        // unit label reaches the unit
        assert_eq!(value(13), "15.0");
        assert_eq!(value(14), "3.0 m");
    }

    #[test]
    fn unit_overrides_leave_the_value_in_si_and_report_the_unit() {
        let Some((results, units, _)) = run_with_units(&[
            "v := 8 m@unit/s@unit",
            "v = … km/hr",
            "v = … s",
            "w := 2 km@unit = … m",
            "[1 m@unit, 2 m@unit] = … cm",
            "[1 m@unit, 2 s@unit] = … m",
            "0.5 = … deg",
        ]) else {
            return;
        };
        assert_eq!(results[0].1, "8.0 m s^-1");
        let unit = |id: &str| units.iter().find(|(k, _)| k == id).map(|(_, v)| v.as_str());
        // the divisor is the unit's SI value (km/hr = 1000/3600 m/s)
        assert_eq!(unit("r001"), Some("0.2777777777777778 m s^-1"));
        assert!(unit("r002")
            .unwrap()
            .contains("the unit override does not match the result"));
        assert_eq!(results[1].1, "8.0 m s^-1");
        assert_eq!(results[2].1, "2000.0 m");
        assert_eq!(unit("r003"), Some("1.0 m"));
        assert_eq!(unit("r004"), Some("0.01 m"));
        assert!(unit("r005").unwrap().starts_with("ERROR"));
        assert_close(
            unit("r006").unwrap(),
            &[&[std::f64::consts::PI / 180.0]],
            1e-15,
        );
    }

    #[test]
    fn units_in_ranges_arrays_and_functions() {
        // climbing_rate r278/r280: a range of lengths, a function of it, a unit override
        let Some((results, units, _)) = run_with_units(&[
            "h_t := 0·m@unit, 1000·m@unit..3000·m@unit",
            "RC(h) := 3.7·m@unit/s@unit - h·0.0005/s@unit",
            "RC(h_t) = … m/s",
            "A := [1 m@unit; 2 s@unit]",
            "2·A =",
            "A + [3 m@unit; 1 s@unit] =",
            "A + [1 s@unit; 1 s@unit] =",
            "A[0] =",
        ]) else {
            return;
        };
        let value = |i: usize| results[i].1.as_str();
        assert!(
            value(0).ends_with("[3.7 m s^-1; 3.2 m s^-1; 2.7 m s^-1; 2.2 m s^-1;;]"),
            "{}",
            value(0)
        );
        assert!(units.iter().any(|(k, v)| k == "r002" && v == "1.0 m s^-1"));
        assert!(value(1).ends_with("[2.0 m; 4.0 s;;]"), "{}", value(1));
        assert!(value(2).ends_with("[4.0 m; 3.0 s;;]"), "{}", value(2));
        assert!(value(3).starts_with("ERROR: EqError: the units in this expression do not match"));
        assert_eq!(value(4), "1.0 m");
    }

    /// Leading number of a printed quantity (`3.7 m s^-1` is 3.7).
    fn magnitude(text: &str) -> f64 {
        text.split_whitespace()
            .next()
            .and_then(|n| n.parse().ok())
            .unwrap_or_else(|| panic!("no number in `{text}`"))
    }

    /// Golden case: the unit-bearing part of the climbing_rate worksheet.
    #[test]
    fn climbing_rate_units_golden() {
        let Some((results, units, _)) = run_with_units(&[
            "m_TO := 1111 kg@unit",
            "S := 16.2 m@unit^2",
            "b := 11 m@unit",
            "e_O := 0.8",
            "C_L.max := 1.6",
            "P_0 := 119 kW@unit",
            "V_η := 60 m@unit/s@unit",
            "V_1 := 38 m@unit/s@unit",
            "RC_1 := 3.7 m@unit/s@unit",
            "V_2 := 63 m@unit/s@unit",
            "RC_2 := 0 m@unit/s@unit",
            "g_0 := 9.80665 m@unit/s@unit^2",
            "ρ_0 := 1.225 kg@unit/m@unit^3",
            "T_0 := 288.15 K@unit",
            "λ := 0.0065 K@unit/m@unit",
            "R_a := 287.05 J@unit/(kg@unit K@unit)",
            "ρ(h) := ρ_0 (1 - λ h/T_0)^(g_0/(R_a λ) - 1)",
            "σ(h) := ρ(h)/ρ_0",
            "W := m_TO g_0",
            "AR := b^2/S",
            "k := 1/(π e_O AR)",
            "f_η(V) := (V/V_η) (2 - V/V_η)",
            "a_1 := P_0 f_η(V_1)",
            "d_1 := (1/2) ρ_0 S V_1^3",
            "n_1 := W RC_1 + 2 k W^2/(ρ_0 S V_1)",
            "a_2 := P_0 f_η(V_2)",
            "d_2 := (1/2) ρ_0 S V_2^3",
            "n_2 := W RC_2 + 2 k W^2/(ρ_0 S V_2)",
            "η_p.max := (n_1 d_2 - n_2 d_1)/(a_1 d_2 - a_2 d_1) =",
            "C_D0 := (a_2 n_1 - a_1 n_2)/(a_1 d_2 - a_2 d_1) =",
            "W =",
            "AR =",
            "k =",
            "C_L(V, h) := 2 W/(ρ(h) V^2 S)",
            "D(V, h) := (1/2) ρ(h) V^2 S (C_D0 + k C_L(V, h)^2)",
            "P_r(V, h) := D(V, h) V",
            "φ(h) := 1.132 σ(h) - 0.132",
            "η_p(V) := η_p.max f_η(V)",
            "P_a(V, h) := η_p(V) P_0 φ(h)",
            "RC(V, h) := (P_a(V, h) - P_r(V, h))/W",
            "V_mp(h) := √(2 W/(ρ(h) S)) (k/(3 C_D0))^(1/4)",
            "V_s(h) := √(2 W/(ρ(h) S C_L.max))",
            "V_mp(0·m@unit) = … m/s",
            "V_s(0·m@unit) = … m/s",
            "RC(V_1, 0·m@unit) =",
            "RC(V_2, 0·m@unit) =",
            "3.711647419718597 m@unit/s@unit = … ft/min",
            "39.35443947850404 m@unit/s@unit = … km/hr",
            "asin(3.711647419718597/39.35443947850404) = … deg",
        ]) else {
            return;
        };
        let by_id = |id: &str| {
            results
                .iter()
                .find(|(k, _)| k == id)
                .unwrap_or_else(|| panic!("no result {id}"))
                .1
                .as_str()
        };
        let unit = |id: &str| {
            units
                .iter()
                .find(|(k, _)| k == id)
                .unwrap_or_else(|| panic!("no unit {id}"))
                .1
                .as_str()
        };
        let close = |got: f64, want: f64, rtol: f64| {
            assert!(
                (got - want).abs() <= rtol * want.abs(),
                "{got} is not {want} (rtol {rtol})"
            );
        };
        let id = |n: usize| format!("r{n:03}");
        // results are SI base units; W = 10895.18815 newton
        close(magnitude(by_id(&id(30))), 10895.18815, 1e-12);
        assert!(by_id(&id(30)).ends_with("kg m s^-2"), "{}", by_id(&id(30)));
        close(magnitude(by_id(&id(28))), 0.7129508416520527, 1e-9);
        close(magnitude(by_id(&id(29))), 0.030032472805025953, 1e-9);
        close(magnitude(by_id(&id(31))), 7.469135802469136, 1e-12);
        close(magnitude(by_id(&id(32))), 0.05327086938199802, 1e-12);
        // the value stays in SI, divisor and value give the saved converted number
        let converted = |value: &str, unit: &str| magnitude(value) / magnitude(unit);
        close(
            converted(by_id(&id(42)), unit(&id(42))),
            29.0570267230745,
            1e-9,
        );
        close(
            converted(by_id(&id(43)), unit(&id(43))),
            26.196714204208927,
            1e-9,
        );
        close(magnitude(by_id(&id(44))), 3.6999999999999997, 1e-12);
        assert!(by_id(&id(44)).ends_with("m s^-1"));
        assert!(magnitude(by_id(&id(45))).abs() < 1e-9);
        close(
            converted(by_id(&id(46)), unit(&id(46))),
            730.6392558501175,
            1e-12,
        );
        close(
            converted(by_id(&id(47)), unit(&id(47))),
            141.67598212261453,
            1e-12,
        );
        close(
            converted(by_id(&id(48)), unit(&id(48))),
            5.411797873750448,
            1e-12,
        );
        assert!(unit(&id(46)).ends_with("m s^-1"));
        assert!(!unit(&id(48)).contains(' '), "{}", unit(&id(48)));
    }
}

#[test]
fn function_head_arguments_with_placeholder_names_round_trip() {
    for src in [
        "M := matrix(2, 2, `_`(i, j) ← i + j)",
        "M := matrix(2, 2, `~`(i, j) ← i + j)",
        "M := matrix(2, 2, g(i, j) ← i + j)",
    ] {
        let statement = parse_statement(src).unwrap_or_else(|e| panic!("parse `{src}`: {e:?}"));
        let printed = equavela_core::syntax::print_statement(&statement);
        assert_eq!(printed, src);
        assert!(!code(src).is_empty());
    }
}

#[test]
fn uniform_random_builtin_reaches_runtime() {
    assert_eq!(expr_with(&[], "rnd(5)"), "eq_rnd(5.0)");
}

#[test]
fn jacob_binds_the_vector_expression() {
    assert_eq!(
        expr_with(&["x", "f"], "Jacob(f(x), x)"),
        "eq_jacob(x -> f_v1(x), x_v1)"
    );
    assert_eq!(
        expr_with(&["x", "f"], "Jacob(f(x), x, 2)"),
        "eq_jacob(x -> f_v1(x), x_v1, 2.0)"
    );
}

#[test]
fn a_var_label_on_a_function_passed_as_a_value_finds_the_function() {
    // An imported `dg` (also the decigram) labelled VARIABLE by the reference application is `dg@var`.
    let out = regions(&["dg(t, y) := -y", "Z := rkfixed([1], 0, 1, 10, dg@var)"]);
    assert!(!out[1].code.contains("is undefined"), "{}", out[1].code);
    assert!(out[1].code.contains(&out[0].defined[0]), "{}", out[1].code);
}

#[test]
fn jacob_takes_a_column_vector_of_names() {
    let out = regions(&["g := 2", "i := 3", "J := Jacob([g·i; g^2], [g; i])"]);
    let code = &out[2].code;
    assert!(code.contains("eq_jacob(__jacob_x -> begin"), "{code}");
    assert!(!code.contains("must be a variable name"), "{code}");
    eprintln!("{code}");
}

#[test]
fn an_evaluated_destructuring_definition_shows_the_whole_value() {
    // `[a; b] := e =` shows `e`, as `e =` would, and still binds every name.
    let regions = regions(&["[p; q] := [1; 2] = "]);
    assert_eq!(
        regions[0].code,
        "__t1 = eq_matrix(2, 1, 1.0, 2.0)\n__t2, __t3 = eq_unpack(__t1, 2, 1)\np_v1 = __t2\nq_v1 = __t3"
    );
    assert_eq!(regions[0].value.as_deref(), Some("__t1"));
}

#[test]
fn a_transposed_target_defines_the_name_transposed() {
    let regions = regions(&["Vᵀ := [1, 2, 3]", "M := [1; 2; 3]", "[U; s; Wᵀ] := M"]);
    assert_eq!(
        regions[0].code,
        "V_v1 = eq_transpose(eq_matrix(1, 3, 1.0, 2.0, 3.0))"
    );
    assert_eq!(
        regions[2].code,
        "__t1, __t2, __t3 = eq_unpack(eq_val(M_v1), 3, 1)\nU_v1 = __t1\ns_v1 = __t2\nW_v1 = eq_transpose(__t3)"
    );
}

#[test]
fn a_name_with_apostrophes_is_a_valid_julia_identifier() {
    let generated = regions(&["x' := 1", "x'' := x' + 2"]);
    let first = &generated[0].code;
    let second = &generated[1].code;
    assert!(!first.contains('\'') && !second.contains('\''), "{first}\n{second}");
    let x1 = worksheet_ident(&parse_name("x'"), 1);
    assert!(second.contains(&x1), "{second}");
    let (segments, _) = demangle_ident(&x1).unwrap();
    assert_eq!(segments[0].text, "x'");
}

fn parse_name(text: &str) -> equavela_core::ast::Name {
    match parse_statement(&format!("{text} := 0")).unwrap().kind {
        equavela_core::ast::StatementKind::Define { target, .. } => match target.kind {
            equavela_core::ast::TargetKind::Ident { name } => name,
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
}
