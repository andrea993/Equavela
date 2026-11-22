//! Read-only inspection of environment metadata; invalid TOML can still be inspected.
use crate::service::CommandError;
use std::io::Read;
use std::path::Path;

pub(crate) fn read(path: &Path) -> Result<String, CommandError> {
    let fail = |message: String| CommandError::new("environment", message);
    let metadata = std::fs::symlink_metadata(path).map_err(|error| fail(error.to_string()))?;
    if !metadata.file_type().is_file() {
        return Err(fail("environment metadata must be a regular file".into()));
    }
    let file = std::fs::File::open(path).map_err(|error| fail(error.to_string()))?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| fail(error.to_string()))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(fail("environment metadata exceeds 16 MiB".into()));
    }
    String::from_utf8(bytes).map_err(|error| fail(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_preserves_invalid_toml_and_rejects_non_text_or_directories() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("Project.toml");
        let text = "# α\n[broken\n";
        std::fs::write(&path, text).unwrap();
        assert_eq!(read(&path).unwrap(), text);
        std::fs::write(&path, [255, 254]).unwrap();
        assert!(read(&path).is_err());
        assert!(read(temp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn inspection_refuses_links() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let link = temp.path().join("Manifest.toml");
        std::fs::write(&source, "[deps]\n").unwrap();
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(read(&link).is_err());
    }
}
