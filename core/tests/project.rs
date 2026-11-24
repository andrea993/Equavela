use equavela_core::dimensions::{DimensionOperation, DimensionWarningKind};
use equavela_core::graph::Region;
use equavela_core::parse_statement;
use equavela_core::project::{
    CalculationSettings, DiagnosticKind, DocumentId, DocumentRegion, IncludeRegion, NodeKind,
    Project, ProjectDocument, RegionOrigin,
};
use std::collections::{BTreeMap, BTreeSet};

fn id(path: &str) -> DocumentId {
    DocumentId::new(path).unwrap()
}

fn math(id: &str, y: f64, source: &str) -> DocumentRegion {
    DocumentRegion::Math(Box::new(Region {
        id: id.to_owned(),
        page: 0,
        x: 0.0,
        y,
        enabled: true,
        statement: std::sync::Arc::new(parse_statement(source).unwrap()),
    }))
}

fn include(id: &str, y: f64, path: &str) -> DocumentRegion {
    DocumentRegion::Include(IncludeRegion {
        id: id.to_owned(),
        page: 0,
        x: 0.0,
        y,
        enabled: true,
        path: path.to_owned(),
    })
}

fn settings(values: &[(&str, &str)]) -> CalculationSettings {
    CalculationSettings {
        values: values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<BTreeMap<_, _>>(),
    }
}

fn document(path: &str, hash: &str, regions: Vec<DocumentRegion>) -> ProjectDocument {
    ProjectDocument {
        id: id(path),
        content_hash: hash.to_owned(),
        settings: CalculationSettings::default(),
        environment: None,
        page: Default::default(),
        result_formats: Default::default(),
        numeric_options: Default::default(),
        math_breaks: Default::default(),
        resources: Default::default(),
        assets: Default::default(),
        page_breaks: Vec::new(),
        regions: regions.into_iter().map(std::sync::Arc::new).collect(),
    }
}

fn origin(path: &str, region_id: &str) -> RegionOrigin {
    RegionOrigin {
        document: id(path),
        region_id: region_id.to_owned(),
    }
}

