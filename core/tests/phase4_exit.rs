//! Phase 4 exit criterion: `x := 3 m`, `y := x^2`,
//! `y =` shows `9 m^2`. The worksheet goes through the whole stack: parser, dependency graph,
//! code generator, the real Julia kernel and the session's result map. Skipped (with a
//! message) when `julia` is not on PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::graph::Region;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::parse_statement;
use equavela_core::project::{
    CalculationSettings, DocumentId, DocumentRegion, Project, ProjectDocument,
};
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn julia_available() -> bool {
    std::process::Command::new("julia")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[test]
fn x_3_m_y_x_squared_shows_9_square_metres() {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    // The SymPy warm-up is not needed here and would delay the kernel shutdown.
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(180);
    let kernel = Arc::new(KernelManager::new(config));

    let id = DocumentId::new("/root.eqv").unwrap();
    let math = [("x", "x := 3 m@unit"), ("y", "y := x^2"), ("show", "y =")];
    let regions = math
        .iter()
        .enumerate()
        .map(|(i, (region_id, text))| {
            DocumentRegion::Math(Box::new(Region {
                id: (*region_id).to_owned(),
                page: 0,
                x: 0.0,
                y: i as f64,
                enabled: true,
                statement: std::sync::Arc::new(parse_statement(text).unwrap()),
            }))
        })
        .map(std::sync::Arc::new)
        .collect();
    let mut project = Project::new();
    project
        .insert(ProjectDocument {
            id: id.clone(),
            content_hash: "h".into(),
            settings: CalculationSettings::default(),
            environment: None,
            page: Default::default(),
            result_formats: Default::default(),
            numeric_options: Default::default(),
            math_breaks: Default::default(),
            resources: Default::default(),
            assets: Default::default(),
            page_breaks: Vec::new(),
            regions,
        })
        .unwrap();
    let texts: HashMap<_, _> = math
        .iter()
        .map(|(r, t)| ((id.clone(), (*r).to_owned()), (*t).to_owned()))
        .collect();
    let mut session = WorksheetSession::new(
        kernel,
        "phase4-exit",
        project,
        id.clone(),
        texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();

    let key = RegionKey {
        document: id,
        region_id: "show".to_owned(),
        instance: 0,
    };
    let RegionState::Value {
        value: Some(KernelValue::Quantity {
            magnitude,
            dimension,
        }),
        display_unit: None,
    } = session.results().get(&key).unwrap()
    else {
        panic!("unexpected {:?}", session.results().get(&key));
    };
    // SI value 9 with dimension length^2, that is `9 m^2`
    assert_eq!(
        serde_json::to_value(&magnitude).unwrap(),
        serde_json::json!({"type": "real", "value": 9.0})
    );
    assert_eq!(
        serde_json::to_value(&dimension).unwrap(),
        serde_json::json!([{"base": "length", "power": [2, 1]}])
    );
}
