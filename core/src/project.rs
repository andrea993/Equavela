//! Multi-document worksheet analysis and include expansion.
//!
//! Includes are expanded as definitions at their position, matching the reference application's "as if
//! pasted" semantics. The expanded math is then passed to [`crate::graph`], so ordinary
//! redefinition, lexical function capture and contextual labels have exactly the same
//! behaviour within and across files.

use crate::area::AreaRegion;
use crate::ast::{Label, Name, Segment, Statement, StatementKind, Target, TargetKind};
use crate::dimensions::{analyze_dimensions_with, DimensionWarningKind};
use crate::fasthash::{HashMap, HashSet};
use crate::graph::{DependencyGraph, GraphError, Region, Worksheet};
use crate::image::{ImageRegion, Resources};
use crate::layout::{MathBreak, PageBreak, PageSetup, TextRegion};
use crate::plot::{PlotRegion, PlotScope};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(String);

impl DocumentId {
    pub fn new(path: &str) -> Result<DocumentId, PathError> {
        Ok(DocumentId(normalize_path(path)?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Resolves an include path lexically against this document's directory.
    pub fn resolve(&self, include_path: &str) -> Result<DocumentId, PathError> {
        let include_path = include_path.replace('\\', "/");
        if is_absolute(&include_path) {
            return DocumentId::new(&include_path);
        }
        let parent = self.0.rsplit_once('/').map_or("", |(parent, _)| parent);
        let joined = if parent.is_empty() {
            include_path
        } else {
            format!("{parent}/{include_path}")
        };
        DocumentId::new(&joined)
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum PathError {
    #[error("document path is empty")]
    Empty,
    #[error("document path contains a NUL character")]
    Nul,
}

/// Strips a Windows verbatim prefix (`\\?\` or `\\?\UNC\`, and their `/`-normalized forms)
/// so canonical paths use ordinary drive or UNC spelling.
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        if rest
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(r"UNC\"))
        {
            return format!(r"\\{}", &rest[4..]);
        }
        if rest.len() >= 3 && rest.as_bytes()[1..3] == *b":\\" {
            return rest.to_owned();
        }
    } else if let Some(rest) = path.strip_prefix("//?/") {
        if rest
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("UNC/"))
        {
            return format!("//{}", &rest[4..]);
        }
        if rest.len() >= 3 && rest.as_bytes()[1..3] == *b":/" {
            return rest.to_owned();
        }
    }
    path.to_owned()
}

fn normalize_path(path: &str) -> Result<String, PathError> {
    if path.is_empty() {
        return Err(PathError::Empty);
    }
    if path.contains('\0') {
        return Err(PathError::Nul);
    }
    // Windows canonicalize() returns verbatim paths. Document IDs use ordinary
    // drive/UNC spelling so typed and canonical paths identify the same document.
    let path = strip_verbatim_prefix(&path.replace('\\', "/"));
    let unc_root = path.strip_prefix("//").and_then(|network| {
        let mut parts = network.splitn(3, '/');
        let server = parts.next()?;
        let share = parts.next()?;
        if server.is_empty() || share.is_empty() {
            return None;
        }
        Some((format!("//{server}/{share}"), parts.next().unwrap_or("")))
    });
    let (prefix, rest, absolute) = if let Some((root, rest)) = unc_root {
        // Parent traversal must never remove the server or share name.
        (root, rest, true)
    } else if path.starts_with('/') {
        ("/".to_owned(), path.trim_start_matches('/'), true)
    } else if path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/' {
        (path[..2].to_owned(), &path[3..], true)
    } else {
        (String::new(), path.as_str(), false)
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if absolute => {}
            ".." => parts.push(".."),
            _ => parts.push(part),
        }
    }
    let body = parts.join("/");
    let normalized = if prefix == "/" {
        format!("/{body}")
    } else if !prefix.is_empty() {
        if body.is_empty() {
            format!("{prefix}/")
        } else {
            format!("{prefix}/{body}")
        }
    } else if body.is_empty() {
        ".".to_owned()
    } else {
        body
    };
    Ok(normalized)
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/')
        || (path.len() >= 3 && path.as_bytes()[1] == b':' && path.as_bytes()[2] == b'/')
}

/// Extensible, deterministic calculation settings used in include cache keys.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct CalculationSettings {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectDocument {
    pub id: DocumentId,
    /// Hash of the source file bytes, supplied by the persistence layer.
    pub content_hash: String,
    #[serde(default)]
    pub settings: CalculationSettings,
    /// The Julia environment directory declared by the document (`environment:` in the
    /// YAML, relative to the document), if any.
    #[serde(default)]
    pub environment: Option<String>,
    /// Page size and margins.
    #[serde(default)]
    pub page: PageSetup,
    /// Result-format overrides by math region id: keys of the `format.*` display settings
    /// (`format.type`, `format.precision`, ...). A region property, not part of the math.
    #[serde(default)]
    pub result_formats: BTreeMap<String, BTreeMap<String, String>>,
    /// Numeric method choices by math region id: the solver algorithm and options of a solving
    /// region, the derivative method of a region with derivatives (`algorithm`, `derivatives`,
    /// ...). A region property that affects values.
    #[serde(default)]
    pub numeric_options: BTreeMap<String, BTreeMap<String, String>>,
    /// The regions of the document, each one shared: cloning a document (an edit does it on
    /// every command) copies the pointers, and an edit replaces only the regions it changes
    ///. The worksheet file is written and read region by region, so the format is the
    /// same.
    pub regions: Vec<Arc<DocumentRegion>>,
    /// Presentation-only line breaks by math region id: never read by the
    /// analysis, the dependency graph or the generated code.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub math_breaks: BTreeMap<String, Vec<MathBreak>>,
    /// Image bytes by resource id.
    #[serde(default)]
    pub resources: Resources,
    /// Images stored as project files, by resource id. An id is in `resources` or
    /// here, never both.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub assets: crate::image::Assets,
    /// Manual page breaks: the pages that end on purpose and where. Sorted
    /// by page, at most one per page; the regions carry the layout the break applied.
    #[serde(default)]
    pub page_breaks: Vec<PageBreak>,
}

