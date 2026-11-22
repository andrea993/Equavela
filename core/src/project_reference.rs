//! Project references.
//!
//! A provider's worksheets are read under virtual document ids (`@Alias/<path>`) and every name
//! they define is renamed into the alias namespace. An export the consumer may use becomes the
//! one-segment name `Alias.name`, which is what the consumer types; any other name gets an
//! extra leading segment `Alias.` that the parser never produces, so the consumer cannot reach
//! it. The analysis then splices the renamed worksheets before the consumer's first region
//! ([`crate::project::Project::analyze`]).

use crate::ast::{Label, Name, Segment, StatementKind, TargetKind};
use crate::graph::Region;
use crate::project::{DocumentId, DocumentRegion, ProjectDocument};
use crate::project_directory::MANIFEST_FILE;
use crate::project_manifest::{ApiEntry, ExportKind, ProjectManifest, ReferenceEntry};
use crate::syntax::print_name;
use crate::worksheet_file::parse_document;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The worksheets of one reference that the analysis splices, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceSplice {
    /// The alias chain, `Thermo` or `Thermo/Steam` for a provider's own reference.
    pub alias: String,
    pub roots: Vec<DocumentId>,
}

/// What a consumer's references contribute to its analysis.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct References {
    /// Nested providers first, so their definitions precede the code that uses them.
    pub splices: Vec<ReferenceSplice>,
    /// The consumer's own aliases.
    pub aliases: Vec<String>,
    /// Messages for reference names the consumer may not use, by printed name.
    pub messages: BTreeMap<String, String>,
    /// Problems of the consumer's references: alias and message.
    pub problems: Vec<(String, String)>,
    /// Every provider read, for trust.
    pub providers: Vec<Provider>,
}

impl References {
    /// The message for a name the consumer wrote under one of its aliases that does not
    /// resolve, or `None` when the name is not a reference name.
    pub fn undefined_message(&self, name: &Name) -> Option<String> {
        let printed = print_name(name);
        let alias = self.alias_of(name)?;
        Some(self.messages.get(&printed).cloned().unwrap_or_else(|| {
            let rest = &printed[alias.len() + 1..];
            format!("`{alias}` exports no `{rest}`")
        }))
    }

    /// The consumer alias a name is written under (`Thermo` for `Thermo.c_p`).
    pub fn alias_of(&self, name: &Name) -> Option<&str> {
        let first = name.segments.first()?;
        if first.subscript || name.segments.len() > 1 && !name.segments[1].subscript {
            return None;
        }
        self.aliases
            .iter()
            .find(|alias| {
                first.text.len() > alias.len() + 1
                    && first.text.starts_with(alias.as_str())
                    && first.text.as_bytes()[alias.len()] == b'.'
            })
            .map(String::as_str)
    }
}

/// A provider project read for a reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub alias: String,
    /// The alias chain from the consumer, `Thermo` or `Thermo/Steam` for a provider's own
    /// reference.
    pub chain: String,
    pub project_id: String,
    pub name: String,
    pub root: PathBuf,
    /// Its current exports, the API a reference locks.
    pub api: Vec<ApiEntry>,
    /// Hash of its Julia code: package sources and the Julia regions spliced from it.
    pub julia_hash: String,
    /// The virtual documents spliced from it, so a pass can tell which Julia regions are its.
    pub documents: Vec<DocumentId>,
}

/// The documents and analysis input of a consumer's references.
#[derive(Debug, Default)]
pub struct LoadedReferences {
    pub documents: Vec<ProjectDocument>,
    pub texts: HashMap<(DocumentId, String), String>,
    pub references: References,
}

/// Whether a document id is a provider worksheet read for a reference (`@Alias/…`).
pub fn is_reference_document(id: &DocumentId) -> bool {
    id.as_str().starts_with('@')
}

