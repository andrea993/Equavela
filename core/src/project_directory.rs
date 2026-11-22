//! Filesystem operations for folder-based projects.
//!
//! Project creation writes to a unique sibling staging directory, then renames that
//! directory into place. As with `std::fs::rename`, callers must serialize creators that
//! target the same destination; portable Rust does not expose a cross-platform no-replace
//! directory rename. The manifest is data only: loading never starts Julia.

use crate::image::{
    validate_asset, validate_resource, AssetReference, ImageError, ImageMedia, ImageResource,
    MAX_RESOURCE_BYTES,
};
use crate::project::DocumentId;
use crate::project_manifest::{validate_portable_path, ManifestError, ProjectManifest};
use crate::worksheet_file::parse_document;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

/// The manifest file of a folder project.
pub const MANIFEST_FILE: &str = "equavela-project.yaml";
static STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum ProjectDirectoryError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("worksheet payload for id `{0}` is missing")]
    MissingWorksheetPayload(String),
    #[error("worksheet payload was supplied for unknown id `{0}`")]
    UnexpectedWorksheetPayload(String),
    #[error("worksheet `{worksheet_id}` is invalid: {message}")]
    InvalidWorksheet {
        worksheet_id: String,
        message: String,
    },
    #[error("project directory `{path}` already exists")]
    AlreadyExists { path: PathBuf },
    #[error(
        "project directory `{path}` does not contain a regular manifest or worksheet: {message}"
    )]
    InvalidProjectFile { path: PathBuf, message: String },
    #[error("project path `{path}` contains a symbolic link")]
    Symlink { path: PathBuf },
    #[error("project path `{path}` resolves outside its root")]
    OutsideRoot { path: PathBuf },
    #[error("filesystem error at `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedProjectDirectory {
    /// Canonical path to the folder project.
    pub root: PathBuf,
    pub manifest: ProjectManifest,
}

/// Creates a complete folder project without overwriting an existing destination.
///
/// `worksheets` maps stable worksheet ids from the manifest to canonical `.eqv` YAML text.
/// All content is validated before any filesystem mutation. A successful rename publishes
/// the complete directory atomically on the destination filesystem.
pub fn create_project(
    destination: &Path,
    manifest: &ProjectManifest,
    worksheets: &BTreeMap<String, String>,
) -> Result<(), ProjectDirectoryError> {
    create_project_with_files(destination, manifest, worksheets, &BTreeMap::new())
}

