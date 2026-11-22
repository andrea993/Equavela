//! Import of legacy `.xmcd` worksheets (the XML format of the reference application before
//! `.mcdx`) into an Equavela worksheet.
//!
//! The math language of an `.xmcd` is the ancestor of the `.mcdx` one, so the math goes through the
//! `.mcdx` translator (`math.rs`), which knows the `.xmcd` elements too. What
//! differs is around it: one XML file instead of a package, geometry in points, text as inline XML,
//! pictures and plots as base64 items, header and footer as RTF.

use super::{
    attr_f64, calculation_settings, child_elements, math, place, round2, ImportError, ImportReport,
    Imported, Placement, Source, PX_TO_PT,
};
use crate::ast::{
    Expr, ExprKind, Ident, Name, Statement, StatementKind, Stmt, StmtKind, Target, TargetKind,
};
use crate::layout::{Margins, PageLine, PageSetup, TextRegion};
use crate::project::{DocumentId, DocumentRegion, ProjectDocument};
use crate::richtext::{MathRun, Paragraph, ParagraphAlign, ParagraphStyle, RichText, Run, TextRun};
use crate::syntax::{parse_statement, print_statement};
use crate::worksheet_writer::write_document;
use roxmltree::{Document, Node};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::Path;

/// The namespace every `.xmcd` worksheet element starts with. It is the format's own
/// internal name, kept in this one constant (GitHub ).
const WORKSHEET_NAMESPACE: &str = "http://schemas.mathsoft.com/worksheet";

/// Unit names of our table that are not units of the same meaning in an `.xmcd`: `g` is
/// the acceleration of gravity there, the gram here.
const NOT_UNITS: &[&str] = &["g"];

