//! Plot regions: hidden trace-expression evaluation, data validation,
//! the binary frame and the real-kernel path. Tests that need the kernel are skipped (with a
//! message) when `julia` is not on PATH.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use equavela_core::ast::StatementKind;
use equavela_core::codegen::GenOptions;
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::kernel_value::{
    DimensionBase, DimensionComponent, KernelValue, MatrixStorage, QuantityMagnitude, RationalPower,
};
use equavela_core::plot::{
    expression_plot_id, expression_region_id, expression_statement, expression_statement_with_x,
    is_expression_region_id, limit_region_id, reference_line_region_id, sampling_region_id,
    unit_region_id, unit_statement, AxisKind, ExpressionResult, LimitBound, PlotAxisLimits,
    PlotAxisUnit, PlotData, PlotDataState, PlotLimitError, PlotScope, PlotUnitError, TraceAxis,
};
use equavela_core::project::{DocumentId, DocumentRegion, Project};
use equavela_core::session::{RecalcMode, RegionKey, RegionState, SessionEvent, WorksheetSession};
use equavela_core::worksheet_file::parse_document;
use equavela_core::worksheet_writer::write_document;

const SHEET: &str = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 0..4\"\n  - id: f\n    at: [0, 20]\n    math: \"f(t) := t^2\"\n  - id: p\n    at: [0, 60]\n    plot:\n      type: xy\n      traces:\n        - {id: t1, x: \"x\", y: \"f(x)\"}\n  - id: late\n    at: [0, 300]\n    math: \"late := 1\"\n";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn kernel() -> Option<Arc<KernelManager>> {
    let ok = std::process::Command::new("julia")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if !ok {
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

fn root() -> DocumentId {
    DocumentId::new("/plot.eqv").unwrap()
}

fn session(kernel: Arc<KernelManager>, yaml: &str) -> WorksheetSession {
    let loaded = parse_document(root(), yaml).unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let texts: HashMap<_, _> = loaded
        .texts
        .into_iter()
        .map(|(id, text)| ((root(), id), text))
        .collect();
    WorksheetSession::new(
        kernel,
        "plot",
        project,
        root(),
        texts,
        GenOptions::default(),
    )
    .unwrap()
}

fn recalc(session: &mut WorksheetSession) -> Vec<SessionEvent> {
    let mut events = Vec::new();
    session
        .recalculate(RecalcMode::Changed, &mut |event| events.push(event.clone()))
        .unwrap();
    events
}

fn vector(values: &[f64]) -> KernelValue {
    KernelValue::Matrix {
        rows: 1,
        cols: values.len(),
        storage: MatrixStorage::Inline {
            values: values.iter().map(|v| KernelValue::real(*v)).collect(),
        },
    }
}

/// The scope in which the x slot of `spec()` (`x1`) is a worksheet variable.
fn explicit_scope() -> PlotScope {
    PlotScope::defining(["x1", "y1"])
}

fn spec() -> equavela_core::plot::PlotSpec {
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x1\", y: \"y1\"}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    match loaded.document.regions[0].as_ref() {
        DocumentRegion::Plot(plot) => plot.plot.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn per_trace_legend_settings_default_and_round_trip_in_version_one() {
    let legacy = parse_document(root(), SHEET).unwrap();
    let DocumentRegion::Plot(legacy_plot) = legacy.document.regions[2].as_ref() else {
        panic!("expected plot region");
    };
    assert!(legacy_plot.plot.traces[0].show_in_legend);
    assert!(legacy_plot.plot.traces[0].legend_label.is_empty());
    let legacy_text = write_document(&legacy.document).unwrap();
    assert!(!legacy_text.contains("show_in_legend"));
    assert!(!legacy_text.contains("legend_label"));

    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: x, y: f(x), show_in_legend: false, legend_label: Measured}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let serialized = write_document(&loaded.document).unwrap();
    assert!(serialized.contains("show_in_legend: false"), "{serialized}");
    assert!(serialized.contains("legend_label: Measured"));
    let reloaded = parse_document(root(), &serialized).unwrap();
    let DocumentRegion::Plot(plot) = reloaded.document.regions[0].as_ref() else {
        panic!("expected plot region");
    };
    assert!(!plot.plot.traces[0].show_in_legend);
    assert_eq!(plot.plot.traces[0].legend_label, "Measured");
}

#[test]
fn a_trace_type_defaults_to_lines_and_round_trips_in_version_one() {
    // a trace type is a version-1 field written only when it is not `lines`,
    // so a worksheet written before trace types existed reads back as line traces and keeps its
    // bytes, and the import's line traces stay identical.
    use equavela_core::plot::{TraceKind, TracePresentation};

    let legacy = parse_document(root(), SHEET).unwrap();
    let DocumentRegion::Plot(legacy_plot) = legacy.document.regions[2].as_ref() else {
        panic!("expected plot region");
    };
    assert_eq!(legacy_plot.plot.traces[0].kind, TraceKind::Lines);
    let legacy_text = write_document(&legacy.document).unwrap();
    assert!(!legacy_text.contains("type: stems"), "{legacy_text}");
    assert!(
        legacy_text.contains("- {id: t1, x: \"x\", y: \"f(x)\"}"),
        "{legacy_text}"
    );

    for (value, kind) in [
        ("stems", TraceKind::Stems),
        ("bars", TraceKind::Bars),
        ("steps", TraceKind::Steps),
    ] {
        let yaml = format!(
            "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{{id: t1, x: x, y: f(x), type: {value}}}]\n"
        );
        let loaded = parse_document(root(), &yaml).unwrap();
        let DocumentRegion::Plot(plot) = loaded.document.regions[0].as_ref() else {
            panic!("expected plot region");
        };
        assert_eq!(plot.plot.traces[0].kind, kind);
        // The type is independent of the presentation.
        assert_eq!(plot.plot.traces[0].presentation, TracePresentation::Line);
        let serialized = write_document(&loaded.document).unwrap();
        assert!(
            serialized.contains(&format!("type: {value}}}")),
            "{serialized}"
        );
        let reloaded = parse_document(root(), &serialized).unwrap();
        let DocumentRegion::Plot(reloaded_plot) = reloaded.document.regions[0].as_ref() else {
            panic!("expected plot region");
        };
        assert_eq!(reloaded_plot.plot, plot.plot);
    }

    // A type the model does not have is a load error, not a silent line.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: x, y: f(x), type: points}]\n";
    assert!(parse_document(root(), yaml).is_err());
}

#[test]
fn a_plot_title_and_axis_titles_round_trip_and_are_optional() {
    // the plot title is a version-1 field written only when it is not empty,
    // and the axis title and unit keep the fields the axis already had.
    let legacy = parse_document(root(), SHEET).unwrap();
    let DocumentRegion::Plot(legacy_plot) = legacy.document.regions[2].as_ref() else {
        panic!("expected plot region");
    };
    assert!(legacy_plot.plot.title.is_empty());
    let legacy_text = write_document(&legacy.document).unwrap();
    assert!(!legacy_text.contains("title:"), "{legacy_text}");

    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      title: Climb rate\n      axes:\n        y: {unit: m/s, title: Speed}\n      traces: [{id: t1, x: x, y: f(x)}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(plot) = loaded.document.regions[0].as_ref() else {
        panic!("expected plot region");
    };
    assert_eq!(plot.plot.title, "Climb rate");
    assert_eq!(plot.plot.axes.y.title, "Speed");
    assert_eq!(plot.plot.axes.y.unit.as_deref(), Some("m/s"));
    let serialized = write_document(&loaded.document).unwrap();
    assert!(serialized.contains("title: Climb rate"), "{serialized}");
    assert!(
        serialized.contains("y: {unit: \"m/s\", title: Speed}"),
        "{serialized}"
    );
    let reloaded = parse_document(root(), &serialized).unwrap();
    let DocumentRegion::Plot(reloaded_plot) = reloaded.document.regions[0].as_ref() else {
        panic!("expected plot region");
    };
    let DocumentRegion::Plot(original) = loaded.document.regions[0].as_ref() else {
        panic!("expected plot region");
    };
    assert_eq!(reloaded_plot.plot, original.plot);
}

#[test]
fn an_axis_position_round_trips_and_is_written_only_when_it_is_origin() {
    // the position is a stored axis field, `boundary` is the default that the file
    // omits, so a worksheet written before the field existed keeps every byte.
    use equavela_core::plot::PlotAxisPosition;

    let legacy = parse_document(root(), SHEET).unwrap();
    let DocumentRegion::Plot(legacy_plot) = legacy.document.regions[2].as_ref() else {
        panic!("expected plot region");
    };
    assert_eq!(legacy_plot.plot.axes.x.position, PlotAxisPosition::Boundary);
    assert_eq!(legacy_plot.plot.axes.y.position, PlotAxisPosition::Boundary);
    let legacy_text = write_document(&legacy.document).unwrap();
    assert!(!legacy_text.contains("position:"), "{legacy_text}");

    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n        x: {position: origin}\n        y: {position: origin, scale: log10, show_grid: false, title: Speed}\n      traces: [{id: t1, x: x, y: f(x)}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let serialized = write_document(&loaded.document).unwrap();
    // The flow mapping keeps the key order of : scale, position, unit, min, max, show_grid, title.
    assert!(serialized.contains("x: {position: origin}"), "{serialized}");
    assert!(
        serialized.contains("y: {scale: log10, position: origin, show_grid: false, title: Speed}"),
        "{serialized}"
    );
    let reloaded = parse_document(root(), &serialized).unwrap();
    let DocumentRegion::Plot(plot) = reloaded.document.regions[0].as_ref() else {
        panic!("expected plot region");
    };
    assert_eq!(plot.plot.axes.x.position, PlotAxisPosition::Origin);
    assert_eq!(plot.plot.axes.y.position, PlotAxisPosition::Origin);
    assert!(!plot.plot.axes.y.show_grid);
    assert_eq!(plot.plot.axes.y2.position, PlotAxisPosition::Boundary);
    // Writing a file that is already canonical reproduces it byte for byte.
    assert_eq!(write_document(&reloaded.document).unwrap(), serialized);
}

#[test]
fn a_title_is_one_line_and_an_axis_unit_must_parse() {
    let mut plot = spec();
    plot.title = "two\nlines".into();
    assert!(plot.validate().unwrap_err().contains("single line"));
    plot.title = "Climb rate".into();
    plot.axes.y.title = "a\rbreak".into();
    assert!(plot.validate().unwrap_err().contains("y-axis title"));
    plot.axes.y.title = String::new();
    plot.axes.y.unit = Some("m/".into());
    assert!(plot.validate().unwrap_err().contains("unit expression"));
    plot.axes.y.unit = Some("m/s".into());
    plot.validate().unwrap();
}

#[test]
fn trace_style_rejects_invalid_colors_and_sizes() {
    let mut plot = spec();
    plot.traces[0].line.width = 7.0;
    assert!(plot.validate().unwrap_err().contains("line width"));
    plot.traces[0].line.width = 1.5;
    plot.traces[0].marker.color = Some("red".into());
    assert!(plot.validate().unwrap_err().contains("#RRGGBB"));
}

#[test]
fn trace_expressions_become_hidden_evaluations_and_ranges_are_allowed() {
    let statement = expression_statement("0..10").unwrap();
    assert!(matches!(
        statement.kind,
        equavela_core::ast::StatementKind::Evaluate { .. }
    ));
    assert!(expression_statement("(").is_err());
    let id = expression_region_id("p", "t1", TraceAxis::Y);
    assert!(equavela_core::plot::is_expression_region_id(&id));
    assert_eq!(equavela_core::plot::expression_plot_id(&id), Some("p"));
    assert!(!equavela_core::plot::is_expression_region_id("p"));
}

#[test]
fn an_undefined_x_variable_sets_up_a_hidden_sampled_x_and_rewrites_y() {
    // The x slot names an undefined `x`; an empty slot would be the error of .
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"sin(x)\"}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(plot) = loaded.document.regions[0].as_ref() else {
        panic!("expected a plot region");
    };
    let regions = plot.expression_regions(&PlotScope::default());
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].id, sampling_region_id("p", "t1"));
    assert_eq!(regions[1].id, expression_region_id("p", "t1", TraceAxis::Y));
    let StatementKind::Evaluate { expr, .. } = &regions[1].statement.kind else {
        panic!("expected an evaluation region");
    };
    let json = serde_json::to_string(expr).unwrap();
    assert!(json.contains("xSheetPlot"), "{json}");
    assert!(!json.contains("\"text\":\"x\""), "{json}");
    let rewritten = expression_statement_with_x("sin(x)", Some("xSheetPlotpx")).unwrap();
    let StatementKind::Evaluate { expr, .. } = &rewritten.kind else {
        panic!("expected an evaluation statement");
    };
    assert!(serde_json::to_string(expr)
        .unwrap()
        .contains("xSheetPlotpx"));
}

#[test]
fn polar_plots_evaluate_angle_as_an_explicit_expression_when_the_worksheet_defines_it() {
    let yaml = r#"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: polar
      traces: [{id: t1, x: "x", y: "r"}]
"#;
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(plot) = loaded.document.regions[0].as_ref() else {
        panic!("expected a plot region");
    };
    let scope = PlotScope::defining(["x", "r"]);
    let regions = plot.expression_regions(&scope);
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].id, expression_region_id("p", "t1", TraceAxis::X));
    assert_eq!(regions[1].id, expression_region_id("p", "t1", TraceAxis::Y));

    let data = plot.plot.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[0.0, std::f64::consts::PI])),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces[0].x, vec![0.0, std::f64::consts::PI]);
    assert_eq!(data.traces[0].y, vec![1.0, 2.0]);
}

