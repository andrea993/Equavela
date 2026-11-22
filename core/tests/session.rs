//! Tests of the worksheet session. Tests that need the kernel are skipped (with a
//! message) when `julia` is not on PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::codegen::GenOptions;
use equavela_core::graph::Region;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::{KernelValue, WireFloat};
use equavela_core::parse_statement;
use equavela_core::project::{
    CalculationSettings, DocumentId, DocumentRegion, Project, ProjectDocument,
};
use equavela_core::session::{
    DocumentView, FailureKind, IntrinsicInfo, KernelStatus, RecalcMode, RegionKey, RegionState,
    SessionError, SessionEvent, ViewContent, WorksheetSession,
};
use equavela_core::worksheet_file::{load_document_file, load_project, parse_document};

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

fn broken_kernel() -> Arc<KernelManager> {
    Arc::new(KernelManager::new(
        KernelConfig::new(repo_root().join("kernel/EquavelaKernel"))
            .with_julia("definitely-not-a-julia-executable"),
    ))
}

fn root_id() -> DocumentId {
    DocumentId::new("/root.eqv").unwrap()
}

fn session(kernel: Arc<KernelManager>, math: &[(&str, &str)]) -> WorksheetSession {
    session_with_settings(kernel, math, &[])
}

fn session_with_settings(
    kernel: Arc<KernelManager>,
    math: &[(&str, &str)],
    settings: &[(&str, &str)],
) -> WorksheetSession {
    let id = root_id();
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
                statement: std::sync::Arc::new(parse_statement(text).unwrap()),
            }))
        })
        .map(std::sync::Arc::new)
        .collect();
    let document = ProjectDocument {
        id: id.clone(),
        content_hash: "h".into(),
        settings: CalculationSettings {
            values: settings
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        },
        environment: None,
        page: Default::default(),
        result_formats: Default::default(),
        math_breaks: Default::default(),
        resources: Default::default(),
        assets: Default::default(),
        page_breaks: Vec::new(),
        regions,
    };
    let mut project = Project::new();
    project.insert(document).unwrap();
    let texts: HashMap<_, _> = math
        .iter()
        .map(|(r, t)| ((id.clone(), (*r).to_owned()), (*t).to_owned()))
        .collect();
    WorksheetSession::new(kernel, "ws1", project, id, texts, GenOptions::default()).unwrap()
}

fn key(region: &str) -> RegionKey {
    RegionKey {
        document: root_id(),
        region_id: region.to_owned(),
        instance: 0,
    }
}

fn state(session: &WorksheetSession, region: &str) -> RegionState {
    session.results().get(&key(region)).unwrap()
}

fn real(state: &RegionState) -> f64 {
    match state {
        RegionState::Value {
            value: Some(KernelValue::Real { value }),
            ..
        }
        | RegionState::Stale {
            value: Some(KernelValue::Real { value }),
            ..
        } => value.as_f64(),
        other => panic!("not a real value: {other:?}"),
    }
}

fn recalc(session: &mut WorksheetSession, mode: RecalcMode) -> (Vec<SessionEvent>, bool) {
    let mut events = Vec::new();
    let summary = session
        .recalculate(mode, &mut |e| events.push(e.clone()))
        .unwrap();
    (events, summary.reset)
}

