//! Minimal reader of the worksheet YAML text format.
//!
//! This reads only what evaluation needs: math regions (`math:`), include regions
//! (`include:`), `julia` regions, positions, the `enabled` flag and calculation settings. `text` regions and the `page` setup are kept for the UI. `plot` and `image`
//! regions are accepted and skipped. The deterministic writer is `worksheet_writer`;
//! this reader is
//! deliberately tolerant of fields it does not know. Version detection and the migrate steps
//!  live here too.

use crate::ast::{JuliaBlock, JuliaImportDecl, Statement, StatementKind};
use crate::graph::Region;
use crate::layout::{RawPage, TextRegion};
use crate::plot::{PlotRegion, PlotSpec};
use crate::project::{
    CalculationSettings, DocumentId, DocumentRegion, IncludeRegion, PathError, Project,
    ProjectDocument, ProjectError,
};
use crate::syntax::{parse_statement, ParseError};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("cannot read `{path}`: {message}")]
    Io { path: String, message: String },
    #[error("invalid worksheet YAML in `{document}`: {message}")]
    Yaml { document: String, message: String },
    #[error("unsupported worksheet format `{found}` in `{document}` (this application reads `equavela-worksheet/1` up to `equavela-worksheet/{}`)", CURRENT_VERSION)]
    UnsupportedFormat { document: String, found: String },
    #[error("unsupported worksheet format `{found}` in `{document}`: written by a newer version of the application (file version {version}, this application reads up to {}); update the application", CURRENT_VERSION)]
    NewerVersion {
        document: String,
        found: String,
        version: u32,
    },
    #[error("`{document}` is not a worksheet: {reason}")]
    NotAWorksheet { document: String, reason: String },
    #[error("region `{region_id}` of `{document}`: {error}")]
    Math {
        document: String,
        region_id: String,
        error: Box<ParseError>,
    },
    #[error("region `{region_id}` of `{document}` is a `solve` block, which only worksheet format version 1 has; a solve block is a `Given` region, constraint regions and a `Find` region")]
    SolveRegion { document: String, region_id: String },
    #[error("julia region `{region_id}` of `{document}`: {message}")]
    Julia {
        document: String,
        region_id: String,
        message: String,
    },
    #[error("invalid page setup in `{document}`: {message}")]
    Page { document: String, message: String },
    #[error("invalid page breaks in `{document}`: {message}")]
    PageBreak { document: String, message: String },
    #[error("plot region `{region_id}` of `{document}`: {message}")]
    Plot {
        document: String,
        region_id: String,
        message: String,
    },
    #[error("image `{what}` of `{document}`: {message}")]
    Image {
        document: String,
        what: String,
        message: String,
    },
    #[error("area `{region_id}` of `{document}`: {message}")]
    Area {
        document: String,
        region_id: String,
        message: String,
    },
    #[error("numeric choices of region `{region_id}` of `{document}`: {message}")]
    Numeric {
        document: String,
        region_id: String,
        message: String,
    },
    #[error("region `{region_id}` of `{document}` has no `math`, `include`, `julia`, `text`, `plot`, `image` or `area` field")]
    UnknownRegion { document: String, region_id: String },
    #[error(transparent)]
    Path(#[from] PathError),
    #[error(transparent)]
    Project(#[from] ProjectError),
}

/// A parsed document plus the source text of its math regions (the spans of statement
/// and error locations refer to these texts).
#[derive(Debug, Clone)]
pub struct LoadedDocument {
    pub document: ProjectDocument,
    /// Region id to math source text.
    pub texts: HashMap<String, String>,
    /// The version of the file when it was older than [`CURRENT_VERSION`] and has been migrated
    /// in memory; `None` for a file already at the current version.
    pub migrated_from: Option<u32>,
    /// Notes about what the reader changed or ignored.
    pub notes: Vec<String>,
}

/// A project loaded from disk: every reachable document and their math texts.
#[derive(Debug, Clone)]
pub struct LoadedProject {
    pub project: Project,
    pub root: DocumentId,
    /// `(document, region id)` to math source text.
    pub texts: HashMap<(DocumentId, String), String>,
    /// Include targets that could not be read (reported as diagnostics by the analysis).
    pub missing: Vec<DocumentId>,
}

/// The key that identifies a worksheet file.
pub const FORMAT_KEY: &str = "format";
/// The container version the writer emits and the model corresponds to.
pub const CURRENT_VERSION: u32 = 3;
/// Value of [`FORMAT_KEY`] written into every new file: the product's worksheet format at
/// [`CURRENT_VERSION`].
pub const FORMAT_ID: &str = "equavela-worksheet/3";
/// Prefix of the identity values of the current spelling; the version follows.
const FORMAT_PREFIX: &str = "equavela-worksheet/";

/// One migrate step: upgrades the parsed file of version `N` to version `N + 1`. It works
/// on the typed raw file, not on an untyped tree, so scalars keep the text the file wrote (an id
/// `y` stays a string). When a later version changes the shape, the step takes the old raw type
/// and returns the next one.
type MigrateStep = fn(&mut RawFile) -> Result<(), String>;

/// The migrate steps; entry `k` upgrades version `k + 1` to `k + 2`. Step 0 flattens the boxed
/// solve regions of version 1; the length is [`CURRENT_VERSION`] minus 1.
const MIGRATIONS: &[MigrateStep] = &[migrate_1_to_2, migrate_2_to_3];

/// Vertical step, in points, between the regions a boxed solve block is flattened into.
pub const SOLVE_LINE_STEP: f64 = 28.0;

/// Version 1 to 2: a boxed `solve:` region becomes
/// the flat regions of a version 15 of the reference application style block, `Given`, one region per constraint, and the call.
/// The `Given` region keeps the id of the box; the others are `<id>-c<n>` and `<id>-call`.
fn migrate_1_to_2(raw: &mut RawFile) -> Result<(), String> {
    let mut used: HashSet<String> = raw.regions.iter().map(|region| region.id.clone()).collect();
    let regions = std::mem::take(&mut raw.regions);
    let mut out = Vec::with_capacity(regions.len());
    let mut boxes: Vec<(Vec<String>, f64)> = Vec::new();
    for mut region in regions {
        let Some(solve) = region.solve.take() else {
            out.push(region);
            continue;
        };
        let (x, y) = region.at.map_or((0.0, 0.0), |at| (at[0], at[1]));
        let flat = |id: String, line: usize, math: &str| RawRegion {
            id,
            page: region.page,
            at: Some([x, y + SOLVE_LINE_STEP * line as f64]),
            enabled: region.enabled,
            math: Some(math.to_owned()),
            ..RawRegion::default()
        };
        let mut lines = vec![flat(region.id.clone(), 0, "Given")];
        for (index, constraint) in solve.given.iter().enumerate() {
            lines.push(flat(
                format!("{}-c{}", region.id, index + 1),
                index + 1,
                constraint.trim_end(),
            ));
        }
        lines.push(flat(
            format!("{}-call", region.id),
            solve.given.len() + 1,
            solve.call.trim_end(),
        ));
        for line in &lines[1..] {
            if !used.insert(line.id.clone()) {
                return Err(format!(
                    "the id `{}` that the solve block `{}` would need is already used",
                    line.id, region.id
                ));
            }
        }
        let ids: Vec<String> = lines.iter().map(|line| line.id.clone()).collect();
        boxes.push((ids, SOLVE_LINE_STEP * (solve.given.len() + 1) as f64));
        out.extend(lines);
    }
    raw.regions = out;
    // the regions below a box move down by the height the new lines need.
    let setup = raw
        .page
        .clone()
        .unwrap_or_default()
        .into_setup()
        .map_err(|message| format!("invalid page setup: {message}"))?;
    // Reading order of the boxes at their original positions.
    boxes.sort_by(|a, b| {
        let key = |ids: &Vec<String>| {
            raw.regions
                .iter()
                .find(|r| r.id == ids[0])
                .map(|r| (r.page.unwrap_or(1), r.at.map_or(0.0, |at| at[1])))
                .unwrap_or((0, 0.0))
        };
        let (ka, kb) = (key(&a.0), key(&b.0));
        ka.0.cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
    });
    for (ids, extra) in &boxes {
        reflow_below(&mut raw.regions, ids, *extra, &setup);
    }
    Ok(())
}

/// Moves every region below the first region of `own` (same page, larger y) down by `extra`
/// points; what no longer fits on the page continues at the top of the next page, which in turn
/// pushes the regions already there.
fn reflow_below(
    regions: &mut [RawRegion],
    own: &[String],
    extra: f64,
    setup: &crate::layout::PageSetup,
) {
    let Some(head) = regions.iter().find(|r| r.id == own[0]) else {
        return;
    };
    let (mut page, origin) = (head.page.unwrap_or(1), head.at.map_or(0.0, |at| at[1]));
    let top = setup.margins.top;
    let limit = setup.height - setup.margins.bottom - SOLVE_LINE_STEP;
    let mut push = extra;
    let mut threshold = Some(origin);
    let mut moved: HashSet<String> = HashSet::new();
    loop {
        let mut overflow: Vec<usize> = Vec::new();
        for (index, region) in regions.iter_mut().enumerate() {
            if own.contains(&region.id) || moved.contains(&region.id) {
                continue;
            }
            if region.page.unwrap_or(1) != page {
                continue;
            }
            let Some(at) = region.at.as_mut() else {
                continue;
            };
            if threshold.is_some_and(|t| at[1] <= t) {
                continue;
            }
            at[1] += push;
            if at[1] > limit {
                overflow.push(index);
            }
        }
        if overflow.is_empty() {
            return;
        }
        // The overflow continues at the top of the next page, in the same relative order.
        let next = page + 1;
        let mut band: f64 = 0.0;
        let mut placed = Vec::new();
        for &index in &overflow {
            let at = regions[index].at.expect("moved regions have a position");
            let new_y =
                ((top + (at[1] - limit - SOLVE_LINE_STEP).max(0.0)) * 100.0).round() / 100.0;
            band = band.max(new_y + SOLVE_LINE_STEP - top);
            placed.push((index, new_y));
        }
        // Regions already on the next page make room first; then the overflow lands on top.
        push = band;
        threshold = None;
        page = next;
        for (index, new_y) in placed {
            moved.insert(regions[index].id.clone());
            // park the overflow on the next page after the others were shifted: record now,
            // apply below by marking `moved` so the shifting loop skips it
            let region = &mut regions[index];
            region.page = Some(next);
            region.at = Some([region.at.expect("position")[0], new_y]);
        }
    }
}

/// Version 2 to 3: version 2
/// read a plain name of the unit table as a unit in a value position unless a definition of the same
/// spelling was visible; version 3 reads it as an ordinary name. The step makes the old meaning
/// explicit: every math text of the file - a `math:` region, the inline math of a `text:` region, a plot
/// trace or limit expression, a table cell - is parsed, its plain unit names get the unit label and the
/// statement is printed again in canonical form. A name that any definition of the file, or a parameter,
/// local binding, loop variable or binder of the same statement, can capture keeps its plain text, so the
/// step never changes a value that the file resolved to a definition. Unit contexts are untouched: a plain
/// name is a unit in the unit override of an evaluation and in a table column unit in version 3 too.
/// The importer's pass over its own output: a name the reference application leaves without a label is
/// not a unit here (the reference application draws it as an ordinary name; only the unit label makes a unit), but when the
/// worksheet defines the same spelling as an explicit variable (`L@var`) it is that variable. Text with no
/// such variable comes back unchanged.
pub(crate) fn rebind_plain_names(text: &str) -> Result<String, String> {
    let variables = explicit_variable_spellings(text);
    if variables.is_empty() {
        return Ok(text.to_owned());
    }
    let id = DocumentId::new("Imported.eqv").map_err(|error| error.to_string())?;
    let loaded =
        parse_document_with(id, text, Some(&variables)).map_err(|error| error.to_string())?;
    crate::worksheet_writer::write_document(&loaded.document).map_err(|error| error.to_string())
}

/// The spellings of the unit table the text writes as an explicit variable (`name@var`).
fn explicit_variable_spellings(text: &str) -> crate::fasthash::HashSet<String> {
    let mut out = crate::fasthash::HashSet::default();
    let mut search = text;
    while let Some(at) = search.find("@var") {
        let before = &search[..at];
        let start = before
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_alphabetic())
            .last()
            .map(|(i, _)| i)
            .unwrap_or(before.len());
        let name = &before[start..];
        if !name.is_empty() && crate::units::is_unit(name) {
            out.insert(name.to_owned());
        }
        search = &search[at + 4..];
    }
    out
}

