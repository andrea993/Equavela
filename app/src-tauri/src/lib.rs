//! The Tauri shell: thin command wrappers around [`service::Service`].

#[cfg(windows)]
mod browser_shortcuts;
mod crash_reports;
pub mod dialogs;
mod environment_metadata;
pub mod kernel_path;
pub mod open_request;
pub mod print;
mod project_archive_files;
mod project_trash;
pub mod service;
pub mod settings;
pub mod snapshot;
pub mod spell;

use equavela_core::session::{
    DefinitionValue, DocumentView, Inspection, KernelStatus, RegionEntry, RegionKey, WarningInfo,
};
use kernel_path::LocationInputs;
use open_request::OpenRequests;
use print::ExportedPdf;
use service::{
    CommandError, DefinitionRef, EditResult, EnvironmentInfo, EventSink, ImageAdded,
    ImportedWorksheet, MathFontEdit, OpenedProject, OpenedWorksheet, ProjectChange,
    ProjectImageUsage, ProjectTextFile, ProjectTextRecovery, ProjectTextRecoveryListing,
    ProjectTextSaved, RecoveryInfo, RegionMove, SavedWorksheet, Service, WorksheetSnapshot,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent, State};

type Shared<'a> = State<'a, Arc<Service>>;

/// Returns the version of the Rust core linked into the app.
#[tauri::command]
fn core_version() -> &'static str {
    equavela_core::version()
}

/// The extensions the Open dialog shows: worksheets and portable documents.
const WORKSHEET_EXTENSIONS: &[&str] = &["eqv", "eqvz"];

/// Opens a page of the user manual (served from the app's own files at `manual/`) in
/// its own window, replacing the page it showed. Only pages inside `manual/` are accepted.
#[tauri::command]
async fn open_manual(app: tauri::AppHandle, page: String) -> Result<(), CommandError> {
    let path = page.split('#').next().unwrap_or_default();
    if !path.starts_with("manual/") || path.contains("..") || path.contains('\\') {
        return Err(CommandError::internal(format!(
            "not a page of the manual: {page}"
        )));
    }
    if let Some(window) = app.get_webview_window("manual") {
        let _ = window.destroy();
    }
    tauri::WebviewWindowBuilder::new(&app, "manual", tauri::WebviewUrl::App(page.into()))
        .title("Equavela manual")
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|error| CommandError::internal(error.to_string()))?;
    Ok(())
}

/// The interface has drawn for the first time: show the main window and close the startup splash.
#[tauri::command]
fn app_ready(app: tauri::AppHandle) {
    show_main_window(&app);
}

/// Shows the main window and closes the splash; harmless when called again.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        if std::env::var_os("EQUAVELA_DRIVER_OFFSCREEN").is_none() {
            let _ = window.set_focus();
        }
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

/// The startup splash; the main window starts hidden and is shown by `app_ready`, or
/// after 20 seconds when the interface never reports. A test driver run gets no splash.
fn open_splash(app: &tauri::App) -> tauri::Result<()> {
    if std::env::var_os("EQUAVELA_DRIVER_OFFSCREEN").is_some() {
        show_main_window(app.handle());
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(app, "splash", tauri::WebviewUrl::App("splash.html".into()))
        .title("Equavela")
        .inner_size(560.0, 300.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .build()?;
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        // Only while the splash is still up: a late call must not take the focus.
        if handle.get_webview_window("splash").is_some() {
            show_main_window(&handle);
        }
    });
    Ok(())
}

/// The current kernel status; changes are pushed as `kernel-status` events.
#[tauri::command]
fn kernel_status(service: Shared<'_>) -> KernelStatus {
    service.kernel_status()
}

/// Starts the kernel in the background (opening a worksheet does this too).
#[tauri::command]
fn start_kernel(service: Shared<'_>) {
    service.inner().start_kernel();
}

/// Loads a worksheet YAML file and the files it includes.
#[tauri::command]
async fn open_worksheet(
    service: Shared<'_>,
    path: String,
) -> Result<OpenedWorksheet, CommandError> {
    service.inner().open_worksheet(&PathBuf::from(path))
}

/// Imports an .mcdx or .xmcd worksheet as a new untitled worksheet (the file is only read).
#[tauri::command]
async fn import_mcdx(service: Shared<'_>, path: String) -> Result<ImportedWorksheet, CommandError> {
    service.inner().import_mcdx(&PathBuf::from(path))
}

/// Creates an empty, unsaved worksheet.
#[tauri::command]
async fn new_worksheet(service: Shared<'_>) -> Result<OpenedWorksheet, CommandError> {
    service.inner().new_worksheet()
}

/// Creates a folder project and opens its initial worksheet.
#[tauri::command]
async fn new_project(
    service: Shared<'_>,
    destination: String,
    name: String,
    project_id: String,
    worksheet_id: String,
) -> Result<OpenedProject, CommandError> {
    service
        .inner()
        .new_project(Path::new(&destination), &name, &project_id, &worksheet_id)
}

/// Convert to project: the standalone worksheet becomes the main worksheet of a new
/// folder project, which opens in its place.
#[tauri::command]
async fn convert_to_project(
    service: Shared<'_>,
    worksheet: String,
    destination: String,
    name: String,
    project_id: String,
    worksheet_id: String,
) -> Result<OpenedProject, CommandError> {
    service.inner().convert_to_project(
        &worksheet,
        Path::new(&destination),
        &name,
        &project_id,
        &worksheet_id,
    )
}

/// Opens a folder project and its main worksheet.
#[tauri::command]
async fn open_project(service: Shared<'_>, root: String) -> Result<OpenedProject, CommandError> {
    service.inner().open_project(Path::new(&root))
}

/// The Julia environment of a worksheet, its files and its kernel.
#[tauri::command]
async fn environment_info(
    service: Shared<'_>,
    worksheet: String,
) -> Result<EnvironmentInfo, CommandError> {
    service.inner().environment_info(&worksheet)
}

/// Sets (`Some`, a directory) or removes (`None`) a standalone worksheet's environment.
#[tauri::command]
async fn set_worksheet_environment(
    service: Shared<'_>,
    worksheet: String,
    environment: Option<String>,
) -> Result<EditResult, CommandError> {
    service
        .inner()
        .set_worksheet_environment(&worksheet, environment.as_deref().map(Path::new))
}

