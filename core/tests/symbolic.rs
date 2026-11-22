//! Symbolic evaluation: request building, result parsing and the
//! real kernel with SymPy end to end.
//!
//! The kernel tests are skipped (with a message) when `julia` is not on PATH or the Python
//! environment with SymPy is not available (`symbolic_status` answers `failed`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use equavela_core::ast::{Expr, ExprKind, Name};
use equavela_core::codegen::GenOptions;
use equavela_core::graph::{DependencyGraph, Region, Worksheet};
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::KernelValue;
use equavela_core::project::{
    CalculationSettings, DocumentId, DocumentRegion, Project, ProjectDocument,
};
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::symbolic::{
    apply_operation, parse_symbolic_result, region_request, SymbolicOperation, SymbolicOutcome,
    SymbolicRequest,
};
use equavela_core::{parse_expression, parse_statement, print_expression};
use serde_json::json;

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

fn name(text: &str) -> Name {
    Name::plain(text)
}

fn expr(text: &str) -> Expr {
    parse_expression(text).unwrap_or_else(|error| panic!("`{text}`: {error:?}"))
}

fn worksheet(math: &[&str]) -> Worksheet {
    Worksheet {
        regions: math
            .iter()
            .enumerate()
            .map(|(i, text)| Region {
                id: format!("r{i}"),
                page: 0,
                x: 0.0,
                y: i as f64,
                enabled: true,
                statement: std::sync::Arc::new(
                    parse_statement(text).unwrap_or_else(|e| panic!("`{text}`: {e:?}")),
                ),
            })
            .collect(),
    }
}

// ------------------------------------------------------------------ request building

#[test]
fn the_request_of_a_region_carries_its_transitive_definitions_in_order() {
    let sheet = worksheet(&[
        "a := 3",
        "unrelated := 7",
        "b := a + 1",
        "f(x) := b·x",
        "a := 10",
        "ⅆ[x] f(x) →",
    ]);
    let graph = DependencyGraph::build(&sheet).unwrap();
    // The region that is not symbolic has no request.
    assert!(region_request(&sheet, &graph, "r0").is_none());
    let request = region_request(&sheet, &graph, "r5").unwrap();
    let names: Vec<String> = request
        .definitions
        .iter()
        .map(|d| equavela_core::syntax::print_name(&d.name))
        .collect();
    // `unrelated` and the later `a := 10` are not reachable from the expression.
    assert_eq!(names, ["a", "b", "f"]);
    assert!(request.definitions[2].params.is_some());
    assert!(request.keywords.is_empty());
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(value["expr"]["type"], "Deriv");
    assert_eq!(value["definitions"][0]["params"], serde_json::Value::Null);
}

#[test]
fn symbolic_find_builds_a_system_without_dependencies_on_guesses() {
    let mut sheet = worksheet(&[
        "x := 99",
        "y := 42",
        "a := 6",
        "Given",
        "x + y == a",
        "x - y == 2",
        "s := Find(y, x) →",
        "s →",
    ]);
    sheet.assemble_solve_blocks();
    let graph = DependencyGraph::build(&sheet).unwrap();
    let request = region_request(&sheet, &graph, "r6").unwrap();
    assert_eq!(request.keywords[0].keyword, "solve");
    assert_eq!(print_expression(&request.keywords[0].args[0]), "[y; x]");
    assert_eq!(request.definitions.len(), 1);
    assert_eq!(request.definitions[0].name, name("a"));
    let downstream = region_request(&sheet, &graph, "r7").unwrap();
    let definition = downstream.definitions.last().unwrap();
    assert_eq!(definition.name, name("s"));
    assert_eq!(definition.keywords[0].keyword, "solve");
}

