//! Recoverable, cooperative project relocations. This journal protects against process crashes,
//! not arbitrary power loss. External edits are checked before rollback.
use crate::document_archive::new_document_id;
use crate::project::{DocumentId, DocumentRegion};
use crate::project_directory::MANIFEST_FILE;
use crate::project_manifest::{validate_portable_path, WorksheetEntry};
use crate::project_tree::{
    existing, folder_path, join, list_tree, protected, read_manifest, tree_worksheets, within,
};
use crate::worksheet_file::parse_document;
use crate::worksheet_writer::write_bytes_atomic;
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    rc::{Rc, Weak},
    time::{Duration, Instant},
};

const JOURNAL: &str = ".equavela-relocation";
thread_local! { static LOCKS: RefCell<BTreeMap<PathBuf, Weak<File>>> = const { RefCell::new(BTreeMap::new()) }; }

// Lock names are stable for a canonical root across cooperating same-user processes. The
// private directory protects the identity file from other users, not from the same user.
fn lock_identity(root: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        root.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        root.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect()
    }
    #[cfg(not(any(unix, windows)))]
    {
        root.to_string_lossy().as_bytes().to_vec()
    }
}
fn lock_name(identity: &[u8]) -> String {
    fn hash(bytes: impl Iterator<Item = u8>, seed: u64) -> u64 {
        bytes.fold(seed, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3))
    }
    format!(
        "{:016x}{:016x}.lock",
        hash(identity.iter().copied(), 0xcbf29ce484222325),
        hash(identity.iter().rev().copied(), 0x84222325cbf29ce4)
    )
}
#[cfg(target_os = "linux")]
fn lock_directory() -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let uid = rustix::process::geteuid().as_raw();
    let path = std::env::temp_dir().join(format!("equavela-project-locks-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(err(&path, e)),
    }
    let meta = fs::symlink_metadata(&path).map_err(|e| err(&path, e))?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700 {
        return Err(format!(
            "{} must be a user-owned private directory (0700)",
            path.display()
        ));
    }
    Ok(path)
}
#[cfg(windows)]
fn lock_directory() -> Result<PathBuf, String> {
    use std::os::windows::fs::MetadataExt;
    let base = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let mut path = base;
    // The OS-managed LOCALAPPDATA root may itself be a reparse point (redirected profiles,
    // OneDrive or VM junctions); check that it resolves to a directory, and enforce the
    // non-reparse-point invariant on the app-owned subdirectories below it.
    let meta = fs::metadata(&path).map_err(|e| err(&path, e))?;
    if !meta.is_dir() {
        return Err(format!(
            "{} is not a regular lock directory",
            path.display()
        ));
    }
    for component in ["Equavela", "project-locks"] {
        path.push(component);
        match fs::create_dir(&path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(err(&path, e)),
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| err(&path, e))?;
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "{} is not a regular lock directory",
                path.display()
            ));
        }
    }
    Ok(path)
}
#[cfg(not(any(target_os = "linux", windows)))]
fn lock_directory() -> Result<PathBuf, String> {
    Err("project locks are not supported on this platform".into())
}