fn started(events: &[SessionEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::RegionStarted { key } => Some(key.region_id.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn tol_and_origin_come_from_the_worksheet_settings() {
    let Some(kernel) = kernel() else {
        return;
    };
    let math = [("t", "TOL ="), ("o", "ORIGIN ="), ("c", "CTOL =")];
    let mut custom = session_with_settings(
        kernel.clone(),
        &math,
        &[("TOL", "0.25"), ("CTOL", "0.5"), ("ORIGIN", "1")],
    );
    recalc(&mut custom, RecalcMode::Changed);
    assert_eq!(real(&state(&custom, "t")), 0.25);
    assert_eq!(real(&state(&custom, "c")), 0.5);
    // ORIGIN is a worksheet setting the kernel receives.
    assert_eq!(real(&state(&custom, "o")), 1.0);
    // Indexing and `last` count from it.
    let indexing = [
        ("v", "v := [10; 20; 30]"),
        ("first", "v[1] ="),
        ("end", "last(v) ="),
    ];
    let mut one = session_with_settings(kernel.clone(), &indexing, &[("ORIGIN", "1")]);
    recalc(&mut one, RecalcMode::All);
    assert_eq!(real(&state(&one, "first")), 10.0);
    assert_eq!(real(&state(&one, "end")), 3.0);
    let mut zero_based = session(kernel.clone(), &indexing);
    recalc(&mut zero_based, RecalcMode::All);
    assert_eq!(real(&state(&zero_based, "first")), 20.0);
    assert_eq!(real(&state(&zero_based, "end")), 2.0);
    // an invalid TOL keeps the default instead of failing the pass; CTOL must be non-negative
    let mut invalid =
        session_with_settings(kernel.clone(), &math, &[("TOL", "-3"), ("CTOL", "-0.5")]);
    recalc(&mut invalid, RecalcMode::All);
    assert_eq!(real(&state(&invalid, "t")), 0.001);
    assert_eq!(real(&state(&invalid, "c")), 0.001);
    // 0 is a valid CTOL: as exact as the algorithm can be
    let mut zero = session_with_settings(kernel.clone(), &math, &[("CTOL", "0")]);
    recalc(&mut zero, RecalcMode::All);
    assert_eq!(real(&state(&zero, "c")), 0.0);
    let mut missing = session(kernel, &math);
    recalc(&mut missing, RecalcMode::All);
    assert_eq!(real(&state(&missing, "t")), 0.001);
    assert_eq!(real(&state(&missing, "c")), 0.001);
}

/// a function head as an argument (`g(i, j) ← e`) is an anonymous function, which is what
/// `matrix(m, n, f)` calls; the `a test worksheet` builds its matrices that way.
#[test]
fn a_function_head_argument_is_an_anonymous_function() {
    let Some(kernel) = kernel() else {
        return;
    };
    let math = [
        ("m", "M := matrix(2, 3, g(i, j) ← i + 10·j)"),
        ("e", "M[1, 2] ="),
        (
            "p",
            "P := matrix(2, 2, h(i, j) ← program { if i == j { 1 } else { 0 } })",
        ),
        ("q", "P[1, 1] + P[0, 1] ="),
    ];
    let mut s = session(kernel.clone(), &math);
    recalc(&mut s, RecalcMode::All);
    // element (1, 2): 1 + 10 * 2 = 21
    assert_eq!(real(&state(&s, "e")), 21.0);
    assert_eq!(real(&state(&s, "q")), 1.0);
    // The head names a local function: it is `g` for the rest of the expression, in a program too.
    let program = [
        (
            "f",
            "F(x) := program { N ← matrix(2, 2, g(i, j) ← x·(i + j))[1, 1] + g(1, 1); N }",
        ),
        ("r", "F(2) ="),
    ];
    let mut named = session(kernel, &program);
    recalc(&mut named, RecalcMode::All);
    // g(1, 1) = 2 * 2 = 4 and the element (1, 1) of the matrix is the same: 8
    assert_eq!(real(&state(&named, "r")), 8.0);
}

/// a tolerance is part of the evaluation context of the whole worksheet, so changing it
/// makes every region out of date and the next pass recalculates all of them. The generated code
/// does not change (it reads `tol()` and `ctol()`), so the fingerprints alone would keep the old
/// results.
#[test]
fn a_tolerance_change_makes_every_region_out_of_date_and_recalculates_it() {
    let Some(kernel) = kernel() else {
        return;
    };
    use equavela_core::edit::EditCommand;
    let math = [("t", "TOL ="), ("c", "CTOL ="), ("plain", "7 =")];
    let mut session = session(kernel, &math);
    recalc(&mut session, RecalcMode::All);
    assert_eq!(real(&state(&session, "t")), 0.001);
    assert_eq!(real(&state(&session, "c")), 0.001);
    let staleness = |session: &WorksheetSession| {
        ["t", "c", "plain"]
            .iter()
            .map(|id| matches!(state(session, id), RegionState::Stale { .. }))
            .collect::<Vec<_>>()
    };
    assert_eq!(staleness(&session), [false, false, false]);
    let values = |pairs: &[(&str, &str)]| EditCommand::SetCalculationSettings {
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Some((*value).to_owned())))
            .collect(),
    };
    let stale = session
        .apply_edit(
            &root_id(),
            "Calculation settings",
            values(&[("TOL", "0.25"), ("CTOL", "0.5")]),
        )
        .unwrap();
    // Every region, including the one that mentions neither tolerance.
    let mut stale_ids: Vec<_> = stale.iter().map(|key| key.region_id.clone()).collect();
    stale_ids.sort();
    assert_eq!(stale_ids, ["c", "plain", "t"]);
    assert_eq!(staleness(&session), [true, true, true]);
    // The next pass starts from a fresh kernel module and evaluates the whole worksheet: the
    // code of a region does not mention the tolerance, so its fingerprint would match.
    let (events, reset) = recalc(&mut session, RecalcMode::Changed);
    assert!(reset);
    let mut started = started(&events);
    started.sort();
    assert_eq!(started, ["c", "plain", "t"]);
    assert_eq!(real(&state(&session, "t")), 0.25);
    assert_eq!(real(&state(&session, "c")), 0.5);
    assert_eq!(real(&state(&session, "plain")), 7.0);
    // An Apply that writes the values the worksheet already has recalculates nothing.
    let unchanged = session
        .apply_edit(
            &root_id(),
            "Calculation settings",
            values(&[("TOL", "0.25"), ("CTOL", "0.5")]),
        )
        .unwrap();
    assert!(unchanged.is_empty(), "{unchanged:?}");
    assert_eq!(staleness(&session), [false, false, false]);
    // Undoing the change restores the previous tolerances and makes the sheet out of date
    // again; the next pass computes the old values.
    session.undo().unwrap().unwrap();
    assert_eq!(staleness(&session), [true, true, true]);
    recalc(&mut session, RecalcMode::Changed);
    assert_eq!(real(&state(&session, "t")), 0.001);
    assert_eq!(real(&state(&session, "c")), 0.001);
}

#[test]
fn physical_constants_carry_their_si_dimensions_and_a_definition_wins() {
    let Some(kernel) = kernel() else {
        return;
    };
    // Every ratio is dimensionless when the constant has the dimension the table promises.
    // The units are labelled: a plain name is a constant or a variable, never a unit.
    let math = [
        ("c", "c·s@unit/m@unit ="),
        ("ec", "e.c/(A@unit·s@unit) ="),
        ("h", "h/(J@unit·s@unit) ="),
        ("hb", "2·π·ħ/(J@unit·s@unit) ="),
        ("k", "k·K@unit/J@unit ="),
        ("mu", "m.u/kg@unit ="),
        ("na", "N.A·mol@unit ="),
        ("r", "R·mol@unit·K@unit/J@unit ="),
        ("rinf", "R∞·m@unit ="),
        ("alpha", "α ="),
        ("eps", "ε_0·μ_0·c^2 ="),
        ("alias", "ε0·μ0·c^2 ="),
        ("sigma", "σ·m@unit^2·K@unit^4/W@unit ="),
        ("flux", "Φ_0/Wb@unit ="),
    ];
    let mut constants = session(kernel.clone(), &math);
    recalc(&mut constants, RecalcMode::All);
    let value = |id: &str| real(&state(&constants, id));
    let close = |id: &str, want: f64| {
        let got = value(id);
        assert!(
            (got - want).abs() <= 1e-9 * want.abs(),
            "{id}: {got} is not {want}"
        );
    };
    close("c", 299_792_458.0);
    close("ec", 1.602176634e-19);
    close("h", 6.62607015e-34);
    close("hb", 6.62607015e-34);
    close("k", 1.380649e-23);
    close("mu", 1.66053906892e-27);
    close("na", 6.02214076e23);
    close("r", 8.31446261815324);
    close("rinf", 10_973_731.568157);
    close("alpha", 7.2973525643e-3);
    close("eps", 1.0);
    close("alias", 1.0);
    close("sigma", 5.670374419184431e-8);
    close("flux", 2.0678338484619295e-15);

    // A definition in the worksheet wins.
    let mut shadowed = session(kernel, &[("d", "c := 5"), ("u", "c =")]);
    recalc(&mut shadowed, RecalcMode::All);
    assert_eq!(real(&state(&shadowed, "u")), 5.0);
}

#[test]
fn inspection_classifies_engine_names_without_losing_worksheet_shadowing() {
    let inspection = session(
        broken_kernel(),
        &[
            ("early", "π ="),
            ("infinity", "∞ ="),
            ("physical", "μ_0 ="),
            ("system", "ORIGIN ="),
            ("builtin", "sin(0) ="),
            ("unresolved", "sin@var + missing ="),
            ("redefine", "π := 4"),
            ("late", "π ="),
            ("labelled", "π@var ="),
            ("explicit", "π@const ="),
        ],
    )
    .inspect();
    let reference = |id: &str, name: &str| {
        inspection
            .references
            .iter()
            .find(|r| r.key.region_id == id && r.name == name)
            .unwrap()
    };
    let pi = Some(IntrinsicInfo::Constant {
        value: Some(WireFloat::from(std::f64::consts::PI)),
    });
    assert_eq!(reference("early", "π").intrinsic, pi);
    assert_eq!(
        reference("infinity", "∞").intrinsic,
        Some(IntrinsicInfo::Constant {
            value: Some(WireFloat::PositiveInfinity)
        })
    );
    assert_eq!(
        reference("physical", "μ_0").intrinsic,
        Some(IntrinsicInfo::Constant { value: None })
    );
    assert_eq!(
        reference("system", "ORIGIN").intrinsic,
        Some(IntrinsicInfo::System)
    );
    assert_eq!(
        reference("builtin", "sin").intrinsic,
        Some(IntrinsicInfo::Builtin)
    );
    assert_eq!(reference("unresolved", "sin@var").intrinsic, None);
    assert_eq!(reference("unresolved", "missing").intrinsic, None);
    assert_eq!(
        reference("late", "π")
            .definition
            .as_ref()
            .unwrap()
            .region_id,
        "redefine"
    );
    assert_eq!(reference("late", "π").intrinsic, None);
    assert_eq!(
        reference("labelled", "π@var").definition_name.as_deref(),
        Some("π")
    );
    assert_eq!(reference("explicit", "π@const").intrinsic, pi);
}

#[test]
fn inspection_resolves_references_to_definitions_and_reports_unit_warnings() {
    let session = session(
        broken_kernel(),
        &[
            ("a", "a := 2 m@unit"),
            ("f", "f(x) := x·a"),
            ("b", "b := f(3) + 1 s@unit"),
            ("show", "b ="),
            ("again", "a := 5 m@unit"),
            ("late", "a ="),
        ],
    );
    let inspection = session.inspect();
    let names: Vec<_> = inspection
        .definitions
        .iter()
        .map(|d| {
            (
                d.name.as_str(),
                d.label.as_str(),
                d.version,
                d.signature.as_str(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("a", "var", 1, "a"),
            ("f", "fn", 1, "f(x)"),
            ("b", "var", 1, "b"),
            ("a", "var", 2, "a"),
        ]
    );
    let key = |id: &str| RegionKey {
        document: root_id(),
        region_id: id.to_owned(),
        instance: 0,
    };
    // `a` in `f` and in `late` resolve to the version that is visible at that point
    let of_region = |id: &str, name: &str| {
        inspection
            .references
            .iter()
            .find(|r| r.key == key(id) && r.name == name)
            .unwrap_or_else(|| panic!("{id} {name}"))
    };
    assert_eq!(of_region("f", "a").definition, Some(key("a")));
    assert_eq!(of_region("f", "a").version, Some(1));
    assert_eq!(of_region("late", "a").definition, Some(key("again")));
    assert_eq!(of_region("late", "a").version, Some(2));
    assert_eq!(of_region("show", "b").definition, Some(key("b")));
    // evaluation order is reported for every region
    assert_eq!(inspection.ranks.len(), 6);
    // metres plus seconds is a unit warning on the region `b`
    assert_eq!(inspection.warnings.len(), 1, "{:?}", inspection.warnings);
    assert_eq!(inspection.warnings[0].key, key("b"));
    assert!(inspection.warnings[0].message.contains("length"));
    assert!(inspection.warnings[0].message.contains("time"));
    assert!(inspection.includes.is_empty());
}

#[test]
fn definition_values_are_read_from_the_kernel_without_reevaluating() {
    let Some(kernel) = kernel() else {
        return;
    };
    let mut session = session(
        kernel,
        &[
            ("a", "a := 2"),
            ("m", "M := identity(30)"),
            ("big", "B := identity(30)"),
            ("bad", "c := 1/0"),
            ("f", "f(x) := x"),
        ],
    );
    let before = session.definition_values(&[("a".into(), 1)]);
    assert_eq!(before[0].error.as_deref(), Some("not calculated yet"));
    recalc(&mut session, RecalcMode::All);
    let values = session.definition_values(&[
        ("a".into(), 1),
        ("M".into(), 1),
        ("c".into(), 1),
        ("f".into(), 1),
        ("zzz".into(), 1),
    ]);
    assert!(matches!(&values[0].value, Some(KernelValue::Real { value }) if value.as_f64() == 2.0));
    // 900 elements is more than a peek returns: only the size
    assert_eq!(values[1].size, Some((30, 30)));
    assert!(values[1].value.is_none() && values[1].error.is_none());
    assert_eq!(values[3].error.as_deref(), Some("not a variable"));
    assert_eq!(values[4].error.as_deref(), Some("not defined"));
    // the peek did not disturb the results
    assert!(matches!(
        state(&session, "a"),
        RegionState::Value { value: None, .. }
    ));
}

#[test]
fn definition_values_come_in_the_unit_the_worksheet_shows() {
    let Some(kernel) = kernel() else {
        return;
    };
    let mut session = session(
        kernel,
        &[
            ("q", "q := 12 kN@unit/m@unit"),
            ("L", "L := 2 m@unit"),
            ("M", "M := q·L^2/8"),
            ("show", "M = … kN·m"),
            ("v", "v := 3 km@unit/hr@unit = … m/s"),
            ("n", "n := L/m@unit"),
        ],
    );
    recalc(&mut session, RecalcMode::All);
    let values = session.definition_values(&[
        ("q".into(), 1),
        ("M".into(), 1),
        ("v".into(), 1),
        ("n".into(), 1),
    ]);
    let unit = |index: usize| {
        values[index]
            .display_unit
            .as_ref()
            .map(|u| (u.text.clone(), u.divisor))
    };
    // written in the definition
    assert_eq!(unit(0), Some(("kN/m".into(), 1000.0)));
    // the latest evaluation of the definition
    assert_eq!(unit(1), Some(("kN·m".into(), 1000.0)));
    // the defining region's own override
    assert_eq!(unit(2).map(|(text, _)| text), Some("m/s".into()));
    // nothing to go by: base SI
    assert_eq!(unit(3), None);
}

#[test]
fn error_spans_point_at_the_failing_sub_expression_when_the_generator_knows_it() {
    let Some(kernel) = kernel() else {
        return;
    };
    let mut session = session(
        kernel,
        &[("undef", "w := missing + 1"), ("div", "y := 2·(1/0)")],
    );
    recalc(&mut session, RecalcMode::All);
    let failing = |id: &str| {
        let RegionState::Error { failure } = state(&session, id) else {
            panic!("{id}: not an error: {:?}", state(&session, id));
        };
        let text = session.math_text(&root_id(), id).unwrap().to_owned();
        let span = failure.span.unwrap_or_else(|| panic!("{id}: no span"));
        text[span.start..span.end].to_owned()
    };
    // an undefined name: exactly the name
    assert_eq!(failing("undef"), "missing");
    // a runtime error inside a helper is located at its statement only (finer spans are a gap)
    assert_eq!(failing("div"), "y := 2·(1/0)");
}

#[test]
fn kernel_failure_is_reported_and_leaves_regions_pending() {
    let mut session = session(broken_kernel(), &[("a", "a := 1"), ("show", "a =")]);
    let mut events = Vec::new();
    let result = session.recalculate(RecalcMode::Changed, &mut |e| events.push(e.clone()));
    assert!(matches!(result, Err(SessionError::Kernel(_))));
    assert!(matches!(
        events.as_slice(),
        [
            SessionEvent::Kernel {
                status: KernelStatus::Starting
            },
            SessionEvent::Kernel {
                status: KernelStatus::Crashed { .. }
            }
        ]
    ));
    assert_eq!(state(&session, "a"), RegionState::Pending);
    assert_eq!(session.results().snapshot().len(), 2);
}

#[test]
fn edits_are_validated() {
    let mut session = session(broken_kernel(), &[("a", "a := 1")]);
    let err = session.edit_math(&root_id(), "a", "a := := 2").unwrap_err();
    assert!(matches!(err, SessionError::Parse(_)));
    assert_eq!(session.math_text(&root_id(), "a"), Some("a := 1"));
    let err = session.edit_math(&root_id(), "nope", "a := 2").unwrap_err();
    assert!(matches!(err, SessionError::NotAMathRegion { .. }));
    let stale = session.edit_math(&root_id(), "a", "a := 2").unwrap();
    assert_eq!(stale, [key("a")]);
    assert_eq!(session.math_text(&root_id(), "a"), Some("a := 2"));
}

#[test]
fn evaluates_a_worksheet_and_reports_values() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[("a", "a := 2"), ("b", "b := a + 1"), ("show", "b =")],
    );
    let (events, reset) = recalc(&mut s, RecalcMode::Changed);
    assert!(reset, "the first pass resets the module");
    assert_eq!(started(&events), ["a", "b", "show"]);
    assert_eq!(real(&state(&s, "show")), 3.0);
    assert!(matches!(
        state(&s, "a"),
        RegionState::Value { value: None, .. }
    ));
    let statuses: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Kernel { status } => Some(match status {
                KernelStatus::NotStarted => "not_started",
                KernelStatus::Starting => "starting",
                KernelStatus::Ready { .. } => "ready",
                KernelStatus::Busy => "busy",
                KernelStatus::Crashed { .. } => "crashed",
            }),
            _ => None,
        })
        .collect();
    assert_eq!(statuses, ["starting", "ready", "busy", "ready"]);
    // Nothing changed: the next pass sends nothing.
    let (events, reset) = recalc(&mut s, RecalcMode::Changed);
    assert!(!reset);
    assert!(started(&events).is_empty());
}

