//! `ml:` math of a `.mcdx` to the worksheet's linear math text.
//!
//! The emitter builds text with its binding level, so it adds parentheses only where the grammar
//! of `the specification` section 5 needs them. The caller validates the text with
//! `parse_statement`; nothing here is trusted to be valid.

use crate::ast::EllipsisForm;
use roxmltree::Node;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

thread_local! {
    /// Whether the `ml:` element being translated is a **unit context** — the unit override of an
    /// evaluation — where every plain name is a unit and the `@unit` label is left out.
    static UNIT_CONTEXT: Cell<bool> = const { Cell::new(false) };
    /// The names an `.xmcd` region writes as units although they carry no label:
    /// in that format a unit is a plain name the worksheet has not defined. Empty for an
    /// `.mcdx`, whose units are labelled.
    /// Whether an override whose names are not all units is left out, and
    /// how many were.
    static DROP_NON_UNIT_OVERRIDES: Cell<bool> = const { Cell::new(false) };
    static DROPPED_OVERRIDES: Cell<usize> = const { Cell::new(0) };
    static IMPLICIT_UNITS: RefCell<Rc<HashSet<String>>> = RefCell::new(Rc::new(HashSet::new()));
}

/// Runs `f` translating `.xmcd` math: a display override that is not a
/// unit is left out. Returns the result and how many overrides were left out.
pub fn with_xmcd_overrides<T>(f: impl FnOnce() -> T) -> (T, usize) {
    DROP_NON_UNIT_OVERRIDES.with(|c| c.set(true));
    DROPPED_OVERRIDES.with(|c| c.set(0));
    let out = f();
    DROP_NON_UNIT_OVERRIDES.with(|c| c.set(false));
    (out, DROPPED_OVERRIDES.with(Cell::get))
}

/// Runs `f` with `names` as the unlabelled names that are units; the set is
/// cleared afterwards whatever `f` returns.
pub fn with_implicit_units<T>(names: Rc<HashSet<String>>, f: impl FnOnce() -> T) -> T {
    let outer = IMPLICIT_UNITS.with(|set| std::mem::replace(&mut *set.borrow_mut(), names));
    let out = f();
    IMPLICIT_UNITS.with(|set| *set.borrow_mut() = outer);
    out
}

fn is_implicit_unit(name: &str) -> bool {
    IMPLICIT_UNITS.with(|set| set.borrow().contains(name))
}

/// Translates a function name: the head of a call is never an implicit unit, because the
/// reference application's `sec`, `min` and their like are functions as well as units.
fn call_head(head: Node) -> R {
    with_implicit_units(Rc::new(HashSet::new()), || expr(head))
}

/// Runs `f` in a unit context: the label is not written there, and the flag is restored
/// whatever `f` returns.
fn in_unit_context<T>(f: impl FnOnce() -> T) -> T {
    let outer = UNIT_CONTEXT.with(|flag| flag.replace(true));
    let out = f();
    UNIT_CONTEXT.with(|flag| flag.set(outer));
    out
}

fn unit_context() -> bool {
    UNIT_CONTEXT.with(Cell::get)
}

/// Binding levels of math-syntax section 5.
const L_RANGE: u8 = 2;
const L_OR: u8 = 3;
const L_AND: u8 = 4;
const L_NOT: u8 = 5;
const L_CMP: u8 = 6;
const L_ADD: u8 = 7;
const L_MUL: u8 = 8;
const L_BIG: u8 = 9;
const L_NEG: u8 = 10;
const L_DIV: u8 = 11;
const L_POW: u8 = 12;
const L_POSTFIX: u8 = 13;
const L_ATOM: u8 = 14;

/// Why a region cannot be translated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MathError {
    /// An `ml:` element (or element shape) outside the mapping of .
    Unsupported(String),
    /// A matrix whose element count is not `rows * cols`.
    MatrixSize,
}

impl MathError {
    /// The report code and message of the error.
    pub fn describe(&self) -> (&'static str, String) {
        match self {
            MathError::Unsupported(what) => {
                ("math-unsupported", format!("`{what}` is not imported"))
            }
            MathError::MatrixSize => (
                "matrix-size-mismatch",
                "a matrix has a different number of elements than rows times columns".into(),
            ),
        }
    }
}

type R = Result<Emit, MathError>;

fn unsupported<T>(what: impl Into<String>) -> Result<T, MathError> {
    Err(MathError::Unsupported(what.into()))
}

#[derive(Debug, Clone)]
struct Emit {
    text: String,
    level: u8,
    /// A big operator: its body absorbs what follows (math-syntax section 5).
    big: bool,
    /// A visible `ml:parens`: doubled in box positions (D5).
    visible_parens: bool,
    /// The text starts with the unary minus.
    negative: bool,
}

impl Emit {
    fn new(text: impl Into<String>, level: u8) -> Emit {
        Emit {
            text: text.into(),
            level,
            big: false,
            visible_parens: false,
            negative: false,
        }
    }
}

fn parenthesize(text: &str) -> String {
    format!("({text})")
}

/// The text of `e` as an operand of at least `min` (parentheses when it binds looser).
/// `allow_big` lets a big operator stand unwrapped.
fn fit(e: &Emit, min: u8, allow_big: bool) -> String {
    if (e.big && !allow_big) || e.level < min {
        parenthesize(&e.text)
    } else {
        e.text.clone()
    }
}

/// An operand in a box position (fraction parts, radicand): one pair of grouping parentheses is
/// free, a visible pair is written doubled (D5).
fn boxed(e: &Emit, min: u8) -> String {
    if e.visible_parens || e.big || e.level < min {
        parenthesize(&e.text)
    } else {
        e.text.clone()
    }
}

fn kids<'a, 'b>(node: Node<'a, 'b>) -> Vec<Node<'a, 'b>> {
    node.children().filter(|c| c.is_element()).collect()
}

