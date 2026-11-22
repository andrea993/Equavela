use equavela_core::dimensions::{
    analyze_dimensions, Dimension, DimensionFact, DimensionOperation, DimensionWarningKind,
};
use equavela_core::graph::{Region, Worksheet};
use equavela_core::parse_statement;

fn region(id: &str, y: f64, source: &str) -> Region {
    Region {
        id: id.to_owned(),
        page: 0,
        x: 0.0,
        y,
        enabled: true,
        statement: std::sync::Arc::new(parse_statement(source).unwrap()),
    }
}

fn analyze(regions: Vec<Region>) -> equavela_core::dimensions::DimensionalAnalysis {
    analyze_dimensions(&Worksheet { regions }).unwrap()
}

#[test]
fn infers_definitions_through_multiplication_and_division() {
    let analysis = analyze(vec![
        region("distance", 0.0, "distance := 3 m@unit"),
        region("time", 1.0, "time := 2 s@unit"),
        region("speed", 2.0, "speed := distance / time"),
    ]);

    let speed = Dimension::length().divided_by(&Dimension::time());
    assert_eq!(
        analysis.dimension_of("speed"),
        Some(&DimensionFact::Scalar(speed))
    );
    assert!(analysis.warnings().is_empty());
}

#[test]
fn warns_for_proven_incompatible_addition_and_comparison() {
    let analysis = analyze(vec![
        region("add", 0.0, "x := 1 m@unit + 1 s@unit"),
        region("compare", 1.0, "1 kg@unit < 2 m@unit ="),
    ]);

    assert_eq!(analysis.warnings().len(), 2);
    assert!(matches!(
        analysis.warnings()[0].kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::Add,
            ..
        }
    ));
    assert!(matches!(
        analysis.warnings()[1].kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::Compare,
            ..
        }
    ));
}

#[test]
fn rational_powers_and_roots_transform_dimensions() {
    let analysis = analyze(vec![
        region("area", 0.0, "area := (2 m@unit)^2"),
        region("root", 1.0, "side := √area"),
        region("fractional", 2.0, "side2 := area^0.5"),
    ]);

    assert_eq!(
        analysis.dimension_of("area"),
        Some(&DimensionFact::Scalar(Dimension::length().powered(2, 1)))
    );
    assert_eq!(
        analysis.dimension_of("root"),
        Some(&DimensionFact::Scalar(Dimension::length()))
    );
    assert_eq!(
        analysis.dimension_of("fractional"),
        analysis.dimension_of("root")
    );
    assert!(analysis.warnings().is_empty());
}

#[test]
fn checks_dimensionless_builtin_arguments_and_user_function_returns() {
    let analysis = analyze(vec![
        region("function", 0.0, "square(x) := x^2"),
        region("call", 1.0, "area := square(3 m@unit)"),
        region("trig", 2.0, "bad := sin(2 s@unit)"),
    ]);

    assert_eq!(
        analysis.dimension_of("call"),
        Some(&DimensionFact::Scalar(Dimension::length().powered(2, 1)))
    );
    assert!(analysis.warnings().iter().any(|warning| matches!(
        warning.kind,
        DimensionWarningKind::ExpectedDimensionless {
            operation: DimensionOperation::FunctionArgument,
            ..
        }
    )));
}

#[test]
fn matrices_keep_per_element_dimensions() {
    let analysis = analyze(vec![
        region("left", 0.0, "A := [1 m@unit, 2 s@unit]"),
        region("right", 1.0, "B := [3 m@unit, 4 s@unit]"),
        region("ok", 2.0, "C := A + B"),
        region("bad", 3.0, "D := A + [1 s@unit, 2 s@unit]"),
    ]);

    assert!(matches!(
        analysis.dimension_of("ok"),
        Some(DimensionFact::Matrix {
            rows: 1,
            cols: 2,
            ..
        })
    ));
    assert_eq!(
        analysis
            .warnings()
            .iter()
            .filter(|warning| warning.region_id == "bad")
            .count(),
        1
    );
}

#[test]
fn ranges_require_compatible_start_step_and_end() {
    let analysis = analyze(vec![region(
        "range",
        0.0,
        "r := 0 m@unit, 1 s@unit..10 m@unit",
    )]);

    assert!(analysis.warnings().iter().any(|warning| matches!(
        warning.kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::Range,
            ..
        }
    )));
}

