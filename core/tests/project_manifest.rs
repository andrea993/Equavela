use equavela_core::project_manifest::{
    is_alias, ApiEntry, ExportEntry, ExportKind, ManifestError, ProjectManifest, ReferenceEntry,
    WorksheetEntry, PROJECT_FORMAT,
};

const PROJECT_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
const SHEET_A: &str = "123e4567-e89b-42d3-a456-426614174001";
const SHEET_B: &str = "123e4567-e89b-42d3-a456-426614174002";

fn manifest() -> ProjectManifest {
    ProjectManifest {
        format: PROJECT_FORMAT.into(),
        project_id: PROJECT_ID.into(),
        name: "Mécanique — étude 東京".into(),
        worksheets: vec![
            WorksheetEntry {
                id: SHEET_A.into(),
                path: "worksheets/Étude.eqv".into(),
            },
            WorksheetEntry {
                id: SHEET_B.into(),
                path: "worksheets/Results 2.eqv".into(),
            },
        ],
        main_worksheet: None,
        environment: Some("julia/env".into()),
        exports: Vec::new(),
        references: Vec::new(),
        julia_modules: Vec::new(),
    }
}

#[test]
fn yaml_round_trip_preserves_unicode_paths_and_stable_ids() {
    let original = manifest();
    let yaml = original.to_yaml().unwrap();
    let decoded = ProjectManifest::from_yaml(&yaml).unwrap();
    assert_eq!(decoded, original);
    assert_eq!(decoded.worksheets[0].id, SHEET_A);
    assert_eq!(decoded.worksheets[0].path, "worksheets/Étude.eqv");
}

#[test]
fn standard_environment_can_be_omitted() {
    let mut value = manifest();
    value.environment = None;
    let decoded = ProjectManifest::from_yaml(&value.to_yaml().unwrap()).unwrap();
    assert_eq!(decoded.environment, None);
}

#[test]
fn rejects_duplicate_ids_paths_and_case_collisions() {
    let mut value = manifest();
    value.worksheets[1].id = SHEET_A.into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateWorksheetId(_))
    ));

    let mut value = manifest();
    value.worksheets[1].path = value.worksheets[0].path.clone();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateWorksheetPath(_))
    ));

    let mut value = manifest();
    value.worksheets[1].path = "WORKSHEETS/ÉTUDE.eqv".into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateWorksheetPath(_))
    ));
}

#[test]
fn rejects_unknown_format_invalid_ids_and_missing_main_entry() {
    let mut value = manifest();
    value.format = "equavela-project/2".into();
    assert!(matches!(value.validate(), Err(ManifestError::Format(_))));

    let mut value = manifest();
    value.project_id = "not-a-uuid".into();
    assert!(matches!(value.validate(), Err(ManifestError::Uuid { .. })));

    // a main worksheet of an old manifest is ignored, whatever it names, and a
    // written manifest has none.
    let mut value = manifest();
    value.main_worksheet = Some("123e4567-e89b-42d3-a456-426614174099".into());
    assert!(value.validate().is_ok());
    assert!(!value.to_yaml().unwrap().contains("main_worksheet"));
}

#[test]
fn rejects_nonportable_worksheet_and_environment_paths() {
    for path in [
        "../escape.eqv",
        "/absolute.eqv",
        "C:/drive.eqv",
        "a\\b.eqv",
        "a//b.eqv",
        "a/./b.eqv",
        "a/CON.eqv",
        "a/b?.eqv",
        "a/b.txt",
    ] {
        let mut value = manifest();
        value.worksheets[0].path = path.into();
        assert!(
            matches!(value.validate(), Err(ManifestError::InvalidPath { .. })),
            "{path}"
        );
    }
    for path in [
        "../outside",
        "/absolute",
        "C:/environment",
        "env\\private",
        "env/COM1",
    ] {
        let mut value = manifest();
        value.environment = Some(path.into());
        assert!(
            matches!(value.validate(), Err(ManifestError::InvalidPath { .. })),
            "{path}"
        );
    }
}

#[test]
fn rejects_empty_worksheet_list_and_unparseable_yaml() {
    let mut value = manifest();
    value.worksheets.clear();
    assert!(matches!(value.validate(), Err(ManifestError::NoWorksheets)));
    assert!(matches!(
        ProjectManifest::from_yaml("[unclosed"),
        Err(ManifestError::Yaml(_))
    ));
}

