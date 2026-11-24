//! Reversible edit commands on a worksheet document.
//!
//! [`apply`] performs one [`EditCommand`] on a document and returns its **inverse**: the
//! command that restores the previous state. The session keeps those inverses as the
//! undo stack and the inverses of the inverses as the redo stack, so every operation the
//! UI can do (add, remove, move, change math) is undoable by construction and the
//! frontend never keeps its own history.

use crate::area::AreaRegion;
use crate::image::{AssetReference, ImageResource, MIN_IMAGE_SIZE};
use crate::layout::{PageBreak, PageSetup};
use crate::plot::PlotSpec;
use crate::project::{DocumentRegion, ProjectDocument};
use crate::richtext::canonical;
use crate::syntax::{parse_statement, ParseError};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// A region together with the source text of its math (math regions only), which is what
/// is needed to put a removed region back.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredRegion {
    pub region: DocumentRegion,
    pub math_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EditCommand {
    /// Inserts a region at `index` of the document's region list.
    Insert { region: StoredRegion, index: usize },
    /// Removes the region with this id.
    Remove { region_id: String },
    /// Moves a region to a page and a position in points.
    Move {
        region_id: String,
        page: u32,
        x: f64,
        y: f64,
    },
    /// Replaces the math text of a math region and its presentation-only line breaks.
    SetMath {
        region_id: String,
        text: String,
        breaks: Vec<crate::layout::MathBreak>,
    },
    /// Replaces the text of a text region. `text` is linear text;
    /// it is stored in canonical form, so the inverse restores exactly the old text.
    SetText { region_id: String, text: String },
    /// Sets the width in points of a region that has one (text regions today; plot and image
    /// regions will take the same command), or `None` for the default width.
    SetWidth {
        region_id: String,
        width: Option<f64>,
    },
    /// Sets the fill of a text region as `#rrggbb`, or `None` for no fill.
    SetTextBackground {
        region_id: String,
        background: Option<String>,
    },
    /// Sets the spelling language of a text region as a dictionary id, or `None` to follow the
    /// worksheet.
    SetTextLanguage {
        region_id: String,
        language: Option<String>,
    },
    /// Sets (`Some`) or removes (`None`) the spelling keys of the worksheet `settings:` mapping,
    /// `spelling.language` and `spelling.ignore`; display only, no value
    /// is recalculated.
    SetSpelling {
        values: BTreeMap<String, Option<String>>,
    },
    /// Disables the region
    ///  or enables it again; content, place and size stay as they are.
    SetEnabled { region_id: String, enabled: bool },
    /// Replaces the page setup of the document. The
    /// regions that would sit in the new left or top margin move into the printable area in the
    /// same undo step, so the inverse is a batch that restores the old page setup first.
    SetPageSetup { page: PageSetup },
    /// Sets or clears (`None`, or an empty map) the result-format override of a math region
    ///: keys of the `format.*` display settings.
    SetResultFormat {
        region_id: String,
        format: Option<BTreeMap<String, String>>,
    },
    /// Sets or clears (`None`, or an empty map) the numeric choices of a math region: the solver
    /// algorithm and options, the derivative method. They change values.
    SetNumericOptions {
        region_id: String,
        options: Option<BTreeMap<String, String>>,
    },
    /// Sets (`Some`) or removes (`None`) entries of the worksheet `settings:` mapping: the
    /// worksheet-wide result format of `the specification`, keys of the
    /// `format.*` display settings. Only display settings are accepted: a calculation setting
    /// (`TOL`, `exact-boolean`) changes results and has no edit path yet. The values themselves
    /// are not checked here; the reader that uses them ignores the ones it does not know
    /// (`formatFromSettings`), as it does for a hand-written file.
    SetResultDefaults {
        values: BTreeMap<String, Option<String>>,
    },
    /// Sets (`Some`) or removes (`None`) the calculation settings of the worksheet
    /// `settings:` mapping: the two tolerances `TOL` and `CTOL` of `the specification`.
    /// Only those two keys are accepted: a
    /// display setting belongs to [`EditCommand::SetResultDefaults`], and the settings this
    /// feature does not model are refused. The values themselves are not checked here (a
    /// value that is not a number keeps the built-in default, as in a hand-written file). In a
    /// session the *effect* is a whole-worksheet recalculation (`WorksheetSession`); the values
    /// a worksheet already has change nothing.
    SetCalculationSettings {
        values: BTreeMap<String, Option<String>>,
    },
    /// Sets (`Some`) or removes (`None`) entries of the worksheet `settings:` mapping: the
    /// worksheet-wide label styles of `the specification`, keys of the form
    /// `label-style.<label>.<property>` with a label of `the specification` (variable,
    /// constant, function, unit, system, keyword) and a property `bold`, `italic`, `underline` or
    /// `color`. Only a label style is accepted: a
    /// result format belongs to [`EditCommand::SetResultDefaults`], a calculation setting to
    /// [`EditCommand::SetCalculationSettings`], and anything else is refused. The values themselves
    /// are not checked here (a flag that is not `true`/`false`, a colour that is not `#rrggbb`, keeps
    /// the built-in property, as in a hand-written file), and no value is recalculated: a label style
    /// is display only.
    SetLabelStyles {
        values: BTreeMap<String, Option<String>>,
    },
    /// Replaces the code of a `julia` block and derives its `using` and `import` fields from
    /// that code; the play/stop state and the
    /// `define` list are kept. One committed edit is one undo step.
    SetJulia { region_id: String, code: String },
    /// Puts a whole `julia` block back: the inverse of [`EditCommand::SetJulia`] and of
    /// [`EditCommand::SetJuliaPlaying`], so undo restores fields that the derivation would
    /// rewrite (a hand-written `using`/`import` the code does not contain).
    SetJuliaBlock {
        region_id: String,
        block: crate::ast::JuliaBlock,
    },
    /// Plays or stops a `julia` block: a stopped block
    /// is never evaluated and exports no name.
    SetJuliaPlaying { region_id: String, playing: bool },
    /// Sets the size in points of the box a `julia` block is drawn in, or `None` for a block that
    /// grows with its content. Display only: nothing is
    /// recalculated. The inverse restores the previous size, so one drag is one undo step.
    SetJuliaSize {
        region_id: String,
        size: Option<(f64, f64)>,
    },
    /// Replaces the specification of a plot region;
    /// it is validated first. One command covers every plot
    /// edit so each is a single undo step.
    SetPlot {
        region_id: String,
        plot: Box<PlotSpec>,
    },
    /// Adds an image resource under `id`. Adding bytes that are already stored
    /// under that id changes nothing.
    AddResource { id: String, resource: ImageResource },
    /// Drops an image resource that no region uses any more (the inverse of `AddResource`).
    DropResource { id: String },
    /// Sets (`Some`) or removes (`None`) the worksheet's `environment:` override:
    /// a directory relative to the worksheet file, or absolute.
    SetEnvironment { environment: Option<String> },
    /// Adds an image resource that names a project file. Adding the same
    /// reference under that id changes nothing. The file itself is never touched by an edit.
    AddAsset { id: String, asset: AssetReference },
    /// Drops an asset resource that no region uses any more (the inverse of `AddAsset`).
    DropAsset { id: String },
    /// Sets the size in points of an image region.
    SetImageSize { region_id: String, size: [f64; 2] },
    /// Points an image region at another resource of the document, keeping its id, page and
    /// position. The resource must be stored.
    SetImageResource { region_id: String, resource: String },
    /// Sets the title, the band height in points and the collapsed flag of an area region;
    /// one command covers every area edit so each is a single undo step.
    SetArea {
        region_id: String,
        title: String,
        height: f64,
        collapsed: bool,
    },
    /// Ends a page on purpose at `y` points: the break is stored and the
    /// caller moves the content below the caret line in the same [`EditCommand::Batch`], so the whole
    /// gesture is one undo step. A page that already ends with a break is refused.
    AddPageBreak { page: u32, y: f64 },
    /// Removes the break of that page; the inverse of [`EditCommand::AddPageBreak`] and the
    /// caller moves the content back in the same batch. `y` is not needed: a page ends once.
    RemovePageBreak { page: u32 },
    /// Replaces the path of an include region (GitHub ): another file to include, or the new
    /// name of the same one. The path is stored as given; it must not be
    /// empty and must resolve against the document's folder.
    SetIncludePath { region_id: String, path: String },
    /// Grows the band of every area that holds one of these regions so that it holds the region's
    /// stored bottom. The caller puts it after a resize or a move in the
    /// same [`EditCommand::Batch`]. The inverse sets the old heights back.
    HoldMembers { region_ids: Vec<String> },
    /// Several commands applied in order; it fails as a whole.
    Batch { commands: Vec<EditCommand> },
}

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("there is no region `{0}` in the document")]
    NoSuchRegion(String),
    #[error("`{0}` is not a math region")]
    NotMath(String),
    #[error("invalid numeric choices: {0}")]
    InvalidNumeric(String),
    #[error("`{0}` is not a text region")]
    NotText(String),
    #[error("`{0}` is not a plot region")]
    NotPlot(String),
    #[error("`{0}` is not an include region")]
    NotInclude(String),
    #[error("an include path must not be empty and must be a valid path: {0}")]
    BadIncludePath(String),
    #[error("`{0}` is not a Julia block")]
    NotJulia(String),
    #[error("invalid plot: {0}")]
    BadPlot(String),
    #[error("`{0}` is not a table region")]
    NotTable(String),
    #[error("invalid table dimensions")]
    BadTable,
    #[error("`{0}` has no adjustable width")]
    NotResizable(String),
    #[error("a region width must be a positive finite number")]
    BadWidth,
    #[error("`{0}` is not a colour (#rrggbb)")]
    BadColor(String),
    #[error("`{0}` is not an image region")]
    NotImage(String),
    #[error("an image size must be finite and at least 12 x 12 pt")]
    BadImageSize,
    #[error("a Julia box size must be two positive finite numbers")]
    BadJuliaSize,
    #[error("there is no image resource `{0}`")]
    NoSuchResource(String),
    #[error("the image resource `{0}` exists with other content")]
    ResourceConflict(String),
    #[error("invalid image asset: {0}")]
    InvalidAsset(String),
    #[error("a Julia environment must name a directory")]
    InvalidEnvironment,
    #[error("the image resource `{0}` is still used by a region")]
    ResourceInUse(String),
    #[error("`{0}` is not an area region")]
    NotArea(String),
    #[error("invalid page setup: {0}")]
    BadPageSetup(String),
    #[error("an area height must be at least 24 pt")]
    BadAreaHeight,
    #[error("an area may not overlap another area")]
    AreaOverlap,
    #[error("a region `{0}` already exists")]
    DuplicateId(String),
    #[error("a region position must be finite")]
    NonFinite,
    #[error("`{0}` is not a display setting an edit may change")]
    NotDisplaySetting(String),
    #[error("`{0}` is not a spelling setting an edit may change")]
    NotSpelling(String),
    #[error("`{0}` is not a dictionary language id such as en_US")]
    BadLanguage(String),
    #[error("page {0} already ends with a page break")]
    PageBreakExists(u32),
    #[error("page {0} has no page break")]
    NoSuchPageBreak(u32),
    #[error("a page break needs a page of 1 or more and a y inside the page")]
    BadPageBreak,
    #[error("`{0}` is not a calculation setting an edit may change")]
    NotCalculationSetting(String),
    #[error("`{0}` is not a label style an edit may change")]
    NotLabelStyle(String),
    #[error("math syntax error: {0}")]
    Parse(ParseError),
}

