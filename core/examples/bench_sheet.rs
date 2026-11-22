//! Times a full recalculation of a worksheet through the real kernel and lists the slowest
//! regions (the time between a region starting and its result arriving).
//!
//!     cargo run --release -q -p equavela-core --example bench_sheet -- <file.eqv> [--trust] [top]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::project::DocumentId;
use equavela_core::session::{RecalcMode, RegionState, SessionEvent, WorksheetSession};
use equavela_core::worksheet_file::load_project_text;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = std::fs::canonicalize(args.next().expect("worksheet path")).expect("exists");
    let mut trust = false;
    let mut top = 8usize;
    for arg in args {
        match arg.as_str() {
            "--trust" => trust = true,
            other => top = other.parse().expect("top"),
        }
    }
    let text = std::fs::read_to_string(&path).expect("reads the worksheet");
    let loaded = load_project_text(DocumentId::new(path.to_str().unwrap()).unwrap(), &text)
        .expect("loads the worksheet");
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config
        .env
        .push(("SHEET_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(600);
    let kernel = Arc::new(KernelManager::new(config));
    let mut session = WorksheetSession::new(
        kernel,
        "bench-sheet",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session.set_trusted(trust);
    let mut started: HashMap<String, Instant> = HashMap::new();
    let mut spans: Vec<(String, f64)> = Vec::new();
    let mut failures: Vec<(String, String)> = Vec::new();
    let begin = Instant::now();
    let summary = session
        .recalculate(RecalcMode::All, &mut |event| match event {
            SessionEvent::RegionStarted { key } => {
                started.insert(key.region_id.clone(), Instant::now());
            }
            SessionEvent::RegionUpdated { entry } => {
                if let Some(at) = started.remove(&entry.key.region_id) {
                    spans.push((entry.key.region_id.clone(), at.elapsed().as_secs_f64()));
                }
                if let RegionState::Error { failure } = &entry.state {
                    failures.push((
                        entry.key.region_id.clone(),
                        format!("{:?}: {}", failure.kind, failure.message),
                    ));
                }
            }
            _ => {}
        })
        .unwrap();
    let total = begin.elapsed().as_secs_f64();
    spans.sort_by(|a, b| b.1.total_cmp(&a.1));
    println!(
        "total {total:.2} s; evaluated {}, failed {}, blocked {}, incomplete {}",
        summary.evaluated, summary.failed, summary.blocked, summary.incomplete
    );
    for (id, seconds) in spans.iter().take(top) {
        println!("  {id}: {seconds:.2} s");
    }
    for (id, message) in failures
        .iter()
        .filter(|(_, m)| !m.starts_with("Blocked"))
        .take(10)
    {
        println!(
            "  FAILED {id}: {}",
            message.chars().take(300).collect::<String>()
        );
    }
}