#[test]
fn edit_marks_dependents_stale_and_recalculates_only_them() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("a", "a := 2"),
            ("b", "b := a + 1"),
            ("c", "c := 100"),
            ("show", "b ="),
            ("showc", "c ="),
        ],
    );
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "show")), 3.0);

    let stale = s.edit_math(&root_id(), "a", "a := 10").unwrap();
    assert_eq!(stale, [key("a"), key("b"), key("show")]);
    // The last good value stays visible while stale.
    assert_eq!(real(&state(&s, "show")), 3.0);
    assert!(matches!(state(&s, "show"), RegionState::Stale { .. }));
    assert!(matches!(state(&s, "showc"), RegionState::Value { .. }));

    let (events, reset) = recalc(&mut s, RecalcMode::Changed);
    assert!(!reset);
    assert_eq!(started(&events), ["a", "b", "show"]);
    assert_eq!(real(&state(&s, "show")), 11.0);
    assert_eq!(real(&state(&s, "showc")), 100.0);
}

#[test]
fn changing_a_function_signature_replaces_it_on_incremental_recalculation() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("f", "f(x) := x + 1"),
            ("direct", "f(3) ="),
            ("array", "A := [f]"),
            ("indirect", "A[0](3) ="),
            ("other", "100 ="),
        ],
    );
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "direct")), 4.0);
    assert_eq!(real(&state(&s, "indirect")), 4.0);

    s.edit_math(&root_id(), "f", "f(a, x) := a·x + 1").unwrap();
    let (events, reset) = recalc(&mut s, RecalcMode::Changed);
    assert!(!reset);
    assert!(!started(&events).contains(&"other".to_owned()));
    for call in ["direct", "indirect"] {
        let RegionState::Error { failure } = state(&s, call) else {
            panic!("{call} still evaluated with the previous signature");
        };
        assert_eq!(failure.message, "f needs 2 arguments but is applied to 1");
    }

    s.edit_math(&root_id(), "direct", "f(2, 3) =").unwrap();
    s.edit_math(&root_id(), "indirect", "A[0](2, 3) =").unwrap();
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "direct")), 7.0);
    assert_eq!(real(&state(&s, "indirect")), 7.0);
}

