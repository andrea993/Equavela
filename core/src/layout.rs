//! Page layout of a worksheet document: page size, margins and the regions
//! that carry no calculation (text). All lengths are in points (1/72 in).
//!
//! The YAML shape:
//!
//! ```yaml
//! page:
//!   size: A4 # or Letter, A3, A5, Legal, or [width, height] in points
//!   orientation: portrait # optional, `landscape` swaps width and height
//!   margins: {top: 72, right: 54, bottom: 72, left: 54} # or one number for all four
//! page-breaks: # optional, manual page ends
//!   - {page: 1, y: 300}
//! ```

use serde::{Deserialize, Serialize};

/// Page margins in points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Margins {
    pub fn uniform(value: f64) -> Margins {
        Margins {
            top: value,
            right: value,
            bottom: value,
            left: value,
        }
    }
}

/// A header or a footer line of the page:
/// three slots drawn at the left edge, the centre and the
/// right edge of the printable width, each one line of text. An empty slot draws nothing; the
/// three tokens `{page}`, `{date}` and `{file}` are replaced when the page is drawn, and the file
/// stores the text as it was typed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageLine {
    #[serde(default)]
    pub left: String,
    #[serde(default)]
    pub center: String,
    #[serde(default)]
    pub right: String,
}

impl PageLine {
    /// Whether the line draws nothing at all.
    pub fn is_empty(&self) -> bool {
        self.left.is_empty() && self.center.is_empty() && self.right.is_empty()
    }

    /// The three slots in the order they are drawn and stored.
    pub fn slots(&self) -> [&str; 3] {
        [&self.left, &self.center, &self.right]
    }

    /// Checks that the line can be drawn and stored: each slot is one
    /// line of text, so a line break or a control character is refused. Tokens are ordinary text
    /// and are not checked here.
    pub fn validate(&self) -> Result<(), String> {
        for slot in self.slots() {
            if slot.chars().any(|c| c.is_control()) {
                return Err("a header or footer slot is one line of text and holds no tab, line break or other control character".into());
            }
        }
        Ok(())
    }
}

/// Page size and margins of a document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSetup {
    /// `A4`, `Letter`, ... or `custom`.
    pub size: String,
    /// Width and height in points after the orientation is applied.
    pub width: f64,
    pub height: f64,
    pub margins: Margins,
    /// The line drawn in the top margin.
    #[serde(default)]
    pub header: PageLine,
    /// The line drawn in the bottom margin.
    #[serde(default)]
    pub footer: PageLine,
}

impl Default for PageSetup {
    fn default() -> PageSetup {
        PageSetup::named("A4", false).expect("A4 is a known size")
    }
}

/// Default margins: 1 in at top and bottom, 0.75 in at the sides.
pub const DEFAULT_MARGINS: Margins = Margins {
    top: 72.0,
    right: 54.0,
    bottom: 72.0,
    left: 54.0,
};

impl PageSetup {
    /// A named standard size, optionally in landscape orientation.
    pub fn named(name: &str, landscape: bool) -> Option<PageSetup> {
        let (canonical, width, height) = match name.to_ascii_lowercase().as_str() {
            "a3" => ("A3", 841.89, 1190.55),
            "a4" => ("A4", 595.28, 841.89),
            "a5" => ("A5", 419.53, 595.28),
            "letter" => ("Letter", 612.0, 792.0),
            "legal" => ("Legal", 612.0, 1008.0),
            _ => return None,
        };
        let (width, height) = if landscape {
            (height, width)
        } else {
            (width, height)
        };
        Some(PageSetup {
            size: canonical.to_owned(),
            width,
            height,
            margins: DEFAULT_MARGINS,
            header: PageLine::default(),
            footer: PageLine::default(),
        })
    }

    /// Height of the area between the top and bottom margins.
    pub fn content_height(&self) -> f64 {
        self.height - self.margins.top - self.margins.bottom
    }

    /// Width of the area between the left and right margins.
    pub fn content_width(&self) -> f64 {
        self.width - self.margins.left - self.margins.right
    }

