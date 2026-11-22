//! Inline math in text regions is evaluated.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::edit::EditCommand;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::DocumentId;
use equavela_core::richtext::inline_region_id;
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::load_project_text;

const SHEET: &str = "format: equavela-worksheet/3
regions:
  - id: above
    at: [0, 1]
    math: 'a + 1 ='
  - id: t
    at: [0, 10]
    text: 'The gain $a := 3$ and the double $b := 2·a =$ with the unit $V$ and the bare $a$.'
  - id: below
    at: [0, 40]
    math: 'a + b ='
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

#[test]
fn inline_definitions_and_evaluations_feed_the_worksheet() {
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
    let id = DocumentId::new("/inline.eqv").unwrap();
    let loaded = load_project_text(id.clone(), SHEET).unwrap();
    let mut session = WorksheetSession::new(
        Arc::new(KernelManager::new(config)),
        "inline-test",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let key = |region: &str| RegionKey {
        document: id.clone(),
        region_id: region.into(),
        instance: 0,
    };
    // the run `b` sees the run `a` before it, and the region below sees both.
    assert_eq!(real(session.results().get(&key("below"))), 9.0);
    // the key of the n-th math run counts every math run (here `b` is the second).
    assert_eq!(
        real(session.results().get(&key(&inline_region_id("t", 1)))),
        6.0
    );
    // A region above the sentence does not see the definition.
    assert!(matches!(
        session.results().get(&key("above")),
        Some(RegionState::Error { .. })
    ));
    // The bare expressions (`V`, `a`) are not evaluated.
    assert!(session
        .results()
        .get(&key(&inline_region_id("t", 2)))
        .is_none());
    assert!(session
        .results()
        .get(&key(&inline_region_id("t", 3)))
        .is_none());
    // editing the text re-evaluates the dependents.
    session
        .apply_edit(
            &id,
            "Edit text",
            EditCommand::SetText {
                region_id: "t".into(),
                text: "The gain $a := 5$ and the double $b := 2·a =$.".into(),
            },
        )
        .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert_eq!(real(session.results().get(&key("below"))), 15.0);
}

/// `matrix(m, n, f)` takes a worksheet function by name.
#[test]
fn matrix_builds_from_a_worksheet_function() {
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
    let id = DocumentId::new("/matrix.eqv").unwrap();
    let sheet = "format: equavela-worksheet/3
regions:
  - id: f
    at: [0, 1]
    math: 'g.el(k, m) := 10·k + m'
  - id: s
    at: [0, 20]
    math: 's := matrix(2, 3, g.el)'
  - id: v
    at: [0, 40]
    math: 's[1, 2] ='
";
    let loaded = load_project_text(id.clone(), sheet).unwrap();
    let mut session = WorksheetSession::new(
        Arc::new(KernelManager::new(config)),
        "matrix-test",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let key = RegionKey {
        document: id.clone(),
        region_id: "v".into(),
        instance: 0,
    };
    assert_eq!(real(session.results().get(&key)), 12.0);
}
