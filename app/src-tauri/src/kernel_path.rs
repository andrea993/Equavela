//! Locating the Julia kernel.
//!
//! Two things must be found: the `EquavelaKernel` Julia project directory (it contains
//! `bin/kernel.jl`) and the Julia executable. Both are looked up in a fixed order, so the
//! same code runs in development (repository checkout), from an installed package and on
//! both Windows and Linux. Nothing here spawns a process; the result is a
//! [`KernelConfig`] for the core `KernelManager`.
//!
//! Kernel project, first hit wins:
//! 1. the `EQUAVELA_KERNEL_DIR` environment variable (an explicit override);
//! 2. `<resource dir>/kernel/EquavelaKernel`;
//! 3. `<executable dir>/kernel/EquavelaKernel`, `<executable dir>/../lib/Equavela/kernel/EquavelaKernel`
//!    and `<executable dir>/../lib/equavela/kernel/EquavelaKernel`
//!    (portable layouts, Linux `/usr/lib` style packages);
//! 4. the repository's `kernel/EquavelaKernel`, compiled in from `CARGO_MANIFEST_DIR`
//!    (development builds only, and only if the directory exists on this machine).
//!
//! Julia executable, first hit wins:
//! 1. the `EQUAVELA_JULIA` environment variable;
//! 2. a Julia runtime bundled next to the kernel: `<kernel parent>/julia/bin/julia[.exe]`;
//! 3. `julia` on `PATH` (juliaup shims are resolved to the real executable by the
//!    kernel manager).
//!
//! Sysimage, first hit wins:
//! 1. the `EQUAVELA_SYSIMAGE` environment variable (`off`, `none`, `0` or `false` disable it);
//! 2. `<kernel parent>/../sysimage/equavelakernel.<dll|so|dylib>` next to the bundled kernel
//!    directory (the packaging step ships one next to the bundled Julia);
//! 3. the repository's `build/sysimage/equavelakernel.<ext>`, only for the repository kernel
//!    and only if no kernel source file is newer than the image (a stale image would run
//!    old kernel code, because a sysimage replaces the sources).
//!
//! A missing file is not an error, and the kernel manager falls back to the stock Julia
//! runtime when Julia rejects the image.
//!
//! Python environment of the symbolic engine, passed to the kernel as
//! environment variables:
//! - `JULIA_CONDAPKG_ENV`: the `EQUAVELA_PYTHON_ENV`/`JULIA_CONDAPKG_ENV` override, else a
//!   short per-user directory (`%LOCALAPPDATA%\equavela\py` on Windows,
//!   `$XDG_DATA_HOME/equavela/py` or `~/.local/share/equavela/py` elsewhere): the environment has
//!   about 8000 files, so a long path would hit the Windows path limit;
//! - `JULIA_CONDAPKG_OFFLINE=yes` once Python and the XLS packages are present;
//!   an inherited `JULIA_CONDAPKG_OFFLINE` wins.
//!
//! Installed package: the Python environment
//! shipped in `<root>/python` is used as it is (`JULIA_PYTHONCALL_EXE`, `JULIA_CONDAPKG_BACKEND=Null`:
//! no resolve, no network) and `JULIA_DEPOT_PATH` is the per-user `<data>/local.equavela.desktop/depot` followed by
//! the shipped read-only `<root>/depot` (the JLL artifacts that CondaPkg's packages look up at
//! load); inherited values of both variables win.

use equavela_core::kernel_manager::KernelConfig;
use std::path::{Path, PathBuf};