#[test]
fn package_changes_mark_evaluated_results_stale_without_installing_packages() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(kernel, &[("a", "a := 2"), ("show", "a =")]);
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "show")), 2.0);

    s.packages_changed();

    assert!(s.calc_needed());
    assert!(matches!(state(&s, "show"), RegionState::Stale { .. }));
    assert_eq!(real(&state(&s, "show")), 2.0);
}

#[test]
fn an_edit_during_a_pass_stops_it_and_the_next_pass_uses_the_edit() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(kernel, &[("a", "a := 2"), ("show", "a =")]);
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "show")), 2.0);

    // A pass runs without the session: the host prepares it, releases the session and
    // runs it. An edit made in between makes it out of date.
    s.edit_math(&root_id(), "a", "a := 5").unwrap();
    let pass = s.pass(RecalcMode::Changed);
    s.edit_math(&root_id(), "a", "a := 7").unwrap();
    let mut events = Vec::new();
    let summary = pass.run(&mut |e| events.push(e.clone())).unwrap();
    assert!(summary.incomplete);
    assert!(
        started(&events).is_empty(),
        "an outdated pass evaluates nothing"
    );
    assert!(matches!(state(&s, "show"), RegionState::Stale { .. }));

    let (events, _) = recalc(&mut s, RecalcMode::Changed);
    assert_eq!(started(&events), ["a", "show"]);
    assert_eq!(real(&state(&s, "show")), 7.0);
}

/// an edit whose derived state is unchanged — a spaces-only math edit, plain text around
/// unchanged inline math, or a move that keeps the reading order — neither asks for a
/// calculation nor stops a pass that is already prepared.
#[test]
fn presentation_edits_do_not_ask_for_a_calculation_or_stop_a_pass() {
    let Some(kernel) = kernel() else { return };
    use equavela_core::edit::EditCommand;
    let mut s = session(kernel, &[("a", "a := 2"), ("show", "a =")]);
    recalc(&mut s, RecalcMode::Changed);

    // A real edit gives the prepared pass work to do.
    s.edit_math(&root_id(), "a", "a := 5").unwrap();
    let revision = s.revision();
    let pass = s.pass(RecalcMode::Changed);
    // Spaces only: the statement is equal, so the generated code cannot change.
    let stale = s.edit_math(&root_id(), "a", "a :=  5").unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(
        s.revision(),
        revision,
        "a spacing edit does not invalidate a pass"
    );
    assert_eq!(s.math_text(&root_id(), "a"), Some("a :=  5"));

    let mut events = Vec::new();
    let summary = pass.run(&mut |e| events.push(e.clone())).unwrap();
    assert!(!summary.incomplete, "the prepared pass still runs");
    assert_eq!(started(&events), ["a", "show"]);
    assert_eq!(real(&state(&s, "show")), 5.0);

    // A move that keeps the order changes no reading order and asks for nothing.
    let revision = s.revision();
    let stale = s
        .apply_edit(
            &root_id(),
            "Move region",
            EditCommand::Move {
                region_id: "a".into(),
                page: 0,
                x: 0.0,
                y: 0.5,
            },
        )
        .unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(s.revision(), revision);

    // A move that keeps the order does not stop a prepared pass either.
    s.edit_math(&root_id(), "a", "a := 9").unwrap();
    let revision = s.revision();
    let pass = s.pass(RecalcMode::Changed);
    let stale = s
        .apply_edit(
            &root_id(),
            "Move region",
            EditCommand::Move {
                region_id: "a".into(),
                page: 0,
                x: 0.0,
                y: 0.75,
            },
        )
        .unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(s.revision(), revision);
    let mut events = Vec::new();
    let summary = pass.run(&mut |e| events.push(e.clone())).unwrap();
    assert!(
        !summary.incomplete,
        "a move that keeps the order keeps the pass"
    );
    assert_eq!(started(&events), ["a", "show"]);
    assert_eq!(real(&state(&s, "show")), 9.0);

    // A move that crosses the other region changes the evaluation order: a pass is due.
    let revision = s.revision();
    let stale = s
        .apply_edit(
            &root_id(),
            "Move region",
            EditCommand::Move {
                region_id: "a".into(),
                page: 0,
                x: 0.0,
                y: 30.0,
            },
        )
        .unwrap();
    assert!(!stale.is_empty());
    assert!(s.calc_needed());
    assert_ne!(s.revision(), revision);
}