fn name_of<'a>(node: Node<'a, '_>) -> &'a str {
    node.tag_name().name()
}

// ---- names -------------------------------------------------------------------------------

fn is_letter(c: char) -> bool {
    c.is_alphabetic() && !c.is_numeric() && c != '\u{1D40}' && c != '\u{2146}'
}

/// `plain-part` of math-syntax 3.2: a letter or `∞`, then letters, digits, `∞`, apostrophes and a
/// `.` that is followed by one of them.
fn plain_base(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let Some(first) = chars.first() else {
        return false;
    };
    if !(is_letter(*first) || *first == '∞') {
        return false;
    }
    chars.iter().enumerate().all(|(i, c)| {
        is_letter(*c)
            || c.is_ascii_digit()
            || *c == '∞'
            || (*c == '\'' && i > 0)
            || (*c == '.'
                && i > 0
                && chars
                    .get(i + 1)
                    .is_some_and(|n| is_letter(*n) || n.is_ascii_digit() || *n == '∞'))
    })
}

/// `plain-sub`: like a base, but it may start with a digit and may contain `_`.
fn plain_sub(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    let Some(first) = chars.first() else {
        return false;
    };
    if !(is_letter(*first) || first.is_ascii_digit() || *first == '∞') {
        return false;
    }
    chars.iter().enumerate().all(|(i, c)| {
        is_letter(*c)
            || c.is_ascii_digit()
            || *c == '∞'
            || *c == '_'
            || (*c == '\'' && i > 0)
            || (*c == '.'
                && i > 0
                && chars
                    .get(i + 1)
                    .is_some_and(|n| is_letter(*n) || n.is_ascii_digit() || *n == '∞'))
    })
}

