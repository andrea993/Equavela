//! Given and Find regions: the assembly of blocks from
//! the reading order, the dependency graph and code generation.

use equavela_core::ast::StatementKind;
use equavela_core::codegen::{generate_worksheet, GenOptions, GeneratedWorksheet};
use equavela_core::graph::{DependencyGraph, Worksheet};
use equavela_core::project::{DocumentId, DocumentRegion};
use equavela_core::worksheet_file::{parse_document, LoadError};
use equavela_core::worksheet_writer::write_document;

/// Two guesses, `Given`, three constraints, the call that defines `s`, and its display.
const SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: r1
    page: 1
    at: [72, 100]
    math: "x := 1"
  - id: r2
    page: 1
    at: [72, 120]
    math: "y := 1"
  - id: g
    page: 1
    at: [72, 140]
    math: "Given"
  - id: c1
    page: 1
    at: [72, 160]
    math: 'x^2 + y^2 == 25'
  - id: c2
    page: 1
    at: [72, 180]
    math: 'y == x'
  - id: c3
    page: 1
    at: [72, 200]
    math: 'x > 0'
  - id: f
    page: 1
    at: [72, 220]
    math: 's := Find(x, y)'
  - id: r4
    page: 1
    at: [72, 260]
    math: "s ="
"#;

fn raw_worksheet(text: &str) -> Result<Worksheet, LoadError> {
    let loaded = parse_document(DocumentId::new("/t.eqv").unwrap(), text)?;
    let regions = loaded
        .document
        .regions
        .into_iter()
        .filter_map(|region| match std::sync::Arc::unwrap_or_clone(region) {
            DocumentRegion::Math(region) => Some(*region),
            _ => None,
        })
        .collect();
    Ok(Worksheet { regions })
}

fn assembled(text: &str) -> Worksheet {
    let mut worksheet = raw_worksheet(text).unwrap();
    worksheet.assemble_solve_blocks();
    worksheet
}

fn generate(text: &str) -> GeneratedWorksheet {
    generate_worksheet(&assembled(text), GenOptions::default()).unwrap()
}

fn constraints_of(worksheet: &Worksheet, id: &str) -> Option<usize> {
    let region = worksheet.regions.iter().find(|r| r.id == id).unwrap();
    match &region.statement.kind {
        StatementKind::Solve { constraints, .. } => Some(constraints.len()),
        _ => None,
    }
}

/// The text of a sheet made of `(id, y, math)` lines.
fn sheet(lines: &[(&str, f64, &str)]) -> String {
    let mut out = String::from("format: equavela-worksheet/3\nregions:\n");
    for (id, y, math) in lines {
        out.push_str(&format!(
            "  - id: {id}\n    page: 1\n    at: [72, {y}]\n    math: '{math}'\n"
        ));
    }
    out
}

fn code_of(generated: &GeneratedWorksheet, id: &str) -> String {
    let region = generated.regions.iter().find(|r| r.id == id).unwrap();
    format!(
        "{}\n{}",
        region.code,
        region.value.clone().unwrap_or_default()
    )
}

#[test]
fn a_block_is_given_constraints_and_the_closing_call() {
    let worksheet = assembled(SHEET);
    assert_eq!(constraints_of(&worksheet, "f"), Some(3));
    // Only the solving region is wrapped; the others stay what they are.
    for id in ["r1", "r2", "g", "c1", "c2", "c3", "r4"] {
        assert_eq!(constraints_of(&worksheet, id), None, "{id}");
    }
}

#[test]
fn assembly_is_idempotent() {
    let once = assembled(SHEET);
    let mut twice = once.clone();
    twice.assemble_solve_blocks();
    assert_eq!(once, twice);
}

#[test]
fn the_regions_stay_flat_in_the_document_and_in_the_file() {
    let loaded = parse_document(DocumentId::new("/t.eqv").unwrap(), SHEET).unwrap();
    assert_eq!(loaded.migrated_from, None);
    for region in &loaded.document.regions {
        let DocumentRegion::Math(region) = region.as_ref() else {
            panic!()
        };
        assert!(!matches!(
            region.statement.kind,
            StatementKind::Solve { .. }
        ));
    }
    let text = write_document(&loaded.document).unwrap();
    assert!(!text.contains("solve"), "{text}");
    assert!(text.contains("math: \"Given\""), "{text}");
    let regions = |t: &str| t.matches("  - id: ").count();
    assert_eq!(regions(&text), regions(SHEET));
}

