//! Integration tests of the kernel supervisor against the real `EquavelaKernel` process.
//! They are skipped (with a message) when `julia` is not on PATH.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use equavela_core::codegen::{generate_worksheet, GenOptions};
use equavela_core::graph::{Region, Worksheet};
use equavela_core::kernel::RpcId;
use equavela_core::kernel_manager::{
    EvaluateRequest, KernelConfig, KernelError, KernelManager, RegionInput, RegionOutcome,
    RequestOptions,
};
use equavela_core::kernel_value::{KernelValue, MatrixStorage};
use equavela_core::parse_statement;

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

fn config() -> KernelConfig {
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    // The SymPy warm-up is not needed here and would delay the kernel shutdown.
    config
        .env
        .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
    config.startup_timeout = Duration::from_secs(180);
    config
}

macro_rules! kernel {
    () => {
        kernel!(config())
    };
    ($config:expr) => {{
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        KernelManager::new($config)
    }};
}

fn region(id: &str, y: f64, math: &str) -> Region {
    Region {
        id: id.to_string(),
        page: 0,
        x: 0.0,
        y,
        enabled: true,
        statement: std::sync::Arc::new(parse_statement(math).unwrap()),
    }
}

fn worksheet(sources: &[&str]) -> Worksheet {
    Worksheet {
        regions: sources
            .iter()
            .enumerate()
            .map(|(index, math)| region(&format!("r{index:03}"), index as f64, math))
            .collect(),
    }
}

fn real(value: f64) -> KernelValue {
    KernelValue::real(value)
}

/// The elements of an inline matrix in row-major (visual) order.
fn rows(value: &KernelValue) -> Vec<Vec<f64>> {
    let KernelValue::Matrix {
        rows,
        cols,
        storage: MatrixStorage::Inline { values },
    } = value
    else {
        panic!("not an inline matrix: {value:?}");
    };
    let number = |value: &KernelValue| match value {
        KernelValue::Real { value } => value.as_f64(),
        other => panic!("not a real: {other:?}"),
    };
    (0..*rows)
        .map(|row| {
            (0..*cols)
                .map(|col| number(&values[col * rows + row]))
                .collect()
        })
        .collect()
}

fn raw(id: &str, code: Option<&str>, value: Option<&str>) -> RegionInput {
    RegionInput {
        display_unit: None,
        capture: false,
        id: id.into(),
        code: code.map(Into::into),
        value: value.map(Into::into),
    }
}

fn raw_request(worksheet: &str, regions: Vec<RegionInput>) -> EvaluateRequest {
    EvaluateRequest {
        worksheet: worksheet.into(),
        reset: false,
        origin: None,
        tol: None,
        ctol: None,
        exact_boolean: None,
        packages: Vec::new(),
        modules: Vec::new(),
        environment: None,
        base_dir: None,
        module_name: None,
        regions,
    }
}

#[test]
fn handshake_ping_and_clean_shutdown() {
    let manager = kernel!();
    assert!(!manager.is_running());
    let info = manager.start().expect("start");
    assert_eq!(info.protocol, 1);
    assert_eq!(info.package, "0.1.0");
    assert!(manager.is_running());
    assert_eq!(manager.generation(), 1);
    manager.ping().expect("ping");
    assert!(!manager.interrupt_active().unwrap(), "nothing is active");

    manager.shutdown();
    assert!(!manager.is_running());
    // The next request starts a new kernel.
    manager.ping().expect("ping after shutdown");
    assert_eq!(manager.generation(), 2);
}

