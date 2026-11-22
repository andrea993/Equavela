//! The vector sum: our form is the built-in function `vsum(v)`,
//! an ordinary call, so it parses and prints byte for byte and every form of the `∑` lower slot
//!  keeps its own meaning. The codegen is tested in `core/tests/codegen.rs`, the
//! arithmetic in `kernel/EqRuntime/test/builtins.jl`, and the last test here runs a whole
//! worksheet through the kernel when `julia` is on PATH.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use equavela_core::ast::{Arg, Expr, ExprKind, StatementKind};
use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::project::DocumentId;
use equavela_core::session::{RecalcMode, RegionKey, RegionState, WorksheetSession};
use equavela_core::worksheet_file::load_project_text;
use equavela_core::{parse_statement, print_statement};

fn roundtrip(text: &str) {
    let parsed = parse_statement(text).unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"));
    assert_eq!(print_statement(&parsed), text, "printing `{text}`");
    let again = parse_statement(&print_statement(&parsed))
        .unwrap_or_else(|e| panic!("re-parse `{text}`: {e:?}"));
    assert_eq!(parsed, again, "re-parsing `{text}`");
}

fn expression(text: &str) -> Expr {
    match parse_statement(text)
        .unwrap_or_else(|e| panic!("parse `{text}`: {e:?}"))
        .kind
    {
        StatementKind::ExprRegion { expr } => expr,
        other => panic!("`{text}` is not an expression region: {other:?}"),
    }
}

/// The source text of a `vsum` call: the callee name and the single argument.
fn vector_sum(text: &str) -> (String, Expr) {
    let ExprKind::Call { callee, args } = expression(text).kind else {
        panic!("`{text}` is not a call");
    };
    let ExprKind::Ident { name } = callee.kind else {
        panic!("the callee of `{text}` is not a name");
    };
    let [Arg::Expr { expr }] = args.as_slice() else {
        panic!("`{text}` does not have exactly one expression argument");
    };
    (
        name.segments
            .last()
            .expect("a name has a segment")
            .text
            .clone(),
        expr.clone(),
    )
}

#[test]
fn the_vector_sum_round_trips_byte_for_byte() {
    for text in [
        "vsum(v)",
        "vsum([1; 2; 3])",
        "vsum(v[i])",
        "vsum(3.5 m)",
        "vsum(a + b)",
        "vsum(vsum(v))",
        "vsum(□)",
        "vsum(v) =",
        "y := vsum(v)",
        "y := vsum(v) =",
        "-vsum(v)",
        "vsum(v)/2",
        "f(vsum(v), 2)",
        "vsum(v)·vsum(w)",
    ] {
        roundtrip(text);
    }
}

#[test]
fn the_vector_sum_is_an_ordinary_call() {
    // A name and one expression argument, like every other built-in call.
    let (name, argument) = vector_sum("vsum(v)");
    assert_eq!(name, "vsum");
    assert!(matches!(argument.kind, ExprKind::Ident { .. }));
    let (_, argument) = vector_sum("vsum([1; 2; 3])");
    assert!(matches!(argument.kind, ExprKind::Matrix { .. }));
    // `vsum` is a name like any other: alone it is not a call, and a definition may use it.
    roundtrip("vsum := 1");
    roundtrip("vsum");
}

#[test]
fn no_form_of_the_sum_bracket_became_a_vector_sum() {
    //  to 6 keep their meaning: the bracket of `∑`/`∏` never holds an array operand
    // without an index, and none of these parse as the call of .
    for text in [
        "∑[i] v[i]",
        "∑[i ∈ 1..4] i",
        "∑[i = 1..n] i",
        "∑[i := 1..n] i",
        "∏[i ∈ 1..n] i",
        "∑[j ≠ k] j",
        "∑[j!] j",
        "∑[j! = k..□] j",
    ] {
        roundtrip(text);
        assert!(
            !matches!(expression(text).kind, ExprKind::Call { .. }),
            "`{text}` must not be a call"
        );
    }
    // The index-only form is still the sum over a range variable with no bounds.
    assert!(matches!(
        expression("∑[i] v[i]").kind,
        ExprKind::Sum {
            index: None,
            bounds: None,
            ..
        }
    ));
}

/// the specification : the sum of the elements, not of a diagonal and not of an
/// `ORIGIN`-dependent index range, with the one error of . Needs `julia`.
#[test]
fn a_vector_sum_evaluates_the_same_whatever_origin_is() {
    if std::process::Command::new("julia")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let sheet = |origin: &str| {
        format!(
            "format: equavela-worksheet/3
settings:
  ORIGIN: {origin}
regions:
  - id: v
    at: [0, 0]
    math: 'v := [1; 2; 3]'
  - id: M
    at: [0, 10]
    math: 'M := [1, 2; 3, 4]'
  - id: total
    at: [0, 20]
    math: 'vsum(v) ='
  - id: matrix_total
    at: [0, 30]
    math: 'vsum(M) ='
  - id: indexed
    at: [0, 40]
    math: '∑[k ∈ ORIGIN..last(v)] v[k] ='
  - id: scalar
    at: [0, 50]
    math: 'vsum(3) ='
"
        )
    };
    let root_path = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let id = DocumentId::new("/vsum.eqv").unwrap();
    let mut values = Vec::new();
    for origin in ["0", "5"] {
        let mut config = KernelConfig::new(root_path.join("kernel/EquavelaKernel"));
        config.startup_timeout = Duration::from_secs(300);
        let loaded = load_project_text(id.clone(), &sheet(origin)).unwrap();
        let mut session = WorksheetSession::new(
            Arc::new(KernelManager::new(config)),
            "vsum-test",
            loaded.project,
            loaded.root,
            loaded.texts,
            GenOptions::default(),
        )
        .unwrap();
        session
            .recalculate(RecalcMode::Changed, &mut |_| {})
            .unwrap();
        let get = |region: &str| {
            session.results().get(&RegionKey {
                document: id.clone(),
                region_id: region.into(),
                instance: 0,
            })
        };
        let real = |region: &str| match get(region) {
            Some(RegionState::Value {
                value: Some(equavela_core::kernel_value::KernelValue::Real { value }),
                ..
            }) => value.as_f64(),
            other => panic!("`{region}` did not evaluate: {other:?}"),
        };
        // Every element (not the trace), in whatever order ORIGIN indexes them.
        assert_eq!(real("total"), 6.0);
        assert_eq!(real("matrix_total"), 10.0);
        // The bounded sum, by contrast, follows ORIGIN.
        assert_eq!(real("indexed"), 6.0);
        let Some(RegionState::Error { failure }) = get("scalar") else {
            panic!("vsum of a scalar must be an error: {:?}", get("scalar"));
        };
        assert_eq!(failure.message, "vsum needs an array");
        values.push((real("total"), real("indexed")));
    }
    // 0 + 1 + 2 + 3 = 6 at both origins: the vector sum has no index to shift.
    assert_eq!(values, vec![(6.0, 6.0), (6.0, 6.0)]);
}
