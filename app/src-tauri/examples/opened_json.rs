//! Opens a worksheet the way the app does and prints what `open_worksheet` returns, as JSON.
//! Used by the GUI benchmark: it checks that a generated worksheet loads, and its output
//! is the fixture the mock backend serves in a plain browser (`?backend=mock&fixture=...`).
//!
//! `cargo run -q -p equavela-app --example opened_json -- <worksheet.eqv> [out.json]`
//! Exit code 1 with the error on stderr when the worksheet does not open.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use equavela_app_lib::kernel_path::LocationInputs;
use equavela_app_lib::service::{EventSink, Service};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first() else {
        eprintln!("usage: opened_json <worksheet.eqv> [out.json]");
        std::process::exit(2);
    };
    let sink: EventSink = Arc::new(|_, _| {});
    // No kernel is started: opening only parses and analyses the worksheet.
    let mut inputs = LocationInputs::from_environment(None);
    inputs.julia_override = Some(PathBuf::from("no-such-julia"));
    let service = Service::new(sink, inputs);
    let opened = match service.open_worksheet(Path::new(path)) {
        Ok(opened) => opened,
        Err(error) => {
            eprintln!("{}: {}", error.kind, error.message);
            std::process::exit(1);
        }
    };
    let text = serde_json::to_string(&opened).expect("serializable");
    match args.get(1) {
        Some(out) => std::fs::write(out, text).expect("write the output file"),
        None => println!("{text}"),
    }
}