fn quote_part(s: &str) -> String {
    let mut out = String::from("`");
    for c in s.chars() {
        if c == '`' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('`');
    out
}

/// The text of an `ml:id`, a literal subscript run kept as the name's subscript.
fn id_text(node: Node) -> String {
    const SUBSCRIPT: &str = "Subscript";
    let mut base = String::new();
    let mut sub = String::new();
    let mut subscripts = 0;
    for d in node.descendants() {
        if d.is_text() {
            let text = d.text().unwrap_or("");
            let in_sub = d
                .ancestors()
                .take_while(|a| *a != node)
                .any(|a| a.is_element() && name_of(a) == SUBSCRIPT);
            if in_sub {
                sub.push_str(text);
            } else {
                base.push_str(text);
            }
        } else if d.is_element() && name_of(d) == SUBSCRIPT {
            subscripts += 1;
        }
    }
    let base = base.trim().to_owned();
    // An `.xmcd` keeps the literal subscript in an attribute.
    if let Some(attribute) = node.attribute("subscript").filter(|s| !s.is_empty()) {
        sub.push_str(attribute);
        subscripts += 1;
    }
    let mut out = if subscripts == 0 {
        if plain_base(&base) {
            base
        } else {
            quote_part(&base)
        }
    } else {
        let b = if plain_base(&base) {
            base
        } else {
            quote_part(&base)
        };
        let s = if plain_sub(&sub) {
            sub
        } else {
            quote_part(&sub)
        };
        format!("{b}_{s}")
    };
    let label = node.attribute("labels");
    let contextual = node.attribute("label-is-contextual") == Some("true");
    if label == Some("UNIT") {
        // the label is what makes a unit in a value position, so every UNIT label is written,
        // contextual or not; a unit context needs none, because a plain name is a unit there.
        if !unit_context() {
            out.push_str("@unit");
        }
    } else if label == Some("VARIABLE")
        && !contextual
        && subscripts == 0
        && crate::units::is_unit(&out)
    {
        // the reference application's explicit VARIABLE label on a name that is also a unit (`A`, `V`, `m`) keeps
        // it a variable; without the label it would read and draw as the unit.
        out.push_str("@var");
    } else if label.is_none() && subscripts == 0 && !unit_context() && is_implicit_unit(&out) {
        // an unlabelled `.xmcd` name that is a unit of that worksheet.
        out.push_str("@unit");
    }
    out
}

fn string_literal(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\u{d}"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ---- expressions -------------------------------------------------------------------------

fn number(text: &str, imag: Option<&str>) -> Emit {
    let text = text.trim();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let body = match imag {
        Some(symbol) => format!("{digits}{symbol}"),
        None => digits.to_owned(),
    };
    if negative {
        let mut e = Emit::new(format!("-{body}"), L_NEG);
        e.negative = true;
        e
    } else {
        Emit::new(body, L_ATOM)
    }
}

/// Translates one expression element.
fn expr(node: Node) -> R {
    match name_of(node) {
        "real" => {
            let text = node.text().unwrap_or("");
            // An `.xmcd` keeps the dots a user typed as an ellipsis (`a + ... + z`) as a number with
            // no digit; it is the name it draws, display only.
            if !text.trim().is_empty() && !text.chars().any(|c| c.is_ascii_digit()) {
                return Ok(Emit::new(quote_part(text.trim()), L_ATOM));
            }
            // An `.xmcd` keeps a binary, octal or hexadecimal literal as its digits and a `base`
            //: the value is written in decimal.
            if let Some(base) = node.attribute("base").and_then(|b| b.parse::<u32>().ok()) {
                if base != 10 {
                    let value = u64::from_str_radix(text.trim(), base)
                        .map_err(|_| MathError::Unsupported(format!("real (base {base})")))?;
                    return Ok(number(&value.to_string(), None));
                }
            }
            Ok(number(text, None))
        }
        "imag" => {
            let symbol = match node.attribute("symbol") {
                Some("j") => "j",
                _ => "i",
            };
            Ok(number(node.text().unwrap_or(""), Some(symbol)))
        }
        "str" => Ok(Emit::new(string_literal(node.text().unwrap_or("")), L_ATOM)),
        "placeholder" => Ok(Emit::new("□", L_ATOM)),
        "id" => {
            let text = id_text(node);
            if text.is_empty() || text == "``" {
                return unsupported("id (empty name)");
            }
            Ok(Emit::new(text, L_ATOM))
        }
        "parens" => {
            let inner = single(node, "parens")?;
            // The pair of a parenthesised local definition belongs to its own form,
            // so an `ml:parens` around it adds none.
            if name_of(inner) == "localDefine" {
                return expr(inner);
            }
            let mut e = Emit::new(parenthesize(&expr(inner)?.text), L_ATOM);
            e.visible_parens = true;
            Ok(e)
        }
        "matrix" => matrix(node),
        "range" => range(node),
        // An `.xmcd` wraps a pasted expression in the record of where it came from.
        "provenance" => expr(provenance_payload(node)?),
        "apply" => apply(node),
        "program" => Ok(Emit::new(program_text(node)?, L_ATOM)),
        // A statement in an expression position is a program of that one statement.
        "if" | "ifThen" | "for" | "while" | "tryCatch" => {
            Ok(Emit::new(format!("program {{ {} }}", stmt(node)?), L_ATOM))
        }
        // A local definition in an operand position is the parenthesised operand of
        // the specification : its value is the value of its right side and no name
        // is bound, so nothing of the target survives the text beyond the definition itself.
        "localDefine" => {
            // A function head is a target of a definition only, and an
            // operand defines nothing, so it has no form here.
            if kids(node)
                .first()
                .is_some_and(|t| name_of(*t) == "function")
            {
                return unsupported("localDefine (function target outside a program)");
            }
            Ok(Emit::new(parenthesize(&local_define(node)?), L_ATOM))
        }
        "return" | "break" | "continue" => {
            unsupported(format!("{} (outside a program)", name_of(node)))
        }
        other => unsupported(other),
    }
}

/// `a..b` and the step form `a, b..c`.
fn range(node: Node) -> R {
    let k = kids(node);
    if k.len() != 2 {
        return unsupported("range (shape)");
    }
    // a comparison as a bound is its Boolean value, 0 or 1 (the reference application: `(j = 1)..3` with
    // j = 1 is 1..3, a test worksheet); `fit` puts it in parentheses.
    let bound = |n: Node| expr(n).map(|e| fit(&e, L_ADD, true));
    if name_of(k[0]) == "sequence" {
        let first = kids(k[0]);
        if first.len() != 2 {
            return unsupported("range (step form)");
        }
        return Ok(Emit::new(
            format!(
                "{}, {}..{}",
                bound(first[0])?,
                bound(first[1])?,
                bound(k[1])?
            ),
            L_RANGE,
        ));
    }
    Ok(Emit::new(
        format!("{}..{}", bound(k[0])?, bound(k[1])?),
        L_RANGE,
    ))
}

fn single<'a, 'b>(node: Node<'a, 'b>, what: &str) -> Result<Node<'a, 'b>, MathError> {
    let k = kids(node);
    if k.len() == 1 {
        Ok(k[0])
    } else {
        unsupported(format!("{what} (arity)"))
    }
}

fn matrix(node: Node) -> R {
    let rows: usize = node
        .attribute("rows")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let cols: usize = node
        .attribute("cols")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let cells = kids(node);
    if cells.len() != rows * cols {
        return Err(MathError::MatrixSize);
    }
    if rows == 0 || cols == 0 {
        return Ok(Emit::new("[]", L_ATOM));
    }
    let texts: Vec<String> = cells
        .iter()
        .map(|c| {
            if is_ellipsis_cell(*c) {
                Ok(EllipsisForm::Horizontal.glyph().to_string())
            } else {
                expr(*c).map(|e| e.text)
            }
        })
        .collect::<Result<_, _>>()?;
    // Column-major storage: element (i, j) is child j * rows + i.
    let lines: Vec<String> = (0..rows)
        .map(|i| {
            (0..cols)
                .map(|j| texts[j * rows + i].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .collect();
    Ok(Emit::new(format!("[{}]", lines.join("; ")), L_ATOM))
}

/// A display-only ellipsis cell of a matrix: a cell that is an `ml:range` whose two bounds
/// carry no value, so a plain translation would read `..` and
/// the region would not parse. The direction is not in this shape, so it is `⋯`.
fn is_ellipsis_cell(cell: Node) -> bool {
    if name_of(cell) != "range" {
        return false;
    }
    let bounds = kids(cell);
    bounds.len() == 2 && bounds.iter().all(|b| carries_no_value(*b))
}

/// Whether a bound of an `ml:range` holds nothing but a dot to show: a placeholder, an empty
/// literal, or the name `.` — what the corpus actually stores.
fn carries_no_value(node: Node) -> bool {
    match name_of(node) {
        "placeholder" => true,
        "real" | "imag" => node.text().unwrap_or("").trim().is_empty(),
        "id" => node.text().unwrap_or("").trim() == ".",
        _ => false,
    }
}

/// Operands of an `ml:apply`: a single `ml:sequence` child stands for its elements.
fn operands<'a, 'b>(rest: &[Node<'a, 'b>]) -> Vec<Node<'a, 'b>> {
    if rest.len() == 1 && name_of(rest[0]) == "sequence" {
        kids(rest[0])
    } else {
        rest.to_vec()
    }
}

/// The glue of an operator with the reference application's equation break: the operator, a
/// line break and the continuation indented 4 spaces.
fn split_glue(glue: &str) -> String {
    format!("{}\n    ", glue.trim_end())
}

/// Whether the operator element carries the reference application's equation break.
fn is_split(head: Node) -> bool {
    head.attribute("split") == Some("true")
}

fn binary_chain(
    args: &[Node],
    glue: &str,
    level: u8,
    left_min: u8,
    right_min: u8,
    allow_big: bool,
) -> R {
    if args.len() < 2 {
        return unsupported("operator (arity)");
    }
    let mut acc = expr(args[0])?;
    for arg in &args[1..] {
        let right = expr(*arg)?;
        let text = format!(
            "{}{glue}{}",
            fit(&acc, left_min, allow_big),
            fit(&right, right_min, allow_big)
        );
        acc = Emit::new(text, level);
    }
    Ok(acc)
}

fn apply(node: Node) -> R {
    let k = kids(node);
    let Some(head) = k.first().copied() else {
        return unsupported("apply (empty)");
    };
    let rest = &k[1..];
    let head = if name_of(head) == "provenance" {
        provenance_payload(head)?
    } else {
        head
    };
    let op = name_of(head);
    // The solving and root-finding keywords of an `.xmcd` are elements of their own that carry the
    // method options; they are the built-in calls of the same name.
    if SOLVER_HEADS.contains(&op) {
        let args: Vec<String> = operands(rest)
            .iter()
            .map(|a| argument(*a))
            .collect::<Result<_, _>>()?;
        return Ok(Emit::new(format!("{op}({})", args.join(", ")), L_POSTFIX));
    }
    // A function call: the head is a name.
    if op == "id" {
        let callee = call_head(head)?;
        let args: Vec<String> = operands(rest)
            .iter()
            .map(|a| argument(*a))
            .collect::<Result<_, _>>()?;
        // An imported `svd(A)` gives `[s; U; Vᴴ]` and Equavela's Julia's `[U; S; V]`: the call
        // becomes the algorithm that computes it once and returns it in the imported order.
        if callee.text == "svd" && args.len() == 1 {
            return Ok(Emit::new(
                format!("program {{ [U; S; V] ← svd({}); [S; U; Vᵀ] }}", args[0]),
                L_ATOM,
            ));
        }
        return Ok(Emit::new(
            format!("{}({})", callee.text, args.join(", ")),
            L_POSTFIX,
        ));
    }
    // A call of an element of an array: the
    // head is not a name but the indexer's own `ml:apply`, so the element is written with the
    // `indexer` rule below and called with these arguments (`F[i](x)`, `F[i, j](x)`).
    if op == "apply" && kids(head).first().is_some_and(|h| name_of(*h) == "indexer") {
        let callee = expr(head)?;
        let args: Vec<String> = operands(rest)
            .iter()
            .map(|a| argument(*a))
            .collect::<Result<_, _>>()?;
        return Ok(Emit::new(
            format!("{}({})", fit(&callee, L_POSTFIX, false), args.join(", ")),
            L_POSTFIX,
        ));
    }
    let args = operands(rest);
    match op {
        "plus" => {
            let glue = if is_split(head) {
                split_glue(" + ")
            } else {
                " + ".into()
            };
            binary_chain(&args, &glue, L_ADD, L_ADD, L_MUL, true)
        }
        "minus" => {
            if args.len() == 1 {
                neg(args[0])
            } else {
                let glue = if is_split(head) {
                    split_glue(" - ")
                } else {
                    " - ".into()
                };
                binary_chain(&args, &glue, L_ADD, L_ADD, L_MUL, true)
            }
        }
        "neg" => {
            if args.len() != 1 {
                return unsupported("neg (arity)");
            }
            neg(args[0])
        }
        "mult" => {
            let glue = if is_split(head) {
                split_glue("·")
            } else {
                "·".into()
            };
            binary_chain(&args, &glue, L_MUL, L_MUL, L_MUL + 1, false)
        }
        "scale" => {
            if args.len() != 2 {
                return unsupported("scale (arity)");
            }
            let a = expr(args[0])?;
            let b = expr(args[1])?;
            let right = if b.negative || b.level < L_MUL + 1 || b.big {
                parenthesize(&b.text)
            } else {
                b.text.clone()
            };
            Ok(Emit::new(
                format!("{} {right}", fit(&a, L_MUL, false)),
                L_MUL,
            ))
        }
        "crossProduct" => binary_chain(&args, " × ", L_MUL, L_MUL, L_MUL + 1, false),
        "div" => {
            if args.len() != 2 {
                return unsupported("div (arity)");
            }
            let a = expr(args[0])?;
            let b = expr(args[1])?;
            if head.attribute("inline") == Some("true") {
                let glue = if is_split(head) {
                    split_glue("÷")
                } else {
                    "÷".into()
                };
                let text = format!(
                    "{}{glue}{}",
                    fit(&a, L_MUL, false),
                    fit(&b, L_MUL + 1, false)
                );
                return Ok(Emit::new(text, L_MUL));
            }
            let text = format!("{}/{}", boxed(&a, L_DIV), boxed(&b, L_POW));
            Ok(Emit::new(text, L_DIV))
        }
        "pow" => {
            if args.len() != 2 {
                return unsupported("pow (arity)");
            }
            let base = expr(args[0])?;
            let exponent = expr(args[1])?;
            let exp_text = if exponent.negative && !exponent.text.contains(['+', ' ', '·', '/']) {
                // `x^-1`, `10^-3`: the exponent may start with a minus (math-syntax section 5).
                exponent.text.clone()
            } else {
                boxed(&exponent, L_POW)
            };
            Ok(Emit::new(
                format!("{}^{exp_text}", fit(&base, L_POSTFIX, false)),
                L_POW,
            ))
        }
        "equal" => binary_chain(&args, " == ", L_CMP, L_CMP, L_ADD, true),
        "notEqual" => binary_chain(&args, " ≠ ", L_CMP, L_CMP, L_ADD, true),
        "lessThan" => binary_chain(&args, " < ", L_CMP, L_CMP, L_ADD, true),
        "greaterThan" => binary_chain(&args, " > ", L_CMP, L_CMP, L_ADD, true),
        "lessOrEqual" => binary_chain(&args, " ≤ ", L_CMP, L_CMP, L_ADD, true),
        "greaterOrEqual" => binary_chain(&args, " ≥ ", L_CMP, L_CMP, L_ADD, true),
        // Element of: a comparison-level operator.
        "elementOf" => binary_chain(&args, " ∈ ", L_CMP, L_CMP, L_ADD, true),
        "and" => binary_chain(&args, " ∧ ", L_AND, L_AND, L_NOT, true),
        "or" => binary_chain(&args, " ∨ ", L_OR, L_OR, L_AND, true),
        "xor" => binary_chain(&args, " ⊕ ", L_OR, L_OR, L_AND, true),
        "not" => {
            if args.len() != 1 {
                return unsupported("not (arity)");
            }
            let a = expr(args[0])?;
            Ok(Emit::new(format!("¬{}", fit(&a, L_NOT, false)), L_NOT))
        }
        "transpose" | "factorial" | "percent" => {
            // `percent` is the reference application's postfix percent `3.4%`:
            // the operand, then the sign with no space.
            if args.len() != 1 {
                return unsupported(format!("{op} (arity)"));
            }
            let a = expr(args[0])?;
            let mark = match op {
                "transpose" => "ᵀ",
                "factorial" => "!",
                _ => "%",
            };
            Ok(Emit::new(
                format!("{}{mark}", fit(&a, L_POSTFIX, false)),
                L_POSTFIX,
            ))
        }
        "absval" => {
            if args.len() != 1 {
                return unsupported("absval (arity)");
            }
            let a = expr(args[0])?;
            if a.text.contains('|') {
                Ok(Emit::new(format!("\\abs({})", a.text), L_ATOM))
            } else {
                Ok(Emit::new(format!("|{}|", a.text), L_ATOM))
            }
        }
        "determinant" | "conjugate" | "vectorize" => {
            if args.len() != 1 {
                return unsupported(format!("{op} (arity)"));
            }
            let word = match op {
                "determinant" => "\\det",
                "conjugate" => "\\conj",
                _ => "\\vec",
            };
            let a = expr(args[0])?;
            Ok(Emit::new(format!("{word}({})", a.text), L_ATOM))
        }
        // The square root and the vector sum of an `.xmcd`: the forms the `.mcdx` writes as an
        // `nthRoot` with an empty index and a `summation` with a placeholder variable.
        "sqrt" => {
            if args.len() != 1 {
                return unsupported("sqrt (arity)");
            }
            let radicand = expr(args[0])?;
            let inner = if radicand.visible_parens {
                parenthesize(&radicand.text)
            } else {
                radicand.text.clone()
            };
            Ok(Emit::new(format!("√({inner})"), L_ATOM))
        }
        "vectorSum" => {
            if args.len() != 1 {
                return unsupported("vectorSum (arity)");
            }
            Ok(Emit::new(
                format!("vsum({})", expr(args[0])?.text),
                L_POSTFIX,
            ))
        }
        "nthRoot" => {
            if args.len() != 2 {
                return unsupported("nthRoot (arity)");
            }
            let radicand = expr(args[1])?;
            let inner = if radicand.visible_parens {
                parenthesize(&radicand.text)
            } else {
                radicand.text.clone()
            };
            if name_of(args[0]) == "placeholder" {
                Ok(Emit::new(format!("√({inner})"), L_ATOM))
            } else {
                let index = expr(args[0])?;
                Ok(Emit::new(format!("√[{}]({inner})", index.text), L_ATOM))
            }
        }
        "indexer" => {
            if args.len() < 2 {
                return unsupported("indexer (arity)");
            }
            let base = expr(args[0])?;
            let mut indices = Vec::new();
            for a in &args[1..] {
                // `M[i, j]` is stored as the indexer with one `ml:sequence` of the indices.
                let items = if name_of(*a) == "sequence" {
                    kids(*a)
                } else {
                    vec![*a]
                };
                for item in items {
                    indices.push(expr(item)?.text);
                }
            }
            Ok(Emit::new(
                format!("{}[{}]", fit(&base, L_POSTFIX, false), indices.join(", ")),
                L_POSTFIX,
            ))
        }
        "matrow" => {
            // The row operator: `M⟪i⟫`.
            if args.len() != 2 {
                return unsupported("matrow (arity)");
            }
            let base = expr(args[0])?;
            let row = expr(args[1])?;
            Ok(Emit::new(
                format!("{}⟪{}⟫", fit(&base, L_POSTFIX, false), row.text),
                L_POSTFIX,
            ))
        }
        "convolution" => {
            // the reference application's convolution operator is the built-in `convolve` with its defaults:
            // the full 1-D convolution of two vectors.
            if args.len() != 2 {
                return unsupported("convolution (arity)");
            }
            let left = argument(args[0])?;
            let right = argument(args[1])?;
            Ok(Emit::new(format!("convolve({left}, {right})"), L_POSTFIX))
        }
        "matcol" => {
            if args.len() != 2 {
                return unsupported("matcol (arity)");
            }
            let base = expr(args[0])?;
            let column = expr(args[1])?;
            Ok(Emit::new(
                format!("{}⟨{}⟩", fit(&base, L_POSTFIX, false), column.text),
                L_POSTFIX,
            ))
        }
        "summation" | "product" | "integral" | "derivative" | "partDerivative" => {
            calculus(op, rest)
        }
        "limit" => limit(rest),
        other => unsupported(other),
    }
}

/// One argument of a call: an expression, or an inline argument definition `target ← value`.
fn argument(node: Node) -> Result<String, MathError> {
    if name_of(node) == "localDefine" {
        return local_define(node);
    }
    expr(node).map(|e| e.text)
}

fn neg(arg: Node) -> R {
    let a = expr(arg)?;
    let text = if a.negative || a.level < L_NEG || a.big {
        parenthesize(&a.text)
    } else {
        a.text.clone()
    };
    let mut e = Emit::new(format!("-{text}"), L_NEG);
    e.negative = true;
    Ok(e)
}

/// `∑ ∏ ∫ ⅆ ∂`: children are an `ml:lambda` (`boundVars`, body) and the bounds or degree.
fn calculus(op: &str, rest: &[Node]) -> R {
    let Some(lambda) = rest.iter().find(|n| name_of(**n) == "lambda") else {
        return unsupported(format!("{op} (no lambda)"));
    };
    let lk = kids(*lambda);
    if lk.len() != 2 || name_of(lk[0]) != "boundVars" {
        return unsupported(format!("{op} (lambda shape)"));
    }
    let vars = kids(lk[0]);
    if vars.len() == 1 && name_of(vars[0]) == "placeholder" {
        // `∑ v`, the reference application's vector sum: the sum of the elements of the array, which we write as the
        // built-in function `vsum(v)`. The other
        // operators of this group have no such form, and a real bound beside a placeholder
        // variable is not a vector sum either: those stay reported.
        if op != "summation" {
            return unsupported(format!("{op} (vector sum)"));
        }
        if bound_of(rest, "lowerBound")?.is_some() || bound_of(rest, "upperBound")?.is_some() {
            return unsupported("summation (vector sum with bounds)");
        }
        let body = expr(lk[1])?;
        return Ok(Emit::new(format!("vsum({})", body.text), L_POSTFIX));
    }
    // A sum or product whose single bound variable is an expression (`j!`, a decoration the
    // user wrote in the index slot) is imported as a free slot, as written.
    let free_slot =
        matches!(op, "summation" | "product") && vars.len() == 1 && name_of(vars[0]) != "id";
    if !free_slot && (vars.len() != 1 || name_of(vars[0]) != "id") {
        return unsupported(format!("{op} (bound variables)"));
    }
    let var = if free_slot {
        fit(&expr(vars[0])?, L_CMP, true)
    } else {
        id_text(vars[0])
    };
    let body = expr(lk[1])?;
    let body_text = fit(&body, L_MUL, true);
    let bound = |name: &str| bound_of(rest, name);
    let glyph = match op {
        "summation" => "∑",
        "product" => "∏",
        "integral" => "∫",
        // the reference application's partial derivative is our `∂[x] e`.
        "partDerivative" => "∂",
        _ => "ⅆ",
    };
    let binder = if matches!(op, "derivative" | "partDerivative") {
        let degree = match rest.iter().find(|n| name_of(**n) == "degree") {
            None => None,
            Some(n) => {
                let d = single(*n, "degree")?;
                if name_of(d) == "placeholder" {
                    None
                } else {
                    Some(expr(d)?)
                }
            }
        };
        match degree {
            None => var,
            Some(d) => format!("{var}^{}", boxed(&d, L_POW)),
        }
    } else {
        match (bound("lowerBound")?, bound("upperBound")?) {
            (lo, hi) if free_slot && (lo.is_some() || hi.is_some()) => {
                let text = |bound: Option<Emit>| {
                    bound.map_or_else(|| "□".to_owned(), |e| fit(&e, L_ADD, true))
                };
                format!("{var} = {}..{}", text(lo), text(hi))
            }
            (Some(lo), Some(hi)) => format!(
                "{var} ∈ {}..{}",
                fit(&lo, L_ADD, true),
                fit(&hi, L_ADD, true)
            ),
            // No bounds: the sum or product over a range variable, the indefinite integral.
            (None, None) => var,
            _ => return unsupported(format!("{op} (one-sided bounds)")),
        }
    };
    let mut e = Emit::new(format!("{glyph}[{binder}] {body_text}"), L_BIG);
    e.big = true;
    Ok(e)
}

/// A bound element's expression, `None` when it is absent or a placeholder. An `.xmcd` holds both
/// bounds in one `bounds` element, lower then upper.
fn bound_of(rest: &[Node], name: &str) -> Result<Option<Emit>, MathError> {
    if let Some(bounds) = rest.iter().find(|n| name_of(**n) == "bounds") {
        let parts = kids(*bounds);
        let index = usize::from(name == "upperBound");
        return match parts.get(index) {
            Some(inner) if name_of(*inner) != "placeholder" => expr(*inner).map(Some),
            _ => Ok(None),
        };
    }
    match rest.iter().find(|n| name_of(**n) == name) {
        None => Ok(None),
        Some(n) => {
            let inner = single(*n, name)?;
            if name_of(inner) == "placeholder" {
                Ok(None)
            } else {
                expr(inner).map(Some)
            }
        }
    }
}

/// `limit`: children are an `ml:lambda` (one bound name, body) and the target.
fn limit(rest: &[Node]) -> R {
    if rest.len() != 2 || name_of(rest[0]) != "lambda" {
        return unsupported("limit (shape)");
    }
    let lk = kids(rest[0]);
    if lk.len() != 2 || name_of(lk[0]) != "boundVars" {
        return unsupported("limit (lambda shape)");
    }
    let vars = kids(lk[0]);
    if vars.len() != 1 || name_of(vars[0]) != "id" {
        return unsupported("limit (bound variables)");
    }
    let var = id_text(vars[0]);
    let body = expr(lk[1])?;
    let target = expr(rest[1])?;
    let mut e = Emit::new(
        format!(
            "\\lim[{var}, {}] {}",
            fit(&target, L_ADD, true),
            fit(&body, L_MUL, true)
        ),
        L_BIG,
    );
    e.big = true;
    Ok(e)
}

// ---- programs ----------------------------------------------------------------------------

/// The statements of a body element: a `program`'s children, or the element itself.
fn body_statements<'a, 'b>(node: Node<'a, 'b>) -> Vec<Node<'a, 'b>> {
    if name_of(node) == "program" {
        kids(node)
    } else {
        vec![node]
    }
}

/// The statements of a `then` or `else` wrapper: its single `program`, or its children.
fn wrapper_statements<'a, 'b>(wrapper: Node<'a, 'b>) -> Vec<Node<'a, 'b>> {
    let k = kids(wrapper);
    if k.len() == 1 {
        body_statements(k[0])
    } else {
        k
    }
}

fn statements_text(statements: &[Node]) -> Result<String, MathError> {
    if statements.is_empty() {
        return Ok("□".into());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut index = 0;
    while index < statements.len() {
        // a run of `.xmcd` `ifThen` statements closed by an `otherwise` is one chain
        // `if … else if … else …`; an `otherwise` with no `ifThen` before it has no meaning.
        if name_of(statements[index]) == "ifThen" {
            let start = index;
            while index < statements.len() && name_of(statements[index]) == "ifThen" {
                index += 1;
            }
            let closed = index < statements.len() && name_of(statements[index]) == "otherwise";
            if !closed {
                for s in &statements[start..index] {
                    parts.push(stmt(*s)?);
                }
                continue;
            }
            let mut chain = Vec::new();
            for s in &statements[start..index] {
                chain.push(if_then_text(*s)?);
            }
            let otherwise = statements_text(&wrapper_statements(statements[index]))?;
            parts.push(format!("{} else {{ {otherwise} }}", chain.join(" else ")));
            index += 1;
            continue;
        }
        if name_of(statements[index]) == "otherwise" {
            return unsupported("otherwise (without an if)");
        }
        parts.push(stmt(statements[index])?);
        index += 1;
    }
    Ok(parts.join("; "))
}

/// `if c { … }` of an `.xmcd` `ifThen`: the test, then the body.
fn if_then_text(node: Node) -> Result<String, MathError> {
    let k = kids(node);
    if k.len() != 2 {
        return unsupported("ifThen (shape)");
    }
    Ok(format!(
        "if {} {{ {} }}",
        expr(k[0])?.text,
        statements_text(&body_statements(k[1]))?
    ))
}

/// The solving keywords an `.xmcd` stores as elements of their own.
const SOLVER_HEADS: [&str; 5] = ["Find", "Minimize", "Maximize", "Minerr", "polyroots"];

/// The expression an `.xmcd` `provenance` element records: its last child that is not
/// part of the record itself.
pub fn provenance_payload<'a, 'b>(node: Node<'a, 'b>) -> Result<Node<'a, 'b>, MathError> {
    const RECORD: [&str; 5] = [
        "originRef",
        "parentRef",
        "comment",
        "originComment",
        "contentHash",
    ];
    kids(node)
        .into_iter()
        .rfind(|k| !RECORD.contains(&name_of(*k)))
        .ok_or_else(|| MathError::Unsupported("provenance (empty)".into()))
}

/// `program { s; s }` of an `ml:program`.
fn program_text(node: Node) -> Result<String, MathError> {
    Ok(format!("program {{ {} }}", statements_text(&kids(node))?))
}

fn local_define(node: Node) -> Result<String, MathError> {
    let k = kids(node);
    if k.len() != 2 {
        return unsupported("localDefine (arity)");
    }
    Ok(format!("{} ← {}", target_text(k[0])?, expr(k[1])?.text))
}

/// `if c { … } else if d { … } else { … }`. the reference application writes the chain as one `ml:if` holding a `test`, a `then`, any
/// number of `ml:elseif` (each a `test` and a `then`, in order) and an optional `else`; an `else` holding a single
/// `if` continues the chain as well.
fn if_text(node: Node) -> Result<String, MathError> {
    let mut out = String::new();
    let mut current = node;
    let mut keyword = "if";
    loop {
        let k = kids(current);
        let part = |name: &str| k.iter().find(|n| name_of(**n) == name).copied();
        let (Some(test), Some(then)) = (part("test"), part("then")) else {
            return unsupported("if (shape)");
        };
        let cond = expr(single(test, "test")?)?;
        out.push_str(&format!(
            "{keyword} {} {{ {} }}",
            cond.text,
            statements_text(&wrapper_statements(then))?
        ));
        // The `elseif` branches, in the order the reference application stores them (a missing one would silently drop a branch of the
        // algorithm).
        for branch in k.iter().filter(|n| name_of(**n) == "elseif") {
            let parts = kids(*branch);
            let find = |name: &str| parts.iter().find(|n| name_of(**n) == name).copied();
            let (Some(test), Some(then)) = (find("test"), find("then")) else {
                return unsupported("elseif (shape)");
            };
            out.push_str(&format!(
                " else if {} {{ {} }}",
                expr(single(test, "test")?)?.text,
                statements_text(&wrapper_statements(then))?
            ));
        }
        let Some(otherwise) = part("else") else {
            return Ok(out);
        };
        let statements = wrapper_statements(otherwise);
        if statements.len() == 1 && name_of(statements[0]) == "if" {
            out.push_str(" else ");
            current = statements[0];
            keyword = "if";
            continue;
        }
        out.push_str(&format!(" else {{ {} }}", statements_text(&statements)?));
        return Ok(out);
    }
}

/// One statement of a program, in the inline form.
fn stmt(node: Node) -> Result<String, MathError> {
    let k = kids(node);
    match name_of(node) {
        "localDefine" => local_define(node),
        "if" => if_text(node),
        "ifThen" => if_then_text(node),
        "otherwise" => unsupported("otherwise (without an if)"),
        "for" => {
            if k.len() != 3 || name_of(k[0]) != "id" {
                return unsupported("for (shape)");
            }
            Ok(format!(
                "for {} ∈ {} {{ {} }}",
                id_text(k[0]),
                expr(k[1])?.text,
                statements_text(&body_statements(k[2]))?
            ))
        }
        "while" => {
            if k.len() != 2 {
                return unsupported("while (shape)");
            }
            Ok(format!(
                "while {} {{ {} }}",
                expr(k[0])?.text,
                statements_text(&body_statements(k[1]))?
            ))
        }
        "tryCatch" => {
            if k.len() != 2 {
                return unsupported("tryCatch (shape)");
            }
            Ok(format!(
                "try {{ {} }} on error {{ {} }}",
                statements_text(&body_statements(k[0]))?,
                statements_text(&body_statements(k[1]))?
            ))
        }
        "return" => {
            if k.len() != 1 {
                return unsupported("return (shape)");
            }
            Ok(format!("return {}", expr(k[0])?.text))
        }
        "break" => Ok("break".into()),
        "continue" => Ok("continue".into()),
        _ => Ok(expr(node)?.text),
    }
}

/// Whether the root element of a region is a statement outside any program.
pub fn is_statement_root(node: Node) -> bool {
    matches!(
        name_of(node),
        "localDefine"
            | "if"
            | "ifThen"
            | "for"
            | "while"
            | "tryCatch"
            | "return"
            | "break"
            | "continue"
    )
}

// ---- statements --------------------------------------------------------------------------

/// The unit override of an `ml:eval`: `None` for a placeholder or none.
fn unit_override(children: &[Node]) -> Result<Option<String>, MathError> {
    for c in children {
        if name_of(*c) == "unitOverride" {
            let k = kids(*c);
            if let Some(first) = k.first() {
                if name_of(*first) != "placeholder" {
                    // an `.xmcd` may show a value in a multiple of any name (`… π`,
                    // `… %`); a display unit here is a unit, so an override with a name that is
                    // not one is left out and counted for the report.
                    let not_a_unit = DROP_NON_UNIT_OVERRIDES.with(Cell::get)
                        && first.descendants().any(|n| {
                            n.is_element()
                                && name_of(n) == "id"
                                && !crate::units::is_unit(n.text().unwrap_or("").trim())
                        });
                    if not_a_unit {
                        DROPPED_OVERRIDES.with(|c| c.set(c.get() + 1));
                        return Ok(None);
                    }
                    // A unit context: its names stay plain, as the file writes them.
                    return in_unit_context(|| expr(*first)).map(|e| Some(e.text));
                }
            }
        }
    }
    Ok(None)
}

fn eval_text(node: Node) -> Result<String, MathError> {
    let k = kids(node);
    let Some(first) = k.first() else {
        return unsupported("eval (empty)");
    };
    let e = expr(*first)?;
    let mut text = format!("{} =", fit(&e, L_RANGE, true));
    if let Some(unit) = unit_override(&k[1..])? {
        text.push_str(" … ");
        text.push_str(&unit);
    }
    Ok(text)
}

fn target_text(node: Node) -> Result<String, MathError> {
    if name_of(node) == "function" {
        let k = kids(node);
        if k.len() != 2 || name_of(k[1]) != "boundVars" {
            return unsupported("function (head shape)");
        }
        let head = expr(k[0])?;
        let params: Vec<String> = kids(k[1])
            .iter()
            .map(|p| expr(*p).map(|e| e.text))
            .collect::<Result<_, _>>()?;
        return Ok(format!("{}({})", head.text, params.join(", ")));
    }
    Ok(expr(node)?.text)
}

/// `e → [kw, …]` of an `ml:symEval`.
fn sym_eval_text(node: Node) -> Result<String, MathError> {
    let k = kids(node);
    let Some(first) = k.first() else {
        return unsupported("symEval (empty)");
    };
    let e = expr(*first)?;
    let mut text = format!("{} →", fit(&e, L_RANGE, true));
    for c in &k[1..] {
        if name_of(*c) != "command" {
            continue;
        }
        let parts = kids(*c);
        let mut items = if parts.len() == 1 && name_of(parts[0]) == "sequence" {
            kids(parts[0])
        } else {
            parts
        };
        // the reference application saves a keyword with two or more arguments as left-nested sequences,
        // `((series, x), 4)`: unfold them into one flat list.
        while items
            .first()
            .is_some_and(|first| name_of(*first) == "sequence")
        {
            let mut flat = kids(items[0]);
            flat.extend_from_slice(&items[1..]);
            items = flat;
        }
        // An empty keyword slot (`→` with a placeholder) is a plain symbolic evaluation.
        if items.len() == 1 && name_of(items[0]) == "placeholder" {
            continue;
        }
        let rendered: Vec<String> = items
            .iter()
            .map(|i| expr(*i).map(|e| e.text))
            .collect::<Result<_, _>>()?;
        text.push_str(&format!("[{}]", rendered.join(", ")));
    }
    Ok(text)
}

/// The linear text of the statement of a `math` element's content. The element is the
/// single `ml:` child of `math`.
pub fn statement_text(node: Node) -> Result<String, MathError> {
    match name_of(node) {
        "define" => {
            let k = kids(node);
            if k.len() != 2 {
                return unsupported("define (arity)");
            }
            let lhs = target_text(k[0])?;
            let rhs = if name_of(k[1]) == "eval" {
                eval_text(k[1])?
            } else if name_of(k[1]) == "symEval" {
                // `f(t) := e → [kw]`: an `.xmcd` definition with a symbolic tail.
                sym_eval_text(k[1])?
            } else {
                expr(k[1])?.text
            };
            Ok(format!("{lhs} := {rhs}"))
        }
        // The global definition of an `.xmcd`; the `.mcdx` has none.
        "globalDefine" => {
            let k = kids(node);
            if k.len() != 2 {
                return unsupported("globalDefine (arity)");
            }
            Ok(format!("{} ≡ {}", target_text(k[0])?, expr(k[1])?.text))
        }
        "provenance" => statement_text(provenance_payload(node)?),
        "eval" => eval_text(node),
        "symEval" => sym_eval_text(node),
        // A statement that is the whole region, outside a program: a bare expression holding a
        // program of that statement.
        "localDefine" | "return" | "break" | "continue" => {
            Ok(format!("program {{ {} }}", stmt(node)?))
        }
        _ => Ok(fit(&expr(node)?, 0, true)),
    }
}