fn migrate_2_to_3(raw: &mut RawFile) -> Result<(), String> {
    let defined = file_definitions(raw);
    apply_rule(raw, &Rule::Label(&defined));
    Ok(())
}

/// What a relabelling pass does to the plain unit names of a file's math: the version-2 rule labels them as
/// units unless the file defines the spelling; the importer's rule leaves them plain, except a
/// spelling the file defines as an explicit variable, which is that variable.
enum Rule<'a> {
    Label(&'a crate::fasthash::HashSet<String>),
    Rebind(&'a crate::fasthash::HashSet<String>),
}

fn apply_rule(raw: &mut RawFile, rule: &Rule) {
    for region in &mut raw.regions {
        if let Some(math) = region.math.take() {
            region.math = Some(migrate_math(&math, rule));
        }
        if let Some(text) = region.text.as_mut() {
            migrate_text(text, rule);
        }
        if let Some(plot) = region.plot.as_mut() {
            migrate_plot(plot, rule);
        }
        if let Some(table) = region.table.as_mut() {
            migrate_table(table, rule);
        }
    }
}

/// The names the file defines anywhere: a definition target or function name of a region or of an inline
/// math run, and the name of a table column (its cells become that column vector).
fn file_definitions(raw: &RawFile) -> crate::fasthash::HashSet<String> {
    let mut defined: crate::fasthash::HashSet<String> = crate::fasthash::HashSet::default();
    let mut texts: Vec<String> = Vec::new();
    for region in &raw.regions {
        if let Some(math) = &region.math {
            texts.push(math.clone());
        }
        if let Some(text) = region.text.as_ref().and_then(raw_text) {
            // The inline math of the text, run by run.
            for paragraph in crate::richtext::RichText::parse(text).0 {
                for run in paragraph.runs {
                    if let crate::richtext::Run::Math(math) = run {
                        texts.push(math.text);
                    }
                }
            }
        }
        if let Some(table) = region.table.as_ref().and_then(|table| table.get("columns")) {
            for column in table.as_array().into_iter().flatten() {
                let name = column
                    .get("name")
                    .and_then(|name| name.as_str())
                    .unwrap_or("");
                if let Ok(crate::ast::Expr {
                    kind: crate::ast::ExprKind::Ident { name },
                    ..
                }) = crate::parse_expression(name)
                {
                    if let Some(text) = name.as_simple() {
                        defined.insert(text.to_owned());
                    }
                }
            }
        }
    }
    for text in texts {
        if let Ok(statement) = parse_statement(text.trim_end()) {
            crate::units::definition_names(&statement, &mut defined);
        }
    }
    defined
}

/// The text of a `text:` region: the string itself or the `text` key of its mapping form.
fn raw_text(value: &serde_json::Value) -> Option<&str> {
    match value {
        serde_json::Value::String(text) => Some(text),
        serde_json::Value::Object(map) => map.get("text").and_then(|text| text.as_str()),
        _ => None,
    }
}

/// One math text with its plain unit names labelled; a text the parser refuses is left as it is found,
/// so the load reports the same parse error it reported before.
fn migrate_math(text: &str, rule: &Rule) -> String {
    let Ok(mut statement) = parse_statement(text.trim_end()) else {
        return text.to_owned();
    };
    match rule {
        Rule::Label(defined) => crate::units::label_value_units(&mut statement, defined),
        Rule::Rebind(variables) => {
            crate::units::rebind_plain_names_to_variables(&mut statement, variables)
        }
    }
    crate::syntax::print_statement(&statement)
}

/// The inline math of a `text:` region, rewritten run by run: the rest of the text is left byte for byte.
fn migrate_text(value: &mut serde_json::Value, rule: &Rule) {
    match value {
        serde_json::Value::String(text) => *text = migrate_inline_math(text, rule),
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(text)) = map.get_mut("text") {
                *text = migrate_inline_math(text, rule);
            }
        }
        _ => {}
    }
}

