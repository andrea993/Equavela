//! Conservative lexical analysis of the free Julia code of a `julia` region.
//!
//! The core never parses Julia. Two questions are answered from the text alone:
//!
//! * which names does the code **define at top level** (so math regions can use them):
//!   only statements that start in column 0 count, and only these shapes are recognised:
//!   `function f(...)`, `f(...) = ...`, `f(...)::T = ...`, `x = ...`, `x::T = ...`,
//!   `a, b = ...`, `const x = ...`, `global x = ...`, `struct T`, `mutable struct T`,
//!   `abstract type T`. Anything indented, inside a `begin`/`let`/`if` block or produced by
//!   a macro is invisible; a `defines:` list in the region names such definitions
//!   explicitly;
//! * which identifiers does the code **mention** (comments and strings excluded), so the
//!   dependency graph can connect the region to the worksheet variables it reads.
//!
//! Over-approximating mentions is harmless (an extra dependency); the definition scan is
//! deliberately narrow so that a name is never exported by accident.

use crate::ast::{ExprKind, JuliaBlock, JuliaImportDecl, Name, Segment};
use crate::codegen::is_reserved_name;
use crate::parse_expression;

/// Whether `text` is a plain Julia identifier.
pub fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '!')
}

/// The worksheet name for a Julia identifier. Following the math grammar (D1), everything
/// after the first `_` is a literal subscript: `my_func` is `my` with subscript `func`,
/// written `my_func` in math text.
pub fn math_name(text: &str) -> Name {
    match text.find('_') {
        Some(index) if index > 0 => Name {
            segments: vec![
                Segment {
                    text: text[..index].to_string(),
                    subscript: false,
                },
                Segment {
                    text: text[index + 1..].to_string(),
                    subscript: true,
                },
            ],
            label: None,
        },
        _ => Name::plain(text),
    }
}

/// The Julia identifier for a worksheet name: the inverse of [`math_name`]. `None` for
/// names with more than one subscript segment or an index-like structure.
pub fn julia_text(name: &Name) -> Option<String> {
    match name.segments.as_slice() {
        [base] if !base.subscript => Some(base.text.clone()),
        [base, sub] if !base.subscript && sub.subscript => {
            Some(format!("{}_{}", base.text, sub.text))
        }
        _ => None,
    }
}

/// Whether `text` is usable as a worksheet name for a Julia definition: a Julia
/// identifier that the math grammar reads back as the same name ([`math_name`]).
pub fn is_math_name(text: &str) -> bool {
    if !is_identifier(text) || text.starts_with("eq_") || text.starts_with('_') {
        return false;
    }
    match parse_expression(text) {
        Ok(expr) => match expr.kind {
            ExprKind::Ident { name } => {
                name.label.is_none() && julia_text(&name).as_deref() == Some(text)
            }
            _ => false,
        },
        Err(_) => false,
    }
}

/// A scanner over Julia source that skips comments and strings.
struct Scanner {
    chars: Vec<char>,
    index: usize,
}

impl Scanner {
    fn new(text: &str) -> Self {
        Scanner {
            chars: text.chars().collect(),
            index: 0,
        }
    }

    fn peek(&self, offset: usize) -> Option<char> {
        self.chars.get(self.index + offset).copied()
    }

    fn starts_with(&self, text: &str) -> bool {
        text.chars()
            .enumerate()
            .all(|(i, c)| self.peek(i) == Some(c))
    }

    /// Skips a `#` line comment or a (nested) `#= ... =#` block comment. The cursor is on `#`.
    fn skip_comment(&mut self) {
        if self.peek(1) == Some('=') {
            let mut depth = 0;
            while self.index < self.chars.len() {
                if self.starts_with("#=") {
                    depth += 1;
                    self.index += 2;
                } else if self.starts_with("=#") {
                    depth -= 1;
                    self.index += 2;
                    if depth == 0 {
                        return;
                    }
                } else {
                    self.index += 1;
                }
            }
        } else {
            while self.index < self.chars.len() && self.chars[self.index] != '\n' {
                self.index += 1;
            }
        }
    }

    /// Skips a string literal and returns the identifiers interpolated with `$name`.
    /// The cursor is on the opening quote.
    fn skip_string(&mut self) -> Vec<String> {
        let mut interpolated = Vec::new();
        let triple = self.starts_with("\"\"\"");
        self.index += if triple { 3 } else { 1 };
        while self.index < self.chars.len() {
            let c = self.chars[self.index];
            if c == '\\' {
                self.index += 2;
            } else if c == '$' {
                self.index += 1;
                if self.peek(0).is_some_and(|c| c.is_alphabetic() || c == '_') {
                    let start = self.index;
                    while self
                        .peek(0)
                        .is_some_and(|c| c.is_alphanumeric() || c == '_')
                    {
                        self.index += 1;
                    }
                    interpolated.push(self.chars[start..self.index].iter().collect());
                }
            } else if triple && self.starts_with("\"\"\"") {
                self.index += 3;
                return interpolated;
            } else if !triple && c == '"' {
                self.index += 1;
                return interpolated;
            } else {
                self.index += 1;
            }
        }
        interpolated
    }
}

