//! Display-only derivatives with respect to an expression (`ⅆ[w[j]] f`, `ⅆ[Aᵀ] f`, `∂[(ω·t)] f`,
//! `ⅆ[x[i]^2] f`): parser, printer, round-trip, AST, evaluation error, and `.xmcd` import.

use equavela_core::ast::{ExprKind, StatementKind};
use equavela_core::codegen::{generate_worksheet, GenOptions};
use equavela_core::graph::{Region, Worksheet};
use equavela_core::{parse_statement, print_statement};

fn roundtrip(text: &str) {
    let parsed = parse_statement(text).unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"));
    assert_eq!(print_statement(&parsed), text, "printing `{text}`");
    let again = parse_statement(&print_statement(&parsed)).unwrap();
    assert_eq!(parsed, again, "re-parsing `{text}`");
}

#[test]
fn derivative_with_expression_variable_round_trips() {
    for text in [
        "ⅆ[x] f",
        "ⅆ[x^2] f",
        "∂[x] f",
        "ⅆ[w[j]] f",
        "ⅆ[Aᵀ] f",
        "∂[(ω·t)] f",
        "ⅆ[x[i]^2] f",
        "∂[x[i]^n] f",
        "ⅆ[(x + y)^2] f",
        "ⅆ[w[j]] f =",
        "y := ∂[Aᵀ] f",
    ] {
        roundtrip(text);
    }
}

#[test]
fn derivative_var_expr_and_order_are_stored_in_ast() {
    let parsed = parse_statement("ⅆ[x[i]^2] f").unwrap();
    let StatementKind::ExprRegion { expr } = parsed.kind else {
        panic!("expected ExprRegion");
    };
    match expr.kind {
        ExprKind::Deriv {
            var,
            var_expr,
            order,
            ..
        } => {
            assert!(var.name.segments.iter().all(|s| s.text.is_empty()));
            assert!(matches!(
                var_expr.as_deref().map(|e| &e.kind),
                Some(ExprKind::Index { .. })
            ));
            assert!(order.is_some());
        }
        other => panic!("expected Deriv, got {other:?}"),
    }

    let plain = parse_statement("ⅆ[x^2] f").unwrap();
    let StatementKind::ExprRegion { expr } = plain.kind else {
        panic!("expected ExprRegion");
    };
    assert!(matches!(
        expr.kind,
        ExprKind::Deriv {
            var_expr: None,
            order: Some(_),
            ..
        }
    ));
}

#[test]
fn evaluating_derivative_with_expression_variable_emits_error_and_bare_expression_is_clean() {
    let ws = Worksheet {
        regions: vec![
            Region {
                id: "shown".into(),
                page: 0,
                x: 0.0,
                y: 0.0,
                enabled: true,
                statement: parse_statement("ⅆ[w[j]] f").unwrap().into(),
            },
            Region {
                id: "eval".into(),
                page: 0,
                x: 0.0,
                y: 20.0,
                enabled: true,
                statement: parse_statement("ⅆ[w[j]] f =").unwrap().into(),
            },
        ],
    };
    let generated = generate_worksheet(&ws, GenOptions::default()).unwrap();
    let shown = generated.regions.iter().find(|r| r.id == "shown").unwrap();
    assert!(
        !shown
            .code
            .contains("the variable of a derivative must be a name"),
        "bare expression must not error: {}",
        shown.code
    );
    let eval = generated.regions.iter().find(|r| r.id == "eval").unwrap();
    let eval_code = eval.value.as_deref().unwrap_or(&eval.code);
    assert!(
        eval_code.contains("the variable of a derivative must be a name"),
        "evaluated form must emit error: code={:?} value={:?}",
        eval.code,
        eval.value
    );
}
