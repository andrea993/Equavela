//! Per-edit timing of the core on large worksheets.
//!
//! Every committed edit clones the whole document (`run_command`), re-runs `apply_document` →
//! `derive` (analysis and codegen of the whole project), rebuilds the results index
//! (`reconcile_store`), and then the service builds the whole `DocumentView` and the results
//! snapshot and serializes them to JSON for the IPC (`edit_result`). This example puts numbers on
//! each of those steps on the synthetic worksheets of the GUI benchmark.
//!
//! `cargo run --release -q -p equavela-app --example edit_timing -- <worksheet.eqv> [--edits 20]`
//!
//! It opens the worksheet the way the app does, then edits math definitions spread over the
//! document — the first one near the top, the last one near the end — through `set_math`, the call
//! `app/src/equavelaApi.ts` makes for a committed math edit (the editor AST as JSON), and undoes
//! each edit, so every sample starts from the same document.
//!
//! No kernel is started (the Julia path points nowhere): this measures parsing, analysis, codegen
//! and the IPC payload, never evaluation. Since an edit returns a delta against the last state
//! the worksheet sent, so the payload row is the few KiB the app really receives; the whole state
//! (what `worksheet_snapshot` returns, and what an edit used to carry) is printed below it.
//!
//! `derive` and `apply_document` are private to `core/src/session.rs`, so no row times them
//! directly: the breakdown at the end rebuilds `derive` from the same public steps it calls
//! (`Project::analyze`, `DependencyGraph::build`, `generate_worksheet`, `region_request` for the
//! symbolic request of every region) instead of adding timing hooks to production code. The
//! in-core `edit_math` row is the authoritative total: it covers the document clone, the edit, the
//! whole `derive`, `reconcile_store` and `invalidate`. `reconcile_store` is not reachable; its cost
//! is the small remainder that `derive` does not account for.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use equavela_app_lib::kernel_path::LocationInputs;
use equavela_app_lib::service::{CommandError, EventSink, Service};
use equavela_core::ast::{Expr, ExprKind, Statement, StatementKind};
use equavela_core::codegen::{generate_worksheet, GenOptions};
use equavela_core::graph::DependencyGraph;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::session::{ViewContent, WorksheetSession};
use equavela_core::symbolic::{region_request_in, statements_by_id, SymbolicRequest};
use equavela_core::worksheet_file::load_project;

/// A math region to edit: the statement to send back, with `+ 0` appended to its right-hand side.
struct Target {
    region_id: String,
    statement: serde_json::Value,
}

/// Timed samples of one measure, in milliseconds.
#[derive(Default)]
struct Timing(Vec<f64>);

impl Timing {
    fn push(&mut self, elapsed: Duration) {
        self.0.push(elapsed.as_secs_f64() * 1000.0);
    }

    fn median(&self) -> f64 {
        median(&self.0)
    }

    fn max(&self) -> f64 {
        self.0.iter().copied().fold(0.0, f64::max)
    }
}