#[test]
fn assemble_accepts_an_implicit_x_vector_for_an_undefined_x_trace() {
    let mut spec = spec();
    spec.traces[0].x = "t".into();
    spec.traces[0].y = "sin(t)".into();
    let data = spec.assemble(
        "p",
        &[ExpressionResult::Value(vector(&vec![0.0; 501]))],
        &PlotScope::default(),
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
}

#[test]
fn the_on_screen_view_range_moves_the_sample_interval_of_an_implicit_x() {
    use equavela_core::plot::{
        implicit_x_bounds, AxisLimit, AxisScale, PlotAxis, PlotKind, ViewRange, IMPLICIT_ANGLE_MAX,
    };
    let axis = PlotAxis::default();
    let view = ViewRange::sample(-15.0, 5.0).expect("a usable view range");

    // priority 3: nobody navigated the plot, so -10..10.
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &axis, None, [None, None]),
        (-10.0, 10.0)
    );
    // priority 2: the view range the user navigated to.
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &axis, Some(view), [None, None]),
        (-15.0, 5.0)
    );
    // priority 1: a typed numeric limit stays authoritative, end by end.
    let min_typed = PlotAxis {
        min: Some(AxisLimit::Value(0.0)),
        ..PlotAxis::default()
    };
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &min_typed, Some(view), [None, None]),
        (0.0, 5.0),
        "the typed minimum wins, the view gives the open end"
    );
    let both_typed = PlotAxis {
        min: Some(AxisLimit::Value(0.0)),
        max: Some(AxisLimit::Value(3.0)),
        ..PlotAxis::default()
    };
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &both_typed, Some(view), [None, None]),
        (0.0, 3.0),
        "interactive zoom never overrides a typed limit"
    );

    // A logarithmic axis keeps the positivity rule of the default interval.
    let log = PlotAxis {
        scale: AxisScale::Log10,
        ..PlotAxis::default()
    };
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &log, Some(view), [None, None]),
        (1.0, 5.0),
        "an end at or below zero becomes 1"
    );
    let negative = ViewRange::sample(-15.0, -5.0).expect("a usable view range");
    assert_eq!(
        implicit_x_bounds(PlotKind::Xy, &log, Some(negative), [None, None]),
        (1.0, 10.0),
        "a maximum not above the minimum becomes ten times it"
    );

    // A polar plot has no x axis to navigate: its angle is unchanged.
    assert_eq!(
        implicit_x_bounds(PlotKind::Polar, &axis, Some(view), [None, None]),
        (0.0, IMPLICIT_ANGLE_MAX)
    );

    // A screen range that cannot be an interval leaves the default one.
    assert_eq!(ViewRange::sample(1.0, 1.0), None);
    assert_eq!(ViewRange::sample(5.0, -5.0), None);
    assert_eq!(ViewRange::sample(f64::NAN, 5.0), None);
    assert_eq!(ViewRange::sample(-10.0, f64::INFINITY), None);
}

