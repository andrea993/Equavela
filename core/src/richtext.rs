//! Rich text of text regions: paragraphs of formatted runs with inline math, and the
//! linear text they are stored as in the worksheet file.
//!
//! The file keeps one block scalar of linear text per text region. This module is the
//! reader (`RichText::parse`, lenient: any text is valid) and the canonical printer
//! (`RichText::print`); the invariant `parse(print(v)) == normalize(v)` is tested. The
//! editor never sees the linear text: it gets the structured value (`ViewContent::Text`)
//! and sends it back (`RichText::from_json`), so only this module knows the grammar.

use crate::ast::{Statement, StatementKind};
use crate::syntax::{normalize::normalize_statement, parse_statement, print_statement};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn is_false(value: &bool) -> bool {
    !*value
}

/// A run of text with one format.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TextRun {
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sub: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub sup: bool,
    /// Font size in points; `None` is the region default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    /// Text colour as `#rrggbb` (lower case); `None` is the region default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Highlight (the background of the run) as `#rrggbb`; `None` is no highlight.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
}

/// A colour as the file and the wire write it: `#rrggbb` in lower case. `None` for anything else, so
/// a colour that is not one never reaches a style sheet.
pub fn normalize_color(text: &str) -> Option<String> {
    let digits = text.strip_prefix('#')?;
    (digits.len() == 6 && digits.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", digits.to_ascii_lowercase()))
}

impl TextRun {
    fn same_format(&self, other: &TextRun) -> bool {
        self.bold == other.bold
            && self.italic == other.italic
            && self.underline == other.underline
            && self.sub == other.sub
            && self.sup == other.sup
            && self.size == other.size
            && self.color == other.color
            && self.highlight == other.highlight
    }
}

/// Separates the text region id from the run index in the result key of an inline math run
///. A control character cannot clash with a region id typed by a user.
const INLINE_SEPARATOR: char = '\u{1e}';

/// The result key region id of the `index`-th math run of the text region `text_id`.
pub fn inline_region_id(text_id: &str, index: usize) -> String {
    format!("{text_id}{INLINE_SEPARATOR}inline{index}")
}

/// Inline math: its linear text and, in views and from the editor,
/// the canonical AST. `statement` is `None` when the text does not parse (the run is then
/// shown as plain text with an error mark) and on the way from the file.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct MathRun {
    pub text: String,
    #[serde(default)]
    pub statement: Option<Box<Statement>>,
    /// The run is not calculated.
    #[serde(default, skip_serializing_if = "is_false")]
    pub disabled: bool,
    /// The run's own result format, keys of the `format.*` display settings.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub format: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Run {
    Text(TextRun),
    Math(MathRun),
}

/// The paragraph styles. `Normal` is the default: a
/// paragraph without a stored style is Normal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParagraphStyle {
    #[default]
    Normal,
    Title,
    Subtitle,
    Heading1,
    Heading2,
    Heading3,
}

impl ParagraphStyle {
    /// The name in the linear text (`{style=heading1}`) and, in snake_case, on the wire.
    pub fn name(self) -> &'static str {
        match self {
            ParagraphStyle::Normal => "normal",
            ParagraphStyle::Title => "title",
            ParagraphStyle::Subtitle => "subtitle",
            ParagraphStyle::Heading1 => "heading1",
            ParagraphStyle::Heading2 => "heading2",
            ParagraphStyle::Heading3 => "heading3",
        }
    }

    /// The style of a name in the linear text; `None` for an unknown name.
    pub fn from_name(name: &str) -> Option<ParagraphStyle> {
        [
            ParagraphStyle::Normal,
            ParagraphStyle::Title,
            ParagraphStyle::Subtitle,
            ParagraphStyle::Heading1,
            ParagraphStyle::Heading2,
            ParagraphStyle::Heading3,
        ]
        .into_iter()
        .find(|style| style.name() == name)
    }

    /// The Outline level of a heading style: 1 to 3, `None` for Normal, Title and Subtitle.
    pub fn heading_level(self) -> Option<u8> {
        match self {
            ParagraphStyle::Heading1 => Some(1),
            ParagraphStyle::Heading2 => Some(2),
            ParagraphStyle::Heading3 => Some(3),
            _ => None,
        }
    }
}

/// The paragraph alignment. `Left` is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParagraphAlign {
    #[default]
    Left,
    Center,
    Right,
    Justify,
}