#[test]
fn a_definition_by_a_symbolic_result_keeps_its_keywords_and_frees_its_parameters() {
    let sheet = worksheet(&[
        "S(n, N_z) := (2·N_z - (k - 1))/2·k == n →[solve, k]",
        "S(1, 2) →[simplify]",
    ]);
    let graph = DependencyGraph::build(&sheet).unwrap();
    let own = region_request(&sheet, &graph, "r0").unwrap();
    assert_eq!(own.keywords[0].keyword, "solve");
    let free: Vec<String> = own
        .free
        .iter()
        .map(equavela_core::syntax::print_name)
        .collect();
    assert_eq!(free, ["n", "N_z"]);
    let using = region_request(&sheet, &graph, "r1").unwrap();
    assert_eq!(using.definitions.len(), 1);
    assert_eq!(using.definitions[0].keywords[0].keyword, "solve");
}

#[test]
fn operations_become_keywords_or_calculus_nodes() {
    let e = expr("x^2");
    let simplify = SymbolicOperation::Simplify.request(&e);
    assert_eq!(simplify.keywords[0].keyword, "simplify");
    let solve = SymbolicOperation::SolveFor { var: name("x") }.request(&e);
    assert_eq!(solve.keywords[0].keyword, "solve");
    assert_eq!(print_expression(&solve.keywords[0].args[0]), "x");
    let derive = SymbolicOperation::Differentiate { var: name("x") }.request(&e);
    assert!(derive.keywords.is_empty());
    assert_eq!(print_expression(&derive.expr), "ⅆ[x] x^2");
    let integrate = SymbolicOperation::Integrate { var: name("x") }.request(&e);
    assert_eq!(print_expression(&integrate.expr), "∫[x] x^2");
    let substitute = SymbolicOperation::Substitute {
        var: name("x"),
        value: expr("3"),
    }
    .request(&e);
    assert_eq!(print_expression(&substitute.keywords[0].args[0]), "x == 3");
    let series = SymbolicOperation::Series {
        var: name("x"),
        order: 4,
    }
    .request(&e);
    assert_eq!(series.keywords[0].args.len(), 2);
}

#[test]
fn results_are_normalized_and_printed_in_canonical_text() {
    // The kernel sends no Paren nodes: 2 · (x + 1) must come back with its parentheses.
    let result = json!({
        "status": "ok",
        "value": {"type": "symbolic", "expr": {
            "type": "Mul",
            "left": {"type": "Num", "text": "2"},
            "right": {"type": "Add",
                "left": {"type": "Ident", "name": {"segments": [{"text": "x", "subscript": false}], "label": null}},
                "right": {"type": "Num", "text": "1"}},
            "split": false
        }}
    });
    let SymbolicOutcome::Value(KernelValue::Symbolic { expr, text }) =
        parse_symbolic_result(&result).unwrap()
    else {
        panic!("not a symbolic value");
    };
    assert_eq!(text, "2·(x + 1)");
    assert_eq!(parse_expression(&text).unwrap(), *expr);

    let failure = json!({"status": "error", "error": {"category": "unsupported", "message": "no"}});
    let SymbolicOutcome::Error(error) = parse_symbolic_result(&failure).unwrap() else {
        panic!("not an error");
    };
    assert_eq!(error.category, "unsupported");
    assert!(parse_symbolic_result(&json!({"status": "maybe"})).is_err());
}

// ------------------------------------------------------------------ the real kernel

/// A kernel with the SymPy warm-up enabled, or `None` (skip) when it cannot run.
fn symbolic_kernel() -> Option<Arc<KernelManager>> {
    symbolic_kernel_in(false)
}