#[test]
fn the_on_screen_view_range_resamples_the_trace_over_its_501_points() {
    use equavela_core::plot::ViewRange;
    let mut spec = spec();
    spec.traces[0].x = "x".into();
    spec.traces[0].y = "sin(x)".into();
    let view = ViewRange::sample(-15.0, 5.0).expect("a usable view range");
    let data = spec.assemble_in_view(
        "p",
        &[ExpressionResult::Value(vector(&vec![0.0; 501]))],
        &PlotScope::default(),
        Some(view),
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    // still 501 points including both ends, so a narrower view keeps its resolution.
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-15.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(5.0));
    assert!((data.traces[0].x[1] - -15.0 - 20.0 / 500.0).abs() < 1e-12);
    // the data says a navigation has samples to move.
    assert!(data.implicit_x);
    let decoded = PlotData::decode_frame(&data.encode_frame()).unwrap();
    assert!(decoded.implicit_x, "the frame carries the flag");

    // An explicit x is calculated once and never resampled by navigation.
    let explicit = plot_with_traces(r#"{id: t1, x: "x1", y: "y1"}"#);
    let data = explicit.assemble_in_view(
        "p",
        &[
            ExpressionResult::Value(vector(&[0.0, 1.0])),
            ExpressionResult::Value(vector(&[0.0, 3.0])),
        ],
        &explicit_scope(),
        Some(view),
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x, [0.0, 1.0]);
    assert!(
        !data.implicit_x,
        "nothing of an explicit x follows the view"
    );

    // A polar angle keeps one turn, whatever the view says.
    let mut polar = plot_with_traces(r#"{id: t1, x: "t", y: "t"}"#);
    polar.kind = equavela_core::plot::PlotKind::Polar;
    let data = polar.assemble_in_view(
        "p",
        &[ExpressionResult::Value(vector(&vec![1.0; 501]))],
        &PlotScope::default(),
        Some(view),
    );
    assert_eq!(data.traces[0].x.first().copied(), Some(0.0));
    assert_eq!(
        data.traces[0].x.last().copied(),
        Some(equavela_core::plot::IMPLICIT_ANGLE_MAX)
    );
    assert!(!data.implicit_x);
}

#[test]
fn the_hidden_sampling_region_samples_the_on_screen_view_range() {
    use equavela_core::plot::{PlotRegion, ViewRange};
    // The sampled interval of a navigated plot is the same statement as the one a typed numeric
    // limit produces, so the kernel and the assembled data agree on the points.
    let spec = plot_with_traces(r#"{id: t1, x: "t", y: "sin(t)"}"#);
    let navigated = PlotRegion {
        view: Some(ViewRange::sample(-15.0, 5.0).expect("a usable view range")),
        ..PlotRegion::new("p", 1, 0.0, 0.0, spec.clone())
    };
    let mut typed = spec.clone();
    typed.axes.x.min = Some(equavela_core::plot::AxisLimit::Value(-15.0));
    typed.axes.x.max = Some(equavela_core::plot::AxisLimit::Value(5.0));
    let limited = PlotRegion::new("p", 1, 0.0, 0.0, typed);
    let statement = |region: &PlotRegion| {
        use equavela_core::print_statement;
        let regions = region.expression_regions(&PlotScope::default());
        assert_eq!(regions[0].id, sampling_region_id("p", "t1"));
        print_statement(&regions[0].statement)
    };
    assert_eq!(statement(&navigated), statement(&limited));
    assert_ne!(
        statement(&navigated),
        statement(&PlotRegion::new("p", 1, 0.0, 0.0, spec))
    );
}

#[test]
fn the_on_screen_view_range_is_never_written_to_the_worksheet() {
    use equavela_core::plot::ViewRange;
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"sin(x)\"}]\n";
    let mut loaded = parse_document(root(), yaml).unwrap();
    let before = write_document(&loaded.document).unwrap();
    let DocumentRegion::Plot(region) = std::sync::Arc::make_mut(&mut loaded.document.regions[0])
    else {
        panic!("expected a plot region");
    };
    region.view = ViewRange::sample(-15.0, 5.0);
    let after = write_document(&loaded.document).unwrap();
    assert_eq!(before, after, "the view is screen-only");
    assert!(!after.contains("view"));
    // A file read back starts again from the default interval.
    let reread = parse_document(root(), &after).unwrap();
    let DocumentRegion::Plot(region) = reread.document.regions[0].as_ref() else {
        panic!("expected a plot region");
    };
    assert_eq!(region.view, None);
}

#[test]
fn an_empty_x_slot_is_an_error_and_never_samples_the_y_variable() {
    use equavela_core::plot::PlotRegion;
    let region =
        |spec: &equavela_core::plot::PlotSpec| PlotRegion::new("p", 1, 0.0, 0.0, spec.clone());

    // decision: typing `x` in the y slot drew `y = x` before an x axis was chosen.
    let mut y_only = spec();
    y_only.traces[0].x.clear();
    y_only.traces[0].y = "x".into();
    assert!(
        region(&y_only)
            .expression_regions(&PlotScope::default())
            .is_empty(),
        "an x-less trace evaluates nothing"
    );
    let data = y_only.assemble("p", &[], &PlotScope::default());
    assert_eq!(data.state, PlotDataState::Error);
    assert!(data.traces.is_empty());
    let error = data.error.expect("the missing x axis is an error");
    assert_eq!((error.trace.as_str(), error.axis), ("t1", TraceAxis::X));
    assert_eq!(error.expression, "");
    assert!(
        error.message.contains("x expression is empty"),
        "{}",
        error.message
    );

    // A y-only trace errors whatever its y expression reads.
    for y in ["sin(t)", "k*tt", "3x"] {
        let mut spec = spec();
        spec.traces[0].x.clear();
        spec.traces[0].y = y.into();
        assert_eq!(
            spec.assemble("p", &[], &PlotScope::default()).state,
            PlotDataState::Error,
            "{y}"
        );
    }

    // A new plot, with both placeholders empty, is not an error.
    let mut blank = spec();
    blank.traces[0].x.clear();
    blank.traces[0].y.clear();
    assert!(region(&blank)
        .expression_regions(&PlotScope::default())
        .is_empty());
    let pending = blank.assemble("p", &[], &PlotScope::default());
    assert_eq!(pending.state, PlotDataState::Pending);
    assert!(pending.error.is_none());
}

/// A plot specification from its trace list, for the tests that only need the model.
fn plot_with_traces(traces: &str) -> equavela_core::plot::PlotSpec {
    let yaml = format!(
        "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{traces}]\n"
    );
    let loaded = parse_document(root(), &yaml).unwrap();
    match loaded.document.regions[0].as_ref() {
        DocumentRegion::Plot(plot) => plot.plot.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_x_slot_of_a_trace_is_the_plot_variable_only_without_a_worksheet_x() {
    use equavela_core::plot::{
        trace_axes, trace_x, PlotScope, PlotTrace, TracePresentation, TraceXKind,
    };
    let trace = |x: &str, y: &str| PlotTrace {
        id: "t1".into(),
        x: x.into(),
        y: y.into(),
        z: String::new(),
        y_axis: equavela_core::plot::TraceYAxis::Left,
        presentation: TracePresentation::Line,
        kind: equavela_core::plot::TraceKind::Lines,
        line: equavela_core::plot::TraceLineStyle::default(),
        marker: equavela_core::plot::TraceMarkerStyle::default(),
        show_in_legend: true,
        legend_label: String::new(),
    };
    let undefined = &PlotScope::default();
    let defined = &PlotScope::defining(["x"]);

    assert_eq!(trace_x(&trace("x", "3x"), undefined), TraceXKind::Implicit);
    assert_eq!(
        trace_x(&trace(" x ", "3x"), undefined),
        TraceXKind::Implicit
    );
    // An empty x slot is an unfilled placeholder, never the plot's own axis.
    assert_eq!(trace_x(&trace("", "3x"), undefined), TraceXKind::Expression);
    assert_eq!(trace_x(&trace("", "3x"), defined), TraceXKind::Expression);
    assert_eq!(trace_x(&trace("x", "3x"), defined), TraceXKind::Expression);
    // Any plain identifier that nothing defines is the plot variable, whatever its name —
    // a spelling of the unit table included, because a plain name is never a unit.
    for name in ["t", "tt", "xx", "X", "θ", "m"] {
        assert_eq!(
            trace_x(&trace(name, "3x"), undefined),
            TraceXKind::Implicit,
            "{name}"
        );
        assert_eq!(
            trace_x(&trace(name, "3x"), &PlotScope::defining([name])),
            TraceXKind::Expression,
            "{name} defined"
        );
    }
    // Defining `x` does not define `x_1` (a different name).
    assert_eq!(trace_x(&trace("x_1", "3x"), defined), TraceXKind::Implicit);
    let subscripted = &PlotScope {
        defined: [equavela_core::ast::Name::sub("x", "1")]
            .into_iter()
            .collect(),
    };
    assert_eq!(
        trace_x(&trace("x_1", "3x"), subscripted),
        TraceXKind::Expression
    );
    assert_eq!(
        trace_x(&trace("x", "3x"), subscripted),
        TraceXKind::Implicit
    );
    // Not a plain identifier, or a constant: an ordinary expression.
    for source in ["2t", "t+1", "sin(t)", "π"] {
        assert_eq!(
            trace_x(&trace(source, "3x"), undefined),
            TraceXKind::Expression,
            "{source}"
        );
    }
    // An empty slot names no variable at all: the y expression is not sampled.
    use equavela_core::plot::sample_variable;
    for y in ["sin(t)", "sin(t)+w", "3x", ""] {
        assert_eq!(sample_variable(&trace("", y), undefined), None, "{y}");
    }

    // The consumed results: a generated x contributes only its y expression.
    assert_eq!(trace_axes(&trace("x", "3x"), undefined), vec![TraceAxis::Y]);
    assert_eq!(
        trace_axes(&trace("x", "3x"), defined),
        vec![TraceAxis::X, TraceAxis::Y]
    );
    assert!(trace_axes(&trace("", ""), undefined).is_empty());
    assert!(trace_axes(&trace("", "3x"), undefined).is_empty());
}

#[test]
fn no_variable_name_is_special_including_x() {
    use equavela_core::ast::ExprKind;
    use equavela_core::plot::{
        expression_statement_rewriting, sample_variable, trace_axes, trace_x, PlotTrace,
        TracePresentation, TraceXKind,
    };
    use equavela_core::{parse_expression, print_statement};
    let trace = |x: &str, y: &str| PlotTrace {
        id: "t1".into(),
        x: x.into(),
        y: y.into(),
        z: String::new(),
        y_axis: equavela_core::plot::TraceYAxis::Left,
        presentation: TracePresentation::Line,
        kind: equavela_core::plot::TraceKind::Lines,
        line: equavela_core::plot::TraceLineStyle::default(),
        marker: equavela_core::plot::TraceMarkerStyle::default(),
        show_in_legend: true,
        legend_label: String::new(),
    };
    // The name the parser gives the x slot, as `plot::sample_variable` returns it.
    let parsed = |source: &str| match parse_expression(source).unwrap().kind {
        ExprKind::Ident { name, .. } => name,
        other => panic!("{source} is not an identifier: {other:?}"),
    };
    let undefined = &PlotScope::default();
    let empty_x_message = "the x expression is empty; enter the x-axis variable or expression";

    // .1: `x` is a name like any other, so the whole matrix below is the same for every
    // name in the list — `x` gets no private sampling, shadowing, rewriting or error path.
    let mut generated: Option<Vec<f64>> = None;
    let mut rewritten: Option<String> = None;
    for name in ["x", "t", "tt", "xx", "X", "θ", "ψ", "t_1"] {
        let y = format!("sin({name})");
        let slot = trace(name, &y);
        assert_eq!(
            sample_variable(&slot, undefined),
            Some(parsed(name)),
            "{name}"
        );
        assert_eq!(trace_x(&slot, undefined), TraceXKind::Implicit, "{name}");
        assert_eq!(trace_axes(&slot, undefined), vec![TraceAxis::Y], "{name}");
        // A worksheet definition of that name — and only that name — makes both slots ordinary.
        // The scope holds the parsed name, as `Project::defined_plain_names` does.
        let defined = PlotScope {
            defined: [parsed(name)].into_iter().collect(),
        };
        assert_eq!(sample_variable(&slot, &defined), None, "{name}");
        assert_eq!(trace_x(&slot, &defined), TraceXKind::Expression, "{name}");
        assert_eq!(
            trace_axes(&slot, &defined),
            vec![TraceAxis::X, TraceAxis::Y],
            "{name}"
        );

        // The generated axis does not depend on the spelling: 501 points over -10 … 10.
        let spec = plot_with_traces(&format!(r#"{{id: t1, x: "{name}", y: "{y}"}}"#));
        let data = spec.assemble(
            "p",
            &[ExpressionResult::Value(vector(&vec![0.0; 501]))],
            undefined,
        );
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        assert_eq!(data.traces[0].x.len(), 501, "{name}");
        assert_eq!(data.traces[0].x.first().copied(), Some(-10.0), "{name}");
        assert_eq!(data.traces[0].x.last().copied(), Some(10.0), "{name}");
        match &generated {
            None => generated = Some(data.traces[0].x.clone()),
            Some(first) => assert_eq!(&data.traces[0].x, first, "{name}"),
        }

        // The y rewrite produces the same statement whatever the variable is called.
        let statement =
            expression_statement_rewriting(&format!("{name}+1"), &parsed(name), Some("plotSample"))
                .unwrap();
        let text = print_statement(&statement);
        match &rewritten {
            None => rewritten = Some(text),
            Some(first) => assert_eq!(&text, first, "{name}"),
        }

        // An empty x slot is the same error for a y expression that names any of them.
        let mut y_only = spec;
        y_only.traces[0].x.clear();
        y_only.traces[0].y = name.into();
        let data = y_only.assemble("p", &[], undefined);
        let error = data.error.expect("an x-less trace is an error");
        assert_eq!(
            (error.axis, error.message.as_str()),
            (TraceAxis::X, empty_x_message),
            "{name}"
        );
    }
    // The dedicated `x` helper and the general rewrite cannot diverge (kept for callers that
    // know the variable is `x`; it is not a special case).
    assert_eq!(
        print_statement(&expression_statement_with_x("x+1", Some("plotSample")).unwrap()),
        print_statement(
            &expression_statement_rewriting("x+1", &parsed("x"), Some("plotSample")).unwrap()
        )
    );
    let rewritten = rewritten.expect("the rewrite ran");
    assert!(rewritten.contains("plotSample"), "{rewritten}");
    let tokens: Vec<&str> = rewritten.split_whitespace().collect();
    for name in ["x", "t", "θ", "ψ", "t_1"] {
        assert!(
            !tokens.contains(&name),
            "{rewritten} still names {name} as a variable"
        );
    }
}

#[test]
fn an_x_slot_naming_x_samples_the_axis_only_without_a_worksheet_x() {
    use equavela_core::plot::{PlotRegion, PlotScope};
    let spec = plot_with_traces(r#"{id: t1, x: "x", y: "3x"}"#);
    let region = PlotRegion::new("p", 1, 0.0, 0.0, spec.clone());
    let region_ids = |scope: &PlotScope| -> Vec<String> {
        let ids: Vec<String> = region
            .expression_regions(scope)
            .into_iter()
            .map(|region| region.id)
            .collect();
        ids
    };

    assert_eq!(
        region_ids(&PlotScope::default()),
        vec![
            sampling_region_id("p", "t1"),
            expression_region_id("p", "t1", TraceAxis::Y)
        ]
    );
    assert_eq!(
        region_ids(&PlotScope::defining(["x"])),
        vec![
            expression_region_id("p", "t1", TraceAxis::X),
            expression_region_id("p", "t1", TraceAxis::Y)
        ]
    );

    // The data side reads one result per consumed expression and samples the x axis.
    let sampled = spec.assemble(
        "p",
        &[ExpressionResult::Value(vector(&vec![1.0; 501]))],
        &PlotScope::default(),
    );
    assert_eq!(sampled.state, PlotDataState::Ready);
    assert_eq!(sampled.traces[0].x.first().copied(), Some(-10.0));
    let explicit = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[0.0, 1.0])),
            ExpressionResult::Value(vector(&[0.0, 3.0])),
        ],
        &PlotScope::defining(["x"]),
    );
    assert_eq!(explicit.state, PlotDataState::Ready);
    assert_eq!(explicit.traces[0].x, [0.0, 1.0]);
}

#[test]
fn the_project_reports_whether_a_plain_x_variable_is_defined() {
    let project = |regions: &str| {
        let yaml = format!("format: equavela-worksheet/3\nregions:{regions}");
        let loaded = parse_document(root(), &yaml).unwrap();
        let mut project = Project::new();
        project.insert(loaded.document).unwrap();
        project
    };
    let with_x = project(
        "\n  - id: xs\n    at: [0, 0]\n    math: \"x := 0..4\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"3x\"}]\n",
    );
    assert!(with_x.defines_plain_name("x"));
    assert!(!with_x.defines_plain_name("y"));
    // A function `x(t)` and a different name do not define the value `x`.
    let function = project("\n  - id: f\n    at: [0, 0]\n    math: \"x(t) := t^2\"\n");
    assert!(!function.defines_plain_name("x"));
    let other = project("\n  - id: xs\n    at: [0, 0]\n    math: \"x_1 := 0..4\"\n");
    assert!(!other.defines_plain_name("x"));
    // A disabled region defines nothing.
    let disabled =
        project("\n  - id: xs\n    at: [0, 0]\n    enabled: false\n    math: \"x := 0..4\"\n");
    assert!(!disabled.defines_plain_name("x"));
}

#[test]
fn project_analysis_adds_one_hidden_node_per_trace_expression_in_reading_order() {
    let loaded = parse_document(root(), SHEET).unwrap();
    let mut project = Project::new();
    project.insert(loaded.document).unwrap();
    let analysis = project.analyze(&root()).unwrap();
    let ids: Vec<String> = analysis
        .nodes()
        .iter()
        .map(|node| node.origin.region_id.clone())
        .collect();
    assert_eq!(ids.len(), 5);
    assert_eq!(ids[0], "xs");
    assert_eq!(ids[2], expression_region_id("p", "t1", TraceAxis::X));
    assert_eq!(ids[3], expression_region_id("p", "t1", TraceAxis::Y));
    assert_eq!(ids[4], "late");
}

/// A plot specification from its `axes:` block (already indented) and trace list.
fn plot_with_axes(axes: &str, traces: &str) -> equavela_core::plot::PlotSpec {
    let yaml = format!(
        "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n{axes}\n      traces: [{traces}]\n"
    );
    let loaded = parse_document(root(), &yaml).unwrap();
    match loaded.document.regions[0].as_ref() {
        DocumentRegion::Plot(plot) => plot.plot.clone(),
        other => panic!("{other:?}"),
    }
}

/// The limits of one axis of assembled plot data.
fn limits_of(data: &PlotData, axis: AxisKind) -> PlotAxisLimits {
    data.limits
        .iter()
        .find(|limits| limits.axis == axis)
        .cloned()
        .expect("every axis is reported")
}

/// A vector whose values carry one base dimension (a quantity per element): the y data of a plot
/// in SI magnitudes.
fn quantity_vector(values: &[f64], base: DimensionBase) -> KernelValue {
    KernelValue::Matrix {
        rows: 1,
        cols: values.len(),
        storage: MatrixStorage::Inline {
            values: values
                .iter()
                .map(|value| KernelValue::Quantity {
                    magnitude: QuantityMagnitude::Real {
                        value: (*value).into(),
                    },
                    dimension: vec![DimensionComponent {
                        base,
                        power: RationalPower(1, 1),
                    }],
                })
                .collect(),
        },
    }
}

/// A real scalar with one base dimension, the value of a unit expression (`mm` is 0.001 m).
fn unit_value(value: f64, base: DimensionBase) -> KernelValue {
    KernelValue::Quantity {
        magnitude: QuantityMagnitude::Real {
            value: value.into(),
        },
        dimension: vec![DimensionComponent {
            base,
            power: RationalPower(1, 1),
        }],
    }
}

#[test]
fn a_unit_expression_is_a_hidden_region_after_the_limits_and_before_the_traces() {
    use equavela_core::plot::PlotRegion;
    let plot = plot_with_axes(
        r#"        x: {max: "L/2"}
        y: {unit: mm, title: Speed}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    assert_eq!(plot.unit_expressions(), vec![AxisKind::Y]);
    let region = PlotRegion::new("p", 1, 0.0, 0.0, plot.clone());
    let regions = region.expression_regions(&explicit_scope());
    let ids: Vec<String> = regions.iter().map(|region| region.id.clone()).collect();
    assert_eq!(
        ids,
        vec![
            limit_region_id("p", AxisKind::X, LimitBound::Max),
            unit_region_id("p", AxisKind::Y),
            expression_region_id("p", "t1", TraceAxis::X),
            expression_region_id("p", "t1", TraceAxis::Y),
        ]
    );
    // The unit region is an evaluation like any other hidden plot expression, and the session
    // tells it apart from a trace expression by its id only.
    assert!(is_expression_region_id(&ids[1]));
    assert_eq!(expression_plot_id(&ids[1]), Some("p"));
    assert!(matches!(
        regions[1].statement.kind,
        StatementKind::Evaluate { .. }
    ));
    assert_eq!((regions[1].x, regions[1].y, regions[1].page), (0.0, 0.0, 1));

    // A name in a unit expression is a unit name: the statement carries the unit label.
    let statement = unit_statement("km/hr").unwrap();
    let text = format!("{:?}", statement.kind);
    assert!(text.contains("Unit"), "{text}");
    // The stored text is untouched: nothing rewrites what the user typed.
    let plot = plot_with_axes(
        r#"        y: {unit: km/hr}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    assert_eq!(plot.axes.y.unit.as_deref(), Some("km/hr"));

    // The right y axis is a region only while a trace is drawn against it.
    let unused = plot_with_axes(r#"        y2: {unit: mm}"#, r#"{id: t1, x: "x1", y: "y1"}"#);
    assert!(unused.unit_expressions().is_empty());
    assert!(!unused.uses_right_axis());
    let used = plot_with_axes(
        r#"        y2: {unit: mm}"#,
        r#"{id: t1, x: "x1", y: "y1", y_axis: right}"#,
    );
    assert_eq!(used.unit_expressions(), vec![AxisKind::Y2]);
    assert!(used.uses_right_axis());
}

#[test]
fn a_display_unit_divides_the_values_and_limits_of_its_axis() {
    // the y axis is in `mm` (0.001 m) and its data is in SI metres.
    let plot = plot_with_axes(
        r#"        y: {unit: mm, max: 0.005}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    let data = plot.assemble(
        "p",
        &[
            ExpressionResult::Value(unit_value(0.001, DimensionBase::Length)),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(quantity_vector(&[0.001, 0.002], DimensionBase::Length)),
        ],
        &explicit_scope(),
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert!(data.unit_errors.is_empty(), "{:?}", data.unit_errors);
    assert_eq!(
        data.units,
        vec![PlotAxisUnit {
            axis: AxisKind::Y,
            divisor: 0.001
        }]
    );
    assert_eq!(data.traces[0].y, [1.0, 2.0], "the trace is drawn in mm");
    assert_eq!(data.traces[0].x, [1.0, 2.0], "the x axis has no unit");
    // The typed limit is an SI magnitude too: 0.005 m is 5 mm.
    assert_eq!(
        limits_of(&data, AxisKind::Y),
        PlotAxisLimits {
            axis: AxisKind::Y,
            min: None,
            max: Some(5.0)
        }
    );
    // The dimension metadata is unchanged: the values are the same quantity, drawn in mm.
    assert_eq!(data.traces[0].y_dimension.len(), 1);

    // The frame carries the units and their failures to the renderer.
    let decoded = PlotData::decode_frame(&data.encode_frame()).unwrap();
    assert_eq!(decoded.units, data.units);
    assert_eq!(decoded.unit_errors, data.unit_errors);
    assert_eq!(limits_of(&decoded, AxisKind::Y).max, Some(5.0));

    // A dimensionless unit converts a dimensionless axis: `deg` is pi/180 on a polar angle.
    let polar = plot_with_axes(r#"        x: {unit: deg}"#, r#"{id: t1, x: "x1", y: "y1"}"#);
    let data = polar.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(std::f64::consts::PI / 180.0)),
            ExpressionResult::Value(vector(&[0.0, std::f64::consts::PI])),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
        ],
        &explicit_scope(),
    );
    assert!(data.unit_errors.is_empty(), "{:?}", data.unit_errors);
    assert_eq!(data.traces[0].x, [0.0, 180.0]);
}

#[test]
fn a_unit_that_cannot_be_used_is_reported_and_keeps_the_si_base_display() {
    let plot = plot_with_axes(r#"        y: {unit: mm}"#, r#"{id: t1, x: "x1", y: "y1"}"#);
    let assemble = |unit: ExpressionResult| {
        plot.assemble(
            "p",
            &[
                unit,
                ExpressionResult::Value(vector(&[1.0, 2.0])),
                ExpressionResult::Value(quantity_vector(&[0.001, 0.002], DimensionBase::Length)),
            ],
            &explicit_scope(),
        )
    };

    // A unit whose dimension disagrees with the data: the traces still draw, in SI.
    let mismatch = assemble(ExpressionResult::Value(unit_value(
        0.001,
        DimensionBase::Time,
    )));
    assert_eq!(mismatch.state, PlotDataState::Ready);
    assert!(mismatch.units.is_empty());
    assert_eq!(mismatch.traces[0].y, [0.001, 0.002]);
    assert_eq!(
        mismatch.unit_errors,
        vec![PlotUnitError {
            axis: AxisKind::Y,
            expression: "mm".into(),
            message: "the unit does not match the dimension of the values of this axis".into(),
        }]
    );

    // A unit that is not a positive number cannot convert an axis.
    let negative = assemble(ExpressionResult::Value(unit_value(
        -0.001,
        DimensionBase::Length,
    )));
    assert!(negative.units.is_empty());
    assert!(negative.unit_errors[0]
        .message
        .contains("a unit must be a positive finite number"));

    // A unit that failed to calculate, and one that is not a real scalar.
    let failed = assemble(ExpressionResult::Failed("`mm` is not a unit".into()));
    assert_eq!(failed.traces[0].y, [0.001, 0.002]);
    assert_eq!(failed.unit_errors[0].message, "`mm` is not a unit");
    let not_a_scalar = assemble(ExpressionResult::Value(vector(&[0.001, 0.002])));
    assert!(not_a_scalar.unit_errors[0]
        .message
        .contains("expected a real number"));

    // Not calculated yet: the axis keeps SI and nothing is reported, like a limit.
    let pending = assemble(ExpressionResult::Pending);
    assert!(pending.units.is_empty());
    assert!(pending.unit_errors.is_empty());
    assert_eq!(pending.traces[0].y, [0.001, 0.002]);
    // A stale unit still converts.
    let stale = assemble(ExpressionResult::Stale(unit_value(
        0.001,
        DimensionBase::Length,
    )));
    assert_eq!(stale.traces[0].y, [1.0, 2.0]);
}

#[test]
fn a_plot_without_data_reports_no_unit_failure() {
    // With no trace there is no dimension to compare a unit with, so nothing is converted and
    // nothing is reported: the mismatch of a pending plot would be a guess.
    let plot = plot_with_axes(r#"        y: {unit: mm}"#, r#"{id: t1, x: "x1", y: "y1"}"#);
    let data = plot.assemble(
        "p",
        &[
            ExpressionResult::Value(unit_value(0.001, DimensionBase::Length)),
            ExpressionResult::Pending,
            ExpressionResult::Pending,
        ],
        &explicit_scope(),
    );
    assert_eq!(data.state, PlotDataState::Pending);
    assert!(data.units.is_empty());
    assert!(data.unit_errors.is_empty());
}

#[test]
fn a_limit_expression_is_a_hidden_region_before_the_trace_expressions() {
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: L\n    at: [0, 0]\n    math: \"L := 8\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      axes:\n        x: {max: \"L/2\"}\n        y: {min: 0, max: \"L\"}\n      traces: [{id: t1, x: \"2t\", y: \"sin(t)\"}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(plot) = loaded.document.regions[1].as_ref() else {
        panic!("the second region is a plot");
    };
    let scope = explicit_scope();
    assert_eq!(
        plot.plot.limit_expressions(),
        vec![
            (AxisKind::X, LimitBound::Max),
            (AxisKind::Y, LimitBound::Max)
        ],
        "a numeric limit is not an expression"
    );
    let regions = plot.expression_regions(&scope);
    let ids: Vec<String> = regions.iter().map(|region| region.id.clone()).collect();
    assert_eq!(
        ids,
        vec![
            limit_region_id("p", AxisKind::X, LimitBound::Max),
            limit_region_id("p", AxisKind::Y, LimitBound::Max),
            expression_region_id("p", "t1", TraceAxis::X),
            expression_region_id("p", "t1", TraceAxis::Y),
        ]
    );
    // The session treats a limit region like any other hidden plot expression.
    assert!(is_expression_region_id(&ids[0]));
    assert_eq!(expression_plot_id(&ids[0]), Some("p"));
    // It is an evaluation of the stored expression, staged at the plot's position.
    assert!(matches!(
        regions[0].statement.kind,
        StatementKind::Evaluate { .. }
    ));
    for region in &regions {
        assert_eq!((region.x, region.y, region.page), (0.0, 40.0, 1));
    }

    // The analysis places them exactly there, before the trace expressions of the plot.
    let mut project = Project::new();
    project.insert(loaded.document.clone()).unwrap();
    let analysis = project.analyze(&root()).unwrap();
    let order: Vec<String> = analysis
        .nodes()
        .iter()
        .map(|node| node.origin.region_id.clone())
        .collect();
    assert_eq!(
        order,
        vec![
            "L".to_owned(),
            limit_region_id("p", AxisKind::X, LimitBound::Max),
            limit_region_id("p", AxisKind::Y, LimitBound::Max),
            expression_region_id("p", "t1", TraceAxis::X),
            expression_region_id("p", "t1", TraceAxis::Y),
        ]
    );
}

#[test]
fn an_evaluated_limit_expression_sets_its_axis_end() {
    let spec = plot_with_axes(
        r#"        x: {max: "L/2"}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    let data = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(4.0)),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[3.0, 4.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(
        limits_of(&data, AxisKind::X),
        PlotAxisLimits {
            axis: AxisKind::X,
            min: None,
            max: Some(4.0)
        }
    );
    assert!(data.limit_errors.is_empty(), "{:?}", data.limit_errors);
    // A numeric limit is reported as stored, without an expression behind it.
    assert_eq!(
        limits_of(&data, AxisKind::Y),
        PlotAxisLimits {
            axis: AxisKind::Y,
            min: None,
            max: None
        }
    );
}

#[test]
fn a_failed_limit_expression_is_reported_on_the_plot_and_keeps_the_traces() {
    let spec = plot_with_axes(
        r#"        x: {min: 1, max: "L/2"}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    let data = spec.assemble(
        "p",
        &[
            ExpressionResult::Failed("`L` is not defined".into()),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[3.0, 4.0])),
        ],
        &explicit_scope(),
    );
    // A broken limit never hides the data: the plot is ready and shows the traces.
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces.len(), 1);
    assert_eq!(
        data.limit_errors,
        vec![PlotLimitError {
            axis: AxisKind::X,
            bound: LimitBound::Max,
            expression: "L/2".into(),
            message: "`L` is not defined".into(),
        }]
    );
    // Only the failed end is automatic; the typed minimum stays.
    assert_eq!(
        limits_of(&data, AxisKind::X),
        PlotAxisLimits {
            axis: AxisKind::X,
            min: Some(1.0),
            max: None
        }
    );

    // A value that is not a real scalar is a limit failure too.
    let not_a_scalar = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[3.0, 4.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(not_a_scalar.state, PlotDataState::Ready);
    let error = &not_a_scalar.limit_errors[0];
    assert!(
        error
            .message
            .contains("expected a real number, found a 1x2 matrix"),
        "{}",
        error.message
    );
    assert_eq!(limits_of(&not_a_scalar, AxisKind::X).max, None);

    // Not calculated yet: that end is automatic and nothing is reported.
    let pending = spec.assemble(
        "p",
        &[
            ExpressionResult::Pending,
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[3.0, 4.0])),
        ],
        &explicit_scope(),
    );
    assert!(pending.limit_errors.is_empty());
    assert_eq!(limits_of(&pending, AxisKind::X).max, None);
    // A stale limit still draws the last value.
    let stale = spec.assemble(
        "p",
        &[
            ExpressionResult::Stale(KernelValue::real(4.0)),
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[3.0, 4.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(limits_of(&stale, AxisKind::X).max, Some(4.0));

    // The frame carries the resolved limits and the failures to the renderer.
    let decoded = PlotData::decode_frame(&data.encode_frame()).unwrap();
    assert_eq!(decoded.limits, data.limits);
    assert_eq!(decoded.limit_errors, data.limit_errors);
    assert_eq!(limits_of(&decoded, AxisKind::X).min, Some(1.0));
}

#[test]
fn limits_that_disagree_with_each_other_or_the_axis_are_dropped() {
    let traces = r#"{id: t1, x: "x1", y: "y1"}"#;
    let x_values = || ExpressionResult::Value(vector(&[1.0, 2.0]));

    // the two ends of one axis must be ordered.
    let unordered = plot_with_axes(r#"        x: {min: 5, max: "L/2"}"#, traces);
    let data = unordered.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(3.0)),
            x_values(),
            x_values(),
        ],
        &explicit_scope(),
    );
    assert_eq!(
        limits_of(&data, AxisKind::X),
        PlotAxisLimits {
            axis: AxisKind::X,
            min: None,
            max: None
        },
        "neither end can be trusted"
    );
    assert_eq!(data.limit_errors.len(), 1);
    assert!(data.limit_errors[0]
        .message
        .contains("the minimum must be less than the maximum"));

    // a logarithmic axis takes positive limits only.
    let log = plot_with_axes(r#"        x: {scale: log10, max: "L"}"#, traces);
    let data = log.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(0.0)),
            x_values(),
            x_values(),
        ],
        &explicit_scope(),
    );
    assert_eq!(limits_of(&data, AxisKind::X).max, None);
    assert!(data.limit_errors[0]
        .message
        .contains("a limit on a logarithmic axis must be positive"));

    // two limits with different units, and a limit whose unit differs from the data.
    // A value with a unit: a real magnitude and one base dimension.
    let quantity = |value: f64, base: DimensionBase| KernelValue::Quantity {
        magnitude: QuantityMagnitude::Real {
            value: value.into(),
        },
        dimension: vec![DimensionComponent {
            base,
            power: RationalPower(1, 1),
        }],
    };
    let metres = |value: f64| quantity(value, DimensionBase::Length);
    let seconds = |value: f64| quantity(value, DimensionBase::Time);
    let mixed = plot_with_axes(
        r#"        y: {min: "a", max: "b"}"#,
        r#"{id: t1, x: "x1", y: "y1"}"#,
    );
    let data = mixed.assemble(
        "p",
        &[
            ExpressionResult::Value(metres(1.0)),
            ExpressionResult::Value(seconds(2.0)),
            x_values(),
            x_values(),
        ],
        &explicit_scope(),
    );
    assert_eq!(
        limits_of(&data, AxisKind::Y),
        PlotAxisLimits {
            axis: AxisKind::Y,
            min: None,
            max: None
        }
    );
    assert!(data
        .limit_errors
        .iter()
        .all(|error| error.message.contains("its unit does not match")));
    // A dimensionless limit is usable on any axis: a number never conflicts with a unit.
    let plain = plot_with_axes(r#"        y: {min: "a"}"#, r#"{id: t1, x: "x1", y: "y1"}"#);
    let data = plain.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(1.0)),
            x_values(),
            x_values(),
        ],
        &explicit_scope(),
    );
    assert!(data.limit_errors.is_empty(), "{:?}", data.limit_errors);
    assert_eq!(limits_of(&data, AxisKind::Y).min, Some(1.0));
}