/// Synchronous, same-thread reentrant lock. It is deliberately not Send.
pub struct ProjectGuard {
    _file: Rc<File>,
}
impl ProjectGuard {
    pub fn acquire(root: &Path) -> Result<Self, String> {
        let root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
        LOCKS.with(|locks| {
            let mut locks = locks.borrow_mut();
            if let Some(file) = locks.get(&root).and_then(Weak::upgrade) {
                return Ok(Self { _file: file });
            }
            let identity = lock_identity(&root);
            let path = lock_directory()?.join(lock_name(&identity));
            if let Ok(meta) = fs::symlink_metadata(&path) {
                if !meta.is_file() {
                    return Err(format!("invalid project lock {}", path.display()));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(format!("invalid project lock {}", path.display()));
                    }
                }
            }
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&path)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            // A just-finished project operation can briefly retain its file handle.
            // Retry only lock contention; real I/O errors must be returned immediately.
            let deadline = Instant::now() + Duration::from_millis(80);
            loop {
                match file.try_lock() {
                    Ok(()) => break,
                    Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(std::fs::TryLockError::WouldBlock) => {
                        return Err(format!("project is busy ({})", root.display()));
                    }
                    Err(std::fs::TryLockError::Error(error)) => {
                        return Err(format!("{}: {error}", path.display()));
                    }
                }
            }
            let mut existing = Vec::new();
            file.read_to_end(&mut existing).map_err(|e| err(&path, e))?;
            if existing.is_empty() {
                file.write_all(&identity)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| err(&path, e))?;
            } else if existing != identity {
                return Err(format!(
                    "project lock identity collision at {}",
                    path.display()
                ));
            }
            let file = Rc::new(file);
            locks.retain(|_, weak| weak.strong_count() > 0);
            locks.insert(root.clone(), Rc::downgrade(&file));
            let guard = Self { _file: file };
            recover(&root)?;
            Ok(guard)
        })
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Sheet {
    old: String,
    new: String,
    before: Vec<u8>,
    after: Vec<u8>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Move {
    from: String,
    to: String,
    fingerprint: BTreeMap<String, String>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    version: u32,
    committed: bool,
    moves: Vec<Move>,
    sheets: Vec<Sheet>,
    manifest_before: Vec<u8>,
    manifest_after: Vec<u8>,
}

/// A preflighted transaction; the lock remains held while the host checks open worksheets.
pub struct RelocationPlan {
    pub destinations: BTreeMap<String, String>,
    pub affected_worksheets: BTreeMap<String, String>,
    root: PathBuf,
    journal: Journal,
    inputs: Vec<(String, Vec<u8>)>,
    _guard: ProjectGuard,
}

fn err(path: &Path, error: impl std::fmt::Display) -> String {
    format!("{}: {error}", path.display())
}
fn safe_path(path: &str) -> Result<(), String> {
    validate_portable_path("path", path).map_err(|e| e.to_string())?;
    if crate::project_tree::internal_path(path) {
        return Err(format!("invalid transaction path `{path}`"));
    }
    Ok(())
}
pub(crate) fn no_links(root: &Path, path: &str) -> Result<(), String> {
    let mut p = root.to_path_buf();
    for c in path.split('/') {
        p.push(c);
        match fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("{} is a symbolic link", p.display()))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(err(&p, e)),
        }
    }
    Ok(())
}
pub(crate) fn check_path(root: &Path, path: &str) -> Result<(), String> {
    safe_path(path)?;
    no_links(root, path)
}
fn mapped(path: &str, moves: &[Move]) -> String {
    moves.iter().find(|m| within(path, &m.from)).map_or_else(
        || path.to_owned(),
        |m| format!("{}{}", m.to, &path[m.from.len()..]),
    )
}
const MAX_FINGERPRINT_DEPTH: usize = 64;