/// Applies `command` to `document`; `texts` holds the math texts of this document by
/// region id. On success the inverse command is returned; on failure nothing changed.
///
/// Every command leaves the full-width text blocks at the left margin
/// ([`ProjectDocument::snap_text_blocks`]), so a block never moves sideways, whatever x an
/// insertion or a move asks for.
pub fn apply(
    document: &mut ProjectDocument,
    texts: &mut HashMap<String, String>,
    command: EditCommand,
) -> Result<EditCommand, EditError> {
    let inverse = apply_command(document, texts, command)?;
    document.snap_text_blocks();
    Ok(inverse)
}

fn apply_command(
    document: &mut ProjectDocument,
    texts: &mut HashMap<String, String>,
    command: EditCommand,
) -> Result<EditCommand, EditError> {
    match command {
        EditCommand::Insert { region, index } => {
            let id = region.region.id().to_owned();
            if document.regions.iter().any(|existing| existing.id() == id) {
                return Err(EditError::DuplicateId(id));
            }
            if !region.region.x().is_finite() || !region.region.y().is_finite() {
                return Err(EditError::NonFinite);
            }
            if let DocumentRegion::Area(area) = &region.region {
                check_area(document, area)?;
            }
            let index = index.min(document.regions.len());
            if let Some(text) = region.math_text {
                texts.insert(id.clone(), text);
            }
            document.regions.insert(index, Arc::new(region.region));
            Ok(EditCommand::Remove { region_id: id })
        }
        EditCommand::Remove { region_id } => {
            let index = position(document, &region_id)?;
            let region = Arc::unwrap_or_clone(document.regions.remove(index));
            let math_text = texts.remove(&region_id);
            let format = document.result_formats.remove(&region_id);
            let numeric = document.numeric_options.remove(&region_id);
            let insert = EditCommand::Insert {
                region: StoredRegion { region, math_text },
                index,
            };
            // The region's override and numeric choices come back with it.
            let mut commands = vec![insert];
            if let Some(format) = format {
                commands.push(EditCommand::SetResultFormat {
                    region_id: region_id.clone(),
                    format: Some(format),
                });
            }
            if let Some(options) = numeric {
                commands.push(EditCommand::SetNumericOptions {
                    region_id,
                    options: Some(options),
                });
            }
            Ok(if commands.len() == 1 {
                commands.remove(0)
            } else {
                EditCommand::Batch { commands }
            })
        }
        EditCommand::Move {
            region_id,
            page,
            x,
            y,
        } => {
            if !x.is_finite() || !y.is_finite() {
                return Err(EditError::NonFinite);
            }
            let index = position(document, &region_id)?;
            if let DocumentRegion::Area(area) = document.regions[index].as_ref() {
                check_area(
                    document,
                    &AreaRegion {
                        page,
                        y,
                        ..area.clone()
                    },
                )?;
            }
            let region = Arc::make_mut(&mut document.regions[index]);
            let inverse = EditCommand::Move {
                region_id,
                page: region.page(),
                x: region.x(),
                y: region.y(),
            };
            region.set_position(page, x, y);
            Ok(inverse)
        }
        EditCommand::SetMath {
            region_id,
            text,
            breaks,
        } => {
            let statement = parse_statement(&text).map_err(EditError::Parse)?;
            let index = position(document, &region_id)?;
            let DocumentRegion::Math(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotMath(region_id));
            };
            let previous = texts.get(&region_id).cloned().unwrap_or_default();
            let previous_breaks = document.math_breaks.remove(&region_id).unwrap_or_default();
            region.statement = Arc::new(statement);
            texts.insert(region_id.clone(), text);
            if !breaks.is_empty() {
                document.math_breaks.insert(region_id.clone(), breaks);
            }
            Ok(EditCommand::SetMath {
                region_id,
                text: previous,
                breaks: previous_breaks,
            })
        }
        EditCommand::SetText { region_id, text } => {
            let index = position(document, &region_id)?;
            let DocumentRegion::Text(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotText(region_id));
            };
            let previous = std::mem::replace(&mut region.text, canonical(&text));
            Ok(EditCommand::SetText {
                region_id,
                text: previous,
            })
        }
        EditCommand::SetWidth { region_id, width } => {
            if width.is_some_and(|w| !w.is_finite() || w <= 0.0) {
                return Err(EditError::BadWidth);
            }
            let index = position(document, &region_id)?;
            let DocumentRegion::Text(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotResizable(region_id));
            };
            if region.full_width {
                return Err(EditError::NotResizable(region_id));
            }
            let previous = std::mem::replace(&mut region.width, width);
            Ok(EditCommand::SetWidth {
                region_id,
                width: previous,
            })
        }
        EditCommand::SetTextBackground {
            region_id,
            background,
        } => {
            let background = match background {
                Some(color) => Some(
                    crate::richtext::normalize_color(&color).ok_or(EditError::BadColor(color))?,
                ),
                None => None,
            };
            let index = position(document, &region_id)?;
            let DocumentRegion::Text(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotText(region_id));
            };
            let previous = std::mem::replace(&mut region.background, background);
            Ok(EditCommand::SetTextBackground {
                region_id,
                background: previous,
            })
        }
        EditCommand::SetTextLanguage {
            region_id,
            language,
        } => {
            if let Some(value) = &language {
                if !crate::spell::is_language_id(value) {
                    return Err(EditError::BadLanguage(value.clone()));
                }
            }
            let index = position(document, &region_id)?;
            let DocumentRegion::Text(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotText(region_id));
            };
            if region.language == language {
                return Ok(EditCommand::Batch { commands: vec![] });
            }
            let previous = std::mem::replace(&mut region.language, language);
            Ok(EditCommand::SetTextLanguage {
                region_id,
                language: previous,
            })
        }
        EditCommand::SetSpelling { values } => {
            if let Some(key) = values.keys().find(|key| !is_spelling_key(key)) {
                return Err(EditError::NotSpelling(key.clone()));
            }
            let mut previous = BTreeMap::new();
            let mut changed = false;
            for (key, value) in values {
                let before = match &value {
                    Some(value) => document.settings.values.insert(key.clone(), value.clone()),
                    None => document.settings.values.remove(&key),
                };
                changed |= before != value;
                previous.insert(key, before);
            }
            if !changed {
                return Ok(EditCommand::Batch { commands: vec![] });
            }
            Ok(EditCommand::SetSpelling { values: previous })
        }
        EditCommand::SetEnabled { region_id, enabled } => {
            let index = position(document, &region_id)?;
            let region = Arc::make_mut(&mut document.regions[index]);
            let previous = region.enabled();
            region.set_enabled(enabled);
            Ok(EditCommand::SetEnabled {
                region_id,
                enabled: previous,
            })
        }
        EditCommand::SetJulia { region_id, code } => {
            let (previous, changed) = with_julia_block(document, &region_id, |block| {
                let code = crate::julia_code::stored_code(&code);
                let declarations = crate::julia_code::declarations(code.as_deref().unwrap_or(""));
                let next = crate::ast::JuliaBlock {
                    code,
                    using: declarations.using,
                    imports: declarations.imports,
                    ..block.clone()
                };
                let changed = next != *block;
                *block = next;
                changed
            })?;
            if !changed {
                // The same code with the same derived fields: nothing to undo.
                return Ok(EditCommand::Batch {
                    commands: Vec::new(),
                });
            }
            Ok(EditCommand::SetJuliaBlock {
                region_id,
                block: previous,
            })
        }
        EditCommand::SetJuliaBlock { region_id, block } => {
            let (previous, _) = with_julia_block(document, &region_id, |current| {
                *current = block;
            })?;
            Ok(EditCommand::SetJuliaBlock {
                region_id,
                block: previous,
            })
        }
        EditCommand::SetJuliaPlaying { region_id, playing } => {
            let (previous, changed) = with_julia_block(document, &region_id, |block| {
                let before = block.playing;
                block.playing = playing;
                before != playing
            })?;
            if !changed {
                return Ok(EditCommand::Batch {
                    commands: Vec::new(),
                });
            }
            Ok(EditCommand::SetJuliaPlaying {
                region_id,
                playing: previous.playing,
            })
        }
        EditCommand::SetJuliaSize { region_id, size } => {
            if size.is_some_and(|(width, height)| {
                !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0
            }) {
                return Err(EditError::BadJuliaSize);
            }
            let (previous, changed) = with_julia_block(document, &region_id, |block| {
                let before = block.size;
                block.size = size;
                before != size
            })?;
            if !changed {
                // The size the box already has: nothing to undo.
                return Ok(EditCommand::Batch {
                    commands: Vec::new(),
                });
            }
            Ok(EditCommand::SetJuliaSize {
                region_id,
                size: previous.size,
            })
        }
        EditCommand::SetIncludePath { region_id, path } => {
            let path = path.trim().to_owned();
            if path.is_empty() {
                return Err(EditError::BadIncludePath("the path is empty".into()));
            }
            document
                .id
                .resolve(&path)
                .map_err(|error| EditError::BadIncludePath(error.to_string()))?;
            let index = position(document, &region_id)?;
            let DocumentRegion::Include(region) = Arc::make_mut(&mut document.regions[index])
            else {
                return Err(EditError::NotInclude(region_id));
            };
            let previous = std::mem::replace(&mut region.path, path);
            Ok(EditCommand::SetIncludePath {
                region_id,
                path: previous,
            })
        }
        EditCommand::SetPlot { region_id, plot } => {
            plot.validate().map_err(EditError::BadPlot)?;
            let index = position(document, &region_id)?;
            let DocumentRegion::Plot(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotPlot(region_id));
            };
            let previous = std::mem::replace(&mut region.plot, *plot);
            Ok(EditCommand::SetPlot {
                region_id,
                plot: Box::new(previous),
            })
        }
        EditCommand::SetPageSetup { page } => {
            page.validate().map_err(EditError::BadPageSetup)?;
            let page = page.canonical_size();
            let previous = std::mem::replace(&mut document.page, page.clone());
            // a region whose stored position is now inside the left or the top margin moves
            // to that margin, on its own page; nothing else moves, so what the author laid out
            // comes back unchanged when the margins change back.
            let mut moves = Vec::new();
            for region in &document.regions {
                // An area is left alone: its band and the regions inside it are one container,
                // so moving the band on its own would silently change
                // which regions are its members.
                if matches!(region.as_ref(), DocumentRegion::Area(_)) {
                    continue;
                }
                let x = region.x().max(page.margins.left);
                let y = region.y().max(page.margins.top);
                if (x, y) == (region.x(), region.y()) {
                    continue;
                }
                moves.push(EditCommand::Move {
                    region_id: region.id().to_owned(),
                    page: region.page(),
                    x,
                    y,
                });
            }
            // Undo restores the page setup first, then the positions: the old positions are legal
            // again once their page is back.
            let mut inverse = vec![EditCommand::SetPageSetup { page: previous }];
            for to_margin in moves {
                // A move of a region that is not an area only fails on a position that is not
                // finite, which a document cannot hold; the page setup applies in any case.
                if let Ok(move_back) = apply(document, texts, to_margin) {
                    inverse.push(move_back);
                }
            }
            Ok(EditCommand::Batch { commands: inverse })
        }
        EditCommand::SetResultFormat { region_id, format } => {
            let index = position(document, &region_id)?;
            if !matches!(*document.regions[index], DocumentRegion::Math(_)) {
                return Err(EditError::NotMath(region_id));
            }
            let format = format.filter(|map| !map.is_empty());
            let previous = match format {
                Some(format) => document.result_formats.insert(region_id.clone(), format),
                None => document.result_formats.remove(&region_id),
            };
            Ok(EditCommand::SetResultFormat {
                region_id,
                format: previous,
            })
        }
        EditCommand::SetNumericOptions { region_id, options } => {
            let index = position(document, &region_id)?;
            if !matches!(*document.regions[index], DocumentRegion::Math(_)) {
                return Err(EditError::NotMath(region_id));
            }
            let options = options.filter(|map| !map.is_empty());
            if let Some(options) = &options {
                crate::numeric_options::validate(options).map_err(EditError::InvalidNumeric)?;
            }
            let previous = match options {
                Some(options) => document.numeric_options.insert(region_id.clone(), options),
                None => document.numeric_options.remove(&region_id),
            };
            Ok(EditCommand::SetNumericOptions {
                region_id,
                options: previous,
            })
        }
        EditCommand::SetResultDefaults { values } => {
            if let Some(key) = values.keys().find(|key| !key.starts_with("format.")) {
                return Err(EditError::NotDisplaySetting(key.clone()));
            }
            let mut previous = BTreeMap::new();
            for (key, value) in values {
                let before = match value {
                    Some(value) => document.settings.values.insert(key.clone(), value),
                    None => document.settings.values.remove(&key),
                };
                previous.insert(key, before);
            }
            Ok(EditCommand::SetResultDefaults { values: previous })
        }
        EditCommand::SetCalculationSettings { values } => {
            // ORIGIN and the two tolerances, and nothing else: the calculation settings the
            // worksheet model carries.
            if let Some(key) = values.keys().find(|key| !is_calculation_setting(key)) {
                return Err(EditError::NotCalculationSetting(key.clone()));
            }
            let mut previous = BTreeMap::new();
            let mut changed = false;
            for (key, value) in values {
                let before = match &value {
                    Some(value) => document.settings.values.insert(key.clone(), value.clone()),
                    None => document.settings.values.remove(&key),
                };
                changed |= before != value;
                previous.insert(key, before);
            }
            // The values the worksheet already has: no change, no recalculation, no undo step.
            if !changed {
                return Ok(EditCommand::Batch { commands: vec![] });
            }
            Ok(EditCommand::SetCalculationSettings { values: previous })
        }
        EditCommand::SetLabelStyles { values } => {
            // The label styles of the worksheet and nothing else: one block of keys per label.
            if let Some(key) = values.keys().find(|key| !is_label_style_key(key)) {
                return Err(EditError::NotLabelStyle(key.clone()));
            }
            let mut previous = BTreeMap::new();
            let mut changed = false;
            for (key, value) in values {
                let before = match &value {
                    Some(value) => document.settings.values.insert(key.clone(), value.clone()),
                    None => document.settings.values.remove(&key),
                };
                changed |= before != value;
                previous.insert(key, before);
            }
            // A style whose values the worksheet already has: no change and no undo step.
            if !changed {
                return Ok(EditCommand::Batch { commands: vec![] });
            }
            Ok(EditCommand::SetLabelStyles { values: previous })
        }
        EditCommand::AddResource { id, resource } => match document.resources.get(&id) {
            Some(existing) if *existing == resource => Ok(EditCommand::Batch { commands: vec![] }),
            Some(_) => Err(EditError::ResourceConflict(id)),
            None if document.assets.contains_key(&id) => Err(EditError::ResourceConflict(id)),
            None => {
                document.resources.insert(id.clone(), resource);
                Ok(EditCommand::DropResource { id })
            }
        },
        EditCommand::DropResource { id } => {
            if document.regions.iter().any(|region| {
                matches!(region.as_ref(), DocumentRegion::Image(image) if image.resource == id)
            }) {
                return Err(EditError::ResourceInUse(id));
            }
            let resource = document
                .resources
                .remove(&id)
                .ok_or_else(|| EditError::NoSuchResource(id.clone()))?;
            Ok(EditCommand::AddResource { id, resource })
        }
        EditCommand::SetEnvironment { environment } => {
            if environment
                .as_deref()
                .is_some_and(|path| path.trim().is_empty())
            {
                return Err(EditError::InvalidEnvironment);
            }
            if document.environment == environment {
                return Ok(EditCommand::Batch { commands: vec![] });
            }
            let previous = std::mem::replace(&mut document.environment, environment);
            Ok(EditCommand::SetEnvironment {
                environment: previous,
            })
        }
        EditCommand::AddAsset { id, asset } => match document.assets.get(&id) {
            Some(existing) if *existing == asset => Ok(EditCommand::Batch { commands: vec![] }),
            Some(_) => Err(EditError::ResourceConflict(id)),
            None if document.resources.contains_key(&id) => Err(EditError::ResourceConflict(id)),
            None => {
                crate::image::validate_asset(&asset).map_err(EditError::InvalidAsset)?;
                document.assets.insert(id.clone(), asset);
                Ok(EditCommand::DropAsset { id })
            }
        },
        EditCommand::DropAsset { id } => {
            if document.regions.iter().any(|region| {
                matches!(region.as_ref(), DocumentRegion::Image(image) if image.resource == id)
            }) {
                return Err(EditError::ResourceInUse(id));
            }
            let asset = document
                .assets
                .remove(&id)
                .ok_or_else(|| EditError::NoSuchResource(id.clone()))?;
            Ok(EditCommand::AddAsset { id, asset })
        }
        EditCommand::SetArea {
            region_id,
            title,
            height,
            collapsed,
        } => {
            let index = position(document, &region_id)?;
            let DocumentRegion::Area(area) = document.regions[index].as_ref() else {
                return Err(EditError::NotArea(region_id));
            };
            let height = (height * 100.0).round() / 100.0;
            check_area(
                document,
                &AreaRegion {
                    height,
                    ..area.clone()
                },
            )?;
            let DocumentRegion::Area(area) = Arc::make_mut(&mut document.regions[index]) else {
                unreachable!("checked above")
            };
            let previous = EditCommand::SetArea {
                region_id,
                title: std::mem::replace(&mut area.title, title),
                height: std::mem::replace(&mut area.height, height),
                collapsed: std::mem::replace(&mut area.collapsed, collapsed),
            };
            Ok(previous)
        }
        EditCommand::SetImageSize { region_id, size } => {
            if size.iter().any(|v| !v.is_finite() || *v < MIN_IMAGE_SIZE) {
                return Err(EditError::BadImageSize);
            }
            let size = [
                (size[0] * 100.0).round() / 100.0,
                (size[1] * 100.0).round() / 100.0,
            ];
            let index = position(document, &region_id)?;
            let DocumentRegion::Image(region) = Arc::make_mut(&mut document.regions[index]) else {
                return Err(EditError::NotImage(region_id));
            };
            let previous = std::mem::replace(&mut region.size, size);
            Ok(EditCommand::SetImageSize {
                region_id,
                size: previous,
            })
        }
        EditCommand::SetImageResource {
            region_id,
            resource,
        } => {
            let index = position(document, &region_id)?;
            if !matches!(*document.regions[index], DocumentRegion::Image(_)) {
                return Err(EditError::NotImage(region_id));
            }
            if !document.has_resource(&resource) {
                return Err(EditError::NoSuchResource(resource));
            }
            let DocumentRegion::Image(region) = Arc::make_mut(&mut document.regions[index]) else {
                unreachable!("checked above")
            };
            let previous = std::mem::replace(&mut region.resource, resource);
            Ok(EditCommand::SetImageResource {
                region_id,
                resource: previous,
            })
        }
        EditCommand::AddPageBreak { page, y } => {
            PageBreak { page, y }
                .validate(&document.page)
                .map_err(|_| EditError::BadPageBreak)?;
            if document.page_breaks.iter().any(|entry| entry.page == page) {
                return Err(EditError::PageBreakExists(page));
            }
            // The list stays sorted by page.
            let at = document
                .page_breaks
                .iter()
                .position(|entry| entry.page > page)
                .unwrap_or(document.page_breaks.len());
            document.page_breaks.insert(at, PageBreak { page, y });
            Ok(EditCommand::RemovePageBreak { page })
        }
        EditCommand::RemovePageBreak { page } => {
            let at = document
                .page_breaks
                .iter()
                .position(|entry| entry.page == page)
                .ok_or(EditError::NoSuchPageBreak(page))?;
            let removed = document.page_breaks.remove(at);
            Ok(EditCommand::AddPageBreak {
                page: removed.page,
                y: removed.y,
            })
        }
        EditCommand::HoldMembers { region_ids } => {
            let mut inverse = Vec::new();
            for (area_id, height) in crate::area::held_heights(document, &region_ids) {
                inverse.push(apply_command(
                    document,
                    texts,
                    EditCommand::SetArea {
                        title: area_title(document, &area_id),
                        collapsed: area_collapsed(document, &area_id),
                        region_id: area_id,
                        height,
                    },
                )?);
            }
            inverse.reverse();
            Ok(EditCommand::Batch { commands: inverse })
        }
        EditCommand::Batch { commands } => {
            let mut inverses: Vec<EditCommand> = Vec::with_capacity(commands.len());
            for command in commands {
                match apply(document, texts, command) {
                    // A step that changed nothing has nothing to undo (an empty batch): the
                    // batch changed nothing when all its steps did not (HoldMembers that grew no
                    // band, a size that was already stored).
                    Ok(EditCommand::Batch { commands }) if commands.is_empty() => {}
                    Ok(inverse) => inverses.push(inverse),
                    Err(error) => {
                        // Roll back what was applied.
                        for inverse in inverses.into_iter().rev() {
                            apply(document, texts, inverse)
                                .expect("an inverse command applies to the state it reverts");
                        }
                        return Err(error);
                    }
                }
            }
            inverses.reverse();
            Ok(EditCommand::Batch { commands: inverses })
        }
    }
}

