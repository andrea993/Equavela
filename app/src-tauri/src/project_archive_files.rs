//! Filesystem wrappers for project archive operations.
//!
//! These helpers only package or extract project data. They never open a worksheet session or
//! start Julia; the Tauri command layer decides what to open after extraction succeeds.

use crate::service::CommandError;
use equavela_core::eqvz::EqvzLimits;
use equavela_core::project_archive::{extract_project, pack_project};
use equavela_core::project_directory::load_project_directory;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

/// Packages a folder project and atomically publishes a `.eqvz` file without replacing anything.
pub(crate) fn pack_to_file(root: &Path, destination: &Path) -> Result<String, CommandError> {
    if !destination.is_absolute() {
        return Err(CommandError::new(
            "project_archive",
            "archive destination must be an absolute path",
        ));
    }
    if !has_eqvz_extension(destination) {
        return Err(CommandError::new(
            "project_archive",
            "archive destination must use the `.eqvz` extension",
        ));
    }
    if path_exists(destination) {
        return Err(CommandError::new(
            "project_archive",
            format!(
                "archive destination `{}` already exists",
                destination.display()
            ),
        ));
    }

    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| {
            CommandError::new(
                "project_archive",
                "archive destination has no parent directory",
            )
        })?;
    if !parent.is_dir() {
        return Err(CommandError::new(
            "project_archive",
            format!(
                "archive parent `{}` is not an existing directory",
                parent.display()
            ),
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        CommandError::new(
            "project_archive",
            format!("cannot resolve project root: {error}"),
        )
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| {
        CommandError::new(
            "project_archive",
            format!("cannot resolve archive parent: {error}"),
        )
    })?;
    let resolved_destination = canonical_parent.join(destination.file_name().unwrap_or_default());
    // the manifest lists every worksheet of the tree before the tree is packed.
    equavela_core::project_tree::sync_manifest(root, &std::collections::BTreeMap::new())
        .map_err(|error| CommandError::new("project_archive", error))?;
    load_project_directory(root)
        .map_err(|error| CommandError::new("project_archive", error.to_string()))?;
    // the archive holds the whole tree, so it cannot be saved anywhere inside it.
    if resolved_destination.starts_with(&canonical_root) {
        return Err(CommandError::new(
            "project_archive",
            "archive destination cannot be inside the project folder: the archive holds the whole project",
        ));
    }

    // Validate and snapshot the project before creating any output file.
    let bytes = pack_project(root)
        .map_err(|error| CommandError::new("project_archive", error.to_string()))?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        CommandError::new("project_archive", format!("cannot stage archive: {error}"))
    })?;
    temporary.write_all(&bytes).map_err(|error| {
        CommandError::new(
            "project_archive",
            format!("cannot write staged archive: {error}"),
        )
    })?;
    temporary.as_file().sync_all().map_err(|error| {
        CommandError::new(
            "project_archive",
            format!("cannot sync staged archive: {error}"),
        )
    })?;
    temporary.persist_noclobber(destination).map_err(|error| {
        CommandError::new(
            "project_archive",
            format!(
                "cannot publish archive `{}`: {}",
                destination.display(),
                error.error
            ),
        )
    })?;
    Ok(destination.to_string_lossy().into_owned())
}

/// Extracts a project archive from a regular, non-symlink `.eqvz` file.
pub(crate) fn extract_from_file(
    source: &Path,
    destination: &Path,
) -> Result<PathBuf, CommandError> {
    let bytes = read_archive_file(source, "project_archive")?;
    let loaded = extract_project(&bytes, destination)
        .map_err(|error| CommandError::new("project_archive", error.to_string()))?;
    Ok(loaded.root)
}

/// Reads a `.eqvz` file: an absolute path to a regular file, not a symbolic link,
/// within the archive size limit. Errors carry `kind`.
pub(crate) fn read_archive_file(
    source: &Path,
    kind: &'static str,
) -> Result<Vec<u8>, CommandError> {
    if !source.is_absolute() {
        return Err(CommandError::new(
            kind,
            "archive source must be an absolute path",
        ));
    }
    if !has_eqvz_extension(source) {
        return Err(CommandError::new(
            kind,
            "archive source must use the `.eqvz` extension",
        ));
    }
    let metadata = fs::symlink_metadata(source).map_err(|error| {
        CommandError::new(kind, format!("cannot inspect archive source: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CommandError::new(
            kind,
            "archive source must be a regular file, not a symbolic link",
        ));
    }
    let max = EqvzLimits::default().archive_bytes;
    if metadata.len() > max {
        return Err(CommandError::new(
            kind,
            format!("archive exceeds the {max}-byte size limit"),
        ));
    }
    let mut file = fs::File::open(source)
        .map_err(|error| CommandError::new(kind, format!("cannot open archive source: {error}")))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| CommandError::new(kind, format!("cannot read archive source: {error}")))?;
    if bytes.len() as u64 > max {
        return Err(CommandError::new(
            kind,
            format!("archive exceeds the {max}-byte size limit"),
        ));
    }
    Ok(bytes)
}

