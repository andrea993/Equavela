//! Which Julia environment a worksheet uses:
//! the project's, an override the worksheet names, or the shared environment of
//! standalone worksheets.

use crate::project::DocumentId;
use crate::project_directory::{find_worksheet_project, MANIFEST_FILE};
use crate::project_manifest::ProjectManifest;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where the environment of a worksheet comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvironmentKind {
    /// The environment shared by every standalone worksheet.
    Shared,
    /// The environment of the folder project that declares the worksheet.
    Project,
    /// The directory the standalone worksheet names in its `environment:` key.
    Override,
    /// The environment a portable `.eqvz` document carries, materialized for it.
    Archive,
}

/// The resolved environment of a worksheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorksheetEnvironment {
    pub kind: EnvironmentKind,
    /// Absolute directory (it may not exist yet: the shared one is created on demand).
    pub directory: PathBuf,
    /// An override given as an absolute path: the worksheet is not portable.
    pub absolute: bool,
    /// Problems of the resolution: a missing override, a key ignored in a project.
    pub problems: Vec<String>,
}

impl WorksheetEnvironment {
    /// Whether the worksheet's Julia code may use the directory. A project or override
    /// directory that does not exist is not replaced by another environment; the shared
    /// one is created on demand.
    pub fn usable(&self) -> bool {
        self.kind == EnvironmentKind::Shared || self.directory.is_dir()
    }
}

/// The environment of the worksheet `root` (its file path, or an untitled id) whose
/// `environment:` key is `declared`, with `shared` the shared environment directory.
pub fn resolve_environment(
    root: &DocumentId,
    declared: Option<&str>,
    shared: &Path,
) -> WorksheetEnvironment {
    resolve_environment_with_archive(root, declared, shared, None)
}

/// As [`resolve_environment`], for a worksheet opened from a portable document whose
/// environment was materialized in `archive`: that directory wins over every other rule.
pub fn resolve_environment_with_archive(
    root: &DocumentId,
    declared: Option<&str>,
    shared: &Path,
    archive: Option<&Path>,
) -> WorksheetEnvironment {
    if let Some(directory) = archive {
        let mut problems = Vec::new();
        if let Some(key) = declared {
            problems.push(format!(
                "the worksheet's environment `{key}` is ignored: a portable document uses the environment it carries"
            ));
        }
        return WorksheetEnvironment {
            kind: EnvironmentKind::Archive,
            directory: directory.to_path_buf(),
            absolute: false,
            problems,
        };
    }
    let file = Path::new(root.as_str());
    let saved = file.is_absolute();
    let shared_environment = |problems| WorksheetEnvironment {
        kind: EnvironmentKind::Shared,
        directory: shared.to_path_buf(),
        absolute: false,
        problems,
    };
    if saved {
        if let Some(project) = find_worksheet_project(file) {
            let mut problems = Vec::new();
            if let Some(key) = declared {
                problems.push(format!(
                    "the worksheet's environment `{key}` is ignored: a worksheet of a project uses the project's environment"
                ));
            }
            // find_worksheet_project has just read and parsed this manifest.
            let declared_by_project = std::fs::read_to_string(project.join(MANIFEST_FILE))
                .ok()
                .and_then(|yaml| ProjectManifest::from_yaml(&yaml).ok())
                .and_then(|manifest| manifest.environment);
            let Some(relative) = declared_by_project else {
                return shared_environment(problems);
            };
            let directory = project.join(relative);
            if !directory.is_dir() {
                problems.push(format!(
                    "the project's Julia environment `{}` is not a directory",
                    directory.display()
                ));
            }
            return WorksheetEnvironment {
                kind: EnvironmentKind::Project,
                directory,
                absolute: false,
                problems,
            };
        }
    }
    match (declared, file.parent().filter(|_| saved)) {
        (Some(key), Some(folder)) => {
            let absolute = Path::new(key).is_absolute();
            let directory = if absolute {
                PathBuf::from(key)
            } else {
                folder.join(key)
            };
            let mut problems = Vec::new();
            if !directory.is_dir() {
                problems.push(format!(
                    "the worksheet's Julia environment `{}` is not a directory",
                    directory.display()
                ));
            }
            WorksheetEnvironment {
                kind: EnvironmentKind::Override,
                directory,
                absolute,
                problems,
            }
        }
        // an untitled worksheet has no folder to resolve an override against.
        _ => shared_environment(Vec::new()),
    }
}

/// A direct dependency of an environment, as the manager lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentDependency {
    pub name: String,
    pub uuid: String,
    /// The version `Manifest.toml` resolves (a standard library has none).
    pub version: Option<String>,
    /// Requested version range from Project.toml, independent of the resolved version.
    #[serde(default)]
    pub compatibility: Option<String>,
    /// Whether `Manifest.toml` lists the package.
    pub installed: bool,
}

/// What the environment's files say, read without running Julia.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentFiles {
    pub project_toml: PathBuf,
    pub project_exists: bool,
    pub manifest_toml: PathBuf,
    pub manifest_exists: bool,
    /// Sorted by name.
    pub dependencies: Vec<EnvironmentDependency>,
    /// A file that exists but cannot be read or parsed.
    pub error: Option<String>,
}