/// Everything the lookup depends on, so it can be tested without touching the real
/// environment.
#[derive(Debug, Clone, Default)]
pub struct LocationInputs {
    pub kernel_dir_override: Option<PathBuf>,
    pub julia_override: Option<PathBuf>,
    pub sysimage_override: Option<PathBuf>,
    /// `EQUAVELA_PYTHON_ENV` or `JULIA_CONDAPKG_ENV`: where the Python environment lives.
    pub python_env_override: Option<PathBuf>,
    /// `JULIA_CONDAPKG_OFFLINE` as inherited from the process, if set.
    pub conda_offline_override: Option<std::ffi::OsString>,
    /// `JULIA_DEPOT_PATH` as inherited from the process, if set.
    pub depot_override: Option<std::ffi::OsString>,
    /// `JULIA_PYTHONCALL_EXE` as inherited from the process, if set.
    pub python_exe_override: Option<std::ffi::OsString>,
    /// The per-user data directory (`%LOCALAPPDATA%`, `$XDG_DATA_HOME`, `~/.local/share`).
    pub data_dir: Option<PathBuf>,
    /// The Tauri resource directory of an installed app.
    pub resource_dir: Option<PathBuf>,
    pub executable_dir: Option<PathBuf>,
    /// The repository checkout this binary was built from, if any.
    pub dev_repository: Option<PathBuf>,
}

impl LocationInputs {
    /// The inputs of the running process.
    pub fn from_environment(resource_dir: Option<PathBuf>) -> Self {
        LocationInputs {
            kernel_dir_override: std::env::var_os("EQUAVELA_KERNEL_DIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            julia_override: std::env::var_os("EQUAVELA_JULIA")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            sysimage_override: std::env::var_os("EQUAVELA_SYSIMAGE")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            python_env_override: std::env::var_os("EQUAVELA_PYTHON_ENV")
                .or_else(|| std::env::var_os("JULIA_CONDAPKG_ENV"))
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
            conda_offline_override: std::env::var_os("JULIA_CONDAPKG_OFFLINE")
                .filter(|value| !value.is_empty()),
            depot_override: std::env::var_os("JULIA_DEPOT_PATH").filter(|value| !value.is_empty()),
            python_exe_override: std::env::var_os("JULIA_PYTHONCALL_EXE")
                .filter(|value| !value.is_empty()),
            data_dir: user_data_dir(),
            resource_dir,
            executable_dir: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            // `app/src-tauri` is two levels below the repository root.
            dev_repository: Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf),
        }
    }
}

