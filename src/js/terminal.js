import { Terminal } from '../vendor/xterm/xterm.mjs';
import { FitAddon } from '../vendor/xterm/addon-fit.mjs';
import { WebLinksAddon } from '../vendor/xterm/addon-web-links.mjs';

const { invoke, Channel } = window.__TAURI__.core;

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
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(new WebLinksAddon());

    // Intercept Shift+Enter BEFORE xterm processes it.
    // Uses platform-specific encoding via send_shift_enter command:
    // - Unix: Kitty CSI u sequence (\x1b[13;2u)
    // - Windows: win32-input-mode sequence that ConPTY natively understands
    const self = this;
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (self.sessionId) {
          invoke('send_shift_enter', { sessionId: self.sessionId })
            .catch(() => {});
        }
        return false;
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

  async destroy() {
    this.resizeObserver.disconnect();
    if (this.sessionId) {
      await invoke('kill_pty', { sessionId: this.sessionId });
    }
    this.term.dispose();
  }
}
