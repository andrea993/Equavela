//! Recoverable host-side trash batches. The caller holds the shared project guard.
use equavela_core::{
    project_manifest::ProjectManifest, project_tree, worksheet_writer::write_file_atomic,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const JOURNAL: &str = ".equavela-trash.json";

#[derive(Serialize, Deserialize)]
struct Journal {
    version: u8,
    root: PathBuf,
    paths: Vec<String>,
    before_ids: BTreeSet<String>,
    manifest: String,
    manifest_after: String,
    stamps: Vec<Vec<Stamp>>,
    committed: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Stamp {
    path: String,
    kind: u8,
    hash: u64,
    size: u64,
}

fn fingerprint(path: &Path) -> Result<Vec<Stamp>, String> {
    fn walk(path: &Path, relative: &str, out: &mut Vec<Stamp>) -> Result<(), String> {
        let metadata =
            fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let (kind, hash, size) = if metadata.file_type().is_symlink() {
            let link = fs::read_link(path).map_err(|e| e.to_string())?;
            (2, hash_bytes(link.as_os_str().as_encoded_bytes()), 0)
        } else if metadata.is_dir() {
            (1, 0, 0)
        } else if metadata.is_file() {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut buffer = [0u8; 65536];
            let mut hash = 0xcbf29ce484222325u64;
            loop {
                let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                for byte in &buffer[..n] {
                    hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
                }
            }
            (0, hash, metadata.len())
        } else {
            return Err(format!("{} is not a regular project item", path.display()));
        };
        out.push(Stamp {
            path: relative.to_owned(),
            kind,
            hash,
            size,
        });
        if kind == 1 {
            let mut children = fs::read_dir(path)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                let name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| "non-UTF-8 name in trash batch")?;
                walk(&child.path(), &format!("{relative}/{name}"), out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(path, "", &mut out)?;
    Ok(out)
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

#[derive(Clone)]
struct Item {
    id: String,
    original: PathBuf,
}

trait Recycle {
    fn list(&self) -> Result<Vec<Item>, String>;
    fn delete(&self, paths: &[PathBuf]) -> Result<(), String>;
    fn restore(&self, ids: &[String]) -> Result<(), String>;
}

fn path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        if let Some(unc) = value.strip_prefix("//?/UNC/") {
            format!("//{unc}").to_lowercase()
        } else {
            value.strip_prefix("//?/").unwrap_or(&value).to_lowercase()
        }
    } else {
        value
    }
}
fn same_path(a: &Path, b: &Path) -> bool {
    path_key(a) == path_key(b)
}
struct Native(PathBuf);
impl Recycle for Native {
    fn list(&self) -> Result<Vec<Item>, String> {
        trash::os_limited::list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|item| {
                path_key(&item.original_path())
                    .starts_with(&format!("{}/", path_key(&self.0).trim_end_matches('/')))
            })
            .map(|item| {
                Ok(Item {
                    id: item
                        .id
                        .to_str()
                        .ok_or("non-UTF-8 trash identifier")?
                        .to_owned(),
                    original: item.original_path(),
                })
            })
            .collect()
    }
    fn delete(&self, paths: &[PathBuf]) -> Result<(), String> {
        trash::delete_all(paths).map_err(|e| e.to_string())
    }
    fn restore(&self, ids: &[String]) -> Result<(), String> {
        let wanted: BTreeSet<_> = ids.iter().map(String::as_str).collect();
        let items: Vec<_> = trash::os_limited::list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|item| item.id.to_str().is_some_and(|id| wanted.contains(id)))
            .collect();
        if items.len() != wanted.len() {
            return Err("a trash entry disappeared before rollback".into());
        }
        trash::os_limited::restore_all(items).map_err(|e| e.to_string())
    }
}

fn write_journal(root: &Path, journal: &Journal) -> Result<(), String> {
    let json = serde_json::to_string(journal).map_err(|e| e.to_string())?;
    write_file_atomic(&root.join(JOURNAL), &json).map_err(|e| e.to_string())
}

fn recover_with(root: &Path, recycle: &impl Recycle) -> Result<(), String> {
    let path = root.join(JOURNAL);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
            return Err("invalid trash transaction journal".into())
        }
        Ok(_) => {}
    }
    let journal: Journal = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if journal.version != 1 || journal.root != root || journal.paths.len() != journal.stamps.len() {
        return Err("trash transaction identity mismatch; journal retained".into());
    }
    ProjectManifest::from_yaml(&journal.manifest).map_err(|e| e.to_string())?;
    ProjectManifest::from_yaml(&journal.manifest_after).map_err(|e| e.to_string())?;
    for entry in &journal.paths {
        equavela_core::project_manifest::validate_portable_path("trash path", entry)
            .map_err(|e| e.to_string())?;
        if entry.split('/').any(|part| part.starts_with('.')) {
            return Err("hidden path in trash journal".into());
        }
    }
    if !journal.committed {
        let current_manifest =
            fs::read_to_string(root.join("equavela-project.yaml")).map_err(|e| e.to_string())?;
        if current_manifest != journal.manifest && current_manifest != journal.manifest_after {
            return Err(
                "project manifest changed outside the trash transaction; journal retained".into(),
            );
        }
        if journal.paths.iter().enumerate().all(|(i, entry)| {
            fingerprint(&root.join(entry)).is_ok_and(|stamps| stamps == journal.stamps[i])
        }) {
            write_file_atomic(&root.join("equavela-project.yaml"), &journal.manifest)
                .map_err(|e| e.to_string())?;
            return fs::remove_file(path).map_err(|e| e.to_string());
        }
        let items = recycle.list()?;
        let mut restore = Vec::new();
        for (i, entry) in journal.paths.iter().enumerate() {
            let source = root.join(entry);
            let matches: Vec<_> = items
                .iter()
                .filter(|item| {
                    same_path(&item.original, &source) && !journal.before_ids.contains(&item.id)
                })
                .collect();
            if fs::symlink_metadata(&source).is_ok() {
                if !matches.is_empty() || fingerprint(&source)? != journal.stamps[i] {
                    return Err(format!(
                        "`{entry}` changed outside the transaction; trash journal retained"
                    ));
                }
            } else {
                if matches.len() != 1 {
                    return Err(format!(
                        "cannot identify the trash entry of `{entry}`; journal retained"
                    ));
                }
                restore.push(matches[0].id.clone());
            }
        }
        if !restore.is_empty() {
            recycle.restore(&restore)?;
        }
        for (i, entry) in journal.paths.iter().enumerate() {
            if fingerprint(&root.join(entry))? != journal.stamps[i] {
                return Err(format!(
                    "`{entry}` differs after trash recovery; journal retained"
                ));
            }
        }
        let manifest = root.join("equavela-project.yaml");
        // The manifest may have been reindexed before the batch failed; restore its saved index.
        write_file_atomic(&manifest, &journal.manifest).map_err(|e| e.to_string())?;
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}

