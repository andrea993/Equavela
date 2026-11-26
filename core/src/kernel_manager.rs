//! Supervisor for the out-of-process Julia kernel.
//!
//! [`KernelManager`] spawns `julia --startup-file=no --project=<EquavelaKernel> bin/kernel.jl`,
//! speaks the framed JSON-RPC protocol of `the specification` over stdio, or
//! over an authenticated loopback socket when the child has a terminal PTY, and keeps the
//! process healthy:
//!
//! - **handshake**: the `version` request must answer with a matching protocol version before
//!   the kernel is considered started;
//! - **requests are sequential**; each is matched by id, `kernel/progress` notifications are
//!   passed to a callback, stale or unknown frames are ignored;
//! - **timeouts**: an expired request is first interrupted softly, then the process is killed
//!   if it does not answer within the grace period;
//! - **interrupt**: [`KernelManager::interrupt_request`] sends Ctrl+C (Windows) or `SIGINT`
//!   (Unix) tagged with the request id, so a late cancel can never hit the next request;
//! - **crash recovery**: a dead or killed kernel is restarted by the next request. The new
//!   process has empty worksheet modules; compare [`KernelManager::generation`] to learn that
//!   state was lost and resend the full worksheet (an `evaluate` with `reset`);
//! - **shutdown**: the `shutdown` request, then a bounded wait, then kill. Dropping the manager
//!   never leaves the child running.

use crate::kernel_terminal::Terminal;
pub use crate::kernel_terminal::TerminalSnapshot;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codegen::GeneratedWorksheet;
use crate::kernel::{
    ActivityParams, BinaryDescriptor, FrameHeader, ProgressParams, ProtocolError, RpcId,
    RpcMessage, INTERRUPTED, PROTOCOL_VERSION,
};
use crate::kernel_interrupt::send_soft_interrupt;
use crate::kernel_value::{KernelValue, ValueError};

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const STDERR_TAIL_LINES: usize = 50;

/// How to start and supervise the kernel.
#[derive(Debug, Clone)]
pub struct KernelConfig {
    /// The Julia executable. Prefer the real executable, not the juliaup shim; with
    /// `resolve_real_julia` the shim is resolved at the first start.
    pub julia: PathBuf,
    /// The `kernel/EquavelaKernel` directory (the Julia project).
    pub project: PathBuf,
    /// The entry script; defaults to `<project>/bin/kernel.jl`.
    pub script: Option<PathBuf>,
    /// Extra Julia options inserted before the script (for example `--sysimage=...`).
    pub julia_args: Vec<OsString>,
    /// Extra environment variables of the kernel process, applied after the inherited
    /// environment.
    pub env: Vec<(OsString, OsString)>,
    /// A custom system image built by `scripts/build-sysimage.jl`.
    /// It is used only if the file exists; if the kernel does not start with it (an image
    /// from another Julia version, a corrupt file) the manager logs the reason to stderr,
    /// starts without it and does not try it again.
    pub sysimage: Option<PathBuf>,
    /// Ask Julia for its own executable path before the first start, so a launcher shim is
    /// not the process that gets interrupted and killed.
    pub resolve_real_julia: bool,
    /// Maximum time for process start plus handshake.
    pub startup_timeout: Duration,
    /// Run the real Julia REPL on a PTY with RPC on a private socket.
    pub terminal: bool,
    /// Default per-request timeout; `None` waits indefinitely.
    pub request_timeout: Option<Duration>,
    /// Time a kernel gets to answer an interrupt before it is killed.
    pub interrupt_grace: Duration,
    /// Time a kernel gets to exit after `shutdown` before it is killed.
    pub shutdown_timeout: Duration,
    /// Where to write diagnostics for an unexpected exit or a broken connection.
    pub crash_report_dir: Option<PathBuf>,
}

impl KernelConfig {
    pub fn new(project: impl Into<PathBuf>) -> Self {
        KernelConfig {
            julia: PathBuf::from("julia"),
            project: project.into(),
            script: None,
            julia_args: Vec::new(),
            env: Vec::new(),
            sysimage: None,
            resolve_real_julia: true,
            startup_timeout: Duration::from_secs(120),
            terminal: false,
            request_timeout: None,
            interrupt_grace: Duration::from_secs(2),
            shutdown_timeout: Duration::from_secs(3),
            crash_report_dir: None,
        }
    }

    pub fn with_julia(mut self, julia: impl Into<PathBuf>) -> Self {
        self.julia = julia.into();
        self
    }

    fn script_path(&self) -> PathBuf {
        self.script
            .clone()
            .unwrap_or_else(|| self.project.join("bin").join("kernel.jl"))
    }
}

/// The answer of the `version` request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelInfo {
    pub julia: String,
    pub package: String,
    pub protocol: u32,
}

#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("cannot start the Julia kernel: {0}")]
    Spawn(io::Error),
    #[error("kernel handshake failed: {0}")]
    Handshake(String),
    #[error("kernel protocol violation: {0}")]
    Protocol(String),
    #[error("kernel I/O error: {0}")]
    Io(io::Error),
    #[error("kernel error {code}: {message}")]
    Rpc {
        code: i32,
        message: String,
        data: Option<Value>,
    },
    #[error("the request was interrupted")]
    Interrupted,
    #[error("the request timed out and was interrupted")]
    Timeout,
    #[error("the kernel did not answer the interrupt and was killed")]
    Unresponsive,
    #[error("the kernel process died ({exit}); stderr tail:\n{stderr}")]
    Crashed { exit: String, stderr: String },
    #[error("invalid kernel response: {0}")]
    InvalidResponse(String),
}

/// A successful response: the `result` and the raw binary payloads of its frame.
#[derive(Debug, Clone, PartialEq)]
pub struct KernelResponse {
    pub result: Value,
    pub binary: Vec<BinaryDescriptor>,
    pub payloads: Vec<Vec<u8>>,
}

/// Per-request settings.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Use this id instead of an allocated one (for example to cancel it later).
    pub id: Option<RpcId>,
    /// Overrides `KernelConfig::request_timeout`.
    pub timeout: Option<Duration>,
}

// ---------------------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------------------

enum Event {
    Frame(Box<FrameHeader>, Vec<Vec<u8>>),
    Closed(String),
}

struct PtyProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// The process group to kill on cleanup; only Linux uses it (Windows has the job object).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pid: u32,
    group_cleaned: bool,
    #[cfg(windows)]
    _job: WindowsJob,
}

