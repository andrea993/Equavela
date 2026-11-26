//! Portable project pack and extract operations.
//!
//! Packing includes the declared project worksheets, relative include closure, shared assets,
//! and the selected Julia environment's project metadata and local `src/` tree. It never includes
//! package depots, caches, `.git` directories or arbitrary project-root files. References that
//! cannot be represented within that boundary are rejected rather than silently omitted.

use crate::eqvz::{EqvzArchive, EqvzError, EqvzKind, EqvzLimits, EqvzManifest, EqvzReference};
use crate::project::{DocumentId, DocumentRegion};
use crate::project_directory::{
    load_project_directory, read_asset, LoadedProjectDirectory, MANIFEST_FILE,
};
use crate::project_manifest::ProjectManifest;
use crate::project_tree::{list_tree, EntryKind};
use crate::worksheet_file::parse_document;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

static STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Where a project archive embeds the projects it references:
/// hidden, so the explorer does not list it and the tree walk does not pack it twice.
pub const REFERENCES_FOLDER: &str = ".equavela-references";

#[derive(Debug, Error)]
pub enum ProjectArchiveError {
    #[error(transparent)]
    Eqvz(#[from] EqvzError),
    #[error("project directory is invalid: {0}")]
    ProjectDirectory(String),
    #[error("project archive is invalid: {0}")]
    Invalid(String),
    #[error("project destination `{0}` already exists")]
    AlreadyExists(PathBuf),
    #[error("project archive filesystem error at `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

type Result<T> = std::result::Result<T, ProjectArchiveError>;

/// Packages a validated folder project as a portable `.eqvz` archive, with the projects it
/// references embedded.
pub fn pack_project(root: &Path) -> Result<Vec<u8>> {
    pack_with(root, &mut Vec::new())
}

fn pack_with(root: &Path, stack: &mut Vec<String>) -> Result<Vec<u8>> {
    let loaded = load_project_directory(root)
        .map_err(|error| ProjectArchiveError::ProjectDirectory(error.to_string()))?;
    let root = &loaded.root;
    let manifest = &loaded.manifest;
    // the referenced projects' folders and where their Julia packages go in the archive.
    let providers = referenced_providers(root, manifest)?;
    let mut entries = BTreeMap::<String, Vec<u8>>::new();
    let manifest_path = root.join(MANIFEST_FILE);
    insert_file(root, MANIFEST_FILE, &manifest_path, &mut entries)?;

    // Traverse every declared worksheet and its transitive include closure. Each source is
    // parsed only as worksheet data; no calculation, Julia code or kernel is run.
    let mut queue: VecDeque<PathBuf> = manifest
        .worksheets
        .iter()
        .map(|sheet| root.join(&sheet.path))
        .collect();
    let mut visited = BTreeSet::new();
    let archive_sheets: Vec<String> = manifest
        .worksheets
        .iter()
        .map(|sheet| sheet.path.clone())
        .collect();
    let mut has_julia = false;
    while let Some(path) = queue.pop_front() {
        let rel = contained_regular_file(root, &path)?;
        let rel_text = portable_relative(&rel)?;
        if !rel_text.ends_with(".eqv") {
            return Err(ProjectArchiveError::Invalid(format!(
                "included worksheet `{rel_text}` does not use `.eqv`"
            )));
        }
        if !visited.insert(rel_text.clone()) {
            continue;
        }
        ensure_budget(&entries, &rel_text, &root.join(&rel))?;
        let data = read_limited(&root.join(&rel), EqvzLimits::default().entry_bytes)?;
        let text = std::str::from_utf8(&data).map_err(|_| {
            ProjectArchiveError::Invalid(format!("worksheet `{rel_text}` is not UTF-8"))
        })?;
        let id =
            DocumentId::new(&rel_text).map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
        let parsed =
            parse_document(id, text).map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
        for region in &parsed.document.regions {
            match region.as_ref() {
                DocumentRegion::Include(include) => {
                    if is_absolute_reference(&include.path) {
                        return Err(ProjectArchiveError::Invalid(format!(
                            "absolute worksheet include `{}` is not portable",
                            include.path
                        )));
                    }
                    let target = parsed
                        .document
                        .id
                        .resolve(&include.path)
                        .map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
                    let target = root.join(target.as_str());
                    let target_rel = contained_regular_file(root, &target)?;
                    queue.push_back(root.join(target_rel));
                }
                DocumentRegion::Math(region) => {
                    has_julia |= statement_uses_julia(&region.statement)?;
                }
                _ => {}
            }
        }
        for asset in parsed.document.assets.values() {
            read_asset(root, asset).map_err(ProjectArchiveError::Invalid)?;
        }
        entries.insert(rel_text, data);
    }

    if let Some(environment) = &manifest.environment {
        let depth = Path::new(environment).components().count();
        let packages: BTreeMap<PathBuf, String> = providers
            .iter()
            .filter_map(|provider| {
                let (folder, inside) = provider.package.clone()?;
                Some((
                    folder,
                    format!(
                        "{}{REFERENCES_FOLDER}/{}/{inside}",
                        "../".repeat(depth),
                        provider.project_id
                    ),
                ))
            })
            .collect();
        collect_environment(root, environment, &mut entries, &packages)?;
    } else if has_julia {
        return Err(ProjectArchiveError::Invalid(
            "project has Julia regions but no project Julia environment is declared".into(),
        ));
    }
    // the archive holds every file of the project tree, not only what the
    // checks above visited. Version-control data stays outside the archive.
    for entry in list_tree(root).map_err(ProjectArchiveError::Invalid)? {
        if entry
            .path
            .split('/')
            .any(|part| part.eq_ignore_ascii_case(".git"))
        {
            continue;
        }
        // A file already packed keeps its packed bytes (environment files may be rewritten).
        if matches!(entry.kind, EntryKind::Folder | EntryKind::Link)
            || entries.contains_key(&entry.path)
        {
            continue;
        }
        let path = root.join(&entry.path);
        contained_regular_file(root, &path)?;
        ensure_budget(&entries, &entry.path, &path)?;
        let data = read_limited(&path, EqvzLimits::default().entry_bytes)?;
        entries.insert(entry.path, data);
    }

    // each referenced project, packed on its own (with its own references), goes under
    // the hidden references folder; the archived manifest points the references there.
    let mut references = Vec::new();
    if !providers.is_empty() {
        stack.push(manifest.project_id.clone());
        let mut archived = manifest.clone();
        for provider in &providers {
            if stack.contains(&provider.project_id) {
                return Err(ProjectArchiveError::Invalid(format!(
                    "reference `{}` makes a cycle",
                    provider.alias
                )));
            }
            let prefix = format!("{REFERENCES_FOLDER}/{}", provider.project_id);
            if !references
                .iter()
                .any(|reference: &EqvzReference| reference.path == prefix)
            {
                let packed = EqvzArchive::decode(&pack_with(&provider.root, stack)?)?;
                for (name, data) in &packed.entries {
                    entries.insert(format!("{prefix}/{name}"), data.clone());
                }
                references.push(EqvzReference {
                    project_id: provider.project_id.clone(),
                    path: prefix.clone(),
                    sha256: snapshot_hash(&packed.entries),
                });
            }
            if let Some(entry) = archived
                .references
                .iter_mut()
                .find(|entry| entry.alias == provider.alias)
            {
                entry.path = prefix;
            }
        }
        stack.pop();
        let yaml = archived
            .to_yaml()
            .map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
        entries.insert(MANIFEST_FILE.into(), yaml.into_bytes());
    }

    // ZIP encoding performs a final compressed and aggregate payload limit check.
    let archive = EqvzArchive {
        manifest: EqvzManifest {
            format_version: 1,
            kind: EqvzKind::Project,
            main: String::new(),
            worksheets: archive_sheets,
            document_id: None,
            references,
        },
        entries,
    };
    Ok(archive.encode()?)
}

/// A project a packed project references.
struct ReferencedProvider {
    alias: String,
    project_id: String,
    root: PathBuf,
    /// The canonical folder of its Julia package and that folder relative to its root.
    package: Option<(PathBuf, String)>,
}

fn referenced_providers(
    root: &Path,
    manifest: &ProjectManifest,
) -> Result<Vec<ReferencedProvider>> {
    let mut providers = Vec::new();
    for reference in &manifest.references {
        let invalid = |reason: String| {
            ProjectArchiveError::Invalid(format!("reference `{}`: {reason}", reference.alias))
        };
        let provider = fs::canonicalize(root.join(&reference.path)).map_err(|_| {
            invalid(format!(
                "the project folder `{}` was not found",
                reference.path
            ))
        })?;
        let theirs = crate::project_reference::read_manifest(&provider).map_err(invalid)?;
        if theirs.project_id != reference.project_id {
            return Err(invalid(format!(
                "`{}` holds another project than the one referenced",
                reference.path
            )));
        }
        let package = crate::project_reference::provider_package(&provider, &theirs).and_then(
            |(_, folder)| {
                let folder = fs::canonicalize(folder).ok()?;
                let inside = portable_relative(folder.strip_prefix(&provider).ok()?).ok()?;
                Some((folder, inside))
            },
        );
        providers.push(ReferencedProvider {
            alias: reference.alias.clone(),
            project_id: reference.project_id.clone(),
            root: provider,
            package,
        });
    }
    Ok(providers)
}

/// The SHA-256 of a packed project's entries, by name.
fn snapshot_hash(entries: &BTreeMap<String, Vec<u8>>) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for (name, data) in entries {
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        hasher.update((data.len() as u64).to_le_bytes());
        hasher.update(data);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `relative` joined to the project-relative folder `base`, `/` separated, or `None` when it
/// leaves the project.
fn join_inside(base: &str, relative: &str) -> Option<String> {
    let relative = relative.replace('\\', "/");
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    Some(parts.join("/"))
}

/// Extracts a complete project archive into a new destination directory.
///
/// The archive and project manifest are cross-checked and the staged project validated first.
/// Publication reserves the destination exclusively and writes the project manifest last.
/// Existing destinations are refused; source bytes are never modified.
pub fn extract_project(bytes: &[u8], destination: &Path) -> Result<LoadedProjectDirectory> {
    let archive = EqvzArchive::decode_with_limits(bytes, EqvzLimits::default())?;
    if archive.manifest.kind != EqvzKind::Project {
        return Err(ProjectArchiveError::Invalid(
            "EQVZ archive kind is not `project`".into(),
        ));
    }
    let manifest_bytes = archive
        .entries
        .get(MANIFEST_FILE)
        .ok_or_else(|| ProjectArchiveError::Invalid(format!("missing `{MANIFEST_FILE}`")))?;
    let yaml = std::str::from_utf8(manifest_bytes)
        .map_err(|_| ProjectArchiveError::Invalid("project manifest is not UTF-8".into()))?;
    let manifest = ProjectManifest::from_yaml(yaml)
        .map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
    let declared: Vec<_> = manifest
        .worksheets
        .iter()
        .map(|sheet| sheet.path.as_str())
        .collect();
    if archive
        .manifest
        .worksheets
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        != declared
    {
        return Err(ProjectArchiveError::Invalid(
            "EQVZ worksheet list does not match the project manifest".into(),
        ));
    }
    // every embedded project must be exactly what was packed.
    for reference in &archive.manifest.references {
        let prefix = format!("{}/", reference.path);
        let snapshot: BTreeMap<String, Vec<u8>> = archive
            .entries
            .iter()
            .filter_map(|(name, data)| Some((name.strip_prefix(&prefix)?.to_owned(), data.clone())))
            .collect();
        if snapshot.is_empty() || snapshot_hash(&snapshot) != reference.sha256 {
            return Err(ProjectArchiveError::Invalid(format!(
                "the embedded project `{}` does not match its recorded hash",
                reference.path
            )));
        }
    }
    let destination = absolute_destination(destination)?;
    if path_exists(&destination) {
        return Err(ProjectArchiveError::AlreadyExists(destination));
    }
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err(io_error(
            parent,
            io::Error::new(io::ErrorKind::NotFound, "parent directory does not exist"),
        ));
    }
    let stage = create_stage(parent, destination.file_name().unwrap_or_default())?;
    let mut stage_dirs = vec![stage.clone()];
    let mut stage_files = Vec::new();
    let result = (|| {
        for (name, data) in &archive.entries {
            let path = stage.join(name);
            create_owned_dirs(
                &stage,
                Path::new(name).parent().unwrap_or(Path::new("")),
                &mut stage_dirs,
            )?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| io_error(&path, e))?;
            stage_files.push(path.clone());
            file.write_all(data).map_err(|e| io_error(&path, e))?;
        }
        if let Some(environment) = &manifest.environment {
            create_owned_dirs(&stage, Path::new(environment), &mut stage_dirs)?;
        }
        let staged = load_project_directory(&stage)
            .map_err(|e| ProjectArchiveError::ProjectDirectory(e.to_string()))?;
        validate_project_files(&staged, archive.entries.keys().map(String::as_str))?;
        publish_project(
            &archive.entries,
            manifest.environment.as_deref(),
            &destination,
        )?;
        load_project_directory(&destination)
            .map_err(|e| ProjectArchiveError::ProjectDirectory(e.to_string()))
    })();
    let cleanup_failed = cleanup_owned(&stage_files, &stage_dirs);
    if cleanup_failed {
        return Err(ProjectArchiveError::Invalid(format!(
            "{}; staging cleanup incomplete at `{}`; remaining files were preserved",
            result
                .err()
                .map_or_else(|| "project published".into(), |e| e.to_string()),
            stage.display()
        )));
    }
    result
}

fn validate_project_files<'a>(
    project: &LoadedProjectDirectory,
    archive_paths: impl Iterator<Item = &'a str>,
) -> Result<()> {
    let mut queue: VecDeque<PathBuf> = project
        .manifest
        .worksheets
        .iter()
        .map(|sheet| project.root.join(&sheet.path))
        .collect();
    // Validate all archived worksheet entries too; includes may be additional `.eqv` files.
    // Embedded referenced projects are checked by their hash, not as this project's files.
    for path in
        archive_paths.filter(|path| path.ends_with(".eqv") && !path.starts_with(REFERENCES_FOLDER))
    {
        queue.push_back(project.root.join(path));
    }
    let mut seen = BTreeSet::new();
    let mut has_julia = false;
    while let Some(path) = queue.pop_front() {
        let relative = contained_regular_file(&project.root, &path)?;
        let key = portable_relative(&relative)?;
        if !seen.insert(key.clone()) {
            continue;
        }
        let parsed = parse_document(
            DocumentId::new(&key).map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?,
            &fs::read_to_string(&path).map_err(|e| io_error(&path, e))?,
        )
        .map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
        for asset in parsed.document.assets.values() {
            read_asset(&project.root, asset).map_err(ProjectArchiveError::Invalid)?;
        }
        for region in &parsed.document.regions {
            if let DocumentRegion::Math(region) = region.as_ref() {
                has_julia |= statement_uses_julia(&region.statement)?;
            }
            if let DocumentRegion::Include(include) = region.as_ref() {
                if is_absolute_reference(&include.path) {
                    return Err(ProjectArchiveError::Invalid(format!(
                        "absolute worksheet include `{}` is not portable",
                        include.path
                    )));
                }
                let target = parsed
                    .document
                    .id
                    .resolve(&include.path)
                    .map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
                let target = project.root.join(target.as_str());
                contained_regular_file(&project.root, &target)?;
                queue.push_back(target);
            }
        }
    }
    if has_julia && project.manifest.environment.is_none() {
        return Err(ProjectArchiveError::Invalid(
            "project has Julia regions but no project Julia environment is declared".into(),
        ));
    }
    if let Some(environment) = &project.manifest.environment {
        for file in ["Project.toml", "Manifest.toml"] {
            let path = project.root.join(environment).join(file);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    let bytes = read_limited(&path, EqvzLimits::default().entry_bytes)?;
                    validate_no_path_dependencies(&bytes, &path.display().to_string(), &|path| {
                        join_inside(environment, path).is_some_and(|inside| {
                            inside.starts_with(&format!("{REFERENCES_FOLDER}/"))
                        })
                    })?;
                }
                Ok(_) => {
                    return Err(ProjectArchiveError::Invalid(format!(
                        "Julia environment file `{}` is not a regular file",
                        path.display()
                    )))
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(&path, error)),
            }
        }
    }
    Ok(())
}

