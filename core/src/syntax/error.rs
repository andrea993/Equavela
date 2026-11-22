//! Parse errors with position, expected/found and an English message (math-syntax R5).

use crate::ast::Span;

/// A syntax error in sheet math text.
///
/// `line` and `column` are 1-based and relative to the parsed text (the YAML layer maps
/// them to file lines); `column` counts characters, not bytes. `span` is the byte range
/// of the offending text (compare positions with [`Span::range`]).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("line {line}, column {column}: {message}")]
pub struct ParseError {
    pub message: String,
    pub span: Span,
    pub line: usize,
    pub column: usize,
    /// What the parser expected at this point (may be empty).
    pub expected: Vec<String>,
    /// Description of what was found (`` `)` ``, `end of input`, `line break`, …).
    pub found: Option<String>,
}

impl ParseError {
    pub(crate) fn new(
        src: &str,
        span: Span,
        message: impl Into<String>,
        expected: Vec<String>,
        found: Option<String>,
    ) -> ParseError {
        let (line, column) = line_col(src, span.start);
        ParseError {
            message: message.into(),
            span,
            line,
            column,
            expected,
            found,
        }
    }

    pub(crate) fn at(src: &str, span: Span, message: impl Into<String>) -> ParseError {
        ParseError::new(src, span, message, Vec::new(), None)
    }
}

/// 1-based line and character column of a byte offset.
pub fn line_col(src: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(src.len());
    let before = &src[..floor_char_boundary(src, offset)];
    let line = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    let column = before[line_start..].chars().count() + 1;
    (line, column)
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Joins alternatives as "a, b or c".
pub(crate) fn join_alternatives(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} or {}", init.join(", "), last),
    }
}
