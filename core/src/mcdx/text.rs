//! The text of a `.mcdx` text region: a WPF `FlowDocument` package to the worksheet's rich text.

use crate::richtext::{MathRun, Paragraph, ParagraphAlign, RichText, Run, TextRun};
use roxmltree::Node;

/// The size of text without an explicit size: the model's default.
const DEFAULT_SIZE_PT: f64 = 12.0;
/// WPF device-independent pixels (1/96 inch) to points.
const PX_TO_PT: f64 = 0.75;

#[derive(Debug, Clone, Default)]
struct Fmt {
    bold: bool,
    italic: bool,
    underline: bool,
    sub: bool,
    sup: bool,
    size_px: Option<f64>,
    /// `Foreground` as `#rrggbb`; black is the default and no colour.
    color: Option<String>,
    /// `Background` of a run as `#rrggbb`; transparent is none.
    highlight: Option<String>,
}

impl Fmt {
    /// The attributes of one element override what is inherited.
    fn with(&self, node: Node) -> Fmt {
        let mut f = self.clone();
        if let Some(w) = node.attribute("FontWeight") {
            f.bold = w.eq_ignore_ascii_case("bold") || w.eq_ignore_ascii_case("semibold");
        }
        if let Some(s) = node.attribute("FontStyle") {
            f.italic = s.eq_ignore_ascii_case("italic") || s.eq_ignore_ascii_case("oblique");
        }
        if let Some(d) = node.attribute("TextDecorations") {
            f.underline = d.to_ascii_lowercase().contains("underline");
        }
        if let Some(b) = node.attribute("BaselineAlignment") {
            f.sub = b.eq_ignore_ascii_case("subscript");
            f.sup = b.eq_ignore_ascii_case("superscript");
        }
        if let Some(size) = node
            .attribute("FontSize")
            .and_then(|v| v.parse::<f64>().ok())
        {
            f.size_px = Some(size);
        }
        // WPF writes colours as `#AARRGGBB`; opaque black is the default text colour and
        // a transparent background is none, so a plain run carries neither.
        if let Some(c) = node.attribute("Foreground") {
            f.color = super::opaque_color(c).filter(|c| c != "#000000");
        }
        if let Some(c) = node.attribute("Background") {
            f.highlight = super::opaque_color(c);
        }
        f
    }

    fn run(&self, text: String) -> Run {
        let size = self
            .size_px
            .map(|px| (px * PX_TO_PT * 10.0).round() / 10.0)
            .filter(|pt| (pt - DEFAULT_SIZE_PT).abs() > 0.05 && *pt > 0.0);
        Run::Text(TextRun {
            text,
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            sub: self.sub,
            sup: self.sup,
            size,
            color: self.color.clone(),
            highlight: self.highlight.clone(),
        })
    }
}

/// What the converter found besides text.
#[derive(Debug, Default)]
pub struct TextOutcome {
    /// Inline math that could not be translated: (index among the inline regions, reason).
    pub math_issues: Vec<(usize, String)>,
    /// Inline math was present but could not be placed.
    pub math_not_placed: bool,
    /// An image inside the text was dropped.
    pub picture_dropped: bool,
    /// Formatting beyond the model was seen (font family, alignment, ...).
    pub style_dropped: bool,
    /// The background of the whole text region: the `Background` of the `FlowDocument` when it is
    /// not transparent. Each run keeps its own background as a highlight.
    pub background: Option<String>,
}

/// The alignment of a paragraph: WPF's
/// `TextAlignment` attribute. An unknown value is not an alignment (the paragraph is left, and the
/// dropped-style note names it).
fn alignment(node: Node) -> Option<ParagraphAlign> {
    match node.attribute("TextAlignment")? {
        "Left" => Some(ParagraphAlign::Left),
        "Center" => Some(ParagraphAlign::Center),
        "Right" => Some(ParagraphAlign::Right),
        "Justify" => Some(ParagraphAlign::Justify),
        _ => None,
    }
}

/// A `Run` of exactly one space: the shape of an inline math slot.
fn is_space_run(node: Node) -> bool {
    node.is_element()
        && node.tag_name().name() == "Run"
        && node.text() == Some(" ")
        && node.children().count() == 1
}

/// The slots of the inline math regions: the space runs without attributes; when there
/// are fewer of them than regions, the earliest space runs with only `style` / `xml:lang` make
/// up the difference. `None` when the count cannot be matched.
fn placeholder_runs<'a, 'i>(
    doc: &'a roxmltree::Document<'i>,
    wanted: usize,
) -> Option<std::collections::HashSet<roxmltree::NodeId>> {
    let mut plain = Vec::new();
    let mut weak = Vec::new();
    for node in doc.descendants().filter(|n| is_space_run(*n)) {
        if node.attributes().len() == 0 {
            plain.push(node.id());
        } else if node
            .attributes()
            .all(|a| a.name() == "style" || a.name() == "lang")
        {
            weak.push(node.id());
        }
    }
    // Document order is the order of `descendants`, so `plain` and `weak` are in order too.
    if plain.len() == wanted {
        return Some(plain.into_iter().collect());
    }
    if plain.len() < wanted && wanted <= plain.len() + weak.len() {
        let mut slots: std::collections::HashSet<_> = plain.into_iter().collect();
        slots.extend(weak.into_iter().take(wanted - slots.len()));
        return Some(slots);
    }
    None
}