fn collect_environment(
    root: &Path,
    environment: &str,
    entries: &mut BTreeMap<String, Vec<u8>>,
    packages: &BTreeMap<PathBuf, String>,
) -> Result<()> {
    let base = root.join(environment);
    let metadata = fs::symlink_metadata(&base).map_err(|e| io_error(&base, e))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ProjectArchiveError::Invalid(format!(
            "Julia environment `{environment}` is not a regular directory"
        )));
    }
    let mut selected = Vec::new();
    for name in ["Project.toml", "Manifest.toml"] {
        let path = base.join(name);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(ProjectArchiveError::Invalid(format!(
                    "Julia environment file `{environment}/{name}` is a symbolic link"
                )))
            }
            Ok(m) if m.is_file() => selected.push(path),
            Ok(_) => {
                return Err(ProjectArchiveError::Invalid(format!(
                    "Julia environment entry `{environment}/{name}` is not a regular file"
                )))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_error(&path, e)),
        }
    }
    let src = base.join("src");
    match fs::symlink_metadata(&src) {
        Ok(_) => collect_paths_under(root, &src, &mut selected)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(&src, error)),
    }
    for path in &selected {
        let rel = path
            .strip_prefix(root)
            .map_err(|_| ProjectArchiveError::Invalid("Julia source is outside project".into()))?;
        let rel = portable_relative(rel)?;
        ensure_budget(entries, &rel, path)?;
        let mut data = read_limited(path, EqvzLimits::default().entry_bytes)?;
        if rel.ends_with("Project.toml") || rel.ends_with("Manifest.toml") {
            // a path to a referenced project's package points to its embedded copy.
            data = rewrite_package_paths(&data, &rel, &base, packages)?;
            validate_no_path_dependencies(&data, &rel, &|path| {
                join_inside(environment, path)
                    .is_some_and(|inside| inside.starts_with(&format!("{REFERENCES_FOLDER}/")))
            })?;
        }
        entries.insert(rel, data);
    }
    Ok(())
}

