//! A parenthesised local definition as an operand:
//! `(target ← e)` is an operand of any expression, its value is the value of `e`,
//! the parentheses belong to the form (they are `Paren` nodes; only a second pair typed in a box
//! is grouping and goes, D5); its target is bound for the operands after it only.
//!
//! The same shapes are what a `.mcdx` holds as an `ml:localDefine` operand or under `ml:parens`;
//! the importer fixture is `tests/fixtures/mcdx/parendef`.

mod common;
use common::*;
use equavela_core::ast::{Expr, ExprKind, Name, StatementKind, Target, TargetKind};
use equavela_core::codegen::Generator;
use equavela_core::graph::{DependencyGraph, Region, Worksheet};
use equavela_core::syntax::normalize_expr;
use equavela_core::{parse_expression, parse_statement, print_expression, print_statement};
use std::sync::Arc;

fn roundtrip(text: &str) {
    let parsed = parse_statement(text).unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"));
    assert_eq!(print_statement(&parsed), text, "printing `{text}`");
    assert_fixed_point(text);
}

/// The expression of a bare-region statement.
fn expr_of(text: &str) -> ExprKind {
    match parse_statement(text).unwrap().kind {
        StatementKind::ExprRegion { expr } => expr.kind,
        other => panic!("not an expression region: {other:?}"),
    }
}

fn graph(regions: Vec<(&str, &str)>) -> DependencyGraph {
    let regions = regions
        .into_iter()
        .enumerate()
        .map(|(i, (id, math))| Region {
            id: id.to_owned(),
            page: 0,
            x: 0.0,
            y: i as f64,
            enabled: true,
            statement: Arc::new(parse_statement(math).unwrap()),
        })
        .collect();
    DependencyGraph::build(&Worksheet { regions }).unwrap()
}

/// The operand is a `Paren` whose content is the definition: the target is a target
/// of 7.3, a destructuring matrix included.
#[test]
fn the_parentheses_belong_to_the_form() {
    assert_eq!(
        sx("v := ([a, b, c] ← [1, 2, 3])ᵀ"),
        "(:= v (ᵀ (paren (← (destructure 1×3 a b c) (matrix 1×3 1 2 3)))))"
    );
    assert_eq!(
        sx("y := g(x)/(z ← 3)"),
        "(:= y (/ (call g x) (paren (← z 3))))"
    );
    // A plain name, an indexed name and a nested destructuring matrix are targets of 7.3.
    assert_eq!(sx("(z ← 3) + 1"), "(+ (paren (← z 3)) 1)");
    assert_eq!(sx("(v[i] ← 1)·2"), "(· (paren (← (index v i) 1)) 2)");
    assert_eq!(
        sx("([a, [b, c]] ← M)"),
        "(paren (← (destructure 1×2 a (destructure 1×2 b c)) M))"
    );
    // The node is a `Paren`, so the operand is an ordinary atom everywhere it appears.
    let kind = expr_of("(z ← 3)");
    match kind {
        ExprKind::Paren { expr } => match expr.kind {
            ExprKind::InlineDef { target, value } => {
                assert!(
                    matches!(target.kind, TargetKind::Ident { .. }),
                    "{target:?}"
                );
                assert!(matches!(value.kind, ExprKind::Num { .. }), "{value:?}");
            }
            other => panic!("not a definition: {other:?}"),
        },
        other => panic!("not a parenthesised definition: {other:?}"),
    }
}

