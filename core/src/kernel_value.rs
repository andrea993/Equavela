//! Typed values exchanged with the Julia kernel.
//!
//! JSON nodes remain independent from transport framing. [`EncodedKernelValue`]
//! joins one value to the binary descriptors and payloads referenced by it.

use std::fmt;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::ast::Expr;
use crate::kernel::{BinaryDType, BinaryDescriptor, BinaryOrder};

pub const VALUE_SCHEMA_VERSION: u32 = 1;
pub const BINARY_MATRIX_ELEMENT_THRESHOLD: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WireFloat {
    Finite(f64),
    NaN,
    PositiveInfinity,
    NegativeInfinity,
}

impl WireFloat {
    pub fn as_f64(self) -> f64 {
        match self {
            WireFloat::Finite(value) => value,
            WireFloat::NaN => f64::NAN,
            WireFloat::PositiveInfinity => f64::INFINITY,
            WireFloat::NegativeInfinity => f64::NEG_INFINITY,
        }
    }
}

impl From<f64> for WireFloat {
    fn from(value: f64) -> Self {
        if value.is_nan() {
            WireFloat::NaN
        } else if value == f64::INFINITY {
            WireFloat::PositiveInfinity
        } else if value == f64::NEG_INFINITY {
            WireFloat::NegativeInfinity
        } else {
            WireFloat::Finite(value)
        }
    }
}

impl Serialize for WireFloat {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            WireFloat::Finite(value) => serializer.serialize_f64(*value),
            WireFloat::NaN => serializer.serialize_str("nan"),
            WireFloat::PositiveInfinity => serializer.serialize_str("infinity"),
            WireFloat::NegativeInfinity => serializer.serialize_str("-infinity"),
        }
    }
}

impl<'de> Deserialize<'de> for WireFloat {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct WireFloatVisitor;

