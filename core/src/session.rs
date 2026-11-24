//! The worksheet session: the UI-agnostic service that connects a worksheet to the kernel.
//!
//! A [`WorksheetSession`] owns a [`Project`] (the root document and its includes), a
//! shared [`KernelManager`] and the results of the last evaluation. It
//!
//! - re-analyses and re-generates after every edit and finds the regions whose generated
//!   Julia (or whose results) are out of date, plus everything that depends on them
//!   ([`DependencyGraph::affected_by`]); those regions are `Stale`;
//! - on [`recalculate`](WorksheetSession::recalculate) sends only the affected regions to
//!   the kernel, one `evaluate` request per region in evaluation order, so a region whose
//!   producer failed is never sent: it is reported as failed with "depends on failed
//!   region X" ([`FailureTracker`]);
//! - maps kernel errors back to source spans (the program statement id of `eq_locate`
//!   through [`GeneratedWorksheet::statements`]) and demangles generated identifiers in
//!   messages;
//! - detects a kernel restart ([`KernelManager::generation`]) and then resends the whole
//!   worksheet with `reset`.
//!
//! Results live in a shared store ([`ResultsHandle`]) that is updated while a pass runs,
//! so another thread can read them. [`InterruptHandle`] is cloneable and stops a pass
//! from another thread. Results are keyed by [`RegionKey`]: document, region id and the
//! occurrence number (a document included twice has two instances of each region).

mod fast_symbolic;
mod inspect;
pub use fast_symbolic::{fast_symbolic_result, FastSymbolicInput};

use crate::ast::{JuliaBlock, Name, Span, Statement, StatementKind};
use crate::codegen::{
    demangle_ident, generate_worksheet_with, symbolic_definition_code, GenOptions, GeneratedRegion,
    GeneratedWorksheet,
};
use crate::edit::{self, EditCommand, EditError};
use crate::environment::{resolve_environment_with_archive, WorksheetEnvironment};
use crate::graph::{DependencyGraph, FailureTracker, GraphError};
use crate::kernel::ProgressParams;
use crate::kernel_manager::{
    EvaluateRequest, InstallResult, KernelError, KernelInfo, KernelManager, RegionError,
    RegionInput, RegionOutcome,
};
use crate::kernel_value::KernelValue;
use crate::layout::PageSetup;
use crate::plot::{self, ExpressionResult, PlotData, PlotScope, ViewRange};
use crate::project::{
    DiagnosticKind, DocumentId, DocumentRegion, NodeKind, Project, ProjectAnalysis,
    ProjectDocument, ProjectError,
};
use crate::richtext::RichText;
use crate::stored_results::{StoredEntry, StoredState};
use crate::symbolic::{
    region_request_in, request_json, statements_by_id, SymbolicOutcome, SymbolicRequest,
};
use crate::syntax::{print_name, print_statement, ParseError};
use crate::worksheet_file::{load_document_file, path_for_document};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

pub use inspect::{
    DefinitionInfo, DefinitionValue, IncludeInfo, Inspection, IntrinsicInfo, ReferenceInfo,
    WarningInfo,
};

// ---------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------

/// Identifies one region instance of the expanded project.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RegionKey {
    pub document: DocumentId,
    pub region_id: String,
    /// Zero for a region of the root document; a document that is included several times
    /// has one instance per inclusion.
    pub instance: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The kernel evaluated the region and it failed (the reference application error or Julia exception).
    Evaluation,
    /// Not evaluated because a region it depends on failed.
    Blocked,
    /// The calculation was interrupted while this region ran.
    Interrupted,
    /// The region runs Julia and the worksheet is not trusted.
    NotTrusted,
    /// The kernel could not be reached or died.
    Kernel,
}

/// Why a region has no value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegionFailure {
    pub kind: FailureKind,
    pub message: String,
    /// The offending source range inside the region's math text: the program statement
    /// reported by the kernel, or the whole statement.
    pub span: Option<Span>,
    /// For `Blocked`: the failed region this one depends on.
    pub blocked_by: Option<RegionKey>,
    /// Set for Julia exceptions that are not the reference application errors.
    pub julia_type: Option<String>,
    /// The package a `MissingPackage` failure needs.
    #[serde(default)]
    pub package: Option<String>,
}

/// The unit override of an evaluation: a formatting instruction.
/// `value` stays in SI base units; the UI shows `value / divisor` followed by `text`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DisplayUnit {
    /// The unit expression as written, in the worksheet syntax (`km/hr`).
    pub text: String,
    /// The SI value of the unit: dividing the SI result by it converts to the unit.
    pub divisor: f64,
    /// The SI value of the unit's zero, subtracted first: 273.15 K for `°C`, 0 for every
    /// other unit. The UI shows `(value - offset) / divisor`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub offset: f64,
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

/// The state of one region.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegionState {
    /// Never calculated (or its last calculation failed and it is awaiting a retry).
    Pending,
    /// Invalidated by an edit; `value` is the last good value, if any.
    Stale {
        #[serde(serialize_with = "display_value")]
        value: Option<KernelValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_unit: Option<DisplayUnit>,
    },
    /// Calculated. `None` for a region that only defines names.
    Value {
        #[serde(serialize_with = "display_value")]
        value: Option<KernelValue>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display_unit: Option<DisplayUnit>,
    },
    Error {
        failure: RegionFailure,
    },
}

/// A result as the frontend receives it: a large matrix goes as its first block, and
/// the rest is read with [`ResultsHandle::block`].
fn display_value<S: serde::Serializer>(
    value: &Option<KernelValue>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    value
        .as_ref()
        .map(KernelValue::display_form)
        .serialize(serializer)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegionEntry {
    pub key: RegionKey,
    #[serde(flatten)]
    pub state: RegionState,
    /// What a Julia cell's last evaluation wrote, how long it took and its trace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<CellOutput>,
}

/// The output of a Julia cell's last evaluation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CellOutput {
    /// stdout and stderr, interleaved in the order written.
    pub text: String,
    pub duration_ms: f64,
    /// The Julia stack trace of a failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<String>,
}

/// Kernel lifecycle as seen by a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum KernelStatus {
    /// No kernel process yet (the initial state of an application; sessions never emit it).
    NotStarted,
    Starting,
    Ready {
        info: KernelInfo,
    },
    Busy,
    Crashed {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PassSummary {
    /// Regions in the affected set.
    pub affected: usize,
    pub evaluated: usize,
    pub failed: usize,
    pub blocked: usize,
    /// The kernel module was reset first (first pass, Ctrl+F5, kernel restart).
    pub reset: bool,
    /// The pass stopped early because of an interrupt or a kernel failure; the regions
    /// that were not reached stay `Stale` (with no value if never calculated).
    pub incomplete: bool,
}

/// Progress notifications of a calculation pass, in order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum SessionEvent {
    Kernel {
        #[serde(flatten)]
        status: KernelStatus,
    },
    PassStarted {
        affected: usize,
        reset: bool,
    },
    RegionStarted {
        key: RegionKey,
    },
    /// Kernel progress of a long-running region.
    RegionProgress {
        key: RegionKey,
        fraction: Option<f64>,
        message: Option<String>,
    },
    RegionUpdated {
        entry: RegionEntry,
    },
    /// The calculated data of a plot region changed (any of its trace expressions was
    /// evaluated or failed); fetch it again with `plot_data`.
    PlotUpdated {
        document: DocumentId,
        region_id: String,
    },
    PassFinished {
        summary: PassSummary,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecalcMode {
    /// F5: evaluate what is out of date (changed, failed, never calculated).
    Changed,
    /// Ctrl+F5: reset the kernel module and evaluate every region.
    All,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error(transparent)]
    Graph(#[from] GraphError),
    #[error("math syntax error: {0}")]
    Parse(ParseError),
    #[error("`{region_id}` in `{document}` is not a math region")]
    NotAMathRegion {
        document: DocumentId,
        region_id: String,
    },
    #[error(transparent)]
    Kernel(#[from] KernelError),
    #[error(transparent)]
    Edit(EditError),
    #[error("the worksheet is not trusted: Julia packages are not installed or run")]
    NotTrusted,
    #[error("there is no Julia environment directory for this worksheet")]
    NoEnvironment,
    #[error("no packages to install")]
    NothingToInstall,
    #[error("could not read the included worksheet `{path}`: {message}")]
    Include { path: String, message: String },
}

/// The project's Julia modules every pass loads: packages of
/// the environment to import and absolute module files to include.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JuliaModules {
    pub packages: Vec<String>,
    pub files: Vec<String>,
}

/// What the UI shows of one document: page setup and regions in file order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentView {
    pub document: DocumentId,
    pub page: PageSetup,
    /// Calculation and display settings of the document (`settings:` in the file).
    pub settings: std::collections::BTreeMap<String, String>,
    /// The manual page breaks of the document, sorted by
    /// page: the UI marks the page each one ends.
    pub page_breaks: Vec<crate::layout::PageBreak>,
    /// The regions of the document, each one shared: `view` hands back the very `Arc` it built
    /// last time for a region that did not change, so a host can tell an unchanged region by its
    /// pointer and skip building or serializing it. Serializes as a list of regions.
    pub regions: Vec<Arc<ViewRegion>>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
    /// Whether the worksheet is trusted: an untrusted worksheet
    /// draws its Julia blocks stopped and runs none of them.
    pub trusted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ViewRegion {
    pub id: String,
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub enabled: bool,
    #[serde(flatten)]
    pub content: ViewContent,
}

// A region's content is one value per region of a document, so the size of the largest variant
// costs nothing measurable; boxing the plot specification
// would touch every construction and match of this enum for no gain.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ViewContent {
    /// A math region: its linear text and the canonical AST.
    Math {
        text: String,
        /// Shared, so that a view region is cheap to clone into a delta; serializes as
        /// the `Statement`.
        statement: Arc<Statement>,
        /// Presentation-only line breaks.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        breaks: Vec<crate::layout::MathBreak>,
        /// The region's result-format override, if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        format: Option<std::collections::BTreeMap<String, String>>,
        /// The region's numeric choices (solver algorithm and options, derivative method), if any.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        numeric: Option<std::collections::BTreeMap<String, String>>,
    },
    Julia {
        block: JuliaBlock,
    },
    Include {
        path: String,
    },
    /// A text region: the stored linear text and its structured form (paragraphs of
    /// runs, inline math with its AST), see `richtext`.
    Text {
        text: String,
        width: Option<f64>,
        /// A full-width text block: the UI draws it from margin to margin.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        full_width: bool,
        /// The fill of the whole region as `#rrggbb`; absent is none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<String>,
        /// The spelling language of the region; absent follows the worksheet.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        paragraphs: RichText,
    },
    /// An image: the bytes are fetched separately by resource id.
    Image {
        resource: String,
        media: crate::image::ImageMedia,
        size: [f64; 2],
    },
    /// A collapsible area: the band; its members are ordinary regions of the view.
    Area {
        title: String,
        height: f64,
        collapsed: bool,
    },
    /// A plot specification. Calculated trace arrays are session data and arrive separately.
    Plot {
        plot: crate::plot::PlotSpec,
    },
}

/// A problem of the project structure (missing include, include cycle, ...).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDiagnostic {
    pub document: DocumentId,
    pub region_id: String,
    pub message: String,
}

// ---------------------------------------------------------------------------------------
// Shared results and interrupt
// ---------------------------------------------------------------------------------------

#[derive(Default)]
struct Store {
    entries: Vec<RegionEntry>,
    index: HashMap<RegionKey, usize>,
}

impl Store {
    fn get(&self, key: &RegionKey) -> Option<&RegionState> {
        self.index.get(key).map(|&i| &self.entries[i].state)
    }

    fn set(&mut self, key: &RegionKey, state: RegionState) -> Option<RegionEntry> {
        let &index = self.index.get(key)?;
        // the output belongs to the last evaluation; a stale or pending cell has none.
        if matches!(state, RegionState::Stale { .. } | RegionState::Pending) {
            self.entries[index].output = None;
        }
        self.entries[index].state = state;
        Some(self.entries[index].clone())
    }

    fn set_output(&mut self, key: &RegionKey, output: Option<CellOutput>) {
        if let Some(&index) = self.index.get(key) {
            self.entries[index].output = output;
        }
    }
}

/// The results of a session in evaluation order. Cloning shares the same store.
#[derive(Clone, Default)]
pub struct ResultsHandle(Arc<Mutex<Store>>);

impl ResultsHandle {
    fn lock(&self) -> MutexGuard<'_, Store> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Entries of the worksheet's visible regions; the hidden evaluations of plot trace
    /// expressions are reached through [`WorksheetSession::plot_data`] instead.
    pub fn snapshot(&self) -> Vec<RegionEntry> {
        self.lock()
            .entries
            .iter()
            .filter(|entry| {
                !plot::is_expression_region_id(&entry.key.region_id)
                    && !crate::table::is_column_region_id(&entry.key.region_id)
            })
            .cloned()
            .collect()
    }

    pub fn get(&self, key: &RegionKey) -> Option<RegionState> {
        self.lock().get(key).cloned()
    }

