use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
pub struct PluginInfo {
    pub name: String,
    pub enabled: bool,
    pub version: String,
    pub scope: String,
}

#[derive(Clone, Serialize)]
pub struct McpServerEntry {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct ClaudeConfigSnapshot {
    pub settings_raw: Value,
    pub plugins: Vec<PluginInfo>,
    pub mcp_servers: Vec<McpServerEntry>,
    pub global_memory: Option<String>,
    pub project_memory: Option<String>,
}

fn claude_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude"))
}

fn encode_project_path(path: &str) -> String {
    path.replace(['/', '\\', ':'], "-")
}

fn read_json_file(path: &Path) -> Option<Value> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
pub fn read_claude_config(project_path: Option<String>) -> Result<ClaudeConfigSnapshot, String> {
    let claude = claude_dir().ok_or("Could not find home directory")?;

    // Read settings.json
    let settings_path = claude.join("settings.json");
    let settings_raw = read_json_file(&settings_path).unwrap_or(Value::Object(Default::default()));

    // Extract enabled plugins from settings
    let enabled_plugins: HashMap<String, bool> = settings_raw
        .get("enabledPlugins")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    // Read installed_plugins.json
    let plugins_path = claude.join("plugins").join("installed_plugins.json");
    let plugins_raw = read_json_file(&plugins_path);

    let mut plugins = Vec::new();
    if let Some(raw) = plugins_raw {
        if let Some(plugins_map) = raw.get("plugins").and_then(|v| v.as_object()) {
            for (name, installs) in plugins_map {
                let install = installs
                    .as_array()
                    .and_then(|arr| arr.first());

                let version = install
                    .and_then(|i| i.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                let scope = install
                    .and_then(|i| i.get("scope"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("user")
                    .to_string();

                let enabled = enabled_plugins.get(name).copied().unwrap_or(false);

                plugins.push(PluginInfo {
                    name: name.clone(),
                    enabled,
                    version,
                    scope,
                });
            }
        }
    }

    // Extract MCP servers from settings.json and ~/.claude.json
    let mut mcp_servers = Vec::new();
    let mut seen_names = std::collections::HashSet::new();

    // Check both sources for mcpServers
    let home = dirs::home_dir();
    let claude_json_raw = home.as_ref()
        .and_then(|h| read_json_file(&h.join(".claude.json")));

    let mcp_sources: Vec<&Value> = [
        Some(&settings_raw),
        claude_json_raw.as_ref(),
    ].into_iter().flatten().collect();

    for source in mcp_sources {
        if let Some(servers) = source.get("mcpServers").and_then(|v| v.as_object()) {
            for (name, config) in servers {
                if seen_names.contains(name) { continue; }
                seen_names.insert(name.clone());

                let command = config
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let args = config
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();

                mcp_servers.push(McpServerEntry {
                    name: name.clone(),
                    command,
                    args,
                });
            }
        }
    }

    // Read global CLAUDE.md
    let global_memory = std::fs::read_to_string(claude.join("CLAUDE.md")).ok();

    // Read project-level CLAUDE.md
    let project_memory = project_path.and_then(|path| {
        let encoded = encode_project_path(&path);
        // Check project's own CLAUDE.md
        let project_claude = Path::new(&path).join("CLAUDE.md");
        if project_claude.exists() {
            return std::fs::read_to_string(project_claude).ok();
        }
        // Check .claude/CLAUDE.md in project
        let dot_claude = Path::new(&path).join(".claude").join("CLAUDE.md");
        if dot_claude.exists() {
            return std::fs::read_to_string(dot_claude).ok();
        }
        // Check in ~/.claude/projects/
        let projects_dir = claude.join("projects").join(&encoded);
        let memory_dir = projects_dir.join("memory");
        if memory_dir.exists() {
            // Read MEMORY.md index if it exists
            return std::fs::read_to_string(memory_dir.join("MEMORY.md")).ok();
        }
        None
    });

    Ok(ClaudeConfigSnapshot {
        settings_raw,
        plugins,
        mcp_servers,
        global_memory,
        project_memory,
    })
}

#[tauri::command]
pub fn save_claude_settings(settings_json: String) -> Result<(), String> {
    // Validate it's valid JSON first
    let _: Value =
        serde_json::from_str(&settings_json).map_err(|e| format!("Invalid JSON: {}", e))?;

    let claude = claude_dir().ok_or("Could not find home directory")?;
    let settings_path = claude.join("settings.json");

    std::fs::write(&settings_path, &settings_json)
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn read_memory_file(path: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read file: {}", e)),
    }
}

#[tauri::command]
pub fn save_memory_file(path: String, content: String) -> Result<(), String> {
    // Create parent directories if needed
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }

    std::fs::write(&path, &content).map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

// --- Project Memories ---

#[derive(Clone, Serialize)]
pub struct MemoryFile {
    pub name: String,
    pub path: String,
    pub content: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectMemories {
    pub project_path: String,
    pub project_name: String,
    pub claude_md: Option<String>,
    pub claude_md_path: Option<String>,
    pub memory_index: Option<String>,
    pub memory_files: Vec<MemoryFile>,
    pub global_claude_md: Option<String>,
}

#[tauri::command]
pub fn read_project_memories(project_path: String) -> Result<ProjectMemories, String> {
    let claude = claude_dir().ok_or("Could not find home directory")?;
    let project = Path::new(&project_path);

    let project_name = project
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    // Read global CLAUDE.md
    let global_claude_md = std::fs::read_to_string(claude.join("CLAUDE.md")).ok();

    // Find project CLAUDE.md (check multiple locations)
    let (claude_md, claude_md_path) = {
        let p1 = project.join("CLAUDE.md");
        let p2 = project.join(".claude").join("CLAUDE.md");
        if p1.exists() {
            (std::fs::read_to_string(&p1).ok(), Some(p1.to_string_lossy().to_string()))
        } else if p2.exists() {
            (std::fs::read_to_string(&p2).ok(), Some(p2.to_string_lossy().to_string()))
        } else {
            (None, None)
        }
    };

    // Read memory files from ~/.claude/projects/<encoded>/memory/
    let encoded = encode_project_path(&project_path);
    let memory_dir = claude.join("projects").join(&encoded).join("memory");

    let memory_index = if memory_dir.join("MEMORY.md").exists() {
        std::fs::read_to_string(memory_dir.join("MEMORY.md")).ok()
    } else {
        None
    };

    let mut memory_files = Vec::new();
    if memory_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&memory_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "MEMORY.md" {
                    continue; // Already read as index
                }
                let path = entry.path();
                if path.is_file() {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        memory_files.push(MemoryFile {
                            name,
                            path: path.to_string_lossy().to_string(),
                            content,
                        });
                    }
                }
            }
        }
    }

    memory_files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(ProjectMemories {
        project_path,
        project_name,
        claude_md,
        claude_md_path,
        memory_index,
        memory_files,
        global_claude_md,
    })
}

