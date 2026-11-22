//! Kernel start-up timing harness. Not part of the normal test run:
//!
//! ```text
//! cargo test -p equavela-core --test kernel_timing -- --ignored --nocapture
//! EQUAVELA_SYSIMAGE=build/sysimage/equavelakernel.dll cargo test ... (same, with a sysimage)
//! ```
//!
//! It prints the time from process spawn to the `version` handshake, the first `evaluate`
//! of a small worksheet (`x := 3 m`, `y := x^2`, `y =`, plus a matrix and a program) and a
//! second, identical-shape evaluate for comparison.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use equavela_core::codegen::GenOptions;
use equavela_core::graph::Region;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::parse_statement;
use equavela_core::project::{
    CalculationSettings, DocumentId, DocumentRegion, Project, ProjectDocument,
};
use equavela_core::session::{RecalcMode, WorksheetSession};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn session(kernel: Arc<KernelManager>, math: &[(&str, &str)]) -> WorksheetSession {
    let id = DocumentId::new("/root.eqv").unwrap();
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
    let document = ProjectDocument {
        id: id.clone(),
        content_hash: "h".into(),
        settings: CalculationSettings::default(),
        environment: None,
        page: Default::default(),
        result_formats: Default::default(),
        math_breaks: Default::default(),
        resources: Default::default(),
        assets: Default::default(),
        page_breaks: Vec::new(),
        regions,
    };
    let mut project = Project::new();
    project.insert(document).unwrap();
    let texts: HashMap<_, _> = math
        .iter()
        .map(|(r, t)| ((id.clone(), (*r).to_owned()), (*t).to_owned()))
        .collect();
    WorksheetSession::new(kernel, "timing", project, id, texts, GenOptions::default()).unwrap()
}

const SMALL: &[(&str, &str)] = &[
    ("x", "x := 3 m"),
    ("y", "y := x^2"),
    ("show", "y ="),
    ("m", "M := matrix(2, 2, 1)"),
    ("det", "|M| ="),
    ("f", "f(a) := a^2 + 1"),
    ("fv", "f(2) ="),
];

#[test]
#[ignore = "timing harness; run explicitly with --ignored --nocapture"]
fn kernel_cold_start_and_first_evaluate() {
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    // The SymPy warm-up is not needed here and would delay the kernel shutdown.
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(300);
    if let Some(path) = std::env::var_os("EQUAVELA_SYSIMAGE") {
        config.sysimage = Some(PathBuf::from(path));
    }
    // e.g. EQUAVELA_JULIA_ARGS="--trace-compile=trace.jl" to see what the first evaluate compiles
    if let Ok(args) = std::env::var("EQUAVELA_JULIA_ARGS") {
        config.julia_args = args.split_whitespace().map(Into::into).collect();
    }
    let sysimage = config.sysimage.clone();
    let requested = sysimage.as_ref().is_some_and(|path| path.is_file());
    let kernel = Arc::new(KernelManager::new(config));

    let t0 = Instant::now();
    let info = kernel.start().expect("kernel starts");
    let startup = t0.elapsed();

    let mut s = session(Arc::clone(&kernel), SMALL);
    let t1 = Instant::now();
    s.recalculate(RecalcMode::Changed, &mut |_| {}).unwrap();
    let first = t1.elapsed();

    let mut s2 = session(Arc::clone(&kernel), SMALL);
    let t2 = Instant::now();
    s2.recalculate(RecalcMode::Changed, &mut |_| {}).unwrap();
    let second = t2.elapsed();

    let in_use = kernel.sysimage_in_use();
    kernel.shutdown();
    println!(
        "TIMING julia={} sysimage={:?} in_use={}\n  start_to_version_handshake = {:.2?}\n  first_evaluate             = {:.2?}\n  second_evaluate            = {:.2?}\n  total_to_first_result      = {:.2?}",
        info.julia, sysimage, in_use, startup, first, second, startup + first
    );
    assert!(
        !requested || in_use,
        "the sysimage exists but the kernel did not start with it"
    );
}