    /// A block of the matrix result of `key`, column-major, without copying the rest of it.
    /// `None` when the result is not a matrix held inline.
    pub fn block(
        &self,
        key: &RegionKey,
        row: usize,
        col: usize,
        rows: usize,
        cols: usize,
    ) -> Option<Vec<KernelValue>> {
        match self.lock().get(key)? {
            RegionState::Value {
                value: Some(value), ..
            }
            | RegionState::Stale {
                value: Some(value), ..
            } => value.block(row, col, rows, cols),
            _ => None,
        }
    }
}

/// Stops a running calculation pass from another thread.
#[derive(Clone)]
pub struct InterruptHandle {
    kernel: Arc<KernelManager>,
    cancel: Arc<AtomicBool>,
}

impl InterruptHandle {
    /// Asks the pass to stop: the running region is interrupted in the kernel and no
    /// further region is sent. Returns whether a kernel request was interrupted.
    pub fn interrupt(&self) -> bool {
        self.cancel.store(true, Ordering::SeqCst);
        self.kernel.interrupt_active().unwrap_or(false)
    }
}

// ---------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------

struct Derived {
    analysis: ProjectAnalysis,
    generated: GeneratedWorksheet,
    /// Graph region ids in evaluation order.
    order: Vec<String>,
    keys: HashMap<String, RegionKey>,
    by_key: HashMap<RegionKey, String>,
    generated_index: HashMap<String, usize>,
    /// The `symbolic` request of each region with a symbolic evaluation (`→`), by graph id.
    symbolic: HashMap<String, SymbolicRequest>,
    /// The enabled regions that take part in the analysis, by document: the regions whose
    /// reading order can change what is calculated. Built once with the analysis, so a move does
    /// not parse every text region of the worksheet to compare the order.
    analysis_regions: HashMap<DocumentId, HashSet<String>>,
}

impl Derived {
    /// The dependency graph of the analysis.
    fn graph(&self) -> &DependencyGraph {
        self.analysis.graph()
    }

    /// Whether a pass prepared from `self` would do exactly the work a pass prepared from
    /// `other` does: the same regions in the same evaluation order, with the same generated
    /// code, displayed values, units, symbolic requests and result keys. Positions and display
    /// settings are not part of it; an edit that leaves this true need not stop a running pass
    /// or start a new one.
    fn same_work(&self, other: &Derived) -> bool {
        if self.order != other.order
            || self.generated.packages != other.generated.packages
            || self.generated.regions.len() != other.generated.regions.len()
            || self.keys.len() != other.keys.len()
            || self.symbolic.len() != other.symbolic.len()
        {
            return false;
        }
        // The keys identify the result entries and the document instance; a change there changes
        // where a result is published, even when the code is identical.
        if self
            .keys
            .iter()
            .any(|(gid, key)| other.keys.get(gid) != Some(key))
        {
            return false;
        }
        for (left, right) in self.generated.regions.iter().zip(&other.generated.regions) {
            if left.id != right.id
                || left.code != right.code
                || left.value != right.value
                || left.symbolic_target != right.symbolic_target
                || display_unit_parts(left) != display_unit_parts(right)
            {
                return false;
            }
        }
        self.symbolic.iter().all(|(gid, request)| {
            other
                .symbolic
                .get(gid)
                .is_some_and(|other| request_json(request) == request_json(other))
        })
    }
}

/// Whether a region takes part in the analysis at all, and so whether its place in the reading
/// order can change what is calculated. Images and areas are never analysed; a text region is
/// analysed only through the inline math that actually evaluates, so moving plain text across
/// other regions cannot change the derived state.
fn participates_in_analysis(region: &DocumentRegion) -> bool {
    match region {
        DocumentRegion::Math(_) | DocumentRegion::Plot(_) | DocumentRegion::Include(_) => true,
        DocumentRegion::Text(text) => !RichText::parse(&text.text).evaluated_math().is_empty(),
        DocumentRegion::Image(_) | DocumentRegion::Area(_) => false,
    }
}

/// Whether an enabled region takes part in the analysis.
fn has_analysis_effect(region: &DocumentRegion) -> bool {
    region.enabled() && participates_in_analysis(region)
}

/// The enabled regions of `document` that take part in the analysis, by id. The set is unchanged
/// by the commands that may change the order (moves, page setup and page breaks): they change no
/// text, plot, table or include content.
fn analysis_region_ids(document: &ProjectDocument) -> HashSet<String> {
    document
        .regions
        .iter()
        .filter(|region| has_analysis_effect(region))
        .map(|region| region.id().to_owned())
        .collect()
}

/// The ids of the regions of `analysis_region_ids` in the reading order the analysis expands them
/// in (`compare_regions`): page, y, x, then id. Two documents with the same sequence put the same
/// regions in the same order, so a move that leaves it unchanged cannot change the analysis.
fn enabled_order(document: &ProjectDocument, analysis: &HashSet<String>) -> Vec<String> {
    let mut order: Vec<&DocumentRegion> = document
        .regions
        .iter()
        .map(|region| region.as_ref())
        .filter(|region| region.enabled() && analysis.contains(region.id()))
        .collect();
    order.sort_by(|left, right| {
        left.page()
            .cmp(&right.page())
            .then_with(|| left.y().total_cmp(&right.y()))
            .then_with(|| left.x().total_cmp(&right.x()))
            .then_with(|| left.id().cmp(right.id()))
    });
    order
        .into_iter()
        .map(|region| region.id().to_owned())
        .collect()
}

/// The code and the displayed text of a region's display unit, for the semantic comparison.
fn display_unit_parts(region: &GeneratedRegion) -> Option<(&str, &str)> {
    region
        .display_unit
        .as_ref()
        .map(|unit| (unit.code.as_str(), unit.text.as_str()))
}

/// The statement of a math region, for the checks that decide whether an edit leaves the
/// analysis alone.
fn math_statement<'a>(document: &'a ProjectDocument, region_id: &str) -> Option<&'a Statement> {
    document
        .regions
        .iter()
        .find_map(|region| match (region.id(), region.as_ref()) {
            (id, DocumentRegion::Math(math)) if id == region_id => Some(math.statement.as_ref()),
            _ => None,
        })
}

/// The inline math of a text region: the only part of a text region the analysis reads.
fn text_inline_math(
    document: &ProjectDocument,
    region_id: &str,
) -> Option<Vec<(usize, Statement)>> {
    document
        .regions
        .iter()
        .find_map(|region| match (region.id(), region.as_ref()) {
            (id, DocumentRegion::Text(text)) if id == region_id => {
                Some(RichText::parse(&text.text).evaluated_math())
            }
            _ => None,
        })
}

/// Whether `command` can leave the analysis and generated code unchanged if the region order and
/// the math content it touches are unchanged. `SetMath`, `SetText`, `Insert`, `Remove` and
/// `SetEnabled` are checked by [`command_content_unchanged`]; the other variants are positions,
/// display or layout only.
fn may_skip_derive(command: &EditCommand) -> bool {
    match command {
        EditCommand::Move { .. }
        | EditCommand::Insert { .. }
        | EditCommand::Remove { .. }
        | EditCommand::SetMath { .. }
        | EditCommand::SetText { .. }
        | EditCommand::SetWidth { .. }
        | EditCommand::SetEnabled { .. }
        | EditCommand::SetResultFormat { .. }
        | EditCommand::SetResultDefaults { .. }
        | EditCommand::SetCalculationSettings { .. }
        | EditCommand::SetLabelStyles { .. }
        | EditCommand::SetJuliaSize { .. }
        | EditCommand::SetArea { .. }
        | EditCommand::HoldMembers { .. }
        | EditCommand::AddResource { .. }
        | EditCommand::DropResource { .. }
        | EditCommand::AddAsset { .. }
        | EditCommand::DropAsset { .. }
        | EditCommand::SetEnvironment { .. }
        | EditCommand::SetImageSize { .. }
        | EditCommand::SetImageResource { .. }
        | EditCommand::AddPageBreak { .. }
        | EditCommand::RemovePageBreak { .. }
        | EditCommand::SetPageSetup { .. } => true,
        EditCommand::Batch { commands } => commands.iter().all(may_skip_derive),
        _ => false,
    }
}

/// Whether a command can change the reading order of the regions the analysis reads: a move, a
/// page setup (which can move regions out of a new margin), a page break (the caller sends the
/// moves with it), or a batch with one of those. The other commands of [`may_skip_derive`] leave
/// every position alone, so their order needs no comparison.
fn may_change_order(command: &EditCommand) -> bool {
    match command {
        EditCommand::Move { .. }
        | EditCommand::SetPageSetup { .. }
        | EditCommand::AddPageBreak { .. }
        | EditCommand::RemovePageBreak { .. } => true,
        EditCommand::Batch { commands } => commands.iter().any(may_change_order),
        _ => false,
    }
}

/// Whether the analysis inputs a [`may_skip_derive`] command touches are unchanged from `before`
/// to `after`: the statement of every `SetMath` region, the inline math of every `SetText` region
/// (the only part of a text region the analysis reads), and the presence of an inserted, removed
/// or enabled region the analysis reads. The other commands of [`may_skip_derive`] change no
/// analysis input.
fn command_content_unchanged(
    before: &ProjectDocument,
    after: &ProjectDocument,
    command: &EditCommand,
) -> bool {
    match command {
        EditCommand::SetMath { region_id, .. } => {
            match (
                math_statement(before, region_id),
                math_statement(after, region_id),
            ) {
                (Some(before), Some(after)) => before == after,
                _ => false,
            }
        }
        EditCommand::SetText { region_id, .. } => {
            match (
                text_inline_math(before, region_id),
                text_inline_math(after, region_id),
            ) {
                (Some(before), Some(after)) => before == after,
                _ => false,
            }
        }
        // An inserted or removed region that the analysis never reads (an image, an area, a
        // disabled region, plain text) changes no generated code.
        EditCommand::Insert { region, .. } => !has_analysis_effect(&region.region),
        EditCommand::Remove { region_id } => before
            .regions
            .iter()
            .find(|region| region.id() == region_id)
            .is_some_and(|region| !has_analysis_effect(region)),
        // Enabling or disabling a region the analysis never reads is presentation only.
        EditCommand::SetEnabled { region_id, .. } => {
            let relevant = |document: &ProjectDocument| {
                document
                    .regions
                    .iter()
                    .find(|region| region.id() == region_id)
                    .is_some_and(|region| has_analysis_effect(region))
            };
            !relevant(before) && !relevant(after)
        }
        EditCommand::Batch { commands } => commands
            .iter()
            .all(|command| command_content_unchanged(before, after, command)),
        _ => true,
    }
}

/// The view regions `view` built, per document and per document region.
///
/// An edit leaves almost every region alone, and an unchanged region shares the `Arc` of its
/// document region, so the view region built from it is still right: `view` hands back the same
/// `Arc<ViewRegion>` instead of parsing rich text and copying statements again. The cache also
/// holds what a view region reads outside its document region (the math text, the result format,
/// the image media), so a change there rebuilds it.
#[derive(Default)]
struct ViewCache {
    documents: HashMap<DocumentId, CachedDocument>,
}

#[derive(Default)]
struct CachedDocument {
    /// Counts the views built, to drop the entries of regions the document no longer holds.
    generation: u64,
    /// The cached view regions by the address of the document region they were built from. The
    /// address is an identity only because the entry keeps the `Arc` alive: no other region can
    /// take it.
    regions: HashMap<usize, CachedRegion>,
}

struct CachedRegion {
    source: Arc<DocumentRegion>,
    /// The math text the view region was built with; `None` when it was printed from the
    /// statement.
    text: Option<String>,
    /// The result-format override the view region shows.
    format: Option<BTreeMap<String, String>>,
    /// The numeric choices the view region shows.
    numeric: Option<BTreeMap<String, String>>,
    /// The media of the resource an image view region shows.
    media: Option<crate::image::ImageMedia>,
    /// The presentation-only line breaks of a math region.
    breaks: Vec<crate::layout::MathBreak>,
    /// The left margin a full-width block or an area was placed at.
    left_margin: f64,
    /// The last view this entry was used by; an entry older than that is gone.
    seen: u64,
    view: Arc<ViewRegion>,
}

impl CachedRegion {
    /// Whether rebuilding this region from `source` would produce the same view region.
    #[allow(clippy::too_many_arguments)]
    fn matches(
        &self,
        source: &Arc<DocumentRegion>,
        text: Option<&str>,
        format: Option<&BTreeMap<String, String>>,
        numeric: Option<&BTreeMap<String, String>>,
        media: Option<crate::image::ImageMedia>,
        breaks: &[crate::layout::MathBreak],
        left_margin: f64,
    ) -> bool {
        Arc::ptr_eq(&self.source, source)
            && self.text.as_deref() == text
            && self.format.as_ref() == format
            && self.numeric.as_ref() == numeric
            && self.media == media
            && self.breaks.as_slice() == breaks
            // A full-width block and an area start at the left margin, so a new margin moves
            // them (`ProjectDocument::snap_text_blocks` does it in the document).
            && (!starts_at_left_margin(source) || self.left_margin == left_margin)
    }
}

