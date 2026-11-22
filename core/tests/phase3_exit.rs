use equavela_core::dimensions::{analyze_dimensions, DimensionOperation, DimensionWarningKind};
use equavela_core::graph::{DependencyGraph, Region, Worksheet};
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

#[test]
fn json_document_is_ordered_linked_and_dimensionally_checked() {
    let source = Worksheet {
        regions: vec![
            region("result", 4.0, "speed ="),
            region("distance", 1.0, "distance := 30 m@unit"),
            region("bad", 3.0, "bad := distance + time"),
            region("time", 0.0, "time := 2 s@unit"),
            region("speed", 2.0, "speed := distance / time"),
        ],
    };

    // JSON is the phase-3 editor/core boundary. Analyze only the deserialized value.
    let json = serde_json::to_string(&source).unwrap();
    let worksheet: Worksheet = serde_json::from_str(&json).unwrap();
    let graph = DependencyGraph::build(&worksheet).unwrap();
    let dimensions = analyze_dimensions(&worksheet).unwrap();

    assert_eq!(
        graph.evaluation_order(),
        ["time", "distance", "speed", "bad", "result"]
    );
    assert_eq!(
        graph.dependencies_of("speed").unwrap(),
        ["time", "distance"]
    );
    assert_eq!(graph.dependencies_of("result").unwrap(), ["speed"]);
    assert_eq!(
        graph.affected_by(["distance"]).unwrap(),
        ["distance", "speed", "bad", "result"]
    );
    assert_eq!(dimensions.warnings().len(), 1);
    assert_eq!(dimensions.warnings()[0].region_id, "bad");
    assert!(matches!(
        dimensions.warnings()[0].kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::Add,
            ..
        }
    ));

    // A warning does not remove the region or stop downstream structural analysis.
    assert!(dimensions.dimension_of("result").is_some());
}