/// Imports the `.xmcd` at `path`.
pub fn import_xmcd(path: &Path) -> Result<Imported, ImportError> {
    let bytes = std::fs::read(path).map_err(|error| ImportError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    import_xmcd_in(&bytes, &name, path.parent())
}

/// Imports an `.xmcd` held in memory; `name` is used in messages only. Includes are not looked
/// up on disk.
pub fn import_xmcd_bytes(bytes: &[u8], name: &str) -> Result<Imported, ImportError> {
    import_xmcd_in(bytes, name, None)
}

/// The import, with the folder of the file when it has one: included worksheets are found from it.
fn import_xmcd_in(bytes: &[u8], name: &str, base: Option<&Path>) -> Result<Imported, ImportError> {
    // an `.xmcdz` is the same XML compressed with gzip.
    let unpacked;
    let bytes = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_end(&mut out)
            .map_err(|error| ImportError::NotXmcd {
                name: name.to_owned(),
                reason: format!("the compressed file cannot be read: {error}"),
            })?;
        unpacked = out;
        &unpacked[..]
    } else {
        bytes
    };
    let not_xmcd = |reason: &str| ImportError::NotXmcd {
        name: name.to_owned(),
        reason: reason.to_owned(),
    };
    let text = std::str::from_utf8(bytes).map_err(|_| not_xmcd("the file is not UTF-8 XML"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let doc = Document::parse(text).map_err(|error| ImportError::Xml {
        name: name.to_owned(),
        message: error.to_string(),
    })?;
    let root = doc.root_element();
    if root.tag_name().name() != "worksheet"
        || !root
            .tag_name()
            .namespace()
            .is_some_and(|ns| ns.starts_with(WORKSHEET_NAMESPACE))
    {
        return Err(not_xmcd("the root element is not a worksheet"));
    }
    let mut report = ImportReport::default();
    let items = binary_items(root);

    let settings_node = child(root, "settings");
    let mut page = settings_node
        .and_then(|s| s.descendants().find(|n| n.has_tag_name_local("pageModel")))
        .map(|model| page_setup(model, &mut report))
        .unwrap_or_default();
    if let Some(model) =
        settings_node.and_then(|s| s.descendants().find(|n| n.has_tag_name_local("pageModel")))
    {
        page.header = page_line(child(model, "header"), "header", &mut report);
        page.footer = page_line(child(model, "footer"), "footer", &mut report);
    }
    let settings = settings_node
        .and_then(|s| {
            s.descendants()
                .find(|n| n.has_tag_name_local("calculation"))
        })
        .map(|calc| calculation_settings(&text[calc.range()], &mut report))
        .unwrap_or_default();
    let styles = settings_node.map(text_styles).unwrap_or_default();

    let mut resources = crate::image::Resources::new();
    let (regions, page_breaks) = convert_regions(
        root,
        base,
        &page,
        &styles,
        &items,
        &mut report,
        &mut resources,
    );

    let document = ProjectDocument {
        id: DocumentId::new("Imported.eqv").expect("a plain file name is a valid id"),
        content_hash: "import".into(),
        settings,
        environment: None,
        page,
        result_formats: std::mem::take(&mut report.region_formats),
        math_breaks: Default::default(),
        resources,
        assets: Default::default(),
        page_breaks,
        regions: regions.into_iter().map(std::sync::Arc::new).collect(),
    };
    let text = write_document(&document).map_err(|error| ImportError::Write(error.to_string()))?;
    let text = crate::worksheet_file::rebind_plain_names(&text).map_err(ImportError::Write)?;
    Ok(Imported { text, report })
}

trait LocalName {
    fn has_tag_name_local(&self, name: &str) -> bool;
}

impl LocalName for Node<'_, '_> {
    fn has_tag_name_local(&self, name: &str) -> bool {
        self.is_element() && self.tag_name().name() == name
    }
}

fn child<'a, 'b>(node: Node<'a, 'b>, name: &str) -> Option<Node<'a, 'b>> {
    child_elements(node)
        .into_iter()
        .find(|c| c.tag_name().name() == name)
}

// ---- binary items ------------------------------------------------------------------------

/// `binaryContent/item` by `item-id`: the base64 text and whether it is gzip-compressed.
fn binary_items<'a>(root: Node<'a, '_>) -> HashMap<String, (bool, &'a str)> {
    let mut items = HashMap::new();
    if let Some(content) = child(root, "binaryContent") {
        for item in child_elements(content) {
            if let (Some(id), Some(text)) = (item.attribute("item-id"), item.text()) {
                let gzip = item.attribute("content-encoding") == Some("gzip");
                items.insert(id.to_owned(), (gzip, text));
            }
        }
    }
    items
}

fn item_bytes(items: &HashMap<String, (bool, &str)>, id: &str) -> Option<Vec<u8>> {
    let (gzip, text) = items.get(id)?;
    let raw = base64_decode(text)?;
    if !gzip {
        return Some(raw);
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(raw.as_slice())
        .read_to_end(&mut out)
        .ok()?;
    Some(out)
}

/// Standard base64 with the line breaks the file writes; `None` for anything else.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for c in text.bytes() {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            break;
        }
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

// ---- page --------------------------------------------------------------------------------

/// the page size and margins, already in points.
fn page_setup(model: Node, report: &mut ImportReport) -> PageSetup {
    let landscape = model
        .attribute("orientation")
        .is_some_and(|o| o.eq_ignore_ascii_case("landscape"));
    // Windows paper codes (`DMPAPER_*`).
    let named = match model.attribute("paper-code").unwrap_or("9") {
        "1" => Some("Letter"),
        "5" => Some("Legal"),
        "8" => Some("A3"),
        "9" => Some("A4"),
        "11" => Some("A5"),
        _ => None,
    };
    let width = attr_f64(model, "page-width").filter(|w| *w > 0.0);
    let height = attr_f64(model, "page-height").filter(|h| *h > 0.0);
    let mut page = match (
        named.and_then(|n| PageSetup::named(n, landscape)),
        width,
        height,
    ) {
        (Some(page), _, _) => page,
        (None, Some(w), Some(h)) => PageSetup {
            size: "custom".into(),
            width: round2(w),
            height: round2(h),
            ..PageSetup::default()
        },
        _ => {
            report.issue(
                "page-size-unknown",
                None,
                format!(
                    "paper code `{}` is not known; A4 is used",
                    model.attribute("paper-code").unwrap_or("")
                ),
            );
            PageSetup::named("A4", landscape).expect("A4 is known")
        }
    };
    if let Some(m) = child(model, "margins") {
        let side = |name: &str, default: f64| attr_f64(m, name).map(round2).unwrap_or(default);
        page.margins = Margins {
            left: side("left", page.margins.left),
            top: side("top", page.margins.top),
            right: side("right", page.margins.right),
            bottom: side("bottom", page.margins.bottom),
        };
    }
    page
}

/// one header or footer, three RTF slots, to a page line.
fn page_line(band: Option<Node>, which: &str, report: &mut ImportReport) -> PageLine {
    let mut line = PageLine::default();
    let Some(band) = band else {
        return line;
    };
    for (slot, target) in [
        ("left", &mut line.left),
        ("center", &mut line.center),
        ("right", &mut line.right),
    ] {
        let Some(rtf) = child(band, slot).and_then(|n| n.text()) else {
            continue;
        };
        let plain = rtf_plain_text(rtf);
        *target = page_fields(&plain, which, report);
    }
    line
}

/// The `{x}` fields of a header or footer to our tokens.
fn page_fields(text: &str, which: &str, report: &mut ImportReport) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let field = &after[..end];
        match field {
            "n" => out.push_str("{page}"),
            "f" => out.push_str("{file}"),
            "d" => out.push_str("{date}"),
            "fd" => {
                out.push_str("{date}");
                report.note(
                    "page-line-format-dropped",
                    Some(which),
                    "the field of the date the file was saved prints the date the page is drawn",
                );
            }
            other => report.note(
                "page-line-field-unknown",
                Some(which),
                format!("the field `{{{other}}}` has no token and is left out"),
            ),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The plain text of a small RTF document: destinations such as the font and colour tables
/// are skipped, control words are dropped, `\'hh` is a Windows-1252 byte and `\uN` a character.
fn rtf_plain_text(rtf: &str) -> String {
    let chars: Vec<char> = rtf.chars().collect();
    let mut out = String::new();
    // Per group depth: whether the group is skipped.
    let mut skip: Vec<bool> = vec![false];
    let mut i = 0;
    let mut skip_after_unicode = 0usize;
    let skipped = |skip: &Vec<bool>| skip.last().copied().unwrap_or(false);
    while i < chars.len() {
        let c = chars[i];
        match c {
            '{' => {
                let parent = skipped(&skip);
                skip.push(parent);
                i += 1;
            }
            '}' => {
                skip.pop();
                i += 1;
            }
            '\\' => {
                let Some(&next) = chars.get(i + 1) else {
                    break;
                };
                if next == '\'' {
                    let hex: String = chars.iter().skip(i + 2).take(2).collect();
                    if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                        if !skipped(&skip) && skip_after_unicode == 0 {
                            out.push(windows_1252(byte));
                        }
                        skip_after_unicode = skip_after_unicode.saturating_sub(1);
                    }
                    i += 4;
                    continue;
                }
                if !next.is_ascii_alphabetic() {
                    // A control symbol: `\{`, `\}`, `\\` are the characters, `\*` marks a
                    // destination to skip, the others are dropped.
                    if next == '*' {
                        if let Some(last) = skip.last_mut() {
                            *last = true;
                        }
                    } else if matches!(next, '{' | '}' | '\\') && !skipped(&skip) {
                        out.push(next);
                    }
                    i += 2;
                    continue;
                }
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_ascii_alphabetic() {
                    j += 1;
                }
                let word: String = chars[i + 1..j].iter().collect();
                let mut number = String::new();
                if j < chars.len() && (chars[j] == '-' || chars[j].is_ascii_digit()) {
                    number.push(chars[j]);
                    j += 1;
                    while j < chars.len() && chars[j].is_ascii_digit() {
                        number.push(chars[j]);
                        j += 1;
                    }
                }
                if j < chars.len() && chars[j] == ' ' {
                    j += 1;
                }
                match word.as_str() {
                    "fonttbl" | "colortbl" | "stylesheet" | "info" | "pict" => {
                        if let Some(last) = skip.last_mut() {
                            *last = true;
                        }
                    }
                    "par" | "line" | "tab" if !skipped(&skip) => out.push(' '),
                    "u" if !skipped(&skip) => {
                        if let Ok(code) = number.parse::<i32>() {
                            let code = if code < 0 { code + 65536 } else { code };
                            if let Some(ch) = char::from_u32(code as u32) {
                                out.push(ch);
                            }
                            skip_after_unicode = 1;
                        }
                    }
                    _ => {}
                }
                i = j;
            }
            '\r' | '\n' => i += 1,
            _ => {
                if !skipped(&skip) {
                    if skip_after_unicode > 0 {
                        skip_after_unicode -= 1;
                    } else {
                        out.push(c);
                    }
                }
                i += 1;
            }
        }
    }
    out
}

/// A Windows-1252 byte as a character.
fn windows_1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    match byte {
        0x80..=0x9f => HIGH[(byte - 0x80) as usize],
        b => b as char,
    }
}

