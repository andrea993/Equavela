//! Persistent snapshots of a Julia environment's metadata around a package operation:
//! saved to disk before Julia changes the files,
//! restored when the operation fails, kept for undoing the last change, and found again after a
//! crash. Only the metadata files are copied; packages, depots and caches are never touched.

use crate::environment::{
    environment_metadata_fingerprint, environment_metadata_snapshot, EnvironmentMetadataSnapshot,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const JOURNAL: &str = "journal.json";
const FILES: &str = "files";

/// Whether the operation a journal describes finished or not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeState {
    Pending,
    Done,
}

/// The journal of the last package operation of one environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeJournal {
    pub directory: PathBuf,
    /// `add`, `remove`, `instantiate`, `resolve`, `update` or `compatibility`.
    pub operation: String,
    pub packages: Vec<String>,
    /// Seconds since the Unix epoch when the operation started.
    pub started: u64,
    pub state: ChangeState,
    /// The metadata files the snapshot holds, by name.
    pub saved: Vec<String>,
    /// The metadata files that were absent.
    pub absent: Vec<String>,
    /// The fingerprint of the metadata the operation left, once it is `Done`.
    pub after: Option<String>,
}

/// Where the snapshots live: `<environments>/.snapshots`.
#[derive(Debug, Clone)]
pub struct SnapshotStore {
    root: PathBuf,
}

fn fnv(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;

/// A short stable fingerprint of metadata files: names, presence and bytes.
fn fingerprint(files: &EnvironmentMetadataSnapshot) -> String {
    let mut hash = FNV_OFFSET;
    for (name, bytes) in files {
        hash = fnv(&(name.len() as u64).to_le_bytes(), hash);
        hash = fnv(name.as_bytes(), hash);
        match bytes {
            Some(bytes) => {
                hash = fnv(&(bytes.len() as u64).to_le_bytes(), hash);
                hash = fnv(bytes, hash);
            }
            None => hash = fnv(&u64::MAX.to_le_bytes(), hash),
        }
    }
    format!("{hash:016x}")
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staged = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&staged)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staged, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

fn describe(path: &Path) -> impl Fn(io::Error) -> String + '_ {
    move |error| format!("{}: {error}", path.display())
}

/// The directory a snapshot is keyed by: canonical, or its canonical parent and its name when
/// it does not exist yet (the shared environment is created on demand), so the key stays the
/// same once it is created.
fn canonical(directory: &Path) -> PathBuf {
    fs::canonicalize(directory).unwrap_or_else(|_| {
        match (directory.parent(), directory.file_name()) {
            (Some(parent), Some(name)) => fs::canonicalize(parent)
                .map(|parent| parent.join(name))
                .unwrap_or_else(|_| directory.to_path_buf()),
            _ => directory.to_path_buf(),
        }
    })
}

