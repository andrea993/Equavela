//! Import of .mcdx worksheets (`.mcdx`) into an Equavela worksheet.
//!
//! [`import_mcdx`] reads the package read-only and returns the canonical `.eqv` text of an
//! untitled worksheet plus a report of everything that was not imported. The
//! importer never writes anything.

mod math;
mod ole;
mod text;
mod xmcd;
mod xmcd_plot;

pub use xmcd::{import_xmcd, import_xmcd_bytes};

use crate::layout::{Margins, PageBreak, PageLine, PageSetup, TextRegion};
use crate::project::{CalculationSettings, DocumentId, DocumentRegion, ProjectDocument};
use crate::richtext::{RichText, Run};
use crate::syntax::{parse_statement, print_statement};
use crate::worksheet_writer::write_document;
use roxmltree::{Document, Node};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

/// WPF device-independent pixels (1/96 inch) to points.
const PX_TO_PT: f64 = 0.75;

/// Root directory of the worksheet parts inside an MCDX package.
const WORKSHEET_PART_ROOT: &str = "mathcad";

fn worksheet_part(relative: &str) -> String {
    format!("{WORKSHEET_PART_ROOT}/{relative}")
}

/// One thing that was not imported or was approximated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportIssue {
    /// A kebab-case code of the spec (`math-unsupported`, `plot-not-imported`, ...).
    pub code: String,
    /// The `.mcdx` region id, when the issue belongs to a region.
    pub region: Option<String>,
    pub message: String,
}

/// What an import produced besides the worksheet.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    /// Top-level regions of the file, page breaks not counted.
    pub regions_total: usize,
    /// Regions that became a math or text region.
    pub regions_imported: usize,
    /// `pageBreak` regions of the file: the top-level ones end a page and store a break entry
    ///, the ones nested in a container are counted and noted only.
    pub page_breaks: usize,
    /// Content that is missing or changed.
    pub issues: Vec<ImportIssue>,
    /// Information that is not a loss of content (version 14 of the reference application conversion notes, settings).
    pub notes: Vec<ImportIssue>,
    /// The display override of the math regions that carry one: the
    /// math font keys of by imported region id. It goes into the document, not the report.
    #[serde(skip)]
    region_formats: BTreeMap<String, BTreeMap<String, String>>,
    /// For each imported math region and inline math run, the id of the region it came from in
    /// the source file (an `.xmcd` import only): what a value check pairs with the saved results.
    #[serde(skip)]
    pub source_regions: Vec<(String, String)>,
    /// The worksheets an `.xmcd` includes that were found on disk: the include path
    /// written in the imported worksheet (`.eqv`) and the `.xmcd` it stands for.
    #[serde(skip)]
    pub includes: Vec<(String, std::path::PathBuf)>,
}

impl ImportReport {
    fn issue(&mut self, code: &str, region: Option<&str>, message: impl Into<String>) {
        let issue = ImportIssue {
            code: code.to_owned(),
            region: region.map(str::to_owned),
            message: message.into(),
        };
        if !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }

    fn note(&mut self, code: &str, region: Option<&str>, message: impl Into<String>) {
        let note = ImportIssue {
            code: code.to_owned(),
            region: region.map(str::to_owned),
            message: message.into(),
        };
        if !self.notes.contains(&note) {
            self.notes.push(note);
        }
    }

    /// Number of issues per code, sorted by code.
    pub fn counts(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for issue in &self.issues {
            *counts.entry(issue.code.clone()).or_insert(0) += 1;
        }
        counts
    }
}

/// The result of an import.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Imported {
    /// The canonical text of the worksheet (`.eqv`).
    pub text: String,
    pub report: ImportReport,
}

/// Why an import failed: nothing is produced.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("cannot read `{path}`: {message}")]
    Io { path: String, message: String },
    #[error("`{name}` is not an .mcdx worksheet ({reason})")]
    NotMcdx { name: String, reason: String },
    #[error("`{name}` is not an .xmcd worksheet ({reason})")]
    NotXmcd { name: String, reason: String },
    #[error("`{name}` has XML that cannot be read: {message}")]
    Xml { name: String, message: String },
    #[error("the imported worksheet cannot be written: {0}")]
    Write(String),
}

/// Imports the worksheet at `path` by its extension: an `.xmcd` or, for any other
/// name, an `.mcdx` (read-only).
pub fn import_file(path: &Path) -> Result<Imported, ImportError> {
    let xmcd = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("xmcd") || e.eq_ignore_ascii_case("xmcdz"));
    if xmcd {
        import_xmcd(path)
    } else {
        import_mcdx(path)
    }
}

/// Imports the `.mcdx` at `path` (read-only).
pub fn import_mcdx(path: &Path) -> Result<Imported, ImportError> {
    let bytes = std::fs::read(path).map_err(|error| ImportError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    import_mcdx_bytes(&bytes, &name)
}

/// Imports a package held in memory; `name` is used in messages only.
pub fn import_mcdx_bytes(bytes: &[u8], name: &str) -> Result<Imported, ImportError> {
    let not_mcdx = |reason: &str| ImportError::NotMcdx {
        name: name.to_owned(),
        reason: reason.to_owned(),
    };
    let mut package = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| not_mcdx(&format!("not a zip package: {error}")))?;
    let worksheet = read_text(&mut package, &worksheet_part("worksheet.xml"))
        .ok_or_else(|| not_mcdx("the worksheet part is missing"))?;
    let xml_error = |error: roxmltree::Error| ImportError::Xml {
        name: name.to_owned(),
        message: error.to_string(),
    };
    let ws_doc = Document::parse(&worksheet).map_err(xml_error)?;
    let mut report = ImportReport::default();

    let presentation = read_text(&mut package, &worksheet_part("settings/presentation.xml"));
    let mut page = match &presentation {
        Some(xml) => page_setup(xml, &mut report),
        None => PageSetup::default(),
    };
    // the reference application keeps the header and the footer of every page in two parts of their own.
    let header = page_line(
        &mut package,
        &worksheet_part("header.xml"),
        &page,
        &mut report,
    );
    let footer = page_line(
        &mut package,
        &worksheet_part("footer.xml"),
        &page,
        &mut report,
    );
    page.header = header;
    page.footer = footer;
    let mut settings = match read_text(&mut package, &worksheet_part("settings/calculation.xml")) {
        Some(xml) => calculation_settings(&xml, &mut report),
        None => CalculationSettings::default(),
    };
    if let Some(xml) = &presentation {
        display_settings(xml, &mut settings);
    }
    let rels = read_text(&mut package, &worksheet_part("_rels/worksheet.xml.rels"))
        .map(|xml| relationships(&xml))
        .unwrap_or_default();

    let mut resources = crate::image::Resources::new();
    let (regions, page_breaks) = convert_regions(
        &ws_doc,
        &page,
        &rels,
        &mut package,
        &mut report,
        &mut resources,
    );
    // A `formattingOverride` that sets a font family is the only part with no place in the model;
    // the other attributes are imported.
    let family_only = ws_doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "formattingOverride")
        .filter(|n| n.attribute("FontFamily").is_some())
        .count();
    if family_only > 0 {
        report.note(
            "math-style-dropped",
            None,
            format!("the font family of {family_only} math region(s) is not imported"),
        );
    }

    let document = ProjectDocument {
        id: DocumentId::new("Imported.eqv").expect("a plain file name is a valid id"),
        content_hash: "import".into(),
        settings,
        environment: None,
        page,
        result_formats: std::mem::take(&mut report.region_formats),
        numeric_options: Default::default(),
        math_breaks: Default::default(),
        resources,
        assets: Default::default(),
        page_breaks,
        regions: regions.into_iter().map(std::sync::Arc::new).collect(),
    };
    let text = write_document(&document).map_err(|error| ImportError::Write(error.to_string()))?;
    // a name the reference application left unlabelled is no unit (it draws it as a name); when the worksheet defines
    // the same spelling as an explicit variable it is that variable.
    let text = crate::worksheet_file::rebind_plain_names(&text).map_err(ImportError::Write)?;
    Ok(Imported { text, report })
}

// ---- package -----------------------------------------------------------------------------

fn read_bytes<R: Read + std::io::Seek>(
    package: &mut zip::ZipArchive<R>,
    part: &str,
) -> Option<Vec<u8>> {
    let mut file = package.by_name(part).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    Some(data)
}

fn read_text<R: Read + std::io::Seek>(
    package: &mut zip::ZipArchive<R>,
    part: &str,
) -> Option<String> {
    let data = read_bytes(package, part)?;
    Some(
        String::from_utf8_lossy(&data)
            .trim_start_matches('\u{feff}')
            .to_owned(),
    )
}