/// [`create_project`] with more files (project-relative portable paths to bytes), written in the
/// staging folder before the project is published, such as the environment files of a converted
/// worksheet. A path that is not portable, or that a worksheet or the manifest uses, is
/// refused.
pub fn create_project_with_files(
    destination: &Path,
    manifest: &ProjectManifest,
    worksheets: &BTreeMap<String, String>,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(), ProjectDirectoryError> {
    manifest.validate()?;
    for path in files.keys() {
        validate_portable_path("file", path)?;
        let taken = path == MANIFEST_FILE
            || manifest
                .worksheets
                .iter()
                .any(|sheet| sheet.path.eq_ignore_ascii_case(path));
        if taken {
            return Err(ProjectDirectoryError::InvalidProjectFile {
                path: PathBuf::from(path),
                message: "the file is a worksheet or the manifest of the project".into(),
            });
        }
    }
    let expected: BTreeSet<_> = manifest
        .worksheets
        .iter()
        .map(|sheet| sheet.id.as_str())
        .collect();
    for id in &expected {
        let text = worksheets
            .get(*id)
            .ok_or_else(|| ProjectDirectoryError::MissingWorksheetPayload((*id).into()))?;
        let sheet = manifest
            .worksheets
            .iter()
            .find(|sheet| sheet.id == **id)
            .expect("id from manifest");
        let document_id = DocumentId::new(&sheet.path).map_err(|error| {
            ProjectDirectoryError::InvalidWorksheet {
                worksheet_id: (*id).into(),
                message: error.to_string(),
            }
        })?;
        parse_document(document_id, text).map_err(|error| {
            ProjectDirectoryError::InvalidWorksheet {
                worksheet_id: (*id).into(),
                message: error.to_string(),
            }
        })?;
    }
    for id in worksheets.keys() {
        if !expected.contains(id.as_str()) {
            return Err(ProjectDirectoryError::UnexpectedWorksheetPayload(
                id.clone(),
            ));
        }
    }
    let manifest_text = manifest.to_yaml()?;

    let destination = absolute_lexical(destination)?;
    if path_exists(&destination) {
        return Err(ProjectDirectoryError::AlreadyExists { path: destination });
    }
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err(io_error(
            parent,
            io::Error::new(io::ErrorKind::NotFound, "parent directory does not exist"),
        ));
    }
    let stage = create_stage(parent, destination.file_name().unwrap_or_default())?;
    let result = (|| {
        if let Some(environment) = &manifest.environment {
            let environment_path = stage.join(Path::new(environment));
            fs::create_dir_all(&environment_path)
                .map_err(|error| io_error(&environment_path, error))?;
        }
        for sheet in &manifest.worksheets {
            let text = worksheets.get(&sheet.id).expect("validated payload map");
            let target = stage.join(Path::new(&sheet.path));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            write_new(&target, text.as_bytes())?;
        }
        for (path, bytes) in files {
            let target = stage.join(Path::new(path));
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
            }
            write_new(&target, bytes)?;
        }
        write_new(&stage.join(MANIFEST_FILE), manifest_text.as_bytes())?;
        if path_exists(&destination) {
            return Err(ProjectDirectoryError::AlreadyExists {
                path: destination.clone(),
            });
        }
        fs::rename(&stage, &destination).map_err(|error| {
            if path_exists(&destination) {
                ProjectDirectoryError::AlreadyExists {
                    path: destination.clone(),
                }
            } else {
                io_error(&destination, error)
            }
        })?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

/// Loads and validates project metadata and verifies every declared worksheet exists.
/// No worksheet is evaluated and no kernel process is started.
pub fn load_project_directory(
    root: &Path,
) -> Result<LoadedProjectDirectory, ProjectDirectoryError> {
    let root = fs::canonicalize(root).map_err(|error| io_error(root, error))?;
    if !root.is_dir() {
        return Err(ProjectDirectoryError::InvalidProjectFile {
            path: root,
            message: "project root is not a directory".into(),
        });
    }
    let _guard = crate::project_tree::ProjectGuard::acquire(&root).map_err(|message| {
        ProjectDirectoryError::InvalidProjectFile {
            path: root.clone(),
            message,
        }
    })?;
    crate::former_names::adopt_project_folder(&root);
    let manifest_path = root.join(MANIFEST_FILE);
    reject_symlink(&manifest_path)?;
    let metadata = fs::metadata(&manifest_path).map_err(|error| io_error(&manifest_path, error))?;
    if !metadata.is_file() {
        return Err(ProjectDirectoryError::InvalidProjectFile {
            path: manifest_path,
            message: "manifest is not a regular file".into(),
        });
    }
    let yaml =
        fs::read_to_string(&manifest_path).map_err(|error| io_error(&manifest_path, error))?;
    let manifest = ProjectManifest::from_yaml(&yaml)?;
    for sheet in &manifest.worksheets {
        verify_contained_file(&root, &sheet.path)?;
    }
    if let Some(environment) = &manifest.environment {
        verify_contained_directory(&root, environment)?;
    }
    Ok(LoadedProjectDirectory { root, manifest })
}

/// Folder of the project's images.
pub const IMAGE_ASSETS: &str = "assets/images";

/// The root of the folder project that declares the worksheet file `worksheet`: the
/// nearest ancestor folder whose manifest lists the same file. `None` when no project does,
/// or when the worksheet path cannot be resolved.
pub fn find_worksheet_project(worksheet: &Path) -> Option<PathBuf> {
    let worksheet = fs::canonicalize(worksheet).ok()?;
    for folder in worksheet.ancestors().skip(1) {
        crate::former_names::adopt_project_folder(folder);
        let manifest_path = folder.join(MANIFEST_FILE);
        if fs::symlink_metadata(&manifest_path).map_or(true, |m| !m.is_file()) {
            continue;
        }
        let Some(manifest) = fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|yaml| ProjectManifest::from_yaml(&yaml).ok())
        else {
            continue;
        };
        let declares = manifest.worksheets.iter().any(|sheet| {
            fs::canonicalize(folder.join(&sheet.path)).is_ok_and(|path| path == worksheet)
        });
        if declares {
            return Some(folder.to_path_buf());
        }
    }
    None
}

/// Checks that a project asset is reachable without reading it: a valid
/// reference, contained in `root`, no symbolic link on the way, a regular file within the size
/// limit. Returns the file's path.
pub fn check_asset(root: &Path, asset: &AssetReference) -> Result<PathBuf, String> {
    validate_asset(asset)?;
    let path = root.join(&asset.path);
    // Every message names the asset: a missing `assets/` folder fails on the folder itself.
    let named = |error: ProjectDirectoryError| format!("asset `{}`: {error}", asset.path);
    verify_components(root, &path).map_err(named)?;
    let metadata = fs::metadata(&path).map_err(|error| named(io_error(&path, error)))?;
    if !metadata.is_file() {
        return Err(format!("asset `{}` is not a regular file", asset.path));
    }
    if metadata.len() > MAX_RESOURCE_BYTES as u64 {
        return Err(format!("asset `{}`: {}", asset.path, ImageError::TooLarge));
    }
    Ok(path)
}

/// Reads a project asset: [`check_asset`], then the bytes are validated and sanitized
/// as an embedded resource is.
pub fn read_asset(root: &Path, asset: &AssetReference) -> Result<ImageResource, String> {
    let path = check_asset(root, asset)?;
    let data = fs::read(&path).map_err(|error| io_error(&path, error).to_string())?;
    validate_resource(ImageResource {
        media: asset.media,
        data,
    })
    .map_err(|error| format!("asset `{}`: {error}", asset.path))
}

/// Stores image bytes as a project asset and returns its project-relative path. A
/// file of `assets/images/` with identical bytes is reused; otherwise a new file is written
/// as `<stem>.<ext>`, with `-2`, `-3`, ... on a name collision. `stem` is reduced to a portable
/// name (`image` when nothing is left).
pub fn store_asset(
    root: &Path,
    resource: &ImageResource,
    stem: &str,
) -> Result<String, ProjectDirectoryError> {
    let _guard = crate::project_tree::ProjectGuard::acquire(root).map_err(|message| {
        ProjectDirectoryError::InvalidProjectFile {
            path: root.to_path_buf(),
            message,
        }
    })?;
    let folder = root.join(IMAGE_ASSETS);
    verify_components(root, &folder).or_else(|error| match error {
        ProjectDirectoryError::Io { ref source, .. }
            if source.kind() == io::ErrorKind::NotFound =>
        {
            Ok(())
        }
        error => Err(error),
    })?;
    fs::create_dir_all(&folder).map_err(|error| io_error(&folder, error))?;
    reject_symlink(&folder)?;
    for name in list_image_assets(root)? {
        let path = folder.join(&name);
        if fs::read(&path).is_ok_and(|bytes| bytes == resource.data) {
            return Ok(format!("{IMAGE_ASSETS}/{name}"));
        }
    }
    let extension = match resource.media {
        ImageMedia::Png => "png",
        ImageMedia::Jpeg => "jpg",
        ImageMedia::Svg => "svg",
    };
    let stem = portable_stem(stem);
    for n in 1u32.. {
        let name = if n == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{n}.{extension}")
        };
        let path = folder.join(&name);
        match write_new(&path, &resource.data) {
            Ok(()) => return Ok(format!("{IMAGE_ASSETS}/{name}")),
            Err(ProjectDirectoryError::Io { source, .. })
                if source.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    unreachable!("an unused file name is always found")
}

/// The file names in `assets/images/`, sorted case-insensitively; empty when the
/// folder does not exist. Symbolic links and subfolders are left out.
pub fn list_image_assets(root: &Path) -> Result<Vec<String>, ProjectDirectoryError> {
    let folder = root.join(IMAGE_ASSETS);
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(&folder, error)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| io_error(&folder, error))?;
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if let (true, Some(name)) = (is_file, entry.file_name().to_str()) {
            names.push(name.to_owned());
        }
    }
    names.sort_by_key(|name| (name.to_lowercase(), name.clone()));
    Ok(names)
}

