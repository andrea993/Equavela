//! PTY transport and bounded byte history for a Julia terminal.
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{MasterPty, PtySize};
use serde::Serialize;

const HISTORY_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct TerminalSnapshot {
    pub generation: u64,
    /// Offset immediately following the returned bytes.
    pub sequence: u64,
    pub data: Vec<u8>,
}

#[derive(Default)]
struct History {
    bytes: VecDeque<u8>,
    sequence: u64,
    closed: bool,
}

impl History {
    fn snapshot(&self, generation: u64, after: u64) -> io::Result<TerminalSnapshot> {
        if self.closed && after >= self.sequence {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "terminal process exited",
            ));
        }
        let first = self.sequence - self.bytes.len() as u64;
        let start = after.max(first).min(self.sequence) - first;
        Ok(TerminalSnapshot {
            generation,
            sequence: self.sequence,
            data: self.bytes.iter().skip(start as usize).copied().collect(),
        })
    }
}

pub(crate) struct Terminal {
    generation: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    history: Arc<Mutex<History>>,
}

fn error(e: impl std::fmt::Display) -> io::Error {
    io::Error::other(e.to_string())
}

/// The cursor position request (DSR 6) and the reply that puts the cursor at the top left.
const CURSOR_REQUEST: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// Removes cursor position requests from the terminal output and counts them. On Windows the
/// pseudo console that `portable_pty` opens inherits the cursor: it asks for the cursor position
/// once and holds the child's output until the reply arrives, so the reader must answer it
///. A request split across two reads is held back until it is complete.
#[derive(Default)]
struct CursorRequests {
    pending: Vec<u8>,
}

impl CursorRequests {
    fn filter(&mut self, input: &[u8], output: &mut Vec<u8>) -> usize {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(input);
        let mut requests = 0;
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i..].starts_with(CURSOR_REQUEST) {
                requests += 1;
                i += CURSOR_REQUEST.len();
            } else if CURSOR_REQUEST.starts_with(&bytes[i..]) {
                self.pending.extend_from_slice(&bytes[i..]);
                break;
            } else {
                output.push(bytes[i]);
                i += 1;
            }
        }
        requests
    }
}

