//! `julia` regions: YAML reader, dependency graph and code generation.

use equavela_core::ast::StatementKind;
use equavela_core::codegen::{generate_worksheet, GenOptions, GeneratedWorksheet};
use equavela_core::graph::{DependencyGraph, Worksheet};
use equavela_core::project::{DocumentId, DocumentRegion};
use equavela_core::worksheet_file::{parse_document, LoadError};

fn load(yaml: &str) -> Result<Worksheet, LoadError> {
    let id = DocumentId::new("/t.eqv").unwrap();
    // The fragments below list regions only: add the identity line every worksheet carries.
    let text = if yaml.starts_with("format:") {
        yaml.to_owned()
    } else {
        format!(
            "format: equavela-worksheet/3
{}",
            yaml.trim_start()
        )
    };
    let loaded = parse_document(id, &text)?;
    let regions = loaded
        .document
        .regions
        .into_iter()
        .filter_map(|region| match std::sync::Arc::unwrap_or_clone(region) {
            DocumentRegion::Math(region) => Some(*region),
            DocumentRegion::Include(_)
            | DocumentRegion::Text(_)
            | DocumentRegion::Plot(_)
            | DocumentRegion::Image(_)
            | DocumentRegion::Area(_) => None,
        })
        .collect();
    Ok(Worksheet { regions })
}

fn generate(yaml: &str) -> GeneratedWorksheet {
    generate_worksheet(&load(yaml).unwrap(), GenOptions::default()).unwrap()
}

const SHEET: &str = r#"format: equavela-worksheet/3
environment: env
regions:
  - id: r1
    at: [0, 10]
    math: "a := 3"
  - id: j1
    at: [0, 20]
    julia:
      using: [LinearAlgebra]
      import:
        nrm: LinearAlgebra.norm
      define: [helper]
      code: |
        function area(r)
            return 3 * r^2 * a
        end
        scale = 2.5
  - id: r2
    at: [0, 30]
    math: "Area(r) := julia.area"
  - id: r3
    at: [0, 40]
    math: "Nrm(v) := julia.nrm"
"#;

#[test]
fn reads_julia_regions_and_environment() {
    let id = DocumentId::new("/t.eqv").unwrap();
    let loaded = parse_document(id, SHEET).unwrap();
    assert_eq!(loaded.document.environment.as_deref(), Some("env"));
    let DocumentRegion::Math(region) = loaded.document.regions[1].as_ref() else {
        panic!("julia region is a math-kind region");
    };
    let StatementKind::Julia { block } = &region.statement.kind else {
        panic!("expected a julia statement");
    };
    assert_eq!(block.using, ["LinearAlgebra"]);
    assert_eq!(block.imports.len(), 1);
    assert_eq!(block.imports[0].name, "nrm");
    assert_eq!(block.imports[0].package, "LinearAlgebra");
    assert_eq!(block.imports[0].function, "norm");
    assert_eq!(block.defines, ["helper"]);
    assert!(block.code.as_deref().unwrap().starts_with("function area"));
    assert!(!block.code.as_deref().unwrap().ends_with('\n'));
    assert_eq!(block.exports(), ["nrm", "helper", "area", "scale"]);
}

#[test]
fn rejects_malformed_imports() {
    let yaml = "regions:\n  - id: j\n    julia:\n      import:\n        f: NoDot\n";
    let error = load(yaml).expect_err("must fail");
    assert!(matches!(error, LoadError::Julia { .. }), "{error}");
    assert!(error.to_string().contains("Package.function"), "{error}");
}

#[test]
fn julia_region_is_connected_in_the_graph() {
    let graph = DependencyGraph::build(&load(SHEET).unwrap()).unwrap();
    // The julia code mentions the worksheet variable `a`.
    assert_eq!(graph.dependencies_of("j1").unwrap(), ["r1"]);
    // Math regions depend on the julia region through the names it defines or imports.
    assert_eq!(graph.dependencies_of("r2").unwrap(), ["j1"]);
    assert_eq!(graph.dependencies_of("r3").unwrap(), ["j1"]);
    // Editing the math variable re-evaluates the julia region and its readers.
    assert_eq!(graph.affected_by(["r1"]).unwrap(), ["r1", "j1", "r2", "r3"]);
    assert!(graph.unresolved_references().is_empty());
}

#[test]
fn later_math_definitions_shadow_julia_names() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      code: "k = 5"
  - id: r1
    at: [0, 2]
    math: "k := 1"
  - id: r2
    at: [0, 3]
    math: "k + 1 ="
"#;
    let graph = DependencyGraph::build(&load(yaml).unwrap()).unwrap();
    assert_eq!(graph.dependencies_of("r2").unwrap(), ["r1"]);
    let generated = generate(yaml);
    assert_eq!(
        generated.regions[2].value.as_deref(),
        Some("eq_add(k_v1, 1.0)")
    );
}