#[test]
fn evaluates_a_generated_worksheet_against_golden_values() {
    let manager = kernel!();
    let sheet = worksheet(&[
        "x := 3",
        "y := x^2 + 1 =",
        "M := [1, 2; 3, 4]",
        "M·M =",
        "z := 1 + 2j =",
        "s := \"text\" =",
        "n := ‖[3; 4]‖ =",
        "t := √[3](-8) =",
        "v := [1; 2; 3]",
        "v =",
        "bad(x) := program\n  y ← 1\n  error(\"boom\")\n  y\n",
        "bad(1) =",
        "bad(2) + 1 =",
        "k := 7 =",
    ]);
    let generated = generate_worksheet(&sheet, GenOptions::default()).unwrap();
    let request = EvaluateRequest::from_generated("golden", &generated);
    let mut notifications = 0;
    let response = manager
        .evaluate_with_progress(&request, &mut |progress| {
            assert_eq!(progress.sequence as usize, notifications + 1);
            notifications += 1;
        })
        .expect("evaluate");
    assert!(notifications >= 1, "progress notifications arrive");
    assert_eq!(response.regions.len(), generated.regions.len());
    assert!(response.packages.is_empty());

    let value = |index: usize| match &response.region(&format!("r{index:03}")).unwrap().outcome {
        RegionOutcome::Value(value) => value.clone(),
        RegionOutcome::Error(error) => panic!("r{index:03} failed: {error:?}"),
    };
    assert_eq!(value(1), Some(real(10.0)));
    assert_eq!(
        rows(&value(3).unwrap()),
        vec![vec![7.0, 10.0], vec![15.0, 22.0]]
    );
    assert_eq!(
        value(4),
        Some(KernelValue::Complex {
            real: 1.0.into(),
            imag: 2.0.into()
        })
    );
    assert_eq!(
        value(5),
        Some(KernelValue::String {
            value: "text".into()
        })
    );
    assert_eq!(value(6), Some(real(5.0)));
    match value(7) {
        Some(KernelValue::Real { value }) => assert!((value.as_f64() + 2.0).abs() < 1e-12),
        other => panic!("cube root: {other:?}"),
    }
    assert_eq!(
        rows(&value(9).unwrap()),
        vec![vec![1.0], vec![2.0], vec![3.0]]
    );
    assert_eq!(value(13), Some(real(7.0)));

    // Per-region errors carry the statement location; later regions still ran.
    let RegionOutcome::Error(error) = &response.region("r011").unwrap().outcome else {
        panic!("bad(1) should fail");
    };
    assert_eq!(error.message, "boom");
    assert_eq!(error.category, "evaluation");
    assert_eq!(error.julia_type, None);
    let statement = error.statement.expect("statement id");
    let location = generated
        .statements
        .iter()
        .find(|location| location.id == statement)
        .expect("known statement");
    assert_eq!(location.region_id, "r010");
    assert!(matches!(
        response.region("r012").unwrap().outcome,
        RegionOutcome::Error(_)
    ));

    // The module persists: a second request sees the earlier definitions.
    let again = raw_request(
        "golden",
        vec![raw("again", None, Some("eq_add(y_v1, 1.0)"))],
    );
    let again = manager.evaluate(&again).expect("evaluate again");
    assert_eq!(
        again.region("again").unwrap().outcome,
        RegionOutcome::Value(Some(real(11.0)))
    );
    // Worksheets are isolated.
    let other = raw_request("other", vec![raw("again", None, Some("y_v1"))]);
    let other = manager.evaluate(&other).expect("evaluate other");
    assert!(matches!(
        other.region("again").unwrap().outcome,
        RegionOutcome::Error(_)
    ));
    manager.discard("golden").expect("discard");
    let gone = manager
        .evaluate(&again_request())
        .expect("evaluate after discard");
    assert!(matches!(
        gone.region("again").unwrap().outcome,
        RegionOutcome::Error(_)
    ));
}

fn again_request() -> EvaluateRequest {
    raw_request("golden", vec![raw("again", None, Some("y_v1"))])
}

#[test]
fn large_matrices_use_binary_frames_and_decode() {
    let manager = kernel!();
    let sheet = worksheet(&[
        "A := identity(20)",
        "A =",
        "B := A·2 =",
        "1 =",
        "C := stack(A, A) =",
    ]);
    let generated = generate_worksheet(&sheet, GenOptions::default()).unwrap();
    let request = EvaluateRequest::from_generated("binary", &generated);
    let response = manager.evaluate(&request).expect("evaluate");
    for id in ["r001", "r002", "r004"] {
        let RegionOutcome::Value(Some(value)) = &response.region(id).unwrap().outcome else {
            panic!("{id}: {:?}", response.region(id));
        };
        let matrix = rows(value);
        let scale = if id == "r002" { 2.0 } else { 1.0 };
        let expected_rows = if id == "r004" { 40 } else { 20 };
        assert_eq!(matrix.len(), expected_rows, "{id}");
        for (row, line) in matrix.iter().enumerate() {
            for (col, number) in line.iter().enumerate() {
                let expected = if row % 20 == col { scale } else { 0.0 };
                assert_eq!(*number, expected, "{id} [{row},{col}]");
            }
        }
    }
    assert_eq!(
        response.region("r003").unwrap().outcome,
        RegionOutcome::Value(Some(real(1.0)))
    );
}

