use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::ipc::Channel;

use crate::status_detector;

/// Find the best available shell on Windows.
/// Prefers pwsh (PowerShell 7+) > powershell.exe (Windows PowerShell 5) > COMSPEC (cmd.exe).
#[cfg(windows)]
fn find_windows_shell() -> String {
    // Check for user-configured shell preference
    if let Ok(shell) = std::env::var("PS_SHELL") {
        return shell;
    }

    // Prefer pwsh (PowerShell 7+) if available
    if let Ok(output) = crate::cmd_util::silent_cmd("where.exe").arg("pwsh.exe").output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(path) = stdout.lines().next() {
                let path = path.trim();
                if !path.is_empty() {
                    return path.to_string();
                }
            }
        }
    }

    // Fall back to Windows PowerShell 5.x (always present on Windows 10+)
    let ps_path = std::path::Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    if ps_path.exists() {
        return ps_path.to_string_lossy().to_string();
    }

    // Last resort: cmd.exe via COMSPEC
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

static PTY_MAP: std::sync::LazyLock<Mutex<HashMap<String, PtyHandle>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Serialize)]
pub struct PtyOutput {
    data: Vec<u8>,
}

/// List all active session IDs (used by socket API on Unix)
#[cfg(unix)]
pub fn list_sessions() -> Vec<String> {
    match PTY_MAP.lock() {
        Ok(map) => map.keys().cloned().collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
pub fn spawn_pty(
    app: tauri::AppHandle,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    session_id: Option<String>,
    on_data: Channel<PtyOutput>,
) -> Result<String, String> {
    // Initialize status detector with app handle (idempotent)
    status_detector::init(&app);

    let pty_system = native_pty_system();

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Determine the user's shell
    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    #[cfg(windows)]
    let shell = find_windows_shell();

    let mut cmd = CommandBuilder::new(&shell);
    #[cfg(unix)]
    cmd.arg("-l"); // Login shell for proper env on Unix
    #[cfg(windows)]
    {
        // PowerShell: disable logo banner for cleaner startup
        let shell_lower = shell.to_lowercase();
        if shell_lower.contains("pwsh") || shell_lower.contains("powershell") {
            cmd.arg("-NoLogo");
        }
    }
    cmd.env("TERM", "xterm-256color");

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    } else {
        // Default to home directory
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Drop the slave — we only need the master side
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let sid = session_id.clone();
    let sid_for_thread = sid.clone();

    // Register session for status tracking
    status_detector::register_session(&sid);

    // Spawn a dedicated OS thread for the blocking PTY read loop
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — process exited
                Ok(n) => {
                    let data = buf[..n].to_vec();

                    // Status detection on each chunk
                    if let Some(new_status) = status_detector::on_output(&sid_for_thread, &data) {
                        status_detector::emit_status(
                            &sid_for_thread,
                            new_status.as_str(),
                            None,
                        );
                    }

                    if on_data.send(PtyOutput { data }).is_err() {
                        break; // Channel closed
                    }
                }
                Err(_) => break,
            }
        }

        // PTY read loop exited — process finished
        status_detector::on_exit(&sid_for_thread, 0);
    });

    let handle = PtyHandle {
        writer,
        master: pair.master,
        child,
    };

    PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .insert(sid.clone(), handle);

    Ok(sid)
}

