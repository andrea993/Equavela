//! Lexer for sheet math text (math-syntax sections 2 and 3).
//!
//! ASCII input spellings are mapped to the canonical tokens here. Line breaks become
//! `Newline` tokens carrying the indentation of the next non-blank line; blank lines and
//! trailing line breaks produce no tokens.

use super::error::ParseError;
use crate::ast::{ImagUnit, Label, Name, Segment, Span};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Num(String),
    Imag(String, ImagUnit),
    Str(String),
    Placeholder,
    /// A name; the second field is the bare word when the name is a single unquoted base
    /// with no label (candidate keyword).
    Ident(Name, Option<String>),
    /// `Package::name` of a qualified Julia call.
    JuliaQual(String, String),
    ColonEq,
    Equiv,
    Equals,
    Arrow,
    LArrow,
    EqEq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    In,
    And,
    Or,
    Xor,
    Not,
    Plus,
    Minus,
    Dot,
    Cross,
    /// `∗` or `\conv`, `⊛` or `\cconv`: the convolutions.
    Conv,
    CircConv,
    /// `∠` or `\polar`: the polar form.
    Angle,
    /// `∇` or `\nabla`: the gradient.
    Nabla,
    InlineDiv,
    Slash,
    Caret,
    Transpose,
    Bang,
    Prime,
    /// `%`: the reference application's postfix percent.
    Percent,
    /// `‰` or `\permille`: the per mille.
    Permille,
    DotDot,
    Comma,
    Semi,
    Ellipsis,
    /// `⋯`: a horizontal ellipsis cell.
    Cdots,
    /// `⋮`: a vertical ellipsis cell.
    Vdots,
    /// `⋱`: a diagonal ellipsis cell.
    Ddots,
    LParen,
    RParen,
    LBrack,
    RBrack,
    LBrace,
    RBrace,
    LAngle,
    RAngle,
    LDAngle,
    RDAngle,
    Bar,
    DBar,
    Sqrt,
    Sum,
    Prod,
    Integral,
    DerivD,
    Partial,
    Lim,
    Vec,
    Conj,
    /// `\Re`, `\Im`: the real and imaginary part.
    RealPart,
    ImagPart,
    Det,
    AbsWord,
    NormWord,
    Newline(usize),
    Eof,
}

#[derive(Debug, Clone)]
pub(crate) struct Token {
    pub tok: Tok,
    pub span: Span,
    /// White space (or a line start) precedes the token.
    pub space_before: bool,
    /// The token is followed by white space, a line break, `;`, `}` or the end of input
    /// (used for statement keywords, math-syntax 3.2).
    pub delim_after: bool,
}

pub(crate) struct Lexed {
    pub tokens: Vec<Token>,
    /// Indentation of the first non-blank line.
    pub first_indent: usize,
}

/// `letter` of math-syntax 3.1. Approximated by the Unicode `Alphabetic` property (a
/// superset of general category L*), minus the reserved glyphs `ᵀ` and `ⅆ`.
pub(crate) fn is_letter(c: char) -> bool {
    c.is_alphabetic() && c != 'ᵀ' && c != 'ⅆ'
}

fn is_name_start_char(c: char) -> bool {
    is_letter(c) || c.is_ascii_digit() || c == '∞' || c == '°'
}

/// `namechar` at position `k` of `chars` (the `.` rule needs the next character). The
/// apostrophe never starts a part, so it is a `namechar` only after the first character:
/// `x'` and `x''` are names, the prime derivative is `′`.
pub(crate) fn is_namechar_at(chars: &[char], k: usize) -> bool {
    match chars.get(k) {
        Some(&c) if is_name_start_char(c) => true,
        Some('\'') => true,
        Some('.') => matches!(chars.get(k + 1), Some(&n) if is_name_start_char(n)),
        _ => false,
    }
}

/// `plain-part` of math-syntax 3.2.
pub(crate) fn is_plain_part(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    match chars.first() {
        // `°` starts the temperature units `°C` and `°F`.
        Some(&c) if is_letter(c) || c == '∞' || c == '°' => {}
        _ => return false,
    }
    (1..chars.len()).all(|k| is_namechar_at(&chars, k))
}

/// `plain-sub` of math-syntax 3.2.
pub(crate) fn is_plain_sub(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    match chars.first() {
        Some(&c) if is_name_start_char(c) => {}
        _ => return false,
    }
    (1..chars.len()).all(|k| chars[k] == '_' || is_namechar_at(&chars, k))
}