pub(crate) fn has_eqvz_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension == "eqvz")
}

fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use equavela_core::project_directory::create_project;
    use equavela_core::project_manifest::{ProjectManifest, WorksheetEntry, PROJECT_FORMAT};
    use std::collections::BTreeMap;
    use std::fs::File;
    use tempfile::tempdir;

    fn fixture_project(root: &Path) {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.into(),
            project_id: id.into(),
            name: "Archive test".into(),
            worksheets: vec![WorksheetEntry {
                id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                path: "main.eqv".into(),
            }],
            main_worksheet: None,
            environment: None,
            exports: Vec::new(),
            references: Vec::new(),
            julia_modules: Vec::new(),
        };
        create_project(
            root,
            &manifest,
            &BTreeMap::from([(
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                "format: equavela-worksheet/3\nregions: []\n".into(),
            )]),
        )
        .unwrap();
    }

    #[test]
    fn pack_and_extract_round_trip() {
        let temp = tempdir().unwrap();
        let project = temp.path().join("project");
        fixture_project(&project);
        let archive = temp.path().join("project.eqvz");
        assert_eq!(
            pack_to_file(&project, &archive).unwrap(),
            archive.to_string_lossy()
        );
        let destination = temp.path().join("restored");
        let restored = extract_from_file(&archive, &destination).unwrap();
        assert_eq!(restored, fs::canonicalize(&destination).unwrap());
        assert_eq!(
            fs::read_to_string(restored.join("main.eqv")).unwrap(),
            fs::read_to_string(project.join("main.eqv")).unwrap()
        );
    }

    #[test]
    fn existing_archive_is_never_overwritten() {
        let temp = tempdir().unwrap();
        let project = temp.path().join("project");
        fixture_project(&project);
        let archive = temp.path().join("existing.eqvz");
        fs::write(&archive, b"keep me").unwrap();
        assert!(pack_to_file(&project, &archive).is_err());
        assert_eq!(fs::read(archive).unwrap(), b"keep me");
    }

    #[test]
    fn rejects_wrong_extension_and_malformed_archive() {
        let temp = tempdir().unwrap();
        let project = temp.path().join("project");
        fixture_project(&project);
        assert!(pack_to_file(&project, &temp.path().join("project.zip")).is_err());
        let bad = temp.path().join("bad.eqvz");
        fs::write(&bad, b"not a zip archive").unwrap();
        assert!(extract_from_file(&bad, &temp.path().join("out")).is_err());
    }

    #[test]
    fn rejects_symlink_source_and_oversized_archive() {
        let temp = tempdir().unwrap();
        let target = temp.path().join("target");
        fs::write(&target, b"bad").unwrap();
        let link = temp.path().join("linked.eqvz");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&target, &link);
        match linked {
            Ok(()) => assert!(extract_from_file(&link, &temp.path().join("out")).is_err()),
            // Windows without Developer Mode or administrator rights cannot make the link:
            // the size check below still runs.
            Err(error) if cfg!(windows) && error.raw_os_error() == Some(1314) => {
                eprintln!("skipping the symlink half: {error}");
            }
            Err(error) => panic!("could not create the symlink: {error}"),
        }

        let huge = temp.path().join("huge.eqvz");
        let file = File::create(&huge).unwrap();
        file.set_len(EqvzLimits::default().archive_bytes + 1)
            .unwrap();
        assert!(extract_from_file(&huge, &temp.path().join("out")).is_err());
    }

    #[test]
    fn destination_must_be_outside_the_project() {
        //  with : the archive holds the whole tree, so it never lands inside it.
        let temp = tempdir().unwrap();
        let project = temp.path().join("project");
        fixture_project(&project);
        fs::create_dir_all(project.join("assets/images")).unwrap();
        for inside in ["assets/images/inside.eqvz", "backup.eqvz"] {
            let error = pack_to_file(&project, &project.join(inside)).unwrap_err();
            assert!(
                error.message.contains("inside the project"),
                "{}",
                error.message
            );
            assert!(!project.join(inside).exists());
        }
        pack_to_file(&project, &temp.path().join("beside.eqvz")).unwrap();
    }
}