fn is_reparse_point(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

fn fingerprint(path: &Path) -> Result<BTreeMap<String, String>, String> {
    fn walk(
        path: &Path,
        rel: &str,
        depth: usize,
        out: &mut BTreeMap<String, String>,
    ) -> Result<(), String> {
        if depth > MAX_FINGERPRINT_DEPTH {
            return Err(format!("{} exceeds maximum folder depth", path.display()));
        }
        let meta = fs::symlink_metadata(path).map_err(|e| err(path, e))?;
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(format!("{} contains a symbolic link", path.display()));
        }
        if meta.is_dir() {
            out.insert(rel.to_owned(), "dir".into());
            for entry in fs::read_dir(path).map_err(|e| err(path, e))? {
                let entry = entry.map_err(|e| err(path, e))?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| format!("{} contains a non-UTF-8 name", path.display()))?;
                let child = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                walk(&entry.path(), &child, depth + 1, out)?;
            }
        } else if meta.is_file() {
            let mut file = File::open(path).map_err(|e| err(path, e))?;
            let mut hash = 0xcbf29ce484222325u64;
            let mut buf = [0u8; 65536];
            let mut len = 0u64;
            loop {
                let n = file.read(&mut buf).map_err(|e| err(path, e))?;
                if n == 0 {
                    break;
                }
                len += n as u64;
                for b in &buf[..n] {
                    hash ^= u64::from(*b);
                    hash = hash.wrapping_mul(0x100000001b3);
                }
            }
            out.insert(rel.to_owned(), format!("{len}:{hash:016x}"));
        } else {
            return Err(format!(
                "{} is not a regular file or folder",
                path.display()
            ));
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(path, "", 0, &mut out)?;
    Ok(out)
}
fn bytes_fingerprint(bytes: &[u8]) -> String {
    format!(
        "{}:{}",
        bytes.len(),
        crate::project_tree::file_version(bytes)
    )
}
fn fingerprint_matches(root: &Path, m: &Move, at: &str, sheets: &[Sheet]) -> Result<bool, String> {
    let actual = fingerprint(&root.join(at))?;
    if actual.len() != m.fingerprint.len() {
        return Ok(false);
    }
    for (rel, expected) in &m.fingerprint {
        let Some(value) = actual.get(rel) else {
            return Ok(false);
        };
        if value == expected {
            continue;
        }
        let old = if rel.is_empty() {
            m.from.clone()
        } else {
            format!("{}/{rel}", m.from)
        };
        if !sheets
            .iter()
            .any(|s| s.old == old && *value == bytes_fingerprint(&s.after))
        {
            return Ok(false);
        }
    }
    Ok(true)
}
fn rename_new(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        rustix::fs::renameat_with(
            rustix::fs::CWD,
            from,
            rustix::fs::CWD,
            to,
            rustix::fs::RenameFlags::NOREPLACE,
        )
        .map_err(|e| err(to, e))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(a.as_ptr(), b.as_ptr(), 0)
        } == 0
        {
            Err(err(to, std::io::Error::last_os_error()))
        } else {
            Ok(())
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = from;
        Err(err(to, "no safe directory rename on this platform"))
    }
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_bytes_atomic(path, bytes).map_err(|e| e.to_string())
}
fn save_journal(root: &Path, journal: &Journal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|e| e.to_string())?;
    write_atomic(&root.join(JOURNAL), &bytes)
}
fn verify_journal(root: &Path, j: &Journal) -> Result<Vec<bool>, String> {
    if j.version != 1 {
        return Err("unknown relocation journal version".into());
    }
    let mut positions = Vec::new();
    let mut names = BTreeSet::new();
    for m in &j.moves {
        safe_path(&m.from)?;
        safe_path(&m.to)?;
        no_links(root, &m.from)?;
        no_links(root, &m.to)?;
        if within(&m.to, &m.from)
            || !names.insert(m.from.to_lowercase())
            || !names.insert(m.to.to_lowercase())
        {
            return Err("invalid relocation journal paths".into());
        }
        let from = root.join(&m.from).exists();
        let to = root.join(&m.to).exists();
        if from == to {
            return Err(format!(
                "relocation recovery conflict: expected exactly one of `{}` and `{}`",
                m.from, m.to
            ));
        }
        if !fingerprint_matches(root, m, if from { &m.from } else { &m.to }, &j.sheets)? {
            return Err(format!(
                "relocation recovery conflict: `{}` changed externally",
                if from { &m.from } else { &m.to }
            ));
        }
        positions.push(to);
    }
    for s in &j.sheets {
        safe_path(&s.old)?;
        safe_path(&s.new)?;
        if mapped(&s.old, &j.moves) != s.new {
            return Err("invalid worksheet path in relocation journal".into());
        }
        let path = if let Some((i, _)) = j
            .moves
            .iter()
            .enumerate()
            .find(|(_, m)| within(&s.old, &m.from))
        {
            if positions[i] {
                &s.new
            } else {
                &s.old
            }
        } else {
            &s.old
        };
        no_links(root, path)?;
        let bytes = fs::read(root.join(path)).map_err(|e| err(&root.join(path), e))?;
        if bytes != s.before && bytes != s.after {
            return Err(format!(
                "relocation recovery conflict: `{path}` changed externally"
            ));
        }
    }
    let path = root.join(MANIFEST_FILE);
    if fs::symlink_metadata(&path)
        .map_err(|e| err(&path, e))?
        .file_type()
        .is_symlink()
    {
        return Err("relocation recovery conflict: project manifest is a symbolic link".into());
    }
    let bytes = fs::read(&path).map_err(|e| err(&path, e))?;
    if bytes != j.manifest_before && bytes != j.manifest_after {
        return Err("relocation recovery conflict: project manifest changed externally".into());
    }
    Ok(positions)
}
/// Recover only while holding ProjectGuard; leave the journal intact on conflict.
pub(crate) fn recover(root: &Path) -> Result<(), String> {
    let path = root.join(JOURNAL);
    let meta = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(&path, e)),
    };
    if !meta.is_file() {
        return Err(format!("invalid relocation journal {}", path.display()));
    }
    let bytes = fs::read(&path).map_err(|e| err(&path, e))?;
    let j: Journal = serde_json::from_slice(&bytes)
        .map_err(|e| format!("invalid relocation journal {}: {e}", path.display()))?;
    if !j.committed {
        let positions = verify_journal(root, &j)?;
        for s in &j.sheets {
            let target = if let Some((i, _)) = j
                .moves
                .iter()
                .enumerate()
                .find(|(_, m)| within(&s.old, &m.from))
            {
                if positions[i] {
                    &s.new
                } else {
                    &s.old
                }
            } else {
                &s.old
            };
            write_atomic(&root.join(target), &s.before)?;
        }
        for (m, moved) in j.moves.iter().zip(positions).rev() {
            if moved {
                rename_new(&root.join(&m.to), &root.join(&m.from))?;
            }
        }
        write_atomic(&root.join(MANIFEST_FILE), &j.manifest_before)?;
    }
    fs::remove_file(&path).map_err(|e| err(&path, e))
}