/// Builds a read-only candidate comparison without changing the selected environment.
#[tauri::command]
async fn preview_environment_switch(
    service: Shared<'_>,
    worksheet: String,
    target: Option<String>,
) -> Result<service::EnvironmentSwitchPreview, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.preview_environment_switch(&worksheet, target.as_deref().map(Path::new))
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// the native folder dialog of the project dialogs. `None`: cancelled.
#[tauri::command]
async fn choose_folder(
    window: tauri::WebviewWindow,
    title: String,
    start: Option<String>,
) -> Result<Option<String>, CommandError> {
    let spec = dialogs::DialogSpec::new(&title)
        .directory(start.map(PathBuf::from).filter(|start| start.is_dir()));
    Ok(dialogs::pick_folder(&window, spec)
        .await?
        .map(|folder| folder.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn choose_environment_switch(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: String,
) -> Result<Option<service::EnvironmentSwitchPreview>, CommandError> {
    let start = service.start_location(&worksheet, None).directory;
    let spec = dialogs::DialogSpec::new("Preview Julia environment").directory(start);
    match dialogs::pick_folder(&window, spec).await? {
        Some(directory) => service
            .preview_environment_switch(&worksheet, Some(&directory))
            .map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
async fn commit_environment_switch(
    service: Shared<'_>,
    worksheet: String,
    token: String,
) -> Result<EditResult, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.commit_environment_switch(&worksheet, &token)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Asks for a folder (native chooser, starting in the worksheet's folder) and makes it the
/// worksheet's environment; `None` when cancelled.
#[tauri::command]
async fn choose_worksheet_environment(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: String,
) -> Result<Option<EditResult>, CommandError> {
    let start = service.start_location(&worksheet, None).directory;
    let spec = dialogs::DialogSpec::new("Julia environment for this worksheet").directory(start);
    match dialogs::pick_folder(&window, spec).await? {
        Some(directory) => service
            .inner()
            .set_worksheet_environment(&worksheet, Some(&directory))
            .map(Some),
        None => Ok(None),
    }
}

/// Adds or removes packages in a worksheet's environment; can take long (downloads).
#[tauri::command]
async fn change_packages(
    service: Shared<'_>,
    worksheet: String,
    packages: Vec<String>,
    remove: bool,
) -> Result<EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.change_packages(&worksheet, &packages, remove)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Restarts the kernel of a worksheet's environment.
#[tauri::command]
async fn restart_environment_kernel(
    service: Shared<'_>,
    worksheet: String,
) -> Result<EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.restart_environment_kernel(&worksheet))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Undoes the last package change or settles an interrupted one: `restore` puts
/// the previous metadata back, otherwise the current files are kept.
#[tauri::command]
async fn revert_environment_change(
    service: Shared<'_>,
    worksheet: String,
    interrupted: bool,
    restore: bool,
) -> Result<EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.revert_environment_change(&worksheet, interrupted, restore)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Packs a folder project into a new `.eqvz` file without replacing anything.
/// Without `destination` the native Save dialog asks for it, starting next to
/// the project; `None` when cancelled. Returns the archive path.
#[tauri::command]
async fn pack_project_archive(
    window: tauri::WebviewWindow,
    root: String,
    destination: Option<String>,
) -> Result<Option<String>, CommandError> {
    let root = PathBuf::from(root);
    let destination = match destination {
        Some(destination) => PathBuf::from(destination),
        None => {
            let name = equavela_core::project_directory::load_project_directory(&root)
                .map(|loaded| loaded.manifest.name)
                .unwrap_or_else(|_| "project".into());
            let spec = dialogs::DialogSpec::new("Pack project as .eqvz")
                .filter("Equavela archive (*.eqvz)", &["eqvz"])
                .directory(root.parent().map(Path::to_path_buf))
                .file_name(format!("{name}.eqvz"));
            match dialogs::save_file(&window, spec).await? {
                Some(path) if path.extension().is_none() => path.with_extension("eqvz"),
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        project_archive_files::pack_to_file(&root, &destination).map(Some)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Extracts a project `.eqvz` into a new folder. Missing paths are asked
/// for with the native Open dialog and then the Save dialog for the new folder; `None` when
/// either is cancelled. Returns the project root; opens nothing.
#[tauri::command]
async fn extract_project_archive(
    window: tauri::WebviewWindow,
    source: Option<String>,
    destination: Option<String>,
) -> Result<Option<String>, CommandError> {
    let source = match source {
        Some(source) => PathBuf::from(source),
        None => {
            let spec = dialogs::DialogSpec::new("Extract project from .eqvz")
                .filter("Equavela archive (*.eqvz)", &["eqvz"]);
            match dialogs::pick_file(&window, spec).await? {
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    let destination = match destination {
        Some(destination) => PathBuf::from(destination),
        None => {
            let stem = source
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "project".into());
            let spec = dialogs::DialogSpec::new("New project folder")
                .directory(source.parent().map(Path::to_path_buf))
                .file_name(stem);
            match dialogs::save_file(&window, spec).await? {
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        project_archive_files::extract_from_file(&source, &destination)
            .map(|root| Some(root.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// the project tree and its manifest, brought in step with the tree.
#[tauri::command]
async fn project_tree(service: Shared<'_>, root: String) -> Result<ProjectChange, CommandError> {
    service.inner().project_tree(Path::new(&root))
}

#[tauri::command]
async fn project_image_usage(
    service: Shared<'_>,
    root: String,
) -> Result<Vec<ProjectImageUsage>, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.project_image_usage(Path::new(&root)))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// a new worksheet (opened), Julia file or folder in `folder` (`""`: the root).
#[tauri::command]
async fn project_create(
    service: Shared<'_>,
    root: String,
    folder: String,
    name: String,
    kind: String,
) -> Result<ProjectChange, CommandError> {
    service
        .inner()
        .project_create(Path::new(&root), &folder, &name, &kind)
}

/// renames a file or folder of the project in place.
#[tauri::command]
async fn project_rename(
    service: Shared<'_>,
    root: String,
    path: String,
    name: String,
) -> Result<ProjectChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_rename(Path::new(&root), &path, &name)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// moves a file or folder of the project into `folder`.
#[tauri::command]
async fn project_move(
    service: Shared<'_>,
    root: String,
    path: String,
    folder: String,
) -> Result<ProjectChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_move(Path::new(&root), &path, &folder)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

#[tauri::command]
async fn project_move_many(
    service: Shared<'_>,
    root: String,
    paths: Vec<String>,
    folder: String,
) -> Result<ProjectChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_move_many(Path::new(&root), &paths, &folder)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

#[tauri::command]
async fn project_delete_many(
    service: Shared<'_>,
    root: String,
    paths: Vec<String>,
) -> Result<ProjectChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_delete_many(Path::new(&root), &paths)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// moves a file or folder of the project to the system trash.
#[tauri::command]
async fn project_delete(
    service: Shared<'_>,
    root: String,
    path: String,
) -> Result<ProjectChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.project_delete(Path::new(&root), &path))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// copies files into `folder`; without `sources` the native Open dialog asks (several
/// files). `None` when cancelled.
#[tauri::command]
async fn project_import(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    root: String,
    folder: String,
    sources: Option<Vec<String>>,
) -> Result<Option<ProjectChange>, CommandError> {
    let sources: Vec<PathBuf> = match sources {
        Some(sources) => sources.into_iter().map(PathBuf::from).collect(),
        None => {
            let spec = dialogs::DialogSpec::new("Import files into the project")
                .filter("All files", &["*"]);
            let chosen = dialogs::pick_files(&window, spec).await?;
            if chosen.is_empty() {
                return Ok(None);
            }
            chosen
        }
    };
    service
        .inner()
        .project_import(Path::new(&root), &folder, &sources)
        .map(Some)
}

/// the text of a file of the project and its version.
#[tauri::command]
async fn project_read_text(
    service: Shared<'_>,
    root: String,
    path: String,
) -> Result<ProjectTextFile, CommandError> {
    service.inner().project_read_text(Path::new(&root), &path)
}

/// saves a text tab; may restart the project's kernel (can take a while).
#[tauri::command]
async fn project_write_text(
    service: Shared<'_>,
    root: String,
    path: String,
    text: String,
    version: String,
) -> Result<ProjectTextSaved, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_write_text(Path::new(&root), &path, &text, &version)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

#[tauri::command]
async fn write_project_text_recovery(
    service: Shared<'_>,
    root: String,
    path: String,
    text: String,
    saved: String,
    version: String,
) -> Result<(), CommandError> {
    service.write_project_text_recovery(Path::new(&root), &path, &text, &saved, &version)
}

#[tauri::command]
async fn project_text_recovery_for(
    service: Shared<'_>,
    root: String,
    path: String,
) -> Result<Option<ProjectTextRecovery>, CommandError> {
    service.project_text_recovery_for(Path::new(&root), &path)
}

#[tauri::command]
async fn discard_project_text_recovery(
    service: Shared<'_>,
    root: String,
    path: String,
) -> Result<(), CommandError> {
    service.discard_project_text_recovery(Path::new(&root), &path)
}

#[tauri::command]
async fn list_project_text_recoveries(
    service: Shared<'_>,
) -> Result<ProjectTextRecoveryListing, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.list_project_text_recoveries())
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

#[tauri::command]
async fn read_project_text_recovery(
    service: Shared<'_>,
    id: String,
) -> Result<ProjectTextRecovery, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.read_project_text_recovery(&id))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

#[tauri::command]
async fn export_project_text_recovery(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    id: String,
) -> Result<Option<String>, CommandError> {
    let name = service.project_text_recovery_name(&id)?;
    let spec = dialogs::DialogSpec::new("Export recovered text").file_name(name);
    let Some(path) = dialogs::save_file(&window, spec).await? else {
        return Ok(None);
    };
    let output = path.to_string_lossy().into_owned();
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.export_project_text_recovery_to(&id, &path)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))??;
    Ok(Some(output))
}

#[tauri::command]
async fn discard_project_text_recovery_entry(
    service: Shared<'_>,
    id: String,
) -> Result<(), CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.discard_project_text_recovery_entry(&id))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// an image of the project as a data URL.
#[tauri::command]
async fn project_image(
    service: Shared<'_>,
    root: String,
    path: String,
) -> Result<String, CommandError> {
    service.inner().project_image(Path::new(&root), &path)
}

/// The project file `path` (`""`: the root) after checking it exists inside the project.
fn project_target(root: &str, path: &str) -> Result<PathBuf, CommandError> {
    let target = if path.is_empty() {
        PathBuf::from(root)
    } else {
        Path::new(root).join(path)
    };
    if path.split('/').any(|part| part == "..") || !target.starts_with(root) || !target.exists() {
        return Err(CommandError::new(
            "project",
            format!("`{path}` is not in the project"),
        ));
    }
    Ok(target)
}

/// hands a file of the project to the system's default application.
#[tauri::command]
async fn project_open_external(root: String, path: String) -> Result<(), CommandError> {
    let target = project_target(&root, &path)?;
    #[cfg(windows)]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&target)
        .spawn();
    #[cfg(not(windows))]
    let spawned = std::process::Command::new("xdg-open").arg(&target).spawn();
    spawned
        .map(|_| ())
        .map_err(|error| CommandError::new("project", format!("cannot open the file: {error}")))
}

/// The argument that makes Explorer open the folder of `path` with it selected.
/// Explorer falls back to the Documents folder when it cannot read the path: a project path joined
/// as `C:\proj\sub/file.eqv` has forward slashes, a canonical path has the `\\?\` prefix, and
/// the standard quoting of an argument with spaces (`"/select,C:\a b"`) is not parsed. The path is
/// written with backslashes only, without the prefix, quoted after the comma.
#[cfg_attr(not(windows), allow(dead_code))]
fn explorer_select_arg(path: &str) -> String {
    let path = path.replace('/', "\\");
    let path = path
        .strip_prefix("\\\\?\\UNC\\")
        .map(|rest| format!("\\\\{rest}"))
        .unwrap_or_else(|| path.strip_prefix("\\\\?\\").unwrap_or(&path).to_string());
    format!("/select,\"{path}\"")
}

#[cfg(windows)]
fn explorer_select(target: &Path) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    // Passed raw: the standard quoting would wrap the whole `/select,...` in quotes.
    std::process::Command::new("explorer")
        .raw_arg(explorer_select_arg(&target.to_string_lossy()))
        .spawn()
}

/// shows a file or folder of the project in the system file manager.
#[tauri::command]
async fn project_reveal(root: String, path: String) -> Result<(), CommandError> {
    let target = project_target(&root, &path)?;
    #[cfg(windows)]
    let spawned = explorer_select(&target);
    #[cfg(not(windows))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(if target.is_dir() {
            target.as_path()
        } else {
            target.parent().unwrap_or(Path::new(&root))
        })
        .spawn();
    spawned.map(|_| ()).map_err(|error| {
        CommandError::new("project", format!("cannot open the file manager: {error}"))
    })
}

/// runs REPL code in the kernel of a worksheet's environment.
#[tauri::command]
async fn repl_eval(
    service: Shared<'_>,
    project: Option<String>,
    code: String,
    reset: Option<bool>,
) -> Result<equavela_core::kernel_manager::ReplResult, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.repl(project.as_deref(), &code, reset.unwrap_or(false))
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// terminal I/O remains separate from framed worksheet RPC.
#[tauri::command]
async fn terminal_open(
    service: Shared<'_>,
    project: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<equavela_core::kernel_manager::TerminalSnapshot, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.terminal_open(project.as_deref(), cols, rows)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

#[tauri::command]
async fn terminal_read(
    service: Shared<'_>,
    project: Option<String>,
    after: u64,
) -> Result<equavela_core::kernel_manager::TerminalSnapshot, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.terminal_read(project.as_deref(), after))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}

#[tauri::command]
async fn terminal_write(
    service: Shared<'_>,
    project: Option<String>,
    data: String,
) -> Result<(), CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.terminal_write(project.as_deref(), &data))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}

#[tauri::command]
async fn terminal_resize(
    service: Shared<'_>,
    project: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.terminal_resize(project.as_deref(), cols, rows)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// restarts the kernel the REPL runs in.
#[tauri::command]
async fn repl_restart(
    service: Shared<'_>,
    project: Option<String>,
) -> Result<String, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.repl_restart(project.as_deref()))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}

/// interrupts the REPL evaluation.
#[tauri::command]
fn repl_interrupt(service: Shared<'_>, project: Option<String>) -> Result<bool, CommandError> {
    service.repl_interrupt(project.as_deref())
}

/// the module name of every open worksheet, by worksheet id.
#[tauri::command]
fn worksheet_module_names(service: Shared<'_>) -> std::collections::HashMap<String, String> {
    service.worksheet_module_names()
}

/// Tab in the REPL input; completions in the REPL module of a worksheet's environment.
#[tauri::command]
async fn repl_complete(
    service: Shared<'_>,
    project: Option<String>,
    text: String,
    position: usize,
) -> Result<equavela_core::kernel_manager::Completions, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.repl_complete(project.as_deref(), &text, position)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// completions for a project text file, from a worksheet's kernel.
#[tauri::command]
async fn complete_code(
    service: Shared<'_>,
    worksheet: String,
    text: String,
    position: usize,
) -> Result<equavela_core::kernel_manager::Completions, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.complete(&worksheet, &text, position))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}

/// shows an open document's file in the system file manager.
#[tauri::command]
async fn reveal_file(path: String) -> Result<(), CommandError> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() || !target.exists() {
        return Err(CommandError::new("file", format!("`{path}` was not found")));
    }
    #[cfg(windows)]
    let spawned = explorer_select(&target);
    #[cfg(not(windows))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(target.parent().unwrap_or(&target))
        .spawn();
    spawned.map(|_| ()).map_err(|error| {
        CommandError::new("file", format!("cannot open the file manager: {error}"))
    })
}

