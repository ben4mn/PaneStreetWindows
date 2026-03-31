use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const TRAILING_BUFFER_SIZE: usize = 512;
const IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const IDLE_CHECK_INTERVAL: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, PartialEq, Serialize)]
pub enum SessionStatus {
    Working,
    Idle,
    WaitingForInput,
    NeedsPermission,
    ClaudeNeedsInput,
    Error,
    ClaudeFinished,
    Exited,
}

impl SessionStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Working => "Working",
            Self::Idle => "Idle",
            Self::WaitingForInput => "WaitingForInput",
            Self::NeedsPermission => "NeedsPermission",
            Self::ClaudeNeedsInput => "ClaudeNeedsInput",
            Self::Error => "Error",
            Self::ClaudeFinished => "ClaudeFinished",
            Self::Exited => "Exited",
        }
    }
}

pub struct StatusState {
    pub current: SessionStatus,
    pub last_output_time: Instant,
    trailing_buffer: Vec<u8>,
}

impl StatusState {
    pub fn new() -> Self {
        Self {
            current: SessionStatus::Idle,
            last_output_time: Instant::now(),
            trailing_buffer: Vec::with_capacity(TRAILING_BUFFER_SIZE),
        }
    }
}

#[derive(Clone, Serialize)]
pub struct StatusEvent {
    pub session_id: String,
    pub status: String,
    pub exit_code: Option<i32>,
}

static STATUS_MAP: std::sync::LazyLock<Mutex<HashMap<String, StatusState>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static IDLE_CHECKER_STARTED: OnceLock<()> = OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());

    // Start idle checker once
    IDLE_CHECKER_STARTED.get_or_init(|| {
        let handle = app.clone();
        std::thread::spawn(move || idle_checker_loop(handle));
    });
}

pub fn register_session(session_id: &str) {
    if let Ok(mut map) = STATUS_MAP.lock() {
        map.insert(session_id.to_string(), StatusState::new());
    }
}

pub fn unregister_session(session_id: &str) {
    if let Ok(mut map) = STATUS_MAP.lock() {
        map.remove(session_id);
    }
}

#[cfg(unix)]
pub fn get_status(session_id: &str) -> String {
    if let Ok(map) = STATUS_MAP.lock() {
        if let Some(state) = map.get(session_id) {
            return state.current.as_str().to_string();
        }
    }
    "Unknown".to_string()
}

/// Called from the PTY read thread with each chunk of output.
/// Returns Some(new_status) if the status changed.
pub fn on_output(session_id: &str, data: &[u8]) -> Option<SessionStatus> {
    let mut map = STATUS_MAP.lock().ok()?;
    let state = map.get_mut(session_id)?;

    // Update trailing buffer
    state.trailing_buffer.extend_from_slice(data);
    if state.trailing_buffer.len() > TRAILING_BUFFER_SIZE {
        let excess = state.trailing_buffer.len() - TRAILING_BUFFER_SIZE;
        state.trailing_buffer.drain(..excess);
    }

    state.last_output_time = Instant::now();

    // Analyze the trailing buffer
    let new_status = analyze_buffer(&state.trailing_buffer);

    if new_status != state.current {
        state.current = new_status.clone();
        return Some(new_status);
    }

    None
}

/// Called when a PTY read loop exits (EOF or error).
pub fn on_exit(session_id: &str, exit_code: i32) {
    if let Ok(mut map) = STATUS_MAP.lock() {
        if let Some(state) = map.get_mut(session_id) {
            state.current = SessionStatus::Exited;
        }
    }

    emit_status(session_id, "Exited", Some(exit_code));
}

/// Strip ANSI escape sequences from text for reliable pattern matching.
fn strip_ansi(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // Skip CSI sequences: ESC [ ... final byte (0x40-0x7E)
            if chars.peek() == Some(&'[') {
                chars.next(); // consume '['
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            // Skip OSC sequences: ESC ] ... BEL or ESC \
            } else if chars.peek() == Some(&']') {
                chars.next();
                while let Some(&next) = chars.peek() {
                    if next == '\x07' {
                        chars.next();
                        break;
                    }
                    if next == '\x1b' {
                        chars.next();
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                    chars.next();
                }
            } else {
                // Skip other single-char escapes
                chars.next();
            }
        } else {
            result.push(c);
        }
    }
    result
}

fn analyze_buffer(buffer: &[u8]) -> SessionStatus {
    let raw = String::from_utf8_lossy(buffer);
    let text = strip_ansi(&raw);
    // Look at the last ~400 chars for prompt detection (increased for Claude prompts)
    let tail = if text.len() > 400 {
        let mut start = text.len() - 400;
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        &text[start..]
    } else {
        &text
    };

    // Claude Code specific: plan approval, input needed, attention needed
    if tail.contains("Claude Code needs your approval")
        || tail.contains("Claude Code needs your input")
        || tail.contains("Claude Code needs your attention")
    {
        return SessionStatus::ClaudeNeedsInput;
    }

    // Claude Code permission prompts (tool use approval)
    if tail.contains("Claude needs your permission") {
        return SessionStatus::WaitingForInput;
    }

    // Check for input prompts
    if tail.contains("(y/n)") || tail.contains("(Y/n)") || tail.contains("(yes/no)") {
        return SessionStatus::WaitingForInput;
    }

    // Check for Claude Code permission prompts
    if tail.contains("Allow") && (tail.contains("once") || tail.contains("always")) {
        return SessionStatus::WaitingForInput;
    }

    // Check for permission/sudo
    if tail.contains("Permission denied") || tail.contains("sudo:") {
        return SessionStatus::NeedsPermission;
    }

    // Check for Claude Code task completion
    if tail.contains("Total cost:") || tail.contains("Total tokens:") {
        return SessionStatus::ClaudeFinished;
    }

    // Check for common error patterns (conservative to avoid false positives
    // during normal compiler output, log lines, etc.)
    if tail.contains("command not found")
        || tail.contains("No such file or directory")
        || tail.contains("is not recognized as an internal or external command")
        || tail.contains("Access is denied")
        || tail.contains("panic:")
        || tail.contains("Traceback (most recent call last)")
        || tail.contains("SyntaxError:")
        || tail.contains("TypeError:")
        || tail.contains("ReferenceError:")
    {
        return SessionStatus::Error;
    }

    // If we just received output, we're working
    SessionStatus::Working
}

pub fn emit_status(session_id: &str, status: &str, exit_code: Option<i32>) {
    if let Some(handle) = APP_HANDLE.get() {
        let _ = handle.emit(
            "session-status-changed",
            StatusEvent {
                session_id: session_id.to_string(),
                status: status.to_string(),
                exit_code,
            },
        );
    }
}

fn idle_checker_loop(handle: AppHandle) {
    loop {
        std::thread::sleep(IDLE_CHECK_INTERVAL);

        let transitions: Vec<(String, SessionStatus)> = {
            let mut map = match STATUS_MAP.lock() {
                Ok(m) => m,
                Err(_) => continue,
            };

            let now = Instant::now();
            let mut changes = Vec::new();

            for (id, state) in map.iter_mut() {
                if state.current == SessionStatus::Working
                    && now.duration_since(state.last_output_time) > IDLE_TIMEOUT
                {
                    state.current = SessionStatus::Idle;
                    changes.push((id.clone(), SessionStatus::Idle));
                }
            }

            changes
        };

        // Emit events outside the lock
        for (id, status) in transitions {
            let _ = handle.emit(
                "session-status-changed",
                StatusEvent {
                    session_id: id,
                    status: status.as_str().to_string(),
                    exit_code: None,
                },
            );
        }
    }
}
