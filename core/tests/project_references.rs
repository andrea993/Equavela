//! Project references.

use equavela_core::codegen::{generate_worksheet_with, GenOptions};
use equavela_core::project::{NodeKind, Project, ProjectAnalysis};
use equavela_core::project_directory::MANIFEST_FILE;
use equavela_core::project_manifest::{
    ApiEntry, ExportEntry, ExportKind, ProjectManifest, ReferenceEntry, WorksheetEntry,
    PROJECT_FORMAT,
};
use equavela_core::project_reference::{load_references, read_api};
use equavela_core::worksheet_file::load_project;
use std::fs;
use std::path::Path;
use std::sync::Arc;

const THERMO: &str = "11111111-1111-4111-8111-111111111111";
const THERMO_SHEET: &str = "11111111-1111-4111-8111-1111111111aa";
const CONSUMER: &str = "22222222-2222-4222-8222-222222222222";
const CONSUMER_SHEET: &str = "22222222-2222-4222-8222-2222222222aa";
const STEAM: &str = "33333333-3333-4333-8333-333333333333";
const STEAM_SHEET: &str = "33333333-3333-4333-8333-3333333333aa";
const EXPORT_CP: &str = "11111111-1111-4111-8111-1111111111c1";
const EXPORT_RHO: &str = "11111111-1111-4111-8111-1111111111c2";
const EXPORT_H: &str = "33333333-3333-4333-8333-3333333333c1";

fn sheet(regions: &[(&str, &str)]) -> String {
    let mut yaml = String::from("format: equavela-worksheet/3\nregions:\n");
    for (index, (id, math)) in regions.iter().enumerate() {
        yaml.push_str(&format!(
            "  - id: {id}\n    at: [0, {}]\n    math: \"{}\"\n",
            10 * (index + 1),
            math.replace('"', "\\\"")
        ));
    }
    yaml
}