/// the project's exports and references.
#[tauri::command]
async fn project_references(
    service: Shared<'_>,
    root: String,
) -> Result<service::ProjectReferences, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.project_references(Path::new(&root)))
        .await
        .map_err(|e| CommandError::internal(e.to_string()))?
}

/// exports a definition region, or stops exporting it.
#[tauri::command]
async fn project_set_export(
    service: Shared<'_>,
    root: String,
    path: String,
    region: String,
    exported: bool,
) -> Result<service::ReferencesChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_set_export(Path::new(&root), &path, &region, exported)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// references a project; without `folder` the native folder dialog asks. `null`: cancelled.
#[tauri::command]
async fn project_add_reference(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    root: String,
    folder: Option<String>,
    alias: Option<String>,
) -> Result<Option<service::ReferencesChange>, CommandError> {
    let folder = match folder {
        Some(folder) => PathBuf::from(folder),
        None => {
            let start = Path::new(&root).parent().map(Path::to_path_buf);
            let spec = dialogs::DialogSpec::new("Add project reference").directory(start);
            match dialogs::pick_folder(&window, spec).await? {
                Some(folder) => folder,
                None => return Ok(None),
            }
        }
    };
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_add_reference(Path::new(&root), &folder, alias.as_deref())
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
    .map(Some)
}

/// lists a project `.jl` file among the modules its worksheets load, or removes it.
#[tauri::command]
async fn project_set_julia_module(
    service: Shared<'_>,
    root: String,
    path: String,
    loaded: bool,
) -> Result<service::ReferencesChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.project_set_julia_module(Path::new(&root), &path, loaded)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// develops a referenced project's Julia package into the worksheet's environment.
#[tauri::command]
async fn develop_reference_package(
    service: Shared<'_>,
    worksheet: String,
    alias: String,
) -> Result<EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.develop_reference_package(&worksheet, &alias)
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// relocks, renames or removes a reference; reloads them all; trusts one.
#[tauri::command]
async fn project_reference_command(
    service: Shared<'_>,
    root: String,
    command: String,
    alias: Option<String>,
    value: Option<String>,
) -> Result<service::ReferencesChange, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        let alias = alias.unwrap_or_default();
        match command.as_str() {
            "update" => service.project_update_reference(root, &alias),
            "remove" => service.project_remove_reference(root, &alias),
            "rename" => {
                service.project_rename_reference(root, &alias, value.as_deref().unwrap_or_default())
            }
            "reload" => service.project_reload_references(root),
            "trust" => service.project_trust_reference(root, &alias, true),
            "untrust" => service.project_trust_reference(root, &alias, false),
            other => Err(CommandError::internal(format!(
                "unknown reference command `{other}`"
            ))),
        }
    })
    .await
    .map_err(|e| CommandError::internal(e.to_string()))?
}

/// The image files of a project's `assets/images/`.
#[tauri::command]
async fn list_project_assets(
    service: Shared<'_>,
    root: String,
) -> Result<Vec<String>, CommandError> {
    service.inner().list_project_assets(Path::new(&root))
}