#[tauri::command]
pub fn write_to_pty(session_id: String, data: Vec<u8>) -> Result<(), String> {
    let mut map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let handle = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    handle
        .writer
        .write_all(&data)
        .map_err(|e| format!("Write error: {}", e))?;

    handle
        .writer
        .flush()
        .map_err(|e| format!("Flush error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn resize_pty(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let handle = map
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn kill_pty(session_id: String) -> Result<(), String> {
    let mut map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    if let Some(mut handle) = map.remove(&session_id) {
        let _ = handle.child.kill();
    }

    status_detector::unregister_session(&session_id);

    Ok(())
}

#[tauri::command]
pub fn get_process_cwd(session_id: String) -> Result<Option<String>, String> {
    let map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let handle = map
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let pid = match handle.child.process_id() {
        Some(pid) => pid,
        None => return Err("No PID available for session".to_string()),
    };

    get_process_cwd_impl(pid)
}

#[cfg(unix)]
fn get_process_cwd_impl(pid: u32) -> Result<Option<String>, String> {
    let output = crate::cmd_util::silent_cmd("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .map_err(|e| format!("lsof failed for PID {}: {}", pid, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("lsof returned error for PID {}: {}", pid, stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix('n') {
            if path.starts_with('/') {
                return Ok(Some(path.to_string()));
            }
        }
    }

    Err(format!("lsof returned no CWD for PID {}. Output: {}", pid, stdout))
}

#[cfg(windows)]
fn get_process_cwd_impl(pid: u32) -> Result<Option<String>, String> {
    // Use wmic (fast, no PowerShell startup overhead) to find the shell's
    // most recent child process and infer CWD from it.
    // When user runs a command after `cd`, the child inherits the shell's CWD.
    let output = crate::cmd_util::silent_cmd("wmic")
        .args([
            "process", "where",
            &format!("ParentProcessId={}", pid),
            "get", "ExecutablePath",
            "/format:list",
        ])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines().rev() {
                if let Some(path_str) = line.strip_prefix("ExecutablePath=") {
                    let path_str = path_str.trim();
                    if !path_str.is_empty() {
                        if let Some(parent) = std::path::Path::new(path_str).parent() {
                            if parent.exists() {
                                return Ok(Some(parent.to_string_lossy().to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    // Fallback: return the user's home directory so the file viewer has something to show
    Ok(dirs::home_dir().map(|h| h.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn get_listening_ports(session_id: String) -> Result<Vec<u16>, String> {
    let map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let handle = map
        .get(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    let pid = match handle.child.process_id() {
        Some(pid) => pid,
        None => return Ok(vec![]),
    };

    get_listening_ports_impl(pid)
}

#[cfg(unix)]
fn get_listening_ports_impl(pid: u32) -> Result<Vec<u16>, String> {
    let output = crate::cmd_util::silent_cmd("lsof")
        .args(["-a", "-p", &pid.to_string(), "-i", "-sTCP:LISTEN", "-Fn"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Ok(vec![]),
    };

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut ports = Vec::new();
    for line in stdout.lines() {
        if let Some(name) = line.strip_prefix('n') {
            if let Some(port_str) = name.rsplit(':').next() {
                if let Ok(port) = port_str.parse::<u16>() {
                    if !ports.contains(&port) {
                        ports.push(port);
                    }
                }
            }
        }
    }

    Ok(ports)
}

#[cfg(windows)]
fn get_listening_ports_impl(pid: u32) -> Result<Vec<u16>, String> {
    let output = crate::cmd_util::silent_cmd("netstat")
        .args(["-ano", "-p", "TCP"])
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Ok(vec![]),
    };

    if !output.status.success() {
        return Ok(vec![]);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let pid_str = pid.to_string();
    let mut ports = Vec::new();
    for line in stdout.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Format: TCP  0.0.0.0:PORT  0.0.0.0:0  LISTENING  PID
        if parts.len() >= 5 && parts[4] == pid_str {
            if let Some(addr) = parts[1].rsplit(':').next() {
                if let Ok(port) = addr.parse::<u16>() {
                    if !ports.contains(&port) {
                        ports.push(port);
                    }
                }
            }
        }
    }

    Ok(ports)
}

#[tauri::command]
pub fn get_pr_status(cwd: String) -> Result<Option<serde_json::Value>, String> {
    // Shell out to gh CLI for PR status
    let output = crate::cmd_util::silent_cmd("gh")
        .args(["pr", "view", "--json", "number,title,state,url"])
        .current_dir(&cwd)
        .output();

    let output = match output {
        Ok(o) => o,
        Err(_) => return Ok(None), // gh not installed or not available
    };

    if !output.status.success() {
        return Ok(None); // No PR or not in a git repo
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(v) => Ok(Some(v)),
        Err(_) => Ok(None),
    }
}

/// Send Shift+Enter to the PTY session.
/// On Windows, ConPTY mangles Kitty CSI u sequences, so we use the win32-input-mode
/// format that ConPTY natively understands: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
/// On Unix, we write the Kitty CSI u sequence directly.
#[tauri::command]
pub fn send_shift_enter(session_id: String) -> Result<(), String> {
    let mut map = PTY_MAP
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    let handle = map
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    use std::io::Write;

    #[cfg(unix)]
    {
        // On Unix, write Kitty CSI u directly — no ConPTY involved
        handle.writer
            .write_all(b"\x1b[13;2u")
            .map_err(|e| format!("Write error: {}", e))?;
    }

    #[cfg(windows)]
    {
        // On Windows, ConPTY mangles escape sequences. Send a raw LF (0x0a)
        // which is distinct from CR (0x0d / Enter). Claude Code in raw mode
        // reads bytes directly and interprets LF as newline insertion.
        handle.writer
            .write_all(b"\x0a")
            .map_err(|e| format!("Write error: {}", e))?;
    }

    handle.writer.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}