/// Every identifier mentioned in `code` outside comments and strings (plus `$name`
/// interpolations), without duplicates, in order of first appearance. Keywords are
/// included; callers match the result against known names.
pub fn identifier_tokens(code: &str) -> Vec<String> {
    let mut scanner = Scanner::new(code);
    let mut out: Vec<String> = Vec::new();
    let push = |token: String, out: &mut Vec<String>| {
        if !out.contains(&token) {
            out.push(token);
        }
    };
    while let Some(c) = scanner.peek(0) {
        if c == '#' {
            scanner.skip_comment();
        } else if c == '"' {
            for token in scanner.skip_string() {
                push(token, &mut out);
            }
        } else if c == '\'' {
            // A character literal (`'a'`, `'\n'`) or a transpose; only skip the former.
            let previous = scanner.index.checked_sub(1).map(|i| scanner.chars[i]);
            let transpose = previous
                .is_some_and(|p| p.is_alphanumeric() || matches!(p, '_' | ')' | ']' | '\'' | '.'));
            if !transpose {
                let close = if scanner.peek(1) == Some('\\') { 3 } else { 2 };
                if scanner.peek(close) == Some('\'') {
                    scanner.index += close + 1;
                    continue;
                }
            }
            scanner.index += 1;
        } else if c == '@' {
            scanner.index += 1;
            while scanner
                .peek(0)
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '!')
            {
                scanner.index += 1;
            }
        } else if c.is_ascii_digit() {
            // A number literal: `1e5`, `0x1f`, `2.5f0`, `1_000`.
            while scanner
                .peek(0)
                .is_some_and(|c| c.is_alphanumeric() || c == '_')
            {
                scanner.index += 1;
            }
        } else if c.is_alphabetic() || c == '_' {
            let start = scanner.index;
            while let Some(c) = scanner.peek(0) {
                if c.is_alphanumeric() || c == '_' || (c == '!' && scanner.peek(1) != Some('=')) {
                    scanner.index += 1;
                } else {
                    break;
                }
            }
            let token: String = scanner.chars[start..scanner.index].iter().collect();
            push(token, &mut out);
        } else {
            scanner.index += 1;
        }
    }
    out
}

/// The lines of `code` that start a top-level statement in column 0: code outside
/// comments, strings and indented continuation lines. Returns `(line text)` values.
fn top_level_lines(code: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut in_block_comment = 0usize;
    let mut in_triple = false;
    for line in code.lines() {
        let starts_inside = in_block_comment > 0 || in_triple;
        // Track multi-line constructs on this line.
        let mut scanner = Scanner::new(line);
        let mut visible = String::new();
        let mut triple = in_triple;
        let mut block = in_block_comment;
        let mut string = false;
        while let Some(c) = scanner.peek(0) {
            if block > 0 {
                if scanner.starts_with("#=") {
                    block += 1;
                    scanner.index += 2;
                } else if scanner.starts_with("=#") {
                    block -= 1;
                    scanner.index += 2;
                } else {
                    scanner.index += 1;
                }
            } else if triple {
                if scanner.starts_with("\"\"\"") {
                    triple = false;
                    scanner.index += 3;
                } else {
                    scanner.index += if c == '\\' { 2 } else { 1 };
                }
            } else if string {
                if c == '\\' {
                    scanner.index += 2;
                } else {
                    if c == '"' {
                        string = false;
                    }
                    scanner.index += 1;
                }
            } else if c == '#' {
                if scanner.peek(1) == Some('=') {
                    block = 1;
                    scanner.index += 2;
                } else {
                    break;
                }
            } else if scanner.starts_with("\"\"\"") {
                triple = true;
                scanner.index += 3;
                visible.push_str("\"\"\"");
            } else if c == '"' {
                string = true;
                scanner.index += 1;
                visible.push('"');
            } else {
                visible.push(c);
                scanner.index += 1;
            }
        }
        in_triple = triple;
        in_block_comment = block;
        if !starts_inside && !line.starts_with([' ', '\t']) && !visible.trim().is_empty() {
            lines.push(visible);
        }
    }
    lines
}