/// Copies metadata to a new directory and selects the copied environment.
#[tauri::command]
async fn copy_worksheet_environment(
    service: Shared<'_>,
    worksheet: String,
    destination: String,
) -> Result<EditResult, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.copy_worksheet_environment(&worksheet, Path::new(&destination))
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Explicit package maintenance in the worksheet's resolved environment.
#[tauri::command]
async fn manage_environment(
    service: Shared<'_>,
    worksheet: String,
    operation: String,
) -> Result<service::EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.manage_environment(&worksheet, &operation))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Validates and changes one direct dependency's required version range.
#[tauri::command]
async fn set_compatibility(
    service: Shared<'_>,
    worksheet: String,
    package_name: String,
    compatibility: String,
) -> Result<service::EnvironmentInfo, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.set_compatibility(&worksheet, &package_name, &compatibility)
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Inspects only a selected environment metadata file, without invoking Julia or an editor.
#[tauri::command]
async fn read_environment_metadata(
    service: Shared<'_>,
    worksheet: String,
    file: String,
) -> Result<String, CommandError> {
    let info = service.environment_info(&worksheet)?;
    let path = match file.as_str() {
        "project" => info.files.project_toml,
        "manifest" => info.files.manifest_toml,
        _ => {
            return Err(CommandError::new(
                "environment",
                "unknown environment metadata file",
            ))
        }
    };
    tauri::async_runtime::spawn_blocking(move || environment_metadata::read(&path))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Saves a worksheet to its own file (atomic write). A worksheet without a file (`untitled`
/// error) needs `save_worksheet_as`.
#[tauri::command]
async fn save_worksheet(
    service: Shared<'_>,
    worksheet: String,
) -> Result<SavedWorksheet, CommandError> {
    service.save_worksheet(&worksheet)
}

/// Saves a worksheet under a new name. Without `path` a native Save As dialog opens, filtered
/// to `.eqv` (`.eqv` is also appended to a name without extension); the result is `None` when the
/// dialog is cancelled. On success the worksheet is re-opened from the new file
/// (`SavedWorksheet::opened` replaces the old session).
#[tauri::command]
async fn save_worksheet_as(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: String,
    path: Option<String>,
    suggested: Option<String>,
) -> Result<Option<SavedWorksheet>, CommandError> {
    let path = match path {
        Some(path) => PathBuf::from(path),
        None => {
            let start = service.start_location(&worksheet, suggested.as_deref());
            // Save As offers the portable document beside the text worksheet; a
            // document opened from a `.eqvz` starts on its own filter.
            let spec = dialogs::DialogSpec::new("Save worksheet as");
            let spec = if start.file_name.ends_with(".eqvz") {
                spec.filter("Portable document (*.eqvz)", &["eqvz"])
                    .filter("Worksheet (*.eqv)", &["eqv"])
            } else {
                spec.filter("Worksheet (*.eqv)", &["eqv"])
                    .filter("Portable document (*.eqvz)", &["eqvz"])
            };
            let spec = spec
                .filter("All files", &["*"])
                .directory(start.directory)
                .file_name(start.file_name);
            let chosen = dialogs::save_file(&window, spec).await?;
            match chosen {
                Some(path) => path,
                None => return Ok(None),
            }
        }
    };
    service
        .inner()
        .save_worksheet_as(&worksheet, &path)
        .map(Some)
}

/// Writes the worksheet's recovery file; `None` when nothing was written
/// (a calculation is running, or there is no place for it).
#[tauri::command]
async fn write_recovery(
    service: Shared<'_>,
    worksheet: String,
) -> Result<Option<String>, CommandError> {
    service.write_recovery(&worksheet)
}

/// A recovery file newer than the worksheet file `path`, to offer at open.
#[tauri::command]
fn recovery_for(service: Shared<'_>, path: String) -> Option<RecoveryInfo> {
    service.recovery_for(&PathBuf::from(path))
}

/// Deletes a recovery file the user discarded.
#[tauri::command]
fn discard_recovery_file(service: Shared<'_>, path: String) -> Result<(), CommandError> {
    service.discard_recovery_file(&PathBuf::from(path))
}

/// The recovery files of untitled worksheets from a previous session.
#[tauri::command]
fn pending_recoveries(service: Shared<'_>) -> Vec<String> {
    service.pending_recoveries()
}

/// Opens a recovery file (see `Service::open_recovery`).
#[tauri::command]
async fn open_recovery(
    service: Shared<'_>,
    recovery: String,
    original: Option<String>,
) -> Result<OpenedWorksheet, CommandError> {
    let original = original.map(PathBuf::from);
    service
        .inner()
        .open_recovery(&PathBuf::from(recovery), original.as_deref())
}

/// The folder of the last worksheet chosen in the Open dialog (the start folder when the current
/// worksheet has no file).
static LAST_OPEN_DIRECTORY: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// The files File > Import reads: `.mcdx` and the older `.xmcd`.
const IMPORT_FILTER: &str = "Worksheets to import (*.mcdx, *.xmcd, *.xmcdz)";
const IMPORT_EXTENSIONS: &[&str] = &["mcdx", "xmcd", "xmcdz"];

/// Shows the native Open dialog (filters: Worksheets `*.eqv` and `*.eqvz` first, the reference application `*.mcdx` and `*.xmcd` (first for
/// `import`), All files;
/// multi-select) and returns the chosen paths, empty when it is cancelled. It starts in the folder of
/// the worksheet `worksheet` when that has a file, else in the last-used folder.
#[tauri::command]
async fn choose_open_paths(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: Option<String>,
    import: Option<bool>,
) -> Result<Vec<String>, CommandError> {
    let import = import.unwrap_or(false);
    let mut start = worksheet
        .and_then(|id| service.start_location(&id, None).directory)
        .or_else(|| {
            LAST_OPEN_DIRECTORY
                .lock()
                .ok()
                .and_then(|last| last.clone())
        });
    start = start.filter(|directory| directory.is_dir());
    // File > Import starts on the reference application filter; both dialogs offer both.
    let spec = dialogs::DialogSpec::new(if import {
        "Import the reference application worksheet"
    } else {
        "Open worksheet"
    });
    // Open shows text worksheets and portable documents together.
    let spec = if import {
        spec.filter(IMPORT_FILTER, IMPORT_EXTENSIONS)
            .filter("Worksheets (*.eqv, *.eqvz)", WORKSHEET_EXTENSIONS)
    } else {
        spec.filter("Worksheets (*.eqv, *.eqvz)", WORKSHEET_EXTENSIONS)
            .filter(IMPORT_FILTER, IMPORT_EXTENSIONS)
    }
    .filter("All files", &["*"])
    .directory(start);
    let chosen = dialogs::pick_files(&window, spec).await?;
    if let Some(directory) = chosen.first().and_then(|path| path.parent()) {
        if let Ok(mut last) = LAST_OPEN_DIRECTORY.lock() {
            *last = Some(directory.to_path_buf());
        }
    }
    Ok(chosen
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// The path of `target` as an include stores it: relative to `base` with `/`
/// separators when both are absolute and share a root, else `target` as given.
fn include_path(base: Option<&std::path::Path>, target: &std::path::Path) -> String {
    use std::path::Component;
    let relative = base.and_then(|base| {
        let from: Vec<Component> = base.components().collect();
        let to: Vec<Component> = target.components().collect();
        if !base.is_absolute() || !target.is_absolute() || from.first() != to.first() {
            return None;
        }
        let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
        let mut parts: Vec<String> = vec!["..".to_owned(); from.len() - common];
        parts.extend(
            to[common..]
                .iter()
                .map(|c| c.as_os_str().to_string_lossy().into_owned()),
        );
        Some(parts.join("/"))
    });
    relative.unwrap_or_else(|| target.to_string_lossy().replace('\\', "/"))
}

/// Asks for the worksheet an include region brings in: the path as the
/// region stores it, or `None` when cancelled.
#[tauri::command]
async fn choose_include_path(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: Option<String>,
) -> Result<Option<String>, CommandError> {
    let base = worksheet
        .as_deref()
        .and_then(|id| service.start_location(id, None).directory);
    let start = base
        .clone()
        .or_else(|| {
            LAST_OPEN_DIRECTORY
                .lock()
                .ok()
                .and_then(|last| last.clone())
        })
        .filter(|directory| directory.is_dir());
    let spec = dialogs::DialogSpec::new("Include worksheet")
        .filter("Worksheets (*.eqv)", &["eqv"])
        .filter(".mcdx worksheets (*.mcdx)", &["mcdx"])
        .directory(start);
    let chosen = dialogs::pick_file(&window, spec).await?;
    Ok(chosen.map(|path| include_path(base.as_deref(), &path)))
}

/// Asks for an image file (native Open dialog, filter SVG, PNG, JPEG); `None` when cancelled. The
/// title is neutral because Insert and Replace both use it.
#[tauri::command]
async fn choose_image_path(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: Option<String>,
) -> Result<Option<String>, CommandError> {
    let start = worksheet
        .and_then(|id| service.start_location(&id, None).directory)
        .or_else(|| {
            LAST_OPEN_DIRECTORY
                .lock()
                .ok()
                .and_then(|last| last.clone())
        })
        .filter(|directory| directory.is_dir());
    let spec = dialogs::DialogSpec::new("Choose an image")
        .filter(
            "Images (*.svg, *.png, *.jpg, *.jpeg)",
            &["svg", "png", "jpg", "jpeg"],
        )
        .directory(start);
    let chosen = dialogs::pick_file(&window, spec).await?;
    Ok(chosen.map(|path| path.to_string_lossy().into_owned()))
}

/// Adds an image region from a file (SVG, PNG or JPEG) at a page position; one undo step.
#[tauri::command]
fn add_image(
    service: Shared<'_>,
    worksheet: String,
    path: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<ImageAdded, CommandError> {
    service.add_image_file(&worksheet, Path::new(&path), page, x, y)
}

/// Adds an image region from the base64 content of a file (paste and drop); one undo step.
#[tauri::command]
fn add_image_data(
    service: Shared<'_>,
    worksheet: String,
    data: String,
    page: u32,
    x: f64,
    y: f64,
) -> Result<ImageAdded, CommandError> {
    service.add_image_base64(&worksheet, &data, page, x, y)
}

/// Sets the size in points of an image region; one undo step.
#[tauri::command]
fn set_image_size(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    width: f64,
    height: f64,
) -> Result<EditResult, CommandError> {
    service.set_image_size(&worksheet, &region_id, width, height)
}

/// Sets the size of an image region back to the size of its picture; one undo step.
#[tauri::command]
fn original_image_size(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
) -> Result<EditResult, CommandError> {
    service.original_image_size(&worksheet, &region_id)
}

/// Replaces the picture of an image region with a file; one undo step.
#[tauri::command]
fn replace_image(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    path: String,
) -> Result<ImageAdded, CommandError> {
    service.replace_image(&worksheet, &region_id, Path::new(&path))
}

/// Sets the title, band height and collapsed flag of an area region; one undo step.
#[tauri::command]
fn set_area(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    title: String,
    height: f64,
    collapsed: bool,
) -> Result<EditResult, CommandError> {
    service.set_area(&worksheet, &region_id, title, height, collapsed)
}

/// Disables the given regions (they are no longer calculated) or enables them again; one undo
/// step.
#[tauri::command]
fn set_regions_enabled(
    service: Shared<'_>,
    worksheet: String,
    region_ids: Vec<String>,
    enabled: bool,
) -> Result<EditResult, CommandError> {
    service.set_regions_enabled(&worksheet, region_ids, enabled)
}

/// An image resource as a `data:` URL.
#[tauri::command]
fn image_data(
    service: Shared<'_>,
    worksheet: String,
    resource: String,
) -> Result<String, CommandError> {
    service.image_data_url(&worksheet, &resource)
}

/// Asks where to export the worksheet as PDF (native Save dialog, `*.pdf` filter, starting in the
/// worksheet's folder with its name); `None` when the dialog is cancelled.
#[tauri::command]
async fn choose_pdf_path(
    window: tauri::WebviewWindow,
    service: Shared<'_>,
    worksheet: String,
    suggested: Option<String>,
) -> Result<Option<String>, CommandError> {
    let start = service.start_location(&worksheet, suggested.as_deref());
    let name = Path::new(&start.file_name)
        .with_extension("pdf")
        .to_string_lossy()
        .into_owned();
    let spec = dialogs::DialogSpec::new("Export PDF")
        .filter("PDF (*.pdf)", &["pdf"])
        .directory(start.directory)
        .file_name(name);
    let chosen = dialogs::save_file(&window, spec).await?;
    Ok(chosen.map(|path| {
        let path = if path.extension().is_none() {
            path.with_extension("pdf")
        } else {
            path
        };
        path.to_string_lossy().into_owned()
    }))
}

/// Puts the regions snippet and a PNG picture (base64) on the system clipboard natively.
/// Linux only: on Windows the web view's own clipboard item carries both.
#[tauri::command]
async fn write_clipboard_picture(
    window: tauri::WebviewWindow,
    text: String,
    png: String,
    svg: Option<String>,
) -> Result<(), CommandError> {
    let png = equavela_core::image::base64_decode(&png)
        .map_err(|error| CommandError::internal(error.to_string()))?;
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(snapshot::write_clipboard_linux(text, png, svg));
            })
            .map_err(|error| CommandError::internal(error.to_string()))?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(10))
                .map_err(|error| format!("the clipboard did not answer: {error}"))?
        })
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
        .map_err(CommandError::internal)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (&window, text, png, svg);
        Err(CommandError::internal(
            "the native clipboard picture is written on Linux only".to_string(),
        ))
    }
}