pub fn plan_rename_item(root: &Path, path: &str, name: &str) -> Result<RelocationPlan, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err("enter a name without folder separators".into());
    }
    let folder = path.rsplit_once('/').map_or("", |(f, _)| f);
    plan(root, vec![(path.to_owned(), join(folder, name))])
}
pub fn plan_move_items(
    root: &Path,
    paths: &[String],
    folder: &str,
) -> Result<RelocationPlan, String> {
    let items = paths
        .iter()
        .map(|p| (p.clone(), join(folder, p.rsplit('/').next().unwrap_or(p))))
        .collect();
    plan(root, items)
}
fn plan(root: &Path, mut items: Vec<(String, String)>) -> Result<RelocationPlan, String> {
    let root = fs::canonicalize(root).map_err(|e| err(root, e))?;
    let guard = ProjectGuard::acquire(&root)?;
    let manifest_path = root.join(MANIFEST_FILE);
    if fs::symlink_metadata(&manifest_path)
        .map_err(|e| err(&manifest_path, e))?
        .file_type()
        .is_symlink()
    {
        return Err("project manifest is a symbolic link".into());
    }
    let manifest_before = fs::read(&manifest_path).map_err(|e| err(&manifest_path, e))?;
    let mut manifest = read_manifest(&root)?;
    items.sort_by(|a, b| a.0.cmp(&b.0));
    items.dedup_by(|a, b| a.0 == b.0);
    let selected: Vec<_> = items.iter().map(|p| p.0.clone()).collect();
    items.retain(|(p, _)| {
        !selected
            .iter()
            .any(|parent| parent != p && within(p, parent))
    });
    let mut destinations = BTreeMap::new();
    let mut moves = Vec::new();
    let mut taken = BTreeSet::new();
    for (from, to) in items {
        safe_path(&from)?;
        safe_path(&to)?;
        no_links(&root, &from)?;
        no_links(&root, &to)?;
        existing(&root, &from)?;
        if protected(&manifest, &from) {
            return Err(format!(
                "`{from}` is the project's Julia environment and cannot be renamed or moved"
            ));
        }
        let parent = to.rsplit_once('/').map_or("", |(p, _)| p);
        folder_path(&root, parent)?;
        destinations.insert(from.clone(), to.clone());
        if from == to {
            continue;
        }
        if from.eq_ignore_ascii_case(&to) {
            return Err("case-only renames are not supported by recoverable relocation".into());
        }
        if within(&to, &from) {
            return Err(format!("`{from}` cannot move into itself"));
        }
        if !taken.insert(to.to_lowercase()) || fs::symlink_metadata(root.join(&to)).is_ok() {
            return Err(format!("`{to}` already exists"));
        }
        moves.push(Move {
            fingerprint: fingerprint(&root.join(&from))?,
            from,
            to,
        });
    }
    let paths = tree_worksheets(&list_tree(&root)?, manifest.environment.as_deref());
    let mut inputs = Vec::new();
    let mut sheets = Vec::new();
    let mut affected = BTreeMap::new();
    for path in &paths {
        no_links(&root, path)?;
        let bytes = fs::read(root.join(path)).map_err(|e| err(&root.join(path), e))?;
        let text = std::str::from_utf8(&bytes).map_err(|e| err(&root.join(path), e))?;
        let id = DocumentId::new(path).map_err(|e| e.to_string())?;
        let mut document = parse_document(id, text)
            .map_err(|e| e.to_string())?
            .document;
        for region in &document.regions {
            if let DocumentRegion::Include(include) = region.as_ref() {
                let normalized = include.path.replace('\\', "/");
                if normalized.starts_with('/') || normalized.get(1..2) == Some(":") {
                    continue;
                }
                let before = DocumentId::new(path)
                    .and_then(|id| id.resolve(&include.path))
                    .map_err(|e| e.to_string())?;
                let after = DocumentId::new(&mapped(path, &moves))
                    .and_then(|id| id.resolve(&include.path))
                    .map_err(|e| e.to_string())?;
                if after.as_str() != mapped(before.as_str(), &moves) {
                    return Err(format!(
                        "`{path}` includes `{}`: this change would break that include",
                        include.path
                    ));
                }
            }
        }
        let mut changed = false;
        for asset in document.assets.values_mut() {
            let target = mapped(&asset.path, &moves);
            if target != asset.path {
                asset.path = target;
                crate::image::validate_asset(asset)?;
                changed = true;
            }
        }
        let new = mapped(path, &moves);
        if manifest
            .environment
            .as_deref()
            .is_some_and(|env| within(&new, env))
        {
            return Err(format!(
                "`{path}` cannot be moved into the project environment"
            ));
        }
        let after = if changed {
            // The normal Save writer drops unused resources. A relocation must retain even
            // unused modeled assets, so edit the resource paths in the parsed YAML instead.
            let mut raw: serde_json::Value =
                serde_saphyr::from_str(text).map_err(|e| e.to_string())?;
            let resources = raw
                .get_mut("resources")
                .and_then(|v| v.as_object_mut())
                .ok_or_else(|| format!("`{path}` has no resource mapping"))?;
            for (id, asset) in &document.assets {
                let value = resources
                    .get_mut(id)
                    .and_then(|v| v.as_object_mut())
                    .ok_or_else(|| format!("`{path}` has no asset `{id}`"))?;
                value.insert(
                    "asset".into(),
                    serde_json::Value::String(asset.path.clone()),
                );
            }
            let result = serde_saphyr::to_string(&raw).map_err(|e| e.to_string())?;
            let mut parsed =
                parse_document(DocumentId::new(path).map_err(|e| e.to_string())?, &result)
                    .map_err(|e| e.to_string())?;
            parsed
                .document
                .content_hash
                .clone_from(&document.content_hash);
            if parsed.document != document {
                return Err(format!("rewriting `{path}` would change worksheet content"));
            }
            result.into_bytes()
        } else {
            bytes.clone()
        };
        if new != *path || changed {
            affected.insert(path.clone(), new.clone());
            sheets.push(Sheet {
                old: path.clone(),
                new,
                before: bytes.clone(),
                after,
            });
        }
        inputs.push((path.clone(), bytes));
    }
    if paths.is_empty() {
        return Err("the project has no worksheet (.eqv file) left".into());
    }
    let ids: BTreeMap<_, _> = manifest
        .worksheets
        .iter()
        .map(|s| (s.path.to_lowercase(), s.id.clone()))
        .collect();
    manifest.worksheets = paths
        .iter()
        .map(|p| WorksheetEntry {
            id: ids
                .get(&p.to_lowercase())
                .cloned()
                .unwrap_or_else(new_document_id),
            path: mapped(p, &moves),
        })
        .collect();
    manifest.worksheets.sort_by(|a, b| a.path.cmp(&b.path));
    // a loaded Julia module stays loaded under its new path.
    for module in &mut manifest.julia_modules {
        *module = mapped(module, &moves);
    }
    let manifest_after = manifest.to_yaml().map_err(|e| e.to_string())?.into_bytes();
    Ok(RelocationPlan {
        destinations,
        affected_worksheets: affected,
        root,
        journal: Journal {
            version: 1,
            committed: false,
            moves,
            sheets,
            manifest_before,
            manifest_after,
        },
        inputs,
        _guard: guard,
    })
}
pub fn execute_relocation(mut plan: RelocationPlan) -> Result<BTreeMap<String, String>, String> {
    let root = &plan.root;
    let j = &mut plan.journal;
    if j.moves.is_empty() {
        return Ok(BTreeMap::new());
    }
    if fs::read(root.join(MANIFEST_FILE)).map_err(|e| err(&root.join(MANIFEST_FILE), e))?
        != j.manifest_before
    {
        return Err("project changed since relocation was planned".into());
    }
    let manifest = read_manifest(root)?;
    let current_paths = tree_worksheets(&list_tree(root)?, manifest.environment.as_deref());
    if current_paths
        != plan
            .inputs
            .iter()
            .map(|(p, _)| p.clone())
            .collect::<Vec<_>>()
    {
        return Err("worksheet tree changed since relocation was planned".into());
    }
    for (path, bytes) in &plan.inputs {
        if fs::read(root.join(path)).map_err(|e| err(&root.join(path), e))? != *bytes {
            return Err(format!("`{path}` changed since relocation was planned"));
        }
    }
    for m in &j.moves {
        if fs::symlink_metadata(root.join(&m.to)).is_ok()
            || fingerprint(&root.join(&m.from))? != m.fingerprint
        {
            return Err(format!("`{}` changed since relocation was planned", m.from));
        }
    }
    save_journal(root, j)?;
    let result = (|| {
        for m in &j.moves {
            rename_new(&root.join(&m.from), &root.join(&m.to))?;
        }
        for s in &j.sheets {
            if s.before != s.after {
                write_atomic(&root.join(&s.new), &s.after)?;
            }
        }
        write_atomic(&root.join(MANIFEST_FILE), &j.manifest_after)?;
        j.committed = true;
        save_journal(root, j)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        return match recover(root) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}; rollback failed, retain journal: {rollback}"
            )),
        };
    }
    // A committed journal is cleanup-only. Failure to remove it must not report a
    // committed operation as failed; the next project lock retries cleanup.
    let _ = recover(root);
    Ok(plan.affected_worksheets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_directory::{create_project, load_project_directory};
    use crate::project_manifest::{ProjectManifest, PROJECT_FORMAT};
    use tempfile::TempDir;

    const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const EMPTY: &str = "format: equavela-worksheet/3\nregions: []\n";
    const IMAGE: &str = "format: equavela-worksheet/3\nresources:\n  logo:\n    media: svg\n    asset: assets/images/logo.svg\nregions: []\n";
    fn project() -> (TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        let manifest = ProjectManifest {
            format: PROJECT_FORMAT.into(),
            project_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd".into(),
            name: "P".into(),
            worksheets: vec![WorksheetEntry {
                id: ID.into(),
                path: "worksheets/main.eqv".into(),
            }],
            main_worksheet: None,
            environment: None,
            exports: Vec::new(),
            references: Vec::new(),
            julia_modules: Vec::new(),
        };
        create_project(
            &root,
            &manifest,
            &BTreeMap::from([(ID.into(), IMAGE.into())]),
        )
        .unwrap();
        fs::create_dir_all(root.join("assets/images")).unwrap();
        fs::write(root.join("assets/images/logo.svg"), b"image").unwrap();
        (temp, root)
    }
    #[test]
    fn asset_rename_updates_shared_unindexed_owners_and_keeps_ids() {
        let (_temp, root) = project();
        fs::write(root.join("other.eqv"), IMAGE).unwrap();
        let p = plan_rename_item(&root, "assets/images/logo.svg", "new.svg").unwrap();
        assert_eq!(p.affected_worksheets.len(), 2);
        assert_eq!(p.affected_worksheets["other.eqv"], "other.eqv");
        execute_relocation(p).unwrap();
        for path in ["other.eqv", "worksheets/main.eqv"] {
            assert!(fs::read_to_string(root.join(path))
                .unwrap()
                .contains("assets/images/new.svg"));
        }
        let manifest = read_manifest(&root).unwrap();
        assert_eq!(manifest.worksheets.len(), 2);
        assert!(root.join("assets/images/new.svg").exists());
    }
    #[test]
    fn bulk_moves_preflight_collisions_and_keep_combined_includes() {
        let (_temp, root) = project();
        fs::create_dir(root.join("lib")).unwrap();
        fs::write(root.join("lib/units.eqv"), EMPTY).unwrap();
        fs::write(root.join("worksheets/main.eqv"),"format: equavela-worksheet/3\nregions:\n  - id: i\n    at: [0, 0]\n    include: ../lib/units.eqv\n").unwrap();
        fs::create_dir(root.join("target")).unwrap();
        let paths = vec!["lib".into(), "worksheets".into(), "lib/units.eqv".into()];
        let p = plan_move_items(&root, &paths, "target").unwrap();
        assert_eq!(p.destinations.len(), 2);
        execute_relocation(p).unwrap();
        assert!(root.join("target/worksheets/main.eqv").exists());
        let (_temp, root) = project();
        fs::create_dir(root.join("dest")).unwrap();
        fs::create_dir(root.join("dest/worksheets")).unwrap();
        assert!(plan_move_items(&root, &["worksheets".into(), "assets".into()], "dest").is_err());
        assert!(root.join("worksheets/main.eqv").exists());
        assert!(root.join("assets/images/logo.svg").exists());
    }
    #[test]
    fn asset_folder_and_owner_move_together_and_invalid_asset_target_is_refused() {
        let (_temp, root) = project();
        fs::create_dir(root.join("assets/group")).unwrap();
        fs::write(root.join("assets/group/owner.eqv"), IMAGE).unwrap();
        fs::create_dir(root.join("assets/target")).unwrap();
        let p = plan_move_items(
            &root,
            &["assets/images".into(), "assets/group".into()],
            "assets/target",
        )
        .unwrap();
        execute_relocation(p).unwrap();
        assert!(
            fs::read_to_string(root.join("assets/target/group/owner.eqv"))
                .unwrap()
                .contains("assets/target/images/logo.svg")
        );
        assert!(plan_move_items(&root, &["assets/target/images".into()], "").is_err());
    }
    #[test]
    fn stale_sources_parse_failure_and_noop_are_safe() {
        let (_temp, root) = project();
        let p = plan_rename_item(&root, "assets/images/logo.svg", "new.svg").unwrap();
        fs::write(root.join("worksheets/main.eqv"), EMPTY).unwrap();
        assert!(execute_relocation(p).unwrap_err().contains("changed"));
        assert!(root.join("assets/images/logo.svg").exists());
        fs::write(root.join("broken.eqv"), "bad: [").unwrap();
        assert!(plan_rename_item(&root, "assets/images/logo.svg", "new.svg").is_err());
        fs::remove_file(root.join("broken.eqv")).unwrap();
        let p = plan_rename_item(&root, "assets/images/logo.svg", "logo.svg").unwrap();
        assert!(execute_relocation(p).unwrap().is_empty());
    }
    #[test]
    fn prepared_move_recovers_on_load_and_preserves_manifest_id() {
        let (_temp, root) = project();
        let p = plan_rename_item(&root, "worksheets/main.eqv", "renamed.eqv").unwrap();
        save_journal(&root, &p.journal).unwrap();
        rename_new(
            &root.join("worksheets/main.eqv"),
            &root.join("worksheets/renamed.eqv"),
        )
        .unwrap();
        drop(p);
        assert!(load_project_directory(&root).is_ok());
        assert!(root.join("worksheets/main.eqv").exists());
        assert!(!root.join(JOURNAL).exists());
    }
    #[test]
    fn recovery_refuses_external_folder_edit_without_overwriting() {
        let (_temp, root) = project();
        let p = plan_rename_item(&root, "assets/images", "pictures").unwrap();
        save_journal(&root, &p.journal).unwrap();
        rename_new(&root.join("assets/images"), &root.join("assets/pictures")).unwrap();
        drop(p);
        fs::write(root.join("assets/pictures/logo.svg"), "external").unwrap();
        let e = load_project_directory(&root).unwrap_err().to_string();
        assert!(e.contains("conflict"), "{e}");
        assert_eq!(
            fs::read(root.join("assets/pictures/logo.svg")).unwrap(),
            b"external"
        );
        assert!(root.join(JOURNAL).exists());
    }
    #[test]
    fn partially_rewritten_prepared_transaction_restores_all_originals() {
        let (_temp, root) = project();
        fs::write(root.join("other.eqv"), IMAGE).unwrap();
        let before = fs::read(root.join(MANIFEST_FILE)).unwrap();
        let p = plan_rename_item(&root, "assets/images/logo.svg", "new.svg").unwrap();
        save_journal(&root, &p.journal).unwrap();
        rename_new(
            &root.join("assets/images/logo.svg"),
            &root.join("assets/images/new.svg"),
        )
        .unwrap();
        let s = &p.journal.sheets[0];
        write_atomic(&root.join(&s.new), &s.after).unwrap();
        drop(p);
        load_project_directory(&root).unwrap();
        assert_eq!(fs::read_to_string(root.join("other.eqv")).unwrap(), IMAGE);
        assert_eq!(
            fs::read_to_string(root.join("worksheets/main.eqv")).unwrap(),
            IMAGE
        );
        assert_eq!(fs::read(root.join(MANIFEST_FILE)).unwrap(), before);
        assert!(root.join("assets/images/logo.svg").exists());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn read_only_project_opens_and_relocation_does_not_mutate() {
        use std::os::unix::fs::PermissionsExt;
        if rustix::process::geteuid().as_raw() == 0 {
            return;
        }
        let (_temp, root) = project();
        let original = fs::metadata(&root).unwrap().permissions();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        assert!(load_project_directory(&root).is_ok());
        let p = plan_rename_item(&root, "assets/images/logo.svg", "new.svg").unwrap();
        assert!(execute_relocation(p).is_err());
        assert!(root.join("assets/images/logo.svg").exists());
        assert!(!root.join("assets/images/new.svg").exists());
        fs::set_permissions(&root, original).unwrap();
    }
    #[test]
    fn lock_identity_collision_is_refused() {
        let (_temp, root) = project();
        let canonical = fs::canonicalize(&root).unwrap();
        let path = lock_directory()
            .unwrap()
            .join(lock_name(&lock_identity(&canonical)));
        fs::write(&path, b"another project").unwrap();
        assert!(ProjectGuard::acquire(&root)
            .err()
            .unwrap()
            .contains("identity collision"));
        fs::remove_file(&path).unwrap();
    }
    #[test]
    fn competing_thread_cannot_acquire_project_lock() {
        let (_temp, root) = project();
        let guard = ProjectGuard::acquire(&root).unwrap();
        let path = root.clone();
        assert!(
            std::thread::spawn(move || ProjectGuard::acquire(&path).err().unwrap())
                .join()
                .unwrap()
                .contains("busy")
        );
        drop(guard);
        ProjectGuard::acquire(&root).unwrap();
    }
    #[test]
    fn briefly_contended_project_lock_is_retried() {
        let (_temp, root) = project();
        let path = root.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = ProjectGuard::acquire(&path).unwrap();
            ready_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(15));
        });
        ready_rx.recv().unwrap();
        let _guard = ProjectGuard::acquire(&root).unwrap();
        worker.join().unwrap();
    }
    #[test]
    fn owner_move_does_not_rebase_asset_and_project_lock_is_reentrant() {
        let (_temp, root) = project();
        fs::create_dir(root.join("other")).unwrap();
        let guard = ProjectGuard::acquire(&root).unwrap();
        let p = plan_move_items(&root, &["worksheets/main.eqv".into()], "other").unwrap();
        execute_relocation(p).unwrap();
        drop(guard);
        assert!(fs::read_to_string(root.join("other/main.eqv"))
            .unwrap()
            .contains("assets/images/logo.svg"));
    }
}