/// R1, R2 and R3: the text prints back byte for byte, in every operand position.
#[test]
fn the_text_round_trips_byte_for_byte() {
    for text in [
        "v := ([a, b, c] ← [1, 2, 3])ᵀ",
        "y := g(x)/(z ← 3)",
        "6/(z ← 3)",
        "6/(z ← 3) + y/(w ← 4)",
        "(z ← 3)",
        "(z ← 3)^2",
        "(z ← 3)!",
        "(z ← 3) + 4",
        "2·(z ← 3)",
        "(v[i] ← 1)·2",
        "f((z ← 3))",
        "f(a, (b ← 2))",
        "f(a, b ← 2)",
        "([a; b] ← M)ᵀ",
        "((z ← 3))",
        "x := (z ← 3) =",
        "(z ← 3) →[simplify]",
    ] {
        roundtrip(text);
    }
    // The expression alone, as the importer and the editor hand it over.
    let parsed = parse_expression("([a, b] ← [1, 2])ᵀ").unwrap();
    assert_eq!(print_expression(&parsed), "([a, b] ← [1, 2])ᵀ");
    // In a box position the definition's pair is the grouping pair, so a second pair the user
    // typed is grouping only and is not kept (D5).
    assert_eq!(canon("((z ← 3))/6"), "(z ← 3)/6");
    assert_eq!(canon("6/((z ← 3))"), "6/(z ← 3)");
    assert_eq!(canon("x^((z ← 3))"), "x^(z ← 3)");
}

///  and N11: the parentheses are never optional, so a bare definition is not an operand.
#[test]
fn a_definition_is_an_operand_only_in_parentheses() {
    for text in [
        "z ← 3",
        "6 / z ← 3",
        "x := z ← 3",
        "(a + b) ← 1",
        "(f(x) ← 1)",
        "(z ← )",
        "()",
    ] {
        assert!(
            parse_statement(text).is_err(),
            "`{text}` must not parse as a statement"
        );
    }
    // Normalization wraps a bare node a hand-built AST may hold (N11), so every printed
    // definition of an operand keeps its pair.
    let mut bare = Expr::synth(ExprKind::Div {
        left: Box::new(Expr::synth(ExprKind::Num { text: "6".into() })),
        right: Box::new(Expr::synth(ExprKind::InlineDef {
            target: Target::synth(TargetKind::Ident {
                name: Name::plain("z"),
            }),
            value: Box::new(Expr::synth(ExprKind::Num { text: "3".into() })),
        })),
    });
    normalize_expr(&mut bare);
    assert_eq!(print_expression(&bare), "6/(z ← 3)");
    let mut again = bare.clone();
    normalize_expr(&mut again);
    assert_eq!(again, bare, "normalize is idempotent");
    // A `Paren` the user typed is a second pair and is kept (R4).
    let mut doubled = Expr::synth(ExprKind::Paren {
        expr: Box::new(bare),
    });
    normalize_expr(&mut doubled);
    assert_eq!(print_expression(&doubled), "(6/(z ← 3))");
}

/// the value's names and the target's indices are the region's references, and the
/// names of the target are not bound.
#[test]
fn nothing_of_the_target_is_bound() {
    // `v := ([a, b, c] ← [1, 2, 3])ᵀ` refers to nothing: the cells are not read, they are written.
    let g = graph(vec![("v", "v := ([a, b, c] ← [1, 2, 3])ᵀ")]);
    assert!(g.unresolved_references().is_empty());
    // The names of the target are not defined by the operand: `a` is undefined afterwards, so the
    // later region refers to nothing.
    let g = graph(vec![
        ("v", "v := ([a, b, c] ← [1, 2, 3])ᵀ"),
        ("w", "w := a + 1"),
    ]);
    assert_eq!(
        g.unresolved_references()
            .iter()
            .map(|r| (r.region_id.as_str(), r.name.as_simple()))
            .collect::<Vec<_>>(),
        [("w", Some("a"))]
    );
    // The value's names and the target's indices are reads.
    let g = graph(vec![
        ("n", "n := 1"),
        ("k", "k := 1"),
        ("v", "v := 3"),
        ("r", "r := (v[k] ← n)·2"),
    ]);
    assert_eq!(g.dependencies_of("r").unwrap(), ["n", "k", "v"]);
}