    /// Checks a page setup: every length finite, the page positive, the margins
    /// non-negative and together leaving room for content. The loader and the page-setup dialog
    /// share this rule, so a file and the dialog accept and refuse the same setups.
    pub fn validate(&self) -> Result<(), String> {
        let lengths = [
            self.width,
            self.height,
            self.margins.top,
            self.margins.right,
            self.margins.bottom,
            self.margins.left,
        ];
        if lengths.iter().any(|value| !value.is_finite()) {
            return Err("page lengths must be finite numbers".into());
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err("page size values must be positive numbers".into());
        }
        if self
            .margins
            .top
            .min(self.margins.right)
            .min(self.margins.bottom)
            .min(self.margins.left)
            < 0.0
        {
            return Err("margins must be non-negative numbers".into());
        }
        if self.margins.left + self.margins.right >= self.width
            || self.margins.top + self.margins.bottom >= self.height
        {
            return Err("the margins leave no room for content".into());
        }
        // The header and the footer are one line of text each.
        self.header.validate()?;
        self.footer.validate()?;
        Ok(())
    }

    /// This setup with its size name made to agree with its dimensions: a standard name
    /// whose width and height are not exactly that size in one of the two orientations becomes
    /// `custom`, so what the writer stores (the name with `orientation`, or `[width, height]`)
    /// reads back as the same setup. A `custom` size stays custom, whatever its dimensions.
    pub fn canonical_size(mut self) -> PageSetup {
        let standard = PageSetup::named(&self.size, false).is_some_and(|portrait| {
            (self.width, self.height) == (portrait.width, portrait.height)
                || (self.width, self.height) == (portrait.height, portrait.width)
        });
        if !standard {
            self.size = "custom".into();
        }
        self
    }
}

/// A part of a vertical range of the sheet that lies inside the printable area of one page.
/// An area band, and any other range that is longer than
/// what is left of a page, is a list of these: one per page it reaches.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FlowSpan {
    /// The 1-based page the part is on.
    pub page: u32,
    /// The top of the part, in points inside its page: the stored `y` on the page the range starts
    /// on, the top margin on every other one.
    pub top: f64,
    /// The length of the part in points.
    pub height: f64,
}

impl FlowSpan {
    /// Where the part ends, in points inside its page.
    pub fn bottom(&self) -> f64 {
        self.top + self.height
    }
}

impl PageSetup {
    /// The top of the printable area: where a range that leaves a page continues.
    pub fn content_top(&self) -> f64 {
        self.margins.top
    }

    /// The bottom of the printable area: where a range leaves its page.
    pub fn content_bottom(&self) -> f64 {
        self.height - self.margins.bottom
    }
}

/// The flow offset of a point of the sheet: `y` of `page` counts from the top margin of the first
/// page, so that the top margin of page `page + 1` follows the bottom margin of page `page`.
pub fn flow_of(setup: &PageSetup, page: u32, y: f64) -> f64 {
    let step = setup.content_height();
    (f64::from(page.max(1)) - 1.0) * step + (y - setup.content_top())
}

/// The point of the sheet `offset` points into the flow, the inverse of [`flow_of`]: the page and
/// the `y` inside it. `y` is not snapped; the caller snaps it like any other position.
pub fn place_of(setup: &PageSetup, offset: f64) -> (u32, f64) {
    let step = setup.content_height();
    if !offset.is_finite() || step <= 0.0 {
        return (1, setup.content_top());
    }
    let page = (offset / step).floor().max(0.0) as u32 + 1;
    let y = setup.content_top() + offset - f64::from(page - 1) * step;
    (page, y)
}

