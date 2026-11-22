use equavela_core::graph::{DependencyGraph, Region, Worksheet};
use equavela_core::parse_statement;

fn region(id: &str, page: u32, x: f64, y: f64, math: &str) -> Region {
    Region {
        id: id.to_owned(),
        page,
        x,
        y,
        enabled: true,
        statement: std::sync::Arc::new(parse_statement(math).unwrap()),
    }
}

fn graph(regions: Vec<Region>) -> DependencyGraph {
    DependencyGraph::build(&Worksheet { regions }).unwrap()
}

#[test]
fn orders_regions_by_page_top_left_and_id() {
    let graph = graph(vec![
        region("z", 1, 20.0, 10.0, "z := 1"),
        region("b", 0, 20.0, 10.0, "b := 1"),
        region("a", 0, 20.0, 10.0, "a := 1"),
        region("left", 0, 10.0, 10.0, "left := 1"),
        region("top", 0, 30.0, 5.0, "top := 1"),
    ]);

    assert_eq!(graph.evaluation_order(), ["top", "left", "a", "b", "z"]);
}

#[test]
fn resolves_only_definitions_visible_at_the_use() {
    let graph = graph(vec![
        region("x1", 0, 0.0, 0.0, "x := 1"),
        region("y", 0, 0.0, 1.0, "y := x + missing"),
        region("x2", 0, 0.0, 2.0, "x := 2"),
        region("z", 0, 0.0, 3.0, "z := x + y"),
    ]);

    assert_eq!(graph.dependencies_of("y").unwrap(), ["x1"]);
    assert_eq!(graph.dependencies_of("z").unwrap(), ["y", "x2"]);
    assert_eq!(
        graph
            .unresolved_references()
            .iter()
            .map(|reference| (reference.region_id.as_str(), reference.name.as_simple()))
            .collect::<Vec<_>>(),
        [("y", Some("missing"))]
    );
}

#[test]
fn recalculates_transitive_dependents_of_the_exact_definition_version() {
    let graph = graph(vec![
        region("x1", 0, 0.0, 0.0, "x := 1"),
        region("y", 0, 0.0, 1.0, "y := x + 1"),
        region("x2", 0, 0.0, 2.0, "x := 2"),
        region("z", 0, 0.0, 3.0, "z := x + y"),
        region("out", 0, 0.0, 4.0, "z ="),
    ]);

    assert_eq!(graph.affected_by(["x1"]).unwrap(), ["x1", "y", "z", "out"]);
    assert_eq!(graph.affected_by(["x2"]).unwrap(), ["x2", "z", "out"]);
}

#[test]
fn function_captures_names_at_its_definition_point() {
    let graph = graph(vec![
        region("a1", 0, 0.0, 0.0, "a := 1"),
        region("f", 0, 0.0, 1.0, "f(x) := x + a"),
        region("a2", 0, 0.0, 2.0, "a := 2"),
        region("call", 0, 0.0, 3.0, "f(a) ="),
    ]);

    assert_eq!(graph.dependencies_of("f").unwrap(), ["a1"]);
    assert_eq!(graph.dependencies_of("call").unwrap(), ["f", "a2"]);
    assert_eq!(graph.affected_by(["a1"]).unwrap(), ["a1", "f", "call"]);
}

#[test]
fn resolves_contextual_and_explicit_variable_and_function_labels() {
    let graph = graph(vec![
        region("var", 0, 0.0, 0.0, "f := 3"),
        region("fn", 0, 0.0, 1.0, "f(x) := x + 1"),
        region("value", 0, 0.0, 2.0, "f@var ="),
        region("call", 0, 0.0, 3.0, "f@fn(2) ="),
        region("context_value", 0, 0.0, 4.0, "f ="),
        region("context_call", 0, 0.0, 5.0, "f(2) ="),
    ]);

    assert_eq!(graph.dependencies_of("value").unwrap(), ["var"]);
    assert_eq!(graph.dependencies_of("call").unwrap(), ["fn"]);
    assert_eq!(graph.dependencies_of("context_value").unwrap(), ["var"]);
    assert_eq!(graph.dependencies_of("context_call").unwrap(), ["fn"]);
}

