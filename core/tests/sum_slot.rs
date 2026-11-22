//! The lower slot of `∑` and `∏`: parser and printer keep what
//! was typed; the bounded, the index-only and the free slot forms are told apart; only the first
//! two evaluate, and a condition in the slot has its own error.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use equavela_core::ast::{BoundGlyph, ExprKind, StatementKind};
use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::DocumentId;
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::{load_project_text, parse_document};
use equavela_core::worksheet_writer::write_document;
use equavela_core::{parse_statement, print_statement};

fn roundtrip(text: &str) {
    let parsed = parse_statement(text).unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"));
    assert_eq!(print_statement(&parsed), text, "printing `{text}`");
    let again = parse_statement(&print_statement(&parsed)).unwrap();
    assert_eq!(parsed, again, "re-parsing `{text}`");
}

#[test]
fn every_slot_form_round_trips_byte_for_byte() {
    for text in [
        "∑[i] x[i]",
        "∑[i ∈ 1..n] i",
        "∑[i = 1..n] i",
        "∑[i := 1..n] i",
        "∏[i ∈ 1..n] i",
        "∏[i = 1..n] i",
        "∏[i := 1..n] i",
        // free slots: any expression, kept as typed
        "∑[j ≠ k] j",
        "∑[j!] j",
        "∑[j ∈ S] j",
        "∑[j < 5] j",
        "∏[j ≠ k] j",
        "∑[j! = k..□] j",
        "∑[j ≠ i = 1..n] j",
        "∏[j! := 2..n] j",
        "y := ∑[j!] j",
        "∑[j!] j =",
    ] {
        roundtrip(text);
    }
}

#[test]
fn every_relational_condition_round_trips_byte_for_byte() {
    // The display-only conditions of a worksheet: each relation, on both glyphs.
    for relation in ["≠", "<", ">", "≤", "≥", "==", "∈"] {
        for glyph in ["∑", "∏"] {
            roundtrip(&format!("{glyph}[i {relation} j] a[i]"));
            // A condition may carry bounds after it and still be kept as typed.
            roundtrip(&format!("{glyph}[i {relation} j = 1..n] a[i]"));
        }
    }
    // The operands are ordinary expressions, chains are kept, and the rest of the region is
    // untouched.
    for text in [
        "∑[f(i) ≤ g(j)] h(i)",
        "∑[i + 1 ≠ n/2] a[i]",
        "∑[-i < j] a[i]",
        "∑[i < j < k] a[i]",
        "∑[i ≠ j ≠ k] a[i]",
        "∑[i ≤ j < k] a[i]",
        "x := ∑[i = 1..n] ∑[j ≤ i] a[j]",
        "∑[i ≤ j] a[i] =",
    ] {
        roundtrip(text);
    }
}

#[test]
fn the_glyph_and_the_free_slot_are_stored_in_the_ast() {
    let glyph = |text: &str| match parse_statement(text).unwrap().kind {
        StatementKind::ExprRegion { expr } => match expr.kind {
            ExprKind::Sum {
                bounds: Some(b),
                index,
                ..
            } => (b.glyph, index.is_some()),
            other => panic!("not a bounded sum: {other:?}"),
        },
        other => panic!("{other:?}"),
    };
    assert_eq!(glyph("∑[i ∈ 1..n] i"), (BoundGlyph::In, false));
    assert_eq!(glyph("∑[i = 1..n] i"), (BoundGlyph::Equals, false));
    assert_eq!(glyph("∑[i := 1..n] i"), (BoundGlyph::Define, false));
    assert_eq!(glyph("∑[j! = 1..n] j"), (BoundGlyph::Equals, true));
    // A free slot has the empty name as its variable.
    let free = match parse_statement("∑[j ≠ k] j").unwrap().kind {
        StatementKind::ExprRegion { expr } => expr,
        other => panic!("{other:?}"),
    };
    assert!(matches!(
        free.kind,
        ExprKind::Sum {
            index: Some(_),
            bounds: None,
            ..
        }
    ));
    // The index-only form keeps the index as the variable and has no bounds.
    let index_only = match parse_statement("∑[i] i").unwrap().kind {
        StatementKind::ExprRegion { expr } => expr,
        other => panic!("{other:?}"),
    };
    assert!(matches!(
        index_only.kind,
        ExprKind::Sum {
            index: None,
            bounds: None,
            ..
        }
    ));
}

#[test]
fn a_slot_without_the_range_after_the_glyph_is_a_syntax_error() {
    assert!(parse_statement("∑[i = 1] i").is_err());
    assert!(parse_statement("∑[] i").is_err());
}