const LABEL_WORDS: &str = "var, fn, unit, const, sys, kw, julia";

/// Words that start a program statement (math-syntax 3.2).
pub(crate) const STATEMENT_KEYWORDS: [&str; 10] = [
    "if", "else", "also", "for", "while", "break", "continue", "return", "try", "on",
];

pub(crate) fn lex(src: &str) -> Result<Lexed, ParseError> {
    let mut lx = Lexer {
        src,
        offs: src.char_indices().map(|(o, _)| o).collect(),
        chars: src.chars().collect(),
        i: 0,
        tokens: Vec::new(),
        space: true,
    };
    let first_indent = lx.skip_blank_lines()?.unwrap_or(0);
    lx.run()?;
    Ok(Lexed {
        tokens: lx.tokens,
        first_indent,
    })
}

struct Lexer<'a> {
    src: &'a str,
    offs: Vec<usize>,
    chars: Vec<char>,
    i: usize,
    tokens: Vec<Token>,
    space: bool,
}

impl Lexer<'_> {
    fn c(&self, k: usize) -> Option<char> {
        self.chars.get(self.i + k).copied()
    }

    fn off(&self, idx: usize) -> usize {
        self.offs.get(idx).copied().unwrap_or(self.src.len())
    }

    fn span(&self, from: usize, to: usize) -> Span {
        Span::new(self.off(from), self.off(to))
    }

    fn err(&self, from: usize, to: usize, msg: impl Into<String>) -> ParseError {
        ParseError::at(self.src, self.span(from, to), msg)
    }

    fn push(&mut self, tok: Tok, from: usize) {
        let delim_after = matches!(
            self.chars.get(self.i),
            None | Some(' ' | '\n' | '\r' | ';' | '}')
        );
        let span = self.span(from, self.i);
        self.tokens.push(Token {
            tok,
            span,
            space_before: self.space,
            delim_after,
        });
        self.space = false;
    }

    /// Skips blank lines at the current line start; returns the indentation of the next
    /// non-blank line, or `None` at the end of input.
    fn skip_blank_lines(&mut self) -> Result<Option<usize>, ParseError> {
        loop {
            let mut k = 0;
            while self.c(k) == Some(' ') {
                k += 1;
            }
            match self.c(k) {
                None => {
                    self.i += k;
                    return Ok(None);
                }
                Some('\n') => self.i += k + 1,
                Some('\r') if self.c(k + 1) == Some('\n') => self.i += k + 2,
                Some('\t') => {
                    return Err(self.err(
                        self.i + k,
                        self.i + k + 1,
                        "tab characters are not allowed; indent with spaces",
                    ))
                }
                Some(_) => {
                    self.i += k;
                    return Ok(Some(k));
                }
            }
        }
    }

    fn run(&mut self) -> Result<(), ParseError> {
        while let Some(c) = self.c(0) {
            match c {
                ' ' => {
                    self.i += 1;
                    self.space = true;
                }
                '\t' => {
                    return Err(self.err(
                        self.i,
                        self.i + 1,
                        "tab characters are not allowed; use spaces",
                    ))
                }
                '\n' | '\r' => {
                    let start = self.i;
                    if c == '\r' {
                        if self.c(1) != Some('\n') {
                            return Err(self.err(
                                start,
                                start + 1,
                                "a carriage return must be followed by a line feed",
                            ));
                        }
                        self.i += 1;
                    }
                    self.i += 1;
                    match self.skip_blank_lines()? {
                        Some(indent) => {
                            self.tokens.push(Token {
                                tok: Tok::Newline(indent),
                                span: self.span(start, start + 1),
                                space_before: self.space,
                                delim_after: true,
                            });
                            self.space = true;
                        }
                        None => break,
                    }
                }
                _ => self.token(c)?,
            }
        }
        let end = self.src.len();
        self.tokens.push(Token {
            tok: Tok::Eof,
            span: Span::new(end, end),
            space_before: self.space,
            delim_after: true,
        });
        Ok(())
    }

    fn token(&mut self, c: char) -> Result<(), ParseError> {
        let start = self.i;
        if is_letter(c) {
            if let Some(tok) = self.julia_qualified()? {
                self.push(tok, start);
                return Ok(());
            }
        }
        if is_letter(c) || c == '∞' || c == '°' || c == '`' {
            let tok = self.identifier()?;
            self.push(tok, start);
            return Ok(());
        }
        if c.is_ascii_digit() || (c == '.' && matches!(self.c(1), Some(d) if d.is_ascii_digit())) {
            let tok = self.number();
            self.push(tok, start);
            return Ok(());
        }
        let (tok, len) = match c {
            ':' if self.c(1) == Some('=') => (Tok::ColonEq, 2),
            ':' => {
                return Err(self.err(
                    start,
                    start + 1,
                    "unexpected `:` (a definition is written `:=`; `::` must follow a Julia package name)",
                ))
            }
            '≡' => (Tok::Equiv, 1),
            '=' if self.c(1) == Some('=') && self.c(2) == Some('=') => (Tok::Equiv, 3),
            '=' if self.c(1) == Some('=') => (Tok::EqEq, 2),
            '=' => (Tok::Equals, 1),
            '→' => (Tok::Arrow, 1),
            '←' => (Tok::LArrow, 1),
            '≠' => (Tok::Ne, 1),
            '≤' => (Tok::Le, 1),
            '≥' => (Tok::Ge, 1),
            '∈' => (Tok::In, 1),
            '∧' => (Tok::And, 1),
            '∨' => (Tok::Or, 1),
            '⊕' => (Tok::Xor, 1),
            '¬' => (Tok::Not, 1),
            '+' => (Tok::Plus, 1),
            '-' if self.c(1) == Some('>') => (Tok::Arrow, 2),
            '-' | '−' => (Tok::Minus, 1),
            '·' | '*' => (Tok::Dot, 1),
            '×' => (Tok::Cross, 1),
            '∗' => (Tok::Conv, 1),
            '⊛' => (Tok::CircConv, 1),
            '∠' => (Tok::Angle, 1),
            '∇' => (Tok::Nabla, 1),
            '÷' => (Tok::InlineDiv, 1),
            '/' => (Tok::Slash, 1),
            '^' => (Tok::Caret, 1),
            'ᵀ' => (Tok::Transpose, 1),
            '!' if self.c(1) == Some('=') => (Tok::Ne, 2),
            '!' => (Tok::Bang, 1),
            '′' | '\'' => (Tok::Prime, 1),
            '%' => (Tok::Percent, 1),
            '‰' => (Tok::Permille, 1),
            '<' if self.c(1) == Some('<') && self.c(2) == Some('<') => (Tok::LDAngle, 3),
            '<' if self.c(1) == Some('<') => (Tok::LAngle, 2),
            '<' if self.c(1) == Some('=') => (Tok::Le, 2),
            '<' if self.c(1) == Some('-') => (Tok::LArrow, 2),
            '<' if self.c(1) == Some('>') => (Tok::Ne, 2),
            '<' => (Tok::Lt, 1),
            '>' if self.c(1) == Some('>') && self.c(2) == Some('>') => (Tok::RDAngle, 3),
            '>' if self.c(1) == Some('>') => (Tok::RAngle, 2),
            '>' if self.c(1) == Some('=') => (Tok::Ge, 2),
            '>' => (Tok::Gt, 1),
            '.' if self.c(1) == Some('.') && self.c(2) == Some('.') => {
                // `...` before a digit is `..` followed by a number such as `.5`.
                if matches!(self.c(3), Some(d) if d.is_ascii_digit()) {
                    (Tok::DotDot, 2)
                } else {
                    (Tok::Ellipsis, 3)
                }
            }
            '.' if self.c(1) == Some('.') => (Tok::DotDot, 2),
            '.' => {
                return Err(self.err(
                    start,
                    start + 1,
                    "unexpected `.` (a period is part of a name only before a letter or digit)",
                ))
            }
            ',' => (Tok::Comma, 1),
            ';' => (Tok::Semi, 1),
            '…' => (Tok::Ellipsis, 1),
            '⋯' => (Tok::Cdots, 1),
            '⋮' => (Tok::Vdots, 1),
            '⋱' => (Tok::Ddots, 1),
            '(' => (Tok::LParen, 1),
            ')' => (Tok::RParen, 1),
            '[' => (Tok::LBrack, 1),
            ']' => (Tok::RBrack, 1),
            '{' => (Tok::LBrace, 1),
            '}' => (Tok::RBrace, 1),
            '⟨' => (Tok::LAngle, 1),
            '⟩' => (Tok::RAngle, 1),
            '⟪' => (Tok::LDAngle, 1),
            '⟫' => (Tok::RDAngle, 1),
            '|' => (Tok::Bar, 1),
            '‖' => (Tok::DBar, 1),
            '√' => (Tok::Sqrt, 1),
            '∑' => (Tok::Sum, 1),
            '∏' => (Tok::Prod, 1),
            '∫' => (Tok::Integral, 1),
            'ⅆ' => (Tok::DerivD, 1),
            '∂' => (Tok::Partial, 1),
            '□' | '?' => (Tok::Placeholder, 1),
            '"' => {
                let tok = self.string()?;
                self.push(tok, start);
                return Ok(());
            }
            '\\' => {
                let tok = self.backslash_word()?;
                self.push(tok, start);
                return Ok(());
            }
            '@' => {
                return Err(self.err(
                    start,
                    start + 1,
                    "unexpected `@`: a label must directly follow a name",
                ))
            }
            c if c.is_control() => {
                return Err(self.err(
                    start,
                    start + 1,
                    format!("control character U+{:04X} is not allowed", c as u32),
                ))
            }
            c => {
                return Err(self.err(
                    start,
                    start + 1,
                    format!("unexpected character `{c}`"),
                ))
            }
        };
        self.i += len;
        self.push(tok, start);
        Ok(())
    }

    fn number(&mut self) -> Tok {
        let start = self.i;
        while matches!(self.c(0), Some(d) if d.is_ascii_digit()) {
            self.i += 1;
        }
        if self.c(0) == Some('.') && matches!(self.c(1), Some(d) if d.is_ascii_digit()) {
            self.i += 1;
            while matches!(self.c(0), Some(d) if d.is_ascii_digit()) {
                self.i += 1;
            }
        }
        if matches!(self.c(0), Some('e' | 'E')) {
            let digit_at = if matches!(self.c(1), Some('+' | '-')) {
                2
            } else {
                1
            };
            if matches!(self.c(digit_at), Some(d) if d.is_ascii_digit()) {
                self.i += digit_at;
                while matches!(self.c(0), Some(d) if d.is_ascii_digit()) {
                    self.i += 1;
                }
            }
        }
        let text = self.src[self.off(start)..self.off(self.i)].to_string();
        if let Some(u @ ('i' | 'j')) = self.c(0) {
            if !is_namechar_at(&self.chars, self.i + 1) {
                self.i += 1;
                let unit = if u == 'i' { ImagUnit::I } else { ImagUnit::J };
                return Tok::Imag(text, unit);
            }
        }
        Tok::Num(text)
    }

    fn string(&mut self) -> Result<Tok, ParseError> {
        let start = self.i;
        self.i += 1;
        let mut value = String::new();
        loop {
            match self.c(0) {
                None | Some('\n') | Some('\r') => {
                    return Err(self.err(start, self.i, "unterminated string literal"))
                }
                Some('"') => {
                    self.i += 1;
                    return Ok(Tok::Str(value));
                }
                Some('\\') => {
                    let esc_start = self.i;
                    match self.c(1) {
                        Some('"') => value.push('"'),
                        Some('\\') => value.push('\\'),
                        Some('n') => value.push('\n'),
                        Some('t') => value.push('\t'),
                        Some('u') if self.c(2) == Some('{') => {
                            let mut k = 3;
                            let mut hex = String::new();
                            while let Some(h) = self.c(k) {
                                if h == '}' {
                                    break;
                                }
                                hex.push(h);
                                k += 1;
                            }
                            let ch = if self.c(k) == Some('}')
                                && (1..=6).contains(&hex.len())
                                && hex.chars().all(|h| h.is_ascii_hexdigit())
                            {
                                u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32)
                            } else {
                                None
                            };
                            match ch {
                                Some(ch) => value.push(ch),
                                None => {
                                    return Err(self.err(
                                        esc_start,
                                        self.i + k + 1,
                                        "invalid `\\u{…}` escape (1 to 6 hex digits of a Unicode scalar value)",
                                    ))
                                }
                            }
                            self.i += k + 1;
                            continue;
                        }
                        _ => return Err(self.err(
                            esc_start,
                            esc_start + 2,
                            "invalid escape in string literal (use \\\", \\\\, \\n, \\t or \\u{…})",
                        )),
                    }
                    self.i += 2;
                }
                Some('\t') => {
                    return Err(self.err(
                        self.i,
                        self.i + 1,
                        "tab characters are not allowed; write `\\t` inside a string",
                    ))
                }
                Some(ch) => {
                    value.push(ch);
                    self.i += 1;
                }
            }
        }
    }

    fn backslash_word(&mut self) -> Result<Tok, ParseError> {
        let start = self.i;
        self.i += 1;
        while matches!(self.c(0), Some(c) if c.is_ascii_alphabetic()) {
            self.i += 1;
        }
        let word = &self.src[self.off(start + 1)..self.off(self.i)];
        Ok(match word {
            "vec" => Tok::Vec,
            "conj" => Tok::Conj,
            "Re" => Tok::RealPart,
            "Im" => Tok::ImagPart,
            "permille" => Tok::Permille,
            "det" => Tok::Det,
            "lim" => Tok::Lim,
            "abs" => Tok::AbsWord,
            "norm" => Tok::NormWord,
            "sqrt" => Tok::Sqrt,
            "sum" => Tok::Sum,
            "prod" => Tok::Prod,
            "int" => Tok::Integral,
            "d" => Tok::DerivD,
            "partial" => Tok::Partial,
            "in" => Tok::In,
            "and" => Tok::And,
            "or" => Tok::Or,
            "xor" => Tok::Xor,
            "not" => Tok::Not,
            "times" => Tok::Cross,
            "conv" => Tok::Conv,
            "cconv" => Tok::CircConv,
            "polar" => Tok::Angle,
            "nabla" => Tok::Nabla,
            "cdots" => Tok::Cdots,
            "vdots" => Tok::Vdots,
            "ddots" => Tok::Ddots,
            "div" => Tok::InlineDiv,
            "T" => Tok::Transpose,
            "" => {
                return Err(self.err(
                    start,
                    start + 1,
                    "a backslash must start an operator word such as `\\vec`",
                ))
            }
            w => return Err(self.err(start, self.i, format!("unknown backslash word `\\{w}`"))),
        })
    }

    /// `Package::name`. Returns `None` when no `::` follows the word.
    fn julia_qualified(&mut self) -> Result<Option<Tok>, ParseError> {
        let julia_char = |c: char| is_letter(c) || c.is_ascii_digit() || c == '_';
        let part_start = |c: Option<char>| matches!(c, Some(c) if is_letter(c) || c == '_');
        let mut k = 0;
        loop {
            while matches!(self.c(k), Some(c) if julia_char(c)) {
                k += 1;
            }
            if self.c(k) == Some('.') && part_start(self.c(k + 1)) {
                k += 1;
            } else {
                break;
            }
        }
        if !(self.c(k) == Some(':') && self.c(k + 1) == Some(':')) {
            // `julia.name`, the qualifier of a Julia block name:
            // the word reads as one name otherwise (`.` before a letter is a name char).
            let prefix = ['j', 'u', 'l', 'i', 'a', '.'];
            if (0..prefix.len()).all(|n| self.c(n) == Some(prefix[n])) && part_start(self.c(6)) {
                self.i += prefix.len();
                let name_start = self.i;
                loop {
                    while matches!(self.c(0), Some(c) if julia_char(c) || c == '!') {
                        self.i += 1;
                    }
                    // `julia.X.f`: a name of the module `X`.
                    if self.c(0) == Some('.') && part_start(self.c(1)) {
                        self.i += 1;
                    } else {
                        break;
                    }
                }
                let name: String = self.chars[name_start..self.i].iter().collect();
                return Ok(Some(Tok::JuliaQual("julia".to_string(), name)));
            }
            return Ok(None);
        }
        let start = self.i;
        let package: String = self.chars[start..start + k].iter().collect();
        let valid_package = package.split('.').all(|part| {
            let mut cs = part.chars();
            matches!(cs.next(), Some(c) if is_letter(c) || c == '_') && cs.all(julia_char)
        });
        if !valid_package {
            return Err(self.err(
                start,
                start + k,
                format!("`{package}` is not a valid Julia package name"),
            ));
        }
        self.i += k + 2;
        let name_start = self.i;
        if !matches!(self.c(0), Some(c) if is_letter(c) || c == '_') {
            return Err(self.err(
                name_start,
                name_start + 1,
                "expected a Julia function name after `::`",
            ));
        }
        while matches!(self.c(0), Some(c) if julia_char(c) || c == '!') {
            self.i += 1;
        }
        let name: String = self.chars[name_start..self.i].iter().collect();
        Ok(Some(Tok::JuliaQual(package, name)))
    }

    fn identifier(&mut self) -> Result<Tok, ParseError> {
        let mut segments = Vec::new();
        let mut quoted = false;
        let (text, q) = self.base_part()?;
        quoted |= q;
        segments.push(Segment {
            text,
            subscript: false,
        });
        loop {
            if self.c(0) == Some('_') && self.c(1) == Some('{') {
                let sub_start = self.i;
                self.i += 2;
                let text = self.braced_sub(sub_start)?;
                segments.push(Segment {
                    text,
                    subscript: true,
                });
                if matches!(self.c(0), Some(c) if is_letter(c) || c == '∞' || c == '`') {
                    let (text, q) = self.base_part()?;
                    quoted |= q;
                    segments.push(Segment {
                        text,
                        subscript: false,
                    });
                    continue;
                }
                break;
            } else if self.c(0) == Some('_') {
                self.i += 1;
                let text = match self.c(0) {
                    Some('`') => {
                        quoted = true;
                        self.quoted_part()?
                    }
                    Some(c) if is_name_start_char(c) => {
                        let s = self.i;
                        self.i += 1;
                        while self.c(0) == Some('_') || is_namechar_at(&self.chars, self.i) {
                            self.i += 1;
                        }
                        self.chars[s..self.i].iter().collect()
                    }
                    _ => {
                        return Err(self.err(
                            self.i - 1,
                            self.i,
                            "expected a subscript after `_` (quote names containing `_` with backticks)",
                        ))
                    }
                };
                segments.push(Segment {
                    text,
                    subscript: true,
                });
                break;
            } else {
                break;
            }
        }
        let mut label = None;
        if self.c(0) == Some('@') {
            let at = self.i;
            self.i += 1;
            while matches!(self.c(0), Some(c) if c.is_ascii_alphabetic()) {
                self.i += 1;
            }
            let word = &self.src[self.off(at + 1)..self.off(self.i)];
            match Label::from_word(word) {
                Some(l) => label = Some(l),
                None if word.is_empty() => {
                    return Err(self.err(at, at + 1, "expected a label after `@`"))
                }
                None => {
                    let msg = format!("unknown label `@{word}` (labels: {LABEL_WORDS})");
                    return Err(self.err(at, self.i, msg));
                }
            }
        }
        let bare = if segments.len() == 1 && !quoted && label.is_none() {
            Some(segments[0].text.clone())
        } else {
            None
        };
        Ok(Tok::Ident(Name { segments, label }, bare))
    }

    /// `plain-part` or `quoted-part`; returns the text and whether it was quoted.
    fn base_part(&mut self) -> Result<(String, bool), ParseError> {
        if self.c(0) == Some('`') {
            return Ok((self.quoted_part()?, true));
        }
        let s = self.i;
        self.i += 1;
        while is_namechar_at(&self.chars, self.i) {
            self.i += 1;
        }
        Ok((self.chars[s..self.i].iter().collect(), false))
    }

    fn quoted_part(&mut self) -> Result<String, ParseError> {
        let start = self.i;
        self.i += 1;
        let mut text = String::new();
        loop {
            match self.c(0) {
                Some('`') => {
                    self.i += 1;
                    break;
                }
                Some('\\') => match self.c(1) {
                    Some(c @ ('`' | '\\')) => {
                        text.push(c);
                        self.i += 2;
                    }
                    _ => {
                        return Err(self.err(
                            self.i,
                            self.i + 2,
                            "invalid escape in quoted name (use \\` or \\\\)",
                        ))
                    }
                },
                Some(c) if !c.is_control() => {
                    text.push(c);
                    self.i += 1;
                }
                _ => return Err(self.err(start, self.i, "unterminated quoted name")),
            }
        }
        if text.is_empty() {
            return Err(self.err(start, self.i, "empty quoted name"));
        }
        Ok(text)
    }

    fn braced_sub(&mut self, start: usize) -> Result<String, ParseError> {
        let mut text = String::new();
        loop {
            match self.c(0) {
                Some('}') => {
                    self.i += 1;
                    break;
                }
                Some('\\') => match self.c(1) {
                    Some(c @ ('}' | '\\')) => {
                        text.push(c);
                        self.i += 2;
                    }
                    _ => {
                        return Err(self.err(
                            self.i,
                            self.i + 2,
                            "invalid escape in subscript (use \\} or \\\\)",
                        ))
                    }
                },
                Some(c) if !c.is_control() => {
                    text.push(c);
                    self.i += 1;
                }
                _ => return Err(self.err(start, self.i, "unterminated subscript `_{…}`")),
            }
        }
        if text.is_empty() {
            return Err(self.err(start, self.i, "empty subscript `_{}`"));
        }
        Ok(text)
    }
}
