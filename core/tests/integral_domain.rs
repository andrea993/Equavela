//! Display-only integral over a domain (`∫[V ∈ Ω] ρ`, `∫[m ∈ m] r^2`): parser, printer,
//! round-trip, AST storage, and evaluation error.

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
fn integral_over_domain_round_trips() {
    for text in [
        "∫[V ∈ Ω] ρ",
        "∫[m ∈ m] r^2",
        "∫[S ∈ S_0] f(x)",
        "∫[V ∈ A + B] ρ",
        "∫[V ∈ Ω] ρ =",
        "M := ∫[V ∈ Ω] ρ",
        // Existing definite and indefinite forms stay untouched.
        "∫[x ∈ 0..1] x^2",
        "∫[x] x^2",
    ] {
        roundtrip(text);
    }
}

#[test]
fn integral_domain_is_stored_in_ast_separately_from_bounds() {
    let parsed = parse_statement("∫[V ∈ Ω] ρ").unwrap();
    let StatementKind::ExprRegion { expr } = parsed.kind else {
        panic!("expected ExprRegion");
    };
    assert!(matches!(
        expr.kind,
        ExprKind::Integral {
            bounds: None,
            domain: Some(_),
            ..
        }
    ));

    let definite = parse_statement("∫[x ∈ 0..1] x").unwrap();
    let StatementKind::ExprRegion { expr } = definite.kind else {
        panic!("expected ExprRegion");
    };
    assert!(matches!(
        expr.kind,
        ExprKind::Integral {
            bounds: Some(_),
            domain: None,
            ..
        }
    ));
}

#[test]
fn evaluating_domain_integral_emits_error_and_bare_expression_is_clean() {
    let ws = Worksheet {
        regions: vec![
            Region {
                id: "shown".into(),
                page: 0,
                x: 0.0,
                y: 0.0,
                enabled: true,
                statement: parse_statement("∫[V ∈ Ω] ρ").unwrap().into(),
            },
            Region {
                id: "eval".into(),
                page: 0,
                x: 0.0,
                y: 20.0,
                enabled: true,
                statement: parse_statement("∫[V ∈ Ω] ρ =").unwrap().into(),
            },
        ],
    };
    let generated = generate_worksheet(&ws, GenOptions::default()).unwrap();
    let shown = generated.regions.iter().find(|r| r.id == "shown").unwrap();
    assert!(
        !shown
            .code
            .contains("an integral over a domain cannot be evaluated"),
        "bare expression must not error: {}",
        shown.code
    );
    let eval = generated.regions.iter().find(|r| r.id == "eval").unwrap();
    let eval_code = eval.value.as_deref().unwrap_or(&eval.code);
    assert!(
        eval_code.contains("an integral over a domain cannot be evaluated"),
        "evaluated form must emit error: code={:?} value={:?}",
        eval.code,
        eval.value
    );
}
