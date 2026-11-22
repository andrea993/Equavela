//! A project is its file tree: listing
//! the tree, keeping the manifest's worksheet index in step with it, and the explorer's file
//! operations. Moving files to the trash is the host's job; [`check_delete`] says whether it may.
//! No operation replaces an existing name, starts Julia or deletes anything.

use crate::document_archive::new_document_id;
use crate::project::{DocumentId, DocumentRegion};
use crate::project_directory::{load_project_directory, portable_file_stem, MANIFEST_FILE};
use crate::project_manifest::{validate_portable_path, ProjectManifest, WorksheetEntry};
pub use crate::project_transaction::{
    execute_relocation, plan_move_items, plan_rename_item, ProjectGuard, RelocationPlan,
};
use crate::worksheet_file::parse_document;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// What a tree row shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Folder,
    Worksheet,
    Julia,
    Image,
    Other,
}

/// One folder or file of the tree, by its project-relative `/` path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeEntry {
    pub path: String,
    pub kind: EntryKind,
    /// Bytes of a file, 0 for a folder.
    pub size: u64,
}

fn describe(path: &Path) -> impl Fn(io::Error) -> String + '_ {
    move |error| format!("{}: {error}", path.display())
}

fn kind_of(name: &str, folder: bool) -> EntryKind {
    if folder {
        return EntryKind::Folder;
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".eqv") {
        EntryKind::Worksheet
    } else if lower.ends_with(".jl") {
        EntryKind::Julia
    } else if [".png", ".jpg", ".jpeg", ".svg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        EntryKind::Image
    } else {
        EntryKind::Other
    }
}

/// every folder and file under `root` except hidden names, links, non-regular items
/// and the manifest, folders first and then files, each by name case-insensitively.
pub fn list_tree(root: &Path) -> Result<Vec<TreeEntry>, String> {
    fn walk(root: &Path, relative: &str, out: &mut Vec<TreeEntry>) -> Result<(), String> {
        let folder = if relative.is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        let mut items = Vec::new();
        for item in fs::read_dir(&folder).map_err(describe(&folder))? {
            let item = item.map_err(describe(&folder))?;
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || (relative.is_empty() && name == MANIFEST_FILE) {
                continue;
            }
            let file_type = item.file_type().map_err(describe(&item.path()))?;
            if file_type.is_dir() || file_type.is_file() {
                items.push((name, file_type.is_dir(), item.path()));
            }
        }
        items.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
                .then_with(|| a.0.cmp(&b.0))
        });
        for (name, is_folder, path) in items {
            let child = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            let size = if is_folder {
                0
            } else {
                fs::metadata(&path).map_err(describe(&path))?.len()
            };
            out.push(TreeEntry {
                path: child.clone(),
                kind: kind_of(&name, is_folder),
                size,
            });
            if is_folder {
                walk(root, &child, out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, "", &mut out)?;
    Ok(out)
}

/// Whether `path` is `folder` or inside it.
pub(crate) fn within(path: &str, folder: &str) -> bool {
    path == folder || path.starts_with(&format!("{folder}/"))
}

/// The worksheets of the tree: its `.eqv` files outside the environment folder.
pub(crate) fn tree_worksheets(entries: &[TreeEntry], environment: Option<&str>) -> Vec<String> {
    let mut paths: Vec<String> = entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Worksheet)
        .filter(|entry| !environment.is_some_and(|env| within(&entry.path, env)))
        .map(|entry| entry.path.clone())
        .collect();
    paths.sort();
    paths
}

/// What [`sync_manifest`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct ManifestSync {
    pub manifest: ProjectManifest,
    /// Whether the manifest was written.
    pub written: bool,
}

