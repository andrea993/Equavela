use equavela_core::{
    codegen::{generate_expression, Generator},
    parse_expression,
};
use equavela_core::{parse_statement, print_statement};

#[test]
fn integral_placeholder_variable_round_trips() {
    for text in ["∫[□] □", "∫[□ ∈ 1..□] x", "f := ∫[□] x"] {
        let statement = parse_statement(text).unwrap();
        assert_eq!(print_statement(&statement), text);
        assert_eq!(
            parse_statement(&print_statement(&statement)).unwrap(),
            statement
        );
    }
}

#[test]
fn empty_integration_variable_is_an_evaluation_error() {
    for text in ["∫[□] x", "∫[□ ∈ 0..1] x"] {
        let expr = parse_expression(text).unwrap();
        let code = generate_expression(&expr).unwrap();
        assert!(
            code.contains("an empty placeholder cannot be evaluated"),
            "{code}"
        );
    }
}

#[test]
fn other_incomplete_binders_and_keywords_round_trip() {
    for text in [
        "∑[□] □",
        "∑[□ ∈ 1..2] x",
        "∏[□] □",
        "ⅆ[□] □",
        "∂[□] □",
        "\\lim[□, 0] □",
        "program { for □ ∈ 1..2 { □ } }",
        "x →[□, x]",
    ] {
        let statement = parse_statement(text).unwrap_or_else(|error| panic!("{text}: {error}"));
        assert_eq!(print_statement(&statement), text);
        assert_eq!(
            parse_statement(&print_statement(&statement)).unwrap(),
            statement
        );
    }
}

#[test]
fn other_empty_binders_are_evaluation_errors() {
    for text in [
        "∑[□] x",
        "∏[□ ∈ 0..1] x",
        "ⅆ[□] x",
        "∂[□] x",
        "\\lim[□, 0] x",
        "program { for □ ∈ 1..2 { x } }",
    ] {
        let expr = parse_expression(text).unwrap();
        let code = generate_expression(&expr).unwrap();
        assert!(
            code.contains("an empty placeholder cannot be evaluated"),
            "{text}: {code}"
        );
    }
}

#[test]
fn empty_targets_round_trip_and_evaluate_as_errors() {
    for text in [
        "□ := 1",
        "□ ≡ 1",
        "[x, □] := [1, 2]",
        "f(□) := 1",
        "□(x) := x",
    ] {
        let statement = parse_statement(text).unwrap_or_else(|e| panic!("{text}: {e}"));
        assert_eq!(print_statement(&statement), text);
        assert_eq!(
            parse_statement(&print_statement(&statement)).unwrap(),
            statement
        );
        let generated = Generator::default().region("draft", &statement);
        assert!(
            generated
                .code
                .contains("an empty placeholder cannot be evaluated"),
            "{text}: {}",
            generated.code
        );
        assert!(generated.defined.is_empty(), "{text}");
    }
    for text in ["program { □ ← 1 }", "(□ ← 1)"] {
        let statement = parse_statement(text).unwrap_or_else(|e| panic!("{text}: {e}"));
        assert_eq!(print_statement(&statement), text);
        let generated = generate_expression(&parse_expression(text).unwrap()).unwrap();
        assert!(
            generated.contains("an empty placeholder cannot be evaluated"),
            "{text}: {generated}"
        );
    }
}

#[test]
fn incomplete_targets_do_not_publish_definitions() {
    use equavela_core::graph::{DependencyGraph, Region, Worksheet};
    use std::sync::Arc;
    let regions = ["□ := 1", "[x, □] := [1, 2]", "f(□) := 1"]
        .iter()
        .enumerate()
        .map(|(i, text)| Region {
            id: format!("r{i}"),
            page: 0,
            x: 0.0,
            y: i as f64,
            enabled: true,
            statement: Arc::new(parse_statement(text).unwrap()),
        })
        .collect();
    let graph = DependencyGraph::build(&Worksheet { regions }).unwrap();
    assert!(graph.definitions().is_empty());
}

#[test]
fn worksheet_save_and_reload_preserves_draft_placeholders() {
    use equavela_core::project::DocumentId;
    use equavela_core::worksheet_file::parse_document;
    use equavela_core::worksheet_writer::write_document;
    let forms = ["∫[□ ∈ 1..□] □", "□ := 1", "f(□) := 1"];
    let mut source = String::from("format: equavela-worksheet/3\nregions:\n");
    for (i, math) in forms.iter().enumerate() {
        source.push_str(&format!(
            "  - id: r{i}\n    at: [0, {}]\n    math: '{math}'\n",
            i * 20
        ));
    }
    let id = DocumentId::new("/t/drafts.eqv").unwrap();
    let once = write_document(&parse_document(id.clone(), &source).unwrap().document).unwrap();
    for math in forms {
        assert!(once.contains(math), "missing {math}: {once}");
    }
    let twice = write_document(&parse_document(id, &once).unwrap().document).unwrap();
    assert_eq!(once, twice);
}