/// replaces each `path` of an environment file that names a referenced project's
/// package (resolved from `environment`, the environment folder) with its archived path.
fn rewrite_package_paths(
    bytes: &[u8],
    path: &str,
    environment: &Path,
    packages: &BTreeMap<PathBuf, String>,
) -> Result<Vec<u8>> {
    if packages.is_empty() {
        return Ok(bytes.to_vec());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ProjectArchiveError::Invalid(format!("`{path}` is not UTF-8")))?;
    let mut value: toml::Value = toml::from_str(text).map_err(|e| {
        ProjectArchiveError::Invalid(format!("invalid Julia environment file `{path}`: {e}"))
    })?;
    fn rewrite(
        value: &mut toml::Value,
        environment: &Path,
        packages: &BTreeMap<PathBuf, String>,
    ) -> bool {
        match value {
            toml::Value::Table(table) => {
                let mut changed = false;
                for (key, child) in table.iter_mut() {
                    if key == "path" {
                        let target = child
                            .as_str()
                            .and_then(|path| fs::canonicalize(environment.join(path)).ok())
                            .and_then(|target| packages.get(&target));
                        if let Some(archived) = target {
                            *child = toml::Value::String(archived.clone());
                            changed = true;
                        }
                    } else {
                        changed |= rewrite(child, environment, packages);
                    }
                }
                changed
            }
            toml::Value::Array(items) => items.iter_mut().fold(false, |changed, item| {
                rewrite(item, environment, packages) | changed
            }),
            _ => false,
        }
    }
    if !rewrite(&mut value, environment, packages) {
        return Ok(bytes.to_vec());
    }
    toml::to_string(&value)
        .map(String::into_bytes)
        .map_err(|e| ProjectArchiveError::Invalid(format!("`{path}`: {e}")))
}