/// Replaces the manifest atomically: a synced temporary file in the root, renamed over it.
pub(crate) fn write_manifest(root: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    manifest.validate().map_err(|error| error.to_string())?;
    let yaml = manifest.to_yaml().map_err(|error| error.to_string())?;
    let target = root.join(MANIFEST_FILE);
    let staged = root.join(format!(".{MANIFEST_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&staged)?;
        file.write_all(yaml.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staged, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result.map_err(describe(&target))
}

pub(crate) fn read_manifest(root: &Path) -> Result<ProjectManifest, String> {
    let path = root.join(MANIFEST_FILE);
    let yaml = fs::read_to_string(&path).map_err(describe(&path))?;
    ProjectManifest::from_yaml(&yaml).map_err(|error| error.to_string())
}

/// brings the manifest's worksheet index in step with the tree. `moved` maps the old
/// paths of worksheets Equavela just moved to their new ones, so they keep their UUIDs.
/// Writes the manifest only when it changed.
pub fn sync_manifest(
    root: &Path,
    moved: &BTreeMap<String, String>,
) -> Result<ManifestSync, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let mut manifest = read_manifest(root)?;
    let tree = list_tree(root)?;
    let paths = tree_worksheets(&tree, manifest.environment.as_deref());
    if paths.is_empty() {
        return Err("the project has no worksheet (.eqv file) left".into());
    }
    let mut ids: BTreeMap<String, String> = BTreeMap::new();
    for sheet in &manifest.worksheets {
        let path = moved.get(&sheet.path).unwrap_or(&sheet.path);
        ids.entry(path.to_lowercase())
            .or_insert_with(|| sheet.id.clone());
    }
    let worksheets: Vec<WorksheetEntry> = paths
        .iter()
        .map(|path| WorksheetEntry {
            id: ids
                .get(&path.to_lowercase())
                .cloned()
                .unwrap_or_else(new_document_id),
            path: path.clone(),
        })
        .collect();
    let written = worksheets != manifest.worksheets;
    manifest.worksheets = worksheets;
    if written {
        write_manifest(root, &manifest)?;
    }
    Ok(ManifestSync { manifest, written })
}

/// The project at `root` (canonical) and its manifest as on disk.
fn load(root: &Path) -> Result<(PathBuf, ProjectManifest), String> {
    let root = fs::canonicalize(root).map_err(describe(root))?;
    let manifest = read_manifest(&root)?;
    Ok((root, manifest))
}

/// Checks a project-relative path given by the explorer: portable, not hidden, existing.
pub(crate) fn existing(root: &Path, path: &str) -> Result<PathBuf, String> {
    validate_portable_path("path", path).map_err(|error| error.to_string())?;
    if path.split('/').any(|part| part.starts_with('.')) {
        return Err(format!("`{path}` is hidden"));
    }
    let full = root.join(path);
    let metadata = fs::symlink_metadata(&full).map_err(describe(&full))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("`{path}` is a symbolic link"));
    }
    Ok(full)
}

/// The folder an explorer command works in: `""` is the root.
pub(crate) fn folder_path(root: &Path, folder: &str) -> Result<PathBuf, String> {
    if folder.is_empty() {
        return Ok(root.to_path_buf());
    }
    let full = existing(root, folder)?;
    if !full.is_dir() {
        return Err(format!("`{folder}` is not a folder"));
    }
    Ok(full)
}

pub(crate) fn join(folder: &str, name: &str) -> String {
    if folder.is_empty() {
        name.to_owned()
    } else {
        format!("{folder}/{name}")
    }
}

/// `stem.ext` in `folder`, or with `-2`, `-3`, ... when the name is taken.
fn free_name(root: &Path, folder: &str, stem: &str, extension: &str) -> String {
    (1..)
        .map(|n| {
            let name = if n == 1 {
                format!("{stem}{extension}")
            } else {
                format!("{stem}-{n}{extension}")
            };
            join(folder, &name)
        })
        .find(|path| fs::symlink_metadata(root.join(path)).is_err())
        .expect("an unbounded sequence has a free name")
}

fn create_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(describe(path))?;
    file.write_all(bytes).map_err(describe(path))?;
    file.sync_all().map_err(describe(path))
}

