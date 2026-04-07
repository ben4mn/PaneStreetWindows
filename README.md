<p align="center">
  <img src="icon.png" alt="PaneStreet Logo" width="128" height="128">
</p>

<h1 align="center">PaneStreet for Windows</h1>

<p align="center">
  <strong>A modern terminal multiplexer for Windows</strong><br>
  Built with Tauri, Rust, and xterm.js — with Claude AI integration baked in.
</p>

<p align="center">
  <a href="https://github.com/ben4mn/PaneStreetWindows/releases/latest"><img src="https://img.shields.io/github/v/release/ben4mn/PaneStreetWindows?style=flat-square&color=2a6df0" alt="Latest Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ben4mn/PaneStreetWindows?style=flat-square&color=2a6df0" alt="MIT License"></a>
  <a href="https://github.com/ben4mn/PaneStreetWindows/stargazers"><img src="https://img.shields.io/github/stars/ben4mn/PaneStreetWindows?style=flat-square&color=2a6df0" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2B-0078D4?style=flat-square&logo=windows" alt="Platform">
  <img src="https://img.shields.io/badge/tauri-2.x-FFC131?style=flat-square&logo=tauri" alt="Tauri 2.x">
</p>

<p align="center">
  <a href="https://github.com/ben4mn/PaneStreetWindows/releases/latest">Download</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#keyboard-shortcuts">Shortcuts</a> •
  <a href="https://github.com/ben4mn/PaneStreet">macOS Version</a>
</p>

---

> **Upgrade Notice (v0.6.0):** If you're on v0.5.1 or earlier, please [download v0.6.0 manually](https://github.com/ben4mn/PaneStreetWindows/releases/tag/v0.6.0). This is a one-time upgrade — auto-updates are now fully working starting with v0.6.0.
>
> **New in v0.6.0:** mascot personality system (speech budget, stare-back, hiccups, command milestones), auto-tile panes (Ctrl+Shift+T), Claude Code hooks integration, file path click-to-open in terminal, mascot sidebar snapping, and 6 new animations.

<p align="center">
  <em>Windows port of <a href="https://github.com/ben4mn/PaneStreet">PaneStreet</a> — the native terminal multiplexer with Claude AI integration.</em>
</p>

## Why PaneStreet?

Terminal multiplexers like tmux are powerful but stuck in the 80s. PaneStreet brings multi-pane terminal management into a native desktop app with GPU-accelerated rendering, drag-and-drop window management, 16 built-in themes, and deep integration with Claude AI tools.

No config files. No arcane keybindings to memorize. Just open it and start working.

## Features

### Terminal Management
- **Multi-pane layouts** — Auto-grid, freeform drag-and-drop, or edge-snap split modes
- **GPU-accelerated rendering** — Powered by xterm.js with WebGL
- **Session persistence** — Layout and scrollback history survive restarts
- **Process status detection** — Know what's running in each pane at a glance
- **Directional navigation** — Move between panes with `Ctrl Alt Arrow` keys
- **Shift+Enter support** — Native newline insertion for Claude Code and other modern CLI tools
- **PowerShell by default** — Auto-detects pwsh (PowerShell 7) or falls back to Windows PowerShell

### Window Management
- **Three layout modes** — Auto-grid for quick setups, freeform for full control, snap-to-edge for tiling
- **Maximize / minimize panes** — Focus on one task, restore when ready
- **Minimized pane pills** — Quick access to backgrounded terminals in the footer

### Notifications & Monitoring
- **Notification sidebar** — Slide-in panel showing terminal alerts in plain language
- **Notification rings** — Pulsing glow on unfocused panes that need attention
- **Mascot notification relay** — When you're in the app, the mascot announces alerts from other terminals
- **Sidebar metadata** — CWD, listening ports, and PR status shown per session
- **OSC notification support** — Handles OSC 9, 99, and 777 terminal notifications
- **Native desktop notifications** — Per-status toggle with sound control, throttled to prevent taskbar flash

### File Browser
- **Built-in file viewer** — Browse directories without leaving the app
- **CWD tracking** — File browser follows your terminal's working directory
- **File preview** — Peek at file contents inline
- **Open in Explorer** — One click to jump to the file system

### Claude AI Integration
- **Plugin viewer** — See installed Claude plugins with version and scope info
- **MCP browser** — View configured Model Context Protocol servers
- **Memory inspector** — Browse project-specific and global Claude memory
- **Scheduled tasks** — Monitor active Claude Code sessions and scheduled tasks
- **Config reader** — Reads your Claude configuration automatically

### Git Integration
- **Branch display** — Current branch shown in the footer with dirty indicator
- **Expandable branch timeline** — Drag-resizable footer showing all branches with ahead/behind counts and commit history
- **File diff indicators** — Green/red +N/-N counts per file in the file browser
- **Inline diff highlighting** — Added/deleted lines highlighted when viewing changed files