fn main() {
    let (path, edits) = parse_args();
    let sink: EventSink = Arc::new(|_, _| {});
    // No kernel is started: an edit only parses, analyses, generates code and builds the view.
    let mut inputs = LocationInputs::from_environment(None);
    inputs.julia_override = Some(PathBuf::from("no-such-julia"));
    let service = Service::new(sink, inputs);
    let opened = match service.open_worksheet(Path::new(&path)) {
        Ok(opened) => opened,
        Err(error) => fail("open_worksheet", error),
    };

    // What the frontend asks after every view change (side panel, hover, problems): the whole
    // inspection of the project.
    {
        let mut inspect = Timing::default();
        let mut inspect_json = Timing::default();
        let mut bytes = 0usize;
        for _ in 0..3 {
            let started = Instant::now();
            let inspection = service
                .inspect(&opened.id)
                .unwrap_or_else(|error| fail("inspect", error));
            inspect.push(started.elapsed());
            let started = Instant::now();
            bytes = serde_json::to_string(&inspection)
                .expect("serializable")
                .len();
            inspect_json.push(started.elapsed());
        }
        println!(
            "  inspect: {:.1} ms median, JSON {:.1} ms, {} bytes ({:.2} MiB)",
            inspect.median(),
            inspect_json.median(),
            bytes,
            bytes as f64 / 1048576.0
        );
    }

    let targets = edit_targets(&opened.view);
    if targets.is_empty() {
        eprintln!(
            "{}: no math definition whose right-hand side accepts `+ 0`",
            path.display()
        );
        std::process::exit(1);
    }
    let indices = spread(&targets, edits);
    let pages = opened
        .view
        .regions
        .iter()
        .map(|region| region.page)
        .max()
        .unwrap_or(0);
    println!("edit_timing: {}", path.display());
    println!(
        "  {} regions on {} pages, {} editable definitions, {} edits",
        opened.view.regions.len(),
        pages,
        targets.len(),
        indices.len()
    );

    // ---- the path the app takes: the public service API ---------------------------------

    let mut service_edit = Timing::default();
    let mut service_json = Timing::default();
    let mut service_view = Timing::default();
    let mut service_results = Timing::default();
    let mut payload_bytes: Vec<f64> = Vec::new();
    let mut undo_edit = Timing::default();
    let mut undo_json = Timing::default();
    for index in &indices {
        let target = &targets[*index];
        let started = Instant::now();
        let result = service
            .set_math(&opened.id, &target.region_id, target.statement.clone())
            .unwrap_or_else(|error| fail("set_math", error));
        service_edit.push(started.elapsed());

        let started = Instant::now();
        let json = serde_json::to_string(&result).expect("the edit result is serializable");
        service_json.push(started.elapsed());
        payload_bytes.push(json.len() as f64);
        drop(json);

        let started = Instant::now();
        let view = service
            .view(&opened.id)
            .unwrap_or_else(|error| fail("view", error));
        service_view.push(started.elapsed());
        drop(view);

        let started = Instant::now();
        let regions = service
            .results(&opened.id)
            .unwrap_or_else(|error| fail("results", error));
        service_results.push(started.elapsed());
        drop(regions);

        let started = Instant::now();
        let undone = service
            .undo(&opened.id)
            .unwrap_or_else(|error| fail("undo", error));
        undo_edit.push(started.elapsed());

        let started = Instant::now();
        let json = serde_json::to_string(&undone).expect("the edit result is serializable");
        undo_json.push(started.elapsed());
        drop(json);
    }

    // ---- the core alone: a session built from the public core API ------------------------
    // (the service keeps its session private, so a second one is created for the core rows)

    let loaded = match load_project(Path::new(&path)) {
        Ok(loaded) => loaded,
        Err(error) => {
            eprintln!("{}: {error}", path.display());
            std::process::exit(1);
        }
    };
    let root = loaded.root.clone();

    // `derive` is private: run the public steps it calls, on the unedited document (an edit
    // changes one expression, not the size of the work). The last step is the symbolic request of
    // every region, with one statement index for the whole worksheet as `derive` builds it.
    let mut derive_analysis = Timing::default();
    let mut derive_graph = Timing::default();
    let mut derive_codegen = Timing::default();
    let mut derive_symbolic = Timing::default();
    let mut derive_total = Timing::default();
    for _ in 0..3 {
        let whole = Instant::now();
        let started = Instant::now();
        let analysis = loaded.project.analyze(&root).unwrap_or_else(|error| {
            eprintln!("analyze: {error}");
            std::process::exit(1);
        });
        derive_analysis.push(started.elapsed());
        let started = Instant::now();
        let graph = DependencyGraph::build(analysis.worksheet()).unwrap_or_else(|error| {
            eprintln!("DependencyGraph::build: {error}");
            std::process::exit(1);
        });
        derive_graph.push(started.elapsed());
        let started = Instant::now();
        let generated = generate_worksheet(analysis.worksheet(), GenOptions::default())
            .unwrap_or_else(|error| {
                eprintln!("generate_worksheet: {error}");
                std::process::exit(1);
            });
        derive_codegen.push(started.elapsed());
        let started = Instant::now();
        let statements = statements_by_id(analysis.worksheet());
        let symbolic: HashMap<String, SymbolicRequest> = analysis
            .worksheet()
            .regions
            .iter()
            .filter_map(|region| {
                region_request_in(&statements, &graph, &region.id)
                    .map(|request| (region.id.clone(), request))
            })
            .collect();
        derive_symbolic.push(started.elapsed());
        derive_total.push(whole.elapsed());
        // Keep the values alive: only their cost matters here.
        std::hint::black_box((&analysis, &graph, &generated, &symbolic));
    }

    let manager = Arc::new(KernelManager::new(KernelConfig::new(PathBuf::from(
        "kernel-not-found",
    ))));
    let mut session = WorksheetSession::new(
        manager,
        "edit-timing",
        loaded.project,
        root.clone(),
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap_or_else(|error| {
        eprintln!("WorksheetSession::new: {error}");
        std::process::exit(1);
    });
    let mut core_edit = Timing::default();
    let mut core_undo = Timing::default();
    for index in &indices {
        let target = &targets[*index];
        let text = Service::statement_text(target.statement.clone())
            .unwrap_or_else(|error| fail("statement_text", error));
        let started = Instant::now();
        session
            .edit_math(&root, &target.region_id, &text)
            .unwrap_or_else(|error| {
                eprintln!("edit_math on `{}`: {error}", target.region_id);
                std::process::exit(1);
            });
        core_edit.push(started.elapsed());
        let started = Instant::now();
        session.undo().unwrap_or_else(|error| {
            eprintln!("undo: {error}");
            std::process::exit(1);
        });
        core_undo.push(started.elapsed());
    }

    // ---- report --------------------------------------------------------------------------

    // The whole state a frontend asks for when it cannot apply a delta: what an edit used
    // to carry on the wire.
    let snapshot = service
        .worksheet_snapshot(&opened.id)
        .unwrap_or_else(|error| fail("worksheet_snapshot", error));
    let snapshot_bytes = serde_json::to_string(&snapshot)
        .expect("the snapshot is serializable")
        .len();

    table(
        "service pass (the calls the app makes for one committed edit)",
        &[
            ("set_math (returns EditResult)", &service_edit),
            ("serde_json::to_string(EditResult)", &service_json),
            ("view (a standalone build)", &service_view),
            ("results (the snapshot)", &service_results),
            ("undo (returns EditResult)", &undo_edit),
            ("undo serde_json::to_string", &undo_json),
        ],
    );
    println!(
        "\n{:<42} {:>12} {:>12}",
        "IPC payload of one edit (delta, #55)", "median", "max"
    );
    println!(
        "{:<42} {:>12} {:>12}",
        "  bytes",
        format!("{:.0}", median(&payload_bytes)),
        format!("{:.0}", payload_bytes.iter().copied().fold(0.0, f64::max))
    );
    println!(
        "{:<42} {:>12} {:>12}",
        "  MiB",
        format!("{:.2}", median(&payload_bytes) / (1024.0 * 1024.0)),
        format!(
            "{:.2}",
            payload_bytes.iter().copied().fold(0.0, f64::max) / (1024.0 * 1024.0)
        )
    );
    println!(
        "{:<42} {:>12}",
        "  the whole state (worksheet_snapshot), bytes", snapshot_bytes
    );

    table(
        "core pass (no service: clone, apply_document, derive, reconcile_store, invalidate)",
        &[
            ("edit_math (the whole in-core edit)", &core_edit),
            ("undo (the whole in-core edit)", &core_undo),
        ],
    );

    table(
        "derive breakdown (derive is private: the same public steps, unedited document)",
        &[
            ("Project::analyze", &derive_analysis),
            ("DependencyGraph::build", &derive_graph),
            ("generate_worksheet", &derive_codegen),
            ("symbolic requests (one statement index)", &derive_symbolic),
            ("derive rebuild (the four steps)", &derive_total),
        ],
    );

    let edit = core_edit.median();
    let derive = derive_total.median();
    println!(
        "\nthe derive rebuild is {:.0} % of one in-core edit ({:.1} ms of {:.1} ms); the rest is the \
         document\nclone, the edit application, derive's key and order maps, reconcile_store and \
         invalidate ({:.1} ms)",
        if edit > 0.0 {
            100.0 * derive / edit
        } else {
            0.0
        },
        derive,
        edit,
        (edit - derive).max(0.0)
    );
    println!(
        "the service call adds the view and the results snapshot: {:.1} ms per edit end to end, \
         {:.1} KiB\nof JSON per edit; the whole state (worksheet_snapshot) is {:.2} MiB",
        service_edit.median(),
        median(&payload_bytes) / 1024.0,
        snapshot_bytes as f64 / (1024.0 * 1024.0)
    );
}

fn parse_args() -> (PathBuf, usize) {
    const USAGE: &str = "usage: edit_timing <worksheet.eqv> [--edits N]";
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(path) = args.first().filter(|arg| !arg.starts_with("--")) else {
        eprintln!("{USAGE}");
        std::process::exit(2);
    };
    let mut edits = 20;
    let mut index = 1;
    while index < args.len() {
        if args[index] != "--edits" {
            eprintln!("unknown argument `{}`\n{USAGE}", args[index]);
            std::process::exit(2);
        }
        match args
            .get(index + 1)
            .and_then(|value| value.parse::<usize>().ok())
        {
            Some(count) if count > 0 => edits = count,
            _ => {
                eprintln!("--edits needs a positive number\n{USAGE}");
                std::process::exit(2);
            }
        }
        index += 2;
    }
    (PathBuf::from(path), edits)
}

/// The math regions that hold a definition whose right-hand side accepts `+ 0`.
fn edit_targets(view: &equavela_core::session::DocumentView) -> Vec<Target> {
    view.regions
        .iter()
        .filter_map(|region| {
            let ViewContent::Math { statement, .. } = &region.content else {
                return None;
            };
            let mut statement = (**statement).clone();
            if !append_zero(&mut statement) {
                return None;
            }
            Some(Target {
                region_id: region.id.clone(),
                statement: serde_json::to_value(&statement).expect("statements are serializable"),
            })
        })
        .collect()
}

/// `t := e` → `t := e + 0`: a valid edit that keeps the name and its dependents, so the stale set
/// and the generated code of the worksheet change the way a real edit changes them.
fn append_zero(statement: &mut Statement) -> bool {
    let rhs = match &mut statement.kind {
        StatementKind::Define {
            rhs, tail: None, ..
        } => rhs,
        _ => return false,
    };
    // A range variable (`a := 1..3`) or a program is not an operand of `+`.
    if matches!(rhs.kind, ExprKind::Range { .. } | ExprKind::Program { .. }) {
        return false;
    }
    let left = std::mem::replace(rhs, Expr::synth(ExprKind::Num { text: "0".into() }));
    *rhs = Expr::synth(ExprKind::Add {
        left: Box::new(left),
        right: Box::new(Expr::synth(ExprKind::Num { text: "0".into() })),
        split: false,
    });
    true
}

/// `count` target indices spread over the document: the first near the top, the last near the end.
fn spread(targets: &[Target], count: usize) -> Vec<usize> {
    let count = count.min(targets.len());
    if count == 0 {
        return Vec::new();
    }
    (0..count)
        .map(|edit| edit * (targets.len() - 1) / count.saturating_sub(1).max(1))
        .collect()
}

fn table(title: &str, rows: &[(&str, &Timing)]) {
    println!("\n{title}");
    println!("{:<42} {:>12} {:>12}", "measure", "median ms", "max ms");
    for (name, timing) in rows {
        println!(
            "{:<42} {:>12} {:>12}",
            name,
            number(timing.median()),
            number(timing.max())
        );
    }
}

fn number(value: f64) -> String {
    if value >= 1000.0 {
        format!("{value:.0}")
    } else if value >= 100.0 {
        format!("{value:.1}")
    } else {
        format!("{value:.2}")
    }
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite samples"));
    let count = sorted.len();
    if count % 2 == 1 {
        sorted[count / 2]
    } else {
        (sorted[count / 2 - 1] + sorted[count / 2]) / 2.0
    }
}

fn fail(what: &str, error: CommandError) -> ! {
    eprintln!("{what}: {}: {}", error.kind, error.message);
    std::process::exit(1);
}