#[test]
fn validation_reports_the_trace_expression_shapes_and_first_error() {
    let spec = spec();
    let ok = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1.0, 2.0, f64::INFINITY])),
            ExpressionResult::Value(vector(&[3.0, f64::NAN, 5.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(ok.state, PlotDataState::Ready);
    assert!(ok.traces[0].x[2].is_nan(), "infinity is stored as a gap");
    assert_eq!(ok.traces[0].finite_points(), 1);

    let unequal = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[1.0, 2.0, 3.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(unequal.state, PlotDataState::Error);
    let error = unequal.error.unwrap();
    assert_eq!((error.trace.as_str(), error.axis), ("t1", TraceAxis::Y));
    assert!(error.message.contains("x has 2 values and y has 3"));
    assert!(unequal.traces.is_empty());

    let scalar = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(1.0)),
            ExpressionResult::Value(vector(&[1.0])),
        ],
        &explicit_scope(),
    );
    let error = scalar.error.unwrap();
    assert_eq!(error.axis, TraceAxis::X);
    assert_eq!(error.expression, "x1");
    assert!(error.message.contains("scalar"), "{}", error.message);

    let matrix = KernelValue::Matrix {
        rows: 2,
        cols: 2,
        storage: MatrixStorage::Inline {
            values: vec![KernelValue::real(1.0); 4],
        },
    };
    let error = spec
        .assemble(
            "p",
            &[
                ExpressionResult::Value(vector(&[1.0])),
                ExpressionResult::Value(matrix),
            ],
            &explicit_scope(),
        )
        .error
        .unwrap();
    assert!(error.message.contains("2x2 matrix"), "{}", error.message);

    let failed = spec.assemble(
        "p",
        &[
            ExpressionResult::Failed("x is undefined".into()),
            ExpressionResult::Value(vector(&[1.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(failed.error.unwrap().message, "x is undefined");

    // Empty vectors are valid and give an empty trace.
    let empty = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[])),
            ExpressionResult::Value(vector(&[])),
        ],
        &explicit_scope(),
    );
    assert_eq!(empty.state, PlotDataState::Ready);
    assert!(empty.traces[0].is_empty());

    let pending = spec.assemble(
        "p",
        &[
            ExpressionResult::Pending,
            ExpressionResult::Value(vector(&[1.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(pending.state, PlotDataState::Pending);
    let stale = spec.assemble(
        "p",
        &[
            ExpressionResult::Stale(vector(&[1.0])),
            ExpressionResult::Value(vector(&[1.0])),
        ],
        &explicit_scope(),
    );
    assert_eq!(stale.state, PlotDataState::Stale);
    assert_eq!(stale.traces.len(), 1, "the last complete data stays");
}

#[test]
fn frames_carry_float64_buffers_and_reject_corruption() {
    let spec = spec();
    let data = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1.0, 2.0, 3.0])),
            ExpressionResult::Value(vector(&[0.5, f64::NAN, -2.0])),
        ],
        &explicit_scope(),
    );
    let frame = data.encode_frame();
    let decoded = PlotData::decode_frame(&frame).unwrap();
    assert_eq!(decoded.traces[0].x, [1.0, 2.0, 3.0]);
    assert!(decoded.traces[0].y[1].is_nan());
    // 4-byte prefix + header + 2 x 3 x 8 payload bytes; no JSON numbers for the arrays.
    let header_len = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
    assert_eq!(frame.len(), 4 + header_len + 48);
    assert!(PlotData::decode_frame(&frame[..frame.len() - 1]).is_err());
    assert!(PlotData::decode_frame(&frame[..2]).is_err());
}

#[test]
fn kernel_evaluates_trace_expressions_and_an_edit_updates_the_plot() {
    let Some(kernel) = kernel() else { return };
    let mut s = session(kernel, SHEET);
    let before = s.plot_data(&root(), "p").unwrap();
    assert_eq!(before.state, PlotDataState::Pending);
    let events = recalc(&mut s);
    let updates = events
        .iter()
        .filter(|event| matches!(event, SessionEvent::PlotUpdated { .. }))
        .count();
    assert!(updates >= 2, "{events:?}");
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x, [0.0, 1.0, 2.0, 3.0, 4.0]);
    assert_eq!(data.traces[0].y, [0.0, 1.0, 4.0, 9.0, 16.0]);
    // Hidden evaluations are not listed with the visible regions.
    assert!(s
        .results()
        .snapshot()
        .iter()
        .all(|entry| !equavela_core::plot::is_expression_region_id(&entry.key.region_id)));

    // changing a definition the y expression resolves to makes the plot stale, and the
    // recalculation replaces the data atomically.
    let stale = s.edit_math(&root(), "f", "f(t) := t^3").unwrap();
    assert!(stale
        .iter()
        .all(|key: &RegionKey| !equavela_core::plot::is_expression_region_id(&key.region_id)));
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Stale);
    assert_eq!(data.traces[0].y, [0.0, 1.0, 4.0, 9.0, 16.0]);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces[0].y, [0.0, 1.0, 8.0, 27.0, 64.0]);
}

