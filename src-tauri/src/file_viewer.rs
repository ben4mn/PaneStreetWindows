use serde::Serialize;
use std::fs;
use std::path::Path;
use crate::cmd_util::silent_cmd;

#[derive(Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub extension: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub content: String,
    pub is_binary: bool,
    pub size: u64,
    pub path: String,
}

#[tauri::command]
pub fn read_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let show_hidden = show_hidden.unwrap_or(false);
    let mut entries = Vec::new();

    let read_dir = fs::read_dir(dir_path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files unless requested
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let entry_path = entry.path();
        let metadata = entry.metadata().ok();
        let is_symlink = entry_path.symlink_metadata().map(|m| m.is_symlink()).unwrap_or(false);
        let is_dir = entry_path.is_dir();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let extension = entry_path.extension().map(|e| e.to_string_lossy().to_string());

        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            is_symlink,
            size,
            extension,
        });
    }

    // Sort: directories first, then files, both alphabetical (case-insensitive)
    entries.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file_content(path: String, max_bytes: Option<u64>) -> Result<FileContent, String> {
    let file_path = Path::new(&path);
    if !file_path.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(&path).map_err(|e| format!("Failed to read metadata: {}", e))?;
    let size = metadata.len();
    let max = max_bytes.unwrap_or(1_048_576); // 1MB default cap

    if size > max {
        return Ok(FileContent {
            content: format!("[File too large: {} bytes, max {} bytes]", size, max),
            is_binary: false,
            size,
            path,
        });
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Check if binary (contains null bytes in first 8KB)
    let check_len = bytes.len().min(8192);
    let is_binary = bytes[..check_len].contains(&0);

    if is_binary {
        return Ok(FileContent {
            content: format!("[Binary file: {} bytes]", size),
            is_binary: true,
            size,
            path,
        });
    }

    let content = String::from_utf8_lossy(&bytes).to_string();

    Ok(FileContent {
        content,
        is_binary: false,
        size,
        path,
    })
}

#[tauri::command]
pub fn open_in_finder(path: String) -> Result<(), String> {
    let target = Path::new(&path);

    #[cfg(target_os = "macos")]
    {
        if target.is_file() {
            silent_cmd("open")
                .args(["-R", &path])
                .spawn()
                .map_err(|e| format!("Failed to open Finder: {}", e))?;
        } else {
            let dir = if target.is_dir() {
                path.clone()
            } else {
                target.parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "/".to_string())
            };
            silent_cmd("open")
                .arg(&dir)
                .spawn()
                .map_err(|e| format!("Failed to open Finder: {}", e))?;
        }

        let _ = silent_cmd("osascript")
            .args(["-e", r#"tell application "System Events" to tell process "Finder" to keystroke "." using {command down, shift down}"#])
            .spawn();
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            silent_cmd("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        } else {
            let dir = if target.is_dir() {
                path.clone()
            } else {
                target.parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "C:\\".to_string())
            };
            silent_cmd("explorer")
                .arg(&dir)
                .spawn()
                .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let dir = if target.is_dir() {
            path.clone()
        } else {
            target.parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string())
        };
        let _ = silent_cmd("xdg-open")
            .arg(&dir)
            .spawn();
    }

    Ok(())
}

#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    silent_cmd("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open: {}", e))?;

    #[cfg(target_os = "windows")]
    silent_cmd("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| format!("Failed to open: {}", e))?;

    #[cfg(target_os = "linux")]
    silent_cmd("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open: {}", e))?;

    Ok(())
}