### Robot Mascot
- **Interactive companion** — An animated robot that lives in the footer, walks around, and reacts to your work
- **Contextual awareness** — Detects terminal activity (builds, tests, deploys, errors) and comments on what it sees
- **Personality-driven easter eggs** — Click the mascot for escalating reactions with attitude
- **Configurable frequency** — Low, medium, or high activity levels, or disable entirely

### Customization
- **16 built-in themes** — Dark, Midnight Blue, Dracula, Nord, Solarized Dark, Gruvbox Dark, Tokyo Night, One Dark, Catppuccin Mocha, Rose Pine, Kanagawa, Everforest, Synthwave 84, Ayu Dark, Horizon, Moonlight
- **Custom themes** — Full color editor for every UI and terminal color
- **Rebindable keyboard shortcuts** — Customize every shortcut with conflict detection

## Installation

### Download (recommended)

Grab the latest `.msi` or `.exe` installer from the [Releases page](https://github.com/ben4mn/PaneStreetWindows/releases/latest).

| Installer | Format |
|-----------|--------|
| `PaneStreet_x.x.x_x64_en-US.msi` | MSI (recommended) |
| `PaneStreet_x.x.x_x64-setup.exe` | NSIS installer |

### Build from Source

Requires [Node.js](https://nodejs.org/) (18+), [Rust](https://rustup.rs/), and [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload).

```bash
git clone https://github.com/ben4mn/PaneStreetWindows.git
cd PaneStreetWindows
npm install
npm run tauri build
```

The `.msi` and `.exe` installers will be in `src-tauri/target/release/bundle/`.

### Development

```bash
npm run tauri dev
```

## Keyboard Shortcuts

All shortcuts are rebindable in **Settings > Keyboard Shortcuts**.

| Action | Default Shortcut |
|--------|-----------------|
| New Terminal | `Ctrl N` |
| Close Terminal | `Ctrl W` |
| Settings | `Ctrl ,` |
| Toggle Sidebar | `Ctrl B` |
| File Browser | `Ctrl Shift E` |
| Maximize Pane | `Ctrl Shift Enter` |
| Minimize Pane | `Ctrl M` |
| Restore All | `Ctrl Shift M` |
| Toggle Layout Mode | `Ctrl Shift G` |
| Previous Pane | `Ctrl Shift [` |
| Next Pane | `Ctrl Shift ]` |
| Navigate Up/Down/Left/Right | `Ctrl Alt Arrow` |
| Notifications | `Ctrl I` |
| Switch to Pane 1-9 | `Ctrl 1` - `Ctrl 9` |
| Close Panel / Overlay | `Escape` |

## Windows-Specific Notes

- **Shell detection** — Automatically prefers PowerShell 7 (`pwsh.exe`) > Windows PowerShell 5 (`powershell.exe`) > `cmd.exe`. Override with the `PS_SHELL` environment variable.
- **Shift+Enter** — Uses a Windows-native approach to bypass ConPTY limitations. Works with Claude Code and other modern CLI tools.
- **Background processes** — All polling commands (`netstat`, `git`, `gh`) run with hidden windows to prevent taskbar flashing.
- **Notifications** — Throttled to prevent rapid taskbar flash on Windows. 5-second cooldown between native desktop notifications.
- **File paths** — Full support for Windows paths (`C:\Users\...`) throughout the UI.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Tauri 2.x](https://v2.tauri.app/) |
| Backend | Rust (tokio, portable-pty, git2, keyring, winapi) |
| Frontend | Vanilla HTML/CSS/JS |
| Terminal | [xterm.js 6.0](https://xtermjs.org/) with WebGL addon |
| Shell | PowerShell (auto-detected) via Windows ConPTY |

## Architecture

```
PaneStreetWindows/
├── src/                    # Frontend (HTML/CSS/JS)
│   ├── index.html          # App shell
│   ├── css/main.css        # Styles + 16 theme definitions
│   └── js/
│       ├── app.js          # Core: layout engine, sessions, shortcuts
│       ├── config-panels.js # Settings, themes, plugins, MCPs, memory
│       ├── file-viewer.js  # File browser panel
│       └── terminal.js     # xterm.js session wrapper
├── src-tauri/              # Backend (Rust)
│   └── src/
│       ├── lib.rs          # Tauri command registry
│       ├── pty_manager.rs  # PTY spawning, I/O, resize, Shift+Enter
│       ├── cmd_util.rs     # Silent process spawning (no console flash)
│       ├── config_reader.rs # Claude config/plugin/MCP reader
│       ├── worktree_manager.rs # Git operations
│       ├── status_detector.rs  # Process status detection
│       ├── file_viewer.rs  # Directory & file reading
│       └── auth_manager.rs # Keyring-based API key storage
├── cli/                    # CLI tool (Unix only)
└── docs/                   # GitHub Pages site
```

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) — free to use, modify, and distribute. Attribution required (keep the copyright notice).

---

<p align="center">
  Built by <a href="https://github.com/ben4mn">ben4mn</a> · Windows port of <a href="https://github.com/ben4mn/PaneStreet">PaneStreet</a>
</p>
