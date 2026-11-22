//! Local diagnostics for the desktop process. .

use std::path::PathBuf;

pub(crate) fn directory() -> Option<PathBuf> {
    std::env::var_os("EQUAVELA_DRIVER_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::kernel_path::user_data_dir().map(|base| base.join("equavela")))
        .map(|base| base.join("crashes"))
}

#[cfg(any(target_os = "linux", windows))]
pub(crate) fn start() -> Option<minidumper_child::ClientHandle> {
    use std::io::Write;

    let directory = directory()?;
    let staging = directory.join("pending");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }

    let dump_directory = directory.clone();
    let reporter = minidumper_child::MinidumperChild::new()
        .with_server_env_var("EQUAVELA_CRASH_REPORTER_SOCKET".into())
        .with_crashes_dir(staging.clone())
        .on_minidump(move |bytes, path| {
            // The helper removes its own scratch file after this callback.
            let Some(name) = path.file_name() else { return };
            let save = || -> std::io::Result<()> {
                let mut dump = tempfile::NamedTempFile::new_in(&dump_directory)?;
                dump.write_all(&bytes)?;
                dump.as_file().sync_all()?;
                dump.persist_noclobber(dump_directory.join(name))
                    .map_err(|error| error.error)?;
                Ok(())
            };
            if let Err(error) = save() {
                eprintln!("Equavela could not save the native crash dump: {error}");
            }
        });
    let is_reporter = reporter.is_crash_reporter_process();
    if let Err(error) = builder.create(&staging) {
        if is_reporter {
            std::process::exit(1);
        }
        eprintln!("Equavela could not create the crash report directory: {error}");
        return None;
    }
    if !is_reporter {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            let save = || -> std::io::Result<()> {
                let mut report = tempfile::Builder::new()
                    .prefix("panic-")
                    .suffix(".txt")
                    .tempfile_in(&directory)?;
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                writeln!(
                    report,
                    "Equavela {} · Rust panic",
                    env!("CARGO_PKG_VERSION")
                )?;
                writeln!(report, "UTC Unix timestamp: {timestamp}")?;
                writeln!(
                    report,
                    "{} · {} · process {}",
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    std::process::id()
                )?;
                writeln!(
                    report,
                    "{panic}\n{}",
                    std::backtrace::Backtrace::force_capture()
                )?;
                report.as_file().sync_all()?;
                report.keep().map_err(|error| error.error)?;
                Ok(())
            };
            if let Err(error) = save() {
                eprintln!("Equavela could not save the Rust panic report: {error}");
            }
            previous(panic);
        }));
    }
    match reporter.spawn() {
        Ok(handle) => Some(handle),
        Err(error) => {
            eprintln!("Equavela could not start the native crash reporter: {error}");
            if is_reporter {
                std::process::exit(1);
            }
            None
        }
    }
}
