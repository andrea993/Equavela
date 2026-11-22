//! Spreadsheet import end to end: `READODS` reads an OpenDocument file inside the kernel,
//! and the evaluate request carries the
//! directory of the worksheet as `base_dir`. The tests that need the kernel are skipped (with
//! a message) when `julia` is not on PATH; the fixture is the one of the EqRuntime suite.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{EvaluateRequest, KernelConfig, KernelManager};
use equavela_core::kernel_value::{KernelValue, MatrixStorage};
use equavela_core::project::DocumentId;
use equavela_core::session::{
    FailureKind, RecalcMode, RegionFailure, RegionKey, RegionState, WorksheetSession,
};
use equavela_core::worksheet_file::{load_project, load_project_text};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn fixture() -> PathBuf {
    repo_root().join("kernel/EqRuntime/test/fixtures/readods.ods")
}

fn julia_available() -> bool {
    std::process::Command::new("julia")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn kernel() -> Option<Arc<KernelManager>> {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return None;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(180);
    Some(Arc::new(KernelManager::new(config)))
}

struct Sandbox {
    dir: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Sandbox {
        let dir =
            std::env::temp_dir().join(format!("equavela-readods-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Sandbox { dir }
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// The fixture next to the worksheet, so that a relative path finds it.
    fn copy_fixture(&self) {
        std::fs::copy(fixture(), self.dir.join("readods.ods")).unwrap();
    }

    fn session(&self, kernel: Arc<KernelManager>, name: &str) -> (WorksheetSession, DocumentId) {
        let loaded = load_project(&self.dir.join("main.eqv")).unwrap();
        let root = loaded.root.clone();
        let session = WorksheetSession::new(
            kernel,
            name,
            loaded.project,
            loaded.root,
            loaded.texts,
            GenOptions::default(),
        )
        .unwrap();
        (session, root)
    }

    /// A worksheet that was never saved: its document id is a bare name, not a path.
    fn untitled(&self, kernel: Arc<KernelManager>, name: &str) -> (WorksheetSession, DocumentId) {
        let root = DocumentId::new("Untitled-7.eqv").unwrap();
        let text = std::fs::read_to_string(self.dir.join("main.eqv")).unwrap();
        let loaded = load_project_text(root.clone(), &text).unwrap();
        let session = WorksheetSession::new(
            kernel,
            name,
            loaded.project,
            loaded.root,
            loaded.texts,
            GenOptions::default(),
        )
        .unwrap();
        (session, root)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

const SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: m
    at: [0, 10]
    math: 'M := READODS("readods.ods")'
  - id: r1
    at: [0, 20]
    math: 'rows(M) ='
  - id: r6
    at: [0, 70]
    math: 'cols(M) ='
  - id: r7
    at: [0, 80]
    math: 'M[0, 0] ='
  - id: r2
    at: [0, 30]
    math: 'READODS("readods.ods", "Data!B2") ='
  - id: r3
    at: [0, 40]
    math: 'READODS("readods.ods", "Data!A1") ='
  - id: r4
    at: [0, 50]
    math: 'READODS("readods.ods", "Data!A3:C3", 0) ='
  - id: r5
    at: [0, 60]
    math: 'READODS("nowhere.ods") ='
"#;

fn key(root: &DocumentId, region: &str) -> RegionKey {
    RegionKey {
        document: root.clone(),
        region_id: region.to_owned(),
        instance: 0,
    }
}

fn state(session: &WorksheetSession, root: &DocumentId, region: &str) -> RegionState {
    session.results().get(&key(root, region)).unwrap()
}

/// The value a region displays: a scalar, or the only element of a 1 x 1 matrix, which is
/// what a range of one cell gives.
fn scalar(session: &WorksheetSession, root: &DocumentId, region: &str) -> KernelValue {
    match state(session, root, region) {
        RegionState::Value {
            value: Some(value @ (KernelValue::Real { .. } | KernelValue::String { .. })),
            ..
        } => value,
        RegionState::Value {
            value:
                Some(KernelValue::Matrix {
                    rows: 1,
                    cols: 1,
                    storage: MatrixStorage::Inline { values },
                }),
            ..
        } => values.into_iter().next().expect("one element"),
        other => panic!("{region} is not a scalar: {other:?}"),
    }
}

fn real(session: &WorksheetSession, root: &DocumentId, region: &str) -> f64 {
    match scalar(session, root, region) {
        KernelValue::Real { value } => value.as_f64(),
        other => panic!("{region} is not a real value: {other:?}"),
    }
}

fn text(session: &WorksheetSession, root: &DocumentId, region: &str) -> String {
    match scalar(session, root, region) {
        KernelValue::String { value } => value,
        other => panic!("{region} is not a string: {other:?}"),
    }
}

fn failure(session: &WorksheetSession, root: &DocumentId, region: &str) -> RegionFailure {
    match state(session, root, region) {
        RegionState::Error { failure } => failure,
        other => panic!("{region} is not an error: {other:?}"),
    }
}

fn recalc(session: &mut WorksheetSession) {
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
}

#[test]
fn the_evaluate_request_serialises_base_dir_when_the_worksheet_has_a_directory() {
    // the specification section 7: the field is optional and is not sent when the
    // worksheet has no directory (an untitled one).
    let with = |base_dir: Option<&str>| EvaluateRequest {
        worksheet: "ws".into(),
        reset: false,
        origin: None,
        tol: None,
        ctol: None,
        exact_boolean: None,
        packages: Vec::new(),
        modules: Vec::new(),
        environment: None,
        base_dir: base_dir.map(str::to_owned),
        module_name: None,
        regions: Vec::new(),
    };
    let json = serde_json::to_value(with(Some("/home/user/sheets"))).unwrap();
    assert_eq!(json["base_dir"], serde_json::json!("/home/user/sheets"));
    let json = serde_json::to_value(with(None)).unwrap();
    assert!(json.get("base_dir").is_none(), "{json}");
}

#[test]
fn a_saved_worksheet_hands_its_directory_to_the_kernel() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("saved");
    sandbox.write("main.eqv", SHEET);
    sandbox.copy_fixture();
    let (mut s, root) = sandbox.session(kernel, "readods-saved");
    assert_eq!(
        s.worksheet_directory().as_deref(),
        Some(sandbox.dir.as_path())
    );
    // The kernel receives the directory with `/` on every platform.
    assert_eq!(
        s.kernel_base_dir(),
        sandbox.dir.to_str().map(|dir| dir.replace('\\', "/"))
    );
    recalc(&mut s);
    // the used range of the first sheet, through the whole stack.
    assert_eq!(real(&s, &root, "r1"), 6.0);
    assert_eq!(real(&s, &root, "r6"), 5.0);
    assert_eq!(real(&s, &root, "r2"), 0.25);
    assert_eq!(text(&s, &root, "r3"), "Tom & Jerry <1>");
    // The elements of a matrix of a sheet may be strings.
    assert_eq!(text(&s, &root, "r7"), "Tom & Jerry <1>");
    // empty cells take the emptyfill of the call.
    assert_eq!(
        state(&s, &root, "r4"),
        RegionState::Value {
            value: Some(KernelValue::Matrix {
                rows: 1,
                cols: 3,
                storage: MatrixStorage::Inline {
                    values: vec![
                        KernelValue::Real {
                            value: equavela_core::kernel_value::WireFloat::Finite(0.0)
                        };
                        3
                    ]
                }
            }),
            display_unit: None,
        }
    );
    // a missing file names the path as resolved, which shows where the relative name
    // landed.
    let missing = failure(&s, &root, "r5");
    assert_eq!(missing.kind, FailureKind::Evaluation);
    // Separators differ by platform (Julia joins with `\\` on Windows): compared with `/`.
    let expected = sandbox.dir.join("nowhere.ods").display().to_string();
    assert!(
        missing
            .message
            .replace('\\', "/")
            .contains(&expected.replace('\\', "/")),
        "{}",
        missing.message
    );
}

#[test]
fn an_untitled_worksheet_has_no_directory_for_a_relative_path() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("untitled");
    sandbox.write("main.eqv", SHEET);
    sandbox.copy_fixture();
    let (mut s, root) = sandbox.untitled(kernel, "readods-untitled");
    assert_eq!(s.worksheet_directory(), None);
    assert_eq!(s.kernel_base_dir(), None);
    recalc(&mut s);
    // the message asks for a saved worksheet or an absolute path.
    let missing = failure(&s, &root, "r5");
    assert!(
        missing.message.contains("save the worksheet first"),
        "{}",
        missing.message
    );
}

#[test]
fn an_untitled_worksheet_reads_an_absolute_path() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("absolute");
    sandbox.copy_fixture();
    let path = sandbox.dir.join("readods.ods");
    sandbox.write(
        "main.eqv",
        &format!(
            "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 10]\n    math: 'rows(READODS(\"{}\")) ='\n",
            // A worksheet string writes a Windows path with `/`: `\` starts an escape there.
            path.display().to_string().replace('\\', "/")
        ),
    );
    let (mut s, root) = sandbox.untitled(kernel, "readods-absolute");
    recalc(&mut s);
    // The file is there and the path is absolute, so the missing worksheet directory does not
    // matter.
    assert_eq!(real(&s, &root, "a"), 6.0);
}