/// The same, with the kernel inside a PTY and a loopback RPC as the desktop app runs it.
fn symbolic_kernel_in(terminal: bool) -> Option<Arc<KernelManager>> {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return None;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config.startup_timeout = Duration::from_secs(180);
    config.terminal = terminal;
    let kernel = Arc::new(KernelManager::new(config));
    // Wait for the warm-up to finish: it tells whether SymPy can run at all.
    kernel.start().expect("kernel starts");
    kernel
        .symbolic_warmup()
        .expect("the warm-up request is answered");
    let deadline = Instant::now() + Duration::from_secs(240);
    loop {
        let status = kernel.symbolic_status().unwrap();
        match status.state.as_str() {
            "ready" => return Some(kernel),
            "failed" if std::env::var_os("EQUAVELA_REQUIRE_SYMPY").is_some() => {
                panic!(
                    "the symbolic engine is required but failed: {:?}",
                    status.message
                )
            }
            "failed" => {
                eprintln!(
                    "skipping: the symbolic engine is not available ({:?})",
                    status.message
                );
                return None;
            }
            _ if Instant::now() > deadline => panic!("the SymPy warm-up did not finish"),
            _ => std::thread::sleep(Duration::from_millis(200)),
        }
    }
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
                statement: std::sync::Arc::new(
                    parse_statement(text).unwrap_or_else(|e| panic!("`{text}`: {e:?}")),
                ),
            }))
        })
        .map(std::sync::Arc::new)
        .collect();
    let mut project = Project::new();
    project
        .insert(ProjectDocument {
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
        })
        .unwrap();
    let texts: HashMap<_, _> = math
        .iter()
        .map(|(r, t)| ((id.clone(), (*r).to_owned()), (*t).to_owned()))
        .collect();
    WorksheetSession::new(
        kernel,
        "symbolic-test",
        project,
        id,
        texts,
        GenOptions::default(),
    )
    .unwrap()
}

fn region_state(session: &WorksheetSession, region_id: &str) -> RegionState {
    let key = RegionKey {
        document: DocumentId::new("/root.eqv").unwrap(),
        region_id: region_id.to_owned(),
        instance: 0,
    };
    session.results().get(&key).unwrap()
}

/// The text and AST of a symbolic region result.
fn symbolic_result(session: &WorksheetSession, region_id: &str) -> (String, Expr) {
    match region_state(session, region_id) {
        RegionState::Value {
            value: Some(KernelValue::Symbolic { expr, text }),
            ..
        } => {
            // The printed text is what the parser accepts, and printing it again is a fixed point.
            let parsed = parse_expression(&text).unwrap_or_else(|e| panic!("`{text}`: {e:?}"));
            assert_eq!(print_expression(&parsed), text, "round trip of `{text}`");
            (text, *expr)
        }
        other => panic!("region {region_id}: unexpected {other:?}"),
    }
}

/// Whether two expressions are mathematically equal: the difference simplifies to 0,
/// or evaluates to 0 numerically.
fn equivalent(kernel: &KernelManager, a: &str, b: &str) -> bool {
    let difference = expr(&format!("({a}) - ({b})"));
    for keywords in [vec!["simplify"], vec!["expand", "simplify"]] {
        let request = SymbolicRequest::new(
            difference.clone(),
            keywords
                .iter()
                .map(|k| equavela_core::symbolic::SymbolicKeyword {
                    keyword: (*k).into(),
                    args: vec![],
                })
                .collect(),
        );
        if let Ok(SymbolicOutcome::Value(KernelValue::Symbolic { text, .. })) =
            kernel.symbolic(&request)
        {
            if text == "0" {
                return true;
            }
        }
    }
    false
}

