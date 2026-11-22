//! Portable `.eqvz` documents: one worksheet and the
//! `Project.toml`/`Manifest.toml` of its Julia environment, which an opened document uses from a
//! folder materialized in Equavela's environments folder.
//!
//! Encoding and decoding work in memory and never execute anything. Materialization writes only
//! the two environment files of the document's own cache folder.

use crate::eqvz::{EqvzArchive, EqvzError, EqvzKind, EqvzManifest};
use std::collections::hash_map::RandomState;
use std::collections::BTreeMap;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

/// The archive path of a document's worksheet.
pub const DOCUMENT_WORKSHEET: &str = "worksheets/main.eqv";
const PROJECT_TOML: &str = "julia/Project.toml";
const MANIFEST_TOML: &str = "julia/Manifest.toml";
/// The largest environment file read from disk, as the environment metadata viewer.
const ENVIRONMENT_FILE_BYTES: u64 = 16 * 1024 * 1024;

static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum DocumentArchiveError {
    #[error(transparent)]
    Eqvz(#[from] EqvzError),
    #[error("invalid portable document: {0}")]
    Invalid(String),
    #[error("environment file error at `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

fn io_error(path: &Path) -> impl FnOnce(io::Error) -> DocumentArchiveError + '_ {
    move |source| DocumentArchiveError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// The environment files a document carries; either may be absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchivedEnvironment {
    pub project: Option<Vec<u8>>,
    pub manifest: Option<Vec<u8>>,
}

/// A decoded portable document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentArchive {
    pub document_id: String,
    /// The worksheet text, as a `.eqv` file holds it.
    pub worksheet: String,
    pub environment: ArchivedEnvironment,
}

/// Whether `id` is a valid document id: 1 to 64 characters from `[A-Za-z0-9-]`.
pub fn valid_document_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A new document id, formatted like a UUID. It only has to be distinct, not secret: it names
/// the cache folder of the document's environment.
pub fn new_document_id() -> String {
    let random = |salt: u64| {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(salt);
        hasher.write_u64(ID_COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default(),
        );
        hasher.write_u32(std::process::id());
        hasher.finish()
    };
    let (high, low) = (random(1), random(2));
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        high >> 32,
        (high >> 16) & 0xffff,
        high & 0xffff,
        low >> 48,
        low & 0xffff_ffff_ffff
    )
}

fn check_toml(name: &str, bytes: &[u8]) -> Result<(), DocumentArchiveError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| DocumentArchiveError::Invalid(format!("{name} is not UTF-8")))?;
    text.parse::<toml::Table>().map_err(|error| {
        DocumentArchiveError::Invalid(format!("{name} is not valid TOML: {error}"))
    })?;
    Ok(())
}

fn check_environment(environment: &ArchivedEnvironment) -> Result<(), DocumentArchiveError> {
    if let Some(project) = &environment.project {
        check_toml(PROJECT_TOML, project)?;
    }
    if let Some(manifest) = &environment.manifest {
        check_toml(MANIFEST_TOML, manifest)?;
    }
    Ok(())
}

/// Encodes a document archive. The environment files must be valid TOML, so that the
/// document opens again.
pub fn encode_document(document: &DocumentArchive) -> Result<Vec<u8>, DocumentArchiveError> {
    if !valid_document_id(&document.document_id) {
        return Err(DocumentArchiveError::Invalid(format!(
            "invalid document id `{}`",
            document.document_id
        )));
    }
    check_environment(&document.environment)?;
    let mut entries = BTreeMap::from([(
        DOCUMENT_WORKSHEET.to_owned(),
        document.worksheet.as_bytes().to_vec(),
    )]);
    if let Some(project) = &document.environment.project {
        entries.insert(PROJECT_TOML.to_owned(), project.clone());
    }
    if let Some(manifest) = &document.environment.manifest {
        entries.insert(MANIFEST_TOML.to_owned(), manifest.clone());
    }
    let archive = EqvzArchive {
        manifest: EqvzManifest {
            format_version: 1,
            kind: EqvzKind::Document,
            main: DOCUMENT_WORKSHEET.to_owned(),
            worksheets: vec![DOCUMENT_WORKSHEET.to_owned()],
            document_id: Some(document.document_id.clone()),
            references: Vec::new(),
        },
        entries,
    };
    Ok(archive.encode()?)
}