#[test]
fn interrupt_stops_a_running_request_and_keeps_the_kernel() {
    let manager = kernel!();
    manager.start().unwrap();
    // Warm up so the loop starts immediately.
    manager
        .evaluate(&raw_request(
            "int",
            vec![raw("w", Some("w_v1 = 1.0"), Some("w_v1"))],
        ))
        .unwrap();
    let generation = manager.generation();

    let id = RpcId::String("long-loop".into());
    let options = RequestOptions {
        id: Some(id.clone()),
        timeout: None,
    };
    let params = serde_json::to_value(raw_request(
        "int",
        vec![raw("loop", Some("while true; rand(1000); end"), None)],
    ))
    .unwrap();
    let started = Instant::now();
    let result = std::thread::scope(|scope| {
        let manager = &manager;
        let id = id.clone();
        scope.spawn(move || {
            std::thread::sleep(Duration::from_millis(1000));
            // A tag that does not match is ignored.
            assert!(!manager
                .interrupt_request(&RpcId::String("other".into()))
                .unwrap());
            assert!(manager.interrupt_request(&id).unwrap());
        });
        manager.request_with("evaluate", Some(params), &options, &mut |_| {})
    });
    assert!(
        matches!(result, Err(KernelError::Interrupted)),
        "unexpected: {result:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_eq!(
        manager.generation(),
        generation,
        "the kernel was not restarted"
    );
    // The same module is still alive and a late interrupt does nothing.
    assert!(!manager.interrupt_request(&id).unwrap());
    let after = manager
        .evaluate(&raw_request("int", vec![raw("a", None, Some("w_v1"))]))
        .unwrap();
    assert_eq!(
        after.region("a").unwrap().outcome,
        RegionOutcome::Value(Some(real(1.0)))
    );
}

#[test]
fn timeouts_interrupt_then_kill_and_restart() {
    let mut config = config();
    config.request_timeout = None;
    config.interrupt_grace = Duration::from_millis(1500);
    let manager = kernel!(config);
    manager.start().unwrap();
    manager
        .evaluate(&raw_request("t", vec![raw("w", Some("w_v1 = 1.0"), None)]))
        .unwrap();
    let generation = manager.generation();

    // Allocating loop: the soft interrupt works, so the result is a timeout, no kill.
    let options = RequestOptions {
        id: None,
        timeout: Some(Duration::from_millis(800)),
    };
    let params = serde_json::to_value(raw_request(
        "t",
        vec![raw("loop", Some("while true; rand(1000); end"), None)],
    ))
    .unwrap();
    let result = manager.request_with("evaluate", Some(params), &options, &mut |_| {});
    assert!(matches!(result, Err(KernelError::Timeout)), "{result:?}");
    assert_eq!(manager.generation(), generation);

    // A tight loop that never reaches a safepoint ignores the interrupt: the kernel is
    // killed after the grace period and the next request starts a fresh one. (If this Julia
    // version can interrupt the loop, a timeout is just as acceptable.)
    let params = serde_json::to_value(raw_request(
        "t",
        vec![raw("tight", Some("while true end"), None)],
    ))
    .unwrap();
    let result = manager.request_with("evaluate", Some(params), &options, &mut |_| {});
    match result {
        Err(KernelError::Unresponsive) => {
            assert!(!manager.is_running());
            manager.ping().expect("restart after kill");
            assert_eq!(manager.generation(), generation + 1);
            // The module state was lost with the process.
            let lost = manager
                .evaluate(&raw_request("t", vec![raw("a", None, Some("w_v1"))]))
                .unwrap();
            assert!(matches!(
                lost.region("a").unwrap().outcome,
                RegionOutcome::Error(_)
            ));
        }
        Err(KernelError::Timeout) => manager.ping().expect("kernel alive"),
        other => panic!("unexpected: {other:?}"),
    }
}

