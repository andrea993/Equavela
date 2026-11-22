use equavela_core::kernel::{BinaryDType, BinaryOrder};
use equavela_core::kernel_value::{
    EncodedKernelValue, KernelValue, MatrixStorage, ValueError, WireFloat,
    BINARY_MATRIX_ELEMENT_THRESHOLD,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    schema_version: u32,
    cases: Vec<FixtureCase>,
}

#[derive(Deserialize)]
struct FixtureCase {
    name: String,
    value: KernelValue,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../fixtures/kernel-values-v1.json"))
        .expect("shared kernel value fixture must parse")
}

#[test]
fn shared_golden_values_round_trip_canonically() {
    let fixture = fixture();
    assert_eq!(fixture.schema_version, 1);
    assert_eq!(fixture.cases.len(), 8);

    for case in fixture.cases {
        case.value
            .validate()
            .unwrap_or_else(|error| panic!("fixture {} is invalid: {error}", case.name));
        let json = serde_json::to_string(&case.value).unwrap();
        let decoded: KernelValue = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, case.value, "fixture {}", case.name);
    }
}

#[test]
fn real_matrix_switches_to_binary_at_the_documented_boundary() {
    let inline = EncodedKernelValue::real_matrix(
        1,
        BINARY_MATRIX_ELEMENT_THRESHOLD - 1,
        vec![1.5; BINARY_MATRIX_ELEMENT_THRESHOLD - 1],
    )
    .unwrap();
    assert!(matches!(
        inline.value,
        KernelValue::Matrix {
            storage: MatrixStorage::Inline { .. },
            ..
        }
    ));
    assert!(inline.binary.is_empty());

    let values: Vec<f64> = (0..BINARY_MATRIX_ELEMENT_THRESHOLD)
        .map(|value| value as f64 + 0.25)
        .collect();
    let binary = EncodedKernelValue::real_matrix(16, 16, values.clone()).unwrap();
    assert_eq!(binary.binary.len(), 1);
    assert_eq!(binary.payloads.len(), 1);
    assert_eq!(binary.binary[0].dtype, BinaryDType::F64Le);
    assert_eq!(binary.binary[0].shape, vec![16, 16]);
    assert_eq!(binary.binary[0].order, BinaryOrder::ColumnMajor);
    assert_eq!(binary.binary[0].bytes, values.len() * 8);

    let materialized = binary.materialize().unwrap();
    let KernelValue::Matrix {
        storage: MatrixStorage::Inline { values: decoded },
        ..
    } = materialized
    else {
        panic!("binary matrix did not materialize inline")
    };
    let decoded: Vec<f64> = decoded
        .into_iter()
        .map(|value| match value {
            KernelValue::Real { value } => value.as_f64(),
            other => panic!("unexpected value {other:?}"),
        })
        .collect();
    assert_eq!(decoded, values);
}

#[test]
fn complex_binary_payload_is_interleaved_little_endian() {
    let values: Vec<(f64, f64)> = (0..BINARY_MATRIX_ELEMENT_THRESHOLD)
        .map(|value| (value as f64, -(value as f64) - 0.5))
        .collect();
    let encoded = EncodedKernelValue::complex_matrix(256, 1, values.clone()).unwrap();
    assert_eq!(encoded.binary[0].dtype, BinaryDType::C128Le);
    assert_eq!(encoded.payloads[0].len(), values.len() * 16);
    assert_eq!(&encoded.payloads[0][0..8], &values[0].0.to_le_bytes());
    assert_eq!(&encoded.payloads[0][8..16], &values[0].1.to_le_bytes());
    encoded.validate().unwrap();
    assert_eq!(encoded.materialize().unwrap().matrix_len(), Some(256));
}

#[test]
fn validation_rejects_shape_count_and_binary_reference_mismatches() {
    let wrong_inline = KernelValue::Matrix {
        rows: 2,
        cols: 2,
        storage: MatrixStorage::Inline {
            values: vec![KernelValue::real(1.0)],
        },
    };
    assert!(matches!(
        wrong_inline.validate(),
        Err(ValueError::ElementCount { .. })
    ));

    let mut encoded = EncodedKernelValue::real_matrix(16, 16, vec![0.0; 256]).unwrap();
    encoded.binary[0].shape = vec![256, 1];
    assert!(matches!(
        encoded.validate(),
        Err(ValueError::BinaryShape { .. })
    ));
}

#[test]
fn wire_float_preserves_non_finite_values_without_invalid_json() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let encoded = serde_json::to_string(&WireFloat::from(value)).unwrap();
        assert!(encoded.starts_with('"'));
        let decoded: WireFloat = serde_json::from_str(&encoded).unwrap();
        if value.is_nan() {
            assert!(decoded.as_f64().is_nan());
        } else {
            assert_eq!(decoded.as_f64(), value);
        }
    }
}

/// A `rows` x `cols` matrix whose element at (r, c) is `1000 * r + c`, column-major.
fn numbered(rows: usize, cols: usize) -> KernelValue {
    let mut values = Vec::with_capacity(rows * cols);
    for c in 0..cols {
        for r in 0..rows {
            values.push(KernelValue::real((1000 * r + c) as f64));
        }
    }
    KernelValue::Matrix {
        rows,
        cols,
        storage: MatrixStorage::Inline { values },
    }
}

#[test]
fn a_large_matrix_reaches_the_frontend_as_its_first_block() {
    // the specification : more than 10 000 elements -> the first 100 x 50 block.
    let large = numbered(300, 80);
    let json = serde_json::to_value(large.display_form().as_ref()).unwrap();
    assert_eq!(json["rows"], 300);
    assert_eq!(json["cols"], 80);
    assert_eq!(json["storage"]["type"], "window");
    assert_eq!(
        (
            json["storage"]["rows"].clone(),
            json["storage"]["cols"].clone()
        ),
        (100.into(), 50.into())
    );
    let values = json["storage"]["values"].as_array().unwrap();
    assert_eq!(values.len(), 100 * 50);
    // Column-major inside the block: element (r, c) at c * 100 + r.
    assert_eq!(values[3 * 100 + 7]["value"], 7003.0);
    // A matrix at the limit stays whole.
    let small = numbered(100, 100);
    assert!(matches!(
        small.display_form().as_ref(),
        KernelValue::Matrix {
            storage: MatrixStorage::Inline { .. },
            ..
        }
    ));
}

#[test]
fn a_block_is_sliced_column_major_and_clipped_to_the_matrix() {
    let m = numbered(5, 4);
    let block = m.block(3, 2, 10, 10).unwrap();
    // Rows 3..5 of columns 2..4.
    let numbers: Vec<f64> = block
        .iter()
        .map(|v| match v {
            KernelValue::Real { value } => value.as_f64(),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(numbers, vec![3002.0, 4002.0, 3003.0, 4003.0]);
    assert_eq!(m.block(9, 9, 2, 2).unwrap(), Vec::<KernelValue>::new());
    assert_eq!(KernelValue::real(1.0).block(0, 0, 1, 1), None);
}

#[test]
fn the_kernel_never_sends_a_window() {
    let json = serde_json::json!({
        "type": "matrix", "rows": 2, "cols": 1,
        "storage": {"type": "window", "row": 0, "col": 0, "rows": 1, "cols": 1, "values": [{"type": "real", "value": 1.0}]}
    });
    let value: KernelValue = serde_json::from_value(json).unwrap();
    assert!(value.validate().is_err());
}
