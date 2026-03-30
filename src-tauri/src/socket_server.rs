use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;

use crate::pty_manager;

#[derive(Deserialize)]
#[allow(dead_code)]
struct SocketCommand {
    cmd: String,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
struct SocketResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn socket_path() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".pane-street");
    std::fs::create_dir_all(&dir).ok();
    dir.join("panestreet.sock")
}

pub fn start(app_handle: tauri::AppHandle) {
    let path = socket_path();

    // Remove stale socket file
    let _ = std::fs::remove_file(&path);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to create tokio runtime for socket server");

        rt.block_on(async move {
            let listener = match UnixListener::bind(&path) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[socket_server] Failed to bind {}: {}", path.display(), e);
                    return;
                }
            };

            // Make socket accessible
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
            }

            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, app).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("[socket_server] Accept error: {}", e);
                    }
                }
            }
        });
    });
}

async fn handle_connection(stream: tokio::net::UnixStream, app: tauri::AppHandle) {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // Connection closed
            Ok(_) => {
                let response = process_command(line.trim(), &app);
                let json = serde_json::to_string(&response).unwrap_or_else(|_| {
                    r#"{"ok":false,"error":"serialize error"}"#.to_string()
                });
                let _ = writer.write_all(json.as_bytes()).await;
                let _ = writer.write_all(b"\n").await;
                let _ = writer.flush().await;
            }
            Err(_) => break,
        }
    }
}

fn process_command(input: &str, app: &tauri::AppHandle) -> SocketResponse {
    let cmd: SocketCommand = match serde_json::from_str(input) {
        Ok(c) => c,
        Err(e) => {
            return SocketResponse {
                ok: false,
                data: None,
                error: Some(format!("Invalid JSON: {}", e)),
            }
        }
    };

    match cmd.cmd.as_str() {
        "ping" => SocketResponse {
            ok: true,
            data: Some(serde_json::json!("pong")),
            error: None,
        },

        "list-sessions" => {
            let sessions = pty_manager::list_sessions();
            SocketResponse {
                ok: true,
                data: Some(serde_json::json!(sessions)),
                error: None,
            }
        }

        "write" => {
            let session_id = match cmd.session_id {
                Some(id) => id,
                None => {
                    return SocketResponse {
                        ok: false,
                        data: None,
                        error: Some("session_id required".to_string()),
                    }
                }
            };
            let data = cmd.data.unwrap_or_default();
            match pty_manager::write_to_pty(session_id, data.into_bytes()) {
                Ok(_) => SocketResponse {
                    ok: true,
                    data: None,
                    error: None,
                },
                Err(e) => SocketResponse {
                    ok: false,
                    data: None,
                    error: Some(e),
                },
            }
        }

        "get-status" => {
            let session_id = match cmd.session_id {
                Some(id) => id,
                None => {
                    return SocketResponse {
                        ok: false,
                        data: None,
                        error: Some("session_id required".to_string()),
                    }
                }
            };
            let status = crate::status_detector::get_status(&session_id);
            SocketResponse {
                ok: true,
                data: Some(serde_json::json!({ "status": status })),
                error: None,
            }
        }

        "notify" => {
            let title = cmd.title.unwrap_or_else(|| "PaneStreet".to_string());
            let body = cmd.body.unwrap_or_default();
            // Emit a Tauri event that the frontend can listen for
            let _ = app.emit(
                "socket-notification",
                serde_json::json!({ "title": title, "body": body }),
            );
            SocketResponse {
                ok: true,
                data: None,
                error: None,
            }
        }

        "focus" => {
            let session_id = match cmd.session_id {
                Some(id) => id,
                None => {
                    return SocketResponse {
                        ok: false,
                        data: None,
                        error: Some("session_id required".to_string()),
                    }
                }
            };
            let _ = app.emit(
                "socket-focus",
                serde_json::json!({ "session_id": session_id }),
            );
            SocketResponse {
                ok: true,
                data: None,
                error: None,
            }
        }

        _ => SocketResponse {
            ok: false,
            data: None,
            error: Some(format!("Unknown command: {}", cmd.cmd)),
        },
    }
}
