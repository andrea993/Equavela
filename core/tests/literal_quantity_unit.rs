//! The unit written in a literal quantity, which the side panel shows a definition's value in.

use equavela_core::ast::StatementKind;
use equavela_core::syntax::{parse_statement, print_expression};
use equavela_core::units::literal_quantity_unit;

fn unit_of(text: &str) -> Option<String> {
    let statement = parse_statement(text).expect("parses");
    let StatementKind::Define { rhs, .. } = statement.kind else {
        panic!("not a definition")
    };
    literal_quantity_unit(&rhs).map(|unit| print_expression(&unit))
}

#[test]
fn literal_quantities_give_their_unit_without_labels() {
    assert_eq!(unit_of("q := 12 kN@unit/m@unit").as_deref(), Some("kN/m"));
    assert_eq!(unit_of("L := 3.5 m@unit").as_deref(), Some("m"));
    assert_eq!(unit_of("F := -2 N@unit").as_deref(), Some("N"));
    assert_eq!(unit_of("A := 4 m@unit^2").as_deref(), Some("m^2"));
    assert_eq!(unit_of("x := [1; 2]·m@unit").as_deref(), Some("m"));
}

#[test]
fn anything_else_has_no_written_unit() {
    assert_eq!(unit_of("n := 12"), None);
    assert_eq!(unit_of("y := L·2"), None);
    assert_eq!(unit_of("z := 2 m@unit + 3 m@unit"), None);
}