impl PtyProcess {
    fn cleanup_group(&mut self) {
        if self.group_cleaned {
            return;
        }
        self.group_cleaned = true;
        // portable-pty creates a new session whose group ID is the child PID.
        #[cfg(target_os = "linux")]
        if let Ok(raw) = i32::try_from(self.pid) {
            if let Some(pid) = rustix::process::Pid::from_raw(raw) {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
            }
        }
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        self.cleanup_group();
        let _ = self.child.kill();
        let _ = self.child.wait();
        // On Windows the job closes after this method, terminating all remaining members.
    }
}

#[cfg(windows)]
struct WindowsJob(isize);

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &dyn portable_pty::Child) -> io::Result<Self> {
        let process = child.as_raw_handle().unwrap_or(std::ptr::null_mut());
        Self::assign_raw_handle(process)
    }

    fn assign_std_child(child: &Child) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        Self::assign_raw_handle(child.as_raw_handle())
    }

    fn assign_raw_handle(process: *mut std::ffi::c_void) -> io::Result<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            );
            if configured == 0
                || process.is_null()
                || AssignProcessToJobObject(job, process as _) == 0
            {
                let error = io::Error::last_os_error();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self(job as isize))
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

struct StdioProcess {
    child: Child,
    #[cfg(windows)]
    _job: Option<WindowsJob>,
}

impl Drop for StdioProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum Process {
    Stdio(StdioProcess),
    Pty(PtyProcess),
}
impl Process {
    fn try_wait(&mut self) -> io::Result<Option<String>> {
        match self {
            Self::Stdio(c) => c.child.try_wait().map(|s| s.map(|s| s.to_string())),
            Self::Pty(c) => {
                let status = c.child.try_wait()?;
                if status.is_some() {
                    c.cleanup_group();
                }
                Ok(status.map(|s| s.to_string()))
            }
        }
    }
    fn kill(&mut self) -> io::Result<()> {
        match self {
            Self::Stdio(c) => c.child.kill(),
            Self::Pty(c) => {
                c.cleanup_group();
                c.child.kill()
            }
        }
    }
    fn wait(&mut self) -> io::Result<()> {
        match self {
            Self::Stdio(c) => c.child.wait().map(|_| ()),
            Self::Pty(c) => c.child.wait().map(|_| ()),
        }
    }
}

struct Running {
    child: Process,
    stdin: Box<dyn Write + Send>,
    terminal: Option<Arc<Terminal>>,
    events: Receiver<Event>,
    pid: u32,
    stderr: Arc<Mutex<VecDeque<String>>>,
    info: KernelInfo,
}

#[derive(Default)]
struct Inner {
    running: Option<Running>,
    real_julia: Option<PathBuf>,
    /// The sysimage failed to start a kernel once; do not try it again.
    sysimage_rejected: bool,
    /// Whether the running kernel was started with the sysimage.
    sysimage_in_use: bool,
}

struct Active {
    id: RpcId,
    pid: u32,
    interrupted_at: Option<Instant>,
    timed_out: bool,
}

/// Supervises one kernel process. All methods take `&self`; requests are serialized, while
/// [`interrupt_request`](Self::interrupt_request) may be called from another thread.
/// Receives the slow work the kernel announces (`Some`) and its end (`None`).
pub type ActivityObserver = Arc<dyn Fn(Option<&ActivityParams>) + Send + Sync>;