/// Every `$…$` run of a linear text rewritten in place;
/// the rest of the text keeps the bytes the file wrote.
fn migrate_inline_math(text: &str, rule: &Rule) -> String {
    let mut out = String::with_capacity(text.len());
    let mut math = String::new();
    let mut in_math = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let escaped = chars.next();
                let target = if in_math { &mut math } else { &mut out };
                target.push(c);
                if let Some(escaped) = escaped {
                    target.push(escaped);
                }
            }
            '$' => {
                if in_math {
                    out.push_str(&migrate_math(&math, rule));
                    math.clear();
                }
                out.push('$');
                in_math = !in_math;
            }
            _ => {
                let target = if in_math { &mut math } else { &mut out };
                target.push(c);
            }
        }
    }
    if in_math {
        // an unterminated `$` is a literal dollar: the run is no math at all
        out.push('$');
        out.push_str(&math);
    }
    out
}

/// The trace expressions and the expression limits of a plot. The axis unit is
/// a unit context and is left plain.
fn migrate_plot(plot: &mut serde_json::Value, rule: &Rule) {
    if let Some(traces) = plot.get_mut("traces").and_then(|t| t.as_array_mut()) {
        for trace in traces {
            for key in ["x", "y"] {
                migrate_json_math(trace.get_mut(key), rule);
            }
        }
    }
    if let Some(axes) = plot.get_mut("axes").and_then(|a| a.as_object_mut()) {
        for axis in axes.values_mut() {
            for key in ["min", "max"] {
                migrate_json_math(axis.get_mut(key), rule);
            }
        }
    }
}