/// The name, kind and arity of what a definition region exports, if it can be exported.
pub fn exportable(region: &DocumentRegion) -> Option<(Name, ExportKind, Option<usize>)> {
    let DocumentRegion::Math(math) = region else {
        return None;
    };
    let target = match &math.statement.kind {
        StatementKind::Define { target, .. } | StatementKind::GlobalDefine { target, .. } => target,
        _ => return None,
    };
    match &target.kind {
        TargetKind::Ident { name } => Some((name.clone(), ExportKind::Value, None)),
        TargetKind::FunctionHead { name, params } => {
            Some((name.name.clone(), ExportKind::Function, Some(params.len())))
        }
        _ => None,
    }
}

/// Reads a project's current API: its exports that still name an exportable
/// region, in manifest order. Broken exports are left out.
pub fn read_api(root: &Path, manifest: &ProjectManifest) -> Vec<ApiEntry> {
    let mut documents: HashMap<String, Option<ProjectDocument>> = HashMap::new();
    let mut api = Vec::new();
    for export in &manifest.exports {
        let document = documents
            .entry(export.worksheet.clone())
            .or_insert_with(|| {
                let sheet = manifest
                    .worksheets
                    .iter()
                    .find(|sheet| sheet.id == export.worksheet)?;
                let id = DocumentId::new(&sheet.path).ok()?;
                let text = std::fs::read_to_string(root.join(&sheet.path)).ok()?;
                parse_document(id, &text).ok().map(|loaded| loaded.document)
            });
        let Some(document) = document else { continue };
        let Some(region) = document
            .regions
            .iter()
            .find(|region| region.id() == export.region && region.enabled())
        else {
            continue;
        };
        if let Some((name, kind, arity)) = exportable(region) {
            api.push(ApiEntry {
                id: export.id.clone(),
                name: print_name(&Name {
                    label: None,
                    ..name
                }),
                kind,
                arity,
            });
        }
    }
    api
}

/// the name of a project's Julia package and its folder, when its environment's
/// `Project.toml` has a `name` and a `uuid`.
pub fn provider_package(root: &Path, manifest: &ProjectManifest) -> Option<(String, PathBuf)> {
    let folder = root.join(manifest.environment.as_deref()?);
    let text = std::fs::read_to_string(folder.join("Project.toml")).ok()?;
    let table = text.parse::<toml::Table>().ok()?;
    table.get("uuid")?.as_str()?;
    let name = table.get("name")?.as_str()?.to_owned();
    Some((name, folder))
}

/// Reads a project manifest without locking or validating the folder further.
pub fn read_manifest(root: &Path) -> Result<ProjectManifest, String> {
    let path = root.join(MANIFEST_FILE);
    let yaml =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    ProjectManifest::from_yaml(&yaml).map_err(|error| error.to_string())
}

/// Loads every reference of the consumer at `root`. Problems are recorded,
/// never returned as errors: a consumer opens with broken references.
pub fn load_references(root: &Path, manifest: &ProjectManifest) -> LoadedReferences {
    let mut loaded = LoadedReferences::default();
    loaded.references.aliases = manifest
        .references
        .iter()
        .map(|reference| reference.alias.clone())
        .collect();
    let mut stack = vec![manifest.project_id.clone()];
    for reference in &manifest.references {
        let mut chain = vec![manifest.name.clone()];
        if let Err(problem) = load_reference(
            root,
            reference,
            "",
            &mut stack,
            &mut chain,
            &mut loaded,
            true,
        ) {
            loaded
                .references
                .problems
                .push((reference.alias.clone(), problem));
        }
    }
    loaded
}

