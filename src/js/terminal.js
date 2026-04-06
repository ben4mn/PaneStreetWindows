import { Terminal } from '../vendor/xterm/xterm.mjs';
import { FitAddon } from '../vendor/xterm/addon-fit.mjs';
import { WebLinksAddon } from '../vendor/xterm/addon-web-links.mjs';
import { SearchAddon } from '../vendor/xterm/addon-search.mjs';

const { invoke, Channel } = window.__TAURI__.core;

const _isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const _mod = (e) => _isMac ? e.metaKey : e.ctrlKey;

// Shared encoder/decoder — avoid creating new instances per keystroke
const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

const DEFAULT_TERMINAL_THEME = {
  background: '#111111',
  foreground: '#cccccc',
  cursor: '#cccccc',
  selectionBackground: '#2a6df044',
  black: '#1a1a1a',
  red: '#ef4444',
  green: '#4ade80',
  yellow: '#f59e0b',
  blue: '#2a6df0',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#cccccc',
  brightBlack: '#555555',
  brightRed: '#f87171',
  brightGreen: '#86efac',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#ffffff',
};

function getSavedTerminalTheme() {
  try {
    const saved = localStorage.getItem('ps-theme');
    if (saved) {
      const data = JSON.parse(saved);
      if (data.terminal) return { ...DEFAULT_TERMINAL_THEME, ...data.terminal };
    }
  } catch {}
  return DEFAULT_TERMINAL_THEME;
}

export class TerminalSession {
  constructor(container) {
    this.container = container;
    this.sessionId = null;
    this.onOutputCallback = null;
    this._outputBuffer = '';

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: parseInt(localStorage.getItem('ps-font-size') || '14'),
      fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", "Menlo", monospace',
      lineHeight: 1.1,
      theme: getSavedTerminalTheme(),
      minimumContrastRatio: 4.5,
      windowsPty: { backend: 'conpty' },
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    // Ctrl+Click (Cmd+Click on Mac) to open links — matches VS Code behavior
    this.term.loadAddon(new WebLinksAddon((e, uri) => {
      if (_mod(e)) {
        window.open(uri, '_blank');
      }
    }));

    // Search addon for find-in-terminal
    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);