fn read_identifier(text: &str) -> Option<(&str, &str)> {
    let mut end = 0;
    for (i, c) in text.char_indices() {
        let ok = if i == 0 {
            c.is_alphabetic() || c == '_'
        } else {
            c.is_alphanumeric() || c == '_' || c == '!'
        };
        if !ok {
            break;
        }
        end = i + c.len_utf8();
    }
    // `x!=y` is not an identifier ending in `!`.
    if text[..end].ends_with('!') && text[end..].starts_with('=') {
        end -= 1;
    }
    (end > 0).then(|| (&text[..end], &text[end..]))
}

fn assignment_follows(rest: &str) -> bool {
    let rest = rest.trim_start();
    rest.starts_with('=') && !rest.starts_with("==") && !rest.starts_with("=>")
}

/// A type annotation `::T` followed by `=`: `x::Float64 = 3`.
fn annotated_assignment(rest: &str) -> bool {
    let rest = rest.trim_start();
    let Some(after) = rest.strip_prefix("::") else {
        return false;
    };
    let bytes: Vec<char> = after.chars().collect();
    let mut depth = 0i32;
    for (i, c) in bytes.iter().enumerate() {
        match c {
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            '=' if depth == 0 => {
                let next = bytes.get(i + 1);
                let prev = i.checked_sub(1).map(|p| bytes[p]);
                return next != Some(&'=')
                    && !matches!(prev, Some('=' | '<' | '>' | '!'))
                    && next != Some(&'>');
            }
            _ => {}
        }
    }
    false
}

/// Index just past the parenthesis group that opens at `text[0]`.
fn skip_parens(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in text.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Names defined at top level by `code` (see the module documentation). Order of first
/// appearance, no duplicates. The result may contain names that are not valid worksheet
/// names; filter with [`is_math_name`].
pub fn defined_names(code: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut add = |name: &str| {
        if !names.iter().any(|known| known == name) {
            names.push(name.to_string());
        }
    };
    for line in top_level_lines(code) {
        let line = line.trim_end();
        let Some((first, rest)) = read_identifier(line) else {
            continue;
        };
        match first {
            "function" => {
                if let Some((name, after)) = read_identifier(rest.trim_start()) {
                    // `function Base.show(...)` extends another module: not a definition.
                    if !after.starts_with('.') {
                        add(name);
                    }
                }
            }
            "const" | "global" => {
                let rest = rest.trim_start();
                if let Some((name, after)) = read_identifier(rest) {
                    if assignment_follows(after) || annotated_assignment(after) {
                        add(name);
                    }
                }
            }
            "struct" => {
                if let Some((name, _)) = read_identifier(rest.trim_start()) {
                    add(name);
                }
            }
            "mutable" => {
                if let Some(after) = rest.trim_start().strip_prefix("struct") {
                    if let Some((name, _)) = read_identifier(after.trim_start()) {
                        add(name);
                    }
                }
            }
            "abstract" => {
                if let Some(after) = rest.trim_start().strip_prefix("type") {
                    if let Some((name, _)) = read_identifier(after.trim_start()) {
                        add(name);
                    }
                }
            }
            _ if is_statement_keyword(first) => {}
            _ => {
                if assignment_follows(rest) || annotated_assignment(rest) {
                    add(first);
                } else if rest.starts_with('(') {
                    // `f(args) = body`, `f(args)::T = body`, `f(args) where T = body`.
                    if let Some(end) = skip_parens(rest) {
                        let tail = rest[end..].trim_start();
                        let tail = tail
                            .strip_prefix("where")
                            .filter(|after| after.starts_with([' ', '{']))
                            .map_or(tail, |after| after);
                        if assignment_follows(tail) || annotated_assignment_or_where(tail) {
                            add(first);
                        }
                    }
                } else if rest.trim_start().starts_with(',') {
                    // `a, b = f(x)`: every name before the `=`.
                    if let Some(position) = tuple_assignment(line) {
                        for name in position {
                            add(&name);
                        }
                    }
                }
            }
        }
    }
    names
}

fn annotated_assignment_or_where(tail: &str) -> bool {
    if annotated_assignment(tail) {
        return true;
    }
    // After `where`: `{T<:Real} = ...` or `T = ...` — find a top-level `=`.
    let mut depth = 0i32;
    let chars: Vec<char> = tail.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        match c {
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth -= 1,
            '=' if depth == 0 => {
                let next = chars.get(i + 1);
                let prev = i.checked_sub(1).map(|p| chars[p]);
                return next != Some(&'=')
                    && next != Some(&'>')
                    && !matches!(prev, Some('=' | '<' | '>' | '!' | ':'));
            }
            _ => {}
        }
    }
    false
}