#[test]
fn a_crashed_kernel_is_reported_and_restarted() {
    let reports = tempfile::tempdir().unwrap();
    let mut config = config();
    config.crash_report_dir = Some(reports.path().to_path_buf());
    let manager = kernel!(config);
    manager.start().unwrap();
    let generation = manager.generation();
    let crash = raw_request("c", vec![raw("die", Some("exit(3)"), None)]);
    match manager.evaluate(&crash) {
        Err(KernelError::Crashed { exit, .. }) => {
            assert!(exit.contains('3'), "exit status was {exit}")
        }
        other => panic!("unexpected: {other:?}"),
    }
    assert!(!manager.is_running());
    let files = std::fs::read_dir(reports.path())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(files.len(), 1);
    let report = std::fs::read_to_string(files[0].path()).unwrap();
    assert!(report.contains("Julia kernel incident"));
    assert!(report.contains("operation evaluate"));
    assert!(report.contains("exit status"));
    manager.ping().expect("restart after crash");
    assert_eq!(manager.generation(), generation + 1);
}

#[test]
fn startup_failures_are_errors() {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return;
    }
    let mut missing = config().with_julia("definitely-not-a-julia-executable");
    missing.resolve_real_julia = false;
    assert!(matches!(
        KernelManager::new(missing).start(),
        Err(KernelError::Spawn(_))
    ));

    // A kernel that speaks another protocol version is rejected by the handshake.
    let dir = repo_root().join("target").join("kernel-manager-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("wrong-protocol.jl");
    std::fs::write(
        &script,
        "println(\"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"result\\\":{\\\"julia\\\":\\\"x\\\",\\\"package\\\":\\\"y\\\",\\\"protocol\\\":99}}\")\nflush(stdout)\nsleep(5)\n",
    )
    .unwrap();
    let mut wrong = config();
    wrong.script = Some(script);
    let error = KernelManager::new(wrong).start().unwrap_err();
    assert!(
        matches!(&error, KernelError::Handshake(message) if message.contains("protocol 99")),
        "{error:?}"
    );

    // A kernel that exits immediately is a handshake failure with its stderr.
    let script = dir.join("dies.jl");
    std::fs::write(&script, "println(stderr, \"kernel exploded\")\nexit(2)\n").unwrap();
    let mut dying = config();
    dying.script = Some(script);
    let error = KernelManager::new(dying).start().unwrap_err();
    assert!(
        matches!(&error, KernelError::Handshake(message) if message.contains("kernel exploded")),
        "{error:?}"
    );
}

#[test]
fn a_sysimage_julia_rejects_falls_back_to_the_stock_runtime() {
    // A file that is not a sysimage makes Julia exit at start-up; the manager must log it,
    // start without the image and not try it again after a restart.
    let dir = std::env::temp_dir().join(format!("equavela-bad-sysimage-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let image = dir.join("not-a-sysimage.bin");
    std::fs::write(&image, b"this is not a system image").unwrap();
    let mut cfg = config();
    cfg.sysimage = Some(image);
    let kernel = kernel!(cfg);
    let info = kernel.start().expect("falls back and starts");
    assert_eq!(info.protocol, equavela_core::kernel::PROTOCOL_VERSION);
    assert!(!kernel.sysimage_in_use());
    kernel.ping().unwrap();
    kernel
        .restart()
        .expect("restart without the rejected image");
    assert!(!kernel.sysimage_in_use());
    kernel.shutdown();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_sysimage_file_is_ignored() {
    let mut cfg = config();
    cfg.sysimage = Some(std::env::temp_dir().join("equavela-no-such-sysimage.dll"));
    let kernel = kernel!(cfg);
    kernel.start().unwrap();
    assert!(!kernel.sysimage_in_use());
    kernel.shutdown();
}

#[test]
fn the_first_symbolic_request_announces_the_wait_and_its_end() {
    let manager = kernel!();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = std::sync::Arc::clone(&seen);
    manager.on_activity(std::sync::Arc::new(move |activity| {
        log.lock().unwrap().push(activity.map(|a| a.kind.clone()));
    }));
    manager.start().unwrap();
    let request = equavela_core::symbolic::SymbolicRequest::new(
        equavela_core::parse_expression("x + x").unwrap(),
        Vec::new(),
    );
    let _ = manager.symbolic(&request);
    // Once the engine is ready, a request does not announce anything.
    let _ = manager.symbolic(&request);
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen, vec![Some("symbolic".to_owned()), None], "{seen:?}");
}
