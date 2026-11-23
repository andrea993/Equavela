//! The results file of a worksheet (`.eqeval`): the results and plot data of its last calculation,
//! written next to the worksheet and read back when it is opened, so that a calculated worksheet
//! shows its results at once.
//!
//! Layout: the 8-byte magic, the length of the JSON header as a little-endian `u64`, the header,
//! then the payloads of the large real and complex matrices in the order of the header's
//! `binary` descriptors (column-major, little-endian, as the kernel protocol sends them).
//! Every value read back is validated like a value from the kernel.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::kernel::{BinaryDType, BinaryDescriptor, BinaryOrder};
use crate::kernel_value::{KernelValue, MatrixStorage, BINARY_MATRIX_ELEMENT_THRESHOLD};
use crate::session::{CellOutput, DisplayUnit, RegionFailure, RegionKey};

/// The extension of a results file.
pub const EXTENSION: &str = "eqeval";
/// The folder of a project that holds the results files of its worksheets.
pub const PROJECT_FOLDER: &str = ".equavela/results";

const MAGIC: &[u8; 8] = b"EQEVAL\0\x01";
/// The version of the header. A file of another version is ignored.
const FORMAT: u32 = 1;

/// The stored result of one region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredEntry {
    pub key: RegionKey,
    /// The fingerprint of the region's calculation when the result was stored: the result is
    /// shown again only while the region would calculate the same way.
    pub fingerprint: String,
    pub state: StoredState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<CellOutput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum StoredState {
    Value {
        value: Option<KernelValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_unit: Option<DisplayUnit>,
    },
    Error {
        failure: RegionFailure,
    },
}

#[derive(Serialize, Deserialize)]
struct Header {
    format: u32,
    /// The version of the application that wrote the file: results of another version are not
    /// shown, since the runtime that calculated them may differ.
    app: String,
    entries: Vec<StoredEntry>,
    binary: Vec<BinaryDescriptor>,
}

/// Where the results of the worksheet at `worksheet` are kept: in `project`'s results folder, under
/// the worksheet's path inside the project, or next to a standalone worksheet.
pub fn results_path(worksheet: &Path, project: Option<&Path>) -> PathBuf {
    let file = worksheet.with_extension(EXTENSION);
    match project.and_then(|root| {
        file.strip_prefix(root)
            .ok()
            .map(|relative| (root, relative))
    }) {
        Some((root, relative)) => root.join(PROJECT_FOLDER).join(relative),
        None => file,
    }
}