/// Decodes a document archive: a project archive is refused with a pointer to Extract
/// Project, environment files must be valid TOML, and an archive without an id gets a new one.
pub fn decode_document(bytes: &[u8]) -> Result<DocumentArchive, DocumentArchiveError> {
    let mut archive = EqvzArchive::decode(bytes)?;
    if archive.manifest.kind == EqvzKind::Project {
        return Err(DocumentArchiveError::Invalid(
            "this is a project archive: use Extract project from .eqvz".into(),
        ));
    }
    let document_id = match archive.manifest.document_id.take() {
        Some(id) if valid_document_id(&id) => id,
        Some(id) => {
            return Err(DocumentArchiveError::Invalid(format!(
                "invalid document id `{id}`"
            )))
        }
        None => new_document_id(),
    };
    let worksheet = archive
        .entries
        .remove(&archive.manifest.main)
        .expect("a validated archive holds its main worksheet");
    let worksheet = String::from_utf8(worksheet).map_err(|_| {
        DocumentArchiveError::Invalid(format!("{} is not UTF-8", archive.manifest.main))
    })?;
    let environment = ArchivedEnvironment {
        project: archive.entries.remove(PROJECT_TOML),
        manifest: archive.entries.remove(MANIFEST_TOML),
    };
    check_environment(&environment)?;
    Ok(DocumentArchive {
        document_id,
        worksheet,
        environment,
    })
}

/// The content hash of the environment files: 16 lowercase hex digits of 64-bit
/// over each file preceded by its length (`u64::MAX` for an absent file), little endian.
pub fn environment_hash(environment: &ArchivedEnvironment) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for file in [&environment.project, &environment.manifest] {
        match file {
            Some(bytes) => {
                feed(&(bytes.len() as u64).to_le_bytes());
                feed(bytes);
            }
            None => feed(&u64::MAX.to_le_bytes()),
        }
    }
    format!("{hash:016x}")
}

/// The folder the environment of `document` is materialized in, under `environments`.
pub fn environment_folder(environments: &Path, document: &DocumentArchive) -> PathBuf {
    environments.join("documents").join(format!(
        "{}-{}",
        document.document_id,
        environment_hash(&document.environment)
    ))
}

/// Places the document's environment files in its cache folder and returns the folder.
/// A file that differs from the archive is replaced, a file the archive lacks is removed, and
/// nothing else in the folder is touched.
pub fn materialize_environment(
    environments: &Path,
    document: &DocumentArchive,
) -> Result<PathBuf, DocumentArchiveError> {
    let folder = environment_folder(environments, document);
    fs::create_dir_all(&folder).map_err(io_error(&folder))?;
    for (name, content) in [
        ("Project.toml", &document.environment.project),
        ("Manifest.toml", &document.environment.manifest),
    ] {
        let path = folder.join(name);
        let existing = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => Some(fs::read(&path).map_err(io_error(&path))?),
            Ok(_) => {
                return Err(DocumentArchiveError::Invalid(format!(
                    "`{}` is not a regular file",
                    path.display()
                )))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(&path)(error)),
        };
        match content {
            Some(bytes) if existing.as_deref() != Some(bytes.as_slice()) => {
                let staged = folder.join(format!(".{name}.{}.tmp", std::process::id()));
                fs::write(&staged, bytes).map_err(io_error(&staged))?;
                fs::rename(&staged, &path).map_err(|error| {
                    let _ = fs::remove_file(&staged);
                    io_error(&path)(error)
                })?;
            }
            None if existing.is_some() => fs::remove_file(&path).map_err(io_error(&path))?,
            _ => {}
        }
    }
    Ok(folder)
}