impl ProjectDocument {
    /// Whether an image resource id names embedded bytes or a project asset.
    pub fn has_resource(&self, id: &str) -> bool {
        self.resources.contains_key(id) || self.assets.contains_key(id)
    }

    /// The media of an image resource, embedded or project asset.
    pub fn image_media(&self, id: &str) -> Option<crate::image::ImageMedia> {
        self.resources
            .get(id)
            .map(|resource| resource.media)
            .or_else(|| self.assets.get(id).map(|asset| asset.media))
    }

    /// Puts every full-width text block (Ctrl+Shift+T) at the left margin. A block spans the
    /// printable width, so only its y is free; call this after anything that can change a
    /// block's x or the margins (a load, an edit, a page setup change).
    pub fn snap_text_blocks(&mut self) {
        let left = self.page.margins.left;
        for region in &mut self.regions {
            // Only a region that really moves is copied out of its `Arc`: snapping runs after
            // every edit, and copying every block and area would undo the sharing.
            let snapped = match region.as_ref() {
                DocumentRegion::Text(text) => text.full_width && text.x != left,
                // An area spans the printable width, so it also starts at the left margin.
                DocumentRegion::Area(area) => area.x != left,
                _ => false,
            };
            if !snapped {
                continue;
            }
            match Arc::make_mut(region) {
                DocumentRegion::Text(text) => text.x = left,
                DocumentRegion::Area(area) => area.x = left,
                _ => {}
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum DocumentRegion {
    Math(Box<Region>),
    Include(IncludeRegion),
    /// A text region: displayed, never calculated.
    Text(TextRegion),
    /// A renderer-independent plot specification; calculated data is session state.
    Plot(Box<PlotRegion>),
    /// An SVG, PNG or JPEG image; the bytes are in the document resources.
    Image(ImageRegion),
    /// A collapsible area: a titled band that groups the regions inside it.
    Area(AreaRegion),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncludeRegion {
    pub id: String,
    #[serde(default)]
    pub page: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub path: String,
}

pub(crate) fn enabled_by_default() -> bool {
    true
}

impl DocumentRegion {
    pub fn id(&self) -> &str {
        match self {
            DocumentRegion::Math(region) => &region.id,
            DocumentRegion::Include(region) => &region.id,
            DocumentRegion::Text(region) => &region.id,
            DocumentRegion::Plot(region) => &region.id,
            DocumentRegion::Image(region) => &region.id,
            DocumentRegion::Area(region) => &region.id,
        }
    }

    pub fn page(&self) -> u32 {
        match self {
            DocumentRegion::Math(region) => region.page,
            DocumentRegion::Include(region) => region.page,
            DocumentRegion::Text(region) => region.page,
            DocumentRegion::Plot(region) => region.page,
            DocumentRegion::Image(region) => region.page,
            DocumentRegion::Area(region) => region.page,
        }
    }

    pub fn x(&self) -> f64 {
        match self {
            DocumentRegion::Math(region) => region.x,
            DocumentRegion::Include(region) => region.x,
            DocumentRegion::Text(region) => region.x,
            DocumentRegion::Plot(region) => region.x,
            DocumentRegion::Image(region) => region.x,
            DocumentRegion::Area(region) => region.x,
        }
    }

    pub fn y(&self) -> f64 {
        match self {
            DocumentRegion::Math(region) => region.y,
            DocumentRegion::Include(region) => region.y,
            DocumentRegion::Text(region) => region.y,
            DocumentRegion::Plot(region) => region.y,
            DocumentRegion::Image(region) => region.y,
            DocumentRegion::Area(region) => region.y,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            DocumentRegion::Math(region) => region.enabled,
            DocumentRegion::Include(region) => region.enabled,
            DocumentRegion::Text(region) => region.enabled,
            DocumentRegion::Plot(region) => region.enabled,
            DocumentRegion::Image(region) => region.enabled,
            DocumentRegion::Area(region) => region.enabled,
        }
    }

    /// Whether the region takes part in the calculation.
    /// A disabled region keeps its content,
    /// place and size: only its evaluation stops.
    pub fn set_enabled(&mut self, enabled: bool) {
        match self {
            DocumentRegion::Math(region) => region.enabled = enabled,
            DocumentRegion::Include(region) => region.enabled = enabled,
            DocumentRegion::Text(region) => region.enabled = enabled,
            DocumentRegion::Plot(region) => region.enabled = enabled,
            DocumentRegion::Image(region) => region.enabled = enabled,
            DocumentRegion::Area(region) => region.enabled = enabled,
        }
    }

    /// Moves the region to `page`, position `(x, y)` in points.
    pub fn set_position(&mut self, page: u32, x: f64, y: f64) {
        let (p, px, py) = match self {
            DocumentRegion::Math(region) => (&mut region.page, &mut region.x, &mut region.y),
            DocumentRegion::Include(region) => (&mut region.page, &mut region.x, &mut region.y),
            DocumentRegion::Text(region) => (&mut region.page, &mut region.x, &mut region.y),
            DocumentRegion::Plot(region) => (&mut region.page, &mut region.x, &mut region.y),
            DocumentRegion::Image(region) => (&mut region.page, &mut region.x, &mut region.y),
            DocumentRegion::Area(region) => (&mut region.page, &mut region.x, &mut region.y),
        };
        *p = page;
        *px = x;
        *py = y;
    }
}

#[derive(Debug, Clone, Default)]
pub struct Project {
    documents: BTreeMap<DocumentId, ProjectDocument>,
    /// The worksheets of referenced projects, spliced before the root.
    references: Arc<crate::project_reference::References>,
}

impl Project {
    pub fn new() -> Project {
        Project::default()
    }

    pub fn insert(&mut self, document: ProjectDocument) -> Result<(), ProjectError> {
        validate_document(&document)?;
        if self.documents.contains_key(&document.id) {
            return Err(ProjectError::DuplicateDocument(document.id));
        }
        self.documents.insert(document.id.clone(), document);
        Ok(())
    }

    pub fn document(&self, id: &DocumentId) -> Option<&ProjectDocument> {
        self.documents.get(id)
    }

    /// Replaces the referenced projects' documents and splices.
    pub fn set_references(
        &mut self,
        loaded: crate::project_reference::LoadedReferences,
    ) -> Result<(), ProjectError> {
        self.documents
            .retain(|id, _| !crate::project_reference::is_reference_document(id));
        for document in loaded.documents {
            validate_document(&document)?;
            self.documents.insert(document.id.clone(), document);
        }
        self.references = Arc::new(loaded.references);
        Ok(())
    }

    /// The consumer's references: aliases, messages, problems and providers.
    pub fn references(&self) -> &Arc<crate::project_reference::References> {
        &self.references
    }

    /// Whether an enabled math region of any loaded document defines the plain worksheet
    /// name `name` as a variable — or exports it from a Julia region — wherever it is and
    /// whether or not it is included.
    ///
    /// A plot trace whose x slot is one plain identifier — of any name, `x` included
    ///  — uses the plot's own sampled variable only when
    /// nothing defines that name. The analysis builds that trace's hidden regions and the
    /// session assembles its data, and the two must answer the same question, so both ask the
    /// project (`PlotScope`).
    pub fn defines_plain_name(&self, name: &str) -> bool {
        self.defined_plain_names().contains(&Name::plain(name))
    }

    /// Every plain worksheet name that an enabled math region of any loaded document defines
    /// as a variable (or exports from a Julia region); the plot scope (`PlotScope`).
    pub fn defined_plain_names(&self) -> HashSet<Name> {
        let mut names = HashSet::default();
        for document in self.documents.values() {
            for region in &document.regions {
                if !region.enabled() {
                    continue;
                }
                if let DocumentRegion::Math(math) = region.as_ref() {
                    statement_defined_names(&math.statement, &mut names);
                }
            }
        }
        names
    }

    /// Inserts or replaces a document (for example after an edit or a reload from disk).
    pub fn replace(
        &mut self,
        document: ProjectDocument,
    ) -> Result<Option<ProjectDocument>, ProjectError> {
        validate_document(&document)?;
        Ok(self.documents.insert(document.id.clone(), document))
    }

    pub fn documents(&self) -> impl Iterator<Item = &ProjectDocument> {
        self.documents.values()
    }

    pub fn analyze(&self, root: &DocumentId) -> Result<ProjectAnalysis, ProjectError> {
        let root_document = self
            .documents
            .get(root)
            .ok_or_else(|| ProjectError::MissingRoot(root.clone()))?;
        let mut builder = AnalysisBuilder::new(self, root_document.settings.clone());
        // the referenced projects' definitions come before the consumer's first region.
        for splice in &self.references.splices {
            for document in &splice.roots {
                if !self.documents.contains_key(document) {
                    continue;
                }
                let instance = builder.new_instance(document.clone(), None);
                let mut stack = vec![document.clone()];
                builder.expand_document(instance, document, true, &mut stack)?;
            }
        }
        let root_instance = builder.new_instance(root.clone(), None);
        let mut stack = vec![root.clone()];
        builder.expand_document(root_instance, root, false, &mut stack)?;
        builder.finish()
    }
}

fn validate_document(document: &ProjectDocument) -> Result<(), ProjectError> {
    let mut ids = HashSet::default();
    for region in &document.regions {
        if !ids.insert(region.id().to_owned()) {
            return Err(ProjectError::DuplicateRegion {
                document: document.id.clone(),
                region_id: region.id().to_owned(),
            });
        }
        if !region.x().is_finite() {
            return Err(ProjectError::NonFiniteCoordinate {
                document: document.id.clone(),
                region_id: region.id().to_owned(),
                coordinate: "x",
            });
        }
        if !region.y().is_finite() {
            return Err(ProjectError::NonFiniteCoordinate {
                document: document.id.clone(),
                region_id: region.id().to_owned(),
                coordinate: "y",
            });
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProjectError {
    #[error("document `{0}` is already loaded")]
    DuplicateDocument(DocumentId),
    #[error("root document `{0}` is not loaded")]
    MissingRoot(DocumentId),
    #[error("duplicate region id `{region_id}` in `{document}`")]
    DuplicateRegion {
        document: DocumentId,
        region_id: String,
    },
    #[error("region `{region_id}` in `{document}` has a non-finite {coordinate} coordinate")]
    NonFiniteCoordinate {
        document: DocumentId,
        region_id: String,
        coordinate: &'static str,
    },
    #[error("invalid include path in `{document}` region `{region_id}`: {source}")]
    InvalidIncludePath {
        document: DocumentId,
        region_id: String,
        source: PathError,
    },
    #[error(transparent)]
    Graph(#[from] GraphError),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct RegionOrigin {
    pub document: DocumentId,
    pub region_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EvaluationId(pub usize);

impl EvaluationId {
    /// The id of this node's region in [`ProjectAnalysis::worksheet`].
    pub fn region_id(self) -> String {
        graph_id(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
    Math,
    Include { target: DocumentId },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectNode {
    pub id: EvaluationId,
    pub origin: RegionOrigin,
    pub kind: NodeKind,
    instance: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticKind {
    MissingInclude {
        target: DocumentId,
    },
    IncludeCycle {
        chain: Vec<DocumentId>,
    },
    SettingsConflict {
        declared: CalculationSettings,
        effective: CalculationSettings,
    },
    DuplicateGlobalDefinition {
        name: Name,
        first: RegionOrigin,
    },
    /// A definition of a name under a reference alias. The region
    /// is left out of the analysis, so the alias keeps meaning the referenced project.
    ReferenceDefinition {
        name: Name,
        alias: String,
    },
    /// A column of an input table that defines nothing because of `reason`:
    /// a header that is not a name, a repeated name, an unknown unit.
    TableColumn {
        column: usize,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDiagnostic {
    pub origin: RegionOrigin,
    pub kind: DiagnosticKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectReference {
    pub evaluation_id: EvaluationId,
    pub origin: RegionOrigin,
    pub name: Name,
    pub span: crate::ast::Span,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectDimensionWarning {
    pub evaluation_id: EvaluationId,
    pub origin: RegionOrigin,
    pub span: crate::ast::Span,
    pub kind: DimensionWarningKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContextVersion {
    pub source: RegionOrigin,
    pub name: Name,
    pub label: Label,
    pub version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentVersion {
    pub document: DocumentId,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IncludeCacheKey {
    pub document: DocumentId,
    pub content_hash: String,
    pub effective_settings: CalculationSettings,
    pub context: Vec<ContextVersion>,
    /// Direct and transitive source versions. This makes a parent's cached export
    /// invalid when one of its nested includes changes.
    pub transitive_content: Vec<ContentVersion>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncludeCacheUse {
    pub include_node: EvaluationId,
    pub origin: RegionOrigin,
    pub key: IncludeCacheKey,
    pub hit: bool,
}

#[derive(Debug, Clone)]
pub struct ProjectAnalysis {
    nodes: Vec<ProjectNode>,
    worksheet: Worksheet,
    dependencies: Vec<Vec<EvaluationId>>,
    unresolved: Vec<ProjectReference>,
    dimension_warnings: Vec<ProjectDimensionWarning>,
    diagnostics: Vec<ProjectDiagnostic>,
    cache_uses: Vec<IncludeCacheUse>,
    instances: Vec<DocumentInstance>,
    /// The dependency graph of `worksheet`, built once by the analysis and reused by the session and
    /// the code generator.
    graph: DependencyGraph,
}

impl ProjectAnalysis {
    /// The dependency graph of [`worksheet`](Self::worksheet).
    pub fn graph(&self) -> &DependencyGraph {
        &self.graph
    }

    /// The expanded worksheet that is analysed and evaluated: one region per math node,
    /// with the id `EvaluationId::region_id` and top-down positions, includes already
    /// spliced in (definitions only).
    pub fn worksheet(&self) -> &Worksheet {
        &self.worksheet
    }

    pub fn nodes(&self) -> &[ProjectNode] {
        &self.nodes
    }

    pub fn dependencies_of(&self, id: EvaluationId) -> &[EvaluationId] {
        self.dependencies
            .get(id.0)
            .map_or(&[], |dependencies| dependencies.as_slice())
    }

    pub fn unresolved_references(&self) -> &[ProjectReference] {
        &self.unresolved
    }

    pub fn diagnostics(&self) -> &[ProjectDiagnostic] {
        &self.diagnostics
    }

    pub fn dimension_warnings(&self) -> &[ProjectDimensionWarning] {
        &self.dimension_warnings
    }

    pub fn cache_uses(&self) -> &[IncludeCacheUse] {
        &self.cache_uses
    }

    pub fn nodes_for_origin(&self, origin: &RegionOrigin) -> Vec<&ProjectNode> {
        self.nodes
            .iter()
            .filter(|node| &node.origin == origin)
            .collect()
    }

    pub fn single_node(&self, origin: &RegionOrigin) -> Option<&ProjectNode> {
        let mut nodes = self.nodes_for_origin(origin).into_iter();
        let node = nodes.next()?;
        nodes.next().is_none().then_some(node)
    }

    /// Invalidates the changed document and every including instance from its include
    /// point onward, recursively through the include tree.
    pub fn invalidated_by_document(&self, document: &DocumentId) -> Vec<&ProjectNode> {
        let mut earliest: Vec<Option<usize>> = vec![None; self.instances.len()];
        let mut queue = VecDeque::new();
        for instance in &self.instances {
            if &instance.document == document {
                queue.push_back((instance.id, 0));
            }
        }
        while let Some((instance_id, start)) = queue.pop_front() {
            if earliest[instance_id].is_some_and(|old| old <= start) {
                continue;
            }
            earliest[instance_id] = Some(start);
            if let Some(parent_include) = self.instances[instance_id].parent_include {
                let parent_instance = self.nodes[parent_include.0].instance;
                let position = self.instances[parent_instance]
                    .nodes
                    .iter()
                    .position(|&node| node == parent_include)
                    .expect("parent include belongs to its instance");
                queue.push_back((parent_instance, position));
            }
        }
        let mut invalidated = HashSet::default();
        for (instance, start) in earliest.into_iter().enumerate() {
            if let Some(start) = start {
                invalidated.extend(self.instances[instance].nodes[start..].iter().copied());
            }
        }
        self.nodes
            .iter()
            .filter(|node| invalidated.contains(&node.id))
            .collect()
    }
}

#[derive(Debug, Clone)]
struct DocumentInstance {
    id: usize,
    document: DocumentId,
    parent_include: Option<EvaluationId>,
    nodes: Vec<EvaluationId>,
}

#[derive(Debug)]
struct IncludeOccurrence {
    include_node: EvaluationId,
    target: DocumentId,
    subtree_math: BTreeSet<EvaluationId>,
    documents: BTreeSet<DocumentId>,
    cacheable: bool,
}

#[derive(Debug, Default)]
struct Expansion {
    math_nodes: BTreeSet<EvaluationId>,
    documents: BTreeSet<DocumentId>,
    cacheable: bool,
}

struct AnalysisBuilder<'a> {
    project: &'a Project,
    effective_settings: CalculationSettings,
    /// What the worksheet defines that changes how plot traces evaluate (`PlotScope`).
    plot_scope: PlotScope,
    nodes: Vec<ProjectNode>,
    graph_regions: Vec<Region>,
    graph_to_node: HashMap<String, EvaluationId>,
    instances: Vec<DocumentInstance>,
    diagnostics: Vec<ProjectDiagnostic>,
    occurrences: Vec<IncludeOccurrence>,
    global_definitions: HashMap<GlobalNameKey, RegionOrigin>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct GlobalNameKey {
    segments: Vec<Segment>,
    label: Label,
}

impl<'a> AnalysisBuilder<'a> {
    fn new(project: &'a Project, effective_settings: CalculationSettings) -> AnalysisBuilder<'a> {
        AnalysisBuilder {
            project,
            effective_settings,
            // The session answers the same question from the same project
            // (`WorksheetSession::plot_data`), so the hidden regions and the assembled data
            // always agree.
            plot_scope: PlotScope {
                defined: project.defined_plain_names(),
            },
            nodes: Vec::new(),
            graph_regions: Vec::new(),
            graph_to_node: HashMap::default(),
            instances: Vec::new(),
            diagnostics: Vec::new(),
            occurrences: Vec::new(),
            global_definitions: HashMap::default(),
        }
    }

    fn new_instance(
        &mut self,
        document: DocumentId,
        parent_include: Option<EvaluationId>,
    ) -> usize {
        let id = self.instances.len();
        self.instances.push(DocumentInstance {
            id,
            document,
            parent_include,
            nodes: Vec::new(),
        });
        id
    }

    fn expand_document(
        &mut self,
        instance: usize,
        document_id: &DocumentId,
        definitions_only: bool,
        stack: &mut Vec<DocumentId>,
    ) -> Result<Expansion, ProjectError> {
        // Borrowed from the project, not from the builder, so the builder stays mutable without
        // a copy of the document.
        let project = self.project;
        let document = project.documents.get(document_id).expect("loaded document");
        let mut order: Vec<usize> = (0..document.regions.len()).collect();
        order.sort_by(|&left, &right| {
            compare_regions(&document.regions[left], &document.regions[right])
        });
        let mut globals = Vec::new();
        let mut regular = Vec::new();
        for index in order {
            let region = &document.regions[index];
            if !region.enabled() {
                continue;
            }
            if matches!(
                region.as_ref(),
                DocumentRegion::Math(math)
                    if matches!(math.statement.kind, StatementKind::GlobalDefine { .. })
            ) {
                globals.push(index);
            } else {
                regular.push(index);
            }
        }

        let mut expansion = Expansion {
            cacheable: true,
            ..Expansion::default()
        };
        expansion.documents.insert(document_id.clone());
        for index in globals.into_iter().chain(regular) {
            match document.regions[index].as_ref() {
                DocumentRegion::Image(_) | DocumentRegion::Area(_) => {}
                DocumentRegion::Text(text) => {
                    // Inline math is evaluated at the text region's place in reading order.
                    for (run, statement) in
                        crate::richtext::RichText::parse(&text.text).evaluated_math()
                    {
                        if definitions_only && !is_definition(&statement) {
                            continue;
                        }
                        let statement = Arc::new(statement);
                        let region = Region {
                            id: crate::richtext::inline_region_id(&text.id, run),
                            page: text.page,
                            x: text.x,
                            y: text.y,
                            enabled: true,
                            statement: Arc::clone(&statement),
                        };
                        let node = self.push_math(instance, document_id, &region, statement);
                        expansion.math_nodes.insert(node);
                    }
                }
                DocumentRegion::Plot(plot) => {
                    // A plot defines nothing, so an included document contributes none of
                    // its plots; in the root, each trace expression is a hidden evaluation
                    // region at the plot's place in reading order.
                    if !definitions_only {
                        for region in plot.expression_regions(&self.plot_scope) {
                            let statement = Arc::clone(&region.statement);
                            let node = self.push_math(instance, document_id, &region, statement);
                            expansion.math_nodes.insert(node);
                        }
                    }
                }
                DocumentRegion::Math(region)
                    if matches!(region.statement.kind, StatementKind::Table { .. }) =>
                {
                    // each named, complete column defines its column vector.
                    let (columns, problems) = crate::table::column_definitions(&region.statement);
                    for (column, reason) in problems {
                        self.diagnostics.push(ProjectDiagnostic {
                            origin: RegionOrigin {
                                document: document_id.clone(),
                                region_id: region.id.clone(),
                            },
                            kind: DiagnosticKind::TableColumn { column, reason },
                        });
                    }
                    for (index, statement) in columns {
                        let statement = Arc::new(statement);
                        let column = Region {
                            id: crate::table::column_region_id(&region.id, index),
                            page: region.page,
                            x: region.x,
                            y: region.y,
                            enabled: region.enabled,
                            statement: Arc::clone(&statement),
                        };
                        let node = self.push_math(instance, document_id, &column, statement);
                        expansion.math_nodes.insert(node);
                    }
                }
                DocumentRegion::Math(region) => {
                    if definitions_only && !is_definition(&region.statement) {
                        continue;
                    }
                    if let Some((name, alias)) = self.reference_definition(document_id, region) {
                        self.diagnostics.push(ProjectDiagnostic {
                            origin: RegionOrigin {
                                document: document_id.clone(),
                                region_id: region.id.clone(),
                            },
                            kind: DiagnosticKind::ReferenceDefinition { name, alias },
                        });
                        continue;
                    }
                    if let StatementKind::GlobalDefine { target, .. } = &region.statement.kind {
                        self.record_global_definitions(document_id, &region.id, target);
                    }
                    // Shared, not copied: the worksheet region holds the document's own
                    // statement.
                    let statement = if definitions_only {
                        Arc::new(downgrade_global(Statement::clone(&region.statement)))
                    } else {
                        Arc::clone(&region.statement)
                    };
                    let node = self.push_math(instance, document_id, region, statement);
                    expansion.math_nodes.insert(node);
                }
                DocumentRegion::Include(include) => {
                    let include_node = match document_id.resolve(&include.path) {
                        Ok(target) => self.push_include(instance, document_id, include, target),
                        Err(source) => {
                            return Err(ProjectError::InvalidIncludePath {
                                document: document_id.clone(),
                                region_id: include.id.clone(),
                                source,
                            });
                        }
                    };
                    let target = match &self.nodes[include_node.0].kind {
                        NodeKind::Include { target } => target.clone(),
                        NodeKind::Math => unreachable!(),
                    };
                    if let Some(cycle_start) = stack.iter().position(|document| document == &target)
                    {
                        let mut chain = stack[cycle_start..].to_vec();
                        chain.push(target);
                        self.diagnostics.push(ProjectDiagnostic {
                            origin: self.nodes[include_node.0].origin.clone(),
                            kind: DiagnosticKind::IncludeCycle { chain },
                        });
                        expansion.cacheable = false;
                        continue;
                    }
                    let Some(target_document) = self.project.documents.get(&target) else {
                        self.diagnostics.push(ProjectDiagnostic {
                            origin: self.nodes[include_node.0].origin.clone(),
                            kind: DiagnosticKind::MissingInclude { target },
                        });
                        expansion.cacheable = false;
                        continue;
                    };
                    if target_document.settings != self.effective_settings {
                        self.diagnostics.push(ProjectDiagnostic {
                            origin: self.nodes[include_node.0].origin.clone(),
                            kind: DiagnosticKind::SettingsConflict {
                                declared: target_document.settings.clone(),
                                effective: self.effective_settings.clone(),
                            },
                        });
                    }
                    let child_instance = self.new_instance(target.clone(), Some(include_node));
                    stack.push(target.clone());
                    let child = self.expand_document(child_instance, &target, true, stack)?;
                    stack.pop();
                    expansion
                        .math_nodes
                        .extend(child.math_nodes.iter().copied());
                    expansion.documents.extend(child.documents.iter().cloned());
                    expansion.cacheable &= child.cacheable;
                    self.occurrences.push(IncludeOccurrence {
                        include_node,
                        target,
                        subtree_math: child.math_nodes,
                        documents: child.documents,
                        cacheable: child.cacheable,
                    });
                }
            }
        }
        Ok(expansion)
    }

    /// The first name under a reference alias that a consumer region defines.
    fn reference_definition(
        &self,
        document: &DocumentId,
        region: &Region,
    ) -> Option<(Name, String)> {
        if crate::project_reference::is_reference_document(document) {
            return None;
        }
        let references = &self.project.references;
        let target = match &solving_statement_kind(&region.statement.kind) {
            StatementKind::Define { target, .. } | StatementKind::GlobalDefine { target, .. } => {
                target
            }
            _ => return None,
        };
        target_names(target).into_iter().find_map(|(name, _)| {
            let alias = references.alias_of(&name)?.to_owned();
            Some((name, alias))
        })
    }

    fn push_math(
        &mut self,
        instance: usize,
        document: &DocumentId,
        source: &Region,
        statement: Arc<Statement>,
    ) -> EvaluationId {
        let id = EvaluationId(self.nodes.len());
        let graph_id = graph_id(id);
        self.nodes.push(ProjectNode {
            id,
            origin: RegionOrigin {
                document: document.clone(),
                region_id: source.id.clone(),
            },
            kind: NodeKind::Math,
            instance,
        });
        self.instances[instance].nodes.push(id);
        self.graph_to_node.insert(graph_id.clone(), id);
        self.graph_regions.push(Region {
            id: graph_id,
            page: 0,
            x: 0.0,
            y: self.graph_regions.len() as f64,
            enabled: true,
            statement,
        });
        id
    }

    fn record_global_definitions(
        &mut self,
        document: &DocumentId,
        region_id: &str,
        target: &Target,
    ) {
        let origin = RegionOrigin {
            document: document.clone(),
            region_id: region_id.to_owned(),
        };
        for (name, label) in target_names(target) {
            let key = GlobalNameKey {
                segments: name.segments.clone(),
                label: name.label.unwrap_or(label),
            };
            if let Some(first) = self.global_definitions.get(&key) {
                self.diagnostics.push(ProjectDiagnostic {
                    origin: origin.clone(),
                    kind: DiagnosticKind::DuplicateGlobalDefinition {
                        name,
                        first: first.clone(),
                    },
                });
            } else {
                self.global_definitions.insert(key, origin.clone());
            }
        }
    }

    fn push_include(
        &mut self,
        instance: usize,
        document: &DocumentId,
        source: &IncludeRegion,
        target: DocumentId,
    ) -> EvaluationId {
        let id = EvaluationId(self.nodes.len());
        self.nodes.push(ProjectNode {
            id,
            origin: RegionOrigin {
                document: document.clone(),
                region_id: source.id.clone(),
            },
            kind: NodeKind::Include { target },
            instance,
        });
        self.instances[instance].nodes.push(id);
        id
    }

    fn finish(mut self) -> Result<ProjectAnalysis, ProjectError> {
        let mut worksheet = Worksheet {
            regions: self.graph_regions,
        };
        // Given/Find blocks are derived from the reading order of the whole project.
        worksheet.assemble_solve_blocks();
        let graph = DependencyGraph::build(&worksheet)?;
        let dimensional_analysis = analyze_dimensions_with(&worksheet, &graph);
        let mut dependencies = vec![Vec::new(); self.nodes.len()];
        for node in &self.nodes {
            if !matches!(node.kind, NodeKind::Math) {
                continue;
            }
            let id = graph_id(node.id);
            dependencies[node.id.0] = graph
                .dependencies_of(&id)
                .unwrap_or_default()
                .iter()
                .map(|dependency| self.graph_to_node[dependency])
                .collect();
        }
        let unresolved = graph
            .unresolved_references()
            .iter()
            .map(|reference| {
                let evaluation_id = self.graph_to_node[&reference.region_id];
                ProjectReference {
                    evaluation_id,
                    origin: self.nodes[evaluation_id.0].origin.clone(),
                    name: reference.name.clone(),
                    span: reference.span,
                }
            })
            .collect();
        let dimension_warnings = dimensional_analysis
            .warnings()
            .iter()
            .map(|warning| {
                let evaluation_id = self.graph_to_node[&warning.region_id];
                ProjectDimensionWarning {
                    evaluation_id,
                    origin: self.nodes[evaluation_id.0].origin.clone(),
                    span: warning.span,
                    kind: warning.kind.clone(),
                }
            })
            .collect();

        self.occurrences
            .sort_by_key(|occurrence| occurrence.include_node);
        let mut cache_uses = Vec::new();
        let mut seen = HashSet::default();
        for occurrence in self
            .occurrences
            .into_iter()
            .filter(|occurrence| occurrence.cacheable)
        {
            let subtree_graph_ids: HashSet<String> = occurrence
                .subtree_math
                .iter()
                .map(|&node| graph_id(node))
                .collect();
            let mut context = Vec::new();
            for reference in graph.resolved_references() {
                if subtree_graph_ids.contains(&reference.region_id)
                    && !subtree_graph_ids.contains(&reference.definition_region_id)
                {
                    let producer = self.graph_to_node[&reference.definition_region_id];
                    context.push(ContextVersion {
                        source: self.nodes[producer.0].origin.clone(),
                        name: reference.definition_name.clone(),
                        label: reference.definition_label,
                        version: reference.definition_version,
                    });
                }
            }
            context.sort_by(context_version_cmp);
            context.dedup();
            let transitive_content = occurrence
                .documents
                .iter()
                .map(|document| ContentVersion {
                    document: document.clone(),
                    content_hash: self.project.documents[document].content_hash.clone(),
                })
                .collect();
            let key = IncludeCacheKey {
                document: occurrence.target.clone(),
                content_hash: self.project.documents[&occurrence.target]
                    .content_hash
                    .clone(),
                effective_settings: self.effective_settings.clone(),
                context,
                transitive_content,
            };
            let hit = !seen.insert(key.clone());
            cache_uses.push(IncludeCacheUse {
                include_node: occurrence.include_node,
                origin: self.nodes[occurrence.include_node.0].origin.clone(),
                key,
                hit,
            });
        }
        Ok(ProjectAnalysis {
            nodes: self.nodes,
            worksheet,
            dependencies,
            unresolved,
            dimension_warnings,
            diagnostics: self.diagnostics,
            cache_uses,
            instances: self.instances,
            graph,
        })
    }
}

pub(crate) fn graph_id(id: EvaluationId) -> String {
    format!("node-{}", id.0)
}

fn compare_regions(left: &DocumentRegion, right: &DocumentRegion) -> std::cmp::Ordering {
    left.page()
        .cmp(&right.page())
        .then_with(|| left.y().total_cmp(&right.y()))
        .then_with(|| left.x().total_cmp(&right.x()))
        .then_with(|| left.id().cmp(right.id()))
}

fn solving_statement_kind(kind: &StatementKind) -> &StatementKind {
    match kind {
        StatementKind::Solve { call, .. } => solving_statement_kind(&call.kind),
        _ => kind,
    }
}

fn is_definition(statement: &Statement) -> bool {
    match &statement.kind {
        StatementKind::Solve { call, .. } => is_definition(call),
        StatementKind::Define { .. } | StatementKind::GlobalDefine { .. } => true,
        // A stopped block defines nothing.
        StatementKind::Julia { block } => block.playing,
        _ => false,
    }
}

/// Adds the worksheet value names a region statement defines (a variable, or a name exported
/// by a Julia region). A function `x(t)` defines no value, so neither it nor its parameters
/// shadow a plot variable of the same name.
fn statement_defined_names(statement: &Statement, names: &mut HashSet<Name>) {
    match &statement.kind {
        StatementKind::Define { target, .. } | StatementKind::GlobalDefine { target, .. } => {
            for (defined, label) in target_names(target) {
                if label == Label::Var {
                    names.insert(Name {
                        label: None,
                        ..defined
                    });
                }
            }
        }
        // A stopped block exports no name.
        StatementKind::Julia { block } if block.playing => {
            names.extend(block.exports().iter().map(|export| Name::plain(export)));
        }
        _ => {}
    }
}

fn target_names(target: &Target) -> Vec<(Name, Label)> {
    match &target.kind {
        TargetKind::Invalid { .. } => Vec::new(),
        TargetKind::Ident { name } => vec![(name.clone(), Label::Var)],
        TargetKind::FunctionHead { name, .. } => vec![(name.name.clone(), Label::Fn)],
        TargetKind::Paren { target }
        | TargetKind::Transpose { target }
        | TargetKind::Index { base: target, .. }
        | TargetKind::Column { base: target, .. }
        | TargetKind::Row { base: target, .. } => target_names(target),
        TargetKind::Destructure { cells, .. } => cells.iter().flat_map(target_names).collect(),
    }
}

fn downgrade_global(statement: Statement) -> Statement {
    match statement.kind {
        StatementKind::GlobalDefine { target, rhs } => Statement {
            span: statement.span,
            kind: StatementKind::Define {
                target,
                rhs,
                tail: None,
            },
        },
        _ => statement,
    }
}

fn context_version_cmp(left: &ContextVersion, right: &ContextVersion) -> std::cmp::Ordering {
    left.source
        .cmp(&right.source)
        .then_with(|| name_key(&left.name).cmp(&name_key(&right.name)))
        .then_with(|| left.label.as_str().cmp(right.label.as_str()))
        .then_with(|| left.version.cmp(&right.version))
}

fn name_key(name: &Name) -> String {
    name.segments
        .iter()
        .map(|segment| {
            if segment.subscript {
                format!("_{{{}}}", segment.text)
            } else {
                segment.text.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod verbatim_path_tests {
    use super::strip_verbatim_prefix;

    #[test]
    fn strips_windows_drive_and_unc_verbatim_prefixes() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\proj\a.eqv"),
            r"C:\proj\a.eqv"
        );
        assert_eq!(
            strip_verbatim_prefix(r"\\?\UNC\server\share\a.eqv"),
            r"\\server\share\a.eqv"
        );
        assert_eq!(
            strip_verbatim_prefix("//?/UNC/server/share/a.eqv"),
            "//server/share/a.eqv"
        );
        assert_eq!(strip_verbatim_prefix("//?/C:/proj/a.eqv"), "C:/proj/a.eqv");
        assert_eq!(
            strip_verbatim_prefix("/home/user/a.eqv"),
            "/home/user/a.eqv"
        );
    }
}