impl ParagraphAlign {
    /// The name in the linear text (`{align=center}`) and, in snake_case, on the wire.
    pub fn name(self) -> &'static str {
        match self {
            ParagraphAlign::Left => "left",
            ParagraphAlign::Center => "center",
            ParagraphAlign::Right => "right",
            ParagraphAlign::Justify => "justify",
        }
    }

    /// The alignment of a name in the linear text; `None` for an unknown name.
    pub fn from_name(name: &str) -> Option<ParagraphAlign> {
        [
            ParagraphAlign::Left,
            ParagraphAlign::Center,
            ParagraphAlign::Right,
            ParagraphAlign::Justify,
        ]
        .into_iter()
        .find(|align| align.name() == name)
    }
}

fn is_normal(style: &ParagraphStyle) -> bool {
    *style == ParagraphStyle::Normal
}

fn is_left(align: &ParagraphAlign) -> bool {
    *align == ParagraphAlign::Left
}

/// A paragraph: its two attributes and its runs. The
/// attributes are left out of the wire form when they are the default, so a plain paragraph
/// keeps the shape it had before they existed.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Paragraph {
    #[serde(default, skip_serializing_if = "is_normal")]
    pub style: ParagraphStyle,
    #[serde(default, skip_serializing_if = "is_left")]
    pub align: ParagraphAlign,
    #[serde(default)]
    pub runs: Vec<Run>,
}

impl Paragraph {
    /// A paragraph of runs with the default style and alignment.
    pub fn runs(runs: Vec<Run>) -> Paragraph {
        Paragraph {
            runs,
            ..Paragraph::default()
        }
    }

    /// The Outline level of the paragraph: the level of its style when it is a heading.
    pub fn heading_level(&self) -> Option<u8> {
        self.style.heading_level()
    }
}

/// Paragraphs. A canonical value has at least one paragraph and no trailing empty paragraph.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RichText(pub Vec<Paragraph>);