fn area_title(document: &ProjectDocument, id: &str) -> String {
    match document
        .regions
        .iter()
        .find(|r| r.id() == id)
        .map(|r| r.as_ref())
    {
        Some(DocumentRegion::Area(area)) => area.title.clone(),
        _ => String::new(),
    }
}

fn area_collapsed(document: &ProjectDocument, id: &str) -> bool {
    matches!(
        document.regions.iter().find(|r| r.id() == id).map(|r| r.as_ref()),
        Some(DocumentRegion::Area(area)) if area.collapsed
    )
}

/// An area must have a valid height and may not overlap another area in the flow of the
/// sheet: its band may cross page breaks, so the bands of two areas are compared as
/// ranges of the flow, not as rectangles of one page.
fn check_area(document: &ProjectDocument, area: &AreaRegion) -> Result<(), EditError> {
    if !crate::area::valid_height(area.height) {
        return Err(EditError::BadAreaHeight);
    }
    let clash = document.regions.iter().any(|region| {
        matches!(
            region.as_ref(),
            DocumentRegion::Area(other)
                if other.id != area.id && other.overlaps(&document.page, area)
        )
    });
    if clash {
        return Err(EditError::AreaOverlap);
    }
    Ok(())
}

/// The calculation settings this feature models: the two tolerances.
fn is_calculation_setting(key: &str) -> bool {
    matches!(key, "ORIGIN" | "TOL" | "CTOL")
}