/// The bytes of a results file holding `entries`.
pub fn encode(entries: &[StoredEntry]) -> Vec<u8> {
    let mut binary = Vec::new();
    let mut payloads: Vec<u8> = Vec::new();
    let entries: Vec<StoredEntry> = entries
        .iter()
        .map(|entry| StoredEntry {
            state: match &entry.state {
                StoredState::Value {
                    value,
                    display_unit,
                } => StoredState::Value {
                    value: value
                        .as_ref()
                        .map(|value| packed(value, &mut binary, &mut payloads)),
                    display_unit: display_unit.clone(),
                },
                error => error.clone(),
            },
            ..entry.clone()
        })
        .collect();
    let header = serde_json::to_vec(&Header {
        format: FORMAT,
        app: env!("CARGO_PKG_VERSION").to_owned(),
        entries,
        binary,
    })
    .expect("a results header serializes");
    let mut bytes = Vec::with_capacity(16 + header.len() + payloads.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&(header.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&payloads);
    bytes
}

/// The entries of a results file. `Err` for a file that is not a results file of this format and
/// version, or whose values are not valid.
pub fn decode(bytes: &[u8]) -> Result<Vec<StoredEntry>, String> {
    let rest = bytes
        .strip_prefix(MAGIC.as_slice())
        .ok_or("not a results file")?;
    let (length, rest) = rest.split_first_chunk::<8>().ok_or("truncated header")?;
    let length = usize::try_from(u64::from_le_bytes(*length)).map_err(|_| "header too long")?;
    if rest.len() < length {
        return Err("truncated header".into());
    }
    let (header, mut data) = rest.split_at(length);
    let header: Header = serde_json::from_slice(header).map_err(|error| error.to_string())?;
    if header.format != FORMAT || header.app != env!("CARGO_PKG_VERSION") {
        return Err("results of another version".into());
    }
    let mut payloads = Vec::with_capacity(header.binary.len());
    for descriptor in &header.binary {
        descriptor.validate().map_err(|error| error.to_string())?;
        if data.len() < descriptor.bytes {
            return Err("truncated payload".into());
        }
        let (payload, rest) = data.split_at(descriptor.bytes);
        payloads.push(payload.to_vec());
        data = rest;
    }
    header
        .entries
        .into_iter()
        .map(|entry| {
            let state = match entry.state {
                StoredState::Value {
                    value: Some(value),
                    display_unit,
                } => StoredState::Value {
                    value: Some(
                        value
                            .materialize_shared(&header.binary, &payloads)
                            .map_err(|error| error.to_string())?,
                    ),
                    display_unit,
                },
                other => other,
            };
            Ok(StoredEntry { state, ..entry })
        })
        .collect()
}

/// `value` with each large matrix of real or complex numbers moved to a payload.
fn packed(
    value: &KernelValue,
    binary: &mut Vec<BinaryDescriptor>,
    payloads: &mut Vec<u8>,
) -> KernelValue {
    let KernelValue::Matrix {
        rows,
        cols,
        storage: MatrixStorage::Inline { values },
    } = value
    else {
        return value.clone();
    };
    let dtype = if values.len() < BINARY_MATRIX_ELEMENT_THRESHOLD {
        None
    } else if values.iter().all(|v| matches!(v, KernelValue::Real { .. })) {
        Some(BinaryDType::F64Le)
    } else if values
        .iter()
        .all(|v| matches!(v, KernelValue::Complex { .. }))
    {
        Some(BinaryDType::C128Le)
    } else {
        None
    };
    let Some(dtype) = dtype else {
        return KernelValue::Matrix {
            rows: *rows,
            cols: *cols,
            storage: MatrixStorage::Inline {
                values: values.iter().map(|v| packed(v, binary, payloads)).collect(),
            },
        };
    };
    let start = payloads.len();
    for v in values {
        match v {
            KernelValue::Real { value } => {
                payloads.extend_from_slice(&value.as_f64().to_le_bytes())
            }
            KernelValue::Complex { real, imag } => {
                payloads.extend_from_slice(&real.as_f64().to_le_bytes());
                payloads.extend_from_slice(&imag.as_f64().to_le_bytes());
            }
            _ => unreachable!("checked above"),
        }
    }
    binary.push(BinaryDescriptor {
        bytes: payloads.len() - start,
        dtype,
        shape: vec![*rows, *cols],
        order: BinaryOrder::ColumnMajor,
    });
    KernelValue::Matrix {
        rows: *rows,
        cols: *cols,
        storage: MatrixStorage::Binary {
            index: binary.len() - 1,
            dtype,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::DocumentId;
    use crate::session::FailureKind;

    fn key(id: &str) -> RegionKey {
        RegionKey {
            document: DocumentId::new("/w/sheet.eqv").unwrap(),
            region_id: id.into(),
            instance: 0,
        }
    }

    fn entry(id: &str, state: StoredState) -> StoredEntry {
        StoredEntry {
            key: key(id),
            fingerprint: "f".into(),
            state,
            output: None,
        }
    }

    fn matrix(rows: usize, cols: usize, values: Vec<KernelValue>) -> KernelValue {
        KernelValue::Matrix {
            rows,
            cols,
            storage: MatrixStorage::Inline { values },
        }
    }

    #[test]
    fn results_round_trip_with_large_matrices_as_payloads() {
        let reals = matrix(
            30,
            20,
            (0..600)
                .map(|i| KernelValue::real(i as f64 / 7.0))
                .collect(),
        );
        let mixed = matrix(
            300,
            2,
            (0..600)
                .map(|i| {
                    if i % 300 == 0 {
                        KernelValue::String {
                            value: "head".into(),
                        }
                    } else {
                        KernelValue::real(i as f64)
                    }
                })
                .collect(),
        );
        let entries = vec![
            entry(
                "a",
                StoredState::Value {
                    value: Some(reals),
                    display_unit: None,
                },
            ),
            entry(
                "b",
                StoredState::Value {
                    value: Some(mixed),
                    display_unit: None,
                },
            ),
            entry(
                "c",
                StoredState::Value {
                    value: None,
                    display_unit: None,
                },
            ),
            entry(
                "d",
                StoredState::Error {
                    failure: RegionFailure {
                        kind: FailureKind::Evaluation,
                        message: "undefined".into(),
                        span: None,
                        blocked_by: None,
                        julia_type: None,
                        package: None,
                    },
                },
            ),
        ];
        let bytes = encode(&entries);
        // The real matrix travels as 600 doubles, not as JSON.
        assert!(bytes.len() < 600 * 8 + 600 * 40, "{} bytes", bytes.len());
        assert_eq!(decode(&bytes).unwrap(), entries);
    }

    #[test]
    fn other_files_are_refused() {
        assert!(decode(b"format: equavela-worksheet/3").is_err());
        let mut bytes = encode(&[entry(
            "a",
            StoredState::Value {
                value: Some(KernelValue::real(1.0)),
                display_unit: None,
            },
        )]);
        bytes.truncate(bytes.len() - 3);
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn project_results_go_to_the_results_folder() {
        assert_eq!(
            results_path(Path::new("/p/sheets/a.eqv"), Some(Path::new("/p"))),
            Path::new("/p/.equavela/results/sheets/a.eqeval")
        );
        assert_eq!(
            results_path(Path::new("/w/a.eqv"), None),
            Path::new("/w/a.eqeval")
        );
    }
}
