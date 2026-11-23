//! The application service behind the Tauri commands.
//!
//! It owns the one shared kernel manager, the open worksheets (a core
//! `WorksheetSession` each) and the kernel status, and it forwards progress to the
//! frontend through an injected event sink. It does not depend on Tauri, so it is tested
//! with a channel instead of a window.
//!
//! Events (the names are part of the frontend contract, see `app/src/equavelaApi.ts`):
//! - `kernel-status`: a `KernelStatus` object (`status`: `not_started`, `starting`,
//!   `ready`, `busy`, `crashed`);
//! - `worksheet-event`: a `SessionEvent` object plus a `worksheet` field with the
//!   worksheet id; `pass_failed` (with `message`) is added for a calculation that could
//!   not run at all.

use crate::kernel_path::{resolve_kernel_config, LocationInputs};
use equavela_core::area::{AreaRegion, MIN_AREA_HEIGHT};
use equavela_core::ast::{Arg, Statement};
use equavela_core::codegen::GenOptions;
use equavela_core::document_archive::{
    decode_document, encode_document, materialize_environment, new_document_id, read_environment,
    DocumentArchive,
};
use equavela_core::edit::{EditCommand, StoredRegion};
use equavela_core::environment::{
    environment_metadata_snapshot, read_environment_files, resolve_environment,
    resolve_environment_with_archive, EnvironmentFiles, EnvironmentKind, WorksheetEnvironment,
};
use equavela_core::environment_snapshot::{ChangeJournal, SnapshotStore};
use equavela_core::graph::Region;
use equavela_core::image::{
    base64_decode, base64_encode, initial_size_pt, natural_size_pt, resource_from_bytes,
    AssetReference, ImageMedia, ImageRegion, ImageResource,
};
use equavela_core::kernel_manager::{KernelConfig, KernelManager};
use equavela_core::layout::{PageBreak, PageSetup, TextRegion};
use equavela_core::plot::{PlotRegion, PlotSpec, ViewRange};
use equavela_core::project::{DocumentId, DocumentRegion, IncludeRegion, Project, ProjectDocument};
use equavela_core::project_directory::{
    check_asset, create_project_with_files, find_worksheet_project, list_image_assets,
    load_project_directory, portable_file_stem, read_asset, store_asset,
};
use equavela_core::project_manifest::{ApiEntry, ProjectManifest, WorksheetEntry, PROJECT_FORMAT};
use equavela_core::project_reference::{self, References};
use equavela_core::project_tree::{self, NewItem, TreeEntry};
use equavela_core::richtext::RichText;
use equavela_core::session::{
    DefinitionValue, DocumentView, Inspection, InterruptHandle, JuliaModules, KernelStatus,
    RecalcMode, RegionEntry, RegionKey, ResultsHandle, SessionDiagnostic, SessionError,
    SessionEvent, ViewRegion, WarningInfo, WorksheetSession,
};
use equavela_core::stored_results;
use equavela_core::syntax::{
    normalize_expr, normalize_statement, normalize_target, parse_arguments, parse_statement,
    print_arguments, print_statement,
};
use equavela_core::worksheet_file::{
    load_project, load_project_text, parse_document, path_for_document, LoadError,
};
use equavela_core::worksheet_module::{module_identifier, module_names};
use equavela_core::worksheet_writer::{
    write_bytes_atomic, write_document, write_file_atomic, WriteError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

pub const EVENT_KERNEL_STATUS: &str = "kernel-status";
pub const EVENT_WORKSHEET: &str = "worksheet-event";
// The core creation API requires callers in this process to serialize publication.
static PROJECT_CREATION: Mutex<()> = Mutex::new(());
static PROJECT_TEXT_RECOVERY: Mutex<()> = Mutex::new(());

/// Delivers an event to the frontend.
pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// An error returned by a command; serialized as `{ kind, message, ... }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandError {
    /// `load`, `parse`, `unknown_worksheet`, `busy`, `region`, `paste` or `internal`.
    pub kind: &'static str,
    pub message: String,
    /// For `parse`: position of the syntax error in the submitted text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<usize>,
}

/// A project image and the worksheets whose live image regions reference it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectImageUsage {
    pub path: String,
    pub worksheets: Vec<String>,
    pub problem: Option<String>,
}

impl CommandError {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> CommandError {
        CommandError {
            kind,
            message: message.into(),
            line: None,
            column: None,
            start: None,
            end: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> CommandError {
        CommandError::new("internal", message)
    }

    fn busy() -> CommandError {
        CommandError::new(
            "busy",
            "a calculation is running; interrupt it or wait until it finishes",
        )
    }
}

impl From<WriteError> for CommandError {
    fn from(error: WriteError) -> Self {
        CommandError::new("save", error.to_string())
    }
}

impl From<LoadError> for CommandError {
    fn from(error: LoadError) -> Self {
        CommandError::new("load", error.to_string())
    }
}

impl From<SessionError> for CommandError {
    fn from(error: SessionError) -> Self {
        match error {
            SessionError::Parse(parse) => CommandError {
                kind: "parse",
                message: parse.to_string(),
                line: Some(parse.line),
                column: Some(parse.column),
                start: Some(parse.span.start),
                end: Some(parse.span.end),
            },
            SessionError::NotAMathRegion { .. } => CommandError::new("region", error.to_string()),
            other => CommandError::new("internal", other.to_string()),
        }
    }
}

/// The source text of a math region.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RegionText {
    pub document: DocumentId,
    pub region_id: String,
    pub text: String,
}

/// What `open_worksheet` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenedWorksheet {
    pub id: String,
    pub root: DocumentId,
    pub regions: Vec<RegionEntry>,
    pub texts: Vec<RegionText>,
    pub diagnostics: Vec<SessionDiagnostic>,
    /// Page setup and regions of the root document, for the page view.
    pub view: DocumentView,
    /// The revision `view` and `regions` have in the worksheet's edit stream: the `base` a
    /// delta applies to. A freshly opened worksheet is at revision 0.
    pub revision: u64,
    /// The worksheet's Julia environment, for the status bar indicator.
    pub environment: EnvironmentSummary,
}

/// Which Julia environment a worksheet uses and which kernel serves it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnvironmentSummary {
    pub kind: EnvironmentKind,
    pub directory: String,
    /// An override given as an absolute path: the worksheet is not portable.
    pub absolute: bool,
    /// The key of its kernel, as `kernel-status` events name it.
    pub kernel: String,
}

impl EnvironmentSummary {
    fn of(environment: &WorksheetEnvironment) -> Self {
        EnvironmentSummary {
            kind: environment.kind,
            directory: slash_path(&environment.directory),
            absolute: environment.absolute,
            kernel: slash_path(&kernel_key(&environment.directory)),
        }
    }
}

/// A read-only comparison of a proposed environment switch.
#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentSwitchPreview {
    pub token: String,
    pub current: EnvironmentSummary,
    pub target: EnvironmentSummary,
    pub files: EnvironmentFiles,
    pub differences: Vec<EnvironmentSwitchDifference>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentSwitchDifference {
    pub name: String,
    pub current: Option<String>,
    pub target: Option<String>,
    pub missing: bool,
}

#[derive(Clone)]
struct EnvironmentSwitchPlan {
    token: String,
    current: EnvironmentSummary,
    target_summary: EnvironmentSummary,
    target: Option<PathBuf>,
    source_files: Vec<(String, Option<Vec<u8>>)>,
    target_files: Vec<(String, Option<Vec<u8>>)>,
}

/// What the environment manager shows.
#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentInfo {
    #[serde(flatten)]
    pub summary: EnvironmentSummary,
    pub problems: Vec<String>,
    pub files: EnvironmentFiles,
    pub kernel_status: KernelStatus,
    /// Whether the worksheet may choose another environment.
    pub can_override: bool,
    /// The last package change, while it can be undone.
    pub last_change: Option<EnvironmentChange>,
    /// A package change Equavela stopped during.
    pub interrupted_change: Option<EnvironmentChange>,
}

/// A package operation recorded by an environment snapshot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnvironmentChange {
    pub operation: String,
    pub packages: Vec<String>,
    /// Seconds since the Unix epoch.
    pub started: u64,
}

impl From<ChangeJournal> for EnvironmentChange {
    fn from(journal: ChangeJournal) -> Self {
        Self {
            operation: journal.operation,
            packages: journal.packages,
            started: journal.started,
        }
    }
}

/// A validated folder project and its opened main worksheet.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenedProject {
    pub root: String,
    pub manifest: ProjectManifest,
    /// The worksheet a command opened with the project: the converted one. Opening or
    /// creating a project opens no worksheet.
    pub worksheet: Option<OpenedWorksheet>,
}

/// What a command of the project explorer returns: the
/// manifest and the tree as they are now, the worksheet it opened, the open worksheets it
/// reopened from a new path (the old session `id` is closed) and the ones it closed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectChange {
    pub manifest: ProjectManifest,
    /// The project tree after the change.
    pub entries: Vec<TreeEntry>,
    pub opened: Option<OpenedWorksheet>,
    pub replaced: Vec<ReplacedWorksheet>,
    /// Sessions closed because their worksheet went to the trash.
    pub closed: Vec<String>,
}

/// A text file of the project tree as a text tab reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectTextFile {
    pub text: String,
    /// The version of the bytes read, which Save checks against the disk.
    pub version: String,
}

/// What saving a text tab did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectTextSaved {
    pub version: String,
    /// Whether the project's kernel restarted because a Julia source changed.
    pub restarted: bool,
}

/// An open worksheet whose session was replaced by a project command.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReplacedWorksheet {
    pub id: String,
    pub opened: OpenedWorksheet,
}

/// What `import_mcdx` returns: the new untitled worksheet and what was not imported.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImportedWorksheet {
    pub opened: OpenedWorksheet,
    pub report: equavela_core::mcdx::ImportReport,
}

/// What `save_worksheet` and `save_worksheet_as` return.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SavedWorksheet {
    /// The file that was written (absolute, forward slashes).
    pub path: String,
    /// Save As to another file re-opens the worksheet there (its includes are resolved against
    /// the new location, the undo history starts again): the new session, to replace the old one.
    pub opened: Option<OpenedWorksheet>,
}

/// Where the Save As dialog opens.
#[derive(Debug, Clone, PartialEq)]
pub struct SaveLocation {
    pub directory: Option<PathBuf>,
    pub file_name: String,
}

/// Unsaved project text and the disk state from which it was edited.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectTextRecovery {
    pub text: String,
    pub saved: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectTextRecoveryEntry {
    pub id: String,
    pub root: String,
    pub path: String,
    pub modified_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectTextRecoveryListing {
    pub entries: Vec<ProjectTextRecoveryEntry>,
    pub unreadable: usize,
}

#[derive(Serialize, Deserialize)]
struct ProjectTextRecoveryFile {
    root: PathBuf,
    path: String,
    recovery: ProjectTextRecovery,
}

/// A recovery file that is newer than the worksheet file it belongs to.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecoveryInfo {
    /// The recovery file (absolute, forward slashes).
    pub path: String,
}

/// A definition asked for by name and version (`definition_values`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct DefinitionRef {
    pub name: String,
    pub version: u32,
}

/// One region of a math-font command: the region and the whole
/// display override it should carry afterwards. The font is part of the region display override,
/// so the command is the result-format one for several regions
/// at once.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MathFontEdit {
    pub region_id: String,
    /// The new display override, `None` when it becomes empty: the `format.*` keys and the
    /// result-table box it keeps are the caller's, which sends the map it already holds.
    pub format: Option<BTreeMap<String, String>>,
}

/// One region move of a drag.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RegionMove {
    pub region_id: String,
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

/// A new band height of an area, applied with a line insertion or removal inside the area.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AreaHeight {
    pub region_id: String,
    pub height: f64,
}

/// One [`RegionMove`] as the edit command that applies it.
/// `command`, then the growth of the band that holds `region_id`: one undo step.
fn held(command: EditCommand, region_id: &str) -> EditCommand {
    EditCommand::Batch {
        commands: vec![
            command,
            EditCommand::HoldMembers {
                region_ids: vec![region_id.to_owned()],
            },
        ],
    }
}

fn move_command(movement: RegionMove) -> EditCommand {
    EditCommand::Move {
        region_id: movement.region_id,
        page: movement.page,
        x: movement.x,
        y: movement.y,
    }
}

/// What an edit command (add, move, remove, undo, redo) returns: the difference between the
/// document view and the results list the worksheet last sent and their state now.
///
/// The frontend keeps the last full view and results list and applies the delta to them, so an
/// edit sends a few KiB whatever the size of the worksheet instead of the whole state (16.7 MiB
/// at 20 000 regions). A field that did not change is left out; the small scalars are always
/// sent. `base` names the revision the delta applies to: a frontend whose stored revision is not
/// `base` asks for [`WorksheetSnapshot`] instead.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EditResult {
    /// The revision the delta applies to (the revision of the last state sent).
    pub base: u64,
    /// The revision of the state after the delta.
    pub revision: u64,
    /// The regions that are new or changed, whole.
    pub regions: Vec<ViewRegion>,
    /// The ids of the regions that are gone.
    pub removed: Vec<String>,
    /// The region ids in their new order; only when the order changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    /// The root document; only when it changed (Save As starts a new session).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<DocumentId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<PageSetup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<BTreeMap<String, String>>,
    /// The manual page breaks; only when they changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_breaks: Option<Vec<PageBreak>>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
    /// Whether the worksheet is trusted; always sent.
    pub trusted: bool,
    /// The result entries that are new or changed, whole: the entries whose state is `stale` are
    /// the regions a calculation has to redo (the list of their keys is not sent: at 20 000
    /// regions it was 2 MiB of the payload, and the UI never used it).
    pub results: Vec<RegionEntry>,
    /// The keys ([`entry_id`]) of the results that are gone.
    pub removed_results: Vec<String>,
    /// The result keys in their new order; only when the order changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results_order: Option<Vec<String>>,
    pub created: Option<String>,
    /// Whether **this change** made an expression (a plot trace included) out of date, so an
    /// automatic calculation is due. A display-only edit or a move that keeps the evaluation
    /// order leaves it false.
    pub calc_needed: bool,
    /// Label of the operation that was done, undone or redone.
    pub label: Option<String>,
    /// The structural problems of the project (missing include, include cycle), only when they changed
    /// with this edit: an include inserted, re-pointed or undone changes them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<SessionDiagnostic>>,
    /// The worksheet's Julia environment, only when this change moved it to another one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<EnvironmentSummary>,
}

/// The whole state of a worksheet, for a frontend that lost the thread of the deltas:
/// `worksheet_snapshot` returns it and resets the baseline, so the next `EditResult` has this
/// `revision` as its `base`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorksheetSnapshot {
    pub revision: u64,
    pub view: DocumentView,
    pub regions: Vec<RegionEntry>,
}

/// What adding or replacing an image returns: the edit delta and how many unsafe SVG parts were
/// removed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageAdded {
    #[serde(flatten)]
    pub edit: EditResult,
    /// Unsafe SVG parts (scripts, external references) dropped from the new image.
    pub removed_parts: usize,
}

/// The image region `region_id` of a document, or a command error naming what it is instead.
fn image_region<'a>(
    document: &'a ProjectDocument,
    region_id: &str,
) -> Result<&'a ImageRegion, CommandError> {
    document
        .regions
        .iter()
        .find_map(|region| match region.as_ref() {
            DocumentRegion::Image(image) if image.id == region_id => Some(image),
            _ => None,
        })
        .ok_or_else(|| CommandError::new("image", format!("`{region_id}` is not an image region")))
}

/// The resource an image region shows.
fn image_resource<'a>(
    document: &'a ProjectDocument,
    image: &ImageRegion,
) -> Result<std::borrow::Cow<'a, ImageResource>, CommandError> {
    resource_bytes(document, &image.resource)
}

/// The bytes of an image resource: embedded, or read from the project asset it names
///.
fn resource_bytes<'a>(
    document: &'a ProjectDocument,
    id: &str,
) -> Result<std::borrow::Cow<'a, ImageResource>, CommandError> {
    if let Some(resource) = document.resources.get(id) {
        return Ok(std::borrow::Cow::Borrowed(resource));
    }
    let asset = document
        .assets
        .get(id)
        .ok_or_else(|| CommandError::new("image", format!("no image resource `{id}`")))?;
    let root = worksheet_project(document).ok_or_else(|| no_project(&asset.path))?;
    read_asset(&root, asset)
        .map(std::borrow::Cow::Owned)
        .map_err(|message| CommandError::new("image", message))
}

/// The folder project that declares the worksheet file of `document`.
fn worksheet_project(document: &ProjectDocument) -> Option<PathBuf> {
    let path = Path::new(document.id.as_str());
    path.is_absolute()
        .then(|| find_worksheet_project(path))
        .flatten()
}

fn no_project(asset: &str) -> CommandError {
    CommandError::new(
        "image",
        format!("image asset `{asset}` needs the worksheet to be part of a project"),
    )
}

/// Where the bytes of new images go within one edit. In a project worksheet
/// they become project assets: the file is written now, identical bytes reuse the file and the
/// resource that names it. Otherwise they are embedded, identical bytes reusing the resource.
struct ImagePlacer {
    project: Option<PathBuf>,
    /// Resource ids in use, including those added earlier in the same edit.
    taken: HashSet<String>,
    /// Assets added earlier in the same edit, by path.
    added_assets: HashMap<String, String>,
    /// Embedded resources added earlier in the same edit.
    added_resources: Vec<(String, ImageResource)>,
}

impl ImagePlacer {
    fn new(document: &ProjectDocument) -> Self {
        ImagePlacer {
            project: worksheet_project(document),
            taken: document
                .resources
                .keys()
                .chain(document.assets.keys())
                .cloned()
                .collect(),
            added_assets: HashMap::new(),
            added_resources: Vec::new(),
        }
    }

    /// The resource id for `resource` and the command that adds it (`None` when an existing
    /// resource is reused). `stem` names a new asset file; `preferred` is tried as the id.
    fn place(
        &mut self,
        document: &ProjectDocument,
        resource: &ImageResource,
        stem: &str,
        preferred: Option<&str>,
    ) -> Result<(String, Option<EditCommand>), CommandError> {
        if let Some(root) = &self.project {
            let path = store_asset(root, resource, stem)
                .map_err(|error| CommandError::new("image", error.to_string()))?;
            let existing = document
                .assets
                .iter()
                .find(|(_, asset)| asset.path == path)
                .map(|(id, _)| id.clone())
                .or_else(|| self.added_assets.get(&path).cloned());
            if let Some(id) = existing {
                return Ok((id, None));
            }
            let id = self.fresh(preferred);
            self.added_assets.insert(path.clone(), id.clone());
            let asset = AssetReference {
                media: resource.media,
                path,
            };
            return Ok((id.clone(), Some(EditCommand::AddAsset { id, asset })));
        }
        let existing = document
            .resources
            .iter()
            .chain(self.added_resources.iter().map(|(id, stored)| (id, stored)))
            .find(|(_, stored)| *stored == resource)
            .map(|(id, _)| id.clone());
        if let Some(id) = existing {
            return Ok((id, None));
        }
        let id = self.fresh(preferred);
        self.added_resources.push((id.clone(), resource.clone()));
        let command = EditCommand::AddResource {
            id: id.clone(),
            resource: resource.clone(),
        };
        Ok((id, Some(command)))
    }

    fn fresh(&mut self, preferred: Option<&str>) -> String {
        let id = preferred
            .filter(|id| !self.taken.contains(*id))
            .map(str::to_owned)
            .unwrap_or_else(|| {
                (1..)
                    .map(|n| format!("img{n}"))
                    .find(|candidate| !self.taken.contains(candidate))
                    .expect("an unused resource id exists")
            });
        self.taken.insert(id.clone());
        id
    }
}

/// The stem of an image file, for naming a new project asset.
fn image_stem(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".into())
}

/// Save As to a file the worksheet's project does not declare: every asset an image
/// region uses becomes an embedded resource, so the copy carries its pictures. An asset that
/// cannot be read refuses the save and names it.
fn embed_assets_leaving_project(
    document: &mut ProjectDocument,
    destination: &Path,
) -> Result<(), CommandError> {
    if document.assets.is_empty() {
        return Ok(());
    }
    let project = worksheet_project(document);
    let stays = project.as_ref().is_some_and(|root| {
        let destination = destination
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .zip(destination.file_name())
            .map(|(parent, name)| parent.join(name));
        load_project_directory(root).is_ok_and(|loaded| {
            loaded
                .manifest
                .worksheets
                .iter()
                .any(|sheet| destination.as_deref() == Some(root.join(&sheet.path).as_path()))
        })
    });
    if stays {
        return Ok(());
    }
    let used: HashSet<String> = document
        .regions
        .iter()
        .filter_map(|region| match region.as_ref() {
            DocumentRegion::Image(image) => Some(image.resource.clone()),
            _ => None,
        })
        .collect();
    for (id, asset) in std::mem::take(&mut document.assets) {
        if !used.contains(&id) {
            continue;
        }
        let resource = match &project {
            Some(root) => read_asset(root, &asset),
            None => Err(no_project(&asset.path).message),
        }
        .map_err(|message| {
            CommandError::new(
                "save",
                format!("cannot embed image asset `{}`: {message}", asset.path),
            )
        })?;
        document.resources.insert(id, resource);
    }
    Ok(())
}

/// The structural problems of a worksheet, plus the project assets its image regions cannot
/// reach. Assets are checked without being read.
fn worksheet_diagnostics(session: &WorksheetSession) -> Vec<SessionDiagnostic> {
    let mut diagnostics = session.diagnostics();
    // the environment's problems belong to the worksheet, not to a region.
    for message in session.environment().problems {
        diagnostics.push(SessionDiagnostic {
            document: session.root().clone(),
            region_id: String::new(),
            message,
        });
    }
    let Some(document) = session.project().document(session.root()) else {
        return diagnostics;
    };
    if document.assets.is_empty() {
        return diagnostics;
    }
    let project = worksheet_project(document);
    for region in &document.regions {
        let DocumentRegion::Image(image) = region.as_ref() else {
            continue;
        };
        let Some(asset) = document.assets.get(&image.resource) else {
            continue;
        };
        let problem = match &project {
            None => Some(no_project(&asset.path).message),
            Some(root) => check_asset(root, asset).err(),
        };
        if let Some(message) = problem {
            diagnostics.push(SessionDiagnostic {
                document: document.id.clone(),
                region_id: image.id.clone(),
                message,
            });
        }
    }
    diagnostics
}

/// The size an image region gets back from : the natural size of `resource` in points,
/// scaled down with the aspect ratio kept to the room between `x` and the right margin (and never
/// larger than the natural size), rounded to 0.01 pt and at least 12 x 12 pt. Original Size
/// and Replace both use it.
fn fitted_image_size(document: &ProjectDocument, resource: &ImageResource, x: f64) -> [f64; 2] {
    let page = &document.page;
    let printable = page.width - page.margins.left - page.margins.right;
    let right = page.width - page.margins.right;
    initial_size_pt(natural_size_pt(resource), (right - x).min(printable))
}

/// The key of a result entry as the frontend builds it (`keyId` in `app/src/equavelaApi.ts`):
/// one region instance's results.
fn entry_id(key: &RegionKey) -> String {
    format!("{}#{}#{}", key.document, key.region_id, key.instance)
}

/// A region as it was last sent.
///
/// The session hands back the same `Arc<ViewRegion>` for a region an edit left alone, so a
/// pointer comparison says "unchanged" without serializing anything: the baseline keeps no JSON
/// of its own any more (at 20 000 regions that was 15 MB and a serialization per region per
/// edit). Keeping the `Arc` alive is what makes the pointer an identity: the address cannot be
/// reused while it is held.
struct SentRegion {
    view: Arc<ViewRegion>,
}

/// A result entry as it was last sent: compared as a value, not as JSON.
struct SentResult {
    entry: RegionEntry,
}

/// What a worksheet last sent to the frontend: the regions and result entries, their order
/// and the other fields of the view, with the revision that names that state.
/// [`SentState::advance`] compares a new state with it and only the differences go on the wire.
#[derive(Default)]
struct SentState {
    revision: u64,
    /// The region last sent, by the address of its `Arc` (see [`SentRegion`]).
    regions: HashMap<usize, SentRegion>,
    /// The region ids in the order last sent.
    region_order: Vec<String>,
    document: String,
    page: String,
    settings: String,
    page_breaks: String,
    /// The result entry last sent, by key.
    results: HashMap<RegionKey, SentResult>,
    /// The keys of the result entries in the order last sent.
    result_order: Vec<RegionKey>,
}

impl SentState {
    /// The baseline of a state that has been sent whole (a worksheet just opened, a snapshot).
    fn capture(revision: u64, view: &DocumentView, regions: &[RegionEntry]) -> SentState {
        let mut state = SentState {
            revision,
            document: serde_json::to_string(&view.document).expect("the document id serializes"),
            page: serde_json::to_string(&view.page).expect("the page setup serializes"),
            settings: serde_json::to_string(&view.settings).expect("the settings serialize"),
            page_breaks: serde_json::to_string(&view.page_breaks)
                .expect("the page breaks serialize"),
            ..SentState::default()
        };
        for region in &view.regions {
            state.region_order.push(region.id.clone());
            state.regions.insert(
                Arc::as_ptr(region) as usize,
                SentRegion {
                    view: Arc::clone(region),
                },
            );
        }
        for entry in regions {
            state.results.insert(
                entry.key.clone(),
                SentResult {
                    entry: entry.clone(),
                },
            );
            state.result_order.push(entry.key.clone());
        }
        state
    }

    /// The delta from this baseline to `view` and `regions`, and the baseline of the state the
    /// frontend holds once it has applied the delta. The caller fills `created`, `calc_needed`
    /// and `label`.
    ///
    /// A region is compared by the pointer of its `Arc`: the session hands back the very region it
    /// built before for a region an edit left alone. A result entry is compared as a value.
    /// Neither is serialized to find out whether it changed.
    fn advance(mut self, view: &DocumentView, regions: &[RegionEntry]) -> (EditResult, SentState) {
        let mut delta = EditResult {
            base: self.revision,
            revision: self.revision + 1,
            regions: Vec::new(),
            removed: Vec::new(),
            order: None,
            document: None,
            page: None,
            settings: None,
            page_breaks: None,
            can_undo: view.can_undo,
            can_redo: view.can_redo,
            undo_label: view.undo_label.clone(),
            redo_label: view.redo_label.clone(),
            trusted: view.trusted,
            results: Vec::new(),
            removed_results: Vec::new(),
            results_order: None,
            created: None,
            calc_needed: false,
            label: None,
            diagnostics: None,
            environment: None,
        };
        let document = serde_json::to_string(&view.document).expect("the document id serializes");
        if document != self.document {
            delta.document = Some(view.document.clone());
            self.document = document;
        }
        let page = serde_json::to_string(&view.page).expect("the page setup serializes");
        if page != self.page {
            delta.page = Some(view.page.clone());
            self.page = page;
        }
        let settings = serde_json::to_string(&view.settings).expect("the settings serialize");
        if settings != self.settings {
            delta.settings = Some(view.settings.clone());
            self.settings = settings;
        }
        let page_breaks =
            serde_json::to_string(&view.page_breaks).expect("the page breaks serialize");
        if page_breaks != self.page_breaks {
            delta.page_breaks = Some(view.page_breaks.clone());
            self.page_breaks = page_breaks;
        }
        // Regions: an unchanged one keeps the very `Arc` the baseline holds, and goes on the wire
        // only when it is new or rebuilt. The same order as the baseline sends no order at all.
        let mut kept: HashMap<usize, SentRegion> = HashMap::with_capacity(view.regions.len());
        let same_order = self.region_order.len() == view.regions.len()
            && self
                .region_order
                .iter()
                .zip(view.regions.iter())
                .all(|(id, region)| *id == region.id);
        for region in &view.regions {
            let address = Arc::as_ptr(region) as usize;
            let unchanged = self
                .regions
                .get(&address)
                .is_some_and(|before| Arc::ptr_eq(&before.view, region));
            if !unchanged {
                delta.regions.push(region.as_ref().clone());
            }
            kept.insert(
                address,
                SentRegion {
                    view: Arc::clone(region),
                },
            );
        }
        // A region is gone only when its id is: a region an edit rebuilt is a new pointer, and
        // that is a change, not a removal. The ids are the same in the same order when nothing
        // was added, removed or moved, which is the case for almost every edit.
        if !same_order {
            let present: HashSet<&str> = view
                .regions
                .iter()
                .map(|region| region.id.as_str())
                .collect();
            delta.removed = self
                .regions
                .values()
                .filter(|before| !present.contains(before.view.id.as_str()))
                .map(|before| before.view.id.clone())
                .collect();
            let order: Vec<String> = view
                .regions
                .iter()
                .map(|region| region.id.clone())
                .collect();
            delta.order = Some(order.clone());
            self.region_order = order;
        }
        self.regions = kept;

        self.revision = delta.revision;

        // Result entries, by key: an unchanged one is compared as a value instead of being
        // serialized to compare the text.
        let mut kept: HashMap<RegionKey, SentResult> = HashMap::with_capacity(regions.len());
        let same_order = self.result_order.len() == regions.len()
            && self
                .result_order
                .iter()
                .zip(regions.iter())
                .all(|(key, entry)| *key == entry.key);
        for entry in regions {
            match self.results.remove(&entry.key) {
                Some(before) if before.entry == *entry => {
                    kept.insert(entry.key.clone(), before);
                }
                _ => {
                    delta.results.push(entry.clone());
                    kept.insert(
                        entry.key.clone(),
                        SentResult {
                            entry: entry.clone(),
                        },
                    );
                }
            }
        }
        if !same_order {
            let present: HashSet<&RegionKey> = regions.iter().map(|entry| &entry.key).collect();
            delta.removed_results = self
                .results
                .keys()
                .filter(|key| !present.contains(key))
                .map(entry_id)
                .collect();
            delta.results_order = Some(regions.iter().map(|entry| entry_id(&entry.key)).collect());
            self.result_order = regions.iter().map(|entry| entry.key.clone()).collect();
        }
        self.results = kept;
        (delta, self)
    }
}

struct OpenWorksheet {
    /// The root document (fixed for the life of the session; Save As starts a new one).
    root: DocumentId,
    /// The key of the kernel of the worksheet's environment.
    kernel_key: Mutex<PathBuf>,
    session: Mutex<WorksheetSession>,
    results: ResultsHandle,
    /// Interrupts the worksheet's pass on the kernel it runs on (it changes with the environment).
    interrupt: Mutex<InterruptHandle>,
    /// Whether a calculation thread is running. The pass does not hold the session.
    running: AtomicBool,
    /// A calculation was asked for while one was running: the thread runs another pass
    /// (`rerun_all` for Ctrl+F5) instead of refusing the request.
    rerun: AtomicBool,
    rerun_all: AtomicBool,
    /// What the frontend was last sent (locked after the session, never before it).
    sent: Mutex<SentState>,
    /// The diagnostics the frontend was last sent (opened or in an edit result).
    sent_diagnostics: Mutex<Vec<SessionDiagnostic>>,
    /// Set when the worksheet was opened from a portable `.eqvz` document.
    archive: Option<ArchiveDocument>,
}

/// What a worksheet opened from a portable `.eqvz` document keeps.
#[derive(Debug, Clone)]
struct ArchiveDocument {
    document_id: String,
    /// The folder its environment was materialized in.
    environment: PathBuf,
}

/// Whether `path` names a portable `.eqvz` document rather than a `.eqv` worksheet.
fn is_document_archive(path: &Path) -> bool {
    crate::project_archive_files::has_eqvz_extension(path)
}

/// The path of the first include region, which a portable document cannot carry.
fn first_include(document: &ProjectDocument) -> Option<&str> {
    document
        .regions
        .iter()
        .find_map(|region| match region.as_ref() {
            DocumentRegion::Include(include) => Some(include.path.as_str()),
            _ => None,
        })
}

/// The bytes of the portable document `target` holding `document` and the environment files of
/// `environment`: assets embedded, no `environment:` key, no includes.
fn document_archive_bytes(
    document: &ProjectDocument,
    environment: &Path,
    document_id: String,
    target: &Path,
) -> Result<Vec<u8>, CommandError> {
    if let Some(path) = first_include(document) {
        return Err(CommandError::new(
            "save",
            format!("a portable document cannot contain include regions: `{path}` would not travel with it"),
        ));
    }
    let mut document = document.clone();
    embed_assets_leaving_project(&mut document, target)?;
    document.environment = None;
    let worksheet = write_document(&document)?;
    let environment = read_environment(environment)
        .map_err(|error| CommandError::new("save", error.to_string()))?;
    encode_document(&DocumentArchive {
        document_id,
        worksheet,
        environment,
    })
    .map_err(|error| CommandError::new("save", error.to_string()))
}

/// `<dir>/.<name>.recovery` for the worksheet file `<dir>/<name>`.
fn recovery_file_for(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.recovery"))
}

fn slash_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    // Match document IDs, including canonical Windows drive and UNC paths.
    DocumentId::new(&text).map_or_else(|_| text.replace('\\', "/"), |id| id.to_string())
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/')
}

/// `.eqv` is the extension of saved worksheets: appended when the name has none.
fn with_default_extension(path: &Path) -> PathBuf {
    if path.extension().is_some() {
        path.to_path_buf()
    } else {
        let mut name = path.as_os_str().to_owned();
        name.push(".eqv");
        PathBuf::from(name)
    }
}

/// The include path to write when a worksheet moves from `old_root` to `new_root`: the same
/// target file, as a path relative to the new directory (or absolute when it was absolute or on
/// another drive).
fn rebase_include(old_root: &DocumentId, new_root: &DocumentId, path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if is_absolute_path(&normalized) {
        return path.to_owned();
    }
    let Ok(target) = old_root.resolve(path) else {
        return path.to_owned();
    };
    let new_dir = new_root
        .as_str()
        .rsplit_once('/')
        .map_or("", |(dir, _)| dir)
        .to_owned();
    relative_path(&new_dir, target.as_str()).unwrap_or_else(|| target.to_string())
}

/// `target` relative to the directory `from_dir` (both normalised, forward slashes), or `None`
/// when they have no common root (another drive).
fn relative_path(from_dir: &str, target: &str) -> Option<String> {
    let from: Vec<&str> = from_dir.split('/').collect();
    let to: Vec<&str> = target.split('/').collect();
    if from.first() != to.first() {
        return None;
    }
    let common = from
        .iter()
        .zip(&to[..to.len() - 1])
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    Some(parts.join("/"))
}

/// Hands the memory glibc keeps after freeing back to the system. A pass and the edits
/// before it allocate and free a lot (the old and the new analysis, the result events); glibc keeps
/// the freed pages, so a 20 000 region worksheet stayed near its high-water mark (about 380 MB
/// resident for about 130 MB live). Called on the calculation thread once a pass is over.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn release_free_memory() {
    extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // SAFETY: malloc_trim only returns free pages of the allocator to the system.
    unsafe {
        malloc_trim(0);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn release_free_memory() {}

/// The kernel of a REPL request, its environment directory and the packages its module uses.
type ReplTarget = (Arc<KernelManager>, Option<String>, Vec<String>);

/// One region of a Replace All (`replace_regions`): its new math (a statement) or its new text value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionRewrite {
    pub region_id: String,
    #[serde(default)]
    pub statement: Option<Value>,
    #[serde(default)]
    pub paragraphs: Option<Value>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The per-user list of trusted worksheets: absolute paths.
#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustFile {
    trusted: Vec<String>,
    /// Referenced projects whose Julia code this user trusts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    references: Vec<TrustedReference>,
}

/// Whether a provider's alias chain is `alias` or one of the projects `alias` uses.
fn in_chain(chain: &str, alias: &str) -> bool {
    chain == alias
        || chain
            .strip_prefix(alias)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// A provider's identity and the hash of its Julia code when it was trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TrustedReference {
    project_id: String,
    julia_hash: String,
}

/// What the project's exports and references are now.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectReferences {
    pub exports: Vec<ExportInfo>,
    pub references: Vec<ReferenceInfo>,
}

/// One export of the project: broken when its region is gone or no longer exportable.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportInfo {
    pub id: String,
    pub worksheet: Option<String>,
    pub region: String,
    pub api: Option<ApiEntry>,
}

/// One reference of the project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferenceInfo {
    pub alias: String,
    pub path: String,
    pub project_id: String,
    /// The provider's name and folder, when it was found.
    pub name: Option<String>,
    pub root: Option<String>,
    /// The locked API and the provider's current one.
    pub api: Vec<ApiEntry>,
    pub current: Vec<ApiEntry>,
    pub problem: Option<String>,
    pub out_of_date: bool,
    /// Whether this user trusts the provider's current Julia code.
    pub trusted: bool,
    /// The provider's Julia package, and whether the consumer's environment has it.
    pub package: Option<String>,
    pub developed: bool,
}

/// A reference or export command's result: the manifest, and what changed in each open
/// worksheet of the project.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReferencesChange {
    pub manifest: ProjectManifest,
    pub worksheets: Vec<WorksheetEdit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorksheetEdit {
    pub id: String,
    pub delta: EditResult,
}

/// The `environment:` value for `directory`: relative to the worksheet's folder, with `/`,
/// when the directory lies under it; absolute otherwise.
fn stored_environment(worksheet: &Path, directory: &Path) -> Result<String, CommandError> {
    let directory = std::fs::canonicalize(directory).map_err(|error| {
        CommandError::new("environment", format!("{}: {error}", directory.display()))
    })?;
    if !directory.is_dir() {
        return Err(CommandError::new(
            "environment",
            format!("{} is not a directory", directory.display()),
        ));
    }
    let folder = worksheet
        .parent()
        .and_then(|folder| std::fs::canonicalize(folder).ok());
    if let Some(relative) =
        folder.and_then(|folder| directory.strip_prefix(folder).ok().map(Path::to_path_buf))
    {
        let text = slash_path(&relative);
        return Ok(if text.is_empty() { ".".into() } else { text });
    }
    Ok(directory.to_string_lossy().into_owned())
}

/// The kernel process of one Julia environment and its last status.
struct EnvironmentKernel {
    manager: Arc<KernelManager>,
    status: KernelStatus,
}

/// The key of the kernel that serves an environment directory: the canonical form of the folder
/// (of its nearest existing ancestor plus the rest when the folder is not created yet, as the
/// shared one is on demand). The key must not change when the folder appears: on Windows
/// `canonicalize` gives a `\\?\` path for an existing folder, so a key that fell back to the path
/// as given before that made the REPL reach a second kernel without the worksheets.
fn kernel_key(directory: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut base = directory;
    loop {
        if let Ok(canonical) = std::fs::canonicalize(base) {
            return rest
                .iter()
                .rev()
                .fold(canonical, |path, part| path.join(part));
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name);
                base = parent;
            }
            _ => return directory.to_path_buf(),
        }
    }
}

pub struct Service {
    sink: EventSink,
    inputs: LocationInputs,
    /// The kernel configuration, resolved once (`Err`: why no kernel can start).
    kernel_config: Mutex<Option<Result<KernelConfig, String>>>,
    /// One kernel per Julia environment in use, by kernel key.
    kernels: Mutex<HashMap<PathBuf, EnvironmentKernel>>,
    worksheets: Mutex<HashMap<String, Arc<OpenWorksheet>>>,
    next_id: AtomicU64,
    switch_plans: Mutex<HashMap<String, EnvironmentSwitchPlan>>,
    /// Where recovery files of worksheets without a file live; none: no recovery for them.
    recovery_dir: Mutex<Option<PathBuf>>,
    environments: Mutex<Option<EnvironmentPaths>>,
    /// The file that lists the worksheets this user trusts;
    /// none in tests that set no configuration directory, so nothing is remembered.
    trust_file: Mutex<Option<PathBuf>>,
    /// Makes the recovery file names of this run unique: `Untitled-1.eqv` of an earlier run must not
    /// be overwritten by the one of this run before it has been offered.
    run_tag: String,
}

struct EnvironmentPaths {
    root: PathBuf,
    shared: PathBuf,
}

impl EnvironmentPaths {
    fn new(root: PathBuf) -> Self {
        let legacy = root.join("standalone");
        // Keep existing files and path-keyed recovery snapshots reachable after an upgrade.
        let keep_legacy = match std::fs::read_dir(&legacy) {
            Ok(mut entries) => entries.next().is_some(),
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        } || SnapshotStore::new(root.join(".snapshots"))
            .folder(&legacy)
            .exists();
        let shared = if keep_legacy {
            legacy
        } else {
            root.join("DefaultEnv")
        };
        Self { root, shared }
    }
}

impl Service {
    pub fn new(sink: EventSink, inputs: LocationInputs) -> Arc<Service> {
        let environments = inputs
            .data_dir
            .as_ref()
            .map(|dir| EnvironmentPaths::new(dir.join("equavela").join("environments")));
        Arc::new(Service {
            sink,
            inputs,
            kernel_config: Mutex::new(None),
            kernels: Mutex::new(HashMap::new()),
            worksheets: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            switch_plans: Mutex::new(HashMap::new()),
            recovery_dir: Mutex::new(None),
            environments: Mutex::new(environments),
            trust_file: Mutex::new(None),
            run_tag: format!(
                "{}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                std::process::id()
            ),
        })
    }

    // ---- kernel -----------------------------------------------------------------------

    /// The kernel of an environment (created on first use, nothing is spawned yet) and the
    /// reason no kernel can be started, if its files were not found.
    fn kernel_for(&self, key: &Path) -> (Arc<KernelManager>, Option<String>) {
        let config = lock(&self.kernel_config)
            .get_or_insert_with(|| resolve_kernel_config(&self.inputs))
            .clone();
        let error = config.as_ref().err().cloned();
        let config = config.map(|mut config| {
            config.crash_report_dir = crate::crash_reports::directory();
            if config.terminal && !key.as_os_str().is_empty() {
                config.env.push((
                    "EQUAVELA_TERMINAL_ENVIRONMENT".into(),
                    key.as_os_str().to_owned(),
                ));
            }
            config
        });
        let mut kernels = lock(&self.kernels);
        let kernel = kernels
            .entry(key.to_path_buf())
            .or_insert_with(|| EnvironmentKernel {
                // A manager that can never start: starting it reports the spawn error.
                manager: Arc::new(KernelManager::new(
                    config.unwrap_or_else(|_| KernelConfig::new(PathBuf::from("kernel-not-found"))),
                )),
                status: KernelStatus::NotStarted,
            });
        (Arc::clone(&kernel.manager), error)
    }

    /// The key of the kernel of the shared environment.
    fn shared_kernel_key(&self) -> PathBuf {
        self.shared_environment()
            .map(|directory| kernel_key(&directory))
            .unwrap_or_default()
    }

    /// The status of the shared environment's kernel.
    pub fn kernel_status(&self) -> KernelStatus {
        self.kernel_status_of(&self.shared_kernel_key())
    }

    fn kernel_status_of(&self, key: &Path) -> KernelStatus {
        lock(&self.kernels)
            .get(key)
            .map(|kernel| kernel.status.clone())
            .unwrap_or(KernelStatus::NotStarted)
    }

    /// Records and announces the status of one kernel: the event names its environment
    /// (`environment`, the kernel key) so the frontend shows the active worksheet's.
    fn set_status(&self, key: &Path, status: KernelStatus) {
        if let Some(kernel) = lock(&self.kernels).get_mut(key) {
            kernel.status = status.clone();
        }
        let mut payload = serde_json::to_value(&status).expect("status serializes");
        if let Value::Object(map) = &mut payload {
            map.insert("environment".into(), Value::String(slash_path(key)));
        }
        (self.sink)(EVENT_KERNEL_STATUS, payload);
    }

    /// Starts the shared environment's kernel in the background unless it is already running
    /// or starting. Progress arrives as `kernel-status` events.
    pub fn start_kernel(self: &Arc<Self>) {
        self.start_kernel_for(self.shared_kernel_key());
    }

    fn start_kernel_for(self: &Arc<Self>, key: PathBuf) {
        if matches!(
            self.kernel_status_of(&key),
            KernelStatus::Starting | KernelStatus::Ready { .. } | KernelStatus::Busy
        ) {
            return;
        }
        let (manager, error) = self.kernel_for(&key);
        if let Some(message) = error {
            self.set_status(&key, KernelStatus::Crashed { message });
            return;
        }
        self.set_status(&key, KernelStatus::Starting);
        let service = Arc::clone(self);
        std::thread::spawn(move || match manager.start() {
            Ok(info) => {
                // A pass may have started meanwhile; do not hide `busy`.
                let busy = matches!(service.kernel_status_of(&key), KernelStatus::Busy);
                if !busy {
                    service.set_status(&key, KernelStatus::Ready { info });
                }
            }
            Err(error) => service.set_status(
                &key,
                KernelStatus::Crashed {
                    message: error.to_string(),
                },
            ),
        });
    }

    /// Stops every kernel and every running calculation (application exit).
    pub fn shutdown(&self) {
        let worksheets: Vec<_> = lock(&self.worksheets).values().cloned().collect();
        for worksheet in worksheets {
            lock(&worksheet.interrupt).interrupt();
        }
        let managers: Vec<_> = lock(&self.kernels)
            .values()
            .map(|kernel| Arc::clone(&kernel.manager))
            .collect();
        for manager in managers {
            manager.shutdown();
        }
    }

    /// The environment of a worksheet about to open and the key of its kernel.
    fn environment_of(
        &self,
        project: &Project,
        root: &DocumentId,
        archive: Option<&Path>,
    ) -> WorksheetEnvironment {
        let shared = self.shared_environment().unwrap_or_default();
        let declared = project
            .document(root)
            .and_then(|document| document.environment.as_deref());
        resolve_environment_with_archive(root, declared, &shared, archive)
    }

    // ---- worksheets -------------------------------------------------------------------

    /// Creates a folder project with one empty main worksheet and opens it.
    pub fn new_project(
        self: &Arc<Self>,
        destination: &Path,
        name: &str,
        project_id: &str,
        worksheet_id: &str,
    ) -> Result<OpenedProject, CommandError> {
        if !destination.is_absolute() {
            return Err(CommandError::new(
                "save",
                "the project destination must be an absolute path",
            ));
        }
        let path = "worksheets/main.eqv";
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.into(),
            project_id: project_id.into(),
            name: name.into(),
            worksheets: vec![WorksheetEntry {
                id: worksheet_id.into(),
                path: path.into(),
            }],
            main_worksheet: None,
            environment: Some("julia".into()),
            exports: Vec::new(),
            references: Vec::new(),
            julia_modules: Vec::new(),
        };
        let document = ProjectDocument {
            id: DocumentId::new(path).map_err(|error| CommandError::internal(error.to_string()))?,
            content_hash: "new".into(),
            settings: Default::default(),
            environment: None,
            page: Default::default(),
            result_formats: Default::default(),
            math_breaks: Default::default(),
            resources: Default::default(),
            assets: Default::default(),
            page_breaks: Vec::new(),
            regions: Vec::new(),
        };
        let worksheets = BTreeMap::from([(worksheet_id.to_owned(), write_document(&document)?)]);
        {
            // the environment names the project as a Julia package with its own module.
            let files = project_tree::project_environment_files(name, None)
                .map_err(|error| CommandError::new("save", error))?;
            let _guard = lock(&PROJECT_CREATION);
            create_project_with_files(destination, &manifest, &worksheets, &files)
                .map_err(|error| CommandError::new("save", error.to_string()))?;
        }
        self.open_project(destination)
    }

    /// Convert to project: the standalone worksheet `id`, with its unsaved edits, becomes
    /// the main worksheet of a new folder project that carries its environment files. The project
    /// opens and replaces the worksheet's session; the worksheet's own file is left unchanged.
    pub fn convert_to_project(
        self: &Arc<Self>,
        id: &str,
        destination: &Path,
        name: &str,
        project_id: &str,
        worksheet_id: &str,
    ) -> Result<OpenedProject, CommandError> {
        if !destination.is_absolute() {
            return Err(CommandError::new(
                "save",
                "the project destination must be an absolute path",
            ));
        }
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let (text, files, trusted) = {
            let session = lock(&worksheet.session);
            let environment = session.environment();
            if environment.kind == EnvironmentKind::Project {
                return Err(CommandError::new(
                    "save",
                    "the worksheet already belongs to a project",
                ));
            }
            let root = session.root().clone();
            let mut document = session
                .project()
                .document(&root)
                .expect("the root document is loaded")
                .clone();
            if let Some(path) = first_include(&document) {
                return Err(CommandError::new(
                    "save",
                    format!("a worksheet with include regions cannot become a project: `{path}` would not resolve from the new folder"),
                ));
            }
            document.environment = None;
            let carried = read_environment(&environment.directory)
                .map_err(|error| CommandError::new("save", error.to_string()))?;
            // a project environment as New project makes it, keeping the deps of
            // the worksheet's environment, so the explorer and the REPL see it at once.
            let mut files =
                project_tree::project_environment_files(name, carried.project.as_deref())
                    .map_err(|error| CommandError::new("save", error))?;
            if let Some(bytes) = carried.manifest {
                files.insert("julia/Manifest.toml".to_owned(), bytes);
            }
            (write_document(&document)?, files, session.is_trusted())
        };
        let stem = if is_absolute_path(worksheet.root.as_str()) {
            Path::new(worksheet.root.as_str())
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let path = format!("worksheets/{}.eqv", portable_file_stem(&stem, "main"));
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.into(),
            project_id: project_id.into(),
            name: name.into(),
            worksheets: vec![WorksheetEntry {
                id: worksheet_id.into(),
                path: path.clone(),
            }],
            main_worksheet: None,
            environment: Some("julia".into()),
            exports: Vec::new(),
            references: Vec::new(),
            julia_modules: Vec::new(),
        };
        let worksheets = BTreeMap::from([(worksheet_id.to_owned(), text)]);
        {
            let _guard = lock(&PROJECT_CREATION);
            create_project_with_files(destination, &manifest, &worksheets, &files)
                .map_err(|error| CommandError::new("save", error.to_string()))?;
        }
        if trusted {
            let file =
                equavela_core::worksheet_file::document_id_for_path(&destination.join(&path))?;
            self.remember_trust(file.as_str(), true);
        }
        // the converted worksheet takes the old tab's place in front.
        let mut opened = self.open_project(destination)?;
        opened.worksheet = Some(self.open_worksheet(&destination.join(&path))?);
        let _ = self.close_worksheet(id);
        Ok(opened)
    }

    // ---- the project tree ----------------------

    fn project_error(error: String) -> CommandError {
        CommandError::new("project", error)
    }

    fn canonical_project(root: &Path) -> Result<PathBuf, CommandError> {
        if !root.is_absolute() {
            return Err(CommandError::new(
                "project",
                "the project directory must be an absolute path",
            ));
        }
        crate::project_trash::recover(root).map_err(Self::project_error)?;
        project_tree::check_project(root).map_err(Self::project_error)
    }

    /// The open sessions of the worksheet file `file`, with whether each is trusted.
    fn sessions_of(&self, file: &Path) -> Result<Vec<(String, bool)>, CommandError> {
        let id = equavela_core::worksheet_file::document_id_for_path(file)?;
        Ok(lock(&self.worksheets)
            .iter()
            .filter(|(_, worksheet)| worksheet.root == id)
            .map(|(id, worksheet)| (id.clone(), lock(&worksheet.session).is_trusted()))
            .collect())
    }

    /// Closes every open session of the file `from` and opens `to` in its place, keeping trust.
    /// The caller has checked that none of them has unsaved changes.
    fn reopen_sessions(
        self: &Arc<Self>,
        from: &Path,
        to: &Path,
    ) -> Result<Vec<ReplacedWorksheet>, CommandError> {
        let mut replaced = Vec::new();
        for (id, trusted) in self.sessions_of(from)? {
            if trusted {
                let to_id = equavela_core::worksheet_file::document_id_for_path(to)?;
                self.remember_trust(to_id.as_str(), true);
            }
            let _ = self.close_worksheet(&id);
            replaced.push(ReplacedWorksheet {
                id,
                opened: self.open_worksheet(to)?,
            });
        }
        Ok(replaced)
    }

    /// The tree and the manifest after a change, with the manifest brought in step.
    fn project_change(
        root: &Path,
        moved: &BTreeMap<String, String>,
    ) -> Result<ProjectChange, CommandError> {
        let synced = project_tree::sync_manifest(root, moved).map_err(Self::project_error)?;
        Ok(ProjectChange {
            manifest: synced.manifest,
            entries: project_tree::list_tree(root).map_err(Self::project_error)?,
            opened: None,
            replaced: Vec::new(),
            closed: Vec::new(),
        })
    }

    /// the tree of the project and its manifest, brought in step with the tree.
    pub fn project_tree(&self, root: &Path) -> Result<ProjectChange, CommandError> {
        if !root.is_absolute() {
            return Err(CommandError::new(
                "project",
                "the project directory must be an absolute path",
            ));
        }
        let root = std::fs::canonicalize(root).map_err(|error| {
            CommandError::new("project", format!("{}: {error}", root.display()))
        })?;
        let _guard = project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        crate::project_trash::recover(&root).map_err(Self::project_error)?;
        Self::project_change(&root, &BTreeMap::new())
    }

    /// a new worksheet (`kind` `worksheet`, opened), Julia file (`julia`) or folder
    /// (`folder`) named after `name` in `folder` (`""`: the root).
    pub fn project_create(
        self: &Arc<Self>,
        root: &Path,
        folder: &str,
        name: &str,
        kind: &str,
    ) -> Result<ProjectChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let empty_worksheet;
        let julia_file;
        let item = match kind {
            "worksheet" => {
                empty_worksheet = write_document(&ProjectDocument {
                    id: DocumentId::new("new.eqv")
                        .map_err(|error| CommandError::internal(error.to_string()))?,
                    content_hash: "new".into(),
                    settings: Default::default(),
                    environment: None,
                    page: Default::default(),
                    result_formats: Default::default(),
                    math_breaks: Default::default(),
                    resources: Default::default(),
                    assets: Default::default(),
                    page_breaks: Vec::new(),
                    regions: Vec::new(),
                })?;
                NewItem::Worksheet(&empty_worksheet)
            }
            "julia" => {
                let (_, manifest) = Self::project_manifest(&root)?;
                julia_file = format!(
                    "# Julia code of the project. Julia blocks use it with `using {}`.\n",
                    project_tree::julia_module_name(&manifest.name)
                );
                NewItem::Julia(&julia_file)
            }
            "folder" => NewItem::Folder,
            _ => {
                return Err(CommandError::new(
                    "project",
                    format!("unknown item kind `{kind}`"),
                ))
            }
        };
        let path =
            project_tree::create_item(&root, folder, name, item).map_err(Self::project_error)?;
        let mut change = Self::project_change(&root, &BTreeMap::new())?;
        if kind == "worksheet" {
            change.opened = Some(self.open_worksheet(&root.join(&path))?);
        }
        Ok(change)
    }

    fn project_manifest(root: &Path) -> Result<(PathBuf, ProjectManifest), CommandError> {
        let loaded = load_project_directory(root)
            .map_err(|error| CommandError::new("project", error.to_string()))?;
        Ok((loaded.root, loaded.manifest))
    }

    /// Reopens the open tabs of the worksheets a rename or move relocated.
    fn relocated(
        self: &Arc<Self>,
        root: &Path,
        moved: &BTreeMap<String, String>,
    ) -> Result<ProjectChange, CommandError> {
        let mut change = Self::project_change(root, moved)?;
        for (from, to) in moved {
            change
                .replaced
                .extend(self.reopen_sessions(&root.join(from), &root.join(to))?);
        }
        Ok(change)
    }

    /// renames `path` in its folder to `name` (a whole file name).
    pub fn project_rename(
        self: &Arc<Self>,
        root: &Path,
        path: &str,
        name: &str,
    ) -> Result<ProjectChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let plan =
            project_tree::plan_rename_item(&root, path, name).map_err(Self::project_error)?;
        let mut moved =
            self.relocation_owners(&root, &plan.destinations, &plan.affected_worksheets)?;
        self.check_saved_owners(&root, &moved)?;
        moved.extend(project_tree::execute_relocation(plan).map_err(Self::project_error)?);
        self.relocated(&root, &moved)
    }

    /// moves `path` into `folder` (`""`: the root).
    pub fn project_move(
        self: &Arc<Self>,
        root: &Path,
        path: &str,
        folder: &str,
    ) -> Result<ProjectChange, CommandError> {
        self.project_move_many(root, &[path.to_owned()], folder)
    }

    pub fn project_move_many(
        self: &Arc<Self>,
        root: &Path,
        paths: &[String],
        folder: &str,
    ) -> Result<ProjectChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let plan =
            project_tree::plan_move_items(&root, paths, folder).map_err(Self::project_error)?;
        let mut moved =
            self.relocation_owners(&root, &plan.destinations, &plan.affected_worksheets)?;
        self.check_saved_owners(&root, &moved)?;
        moved.extend(project_tree::execute_relocation(plan).map_err(Self::project_error)?);
        self.relocated(&root, &moved)
    }

    fn relocation_owners(
        &self,
        root: &Path,
        destinations: &BTreeMap<String, String>,
        planned: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, String>, CommandError> {
        let mut affected = planned.clone();
        let within = |path: &str, from: &str| {
            let (path, from) = if cfg!(windows) {
                (path.to_ascii_lowercase(), from.to_ascii_lowercase())
            } else {
                (path.to_owned(), from.to_owned())
            };
            path == from || path.starts_with(&format!("{from}/"))
        };
        let mapped = |path: &str| {
            destinations
                .iter()
                .find(|(from, _)| within(path, from))
                .map_or_else(
                    || path.to_owned(),
                    |(from, to)| format!("{to}{}", &path[from.len()..]),
                )
        };
        for image in self.project_image_usage(root)? {
            if destinations
                .iter()
                .any(|(from, to)| from != to && within(&image.path, from))
            {
                for owner in image.worksheets {
                    affected
                        .entry(owner.clone())
                        .or_insert_with(|| mapped(&owner));
                }
            }
        }
        Ok(affected)
    }

    fn check_saved_owners(
        &self,
        root: &Path,
        affected: &BTreeMap<String, String>,
    ) -> Result<(), CommandError> {
        for path in affected.keys() {
            let full = root.join(path);
            let text =
                std::fs::read_to_string(&full).map_err(|e| Self::project_error(e.to_string()))?;
            let parsed = parse_document(
                DocumentId::new(path).map_err(|e| Self::project_error(e.to_string()))?,
                &text,
            )?;
            let saved = write_document(&parsed.document)?;
            for (id, _) in self.sessions_of(&full)? {
                let worksheet = self.worksheet(&id)?;
                let session = lock(&worksheet.session);
                let document = session
                    .project()
                    .document(&worksheet.root)
                    .ok_or_else(|| Self::project_error("worksheet is unavailable".into()))?;
                if write_document(document)? != saved {
                    return Err(Self::project_error(format!(
                        "save worksheet `{path}` before changing its files or image references"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Inspect both saved worksheets and their open sessions without evaluating them.
    pub fn project_image_usage(&self, root: &Path) -> Result<Vec<ProjectImageUsage>, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let (_, manifest) = Self::project_manifest(&root)?;
        let entries = project_tree::list_tree(&root).map_err(Self::project_error)?;
        let mut usage: BTreeMap<String, (BTreeSet<String>, Option<String>)> = BTreeMap::new();
        let in_environment = |path: &str| {
            manifest.environment.as_deref().is_some_and(|env| {
                path == env
                    || path
                        .strip_prefix(env)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            })
        };
        for entry in &entries {
            if entry.kind != project_tree::EntryKind::Image
                || !entry.path.starts_with("assets/")
                || in_environment(&entry.path)
            {
                continue;
            }
            let extension = entry
                .path
                .rsplit('.')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            let media = match extension.as_str() {
                "png" => ImageMedia::Png,
                "jpg" | "jpeg" => ImageMedia::Jpeg,
                "svg" => ImageMedia::Svg,
                _ => continue,
            };
            let asset = AssetReference {
                path: entry.path.clone(),
                media,
            };
            usage.insert(
                entry.path.clone(),
                (BTreeSet::new(), check_asset(&root, &asset).err()),
            );
        }
        let mut collect = |document: &ProjectDocument, sheet: &str| {
            for region in &document.regions {
                if let DocumentRegion::Image(image) = region.as_ref() {
                    if let Some(asset) = document.assets.get(&image.resource) {
                        let entry = usage.entry(asset.path.clone()).or_default();
                        entry.0.insert(sheet.to_owned());
                        if let Err(error) = check_asset(&root, asset) {
                            entry.1 = Some(error);
                        }
                    }
                }
            }
        };
        for sheet in entries.iter().filter(|entry| {
            entry.kind == project_tree::EntryKind::Worksheet && !in_environment(&entry.path)
        }) {
            let file = root.join(&sheet.path);
            let text = std::fs::read_to_string(&file)
                .map_err(|error| Self::project_error(format!("{}: {error}", file.display())))?;
            let id = DocumentId::new(&sheet.path)
                .map_err(|error| Self::project_error(error.to_string()))?;
            let parsed = parse_document(id, &text)
                .map_err(|error| Self::project_error(format!("`{}`: {error}", sheet.path)))?;
            collect(&parsed.document, &sheet.path);
            for (id, _) in self.sessions_of(&file)? {
                let worksheet = self.worksheet(&id)?;
                let session = lock(&worksheet.session);
                let document = session.project().document(&worksheet.root).ok_or_else(|| {
                    Self::project_error(format!("cannot inspect worksheet `{}`", sheet.path))
                })?;
                collect(document, &sheet.path);
            }
        }
        Ok(usage
            .into_iter()
            .map(|(path, (worksheets, problem))| ProjectImageUsage {
                path,
                worksheets: worksheets.into_iter().collect(),
                problem,
            })
            .collect())
    }

    /// Refuse deleting project assets still named by a surviving worksheet, including unsaved
    /// references in open sessions. Parse every declared worksheet so an unreadable one cannot
    /// silently hide a reference.
    fn check_project_asset_deletion(
        &self,
        root: &Path,
        manifest: &ProjectManifest,
        paths: &[String],
    ) -> Result<(), CommandError> {
        let targets: Vec<_> = paths
            .iter()
            .map(|path| {
                if cfg!(windows) {
                    path.to_lowercase()
                } else {
                    path.to_owned()
                }
            })
            .collect();
        let within = |candidate: &str| {
            let candidate = if cfg!(windows) {
                candidate.to_lowercase()
            } else {
                candidate.to_owned()
            };
            targets.iter().any(|target| {
                candidate == *target
                    || candidate
                        .strip_prefix(target)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            })
        };
        let check = |document: &ProjectDocument, sheet: &str| -> Result<(), CommandError> {
            for region in &document.regions {
                let DocumentRegion::Image(image) = region.as_ref() else {
                    continue;
                };
                let Some(asset) = document.assets.get(&image.resource) else {
                    continue;
                };
                equavela_core::image::validate_asset(asset).map_err(Self::project_error)?;
                if within(&asset.path) {
                    return Err(Self::project_error(format!(
                        "`{sheet}` references asset `{}`: remove the reference and save the worksheet before deleting it",
                        asset.path
                    )));
                }
            }
            Ok(())
        };
        let sheets = project_tree::list_tree(root).map_err(Self::project_error)?;
        for sheet in sheets.iter().filter(|entry| {
            entry.kind == project_tree::EntryKind::Worksheet
                && !manifest.environment.as_deref().is_some_and(|env| {
                    entry.path == env
                        || entry
                            .path
                            .strip_prefix(env)
                            .is_some_and(|suffix| suffix.starts_with('/'))
                })
        }) {
            if within(&sheet.path) {
                continue;
            }
            let file = root.join(&sheet.path);
            let text = std::fs::read_to_string(&file)
                .map_err(|error| Self::project_error(format!("{}: {error}", file.display())))?;
            let id = DocumentId::new(&sheet.path)
                .map_err(|error| Self::project_error(error.to_string()))?;
            let parsed = parse_document(id, &text)
                .map_err(|error| Self::project_error(format!("`{}`: {error}", sheet.path)))?;
            check(&parsed.document, &sheet.path)?;
            for (id, _) in self.sessions_of(&file)? {
                let worksheet = self.worksheet(&id)?;
                let session = lock(&worksheet.session);
                let document = session.project().document(&worksheet.root).ok_or_else(|| {
                    Self::project_error(format!("cannot inspect worksheet `{}`", sheet.path))
                })?;
                check(document, &sheet.path)?;
            }
        }
        Ok(())
    }

    /// moves `path` to the system trash, closing the open tabs of its worksheets. Never a
    /// permanent delete: without a trash nothing is deleted.
    pub fn project_delete(&self, root: &Path, path: &str) -> Result<ProjectChange, CommandError> {
        self.project_delete_many(root, &[path.to_owned()])
    }

    pub fn project_delete_many(
        &self,
        root: &Path,
        paths: &[String],
    ) -> Result<ProjectChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let before = Self::project_change(&root, &BTreeMap::new())?;
        let full = project_tree::check_delete_many(&root, paths).map_err(Self::project_error)?;
        let paths = full
            .iter()
            .map(|path| {
                path.strip_prefix(&root)
                    .map(slash_path)
                    .map_err(|e| Self::project_error(e.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let affected: BTreeMap<_, _> = before
            .manifest
            .worksheets
            .iter()
            .filter(|sheet| {
                paths
                    .iter()
                    .any(|path| sheet.path == *path || sheet.path.starts_with(&format!("{path}/")))
            })
            .map(|sheet| (sheet.path.clone(), sheet.path.clone()))
            .collect();
        self.check_saved_owners(&root, &affected)?;
        self.check_project_asset_deletion(&root, &before.manifest, &paths)?;
        crate::project_trash::delete(&root, &paths).map_err(Self::project_error)?;
        let mut closed = Vec::new();
        for sheet in affected.keys() {
            for (id, _) in self.sessions_of(&root.join(sheet))? {
                let _ = self.close_worksheet(&id);
                closed.push(id);
            }
        }
        let mut change = Self::project_change(&root, &BTreeMap::new())?;
        change.closed = closed;
        Ok(change)
    }

    // ---- project references -----------------------------

    /// The folder project the worksheet file `root` belongs to, if any: the nearest folder
    /// above it with a project manifest. Every `.eqv` of the tree is a worksheet of the project
    ///, declared in the manifest yet or not.
    fn project_of(root: &DocumentId) -> Option<PathBuf> {
        let path = Path::new(root.as_str());
        if !path.is_absolute() {
            return None;
        }
        if let Some(declared) = find_worksheet_project(path) {
            return Some(declared);
        }
        let file = std::fs::canonicalize(path).ok()?;
        file.ancestors()
            .skip(1)
            .find(|folder| project_reference::read_manifest(folder).is_ok())
            .map(Path::to_path_buf)
    }

    /// Reads the references of `project_root` into a session with their trust.
    fn load_session_references(
        &self,
        session: &mut WorksheetSession,
        project_root: &Path,
    ) -> Result<(), CommandError> {
        let manifest =
            project_reference::read_manifest(project_root).map_err(Self::project_error)?;
        let loaded = project_reference::load_references(project_root, &manifest);
        let untrusted = self.untrusted_references(&loaded.references);
        session.set_references(loaded)?;
        session.set_untrusted_references(untrusted);
        session.set_julia_modules(Self::julia_modules(project_root, &manifest));
        Ok(())
    }

    /// The modules a project's worksheets load: the project package's
    /// own file as its package, any other listed file by its absolute path.
    fn julia_modules(project_root: &Path, manifest: &ProjectManifest) -> JuliaModules {
        let package = project_reference::provider_package(project_root, manifest);
        let mut modules = JuliaModules::default();
        for path in &manifest.julia_modules {
            let full = project_root.join(path);
            match &package {
                Some((name, folder)) if full == folder.join("src").join(format!("{name}.jl")) => {
                    modules.packages.push(name.clone());
                }
                _ => modules.files.push(full.to_string_lossy().into_owned()),
            }
        }
        modules
    }

    /// runs REPL code in the kernel of worksheet `id`'s environment, starting the
    /// kernel when needed. The REPL is the user's own code, so it needs no worksheet trust.
    pub fn repl(
        &self,
        project: Option<&str>,
        code: &str,
        reset: bool,
    ) -> Result<equavela_core::kernel_manager::ReplResult, CommandError> {
        let (manager, environment, packages) = self.repl_target(project)?;
        manager
            .repl(environment.as_deref(), &packages, code, reset)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    /// attach the real terminal to the environment's existing kernel.
    pub fn terminal_open(
        &self,
        project: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<equavela_core::kernel_manager::TerminalSnapshot, CommandError> {
        let (manager, environment, packages) = self.repl_target(project)?;
        let modules = if let Some(root) = project {
            let root = Self::canonical_project(Path::new(root))?;
            let manifest = project_reference::read_manifest(&root).map_err(Self::project_error)?;
            Self::julia_modules(&root, &manifest).files
        } else {
            Vec::new()
        };
        manager
            .request(
                "terminal_prepare",
                Some(serde_json::json!({
                    "environment": environment, "packages": packages, "modules": modules,
                })),
            )
            .map_err(|error| CommandError::new("kernel", error.to_string()))?;
        manager
            .terminal_open(cols, rows)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    pub fn terminal_read(
        &self,
        project: Option<&str>,
        after: u64,
    ) -> Result<equavela_core::kernel_manager::TerminalSnapshot, CommandError> {
        let (manager, _, _) = self.repl_target_with_start(project, false)?;
        manager
            .terminal_read(after)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    pub fn terminal_write(&self, project: Option<&str>, data: &str) -> Result<(), CommandError> {
        let (manager, _, _) = self.repl_target_with_start(project, false)?;
        manager
            .terminal_write(data.as_bytes())
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    pub fn terminal_resize(
        &self,
        project: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<(), CommandError> {
        let (manager, _, _) = self.repl_target_with_start(project, false)?;
        manager
            .terminal_resize(cols, rows)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    /// completions of the REPL input `text` at character `position`, in the REPL module of
    /// worksheet `id`'s environment (names defined in the REPL complete too). Like a run, it
    /// starts the kernel when needed.
    pub fn repl_complete(
        &self,
        project: Option<&str>,
        text: &str,
        position: usize,
    ) -> Result<equavela_core::kernel_manager::Completions, CommandError> {
        let (manager, environment, packages) = self.repl_target(project)?;
        manager
            .complete_in_repl(environment.as_deref(), &packages, text, position)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    /// the module names of the worksheets of the kernel `worksheet` runs in. In a project
    /// they come from every worksheet file of the project (flat names, numbered in path order, and
    /// never the name of a `.jl` file or of the project's package); outside one, from the open
    /// worksheets that are not in a project and share the kernel.
    fn module_names_with(&self, worksheet: &OpenWorksheet) -> (String, HashMap<String, String>) {
        let stem = |path: &str| {
            Path::new(path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        if let Some(project) = Self::project_of(&worksheet.root) {
            let entries = project_tree::list_tree(&project).unwrap_or_default();
            let mut taken: Vec<String> = entries
                .iter()
                .filter(|entry| entry.path.to_ascii_lowercase().ends_with(".jl"))
                .map(|entry| stem(&entry.path))
                .collect();
            if let Ok(manifest) = project_reference::read_manifest(&project) {
                if let Some((package, _)) = project_reference::provider_package(&project, &manifest)
                {
                    taken.push(package);
                }
            }
            let sheets: Vec<(String, String)> = entries
                .iter()
                .filter(|entry| matches!(entry.kind, project_tree::EntryKind::Worksheet))
                .map(|entry| (entry.path.clone(), stem(&entry.path)))
                .collect();
            // On Windows one folder has several spellings (an 8.3 short name, another case):
            // the worksheet's path inside the project is taken between canonical paths.
            let canonical = |path: PathBuf| path.canonicalize().unwrap_or(path);
            let own = slash_path(&canonical(path_for_document(&worksheet.root)))
                .strip_prefix(&format!("{}/", slash_path(&canonical(project.clone()))))
                .map(str::to_owned)
                .unwrap_or_else(|| worksheet.root.as_str().to_owned());
            return (own, module_names(&sheets, &taken));
        }
        let key = lock(&worksheet.kernel_key).clone();
        let sheets: Vec<(String, String)> = lock(&self.worksheets)
            .values()
            .filter(|other| {
                Self::project_of(&other.root).is_none() && *lock(&other.kernel_key) == key
            })
            .map(|other| (other.root.as_str().to_owned(), stem(other.root.as_str())))
            .collect();
        (
            worksheet.root.as_str().to_owned(),
            module_names(&sheets, &[]),
        )
    }

    /// The module name of worksheet `worksheet`.
    fn module_name_of(&self, worksheet: &OpenWorksheet) -> String {
        let (own, names) = self.module_names_with(worksheet);
        names.get(&own).cloned().unwrap_or_else(|| {
            module_identifier(
                &Path::new(worksheet.root.as_str())
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            )
        })
    }

    /// the module name of every open worksheet, by worksheet id, for the side panel and
    /// the tooltips.
    pub fn worksheet_module_names(&self) -> HashMap<String, String> {
        let open: Vec<(String, Arc<OpenWorksheet>)> = lock(&self.worksheets)
            .iter()
            .map(|(id, worksheet)| (id.clone(), Arc::clone(worksheet)))
            .collect();
        open.into_iter()
            .map(|(id, worksheet)| (id, self.module_name_of(&worksheet)))
            .collect()
    }

    /// The kernel of worksheet `id` (started when needed), its environment and the package the
    /// REPL module uses.
    fn repl_target(&self, project: Option<&str>) -> Result<ReplTarget, CommandError> {
        self.repl_target_with_start(project, true)
    }

    fn repl_target_with_start(
        &self,
        project: Option<&str>,
        start: bool,
    ) -> Result<ReplTarget, CommandError> {
        // the REPL of the open project's environment, else of the generic environment.
        let (directory, packages) = match project {
            Some(root) => {
                let root = Self::canonical_project(Path::new(root))?;
                let manifest =
                    project_reference::read_manifest(&root).map_err(Self::project_error)?;
                let packages = project_reference::provider_package(&root, &manifest)
                    .map(|(name, _)| vec![name])
                    .unwrap_or_default();
                let directory = match manifest.environment.as_deref() {
                    Some(environment) => Some(root.join(environment)),
                    None => self.shared_environment(),
                };
                (directory, packages)
            }
            None => (self.shared_environment(), Vec::new()),
        };
        // An uninitialized shared folder is no environment to load.
        let directory = directory.filter(|dir| {
            dir.join("Project.toml").is_file() || dir.join("JuliaProject.toml").is_file()
        });
        let key = directory
            .as_deref()
            .map(kernel_key)
            .unwrap_or_else(|| self.shared_kernel_key());
        let (manager, _) = self.kernel_for(&key);
        let environment = directory.map(|dir| dir.to_string_lossy().into_owned());
        if start && !manager.is_running() {
            self.set_status(&key, KernelStatus::Starting);
            match manager.start() {
                Ok(info) => self.set_status(&key, KernelStatus::Ready { info }),
                Err(error) => {
                    self.set_status(
                        &key,
                        KernelStatus::Crashed {
                            message: error.to_string(),
                        },
                    );
                    return Err(CommandError::new("kernel", error.to_string()));
                }
            }
        }
        Ok((manager, environment, packages))
    }

    /// Restart REPL: the kernel the REPL runs in starts again, as Restart kernel
    /// does for a worksheet's environment. It needs no open worksheet. Returns the key of
    /// the kernel, as `EnvironmentSummary::kernel` names it, so the worksheets on it can refresh.
    pub fn repl_restart(&self, project: Option<&str>) -> Result<String, CommandError> {
        let (manager, environment, _) = self.repl_target_with_start(project, false)?;
        let key = environment
            .as_deref()
            .map(|dir| kernel_key(Path::new(dir)))
            .unwrap_or_else(|| self.shared_kernel_key());
        self.after_environment_change(&key, &manager)?;
        Ok(slash_path(&key))
    }

    /// Stop interrupts what the kernel of worksheet `id` is evaluating.
    pub fn repl_interrupt(&self, project: Option<&str>) -> Result<bool, CommandError> {
        let (manager, _, _) = self.repl_target(project)?;
        manager
            .interrupt_active()
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    /// completions for a project text file, from the kernel of worksheet `id`'s
    /// environment. Refused when that kernel is not running: completion never starts Julia,
    /// and the editor then uses its own words.
    pub fn complete(
        &self,
        id: &str,
        text: &str,
        position: usize,
    ) -> Result<equavela_core::kernel_manager::Completions, CommandError> {
        let worksheet = self.worksheet(id)?;
        let (manager, environment, packages) = {
            let session = lock(&worksheet.session);
            let environment = session.active_environment_directory();
            // Loading the environment's packages runs their code: only for a trusted worksheet.
            let packages = if session.is_trusted() {
                Self::project_of(&worksheet.root)
                    .and_then(|root| {
                        let manifest = project_reference::read_manifest(&root).ok()?;
                        Some(Self::julia_modules(&root, &manifest).packages)
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            (
                Arc::clone(session.kernel()),
                session.is_trusted().then_some(environment).flatten(),
                packages,
            )
        };
        if !manager.is_running() {
            return Err(CommandError::new("kernel", "the kernel is not running"));
        }
        manager
            .complete(environment.as_deref(), &packages, text, position)
            .map_err(|error| CommandError::new("kernel", error.to_string()))
    }

    /// Load in worksheets, the checkbox above a project `.jl` file.
    pub fn project_set_julia_module(
        &self,
        root: &Path,
        path: &str,
        loaded: bool,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest =
            project_tree::set_julia_module(&root, path, loaded).map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// Reloads the references of every open project worksheet: a change to one project's
    /// exports or references can reach the projects that use it.
    fn refresh_references(&self) -> Result<Vec<WorksheetEdit>, CommandError> {
        let open: Vec<(String, Arc<OpenWorksheet>)> = lock(&self.worksheets)
            .iter()
            .map(|(id, worksheet)| (id.clone(), Arc::clone(worksheet)))
            .collect();
        let mut edits = Vec::new();
        for (id, worksheet) in open {
            let Some(project_root) = Self::project_of(&worksheet.root) else {
                continue;
            };
            let mut session = lock(&worksheet.session);
            self.load_session_references(&mut session, &project_root)?;
            edits.push(WorksheetEdit {
                id,
                delta: Self::edit_result(&worksheet, &session, None, None),
            });
        }
        Ok(edits)
    }

    fn references_change(
        &self,
        manifest: ProjectManifest,
    ) -> Result<ReferencesChange, CommandError> {
        Ok(ReferencesChange {
            manifest,
            worksheets: self.refresh_references()?,
        })
    }

    /// the project's exports and references as they are now. Runs no Julia.
    pub fn project_references(&self, root: &Path) -> Result<ProjectReferences, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest = project_reference::read_manifest(&root).map_err(Self::project_error)?;
        let api = project_reference::read_api(&root, &manifest);
        let exports = manifest
            .exports
            .iter()
            .map(|export| ExportInfo {
                id: export.id.clone(),
                worksheet: manifest
                    .worksheets
                    .iter()
                    .find(|sheet| sheet.id == export.worksheet)
                    .map(|sheet| sheet.path.clone()),
                region: export.region.clone(),
                api: api.iter().find(|entry| entry.id == export.id).cloned(),
            })
            .collect();
        let loaded = project_reference::load_references(&root, &manifest);
        let dependencies: Vec<String> = manifest
            .environment
            .as_deref()
            .map(|environment| {
                read_environment_files(&root.join(environment))
                    .dependencies
                    .into_iter()
                    .map(|dependency| dependency.name)
                    .collect()
            })
            .unwrap_or_default();
        let references = manifest
            .references
            .iter()
            .map(|reference| {
                let provider = loaded
                    .references
                    .providers
                    .iter()
                    .find(|provider| provider.project_id == reference.project_id);
                let problem = loaded
                    .references
                    .problems
                    .iter()
                    .find(|(alias, _)| alias == &reference.alias)
                    .map(|(_, message)| message.clone());
                let current = provider
                    .map(|provider| provider.api.clone())
                    .unwrap_or_default();
                let package = provider.and_then(|provider| {
                    let theirs = project_reference::read_manifest(&provider.root).ok()?;
                    project_reference::provider_package(&provider.root, &theirs)
                        .map(|(name, _)| name)
                });
                ReferenceInfo {
                    developed: package
                        .as_ref()
                        .is_some_and(|name| dependencies.contains(name)),
                    package,
                    alias: reference.alias.clone(),
                    path: reference.path.clone(),
                    project_id: reference.project_id.clone(),
                    name: provider.map(|provider| provider.name.clone()),
                    root: provider.map(|provider| provider.root.to_string_lossy().into_owned()),
                    out_of_date: provider.is_some() && current != reference.api,
                    api: reference.api.clone(),
                    current,
                    problem,
                    // A reference is trusted with the projects it uses in turn.
                    trusted: provider.is_some()
                        && loaded.references.providers.iter().all(|provider| {
                            !in_chain(&provider.chain, &reference.alias)
                                || self.trusts_provider(provider)
                        }),
                }
            })
            .collect();
        Ok(ProjectReferences {
            exports,
            references,
        })
    }

    /// exports a definition region of a project worksheet, or stops exporting it.
    pub fn project_set_export(
        &self,
        root: &Path,
        path: &str,
        region: &str,
        exported: bool,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest = project_reference::set_export(&root, path, region, exported)
            .map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// references the project in `folder`.
    pub fn project_add_reference(
        &self,
        root: &Path,
        folder: &Path,
        alias: Option<&str>,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let (manifest, _) =
            project_reference::add_reference(&root, folder, alias).map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// relocks a reference to the provider's current exports.
    pub fn project_update_reference(
        &self,
        root: &Path,
        alias: &str,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest =
            project_reference::update_reference(&root, alias).map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// removes a reference.
    pub fn project_remove_reference(
        &self,
        root: &Path,
        alias: &str,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest =
            project_reference::remove_reference(&root, alias).map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// renames a reference's alias.
    pub fn project_rename_reference(
        &self,
        root: &Path,
        alias: &str,
        new_alias: &str,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest = project_reference::rename_reference(&root, alias, new_alias)
            .map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// develops a referenced project's Julia package into the environment of the
    /// worksheet `id`'s project, by relative path, with 's trust, snapshot and restart.
    pub fn develop_reference_package(
        &self,
        id: &str,
        alias: &str,
    ) -> Result<EnvironmentInfo, CommandError> {
        let worksheet = self.worksheet(id)?;
        let refused = |message: String| CommandError::new("environment", message);
        let project_root = Self::project_of(&worksheet.root)
            .ok_or_else(|| refused("the worksheet is not part of a project".into()))?;
        let manifest =
            project_reference::read_manifest(&project_root).map_err(Self::project_error)?;
        let reference = manifest
            .references
            .iter()
            .find(|reference| reference.alias == alias)
            .ok_or_else(|| refused(format!("the project has no reference `{alias}`")))?;
        let provider = std::fs::canonicalize(project_root.join(&reference.path)).map_err(|_| {
            refused(format!(
                "the project folder `{}` was not found",
                reference.path
            ))
        })?;
        let theirs = project_reference::read_manifest(&provider).map_err(Self::project_error)?;
        if theirs.project_id != reference.project_id {
            return Err(refused(format!(
                "`{}` holds another project than the one referenced",
                reference.path
            )));
        }
        let (_, package) = project_reference::provider_package(&provider, &theirs)
            .ok_or_else(|| refused(format!("`{alias}` has no Julia package")))?;
        let environment = lock(&worksheet.session)
            .environment_directory()
            .ok_or_else(|| {
                refused("the worksheet's Julia environment is not a directory".into())
            })?;
        std::fs::create_dir_all(&environment)
            .map_err(|error| refused(format!("{}: {error}", environment.display())))?;
        let environment = std::fs::canonicalize(&environment)
            .map_err(|error| refused(format!("{}: {error}", environment.display())))?;
        let package = std::fs::canonicalize(&package)
            .map_err(|error| refused(format!("{}: {error}", package.display())))?;
        let relative = project_reference::relative_path(&environment, &package).map_err(refused)?;
        self.modify_environment(id, &[relative], "develop", None)
    }

    /// reads the referenced projects' saved files again.
    pub fn project_reload_references(&self, root: &Path) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest = project_reference::read_manifest(&root).map_err(Self::project_error)?;
        self.references_change(manifest)
    }

    /// trusts a referenced project's current Julia code, or takes the trust back.
    pub fn project_trust_reference(
        &self,
        root: &Path,
        alias: &str,
        trusted: bool,
    ) -> Result<ReferencesChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let manifest = project_reference::read_manifest(&root).map_err(Self::project_error)?;
        let reference = manifest
            .references
            .iter()
            .find(|reference| reference.alias == alias)
            .ok_or_else(|| {
                Self::project_error(format!("the project has no reference `{alias}`"))
            })?;
        let loaded = project_reference::load_references(&root, &manifest);
        if !loaded
            .references
            .providers
            .iter()
            .any(|provider| provider.project_id == reference.project_id)
        {
            return Err(Self::project_error(format!(
                "the referenced project `{alias}` is unavailable"
            )));
        }
        // The reference and the projects it uses in turn.
        let mut trust = self.trust_file();
        for provider in &loaded.references.providers {
            if !in_chain(&provider.chain, alias) {
                continue;
            }
            trust
                .references
                .retain(|known| known.project_id != provider.project_id);
            if trusted {
                trust.references.push(TrustedReference {
                    project_id: provider.project_id.clone(),
                    julia_hash: provider.julia_hash.clone(),
                });
            }
        }
        self.write_trust_file(&trust);
        self.references_change(manifest)
    }

    /// copies `sources` into `folder`, never over an existing name.
    pub fn project_import(
        &self,
        root: &Path,
        folder: &str,
        sources: &[PathBuf],
    ) -> Result<ProjectChange, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        project_tree::import_files(&root, folder, sources).map_err(Self::project_error)?;
        Self::project_change(&root, &BTreeMap::new())
    }

    /// the text of a file of the tree and its version.
    pub fn project_read_text(
        &self,
        root: &Path,
        path: &str,
    ) -> Result<ProjectTextFile, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let (text, version) =
            project_tree::read_text_file(&root, path).map_err(Self::project_error)?;
        Ok(ProjectTextFile { text, version })
    }

    fn project_text_recovery_store(&self) -> Result<PathBuf, CommandError> {
        let dir = lock(&self.recovery_dir)
            .clone()
            .ok_or_else(|| CommandError::internal("the recovery directory is unavailable"))?;
        let store = dir.join("project-text");
        if let Ok(metadata) = std::fs::symlink_metadata(&store) {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(CommandError::internal(
                    "invalid project text recovery directory",
                ));
            }
        }
        Ok(store)
    }

    fn recovery_entry_path(&self, id: &str) -> Result<PathBuf, CommandError> {
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CommandError::internal("invalid project text recovery id"));
        }
        Ok(self
            .project_text_recovery_store()?
            .join(format!("{id}.json")))
    }

    fn read_recovery_entry(file: &Path) -> Result<ProjectTextRecoveryFile, CommandError> {
        let metadata = std::fs::symlink_metadata(file)
            .map_err(|error| CommandError::internal(format!("{}: {error}", file.display())))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(CommandError::internal(
                "recovery entry is not a regular file",
            ));
        }
        let bytes = std::fs::read(file)
            .map_err(|error| CommandError::internal(format!("{}: {error}", file.display())))?;
        let record: ProjectTextRecoveryFile = serde_json::from_slice(&bytes)
            .map_err(|error| CommandError::internal(format!("{}: {error}", file.display())))?;
        if !record.root.is_absolute()
            || equavela_core::project_manifest::validate_portable_path("path", &record.path)
                .is_err()
        {
            return Err(CommandError::internal(
                "invalid project text recovery metadata",
            ));
        }
        Ok(record)
    }

    pub fn list_project_text_recoveries(&self) -> Result<ProjectTextRecoveryListing, CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let store = self.project_text_recovery_store()?;
        let dir = match std::fs::read_dir(&store) {
            Ok(dir) => dir,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ProjectTextRecoveryListing {
                    entries: vec![],
                    unreadable: 0,
                })
            }
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "{}: {error}",
                    store.display()
                )))
            }
        };
        let mut listing = ProjectTextRecoveryListing {
            entries: Vec::new(),
            unreadable: 0,
        };
        for entry in dir {
            let entry = entry.map_err(|error| CommandError::internal(error.to_string()))?;
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                listing.unreadable += 1;
                continue;
            }
            let record = match Self::read_recovery_entry(&path) {
                Ok(record) => record,
                Err(_) => {
                    listing.unreadable += 1;
                    continue;
                }
            };
            let modified_ms = match entry.metadata().and_then(|metadata| metadata.modified()) {
                Ok(time) => time
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(u64::MAX as u128) as u64,
                Err(_) => {
                    listing.unreadable += 1;
                    continue;
                }
            };
            listing.entries.push(ProjectTextRecoveryEntry {
                id: id.to_owned(),
                root: record.root.to_string_lossy().into_owned(),
                path: record.path,
                modified_ms,
            });
        }
        listing.entries.sort_by(|a, b| {
            b.modified_ms
                .cmp(&a.modified_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(listing)
    }

    pub fn read_project_text_recovery(
        &self,
        id: &str,
    ) -> Result<ProjectTextRecovery, CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        Ok(Self::read_recovery_entry(&self.recovery_entry_path(id)?)?.recovery)
    }

    pub fn project_text_recovery_name(&self, id: &str) -> Result<String, CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let record = Self::read_recovery_entry(&self.recovery_entry_path(id)?)?;
        Ok(record
            .path
            .rsplit('/')
            .next()
            .unwrap_or("recovered.txt")
            .to_owned())
    }

    pub fn export_project_text_recovery_to(
        &self,
        id: &str,
        destination: &Path,
    ) -> Result<(), CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let file = self.recovery_entry_path(id)?;
        let record = Self::read_recovery_entry(&file)?;
        let store = std::fs::canonicalize(
            self.project_text_recovery_store()?
                .parent()
                .expect("text recovery has a parent directory"),
        )
        .map_err(|error| CommandError::internal(error.to_string()))?;
        let parent = destination
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent = std::fs::canonicalize(parent)
            .map_err(|error| CommandError::internal(error.to_string()))?;
        if parent.starts_with(&store)
            || std::fs::canonicalize(destination).is_ok_and(|path| path.starts_with(&store))
        {
            return Err(CommandError::internal(
                "cannot export into the recovery directory",
            ));
        }
        write_file_atomic(destination, &record.recovery.text)?;
        Ok(())
    }

    pub fn discard_project_text_recovery_entry(&self, id: &str) -> Result<(), CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let file = self.recovery_entry_path(id)?;
        match std::fs::symlink_metadata(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(CommandError::internal(error.to_string())),
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(CommandError::internal(
                    "recovery entry is not a regular file",
                ))
            }
            Ok(_) => {}
        }
        Self::read_recovery_entry(&file)?;
        std::fs::remove_file(file).map_err(|error| CommandError::internal(error.to_string()))
    }

    // The complete identity is stored and checked as well as hashed, so even a collision
    // cannot cause one project file's recovery to overwrite or delete another's.
    fn project_text_recovery_path(&self, root: &Path, path: &str) -> Result<PathBuf, CommandError> {
        project_tree::read_text_file(root, path).map_err(Self::project_error)?;
        let dir = lock(&self.recovery_dir).clone().ok_or_else(|| {
            CommandError::new("internal", "the recovery directory is unavailable")
        })?;
        let identity = serde_json::to_vec(&(root, path))
            .map_err(|error| CommandError::internal(error.to_string()))?;
        let mut reversed = identity.clone();
        reversed.reverse();
        Ok(dir.join("project-text").join(format!(
            "{}{}.json",
            project_tree::file_version(&identity),
            project_tree::file_version(&reversed)
        )))
    }

    fn read_project_text_recovery_file(
        file: &Path,
        root: &Path,
        path: &str,
        quarantine_invalid: bool,
    ) -> Result<Option<ProjectTextRecovery>, CommandError> {
        let bytes = match std::fs::read(file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(CommandError::internal(format!(
                    "{}: {error}",
                    file.display()
                )))
            }
        };
        // Check an intact identity even if some other field is malformed. A hash collision
        // must never cause another file's data to be moved or removed.
        let parsed: Result<Value, _> = serde_json::from_slice(&bytes);
        if let Ok(value) = &parsed {
            let expected_root = serde_json::to_value(root)
                .map_err(|error| CommandError::internal(error.to_string()))?;
            if value
                .get("root")
                .is_some_and(|value| value != &expected_root)
                || value.get("path").is_some_and(|value| value != path)
            {
                return Err(CommandError::internal(
                    "project text recovery identity collision",
                ));
            }
        }
        let record: ProjectTextRecoveryFile = match parsed.and_then(serde_json::from_value) {
            Ok(record) => record,
            Err(error) if !quarantine_invalid => {
                return Err(CommandError::internal(format!(
                    "{}: {error}",
                    file.display()
                )));
            }
            Err(_) => {
                use std::io::Write;
                let dir = file
                    .parent()
                    .expect("recovery path has a parent")
                    .join("corrupt");
                std::fs::create_dir_all(&dir).map_err(|error| {
                    CommandError::internal(format!("{}: {error}", dir.display()))
                })?;
                let mut copy = tempfile::NamedTempFile::new_in(&dir).map_err(|error| {
                    CommandError::internal(format!("{}: {error}", dir.display()))
                })?;
                copy.write_all(&bytes)
                    .and_then(|_| copy.as_file().sync_all())
                    .map_err(|error| {
                        CommandError::internal(format!("{}: {error}", dir.display()))
                    })?;
                copy.keep()
                    .map_err(|error| CommandError::internal(error.to_string()))?;
                std::fs::remove_file(file).map_err(|error| {
                    CommandError::internal(format!("{}: {error}", file.display()))
                })?;
                return Ok(None);
            }
        };
        if record.root != root || record.path != path {
            return Err(CommandError::internal(
                "project text recovery identity collision",
            ));
        }
        Ok(Some(record.recovery))
    }

    pub fn write_project_text_recovery(
        &self,
        root: &Path,
        path: &str,
        text: &str,
        saved: &str,
        version: &str,
    ) -> Result<(), CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let file = self.project_text_recovery_path(&root, path)?;
        Self::read_project_text_recovery_file(&file, &root, path, true)?;
        let record = ProjectTextRecoveryFile {
            root,
            path: path.to_owned(),
            recovery: ProjectTextRecovery {
                text: text.to_owned(),
                saved: saved.to_owned(),
                version: version.to_owned(),
            },
        };
        let parent = file.parent().expect("recovery path has a parent");
        std::fs::create_dir_all(parent)
            .map_err(|error| CommandError::internal(error.to_string()))?;
        let contents = serde_json::to_string(&record)
            .map_err(|error| CommandError::internal(error.to_string()))?;
        write_file_atomic(&file, &contents)?;
        Ok(())
    }

    pub fn project_text_recovery_for(
        &self,
        root: &Path,
        path: &str,
    ) -> Result<Option<ProjectTextRecovery>, CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let file = self.project_text_recovery_path(&root, path)?;
        Self::read_project_text_recovery_file(&file, &root, path, false)
    }

    pub fn discard_project_text_recovery(
        &self,
        root: &Path,
        path: &str,
    ) -> Result<(), CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let file = self.project_text_recovery_path(&root, path)?;
        if Self::read_project_text_recovery_file(&file, &root, path, true)?.is_some() {
            std::fs::remove_file(&file)
                .map_err(|error| CommandError::internal(error.to_string()))?;
        }
        Ok(())
    }

    /// saves a text tab, when the file is still the version it read. Saving a Julia
    /// source of the project's environment restarts the project's kernel, if one runs, and
    /// recalculates its worksheets, so they use the new code.
    pub fn project_write_text(
        &self,
        root: &Path,
        path: &str,
        text: &str,
        version: &str,
    ) -> Result<ProjectTextSaved, CommandError> {
        let _guard = lock(&PROJECT_TEXT_RECOVERY);
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let version = project_tree::write_text_file(&root, path, text, version)
            .map_err(Self::project_error)?;
        let (_, manifest) = Self::project_manifest(&root)?;
        let julia_source = path.to_ascii_lowercase().ends_with(".jl")
            && manifest
                .environment
                .as_deref()
                .is_some_and(|env| path.starts_with(&format!("{env}/")));
        let mut restarted = false;
        if julia_source {
            let environment = root.join(manifest.environment.as_deref().unwrap_or_default());
            let key = kernel_key(&environment);
            let manager = lock(&self.kernels)
                .get(&key)
                .map(|kernel| Arc::clone(&kernel.manager));
            // A kernel that never started loads the new code when it first runs.
            let started = !matches!(self.kernel_status_of(&key), KernelStatus::NotStarted);
            if let Some(manager) = manager.filter(|_| started) {
                self.after_environment_change(&key, &manager)?;
                restarted = true;
            }
        }
        // Keep a newer autosave, and never turn a successful save into an error if cleanup fails.
        if let Ok(file) = self.project_text_recovery_path(&root, path) {
            if let Ok(Some(recovery)) =
                Self::read_project_text_recovery_file(&file, &root, path, false)
            {
                if recovery.text == text {
                    let _ = std::fs::remove_file(file);
                }
            }
        }
        Ok(ProjectTextSaved { version, restarted })
    }

    /// an image of the tree as a data URL.
    pub fn project_image(&self, root: &Path, path: &str) -> Result<String, CommandError> {
        let root = Self::canonical_project(root)?;
        let _project_guard =
            project_tree::ProjectGuard::acquire(&root).map_err(Self::project_error)?;
        let (media, bytes) =
            project_tree::read_image_file(&root, path).map_err(Self::project_error)?;
        Ok(format!("data:{media};base64,{}", base64_encode(&bytes)))
    }

    /// Opens a validated folder project. It opens no worksheet: the app restores the tabs of the
    /// project's last session.
    pub fn open_project(self: &Arc<Self>, root: &Path) -> Result<OpenedProject, CommandError> {
        if !root.is_absolute() {
            return Err(CommandError::new(
                "load",
                "the project directory must be an absolute path",
            ));
        }
        // the manifest follows the tree before anything reads it.
        let _guard = project_tree::ProjectGuard::acquire(root).map_err(Self::project_error)?;
        crate::project_trash::recover(root).map_err(Self::project_error)?;
        project_tree::sync_manifest(root, &BTreeMap::new())
            .map_err(|error| CommandError::new("load", error))?;
        let loaded = load_project_directory(root)
            .map_err(|error| CommandError::new("load", error.to_string()))?;
        Ok(OpenedProject {
            root: slash_path(&loaded.root),
            manifest: loaded.manifest,
            worksheet: None,
        })
    }

    /// The image files of a folder project's `assets/images/`, sorted case-insensitively.
    pub fn list_project_assets(&self, root: &Path) -> Result<Vec<String>, CommandError> {
        if !root.is_absolute() {
            return Err(CommandError::new(
                "load",
                "the project directory must be an absolute path",
            ));
        }
        let loaded = load_project_directory(root)
            .map_err(|error| CommandError::new("load", error.to_string()))?;
        list_image_assets(&loaded.root)
            .map_err(|error| CommandError::new("load", error.to_string()))
    }

    /// Loads a worksheet file (and its includes). The kernel is started in the background.
    pub fn open_worksheet(self: &Arc<Self>, path: &Path) -> Result<OpenedWorksheet, CommandError> {
        let _project_guard = Self::guard_path(path)?;
        crate::project_trash::recover_for_path(path).map_err(Self::project_error)?;
        if is_document_archive(path) {
            return self.open_document_archive(path, None);
        }
        let loaded = load_project(path)?;
        self.open_session(loaded.project, loaded.root, loaded.texts, None)
    }

    /// Opens a portable `.eqvz` document: the container is validated and
    /// the worksheet checked before its environment is materialized. `text` replaces the
    /// archived worksheet (a recovery file of the document).
    fn open_document_archive(
        self: &Arc<Self>,
        path: &Path,
        text: Option<String>,
    ) -> Result<OpenedWorksheet, CommandError> {
        let bytes = crate::project_archive_files::read_archive_file(path, "load")?;
        let archive = decode_document(&bytes)
            .map_err(|error| CommandError::new("load", error.to_string()))?;
        let root = equavela_core::worksheet_file::document_id_for_path(path)?;
        let text = text.unwrap_or_else(|| archive.worksheet.clone());
        let parsed = parse_document(root.clone(), &text)?;
        if let Some(include) = first_include(&parsed.document) {
            return Err(CommandError::new(
                "load",
                format!("a portable document cannot contain include regions (`{include}`)"),
            ));
        }
        let environments = lock(&self.environments)
            .as_ref()
            .map(|paths| paths.root.clone())
            .ok_or_else(|| {
                CommandError::new("load", "Equavela's environments folder is unavailable")
            })?;
        let environment = materialize_environment(&environments, &archive)
            .map_err(|error| CommandError::new("load", error.to_string()))?;
        let loaded = load_project_text(root, &text)?;
        self.open_session(
            loaded.project,
            loaded.root,
            loaded.texts,
            Some(ArchiveDocument {
                document_id: archive.document_id,
                environment,
            }),
        )
    }

    /// Creates an empty, unsaved worksheet (File > New).
    pub fn new_worksheet(self: &Arc<Self>) -> Result<OpenedWorksheet, CommandError> {
        let number = self.next_id.load(Ordering::SeqCst);
        let root = DocumentId::new(&format!("Untitled-{number}.eqv"))
            .map_err(|error| CommandError::new("internal", error.to_string()))?;
        let mut project = Project::new();
        project
            .insert(ProjectDocument {
                id: root.clone(),
                content_hash: "new".into(),
                settings: Default::default(),
                environment: None,
                page: Default::default(),
                result_formats: Default::default(),
                math_breaks: Default::default(),
                resources: Default::default(),
                assets: Default::default(),
                page_breaks: Vec::new(),
                regions: Vec::new(),
            })
            .map_err(|error| CommandError::new("internal", error.to_string()))?;
        self.open_session(project, root, HashMap::new(), None)
    }

    /// Imports an .mcdx worksheet or an older `.xmcd`,
    /// chosen by the extension, as a new
    /// **untitled** worksheet: the file is only read, nothing is written next to it, and Save asks
    /// for a `.eqv` name. The caller shows the worksheet as modified.
    pub fn import_mcdx(self: &Arc<Self>, path: &Path) -> Result<ImportedWorksheet, CommandError> {
        let imported = equavela_core::mcdx::import_file(path)
            .map_err(|error| CommandError::new("load", error.to_string()))?;
        let number = self.next_id.load(Ordering::SeqCst);
        let root = DocumentId::new(&format!("Untitled-{number}.eqv"))
            .map_err(|error| CommandError::new("internal", error.to_string()))?;
        let loaded = load_project_text(root, &imported.text)?;
        let opened = self.open_session(loaded.project, loaded.root, loaded.texts, None)?;
        Ok(ImportedWorksheet {
            opened,
            report: imported.report,
        })
    }

    fn open_session(
        self: &Arc<Self>,
        project: Project,
        root: DocumentId,
        loaded_texts: HashMap<(DocumentId, String), String>,
        archive: Option<ArchiveDocument>,
    ) -> Result<OpenedWorksheet, CommandError> {
        let id = format!("ws{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let environment = self.environment_of(
            &project,
            &root,
            archive
                .as_ref()
                .map(|archive| archive.environment.as_path()),
        );
        let key = kernel_key(&environment.directory);
        let (manager, _) = self.kernel_for(&key);
        let texts: Vec<RegionText> = {
            let mut texts: Vec<RegionText> = loaded_texts
                .iter()
                .map(|((document, region_id), text)| RegionText {
                    document: document.clone(),
                    region_id: region_id.clone(),
                    text: text.clone(),
                })
                .collect();
            texts.sort_by(|a, b| (&a.document, &a.region_id).cmp(&(&b.document, &b.region_id)));
            texts
        };
        let mut session = WorksheetSession::new(
            manager,
            id.clone(),
            project,
            root.clone(),
            loaded_texts,
            GenOptions::default(),
        )?;
        if let Some(shared) = self.shared_environment() {
            session.set_shared_environment(shared);
        }
        if let Some(archive) = &archive {
            session.set_archive_environment(archive.environment.clone());
        }
        // a project worksheet sees its references' exports.
        if let Some(project_root) = Self::project_of(&root) {
            self.load_session_references(&mut session, &project_root)?;
        }
        // Section 6: a worksheet made in the app is trusted; a file is trusted when this
        // user trusted it before, otherwise its Julia blocks stay stopped until the user trusts it.
        session
            .set_trusted(!is_absolute_path(root.as_str()) || self.is_trusted_path(root.as_str()));
        // The results of the last calculation, as long as the regions still calculate the same.
        if let Some(file) = Self::results_file(&root, archive.is_some()) {
            if let Some(entries) = std::fs::read(&file)
                .ok()
                .and_then(|bytes| stored_results::decode(&bytes).ok())
            {
                session.restore_results(entries);
            }
        }
        let results = session.results();
        let regions = results.snapshot();
        let view = session.view(&root).expect("the root document is loaded");
        // The frontend starts from this state: revision 0, and the deltas count from here.
        let sent = SentState::capture(0, &view, &regions);
        let opened = OpenedWorksheet {
            id: id.clone(),
            regions,
            texts,
            diagnostics: worksheet_diagnostics(&session),
            view,
            root: root.clone(),
            revision: sent.revision,
            environment: EnvironmentSummary::of(&environment),
        };
        let worksheet = Arc::new(OpenWorksheet {
            root,
            kernel_key: Mutex::new(key),
            interrupt: Mutex::new(session.interrupt_handle()),
            results,
            session: Mutex::new(session),
            running: AtomicBool::new(false),
            rerun: AtomicBool::new(false),
            rerun_all: AtomicBool::new(false),
            sent: Mutex::new(sent),
            sent_diagnostics: Mutex::new(opened.diagnostics.clone()),
            archive,
        });
        lock(&self.worksheets).insert(id, worksheet);
        self.start_kernel();
        Ok(opened)
    }

    // ---- stored results ----------------------------------------------------------------

    /// The results file of a worksheet saved as a `.eqv` file: in its project's results folder or
    /// next to it. `None` for an untitled worksheet and a portable document.
    fn results_file(root: &DocumentId, archive: bool) -> Option<PathBuf> {
        if archive || !is_absolute_path(root.as_str()) {
            return None;
        }
        let path = path_for_document(root);
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        let project =
            Self::project_of(root).map(|folder| std::fs::canonicalize(&folder).unwrap_or(folder));
        Some(stored_results::results_path(&path, project.as_deref()))
    }

    /// Writes the worksheet's results file with its current results, if it has any. A failure only
    /// loses the stored results: the worksheet itself is untouched.
    fn write_results(worksheet: &OpenWorksheet) {
        let Some(file) = Self::results_file(&worksheet.root, worksheet.archive.is_some()) else {
            return;
        };
        // A command that holds the session may be waiting for this pass to end: never wait for it
        // here; the next pass or save writes the file.
        let Ok(session) = worksheet.session.try_lock() else {
            return;
        };
        let entries = session.stored_results();
        drop(session);
        // A worksheet that was never calculated has nothing to keep: no file is created for it.
        if entries.is_empty() {
            return;
        }
        let bytes = stored_results::encode(&entries);
        let written = file
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .map_err(|error| error.to_string())
            .and_then(|()| write_bytes_atomic(&file, &bytes).map_err(|error| error.to_string()));
        if let Err(error) = written {
            eprintln!(
                "could not write the results file {}: {error}",
                file.display()
            );
        }
    }

    // ---- saving -----------------------------------------------------------------------

    /// Whether the worksheet has no file yet (File > New): its id is a bare `Untitled-N.eqv`.
    pub fn is_untitled(&self, id: &str) -> Result<bool, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        Ok(!is_absolute_path(session.root().as_str()))
    }

    /// Where a Save As dialog starts: the worksheet's directory and its file name (`suggested`,
    /// the tab name, for a worksheet without a file; always with the `.eqv` extension).
    pub fn start_location(&self, id: &str, suggested: Option<&str>) -> SaveLocation {
        let root = self
            .worksheet(id)
            .ok()
            .and_then(|worksheet| worksheet.session.try_lock().ok().map(|s| s.root().clone()));
        let (directory, name) = match &root {
            Some(root) if is_absolute_path(root.as_str()) => {
                let path = path_for_document(root);
                (
                    path.parent().map(Path::to_path_buf),
                    path.file_name().map(|n| n.to_string_lossy().into_owned()),
                )
            }
            _ => (None, None),
        };
        let name = name
            .or_else(|| suggested.map(str::to_owned))
            .unwrap_or_else(|| "Untitled".to_owned());
        // A portable document keeps its extension; everything else saves as `.eqv`.
        // A portable document keeps its extension; everything else saves as `.eqv`.
        let file_name = if name.ends_with(".eqvz") {
            name
        } else {
            format!("{}.eqv", name.strip_suffix(".eqv").unwrap_or(&name))
        };
        SaveLocation {
            directory,
            file_name,
        }
    }

    /// Saves the worksheet to its own file (the root document only; included files are never
    /// written). Atomic: a temporary file is written and renamed over the target. Not available
    /// while a calculation runs (the UI waits for the pass to finish).
    pub fn save_worksheet(&self, id: &str) -> Result<SavedWorksheet, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let session = lock(&worksheet.session);
        let root = session.root().clone();
        if !is_absolute_path(root.as_str()) {
            return Err(CommandError::new(
                "untitled",
                "the worksheet has no file yet: use Save As",
            ));
        }
        let document = session
            .project()
            .document(&root)
            .expect("the root document is loaded");
        let path = path_for_document(&root);
        if let Some(archive) = &worksheet.archive {
            // the current worksheet and the current files of its environment folder.
            let bytes = document_archive_bytes(
                document,
                &archive.environment,
                archive.document_id.clone(),
                &path,
            )?;
            write_bytes_atomic(&path, &bytes)?;
        } else {
            let text = write_document(document)?;
            write_file_atomic(&path, &text)?;
        }
        drop(session);
        Self::write_results(&worksheet);
        self.delete_recovery(&root);
        Ok(SavedWorksheet {
            path: root.to_string(),
            opened: None,
        })
    }

    /// Writes the worksheet to `path` (`.eqv` is appended to a name without extension) and
    /// re-opens it from there, so that its include paths resolve against the new location.
    /// Relative include paths are rewritten to keep pointing at the same files. The old session
    /// is closed; the returned worksheet replaces it.
    pub fn save_worksheet_as(
        self: &Arc<Self>,
        id: &str,
        path: &Path,
    ) -> Result<SavedWorksheet, CommandError> {
        let path = with_default_extension(path);
        let new_root = equavela_core::worksheet_file::document_id_for_path(&path)?;
        let _destination_guard = Self::guard_path(&path)?;
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        {
            let session = lock(&worksheet.session);
            let root = session.root().clone();
            if root == new_root {
                drop(session);
                return self.save_worksheet(id);
            }
            let mut document = session
                .project()
                .document(&root)
                .expect("the root document is loaded")
                .clone();
            if is_document_archive(&path) {
                // the environment the worksheet uses now travels with it.
                let document_id = worksheet
                    .archive
                    .as_ref()
                    .map_or_else(new_document_id, |archive| archive.document_id.clone());
                let bytes = document_archive_bytes(
                    &document,
                    &session.environment().directory,
                    document_id,
                    &path,
                )?;
                write_bytes_atomic(&path, &bytes)?;
                self.delete_recovery(&new_root);
                drop(session);
                if lock(&worksheet.session).is_trusted() {
                    self.remember_trust(new_root.as_str(), true);
                }
                let opened = self.open_document_archive(&path, None)?;
                let _ = self.close_worksheet(id);
                return Ok(SavedWorksheet {
                    path: new_root.to_string(),
                    opened: Some(opened),
                });
            }
            embed_assets_leaving_project(&mut document, &path)?;
            if is_absolute_path(root.as_str()) {
                for region in &mut document.regions {
                    if matches!(region.as_ref(), DocumentRegion::Include(_)) {
                        if let DocumentRegion::Include(include) = Arc::make_mut(region) {
                            include.path = rebase_include(&root, &new_root, &include.path);
                        }
                    }
                }
            }
            let text = write_document(&document)?;
            write_file_atomic(&path, &text)?;
            // A backup left next to the new name is out of date now.
            self.delete_recovery(&new_root);
        }
        // A trusted worksheet stays trusted under its new name (section 6).
        if lock(&worksheet.session).is_trusted() {
            self.remember_trust(new_root.as_str(), true);
        }
        let loaded = load_project(&path)?;
        let opened = self.open_session(loaded.project, loaded.root, loaded.texts, None)?;
        // The old session is replaced by the new one.
        let _ = self.close_worksheet(id);
        Ok(SavedWorksheet {
            path: new_root.to_string(),
            opened: Some(opened),
        })
    }

    // ---- trust -------------------------------

    /// Sets the directory of the per-user configuration: the trusted worksheets are listed in
    /// `trusted-worksheets.json` there.
    pub fn set_config_dir(&self, dir: PathBuf) {
        *lock(&self.trust_file) = Some(dir.join("trusted-worksheets.json"));
    }

    fn trusted_paths(&self) -> Vec<String> {
        let Some(file) = lock(&self.trust_file).clone() else {
            return Vec::new();
        };
        std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<TrustFile>(&text).ok())
            .map(|file| file.trusted)
            .unwrap_or_default()
    }

    fn is_trusted_path(&self, path: &str) -> bool {
        self.trusted_paths().iter().any(|known| known == path)
    }

    fn trust_file(&self) -> TrustFile {
        let Some(file) = lock(&self.trust_file).clone() else {
            return TrustFile::default();
        };
        std::fs::read_to_string(file)
            .ok()
            .and_then(|text| serde_json::from_str::<TrustFile>(&text).ok())
            .unwrap_or_default()
    }

    fn write_trust_file(&self, trust: &TrustFile) {
        let Some(file) = lock(&self.trust_file).clone() else {
            return;
        };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let text = serde_json::to_string_pretty(trust).expect("the trust file serializes");
        let _ = write_file_atomic(&file, &format!("{text}\n"));
    }

    /// Whether this user trusts a provider's current Julia code.
    fn trusts_provider(&self, provider: &project_reference::Provider) -> bool {
        self.trust_file().references.contains(&TrustedReference {
            project_id: provider.project_id.clone(),
            julia_hash: provider.julia_hash.clone(),
        })
    }

    /// The spliced documents of untrusted providers, with the alias that names them.
    fn untrusted_references(&self, references: &References) -> BTreeMap<DocumentId, String> {
        let mut untrusted = BTreeMap::new();
        for provider in &references.providers {
            if !self.trusts_provider(provider) {
                for document in &provider.documents {
                    untrusted.insert(document.clone(), provider.chain.clone());
                }
            }
        }
        untrusted
    }

    /// Adds `path` to the trusted worksheets of this user, or removes it.
    fn remember_trust(&self, path: &str, trusted: bool) {
        let mut trust = self.trust_file();
        trust.trusted.retain(|known| known != path);
        if trusted {
            trust.trusted.push(path.to_owned());
        }
        trust.trusted.sort();
        // The trusted references are kept as they are.
        self.write_trust_file(&trust);
    }

    /// Trusts a worksheet, or takes the trust back: its Julia blocks may then
    /// play, and a saved file is remembered for this user so it is trusted when it is opened again.
    pub fn set_worksheet_trusted(
        &self,
        id: &str,
        trusted: bool,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        if is_absolute_path(root.as_str()) {
            self.remember_trust(root.as_str(), trusted);
        }
        session.set_trusted(trusted);
        Ok(Self::edit_result(&worksheet, &session, None, None))
    }

    // ---- autosave and recovery ----------------------------------------

    /// Sets the directory for the recovery files of worksheets without a file.
    pub fn set_recovery_dir(&self, dir: PathBuf) {
        *lock(&self.recovery_dir) = Some(dir);
    }

    /// Sets the folder of Equavela's Julia environments (a test driver keeps its own).
    pub fn set_environments_dir(&self, dir: PathBuf) {
        *lock(&self.environments) = Some(EnvironmentPaths::new(dir));
    }

    /// The environment shared by standalone worksheets.
    fn shared_environment(&self) -> Option<PathBuf> {
        lock(&self.environments)
            .as_ref()
            .map(|paths| paths.shared.clone())
    }

    /// The recovery file of a worksheet: `<dir>/.<name>.recovery` next to a saved file,
    /// `<recovery dir>/<run tag>-<name>.recovery` for an untitled worksheet (none when no directory is set).
    fn recovery_path(&self, root: &DocumentId) -> Option<PathBuf> {
        if is_absolute_path(root.as_str()) {
            Some(recovery_file_for(&path_for_document(root)))
        } else {
            lock(&self.recovery_dir)
                .as_ref()
                .map(|dir| dir.join(format!("{}-{}.recovery", self.run_tag, root.as_str())))
        }
    }

    fn delete_recovery(&self, root: &DocumentId) {
        if let Some(path) = self.recovery_path(root) {
            let _ = std::fs::remove_file(path);
        }
    }

    /// Writes the worksheet's recovery file: what Save would write, atomically, without touching
    /// the worksheet file. Returns the file written, or `None` when nothing was written because a
    /// calculation holds the session (the caller tries again later) or there is no place for it.
    pub fn write_recovery(&self, id: &str) -> Result<Option<String>, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let Some(path) = self.recovery_path(&worksheet.root) else {
            return Ok(None);
        };
        let Ok(session) = worksheet.session.try_lock() else {
            return Ok(None);
        };
        let document = session
            .project()
            .document(&worksheet.root)
            .expect("the root document is loaded");
        let text = write_document(document)?;
        drop(session);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                CommandError::new("internal", format!("{}: {error}", parent.display()))
            })?;
        }
        write_file_atomic(&path, &text)?;
        Ok(Some(slash_path(&path)))
    }

    /// The recovery file of a worksheet file, when it is newer than the file. A stale one
    /// (not newer) is deleted.
    pub fn recovery_for(&self, path: &Path) -> Option<RecoveryInfo> {
        let recovery = recovery_file_for(path);
        let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let backup = modified(&recovery)?;
        match modified(path) {
            Some(saved) if saved >= backup => {
                let _ = std::fs::remove_file(&recovery);
                None
            }
            _ => Some(RecoveryInfo {
                path: slash_path(&recovery),
            }),
        }
    }

    /// Deletes a recovery file the user discarded (only `*.recovery` files are touched).
    pub fn discard_recovery_file(&self, path: &Path) -> Result<(), CommandError> {
        if path.extension().and_then(|e| e.to_str()) != Some("recovery") {
            return Err(CommandError::new("internal", "not a recovery file"));
        }
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CommandError::new(
                "internal",
                format!("{}: {error}", path.display()),
            )),
        }
    }

    /// The recovery files of worksheets that never had a file, sorted by name.
    pub fn pending_recoveries(&self) -> Vec<String> {
        let Some(dir) = lock(&self.recovery_dir).clone() else {
            return Vec::new();
        };
        let mut found: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("recovery"))
            .map(|path| slash_path(&path))
            .collect();
        found.sort();
        found
    }

    /// Opens a recovery file as a worksheet. With `original` (the worksheet file it belongs to)
    /// the worksheet takes that file's name, so Save writes there and the recovery file keeps
    /// guarding it; without, it becomes a new untitled worksheet whose own recovery file is
    /// written at once, after which the old one is deleted. The caller shows it as modified.
    pub fn open_recovery(
        self: &Arc<Self>,
        recovery: &Path,
        original: Option<&Path>,
    ) -> Result<OpenedWorksheet, CommandError> {
        let text = std::fs::read_to_string(recovery).map_err(|error| {
            CommandError::new("load", format!("{}: {error}", recovery.display()))
        })?;
        let root = match original {
            Some(path) => equavela_core::worksheet_file::document_id_for_path(path)?,
            None => {
                let number = self.next_id.load(Ordering::SeqCst);
                DocumentId::new(&format!("Untitled-{number}.eqv"))
                    .map_err(|error| CommandError::new("internal", error.to_string()))?
            }
        };
        if let Some(path) = original.filter(|path| is_document_archive(path)) {
            // The backup of a portable document: its environment still comes from the archive.
            return self.open_document_archive(path, Some(text));
        }
        let loaded = load_project_text(root, &text)?;
        let opened = self.open_session(loaded.project, loaded.root, loaded.texts, None)?;
        if original.is_none() {
            // Its own backup first, so that there is no moment without one.
            let own = self.write_recovery(&opened.id)?;
            if own.is_some_and(|written| written != slash_path(recovery)) {
                let _ = std::fs::remove_file(recovery);
            }
        }
        Ok(opened)
    }

    // ---- region editing ---------------------------------------------------------------

    /// The delta from what the worksheet last sent to the state of `session` now, and the
    /// new baseline. The session is held by the caller, so the two lock in one order only.
    fn edit_result(
        worksheet: &OpenWorksheet,
        session: &WorksheetSession,
        created: Option<String>,
        label: Option<String>,
    ) -> EditResult {
        // An edit that changes what a pass would do stops a running pass; one that only changes
        // presentation leaves it running.
        let calc_needed = session.calc_needed();
        if worksheet.running.load(Ordering::SeqCst) && calc_needed {
            lock(&worksheet.interrupt).interrupt();
        }
        let view = session
            .view(session.root())
            .expect("the root document is loaded");
        let regions = worksheet.results.snapshot();
        let mut sent = lock(&worksheet.sent);
        let (mut delta, next) = std::mem::take(&mut *sent).advance(&view, &regions);
        *sent = next;
        delta.created = created;
        delta.calc_needed = calc_needed;
        delta.label = label;
        let diagnostics = worksheet_diagnostics(session);
        let mut sent_diagnostics = lock(&worksheet.sent_diagnostics);
        if *sent_diagnostics != diagnostics {
            sent_diagnostics.clone_from(&diagnostics);
            delta.diagnostics = Some(diagnostics);
        }
        delta
    }

    /// Adds a region of `kind` (`math`, `text`, `plot` or `include`) at a page position. Math
    /// regions need valid math text (a new empty region holds the placeholder `□`).
    pub fn add_region(
        &self,
        id: &str,
        kind: &str,
        page: u32,
        x: f64,
        y: f64,
        text: Option<&str>,
    ) -> Result<EditResult, CommandError> {
        self.add_region_inner(id, kind, page, x, y, text, false, Vec::new())
    }

    /// Adds a region with an optional initial size for a plot. The size is part of the insertion
    /// command, so creating a fitted plot remains one undo step.
    #[allow(clippy::too_many_arguments)] // Mirrors the backward-compatible flat IPC arguments.
    pub fn add_region_with_plot_size(
        &self,
        id: &str,
        kind: &str,
        page: u32,
        x: f64,
        y: f64,
        text: Option<&str>,
        plot_size: Option<[f64; 2]>,
    ) -> Result<EditResult, CommandError> {
        if plot_size.is_some() && kind != "plot" {
            return Err(CommandError::new(
                "region",
                "an initial plot size requires a plot region",
            ));
        }
        self.add_region_inner_with_plot_size(
            id,
            kind,
            page,
            x,
            y,
            text,
            false,
            Vec::new(),
            plot_size,
        )
    }

    /// Existing insertion forms retain their signature and omit initial plot sizing.
    #[allow(clippy::too_many_arguments)]
    fn add_region_inner(
        &self,
        id: &str,
        kind: &str,
        page: u32,
        x: f64,
        y: f64,
        text: Option<&str>,
        full_width: bool,
        breaks: Vec<equavela_core::layout::MathBreak>,
    ) -> Result<EditResult, CommandError> {
        self.add_region_inner_with_plot_size(id, kind, page, x, y, text, full_width, breaks, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn add_region_inner_with_plot_size(
        &self,
        id: &str,
        kind: &str,
        page: u32,
        x: f64,
        y: f64,
        text: Option<&str>,
        full_width: bool,
        breaks: Vec<equavela_core::layout::MathBreak>,
        plot_size: Option<[f64; 2]>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let region_id = session.new_region_id(&root);
        let stored = match kind {
            "math" => {
                let text = text.unwrap_or("\u{25a1}");
                let statement = parse_statement(text).map_err(SessionError::Parse)?;
                StoredRegion {
                    region: DocumentRegion::Math(Box::new(Region {
                        id: region_id.clone(),
                        page,
                        x,
                        y,
                        enabled: true,
                        statement: Arc::new(statement),
                    })),
                    math_text: Some(text.to_owned()),
                }
            }
            "text" => StoredRegion {
                region: DocumentRegion::Text(TextRegion {
                    id: region_id.clone(),
                    page,
                    x,
                    y,
                    enabled: true,
                    // A new text box has no stored width: it grows with its text up to the right
                    // margin; a block takes the printable width.
                    width: None,
                    full_width,
                    background: None,
                    language: None,
                    text: equavela_core::richtext::canonical(text.unwrap_or("Text")),
                }),
                math_text: None,
            },
            // A Julia block from Insert > Julia: empty and stopped.
            "julia" => StoredRegion {
                region: DocumentRegion::Math(Box::new(Region {
                    id: region_id.clone(),
                    page,
                    x,
                    y,
                    enabled: true,
                    statement: Arc::new(equavela_core::ast::Statement {
                        span: Default::default(),
                        kind: equavela_core::ast::StatementKind::Julia {
                            block: equavela_core::ast::JuliaBlock {
                                playing: false,
                                ..Default::default()
                            },
                        },
                    }),
                })),
                math_text: None,
            },
            // a new table is a math region: two columns, two value rows.
            "table" => {
                let text = "table:[\u{25a1}, \u{25a1}; \u{25a1}, \u{25a1}; \u{25a1}, \u{25a1}]";
                let statement = parse_statement(text).map_err(SessionError::Parse)?;
                StoredRegion {
                    region: DocumentRegion::Math(Box::new(Region {
                        id: region_id.clone(),
                        page,
                        x,
                        y,
                        enabled: true,
                        statement: Arc::new(statement),
                    })),
                    math_text: Some(text.to_owned()),
                }
            }
            "plot" => StoredRegion {
                region: DocumentRegion::Plot(Box::new(PlotRegion {
                    id: region_id.clone(),
                    page,
                    x,
                    y,
                    enabled: true,
                    plot: {
                        let mut plot = PlotSpec::new_xy();
                        if let Some(size) = plot_size {
                            plot.size = size;
                        }
                        plot.validate()
                            .map_err(|message| CommandError::new("region", message))?;
                        plot
                    },
                    view: None,
                })),
                math_text: None,
            },
            "area" => {
                // An expanded area of 120 pt, shortened so that it ends inside the printable
                // area of its page and before the next band in the flow of the sheet: an
                // insert never starts a band across a page break. Refused where no room is left.
                let document = session
                    .project()
                    .document(&root)
                    .expect("the root document is loaded");
                let page_setup = &document.page;
                let margins = &page_setup.margins;
                let left = margins.left;
                let (y, mut end) = (y.max(margins.top), page_setup.height - margins.bottom);
                // The flow offset of the printable top of this page: a limit measured in the flow is
                // turned back into a `y` of this page with it.
                let page_top = equavela_core::layout::flow_of(page_setup, page, margins.top);
                let start = equavela_core::layout::flow_of(page_setup, page, y);
                for region in &document.regions {
                    if let DocumentRegion::Area(other) = region.as_ref() {
                        let other_start =
                            equavela_core::layout::flow_of(page_setup, other.page, other.y);
                        if other_start <= start + 1e-9 && start < other_start + other.height - 1e-9
                        {
                            // The crosshair is inside another band, on whatever page it starts.
                            end = y;
                        } else if other_start > start {
                            end = end.min(margins.top + (other_start - page_top));
                        }
                    }
                }
                let height = (end - y).min(120.0).floor();
                if height < MIN_AREA_HEIGHT {
                    return Err(CommandError::new(
                        "region",
                        "there is no room for an area here: move the crosshair to free space",
                    ));
                }
                StoredRegion {
                    region: DocumentRegion::Area(AreaRegion {
                        id: region_id.clone(),
                        page,
                        x: left,
                        y,
                        enabled: true,
                        title: text.unwrap_or("Area").to_owned(),
                        height,
                        collapsed: false,
                    }),
                    math_text: None,
                }
            }
            "include" => StoredRegion {
                region: DocumentRegion::Include(IncludeRegion {
                    id: region_id.clone(),
                    page,
                    x,
                    y,
                    enabled: true,
                    path: text.unwrap_or_default().to_owned(),
                }),
                math_text: None,
            },
            other => {
                return Err(CommandError::new(
                    "region",
                    format!("unknown region kind `{other}`"),
                ))
            }
        };
        // A new math region can carry its presentation line breaks in the same undo step
        //: insert it, then set the breaks on it.
        let insert = EditCommand::Insert {
            region: stored,
            index: usize::MAX,
        };
        let command = if breaks.is_empty() {
            insert
        } else {
            EditCommand::Batch {
                commands: vec![
                    insert,
                    EditCommand::SetMath {
                        region_id: region_id.clone(),
                        text: text.unwrap_or("\u{25a1}").to_owned(),
                        breaks,
                    },
                ],
            }
        };
        session.apply_edit(&root, "Add region", command)?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            Some(region_id),
            Some("Add region".into()),
        ))
    }

    /// The canonical math text of a statement sent by the math editor as AST JSON (the
    /// serde form of `equavela_core::ast::Statement`): normalized (N1 parentheses, names)
    /// and printed. The text then goes through the ordinary parse-and-apply path, so the
    /// Rust parser stays the authority on what a region may contain.
    pub fn statement_text(statement: Value) -> Result<String, CommandError> {
        let mut statement: Statement = serde_json::from_value(statement)
            .map_err(|error| CommandError::new("parse", format!("invalid math: {error}")))?;
        normalize_statement(&mut statement);
        Ok(print_statement(&statement))
    }

    /// Adds a math region from the editor's AST (one undo step).
    pub fn add_math_region(
        &self,
        id: &str,
        page: u32,
        x: f64,
        y: f64,
        statement: Value,
    ) -> Result<EditResult, CommandError> {
        self.add_math_region_with_breaks(id, page, x, y, statement, Vec::new())
    }

    /// [`add_math_region`](Self::add_math_region) with the presentation-only line breaks of the
    /// new region, in the same undo step as the insertion.
    pub fn add_math_region_with_breaks(
        &self,
        id: &str,
        page: u32,
        x: f64,
        y: f64,
        statement: Value,
        breaks: Vec<equavela_core::layout::MathBreak>,
    ) -> Result<EditResult, CommandError> {
        let text = Self::statement_text(statement)?;
        self.add_region_inner(id, "math", page, x, y, Some(&text), false, breaks)
    }

    /// Evaluate from an immutable scope snapshot. The worksheet stays editable during the request.
    pub fn fast_symbolic(
        &self,
        id: &str,
        input: equavela_core::session::FastSymbolicInput,
    ) -> Result<Value, CommandError> {
        use equavela_core::symbolic::SymbolicOutcome;
        let worksheet = self.worksheet(id)?;
        let (request, kernel) = {
            let session = lock(&worksheet.session);
            let request = session
                .prepare_fast_symbolic(&input)
                .map_err(|message| CommandError::new("symbolic", message))?;
            (request, Arc::clone(session.kernel()))
        };
        let result = kernel
            .symbolic(&request)
            .map_err(|error| CommandError::new("symbolic", error.to_string()))?;
        if let SymbolicOutcome::Error(error) = &result {
            return Err(CommandError::new("symbolic", &error.message));
        }
        let expr = result
            .expr()
            .ok_or_else(|| CommandError::internal("The symbolic result has no expression"))?;
        serde_json::to_value(equavela_core::session::fast_symbolic_result(
            &input,
            expr.clone(),
        ))
        .map_err(|error| CommandError::internal(error.to_string()))
    }

    /// Replaces the math of a region of the root document with the editor's AST. One
    /// committed edit is one undo step.
    pub fn set_math(
        &self,
        id: &str,
        region_id: &str,
        statement: Value,
    ) -> Result<EditResult, CommandError> {
        self.set_math_with_breaks(id, region_id, statement, Vec::new())
    }

    /// [`set_math`](Self::set_math) with the presentation-only line breaks of the region.
    pub fn set_math_with_breaks(
        &self,
        id: &str,
        region_id: &str,
        statement: Value,
        breaks: Vec<equavela_core::layout::MathBreak>,
    ) -> Result<EditResult, CommandError> {
        let text = Self::statement_text(statement)?;
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.edit_math_with_breaks(&root, region_id, &text, breaks)?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Edit math".into()),
        ))
    }

    /// Rewrites several regions in one undo step: each rewrite
    /// is the math of a math region (a statement, as `set_math` takes it) or the value of a text
    /// region (as `set_text` takes it).
    pub fn replace_regions(
        &self,
        id: &str,
        rewrites: Vec<RegionRewrite>,
    ) -> Result<EditResult, CommandError> {
        let mut commands = Vec::with_capacity(rewrites.len());
        for rewrite in rewrites {
            commands.push(match (rewrite.statement, rewrite.paragraphs) {
                (Some(statement), None) => EditCommand::SetMath {
                    region_id: rewrite.region_id,
                    text: Self::statement_text(statement)?,
                    breaks: Vec::new(),
                },
                (None, Some(paragraphs)) => EditCommand::SetText {
                    region_id: rewrite.region_id,
                    text: Self::text_of_value(paragraphs)?,
                },
                _ => {
                    return Err(CommandError::new(
                        "region",
                        "a rewrite holds either the math or the text of a region",
                    ))
                }
            });
        }
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(&root, "Replace", EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Replace".into()),
        ))
    }

    /// The canonical linear text of a text value sent by the text editor (runs as JSON;
    /// inline math carries its AST). Printing and normalizing happen in Rust.
    pub fn text_of_value(paragraphs: Value) -> Result<String, CommandError> {
        RichText::from_json(paragraphs)
            .map(|value| value.print())
            .map_err(|message| CommandError::new("parse", message))
    }

    /// Adds a text region from the editor's value (one undo step).
    pub fn add_text_region(
        &self,
        id: &str,
        page: u32,
        x: f64,
        y: f64,
        paragraphs: Value,
        full_width: bool,
    ) -> Result<EditResult, CommandError> {
        let text = Self::text_of_value(paragraphs)?;
        self.add_region_inner(id, "text", page, x, y, Some(&text), full_width, Vec::new())
    }

    /// Replaces the text of a text region with the editor's value. One committed edit is
    /// one undo step.
    pub fn set_text(
        &self,
        id: &str,
        region_id: &str,
        paragraphs: Value,
    ) -> Result<EditResult, CommandError> {
        let text = Self::text_of_value(paragraphs)?;
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Edit text",
            EditCommand::SetText {
                region_id: region_id.to_owned(),
                text,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Edit text".into()),
        ))
    }

    /// The canonical linear text of a statement (the clipboard form of math): the editor sends
    /// the AST, Rust normalizes and prints it.
    pub fn print_math(statement: Value) -> Result<String, CommandError> {
        Self::statement_text(statement)
    }

    /// The canonical linear text of a list of call arguments, `a, b` (serde form of `ast::Arg`):
    /// the clipboard form of a run of arguments. Like `print_math`, Rust
    /// normalizes and prints it.
    pub fn print_math_args(args: Value) -> Result<String, CommandError> {
        let mut args: Vec<Arg> = serde_json::from_value(args)
            .map_err(|error| CommandError::new("parse", format!("invalid math: {error}")))?;
        for arg in &mut args {
            match arg {
                Arg::Expr { expr } => normalize_expr(expr),
                Arg::InlineDef { target, value, .. } => {
                    normalize_target(target);
                    normalize_expr(value);
                }
            }
        }
        Ok(print_arguments(&args))
    }

    /// Parses linear math text as a list of call arguments (serde form of `Vec<ast::Arg>`): the
    /// clipboard form of a run of arguments. A syntax error is a `parse`
    /// error with its position.
    pub fn parse_math_args(text: &str) -> Result<Value, CommandError> {
        let args = parse_arguments(text.trim()).map_err(SessionError::Parse)?;
        serde_json::to_value(&args)
            .map_err(|error| CommandError::new("parse", format!("cannot encode the math: {error}")))
    }

    /// Parses linear math text (pasted text) to the canonical AST (serde form of
    /// `ast::Statement`). A syntax error is a `parse` error with its position.
    pub fn parse_math(text: &str) -> Result<Value, CommandError> {
        let statement = parse_statement(text.trim()).map_err(SessionError::Parse)?;
        serde_json::to_value(&statement)
            .map_err(|error| CommandError::new("parse", format!("cannot encode the math: {error}")))
    }

    /// Pastes regions given as a snippet of the worksheet `regions:` list (the clipboard form
    /// of regions): fresh ids, the group's top-left corner placed at `(x, y)` of `page`, one
    /// undo step. The bytes of the images in the snippet travel with it and land in
    /// the worksheet's `resources` in the same undo step. A text that is not such a
    /// snippet is a `paste` error.
    pub fn paste_regions(
        &self,
        id: &str,
        page: u32,
        x: f64,
        y: f64,
        snippet: &str,
    ) -> Result<EditResult, CommandError> {
        let not_regions = |message: String| CommandError::new("paste", message);
        let document =
            DocumentId::new("/clipboard.eqv").map_err(|error| not_regions(error.to_string()))?;
        let loaded = equavela_core::worksheet_file::parse_document(
            document,
            &format!("format: equavela-worksheet/3\nregions:\n{snippet}"),
        )
        .map_err(|error| not_regions(error.to_string()))?;
        // A clipboard snippet carries bytes; a project file reference would not travel.
        if let Some(asset) = loaded.document.assets.values().next() {
            return Err(not_regions(format!(
                "the clipboard names the project file `{}` instead of carrying the image",
                asset.path
            )));
        }
        let snippet_resources = loaded.document.resources;
        let regions = loaded.document.regions;
        if regions.is_empty() {
            return Err(not_regions("the clipboard holds no regions".into()));
        }
        let first_page = regions.iter().map(|r| r.page()).min().unwrap_or(1);
        let left = regions
            .iter()
            .filter(|r| r.page() == first_page)
            .map(|r| r.x())
            .fold(f64::INFINITY, f64::min);
        let top = regions
            .iter()
            .filter(|r| r.page() == first_page)
            .map(|r| r.y())
            .fold(f64::INFINITY, f64::min);
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let mut commands = Vec::with_capacity(regions.len());
        let mut resource_ids: HashMap<String, String> = HashMap::new();
        {
            let document = session
                .project()
                .document(&root)
                .expect("the root document is loaded");
            let mut placer = ImagePlacer::new(document);
            for region in &regions {
                let DocumentRegion::Image(image) = region.as_ref() else {
                    continue;
                };
                if resource_ids.contains_key(&image.resource) {
                    continue;
                }
                // A snippet carries the bytes of its images: identical bytes are one
                // resource, an id this worksheet uses for other bytes gets a fresh one,
                // and a resource the worksheet does not have is added.
                let stored = snippet_resources
                    .get(&image.resource)
                    .expect("the reader refused a snippet with a missing resource");
                let (target, added) =
                    placer.place(document, stored, "image", Some(&image.resource))?;
                commands.extend(added);
                resource_ids.insert(image.resource.clone(), target);
            }
        }
        let mut last = None;
        let mut pasted = Vec::new();
        for region in regions {
            let mut region = Arc::unwrap_or_clone(region);
            let new_id = session.new_region_id(&root);
            let math_text = loaded.texts.get(region.id()).cloned();
            let target_page = page + (region.page() - first_page);
            region.set_position(target_page, x + (region.x() - left), y + (region.y() - top));
            match &mut region {
                DocumentRegion::Math(r) => r.id = new_id.clone(),
                DocumentRegion::Include(r) => r.id = new_id.clone(),
                DocumentRegion::Text(r) => r.id = new_id.clone(),
                DocumentRegion::Plot(r) => r.id = new_id.clone(),
                DocumentRegion::Image(r) => r.id = new_id.clone(),
                DocumentRegion::Area(r) => r.id = new_id.clone(),
            }
            if let DocumentRegion::Image(image) = &mut region {
                let target = resource_ids
                    .get(&image.resource)
                    .expect("every pasted image was given a resource")
                    .clone();
                image.resource = target;
            }
            pasted.push(new_id.clone());
            last = Some(new_id);
            commands.push(EditCommand::Insert {
                region: StoredRegion { region, math_text },
                index: usize::MAX,
            });
        }
        // A pasted region taller than the band it lands in grows the band.
        commands.push(EditCommand::HoldMembers { region_ids: pasted });
        session.apply_edit(&root, "Paste", EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            last,
            Some("Paste".into()),
        ))
    }

    /// Moves regions (one undo step for the whole drag).
    pub fn move_regions(
        &self,
        id: &str,
        moves: Vec<RegionMove>,
        area_heights: Vec<AreaHeight>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let label = if moves.len() == 1 && area_heights.is_empty() {
            "Move region"
        } else {
            "Move regions"
        };
        // A line inserted or removed inside an area moves the content after it and changes the
        // band in the same undo step. A shrinking band is resized before the moves and a
        // growing one after them, so the band never overlaps the area that moves with the content.
        let mut shrink = Vec::new();
        let mut grow = Vec::new();
        for change in area_heights {
            let current = session
                .project()
                .document(&root)
                .and_then(|document| {
                    document
                        .regions
                        .iter()
                        .find_map(|region| match region.as_ref() {
                            DocumentRegion::Area(area) if area.id == change.region_id => {
                                Some(area.clone())
                            }
                            _ => None,
                        })
                })
                .ok_or_else(|| {
                    CommandError::new("area", format!("`{}` is not an area", change.region_id))
                })?;
            let command = EditCommand::SetArea {
                region_id: change.region_id,
                title: current.title.clone(),
                height: change.height,
                collapsed: current.collapsed,
            };
            if change.height < current.height {
                shrink.push(command);
            } else {
                grow.push(command);
            }
        }
        // A drag that drops a region into a band grows the band to hold it; a line
        // inserted or removed inside a band sets the band itself.
        let held = if shrink.is_empty() && grow.is_empty() {
            moves.iter().map(|m| m.region_id.clone()).collect()
        } else {
            Vec::new()
        };
        let mut commands = shrink;
        commands.extend(moves.into_iter().map(move_command));
        commands.extend(grow);
        if !held.is_empty() {
            commands.push(EditCommand::HoldMembers { region_ids: held });
        }
        session.apply_edit(&root, label, EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Ends the page at `y` and moves the content at or below the caret line onto the next page:
    /// one undo step, "Add page break". The shift of the flow is the
    /// frontend's (`app/src/layout/lines.ts`), which sends the moves that come with the break.
    pub fn add_page_break(
        &self,
        id: &str,
        page: u32,
        y: f64,
        moves: Vec<RegionMove>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let mut commands: Vec<EditCommand> = moves.into_iter().map(move_command).collect();
        commands.push(EditCommand::AddPageBreak { page, y });
        session.apply_edit(&root, "Add page break", EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Add page break".into()),
        ))
    }

    /// Removes the break of `page` and moves the content at or after it back up by the space the
    /// break made free: one undo step, "Remove page break". The move comes from the
    /// frontend, like the one of `add_page_break`.
    pub fn remove_page_break(
        &self,
        id: &str,
        page: u32,
        moves: Vec<RegionMove>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let mut commands: Vec<EditCommand> = moves.into_iter().map(move_command).collect();
        commands.push(EditCommand::RemovePageBreak { page });
        session.apply_edit(&root, "Remove page break", EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Remove page break".into()),
        ))
    }

    /// Sets (or with `None` clears) the result-format override of a math region: keys of
    /// the `format.*` display settings. One undo step.
    pub fn set_result_format(
        &self,
        id: &str,
        region_id: &str,
        format: Option<BTreeMap<String, String>>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Result format",
            EditCommand::SetResultFormat {
                region_id: region_id.to_owned(),
                format,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Result format".into()),
        ))
    }

    /// Sets the math font of the given math regions: every region
    /// gets the display override it is given, so one command covers several regions and is one
    /// undo step, labelled `Math font`, or `Reset math style` for a reset. The font is
    /// part of the region display override, so the values are written
    /// by the result-format command of and a region of another kind is refused by the core.
    pub fn set_math_font(
        &self,
        id: &str,
        edits: Vec<MathFontEdit>,
        reset: bool,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let label = if reset {
            "Reset math style"
        } else {
            "Math font"
        };
        let commands = edits
            .into_iter()
            .map(|edit| EditCommand::SetResultFormat {
                region_id: edit.region_id,
                format: edit.format,
            })
            .collect();
        session.apply_edit(&root, label, EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Sets (`Some`) or removes (`None`) entries of the worksheet `settings:` mapping: the
    /// worksheet-wide result-format defaults, keys of the `format.*`
    /// display settings. Display only: no result is invalidated. One undo step.
    pub fn set_result_defaults(
        &self,
        id: &str,
        values: BTreeMap<String, Option<String>>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Worksheet format",
            EditCommand::SetResultDefaults { values },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Worksheet format".into()),
        ))
    }

    /// Sets (`Some`) or removes (`None`) entries of the worksheet `settings:` mapping: the
    /// worksheet-wide label styles, keys of the form
    /// `label-style.<label>.<property>`. Display only: no result is
    /// invalidated. One undo step, labelled `Label styles`.
    pub fn set_label_styles(
        &self,
        id: &str,
        values: BTreeMap<String, Option<String>>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Label styles",
            EditCommand::SetLabelStyles { values },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Label styles".into()),
        ))
    }

    /// Replaces the code of a Julia block; its `using` and `import` follow from the code.
    /// One undo step, none when nothing changes.
    pub fn set_julia_code(
        &self,
        id: &str,
        region_id: &str,
        code: &str,
    ) -> Result<EditResult, CommandError> {
        self.julia_edit(
            id,
            "Edit Julia code",
            EditCommand::SetJulia {
                region_id: region_id.to_owned(),
                code: code.to_owned(),
            },
        )
    }

    /// Plays or stops a Julia block; one undo step.
    pub fn set_julia_playing(
        &self,
        id: &str,
        region_id: &str,
        playing: bool,
    ) -> Result<EditResult, CommandError> {
        let label = if playing {
            "Play Julia block"
        } else {
            "Stop Julia block"
        };
        self.julia_edit(
            id,
            label,
            EditCommand::SetJuliaPlaying {
                region_id: region_id.to_owned(),
                playing,
            },
        )
    }

    /// Run: the next pass evaluates the region and its dependents
    /// again, whatever the calculation mode. It changes nothing in the worksheet.
    pub fn run_region(&self, id: &str, region_id: &str) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.rerun_region(&root, region_id)?;
        Ok(Self::edit_result(&worksheet, &session, None, None))
    }

    /// Sets the size in points of the box a Julia block is drawn in, or `None` for a block that
    /// grows with its content: screen and print alike, one undo
    /// step, and none when the box already has that size.
    pub fn set_julia_size(
        &self,
        id: &str,
        region_id: &str,
        size: Option<(f64, f64)>,
    ) -> Result<EditResult, CommandError> {
        self.julia_edit(
            id,
            "Resize Julia block",
            held(
                EditCommand::SetJuliaSize {
                    region_id: region_id.to_owned(),
                    size,
                },
                region_id,
            ),
        )
    }

    fn julia_edit(
        &self,
        id: &str,
        label: &str,
        command: EditCommand,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(&root, label, command)?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Disables the given regions - they are no longer calculated - or enables them again.
    /// One undo step, labelled
    /// `Disable region` or `Enable region`, whatever the number of regions.
    pub fn set_regions_enabled(
        &self,
        id: &str,
        region_ids: Vec<String>,
        enabled: bool,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let label = if enabled {
            "Enable region"
        } else {
            "Disable region"
        };
        let commands = region_ids
            .into_iter()
            .map(|region_id| EditCommand::SetEnabled { region_id, enabled })
            .collect();
        session.apply_edit(&root, label, EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Replaces the page setup of the worksheet; the
    /// regions that would sit in the new left or top margin move with it. One undo step.
    pub fn set_page_setup(&self, id: &str, page: PageSetup) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(&root, "Page setup", EditCommand::SetPageSetup { page })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Page setup".into()),
        ))
    }

    /// Sets (`Some`) or removes (`None`) the worksheet calculation settings, the two tolerances
    /// `TOL` and `CTOL`. One undo step, and **not** display only:
    /// every region becomes out of date and is recalculated with the new tolerance (`calc_needed`
    /// in the result tells the frontend to start the pass when calculation is automatic).
    pub fn set_calculation_settings(
        &self,
        id: &str,
        values: BTreeMap<String, Option<String>>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Calculation settings",
            EditCommand::SetCalculationSettings { values },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Calculation settings".into()),
        ))
    }

    /// Sets the width in points of a region with an adjustable width (text regions), or
    /// resets it to the default with `None`. One undo step.
    pub fn set_region_width(
        &self,
        id: &str,
        region_id: &str,
        width: Option<f64>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Resize region",
            EditCommand::SetWidth {
                region_id: region_id.to_owned(),
                width,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Resize region".into()),
        ))
    }

    /// Sets (or with `None` clears) the spelling language of a text region; one undo step.
    pub fn set_text_language(
        &self,
        id: &str,
        region_id: &str,
        language: Option<String>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Text language",
            EditCommand::SetTextLanguage {
                region_id: region_id.to_owned(),
                language,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Text language".into()),
        ))
    }

    /// Sets (`Some`) or removes (`None`) the spelling keys of the worksheet, `spelling.language`
    /// and `spelling.ignore`. Display only; one undo step.
    pub fn set_spelling(
        &self,
        id: &str,
        values: BTreeMap<String, Option<String>>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(&root, "Spelling", EditCommand::SetSpelling { values })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Spelling".into()),
        ))
    }

    /// Sets (or with `None` clears) the fill of a text region as `#rrggbb`; one undo step.
    pub fn set_text_background(
        &self,
        id: &str,
        region_id: &str,
        background: Option<String>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Text background",
            EditCommand::SetTextBackground {
                region_id: region_id.to_owned(),
                background,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Text background".into()),
        ))
    }

    /// Replaces the specification of a plot region (expressions, axes, presentation, size);
    /// validated by the core. One undo step.
    pub fn set_plot(
        &self,
        id: &str,
        region_id: &str,
        plot: PlotSpec,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Edit plot",
            held(
                EditCommand::SetPlot {
                    region_id: region_id.to_owned(),
                    plot: Box::new(plot),
                },
                region_id,
            ),
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Edit plot".into()),
        ))
    }

    /// Replaces the path of an include region (GitHub ): the text the user typed, stored as
    /// says (`/` separators, relative to the worksheet's folder when it is an absolute path below a
    /// common root). The new target is read when it exists; one undo step.
    pub fn set_include_path(
        &self,
        id: &str,
        region_id: &str,
        path: &str,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let typed = path.trim();
        let stored =
            if is_absolute_path(&typed.replace('\\', "/")) && is_absolute_path(root.as_str()) {
                let base = path_for_document(&root).parent().map(Path::to_path_buf);
                crate::include_path(base.as_deref(), Path::new(typed))
            } else {
                typed.replace('\\', "/")
            };
        session.apply_edit(
            &root,
            "Edit include path",
            EditCommand::SetIncludePath {
                region_id: region_id.to_owned(),
                path: stored,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Edit include path".into()),
        ))
    }

    /// Stores (`Some` ends) or clears (`None`) the transient on-screen x range of a plot region,
    /// which is the sample interval of every implicit x trace the user navigated the plot over.
    /// Screen-only: not an undo step and never written to the
    /// worksheet. Returns whether the range moved, so the frontend only starts a calculation when
    /// the plot has something new to draw; a half range (one end only) is not a view, and clears
    /// it like `None`.
    pub fn set_plot_view(
        &self,
        id: &str,
        region_id: &str,
        x_min: Option<f64>,
        x_max: Option<f64>,
    ) -> Result<bool, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let view = match (x_min, x_max) {
            (Some(min), Some(max)) => ViewRange::sample(min, max),
            _ => None,
        };
        Ok(session.set_plot_view(&root, region_id, view)?)
    }

    /// Adds an image region from the bytes of an SVG, PNG or JPEG file: an
    /// SVG is sanitized, the size is the natural size fitted to the printable width, and
    /// the resource and the region are one undo step. Identical bytes share one resource.
    pub fn add_image(
        &self,
        id: &str,
        bytes: &[u8],
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<ImageAdded, CommandError> {
        self.add_image_named(id, bytes, "image", page, x, y)
    }

    /// Like [`Service::add_image`]; `stem` names the project asset a project worksheet stores
    /// the bytes in.
    fn add_image_named(
        &self,
        id: &str,
        bytes: &[u8],
        stem: &str,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<ImageAdded, CommandError> {
        let (resource, removed) = resource_from_bytes(bytes)
            .map_err(|error| CommandError::new("image", error.to_string()))?;
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let document = session
            .project()
            .document(&root)
            .expect("the root document is loaded");
        let (left, right) = (
            document.page.margins.left,
            document.page.width - document.page.margins.right,
        );
        let size = initial_size_pt(natural_size_pt(&resource), right - left);
        let (resource_id, added) =
            ImagePlacer::new(document).place(document, &resource, stem, None)?;
        // The image starts inside the printable width, and on the next page when it does not fit
        // above the bottom margin.
        let x = x.min(right - size[0]).max(left);
        let (top, bottom) = (
            document.page.margins.top,
            document.page.height - document.page.margins.bottom,
        );
        let (page, y) = if y + size[1] > bottom && size[1] <= bottom - top && y >= top {
            (page + 1, top)
        } else {
            (page, y)
        };
        let region_id = session.new_region_id(&root);
        let mut commands: Vec<EditCommand> = added.into_iter().collect();
        commands.push(EditCommand::Insert {
            region: StoredRegion {
                region: DocumentRegion::Image(ImageRegion {
                    id: region_id.clone(),
                    page,
                    x,
                    y,
                    enabled: true,
                    resource: resource_id,
                    size,
                }),
                math_text: None,
            },
            index: usize::MAX,
        });
        session.apply_edit(&root, "Add image", EditCommand::Batch { commands })?;
        Ok(ImageAdded {
            edit: Self::edit_result(
                &worksheet,
                &session,
                Some(region_id),
                Some("Add image".into()),
            ),
            removed_parts: removed.len(),
        })
    }

    /// Adds an image region from a file on disk.
    pub fn add_image_file(
        &self,
        id: &str,
        path: &Path,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<ImageAdded, CommandError> {
        let bytes = std::fs::read(path).map_err(|error| {
            CommandError::new("image", format!("cannot read {}: {error}", path.display()))
        })?;
        self.add_image_named(id, &bytes, &image_stem(path), page, x, y)
    }

    /// Sets the size in points of an image region (the UI keeps the aspect ratio); one undo step.
    pub fn set_image_size(
        &self,
        id: &str,
        region_id: &str,
        width: f64,
        height: f64,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        session.apply_edit(
            &root,
            "Resize image",
            held(
                EditCommand::SetImageSize {
                    region_id: region_id.to_owned(),
                    size: [width, height],
                },
                region_id,
            ),
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Resize image".into()),
        ))
    }

    /// Sets the size of an image region back to the size of the picture it shows; one
    /// undo step, or none when the size is already that one.
    pub fn original_image_size(
        &self,
        id: &str,
        region_id: &str,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let (current, size) = {
            let document = session
                .project()
                .document(&root)
                .expect("the root document is loaded");
            let image = image_region(document, region_id)?;
            let resource = image_resource(document, image)?;
            (image.size, fitted_image_size(document, &resource, image.x))
        };
        let label = if current == size {
            None
        } else {
            session.apply_edit(
                &root,
                "Original size",
                EditCommand::SetImageSize {
                    region_id: region_id.to_owned(),
                    size,
                },
            )?;
            Some("Original size".to_owned())
        };
        Ok(Self::edit_result(&worksheet, &session, None, label))
    }

    /// Replaces the picture of an image region with the one in `path`: the region keeps its
    /// id, page and position, its size follows, and the old resource goes when no region
    /// uses it any more. One undo step ("Replace image"); a refused file changes nothing.
    pub fn replace_image(
        &self,
        id: &str,
        region_id: &str,
        path: &Path,
    ) -> Result<ImageAdded, CommandError> {
        let bytes = std::fs::read(path).map_err(|error| {
            CommandError::new("image", format!("cannot read {}: {error}", path.display()))
        })?;
        self.replace_image_named(id, region_id, &bytes, &image_stem(path))
    }

    /// Like [`Service::replace_image`], with the file content in memory.
    pub fn replace_image_bytes(
        &self,
        id: &str,
        region_id: &str,
        bytes: &[u8],
    ) -> Result<ImageAdded, CommandError> {
        self.replace_image_named(id, region_id, bytes, "image")
    }

    fn replace_image_named(
        &self,
        id: &str,
        region_id: &str,
        bytes: &[u8],
        stem: &str,
    ) -> Result<ImageAdded, CommandError> {
        let (resource, removed) = resource_from_bytes(bytes)
            .map_err(|error| CommandError::new("image", error.to_string()))?;
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let mut commands = Vec::new();
        {
            let document = session
                .project()
                .document(&root)
                .expect("the root document is loaded");
            let image = image_region(document, region_id)?;
            let size = fitted_image_size(document, &resource, image.x);
            // Identical bytes keep their resource; otherwise the picture gets a
            // new one and the old one is dropped once nothing shows it.
            let (resource_id, added) =
                ImagePlacer::new(document).place(document, &resource, stem, None)?;
            commands.extend(added);
            if image.resource != resource_id {
                let still_used = document.regions.iter().any(|region| {
                    matches!(
                        region.as_ref(),
                        DocumentRegion::Image(other)
                            if other.id != region_id && other.resource == image.resource
                    )
                });
                commands.push(EditCommand::SetImageResource {
                    region_id: region_id.to_owned(),
                    resource: resource_id,
                });
                if !still_used {
                    let id = image.resource.clone();
                    commands.push(if document.assets.contains_key(&id) {
                        EditCommand::DropAsset { id }
                    } else {
                        EditCommand::DropResource { id }
                    });
                }
            }
            if image.size != size {
                commands.push(EditCommand::SetImageSize {
                    region_id: region_id.to_owned(),
                    size,
                });
            }
        }
        if !commands.is_empty() {
            session.apply_edit(&root, "Replace image", EditCommand::Batch { commands })?;
        }
        Ok(ImageAdded {
            edit: Self::edit_result(
                &worksheet,
                &session,
                Some(region_id.to_owned()),
                Some("Replace image".into()),
            ),
            removed_parts: removed.len(),
        })
    }

    /// The bytes of an image resource as a `data:` URL, for an `<img>` element.
    pub fn image_data_url(&self, id: &str, resource: &str) -> Result<String, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        let document = session
            .project()
            .document(session.root())
            .expect("the root document is loaded");
        if !document.has_resource(resource) {
            return Err(CommandError::new(
                "region",
                format!("no image resource `{resource}`"),
            ));
        }
        let stored = resource_bytes(document, resource)?;
        Ok(format!(
            "data:{};base64,{}",
            stored.media.mime(),
            base64_encode(&stored.data)
        ))
    }

    /// Like [`Service::add_image`], with the file content as base64 (paste and drop).
    pub fn add_image_base64(
        &self,
        id: &str,
        data: &str,
        page: u32,
        x: f64,
        y: f64,
    ) -> Result<ImageAdded, CommandError> {
        let bytes =
            base64_decode(data).map_err(|error| CommandError::new("image", error.to_string()))?;
        self.add_image(id, &bytes, page, x, y)
    }

    /// Sets the title, band height and collapsed flag of an area region; one undo step. `label`
    /// names it in the undo history ("Collapse area", "Expand area", "Edit area").
    pub fn set_area(
        &self,
        id: &str,
        region_id: &str,
        title: String,
        height: f64,
        collapsed: bool,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let before = session.project().document(&root).and_then(|document| {
            document
                .regions
                .iter()
                .find_map(|region| match region.as_ref() {
                    DocumentRegion::Area(area) if area.id == region_id => Some(area.collapsed),
                    _ => None,
                })
        });
        let label = match before {
            Some(was) if was != collapsed && collapsed => "Collapse area",
            Some(was) if was != collapsed => "Expand area",
            _ => "Edit area",
        };
        session.apply_edit(
            &root,
            label,
            EditCommand::SetArea {
                region_id: region_id.to_owned(),
                title,
                height,
                collapsed,
            },
        )?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Deletes regions (one undo step).
    pub fn remove_regions(
        &self,
        id: &str,
        region_ids: Vec<String>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        let label = if region_ids.len() == 1 {
            "Delete region"
        } else {
            "Delete regions"
        };
        let commands = region_ids
            .into_iter()
            .map(|region_id| EditCommand::Remove { region_id })
            .collect();
        session.apply_edit(&root, label, EditCommand::Batch { commands })?;
        Ok(Self::edit_result(
            &worksheet,
            &session,
            None,
            Some(label.into()),
        ))
    }

    /// Undoes the last edit (nothing to undo: the unchanged view and no label).
    pub fn undo(&self, id: &str) -> Result<EditResult, CommandError> {
        self.history_step(id, true)
    }

    /// Repeats the last undone edit.
    pub fn redo(&self, id: &str) -> Result<EditResult, CommandError> {
        self.history_step(id, false)
    }

    fn history_step(&self, id: &str, undo: bool) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let outcome = if undo {
            session.undo()?
        } else {
            session.redo()?
        };
        let label = outcome.map(|(label, _)| label);
        // Undoing or redoing "Change environment" moves the worksheet between kernels.
        let environment = self.sync_environment(&worksheet, &mut session);
        let mut result = Self::edit_result(&worksheet, &session, None, label);
        result.environment = environment;
        Ok(result)
    }

    /// Puts the worksheet on the kernel of the environment it resolves to now and
    /// releases the previous kernel; `Some` with the new environment when it moved.
    fn sync_environment(
        &self,
        worksheet: &OpenWorksheet,
        session: &mut WorksheetSession,
    ) -> Option<EnvironmentSummary> {
        let environment = session.environment();
        let key = kernel_key(&environment.directory);
        let previous = lock(&worksheet.kernel_key).clone();
        if key == previous {
            return None;
        }
        // A running pass still owns the previous manager and interrupt handle.
        lock(&worksheet.interrupt).interrupt();
        let (manager, _) = self.kernel_for(&key);
        session.set_kernel(manager);
        *lock(&worksheet.interrupt) = session.interrupt_handle();
        *lock(&worksheet.kernel_key) = key;
        self.release_kernel(&previous);
        Some(EnvironmentSummary::of(&environment))
    }

    /// Prepare a read-only comparison. One preview per worksheet is retained.
    pub fn preview_environment_switch(
        &self,
        id: &str,
        target: Option<&Path>,
    ) -> Result<EnvironmentSwitchPreview, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        let root = session.root().clone();
        let current_env = session.environment();
        if !is_absolute_path(root.as_str())
            || matches!(
                current_env.kind,
                EnvironmentKind::Project | EnvironmentKind::Archive
            )
        {
            return Err(CommandError::new(
                "environment",
                "only a saved standalone worksheet can change environment",
            ));
        }
        let value = target
            .map(|directory| stored_environment(Path::new(root.as_str()), directory))
            .transpose()?;
        let shared = self
            .shared_environment()
            .ok_or_else(|| CommandError::new("environment", "shared environment is unavailable"))?;
        let target_env = resolve_environment(&root, value.as_deref(), &shared);
        let source_files =
            equavela_core::environment::environment_metadata_fingerprint(&current_env.directory)
                .map_err(|e| CommandError::new("environment", e))?;
        let target_files = environment_metadata_snapshot(&target_env.directory)
            .map_err(|e| CommandError::new("environment", e))?;
        let current_files = read_environment_files(&current_env.directory);
        let files = read_environment_files(&target_env.directory);
        let names: std::collections::BTreeSet<_> = current_files
            .dependencies
            .iter()
            .chain(&files.dependencies)
            .map(|dep| dep.name.clone())
            .collect();
        let differences = names
            .into_iter()
            .filter_map(|name| {
                let current = current_files
                    .dependencies
                    .iter()
                    .find(|dep| dep.name == name);
                let target = files.dependencies.iter().find(|dep| dep.name == name);
                let old = current.and_then(|dep| dep.version.clone());
                let new = target.and_then(|dep| dep.version.clone());
                let requirements_changed = current
                    .zip(target)
                    .is_some_and(|(a, b)| a.compatibility != b.compatibility);
                let identity_changed = current.zip(target).is_some_and(|(a, b)| a.uuid != b.uuid);
                if old == new
                    && current.is_some() == target.is_some()
                    && current.map(|dep| dep.installed) == target.map(|dep| dep.installed)
                    && !requirements_changed
                    && !identity_changed
                {
                    return None;
                }
                let describe = |dep: Option<&equavela_core::environment::EnvironmentDependency>,
                                version: Option<String>| {
                    if !requirements_changed && !identity_changed {
                        return version;
                    }
                    dep.map(|dep| {
                        let mut text = dep.version.clone().unwrap_or_else(|| "unresolved".into());
                        if requirements_changed {
                            text.push_str(&format!(
                                " (requires {})",
                                dep.compatibility.as_deref().unwrap_or("any")
                            ));
                        }
                        if identity_changed {
                            text.push_str(&format!(" (UUID {})", dep.uuid));
                        }
                        text
                    })
                };
                Some(EnvironmentSwitchDifference {
                    name,
                    current: describe(current, old),
                    target: describe(target, new),
                    missing: target.is_none_or(|dep| !dep.installed),
                })
            })
            .collect();
        let token = format!("switch-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let current = EnvironmentSummary::of(&current_env);
        let preview = EnvironmentSwitchPreview {
            token: token.clone(),
            current: current.clone(),
            target: EnvironmentSummary::of(&target_env),
            files,
            differences,
        };
        lock(&self.switch_plans).insert(
            id.to_owned(),
            EnvironmentSwitchPlan {
                token,
                current,
                target_summary: preview.target.clone(),
                target: target.map(Path::to_path_buf),
                source_files,
                target_files,
            },
        );
        Ok(preview)
    }

    /// Start a trusted target before changing the undoable worksheet selection.
    pub fn commit_environment_switch(
        &self,
        id: &str,
        token: &str,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let plan = lock(&self.switch_plans)
            .get(id)
            .filter(|plan| plan.token == token)
            .cloned()
            .ok_or_else(|| {
                CommandError::new("environment", "invalid or expired environment preview")
            })?;
        let root = session.root().clone();
        let current = session.environment();
        let value = plan
            .target
            .as_deref()
            .map(|directory| stored_environment(Path::new(root.as_str()), directory))
            .transpose()?;
        let shared = self
            .shared_environment()
            .ok_or_else(|| CommandError::new("environment", "shared environment is unavailable"))?;
        let target = resolve_environment(&root, value.as_deref(), &shared);
        let validate = || -> Result<(), CommandError> {
            if EnvironmentSummary::of(&current) != plan.current
                || EnvironmentSummary::of(&target) != plan.target_summary
                || equavela_core::environment::environment_metadata_fingerprint(&current.directory)
                    .map_err(|e| CommandError::new("environment", e))?
                    != plan.source_files
                || environment_metadata_snapshot(&target.directory)
                    .map_err(|e| CommandError::new("environment", e))?
                    != plan.target_files
            {
                return Err(CommandError::new(
                    "environment",
                    "environment preview is stale; preview again",
                ));
            }
            Ok(())
        };
        validate()?;
        let key = kernel_key(&target.directory);
        if session.is_trusted() {
            if lock(&self.kernels)
                .get(&key)
                .is_some_and(|kernel| matches!(kernel.status, KernelStatus::Busy))
            {
                return Err(CommandError::new(
                    "environment",
                    "the target environment is busy; stop its calculation before switching",
                ));
            }
            let (manager, error) = self.kernel_for(&key);
            let started = if let Some(error) = error {
                Err(error)
            } else {
                manager.start().map_err(|error| error.to_string())
            };
            match started {
                Ok(info) => self.set_status(&key, KernelStatus::Ready { info }),
                Err(error) => {
                    self.release_kernel(&key);
                    return Err(CommandError::new("kernel", error));
                }
            }
            if let Err(error) = validate() {
                self.release_kernel(&key);
                return Err(error);
            }
        }
        if let Err(error) = session.apply_edit(
            &root,
            "Change environment",
            EditCommand::SetEnvironment { environment: value },
        ) {
            self.release_kernel(&key);
            return Err(error.into());
        }
        let moved = self.sync_environment(&worksheet, &mut session);
        let mut result = Self::edit_result(
            &worksheet,
            &session,
            None,
            Some("Change environment".into()),
        );
        result.environment =
            Some(moved.unwrap_or_else(|| EnvironmentSummary::of(&session.environment())));
        lock(&self.switch_plans).remove(id);
        Ok(result)
    }

    /// Sets (`Some`, a directory) or removes (`None`) the override of a saved standalone
    /// worksheet: one undo step ("Change environment"). The path is stored relative to the
    /// worksheet file when the directory lies under the file's folder, absolute otherwise.
    pub fn set_worksheet_environment(
        &self,
        id: &str,
        directory: Option<&Path>,
    ) -> Result<EditResult, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        if !is_absolute_path(root.as_str()) {
            return Err(CommandError::new(
                "environment",
                "save the worksheet before choosing its Julia environment",
            ));
        }
        if matches!(
            session.environment().kind,
            EnvironmentKind::Project | EnvironmentKind::Archive
        ) {
            return Err(CommandError::new(
                "environment",
                "a worksheet of a project uses the project's environment",
            ));
        }
        let value = match directory {
            Some(directory) => Some(stored_environment(Path::new(root.as_str()), directory)?),
            None => None,
        };
        let label = "Change environment";
        session.apply_edit(
            &root,
            label,
            EditCommand::SetEnvironment { environment: value },
        )?;
        let moved = self.sync_environment(&worksheet, &mut session);
        let mut result = Self::edit_result(&worksheet, &session, None, Some(label.into()));
        result.environment =
            Some(moved.unwrap_or_else(|| EnvironmentSummary::of(&session.environment())));
        Ok(result)
    }

    /// Copies environment metadata without executing Julia, then selects it as an undoable override.
    pub fn copy_worksheet_environment(
        &self,
        id: &str,
        destination: &Path,
    ) -> Result<EditResult, CommandError> {
        if !destination.is_absolute() {
            return Err(CommandError::new(
                "environment",
                "choose an absolute destination directory",
            ));
        }
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let mut session = lock(&worksheet.session);
        let root = session.root().clone();
        if !is_absolute_path(root.as_str())
            || matches!(
                session.environment().kind,
                EnvironmentKind::Project | EnvironmentKind::Archive
            )
        {
            return Err(CommandError::new(
                "environment",
                "only a saved standalone worksheet can select a copied environment",
            ));
        }
        let source = session.environment_directory().ok_or_else(|| {
            CommandError::new("environment", "the environment is not a directory")
        })?;
        equavela_core::environment_copy::copy_environment(&source, destination)
            .map_err(|error| CommandError::new("environment", error.to_string()))?;
        let value = stored_environment(Path::new(root.as_str()), destination).map_err(|error| {
            CommandError::new(
                "environment",
                format!(
                    "environment copied to {}, but selection failed: {}",
                    destination.display(),
                    error.message
                ),
            )
        })?;
        session.apply_edit(
            &root,
            "Copy environment",
            EditCommand::SetEnvironment {
                environment: Some(value),
            },
        )?;
        let moved = self.sync_environment(&worksheet, &mut session);
        let mut result =
            Self::edit_result(&worksheet, &session, None, Some("Copy environment".into()));
        result.environment =
            Some(moved.unwrap_or_else(|| EnvironmentSummary::of(&session.environment())));
        Ok(result)
    }

    /// Adds (`remove` false) or removes packages in the worksheet's environment: `Pkg.add`
    /// or `Pkg.rm` in its kernel. Adding downloads code, so it needs a trusted worksheet; the
    /// session is not held while the kernel works. Returns the environment as it is afterwards.
    pub fn change_packages(
        &self,
        id: &str,
        packages: &[String],
        remove: bool,
    ) -> Result<EnvironmentInfo, CommandError> {
        self.modify_environment(id, packages, if remove { "remove" } else { "add" }, None)
    }

    /// Explicit maintenance of the selected environment; never updates implicitly.
    pub fn manage_environment(
        &self,
        id: &str,
        operation: &str,
    ) -> Result<EnvironmentInfo, CommandError> {
        if !matches!(operation, "instantiate" | "resolve" | "update") {
            return Err(CommandError::new(
                "environment",
                "unknown environment operation",
            ));
        }
        self.modify_environment(id, &[], operation, None)
    }

    pub fn set_compatibility(
        &self,
        id: &str,
        package: &str,
        compatibility: &str,
    ) -> Result<EnvironmentInfo, CommandError> {
        self.modify_environment(
            id,
            &[package.to_owned()],
            "compatibility",
            Some(compatibility),
        )
    }

    fn modify_environment(
        &self,
        id: &str,
        packages: &[String],
        operation: &str,
        compatibility: Option<&str>,
    ) -> Result<EnvironmentInfo, CommandError> {
        let refused = |message: &str| CommandError::new("environment", message.to_owned());
        if matches!(operation, "add" | "remove" | "compatibility" | "develop")
            && packages.is_empty()
        {
            return Err(refused("name at least one package"));
        }
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let (manager, directory, key, is_shared) = {
            let session = lock(&worksheet.session);
            if !session.is_trusted() {
                return Err(refused(
                    "the worksheet is not trusted: trust it before changing its packages",
                ));
            }
            let environment = session.environment();
            if !environment.usable() || environment.directory.as_os_str().is_empty() {
                return Err(refused(
                    "the worksheet's Julia environment is not a directory",
                ));
            }
            (
                Arc::clone(session.kernel()),
                environment.directory,
                lock(&worksheet.kernel_key).clone(),
                environment.kind == EnvironmentKind::Shared,
            )
        };
        // The shared environment is created when first needed.
        std::fs::create_dir_all(&directory)
            .map_err(|error| refused(&format!("{}: {error}", directory.display())))?;
        // the metadata is on disk before Julia runs.
        let store = self.snapshots();
        if let Some(store) = &store {
            store
                .begin(&directory, operation, packages)
                .map_err(|error| refused(&error))?;
        }
        let info = match manager.start() {
            Ok(info) => info,
            Err(error) => {
                // Nothing changed: the snapshot is not needed.
                if let Some(store) = &store {
                    let _ = store.discard(&directory);
                }
                return Err(CommandError::new("kernel", error.to_string()));
            }
        };
        self.set_status(&key, KernelStatus::Ready { info });
        let path = directory.to_string_lossy();
        let outcome = (|| {
            let result = match operation {
                "remove" => manager.remove_packages(&path, packages),
                "add" => manager.install_packages(&path, packages),
                "develop" => manager.develop_packages(&path, packages),
                "compatibility" => manager.set_compatibility(
                    &path,
                    &packages[0],
                    compatibility.unwrap_or_default(),
                ),
                _ => {
                    let project = directory.join("Project.toml");
                    if is_shared
                        && !project.is_file()
                        && !directory.join("JuliaProject.toml").is_file()
                    {
                        // Write inside the snapshot so undo can restore an uninitialized environment.
                        match std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&project)
                        {
                            Ok(mut file) => {
                                use std::io::Write;
                                file.write_all(b"[deps]\n")
                                    .map_err(|error| format!("{}: {error}", project.display()))?;
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                            Err(error) => return Err(format!("{}: {error}", project.display())),
                        }
                    }
                    manager.manage_environment(&path, operation)
                }
            };
            result.map_err(|error| error.to_string())
        })();
        if let Err(error) = outcome {
            // the files go back as they were; a failed restore leaves it interrupted.
            let restored = match &store {
                Some(store) => match store.restore(&directory) {
                    Ok(()) => "; the environment files were restored".to_owned(),
                    Err(problem) => format!(
                        "; the environment files could not be restored ({problem}), the change is kept as interrupted"
                    ),
                },
                None => String::new(),
            };
            let _ = self.after_environment_change(&key, &manager);
            return Err(CommandError::new(
                "environment",
                format!("{error}{restored}"),
            ));
        }
        if let Some(store) = &store {
            store.finish(&directory).map_err(|error| refused(&error))?;
        }
        self.after_environment_change(&key, &manager)?;
        self.environment_info(id)
    }

    /// The snapshots of environment metadata, beside Equavela's environments.
    fn snapshots(&self) -> Option<SnapshotStore> {
        lock(&self.environments)
            .as_ref()
            .map(|paths| SnapshotStore::new(paths.root.join(".snapshots")))
    }

    /// After the metadata of the environment of kernel `key` changed: every open worksheet of
    /// it recalculates what depended on packages, and the kernel restarts.
    fn after_environment_change(
        &self,
        key: &Path,
        manager: &Arc<KernelManager>,
    ) -> Result<(), CommandError> {
        // Every open worksheet of that environment recalculates what failed on a package.
        let sharing: Vec<_> = lock(&self.worksheets)
            .values()
            .filter(|open| *lock(&open.kernel_key) == key)
            .cloned()
            .collect();
        for open in sharing {
            lock(&open.session).packages_changed();
        }
        // Julia retains loaded package modules even after Pkg changes their versions.
        // A fresh worksheet module alone cannot pick up an updated package implementation.
        self.set_status(key, KernelStatus::Starting);
        match manager.restart() {
            Ok(info) => {
                self.set_status(key, KernelStatus::Ready { info });
                Ok(())
            }
            Err(error) => {
                self.set_status(
                    key,
                    KernelStatus::Crashed {
                        message: error.to_string(),
                    },
                );
                Err(CommandError::new("kernel", error.to_string()))
            }
        }
    }

    /// Restart kernel: the kernel of the worksheet's environment starts again, and every
    /// worksheet using it recalculates from scratch. No file changes and no trust is needed.
    pub fn restart_environment_kernel(&self, id: &str) -> Result<EnvironmentInfo, CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let manager = Arc::clone(lock(&worksheet.session).kernel());
        let key = lock(&worksheet.kernel_key).clone();
        self.after_environment_change(&key, &manager)?;
        self.environment_info(id)
    }

    /// Undo the last package change, or settle an interrupted one: `restore`
    /// puts the previous metadata back, otherwise the current files are kept. Both need a
    /// trusted worksheet; a restore restarts the kernel.
    pub fn revert_environment_change(
        &self,
        id: &str,
        interrupted: bool,
        restore: bool,
    ) -> Result<EnvironmentInfo, CommandError> {
        let refused = |message: &str| CommandError::new("environment", message.to_owned());
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        let (manager, directory, key) = {
            let session = lock(&worksheet.session);
            if !session.is_trusted() {
                return Err(refused(
                    "the worksheet is not trusted: trust it before changing its packages",
                ));
            }
            let directory = session
                .environment_directory()
                .ok_or_else(|| refused("the worksheet's Julia environment is not a directory"))?;
            (
                Arc::clone(session.kernel()),
                directory,
                lock(&worksheet.kernel_key).clone(),
            )
        };
        let store = self
            .snapshots()
            .ok_or_else(|| refused("Equavela's environments folder is unavailable"))?;
        let found = if interrupted {
            store.interrupted(&directory)
        } else {
            store.undoable(&directory)
        };
        if found.is_none() {
            return Err(refused(if interrupted {
                "no interrupted package change to settle"
            } else {
                "there is no package change to undo"
            }));
        }
        if !restore {
            store.discard(&directory).map_err(|error| refused(&error))?;
            return self.environment_info(id);
        }
        store.restore(&directory).map_err(|error| refused(&error))?;
        self.after_environment_change(&key, &manager)?;
        self.environment_info(id)
    }

    /// The whole state of a worksheet and the revision it has now, and a fresh baseline:
    /// a frontend whose stored revision is not a delta's `base` asks for this and carries on.
    pub fn worksheet_snapshot(&self, id: &str) -> Result<WorksheetSnapshot, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        let view = session
            .view(session.root())
            .expect("the root document is loaded");
        let regions = worksheet.results.snapshot();
        // A new revision, so a frontend still holding the old one cannot accept what follows.
        let mut sent = lock(&worksheet.sent);
        let state = SentState::capture(sent.revision + 1, &view, &regions);
        let revision = state.revision;
        *sent = state;
        Ok(WorksheetSnapshot {
            revision,
            view,
            regions,
        })
    }

    /// The current view of the root document (not available while a calculation runs).
    pub fn view(&self, id: &str) -> Result<DocumentView, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        Ok(session
            .view(session.root())
            .expect("the root document is loaded"))
    }

    /// The calculated data of a plot region as one binary frame:
    /// a `u32` header length, the JSON header, then little-endian `f64` buffers.
    /// Not available while a calculation runs; the UI asks again when the pass finishes.
    pub fn plot_data(&self, id: &str, region_id: &str) -> Result<Vec<u8>, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        let data = session
            .plot_data(session.root(), region_id)
            .ok_or_else(|| CommandError::new("region", format!("no plot region `{region_id}`")))?;
        Ok(data.encode_frame())
    }

    fn worksheet(&self, id: &str) -> Result<Arc<OpenWorksheet>, CommandError> {
        lock(&self.worksheets).get(id).cloned().ok_or_else(|| {
            CommandError::new("unknown_worksheet", format!("no open worksheet `{id}`"))
        })
    }

    fn guard_path(path: &Path) -> Result<Option<project_tree::ProjectGuard>, CommandError> {
        if !path.is_absolute() {
            return Ok(None);
        }
        for root in path.ancestors().skip(1) {
            if root.join("equavela-project.yaml").is_file()
                || root.join(".equavela-trash.json").exists()
            {
                let guard =
                    project_tree::ProjectGuard::acquire(root).map_err(Self::project_error)?;
                crate::project_trash::recover(root).map_err(Self::project_error)?;
                return Ok(Some(guard));
            }
        }
        Ok(None)
    }

    fn guard_worksheet(
        &self,
        id: &str,
        worksheet: &Arc<OpenWorksheet>,
    ) -> Result<Option<project_tree::ProjectGuard>, CommandError> {
        let guard = Self::guard_path(Path::new(worksheet.root.as_str()))?;
        let registered = self.worksheet(id)?;
        if !Arc::ptr_eq(&registered, worksheet) {
            return Err(Self::project_error(
                "worksheet changed while the project operation started".into(),
            ));
        }
        Ok(guard)
    }

    pub fn close_worksheet(&self, id: &str) -> Result<(), CommandError> {
        let worksheet = lock(&self.worksheets).remove(id).ok_or_else(|| {
            CommandError::new("unknown_worksheet", format!("no open worksheet `{id}`"))
        })?;
        lock(&self.switch_plans).remove(id);
        lock(&worksheet.interrupt).interrupt();
        // Closed means saved or discarded: its backup is no longer wanted.
        self.delete_recovery(&worksheet.root);
        self.release_kernel(&lock(&worksheet.kernel_key).clone());
        Ok(())
    }

    /// Stops the kernel of an environment other than the shared one once no open worksheet
    /// uses it.
    fn release_kernel(&self, key: &Path) {
        if key == self.shared_kernel_key() {
            return;
        }
        let in_use = lock(&self.worksheets)
            .values()
            .any(|open| lock(&open.kernel_key).as_path() == key);
        if in_use {
            return;
        }
        if let Some(kernel) = lock(&self.kernels).remove(key) {
            kernel.manager.shutdown();
        }
    }

    /// Replaces the math of a region. Returns the regions that became stale; a running
    /// calculation stops and the next one picks the edit up.
    pub fn edit_region(
        &self,
        id: &str,
        document: &str,
        region_id: &str,
        text: &str,
    ) -> Result<Vec<RegionKey>, CommandError> {
        let worksheet = self.worksheet(id)?;
        let document = DocumentId::new(document)
            .map_err(|error| CommandError::new("region", error.to_string()))?;
        let mut session = lock(&worksheet.session);
        Ok(session.edit_math(&document, region_id, text)?)
    }

    /// The names, references, include tree and unit warnings of a worksheet (Variables, hover,
    /// Includes, Problems).
    pub fn inspect(&self, id: &str) -> Result<Inspection, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        Ok(session.inspect())
    }

    /// The unit warnings of a worksheet (underlines in the sheet, the Problems count): the part
    /// of the inspection the UI needs after every edit.
    pub fn inspect_warnings(&self, id: &str) -> Result<Vec<WarningInfo>, CommandError> {
        let worksheet = self.worksheet(id)?;
        let session = lock(&worksheet.session);
        Ok(session.inspect_warnings())
    }

    /// The current kernel values of definitions (`name` as written, `version`); a read, no
    /// re-evaluation. Fails with `busy` while a calculation runs.
    pub fn definition_values(
        &self,
        id: &str,
        items: Vec<DefinitionRef>,
    ) -> Result<Vec<DefinitionValue>, CommandError> {
        let worksheet = self.worksheet(id)?;
        // It asks the kernel, which is busy with the pass: waiting would block the command.
        if worksheet.running.load(Ordering::SeqCst) {
            return Err(CommandError::busy());
        }
        let session = lock(&worksheet.session);
        let wanted: Vec<(String, u32)> = items.into_iter().map(|i| (i.name, i.version)).collect();
        Ok(session.definition_values(&wanted))
    }

    /// The current results in evaluation order; available while a calculation runs.
    pub fn results(&self, id: &str) -> Result<Vec<RegionEntry>, CommandError> {
        Ok(self.worksheet(id)?.results.snapshot())
    }

    /// A block of the matrix result of `key`, column-major and clipped to the matrix:
    /// what the frontend reads as a large result scrolls.
    pub fn result_block(
        &self,
        id: &str,
        key: &RegionKey,
        row: usize,
        col: usize,
        rows: usize,
        cols: usize,
    ) -> Result<Vec<equavela_core::kernel_value::KernelValue>, CommandError> {
        // A block larger than the first window is never needed by one box; refuse a request
        // that would copy the whole matrix back.
        if rows.saturating_mul(cols) > equavela_core::kernel_value::WINDOW_LIMIT {
            return Err(CommandError::new(
                "result",
                "a result block may hold at most 10 000 elements",
            ));
        }
        self.worksheet(id)?
            .results
            .block(key, row, col, rows, cols)
            .ok_or_else(|| CommandError::new("result", "the region has no matrix result"))
    }

    /// Starts a calculation on a background thread (`all` is Ctrl+F5, otherwise F5).
    /// Progress arrives as `worksheet-event` and `kernel-status` events. While one runs, the
    /// request is queued: another pass follows on the worksheet as it is then.
    pub fn recalculate(self: &Arc<Self>, id: &str, all: bool) -> Result<(), CommandError> {
        let worksheet = self.worksheet(id)?;
        let _project_guard = self.guard_worksheet(id, &worksheet)?;
        if all {
            worksheet.rerun_all.store(true, Ordering::SeqCst);
        }
        worksheet.rerun.store(true, Ordering::SeqCst);
        if worksheet.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let service = Arc::clone(self);
        let id = id.to_owned();
        std::thread::spawn(move || loop {
            worksheet.rerun.store(false, Ordering::SeqCst);
            // The session revision the pass ran on: a request queued meanwhile for the same
            // worksheet is already answered by it.
            let mut covered = None;
            let mode = if worksheet.rerun_all.swap(false, Ordering::SeqCst) {
                RecalcMode::All
            } else {
                RecalcMode::Changed
            };
            let key = lock(&worksheet.kernel_key).clone();
            let (_, config_error) = service.kernel_for(&key);
            let outcome = match config_error {
                Some(message) => {
                    service.set_status(
                        &key,
                        KernelStatus::Crashed {
                            message: message.clone(),
                        },
                    );
                    Err(message)
                }
                None => {
                    // Only preparing the pass holds the session; edits go on while it runs.
                    let module_name = service.module_name_of(&worksheet);
                    let pass = {
                        let mut session = lock(&worksheet.session);
                        session.set_module_name(Some(module_name));
                        session.pass(mode)
                    };
                    covered = Some(pass.revision());
                    pass.run(&mut |event| service.forward(&id, event))
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }
            };
            if let Err(message) = outcome {
                (service.sink)(
                    EVENT_WORKSHEET,
                    json!({ "worksheet": id, "event": "pass_failed", "message": message }),
                );
            }
            if worksheet.rerun.load(Ordering::SeqCst) {
                let changed = covered != Some(lock(&worksheet.session).revision());
                if changed || worksheet.rerun_all.load(Ordering::SeqCst) {
                    continue;
                }
                worksheet.rerun.store(false, Ordering::SeqCst);
            }
            Self::write_results(&worksheet);
            worksheet.running.store(false, Ordering::SeqCst);
            release_free_memory();
            // A request that came between the check above and the store found the thread
            // still running and only queued itself: take it over.
            if worksheet.rerun.load(Ordering::SeqCst)
                && !worksheet.running.swap(true, Ordering::SeqCst)
            {
                continue;
            }
            break;
        });
        Ok(())
    }

    fn forward(&self, worksheet: &str, event: &SessionEvent) {
        if let SessionEvent::Kernel { status } = event {
            let key = lock(&self.worksheets)
                .get(worksheet)
                .map(|open| lock(&open.kernel_key).clone())
                .unwrap_or_else(|| self.shared_kernel_key());
            self.set_status(&key, status.clone());
            return;
        }
        let mut value = serde_json::to_value(event).expect("event serializes");
        if let Value::Object(map) = &mut value {
            map.insert("worksheet".into(), Value::String(worksheet.to_owned()));
        }
        (self.sink)(EVENT_WORKSHEET, value);
    }

    /// The worksheet's Julia environment, its files and its kernel, for the manager.
    pub fn environment_info(&self, id: &str) -> Result<EnvironmentInfo, CommandError> {
        let worksheet = self.worksheet(id)?;
        let (environment, saved) = {
            let session = lock(&worksheet.session);
            (
                session.environment(),
                is_absolute_path(session.root().as_str()),
            )
        };
        let summary = EnvironmentSummary::of(&environment);
        let key = lock(&worksheet.kernel_key).clone();
        let store = self.snapshots();
        let changes = |undo: bool| {
            store.as_ref().and_then(|store| {
                if undo {
                    store.undoable(&environment.directory)
                } else {
                    store.interrupted(&environment.directory)
                }
            })
        };
        Ok(EnvironmentInfo {
            last_change: changes(true).map(EnvironmentChange::from),
            interrupted_change: changes(false).map(EnvironmentChange::from),
            files: read_environment_files(&environment.directory),
            kernel_status: self.kernel_status_of(&key),
            can_override: saved
                && !matches!(
                    environment.kind,
                    EnvironmentKind::Project | EnvironmentKind::Archive
                ),
            problems: environment.problems,
            summary,
        })
    }

    /// Interrupts the running calculation of a worksheet. Returns whether a kernel
    /// request was interrupted (no pass or between regions: `false`, the pass still stops).
    pub fn interrupt(&self, id: &str) -> Result<bool, CommandError> {
        let worksheet = self.worksheet(id)?;
        // A stop also drops the passes that were queued behind the running one.
        worksheet.rerun.store(false, Ordering::SeqCst);
        worksheet.rerun_all.store(false, Ordering::SeqCst);
        let interrupted = lock(&worksheet.interrupt).interrupt();
        Ok(interrupted)
    }
}

#[cfg(test)]
mod tests {
    /// opening or creating a project opens no worksheet; tests open the first one.
    fn first_sheet(service: &Arc<Service>, project: &OpenedProject) -> OpenedWorksheet {
        let root = PathBuf::from(&project.root);
        service
            .open_worksheet(&root.join(&project.manifest.worksheets[0].path))
            .unwrap()
    }

    use super::*;
    use equavela_core::plot::{PlotData, PlotDataState};

    /// Whether `reported` names the directory `expected`: on Windows a temporary directory can be
    /// spelled with its 8.3 short name or its long name.
    fn same_dir(reported: &str, expected: &Path) -> bool {
        let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        canonical(Path::new(reported)) == canonical(expected)
    }
    use std::sync::mpsc::{channel, Receiver};
    use std::time::Duration;

    type Events = Receiver<(String, Value)>;

    fn service(julia_override: Option<PathBuf>) -> (Arc<Service>, Events) {
        let (sender, receiver) = channel();
        let sender = Mutex::new(sender);
        let sink: EventSink = Arc::new(move |name, payload| {
            let _ = lock(&sender).send((name.to_owned(), payload));
        });
        let mut inputs = LocationInputs::from_environment(None);
        inputs.julia_override = julia_override;
        let service = Service::new(sink, inputs);
        // Tests never touch the user's shared Julia environment, nor each other's: tests run
        // in parallel in one process, so the folder is one per service, not per process.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        service.set_environments_dir(std::env::temp_dir().join(format!(
            "equavela-test-environments-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )));
        (service, receiver)
    }

    #[test]
    fn first_fast_symbolic_z_transform_in_a_new_worksheet() {
        if !julia_available() {
            return;
        }
        let (service, _) = service(None);
        let opened = service.new_worksheet().unwrap();
        let input = serde_json::from_value(json!({
            "regionId": null, "page": 1, "x": 70.0, "y": 70.0,
            "statement": equavela_core::parse_statement("a + b").unwrap(),
            "operation": "z_transform", "variable": equavela_core::ast::Name::plain("b"),
            "worksheetVariables": true,
        }))
        .unwrap();
        let result = service.fast_symbolic(&opened.id, input);
        let inserted = result
            .and_then(|statement| service.add_math_region(&opened.id, 1, 70.0, 100.0, statement));
        service.shutdown();
        assert!(inserted.unwrap().created.is_some());
    }

    #[test]
    fn switch_preview_is_read_only_stale_safe_and_undoable() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("shared"));
        let source = temp.path().join("source");
        let target = temp.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        let project = "[deps]\nFoo = \"11111111-1111-1111-1111-111111111111\"\n";
        for (dir, version) in [(&source, "1.0.0"), (&target, "2.0.0")] {
            std::fs::write(dir.join("Project.toml"), project).unwrap();
            std::fs::write(
                dir.join("Manifest.toml"),
                format!("manifest_format = \"2.0\"\n[[deps.Foo]]\nversion = \"{version}\"\n"),
            )
            .unwrap();
        }
        let path = temp.path().join("calc.eqv");
        let sheet = "format: equavela-worksheet/3\nenvironment: source\nregions: []\n";
        std::fs::write(&path, sheet).unwrap();
        let id = service.open_worksheet(&path).unwrap().id;
        let preview = service
            .preview_environment_switch(&id, Some(&target))
            .unwrap();
        assert_eq!(preview.differences[0].current.as_deref(), Some("1.0.0"));
        assert_eq!(preview.differences[0].target.as_deref(), Some("2.0.0"));
        assert!(!preview.differences[0].missing);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sheet);
        assert!(!lock(&service.kernels).contains_key(&kernel_key(&target)));
        assert!(service.commit_environment_switch(&id, "foreign").is_err());
        std::fs::write(target.join("Project.toml"), "[deps]\n").unwrap();
        assert!(service
            .commit_environment_switch(&id, &preview.token)
            .is_err());
        assert_eq!(
            service.environment_info(&id).unwrap().summary.kind,
            EnvironmentKind::Override
        );
        assert!(same_dir(
            &service.environment_info(&id).unwrap().summary.kernel,
            &source
        ));
        let preview = service
            .preview_environment_switch(&id, Some(&target))
            .unwrap();
        service.set_worksheet_trusted(&id, true).unwrap();
        assert!(service
            .commit_environment_switch(&id, &preview.token)
            .is_err());
        assert!(same_dir(
            &service.environment_info(&id).unwrap().summary.kernel,
            &source
        ));
        service.set_worksheet_trusted(&id, false).unwrap();
        service
            .commit_environment_switch(&id, &preview.token)
            .unwrap();
        assert!(same_dir(
            &service.environment_info(&id).unwrap().summary.kernel,
            &target
        ));
        assert!(!lock(&service.kernels)
            .get(&kernel_key(&target))
            .unwrap()
            .manager
            .is_running());
        assert!(same_dir(
            &service.undo(&id).unwrap().environment.unwrap().kernel,
            &source
        ));
        assert!(service
            .commit_environment_switch(&id, &preview.token)
            .is_err());
    }

    #[test]
    fn switch_preview_discloses_identity_and_requirement_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        for (name, uuid, bound) in [
            ("source", "11111111-1111-1111-1111-111111111111", "1"),
            ("target", "22222222-2222-2222-2222-222222222222", "2"),
        ] {
            let directory = temp.path().join(name);
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(
                directory.join("Project.toml"),
                format!("[deps]\nFoo = \"{uuid}\"\n[compat]\nFoo = \"{bound}\"\n"),
            )
            .unwrap();
            std::fs::write(
                directory.join("Manifest.toml"),
                "manifest_format = \"2.0\"\n[[deps.Foo]]\nversion = \"1.0.0\"\n",
            )
            .unwrap();
        }
        let path = temp.path().join("same-version.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nenvironment: source\nregions: []\n",
        )
        .unwrap();
        let id = service.open_worksheet(&path).unwrap().id;
        let preview = service
            .preview_environment_switch(&id, Some(&temp.path().join("target")))
            .unwrap();
        assert_eq!(preview.differences.len(), 1);
        assert!(preview.differences[0]
            .current
            .as_deref()
            .unwrap()
            .contains("requires 1"));
        assert!(preview.differences[0]
            .target
            .as_deref()
            .unwrap()
            .contains("requires 2"));
        assert!(preview.differences[0]
            .target
            .as_deref()
            .unwrap()
            .contains("22222222"));
        service.shutdown();
    }

    #[test]
    fn switch_preview_rejects_malformed_orphan_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("shared"));
        let path = temp.path().join("calc.eqv");
        std::fs::write(&path, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let id = service.open_worksheet(&path).unwrap().id;
        let target = temp.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("Manifest.toml"), "invalid = [").unwrap();
        assert!(service
            .preview_environment_switch(&id, Some(&target))
            .is_err());
    }

    fn julia_available() -> bool {
        std::process::Command::new("julia")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn folder_project_creation_and_opening() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let project_id = "11111111-1111-4111-8111-111111111111";
        let worksheet_id = "22222222-2222-4222-8222-222222222222";
        let created = service
            .new_project(&target, "Example", project_id, worksheet_id)
            .unwrap();
        let created_sheet = first_sheet(&service, &created);
        assert_eq!(created.root, slash_path(&target.canonicalize().unwrap()));
        assert_eq!(created.manifest.name, "Example");
        assert_eq!(created.manifest.worksheets[0].path, "worksheets/main.eqv");
        assert!(created_sheet.view.regions.is_empty());
        assert!(!created_sheet.view.trusted);
        let reopened = service.open_project(&target).unwrap();
        let reopened_sheet = first_sheet(&service, &reopened);
        assert_eq!(reopened.manifest, created.manifest);
        assert_eq!(reopened_sheet.root, created_sheet.root);
        assert_ne!(reopened_sheet.id, created_sheet.id);
        let other_id = "33333333-3333-4333-8333-333333333333";
        let other = target.join("worksheets/other.eqv");
        std::fs::copy(target.join("worksheets/main.eqv"), &other).unwrap();
        let mut manifest = created.manifest;
        manifest.worksheets.push(WorksheetEntry {
            id: other_id.into(),
            path: "worksheets/other.eqv".into(),
        });
        std::fs::write(
            target.join("equavela-project.yaml"),
            manifest.to_yaml().unwrap() + "main_worksheet: 33333333-3333-4333-8333-333333333333\n",
        )
        .unwrap();
        // an old manifest's main worksheet is ignored; opening opens nothing.
        let reopened = service.open_project(&target).unwrap();
        assert!(reopened.worksheet.is_none());
        assert!(!reopened
            .manifest
            .to_yaml()
            .unwrap()
            .contains("main_worksheet"));
        assert!(other.exists());
        let reopened_sheet = first_sheet(&service, &reopened);
        // the project's environment, declared by New Project, is what the worksheet uses.
        assert_eq!(manifest.environment.as_deref(), Some("julia"));
        assert!(target.join("julia").is_dir());
        let session = service.worksheet(&reopened_sheet.id).unwrap();
        let environment = lock(&session.session).environment();
        assert_eq!(environment.kind, EnvironmentKind::Project);
        assert_eq!(
            environment.directory,
            target.canonicalize().unwrap().join("julia")
        );
        // A declared environment that is not a directory is refused on open.
        std::fs::remove_dir_all(target.join("julia")).unwrap();
        assert_eq!(service.open_project(&target).unwrap_err().kind, "load");
        service.shutdown();
    }

    #[test]
    fn project_assets_are_drawn_from_the_project_and_missing_ones_are_problems() {
        // an asset resource is read from the project folder; a missing file
        // does not stop the load, it is a problem of the region.
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let id = "11111111-1111-4111-8111-111111111111";
        service.new_project(&target, "Assets", id, id).unwrap();
        std::fs::create_dir_all(target.join("assets/images")).unwrap();
        std::fs::write(target.join("assets/images/beam.png"), tiny_png(40, 20)).unwrap();
        std::fs::write(
            target.join("worksheets/main.eqv"),
            "format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [54, 72]\n    image:\n      resource: img1\n      size: [60, 30]\nresources:\n  img1:\n    media: png\n    asset: assets/images/beam.png\n",
        )
        .unwrap();
        let opened = service.open_project(&target).unwrap();
        let opened_sheet = first_sheet(&service, &opened);
        assert!(opened_sheet.diagnostics.is_empty());
        let url = service.image_data_url(&opened_sheet.id, "img1").unwrap();
        assert_eq!(
            url,
            format!("data:image/png;base64,{}", base64_encode(&tiny_png(40, 20)))
        );
        let sized = service.original_image_size(&opened_sheet.id, "r1").unwrap();
        assert!(sized.label.is_some());

        std::fs::remove_file(target.join("assets/images/beam.png")).unwrap();
        let reopened = service.open_project(&target).unwrap();
        let reopened_sheet = first_sheet(&service, &reopened);
        assert_eq!(reopened_sheet.diagnostics.len(), 1);
        assert_eq!(reopened_sheet.diagnostics[0].region_id, "r1");
        assert!(reopened_sheet.diagnostics[0]
            .message
            .contains("assets/images/beam.png"));
        assert!(service.image_data_url(&reopened_sheet.id, "img1").is_err());

        // The same file outside its project: no project to resolve against.
        let alone = temp.path().join("alone.eqv");
        std::fs::copy(target.join("worksheets/main.eqv"), &alone).unwrap();
        let opened = service.open_worksheet(&alone).unwrap();
        assert!(opened.diagnostics[0].message.contains("part of a project"));
        service.shutdown();
    }

    #[test]
    fn an_image_that_does_not_fit_above_the_bottom_margin_starts_on_the_next_page() {
        // the specification : one undo step, at the top of the next page's printable area.
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let id = service.new_worksheet().unwrap().id;
        let view = full_view(&service, &id);
        let (top, bottom) = (
            view.page.margins.top,
            view.page.height - view.page.margins.bottom,
        );
        let png = tiny_png(200, 150); // 150 pt tall
        let fits = service
            .add_image(&id, &png, 1, 72.0, bottom - 160.0)
            .unwrap();
        let moved = service
            .add_image(&id, &png, 1, 72.0, bottom - 100.0)
            .unwrap();
        let at = |region: &str| {
            let view = serde_json::to_value(full_view(&service, &id)).unwrap();
            let region = view["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == region)
                .cloned()
                .unwrap();
            (
                region["page"].as_u64().unwrap(),
                region["at"].clone(),
                region["y"].as_f64(),
            )
        };
        let fits = at(fits.edit.created.as_deref().unwrap());
        let moved = at(moved.edit.created.as_deref().unwrap());
        assert_eq!(fits.0, 1);
        assert_eq!(fits.2, Some(bottom - 160.0));
        assert_eq!((moved.0, moved.2), (2, Some(top)));
        service.undo(&id).unwrap();
        assert_eq!(full_view(&service, &id).regions.len(), 1);
        service.shutdown();
    }

    #[test]
    fn images_inserted_into_a_project_worksheet_become_shared_assets() {
        // the bytes go to assets/images once; identical bytes reuse file and resource;
        // undo keeps the file; a paste of identical bytes points at the same asset.
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let pid = "11111111-1111-4111-8111-111111111111";
        let created = service.new_project(&target, "Assets", pid, pid).unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let id = &first_sheet(&service, &created).id;
        let beam = temp.path().join("beam.png");
        std::fs::write(&beam, tiny_png(40, 20)).unwrap();
        service.add_image_file(id, &beam, 1, 72.0, 72.0).unwrap();
        service.add_image_file(id, &beam, 1, 72.0, 200.0).unwrap();
        let assets = target.join("assets/images");
        assert_eq!(
            std::fs::read(assets.join("beam.png")).unwrap(),
            tiny_png(40, 20)
        );
        assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 1);
        service.save_worksheet(id).unwrap();
        let text = std::fs::read_to_string(target.join("worksheets/main.eqv")).unwrap();
        assert!(
            text.contains(
                "resources:\n  img1:\n    media: png\n    asset: assets/images/beam.png\n"
            ),
            "{text}"
        );
        assert!(!text.contains("base64"), "{text}");
        assert_eq!(text.matches("resource: img1").count(), 2, "{text}");

        // Replace: new bytes, new file named after the source; the old asset stays on disk.
        let regions = |service: &Service| -> Vec<(String, String)> {
            serde_json::to_value(full_view(service, id)).unwrap()["regions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|region| region["kind"] == "image")
                .map(|region| {
                    (
                        region["id"].as_str().unwrap().to_owned(),
                        region["resource"].as_str().unwrap().to_owned(),
                    )
                })
                .collect()
        };
        let first = regions(&service)[0].0.clone();
        let wide = temp.path().join("wide beam.png");
        std::fs::write(&wide, tiny_png(80, 20)).unwrap();
        service.replace_image(id, &first, &wide).unwrap();
        assert!(assets.join("wide beam.png").is_file());
        assert_eq!(regions(&service)[0].1, "img2");
        service.undo(id).unwrap();
        assert_eq!(regions(&service)[0].1, "img1");
        assert!(
            assets.join("wide beam.png").is_file(),
            "undo keeps the file"
        );

        // A pasted snippet with the same bytes reuses the asset; other bytes get a new file.
        let snippet = |data: &[u8]| {
            format!(
                "- id: i1\n  page: 1\n  at: [100, 400]\n  image:\n    resource: img1\n    size: [30, 15]\nresources:\n  img1:\n    media: png\n    base64: {}\n",
                base64_encode(data)
            )
        };
        service
            .paste_regions(id, 1, 100.0, 400.0, &snippet(&tiny_png(40, 20)))
            .unwrap();
        assert_eq!(regions(&service)[2].1, "img1");
        service
            .paste_regions(id, 1, 100.0, 500.0, &snippet(&tiny_png(10, 10)))
            .unwrap();
        assert!(assets.join("image.png").is_file());
        let asset_snippet = "- id: i1\n  page: 1\n  at: [0, 0]\n  image:\n    resource: a\n    size: [30, 15]\nresources:\n  a:\n    media: png\n    asset: assets/images/beam.png\n";
        assert_eq!(
            service
                .paste_regions(id, 1, 0.0, 600.0, asset_snippet)
                .unwrap_err()
                .kind,
            "paste"
        );
        service.shutdown();
    }

    #[test]
    fn save_as_outside_the_project_embeds_the_assets() {
        // the copy outside the project carries its pictures; an unreadable asset refuses.
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let pid = "11111111-1111-4111-8111-111111111111";
        let created = service.new_project(&target, "Assets", pid, pid).unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let id = first_sheet(&service, &created).id;
        let beam = temp.path().join("beam.png");
        std::fs::write(&beam, tiny_png(40, 20)).unwrap();
        service.add_image_file(&id, &beam, 1, 72.0, 72.0).unwrap();
        service.save_worksheet(&id).unwrap();
        let outside = temp.path().join("standalone.eqv");
        let saved = service.save_worksheet_as(&id, &outside).unwrap();
        let text = std::fs::read_to_string(&outside).unwrap();
        assert!(text.contains("    media: png\n    base64: |\n"), "{text}");
        assert!(!text.contains("asset:"), "{text}");
        let copy = saved.opened.unwrap();
        assert!(copy.diagnostics.is_empty());
        assert!(service.image_data_url(&copy.id, "img1").is_ok());
        // The project worksheet itself still references the asset.
        let main = std::fs::read_to_string(target.join("worksheets/main.eqv")).unwrap();
        assert!(main.contains("asset: assets/images/beam.png"), "{main}");

        let reopened = service.open_project(&target).unwrap();
        let project = first_sheet(&service, &reopened).id;
        std::fs::remove_file(target.join("assets/images/beam.png")).unwrap();
        let refused = temp.path().join("refused.eqv");
        let error = service.save_worksheet_as(&project, &refused).unwrap_err();
        assert!(
            error.message.contains("assets/images/beam.png"),
            "{}",
            error.message
        );
        assert!(!refused.exists());
        service.shutdown();
    }

    #[test]
    fn a_worksheet_saved_as_a_portable_document_carries_and_uses_its_environment() {
        // .
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let environments = temp.path().join("environments");
        service.set_environments_dir(environments.clone());
        let env = temp.path().join("env");
        std::fs::create_dir(&env).unwrap();
        let project_toml = "[deps]\nFoo = \"d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b14\"\n";
        std::fs::write(env.join("Project.toml"), project_toml).unwrap();
        std::fs::write(env.join("Manifest.toml"), "manifest_format = \"2.0\"\n").unwrap();
        let source = temp.path().join("sizing.eqv");
        std::fs::write(
            &source,
            "format: equavela-worksheet/3\nenvironment: env\nregions:\n  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&source).unwrap();
        assert_eq!(opened.environment.kind, EnvironmentKind::Override);

        let portable = temp.path().join("sizing.eqvz");
        let saved = service.save_worksheet_as(&opened.id, &portable).unwrap();
        let document = saved.opened.unwrap();
        assert_eq!(document.root.as_str(), slash_path(&portable));
        let bytes = std::fs::read(&portable).unwrap();
        let archive = decode_document(&bytes).unwrap();
        assert!(
            archive.worksheet.contains("a := 2"),
            "{}",
            archive.worksheet
        );
        assert!(
            !archive.worksheet.contains("environment:"),
            "{}",
            archive.worksheet
        );
        assert_eq!(
            archive.environment.project.as_deref(),
            Some(project_toml.as_bytes())
        );
        assert!(archive.environment.manifest.is_some());

        // The document uses the environment materialized from its archive, not the override.
        assert_eq!(document.environment.kind, EnvironmentKind::Archive);
        let folder = PathBuf::from(&document.environment.directory);
        assert!(
            folder.starts_with(environments.join("documents")),
            "{}",
            folder.display()
        );
        assert!(folder
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&archive.document_id));
        assert_eq!(
            std::fs::read_to_string(folder.join("Project.toml")).unwrap(),
            project_toml
        );
        let info = service.environment_info(&document.id).unwrap();
        assert!(!info.can_override);
        assert!(service
            .set_worksheet_environment(&document.id, Some(&env))
            .is_err());
        assert_eq!(
            service.start_location(&document.id, None).file_name,
            "sizing.eqvz"
        );

        // A package change in the folder is saved into the archive, with the same id.
        let changed = "[deps]\n";
        std::fs::write(folder.join("Project.toml"), changed).unwrap();
        service.save_worksheet(&document.id).unwrap();
        let resaved = decode_document(&std::fs::read(&portable).unwrap()).unwrap();
        assert_eq!(resaved.document_id, archive.document_id);
        assert_eq!(
            resaved.environment.project.as_deref(),
            Some(changed.as_bytes())
        );
        service.close_worksheet(&document.id).unwrap();

        // Opened again, the document materializes its saved environment.
        let again = service.open_worksheet(&portable).unwrap();
        assert_eq!(again.environment.kind, EnvironmentKind::Archive);
        let refolder = PathBuf::from(&again.environment.directory);
        assert_ne!(refolder, folder);
        assert_eq!(
            std::fs::read_to_string(refolder.join("Project.toml")).unwrap(),
            changed
        );
        assert!(again
            .regions
            .iter()
            .any(|region| region.key.region_id == "a"));

        // Its recovery file reopens with the archived environment.
        // (Closing the worksheet would delete it, so the backup is opened beside it.)
        let recovery = service.write_recovery(&again.id).unwrap().unwrap();
        let restored = service
            .open_recovery(Path::new(&recovery), Some(&portable))
            .unwrap();
        assert_eq!(restored.environment.kind, EnvironmentKind::Archive);
        service.shutdown();
    }

    #[test]
    fn portable_documents_refuse_includes_and_project_archives() {
        // .
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        std::fs::write(
            temp.path().join("lib.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        let with_include = temp.path().join("root.eqv");
        std::fs::write(
            &with_include,
            "format: equavela-worksheet/3\nregions:\n  - id: i1\n    at: [0, 0]\n    include: lib.eqv\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&with_include).unwrap();
        let refused = temp.path().join("root.eqvz");
        let error = service.save_worksheet_as(&opened.id, &refused).unwrap_err();
        assert!(error.message.contains("lib.eqv"), "{}", error.message);
        assert!(!refused.exists());

        // A document archive made by another tool with an include does not open.
        let crafted = equavela_core::eqvz::EqvzArchive {
            manifest: equavela_core::eqvz::EqvzManifest {
                format_version: 1,
                kind: equavela_core::eqvz::EqvzKind::Document,
                main: "worksheets/main.eqv".into(),
                worksheets: vec!["worksheets/main.eqv".into()],
                document_id: Some("abc".into()),
                references: Vec::new(),
            },
            entries: BTreeMap::from([(
                "worksheets/main.eqv".to_owned(),
                std::fs::read(&with_include).unwrap(),
            )]),
        };
        let crafted_path = temp.path().join("crafted.eqvz");
        std::fs::write(&crafted_path, crafted.encode().unwrap()).unwrap();
        let error = service.open_worksheet(&crafted_path).unwrap_err();
        assert!(error.message.contains("include"), "{}", error.message);
        assert!(!temp.path().join("environments/documents").exists());

        // A project archive points to Extract Project.
        let project = temp.path().join("project");
        let pid = "11111111-1111-4111-8111-111111111111";
        service.new_project(&project, "P", pid, pid).unwrap();
        let packed = temp.path().join("project.eqvz");
        std::fs::write(
            &packed,
            equavela_core::project_archive::pack_project(&project).unwrap(),
        )
        .unwrap();
        let error = service.open_worksheet(&packed).unwrap_err();
        assert!(
            error.message.contains("Extract project"),
            "{}",
            error.message
        );
        service.shutdown();
    }

    #[test]
    fn a_worksheet_of_the_empty_shared_environment_converts_to_a_project_environment() {
        // the shared environment has no Project.toml before a package is added; the
        // project still gets its own environment, so the explorer and the REPL see it at once.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let source = temp.path().join("plate.eqv");
        std::fs::write(&source, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let opened = service.open_worksheet(&source).unwrap();
        let pid = "11111111-1111-4111-8111-111111111111";
        let target = temp.path().join("plate");
        let project = service
            .convert_to_project(&opened.id, &target, "Plate design", pid, pid)
            .unwrap();
        let toml = std::fs::read_to_string(target.join("julia/Project.toml")).unwrap();
        assert!(
            toml.starts_with("name = \"PlateDesign\"\nuuid = \""),
            "{toml}"
        );
        assert!(target.join("julia/src/PlateDesign.jl").is_file());
        let entries: Vec<String> = service
            .project_tree(&target)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.path)
            .collect();
        assert!(
            entries.contains(&"julia/Project.toml".to_owned()),
            "{entries:?}"
        );
        // the REPL runs in the project's environment, not in the shared one.
        let root = project.root.clone();
        let (_, environment, packages) =
            service.repl_target_with_start(Some(&root), false).unwrap();
        let environment = PathBuf::from(environment.expect("the project environment"));
        assert_eq!(environment.file_name().unwrap(), "julia");
        assert_eq!(packages, vec!["PlateDesign".to_owned()]);
        service.shutdown();
    }

    #[test]
    fn a_standalone_worksheet_converts_to_a_project_with_its_environment() {
        // .
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let env = temp.path().join("env");
        std::fs::create_dir(&env).unwrap();
        let project_toml = "[deps]\nFoo = \"d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b14\"\n";
        std::fs::write(env.join("Project.toml"), project_toml).unwrap();
        // A `:` in a file name is renamed in the project; Windows cannot hold one at all.
        let (name, stored) = if cfg!(windows) {
            ("beam sizing.eqv", "beam sizing.eqv")
        } else {
            ("beam: sizing.eqv", "beam- sizing.eqv")
        };
        let source = temp.path().join(name);
        let original = "format: equavela-worksheet/3\nenvironment: env\nregions:\n  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n";
        std::fs::write(&source, original).unwrap();
        let opened = service.open_worksheet(&source).unwrap();
        service
            .edit_region(&opened.id, opened.root.as_str(), "a", "a := 3")
            .unwrap();
        let pid = "11111111-1111-4111-8111-111111111111";
        let wid = "22222222-2222-4222-8222-222222222222";
        let target = temp.path().join("beam");
        let project = service
            .convert_to_project(&opened.id, &target, "Beam", pid, wid)
            .unwrap();
        assert_eq!(
            project.manifest.worksheets[0].path,
            format!("worksheets/{stored}")
        );
        assert_eq!(
            project.worksheet.as_ref().unwrap().environment.kind,
            EnvironmentKind::Project
        );
        let text = std::fs::read_to_string(target.join("worksheets").join(stored)).unwrap();
        assert!(
            text.contains("a := 3") && !text.contains("environment:"),
            "{text}"
        );
        // The project's package with the deps of the old environment.
        let converted = std::fs::read_to_string(target.join("julia/Project.toml")).unwrap();
        assert!(
            converted.starts_with("name = \"Beam\"\nuuid = \""),
            "{converted}"
        );
        assert!(
            converted.ends_with("\n[deps]\nFoo = \"d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b14\"\n"),
            "{converted}"
        );
        assert!(target.join("julia/src/Beam.jl").is_file());
        assert!(!target.join("julia/Manifest.toml").exists());
        // The original file is untouched and the old session is gone.
        assert_eq!(std::fs::read_to_string(&source).unwrap(), original);
        assert!(service.worksheet(&opened.id).is_err());
        // A worksheet of a project, or one that exists already, is refused.
        let again = service
            .convert_to_project(
                &project.worksheet.as_ref().unwrap().id,
                &temp.path().join("other"),
                "X",
                pid,
                wid,
            )
            .unwrap_err();
        assert!(
            again.message.contains("already belongs"),
            "{}",
            again.message
        );
        let untitled = service.new_worksheet().unwrap();
        let exists = service
            .convert_to_project(&untitled.id, &target, "X", pid, wid)
            .unwrap_err();
        assert!(exists.message.contains("exists"), "{}", exists.message);
        let fresh = service
            .convert_to_project(&untitled.id, &temp.path().join("fresh"), "Fresh", pid, wid)
            .unwrap();
        assert_eq!(fresh.manifest.worksheets[0].path, "worksheets/main.eqv");
        service.shutdown();
    }

    #[test]
    fn a_portable_document_converts_to_a_project_and_includes_are_refused() {
        //  with a .eqvz (its archive environment) and a worksheet with an include.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let manifest_toml = "manifest_format = \"2.0\"\n";
        let portable = temp.path().join("doc.eqvz");
        std::fs::write(
            &portable,
            encode_document(&DocumentArchive {
                document_id: "abc".into(),
                worksheet: "format: equavela-worksheet/3\nregions: []\n".into(),
                environment: equavela_core::document_archive::ArchivedEnvironment {
                    project: Some(b"[deps]\n".to_vec()),
                    manifest: Some(manifest_toml.as_bytes().to_vec()),
                },
            })
            .unwrap(),
        )
        .unwrap();
        let opened = service.open_worksheet(&portable).unwrap();
        let pid = "11111111-1111-4111-8111-111111111111";
        let target = temp.path().join("from document");
        let project = service
            .convert_to_project(&opened.id, &target, "Doc", pid, pid)
            .unwrap();
        assert_eq!(project.manifest.worksheets[0].path, "worksheets/doc.eqv");
        assert_eq!(
            std::fs::read_to_string(target.join("julia/Manifest.toml")).unwrap(),
            manifest_toml
        );

        std::fs::write(
            temp.path().join("lib.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        let with_include = temp.path().join("root.eqv");
        std::fs::write(
            &with_include,
            "format: equavela-worksheet/3\nregions:\n  - id: i1\n    at: [0, 0]\n    include: lib.eqv\n",
        )
        .unwrap();
        let included = service.open_worksheet(&with_include).unwrap();
        let refused = temp.path().join("refused");
        let error = service
            .convert_to_project(&included.id, &refused, "R", pid, pid)
            .unwrap_err();
        assert!(error.message.contains("lib.eqv"), "{}", error.message);
        assert!(!refused.exists());
        service.shutdown();
    }

    #[test]
    fn project_text_recovery_browser_survives_a_moved_project() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let recovery_dir = temp.path().join("recovery");
        service.set_recovery_dir(recovery_dir.clone());
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Beam", id, id)
            .unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(created.root);
        let source = root.join("notes.txt");
        std::fs::write(&source, "original").unwrap();
        service
            .write_project_text_recovery(&root, "notes.txt", "edited", "original", "v1")
            .unwrap();
        let moved = temp.path().join("moved");
        std::fs::rename(&root, &moved).unwrap();
        let store = recovery_dir.join("project-text");
        std::fs::write(store.join("broken.json"), "{").unwrap();
        std::fs::create_dir_all(store.join("corrupt")).unwrap();
        std::fs::write(store.join("corrupt/old.json"), "{").unwrap();
        let listing = service.list_project_text_recoveries().unwrap();
        assert_eq!(listing.unreadable, 1);
        assert_eq!(listing.entries.len(), 1);
        let id = &listing.entries[0].id;
        assert_eq!(listing.entries[0].path, "notes.txt");
        assert_eq!(
            service.read_project_text_recovery(id).unwrap().text,
            "edited"
        );
        assert!(service.read_project_text_recovery("../bad").is_err());
        let output = temp.path().join("export.txt");
        service
            .export_project_text_recovery_to(id, &output)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "edited");
        assert!(service
            .export_project_text_recovery_to(id, &store.join("overwrite.json"))
            .is_err());
        assert!(service
            .export_project_text_recovery_to(id, &recovery_dir.join("worksheet.recovery"))
            .is_err());
        assert!(service
            .export_project_text_recovery_to(id, &temp.path().join("missing/out.txt"))
            .is_err());
        assert!(service.read_project_text_recovery(id).is_ok());
        #[cfg(unix)]
        {
            let link_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            std::os::unix::fs::symlink(
                store.join(format!("{id}.json")),
                store.join(format!("{link_id}.json")),
            )
            .unwrap();
            assert_eq!(
                service
                    .list_project_text_recoveries()
                    .unwrap()
                    .entries
                    .len(),
                1
            );
            assert!(service.read_project_text_recovery(link_id).is_err());
            assert!(service
                .discard_project_text_recovery_entry(link_id)
                .is_err());
        }
        service.discard_project_text_recovery_entry(id).unwrap();
        service.discard_project_text_recovery_entry(id).unwrap();
        assert_eq!(
            std::fs::read_to_string(moved.join("notes.txt")).unwrap(),
            "original"
        );
        assert!(store.join("broken.json").exists());
        service.shutdown();
    }

    #[test]
    fn project_text_recovery_roundtrip_and_save_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let recovery_dir = temp.path().join("appdata/recovery");
        service.set_recovery_dir(recovery_dir.clone());
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let root = PathBuf::from(
            service
                .new_project(&temp.path().join("project"), "Beam", id, id)
                .unwrap()
                .root,
        );
        let path = "julia/src/Beam.jl";
        let original = service.project_read_text(&root, path).unwrap();
        let edit = "module Beam\nf() = 1\nend\n";
        service
            .write_project_text_recovery(&root, path, edit, &original.text, &original.version)
            .unwrap();
        let recovery = service
            .project_text_recovery_for(&root, path)
            .unwrap()
            .unwrap();
        assert_eq!(
            recovery,
            ProjectTextRecovery {
                text: edit.into(),
                saved: original.text.clone(),
                version: original.version.clone()
            }
        );
        assert_eq!(
            std::fs::read_dir(recovery_dir.join("project-text"))
                .unwrap()
                .count(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(root.join(path)).unwrap(),
            original.text
        );
        assert!(service
            .write_project_text_recovery(&root, "../escape", "x", "x", "x")
            .is_err());
        assert!(service
            .project_text_recovery_for(&root, "../escape")
            .is_err());
        assert!(service
            .discard_project_text_recovery(&root, "../escape")
            .is_err());
        std::fs::write(root.join(path), "external change").unwrap();
        assert!(service
            .project_write_text(&root, path, edit, &original.version)
            .is_err());
        assert_eq!(
            service.project_text_recovery_for(&root, path).unwrap(),
            Some(recovery)
        );
        let changed = service.project_read_text(&root, path).unwrap();
        service
            .project_write_text(&root, path, edit, &changed.version)
            .unwrap();
        assert!(service
            .project_text_recovery_for(&root, path)
            .unwrap()
            .is_none());
        service
            .write_project_text_recovery(&root, path, "newer", edit, &changed.version)
            .unwrap();
        service.discard_project_text_recovery(&root, path).unwrap();
        service.discard_project_text_recovery(&root, path).unwrap();
        assert!(service
            .project_text_recovery_for(&root, path)
            .unwrap()
            .is_none());
        service.shutdown();
    }

    #[test]
    fn project_text_recovery_quarantines_corruption_without_touching_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let recovery_dir = temp.path().join("recovery");
        service.set_recovery_dir(recovery_dir.clone());
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let root = PathBuf::from(
            service
                .new_project(&temp.path().join("project"), "Beam", id, id)
                .unwrap()
                .root,
        );
        let path = "julia/src/Beam.jl";
        // The commands key the recovery by the canonical root, which on Windows is not the
        // `C:/…` text that `new_project` reports: the test writes where they read.
        let canonical = Service::canonical_project(&root).unwrap();
        let file = service
            .project_text_recovery_path(&canonical, path)
            .unwrap();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let corrupt = b"{ invalid recovery";
        std::fs::write(&file, corrupt).unwrap();
        assert!(service.project_text_recovery_for(&root, path).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), corrupt);
        service
            .write_project_text_recovery(&root, path, "edit", "saved", "version")
            .unwrap();
        assert_eq!(
            service
                .project_text_recovery_for(&root, path)
                .unwrap()
                .unwrap()
                .text,
            "edit"
        );
        let corrupt_dir = recovery_dir.join("project-text/corrupt");
        let contents = || {
            std::fs::read_dir(&corrupt_dir)
                .unwrap()
                .map(|entry| std::fs::read(entry.unwrap().path()).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(contents(), vec![corrupt.to_vec()]);
        std::fs::write(&file, b"invalid again").unwrap();
        service.discard_project_text_recovery(&root, path).unwrap();
        assert!(!file.exists());
        let copies = contents();
        assert_eq!(copies.len(), 2);
        assert!(copies.contains(&corrupt.to_vec()));
        assert!(copies.contains(&b"invalid again".to_vec()));
        let collision =
            serde_json::json!({"root": root, "path": "different", "recovery": {"broken": true}})
                .to_string();
        std::fs::write(&file, &collision).unwrap();
        assert!(service
            .write_project_text_recovery(&root, path, "edit", "saved", "version")
            .is_err());
        assert!(service.discard_project_text_recovery(&root, path).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), collision);
        assert_eq!(contents().len(), 2);
        service.shutdown();
    }

    #[test]
    fn project_image_usage_and_relocation_cover_saved_and_live_references() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Beam", id, id)
            .unwrap();
        let created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(&created.root);
        std::fs::create_dir_all(root.join("assets/group")).unwrap();
        std::fs::write(root.join("assets/group/unused.png"), tiny_png(10, 10)).unwrap();
        let source = temp.path().join("live.png");
        std::fs::write(&source, tiny_png(10, 10)).unwrap();
        service
            .add_image_file(&created_sheet.id, &source, 1, 72.0, 72.0)
            .unwrap();
        let sheet = "format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [54, 72]\n    image:\n      resource: img1\n      size: [60, 30]\n  - id: r2\n    at: [54, 120]\n    image:\n      resource: img1\n      size: [60, 30]\nresources:\n  img1:\n    media: png\n    asset: assets/group/missing.png\n  orphan:\n    media: png\n    asset: assets/group/orphan.png\n";
        std::fs::write(root.join("assets/group/owner.eqv"), sheet).unwrap();
        let usage = service.project_image_usage(&root).unwrap();
        assert_eq!(usage.len(), 3);
        let find = |path: &str| usage.iter().find(|item| item.path == path).unwrap();
        assert_eq!(
            find("assets/group/missing.png").worksheets,
            ["assets/group/owner.eqv"]
        );
        assert!(find("assets/group/missing.png").problem.is_some());
        assert!(find("assets/group/unused.png").worksheets.is_empty());
        assert!(find("assets/group/unused.png").problem.is_none());
        assert_eq!(
            find("assets/images/live.png").worksheets,
            ["worksheets/main.eqv"]
        );
        assert!(service
            .project_rename(&root, "assets/images/live.png", "new.png")
            .unwrap_err()
            .message
            .contains("worksheets/main.eqv"));
        assert!(service
            .project_move(&root, "assets/images/live.png", "assets/group")
            .unwrap_err()
            .message
            .contains("worksheets/main.eqv"));
        service
            .project_rename(&root, "assets/group", "other")
            .unwrap();
        assert!(std::fs::read_to_string(root.join("assets/other/owner.eqv"))
            .unwrap()
            .contains("assets/other/missing.png"));
        service
            .project_rename(&root, "assets/images/live.png", "live.png")
            .unwrap();
        service
            .project_move(&root, "assets/images/live.png", "assets/images")
            .unwrap();
        service
            .project_rename(&root, "assets/other/unused.png", "renamed.png")
            .unwrap();
        service
            .project_move(&root, "assets/other/owner.eqv", "worksheets")
            .unwrap();
        service.save_worksheet(&created_sheet.id).unwrap();
        let renamed = service
            .project_rename(&root, "assets/images/live.png", "saved.png")
            .unwrap();
        assert!(renamed
            .replaced
            .iter()
            .any(|entry| entry.id == created_sheet.id));
        assert!(std::fs::read_to_string(root.join("worksheets/main.eqv"))
            .unwrap()
            .contains("assets/images/saved.png"));
        std::fs::write(root.join("worksheets/broken.eqv"), "invalid: [").unwrap();
        assert!(service.project_image_usage(&root).is_err());
        service.shutdown();
    }

    #[test]
    fn project_bulk_changes_are_preflighted_and_can_remove_an_owner_with_its_asset() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Bulk", id, id)
            .unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(&created.root);
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::create_dir_all(root.join("target")).unwrap();
        for name in ["a.txt", "b.txt"] {
            std::fs::write(root.join("data").join(name), name).unwrap();
        }
        std::fs::write(root.join("target/b.txt"), "existing").unwrap();
        let selected = vec!["data/a.txt".into(), "data/b.txt".into()];
        assert!(service
            .project_move_many(&root, &selected, "target")
            .is_err());
        assert!(root.join("data/a.txt").exists() && root.join("data/b.txt").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("target/b.txt")).unwrap(),
            "existing"
        );
        std::fs::remove_file(root.join("target/b.txt")).unwrap();
        service
            .project_move_many(&root, &selected, "target")
            .unwrap();
        assert!(root.join("target/a.txt").exists() && root.join("target/b.txt").exists());
        std::fs::create_dir_all(root.join("assets/images")).unwrap();
        std::fs::write(root.join("assets/images/shared.png"), tiny_png(10, 10)).unwrap();
        let owner = root.join("worksheets/owner.eqv");
        std::fs::write(&owner, "format: equavela-worksheet/3\nregions:\n  - id: img\n    at: [0, 0]\n    image:\n      resource: shared\n      size: [20, 20]\nresources:\n  shared:\n    media: png\n    asset: assets/images/shared.png\n").unwrap();
        let opened = service.open_worksheet(&owner).unwrap();
        let deleted = service
            .project_delete_many(
                &root,
                &[
                    "worksheets/owner.eqv".into(),
                    "assets/images/shared.png".into(),
                ],
            )
            .unwrap();
        assert!(deleted.closed.contains(&opened.id));
        assert!(!owner.exists() && !root.join("assets/images/shared.png").exists());
        assert!(root.join("worksheets/main.eqv").exists());
        assert!(!root.join(".equavela-trash.json").exists());
        service.shutdown();
    }

    #[test]
    fn project_references_lock_exports_reach_open_worksheets_and_need_their_own_trust() {
        // the specification .
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        service.set_config_dir(temp.path().join("config"));
        let provider_id = "11111111-1111-4111-8111-111111111111";
        let provider = service
            .new_project(
                &temp.path().join("Thermo"),
                "Thermo",
                provider_id,
                provider_id,
            )
            .unwrap();
        let provider_sheet = first_sheet(&service, &provider);
        let provider_root = PathBuf::from(&provider.root);
        service.close_worksheet(&provider_sheet.id).unwrap();
        std::fs::write(
            provider_root.join("worksheets/main.eqv"),
            "format: equavela-worksheet/3\nregions:\n  - id: cp\n    at: [0, 10]\n    math: \"c_p(T) := 2·T\"\n  - id: k\n    at: [0, 20]\n    math: \"k := 3\"\n",
        )
        .unwrap();
        service
            .project_set_export(&provider_root, "worksheets/main.eqv", "cp", true)
            .unwrap();
        let exports = service.project_references(&provider_root).unwrap().exports;
        assert_eq!(exports.len(), 1);
        assert_eq!(exports[0].api.as_ref().unwrap().name, "c_p");
        assert!(service
            .project_set_export(&provider_root, "worksheets/main.eqv", "missing", true)
            .is_err());

        let consumer_id = "22222222-2222-4222-8222-222222222222";
        let consumer = service
            .new_project(
                &temp.path().join("Consumer"),
                "Consumer",
                consumer_id,
                consumer_id,
            )
            .unwrap();
        let consumer_sheet = first_sheet(&service, &consumer);
        let consumer_root = PathBuf::from(&consumer.root);
        let change = service
            .project_add_reference(&consumer_root, &provider_root, None)
            .unwrap();
        assert_eq!(change.manifest.references[0].alias, "Thermo");
        assert_eq!(change.manifest.references[0].path, "../Thermo");
        // The open worksheet of the consumer was refreshed.
        assert!(change
            .worksheets
            .iter()
            .any(|edit| edit.id == consumer_sheet.id));

        let info = &service
            .project_references(&consumer_root)
            .unwrap()
            .references[0];
        assert_eq!(info.name.as_deref(), Some("Thermo"));
        assert!(info.problem.is_none() && !info.out_of_date && !info.trusted);
        service
            .project_trust_reference(&consumer_root, "Thermo", true)
            .unwrap();
        assert!(
            service
                .project_references(&consumer_root)
                .unwrap()
                .references[0]
                .trusted
        );
        // Changed Julia code needs trust again.
        std::fs::create_dir_all(provider_root.join("julia/src")).unwrap();
        std::fs::write(provider_root.join("julia/src/Extra.jl"), "x = 1\n").unwrap();
        assert!(
            !service
                .project_references(&consumer_root)
                .unwrap()
                .references[0]
                .trusted
        );
        // Trusting a worksheet keeps the trusted references.
        service
            .project_trust_reference(&consumer_root, "Thermo", true)
            .unwrap();
        service
            .set_worksheet_trusted(&consumer_sheet.id, true)
            .unwrap();
        assert!(
            service
                .project_references(&consumer_root)
                .unwrap()
                .references[0]
                .trusted
        );

        // A new export is out of date until the reference is updated.
        service
            .project_set_export(&provider_root, "worksheets/main.eqv", "k", true)
            .unwrap();
        assert!(
            service
                .project_references(&consumer_root)
                .unwrap()
                .references[0]
                .out_of_date
        );
        service
            .project_update_reference(&consumer_root, "Thermo")
            .unwrap();
        assert!(
            !service
                .project_references(&consumer_root)
                .unwrap()
                .references[0]
                .out_of_date
        );

        // A missing provider is a problem of the reference and of the open worksheet.
        std::fs::rename(&provider_root, temp.path().join("Moved")).unwrap();
        let change = service.project_reload_references(&consumer_root).unwrap();
        let edit = change
            .worksheets
            .iter()
            .find(|edit| edit.id == consumer_sheet.id)
            .unwrap();
        let diagnostics = edit.delta.diagnostics.as_ref().unwrap();
        assert!(diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("reference `Thermo`")));
        assert!(service
            .project_references(&consumer_root)
            .unwrap()
            .references[0]
            .problem
            .as_deref()
            .is_some_and(|problem| problem.contains("was not found")));
        service
            .project_remove_reference(&consumer_root, "Thermo")
            .unwrap();
        service.shutdown();
    }

    #[test]
    fn project_asset_deletion_protects_surviving_worksheets() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Beam", id, id)
            .unwrap();
        let created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(&created.root);
        service.close_worksheet(&created_sheet.id).unwrap();
        std::fs::create_dir_all(root.join("assets/group")).unwrap();
        let image = "assets/group/beam.png";
        std::fs::write(root.join(image), tiny_png(10, 10)).unwrap();
        std::fs::write(root.join("assets/group/unused.png"), tiny_png(10, 10)).unwrap();
        let sheet = format!("format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [54, 72]\n    image:\n      resource: img1\n      size: [60, 30]\nresources:\n  img1:\n    media: png\n    asset: {image}\n");
        std::fs::write(root.join("worksheets/main.eqv"), &sheet).unwrap();
        let before = std::fs::read(root.join("worksheets/main.eqv")).unwrap();
        let error = service.project_delete(&root, image).unwrap_err();
        assert!(
            error.message.contains(image) && error.message.contains("worksheets/main.eqv"),
            "{}",
            error.message
        );
        assert!(error.message.contains("save the worksheet"));
        assert!(root.join(image).exists());
        assert_eq!(
            std::fs::read(root.join("worksheets/main.eqv")).unwrap(),
            before
        );
        service
            .project_delete(&root, "assets/group/unused.png")
            .unwrap();
        assert!(!root.join("assets/group/unused.png").exists());

        // The folder contains one owner, but the surviving worksheet also owns the image.
        std::fs::write(root.join("assets/group/owner.eqv"), &sheet).unwrap();
        let mut manifest = created.manifest;
        manifest.worksheets.push(WorksheetEntry {
            id: "22222222-2222-4222-8222-222222222222".into(),
            path: "assets/group/owner.eqv".into(),
        });
        std::fs::write(
            root.join("equavela-project.yaml"),
            manifest.to_yaml().unwrap(),
        )
        .unwrap();
        let error = service.project_delete(&root, "assets/group").unwrap_err();
        assert!(
            error.message.contains(image) && error.message.contains("worksheets/main.eqv"),
            "{}",
            error.message
        );
        assert!(root.join(image).exists() && root.join("assets/group/owner.eqv").exists());
        std::fs::write(
            root.join("worksheets/main.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        service.project_delete(&root, "assets/group").unwrap();
        assert!(!root.join("assets/group").exists());
        assert!(root.join("worksheets/main.eqv").exists());
        service.shutdown();
    }

    #[test]
    fn project_asset_deletion_ignores_orphans_and_checks_external_worksheets() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Beam", id, id)
            .unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(&created.root);
        std::fs::create_dir_all(root.join("assets/images")).unwrap();
        std::fs::write(root.join("assets/images/orphan.png"), tiny_png(10, 10)).unwrap();
        std::fs::write(root.join("assets/images/live.png"), tiny_png(10, 10)).unwrap();
        // This sheet was added outside the explorer and is absent from the manifest.
        let sheet = root.join("worksheets/external.eqv");
        std::fs::write(&sheet, "format: equavela-worksheet/3\nregions: []\nresources:\n  img1:\n    media: png\n    asset: assets/images/orphan.png\n").unwrap();
        service
            .project_delete(&root, "assets/images/orphan.png")
            .unwrap();
        assert!(!root.join("assets/images/orphan.png").exists());
        std::fs::write(&sheet, "format: equavela-worksheet/3\nregions:\n  - id: r1\n    at: [54, 72]\n    image:\n      resource: img1\n      size: [60, 30]\nresources:\n  img1:\n    media: png\n    asset: assets/images/live.png\n").unwrap();
        // A successful tree operation may index it, so remove it again to verify discovery.
        let mut manifest = Service::project_manifest(&root).unwrap().1;
        manifest
            .worksheets
            .retain(|sheet| sheet.path != "worksheets/external.eqv");
        std::fs::write(
            root.join("equavela-project.yaml"),
            manifest.to_yaml().unwrap(),
        )
        .unwrap();
        let error = service
            .project_delete(&root, "assets/images/live.png")
            .unwrap_err();
        assert!(
            error.message.contains("worksheets/external.eqv")
                && error.message.contains("assets/images/live.png")
        );
        assert!(root.join("assets/images/live.png").exists());
        service.shutdown();
    }

    #[test]
    fn project_asset_deletion_protects_unsaved_image_references() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let id = "11111111-1111-4111-8111-111111111111";
        let created = service
            .new_project(&temp.path().join("project"), "Beam", id, id)
            .unwrap();
        let created_sheet = first_sheet(&service, &created);
        let root = PathBuf::from(&created.root);
        let source = temp.path().join("unsaved.png");
        std::fs::write(&source, tiny_png(10, 10)).unwrap();
        service
            .add_image_file(&created_sheet.id, &source, 1, 72.0, 72.0)
            .unwrap();
        let asset = "assets/images/unsaved.png";
        let error = service.project_delete(&root, asset).unwrap_err();
        assert!(
            error.message.contains(asset) && error.message.contains("worksheets/main.eqv"),
            "{}",
            error.message
        );
        assert!(root.join(asset).exists());
        assert!(service.worksheet(&created_sheet.id).is_ok());
        service.shutdown();
    }

    #[test]
    fn project_text_files_and_images_open_and_save() {
        //  through the service.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let pid = "11111111-1111-4111-8111-111111111111";
        let root = PathBuf::from(
            service
                .new_project(&temp.path().join("p"), "Beam", pid, pid)
                .unwrap()
                .root,
        );
        let file = service
            .project_read_text(&root, "julia/src/Beam.jl")
            .unwrap();
        assert_eq!(file.text, "module Beam\n\nend\n");
        let saved = service
            .project_write_text(
                &root,
                "julia/src/Beam.jl",
                "module Beam\nf() = 1\nend\n",
                &file.version,
            )
            .unwrap();
        // No kernel runs for the project yet, so nothing restarts.
        assert!(!saved.restarted);
        assert_ne!(saved.version, file.version);
        let stale = service
            .project_write_text(&root, "julia/src/Beam.jl", "x", &file.version)
            .unwrap_err();
        assert!(
            stale.message.contains("changed on disk"),
            "{}",
            stale.message
        );
        std::fs::write(root.join("logo.svg"), "<svg/>").unwrap();
        assert_eq!(
            service.project_image(&root, "logo.svg").unwrap(),
            "data:image/svg+xml;base64,PHN2Zy8+"
        );
        assert!(service.project_read_text(&root, "../x").is_err());
        service.shutdown();
    }

    #[test]
    fn the_project_tree_is_managed_and_open_tabs_follow_it() {
        //  through the service.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(temp.path().join("environments"));
        let root = temp.path().join("project");
        let pid = "11111111-1111-4111-8111-111111111111";
        let main = service.new_project(&root, "beam design", pid, pid).unwrap();
        let root = PathBuf::from(&main.root);
        // the environment is the project's Julia package.
        let project_toml = std::fs::read_to_string(root.join("julia/Project.toml")).unwrap();
        assert!(
            project_toml.starts_with("name = \"BeamDesign\"\nuuid = \""),
            "{project_toml}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("julia/src/BeamDesign.jl")).unwrap(),
            "module BeamDesign\n\nend\n"
        );

        let created = service
            .project_create(&root, "worksheets", "Loads", "worksheet")
            .unwrap();
        let loads = created.opened.unwrap();
        assert_eq!(loads.environment.kind, EnvironmentKind::Project);
        assert_eq!(created.manifest.worksheets.len(), 2);
        let id = created.manifest.worksheets[0].id.clone();
        assert_eq!(created.manifest.worksheets[0].path, "worksheets/Loads.eqv");
        let julia = service
            .project_create(&root, "julia/src", "tools", "julia")
            .unwrap();
        assert!(julia
            .entries
            .iter()
            .any(|entry| entry.path == "julia/src/tools.jl"));
        assert!(std::fs::read_to_string(root.join("julia/src/tools.jl"))
            .unwrap()
            .contains("using BeamDesign"));
        service.project_create(&root, "", "data", "folder").unwrap();

        // A move keeps the worksheet's id and reopens its tab from the new path.
        let moved = service
            .project_move(&root, "worksheets/Loads.eqv", "data")
            .unwrap();
        assert_eq!(moved.replaced.len(), 1);
        assert_eq!(moved.replaced[0].id, loads.id);
        let sheet = moved
            .manifest
            .worksheets
            .iter()
            .find(|sheet| sheet.path == "data/Loads.eqv")
            .unwrap();
        assert_eq!(sheet.id, id);
        let renamed = service.project_rename(&root, "data", "inputs").unwrap();
        assert!(renamed.replaced[0]
            .opened
            .root
            .as_str()
            .ends_with("inputs/Loads.eqv"));

        // A file put in the folder by another program is a worksheet at the next listing.
        std::fs::write(
            root.join("extra.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        let listed = service.project_tree(&root).unwrap();
        assert!(listed
            .manifest
            .worksheets
            .iter()
            .any(|sheet| sheet.path == "extra.eqv"));

        assert!(service.project_delete(&root, "julia").is_err());
        assert!(service.project_create(&root, "", "x", "picture").is_err());
        service.shutdown();
    }

    #[test]
    fn environment_problems_are_worksheet_problems() {
        // a standalone worksheet without the key uses the shared environment; a
        // missing override is a problem of the worksheet.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let plain = temp.path().join("plain.eqv");
        std::fs::write(&plain, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let opened = service.open_worksheet(&plain).unwrap();
        assert!(opened.diagnostics.is_empty());
        let session = service.worksheet(&opened.id).unwrap();
        let environment = lock(&session.session).environment();
        assert_eq!(environment.kind, EnvironmentKind::Shared);
        assert!(environment.directory.ends_with("DefaultEnv"));
        let broken = temp.path().join("broken.eqv");
        std::fs::write(
            &broken,
            "format: equavela-worksheet/3\nenvironment: gone\nregions: []\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&broken).unwrap();
        assert_eq!(opened.diagnostics.len(), 1);
        assert_eq!(opened.diagnostics[0].region_id, "");
        assert!(opened.diagnostics[0].message.contains("gone"));
        service.shutdown();
    }

    #[test]
    fn each_environment_has_its_own_kernel_released_with_its_last_worksheet() {
        // worksheets with the same environment share one kernel; another
        // environment gets its own, stopped when its last worksheet closes.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let sheet = |name: &str, environment: Option<&str>| {
            let path = temp.path().join(name);
            let key = environment.map_or(String::new(), |dir| format!("environment: {dir}\n"));
            std::fs::write(
                &path,
                format!("format: equavela-worksheet/3\n{key}regions: []\n"),
            )
            .unwrap();
            service.open_worksheet(&path).unwrap().id
        };
        std::fs::create_dir(temp.path().join("env")).unwrap();
        let shared_a = sheet("a.eqv", None);
        let shared_b = sheet("b.eqv", None);
        let own_c = sheet("c.eqv", Some("env"));
        let own_d = sheet("d.eqv", Some("env"));
        let key_of = |id: &str| lock(&service.worksheet(id).unwrap().kernel_key).clone();
        assert_eq!(key_of(&shared_a), key_of(&shared_b));
        assert_eq!(key_of(&shared_a), service.shared_kernel_key());
        assert_eq!(key_of(&own_c), key_of(&own_d));
        assert_eq!(
            key_of(&own_c),
            temp.path().join("env").canonicalize().unwrap()
        );
        assert_eq!(lock(&service.kernels).len(), 2);
        let own = key_of(&own_c);
        service.close_worksheet(&own_c).unwrap();
        assert!(lock(&service.kernels).contains_key(&own));
        service.close_worksheet(&own_d).unwrap();
        assert!(!lock(&service.kernels).contains_key(&own));
        // The shared kernel stays even with no standalone worksheet open.
        service.close_worksheet(&shared_a).unwrap();
        service.close_worksheet(&shared_b).unwrap();
        assert!(lock(&service.kernels).contains_key(&service.shared_kernel_key()));
        service.shutdown();
    }

    /// two environments with different versions of one package do not see each other.
    #[test]
    fn worksheets_with_different_environments_do_not_contaminate_each_other() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let uuid = "d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b13";
        let (service, events) = service(None);
        let mut values = Vec::new();
        for (name, factor) in [("three", 3), ("four", 4)] {
            let dir = temp.path().join(name);
            std::fs::create_dir_all(dir.join("Foo/src")).unwrap();
            std::fs::write(
                dir.join("Foo/Project.toml"),
                format!("name = \"Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"),
            )
            .unwrap();
            std::fs::write(
                dir.join("Foo/src/Foo.jl"),
                format!("module Foo\nscale(x) = {factor}x\nend\n"),
            )
            .unwrap();
            std::fs::write(
                dir.join("Project.toml"),
                format!("[deps]\nFoo = \"{uuid}\"\n"),
            )
            .unwrap();
            std::fs::write(
                dir.join("Manifest.toml"),
                format!("manifest_format = \"2.0\"\n\n[[deps.Foo]]\npath = \"Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"),
            )
            .unwrap();
            let path = dir.join("sheet.eqv");
            std::fs::write(
                &path,
                "format: equavela-worksheet/3\nenvironment: .\nregions:\n  - id: j1\n    at: [0, 10]\n    julia:\n      using: [Foo]\n      import:\n        scale: Foo.scale\n  - id: f\n    at: [0, 15]\n    math: \"Scale(x) := julia.scale\"\n  - id: r1\n    at: [0, 20]\n    math: \"Scale(2) =\"\n",
            )
            .unwrap();
            let id = service.open_worksheet(&path).unwrap().id;
            service.set_worksheet_trusted(&id, true).unwrap();
            service.recalculate(&id, true).unwrap();
            collect_until(&events, "pass_finished");
            let results = serde_json::to_value(service.results(&id).unwrap()).unwrap();
            let r1 = results
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["key"]["region_id"] == "r1")
                .cloned()
                .unwrap();
            values.push(r1["value"]["value"].as_f64().unwrap_or(f64::NAN));
        }
        assert_eq!(values, [6.0, 8.0]);
        assert_eq!(lock(&service.kernels).len(), 3, "shared, three, four");
        service.shutdown();
    }

    #[test]
    fn the_environment_manager_describes_the_worksheet_environment() {
        // kind, files and dependencies; only a saved standalone worksheet
        // may choose another environment.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let untitled = service.new_worksheet().unwrap();
        assert_eq!(untitled.environment.kind, EnvironmentKind::Shared);
        assert!(untitled.environment.directory.ends_with("DefaultEnv"));
        assert!(!service.environment_info(&untitled.id).unwrap().can_override);

        let env = temp.path().join("env");
        std::fs::create_dir(&env).unwrap();
        std::fs::write(
            env.join("Project.toml"),
            "[deps]\nFoo = \"d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b14\"\n",
        )
        .unwrap();
        let path = temp.path().join("own.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nenvironment: env\nregions: []\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        assert_eq!(opened.environment.kind, EnvironmentKind::Override);
        assert_eq!(
            opened.environment.kernel,
            slash_path(&env.canonicalize().unwrap())
        );
        let info = service.environment_info(&opened.id).unwrap();
        assert!(info.can_override);
        assert!(info.files.project_exists);
        assert_eq!(info.files.dependencies[0].name, "Foo");
        assert!(!info.files.dependencies[0].installed);
        assert!(matches!(info.kernel_status, KernelStatus::NotStarted));
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["kind"], "override");
        assert_eq!(json["files"]["dependencies"][0]["name"], "Foo");

        let project = temp.path().join("project");
        let pid = "11111111-1111-4111-8111-111111111111";
        let created = service.new_project(&project, "P", pid, pid).unwrap();
        let created_sheet = first_sheet(&service, &created);
        assert_eq!(created_sheet.environment.kind, EnvironmentKind::Project);
        assert!(
            !service
                .environment_info(&created_sheet.id)
                .unwrap()
                .can_override
        );
        service.shutdown();
    }

    #[test]
    fn a_standalone_worksheet_can_choose_its_environment_with_undo() {
        // one undo step, relative under the worksheet's folder, absolute elsewhere; the
        // worksheet moves between kernels; refused for untitled and project worksheets.
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let path = temp.path().join("calc.eqv");
        std::fs::write(&path, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let id = service.open_worksheet(&path).unwrap().id;
        let key = || lock(&service.worksheet(&id).unwrap().kernel_key).clone();
        assert_eq!(key(), service.shared_kernel_key());
        let env = temp.path().join("julia env");
        std::fs::create_dir(&env).unwrap();
        let result = service.set_worksheet_environment(&id, Some(&env)).unwrap();
        assert_eq!(result.label.as_deref(), Some("Change environment"));
        assert!(result.calc_needed);
        let summary = result.environment.unwrap();
        assert_eq!(summary.kind, EnvironmentKind::Override);
        assert!(!summary.absolute);
        assert_eq!(key(), env.canonicalize().unwrap());
        service.save_worksheet(&id).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("environment: julia env\n"), "{text}");

        let elsewhere = tempfile::tempdir().unwrap();
        let summary = service
            .set_worksheet_environment(&id, Some(elsewhere.path()))
            .unwrap()
            .environment
            .unwrap();
        assert!(summary.absolute);
        // The kernel of "julia env" had only this worksheet: it is released.
        assert!(!lock(&service.kernels).contains_key(&env.canonicalize().unwrap()));
        let undone = service.undo(&id).unwrap();
        assert_eq!(undone.environment.unwrap().kind, EnvironmentKind::Override);
        assert_eq!(key(), env.canonicalize().unwrap());
        let cleared = service.set_worksheet_environment(&id, None).unwrap();
        assert_eq!(cleared.environment.unwrap().kind, EnvironmentKind::Shared);
        assert_eq!(key(), service.shared_kernel_key());
        // An edit that is not about the environment carries none.
        let plain = service.undo(&id).unwrap();
        assert!(plain.environment.is_some(), "undo of the clear moves back");
        assert!(service.redo(&id).unwrap().environment.is_some());

        let untitled = service.new_worksheet().unwrap().id;
        assert_eq!(
            service
                .set_worksheet_environment(&untitled, Some(&env))
                .unwrap_err()
                .kind,
            "environment"
        );
        let project = temp.path().join("project");
        let pid = "11111111-1111-4111-8111-111111111111";
        let created = service.new_project(&project, "P", pid, pid).unwrap();
        let _created_sheet = first_sheet(&service, &created);
        let in_project = first_sheet(&service, &created).id;
        assert_eq!(
            service
                .set_worksheet_environment(&in_project, None)
                .unwrap_err()
                .kind,
            "environment"
        );
        service.shutdown();
    }

    /// Switching environments interrupts a calculation on the old kernel before replacing its
    /// handle; otherwise the pass can continue with the old environment after the switch.
    #[test]
    fn changing_environment_interrupts_a_running_pass_on_the_old_kernel() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, events) = service(None);
        let path = temp.path().join("switch-during-pass.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nregions:\n  - id: f\n    at: [0, 0]\n    math: |\n      Long(n) := program\n        s ← 0\n        for i ∈ 1..n\n          s ← s + i\n        s\n  - id: run\n    at: [0, 40]\n    math: \"Long(10000000000) =\"\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        service.recalculate(&opened.id, false).unwrap();
        wait_for_region_started(&events, "run");
        // Let the kernel enter the loop so the test covers an active request on the old kernel.
        std::thread::sleep(Duration::from_millis(500));

        let environment = temp.path().join("new-environment");
        std::fs::create_dir(&environment).unwrap();
        let result = service
            .set_worksheet_environment(&opened.id, Some(&environment))
            .unwrap();
        assert!(result.calc_needed);
        collect_until(&events, "pass_finished");
        let results = serde_json::to_value(service.results(&opened.id).unwrap()).unwrap();
        let run = results
            .as_array()
            .unwrap()
            .iter()
            .find(|region| region["key"]["region_id"] == "run")
            .unwrap();
        // The environment change invalidates the old pass, so its old-environment result must
        // not be published. Since auto-calculate is off in this test, the new value is pending.
        assert_eq!(run["state"], "pending", "{run}");
        // PassFinished is emitted by the pass before the worker clears its running flag.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while service
            .worksheet(&opened.id)
            .unwrap()
            .running
            .load(Ordering::SeqCst)
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!service
            .worksheet(&opened.id)
            .unwrap()
            .running
            .load(Ordering::SeqCst));
        service.shutdown();
    }

    #[test]
    fn shared_environment_keeps_legacy_metadata_and_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let legacy = root.join("standalone");
        std::fs::create_dir(&legacy).unwrap();
        assert_eq!(
            EnvironmentPaths::new(root.into()).shared,
            root.join("DefaultEnv")
        );

        let project = legacy.join("JuliaProject.toml");
        std::fs::write(&project, "[deps]\n").unwrap();
        assert_eq!(EnvironmentPaths::new(root.into()).shared, legacy);

        std::fs::remove_file(project).unwrap();
        SnapshotStore::new(root.join(".snapshots"))
            .begin(&legacy, "add", &["Example".into()])
            .unwrap();
        assert_eq!(EnvironmentPaths::new(root.into()).shared, legacy);
    }

    #[test]
    fn shared_environment_update_initializes_metadata_and_can_be_undone() {
        if !julia_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(None);
        let environments = temp.path().join("environments");
        service.set_environments_dir(environments.clone());
        let path = temp.path().join("update.eqv");
        std::fs::write(&path, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        service.set_worksheet_trusted(&opened.id, true).unwrap();
        let project = environments.join("DefaultEnv").join("Project.toml");
        assert!(!project.exists());

        let info = service.manage_environment(&opened.id, "update").unwrap();
        assert_eq!(info.summary.kind, EnvironmentKind::Shared);
        assert!(info.files.project_exists);
        assert!(info.files.manifest_exists);
        assert!(info.files.dependencies.is_empty());
        assert_eq!(std::fs::read_to_string(&project).unwrap(), "[deps]\n");
        assert!(!temp.path().join("Project.toml").exists());

        let undone = service
            .revert_environment_change(&opened.id, false, true)
            .unwrap();
        assert!(!undone.files.project_exists);
        assert!(!undone.files.manifest_exists);
        assert!(!project.exists());
        service.shutdown();
    }

    #[test]
    fn environment_maintenance_validates_operation_and_trust_before_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let path = temp.path().join("maintenance.eqv");
        std::fs::write(&path, "format: equavela-worksheet/3\nregions: []\n").unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        let directory = service
            .environment_info(&opened.id)
            .unwrap()
            .summary
            .directory;
        assert!(!Path::new(&directory).exists());
        for operation in ["instantiate", "resolve", "update"] {
            let error = service
                .manage_environment(&opened.id, operation)
                .unwrap_err();
            assert!(error.message.contains("not trusted"));
        }
        let error = service
            .manage_environment(&opened.id, "eval arbitrary code")
            .unwrap_err();
        assert!(error.message.contains("unknown environment operation"));
        assert!(!Path::new(&directory).exists());
        service.shutdown();
    }

    #[test]
    fn compatibility_changes_are_trusted_and_reflected_in_environment_info() {
        if !julia_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(None);
        let env = temp.path().join("environment");
        std::fs::create_dir(&env).unwrap();
        let project = env.join("Project.toml");
        std::fs::write(
            &project,
            "[deps]\nLinearAlgebra = \"37e2e46d-f89d-539d-b4ee-838fcccc9c8e\"\n",
        )
        .unwrap();
        let sheet = temp.path().join("compat.eqv");
        std::fs::write(
            &sheet,
            "format: equavela-worksheet/3\nenvironment: environment\nregions: []\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&sheet).unwrap();
        let before = std::fs::read(&project).unwrap();
        assert!(service
            .set_compatibility(&opened.id, "LinearAlgebra", "1")
            .unwrap_err()
            .message
            .contains("not trusted"));
        assert_eq!(std::fs::read(&project).unwrap(), before);
        service.set_worksheet_trusted(&opened.id, true).unwrap();
        let info = service
            .set_compatibility(&opened.id, "LinearAlgebra", "1")
            .unwrap();
        assert_eq!(
            info.files.dependencies[0].compatibility.as_deref(),
            Some("1")
        );
        let stable = std::fs::read(&project).unwrap();
        assert!(service
            .set_compatibility(&opened.id, "MissingDependency", "1")
            .is_err());
        assert_eq!(std::fs::read(&project).unwrap(), stable);
        let info = service
            .set_compatibility(&opened.id, "LinearAlgebra", "")
            .unwrap();
        assert_eq!(info.files.dependencies[0].compatibility, None);
        service.shutdown();
    }

    #[test]
    fn environment_resolve_uses_the_selected_directory() {
        if !julia_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(None);
        let path = temp.path().join("resolve.eqv");
        let env = temp.path().join("environment");
        std::fs::create_dir(&env).unwrap();
        std::fs::write(env.join("Project.toml"), "[deps]\n").unwrap();
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nenvironment: environment\nregions: []\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        service.set_worksheet_trusted(&opened.id, true).unwrap();
        let manager = Arc::clone(lock(&service.worksheet(&opened.id).unwrap().session).kernel());
        manager.start().unwrap();
        let generation = manager.generation();
        let info = service.manage_environment(&opened.id, "resolve").unwrap();
        assert!(same_dir(&info.summary.directory, &env));
        assert!(env.join("Manifest.toml").is_file());
        assert!(manager.generation() > generation);
        service.shutdown();
    }

    /// removing a package runs Pkg.rm in the worksheet's environment; untrusted refuses.
    #[test]
    fn an_interrupted_package_change_is_reported_and_blocks_until_settled() {
        // a snapshot left `pending` by a crash, found by a new service.
        let temp = tempfile::tempdir().unwrap();
        let env = temp.path().join("env");
        std::fs::create_dir(&env).unwrap();
        std::fs::write(env.join("Project.toml"), "[deps]\n").unwrap();
        let path = temp.path().join("sheet.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nenvironment: env\nregions: []\n",
        )
        .unwrap();
        let environments = temp.path().join("environments");
        SnapshotStore::new(environments.join(".snapshots"))
            .begin(&env, "update", &[])
            .unwrap();
        std::fs::write(env.join("Manifest.toml"), "manifest_format = \"2.0\"\n").unwrap();

        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        service.set_environments_dir(environments);
        let id = service.open_worksheet(&path).unwrap().id;
        let info = service.environment_info(&id).unwrap();
        assert_eq!(info.interrupted_change.unwrap().operation, "update");
        assert!(info.last_change.is_none());
        // Untrusted: nothing is settled.
        assert!(service.revert_environment_change(&id, true, true).is_err());
        service.set_worksheet_trusted(&id, true).unwrap();
        let blocked = service
            .change_packages(&id, &["Foo".to_owned()], false)
            .unwrap_err();
        assert!(
            blocked.message.contains("interrupted"),
            "{}",
            blocked.message
        );
        // Keep current files: the snapshot goes, the files stay.
        let kept = service.revert_environment_change(&id, true, false).unwrap();
        assert!(kept.interrupted_change.is_none());
        assert!(env.join("Manifest.toml").exists());
        assert!(service.revert_environment_change(&id, true, false).is_err());
        service.shutdown();
    }

    #[test]
    fn restart_kernel_starts_the_environment_kernel_again() {
        // no trust needed, no file changes, a new process.
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let path = write_worksheet("restart", SHEET);
        let (service, _) = service(None);
        let id = service.open_worksheet(&path).unwrap().id;
        let before = std::fs::read_to_string(&path).unwrap();
        let manager = Arc::clone(lock(&service.worksheet(&id).unwrap().session).kernel());
        manager.start().unwrap();
        let generation = manager.generation();
        let info = service.restart_environment_kernel(&id).unwrap();
        assert!(manager.generation() > generation, "a new kernel process");
        assert!(
            matches!(info.kernel_status, KernelStatus::Ready { .. }),
            "{:?}",
            info.kernel_status
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        service.shutdown();
    }

    #[test]
    fn packages_are_removed_from_the_worksheet_environment() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let uuid = "d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b15";
        let dir = temp.path();
        std::fs::create_dir_all(dir.join("Foo/src")).unwrap();
        std::fs::write(
            dir.join("Foo/Project.toml"),
            format!("name = \"Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"),
        )
        .unwrap();
        std::fs::write(dir.join("Foo/src/Foo.jl"), "module Foo\nend\n").unwrap();
        std::fs::write(
            dir.join("Project.toml"),
            format!("[deps]\nFoo = \"{uuid}\"\n"),
        )
        .unwrap();
        std::fs::write(
            dir.join("Manifest.toml"),
            format!("manifest_format = \"2.0\"\n\n[[deps.Foo]]\npath = \"Foo\"\nuuid = \"{uuid}\"\nversion = \"0.1.0\"\n"),
        )
        .unwrap();
        let path = dir.join("sheet.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3\nenvironment: .\nregions: []\n",
        )
        .unwrap();
        let (service, _) = service(None);
        let id = service.open_worksheet(&path).unwrap().id;
        let names = ["Foo".to_owned()];
        assert_eq!(
            service.change_packages(&id, &names, true).unwrap_err().kind,
            "environment",
            "an untrusted worksheet changes no environment"
        );
        service.set_worksheet_trusted(&id, true).unwrap();
        assert_eq!(
            service.environment_info(&id).unwrap().files.dependencies[0].name,
            "Foo"
        );
        let manager = Arc::clone(lock(&service.worksheet(&id).unwrap().session).kernel());
        manager.start().unwrap();
        let generation = manager.generation();
        let info = service.change_packages(&id, &names, true).unwrap();
        assert!(
            manager.generation() > generation,
            "package changes restart the affected kernel"
        );
        assert!(info.files.dependencies.is_empty(), "{:?}", info.files);
        assert!(!std::fs::read_to_string(dir.join("Project.toml"))
            .unwrap()
            .contains("Foo"));
        assert_eq!(
            service.change_packages(&id, &[], false).unwrap_err().kind,
            "environment"
        );

        // the removal can be undone; the snapshot gives the files back byte for byte.
        let last = info.last_change.expect("the removal is undoable");
        assert_eq!(
            (last.operation.as_str(), last.packages.as_slice()),
            ("remove", &names[..])
        );
        let undone = service.revert_environment_change(&id, false, true).unwrap();
        assert_eq!(undone.files.dependencies[0].name, "Foo");
        assert!(undone.last_change.is_none());
        assert!(service.revert_environment_change(&id, false, true).is_err());

        // a failed operation leaves the metadata exactly as it was.
        let project = std::fs::read(dir.join("Project.toml")).unwrap();
        let manifest = std::fs::read(dir.join("Manifest.toml")).unwrap();
        let failed = service
            .change_packages(&id, &["NoSuchPackageForEquavelaTests".to_owned()], false)
            .unwrap_err();
        assert!(failed.message.contains("restored"), "{}", failed.message);
        assert_eq!(std::fs::read(dir.join("Project.toml")).unwrap(), project);
        assert_eq!(std::fs::read(dir.join("Manifest.toml")).unwrap(), manifest);
        let info = service.environment_info(&id).unwrap();
        assert!(info.last_change.is_none() && info.interrupted_change.is_none());
        service.shutdown();
    }

    #[test]
    fn folder_project_rejects_invalid_and_existing_destinations() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            service.new_project(&target, "", id, id).unwrap_err().kind,
            "save"
        );
        assert!(!target.exists());
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "existing").unwrap();
        assert_eq!(
            service
                .new_project(&target, "Example", id, id)
                .unwrap_err()
                .kind,
            "save"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("keep")).unwrap(),
            "existing"
        );
        assert_eq!(service.open_project(&target).unwrap_err().kind, "load");
        let relative = Path::new("relative-project");
        let error = service
            .new_project(relative, "Example", id, id)
            .unwrap_err();
        assert_eq!(error.kind, "save");
        assert!(error.message.contains("absolute"));
        assert!(!relative.exists());
        let error = service.open_project(relative).unwrap_err();
        assert_eq!(error.kind, "load");
        assert!(error.message.contains("absolute"));
    }

    #[test]
    fn folder_project_concurrent_creators_do_not_replace_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("project");
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = ["First", "Second"]
            .into_iter()
            .map(|name| {
                let service = service.clone();
                let barrier = barrier.clone();
                let target = target.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    service.new_project(
                        &target,
                        name,
                        "11111111-1111-4111-8111-111111111111",
                        "22222222-2222-4222-8222-222222222222",
                    )
                })
            })
            .collect();
        let results: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let winner = results
            .iter()
            .find_map(|result| result.as_ref().ok())
            .unwrap();
        assert_eq!(
            load_project_directory(&target).unwrap().manifest.name,
            winner.manifest.name
        );
        service.shutdown();
    }

    fn write_worksheet(name: &str, regions: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("equavela-service-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.eqv");
        std::fs::write(
            &path,
            format!("format: equavela-worksheet/3\nregions:\n{regions}"),
        )
        .unwrap();
        path
    }

    const SHEET: &str = "  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n  - id: b\n    at: [0, 10]\n    math: \"b := a + 1\"\n  - id: show\n    at: [0, 20]\n    math: \"b =\"\n";

    /// The whole view of a worksheet, as the frontend holds it after applying the deltas: the
    /// snapshot. It also resets the baseline, so call it on tests that check state, not in
    /// the middle of a sequence of deltas.
    fn full_view(service: &Service, id: &str) -> DocumentView {
        service.worksheet_snapshot(id).unwrap().view
    }

    /// The whole results list of a worksheet, as the frontend holds it.
    fn full_results(service: &Service, id: &str) -> Vec<RegionEntry> {
        service.worksheet_snapshot(id).unwrap().regions
    }

    /// Collects events until a `worksheet-event` named `until` arrives.
    fn collect_until(events: &Events, until: &str) -> Vec<(String, Value)> {
        let mut seen = Vec::new();
        loop {
            let event = events
                .recv_timeout(Duration::from_secs(240))
                .expect("event before timeout");
            let done = event.0 == EVENT_WORKSHEET && event.1["event"] == until;
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    /// Waits until the pass starts the region `region_id` (its `region_started` event).
    fn wait_for_region_started(events: &Events, region_id: &str) {
        loop {
            let (name, payload) = events
                .recv_timeout(Duration::from_secs(240))
                .expect("event before timeout");
            if name == EVENT_WORKSHEET
                && payload["event"] == "region_started"
                && payload["key"]["region_id"] == region_id
            {
                return;
            }
        }
    }

    #[test]
    fn open_reports_pending_regions_and_texts_without_a_kernel() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("open", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        assert_eq!(opened.regions.len(), 3);
        assert!(opened
            .regions
            .iter()
            .all(|r| matches!(r.state, equavela_core::session::RegionState::Pending)));
        assert_eq!(opened.texts.len(), 3);
        assert!(opened.diagnostics.is_empty());
        let json = serde_json::to_value(&opened).unwrap();
        assert_eq!(json["regions"][0]["state"], "pending");
        assert_eq!(json["regions"][0]["key"]["region_id"], "a");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A minimal `.mcdx` (one definition, one evaluation, one text) written to a temp folder.
    fn write_mcdx(name: &str) -> PathBuf {
        use std::io::Write;
        let dir =
            std::env::temp_dir().join(format!("equavela-import-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.mcdx");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file(
            "mathcad/worksheet.xml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(
            br#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
<region region-id="0" top="0" left="0"><math><ml:define><ml:id>a</ml:id><ml:real>2</ml:real></ml:define></math></region>
<region region-id="1" top="40" left="0"><math><ml:eval><ml:apply><ml:plus /><ml:id>a</ml:id><ml:real>1</ml:real></ml:apply></ml:eval></math></region>
<region region-id="2" top="80" left="0"><plot /></region>
</regions></worksheet>"#,
        )
        .unwrap();
        zip.finish().unwrap();
        path
    }

    #[test]
    fn import_opens_an_untitled_worksheet_and_leaves_the_mcdx_alone() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_mcdx("untitled");
        let dir = path.parent().unwrap().to_path_buf();
        let before = std::fs::read(&path).unwrap();
        let listing = |d: &Path| {
            let mut names: Vec<_> = std::fs::read_dir(d)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let before_listing = listing(&dir);
        let imported = service.import_mcdx(&path).unwrap();
        assert_eq!(imported.opened.regions.len(), 2);
        assert_eq!(imported.report.regions_total, 3);
        assert_eq!(imported.report.issues.len(), 1);
        assert_eq!(imported.report.issues[0].code, "plot-not-imported");
        assert!(imported.opened.root.as_str().starts_with("Untitled-"));
        assert!(service.is_untitled(&imported.opened.id).unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(listing(&dir), before_listing);
        // Saving needs a name: it never writes next to the `.mcdx` by itself.
        assert!(service.save_worksheet(&imported.opened.id).is_err());
        assert_eq!(listing(&dir), before_listing);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// an `.xmcd` goes through the same command, chosen by its extension.
    #[test]
    fn import_reads_an_xmcd_by_its_extension() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = std::env::temp_dir().join(format!("equavela-import-xmcd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("old.xmcd");
        std::fs::write(
            &path,
            br#"<worksheet xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>
<region region-id="0" top="0" left="0"><math><ml:define><ml:id>a</ml:id><ml:real>2</ml:real></ml:define></math></region>
<region region-id="1" top="30" left="0"><plot item-idref="1"/></region>
</regions></worksheet>"#,
        )
        .unwrap();
        let imported = service.import_mcdx(&path).unwrap();
        assert_eq!(imported.opened.regions.len(), 1);
        assert_eq!(imported.report.regions_total, 2);
        assert_eq!(imported.report.issues[0].code, "plot-not-imported");
        assert!(service.is_untitled(&imported.opened.id).unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn importing_a_file_that_is_not_a_worksheet_fails_with_load() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = std::env::temp_dir().join(format!("equavela-import-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.mcdx");
        std::fs::write(&path, b"not a zip").unwrap();
        let error = service.import_mcdx(&path).unwrap_err();
        assert_eq!(error.kind, "load");
        assert!(error.message.contains("not an .mcdx worksheet"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn edit_validates_and_returns_stale_regions() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("edit", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let document = opened.root.as_str().to_owned();
        let error = service
            .edit_region(&opened.id, &document, "a", "a := := 1")
            .unwrap_err();
        assert_eq!(error.kind, "parse");
        assert_eq!(error.line, Some(1));
        assert!(error.start.is_some());
        let error = service
            .edit_region(&opened.id, &document, "zzz", "a := 1")
            .unwrap_err();
        assert_eq!(error.kind, "region");
        let stale = service
            .edit_region(&opened.id, &document, "a", "a := 5")
            .unwrap();
        assert_eq!(stale.len(), 3);
        assert_eq!(
            service
                .edit_region("nope", &document, "a", "a := 1")
                .unwrap_err()
                .kind,
            "unknown_worksheet"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn open_errors_are_load_errors() {
        let (service, _events) = service(None);
        let error = service
            .open_worksheet(Path::new("/definitely/not/here.eqv"))
            .unwrap_err();
        assert_eq!(error.kind, "load");
    }

    #[test]
    fn a_missing_kernel_is_reported_as_status_and_pass_failure() {
        let (service, events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("nokernel", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        service.recalculate(&opened.id, false).unwrap();
        let seen = collect_until(&events, "pass_failed");
        assert!(seen
            .iter()
            .any(|(name, payload)| name == EVENT_KERNEL_STATUS && payload["status"] == "crashed"));
        assert!(matches!(
            service.kernel_status(),
            KernelStatus::Crashed { .. }
        ));
        // Results are untouched.
        let results = service.results(&opened.id).unwrap();
        assert_eq!(
            serde_json::to_value(&results).unwrap()[0]["state"],
            "pending"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_given_region_is_a_math_region_added_and_undone_in_one_step() {
        // The keyword region `Given` opens a solve block: the
        // backend adds it as an ordinary math region, whichever UI path asked for it.
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("given-region", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region(id, "math", 1, 30.0, 300.0, Some("Given"))
            .unwrap();
        let region_id = added.created.clone().unwrap();
        let find = |view: &DocumentView| {
            let json = serde_json::to_value(view).unwrap();
            json["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == region_id.as_str())
                .cloned()
        };
        let region = find(&full_view(&service, id)).expect("the Given region is in the view");
        assert_eq!(region["kind"], "math");
        assert_eq!(region["text"], "Given");
        // One undo step removes it again.
        service.undo(id).unwrap();
        assert!(find(&full_view(&service, id)).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Replace All: several regions rewritten by one command, one undo step.
    #[test]
    fn replace_regions_rewrites_several_regions_in_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("replace-regions", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let text_of = |region: &str| {
            let json = serde_json::to_value(full_view(&service, id)).unwrap();
            json["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == region)
                .unwrap()["text"]
                .clone()
        };
        let (a_before, b_before) = (text_of("a"), text_of("b"));
        let rewrites = vec![
            RegionRewrite {
                region_id: "a".into(),
                statement: Some(Service::parse_math("a := 7").unwrap()),
                paragraphs: None,
            },
            RegionRewrite {
                region_id: "b".into(),
                statement: Some(Service::parse_math("b := a + 7").unwrap()),
                paragraphs: None,
            },
        ];
        let replaced = service.replace_regions(id, rewrites).unwrap();
        assert_eq!(replaced.label.as_deref(), Some("Replace"));
        assert_eq!(text_of("a"), "a := 7");
        assert_eq!(text_of("b"), "b := a + 7");
        service.undo(id).unwrap();
        assert_eq!(text_of("a"), a_before);
        assert_eq!(text_of("b"), b_before);
        // A rewrite must hold the math or the text of its region, not both or neither.
        let empty = RegionRewrite {
            region_id: "a".into(),
            statement: None,
            paragraphs: None,
        };
        assert!(service.replace_regions(id, vec![empty]).is_err());
    }

    #[test]
    fn the_math_editor_submits_ast_json_as_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("editor-ast", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let ident = |t: &str| json!({"type": "Ident", "name": {"segments": [{"text": t, "subscript": false}]}});
        // (a + b)·c built by the editor without a Paren node: normalization adds it (N1).
        let statement = json!({
            "type": "Define",
            "target": {"type": "Ident", "name": {"segments": [{"text": "a", "subscript": false}]}},
            "rhs": {"type": "Mul", "left": {"type": "Add", "left": ident("x"), "right": ident("y")}, "right": ident("z")},
            "tail": null,
        });
        assert_eq!(
            Service::statement_text(statement.clone()).unwrap(),
            "a := (x + y)·z"
        );
        let edited = service.set_math(id, "a", statement).unwrap();
        assert_eq!(edited.label.as_deref(), Some("Edit math"));
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        let a = json["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "a")
            .unwrap()
            .clone();
        assert_eq!(a["text"], "a := (x + y)·z");
        assert_eq!(a["statement"]["rhs"]["left"]["type"], "Paren");
        service.undo(id).unwrap();
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_ne!(json["regions"][0]["text"], "a := (x + y)·z");

        let added = service
            .add_math_region(
                id,
                1,
                30.0,
                300.0,
                json!({"type": "Evaluate", "expr": ident("a"), "unit": null}),
            )
            .unwrap();
        assert_eq!(added.created.as_deref(), Some("r1"));
        let error = service
            .set_math(
                id,
                "a",
                json!({"type": "Define", "target": {"type": "Placeholder"}}),
            )
            .unwrap_err();
        assert_eq!(error.kind, "parse");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A new math region stores its presentation line breaks in the same undo step.
    #[test]
    fn a_new_math_region_keeps_its_line_breaks_in_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("editor-breaks", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let ident = |t: &str| json!({"type": "Ident", "name": {"segments": [{"text": t, "subscript": false}]}});
        let breaks = vec![equavela_core::layout::MathBreak {
            path: vec![0],
            offset: None,
        }];
        let added = service
            .add_math_region_with_breaks(
                id,
                1,
                30.0,
                300.0,
                json!({"type": "Evaluate", "expr": ident("a"), "unit": null}),
                breaks.clone(),
            )
            .unwrap();
        let region_id = added.created.clone().unwrap();
        let view = full_view(&service, id);
        let region = view
            .regions
            .iter()
            .find(|region| region.id == region_id)
            .unwrap();
        match &region.content {
            equavela_core::session::ViewContent::Math { breaks: seen, .. } => {
                assert_eq!(seen, &breaks)
            }
            other => panic!("expected a math region, got {other:?}"),
        }
        // The insert and its breaks are one undo step.
        service.undo(id).unwrap();
        let view = full_view(&service, id);
        assert!(!view.regions.iter().any(|region| region.id == region_id));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A page break and the moves of the content below the caret line are one undo step, and the
    /// whole view (not only its regions) says where the pages end.
    #[test]
    fn a_page_break_and_its_moves_are_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("page-break", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let moves = vec![RegionMove {
            region_id: "b".into(),
            page: 2,
            x: 0.0,
            y: 200.0,
        }];
        let added = service.add_page_break(id, 1, 300.0, moves).unwrap();
        assert_eq!(added.label.as_deref(), Some("Add page break"));
        assert_eq!(
            added.page_breaks.as_deref(),
            Some(&[PageBreak { page: 1, y: 300.0 }][..])
        );
        let view = full_view(&service, id);
        assert_eq!(view.page_breaks, vec![PageBreak { page: 1, y: 300.0 }]);
        assert!(view
            .regions
            .iter()
            .any(|region| region.id == "b" && region.page == 2 && region.y == 200.0));
        // A second break on the same page is refused; the first stays and nothing else changes.
        let error = service
            .add_page_break(id, 1, 400.0, Vec::new())
            .unwrap_err();
        assert!(error.message.contains("already ends with a page break"));
        // Undo takes the break and the move back together: one step.
        let undone = service.undo(id).unwrap();
        assert_eq!(undone.label.as_deref(), Some("Add page break"));
        let view = full_view(&service, id);
        assert!(view.page_breaks.is_empty());
        assert!(view
            .regions
            .iter()
            .any(|region| region.id == "b" && region.page == 1 && region.y == 10.0));
        // Redo, then remove the break with the reverse move.
        service.redo(id).unwrap();
        let moves = vec![RegionMove {
            region_id: "b".into(),
            page: 1,
            x: 0.0,
            y: 10.0,
        }];
        let removed = service.remove_page_break(id, 1, moves).unwrap();
        assert_eq!(removed.label.as_deref(), Some("Remove page break"));
        assert_eq!(removed.page_breaks.as_deref(), Some(&[][..]));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn region_commands_edit_the_view_with_undo_and_redo() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("commands", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        assert_eq!(opened.view.regions.len(), 3);
        let id = &opened.id;

        let added = service
            .add_region(id, "math", 1, 30.0, 60.0, Some("c := a + b"))
            .unwrap();
        assert_eq!(added.created.as_deref(), Some("r1"));
        assert_eq!(full_view(&service, id).regions.len(), 4);
        assert_eq!(full_results(&service, id).len(), 4);
        assert!(added.can_undo && !added.can_redo);
        service.add_region(id, "math", 1, 0.0, 90.0, None).unwrap();
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_eq!(json["regions"][4]["text"], "\u{25a1}");
        assert_eq!(
            service
                .add_region(id, "math", 1, 0.0, 0.0, Some("x := := 1"))
                .unwrap_err()
                .kind,
            "parse"
        );
        service
            .add_region(id, "text", 2, 54.0, 72.0, Some("Notes"))
            .unwrap();
        let view = full_view(&service, id);
        assert!(matches!(
            view.regions.last().unwrap().content,
            equavela_core::session::ViewContent::Text { .. }
        ));

        let moved = service
            .move_regions(
                id,
                vec![
                    RegionMove {
                        region_id: "a".into(),
                        page: 1,
                        x: 12.0,
                        y: 300.0,
                    },
                    RegionMove {
                        region_id: "b".into(),
                        page: 2,
                        x: 12.0,
                        y: 330.0,
                    },
                ],
                Vec::new(),
            )
            .unwrap();
        assert_eq!(moved.label.as_deref(), Some("Move regions"));
        let view = full_view(&service, id);
        let a = view.regions.iter().find(|r| r.id == "a").unwrap();
        assert_eq!((a.page, a.x, a.y), (1, 12.0, 300.0));

        let removed = service
            .remove_regions(id, vec!["a".into(), "show".into()])
            .unwrap();
        assert_eq!(removed.label.as_deref(), Some("Delete regions"));
        assert!(full_view(&service, id)
            .regions
            .iter()
            .all(|r| r.id != "a" && r.id != "show"));

        let undone = service.undo(id).unwrap();
        assert_eq!(undone.label.as_deref(), Some("Delete regions"));
        assert!(full_view(&service, id).regions.iter().any(|r| r.id == "a"));
        assert!(undone.can_redo);
        service.redo(id).unwrap();
        assert!(full_view(&service, id).regions.iter().all(|r| r.id != "a"));
        // Undo everything: back to the loaded document.
        let mut last = removed;
        for _ in 0..10 {
            last = service.undo(id).unwrap();
        }
        assert!(!last.can_undo);
        assert_eq!(full_view(&service, id).regions.len(), 3);
        assert_eq!(last.label, None);
        assert_eq!(service.view(id).unwrap().regions.len(), 3);

        let error = service
            .add_region(id, "image", 1, 0.0, 0.0, None)
            .unwrap_err();
        assert_eq!(error.kind, "region");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ---- the wire-level delta --------------------------------------------------

    /// A math edit sends the one region it changed and the results that changed with it, not the
    /// whole view and the whole results list.
    #[test]
    fn an_edit_sends_only_the_region_it_changed() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("delta-edit", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        assert_eq!(opened.revision, 0);
        let delta = service
            .set_math(id, "a", Service::parse_math("a := 5").unwrap())
            .unwrap();
        assert_eq!((delta.base, delta.revision), (0, 1));
        let changed: Vec<&str> = delta.regions.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(changed, ["a"]);
        assert!(delta.removed.is_empty());
        assert!(delta.order.is_none(), "the order did not change");
        assert!(delta.document.is_none() && delta.page.is_none() && delta.settings.is_none());
        assert!(delta.can_undo && !delta.can_redo);
        assert_eq!(delta.undo_label.as_deref(), Some("Edit math"));
        assert_eq!(delta.label.as_deref(), Some("Edit math"));
        // No calculation has run, so no entry changed state: nothing to send for the results
        // (with a kernel the stale entries come too, see
        // `an_edit_after_a_calculation_sends_its_changed_results`).
        assert!(delta.results.is_empty());
        assert!(delta.calc_needed);
        assert!(delta.removed_results.is_empty() && delta.results_order.is_none());
        // A few hundred bytes whatever the size of the worksheet.
        let json = serde_json::to_string(&delta).unwrap();
        assert!(json.len() < 2048, "{} bytes: {json}", json.len());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Undo sends back the region and the results it restored; the rebuilt state is the loaded
    /// document again.
    #[test]
    fn undo_sends_back_the_region_and_results_it_restored() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("delta-undo", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let edited = service
            .set_math(id, "a", Service::parse_math("a := 5").unwrap())
            .unwrap();
        let undone = service.undo(id).unwrap();
        assert_eq!((undone.base, undone.revision), (edited.revision, 2));
        assert_eq!(undone.regions.len(), 1);
        let region = &undone.regions[0];
        assert_eq!(region.id, "a");
        match &region.content {
            equavela_core::session::ViewContent::Math { text, .. } => assert_eq!(text, "a := 2"),
            other => panic!("not a math region: {other:?}"),
        }
        assert_eq!(undone.label.as_deref(), Some("Edit math"));
        // Nothing was calculated before the edit, so undo restores no result.
        assert!(undone.results.is_empty());
        // The state the frontend rebuilds is the one the worksheet had before the edit.
        let view = full_view(&service, id);
        assert_eq!(
            view.regions
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "show"]
        );
        match &view.regions[0].content {
            equavela_core::session::ViewContent::Math { text, .. } => assert_eq!(text, "a := 2"),
            other => panic!("not a math region: {other:?}"),
        }
        assert_eq!(full_results(&service, id).len(), 3);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Adding a region sends it with the new order; removing it reports it as gone, with its
    /// result entry.
    #[test]
    fn added_and_removed_regions_are_reported_with_the_new_order() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("delta-add-remove", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region(id, "math", 1, 54.0, 300.0, Some("c := a + b"))
            .unwrap();
        let created = added.created.clone().unwrap();
        assert_eq!(
            added
                .regions
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            [created.as_str()]
        );
        assert!(added.removed.is_empty());
        let order = added.order.as_ref().expect("the order changed");
        assert_eq!(order.len(), 4);
        assert_eq!(order.last(), Some(&created));
        assert_eq!(added.results.len(), 1);
        let entry_key = entry_id(&added.results[0].key);
        assert_eq!(added.results[0].key.region_id, created);
        assert!(matches!(
            added.results[0].state,
            equavela_core::session::RegionState::Pending
        ));
        assert_eq!(
            added.results_order.as_ref().unwrap().last(),
            Some(&entry_key)
        );

        let removed = service.remove_regions(id, vec![created.clone()]).unwrap();
        assert_eq!(removed.base, added.revision);
        assert!(removed.regions.is_empty(), "no other region changed");
        assert_eq!(removed.removed, std::slice::from_ref(&created));
        let order = removed.order.as_ref().expect("the order changed");
        assert!(!order.contains(&created));
        assert_eq!(removed.removed_results, [entry_key]);
        assert!(removed.results.is_empty());
        // Undoing the delete brings the region and its result back.
        let restored = service.undo(id).unwrap();
        assert_eq!(
            restored
                .regions
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            [created.as_str()]
        );
        assert_eq!(restored.results.len(), 1);
        assert!(restored.removed_results.is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// After a calculation, an edit sends the region it changed and the result entries that went
    /// stale, with their values, and nothing else.
    #[test]
    fn an_edit_after_a_calculation_sends_its_changed_results() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let path = write_worksheet("delta-results", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        service.recalculate(id, false).unwrap();
        collect_until(&events, "pass_finished");
        let delta = service
            .set_math(id, "a", Service::parse_math("a := 5").unwrap())
            .unwrap();
        assert_eq!(
            delta
                .regions
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
        // Exactly the entries the edit made stale, with their previous values.
        let mut stale: Vec<&str> = delta
            .results
            .iter()
            .map(|entry| entry.key.region_id.as_str())
            .collect();
        stale.sort();
        assert_eq!(stale, ["a", "b", "show"]);
        assert!(delta.results.iter().all(|entry| matches!(
            entry.state,
            equavela_core::session::RegionState::Stale { .. }
        )));
        assert!(delta.results.iter().any(|entry| matches!(
            &entry.state,
            equavela_core::session::RegionState::Stale { value: Some(_), .. }
        )));
        assert!(delta.removed_results.is_empty() && delta.results_order.is_none());
        let json = serde_json::to_string(&delta).unwrap();
        assert!(json.len() < 4096, "{} bytes: {json}", json.len());

        // a spaces-only edit of the same statement changes the text but not the work a pass
        // would do, so it asks for no calculation and leaves every result alone.
        service.recalculate(id, false).unwrap();
        collect_until(&events, "pass_finished");
        // A snapshot takes the pass results as the baseline, so the next delta shows the edit
        // alone (a pass does not advance the service's sent baseline).
        service.worksheet_snapshot(id).unwrap();
        let same = service
            .set_math(id, "a", Service::parse_math("a :=  5").unwrap())
            .unwrap();
        assert!(!same.calc_needed);
        assert!(same.results.is_empty());
        assert!(same.regions.iter().all(|region| region.id == "a"));
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// a move that keeps the reading order changes no evaluation and asks for no
    /// calculation; a move that crosses another region does.
    #[test]
    fn a_move_that_keeps_the_reading_order_asks_for_no_calculation() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let path = write_worksheet(
            "move-no-calc",
            "  - id: a\n    at: [0, 0]\n    math: \"a := 2\"\n  - id: c\n    at: [0, 10]\n    math: \"c := 3\"\n  - id: show\n    at: [0, 20]\n    math: \"a + c =\"\n",
        );
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        service.recalculate(id, false).unwrap();
        collect_until(&events, "pass_finished");
        service.worksheet_snapshot(id).unwrap();

        // a (y 0) still sits above c (y 10) and show (y 20): the order is the same.
        let same = service
            .move_regions(
                id,
                vec![RegionMove {
                    region_id: "a".into(),
                    page: 1,
                    x: 0.0,
                    y: 5.0,
                }],
                Vec::new(),
            )
            .unwrap();
        assert!(!same.calc_needed);
        assert!(same.results.is_empty());

        // a now sits below c: the evaluation order changes, so a calculation is due.
        let reordered = service
            .move_regions(
                id,
                vec![RegionMove {
                    region_id: "a".into(),
                    page: 1,
                    x: 0.0,
                    y: 25.0,
                }],
                Vec::new(),
            )
            .unwrap();
        assert!(reordered.calc_needed);
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A snapshot returns the whole state under a new revision, and the deltas count from there;
    /// a frontend that missed a delta can tell by comparing `base` with its revision.
    #[test]
    fn a_snapshot_resynchronises_and_resets_the_baseline() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("delta-snapshot", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let missed = service
            .set_math(id, "a", Service::parse_math("a := 5").unwrap())
            .unwrap();
        let snapshot = service.worksheet_snapshot(id).unwrap();
        assert_eq!(snapshot.revision, missed.revision + 1);
        assert_eq!(snapshot.view.regions.len(), 3);
        assert_eq!(snapshot.regions.len(), 3);
        // The missed delta does not apply to the snapshot's revision.
        assert_ne!(missed.base, snapshot.revision);
        let next = service
            .set_math(id, "a", Service::parse_math("a := 6").unwrap())
            .unwrap();
        assert_eq!(next.base, snapshot.revision);
        assert_eq!(next.regions.len(), 1);
        assert_eq!(next.regions[0].id, "a");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// A reorder sends the new order and no region; a state that did not change sends nothing but
    /// the scalars. No command reorders regions yet (they are in document order), so the
    /// baseline is driven directly.
    #[test]
    fn a_reorder_sends_the_new_order_and_no_region() {
        let math = |id: &str, text: &str| {
            Arc::new(ViewRegion {
                id: id.to_owned(),
                page: 1,
                x: 54.0,
                y: 72.0,
                enabled: true,
                content: equavela_core::session::ViewContent::Math {
                    text: text.to_owned(),
                    statement: Arc::new(parse_statement(text).unwrap()),
                    breaks: Vec::new(),
                    format: None,
                },
            })
        };
        let view = |regions: Vec<Arc<ViewRegion>>| DocumentView {
            document: DocumentId::new("delta.eqv").unwrap(),
            page: PageSetup::default(),
            settings: BTreeMap::new(),
            page_breaks: Vec::new(),
            regions,
            can_undo: false,
            can_redo: false,
            undo_label: None,
            redo_label: None,
            trusted: true,
        };
        let (a, b) = (math("a", "a := 2"), math("b", "b := a + 1"));
        let sent = SentState::capture(7, &view(vec![Arc::clone(&a), Arc::clone(&b)]), &[]);
        // The same regions, swapped: only the order changes. The session hands back the same
        // `Arc<ViewRegion>` for a region it did not rebuild, which is how `advance` tells that a
        // region did not change.
        let swapped = view(vec![Arc::clone(&b), Arc::clone(&a)]);
        let (delta, next) = sent.advance(&swapped, &[]);
        assert_eq!((delta.base, delta.revision), (7, 8));
        assert!(delta.regions.is_empty());
        assert!(delta.removed.is_empty());
        assert_eq!(delta.order, Some(vec!["b".to_owned(), "a".to_owned()]));
        assert!(delta.document.is_none() && delta.page.is_none() && delta.settings.is_none());
        assert_eq!(next.revision, 8);
        let (same, after) = next.advance(&swapped, &[]);
        assert!(same.regions.is_empty() && same.order.is_none() && same.results_order.is_none());
        assert!(same.removed.is_empty() && same.results.is_empty());
        // A region the session rebuilt (a new `Arc`) is sent even if its text looks the same.
        let rebuilt = view(vec![
            Arc::clone(&b),
            math("a", "a := 2"),
            math("c", "c := 1"),
        ]);
        let (changed, _) = after.advance(&rebuilt, &[]);
        let ids: Vec<&str> = changed
            .regions
            .iter()
            .map(|region| region.id.as_str())
            .collect();
        assert_eq!(ids, ["a", "c"]);
        assert_eq!(
            changed.order,
            Some(vec!["b".into(), "a".into(), "c".into()])
        );
    }

    /// A 4 x 2 pixel PNG header (the size is read from the header only).
    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
        bytes.extend(b"IHDR");
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes.extend([8, 2, 0, 0, 0]);
        bytes
    }

    #[test]
    fn images_are_added_resized_saved_and_reopened() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("image");
        let png = tiny_png(400, 200);
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"60\" height=\"30\"><script>alert(1)</script><rect width=\"60\" height=\"30\"/></svg>";
        std::fs::write(dir.join("a.png"), &png).unwrap();
        std::fs::write(dir.join("b.svg"), svg).unwrap();
        std::fs::write(dir.join("c.txt"), "no image").unwrap();
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;

        let first = service
            .add_image_file(id, &dir.join("a.png"), 1, 54.0, 100.0)
            .unwrap();
        assert_eq!(first.removed_parts, 0);
        let created = first.edit.created.clone().unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = &view["regions"][0];
        assert_eq!(region["kind"], "image");
        assert_eq!(region["resource"], "img1");
        assert_eq!(region["media"], "png");
        // 400 x 200 px = 300 x 150 pt, inside the 487 pt printable width of A4.
        assert_eq!(region["size"], json!([300.0, 150.0]));
        let url = service.image_data_url(id, "img1").unwrap();
        assert!(
            url.starts_with("data:image/png;base64,iVBORw0KGgo"),
            "{url}"
        );

        // The same bytes share the resource; an SVG loses its script and is counted.
        service
            .add_image_file(id, &dir.join("a.png"), 1, 54.0, 300.0)
            .unwrap();
        let svg_added = service
            .add_image_file(id, &dir.join("b.svg"), 1, 54.0, 400.0)
            .unwrap();
        assert_eq!(svg_added.removed_parts, 1);
        assert!(service
            .image_data_url(id, "img2")
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));
        assert!(service.image_data_url(id, "img3").is_err());
        // Not an image, and invalid base64.
        assert_eq!(
            service
                .add_image_file(id, &dir.join("c.txt"), 1, 0.0, 0.0)
                .unwrap_err()
                .kind,
            "image"
        );
        assert_eq!(
            service
                .add_image_base64(id, "!!", 1, 0.0, 0.0)
                .unwrap_err()
                .kind,
            "image"
        );
        let pasted = service
            .add_image_base64(
                id,
                &equavela_core::image::base64_encode(&png),
                1,
                54.0,
                500.0,
            )
            .unwrap();
        assert!(pasted.edit.created.is_some());

        // Resize is one undo step and respects the minimum.
        service.set_image_size(id, &created, 150.0, 75.0).unwrap();
        assert_eq!(
            serde_json::to_value(full_view(&service, id)).unwrap()["regions"][0]["size"],
            json!([150.0, 75.0])
        );
        assert!(service.set_image_size(id, &created, 2.0, 75.0).is_err());
        service.undo(id).unwrap();
        assert_eq!(
            serde_json::to_value(service.view(id).unwrap()).unwrap()["regions"][0]["size"],
            json!([300.0, 150.0])
        );
        service.set_image_size(id, &created, 150.0, 75.0).unwrap();

        // Save, reopen: the regions, sizes and bytes come back.
        let target = dir.join("pictures.eqv");
        service.save_worksheet_as(id, &target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("resources:"), "{text}");
        assert!(!text.contains("script"), "{text}");
        let reopened = service.open_worksheet(&target).unwrap();
        let view = serde_json::to_value(service.view(&reopened.id).unwrap()).unwrap();
        let sizes: Vec<_> = view["regions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["size"].clone())
            .collect();
        assert_eq!(sizes[0], json!([150.0, 75.0]));
        assert_eq!(sizes.len(), 4);
        assert_eq!(service.image_data_url(&reopened.id, "img1").unwrap(), url);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_image_goes_back_to_its_original_size_and_is_replaced_in_place() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("image-replace");
        let png = tiny_png(400, 200);
        let small = tiny_png(80, 40);
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"60\" height=\"30\"><script>alert(1)</script><rect width=\"60\" height=\"30\"/></svg>";
        std::fs::write(dir.join("a.png"), &png).unwrap();
        std::fs::write(dir.join("small.png"), &small).unwrap();
        std::fs::write(dir.join("b.svg"), svg).unwrap();
        std::fs::write(dir.join("c.txt"), "no image").unwrap();
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let added = service
            .add_image_file(id, &dir.join("a.png"), 1, 54.0, 100.0)
            .unwrap();
        let region_id = added.edit.created.clone().unwrap();
        let image = |service: &Service| {
            let view = serde_json::to_value(full_view(service, id)).unwrap();
            view["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == json!(region_id))
                .cloned()
                .unwrap()
        };
        // 400 x 200 px = 300 x 150 pt, the natural size of the picture.
        assert_eq!(image(&service)["size"], json!([300.0, 150.0]));

        // Original Size on an image that is already at its own size records no undo step.
        let unchanged = service.original_image_size(id, &region_id).unwrap();
        assert_eq!(unchanged.label, None);
        // The last undo step is still the insertion: Original Size added none.
        assert_eq!(
            serde_json::to_value(service.view(id).unwrap()).unwrap()["undo_label"],
            json!("Add image")
        );

        service.set_image_size(id, &region_id, 150.0, 75.0).unwrap();
        assert_eq!(image(&service)["size"], json!([150.0, 75.0]));
        let restored = service.original_image_size(id, &region_id).unwrap();
        assert_eq!(restored.label.as_deref(), Some("Original size"));
        assert_eq!(image(&service)["size"], json!([300.0, 150.0]));
        // Position and resource do not change, and one undo brings the dragged size back.
        assert_eq!(image(&service)["x"], json!(54.0));
        assert_eq!(image(&service)["resource"], json!("img1"));
        service.undo(id).unwrap();
        assert_eq!(image(&service)["size"], json!([150.0, 75.0]));
        service.undo(id).unwrap();
        assert_eq!(image(&service)["size"], json!([300.0, 150.0]));

        // Not an image region and no such region are refused.
        assert_eq!(
            service.original_image_size(id, "nope").unwrap_err().kind,
            "image"
        );

        // Replace keeps the id, the page and the position, adopts the new picture's size, drops the
        // old resource and is one undo step.
        let replaced = service
            .replace_image(id, &region_id, &dir.join("small.png"))
            .unwrap();
        assert_eq!(replaced.removed_parts, 0);
        let region = image(&service);
        assert_eq!(region["x"], json!(54.0));
        assert_eq!(region["y"], json!(100.0));
        assert_eq!(region["page"], json!(1));
        // 80 x 40 px = 60 x 30 pt: the new picture's natural size, the aspect ratio kept.
        assert_eq!(region["size"], json!([60.0, 30.0]));
        assert_ne!(region["resource"], json!("img1"));
        assert!(service.image_data_url(id, "img1").is_err());
        service.undo(id).unwrap();
        let region = image(&service);
        assert_eq!(region["resource"], json!("img1"));
        assert_eq!(region["size"], json!([300.0, 150.0]));

        // An SVG replacement is sanitized like an inserted one, and its unsafe parts are counted.
        let with_svg = service
            .replace_image(id, &region_id, &dir.join("b.svg"))
            .unwrap();
        assert_eq!(with_svg.removed_parts, 1);
        let resource = image(&service)["resource"].as_str().unwrap().to_owned();
        let url = service.image_data_url(id, &resource).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"), "{url}");
        // 60 x 30 px = 45 x 22.5 pt.
        assert_eq!(image(&service)["size"], json!([45.0, 22.5]));

        // A file that is not an image leaves the region as it was.
        assert_eq!(
            service
                .replace_image(id, &region_id, &dir.join("c.txt"))
                .unwrap_err()
                .kind,
            "image"
        );
        assert_eq!(image(&service)["resource"], json!(resource));

        // The replaced picture survives a save and reopen, and the dropped one does not.
        let target = dir.join("replaced.eqv");
        service.save_worksheet_as(id, &target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(!text.contains("script"), "{text}");
        let reopened = service.open_worksheet(&target).unwrap();
        let view = serde_json::to_value(service.view(&reopened.id).unwrap()).unwrap();
        assert_eq!(view["regions"][0]["resource"], json!(resource));
        assert_eq!(view["regions"][0]["size"], json!([45.0, 22.5]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_line_inside_an_area_resizes_the_band_and_moves_the_content_in_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let area = service
            .add_region(id, "area", 1, 54.0, 100.0, None)
            .unwrap()
            .created
            .unwrap();
        service
            .add_region(id, "math", 1, 54.0, 130.0, Some("a := 1"))
            .unwrap();
        service
            .add_region(id, "math", 1, 54.0, 160.0, Some("b := 2"))
            .unwrap();
        let below = service
            .add_region(id, "math", 1, 54.0, 300.0, Some("c := 3"))
            .unwrap()
            .created
            .unwrap();
        let at = |service: &Service, region: &str| {
            let json = serde_json::to_value(full_view(service, id)).unwrap();
            let found = json["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["id"] == region)
                .unwrap()
                .clone();
            (found["y"].as_f64().unwrap(), found["height"].as_f64())
        };
        assert_eq!(at(&service, &area), (100.0, Some(120.0)));
        // A line at y 145: the member below it and the region under the band move down one line and
        // the band grows by the same amount, as one step.
        let moves = |first: f64, second: f64| {
            vec![
                RegionMove {
                    region_id: "r3".into(),
                    page: 1,
                    x: 54.0,
                    y: first,
                },
                RegionMove {
                    region_id: below.clone(),
                    page: 1,
                    x: 54.0,
                    y: second,
                },
            ]
        };
        let grown = service
            .move_regions(
                id,
                moves(175.0, 315.0),
                vec![AreaHeight {
                    region_id: area.clone(),
                    height: 135.0,
                }],
            )
            .unwrap();
        assert_eq!(grown.label.as_deref(), Some("Move regions"));
        assert_eq!(at(&service, &area).1, Some(135.0));
        assert_eq!(at(&service, "r3").0, 175.0);
        service.undo(id).unwrap();
        assert_eq!(at(&service, &area).1, Some(120.0));
        assert_eq!(at(&service, "r3").0, 160.0);
        assert_eq!(at(&service, &below).0, 300.0);
        // Removing the line shrinks the band again; the band is resized before the content moves up.
        service
            .move_regions(
                id,
                moves(145.0, 285.0),
                vec![AreaHeight {
                    region_id: area.clone(),
                    height: 105.0,
                }],
            )
            .unwrap();
        assert_eq!(at(&service, &area).1, Some(105.0));
        // A height for something that is not an area is refused and changes nothing.
        let refused = service
            .move_regions(
                id,
                Vec::new(),
                vec![AreaHeight {
                    region_id: "r3".into(),
                    height: 60.0,
                }],
            )
            .unwrap_err();
        assert_eq!(refused.kind, "area");
    }

    #[test]
    fn areas_are_added_collapsed_saved_and_reopened() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("area");
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        // A4, margins 72: the first area is 120 pt; the second is shortened to end where the third starts.
        let first = service
            .add_region(id, "area", 1, 54.0, 100.0, None)
            .unwrap();
        let area_id = first.created.clone().unwrap();
        let regions = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_eq!(regions["regions"][0]["kind"], "area");
        assert_eq!(regions["regions"][0]["height"], 120.0);
        assert_eq!(regions["regions"][0]["title"], "Area");
        service
            .add_region(id, "area", 1, 54.0, 400.0, Some("Late"))
            .unwrap();
        service
            .add_region(id, "area", 1, 54.0, 340.0, None)
            .unwrap();
        assert_eq!(
            serde_json::to_value(full_view(&service, id)).unwrap()["regions"][2]["height"],
            60.0
        );
        // Inside another area, or in the top margin's shadow of nothing: refused with a message.
        assert_eq!(
            service
                .add_region(id, "area", 1, 54.0, 130.0, None)
                .unwrap_err()
                .kind,
            "region"
        );
        service
            .add_region(id, "math", 1, 54.0, 150.0, Some("x := 1"))
            .unwrap();

        let collapsed = service
            .set_area(id, &area_id, "Inputs".into(), 120.0, true)
            .unwrap();
        assert_eq!(collapsed.label.as_deref(), Some("Collapse area"));
        assert!(service
            .set_area(id, &area_id, "Inputs".into(), 10.0, true)
            .is_err());
        assert!(service.set_area(id, "r4", "x".into(), 50.0, false).is_err());
        // Undo of the collapse restores the expanded flag; redo collapses again.
        service.undo(id).unwrap();
        assert_eq!(
            serde_json::to_value(full_view(&service, id)).unwrap()["regions"][0]["collapsed"],
            false
        );
        service.redo(id).unwrap();
        let target = dir.join("areas.eqv");
        service.save_worksheet_as(id, &target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(
            text.contains("title: Inputs") && text.contains("collapsed: true"),
            "{text}"
        );
        let reopened = service.open_worksheet(&target).unwrap();
        let view = serde_json::to_value(service.view(&reopened.id).unwrap()).unwrap();
        assert_eq!(view["regions"][0]["collapsed"], true);
        assert_eq!(view["regions"][0]["title"], "Inputs");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Restart REPL restarts the REPL's kernel with no worksheet open; a Julia that
    /// cannot start is the error of the command, and the kernel's status says so.
    #[test]
    fn restart_repl_needs_no_worksheet_and_reports_a_kernel_that_cannot_start() {
        let (broken, _events) = service(Some(PathBuf::from("no-such-julia")));
        let error = broken.repl_restart(None).unwrap_err();
        assert_eq!(error.kind, "kernel");
        if julia_available() {
            let (service, _events) = service(None);
            let temp = tempfile::tempdir().unwrap();
            service.set_environments_dir(temp.path().join("not-created-yet"));
            service.repl(None, "restart_marker = 1", false).unwrap();
            service.repl_restart(None).unwrap();
            // The new process has no state of the old one.
            let result = service
                .repl(None, "isdefined(Main, :restart_marker)", false)
                .unwrap();
            assert_eq!(result.value.as_deref(), Some("false"), "{result:?}");
        }
    }

    /// GitHub: the REPL of a worksheet that uses the shared environment
    /// runs although that folder does not exist yet. The kernel was
    /// given the missing folder and failed with "Internal error" (-32603).
    #[test]
    fn repl_runs_in_an_untitled_worksheet_without_a_shared_environment_folder() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, _events) = service(None);
        service.set_environments_dir(temp.path().join("not-created-yet"));
        let opened = service.new_worksheet().unwrap();
        assert!(!Path::new(&opened.environment.directory).exists());
        let result = service.repl(None, "1+1", false).unwrap();
        assert_eq!(result.value.as_deref(), Some("2"), "{result:?}");
        let result = service.repl(None, "x = 3; x^2", false).unwrap();
        assert_eq!(result.value.as_deref(), Some("9"), "{result:?}");
        let result = service.repl(None, "println(\"hi\")", false).unwrap();
        assert!(result.output.contains("hi"), "{result:?}");
        assert_eq!(result.error, None, "{result:?}");
        // a saved worksheet without the key runs in the generic environment, whose REPL
        // reaches it by its file name.
        let path = temp.path().join("saved beam.eqv");
        std::fs::write(&path, "format: equavela-worksheet/3\nregions:\n  - id: a\n    at: [0, 0]\n    math: \"a := 21\"\n").unwrap();
        let saved = service.open_worksheet(&path).unwrap();
        service.recalculate(&saved.id, true).unwrap();
        collect_until(&_events, "pass_finished");
        assert_eq!(
            service
                .worksheet_module_names()
                .get(&saved.id)
                .map(String::as_str),
            Some("saved_beam")
        );
        let result = service
            .repl(None, "2*Project.saved_beam.a_v1", false)
            .unwrap();
        assert_eq!(result.value.as_deref(), Some("42.0"), "{result:?}");
        service.shutdown();
    }

    /// GitHub : every open worksheet of a project is its own module of `Project`, also
    /// when two files of the project share a name (numbered in path order), on every platform.
    #[test]
    fn project_worksheets_are_modules_of_project() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Heat project");
        std::fs::create_dir_all(root.join("worksheets").join("other")).unwrap();
        let sheet = |math: &str| {
            format!(
                "format: equavela-worksheet/3
regions:
  - id: a
    at: [0, 0]
    math: \"{math}\"
"
            )
        };
        std::fs::write(root.join("worksheets/sizing.eqv"), sheet("a := 1")).unwrap();
        std::fs::write(root.join("worksheets/other/sizing.eqv"), sheet("a := 2")).unwrap();
        std::fs::write(root.join("worksheets/verification.eqv"), sheet("a := 3")).unwrap();
        std::fs::write(
            root.join("equavela-project.yaml"),
            "format: equavela-project/1
project_id: 52f9edb3-d0cc-4c3e-b4a0-2789c29547a5
name: Heat
worksheets:
  - id: 59eefdf2-9079-4331-8824-6f169660a031
    path: worksheets/sizing.eqv
  - id: 5f1510ed-2fa7-46bf-9508-1f28aaaf28e0
    path: worksheets/other/sizing.eqv
  - id: 6f1510ed-2fa7-46bf-9508-1f28aaaf28e1
    path: worksheets/verification.eqv
",
        )
        .unwrap();
        let (service, events) = service(None);
        service.set_environments_dir(temp.path().join("environments"));
        let mut opened = Vec::new();
        for file in [
            "worksheets/sizing.eqv",
            "worksheets/other/sizing.eqv",
            "worksheets/verification.eqv",
        ] {
            let sheet = service.open_worksheet(&root.join(file)).unwrap();
            service.recalculate(&sheet.id, true).unwrap();
            collect_until(&events, "pass_finished");
            opened.push((file, sheet.id));
        }
        let names = service.worksheet_module_names();
        let name_of = |file: &str| {
            let id = &opened.iter().find(|(f, _)| *f == file).unwrap().1;
            names[id].clone()
        };
        assert_eq!(name_of("worksheets/other/sizing.eqv"), "sizing");
        assert_eq!(name_of("worksheets/sizing.eqv"), "sizing2");
        assert_eq!(name_of("worksheets/verification.eqv"), "verification");
        let listed = service
            .repl(None, "join(sort(string.(filter(n -> getfield(Project, n) isa Module, names(Project; all=true)))), \",\")", false)
            .unwrap();
        assert_eq!(listed.error, None, "{listed:?}");
        assert!(
            listed
                .value
                .as_deref()
                .is_some_and(|v| v.contains("sizing,sizing2") && v.contains("verification")),
            "{listed:?}"
        );
        service.shutdown();
    }

    /// GitHub : the shared environment folder is created while a worksheet is open (a
    /// package is added). The kernel key was the path as given while the folder was missing and
    /// the canonical path (`\?\` on Windows) afterwards, so the REPL reached a second kernel
    /// that knew none of the worksheets.
    #[test]
    fn the_repl_keeps_the_kernel_of_the_worksheets_when_the_environment_folder_appears() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, events) = service(None);
        let environments = temp.path().join("environments");
        service.set_environments_dir(environments.clone());
        let path = temp.path().join("beam.eqv");
        std::fs::write(
            &path,
            "format: equavela-worksheet/3
regions:
  - id: a
    at: [0, 0]
    math: \"a := 21\"
",
        )
        .unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        service.recalculate(&opened.id, true).unwrap();
        collect_until(&events, "pass_finished");
        std::fs::create_dir_all(environments.join("DefaultEnv")).unwrap();
        std::fs::write(
            environments.join("DefaultEnv").join("Project.toml"),
            "[deps]
",
        )
        .unwrap();
        let result = service.repl(None, "2*Project.beam.a_v1", false).unwrap();
        assert_eq!(result.value.as_deref(), Some("42.0"), "{result:?}");
        service.shutdown();
    }

    /// the specification : Tab completes in the REPL module, so a name defined in the REPL and a
    /// LaTeX name complete, in an untitled worksheet.
    #[test]
    fn repl_completes_names_defined_in_the_repl() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let (service, _events) = service(None);
        service.set_environments_dir(temp.path().join("not-created-yet"));
        service.new_worksheet().unwrap();
        service.repl(None, "myreplvariable = 1", false).unwrap();
        let found = service.repl_complete(None, "myrepl", 6).unwrap();
        assert!(
            found.items.contains(&"myreplvariable".to_owned()),
            "{found:?}"
        );
        assert_eq!((found.from, found.to), (0, 6));
        let latex = service.repl_complete(None, "x = \\alpha", 10).unwrap();
        assert_eq!(latex.items, vec!["α".to_owned()], "{latex:?}");
        assert_eq!(latex.from, 4);
        service.shutdown();
    }

    #[test]
    fn new_worksheet_is_empty_and_editable() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        assert!(opened.view.regions.is_empty());
        assert_eq!(opened.view.page.size, "A4");
        service
            .add_region(&opened.id, "math", 1, 54.0, 72.0, Some("x := 1"))
            .unwrap();
        assert_eq!(full_results(&service, &opened.id).len(), 1);
    }

    #[test]
    fn inspect_lists_definitions_and_references_and_peeks_need_a_calculation() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        service
            .add_region(id, "math", 1, 54.0, 72.0, Some("a := 2"))
            .unwrap();
        service
            .add_region(id, "math", 1, 54.0, 96.0, Some("b := a + 1"))
            .unwrap();
        let inspection = serde_json::to_value(service.inspect(id).unwrap()).unwrap();
        assert_eq!(inspection["definitions"].as_array().unwrap().len(), 2);
        assert_eq!(inspection["definitions"][0]["name"], "a");
        assert_eq!(inspection["definitions"][1]["signature"], "b");
        let reference = &inspection["references"][0];
        assert_eq!(reference["name"], "a");
        assert_eq!(reference["definition"]["region_id"], "r1");
        // The reference span is the span of the identifier node in the region's AST (the UI
        // finds the DOM node by it).
        fn ident_span(node: &Value, name: &str) -> Option<Value> {
            match node {
                Value::Object(map) => {
                    if map.get("type") == Some(&json!("Ident"))
                        && map["name"]["segments"][0]["text"] == name
                    {
                        return Some(map["span"].clone());
                    }
                    map.values().find_map(|child| ident_span(child, name))
                }
                Value::Array(items) => items.iter().find_map(|child| ident_span(child, name)),
                _ => None,
            }
        }
        let view = serde_json::to_value(service.view(id).unwrap()).unwrap();
        let span = ident_span(&view["regions"][1]["statement"], "a").unwrap();
        assert_eq!(span["start"], reference["start"]);
        assert_eq!(span["end"], reference["end"]);
        let values = service
            .definition_values(
                id,
                vec![DefinitionRef {
                    name: "a".into(),
                    version: 1,
                }],
            )
            .unwrap();
        assert_eq!(values[0].error.as_deref(), Some("not calculated yet"));
    }

    #[test]
    fn inspect_warnings_lists_the_unit_warnings_of_the_inspection() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        service
            .add_region(id, "math", 1, 54.0, 72.0, Some("l := 2 m@unit"))
            .unwrap();
        service
            .add_region(id, "math", 1, 54.0, 96.0, Some("t := l + 1 s@unit"))
            .unwrap();
        let warnings = service.inspect_warnings(id).unwrap();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert_eq!(warnings, service.inspect(id).unwrap().warnings);
    }

    #[test]
    fn region_width_is_set_reset_and_undone() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let added = service
            .add_text_region(
                id,
                1,
                54.0,
                72.0,
                json!([{"runs": [{"kind": "text", "text": "Wide"}]}]),
                false,
            )
            .unwrap();
        let region = added.created.clone().unwrap();
        let width = |view: &DocumentView| {
            serde_json::to_value(view).unwrap()["regions"][0]["width"].clone()
        };
        // A new text box has no stored width: it grows with its text.
        assert_eq!(width(&full_view(&service, id)), json!(null));
        let resized = service.set_region_width(id, &region, Some(200.0)).unwrap();
        assert_eq!(resized.label.as_deref(), Some("Resize region"));
        assert_eq!(width(&full_view(&service, id)), json!(200.0));
        service.undo(id).unwrap();
        assert_eq!(width(&full_view(&service, id)), json!(null));
        service.redo(id).unwrap();
        assert_eq!(width(&full_view(&service, id)), json!(200.0));
        assert!(service.set_region_width(id, &region, Some(0.0)).is_err());
        let math = service
            .add_region(id, "math", 1, 54.0, 200.0, Some("x := 1"))
            .unwrap()
            .created
            .unwrap();
        assert!(service.set_region_width(id, &math, Some(100.0)).is_err());
    }

    #[test]
    fn text_regions_are_added_and_edited_from_the_editor_value_with_undo() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let statement =
            serde_json::to_value(equavela_core::parse_statement("a/b").unwrap()).unwrap();
        let added = service
            .add_text_region(
                id,
                1,
                54.0,
                72.0,
                json!([{"runs": [
                    {"kind": "text", "text": "Ratio "},
                    {"kind": "math", "text": "", "statement": statement},
                    {"kind": "text", "text": " is big", "bold": true, "size": 15.0}
                ]}]),
                false,
            )
            .unwrap();
        let region = added.created.clone().unwrap();
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_eq!(json["regions"][0]["kind"], "text");
        assert_eq!(
            json["regions"][0]["text"],
            "Ratio $a/b${size=15}** is big**{size}"
        );
        assert_eq!(
            json["regions"][0]["paragraphs"][0]["runs"][1]["kind"],
            "math"
        );
        assert_eq!(
            json["regions"][0]["paragraphs"][0]["runs"][1]["text"],
            "a/b"
        );
        assert!(json["regions"][0]["paragraphs"][0]["runs"][1]["statement"].is_object());

        let edited = service
            .set_text(
                id,
                &region,
                json!([{"runs": [{"kind": "text", "text": "Plain"}]}]),
            )
            .unwrap();
        assert_eq!(edited.label.as_deref(), Some("Edit text"));
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_eq!(json["regions"][0]["text"], "Plain");
        service.undo(id).unwrap();
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        assert_eq!(
            json["regions"][0]["text"],
            "Ratio $a/b${size=15}** is big**{size}"
        );
        assert_eq!(
            service
                .set_text(id, "nope", json!([{"runs": []}]))
                .unwrap_err()
                .kind,
            "region"
        );
        assert_eq!(
            service
                .set_text(id, &region, json!("bad"))
                .unwrap_err()
                .kind,
            "parse"
        );
    }

    #[test]
    fn clipboard_commands_print_parse_and_paste_regions_in_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        // math: AST to canonical text and back
        let ast = Service::parse_math("  a := (x + y)*z ").unwrap();
        assert_eq!(ast["type"], "Define");
        assert_eq!(Service::print_math(ast).unwrap(), "a := (x + y)·z");
        assert_eq!(Service::parse_math("a := := 1").unwrap_err().kind, "parse");
        // a run of call arguments: the same round trip
        let args = Service::parse_math_args("x + y, 2").unwrap();
        assert_eq!(args.as_array().unwrap().len(), 2);
        assert_eq!(args[0]["type"], "Expr");
        assert_eq!(Service::print_math_args(args).unwrap(), "x + y, 2");
        assert_eq!(Service::parse_math_args("a,").unwrap_err().kind, "parse");
        assert_eq!(
            Service::print_math_args(serde_json::json!([{ "type": "Expr" }]))
                .unwrap_err()
                .kind,
            "parse"
        );

        // regions: a snippet of the worksheet `regions:` list, ids replaced, group moved
        let snippet = [
            "- id: a",
            "  page: 1",
            "  at: [100, 200]",
            "  math: \"L := 3 m\"",
            "- id: b",
            "  page: 1",
            "  at: [150, 260]",
            "  text: \"Beam **load**\"",
            "- id: c",
            "  page: 2",
            "  at: [100, 50]",
            "  include: \"other.eqv\"",
            "",
        ]
        .join("\n");
        let pasted = service.paste_regions(id, 3, 30.0, 40.0, &snippet).unwrap();
        assert_eq!(pasted.label.as_deref(), Some("Paste"));
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        let regions = json["regions"].as_array().unwrap();
        assert_eq!(regions.len(), 3);
        assert_eq!(regions[0]["id"], "r1");
        assert_eq!(
            (
                regions[0]["page"].clone(),
                regions[0]["x"].clone(),
                regions[0]["y"].clone()
            ),
            (3.into(), 30.0.into(), 40.0.into())
        );
        assert_eq!(regions[0]["text"], "L := 3 m");
        assert_eq!(
            (regions[1]["x"].clone(), regions[1]["y"].clone()),
            (80.0.into(), 100.0.into())
        );
        assert_eq!(regions[1]["text"], "Beam **load**");
        assert_eq!(regions[2]["page"], 4);
        assert_eq!(pasted.created.as_deref(), Some("r3"));
        // one undo step removes all three
        service.undo(id).unwrap();
        assert!(full_view(&service, id).regions.is_empty());
        // text that is not a regions snippet is refused
        assert_eq!(
            service
                .paste_regions(id, 1, 0.0, 0.0, "just some words")
                .unwrap_err()
                .kind,
            "paste"
        );
    }

    #[test]
    fn a_pasted_plot_keeps_its_traces_and_axes() {
        let (service, _events) = service(None);
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        // The form the frontend copies (`regionsSnippet`): the plot mapping in JSON form.
        let snippet = [
            "- id: p",
            "  page: 1",
            "  at: [60, 80]",
            "  plot: {\"version\":1,\"type\":\"xy\",\"size\":[300,200],\"title\":\"T\",\"axes\":{\"x\":{},\"y\":{\"scale\":\"log10\"}},\"traces\":[{\"id\":\"t1\",\"x\":\"x\",\"y\":\"sin(x)\",\"presentation\":\"line\"}]}",
            "",
        ]
        .join("\n");
        let pasted = service.paste_regions(id, 2, 70.0, 90.0, &snippet).unwrap();
        assert_eq!(pasted.label.as_deref(), Some("Paste"));
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = &json["regions"][0];
        assert_eq!(region["kind"], "plot");
        assert_eq!(region["page"], 2);
        assert_eq!(region["plot"]["title"], "T");
        assert_eq!(region["plot"]["axes"]["y"]["scale"], "log10");
        assert_eq!(region["plot"]["traces"][0]["y"], "sin(x)");
        service.undo(id).unwrap();
        assert!(full_view(&service, id).regions.is_empty());
    }

    /// the editor gives a reopened `julia.` reference back as the name, or the call
    /// of the name, it is while typed; the commit reads it as the Julia reference again.
    #[test]
    fn a_julia_name_from_the_editor_commits_as_the_julia_reference() {
        let name = |text: &str| json!({"type": "Ident", "name": {"segments": [{"text": text, "subscript": false}], "label": null}});
        let bare = Service::statement_text(json!({"type": "ExprRegion", "expr": name("julia.x")}))
            .unwrap();
        assert_eq!(bare, "julia.x");
        let call = Service::statement_text(json!({
            "type": "ExprRegion",
            "expr": {"type": "Call", "callee": name("julia.X.f"), "args": [{"type": "Expr", "expr": name("a")}]}
        }))
        .unwrap();
        assert_eq!(call, "julia.X.f(a)");
        for (text, bare) in [(bare, true), (call, false)] {
            let parsed = equavela_core::syntax::parse_statement(&text).unwrap();
            let json = serde_json::to_value(&parsed).unwrap();
            assert_eq!(json["expr"]["type"], "JuliaCall", "{text}");
            assert_eq!(
                json["expr"]["bare"].as_bool().unwrap_or(false),
                bare,
                "{text}"
            );
        }
    }

    #[test]
    fn a_pasted_julia_region_keeps_its_block() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        // The form the frontend copies (`regionsSnippet`): JSON-quoted strings under `julia:`.
        let snippet = [
            "- id: j",
            "  page: 1",
            "  at: [60, 80]",
            "  julia:",
            "    size: [300, 120]",
            "    playing: false",
            "    using: [\"LinearAlgebra\"]",
            "    import:",
            "      \"area\": \"Geometry.area\"",
            "    define: [\"area\"]",
            "    code: \"function f(x)\\n  x + 1\\nend\"",
            "",
        ]
        .join("\n");
        let pasted = service.paste_regions(id, 2, 70.0, 90.0, &snippet).unwrap();
        assert_eq!(pasted.label.as_deref(), Some("Paste"));
        let json = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = &json["regions"][0];
        assert_eq!(region["kind"], "julia");
        assert_eq!(
            (
                region["page"].clone(),
                region["x"].clone(),
                region["y"].clone()
            ),
            (2.into(), 70.0.into(), 90.0.into())
        );
        let block = &region["block"];
        assert_eq!(block["playing"], false);
        assert_eq!(block["size"], serde_json::json!([300.0, 120.0]));
        assert_eq!(block["using"], serde_json::json!(["LinearAlgebra"]));
        assert_eq!(block["defines"], serde_json::json!(["area"]));
        assert_eq!(block["code"], "function f(x)\n  x + 1\nend");
        assert_eq!(block["imports"][0]["name"], "area");
        assert_eq!(block["imports"][0]["package"], "Geometry");
        service.undo(id).unwrap();
        assert!(full_view(&service, id).regions.is_empty());
    }

    #[test]
    fn a_pasted_image_carries_its_bytes_and_shares_one_resource() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        // A 1 x 1 PNG and a small SVG: the pictures themselves travel with the snippet.
        const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwUBAP3l4wAAAABJRU5ErkJggg==";
        const SVG: &str =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>";
        const OTHER_SVG: &str =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"><circle r=\"5\"/></svg>";
        // The snippet the frontend writes: the image item plus the resource it shows.
        let snippet = |resource: &str, media: &str, key: &str, data: &str| {
            [
                "- id: i1".to_owned(),
                "  page: 1".to_owned(),
                "  at: [100, 200]".to_owned(),
                "  image:".to_owned(),
                format!("    resource: {resource}"),
                "    size: [144, 108]".to_owned(),
                "resources:".to_owned(),
                format!("  {resource}:"),
                format!("    media: {media}"),
                format!("    {key}: {}", serde_json::to_string(data).unwrap()),
                String::new(),
            ]
            .join("\n")
        };
        let view = || serde_json::to_value(full_view(&service, id)).unwrap();
        let images = |view: &Value| -> Vec<String> {
            view["regions"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|region| region["kind"] == "image")
                .map(|region| region["resource"].as_str().unwrap().to_owned())
                .collect()
        };
        let pasted = service
            .paste_regions(id, 2, 30.0, 40.0, &snippet("img1", "png", "base64", PNG))
            .unwrap();
        assert_eq!(pasted.label.as_deref(), Some("Paste"));
        let first = view();
        let region = &first["regions"][0];
        assert_eq!(region["kind"], "image");
        assert_eq!(region["resource"], "img1");
        assert_eq!(region["size"], json!([144.0, 108.0]));
        assert_eq!(region["page"], 2);
        assert_eq!(
            (region["x"].clone(), region["y"].clone()),
            (30.0.into(), 40.0.into())
        );
        assert!(service
            .image_data_url(id, "img1")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        // Identical bytes are one resource: the second paste points at `img1` too
        // instead of storing the picture twice.
        service
            .paste_regions(id, 2, 30.0, 400.0, &snippet("img1", "png", "base64", PNG))
            .unwrap();
        assert_eq!(images(&view()), vec!["img1".to_owned(), "img1".to_owned()]);
        // An id this worksheet already uses for other bytes gets a fresh one.
        service
            .add_image(id, SVG.as_bytes(), 3, 72.0, 72.0)
            .unwrap();
        service
            .paste_regions(
                id,
                2,
                30.0,
                600.0,
                &snippet("img1", "svg", "text", OTHER_SVG),
            )
            .unwrap();
        assert_eq!(
            images(&view()),
            vec![
                "img1".to_owned(),
                "img1".to_owned(),
                "img2".to_owned(),
                "img3".to_owned()
            ]
        );
        // The resources are stored and dropped with the regions: one undo step.
        service.undo(id).unwrap();
        assert_eq!(
            images(&view()),
            vec!["img1".to_owned(), "img1".to_owned(), "img2".to_owned()]
        );
        assert_eq!(
            service.image_data_url(id, "img3").unwrap_err().kind,
            "region"
        );
        // A snippet whose image names a resource it does not carry is refused.
        let wrong = snippet("img9", "png", "base64", PNG).replace("  img9:", "  img8:");
        let refused = service.paste_regions(id, 1, 0.0, 0.0, &wrong).unwrap_err();
        assert_eq!(refused.kind, "paste");
        assert!(
            refused.message.contains("does not exist"),
            "{}",
            refused.message
        );
    }

    #[test]
    fn a_pasted_area_keeps_its_title_and_its_members() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let snippet = [
            "- id: a1",
            "  page: 1",
            "  at: [54, 100]",
            "  area:",
            "    title: \"Beam\"",
            "    height: 120",
            "- id: m1",
            "  page: 1",
            "  at: [72, 140]",
            "  math: \"L := 3 m\"",
            "",
        ]
        .join("\n");
        service.paste_regions(id, 2, 54.0, 300.0, &snippet).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let regions = view["regions"].as_array().unwrap();
        assert_eq!(regions.len(), 2);
        let left = view["page"]["margins"]["left"].as_f64().unwrap();
        // The area spans the printable width of the worksheet it lands in and keeps its
        // title and height.
        assert_eq!(regions[0]["kind"], "area");
        assert_eq!(regions[0]["title"], "Beam");
        assert_eq!(regions[0]["height"], 120.0);
        assert_eq!(regions[0]["x"], left);
        assert_eq!(
            (regions[0]["page"].clone(), regions[0]["y"].clone()),
            (2.into(), 300.0.into())
        );
        // The member keeps its offset, so it is inside the band again.
        assert_eq!(regions[1]["kind"], "math");
        assert_eq!(regions[1]["text"], "L := 3 m");
        assert_eq!(
            (regions[1]["page"].clone(), regions[1]["y"].clone()),
            (2.into(), 340.0.into())
        );
        assert_ne!(regions[0]["id"], "a1");
        // One undo step takes the area and its member away again.
        service.undo(id).unwrap();
        assert!(full_view(&service, id).regions.is_empty());
    }

    /// The browser mock (`app/src/mock`) shows what this command returns for the demo
    /// worksheet. Regenerate with `EQUAVELA_UPDATE_FIXTURE=1 cargo test -p equavela-app demo_fixture`.
    #[test]
    fn demo_fixture_matches_what_open_worksheet_returns() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        // The mock's shared environment (mockBackend.ts `environmentOf`), the same on every machine.
        service.set_environments_dir(PathBuf::from("/mock/environments"));
        let mock = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/mock");
        let opened = service.open_worksheet(&mock.join("demo.eqv")).unwrap();
        let root = opened.root.as_str().to_owned();
        let mut text = serde_json::to_string_pretty(&opened).unwrap();
        text = text.replace(&root, "/demo/demo.eqv");
        text = text.replace(
            &root.replace("demo.eqv", "libs/helpers.eqv"),
            "/demo/libs/helpers.eqv",
        );
        // On Windows the absolute mock path gains the drive letter (`D:/mock/environments`).
        while let Some(at) = text.find(":/mock/") {
            match text[..at].chars().last() {
                Some(drive) if drive.is_ascii_alphabetic() => {
                    text.replace_range(at - 1..at + 1, "")
                }
                _ => break,
            }
        }
        text.push('\n');
        let fixture = mock.join("demo.opened.json");
        if std::env::var_os("EQUAVELA_UPDATE_FIXTURE").is_some() {
            std::fs::write(&fixture, &text).unwrap();
        }
        let current = std::fs::read_to_string(&fixture).unwrap_or_default();
        assert_eq!(
            current.replace("\r\n", "\n"),
            text,
            "demo.opened.json is out of date: run with EQUAVELA_UPDATE_FIXTURE=1"
        );
    }

    /// Found driving the real app: Stop on a long loop. The pass must end with the loop region
    /// marked interrupted (an update event for it), and the results must say so.
    #[test]
    fn stop_interrupts_a_long_loop_and_reports_it() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let path = write_worksheet(
            "stop",
            "  - id: a
    at: [0, 0]
    math: \"a := 1\"
  - id: f
    at: [0, 20]
    math: |
      Long(n) := program
        s ← 0
        for i ∈ 1..n
          s ← s + i
        s
  - id: run
    at: [0, 100]
    math: \"Long(10000000000) =\"
  - id: after
    at: [0, 120]
    math: \"a + 1 =\"
",
        );
        let opened = service.open_worksheet(&path).unwrap();
        service.recalculate(&opened.id, false).unwrap();
        // Stop once the loop runs, not after a fixed time: with many kernels starting at once
        // (a parallel `cargo test`) five seconds were not always enough to reach it. The
        // short pause lets the kernel enter the loop the started event announces.
        wait_for_region_started(&events, "run");
        std::thread::sleep(Duration::from_millis(500));
        service.interrupt(&opened.id).unwrap();
        collect_until(&events, "pass_finished");
        let results = serde_json::to_value(service.results(&opened.id).unwrap()).unwrap();
        let run = results
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"]["region_id"] == "run")
            .unwrap();
        assert_eq!(run["state"], "error", "{run}");
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// `.eqv` worksheets open and include other `.eqv` files.
    #[test]
    fn worksheets_open_and_include_worksheet_files() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let path = write_worksheet(
            "eqv",
            "  - id: a
    at: [0, 0]
    math: \"a := 1\"
",
        );
        let dir = path.parent().unwrap().to_owned();
        std::fs::write(
            dir.join("lib.eqv"),
            "format: equavela-worksheet/3
regions:
  - id: k
    at: [0, 0]
    math: \"kk := 7\"
",
        )
        .unwrap();
        std::fs::write(
            dir.join("old.eqv"),
            "format: equavela-worksheet/3
regions:
  - id: k
    at: [0, 0]
    math: \"jj := 3\"
",
        )
        .unwrap();
        let root = dir.join("root.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3
regions:
  - id: i1
    at: [0, 0]
    include: lib.eqv
  - id: i2
    at: [0, 10]
    include: old.eqv
  - id: u
    at: [0, 20]
    math: \"kk + jj =\"
",
        )
        .unwrap();
        let opened = service.open_worksheet(&root).unwrap();
        service.recalculate(&opened.id, false).unwrap();
        collect_until(&events, "pass_finished");
        let results = serde_json::to_value(service.results(&opened.id).unwrap()).unwrap();
        let u = results
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"]["region_id"] == "u")
            .unwrap();
        assert_eq!(u["value"]["value"], 10.0, "{u}");
        service.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// a `.eqv` file from another program is refused with a clear message, and a
    /// `.eqv` file that includes one reports it instead of failing with a parse error.
    #[test]
    fn foreign_mm_files_are_not_worksheets() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir =
            std::env::temp_dir().join(format!("equavela-service-foreign-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let foreign = dir.join("map.eqv");
        std::fs::write(&foreign, "<map version=\"1.0.1\"><node TEXT=\"x\"/></map>").unwrap();
        let error = service.open_worksheet(&foreign).unwrap_err();
        assert!(
            error.message.contains("is not a worksheet"),
            "{}",
            error.message
        );
        // a file with another extension is refused too: only `.eqv` files are worksheets
        let other = dir.join("map.xml");
        std::fs::write(
            &other,
            "format: equavela-worksheet/3
regions: []
",
        )
        .unwrap();
        let error = service.open_worksheet(&other).unwrap_err();
        assert!(
            error.message.contains("is not a worksheet"),
            "{}",
            error.message
        );
        service.shutdown();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn result_format_override_is_a_region_property_in_the_view() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("fmt", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.as_str();
        let format = |view: &DocumentView| {
            serde_json::to_value(view).unwrap()["regions"][1]["format"].clone()
        };
        let map: BTreeMap<String, String> =
            [("format.type".to_owned(), "percent".to_owned())].into();
        let set = service.set_result_format(id, "b", Some(map)).unwrap();
        assert_eq!(set.label.as_deref(), Some("Result format"));
        assert_eq!(
            format(&full_view(&service, id)),
            json!({"format.type": "percent"})
        );
        service.undo(id).unwrap();
        assert_eq!(format(&full_view(&service, id)), json!(null));
        service.redo(id).unwrap();
        assert_eq!(
            format(&full_view(&service, id)),
            json!({"format.type": "percent"})
        );
        assert!(service.set_result_format(id, "nope", None).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The math font of the selected regions:
    /// one command gives several regions their display override, one undo step for the
    /// whole command, the labels `Math font` and `Reset math style`, and a region of another kind
    /// is refused by the core.
    #[test]
    fn the_math_font_is_one_undo_step_for_the_whole_selection() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("font", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.as_str();
        let format = |view: &DocumentView, index: usize| {
            serde_json::to_value(view).unwrap()["regions"][index]["format"].clone()
        };
        let font = |size: &str| -> Option<BTreeMap<String, String>> {
            Some(
                [
                    ("math-font.size".to_owned(), size.to_owned()),
                    ("math-font.color".to_owned(), "#c00000".to_owned()),
                ]
                .into(),
            )
        };
        let edits = vec![
            MathFontEdit {
                region_id: "a".into(),
                format: font("15"),
            },
            MathFontEdit {
                region_id: "show".into(),
                format: font("15"),
            },
        ];
        let set = service.set_math_font(id, edits, false).unwrap();
        assert_eq!(set.label.as_deref(), Some("Math font"));
        let view = full_view(&service, id);
        assert_eq!(
            format(&view, 0),
            json!({"math-font.size": "15", "math-font.color": "#c00000"})
        );
        assert_eq!(format(&view, 1), json!(null));
        assert_eq!(
            format(&view, 2),
            json!({"math-font.size": "15", "math-font.color": "#c00000"})
        );
        // One Ctrl+Z restores the font of both regions.
        service.undo(id).unwrap();
        let view = full_view(&service, id);
        assert_eq!(format(&view, 0), json!(null));
        assert_eq!(format(&view, 2), json!(null));
        service.redo(id).unwrap();
        assert_eq!(
            format(&full_view(&service, id), 2)["math-font.size"],
            json!("15")
        );
        // Reset removes the font keys, one undo step with its own label.
        let reset = vec![
            MathFontEdit {
                region_id: "a".into(),
                format: None,
            },
            MathFontEdit {
                region_id: "show".into(),
                format: None,
            },
        ];
        let cleared = service.set_math_font(id, reset, true).unwrap();
        assert_eq!(cleared.label.as_deref(), Some("Reset math style"));
        let view = full_view(&service, id);
        assert_eq!(format(&view, 0), json!(null));
        assert_eq!(format(&view, 2), json!(null));
        service.undo(id).unwrap();
        assert_eq!(
            format(&full_view(&service, id), 0)["math-font.size"],
            json!("15")
        );
        // A math-font command on a region that is not math fails as a whole.
        let wrong = vec![MathFontEdit {
            region_id: "nope".into(),
            format: font("9"),
        }];
        assert!(service.set_math_font(id, wrong, false).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The worksheet-wide result format: one undo step, only `format.*`
    /// keys, and the settings reach the frontend through the delta.
    #[test]
    fn worksheet_result_defaults_are_one_undo_step_of_display_settings() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("fmt-defaults", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.as_str();
        let settings = |url: &DocumentView| serde_json::to_value(&url.settings).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        let values: BTreeMap<String, Option<String>> = [
            ("format.type".to_owned(), Some("decimal".to_owned())),
            ("format.precision".to_owned(), Some("5".to_owned())),
        ]
        .into();
        let set = service.set_result_defaults(id, values).unwrap();
        assert_eq!(set.label.as_deref(), Some("Worksheet format"));
        assert_eq!(
            settings(&full_view(&service, id)),
            json!({"format.type": "decimal", "format.precision": "5"})
        );
        service.undo(id).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        service.redo(id).unwrap();
        assert_eq!(
            settings(&full_view(&service, id)),
            json!({"format.type": "decimal", "format.precision": "5"})
        );
        // Reset: the keys go away again, in one step.
        let reset: BTreeMap<String, Option<String>> = [
            ("format.type".to_owned(), None),
            ("format.precision".to_owned(), None),
        ]
        .into();
        service.set_result_defaults(id, reset).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        // A calculation setting would change results with no recalculation: refused.
        let tol: BTreeMap<String, Option<String>> =
            [("TOL".to_owned(), Some("0.5".to_owned()))].into();
        assert!(service.set_result_defaults(id, tol).is_err());
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The worksheet-wide label styles: one undo step per Apply or
    /// Reset, only `label-style.*` keys, and the settings reach the frontend through the delta.
    #[test]
    fn label_styles_are_one_undo_step_of_display_settings() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("label-styles", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.as_str();
        let settings = |url: &DocumentView| serde_json::to_value(&url.settings).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        let values: BTreeMap<String, Option<String>> = [
            (
                "label-style.var.color".to_owned(),
                Some("#c00000".to_owned()),
            ),
            (
                "label-style.var.italic".to_owned(),
                Some("false".to_owned()),
            ),
            ("label-style.kw.bold".to_owned(), Some("false".to_owned())),
        ]
        .into();
        let set = service.set_label_styles(id, values).unwrap();
        assert_eq!(set.label.as_deref(), Some("Label styles"));
        assert_eq!(
            settings(&full_view(&service, id)),
            json!({
                "label-style.var.color": "#c00000",
                "label-style.var.italic": "false",
                "label-style.kw.bold": "false",
            })
        );
        // One undo step restores every key of the Apply.
        service.undo(id).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        service.redo(id).unwrap();
        assert_eq!(
            settings(&full_view(&service, id))["label-style.var.color"],
            json!("#c00000")
        );
        // Reset of a style: its own keys go, the others stay.
        let reset: BTreeMap<String, Option<String>> = [
            ("label-style.var.color".to_owned(), None),
            ("label-style.var.italic".to_owned(), None),
        ]
        .into();
        let cleared = service.set_label_styles(id, reset).unwrap();
        assert_eq!(cleared.label.as_deref(), Some("Label styles"));
        let after = settings(&full_view(&service, id));
        assert_eq!(after["label-style.kw.bold"], json!("false"));
        assert!(after.get("label-style.var.color").is_none());
        // A key that is not a label style, or a label/property the model does not have, is refused.
        for key in [
            "format.type",
            "TOL",
            "label-style.var.strikeout",
            "label-style.user.bold",
        ] {
            let wrong: BTreeMap<String, Option<String>> =
                [(key.to_owned(), Some("1".to_owned()))].into();
            assert!(service.set_label_styles(id, wrong).is_err(), "{key}");
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// An edit during a calculation is applied at once: the pass does not hold the
    /// session, the edit stops it, and a calculation asked for meanwhile follows on the edit.
    #[test]
    fn an_edit_during_a_calculation_is_applied_and_the_queued_pass_uses_it() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let sheet = "  - id: f\n    at: [0, 0]\n    math: |-\n      Long(n) := program\n        s ← 0\n        for i ∈ 1..n\n          s ← s + i\n        s\n  - id: run\n    at: [0, 40]\n    math: \"Long(10000000000) =\"\n";
        let path = write_worksheet("edit-during-pass", sheet);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        service.recalculate(id, false).unwrap();
        wait_for_region_started(&events, "run");
        // The long loop is running: the edit is not refused, and it does not wait for it.
        let started = std::time::Instant::now();
        service
            .set_math(id, "run", Service::parse_math("Long(10) =").unwrap())
            .expect("an edit during a calculation is applied");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        // What the frontend does after an edit in automatic mode: queued, not refused.
        service
            .recalculate(id, false)
            .expect("queued behind the running pass");
        let deadline = std::time::Instant::now() + Duration::from_secs(240);
        loop {
            let results = serde_json::to_value(service.results(id).unwrap()).unwrap();
            let run = results
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["key"]["region_id"] == "run")
                .cloned()
                .unwrap();
            if run["state"] == "value" {
                assert_eq!(run["value"]["value"], 55.0);
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{run}");
            std::thread::sleep(Duration::from_millis(50));
        }
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn recalculate_streams_events_and_updates_results() {
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        let (service, events) = service(None);
        let path = write_worksheet("e2e", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let document = opened.root.as_str().to_owned();
        service.recalculate(&opened.id, false).unwrap();
        let seen = collect_until(&events, "pass_finished");
        let kinds: Vec<String> = seen
            .iter()
            .map(|(name, payload)| {
                if name == EVENT_KERNEL_STATUS {
                    format!("kernel:{}", payload["status"].as_str().unwrap())
                } else {
                    format!("equavela:{}", payload["event"].as_str().unwrap())
                }
            })
            .collect();
        assert!(kinds.contains(&"kernel:busy".to_owned()), "{kinds:?}");
        assert!(
            kinds.contains(&"equavela:region_updated".to_owned()),
            "{kinds:?}"
        );
        assert_eq!(kinds.last().unwrap(), "equavela:pass_finished");
        let results = serde_json::to_value(service.results(&opened.id).unwrap()).unwrap();
        assert_eq!(results[2]["state"], "value");
        assert_eq!(results[2]["value"]["value"], 3.0);
        assert!(matches!(
            service.kernel_status(),
            KernelStatus::Ready { .. }
        ));

        // Edit, recalculate again: only the dependents are sent.
        service
            .edit_region(&opened.id, &document, "a", "a := 10")
            .unwrap();
        service.recalculate(&opened.id, false).unwrap();
        let seen = collect_until(&events, "pass_finished");
        let started: Vec<_> = seen
            .iter()
            .filter(|(_, p)| p["event"] == "region_started")
            .map(|(_, p)| p["key"]["region_id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(started, ["a", "b", "show"]);
        let results = serde_json::to_value(service.results(&opened.id).unwrap()).unwrap();
        assert_eq!(results[2]["value"]["value"], 11.0);
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
    #[test]
    fn plot_data_is_a_binary_frame_that_follows_the_calculation() {
        let plot = "  - id: xs\n    at: [0, 0]\n    math: \"x := 0..3\"\n  - id: f\n    at: [0, 20]\n    math: \"f(t) := 2 * t\"\n  - id: p\n    at: [0, 40]\n    plot:\n      type: xy\n      traces:\n        - {id: t1, x: \"x\", y: \"f(x)\"}\n";
        let (service, events) = service(None);
        let path = write_worksheet("plot", plot);
        let opened = service.open_worksheet(&path).unwrap();
        let document = opened.root.as_str().to_owned();
        // The plot region is part of the view; its hidden evaluations are not results.
        assert_eq!(opened.regions.len(), 2);
        let view = serde_json::to_value(service.view(&opened.id).unwrap()).unwrap();
        assert_eq!(view["regions"][2]["kind"], "plot");
        let pending = PlotData::decode_frame(&service.plot_data(&opened.id, "p").unwrap()).unwrap();
        assert_eq!(pending.state, PlotDataState::Pending);
        assert!(service.plot_data(&opened.id, "xs").is_err());
        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            return;
        }
        service.recalculate(&opened.id, false).unwrap();
        let seen = collect_until(&events, "pass_finished");
        assert!(seen.iter().any(|(_, p)| p["event"] == "plot_updated"));
        let data = PlotData::decode_frame(&service.plot_data(&opened.id, "p").unwrap()).unwrap();
        assert_eq!(data.state, PlotDataState::Ready);
        assert_eq!(data.traces[0].y, [0.0, 2.0, 4.0, 6.0]);
        service
            .edit_region(&opened.id, &document, "f", "f(t) := 3 * t")
            .unwrap();
        let stale = PlotData::decode_frame(&service.plot_data(&opened.id, "p").unwrap()).unwrap();
        assert_eq!(stale.state, PlotDataState::Stale);
        service.recalculate(&opened.id, false).unwrap();
        collect_until(&events, "pass_finished");
        let data = PlotData::decode_frame(&service.plot_data(&opened.id, "p").unwrap()).unwrap();
        assert_eq!(data.traces[0].y, [0.0, 3.0, 6.0, 9.0]);
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
    #[test]
    fn a_plot_view_resamples_an_implicit_x_trace_and_is_never_saved() {
        // A trace whose x slot names an undefined variable: navigating the plot resamples
        // it over the visible interval.
        let regions = "  - id: p\n    at: [0, 0]\n    plot:\n      type: xy\n      traces: [{id: t1, x: \"t\", y: \"sin(t)\"}]\n";
        let (service, events) = service(None);
        let path = write_worksheet("plot-view", regions);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        // The stored form, without any view: what a save writes after a navigation must match it.
        service.save_worksheet(id).unwrap();
        let stored = std::fs::read_to_string(&path).unwrap();
        assert!(!stored.contains("view"));
        // The frame tells the frontend that a navigation has samples to move.
        let pending = PlotData::decode_frame(&service.plot_data(id, "p").unwrap()).unwrap();
        assert_eq!(pending.state, PlotDataState::Pending);
        assert!(pending.implicit_x);

        if !julia_available() {
            eprintln!("skipping: julia is not on PATH");
            service.shutdown();
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
            return;
        }
        // Nobody navigated the plot yet: the default interval.
        service.recalculate(id, false).unwrap();
        collect_until(&events, "pass_finished");
        let data = PlotData::decode_frame(&service.plot_data(id, "p").unwrap()).unwrap();
        assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
        assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
        assert_eq!(data.traces[0].x.last().copied(), Some(10.0));

        // Panning to -15..5 resamples the trace over that interval.
        assert!(service
            .set_plot_view(id, "p", Some(-15.0), Some(5.0))
            .unwrap());
        // The same range again changes nothing, so the frontend starts no calculation.
        assert!(!service
            .set_plot_view(id, "p", Some(-15.0), Some(5.0))
            .unwrap());
        // the view is not an undo step and not part of the file.
        assert!(!service.view(id).unwrap().can_undo);
        service.save_worksheet(id).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), stored);
        assert!(service.undo(id).unwrap().label.is_none());

        service.recalculate(id, false).unwrap();
        let seen = collect_until(&events, "pass_finished");
        // Only the plot's own expressions are calculated again: no visible region is sent.
        let started: Vec<String> = seen
            .iter()
            .filter(|(_, payload)| payload["event"] == "region_started")
            .map(|(_, payload)| payload["key"]["region_id"].as_str().unwrap().to_owned())
            .collect();
        assert!(
            started.iter().all(|region| region.starts_with("p")),
            "{started:?}"
        );
        let data = PlotData::decode_frame(&service.plot_data(id, "p").unwrap()).unwrap();
        assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
        assert_eq!(data.traces[0].x.len(), 501);
        assert_eq!(data.traces[0].x.first().copied(), Some(-15.0));
        assert_eq!(data.traces[0].x.last().copied(), Some(5.0));
        assert!((data.traces[0].y[0] - (-15.0_f64).sin()).abs() < 1e-12);

        // A half range is not an interval: it clears the view like reset-to-data-range does.
        service.set_plot_view(id, "p", Some(-3.0), None).unwrap();
        service.recalculate(id, false).unwrap();
        collect_until(&events, "pass_finished");
        let data = PlotData::decode_frame(&service.plot_data(id, "p").unwrap()).unwrap();
        assert_eq!(data.state, PlotDataState::Ready, "{:?}", data.error);
        assert_eq!(data.traces[0].x.first().copied(), Some(-10.0));
        assert_eq!(data.traces[0].x.last().copied(), Some(10.0));
        service.save_worksheet(id).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), stored);
        service.shutdown();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// Section 6: a file opens untrusted until this user trusts it, the answer is remembered
    /// per file, a worksheet made in the app is trusted and a trusted worksheet keeps its trust
    /// under a new name.
    #[test]
    fn worksheet_trust_is_remembered_per_user() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let config = std::env::temp_dir().join(format!("equavela-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&config);
        service.set_config_dir(config.clone());
        let path = write_worksheet("trust", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        assert!(!opened.view.trusted);
        let trusted = service.set_worksheet_trusted(&opened.id, true).unwrap();
        assert!(trusted.trusted);
        service.close_worksheet(&opened.id).unwrap();
        let again = service.open_worksheet(&path).unwrap();
        assert!(again.view.trusted, "the answer is remembered for the file");
        let list = std::fs::read_to_string(config.join("trusted-worksheets.json")).unwrap();
        assert!(list.contains("test.eqv"), "{list}");
        // Save As keeps the trust under the new name.
        let copy = path.with_file_name("copy.eqv");
        let saved = service.save_worksheet_as(&again.id, &copy).unwrap();
        assert!(saved.opened.unwrap().view.trusted);
        // Taking the trust back forgets the file.
        let reopened = service.open_worksheet(&path).unwrap();
        service.set_worksheet_trusted(&reopened.id, false).unwrap();
        service.close_worksheet(&reopened.id).unwrap();
        assert!(!service.open_worksheet(&path).unwrap().view.trusted);
        // A worksheet made in the app is trusted.
        assert!(service.new_worksheet().unwrap().view.trusted);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn julia_blocks_are_inserted_stopped_edited_and_played_through_the_service() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("julia-edit", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region(id, "julia", 1, 54.0, 300.0, None)
            .unwrap();
        let block_id = added.created.clone().unwrap();
        let block = |service: &Service| {
            let view = serde_json::to_value(full_view(service, id)).unwrap();
            view["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|region| region["id"] == block_id.as_str())
                .unwrap()["block"]
                .clone()
        };
        // a new block is empty and stopped.
        assert_eq!(block(&service)["playing"], false);
        assert_eq!(block(&service)["code"], Value::Null);
        // the header follows from the code lines.
        let edited = service
            .set_julia_code(
                id,
                &block_id,
                "using Statistics\nimport Statistics: mean\nx = 1\n",
            )
            .unwrap();
        assert_eq!(edited.label.as_deref(), Some("Edit Julia code"));
        assert_eq!(block(&service)["using"], json!(["Statistics"]));
        assert_eq!(block(&service)["imports"][0]["name"], "mean");
        // The final empty line typed after `x = 1` is kept.
        assert_eq!(
            block(&service)["code"],
            "using Statistics\nimport Statistics: mean\nx = 1\n"
        );
        // play, then one undo stops it again and a second one takes the code back.
        let played = service.set_julia_playing(id, &block_id, true).unwrap();
        assert_eq!(played.label.as_deref(), Some("Play Julia block"));
        assert_eq!(block(&service)["playing"], true);
        service.undo(id).unwrap();
        assert_eq!(block(&service)["playing"], false);
        service.undo(id).unwrap();
        assert_eq!(block(&service)["code"], Value::Null);
        // A region that is not a Julia block refuses both commands.
        assert!(service.set_julia_playing(id, "missing", true).is_err());
    }

    /// the box of a Julia block is one undo step of the service, it is what the
    /// frontend is told to draw, it survives Save and reopen, and a size that is not a size or a
    /// region that is not a block is refused.
    #[test]
    fn a_julia_block_is_resized_through_the_service_and_the_box_survives_a_reopen() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("julia-size", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region(id, "julia", 1, 54.0, 300.0, None)
            .unwrap();
        let block_id = added.created.clone().unwrap();
        let box_of = |service: &Service| {
            let view = serde_json::to_value(full_view(service, id)).unwrap();
            view["regions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|region| region["id"] == block_id.as_str())
                .unwrap()["block"]["size"]
                .clone()
        };
        // A new block has no stored box: it grows with its content.
        assert_eq!(box_of(&service), Value::Null);
        let resized = service
            .set_julia_size(id, &block_id, Some((300.0, 150.0)))
            .unwrap();
        assert_eq!(resized.label.as_deref(), Some("Resize Julia block"));
        assert_eq!(box_of(&service), json!([300.0, 150.0]));
        // The same size again is no undo step: one undo goes back to the growing box.
        service
            .set_julia_size(id, &block_id, Some((300.0, 150.0)))
            .unwrap();
        assert_eq!(box_of(&service), json!([300.0, 150.0]));
        service.undo(id).unwrap();
        assert_eq!(box_of(&service), Value::Null);
        service.redo(id).unwrap();
        assert_eq!(box_of(&service), json!([300.0, 150.0]));
        // A size that is not two positive finite numbers, and a region that is not a block.
        assert!(service
            .set_julia_size(id, &block_id, Some((0.0, 150.0)))
            .is_err());
        assert!(service
            .set_julia_size(id, &block_id, Some((300.0, -1.0)))
            .is_err());
        assert!(service
            .set_julia_size(id, "missing", Some((300.0, 150.0)))
            .is_err());
        assert_eq!(box_of(&service), json!([300.0, 150.0]));

        // Save and reopen: the box is in the file and comes back with the block.
        let target = path.with_file_name("julia-size-saved.eqv");
        service.save_worksheet_as(id, &target).unwrap();
        let saved = std::fs::read_to_string(&target).unwrap();
        assert!(saved.contains("      size: [300, 150]\n"), "{saved}");
        let reopened = service.open_worksheet(&target).unwrap();
        let view = serde_json::to_value(full_view(&service, &reopened.id)).unwrap();
        let block = view["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|region| region["id"] == block_id.as_str())
            .unwrap()["block"]
            .clone();
        assert_eq!(block["size"], json!([300.0, 150.0]));
        // And the box goes back to the growing one.
        service
            .set_julia_size(&reopened.id, &block_id, None)
            .unwrap();
        let view = serde_json::to_value(full_view(&service, &reopened.id)).unwrap();
        let block = view["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|region| region["id"] == block_id.as_str())
            .unwrap()["block"]
            .clone();
        assert_eq!(block["size"], Value::Null);
    }

    #[test]
    fn plots_are_added_edited_and_undone_through_the_service() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("plot-edit", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region(id, "plot", 1, 54.0, 100.0, None)
            .unwrap();
        let plot_id = added.created.clone().unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(region["kind"], "plot");
        assert_eq!(region["plot"]["size"], json!([360.0, 220.0]));
        assert_eq!(region["plot"]["traces"][0]["x"], "");
        // A plot with unfilled placeholders is pending, not an error.
        let frame = PlotData::decode_frame(&service.plot_data(id, &plot_id).unwrap()).unwrap();
        assert_eq!(frame.state, PlotDataState::Pending);

        let mut spec: equavela_core::plot::PlotSpec =
            serde_json::from_value(region["plot"].clone()).unwrap();
        spec.traces[0].x = "0..3".into();
        spec.traces[0].y = "b".into();
        spec.size = [420.0, 240.0];
        let edited = service.set_plot(id, &plot_id, spec.clone()).unwrap();
        assert_eq!(edited.label.as_deref(), Some("Edit plot"));
        let mut bad = spec.clone();
        bad.traces[0].y = "(".into();
        assert!(service.set_plot(id, &plot_id, bad).is_err());
        service.undo(id).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(region["plot"]["size"], json!([360.0, 220.0]));
        service.redo(id).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(region["plot"]["traces"][0]["y"], "b");

        // A trace type travels as `type`, and a line trace carries none, which is
        // the file default: the spec the frontend reads is the one it sends back.
        let mut stem: equavela_core::plot::PlotSpec =
            serde_json::from_value(region["plot"].clone()).unwrap();
        assert_eq!(stem.traces[0].kind, equavela_core::plot::TraceKind::Lines);
        stem.traces[0].kind = equavela_core::plot::TraceKind::Stems;
        service.set_plot(id, &plot_id, stem).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(region["plot"]["traces"][0]["type"], "stems");
        let round: equavela_core::plot::PlotSpec =
            serde_json::from_value(region["plot"].clone()).unwrap();
        assert_eq!(round.traces[0].kind, equavela_core::plot::TraceKind::Stems);

        // An axis limit that is an expression travels as its math text, so the
        // page draws the text it stores and the view the frontend reads is the spec it sends back.
        let mut with_limit: equavela_core::plot::PlotSpec =
            serde_json::from_value(region["plot"].clone()).unwrap();
        with_limit.axes.x.max = Some(equavela_core::plot::AxisLimit::Expression("3/2".into()));
        service.set_plot(id, &plot_id, with_limit).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(region["plot"]["axes"]["x"]["max"], "3/2");
        let round: equavela_core::plot::PlotSpec =
            serde_json::from_value(region["plot"].clone()).unwrap();
        assert_eq!(
            round.axes.x.max,
            Some(equavela_core::plot::AxisLimit::Expression("3/2".into()))
        );
        // A limit that does not parse is refused like any other invalid plot.
        let mut bad_limit = round;
        bad_limit.axes.y.min = Some(equavela_core::plot::AxisLimit::Expression("(".into()));
        assert!(service.set_plot(id, &plot_id, bad_limit).is_err());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_plot_can_be_added_with_a_valid_initial_size_in_one_undo_step() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("plot-initial-size", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_region_with_plot_size(id, "plot", 1, 54.0, 100.0, None, Some([240.0, 220.0]))
            .unwrap();
        let plot_id = added.created.clone().unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let region = view["regions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|region| region["id"] == plot_id)
            .unwrap();
        assert_eq!(region["plot"]["size"], json!([240.0, 220.0]));
        assert_eq!(added.label.as_deref(), Some("Add region"));

        service.undo(id).unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        assert!(view["regions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|region| region["id"] != plot_id));

        assert!(service
            .add_region_with_plot_size(id, "text", 1, 54.0, 100.0, None, Some([240.0, 220.0]))
            .is_err());
        assert!(service
            .add_region_with_plot_size(id, "plot", 1, 54.0, 100.0, None, Some([143.0, 220.0]))
            .is_err());
        assert!(service
            .add_region_with_plot_size(id, "plot", 1, 54.0, 100.0, None, Some([f64::NAN, 220.0]))
            .is_err());
    }
    #[test]
    fn a_text_block_is_full_width_and_cannot_be_resized() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("block", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = &opened.id;
        let added = service
            .add_text_region(
                id,
                1,
                99.0,
                150.0,
                json!([{"runs": [{"kind": "text", "text": "Block"}]}]),
                true,
            )
            .unwrap();
        let region = added.created.unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let block = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(block["full_width"], json!(true));
        // Inserted with the crosshair at x = 99: the block starts at the left margin (54).
        assert_eq!(block["x"], json!(54.0));
        assert_eq!(block["y"], json!(150.0));
        assert!(service.set_region_width(id, &region, Some(200.0)).is_err());
        // A drag moves it vertically only.
        service
            .move_regions(
                id,
                vec![RegionMove {
                    region_id: region.clone(),
                    page: 1,
                    x: 300.0,
                    y: 400.0,
                }],
                Vec::new(),
            )
            .unwrap();
        let view = serde_json::to_value(full_view(&service, id)).unwrap();
        let block = view["regions"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(
            (block["x"].clone(), block["y"].clone()),
            (json!(54.0), json!(400.0))
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("equavela-save-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Save writes the edited document to its own file, atomically, in the canonical format.
    #[test]
    fn save_writes_the_edited_worksheet_to_its_own_file() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("save", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        service
            .add_region(&opened.id, "math", 1, 54.0, 300.0, Some("c := a + b"))
            .unwrap();
        let saved = service.save_worksheet(&opened.id).unwrap();
        assert!(saved.opened.is_none());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with(
                "format: equavela-worksheet/3
page:
"
            ),
            "{text}"
        );
        assert!(text.contains("math: \"c := a + b\""), "{text}");
        let again = load_project(&path).unwrap();
        let root = again.project.document(&again.root).unwrap();
        assert_eq!(root.regions.len(), 4);
        // No temporary file is left behind.
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["test.eqv".to_owned()]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_worksheet_without_a_file_cannot_be_saved_but_can_be_saved_as_mm() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        assert!(service.is_untitled(&opened.id).unwrap());
        let error = service.save_worksheet(&opened.id).unwrap_err();
        assert_eq!(error.kind, "untitled");
        service
            .add_region(&opened.id, "math", 1, 54.0, 72.0, Some("x := 1"))
            .unwrap();
        let dir = temp_dir("untitled");
        // A name without extension gets `.eqv`.
        let saved = service
            .save_worksheet_as(&opened.id, &dir.join("first"))
            .unwrap();
        assert!(saved.path.ends_with("/first.eqv"), "{}", saved.path);
        assert!(dir.join("first.eqv").is_file());
        let reopened = saved.opened.unwrap();
        assert_eq!(reopened.regions.len(), 1);
        assert_ne!(reopened.id, opened.id);
        // The old session is closed, the new one is saved under its file.
        assert!(service.view(&opened.id).is_err());
        assert!(!service.is_untitled(&reopened.id).unwrap());
        service.save_worksheet(&reopened.id).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Save As in another directory keeps relative includes pointing at the same files.
    #[test]
    fn save_as_elsewhere_rewrites_relative_includes() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("rebase");
        std::fs::create_dir_all(dir.join("a/libs")).unwrap();
        std::fs::create_dir_all(dir.join("b/deep")).unwrap();
        std::fs::write(
            dir.join("a/libs/lib.eqv"),
            "format: equavela-worksheet/3
regions:
  - id: l
    math: \"kk := 7\"
",
        )
        .unwrap();
        let root = dir.join("a/root.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3
regions:
  - id: i
    page: 1
    at: [54, 72]
    include: libs/lib.eqv
",
        )
        .unwrap();
        let opened = service.open_worksheet(&root).unwrap();
        let saved = service
            .save_worksheet_as(&opened.id, &dir.join("b/deep/copy.eqv"))
            .unwrap();
        let text = std::fs::read_to_string(dir.join("b/deep/copy.eqv")).unwrap();
        assert!(text.contains("include: ../../a/libs/lib.eqv"), "{text}");
        // The copy loads with the include resolved, and the original file is untouched.
        let loaded = load_project(&dir.join("b/deep/copy.eqv")).unwrap();
        assert!(loaded.missing.is_empty(), "{:?}", loaded.missing);
        assert!(saved.opened.unwrap().diagnostics.is_empty());
        assert!(std::fs::read_to_string(&root)
            .unwrap()
            .contains("include: libs/lib.eqv"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// GitHub : the path of an include is edited in place; the typed text is stored with `/`
    /// separators, an absolute path below the folder becomes relative, the new target is read, an empty
    /// text is refused, and the change is one undo step.
    #[test]
    fn the_path_of_an_include_is_edited_in_place() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("include-edit");
        std::fs::create_dir_all(dir.join("libs")).unwrap();
        let lib = |name: &str, math: &str| {
            std::fs::write(
                dir.join(name),
                format!(
                    "format: equavela-worksheet/3\nregions:\n  - id: l\n    math: \"{math}\"\n"
                ),
            )
            .unwrap();
        };
        lib("old.eqv", "kk := 7");
        lib("libs/new.eqv", "mm := 9");
        let root = dir.join("root.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3\nregions:\n  - id: i\n    page: 1\n    at: [54, 72]\n    include: old.eqv\n",
        )
        .unwrap();
        let opened = service.open_worksheet(&root).unwrap();
        let path_of = |service: &Service| -> String {
            let view = service.view(&opened.id).unwrap();
            match &view.regions.iter().find(|r| r.id == "i").unwrap().content {
                equavela_core::session::ViewContent::Include { path } => path.clone(),
                other => panic!("{other:?}"),
            }
        };
        // Typed with a backslash (Windows habit): stored with `/`; the file exists, so nothing is missing.
        let edited = service
            .set_include_path(&opened.id, "i", "libs\\new.eqv")
            .unwrap();
        assert_eq!(path_of(&service), "libs/new.eqv");
        // The target is read and nothing changed in the diagnostics of the open worksheet: none are sent.
        assert!(edited.diagnostics.is_none(), "{:?}", edited.diagnostics);
        // An absolute path below the worksheet's folder is stored relative.
        let absolute = dir.join("old.eqv");
        service
            .set_include_path(&opened.id, "i", absolute.to_str().unwrap())
            .unwrap();
        assert_eq!(path_of(&service), "old.eqv");
        // A name that does not exist is the missing-include diagnostic, an empty text is refused.
        let gone = service
            .set_include_path(&opened.id, "i", "nope.eqv")
            .unwrap();
        // A name that does not exist: the missing-include diagnostic is sent with the edit, and cleared by the undo.
        let sent = gone.diagnostics.expect("the diagnostics changed");
        assert!(
            sent.iter()
                .any(|d| d.message.contains("was not found") && d.region_id == "i"),
            "{sent:?}"
        );
        assert!(service.set_include_path(&opened.id, "i", "   ").is_err());
        assert_eq!(path_of(&service), "nope.eqv");
        let undone = service.undo(&opened.id).unwrap();
        assert_eq!(path_of(&service), "old.eqv");
        assert_eq!(undone.diagnostics, Some(Vec::new()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relative_paths_between_directories() {
        assert_eq!(relative_path("/a/b", "/a/b/c.eqv").unwrap(), "c.eqv");
        assert_eq!(relative_path("/a/b", "/a/c/d.eqv").unwrap(), "../c/d.eqv");
        assert_eq!(relative_path("/a", "/x/y.eqv").unwrap(), "../x/y.eqv");
        assert_eq!(relative_path("C:/a", "C:/a/b/c.eqv").unwrap(), "b/c.eqv");
        assert_eq!(relative_path("C:/a", "D:/a/c.eqv"), None);
        assert_eq!(relative_path("", "/f.eqv").unwrap(), "f.eqv");
    }

    #[test]
    fn the_save_as_dialog_starts_at_a_mm_name() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("dialog", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let location = service.start_location(&opened.id, Some("ignored"));
        assert_eq!(location.file_name, "test.eqv");
        assert_eq!(location.directory.as_deref(), path.parent());
        let fresh = service.new_worksheet().unwrap();
        let location = service.start_location(&fresh.id, Some("Untitled-2"));
        assert_eq!(location.file_name, "Untitled-2.eqv");
        assert_eq!(location.directory, None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ---- autosave and recovery -------------------------------------

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The recovery file is written next to the file, holds the edited content, leaves the file
    /// alone, is offered when newer, restored as a modified worksheet and deleted by Save.
    #[test]
    fn a_recovery_file_is_written_offered_restored_and_deleted_by_save() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("recovery", SHEET);
        let before = std::fs::read_to_string(&path).unwrap();
        let opened = service.open_worksheet(&path).unwrap();
        assert!(service.recovery_for(&path).is_none());
        service
            .add_region(&opened.id, "math", 1, 54.0, 300.0, Some("c := a + b"))
            .unwrap();
        let written = service.write_recovery(&opened.id).unwrap().unwrap();
        assert!(written.ends_with("/.test.eqv.recovery"), "{written}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
        assert!(std::fs::read_to_string(&written)
            .unwrap()
            .contains("math: \"c := a + b\""));
        // No temporary file is left behind.
        assert_eq!(
            names_in(path.parent().unwrap()),
            vec![".test.eqv.recovery".to_owned(), "test.eqv".to_owned()]
        );
        // The recovery file is newer than the file: it is offered.
        let offered = service.recovery_for(&path).expect("newer recovery file");
        assert_eq!(offered.path, written);
        // Restore: the worksheet takes the name of the file and holds the recovered region.
        let restored = service
            .open_recovery(Path::new(&offered.path), Some(&path))
            .unwrap();
        assert_eq!(restored.view.regions.len(), 4);
        assert!(restored.root.as_str().ends_with("test.eqv"));
        assert!(!service.is_untitled(&restored.id).unwrap());
        // The recovery file keeps guarding it until Save.
        assert!(Path::new(&written).exists());
        service.save_worksheet(&restored.id).unwrap();
        assert!(!Path::new(&written).exists());
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .contains("math: \"c := a + b\""));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn closing_discarding_and_stale_recovery_files() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("recovery-close", SHEET);
        let recovery = path.with_file_name(".test.eqv.recovery");
        let opened = service.open_worksheet(&path).unwrap();
        service.write_recovery(&opened.id).unwrap();
        assert!(recovery.exists());
        // Closing (saved or discarded) deletes it.
        service.close_worksheet(&opened.id).unwrap();
        assert!(!recovery.exists());
        // A recovery file that is not newer than the file is stale and removed when looked at.
        std::fs::write(
            &recovery,
            "format: equavela-worksheet/3
",
        )
        .unwrap();
        std::fs::write(&path, std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(service.recovery_for(&path).is_none());
        assert!(!recovery.exists());
        // Discard removes only recovery files.
        std::fs::write(&recovery, "x").unwrap();
        assert!(service.discard_recovery_file(&path).is_err());
        service.discard_recovery_file(&recovery).unwrap();
        assert!(!recovery.exists());
        service.discard_recovery_file(&recovery).unwrap();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// An untitled worksheet has its recovery file in the app data directory; the next run lists it,
    /// restores it as a new untitled worksheet with its own backup, and the old file goes away.
    #[test]
    fn an_untitled_worksheet_is_recovered_in_the_app_data_directory() {
        let dir = temp_dir("untitled-recovery");
        let (first, _events) = service(Some(PathBuf::from("no-such-julia")));
        // No recovery directory: nothing is written.
        let probe = first.new_worksheet().unwrap();
        assert!(first.write_recovery(&probe.id).unwrap().is_none());
        first.set_recovery_dir(dir.join("recovery"));
        let opened = first.new_worksheet().unwrap();
        first
            .add_region(&opened.id, "math", 1, 54.0, 72.0, Some("x := 41"))
            .unwrap();
        let written = first.write_recovery(&opened.id).unwrap().unwrap();
        assert!(written.contains("Untitled-"), "{written}");
        // The process "crashes": a new run finds the file.
        let (second, _events) = service(Some(PathBuf::from("no-such-julia")));
        assert!(second.pending_recoveries().is_empty());
        second.set_recovery_dir(dir.join("recovery"));
        let pending = second.pending_recoveries();
        assert_eq!(pending, vec![written.clone()]);
        let restored = second.open_recovery(Path::new(&pending[0]), None).unwrap();
        assert!(second.is_untitled(&restored.id).unwrap());
        assert_eq!(restored.view.regions.len(), 1);
        // The old file is replaced by the new session's own.
        let now = second.pending_recoveries();
        assert_eq!(now.len(), 1);
        assert_ne!(now[0], written);
        assert!(!Path::new(&written).exists());
        // Closing it removes the last backup.
        second.close_worksheet(&restored.id).unwrap();
        assert!(second.pending_recoveries().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Save As deletes the backup of the old name and one left next to the new name.
    #[test]
    fn save_as_deletes_the_old_and_the_new_names_backups() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let dir = temp_dir("recovery-save-as");
        service.set_recovery_dir(dir.join("recovery"));
        let opened = service.new_worksheet().unwrap();
        service
            .add_region(&opened.id, "math", 1, 54.0, 72.0, Some("x := 1"))
            .unwrap();
        service.write_recovery(&opened.id).unwrap();
        assert_eq!(service.pending_recoveries().len(), 1);
        let target = dir.join("named.eqv");
        let stale = dir.join(".named.eqv.recovery");
        std::fs::write(&stale, "old").unwrap();
        service.save_worksheet_as(&opened.id, &target).unwrap();
        assert!(service.pending_recoveries().is_empty());
        assert!(!stale.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Disable Region: selected regions stop
    /// being calculated, one undo step for the whole selection, and the flag is saved.
    #[test]
    fn disabling_regions_is_one_undo_step_and_is_saved() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("disabled", SHEET);
        let dir = path.parent().unwrap().to_path_buf();
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.clone();

        let disabled = service
            .set_regions_enabled(&id, vec!["a".into(), "b".into()], false)
            .unwrap();
        assert_eq!(disabled.label.as_deref(), Some("Disable region"));
        let view = full_view(&service, &id);
        assert!(view.regions.iter().take(2).all(|region| !region.enabled));
        assert!(view.regions[2].enabled);
        // A disabled region has no result entry of its own and does not define `a`.
        let results = full_results(&service, &id);
        let entries: Vec<&str> = results
            .iter()
            .map(|entry| entry.key.region_id.as_str())
            .collect();
        assert_eq!(entries, ["show"]);

        // One Ctrl+Z brings both regions back; one Ctrl+Y disables them again.
        service.undo(&id).unwrap();
        assert!(full_view(&service, &id)
            .regions
            .iter()
            .take(2)
            .all(|region| region.enabled));
        service.redo(&id).unwrap();
        assert!(full_view(&service, &id)
            .regions
            .iter()
            .take(2)
            .all(|region| !region.enabled));
        let enabled = service
            .set_regions_enabled(&id, vec!["a".into(), "b".into()], true)
            .unwrap();
        assert_eq!(enabled.label.as_deref(), Some("Enable region"));
        assert!(full_view(&service, &id)
            .regions
            .iter()
            .take(2)
            .all(|region| region.enabled));
        assert!(service
            .set_regions_enabled(&id, vec!["nope".into()], false)
            .is_err());
        // The flag is part of the file: `enabled: false` is written for the disabled region only.
        service
            .set_regions_enabled(&id, vec!["a".into()], false)
            .unwrap();
        let target = dir.join("disabled.eqv");
        service.save_worksheet_as(&id, &target).unwrap();
        let text = std::fs::read_to_string(&target).unwrap();
        assert_eq!(text.matches("enabled: false").count(), 1, "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_page_setup_is_one_undo_step_that_takes_the_margins_into_account() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let opened = service.new_worksheet().unwrap();
        let id = &opened.id;
        let page = |view: &DocumentView| view.page.clone();
        assert_eq!(page(&full_view(&service, id)), PageSetup::default());
        // A margin wider than the place the new region of `new_worksheet` takes.
        let mut setup = PageSetup::named("Letter", true).unwrap();
        setup.margins = equavela_core::layout::Margins {
            top: 100.0,
            right: 40.0,
            bottom: 50.0,
            left: 80.0,
        };
        let edited = service.set_page_setup(id, setup.clone()).unwrap();
        assert_eq!(edited.label.as_deref(), Some("Page setup"));
        // The delta the UI applies carries the new setup (page and margins) and the moved regions.
        assert_eq!(edited.page.as_ref(), Some(&setup));
        assert!(edited
            .regions
            .iter()
            .all(|region| region.x >= 80.0 && region.y >= 100.0));
        let view = full_view(&service, id);
        assert_eq!(view.page, setup);
        assert!(view
            .regions
            .iter()
            .all(|region| region.x >= 80.0 && region.y >= 100.0));
        service.undo(id).unwrap();
        assert_eq!(page(&full_view(&service, id)), PageSetup::default());
        service.redo(id).unwrap();
        assert_eq!(page(&full_view(&service, id)), setup);
        let mut bad = setup;
        bad.margins.left = 800.0;
        assert!(service.set_page_setup(id, bad).is_err());
        assert_eq!(page(&full_view(&service, id)).size, "Letter");
    }

    /// Find and Replace in math mode inserts the replacement's tree as it
    /// is and relies on printing to add the parentheses its new place needs, then parses again.
    #[test]
    fn print_math_adds_the_parentheses_a_substituted_subtree_needs() {
        let mut statement = Service::parse_math("y := 2·x").unwrap();
        statement["rhs"]["right"] = Service::parse_math("a + b").unwrap()["expr"].clone();
        let text = Service::print_math(statement).unwrap();
        assert_eq!(text, "y := 2·(a + b)");
        assert!(Service::parse_math(&text).is_ok());
    }

    /// The calculation settings: one undo step of the two
    /// tolerances, and unlike the result-format defaults every region becomes out of date
    /// so the frontend recalculates (`calc_needed`).
    #[test]
    fn calculation_settings_are_one_undo_step_and_ask_for_a_recalculation() {
        let (service, _events) = service(Some(PathBuf::from("no-such-julia")));
        let path = write_worksheet("calc-settings", SHEET);
        let opened = service.open_worksheet(&path).unwrap();
        let id = opened.id.as_str();
        let settings = |url: &DocumentView| serde_json::to_value(&url.settings).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        let values: BTreeMap<String, Option<String>> = [
            ("TOL".to_owned(), Some("0.25".to_owned())),
            ("CTOL".to_owned(), Some("0.5".to_owned())),
        ]
        .into();
        let set = service.set_calculation_settings(id, values).unwrap();
        assert_eq!(set.label.as_deref(), Some("Calculation settings"));
        // The delta carries the new settings and says a calculation is due: a
        // calculation setting is never display only.
        assert_eq!(
            settings(&full_view(&service, id)),
            json!({"TOL": "0.25", "CTOL": "0.5"})
        );
        assert!(set.calc_needed);
        // Undo restores the previous tolerances and is one step.
        service.undo(id).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        service.redo(id).unwrap();
        assert_eq!(
            settings(&full_view(&service, id)),
            json!({"TOL": "0.25", "CTOL": "0.5"})
        );
        // Reset: the keys go away again, in one step.
        let reset: BTreeMap<String, Option<String>> =
            [("TOL".to_owned(), None), ("CTOL".to_owned(), None)].into();
        service.set_calculation_settings(id, reset).unwrap();
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        // A display setting belongs to the other command: refused here.
        let wrong: BTreeMap<String, Option<String>> =
            [("format.type".to_owned(), Some("decimal".to_owned()))].into();
        assert!(service.set_calculation_settings(id, wrong).is_err());
        assert_eq!(settings(&full_view(&service, id)), json!({}));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn copying_environment_selects_copy_and_undo_redo_preserves_files() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let worksheet_dir = temp.path().join("worksheet");
        let source = worksheet_dir.join("env");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("Project.toml"),
            "[deps]\nFoo = \"d3a1c7e0-5b0a-4c53-9a8e-0f7f2f4a9b14\"\n",
        )
        .unwrap();
        let root = worksheet_dir.join("calc.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3\nenvironment: env\nregions: []\n",
        )
        .unwrap();
        let id = service.open_worksheet(&root).unwrap().id;
        let source = source.canonicalize().unwrap();
        assert!(same_dir(
            &service.environment_info(&id).unwrap().summary.kernel,
            &source
        ));

        let destination = temp.path().join("copied-env");
        let copied = service
            .copy_worksheet_environment(&id, &destination)
            .unwrap();
        assert_eq!(copied.label.as_deref(), Some("Copy environment"));
        assert!(same_dir(&copied.environment.unwrap().kernel, &destination));
        assert_eq!(
            std::fs::read(destination.join("Project.toml")).unwrap(),
            std::fs::read(source.join("Project.toml")).unwrap()
        );

        let undone = service.undo(&id).unwrap();
        assert!(same_dir(&undone.environment.unwrap().kernel, &source));
        assert!(destination.join("Project.toml").is_file());
        let redone = service.redo(&id).unwrap();
        assert!(same_dir(&redone.environment.unwrap().kernel, &destination));
        assert!(destination.join("Project.toml").is_file());
        service.shutdown();
    }

    #[test]
    fn copying_environment_refuses_existing_destination_without_changing_it() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let source = temp.path().join("env");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("Project.toml"), "[deps]\n").unwrap();
        let root = temp.path().join("calc.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3\nenvironment: env\nregions: []\n",
        )
        .unwrap();
        let id = service.open_worksheet(&root).unwrap().id;
        let destination = temp.path().join("already-there");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("keep.txt"), "untouched").unwrap();
        let error = service
            .copy_worksheet_environment(&id, &destination)
            .unwrap_err();
        assert_eq!(error.kind, "environment");
        assert_eq!(
            std::fs::read_to_string(destination.join("keep.txt")).unwrap(),
            "untouched"
        );
        assert!(!destination.join("Project.toml").exists());
        assert_eq!(
            service.environment_info(&id).unwrap().summary.kernel,
            slash_path(&source.canonicalize().unwrap())
        );
        service.shutdown();
    }

    #[test]
    fn copying_environment_refuses_untitled_project_and_path_dependencies_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let (service, _) = service(Some(PathBuf::from("/nonexistent-julia")));
        let untitled = service.new_worksheet().unwrap();
        let untitled_destination = temp.path().join("untitled-copy");
        assert_eq!(
            service
                .copy_worksheet_environment(&untitled.id, &untitled_destination)
                .unwrap_err()
                .kind,
            "environment"
        );
        assert!(!untitled_destination.exists());

        let project_destination = temp.path().join("project");
        let project = service
            .new_project(
                &project_destination,
                "Example",
                "11111111-1111-4111-8111-111111111111",
                "22222222-2222-4222-8222-222222222222",
            )
            .unwrap();
        let project_sheet = first_sheet(&service, &project);
        let project_copy = temp.path().join("project-copy");
        assert_eq!(
            service
                .copy_worksheet_environment(&project_sheet.id, &project_copy)
                .unwrap_err()
                .kind,
            "environment"
        );
        assert!(!project_copy.exists());

        let worksheet_dir = temp.path().join("standalone");
        let source = worksheet_dir.join("env");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("Project.toml"),
            "[deps]\n\n[sources]\nFoo = { path = \"../Foo\" }\n",
        )
        .unwrap();
        let root = worksheet_dir.join("calc.eqv");
        std::fs::write(
            &root,
            "format: equavela-worksheet/3\nenvironment: env\nregions: []\n",
        )
        .unwrap();
        let id = service.open_worksheet(&root).unwrap().id;
        let before = service.environment_info(&id).unwrap().summary.kernel;
        let destination = temp.path().join("invalid-dependency-copy");
        let error = service
            .copy_worksheet_environment(&id, &destination)
            .unwrap_err();
        assert_eq!(error.kind, "environment");
        assert!(
            error.message.contains("local path dependency"),
            "{}",
            error.message
        );
        assert!(!destination.exists());
        assert_eq!(
            service.environment_info(&id).unwrap().summary.kernel,
            before
        );
        service.shutdown();
    }
}
