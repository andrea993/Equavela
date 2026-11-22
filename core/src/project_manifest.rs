//! Portable, filesystem-independent manifest for a Equavela folder project.
//!
//! This is durable project metadata, distinct from [`crate::project::Project`], which is
//! the in-memory worksheet/include analysis model. Parsing and validation never access the
//! filesystem or start the Julia kernel.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use thiserror::Error;

pub const PROJECT_FORMAT: &str = "equavela-project/1";

/// Durable metadata for a folder-based Equavela project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectManifest {
    pub format: String,
    /// Stable project identity, supplied by the caller as a canonical lowercase UUID.
    pub project_id: String,
    pub name: String,
    pub worksheets: Vec<WorksheetEntry>,
    /// The main worksheet of manifests written before : read and ignored, never written.
    /// A project's worksheets are ordinary files.
    #[serde(default, skip_serializing)]
    pub main_worksheet: Option<String>,
    /// Project-relative Julia environment directory. `None` selects the standard environment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// Public definitions other projects may use.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exports: Vec<ExportEntry>,
    /// Projects whose exports this project uses under an alias.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<ReferenceEntry>,
    /// Project-relative `.jl` files every worksheet of the project loads.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub julia_modules: Vec<String>,
}

/// one exported definition region.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportEntry {
    pub id: String,
    /// The UUID of the worksheet that defines it.
    pub worksheet: String,
    /// The id of the definition region in that worksheet.
    pub region: String,
}

/// a referenced project, its folder relative to this project's root and its locked API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReferenceEntry {
    pub alias: String,
    pub project_id: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub api: Vec<ApiEntry>,
}

/// an export as the consumer saw it when the reference was added or updated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiEntry {
    pub id: String,
    /// Math linear text of the exported name.
    pub name: String,
    pub kind: ExportKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arity: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Value,
    Function,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorksheetEntry {
    /// Stable worksheet identity, independent of its logical path.
    pub id: String,
    /// Portable path relative to the project root.
    pub path: String,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ManifestError {
    #[error("invalid project manifest YAML: {0}")]
    Yaml(String),
    #[error("unsupported project manifest format `{0}`")]
    Format(String),
    #[error("{field} must be a canonical lowercase UUID")]
    Uuid { field: String },
    #[error("project name must not be empty")]
    EmptyName,
    #[error("project must contain at least one worksheet")]
    NoWorksheets,
    #[error("worksheet id `{0}` is duplicated")]
    DuplicateWorksheetId(String),
    #[error("worksheet path `{0}` is duplicated (paths are case-insensitive for portability)")]
    DuplicateWorksheetPath(String),
    #[error("export id `{0}` is duplicated")]
    DuplicateExportId(String),
    #[error("region `{region}` of worksheet `{worksheet}` is exported twice")]
    DuplicateExport { worksheet: String, region: String },
    #[error("export `{0}` has an empty region id")]
    ExportRegion(String),
    #[error(
        "invalid reference alias `{0}`: use a letter followed by letters or digits, not `julia`"
    )]
    InvalidAlias(String),
    #[error("reference alias `{0}` is duplicated")]
    DuplicateAlias(String),
    #[error("project `{0}` is referenced twice")]
    DuplicateReference(String),
    #[error("a project cannot reference itself")]
    SelfReference,
    #[error("reference `{alias}`: {reason}")]
    InvalidReferenceApi { alias: String, reason: String },
    #[error("invalid {field} path `{path}`: {reason}")]
    InvalidPath {
        field: String,
        path: String,
        reason: String,
    },
}

impl ProjectManifest {
    /// Parse and validate a YAML manifest. No paths are opened or resolved on disk.
    pub fn from_yaml(yaml: &str) -> Result<Self, ManifestError> {
        let mut manifest: Self =
            serde_saphyr::from_str(yaml).map_err(|error| ManifestError::Yaml(error.to_string()))?;
        if manifest.format == crate::former_names::PROJECT_FORMAT {
            manifest.format = PROJECT_FORMAT.into();
        }
        manifest.validate()?;
        Ok(manifest)
    }