#[test]
fn reading_order_decides_not_the_order_of_the_file() {
    // The same block with the regions listed upside down.
    let mut lines = vec![
        ("r1", 100.0, "x := 1"),
        ("g", 120.0, "Given"),
        ("c1", 140.0, "x^2 == 9"),
        ("f", 160.0, "Find(x) ="),
    ];
    lines.reverse();
    let worksheet = assembled(&sheet(&lines));
    assert_eq!(constraints_of(&worksheet, "f"), Some(1));
}

#[test]
fn the_block_is_one_unit_in_the_graph() {
    let graph = DependencyGraph::build(&assembled(SHEET)).unwrap();
    // The solving region reads the guesses `x` and `y` through the constraints; `s` is read by r4.
    assert_eq!(graph.dependencies_of("f").unwrap(), ["r1", "r2"]);
    assert_eq!(graph.dependencies_of("r4").unwrap(), ["f"]);
    assert_eq!(
        graph.affected_by(["r1"]).unwrap(),
        ["r1", "c1", "c2", "c3", "f", "r4"]
    );
    assert!(
        graph.unresolved_references().is_empty(),
        "{:?}",
        graph.unresolved_references()
    );
}

#[test]
fn a_name_only_used_in_a_constraint_is_a_dependency_of_the_call() {
    let text = sheet(&[
        ("a", 100.0, "x := 1"),
        ("b", 110.0, "k := 4"),
        ("g", 120.0, "Given"),
        ("c", 130.0, "x * k == 8"),
        ("f", 140.0, "Find(x) ="),
    ]);
    let graph = DependencyGraph::build(&assembled(&text)).unwrap();
    assert_eq!(graph.dependencies_of("f").unwrap(), ["a", "b"]);
}

#[test]
fn an_undefined_name_in_a_constraint_is_reported() {
    let text = SHEET.replace("'y == x'", "'y == zz'");
    let graph = DependencyGraph::build(&assembled(&text)).unwrap();
    let unresolved = graph.unresolved_references();
    assert!(
        unresolved.iter().any(|u| u.region_id == "c2"),
        "{unresolved:?}"
    );
}

#[test]
fn given_itself_is_not_an_undefined_name() {
    let graph = DependencyGraph::build(&assembled(SHEET)).unwrap();
    assert!(graph
        .unresolved_references()
        .iter()
        .all(|u| u.region_id != "g"));
    let generated = generate(SHEET);
    let code = code_of(&generated, "g");
    assert!(!code.contains("eq_error"), "{code}");
}

#[test]
fn definitions_between_given_and_the_call_are_ordinary_definitions() {
    let text = sheet(&[
        ("a", 100.0, "x := 1"),
        ("g", 110.0, "Given"),
        ("d", 120.0, "k := 9"),
        ("c", 130.0, "x^2 == k"),
        ("e", 140.0, "k ="),
        ("f", 150.0, "r := Find(x)"),
    ]);
    let worksheet = assembled(&text);
    // `k := 9` and `k =` are not constraints; `x^2 == k` is the only one.
    assert_eq!(constraints_of(&worksheet, "f"), Some(1));
    let graph = DependencyGraph::build(&worksheet).unwrap();
    assert_eq!(graph.dependencies_of("f").unwrap(), ["a", "d"]);
    let generated = generate(&text);
    assert_eq!(
        generated
            .regions
            .iter()
            .find(|r| r.id == "d")
            .unwrap()
            .defined
            .len(),
        1
    );
}

#[test]
fn generates_find_with_constraint_lambdas() {
    let generated = generate(SHEET);
    let code = code_of(&generated, "f");
    assert!(code.contains("eq_find(["), "{code}");
    assert!(code.contains("eq_constraint(:eq,"), "{code}");
    assert!(code.contains("eq_constraint(:gt,"), "{code}");
    assert!(code.contains("], [x_v1, y_v1])"), "{code}");
    let block = generated.regions.iter().find(|r| r.id == "f").unwrap();
    assert_eq!(block.defined.len(), 1);
    // The constraint regions run nothing of their own.
    for id in ["g", "c1", "c2", "c3"] {
        let region = generated.regions.iter().find(|r| r.id == id).unwrap();
        assert!(region.value.is_none() && region.defined.is_empty(), "{id}");
    }
}