// ---- regions -----------------------------------------------------------------------------

/// A `region` element as a placement source. `.xmcd` geometry is in points; the placement of the
/// `.mcdx` importer counts in 1/96 inch, so the values are converted on the way in.
fn source_of<'a, 'b>(region: Node<'a, 'b>) -> Source<'a, 'b> {
    let px = |name: &str| attr_f64(region, name).map(|v| v / PX_TO_PT);
    Source {
        region,
        id: region.attribute("region-id").unwrap_or("?").to_owned(),
        primary: child_elements(region)
            .into_iter()
            .find(|c| c.tag_name().name() != "rendering"),
        top: px("top"),
        left: px("left").unwrap_or(0.0),
        height: px("height"),
    }
}

fn kind_of(source: &Source) -> &'static str {
    match source.primary.map(|p| p.tag_name().name()) {
        Some("math") => "math",
        Some("text") => "text",
        Some("plot") => "plot",
        Some("pageBreak") => "pageBreak",
        Some("picture") | Some("png") => "picture",
        Some("area") => "area",
        Some("reference") => "include",
        _ => "other",
    }
}

fn convert_regions(
    root: Node,
    base: Option<&Path>,
    page: &PageSetup,
    styles: &TextStyles,
    items: &HashMap<String, (bool, &str)>,
    report: &mut ImportReport,
    resources: &mut crate::image::Resources,
) -> (Vec<DocumentRegion>, Vec<crate::layout::PageBreak>) {
    let Some(list) = child(root, "regions") else {
        return (Vec::new(), Vec::new());
    };
    // an area's regions take their place in the flow; the area itself is a band of the
    // reference application's own that the model draws differently.
    let mut sources: Vec<Source> = Vec::new();
    for region in child_elements(list)
        .into_iter()
        .filter(|n| n.tag_name().name() == "region")
    {
        let source = source_of(region);
        if kind_of(&source) == "area" {
            let area = source.primary.expect("an area has its element");
            report.note(
                "area-flattened",
                Some(&source.id),
                format!(
                    "the area `{}` is imported as its regions, without the area itself",
                    area.attribute("name").unwrap_or("")
                ),
            );
            sources.extend(
                child_elements(area)
                    .into_iter()
                    .filter(|n| n.tag_name().name() == "region")
                    .map(source_of),
            );
            continue;
        }
        sources.push(source);
    }
    let (placements, page_breaks) = place(&sources, page, report);
    let definitions = Definitions::of(&sources);
    let mut regions = Vec::new();
    for (index, source) in sources.iter().enumerate() {
        let kind = kind_of(source);
        if kind == "pageBreak" {
            continue;
        }
        report.regions_total += 1;
        let id = format!("r{}", regions.len() + 1);
        let mut at = placements[index];
        // the reference application lines regions up, and orders their calculation, by
        // the anchor of their math (`align-y`), not by the top of the box; a stored `y` is that
        // anchor too. A tall result beside its definition therefore stays
        // after it.
        if kind == "math" {
            if let (Some(top), Some(anchor)) = (
                attr_f64(source.region, "top"),
                attr_f64(source.region, "align-y"),
            ) {
                at.y = round2(at.y + (anchor - top));
            }
        }
        let created = match kind {
            "math" => math_region(source, at, &id, &definitions, report),
            "text" => text_region(source, at, &id, page, styles, &definitions, report),
            "picture" => picture_region(source, at, &id, items, resources, report),
            "include" => include_region(source, at, &id, base, report),
            "plot" => {
                let item = source
                    .primary
                    .and_then(|p| p.attribute("item-idref"))
                    .and_then(|r| item_bytes(items, r));
                super::xmcd_plot::plot_region(
                    source,
                    at,
                    &id,
                    page,
                    item,
                    &definitions.units(),
                    report,
                )
            }
            _ => {
                other_region(source, report);
                None
            }
        };
        if let Some(region) = created {
            match &region {
                DocumentRegion::Math(m) => {
                    report
                        .source_regions
                        .push((m.id.clone(), source.id.clone()));
                }
                // A nested region whose math was not imported shifts the runs: no pairing then.
                DocumentRegion::Text(t)
                    if !report.issues.iter().any(|i| {
                        i.region.as_deref() == Some(source.id.as_str())
                            && i.message.starts_with("inline math")
                    }) =>
                {
                    for (k, nested) in inline_sources(source).into_iter().enumerate() {
                        report
                            .source_regions
                            .push((crate::richtext::inline_region_id(&t.id, k), nested));
                    }
                }
                _ => {}
            }
            regions.push(region);
            report.regions_imported += 1;
        }
    }
    (regions, page_breaks)
}

