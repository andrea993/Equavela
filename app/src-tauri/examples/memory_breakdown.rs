//! What the backend keeps for a worksheet, step by step: the live heap after loading the
//! document, building the session (analysis, generated code), building the view and opening the
//! worksheet in the service. Linux only (it reads `/proc/self/statm` after `malloc_trim`).
//!
//! `cargo run --release -p equavela-app --example memory_breakdown -- app/perf-fixtures/large-20k.eqv`

use std::path::{Path, PathBuf};
use std::sync::Arc;

use equavela_app_lib::kernel_path::LocationInputs;
use equavela_app_lib::service::{EventSink, Service};
use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::session::WorksheetSession;
use equavela_core::worksheet_file::load_project;

#[cfg(all(target_os = "linux", target_env = "gnu"))]
extern "C" {
    fn malloc_trim(pad: usize) -> i32;
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
unsafe fn malloc_trim(_pad: usize) -> i32 {
    0
}

/// Resident memory in MiB once glibc has returned what it can.
fn live_mib() -> f64 {
    unsafe { malloc_trim(0) };
    let statm = std::fs::read_to_string("/proc/self/statm").expect("statm");
    let resident: f64 = statm.split_whitespace().nth(1).unwrap().parse().unwrap();
    resident * 4096.0 / 1048576.0
}

fn main() {
    if !cfg!(target_os = "linux") {
        eprintln!("memory_breakdown reads /proc/self/statm: Linux only");
        return;
    }
    let path = std::env::args()
        .nth(1)
        .expect("usage: memory_breakdown <sheet.eqv>");
    let base = live_mib();
    let mut last = base;
    let mut step = |name: &str| {
        let now = live_mib();
        println!("{name:<44} {:>8.1} MiB  (+{:.1})", now - base, now - last);
        last = now;
    };

    let loaded = load_project(Path::new(&path)).expect("load");
    let regions = loaded
        .project
        .document(&loaded.root)
        .map(|document| document.regions.len())
        .unwrap_or(0);
    step("document and math texts loaded");
    let manager = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from("none"))));
    let session = WorksheetSession::new(
        manager,
        "memory",
        loaded.project,
        loaded.root.clone(),
        loaded.texts,
        GenOptions::default(),
    )
    .expect("session");
    step("session (analysis, generated code, store)");
    let view = session.view(&loaded.root).expect("view");
    step("view of the root document");
    let json = serde_json::to_string(&view).expect("json");
    step("the view as JSON (what open sends)");
    let json_len = json.len();
    drop(json);
    drop(view);
    drop(session);
    step("all of the above dropped");

    let sink: EventSink = Arc::new(|_, _| {});
    let mut inputs = LocationInputs::from_environment(None);
    inputs.julia_override = Some(PathBuf::from("no-such-julia"));
    let service = Service::new(sink, inputs);
    let opened = service.open_worksheet(Path::new(&path)).expect("open");
    step("service: worksheet opened (with the reply)");
    drop(opened);
    step("service: reply dropped (what stays open)");
    println!(
        "{regions} regions; view JSON {:.1} MiB; per region: {:.1} KiB kept open",
        json_len as f64 / 1048576.0,
        (last - base) * 1024.0 / regions as f64
    );
    std::hint::black_box(&service);
}
