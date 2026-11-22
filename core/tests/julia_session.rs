//! `julia` regions end to end: trust, environments, missing packages. The
//! tests that need the kernel are skipped (with a message) when `julia` is not on PATH.
//! Only standard-library packages and a local path package are used (no downloads).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::DocumentId;
use equavela_core::session::{
    FailureKind, RecalcMode, RegionKey, RegionState, SessionError, WorksheetSession,
};
use equavela_core::worksheet_file::load_project;

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

fn kernel() -> Option<Arc<KernelManager>> {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return None;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    // The SymPy warm-up is not needed here and would delay the kernel shutdown.
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
            std::env::temp_dir().join(format!("equavela-julia-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Sandbox { dir }
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
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
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

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

fn real(state: &RegionState) -> f64 {
    match state {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("not a real value: {other:?}"),
    }
}

fn recalc(session: &mut WorksheetSession) {
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
}

fn failure(state: &RegionState) -> &equavela_core::session::RegionFailure {
    match state {
        RegionState::Error { failure } => failure,
        other => panic!("expected an error, got {other:?}"),
    }
}

const SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: a
    at: [0, 10]
    math: "a := 3"
  - id: j1
    at: [0, 20]
    julia:
      using: [LinearAlgebra, Statistics]
      import:
        nrm: LinearAlgebra.norm
        mean: Statistics.mean
      code: |
        function area(r)
            return 3 * r^2 * a
        end
        scale = 2.5
        v = [1.0, 2.0, 6.0]
  - id: f1
    at: [0, 24]
    math: "Area(r) := julia.area"
  - id: f2
    at: [0, 25]
    math: "Nrm(x) := julia.nrm"
  - id: f3
    at: [0, 26]
    math: "Mean(x) := julia.mean"
  - id: r2
    at: [0, 30]
    math: "Area(2) ="
  - id: r3
    at: [0, 40]
    math: "julia.scale + Nrm([3; 4]) ="
  - id: r4
    at: [0, 50]
    math: "Mean(julia.v) ="
  - id: r5
    at: [0, 60]
    math: "a + 1 ="
  - id: direct
    at: [0, 70]
    math: "julia.area(2) ="
  - id: imported
    at: [0, 80]
    math: "julia.nrm([3; 4]) ="
  - id: constant
    at: [0, 90]
    math: "s_max := julia.scale"
  - id: constantuse
    at: [0, 100]
    math: "s_max + julia.scale ="
"#;

#[test]
fn julia_regions_are_blocked_until_the_worksheet_is_trusted() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("trust");
    sandbox.write("main.eqv", SHEET);
    let (mut s, root) = sandbox.session(kernel, "julia-trust");
    assert!(!s.is_trusted());
    recalc(&mut s);
    // reference-only regions run without trust.
    assert_eq!(real(&state(&s, &root, "r5")), 4.0);
    // The julia region and every region that calls Julia are refused.
    let refused = state(&s, &root, "j1");
    assert_eq!(failure(&refused).kind, FailureKind::NotTrusted);
    for id in ["r2", "r3"] {
        let st = state(&s, &root, id);
        assert_eq!(failure(&st).kind, FailureKind::Blocked, "{id}");
    }
    // `Mean(v)` calls Julia, and `v` comes from the julia region.
    let st = state(&s, &root, "r4");
    assert!(matches!(
        failure(&st).kind,
        FailureKind::NotTrusted | FailureKind::Blocked
    ));
    assert!(matches!(
        s.install_packages(&[]),
        Err(SessionError::NotTrusted)
    ));

    s.set_trusted(true);
    recalc(&mut s);
    // area(2) = 3 * 2^2 * a with `a` bound from the worksheet (to_julia).
    assert_eq!(real(&state(&s, &root, "r2")), 36.0);
    assert_eq!(real(&state(&s, &root, "r3")), 7.5);
    assert_eq!(real(&state(&s, &root, "r4")), 3.0);
    assert_eq!(real(&state(&s, &root, "direct")), 36.0);
    assert_eq!(real(&state(&s, &root, "imported")), 5.0);
    assert_eq!(real(&state(&s, &root, "constantuse")), 5.0);
    assert!(matches!(
        state(&s, &root, "j1"),
        RegionState::Value { value: None, .. }
    ));

    // Editing the worksheet variable re-runs the julia region (it reads `a`) and its readers.
    s.edit_math(&root, "a", "a := 4").unwrap();
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "r2")), 48.0);
    assert_eq!(real(&state(&s, &root, "direct")), 48.0);
    assert_eq!(real(&state(&s, &root, "r5")), 5.0);

    // Withdrawing trust fails Julia regions again on the next full pass.
    s.set_trusted(false);
    s.recalculate(RecalcMode::All, &mut |_| {}).unwrap();
    assert_eq!(
        failure(&state(&s, &root, "j1")).kind,
        FailureKind::NotTrusted
    );
    assert_eq!(real(&state(&s, &root, "r5")), 5.0);
}

