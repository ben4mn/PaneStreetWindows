# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PaneStreet for Windows is a native terminal multiplexer built with Tauri 2.x. The frontend is vanilla HTML/CSS/JS (no framework, no bundler). The backend is Rust. Terminals are powered by xterm.js 6.0 with WebGL rendering and Windows ConPTY via the `portable-pty` crate.

## Build & Development Commands

```bash
npm install                # Install frontend deps (xterm.js, Tauri API, dialog plugin)
npm run tauri dev          # Run in development mode (hot-reloads frontend, rebuilds Rust on change)
npm run tauri build        # Production build — outputs .msi/.exe to src-tauri/target/release/bundle/
npm run vendor             # Copy node_modules assets to src/vendor/ (run after adding new JS deps)
```

Prerequisites: Node.js 18+, Rust toolchain, Visual Studio Build Tools (C++ workload).

There is no test suite, linter, or formatter configured.

## Architecture

**Frontend (`src/`)** — served directly as `frontendDist` (no build step). All JS is loaded via `<script>` tags in `index.html`.

- `js/app.js` — Core orchestrator: layout engine (auto-grid, freeform, snap-to-edge), session management, keyboard shortcuts, sidebar, notifications, mascot, theme system. This is the largest file and the main entry point.
- `js/terminal.js` — xterm.js session wrapper. Handles PTY spawn/kill, I/O streaming, resize, WebGL addon, fit addon, and Shift+Enter support via Tauri `invoke`.
- `js/config-panels.js` — Settings UI: themes, plugins, MCPs, Claude memory inspector, keyboard shortcut editor.
- `js/file-viewer.js` — File browser panel with CWD tracking, git diff indicators, and file preview.
- `css/main.css` — All styles including 16 theme definitions as CSS custom properties.

**Backend (`src-tauri/src/`)** — Rust Tauri commands exposed to the frontend via `tauri::generate_handler!` in `lib.rs`.

- `pty_manager.rs` — PTY lifecycle (spawn, write, resize, kill), CWD detection, port scanning, PR status, Shift+Enter injection. Central to the app's core function.
- `worktree_manager.rs` — Git operations via `git2` crate: branch info, commit graph, diff stats, worktree create/cleanup.
- `config_reader.rs` — Reads Claude Code config files (settings, plugins, MCPs, memory, scheduled tasks). Also handles session save/load persistence.
- `file_viewer.rs` — Directory listing and file content reading for the file browser.
- `status_detector.rs` — Detects running process type in each PTY for status display.
- `auth_manager.rs` — Keyring-based API key storage.
- `cmd_util.rs` — Silent process spawning (Windows `CREATE_NO_WINDOW` flag to prevent console flash).
- `socket_server.rs` — Unix-only IPC socket server (not active on Windows).

**Frontend-backend communication** — All calls use `window.__TAURI__.core.invoke("command_name", { args })`. There is no REST API or WebSocket layer; it's all Tauri IPC.

## Key Patterns

- **No build step for frontend**: JS files are loaded directly. New JS dependencies must be vendored into `src/vendor/` using `npm run vendor` (see `scripts/copy-vendor.js`).
- **Global Tauri**: `withGlobalTauri: true` in tauri.conf.json means the Tauri API is available as `window.__TAURI__` rather than via ES module imports.
- **Windows-specific considerations**: PTY uses ConPTY. Background process spawning uses `cmd_util::silent_command()` to avoid taskbar flash. Shift+Enter requires special handling via `send_shift_enter` command.
- **Session persistence**: Layout and terminal state are saved/loaded via `config_reader::save_sessions`/`load_sessions` to the user's app data directory.