/// Refuses local path dependencies, except the paths `allowed` accepts.
fn validate_no_path_dependencies(
    bytes: &[u8],
    path: &str,
    allowed: &dyn Fn(&str) -> bool,
) -> Result<()> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ProjectArchiveError::Invalid(format!("`{path}` is not UTF-8")))?;
    let value: toml::Value = toml::from_str(text).map_err(|e| {
        ProjectArchiveError::Invalid(format!("invalid Julia environment file `{path}`: {e}"))
    })?;
    fn has_path(value: &toml::Value, allowed: &dyn Fn(&str) -> bool) -> bool {
        match value {
            toml::Value::Table(table) => table.iter().any(|(key, child)| {
                (key == "path" && !child.as_str().is_some_and(allowed))
                    || ((key == "url" || key == "repo-url")
                        && child.as_str().is_some_and(is_local_source))
                    || has_path(child, allowed)
            }),
            toml::Value::Array(items) => items.iter().any(|item| has_path(item, allowed)),
            _ => false,
        }
    }
    if has_path(&value, allowed) {
        return Err(ProjectArchiveError::Invalid(format!("Julia environment file `{path}` has a local path dependency, which this archive version cannot bundle")));
    }
    Ok(())
}

fn collect_paths_under(root: &Path, path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| io_error(path, e))?;
    if meta.file_type().is_symlink() {
        return Err(ProjectArchiveError::Invalid(format!(
            "project path `{}` is a symbolic link",
            path.display()
        )));
    }
    if meta.is_file() {
        contained_regular_file(root, path)?;
        files.push(path.to_path_buf());
        if files.len() + 1 >= EqvzLimits::default().entries {
            return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry count")));
        }
        return Ok(());
    }
    if !meta.is_dir() {
        return Err(ProjectArchiveError::Invalid(format!(
            "project path `{}` is not a regular file or directory",
            path.display()
        )));
    }
    if path.file_name().is_some_and(|name| name == ".git") {
        return Ok(());
    }
    let mut children = Vec::new();
    for child in fs::read_dir(path).map_err(|e| io_error(path, e))? {
        if children.len() + files.len() >= EqvzLimits::default().entries {
            return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry count")));
        }
        children.push(child.map_err(|e| io_error(path, e))?.path());
    }
    children.sort();
    for child in children {
        collect_paths_under(root, &child, files)?;
    }
    Ok(())
}