const SHEET: &str = "format: equavela-worksheet/3
regions:
  - id: n
    at: [0, 1]
    math: 'n := 4'
  - id: rng
    at: [0, 10]
    math: 'i := 0..4'
  - id: eq
    at: [0, 20]
    math: '∑[i = 1..n] i ='
  - id: def
    at: [0, 40]
    math: '∑[i := 1..n] i ='
  - id: prod_eq
    at: [0, 60]
    math: '∏[i = 1..n] i ='
  - id: prod_def
    at: [0, 80]
    math: '∏[i := 1..n] i ='
  - id: range_sum
    at: [0, 90]
    math: '∑[i] i ='
  - id: range_prod
    at: [0, 95]
    math: '∏[i] (i + 1) ='
  - id: not_range
    at: [0, 98]
    math: '∑[k] k ='
  - id: shown
    at: [0, 100]
    math: '∑[j ≠ 2] j'
  - id: cond_shown
    at: [0, 110]
    math: '∑[i ≤ j] i'
  - id: text
    at: [0, 120]
    text: 'Shown only: $∑[j!] j$ and evaluated: $∑[j ≠ 2] j =$.'
  - id: bad_sum
    at: [0, 140]
    math: '∑[j ≠ 2] j ='
  - id: bad_prod
    at: [0, 160]
    math: '∏[j! = 1..n] j ='
  - id: bad_cond_prod
    at: [0, 170]
    math: '∏[j > 2] j ='
  - id: bad_cond_bounds
    at: [0, 180]
    math: '∑[j ≠ k = 1..n] j ='
  - id: bad_member
    at: [0, 190]
    math: '∑[j ∈ S] j ='
  - id: bad_cond_eq
    at: [0, 195]
    math: '∑[j == k] j ='
";

fn real(state: Option<RegionState>) -> f64 {
    match state {
        Some(RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        }) => value.as_f64(),
        other => panic!("unexpected result: {other:?}"),
    }
}

fn error_message(state: Option<RegionState>) -> String {
    match state {
        Some(RegionState::Error { failure }) => failure.message,
        other => panic!("expected an error, got {other:?}"),
    }
}

#[test]
fn index_forms_evaluate_equally_and_free_slots_only_fail_when_evaluated() {
    if std::process::Command::new("julia")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let root_path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut config = KernelConfig::new(root_path.join("kernel/EquavelaKernel"));
    config.startup_timeout = Duration::from_secs(300);
    let id = DocumentId::new("/sum.eqv").unwrap();
    let loaded = load_project_text(id.clone(), SHEET).unwrap();
    let mut session = WorksheetSession::new(
        Arc::new(KernelManager::new(config)),
        "sum-test",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let get = |region: &str| {
        session.results().get(&RegionKey {
            document: id.clone(),
            region_id: region.into(),
            instance: 0,
        })
    };
    assert_eq!(real(get("eq")), 10.0);
    assert_eq!(real(get("def")), 10.0);
    assert_eq!(real(get("prod_eq")), 24.0);
    assert_eq!(real(get("prod_def")), 24.0);
    // index only, over the values of the range variable.
    assert_eq!(real(get("range_sum")), 10.0);
    assert_eq!(real(get("range_prod")), 120.0);
    assert_eq!(error_message(get("not_range")), "k is not a range variable");
    // Displayed only: no error, no value.
    assert!(!matches!(get("shown"), Some(RegionState::Error { .. })));
    assert!(!matches!(
        get("cond_shown"),
        Some(RegionState::Error { .. })
    ));
    // evaluated, a condition says so; nothing is stripped.
    assert_eq!(
        error_message(get("bad_sum")),
        "the condition of the sum cannot be evaluated"
    );
    assert_eq!(
        error_message(get("bad_cond_prod")),
        "the condition of the product cannot be evaluated"
    );
    // Bounds after the condition do not make it evaluable.
    assert_eq!(
        error_message(get("bad_cond_bounds")),
        "the condition of the sum cannot be evaluated"
    );
    // Membership and the Boolean equality are conditions too.
    assert_eq!(
        error_message(get("bad_member")),
        "the condition of the sum cannot be evaluated"
    );
    assert_eq!(
        error_message(get("bad_cond_eq")),
        "the condition of the sum cannot be evaluated"
    );
    // Any other free slot keeps its own message.
    assert_eq!(
        error_message(get("bad_prod")),
        "the lower limit of the product must be i = start or a range variable"
    );
    // Inline math: the evaluated run fails, the bare one (index 0) is not evaluated.
    assert!(get(&equavela_core::richtext::inline_region_id("text", 0)).is_none());
    assert_eq!(
        error_message(get(&equavela_core::richtext::inline_region_id("text", 1))),
        "the condition of the sum cannot be evaluated"
    );
}

#[test]
fn a_worksheet_with_conditions_and_an_index_only_sum_is_saved_and_reloaded_unchanged() {
    let forms = [
        "∑[i ≠ j] a[i]",
        "∑[i < j] a[i]",
        "∑[i > j] a[i]",
        "∑[i ≤ j] a[i]",
        "∑[i ≥ j] a[i]",
        "∏[i ≠ j] a[i]",
        "∑[i] i =",
        "i := 0..4",
    ];
    let mut source = String::from("format: equavela-worksheet/3\nregions:\n");
    for (n, math) in forms.iter().enumerate() {
        source.push_str(&format!(
            "  - id: r{n}\n    at: [0, {}]\n    math: '{math}'\n",
            n * 20
        ));
    }
    // The file the writer produces reads back to the same model and the same text, so a
    // condition and an index-only sum survive a save and a reload unchanged.
    let id = DocumentId::new("/t/conditions.eqv").unwrap();
    let once = write_document(&parse_document(id.clone(), &source).unwrap().document).unwrap();
    for math in forms {
        assert!(once.contains(math), "`{math}` missing from\n{once}");
    }
    let twice = write_document(&parse_document(id, &once).unwrap().document).unwrap();
    assert_eq!(once, twice, "saving twice changes the file");
}