fn write_project(
    root: &Path,
    id: &str,
    name: &str,
    sheet_id: &str,
    worksheet: &str,
    exports: Vec<ExportEntry>,
    references: Vec<ReferenceEntry>,
) -> ProjectManifest {
    let manifest = ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: id.into(),
        name: name.into(),
        worksheets: vec![WorksheetEntry {
            id: sheet_id.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: None,
        exports,
        references,
        julia_modules: Vec::new(),
    };
    fs::create_dir_all(root.join("worksheets")).unwrap();
    fs::write(root.join("worksheets/main.eqv"), worksheet).unwrap();
    fs::write(root.join(MANIFEST_FILE), manifest.to_yaml().unwrap()).unwrap();
    manifest
}

fn export(id: &str, region: &str) -> ExportEntry {
    ExportEntry {
        id: id.into(),
        worksheet: THERMO_SHEET.into(),
        region: region.into(),
    }
}

/// Thermo: a private constant `k`, an exported function `c_p(T)` that uses it, an exported value
/// `ρ` and an unexported `secret`.
fn thermo(root: &Path) -> ProjectManifest {
    write_project(
        root,
        THERMO,
        "Thermo",
        THERMO_SHEET,
        &sheet(&[
            ("k", "k := 2"),
            ("cp", "c_p(T) := k·T"),
            ("rho", "ρ := 1000"),
            ("secret", "secret := 7"),
        ]),
        vec![export(EXPORT_CP, "cp"), export(EXPORT_RHO, "rho")],
        Vec::new(),
    )
}

fn reference(path: &str, api: Vec<ApiEntry>) -> ReferenceEntry {
    ReferenceEntry {
        alias: "Thermo".into(),
        project_id: THERMO.into(),
        path: path.into(),
        api,
    }
}

/// Loads the consumer's worksheet with its references and analyses it.
fn analyse(consumer: &Path) -> (Project, ProjectAnalysis) {
    let manifest =
        ProjectManifest::from_yaml(&fs::read_to_string(consumer.join(MANIFEST_FILE)).unwrap())
            .unwrap();
    let mut loaded = load_project(&consumer.join("worksheets/main.eqv")).unwrap();
    loaded
        .project
        .set_references(load_references(consumer, &manifest))
        .unwrap();
    let analysis = loaded.project.analyze(&loaded.root).unwrap();
    (loaded.project, analysis)
}

/// The generator's messages for a consumer region (by region id).
fn errors(project: &Project, analysis: &ProjectAnalysis, region: &str) -> Vec<String> {
    let options = GenOptions {
        references: Arc::clone(project.references()),
        ..GenOptions::default()
    };
    let generated =
        generate_worksheet_with(analysis.worksheet(), analysis.graph(), options).unwrap();
    let node = analysis
        .nodes()
        .iter()
        .find(|node| {
            matches!(node.kind, NodeKind::Math)
                && node.origin.region_id == region
                && !node.origin.document.as_str().starts_with('@')
        })
        .unwrap();
    generated
        .regions
        .iter()
        .find(|generated| generated.id == node.id.region_id())
        .unwrap()
        .diagnostics
        .iter()
        .map(|diagnostic| diagnostic.message.clone())
        .collect()
}

fn unresolved(analysis: &ProjectAnalysis) -> Vec<String> {
    analysis
        .unresolved_references()
        .iter()
        .filter(|reference| !reference.origin.document.as_str().starts_with('@'))
        .map(|reference| equavela_core::print_name(&reference.name))
        .collect()
}

#[test]
fn exports_resolve_under_the_alias_and_private_names_do_not() {
    let temp = tempfile::tempdir().unwrap();
    let provider = thermo(&temp.path().join("Thermo"));
    let api = read_api(&temp.path().join("Thermo"), &provider);
    assert_eq!(
        api.iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>(),
        ["c_p", "ρ"]
    );
    assert_eq!(api[0].kind, ExportKind::Function);
    assert_eq!(api[0].arity, Some(1));
    let consumer = temp.path().join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[
            ("own", "k := 5"),
            ("use", "Thermo.c_p(300) + Thermo.ρ ="),
            ("mine", "k ="),
            ("private", "Thermo.k ="),
            ("unexported", "Thermo.secret ="),
        ]),
        Vec::new(),
        vec![reference("../Thermo", api)],
    );
    let (project, analysis) = analyse(&consumer);
    assert!(
        project.references().problems.is_empty(),
        "{:?}",
        project.references().problems
    );
    let missing = unresolved(&analysis);
    assert!(missing.contains(&"Thermo.k".to_string()), "{missing:?}");
    assert!(
        missing.contains(&"Thermo.secret".to_string()),
        "{missing:?}"
    );
    assert!(
        !missing
            .iter()
            .any(|name| name == "Thermo.c_p" || name == "Thermo.ρ"),
        "{missing:?}"
    );
    // The consumer's own `k` is not the provider's private `k`.
    assert!(errors(&project, &analysis, "mine").is_empty());
    assert!(errors(&project, &analysis, "use").is_empty());
    assert_eq!(
        errors(&project, &analysis, "private"),
        ["`Thermo` exports no `k`"]
    );
    assert_eq!(
        errors(&project, &analysis, "unexported"),
        ["`Thermo` exports no `secret`"]
    );
    let mine = analysis
        .nodes()
        .iter()
        .find(|node| node.origin.region_id == "mine")
        .unwrap();
    let own = analysis
        .nodes()
        .iter()
        .find(|node| node.origin.region_id == "own")
        .unwrap();
    assert_eq!(analysis.dependencies_of(mine.id), [own.id]);
}

#[test]
fn locked_api_changes_are_reported_by_name() {
    let temp = tempfile::tempdir().unwrap();
    let provider = thermo(&temp.path().join("Thermo"));
    let mut api = read_api(&temp.path().join("Thermo"), &provider);
    // Locked when c_p took two arguments, and with an export that no longer exists.
    api[0].arity = Some(2);
    api.push(ApiEntry {
        id: "11111111-1111-4111-8111-1111111111c9".into(),
        name: "gone".into(),
        kind: ExportKind::Value,
        arity: None,
    });
    let consumer = temp.path().join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[
            ("a", "Thermo.c_p(1) ="),
            ("b", "Thermo.gone ="),
            ("c", "Thermo.ρ ="),
        ]),
        Vec::new(),
        vec![reference("../Thermo", api)],
    );
    let (project, analysis) = analyse(&consumer);
    assert_eq!(
        errors(&project, &analysis, "a"),
        ["`Thermo.c_p` changed signature: update the reference"]
    );
    assert_eq!(
        errors(&project, &analysis, "b"),
        ["`Thermo.gone` is no longer exported: update the reference"]
    );
    assert!(errors(&project, &analysis, "c").is_empty());
}