impl SnapshotStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The snapshot folder of `directory`: of its path, 16 hex digits.
    pub fn folder(&self, directory: &Path) -> PathBuf {
        let path = canonical(directory);
        let key = fnv(path.to_string_lossy().as_bytes(), FNV_OFFSET);
        self.root.join(format!("{key:016x}"))
    }

    /// The journal of `directory`, if a complete snapshot exists.
    pub fn journal(&self, directory: &Path) -> Result<Option<ChangeJournal>, String> {
        let path = self.folder(directory).join(JOURNAL);
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|error| format!("{}: {error}", path.display())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(describe(&path)(error)),
        }
    }

    fn write_journal(&self, journal: &ChangeJournal) -> Result<(), String> {
        let path = self.folder(&journal.directory).join(JOURNAL);
        let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
        write_atomic(&path, &bytes).map_err(describe(&path))
    }

    /// Saves the metadata of `directory` before `operation` changes it. Refused while a
    /// change of that directory is interrupted, or when the metadata is not valid TOML,
    /// a link or a non-regular file. Replaces an older finished snapshot.
    pub fn begin(
        &self,
        directory: &Path,
        operation: &str,
        packages: &[String],
    ) -> Result<ChangeJournal, String> {
        if let Some(journal) = self.journal(directory)? {
            if journal.state == ChangeState::Pending {
                return Err(format!(
                    "the last change of this environment ({}) was interrupted: restore the previous files or keep the current ones first",
                    journal.operation
                ));
            }
        }
        let files = environment_metadata_snapshot(directory)?;
        let folder = self.folder(directory);
        match fs::remove_dir_all(&folder) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(describe(&folder)(error)),
        }
        let saved_dir = folder.join(FILES);
        fs::create_dir_all(&saved_dir).map_err(describe(&saved_dir))?;
        let mut saved = Vec::new();
        let mut absent = Vec::new();
        for (name, bytes) in &files {
            match bytes {
                Some(bytes) => {
                    let path = saved_dir.join(name);
                    write_atomic(&path, bytes).map_err(describe(&path))?;
                    saved.push(name.clone());
                }
                None => absent.push(name.clone()),
            }
        }
        let journal = ChangeJournal {
            directory: canonical(directory),
            operation: operation.to_owned(),
            packages: packages.to_vec(),
            started: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or_default(),
            state: ChangeState::Pending,
            saved,
            absent,
            after: None,
        };
        // The journal last: it only ever describes a complete snapshot.
        self.write_journal(&journal)?;
        Ok(journal)
    }

    /// Marks the change of `directory` as done and records what it left.
    pub fn finish(&self, directory: &Path) -> Result<(), String> {
        let mut journal = self
            .journal(directory)?
            .ok_or_else(|| "no environment snapshot to finish".to_owned())?;
        journal.state = ChangeState::Done;
        journal.after = Some(fingerprint(&environment_metadata_fingerprint(directory)?));
        self.write_journal(&journal)
    }

    /// The finished change of `directory` that can still be undone: its metadata is what the
    /// operation left.
    pub fn undoable(&self, directory: &Path) -> Option<ChangeJournal> {
        let journal = self.journal(directory).ok()??;
        let current = environment_metadata_fingerprint(directory).ok()?;
        (journal.state == ChangeState::Done
            && journal.after.as_deref() == Some(fingerprint(&current).as_str()))
        .then_some(journal)
    }

    /// The interrupted change of `directory`, if any.
    pub fn interrupted(&self, directory: &Path) -> Option<ChangeJournal> {
        self.journal(directory)
            .ok()
            .flatten()
            .filter(|journal| journal.state == ChangeState::Pending)
    }

    /// Puts the metadata of `directory` back as the snapshot saved it and deletes the snapshot
    ///: saved files get their bytes back, every other metadata file is removed. On an
    /// error the snapshot is kept, so the change shows as interrupted.
    pub fn restore(&self, directory: &Path) -> Result<(), String> {
        let journal = self
            .journal(directory)?
            .ok_or_else(|| "no environment snapshot to restore".to_owned())?;
        let saved_dir = self.folder(directory).join(FILES);
        fs::create_dir_all(directory).map_err(describe(directory))?;
        for name in &journal.saved {
            let source = saved_dir.join(name);
            let bytes = fs::read(&source).map_err(describe(&source))?;
            let target = directory.join(name);
            write_atomic(&target, &bytes).map_err(describe(&target))?;
        }
        for (name, _) in environment_metadata_fingerprint(directory)? {
            if journal.saved.contains(&name) {
                continue;
            }
            let path = directory.join(&name);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(describe(&path)(error)),
            }
        }
        self.discard(directory)
    }

    /// Deletes the snapshot of `directory`.
    pub fn discard(&self, directory: &Path) -> Result<(), String> {
        let folder = self.folder(directory);
        match fs::remove_dir_all(&folder) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(describe(&folder)(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const PROJECT: &str = "[deps]\nA = \"7876af07-990d-54b4-ab0e-23690620f79a\"\n";
    const MANIFEST: &str = "manifest_format = \"2.0\"\n";

    fn setup() -> (tempfile::TempDir, PathBuf, SnapshotStore) {
        let temp = tempdir().unwrap();
        let env = temp.path().join("env");
        fs::create_dir(&env).unwrap();
        fs::write(env.join("Project.toml"), PROJECT).unwrap();
        let store = SnapshotStore::new(temp.path().join(".snapshots"));
        (temp, env, store)
    }

    #[test]
    fn a_failed_change_is_restored_exactly_and_leaves_no_snapshot() {
        let (_temp, env, store) = setup();
        let journal = store.begin(&env, "add", &["B".into()]).unwrap();
        assert_eq!(journal.state, ChangeState::Pending);
        assert_eq!(journal.saved, ["Project.toml"]);
        assert!(journal.absent.contains(&"Manifest.toml".to_owned()));
        // What Pkg might leave behind halfway.
        fs::write(env.join("Project.toml"), "[deps]\n").unwrap();
        fs::write(env.join("Manifest.toml"), MANIFEST).unwrap();
        fs::write(env.join("Manifest-v1.11.toml"), MANIFEST).unwrap();
        fs::write(env.join("LocalPreferences.toml"), "x = 1\n").unwrap();
        store.restore(&env).unwrap();
        assert_eq!(
            fs::read_to_string(env.join("Project.toml")).unwrap(),
            PROJECT
        );
        assert!(!env.join("Manifest.toml").exists());
        assert!(!env.join("Manifest-v1.11.toml").exists());
        assert!(env.join("LocalPreferences.toml").exists(), "not metadata");
        assert_eq!(store.journal(&env).unwrap(), None);
        assert!(!store.folder(&env).exists());
    }

    #[test]
    fn the_last_finished_change_is_undoable_while_the_files_are_unchanged() {
        let (_temp, env, store) = setup();
        store.begin(&env, "add", &["B".into()]).unwrap();
        fs::write(env.join("Manifest.toml"), MANIFEST).unwrap();
        store.finish(&env).unwrap();
        let undoable = store.undoable(&env).unwrap();
        assert_eq!(
            (undoable.operation.as_str(), undoable.packages.as_slice()),
            ("add", &["B".to_owned()][..])
        );
        assert_eq!(store.interrupted(&env), None);
        store.restore(&env).unwrap();
        assert!(!env.join("Manifest.toml").exists());
        assert_eq!(store.undoable(&env), None);

        // Changed by someone else afterwards: no longer offered.
        store.begin(&env, "resolve", &[]).unwrap();
        store.finish(&env).unwrap();
        fs::write(env.join("Project.toml"), "[deps]\n").unwrap();
        assert_eq!(store.undoable(&env), None);
    }

    #[test]
    fn an_interrupted_change_blocks_new_ones_until_restored_or_kept() {
        let (_temp, env, store) = setup();
        store.begin(&env, "update", &[]).unwrap();
        // A new store, as after a restart, still sees it.
        let again = SnapshotStore::new(store.root.clone());
        let interrupted = again.interrupted(&env).unwrap();
        assert_eq!(interrupted.operation, "update");
        let error = again.begin(&env, "add", &["C".into()]).unwrap_err();
        assert!(error.contains("interrupted"), "{error}");
        fs::write(env.join("Project.toml"), "[deps]\n").unwrap();
        again.discard(&env).unwrap();
        assert_eq!(
            fs::read_to_string(env.join("Project.toml")).unwrap(),
            "[deps]\n"
        );
        again.begin(&env, "add", &["C".into()]).unwrap();
    }

    #[test]
    fn invalid_metadata_refuses_before_anything_is_written() {
        let (_temp, env, store) = setup();
        fs::write(env.join("Manifest.toml"), "[deps\n").unwrap();
        assert!(store.begin(&env, "resolve", &[]).is_err());
        assert!(!store.folder(&env).exists());
    }

    #[test]
    fn a_missing_shared_environment_keeps_its_key_and_restores_to_nothing() {
        let temp = tempdir().unwrap();
        let env = temp.path().join("standalone");
        let store = SnapshotStore::new(temp.path().join(".snapshots"));
        let before = store.folder(&env);
        store.begin(&env, "add", &["A".into()]).unwrap();
        fs::create_dir(&env).unwrap();
        fs::write(env.join("Project.toml"), PROJECT).unwrap();
        assert_eq!(store.folder(&env), before);
        assert!(store.interrupted(&env).is_some());
        store.restore(&env).unwrap();
        assert!(!env.join("Project.toml").exists());
    }
}