/// What [`create_item`] makes.
pub enum NewItem<'a> {
    /// A worksheet holding the given text (`.eqv`).
    Worksheet(&'a str),
    /// A Julia file holding the given text (`.jl`).
    Julia(&'a str),
    Folder,
}

/// creates a worksheet, Julia file or folder named after `name` in `folder`, never over
/// an existing name. Returns its project-relative path.
pub fn create_item(root: &Path, folder: &str, name: &str, item: NewItem) -> Result<String, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let (root, _) = load(root)?;
    folder_path(&root, folder)?;
    let (fallback, extension) = match item {
        NewItem::Worksheet(_) => ("worksheet", ".eqv"),
        NewItem::Julia(_) => ("functions", ".jl"),
        NewItem::Folder => ("folder", ""),
    };
    let given = name.trim();
    let given = given
        .strip_suffix(extension)
        .filter(|_| !extension.is_empty())
        .unwrap_or(given);
    let path = free_name(
        &root,
        folder,
        &portable_file_stem(given, fallback),
        extension,
    );
    validate_portable_path("path", &path).map_err(|error| error.to_string())?;
    let full = root.join(&path);
    match item {
        NewItem::Worksheet(text) | NewItem::Julia(text) => create_new(&full, text.as_bytes())?,
        NewItem::Folder => fs::create_dir(&full).map_err(describe(&full))?,
    }
    Ok(path)
}

/// The environment folder and its `Project.toml`, which the explorer never renames, moves or
/// deletes.
pub(crate) fn protected(manifest: &ProjectManifest, path: &str) -> bool {
    manifest.environment.as_deref().is_some_and(|env| {
        path == env || path == format!("{env}/Project.toml") || within(env, path)
    })
}

/// The include regions of every worksheet, by worksheet path: `(include path)`.
fn includes_of(
    root: &Path,
    worksheets: &[WorksheetEntry],
) -> Result<Vec<(String, String)>, String> {
    let mut found = Vec::new();
    for sheet in worksheets {
        let file = root.join(&sheet.path);
        let text = fs::read_to_string(&file).map_err(describe(&file))?;
        let id = DocumentId::new(&sheet.path).map_err(|error| error.to_string())?;
        let parsed = parse_document(id, &text).map_err(|error| error.to_string())?;
        for region in &parsed.document.regions {
            if let DocumentRegion::Include(include) = region.as_ref() {
                found.push((sheet.path.clone(), include.path.clone()));
            }
        }
    }
    Ok(found)
}

/// The worksheets a change of `path` (a file, or a folder and everything in it) touches.
pub fn affected_worksheets(manifest: &ProjectManifest, path: &str) -> Vec<String> {
    manifest
        .worksheets
        .iter()
        .filter(|sheet| within(&sheet.path, path))
        .map(|sheet| sheet.path.clone())
        .collect()
}

/// Renames one item as a recoverable transaction.
pub fn rename_item(
    root: &Path,
    path: &str,
    name: &str,
) -> Result<(String, BTreeMap<String, String>), String> {
    let plan = plan_rename_item(root, path, name)?;
    let to = plan
        .destinations
        .get(path)
        .cloned()
        .unwrap_or_else(|| path.to_owned());
    Ok((to, execute_relocation(plan)?))
}

/// Moves one item as a recoverable transaction.
pub fn move_item(
    root: &Path,
    path: &str,
    folder: &str,
) -> Result<(String, BTreeMap<String, String>), String> {
    let plan = plan_move_items(root, &[path.to_owned()], folder)?;
    let to = plan
        .destinations
        .get(path)
        .cloned()
        .unwrap_or_else(|| path.to_owned());
    Ok((to, execute_relocation(plan)?))
}

/// whether `path` may go to the trash, and the full path to give the trash. Refused for
/// the environment folder and its `Project.toml`, for the last worksheets, and when another
/// worksheet includes one that goes.
pub fn check_delete(root: &Path, path: &str) -> Result<PathBuf, String> {
    check_delete_many(root, &[path.to_owned()])?
        .into_iter()
        .next()
        .ok_or_else(|| "no project item selected".into())
}

/// Returns the normalized selected roots, each at most once and without descendants of another.
pub fn normalize_roots(paths: &[String]) -> Vec<String> {
    let mut sorted = paths.to_vec();
    sorted.sort();
    sorted.dedup();
    let all = sorted.clone();
    sorted.retain(|path| !all.iter().any(|other| other != path && within(path, other)));
    sorted
}