    // Intercept Shift+Enter BEFORE xterm processes it.
    // Uses platform-specific encoding via send_shift_enter command:
    // - Unix: Kitty CSI u sequence (\x1b[13;2u)
    // - Windows: win32-input-mode sequence that ConPTY natively understands
    const self = this;
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !_mod(e) && !e.altKey) {
        if (self.sessionId) {
          invoke('send_shift_enter', { sessionId: self.sessionId })
            .catch(() => {});
        }
        return false;
      }
      // Mod+C: copy if there's a selection, otherwise send SIGINT as normal
      if (e.type === 'keydown' && e.key === 'c' && _mod(e) && !e.shiftKey && !e.altKey) {
        const sel = self.term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel);
          self.term.clearSelection();
          return false;
        }
      }
      // Mod+Shift+C: always copy (works even in apps that capture Ctrl+C)
      if (e.type === 'keydown' && e.key === 'C' && _mod(e) && e.shiftKey && !e.altKey) {
        const sel = self.term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel);
          self.term.clearSelection();
        }
        return false;
      }
      // Mod+V: paste from clipboard
      if (e.type === 'keydown' && e.key === 'v' && _mod(e) && !e.shiftKey && !e.altKey) {
        navigator.clipboard.readText().then(text => {
          if (text && self.sessionId) {
            invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode(text)) });
          }
        });
        return false;
      }
      // Mod+Shift+V: always paste
      if (e.type === 'keydown' && e.key === 'V' && _mod(e) && e.shiftKey && !e.altKey) {
        navigator.clipboard.readText().then(text => {
          if (text && self.sessionId) {
            invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode(text)) });
          }
        });
        return false;
      }
      // Mod+Shift+F: find in terminal
      if (e.type === 'keydown' && e.key === 'F' && _mod(e) && e.shiftKey && !e.altKey) {
        self.toggleSearchBar();
        return false;
      }
      // Escape: close search bar if open
      if (e.type === 'keydown' && e.key === 'Escape' && self._searchBarVisible) {
        self.hideSearchBar();
        return false;
      }
      // Scroll shortcuts
      if (e.type === 'keydown' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === 'PageUp') { self.term.scrollPages(-1); return false; }
        if (e.key === 'PageDown') { self.term.scrollPages(1); return false; }
      }
      if (e.type === 'keydown' && _mod(e) && !e.shiftKey && !e.altKey) {
        if (e.key === 'Home') { self.term.scrollToTop(); return false; }
        if (e.key === 'End') { self.term.scrollToBottom(); return false; }
      }
      // Ctrl+Left/Right: move by word (use readline ESC b/f — universally supported)
      if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && self.sessionId) {
        if (e.key === 'ArrowLeft') {
          invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode('\x1bb')) });
          return false;
        }
        if (e.key === 'ArrowRight') {
          invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode('\x1bf')) });
          return false;
        }
        // Ctrl+Backspace: delete word behind cursor
        if (e.key === 'Backspace') {
          invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode('\x17')) });
          return false;
        }
        // Ctrl+Delete: delete word ahead of cursor
        if (e.key === 'Delete') {
          invoke('write_to_pty', { sessionId: self.sessionId, data: Array.from(_encoder.encode('\x1bd')) });
          return false;
        }
      }
      return true;
    });

    // Kitty keyboard protocol support — Claude Code queries this on startup
    // to decide whether Shift+Enter (and other modified keys) are supported.
    // Start with flags=1 to signal progressive enhancement support from the start.
    this._kittyKeyboardFlags = 1;
    this._kittyKeyboardStack = [];

    // Query: CSI ? u — respond with current flags so Claude Code knows we support it
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, (params) => {
      if (this.sessionId) {
        const encoder = new TextEncoder();
        invoke('write_to_pty', {
          sessionId: this.sessionId,
          data: Array.from(encoder.encode(`\x1b[?${this._kittyKeyboardFlags}u`)),
        });
      }
      return true;
    });

    // Enable/push: CSI > flags u — application requests enhanced keyboard mode
    this.term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      this._kittyKeyboardStack.push(this._kittyKeyboardFlags);
      this._kittyKeyboardFlags = params.length ? params[0] : 0;
      return true;
    });

    // Disable/pop: CSI < u — application reverts keyboard mode
    this.term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      const count = (params.length && params[0]) ? params[0] : 1;
      for (let i = 0; i < count && this._kittyKeyboardStack.length; i++) {
        this._kittyKeyboardFlags = this._kittyKeyboardStack.pop();
      }
      if (!this._kittyKeyboardStack.length) this._kittyKeyboardFlags = 0;
      return true;
    });

    // Note: Shift+Enter is handled by the capture-phase document keydown handler
    // in app.js, which fires before xterm sees the event. This ensures the CSI u
    // sequence reaches the PTY without xterm's default \r handling interfering.

    // Register OSC handlers for terminal notifications (OSC 9, 99, 777)
    // OSC 9: iTerm2-style growl notification
    this.term.parser.registerOscHandler(9, (data) => {
      window.dispatchEvent(new CustomEvent('terminal-notification', {
        detail: { title: 'Terminal', body: data, sessionId: this.sessionId }
      }));
      return true;
    });
    // OSC 99: kitty notification protocol
    this.term.parser.registerOscHandler(99, (data) => {
      // kitty format: key=value;key=value pairs, 'body' or 'p' for payload
      let body = data;
      const parts = data.split(';');
      for (const part of parts) {
        const [key, ...rest] = part.split('=');
        if (key === 'body' || key === 'p' || key === 'd') {
          body = rest.join('=');
          break;
        }
      }
      window.dispatchEvent(new CustomEvent('terminal-notification', {
        detail: { title: 'Terminal', body, sessionId: this.sessionId }
      }));
      return true;
    });
    // OSC 777: rxvt-unicode notification
    this.term.parser.registerOscHandler(777, (data) => {
      // Format: notify;title;body
      const parts = data.split(';');
      const title = parts[1] || 'Terminal';
      const body = parts.slice(2).join(';') || parts[1] || data;
      window.dispatchEvent(new CustomEvent('terminal-notification', {
        detail: { title, body, sessionId: this.sessionId }
      }));
      return true;
    });

    // Observe container resize with debounce to avoid layout thrashing
    this._fitTimer = null;
    this.resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._fitTimer);
      this._fitTimer = setTimeout(() => this.fit(), 30);
    });
  }

  open() {
    this.term.open(this.container);
    this.resizeObserver.observe(this.container);
    this._setupContextMenu();
    // Fit after layout has settled
    requestAnimationFrame(() => this.fit());

    // Backup: capture Shift+Enter at container DOM level too
    this.container.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (this.sessionId) {
          e.preventDefault();
          e.stopPropagation();
          invoke('send_shift_enter', { sessionId: this.sessionId }).catch(() => {});
        }
      }
    }, true);
  }

  fit() {
    try {
      this.fitAddon.fit();
    } catch (_) {}
  }

  updateTheme(themeColors) {
    this.term.options.theme = { ...this.term.options.theme, ...themeColors };
  }

  applySettings(settings) {
    if (settings.fontSize !== undefined) {
      this.term.options.fontSize = settings.fontSize;
    }
    this.fit();
  }

  onOutput(callback) {
    this.onOutputCallback = callback;
  }

  async connect(cwd, sessionId = null) {
    const channel = new Channel();
    channel.onmessage = (msg) => {
      const bytes = new Uint8Array(msg.data);
      // Write to terminal first — this is the latency-critical path
      this.term.write(bytes);

      // Defer output scanning to avoid blocking the render
      if (this.onOutputCallback) {
        const self = this;
        requestAnimationFrame(() => {
          try {
            const text = _decoder.decode(bytes, { stream: true });
            self._outputBuffer += text;
            if (self._outputBuffer.length > 2000) {
              self._outputBuffer = self._outputBuffer.slice(-1000);
            }
            self.onOutputCallback(text, self._outputBuffer);
          } catch {}
        });
      }
    };

    this.sessionId = await invoke('spawn_pty', {
      rows: this.term.rows,
      cols: this.term.cols,
      cwd: cwd || null,
      sessionId: sessionId || null,
      shell: localStorage.getItem('ps-shell') || null,
      onData: channel,
    });

    // Batch rapid keystrokes into a single IPC call using microtask coalescing.
    // This reduces IPC overhead when typing fast (e.g. holding a key down).
    let inputQueue = [];
    let inputFlushScheduled = false;
    const sid = this.sessionId;

    const flushInput = () => {
      inputFlushScheduled = false;
      if (inputQueue.length === 0) return;
      const combined = inputQueue.join('');
      inputQueue.length = 0;
      const bytes = _encoder.encode(combined);
      invoke('write_to_pty', { sessionId: sid, data: Array.from(bytes) });
    };

    this.term.onData((data) => {
      inputQueue.push(data);
      if (!inputFlushScheduled) {
        inputFlushScheduled = true;
        // queueMicrotask fires after current event but before next frame —
        // batches all keystrokes from a single event loop tick
        queueMicrotask(flushInput);
      }
    });

    this.term.onResize(({ rows, cols }) => {
      invoke('resize_pty', {
        sessionId: this.sessionId,
        rows,
        cols,
      });
    });

    // On Windows, the WebGL renderer and ConPTY sometimes need a
    // re-fit after initial connection to render correctly.
    setTimeout(() => this.fit(), 150);

    return this.sessionId;
  }

  focus() {
    this.term.focus();
    // Force full redraw to clear stale TUI artifacts (e.g. after clicking
    // away from a full-screen app like `claude -r` and clicking back).
    this.term.refresh(0, this.term.rows - 1);
  }

  /**
   * Serialize the terminal scrollback buffer (last N lines) as plain text.
   * Used for session persistence across restarts.
   */
  getScrollback(maxLines = 1000) {
    const buffer = this.term.buffer.active;
    const totalLines = buffer.length;
    const startLine = Math.max(0, totalLines - maxLines);
    const lines = [];
    for (let i = startLine; i < totalLines; i++) {
      const line = buffer.getLine(i);
      if (line) {
        const text = line.translateToString(true);
        // Skip trailing empty lines
        lines.push(text);
      }
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /**
   * Write saved scrollback content into the terminal before connecting PTY.
   */
  restoreScrollback(content) {
    if (!content) return;
    // Write the content with newlines so it appears as previous output
    this.term.write(content.replace(/\n/g, '\r\n') + '\r\n');
  }

  // --- Search bar (find in terminal) ---
  _searchBarVisible = false;
  _searchBar = null;

  toggleSearchBar() {
    if (this._searchBarVisible) {
      this.hideSearchBar();
    } else {
      this.showSearchBar();
    }
  }

  showSearchBar() {
    if (this._searchBar) {
      this._searchBarVisible = true;
      this._searchBar.style.display = 'flex';
      this._searchBar.querySelector('input').focus();
      return;
    }

    const bar = document.createElement('div');
    bar.className = 'terminal-search-bar';
    bar.innerHTML = `
      <input type="text" placeholder="Find..." spellcheck="false" />
      <span class="search-count"></span>
      <button class="search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
      <button class="search-next" title="Next (Enter)">&#x25BC;</button>
      <button class="search-close" title="Close (Escape)">&times;</button>
    `;

    const input = bar.querySelector('input');
    const countEl = bar.querySelector('.search-count');
    const prevBtn = bar.querySelector('.search-prev');
    const nextBtn = bar.querySelector('.search-next');
    const closeBtn = bar.querySelector('.search-close');

    const updateCount = () => {
      // SearchAddon fires onDidChangeResults if available
    };

    let resultListener = null;
    if (this.searchAddon.onDidChangeResults) {
      resultListener = this.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        countEl.textContent = resultCount > 0 ? `${resultIndex + 1}/${resultCount}` : 'No results';
      });
    }

    const doSearch = (direction) => {
      const query = input.value;
      if (!query) {
        this.searchAddon.clearDecorations();
        countEl.textContent = '';
        return;
      }
      if (direction === 'prev') {
        this.searchAddon.findPrevious(query, { incremental: true });
      } else {
        this.searchAddon.findNext(query, { incremental: true });
      }
    };

    input.addEventListener('input', () => doSearch('next'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); doSearch('prev'); }
      else if (e.key === 'Enter') { e.preventDefault(); doSearch('next'); }
      else if (e.key === 'Escape') { e.preventDefault(); this.hideSearchBar(); }
      e.stopPropagation();
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    prevBtn.addEventListener('click', () => doSearch('prev'));
    nextBtn.addEventListener('click', () => doSearch('next'));
    closeBtn.addEventListener('click', () => this.hideSearchBar());

    // Stop clicks in the search bar from propagating to pane focus handlers
    bar.addEventListener('mousedown', (e) => e.stopPropagation());

    this._searchBar = bar;
    this._searchBarResultListener = resultListener;
    this._searchBarVisible = true;
    this.container.style.position = 'relative';
    this.container.appendChild(bar);
    input.focus();
  }

  hideSearchBar() {
    if (!this._searchBar) return;
    this._searchBarVisible = false;
    this._searchBar.style.display = 'none';
    this.searchAddon.clearDecorations();
    this.term.focus();
  }

  // --- Right-click context menu ---
  _setupContextMenu() {
    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // Remove any existing menu
      document.querySelectorAll('.terminal-context-menu').forEach(m => m.remove());

      const menu = document.createElement('div');
      menu.className = 'terminal-context-menu';

      const mod = _isMac ? '\u2318' : 'Ctrl+';
      const items = [
        { label: 'Copy', shortcut: `${mod}C`, action: () => {
          const sel = this.term.getSelection();
          if (sel) navigator.clipboard.writeText(sel);
        }, disabled: !this.term.getSelection() },
        { label: 'Paste', shortcut: `${mod}V`, action: () => {
          navigator.clipboard.readText().then(text => {
            if (text && this.sessionId) invoke('write_to_pty', { sessionId: this.sessionId, data: Array.from(_encoder.encode(text)) });
          });
        }},
        { label: 'Select All', action: () => this.term.selectAll() },
        { type: 'separator' },
        { label: 'Find...', shortcut: `${mod}Shift+F`, action: () => this.showSearchBar() },
        { label: 'Clear', action: () => this.term.clear() },
      ];

      for (const item of items) {
        if (item.type === 'separator') {
          const sep = document.createElement('div');
          sep.className = 'ctx-separator';
          menu.appendChild(sep);
          continue;
        }
        const row = document.createElement('div');
        row.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
        row.innerHTML = `<span>${item.label}</span>${item.shortcut ? `<span class="ctx-shortcut">${item.shortcut}</span>` : ''}`;
        if (!item.disabled) {
          row.addEventListener('click', () => { menu.remove(); item.action(); });
        }
        menu.appendChild(row);
      }

      // Position near cursor, but keep on screen
      menu.style.left = `${e.offsetX}px`;
      menu.style.top = `${e.offsetY}px`;
      this.container.appendChild(menu);

      // Close on any click outside
      const closeMenu = (ev) => {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', closeMenu, true); }
      };
      setTimeout(() => document.addEventListener('mousedown', closeMenu, true), 0);
    });
  }

  async destroy() {
    this.resizeObserver.disconnect();
    if (this.sessionId) {
      await invoke('kill_pty', { sessionId: this.sessionId });
    }
    this.term.dispose();
  }
}