#[test]
fn symbolic_solve_and_find_agree_on_both_voltage_and_current_solutions() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let first = "V_DC == V_DC0 - R_eq·I_sec";
    let second = "V_DC0·I_sec == P_sec - (V_DC0 - V_DC)^2/R_eq";
    let list_input = format!("[{first}; {second}] →[solve, V_DC, I_sec]");
    let vector_input = format!("[{first}; {second}] →[solve, [V_DC; I_sec]]");
    let mut sheet = session(
        kernel.clone(),
        &[
            ("guess", "V_DC := 99"),
            ("list", &list_input),
            ("vector", &vector_input),
            ("given", "Given"),
            ("first", first),
            ("second", second),
            ("find", "Find(V_DC, I_sec) →"),
            ("linear-given", "Given"),
            ("linear-first", first),
            (
                "linear-second",
                "V_DC0·I_sec == P_sec - (V_DC0 - V_DC)/R_eq",
            ),
            ("linear-find", "Find(V_DC, I_sec) →"),
        ],
    );
    sheet.recalculate(RecalcMode::Changed, &mut |_| {}).unwrap();
    let (list, result) = symbolic_result(&sheet, "list");
    assert_eq!(symbolic_result(&sheet, "vector").0, list);
    assert_eq!(symbolic_result(&sheet, "find").0, list);
    let ExprKind::Matrix {
        rows: 2,
        cols: 2,
        cells,
    } = result.kind
    else {
        panic!("expected two solutions with two unknowns each, got {list}");
    };
    let discriminant = "√(V_DC0^2 + 4·R_eq·P_sec)";
    let mut positive_voltage_branch_seen = false;
    let mut negative_voltage_branch_seen = false;
    for pair in cells.as_chunks::<2>().0 {
        let voltage = print_expression(&pair[0]);
        let current = print_expression(&pair[1]);
        assert!(equivalent(
            &kernel,
            &voltage,
            &format!("V_DC0 - R_eq·({current})")
        ));
        if equivalent(&kernel, &voltage, &format!("(3·V_DC0 + {discriminant})/2")) {
            positive_voltage_branch_seen = true;
        } else if equivalent(&kernel, &voltage, &format!("(3·V_DC0 - {discriminant})/2")) {
            negative_voltage_branch_seen = true;
        } else {
            panic!("unexpected voltage branch {voltage}");
        }
    }
    assert!(positive_voltage_branch_seen && negative_voltage_branch_seen);

    let (text, linear) = symbolic_result(&sheet, "linear-find");
    let ExprKind::Matrix {
        rows: 1,
        cols: 2,
        cells,
    } = linear.kind
    else {
        panic!("expected one row for the linear Given system, got {text}");
    };
    assert!(equivalent(
        &kernel,
        &print_expression(&cells[0]),
        "V_DC0 - R_eq·P_sec/(V_DC0+1)"
    ));
    assert!(equivalent(
        &kernel,
        &print_expression(&cells[1]),
        "P_sec/(V_DC0+1)"
    ));
}

/// GitHub : symbolic evaluation through the kernel the desktop app starts (PTY + loopback).
#[test]
fn symbolic_evaluation_works_in_the_pty_kernel() {
    let Some(kernel) = symbolic_kernel_in(true) else {
        return;
    };
    let request = SymbolicRequest::new(
        expr("(x+1)^2"),
        vec![equavela_core::symbolic::SymbolicKeyword {
            keyword: "expand".into(),
            args: vec![],
        }],
    );
    match kernel.symbolic(&request) {
        Ok(SymbolicOutcome::Value(KernelValue::Symbolic { text, .. })) => {
            assert!(text.contains("x^2"), "{text}")
        }
        other => panic!("unexpected {other:?}"),
    }
    kernel.shutdown();
}

#[test]
fn the_handshake_does_not_load_sympy_until_asked() {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config.startup_timeout = Duration::from_secs(180);
    let kernel = KernelManager::new(config);
    kernel.start().unwrap();
    // The handshake does not load SymPy: only `symbolic_warmup` starts it.
    assert_eq!(kernel.symbolic_status().unwrap().state, "idle");
    let state = kernel.symbolic_warmup().unwrap().state;
    assert!(
        ["warming", "ready", "failed"].contains(&state.as_str()),
        "{state}"
    );
    // Asking again does not start a second warm-up.
    let again = kernel.symbolic_warmup().unwrap().state;
    assert!(
        ["warming", "ready", "failed"].contains(&again.as_str()),
        "{again}"
    );
    kernel.shutdown();
}