/// Preflights a whole trash selection. Callers must retain an outer project guard until trash
/// completes, so the tree cannot change between this check and the operation.
pub fn check_delete_many(root: &Path, paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let (root, manifest) = load(root)?;
    let roots = normalize_roots(paths);
    let mut full = Vec::new();
    for path in &roots {
        crate::project_transaction::check_path(&root, path)?;
        full.push(existing(&root, path)?);
        if protected(&manifest, path) {
            return Err(format!(
                "`{path}` is the project's Julia environment and cannot be deleted"
            ));
        }
    }
    let worksheets = tree_worksheets(&list_tree(&root)?, manifest.environment.as_deref());
    let going = |path: &str| roots.iter().any(|root| within(path, root));
    if !worksheets.is_empty() && worksheets.iter().all(|path| going(path)) {
        return Err(
            "a project needs at least one worksheet: this would delete the last one".into(),
        );
    }
    let sheets: Vec<WorksheetEntry> = worksheets
        .into_iter()
        .map(|path| WorksheetEntry {
            id: String::new(),
            path,
        })
        .collect();
    for (sheet, include) in includes_of(&root, &sheets)? {
        if going(&sheet) {
            continue;
        }
        let target = DocumentId::new(&sheet)
            .and_then(|id| id.resolve(&include))
            .map_err(|e| e.to_string())?;
        if going(target.as_str()) {
            return Err(format!(
                "`{sheet}` includes `{}`: delete or change that include first",
                target.as_str()
            ));
        }
    }
    Ok(full)
}

/// copies `sources` into `folder`, never over an existing name. A worksheet with include
/// regions is refused before anything is copied. Returns the new project-relative paths.
pub fn import_files(root: &Path, folder: &str, sources: &[PathBuf]) -> Result<Vec<String>, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let (root, _) = load(root)?;
    folder_path(&root, folder)?;
    let mut payloads = Vec::new();
    for source in sources {
        let metadata = fs::metadata(source).map_err(describe(source))?;
        if !metadata.is_file() {
            return Err(format!("`{}` is not a file", source.display()));
        }
        let bytes = fs::read(source).map_err(describe(source))?;
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if kind_of(&name, false) == EntryKind::Worksheet {
            let text =
                String::from_utf8(bytes.clone()).map_err(|_| format!("`{name}` is not UTF-8"))?;
            let id = DocumentId::new(&name).map_err(|error| error.to_string())?;
            let parsed = parse_document(id, &text).map_err(|error| error.to_string())?;
            if let Some(include) =
                parsed
                    .document
                    .regions
                    .iter()
                    .find_map(|region| match region.as_ref() {
                        DocumentRegion::Include(include) => Some(include.path.clone()),
                        _ => None,
                    })
            {
                return Err(format!(
                    "`{name}` has include regions: `{include}` would not resolve from the project"
                ));
            }
        }
        let (stem, extension) = match name.rfind('.') {
            Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
            _ => (name.as_str(), ""),
        };
        payloads.push((
            portable_file_stem(stem, "file"),
            extension.to_ascii_lowercase(),
            bytes,
        ));
    }
    let mut created = Vec::new();
    for (stem, extension, bytes) in payloads {
        let path = free_name(&root, folder, &stem, &extension);
        create_new(&root.join(&path), &bytes)?;
        created.push(path);
    }
    Ok(created)
}

/// The largest text file a text tab opens.
pub const TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// The largest image an image tab shows, as for image resources.
pub const IMAGE_FILE_BYTES: u64 = 25 * 1024 * 1024;

