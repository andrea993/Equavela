//! Platform soft-interrupt for the kernel process.
//!
//! Julia turns a console Ctrl+C event (Windows) or `SIGINT` (Linux and other Unix systems)
//! into an `InterruptException` when `Base.exit_on_sigint(false)` is set, which the kernel
//! entry point does. This is the only module of the crate that uses `unsafe`; the foreign
//! functions are declared by hand so no extra dependency is needed.

use std::io;

/// Asks the process `pid` to interrupt the running evaluation without terminating it.
pub fn send_soft_interrupt(pid: u32) -> io::Result<()> {
    imp::send_soft_interrupt(pid)
}

#[cfg(unix)]
mod imp {
    use std::io;

    const SIGINT: i32 = 2;

    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }

    pub fn send_soft_interrupt(pid: u32) -> io::Result<()> {
        let pid = i32::try_from(pid)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "pid out of range"))?;
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions.
        if unsafe { kill(pid, SIGINT) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::sync::Mutex;

    const CTRL_C_EVENT: u32 = 0;
    /// Time for the console to finish delivering the event before the handler is restored.
    const SETTLE: std::time::Duration = std::time::Duration::from_millis(100);

    #[link(name = "kernel32")]
    extern "system" {
        fn FreeConsole() -> i32;
        fn AttachConsole(process_id: u32) -> i32;
        fn GetConsoleProcessList(process_list: *mut u32, process_count: u32) -> u32;
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
        fn GenerateConsoleCtrlEvent(event: u32, process_group_id: u32) -> i32;
    }

    /// The console state of the host process is global, so interrupts are serialized.
    static CONSOLE: Mutex<()> = Mutex::new(());

    /// The kernel is started with its own (hidden) console. To deliver Ctrl+C to it, the
    /// host detaches from its own console, attaches to the kernel's, ignores the event
    /// itself, generates it, and re-attaches to the console it had before (through another
    /// process on it) so a host started from a terminal keeps its console.
    pub fn send_soft_interrupt(pid: u32) -> io::Result<()> {
        let _guard = CONSOLE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let own_pid = std::process::id();

        let mut list = [0_u32; 64];
        // SAFETY: the buffer is valid for `list.len()` entries.
        let count = unsafe { GetConsoleProcessList(list.as_mut_ptr(), list.len() as u32) };
        let companion = list
            .iter()
            .take((count as usize).min(list.len()))
            .copied()
            .find(|&candidate| candidate != own_pid && candidate != pid);

        // SAFETY: plain console API calls; the order follows .
        let result = unsafe {
            // Ignore Ctrl+C in this process for the whole operation: the console delivers the
            // event asynchronously, so the ignore flag must outlive the console switch.
            SetConsoleCtrlHandler(None, 1);
            FreeConsole();
            let attached = AttachConsole(pid);
            if attached == 0 {
                Err(io::Error::last_os_error())
            } else {
                let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0);
                let error = if sent == 0 {
                    Some(io::Error::last_os_error())
                } else {
                    None
                };
                std::thread::sleep(SETTLE);
                FreeConsole();
                match error {
                    None => Ok(()),
                    Some(error) => Err(error),
                }
            }
        };
        if let Some(companion) = companion {
            // SAFETY: re-attach to the console this process had before.
            unsafe {
                AttachConsole(companion);
            }
        }
        std::thread::sleep(SETTLE);
        // SAFETY: restores the default Ctrl+C handling that was suspended above.
        unsafe {
            SetConsoleCtrlHandler(None, 0);
        }
        result
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use std::io;

    pub fn send_soft_interrupt(_pid: u32) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "soft interrupt is not implemented for this platform",
        ))
    }
}