fn load_reference(
    consumer_root: &Path,
    reference: &ReferenceEntry,
    id_prefix: &str,
    stack: &mut Vec<String>,
    chain: &mut Vec<String>,
    loaded: &mut LoadedReferences,
    top: bool,
) -> Result<(), String> {
    let alias = &reference.alias;
    let folder = consumer_root.join(&reference.path);
    let root = std::fs::canonicalize(&folder)
        .map_err(|_| format!("the project folder `{}` was not found", reference.path))?;
    let manifest = read_manifest(&root)
        .map_err(|_| format!("`{}` is not a Equavela project", reference.path))?;
    if manifest.project_id != reference.project_id {
        return Err(format!(
            "`{}` holds another project ({}) than the one referenced",
            reference.path, manifest.name
        ));
    }
    if stack.contains(&manifest.project_id) {
        chain.push(manifest.name.clone());
        return Err(format!("reference cycle: {}", chain.join(" → ")));
    }
    let api = read_api(&root, &manifest);
    let current: HashMap<&str, &ApiEntry> =
        api.iter().map(|entry| (entry.id.as_str(), entry)).collect();
    let mut public = BTreeSet::new();
    for locked in &reference.api {
        let qualified = format!("{alias}.{}", locked.name);
        match current.get(locked.id.as_str()) {
            Some(now)
                if now.name == locked.name
                    && now.kind == locked.kind
                    && now.arity == locked.arity =>
            {
                public.insert(locked.name.clone());
            }
            Some(now) if now.name == locked.name => {
                if top {
                    loaded.references.messages.insert(
                        qualified.clone(),
                        format!("`{qualified}` changed signature: update the reference"),
                    );
                }
            }
            _ => {
                if top {
                    loaded.references.messages.insert(
                        qualified.clone(),
                        format!("`{qualified}` is no longer exported: update the reference"),
                    );
                }
            }
        }
    }
    if top {
        for entry in &api {
            if !reference.api.iter().any(|locked| locked.id == entry.id) {
                let qualified = format!("{alias}.{}", entry.name);
                loaded.references.messages.entry(qualified.clone()).or_insert_with(|| {
                    format!("`{qualified}` is not in the locked API of `{alias}`: update the reference")
                });
            }
        }
    }

    // The provider's own references come first, inside this namespace.
    let prefix = format!("{id_prefix}@{alias}/");
    let first_nested = loaded.documents.len();
    let first_splice = loaded.references.splices.len();
    stack.push(manifest.project_id.clone());
    chain.push(manifest.name.clone());
    for nested in &manifest.references {
        let mut nested_loaded = LoadedReferences::default();
        if let Err(problem) = load_reference(
            &root,
            nested,
            &prefix,
            stack,
            chain,
            &mut nested_loaded,
            false,
        ) {
            loaded
                .references
                .problems
                .push((format!("{alias}/{}", nested.alias), problem));
        }
        loaded.documents.extend(nested_loaded.documents);
        loaded.texts.extend(nested_loaded.texts);
        loaded
            .references
            .splices
            .extend(nested_loaded.references.splices);
        loaded
            .references
            .problems
            .extend(nested_loaded.references.problems);
        loaded
            .references
            .providers
            .extend(nested_loaded.references.providers);
    }
    stack.pop();
    chain.pop();

    // The worksheets that define the usable exports, each with what it includes.
    let mut roots = Vec::new();
    for export in &manifest.exports {
        let Some(entry) = api.iter().find(|entry| entry.id == export.id) else {
            continue;
        };
        if !public.contains(&entry.name) {
            continue;
        }
        let Some(sheet) = manifest
            .worksheets
            .iter()
            .find(|sheet| sheet.id == export.worksheet)
        else {
            continue;
        };
        let id = DocumentId::new(&format!("{prefix}{}", sheet.path))
            .map_err(|error| error.to_string())?;
        if !roots.contains(&id) {
            roots.push(id);
        }
    }
    let mut own = Vec::new();
    let mut queue: Vec<DocumentId> = roots.iter().rev().cloned().collect();
    let mut seen = BTreeSet::new();
    while let Some(id) = queue.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(relative) = id.as_str().strip_prefix(&prefix) else {
            continue;
        };
        let path = root.join(relative);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let parsed =
            parse_document(id.clone(), &text).map_err(|error| format!("`{relative}`: {error}"))?;
        for region in &parsed.document.regions {
            if let DocumentRegion::Include(include) = region.as_ref() {
                if let Ok(target) = id.resolve(&include.path) {
                    queue.push(target);
                }
            }
        }
        for (region, text) in parsed.texts {
            loaded.texts.insert((id.clone(), region), text);
        }
        own.push(parsed.document);
    }

    // Rename everything this provider and its own references define.
    let mut documents: Vec<ProjectDocument> = loaded.documents.drain(first_nested..).collect();
    let nested_count = documents.len();
    documents.extend(own);
    let mut defined = BTreeSet::new();
    for document in &documents {
        for region in &document.regions {
            if let DocumentRegion::Math(math) = region.as_ref() {
                defined_names(&math.statement.kind, &mut defined);
            }
        }
    }
    let own_count = documents.len() - nested_count;
    let julia_hash = julia_hash(&root, &documents[nested_count..]);
    let renamed: Vec<ProjectDocument> = documents
        .into_iter()
        .map(|document| namespace_document(document, alias, &defined, &public))
        .collect();
    let own_ids: Vec<DocumentId> = renamed[renamed.len() - own_count..]
        .iter()
        .map(|document| document.id.clone())
        .collect();
    loaded.documents.extend(renamed);
    for splice in &mut loaded.references.splices[first_splice..] {
        splice.alias = format!("{alias}/{}", splice.alias);
    }
    loaded.references.splices.push(ReferenceSplice {
        alias: alias.clone(),
        roots,
    });
    let chain = id_prefix
        .split('/')
        .filter_map(|part| part.strip_prefix('@'))
        .chain(std::iter::once(alias.as_str()))
        .collect::<Vec<_>>()
        .join("/");
    loaded.references.providers.push(Provider {
        alias: alias.clone(),
        chain,
        project_id: manifest.project_id.clone(),
        name: manifest.name.clone(),
        root,
        api,
        julia_hash,
        documents: own_ids,
    });
    Ok(())
}