#[test]
fn julia_exceptions_are_reported_on_the_calling_region() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("errors");
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: j1
    at: [0, 10]
    julia:
      code: |
        boom(x) = error("kaput")
        bad syntax here (
  - id: j2
    at: [0, 20]
    julia:
      code: |
        kaboom(x) = error("kaput")
  - id: f
    at: [0, 25]
    math: "K(x) := julia.kaboom"
  - id: r1
    at: [0, 30]
    math: "K(1) ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-errors");
    s.set_trusted(true);
    recalc(&mut s);
    // A syntax error in the julia code fails that region only and blocks its readers.
    let first = state(&s, &root, "j1");
    assert_eq!(failure(&first).kind, FailureKind::Evaluation);
    // `kaboom` comes from j2, which is fine; the exception names its type.
    let call = state(&s, &root, "r1");
    let call = failure(&call);
    assert!(call.message.contains("kaput"), "{}", call.message);
    assert!(call.message.contains("ErrorException"), "{}", call.message);
}

#[test]
fn missing_packages_are_reported_not_installed() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("missing");
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: j1
    at: [0, 10]
    julia:
      using: [NoSuchPackageForSure]
      import:
        thing: NoSuchPackageForSure.thing
  - id: r1
    at: [0, 20]
    math: "T(x) := julia.thing"
  - id: r2
    at: [0, 30]
    math: "OtherMissingPackage::f(1) ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-missing");
    s.set_trusted(true);
    recalc(&mut s);
    let j1 = state(&s, &root, "j1");
    let j1 = failure(&j1);
    assert_eq!(j1.julia_type.as_deref(), Some("MissingPackage"));
    assert!(j1.message.contains("not installed"), "{}", j1.message);
    // the failure names the package, for the Add action of the Problems panel.
    assert_eq!(j1.package.as_deref(), Some("NoSuchPackageForSure"));
    assert_eq!(failure(&state(&s, &root, "r1")).kind, FailureKind::Blocked);
    // A direct package call is not a registered function: it never loads a package.
    let r2 = state(&s, &root, "r2");
    assert!(
        failure(&r2)
            .message
            .contains("is not registered on the worksheet"),
        "{r2:?}"
    );
    assert_eq!(s.missing_packages(), ["NoSuchPackageForSure"]);
}

#[test]
fn the_worksheet_environment_provides_packages_and_installs_offline() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("env");
    let uuid = "d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b12";
    sandbox.write(
        "Foo/Project.toml",
        &format!("name = \"Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"),
    );
    sandbox.write("Foo/src/Foo.jl", "module Foo\ntriple(x) = 3x\nend\n");
    sandbox.write(
        "worksheet/Project.toml",
        &format!("[deps]\nFoo = \"{uuid}\"\n"),
    );
    sandbox.write(
        "worksheet/Manifest.toml",
        &format!(
            "manifest_format = \"2.0\"\n\n[[deps.Foo]]\npath = \"../Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"
        ),
    );
    // the folder of the worksheet is its environment only when the file says so.
    sandbox.write(
        "worksheet/main.eqv",
        r#"format: equavela-worksheet/3
environment: .
regions:
  - id: j1
    at: [0, 10]
    julia:
      using: [Foo]
      import:
        triple: Foo.triple
  - id: f
    at: [0, 15]
    math: "Triple(x) := julia.triple"
  - id: r1
    at: [0, 20]
    math: "Triple(14) ="
  - id: r2
    at: [0, 30]
    math: "Triple(2) ="
"#,
    );
    let worksheet_dir = sandbox.dir.join("worksheet");
    let loaded = load_project(&worksheet_dir.join("main.eqv")).unwrap();
    let root = loaded.root.clone();
    let mut s = WorksheetSession::new(
        kernel,
        "julia-env",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    s.set_shared_environment(sandbox.dir.join("shared"));
    assert_eq!(
        s.environment().kind,
        equavela_core::environment::EnvironmentKind::Override
    );
    assert_eq!(
        s.environment_directory().unwrap().canonicalize().unwrap(),
        worksheet_dir.canonicalize().unwrap()
    );
    s.set_trusted(true);
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "r1")), 42.0);
    assert_eq!(real(&state(&s, &root, "r2")), 6.0);
    // Instantiating the environment (no package names) needs no network here.
    let result = s.install_packages(&[]).unwrap();
    assert!(result.packages.is_empty());
}