/// codegen emits the value of the right side; the target is not
/// evaluated, not unpacked and not assigned.
#[test]
fn the_generated_code_is_the_value_of_the_right_side() {
    let mut generator = Generator::default();
    for name in ["g", "x", "z", "a", "b", "c", "M", "v", "i"] {
        generator.declare_variable(name);
    }
    let mut generate = |source: &str| {
        let parsed = parse_expression(source).unwrap_or_else(|e| panic!("parse `{source}`: {e:?}"));
        generator
            .expression(&parsed)
            .unwrap_or_else(|e| panic!("generate `{source}`: {e}"))
    };
    assert_eq!(generate("6/(z ← 3)"), "eq_div(6.0, 3.0)");
    assert_eq!(generate("g(x)/(z ← 3)"), "eq_div(g_v1(x_v1), 3.0)");
    assert_eq!(
        generate("([a, b, c] ← [1, 2, 3])ᵀ"),
        "eq_transpose(eq_matrix(1, 3, 1.0, 2.0, 3.0))"
    );
    // A destructuring target of the operand is not taken apart: no `eq_unpack` is generated.
    assert_eq!(generate("([a, b] ← M)ᵀ"), "eq_transpose(M_v1)");
    // The postfix operator and the arithmetic apply to the value of the definition.
    assert_eq!(generate("(z ← 3) + 1"), "eq_add(3.0, 1.0)");
    assert_eq!(generate("(z ← 3)^2"), "eq_pow(3.0, 2.0)");
}

/// the operand hands its value through, so a definition through it keeps the
/// copy-on-assign rule of the value it holds (`may_alias`).
#[test]
fn a_definition_through_the_operand_keeps_the_copy_of_an_array() {
    let mut generator = Generator::default();
    generator.declare_variable("M");
    let statement = parse_statement("x := (M ← M)").unwrap();
    let region = generator.region("r0", &statement);
    assert_eq!(region.code, "x_v1 = eq_val(M_v1)");
}

/// an operand after the definition reads it, so the name is
/// not a reference to the worksheet there; an operand before it still is.
#[test]
fn the_operands_after_a_definition_read_it() {
    let g = graph(vec![
        ("f", "f(a, b) := a·b"),
        ("x", "X := 10"),
        ("r", "f(X ← 3, X + 1) ="),
    ]);
    assert_eq!(g.dependencies_of("r").unwrap(), ["f"]);
    assert!(g.unresolved_references().is_empty());
    // Read before its definition in the written order, the name is the worksheet's.
    let g = graph(vec![("x", "X := 10"), ("r", "X + (X ← 3) =")]);
    assert_eq!(g.dependencies_of("r").unwrap(), ["x"]);
    // The cells of a destructuring target bind too.
    let g = graph(vec![("r", "([a, b] ← [1, 2])ᵀ + a =")]);
    assert!(g.unresolved_references().is_empty());
    // The binding ends with the expression.
    let g = graph(vec![("r", "f(X ← 3) ="), ("s", "X =")]);
    assert_eq!(
        g.unresolved_references()
            .iter()
            .filter(|r| r.region_id == "s")
            .count(),
        1
    );
}

/// the generated code binds a name that a later operand reads, in a `let` that ends
/// with the expression.
#[test]
fn the_generated_code_binds_a_name_read_later() {
    let mut generator = Generator::default();
    for name in ["f", "X"] {
        generator.declare_variable(name);
    }
    let parsed = parse_expression("f(X ← 3, X + 1)").unwrap();
    let code = generator.expression(&parsed).unwrap();
    assert!(code.starts_with("(let X\n"), "{code}");
    assert!(code.contains("X = __t"), "{code}");
    assert!(code.contains("eq_add(X, 1.0)"), "{code}");
    assert!(!code.contains("X_v1"), "{code}");
    // A name read before the definition keeps the worksheet version.
    let parsed = parse_expression("X + (X ← 3)").unwrap();
    assert_eq!(generator.expression(&parsed).unwrap(), "eq_add(X_v1, 3.0)");
}
