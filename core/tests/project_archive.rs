use equavela_core::eqvz::{EqvzArchive, EqvzKind};
use equavela_core::project_archive;
use equavela_core::project_directory::{create_project, MANIFEST_FILE};
use equavela_core::project_manifest::{ProjectManifest, WorksheetEntry, PROJECT_FORMAT};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use tempfile::tempdir;

const PROJECT_ID: &str = "52f9edb3-d0cc-4c3e-b4a0-2789c29547a5";
const SHEET_ID: &str = "59eefdf2-9079-4331-8824-6f169660a031";

fn manifest(environment: Option<&str>) -> ProjectManifest {
    ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: PROJECT_ID.into(),
        name: "Archive test".into(),
        worksheets: vec![WorksheetEntry {
            id: SHEET_ID.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: environment.map(str::to_owned),
        exports: Vec::new(),
        references: Vec::new(),
        julia_modules: Vec::new(),
    }
}

fn create(root: &Path, worksheet: &str, environment: Option<&str>) {
    create_project(
        root,
        &manifest(environment),
        &BTreeMap::from([(SHEET_ID.into(), worksheet.into())]),
    )
    .unwrap();
}

#[test]
fn pack_extract_roundtrips_shared_asset_include_and_local_environment_source() {
    let source = tempdir().unwrap();
    let project = source.path().join("project");
    let worksheet = "format: equavela-worksheet/3\nresources:\n  logo:\n    media: svg\n    asset: assets/images/logo.svg\nregions:\n  - id: inc\n    at: [0, 10]\n    include: ../modules/shared.eqv\n";
    create(&project, worksheet, Some("julia"));
    fs::create_dir_all(project.join("modules")).unwrap();
    fs::write(
        project.join("modules/shared.eqv"),
        "format: equavela-worksheet/3\nregions: []\n",
    )
    .unwrap();
    fs::create_dir_all(project.join("assets/images")).unwrap();
    fs::write(
        project.join("assets/images/logo.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>",
    )
    .unwrap();
    fs::write(project.join("julia/Project.toml"), "[deps]\n").unwrap();
    fs::write(
        project.join("julia/Manifest.toml"),
        "julia_version = \"1.11.0\"\nmanifest_format = \"2.0\"\nproject_hash = \"abc\"\n",
    )
    .unwrap();
    fs::create_dir_all(project.join("julia/src")).unwrap();
    fs::write(
        project.join("julia/src/ArchiveTest.jl"),
        "module ArchiveTest\nend\n",
    )
    .unwrap();
    // whatever the tree shows travels, a hidden file does not.
    fs::write(project.join("julia/notes.txt"), "keep me").unwrap();
    fs::write(project.join("julia/.cache"), "exclude me").unwrap();

    let bytes = project_archive::pack_project(&project).unwrap();
    let archive = EqvzArchive::decode(&bytes).unwrap();
    assert_eq!(archive.manifest.kind, EqvzKind::Project);
    assert!(archive.entries.contains_key(MANIFEST_FILE));
    assert!(archive.entries.contains_key("modules/shared.eqv"));
    assert!(archive.entries.contains_key("assets/images/logo.svg"));
    assert!(archive.entries.contains_key("julia/src/ArchiveTest.jl"));
    assert!(archive.entries.contains_key("julia/notes.txt"));
    assert!(!archive.entries.contains_key("julia/.cache"));

    let destination = source.path().join("restored");
    let restored = project_archive::extract_project(&bytes, &destination).unwrap();
    assert_eq!(restored.manifest, manifest(Some("julia")));
    assert_eq!(
        fs::read(destination.join("modules/shared.eqv")).unwrap(),
        fs::read(project.join("modules/shared.eqv")).unwrap()
    );
    assert!(destination.join("julia/Project.toml").is_file());
    assert!(
        project.join(MANIFEST_FILE).is_file(),
        "packing preserves the source project"
    );
}

#[test]
fn rejects_absolute_external_and_missing_includes_and_missing_assets() {
    let temp = tempdir().unwrap();
    let external = temp.path().join("outside.eqv");
    fs::write(&external, "format: equavela-worksheet/3\nregions: []\n").unwrap();
    let root = temp.path().join("external");
    create(
        &root,
        &format!(
            "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: {}\n",
            external.display()
        ),
        Some("julia"),
    );
    assert!(project_archive::pack_project(&root)
        .unwrap_err()
        .to_string()
        .contains("absolute worksheet include"));

    let root = temp.path().join("absolute-internal");
    create(
        &root,
        "format: equavela-worksheet/3\nregions: []\n",
        Some("julia"),
    );
    let internal = root.join("worksheets/inside.eqv");
    fs::write(&internal, "format: equavela-worksheet/3\nregions: []\n").unwrap();
    fs::write(
        root.join("worksheets/main.eqv"),
        format!(
            "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: {}\n",
            internal.display()
        ),
    )
    .unwrap();
    assert!(project_archive::pack_project(&root)
        .unwrap_err()
        .to_string()
        .contains("absolute worksheet include"));

    let root = temp.path().join("missing");
    create(&root, "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: absent.eqv\n", Some("julia"));
    assert!(project_archive::pack_project(&root).is_err());

    let root = temp.path().join("asset");
    create(&root, "format: equavela-worksheet/3\nresources:\n  logo:\n    media: svg\n    asset: assets/images/missing.svg\nregions: []\n", Some("julia"));
    let message = project_archive::pack_project(&root)
        .unwrap_err()
        .to_string();
    assert!(message.contains("missing.svg"), "{message}");
}

#[test]
fn rejects_path_dependencies_and_julia_usage_without_shared_environment() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("path-dep");
    create(
        &root,
        "format: equavela-worksheet/3\nregions: []\n",
        Some("julia"),
    );
    fs::write(
        root.join("julia/Project.toml"),
        "[sources.local]\npath = \"../local\"\n",
    )
    .unwrap();
    assert!(project_archive::pack_project(&root)
        .unwrap_err()
        .to_string()
        .contains("local path dependency"));

    let root = temp.path().join("without-env");
    create(&root, "format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n    math: \"Pkg::f(1) =\"\n", None);
    assert!(project_archive::pack_project(&root)
        .unwrap_err()
        .to_string()
        .contains("no project Julia environment"));
}

#[test]
fn extraction_refuses_existing_destination_and_manifest_mismatch() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("source");
    create(
        &root,
        "format: equavela-worksheet/3\nregions: []\n",
        Some("julia"),
    );
    let bytes = project_archive::pack_project(&root).unwrap();
    let existing = temp.path().join("exists");
    fs::create_dir(&existing).unwrap();
    fs::write(existing.join("theirs.txt"), "kept").unwrap();
    assert!(project_archive::extract_project(&bytes, &existing).is_err());
    assert_eq!(
        fs::read_to_string(existing.join("theirs.txt")).unwrap(),
        "kept"
    );
    // success or failure, no staging folder is left beside the destination.
    let fresh = temp.path().join("fresh");
    project_archive::extract_project(&bytes, &fresh).unwrap();
    let leftovers: Vec<_> = fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("eqvz-stage"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    let mut archive = EqvzArchive::decode(&bytes).unwrap();
    archive
        .manifest
        .worksheets
        .push("worksheets/other.eqv".into());
    archive.entries.insert(
        "worksheets/other.eqv".into(),
        b"format: equavela-worksheet/3\nregions: []\n".to_vec(),
    );
    archive.manifest.main = "worksheets/other.eqv".into();
    let malformed = archive.encode().unwrap();
    let dest = temp.path().join("bad");
    assert!(project_archive::extract_project(&malformed, &dest).is_err());
    assert!(!dest.exists());
}

#[test]
fn julia_detection_ignores_strings_and_is_enforced_on_extraction() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("source");
    create(&root, "format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n    math: '\"Pkg::f julia.foo\" ='\n", None);
    let bytes = project_archive::pack_project(&root).unwrap();
    let mut archive = EqvzArchive::decode(&bytes).unwrap();
    archive.entries.insert("worksheets/main.eqv".into(), b"format: equavela-worksheet/3\nregions:\n  - id: m\n    at: [0, 0]\n    math: 'Pkg::f(1) ='\n".to_vec());
    let bytes = archive.encode().unwrap();
    let destination = temp.path().join("dest");
    assert!(project_archive::extract_project(&bytes, &destination)
        .unwrap_err()
        .to_string()
        .contains("no project Julia environment"));
    assert!(!destination.exists());
}