/// The names a statement defines at worksheet level, by segments (labels apart).
fn defined_names(kind: &StatementKind, names: &mut BTreeSet<String>) {
    fn target(kind: &TargetKind, names: &mut BTreeSet<String>) {
        match kind {
            TargetKind::Ident { name } => {
                names.insert(segments_key(&name.segments));
            }
            TargetKind::FunctionHead { name, .. } => {
                names.insert(segments_key(&name.name.segments));
            }
            TargetKind::Paren { target: inner }
            | TargetKind::Index { base: inner, .. }
            | TargetKind::Column { base: inner, .. }
            | TargetKind::Row { base: inner, .. } => target(&inner.kind, names),
            TargetKind::Destructure { cells, .. } => {
                for cell in cells {
                    target(&cell.kind, names);
                }
            }
        }
    }
    match kind {
        StatementKind::Define { target: t, .. } | StatementKind::GlobalDefine { target: t, .. } => {
            target(&t.kind, names)
        }
        StatementKind::Solve { call, .. } => defined_names(&call.kind, names),
        _ => {}
    }
}

/// A name's segments as one comparable key (`_{…}` marks a subscript).
fn segments_key(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|segment| {
            if segment.subscript {
                format!("_{{{}}}", segment.text)
            } else {
                format!("{{{}}}", segment.text)
            }
        })
        .collect()
}

/// The name a provider name becomes in the consumer (module docs).
fn namespaced(name: &Name, alias: &str, public: &BTreeSet<String>) -> Name {
    let mut renamed = name.clone();
    let plain = print_name(&Name {
        label: None,
        ..name.clone()
    });
    if public.contains(&plain) {
        renamed.segments[0].text = format!("{alias}.{}", renamed.segments[0].text);
    } else {
        renamed.segments.insert(
            0,
            Segment {
                text: format!("{alias}."),
                subscript: false,
            },
        );
    }
    renamed
}