#[test]
fn kernel_calculates_a_limit_expression_and_follows_its_definition() {
    let Some(kernel) = kernel() else { return };
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 0..2\"\n  - id: half\n    at: [0, 20]\n    math: \"half := 8\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      axes:\n        x: {max: \"half/2\"}\n      traces: [{id: t1, x: \"x\", y: \"x^2\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(limits_of(&data, AxisKind::X).max, Some(4.0));
    assert!(data.limit_errors.is_empty(), "{:?}", data.limit_errors);
    // A limit is presentation only: the trace data does not change with it.
    assert_eq!(data.traces[0].x, [0.0, 1.0, 2.0]);

    // the limit follows the definition it reads, like any other expression of the plot.
    let stale = s.edit_math(&root(), "half", "half := 2").unwrap();
    assert!(
        stale
            .iter()
            .all(|key: &RegionKey| !is_expression_region_id(&key.region_id)),
        "the hidden limit is not a visible region"
    );
    assert_eq!(
        s.plot_data(&root(), "p").unwrap().state,
        PlotDataState::Stale
    );
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(limits_of(&data, AxisKind::X).max, Some(1.0));
    // No hidden evaluation ever shows up among the visible regions.
    assert!(s
        .results()
        .snapshot()
        .iter()
        .all(|entry| !is_expression_region_id(&entry.key.region_id)));
}