/// The version of a file's bytes, to notice a change on disk between reading and saving
///: 16 hex digits of 64-bit .
pub fn file_version(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Reads a regular file of the tree, refusing one over `limit` bytes.
fn read_tree_file(root: &Path, path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let (root, _) = load(root)?;
    let full = existing(&root, path)?;
    let metadata = fs::metadata(&full).map_err(describe(&full))?;
    if !metadata.is_file() {
        return Err(format!("`{path}` is not a file"));
    }
    if metadata.len() > limit {
        return Err(format!(
            "`{path}` is larger than {} MiB",
            limit / (1024 * 1024)
        ));
    }
    fs::read(&full).map_err(describe(&full))
}

/// the text of a file of the tree and its version. Refused over 5 MiB or not UTF-8.
pub fn read_text_file(root: &Path, path: &str) -> Result<(String, String), String> {
    let bytes = read_tree_file(root, path, TEXT_FILE_BYTES)?;
    let version = file_version(&bytes);
    let text = String::from_utf8(bytes).map_err(|_| format!("`{path}` is not UTF-8 text"))?;
    Ok((text, version))
}

/// writes `text` to a file of the tree atomically, when the file on disk is still the
/// version that was read. Returns the new version.
pub fn write_text_file(
    root: &Path,
    path: &str,
    text: &str,
    version: &str,
) -> Result<String, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let (root, _) = load(root)?;
    let full = existing(&root, path)?;
    let current = fs::read(&full).map_err(describe(&full))?;
    if file_version(&current) != version {
        return Err(format!(
            "`{path}` changed on disk since it was opened: reload it before saving"
        ));
    }
    let name = full
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = full.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&staged)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staged, &full)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result.map_err(describe(&full))?;
    Ok(file_version(text.as_bytes()))
}

/// the media type and bytes of an image of the tree.
pub fn read_image_file(root: &Path, path: &str) -> Result<(&'static str, Vec<u8>), String> {
    let lower = path.to_ascii_lowercase();
    let media = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        return Err(format!("`{path}` is not an image"));
    };
    Ok((media, read_tree_file(root, path, IMAGE_FILE_BYTES)?))
}

/// lists the `.jl` file at `path` among the modules every worksheet loads, or removes it.
pub fn set_julia_module(root: &Path, path: &str, loaded: bool) -> Result<ProjectManifest, String> {
    let _guard = ProjectGuard::acquire(root)?;
    let (root, mut manifest) = load(root)?;
    if loaded {
        existing(&root, path)?;
        if !path.ends_with(".jl") {
            return Err(format!("`{path}` is not a Julia file"));
        }
        if !manifest.julia_modules.iter().any(|module| module == path) {
            manifest.julia_modules.push(path.to_owned());
        }
    } else {
        manifest.julia_modules.retain(|module| module != path);
    }
    write_manifest(&root, &manifest)?;
    Ok(manifest)
}

/// the environment files of a new project named `name`: `julia/Project.toml` naming
/// the project's package (`name`, a new `uuid`) and `julia/src/<Module>.jl`. `existing` is the
/// `Project.toml` of the environment a converted worksheet used: its other keys (`[deps]`,
/// `[compat]`, ...) are kept, a `name` or `uuid` it had is replaced.
pub fn project_environment_files(
    name: &str,
    existing: Option<&[u8]>,
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let module = julia_module_name(name);
    let mut rest = match existing {
        Some(bytes) => {
            let text = std::str::from_utf8(bytes)
                .map_err(|_| "the environment's Project.toml is not UTF-8".to_owned())?;
            text.parse::<toml::Table>().map_err(|error| {
                format!("the environment's Project.toml cannot be read: {error}")
            })?
        }
        None => toml::Table::new(),
    };
    rest.remove("name");
    rest.remove("uuid");
    let mut project = format!("name = \"{module}\"\nuuid = \"{}\"\n", new_document_id());
    if !rest.is_empty() {
        let body = toml::to_string(&rest).map_err(|error| error.to_string())?;
        project.push('\n');
        project.push_str(&body);
    }
    Ok(BTreeMap::from([
        ("julia/Project.toml".to_owned(), project.into_bytes()),
        (
            format!("julia/src/{module}.jl"),
            format!("module {module}\n\nend\n").into_bytes(),
        ),
    ]))
}

/// the project name as a Julia module name: letters, digits and `_`, starting with a
/// letter, each word capitalized; `Project` when nothing is left.
pub fn julia_module_name(name: &str) -> String {
    let mut module = String::new();
    for word in name.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')) {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            module.extend(first.to_uppercase());
            module.push_str(chars.as_str());
        }
    }
    let module = module.trim_start_matches(|ch: char| !ch.is_ascii_alphabetic());
    let mut chars = module.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => "Project".into(),
    }
}