/// Whether `key` is a spelling key of the worksheet `settings:`.
fn is_spelling_key(key: &str) -> bool {
    key == "spelling.language" || key == "spelling.ignore"
}

/// The labels a name can carry.
const LABEL_KINDS: [&str; 6] = ["var", "const", "fn", "unit", "sys", "kw"];

/// The properties a label style sets.
const LABEL_PROPERTIES: [&str; 4] = ["bold", "italic", "underline", "color"];

/// Whether `key` is a label style of the worksheet `settings:`: `label-style.<label>.<property>`
/// with one of the six labels and one of the four properties, and nothing else.
fn is_label_style_key(key: &str) -> bool {
    let mut parts = key.split('.');
    if parts.next() != Some("label-style") {
        return false;
    }
    let (Some(label), Some(property), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    LABEL_KINDS.contains(&label) && LABEL_PROPERTIES.contains(&property)
}

/// Runs `change` on the `julia` block of region `region_id` and returns the block as it was
/// before and what `change` reported, or [`EditError::NotJulia`] when the region is not one.
fn with_julia_block<T>(
    document: &mut ProjectDocument,
    region_id: &str,
    change: impl FnOnce(&mut crate::ast::JuliaBlock) -> T,
) -> Result<(crate::ast::JuliaBlock, T), EditError> {
    let index = position(document, region_id)?;
    let DocumentRegion::Math(region) = Arc::make_mut(&mut document.regions[index]) else {
        return Err(EditError::NotJulia(region_id.to_owned()));
    };
    let statement = Arc::make_mut(&mut region.statement);
    let crate::ast::StatementKind::Julia { block } = &mut statement.kind else {
        return Err(EditError::NotJulia(region_id.to_owned()));
    };
    let previous = block.clone();
    let changed = change(block);
    Ok((previous, changed))
}

fn position(document: &ProjectDocument, region_id: &str) -> Result<usize, EditError> {
    document
        .regions
        .iter()
        .position(|region| region.id() == region_id)
        .ok_or_else(|| EditError::NoSuchRegion(region_id.to_owned()))
}