/// The cells of a table column are math text (a table column unit is a unit context and stays plain).
fn migrate_table(table: &mut serde_json::Value, rule: &Rule) {
    let Some(columns) = table.get_mut("columns").and_then(|c| c.as_array_mut()) else {
        return;
    };
    for column in columns {
        let Some(cells) = column.get_mut("cells").and_then(|c| c.as_array_mut()) else {
            continue;
        };
        for cell in cells {
            migrate_json_math(Some(cell), rule);
        }
    }
}

/// A math string of a JSON value (a plot expression or a limit; a numeric limit is not math).
fn migrate_json_math(value: Option<&mut serde_json::Value>, rule: &Rule) {
    if let Some(serde_json::Value::String(text)) = value {
        if !text.trim().is_empty() {
            *text = migrate_math(text, rule);
        }
    }
}

/// Number of migrate steps defined (equals [`CURRENT_VERSION`] minus 1).
pub fn migration_step_count() -> usize {
    MIGRATIONS.len()
}

/// The version a `format` value stands for: `equavela-worksheet/N` is `N`. Anything else is an unsupported format; a version above
/// [`CURRENT_VERSION`] is the newer-version error.
fn classify_format(document: &str, value: &str) -> Result<u32, LoadError> {
    let unsupported = || LoadError::UnsupportedFormat {
        document: document.to_owned(),
        found: value.to_owned(),
    };
    let digits = value
        .strip_prefix(FORMAT_PREFIX)
        .or_else(|| value.strip_prefix(crate::former_names::WORKSHEET_FORMAT_PREFIX))
        .ok_or_else(unsupported)?;
    let canonical = !digits.is_empty()
        && !digits.starts_with('0')
        && digits.bytes().all(|b| b.is_ascii_digit());
    let version: u32 = digits
        .parse()
        .ok()
        .filter(|_| canonical)
        .ok_or_else(unsupported)?;
    if version > CURRENT_VERSION {
        return Err(LoadError::NewerVersion {
            document: document.to_owned(),
            found: value.to_owned(),
            version,
        });
    }
    Ok(version)
}

/// What the first physical line of a file says about its format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FormatLine {
    /// The first line is `format: <value>`.
    Key(String),
    /// Anything else (a different first line such as XML, a comment or source code).
    Other(String),
    /// The file is empty.
    Empty,
}

/// Reads the first physical line (an optional UTF-8 byte order mark is ignored).
pub fn format_line(content: &str) -> FormatLine {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let Some(line) = content.lines().next() else {
        return FormatLine::Empty;
    };
    if let Some(rest) = line.strip_prefix("format:") {
        let value = rest.split('#').next().unwrap_or("").trim();
        let value = value.trim_matches(|c| c == '"' || c == '\'');
        return FormatLine::Key(value.to_owned());
    }
    let preview = if line.is_empty() {
        "<blank>"
    } else {
        line.trim()
    };
    FormatLine::Other(preview.chars().take(40).collect())
}