/// Prints the calling web view, which the frontend has put into the print view, to the PDF file
/// `path`: the platform adapter prints, then every page is cropped to exactly
/// `width_pt` x `height_pt` (the page setup's size after the orientation). A test can call this
/// directly with a path; no dialog is involved.
#[tauri::command]
async fn export_pdf(
    window: tauri::WebviewWindow,
    path: String,
    width_pt: f64,
    height_pt: f64,
) -> Result<ExportedPdf, CommandError> {
    let invalid =
        !(width_pt.is_finite() && height_pt.is_finite() && width_pt > 1.0 && height_pt > 1.0);
    if invalid {
        return Err(CommandError::internal(format!(
            "invalid page size {width_pt} x {height_pt} pt"
        )));
    }
    let internal = |message: String| CommandError::internal(message);
    let pending = print::PendingPdf::new(Path::new(&path)).map_err(internal)?;
    let output = pending.path();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    #[cfg(windows)]
    {
        let (width_in, height_in, landscape) = print::request_size(width_pt, height_pt);
        let target = print::plain_path(&output);
        window
            .with_webview(move |webview| {
                print::windows_adapter::print_to_pdf(
                    webview, target, width_in, height_in, landscape, tx,
                )
            })
            .map_err(|error| CommandError::internal(error.to_string()))?;
    }
    #[cfg(target_os = "linux")]
    {
        let target = output.clone();
        let (short, long, linux_landscape) = print::request_linux_size(width_pt, height_pt);
        window
            .with_webview(move |webview| {
                print::linux_adapter::print_to_pdf(
                    webview,
                    &target,
                    short,
                    long,
                    linux_landscape,
                    tx,
                )
            })
            .map_err(|error| CommandError::internal(error.to_string()))?;
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (&window, tx);
        return Err(CommandError::internal(
            "PDF export is not available on this platform".to_string(),
        ));
    }
    // The completion callback runs on the UI thread: wait for it off-thread.
    let waited = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .map_err(|error| format!("the print engine did not answer: {error}"))?
    })
    .await
    .map_err(|error| CommandError::internal(error.to_string()))?;
    waited.map_err(CommandError::internal)?;
    let pages =
        print::crop_to_page(&output, width_pt, height_pt).map_err(CommandError::internal)?;
    let output = pending.publish().map_err(internal)?;
    Ok(ExportedPdf {
        path: print::plain_path(&output),
        pages,
        width_pt,
        height_pt,
    })
}

/// The application settings; the defaults when nothing is stored.
#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> settings::AppSettings {
    app.path().app_config_dir().map_or_else(
        |_| settings::AppSettings::default(),
        |dir| settings::load(&dir),
    )
}

/// Validates and stores the settings in the app config directory; returns what was stored.
#[tauri::command]
fn set_settings(
    app: tauri::AppHandle,
    settings: serde_json::Value,
) -> Result<settings::AppSettings, CommandError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| CommandError::internal(error.to_string()))?;
    settings::store(&dir, &settings).map_err(CommandError::internal)
}

/// The worksheet file named on the command line, if any (opened at start-up).
#[tauri::command]
fn initial_worksheet() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|argument| !argument.starts_with('-') && PathBuf::from(argument).is_file())
}

/// Worksheet paths that other launches of the application asked this instance to open.
#[tauri::command]
fn take_open_requests(requests: State<'_, OpenRequests>) -> Vec<String> {
    requests.take()
}

/// A second launch: queue its file arguments, tell the interface, bring the window to the front.
fn forward_launch(app: &tauri::AppHandle, args: &[String], cwd: &str) {
    let paths = open_request::file_arguments(args.get(1..).unwrap_or_default(), Path::new(cwd));
    if let Some(requests) = app.try_state::<OpenRequests>() {
        requests.push(paths);
    }
    let _ = app.emit(open_request::EVENT_OPEN_REQUEST, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The current view (page setup and regions) of a worksheet.
#[tauri::command]
fn get_view(service: Shared<'_>, worksheet: String) -> Result<DocumentView, CommandError> {
    service.view(&worksheet)
}

/// The whole view and results list of a worksheet, and the revision they now are: the
/// frontend asks for it when it cannot apply a delta, then carries on with the next ones.
#[tauri::command]
fn worksheet_snapshot(
    service: Shared<'_>,
    worksheet: String,
) -> Result<WorksheetSnapshot, CommandError> {
    service.worksheet_snapshot(&worksheet)
}

/// Adds a region (`math`, `text` or `include`) at a page position.
// Keep the existing flat IPC arguments compatible when adding the optional plot size.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn add_region(
    service: Shared<'_>,
    worksheet: String,
    kind: String,
    page: u32,
    x: f64,
    y: f64,
    text: Option<String>,
    plot_size: Option<[f64; 2]>,
) -> Result<EditResult, CommandError> {
    match plot_size {
        Some(size) => service.add_region_with_plot_size(
            &worksheet,
            &kind,
            page,
            x,
            y,
            text.as_deref(),
            Some(size),
        ),
        None => service.add_region(&worksheet, &kind, page, x, y, text.as_deref()),
    }
}

/// Adds a math region from the math editor's AST (`equavela_core::ast::Statement` JSON).
#[tauri::command]
fn add_math_region(
    service: Shared<'_>,
    worksheet: String,
    page: u32,
    x: f64,
    y: f64,
    statement: serde_json::Value,
    breaks: Option<Vec<equavela_core::layout::MathBreak>>,
) -> Result<EditResult, CommandError> {
    service.add_math_region_with_breaks(
        &worksheet,
        page,
        x,
        y,
        statement,
        breaks.unwrap_or_default(),
    )
}

#[tauri::command]
async fn fast_symbolic(
    service: Shared<'_>,
    worksheet: String,
    input: equavela_core::session::FastSymbolicInput,
) -> Result<serde_json::Value, CommandError> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.fast_symbolic(&worksheet, input))
        .await
        .map_err(|error| CommandError::internal(error.to_string()))?
}