// --- Claude Scheduled Tasks & Sessions ---

#[derive(Clone, Serialize)]
pub struct ClaudeSession {
    pub pid: u64,
    pub session_id: String,
    pub cwd: String,
    pub started_at: i64,
    pub kind: String,
    pub entrypoint: String,
    pub name: Option<String>,
    pub alive: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: Option<String>,
    pub cron: Option<String>,
    pub prompt: Option<String>,
    pub recurring: Option<bool>,
    pub created_at: Option<i64>,
    pub last_run: Option<i64>,
    pub name: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ScheduledOverview {
    pub sessions: Vec<ClaudeSession>,
    pub scheduled_tasks: Vec<ScheduledTask>,
}

#[cfg(unix)]
fn is_pid_alive(pid: u64) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn is_pid_alive(pid: u64) -> bool {
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::winnt::PROCESS_QUERY_LIMITED_INFORMATION;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if handle.is_null() {
            false
        } else {
            CloseHandle(handle);
            true
        }
    }
}

#[tauri::command]
pub fn read_scheduled_tasks() -> Result<ScheduledOverview, String> {
    let claude = claude_dir().ok_or("Could not find home directory")?;

    // Read active sessions from ~/.claude/sessions/*.json
    let mut sessions = Vec::new();
    let sessions_dir = claude.join("sessions");
    if sessions_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "json").unwrap_or(false) {
                    if let Ok(content) = std::fs::read_to_string(&path) {
                        if let Ok(val) = serde_json::from_str::<Value>(&content) {
                            let pid = val.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                            let alive = if pid > 0 { is_pid_alive(pid) } else { false };

                            sessions.push(ClaudeSession {
                                pid,
                                session_id: val
                                    .get("sessionId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                cwd: val
                                    .get("cwd")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                started_at: val
                                    .get("startedAt")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(0),
                                kind: val
                                    .get("kind")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                entrypoint: val
                                    .get("entrypoint")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                name: val
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .map(String::from),
                                alive,
                            });
                        }
                    }
                }
            }
        }
    }

    // Sort: alive first, then by started_at descending
    sessions.sort_by(|a, b| {
        b.alive
            .cmp(&a.alive)
            .then(b.started_at.cmp(&a.started_at))
    });

    // Read scheduled tasks from ~/.claude/scheduled_tasks.json if it exists
    let mut scheduled_tasks = Vec::new();
    let tasks_path = claude.join("scheduled_tasks.json");
    if tasks_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&tasks_path) {
            // Try parsing as array first, then as object with a tasks field
            if let Ok(tasks) = serde_json::from_str::<Vec<ScheduledTask>>(&content) {
                scheduled_tasks = tasks;
            } else if let Ok(val) = serde_json::from_str::<Value>(&content) {
                if let Some(arr) = val.get("tasks").and_then(|v| v.as_array()) {
                    for item in arr {
                        if let Ok(task) = serde_json::from_value::<ScheduledTask>(item.clone()) {
                            scheduled_tasks.push(task);
                        }
                    }
                }
            }
        }
    }

    Ok(ScheduledOverview {
        sessions,
        scheduled_tasks,
    })
}

// --- Session Persistence ---

fn pane_street_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".pane-street"))
}

#[tauri::command]
pub fn save_sessions(json: String) -> Result<(), String> {
    let dir = pane_street_dir().ok_or("Could not find home directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    std::fs::write(dir.join("sessions.json"), &json)
        .map_err(|e| format!("Failed to write sessions: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn load_sessions() -> Result<Option<String>, String> {
    let path = pane_street_dir()
        .ok_or("Could not find home directory")?
        .join("sessions.json");
    if path.exists() {
        std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| format!("Failed to read sessions: {}", e))
    } else {
        Ok(None)
    }
}
