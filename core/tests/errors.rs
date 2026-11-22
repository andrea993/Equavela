//! Malformed inputs: errors carry line, column, span, expected/found and an English
//! message (math-syntax R5).

use equavela_core::syntax::{parse_expression, parse_program_block, parse_statement, ParseError};

fn err(src: &str) -> ParseError {
    match parse_statement(src) {
        Ok(s) => panic!("{src:?} should not parse, got {s:?}"),
        Err(e) => e,
    }
}

/// Asserts the 1-based line and column and a fragment of the message.
fn check(src: &str, line: usize, column: usize, message: &str) -> ParseError {
    let e = err(src);
    assert_eq!(
        (e.line, e.column),
        (line, column),
        "position for {src:?}: {e}"
    );
    assert!(
        e.message.contains(message),
        "message for {src:?}: {:?} does not contain {message:?}",
        e.message
    );
    assert!(e.span.start <= src.len() && e.span.end <= src.len());
    e
}

#[test]
fn unclosed_parenthesis() {
    let e = check("x := (a + b", 1, 12, "expected `)`, found end of input");
    assert_eq!(e.expected, vec!["`)`".to_string()]);
    assert_eq!(e.found.as_deref(), Some("end of input"));
    assert_eq!(e.span.range(), 11..11);
}

#[test]
fn missing_operand() {
    let e = check(
        "x := a +",
        1,
        9,
        "expected an expression, found end of input",
    );
    assert_eq!(
        e.to_string(),
        "line 1, column 9: expected an expression, found end of input"
    );
}

#[test]
fn ragged_matrix() {
    let e = check(
        "x := [1, 2; 3]",
        1,
        13,
        "matrix row 2 has 1 cells, expected 2",
    );
    assert_eq!(e.span.range(), 12..13);
}

#[test]
fn mixed_else_if_and_also_if() {
    check(
        "f(x) := program\n  if a\n    1\n  also if b\n    2\n  else if c\n    3",
        6,
        3,
        "`else if` and `also if` cannot be mixed",
    );
}

#[test]
fn orphan_else() {
    check(
        "f := program\n  else\n    1",
        2,
        3,
        "`else` without a matching `if`",
    );
}

#[test]
fn orphan_on_error() {
    check(
        "f := program\n  on error\n    1",
        2,
        3,
        "`on error` without a matching `try`",
    );
}

#[test]
fn tab_character() {
    check("x := a\tb", 1, 7, "tab characters are not allowed");
}

#[test]
fn unterminated_string() {
    let e = check("x := \"abc", 1, 6, "unterminated string literal");
    assert_eq!(e.span.range(), 5..9);
}

#[test]
fn unknown_backslash_word() {
    let e = check("x := \\foo(a)", 1, 6, "unknown backslash word `\\foo`");
    assert_eq!(e.span.range(), 5..9);
}

#[test]
fn unknown_label() {
    check("x := y@bogus", 1, 7, "unknown label `@bogus`");
}

#[test]
fn local_definition_at_worksheet_level() {
    check(
        "x ← 3",
        1,
        3,
        "`←` is allowed only after a target in a program statement",
    );
}

#[test]
fn a_range_inside_a_call_parses() {
    // a two-bound range is a call argument; the codegen decides.
    equavela_core::parse_statement("y := f(0..3)").expect("a range is an argument");
}

#[test]
fn range_in_a_local_definition() {
    check(
        "f := program\n  x ← 0..3",
        2,
        8,
        "a range is allowed only as the right side",
    );
}

#[test]
fn try_without_on_error() {
    check(
        "f(x) := program\n  try\n    a\n  b",
        4,
        3,
        "expected `on error` after the body of `try`",
    );
}

#[test]
fn unexpected_indentation() {
    check(
        "f(x) := program\n  a\n    b",
        3,
        5,
        "unexpected indentation",
    );
}

#[test]
fn continuation_not_indented() {
    check(
        "x := a +\nb",
        2,
        1,
        "continuation of a broken line must be indented",
    );
}

#[test]
fn line_break_without_operator() {
    check("x := a\n    + b", 1, 7, "unexpected line break");
}

#[test]
fn empty_quoted_name() {
    check("x := ``", 1, 6, "empty quoted name");
}

#[test]
fn invalid_definition_target() {
    check("2 := x", 1, 3, "invalid left side of a definition");
}

#[test]
fn return_without_value() {
    check(
        "x := program\n  return",
        2,
        9,
        "expected an expression after `return`",
    );
}

#[test]
fn program_without_body() {
    check(
        "S(n) := program",
        1,
        16,
        "expected a line break and an indented block after `program`",
    );
}

#[test]
fn unclosed_absolute_value() {
    check("x := |a + b", 1, 12, "expected `|`, found end of input");
}

#[test]
fn julia_name_without_call() {
    check(
        "x := ControlSystems::lqr",
        1,
        25,
        "expected `(` after a qualified Julia function name",
    );
}

#[test]
fn ellipsis_without_unit() {
    check("v = …", 1, 6, "expected a unit after `…`");
}

#[test]
fn for_without_element_of() {
    check(
        "x := program\n  for i 1..n\n    a",
        2,
        9,
        "expected `∈`, found number `1`",
    );
}

#[test]
fn unmatched_closing_bracket() {
    check("x := a)", 1, 7, "unmatched `)`");
}

#[test]
fn global_definition_with_tail() {
    check(
        "x ≡ 3 =",
        1,
        7,
        "a global definition cannot have an evaluation tail",
    );
}

#[test]
fn subscript_marker_without_subscript() {
    check("x := F_ + 1", 1, 7, "expected a subscript after `_`");
}

#[test]
fn block_program_inside_an_expression() {
    check(
        "x := 1 + program",
        1,
        10,
        "a block `program` must be the whole right side",
    );
}

#[test]
fn columns_are_counted_in_characters() {
    // `η` and `·` are two bytes each in UTF-8; the column counts characters.
    let e = check("η := a·)", 1, 8, "expected an expression, found `)`");
    assert_eq!(e.span.range(), 9..10);
}

/// A `←` whose left side is not a name, an indexed name, a function head or a destructuring
/// matrix is reported, not read as an expression.
#[test]
fn a_bad_local_definition_target_is_reported() {
    let e = parse_statement("f := program\n  g(x + 1) ← 1").unwrap_err();
    assert!(e.message.contains("invalid target of `←`"), "{e:?}");
    assert_eq!(e.line, 2);
}

/// A nested destructuring cell is a target, not an expression: a cell that is not a
/// name, an indexed name, a column or a row leaves the matrix an ordinary matrix expression, so
/// the statement is reported as a bad definition target and not silently accepted.
#[test]
fn a_nested_destructuring_cell_must_be_a_target() {
    check("[[1, 2]] := v", 1, 10, "invalid left side of a definition");
    let e = parse_statement("S(M) := program\n  [[f(x)]] ← M").unwrap_err();
    assert!(e.message.contains("invalid target of `←`"), "{e:?}");
    assert_eq!(e.line, 2);
    // The same in an inline argument definition: a matrix of values is not a target.
    let e = parse_statement("f([1, 2] ← x)").unwrap_err();
    assert!(e.message.contains("expected `,` or `)`"), "{e:?}");
}

#[test]
fn other_entry_points_report_errors() {
    let e = parse_expression("a +* b").unwrap_err();
    assert_eq!((e.line, e.column), (1, 4));
    let e = parse_program_block("a\n  b").unwrap_err();
    assert_eq!((e.line, e.column), (2, 3));
    assert!(e.message.contains("unexpected indentation"));
}