#[test]
fn generates_minimize_with_an_objective() {
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("r2", 110.0, "f(t) := (t - 2)^2"),
        ("g", 120.0, "Given"),
        ("c", 130.0, "x >= 3"),
        ("m", 140.0, "Minimize(f, x) ="),
    ]);
    let generated = generate(&text);
    let block = generated.regions.iter().find(|r| r.id == "m").unwrap();
    let value = block.value.as_deref().unwrap();
    assert!(value.starts_with("eq_minimize("), "{value}");
    assert!(value.contains("eq_constraint(:ge,"), "{value}");
}

#[test]
fn minimize_and_maximize_accept_zero_constraints_after_given() {
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("r2", 110.0, "f(t) := -(t - 2)^2"),
        ("g", 120.0, "Given"),
        ("m", 130.0, "Maximize(f, x) ="),
    ]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "m"), Some(0));
    let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
    let value = generated.regions.iter().find(|r| r.id == "m").unwrap();
    assert!(value.value.as_deref().unwrap().starts_with("eq_maximize("));
}

#[test]
fn minimize_and_maximize_work_without_given() {
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("r2", 110.0, "f(t) := (t - 2)^2"),
        ("r3", 120.0, "h(t) := -(t - 4)^2"),
        ("m1", 130.0, "p_min := Minimize(f, x)"),
        ("m2", 140.0, "maximize(h, x) ="),
        ("g", 150.0, "Given"),
        ("c", 160.0, "x >= 3"),
        ("m3", 170.0, "Minimize(f, x) ="),
    ]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "m1"), Some(0));
    assert_eq!(constraints_of(&worksheet, "m2"), Some(0));
    assert_eq!(constraints_of(&worksheet, "m3"), Some(1));
    let mut twice = worksheet.clone();
    twice.assemble_solve_blocks();
    assert_eq!(worksheet, twice);

    let graph = DependencyGraph::build(&worksheet).unwrap();
    assert!(
        graph.unresolved_references().is_empty(),
        "{:?}",
        graph.unresolved_references()
    );
    assert_eq!(graph.dependencies_of("m1").unwrap(), ["r1", "r2"]);
    assert_eq!(graph.dependencies_of("m2").unwrap(), ["r1", "r3"]);

    let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
    let m1 = code_of(&generated, "m1");
    assert!(m1.contains("eq_minimize(") && m1.contains("[]"), "{m1}");
    assert!(!m1.contains("eq_error"), "{m1}");
    let m2 = code_of(&generated, "m2");
    assert!(m2.contains("eq_maximize(") && m2.contains("[]"), "{m2}");
    assert!(!m2.contains("eq_error"), "{m2}");
    let m3 = code_of(&generated, "m3");
    assert!(
        m3.contains("eq_minimize(") && m3.contains("eq_constraint(:ge,"),
        "{m3}"
    );
}

#[test]
fn a_call_closes_the_block_whatever_the_statement_form() {
    for (call, expected_defined) in [
        ("Find(x) =", 0),
        ("s := Find(x)", 1),
        ("s := 2 * Find(x)", 1),
        ("Minerr(x) =", 0),
        ("f(a) := Find(x)", 1),
    ] {
        let text = sheet(&[
            ("r1", 100.0, "x := 1"),
            ("g", 110.0, "Given"),
            ("c", 120.0, "x == 2"),
            ("f", 130.0, call),
        ]);
        let worksheet = assembled(&text);
        assert_eq!(constraints_of(&worksheet, "f"), Some(1), "{call}");
        let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
        let region = generated.regions.iter().find(|r| r.id == "f").unwrap();
        assert_eq!(region.defined.len(), expected_defined, "{call}");
    }
}

#[test]
fn the_solving_function_names_are_case_insensitive() {
    for (given, call) in [
        ("given", "find(x) ="),
        ("GIVEN", "FIND(x) ="),
        ("Given", "Find(x) ="),
    ] {
        let text = sheet(&[
            ("r1", 100.0, "x := 1"),
            ("g", 110.0, given),
            ("c", 120.0, "x == 2"),
            ("f", 130.0, call),
        ]);
        assert_eq!(
            constraints_of(&assembled(&text), "f"),
            Some(1),
            "{given} {call}"
        );
    }
}

#[test]
fn several_blocks_follow_each_other_and_do_not_share_constraints() {
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("g1", 110.0, "Given"),
        ("c1", 120.0, "x == 2"),
        ("f1", 130.0, "a := Find(x)"),
        ("c2", 140.0, "x == 5"),
        ("g2", 150.0, "Given"),
        ("c3", 160.0, "x == 3"),
        ("c4", 170.0, "x > 0"),
        ("f2", 180.0, "b := Find(x)"),
    ]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "f1"), Some(1));
    // `x == 5` sits between the blocks: it belongs to none.
    assert_eq!(constraints_of(&worksheet, "f2"), Some(2));
}

