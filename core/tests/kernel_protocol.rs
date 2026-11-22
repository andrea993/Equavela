use equavela_core::kernel::{
    BinaryDType, BinaryDescriptor, BinaryOrder, ErrorCategory, ErrorData, FrameHeader,
    ProgressParams, ProtocolError, RpcError, RpcId, RpcMessage, INTERRUPTED,
};
use serde_json::{json, Value};

#[test]
fn requests_notifications_and_responses_round_trip() {
    let request =
        FrameHeader::request(RpcId::Number(7), "evaluate", Some(json!({"code": "1 + 2"})));
    let decoded = FrameHeader::decode_line(&request.encode_line().unwrap()).unwrap();
    assert_eq!(decoded, request);

    let notification = FrameHeader::notification(
        "kernel/progress",
        Some(
            serde_json::to_value(ProgressParams {
                request_id: RpcId::String("region-4".into()),
                sequence: 2,
                fraction: Some(0.5),
                message: Some("Compiling".into()),
            })
            .unwrap(),
        ),
    );
    assert_eq!(
        FrameHeader::decode_line(&notification.encode_line().unwrap()).unwrap(),
        notification
    );

    let success = FrameHeader::success(RpcId::Number(7), json!({"value": 3.0}));
    assert_eq!(
        FrameHeader::decode_line(&success.encode_line().unwrap()).unwrap(),
        success
    );
}

#[test]
fn rejects_invalid_json_rpc_shapes_and_versions() {
    assert!(matches!(
        FrameHeader::decode_line("{not json}\n"),
        Err(ProtocolError::InvalidJson(_))
    ));
    assert!(matches!(
        FrameHeader::decode_line(r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#),
        Err(ProtocolError::UnsupportedVersion(_))
    ));
    assert!(matches!(
        FrameHeader::decode_line(
            r#"{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":-1,"message":"bad"}}"#
        ),
        Err(ProtocolError::InvalidMessage(_))
    ));
    assert!(matches!(
        FrameHeader::decode_line(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#),
        Err(ProtocolError::InvalidMessage(_))
    ));
}

#[test]
fn interrupted_errors_are_structured_and_tagged_with_the_request() {
    let id = RpcId::String("evaluation-9".into());
    let frame = FrameHeader::error(
        Some(id.clone()),
        RpcError {
            code: INTERRUPTED,
            message: "Interrupted".into(),
            data: Some(
                serde_json::to_value(ErrorData {
                    category: ErrorCategory::Interrupted,
                    request_id: Some(id.clone()),
                    retryable: true,
                    details: None,
                })
                .unwrap(),
            ),
        },
    );
    let decoded = FrameHeader::decode_line(&frame.encode_line().unwrap()).unwrap();

    let RpcMessage::Error(response) = decoded.message else {
        panic!("expected an error response");
    };
    assert_eq!(response.error.code, INTERRUPTED);
    let data: ErrorData = serde_json::from_value(response.error.data.unwrap()).unwrap();
    assert_eq!(data.category, ErrorCategory::Interrupted);
    assert_eq!(data.request_id, Some(id));
    assert!(data.retryable);
}

#[test]
fn binary_descriptors_validate_shape_size_and_exact_payload_boundaries() {
    let descriptors = vec![
        BinaryDescriptor {
            bytes: 48,
            dtype: BinaryDType::F64Le,
            shape: vec![2, 3],
            order: BinaryOrder::ColumnMajor,
        },
        BinaryDescriptor {
            bytes: 4,
            dtype: BinaryDType::U8,
            shape: vec![4],
            order: BinaryOrder::ColumnMajor,
        },
    ];
    let frame =
        FrameHeader::success(RpcId::Number(4), json!({"value": "binary"})).with_binary(descriptors);
    let decoded = FrameHeader::decode_line(&frame.encode_line().unwrap()).unwrap();
    let payload = vec![0_u8; 52];
    let slices = decoded.split_payload(&payload).unwrap();
    assert_eq!(
        slices.iter().map(|slice| slice.len()).collect::<Vec<_>>(),
        [48, 4]
    );

    assert!(matches!(
        decoded.split_payload(&payload[..51]),
        Err(ProtocolError::PayloadLength {
            expected: 52,
            actual: 51
        })
    ));
    assert!(matches!(
        FrameHeader::decode_line(
            r#"{"jsonrpc":"2.0","id":1,"result":null,"binary":[{"bytes":7,"dtype":"f64le","shape":[1],"order":"column-major"}]}"#
        ),
        Err(ProtocolError::InvalidBinary(_))
    ));
}

#[test]
fn float_serialization_is_bit_exact() {
    let values = [
        f64::from_bits(1),
        0.1_f64,
        std::f64::consts::PI,
        f64::MAX,
        f64::MIN_POSITIVE,
    ];
    for (index, value) in values.into_iter().enumerate() {
        let frame = FrameHeader::success(RpcId::Number(index as u64), json!(value));
        let decoded = FrameHeader::decode_line(&frame.encode_line().unwrap()).unwrap();
        let RpcMessage::Success(response) = decoded.message else {
            panic!("expected success response");
        };
        let returned = response.result.as_f64().unwrap();
        assert_eq!(returned.to_bits(), value.to_bits());
    }
}

#[test]
fn encoded_headers_are_exactly_one_line() {
    let frame = FrameHeader::request(
        RpcId::Number(1),
        "evaluate",
        Some(json!({"source": "line one\nline two"})),
    );
    let line = frame.encode_line().unwrap();
    assert!(line.ends_with('\n'));
    assert_eq!(line.bytes().filter(|byte| *byte == b'\n').count(), 1);
    assert!(matches!(
        FrameHeader::decode_line("{}\n{}\n"),
        Err(ProtocolError::MultipleHeaders)
    ));
}

#[test]
fn error_data_preserves_arbitrary_details() {
    let details: Value = json!({"region": "r7", "line": 3, "stack": ["f", "g"]});
    let data = ErrorData {
        category: ErrorCategory::Evaluation,
        request_id: Some(RpcId::Number(12)),
        retryable: false,
        details: Some(details.clone()),
    };
    assert_eq!(
        serde_json::from_value::<ErrorData>(serde_json::to_value(data).unwrap())
            .unwrap()
            .details,
        Some(details)
    );
}