/// Replaces a region's math with the math editor's AST; one undo step.
#[tauri::command]
fn set_math(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    statement: serde_json::Value,
    breaks: Option<Vec<equavela_core::layout::MathBreak>>,
) -> Result<EditResult, CommandError> {
    service.set_math_with_breaks(
        &worksheet,
        &region_id,
        statement,
        breaks.unwrap_or_default(),
    )
}

/// Adds a text region from the text editor's value (paragraphs of runs, inline math as AST).
#[tauri::command]
fn add_text_region(
    service: Shared<'_>,
    worksheet: String,
    page: u32,
    x: f64,
    y: f64,
    paragraphs: serde_json::Value,
    full_width: Option<bool>,
) -> Result<EditResult, CommandError> {
    service.add_text_region(
        &worksheet,
        page,
        x,
        y,
        paragraphs,
        full_width.unwrap_or(false),
    )
}

/// Replaces a text region's content with the text editor's value; one undo step.
#[tauri::command]
fn set_text(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    paragraphs: serde_json::Value,
) -> Result<EditResult, CommandError> {
    service.set_text(&worksheet, &region_id, paragraphs)
}

/// Rewrites several regions in one undo step (Replace All).
#[tauri::command]
fn replace_regions(
    service: Shared<'_>,
    worksheet: String,
    rewrites: Vec<service::RegionRewrite>,
) -> Result<EditResult, CommandError> {
    service.replace_regions(&worksheet, rewrites)
}

/// The canonical linear text of a statement (AST JSON): the clipboard form of math.
#[tauri::command]
fn print_math(statement: serde_json::Value) -> Result<String, CommandError> {
    Service::print_math(statement)
}

/// Parses pasted linear math text to the canonical AST.
#[tauri::command]
fn parse_math(text: String) -> Result<serde_json::Value, CommandError> {
    Service::parse_math(&text)
}

/// The canonical linear text of a list of call arguments (`a, b`): the clipboard form of a run.
#[tauri::command]
fn print_math_args(args: serde_json::Value) -> Result<String, CommandError> {
    Service::print_math_args(args)
}

/// Parses pasted linear math text as a list of call arguments (`a, b`).
#[tauri::command]
fn parse_math_args(text: String) -> Result<serde_json::Value, CommandError> {
    Service::parse_math_args(&text)
}

/// Pastes regions from a clipboard snippet (worksheet `regions:` YAML); one undo step.
#[tauri::command]
fn paste_regions(
    service: Shared<'_>,
    worksheet: String,
    page: u32,
    x: f64,
    y: f64,
    snippet: String,
) -> Result<EditResult, CommandError> {
    service.paste_regions(&worksheet, page, x, y, &snippet)
}

/// Moves regions; the whole drag is one undo step. `area_heights` resizes the band of an area in
/// the same step, for a line inserted or removed inside it.
#[tauri::command]
fn move_regions(
    service: Shared<'_>,
    worksheet: String,
    moves: Vec<RegionMove>,
    area_heights: Option<Vec<service::AreaHeight>>,
) -> Result<EditResult, CommandError> {
    service.move_regions(&worksheet, moves, area_heights.unwrap_or_default())
}

/// Replaces the page setup; one undo step.
#[tauri::command]
fn set_page_setup(
    service: Shared<'_>,
    worksheet: String,
    page: equavela_core::layout::PageSetup,
) -> Result<EditResult, CommandError> {
    service.set_page_setup(&worksheet, page)
}

/// Ends the page at `y` points and moves the content below the caret line onto the next page;
/// one undo step for the break and the moves together.
#[tauri::command]
fn add_page_break(
    service: Shared<'_>,
    worksheet: String,
    page: u32,
    y: f64,
    moves: Vec<RegionMove>,
) -> Result<EditResult, CommandError> {
    service.add_page_break(&worksheet, page, y, moves)
}

/// Removes the page break of `page` and moves the content at or after it back up; one undo
/// step.
#[tauri::command]
fn remove_page_break(
    service: Shared<'_>,
    worksheet: String,
    page: u32,
    moves: Vec<RegionMove>,
) -> Result<EditResult, CommandError> {
    service.remove_page_break(&worksheet, page, moves)
}

/// Sets (or with `null` resets) the width of a text region; one undo step.
#[tauri::command]
fn set_region_width(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    width: Option<f64>,
) -> Result<EditResult, CommandError> {
    service.set_region_width(&worksheet, &region_id, width)
}

/// Sets (or with `null` clears) the spelling language of a text region; one undo step.
#[tauri::command]
fn set_text_language(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    language: Option<String>,
) -> Result<EditResult, CommandError> {
    service.set_text_language(&worksheet, &region_id, language)
}

/// Sets (or with `null` entries removes) the spelling keys of the worksheet.
#[tauri::command]
fn set_spelling(
    service: Shared<'_>,
    worksheet: String,
    values: std::collections::BTreeMap<String, Option<String>>,
) -> Result<EditResult, CommandError> {
    service.set_spelling(&worksheet, values)
}

type Spelling<'a> = State<'a, spell::SpellService>;

/// The dictionaries of the catalogue and whether each one can be used.
#[tauri::command]
fn spell_languages(spelling: Spelling<'_>) -> Vec<spell::Language> {
    spelling.languages()
}

/// One flag per word, `true` when it is spelled correctly. Runs off the UI thread.
#[tauri::command(async)]
fn spell_check(
    spelling: Spelling<'_>,
    language: String,
    words: Vec<String>,
) -> Result<spell::SpellCheck, CommandError> {
    spelling
        .check(&language, &words)
        .map_err(CommandError::internal)
}

/// The corrections of a word.
#[tauri::command(async)]
fn spell_suggest(
    spelling: Spelling<'_>,
    language: String,
    word: String,
) -> Result<Vec<String>, CommandError> {
    spelling
        .suggest(&language, &word)
        .map_err(CommandError::internal)
}

/// Adds a word to the user's dictionary.
#[tauri::command]
fn spell_add_word(spelling: Spelling<'_>, word: String) -> Result<(), CommandError> {
    spelling.add_word(&word).map_err(CommandError::internal)
}

/// The licence text of an installed dictionary.
#[tauri::command]
fn spell_license(spelling: Spelling<'_>, language: String) -> Option<String> {
    spelling.license(&language)
}

/// Downloads a dictionary from LibreOffice after the user agreed.
#[tauri::command(async)]
fn spell_install(spelling: Spelling<'_>, language: String) -> Result<(), CommandError> {
    spelling.install(&language).map_err(CommandError::internal)
}

/// Removes a downloaded dictionary.
#[tauri::command]
fn spell_uninstall(spelling: Spelling<'_>, language: String) -> Result<(), CommandError> {
    spelling
        .uninstall(&language)
        .map_err(CommandError::internal)
}

/// Sets (or with `null` clears) the fill of a text region as `#rrggbb`; one undo step.
#[tauri::command]
fn set_text_background(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    background: Option<String>,
) -> Result<EditResult, CommandError> {
    service.set_text_background(&worksheet, &region_id, background)
}

/// Sets (or with `null` clears) the numeric choices of a math region; one undo step.
#[tauri::command]
fn set_numeric_options(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    options: Option<std::collections::BTreeMap<String, String>>,
) -> Result<EditResult, CommandError> {
    service.set_numeric_options(&worksheet, &region_id, options)
}

/// Sets (or with `null` clears) the result-format override of a math region; one undo step.
#[tauri::command]
fn set_result_format(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    format: Option<std::collections::BTreeMap<String, String>>,
) -> Result<EditResult, CommandError> {
    service.set_result_format(&worksheet, &region_id, format)
}

/// Sets the math font of the given math regions; one undo step for
/// the whole command, labelled `Math font` or, for a reset, `Reset math style`.
#[tauri::command]
fn set_math_font(
    service: Shared<'_>,
    worksheet: String,
    edits: Vec<MathFontEdit>,
    reset: bool,
) -> Result<EditResult, CommandError> {
    service.set_math_font(&worksheet, edits, reset)
}

/// Sets (or with `null` entries removes) the worksheet-wide result-format defaults; one
/// undo step.
#[tauri::command]
fn set_result_defaults(
    service: Shared<'_>,
    worksheet: String,
    values: std::collections::BTreeMap<String, Option<String>>,
) -> Result<EditResult, CommandError> {
    service.set_result_defaults(&worksheet, values)
}

/// Sets (or with `null` entries removes) the worksheet calculation settings, `TOL` and `CTOL`;
/// one undo step and a recalculation of the whole worksheet.
#[tauri::command]
fn set_label_styles(
    service: Shared<'_>,
    worksheet: String,
    values: std::collections::BTreeMap<String, Option<String>>,
) -> Result<EditResult, CommandError> {
    service.set_label_styles(&worksheet, values)
}

/// Replaces the code of a Julia block.
#[tauri::command]
fn set_julia_code(
    service: Shared<'_>,
    worksheet: String,
    region: String,
    code: String,
) -> Result<EditResult, CommandError> {
    service.set_julia_code(&worksheet, &region, &code)
}