fn tuple_assignment(line: &str) -> Option<Vec<String>> {
    let mut rest = line;
    let mut names = Vec::new();
    loop {
        let (name, after) = read_identifier(rest.trim_start())?;
        names.push(name.to_string());
        let after = after.trim_start();
        if let Some(next) = after.strip_prefix(',') {
            rest = next;
        } else if assignment_follows(after) {
            return Some(names);
        } else {
            return None;
        }
    }
}

fn is_statement_keyword(word: &str) -> bool {
    matches!(
        word,
        "if" | "for"
            | "while"
            | "begin"
            | "let"
            | "try"
            | "end"
            | "else"
            | "elseif"
            | "catch"
            | "finally"
            | "return"
            | "break"
            | "continue"
            | "using"
            | "import"
            | "export"
            | "module"
            | "macro"
            | "quote"
            | "do"
            | "local"
            | "primitive"
    )
}

/// The `using` modules and the `import Package: name` entries that the code of a block states
/// in its own lines: the YAML fields of section 1 are
/// derived from these, never edited on their own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Declarations {
    pub using: Vec<String>,
    pub imports: Vec<JuliaImportDecl>,
}

/// Derives the `using` and `import` declarations of a block from its code.
///
/// Only a line that starts in column 0 counts, and only outside comments and strings (the same
/// visibility rule the definition scan uses). `using A, B` and `import P: f, g` are read; a bare
/// `import P`, `import P.f`, `using A: x` and an indented line are left to the code, which still
/// runs them. An imported name is taken only when the math grammar reads it back as itself, so
/// `import Base: show!` adds no field the code generator would refuse.
pub fn declarations(code: &str) -> Declarations {
    let mut out = Declarations::default();
    for line in top_level_lines(code) {
        if let Some(rest) = keyword_rest(&line, "using") {
            // `using A: x` brings names into scope, not a module: the field holds modules only.
            if rest.contains(':') {
                continue;
            }
            for name in rest.split(',').map(str::trim) {
                if is_module_path(name) && !out.using.iter().any(|known| known == name) {
                    out.using.push(name.to_owned());
                }
            }
        } else if let Some(rest) = keyword_rest(&line, "import") {
            let Some((package, names)) = rest.split_once(':') else {
                continue;
            };
            let package = package.trim();
            if !is_module_path(package) {
                continue;
            }
            for name in names.split(',').map(str::trim) {
                let name = name.trim_end_matches(';').trim();
                if !is_math_name(name) {
                    continue;
                }
                if out.imports.iter().any(|known| known.name == name) {
                    continue;
                }
                out.imports.push(JuliaImportDecl {
                    name: name.to_owned(),
                    package: package.to_owned(),
                    function: name.to_owned(),
                });
            }
        }
    }
    out
}

/// The rest of a line that starts with `keyword` followed by white space, if it does.
fn keyword_rest<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(keyword)?;
    match rest.chars().next() {
        Some(c) if c.is_whitespace() => Some(rest.trim()),
        _ => None,
    }
}

/// Whether `text` is a Julia module path (`A`, `Base.Threads`): one identifier per dot, no `!`.
pub fn is_module_path(text: &str) -> bool {
    !text.is_empty() && text.split('.').all(is_module_segment)
}

fn is_module_segment(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_')
}

impl JuliaBlock {
    /// Worksheet names that this region makes visible to math regions: imported function
    /// names, explicit `defines`, and the names detected in `code` (detected names that
    /// clash with a built-in or constant are not exported). Valid worksheet names only,
    /// without duplicates. Imports and explicit names that clash with a built-in are
    /// reported by code generation.
    pub fn exports(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut add = |name: &str| {
            if !out.iter().any(|known| known == name) {
                out.push(name.to_string());
            }
        };
        for import in &self.imports {
            if is_math_name(&import.name) {
                add(&import.name);
            }
        }
        for name in &self.defines {
            if is_math_name(name) {
                add(name);
            }
        }
        if let Some(code) = &self.code {
            for name in defined_names(code) {
                if is_math_name(&name) && !is_reserved_name(&name) {
                    add(&name);
                }
            }
        }
        out
    }

    /// Identifiers mentioned by the code that are valid worksheet names (candidates for
    /// worksheet variables the code reads).
    pub fn mentions(&self) -> Vec<String> {
        self.code
            .as_deref()
            .map(identifier_tokens)
            .unwrap_or_default()
            .into_iter()
            .filter(|token| is_math_name(token))
            .collect()
    }
}

