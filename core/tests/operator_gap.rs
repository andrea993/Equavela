//! Operator gaps use the existing placeholder/juxtaposition worksheet syntax.

use equavela_core::ast::Statement;
use equavela_core::{parse_statement, print_statement};
use serde_json::json;

#[test]
fn frontend_operator_gap_wire_prints_as_a_persistent_incomplete_expression() {
    let name = |text| json!({"type": "Ident", "name": {"segments": [{"text": text, "subscript": false}], "label": null}});
    let wire = json!({"type": "ExprRegion", "expr": {
        "type": "Juxt", "left": {
            "type": "Juxt", "left": name("a"), "right": {"type": "Placeholder"}
        }, "right": name("b")
    }});
    let statement: Statement = serde_json::from_value(wire).unwrap();
    assert_eq!(print_statement(&statement), "a □ b");
    let reopened = parse_statement(&print_statement(&statement)).unwrap();
    assert_eq!(print_statement(&reopened), "a □ b");
}

#[test]
fn operator_gap_grouping_roundtrips() {
    for text in [
        "a □ b",
        "(a + b) □ c",
        "a □ (b + c)",
        "|a| □ b",
        "f(a) □ b",
        "a □ [1 2]",
    ] {
        let parsed = parse_statement(text).unwrap();
        let printed = print_statement(&parsed);
        let reopened = parse_statement(&printed).unwrap();
        assert_eq!(parsed, reopened, "{text}");
        assert_eq!(print_statement(&reopened), printed, "{text}");
        assert!(printed.contains('□'), "{text}");
    }
}