/// Trusts a worksheet or takes the trust back.
#[tauri::command]
fn set_worksheet_trusted(
    service: Shared<'_>,
    worksheet: String,
    trusted: bool,
) -> Result<EditResult, CommandError> {
    service.set_worksheet_trusted(&worksheet, trusted)
}

/// Plays or stops a Julia block.
#[tauri::command]
fn set_julia_playing(
    service: Shared<'_>,
    worksheet: String,
    region: String,
    playing: bool,
) -> Result<EditResult, CommandError> {
    service.set_julia_playing(&worksheet, &region, playing)
}

/// Runs a Julia block again with what depends on it.
#[tauri::command]
fn run_region(
    service: Shared<'_>,
    worksheet: String,
    region: String,
) -> Result<EditResult, CommandError> {
    service.run_region(&worksheet, &region)
}

/// Sets (or with two `null`s clears) the size of the box a Julia block is drawn in; one undo step.
#[tauri::command]
fn set_julia_size(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<EditResult, CommandError> {
    let size = match (width, height) {
        (Some(width), Some(height)) => Some((width, height)),
        // A box needs both sides: a lone width is a caller error and clears the stored size.
        _ => None,
    };
    service.set_julia_size(&worksheet, &region_id, size)
}

#[tauri::command]
fn set_calculation_settings(
    service: Shared<'_>,
    worksheet: String,
    values: std::collections::BTreeMap<String, Option<String>>,
) -> Result<EditResult, CommandError> {
    service.set_calculation_settings(&worksheet, values)
}

#[tauri::command]
fn set_plot(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    plot: equavela_core::plot::PlotSpec,
) -> Result<EditResult, CommandError> {
    service.set_plot(&worksheet, &region_id, plot)
}

/// The transient on-screen x range of a plot, which resamples its implicit x traces:
/// `None` ends mean reset-to-data-range. Not an undo step and not a
/// change to the worksheet. Returns whether the plot has something new to draw.
/// Replaces the path of an include region with the text the user typed (GitHub ).
#[tauri::command]
fn set_include_path(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    path: String,
) -> Result<EditResult, CommandError> {
    service.set_include_path(&worksheet, &region_id, &path)
}

#[tauri::command]
fn set_plot_view(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
    x_min: Option<f64>,
    x_max: Option<f64>,
) -> Result<bool, CommandError> {
    service.set_plot_view(&worksheet, &region_id, x_min, x_max)
}

#[tauri::command]
fn remove_regions(
    service: Shared<'_>,
    worksheet: String,
    region_ids: Vec<String>,
) -> Result<EditResult, CommandError> {
    service.remove_regions(&worksheet, region_ids)
}

#[tauri::command]
fn undo(service: Shared<'_>, worksheet: String) -> Result<EditResult, CommandError> {
    service.undo(&worksheet)
}

#[tauri::command]
fn redo(service: Shared<'_>, worksheet: String) -> Result<EditResult, CommandError> {
    service.redo(&worksheet)
}

#[tauri::command]
fn close_worksheet(service: Shared<'_>, worksheet: String) -> Result<(), CommandError> {
    service.close_worksheet(&worksheet)
}

/// Replaces the math text of a region; returns the regions that became stale.
#[tauri::command]
fn edit_region(
    service: Shared<'_>,
    worksheet: String,
    document: String,
    region_id: String,
    text: String,
) -> Result<Vec<RegionKey>, CommandError> {
    service.edit_region(&worksheet, &document, &region_id, &text)
}

/// Starts a calculation (`all`: Ctrl+F5, otherwise F5); progress arrives as events.
#[tauri::command]
fn recalculate(service: Shared<'_>, worksheet: String, all: bool) -> Result<(), CommandError> {
    service.inner().recalculate(&worksheet, all)
}

/// Interrupts the running calculation.
#[tauri::command]
fn interrupt(service: Shared<'_>, worksheet: String) -> Result<bool, CommandError> {
    service.interrupt(&worksheet)
}

/// Names, references, include tree and unit warnings of a worksheet.
#[tauri::command]
fn inspect(service: Shared<'_>, worksheet: String) -> Result<Inspection, CommandError> {
    service.inspect(&worksheet)
}

/// The unit warnings of a worksheet (underlines and the Problems count); `inspect` without the
/// names, so the UI can ask for it after every edit.
#[tauri::command]
fn inspect_warnings(
    service: Shared<'_>,
    worksheet: String,
) -> Result<Vec<WarningInfo>, CommandError> {
    service.inspect_warnings(&worksheet)
}

/// Current values of definitions (name as written and version), read from the kernel.
#[tauri::command]
fn definition_values(
    service: Shared<'_>,
    worksheet: String,
    items: Vec<DefinitionRef>,
) -> Result<Vec<DefinitionValue>, CommandError> {
    service.definition_values(&worksheet, items)
}

#[tauri::command]
fn get_results(service: Shared<'_>, worksheet: String) -> Result<Vec<RegionEntry>, CommandError> {
    service.results(&worksheet)
}

/// A block of a large matrix result, column-major.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn result_block(
    service: Shared<'_>,
    worksheet: String,
    key: RegionKey,
    row: usize,
    col: usize,
    rows: usize,
    cols: usize,
) -> Result<Vec<equavela_core::kernel_value::KernelValue>, CommandError> {
    service.result_block(&worksheet, &key, row, col, rows, cols)
}

/// The calculated data of one plot region as a raw binary frame (`plot_data` in the
/// service); the arrays are not JSON numbers.
#[tauri::command]
fn get_plot_data(
    service: Shared<'_>,
    worksheet: String,
    region_id: String,
) -> Result<tauri::ipc::Response, CommandError> {
    service
        .plot_data(&worksheet, &region_id)
        .map(tauri::ipc::Response::new)
}

/// Equavela was called MathMaster: its settings, recovery data, web view storage, Python
/// environment and worksheet environments move once to the folders of the new name.
fn adopt_former_app_folders() {
    const RENAMED: [(&str, &str); 2] = [
        ("local.mathmaster.desktop", "local.equavela.desktop"),
        ("mathmaster", "equavela"),
    ];
    let mut seen = Vec::new();
    for base in [
        dirs::config_dir(),
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::cache_dir(),
    ]
    .into_iter()
    .flatten()
    {
        if seen.contains(&base) {
            continue;
        }
        for (former, current) in RENAMED {
            let (from, to) = (base.join(former), base.join(current));
            if from.is_dir() && !to.exists() {
                let _ = std::fs::rename(&from, &to);
            }
        }
        seen.push(base);
    }
}