/// `.eqv`, or `.eqvz` for the worksheet of a portable document, which is identified by the
/// archive's path; its text comes from inside the archive.
fn has_worksheet_extension(document: &str) -> bool {
    let document = document.to_ascii_lowercase();
    document.ends_with(".eqv") || document.ends_with(".eqvz")
}

/// Checks the identifying first line and returns the version it states. Every
/// worksheet carries it: the extension alone proves nothing, and a file without the line is "not a worksheet".
fn check_identity(document: &str, content: &str) -> Result<u32, LoadError> {
    let not_a_worksheet = |reason: String| LoadError::NotAWorksheet {
        document: document.to_owned(),
        reason,
    };
    if !has_worksheet_extension(document) {
        return Err(not_a_worksheet(
            "worksheets have the `.eqv` extension".to_owned(),
        ));
    }
    match format_line(content) {
        FormatLine::Key(value) if value.starts_with(FORMAT_PREFIX) => {
            classify_format(document, &value)
        }
        FormatLine::Key(value) => Err(not_a_worksheet(format!(
            "its first line says `format: {value}`, not `format: {FORMAT_ID}` (a file from another program?)"
        ))),
        FormatLine::Other(line) => Err(not_a_worksheet(format!(
            "its first line `{line}` is not `format: {FORMAT_ID}` (a `.eqv` file from another program?)"
        ))),
        FormatLine::Empty => Err(not_a_worksheet(format!(
            "the file is empty (a worksheet starts with `format: {FORMAT_ID}`)"
        ))),
    }
}

#[derive(Deserialize)]
struct RawFile {
    #[serde(default)]
    settings: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    page: Option<RawPage>,
    /// Manual page breaks.
    #[serde(default, rename = "page-breaks")]
    page_breaks: Vec<RawPageBreak>,
    #[serde(default)]
    regions: Vec<RawRegion>,
    #[serde(default)]
    resources: BTreeMap<String, RawResource>,
}

#[derive(Deserialize)]
struct RawPageBreak {
    page: u32,
    y: f64,
}

#[derive(Deserialize)]
struct RawResource {
    media: String,
    #[serde(default)]
    base64: Option<String>,
    #[serde(default)]
    text: Option<String>,
    /// A project file instead of bytes.
    #[serde(default)]
    asset: Option<String>,
}

#[derive(Deserialize)]
struct RawArea {
    #[serde(default)]
    title: String,
    height: f64,
    #[serde(default)]
    collapsed: bool,
}

#[derive(Deserialize)]
struct RawImage {
    resource: String,
    size: [f64; 2],
}