/// `F(X, y) := julia.f` registers a Julia function under a worksheet name of the
/// user's choice; the call passes the arguments in order, and a Julia name with underscores keeps
/// them.
#[test]
fn a_registered_julia_function_is_called_with_the_worksheet_arguments() {
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("register");
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: j1
    at: [0, 10]
    julia:
      code: |
        k_x_max(a, b) = a + 2b
        gain_1 = 4.0
  - id: f
    at: [0, 20]
    math: "F_x(X, y) := julia.k_x_max"
  - id: r1
    at: [0, 30]
    math: "F_x(1, 2) ="
  - id: r2
    at: [0, 40]
    math: "julia.gain_1·F_x(0, 1) ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-register");
    s.set_trusted(true);
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "r1")), 5.0);
    assert_eq!(real(&state(&s, &root, "r2")), 8.0);
}

#[test]
fn run_evaluates_a_block_and_its_dependents_again_without_changes() {
    // the specification : Run evaluates the block again even when nothing changed.
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("run");
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: j
    at: [0, 10]
    julia:
      code: |
        global RUNS = (@isdefined(RUNS) ? RUNS : 0) + 1
        counter = RUNS
  - id: c
    at: [0, 20]
    math: "julia.counter ="
  - id: other
    at: [0, 30]
    math: "1 + 1 ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-run");
    s.set_trusted(true);
    recalc(&mut s);
    let first = real(&state(&s, &root, "c"));
    // Nothing changed: an ordinary pass evaluates nothing again.
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "c")), first);

    let stale = s.rerun_region(&root, "j").unwrap();
    let ids: Vec<_> = stale.iter().map(|key| key.region_id.as_str()).collect();
    assert!(
        ids.contains(&"j") && ids.contains(&"c") && !ids.contains(&"other"),
        "{ids:?}"
    );
    assert!(s.calc_needed());
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "c")), first + 1.0);
    assert_eq!(real(&state(&s, &root, "other")), 2.0);
    // A region that does not evaluate cannot be run.
    assert!(s.rerun_region(&root, "nowhere").is_err());
}