#[test]
fn kernel_reports_a_broken_limit_and_still_draws_the_traces() {
    let Some(kernel) = kernel() else { return };
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 0..2\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      axes:\n        y: {max: \"nope\", min: 1}\n      traces: [{id: t1, x: \"x\", y: \"x^2\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    // The traces still draw: a broken limit is reported, it never becomes a plot-data error.
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces.len(), 1);
    assert_eq!(data.limit_errors.len(), 1, "{:?}", data.limit_errors);
    let error = &data.limit_errors[0];
    assert_eq!((error.axis, error.bound), (AxisKind::Y, LimitBound::Max));
    assert_eq!(error.expression, "nope");
    assert!(!error.message.is_empty());
    // Only the failed end is automatic; the typed minimum stays.
    assert_eq!(
        limits_of(&data, AxisKind::Y),
        PlotAxisLimits {
            axis: AxisKind::Y,
            min: Some(1.0),
            max: None
        }
    );
}

#[test]
fn kernel_evaluates_an_undefined_x_trace_on_the_default_interval() {
    let Some(kernel) = kernel() else { return };
    // An x slot naming an undefined variable, not an empty placeholder.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"sin(x)\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
    assert!((data.traces[0].y[0] - (-10.0_f64).sin()).abs() < 1e-12);
}

#[test]
fn kernel_resamples_a_navigated_plot_and_nothing_else() {
    use equavela_core::plot::ViewRange;
    let Some(kernel) = kernel() else { return };
    // A trace sampled by the plot next to a definition the view must leave alone.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: k\n    at: [0, 0]\n    math: \"k := 2\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"t\", y: \"sin(t)\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
    let before = write_document(s.project().document(&root()).unwrap()).unwrap();

    // panning to -15..5 resamples the trace over that interval.
    assert!(s
        .set_plot_view(&root(), "p", ViewRange::sample(-15.0, 5.0))
        .unwrap());
    assert_eq!(
        s.plot_data(&root(), "p").unwrap().state,
        PlotDataState::Stale,
        "the plot waits for the next pass, the screen keeps the last data"
    );
    let events = recalc(&mut s);
    let started: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::RegionStarted { key } => Some(key.region_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        started,
        vec![
            sampling_region_id("p", "t1"),
            expression_region_id("p", "t1", TraceAxis::Y),
        ],
        "only the plot's own expressions are calculated again"
    );
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-15.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(5.0));
    assert!((data.traces[0].y[0] - (-15.0_f64).sin()).abs() < 1e-12);
    assert!((data.traces[0].y[500] - 5.0_f64.sin()).abs() < 1e-12);

    // the view is not an undo step and never reaches the file.
    assert!(s.undo_label().is_none());
    assert!(s.undo().unwrap().is_none());
    assert_eq!(
        write_document(s.project().document(&root()).unwrap()).unwrap(),
        before
    );

    // The range the plot already has resamples nothing at all.
    assert!(!s
        .set_plot_view(&root(), "p", ViewRange::sample(-15.0, 5.0))
        .unwrap());
    assert_eq!(
        s.plot_data(&root(), "p").unwrap().state,
        PlotDataState::Ready
    );

    // Reset-to-data-range clears it, back to the default interval.
    s.set_plot_view(&root(), "p", None).unwrap();
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
    // A region that is not a plot is refused, not silently ignored.
    assert!(s.set_plot_view(&root(), "k", None).is_err());
}

#[test]
fn kernel_plots_y_over_x_when_the_x_slot_names_x_and_no_x_is_defined() {
    let Some(kernel) = kernel() else { return };
    // the user types `3x` in the y slot and `x` in the x slot of a new plot: the report
    // was "x is undefined" because the x slot was compiled as a worksheet reference.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"3x\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
    let last = data.traces[0].x.len() - 1;
    assert!((data.traces[0].y[0] - 3.0 * data.traces[0].x[0]).abs() < 1e-12);
    assert!((data.traces[0].y[last] - 3.0 * data.traces[0].x[last]).abs() < 1e-12);
}

/// Plot data of a one-plot worksheet whose first trace is `x`, `y` (after optional regions).
#[test]
fn kernel_calculates_an_axis_unit_and_converts_the_axis() {
    let Some(kernel) = kernel() else { return };
    // The y data is a length in SI metres; the axis asks for millimetres.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 1..2\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      axes:\n        y: {unit: mm, max: 0.005}\n      traces: [{id: t1, x: \"x\", y: \"x * 0.001 m@unit\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert!(data.unit_errors.is_empty(), "{:?}", data.unit_errors);
    assert_eq!(
        data.units,
        vec![PlotAxisUnit {
            axis: AxisKind::Y,
            divisor: 0.001
        }]
    );
    assert_eq!(data.traces[0].y, [1.0, 2.0]);
    assert_eq!(limits_of(&data, AxisKind::Y).max, Some(5.0));

    // The unit region never shows up among the visible regions and is not a trace expression.
    assert!(s
        .results()
        .snapshot()
        .iter()
        .all(|entry| !is_expression_region_id(&entry.key.region_id)));
}

#[test]
fn kernel_reports_a_unit_that_is_not_a_unit_and_keeps_the_si_axis() {
    let Some(kernel) = kernel() else { return };
    // `zz` is not a unit name: the unit cannot be calculated, so the axis stays in SI metres and
    // the plot says why instead of guessing a divisor.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 1..2\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      axes:\n        y: {unit: zz}\n      traces: [{id: t1, x: \"x\", y: \"x * 0.001 m@unit\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert!(data.units.is_empty());
    assert_eq!(data.traces[0].y, [0.001, 0.002]);
    assert_eq!(data.unit_errors.len(), 1, "{:?}", data.unit_errors);
    assert_eq!(data.unit_errors[0].axis, AxisKind::Y);
    assert_eq!(data.unit_errors[0].expression, "zz");
    assert!(
        data.unit_errors[0].message.contains("zz is not a unit"),
        "{}",
        data.unit_errors[0].message
    );
}

fn plot_data_of(
    kernel: Arc<KernelManager>,
    before: &str,
    kind: &str,
    x: &str,
    y: &str,
) -> PlotData {
    let yaml = format!(
        "format: equavela-worksheet/3\nregions:{before}\n  - id: p\n    at: [0, 200]\n    plot:\n      type: {kind}\n      traces: [{{id: t1, x: \"{x}\", y: \"{y}\"}}]\n"
    );
    let mut s = session(kernel, &yaml);
    recalc(&mut s);
    s.plot_data(&root(), "p").unwrap()
}