#[derive(Deserialize)]
struct RawJulia {
    /// Absent in the files written before the field existed: those blocks play.
    #[serde(default)]
    playing: Option<bool>,
    /// The box of the block in points; absent when the block has no stored size.
    #[serde(default)]
    size: Option<[f64; 2]>,
    #[serde(default)]
    using: Vec<String>,
    #[serde(default, rename = "import")]
    imports: BTreeMap<String, String>,
    #[serde(default)]
    define: Vec<String>,
    #[serde(default)]
    code: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawRegion {
    id: String,
    #[serde(default)]
    page: Option<u32>,
    #[serde(default)]
    at: Option<[f64; 2]>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    math: Option<String>,
    /// Result-format override of a math region: keys of the `format.*` settings.
    #[serde(default)]
    format: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    /// The numeric choices of a math region (solver algorithm and options, derivative method).
    #[serde(default)]
    numeric: Option<std::collections::BTreeMap<String, serde_json::Value>>,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    julia: Option<RawJulia>,
    /// A boxed solve block of format version 1: only read by the migration step 1 to 2.
    #[serde(default)]
    solve: Option<RawSolve>,
    #[serde(default)]
    text: Option<serde_json::Value>,
    #[serde(default)]
    plot: Option<serde_json::Value>,
    #[serde(default)]
    image: Option<serde_json::Value>,
    #[serde(default)]
    area: Option<RawArea>,
    #[serde(default)]
    table: Option<serde_json::Value>,
    /// Presentation-only line breaks of a math region.
    #[serde(default)]
    breaks: Vec<RawMathBreak>,
}

#[derive(Debug, Deserialize, Default)]
struct RawMathBreak {
    #[serde(default)]
    path: Vec<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSolve {
    #[serde(default)]
    given: Vec<String>,
    call: String,
}

/// Parses one worksheet document from its YAML text.
pub fn parse_document(id: DocumentId, content: &str) -> Result<LoadedDocument, LoadError> {
    parse_document_with(id, content, None)
}

/// `parse_document`, with the importer's rebinding of plain unit-table names to explicit variables applied
/// after the version steps when `rebind` is given.
fn parse_document_with(
    id: DocumentId,
    content: &str,
    rebind: Option<&crate::fasthash::HashSet<String>>,
) -> Result<LoadedDocument, LoadError> {
    let name = id.as_str().to_owned();
    let version = check_identity(&name, content)?;
    let yaml_error = |message: String| LoadError::Yaml {
        document: name.clone(),
        message,
    };
    // the version is known before the body is turned into the model.
    let mut raw: RawFile =
        serde_saphyr::from_str(content).map_err(|error| yaml_error(error.to_string()))?;
    // a current file takes no step.
    for (index, step) in MIGRATIONS.iter().enumerate().skip(version as usize - 1) {
        step(&mut raw).map_err(|message| {
            yaml_error(format!(
                "cannot migrate from version {}: {message}",
                index + 1
            ))
        })?;
    }
    if let Some(variables) = rebind {
        apply_rule(&mut raw, &Rule::Rebind(variables));
    }
    let migrated_from = (version < CURRENT_VERSION).then_some(version);
    let notes = Vec::new();
    let values: BTreeMap<String, String> = raw
        .settings
        .into_iter()
        .map(|(key, value)| {
            let text = match value {
                serde_json::Value::String(text) => text,
                other => other.to_string(),
            };
            (key, text)
        })
        .collect();
    let settings = CalculationSettings { values };
    let page = raw
        .page
        .unwrap_or_default()
        .into_setup()
        .map_err(|message| LoadError::Page {
            document: name.clone(),
            message,
        })?;
    // the breaks are sorted by page and a page ends once.
    let mut page_breaks: Vec<crate::layout::PageBreak> = raw
        .page_breaks
        .into_iter()
        .map(|entry| crate::layout::PageBreak {
            page: entry.page,
            y: entry.y,
        })
        .collect();
    page_breaks.sort_by_key(|entry| entry.page);
    crate::layout::validate_page_breaks(&page_breaks, &page).map_err(|message| {
        LoadError::PageBreak {
            document: name.clone(),
            message,
        }
    })?;
    let image_error = |what: &str, message: String| LoadError::Image {
        document: name.clone(),
        what: what.to_owned(),
        message,
    };
    let mut resources = crate::image::Resources::new();
    let mut assets = crate::image::Assets::new();
    for (resource_id, raw_resource) in std::mem::take(&mut raw.resources) {
        let media = crate::image::ImageMedia::from_name(&raw_resource.media).ok_or_else(|| {
            image_error(
                &resource_id,
                format!("unknown media `{}` (png, jpeg or svg)", raw_resource.media),
            )
        })?;
        if let Some(path) = raw_resource.asset {
            if raw_resource.base64.is_some() || raw_resource.text.is_some() {
                return Err(image_error(
                    &resource_id,
                    "a resource has exactly one of `base64`, `text` or `asset`".into(),
                ));
            }
            let asset = crate::image::AssetReference { media, path };
            crate::image::validate_asset(&asset).map_err(|e| image_error(&resource_id, e))?;
            assets.insert(resource_id, asset);
            continue;
        }
        let data = match (media, raw_resource.base64, raw_resource.text) {
            (crate::image::ImageMedia::Svg, _, Some(text)) => text.trim().as_bytes().to_vec(),
            (crate::image::ImageMedia::Svg, _, None) => {
                return Err(image_error(
                    &resource_id,
                    "an svg resource needs `text`".into(),
                ))
            }
            (_, Some(b64), _) => crate::image::base64_decode(&b64)
                .map_err(|e| image_error(&resource_id, e.to_string()))?,
            (_, None, _) => {
                return Err(image_error(
                    &resource_id,
                    "a png or jpeg resource needs `base64`".into(),
                ))
            }
        };
        let resource = crate::image::validate_resource(crate::image::ImageResource { media, data })
            .map_err(|e| image_error(&resource_id, e.to_string()))?;
        resources.insert(resource_id, resource);
    }
    let mut regions = Vec::new();
    let mut result_formats = std::collections::BTreeMap::new();
    let mut numeric_options = std::collections::BTreeMap::new();
    let mut math_breaks = std::collections::BTreeMap::new();
    let mut texts = HashMap::new();
    for raw_region in raw.regions {
        let (x, y) = raw_region.at.map_or((0.0, 0.0), |at| (at[0], at[1]));
        let page = raw_region.page.unwrap_or(1);
        let enabled = raw_region.enabled.unwrap_or(true);
        let region_id = raw_region.id.clone();
        let breaks: Vec<crate::layout::MathBreak> = raw_region
            .breaks
            .into_iter()
            .map(|entry| crate::layout::MathBreak {
                path: entry.path,
                offset: entry.offset,
            })
            .collect();
        if let Some(math) = raw_region.math {
            let statement = parse_statement(math.trim_end()).map_err(|error| LoadError::Math {
                document: name.clone(),
                region_id: raw_region.id.clone(),
                error: Box::new(error),
            })?;
            texts.insert(raw_region.id.clone(), math.trim_end().to_owned());
            if !breaks.is_empty() {
                math_breaks.insert(region_id.clone(), breaks);
            }
            if let Some(format) = raw_region.format {
                let map: std::collections::BTreeMap<String, String> = format
                    .into_iter()
                    .map(|(key, value)| {
                        let text = match value {
                            serde_json::Value::String(text) => text,
                            other => other.to_string(),
                        };
                        (key, text)
                    })
                    .collect();
                if !map.is_empty() {
                    result_formats.insert(raw_region.id.clone(), map);
                }
            }
            if let Some(numeric) = raw_region.numeric {
                let map: std::collections::BTreeMap<String, String> = numeric
                    .into_iter()
                    .map(|(key, value)| {
                        let text = match value {
                            serde_json::Value::String(text) => text,
                            other => other.to_string(),
                        };
                        (key, text)
                    })
                    .collect();
                crate::numeric_options::validate(&map).map_err(|message| LoadError::Numeric {
                    document: name.clone(),
                    region_id: raw_region.id.clone(),
                    message,
                })?;
                if !map.is_empty() {
                    numeric_options.insert(raw_region.id.clone(), map);
                }
            }
            regions.push(DocumentRegion::Math(Box::new(Region {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                statement: std::sync::Arc::new(statement),
            })));
        } else if let Some(julia) = raw_region.julia {
            let block = julia_block(&name, &raw_region.id, julia)?;
            regions.push(DocumentRegion::Math(Box::new(Region {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                statement: std::sync::Arc::new(Statement::synth(StatementKind::Julia { block })),
            })));
        } else if raw_region.solve.is_some() {
            // Version 1 files were migrated above; only a version 2 file can still have one.
            return Err(LoadError::SolveRegion {
                document: name.clone(),
                region_id: raw_region.id,
            });
        } else if let Some(path) = raw_region.include {
            regions.push(DocumentRegion::Include(IncludeRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                path,
            }));
        } else if let Some(text) = raw_region.text {
            let (text, width, full_width, background, language) = match text {
                serde_json::Value::String(text) => (text, None, false, None, None),
                serde_json::Value::Object(map) => (
                    map.get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    map.get("width").and_then(|value| value.as_f64()),
                    map.get("width").and_then(|value| value.as_str()) == Some("full"),
                    // a stored value that is not `#rrggbb` is no fill, never a load error.
                    map.get("background")
                        .and_then(|value| value.as_str())
                        .and_then(crate::richtext::normalize_color),
                    // a value that is not a dictionary id is no language, never a load error.
                    map.get("language")
                        .and_then(|value| value.as_str())
                        .filter(|value| crate::spell::is_language_id(value))
                        .map(str::to_owned),
                ),
                other => (other.to_string(), None, false, None, None),
            };
            regions.push(DocumentRegion::Text(TextRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                width,
                full_width,
                background,
                language,
                text: text.trim_end().to_owned(),
            }));
        } else if let Some(plot) = raw_region.plot {
            let plot: PlotSpec = serde_json::from_value(plot).map_err(|error| LoadError::Plot {
                document: name.clone(),
                region_id: raw_region.id.clone(),
                message: error.to_string(),
            })?;
            plot.validate().map_err(|message| LoadError::Plot {
                document: name.clone(),
                region_id: raw_region.id.clone(),
                message,
            })?;
            regions.push(DocumentRegion::Plot(Box::new(PlotRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                plot,
                // the on-screen view is never read from or written to a file.
                view: None,
            })));
        } else if let Some(image) = raw_region.image {
            let image: RawImage = serde_json::from_value(image)
                .map_err(|e| image_error(&raw_region.id, e.to_string()))?;
            if !resources.contains_key(&image.resource) && !assets.contains_key(&image.resource) {
                return Err(image_error(
                    &raw_region.id,
                    format!("resource `{}` does not exist", image.resource),
                ));
            }
            if image.size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
                return Err(image_error(
                    &raw_region.id,
                    "size must be two positive finite numbers".into(),
                ));
            }
            regions.push(DocumentRegion::Image(crate::image::ImageRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                resource: image.resource,
                size: image.size,
            }));
        } else if let Some(area) = raw_region.area {
            if !crate::area::valid_height(area.height) {
                return Err(LoadError::Area {
                    document: name,
                    region_id: raw_region.id,
                    message: format!(
                        "height must be a finite number of at least {} pt",
                        crate::area::MIN_AREA_HEIGHT
                    ),
                });
            }
            regions.push(DocumentRegion::Area(crate::area::AreaRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                title: area.title,
                height: area.height,
                collapsed: area.collapsed,
            }));
        } else if let Some(table) = raw_region.table {
            let table: crate::table::TableSpec =
                serde_json::from_value(table).map_err(|e| LoadError::Yaml {
                    document: name.clone(),
                    message: format!("table `{}`: {e}", raw_region.id),
                })?;
            let region = crate::table::TableRegion {
                id: raw_region.id,
                page,
                x,
                y,
                enabled,
                table,
            };
            if !region.valid() {
                return Err(LoadError::Yaml {
                    document: name.clone(),
                    message: format!(
                        "table `{}` must have rectangular non-empty columns",
                        region.id
                    ),
                });
            }
            // an old table becomes a math region holding the table statement.
            let text = region.table.statement_text();
            let statement = parse_statement(&text).map_err(|error| LoadError::Math {
                document: name.clone(),
                region_id: region.id.clone(),
                error: Box::new(error),
            })?;
            texts.insert(region.id.clone(), text);
            regions.push(DocumentRegion::Math(Box::new(Region {
                id: region.id,
                page: region.page,
                x: region.x,
                y: region.y,
                enabled: region.enabled,
                statement: std::sync::Arc::new(statement),
            })));
        } else {
            return Err(LoadError::UnknownRegion {
                document: name,
                region_id: raw_region.id,
            });
        }
    }
    let mut document = ProjectDocument {
        id,
        content_hash: content_hash(content),
        settings,
        environment: raw.environment,
        page,
        result_formats,
        numeric_options,
        math_breaks,
        resources,
        assets,
        page_breaks,
        // The document shares its regions; the parsed regions are built fresh here.
        regions: regions.into_iter().map(std::sync::Arc::new).collect(),
    };
    // A text block ignores a stored x: it starts at the left margin.
    document.snap_text_blocks();
    Ok(LoadedDocument {
        document,
        texts,
        migrated_from,
        notes,
    })
}