/// a region that failed is not turned back into `pending` and retried by an unrelated
/// edit; only a change to what a pass would do asks for a new one.
#[test]
fn an_error_region_is_not_retried_by_an_unrelated_edit() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("a", "a := 2"),
            ("bad", "bad := nothing_here"),
            ("show", "a ="),
        ],
    );
    recalc(&mut s, RecalcMode::Changed);
    assert!(matches!(state(&s, "bad"), RegionState::Error { .. }));
    assert_eq!(real(&state(&s, "show")), 2.0);

    let stale = s.edit_math(&root_id(), "a", "a :=  2").unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert!(
        matches!(state(&s, "bad"), RegionState::Error { .. }),
        "an unrelated edit leaves the error as it is"
    );
}

/// inserting, removing or disabling a region the analysis never reads is presentation
/// only; the same command on a region with math asks for a calculation.
#[test]
fn display_only_insert_remove_and_disable_do_not_recalculate() {
    let Some(kernel) = kernel() else { return };
    use equavela_core::edit::{EditCommand, StoredRegion};
    use equavela_core::layout::TextRegion;
    let id = DocumentId::new("/display.eqv").unwrap();
    let loaded = parse_document(
        id.clone(),
        "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n  - id: t\n    at: [0, 10]\n    text: |\n      Hello\n  - id: ti\n    at: [0, 20]\n    text: \"Inline $b := 3$\"\n",
    )
    .unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let texts = loaded
        .texts
        .into_iter()
        .map(|(region, text)| ((id.clone(), region), text))
        .collect();
    let mut s = WorksheetSession::new(
        kernel,
        "ws-display",
        project,
        id.clone(),
        texts,
        GenOptions::default(),
    )
    .unwrap();
    recalc(&mut s, RecalcMode::Changed);

    let revision = s.revision();
    let stale = s
        .apply_edit(
            &id,
            "Delete region",
            EditCommand::Remove {
                region_id: "t".into(),
            },
        )
        .unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(s.revision(), revision);

    // The inline `$b := 3$` is a hidden math region: removing it changes the analysis.
    s.apply_edit(
        &id,
        "Delete region",
        EditCommand::Remove {
            region_id: "ti".into(),
        },
    )
    .unwrap();
    assert!(s.calc_needed());
    assert_ne!(s.revision(), revision);

    let revision = s.revision();
    let stale = s
        .apply_edit(
            &id,
            "Insert region",
            EditCommand::Insert {
                region: StoredRegion {
                    region: DocumentRegion::Text(TextRegion {
                        id: "t2".into(),
                        page: 1,
                        x: 0.0,
                        y: 30.0,
                        enabled: true,
                        width: None,
                        full_width: false,
                        background: None,
                        language: None,
                        text: "Plain".into(),
                    }),
                    math_text: None,
                },
                index: usize::MAX,
            },
        )
        .unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(s.revision(), revision);

    // Disabling a math region takes it out of the analysis.
    s.apply_edit(
        &id,
        "Disable region",
        EditCommand::SetEnabled {
            region_id: "a".into(),
            enabled: false,
        },
    )
    .unwrap();
    assert!(s.calc_needed());
    assert_ne!(s.revision(), revision);
}

/// a text edit that keeps its inline math is presentation only; one that changes it asks
/// for a calculation.
#[test]
fn plain_text_does_not_recalculate_but_inline_math_does() {
    let Some(kernel) = kernel() else { return };
    use equavela_core::edit::EditCommand;
    let id = DocumentId::new("/text.eqv").unwrap();
    let loaded = parse_document(
        id.clone(),
        "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n  - id: t\n    at: [0, 10]\n    text: |\n      Hello\n",
    )
    .unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let texts = loaded
        .texts
        .into_iter()
        .map(|(region, text)| ((id.clone(), region), text))
        .collect();
    let mut s = WorksheetSession::new(
        kernel,
        "ws-text",
        project,
        id.clone(),
        texts,
        GenOptions::default(),
    )
    .unwrap();
    recalc(&mut s, RecalcMode::Changed);

    let revision = s.revision();
    let stale = s
        .apply_edit(
            &id,
            "Edit text",
            EditCommand::SetText {
                region_id: "t".into(),
                text: "Hello ".into(),
            },
        )
        .unwrap();
    assert!(stale.is_empty());
    assert!(!s.calc_needed());
    assert_eq!(s.revision(), revision);

    let stale = s
        .apply_edit(
            &id,
            "Edit text",
            EditCommand::SetText {
                region_id: "t".into(),
                text: "Hello $b := 3$".into(),
            },
        )
        .unwrap();
    assert!(!stale.is_empty());
    assert!(s.calc_needed());
    assert_ne!(s.revision(), revision);
}

#[test]
fn failed_regions_block_their_dependents_without_sending_them() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("a", "a := nothing_here"),
            ("b", "b := a + 1"),
            ("c", "c := b * 2"),
            ("d", "d := 5"),
            ("show", "c ="),
            ("showd", "d ="),
        ],
    );
    let (events, _) = recalc(&mut s, RecalcMode::Changed);
    // Only the failing region and the independent regions were sent.
    assert_eq!(started(&events), ["a", "d", "showd"]);
    let RegionState::Error { failure } = state(&s, "a") else {
        panic!("a should fail");
    };
    assert_eq!(failure.kind, FailureKind::Evaluation);
    assert!(
        failure.message.contains("nothing_here"),
        "{}",
        failure.message
    );
    let RegionState::Error { failure } = state(&s, "b") else {
        panic!("b should be blocked");
    };
    assert_eq!(failure.kind, FailureKind::Blocked);
    assert_eq!(failure.blocked_by, Some(key("a")));
    assert!(failure.message.starts_with("depends on failed region"));
    let RegionState::Error { failure } = state(&s, "show") else {
        panic!("show should be blocked");
    };
    assert_eq!(failure.kind, FailureKind::Blocked);
    assert_eq!(failure.blocked_by, Some(key("c")));
    assert_eq!(real(&state(&s, "showd")), 5.0);

    // Fixing the root cause recovers the whole chain.
    s.edit_math(&root_id(), "a", "a := 1").unwrap();
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "show")), 4.0);
}

