//! Solve blocks end to end through the real kernel. The tests are
//! skipped (with a message) when `julia` is not on PATH, like `julia_session.rs`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::DocumentId;
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::load_project_text;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn kernel() -> Option<Arc<KernelManager>> {
    let available = std::process::Command::new("julia")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !available {
        eprintln!("skipping: julia is not on PATH");
        return None;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config
        .env
        .push(("SHEET_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(300);
    Some(Arc::new(KernelManager::new(config)))
}

const SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: g
    at: [0, 10]
    math: "g := 1"
  - id: given
    at: [0, 20]
    math: "Given"
  - id: c1
    at: [0, 30]
    math: "g^2 == 2"
  - id: c2
    at: [0, 40]
    math: "g > 0"
  - id: solve
    at: [0, 50]
    math: "Find(g) ="
  - id: best
    at: [0, 80]
    math: "h := 5"
  - id: f
    at: [0, 85]
    math: "f(t) := t^2"
  - id: given2
    at: [0, 88]
    math: "Given"
  - id: c3
    at: [0, 89]
    math: "h >= 2"
  - id: min
    at: [0, 90]
    math: "Minimize(f, h) ="
  - id: given3
    at: [0, 110]
    math: "Given"
  - id: c4
    at: [0, 115]
    math: "g^2 == -1"
  - id: impossible
    at: [0, 120]
    math: "Find(g) ="
  - id: nogiven
    at: [0, 130]
    math: "Find(g) ="
  - id: umin_f
    at: [0, 140]
    math: "q(t) := (t - 3)^2 + 1"
  - id: umin
    at: [0, 150]
    math: "Minimize(q, h) ="
  - id: umax_f
    at: [0, 160]
    math: "r(t) := -(t - 4)^2 + 5"
  - id: umax
    at: [0, 170]
    math: "Maximize(r, h) ="
"#;

fn real(session: &WorksheetSession, root: &DocumentId, id: &str) -> f64 {
    let key = RegionKey {
        document: root.clone(),
        region_id: id.to_owned(),
        instance: 0,
    };
    match session.results().get(&key).unwrap() {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("{id}: not a real value: {other:?}"),
    }
}

fn is_error(session: &WorksheetSession, root: &DocumentId, id: &str) -> bool {
    let key = RegionKey {
        document: root.clone(),
        region_id: id.to_owned(),
        instance: 0,
    };
    matches!(
        session.results().get(&key).unwrap(),
        RegionState::Error { .. }
    )
}

#[test]
fn solve_blocks_calculate_through_the_kernel() {
    let Some(kernel) = kernel() else { return };
    let id = DocumentId::new("/solve.eqv").unwrap();
    let loaded = load_project_text(id, SHEET).unwrap();
    let root = loaded.root.clone();
    let mut session = WorksheetSession::new(
        kernel,
        "solve-block",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    // Find(g) with g^2 = 2 and g > 0, from the guess g = 1.
    assert!((real(&session, &root, "solve") - 2f64.sqrt()).abs() < 1e-6);
    // Minimize(f, h) with h >= 2 and f(t) = t^2.
    assert!((real(&session, &root, "min") - 2.0).abs() < 1e-3);
    // No solution is an error in that region only.
    assert!(is_error(&session, &root, "impossible"));
    // A call without a Given above it is an error, not a solve with no constraints.
    assert!(is_error(&session, &root, "nogiven"));
    // Minimize and Maximize without a Given above them solve unconstrained.
    assert!((real(&session, &root, "umin") - 3.0).abs() < 1e-4);
    assert!((real(&session, &root, "umax") - 4.0).abs() < 1e-4);

    // Editing a constraint region recalculates the solving region (one ordinary math edit).
    session.edit_math(&root, "c1", "g^2 == 9").unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert!((real(&session, &root, "solve") - 3.0).abs() < 1e-6);
}

const ODE_SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: given
    at: [0, 10]
    math: "Given"
  - id: eq
    at: [0, 20]
    math: "y′′(t) + y(t) == 0"
  - id: c1
    at: [0, 30]
    math: "y(0) == 0"
  - id: c2
    at: [0, 40]
    math: "y′(0) == 1"
  - id: solve
    at: [0, 50]
    math: "y := odesolve(y(t), 3.14159265358979)"
  - id: value
    at: [0, 60]
    math: "y(1) ="
  - id: given2
    at: [0, 70]
    math: "Given"
  - id: eq2
    at: [0, 80]
    math: "z′(s) == -2*z(s)"
  - id: c3
    at: [0, 90]
    math: "z(0) == 3"
  - id: solve2
    at: [0, 100]
    math: "z := odesolve(z(s), 1, 200)"
  - id: value2
    at: [0, 110]
    math: "z(0.5) ="
  - id: given3
    at: [0, 120]
    math: "Given"
  - id: eq3
    at: [0, 130]
    math: "ⅆ[s] w(s) == -w(s)"
  - id: c4
    at: [0, 140]
    math: "w(0) == 1"
  - id: eq4
    at: [0, 150]
    math: "ⅆ[s^2] v(s) == -v(s)"
  - id: c5
    at: [0, 160]
    math: "v(0) == 0"
  - id: c6
    at: [0, 170]
    math: "v(1.5707963267949) == 1"
  - id: solve3
    at: [0, 180]
    math: "[w; v] := odesolve([w(s); v(s)], 1.5707963267949)"
  - id: value3
    at: [0, 190]
    math: "w(1) ="
  - id: value4
    at: [0, 200]
    math: "v(1) ="
"#;

#[test]
fn odesolve_blocks_calculate_through_the_kernel() {
    let Some(kernel) = kernel() else { return };
    let id = DocumentId::new("/ode.eqv").unwrap();
    let loaded = load_project_text(id, ODE_SHEET).unwrap();
    let root = loaded.root.clone();
    let mut session = WorksheetSession::new(
        kernel,
        "odesolve",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    // y'' + y = 0 with y(0) = 0 and y'(0) = 1 is sin(t).
    assert!((real(&session, &root, "value") - 1f64.sin()).abs() < 1e-8);
    // z' = -2 z with z(0) = 3 is 3 exp(-2 s).
    assert!((real(&session, &root, "value2") - 3.0 * (-1f64).exp()).abs() < 1e-8);
    // the reference application writes the derivative as the operator (ⅆ[s] w(s), ⅆ[s^2] v(s)): w' = -w is exp(-s) and
    // v'' = -v with v(0) = 0, v(pi/2) = 1 is sin(s).
    assert!((real(&session, &root, "value3") - (-1f64).exp()).abs() < 1e-8);
    assert!((real(&session, &root, "value4") - 1f64.sin()).abs() < 1e-8);
}

const GLOBAL_SHEET: &str = r#"format: equavela-worksheet/3
regions:
  - id: f
    at: [0, 10]
    math: "f(x, y) := x^2 + y^2 + 10·(2 - cos(2·π·x) - cos(2·π·y))"
  - id: x
    at: [0, 20]
    math: "x := 3.1"
  - id: y
    at: [0, 30]
    math: "y := 2.9"
  - id: given
    at: [0, 40]
    math: "Given"
  - id: c1
    at: [0, 50]
    math: "x >= -5"
  - id: c2
    at: [0, 60]
    math: "x <= 5"
  - id: c3
    at: [0, 70]
    math: "y >= -5"
  - id: c4
    at: [0, 80]
    math: "y <= 5"
  - id: local
    at: [0, 90]
    math: "p := Minimize(f, x, y)"
  - id: given2
    at: [0, 100]
    math: "Given"
  - id: d1
    at: [0, 110]
    math: "x >= -5"
  - id: d2
    at: [0, 120]
    math: "x <= 5"
  - id: d3
    at: [0, 130]
    math: "y >= -5"
  - id: d4
    at: [0, 140]
    math: "y <= 5"
  - id: global
    at: [0, 150]
    math: "q := Minimize(f, x, y)"
    numeric:
      algorithm: direct-l
  - id: px
    at: [0, 160]
    math: "p[0] ="
  - id: qx
    at: [0, 170]
    math: "q[0] ="
"#;

#[test]
fn a_global_algorithm_chosen_for_the_region_finds_the_minimum_in_the_box() {
    let Some(kernel) = kernel() else { return };
    let id = DocumentId::new("/global.eqv").unwrap();
    let loaded = load_project_text(id, GLOBAL_SHEET).unwrap();
    let root = loaded.root.clone();
    let mut session = WorksheetSession::new(
        kernel,
        "global",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    // The local default stays near the guess; DIRECT-L finds the minimum at the origin.
    assert!(real(&session, &root, "px") > 2.5);
    assert!(real(&session, &root, "qx").abs() < 1e-6);
}
