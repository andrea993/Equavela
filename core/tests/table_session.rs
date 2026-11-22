use equavela_core::{
    codegen::GenOptions,
    kernel_manager::{KernelConfig, KernelManager},
    kernel_value::KernelValue,
    project::DocumentId,
    session::{RecalcMode, RegionKey, RegionState, WorksheetSession},
    worksheet_file::load_project_text,
};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn table_columns_feed_calculations_and_edits_recalculate() {
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
    let id = DocumentId::new("/table.eqv").unwrap();
    let text = "format: equavela-worksheet/3\nregions:\n  - id: prior\n    at: [0, 1]\n    math: 'x := [9; 10]'\n  - id: t\n    at: [0, 10]\n    table:\n      columns:\n        - name: x\n          cells: ['1', '2']\n  - id: result\n    at: [0, 40]\n    math: 'x[0 + ORIGIN] + x[1 + ORIGIN] ='\n";
    let loaded = load_project_text(id.clone(), text).unwrap();
    let mut session = WorksheetSession::new(
        Arc::new(KernelManager::new(config)),
        "table-test",
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
        region_id: "result".into(),
        instance: 0,
    };
    let value = || match session.results().get(&key).unwrap() {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("unexpected result: {other:?}"),
    };
    assert_eq!(value(), 3.0);
    // the converted table is a math region; editing it is editing its math.
    session.edit_math(&id, "t", "table:[x; 3; 4]").unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    match session.results().get(&key).unwrap() {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => assert_eq!(value.as_f64(), 7.0),
        other => panic!("unexpected result: {other:?}"),
    }
    // A column unit is a unit context: the column is multiplied by it.
    session
        .edit_math(&id, "t", "table units:[x; m; 3; 4]")
        .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    match session.results().get(&key).unwrap() {
        RegionState::Value {
            value:
                Some(KernelValue::Quantity {
                    magnitude,
                    dimension,
                }),
            ..
        } => {
            assert_eq!(
                serde_json::to_value(magnitude).unwrap(),
                serde_json::json!({"type": "real", "value": 7.0})
            );
            assert_eq!(
                serde_json::to_value(dimension).unwrap(),
                serde_json::json!([{"base": "length", "power": [1, 1]}])
            );
        }
        other => panic!("a column unit must multiply the column: {other:?}"),
    }
    // An unknown unit: the column defines nothing, so the earlier `x` is the one in effect.
    session
        .edit_math(&id, "t", "table units:[x; parsec2; 3; 4]")
        .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    match session.results().get(&key).unwrap() {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => assert_eq!(value.as_f64(), 19.0),
        other => panic!("invalid unit must leave the earlier definition in effect: {other:?}"),
    }
    for _ in 0..3 {
        session.undo().unwrap().unwrap();
    }
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    match session.results().get(&key).unwrap() {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => assert_eq!(value.as_f64(), 3.0),
        other => panic!("unexpected undo result: {other:?}"),
    }
    assert!(session
        .results()
        .snapshot()
        .iter()
        .all(|entry| !entry.key.region_id.contains('\u{1e}')));
}