/// The code a block stores: as typed, trailing empty
/// lines included, with the spaces of a line that holds nothing else dropped. `None` when the code
/// is only blank.
pub fn stored_code(code: &str) -> Option<String> {
    if code.trim().is_empty() {
        return None;
    }
    let lines: Vec<&str> = code
        .split('\n')
        .map(|line| if line.trim().is_empty() { "" } else { line })
        .collect();
    Some(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_top_level_definitions() {
        let code = "\
function area(r)
    pi * r^2
end
volume(r, h) = area(r) * h
scale = 3.0
const LIMIT = 10
x::Float64 = 2
a, b = (1, 2)
struct Point
    x::Float64
end
mutable struct Box end
abstract type Shape end
shifted(x)::Float64 = x + 1
g(x) where T = x
function Base.show(io, p) end
";
        assert_eq!(
            defined_names(code),
            [
                "area", "volume", "scale", "LIMIT", "x", "a", "b", "Point", "Box", "Shape",
                "shifted", "g"
            ]
        );
    }

    #[test]
    fn ignores_indented_commented_and_string_code() {
        let code = "\
# hidden = 1
#= block
comment_name = 2
=#
text = \"\"\"
inside = 3
\"\"\"
if cond
    inner = 4
end
for i = 1:3
    acc = i
end
x == 3
y != 4
f(x) == 5
";
        assert_eq!(defined_names(code), ["text"]);
    }

    #[test]
    fn collects_identifier_mentions() {
        let tokens = identifier_tokens(
            "y = x + sin(z) # w\ns = \"not_a_name $inter\"\nc = 'q'\nt = m'\nn = 1e5 + 0x1f + k!\n@time v",
        );
        for expected in [
            "y", "x", "sin", "z", "s", "inter", "c", "t", "m", "n", "k!", "v",
        ] {
            assert!(tokens.contains(&expected.to_string()), "{expected}");
        }
        for unexpected in ["w", "not_a_name", "q", "e5", "x1f", "time"] {
            assert!(!tokens.contains(&unexpected.to_string()), "{unexpected}");
        }
    }

    #[test]
    fn math_names_must_round_trip_through_the_grammar() {
        assert!(is_math_name("area"));
        assert!(is_math_name("my_func"));
        assert!(is_math_name("a_b_c"));
        assert!(!is_math_name("eq_x"));
        assert!(!is_math_name("_hidden"));
        assert!(!is_math_name("a.b"));
        assert!(!is_math_name("save!"));
        let name = math_name("a_b_c");
        assert_eq!(name.segments.len(), 2);
        assert_eq!(julia_text(&name).as_deref(), Some("a_b_c"));
    }

    #[test]
    fn derives_using_and_import_from_top_level_lines() {
        let code = "\
using LinearAlgebra, Statistics
import Statistics: mean, median
import Base: show!
using Base.Threads
scale = 2
function f(x)
    using Nope
    return x
end
# using Commented
s = \"\"\"
using InAString
\"\"\"
#= using InABlockComment =#
import Nope
import Nope.f
using Nope: thing
";
        let derived = declarations(code);
        assert_eq!(
            derived.using,
            ["LinearAlgebra", "Statistics", "Base.Threads"]
        );
        let imports: Vec<(&str, &str, &str)> = derived
            .imports
            .iter()
            .map(|import| {
                (
                    import.name.as_str(),
                    import.package.as_str(),
                    import.function.as_str(),
                )
            })
            .collect();
        // `show!` is not a worksheet name, so it stays in the code and adds no field.
        assert_eq!(
            imports,
            [
                ("mean", "Statistics", "mean"),
                ("median", "Statistics", "median"),
            ]
        );
    }

    #[test]
    fn derives_nothing_from_an_empty_or_plain_block() {
        assert_eq!(declarations(""), Declarations::default());
        let plain = declarations("x = 1\nusing\nusingNotAKeyword A\n");
        assert!(plain.using.is_empty() && plain.imports.is_empty());
    }

    #[test]
    fn module_paths_are_identifiers_separated_by_dots() {
        assert!(is_module_path("LinearAlgebra"));
        assert!(is_module_path("Base.Threads"));
        assert!(!is_module_path(""));
        assert!(!is_module_path("A."));
        assert!(!is_module_path("A..B"));
        assert!(!is_module_path("A B"));
        assert!(!is_module_path("f!"));
    }

    #[test]
    fn exports_skip_reserved_detected_names() {
        let block = JuliaBlock {
            code: Some("sin(x) = x\nscale = 2\n".into()),
            defines: vec!["hidden".into()],
            ..JuliaBlock::default()
        };
        assert_eq!(block.exports(), ["hidden", "scale"]);
    }
}