#[test]
fn recursive_function_does_not_depend_on_an_external_self_name() {
    let graph = graph(vec![region("f", 0, 0.0, 0.0, "f(n) := f(n - 1)")]);

    assert!(graph.dependencies_of("f").unwrap().is_empty());
    assert!(graph.unresolved_references().is_empty());
}

#[test]
fn program_locals_and_binders_are_not_worksheet_dependencies() {
    let graph = graph(vec![
        region("sheet", 0, 0.0, 0.0, "sheet := 4"),
        region(
            "f",
            0,
            0.0,
            1.0,
            "f(n) := program\n  total \u{2190} sheet\n  for i \u{2208} 1..n\n    total \u{2190} total + i\n  total",
        ),
    ]);

    assert_eq!(graph.dependencies_of("f").unwrap(), ["sheet"]);
    assert!(graph.unresolved_references().is_empty());
}

#[test]
fn global_definition_is_visible_above_and_an_ordinary_definition_overrides_it() {
    let graph = graph(vec![
        region("before", 0, 0.0, 0.0, "before := g"),
        region("global", 0, 0.0, 1.0, "g \u{2261} 1"),
        region("local", 0, 0.0, 2.0, "g := 2"),
        region("after", 0, 0.0, 3.0, "after := g"),
    ]);

    assert_eq!(
        graph.evaluation_order(),
        ["global", "before", "local", "after"]
    );
    assert_eq!(graph.dependencies_of("before").unwrap(), ["global"]);
    assert_eq!(graph.dependencies_of("after").unwrap(), ["local"]);
}

#[test]
fn indexed_assignment_reads_the_previous_value_when_one_exists() {
    let graph = graph(vec![
        region("v1", 0, 0.0, 0.0, "v := [1; 2]"),
        region("i", 0, 0.0, 1.0, "i := 1"),
        region("v2", 0, 0.0, 2.0, "v[i] := 3"),
        region("use", 0, 0.0, 3.0, "v ="),
    ]);

    assert_eq!(graph.dependencies_of("v2").unwrap(), ["v1", "i"]);
    assert_eq!(graph.dependencies_of("use").unwrap(), ["v2"]);
}

#[test]
fn disabled_definition_is_neither_scheduled_nor_visible() {
    let mut disabled = region("x", 0, 0.0, 0.0, "x := 1");
    disabled.enabled = false;
    let graph = graph(vec![disabled, region("use", 0, 0.0, 1.0, "x =")]);

    assert_eq!(graph.evaluation_order(), ["use"]);
    assert!(graph.dependencies_of("use").unwrap().is_empty());
    assert_eq!(graph.unresolved_references().len(), 1);
    assert!(graph.affected_by(["x"]).unwrap().is_empty());
}

#[test]
fn worksheet_document_round_trips_as_json() {
    let worksheet = Worksheet {
        regions: vec![region("r1", 2, 12.5, 18.25, "x := 1")],
    };

    let json = serde_json::to_string(&worksheet).unwrap();
    let decoded: Worksheet = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, worksheet);
}

#[test]
fn rejects_duplicate_ids_and_non_finite_coordinates() {
    let duplicate = Worksheet {
        regions: vec![
            region("same", 0, 0.0, 0.0, "x := 1"),
            region("same", 0, 0.0, 1.0, "y := 1"),
        ],
    };
    assert!(DependencyGraph::build(&duplicate).is_err());

    let invalid = Worksheet {
        regions: vec![region("bad", 0, f64::NAN, 0.0, "x := 1")],
    };
    assert!(DependencyGraph::build(&invalid).is_err());
}