const EXPORT: &str = "123e4567-e89b-42d3-a456-426614174010";
const OTHER: &str = "123e4567-e89b-42d3-a456-426614174020";

fn with_exports_and_references() -> ProjectManifest {
    let mut value = manifest();
    value.exports = vec![ExportEntry {
        id: EXPORT.into(),
        worksheet: SHEET_A.into(),
        region: "r12".into(),
    }];
    value.references = vec![ReferenceEntry {
        alias: "Thermo".into(),
        project_id: OTHER.into(),
        path: "../../Shared/Thermo dynamics".into(),
        api: vec![
            ApiEntry {
                id: EXPORT.into(),
                name: "c_p".into(),
                kind: ExportKind::Function,
                arity: Some(1),
            },
            ApiEntry {
                id: SHEET_B.into(),
                name: "ρ".into(),
                kind: ExportKind::Value,
                arity: None,
            },
        ],
    }];
    value
}

#[test]
fn exports_and_references_round_trip_and_are_omitted_when_empty() {
    // the specification .
    let value = with_exports_and_references();
    let yaml = value.to_yaml().unwrap();
    assert!(yaml.contains("kind: function"), "{yaml}");
    assert_eq!(ProjectManifest::from_yaml(&yaml).unwrap(), value);
    let plain = manifest().to_yaml().unwrap();
    assert!(
        !plain.contains("exports") && !plain.contains("references"),
        "{plain}"
    );
}

#[test]
fn rejects_invalid_exports() {
    let mut value = with_exports_and_references();
    value.exports.push(value.exports[0].clone());
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateExportId(_))
    ));

    let mut value = with_exports_and_references();
    let mut twice = value.exports[0].clone();
    twice.id = OTHER.into();
    value.exports.push(twice);
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateExport { .. })
    ));

    // an export of a worksheet that is no longer listed stays valid (shown as broken).
    let mut value = with_exports_and_references();
    value.exports[0].worksheet = OTHER.into();
    assert!(value.validate().is_ok());
    value.exports[0].worksheet = "sheet".into();
    assert!(matches!(value.validate(), Err(ManifestError::Uuid { .. })));

    let mut value = with_exports_and_references();
    value.exports[0].region = " ".into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::ExportRegion(_))
    ));
}

#[test]
fn rejects_invalid_references() {
    for alias in ["", "2x", "a.b", "a_b", "julia", "Julia"] {
        assert!(!is_alias(alias), "{alias}");
    }
    assert!(is_alias("Thermo2") && is_alias("Θερμό"));

    let mut value = with_exports_and_references();
    value.references[0].alias = "julia".into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::InvalidAlias(_))
    ));

    let mut value = with_exports_and_references();
    let mut again = value.references[0].clone();
    again.alias = "THERMO".into();
    again.project_id = SHEET_A.into();
    value.references.push(again);
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateAlias(_))
    ));

    let mut value = with_exports_and_references();
    let mut again = value.references[0].clone();
    again.alias = "Other".into();
    value.references.push(again);
    assert!(matches!(
        value.validate(),
        Err(ManifestError::DuplicateReference(_))
    ));

    let mut value = with_exports_and_references();
    value.references[0].project_id = PROJECT_ID.into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::SelfReference)
    ));

    for path in [
        "/abs/Thermo",
        "C:/Thermo",
        "..",
        "../..",
        "a/../b",
        "a\\b",
        "",
    ] {
        let mut value = with_exports_and_references();
        value.references[0].path = path.into();
        assert!(
            matches!(value.validate(), Err(ManifestError::InvalidPath { .. })),
            "{path}"
        );
    }

    let mut value = with_exports_and_references();
    value.references[0].api[1].arity = Some(0);
    assert!(matches!(
        value.validate(),
        Err(ManifestError::InvalidReferenceApi { .. })
    ));

    let mut value = with_exports_and_references();
    value.references[0].api[1].name = "c_p".into();
    assert!(matches!(
        value.validate(),
        Err(ManifestError::InvalidReferenceApi { .. })
    ));
}