#[test]
fn rejects_local_git_environment_sources() {
    let temp = tempdir().unwrap();
    let root = temp.path().join("source");
    create(
        &root,
        "format: equavela-worksheet/3\nregions: []\n",
        Some("julia"),
    );
    for source in ["file:///tmp/local", "../local", "/tmp/local", "C:/local"] {
        fs::write(
            root.join("julia/Project.toml"),
            format!("[sources.local]\nurl = '{source}'\n"),
        )
        .unwrap();
        assert!(
            project_archive::pack_project(&root)
                .unwrap_err()
                .to_string()
                .contains("local path dependency"),
            "{source}"
        );
    }
    fs::write(
        root.join("julia/Manifest.toml"),
        "[[deps.local]]\nrepo-url = 'file:///tmp/local'\n",
    )
    .unwrap();
    fs::write(root.join("julia/Project.toml"), "[deps]\n").unwrap();
    assert!(project_archive::pack_project(&root).is_err());
}

#[test]
fn the_archive_holds_the_whole_tree_but_nothing_hidden() {
    // data files and Julia sources travel; `.git` and hidden files do not.
    let source = tempdir().unwrap();
    let root = source.path().join("tree");
    create(
        &root,
        "format: equavela-worksheet/3\nregions: []\n",
        Some("julia"),
    );
    fs::create_dir_all(root.join("data")).unwrap();
    fs::write(root.join("data/loads.csv"), "1,2\n").unwrap();
    fs::create_dir_all(root.join("julia/src")).unwrap();
    fs::write(root.join("julia/src/Tools.jl"), "module Tools\nend\n").unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/HEAD"), "ref").unwrap();
    fs::write(root.join(".secret"), "x").unwrap();
    let bytes = project_archive::pack_project(&root).unwrap();
    let archive = EqvzArchive::decode(&bytes).unwrap();
    assert!(archive.entries.contains_key("data/loads.csv"));
    assert!(archive.entries.contains_key("julia/src/Tools.jl"));
    assert!(archive
        .entries
        .keys()
        .all(|name| !name.split('/').any(|part| part.starts_with('.'))));
    let restored = source.path().join("restored");
    project_archive::extract_project(&bytes, &restored).unwrap();
    assert_eq!(
        fs::read_to_string(restored.join("data/loads.csv")).unwrap(),
        "1,2\n"
    );
}

