//! the specification: input tables as math statements.
use equavela_core::ast::StatementKind;
use equavela_core::syntax::print_statement;
use equavela_core::table::column_definitions;

#[test]
fn a_table_reads_and_prints_as_linear_text() {
    for text in [
        "table:[a, b; 1, 2; 3, 4]",
        "table units:[a, b; m, s; 1, 2; 3, 4]",
        "table:[x_1; 1 + 2]",
    ] {
        let statement = equavela_core::parse_statement(text).unwrap();
        assert!(
            matches!(statement.kind, StatementKind::Table { .. }),
            "{text}"
        );
        assert_eq!(print_statement(&statement), text);
    }
    // A name `table` keeps its meaning elsewhere; a table needs a name row and a value row.
    assert!(matches!(
        equavela_core::parse_statement("table := 3").unwrap().kind,
        StatementKind::Define { .. }
    ));
    assert!(equavela_core::parse_statement("table:[a, b]").is_err());
    assert!(equavela_core::parse_statement("table units:[a; m]").is_err());
    assert!(equavela_core::parse_statement("table:3").is_err());
}

#[test]
fn named_complete_columns_define_column_vectors() {
    let statement =
        equavela_core::parse_statement("table units:[F, L, □; kN, m, □; 1, 2, 5; 3, □, 6]")
            .unwrap();
    let (definitions, problems) = column_definitions(&statement);
    let printed: Vec<String> = definitions
        .iter()
        .map(|(column, s)| format!("{column}: {}", print_statement(s)))
        .collect();
    // F is complete with a unit; L has an empty value; the third column has no name.
    assert_eq!(printed, ["0: F := [1; 3]·kN@unit"]);
    assert!(problems.is_empty(), "{problems:?}");
}

#[test]
fn headers_that_are_not_names_are_reported_and_define_nothing() {
    // `A:` or `."A"` cannot even be typed as math; what parses but is not a name is refused.
    let statement =
        equavela_core::parse_statement("table:[a + 1, 2, b, b, f(x); 1, 2, 3, 4, 5]").unwrap();
    let (definitions, problems) = column_definitions(&statement);
    let defined: Vec<usize> = definitions.iter().map(|(column, _)| *column).collect();
    assert_eq!(defined, [2]);
    let reasons: Vec<(usize, &str)> = problems
        .iter()
        .map(|(column, reason)| (*column, reason.as_str()))
        .collect();
    assert_eq!(
        reasons,
        [
            (0, "the header must be a name"),
            (1, "the header must be a name"),
            (3, "`b` names another column too"),
            (4, "the header must be a name")
        ]
    );
    let unknown = equavela_core::parse_statement("table units:[a; parsec2; 1]").unwrap();
    let (definitions, problems) = column_definitions(&unknown);
    assert!(definitions.is_empty());
    assert_eq!(problems[0].1, "`parsec2` is not a known unit");
}