pub struct KernelManager {
    config: KernelConfig,
    inner: Mutex<Inner>,
    active: Mutex<Option<Active>>,
    next_id: AtomicU64,
    generation: AtomicU64,
    terminal: Mutex<Option<Arc<Terminal>>>,
    activity: Mutex<Option<ActivityObserver>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl KernelManager {
    /// Creates a manager; the process is started by [`start`](Self::start) or lazily by the
    /// first request.
    pub fn new(config: KernelConfig) -> Self {
        KernelManager {
            config,
            inner: Mutex::new(Inner::default()),
            active: Mutex::new(None),
            next_id: AtomicU64::new(1),
            generation: AtomicU64::new(0),
            terminal: Mutex::new(None),
            activity: Mutex::new(None),
        }
    }

    /// Sets who hears about the slow work of requests (`kernel/activity`): it is called with the
    /// activity when the kernel announces one and with `None` when that request ends.
    pub fn on_activity(&self, observer: ActivityObserver) {
        *lock(&self.activity) = Some(observer);
    }

    fn announce_activity(&self, activity: Option<&ActivityParams>) {
        let observer = lock(&self.activity).clone();
        if let Some(observer) = observer {
            observer(activity);
        }
    }

    /// Start (if necessary), resize and attach to the current environment terminal.
    pub fn terminal_open(&self, cols: u16, rows: u16) -> Result<TerminalSnapshot, KernelError> {
        if !self.config.terminal {
            return Err(KernelError::Protocol(
                "terminal transport is not enabled for this kernel".into(),
            ));
        }
        self.start()?;
        self.terminal_resize(cols, rows)?;
        self.terminal_read(0)
    }

    pub fn terminal_read(&self, after: u64) -> Result<TerminalSnapshot, KernelError> {
        let terminal = lock(&self.terminal)
            .clone()
            .ok_or_else(|| KernelError::Protocol("terminal is not running".into()))?;
        terminal.read(after).map_err(KernelError::Io)
    }

    pub fn terminal_write(&self, data: &[u8]) -> Result<(), KernelError> {
        let terminal = lock(&self.terminal)
            .clone()
            .ok_or_else(|| KernelError::Protocol("terminal is not running".into()))?;
        terminal.write(data).map_err(KernelError::Io)
    }

    pub fn terminal_resize(&self, cols: u16, rows: u16) -> Result<(), KernelError> {
        let terminal = lock(&self.terminal)
            .clone()
            .ok_or_else(|| KernelError::Protocol("terminal is not running".into()))?;
        terminal.resize(cols, rows).map_err(KernelError::Io)
    }

    pub fn config(&self) -> &KernelConfig {
        &self.config
    }

    /// Number of kernel processes started so far. It changes whenever the kernel was
    /// (re)started, which means all worksheet state in the kernel was lost.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Starts the kernel if it is not running and returns its version information.
    pub fn start(&self) -> Result<KernelInfo, KernelError> {
        let mut inner = lock(&self.inner);
        self.ensure_running(&mut inner)?;
        Ok(inner.running.as_ref().expect("running").info.clone())
    }

    /// Version information of the running kernel, if there is one.
    pub fn info(&self) -> Option<KernelInfo> {
        lock(&self.inner)
            .running
            .as_ref()
            .map(|running| running.info.clone())
    }

    /// Whether the running kernel was started with the configured sysimage.
    pub fn sysimage_in_use(&self) -> bool {
        let inner = lock(&self.inner);
        inner.running.is_some() && inner.sysimage_in_use
    }

    pub fn is_running(&self) -> bool {
        lock(&self.inner).running.is_some()
    }

    /// The id of the request currently being answered, if any.
    pub fn active_request(&self) -> Option<RpcId> {
        lock(&self.active).as_ref().map(|active| active.id.clone())
    }

    /// Sends a request and waits for its response.
    pub fn request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<KernelResponse, KernelError> {
        self.request_with(method, params, &RequestOptions::default(), &mut |_| {})
    }

    /// Sends a request; `progress` receives the `kernel/progress` notifications that belong
    /// to it, in order.
    pub fn request_with(
        &self,
        method: &str,
        params: Option<Value>,
        options: &RequestOptions,
        progress: &mut dyn FnMut(&ProgressParams),
    ) -> Result<KernelResponse, KernelError> {
        let mut inner = lock(&self.inner);
        self.ensure_running(&mut inner)?;
        let id = options.id.clone().unwrap_or_else(|| self.allocate_id());
        let timeout = options.timeout.or(self.config.request_timeout);
        let running = inner.running.as_mut().expect("running");
        match self.exchange(running, &id, method, params, timeout, progress) {
            Ok(response) => Ok(response),
            Err((error, fatal)) => {
                if let KernelError::Crashed { exit, stderr } = &error {
                    self.report_crash(running, method, exit, stderr);
                }
                if fatal {
                    *lock(&self.terminal) = None;
                    if let Some(dead) = inner.running.take() {
                        terminate(dead);
                    }
                }
                Err(error)
            }
        }
    }

    pub fn ping(&self) -> Result<(), KernelError> {
        let response = self.request("ping", None)?;
        if response.result == Value::String("pong".into()) {
            Ok(())
        } else {
            Err(KernelError::InvalidResponse(format!(
                "ping answered {}",
                response.result
            )))
        }
    }

    /// [`evaluate_with_progress`](Self::evaluate_with_progress) without a progress callback.
    pub fn evaluate(&self, request: &EvaluateRequest) -> Result<EvaluateResponse, KernelError> {
        self.evaluate_with_progress(request, &mut |_| {})
    }

    /// Evaluates generated Julia for one worksheet (`evaluate`, protocol section 7).
    pub fn evaluate_with_progress(
        &self,
        request: &EvaluateRequest,
        progress: &mut dyn FnMut(&ProgressParams),
    ) -> Result<EvaluateResponse, KernelError> {
        self.evaluate_with_options(request, &RequestOptions::default(), progress)
    }

    /// Evaluates generated Julia for one worksheet with explicit request options (such as a
    /// pre-allocated request id for targeted interruption).
    pub fn evaluate_with_options(
        &self,
        request: &EvaluateRequest,
        options: &RequestOptions,
        progress: &mut dyn FnMut(&ProgressParams),
    ) -> Result<EvaluateResponse, KernelError> {
        let params = serde_json::to_value(request)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))?;
        let response = self.request_with("evaluate", Some(params), options, progress)?;
        EvaluateResponse::from_response(&response)
    }

    /// Allocates a unique request id for use with [`RequestOptions::id`] and
    /// [`interrupt_request`](Self::interrupt_request).
    pub fn next_request_id(&self) -> RpcId {
        self.allocate_id()
    }

    /// Adds `packages` to the Julia environment in the directory `environment` and
    /// instantiates it (`install_packages`, protocol section 8). Downloads packages: call
    /// it only after the user trusted the worksheet and agreed to the installation.
    pub fn install_packages(
        &self,
        environment: &str,
        packages: &[String],
    ) -> Result<InstallResult, KernelError> {
        let response = self.request(
            "install_packages",
            Some(serde_json::json!({ "environment": environment, "packages": packages })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Removes `packages` from the direct dependencies of the environment in the directory
    /// `environment` (`remove_packages`, protocol section 8).
    pub fn remove_packages(
        &self,
        environment: &str,
        packages: &[String],
    ) -> Result<InstallResult, KernelError> {
        let response = self.request(
            "remove_packages",
            Some(serde_json::json!({ "environment": environment, "packages": packages })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Develops the packages in the folders `paths` (relative to `environment`) into the
    /// environment.
    pub fn develop_packages(
        &self,
        environment: &str,
        paths: &[String],
    ) -> Result<InstallResult, KernelError> {
        let response = self.request(
            "develop_packages",
            Some(serde_json::json!({ "environment": environment, "paths": paths })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Evaluates `code` in the REPL module of `environment`.
    pub fn repl(
        &self,
        environment: Option<&str>,
        packages: &[String],
        code: &str,
        reset: bool,
    ) -> Result<ReplResult, KernelError> {
        let response = self.request(
            "repl",
            Some(serde_json::json!({
                "environment": environment, "packages": packages, "code": code, "reset": reset,
            })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// The completions of `text` at character `position`,
    /// in a module that uses `packages` of `environment`.
    pub fn complete(
        &self,
        environment: Option<&str>,
        packages: &[String],
        text: &str,
        position: usize,
    ) -> Result<Completions, KernelError> {
        self.complete_request(environment, packages, text, position, false)
    }

    /// Like [`KernelManager::complete`], in the REPL module of `environment`: names
    /// defined in the REPL complete too.
    pub fn complete_in_repl(
        &self,
        environment: Option<&str>,
        packages: &[String],
        text: &str,
        position: usize,
    ) -> Result<Completions, KernelError> {
        self.complete_request(environment, packages, text, position, true)
    }

    fn complete_request(
        &self,
        environment: Option<&str>,
        packages: &[String],
        text: &str,
        position: usize,
        repl: bool,
    ) -> Result<Completions, KernelError> {
        let response = self.request(
            "complete",
            Some(serde_json::json!({
                "environment": environment, "packages": packages, "text": text,
                "position": position, "repl": repl,
            })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Explicit package maintenance; the kernel validates the operation whitelist.
    pub fn manage_environment(
        &self,
        environment: &str,
        operation: &str,
    ) -> Result<InstallResult, KernelError> {
        let response = self.request(
            "manage_environment",
            Some(serde_json::json!({ "environment": environment, "operation": operation })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Changes one direct dependency's compatibility range through native Julia Pkg.
    pub fn set_compatibility(
        &self,
        environment: &str,
        package: &str,
        compatibility: &str,
    ) -> Result<InstallResult, KernelError> {
        let response = self.request(
            "set_compatibility",
            Some(serde_json::json!({
                "environment": environment, "package": package, "compatibility": compatibility,
            })),
        )?;
        serde_json::from_value(response.result)
            .map_err(|error| KernelError::InvalidResponse(error.to_string()))
    }

    /// Drops a worksheet's module in the kernel (`discard`).
    pub fn discard(&self, worksheet: &str) -> Result<(), KernelError> {
        self.request(
            "discard",
            Some(serde_json::json!({ "worksheet": worksheet })),
        )
        .map(|_| ())
    }

    /// Soft-interrupts the active request if its id is `id`. Returns whether an interrupt was
    /// sent. A request that already finished (or a different one is active) is never hit.
    pub fn interrupt_request(&self, id: &RpcId) -> Result<bool, KernelError> {
        self.interrupt_matching(Some(id))
    }

    /// Soft-interrupts whatever request is active.
    pub fn interrupt_active(&self) -> Result<bool, KernelError> {
        self.interrupt_matching(None)
    }

    fn interrupt_matching(&self, id: Option<&RpcId>) -> Result<bool, KernelError> {
        let mut active = lock(&self.active);
        let Some(active) = active.as_mut() else {
            return Ok(false);
        };
        if id.is_some_and(|id| *id != active.id) {
            return Ok(false);
        }
        send_soft_interrupt(active.pid).map_err(KernelError::Io)?;
        active.interrupted_at.get_or_insert_with(Instant::now);
        Ok(true)
    }

    /// Kills the running kernel (if any) and starts a fresh one.
    pub fn restart(&self) -> Result<KernelInfo, KernelError> {
        let mut inner = lock(&self.inner);
        *lock(&self.terminal) = None;
        if let Some(running) = inner.running.take() {
            terminate(running);
        }
        self.ensure_running(&mut inner)?;
        Ok(inner.running.as_ref().expect("running").info.clone())
    }

    /// Stops the kernel cleanly: `shutdown`, a bounded wait, then kill.
    pub fn shutdown(&self) {
        let mut inner = lock(&self.inner);
        *lock(&self.terminal) = None;
        let Some(mut running) = inner.running.take() else {
            return;
        };
        let id = self.allocate_id();
        let timeout = Some(self.config.shutdown_timeout);
        let _ = self.exchange(&mut running, &id, "shutdown", None, timeout, &mut |_| {});
        let deadline = Instant::now() + self.config.shutdown_timeout;
        while Instant::now() < deadline {
            if matches!(running.child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(POLL_INTERVAL);
        }
        terminate(running);
    }

    fn allocate_id(&self) -> RpcId {
        RpcId::Number(self.next_id.fetch_add(1, Ordering::SeqCst))
    }

    fn ensure_running(&self, inner: &mut Inner) -> Result<(), KernelError> {
        if let Some(running) = inner.running.as_mut() {
            // A kernel that died between requests is replaced.
            let status = running.child.try_wait();
            if let Ok(Some(exit)) = &status {
                if self.config.crash_report_dir.is_some() {
                    self.report_crash(
                        running,
                        "between requests",
                        exit,
                        &stderr_tail(&running.stderr),
                    );
                }
            }
            if !matches!(status, Ok(None)) {
                *lock(&self.terminal) = None;
                if let Some(dead) = inner.running.take() {
                    terminate(dead);
                }
            }
        }
        if inner.running.is_none() {
            inner.running = Some(self.spawn(inner)?);
            self.generation.fetch_add(1, Ordering::SeqCst);
            *lock(&self.terminal) = inner
                .running
                .as_ref()
                .and_then(|running| running.terminal.clone());
        }
        Ok(())
    }

    fn spawn(&self, inner: &mut Inner) -> Result<Running, KernelError> {
        let sysimage = self
            .config
            .sysimage
            .as_ref()
            .filter(|path| !inner.sysimage_rejected && path.is_file())
            .cloned();
        if let Some(image) = sysimage {
            match self.spawn_with(inner, Some(&image)) {
                Ok(running) => {
                    inner.sysimage_in_use = true;
                    return Ok(running);
                }
                Err(error) => {
                    eprintln!(
                        "equavela-core: the kernel did not start with the sysimage `{}` ({error});                          starting without it",
                        image.display()
                    );
                    inner.sysimage_rejected = true;
                }
            }
        }
        inner.sysimage_in_use = false;
        self.spawn_with(inner, None)
    }

    fn spawn_with(
        &self,
        inner: &mut Inner,
        sysimage: Option<&std::path::Path>,
    ) -> Result<Running, KernelError> {
        let julia = self.julia_executable(inner);
        if self.config.terminal {
            return self.spawn_terminal(&julia, sysimage);
        }
        let mut project_flag = OsString::from("--project=");
        project_flag.push(&self.config.project);
        let mut command = Command::new(&julia);
        command
            .arg("--startup-file=no")
            .arg("--color=no")
            .arg(project_flag);
        if let Some(image) = sysimage {
            let mut flag = OsString::from("--sysimage=");
            flag.push(image);
            command.arg(flag);
        }
        command
            .args(&self.config.julia_args)
            .arg(self.config.script_path())
            .envs(self.config.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // The kernel gets its own hidden console so Ctrl+C can be delivered to it alone.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(KernelError::Spawn)?;
        let pid = child.id();
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr_pipe = child.stderr.take().expect("piped stderr");

        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        spawn_stderr_drain(stderr_pipe, Arc::clone(&stderr));
        let (sender, events) = mpsc::channel();
        spawn_reader(stdout, sender);

        #[cfg(windows)]
        let job = WindowsJob::assign_std_child(&child).ok();
        let mut running = Running {
            child: Process::Stdio(StdioProcess {
                child,
                #[cfg(windows)]
                _job: job,
            }),
            stdin: Box::new(stdin),
            terminal: None,
            events,
            pid,
            stderr,
            info: KernelInfo {
                julia: String::new(),
                package: String::new(),
                protocol: 0,
            },
        };
        let id = self.allocate_id();
        let handshake = self.exchange(
            &mut running,
            &id,
            "version",
            None,
            Some(self.config.startup_timeout),
            &mut |_| {},
        );
        let info = match handshake {
            Ok(response) => serde_json::from_value::<KernelInfo>(response.result)
                .map_err(|error| KernelError::Handshake(error.to_string())),
            Err((error, _)) => Err(KernelError::Handshake(error.to_string())),
        };
        match info {
            Ok(info) if info.protocol == PROTOCOL_VERSION => {
                running.info = info;
                Ok(running)
            }
            Ok(info) => {
                terminate(running);
                Err(KernelError::Handshake(format!(
                    "kernel speaks protocol {}, expected {PROTOCOL_VERSION}",
                    info.protocol
                )))
            }
            Err(error) => {
                terminate(running);
                Err(error)
            }
        }
    }

    fn spawn_terminal(
        &self,
        julia: &std::path::Path,
        sysimage: Option<&std::path::Path>,
    ) -> Result<Running, KernelError> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(KernelError::Spawn)?;
        listener.set_nonblocking(true).map_err(KernelError::Spawn)?;
        let mut random = [0u8; 32];
        getrandom::fill(&mut random)
            .map_err(|e| KernelError::Spawn(io::Error::other(e.to_string())))?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| KernelError::Spawn(io::Error::other(e.to_string())))?;
        let mut project_flag = OsString::from("--project=");
        project_flag.push(&self.config.project);
        let mut command = CommandBuilder::new(julia);
        command.arg("--startup-file=no");
        command.arg("-i");
        command.arg(project_flag);
        if let Some(image) = sysimage {
            let mut flag = OsString::from("--sysimage=");
            flag.push(image);
            command.arg(flag);
        }
        for arg in &self.config.julia_args {
            command.arg(arg);
        }
        command.arg(self.config.script_path());
        for (key, value) in &self.config.env {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        command.env(
            "EQUAVELA_RPC_ADDRESS",
            listener
                .local_addr()
                .map_err(KernelError::Spawn)?
                .to_string(),
        );
        command.env("EQUAVELA_RPC_TOKEN", &token);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| KernelError::Spawn(io::Error::other(e.to_string())))?;
        drop(pair.slave);
        let pid = match child.process_id() {
            Some(pid) => pid,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KernelError::Spawn(io::Error::other(
                    "PTY child has no process id",
                )));
            }
        };
        #[cfg(windows)]
        let job = match WindowsJob::assign(child.as_ref()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KernelError::Spawn(error));
            }
        };
        let mut child = PtyProcess {
            child,
            pid,
            group_cleaned: false,
            #[cfg(windows)]
            _job: job,
        };
        let terminal = match Terminal::new(pair.master, self.generation() + 1) {
            Ok(t) => Arc::new(t),
            Err(e) => {
                return Err(KernelError::Spawn(e));
            }
        };
        let deadline = Instant::now() + self.config.startup_timeout;
        let socket = loop {
            if Instant::now() >= deadline {
                return Err(KernelError::Handshake(
                    "terminal RPC connection timed out".into(),
                ));
            }
            match listener.accept() {
                Ok((mut socket, _)) => {
                    // On Windows an accepted socket inherits the listener's non-blocking mode
                    // (on Linux it does not): every read would fail with WouldBlock.
                    if socket.set_nonblocking(false).is_err() {
                        continue;
                    }
                    let remaining = deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(2));
                    let _ = socket.set_read_timeout(Some(remaining));
                    let mut received = vec![0u8; token.len() + 1];
                    if socket.read_exact(&mut received).is_ok()
                        && received == format!("{token}\n").as_bytes()
                    {
                        let _ = socket.set_read_timeout(None);
                        break socket;
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if matches!(child.child.try_wait(), Ok(Some(_)) | Err(_)) {
                        return Err(KernelError::Handshake(
                            "terminal kernel exited before RPC connection".into(),
                        ));
                    }
                    thread::sleep(POLL_INTERVAL);
                }
                Err(e) => return Err(KernelError::Spawn(e)),
            }
        };
        self.finish_terminal_spawn(child, pid, terminal, socket, deadline)
    }

    fn finish_terminal_spawn(
        &self,
        child: PtyProcess,
        pid: u32,
        terminal: Arc<Terminal>,
        socket: TcpStream,
        deadline: Instant,
    ) -> Result<Running, KernelError> {
        let reader = match socket.try_clone() {
            Ok(reader) => reader,
            Err(e) => return Err(KernelError::Spawn(e)),
        };
        let (sender, events) = mpsc::channel();
        spawn_reader(reader, sender);
        let mut running = Running {
            child: Process::Pty(child),
            stdin: Box::new(socket),
            terminal: Some(terminal),
            events,
            pid,
            stderr: Arc::new(Mutex::new(VecDeque::new())),
            info: KernelInfo {
                julia: String::new(),
                package: String::new(),
                protocol: 0,
            },
        };
        let id = self.allocate_id();
        let result = self.exchange(
            &mut running,
            &id,
            "version",
            None,
            Some(deadline.saturating_duration_since(Instant::now())),
            &mut |_| {},
        );
        let info = result
            .map_err(|(e, _)| KernelError::Handshake(e.to_string()))
            .and_then(|r| {
                serde_json::from_value::<KernelInfo>(r.result)
                    .map_err(|e| KernelError::Handshake(e.to_string()))
            });
        match info {
            Ok(info) if info.protocol == PROTOCOL_VERSION => {
                running.info = info;
                Ok(running)
            }
            Ok(info) => {
                terminate(running);
                Err(KernelError::Handshake(format!(
                    "kernel speaks protocol {}, expected {PROTOCOL_VERSION}",
                    info.protocol
                )))
            }
            Err(e) => {
                terminate(running);
                Err(e)
            }
        }
    }

    fn julia_executable(&self, inner: &mut Inner) -> PathBuf {
        if !self.config.resolve_real_julia {
            return self.config.julia.clone();
        }
        inner
            .real_julia
            .get_or_insert_with(|| {
                resolve_real_julia(&self.config.julia).unwrap_or_else(|| self.config.julia.clone())
            })
            .clone()
    }

    /// One request/response exchange. The error carries whether the process is no longer
    /// usable (died, killed, or protocol failure) and must be discarded.
    fn exchange(
        &self,
        running: &mut Running,
        id: &RpcId,
        method: &str,
        params: Option<Value>,
        timeout: Option<Duration>,
        progress: &mut dyn FnMut(&ProgressParams),
    ) -> Result<KernelResponse, (KernelError, bool)> {
        let line = FrameHeader::request(id.clone(), method, params)
            .encode_line()
            .map_err(|error| (KernelError::Protocol(error.to_string()), false))?;
        // Frames of a previous, abandoned request may still be queued; they do not match the
        // id and are dropped below, so no draining is needed here.
        if let Err(error) = running
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| running.stdin.flush())
        {
            return Err((self.crashed(running, Some(error)), true));
        }

        *lock(&self.active) = Some(Active {
            id: id.clone(),
            pid: running.pid,
            interrupted_at: None,
            timed_out: false,
        });
        let mut announced = false;
        let outcome = self.wait_for_response(running, id, timeout, progress, &mut announced);
        *lock(&self.active) = None;
        if announced {
            self.announce_activity(None);
        }
        outcome
    }

    fn wait_for_response(
        &self,
        running: &mut Running,
        id: &RpcId,
        timeout: Option<Duration>,
        progress: &mut dyn FnMut(&ProgressParams),
        announced: &mut bool,
    ) -> Result<KernelResponse, (KernelError, bool)> {
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        loop {
            match running.events.recv_timeout(POLL_INTERVAL) {
                Ok(Event::Frame(header, payloads)) => match header.message {
                    RpcMessage::Notification(notification) => {
                        if notification.method == "kernel/progress" {
                            if let Some(params) = notification.params.and_then(|value| {
                                serde_json::from_value::<ProgressParams>(value).ok()
                            }) {
                                if params.request_id == *id {
                                    progress(&params);
                                }
                            }
                        } else if notification.method == "kernel/activity" {
                            if let Some(params) = notification.params.and_then(|value| {
                                serde_json::from_value::<ActivityParams>(value).ok()
                            }) {
                                if params.request_id == *id {
                                    *announced = true;
                                    self.announce_activity(Some(&params));
                                }
                            }
                        }
                    }
                    RpcMessage::Success(success) if success.id == *id => {
                        return Ok(KernelResponse {
                            result: success.result,
                            binary: header.binary,
                            payloads,
                        });
                    }
                    RpcMessage::Error(response) if response.id.as_ref() == Some(id) => {
                        let timed_out = lock(&self.active)
                            .as_ref()
                            .is_some_and(|active| active.timed_out);
                        let error = if response.error.code == INTERRUPTED {
                            if timed_out {
                                KernelError::Timeout
                            } else {
                                KernelError::Interrupted
                            }
                        } else {
                            KernelError::Rpc {
                                code: response.error.code,
                                message: response.error.message,
                                data: response.error.data,
                            }
                        };
                        return Err((error, false));
                    }
                    RpcMessage::Error(response) if response.id.is_none() => {
                        return Err((
                            KernelError::Protocol(format!(
                                "kernel rejected a frame: {}",
                                response.error.message
                            )),
                            true,
                        ));
                    }
                    // Late frames of an earlier request, requests from the kernel: ignored.
                    _ => {}
                },
                Ok(Event::Closed(reason)) => {
                    return Err((self.crashed_with(running, reason), true));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err((self.crashed_with(running, "reader stopped".into()), true));
                }
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(status) = running.child.try_wait().ok().flatten() {
                        // The reader reports EOF shortly; do not wait for it.
                        return Err((self.crashed_status(running, status), true));
                    }
                }
            }
            if self.must_kill(running, deadline) {
                return Err((KernelError::Unresponsive, true));
            }
        }
    }

    /// Returns `Ok(true)` when the kernel must be killed for ignoring an interrupt.
    fn must_kill(&self, running: &Running, deadline: Option<Instant>) -> bool {
        let now = Instant::now();
        let mut active = lock(&self.active);
        let Some(active) = active.as_mut() else {
            return false;
        };
        match active.interrupted_at {
            Some(at) => now.duration_since(at) > self.config.interrupt_grace,
            None => {
                if deadline.is_some_and(|deadline| now >= deadline) {
                    active.timed_out = true;
                    match send_soft_interrupt(running.pid) {
                        Ok(()) => {
                            active.interrupted_at = Some(now);
                            false
                        }
                        // No way to interrupt: the request cannot be stopped softly.
                        Err(_) => true,
                    }
                } else {
                    false
                }
            }
        }
    }

    fn report_crash(&self, running: &Running, method: &str, exit: &str, stderr: &str) {
        let Some(dir) = &self.config.crash_report_dir else {
            return;
        };
        let write = || -> io::Result<()> {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(dir)?;
            let mut report = tempfile::Builder::new()
                .prefix("julia-")
                .suffix(".txt")
                .tempfile_in(dir)?;
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            writeln!(
                report,
                "Equavela {} · Julia kernel incident",
                crate::version()
            )?;
            writeln!(report, "UTC Unix timestamp: {timestamp}")?;
            writeln!(
                report,
                "Julia {} · kernel {}",
                running.info.julia, running.info.package
            )?;
            writeln!(
                report,
                "Process {} · operation {method} · {exit}",
                running.pid
            )?;
            if !stderr.is_empty() {
                let start = stderr.len().saturating_sub(64 * 1024);
                let tail = String::from_utf8_lossy(&stderr.as_bytes()[start..]);
                writeln!(report, "\nStderr tail:\n{tail}")?;
            }
            report.as_file().sync_all()?;
            report.keep().map_err(|error| error.error)?;
            Ok(())
        };
        if let Err(error) = write() {
            eprintln!("Equavela could not save the Julia crash report: {error}");
        }
    }

    fn crashed(&self, running: &mut Running, io_error: Option<io::Error>) -> KernelError {
        let reason = io_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown".into());
        self.crashed_with(running, reason)
    }

    fn crashed_with(&self, running: &mut Running, reason: String) -> KernelError {
        // Give the process a moment to report its exit status.
        let deadline = Instant::now() + Duration::from_millis(500);
        let status = loop {
            if let Ok(Some(status)) = running.child.try_wait() {
                break Some(status);
            }
            if Instant::now() >= deadline {
                break None;
            }
            thread::sleep(Duration::from_millis(10));
        };
        match status {
            Some(status) => self.crashed_status(running, status),
            None => KernelError::Crashed {
                exit: format!("{reason}; still running"),
                stderr: stderr_tail(&running.stderr),
            },
        }
    }

    fn crashed_status(&self, running: &Running, status: String) -> KernelError {
        KernelError::Crashed {
            exit: format!("exit status {status}"),
            stderr: stderr_tail(&running.stderr),
        }
    }
}

impl Drop for KernelManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn stderr_tail(stderr: &Mutex<VecDeque<String>>) -> String {
    // The drain thread may still be flushing the last lines.
    thread::sleep(Duration::from_millis(50));
    lock(stderr).iter().cloned().collect::<Vec<_>>().join("\n")
}

fn terminate(mut running: Running) {
    let _ = running.child.kill();
    let _ = running.child.wait();
}

/// Upper bound on a single binary payload read from the kernel protocol stream.
const MAX_BINARY_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;

/// Maximum time to wait when probing a launcher (such as `juliaup`) for the real Julia binary.
const RESOLVE_REAL_JULIA_TIMEOUT: Duration = Duration::from_secs(10);

fn resolve_real_julia(julia: &PathBuf) -> Option<PathBuf> {
    let mut command = Command::new(julia);
    command
        .args(["--startup-file=no", "-e", "print(Base.julia_cmd().exec[1])"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + RESOLVE_REAL_JULIA_TIMEOUT;
    let status = loop {
        match child.try_wait().ok()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    if !status.success() {
        return None;
    }
    let mut stdout = Vec::new();
    child.stdout.take()?.read_to_end(&mut stdout).ok()?;
    let path = PathBuf::from(String::from_utf8(stdout).ok()?.trim());
    path.is_file().then_some(path)
}

fn spawn_stderr_drain(pipe: impl Read + Send + 'static, tail: Arc<Mutex<VecDeque<String>>>) {
    thread::spawn(move || drain_stderr(pipe, &tail));
}

/// The lines of Julia's first `ERROR:` kept at the head of the stderr tail, the error line included.
const STDERR_ERROR_LINES: usize = 8;

/// Keeps the last [`STDERR_TAIL_LINES`] lines of the kernel's stderr, except that the first
/// `ERROR:` line and the lines right after it are never dropped: a precompile failure prints its
/// message first and a long stack trace after it, and the message is what the user must see.
fn drain_stderr(pipe: impl Read, tail: &Mutex<VecDeque<String>>) {
    let mut pinned = 0usize;
    let mut pinning = 0usize;
    let mut found = false;
    for line in BufReader::new(pipe).lines() {
        let Ok(line) = line else { return };
        let mut tail = lock(tail);
        if !found && line.contains("ERROR:") {
            found = true;
            // What came before the error (progress lines) matters less than the error itself.
            tail.clear();
            pinning = STDERR_ERROR_LINES;
        }
        if tail.len() == STDERR_TAIL_LINES {
            if pinned < tail.len() {
                tail.remove(pinned);
            } else {
                tail.pop_front();
            }
        }
        tail.push_back(line);
        if pinning > 0 {
            pinning -= 1;
            pinned += 1;
        }
    }
}

fn spawn_reader(stdout: impl Read + Send + 'static, sender: Sender<Event>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    let _ = sender.send(Event::Closed("the kernel closed its output".into()));
                    return;
                }
                Ok(_) => {}
                Err(error) => {
                    let _ = sender.send(Event::Closed(format!("read error: {error}")));
                    return;
                }
            }
            if line.trim().is_empty() {
                continue;
            }
            let header = match FrameHeader::decode_line(&line) {
                Ok(header) => header,
                // A stray non-protocol line on stdout is ignored; framing errors are fatal.
                Err(ProtocolError::InvalidJson(_) | ProtocolError::NotObject) => continue,
                Err(error) => {
                    let _ = sender.send(Event::Closed(format!("invalid frame: {error}")));
                    return;
                }
            };
            let mut payloads = Vec::with_capacity(header.binary.len());
            for descriptor in &header.binary {
                if descriptor.bytes > MAX_BINARY_PAYLOAD_BYTES {
                    let _ = sender.send(Event::Closed(format!(
                        "binary payload of {} bytes exceeds limit",
                        descriptor.bytes
                    )));
                    return;
                }
                let mut payload = vec![0_u8; descriptor.bytes];
                if let Err(error) = reader.read_exact(&mut payload) {
                    let _ = sender.send(Event::Closed(format!("truncated payload: {error}")));
                    return;
                }
                payloads.push(payload);
            }
            if sender
                .send(Event::Frame(Box::new(header), payloads))
                .is_err()
            {
                return;
            }
        }
    });
}

// ---------------------------------------------------------------------------------------
// Typed `evaluate`
// ---------------------------------------------------------------------------------------

/// One region of an `evaluate` request: top-level Julia statements and/or an expression.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegionInput {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The unit of a unit override; the kernel returns it next to the value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_unit: Option<String>,
    /// Record the region's output, duration and trace.
    #[serde(skip_serializing_if = "is_false")]
    pub capture: bool,
}

/// The `evaluate` request (protocol section 7).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvaluateRequest {
    pub worksheet: String,
    #[serde(skip_serializing_if = "is_false")]
    pub reset: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<i64>,
    /// The convergence tolerance `TOL` for this request (positive, finite).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tol: Option<f64>,
    /// The constraint tolerance `CTOL` of a solve block for this request (non-negative, finite).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctol: Option<f64>,
    /// `Some(false)` selects approximate equality; `None` is the exact default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_boolean: Option<bool>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub packages: Vec<String>,
    /// Absolute paths of project module files to include once into the worksheet module.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<String>,
    /// A Julia environment directory (with `Project.toml`) to stack on the kernel's load
    /// path before the regions run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    /// The directory of the worksheet file, which a built-in that reads a file with a
    /// relative path resolves against.
    /// `None` for a worksheet that has no saved file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    /// The name the REPL reaches the worksheet's module by; `None` keeps it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_name: Option<String>,
    pub regions: Vec<RegionInput>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl EvaluateRequest {
    /// The request for a generated worksheet: its regions in evaluation order and its
    /// Julia packages.
    pub fn from_generated(worksheet: impl Into<String>, generated: &GeneratedWorksheet) -> Self {
        EvaluateRequest {
            worksheet: worksheet.into(),
            reset: false,
            origin: None,
            tol: None,
            ctol: None,
            exact_boolean: None,
            packages: generated.packages.clone(),
            modules: Vec::new(),
            environment: None,
            base_dir: None,
            module_name: None,
            regions: generated
                .regions
                .iter()
                .map(|region| RegionInput {
                    id: region.id.clone(),
                    code: (!region.code.is_empty()).then(|| region.code.clone()),
                    value: region.value.clone(),
                    display_unit: region.display_unit.as_ref().map(|unit| unit.code.clone()),
                    capture: region.julia_cell,
                })
                .collect(),
        }
    }

    pub fn with_reset(mut self, reset: bool) -> Self {
        self.reset = reset;
        self
    }
}

/// A region failure as reported by the kernel.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RegionError {
    pub category: String,
    pub message: String,
    /// The program statement id (`eq_locate`), see `GeneratedWorksheet::statements`.
    #[serde(default)]
    pub statement: Option<i64>,
    /// Set for exceptions that are not the reference application errors (`MissingPackage` for a package
    /// that is not installed).
    #[serde(default)]
    pub julia_type: Option<String>,
    /// The package name of a `MissingPackage` error.
    #[serde(default)]
    pub package: Option<String>,
    /// The Julia stack trace of a captured region's failure.
    #[serde(default)]
    pub trace: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RegionOutcome {
    /// `None` when the region has no value expression (it only defines names).
    Value(Option<KernelValue>),
    Error(RegionError),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RegionResult {
    pub id: String,
    pub outcome: RegionOutcome,
    /// The unit of a unit override as a kernel value (see `KernelValue::unit_divisor`).
    pub display_unit: Option<KernelValue>,
    /// The SI offset of an offset temperature override, `°C` or `°F`; 0 otherwise.
    pub display_offset: f64,
    /// What a captured region wrote to stdout and stderr, and how long it took.
    pub output: Option<String>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PackageResult {
    pub name: String,
    #[serde(default)]
    pub error: Option<String>,
    /// Set when the import failed because the package is not installed.
    #[serde(default)]
    pub missing: Option<String>,
}

/// How the kernel treated the `environment` of an `evaluate` request.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EnvironmentResult {
    pub path: String,
    #[serde(default)]
    pub error: Option<String>,
}

/// The `repl` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReplResult {
    pub incomplete: bool,
    pub output: String,
    pub value: Option<String>,
    pub error: Option<String>,
    pub trace: Option<String>,
    pub duration: f64,
}

/// The `complete` result: candidates and the range of characters they replace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Completions {
    pub items: Vec<String>,
    pub from: usize,
    pub to: usize,
}

/// The `install_packages` result (protocol section 8).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InstallResult {
    pub environment: String,
    pub packages: Vec<String>,
    #[serde(default)]
    pub log: String,
}

/// The decoded `evaluate` result. Binary matrices are materialized to inline values.
#[derive(Debug, Clone, PartialEq)]
pub struct EvaluateResponse {
    pub regions: Vec<RegionResult>,
    pub packages: Vec<PackageResult>,
    /// How each module file of the request loaded; `name` is its path.
    pub modules: Vec<PackageResult>,
    /// Present when the request named an environment.
    pub environment: Option<EnvironmentResult>,
}

#[derive(Deserialize)]
struct WireEvaluate {
    regions: Vec<WireRegion>,
    #[serde(default)]
    packages: Vec<PackageResult>,
    #[serde(default)]
    modules: Vec<PackageResult>,
    #[serde(default)]
    environment: Option<EnvironmentResult>,
}

#[derive(Deserialize)]
struct WireRegion {
    id: String,
    status: String,
    #[serde(default)]
    value: Option<KernelValue>,
    #[serde(default)]
    display_unit: Option<KernelValue>,
    #[serde(default)]
    display_offset: f64,
    #[serde(default)]
    error: Option<RegionError>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
}

impl EvaluateResponse {
    pub fn from_response(response: &KernelResponse) -> Result<Self, KernelError> {
        let invalid = |message: String| KernelError::InvalidResponse(message);
        let wire: WireEvaluate = serde_json::from_value(response.result.clone())
            .map_err(|error| invalid(error.to_string()))?;
        let mut regions = Vec::with_capacity(wire.regions.len());
        for region in wire.regions {
            let outcome = match region.status.as_str() {
                "ok" => RegionOutcome::Value(
                    region
                        .value
                        .map(|value| value.materialize_shared(&response.binary, &response.payloads))
                        .transpose()
                        .map_err(|error: ValueError| {
                            invalid(format!("region {}: {error}", region.id))
                        })?,
                ),
                "error" => RegionOutcome::Error(region.error.ok_or_else(|| {
                    invalid(format!(
                        "region {} has status error but no error",
                        region.id
                    ))
                })?),
                other => return Err(invalid(format!("unknown region status `{other}`"))),
            };
            regions.push(RegionResult {
                id: region.id,
                outcome,
                display_unit: region.display_unit,
                display_offset: region.display_offset,
                output: region.output,
                duration: region.duration,
            });
        }
        Ok(EvaluateResponse {
            regions,
            packages: wire.packages,
            modules: wire.modules,
            environment: wire.environment,
        })
    }

    pub fn region(&self, id: &str) -> Option<&RegionResult> {
        self.regions.iter().find(|region| region.id == id)
    }
}

#[cfg(test)]
mod stderr_tests {
    use super::*;

    #[test]
    fn the_first_error_and_its_message_survive_a_long_stack_trace() {
        let mut text = String::from("Precompiling EquavelaKernel...\n");
        text.push_str(
            "ERROR: LoadError: Package EqRuntime does not have Zlib_jll in its dependencies\n",
        );
        for frame in 0..200 {
            text.push_str(&format!(" [{frame}] frame\n"));
        }
        let tail = Mutex::new(VecDeque::new());
        drain_stderr(text.as_bytes(), &tail);
        let lines: Vec<String> = lock(&tail).iter().cloned().collect();
        assert_eq!(lines.len(), STDERR_TAIL_LINES);
        assert!(lines[0].starts_with("ERROR: LoadError: Package EqRuntime"));
        assert_eq!(lines.last().unwrap(), " [199] frame");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod pty_lifecycle_tests {
    use super::*;

    #[test]
    fn dropping_pty_process_stops_child_process_group() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg("sleep 60 & echo CHILD:$!; wait");
        let child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        drop(pair.slave);
        let mut reader = BufReader::new(pair.master.try_clone_reader().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let descendant: u32 = line.trim().strip_prefix("CHILD:").unwrap().parse().unwrap();
        let process = PtyProcess {
            child,
            pid,
            group_cleaned: false,
        };
        assert!(std::path::Path::new(&format!("/proc/{descendant}")).exists());
        drop(process);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stat = std::fs::read_to_string(format!("/proc/{descendant}/stat"));
            if stat.as_ref().map_or(true, |s| {
                s.rsplit_once(')')
                    .is_some_and(|(_, tail)| tail.trim_start().starts_with('Z'))
            }) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "PTY descendant {descendant} survived shutdown"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
}
