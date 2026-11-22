//! Copy Julia environment metadata without executing Julia or copying its depot.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_METADATA_BYTES: u64 = 16 * 1024 * 1024;

/// An environment could not be copied safely.
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CopyError {
    message: String,
}

impl CopyError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

fn selected_file(directory: &Path, preferred: &str, plain: &str) -> Result<PathBuf, CopyError> {
    let path = directory.join(preferred);
    match fs::symlink_metadata(&path) {
        Ok(_) => Ok(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(directory.join(plain)),
        Err(error) => Err(CopyError::new(format!("{}: {error}", path.display()))),
    }
}

fn read_metadata(path: &Path, optional: bool) -> Result<Option<Vec<u8>>, CopyError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(CopyError::new(format!("{}: {error}", path.display()))),
    };
    if !metadata.file_type().is_file() {
        return Err(CopyError::new(format!(
            "{}: expected a regular file, not a symlink or special file",
            path.display()
        )));
    }
    let file = fs::File::open(path)
        .map_err(|error| CopyError::new(format!("{}: {error}", path.display())))?;
    if !file
        .metadata()
        .map_err(|error| CopyError::new(format!("{}: {error}", path.display())))?
        .is_file()
    {
        return Err(CopyError::new(format!(
            "{}: expected a regular file",
            path.display()
        )));
    }
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CopyError::new(format!("{}: {error}", path.display())))?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(CopyError::new(format!(
            "{}: file exceeds 16 MiB",
            path.display()
        )));
    }
    Ok(Some(bytes))
}

fn validate(path: &Path, bytes: &[u8], project: bool) -> Result<(), CopyError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|error| CopyError::new(format!("{}: {error}", path.display())))?;
    let table = text
        .parse::<toml::Table>()
        .map_err(|error| CopyError::new(format!("{}: {error}", path.display())))?;
    fn find_path(value: &toml::Value, context: &str) -> Option<String> {
        match value {
            toml::Value::Table(table) => {
                if table.get("path").is_some_and(toml::Value::is_str) {
                    return Some(context.to_owned());
                }
                table
                    .iter()
                    .find_map(|(key, child)| find_path(child, &format!("{context}.{key}")))
            }
            toml::Value::Array(array) => array.iter().find_map(|child| find_path(child, context)),
            _ => None,
        }
    }
    if project && table.contains_key("workspace") {
        return Err(CopyError::new(format!(
            "{}: workspace projects cannot be copied safely",
            path.display()
        )));
    }
    let found = if project {
        table
            .get("sources")
            .and_then(|sources| find_path(sources, "sources"))
    } else {
        find_path(&toml::Value::Table(table), "manifest")
    };
    if let Some(context) = found {
        return Err(CopyError::new(format!(
            "{}: local path dependency at {context} cannot be copied safely",
            path.display()
        )));
    }
    Ok(())
}

/// Copy the selected project and optional manifest byte-for-byte into a new directory.
/// Local path dependencies are rejected because their meaning could change after copying.
pub fn copy_environment(source: &Path, destination: &Path) -> Result<(), CopyError> {
    // Version-specific manifests depend on the Julia version used to open the copy.
    // Refuse them until the copy operation can preserve that selection explicitly.
    for entry in fs::read_dir(source)
        .map_err(|error| CopyError::new(format!("{}: {error}", source.display())))?
    {
        let entry =
            entry.map_err(|error| CopyError::new(format!("{}: {error}", source.display())))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with("Manifest-v") || name.starts_with("JuliaManifest-v"))
            && name.ends_with(".toml")
        {
            return Err(CopyError::new(format!(
                "{}: version-specific manifests are not supported when copying",
                entry.path().display()
            )));
        }
    }
    let project = selected_file(source, "JuliaProject.toml", "Project.toml")?;
    let manifest = selected_file(source, "JuliaManifest.toml", "Manifest.toml")?;
    let project_bytes = read_metadata(&project, false)?.expect("required metadata");
    let manifest_bytes = read_metadata(&manifest, true)?;
    validate(&project, &project_bytes, true)?;
    if let Some(bytes) = &manifest_bytes {
        validate(&manifest, bytes, false)?;
    }

    fs::create_dir(destination)
        .map_err(|error| CopyError::new(format!("{}: {error}", destination.display())))?;
    let mut created = Vec::new();
    let result = (|| {
        for (source_file, bytes) in std::iter::once((&project, &project_bytes))
            .chain(manifest_bytes.as_ref().map(|bytes| (&manifest, bytes)))
        {
            let target = destination.join(source_file.file_name().expect("metadata filename"));
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| CopyError::new(format!("{}: {error}", target.display())))?;
            created.push(target.clone());
            file.write_all(bytes)
                .map_err(|error| CopyError::new(format!("{}: {error}", target.display())))?;
            file.sync_all()
                .map_err(|error| CopyError::new(format!("{}: {error}", target.display())))?;
        }
        Ok(())
    })();
    if result.is_err() {
        for path in created.iter().rev() {
            let _ = fs::remove_file(path);
        }
        let _ = fs::remove_dir(destination);
    }
    result
}
