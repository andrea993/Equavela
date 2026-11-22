//! Which Julia environment a worksheet uses.

use equavela_core::environment::{resolve_environment, EnvironmentKind};
use equavela_core::project::DocumentId;
use equavela_core::project_directory::create_project;
use equavela_core::project_manifest::{ProjectManifest, WorksheetEntry, PROJECT_FORMAT};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const SHEET: &str = "format: equavela-worksheet/3\nregions: []\n";
const ID: &str = "123e4567-e89b-42d3-a456-426614174001";

fn id(path: &Path) -> DocumentId {
    DocumentId::new(&path.to_string_lossy()).unwrap()
}

fn project(root: &Path, environment: Option<&str>) -> PathBuf {
    let manifest = ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: "123e4567-e89b-42d3-a456-426614174000".into(),
        name: "P".into(),
        worksheets: vec![WorksheetEntry {
            id: ID.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: environment.map(str::to_owned),
        exports: Vec::new(),
        references: Vec::new(),
        julia_modules: Vec::new(),
    };
    create_project(
        root,
        &manifest,
        &BTreeMap::from([(ID.into(), SHEET.into())]),
    )
    .unwrap();
    root.canonicalize().unwrap().join("worksheets/main.eqv")
}

#[test]
fn untitled_and_standalone_worksheets_use_the_shared_environment() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared");
    let untitled = DocumentId::new("Untitled-1.eqv").unwrap();
    let resolved = resolve_environment(&untitled, Some("."), &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Shared);
    assert_eq!(resolved.directory, shared);
    assert!(resolved.usable(), "the shared one is created on demand");
    // a Project.toml next to the worksheet is not used without the key.
    fs::write(temp.path().join("Project.toml"), "").unwrap();
    let sheet = temp.path().join("calc.eqv");
    fs::write(&sheet, SHEET).unwrap();
    let resolved = resolve_environment(&id(&sheet), None, &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Shared);
    assert!(resolved.problems.is_empty());
}

#[test]
fn a_standalone_worksheet_can_name_its_own_environment() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared");
    let sheet = temp.path().join("calc.eqv");
    fs::write(&sheet, SHEET).unwrap();
    fs::create_dir(temp.path().join("env")).unwrap();
    let resolved = resolve_environment(&id(&sheet), Some("env"), &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Override);
    assert_eq!(resolved.directory, temp.path().join("env"));
    assert!(!resolved.absolute);
    assert!(resolved.usable());
    let elsewhere = tempfile::tempdir().unwrap();
    let key = elsewhere.path().to_string_lossy().into_owned();
    let resolved = resolve_environment(&id(&sheet), Some(&key), &shared);
    assert_eq!(resolved.directory, elsewhere.path());
    assert!(resolved.absolute);
    // a missing override is a problem and is not replaced by another environment.
    let resolved = resolve_environment(&id(&sheet), Some("gone"), &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Override);
    assert!(!resolved.usable());
    assert!(
        resolved.problems[0].contains("gone"),
        "{:?}",
        resolved.problems
    );
}

#[test]
fn a_project_worksheet_uses_the_project_environment() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared");
    let sheet = project(&temp.path().join("with"), Some("julia"));
    let resolved = resolve_environment(&id(&sheet), None, &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Project);
    assert_eq!(
        resolved.directory,
        temp.path()
            .join("with")
            .canonicalize()
            .unwrap()
            .join("julia")
    );
    assert!(resolved.usable());
    // a worksheet key inside a project is ignored and reported.
    let resolved = resolve_environment(&id(&sheet), Some("."), &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Project);
    assert!(
        resolved.problems[0].contains("ignored"),
        "{:?}",
        resolved.problems
    );
    // The project environment folder disappears: a problem, not the shared one.
    fs::remove_dir(temp.path().join("with/julia")).unwrap();
    let resolved = resolve_environment(&id(&sheet), None, &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Project);
    assert!(!resolved.usable());
    assert!(!resolved.problems.is_empty());
    // A project that declares no environment uses the shared one.
    let sheet = project(&temp.path().join("without"), None);
    let resolved = resolve_environment(&id(&sheet), None, &shared);
    assert_eq!(resolved.kind, EnvironmentKind::Shared);
}