/// The parts of the vertical range of `height` points that starts at `y` of `page` that lie inside
/// the printable area of a page: the first part runs from
/// `y` down to the bottom margin, every later part from the top margin to the bottom margin, and the
/// last one to the end of the range. A range that fits on its page is one part, so this is the
/// single-page band of when nothing crosses a page.
pub fn flow_spans(setup: &PageSetup, page: u32, y: f64, height: f64) -> Vec<FlowSpan> {
    /// The most parts a range is split into: a file may hold any finite height, and a corrupt one
    /// must not make this loop for ever. 10 000 pages are far beyond any real worksheet.
    const MAX_SPANS: usize = 10_000;
    let top = setup.content_top();
    let bottom = setup.content_bottom();
    let step = bottom - top;
    let mut spans = Vec::new();
    if step <= 0.0 || !y.is_finite() || !height.is_finite() || height <= 0.0 {
        return spans;
    }
    let mut page = page.max(1);
    let mut span_top = y;
    let mut left = height;
    // One part per page: a range of any length ends, and each page takes at most its printable
    // height, so the loop is bounded by the length of the range (and by the guard above).
    while left > 1e-9 && spans.len() < MAX_SPANS {
        let room = bottom - span_top;
        if room <= 1e-9 {
            // The range has left the printable area of this page: it continues at the top margin of
            // the next one.
            page += 1;
            span_top = top;
            continue;
        }
        let take = room.min(left);
        spans.push(FlowSpan {
            page,
            top: span_top,
            height: take,
        });
        left -= take;
        page += 1;
        span_top = top;
    }
    spans
}

/// The `page:` mapping as written in a worksheet file.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawPage {
    #[serde(default)]
    size: Option<serde_json::Value>,
    #[serde(default)]
    orientation: Option<String>,
    #[serde(default)]
    margins: Option<serde_json::Value>,
    #[serde(default)]
    header: Option<serde_json::Value>,
    #[serde(default)]
    footer: Option<serde_json::Value>,
}

impl RawPage {
    /// Converts the raw mapping, reporting the first problem as a message.
    pub fn into_setup(self) -> Result<PageSetup, String> {
        let landscape = match self.orientation.as_deref() {
            None | Some("portrait") => false,
            Some("landscape") => true,
            Some(other) => {
                return Err(format!(
                    "page orientation must be `portrait` or `landscape`, found `{other}`"
                ))
            }
        };
        let mut setup = match &self.size {
            None => PageSetup::named("A4", landscape).expect("A4 is known"),
            Some(serde_json::Value::String(name)) => PageSetup::named(name, landscape)
                .ok_or_else(|| format!("unknown page size `{name}`"))?,
            Some(serde_json::Value::Array(items)) if items.len() == 2 => {
                let number = |value: &serde_json::Value| {
                    value
                        .as_f64()
                        .filter(|n| n.is_finite() && *n > 0.0)
                        .ok_or_else(|| "page size values must be positive numbers".to_owned())
                };
                let (width, height) = (number(&items[0])?, number(&items[1])?);
                let (width, height) = if landscape {
                    (height, width)
                } else {
                    (width, height)
                };
                PageSetup {
                    size: "custom".into(),
                    width,
                    height,
                    margins: DEFAULT_MARGINS,
                    header: PageLine::default(),
                    footer: PageLine::default(),
                }
            }
            Some(_) => return Err("page size must be a name or [width, height]".into()),
        };
        if let Some(margins) = self.margins {
            setup.margins = match margins {
                serde_json::Value::Number(n) => Margins::uniform(
                    n.as_f64()
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .ok_or("margins must be non-negative numbers")?,
                ),
                other => {
                    let margins: Margins = serde_json::from_value(other)
                        .map_err(|e| format!("margins need top, right, bottom, left: {e}"))?;
                    margins
                }
            };
        }
        setup.header = page_line(self.header, "header")?;
        setup.footer = page_line(self.footer, "footer")?;
        setup.validate()?;
        Ok(setup)
    }
}

/// A manual page break: the page ends at
/// `y` points on purpose, so the worksheet continues on the next page whether or not the
/// content of the page reached the bottom margin.
///
/// A break belongs to the document, not to a region: it has no id and no selection. `y` is where
/// the author put the break (the caret line of `Add Page Break`), not a drawn coordinate: the mark
/// is drawn at the bottom of the page the break ends, and `y` records how much space the break
/// made free, so that removing it can move the content back.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PageBreak {
    /// The 1-based page the break ends.
    pub page: u32,
    /// Where the page ends, in points inside that page.
    pub y: f64,
}

impl PageBreak {
    /// Checks one break against the page setup: a page that exists (1 or more) and a finite `y`
    /// inside the page.
    pub fn validate(&self, setup: &PageSetup) -> Result<(), String> {
        if self.page == 0 {
            return Err("a page break needs a page of 1 or more".into());
        }
        if !self.y.is_finite() || self.y < 0.0 || self.y > setup.height {
            return Err(format!(
                "the y of the page break on page {} must be a number of points between 0 and the page height ({})",
                self.page, setup.height
            ));
        }
        Ok(())
    }
}