#[test]
fn program_errors_carry_the_statement_span() {
    let Some(kernel) = kernel() else { return };
    let source = "p := program\n  y ← 1\n  error(\"boom\")\n  y\n";
    let mut s = session(kernel, &[("p", source), ("use", "p =")]);
    recalc(&mut s, RecalcMode::Changed);
    let RegionState::Error { failure } = state(&s, "p") else {
        panic!("p should fail: {:?}", state(&s, "p"));
    };
    assert_eq!(failure.kind, FailureKind::Evaluation);
    assert!(failure.message.contains("boom"), "{}", failure.message);
    let span = failure.span.expect("a span");
    let text = s.math_text(&root_id(), "p").unwrap();
    assert_eq!(&text[span.range()], "error(\"boom\")");
}

#[test]
fn a_kernel_restart_resends_the_whole_worksheet_with_reset() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        Arc::clone(&kernel),
        &[("a", "a := 2"), ("b", "b := a * 3"), ("show", "b =")],
    );
    recalc(&mut s, RecalcMode::Changed);
    kernel.restart().unwrap();
    // Nothing changed in the worksheet, but the kernel lost its state.
    let (events, reset) = recalc(&mut s, RecalcMode::Changed);
    assert!(reset);
    assert_eq!(started(&events), ["a", "b", "show"]);
    assert_eq!(real(&state(&s, "show")), 6.0);
}

#[test]
fn recalculate_all_resets_and_evaluates_everything() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(kernel, &[("a", "a := 2"), ("show", "a =")]);
    recalc(&mut s, RecalcMode::Changed);
    let (events, reset) = recalc(&mut s, RecalcMode::All);
    assert!(reset);
    assert_eq!(started(&events), ["a", "show"]);
    assert_eq!(real(&state(&s, "show")), 2.0);
}

#[test]
fn interrupt_stops_the_pass_and_a_retry_resumes() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("a", "a := 1"),
            (
                "loop",
                "spin := program\n  n ← 0\n  while 1\n    n ← n + 1\n    v ← augment(n, n)\n  n",
            ),
            ("after", "z := spin + 1"),
            ("showa", "a ="),
        ],
    );
    // Start the kernel first so the loop begins promptly.
    s.kernel().start().unwrap();
    let handle = s.interrupt_handle();
    let mut summary = None;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(4000));
            handle.interrupt();
        });
        summary = Some(
            s.recalculate(RecalcMode::Changed, &mut |_| {})
                .expect("pass"),
        );
    });
    assert!(summary.unwrap().incomplete);
    let RegionState::Error { failure } = state(&s, "loop") else {
        panic!(
            "the loop region should be interrupted: {:?}",
            state(&s, "loop")
        );
    };
    assert_eq!(
        failure.kind,
        FailureKind::Interrupted,
        "{}",
        failure.message
    );
    // Regions after the interrupted one were not sent.
    assert!(matches!(
        state(&s, "after"),
        RegionState::Stale { value: None, .. }
    ));
    assert!(matches!(
        state(&s, "showa"),
        RegionState::Stale { value: None, .. }
    ));
    // Fix the loop and retry: the pass picks up where it stopped.
    s.edit_math(&root_id(), "loop", "spin := 4").unwrap();
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&state(&s, "showa")), 1.0);
    assert!(matches!(state(&s, "after"), RegionState::Value { .. }));
}

/// Found driving the real app: Stop on a long counting loop (no allocation, so no obvious
/// safepoint) must end the pass with the loop region marked as interrupted, not leave it pending.
#[test]
fn stop_on_a_tight_loop_marks_the_loop_interrupted() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            ("a", "a := 1"),
            (
                "f",
                "Long(n) := program
  s ← 0
  for i ∈ 1..n
    s ← s + i
  s",
            ),
            ("run", "Long(10000000000) ="),
            ("showa", "a + 1 ="),
        ],
    );
    s.kernel().start().unwrap();
    let handle = s.interrupt_handle();
    let mut summary = None;
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(4000));
            handle.interrupt();
        });
        summary = Some(
            s.recalculate(RecalcMode::Changed, &mut |_| {})
                .expect("pass"),
        );
    });
    assert!(summary.unwrap().incomplete);
    let RegionState::Error { failure } = state(&s, "run") else {
        panic!("the loop region should be an error: {:?}", state(&s, "run"));
    };
    assert!(
        matches!(failure.kind, FailureKind::Interrupted | FailureKind::Kernel),
        "{:?} {}",
        failure.kind,
        failure.message
    );
}