/// Converts `Xaml/Document.xaml`. `inline_math` holds the translated inline math regions in text
/// order (`Err` for one that could not be translated).
pub fn convert(xaml: &str, inline_math: &[Result<String, String>]) -> (RichText, TextOutcome) {
    let mut outcome = TextOutcome::default();
    let xaml = xaml.trim_start_matches('\u{feff}');
    let Ok(doc) = roxmltree::Document::parse(xaml) else {
        return (RichText::default(), outcome);
    };
    let root = doc.root_element();
    let slots = if inline_math.is_empty() {
        None
    } else {
        placeholder_runs(&doc, inline_math.len())
    };
    if !inline_math.is_empty() && slots.is_none() {
        outcome.math_not_placed = true;
    }
    let mut state = State {
        paragraphs: Vec::new(),
        math_index: 0,
        inline_math,
        slots: slots.unwrap_or_default(),
        outcome,
    };
    let mut base = Fmt::default().with(root);
    // The background of the document is the region's; only a run's own `Background` is a highlight.
    state.outcome.background = base.highlight.take();
    state.blocks(root, &base, false);
    let mut text = RichText(state.paragraphs);
    text.normalize();
    (text, state.outcome)
}

struct State<'a> {
    paragraphs: Vec<Paragraph>,
    math_index: usize,
    inline_math: &'a [Result<String, String>],
    /// The runs that hold an inline math region; empty when none is placed.
    slots: std::collections::HashSet<roxmltree::NodeId>,
    outcome: TextOutcome,
}