/// A presentation-only line break in a math region:
/// the continuation line starts before the node at `path` (a path of child indices in
/// the statement's canonical AST). `offset` is set only for a string literal, where it is the
/// character offset inside the string's value; the break is visual and never changes the value.
///
/// The break list belongs to the document, keyed by math region id, so it is not part of the
/// analysis, the dependency graph or the generated code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct MathBreak {
    /// Child-index path of the node the continuation line starts with; empty is the statement
    /// itself and is not a valid break.
    pub path: Vec<usize>,
    /// Character offset inside a string literal (UTF-16 code units, the editor's convention).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

/// Checks a whole break list: every break is valid and no page has two of them. The reader
/// and the edit commands keep the list sorted by page, so a document in memory always holds it in
/// that order.
pub fn validate_page_breaks(breaks: &[PageBreak], setup: &PageSetup) -> Result<(), String> {
    for (index, entry) in breaks.iter().enumerate() {
        entry.validate(setup)?;
        if index > 0 && breaks[index - 1].page >= entry.page {
            return Err(if breaks[index - 1].page == entry.page {
                format!("page {} has two page breaks", entry.page)
            } else {
                "page breaks are not sorted by page".into()
            });
        }
    }
    Ok(())
}

/// A `header:` or `footer:` value of the `page:` mapping as a [`PageLine`]: a mapping
/// `{left, center, right}` whose slots may be left out, or nothing at all.
fn page_line(value: Option<serde_json::Value>, what: &str) -> Result<PageLine, String> {
    let Some(value) = value else {
        return Ok(PageLine::default());
    };
    let line: PageLine = serde_json::from_value(value).map_err(|_| {
        format!("`{what}` must be a mapping with `left`, `center` and `right` text")
    })?;
    line.validate()
        .map_err(|message| format!("`{what}`: {message}"))?;
    Ok(line)
}

/// A text region: shown on the page, not calculated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    /// Width in points; `None` lets the region take the rest of the content width.
    #[serde(default)]
    pub width: Option<f64>,
    /// A text block (Ctrl+Shift+T): always the printable width, from the left margin to the
    /// right margin, whatever the page setup. `x` and `width` are then ignored.
    #[serde(default)]
    pub full_width: bool,
    /// The background of the whole region as `#rrggbb` (lower case); `None` is no fill.
    #[serde(default)]
    pub background: Option<String>,
    /// The spelling language of this region as a dictionary id (`en_US`, `it_IT`); `None`
    /// follows the worksheet.
    #[serde(default)]
    pub language: Option<String>,
    pub text: String,
}

fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> Result<PageSetup, String> {
        let raw: RawPage = serde_saphyr::from_str(yaml).expect("yaml");
        raw.into_setup()
    }

    #[test]
    fn default_is_a4_portrait() {
        let setup = PageSetup::default();
        assert_eq!(setup.size, "A4");
        assert!(setup.height > setup.width);
        assert!((setup.content_height() - (841.89 - 144.0)).abs() < 1e-9);
    }

    #[test]
    fn letter_landscape_with_uniform_margins() {
        let setup = parse("size: Letter\norientation: landscape\nmargins: 36\n").unwrap();
        assert_eq!((setup.width, setup.height), (792.0, 612.0));
        assert_eq!(setup.margins, Margins::uniform(36.0));
    }

    #[test]
    fn custom_size_and_explicit_margins() {
        let setup =
            parse("size: [300, 400]\nmargins: {top: 1, right: 2, bottom: 3, left: 4}\n").unwrap();
        assert_eq!(setup.size, "custom");
        assert_eq!(setup.margins.left, 4.0);
    }

    #[test]
    fn rejects_unknown_size_and_huge_margins() {
        assert!(parse("size: Tabloid-ish\n")
            .unwrap_err()
            .contains("unknown"));
        assert!(parse("margins: 400\n").unwrap_err().contains("no room"));
    }

    #[test]
    fn validate_accepts_the_limits_and_names_the_problem() {
        let mut setup = PageSetup::default();
        assert_eq!(setup.validate(), Ok(()));
        // A margin of 0 is allowed, and so is a page of any positive size.
        setup.margins = Margins::uniform(0.0);
        assert_eq!(setup.validate(), Ok(()));
        setup.margins = Margins {
            top: 0.0,
            right: 0.0,
            bottom: 0.0,
            left: 0.0,
        };
        assert_eq!(setup.validate(), Ok(()));
        setup.margins = DEFAULT_MARGINS;
        setup.width = 0.0;
        assert!(setup.validate().unwrap_err().contains("positive"));
        setup.width = f64::NAN;
        assert!(setup.validate().unwrap_err().contains("finite"));
        setup.width = 595.28;
        setup.margins.left = -1.0;
        assert!(setup.validate().unwrap_err().contains("non-negative"));
        setup.margins.left = 560.0;
        assert!(setup.validate().unwrap_err().contains("no room"));
    }

    #[test]
    fn header_and_footer_are_read_slot_by_slot() {
        let setup = parse(
            "header: {center: Beam analysis, right: \"Page {page}\"}\nfooter: {left: \"{file}\"}\n",
        )
        .unwrap();
        assert_eq!(setup.header.center, "Beam analysis");
        // the token is stored as it was typed, not expanded.
        assert_eq!(setup.header.right, "Page {page}");
        assert!(setup.header.left.is_empty());
        assert_eq!(setup.footer.left, "{file}");
        assert!(setup.footer.center.is_empty() && setup.footer.right.is_empty());
        assert!(!setup.header.is_empty() && !setup.footer.is_empty());
        // A page without the two keys has neither line.
        let plain = parse("size: A4\n").unwrap();
        assert!(plain.header.is_empty() && plain.footer.is_empty());
    }

    #[test]
    fn a_page_line_is_one_line_of_text_and_a_mapping() {
        // a line break or a control character cannot be drawn on one line.
        let broken = parse("header: {center: \"one\\ntwo\"}\n").unwrap_err();
        assert!(broken.contains("header"), "{broken}");
        assert!(broken.contains("one line"), "{broken}");
        let tabbed = parse("footer: {left: \"a\\tb\"}\n").unwrap_err();
        assert!(tabbed.contains("one line"), "{tabbed}");
        // A bare string is not a line with slots.
        let bare = parse("header: Just a title\n").unwrap_err();
        assert!(bare.contains("mapping"), "{bare}");
    }

    #[test]
    fn validate_refuses_a_control_character_in_a_slot() {
        let mut setup = PageSetup::default();
        assert_eq!(setup.validate(), Ok(()));
        setup.footer.right = "Page\t1".into();
        assert!(setup.validate().unwrap_err().contains("one line of text"));
        setup.footer.right = "Page {page}".into();
        assert_eq!(setup.validate(), Ok(()));
    }

    #[test]
    fn a_named_size_that_does_not_match_its_dimensions_is_custom() {
        let a4 = PageSetup::named("A4", false).unwrap();
        assert_eq!(a4.clone().canonical_size(), a4);
        // Landscape A4 is still A4: the orientation is the order of the two dimensions.
        let landscape = PageSetup::named("A4", true).unwrap();
        assert_eq!(landscape.clone().canonical_size().size, "A4");
        // A named size whose dimensions were edited is stored as a custom size.
        let edited = PageSetup {
            width: 600.0,
            ..a4.clone()
        };
        assert_eq!(edited.canonical_size().size, "custom");
        // A custom size stays custom even when it matches a standard one.
        let custom = PageSetup {
            size: "custom".into(),
            ..a4
        };
        assert_eq!(custom.clone().canonical_size(), custom);
    }

    /// A4 (841.89 pt) with the default 72 pt top and bottom margins: a printable height of 697.89 pt,
    /// so the flow's steps are 697.89 and the bottom margin of a page is at 769.89.
    fn a4() -> PageSetup {
        PageSetup::default()
    }

    #[test]
    fn a_range_that_fits_is_one_span_of_one_page() {
        let setup = a4();
        // The band of : it starts at 100 and ends at 220, well inside the printable area.
        let spans = flow_spans(&setup, 1, 100.0, 120.0);
        assert_eq!(
            spans,
            vec![FlowSpan {
                page: 1,
                top: 100.0,
                height: 120.0
            }]
        );
        assert_eq!(spans[0].bottom(), 220.0);
        // A range that ends exactly on the bottom margin does not continue anywhere.
        let touches = flow_spans(&setup, 1, 700.0, 69.89);
        assert_eq!(touches.len(), 1);
        assert!((touches[0].bottom() - setup.content_bottom()).abs() < 1e-9);
    }

    #[test]
    fn a_range_longer_than_the_page_continues_at_the_top_margin_of_the_next_one() {
        let setup = a4();
        // 100 to 769.89 on page 1 (669.89 pt) and 72 to 102.11 on page 2, for 700 pt in all.
        let spans = flow_spans(&setup, 1, 100.0, 700.0);
        assert_eq!(spans.len(), 2);
        assert_eq!((spans[0].page, spans[0].top), (1, 100.0));
        assert!((spans[0].height - 669.89).abs() < 1e-6);
        assert_eq!((spans[1].page, spans[1].top), (2, 72.0));
        assert!((spans[1].height - 30.11).abs() < 1e-6);
        // The lengths add up to the whole range, whatever it starts at.
        for start in [0.0, 72.0, 500.0] {
            let total: f64 = flow_spans(&setup, 1, start, 2_000.0)
                .iter()
                .map(|span| span.height)
                .sum();
            assert!((total - 2_000.0).abs() < 1e-6, "start {start}");
        }
    }

    #[test]
    fn a_range_can_cross_two_page_breaks() {
        let setup = a4();
        // Three pages: 100 to 769.89 (669.89 pt), a whole printable page (697.89 pt), and the rest
        // (32.22 pt) at the top of the third.
        let spans = flow_spans(&setup, 1, 100.0, 1_400.0);
        assert_eq!(spans.len(), 3);
        assert_eq!(
            spans.iter().map(|s| s.page).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!((spans[1].height - 697.89).abs() < 1e-6);
        assert!((spans[2].height - 32.22).abs() < 1e-6);
        // A range that starts on a later page counts from there.
        let later = flow_spans(&setup, 2, 700.0, 200.0);
        assert_eq!(later.len(), 2);
        assert_eq!((later[1].page, later[1].top), (3, 72.0));
        assert!((later[1].height - 130.11).abs() < 1e-6);
    }

    #[test]
    fn a_range_in_the_bottom_margin_starts_on_the_next_page() {
        let setup = a4();
        // y 800 is below the bottom margin (769.89): the printable area of page 1 is used up, so the
        // first part is on page 2.
        let spans = flow_spans(&setup, 1, 800.0, 100.0);
        assert_eq!(spans.len(), 1);
        assert_eq!((spans[0].page, spans[0].top), (2, 72.0));
    }

    #[test]
    fn flow_coordinates_round_trip_and_order_the_pages() {
        let setup = a4();
        let step = setup.content_height();
        assert_eq!(flow_of(&setup, 1, 72.0), 0.0);
        assert!((flow_of(&setup, 2, 72.0) - step).abs() < 1e-9);
        // The bottom of a page is one step further, whatever the margins are.
        assert!((flow_of(&setup, 1, setup.content_bottom()) - step).abs() < 1e-9);
        for (page, y) in [(1, 72.0), (1, 500.0), (2, 72.0), (3, 400.0)] {
            assert_eq!(place_of(&setup, flow_of(&setup, page, y)), (page, y));
        }
        // The top of a page is never below the top of the next one.
        assert!(flow_of(&setup, 1, 700.0) < flow_of(&setup, 2, 72.0));
    }

    #[test]
    fn a_range_of_no_length_or_a_broken_one_has_no_span() {
        let setup = a4();
        assert!(flow_spans(&setup, 1, 100.0, 0.0).is_empty());
        assert!(flow_spans(&setup, 1, 100.0, -5.0).is_empty());
        assert!(flow_spans(&setup, 1, f64::NAN, 100.0).is_empty());
        assert!(flow_spans(&setup, 1, 100.0, f64::INFINITY).is_empty());
    }
}