#[test]
fn the_manager_reads_dependencies_and_resolved_versions_from_the_files() {
    // direct dependencies from Project.toml, versions from Manifest.toml, no Julia.
    use equavela_core::environment::read_environment_files;
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let files = read_environment_files(dir);
    assert!(!files.project_exists && !files.manifest_exists);
    assert!(files.dependencies.is_empty() && files.error.is_none());
    fs::write(
        dir.join("Project.toml"),
        "[deps]\nPlots = \"91a5bcdd-55d7-5caf-9e0b-520d859cae80\"\nLinearAlgebra = \"37e2e46d-f89d-539d-b4ee-838fcccc9c8e\"\n\n[compat]\nPlots = \"1\"\n",
    )
    .unwrap();
    let files = read_environment_files(dir);
    assert!(files.project_exists && !files.manifest_exists);
    let names: Vec<_> = files.dependencies.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["LinearAlgebra", "Plots"]);
    assert_eq!(files.dependencies[0].compatibility, None);
    assert_eq!(files.dependencies[1].compatibility.as_deref(), Some("1"));
    assert!(files.dependencies.iter().all(|d| d.version.is_none()));
    fs::write(
        dir.join("Manifest.toml"),
        "julia_version = \"1.11.5\"\nmanifest_format = \"2.0\"\n\n[[deps.Plots]]\nuuid = \"91a5bcdd-55d7-5caf-9e0b-520d859cae80\"\nversion = \"1.40.9\"\n\n[[deps.LinearAlgebra]]\nuuid = \"37e2e46d-f89d-539d-b4ee-838fcccc9c8e\"\n",
    )
    .unwrap();
    let files = read_environment_files(dir);
    assert!(files.manifest_exists);
    assert_eq!(files.dependencies[1].version.as_deref(), Some("1.40.9"));
    assert_eq!(files.dependencies[1].compatibility.as_deref(), Some("1"));
    // A standard library has no version in the Manifest: it is installed, with no number.
    assert_eq!(files.dependencies[0].version, None);
    assert!(files.dependencies[0].installed);
    // The old Manifest format lists packages at the top level.
    fs::write(
        dir.join("Manifest.toml"),
        "[[Plots]]\nuuid = \"91a5bcdd-55d7-5caf-9e0b-520d859cae80\"\nversion = \"1.38.0\"\n",
    )
    .unwrap();
    let files = read_environment_files(dir);
    assert_eq!(files.dependencies[1].version.as_deref(), Some("1.38.0"));
    assert!(!files.dependencies[0].installed);
    fs::write(dir.join("Project.toml"), "[deps\n").unwrap();
    assert!(read_environment_files(dir).error.is_some());
}
#[test]
fn preview_fingerprints_allow_broken_source_but_validate_target_metadata() {
    use equavela_core::environment::{
        environment_metadata_fingerprint, environment_metadata_snapshot,
    };
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("Project.toml"), "[broken").unwrap();
    assert!(environment_metadata_snapshot(temp.path()).is_err());
    let source = environment_metadata_fingerprint(temp.path()).unwrap();
    fs::write(temp.path().join("Project.toml"), "[deps]\n").unwrap();
    assert_ne!(
        source,
        environment_metadata_fingerprint(temp.path()).unwrap()
    );
    fs::write(temp.path().join("Manifest-v1.11.toml"), "[deps]\n").unwrap();
    let before = environment_metadata_snapshot(temp.path()).unwrap();
    fs::rename(
        temp.path().join("Manifest-v1.11.toml"),
        temp.path().join("Manifest-v1.12.toml"),
    )
    .unwrap();
    assert_ne!(before, environment_metadata_snapshot(temp.path()).unwrap());
}

#[cfg(unix)]
#[test]
fn broken_link_source_can_be_fingerprinted_without_following_it() {
    use equavela_core::environment::{
        environment_metadata_fingerprint, environment_metadata_snapshot,
    };
    let temp = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink("missing-source", temp.path().join("Project.toml")).unwrap();
    assert!(environment_metadata_snapshot(temp.path()).is_err());
    let before = environment_metadata_fingerprint(temp.path()).unwrap();
    fs::remove_file(temp.path().join("Project.toml")).unwrap();
    fs::write(temp.path().join("Project.toml"), "[deps]\n").unwrap();
    assert_ne!(
        before,
        environment_metadata_fingerprint(temp.path()).unwrap()
    );
}