impl State<'_> {
    fn blocks(&mut self, node: Node, fmt: &Fmt, bullet: bool) {
        let mut first_in_item = bullet;
        for child in node.children().filter(|c| c.is_element()) {
            match child.tag_name().name() {
                "Paragraph" => {
                    let f = fmt.with(child);
                    let mut runs = Vec::new();
                    if first_in_item {
                        runs.push(f.run("• ".into()));
                        first_in_item = false;
                    }
                    self.inlines(child, &f, &mut runs);
                    // The paragraph alignment is part of our model; a named style is not,
                    // so the paragraph is Normal.
                    self.paragraphs.push(Paragraph {
                        align: alignment(child).unwrap_or_default(),
                        runs,
                        ..Paragraph::default()
                    });
                    self.note_style(child);
                }
                "Section" => self.blocks(child, &fmt.with(child), false),
                "List" => self.blocks(child, &fmt.with(child), false),
                "ListItem" => self.blocks(child, &fmt.with(child), true),
                _ => {}
            }
        }
    }

    fn note_style(&mut self, node: Node) {
        // A recognised alignment is imported, so it is not a dropped style.
        let imported_alignment = alignment(node).is_some();
        for a in node.attributes() {
            if matches!(a.name(), "TextAlignment" | "TextIndent" | "FontFamily")
                && !(a.name() == "TextAlignment" && imported_alignment)
                && a.value() != "Left"
            {
                self.outcome.style_dropped = true;
            }
        }
    }

    fn inlines(&mut self, node: Node, fmt: &Fmt, runs: &mut Vec<Run>) {
        for child in node.children() {
            // WPF writes a paragraph's text inside a `Run`, but it also lets the text sit in the
            // paragraph itself, which is how the reference application stores the text of a header or footer field
            //: a bare text node is a run of the inherited format. A node that holds only
            // spaces and line breaks is the indentation of a pretty-printed part, not text, so it
            // is dropped (the reference application itself writes every intended space inside a `Run`).
            if child.is_text() {
                let text = child.text().unwrap_or_default();
                if !text.trim().is_empty() {
                    runs.push(fmt.run(text.to_owned()));
                }
                continue;
            }
            if !child.is_element() {
                continue;
            }
            match child.tag_name().name() {
                "Run" => {
                    if self.slots.contains(&child.id()) {
                        let index = self.math_index;
                        self.math_index += 1;
                        match &self.inline_math[index] {
                            Ok(text) => runs.push(Run::Math(MathRun {
                                text: text.clone(),
                                ..Default::default()
                            })),
                            Err(reason) => {
                                self.outcome.math_issues.push((index, reason.clone()));
                                runs.push(fmt.run(" ".into()));
                            }
                        }
                        continue;
                    }
                    let f = fmt.with(child);
                    self.note_style(child);
                    let text: String = child.children().filter_map(|c| c.text()).collect();
                    runs.push(f.run(text));
                }
                "Span" | "Bold" | "Italic" | "Underline" => {
                    let mut f = fmt.with(child);
                    match child.tag_name().name() {
                        "Bold" => f.bold = true,
                        "Italic" => f.italic = true,
                        "Underline" => f.underline = true,
                        _ => {}
                    }
                    self.note_style(child);
                    self.inlines(child, &f, runs);
                }
                "LineBreak" => runs.push(fmt.run(" ".into())),
                "InlineUIContainer" => self.outcome.picture_dropped = true,
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str =
        r#"<Section xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">"#;

    fn convert_xaml(body: &str) -> (RichText, TextOutcome) {
        convert(&format!("{HEAD}{body}</Section>"), &[])
    }

    /// the paragraph alignment of a reference application text region is ours.
    #[test]
    fn paragraph_alignment_is_imported() {
        let (text, outcome) = convert_xaml(
            r#"<Paragraph TextAlignment="Center"><Run>Centred</Run></Paragraph>
               <Paragraph TextAlignment="Right"><Run>Right</Run></Paragraph>
               <Paragraph TextAlignment="Justify"><Run>Justified</Run></Paragraph>
               <Paragraph TextAlignment="Left"><Run>Left</Run></Paragraph>
               <Paragraph><Run>Default</Run></Paragraph>"#,
        );
        assert_eq!(
            text.0.iter().map(|p| p.align).collect::<Vec<_>>(),
            vec![
                ParagraphAlign::Center,
                ParagraphAlign::Right,
                ParagraphAlign::Justify,
                ParagraphAlign::Left,
                ParagraphAlign::Left
            ]
        );
        assert_eq!(
            text.print(),
            "{align=center}Centred\n\n{align=right}Right\n\n{align=justify}Justified\n\nLeft\n\nDefault"
        );
        // A recognised alignment is not a dropped style.
        assert!(!outcome.style_dropped);
        // A named style is not imported: the runs keep their formatting.
        let (text, outcome) = convert_xaml(
            r#"<Paragraph TextAlignment="Center"><Run FontWeight="Bold">Bold</Run></Paragraph>"#,
        );
        assert_eq!(text.0[0].align, ParagraphAlign::Center);
        assert_eq!(text.0[0].style, crate::richtext::ParagraphStyle::Normal);
        assert!(matches!(&text.0[0].runs[0], Run::Text(run) if run.bold && run.text == "Bold"));
        assert!(!outcome.style_dropped);
    }

    /// WPF lets a paragraph hold its text without a `Run`, and the reference application writes the text of a header or
    /// footer field that way: the bare text is a run of
    /// the inherited format, not a lost paragraph.
    #[test]
    fn a_paragraph_without_runs_keeps_its_text() {
        let (text, outcome) = convert_xaml(
            "<Paragraph>Issued by A. Drius</Paragraph>\n<Paragraph>\n  <Bold>bold</Bold> plain\n</Paragraph>",
        );
        assert_eq!(text.print(), "Issued by A. Drius\n\n**bold** plain");
        assert!(!outcome.style_dropped);
    }

    /// `Foreground` and `Background` of a run are its colour and highlight, the
    /// background of the document is the region's, and the defaults (opaque black, transparent) are none.
    #[test]
    fn colours_and_backgrounds_are_imported() {
        let xaml = format!(
            r##"{HEAD}<Paragraph><Run Foreground="#FF2E3192">blue </Run><Run Background="#FFFFFF80">hi </Run><Run Foreground="#FF000000" Background="#00FFFFFF">plain</Run></Paragraph></Section>"##
        );
        let (text, outcome) = convert(&xaml, &[]);
        assert_eq!(
            text.print(),
            "{color=#2e3192}blue {color}{bg=#ffff80}hi {bg}plain"
        );
        assert!(!outcome.style_dropped);
        assert_eq!(outcome.background, None);
        // The document's own background is the region's fill, not a highlight of every run.
        let root = r##"<Section xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Foreground="#FFFF0000" Background="#FFFDFDD5"><Paragraph><Run>x</Run></Paragraph></Section>"##;
        let (text, outcome) = convert(root, &[]);
        assert_eq!(outcome.background.as_deref(), Some("#fdfdd5"));
        assert_eq!(text.print(), "{color=#ff0000}x{color}");
    }

    /// An alignment value we do not know is left, and the note still names it as a dropped style.
    #[test]
    fn an_unknown_alignment_falls_back_to_left_and_is_reported() {
        let (text, outcome) =
            convert_xaml(r#"<Paragraph TextAlignment="Nonsense"><Run>x</Run></Paragraph>"#);
        assert_eq!(text.0[0].align, ParagraphAlign::Left);
        assert!(outcome.style_dropped);
    }
}