#[test]
fn includes_are_evaluated_and_invalidated_when_the_file_changes() {
    let Some(kernel) = kernel() else { return };
    let dir = std::env::temp_dir().join(format!("equavela-session-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let lib = dir.join("lib.eqv");
    let root = dir.join("root.eqv");
    std::fs::write(
        &lib,
        "format: equavela-worksheet/3\nregions:\n  - id: k\n    at: [0, 0]\n    math: \"k := 3\"\n",
    )
    .unwrap();
    std::fs::write(
        &root,
        "format: equavela-worksheet/3\nregions:\n  - id: inc\n    at: [0, 0]\n    include: lib.eqv\n  - id: y\n    at: [0, 10]\n    math: \"y := k * 2\"\n  - id: show\n    at: [0, 20]\n    math: \"y =\"\n",
    )
    .unwrap();
    let loaded = load_project(&root).unwrap();
    let lib_id = loaded
        .project
        .documents()
        .find(|d| d.id != loaded.root)
        .unwrap()
        .id
        .clone();
    let root_doc = loaded.root.clone();
    let mut s = WorksheetSession::new(
        kernel,
        "ws-inc",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    recalc(&mut s, RecalcMode::Changed);
    let show = RegionKey {
        document: root_doc,
        region_id: "show".into(),
        instance: 0,
    };
    assert_eq!(real(&s.results().get(&show).unwrap()), 6.0);
    let included = RegionKey {
        document: lib_id.clone(),
        region_id: "k".into(),
        instance: 0,
    };
    assert!(matches!(
        s.results().get(&included),
        Some(RegionState::Value { .. })
    ));

    // The included file changes on disk.
    std::fs::write(
        &lib,
        "format: equavela-worksheet/3\nregions:\n  - id: k\n    at: [0, 0]\n    math: \"k := 5\"\n",
    )
    .unwrap();
    let stale = s
        .replace_document(load_document_file(&lib_id).unwrap())
        .unwrap();
    assert_eq!(stale.len(), 3, "{stale:?}");
    recalc(&mut s, RecalcMode::Changed);
    assert_eq!(real(&s.results().get(&show).unwrap()), 10.0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_include_is_a_diagnostic() {
    let dir = std::env::temp_dir().join(format!("equavela-session-miss-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let root = dir.join("root.eqv");
    std::fs::write(
        &root,
        "format: equavela-worksheet/3\nregions:\n  - id: inc\n    at: [0, 0]\n    include: gone.eqv\n  - id: a\n    at: [0, 10]\n    math: \"a := 1\"\n",
    )
    .unwrap();
    let loaded = load_project(&root).unwrap();
    assert_eq!(loaded.missing.len(), 1);
    let s = WorksheetSession::new(
        broken_kernel(),
        "ws-miss",
        loaded.project,
        loaded.root,
        loaded.texts,
        GenOptions::default(),
    )
    .unwrap();
    let diagnostics = s.diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert!(diagnostics[0].message.contains("was not found"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn yaml_documents_load_math_text_plots_and_includes() {
    let id = DocumentId::new("/doc.eqv").unwrap();
    let text = "format: equavela-worksheet/3\nsettings:\n  origin: 0\nregions:\n  - id: t\n    page: 1\n    at: [54, 72]\n    text: |\n      Hello\n  - id: m\n    page: 1\n    at: [54, 110]\n    math: \"L := 3.5\"\n    result: \"3.5\"\n  - id: p\n    at: [54, 220]\n    math: |\n      S(n) := program\n        s ← 0\n        for i ∈ 1..n\n          s ← s + i\n        s\n  - id: plot1\n    at: [54, 260]\n    plot:\n      version: 1\n      type: xy\n      size: [360, 220]\n      traces:\n        - id: trace-1\n          x: \"0..10\"\n          y: \"ys\"\n  - id: inc\n    at: [0, 500]\n    include: \"sub/other.eqv\"\n";
    let loaded = parse_document(id, text).unwrap();
    // Text and plot regions are kept for the page view; images are still phase 8 work.
    assert_eq!(loaded.document.regions.len(), 5);
    assert!(matches!(
        loaded.document.regions[0].as_ref(),
        DocumentRegion::Text(text) if text.text == "Hello"
    ));
    assert_eq!(loaded.texts["m"], "L := 3.5");
    assert!(loaded.texts["p"].starts_with("S(n) := program\n  s ← 0"));
    assert_eq!(loaded.document.settings.values["origin"], "0");
    let DocumentRegion::Plot(plot) = loaded.document.regions[3].as_ref() else {
        panic!("plot region was not retained")
    };
    assert_eq!(plot.plot.size, [360.0, 220.0]);
    assert_eq!(plot.plot.traces[0].y, "ys");
}

#[test]
fn plot_regions_validate_version_size_trace_ids_and_expressions() {
    use equavela_core::worksheet_file::LoadError;
    let id = DocumentId::new("/plot.eqv").unwrap();
    let prefix = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n";
    for (body, expected) in [
        (
            "      version: 2\n      type: xy\n      traces: [{id: \"t\", x: \"x\", y: \"y\"}]\n",
            "unsupported plot version",
        ),
        (
            "      type: xy\n      size: [100, 220]\n      traces: [{id: \"t\", x: \"x\", y: \"y\"}]\n",
            "width",
        ),
        ("      type: xy\n      traces: []\n", "at least one trace"),
        (
            "      type: xy\n      traces: [{id: \"t\", x: \"x\", y: \"(\"}]\n",
            "y expression",
        ),
    ] {
        let error = parse_document(id.clone(), &format!("{prefix}{body}")).unwrap_err();
        let LoadError::Plot { message, .. } = error else {
            panic!("unexpected error: {error}")
        };
        assert!(message.contains(expected), "{message}");
    }
}

/// a worksheet must start with the identifying `format:` key and have the `.eqv`
/// extension; the pre- spelling `sheet/1` is not accepted.
#[test]
fn worksheets_need_the_identifying_first_line_and_the_mm_extension() {
    use equavela_core::worksheet_file::{format_line, FormatLine, LoadError, FORMAT_ID};
    let body = "regions:\n  - id: m\n    at: [0, 0]\n    math: \"x := 1\"\n";
    let mm = DocumentId::new("/doc.eqv").unwrap();
    let ours = format!("format: {FORMAT_ID}\n{body}");
    assert_eq!(
        parse_document(mm.clone(), &ours)
            .unwrap()
            .document
            .regions
            .len(),
        1
    );
    // A byte order mark is allowed, but the key remains the first physical text line.
    let decorated = format!("\u{feff}format: \"{FORMAT_ID}\"  # version 1\n{body}");
    assert!(parse_document(mm.clone(), &decorated).is_ok());
    // no key in a `.eqv` file: not a worksheet (the text may be valid YAML but could be anything)
    for text in [
        body.to_owned(),
        "<map version=\"1.0.1\">\n</map>\n".to_owned(),
        "#import <Foundation/Foundation.h>\nint main() {}\n".to_owned(),
        String::new(),
        format!("# saved by Equavela\nformat: {FORMAT_ID}\n{body}"),
        format!("\nformat: {FORMAT_ID}\n{body}"),
        "format: freemind\nregions: []\n".to_owned(),
        // the spelling before is no longer a worksheet
        format!("format: sheet/1\n{body}"),
        // the key must be the first line, not somewhere below
        format!("settings: {{}}\nformat: {FORMAT_ID}\n{body}"),
    ] {
        let error = parse_document(mm.clone(), &text).unwrap_err();
        assert!(
            matches!(error, LoadError::NotAWorksheet { .. }),
            "{text:?}: {error}"
        );
        assert!(error.to_string().contains("is not a worksheet"), "{error}");
        assert!(error.to_string().contains("/doc.eqv"), "{error}");
    }
    // a newer version of our own format is a version error, not "not a worksheet"
    let newer = parse_document(mm, "format: equavela-worksheet/4\nregions: []\n").unwrap_err();
    assert!(
        newer.to_string().contains("unsupported worksheet format"),
        "{newer}"
    );
    // another extension is not a worksheet, whatever the content
    for name in ["/doc.sheet.yaml", "/doc.yaml", "/doc"] {
        let error = parse_document(DocumentId::new(name).unwrap(), &ours).unwrap_err();
        assert!(
            matches!(error, LoadError::NotAWorksheet { .. }),
            "{name}: {error}"
        );
        assert!(error.to_string().contains(".eqv"), "{error}");
    }
    assert_eq!(format_line(&ours), FormatLine::Key(FORMAT_ID.into()));
    assert_eq!(format_line(body), FormatLine::Other("regions:".into()));
    assert_eq!(
        format_line("# only a comment\n"),
        FormatLine::Other("# only a comment".into())
    );
    assert_eq!(
        format_line("\nformat: equavela-worksheet/3\n"),
        FormatLine::Other("<blank>".into())
    );
}

#[test]
fn yaml_errors_name_the_document_and_region() {
    let id = DocumentId::new("/doc.eqv").unwrap();
    let bad_math =
        "format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n    math: \"x := := 1\"\n";
    let error = parse_document(id.clone(), bad_math)
        .unwrap_err()
        .to_string();
    assert!(error.contains("region `m`"), "{error}");
    assert!(error.contains("line 1"), "{error}");
    let wrong = "format: sheet/2\nregions: []\n";
    assert!(parse_document(id.clone(), wrong)
        .unwrap_err()
        .to_string()
        .contains("sheet/2"));
    let empty = "format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n";
    assert!(parse_document(id.clone(), empty)
        .unwrap_err()
        .to_string()
        .contains("no `math`"));
    assert!(parse_document(id, "regions: [").is_err());
}

#[test]
fn units_flow_through_the_session_and_unit_overrides_become_display_units() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(
        kernel,
        &[
            // a unit is a labelled name, so the value positions carry `@unit`
            ("x", "x := 3 m@unit"),
            ("y", "y := x^2"),
            ("show", "y ="),
            ("v", "v := 8 m@unit/s@unit"),
            ("vshow", "v = … km/hr"),
            ("bad", "v = … s"),
            ("mix", "1 m@unit + 1 s@unit ="),
            ("deg", "30 deg@unit ="),
        ],
    );
    recalc(&mut s, RecalcMode::Changed);
    // phase 4 exit criterion: x := 3 m, y := x^2, y = shows 9 m^2
    let RegionState::Value {
        value: Some(KernelValue::Quantity {
            magnitude,
            dimension,
        }),
        display_unit: None,
    } = state(&s, "show")
    else {
        panic!("unexpected {:?}", state(&s, "show"));
    };
    assert_eq!(
        serde_json::to_value(&magnitude).unwrap(),
        serde_json::json!({"type": "real", "value": 9.0})
    );
    assert_eq!(
        serde_json::to_value(&dimension).unwrap(),
        serde_json::json!([{"base": "length", "power": [2, 1]}])
    );
    // the value stays in SI, the unit override travels as a display unit
    let RegionState::Value {
        value: Some(value),
        display_unit: Some(unit),
    } = state(&s, "vshow")
    else {
        panic!("unexpected {:?}", state(&s, "vshow"));
    };
    assert_eq!(unit.text, "km/hr");
    assert!((unit.divisor - 1000.0 / 3600.0).abs() < 1e-15);
    let json = serde_json::to_value(&value).unwrap();
    assert_eq!(json["magnitude"]["value"], 8.0);
    // a dimension mismatch is an error of the region only
    match state(&s, "bad") {
        RegionState::Error { failure } => {
            assert_eq!(failure.kind, FailureKind::Evaluation);
            assert!(failure.message.contains("unit override"), "{failure:?}");
        }
        other => panic!("unexpected {other:?}"),
    }
    match state(&s, "mix") {
        RegionState::Error { failure } => {
            assert!(failure.message.contains("units"), "{failure:?}")
        }
        other => panic!("unexpected {other:?}"),
    }
    // dimensionless units are numbers
    assert!((real(&state(&s, "deg")) - std::f64::consts::FRAC_PI_6).abs() < 1e-15);
    // changing only the unit override re-sends the region with the new unit
    s.edit_math(&root_id(), "vshow", "v = … m/s").unwrap();
    let (events, _) = recalc(&mut s, RecalcMode::Changed);
    // (regions that failed are retried on every pass)
    assert_eq!(started(&events), ["vshow", "bad", "mix"]);
    let RegionState::Value {
        display_unit: Some(unit),
        ..
    } = state(&s, "vshow")
    else {
        panic!("unexpected {:?}", state(&s, "vshow"));
    };
    assert_eq!(unit.text, "m/s");
    assert_eq!(unit.divisor, 1.0);
}

#[test]
fn approximate_equality_follows_the_exact_boolean_setting() {
    let Some(kernel) = kernel() else { return };
    let math = [("eq", "(1 + 0.00000000000001) == 1 =")];
    let mut exact = session(kernel.clone(), &math);
    recalc(&mut exact, RecalcMode::Changed);
    assert_eq!(real(&state(&exact, "eq")), 0.0);
    let mut approximate =
        session_with_settings(kernel.clone(), &math, &[("exact-boolean", "false")]);
    recalc(&mut approximate, RecalcMode::Changed);
    assert_eq!(real(&state(&approximate, "eq")), 1.0);
    let mut explicit_true = session_with_settings(kernel, &math, &[("exact-boolean", "true")]);
    recalc(&mut explicit_true, RecalcMode::Changed);
    assert_eq!(real(&state(&explicit_true, "eq")), 0.0);
}

/// The view hands back the very `Arc<ViewRegion>` of a region an edit left alone, and a new one
/// for the region it changed: that is how the app skips an unchanged region.
#[test]
fn an_unchanged_region_is_the_same_view_region_across_an_edit() {
    let kernel = Arc::new(KernelManager::new(
        KernelConfig::new(PathBuf::from("no-such-julia"))
            .with_julia("definitely-not-a-julia-executable"),
    ));
    let mut session = session(
        kernel,
        &[("a", "a := 1"), ("b", "b := a + 1"), ("c", "c := 3")],
    );
    let before = session.view(&root_id()).unwrap();
    let again = session.view(&root_id()).unwrap();
    for (first, second) in before.regions.iter().zip(again.regions.iter()) {
        assert!(
            Arc::ptr_eq(first, second),
            "`{}` was rebuilt by a second view",
            first.id
        );
    }
    session.edit_math(&root_id(), "b", "b := a + 2").unwrap();
    let after = session.view(&root_id()).unwrap();
    let of = |view: &DocumentView, id: &str| {
        view.regions
            .iter()
            .find(|region| region.id == id)
            .unwrap()
            .clone()
    };
    for id in ["a", "c"] {
        assert!(
            Arc::ptr_eq(&of(&before, id), &of(&after, id)),
            "`{id}` did not change but was rebuilt"
        );
    }
    assert!(!Arc::ptr_eq(&of(&before, "b"), &of(&after, "b")));
    match &of(&after, "b").content {
        ViewContent::Math { text, .. } => assert_eq!(text, "b := a + 2"),
        other => panic!("expected math, got {other:?}"),
    }
    // The text of a region is not part of its `Arc`: it is compared too.
    session.edit_math(&root_id(), "a", "a := 4").unwrap();
    let after = session.view(&root_id()).unwrap();
    assert!(!Arc::ptr_eq(&of(&before, "a"), &of(&after, "a")));
    match &of(&after, "a").content {
        ViewContent::Math { text, .. } => assert_eq!(text, "a := 4"),
        other => panic!("expected math, got {other:?}"),
    }
}

#[test]
fn text_blocks_read_width_full_and_old_text_still_loads() {
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [10, 72]\n    text: {text: \"Block\", width: full}\n  - id: b\n    at: [10, 120]\n    text: {text: \"Narrow\", width: 200}\n  - id: c\n    at: [10, 160]\n    text: Plain\n";
    let loaded = parse_document(DocumentId::new("/t.eqv").unwrap(), yaml).unwrap();
    let flags: Vec<(bool, Option<f64>)> = loaded
        .document
        .regions
        .iter()
        .map(|region| match region.as_ref() {
            DocumentRegion::Text(text) => (text.full_width, text.width),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(flags, [(true, None), (false, Some(200.0)), (false, None)]);
}

/// an inline definition is seen by the later operands of
/// its expression, shadows the worksheet there, and ends with the expression.
#[test]
fn an_inline_definition_is_seen_by_the_later_operands() {
    let Some(kernel) = kernel() else {
        return;
    };
    let math = [
        ("f", "f(a, b) := a·b"),
        ("x", "X := 10"),
        ("r", "f(X ← 3, X + 1) ="),
        ("p", "(z ← 2)·(z + 1) ="),
        ("s", "X ="),
    ];
    let mut session = session(kernel, &math);
    recalc(&mut session, RecalcMode::All);
    assert_eq!(real(&state(&session, "r")), 12.0);
    assert_eq!(real(&state(&session, "p")), 6.0);
    assert_eq!(real(&state(&session, "s")), 10.0);
}