fn julia_block(document: &str, region_id: &str, raw: RawJulia) -> Result<JuliaBlock, LoadError> {
    let fail = |message: String| LoadError::Julia {
        document: document.to_owned(),
        region_id: region_id.to_owned(),
        message,
    };
    // The box of the block is drawn at exactly this size, so it has to be a size.
    if let Some(size) = raw.size {
        if size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err(fail("size must be two positive finite numbers".into()));
        }
    }
    let mut imports = Vec::new();
    for (name, path) in raw.imports {
        let parts: Vec<&str> = path.split('.').collect();
        match parts.as_slice() {
            [package, function]
                if crate::julia_code::is_identifier(package)
                    && crate::julia_code::is_identifier(function) =>
            {
                imports.push(JuliaImportDecl {
                    name,
                    package: (*package).to_owned(),
                    function: (*function).to_owned(),
                });
            }
            _ => {
                return Err(fail(format!(
                    "import `{name}` must be written `Package.function`, found `{path}`"
                )))
            }
        }
    }
    Ok(JuliaBlock {
        playing: raw.playing.unwrap_or(true),
        size: raw.size.map(|[width, height]| (width, height)),
        using: raw.using,
        imports,
        // A block scalar ends with one line break that is not part of the code; a keeping one
        // (`|+`) holds the code's trailing empty lines before it (section 2, `code`).
        code: raw.code.and_then(|code| {
            let code = code.strip_suffix('\n').unwrap_or(&code);
            crate::julia_code::stored_code(code)
        }),
        defines: raw.define,
    })
}

