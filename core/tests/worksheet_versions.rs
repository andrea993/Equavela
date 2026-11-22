//! File-format versions and migrations.
//!
//! One golden pair per released format: the old file and the canonical current text it must be
//! rewritten to. Set `UPDATE_GOLDEN=1` to (re)create a missing expected file, then review it.

use equavela_core::project::DocumentId;
use equavela_core::worksheet_file::{
    migration_step_count, parse_document, LoadError, CURRENT_VERSION,
};
use equavela_core::worksheet_writer::write_document;
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worksheet-versions")
}

fn id(name: &str) -> DocumentId {
    DocumentId::new(&format!("/t/{name}")).unwrap()
}

/// Golden: `<file>` is read, its version is checked, the writer output equals the expected file.
fn golden(file: &str, expected: &str, migrated_from: Option<u32>) {
    let text = std::fs::read_to_string(dir().join(file)).unwrap();
    let loaded = parse_document(id(file), &text).unwrap_or_else(|e| panic!("{file}: {e}"));
    assert_eq!(loaded.migrated_from, migrated_from, "{file}");
    let out = write_document(&loaded.document).unwrap();
    let path = dir().join(expected);
    if !path.exists() && std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &out).unwrap();
    }
    let want = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(out, want, "{file} must be rewritten to {expected}");
    // the rewritten text is current: it reads back without migration to the same model
    let again = parse_document(id(expected), &out).unwrap();
    assert_eq!(again.migrated_from, None);
    assert_eq!(write_document(&again.document).unwrap(), out);
}

#[test]
fn version_0_does_not_exist_any_more() {
    // nothing was released before version 1, so the files of the development spellings
    // (no identity line, `format: sheet/1`) are not worksheets and nothing migrates from 0.
    for text in [
        "regions: []\n",
        "format: sheet/1\nregions: []\n",
        "format: equavela-worksheet/0\nregions: []\n",
    ] {
        parse_document(id("v0.eqv"), text).unwrap_err();
    }
}

#[test]
fn version_1_is_migrated_and_rewritten_as_the_current_version() {
    // Only the identity line differs: this file has no solve block, the step changes nothing else.
    golden("v1-current.eqv", "v1-current.expected.eqv", Some(1));
    let a = std::fs::read_to_string(dir().join("v1-current.eqv")).unwrap();
    let b = std::fs::read_to_string(dir().join("v1-current.expected.eqv")).unwrap();
    assert_eq!(
        a.replace("\r\n", "\n")
            .replacen("worksheet/1", "worksheet/3", 1),
        b.replace("\r\n", "\n")
    );
}

/// boxed solve blocks of version 1 become Given, constraint and call regions.
#[test]
fn version_1_boxed_solve_blocks_become_flat_regions() {
    golden("v1-solve-block.eqv", "v1-solve-block.expected.eqv", Some(1));
}

#[test]
fn the_migrated_solve_block_means_the_same_to_the_analysis() {
    use equavela_core::ast::StatementKind;
    use equavela_core::graph::Worksheet;
    use equavela_core::project::DocumentRegion;
    let text = std::fs::read_to_string(dir().join("v1-solve-block.eqv")).unwrap();
    let loaded = parse_document(id("v1-solve-block.eqv"), &text).unwrap();
    let regions = loaded
        .document
        .regions
        .into_iter()
        .filter_map(|region| match std::sync::Arc::unwrap_or_clone(region) {
            DocumentRegion::Math(region) => Some(*region),
            _ => None,
        })
        .collect();
    let mut worksheet = Worksheet { regions };
    worksheet.assemble_solve_blocks();
    let call = worksheet
        .regions
        .iter()
        .find(|r| r.id == "r3-call")
        .unwrap();
    let StatementKind::Solve { constraints, .. } = &call.statement.kind else {
        panic!("the call region closes the migrated block");
    };
    assert_eq!(constraints.len(), 3);
}

#[test]
fn a_migration_that_would_reuse_an_id_fails_and_loads_nothing() {
    let text = "format: equavela-worksheet/1\nregions:\n  - id: b\n    at: [0, 0]\n    solve:\n      call: 'Find(x)'\n  - id: b-call\n    at: [0, 100]\n    math: \"x := 1\"\n";
    let error = parse_document(id("clash.eqv"), text).unwrap_err();
    assert!(matches!(error, LoadError::Yaml { .. }), "{error}");
    assert!(error.to_string().contains("b-call"), "{error}");
}

#[test]
fn a_solve_key_in_a_version_2_file_is_refused() {
    let text = "format: equavela-worksheet/2\nregions:\n  - id: b\n    at: [0, 0]\n    solve:\n      call: 'Find(x)'\n";
    let error = parse_document(id("v2.eqv"), text).unwrap_err();
    assert!(matches!(error, LoadError::SolveRegion { .. }), "{error}");
}