fn insert_file(
    root: &Path,
    name: &str,
    path: &Path,
    entries: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    let rel = contained_regular_file(root, path)?;
    ensure_budget(entries, name, &root.join(&rel))?;
    entries.insert(
        name.into(),
        read_limited(&root.join(rel), EqvzLimits::default().entry_bytes)?,
    );
    Ok(())
}

fn ensure_budget(entries: &BTreeMap<String, Vec<u8>>, name: &str, path: &Path) -> Result<()> {
    let limits = EqvzLimits::default();
    if !entries.contains_key(name) && entries.len() + 2 > limits.entries {
        return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry count")));
    }
    let metadata = fs::metadata(path).map_err(|e| io_error(path, e))?;
    if metadata.len() > limits.entry_bytes {
        return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry size")));
    }
    let used: u64 = entries.values().map(|bytes| bytes.len() as u64).sum();
    if used
        .checked_add(metadata.len())
        .is_none_or(|size| size > limits.total_bytes.saturating_sub(1024))
    {
        return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("total size")));
    }
    Ok(())
}

fn contained_regular_file(root: &Path, path: &Path) -> Result<PathBuf> {
    let lexical_relative = path.strip_prefix(root).map_err(|_| {
        ProjectArchiveError::Invalid(format!(
            "project dependency `{}` is outside the project",
            path.display()
        ))
    })?;
    let mut current = root.to_path_buf();
    for component in lexical_relative.components() {
        let std::path::Component::Normal(name) = component else {
            return Err(ProjectArchiveError::Invalid(format!(
                "project dependency `{}` has an unsafe path",
                path.display()
            )));
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|e| io_error(&current, e))?;
        if metadata.file_type().is_symlink() {
            return Err(ProjectArchiveError::Invalid(format!(
                "project path `{}` is a symbolic link",
                current.display()
            )));
        }
    }
    let canonical = fs::canonicalize(path).map_err(|e| io_error(path, e))?;
    if !canonical.starts_with(root) {
        return Err(ProjectArchiveError::Invalid(format!(
            "project dependency `{}` is outside the project",
            path.display()
        )));
    }
    let relative = canonical
        .strip_prefix(root)
        .expect("checked prefix")
        .to_path_buf();
    if !canonical.is_file() {
        return Err(ProjectArchiveError::Invalid(format!(
            "project dependency `{}` is not a regular file",
            path.display()
        )));
    }
    Ok(relative)
}

fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>> {
    let meta = fs::metadata(path).map_err(|e| io_error(path, e))?;
    if meta.len() > max {
        return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry size")));
    }
    let file = fs::File::open(path).map_err(|e| io_error(path, e))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| io_error(path, e))?;
    if bytes.len() as u64 > max {
        return Err(ProjectArchiveError::Eqvz(EqvzError::Limit("entry size")));
    }
    Ok(bytes)
}

fn portable_relative(path: &Path) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(ProjectArchiveError::Invalid(
                "project path is not a portable relative path".into(),
            ));
        };
        parts.push(
            part.to_str()
                .ok_or_else(|| ProjectArchiveError::Invalid("project path is not UTF-8".into()))?,
        );
    }
    Ok(parts.join("/"))
}

fn is_absolute_reference(path: &str) -> bool {
    path.starts_with('\\')
        || Path::new(path).is_absolute()
        || (path.len() >= 3
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'/' | b'\\'))
}

fn absolute_destination(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(ProjectArchiveError::Invalid(
            "project destination must be an absolute path".into(),
        ));
    }
    Ok(path.to_path_buf())
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn create_owned_dirs(root: &Path, relative: &Path, dirs: &mut Vec<PathBuf>) -> Result<()> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        if !dirs.contains(&current) {
            fs::create_dir(&current).map_err(|e| io_error(&current, e))?;
            dirs.push(current.clone());
        }
    }
    Ok(())
}