/// A deterministic hash of the file text, used in include cache keys.
pub fn content_hash(content: &str) -> String {
    // `DefaultHasher::new()` uses fixed keys, so the value is stable for one build.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// The document id of a file path (absolute, forward slashes).
pub fn document_id_for_path(path: &Path) -> Result<DocumentId, LoadError> {
    let absolute = std::path::absolute(path).map_err(|error| LoadError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    Ok(DocumentId::new(&absolute.to_string_lossy())?)
}

/// The file behind a document id.
pub fn path_for_document(id: &DocumentId) -> PathBuf {
    PathBuf::from(id.as_str())
}

/// Reads one document file.
pub fn load_document_file(id: &DocumentId) -> Result<LoadedDocument, LoadError> {
    let path = path_for_document(id);
    let content = std::fs::read_to_string(&path).map_err(|error| LoadError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    })?;
    parse_document(id.clone(), &content)
}

/// Loads a worksheet file and, recursively, every file it includes. An include target
/// that does not exist is recorded in `missing` (the project analysis reports it); any
/// other read or parse failure is an error.
pub fn load_project(root_path: &Path) -> Result<LoadedProject, LoadError> {
    let root = document_id_for_path(root_path)?;
    load_project_from(root, None)
}

/// Like [`load_project`], but the root document is parsed from `root_text` instead of being read
/// from its file: a recovery file restored under the name of the worksheet it belongs to (the
/// root may be a bare name such as `Untitled-3.eqv`, which has no file). Included files are read
/// from disk as usual.
pub fn load_project_text(root: DocumentId, root_text: &str) -> Result<LoadedProject, LoadError> {
    load_project_from(root, Some(root_text))
}

fn load_project_from(
    root: DocumentId,
    root_text: Option<&str>,
) -> Result<LoadedProject, LoadError> {
    let mut project = Project::new();
    let mut texts = HashMap::new();
    let mut missing = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = vec![root.clone()];
    while let Some(id) = queue.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let loaded = match root_text {
            Some(text) if id == root => parse_document(id.clone(), text)?,
            _ => {
                if !path_for_document(&id).exists() {
                    if id == root {
                        return Err(LoadError::Io {
                            path: id.to_string(),
                            message: "file not found".into(),
                        });
                    }
                    missing.push(id);
                    continue;
                }
                load_document_file(&id)?
            }
        };
        for region in &loaded.document.regions {
            if let DocumentRegion::Include(include) = region.as_ref() {
                queue.push(id.resolve(&include.path)?);
            }
        }
        for (region_id, text) in loaded.texts {
            texts.insert((id.clone(), region_id), text);
        }
        project.insert(loaded.document)?;
    }
    Ok(LoadedProject {
        project,
        root,
        texts,
        missing,
    })
}

#[cfg(test)]
mod rebind_tests {
    use super::rebind_plain_names;

    const SHEET: &str = "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 10]\n    math: \"L@var := 3\"\n  - id: b\n    at: [0, 20]\n    math: \"2·L + V + 3 m@unit =\"\n";

    #[test]
    fn a_plain_unit_spelling_the_file_defines_as_a_variable_is_that_variable() {
        let out = rebind_plain_names(SHEET).unwrap();
        // `L` is the variable the file defines; `V` is defined nowhere and stays a plain name, never a unit.
        assert!(out.contains("2·L@var + V + 3 m@unit ="), "{out}");
        assert!(!out.contains("V@unit"), "{out}");
    }

    #[test]
    fn a_file_with_no_explicit_variable_comes_back_unchanged() {
        let plain = "format: equavela-worksheet/3\nregions:\n  - id: b\n    at: [0, 20]\n    math: \"2 L + 3 m =\"\n";
        assert_eq!(rebind_plain_names(plain).unwrap(), plain);
    }
}