#[test]
fn missing_and_substituted_projects_are_problems() {
    let temp = tempfile::tempdir().unwrap();
    let consumer = temp.path().join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[("a", "Thermo.ρ =")]),
        Vec::new(),
        vec![reference("../Thermo", Vec::new())],
    );
    let (project, _) = analyse(&consumer);
    assert_eq!(project.references().problems.len(), 1);
    assert!(project.references().problems[0].1.contains("was not found"));

    // A folder that holds another project is never used in its place.
    write_project(
        &temp.path().join("Thermo"),
        STEAM,
        "Steam",
        STEAM_SHEET,
        &sheet(&[("h", "h := 1")]),
        Vec::new(),
        Vec::new(),
    );
    let (project, _) = analyse(&consumer);
    assert!(
        project.references().problems[0]
            .1
            .contains("another project"),
        "{:?}",
        project.references().problems
    );
}

#[test]
fn nested_references_compose_and_cycles_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let steam_root = temp.path().join("Steam");
    let steam = write_project(
        &steam_root,
        STEAM,
        "Steam",
        STEAM_SHEET,
        &sheet(&[("h", "h(T, p) := T + p")]),
        vec![ExportEntry {
            id: EXPORT_H.into(),
            worksheet: STEAM_SHEET.into(),
            region: "h".into(),
        }],
        Vec::new(),
    );
    let steam_api = read_api(&steam_root, &steam);
    let thermo_root = temp.path().join("Thermo");
    let thermo = write_project(
        &thermo_root,
        THERMO,
        "Thermo",
        THERMO_SHEET,
        &sheet(&[("cp", "c_p(T) := Steam.h(T, 1)")]),
        vec![export(EXPORT_CP, "cp")],
        vec![ReferenceEntry {
            alias: "Steam".into(),
            project_id: STEAM.into(),
            path: "../Steam".into(),
            api: steam_api,
        }],
    );
    let consumer = temp.path().join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[("a", "Thermo.c_p(2) ="), ("b", "Steam.h(1, 2) =")]),
        Vec::new(),
        vec![reference("../Thermo", read_api(&thermo_root, &thermo))],
    );
    let (project, analysis) = analyse(&consumer);
    assert!(
        project.references().problems.is_empty(),
        "{:?}",
        project.references().problems
    );
    assert!(errors(&project, &analysis, "a").is_empty());
    // The consumer does not reference Steam: its names are Thermo's business.
    assert_eq!(errors(&project, &analysis, "b"), ["Steam.h is undefined"]);
    let aliases: Vec<_> = project
        .references()
        .splices
        .iter()
        .map(|splice| splice.alias.as_str())
        .collect();
    assert_eq!(aliases, ["Thermo/Steam", "Thermo"]);

    // Steam now references the consumer: Consumer → Thermo → Steam → Consumer.
    let mut steam = steam;
    steam.references = vec![ReferenceEntry {
        alias: "Back".into(),
        project_id: CONSUMER.into(),
        path: "../Consumer".into(),
        api: Vec::new(),
    }];
    fs::write(steam_root.join(MANIFEST_FILE), steam.to_yaml().unwrap()).unwrap();
    let (project, _) = analyse(&consumer);
    let problems = &project.references().problems;
    assert!(
        problems
            .iter()
            .any(|(_, message)| message == "reference cycle: Consumer → Thermo → Steam → Consumer"),
        "{problems:?}"
    );
}