pub fn recover(root: &Path) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let _guard = project_tree::ProjectGuard::acquire(&root)?;
    recover_with(&root, &Native(root.clone()))
}

pub fn recover_for_path(path: &Path) -> Result<(), String> {
    for root in path.ancestors().skip(1) {
        if root.join(JOURNAL).exists() {
            return recover(root);
        }
        if root.join("equavela-project.yaml").is_file() {
            break;
        }
    }
    Ok(())
}

fn delete_with(root: &Path, paths: &[String], recycle: &impl Recycle) -> Result<(), String> {
    recover_with(root, recycle)?;
    let full: Vec<_> = paths.iter().map(|path| root.join(path)).collect();
    let stamps = full
        .iter()
        .map(|path| fingerprint(path))
        .collect::<Result<Vec<_>, _>>()?;
    let before_ids = recycle
        .list()?
        .into_iter()
        .filter(|item| full.iter().any(|path| same_path(path, &item.original)))
        .map(|item| item.id)
        .collect();
    let manifest =
        fs::read_to_string(root.join("equavela-project.yaml")).map_err(|e| e.to_string())?;
    let mut after = ProjectManifest::from_yaml(&manifest).map_err(|e| e.to_string())?;
    after.worksheets.retain(|sheet| {
        !paths
            .iter()
            .any(|path| sheet.path == *path || sheet.path.starts_with(&format!("{path}/")))
    });
    // a deleted Julia module is no longer loaded.
    after.julia_modules.retain(|module| {
        !paths
            .iter()
            .any(|path| module == path || module.starts_with(&format!("{path}/")))
    });
    if after.worksheets.is_empty() {
        return Err("cannot delete the last worksheet".into());
    }
    let manifest_after = after.to_yaml().map_err(|e| e.to_string())?;
    let mut journal = Journal {
        version: 1,
        root: root.to_owned(),
        paths: paths.to_vec(),
        before_ids,
        manifest,
        manifest_after,
        stamps,
        committed: false,
    };
    write_journal(root, &journal)?;
    let result = (|| {
        recycle.delete(&full)?;
        project_tree::sync_manifest(root, &Default::default())?;
        journal.committed = true;
        write_journal(root, &journal)
    })();
    if let Err(error) = result {
        return match recover_with(root, recycle) {
            Ok(()) => Err(format!("{error}; the trash batch was rolled back")),
            Err(recovery) => Err(format!("{error}; recovery pending: {recovery}")),
        };
    }
    let _ = fs::remove_file(root.join(JOURNAL));
    Ok(())
}