#[test]
fn phase_5_exit_the_derivative_of_a_worksheet_function() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let mut session = session(
        Arc::clone(&kernel),
        &[("f", "f(x) := x^2·sin(x)"), ("d", "ⅆ[x] f(x) →")],
    );
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let (text, _) = symbolic_result(&session, "d");
    assert_eq!(text, "x^2·cos(x) + 2·x·sin(x)");
    // The definition region itself still has no value.
    assert!(matches!(
        region_state(&session, "f"),
        RegionState::Value { value: None, .. }
    ));

    // Editing the function re-evaluates the symbolic region (dependency tracking).
    session
        .edit_math(&DocumentId::new("/root.eqv").unwrap(), "f", "f(x) := x^3")
        .unwrap();
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let (text, _) = symbolic_result(&session, "d");
    assert_eq!(text, "3·x^2");
}

/// The real value of a numeric region.
fn real_value(session: &WorksheetSession, region_id: &str) -> f64 {
    match region_state(session, region_id) {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("region {region_id}: unexpected {other:?}"),
    }
}

#[test]
fn names_defined_by_a_symbolic_result_work_in_numeric_regions() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let mut session = session(
        Arc::clone(&kernel),
        &[
            // a function defined by a derivative, with a numeric use
            ("g", "g(x) := ⅆ[x] x^3 →"),
            ("g2", "g(2) ="),
            // a function defined with a keyword
            ("k", "k(x) := (x^2 - 1)/(x - 1) →[simplify]"),
            ("k4", "k(4) ="),
            // a variable defined by a solve with two solutions (column vector)
            ("s", "S := 2·y^2 - 8 == 0 →[solve, y]"),
            ("s0", "S[0]·S[1] ="),
            // a numeric definition feeds a symbolic one, whose result feeds a numeric one
            ("a", "a := 3"),
            ("h", "h(t) := a·t^2 →"),
            ("h2", "h(2) ="),
            // a symbolic definition that fails keeps its dependents blocked
            ("bad", "b(x) := x →[frobnicate]"),
            ("bad_use", "b(1) ="),
        ],
    );
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert_eq!(real_value(&session, "g2"), 12.0);
    assert_eq!(real_value(&session, "k4"), 5.0);
    assert_eq!(real_value(&session, "s0"), -4.0);
    assert_eq!(real_value(&session, "h2"), 12.0);
    // the symbolic regions still show their symbolic results
    assert_eq!(symbolic_result(&session, "g").0, "3·x^2");
    assert!(matches!(
        region_state(&session, "bad_use"),
        RegionState::Error { .. }
    ));
    kernel.shutdown();
}

#[test]
fn in_place_operations_use_the_same_engine() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let run = |operation: SymbolicOperation, text: &str| {
        let result = apply_operation(&kernel, &operation, &expr(text), Vec::new());
        let mut result = result.expect("operation succeeds");
        equavela_core::syntax::normalize_expr(&mut result);
        print_expression(&result)
    };
    assert_eq!(
        run(SymbolicOperation::Differentiate { var: name("x") }, "x^3"),
        "3·x^2"
    );
    assert_eq!(
        run(SymbolicOperation::Integrate { var: name("x") }, "2·x"),
        "x^2"
    );
    assert_eq!(
        run(
            SymbolicOperation::Substitute {
                var: name("x"),
                value: expr("2")
            },
            "x^2 + y"
        ),
        "y + 4"
    );
    assert_eq!(run(SymbolicOperation::Factor, "x^2 - 1"), "(x - 1)·(x + 1)");
    assert_eq!(run(SymbolicOperation::Expand, "(x + 1)^2"), "x^2 + 2·x + 1");
    assert_eq!(
        run(
            SymbolicOperation::SolveFor { var: name("x") },
            "2·x - 6 == 0"
        ),
        "3"
    );
    assert_eq!(
        run(SymbolicOperation::Float { digits: Some(5) }, "π"),
        "3.1416"
    );
    // A failing operation reports the reason and changes nothing.
    let error = apply_operation(
        &kernel,
        &SymbolicOperation::SolveFor { var: name("x") },
        &expr("1 == 2"),
        Vec::new(),
    )
    .unwrap_err();
    assert_eq!(error.category, "symbolic");
    // Failures of live evaluations are region errors, not crashes.
    let mut session = session(
        Arc::clone(&kernel),
        &[("bad", "x →[frobnicate]"), ("later", "y := 2")],
    );
    session
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert!(matches!(
        region_state(&session, "bad"),
        RegionState::Error { .. }
    ));
    assert!(matches!(
        region_state(&session, "later"),
        RegionState::Value { .. }
    ));
    kernel.shutdown();
}

