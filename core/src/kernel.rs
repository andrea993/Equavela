//! Transport-neutral JSON-RPC contract for the out-of-process Julia kernel.
//!
//! A transport reads one JSON header line and then exactly the raw byte counts declared
//! by [`FrameHeader::binary`]. Process spawning, timeouts and the platform-specific
//! interrupt signal belong to the kernel manager; this module only defines and validates
//! the wire representation.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const JSON_RPC_VERSION: &str = "2.0";
pub const PROTOCOL_VERSION: u32 = 1;

pub const PARSE_ERROR: i32 = -32700;
pub const INVALID_REQUEST: i32 = -32600;
pub const METHOD_NOT_FOUND: i32 = -32601;
pub const INVALID_PARAMS: i32 = -32602;
pub const INTERNAL_ERROR: i32 = -32603;
pub const EVALUATION_ERROR: i32 = -32000;
pub const INTERRUPTED: i32 = -32800;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(u64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcRequest {
    pub id: RpcId,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcNotification {
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcSuccess {
    pub id: RpcId,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcErrorResponse {
    /// `None` is permitted only when validation cannot recover the request id.
    pub id: Option<RpcId>,
    pub error: RpcError,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RpcMessage {
    Request(RpcRequest),
    Notification(RpcNotification),
    Success(RpcSuccess),
    Error(RpcErrorResponse),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Evaluation,
    Interrupted,
    InvalidInput,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorData {
    pub category: ErrorCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<RpcId>,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProgressParams {
    pub request_id: RpcId,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Slow, one-time work of a request that the user should wait for (`kernel/activity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityParams {
    pub request_id: RpcId,
    /// `packages` (installing or resolving packages), `compiling` (precompiling packages a
    /// worksheet loads) or `symbolic` (preparing Python and SymPy).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BinaryDType {
    #[serde(rename = "f64le")]
    F64Le,
    #[serde(rename = "c128le")]
    C128Le,
    #[serde(rename = "i64le")]
    I64Le,
    #[serde(rename = "u8")]
    U8,
}

impl BinaryDType {
    pub const fn element_bytes(self) -> usize {
        match self {
            BinaryDType::F64Le | BinaryDType::I64Le => 8,
            BinaryDType::C128Le => 16,
            BinaryDType::U8 => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinaryOrder {
    ColumnMajor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BinaryDescriptor {
    pub bytes: usize,
    pub dtype: BinaryDType,
    pub shape: Vec<usize>,
    pub order: BinaryOrder,
}

impl BinaryDescriptor {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        let elements = self
            .shape
            .iter()
            .try_fold(1_usize, |product, &length| product.checked_mul(length));
        let expected = elements
            .and_then(|elements| elements.checked_mul(self.dtype.element_bytes()))
            .ok_or_else(|| ProtocolError::InvalidBinary("binary shape overflows usize".into()))?;
        if self.bytes != expected {
            return Err(ProtocolError::InvalidBinary(format!(
                "descriptor declares {} bytes but dtype and shape require {expected}",
                self.bytes
            )));
        }
        Ok(())
    }
}

/// A JSON-RPC header and the binary payload descriptors immediately following its line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameHeader {
    pub message: RpcMessage,
    pub binary: Vec<BinaryDescriptor>,
}

impl FrameHeader {
    pub fn request(id: RpcId, method: impl Into<String>, params: Option<Value>) -> FrameHeader {
        FrameHeader {
            message: RpcMessage::Request(RpcRequest {
                id,
                method: method.into(),
                params,
            }),
            binary: Vec::new(),
        }
    }

    pub fn notification(method: impl Into<String>, params: Option<Value>) -> FrameHeader {
        FrameHeader {
            message: RpcMessage::Notification(RpcNotification {
                method: method.into(),
                params,
            }),
            binary: Vec::new(),
        }
    }

    pub fn success(id: RpcId, result: Value) -> FrameHeader {
        FrameHeader {
            message: RpcMessage::Success(RpcSuccess { id, result }),
            binary: Vec::new(),
        }
    }

    pub fn error(id: Option<RpcId>, error: RpcError) -> FrameHeader {
        FrameHeader {
            message: RpcMessage::Error(RpcErrorResponse { id, error }),
            binary: Vec::new(),
        }
    }

    pub fn with_binary(mut self, binary: Vec<BinaryDescriptor>) -> FrameHeader {
        self.binary = binary;
        self
    }

    pub fn encode_line(&self) -> Result<String, ProtocolError> {
        self.validate_binary()?;
        let mut object = self.message_object()?;
        if !self.binary.is_empty() {
            object.insert(
                "binary".into(),
                serde_json::to_value(&self.binary)
                    .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?,
            );
        }
        let mut line = serde_json::to_string(&object)
            .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?;
        line.push('\n');
        Ok(line)
    }

    pub fn decode_line(line: &str) -> Result<FrameHeader, ProtocolError> {
        let line = line
            .strip_suffix("\r\n")
            .or_else(|| line.strip_suffix('\n'))
            .unwrap_or(line);
        if line.contains(['\n', '\r']) {
            return Err(ProtocolError::MultipleHeaders);
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|error| ProtocolError::InvalidJson(error.to_string()))?;
        let mut object = value.as_object().cloned().ok_or(ProtocolError::NotObject)?;
        let binary = match object.remove("binary") {
            Some(value) => serde_json::from_value(value)
                .map_err(|error| ProtocolError::InvalidBinary(error.to_string()))?,
            None => Vec::new(),
        };
        let version = object
            .remove("jsonrpc")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| ProtocolError::InvalidMessage("missing string `jsonrpc`".into()))?;
        if version != JSON_RPC_VERSION {
            return Err(ProtocolError::UnsupportedVersion(version));
        }
        let message = decode_message(object)?;
        let frame = FrameHeader { message, binary };
        frame.validate_binary()?;
        Ok(frame)
    }

    pub fn payload_bytes(&self) -> Result<usize, ProtocolError> {
        self.binary.iter().try_fold(0_usize, |total, descriptor| {
            total
                .checked_add(descriptor.bytes)
                .ok_or_else(|| ProtocolError::InvalidBinary("payload size overflows usize".into()))
        })
    }

    pub fn split_payload<'a>(&self, payload: &'a [u8]) -> Result<Vec<&'a [u8]>, ProtocolError> {
        let expected = self.payload_bytes()?;
        if payload.len() != expected {
            return Err(ProtocolError::PayloadLength {
                expected,
                actual: payload.len(),
            });
        }
        let mut start = 0;
        Ok(self
            .binary
            .iter()
            .map(|descriptor| {
                let end = start + descriptor.bytes;
                let part = &payload[start..end];
                start = end;
                part
            })
            .collect())
    }

    fn validate_binary(&self) -> Result<(), ProtocolError> {
        for descriptor in &self.binary {
            descriptor.validate()?;
        }
        self.payload_bytes()?;
        Ok(())
    }

    fn message_object(&self) -> Result<Map<String, Value>, ProtocolError> {
        let mut object = Map::new();
        object.insert("jsonrpc".into(), Value::String(JSON_RPC_VERSION.into()));
        match &self.message {
            RpcMessage::Request(request) => {
                object.insert("id".into(), id_value(&request.id)?);
                object.insert("method".into(), Value::String(request.method.clone()));
                if let Some(params) = &request.params {
                    object.insert("params".into(), params.clone());
                }
            }
            RpcMessage::Notification(notification) => {
                object.insert("method".into(), Value::String(notification.method.clone()));
                if let Some(params) = &notification.params {
                    object.insert("params".into(), params.clone());
                }
            }
            RpcMessage::Success(success) => {
                object.insert("id".into(), id_value(&success.id)?);
                object.insert("result".into(), success.result.clone());
            }
            RpcMessage::Error(response) => {
                object.insert(
                    "id".into(),
                    response
                        .id
                        .as_ref()
                        .map(id_value)
                        .transpose()?
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "error".into(),
                    serde_json::to_value(&response.error)
                        .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?,
                );
            }
        }
        Ok(object)
    }
}

fn id_value(id: &RpcId) -> Result<Value, ProtocolError> {
    serde_json::to_value(id).map_err(|error| ProtocolError::InvalidMessage(error.to_string()))
}

fn decode_message(mut object: Map<String, Value>) -> Result<RpcMessage, ProtocolError> {
    let has_method = object.contains_key("method");
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_method && !has_result && !has_error {
        let method = object
            .remove("method")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| ProtocolError::InvalidMessage("`method` must be a string".into()))?;
        let params = object.remove("params");
        return match object.remove("id") {
            Some(Value::Null) => Err(ProtocolError::InvalidMessage(
                "request id cannot be null".into(),
            )),
            Some(value) => Ok(RpcMessage::Request(RpcRequest {
                id: parse_id(value)?,
                method,
                params,
            })),
            None => Ok(RpcMessage::Notification(RpcNotification { method, params })),
        };
    }
    if !has_method && has_result != has_error {
        let id = object
            .remove("id")
            .ok_or_else(|| ProtocolError::InvalidMessage("response is missing `id`".into()))?;
        if has_result {
            if id.is_null() {
                return Err(ProtocolError::InvalidMessage(
                    "success response id cannot be null".into(),
                ));
            }
            return Ok(RpcMessage::Success(RpcSuccess {
                id: parse_id(id)?,
                result: object.remove("result").expect("checked above"),
            }));
        }
        let id = if id.is_null() {
            None
        } else {
            Some(parse_id(id)?)
        };
        let error = serde_json::from_value(object.remove("error").expect("checked above"))
            .map_err(|error| ProtocolError::InvalidMessage(error.to_string()))?;
        return Ok(RpcMessage::Error(RpcErrorResponse { id, error }));
    }
    Err(ProtocolError::InvalidMessage(
        "message must contain exactly one of method, result, or error".into(),
    ))
}

fn parse_id(value: Value) -> Result<RpcId, ProtocolError> {
    serde_json::from_value(value).map_err(|_| {
        ProtocolError::InvalidMessage("id must be a string or unsigned integer".into())
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("invalid JSON header: {0}")]
    InvalidJson(String),
    #[error("JSON-RPC header must be an object")]
    NotObject,
    #[error("unsupported JSON-RPC version `{0}`")]
    UnsupportedVersion(String),
    #[error("invalid JSON-RPC message: {0}")]
    InvalidMessage(String),
    #[error("invalid binary descriptor: {0}")]
    InvalidBinary(String),
    #[error("binary payload length is {actual}, expected {expected}")]
    PayloadLength { expected: usize, actual: usize },
    #[error("input contains more than one JSON header line")]
    MultipleHeaders,
}