/// What the kernel module holds for a region that evaluated successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    code: String,
    value: Option<String>,
    display_unit: Option<String>,
    /// The JSON of the symbolic request (expression, keywords, definitions in scope).
    symbolic: Option<String>,
}

impl Fingerprint {
    /// Whether `region` would have this fingerprint, without building one: every edit asks it
    /// of every region.
    fn matches(&self, region: &GeneratedRegion, symbolic: Option<&SymbolicRequest>) -> bool {
        self.code == region.code
            && self.value == region.value
            && self.display_unit.as_deref() == region.display_unit.as_ref().map(|u| u.code.as_str())
            && match (&self.symbolic, symbolic) {
                (None, None) => true,
                (Some(sent), Some(request)) => request_json(request).to_string().as_str() == sent,
                _ => false,
            }
    }
}

fn fingerprint(region: &GeneratedRegion, symbolic: Option<&SymbolicRequest>) -> Fingerprint {
    Fingerprint {
        code: region.code.clone(),
        value: region.value.clone(),
        display_unit: region.display_unit.as_ref().map(|unit| unit.code.clone()),
        symbolic: symbolic.map(|request| request_json(request).to_string()),
    }
}

pub struct WorksheetSession {
    kernel: Arc<KernelManager>,
    worksheet_id: String,
    gen_options: GenOptions,
    project: Project,
    root: DocumentId,
    /// The math source text of each region, by document: nested so that looking up the text of a
    /// region borrows its id instead of building a key.
    texts: HashMap<DocumentId, HashMap<String, String>>,
    edits: u64,
    results: ResultsHandle,
    cancel: Arc<AtomicBool>,
    derived: Arc<Derived>,
    /// What the kernel holds and the package problems, shared with a running pass.
    pass_state: SharedPassState,
    /// Bumped by every change of the derived state; a pass prepared before it stops.
    revision: Arc<AtomicU64>,
    /// Whether the last applied change made a calculation due. It is reset by every command and
    /// set by `apply_document` when the derived state changed (or by a command that changes the
    /// evaluation context, such as the tolerances). An edit that leaves the derived state alone —
    /// plain text, whitespace, a display setting, a move that keeps the evaluation order — does
    /// not stop a running pass and does not start a new one.
    calc_needed: bool,
    /// Whether Julia regions and package calls may run.
    trusted: bool,
    /// The project's Julia modules every pass loads, set by the host.
    julia_modules: Arc<JuliaModules>,
    /// The name the REPL reaches this worksheet's module by, set by the host.
    module_name: Option<String>,
    /// Documents of referenced projects that are not trusted, with the alias that names them:
    /// their Julia regions do not run.
    untrusted_references: Arc<BTreeMap<DocumentId, String>>,
    /// The environment shared by standalone worksheets, set by the host.
    shared_environment: Option<PathBuf>,
    /// The environment materialized for a portable `.eqvz` document, set by the host.
    archive_environment: Option<PathBuf>,
    /// Undo and redo stacks of edit commands (each entry holds the command that reverts
    /// the change it records).
    undo: Vec<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    next_region: u64,
    /// The view regions already built, by document and document region.
    views: Mutex<ViewCache>,
}

/// Longest undo history kept.
const HISTORY_LIMIT: usize = 500;

#[derive(Debug, Clone)]
struct HistoryEntry {
    document: DocumentId,
    label: String,
    command: EditCommand,
}

#[derive(Debug, Clone)]
struct PackageProblem {
    message: String,
    missing: bool,
}

/// What a calculation pass reads and writes besides the results: the fingerprints of what the
/// kernel module holds, whether it must be reset, and the package problems found. It has its
/// own lock so a pass runs without the session; it is locked for single statements only,
/// never while the kernel is called, and before the results store when both are needed.
struct PassState {
    sent: HashMap<RegionKey, Fingerprint>,
    kernel_generation: Option<u64>,
    needs_reset: bool,
    /// Packages that failed to import in the kernel, with the reason.
    package_errors: HashMap<String, PackageProblem>,
    /// Packages reported as not installed during the last pass.
    missing_packages: BTreeSet<String>,
    /// Project module files that failed to load, with the reason.
    module_errors: BTreeMap<String, String>,
}

#[derive(Clone)]
struct SharedPassState(Arc<Mutex<PassState>>);

impl Default for SharedPassState {
    fn default() -> Self {
        SharedPassState(Arc::new(Mutex::new(PassState {
            sent: HashMap::new(),
            kernel_generation: None,
            needs_reset: true,
            package_errors: HashMap::new(),
            module_errors: BTreeMap::new(),
            missing_packages: BTreeSet::new(),
        })))
    }
}

impl SharedPassState {
    fn lock(&self) -> MutexGuard<'_, PassState> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl WorksheetSession {
    /// Creates a session for `root` in `project`. `worksheet_id` names the module in the
    /// kernel and must be unique among the sessions that share a kernel. Nothing is
    /// evaluated yet: every region is `Pending`.
    pub fn new(
        kernel: Arc<KernelManager>,
        worksheet_id: impl Into<String>,
        project: Project,
        root: DocumentId,
        texts: HashMap<(DocumentId, String), String>,
        gen_options: GenOptions,
    ) -> Result<WorksheetSession, SessionError> {
        let derived = Arc::new(derive(&project, &root, &gen_options)?);
        let mut by_document: HashMap<DocumentId, HashMap<String, String>> = HashMap::new();
        for ((document, region_id), text) in texts {
            by_document
                .entry(document)
                .or_default()
                .insert(region_id, text);
        }
        let mut session = WorksheetSession {
            kernel,
            worksheet_id: worksheet_id.into(),
            gen_options,
            project,
            root,
            texts: by_document,
            edits: 0,
            results: ResultsHandle::default(),
            cancel: Arc::new(AtomicBool::new(false)),
            derived,
            pass_state: SharedPassState::default(),
            revision: Arc::new(AtomicU64::new(0)),
            calc_needed: false,
            trusted: false,
            untrusted_references: Arc::default(),
            julia_modules: Arc::default(),
            module_name: None,
            shared_environment: None,
            archive_environment: None,
            undo: Vec::new(),
            redo: Vec::new(),
            next_region: 0,
            views: Mutex::new(ViewCache::default()),
        };
        session.reconcile_store();
        Ok(session)
    }

    pub fn root(&self) -> &DocumentId {
        &self.root
    }

    /// Whether Julia regions may run. Sessions start untrusted: a region that runs Julia
    /// (a `julia` region, an imported or Julia-defined name, a `Pkg::f` call) fails with
    /// [`FailureKind::NotTrusted`] and its dependents are blocked, until the host calls
    /// `set_trusted(true)` after the user decision. reference-only regions always run.
    pub fn is_trusted(&self) -> bool {
        self.trusted
    }

