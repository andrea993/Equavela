use equavela_core::image::{AssetReference, ImageMedia, ImageResource};
use equavela_core::project_directory::{
    create_project, create_project_with_files, find_worksheet_project, list_image_assets,
    load_project_directory, read_asset, store_asset, ProjectDirectoryError,
};
use equavela_core::project_manifest::{ProjectManifest, WorksheetEntry, PROJECT_FORMAT};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const PROJECT_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
const SHEET_ID: &str = "123e4567-e89b-42d3-a456-426614174001";
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temporary_directory() -> PathBuf {
    let root = std::env::temp_dir();
    loop {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!("equavela-project-test-{}-{id}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("cannot create test directory: {error}"),
        }
    }
}

fn manifest() -> ProjectManifest {
    ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: PROJECT_ID.into(),
        name: "Basic project".into(),
        worksheets: vec![WorksheetEntry {
            id: SHEET_ID.into(),
            path: "worksheets/main.eqv".into(),
        }],
        main_worksheet: None,
        environment: Some("julia/environment".into()),
        exports: Vec::new(),
        references: Vec::new(),
        julia_modules: Vec::new(),
    }
}

fn worksheet() -> String {
    "format: equavela-worksheet/3\nregions:\n  - id: a\n    math: \"x := 2\"\n".into()
}

fn payloads() -> BTreeMap<String, String> {
    BTreeMap::from([(SHEET_ID.into(), worksheet())])
}

fn create_at(destination: &Path) {
    create_project(destination, &manifest(), &payloads()).unwrap();
}

#[test]
fn creates_and_loads_project_with_initial_worksheet() {
    let parent = temporary_directory();
    let destination = parent.join("A project");
    create_at(&destination);

    let loaded = load_project_directory(&destination).unwrap();
    assert_eq!(loaded.manifest, manifest());
    assert_eq!(
        fs::read_to_string(destination.join("worksheets/main.eqv")).unwrap(),
        worksheet()
    );
    assert!(destination.join("equavela-project.yaml").is_file());
    assert!(destination.join("julia/environment").is_dir());

    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn canonical_project_worksheet_paths_round_trip_through_document_ids() {
    let parent = temporary_directory();
    let destination = parent.join("OneDrive - Company").join("A project");
    fs::create_dir_all(destination.parent().unwrap()).unwrap();
    create_at(&destination);
    let loaded = load_project_directory(&destination).unwrap();
    let canonical = loaded.root.join("worksheets/main.eqv");
    let original = destination.join("worksheets/main.eqv");
    use equavela_core::worksheet_file::{document_id_for_path, load_project, path_for_document};
    let id = document_id_for_path(&canonical).unwrap();
    assert_eq!(id, document_id_for_path(&original).unwrap());
    assert_eq!(
        fs::read_to_string(path_for_document(&id)).unwrap(),
        worksheet()
    );
    load_project(&canonical).unwrap();
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn refuses_existing_destination_without_changing_it() {
    let parent = temporary_directory();
    let destination = parent.join("existing");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("keep.txt"), "preserve me").unwrap();

    assert!(matches!(
        create_project(&destination, &manifest(), &payloads()),
        Err(ProjectDirectoryError::AlreadyExists { .. })
    ));
    assert_eq!(
        fs::read_to_string(destination.join("keep.txt")).unwrap(),
        "preserve me"
    );
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);

    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn invalid_manifest_or_sheet_leaves_no_project_or_staging_directory() {
    let parent = temporary_directory();
    let destination = parent.join("new-project");
    let mut invalid = manifest();
    invalid.worksheets[0].path = "../escape.eqv".into();
    assert!(create_project(&destination, &invalid, &payloads()).is_err());
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);

    let invalid_sheet = BTreeMap::from([(SHEET_ID.into(), "not worksheet yaml: [".into())]);
    assert!(matches!(
        create_project(&destination, &manifest(), &invalid_sheet),
        Err(ProjectDirectoryError::InvalidWorksheet { .. })
    ));
    assert!(!destination.exists());
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);

    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn missing_declared_worksheet_is_rejected_on_load() {
    let parent = temporary_directory();
    let destination = parent.join("project");
    create_at(&destination);
    fs::remove_file(destination.join("worksheets/main.eqv")).unwrap();
    assert!(matches!(
        load_project_directory(&destination),
        Err(ProjectDirectoryError::Io { .. })
    ));

    fs::remove_dir_all(parent).unwrap();
}