    /// Validate this value before it is used or serialized.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.format != PROJECT_FORMAT {
            return Err(ManifestError::Format(self.format.clone()));
        }
        validate_uuid(&self.project_id, "project_id")?;
        if self.name.trim().is_empty() {
            return Err(ManifestError::EmptyName);
        }
        if self.worksheets.is_empty() {
            return Err(ManifestError::NoWorksheets);
        }

        let mut ids = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for worksheet in &self.worksheets {
            validate_uuid(&worksheet.id, "worksheet id")?;
            if !ids.insert(worksheet.id.as_str()) {
                return Err(ManifestError::DuplicateWorksheetId(worksheet.id.clone()));
            }
            validate_relative_path("worksheet", &worksheet.path, true)?;
            if !paths.insert(worksheet.path.to_lowercase()) {
                return Err(ManifestError::DuplicateWorksheetPath(
                    worksheet.path.clone(),
                ));
            }
        }
        if let Some(environment) = &self.environment {
            validate_relative_path("environment", environment, false)?;
        }
        self.validate_exports()?;
        let mut modules = BTreeSet::new();
        for path in &self.julia_modules {
            validate_relative_path("Julia module", path, false)?;
            if !path.ends_with(".jl") || !modules.insert(path.to_lowercase()) {
                return Err(ManifestError::InvalidPath {
                    field: "Julia module".into(),
                    path: path.clone(),
                    reason: "a Julia module is a `.jl` file listed once".into(),
                });
            }
        }
        self.validate_references()
    }

    fn validate_exports(&self) -> Result<(), ManifestError> {
        let mut ids = BTreeSet::new();
        let mut regions = BTreeSet::new();
        for export in &self.exports {
            validate_uuid(&export.id, "export id")?;
            if !ids.insert(export.id.as_str()) {
                return Err(ManifestError::DuplicateExportId(export.id.clone()));
            }
            // an export of a worksheet that is gone stays listed, as broken.
            validate_uuid(&export.worksheet, "export worksheet")?;
            if export.region.trim().is_empty() {
                return Err(ManifestError::ExportRegion(export.id.clone()));
            }
            if !regions.insert((export.worksheet.as_str(), export.region.as_str())) {
                return Err(ManifestError::DuplicateExport {
                    worksheet: export.worksheet.clone(),
                    region: export.region.clone(),
                });
            }
        }
        Ok(())
    }

    fn validate_references(&self) -> Result<(), ManifestError> {
        let mut aliases = BTreeSet::new();
        let mut projects = BTreeSet::new();
        for reference in &self.references {
            if !is_alias(&reference.alias) {
                return Err(ManifestError::InvalidAlias(reference.alias.clone()));
            }
            if !aliases.insert(reference.alias.to_lowercase()) {
                return Err(ManifestError::DuplicateAlias(reference.alias.clone()));
            }
            validate_uuid(&reference.project_id, "reference project_id")?;
            if reference.project_id == self.project_id {
                return Err(ManifestError::SelfReference);
            }
            if !projects.insert(reference.project_id.as_str()) {
                return Err(ManifestError::DuplicateReference(
                    reference.project_id.clone(),
                ));
            }
            validate_reference_path(&reference.path)?;
            let mut api = BTreeSet::new();
            let mut names = BTreeSet::new();
            for entry in &reference.api {
                let bad = |reason: &str| ManifestError::InvalidReferenceApi {
                    alias: reference.alias.clone(),
                    reason: reason.into(),
                };
                validate_uuid(&entry.id, "reference api id")?;
                if !api.insert(entry.id.as_str()) {
                    return Err(bad("an export id is listed twice"));
                }
                if entry.name.trim().is_empty() || !names.insert(entry.name.as_str()) {
                    return Err(bad("export names must be present and unique"));
                }
                if (entry.kind == ExportKind::Function) != entry.arity.is_some() {
                    return Err(bad("a function has an arity and a value has none"));
                }
            }
        }
        Ok(())
    }

    /// Serialize a validated manifest as readable YAML.
    pub fn to_yaml(&self) -> Result<String, ManifestError> {
        self.validate()?;
        serde_saphyr::to_string(self).map_err(|error| ManifestError::Yaml(error.to_string()))
    }
}

fn validate_uuid(value: &str, field: &str) -> Result<(), ManifestError> {
    let valid = value.len() == 36
        && [8, 13, 18, 23]
            .iter()
            .all(|index| value.as_bytes()[*index] == b'-')
        && value.bytes().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(&byte)
        });
    if valid {
        Ok(())
    } else {
        Err(ManifestError::Uuid {
            field: field.into(),
        })
    }
}

/// a plain identifier, a letter then letters or digits, that is not `julia`.
pub fn is_alias(alias: &str) -> bool {
    let mut chars = alias.chars();
    chars.next().is_some_and(char::is_alphabetic)
        && chars.all(char::is_alphanumeric)
        && !alias.eq_ignore_ascii_case("julia")
}

/// a referenced project's folder, relative to the consumer's root. Leading `..`
/// components may leave the consumer's folder; everything else follows the portable rules.
pub fn validate_reference_path(path: &str) -> Result<(), ManifestError> {
    let mut rest = path;
    while let Some(tail) = rest.strip_prefix("../") {
        rest = tail;
    }
    if rest == ".." {
        return Err(ManifestError::InvalidPath {
            field: "reference".into(),
            path: path.into(),
            reason: "the path must name a project folder".into(),
        });
    }
    validate_relative_path("reference", rest, false).map_err(|error| match error {
        ManifestError::InvalidPath { reason, .. } => ManifestError::InvalidPath {
            field: "reference".into(),
            path: path.into(),
            reason,
        },
        other => other,
    })
}

/// Checks a portable project-relative path (`/` separators, no `.`/`..`, Windows-safe names), as
/// the manifest's paths are checked. Used for project asset paths.
pub fn validate_portable_path(field: &str, path: &str) -> Result<(), ManifestError> {
    validate_relative_path(field, path, false)
}

fn validate_relative_path(field: &str, path: &str, worksheet: bool) -> Result<(), ManifestError> {
    let invalid = |reason: &str| ManifestError::InvalidPath {
        field: field.into(),
        path: path.into(),
        reason: reason.into(),
    };
    if path.is_empty() {
        return Err(invalid("path is empty"));
    }
    if path.starts_with('/') || path.contains('\\') || path.contains(':') {
        return Err(invalid("path must be relative and use `/` separators"));
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(invalid("empty, `.` and `..` components are not allowed"));
        }
        if component
            .chars()
            .any(|ch| ch.is_control() || "<>\"|?*".contains(ch))
        {
            return Err(invalid(
                "component contains a character not portable to Windows",
            ));
        }
        if component.ends_with([' ', '.']) {
            return Err(invalid("component may not end in a space or dot"));
        }
        let stem = component.split('.').next().unwrap_or(component);
        let upper = stem.to_ascii_uppercase();
        let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (upper.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && matches!(upper.as_bytes()[3], b'1'..=b'9'));
        if reserved {
            return Err(invalid("component is a reserved Windows device name"));
        }
    }
    if worksheet && !path.ends_with(".eqv") {
        return Err(invalid("worksheet path must end in `.eqv`"));
    }
    Ok(())
}