#[test]
fn a_loaded_project_module_is_reached_by_its_qualified_names() {
    // the specification : no Julia block, no import.
    use equavela_core::session::JuliaModules;
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("modules");
    sandbox.write(
        "Tools.jl",
        "module Tools\nhidden(x) = 2x\ntotal(x) = sum(x)\nconst k = 5\nmodule Inner\nconst c = 2\nplus(x) = x + c\nend\nend\n",
    );
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: reg
    at: [0, 10]
    math: "U(x) := julia.Tools.hidden"
  - id: use
    at: [0, 20]
    math: "U(3) ="
  - id: value
    at: [0, 30]
    math: "julia.Tools.k ="
  - id: direct
    at: [0, 40]
    math: "julia.Tools.hidden(3) ="
  - id: alias
    at: [0, 50]
    math: "κ_max := julia.Tools.k"
  - id: aliasuse
    at: [0, 60]
    math: "κ_max + julia.Tools.k ="
  - id: nested
    at: [0, 70]
    math: "julia.Tools.Inner.plus(julia.Tools.Inner.c) ="
  - id: vector
    at: [0, 80]
    math: "julia.Tools.total(julia.Tools.hidden([1; 2; 3])) ="
  - id: units
    at: [0, 90]
    math: "julia.Tools.hidden(3 m@unit)/m@unit ="
  - id: arity
    at: [0, 100]
    math: "julia.Tools.hidden() ="
  - id: notcallable
    at: [0, 110]
    math: "julia.Tools.k(1) ="
  - id: basecall
    at: [0, 120]
    math: "julia.Base.sin(0) ="
  - id: basevalue
    at: [0, 130]
    math: "julia.Base.pi ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-modules");
    s.set_trusted(true);
    // Without the module the name is unknown to Julia.
    recalc(&mut s);
    assert!(matches!(state(&s, &root, "use"), RegionState::Error { .. }));
    assert_eq!(real(&state(&s, &root, "basecall")), 0.0);
    assert_eq!(real(&state(&s, &root, "basevalue")), std::f64::consts::PI);
    s.set_julia_modules(JuliaModules {
        packages: Vec::new(),
        files: vec![sandbox.dir.join("Tools.jl").to_string_lossy().into_owned()],
    });
    recalc(&mut s);
    assert_eq!(real(&state(&s, &root, "use")), 6.0);
    assert_eq!(real(&state(&s, &root, "value")), 5.0);
    // Direct calls and values use the same conversion bridge as registrations.
    for (id, expected) in [
        ("direct", 6.0),
        ("aliasuse", 10.0),
        ("nested", 4.0),
        ("vector", 12.0),
        ("units", 6.0),
    ] {
        assert_eq!(real(&state(&s, &root, id)), expected, "{id}");
    }
    for id in ["arity", "notcallable"] {
        let result = state(&s, &root, id);
        assert!(
            failure(&result).message.contains("MethodError"),
            "{id}: {result:?}"
        );
    }
    s.set_trusted(false);
    s.recalculate(RecalcMode::All, &mut |_| {}).unwrap();
    for id in ["direct", "value", "alias", "nested"] {
        assert_eq!(
            failure(&state(&s, &root, id)).kind,
            FailureKind::NotTrusted,
            "{id}"
        );
    }
    s.set_trusted(true);
    // A missing module file is a problem of the worksheet.
    s.set_julia_modules(JuliaModules {
        packages: Vec::new(),
        files: vec![sandbox.dir.join("Gone.jl").to_string_lossy().into_owned()],
    });
    recalc(&mut s);
    assert!(s
        .diagnostics()
        .iter()
        .any(|diagnostic| diagnostic.message.contains("Gone.jl")));
}

#[test]
fn a_julia_cell_keeps_its_output_duration_and_trace() {
    // the specification .
    let Some(kernel) = kernel() else { return };
    let sandbox = Sandbox::new("output");
    sandbox.write(
        "main.eqv",
        r#"format: equavela-worksheet/3
regions:
  - id: ok
    at: [0, 10]
    julia:
      code: |
        println("hello")
        boom() = error("kaput")
  - id: bad
    at: [0, 20]
    julia:
      code: |
        println("before")
        boom()
  - id: math
    at: [0, 30]
    math: "1 + 1 ="
"#,
    );
    let (mut s, root) = sandbox.session(kernel, "julia-output");
    s.set_trusted(true);
    recalc(&mut s);
    let results = s.results();
    let entry = |id: &str| {
        results
            .snapshot()
            .into_iter()
            .find(|entry| entry.key.document == root && entry.key.region_id == id)
            .unwrap()
    };
    let ok = entry("ok").output.unwrap();
    assert_eq!(ok.text, "hello\n");
    assert!(ok.duration_ms >= 0.0 && ok.trace.is_none());
    let bad = entry("bad").output.unwrap();
    assert_eq!(bad.text, "before\n");
    assert!(bad.trace.unwrap().contains("boom()"));
    assert!(entry("math").output.is_none());
    // Running the cell again replaces the output; a stale cell has none.
    s.rerun_region(&root, "ok").unwrap();
    assert!(entry("ok").output.is_none());
    recalc(&mut s);
    assert_eq!(entry("ok").output.unwrap().text, "hello\n");
}

#[test]
fn the_kernel_completes_julia_names_in_characters() {
    // the specification, the specification `complete`.
    let Some(kernel) = kernel() else { return };
    kernel.start().unwrap();
    let completions = kernel.complete(None, &[], "y = σ + prin", 12).unwrap();
    assert!(
        completions.items.iter().any(|item| item == "println"),
        "{completions:?}"
    );
    assert_eq!((completions.from, completions.to), (8, 12));
}