#[cfg(unix)]
#[test]
fn loader_rejects_worksheet_symlink() {
    let parent = temporary_directory();
    let destination = parent.join("project");
    create_at(&destination);
    let worksheet_path = destination.join("worksheets/main.eqv");
    fs::remove_file(&worksheet_path).unwrap();
    let outside = parent.join("outside.eqv");
    fs::write(&outside, worksheet()).unwrap();
    std::os::unix::fs::symlink(&outside, &worksheet_path).unwrap();

    assert!(matches!(
        load_project_directory(&destination),
        Err(ProjectDirectoryError::Symlink { .. })
    ));
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn worksheet_payloads_must_match_manifest_entries_exactly() {
    let parent = temporary_directory();
    let destination = parent.join("project");
    let missing = BTreeMap::new();
    assert!(matches!(
        create_project(&destination, &manifest(), &missing),
        Err(ProjectDirectoryError::MissingWorksheetPayload(_))
    ));
    let extra = BTreeMap::from([
        (SHEET_ID.into(), worksheet()),
        ("123e4567-e89b-42d3-a456-426614174099".into(), worksheet()),
    ]);
    assert!(matches!(
        create_project(&destination, &manifest(), &extra),
        Err(ProjectDirectoryError::UnexpectedWorksheetPayload(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 0);
    fs::remove_dir_all(parent).unwrap();
}

const PNG: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0,
    2, 0, 0, 0, 1, 8, 6, 0, 0, 0,
];

fn png(tag: u8) -> ImageResource {
    let mut data = PNG.to_vec();
    data.push(tag);
    ImageResource {
        media: ImageMedia::Png,
        data,
    }
}

#[test]
fn a_worksheet_finds_the_project_that_declares_it() {
    // the nearest manifest that lists the file, from the worksheet's own folder up.
    let parent = temporary_directory();
    let root = parent.join("project");
    create_at(&root);
    fs::create_dir_all(root.join("julia/environment")).unwrap();
    let found = find_worksheet_project(&root.join("worksheets/main.eqv")).unwrap();
    assert_eq!(found, root.canonicalize().unwrap());
    fs::write(root.join("worksheets/stray.eqv"), worksheet()).unwrap();
    assert_eq!(
        find_worksheet_project(&root.join("worksheets/stray.eqv")),
        None
    );
    fs::write(parent.join("alone.eqv"), worksheet()).unwrap();
    assert_eq!(find_worksheet_project(&parent.join("alone.eqv")), None);
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn assets_are_stored_once_named_portably_and_read_back() {
    // identical bytes reuse the file; a name collision gets a suffix.
    let parent = temporary_directory();
    let root = parent.join("project");
    create_at(&root);
    assert!(list_image_assets(&root).unwrap().is_empty());
    let first = store_asset(&root, &png(1), "beam").unwrap();
    assert_eq!(first, "assets/images/beam.png");
    assert_eq!(store_asset(&root, &png(1), "other").unwrap(), first);
    assert_eq!(
        store_asset(&root, &png(2), "beam").unwrap(),
        "assets/images/beam-2.png"
    );
    assert_eq!(
        store_asset(&root, &png(3), "a:b/c.d ").unwrap(),
        "assets/images/a-b-c-d.png"
    );
    assert_eq!(
        store_asset(&root, &png(4), "..").unwrap(),
        "assets/images/image.png"
    );
    assert_eq!(
        store_asset(&root, &png(5), "Con").unwrap(),
        "assets/images/Con-.png"
    );
    assert_eq!(
        list_image_assets(&root).unwrap(),
        [
            "a-b-c-d.png",
            "beam-2.png",
            "beam.png",
            "Con-.png",
            "image.png"
        ]
    );
    let asset = |path: &str| AssetReference {
        media: ImageMedia::Png,
        path: path.into(),
    };
    assert_eq!(read_asset(&root, &asset(&first)).unwrap(), png(1));
    let missing = read_asset(&root, &asset("assets/images/none.png")).unwrap_err();
    assert!(missing.contains("none.png"), "{missing}");
    fs::write(root.join("assets/images/fake.png"), b"not a png").unwrap();
    let fake = read_asset(&root, &asset("assets/images/fake.png")).unwrap_err();
    assert!(fake.contains("not a valid png"), "{fake}");
    fs::remove_dir_all(parent).unwrap();
}

#[cfg(unix)]
#[test]
fn an_asset_behind_a_symbolic_link_is_refused() {
    let parent = temporary_directory();
    let root = parent.join("project");
    create_at(&root);
    fs::write(parent.join("outside.png"), &png(1).data).unwrap();
    fs::create_dir_all(root.join("assets/images")).unwrap();
    std::os::unix::fs::symlink(
        parent.join("outside.png"),
        root.join("assets/images/link.png"),
    )
    .unwrap();
    let asset = AssetReference {
        media: ImageMedia::Png,
        path: "assets/images/link.png".into(),
    };
    let error = read_asset(&root, &asset).unwrap_err();
    assert!(error.contains("symbolic link"), "{error}");
    assert!(!list_image_assets(&root)
        .unwrap()
        .contains(&"link.png".to_owned()));
    fs::remove_dir_all(parent).unwrap();
}

#[test]
fn extra_files_are_written_before_publication_and_must_be_portable_and_free() {
    // the environment files of a converted worksheet.
    let parent = temporary_directory();
    let destination = parent.join("converted");
    let files = BTreeMap::from([(
        "julia/environment/Project.toml".to_owned(),
        b"[deps]\n".to_vec(),
    )]);
    create_project_with_files(&destination, &manifest(), &payloads(), &files).unwrap();
    assert_eq!(
        fs::read(destination.join("julia/environment/Project.toml")).unwrap(),
        b"[deps]\n"
    );
    load_project_directory(&destination).unwrap();

    for bad in [
        "../outside.toml",
        "worksheets/MAIN.eqv",
        "equavela-project.yaml",
    ] {
        let target = parent.join("refused");
        let files = BTreeMap::from([(bad.to_owned(), b"x".to_vec())]);
        assert!(
            create_project_with_files(&target, &manifest(), &payloads(), &files).is_err(),
            "{bad}"
        );
        assert!(!target.exists(), "{bad}");
    }
    assert_eq!(
        fs::read_dir(&parent).unwrap().count(),
        1,
        "no staging folder is left"
    );
    fs::remove_dir_all(parent).unwrap();
}