#[test]
fn generates_region_code_and_calls() {
    let generated = generate(SHEET);
    let ids: Vec<&str> = generated.regions.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["r1", "j1", "r2", "r3"]);
    let julia = &generated.regions[1];
    assert!(julia.needs_julia);
    assert_eq!(julia.defined, ["nrm", "helper", "area", "scale"]);
    assert_eq!(julia.packages, ["LinearAlgebra"]);
    let lines: Vec<&str> = julia.code.lines().collect();
    assert_eq!(lines[0], "using LinearAlgebra");
    assert_eq!(lines[1], "import LinearAlgebra");
    assert_eq!(lines[2], "a = to_julia(a_v1)");
    assert_eq!(lines[3], "function area(r)");
    assert!(julia.code.ends_with("scale = 2.5"));
    assert!(!generated.regions[0].needs_julia);

    // Julia functions are called through their registration.
    assert_eq!(
        generated.regions[2].code,
        "Area_v1 = let\n    Area_v1(r) = eq_julia_call(area, r)\n    Area_v1\nend"
    );
    assert!(generated.regions[2].needs_julia);
    assert_eq!(
        generated.regions[3].code,
        "Nrm_v1 = let\n    Nrm_v1(v) = eq_julia_call(LinearAlgebra.norm, v)\n    Nrm_v1\nend"
    );
    assert!(generated.regions[3]
        .packages
        .contains(&"LinearAlgebra".to_string()));
}

#[test]
fn import_clashes_are_reported() {
    let yaml = r#"
regions:
  - id: r1
    at: [0, 1]
    math: "x := 1"
  - id: j1
    at: [0, 2]
    julia:
      import:
        max: LinearAlgebra.norm
        x: LinearAlgebra.norm
        bad name: LinearAlgebra.norm
"#;
    let generated = generate(yaml);
    let julia = &generated.regions[1];
    assert!(julia.code.starts_with("eq_error("), "{}", julia.code);
    let messages: Vec<&str> = julia
        .diagnostics
        .iter()
        .map(|d| d.message.as_str())
        .collect();
    // An import name is a Julia name reached through `julia.`: a built-in or
    // worksheet name of the same spelling is no clash, an invalid Julia name is.
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(
        messages[0].contains("`bad name` is not a valid Julia name"),
        "{messages:?}"
    );
    assert!(julia.defined.is_empty());
}

#[test]
fn detected_names_that_clash_with_builtins_are_not_exported() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      code: |
        sin(x) = x
        mine(x) = x
  - id: r1
    at: [0, 2]
    math: "sin(0) ="
"#;
    let generated = generate(yaml);
    assert_eq!(generated.regions[0].defined, ["mine"]);
    assert_eq!(generated.regions[1].value.as_deref(), Some("eq_sin(0.0)"));
    assert!(!generated.regions[1].needs_julia);
}

#[test]
fn subscripted_julia_names_are_written_with_an_underscore() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      code: "my_func(x) = 2x"
  - id: r1
    at: [0, 2]
    math: "F(x) := julia.my_func"
"#;
    let generated = generate(yaml);
    assert_eq!(generated.regions[0].defined, ["my_func"]);
    assert_eq!(
        generated.regions[1].code,
        "F_v1 = let\n    F_v1(x) = eq_julia_call(my_func, x)\n    F_v1\nend"
    );
}

/// a stopped block is never evaluated. It emits no code, exports no name and does not
/// need a trusted session, so math below that reads its names sees the worksheet, not the block.
#[test]
fn a_stopped_block_defines_nothing_and_emits_no_code() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      playing: false
      using: [LinearAlgebra]
      code: |
        scale = 2.5
  - id: r1
    at: [0, 2]
    math: "x := 1"
  - id: r2
    at: [0, 3]
    math: "scale + x ="
"#;
    let generated = generate(yaml);
    let julia = &generated.regions[0];
    assert!(!julia.needs_julia);
    assert!(julia.code.is_empty(), "{}", julia.code);
    assert!(julia.defined.is_empty());
    assert!(julia.packages.is_empty());
    // `scale` is not exported: the math below does not depend on the block and calls no Julia.
    assert!(!generated.regions[2].needs_julia);
    let graph = DependencyGraph::build(&load(yaml).unwrap()).unwrap();
    assert_eq!(graph.dependencies_of("r2").unwrap(), ["r1"]);
}

/// stops and plays through the file alone: the same block plays when the key is absent.
#[test]
fn a_block_without_the_key_plays() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      code: "scale = 2.5"
  - id: r1
    at: [0, 2]
    math: "julia.scale ="
"#;
    let generated = generate(yaml);
    assert!(generated.regions[0].needs_julia);
    assert_eq!(generated.regions[0].defined, ["scale"]);
    assert_eq!(
        generated.regions[1].value.as_deref(),
        Some("from_julia(scale)")
    );
}