/// the file an include names, found from the folder of the importing file. The stored path
/// is the absolute path on the author's machine, so the longest end of it that exists below a
/// folder that holds the importing file wins.
fn find_include(href: &str, base: &Path) -> Option<std::path::PathBuf> {
    let parts: Vec<&str> = href
        .split(['\\', '/'])
        .filter(|p| !p.is_empty() && !p.ends_with(':'))
        .collect();
    for start in 0..parts.len() {
        for folder in base.ancestors().take(8) {
            let mut candidate = folder.to_path_buf();
            candidate.extend(&parts[start..]);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // A library moved to another folder: the same file name in the nearest folder tree that
    // holds the importing file.
    let name = parts.last()?.to_lowercase();
    base.ancestors()
        .take(4)
        .find_map(|folder| find_by_name(folder, &name, 6))
}

/// the newest version of a numbered library (`Lib07.xmcd` missing, `Lib08.xmcd` present):
/// the same name with the highest number, in the nearest folder tree that holds one.
fn newest_version(href: &str, base: &Path) -> Option<std::path::PathBuf> {
    let name = href.rsplit(['\\', '/']).next()?.to_lowercase();
    let (stem, extension) = name.rsplit_once('.')?;
    let prefix = stem.trim_end_matches(|c: char| c.is_ascii_digit());
    if prefix.len() == stem.len() || prefix.is_empty() {
        return None;
    }
    let version = |path: &Path| -> Option<u32> {
        let file = path.file_name()?.to_string_lossy().to_lowercase();
        let (s, e) = file.rsplit_once('.')?;
        let digits = s.strip_prefix(prefix)?;
        (e == extension && !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
            .then(|| digits.parse().ok())
            .flatten()
    };
    base.ancestors().take(4).find_map(|folder| {
        let mut found = Vec::new();
        collect_files(folder, 6, &mut found);
        found
            .into_iter()
            .filter_map(|p| version(&p).map(|v| (v, p)))
            .max_by_key(|(v, _)| *v)
            .map(|(_, p)| p)
    })
}

fn collect_files(folder: &Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            out.push(path);
        } else if depth > 0 && path.is_dir() {
            collect_files(&path, depth - 1, out);
        }
    }
}

fn find_by_name(folder: &Path, name: &str, depth: usize) -> Option<std::path::PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(folder).ok()?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in &entries {
        let path = entry.path();
        if path.is_file() && entry.file_name().to_string_lossy().to_lowercase() == name {
            return Some(path);
        }
    }
    if depth == 0 {
        return None;
    }
    entries
        .iter()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .find_map(|dir| find_by_name(&dir, name, depth - 1))
}