/// The project at `root` exists and its manifest reads (for hosts that list the tree).
pub fn check_project(root: &Path) -> Result<PathBuf, String> {
    load_project_directory(root)
        .map(|loaded| loaded.root)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_directory::create_project;
    use crate::project_manifest::PROJECT_FORMAT;
    use tempfile::tempdir;

    const MAIN: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const EMPTY: &str = "format: equavela-worksheet/3\nregions: []\n";

    fn project() -> (tempfile::TempDir, PathBuf) {
        let temp = tempdir().unwrap();
        let root = temp.path().join("project");
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.into(),
            project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
            name: "P".into(),
            worksheets: vec![WorksheetEntry {
                id: MAIN.into(),
                path: "worksheets/main.eqv".into(),
            }],
            main_worksheet: None,
            environment: Some("julia".into()),
            exports: Vec::new(),
            references: Vec::new(),
            julia_modules: Vec::new(),
        };
        create_project(
            &root,
            &manifest,
            &BTreeMap::from([(MAIN.into(), EMPTY.into())]),
        )
        .unwrap();
        fs::write(root.join("julia/Project.toml"), "[deps]\n").unwrap();
        let root = fs::canonicalize(root).unwrap();
        (temp, root)
    }

    fn paths(root: &Path) -> Vec<String> {
        list_tree(root)
            .unwrap()
            .into_iter()
            .map(|entry| entry.path)
            .collect()
    }

    #[test]
    fn the_tree_lists_folders_first_and_hides_hidden_links_and_the_manifest() {
        let (_temp, root) = project();
        fs::create_dir_all(root.join(".git/objects")).unwrap();
        fs::write(root.join(".notes"), "x").unwrap();
        fs::write(root.join("Readme.txt"), "hi").unwrap();
        fs::write(root.join("worksheets/b.png"), "png").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("Readme.txt"), root.join("link.txt")).unwrap();
        assert_eq!(
            paths(&root),
            [
                "julia",
                "julia/Project.toml",
                "worksheets",
                "worksheets/b.png",
                "worksheets/main.eqv",
                "Readme.txt"
            ]
        );
        let tree = list_tree(&root).unwrap();
        assert_eq!(tree[4].kind, EntryKind::Worksheet);
        assert_eq!(tree[3].kind, EntryKind::Image);
        assert_eq!(tree[5].size, 2);
    }

    #[test]
    fn the_manifest_follows_the_tree_and_keeps_ids_of_moved_worksheets() {
        let (_temp, root) = project();
        assert!(!sync_manifest(&root, &BTreeMap::new()).unwrap().written);
        fs::write(root.join("extra.eqv"), EMPTY).unwrap();
        fs::write(root.join("julia/inside.eqv"), EMPTY).unwrap();
        let synced = sync_manifest(&root, &BTreeMap::new()).unwrap();
        assert!(synced.written);
        let listed: Vec<_> = synced
            .manifest
            .worksheets
            .iter()
            .map(|s| s.path.as_str())
            .collect();
        assert_eq!(
            listed,
            ["extra.eqv", "worksheets/main.eqv"],
            "nothing from the environment folder"
        );

        let (to, moved) = rename_item(&root, "worksheets/main.eqv", "start.eqv").unwrap();
        assert_eq!(to, "worksheets/start.eqv");
        let synced = sync_manifest(&root, &moved).unwrap();
        let main = synced
            .manifest
            .worksheets
            .iter()
            .find(|s| s.path == "worksheets/start.eqv")
            .unwrap();
        assert_eq!(main.id, MAIN, "a worksheet Equavela renames keeps its id");

        // A worksheet removed outside Equavela leaves the manifest; no worksheet is main.
        fs::remove_file(root.join("worksheets/start.eqv")).unwrap();
        let synced = sync_manifest(&root, &BTreeMap::new()).unwrap();
        assert!(synced
            .manifest
            .worksheets
            .iter()
            .all(|sheet| sheet.path != "worksheets/start.eqv"));
        fs::remove_file(root.join("extra.eqv")).unwrap();
        assert!(sync_manifest(&root, &BTreeMap::new()).is_err());
    }

    #[test]
    fn julia_sources_can_be_selected_from_every_project_directory() {
        let (_temp, root) = project();
        let paths = [
            "Root.jl",
            "julia/Environment.jl",
            "julia/scripts/Nested.jl",
            "julia/src/Package.jl",
        ];
        for path in paths {
            let file = root.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "module Example\nend\n").unwrap();
            let manifest = set_julia_module(&root, path, true).unwrap();
            assert!(manifest.julia_modules.contains(&path.to_owned()));
        }
        let (_, manifest) = load(&root).unwrap();
        assert_eq!(manifest.julia_modules, paths);
        let manifest = set_julia_module(&root, paths[1], false).unwrap();
        assert!(!manifest.julia_modules.contains(&paths[1].to_owned()));
        assert!(set_julia_module(&root, "../Outside.jl", true).is_err());
        assert!(set_julia_module(&root, "julia/Project.toml", true).is_err());
    }

    #[test]
    fn new_items_take_free_portable_names() {
        let (_temp, root) = project();
        assert_eq!(
            create_item(&root, "worksheets", "main", NewItem::Worksheet(EMPTY)).unwrap(),
            "worksheets/main-2.eqv"
        );
        assert!(create_item(&root, "julia/src", "x", NewItem::Folder)
            .unwrap_err()
            .contains("julia/src"));
        assert_eq!(
            create_item(&root, "julia", "src", NewItem::Folder).unwrap(),
            "julia/src"
        );
        assert_eq!(
            create_item(&root, "julia/src", "beam tools.jl", NewItem::Julia("# x\n")).unwrap(),
            "julia/src/beam tools.jl"
        );
        assert_eq!(
            create_item(&root, "", "data", NewItem::Folder).unwrap(),
            "data"
        );
        assert!(create_item(&root, "../outside", "x", NewItem::Folder).is_err());
    }

    #[test]
    fn moves_keep_includes_working_or_are_refused() {
        let (_temp, root) = project();
        fs::create_dir(root.join("lib")).unwrap();
        fs::write(root.join("lib/units.eqv"), EMPTY).unwrap();
        fs::write(
            root.join("worksheets/main.eqv"),
            "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: ../lib/units.eqv\n",
        )
        .unwrap();
        sync_manifest(&root, &BTreeMap::new()).unwrap();
        // Moving the included file, or the includer to another depth, breaks the include.
        assert!(move_item(&root, "lib/units.eqv", "")
            .unwrap_err()
            .contains("worksheets/main.eqv"));
        assert!(move_item(&root, "worksheets/main.eqv", "").is_err());
        // Moving both folders together into one parent keeps the relative path valid.
        create_item(&root, "", "src", NewItem::Folder).unwrap();
        move_item(&root, "lib", "src").unwrap_err();
        // Renaming an unrelated file is fine and never replaces a name.
        fs::write(root.join("notes.txt"), "a").unwrap();
        fs::write(root.join("taken.txt"), "b").unwrap();
        assert!(rename_item(&root, "notes.txt", "taken.txt")
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(fs::read_to_string(root.join("taken.txt")).unwrap(), "b");
        // The environment folder stays where it is.
        assert!(rename_item(&root, "julia", "env").is_err());
        assert!(move_item(&root, "julia/Project.toml", "").is_err());
        assert!(move_item(&root, "worksheets", "worksheets").is_err());
    }

    #[test]
    fn delete_checks_protect_the_environment_the_last_worksheet_and_includes() {
        let (_temp, root) = project();
        assert!(check_delete(&root, "julia").is_err());
        assert!(check_delete(&root, "julia/Project.toml").is_err());
        assert!(check_delete(&root, "worksheets/main.eqv")
            .unwrap_err()
            .contains("last"));
        assert!(check_delete(&root, "worksheets").is_err());
        fs::write(root.join("lib.eqv"), EMPTY).unwrap();
        fs::write(
            root.join("worksheets/main.eqv"),
            "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: ../lib.eqv\n",
        )
        .unwrap();
        sync_manifest(&root, &BTreeMap::new()).unwrap();
        assert!(check_delete(&root, "lib.eqv")
            .unwrap_err()
            .contains("worksheets/main.eqv"));
        fs::write(root.join("data.csv"), "1,2").unwrap();
        assert_eq!(
            check_delete(&root, "data.csv").unwrap(),
            root.join("data.csv")
        );
    }

    #[test]
    fn batch_delete_checks_combined_surviving_includes_and_all_worksheets() {
        let (_temp, root) = project();
        fs::write(root.join("survivor.eqv"), EMPTY).unwrap();
        fs::write(root.join("target.eqv"), EMPTY).unwrap();
        fs::write(root.join("worksheets/main.eqv"), "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: ../target.eqv\n").unwrap();
        assert!(check_delete_many(&root, &["target.eqv".into()]).is_err());
        let paths = check_delete_many(
            &root,
            &[
                "target.eqv".into(),
                "worksheets/main.eqv".into(),
                "worksheets".into(),
                "target.eqv".into(),
            ],
        )
        .unwrap();
        assert_eq!(
            paths,
            vec![root.join("target.eqv"), root.join("worksheets")]
        );
        assert!(check_delete_many(
            &root,
            &[
                "target.eqv".into(),
                "worksheets".into(),
                "survivor.eqv".into()
            ]
        )
        .is_err());
        assert!(check_delete_many(&root, &["julia".into(), "target.eqv".into()]).is_err());
    }

    #[test]
    fn imports_copy_with_free_names_and_refuse_includes() {
        let (temp, root) = project();
        let a = temp.path().join("Data Set.CSV");
        fs::write(&a, "1").unwrap();
        fs::write(root.join("Data Set.csv"), "old").unwrap();
        assert_eq!(
            import_files(&root, "", std::slice::from_ref(&a)).unwrap(),
            ["Data Set-2.csv"]
        );
        assert_eq!(fs::read_to_string(&a).unwrap(), "1");
        let included = temp.path().join("inc.eqv");
        fs::write(&included, "format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: x.eqv\n").unwrap();
        assert!(import_files(&root, "", &[a, included])
            .unwrap_err()
            .contains("x.eqv"));
        assert!(
            !root.join("Data Set-3.csv").exists(),
            "nothing is copied when one file is refused"
        );
    }

    #[test]
    fn julia_module_names() {
        assert_eq!(julia_module_name("beam design"), "BeamDesign");
        assert_eq!(julia_module_name("Heat-exchanger 2"), "HeatExchanger2");
        assert_eq!(julia_module_name("2nd try"), "NdTry");
        assert_eq!(julia_module_name("è à"), "Project");
    }

    #[test]
    fn text_files_are_read_and_saved_only_when_unchanged_on_disk() {
        let (_temp, root) = project();
        fs::write(root.join("notes.md"), "# Notes\n").unwrap();
        let (text, version) = read_text_file(&root, "notes.md").unwrap();
        assert_eq!(text, "# Notes\n");
        let next = write_text_file(&root, "notes.md", "# Notes\nmore\n", &version).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes.md")).unwrap(),
            "# Notes\nmore\n"
        );
        assert!(write_text_file(&root, "notes.md", "stale", &version)
            .unwrap_err()
            .contains("changed on disk"));
        fs::write(root.join("notes.md"), "edited elsewhere").unwrap();
        assert!(write_text_file(&root, "notes.md", "mine", &next).is_err());
        assert_eq!(
            fs::read_to_string(root.join("notes.md")).unwrap(),
            "edited elsewhere"
        );
        fs::write(root.join("bytes.txt"), [0xff, 0xfe]).unwrap();
        assert!(read_text_file(&root, "bytes.txt")
            .unwrap_err()
            .contains("UTF-8"));
        assert!(read_text_file(&root, "../outside.txt").is_err());
        assert!(fs::read_dir(&root).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn images_are_read_with_their_media_type() {
        let (_temp, root) = project();
        fs::write(root.join("a.svg"), "<svg/>").unwrap();
        assert_eq!(
            read_image_file(&root, "a.svg").unwrap(),
            ("image/svg+xml", b"<svg/>".to_vec())
        );
        fs::write(root.join("a.txt"), "x").unwrap();
        assert!(read_image_file(&root, "a.txt").is_err());
    }
}
