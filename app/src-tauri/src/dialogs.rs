//! The one place that opens native file dialogs.
//!
//! Every dialog is owned by the app window (`set_parent`) and runs on a blocking-pool thread
//! (`rfd` initialises a single-threaded COM apartment on it and runs the dialog's own modal
//! loop), so the Tauri main thread keeps pumping messages and the user stays disabled while the
//! dialog is up. Without an owner Windows treats the dialog as a free top-level window and can
//! restore it with a stale full-screen geometry that it then does not let the user change.

use std::path::PathBuf;

use rfd::FileDialog;
use tauri::WebviewWindow;

use crate::service::CommandError;

/// What a dialog shows, independent of `rfd` so it can be unit-tested.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DialogSpec {
    pub title: String,
    /// (label, extensions) in the order the dialog offers them.
    pub filters: Vec<(String, Vec<String>)>,
    pub directory: Option<PathBuf>,
    pub file_name: Option<String>,
}

impl DialogSpec {
    pub fn new(title: &str) -> Self {
        Self {
            title: title.to_owned(),
            ..Self::default()
        }
    }

    pub fn filter(mut self, label: &str, extensions: &[&str]) -> Self {
        self.filters.push((
            label.to_owned(),
            extensions.iter().map(|e| (*e).to_owned()).collect(),
        ));
        self
    }

    pub fn directory(mut self, directory: Option<PathBuf>) -> Self {
        self.directory = directory;
        self
    }

    pub fn file_name(mut self, name: String) -> Self {
        self.file_name = Some(name);
        self
    }

    /// The `rfd` dialog for this spec, owned by `window`.
    fn build(&self, window: &WebviewWindow) -> FileDialog {
        let mut dialog = FileDialog::new().set_title(&self.title).set_parent(window);
        for (label, extensions) in &self.filters {
            let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(label, &extensions);
        }
        if let Some(directory) = &self.directory {
            dialog = dialog.set_directory(directory);
        }
        if let Some(name) = &self.file_name {
            dialog = dialog.set_file_name(name);
        }
        dialog
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    PickFile,
    PickFiles,
    PickFolder,
    SaveFile,
}

enum Picked {
    One(Option<PathBuf>),
    Many(Option<Vec<PathBuf>>),
}

async fn run(window: &WebviewWindow, spec: DialogSpec, mode: Mode) -> Result<Picked, CommandError> {
    // Built here so the user handle is read from the window, shown on the blocking pool.
    let dialog = spec.build(window);
    tauri::async_runtime::spawn_blocking(move || match mode {
        Mode::PickFile => Picked::One(dialog.pick_file()),
        Mode::PickFiles => Picked::Many(dialog.pick_files()),
        Mode::PickFolder => Picked::One(dialog.pick_folder()),
        Mode::SaveFile => Picked::One(dialog.save_file()),
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))
}

pub async fn pick_file(
    window: &WebviewWindow,
    spec: DialogSpec,
) -> Result<Option<PathBuf>, CommandError> {
    match run(window, spec, Mode::PickFile).await? {
        Picked::One(path) => Ok(path),
        Picked::Many(_) => unreachable!(),
    }
}

pub async fn pick_files(
    window: &WebviewWindow,
    spec: DialogSpec,
) -> Result<Vec<PathBuf>, CommandError> {
    match run(window, spec, Mode::PickFiles).await? {
        Picked::Many(paths) => Ok(paths.unwrap_or_default()),
        Picked::One(_) => unreachable!(),
    }
}

/// A folder chooser (filters do not apply); `None` when cancelled.
pub async fn pick_folder(
    window: &WebviewWindow,
    spec: DialogSpec,
) -> Result<Option<PathBuf>, CommandError> {
    match run(window, spec, Mode::PickFolder).await? {
        Picked::One(path) => Ok(path),
        Picked::Many(_) => unreachable!(),
    }
}

pub async fn save_file(
    window: &WebviewWindow,
    spec: DialogSpec,
) -> Result<Option<PathBuf>, CommandError> {
    match run(window, spec, Mode::SaveFile).await? {
        Picked::One(path) => Ok(path),
        Picked::Many(_) => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_keeps_filter_order_and_start() {
        let spec = DialogSpec::new("Open worksheet")
            .filter("Worksheets (*.eqv)", &["eqv"])
            .filter("All files", &["*"])
            .directory(Some(PathBuf::from("C:/x")))
            .file_name("a.eqv".to_owned());
        assert_eq!(spec.title, "Open worksheet");
        assert_eq!(spec.filters[0].0, "Worksheets (*.eqv)");
        assert_eq!(spec.filters[1].1, vec!["*".to_owned()]);
        assert_eq!(spec.directory, Some(PathBuf::from("C:/x")));
        assert_eq!(spec.file_name.as_deref(), Some("a.eqv"));
    }
}