pub fn run() {
    if std::env::var_os("EQUAVELA_DRIVER_DATA_DIR").is_none() {
        adopt_former_app_folders();
    }
    #[cfg(any(target_os = "linux", windows))]
    let _crash_reporter = crash_reports::start();
    let builder = tauri::Builder::default();
    // Explicit opt-in for the local regression driver; ordinary builds do not include this hook.
    #[cfg(all(feature = "e2e-print", debug_assertions, target_os = "linux"))]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished || webview.label() != "main" {
            return;
        }
        if let (Ok(endpoint), Ok(output)) = (
            std::env::var("EQUAVELA_E2E_PRINT_ENDPOINT"),
            std::env::var("EQUAVELA_E2E_PRINT_OUTPUT"),
        ) {
            use webkit2gtk::WebViewExt;
            let screenshot = format!("{output}.png");
            let _ = webview.with_webview(move |platform| {
                let view = platform.inner();
                view.connect_title_notify(move |view| {
                    if view.title().as_deref() != Some("equavela-e2e-snapshot") {
                        return;
                    }
                    let destination = screenshot.clone();
                    view.snapshot(
                        webkit2gtk::SnapshotRegion::FullDocument,
                        webkit2gtk::SnapshotOptions::empty(),
                        None::<&gtk::gio::Cancellable>,
                        move |snapshot| {
                            let saved =
                                snapshot
                                    .map_err(|error| error.to_string())
                                    .and_then(|surface| {
                                        let image = gtk::cairo::ImageSurface::try_from(surface)
                                            .map_err(|error| error.to_string())?;
                                        let pixbuf = gtk::gdk::pixbuf_get_from_surface(
                                            &image,
                                            0,
                                            0,
                                            image.width(),
                                            image.height(),
                                        )
                                        .ok_or("snapshot could not be read")?;
                                        pixbuf
                                            .savev(&destination, "png", &[])
                                            .map_err(|error| error.to_string())
                                    });
                            if let Err(error) = saved {
                                eprintln!("e2e print snapshot failed: {error}");
                            }
                        },
                    );
                });
            });
            let script = include_str!("../../scripts/e2e-linux-print-injected.js")
                .replace("__ENDPOINT__", &serde_json::to_string(&endpoint).unwrap())
                .replace("__OUTPUT__", &serde_json::to_string(&output).unwrap());
            let _ = webview.eval(script);
        }
    });
    // Explicit opt-in for the GUI latency benchmark: the page runs the benchmark on the
    // worksheet it opened and posts the report to the driver's local endpoint. Release builds may enable
    // it (the numbers must come from optimised code); packaging never does.
    #[cfg(feature = "e2e-perf")]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished || webview.label() != "main" {
            return;
        }
        if let Ok(endpoint) = std::env::var("EQUAVELA_E2E_PERF_ENDPOINT") {
            let options =
                std::env::var("EQUAVELA_E2E_PERF_OPTIONS").unwrap_or_else(|_| "{}".into());
            let script = include_str!("../../scripts/perf-real-injected.js")
                .replace("__ENDPOINT__", &serde_json::to_string(&endpoint).unwrap())
                .replace("__OPTIONS__", &options);
            let _ = webview.eval(script);
        }
    });
    // Explicit opt-in for the project UI driver.
    #[cfg(feature = "e2e-project")]
    let builder = builder.on_page_load(|webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished || webview.label() != "main" {
            return;
        }
        if let Ok(endpoint) = std::env::var("EQUAVELA_E2E_PROJECT_ENDPOINT") {
            let options =
                std::env::var("EQUAVELA_E2E_PROJECT_OPTIONS").unwrap_or_else(|_| "{}".into());
            let script = include_str!("../../scripts/e2e-project-injected.js")
                .replace("__ENDPOINT__", &serde_json::to_string(&endpoint).unwrap())
                .replace("__OPTIONS__", &options);
            let _ = webview.eval(script);
        }
    });
    // One instance per user; `EQUAVELA_MULTI_INSTANCE=1` lets test drivers start several.
    let builder = if std::env::var_os("EQUAVELA_MULTI_INSTANCE").is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            forward_launch(app, &args, &cwd);
        }))
    };
    let app = builder
        .manage(OpenRequests::default())
        .manage(spell::SpellService::default())
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                browser_shortcuts::configure(&window)?;
            }
            let handle = app.handle().clone();
            let sink: EventSink = Arc::new(move |name, payload| {
                let _ = handle.emit(name, payload);
            });
            let inputs = LocationInputs::from_environment(app.path().resource_dir().ok());
            let service = Service::new(sink, inputs);
            // Test drivers (app/scripts/real-app.mjs) keep their runs out of the user's way: their own
            // recovery folder (so they never meet, or touch, the user's backups) and, with
            // EQUAVELA_DRIVER_OFFSCREEN, a window parked far outside the screens that cannot take focus.
            if let Some(dir) = std::env::var_os("EQUAVELA_DRIVER_DATA_DIR") {
                service.set_environments_dir(PathBuf::from(&dir).join("environments"));
            }
            if let Some(dir) = std::env::var_os("EQUAVELA_DRIVER_DATA_DIR") {
                service.set_recovery_dir(PathBuf::from(dir).join("recovery"));
            } else if let Ok(dir) = app.path().app_data_dir() {
                service.set_recovery_dir(dir.join("recovery"));
            }
            // The worksheets this user trusts. A test driver keeps its
            // own list, so it never trusts or forgets a worksheet of the user.
            if let Some(dir) = std::env::var_os("EQUAVELA_DRIVER_DATA_DIR") {
                service.set_config_dir(PathBuf::from(dir));
            } else if let Ok(dir) = app.path().app_config_dir() {
                service.set_config_dir(dir);
            }
            if std::env::var_os("EQUAVELA_DRIVER_OFFSCREEN").is_some() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focusable(false);
                    let _ = window.set_position(tauri::PhysicalPosition::new(-32000, -32000));
                }
            }
            app.manage(service);
            open_splash(app)?;
            // The downloaded dictionaries and the user's words; a test driver keeps its own.
            let spelling_dir = std::env::var_os("EQUAVELA_DRIVER_DATA_DIR")
                .map(PathBuf::from)
                .or_else(|| app.path().app_data_dir().ok())
                .map(|dir| dir.join("spelling"));
            if let Some(dir) = spelling_dir {
                app.state::<spell::SpellService>().set_dir(dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_ready,
            open_manual,
            core_version,
            kernel_status,
            start_kernel,
            open_worksheet,
            new_worksheet,
            new_project,
            convert_to_project,
            project_tree,
            project_image_usage,
            project_create,
            project_rename,
            project_move,
            project_move_many,
            project_delete,
            project_delete_many,
            project_import,
            project_reveal,
            project_read_text,
            project_write_text,
            write_project_text_recovery,
            project_text_recovery_for,
            discard_project_text_recovery,
            list_project_text_recoveries,
            read_project_text_recovery,
            export_project_text_recovery,
            discard_project_text_recovery_entry,
            project_image,
            project_open_external,
            project_references,
            project_set_export,
            project_add_reference,
            project_reference_command,
            develop_reference_package,
            project_set_julia_module,
            reveal_file,
            complete_code,
            repl_eval,
            terminal_open,
            terminal_read,
            terminal_write,
            terminal_resize,
            repl_interrupt,
            repl_restart,
            worksheet_module_names,
            repl_complete,
            open_project,
            list_project_assets,
            pack_project_archive,
            extract_project_archive,
            environment_info,
            set_worksheet_environment,
            choose_worksheet_environment,
            preview_environment_switch,
            choose_environment_switch,
            choose_folder,
            commit_environment_switch,
            change_packages,
            revert_environment_change,
            restart_environment_kernel,
            manage_environment,
            set_compatibility,
            read_environment_metadata,
            copy_worksheet_environment,
            save_worksheet,
            save_worksheet_as,
            write_recovery,
            recovery_for,
            discard_recovery_file,
            pending_recoveries,
            open_recovery,
            import_mcdx,
            choose_open_paths,
            choose_pdf_path,
            choose_include_path,
            choose_image_path,
            add_image,
            add_image_data,
            set_image_size,
            original_image_size,
            replace_image,
            set_area,
            set_regions_enabled,
            image_data,
            export_pdf,
            write_clipboard_picture,
            get_settings,
            set_settings,
            initial_worksheet,
            take_open_requests,
            get_view,
            worksheet_snapshot,
            add_region,
            add_math_region,
            set_math,
            fast_symbolic,
            add_text_region,
            set_text,
            replace_regions,
            print_math,
            parse_math,
            print_math_args,
            parse_math_args,
            paste_regions,
            move_regions,
            add_page_break,
            remove_page_break,
            set_region_width,
            set_text_background,
            set_text_language,
            set_spelling,
            spell_languages,
            spell_check,
            spell_suggest,
            spell_add_word,
            spell_license,
            spell_install,
            spell_uninstall,
            set_page_setup,
            set_result_format,
            set_numeric_options,
            set_math_font,
            set_result_defaults,
            set_calculation_settings,
            set_label_styles,
            set_julia_code,
            set_julia_playing,
            set_julia_size,
            set_worksheet_trusted,
            run_region,
            inspect,
            inspect_warnings,
            definition_values,
            set_plot,
            set_include_path,
            set_plot_view,
            remove_regions,
            undo,
            redo,
            close_worksheet,
            edit_region,
            recalculate,
            interrupt,
            get_results,
            result_block,
            get_plot_data,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the Equavela application");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(service) = handle.try_state::<Arc<Service>>() {
                service.shutdown();
            }
        }
    });
}

#[cfg(test)]
mod explorer_select_tests {
    use super::explorer_select_arg;

    #[test]
    fn a_project_path_reaches_explorer_with_backslashes_and_quoted() {
        assert_eq!(
            explorer_select_arg(r"C:\Users\a b\proj\sub/file.eqv"),
            r#"/select,"C:\Users\a b\proj\sub\file.eqv""#
        );
    }

    #[test]
    fn a_canonical_path_loses_its_verbatim_prefix() {
        assert_eq!(
            explorer_select_arg(r"\\?\C:\proj\a.eqv"),
            r#"/select,"C:\proj\a.eqv""#
        );
        assert_eq!(
            explorer_select_arg(r"\\?\UNC\server\share\a.eqv"),
            r#"/select,"\\server\share\a.eqv""#
        );
    }
}

#[cfg(test)]
mod include_path_tests {
    #[cfg(unix)]
    use super::include_path;
    #[cfg(unix)]
    use std::path::Path;

    #[test]
    #[cfg(unix)]
    fn a_saved_worksheet_stores_the_path_relative_to_its_folder() {
        let base = Path::new("/home/a/proj");
        assert_eq!(
            include_path(Some(base), Path::new("/home/a/proj/libs/h.eqv")),
            "libs/h.eqv"
        );
        assert_eq!(
            include_path(Some(base), Path::new("/home/a/other/h.eqv")),
            "../other/h.eqv"
        );
        assert_eq!(
            include_path(Some(base), Path::new("/home/a/proj/h.eqv")),
            "h.eqv"
        );
    }

    #[test]
    #[cfg(unix)]
    fn an_untitled_worksheet_stores_the_absolute_path() {
        assert_eq!(
            include_path(None, Path::new("/home/a/proj/h.eqv")),
            "/home/a/proj/h.eqv"
        );
    }
}
