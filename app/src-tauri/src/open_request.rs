//! Open requests from a second launch of the application.
//!
//! The single-instance plugin hands the command line of the second launch to the running
//! instance; the file arguments are queued here and the interface drains the queue (it can
//! ask before it has subscribed to the notification, so a request is never lost).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The event the interface listens to; the payload is empty, the paths come from `take`.
pub const EVENT_OPEN_REQUEST: &str = "open-request";

/// The file arguments of a command line (`args` without the program name): existing files only,
/// options (`-...`) skipped, relative paths resolved against `cwd`, duplicates removed, in order.
pub fn file_arguments(args: &[String], cwd: &Path) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for argument in args {
        if argument.is_empty() || argument.starts_with('-') {
            continue;
        }
        let path = PathBuf::from(argument);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if !path.is_file() {
            continue;
        }
        let text = path.to_string_lossy().into_owned();
        if !found.contains(&text) {
            found.push(text);
        }
    }
    found
}

/// Paths received from other launches and not yet delivered to the interface.
#[derive(Default)]
pub struct OpenRequests {
    queue: Mutex<Vec<String>>,
}

impl OpenRequests {
    pub fn push(&self, paths: Vec<String>) {
        self.queue.lock().expect("open queue").extend(paths);
    }

    /// Everything queued so far; the queue is empty afterwards.
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.queue.lock().expect("open queue"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    #[test]
    fn keeps_existing_files_in_order_and_skips_options_and_missing_ones() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.eqv");
        let b = dir.path().join("b.eqv");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "x").unwrap();
        let args = strings(&[
            "--flag",
            b.to_str().unwrap(),
            "missing.eqv",
            "",
            a.to_str().unwrap(),
        ]);
        let found = file_arguments(&args, dir.path());
        assert_eq!(
            found,
            vec![
                b.to_string_lossy().into_owned(),
                a.to_string_lossy().into_owned()
            ]
        );
    }

    #[test]
    fn resolves_relative_paths_against_the_working_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("rel.eqv"), "x").unwrap();
        let found = file_arguments(&strings(&["rel.eqv"]), dir.path());
        assert_eq!(
            found,
            vec![dir.path().join("rel.eqv").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn opens_a_file_named_twice_once_and_ignores_directories() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.eqv");
        std::fs::write(&a, "x").unwrap();
        let args = strings(&[
            a.to_str().unwrap(),
            a.to_str().unwrap(),
            dir.path().to_str().unwrap(),
        ]);
        assert_eq!(file_arguments(&args, dir.path()).len(), 1);
    }

    #[test]
    fn no_arguments_means_no_files() {
        assert!(file_arguments(&[], Path::new(".")).is_empty());
    }

    #[test]
    fn the_queue_is_drained_by_take() {
        let queue = OpenRequests::default();
        assert!(queue.take().is_empty());
        queue.push(strings(&["one"]));
        queue.push(strings(&["two", "three"]));
        assert_eq!(queue.take(), strings(&["one", "two", "three"]));
        assert!(queue.take().is_empty());
    }
}