#[test]
fn unit_overrides_are_checked_without_stopping_analysis() {
    let analysis = analyze(vec![
        region("value", 0.0, "distance := 2 m@unit"),
        region("display", 1.0, "distance = … s@unit"),
        region("later", 2.0, "later := distance + 1 m@unit"),
    ]);

    assert!(analysis.warnings().iter().any(|warning| matches!(
        warning.kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::UnitOverride,
            ..
        }
    )));
    assert_eq!(
        analysis.dimension_of("later"),
        Some(&DimensionFact::Scalar(Dimension::length()))
    );
}

#[test]
fn unknown_dimensions_do_not_create_false_warnings() {
    let analysis = analyze(vec![
        region("unknown", 0.0, "x := package_value + 1 m@unit"),
        region("julia", 1.0, "y := Pkg::f(x) + 1 s@unit"),
    ]);

    assert_eq!(
        analysis.dimension_of("unknown"),
        Some(&DimensionFact::Unknown)
    );
    assert_eq!(
        analysis.dimension_of("julia"),
        Some(&DimensionFact::Unknown)
    );
    assert!(analysis.warnings().is_empty());
}

#[test]
fn disabled_regions_are_not_analyzed() {
    let mut disabled = region("disabled", 0.0, "x := 1 m@unit + 1 s@unit");
    disabled.enabled = false;
    let analysis = analyze(vec![disabled, region("live", 1.0, "y := 1 m@unit")]);

    assert_eq!(analysis.dimension_of("disabled"), None);
    assert!(analysis.warnings().is_empty());
}

#[test]
fn follows_the_exact_definition_version_across_redefinitions() {
    let analysis = analyze(vec![
        region("length", 0.0, "x := 1 m@unit"),
        region("bad", 1.0, "before := x + 1 s@unit"),
        region("time", 2.0, "x := 2 s@unit"),
        region("good", 3.0, "after := x + 1 s@unit"),
    ]);

    assert_eq!(
        analysis
            .warnings()
            .iter()
            .filter(|warning| warning.region_id == "bad")
            .count(),
        1
    );
    assert!(analysis
        .warnings()
        .iter()
        .all(|warning| warning.region_id != "good"));
    assert_eq!(
        analysis.dimension_of("good"),
        Some(&DimensionFact::Scalar(Dimension::time()))
    );
}

#[test]
fn root_index_must_be_dimensionless() {
    let analysis = analyze(vec![region("root", 0.0, "x := √[2 s@unit](4 m@unit)")]);

    assert!(analysis.warnings().iter().any(|warning| matches!(
        warning.kind,
        DimensionWarningKind::ExpectedDimensionless {
            operation: DimensionOperation::FunctionArgument,
            ..
        }
    )));
    assert_eq!(analysis.dimension_of("root"), Some(&DimensionFact::Unknown));
}

#[test]
fn physical_constants_have_their_dimensions() {
    let analysis = analyze(vec![
        region("speed", 0.0, "speed := c"),
        region("tail", 1.0, "t := α + 1"),
        region("bad", 2.0, "bad := e.c + 1 m@unit"),
    ]);
    let speed = Dimension::length().divided_by(&Dimension::time());
    assert_eq!(
        analysis.dimension_of("speed"),
        Some(&DimensionFact::Scalar(speed))
    );
    // `α` is dimensionless, so adding 1 is fine; a charge plus a length is flagged
    assert_eq!(analysis.warnings().len(), 1);
}

/// the specification : a plain name is a unit only inside a unit context. The override
/// is one, so its dimension is proved and the mismatch reported; a plain name in a value position is
/// an ordinary name, so `1 m` there says nothing about dimensions.
#[test]
fn a_plain_name_is_a_unit_only_in_a_unit_context() {
    let analysis = analyze(vec![
        region("value", 0.0, "distance := 2 m@unit"),
        region("display", 1.0, "distance = … s"),
    ]);
    assert!(analysis.warnings().iter().any(|warning| matches!(
        warning.kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::UnitOverride,
            ..
        }
    )));

    let analysis = analyze(vec![
        region("value", 0.0, "distance := 2 m@unit"),
        region("plain", 1.0, "other := distance + 1 m"),
        region("labelled", 2.0, "third := distance + 1 m@unit"),
    ]);
    assert!(analysis.warnings().is_empty(), "{:?}", analysis.warnings());
    assert_eq!(
        analysis.dimension_of("plain"),
        Some(&DimensionFact::Unknown)
    );
    assert_eq!(
        analysis.dimension_of("labelled"),
        Some(&DimensionFact::Scalar(Dimension::length()))
    );
}
