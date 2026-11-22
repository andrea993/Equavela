//! Project references evaluated by the Julia kernel.
//! Skipped (with a message) when `julia` is not on PATH.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::DocumentId;
use equavela_core::project_directory::MANIFEST_FILE;
use equavela_core::project_manifest::{
    ExportEntry, ProjectManifest, ReferenceEntry, WorksheetEntry, PROJECT_FORMAT,
};
use equavela_core::project_reference::{load_references, read_api};
use equavela_core::session::{FailureKind, RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::load_project;

fn kernel() -> Option<Arc<KernelManager>> {
    let available = std::process::Command::new("julia")
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    if !available {
        eprintln!("skipping: julia is not on PATH");
        return None;
    }
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut config = KernelConfig::new(repo.join("kernel/EquavelaKernel"));
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(180);
    Some(Arc::new(KernelManager::new(config)))
}

const THERMO: &str = "11111111-1111-4111-8111-111111111111";
const THERMO_SHEET: &str = "11111111-1111-4111-8111-1111111111aa";
const CONSUMER: &str = "22222222-2222-4222-8222-222222222222";
const CONSUMER_SHEET: &str = "22222222-2222-4222-8222-2222222222aa";

fn write_project(
    root: &Path,
    id: &str,
    sheet: &str,
    worksheet: &str,
    exports: Vec<ExportEntry>,
    references: Vec<ReferenceEntry>,
) -> ProjectManifest {
    let manifest = ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: id.into(),
        name: id[..4].into(),
        worksheets: vec![WorksheetEntry {
            id: sheet.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: None,
        exports,
        references,
        julia_modules: Vec::new(),
    };
    std::fs::create_dir_all(root.join("worksheets")).unwrap();
    std::fs::write(root.join("worksheets/main.eqv"), worksheet).unwrap();
    std::fs::write(root.join(MANIFEST_FILE), manifest.to_yaml().unwrap()).unwrap();
    manifest
}

fn export(id: &str, region: &str) -> ExportEntry {
    ExportEntry {
        id: id.into(),
        worksheet: THERMO_SHEET.into(),
        region: region.into(),
    }
}

fn state(session: &WorksheetSession, root: &DocumentId, region: &str) -> RegionState {
    session
        .results()
        .get(&RegionKey {
            document: root.clone(),
            region_id: region.into(),
            instance: 0,
        })
        .unwrap()
}

fn real(state: &RegionState) -> f64 {
    match state {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("not a real value: {other:?}"),
    }
}

#[test]
fn referenced_exports_evaluate_in_the_consumers_kernel_and_julia_needs_their_trust() {
    let Some(kernel) = kernel() else { return };
    let temp: PathBuf = std::fs::canonicalize(tempfile::tempdir().unwrap().keep()).unwrap();
    let provider = temp.join("Thermo");
    // A private constant and a Julia function, used through exported math definitions.
    let manifest = write_project(
        &provider,
        THERMO,
        THERMO_SHEET,
        "format: equavela-worksheet/3\nregions:\n  - id: k\n    at: [0, 10]\n    math: \"k := 2\"\n  - id: cp\n    at: [0, 20]\n    math: \"c_p(T) := k·T\"\n  - id: jl\n    at: [0, 30]\n    julia:\n      code: |\n        twice(x) = 2x\n  - id: tw\n    at: [0, 40]\n    math: \"tw(x) := julia.twice\"\n  - id: h\n    at: [0, 50]\n    math: \"h(x) := tw(x) + k\"\n",
        vec![
            export("11111111-1111-4111-8111-1111111111c1", "cp"),
            export("11111111-1111-4111-8111-1111111111c2", "h"),
        ],
        Vec::new(),
    );
    let consumer = temp.join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        CONSUMER_SHEET,
        "format: equavela-worksheet/3\nregions:\n  - id: own\n    at: [0, 10]\n    math: \"k := 5\"\n  - id: cp\n    at: [0, 20]\n    math: \"Thermo.c_p(300) =\"\n  - id: mine\n    at: [0, 30]\n    math: \"k =\"\n  - id: h\n    at: [0, 40]\n    math: \"Thermo.h(10) =\"\n",
        Vec::new(),
        vec![ReferenceEntry {
            alias: "Thermo".into(),
            project_id: THERMO.into(),
            path: "../Thermo".into(),
            api: read_api(&provider, &manifest),
        }],
    );
    let consumer_manifest =
        ProjectManifest::from_yaml(&std::fs::read_to_string(consumer.join(MANIFEST_FILE)).unwrap())
            .unwrap();
    let loaded = load_project(&consumer.join("worksheets/main.eqv")).unwrap();
    let root = loaded.root.clone();
    let mut session = WorksheetSession::new(
        kernel,
        "references",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session.set_trusted(true);
    let references = load_references(&consumer, &consumer_manifest);
    let untrusted: BTreeMap<DocumentId, String> = references
        .references
        .providers
        .iter()
        .flat_map(|provider| {
            provider
                .documents
                .iter()
                .map(|document| (document.clone(), provider.chain.clone()))
                .collect::<Vec<_>>()
        })
        .collect();
    session.set_references(references).unwrap();
    session.set_untrusted_references(untrusted);
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();

    // Plain math of the provider runs; its private `k` is not the consumer's `k`.
    assert_eq!(real(&state(&session, &root, "cp")), 600.0);
    assert_eq!(real(&state(&session, &root, "mine")), 5.0);
    // Its Julia region waits for the reference's trust.
    match state(&session, &root, "h") {
        RegionState::Error { failure } => {
            assert!(
                matches!(failure.kind, FailureKind::Blocked | FailureKind::NotTrusted),
                "{failure:?}"
            );
        }
        other => panic!("expected an error, got {other:?}"),
    }
    let julia_region = session
        .results()
        .snapshot()
        .into_iter()
        .find(|entry| {
            entry.key.document.as_str().starts_with("@Thermo/") && entry.key.region_id == "jl"
        })
        .unwrap();
    match julia_region.state {
        RegionState::Error { failure } => assert_eq!(
            failure.message,
            "trust the referenced project `Thermo` to run its Julia code"
        ),
        other => panic!("expected the trust error, got {other:?}"),
    }

    session.set_untrusted_references(BTreeMap::new());
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert_eq!(real(&state(&session, &root, "h")), 22.0);
    let _ = std::fs::remove_dir_all(&temp);
}
