//! In-memory EQVZ container encoding and decoding. No files are extracted or executed.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EqvzKind {
    Document,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EqvzManifest {
    pub format_version: u32,
    pub kind: EqvzKind,
    /// The worksheet of a document archive. A project archive has none since :
    /// empty, not written; archives that name one still read.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub main: String,
    pub worksheets: Vec<String>,
    /// The stable id of a portable document; optional for readers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    /// Referenced projects embedded in a project archive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<EqvzReference>,
}

/// A referenced project embedded under `path`, with the SHA-256 of its packed content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EqvzReference {
    pub project_id: String,
    pub path: String,
    pub sha256: String,
}

/// Payloads keyed by their archive paths; `manifest.json` is represented separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EqvzArchive {
    pub manifest: EqvzManifest,
    pub entries: BTreeMap<String, Vec<u8>>,
}

/// Resource limits apply to the manifest as well as payload entries.
#[derive(Debug, Clone, Copy)]
pub struct EqvzLimits {
    pub archive_bytes: u64,
    pub entries: usize,
    pub entry_bytes: u64,
    pub total_bytes: u64,
}

impl Default for EqvzLimits {
    fn default() -> Self {
        Self {
            archive_bytes: 256 * 1024 * 1024,
            entries: 1024,
            entry_bytes: 64 * 1024 * 1024,
            total_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EqvzError {
    #[error("invalid ZIP archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("archive I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid manifest: {0}")]
    Manifest(#[from] serde_json::Error),
    #[error("unsupported EQVZ format version {0}")]
    Version(u32),
    #[error("invalid archive: {0}")]
    Invalid(String),
    #[error("archive exceeds {0} limit")]
    Limit(&'static str),
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|part| {
            if part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|c| c < ' ' || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
            {
                return false;
            }
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            !matches!(
                stem.as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
        })
}

fn validate(archive: &EqvzArchive) -> Result<(), EqvzError> {
    let manifest = &archive.manifest;
    if manifest.format_version != 1 {
        return Err(EqvzError::Version(manifest.format_version));
    }
    let mut worksheets = BTreeSet::new();
    for path in &manifest.worksheets {
        if !valid_path(path) || !path.ends_with(".eqv") || !worksheets.insert(path) {
            return Err(EqvzError::Invalid(format!(
                "invalid or duplicate worksheet path: {path}"
            )));
        }
        if !archive.entries.contains_key(path) {
            return Err(EqvzError::Invalid(format!("missing worksheet: {path}")));
        }
    }
    let needs_main = manifest.kind == EqvzKind::Document;
    if (needs_main || !manifest.main.is_empty()) && !worksheets.contains(&manifest.main) {
        return Err(EqvzError::Invalid("main must be a listed worksheet".into()));
    }
    if manifest.kind == EqvzKind::Document && worksheets.len() != 1 {
        return Err(EqvzError::Invalid(
            "a document must have exactly one worksheet".into(),
        ));
    }
    let mut names = BTreeSet::from([MANIFEST.to_lowercase()]);
    for path in archive.entries.keys() {
        if !valid_path(path) || !names.insert(path.to_lowercase()) {
            return Err(EqvzError::Invalid(format!("invalid payload path: {path}")));
        }
    }
    for name in &names {
        for (index, _) in name.match_indices('/') {
            if names.contains(&name[..index]) {
                return Err(EqvzError::Invalid(format!(
                    "file/directory path collision: {name}"
                )));
            }
        }
    }
    Ok(())
}

impl EqvzArchive {
    pub fn decode(bytes: &[u8]) -> Result<Self, EqvzError> {
        Self::decode_with_limits(bytes, EqvzLimits::default())
    }

    pub fn decode_with_limits(bytes: &[u8], limits: EqvzLimits) -> Result<Self, EqvzError> {
        if bytes.len() as u64 > limits.archive_bytes {
            return Err(EqvzError::Limit("archive size"));
        }
        let mut zip = ZipArchive::new(Cursor::new(bytes))?;
        if zip.has_duplicate_names() {
            return Err(EqvzError::Invalid("duplicate ZIP entries".into()));
        }
        if zip.len() > limits.entries {
            return Err(EqvzError::Limit("entry count"));
        }
        let mut entries = BTreeMap::new();
        let mut total = 0u64;
        for index in 0..zip.len() {
            let mut file = zip.by_index(index)?;
            let name = std::str::from_utf8(file.name_raw())
                .map_err(|_| EqvzError::Invalid("entry name is not UTF-8".into()))?
                .to_owned();
            if !valid_path(&name) || file.is_dir() {
                return Err(EqvzError::Invalid(format!("invalid entry path: {name}")));
            }
            if let Some(mode) = file.unix_mode() {
                match mode & 0o170000 {
                    0 | 0o100000 => {} // Unspecified type or regular file.
                    0o120000 => return Err(EqvzError::Invalid(format!("symlink entry: {name}"))),
                    _ => return Err(EqvzError::Invalid(format!("non-regular entry: {name}"))),
                }
            }
            if !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            ) {
                return Err(EqvzError::Invalid(format!(
                    "unsupported compression: {name}"
                )));
            }
            if entries.contains_key(&name) {
                return Err(EqvzError::Invalid(format!("duplicate entry: {name}")));
            }
            if file.size() > limits.entry_bytes {
                return Err(EqvzError::Limit("entry size"));
            }
            let remaining = limits
                .total_bytes
                .checked_sub(total)
                .ok_or(EqvzError::Limit("total size"))?;
            let cap = limits.entry_bytes.min(remaining);
            let mut data = Vec::new();
            (&mut file)
                .take(cap.saturating_add(1))
                .read_to_end(&mut data)?;
            if data.len() as u64 > cap {
                return Err(EqvzError::Limit(if remaining < limits.entry_bytes {
                    "total size"
                } else {
                    "entry size"
                }));
            }
            total += data.len() as u64;
            let name = crate::former_names::current_entry_name(&name).unwrap_or(name);
            entries.insert(name, data);
        }
        let manifest_data = entries
            .remove(MANIFEST)
            .ok_or_else(|| EqvzError::Invalid("missing manifest.json".into()))?;
        let manifest = serde_json::from_slice(&manifest_data)?;
        let archive = Self { manifest, entries };
        validate(&archive)?;
        Ok(archive)
    }

    /// Encode with stable entry ordering, metadata and compression settings.
    pub fn encode(&self) -> Result<Vec<u8>, EqvzError> {
        self.encode_with_limits(EqvzLimits::default())
    }

    pub fn encode_with_limits(&self, limits: EqvzLimits) -> Result<Vec<u8>, EqvzError> {
        validate(self)?;
        let manifest = serde_json::to_vec(&self.manifest)?;
        if self
            .entries
            .len()
            .checked_add(1)
            .is_none_or(|n| n > limits.entries)
        {
            return Err(EqvzError::Limit("entry count"));
        }
        let mut total = 0u64;
        for data in std::iter::once(&manifest).chain(self.entries.values()) {
            let size = data.len() as u64;
            if size > limits.entry_bytes {
                return Err(EqvzError::Limit("entry size"));
            }
            total = total
                .checked_add(size)
                .ok_or(EqvzError::Limit("total size"))?;
            if total > limits.total_bytes {
                return Err(EqvzError::Limit("total size"));
            }
        }
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file(MANIFEST, options)?;
        zip.write_all(&manifest)?;
        for (path, data) in &self.entries {
            zip.start_file(path, options)?;
            zip.write_all(data)?;
        }
        let bytes = zip.finish()?.into_inner();
        if bytes.len() as u64 > limits.archive_bytes {
            return Err(EqvzError::Limit("archive size"));
        }
        Ok(bytes)
    }
}