#[test]
fn kernel_draws_unitful_boxplotgraph_with_multiple_data_sets() {
    let Some(kernel) = kernel() else { return };
    let data = plot_data_of(
        kernel,
        "\n  - id: boxes\n    at: [0, 0]\n    math: \"B := boxplotgraph([1,2;2,3;3,4;4,5;100,6]*m@unit)\"",
        "xy",
        "B[0]",
        "B[1]",
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert!(data.unit_errors.is_empty(), "{:?}", data.unit_errors);
    let trace = &data.traces[0];
    assert_eq!(trace.x.len(), trace.y.len());
    assert!(trace.x.iter().any(|x| x.is_nan()));
    assert!(trace.y.iter().any(|y| y.is_nan()));
    assert!(trace.y.contains(&100.0));
    assert!(trace.x.iter().any(|x| *x > 2.0));
}

#[test]
fn kernel_samples_any_undefined_variable_named_in_the_x_slot() {
    let Some(kernel) = kernel() else { return };
    // decision: `x` worked, `t`, `tt` and `xx` did not.
    for name in ["t", "tt", "xx", "ψ", "t_1"] {
        let y = format!("sin({name})");
        let data = plot_data_of(kernel.clone(), "", "xy", name, &y);
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        let trace = &data.traces[0];
        assert_eq!(trace.x.len(), 501, "{name}");
        assert_eq!(trace.x.first().copied(), Some(-10.0), "{name}");
        assert_eq!(trace.x.last().copied(), Some(10.0), "{name}");
        assert!((trace.y[0] - (-10.0_f64).sin()).abs() < 1e-12, "{name}");
        assert!((trace.y[250] - 0.0).abs() < 1e-12, "{name}");
    }
}

#[test]
fn kernel_samples_x_exactly_like_any_other_name() {
    let Some(kernel) = kernel() else { return };
    // .1: the sampled data does not depend on the spelling of the name. `x`, `t`, a
    // literal subscript and a Greek name all produce the same axis and the same y = x line.
    let mut reference: Option<(Vec<f64>, Vec<f64>)> = None;
    for name in ["x", "t", "tt", "xx", "θ", "ψ", "t_1"] {
        let data = plot_data_of(kernel.clone(), "", "xy", name, name);
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        let trace = &data.traces[0];
        assert_eq!(trace.x.len(), 501, "{name}");
        // y = x to within the kernel's range arithmetic (Julia steps the range, Rust multiplies).
        for (x, y) in trace.x.iter().zip(&trace.y) {
            assert!((x - y).abs() < 1e-9, "{name}: y = x ({x} vs {y})");
        }
        match &reference {
            None => reference = Some((trace.x.clone(), trace.y.clone())),
            Some((x, y)) => {
                assert_eq!(&trace.x, x, "{name}: the same sampled axis");
                assert_eq!(&trace.y, y, "{name}: the same values");
            }
        }
    }
    // The same inside a longer expression, and in a polar plot (the angle over one turn).
    for name in ["x", "t", "ψ"] {
        let y = format!("2+cos(3{name})");
        let data = plot_data_of(kernel.clone(), "", "polar", name, &y);
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        assert_eq!(data.traces[0].x.first().copied(), Some(0.0), "{name}");
        assert_eq!(data.traces[0].y[0], 3.0, "{name}");
    }
}

#[test]
fn kernel_does_not_sample_the_y_variable_when_the_x_slot_is_empty() {
    let Some(kernel) = kernel() else { return };
    // decision: `x` in the y slot of a new plot drew a line before an x axis was chosen.
    for y in ["x", "sin(t)", "k*tt"] {
        let data = plot_data_of(kernel.clone(), "", "xy", "", y);
        assert_eq!(data.state, PlotDataState::Error, "{y}: {:?}", data.error);
        let error = data.error.expect("an x-less trace is an error");
        assert_eq!(error.axis, TraceAxis::X, "{y}");
        assert!(
            error.message.contains("x expression is empty"),
            "{y}: {}",
            error.message
        );
        assert!(data.traces.is_empty(), "{y}");
    }
    // A polar trace with an empty angle slot is the same error.
    let polar = plot_data_of(kernel.clone(), "", "polar", "", "2+cos(3x)");
    assert_eq!(polar.state, PlotDataState::Error, "{:?}", polar.error);
    // Naming the variable in the x slot still samples it.
    let data = plot_data_of(kernel, "", "xy", "x", "x");
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].y[0], -10.0);
}

#[test]
fn kernel_uses_a_variable_defined_above_the_plot_without_sampling() {
    let Some(kernel) = kernel() else { return };
    for name in ["t", "tt", "t_1"] {
        let before = format!("\n  - id: a\n    at: [0, 0]\n    math: \"{name} := 0..4\"");
        let y = format!("2{name}");
        let data = plot_data_of(kernel.clone(), &before, "xy", name, &y);
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        assert_eq!(data.traces[0].x, [0.0, 1.0, 2.0, 3.0, 4.0], "{name}");
        assert_eq!(data.traces[0].y, [0.0, 2.0, 4.0, 6.0, 8.0], "{name}");
    }
}

#[test]
fn kernel_samples_a_variable_that_is_only_a_function_parameter_elsewhere() {
    let Some(kernel) = kernel() else { return };
    // `f(t) := t^2` defines the function `f`, not a value `t`.
    let before = "\n  - id: f\n    at: [0, 0]\n    math: \"f(t) := t^2\"";
    let data = plot_data_of(kernel, before, "xy", "t", "f(t)");
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert!((data.traces[0].y[0] - 100.0).abs() < 1e-9);
}

#[test]
fn kernel_samples_a_polar_angle_over_one_turn() {
    let Some(kernel) = kernel() else { return };
    for name in ["θ", "t", "x"] {
        let y = format!("2+cos(3{name})");
        let data = plot_data_of(kernel.clone(), "", "polar", name, &y);
        assert_eq!(data.state, PlotDataState::Ready, "{name}: {:?}", data.error);
        let trace = &data.traces[0];
        assert_eq!(trace.x.len(), 501, "{name}");
        assert_eq!(trace.x.first().copied(), Some(0.0), "{name}");
        assert!(
            (trace.x.last().unwrap() - std::f64::consts::TAU).abs() < 1e-12,
            "{name}"
        );
        assert!((trace.y[0] - 3.0).abs() < 1e-12, "{name}");
    }
}

#[test]
fn kernel_uses_a_worksheet_x_defined_above_the_plot_in_the_x_slot() {
    let Some(kernel) = kernel() else { return };
    // The same two slots, but `x` is a worksheet range: the explicit form is unchanged.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: xs\n    at: [0, 0]\n    math: \"x := 0..4\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"3x\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x, [0.0, 1.0, 2.0, 3.0, 4.0]);
    assert_eq!(data.traces[0].y, [0.0, 3.0, 6.0, 9.0, 12.0]);
}

#[test]
fn defining_x_switches_the_same_trace_between_the_plot_x_and_the_worksheet_x() {
    let Some(kernel) = kernel() else { return };
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: other\n    at: [0, 0]\n    math: \"t := 0..4\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"3x\"}]\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501, "no worksheet x: sampled axis");

    // The worksheet starts defining `x`: the trace now reads the worksheet vector, and the
    // hidden sampling region is gone.
    s.edit_math(&root(), "other", "x := 0..4").unwrap();
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x, [0.0, 1.0, 2.0, 3.0, 4.0]);
    assert_eq!(data.traces[0].y, [0.0, 3.0, 6.0, 9.0, 12.0]);

    // Removing the definition returns to the plot's own x (the reported form again).
    s.edit_math(&root(), "other", "t := 0..4").unwrap();
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
}

#[test]
fn an_x_defined_only_below_the_plot_keeps_the_explicit_form_and_the_ordering_error() {
    let Some(kernel) = kernel() else { return };
    // The scope is project-wide, not per position: a definition below the plot keeps
    // the slots as worksheet expressions, so the trace reports the ordering error instead of
    // silently sampling the axis.
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"x\", y: \"3x\"}]\n  - id: xs\n    at: [0, 300]\n    math: \"x := 0..4\"\n";
    let mut s = session(kernel, yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Error);
    let error = data.error.unwrap();
    assert_eq!(
        (error.trace.as_str(), error.axis, error.expression.as_str()),
        ("t1", TraceAxis::X, "x")
    );
    assert!(
        error.message.contains("x is undefined"),
        "{}",
        error.message
    );
}

#[test]
fn a_definition_below_the_plot_is_not_visible_and_the_error_names_the_trace() {
    let Some(kernel) = kernel() else { return };
    let yaml = SHEET.replace("y: \"f(x)\"", "y: \"late\"");
    assert_ne!(yaml, SHEET);
    let mut s = session(kernel, &yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Error);
    let error = data.error.unwrap();
    assert_eq!(
        (error.trace.as_str(), error.axis, error.expression.as_str()),
        ("t1", TraceAxis::Y, "late")
    );
    // Other worksheet regions still calculate.
    assert!(matches!(
        s.results().get(&RegionKey {
            document: root(),
            region_id: "late".into(),
            instance: 0
        }),
        Some(RegionState::Value { .. })
    ));
}

#[test]
fn a_new_plot_has_empty_placeholders_that_are_not_evaluated() {
    use equavela_core::plot::{PlotRegion, PlotSpec};
    let spec = PlotSpec::new_xy();
    spec.validate().unwrap();
    assert_eq!(spec.traces.len(), 1);
    assert_eq!(spec.size, [360.0, 220.0]);
    // A new trace is hidden from the legend, and the file says so.
    assert!(!spec.traces[0].show_in_legend);
    let region = PlotRegion::new("p", 1, 0.0, 0.0, spec.clone());
    assert!(region.expression_regions(&PlotScope::default()).is_empty());
    assert_eq!(
        spec.assemble("p", &[], &PlotScope::default()).state,
        PlotDataState::Pending,
        "nothing to draw yet"
    );
}

#[test]
fn long_traces_are_reduced_to_min_max_buckets_in_order() {
    use equavela_core::plot::TraceData;
    let n = 1_000;
    let mut trace = TraceData {
        z: None,
        id: "t".into(),
        x: (0..n).map(|i| i as f64).collect(),
        y: (0..n).map(|i| ((i as f64) / 10.0).sin()).collect(),
        x_dimension: vec![],
        y_dimension: vec![],
        downsampled_from: None,
    };
    trace.y[500] = 50.0; // a spike must survive
    let before = trace.clone();
    trace.reduce_for_display(2_000, 10);
    assert_eq!(trace, before, "below the threshold nothing changes");
    trace.reduce_for_display(100, 10);
    assert!(trace.len() <= 20 && trace.len() >= 10, "{}", trace.len());
    assert_eq!(trace.downsampled_from, Some(n));
    assert!(trace.y.contains(&50.0));
    assert!(trace.x.windows(2).all(|w| w[0] < w[1]), "worksheet order");
}