/// A worksheet without symbolic regions never loads SymPy; one with a symbolic
/// evaluation starts the warm-up when it is calculated.
#[test]
fn only_a_worksheet_with_symbolics_warms_sympy_up() {
    if !julia_available() {
        eprintln!("skipping: julia is not on PATH");
        return;
    }
    let mut config = KernelConfig::new(repo_root().join("kernel/EquavelaKernel"));
    config.startup_timeout = Duration::from_secs(180);
    let kernel = Arc::new(KernelManager::new(config));

    let mut numeric = session(Arc::clone(&kernel), &[("a", "a := 2"), ("show", "a + 1 =")]);
    numeric
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    assert_eq!(kernel.symbolic_status().unwrap().state, "idle");

    let mut symbolic = session(Arc::clone(&kernel), &[("f", "x^2 + x^2 →")]);
    symbolic
        .recalculate(RecalcMode::Changed, &mut |_| {})
        .unwrap();
    let state = kernel.symbolic_status().unwrap().state;
    assert!(
        ["warming", "ready", "failed"].contains(&state.as_str()),
        "{state}"
    );
    kernel.shutdown();
}

#[test]
fn jacob_of_a_vector_function_round_trips_through_the_worksheet() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let mut sheet = session(
        kernel,
        &[
            ("f", "F(x) := [x[0]·x[1]; x[0]^2]"),
            ("j", "Jacob(F(x), x, 3) →"),
        ],
    );
    sheet.recalculate(RecalcMode::Changed, &mut |_| {}).unwrap();
    let (text, _) = symbolic_result(&sheet, "j");
    assert_eq!(text, "[x[1], x[0], 0; 2·x[0], 0, 0]");
}

#[test]
fn jacob_numeric_worksheet_uses_the_vector_expression() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    let mut sheet = session(
        kernel,
        &[
            ("f", "F(x) := [x[0]·x[1]; x[0]^2]"),
            ("x", "x := [2; 3]"),
            ("j", "Jacob(F(x), x) ="),
        ],
    );
    sheet.recalculate(RecalcMode::Changed, &mut |_| {}).unwrap();
    let RegionState::Value {
        value:
            Some(KernelValue::Matrix {
                rows,
                cols,
                storage: equavela_core::kernel_value::MatrixStorage::Inline { values: cells },
            }),
        ..
    } = region_state(&sheet, "j")
    else {
        panic!("numeric Jacob: {:?}", region_state(&sheet, "j"));
    };
    assert_eq!((rows, cols), (2, 2));
    for (cell, expected) in cells.iter().zip([3.0, 4.0, 2.0, 0.0]) {
        let KernelValue::Real { value } = cell else {
            panic!("unexpected matrix cell: {cell:?}");
        };
        assert!(
            (value.as_f64() - expected).abs() < 1e-7,
            "actual {}, expected {expected}",
            value.as_f64()
        );
    }
}