/// a Julia block exports nothing by itself; `julia.` reaches its names,
/// and a definition registers a Julia function under a worksheet name of the user's choice.
#[test]
fn julia_names_are_reached_through_the_qualifier_and_registered() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      code: |
        k_x_max(a, b) = a + 2b
        gain = 4
  - id: r1
    at: [0, 2]
    math: "F(X, y) := julia.k_x_max"
  - id: r2
    at: [0, 3]
    math: "F(1, 2) ="
  - id: r3
    at: [0, 4]
    math: "g := julia.gain"
  - id: r4
    at: [0, 5]
    math: "gain ="
  - id: r5
    at: [0, 6]
    math: "julia.nope ="
"#;
    let generated = generate(yaml);
    assert_eq!(
        generated.regions[1].code,
        "F_v1 = let\n    F_v1(X, y) = eq_julia_call(k_x_max, X, y)\n    F_v1\nend"
    );
    assert!(generated.regions[1].needs_julia);
    assert_eq!(
        generated.regions[2].value.as_deref(),
        Some("F_v1(1.0, 2.0)")
    );
    assert_eq!(generated.regions[3].code, "g_v1 = from_julia(gain)");
    // A plain name never reaches the block.
    assert!(!generated.regions[4].needs_julia);
    assert!(generated.regions[5]
        .value
        .as_deref()
        .unwrap()
        .contains("is not defined by a Julia block above"));
    let graph = DependencyGraph::build(&load(yaml).unwrap()).unwrap();
    assert_eq!(graph.dependencies_of("r1").unwrap(), ["j1"]);
    assert_eq!(graph.dependencies_of("r3").unwrap(), ["j1"]);
    let unresolved: Vec<&str> = graph
        .unresolved_references()
        .iter()
        .map(|r| r.region_id.as_str())
        .collect();
    assert_eq!(unresolved, ["r4", "r5"]);
}

/// The bare form prints back as written; only `julia` may be bare.
#[test]
fn the_bare_julia_name_round_trips() {
    for text in [
        "F(X, y) := julia.k_x_max",
        "g := julia.gain_1",
        "julia.f!(1) =",
    ] {
        let parsed = equavela_core::parse_statement(text).unwrap();
        assert_eq!(equavela_core::print_statement(&parsed), text);
    }
    assert!(equavela_core::parse_statement("LinearAlgebra::norm =").is_err());
}

/// direct calls use the Julia qualifier and the conversion bridge.
#[test]
fn julia_qualified_functions_can_be_called_without_registration() {
    let yaml = r#"
regions:
  - id: j1
    at: [0, 1]
    julia:
      using: [Statistics]
      code: "triple(x) = 3x"
  - id: r1
    at: [0, 2]
    math: "julia.triple(2) ="
  - id: r2
    at: [0, 3]
    math: "Statistics::mean(2) ="
  - id: r3
    at: [0, 4]
    math: "triple@julia(2) ="
"#;
    let generated = generate(yaml);
    let direct = &generated.regions[1];
    assert_eq!(direct.value.as_deref(), Some("eq_julia_call(triple, 2.0)"));
    assert!(direct.diagnostics.is_empty());
    assert!(direct.needs_julia);
    let graph = DependencyGraph::build(&load(yaml).unwrap()).unwrap();
    assert_eq!(graph.dependencies_of("r1").unwrap(), ["j1"]);
    for (index, name) in [(2, "Statistics.mean"), (3, "triple")] {
        let value = generated.regions[index].value.as_deref().unwrap();
        assert!(
            value.contains(&format!(
                "the Julia function `{name}` is not registered on the worksheet"
            )),
            "{value}"
        );
    }
}

#[test]
fn qualified_julia_names_read_print_and_need_no_block() {
    // the specification .
    let statement = equavela_core::parse_statement("U(x, y) := julia.Tools.Inner.f!").unwrap();
    assert_eq!(
        equavela_core::print_statement(&statement),
        "U(x, y) := julia.Tools.Inner.f!"
    );
    let generated = generate(
        "regions:
  - id: u
    at: [0, 10]
    math: \"U(x) := julia.Tools.f\"
  - id: v
    at: [0, 20]
    math: \"a := julia.Tools.k\"
  - id: direct
    at: [0, 30]
    math: \"julia.Tools.Inner.f!(2) =\"
",
    );
    let code: String = generated.regions.iter().map(|r| r.code.clone()).collect();
    assert!(code.contains("eq_julia_call(Tools.f, "), "{code}");
    assert!(code.contains("from_julia(Tools.k)"), "{code}");
    assert_eq!(
        generated.regions[2].value.as_deref(),
        Some("eq_julia_call(Tools.Inner.f!, 2.0)")
    );
    assert!(generated
        .regions
        .iter()
        .all(|region| region.diagnostics.is_empty()));
}