#[test]
fn a_consumer_cannot_define_a_reference_name_and_unlocked_exports_ask_for_an_update() {
    let temp = tempfile::tempdir().unwrap();
    let provider = thermo(&temp.path().join("Thermo"));
    // Locked before ρ was exported.
    let api: Vec<_> = read_api(&temp.path().join("Thermo"), &provider)
        .into_iter()
        .filter(|entry| entry.name == "c_p")
        .collect();
    let consumer = temp.path().join("Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[
            ("def", "Thermo.c_p(T) := 0"),
            ("use", "Thermo.c_p(1) ="),
            ("rho", "Thermo.ρ ="),
        ]),
        Vec::new(),
        vec![reference("../Thermo", api)],
    );
    let (project, analysis) = analyse(&consumer);
    let diagnostics: Vec<_> = analysis
        .diagnostics()
        .iter()
        .map(|diagnostic| diagnostic.origin.region_id.as_str())
        .collect();
    assert_eq!(diagnostics, ["def"]);
    // The use still reaches the provider's export, not the refused local definition.
    assert!(errors(&project, &analysis, "use").is_empty());
    let used = analysis
        .nodes()
        .iter()
        .find(|node| node.origin.region_id == "use")
        .unwrap();
    let producer = analysis.dependencies_of(used.id)[0];
    assert!(analysis.nodes()[producer.0]
        .origin
        .document
        .as_str()
        .starts_with("@Thermo/"));
    assert_eq!(
        errors(&project, &analysis, "rho"),
        ["`Thermo.ρ` is not in the locked API of `Thermo`: update the reference"]
    );
}

#[test]
fn export_and_reference_commands_edit_the_manifests() {
    use equavela_core::project_reference::{
        add_reference, propose_alias, relative_path, remove_reference, rename_reference,
        set_export, update_reference,
    };
    let temp = tempfile::tempdir().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let thermo_root = base.join("Libs/Thermo dynamics");
    write_project(
        &thermo_root,
        THERMO,
        "Thermo dynamics",
        THERMO_SHEET,
        &sheet(&[
            ("cp", "c_p(T) := 2·T"),
            ("eval", "c_p(1) ="),
            ("rho", "ρ := 1000"),
        ]),
        Vec::new(),
        Vec::new(),
    );
    // only a one-name definition is exported, once per region and per name.
    let manifest = set_export(&thermo_root, "worksheets/main.eqv", "cp", true).unwrap();
    assert_eq!(manifest.exports.len(), 1);
    assert!(set_export(&thermo_root, "worksheets/main.eqv", "eval", true).is_err());
    assert!(set_export(&thermo_root, "worksheets/main.eqv", "missing", true).is_err());
    assert_eq!(
        set_export(&thermo_root, "worksheets/main.eqv", "cp", true)
            .unwrap()
            .exports
            .len(),
        1
    );

    let consumer = base.join("Work/Consumer");
    write_project(
        &consumer,
        CONSUMER,
        "Consumer",
        CONSUMER_SHEET,
        &sheet(&[("a", "Thermodynamics.c_p(1) =")]),
        Vec::new(),
        Vec::new(),
    );
    assert_eq!(
        relative_path(&consumer, &thermo_root).unwrap(),
        "../../Libs/Thermo dynamics"
    );
    let (manifest, alias) = add_reference(&consumer, &thermo_root, None).unwrap();
    assert_eq!(alias, "Thermodynamics");
    assert_eq!(manifest.references[0].path, "../../Libs/Thermo dynamics");
    assert_eq!(manifest.references[0].api.len(), 1);
    // Already referenced, itself, a cycle.
    assert!(add_reference(&consumer, &thermo_root, Some("Other")).is_err());
    assert!(add_reference(&consumer, &consumer, None).is_err());
    assert!(add_reference(&thermo_root, &consumer, None)
        .unwrap_err()
        .contains("cycle"));

    // A new export reaches the consumer once the reference is updated.
    set_export(&thermo_root, "worksheets/main.eqv", "rho", true).unwrap();
    assert_eq!(
        update_reference(&consumer, "Thermodynamics")
            .unwrap()
            .references[0]
            .api
            .len(),
        2
    );
    assert!(rename_reference(&consumer, "Thermodynamics", "julia").is_err());
    let manifest = rename_reference(&consumer, "Thermodynamics", "Thermo").unwrap();
    assert_eq!(manifest.references[0].alias, "Thermo");
    assert!(remove_reference(&consumer, "Thermo")
        .unwrap()
        .references
        .is_empty());
    assert!(remove_reference(&consumer, "Thermo").is_err());

    assert_eq!(propose_alias("2D tools", &[]), "P2Dtools");
    assert_eq!(propose_alias("Julia", &[]), "Julia1");
    assert_eq!(
        propose_alias("Steam", &["steam".into(), "Steam2".into()]),
        "Steam3"
    );
}