/// `to` relative to the folder `from`, with `/` separators.
fn relative_path(from: &Path, to: &Path) -> String {
    let from: Vec<_> = from.components().collect();
    let to: Vec<_> = to.components().collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".into(); from.len() - common];
    parts.extend(
        to[common..]
            .iter()
            .map(|c| c.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// a `reference` region becomes an include of the same worksheet imported as `.eqv`.
fn include_region(
    source: &Source,
    at: Placement,
    id: &str,
    base: Option<&Path>,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let element = source.primary?;
    let href = child(element, "originRef")
        .or_else(|| child(element, "link"))
        .and_then(|l| l.attribute("href"))
        .unwrap_or("")
        .to_owned();
    let file_name = href
        .rsplit(['\\', '/'])
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("included.xmcd");
    let as_eqv = |name: &str| match name.rsplit_once('.') {
        Some((stem, _)) => format!("{stem}.eqv"),
        None => format!("{name}.eqv"),
    };
    let mut found = base.and_then(|b| find_include(&href, b).map(|f| (b, f)));
    if found.is_none() {
        if let Some((b, newer)) = base.and_then(|b| newest_version(&href, b).map(|f| (b, f))) {
            report.issue(
                "include-version-substituted",
                Some(&source.id),
                format!(
                    "the included worksheet `{href}` was not found; its newest version `{}` is included instead",
                    newer.display()
                ),
            );
            found = Some((b, newer));
        }
    }
    let path = match &found {
        Some((b, file)) => {
            let path = as_eqv(&relative_path(b, file));
            report.includes.push((path.clone(), file.clone()));
            report.note(
                "include-needs-import",
                Some(&source.id),
                format!(
                    "the included worksheet `{}` is imported as an include of `{path}`; import it too and save it there",
                    file.display()
                ),
            );
            path
        }
        None => {
            let path = as_eqv(file_name);
            report.issue(
                "include-not-found",
                Some(&source.id),
                format!(
                    "the included worksheet `{href}` was not found; the include names `{path}`"
                ),
            );
            path
        }
    };
    Some(DocumentRegion::Include(crate::project::IncludeRegion {
        id: id.to_owned(),
        page: at.page,
        x: at.x,
        y: at.y,
        enabled: true,
        path,
    }))
}

/// what is reported for the region kinds that are not imported.
fn other_region(source: &Source, report: &mut ImportReport) {
    let element = source.primary.map(|p| p.tag_name().name()).unwrap_or("");
    let (code, message) = match element {
        "reference" => (
            "include-not-imported",
            format!(
                "include of `{}` is not imported",
                source
                    .primary
                    .and_then(|p| child(p, "originRef"))
                    .and_then(|l| l.attribute("href"))
                    .unwrap_or("?")
            ),
        ),
        "component" => (
            "component-not-imported",
            "components (spreadsheet, data and scripted components) are not imported".into(),
        ),
        "ole" => ("ole-not-imported", "OLE objects are not imported".into()),
        "metafile" => (
            "picture-not-imported",
            "Windows metafile pictures cannot be drawn on every platform and are not imported"
                .into(),
        ),
        "link" => (
            "link-not-imported",
            format!(
                "the hyperlink to `{}` is not imported",
                source
                    .primary
                    .and_then(|p| p.attribute("href"))
                    .unwrap_or("?")
            ),
        ),
        other => (
            "region-unknown",
            format!("unknown region content `{other}`"),
        ),
    };
    report.issue(code, Some(&source.id), message);
}

// ---- math --------------------------------------------------------------------------------

/// The names the worksheet defines, for the implicit units of .
struct Definitions {
    /// The unit names that stay units: our table less what the worksheet defines anywhere (a
    /// definition, a function head, an element assignment, a parameter, a local variable, a
    /// range variable).
    units: std::rc::Rc<HashSet<String>>,
    /// the range variables defined so far, in reading order, with the range each holds.
    ranges: std::cell::RefCell<Vec<(Name, Expr)>>,
    /// the names a definition of an earlier region gives a value to.
    valued: std::cell::RefCell<HashSet<Name>>,
}

impl Definitions {
    fn of(sources: &[Source]) -> Definitions {
        let mut everywhere = HashSet::new();
        for source in sources {
            if let Some(primary) = source.primary {
                for node in primary.descendants().filter(|n| n.is_element()) {
                    defined_names(node, &mut everywhere);
                }
            }
        }
        let units = crate::units::unit_names()
            .into_iter()
            .filter(|n| !everywhere.contains(n) && !NOT_UNITS.contains(&n.as_str()))
            .collect();
        Definitions {
            units: std::rc::Rc::new(units),
            ranges: Default::default(),
            valued: Default::default(),
        }
    }

    /// The unit names that are units in `math`: none in a symbolic evaluation.
    fn units_in(&self, math: Node) -> std::rc::Rc<HashSet<String>> {
        if math
            .descendants()
            .any(|n| n.is_element() && n.tag_name().name() == "symEval")
        {
            return Default::default();
        }
        self.units()
    }

    /// The unit names the worksheet leaves as units: every unit of our table that the
    /// worksheet does not define.
    fn units(&self) -> std::rc::Rc<HashSet<String>> {
        self.units.clone()
    }

    /// records a range variable, and turns a definition whose index uses range variables
    /// into a program that assigns one element per value (`d := program { for k ∈ 0..N
    /// { d[k + 1] ← d[k]·q }; d }`), as the reference application computes it value by value.
    /// When an earlier region gave the array a value, the program starts with `d ← d`.
    /// The loops run over the ranges as written in their definitions, because inside a nested
    /// loop the name of an outer range variable is already the loop's scalar. The plain
    /// `v[i] := e` and `M⟨i⟩ := e` stay as they are: the engine iterates those itself.
    fn loop_ranges(&self, statement: Statement) -> Statement {
        let (StatementKind::Define { target, .. } | StatementKind::GlobalDefine { target, .. }) =
            &statement.kind
        else {
            return statement;
        };
        let valued_above = match &target.kind {
            TargetKind::Ident { name } => !self.valued.borrow_mut().insert(name.clone()),
            _ => {
                indexed_root(target).is_some_and(|(root, _)| !self.valued.borrow_mut().insert(root))
            }
        };
        let StatementKind::Define { target, rhs, tail } = &statement.kind else {
            return statement;
        };
        let mut ranges = self.ranges.borrow_mut();
        if let TargetKind::Ident { name } = &target.kind {
            ranges.retain(|(n, _)| n != name);
            if matches!(rhs.kind, ExprKind::Range { .. }) {
                ranges.push((name.clone(), rhs.clone()));
            }
            return statement;
        }
        let Some((root, indices)) = indexed_root(target) else {
            return statement;
        };
        let mut loops: Vec<(Name, Expr)> = Vec::new();
        for index in &indices {
            for name in expr_names(index) {
                if let Some(range) = ranges.iter().rev().find(|(n, _)| *n == name) {
                    if !loops.iter().any(|(n, _)| *n == name) {
                        loops.push(range.clone());
                    }
                }
            }
        }
        let engine_iterates = matches!(
            &target.kind,
            TargetKind::Index { base, indices } if indices.len() == 1
                && matches!(base.kind, TargetKind::Ident { .. })
                && matches!(indices[0].kind, ExprKind::Ident { .. })
        ) || matches!(
            &target.kind,
            TargetKind::Column { base, index }
                if matches!(base.kind, TargetKind::Ident { .. })
                    && matches!(index.kind, ExprKind::Ident { .. })
        );
        if loops.is_empty() || engine_iterates {
            return statement;
        }
        let mut body = vec![Stmt::synth(StmtKind::LocalDef {
            target: target.clone(),
            rhs: rhs.clone(),
        })];
        for (name, range) in loops.into_iter().rev() {
            body = vec![Stmt::synth(StmtKind::For {
                var: Ident::new(name),
                source: range,
                body,
            })];
        }
        // An element assignment starts a new local array: `d ← d` keeps the elements
        // the worksheet gave `d` above (`d[1] := 1`).
        if valued_above {
            let root_expr = Expr::synth(ExprKind::Ident { name: root.clone() });
            body.insert(
                0,
                Stmt::synth(StmtKind::LocalDef {
                    target: Target::synth(TargetKind::Ident { name: root.clone() }),
                    rhs: root_expr,
                }),
            );
        }
        body.push(Stmt::synth(StmtKind::ExprStmt {
            expr: Expr::synth(ExprKind::Ident { name: root.clone() }),
        }));
        LOOPED_DEFINITION.with(|c| c.set(true));
        Statement::synth(StatementKind::Define {
            target: Target::synth(TargetKind::Ident { name: root }),
            rhs: Expr::synth(ExprKind::Program { body }),
            tail: tail.clone(),
        })
    }
}

/// The plain names an element defines.
fn defined_names(node: Node, out: &mut HashSet<String>) {
    let name = node.tag_name().name();
    let target = match name {
        "define" | "globalDefine" | "localDefine" | "for" => {
            child_elements(node).into_iter().next()
        }
        "boundVars" => {
            for id in child_elements(node) {
                target_names(id, out);
            }
            None
        }
        _ => None,
    };
    if let Some(target) = target {
        target_names(target, out);
    }
}

fn target_names(target: Node, out: &mut HashSet<String>) {
    match target.tag_name().name() {
        "id" => {
            if target.attribute("subscript").is_none_or(str::is_empty) {
                out.insert(target.text().unwrap_or("").trim().to_owned());
            }
        }
        // `f(x) :=` and `v[i :=`: the name of the function or the array.
        "function" | "apply" => {
            let parts = child_elements(target);
            let head = if target.tag_name().name() == "apply" {
                parts.get(1)
            } else {
                parts.first()
            };
            if let Some(head) = head {
                target_names(*head, out);
            }
        }
        "matrix" => {
            for cell in child_elements(target) {
                target_names(cell, out);
            }
        }
        _ => {}
    }
}

/// The statement element of a `math` element: `resultFormat` is the region's display format, and
/// a `provenance` record wraps the statement of a pasted region.
fn statement_element<'a, 'b>(math: Node<'a, 'b>) -> Option<Node<'a, 'b>> {
    child_elements(math)
        .into_iter()
        .find(|c| c.tag_name().name() != "resultFormat")
}

thread_local! {
    /// Display overrides left out while translating the current region.
    static DROPPED_DISPLAY: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Whether the current region's definition was turned into a loop.
    static LOOPED_DEFINITION: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The canonical statement text of a `math` element, validated by the parser.
/// The array an element, column or row target assigns into, and the index expressions of the
/// target in the order they are written (`X⟨i⟩[j]` gives `X` and `i`, `j`).
fn indexed_root(target: &Target) -> Option<(Name, Vec<Expr>)> {
    let mut indices = Vec::new();
    let mut at = target;
    loop {
        match &at.kind {
            TargetKind::Ident { name } => {
                indices.reverse();
                return (!indices.is_empty()).then(|| (name.clone(), indices));
            }
            TargetKind::Index { base, indices: own } => {
                indices.extend(own.iter().rev().cloned());
                at = base;
            }
            TargetKind::Column { base, index } | TargetKind::Row { base, index } => {
                indices.push((**index).clone());
                at = base;
            }
            TargetKind::Paren { target } => at = target,
            _ => return None,
        }
    }
}

/// The names an expression reads, in the order they are written.
fn expr_names(expr: &Expr) -> Vec<Name> {
    fn walk(value: &serde_json::Value, out: &mut Vec<Name>) {
        match value {
            serde_json::Value::Object(object) => {
                if object.get("type").and_then(serde_json::Value::as_str) == Some("Ident") {
                    if let Some(name) = object
                        .get("name")
                        .and_then(|name| serde_json::from_value::<Name>(name.clone()).ok())
                    {
                        out.push(name);
                    }
                }
                for value in object.values() {
                    walk(value, out);
                }
            }
            serde_json::Value::Array(values) => values.iter().for_each(|v| walk(v, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(
        &serde_json::to_value(expr).expect("an expression serializes"),
        &mut out,
    );
    out
}

fn math_statement(math: Node, definitions: &Definitions) -> Result<String, (String, String)> {
    let Some(content) = statement_element(math) else {
        return Err(("math-empty".into(), "the math region is empty".into()));
    };
    let (linear, dropped) = math::with_xmcd_overrides(|| {
        math::with_implicit_units(definitions.units_in(math), || math::statement_text(content))
    });
    if dropped > 0 {
        DROPPED_DISPLAY.with(|c| c.set(c.get() + dropped));
    }
    let linear = linear.map_err(|e| {
        let (code, message) = e.describe();
        (code.to_owned(), message)
    })?;
    match parse_statement(&linear) {
        Ok(statement) => Ok(print_statement(&definitions.loop_ranges(statement))),
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
    definitions: &Definitions,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let math = source.primary?;
    DROPPED_DISPLAY.with(|c| c.set(0));
    LOOPED_DEFINITION.with(|c| c.set(false));
    let statement = math_statement(math, definitions);
    if LOOPED_DEFINITION.with(|c| c.get()) {
        report.note(
            "range-definition-loop",
            Some(&source.id),
            "a definition indexed by range variables is imported as a program that loops over them",
        );
    }
    if DROPPED_DISPLAY.with(|c| c.get()) > 0 {
        report.note(
            "display-unit-dropped",
            Some(&source.id),
            "the result is shown in a multiple of a name that is not a unit (such as π or %); it is imported shown in SI",
        );
    }
    match statement {
        Ok(text) => {
            let root = statement_element(math)?;
            let root = if root.tag_name().name() == "provenance" {
                math::provenance_payload(root).ok()?
            } else {
                root
            };
            if math::is_statement_root(root) {
                report.note(
                    "statement-outside-program",
                    Some(&source.id),
                    "a program statement outside a program is kept as a displayed expression (never evaluated)",
                );
            }
            if math.attribute("disable-calc") == Some("true") {
                report.note(
                    "disabled-region",
                    Some(&source.id),
                    "the region was disabled for calculation; it is imported enabled",
                );
            }
            let statement = parse_statement(&text).ok()?;
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

// ---- pictures ----------------------------------------------------------------------------

/// a `png` picture becomes an image region; a metafile is reported.
fn picture_region(
    source: &Source,
    at: Placement,
    id: &str,
    items: &HashMap<String, (bool, &str)>,
    resources: &mut crate::image::Resources,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let element = source.primary?;
    // A picture is a `picture` holding the image, or the image itself as the region's content.
    let image = if element.tag_name().name() == "picture" {
        child_elements(element).into_iter().next()
    } else {
        Some(element)
    };
    let Some(image) = image else {
        report.issue(
            "picture-not-imported",
            Some(&source.id),
            "the picture is empty",
        );
        return None;
    };
    if image.tag_name().name() != "png" {
        report.issue(
            "picture-not-imported",
            Some(&source.id),
            format!(
                "`{}` pictures (Windows metafiles) cannot be drawn on every platform and are not imported",
                image.tag_name().name()
            ),
        );
        return None;
    }
    let Some(bytes) = image
        .attribute("item-idref")
        .and_then(|r| item_bytes(items, r))
    else {
        report.issue(
            "picture-not-imported",
            Some(&source.id),
            "the image data is missing or unreadable",
        );
        return None;
    };
    let (resource, _) = match crate::image::resource_from_bytes(&bytes) {
        Ok(r) => r,
        Err(error) => {
            report.issue("picture-not-imported", Some(&source.id), error.to_string());
            return None;
        }
    };
    let size = match (
        attr_f64(image, "display-width").or_else(|| attr_f64(source.region, "width")),
        attr_f64(image, "display-height").or_else(|| attr_f64(source.region, "height")),
    ) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => [round2(w), round2(h)],
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

// ---- text --------------------------------------------------------------------------------

/// Character formatting while walking the inline XML of a paragraph.
#[derive(Debug, Clone, Default)]
struct Fmt {
    bold: bool,
    italic: bool,
    underline: bool,
    sub: bool,
    sup: bool,
    size: Option<f64>,
    color: Option<String>,
}

impl Fmt {
    /// The attributes of an `inlineAttr` (or of a style's) over what is inherited.
    fn with_attrs(&self, node: Node) -> Fmt {
        let mut f = self.clone();
        if let Some(w) = node.attribute("font-weight") {
            f.bold = w == "bold";
        }
        if let Some(s) = node.attribute("font-style") {
            f.italic = s == "italic";
        }
        if let Some(u) = node.attribute("underline") {
            f.underline = u == "true";
        }
        if let Some(v) = node.attribute("vertical-align") {
            f.sub = v == "sub" || v == "subscript";
            f.sup = v == "super" || v == "superscript";
        }
        if let Some(size) = attr_f64(node, "font-size").or_else(|| attr_f64(node, "size")) {
            f.size = Some(size);
        }
        f
    }

    fn run(&self, text: String, base_size: f64) -> Run {
        Run::Text(TextRun {
            text,
            bold: self.bold,
            italic: self.italic,
            underline: self.underline,
            sub: self.sub,
            sup: self.sup,
            size: self
                .size
                .filter(|s| (s - base_size).abs() > 0.05 && *s > 0.0),
            color: self.color.clone(),
            highlight: None,
        })
    }
}

/// A named text style: its paragraph alignment and character formatting.
#[derive(Debug, Clone, Default)]
struct TextStyle {
    align: Option<String>,
    fmt: Fmt,
}

#[derive(Debug, Default)]
struct TextStyles {
    styles: HashMap<String, TextStyle>,
}

impl TextStyles {
    /// The size of the Normal style: text of that size is written without a size.
    fn base_size(&self) -> f64 {
        self.styles
            .get("Normal")
            .and_then(|s| s.fmt.size)
            .unwrap_or(10.0)
    }
}

fn text_styles(settings: Node) -> TextStyles {
    let mut raw: HashMap<String, (Option<String>, Node, Option<Node>)> = HashMap::new();
    for style in settings
        .descendants()
        .filter(|n| n.has_tag_name_local("textStyle"))
    {
        let Some(name) = style.attribute("name") else {
            continue;
        };
        raw.insert(
            name.to_owned(),
            (
                style.attribute("base-style").map(str::to_owned),
                style,
                None,
            ),
        );
    }
    let mut styles = HashMap::new();
    for name in raw.keys() {
        // The chain from the base down to the style (a cycle stops it).
        let mut chain = Vec::new();
        let mut current = Some(name.clone());
        while let Some(n) = current {
            if chain.contains(&n) || chain.len() > 16 {
                break;
            }
            let Some((base, _, _)) = raw.get(&n) else {
                break;
            };
            chain.push(n.clone());
            current = base.clone();
        }
        let mut style = TextStyle::default();
        for n in chain.iter().rev() {
            let node = raw[n].1;
            if let Some(block) = child(node, "blockAttr") {
                if let Some(a) = block.attribute("text-align").filter(|a| *a != "inherit") {
                    style.align = Some(a.to_owned());
                }
            }
            if let Some(inline) = child(node, "inlineAttr") {
                style.fmt = style.fmt.with_attrs(inline);
            }
        }
        styles.insert(name.clone(), style);
    }
    TextStyles { styles }
}

fn paragraph_style(name: &str) -> Option<ParagraphStyle> {
    match name.to_ascii_lowercase().as_str() {
        "normal" => Some(ParagraphStyle::Normal),
        "heading 1" => Some(ParagraphStyle::Heading1),
        "heading 2" => Some(ParagraphStyle::Heading2),
        "heading 3" => Some(ParagraphStyle::Heading3),
        "title" => Some(ParagraphStyle::Title),
        "subtitle" => Some(ParagraphStyle::Subtitle),
        _ => None,
    }
}

fn alignment(value: &str) -> ParagraphAlign {
    match value {
        "center" => ParagraphAlign::Center,
        "right" => ParagraphAlign::Right,
        "justify" => ParagraphAlign::Justify,
        _ => ParagraphAlign::Left,
    }
}

/// `#rgb` or `#rrggbb` as `#rrggbb`; black is the default and no colour.
fn text_color(value: &str) -> Option<String> {
    let digits = value.trim().strip_prefix('#')?;
    let full = match digits.len() {
        3 => digits.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => digits.to_owned(),
        _ => return None,
    };
    crate::richtext::normalize_color(&format!("#{full}")).filter(|c| c != "#000000")
}

struct TextState<'d> {
    definitions: &'d Definitions,
    base_size: f64,
    math_issues: Vec<String>,
    style_dropped: bool,
}

impl TextState<'_> {
    fn inlines(&mut self, node: Node, fmt: &Fmt, runs: &mut Vec<Run>) {
        for c in node.children() {
            if c.is_text() {
                let text = c.text().unwrap_or("").replace(['\r', '\n'], "");
                if !text.is_empty() {
                    runs.push(fmt.run(text, self.base_size));
                }
                continue;
            }
            if !c.is_element() {
                continue;
            }
            match c.tag_name().name() {
                "sp" => {
                    let count = c
                        .attribute("count")
                        .and_then(|n| n.parse::<usize>().ok())
                        .unwrap_or(1)
                        .min(64);
                    runs.push(fmt.run(" ".repeat(count), self.base_size));
                }
                "tab" | "br" => runs.push(fmt.run(" ".into(), self.base_size)),
                "f" => {
                    if c.attribute("family").is_some() {
                        self.style_dropped = true;
                    }
                    self.inlines(c, &fmt.with_attrs(c), runs);
                }
                "inlineAttr" => self.inlines(c, &fmt.with_attrs(c), runs),
                "b" => self.inlines(
                    c,
                    &Fmt {
                        bold: true,
                        ..fmt.clone()
                    },
                    runs,
                ),
                "i" => self.inlines(
                    c,
                    &Fmt {
                        italic: true,
                        ..fmt.clone()
                    },
                    runs,
                ),
                "u" => self.inlines(
                    c,
                    &Fmt {
                        underline: true,
                        ..fmt.clone()
                    },
                    runs,
                ),
                "sub" => self.inlines(
                    c,
                    &Fmt {
                        sub: true,
                        sup: false,
                        ..fmt.clone()
                    },
                    runs,
                ),
                "sup" => self.inlines(
                    c,
                    &Fmt {
                        sup: true,
                        sub: false,
                        ..fmt.clone()
                    },
                    runs,
                ),
                "c" => {
                    let color = c.attribute("val").and_then(text_color);
                    self.inlines(
                        c,
                        &Fmt {
                            color,
                            ..fmt.clone()
                        },
                        runs,
                    );
                }
                "region" => {
                    let math = child(c, "math");
                    match math.map(|m| math_statement(m, self.definitions)) {
                        Some(Ok(text)) => runs.push(Run::Math(MathRun {
                            text,
                            ..MathRun::default()
                        })),
                        Some(Err((code, message))) => {
                            self.math_issues.push(format!("{code}: {message}"));
                            runs.push(fmt.run(" ".into(), self.base_size));
                        }
                        None => self.math_issues.push(format!(
                            "an inline `{}` region is not imported",
                            source_of(c)
                                .primary
                                .map(|p| p.tag_name().name())
                                .unwrap_or("?")
                        )),
                    }
                }
                // Anything else holding text keeps its text.
                _ => self.inlines(c, fmt, runs),
            }
        }
    }
}

/// The ids of the inline math regions of a text region that the import turned into math runs,
/// in text order: a nested region whose math was not imported leaves no run.
fn inline_sources(source: &Source) -> Vec<String> {
    let Some(element) = source.primary else {
        return Vec::new();
    };
    element
        .descendants()
        .filter(|n| n.has_tag_name_local("region"))
        .filter(|r| child(*r, "math").is_some())
        .map(|r| r.attribute("region-id").unwrap_or("?").to_owned())
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn text_region(
    source: &Source,
    at: Placement,
    id: &str,
    page: &PageSetup,
    styles: &TextStyles,
    definitions: &Definitions,
    report: &mut ImportReport,
) -> Option<DocumentRegion> {
    let element = source.primary?;
    let mut state = TextState {
        definitions,
        base_size: styles.base_size(),
        math_issues: Vec::new(),
        style_dropped: false,
    };
    let mut paragraphs = Vec::new();
    for p in child_elements(element)
        .into_iter()
        .filter(|n| n.tag_name().name() == "p")
    {
        let style_name = p.attribute("style").unwrap_or("Normal");
        let named = styles.styles.get(style_name).cloned().unwrap_or_default();
        let style = paragraph_style(style_name);
        if style.is_none() {
            state.style_dropped = true;
        }
        // A heading keeps our heading look; any other style gives its character format.
        let fmt = match style {
            Some(ParagraphStyle::Normal) | None => named.fmt.clone(),
            Some(_) => Fmt::default(),
        };
        let align = p
            .attribute("text-align")
            .filter(|a| *a != "inherit")
            .map(str::to_owned)
            .or(named.align.clone())
            .unwrap_or_default();
        let mut runs = Vec::new();
        if p.attribute("list-style-type")
            .is_some_and(|l| l != "inherit" && l != "none")
        {
            runs.push(fmt.run("• ".into(), state.base_size));
        }
        state.inlines(p, &fmt, &mut runs);
        paragraphs.push(Paragraph {
            style: style.unwrap_or_default(),
            align: alignment(&align),
            runs,
        });
    }
    for (index, reason) in state.math_issues.iter().enumerate() {
        report.issue(
            "math-unsupported",
            Some(&source.id),
            format!("inline math {} not imported: {reason}", index + 1),
        );
    }
    if state.style_dropped {
        report.note(
            "text-style-dropped",
            None,
            "the font family and the custom paragraph styles of text are not imported",
        );
    }
    let mut rich = RichText(paragraphs);
    rich.normalize();
    let linear = rich.print();
    if linear.trim().is_empty() {
        return None;
    }
    let full = element.attribute("use-page-width") == Some("true");
    let width = attr_f64(source.region, "width")
        .map(round2)
        .filter(|w| *w > 0.0 && *w < page.content_width() - 0.5);
    let canonical = RichText::parse(&linear).print();
    Some(DocumentRegion::Text(TextRegion {
        id: id.to_owned(),
        page: at.page,
        x: if full { page.margins.left } else { at.x },
        y: at.y,
        enabled: true,
        width: if full { None } else { width },
        full_width: full,
        background: source
            .region
            .attribute("background-color")
            .and_then(text_color)
            .filter(|c| c != "#ffffff"),
        language: None,
        text: canonical,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_and_rtf() {
        assert_eq!(base64_decode("aGVs\nbG8=").unwrap(), b"hello");
        let rtf = r"{\rtf1\ansi{\fonttbl{\f0\fswiss Arial;}}{\colortbl\red0\green0\blue0;}\deflang1033{\*\fchars }\pard\plain\f3\fs18 Pagina \{n\} \'e8 qui\par }";
        assert_eq!(rtf_plain_text(rtf).trim(), "Pagina {n} è qui");
        let mut report = ImportReport::default();
        assert_eq!(
            page_fields("File: {f}  Page {n} of {nn}", "footer", &mut report),
            "File: {file} Page {page} of"
        );
        assert_eq!(report.notes.len(), 1);
    }
}
