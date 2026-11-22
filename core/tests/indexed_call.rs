//! A call whose callee is an element of an array:
//! `F[i](x)` is an ordinary `Call` whose callee is an ordinary `Index`, the text
//! round-trips byte for byte, and only adjacency makes it a call (`F[i] (x)` is a product).

mod common;
use common::*;
use equavela_core::ast::{Arg, ExprKind, StatementKind};
use equavela_core::{parse_expression, parse_statement, print_expression, print_statement};

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

/// The callee of a call and its arguments.
fn call_parts(kind: &ExprKind) -> (&ExprKind, &[Arg]) {
    match kind {
        ExprKind::Call { callee, args } => (&callee.kind, args),
        other => panic!("not a call: {other:?}"),
    }
}

#[test]
fn an_element_call_is_a_call_whose_callee_is_an_index() {
    let kind = expr_of("F[i](x)");
    let (callee, args) = call_parts(&kind);
    match callee {
        ExprKind::Index { base, indices } => {
            assert!(matches!(base.kind, ExprKind::Ident { .. }), "{base:?}");
            assert_eq!(indices.len(), 1);
        }
        other => panic!("callee is not an index: {other:?}"),
    }
    assert_eq!(args.len(), 1);
    assert_eq!(sx("F[i](x)"), "(call (index F i) x)");
    assert_eq!(sx("F[i, j](x)"), "(call (index F i j) x)");
    assert_eq!(sx("F[0](x, 2)"), "(call (index F 0) x 2)");
    // A chain of postfix operators is a callee too.
    assert_eq!(sx("t[ord][i](x)"), "(call (index (index t ord) i) x)");
    // So is a parenthesised element, and the parenthesis stays a node.
    assert_eq!(sx("(F[i])(x)"), "(call (paren (index F i)) x)");
}

#[test]
fn the_text_round_trips_byte_for_byte() {
    for text in [
        "F[i](x)",
        "F[i, j](x)",
        "F[i, j](x, 2)",
        "F[1, 2](3)",
        "F[i][j](x)",
        "t[ord][i](x)",
        "(F[i])(x)",
        "F[i](F[j](x))",
        "F[V[i]](x)",
        "A·F[i](x) + 1",
        "F[i](n - 1)!",
        "F[i](x)^2",
        "2·F[i](x)",
        "y := F[i](x)",
        "F[i](x) =",
        "f(a, F[i](x))",
        "f(g ← F[0])",
    ] {
        roundtrip(text);
    }
    // The expression alone, as the importer and the editor hand it over.
    let parsed = parse_expression("F[i](x)").unwrap();
    assert_eq!(print_expression(&parsed), "F[i](x)");
}

#[test]
fn a_space_after_the_bracket_makes_it_a_product_not_a_call() {
    // D12: the call is only the adjacent `(`, so the printer keeps the space and never
    // produces a text that would read as a call.
    assert_eq!(sx("F[i] (x)"), "(juxt (index F i) (paren x))");
    roundtrip("F[i] (x)");
    assert_eq!(canon("F[i](x)"), "F[i](x)");
    assert_eq!(canon("F[i, j](x)"), "F[i, j](x)");
    assert_eq!(canon("F[1,2](x)"), "F[1, 2](x)");
}

#[test]
fn an_element_call_is_an_ordinary_statement() {
    // the call is an expression like any other, so it takes a definition, an
    // evaluation tail and a place among the arguments of another call.
    assert_eq!(sx("y := F[i](x)"), "(:= y (call (index F i) x))");
    assert_eq!(sx("F[i](x) ="), "(= (call (index F i) x))");
    assert_eq!(sx("f(a, F[i](x))"), "(call f a (call (index F i) x))");
    // A name taken from an element is a value: the index of a call and of a definition is
    // written the same way.
    assert_eq!(sx("g := F[0]"), "(:= g (index F 0))");
}

#[test]
fn the_form_survives_the_worksheet_file_reader() {
    // A worksheet region keeps the text as written and the reader accepts it. A current
    // file: version 2 would migrate the plain `g` of the matrix (the gram) to `g@unit`.
    let doc = "format: equavela-worksheet/3\nregions:\n  - id: r1\n    page: 1\n    at: [36, 72]\n    math: \"F[i](x) =\"\n  - id: r2\n    page: 1\n    at: [36, 147]\n    math: \"F := [f; g]\"\n";
    let id = equavela_core::project::DocumentId::new("Untitled-1.eqv").unwrap();
    let project = equavela_core::worksheet_file::load_project_text(id, doc)
        .expect("the worksheet reader accepts an element call");
    let texts: Vec<&str> = project.texts.values().map(String::as_str).collect();
    assert!(texts.contains(&"F[i](x) ="), "{texts:?}");
    assert!(texts.contains(&"F := [f; g]"), "{texts:?}");
}