#[test]
fn a_second_given_is_an_error_on_that_region_and_the_first_block_stays_open() {
    // the second `Given` is marked; the first block keeps collecting.
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("g1", 110.0, "Given"),
        ("c1", 120.0, "x == 2"),
        ("g2", 130.0, "Given"),
        ("c2", 140.0, "x > 0"),
        ("f", 150.0, "Find(x) ="),
    ]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "f"), Some(2));
    assert_eq!(constraints_of(&worksheet, "g2"), Some(0));
    assert_eq!(constraints_of(&worksheet, "g1"), None);
    let mut twice = worksheet.clone();
    twice.assemble_solve_blocks();
    assert_eq!(worksheet, twice);
    let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
    let code = code_of(&generated, "g2");
    assert!(
        code.contains("eq_error") && code.contains("already open"),
        "{code}"
    );
    assert!(code_of(&generated, "f").contains("eq_find"));
    assert!(!code_of(&generated, "g1").contains("eq_error"));
    // After the call the next `Given` is fine again.
    let again = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("g1", 110.0, "Given"),
        ("f", 120.0, "Find(x) ="),
        ("g2", 130.0, "Given"),
    ]);
    assert_eq!(constraints_of(&assembled(&again), "g2"), None);
}

#[test]
fn a_call_without_given_is_an_error_naming_the_rule() {
    let text = sheet(&[("r1", 100.0, "x := 1"), ("f", 110.0, "Find(x) =")]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "f"), None);
    let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
    let code = code_of(&generated, "f");
    assert!(code.contains("eq_error"), "{code}");
    assert!(code.contains("Given"), "{code}");
    assert!(!code.contains("eq_find"), "{code}");
}

#[test]
fn constraints_before_given_or_after_the_call_are_plain_expressions() {
    let text = sheet(&[
        ("r1", 100.0, "x := 1"),
        ("c0", 105.0, "x == 9"),
        ("g", 110.0, "Given"),
        ("c1", 120.0, "x == 2"),
        ("f", 130.0, "Find(x) ="),
        ("c2", 140.0, "x == 7"),
        ("f2", 150.0, "Find(x) ="),
    ]);
    let worksheet = assembled(&text);
    assert_eq!(constraints_of(&worksheet, "f"), Some(1));
    // The second call has no open block: error.
    assert_eq!(constraints_of(&worksheet, "f2"), None);
    let generated = generate_worksheet(&worksheet, GenOptions::default()).unwrap();
    assert!(code_of(&generated, "f2").contains("eq_error"));
}

#[test]
fn a_constraint_that_is_not_a_comparison_is_an_error_on_the_call() {
    let text = SHEET.replace("'x > 0'", "'x + 1'");
    let generated = generate(&text);
    let code = code_of(&generated, "f");
    assert!(code.contains("eq_error"), "{code}");
    assert!(code.contains("compares two expressions"), "{code}");
}

#[test]
fn a_disabled_region_takes_no_part_in_a_block() {
    // A disabled constraint between `Given` and the call is not collected.
    let with_off = SHEET.replace(
        "  - id: f
",
        "  - id: off
    page: 1
    at: [72, 210]
    enabled: false
    math: 'x < 0'
  - id: f
",
    );
    assert_eq!(constraints_of(&assembled(&with_off), "f"), Some(3));
    // A disabled `Given` opens nothing.
    let no_given = SHEET.replace(
        "    math: \"Given\"
",
        "    enabled: false
    math: \"Given\"
",
    );
    assert_eq!(constraints_of(&assembled(&no_given), "f"), None);
}

#[test]
fn a_solve_key_is_not_part_of_version_2() {
    let text = "format: equavela-worksheet/3\nregions:\n  - id: b\n    at: [0, 0]\n    solve:\n      call: 'Find(x)'\n";
    let error = parse_document(DocumentId::new("/t.eqv").unwrap(), text).unwrap_err();
    assert!(error.to_string().contains("`b`"), "{error}");
    assert!(error.to_string().contains("solve"), "{error}");
}

#[test]
#[ignore = "prints the script for a manual end-to-end run"]
fn print_script() {
    println!("{}", generate(SHEET).script());
}