/// The per-user data directory of this platform.
pub(crate) fn user_data_dir() -> Option<PathBuf> {
    let non_empty = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
    if cfg!(windows) {
        non_empty("LOCALAPPDATA").map(PathBuf::from)
    } else {
        non_empty("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| non_empty("HOME").map(|home| PathBuf::from(home).join(".local/share")))
    }
}

fn is_kernel_project(dir: &Path) -> bool {
    dir.join("bin").join("kernel.jl").is_file()
}

/// Finds the `EquavelaKernel` project directory.
pub fn find_kernel_project(inputs: &LocationInputs) -> Result<PathBuf, String> {
    if let Some(dir) = &inputs.kernel_dir_override {
        return if is_kernel_project(dir) {
            Ok(dir.clone())
        } else {
            Err(format!(
                "EQUAVELA_KERNEL_DIR is set to `{}`, which does not contain bin/kernel.jl",
                dir.display()
            ))
        };
    }
    let mut candidates = Vec::new();
    if let Some(resources) = &inputs.resource_dir {
        candidates.push(resources.join("kernel").join("EquavelaKernel"));
    }
    if let Some(exe_dir) = &inputs.executable_dir {
        candidates.push(exe_dir.join("kernel").join("EquavelaKernel"));
        for lib_name in ["Equavela", "equavela"] {
            candidates.push(
                exe_dir
                    .join("..")
                    .join("lib")
                    .join(lib_name)
                    .join("kernel")
                    .join("EquavelaKernel"),
            );
        }
    }
    if let Some(repository) = &inputs.dev_repository {
        candidates.push(repository.join("kernel").join("EquavelaKernel"));
    }
    for candidate in &candidates {
        if is_kernel_project(candidate) {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "the Julia kernel project (kernel/EquavelaKernel) was not found; looked in: {}. \
         Set EQUAVELA_KERNEL_DIR to override.",
        candidates
            .iter()
            .map(|path| format!("`{}`", path.display()))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

/// The name of the Julia executable on this platform.
pub fn julia_file_name() -> &'static str {
    if cfg!(windows) {
        "julia.exe"
    } else {
        "julia"
    }
}

/// Finds the Julia executable: override, bundled runtime, then `PATH`.
pub fn find_julia(inputs: &LocationInputs, kernel_project: &Path) -> PathBuf {
    if let Some(julia) = &inputs.julia_override {
        return julia.clone();
    }
    // `<kernel>/../julia/bin/julia` next to the bundled kernel directory.
    if let Some(root) = kernel_project.parent().and_then(Path::parent) {
        let bundled = root.join("julia").join("bin").join(julia_file_name());
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("julia")
}

/// The file name of the kernel sysimage on this platform (`equavelakernel.dll` / `.so` /
/// `.dylib`, the extension Julia's `Libdl.dlext` reports).
pub fn sysimage_file_name() -> &'static str {
    if cfg!(windows) {
        "equavelakernel.dll"
    } else if cfg!(target_os = "macos") {
        "equavelakernel.dylib"
    } else {
        "equavelakernel.so"
    }
}

fn sysimage_disabled(path: &Path) -> bool {
    path.to_str().is_some_and(|text| {
        ["off", "none", "0", "false"].contains(&text.to_ascii_lowercase().as_str())
    })
}

/// The newest modification time of the files that make up the kernel (the EquavelaKernel and
/// EqRuntime sources and manifests).
fn newest_kernel_source(kernel_project: &Path) -> Option<std::time::SystemTime> {
    const MAX_DEPTH: usize = 32;
    fn is_reparse_point(meta: &std::fs::Metadata) -> bool {
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
    fn visit(path: &Path, depth: usize, newest: &mut Option<std::time::SystemTime>) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return;
        };
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return;
        }
        if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    visit(&entry.path(), depth + 1, newest);
                }
            }
        } else if let Ok(modified) = meta.modified() {
            if newest.is_none_or(|current| modified > current) {
                *newest = Some(modified);
            }
        }
    }
    let mut newest = None;
    let runtime = kernel_project.parent()?.join("EqRuntime");
    for root in [kernel_project, runtime.as_path()] {
        for item in ["src", "Project.toml", "Manifest.toml"] {
            visit(&root.join(item), 0, &mut newest);
        }
    }
    newest
}

/// True if a kernel source file is newer than the image.
fn sysimage_is_stale(image: &Path, kernel_project: &Path) -> bool {
    let Some(built) = std::fs::metadata(image)
        .and_then(|meta| meta.modified())
        .ok()
    else {
        return true;
    };
    newest_kernel_source(kernel_project).is_some_and(|source| source > built)
}

/// Finds the kernel sysimage, if there is a usable one (see the module documentation).
pub fn find_sysimage(inputs: &LocationInputs, kernel_project: &Path) -> Option<PathBuf> {
    if let Some(path) = &inputs.sysimage_override {
        return if sysimage_disabled(path) || !path.is_file() {
            None
        } else {
            Some(path.clone())
        };
    }
    // `<root>/kernel/EquavelaKernel` -> `<root>/sysimage/equavelakernel.<ext>`
    if let Some(root) = kernel_project.parent().and_then(Path::parent) {
        let bundled = root.join("sysimage").join(sysimage_file_name());
        if bundled.is_file() {
            return Some(bundled);
        }
    }
    if let Some(repository) = &inputs.dev_repository {
        if kernel_project == repository.join("kernel").join("EquavelaKernel") {
            let built = repository
                .join("build")
                .join("sysimage")
                .join(sysimage_file_name());
            if built.is_file() && !sysimage_is_stale(&built, kernel_project) {
                return Some(built);
            }
        }
    }
    None
}

/// The directory of the Python environment of the symbolic engine.
pub fn python_env_dir(inputs: &LocationInputs) -> Option<PathBuf> {
    inputs.python_env_override.clone().or_else(|| {
        inputs
            .data_dir
            .as_ref()
            .map(|dir| dir.join("equavela").join("py"))
    })
}