/// The project and manifest files of an environment directory, preferring Julia's
/// `JuliaProject.toml`/`JuliaManifest.toml` names when they exist, as Julia does.
fn environment_file(directory: &Path, preferred: &str, plain: &str) -> PathBuf {
    let preferred = directory.join(preferred);
    if preferred.is_file() {
        preferred
    } else {
        directory.join(plain)
    }
}

/// Reads the direct dependencies of the environment in `directory` and the versions its
/// manifest resolves.
pub fn read_environment_files(directory: &Path) -> EnvironmentFiles {
    let project_toml = environment_file(directory, "JuliaProject.toml", "Project.toml");
    let manifest_toml = environment_file(directory, "JuliaManifest.toml", "Manifest.toml");
    let mut files = EnvironmentFiles {
        project_exists: project_toml.is_file(),
        manifest_exists: manifest_toml.is_file(),
        project_toml,
        manifest_toml,
        dependencies: Vec::new(),
        error: None,
    };
    let read = |path: &Path| -> Result<toml::Table, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        text.parse::<toml::Table>()
            .map_err(|error| format!("{}: {error}", path.display()))
    };
    if !files.project_exists {
        return files;
    }
    let project = match read(&files.project_toml) {
        Ok(project) => project,
        Err(error) => {
            files.error = Some(error);
            return files;
        }
    };
    // Manifest format 2.0 keeps packages under `deps`; format 1 at the top level.
    let manifest = if files.manifest_exists {
        match read(&files.manifest_toml) {
            Ok(manifest) => Some(manifest),
            Err(error) => {
                files.error = Some(error);
                None
            }
        }
    } else {
        None
    };
    let packages = manifest
        .as_ref()
        .map(|manifest| match manifest.get("deps") {
            Some(toml::Value::Table(deps)) if manifest.contains_key("manifest_format") => deps,
            _ => manifest,
        });
    if let Some(toml::Value::Table(deps)) = project.get("deps") {
        for (name, uuid) in deps {
            let entry = packages
                .and_then(|packages| packages.get(name))
                .and_then(|entries| entries.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.as_table());
            files.dependencies.push(EnvironmentDependency {
                name: name.clone(),
                uuid: uuid.as_str().unwrap_or_default().to_owned(),
                version: entry
                    .and_then(|entry| entry.get("version"))
                    .and_then(|version| version.as_str())
                    .map(str::to_owned),
                installed: entry.is_some(),
                compatibility: project
                    .get("compat")
                    .and_then(|compat| compat.get(name))
                    .and_then(|bound| bound.as_str())
                    .map(str::to_owned),
            });
        }
    }
    files.dependencies.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

/// Filenames, existence and bytes of environment metadata at one point in time.
pub type EnvironmentMetadataSnapshot = Vec<(String, Option<Vec<u8>>)>;

/// Validate and snapshot all recognized Julia environment metadata without executing Julia.
pub fn environment_metadata_snapshot(
    directory: &Path,
) -> Result<EnvironmentMetadataSnapshot, String> {
    metadata_snapshot(directory, true)
}

/// Fingerprint the previous environment even when its TOML is broken, to permit recovery.
pub fn environment_metadata_fingerprint(
    directory: &Path,
) -> Result<EnvironmentMetadataSnapshot, String> {
    metadata_snapshot(directory, false)
}

fn metadata_snapshot(
    directory: &Path,
    validate: bool,
) -> Result<EnvironmentMetadataSnapshot, String> {
    use std::io::Read;
    let mut result = Vec::new();
    let mut names: Vec<String> = [
        "JuliaProject.toml",
        "Project.toml",
        "JuliaManifest.toml",
        "Manifest.toml",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    match std::fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if (name.starts_with("Manifest-v") || name.starts_with("JuliaManifest-v"))
                    && name.ends_with(".toml")
                {
                    names.push(name);
                    if names.len() > 64 {
                        return Err("too many environment metadata files (maximum 64)".into());
                    }
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("{}: {error}", directory.display())),
    }
    names.sort();
    let mut total_bytes = 0usize;
    for name in names {
        let path = directory.join(&name);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                result.push((name, None));
                continue;
            }
            Err(error) => return Err(format!("{}: {error}", path.display())),
        };
        if !metadata.file_type().is_file() {
            if validate {
                return Err(format!("{}: expected a regular file", path.display()));
            }
            // Fingerprint a broken source without following links or opening special files.
            let link = if metadata.file_type().is_symlink() {
                Some(std::fs::read_link(&path).map_err(|error| error.to_string())?)
            } else {
                None
            };
            result.push((
                name,
                Some(format!("nonregular\0{:?}:{link:?}", metadata.file_type()).into_bytes()),
            ));
            continue;
        }
        let file =
            std::fs::File::open(&path).map_err(|error| format!("{}: {error}", path.display()))?;
        if !file
            .metadata()
            .map_err(|error| format!("{}: {error}", path.display()))?
            .is_file()
        {
            return Err(format!("{}: expected a regular file", path.display()));
        }
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!("{}: file exceeds 16 MiB", path.display()));
        }
        total_bytes += bytes.len();
        if total_bytes > 64 * 1024 * 1024 {
            return Err("environment metadata exceeds 64 MiB in total".into());
        }
        if validate {
            let text = std::str::from_utf8(&bytes)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            text.parse::<toml::Table>()
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
        if !validate {
            bytes.splice(0..0, b"file\0".iter().copied());
        }
        result.push((name, Some(bytes)));
    }
    Ok(result)
}