#[test]
fn failure_propagates_to_transitive_dependents_only() {
    use equavela_core::graph::FailureTracker;
    let graph = graph(vec![
        region("a", 0, 0.0, 0.0, "a := 1"),
        region("b", 0, 0.0, 1.0, "b := a + 1"),
        region("c", 0, 0.0, 2.0, "c := b + 1"),
        region("d", 0, 0.0, 3.0, "d := 5"),
        region("e", 0, 0.0, 4.0, "e := c + d"),
        region("show", 0, 0.0, 5.0, "d ="),
    ]);
    let mut tracker = FailureTracker::new(&graph);
    assert_eq!(tracker.mark_blocked("a"), None);
    tracker.mark_failed("a").unwrap();
    assert_eq!(
        tracker.mark_blocked("b").as_deref(),
        Some("depends on failed region a")
    );
    // c depends on b, which is recorded as failed: the failure is transitive.
    assert_eq!(
        tracker.mark_blocked("c").as_deref(),
        Some("depends on failed region b")
    );
    assert_eq!(tracker.mark_blocked("d"), None);
    assert_eq!(
        tracker.mark_blocked("e").as_deref(),
        Some("depends on failed region c")
    );
    assert_eq!(tracker.mark_blocked("show"), None);
    assert!(tracker.is_failed("e"));
    assert!(!tracker.is_failed("d"));
}

#[test]
fn blocker_reports_the_first_failed_producer_in_evaluation_order() {
    use equavela_core::graph::FailureTracker;
    let graph = graph(vec![
        region("x", 0, 0.0, 0.0, "x := 1"),
        region("y", 0, 0.0, 1.0, "y := 2"),
        region("z", 0, 0.0, 2.0, "z := x + y"),
    ]);
    let mut tracker = FailureTracker::new(&graph);
    tracker.mark_failed("y").unwrap();
    tracker.mark_failed("x").unwrap();
    assert_eq!(tracker.blocker("z"), Some("x"));
    assert!(tracker.mark_failed("nope").is_err());
}

#[test]
fn redefinition_after_a_failure_is_not_blocked() {
    use equavela_core::graph::FailureTracker;
    let graph = graph(vec![
        region("x1", 0, 0.0, 0.0, "x := 1"),
        region("x2", 0, 0.0, 1.0, "x := 2"),
        region("use", 0, 0.0, 2.0, "u := x"),
    ]);
    let mut tracker = FailureTracker::new(&graph);
    tracker.mark_failed("x1").unwrap();
    // `use` reads version 2 of x, not the failed version 1.
    assert_eq!(tracker.mark_blocked("use"), None);
}

#[test]
fn root_with_an_interval_binds_its_unknown() {
    let graph = graph(vec![
        region("x1", 0, 0.0, 0.0, "x := 7"),
        region("a", 0, 0.0, 1.0, "a := root(x - k, x, 0, 10)"),
        region("b", 0, 0.0, 2.0, "b := root(x - 1, x)"),
    ]);
    // interval form: `x` is bound inside the expression, so it is not a dependency
    // (`k` is a real unresolved name); the guess form reads `x`
    assert!(graph.dependencies_of("a").unwrap().is_empty());
    assert_eq!(graph.dependencies_of("b").unwrap(), ["x1"]);
    let unresolved: Vec<_> = graph
        .unresolved_references()
        .iter()
        .filter(|reference| reference.region_id == "a")
        .map(|reference| reference.name.as_simple())
        .collect();
    assert_eq!(unresolved, [Some("root"), Some("k")]);
}

/// the specification : a plain name is never a unit, so `2 L` reads the variable `L`
/// and depends on its definition — while `2 L@unit` is a name of its own, a unit, and reaches the
/// unit-labelled definition of the same spelling, not the variable.
#[test]
fn a_plain_unit_like_name_is_a_reference_to_the_variable() {
    let sheet = graph(vec![
        region("def", 0, 0.0, 0.0, "L := 3"),
        region("use", 0, 0.0, 1.0, "y := 2 L"),
        region("unitdef", 0, 0.0, 2.0, "L@unit := 4"),
        region("unit", 0, 0.0, 3.0, "z := 2 L@unit"),
    ]);

    assert_eq!(sheet.dependencies_of("use").unwrap(), ["def"]);
    // the labelled reference is the unit-labelled definition, never the variable
    assert_eq!(sheet.dependencies_of("unit").unwrap(), ["unitdef"]);
    // a plain unit-like name that nothing defines is an unresolved name like any other
    let alone = graph(vec![region("only", 0, 0.0, 0.0, "y := 2 L")]);
    assert_eq!(
        alone
            .unresolved_references()
            .iter()
            .map(|reference| reference.name.as_simple())
            .collect::<Vec<_>>(),
        [Some("L")]
    );
}