/// Relationship ID to part name from the worksheet relationship part.
fn relationships(xml: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    if let Ok(doc) = Document::parse(xml) {
        for r in doc.descendants().filter(|n| n.has_tag_name("Relationship")) {
            if let (Some(id), Some(target)) = (r.attribute("Id"), r.attribute("Target")) {
                map.insert(id.to_owned(), target.trim_start_matches('/').to_owned());
            }
        }
    }
    map
}

// ---- page and settings -------------------------------------------------------------------

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// .
fn page_setup(xml: &str, report: &mut ImportReport) -> PageSetup {
    let Ok(doc) = Document::parse(xml) else {
        return PageSetup::default();
    };
    let Some(model) = doc.descendants().find(|n| n.has_tag_name("pageModel")) else {
        return PageSetup::default();
    };
    let landscape = model
        .attribute("orientation")
        .is_some_and(|o| o.eq_ignore_ascii_case("landscape"));
    let code = model.attribute("paper-code").unwrap_or("A4");
    let mut page = PageSetup::named(code, landscape).unwrap_or_else(|| {
        report.issue(
            "page-size-unknown",
            None,
            format!("paper code `{code}` is not known; A4 is used"),
        );
        PageSetup::named("A4", landscape).expect("A4 is known")
    });
    let numbers: Option<Vec<f64>> = model.attribute("page-margin").map(|value| {
        value
            .split(',')
            .filter_map(|v| v.trim().parse::<f64>().ok())
            .collect()
    });
    match numbers {
        Some(n) if n.len() == 4 => {
            // WPF Thickness order: left, top, right, bottom.
            page.margins = Margins {
                left: round2(n[0] * PX_TO_PT),
                top: round2(n[1] * PX_TO_PT),
                right: round2(n[2] * PX_TO_PT),
                bottom: round2(n[3] * PX_TO_PT),
            };
        }
        _ => {
            // the reference application's presets, owner-confirmed: all four sides.
            let preset = match model.attribute("margin-type") {
                Some("Narrow") => Some(12.5),
                Some("Normal") | Some("Standard") => Some(25.0),
                Some("Wide") => Some(50.0),
                _ => None,
            };
            if let Some(mm) = preset {
                page.margins = Margins::uniform(round2(mm * 72.0 / 25.4));
            }
        }
    }
    page
}

/// The slot of a header or footer region: the third of the printable width
/// the centre of the region falls in.
fn slot_of(centre: f64, printable: f64) -> usize {
    if printable <= 0.0 || centre < printable / 3.0 {
        0
    } else if centre < printable * 2.0 / 3.0 {
        1
    } else {
        2
    }
}