/// A file stem that passes the portable path rules: unsafe characters become `-`, trailing
/// dots and spaces are trimmed, reserved device names get a `-` suffix.
fn portable_stem(stem: &str) -> String {
    portable_file_stem(stem, "image")
}

/// [`portable_stem`] with `fallback` when nothing is left.
pub fn portable_file_stem(stem: &str, fallback: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_control() || "<>\"|?*/\\:.".contains(ch) {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let cleaned = cleaned
        .trim_matches(|ch: char| ch == ' ' || ch == '-')
        .to_owned();
    if cleaned.is_empty() {
        return fallback.into();
    }
    if validate_portable_path("asset", &format!("{cleaned}.png")).is_err() {
        return format!("{cleaned}-");
    }
    cleaned
}

fn verify_contained_file(root: &Path, relative: &str) -> Result<(), ProjectDirectoryError> {
    let path = root.join(relative);
    verify_components(root, &path)?;
    let metadata = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    if !metadata.is_file() {
        return Err(ProjectDirectoryError::InvalidProjectFile {
            path,
            message: "worksheet is not a regular file".into(),
        });
    }
    let canonical = fs::canonicalize(&path).map_err(|error| io_error(&path, error))?;
    if !canonical.starts_with(root) {
        return Err(ProjectDirectoryError::OutsideRoot { path });
    }
    Ok(())
}

fn verify_contained_directory(root: &Path, relative: &str) -> Result<(), ProjectDirectoryError> {
    let path = root.join(relative);
    verify_components(root, &path)?;
    let metadata = fs::metadata(&path).map_err(|error| io_error(&path, error))?;
    if !metadata.is_dir() {
        return Err(ProjectDirectoryError::InvalidProjectFile {
            path,
            message: "environment is not a directory".into(),
        });
    }
    let canonical = fs::canonicalize(&path).map_err(|error| io_error(&path, error))?;
    if !canonical.starts_with(root) {
        return Err(ProjectDirectoryError::OutsideRoot { path });
    }
    Ok(())
}

fn verify_components(root: &Path, target: &Path) -> Result<(), ProjectDirectoryError> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| ProjectDirectoryError::OutsideRoot {
            path: target.into(),
        })?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(ProjectDirectoryError::OutsideRoot {
                path: target.into(),
            });
        };
        current.push(name);
        reject_symlink(&current)?;
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), ProjectDirectoryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ProjectDirectoryError::Symlink { path: path.into() })
        }
        Ok(_) => Ok(()),
        Err(error) => Err(io_error(path, error)),
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), ProjectDirectoryError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| io_error(path, error))?;
    file.write_all(bytes)
        .map_err(|error| io_error(path, error))?;
    file.sync_all().map_err(|error| io_error(path, error))
}

fn create_stage(
    parent: &Path,
    basename: &std::ffi::OsStr,
) -> Result<PathBuf, ProjectDirectoryError> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..128 {
        let counter = STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            ".{}.equavela-stage-{}-{stamp}-{counter}",
            basename.to_string_lossy(),
            std::process::id()
        );
        let path = parent.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error(&path, error)),
        }
    }
    Err(io_error(
        parent,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not reserve a unique staging directory",
        ),
    ))
}

fn absolute_lexical(path: &Path) -> Result<PathBuf, ProjectDirectoryError> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| io_error(path, error))
    }
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn io_error(path: &Path, source: io::Error) -> ProjectDirectoryError {
    ProjectDirectoryError::Io {
        path: path.into(),
        source,
    }
}