/// Reads one environment file: the Julia-specific name when it exists, as Julia prefers it.
fn read_environment_file(
    directory: &Path,
    preferred: &str,
    plain: &str,
) -> Result<Option<Vec<u8>>, DocumentArchiveError> {
    for name in [preferred, plain] {
        let path = directory.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                let mut bytes = Vec::new();
                fs::File::open(&path)
                    .map_err(io_error(&path))?
                    .take(ENVIRONMENT_FILE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_error(&path))?;
                if bytes.len() as u64 > ENVIRONMENT_FILE_BYTES {
                    return Err(DocumentArchiveError::Invalid(format!(
                        "`{}` exceeds 16 MiB",
                        path.display()
                    )));
                }
                return Ok(Some(bytes));
            }
            Ok(_) => {
                return Err(DocumentArchiveError::Invalid(format!(
                    "`{}` is not a regular file",
                    path.display()
                )))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(&path)(error)),
        }
    }
    Ok(None)
}

/// The environment files of `directory` that a document saved from it carries.
/// A directory that does not exist has none.
pub fn read_environment(directory: &Path) -> Result<ArchivedEnvironment, DocumentArchiveError> {
    Ok(ArchivedEnvironment {
        project: read_environment_file(directory, "JuliaProject.toml", "Project.toml")?,
        manifest: read_environment_file(directory, "JuliaManifest.toml", "Manifest.toml")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PROJECT: &[u8] = b"[deps]\nExample = \"7876af07-990d-54b4-ab0e-23690620f79a\"\n";
    const MANIFEST: &[u8] = b"manifest_format = \"2.0\"\n";

    fn document() -> DocumentArchive {
        DocumentArchive {
            document_id: "0a1b2c3d-0000-4000-8000-00000000abcd".into(),
            worksheet: "format: equavela-worksheet/3\nregions: []\n".into(),
            environment: ArchivedEnvironment {
                project: Some(PROJECT.to_vec()),
                manifest: Some(MANIFEST.to_vec()),
            },
        }
    }

    #[test]
    fn a_document_round_trips_with_its_environment_and_identical_bytes() {
        let bytes = encode_document(&document()).unwrap();
        assert_eq!(bytes, encode_document(&document()).unwrap());
        assert_eq!(decode_document(&bytes).unwrap(), document());
        let archive = EqvzArchive::decode(&bytes).unwrap();
        assert_eq!(archive.manifest.kind, EqvzKind::Document);
        assert_eq!(archive.manifest.main, DOCUMENT_WORKSHEET);
        assert_eq!(
            archive.entries.keys().collect::<Vec<_>>(),
            [MANIFEST_TOML, PROJECT_TOML, DOCUMENT_WORKSHEET]
        );
    }

    #[test]
    fn absent_environment_files_are_not_stored() {
        let mut bare = document();
        bare.environment = ArchivedEnvironment::default();
        let bytes = encode_document(&bare).unwrap();
        assert_eq!(EqvzArchive::decode(&bytes).unwrap().entries.len(), 1);
        assert_eq!(decode_document(&bytes).unwrap(), bare);
    }

    #[test]
    fn a_project_archive_is_refused_and_points_to_extract() {
        let archive = EqvzArchive {
            manifest: EqvzManifest {
                format_version: 1,
                kind: EqvzKind::Project,
                main: "worksheets/a.eqv".into(),
                worksheets: vec!["worksheets/a.eqv".into()],
                document_id: None,
                references: Vec::new(),
            },
            entries: BTreeMap::from([("worksheets/a.eqv".into(), b"regions: []\n".to_vec())]),
        };
        let error = decode_document(&archive.encode().unwrap()).unwrap_err();
        assert!(error.to_string().contains("Extract project"), "{error}");
    }

    #[test]
    fn invalid_environment_files_and_ids_are_refused() {
        let mut broken = document();
        broken.environment.manifest = Some(b"[deps\n".to_vec());
        assert!(encode_document(&broken)
            .unwrap_err()
            .to_string()
            .contains("Manifest.toml"));
        let mut bad_id = document();
        bad_id.document_id = "../escape".into();
        assert!(encode_document(&bad_id).is_err());

        // The same files written by another tool are refused when the document is opened.
        let archive = EqvzArchive {
            manifest: EqvzManifest {
                format_version: 1,
                kind: EqvzKind::Document,
                main: DOCUMENT_WORKSHEET.into(),
                worksheets: vec![DOCUMENT_WORKSHEET.into()],
                document_id: Some("../escape".into()),
                references: Vec::new(),
            },
            entries: BTreeMap::from([(DOCUMENT_WORKSHEET.into(), b"regions: []\n".to_vec())]),
        };
        assert!(decode_document(&archive.encode().unwrap()).is_err());
    }

    #[test]
    fn a_document_without_an_id_gets_a_new_valid_one() {
        let archive = EqvzArchive {
            manifest: EqvzManifest {
                format_version: 1,
                kind: EqvzKind::Document,
                main: DOCUMENT_WORKSHEET.into(),
                worksheets: vec![DOCUMENT_WORKSHEET.into()],
                document_id: None,
                references: Vec::new(),
            },
            entries: BTreeMap::from([(DOCUMENT_WORKSHEET.into(), b"regions: []\n".to_vec())]),
        };
        let bytes = archive.encode().unwrap();
        let first = decode_document(&bytes).unwrap().document_id;
        assert!(valid_document_id(&first) && first.len() == 36, "{first}");
        assert_ne!(first, decode_document(&bytes).unwrap().document_id);
    }

    #[test]
    fn the_environment_hash_is_fixed_and_tells_absent_from_empty() {
        let empty = ArchivedEnvironment {
            project: Some(Vec::new()),
            manifest: None,
        };
        assert_eq!(environment_hash(&empty), environment_hash(&empty.clone()));
        assert_ne!(
            environment_hash(&empty),
            environment_hash(&ArchivedEnvironment::default())
        );
        assert_ne!(
            environment_hash(&document().environment),
            environment_hash(&empty)
        );
        // The bytes are part of the format: a cache folder name must not change.
        assert_eq!(
            environment_hash(&ArchivedEnvironment::default()),
            "d6607508f5a1e855"
        );
    }

    #[test]
    fn materializing_writes_reuses_repairs_and_leaves_other_files() {
        let temp = tempdir().unwrap();
        let folder = materialize_environment(temp.path(), &document()).unwrap();
        assert_eq!(folder, environment_folder(temp.path(), &document()));
        assert!(folder.starts_with(temp.path().join("documents")));
        assert_eq!(fs::read(folder.join("Project.toml")).unwrap(), PROJECT);
        assert_eq!(fs::read(folder.join("Manifest.toml")).unwrap(), MANIFEST);

        // A package change made in the folder and not saved is replaced by the archive's files.
        fs::write(folder.join("Project.toml"), b"[deps]\n").unwrap();
        fs::write(folder.join("LocalPreferences.toml"), b"keep = true\n").unwrap();
        assert_eq!(
            materialize_environment(temp.path(), &document()).unwrap(),
            folder
        );
        assert_eq!(fs::read(folder.join("Project.toml")).unwrap(), PROJECT);
        assert!(folder.join("LocalPreferences.toml").is_file());

        // A file the archive does not carry is removed; the folder name follows the content.
        let mut without_manifest = document();
        without_manifest.environment.manifest = None;
        let other = materialize_environment(temp.path(), &without_manifest).unwrap();
        assert_ne!(other, folder);
        fs::write(other.join("Manifest.toml"), MANIFEST).unwrap();
        materialize_environment(temp.path(), &without_manifest).unwrap();
        assert!(!other.join("Manifest.toml").exists());
        assert!(fs::read_dir(&other).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
    }

    #[test]
    fn reading_prefers_the_julia_specific_names_and_allows_none() {
        let temp = tempdir().unwrap();
        assert_eq!(
            read_environment(&temp.path().join("missing")).unwrap(),
            ArchivedEnvironment::default()
        );
        fs::write(temp.path().join("Project.toml"), b"[deps]\n").unwrap();
        fs::write(temp.path().join("JuliaProject.toml"), PROJECT).unwrap();
        let read = read_environment(temp.path()).unwrap();
        assert_eq!(read.project.as_deref(), Some(PROJECT));
        assert_eq!(read.manifest, None);
    }
}