/// step `2 -> 3`: the units a version 2 file resolved by context become labelled, and
/// every name a definition can capture keeps its plain text.
#[test]
fn version_2_units_are_labelled_and_definitions_are_left_alone() {
    golden("v2-units.eqv", "v2-units.expected.eqv", Some(2));
    let text = std::fs::read_to_string(dir().join("v2-units.expected.eqv")).unwrap();
    // a value position is labelled
    assert!(text.contains("math: \"L := 3.5 m@unit\""), "{text}");
    assert!(text.contains("math: \"F := 2 kN@unit·m@unit\""), "{text}");
    // the unit context of an evaluation stays plain
    assert!(text.contains("math: \"F = … kN·m\""), "{text}");
    // a name the file defines anywhere keeps its plain text, even above its definition
    assert!(text.contains("math: \"s := 3\""), "{text}");
    assert!(text.contains("math: \"y := s + 1\""), "{text}");
    // a parameter and a binder capture their name
    assert!(text.contains("math: \"f(s) := 2·s\""), "{text}");
    assert!(text.contains("math: \"∑[s ∈ 1..3] s\""), "{text}");
    // the inline math of a text region is migrated too, and the text around it is untouched
    assert!(
        text.contains("text: \"A length $x := 3.5 m@unit$ and a plain $3 s$\""),
        "{text}"
    );
    // The migrated model is what the current version would have written: every unit name of a value
    // position carries its label, so the meaning of each region is the one version 2 gave it.
    let loaded = parse_document(
        id("v2-units.eqv"),
        &std::fs::read_to_string(dir().join("v2-units.eqv")).unwrap(),
    )
    .expect("the file loads");
    assert_eq!(loaded.migrated_from, Some(2));
    assert_eq!(
        loaded.texts.get("r1").map(String::as_str),
        Some("L := 3.5 m@unit")
    );
}

#[test]
fn every_version_above_the_first_has_a_migrate_step() {
    assert_eq!(CURRENT_VERSION, 3);
    assert_eq!(migration_step_count() as u32, CURRENT_VERSION - 1);
}

#[test]
fn a_newer_file_is_refused_before_anything_is_loaded() {
    // a valid body that would load fine: the refusal comes from the version alone
    let body = "regions:\n  - id: m\n    at: [0, 0]\n    math: \"x := 1\"\n";
    let next = CURRENT_VERSION + 1;
    for (name, text) in [
        (
            "/t/new.eqv",
            format!("format: equavela-worksheet/{next}\n{body}"),
        ),
        (
            "/t/new.eqv",
            format!("format: equavela-worksheet/{}\n{body}", next + 40),
        ),
        // a newer file whose body this version could not even parse
        (
            "/t/new.eqv",
            format!(
                "format: equavela-worksheet/{next}\nregions: [{{id: x, quantum: 1}}]\nnot yaml: [\n"
            ),
        ),
    ] {
        let error = parse_document(DocumentId::new(name).unwrap(), &text).unwrap_err();
        assert!(
            matches!(error, LoadError::NewerVersion { .. }),
            "{text:?}: {error}"
        );
        let message = error.to_string();
        assert!(
            message.starts_with("unsupported worksheet format"),
            "{message}"
        );
        assert!(
            message.contains("newer version of the application"),
            "{message}"
        );
        assert!(message.contains(name), "{message}");
        assert!(message.contains(&format!("this application reads up to {CURRENT_VERSION}")));
    }
}

#[test]
fn malformed_versions_are_unsupported_not_newer() {
    for value in [
        "equavela-worksheet/0",
        "equavela-worksheet/01",
        "equavela-worksheet/-1",
        "equavela-worksheet/+1",
        "equavela-worksheet/x",
        "equavela-worksheet/",
        "equavela-worksheet/1.0",
        "equavela-worksheet/99999999999999999999",
    ] {
        let text = format!("format: {value}\nregions: []\n");
        let error = parse_document(id("a.eqv"), &text).unwrap_err();
        assert!(
            matches!(error, LoadError::UnsupportedFormat { .. }),
            "{value}: {error}"
        );
        assert!(error.to_string().contains(value), "{error}");
    }
}

#[test]
fn a_document_that_is_not_a_mapping_is_not_a_worksheet() {
    for text in ["just text\n", "- a\n- b\n", ""] {
        let error = parse_document(id("bad.eqv"), text).unwrap_err();
        assert!(
            matches!(error, LoadError::NotAWorksheet { .. }),
            "{text:?}: {error}"
        );
    }
}

/// Scalars keep the text the file wrote: an id `y` is not a Boolean.
#[test]
fn yaml_1_1_looking_ids_stay_strings() {
    let text = "format: equavela-worksheet/3\nregions:\n  - id: y\n    at: [0, 0]\n    math: \"k := 1\"\n  - id: no\n    at: [0, 10]\n    math: \"j := 2\"\n";
    let loaded = parse_document(id("ids.eqv"), text).unwrap();
    assert_eq!(loaded.migrated_from, None);
    assert!(loaded.texts.contains_key("y") && loaded.texts.contains_key("no"));
}

/// a called name is a function, never a unit, so the migration leaves `g(2)` (g is the gram)
/// plain, while a value `g` becomes `g@unit`.
#[test]
fn version_2_migration_never_labels_a_callee() {
    let text = "format: equavela-worksheet/2\nregions:\n  - id: r1\n    at: [0, 0]\n    math: \"y := g(2) + 3 g\"\n";
    let loaded = parse_document(id("callee.eqv"), text).expect("the file loads");
    assert_eq!(
        loaded.texts.get("r1").map(String::as_str),
        Some("y := g(2) + 3 g@unit")
    );
}