impl Terminal {
    pub(crate) fn new(master: Box<dyn MasterPty + Send>, generation: u64) -> io::Result<Self> {
        let mut reader = master.try_clone_reader().map_err(error)?;
        let writer = Arc::new(Mutex::new(master.take_writer().map_err(error)?));
        let history = Arc::new(Mutex::new(History::default()));
        let target = Arc::clone(&history);
        let answer = Arc::clone(&writer);
        thread::spawn(move || {
            let mut buffer = [0; 8192];
            let mut requests = CursorRequests::default();
            let mut shown = Vec::with_capacity(buffer.len());
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                shown.clear();
                if cfg!(windows) {
                    for _ in 0..requests.filter(&buffer[..n], &mut shown) {
                        let mut w = answer.lock().unwrap_or_else(|e| e.into_inner());
                        let _ = w.write_all(CURSOR_REPLY).and_then(|()| w.flush());
                    }
                } else {
                    shown.extend_from_slice(&buffer[..n]);
                }
                let mut h = target.lock().unwrap_or_else(|e| e.into_inner());
                h.sequence += shown.len() as u64;
                h.bytes.extend(&shown);
                let excess = h.bytes.len().saturating_sub(HISTORY_LIMIT);
                h.bytes.drain(..excess);
            }
            target.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        });
        Ok(Self {
            generation,
            master: Mutex::new(master),
            writer,
            history,
        })
    }

    pub(crate) fn read(&self, after: u64) -> io::Result<TerminalSnapshot> {
        self.history
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(self.generation, after)
    }

    pub(crate) fn write(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        writer.write_all(bytes)?;
        writer.flush()
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        if cols == 0 || rows == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "terminal dimensions must be nonzero",
            ));
        }
        self.master
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::{CursorRequests, History};
    use crate::kernel_manager::{KernelConfig, KernelManager};
    use std::time::{Duration, Instant};

    #[test]
    fn cursor_requests_are_removed_and_counted_even_when_split() {
        let mut requests = CursorRequests::default();
        let mut shown = Vec::new();
        assert_eq!(requests.filter(b"a\x1b[6nb\x1b[6n", &mut shown), 2);
        assert_eq!(shown, b"ab");

        shown.clear();
        assert_eq!(requests.filter(b"c\x1b[", &mut shown), 0);
        assert_eq!(shown, b"c");
        assert_eq!(requests.filter(b"6nd", &mut shown), 1);
        assert_eq!(shown, b"cd");

        // Other escape sequences pass through untouched, also when they start like a request.
        shown.clear();
        assert_eq!(requests.filter(b"\x1b[6;1H\x1b[0m", &mut shown), 0);
        assert_eq!(shown, b"\x1b[6;1H\x1b[0m");
    }

    /// `text` without its terminal control sequences (CSI `ESC [ … final` and OSC `ESC ] … BEL`).
    fn without_escapes(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            if c != '\x1b' {
                out.push(c);
                continue;
            }
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.peek() == Some(&'\\')) {
                            if c == '\x1b' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        out
    }

    #[test]
    fn escapes_are_removed_from_terminal_text() {
        assert_eq!(
            without_escapes("RUNTIME_READY=\x1b[?2004h\x1b[?25ltrue\x1b[32m\x1b]0;t\x07!"),
            "RUNTIME_READY=true!"
        );
    }

    fn wait_for(manager: &KernelManager, after: u64, expected: &str) -> (u64, String) {
        wait_for_timeout(manager, after, expected, Duration::from_secs(40))
    }

    fn wait_for_timeout(
        manager: &KernelManager,
        after: u64,
        expected: &str,
        timeout: Duration,
    ) -> (u64, String) {
        let deadline = Instant::now() + timeout;
        let mut sequence = after;
        let mut output = Vec::new();
        loop {
            let snapshot = manager.terminal_read(sequence).unwrap();
            sequence = snapshot.sequence;
            output.extend(snapshot.data);
            let text = String::from_utf8_lossy(&output).into_owned();
            // The Windows console interleaves cursor sequences with the printed text
            // (`RUNTIME_READY=\x1b[?25ltrue`): the text is matched without them.
            if text.contains(expected) || without_escapes(&text).contains(expected) {
                return (sequence, text);
            }
            assert!(
                Instant::now() < deadline,
                "terminal did not show {expected:?}: {text:?}"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn history_reports_generation_offsets_and_eof() {
        let mut history = History::default();
        history.bytes.extend(b"abc");
        history.sequence = 3;
        let first = history.snapshot(4, 0).unwrap();
        assert_eq!(
            (first.generation, first.sequence, first.data),
            (4, 3, b"abc".to_vec())
        );
        let new = history.snapshot(5, 9).unwrap();
        assert_eq!((new.generation, new.sequence, new.data), (5, 3, Vec::new()));
        assert_eq!(history.snapshot(5, 0).unwrap().data, b"abc");
        history.closed = true;
        assert_eq!(history.snapshot(5, 1).unwrap().data, b"bc");
        assert_eq!(
            history.snapshot(5, 3).unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn real_terminal_and_rpc_share_process_and_lifecycle() {
        if std::process::Command::new("julia")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        std::fs::write(temporary.path().join("Project.toml"), "[deps]\n").unwrap();
        let mut config = KernelConfig::new(root.join("kernel/EquavelaKernel"));
        config.env.push((
            "JULIA_HISTORY".into(),
            temporary.path().join("history.jl").into_os_string(),
        ));
        config.env.push((
            "EQUAVELA_TERMINAL_ENVIRONMENT".into(),
            temporary.path().as_os_str().into(),
        ));
        config.terminal = true;
        config.request_timeout = Some(Duration::from_secs(30));
        config
            .env
            .push(("EQUAVELA_SYMBOLIC_WARMUP".into(), "off".into()));
        let manager = std::sync::Arc::new(KernelManager::new(config));
        let initial = manager.terminal_open(90, 30).unwrap();
        let (_, text) = wait_for(&manager, 0, "julia>");
        assert!(text.contains("julia>"));
        let pid = manager
            .request("repl", Some(serde_json::json!({"code":"getpid()"})))
            .unwrap();
        let pid = pid.result["value"].as_str().unwrap();
        manager
            .terminal_write(b"println(\"PTY_PROCESS=\", getpid())\r")
            .unwrap();
        let (seq, _) = wait_for(&manager, initial.sequence, &format!("PTY_PROCESS={pid}"));
        manager.terminal_write(b"println(\"RUNTIME_READY=\", isdefined(Main, :EqRuntime) && isdefined(Main, :eq_identity) && !isdefined(Main, :REPL) && !isdefined(Main, :Sockets) && !isdefined(Main, :Pkg))\r").unwrap();
        let (seq, _) = wait_for(&manager, seq, "RUNTIME_READY=true");
        manager.terminal_write(b"1+2\r").unwrap();
        let (seq, _) = wait_for(&manager, seq, "3");
        manager.terminal_resize(100, 40).unwrap();
        manager
            .terminal_write(b"isdefined(Main, :Project)\r")
            .unwrap();
        let (seq, output) = wait_for(&manager, seq, "true");
        assert!(output.contains("true"));
        let mut seq = if output.contains("julia>") {
            seq
        } else {
            wait_for(&manager, seq, "julia>").0
        };

        manager.terminal_write(b"\t").unwrap();
        let (next, _) = wait_for(&manager, seq, "Project");
        seq = next;
        manager.terminal_write(b"?sin\r").unwrap();
        let (next, help) = wait_for(&manager, seq, "Compute sine");
        seq = if help
            .split("Compute sine")
            .last()
            .unwrap()
            .contains("\x1b[?2004h")
        {
            next
        } else {
            wait_for(&manager, next, "\x1b[?2004h").0
        };
        manager.terminal_write(b"]").unwrap();
        let (next, _) = wait_for(&manager, seq, "pkg>");
        seq = next;
        manager.terminal_write(b"status\r").unwrap();
        // Julia prints the environment by its long path; on Windows the temporary folder may be
        // spelled with an 8.3 short name, so the canonical path is expected (without `\\?\`).
        let canonical = temporary.path().canonicalize().unwrap();
        let canonical = canonical.to_string_lossy();
        let environment = canonical.strip_prefix(r"\\?\").unwrap_or(&canonical);
        let (next, status) = wait_for(&manager, seq, environment);
        assert!(status.contains(environment), "{status:?}");
        assert!(
            !status.contains("EquavelaKernel/Project.toml"),
            "{status:?}"
        );
        seq = if status.split(environment).last().unwrap().contains("pkg>") {
            next
        } else {
            wait_for(&manager, next, "pkg>").0
        };
        manager.terminal_write(b"\x7f").unwrap();
        let (next, _) = wait_for(&manager, seq, "julia>");
        seq = next;
        // `echo` is a program on Unix but a `cmd` built-in on Windows.
        let shell_echo: &[u8] = if cfg!(windows) {
            b";cmd /c echo MM_SHELL_MARKER\r"
        } else {
            b";echo MM_SHELL_MARKER\r"
        };
        manager.terminal_write(shell_echo).unwrap();
        let (next, shell) = wait_for(&manager, seq, "MM_SHELL_MARKER\r\n");
        seq = if shell
            .split("MM_SHELL_MARKER\r\n")
            .last()
            .unwrap()
            .contains("shell>")
        {
            next
        } else {
            wait_for(&manager, next, "shell>").0
        };
        manager.terminal_write(b"\x7f").unwrap();
        seq = wait_for(&manager, seq, "julia>").0;
        manager
            .terminal_write(b"begin\r println(\"MM_MULTILINE_OK\")\rend\r")
            .unwrap();
        let (next, multiline) = wait_for(&manager, seq, "MM_MULTILINE_OK\r\n");
        seq = if multiline
            .split("MM_MULTILINE_OK\r\n")
            .last()
            .unwrap()
            .contains("julia>")
        {
            next
        } else {
            wait_for(&manager, next, "julia>").0
        };

        // The unfinished line remains editable while the binary RPC response is read separately.
        manager.terminal_write(b"1+").unwrap();
        let request_manager = std::sync::Arc::clone(&manager);
        let capture = std::thread::spawn(move || {
            request_manager.request("evaluate", Some(serde_json::json!({
            "worksheet":"terminal_capture", "regions":[{"id":"capture", "code":"println(\"REGION_ONLY\"); sleep(3)", "capture":true}]
        })))
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while manager.active_request().is_none() {
            assert!(Instant::now() < deadline, "capture request did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        manager.terminal_write(b"2").unwrap();
        let captured = capture.join().unwrap().unwrap();
        assert_eq!(captured.result["regions"][0]["output"], "REGION_ONLY\n");
        let binary = manager.request("evaluate", Some(serde_json::json!({
            "worksheet":"terminal_binary", "regions":[{"id":"matrix", "value":"reshape(Float64.(1:400),20,20)"}]
        }))).unwrap();
        assert!(
            !binary.payloads.is_empty(),
            "binary array was not framed as binary: {:?}",
            binary.result
        );
        manager.terminal_write(b"\r").unwrap();
        let (next, edited) = wait_for(&manager, seq, "julia>");
        assert!(edited.contains('3'), "{edited:?}");
        assert!(
            !edited.contains("jsonrpc"),
            "RPC bytes leaked into terminal: {edited:?}"
        );
        assert!(
            !edited.contains("REGION_ONLY"),
            "worksheet output leaked into terminal: {edited:?}"
        );
        seq = next;

        manager
            .terminal_write(b"println(\"MM_SLEEP_STARTED\"); sleep(30)\r")
            .unwrap();
        let (next, _) = wait_for(&manager, seq, "MM_SLEEP_STARTED\r\n");
        manager.terminal_write(b"\x03").unwrap();
        let (_, interrupted) = wait_for_timeout(&manager, next, "julia>", Duration::from_secs(5));
        assert!(
            interrupted.contains("InterruptException"),
            "{interrupted:?}"
        );
        manager.ping().unwrap();
        manager.shutdown();
        assert!(manager.terminal_read(0).is_err());
        assert!(!manager.is_running());
    }
}