    /// Records the user trust decision. Failed regions are retried by the next pass.
    pub fn set_trusted(&mut self, trusted: bool) {
        self.calc_needed = false;
        if self.trusted != trusted {
            self.trusted = trusted;
            // What a pass may run changed: a pass prepared before is out of date, and the
            // next one is due whether or not the generated code changed.
            self.calc_needed = true;
            self.revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Sets the project's Julia modules that every pass loads. A change
    /// makes the next pass start from a fresh module and evaluate everything again.:
    /// the name the REPL reaches this worksheet's module by; sent with the next pass.
    pub fn set_module_name(&mut self, name: Option<String>) {
        self.module_name = name;
    }

    /// The module name the last [`set_module_name`](Self::set_module_name) gave.
    pub fn module_name(&self) -> Option<&str> {
        self.module_name.as_deref()
    }

    pub fn set_julia_modules(&mut self, modules: JuliaModules) {
        if *self.julia_modules != modules {
            self.julia_modules = Arc::new(modules);
            self.state_after_module_change();
        }
    }

    fn state_after_module_change(&mut self) {
        self.pass_state.lock().module_errors.clear();
        self.forget_sent_and_require_reset();
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.invalidate();
    }

    /// Sets the documents of referenced projects whose Julia code is not trusted.
    /// Like [`set_trusted`](Self::set_trusted) it only adds to [`calc_needed`](Self::calc_needed),
    /// so it can follow [`set_references`](Self::set_references) in one command.
    pub fn set_untrusted_references(&mut self, untrusted: BTreeMap<DocumentId, String>) {
        if *self.untrusted_references != untrusted {
            self.untrusted_references = Arc::new(untrusted);
            self.calc_needed = true;
            self.revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Changes with every change of what a calculation pass would do (an edit, the trust decision,
    /// an install): a pass prepared at an older revision is out of date.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    /// Moves the worksheet to the kernel of its new environment: nothing the previous
    /// kernel holds is valid, so the next pass evaluates the whole worksheet from a fresh module.
    pub fn set_kernel(&mut self, kernel: Arc<KernelManager>) {
        self.kernel = kernel;
        {
            let mut state = self.pass_state.lock();
            state.package_errors.clear();
            state.missing_packages.clear();
        }
        self.forget_sent_and_require_reset();
        self.pass_state.lock().kernel_generation = None;
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    /// The worksheet's environment changed under it: the
    /// recorded package problems go and the next pass evaluates from a fresh module.
    pub fn packages_changed(&mut self) {
        let mut state = self.pass_state.lock();
        state.package_errors.clear();
        state.missing_packages.clear();
        drop(state);
        self.forget_sent_and_require_reset();
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.invalidate();
    }

    /// Sets the directory of the environment shared by standalone worksheets.
    pub fn set_shared_environment(&mut self, directory: PathBuf) {
        self.shared_environment = Some(directory);
    }

    /// Sets the environment materialized for a portable document.
    pub fn set_archive_environment(&mut self, directory: PathBuf) {
        self.archive_environment = Some(directory);
    }

    /// The environment materialized for a portable document, if the worksheet is one.
    pub fn archive_environment(&self) -> Option<&Path> {
        self.archive_environment.as_deref()
    }

    /// The resolved Julia environment of the worksheet: the project's, the
    /// override the worksheet names, or the shared one.
    pub fn environment(&self) -> WorksheetEnvironment {
        let declared = self
            .project
            .document(&self.root)
            .and_then(|document| document.environment.as_deref());
        let shared = self.shared_environment.as_deref().unwrap_or(Path::new(""));
        resolve_environment_with_archive(
            &self.root,
            declared,
            shared,
            self.archive_environment.as_deref(),
        )
    }

    /// The directory of the worksheet's environment when its Julia code may use it: `None`
    /// for a project or override directory that does not exist and when the host set
    /// no shared directory.
    pub fn environment_directory(&self) -> Option<PathBuf> {
        let environment = self.environment();
        (environment.usable() && !environment.directory.as_os_str().is_empty())
            .then_some(environment.directory)
    }

    /// The environment directory a kernel request may be given: the worksheet's environment when
    /// it exists and holds a `Project.toml`; `None` otherwise, which runs in the kernel's own
    /// environment. The shared environment is created on demand, so before the first
    /// package is added its folder is missing and the kernel must not be sent it (GitHub ).
    pub fn active_environment_directory(&self) -> Option<String> {
        active_environment(self.environment_directory())
    }

    /// What a missing-package message adds: the environment's problems, or that
    /// the worksheet's folder holds a `Project.toml` it no longer uses implicitly.
    fn missing_package_hint(&self) -> Option<String> {
        let environment = self.environment();
        if !environment.problems.is_empty() {
            return Some(environment.problems.join("; "));
        }
        let folder = self.worksheet_directory()?;
        let unused = folder.join("Project.toml").is_file()
            && environment.directory.canonicalize().ok() != folder.canonicalize().ok();
        unused.then(|| {
            "the worksheet's folder has a Project.toml: choose it as this worksheet's environment to use its packages".to_owned()
        })
    }

    /// The directory of the worksheet file, which the kernel resolves a relative file name of
    /// a built-in against. `None` for a
    /// worksheet that has no saved file: an untitled one, where a relative path is an error.
    pub fn worksheet_directory(&self) -> Option<PathBuf> {
        let file = path_for_document(&self.root);
        file.is_absolute()
            .then(|| file.parent().map(Path::to_path_buf))
            .flatten()
    }

    /// The `base_dir` field of a kernel request: the worksheet directory as text, which the
    /// kernel keeps for the duration of one `evaluate`.
    pub fn kernel_base_dir(&self) -> Option<String> {
        self.worksheet_directory()
            .and_then(|directory| directory.to_str().map(str::to_owned))
    }

    /// Packages that were reported as not installed during the last pass. The host shows
    /// them in the install prompt and passes them to
    /// [`install_packages`](Self::install_packages).
    pub fn missing_packages(&self) -> Vec<String> {
        self.pass_state
            .lock()
            .missing_packages
            .iter()
            .cloned()
            .collect()
    }

    /// Installs packages into the Julia environment of the worksheet (`Project.toml` and
    /// `Manifest.toml` next to the worksheet) through the kernel and instantiates it.
    /// With an empty `packages` list the packages that were reported missing are
    /// installed, and an existing environment is only instantiated. This downloads code:
    /// it needs a trusted worksheet and, in the UI, the explicit consent of the user. Run
    /// the next pass afterwards; regions that failed on a missing package are retried.
    pub fn install_packages(&mut self, packages: &[String]) -> Result<InstallResult, SessionError> {
        self.calc_needed = false;
        if !self.trusted {
            return Err(SessionError::NotTrusted);
        }
        let directory = self
            .environment_directory()
            .ok_or(SessionError::NoEnvironment)?;
        // The shared environment is created when first needed.
        std::fs::create_dir_all(&directory).map_err(|_| SessionError::NoEnvironment)?;
        let wanted: Vec<String> = if packages.is_empty() {
            self.missing_packages()
        } else {
            packages.to_vec()
        };
        if wanted.is_empty() && active_environment(self.environment_directory()).is_none() {
            return Err(SessionError::NothingToInstall);
        }
        let result = self
            .kernel
            .install_packages(&directory.to_string_lossy(), &wanted)?;
        let mut state = self.pass_state.lock();
        state.package_errors.clear();
        state.missing_packages.clear();
        drop(state);
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    pub fn project(&self) -> &Project {
        &self.project
    }

    pub fn worksheet_id(&self) -> &str {
        &self.worksheet_id
    }

    /// The math source text of a region, if known.
    pub fn math_text(&self, document: &DocumentId, region_id: &str) -> Option<&str> {
        self.texts.get(document)?.get(region_id).map(String::as_str)
    }

    pub fn results(&self) -> ResultsHandle {
        self.results.clone()
    }

    /// The results to keep in the worksheet's results file: every value and every failure of a
    /// region's own calculation (or of one it depends on), with the fingerprint of the calculation
    /// that produced it. Out-of-date and pending regions are left out, and so are values that only
    /// live in this kernel (Julia handles).
    pub fn stored_results(&self) -> Vec<StoredEntry> {
        let context = self.stored_context();
        let store = self.results.lock();
        self.derived
            .order
            .iter()
            .filter_map(|gid| {
                let key = &self.derived.keys[gid];
                let entry = &store.entries[*store.index.get(key)?];
                let state = match &entry.state {
                    RegionState::Value {
                        value,
                        display_unit,
                    } if !value.as_ref().is_some_and(holds_handle) => StoredState::Value {
                        value: value.clone(),
                        display_unit: display_unit.clone(),
                    },
                    RegionState::Error { failure }
                        if matches!(
                            failure.kind,
                            FailureKind::Evaluation | FailureKind::Blocked
                        ) =>
                    {
                        StoredState::Error {
                            failure: failure.clone(),
                        }
                    }
                    _ => return None,
                };
                Some(StoredEntry {
                    key: key.clone(),
                    fingerprint: self.stored_fingerprint(gid, &context),
                    state,
                    output: entry.output.clone(),
                })
            })
            .collect()
    }

    /// Shows the stored results that still hold, in evaluation order, and returns how many. A
    /// result holds while its region would calculate exactly as when it was stored; the first one
    /// that does not (or is missing or invalid) ends the restore, since every region after it may
    /// read what changed. Restored results are not in the kernel: a pass calculates them again.
    pub fn restore_results(&self, entries: Vec<StoredEntry>) -> usize {
        let mut stored: HashMap<RegionKey, StoredEntry> = entries
            .into_iter()
            .map(|entry| (entry.key.clone(), entry))
            .collect();
        let context = self.stored_context();
        let mut store = self.results.lock();
        let mut restored = 0;
        for gid in &self.derived.order {
            let key = &self.derived.keys[gid];
            let Some(entry) = stored.remove(key) else {
                break;
            };
            if entry.fingerprint != self.stored_fingerprint(gid, &context) {
                break;
            }
            let state = match entry.state {
                StoredState::Value {
                    value,
                    display_unit,
                } => {
                    if value
                        .as_ref()
                        .is_some_and(|value| value.validate().is_err())
                    {
                        break;
                    }
                    RegionState::Value {
                        value,
                        display_unit,
                    }
                }
                StoredState::Error { failure } => RegionState::Error { failure },
            };
            if store.set(key, state).is_none() {
                break;
            }
            store.set_output(key, entry.output);
            restored += 1;
        }
        restored
    }

    /// What every stored result depends on besides its own region: the worksheet's calculation
    /// settings (its display settings change no value).
    fn stored_context(&self) -> String {
        let mut context = String::new();
        if let Some(document) = self.project.document(&self.root) {
            let settings: BTreeMap<_, _> = document
                .settings
                .values
                .iter()
                .filter(|(name, _)| !name.starts_with("format."))
                .collect();
            for (name, value) in settings {
                context.push_str(&format!("{name}={value}\u{1f}"));
            }
        }
        context
    }

    /// The fingerprint of the calculation of region `gid`, as a results file keeps it.
    fn stored_fingerprint(&self, gid: &str, context: &str) -> String {
        let mut text = String::from(context);
        if let Some(&index) = self.derived.generated_index.get(gid) {
            let region = &self.derived.generated.regions[index];
            for part in [
                region.code.as_str(),
                region.value.as_deref().unwrap_or("\u{0}"),
                region
                    .display_unit
                    .as_ref()
                    .map_or("\u{0}", |unit| unit.code.as_str()),
            ] {
                text.push_str(part);
                text.push('\u{1e}');
            }
            if let Some(request) = self.derived.symbolic.get(gid) {
                text.push_str(&request_json(request).to_string());
            }
        }
        // The Fowler-Noll-Vo hash: the same text gives the same fingerprint in every run and version.
        let hash = text.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        format!("{hash:016x}")
    }

    pub fn interrupt_handle(&self) -> InterruptHandle {
        InterruptHandle {
            kernel: Arc::clone(&self.kernel),
            cancel: Arc::clone(&self.cancel),
        }
    }

    pub fn kernel(&self) -> &Arc<KernelManager> {
        &self.kernel
    }

    /// Structural problems of the project (missing includes, include cycles, duplicate
    /// global definitions).
    pub fn diagnostics(&self) -> Vec<SessionDiagnostic> {
        self.derived
            .analysis
            .diagnostics()
            .iter()
            .map(|diagnostic| SessionDiagnostic {
                document: diagnostic.origin.document.clone(),
                region_id: diagnostic.origin.region_id.clone(),
                message: match &diagnostic.kind {
                    DiagnosticKind::MissingInclude { target } => {
                        format!("included worksheet `{target}` was not found")
                    }
                    DiagnosticKind::IncludeCycle { chain } => format!(
                        "include cycle: {}",
                        chain
                            .iter()
                            .map(|document| document.as_str())
                            .collect::<Vec<_>>()
                            .join(" -> ")
                    ),
                    DiagnosticKind::SettingsConflict { .. } => {
                        "the included worksheet declares different calculation settings; the parent settings apply".into()
                    }
                    DiagnosticKind::TableColumn { column, reason } => {
                        format!("table column {}: {reason}", column + 1)
                    }
                    DiagnosticKind::ReferenceDefinition { name, alias } => format!(
                        "`{}` belongs to the reference `{alias}` and cannot be defined here",
                        print_name(name)
                    ),
                    DiagnosticKind::DuplicateGlobalDefinition { name, first } => format!(
                        "global definition of `{}` duplicates the one in `{}` region `{}`",
                        print_name(name),
                        first.document,
                        first.region_id
                    ),
                },
            })
            // a project module that failed to load is a problem of the worksheet.
            .chain(self.pass_state.lock().module_errors.iter().map(|(path, message)| {
                SessionDiagnostic {
                    document: self.root.clone(),
                    region_id: String::new(),
                    message: format!("Julia module `{path}` did not load: {message}"),
                }
            }).collect::<Vec<_>>())
            // a reference's problems belong to the worksheet, not to a region.
            .chain(self.project.references().problems.iter().map(|(alias, message)| {
                SessionDiagnostic {
                    document: self.root.clone(),
                    region_id: String::new(),
                    message: format!("reference `{alias}`: {message}"),
                }
            }))
            .collect()
    }

    /// Whether any expression (including the hidden plot expressions that are not part of
    /// [`ResultsHandle::snapshot`]) has no calculated value: pending, stale or failed. This is the
    /// state of the worksheet, not whether the last change made a calculation due
    /// ([`calc_needed`](Self::calc_needed)).
    pub fn needs_calculation(&self) -> bool {
        self.results
            .lock()
            .entries
            .iter()
            .any(|entry| !matches!(entry.state, RegionState::Value { .. }))
    }

    /// Whether the **last applied change** made a calculation due: the derived state changed,
    /// the evaluation context changed (tolerances, trust, package install), or a new document
    /// was loaded. An edit that only changed presentation (text, spacing, display settings) or
    /// moved a region without changing the evaluation order leaves it false, so an automatic
    /// calculation does not start for it and a running pass is not stopped.
    pub fn calc_needed(&self) -> bool {
        self.calc_needed
    }

    /// The calculated data of a plot region of a document (instance 0 of the root or of the
    /// document), built from the state of its hidden trace expressions: `None` when there
    /// is no such enabled plot.
    pub fn plot_data(&self, document: &DocumentId, plot_id: &str) -> Option<PlotData> {
        let region =
            self.project
                .document(document)?
                .regions
                .iter()
                .find_map(|region| match region.as_ref() {
                    DocumentRegion::Plot(plot) if plot.id == plot_id => Some(plot),
                    _ => None,
                })?;
        // The analysis built this plot's hidden regions with the same scope, so the results
        // read here are exactly the ones `assemble` consumes.
        let scope = PlotScope {
            defined: self.project.defined_plain_names(),
        };
        let store = self.results.lock();
        let read = |region_id: String| -> ExpressionResult {
            let key = RegionKey {
                document: document.clone(),
                region_id,
                instance: 0,
            };
            match store.get(&key) {
                None | Some(RegionState::Pending) => ExpressionResult::Pending,
                Some(RegionState::Stale { value: None, .. }) => ExpressionResult::Pending,
                Some(RegionState::Stale {
                    value: Some(value), ..
                }) => ExpressionResult::Stale(value.clone()),
                Some(RegionState::Value {
                    value: Some(value), ..
                }) => ExpressionResult::Value(value.clone()),
                Some(RegionState::Value { value: None, .. }) => {
                    ExpressionResult::Failed("the expression has no value".into())
                }
                Some(RegionState::Error { failure }) => {
                    ExpressionResult::Failed(failure.message.clone())
                }
            }
        };
        let mut results = Vec::new();
        // The limit expressions first, in `limit_expressions` order: `assemble` reads them before
        // the traces, exactly as the analysis evaluated them.
        for (axis, bound) in region.plot.limit_expressions() {
            results.push(read(plot::limit_region_id(plot_id, axis, bound)));
        }
        // Then the axis display units, in `unit_expressions` order.
        for axis in region.plot.unit_expressions() {
            results.push(read(plot::unit_region_id(plot_id, axis)));
        }
        for trace in &region.plot.traces {
            for axis in plot::plot_trace_axes(region.plot.kind, trace, &scope) {
                results.push(read(plot::expression_region_id(plot_id, &trace.id, axis)));
            }
        }
        // the on-screen view range is the sample interval of every implicit x trace,
        // so the data read here is the data the user is looking at.
        Some(
            region
                .plot
                .assemble_in_view(plot_id, &results, &scope, region.view),
        )
    }

    // ---- edits ----------------------------------------------------------------------

    /// Replaces the math of a region with `text` (parsed with the worksheet math syntax).
    /// On a syntax error nothing changes. Returns the regions that became stale (the
    /// edited region and everything that depends on it), in evaluation order.
    pub fn edit_math(
        &mut self,
        document: &DocumentId,
        region_id: &str,
        text: &str,
    ) -> Result<Vec<RegionKey>, SessionError> {
        self.edit_math_with_breaks(document, region_id, text, Vec::new())
    }

    /// [`edit_math`](Self::edit_math) with presentation-only line breaks:
    /// they change no generated code, so a break-only edit invalidates nothing.
    pub fn edit_math_with_breaks(
        &mut self,
        document: &DocumentId,
        region_id: &str,
        text: &str,
        breaks: Vec<crate::layout::MathBreak>,
    ) -> Result<Vec<RegionKey>, SessionError> {
        self.apply_edit(
            document,
            "Edit math",
            EditCommand::SetMath {
                region_id: region_id.to_owned(),
                text: text.to_owned(),
                breaks,
            },
        )
    }

    /// Applies an edit command (add, remove, move or change regions) and records it for
    /// undo. Returns the regions that became stale. On an error nothing changes.
    pub fn apply_edit(
        &mut self,
        document: &DocumentId,
        label: &str,
        command: EditCommand,
    ) -> Result<Vec<RegionKey>, SessionError> {
        let (inverse, stale) = self.run_command(document, command)?;
        // An empty batch as the inverse means the command changed nothing (bytes that are
        // already stored, tolerances that already have those values): there is nothing to
        // undo, so it is not an undo step and it keeps the redo stack.
        if !matches!(&inverse, EditCommand::Batch { commands } if commands.is_empty()) {
            self.undo.push(HistoryEntry {
                document: document.clone(),
                label: label.to_owned(),
                command: inverse,
            });
            if self.undo.len() > HISTORY_LIMIT {
                self.undo.remove(0);
            }
            self.redo.clear();
        }
        Ok(stale)
    }

    fn run_command(
        &mut self,
        document: &DocumentId,
        command: EditCommand,
    ) -> Result<(EditCommand, Vec<RegionKey>), SessionError> {
        self.calc_needed = false;
        let not_math = |region_id: &str| SessionError::NotAMathRegion {
            document: document.clone(),
            region_id: region_id.to_owned(),
        };
        // A command that changes the evaluation context of the whole worksheet
        //  leaves every result out of date: the generated code does not
        // hold the value (it reads `tol()` and `ctol()`), so the fingerprints alone would keep
        // the results computed before the change. The settings are compared afterwards, so an
        // Apply that writes the values the worksheet already has recalculates nothing.
        let settings_before = matches!(command, EditCommand::SetCalculationSettings { .. })
            .then(|| {
                self.project
                    .document(document)
                    .map(|document| document.settings.values.clone())
            })
            .flatten();
        let before = self
            .project
            .document(document)
            .ok_or_else(|| not_math(""))?
            .clone();
        let mut updated = before.clone();
        let mut doc_texts: HashMap<String, String> =
            self.texts.get(document).cloned().unwrap_or_default();
        // The command after the edit, for the checks that decide whether a pass would do
        // different work; only the commands that may leave the derived state alone need it.
        let may_skip = may_skip_derive(&command);
        let changes_order = may_change_order(&command);
        let checked = may_skip.then(|| command.clone());
        let inverse =
            edit::apply(&mut updated, &mut doc_texts, command).map_err(|error| match error {
                EditError::Parse(parse) => SessionError::Parse(parse),
                EditError::NoSuchRegion(id) | EditError::NotMath(id) => not_math(&id),
                other => SessionError::Edit(other),
            })?;
        // An empty batch as the inverse means the command changed nothing (bytes that are
        // already stored, tolerances that already have those values): the document, its
        // revision and every result stay as they are, and no region becomes stale.
        if matches!(&inverse, EditCommand::Batch { commands } if commands.is_empty()) {
            return Ok((inverse, Vec::new()));
        }
        // A new environment leaves every result out of date like a tolerance does.
        let recalculation = settings_before.is_some_and(|before| before != updated.settings.values)
            || before.environment != updated.environment;
        self.edits += 1;
        updated.content_hash = format!("edit-{}-{}", self.edits, updated.content_hash);
        // A display-only edit, a text edit that keeps its inline math, a whitespace edit and a
        // move that keeps the evaluation order leave the analysis and the generated code alone:
        // the document is replaced, the view is rebuilt from it, and no pass is stopped or
        // started. The `derive` of the whole project is skipped too.
        let skip_derive = may_skip
            && (!changes_order || {
                let analysis = self
                    .derived
                    .analysis_regions
                    .get(document)
                    .cloned()
                    .unwrap_or_else(|| analysis_region_ids(&before));
                enabled_order(&before, &analysis) == enabled_order(&updated, &analysis)
            })
            && checked
                .as_ref()
                .is_some_and(|command| command_content_unchanged(&before, &updated, command));
        if skip_derive {
            self.project.replace(updated)?;
            self.texts.insert(document.clone(), doc_texts);
            if recalculation {
                self.forget_sent_and_require_reset();
                self.calc_needed = true;
                self.revision.fetch_add(1, Ordering::SeqCst);
                // With what the kernel was sent forgotten, every region is out of date.
                return Ok((inverse, self.invalidate()));
            }
            return Ok((inverse, Vec::new()));
        }
        self.load_missing_includes(&updated)?;
        self.apply_document(updated)?;
        self.texts.insert(document.clone(), doc_texts);
        if recalculation {
            // Forgetting what the kernel was sent makes `affected` report every region, so
            // everything shows as out of date at once and the automatic calculation of the
            // frontend has something to do.
            self.forget_sent_and_require_reset();
            // The code did not change (a tolerance is read at calculation time), so the semantic
            // comparison in `apply_document` cannot see this change: a running pass must still
            // stop and the next one must run from a fresh module.
            self.calc_needed = true;
            self.revision.fetch_add(1, Ordering::SeqCst);
        }
        if self.calc_needed {
            Ok((inverse, self.invalidate()))
        } else {
            // The derive ran (the command is not one of the fast paths) but it produced the same
            // work: no result is out of date, and the results of an unrelated failed region are
            // left as they are.
            Ok((inverse, Vec::new()))
        }
    }

    /// Reads into the project the worksheets that the include regions of `document` (and, in turn, of
    /// those worksheets) point at and the project does not hold yet. Opening a worksheet loads its
    /// includes (`load_project`); an include inserted or re-pointed while the worksheet is open
    ///  needs the same, or it would stay a missing include until the file is reopened.
    /// A file that does not exist is left alone (it is the missing-include diagnostic); one that exists and is
    /// not a worksheet is an error of the edit.
    fn load_missing_includes(&mut self, document: &ProjectDocument) -> Result<(), SessionError> {
        let targets = |document: &ProjectDocument| -> Vec<DocumentId> {
            document
                .regions
                .iter()
                .filter_map(|region| match region.as_ref() {
                    DocumentRegion::Include(include) => document.id.resolve(&include.path).ok(),
                    _ => None,
                })
                .collect()
        };
        let mut queue = targets(document);
        let mut seen = HashSet::new();
        while let Some(id) = queue.pop() {
            if id == document.id || !seen.insert(id.clone()) || self.project.document(&id).is_some()
            {
                continue;
            }
            if !path_for_document(&id).is_file() {
                continue;
            }
            let loaded = load_document_file(&id).map_err(|error| SessionError::Include {
                path: id.to_string(),
                message: error.to_string(),
            })?;
            queue.extend(targets(&loaded.document));
            self.texts.insert(id.clone(), loaded.texts);
            self.project.insert(loaded.document)?;
        }
        Ok(())
    }

    /// Forgets what the kernel was sent and makes the next pass reset the module: the evaluation
    /// context changed, so no stored result can be trusted even when the code is the same.
    fn forget_sent_and_require_reset(&self) {
        let mut state = self.pass_state.lock();
        state.sent.clear();
        // `needs_reset` makes the next pass evaluate the whole worksheet from a fresh kernel
        // module whatever the fingerprints say: a pass that a running calculation published in
        // between cannot leave a result computed with the previous tolerance behind.
        state.needs_reset = true;
    }

    /// Stores (`Some`) or clears (`None`) the transient on-screen x range of a plot region, the
    /// sample interval of every implicit x trace while the user has navigated the plot.
    ///
    /// Screen-only state, like the view itself: not an undo step and not part of the stored
    /// worksheet. Returns whether the range moved: `false` for the range the plot already has, for
    /// which nothing is recalculated at all. Only the plot's own expressions become out of date
    /// (no visible region does), so no other region of the worksheet is evaluated again.
    pub fn set_plot_view(
        &mut self,
        document: &DocumentId,
        plot_id: &str,
        view: Option<ViewRange>,
    ) -> Result<bool, SessionError> {
        self.calc_needed = false;
        let mut updated = self
            .project
            .document(document)
            .ok_or_else(|| SessionError::NotAMathRegion {
                document: document.clone(),
                region_id: plot_id.to_owned(),
            })?
            .clone();
        let Some(index) = updated.regions.iter().position(
            |region| matches!(region.as_ref(), DocumentRegion::Plot(plot) if plot.id == plot_id),
        ) else {
            return Err(SessionError::NotAMathRegion {
                document: document.clone(),
                region_id: plot_id.to_owned(),
            });
        };
        let DocumentRegion::Plot(region) = Arc::make_mut(&mut updated.regions[index]) else {
            unreachable!("the region was found as a plot");
        };
        if region.view == view {
            // The same range as the one already drawn: nothing to resample.
            return Ok(false);
        }
        region.view = view;
        // The hidden sampling definitions of this plot changed, so the analysis, their generated
        // code and the regions that read them are rebuilt. Nothing is pushed on the undo stack and
        // the document keeps the bytes it had: `view` is skipped when the worksheet is written.
        self.edits += 1;
        updated.content_hash = format!("edit-{}-{}", self.edits, updated.content_hash);
        self.apply_document(updated)?;
        // The hidden sampling definitions of this plot changed, so the analysis, their generated
        // code and the regions that read them are rebuilt. Only when that really changed what a
        // pass would do is anything invalidated; a range that leaves the code alone does not
        // stop a running pass.
        if self.calc_needed {
            self.invalidate();
        }
        Ok(true)
    }

    /// Reverts the last edit. Returns its label and the regions that became stale, or
    /// `None` when there is nothing to undo.
    pub fn undo(&mut self) -> Result<Option<(String, Vec<RegionKey>)>, SessionError> {
        let Some(entry) = self.undo.pop() else {
            return Ok(None);
        };
        match self.run_command(&entry.document, entry.command.clone()) {
            Ok((inverse, stale)) => {
                let label = entry.label.clone();
                self.redo.push(HistoryEntry {
                    command: inverse,
                    ..entry
                });
                Ok(Some((label, stale)))
            }
            Err(error) => {
                self.undo.push(entry);
                Err(error)
            }
        }
    }

    /// Repeats the last undone edit.
    pub fn redo(&mut self) -> Result<Option<(String, Vec<RegionKey>)>, SessionError> {
        let Some(entry) = self.redo.pop() else {
            return Ok(None);
        };
        match self.run_command(&entry.document, entry.command.clone()) {
            Ok((inverse, stale)) => {
                let label = entry.label.clone();
                self.undo.push(HistoryEntry {
                    command: inverse,
                    ..entry
                });
                Ok(Some((label, stale)))
            }
            Err(error) => {
                self.redo.push(entry);
                Err(error)
            }
        }
    }

    /// Label of the edit `undo` would revert.
    pub fn undo_label(&self) -> Option<&str> {
        self.undo.last().map(|entry| entry.label.as_str())
    }

    /// Label of the edit `redo` would repeat.
    pub fn redo_label(&self) -> Option<&str> {
        self.redo.last().map(|entry| entry.label.as_str())
    }

    /// A region id that is unused in `document` and was never handed out before by this
    /// session (so redoing a removal can never collide with a later insertion).
    pub fn new_region_id(&mut self, document: &DocumentId) -> String {
        let existing = self
            .project
            .document(document)
            .and_then(|doc| {
                doc.regions
                    .iter()
                    .filter_map(|region| {
                        region
                            .id()
                            .trim_start_matches(|c: char| !c.is_ascii_digit())
                            .parse::<u64>()
                            .ok()
                    })
                    .max()
            })
            .map_or(0, |max| max + 1);
        let number = self.next_region.max(existing).max(1);
        self.next_region = number + 1;
        format!("r{number}")
    }

    /// The page setup and regions of a document as the UI shows them.
    ///
    /// A region that has not changed since the last call is the same `Arc<ViewRegion>` as then,
    /// built once: an edit parses and copies only the regions it touched.
    pub fn view(&self, document: &DocumentId) -> Option<DocumentView> {
        let doc = self.project.document(document)?;
        let left_margin = doc.page.margins.left;
        let mut cache = self
            .views
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.documents.entry(document.clone()).or_default();
        cached.generation += 1;
        let generation = cached.generation;
        let texts = self.texts.get(document);
        let mut regions: Vec<Arc<ViewRegion>> = Vec::with_capacity(doc.regions.len());
        for region in &doc.regions {
            let address = Arc::as_ptr(region) as usize;
            let text = match region.as_ref() {
                DocumentRegion::Math(math) => texts
                    .and_then(|texts| texts.get(&math.id))
                    .map(String::as_str),
                _ => None,
            };
            // Almost every worksheet overrides no format: then no region needs the `BTreeMap`
            // lookup.
            let format = match region.as_ref() {
                DocumentRegion::Math(math) if !doc.result_formats.is_empty() => {
                    doc.result_formats.get(&math.id)
                }
                _ => None,
            };
            let numeric = match region.as_ref() {
                DocumentRegion::Math(math) if !doc.numeric_options.is_empty() => {
                    doc.numeric_options.get(&math.id)
                }
                _ => None,
            };
            let media = match region.as_ref() {
                DocumentRegion::Image(image) => Some(
                    doc.image_media(&image.resource)
                        .unwrap_or(crate::image::ImageMedia::Png),
                ),
                _ => None,
            };
            let breaks: &[crate::layout::MathBreak] = match region.as_ref() {
                DocumentRegion::Math(math) => doc
                    .math_breaks
                    .get(&math.id)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                _ => &[],
            };
            if let Some(entry) = cached.regions.get_mut(&address) {
                if entry.matches(region, text, format, numeric, media, breaks, left_margin) {
                    entry.seen = generation;
                    regions.push(Arc::clone(&entry.view));
                    continue;
                }
            }
            let view = Arc::new(build_view_region(
                region, text, format, numeric, media, breaks, doc,
            ));
            cached.regions.insert(
                address,
                CachedRegion {
                    source: Arc::clone(region),
                    text: text.map(str::to_owned),
                    format: format.cloned(),
                    numeric: numeric.cloned(),
                    media,
                    breaks: breaks.to_vec(),
                    left_margin,
                    seen: generation,
                    view: Arc::clone(&view),
                },
            );
            regions.push(view);
        }
        // What the document no longer holds (a removed region) is dropped with its view.
        cached.regions.retain(|_, entry| entry.seen == generation);
        drop(cache);
        Some(DocumentView {
            document: document.clone(),
            page: doc.page.clone(),
            settings: doc.settings.values.clone(),
            page_breaks: doc.page_breaks.clone(),
            regions,
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            undo_label: self.undo_label().map(str::to_owned),
            redo_label: self.redo_label().map(str::to_owned),
            trusted: self.trusted,
        })
    }

    /// Replaces a whole document (for example after its file changed on disk), with the
    /// math texts of its regions. Returns the regions that became stale.
    pub fn replace_document(
        &mut self,
        loaded: crate::worksheet_file::LoadedDocument,
    ) -> Result<Vec<RegionKey>, SessionError> {
        self.calc_needed = false;
        let id = loaded.document.id.clone();
        self.undo.clear();
        self.redo.clear();
        self.texts.insert(id, loaded.texts);
        self.apply_document(loaded.document)?;
        // A document read from disk is a new context even when its code is identical: a running
        // pass must stop at its next region and Automatic mode evaluates the reloaded worksheet.
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
        Ok(self.invalidate())
    }

    /// Run: the next pass evaluates the region `region_id` of
    /// `document` and everything that depends on it, even when nothing changed. Returns the
    /// regions that became stale.
    pub fn rerun_region(
        &mut self,
        document: &DocumentId,
        region_id: &str,
    ) -> Result<Vec<RegionKey>, SessionError> {
        self.calc_needed = false;
        let keys: Vec<RegionKey> = self
            .derived
            .by_key
            .keys()
            .filter(|key| &key.document == document && key.region_id == region_id)
            .cloned()
            .collect();
        if keys.is_empty() {
            // A disabled block or a region that evaluates nothing has nothing to run.
            return Err(SessionError::NotAMathRegion {
                document: document.clone(),
                region_id: region_id.to_owned(),
            });
        }
        {
            let mut state = self.pass_state.lock();
            for key in &keys {
                state.sent.remove(key);
            }
        }
        self.calc_needed = true;
        self.revision.fetch_add(1, Ordering::SeqCst);
        Ok(self.invalidate())
    }

    /// Replaces the referenced projects: their documents, texts
    /// and splices. Returns the regions that became stale.
    pub fn set_references(
        &mut self,
        loaded: crate::project_reference::LoadedReferences,
    ) -> Result<Vec<RegionKey>, SessionError> {
        self.calc_needed = false;
        let previous = self.project.clone();
        self.texts
            .retain(|document, _| !crate::project_reference::is_reference_document(document));
        for ((document, region_id), text) in &loaded.texts {
            self.texts
                .entry(document.clone())
                .or_default()
                .insert(region_id.clone(), text.clone());
        }
        self.project.set_references(loaded)?;
        match derive(&self.project, &self.root, &self.gen_options) {
            Ok(derived) => {
                let same_work = self.derived.same_work(&derived);
                self.derived = Arc::new(derived);
                if !same_work {
                    self.revision.fetch_add(1, Ordering::SeqCst);
                    self.calc_needed = true;
                }
                self.reconcile_store();
                Ok(self.invalidate())
            }
            Err(error) => {
                self.project = previous;
                Err(error)
            }
        }
    }

    fn apply_document(
        &mut self,
        document: crate::project::ProjectDocument,
    ) -> Result<(), SessionError> {
        let previous = self.project.replace(document)?;
        match derive(&self.project, &self.root, &self.gen_options) {
            Ok(derived) => {
                let same_work = self.derived.same_work(&derived);
                self.derived = Arc::new(derived);
                if !same_work {
                    // What a pass would do changed: it becomes out of date and the next one has
                    // work. An edit that only changed presentation leaves the revision alone, so
                    // a running pass goes on.
                    self.revision.fetch_add(1, Ordering::SeqCst);
                    self.calc_needed = true;
                }
                self.reconcile_store();
                Ok(())
            }
            Err(error) => {
                if let Some(previous) = previous {
                    // Keep the project consistent with the last good analysis.
                    let _ = self.project.replace(previous);
                }
                Err(error)
            }
        }
    }

    /// Keeps the store entries in step with the nodes of the analysis: new regions are
    /// `Pending`, vanished ones are dropped, order follows evaluation order.
    fn reconcile_store(&mut self) {
        let derived = Arc::clone(&self.derived);
        let mut store = self.results.lock();
        let mut entries = Vec::with_capacity(derived.order.len());
        for gid in &derived.order {
            let key = derived.keys[gid].clone();
            let state = store.get(&key).cloned().unwrap_or(RegionState::Pending);
            let output = store
                .index
                .get(&key)
                .and_then(|&index| store.entries[index].output.clone());
            entries.push(RegionEntry { key, state, output });
        }
        store.index = entries
            .iter()
            .enumerate()
            .map(|(i, entry)| (entry.key.clone(), i))
            .collect();
        store.entries = entries;
        drop(store);
        self.pass_state
            .lock()
            .sent
            .retain(|key, _| derived.by_key.contains_key(key));
    }

    /// The region ids (graph ids, evaluation order) that need evaluation (see [`affected`]).
    fn affected(&self) -> Vec<String> {
        let state = self.pass_state.lock();
        affected(&self.derived, &self.results, &state.sent)
    }

    /// Marks the affected regions stale (or pending when they never had a value) and
    /// returns their keys.
    fn invalidate(&mut self) -> Vec<RegionKey> {
        let affected = self.affected();
        let derived = Arc::clone(&self.derived);
        let mut store = self.results.lock();
        let mut keys = Vec::new();
        for gid in affected {
            let key = derived.keys[&gid].clone();
            let state = stale_or_pending(store.get(&key));
            store.set(&key, state);
            if !plot::is_expression_region_id(&key.region_id)
                && !crate::table::is_column_region_id(&key.region_id)
            {
                keys.push(key);
            }
        }
        keys
    }

    // ---- calculation ----------------------------------------------------------------

    /// Prepares a calculation pass of the regions that are out of date (`RecalcMode::Changed`,
    /// F5) or of all of them after resetting the kernel module (`RecalcMode::All`, Ctrl+F5).
    /// The pass holds what it needs, so the host runs it without keeping the session locked:
    /// edits go on meanwhile, and one made during the pass stops it at the next region.
    pub fn pass(&self, mode: RecalcMode) -> Pass {
        let setting = |name: &str| {
            self.project
                .document(&self.root)
                .and_then(|document| document.settings.values.get(name))
        };
        Pass {
            mode,
            kernel: Arc::clone(&self.kernel),
            worksheet_id: self.worksheet_id.clone(),
            results: self.results.clone(),
            cancel: Arc::clone(&self.cancel),
            derived: Arc::clone(&self.derived),
            state: self.pass_state.clone(),
            revision: Arc::clone(&self.revision),
            start_revision: self.revision.load(Ordering::SeqCst),
            trusted: self.trusted,
            untrusted_references: Arc::clone(&self.untrusted_references),
            julia_modules: Arc::clone(&self.julia_modules),
            module_name: self.module_name.clone(),
            environment_directory: self.environment_directory(),
            missing_hint: self.missing_package_hint(),
            // The directory of the saved worksheet, for a built-in that reads a file with a
            // relative path: an untitled worksheet has none.
            base_dir: self.kernel_base_dir(),
            // `ORIGIN`: an integer; anything else keeps 0.
            origin: setting("ORIGIN").and_then(|text| text.trim().parse::<i64>().ok()),
            // `TOL`: a positive finite number; anything else keeps the default.
            tol: setting("TOL")
                .and_then(|text| text.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value > 0.0),
            // `CTOL` is non-negative: 0 is allowed, unlike TOL.
            ctol: setting("CTOL")
                .and_then(|text| text.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0),
            // Approximate equality: only an explicit `exact-boolean: false` changes
            // the exact default.
            exact_boolean: setting("exact-boolean")
                .is_some_and(|text| text.trim().eq_ignore_ascii_case("false"))
                .then_some(false),
        }
    }

    /// Runs a calculation pass (see [`pass`](Self::pass)) with the session held. Blocking;
    /// run it on a background thread and read [`results`](Self::results) meanwhile.
    ///
    /// Region failures are results, not errors. `Err` means the kernel could not be
    /// started; the regions then stay as they were.
    pub fn recalculate(
        &mut self,
        mode: RecalcMode,
        progress: &mut dyn FnMut(&SessionEvent),
    ) -> Result<PassSummary, SessionError> {
        self.pass(mode).run(progress)
    }
}

/// A calculation pass prepared by [`WorksheetSession::pass`]. It works on the derived state of
/// the moment it was prepared and shares only the results store and [`PassState`] with the
/// session.
pub struct Pass {
    mode: RecalcMode,
    kernel: Arc<KernelManager>,
    worksheet_id: String,
    results: ResultsHandle,
    cancel: Arc<AtomicBool>,
    derived: Arc<Derived>,
    state: SharedPassState,
    revision: Arc<AtomicU64>,
    start_revision: u64,
    trusted: bool,
    untrusted_references: Arc<BTreeMap<DocumentId, String>>,
    julia_modules: Arc<JuliaModules>,
    module_name: Option<String>,
    environment_directory: Option<PathBuf>,
    /// Added to a missing-package message.
    missing_hint: Option<String>,
    base_dir: Option<String>,
    origin: Option<i64>,
    tol: Option<f64>,
    ctol: Option<f64>,
    exact_boolean: Option<bool>,
}

impl Pass {
    /// The session revision the pass was prepared at (see [`WorksheetSession::revision`]).
    pub fn revision(&self) -> u64 {
        self.start_revision
    }

    /// Whether the worksheet was edited since the pass was prepared.
    fn outdated(&self) -> bool {
        self.revision.load(Ordering::SeqCst) != self.start_revision
    }

    /// Evaluates the affected regions one by one and publishes each result. Blocking.
    pub fn run(self, progress: &mut dyn FnMut(&SessionEvent)) -> Result<PassSummary, SessionError> {
        self.cancel.store(false, Ordering::SeqCst);
        if !self.kernel.is_running() {
            progress(&SessionEvent::Kernel {
                status: KernelStatus::Starting,
            });
        }
        let info = match self.kernel.start() {
            Ok(info) => info,
            Err(error) => {
                progress(&SessionEvent::Kernel {
                    status: KernelStatus::Crashed {
                        message: error.to_string(),
                    },
                });
                return Err(SessionError::Kernel(error));
            }
        };
        progress(&SessionEvent::Kernel {
            status: KernelStatus::Ready { info },
        });
        // SymPy loads in the background only for a worksheet that uses it: it costs about 300 MB
        //. The request answers at once and does nothing once the warm-up has started; a
        // failure here only means the first symbolic region loads SymPy itself.
        if !self.derived.symbolic.is_empty() {
            let _ = self.kernel.symbolic_warmup();
        }
        let generation = self.kernel.generation();
        let (affected, reset) = {
            let mut state = self.state.lock();
            if state.kernel_generation != Some(generation) || self.mode == RecalcMode::All {
                state.needs_reset = true;
            }
            state.kernel_generation = Some(generation);
            if state.needs_reset {
                state.sent.clear();
            }
            let affected = if state.needs_reset {
                self.derived.order.clone()
            } else {
                affected(&self.derived, &self.results, &state.sent)
            };
            (affected, state.needs_reset)
        };
        let derived = Arc::clone(&self.derived);
        // Everything in the affected set is out of date now.
        {
            let mut store = self.results.lock();
            for gid in &affected {
                let key = &derived.keys[gid];
                let state = stale_or_pending(store.get(key));
                store.set(key, state);
            }
        }
        let mut summary = PassSummary {
            affected: affected.len(),
            reset,
            ..PassSummary::default()
        };
        progress(&SessionEvent::PassStarted {
            affected: affected.len(),
            reset,
        });
        progress(&SessionEvent::Kernel {
            status: KernelStatus::Busy,
        });
        let (origin, tol, ctol, exact_boolean) =
            (self.origin, self.tol, self.ctol, self.exact_boolean);

        let mut tracker = FailureTracker::new(derived.analysis.graph());
        self.state.lock().missing_packages.clear();
        let mut first = true;
        let mut crashed = None;
        // An edit made during the pass changed what the kernel should hold: the pass stops,
        // publishes nothing more, and the next pass starts from the edited worksheet.
        let mut outdated = false;
        for gid in &affected {
            if self.cancel.load(Ordering::SeqCst) {
                summary.incomplete = true;
                break;
            }
            if self.outdated() {
                summary.incomplete = true;
                outdated = true;
                break;
            }
            let key = derived.keys[gid].clone();
            if let Some(message) = tracker.mark_blocked(gid) {
                let blocker = tracker.blocker(gid).map(|b| derived.keys[b].clone());
                self.state.lock().sent.remove(&key);
                summary.blocked += 1;
                self.publish(
                    &key,
                    RegionState::Error {
                        failure: RegionFailure {
                            kind: FailureKind::Blocked,
                            message,
                            span: statement_span(&derived, gid),
                            blocked_by: blocker,
                            julia_type: None,
                            package: None,
                        },
                    },
                    progress,
                );
                continue;
            }
            let Some(&index) = derived.generated_index.get(gid) else {
                continue;
            };
            let region = &derived.generated.regions[index];
            let untrusted = if !region.needs_julia {
                None
            } else if !self.trusted {
                Some("this region runs Julia and the worksheet is not trusted".to_string())
            } else {
                self.untrusted_references.get(&key.document).map(|alias| {
                    format!("trust the referenced project `{alias}` to run its Julia code")
                })
            };
            if let Some(message) = untrusted {
                let _ = tracker.mark_failed(gid);
                self.state.lock().sent.remove(&key);
                summary.failed += 1;
                self.publish(
                    &key,
                    RegionState::Error {
                        failure: simple_failure(FailureKind::NotTrusted, message, &derived, gid),
                    },
                    progress,
                );
                continue;
            }
            if let Some(failure) = self.package_failure(&derived, gid, region) {
                let _ = tracker.mark_failed(gid);
                self.state.lock().sent.remove(&key);
                summary.failed += 1;
                self.publish(&key, RegionState::Error { failure }, progress);
                continue;
            }
            // Packages and the environment are set up once per pass, and only for a
            // trusted worksheet (importing a package runs its code).
            let setup = first && self.trusted;
            let request = EvaluateRequest {
                worksheet: self.worksheet_id.clone(),
                reset: first && reset,
                origin,
                tol,
                ctol,
                exact_boolean,
                packages: if setup {
                    // the project's checked package loads with the worksheet's own.
                    let mut packages = derived.generated.packages.clone();
                    for package in &self.julia_modules.packages {
                        if !packages.contains(package) {
                            packages.push(package.clone());
                        }
                    }
                    packages
                } else {
                    Vec::new()
                },
                modules: if setup {
                    self.julia_modules.files.clone()
                } else {
                    Vec::new()
                },
                environment: if setup {
                    active_environment(self.environment_directory.clone())
                } else {
                    None
                },
                base_dir: self.base_dir.clone(),
                module_name: self.module_name.clone(),
                regions: vec![RegionInput {
                    id: region.id.clone(),
                    code: (!region.code.is_empty()).then(|| region.code.clone()),
                    value: region.value.clone(),
                    display_unit: region.display_unit.as_ref().map(|unit| unit.code.clone()),
                    capture: region.julia_cell,
                }],
            };
            progress(&SessionEvent::RegionStarted { key: key.clone() });
            let started_key = key.clone();
            let outcome =
                self.kernel
                    .evaluate_with_progress(&request, &mut |p: &ProgressParams| {
                        progress(&SessionEvent::RegionProgress {
                            key: started_key.clone(),
                            fraction: p.fraction,
                            message: p.message.clone(),
                        })
                    });
            first = false;
            if outcome.is_ok() {
                self.state.lock().needs_reset = false;
            }
            if self.outdated() {
                summary.incomplete = true;
                outdated = true;
                break;
            }
            match outcome {
                Ok(response) => {
                    for module in &response.modules {
                        let mut state = self.state.lock();
                        match &module.error {
                            Some(message) => {
                                state
                                    .module_errors
                                    .insert(module.name.clone(), message.clone());
                            }
                            None => {
                                state.module_errors.remove(&module.name);
                            }
                        }
                    }
                    for package in &response.packages {
                        match &package.error {
                            Some(message) => {
                                self.state.lock().package_errors.insert(
                                    package.name.clone(),
                                    PackageProblem {
                                        message: message.clone(),
                                        missing: package.missing.is_some(),
                                    },
                                );
                            }
                            None => {
                                self.state.lock().package_errors.remove(&package.name);
                            }
                        }
                    }
                    let display_unit = response.region(gid).and_then(|r| {
                        let unit = region.display_unit.as_ref()?;
                        Some(DisplayUnit {
                            text: unit.text.clone(),
                            divisor: r.display_unit.as_ref()?.unit_divisor()?,
                            offset: r.display_offset,
                        })
                    });
                    // a Julia cell keeps what it wrote, how long it took and its trace.
                    if region.julia_cell {
                        let output = response.region(gid).map(|r| CellOutput {
                            text: r.output.clone().unwrap_or_default(),
                            duration_ms: r.duration.unwrap_or_default() * 1000.0,
                            trace: match &r.outcome {
                                RegionOutcome::Error(error) => error.trace.clone(),
                                RegionOutcome::Value(_) => None,
                            },
                        });
                        self.results.lock().set_output(&key, output);
                    }
                    let result = response.region(gid).map(|r| r.outcome.clone());
                    match result {
                        Some(RegionOutcome::Value(value)) => {
                            // A region with a symbolic evaluation shows the symbolic result.
                            let mut value = value;
                            if let Some(spec) = derived.symbolic.get(gid) {
                                let mut request = spec.clone();
                                request.origin = origin;
                                match self.symbolic_step(&derived, gid, &request, region) {
                                    SymbolicStep::Value(symbolic) => value = Some(symbolic),
                                    SymbolicStep::Failed(failure) => {
                                        let _ = tracker.mark_failed(gid);
                                        self.state.lock().sent.remove(&key);
                                        summary.failed += 1;
                                        self.publish(
                                            &key,
                                            RegionState::Error { failure },
                                            progress,
                                        );
                                        continue;
                                    }
                                    SymbolicStep::Interrupted(failure) => {
                                        let _ = tracker.mark_failed(gid);
                                        self.state.lock().sent.remove(&key);
                                        summary.failed += 1;
                                        summary.incomplete = true;
                                        self.publish(
                                            &key,
                                            RegionState::Error { failure },
                                            progress,
                                        );
                                        break;
                                    }
                                    SymbolicStep::Crashed(failure) => {
                                        let _ = tracker.mark_failed(gid);
                                        summary.failed += 1;
                                        summary.incomplete = true;
                                        crashed = Some(failure.message.clone());
                                        self.publish(
                                            &key,
                                            RegionState::Error { failure },
                                            progress,
                                        );
                                        break;
                                    }
                                }
                            }
                            self.state.lock().sent.insert(
                                key.clone(),
                                fingerprint(region, derived.symbolic.get(gid)),
                            );
                            summary.evaluated += 1;
                            self.publish(
                                &key,
                                RegionState::Value {
                                    value,
                                    display_unit,
                                },
                                progress,
                            );
                        }
                        Some(RegionOutcome::Error(error)) => {
                            let _ = tracker.mark_failed(gid);
                            self.state.lock().sent.remove(&key);
                            summary.failed += 1;
                            if let Some(package) = &error.package {
                                self.state.lock().missing_packages.insert(package.clone());
                            }
                            // A package that failed to import in this very request is the
                            // real cause of an undefined-name error of its own region.
                            let failure = self
                                .package_failure(&derived, gid, region)
                                .unwrap_or_else(|| map_region_error(&derived, gid, &error));
                            self.publish(&key, RegionState::Error { failure }, progress);
                        }
                        None => {
                            let _ = tracker.mark_failed(gid);
                            summary.failed += 1;
                            self.publish(
                                &key,
                                RegionState::Error {
                                    failure: simple_failure(
                                        FailureKind::Kernel,
                                        "the kernel returned no result for the region".into(),
                                        &derived,
                                        gid,
                                    ),
                                },
                                progress,
                            );
                        }
                    }
                }
                Err(KernelError::Interrupted) | Err(KernelError::Timeout) => {
                    let _ = tracker.mark_failed(gid);
                    self.state.lock().sent.remove(&key);
                    summary.failed += 1;
                    summary.incomplete = true;
                    self.publish(
                        &key,
                        RegionState::Error {
                            failure: simple_failure(
                                FailureKind::Interrupted,
                                "calculation interrupted".into(),
                                &derived,
                                gid,
                            ),
                        },
                        progress,
                    );
                    break;
                }
                Err(KernelError::Rpc { message, .. }) => {
                    let _ = tracker.mark_failed(gid);
                    self.state.lock().sent.remove(&key);
                    summary.failed += 1;
                    self.publish(
                        &key,
                        RegionState::Error {
                            failure: simple_failure(
                                FailureKind::Evaluation,
                                message,
                                &derived,
                                gid,
                            ),
                        },
                        progress,
                    );
                }
                Err(error) => {
                    // The kernel died (or never answered): the module is gone.
                    let _ = tracker.mark_failed(gid);
                    summary.failed += 1;
                    summary.incomplete = true;
                    crashed = Some(error.to_string());
                    self.publish(
                        &key,
                        RegionState::Error {
                            failure: simple_failure(
                                FailureKind::Kernel,
                                error.to_string(),
                                &derived,
                                gid,
                            ),
                        },
                        progress,
                    );
                    break;
                }
            }
        }
        if summary.incomplete && !outdated {
            // Regions that were not reached must be retried, not trusted. `Pending` means
            // that no calculation has ever been attempted; after a stopped pass they are
            // explicitly out of date even when they have no previous value.
            for gid in &affected {
                if let Some(entry) = derived.keys.get(gid) {
                    let current = self.results.get(entry);
                    let reached = matches!(
                        current.as_ref(),
                        Some(RegionState::Value { .. }) | Some(RegionState::Error { .. })
                    );
                    if !reached {
                        self.state.lock().sent.remove(entry);
                        self.publish(entry, stale_after_incomplete(current.as_ref()), progress);
                    }
                }
            }
        }
        if let Some(message) = crashed {
            let mut state = self.state.lock();
            state.kernel_generation = None;
            state.needs_reset = true;
            state.sent.clear();
            drop(state);
            progress(&SessionEvent::Kernel {
                status: KernelStatus::Crashed { message },
            });
        } else if let Some(info) = self.kernel.info() {
            progress(&SessionEvent::Kernel {
                status: KernelStatus::Ready { info },
            });
        }
        progress(&SessionEvent::PassFinished { summary });
        Ok(summary)
    }

    /// Runs the symbolic request of a region and maps the outcome.
    fn symbolic_step(
        &self,
        derived: &Derived,
        gid: &str,
        request: &SymbolicRequest,
        region: &GeneratedRegion,
    ) -> SymbolicStep {
        match self.kernel.symbolic(request) {
            Ok(SymbolicOutcome::Value(value)) => {
                // A definition by a symbolic result becomes usable in numeric regions: the
                // result is generated as numeric code that replaces the placeholder.
                if let (Some(target), KernelValue::Symbolic { expr, .. }) =
                    (&region.symbolic_target, &value)
                {
                    let code = symbolic_definition_code(target, expr);
                    let definition = EvaluateRequest {
                        worksheet: self.worksheet_id.clone(),
                        reset: false,
                        origin: request.origin,
                        tol: None,
                        ctol: None,
                        exact_boolean: None,
                        packages: Vec::new(),
                        modules: Vec::new(),
                        environment: None,
                        base_dir: self.base_dir.clone(),
                        module_name: None,
                        regions: vec![RegionInput {
                            id: region.id.clone(),
                            code: Some(code),
                            value: None,
                            display_unit: None,
                            capture: false,
                        }],
                    };
                    match self.kernel.evaluate(&definition) {
                        Ok(response) => {
                            if let Some(RegionOutcome::Error(error)) =
                                response.region(gid).map(|r| r.outcome.clone())
                            {
                                return SymbolicStep::Failed(map_region_error(
                                    derived, gid, &error,
                                ));
                            }
                        }
                        Err(KernelError::Interrupted) | Err(KernelError::Timeout) => {
                            return SymbolicStep::Interrupted(simple_failure(
                                FailureKind::Interrupted,
                                "calculation interrupted".into(),
                                derived,
                                gid,
                            ));
                        }
                        Err(error) => {
                            return SymbolicStep::Crashed(simple_failure(
                                FailureKind::Kernel,
                                error.to_string(),
                                derived,
                                gid,
                            ));
                        }
                    }
                }
                SymbolicStep::Value(value)
            }
            Ok(SymbolicOutcome::Error(error)) => SymbolicStep::Failed(simple_failure(
                FailureKind::Evaluation,
                error.message,
                derived,
                gid,
            )),
            Err(KernelError::Interrupted) | Err(KernelError::Timeout) => {
                SymbolicStep::Interrupted(simple_failure(
                    FailureKind::Interrupted,
                    "calculation interrupted".into(),
                    derived,
                    gid,
                ))
            }
            Err(KernelError::Rpc { message, .. }) => SymbolicStep::Failed(simple_failure(
                FailureKind::Evaluation,
                message,
                derived,
                gid,
            )),
            Err(error) => SymbolicStep::Crashed(simple_failure(
                FailureKind::Kernel,
                error.to_string(),
                derived,
                gid,
            )),
        }
    }

    /// The failure of a region that calls a package that could not be imported.
    fn package_failure(
        &self,
        derived: &Derived,
        gid: &str,
        region: &GeneratedRegion,
    ) -> Option<RegionFailure> {
        for package in &region.packages {
            let Some(problem) = self.state.lock().package_errors.get(package).cloned() else {
                continue;
            };
            let (message, julia_type) = if problem.missing {
                self.state.lock().missing_packages.insert(package.clone());
                (
                    match &self.missing_hint {
                        Some(hint) => format!(
                            "package {package} is not installed in the worksheet environment ({hint})"
                        ),
                        None => format!(
                            "package {package} is not installed in the worksheet environment; install the worksheet packages first"
                        ),
                    },
                    "MissingPackage",
                )
            } else {
                (
                    format!("package {package} could not be loaded: {}", problem.message),
                    "PackageError",
                )
            };
            let mut failure = simple_failure(FailureKind::Evaluation, message, derived, gid);
            failure.julia_type = Some(julia_type.to_string());
            failure.package = problem.missing.then(|| package.clone());
            return Some(failure);
        }
        None
    }

    fn publish(
        &self,
        key: &RegionKey,
        state: RegionState,
        progress: &mut dyn FnMut(&SessionEvent),
    ) {
        let entry = self.results.lock().set(key, state);
        if let Some(entry) = entry {
            if let Some(plot_id) = plot::expression_plot_id(&entry.key.region_id) {
                progress(&SessionEvent::PlotUpdated {
                    document: entry.key.document.clone(),
                    region_id: plot_id.to_owned(),
                });
            } else {
                progress(&SessionEvent::RegionUpdated { entry });
            }
        }
    }
}

/// The region ids (graph ids, evaluation order) that need evaluation: regions that are not
/// calculated or whose generated code changed since the kernel got it, and their dependents.
fn affected(
    derived: &Derived,
    results: &ResultsHandle,
    sent: &HashMap<RegionKey, Fingerprint>,
) -> Vec<String> {
    let store = results.lock();
    let mut dirty = Vec::new();
    for gid in &derived.order {
        let key = &derived.keys[gid];
        let unchanged = match (derived.generated_index.get(gid), sent.get(key)) {
            (Some(&i), Some(sent)) => {
                sent.matches(&derived.generated.regions[i], derived.symbolic.get(gid))
            }
            (None, None) => true,
            _ => false,
        };
        let calculated = matches!(store.get(key), Some(RegionState::Value { .. }));
        if !calculated || !unchanged {
            dirty.push(gid.clone());
        }
    }
    drop(store);
    derived
        .analysis
        .graph()
        .affected_by(dirty)
        .expect("dirty ids come from the graph")
}

/// The environment directory handed to the kernel: only when it has a `Project.toml`.
fn active_environment(directory: Option<PathBuf>) -> Option<String> {
    let directory = directory?;
    ["Project.toml", "JuliaProject.toml"]
        .iter()
        .any(|name| directory.join(name).is_file())
        .then(|| directory.to_string_lossy().into_owned())
}

/// Whether `value` is or holds a Julia handle, which names an object of this kernel only.
fn holds_handle(value: &KernelValue) -> bool {
    match value {
        KernelValue::Handle { .. } => true,
        KernelValue::Matrix {
            storage: crate::kernel_value::MatrixStorage::Inline { values },
            ..
        } => values.iter().any(holds_handle),
        _ => false,
    }
}

/// Invalidating an untouched region keeps it pending; a previous good value becomes stale.
fn stale_or_pending(state: Option<&RegionState>) -> RegionState {
    match state {
        Some(RegionState::Value {
            value,
            display_unit,
        })
        | Some(RegionState::Stale {
            value,
            display_unit,
        }) => RegionState::Stale {
            value: value.clone(),
            display_unit: display_unit.clone(),
        },
        _ => RegionState::Pending,
    }
}

/// Once a pass has started and stopped early, an unreached region is out of date even if
/// it has never produced a value.
fn stale_after_incomplete(state: Option<&RegionState>) -> RegionState {
    match stale_or_pending(state) {
        RegionState::Pending => RegionState::Stale {
            value: None,
            display_unit: None,
        },
        stale => stale,
    }
}

/// The outcome of the symbolic request of one region.
enum SymbolicStep {
    Value(KernelValue),
    Failed(RegionFailure),
    Interrupted(RegionFailure),
    Crashed(RegionFailure),
}

// ---------------------------------------------------------------------------------------
// Derivation and error mapping
// ---------------------------------------------------------------------------------------

/// Whether a region is placed at the left margin of its page rather than at its own x.
fn starts_at_left_margin(region: &Arc<DocumentRegion>) -> bool {
    match region.as_ref() {
        DocumentRegion::Text(text) => text.full_width,
        DocumentRegion::Area(_) => true,
        _ => false,
    }
}

/// Builds the view region of one document region. `view` calls it only for a region it has no
/// fresh cached version of, and passes what the view reads besides the region itself.
fn build_view_region(
    region: &DocumentRegion,
    math_text: Option<&str>,
    format: Option<&BTreeMap<String, String>>,
    numeric: Option<&BTreeMap<String, String>>,
    media: Option<crate::image::ImageMedia>,
    breaks: &[crate::layout::MathBreak],
    doc: &crate::project::ProjectDocument,
) -> ViewRegion {
    let (content, page, x, y, enabled) = match region {
        DocumentRegion::Math(math) => (
            match &math.statement.kind {
                StatementKind::Julia { block } => ViewContent::Julia {
                    block: block.clone(),
                },
                _ => ViewContent::Math {
                    text: math_text
                        .map(str::to_owned)
                        .unwrap_or_else(|| print_statement(&math.statement)),
                    statement: Arc::clone(&math.statement),
                    breaks: breaks.to_vec(),
                    format: format.cloned(),
                    numeric: numeric.cloned(),
                },
            },
            math.page,
            math.x,
            math.y,
            math.enabled,
        ),
        DocumentRegion::Include(include) => (
            ViewContent::Include {
                path: include.path.clone(),
            },
            include.page,
            include.x,
            include.y,
            include.enabled,
        ),
        DocumentRegion::Text(text) => (
            ViewContent::Text {
                text: text.text.clone(),
                width: text.width,
                full_width: text.full_width,
                background: text.background.clone(),
                language: text.language.clone(),
                paragraphs: {
                    let mut value = RichText::parse(&text.text);
                    value.resolve_math();
                    value
                },
            },
            text.page,
            // A text block always starts at the left margin.
            if text.full_width {
                doc.page.margins.left
            } else {
                text.x
            },
            text.y,
            text.enabled,
        ),
        DocumentRegion::Image(image) => (
            ViewContent::Image {
                resource: image.resource.clone(),
                media: media.unwrap_or_else(|| {
                    doc.image_media(&image.resource)
                        .unwrap_or(crate::image::ImageMedia::Png)
                }),
                size: image.size,
            },
            image.page,
            image.x,
            image.y,
            image.enabled,
        ),
        DocumentRegion::Area(area) => (
            ViewContent::Area {
                title: area.title.clone(),
                height: area.height,
                collapsed: area.collapsed,
            },
            area.page,
            doc.page.margins.left,
            area.y,
            area.enabled,
        ),
        DocumentRegion::Plot(plot) => (
            ViewContent::Plot {
                plot: plot.plot.clone(),
            },
            plot.page,
            plot.x,
            plot.y,
            plot.enabled,
        ),
    };
    ViewRegion {
        id: region.id().to_owned(),
        page,
        x,
        y,
        enabled,
        content,
    }
}

/// The numeric choices of the regions of every document, keyed by the id of their node in the
/// generated worksheet (an included document's region has one per inclusion).
fn numeric_choices(
    project: &Project,
    analysis: &crate::project::ProjectAnalysis,
) -> crate::fasthash::HashMap<String, BTreeMap<String, String>> {
    let mut choices = crate::fasthash::HashMap::default();
    for node in analysis.nodes() {
        let Some(document) = project.document(&node.origin.document) else {
            continue;
        };
        if let Some(options) = document.numeric_options.get(&node.origin.region_id) {
            choices.insert(crate::project::graph_id(node.id), options.clone());
        }
    }
    choices
}

fn derive(
    project: &Project,
    root: &DocumentId,
    options: &GenOptions,
) -> Result<Derived, SessionError> {
    let analysis = project.analyze(root)?;
    let worksheet = analysis.worksheet();
    // The analysis built the dependency graph already; it is reused, not rebuilt.
    let graph = analysis.graph();
    let mut options = options.clone();
    options.references = std::sync::Arc::clone(project.references());
    options.numeric = std::sync::Arc::new(numeric_choices(project, &analysis));
    let generated = generate_worksheet_with(worksheet, graph, options)?;
    let mut keys = HashMap::new();
    let mut by_key = HashMap::new();
    let mut occurrences: HashMap<(DocumentId, String), u32> = HashMap::new();
    let mut node_order = Vec::new();
    for node in analysis.nodes() {
        if !matches!(node.kind, NodeKind::Math) {
            continue;
        }
        let counter = occurrences
            .entry((node.origin.document.clone(), node.origin.region_id.clone()))
            .or_default();
        let key = RegionKey {
            document: node.origin.document.clone(),
            region_id: node.origin.region_id.clone(),
            instance: *counter,
        };
        *counter += 1;
        let gid = node.id.region_id();
        keys.insert(gid.clone(), key.clone());
        by_key.insert(key, gid.clone());
        node_order.push(gid);
    }
    // Evaluation order, restricted to math nodes (all enabled regions of the analysis).
    let order: Vec<String> = graph
        .evaluation_order()
        .into_iter()
        .filter(|gid| keys.contains_key(gid))
        .collect();
    debug_assert_eq!(order.len(), node_order.len());
    let generated_index = generated
        .regions
        .iter()
        .enumerate()
        .map(|(i, region)| (region.id.clone(), i))
        .collect();
    // One statement index for all regions: built per region it made this step quadratic.
    let statements = statements_by_id(worksheet);
    let symbolic = worksheet
        .regions
        .iter()
        .filter_map(|region| {
            region_request_in(&statements, graph, &region.id)
                .map(|request| (region.id.clone(), request))
        })
        .collect();
    let analysis_regions = project
        .documents()
        .map(|document| {
            (
                document.id.clone(),
                document
                    .regions
                    .iter()
                    .filter(|region| has_analysis_effect(region))
                    .map(|region| region.id().to_owned())
                    .collect(),
            )
        })
        .collect();
    Ok(Derived {
        analysis,
        generated,
        order,
        keys,
        by_key,
        generated_index,
        symbolic,
        analysis_regions,
    })
}

fn statement_span(derived: &Derived, gid: &str) -> Option<Span> {
    derived
        .analysis
        .worksheet()
        .regions
        .iter()
        .find(|region| region.id == gid)
        .map(|region| region.statement.span)
}

fn simple_failure(
    kind: FailureKind,
    message: String,
    derived: &Derived,
    gid: &str,
) -> RegionFailure {
    RegionFailure {
        kind,
        message,
        span: statement_span(derived, gid),
        blocked_by: None,
        julia_type: None,
        package: None,
    }
}

fn map_region_error(derived: &Derived, gid: &str, error: &RegionError) -> RegionFailure {
    let located = error.statement.and_then(|id| {
        derived
            .generated
            .statements
            .iter()
            .find(|location| location.id == id && location.region_id == gid)
            .map(|location| location.span)
    });
    let message = demangle_message(&error.message);
    // A problem the generator found (an undefined name, an unsupported form) carries the span of
    // the sub-expression it is about; the kernel only knows the statement.
    let diagnosed = derived.generated_index.get(gid).and_then(|index| {
        derived.generated.regions[*index]
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message == message)
            .map(|diagnostic| diagnostic.span)
    });
    RegionFailure {
        kind: FailureKind::Evaluation,
        message,
        span: diagnosed
            .or(located)
            .or_else(|| statement_span(derived, gid)),
        blocked_by: None,
        julia_type: error.julia_type.clone(),
        package: error.package.clone(),
    }
}

/// Replaces generated sheet identifiers (`x_v2`) in a kernel message by the worksheet
/// names they stand for.
pub fn demangle_message(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        let replaced = match demangle_ident(token) {
            Some((segments, Some(_))) if token.contains("_v") => Some(print_name(&Name {
                segments,
                label: None,
            })),
            _ => None,
        };
        out.push_str(replaced.as_deref().unwrap_or(token));
        token.clear();
    };
    for c in message.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            token.push(c);
        } else {
            flush(&mut token, &mut out);
            out.push(c);
        }
    }
    flush(&mut token, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demangles_worksheet_identifiers_in_messages() {
        assert_eq!(
            demangle_message("UndefVarError: `x_v2` not defined in `Worksheet1`"),
            "UndefVarError: `x` not defined in `Worksheet1`"
        );
        assert_eq!(
            demangle_message("plain text, no names"),
            "plain text, no names"
        );
        assert_eq!(demangle_message("a_v1 + b_v12"), "a + b");
    }

    #[test]
    fn leaves_other_identifiers_alone() {
        assert_eq!(demangle_message("eq_add failed"), "eq_add failed");
        assert_eq!(demangle_message("version 3"), "version 3");
    }
}