/// Whether the environment contains Python and the packages needed by the XLS bridge.
fn python_env_is_resolved(dir: &Path) -> bool {
    if !(dir.join("python.exe").is_file() || dir.join("bin").join("python").is_file()) {
        return false;
    }
    let has_packages = |site: &Path| {
        ["xlrd", "xlwt", "xlutils"]
            .iter()
            .all(|name| site.join(name).is_dir())
    };
    has_packages(&dir.join("Lib").join("site-packages"))
        || std::fs::read_dir(dir.join("lib")).is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry.file_name().to_string_lossy().starts_with("python")
                    && has_packages(&entry.path().join("site-packages"))
            })
        })
}

/// The Python interpreter shipped next to the kernel, if any.
pub fn find_bundled_python(kernel_project: &Path) -> Option<PathBuf> {
    let root = kernel_project.parent().and_then(Path::parent)?;
    let python = root.join("python");
    [python.join("python.exe"), python.join("bin").join("python")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// True when a Julia runtime ships next to the kernel: an installed package.
fn is_installed_layout(kernel_project: &Path) -> bool {
    kernel_project
        .parent()
        .and_then(Path::parent)
        .is_some_and(|root| {
            root.join("julia")
                .join("bin")
                .join(julia_file_name())
                .is_file()
        })
}

/// The name of the application's own per-user data directory: the Tauri identifier
/// (`app/src-tauri/tauri.conf.json`), which is also Tauri's app local data directory. It must differ
/// from the install directory: the default per-user install directory of the Windows installer is
/// `%LOCALAPPDATA%\Equavela`, and uninstalling removes it entirely.
const APP_DATA_NAME: &str = "local.equavela.desktop";

/// The per-user Julia depot of an installed app: `<data>/local.equavela.desktop/depot`.
/// Writable, so packages of `julia` regions and pkgimages have a place; read-only
/// install directories are never written.
pub fn depot_dir(inputs: &LocationInputs) -> Option<PathBuf> {
    inputs
        .data_dir
        .as_ref()
        .map(|dir| dir.join(APP_DATA_NAME).join("depot"))
}

/// The kernel environment of an installed app: the shipped Python environment is used
/// as it is (no CondaPkg resolve, no network), the depot is per user.
pub fn installed_env(
    inputs: &LocationInputs,
    python: Option<&Path>,
    shipped_depot: Option<&Path>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = Vec::new();
    if let Some(python) = python {
        if inputs.python_exe_override.is_none() {
            env.push(("JULIA_PYTHONCALL_EXE".into(), python.as_os_str().to_owned()));
        }
        env.push(("JULIA_CONDAPKG_BACKEND".into(), "Null".into()));
    }
    if inputs.depot_override.is_none() {
        if let Some(depot) = depot_dir(inputs) {
            // The shipped depot (`<root>/depot`, JLL artifacts only) is read-only and comes second.
            let mut depots = vec![depot];
            if let Some(shipped) = shipped_depot {
                depots.push(shipped.to_owned());
            }
            if let Ok(joined) = std::env::join_paths(depots) {
                env.push(("JULIA_DEPOT_PATH".into(), joined));
            }
        }
    }
    env
}

/// The extra environment variables of the kernel process (see the module documentation).
pub fn kernel_env(inputs: &LocationInputs) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    let mut env = Vec::new();
    if let Some(dir) = python_env_dir(inputs) {
        let offline = inputs
            .conda_offline_override
            .clone()
            .or_else(|| python_env_is_resolved(&dir).then(|| "yes".into()));
        env.push(("JULIA_CONDAPKG_ENV".into(), dir.into_os_string()));
        if let Some(offline) = offline {
            env.push(("JULIA_CONDAPKG_OFFLINE".into(), offline));
        }
    }
    env
}

/// The kernel configuration for this machine.
pub fn resolve_kernel_config(inputs: &LocationInputs) -> Result<KernelConfig, String> {
    let project = find_kernel_project(inputs)?;
    let julia = find_julia(inputs, &project);
    let sysimage = find_sysimage(inputs, &project);
    let mut config = KernelConfig::new(project).with_julia(julia);
    config.terminal = true;
    config.sysimage = sysimage;
    // the first start of an installed kernel precompiles EquavelaKernel and the
    // symbolic stack into the per-user depot, which takes minutes on a slow machine.
    if is_installed_layout(&config.project) {
        config.startup_timeout = std::time::Duration::from_secs(900);
    }
    config.env = if is_installed_layout(&config.project) {
        // The first start creates the per-user depot; a failure is not fatal, Julia reports it.
        if inputs.depot_override.is_none() {
            if let Some(depot) = depot_dir(inputs) {
                let _ = std::fs::create_dir_all(depot);
            }
        }
        let root = config.project.parent().and_then(Path::parent);
        let shipped_depot = root
            .map(|root| root.join("depot"))
            .filter(|dir| dir.is_dir());
        installed_env(
            inputs,
            find_bundled_python(&config.project).as_deref(),
            shipped_depot.as_deref(),
        )
    } else {
        kernel_env(inputs)
    };
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_kernel(root: &Path) -> PathBuf {
        let project = root.join("kernel").join("EquavelaKernel");
        fs::create_dir_all(project.join("bin")).unwrap();
        fs::write(project.join("bin").join("kernel.jl"), "# kernel").unwrap();
        project
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "equavela-kernel-path-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn python_environment_variables_follow_the_resolved_state() {
        let dir = temp("pyenv");
        let inputs = LocationInputs {
            data_dir: Some(dir.clone()),
            ..LocationInputs::default()
        };
        let env_dir = dir.join("equavela").join("py");
        // Not resolved yet: the directory is set and offline mode is not.
        let env = kernel_env(&inputs);
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, "JULIA_CONDAPKG_ENV");
        assert_eq!(env[0].1, env_dir.as_os_str());
        // An older environment with Python but without the XLS packages must resolve again.
        fs::create_dir_all(env_dir.join("bin")).unwrap();
        fs::write(env_dir.join("bin").join("python"), "").unwrap();
        assert_eq!(kernel_env(&inputs).len(), 1);
        let site = env_dir.join("lib/python3.12/site-packages");
        for package in ["xlrd", "xlwt"] {
            fs::create_dir_all(site.join(package)).unwrap();
        }
        assert_eq!(kernel_env(&inputs).len(), 1);
        fs::create_dir_all(site.join("xlutils")).unwrap();
        let env = kernel_env(&inputs);
        assert!(env
            .iter()
            .any(|(k, v)| k == "JULIA_CONDAPKG_OFFLINE" && v == "yes"));
        fs::remove_dir_all(env_dir.join("lib")).unwrap();
        let site = env_dir.join("Lib/site-packages");
        for package in ["xlrd", "xlwt", "xlutils"] {
            fs::create_dir_all(site.join(package)).unwrap();
        }
        assert!(python_env_is_resolved(&env_dir));
        // Overrides win.
        let custom = LocationInputs {
            python_env_override: Some(dir.join("custom")),
            conda_offline_override: Some("no".into()),
            data_dir: Some(dir.clone()),
            ..LocationInputs::default()
        };
        let env = kernel_env(&custom);
        assert_eq!(env[0].1, dir.join("custom").as_os_str());
        assert!(env
            .iter()
            .any(|(k, v)| k == "JULIA_CONDAPKG_OFFLINE" && v == "no"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn installed_layout_uses_the_shipped_python_and_a_per_user_depot() {
        let root = temp("installed");
        let project = make_kernel(&root);
        let julia = root.join("julia").join("bin");
        fs::create_dir_all(&julia).unwrap();
        fs::write(julia.join(julia_file_name()), "").unwrap();
        fs::create_dir_all(root.join("depot")).unwrap();
        let python = root.join("python");
        fs::create_dir_all(python.join("bin")).unwrap();
        let exe = if cfg!(windows) {
            python.join("python.exe")
        } else {
            python.join("bin").join("python")
        };
        fs::write(&exe, "").unwrap();
        let data = temp("installed-data");
        let inputs = LocationInputs {
            kernel_dir_override: Some(project.clone()),
            data_dir: Some(data.clone()),
            ..LocationInputs::default()
        };
        let config = resolve_kernel_config(&inputs).unwrap();
        let get = |name: &str| {
            config
                .env
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("JULIA_PYTHONCALL_EXE").unwrap(), exe.as_os_str());
        assert_eq!(get("JULIA_CONDAPKG_BACKEND").unwrap(), "Null");
        assert_eq!(
            get("JULIA_DEPOT_PATH").unwrap(),
            std::env::join_paths([
                data.join("local.equavela.desktop").join("depot"),
                root.join("depot")
            ])
            .unwrap()
        );
        assert!(get("JULIA_CONDAPKG_ENV").is_none());
        // inherited values win
        let inherited = LocationInputs {
            depot_override: Some("/elsewhere".into()),
            python_exe_override: Some("/py".into()),
            ..inputs
        };
        let config = resolve_kernel_config(&inherited).unwrap();
        assert!(config
            .env
            .iter()
            .all(|(k, _)| k != "JULIA_DEPOT_PATH" && k != "JULIA_PYTHONCALL_EXE"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn override_wins_and_is_validated() {
        let dir = temp("override");
        let project = make_kernel(&dir);
        let inputs = LocationInputs {
            kernel_dir_override: Some(project.clone()),
            resource_dir: Some(dir.join("elsewhere")),
            ..LocationInputs::default()
        };
        assert_eq!(find_kernel_project(&inputs).unwrap(), project);
        let bad = LocationInputs {
            kernel_dir_override: Some(dir.join("nope")),
            ..LocationInputs::default()
        };
        assert!(find_kernel_project(&bad)
            .unwrap_err()
            .contains("EQUAVELA_KERNEL_DIR"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resource_dir_beats_executable_dir_and_dev_checkout() {
        let resources = temp("resources");
        let exe = temp("exe");
        let dev = temp("dev");
        let expected = make_kernel(&resources);
        make_kernel(&exe);
        make_kernel(&dev);
        let inputs = LocationInputs {
            resource_dir: Some(resources.clone()),
            executable_dir: Some(exe.clone()),
            dev_repository: Some(dev.clone()),
            ..LocationInputs::default()
        };
        assert_eq!(find_kernel_project(&inputs).unwrap(), expected);
        for dir in [resources, exe, dev] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn falls_back_to_the_executable_dir_then_the_dev_checkout() {
        let exe = temp("exe2");
        let dev = temp("dev2");
        let in_exe = make_kernel(&exe);
        let in_dev = make_kernel(&dev);
        let inputs = LocationInputs {
            resource_dir: Some(exe.join("no-resources")),
            executable_dir: Some(exe.clone()),
            dev_repository: Some(dev.clone()),
            ..LocationInputs::default()
        };
        assert_eq!(find_kernel_project(&inputs).unwrap(), in_exe);
        let dev_only = LocationInputs {
            dev_repository: Some(dev.clone()),
            ..LocationInputs::default()
        };
        assert_eq!(find_kernel_project(&dev_only).unwrap(), in_dev);
        for dir in [exe, dev] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn linux_lib_layout_is_found_next_to_the_executable() {
        let root = temp("lib");
        let project = root
            .join("lib")
            .join("Equavela")
            .join("kernel")
            .join("EquavelaKernel");
        fs::create_dir_all(project.join("bin")).unwrap();
        fs::write(project.join("bin").join("kernel.jl"), "# kernel").unwrap();
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let inputs = LocationInputs {
            executable_dir: Some(bin),
            ..LocationInputs::default()
        };
        let found = find_kernel_project(&inputs).unwrap();
        assert!(found.ends_with("EquavelaKernel"));
        assert!(is_kernel_project(&found));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_kernel_lists_the_places_that_were_searched() {
        let inputs = LocationInputs {
            resource_dir: Some(PathBuf::from("/nowhere")),
            ..LocationInputs::default()
        };
        let error = find_kernel_project(&inputs).unwrap_err();
        assert!(
            error.contains("nowhere") && error.contains("EQUAVELA_KERNEL_DIR"),
            "{error}"
        );
    }

    #[test]
    fn julia_lookup_order_is_override_bundled_path() {
        let root = temp("julia");
        let project = make_kernel(&root);
        let none = LocationInputs::default();
        assert_eq!(find_julia(&none, &project), PathBuf::from("julia"));
        let bin = root.join("julia").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(julia_file_name()), "").unwrap();
        assert_eq!(find_julia(&none, &project), bin.join(julia_file_name()));
        let overridden = LocationInputs {
            julia_override: Some(PathBuf::from("/opt/julia/bin/julia")),
            ..LocationInputs::default()
        };
        assert_eq!(
            find_julia(&overridden, &project),
            PathBuf::from("/opt/julia/bin/julia")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sysimage_lookup_override_bundled_and_stale_dev_image() {
        use std::time::{Duration, SystemTime};
        let root = temp("sysimage");
        let project = make_kernel(&root);
        let none = LocationInputs::default();
        assert_eq!(find_sysimage(&none, &project), None);

        // bundled next to the julia runtime
        let image = root.join("sysimage").join(sysimage_file_name());
        fs::create_dir_all(image.parent().unwrap()).unwrap();
        fs::write(&image, "image").unwrap();
        assert_eq!(find_sysimage(&none, &project), Some(image.clone()));

        // the override wins, can disable, and a missing file is ignored
        let explicit = root.join("custom.img");
        fs::write(&explicit, "image").unwrap();
        let overridden = LocationInputs {
            sysimage_override: Some(explicit.clone()),
            ..LocationInputs::default()
        };
        assert_eq!(find_sysimage(&overridden, &project), Some(explicit));
        for text in ["off", "NONE", "0", "false"] {
            let disabled = LocationInputs {
                sysimage_override: Some(PathBuf::from(text)),
                ..LocationInputs::default()
            };
            assert_eq!(find_sysimage(&disabled, &project), None);
        }
        let missing = LocationInputs {
            sysimage_override: Some(root.join("missing.img")),
            ..LocationInputs::default()
        };
        assert_eq!(find_sysimage(&missing, &project), None);
        let _ = fs::remove_dir_all(&root);

        // the repository's build output is used only while it is newer than the sources
        let dev = temp("sysimage-dev");
        let project = make_kernel(&dev);
        let runtime = dev.join("kernel").join("EqRuntime").join("src");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join("EqRuntime.jl"), "# runtime").unwrap();
        let built = dev
            .join("build")
            .join("sysimage")
            .join(sysimage_file_name());
        fs::create_dir_all(built.parent().unwrap()).unwrap();
        fs::write(&built, "image").unwrap();
        let inputs = LocationInputs {
            dev_repository: Some(dev.clone()),
            ..LocationInputs::default()
        };
        let past = SystemTime::now() - Duration::from_secs(3600);
        let set_time = |path: &Path, time: SystemTime| {
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(time)
                .unwrap();
        };
        set_time(&runtime.join("EqRuntime.jl"), past);
        set_time(&project.join("bin").join("kernel.jl"), past);
        assert_eq!(find_sysimage(&inputs, &project), Some(built.clone()));
        // a source file newer than the image makes it stale
        set_time(&built, past - Duration::from_secs(60));
        set_time(&runtime.join("EqRuntime.jl"), SystemTime::now());
        assert_eq!(find_sysimage(&inputs, &project), None);
        let _ = fs::remove_dir_all(dev);
    }

    #[test]
    fn the_repository_kernel_is_found_in_a_development_build() {
        let inputs = LocationInputs::from_environment(None);
        let project = find_kernel_project(&inputs).expect("repository kernel/EquavelaKernel");
        assert!(is_kernel_project(&project));
        let config = resolve_kernel_config(&inputs).unwrap();
        assert_eq!(config.project, project);
    }
}