pub fn delete(root: &Path, paths: &[String]) -> Result<(), String> {
    let _guard = project_tree::ProjectGuard::acquire(root)?;
    delete_with(root, paths, &Native(root.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        panic::{catch_unwind, AssertUnwindSafe},
    };

    struct FakeTrash {
        directory: PathBuf,
        items: RefCell<Vec<Item>>,
        fail_after: Option<usize>,
        crash: bool,
        fail_restore: Cell<bool>,
    }
    impl Recycle for FakeTrash {
        fn list(&self) -> Result<Vec<Item>, String> {
            Ok(self.items.borrow().clone())
        }
        fn delete(&self, paths: &[PathBuf]) -> Result<(), String> {
            for (i, path) in paths.iter().enumerate() {
                let id = format!("item-{i}");
                fs::rename(path, self.directory.join(&id)).map_err(|e| e.to_string())?;
                self.items.borrow_mut().push(Item {
                    id,
                    original: path.clone(),
                });
                if self.fail_after == Some(i + 1) {
                    assert!(!self.crash, "simulated process interruption");
                    return Err("injected trash failure".into());
                }
            }
            Ok(())
        }
        fn restore(&self, ids: &[String]) -> Result<(), String> {
            if self.fail_restore.get() {
                return Err("trash is temporarily unavailable".into());
            }
            for id in ids {
                let item = self
                    .items
                    .borrow()
                    .iter()
                    .find(|item| &item.id == id)
                    .cloned()
                    .ok_or("missing fake entry")?;
                if item.original.exists() {
                    return Err("restore collision".into());
                }
                fs::rename(self.directory.join(id), &item.original).map_err(|e| e.to_string())?;
                self.items.borrow_mut().retain(|item| &item.id != id);
            }
            Ok(())
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, FakeTrash, Vec<String>) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let trash = temp.path().join("trash");
        fs::create_dir(&trash).unwrap();
        fs::write(
            root.join("main.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        fs::write(
            root.join("other.eqv"),
            "format: equavela-worksheet/3\nregions: []\n",
        )
        .unwrap();
        fs::write(root.join("notes.txt"), "original notes").unwrap();
        let yaml = "format: equavela-project/1\nproject_id: 11111111-1111-4111-8111-111111111111\nname: Trash\nworksheets:\n  - id: 22222222-2222-4222-8222-222222222222\n    path: main.eqv\n  - id: 33333333-3333-4333-8333-333333333333\n    path: other.eqv\nmain_worksheet: 22222222-2222-4222-8222-222222222222\n";
        let manifest = ProjectManifest::from_yaml(yaml).unwrap();
        fs::write(
            root.join("equavela-project.yaml"),
            manifest.to_yaml().unwrap(),
        )
        .unwrap();
        (
            temp,
            root,
            FakeTrash {
                directory: trash,
                items: RefCell::new(vec![]),
                fail_after: None,
                crash: false,
                fail_restore: Cell::new(false),
            },
            vec!["notes.txt".into(), "other.eqv".into()],
        )
    }

    #[test]
    fn trash_batch_commits_all_paths_and_index() {
        let (_temp, root, recycle, paths) = fixture();
        let _guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        delete_with(&root, &paths, &recycle).unwrap();
        assert!(paths.iter().all(|path| !root.join(path).exists()));
        assert_eq!(recycle.items.borrow().len(), 2);
        assert!(!root.join(JOURNAL).exists());
        assert_eq!(
            ProjectManifest::from_yaml(
                &fs::read_to_string(root.join("equavela-project.yaml")).unwrap()
            )
            .unwrap()
            .worksheets
            .len(),
            1
        );
    }

    #[test]
    fn trash_batch_failure_restores_files_and_manifest() {
        let (_temp, root, mut recycle, paths) = fixture();
        recycle.fail_after = Some(1);
        let _guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        let before = fs::read(root.join("equavela-project.yaml")).unwrap();
        assert!(delete_with(&root, &paths, &recycle)
            .unwrap_err()
            .contains("rolled back"));
        assert_eq!(
            fs::read(root.join("equavela-project.yaml")).unwrap(),
            before
        );
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "original notes"
        );
        assert!(root.join("other.eqv").exists());
        assert!(recycle.items.borrow().is_empty());
        assert!(!root.join(JOURNAL).exists());
    }

    #[test]
    fn trash_batch_interruption_is_recovered_without_original_source_access() {
        let (_temp, root, mut recycle, paths) = fixture();
        recycle.fail_after = Some(1);
        recycle.crash = true;
        let _guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| delete_with(&root, &paths, &recycle))).is_err());
        assert!(root.join(JOURNAL).exists());
        assert!(!root.join("notes.txt").exists());
        recover_with(&root, &recycle).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "original notes"
        );
        assert!(!root.join(JOURNAL).exists());
    }

    #[test]
    fn trash_batch_conflicts_and_unavailable_restore_preserve_the_journal() {
        let (_temp, root, mut recycle, paths) = fixture();
        recycle.fail_after = Some(1);
        recycle.crash = true;
        let _guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| delete_with(&root, &paths, &recycle))).is_err());
        fs::write(root.join("notes.txt"), "external work").unwrap();
        assert!(recover_with(&root, &recycle).is_err());
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "external work"
        );
        fs::remove_file(root.join("notes.txt")).unwrap();
        recycle.fail_restore.set(true);
        assert!(recover_with(&root, &recycle).is_err());
        assert!(root.join(JOURNAL).exists());
        recycle.fail_restore.set(false);
        recover_with(&root, &recycle).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("notes.txt")).unwrap(),
            "original notes"
        );
    }

    #[test]
    fn trash_batch_manifest_conflict_is_not_overwritten() {
        let (_temp, root, mut recycle, paths) = fixture();
        recycle.fail_after = Some(1);
        recycle.crash = true;
        let _guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        let manifest = root.join("equavela-project.yaml");
        let before = fs::read(&manifest).unwrap();
        assert!(catch_unwind(AssertUnwindSafe(|| delete_with(&root, &paths, &recycle))).is_err());
        let mut external =
            ProjectManifest::from_yaml(std::str::from_utf8(&before).unwrap()).unwrap();
        external.name = "External edit".into();
        fs::write(&manifest, external.to_yaml().unwrap()).unwrap();
        assert!(recover_with(&root, &recycle)
            .unwrap_err()
            .contains("manifest changed"));
        assert!(fs::read_to_string(&manifest)
            .unwrap()
            .contains("External edit"));
        fs::write(&manifest, before).unwrap();
        recover_with(&root, &recycle).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn native_trash_interruption_is_restored_when_the_project_opens() {
        const CHILD: &str = "EQUAVELA_NATIVE_TRASH_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let data = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "project_trash::tests::native_trash_interruption_is_restored_when_the_project_opens", "--nocapture"])
                .env(CHILD, "1").env("XDG_DATA_HOME", data.path()).output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        struct CrashNative(Native);
        impl Recycle for CrashNative {
            fn list(&self) -> Result<Vec<Item>, String> {
                self.0.list()
            }
            fn restore(&self, ids: &[String]) -> Result<(), String> {
                self.0.restore(ids)
            }
            fn delete(&self, paths: &[PathBuf]) -> Result<(), String> {
                self.0.delete(&paths[..1])?;
                panic!("simulated interruption after native trash");
            }
        }
        let (temp, root, _, _) = fixture();
        let before = fs::read(root.join("equavela-project.yaml")).unwrap();
        let guard = project_tree::ProjectGuard::acquire(&root).unwrap();
        let recycle = CrashNative(Native(root.clone()));
        assert!(catch_unwind(AssertUnwindSafe(|| delete_with(
            &root,
            &["main.eqv".into(), "notes.txt".into()],
            &recycle
        )))
        .is_err());
        drop(guard);
        assert!(!root.join("main.eqv").exists());
        let mut inputs = crate::kernel_path::LocationInputs::from_environment(None);
        inputs.julia_override = Some(PathBuf::from("/nonexistent-julia"));
        let service = crate::service::Service::new(std::sync::Arc::new(|_, _| {}), inputs);
        service.set_environments_dir(temp.path().join("environments"));
        service.open_project(&root).unwrap();
        assert!(root.join("main.eqv").exists());
        assert_eq!(
            fs::read(root.join("equavela-project.yaml")).unwrap(),
            before
        );
        assert!(!root.join(JOURNAL).exists());
        service.shutdown();
    }
}