        impl<'de> Visitor<'de> for WireFloatVisitor {
            type Value = WireFloat;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a finite number or nan/infinity string")
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(WireFloat::from(value))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(WireFloat::Finite(value as f64))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(WireFloat::Finite(value as f64))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                match value {
                    "nan" => Ok(WireFloat::NaN),
                    "infinity" => Ok(WireFloat::PositiveInfinity),
                    "-infinity" => Ok(WireFloat::NegativeInfinity),
                    _ => Err(E::unknown_variant(value, &["nan", "infinity", "-infinity"])),
                }
            }
        }

        deserializer.deserialize_any(WireFloatVisitor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DimensionBase {
    Length,
    Mass,
    Time,
    Current,
    Temperature,
    Amount,
    Luminosity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RationalPower(pub i32, pub u32);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DimensionComponent {
    pub base: DimensionBase,
    pub power: RationalPower,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuantityMagnitude {
    Real { value: WireFloat },
    Complex { real: WireFloat, imag: WireFloat },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MatrixStorage {
    Inline {
        values: Vec<KernelValue>,
    },
    Binary {
        index: usize,
        dtype: BinaryDType,
    },
    /// One block of a large matrix, as the frontend receives it:
    /// the elements of rows `row..row + rows` and columns `col..col + cols`, column-major. The
    /// matrix keeps its full `rows` and `cols`. Never sent by the kernel.
    Window {
        row: usize,
        col: usize,
        rows: usize,
        cols: usize,
        values: Vec<KernelValue>,
    },
}

/// A matrix with more elements than this reaches the frontend as its first block.
pub const WINDOW_LIMIT: usize = 10_000;
/// The rows and columns of that first block.
pub const WINDOW_ROWS: usize = 100;
pub const WINDOW_COLS: usize = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelValue {
    Real {
        value: WireFloat,
    },
    Complex {
        real: WireFloat,
        imag: WireFloat,
    },
    String {
        value: String,
    },
    Quantity {
        magnitude: QuantityMagnitude,
        dimension: Vec<DimensionComponent>,
    },
    Matrix {
        rows: usize,
        cols: usize,
        storage: MatrixStorage,
    },
    Handle {
        id: String,
        julia_type: String,
        summary: String,
    },
    /// The result of a symbolic evaluation: canonical AST,
    /// normalized, and its canonical linear text.
    Symbolic {
        expr: Box<Expr>,
        #[serde(default)]
        text: String,
    },
}

impl KernelValue {
    /// The form the frontend receives: a matrix with more than [`WINDOW_LIMIT`]
    /// elements becomes its first block; every other value is itself.
    pub fn display_form(&self) -> std::borrow::Cow<'_, KernelValue> {
        match self {
            KernelValue::Matrix {
                rows,
                cols,
                storage: MatrixStorage::Inline { .. },
            } if rows.saturating_mul(*cols) > WINDOW_LIMIT => {
                let (shown_rows, shown_cols) = ((*rows).min(WINDOW_ROWS), (*cols).min(WINDOW_COLS));
                std::borrow::Cow::Owned(KernelValue::Matrix {
                    rows: *rows,
                    cols: *cols,
                    storage: MatrixStorage::Window {
                        row: 0,
                        col: 0,
                        rows: shown_rows,
                        cols: shown_cols,
                        values: self.block(0, 0, shown_rows, shown_cols).unwrap_or_default(),
                    },
                })
            }
            _ => std::borrow::Cow::Borrowed(self),
        }
    }

    /// The elements of rows `row..row + rows` and columns `col..col + cols` of a matrix held
    /// inline, column-major, clipped to the matrix. `None` for
    /// anything else.
    pub fn block(
        &self,
        row: usize,
        col: usize,
        rows: usize,
        cols: usize,
    ) -> Option<Vec<KernelValue>> {
        let KernelValue::Matrix {
            rows: all_rows,
            cols: all_cols,
            storage: MatrixStorage::Inline { values },
        } = self
        else {
            return None;
        };
        let row_end = row.saturating_add(rows).min(*all_rows);
        let col_end = col.saturating_add(cols).min(*all_cols);
        let mut block = Vec::new();
        for c in col.min(col_end)..col_end {
            let start = c * all_rows;
            block.extend_from_slice(values.get(start + row.min(row_end)..start + row_end)?);
        }
        Some(block)
    }

    /// The divisor a display unit stands for: the real value of a dimensionless unit or the
    /// real magnitude of an SI quantity (`km/hr` is `0.2777…`). `None` for anything else.
    pub fn unit_divisor(&self) -> Option<f64> {
        match self {
            KernelValue::Real { value } => Some(value.as_f64()),
            KernelValue::Quantity {
                magnitude: QuantityMagnitude::Real { value },
                ..
            } => Some(value.as_f64()),
            _ => None,
        }
    }

    pub fn real(value: f64) -> Self {
        KernelValue::Real {
            value: value.into(),
        }
    }

    pub fn validate(&self) -> Result<(), ValueError> {
        let mut references = Vec::new();
        self.validate_inner(None, &mut references)
    }

    /// Validates this value against the binary entries of a frame it shares with other
    /// values (an `evaluate` response carries several), then returns it with every binary
    /// matrix converted to inline storage. Unlike [`EncodedKernelValue::materialize`] it does
    /// not require this value to reference every entry of the frame.
    pub fn materialize_shared(
        &self,
        descriptors: &[BinaryDescriptor],
        payloads: &[Vec<u8>],
    ) -> Result<KernelValue, ValueError> {
        let mut references = Vec::new();
        self.validate_inner(Some((descriptors, payloads)), &mut references)?;
        materialize_value(self, payloads)
    }

    pub fn matrix_len(&self) -> Option<usize> {
        match self {
            KernelValue::Matrix { rows, cols, .. } => rows.checked_mul(*cols),
            _ => None,
        }
    }

    fn validate_inner(
        &self,
        binary: Option<(&[BinaryDescriptor], &[Vec<u8>])>,
        references: &mut Vec<usize>,
    ) -> Result<(), ValueError> {
        match self {
            KernelValue::Quantity { dimension, .. } => validate_dimension(dimension),
            KernelValue::Matrix {
                rows,
                cols,
                storage,
            } => {
                let expected = rows
                    .checked_mul(*cols)
                    .ok_or(ValueError::MatrixShapeOverflow)?;
                match storage {
                    MatrixStorage::Inline { values } => {
                        if values.len() != expected {
                            return Err(ValueError::ElementCount {
                                expected,
                                actual: values.len(),
                            });
                        }
                        for value in values {
                            value.validate_inner(binary, references)?;
                        }
                    }
                    MatrixStorage::Window { .. } => return Err(ValueError::WindowFromKernel),
                    MatrixStorage::Binary { index, dtype } => {
                        let Some((descriptors, payloads)) = binary else {
                            return Err(ValueError::BinaryOutsideFrame { index: *index });
                        };
                        let descriptor = descriptors
                            .get(*index)
                            .ok_or(ValueError::MissingBinary { index: *index })?;
                        let payload = payloads
                            .get(*index)
                            .ok_or(ValueError::MissingBinary { index: *index })?;
                        if descriptor.dtype != *dtype {
                            return Err(ValueError::BinaryDType {
                                index: *index,
                                expected: *dtype,
                                actual: descriptor.dtype,
                            });
                        }
                        if descriptor.shape.as_slice() != [*rows, *cols] {
                            return Err(ValueError::BinaryShape {
                                index: *index,
                                expected: vec![*rows, *cols],
                                actual: descriptor.shape.clone(),
                            });
                        }
                        if descriptor.order != BinaryOrder::ColumnMajor {
                            return Err(ValueError::BinaryOrder { index: *index });
                        }
                        if payload.len() != descriptor.bytes {
                            return Err(ValueError::PayloadLength {
                                index: *index,
                                expected: descriptor.bytes,
                                actual: payload.len(),
                            });
                        }
                        references.push(*index);
                    }
                }
                Ok(())
            }
            KernelValue::Handle { id, julia_type, .. } => {
                if id.is_empty() || julia_type.is_empty() {
                    Err(ValueError::EmptyHandleField)
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }
}

fn validate_dimension(dimension: &[DimensionComponent]) -> Result<(), ValueError> {
    let mut previous = None;
    for component in dimension {
        let RationalPower(numerator, denominator) = component.power;
        if denominator == 0 {
            return Err(ValueError::ZeroPowerDenominator);
        }
        if numerator == 0 {
            return Err(ValueError::ZeroDimensionPower);
        }
        if gcd(numerator.unsigned_abs(), denominator) != 1 {
            return Err(ValueError::UnreducedDimensionPower);
        }
        if previous.is_some_and(|base| base >= component.base) {
            return Err(ValueError::NonCanonicalDimension);
        }
        previous = Some(component.base);
    }
    Ok(())
}

const fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

#[derive(Debug, Clone, PartialEq)]
pub struct EncodedKernelValue {
    pub value: KernelValue,
    pub binary: Vec<BinaryDescriptor>,
    pub payloads: Vec<Vec<u8>>,
}

impl EncodedKernelValue {
    pub fn inline(value: KernelValue) -> Result<Self, ValueError> {
        value.validate()?;
        Ok(Self {
            value,
            binary: Vec::new(),
            payloads: Vec::new(),
        })
    }

    pub fn real_matrix(rows: usize, cols: usize, values: Vec<f64>) -> Result<Self, ValueError> {
        validate_matrix_count(rows, cols, values.len())?;
        if values.len() < BINARY_MATRIX_ELEMENT_THRESHOLD {
            return Self::inline(KernelValue::Matrix {
                rows,
                cols,
                storage: MatrixStorage::Inline {
                    values: values.into_iter().map(KernelValue::real).collect(),
                },
            });
        }
        let mut payload = Vec::with_capacity(values.len() * 8);
        for value in values {
            payload.extend_from_slice(&value.to_le_bytes());
        }
        Self::binary_matrix(rows, cols, BinaryDType::F64Le, payload)
    }

    pub fn complex_matrix(
        rows: usize,
        cols: usize,
        values: Vec<(f64, f64)>,
    ) -> Result<Self, ValueError> {
        validate_matrix_count(rows, cols, values.len())?;
        if values.len() < BINARY_MATRIX_ELEMENT_THRESHOLD {
            return Self::inline(KernelValue::Matrix {
                rows,
                cols,
                storage: MatrixStorage::Inline {
                    values: values
                        .into_iter()
                        .map(|(real, imag)| KernelValue::Complex {
                            real: real.into(),
                            imag: imag.into(),
                        })
                        .collect(),
                },
            });
        }
        let mut payload = Vec::with_capacity(values.len() * 16);
        for (real, imag) in values {
            payload.extend_from_slice(&real.to_le_bytes());
            payload.extend_from_slice(&imag.to_le_bytes());
        }
        Self::binary_matrix(rows, cols, BinaryDType::C128Le, payload)
    }

    fn binary_matrix(
        rows: usize,
        cols: usize,
        dtype: BinaryDType,
        payload: Vec<u8>,
    ) -> Result<Self, ValueError> {
        let value = KernelValue::Matrix {
            rows,
            cols,
            storage: MatrixStorage::Binary { index: 0, dtype },
        };
        let encoded = Self {
            value,
            binary: vec![BinaryDescriptor {
                bytes: payload.len(),
                dtype,
                shape: vec![rows, cols],
                order: BinaryOrder::ColumnMajor,
            }],
            payloads: vec![payload],
        };
        encoded.validate()?;
        Ok(encoded)
    }

    pub fn validate(&self) -> Result<(), ValueError> {
        if self.binary.len() != self.payloads.len() {
            return Err(ValueError::BinaryPayloadCount {
                descriptors: self.binary.len(),
                payloads: self.payloads.len(),
            });
        }
        for descriptor in &self.binary {
            descriptor
                .validate()
                .map_err(|error| ValueError::InvalidDescriptor(error.to_string()))?;
        }
        let mut references = Vec::new();
        self.value
            .validate_inner(Some((&self.binary, &self.payloads)), &mut references)?;
        references.sort_unstable();
        references.dedup();
        if references.len() != self.binary.len()
            || references.iter().copied().ne(0..self.binary.len())
        {
            return Err(ValueError::UnreferencedBinary);
        }
        Ok(())
    }

    pub fn materialize(&self) -> Result<KernelValue, ValueError> {
        self.validate()?;
        materialize_value(&self.value, &self.payloads)
    }
}

fn validate_matrix_count(rows: usize, cols: usize, actual: usize) -> Result<(), ValueError> {
    let expected = rows
        .checked_mul(cols)
        .ok_or(ValueError::MatrixShapeOverflow)?;
    if actual != expected {
        return Err(ValueError::ElementCount { expected, actual });
    }
    Ok(())
}

fn materialize_value(value: &KernelValue, payloads: &[Vec<u8>]) -> Result<KernelValue, ValueError> {
    let KernelValue::Matrix {
        rows,
        cols,
        storage,
    } = value
    else {
        return Ok(value.clone());
    };
    let values = match storage {
        MatrixStorage::Inline { values } => values
            .iter()
            .map(|value| materialize_value(value, payloads))
            .collect::<Result<Vec<_>, _>>()?,
        MatrixStorage::Window { .. } => return Ok(value.clone()),
        MatrixStorage::Binary { index, dtype } => {
            let payload = &payloads[*index];
            match dtype {
                BinaryDType::F64Le => payload
                    .as_chunks::<8>()
                    .0
                    .iter()
                    .map(|bytes| KernelValue::real(f64::from_le_bytes(*bytes)))
                    .collect(),
                BinaryDType::C128Le => payload
                    .as_chunks::<16>()
                    .0
                    .iter()
                    .map(|bytes| {
                        let real = f64::from_le_bytes(
                            bytes[0..8].try_into().expect("validated real chunk"),
                        );
                        let imag = f64::from_le_bytes(
                            bytes[8..16].try_into().expect("validated imaginary chunk"),
                        );
                        KernelValue::Complex {
                            real: real.into(),
                            imag: imag.into(),
                        }
                    })
                    .collect(),
                other => return Err(ValueError::UnsupportedMatrixDType(*other)),
            }
        }
    };
    Ok(KernelValue::Matrix {
        rows: *rows,
        cols: *cols,
        storage: MatrixStorage::Inline { values },
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ValueError {
    #[error("a window of a matrix is a frontend form, never a kernel value")]
    WindowFromKernel,
    #[error("matrix shape overflows usize")]
    MatrixShapeOverflow,
    #[error("matrix has {actual} elements, expected {expected}")]
    ElementCount { expected: usize, actual: usize },
    #[error("dimension power denominator cannot be zero")]
    ZeroPowerDenominator,
    #[error("zero dimension powers must be omitted")]
    ZeroDimensionPower,
    #[error("dimension powers must be reduced")]
    UnreducedDimensionPower,
    #[error("dimension components must be unique and in canonical order")]
    NonCanonicalDimension,
    #[error("opaque handle id and Julia type cannot be empty")]
    EmptyHandleField,
    #[error("binary matrix entry {index} requires frame payloads")]
    BinaryOutsideFrame { index: usize },
    #[error("binary entry {index} is missing")]
    MissingBinary { index: usize },
    #[error("binary entry {index} dtype is {actual:?}, expected {expected:?}")]
    BinaryDType {
        index: usize,
        expected: BinaryDType,
        actual: BinaryDType,
    },
    #[error("binary entry {index} shape is {actual:?}, expected {expected:?}")]
    BinaryShape {
        index: usize,
        expected: Vec<usize>,
        actual: Vec<usize>,
    },
    #[error("binary entry {index} is not column-major")]
    BinaryOrder { index: usize },
    #[error("binary entry {index} payload has {actual} bytes, expected {expected}")]
    PayloadLength {
        index: usize,
        expected: usize,
        actual: usize,
    },
    #[error("frame has {descriptors} descriptors and {payloads} payloads")]
    BinaryPayloadCount { descriptors: usize, payloads: usize },
    #[error("invalid binary descriptor: {0}")]
    InvalidDescriptor(String),
    #[error("every binary entry must be referenced by the value exactly by index set")]
    UnreferencedBinary,
    #[error("{0:?} is not a supported matrix binary dtype")]
    UnsupportedMatrixDType(BinaryDType),
}
