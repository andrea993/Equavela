//! Display-only ellipsis cells of matrices.
//!
//! The three glyphs are whole matrix cells and never expressions, each keeps its direction
//! through the round trip, and a matrix that holds one is shown but never evaluated.

use equavela_core::ast::{EllipsisForm, ExprKind, StatementKind};
use equavela_core::codegen::Generator;
use equavela_core::{parse_expression, parse_statement, print_statement};

fn roundtrip(text: &str) {
    let parsed = parse_statement(text).unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"));
    assert_eq!(print_statement(&parsed), text, "printing `{text}`");
    let again = parse_statement(&print_statement(&parsed)).unwrap();
    assert_eq!(parsed, again, "re-parsing `{text}`");
}

/// The cells of the matrix of a bare-region statement, in row-major order.
fn cells(text: &str) -> Vec<ExprKind> {
    match parse_statement(text).unwrap().kind {
        StatementKind::ExprRegion { expr } => match expr.kind {
            ExprKind::Matrix { cells, .. } => cells.into_iter().map(|c| c.kind).collect(),
            other => panic!("not a matrix: {other:?}"),
        },
        other => panic!("{other:?}"),
    }
}

#[test]
fn every_form_round_trips_byte_for_byte() {
    for text in [
        // one cell, each form
        "[⋯]",
        "[⋮]",
        "[⋱]",
        // a whole documentation matrix
        "[a, ⋯, b; ⋮, ⋱, ⋮; c, ⋯, d]",
        // mixed with ordinary cells
        "[1, ⋯, 2]",
        "[1, ⋯; 2, ⋮]",
        "[⋯, 1; 2, 3]",
        // nested, as any other matrix
        "[[⋯], [⋮]]",
        // in a definition, a global definition, an evaluation and a text region
        "x := [⋯]",
        "M ≡ [⋯; ⋮]",
        "[1, ⋯] =",
        // inside a call argument and an index
        "f([⋯], 2)",
        "v[[⋯][0]]",
    ] {
        roundtrip(text);
    }
}

#[test]
fn the_ascii_spellings_become_the_glyphs() {
    for (typed, printed) in [
        ("[\\cdots]", "[⋯]"),
        ("[\\vdots]", "[⋮]"),
        ("[\\ddots]", "[⋱]"),
        ("[a, \\cdots; \\vdots, \\ddots]", "[a, ⋯; ⋮, ⋱]"),
    ] {
        let parsed = parse_statement(typed).unwrap_or_else(|e| panic!("parse `{typed}`: {e:?}"));
        assert_eq!(print_statement(&parsed), printed, "printing `{typed}`");
    }
}

#[test]
fn each_form_is_stored_in_the_ast_and_kept_apart() {
    assert_eq!(
        cells("[⋯, ⋮; ⋱, 1]"),
        vec![
            ExprKind::EllipsisCell {
                form: EllipsisForm::Horizontal
            },
            ExprKind::EllipsisCell {
                form: EllipsisForm::Vertical
            },
            ExprKind::EllipsisCell {
                form: EllipsisForm::Diagonal
            },
            ExprKind::Num { text: "1".into() },
        ]
    );
    // The wire form the editor and the renderer read.
    let json = serde_json::to_value(parse_statement("[⋮]").unwrap()).unwrap();
    assert_eq!(json["expr"]["cells"][0]["type"], "EllipsisCell");
    assert_eq!(json["expr"]["cells"][0]["form"], "vertical");
    // One meaning, three glyphs: never the same text, never an empty slot.
    let glyphs = EllipsisForm::ALL.map(|form| form.glyph());
    assert_eq!(glyphs, ["⋯", "⋮", "⋱"]);
    assert!(!glyphs.contains(&"□"));
}

#[test]
fn an_ellipsis_cell_is_only_a_matrix_cell() {
    // Where the parser starts the cell itself, the message says what is wrong.
    for text in [
        "⋯",
        "⋮",
        "x := ⋯",
        "f(⋯)",
        "2·⋯",
        "∑[⋯] a",
        "x := (⋯)",
        "|⋯|",
        "v[⋯]",
    ] {
        let error = parse_statement(text).expect_err(text);
        assert_eq!(
            error.message, "an ellipsis cell is only allowed as a matrix cell",
            "message for `{text}`"
        );
    }
    // After a whole cell the matrix grammar reports the missing separator.
    for text in ["[⋯ + 1]", "[1, ⋯ 2]"] {
        let error = parse_statement(text).expect_err(text);
        assert!(
            error.message.contains("expected `,`, `;` or `]`"),
            "message for `{text}`: {}",
            error.message
        );
    }
    // The cells of a destructuring definition are names, so an ellipsis is never a target; the
    // message there is the one of the failed left side, not of a cell.
    // An ellipsis cannot be defined: the left side is kept as written and cannot be calculated.
    let equavela_core::ast::StatementKind::Define { target, .. } =
        parse_statement("[a, ⋯] := v").unwrap().kind
    else {
        panic!("not a definition");
    };
    assert!(matches!(
        target.kind,
        equavela_core::ast::TargetKind::Invalid { .. }
    ));
    // Away from a cell, by itself, the glyph is unknown input, not an operator.
    assert!(parse_expression("⋯").is_err());
}

#[test]
fn a_matrix_with_an_ellipsis_cell_cannot_be_evaluated() {
    let mut generator = Generator::default();
    for text in ["[1, ⋯; 2, ⋮]", "[⋯]"] {
        let parsed = parse_expression(text).unwrap_or_else(|e| panic!("{text}: {e:?}"));
        let generated = generator.expression(&parsed).unwrap();
        assert!(
            generated.contains(r#"eq_error("a matrix with an ellipsis cell cannot be evaluated")"#),
            "{text}: {generated}"
        );
    }
    // The cell itself, should it ever reach the generator alone, is display-only too.
    let lone = parse_statement("[⋯]").unwrap();
    let StatementKind::ExprRegion { expr } = lone.kind else {
        panic!("not a bare region");
    };
    let ExprKind::Matrix { cells, .. } = expr.kind else {
        panic!("not a matrix");
    };
    let cell = &cells[0];
    let generated = generator.expression(cell).unwrap();
    assert!(
        generated
            .contains(r#"eq_error("an ellipsis cell is displayed only and cannot be evaluated")"#),
        "{generated}"
    );
    // An ordinary matrix still generates its cells.
    let ordinary = parse_expression("[1, 2; 3, 4]").unwrap();
    assert!(!generator
        .expression(&ordinary)
        .unwrap()
        .contains("eq_error"));
}