/// A header or a footer part as a page line. The regions of the left third
/// fill the left slot, the centre third the
/// centre slot and the right third the right slot, joining the regions of one slot with one space
/// in x order.
fn page_line<R: Read + std::io::Seek>(
    package: &mut zip::ZipArchive<R>,
    part: &str,
    page: &PageSetup,
    report: &mut ImportReport,
) -> PageLine {
    let what = Path::new(part)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("header")
        .to_owned();
    let Some(xml) = read_text(package, part) else {
        // A worksheet without the part has no line.
        return PageLine::default();
    };
    let Ok(doc) = Document::parse(&xml) else {
        report.issue(
            "page-line-not-imported",
            None,
            format!("`{part}` cannot be read as XML, so the {what} is not imported"),
        );
        return PageLine::default();
    };
    // The text packages of the part are named by its own relationships, as `worksheet.xml.rels`
    // names the sheet's.
    let rels = Path::new(part)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| worksheet_part(&format!("_rels/{name}.rels")))
        .and_then(|rels| read_text(package, &rels))
        .map(|xml| relationships(&xml))
        .unwrap_or_default();
    let printable = page.content_width() / PX_TO_PT;
    let mut slots: [Vec<(f64, String)>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let mut styled = false;
    let regions = child_elements(doc.root_element())
        .into_iter()
        .find(|n| n.tag_name().name() == "regions");
    for region in regions.map(child_elements).unwrap_or_default() {
        if region.tag_name().name() != "region" {
            continue;
        }
        let id = region
            .attribute("region-id")
            .map(|id| format!("{what}:{id}"));
        let left = attr_f64(region, "left").unwrap_or(0.0);
        let width = attr_f64(region, "actualWidth")
            .or_else(|| attr_f64(region, "width"))
            .unwrap_or(0.0);
        let slot = slot_of(left + width / 2.0, printable);
        let id = id.as_deref();
        if let Some((text, has_style)) =
            page_region_text(region, &xml, &rels, package, id, &what, report)
        {
            styled |= has_style;
            slots[slot].push((left, text));
        }
    }
    if styled {
        report.note(
            "page-line-style-dropped",
            None,
            "the font family, size, colour and emphasis of header and footer text are not imported: \
             a page line uses the bundled text font at 10 pt",
        );
    }
    let join = |mut items: Vec<(f64, String)>| {
        items.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        items
            .into_iter()
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let [left, center, right] = slots;
    PageLine {
        left: join(left),
        center: join(center),
        right: join(right),
    }
}

/// The text one header or footer region gives, and whether it carries formatting the page line
/// cannot hold.
#[allow(clippy::too_many_arguments)]
fn page_region_text<R: Read + std::io::Seek>(
    region: Node,
    part_xml: &str,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    id: Option<&str>,
    what: &str,
    report: &mut ImportReport,
) -> Option<(String, bool)> {
    let content = child_elements(region).into_iter().next()?;
    match content.tag_name().name() {
        "text" => {
            let (rich, styled) = page_text(content, part_xml, rels, package, id, report)?;
            let text = plain_line(&rich);
            (!text.is_empty()).then_some((text, styled))
        }
        "fieldText" => {
            let saved = child_elements(content)
                .into_iter()
                .find(|n| n.tag_name().name() == "text")
                .and_then(|text| page_text(text, part_xml, rels, package, id, report))
                .unwrap_or_default();
            let (rich, styled) = saved;
            let saved = plain_line(&rich);
            let field = child_elements(content)
                .into_iter()
                .find(|n| n.tag_name().name() != "text")?;
            let name = field.tag_name().name();
            let template = field.attribute("template").unwrap_or("");
            // The fields a page line can hold; any other name is a field of the reference application's that
            // the model does not know.
            let token = match name {
                "pageNumber" => Some("{page}"),
                "fileName" => Some("{file}"),
                "dateSaved" => Some("{date}"),
                // A date field under another name
                //  is still a date.
                other if other.starts_with("date") => {
                    report.note(
                        "page-line-field-unknown",
                        id,
                        format!(
                            "the field `{other}` is imported as a date, like `dateSaved`; that its \
                             name is a date field is unchecked"
                        ),
                    );
                    Some("{date}")
                }
                other => {
                    report.note(
                        "page-line-field-unknown",
                        id,
                        format!(
                            "the field `{other}` is not in the model; the text it displays, `{saved}`, \
                             is written as saved"
                        ),
                    );
                    None
                }
            };
            let Some(token) = token else {
                return (!saved.is_empty()).then_some((saved, styled));
            };
            // The total number of pages and the words around the number are not in the model, and
            // a date is drawn as `YYYY-MM-DD` on the day of the drawing, never in the saved
            // format: what the template asks for beyond the token is named.
            let formatted = match name {
                // The bare number is what `{page}` writes; the total number of pages and the
                // words around the number are not in the model.
                "pageNumber" => !matches!(template, "" | "@PageNo"),
                // `{file}` is the file name, whatever the field's template says.
                "fileName" => false,
                // A date is drawn as `YYYY-MM-DD` on the day of the drawing,
                // never in the saved format.
                _ => true,
            };
            if formatted {
                let format = if template.is_empty() {
                    "without a template"
                } else {
                    template
                };
                let reason = if name == "pageNumber" {
                    "the model writes `{page}`, the number alone"
                } else {
                    "the model writes `{date}`, the date the page is drawn as YYYY-MM-DD"
                };
                report.note(
                    "page-line-format-dropped",
                    id,
                    format!("the format `{format}` of the `{name}` field is not kept: {reason}"),
                );
            }
            Some((token.to_owned(), styled))
        }
        "math" => {
            report.issue(
                "page-line-not-imported",
                id,
                format!(
                    "a `math` region in the {what} is not imported: a page line holds text only"
                ),
            );
            None
        }
        other => {
            report.issue(
                "page-line-not-imported",
                id,
                format!(
                    "a `{other}` region in the {what} is not imported: a page line holds text only"
                ),
            );
            None
        }
    }
}

/// The text of a `text` element of a header or footer: the package its `item-idref` names, read
/// like a text region, or the `FlowDocument` stored inside the part (which is how a field
/// keeps the text it displays). The second value says whether the text carries formatting that the
/// page line cannot hold.
fn page_text<R: Read + std::io::Seek>(
    node: Node,
    part_xml: &str,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    id: Option<&str>,
    report: &mut ImportReport,
) -> Option<(RichText, bool)> {
    let xaml = match node.attribute("item-idref") {
        Some(idref) => {
            let read = rels
                .get(idref)
                .and_then(|part| read_bytes(package, part))
                .and_then(|bytes| {
                    let mut inner = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
                    let name = (0..inner.len()).find_map(|i| {
                        let file = inner.by_index(i).ok()?;
                        let name = file.name().ok()?.into_owned();
                        name.to_ascii_lowercase()
                            .ends_with("document.xaml")
                            .then_some(name)
                    })?;
                    read_text(&mut inner, &name)
                });
            match read {
                Some(xaml) => xaml,
                None => {
                    report.issue(
                        "text-unreadable",
                        id,
                        format!("the text part `{idref}` of the header or footer is missing or unreadable"),
                    );
                    return None;
                }
            }
        }
        None => {
            let element = child_elements(node)
                .into_iter()
                .find(|n| n.tag_name().name() == "FlowDocument")?;
            part_xml.get(element.range())?.to_owned()
        }
    };
    let (rich, outcome) = text::convert(&xaml, &[]);
    let emphasized = rich
        .0
        .iter()
        .flat_map(|paragraph| &paragraph.runs)
        .any(|run| match run {
            Run::Text(run) => {
                run.bold || run.italic || run.underline || run.sub || run.sup || run.size.is_some()
            }
            Run::Math(_) => false,
        });
    Some((rich, outcome.style_dropped || emphasized))
}

/// A page line is one line of text: the runs of the text joined, every paragraph break and
/// control character as one space, and runs of spaces collapsed.
fn plain_line(rich: &RichText) -> String {
    let mut text = String::new();
    for paragraph in &rich.0 {
        if !text.is_empty() {
            text.push(' ');
        }
        for run in &paragraph.runs {
            match run {
                Run::Text(run) => text.push_str(&run.text),
                Run::Math(run) => text.push_str(&run.text),
            }
        }
    }
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// the reference application's own default style of each label: bold, italic and colour `#rrggbb`, as 186
/// of the 197 corpus files store them. Only a property that differs from these is imported.
const MCDX_LABEL_STYLES: [(&str, &str, bool, bool, &str); 6] = [
    ("Variable", "var", false, true, "#000000"),
    ("Constant", "const", true, true, "#556b2f"),
    ("Function", "fn", false, false, "#000000"),
    ("Unit", "unit", true, true, "#00008b"),
    ("System", "sys", true, false, "#000000"),
    ("Keyword", "kw", true, false, "#000000"),
];

/// A WPF colour `#AARRGGBB` or `#RRGGBB` as `#rrggbb`, lower case.
fn wpf_color(text: &str) -> Option<String> {
    let hex = text.strip_prefix('#')?;
    let rgb = match hex.len() {
        8 => &hex[2..],
        6 => hex,
        _ => return None,
    };
    rgb.chars()
        .all(|c| c.is_ascii_hexdigit())
        .then(|| format!("#{}", rgb.to_ascii_lowercase()))
}

/// An integer attribute stored under `key` when it is in `range` and differs from `default`.
fn int_setting(
    values: &mut std::collections::BTreeMap<String, String>,
    node: roxmltree::Node,
    attr: &str,
    key: &str,
    range: (i64, i64),
    default: i64,
) {
    if let Some(v) = node
        .attribute(attr)
        .and_then(|v| v.trim().parse::<i64>().ok())
    {
        if (range.0..=range.1).contains(&v) && v != default {
            values.insert(key.into(), v.to_string());
        }
    }
}

/// the worksheet-wide display settings of `presentation.xml` (result format, matrix
/// display, label styles), stored only where they differ from their defaults.
fn display_settings(xml: &str, settings: &mut CalculationSettings) {
    let Ok(doc) = Document::parse(xml) else {
        return;
    };
    let values = &mut settings.values;
    for node in doc.descendants().filter(|n| n.is_element()) {
        match node.tag_name().name() {
            "general" => {
                int_setting(values, node, "precision", "format.precision", (0, 15), 3);
                int_setting(
                    values,
                    node,
                    "exponential-threshold",
                    "format.exp-threshold",
                    (1, 307),
                    3,
                );
                int_setting(
                    values,
                    node,
                    "zero-threshold",
                    "format.zero-threshold",
                    (1, 307),
                    15,
                );
                int_setting(
                    values,
                    node,
                    "complex-threshold",
                    "format.complex-threshold",
                    (1, 307),
                    10,
                );
                if node.attribute("show-trailing-zeros") == Some("true") {
                    values.insert("format.trailing-zeros".into(), "true".into());
                }
                let radix = match node.attribute("radix") {
                    Some("hex") => Some("hexadecimal"),
                    Some("oct") => Some("octal"),
                    Some("bin") => Some("binary"),
                    _ => None,
                };
                if let Some(radix) = radix {
                    values.insert("format.radix".into(), radix.into());
                }
                if node.attribute("imaginary-value") == Some("j") {
                    values.insert("format.imaginary".into(), "j".into());
                }
            }
            "matrix" => {
                if let Some(size) = node.attribute("size") {
                    let parts: Vec<Option<u32>> =
                        size.split(',').map(|p| p.trim().parse().ok()).collect();
                    if let [Some(rows), Some(cols)] = parts[..] {
                        if (rows, cols) != (12, 12) && rows > 0 && cols > 0 {
                            values.insert("format.matrix-size".into(), format!("{rows},{cols}"));
                        }
                    }
                }
                if node.attribute("show-indices") == Some("true") {
                    values.insert("format.show-indices".into(), "true".into());
                }
                if node.attribute("expand-nested-arrays") == Some("true") {
                    values.insert("format.expand-nested".into(), "true".into());
                }
            }
            "mathStyle" => {
                let Some(&(_, label, bold, italic, color)) = MCDX_LABEL_STYLES
                    .iter()
                    .find(|style| Some(style.0) == node.attribute("name"))
                else {
                    continue;
                };
                let flag =
                    |attr: &str, on: &str| node.attribute(attr).map(|v| v.eq_ignore_ascii_case(on));
                if let Some(b) = flag("font-weight", "Bold").filter(|b| *b != bold) {
                    values.insert(format!("label-style.{label}.bold"), b.to_string());
                }
                if let Some(i) = flag("font-style", "Italic").filter(|i| *i != italic) {
                    values.insert(format!("label-style.{label}.italic"), i.to_string());
                }
                if let Some(c) = node
                    .attribute("color")
                    .and_then(wpf_color)
                    .filter(|c| c != color)
                {
                    values.insert(format!("label-style.{label}.color"), c);
                }
            }
            _ => {}
        }
    }
}

/// Whether an imported tolerance differs from the built-in default: a value
/// equal to the default is not stored, so a worksheet at the defaults carries no tolerance key.
/// A value that is not a number is kept as written.
fn differs_from(text: &str, default: f64) -> bool {
    // A value that is not a number is kept as written: it differs from the default.
    text.trim().parse::<f64>() != Ok(default)
}

/// .
fn calculation_settings(xml: &str, report: &mut ImportReport) -> CalculationSettings {
    let mut settings = CalculationSettings::default();
    let Ok(doc) = Document::parse(xml) else {
        return settings;
    };
    let mut not_imported: Vec<String> = Vec::new();
    for node in doc.descendants().filter(|n| n.is_element()) {
        match node.tag_name().name() {
            "builtInVariables" => {
                // ORIGIN is a worksheet setting; 0 is the default and is not
                // stored, the canonical form of .
                if let Some(v) = node
                    .attribute("array-origin")
                    .filter(|v| v.trim().parse::<f64>().ok() != Some(0.0))
                {
                    settings.values.insert("ORIGIN".into(), v.trim().to_owned());
                }
                // TOL and CTOL are settings we model. A value
                // equal to the built-in default is not stored, the canonical form of .
                for (source, key, default) in [
                    ("convergence-tolerance", "TOL", 0.001),
                    ("constraint-tolerance", "CTOL", 0.001),
                ] {
                    if let Some(v) = node.attribute(source).filter(|v| differs_from(v, default)) {
                        settings.values.insert(key.into(), v.to_owned());
                    }
                }
                for (key, default) in [
                    ("prn-col-width", "8"),
                    ("prn-precision", "4"),
                    ("random-seed", "1"),
                ] {
                    if node.attribute(key).is_some_and(|v| v != default) {
                        not_imported.push(key.to_owned());
                    }
                }
            }
            "calculationBehavior" => {
                if node.attribute("exact-boolean") == Some("false") {
                    settings
                        .values
                        .insert("exact-boolean".into(), "false".into());
                }
                for (key, default) in [
                    ("strings-use-origin", "false"),
                    ("matrix-strict-singularity-check", "false"),
                    ("units-in-symbolics", "false"),
                    ("constants-in-symbolics", "false"),
                ] {
                    if node.attribute(key).is_some_and(|v| v != default) {
                        not_imported.push(key.to_owned());
                    }
                }
            }
            "currentUnitSystem" if node.attribute("name").is_some_and(|n| n != "si") => {
                not_imported.push("unit system".to_owned());
            }
            _ => {}
        }
    }
    if !not_imported.is_empty() {
        report.note(
            "settings-not-imported",
            None,
            format!(
                "settings that differ from the defaults and are not part of the model: {}",
                not_imported.join(", ")
            ),
        );
    }
    settings
}

// ---- regions -----------------------------------------------------------------------------

fn attr_f64(node: Node, name: &str) -> Option<f64> {
    node.attribute(name).and_then(|v| v.trim().parse().ok())
}

fn child_elements<'a, 'b>(node: Node<'a, 'b>) -> Vec<Node<'a, 'b>> {
    node.children().filter(|c| c.is_element()).collect()
}

/// A top-level region with its primary child.
struct Source<'a, 'b> {
    region: Node<'a, 'b>,
    id: String,
    primary: Option<Node<'a, 'b>>,
    top: Option<f64>,
    left: f64,
    height: Option<f64>,
}

/// Where a region lands.
#[derive(Clone, Copy)]
struct Placement {
    page: u32,
    x: f64,
    y: f64,
}

fn convert_regions<R: Read + std::io::Seek>(
    ws: &Document,
    page: &PageSetup,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    report: &mut ImportReport,
    resources: &mut crate::image::Resources,
) -> (Vec<DocumentRegion>, Vec<PageBreak>) {
    let root = ws.root_element();
    let Some(list) = child_elements(root)
        .into_iter()
        .find(|n| n.tag_name().name() == "regions")
    else {
        return (Vec::new(), Vec::new());
    };
    let mut sources: Vec<Source> = region_sources(list);
    // Areas: the nested regions, and the band each area takes in the flow. A collapsed area's
    // file height is only its header, so what lies below moves down by the hidden part: stored
    // positions are the expanded layout.
    let nested: Vec<Vec<Source>> = sources
        .iter()
        .map(|s| match s.primary {
            Some(p) if p.tag_name().name() == "Area" => child_elements(p)
                .into_iter()
                .find(|n| n.tag_name().name() == "regions")
                .map(region_sources)
                .unwrap_or_default(),
            _ => Vec::new(),
        })
        .collect();
    let mut bands: Vec<Option<f64>> = vec![None; sources.len()];
    let printable_px = page.content_height() / PX_TO_PT;
    let mut by_top: Vec<usize> = (0..sources.len()).collect();
    by_top.sort_by(|a, b| {
        sources[*a]
            .top
            .partial_cmp(&sources[*b].top)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for index in by_top {
        let Some(element) = sources[index].primary else {
            continue;
        };
        if element.tag_name().name() != "Area" {
            continue;
        }
        let extent = nested[index]
            .iter()
            .map(|n| n.top.unwrap_or(0.0) + n.height.unwrap_or(0.0))
            .fold(0.0, f64::max);
        let own = sources[index].height.unwrap_or(0.0);
        let minimum = crate::area::MIN_AREA_HEIGHT / PX_TO_PT;
        let band = (crate::area::AREA_HEADER_PT / PX_TO_PT + extent)
            .max(own)
            .max(minimum);
        let band = if band > printable_px {
            report.note(
                "area-clamped",
                Some(&sources[index].id),
                "the area is taller than a page and was shortened to the printable height",
            );
            printable_px
        } else {
            band
        };
        bands[index] = Some(band);
        if element.attribute("IsCollapsed") == Some("true") && band > own {
            let threshold = sources[index].top.unwrap_or(0.0) + own;
            for (other, source) in sources.iter_mut().enumerate() {
                if other != index && source.top.is_some_and(|t| t >= threshold - 1e-9) {
                    source.top = source.top.map(|t| t + band - own);
                }
            }
        }
        sources[index].height = Some(band);
    }

    let (placements, page_breaks) = place(&sources, page, report);
    let mut regions = Vec::new();
    let mut sequence = 0usize;
    for (index, source) in sources.iter().enumerate() {
        let kind = source.primary.map(|p| p.tag_name().name()).unwrap_or("");
        if kind == "pageBreak" {
            continue;
        }
        report.regions_total += 1;
        notes_for(source, report);
        let at = placements[index];
        let id = format!("r{}", sequence + 1);
        let created = if kind == "Area" {
            area_region(
                source,
                &nested[index],
                bands[index].unwrap_or(0.0),
                at,
                &mut sequence,
                page,
                rels,
                package,
                report,
                resources,
                &mut regions,
            )
        } else {
            convert_source(
                source, kind, at, &id, page, rels, package, report, resources,
            )
        };
        if !created.is_empty() {
            sequence += created.len();
            regions.extend(created);
            report.regions_imported += 1;
        }
    }
    (regions, page_breaks)
}

/// One non-area region converted by its content kind.
#[allow(clippy::too_many_arguments)]
fn convert_source<R: Read + std::io::Seek>(
    source: &Source,
    kind: &str,
    at: Placement,
    id: &str,
    page: &PageSetup,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    report: &mut ImportReport,
    resources: &mut crate::image::Resources,
) -> Vec<DocumentRegion> {
    if kind == "solveblock" {
        return solve_block_regions(source, at, id, report);
    }
    convert_single(source, kind, at, id, page, rels, package, report, resources)
        .into_iter()
        .collect()
}

/// One non-area region that becomes at most one region.
#[allow(clippy::too_many_arguments)]
fn convert_single<R: Read + std::io::Seek>(
    source: &Source,
    kind: &str,
    at: Placement,
    id: &str,
    page: &PageSetup,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    report: &mut ImportReport,
    resources: &mut crate::image::Resources,
) -> Option<DocumentRegion> {
    match kind {
        "math" => math_region(source, at, id, report),
        "text" => text_region(source, at, id, page, rels, package, report),
        "plot" => plot_region(source, at, id, page, report),
        "reference" => {
            report.issue(
                "include-not-imported",
                Some(&source.id),
                format!(
                    "include of `{}` is not imported yet",
                    source
                        .primary
                        .and_then(|p| p.attribute("href"))
                        .unwrap_or("?")
                ),
            );
            None
        }
        "Area" => {
            report.issue(
                "container-not-imported",
                Some(&source.id),
                format!("`{kind}` and the regions inside it are not imported"),
            );
            None
        }
        "picture" => picture_region(source, at, id, rels, package, resources, report),
        "oleObject" => {
            report.issue(
                "ole-not-imported",
                Some(&source.id),
                "OLE objects are not imported",
            );
            None
        }
        "spec-table" => {
            report.issue(
                "table-not-imported",
                Some(&source.id),
                "tables are not imported",
            );
            None
        }
        other => {
            report.issue(
                "region-unknown",
                Some(&source.id),
                format!("unknown region content `{other}`"),
            );
            None
        }
    }
}

/// An `Area`: the area region, then its nested regions placed below its header. Both go
/// on `regions` here; the caller gets nothing back to add. A nested area is not imported.
#[allow(clippy::too_many_arguments)]
fn area_region<R: Read + std::io::Seek>(
    source: &Source,
    nested: &[Source],
    band_px: f64,
    at: Placement,
    sequence: &mut usize,
    page: &PageSetup,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    report: &mut ImportReport,
    resources: &mut crate::image::Resources,
    regions: &mut Vec<DocumentRegion>,
) -> Vec<DocumentRegion> {
    let Some(element) = source.primary else {
        return Vec::new();
    };
    let area = DocumentRegion::Area(crate::area::AreaRegion {
        id: format!("r{}", *sequence + 1),
        page: at.page,
        x: page.margins.left,
        y: at.y,
        enabled: true,
        title: element
            .attribute("Title")
            .or_else(|| element.attribute("Name"))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or("Area")
            .to_owned(),
        height: round2(band_px * PX_TO_PT),
        collapsed: element.attribute("IsCollapsed") == Some("true"),
    });
    // The area takes its id first, so the members' ids follow it.
    *sequence += 1;
    let mut members = Vec::new();
    for member in nested {
        let kind = member.primary.map(|p| p.tag_name().name()).unwrap_or("");
        if kind == "pageBreak" {
            nested_page_break(member, report);
            continue;
        }
        report.regions_total += 1;
        notes_for(member, report);
        let member_at = Placement {
            page: at.page,
            x: round2(page.margins.left + member.left * PX_TO_PT),
            y: round2(at.y + crate::area::AREA_HEADER_PT + member.top.unwrap_or(0.0) * PX_TO_PT),
        };
        let id = format!("r{}", *sequence + 1);
        let created = if kind == "Area" {
            report.issue(
                "container-not-imported",
                Some(&member.id),
                "an area inside an area is not imported",
            );
            Vec::new()
        } else {
            convert_source(
                member, kind, member_at, &id, page, rels, package, report, resources,
            )
        };
        if !created.is_empty() {
            *sequence += created.len();
            members.extend(created);
            report.regions_imported += 1;
        }
    }
    report.regions_imported += 1;
    regions.push(area);
    regions.extend(members);
    Vec::new()
}

/// A `solveblock`: its nested math regions, in
/// top order, become flat regions of a version 15 of the reference application style block at the position of the block: a
/// `Given` region (added when the reference application's block has no such line), then every nested math region
/// as a region of its own, stacked at the step of . Nothing is validated here: the rules of
/// section 2 apply when the worksheet is analysed. A nested region that is not math is reported
/// and left out; a block without a solving call is imported as its lines and noted.
fn solve_block_regions(
    source: &Source,
    at: Placement,
    id: &str,
    report: &mut ImportReport,
) -> Vec<DocumentRegion> {
    use crate::ast::{Statement, StatementKind};
    let Some(element) = source.primary else {
        return Vec::new();
    };
    let mut nested: Vec<Source> = child_elements(element)
        .into_iter()
        .find(|n| n.tag_name().name() == "regions")
        .map(region_sources)
        .unwrap_or_default();
    nested.sort_by(|a, b| {
        let key = |s: &Source| (s.top.unwrap_or(0.0), s.left);
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut statements: Vec<std::sync::Arc<Statement>> = Vec::new();
    for member in &nested {
        let kind = member.primary.map(|p| p.tag_name().name()).unwrap_or("");
        if kind == "pageBreak" {
            nested_page_break(member, report);
            continue;
        }
        if kind != "math" {
            report.issue(
                "container-not-imported",
                Some(&member.id),
                format!("a nested `{kind}` region of a solve block is not imported"),
            );
            continue;
        }
        notes_for(member, report);
        if let Some(DocumentRegion::Math(region)) = math_region(member, at, id, report) {
            let mut statement = region.statement;
            // `Given =` is the keyword too: a bare name is never evaluated.
            if let StatementKind::Evaluate { expr, unit: None } = statement.kind.clone() {
                let as_region = Statement::synth(StatementKind::ExprRegion { expr });
                if crate::graph::is_given_statement(&as_region) {
                    statement = std::sync::Arc::new(as_region);
                }
            }
            statements.push(statement);
        }
    }
    if statements.is_empty() {
        report.issue(
            "container-not-imported",
            Some(&source.id),
            "`solveblock` has no math lines to import",
        );
        return Vec::new();
    }
    if !crate::graph::is_given_statement(&statements[0]) {
        let given = parse_statement("Given").expect("the keyword parses");
        statements.insert(0, std::sync::Arc::new(given));
    }
    if !statements
        .iter()
        .any(|statement| crate::graph::calls_solving_function(statement))
    {
        report.note(
            "solve-block-no-call",
            Some(&source.id),
            "the solve block has no Find, Minerr, Minimize or Maximize call; its lines are imported as they are",
        );
    }
    let first: usize = id.trim_start_matches('r').parse().unwrap_or(1);
    statements
        .into_iter()
        .enumerate()
        .map(|(index, statement)| {
            DocumentRegion::Math(Box::new(crate::graph::Region {
                id: format!("r{}", first + index),
                page: at.page,
                x: at.x,
                y: round2(at.y + crate::worksheet_file::SOLVE_LINE_STEP * index as f64),
                enabled: true,
                statement,
            }))
        })
        .collect()
}

fn region_sources<'a, 'b>(list: Node<'a, 'b>) -> Vec<Source<'a, 'b>> {
    child_elements(list)
        .into_iter()
        .filter(|n| n.tag_name().name() == "region")
        .map(|region| {
            let primary = child_elements(region)
                .into_iter()
                .find(|c| c.tag_name().name() != "mc14-conversion-loss-annotations");
            Source {
                region,
                id: region.attribute("region-id").unwrap_or("?").to_owned(),
                primary,
                top: attr_f64(region, "top"),
                left: attr_f64(region, "left").unwrap_or(0.0),
                height: attr_f64(region, "actualHeight").or_else(|| attr_f64(region, "height")),
            }
        })
        .collect()
}

///  step 5: a `pageBreak` nested in an `Area` or in a `solveblock` is a region of that container,
/// not of the page flow. It ends no page and stores no `page-breaks:` entry, but it is counted as a
/// page break of the report and noted, so nothing is dropped silently.
fn nested_page_break(source: &Source, report: &mut ImportReport) {
    report.page_breaks += 1;
    report.note(
        "page-break-nested",
        Some(&source.id),
        "a page break inside a container ends no page and is not imported",
    );
}

fn notes_for(source: &Source, report: &mut ImportReport) {
    let annotations: Vec<String> = child_elements(source.region)
        .into_iter()
        .filter(|c| c.tag_name().name() == "mc14-conversion-loss-annotations")
        .flat_map(|c| child_elements(c))
        .filter_map(|a| a.text().map(|t| t.trim().to_owned()))
        .filter(|t| !t.is_empty())
        .collect();
    if !annotations.is_empty() {
        report.note(
            "converted-from-legacy-worksheet",
            Some(&source.id),
            annotations.join("; "),
        );
    }
}

/// The `y` of the break that ends a page at `top` px of the canvas: the position of
/// the break in the frame of the regions of that page (`top` counts from the printable area, the
/// stored `y` from the top edge of the page), clamped to the printable bottom, where a page can end.
/// A break in the bottom margin therefore frees no space, and its `page-breaks:` entry stays
/// reachable by a crosshair in the page view.
fn break_y(page: &PageSetup, top: f64, origin: f64) -> (f64, bool) {
    let stored = round2(page.margins.top + (top - origin) * PX_TO_PT);
    let bottom = round2(page.margins.top + page.content_height());
    (stored.min(bottom), stored > bottom)
}

/// page and position of every region, indexed like `sources`, plus the `page-breaks:` entry
/// of every explicit break, sorted by page and at most one per page.
fn place(
    sources: &[Source],
    page: &PageSetup,
    report: &mut ImportReport,
) -> (Vec<Placement>, Vec<PageBreak>) {
    let printable_px = page.content_height() / PX_TO_PT;
    let mut order: Vec<usize> = (0..sources.len()).collect();
    let mut last_top = 0.0;
    let tops: Vec<f64> = sources
        .iter()
        .map(|s| {
            if let Some(t) = s.top {
                last_top = t;
            }
            s.top.unwrap_or(last_top)
        })
        .collect();
    order.sort_by(|a, b| {
        tops[*a]
            .partial_cmp(&tops[*b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                sources[*a]
                    .left
                    .partial_cmp(&sources[*b].left)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    let mut placements = vec![
        Placement {
            page: 1,
            x: 0.0,
            y: 0.0
        };
        sources.len()
    ];
    let mut breaks: Vec<PageBreak> = Vec::new();
    let mut current_page = 1u32;
    let mut origin = 0.0;
    let mut first_on_page = true;
    for index in order {
        let source = &sources[index];
        let top = tops[index];
        let is_break = source
            .primary
            .is_some_and(|p| p.tag_name().name() == "pageBreak");
        if is_break {
            let (y, clamped) = break_y(page, top, origin);
            if clamped {
                report.note(
                    "page-break-clamped",
                    Some(&source.id),
                    format!(
                        "the reference application stored the break below the printable area of page {current_page}; it ends that page at its printable bottom, where it frees no space"
                    ),
                );
            }
            breaks.push(PageBreak {
                page: current_page,
                y,
            });
            current_page += 1;
            origin = top;
            first_on_page = true;
            report.page_breaks += 1;
            continue;
        }
        if !first_on_page {
            if let Some(height) = source.height {
                if top - origin + height > printable_px {
                    current_page += 1;
                    origin = top;
                }
            }
        }
        first_on_page = false;
        placements[index] = Placement {
            page: current_page,
            x: round2(page.margins.left + source.left * PX_TO_PT),
            y: round2(page.margins.top + (top - origin) * PX_TO_PT),
        };
    }
    (placements, breaks)
}

/// The canonical statement text of the `ml:` content of a `math` element, validated by the parser
///. The error is `(code, message)`.
fn math_statement(math: Node) -> Result<String, (String, String)> {
    let Some(content) = child_elements(math).into_iter().next() else {
        return Err(("math-empty".into(), "the math region is empty".into()));
    };
    let linear = math::statement_text(content).map_err(|e| {
        let (code, message) = e.describe();
        (code.to_owned(), message)
    })?;
    match parse_statement(&linear) {
        Ok(statement) => Ok(print_statement(&statement)),
        Err(error) => Err((
            "math-unparsable".into(),
            format!("`{linear}` is not valid worksheet math: {error}"),
        )),
    }
}

fn math_region(
    source: &Source,
    at: Placement,
    id: &str,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let math = source.primary?;
    match math_statement(math) {
        Ok(text) => {
            if child_elements(math)
                .first()
                .is_some_and(|c| math::is_statement_root(*c))
            {
                report.note(
                    "statement-outside-program",
                    Some(&source.id),
                    "a program statement outside a program is kept as a displayed expression (never evaluated)",
                );
            }
            // The statement was parsed once already; parse the canonical text for the model.
            let statement = parse_statement(&text).ok()?;
            // The override sits in the `math` element in the reference application's own files and next to it in the
            // fixtures: both are read.
            let font = math_font_of(math, source.region);
            if !font.is_empty() {
                report.region_formats.insert(id.to_owned(), font);
            }
            Some(DocumentRegion::Math(Box::new(crate::graph::Region {
                id: id.to_owned(),
                page: at.page,
                x: at.x,
                y: at.y,
                enabled: true,
                statement: std::sync::Arc::new(statement),
            })))
        }
        Err((code, message)) => {
            report.issue(&code, Some(&source.id), message);
            None
        }
    }
}

/// The math font keys of a `math` element's `formattingOverride`: the background
/// colour is the highlight, `FontSize` the size in points.
/// The default size is no key, as the file
/// writes it; a transparent colour is no highlight.
fn math_font_of(math: Node, region: Node) -> BTreeMap<String, String> {
    let mut keys = BTreeMap::new();
    let Some(over) = child_elements(math)
        .into_iter()
        .chain(child_elements(region))
        .find(|n| n.tag_name().name() == "formattingOverride")
    else {
        return keys;
    };
    if let Some(color) = over.attribute("BackgroundColor").and_then(opaque_color) {
        keys.insert("math-font.highlight".to_owned(), color);
    }
    if let Some(size) = over
        .attribute("FontSize")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.fract() == 0.0 && (6.0..=72.0).contains(n) && *n != 11.0)
    {
        keys.insert("math-font.size".to_owned(), format!("{}", size as i64));
    }
    keys
}

/// `#AARRGGBB` or `#RRGGBB` as `#rrggbb`, lower case; `None` when it is transparent or not a colour.
pub(crate) fn opaque_color(value: &str) -> Option<String> {
    let digits = value.trim().strip_prefix('#')?;
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match digits.len() {
        6 => Some(format!("#{}", digits.to_ascii_lowercase())),
        8 if !digits[..2].eq_ignore_ascii_case("00") => {
            Some(format!("#{}", digits[2..].to_ascii_lowercase()))
        }
        _ => None,
    }
}

/// a `picture` region becomes an image region; the bytes are sanitized (SVG) or kept.
fn picture_region<R: Read + std::io::Seek>(
    source: &Source,
    at: Placement,
    id: &str,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    resources: &mut crate::image::Resources,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let element = source.primary?;
    let idref = child_elements(element)
        .into_iter()
        .find_map(|c| c.attribute("item-idref"));
    let bytes = idref
        .and_then(|r| rels.get(r))
        .and_then(|part| read_bytes(package, part));
    let Some(bytes) = bytes else {
        report.issue(
            "picture-not-imported",
            Some(&source.id),
            "the image part is missing or unreadable",
        );
        return None;
    };
    let (resource, removed) = match crate::image::resource_from_bytes(&bytes) {
        Ok(r) => r,
        Err(error) => {
            report.issue("picture-not-imported", Some(&source.id), error.to_string());
            return None;
        }
    };
    if !removed.is_empty() {
        report.note(
            "svg-sanitized",
            Some(&source.id),
            format!(
                "unsafe parts of the SVG were removed: {}",
                removed.join(", ")
            ),
        );
    }
    let size = match (
        attr_f64(source.region, "width").or_else(|| attr_f64(source.region, "actualWidth")),
        attr_f64(source.region, "height").or_else(|| attr_f64(source.region, "actualHeight")),
    ) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => [round2(w * PX_TO_PT), round2(h * PX_TO_PT)],
        _ => crate::image::natural_size_pt(&resource).unwrap_or([72.0, 72.0]),
    };
    let existing = resources
        .iter()
        .find(|(_, r)| **r == resource)
        .map(|(k, _)| k.clone());
    let key = existing.unwrap_or_else(|| {
        let key = format!("img{}", resources.len() + 1);
        resources.insert(key.clone(), resource);
        key
    });
    Some(DocumentRegion::Image(crate::image::ImageRegion {
        id: id.to_owned(),
        page: at.page,
        x: at.x,
        y: at.y,
        enabled: true,
        resource: key,
        size,
    }))
}

/// The canonical text of the math content of a plot expression or limit. `None` for an
/// empty (placeholder) expression.
fn plot_math_text(content: Node) -> Result<Option<String>, (String, String)> {
    if content.tag_name().name() == "placeholder" {
        return Ok(None);
    }
    let linear = math::statement_text(content).map_err(|e| {
        let (code, message) = e.describe();
        (code.to_owned(), message)
    })?;
    match parse_statement(&format!("plot_axis := {linear}")) {
        Ok(statement) => Ok(Some(
            print_statement(&statement)
                .strip_prefix("plot_axis := ")
                .unwrap_or(&linear)
                .to_owned(),
        )),
        Err(error) => Err((
            "math-unparsable".into(),
            format!("`{linear}` is not a valid plot expression: {error}"),
        )),
    }
}

/// The canonical text of a plot trace expression, from a `math` element. `None` for an
/// empty (placeholder) expression.
fn plot_expression(math: Node) -> Result<Option<String>, (String, String)> {
    let Some(content) = child_elements(math).into_iter().next() else {
        return Ok(None);
    };
    plot_math_text(content)
}

/// The expressions of one axis, in order.
fn axis_expressions<'a, 'b>(axis: Node<'a, 'b>) -> Vec<Node<'a, 'b>> {
    axis.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "plotEquation")
        .filter_map(|pe| {
            child_elements(pe)
                .into_iter()
                .find(|c| c.tag_name().name() == "math")
        })
        .collect()
}

/// The line pattern of a `traceStyle line-style` value, matched case-insensitively.
/// `None` means the trace draws no line and is not a pattern, so it never reaches here; `None`
/// as a return value is a value the model cannot place.
fn mcdx_line_pattern(value: &str) -> Option<crate::plot::TraceLinePattern> {
    use crate::plot::TraceLinePattern;
    match value.to_ascii_lowercase().as_str() {
        "solid" => Some(TraceLinePattern::Solid),
        "dash" => Some(TraceLinePattern::Dash),
        "dot" => Some(TraceLinePattern::Dot),
        "dashdot" => Some(TraceLinePattern::DashDot),
        _ => None,
    }
}

/// The trace type of a `traceStyle` text value, matched
/// case-insensitively. `None` is a text the model does not draw — the trace then stays a line
/// trace and the text is named in a note — and an empty text is the default type, which is not a
/// value the file stated.
fn mcdx_trace_kind(value: &str) -> Option<crate::plot::TraceKind> {
    use crate::plot::TraceKind;
    match value.to_ascii_lowercase().as_str() {
        "" | "lines" => Some(TraceKind::Lines),
        "stems" => Some(TraceKind::Stems),
        "bar" | "bars" => Some(TraceKind::Bars),
        "step" | "steps" => Some(TraceKind::Steps),
        _ => None,
    }
}

/// The marker shape of a `traceStyle symbol` value, matched case-insensitively. `none`
/// means no marker and is not a shape, so it never reaches here; `None` as a return value is a
/// value the model cannot place. the reference application's `point` is a small filled marker: the model's circle.
fn mcdx_marker_shape(value: &str) -> Option<crate::plot::TraceMarkerShape> {
    use crate::plot::TraceMarkerShape;
    match value.to_ascii_lowercase().as_str() {
        "circle" | "point" => Some(TraceMarkerShape::Circle),
        "square" => Some(TraceMarkerShape::Square),
        "diamond" => Some(TraceMarkerShape::Diamond),
        "cross" => Some(TraceMarkerShape::Cross),
        "x" => Some(TraceMarkerShape::X),
        "triangle-up" => Some(TraceMarkerShape::TriangleUp),
        "triangle-down" => Some(TraceMarkerShape::TriangleDown),
        _ => None,
    }
}

/// an `xyPlot` becomes a plot region, or the issue says why not.
fn mcdx_plot_color(value: &str) -> Option<String> {
    let hex = value.strip_prefix('#')?;
    let rgb = match hex.len() {
        6 => hex,
        8 => hex.get(2..)?, // the reference application stores ARGB; the plot model uses opaque CSS RGB.
        _ => return None,
    };
    rgb.bytes()
        .all(|byte| byte.is_ascii_hexdigit())
        .then(|| format!("#{rgb}"))
}

/// the specification : where the reference application draws one axis, from the `axisLine` child of `xAxis` or
/// `yAxis`.
///
/// `position="origin"` is the axis position `origin`; every other value, and an axis without an
/// `axisLine`, is the model's default `boundary`. The `origin-positioning` attribute of the `plot`
/// element is the reference application's own summary of the same thing and is not read: the per-axis value is the
/// precise one. The comparison is case-insensitive, like the
/// trace style values.
fn axis_position(axis: Node) -> crate::plot::PlotAxisPosition {
    child_elements(axis)
        .into_iter()
        .find(|n| n.tag_name().name() == "axisLine")
        .and_then(|line| line.attribute("position"))
        .filter(|value| value.eq_ignore_ascii_case("origin"))
        .map_or(crate::plot::PlotAxisPosition::Boundary, |_| {
            crate::plot::PlotAxisPosition::Origin
        })
}

fn plot_region(
    source: &Source,
    at: Placement,
    id: &str,
    page: &PageSetup,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    use crate::plot::{
        AxisLimit, AxisScale, PlotAxes, PlotAxis, PlotKind, PlotSpec, PlotTrace, TracePresentation,
    };
    let element = source.primary?;
    let fail = |report: &mut ImportReport, message: String| {
        report.issue("plot-not-imported", Some(&source.id), message);
        None
    };
    let Some(xy) = element
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "xyPlot")
    else {
        let kind = child_elements(element)
            .first()
            .map(|c| c.tag_name().name().to_owned())
            .unwrap_or_else(|| "empty".into());
        return fail(report, format!("`{kind}` plots are not imported"));
    };
    let axes_node = child_elements(xy)
        .into_iter()
        .find(|n| n.tag_name().name() == "axes");
    let axis = |name: &str| {
        axes_node.and_then(|a| {
            child_elements(a)
                .into_iter()
                .find(|n| n.tag_name().name() == name)
        })
    };
    let (Some(x_axis), Some(y_axis)) = (axis("xAxis"), axis("yAxis")) else {
        return fail(report, "the plot has no x or y axis".into());
    };
    let mut expressions = [Vec::new(), Vec::new()];
    for (slot, node) in [x_axis, y_axis].into_iter().enumerate() {
        for math in axis_expressions(node) {
            match plot_expression(math) {
                Ok(Some(text)) => expressions[slot].push(text),
                Ok(None) => {
                    return fail(
                        report,
                        "an empty axis expression (undefined x, default interval) is not imported"
                            .into(),
                    )
                }
                Err((code, message)) => {
                    report.issue(&code, Some(&source.id), message);
                    return None;
                }
            }
        }
    }
    let [xs, ys] = expressions;
    if xs.is_empty() || ys.is_empty() {
        return fail(report, "the plot has no trace expression".into());
    }
    let shared = xs.len() == 1 || xs.iter().all(|x| *x == xs[0]);
    if xs.len() != ys.len() && !shared {
        return fail(
            report,
            format!(
                "{} x expressions and {} y expressions cannot be paired",
                xs.len(),
                ys.len()
            ),
        );
    }
    let styles: Vec<Node> = xy
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "traceStyle")
        .collect();
    // the specification : the text of `traceStyle` is the type the reference application draws. A text the model
    // does not draw keeps the trace a line trace and is named in one note.
    let mut kinds = Vec::with_capacity(ys.len());
    for (i, _) in ys.iter().enumerate() {
        let text = styles
            .get(i)
            .and_then(|style| style.text())
            .map(str::trim)
            .unwrap_or("");
        match mcdx_trace_kind(text) {
            Some(kind) => kinds.push(kind),
            None => {
                report.note(
                    "plot-trace-type-dropped",
                    Some(&source.id),
                    format!("trace {} has the trace type `{text}`, which is not drawn: it is imported as a line", i + 1),
                );
                kinds.push(crate::plot::TraceKind::Lines);
            }
        }
    }
    let traces: Vec<PlotTrace> = ys
        .iter()
        .enumerate()
        .map(|(i, y)| {
            let style = styles.get(i);
            let line_style = style.and_then(|s| s.attribute("line-style"));
            let symbol = style.and_then(|s| s.attribute("symbol")).unwrap_or("none");
            // line style `None` means the trace draws no line; a symbol other than `none`
            // means it draws markers.
            let line_enabled = !line_style.is_some_and(|value| value.eq_ignore_ascii_case("none"));
            let marker_enabled = !symbol.eq_ignore_ascii_case("none");
            let line_color = style
                .and_then(|s| s.attribute("color"))
                .and_then(mcdx_plot_color);
            // A weight outside the model's 0.5 to 6 pt range keeps the default and is named in the
            // note.
            let line_width = style
                .and_then(|s| s.attribute("line-weight"))
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| (0.5..=6.0).contains(value))
                .unwrap_or(crate::plot::TraceLineStyle::default().width);
            PlotTrace {
                z: String::new(),
                id: format!("trace-{}", i + 1),
                x: if shared { xs[0].clone() } else { xs[i].clone() },
                y: y.clone(),
                y_axis: crate::plot::TraceYAxis::Left,
                // Neither a line nor a symbol is a line: the model has no hidden trace.
                presentation: match (line_enabled, marker_enabled) {
                    (true, true) => TracePresentation::LineMarkers,
                    (false, true) => TracePresentation::Markers,
                    _ => TracePresentation::Line,
                },
                kind: kinds[i],
                line: crate::plot::TraceLineStyle {
                    // A line style the model cannot place is solid, and the note names the field.
                    style: line_style
                        .and_then(mcdx_line_pattern)
                        .unwrap_or(crate::plot::TraceLinePattern::Solid),
                    width: line_width,
                    color: line_color.clone(),
                },
                marker: crate::plot::TraceMarkerStyle {
                    // A symbol the model cannot place is a circle, and the note names the field.
                    shape: mcdx_marker_shape(symbol)
                        .unwrap_or(crate::plot::TraceMarkerShape::Circle),
                    // the reference application's `traceStyle` stores no marker size we know of:
                    // the model default stands.
                    size: crate::plot::TraceMarkerStyle::default().size,
                    // the reference application stores one colour per trace, so a drawn marker keeps the trace colour.
                    color: if marker_enabled { line_color } else { None },
                },
                // the reference application's legend settings are not imported: hidden, as a new trace.
                show_in_legend: false,
                legend_label: String::new(),
            }
        })
        .collect();
    // a limit is the number the author typed, or the expression itself, which keeps
    // following its definition after the import.
    let mut axis_spec = |node: Node, which: &str| {
        let domain = child_elements(node)
            .into_iter()
            .find(|n| n.tag_name().name() == "xyDomain");
        let log = domain.is_some_and(|d| d.attribute("scale-type") == Some("logarithmic"));
        let mut limit = |name: &str| -> Option<AxisLimit> {
            let value = child_elements(domain?)
                .into_iter()
                .find(|n| n.tag_name().name() == name)?;
            let content = child_elements(value).into_iter().next()?;
            if content.tag_name().name() == "real" {
                return content
                    .text()
                    .and_then(|text| text.trim().parse::<f64>().ok())
                    .filter(|number| number.is_finite())
                    .map(AxisLimit::Value);
            }
            match plot_math_text(content) {
                Ok(Some(text)) => Some(AxisLimit::Expression(text)),
                // A `placeholder` (or no content) is an automatic end.
                Ok(None) => None,
                Err((code, message)) => {
                    report.issue(&code, Some(&source.id), message);
                    None
                }
            }
        };
        let (mut min, mut max) = (limit("startValue"), limit("endValue"));
        let number = |limit: &Option<AxisLimit>| limit.as_ref().and_then(AxisLimit::value);
        let bad = number(&min).zip(number(&max)).is_some_and(|(a, b)| a >= b)
            || (log
                && (number(&min).is_some_and(|v| v <= 0.0)
                    || number(&max).is_some_and(|v| v <= 0.0)));
        if bad {
            min = None;
            max = None;
            report.note(
                "plot-limits-dropped",
                Some(&source.id),
                format!("the {which} axis limits are not usable (unordered or not positive on a log axis)"),
            );
        }
        PlotAxis {
            scale: if log {
                AxisScale::Log10
            } else {
                AxisScale::Linear
            },
            // the axis line the reference application wrote tells where the axis is drawn.
            position: axis_position(node),
            unit: None,
            min,
            max,
            title: String::new(),
            show_grid: true,
        }
    };
    let axes = PlotAxes {
        x: axis_spec(x_axis, "x"),
        y: axis_spec(y_axis, "y"),
        y2: Box::new(PlotAxis::default()),
    };
    let size = match (
        attr_f64(source.region, "width").or_else(|| attr_f64(source.region, "actualWidth")),
        attr_f64(source.region, "height").or_else(|| attr_f64(source.region, "actualHeight")),
    ) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => [
            round2((w * PX_TO_PT).clamp(crate::plot::MIN_PLOT_WIDTH, page.content_width())),
            round2((h * PX_TO_PT).max(crate::plot::MIN_PLOT_HEIGHT)),
        ],
        _ => [
            crate::plot::DEFAULT_PLOT_WIDTH,
            crate::plot::DEFAULT_PLOT_HEIGHT,
        ],
    };
    let spec = PlotSpec {
        version: crate::plot::PLOT_VERSION,
        kind: PlotKind::Xy,
        // The plot title and the axis labels of a `.mcdx` plot are not imported:
        // nothing is guessed.
        title: String::new(),
        size,
        axes,
        grid_spacing: None,
        legend_position: crate::plot::LegendPosition::default(),
        legend_font_size: None,
        traces,
        reference_lines: Vec::new(),
    };
    if let Err(message) = spec.validate() {
        return fail(report, message);
    }
    report.note(
        "plot-style-dropped",
        None,
        "plot titles, legend settings, grids, tick settings, axis labels, reference markers, number formats, \
         the number of points, a marker size, colors or line weights outside the model's range and unknown \
         line styles or symbols are not imported; a trace with neither a line nor a symbol is imported as a line",
    );
    Some(DocumentRegion::Plot(Box::new(crate::plot::PlotRegion {
        id: id.to_owned(),
        page: at.page,
        x: at.x,
        y: at.y,
        enabled: true,
        plot: spec,
        view: None,
    })))
}

fn text_region<R: Read + std::io::Seek>(
    source: &Source,
    at: Placement,
    id: &str,
    page: &PageSetup,
    rels: &BTreeMap<String, String>,
    package: &mut zip::ZipArchive<R>,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let element = source.primary?;
    let xaml = element
        .attribute("item-idref")
        .and_then(|idref| rels.get(idref))
        .and_then(|part| read_bytes(package, part))
        .and_then(|bytes| {
            let mut inner = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
            let name = (0..inner.len()).find_map(|i| {
                let file = inner.by_index(i).ok()?;
                let name = file.name().ok()?.into_owned();
                name.to_ascii_lowercase()
                    .ends_with("document.xaml")
                    .then_some(name)
            })?;
            read_text(&mut inner, &name)
        });
    let Some(xaml) = xaml else {
        report.issue(
            "text-unreadable",
            Some(&source.id),
            "the text part of the region is missing or unreadable",
        );
        return None;
    };
    // Inline math regions, in text order.
    let inline: Vec<Result<String, String>> = child_elements(element)
        .into_iter()
        .find(|n| n.tag_name().name() == "regions")
        .map(|list| {
            child_elements(list)
                .into_iter()
                .filter(|n| n.tag_name().name() == "region")
                .map(|r| {
                    child_elements(r)
                        .into_iter()
                        .find(|n| n.tag_name().name() == "math")
                        .map(|m| {
                            math_statement(m)
                                .map_err(|(code, message)| format!("{code}: {message}"))
                        })
                        .unwrap_or_else(|| Err("not math".into()))
                })
                .collect()
        })
        .unwrap_or_default();
    let (rich, outcome) = text::convert(&xaml, &inline);
    if outcome.math_not_placed {
        report.issue(
            "inline-math-not-placed",
            Some(&source.id),
            "the number of inline math regions differs from the math slots in the text; none was placed",
        );
    }
    for (index, reason) in outcome.math_issues {
        report.issue(
            "math-unsupported",
            Some(&source.id),
            format!("inline math {} not imported: {reason}", index + 1),
        );
    }
    if outcome.picture_dropped {
        report.issue(
            "picture-not-imported",
            Some(&source.id),
            "an image inside the text is not imported",
        );
    }
    if outcome.style_dropped {
        report.note(
            "text-style-dropped",
            None,
            "the font family and indentation of text are not imported",
        );
    }
    let linear = rich.print();
    if linear.trim().is_empty() {
        return None;
    }
    let block = element.attribute("is-text-block") == Some("true");
    let width = attr_f64(source.region, "width")
        .or_else(|| attr_f64(source.region, "actualWidth"))
        .map(|px| round2(px * PX_TO_PT))
        .filter(|w| *w > 0.0 && *w < page.content_width() - 0.5);
    // RichText::parse is the reader of what `print` wrote: the stored form is canonical.
    let canonical = RichText::parse(&linear).print();
    Some(DocumentRegion::Text(TextRegion {
        id: id.to_owned(),
        page: at.page,
        x: if block { page.margins.left } else { at.x },
        y: at.y,
        enabled: true,
        width: if block { None } else { width },
        full_width: block,
        background: outcome.background.clone(),
        language: None,
        text: canonical,
    }))
}

#[cfg(test)]
mod tests {
    use super::{math_font_of, mcdx_line_pattern, mcdx_marker_shape, opaque_color};
    use crate::plot::{TraceLinePattern, TraceMarkerShape};

    /// a `formattingOverride` background is the highlight and its size the math font size; a
    /// transparent colour, the default size and a font family are not keys.
    #[test]
    fn a_math_override_becomes_the_math_font_keys() {
        let parse = |xml: &str| {
            let doc = roxmltree::Document::parse(xml).unwrap();
            math_font_of(doc.root_element(), doc.root_element())
        };
        let keys = parse(
            r##"<math><formattingOverride BackgroundColor="#80FF80" FontSize="8" FontFamily="X"/></math>"##,
        );
        assert_eq!(
            keys.get("math-font.highlight").map(String::as_str),
            Some("#80ff80")
        );
        assert_eq!(keys.get("math-font.size").map(String::as_str), Some("8"));
        let alpha = parse(r##"<math><formattingOverride BackgroundColor="#FFFFF200"/></math>"##);
        assert_eq!(
            alpha.get("math-font.highlight").map(String::as_str),
            Some("#fff200")
        );
        assert!(parse(
            r##"<math><formattingOverride BackgroundColor="#00FFFFFF" FontSize="11"/></math>"##
        )
        .is_empty());
        assert!(parse("<math/>").is_empty());
        assert_eq!(opaque_color("#FF2E3192").as_deref(), Some("#2e3192"));
        assert_eq!(opaque_color("#fdfdd5").as_deref(), Some("#fdfdd5"));
        assert_eq!(opaque_color("Red"), None);
    }

    /// every `line-style` value the corpus shows, plus dash-dot and the case variants. A
    /// value the model cannot place is `None`, so the caller keeps the default and names it in the
    /// note instead of guessing.
    #[test]
    fn trace_style_line_patterns_are_matched_case_insensitively() {
        for (value, pattern) in [
            ("Solid", TraceLinePattern::Solid),
            ("solid", TraceLinePattern::Solid),
            ("Dash", TraceLinePattern::Dash),
            ("Dot", TraceLinePattern::Dot),
            ("DashDot", TraceLinePattern::DashDot),
            ("dashdot", TraceLinePattern::DashDot),
        ] {
            assert_eq!(mcdx_line_pattern(value), Some(pattern), "`{value}`");
        }
        for value in ["None", "none", "LongDash", ""] {
            assert_eq!(mcdx_line_pattern(value), None, "`{value}`");
        }
    }

    /// every `symbol` value, including the reference application's `point` (the model's circle), and the
    /// fallback for a name the model does not know.
    #[test]
    fn trace_style_marker_shapes_are_matched_case_insensitively() {
        for (value, shape) in [
            ("Circle", TraceMarkerShape::Circle),
            ("point", TraceMarkerShape::Circle),
            ("Square", TraceMarkerShape::Square),
            ("diamond", TraceMarkerShape::Diamond),
            ("Cross", TraceMarkerShape::Cross),
            ("x", TraceMarkerShape::X),
            ("Triangle-Up", TraceMarkerShape::TriangleUp),
            ("triangle-down", TraceMarkerShape::TriangleDown),
        ] {
            assert_eq!(mcdx_marker_shape(value), Some(shape), "`{value}`");
        }
        for value in ["none", "None", "star", ""] {
            assert_eq!(mcdx_marker_shape(value), None, "`{value}`");
        }
    }
}