#[test]
fn packing_embeds_referenced_projects_and_their_package_paths() {
    // the specification .
    use equavela_core::project_archive::REFERENCES_FOLDER;
    use equavela_core::project_manifest::{ExportEntry, ReferenceEntry};
    use equavela_core::project_reference::{load_references, read_api};
    const PROVIDER: &str = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
    const PROVIDER_SHEET: &str = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1b2";
    let temp = tempdir().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let provider = base.join("libs/Thermo");
    fs::create_dir_all(base.join("libs")).unwrap();
    fs::create_dir_all(base.join("work")).unwrap();
    let provider_manifest = ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: PROVIDER.into(),
        name: "Thermo".into(),
        worksheets: vec![WorksheetEntry {
            id: PROVIDER_SHEET.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: Some("julia".into()),
        exports: vec![ExportEntry {
            id: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1c3".into(),
            worksheet: PROVIDER_SHEET.into(),
            region: "cp".into(),
        }],
        references: Vec::new(),
        julia_modules: Vec::new(),
    };
    create_project(
        &provider,
        &provider_manifest,
        &BTreeMap::from([(
            PROVIDER_SHEET.into(),
            "format: equavela-worksheet/3\nregions:\n  - id: cp\n    at: [0, 10]\n    math: \"c_p(T) := 2·T\"\n".into(),
        )]),
    )
    .unwrap();
    fs::write(
        provider.join("julia/Project.toml"),
        "name = \"Thermo\"\nuuid = \"0d1e5c4a-8a51-4b8f-9f0e-0c2b1f6f4e21\"\n",
    )
    .unwrap();
    fs::create_dir_all(provider.join("julia/src")).unwrap();
    fs::write(provider.join("julia/src/Thermo.jl"), "module Thermo\nend\n").unwrap();

    let consumer = base.join("work/consumer");
    let mut consumer_manifest = manifest(Some("julia"));
    consumer_manifest.references = vec![ReferenceEntry {
        alias: "Thermo".into(),
        project_id: PROVIDER.into(),
        path: "../../libs/Thermo".into(),
        api: read_api(&provider, &provider_manifest),
    }];
    create_project(
        &consumer,
        &consumer_manifest,
        &BTreeMap::from([(
            SHEET_ID.into(),
            "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 10]\n    math: \"Thermo.c_p(2) =\"\n".into(),
        )]),
    )
    .unwrap();
    // The consumer's environment develops the provider's package by a relative path.
    fs::write(
        consumer.join("julia/Project.toml"),
        "[deps]\nThermo = \"0d1e5c4a-8a51-4b8f-9f0e-0c2b1f6f4e21\"\n",
    )
    .unwrap();
    fs::write(
        consumer.join("julia/Manifest.toml"),
        "julia_version = \"1.11.0\"\nmanifest_format = \"2.0\"\n\n[[deps.Thermo]]\npath = \"../../../libs/Thermo/julia\"\nuuid = \"0d1e5c4a-8a51-4b8f-9f0e-0c2b1f6f4e21\"\n",
    )
    .unwrap();

    let bytes = project_archive::pack_project(&consumer).unwrap();
    let archive = EqvzArchive::decode(&bytes).unwrap();
    let prefix = format!("{REFERENCES_FOLDER}/{PROVIDER}");
    assert_eq!(archive.manifest.references.len(), 1);
    assert_eq!(archive.manifest.references[0].path, prefix);
    assert!(archive
        .entries
        .contains_key(&format!("{prefix}/worksheets/main.eqv")));
    assert!(archive
        .entries
        .contains_key(&format!("{prefix}/julia/src/Thermo.jl")));
    let archived = std::str::from_utf8(&archive.entries["julia/Manifest.toml"]).unwrap();
    assert!(
        archived.contains(&format!("../{prefix}/julia")),
        "{archived}"
    );
    // The source files are left as they are.
    assert!(fs::read_to_string(consumer.join("julia/Manifest.toml"))
        .unwrap()
        .contains("../../../libs/Thermo/julia"));

    let destination = base.join("restored");
    let restored = project_archive::extract_project(&bytes, &destination).unwrap();
    assert_eq!(restored.manifest.references[0].path, prefix);
    let loaded = load_references(&destination, &restored.manifest);
    assert!(
        loaded.references.problems.is_empty(),
        "{:?}",
        loaded.references.problems
    );
    assert_eq!(loaded.references.providers[0].name, "Thermo");
    // Packing the restored project again embeds the same snapshot.
    let again = EqvzArchive::decode(&project_archive::pack_project(&destination).unwrap()).unwrap();
    assert_eq!(again.manifest.references, archive.manifest.references);

    // A changed embedded file is refused.
    let mut tampered = archive.clone();
    tampered.entries.insert(
        format!("{prefix}/worksheets/main.eqv"),
        b"format: equavela-worksheet/3\nregions: []\n".to_vec(),
    );
    let refused = project_archive::extract_project(&tampered.encode().unwrap(), &base.join("bad"))
        .unwrap_err()
        .to_string();
    assert!(refused.contains("recorded hash"), "{refused}");

    // A missing referenced project cannot be packed.
    fs::rename(&provider, base.join("libs/Moved")).unwrap();
    let missing = project_archive::pack_project(&consumer)
        .unwrap_err()
        .to_string();
    assert!(missing.contains("reference `Thermo`"), "{missing}");
}