#[test]
fn resolves_relative_transitive_includes_and_preserves_origins() {
    let mut project = Project::new();
    project
        .insert(document(
            "lib/base.eqv",
            "base-v1",
            vec![math("base", 0.0, "base := parent + 1")],
        ))
        .unwrap();
    project
        .insert(document(
            "lib/mid.eqv",
            "mid-v1",
            vec![
                include("inc-base", 0.0, "base.eqv"),
                math("mid", 1.0, "mid := base + 1"),
                math("ignored", 2.0, "mid ="),
            ],
        ))
        .unwrap();
    project
        .insert(document(
            "worksheets/main.eqv",
            "main-v1",
            vec![
                math("parent", 0.0, "parent := 10"),
                math("before", 1.0, "before := mid"),
                include("inc-mid", 2.0, "../lib/mid.eqv"),
                math("after", 3.0, "after := mid + base"),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("worksheets/main.eqv")).unwrap();
    let base = analysis
        .single_node(&origin("lib/base.eqv", "base"))
        .unwrap();
    let mid = analysis.single_node(&origin("lib/mid.eqv", "mid")).unwrap();
    let parent = analysis
        .single_node(&origin("worksheets/main.eqv", "parent"))
        .unwrap();
    let after = analysis
        .single_node(&origin("worksheets/main.eqv", "after"))
        .unwrap();

    assert_eq!(analysis.dependencies_of(base.id), &[parent.id]);
    assert_eq!(analysis.dependencies_of(mid.id), &[base.id]);
    assert_eq!(analysis.dependencies_of(after.id), &[base.id, mid.id]);
    assert!(analysis
        .nodes_for_origin(&origin("lib/mid.eqv", "ignored"))
        .is_empty());
    assert!(analysis.unresolved_references().iter().any(|reference| {
        reference.origin == origin("worksheets/main.eqv", "before")
            && reference.name.as_simple() == Some("mid")
    }));
}

#[test]
fn reports_missing_targets_and_cycles_at_the_include_that_closes_them() {
    let mut project = Project::new();
    project
        .insert(document(
            "a.eqv",
            "a1",
            vec![
                include("to-b", 0.0, "b.eqv"),
                include("missing", 1.0, "missing.eqv"),
                math("use-b", 2.0, "b ="),
                math("use-missing", 3.0, "not_there ="),
            ],
        ))
        .unwrap();
    project
        .insert(document(
            "b.eqv",
            "b1",
            vec![include("back-to-a", 0.0, "a.eqv"), math("b", 1.0, "b := 2")],
        ))
        .unwrap();

    let analysis = project.analyze(&id("a.eqv")).unwrap();
    assert!(analysis.diagnostics().iter().any(|diagnostic| {
        diagnostic.origin == origin("b.eqv", "back-to-a")
            && matches!(
                &diagnostic.kind,
                DiagnosticKind::IncludeCycle { chain }
                    if chain == &vec![id("a.eqv"), id("b.eqv"), id("a.eqv")]
            )
    }));
    assert!(analysis.diagnostics().iter().any(|diagnostic| {
        diagnostic.origin == origin("a.eqv", "missing")
            && matches!(
                &diagnostic.kind,
                DiagnosticKind::MissingInclude { target } if target == &id("missing.eqv")
            )
    }));
    assert!(analysis.single_node(&origin("b.eqv", "b")).is_some());
    // A -> B is not cached either: B's expansion contains the cycle error.
    assert!(analysis.cache_uses().is_empty());
}

#[test]
fn reuses_a_diamond_include_only_when_its_context_key_matches() {
    let mut project = Project::new();
    project
        .insert(document("c.eqv", "c1", vec![math("c", 0.0, "c := 1")]))
        .unwrap();
    for name in ["a", "b"] {
        project
            .insert(document(
                &format!("{name}.eqv"),
                &format!("{name}1"),
                vec![include("to-c", 0.0, "c.eqv")],
            ))
            .unwrap();
    }
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![
                include("to-a", 0.0, "a.eqv"),
                include("to-b", 1.0, "b.eqv"),
                math("out", 2.0, "c ="),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("root.eqv")).unwrap();
    let c_uses: Vec<_> = analysis
        .cache_uses()
        .iter()
        .filter(|cache_use| cache_use.key.document == id("c.eqv"))
        .collect();
    assert_eq!(c_uses.len(), 2);
    assert_eq!(c_uses[0].key, c_uses[1].key);
    assert!(!c_uses[0].hit);
    assert!(c_uses[1].hit);
    assert_eq!(analysis.nodes_for_origin(&origin("c.eqv", "c")).len(), 2);
}

#[test]
fn same_file_in_two_parent_contexts_gets_two_cache_entries() {
    let mut project = Project::new();
    project
        .insert(document(
            "child.eqv",
            "child1",
            vec![math("y", 0.0, "y := p + 1")],
        ))
        .unwrap();
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![
                math("p1", 0.0, "p := 1"),
                include("first", 1.0, "child.eqv"),
                math("p2", 2.0, "p := 2"),
                include("second", 3.0, "child.eqv"),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("root.eqv")).unwrap();
    let uses: Vec<_> = analysis
        .cache_uses()
        .iter()
        .filter(|cache_use| cache_use.key.document == id("child.eqv"))
        .collect();
    assert_eq!(uses.len(), 2);
    assert_ne!(uses[0].key, uses[1].key);
    assert_eq!(uses[0].key.context[0].version, 1);
    assert_eq!(uses[1].key.context[0].version, 2);
    assert!(!uses[0].hit && !uses[1].hit);
}

#[test]
fn parent_settings_are_effective_and_conflicts_are_warnings() {
    let mut child = document("child.eqv", "child1", vec![math("x", 0.0, "x := 1")]);
    child.settings = settings(&[("origin", "1")]);
    let mut root = document("root.eqv", "root1", vec![include("inc", 0.0, "child.eqv")]);
    root.settings = settings(&[("origin", "0")]);
    let mut project = Project::new();
    project.insert(child).unwrap();
    project.insert(root.clone()).unwrap();

    let analysis = project.analyze(&root.id).unwrap();
    assert_eq!(
        analysis.cache_uses()[0].key.effective_settings,
        root.settings
    );
    assert!(analysis.diagnostics().iter().any(|diagnostic| {
        diagnostic.origin == origin("root.eqv", "inc")
            && matches!(diagnostic.kind, DiagnosticKind::SettingsConflict { .. })
    }));
}

#[test]
fn changing_an_included_document_invalidates_each_parent_from_its_include_point() {
    let mut project = Project::new();
    project
        .insert(document(
            "grand.eqv",
            "grand1",
            vec![math("g", 0.0, "g := 1")],
        ))
        .unwrap();
    project
        .insert(document(
            "child.eqv",
            "child1",
            vec![
                math("before-grand", 0.0, "before_grand := 1"),
                include("to-grand", 1.0, "grand.eqv"),
                math("after-grand", 2.0, "after_grand := g"),
            ],
        ))
        .unwrap();
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![
                math("before", 0.0, "before := 1"),
                include("to-child", 1.0, "child.eqv"),
                math("after", 2.0, "after := after_grand"),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("root.eqv")).unwrap();
    let invalidated: BTreeSet<_> = analysis
        .invalidated_by_document(&id("grand.eqv"))
        .into_iter()
        .map(|node| node.origin.clone())
        .collect();

    assert!(invalidated.contains(&origin("grand.eqv", "g")));
    assert!(invalidated.contains(&origin("child.eqv", "to-grand")));
    assert!(invalidated.contains(&origin("child.eqv", "after-grand")));
    assert!(invalidated.contains(&origin("root.eqv", "to-child")));
    assert!(invalidated.contains(&origin("root.eqv", "after")));
    assert!(!invalidated.contains(&origin("child.eqv", "before-grand")));
    assert!(!invalidated.contains(&origin("root.eqv", "before")));
}

#[test]
fn document_ids_resolve_relative_parent_segments_and_absolute_paths() {
    let base = id("project/sheets/main.eqv");
    assert_eq!(
        base.resolve("../lib/base.eqv").unwrap(),
        id("project/lib/base.eqv")
    );
    assert_eq!(
        base.resolve("/shared/base.eqv").unwrap(),
        id("/shared/base.eqv")
    );
    assert_eq!(
        id("C:/work/main.eqv").resolve("../lib.eqv").unwrap(),
        id("C:/lib.eqv")
    );
}

#[test]
fn windows_canonical_paths_keep_drive_and_network_roots() {
    let drive = id(r"\\?\E:\Users\Test User\OneDrive - Company\project\worksheets\main.eqv");
    assert_eq!(
        drive.as_str(),
        "E:/Users/Test User/OneDrive - Company/project/worksheets/main.eqv"
    );
    assert_eq!(
        drive.resolve(r"..\library.eqv").unwrap(),
        id("E:/Users/Test User/OneDrive - Company/project/library.eqv")
    );
    assert_eq!(
        id("//?/E:/work/./sheets/../main.eqv"),
        id("E:/work/main.eqv")
    );
    assert_eq!(
        drive.resolve(r"\\?\C:\shared\base.eqv").unwrap(),
        id("C:/shared/base.eqv")
    );

    let network = id(r"\\?\UNC\server\share\project\main.eqv");
    assert_eq!(network.as_str(), "//server/share/project/main.eqv");
    assert_eq!(network, id(r"\\server\share\project\main.eqv"));
    assert_eq!(
        network.resolve(r"..\..\..\base.eqv").unwrap().as_str(),
        "//server/share/base.eqv"
    );
    assert_eq!(
        drive.resolve(r"\\server\share\base.eqv").unwrap().as_str(),
        "//server/share/base.eqv"
    );
    assert_eq!(id("///work/./main.eqv").as_str(), "/work/main.eqv");
}

#[test]
fn project_document_round_trips_as_json() {
    let document = document(
        "root.eqv",
        "root1",
        vec![math("x", 0.0, "x := 1"), include("inc", 1.0, "lib.eqv")],
    );
    let json = serde_json::to_string(&document).unwrap();
    assert_eq!(
        serde_json::from_str::<ProjectDocument>(&json).unwrap(),
        document
    );
}

#[test]
fn include_nodes_are_present_in_the_project_schedule() {
    let mut project = Project::new();
    project
        .insert(document("lib.eqv", "lib1", vec![math("x", 0.0, "x := 1")]))
        .unwrap();
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![include("inc", 0.0, "lib.eqv")],
        ))
        .unwrap();
    let analysis = project.analyze(&id("root.eqv")).unwrap();
    let include_node = analysis.single_node(&origin("root.eqv", "inc")).unwrap();
    assert!(matches!(
        include_node.kind,
        NodeKind::Include { ref target } if target == &id("lib.eqv")
    ));
}