fn cleanup_owned(files: &[PathBuf], dirs: &[PathBuf]) -> bool {
    let mut failed = false;
    for file in files.iter().rev() {
        failed |= fs::remove_file(file).is_err();
    }
    for dir in dirs.iter().rev() {
        failed |= fs::remove_dir(dir).is_err();
    }
    failed
}

fn create_stage(parent: &Path, basename: &std::ffi::OsStr) -> Result<PathBuf> {
    for _ in 0..128 {
        let counter = STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{}.eqvz-stage-{}-{counter}",
            basename.to_string_lossy(),
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(&path, e)),
        }
    }
    Err(ProjectArchiveError::Invalid(
        "could not allocate a unique extraction staging directory".into(),
    ))
}

fn statement_uses_julia(statement: &crate::ast::Statement) -> Result<bool> {
    fn contains(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::Object(map) => {
                map.get("type")
                    .and_then(|v| v.as_str())
                    .is_some_and(|kind| kind == "Julia" || kind == "JuliaCall")
                    || map.values().any(contains)
            }
            serde_json::Value::Array(values) => values.iter().any(contains),
            _ => false,
        }
    }
    let value =
        serde_json::to_value(statement).map_err(|e| ProjectArchiveError::Invalid(e.to_string()))?;
    Ok(contains(&value))
}