/// an expression x limit drives the sample of an implicit x.
/// The hidden sampling definition is written with the limit
/// expressions, and the drawn x vector uses their calculated values.
#[test]
fn expression_x_limits_drive_the_sample_of_an_implicit_x() {
    let spec = plot_with_axes(
        r#"        x: {min: "-π/ω", max: "π/ω"}"#,
        r#"{id: t1, x: "t", y: "sin(ω·t)"}"#,
    );
    let scope = PlotScope::defining(["ω"]);
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes:\n        x: {min: \"-π/ω\", max: \"π/ω\"}\n      traces: [{id: t1, x: \"t\", y: \"sin(ω·t)\"}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(plot) = loaded.document.regions[0].as_ref() else {
        panic!("a plot");
    };
    let regions = plot.expression_regions(&scope);
    let sampling = regions
        .iter()
        .find(|region| region.id == sampling_region_id("p", "t1"))
        .expect("a sampling region");
    let text = equavela_core::syntax::print_statement(&sampling.statement);
    assert!(
        text.ends_with(":= (-π/ω), (-π/ω) + ((π/ω) - (-π/ω))/500..(π/ω)"),
        "{text}"
    );

    // Calculated limits ±2 (SI): the drawn x runs over them, 501 points.
    let data = spec.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(-2.0)),
            ExpressionResult::Value(KernelValue::real(2.0)),
            ExpressionResult::Value(vector(&vec![0.0; 501])),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(data.traces[0].x.len(), 501);
    assert_eq!(data.traces[0].x.first().copied(), Some(-2.0));
    assert_eq!(data.traces[0].x.last().copied(), Some(2.0));
}

#[test]
fn contour_explicit_grid_golden() {
    let yaml = "format: equavela-worksheet/2\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: contour\n      traces:\n        - {id: t, x: xs, y: ys, z: zs}\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!()
    };
    assert_eq!(region.expression_regions(&PlotScope::default()).len(), 3);
    let matrix = |rows, cols, values: &[f64]| KernelValue::Matrix {
        rows,
        cols,
        storage: MatrixStorage::Inline {
            values: values.iter().map(|v| KernelValue::real(*v)).collect(),
        },
    };
    // Asymmetric 2x3 grid, column-major: rows [1, 2, 3] and [10, 20, 30].
    let results = vec![
        ExpressionResult::Value(matrix(3, 1, &[0., 2., 5.])),
        ExpressionResult::Value(matrix(2, 1, &[0., 4.])),
        ExpressionResult::Value(matrix(2, 3, &[1., 10., 2., 20., 3., 30.])),
    ];
    let data = region.plot.assemble("p", &results, &PlotScope::default());
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(
        data.traces[0].z.as_ref().unwrap().values,
        vec![1., 10., 2., 20., 3., 30.]
    );
    assert_eq!(PlotData::decode_frame(&data.encode_frame()).unwrap(), data);
    let written = write_document(&loaded.document).unwrap();
    let roundtrip = parse_document(root(), &written).unwrap();
    assert_eq!(roundtrip.document.regions, loaded.document.regions);
    let mut bad = results;
    bad[2] = ExpressionResult::Value(matrix(3, 2, &[1., 2., 3., 4., 5., 6.]));
    let failed = region.plot.assemble("p", &bad, &PlotScope::default());
    assert_eq!(failed.state, PlotDataState::Error);
    assert!(failed.traces.is_empty());
    assert_eq!(failed.error.unwrap().axis.as_str(), "z");
}

// Hand-authored golden: 's provisional orientation, not the reference application evidence.
const CONTOUR: &str = "format: equavela-worksheet/2\nregions:\n  - id: p\n    at: [0, 60]\n    plot:\n      type: contour\n      traces:\n        - {id: t1, x: '[1, 3, 7]', y: '[10, 20]', z: '[11, 12, 13; 21, 22, 23]'}\n";

#[test]
fn contour_golden_grid_roundtrips_and_evaluates_all_three_expressions() {
    let loaded = parse_document(root(), CONTOUR).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!()
    };
    let scope = PlotScope::default();
    let regions = region.expression_regions(&scope);
    assert_eq!(regions.len(), 3);
    assert!(regions[2].id.ends_with("z"));
    let z = KernelValue::Matrix {
        rows: 2,
        cols: 3,
        storage: MatrixStorage::Inline {
            values: [11., 21., 12., 22., 13., 23.]
                .into_iter()
                .map(KernelValue::real)
                .collect(),
        },
    };
    let data = region.plot.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1., 3., 7.])),
            ExpressionResult::Value(vector(&[10., 20.])),
            ExpressionResult::Value(z),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(
        (
            data.traces[0].z.as_ref().unwrap().rows,
            data.traces[0].z.as_ref().unwrap().cols
        ),
        (2, 3)
    );
    assert_eq!(
        data.traces[0].z.as_ref().map(|z| z.values.as_slice()),
        Some([11., 21., 12., 22., 13., 23.].as_slice())
    );
    assert_eq!(PlotData::decode_frame(&data.encode_frame()).unwrap(), data);
    let written = write_document(&loaded.document).unwrap();
    let again = parse_document(root(), &written).unwrap();
    assert_eq!(again.document.regions, loaded.document.regions);
}

#[test]
fn contour_rejects_wrong_shape_and_nonmonotone_grid_atomically() {
    let loaded = parse_document(root(), CONTOUR).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!()
    };
    for (x, z, axis) in [
        (vector(&[1., 3., 7.]), vector(&[1., 2.]), "z"),
        (vector(&[1., 1., 7.]), vector(&[1., 2.]), "x"),
    ] {
        let data = region.plot.assemble(
            "p",
            &[
                ExpressionResult::Value(x),
                ExpressionResult::Value(vector(&[10., 20.])),
                ExpressionResult::Value(z),
            ],
            &PlotScope::default(),
        );
        assert_eq!(data.state, PlotDataState::Error);
        assert!(data.traces.is_empty());
        assert_eq!(data.error.unwrap().axis.as_str(), axis);
    }
}

#[test]
fn reference_lines_roundtrip_evaluate_and_keep_their_order_in_the_frame() {
    let yaml = r##"format: equavela-worksheet/3
regions:
  - id: p
    at: [0, 0]
    plot:
      type: xy
      traces: [{id: t1, x: x1, y: y1}]
      reference_lines:
        - {id: ref-1, axis: x, value: x0, line: {style: dash, width: 2, color: "#778899"}, show_in_legend: true, legend_label: Setpoint}
        - {id: ref-2, axis: "y", value: 3}
"##;
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!("expected plot");
    };
    let scope = PlotScope::defining(["x0", "x1", "y1"]);
    let expressions = region.expression_regions(&scope);
    assert_eq!(expressions.len(), 3);
    assert_eq!(expressions[0].id, reference_line_region_id("p", "ref-1"));
    assert!(expressions[1].id.ends_with("x"));
    assert!(expressions[2].id.ends_with("y"));

    let data = region.plot.assemble(
        "p",
        &[
            ExpressionResult::Value(KernelValue::real(2.0)),
            ExpressionResult::Value(vector(&[0.0, 1.0, 2.0])),
            ExpressionResult::Value(vector(&[1.0, 2.0, 3.0])),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces.len(), 1);
    assert_eq!(
        data.reference_lines
            .iter()
            .map(|line| line.value)
            .collect::<Vec<_>>(),
        [2.0, 3.0]
    );
    assert_eq!(data.reference_lines[0].axis, AxisKind::X);
    assert_eq!(data.reference_lines[1].axis, AxisKind::Y);
    assert!(data.reference_line_errors.is_empty());
    assert_eq!(PlotData::decode_frame(&data.encode_frame()).unwrap(), data);

    let written = write_document(&loaded.document).unwrap();
    assert!(written.contains("reference_lines:"), "{written}");
    assert!(written.contains("axis: x, value: \"x0\""), "{written}");
    assert!(written.contains("show_in_legend: true"), "{written}");
    let roundtrip = parse_document(root(), &written).unwrap();
    assert_eq!(roundtrip.document.regions, loaded.document.regions);
}

#[test]
fn a_bad_reference_line_value_does_not_hide_valid_traces() {
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: x1, y: y1}]\n      reference_lines: [{id: ref-1, axis: x, value: x0}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!("expected plot");
    };
    let scope = PlotScope::defining(["x0", "x1", "y1"]);
    let data = region.plot.assemble(
        "p",
        &[
            ExpressionResult::Value(vector(&[1.0, 2.0])),
            ExpressionResult::Value(vector(&[0.0, 1.0])),
            ExpressionResult::Value(vector(&[4.0, 5.0])),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.traces.len(), 1);
    assert!(data.reference_lines.is_empty());
    assert_eq!(data.reference_line_errors.len(), 1);
    assert!(data.reference_line_errors[0]
        .message
        .contains("real number"));
}

#[test]
fn a_unitful_reference_line_uses_the_axis_display_unit() {
    let yaml = "format: equavela-worksheet/3\nregions:\n  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      axes: {y: {unit: mm}}\n      traces: [{id: t1, x: x1, y: y1}]\n      reference_lines: [{id: ref-1, axis: \"y\", value: level}]\n";
    let loaded = parse_document(root(), yaml).unwrap();
    let DocumentRegion::Plot(region) = loaded.document.regions[0].as_ref() else {
        panic!("expected plot");
    };
    let scope = PlotScope::defining(["level", "x1", "y1"]);
    let data = region.plot.assemble(
        "p",
        &[
            ExpressionResult::Value(unit_value(0.001, DimensionBase::Length)),
            ExpressionResult::Value(unit_value(0.002, DimensionBase::Length)),
            ExpressionResult::Value(vector(&[0.0, 1.0])),
            ExpressionResult::Value(quantity_vector(&[0.001, 0.003], DimensionBase::Length)),
        ],
        &scope,
    );
    assert_eq!(data.state, PlotDataState::Ready);
    assert_eq!(data.reference_lines[0].value, 2.0);
    assert_eq!(data.reference_lines[0].axis, AxisKind::Y);
    assert!(data.reference_line_errors.is_empty());
}

#[test]
fn contour_kernel_grid_recalculates_when_z_changes() {
    let Some(kernel) = kernel() else {
        return;
    };
    let yaml = CONTOUR
        .replace(
            "  - id: p",
            "  - id: zs\n    at: [0, 0]\n    math: 'Z := [11, 12, 13; 21, 22, 23]'\n  - id: p",
        )
        .replace("z: '[11, 12, 13; 21, 22, 23]'", "z: 'Z'");
    let mut s = session(kernel, &yaml);
    recalc(&mut s);
    let data = s.plot_data(&root(), "p").unwrap();
    assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
    assert_eq!(
        data.traces[0].z.as_ref().unwrap().values,
        [11., 21., 12., 22., 13., 23.]
    );
    s.edit_math(&root(), "zs", "Z := [1, 2, 3; 4, 5, 6]")
        .unwrap();
    assert_eq!(
        s.plot_data(&root(), "p").unwrap().state,
        PlotDataState::Stale
    );
    recalc(&mut s);
    let updated = s.plot_data(&root(), "p").unwrap();
    assert_eq!(updated.state, PlotDataState::Ready);
    assert_eq!(
        updated.traces[0].z.as_ref().unwrap().values,
        [1., 4., 2., 5., 3., 6.]
    );
}