#[test]
fn reports_duplicate_global_definitions_across_includes() {
    let mut project = Project::new();
    project
        .insert(document(
            "lib.eqv",
            "lib1",
            vec![math("lib-global", 0.0, "gravity ≡ 9.81 m@unit/s@unit^2")],
        ))
        .unwrap();
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![
                math("root-global", 0.0, "gravity ≡ 10 m@unit/s@unit^2"),
                include("inc", 1.0, "lib.eqv"),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("root.eqv")).unwrap();
    assert!(analysis.diagnostics().iter().any(|diagnostic| {
        diagnostic.origin == origin("lib.eqv", "lib-global")
            && matches!(
                &diagnostic.kind,
                DiagnosticKind::DuplicateGlobalDefinition { name, first }
                    if name.as_simple() == Some("gravity")
                        && first == &origin("root.eqv", "root-global")
            )
    }));
}

#[test]
fn dimensional_warnings_cross_include_boundaries_and_keep_parent_origin() {
    let mut project = Project::new();
    project
        .insert(document(
            "lib.eqv",
            "lib1",
            vec![math("distance", 0.0, "distance := 3 m@unit")],
        ))
        .unwrap();
    project
        .insert(document(
            "root.eqv",
            "root1",
            vec![
                include("inc", 0.0, "lib.eqv"),
                math("bad", 1.0, "bad := distance + 2 s@unit"),
            ],
        ))
        .unwrap();

    let analysis = project.analyze(&id("root.eqv")).unwrap();
    assert_eq!(analysis.dimension_warnings().len(), 1);
    assert_eq!(
        analysis.dimension_warnings()[0].origin,
        origin("root.eqv", "bad")
    );
    assert!(matches!(
        analysis.dimension_warnings()[0].kind,
        DimensionWarningKind::Mismatch {
            operation: DimensionOperation::Add,
            ..
        }
    ));
}