type Flag = (&'static str, fn(&TextRun) -> bool);
const FLAGS: [Flag; 5] = [
    ("**", |r| r.bold),
    ("*", |r| r.italic),
    ("++", |r| r.underline),
    ("~", |r| r.sub),
    ("^", |r| r.sup),
];

impl RichText {
    /// Canonical form: line breaks inside runs become spaces, empty runs and empty math
    /// are dropped, adjacent runs of equal format are merged, trailing empty paragraphs
    /// and trailing whitespace are dropped, and there is at least one paragraph.
    pub fn normalize(&mut self) {
        for paragraph in &mut self.0 {
            let mut runs: Vec<Run> = Vec::with_capacity(paragraph.runs.len());
            for run in paragraph.runs.drain(..) {
                match run {
                    Run::Text(mut text) => {
                        if text.text.contains(['\n', '\r']) {
                            text.text = text.text.replace(['\r', '\n'], " ");
                        }
                        if text.text.is_empty() {
                            continue;
                        }
                        if let Some(Run::Text(last)) = runs.last_mut() {
                            if last.same_format(&text) {
                                last.text.push_str(&text.text);
                                continue;
                            }
                        }
                        runs.push(Run::Text(text));
                    }
                    Run::Math(mut math) => {
                        math.text = math.text.replace(['\r', '\n'], " ");
                        if !math.text.trim().is_empty() {
                            runs.push(Run::Math(math));
                        }
                    }
                }
            }
            paragraph.runs = runs;
        }
        loop {
            while self.0.last().is_some_and(|p| p.runs.is_empty()) {
                self.0.pop();
            }
            let Some(Run::Text(last)) = self.0.last_mut().and_then(|p| p.runs.last_mut()) else {
                break;
            };
            let trimmed = last.text.trim_end().len();
            if trimmed == last.text.len() {
                break;
            }
            last.text.truncate(trimmed);
            if last.text.is_empty() {
                self.0.last_mut().expect("a last paragraph").runs.pop();
            } else {
                break;
            }
        }
        if self.0.is_empty() {
            self.0.push(Paragraph::default());
        }
    }

    /// Reads linear text. Every string is valid: an unterminated `$`, an unknown `{...}`
    /// or a lone `\` are literal characters. The result is canonical.
    pub fn parse(linear: &str) -> RichText {
        let mut value = RichText(linear.split("\n\n").map(parse_paragraph).collect());
        value.normalize();
        value
    }

    /// The canonical linear text (the stored form).
    pub fn print(&self) -> String {
        let mut value = self.clone();
        value.normalize();
        value
            .0
            .iter()
            .map(print_paragraph)
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// The inline math runs that the analysis evaluates:
    /// definitions, evaluations and symbolic evaluations, as `(index of the math run among all
    /// math runs of the text, statement)` in reading order. Bare expressions and text that does
    /// not parse are left out.
    pub fn evaluated_math(&self) -> Vec<(usize, Statement)> {
        let mut out = Vec::new();
        let mut index = 0;
        for run in self.0.iter().flat_map(|paragraph| &paragraph.runs) {
            if let Run::Math(math) = run {
                // A disabled run is not calculated but still counts in the index.
                let parsed = if math.disabled {
                    None
                } else {
                    parse_statement(&math.text).ok()
                };
                if let Some(statement) = parsed {
                    if matches!(
                        statement.kind,
                        StatementKind::Define { .. }
                            | StatementKind::GlobalDefine { .. }
                            | StatementKind::Evaluate { .. }
                            | StatementKind::Symbolic { .. }
                    ) {
                        out.push((index, statement));
                    }
                }
                index += 1;
            }
        }
        out
    }

    /// Fills `statement` of every math run from its text (`None` when it does not parse).
    pub fn resolve_math(&mut self) {
        for run in self.0.iter_mut().flat_map(|paragraph| &mut paragraph.runs) {
            if let Run::Math(math) = run {
                math.statement = parse_statement(&math.text).ok().map(Box::new);
            }
        }
    }

    /// The value sent by the editor (runs as JSON, math runs with their `statement` AST):
    /// math is normalized and printed by the Rust printer, which stays the authority on
    /// its text; the result is canonical and has no `statement` left.
    pub fn from_json(value: serde_json::Value) -> Result<RichText, String> {
        let mut value: RichText =
            serde_json::from_value(value).map_err(|error| format!("invalid text: {error}"))?;
        for run in value.0.iter_mut().flat_map(|paragraph| &mut paragraph.runs) {
            if let Run::Math(math) = run {
                if let Some(mut statement) = math.statement.take() {
                    normalize_statement(&mut statement);
                    math.text = print_statement(&statement);
                }
            }
        }
        value.normalize();
        Ok(value)
    }
}

/// The canonical form of linear text: `print(parse(text))`.
pub fn canonical(linear: &str) -> String {
    RichText::parse(linear).print()
}

/// A paragraph attribute token at the very start of a paragraph (`{style=title}`, `{align=center}`).
enum Attribute {
    Style(ParagraphStyle),
    Align(ParagraphAlign),
}

impl Attribute {
    /// The token at the start of `chars` and its length in characters.
    fn at(chars: &[char]) -> Option<(Attribute, usize)> {
        if chars.first() != Some(&'{') {
            return None;
        }
        let end = chars.iter().position(|&c| c == '}')?;
        let body: String = chars[1..end].iter().collect();
        let attribute = if let Some(name) = body.strip_prefix("style=") {
            Attribute::Style(ParagraphStyle::from_name(name)?)
        } else {
            Attribute::Align(ParagraphAlign::from_name(body.strip_prefix("align=")?)?)
        };
        Some((attribute, end + 1))
    }
}

/// The math between the `$` at `open` and the next unescaped `$`, and the index after it.
fn scan_math(chars: &[char], open: usize) -> Option<(String, usize)> {
    let mut j = open + 1;
    let mut source = String::new();
    while j < chars.len() {
        if chars[j] == '$' {
            return Some((source, j + 1));
        }
        if chars[j] == '\\' && j + 1 < chars.len() {
            j += 1;
        }
        source.push(chars[j]);
        j += 1;
    }
    None
}

/// A chain of run attribute tokens (`{disabled}`, `{format.key=value}`) at `start`, and the index
/// of the `$` that follows it. `None` when there is no token or no `$` right after the chain.
fn inline_attributes(
    chars: &[char],
    start: usize,
) -> Option<(bool, BTreeMap<String, String>, usize)> {
    let mut at = start;
    let mut disabled = false;
    let mut format = BTreeMap::new();
    while chars.get(at) == Some(&'{') {
        let end = at + chars[at..].iter().position(|&c| c == '}')?;
        let body: String = chars[at + 1..end].iter().collect();
        if body == "disabled" {
            disabled = true;
        } else if let Some((key, value)) = body
            .split_once('=')
            .filter(|(key, _)| key.starts_with("format."))
        {
            format.insert(key.to_string(), value.to_string());
        } else {
            return None;
        }
        at = end + 1;
    }
    (at > start && chars.get(at) == Some(&'$')).then_some((disabled, format, at))
}

fn parse_paragraph(line: &str) -> Paragraph {
    let chars: Vec<char> = line.chars().collect();
    // The attributes sit at the very start of the paragraph, each at most once, in any order
    // (the printer writes the canonical order). Anything else is the first run's text.
    let mut paragraph = Paragraph::default();
    let (mut style_seen, mut align_seen) = (false, false);
    let mut start = 0;
    while !(style_seen && align_seen) {
        let Some((attribute, len)) = Attribute::at(&chars[start..]) else {
            break;
        };
        match attribute {
            Attribute::Style(style) if !style_seen => {
                paragraph.style = style;
                style_seen = true;
            }
            Attribute::Align(align) if !align_seen => {
                paragraph.align = align;
                align_seen = true;
            }
            // A repeated token is text, as everywhere else in this lenient reader.
            _ => break,
        }
        start += len;
    }
    let chars = &chars[start..];
    let mut runs = Vec::new();
    let mut state = TextRun::default();
    let mut buffer = String::new();
    let flush = |runs: &mut Vec<Run>, state: &TextRun, buffer: &mut String| {
        if !buffer.is_empty() {
            runs.push(Run::Text(TextRun {
                text: std::mem::take(buffer),
                ..state.clone()
            }));
        }
    };
    let starts = |at: usize, pattern: &str| {
        pattern
            .chars()
            .enumerate()
            .all(|(k, c)| chars.get(at + k) == Some(&c))
    };
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            buffer.push(chars[i + 1]);
            i += 2;
        } else if let Some((disabled, format, at)) = inline_attributes(chars, i) {
            // `{disabled}` and `{format.key=value}` right before a closed `$...$` belong to that
            // run; anywhere else the `{` is a literal character.
            match scan_math(chars, at) {
                Some((source, end)) => {
                    flush(&mut runs, &state, &mut buffer);
                    runs.push(Run::Math(MathRun {
                        text: source,
                        statement: None,
                        disabled,
                        format,
                    }));
                    i = end;
                }
                None => {
                    buffer.push('{');
                    i += 1;
                }
            }
        } else if c == '$' {
            // Inline math up to the next unescaped `$`; without one the `$` is literal.
            match scan_math(chars, i) {
                Some((source, end)) => {
                    flush(&mut runs, &state, &mut buffer);
                    runs.push(Run::Math(MathRun {
                        text: source,
                        ..Default::default()
                    }));
                    i = end;
                }
                None => {
                    buffer.push('$');
                    i += 1;
                }
            }
        } else if c == '{' && (starts(i, "{size") || starts(i, "{color") || starts(i, "{bg")) {
            let name = if starts(i, "{size") {
                "size"
            } else if starts(i, "{color") {
                "color"
            } else {
                "bg"
            };
            let end = chars[i..].iter().position(|&c| c == '}').map(|p| i + p);
            let argument = end.map(|end| chars[i + 1 + name.len()..end].iter().collect::<String>());
            // `{name}` resets, `{name=value}` sets; a value that is not one leaves the token as text.
            let value: Option<Option<String>> = match argument.as_deref() {
                Some("") => Some(None),
                Some(arg) => arg.strip_prefix('=').and_then(|value| match name {
                    "size" => value
                        .parse::<f64>()
                        .ok()
                        .filter(|n| n.is_finite() && *n > 0.0)
                        .map(|n| Some(format_size(n))),
                    _ => normalize_color(value).map(Some),
                }),
                None => None,
            };
            match (value, end) {
                (Some(value), Some(end)) => {
                    flush(&mut runs, &state, &mut buffer);
                    match name {
                        "size" => state.size = value.and_then(|n| n.parse().ok()),
                        "color" => state.color = value,
                        _ => state.highlight = value,
                    }
                    i = end + 1;
                }
                _ => {
                    buffer.push('{');
                    i += 1;
                }
            }
        } else {
            let token = if starts(i, "**") {
                Some(0)
            } else if starts(i, "++") {
                Some(2)
            } else {
                match c {
                    '*' => Some(1),
                    '~' => Some(3),
                    '^' => Some(4),
                    _ => None,
                }
            };
            match token {
                Some(index) => {
                    flush(&mut runs, &state, &mut buffer);
                    match index {
                        0 => state.bold = !state.bold,
                        1 => state.italic = !state.italic,
                        2 => state.underline = !state.underline,
                        3 => state.sub = !state.sub,
                        _ => state.sup = !state.sup,
                    }
                    i += FLAGS[index].0.chars().count();
                }
                None => {
                    buffer.push(c);
                    i += 1;
                }
            }
        }
    }
    flush(&mut runs, &state, &mut buffer);
    paragraph.runs = runs;
    paragraph
}