fn is_local_source(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    lower.starts_with("file:")
        || source.starts_with('/')
        || source.starts_with('\\')
        || source.starts_with("./")
        || source.starts_with("../")
        || (!source.contains("://") && !source.contains('@'))
        || (source.len() >= 2 && source.as_bytes()[1] == b':')
            && source.as_bytes()[0].is_ascii_alphabetic()
            && source
                .as_bytes()
                .get(2)
                .is_some_and(|b| *b == b'/' || *b == b'\\')
}

// Destination ownership is established by create_dir. Never remove anything we did not create.
fn publish_project(
    entries: &BTreeMap<String, Vec<u8>>,
    environment: Option<&str>,
    destination: &Path,
) -> Result<()> {
    fs::create_dir(destination).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            ProjectArchiveError::AlreadyExists(destination.to_path_buf())
        } else {
            io_error(destination, e)
        }
    })?;
    let mut dirs = vec![destination.to_path_buf()];
    let mut files = Vec::new();
    let result = (|| {
        if let Some(environment) = environment {
            let mut current = destination.to_path_buf();
            for component in Path::new(environment).components() {
                current.push(component.as_os_str());
                fs::create_dir(&current).map_err(|e| io_error(&current, e))?;
                dirs.push(current.clone());
            }
        }
        for (name, data) in entries
            .iter()
            .filter(|(name, _)| name.as_str() != MANIFEST_FILE)
            .chain(
                entries
                    .iter()
                    .filter(|(name, _)| name.as_str() == MANIFEST_FILE),
            )
        {
            let path = destination.join(name);
            let mut current = destination.to_path_buf();
            for component in Path::new(name)
                .parent()
                .unwrap_or(Path::new(""))
                .components()
            {
                current.push(component.as_os_str());
                if !dirs.contains(&current) {
                    fs::create_dir(&current).map_err(|e| io_error(&current, e))?;
                    dirs.push(current.clone());
                }
            }
            // Record the path only after create_new succeeds, including partial write failures.
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| io_error(&path, e))?;
            files.push(path.clone());
            file.write_all(data).map_err(|e| io_error(&path, e))?;
            file.sync_all().map_err(|e| io_error(&path, e))?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let cleanup_failed = cleanup_owned(&files, &dirs);
        if cleanup_failed {
            return Err(ProjectArchiveError::Invalid(format!(
                "{error}; cleanup incomplete at `{}`; remaining files were preserved",
                destination.display()
            )));
        }
        return Err(error);
    }
    Ok(())
}

fn io_error(path: &Path, source: io::Error) -> ProjectArchiveError {
    ProjectArchiveError::Io {
        path: path.into(),
        source,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(pairs: &[(&str, &str)]) -> BTreeMap<String, Vec<u8>> {
        pairs
            .iter()
            .map(|(name, text)| ((*name).to_owned(), text.as_bytes().to_vec()))
            .collect()
    }

    #[test]
    fn a_destination_created_meanwhile_is_refused_and_left_alone() {
        // the race between the existence check and publication ends in the reservation.
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("project");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("theirs.txt"), "kept").unwrap();
        let error = publish_project(
            &entries(&[(MANIFEST_FILE, "m"), ("worksheets/main.eqv", "w")]),
            None,
            &destination,
        )
        .unwrap_err();
        assert!(
            matches!(error, ProjectArchiveError::AlreadyExists(_)),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(destination.join("theirs.txt")).unwrap(),
            "kept"
        );
        assert!(!destination.join(MANIFEST_FILE).exists());
        assert!(!destination.join("worksheets").exists());
    }

    #[test]
    fn a_failed_publication_removes_what_it_created_and_never_writes_the_manifest() {
        // `a` is written as a file, then `a/b` needs `a` as a folder and fails; the
        // manifest comes last, so it was never written, and the reserved folder goes.
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("project");
        let error = publish_project(
            &entries(&[(MANIFEST_FILE, "m"), ("a", "file"), ("a/b", "nested")]),
            None,
            &destination,
        )
        .unwrap_err();
        assert!(matches!(error, ProjectArchiveError::Io { .. }), "{error}");
        assert!(!destination.exists());
    }
}