/// A provider document with its names in the alias namespace. Only math and include regions
/// are kept: text and table regions of a provider are not spliced.
fn namespace_document(
    mut document: ProjectDocument,
    alias: &str,
    defined: &BTreeSet<String>,
    public: &BTreeSet<String>,
) -> ProjectDocument {
    document.regions = document
        .regions
        .into_iter()
        .filter_map(|region| match region.as_ref() {
            DocumentRegion::Include(_) => Some(region),
            DocumentRegion::Math(math) => {
                let mut value = serde_json::to_value(math.statement.as_ref()).ok()?;
                rename_value(&mut value, &|name: &Name| {
                    let renameable =
                        matches!(name.label, None | Some(Label::Var) | Some(Label::Fn));
                    (renameable && defined.contains(&segments_key(&name.segments)))
                        .then(|| namespaced(name, alias, public))
                });
                let statement = serde_json::from_value(value).ok()?;
                Some(Arc::new(DocumentRegion::Math(Box::new(Region {
                    statement: Arc::new(statement),
                    ..Region::clone(math)
                }))))
            }
            _ => None,
        })
        .collect();
    document
}

/// Replaces every name object (`{"segments": [...], "label": ...}`) of a serialized statement.
fn rename_value(value: &mut Value, rename: &dyn Fn(&Name) -> Option<Name>) {
    match value {
        Value::Object(map) => {
            let is_name = map.get("segments").is_some_and(Value::is_array)
                && map.keys().all(|key| key == "segments" || key == "label");
            if is_name {
                if let Ok(name) = serde_json::from_value::<Name>(Value::Object(map.clone())) {
                    if let Some(renamed) = rename(&name) {
                        if let Ok(new) = serde_json::to_value(renamed) {
                            *value = new;
                        }
                    }
                    return;
                }
            }
            for child in map.values_mut() {
                rename_value(child, rename);
            }
        }
        Value::Array(items) => {
            for item in items {
                rename_value(item, rename);
            }
        }
        _ => {}
    }
}

///  over the provider's `julia/src` files and the Julia regions of its spliced
/// documents.
fn julia_hash(root: &Path, documents: &[ProjectDocument]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
        }
        hash = (hash ^ 0xff).wrapping_mul(0x100000001b3);
    };
    let mut files = Vec::new();
    collect_files(&root.join("julia").join("src"), &mut files);
    files.sort();
    for file in files {
        // Relative names, so moving the provider keeps its trust.
        let relative = file.strip_prefix(root).unwrap_or(&file);
        feed(relative.to_string_lossy().replace('\\', "/").as_bytes());
        if let Ok(bytes) = std::fs::read(&file) {
            feed(&bytes);
        }
    }
    for document in documents {
        for region in &document.regions {
            if let DocumentRegion::Math(math) = region.as_ref() {
                if let StatementKind::Julia { block } = &math.statement.kind {
                    feed(document.id.as_str().as_bytes());
                    feed(block.code.as_deref().unwrap_or_default().as_bytes());
                }
            }
        }
    }
    format!("{hash:016x}")
}