#[test]
fn fast_symbolic_uses_the_live_source_scope_and_labels_results() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    use equavela_core::session::{fast_symbolic_result, FastSymbolicInput};
    let worksheet = session(
        kernel.clone(),
        &[
            ("a", "a := 3"),
            ("b", "b := 1"),
            ("x", "x := 80"),
            ("source", "0"),
            ("later", "a := 99"),
        ],
    );
    let solve = |math: &str, in_scope: bool| {
        let input: FastSymbolicInput = serde_json::from_value(json!({
            "regionId": "source", "page": 0, "x": 0.0, "y": 0.0,
            "statement": parse_statement(math).unwrap(), "operation": "solve",
            "variable": Name::plain("x"), "worksheetVariables": in_scope,
        }))
        .unwrap();
        let request = worksheet.prepare_fast_symbolic(&input).unwrap();
        let outcome = kernel.symbolic(&request).unwrap();
        let expr = outcome.expr().unwrap_or_else(|| panic!("{outcome:?}"));
        let result = fast_symbolic_result(&input, expr.clone());
        equavela_core::syntax::print_statement(&result)
    };
    assert_eq!(solve("x == a + 2", true), "x == 5");
    assert_eq!(solve("x == a", false), "x == a");
    assert_eq!(solve("[x + y == 3; x - y == 1]", true), "x == 2");
    let literal_system = solve("[x + y == a; x - y == b]", false);
    assert!(
        literal_system.starts_with("x == ")
            && literal_system.contains("a")
            && literal_system.contains("b"),
        "{literal_system}"
    );
    let multiple = solve("x^2 == 1", true);
    assert!(
        multiple.starts_with("x == [") && multiple.contains("-1"),
        "{multiple}"
    );
    kernel.shutdown();
}

#[test]
fn fast_symbolic_runs_parameter_ready_operations_with_engine_defaults() {
    let Some(kernel) = symbolic_kernel() else {
        return;
    };
    use equavela_core::session::FastSymbolicInput;
    use equavela_core::symbolic::SymbolicKeyword;
    let worksheet = session(kernel.clone(), &[("source", "0")]);
    for (operation, keyword, math, args) in [
        ("laplace", "laplace", "s·exp(-q)", &["q", "s1"][..]),
        ("inverse_laplace", "invlaplace", "1/(q^2 + 1)", &["q"][..]),
        ("fourier", "fourier", "exp(-q^2)", &["q"][..]),
        ("inverse_fourier", "invfourier", "2/(q^2 + 1)", &["q"][..]),
        ("z_transform", "ztrans", "2^q", &["q"][..]),
        ("inverse_z_transform", "invztrans", "q/(q - 2)", &["q"][..]),
        ("series", "series", "1/(1 - q)", &["q", "6"][..]),
        ("coefficients", "coeffs", "q^2 + 2q", &["q"][..]),
        ("float", "float", "1/3", &[][..]),
        ("combine", "combine", "1/u + 1/v", &[][..]),
        ("rectangular", "rectangular", "exp(1i·q)", &[][..]),
        (
            "continued_fraction",
            "confrac",
            "(q + 1)/(q - 1)",
            &["q"][..],
        ),
        ("continued_fraction", "confrac", "17/11", &[][..]),
    ] {
        let variable = args.first().map(|_| Name::plain("q"));
        let input: FastSymbolicInput = serde_json::from_value(json!({
            "regionId": "source", "page": 0, "x": 0.0, "y": 0.0,
            "statement": parse_statement(math).unwrap(), "operation": operation,
            "variable": variable, "worksheetVariables": false,
        }))
        .unwrap();
        let fast = worksheet.prepare_fast_symbolic(&input).unwrap();
        let standard = SymbolicRequest::new(
            parse_expression(math).unwrap(),
            vec![SymbolicKeyword {
                keyword: keyword.into(),
                args: args
                    .iter()
                    .map(|arg| parse_expression(arg).unwrap())
                    .collect(),
            }],
        );
        let result = |request: &SymbolicRequest| {
            let outcome = kernel.symbolic(request).unwrap();
            print_expression(
                outcome
                    .expr()
                    .unwrap_or_else(|| panic!("{operation}: {outcome:?}")),
            )
        };
        assert_eq!(result(&fast), result(&standard), "{operation}");
    }
    kernel.shutdown();
}