fn escape_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if "\\*$~^[]{}".contains(c) {
            out.push('\\');
            out.push(c);
        } else if c == '+'
            && (i == 0 || i + 1 == chars.len() || chars[i - 1] == '+' || chars[i + 1] == '+')
        {
            out.push_str("\\+");
        } else {
            out.push(c);
        }
    }
    out
}

fn format_size(size: f64) -> String {
    if size.fract() == 0.0 {
        format!("{}", size as i64)
    } else {
        format!("{size}")
    }
}

/// Whether a format entry cannot be written as a `{key=value}` token.
fn format_token_unsafe(key: &str, value: &str) -> bool {
    let bad = |text: &str| text.contains(['{', '}', '\n', '\r', '$', '\\']);
    bad(key) || bad(value) || key.contains('=')
}

fn print_paragraph(paragraph: &Paragraph) -> String {
    let mut out = String::new();
    // The attributes come first, style then alignment, and only when they are not the default:
    // an ordinary paragraph is written exactly as before.
    if paragraph.style != ParagraphStyle::Normal {
        out.push_str(&format!("{{style={}}}", paragraph.style.name()));
    }
    if paragraph.align != ParagraphAlign::Left {
        out.push_str(&format!("{{align={}}}", paragraph.align.name()));
    }
    let runs = &paragraph.runs;
    let mut on = [false; 5];
    let mut size: Option<f64> = None;
    let mut color: Option<String> = None;
    let mut highlight: Option<String> = None;
    // Closers first, then size, colour and highlight, then openers, in fixed order: toggles commute, so the
    // reader does not depend on the order.
    let mut switch_to = |out: &mut String, target: &TextRun| {
        for (k, (token, get)) in FLAGS.iter().enumerate() {
            if on[k] && !get(target) {
                out.push_str(token);
                on[k] = false;
            }
        }
        if target.size != size {
            match target.size {
                Some(n) => out.push_str(&format!("{{size={}}}", format_size(n))),
                None => out.push_str("{size}"),
            }
            size = target.size;
        }
        if target.color != color {
            match &target.color {
                Some(value) => out.push_str(&format!("{{color={value}}}")),
                None => out.push_str("{color}"),
            }
            color.clone_from(&target.color);
        }
        if target.highlight != highlight {
            match &target.highlight {
                Some(value) => out.push_str(&format!("{{bg={value}}}")),
                None => out.push_str("{bg}"),
            }
            highlight.clone_from(&target.highlight);
        }
        for (k, (token, get)) in FLAGS.iter().enumerate() {
            if !on[k] && get(target) {
                out.push_str(token);
                on[k] = true;
            }
        }
    };
    for run in runs {
        match run {
            Run::Text(text) => {
                switch_to(&mut out, text);
                out.push_str(&escape_text(&text.text));
            }
            Run::Math(math) => {
                switch_to(&mut out, &TextRun::default());
                if math.disabled {
                    out.push_str("{disabled}");
                }
                for (key, value) in &math.format {
                    // A token cannot hold what would end it: such an entry is not stored.
                    if key.starts_with("format.") && !format_token_unsafe(key, value) {
                        out.push_str(&format!("{{{key}={value}}}"));
                    }
                }
                out.push('$');
                for c in math.text.chars() {
                    if c == '\\' || c == '$' {
                        out.push('\\');
                    }
                    out.push(c);
                }
                out.push('$');
            }
        }
    }
    switch_to(&mut out, &TextRun::default());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> Run {
        Run::Text(TextRun {
            text: t.into(),
            ..Default::default()
        })
    }

    fn math(t: &str) -> Run {
        Run::Math(MathRun {
            text: t.into(),
            ..Default::default()
        })
    }

    /// A paragraph of runs with the default attributes.
    fn para(runs: Vec<Run>) -> Paragraph {
        Paragraph::runs(runs)
    }

    /// A paragraph with a style and an alignment.
    fn styled(runs: Vec<Run>, style: ParagraphStyle, align: ParagraphAlign) -> Paragraph {
        Paragraph { style, align, runs }
    }

    #[test]
    fn colour_and_highlight_are_run_attributes_that_print_back() {
        let linear = "plain {color=#ff0000}red {bg=#ffff80}on yellow{color}{bg} and **bold**";
        let value = RichText::parse(linear);
        let runs: Vec<&TextRun> = value.0[0]
            .runs
            .iter()
            .map(|run| match run {
                Run::Text(text) => text,
                Run::Math(_) => panic!("no math here"),
            })
            .collect();
        assert_eq!(runs[0].color, None);
        assert_eq!(runs[1].color.as_deref(), Some("#ff0000"));
        assert_eq!(runs[1].highlight, None);
        assert_eq!(runs[2].color.as_deref(), Some("#ff0000"));
        assert_eq!(runs[2].highlight.as_deref(), Some("#ffff80"));
        assert_eq!(runs[3].color, None);
        assert_eq!(runs[3].highlight, None);
        assert_eq!(
            value.print(),
            "plain {color=#ff0000}red {bg=#ffff80}on yellow{color}{bg} and **bold**"
        );
        // Upper case is normalised, and a value that is not a colour is literal text.
        assert_eq!(
            RichText::parse("{color=#FF0000}x").print(),
            "{color=#ff0000}x{color}"
        );
        let literal = RichText::parse("{color=red}x {bg=#12}y");
        assert_eq!(literal.0[0].runs.len(), 1);
        assert_eq!(literal.print(), "\\{color=red\\}x \\{bg=#12\\}y");
    }

    #[test]
    fn inline_math_attributes_print_back_before_the_dollar() {
        let linear = "a {disabled}{format.precision=3}$x := 1$ b $y$";
        let value = RichText::parse(linear);
        let runs = &value.0[0].runs;
        let Run::Math(first) = &runs[1] else {
            panic!("math expected")
        };
        assert!(first.disabled);
        assert_eq!(
            first.format.get("format.precision").map(String::as_str),
            Some("3")
        );
        let Run::Math(second) = &runs[3] else {
            panic!("math expected")
        };
        assert!(!second.disabled && second.format.is_empty());
        assert_eq!(value.print(), linear);
        // Tokens that do not lead into a closed `$...$` are literal text.
        assert_eq!(RichText::parse("{disabled} x").print(), "\\{disabled\\} x");
        // A disabled run is not evaluated but keeps its index.
        let evaluated = RichText::parse("{disabled}$a := 1$ $b := 2$").evaluated_math();
        assert_eq!(evaluated.len(), 1);
        assert_eq!(evaluated[0].0, 1);
    }

    #[test]
    fn plain_text_is_itself() {
        let value = RichText::parse("Simply supported beam");
        assert_eq!(value.0, vec![para(vec![text("Simply supported beam")])]);
        assert_eq!(value.print(), "Simply supported beam");
    }

    #[test]
    fn sample_from_the_spike() {
        let linear = "The ratio $a/b$ is **important** for the area A = r^2^ in this example.\n\nSecond paragraph with *italic* and ++underlined++{size=15} text at 15 pt.{size}";
        let value = RichText::parse(linear);
        assert_eq!(value.0.len(), 2);
        assert!(matches!(&value.0[0].runs[1], Run::Math(m) if m.text == "a/b"));
        assert!(matches!(&value.0[0].runs[3], Run::Text(t) if t.bold && t.text == "important"));
        assert!(matches!(&value.0[0].runs[5], Run::Text(t) if t.sup && t.text == "2"));
        assert!(matches!(&value.0[1].runs[4], Run::Text(t) if t.size == Some(15.0)));
        assert_eq!(value.print(), linear);
    }

    #[test]
    fn lenient_reader() {
        // unterminated math, unknown braces, lone backslash are literal
        let value = RichText::parse("cost $5 {x} and {size=abc} and a\\");
        assert_eq!(
            value.0,
            vec![para(vec![text("cost $5 {x} and {size=abc} and a\\")])]
        );
        // escapes
        assert_eq!(
            RichText::parse("a\\*b\\$c").0,
            vec![para(vec![text("a*b$c")])]
        );
        // attribute tokens with an unknown value, or after the first character, are text
        assert_eq!(
            RichText::parse("{style=Chapter} text").0,
            vec![para(vec![text("{style=Chapter} text")])]
        );
        assert_eq!(
            RichText::parse("text {align=center}").0,
            vec![para(vec![text("text {align=center}")])]
        );
        // a repeated token is text; the first one still counts
        let repeated = RichText::parse("{align=center}{align=right}x");
        assert_eq!(repeated.0[0].align, ParagraphAlign::Center);
        assert_eq!(repeated.0[0].runs, vec![text("{align=right}x")]);
    }

    #[test]
    fn paragraph_styles_and_alignment_round_trip() {
        let linear = "{style=heading1}Simply supported beam\n\n{align=center}The ratio $a/b$ is **important** for the area A = r^2^ in this example.\n\n{style=subtitle}{align=right}Second paragraph, right aligned.";
        let value = RichText::parse(linear);
        assert_eq!(value.0.len(), 3);
        assert_eq!(value.0[0].style, ParagraphStyle::Heading1);
        assert_eq!(value.0[0].align, ParagraphAlign::Left);
        assert!(matches!(&value.0[0].runs[0], Run::Text(t) if t.text == "Simply supported beam"));
        assert_eq!(value.0[1].style, ParagraphStyle::Normal);
        assert_eq!(value.0[1].align, ParagraphAlign::Center);
        assert_eq!(value.0[2].style, ParagraphStyle::Subtitle);
        assert_eq!(value.0[2].align, ParagraphAlign::Right);
        // the printer writes style first, then alignment, and omits both when they are
        // the defaults, so an ordinary paragraph keeps the linear text it always had
        assert_eq!(value.print(), linear);
        // every style and alignment survives a round trip
        for style in [
            ParagraphStyle::Normal,
            ParagraphStyle::Title,
            ParagraphStyle::Subtitle,
            ParagraphStyle::Heading1,
            ParagraphStyle::Heading2,
            ParagraphStyle::Heading3,
        ] {
            for align in [
                ParagraphAlign::Left,
                ParagraphAlign::Center,
                ParagraphAlign::Right,
                ParagraphAlign::Justify,
            ] {
                let value = RichText(vec![styled(vec![text("heading text")], style, align)]);
                let printed = value.print();
                assert_eq!(RichText::parse(&printed), value, "{printed:?}");
                assert_eq!(RichText::parse(&printed).print(), printed);
                if style == ParagraphStyle::Normal && align == ParagraphAlign::Left {
                    assert_eq!(printed, "heading text");
                } else {
                    assert!(
                        printed.starts_with('{'),
                        "attributes are written first: {printed:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn an_attribute_only_paragraph_keeps_its_attributes() {
        // An interior empty paragraph is kept, and so are the attributes on it.
        let linear = "first\n\n{class=title}{align=justify}\n\nlast";
        let value = RichText::parse(linear);
        // `{class=...}` is not a token: the paragraph is text, not an empty styled paragraph
        assert_eq!(value.0[1].style, ParagraphStyle::Normal);
        assert_eq!(value.0[1].runs, vec![text("{class=title}{align=justify}")]);
        let linear = "first\n\n{style=title}{align=justify}\n\nlast";
        let value = RichText::parse(linear);
        assert_eq!(value.0.len(), 3);
        assert_eq!(value.0[1].style, ParagraphStyle::Title);
        assert_eq!(value.0[1].align, ParagraphAlign::Justify);
        assert!(value.0[1].runs.is_empty());
        assert_eq!(value.print(), linear);
    }

    #[test]
    fn heading_levels_come_from_the_style() {
        assert_eq!(ParagraphStyle::Heading1.heading_level(), Some(1));
        assert_eq!(ParagraphStyle::Heading2.heading_level(), Some(2));
        assert_eq!(ParagraphStyle::Heading3.heading_level(), Some(3));
        assert_eq!(ParagraphStyle::Title.heading_level(), None);
        assert_eq!(ParagraphStyle::Subtitle.heading_level(), None);
        assert_eq!(ParagraphStyle::Normal.heading_level(), None);
    }

    #[test]
    fn canonical_form_rules() {
        let mut value = RichText(vec![
            para(vec![text("a"), text("b"), text("")]),
            Paragraph::default(),
            para(vec![text("trailing   ")]),
            para(vec![]),
        ]);
        value.normalize();
        assert_eq!(
            value.0,
            vec![
                para(vec![text("ab")]),
                Paragraph::default(),
                para(vec![text("trailing")])
            ]
        );
        assert_eq!(value.print(), "ab\n\n\n\ntrailing");
        assert_eq!(RichText::parse(&value.print()), value);
        let mut empty = RichText(vec![Paragraph::default(), para(vec![text("  ")])]);
        empty.normalize();
        assert_eq!(empty.0, vec![Paragraph::default()]);
        assert_eq!(empty.print(), "");
        // attributes survive normalize, and are dropped with the paragraph they belong to
        let mut attributes = RichText(vec![
            styled(
                vec![text("title")],
                ParagraphStyle::Title,
                ParagraphAlign::Center,
            ),
            styled(vec![], ParagraphStyle::Heading2, ParagraphAlign::Left),
        ]);
        attributes.normalize();
        assert_eq!(attributes.0.len(), 1);
        assert_eq!(attributes.0[0].style, ParagraphStyle::Title);
        assert_eq!(attributes.print(), "{style=title}{align=center}title");
    }

    /// Small deterministic generator (the same idea as the spike's).
    fn generate(seed: u32) -> RichText {
        let mut s = seed.max(1);
        let mut rnd = |n: usize| {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (s as usize) % n
        };
        let words = [
            "alpha",
            "x",
            "a*b",
            "$5",
            "50%",
            "C:\\dir",
            "++",
            "a+b",
            "~",
            "^",
            "[x]",
            "{size}",
            "{",
            "",
            " ",
            "é",
            "∑",
            "**",
            "_",
            "two  spaces",
            "+",
            "{size=9}",
            "{style=title}",
            "{align=center}",
            "}",
        ];
        let sizes = [None, None, Some(9.0), Some(12.0), Some(15.0), Some(10.5)];
        let styles = [
            ParagraphStyle::Normal,
            ParagraphStyle::Normal,
            ParagraphStyle::Title,
            ParagraphStyle::Subtitle,
            ParagraphStyle::Heading1,
            ParagraphStyle::Heading2,
            ParagraphStyle::Heading3,
        ];
        let aligns = [
            ParagraphAlign::Left,
            ParagraphAlign::Left,
            ParagraphAlign::Center,
            ParagraphAlign::Right,
            ParagraphAlign::Justify,
        ];
        let mut paragraphs = Vec::new();
        for _ in 0..(1 + rnd(3)) {
            let mut runs = Vec::new();
            for _ in 0..rnd(5) {
                if rnd(5) == 0 {
                    runs.push(math(["x^2", "a/b", "$", "\\", "f(x):=x+1", "a$b"][rnd(6)]));
                } else {
                    let word = format!("{}{}", words[rnd(words.len())], words[rnd(words.len())]);
                    let sp = rnd(8);
                    runs.push(Run::Text(TextRun {
                        text: word,
                        bold: rnd(3) == 0,
                        italic: rnd(3) == 0,
                        underline: rnd(5) == 0,
                        sub: sp == 0,
                        sup: sp == 1,
                        size: sizes[rnd(sizes.len())],
                        color: [None, None, Some("#ff0000"), Some("#2e3192")][rnd(4)]
                            .map(str::to_owned),
                        highlight: [None, None, None, Some("#ffff80")][rnd(4)].map(str::to_owned),
                    }));
                }
            }
            paragraphs.push(styled(
                runs,
                styles[rnd(styles.len())],
                aligns[rnd(aligns.len())],
            ));
        }
        let mut value = RichText(paragraphs);
        value.normalize();
        value
    }

    #[test]
    fn print_parse_is_the_identity_on_generated_values() {
        let mut dollars = 0;
        let mut stars = 0;
        let mut attrs = 0;
        for seed in 1..=500 {
            let value = generate(seed);
            let linear = value.print();
            assert_eq!(RichText::parse(&linear), value, "seed {seed}: {linear:?}");
            assert_eq!(RichText::parse(&linear).print(), linear, "seed {seed}");
            if linear.contains("\\$") {
                dollars += 1;
            }
            if linear.contains("\\*") {
                stars += 1;
            }
            if linear.starts_with('{') || linear.contains("\n\n{") {
                attrs += 1;
            }
        }
        assert!(dollars > 20 && stars > 20, "{dollars} {stars}");
        assert!(attrs > 20, "{attrs}");
    }

    #[test]
    fn math_resolves_and_the_editor_value_is_printed_by_rust() {
        let mut value = RichText::parse("so $x^2$ and $not math ((");
        value.resolve_math();
        let Run::Math(m) = &value.0[0].runs[1] else {
            panic!("math run")
        };
        assert!(m.statement.is_some());
        // from the editor: a statement in AST form replaces the text
        let statement = parse_statement("a/b").unwrap();
        let json = serde_json::json!([{
            "runs": [
                {"kind": "text", "text": "r = ", "bold": true},
                {"kind": "math", "text": "ignored", "statement": serde_json::to_value(&statement).unwrap()}
            ]
        }]);
        let value = RichText::from_json(json).unwrap();
        assert_eq!(value.print(), "**r = **$a/b$");
        assert!(RichText::from_json(serde_json::json!("nope")).is_err());
        // the editor's paragraphs carry their attributes, which the printer writes first
        let json = serde_json::json!([{
            "style": "heading2",
            "align": "justify",
            "runs": [{"kind": "text", "text": "chapter"}]
        }]);
        let value = RichText::from_json(json).unwrap();
        assert_eq!(value.print(), "{style=heading2}{align=justify}chapter");
    }

    #[test]
    fn serde_shape_is_paragraphs_of_flat_runs() {
        let value = RichText::parse("a **b**");
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(
            json,
            serde_json::json!([{
                "runs": [
                    {"kind": "text", "text": "a "},
                    {"kind": "text", "text": "b", "bold": true}
                ]
            }])
        );
        // default attributes are left out; a styled paragraph carries them
        let styled_value = RichText::parse("{style=heading1}{align=center}Heading");
        assert_eq!(
            serde_json::to_value(&styled_value).unwrap(),
            serde_json::json!([{
                "style": "heading1",
                "align": "center",
                "runs": [{"kind": "text", "text": "Heading"}]
            }])
        );
    }
}