fn collect_files(folder: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

// ---- manifest operations ------------------------------------------------------

fn locked<T>(
    root: &Path,
    change: impl FnOnce(&Path, &mut ProjectManifest) -> Result<T, String>,
) -> Result<(ProjectManifest, T), String> {
    let _guard = crate::project_tree::ProjectGuard::acquire(root)?;
    let root =
        std::fs::canonicalize(root).map_err(|error| format!("{}: {error}", root.display()))?;
    let mut manifest = read_manifest(&root)?;
    let result = change(&root, &mut manifest)?;
    crate::project_tree::write_manifest(&root, &manifest)?;
    Ok((manifest, result))
}

/// exports the definition region `region` of the worksheet at `path` (project-relative),
/// or stops exporting it.
pub fn set_export(
    root: &Path,
    path: &str,
    region: &str,
    exported: bool,
) -> Result<ProjectManifest, String> {
    locked(root, |root, manifest| {
        let sheet = manifest
            .worksheets
            .iter()
            .find(|sheet| sheet.path == path)
            .ok_or_else(|| format!("`{path}` is not a worksheet of the project"))?
            .id
            .clone();
        let at = manifest
            .exports
            .iter()
            .position(|export| export.worksheet == sheet && export.region == region);
        match (exported, at) {
            (false, Some(at)) => {
                manifest.exports.remove(at);
            }
            (true, None) => {
                let id = DocumentId::new(path).map_err(|error| error.to_string())?;
                let text = std::fs::read_to_string(root.join(path))
                    .map_err(|error| format!("`{path}`: {error}"))?;
                let document = parse_document(id, &text)
                    .map_err(|error| format!("`{path}`: {error}"))?
                    .document;
                let found = document
                    .regions
                    .iter()
                    .find(|candidate| candidate.id() == region)
                    .ok_or_else(|| format!("`{path}` has no region `{region}`: save it first"))?;
                let (name, _, _) = exportable(found).ok_or_else(|| {
                    "only a definition of one value or function can be exported".to_string()
                })?;
                let printed = print_name(&Name {
                    label: None,
                    ..name
                });
                if read_api(root, manifest)
                    .iter()
                    .any(|entry| entry.name == printed)
                {
                    return Err(format!("the project already exports `{printed}`"));
                }
                manifest.exports.push(crate::project_manifest::ExportEntry {
                    id: crate::document_archive::new_document_id(),
                    worksheet: sheet,
                    region: region.to_owned(),
                });
            }
            _ => {}
        }
        Ok(())
    })
    .map(|(manifest, ())| manifest)
}

/// The path of `target` relative to `base`, both absolute, with `/`.
pub fn relative_path(base: &Path, target: &Path) -> Result<String, String> {
    let base: Vec<_> = base.components().collect();
    let target: Vec<_> = target.components().collect();
    if base.first() != target.first() {
        return Err(
            "the project is on another drive: it cannot be referenced by a relative path".into(),
        );
    }
    let common = base
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let mut parts: Vec<String> = vec!["..".into(); base.len() - common];
    parts.extend(
        target[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    if parts.is_empty() {
        return Err("a project cannot reference itself".into());
    }
    Ok(parts.join("/"))
}

/// An alias proposed from a project name: its letters and digits, starting with a
/// letter, with `2`, `3`, … when taken.
pub fn propose_alias(name: &str, taken: &[String]) -> String {
    let mut base: String = name.chars().filter(|c| c.is_alphanumeric()).collect();
    if !base.chars().next().is_some_and(char::is_alphabetic) {
        base = format!("P{base}");
    }
    if base.eq_ignore_ascii_case("julia") {
        base.push('1');
    }
    let free = |alias: &str| !taken.iter().any(|other| other.eq_ignore_ascii_case(alias));
    if free(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}{n}"))
        .find(|alias| free(alias))
        .expect("an unused alias")
}

/// Whether `target` is reachable from the references of the project at `root`.
fn reaches(root: &Path, target: &str, seen: &mut BTreeSet<String>) -> bool {
    let Ok(manifest) = read_manifest(root) else {
        return false;
    };
    if manifest.project_id == target {
        return true;
    }
    if !seen.insert(manifest.project_id.clone()) {
        return false;
    }
    manifest.references.iter().any(|reference| {
        std::fs::canonicalize(root.join(&reference.path))
            .is_ok_and(|next| reaches(&next, target, seen))
    })
}

/// references the project in `folder` under `alias` (or a proposed one), locking its
/// current API. Returns the manifest and the alias.
pub fn add_reference(
    root: &Path,
    folder: &Path,
    alias: Option<&str>,
) -> Result<(ProjectManifest, String), String> {
    locked(root, |root, manifest| {
        let provider = std::fs::canonicalize(folder)
            .map_err(|error| format!("{}: {error}", folder.display()))?;
        if provider == root {
            return Err("a project cannot reference itself".into());
        }
        let theirs = read_manifest(&provider)
            .map_err(|_| format!("`{}` is not a Equavela project", folder.display()))?;
        if theirs.project_id == manifest.project_id {
            return Err("a project cannot reference itself".into());
        }
        if manifest
            .references
            .iter()
            .any(|reference| reference.project_id == theirs.project_id)
        {
            return Err(format!("`{}` is already referenced", theirs.name));
        }
        if reaches(&provider, &manifest.project_id, &mut BTreeSet::new()) {
            return Err(format!(
                "`{}` already uses this project: the reference would make a cycle",
                theirs.name
            ));
        }
        let taken: Vec<String> = manifest
            .references
            .iter()
            .map(|reference| reference.alias.clone())
            .collect();
        let alias = match alias {
            Some(alias) => {
                if !crate::project_manifest::is_alias(alias) {
                    return Err(format!(
                        "`{alias}` is not a valid alias: use a letter followed by letters or digits"
                    ));
                }
                if taken.iter().any(|other| other.eq_ignore_ascii_case(alias)) {
                    return Err(format!("the alias `{alias}` is already used"));
                }
                alias.to_owned()
            }
            None => propose_alias(&theirs.name, &taken),
        };
        manifest.references.push(ReferenceEntry {
            alias: alias.clone(),
            project_id: theirs.project_id.clone(),
            path: relative_path(root, &provider)?,
            api: read_api(&provider, &theirs),
        });
        Ok(alias)
    })
}

fn reference_mut<'a>(
    manifest: &'a mut ProjectManifest,
    alias: &str,
) -> Result<&'a mut ReferenceEntry, String> {
    manifest
        .references
        .iter_mut()
        .find(|reference| reference.alias == alias)
        .ok_or_else(|| format!("the project has no reference `{alias}`"))
}

/// relocks a reference's API to the provider's current exports.
pub fn update_reference(root: &Path, alias: &str) -> Result<ProjectManifest, String> {
    locked(root, |root, manifest| {
        let reference = reference_mut(manifest, alias)?;
        let provider = std::fs::canonicalize(root.join(&reference.path))
            .map_err(|_| format!("the project folder `{}` was not found", reference.path))?;
        let theirs = read_manifest(&provider)?;
        if theirs.project_id != reference.project_id {
            return Err(format!(
                "`{}` holds another project ({}) than the one referenced",
                reference.path, theirs.name
            ));
        }
        reference.api = read_api(&provider, &theirs);
        Ok(())
    })
    .map(|(manifest, ())| manifest)
}

/// removes a reference.
pub fn remove_reference(root: &Path, alias: &str) -> Result<ProjectManifest, String> {
    locked(root, |_, manifest| {
        let before = manifest.references.len();
        manifest
            .references
            .retain(|reference| reference.alias != alias);
        if manifest.references.len() == before {
            return Err(format!("the project has no reference `{alias}`"));
        }
        Ok(())
    })
    .map(|(manifest, ())| manifest)
}

/// renames a reference's alias.
pub fn rename_reference(
    root: &Path,
    alias: &str,
    new_alias: &str,
) -> Result<ProjectManifest, String> {
    locked(root, |_, manifest| {
        if !crate::project_manifest::is_alias(new_alias) {
            return Err(format!(
                "`{new_alias}` is not a valid alias: use a letter followed by letters or digits"
            ));
        }
        if manifest.references.iter().any(|reference| {
            reference.alias != alias && reference.alias.eq_ignore_ascii_case(new_alias)
        }) {
            return Err(format!("the alias `{new_alias}` is already used"));
        }
        reference_mut(manifest, alias)?.alias = new_alias.to_owned();
        Ok(())
    })
    .map(|(manifest, ())| manifest)
}
