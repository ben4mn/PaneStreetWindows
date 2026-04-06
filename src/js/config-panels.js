const { invoke } = window.__TAURI__.core;

const _isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
function _modActive(e) { return _isMac ? e.metaKey : e.ctrlKey; }

let activePanel = null;
let onHideCallback = null;
let settingsDirty = false;
let savedSettingsSnapshot = {};
let focusedSessionCwd = null;

export function setFocusedCwd(cwd) {
  const changed = cwd !== focusedSessionCwd;
  focusedSessionCwd = cwd;

  // Auto-refresh memory panel if it's open and the project changed
  if (changed && cwd && activePanel === 'memory') {
    renderMemoryPanel();
  }
}

// --- Panel Switching ---

export function setOnHide(callback) {
  onHideCallback = callback;
}

export function showPanel(panelName) {
  // Check for unsaved settings when switching away
  if (settingsDirty && activePanel === 'settings' && panelName !== 'settings') {
    showUnsavedDialog(
      () => {
        document.getElementById('general-save')?.click();
        settingsDirty = false;
        doShowPanel(panelName);
      },
      () => {
        settingsDirty = false;
        doShowPanel(panelName);
      }
    );
    return;
  }
  doShowPanel(panelName);
}

function doShowPanel(panelName) {
  document.getElementById('pane-grid').style.display = 'none';
  document.getElementById('file-viewer').style.display = 'none';
  document.querySelectorAll('.config-panel').forEach(p => p.style.display = 'none');

  const panel = document.getElementById(`${panelName}-panel`);
  if (panel) panel.style.display = '';

  // Highlight active button
  document.querySelectorAll('#sidebar-actions button').forEach(b => b.classList.remove('panel-active'));
  const btnMap = { settings: 'settings-btn', plugins: 'config-plugins-btn', mcps: 'config-mcps-btn', memory: 'config-memory-btn', scheduled: 'config-scheduled-btn' };
  document.getElementById(btnMap[panelName])?.classList.add('panel-active');

  activePanel = panelName;

  // Render panel content
  if (panelName === 'settings') renderSettingsPanel();
  else if (panelName === 'plugins') renderPluginsPanel();
  else if (panelName === 'mcps') renderMcpsPanel();
  else if (panelName === 'memory') renderMemoryPanel();
  else if (panelName === 'scheduled') renderScheduledPanel();
}

export function hidePanel() {
  if (settingsDirty && activePanel === 'settings') {
    showUnsavedDialog(
      () => {
        document.getElementById('general-save')?.click();
        settingsDirty = false;
        doHidePanel();
      },
      () => {
        settingsDirty = false;
        doHidePanel();
      }
    );
    return;
  }
  doHidePanel();
}

function doHidePanel() {
  document.querySelectorAll('.config-panel').forEach(p => p.style.display = 'none');
  document.getElementById('pane-grid').style.display = '';
  if (document.getElementById('fv-toggle-btn')?.classList.contains('active')) {
    document.getElementById('file-viewer').style.display = 'flex';
  }
  document.querySelectorAll('#sidebar-actions button').forEach(b => b.classList.remove('panel-active'));
  activePanel = null;
  if (onHideCallback) onHideCallback();
}

export function togglePanel(panelName) {
  if (activePanel === panelName) hidePanel();
  else showPanel(panelName);
}

export function isAnyPanelActive() {
  return activePanel !== null;
}

// --- Unsaved Settings Dialog ---

function captureSettingsSnapshot() {
  return {
    fontSize: localStorage.getItem('ps-font-size') || '14',
    shell: localStorage.getItem('ps-shell') || '',
    defaultDir: localStorage.getItem('ps-default-dir') || '',
    gitShowBranch: localStorage.getItem('ps-git-show-branch') ?? 'true',
    gitShowWorktree: localStorage.getItem('ps-git-show-worktree') ?? 'true',
    gitShowDirty: localStorage.getItem('ps-git-show-dirty') ?? 'true',
    gitPoll: localStorage.getItem('ps-git-poll') || '5',
    notifications: localStorage.getItem('ps-notifications') ?? 'true',
    notifyWaiting: localStorage.getItem('ps-notify-waiting') ?? 'true',
    notifyPermission: localStorage.getItem('ps-notify-permission') ?? 'true',
    notifyExited: localStorage.getItem('ps-notify-exited') ?? 'true',
    notifySound: localStorage.getItem('ps-notify-sound') ?? 'true',
    robotEnabled: localStorage.getItem('ps-robot-enabled') ?? 'true',
    robotFrequency: localStorage.getItem('ps-robot-frequency') || 'medium',
  };
}

function checkSettingsDirty() {
  const container = document.getElementById('settings-tab-content');
  if (!container || currentSettingsTab !== 'general') return false;
  const current = {
    fontSize: container.querySelector('#pref-font-size')?.value,
    shell: container.querySelector('#pref-shell')?.value || '',
    defaultDir: container.querySelector('#pref-default-dir')?.value || '',
    gitShowBranch: String(container.querySelector('#pref-git-branch')?.checked ?? true),
    gitShowWorktree: String(container.querySelector('#pref-git-worktree')?.checked ?? true),
    gitShowDirty: String(container.querySelector('#pref-git-dirty')?.checked ?? true),
    gitPoll: container.querySelector('#pref-git-poll')?.value || '5',
    notifications: String(container.querySelector('#pref-notifications')?.checked ?? true),
    notifyWaiting: String(container.querySelector('#pref-notify-waiting')?.checked ?? true),
    notifyPermission: String(container.querySelector('#pref-notify-permission')?.checked ?? true),
    notifyExited: String(container.querySelector('#pref-notify-exited')?.checked ?? true),
    notifySound: String(container.querySelector('#pref-notify-sound')?.checked ?? true),
    robotEnabled: String(container.querySelector('#pref-robot')?.checked ?? true),
    robotFrequency: container.querySelector('#pref-robot-frequency')?.value || 'medium',
  };
  return JSON.stringify(current) !== JSON.stringify(savedSettingsSnapshot);
}

function attachDirtyListeners(container) {
  const fields = container.querySelectorAll('input, select');
  fields.forEach(field => {
    field.addEventListener('input', () => { settingsDirty = checkSettingsDirty(); });
    field.addEventListener('change', () => { settingsDirty = checkSettingsDirty(); });
  });
}

function showUnsavedDialog(onSave, onDiscard) {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.innerHTML = `
    <div class="dialog-box">
      <div class="dialog-title">Unsaved Changes</div>
      <div class="dialog-message">You have unsaved settings changes.</div>
      <div class="dialog-actions">
        <button class="dialog-btn dialog-btn-cancel">Cancel</button>
        <button class="dialog-btn dialog-btn-discard">Discard</button>
        <button class="dialog-btn dialog-btn-save">Save & Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.dialog-btn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('.dialog-btn-discard').onclick = () => { overlay.remove(); onDiscard(); };
  overlay.querySelector('.dialog-btn-save').onclick = () => { overlay.remove(); onSave(); };
}

// --- Settings Panel ---

let currentSettingsTab = 'general';

async function renderSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  panel.innerHTML = `
    <div class="config-panel-header">
      <button class="config-back-btn" id="settings-back">\u2190 Back</button>
      <h1>Settings</h1>
    </div>
    <div class="settings-tabs">
      <button class="settings-tab ${currentSettingsTab === 'general' ? 'active' : ''}" data-tab="general">General</button>
      <button class="settings-tab ${currentSettingsTab === 'keys' ? 'active' : ''}" data-tab="keys">Keys</button>
      <button class="settings-tab ${currentSettingsTab === 'theme' ? 'active' : ''}" data-tab="theme">Theme</button>
      <button class="settings-tab ${currentSettingsTab === 'auth' ? 'active' : ''}" data-tab="auth">Auth</button>
      <button class="settings-tab ${currentSettingsTab === 'about' ? 'active' : ''}" data-tab="about">About</button>
    </div>
    <div id="settings-tab-content"></div>
  `;

  panel.querySelector('#settings-back').onclick = hidePanel;

  panel.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
      if (settingsDirty && currentSettingsTab === 'general') {
        showUnsavedDialog(
          () => {
            document.getElementById('general-save')?.click();
            settingsDirty = false;
            switchToTab(tab.dataset.tab, panel);
          },
          () => {
            settingsDirty = false;
            switchToTab(tab.dataset.tab, panel);
          }
        );
        return;
      }
      switchToTab(tab.dataset.tab, panel);
    };
  });

  renderSettingsTab(currentSettingsTab);
}

function switchToTab(tabName, panel) {
  currentSettingsTab = tabName;
  panel.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  panel.querySelector(`.settings-tab[data-tab="${tabName}"]`)?.classList.add('active');
  renderSettingsTab(tabName);
}

async function renderSettingsTab(tab) {
  const container = document.getElementById('settings-tab-content');
  if (!container) return;

  if (tab === 'general') {
    const fontSize = localStorage.getItem('ps-font-size') || '14';
    const shell = localStorage.getItem('ps-shell') || '';
    const defaultDir = localStorage.getItem('ps-default-dir') || '';
    const gitShowBranch = localStorage.getItem('ps-git-show-branch') !== 'false';
    const gitShowWorktree = localStorage.getItem('ps-git-show-worktree') !== 'false';
    const gitShowDirty = localStorage.getItem('ps-git-show-dirty') !== 'false';
    const gitPollInterval = localStorage.getItem('ps-git-poll') || '5';
    const notificationsEnabled = localStorage.getItem('ps-notifications') !== 'false';
    const notifyOnWaiting = localStorage.getItem('ps-notify-waiting') !== 'false';
    const notifyOnPermission = localStorage.getItem('ps-notify-permission') !== 'false';
    const notifyOnExited = localStorage.getItem('ps-notify-exited') !== 'false';
    const notifyOnCompleted = localStorage.getItem('ps-notify-completed') === 'true';
    const notifyOnError = localStorage.getItem('ps-notify-error') !== 'false';
    const notifyOnClaudeFinished = localStorage.getItem('ps-notify-claude-finished') !== 'false';
    const notifySound = localStorage.getItem('ps-notify-sound') !== 'false';
    const robotEnabled = localStorage.getItem('ps-robot-enabled') !== 'false';
    const robotFrequency = localStorage.getItem('ps-robot-frequency') || 'medium';

    container.innerHTML = `
      <div class="settings-group">
        <div class="setting-row-stacked">
          <div class="setting-label">Terminal Font Size</div>
          <div class="setting-description">Size in pixels for terminal text</div>
          <div class="setting-control">
            <input type="range" id="pref-font-size" min="10" max="24" value="${fontSize}" class="setting-range" />
            <input type="number" id="font-size-input" min="10" max="24" value="${fontSize}" class="font-size-number" />
            <span class="setting-range-value">px</span>
          </div>
          <div class="font-preview" id="font-preview" style="font-size:${fontSize}px">
            The quick brown fox jumps over the lazy dog<br>
            $ claude --help &nbsp; 0123456789
          </div>
        </div>

        <div class="setting-row-stacked">
          <div class="setting-label">Default Shell</div>
          <div class="setting-description">Select a shell for new terminals</div>
          <select class="form-input setting-input-full" id="pref-shell">
            <option value="">System Default</option>
          </select>
        </div>

        <div class="setting-row-stacked">
          <div class="setting-label">Default Directory</div>
          <div class="setting-description">New terminals open here. Leave empty for home directory.</div>
          <div class="setting-browse-row">
            <input type="text" class="form-input" id="pref-default-dir" value="${defaultDir}" placeholder="~/Projects" style="flex:1" />
            <button class="setting-browse-btn" id="browse-dir">Browse</button>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="setting-section-title">Git Display</div>

        <div class="setting-row-stacked">
          <div class="setting-row-inline">
            <div>
              <div class="setting-label">Show branch name</div>
              <div class="setting-description">Display current git branch in the footer</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-git-branch" ${gitShowBranch ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row-stacked">
          <div class="setting-row-inline">
            <div>
              <div class="setting-label">Show worktree info</div>
              <div class="setting-description">Show active worktree count when in a git repo</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-git-worktree" ${gitShowWorktree ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row-stacked">
          <div class="setting-row-inline">
            <div>
              <div class="setting-label">Show dirty indicator</div>
              <div class="setting-description">Show * next to branch name when there are uncommitted changes</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-git-dirty" ${gitShowDirty ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row-stacked">
          <div class="setting-label">Poll interval</div>
          <div class="setting-description">How often to refresh git info (seconds)</div>
          <div class="setting-control">
            <input type="range" id="pref-git-poll" min="2" max="30" value="${gitPollInterval}" class="setting-range" />
            <span class="setting-range-value" id="git-poll-value">${gitPollInterval}s</span>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="setting-section-title">Notifications</div>

        <div class="setting-row-stacked">
          <div class="setting-row-inline">
            <div>
              <div class="setting-label">Enable notifications</div>
              <div class="setting-description">Show desktop notifications when the app is in the background</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notifications" ${notificationsEnabled ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>
        </div>

        <div class="setting-row-stacked notify-sub-settings" ${notificationsEnabled ? '' : 'style="opacity:0.4;pointer-events:none"'}>
          <div class="setting-description" style="margin-bottom:8px;font-weight:500;color:var(--text-primary)">Notify me when...</div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Session is waiting for input</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-waiting" ${notifyOnWaiting ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Session needs permission</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-permission" ${notifyOnPermission ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Session finishes / exits</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-exited" ${notifyOnExited ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Command completed (Working → Idle)</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-completed" ${notifyOnCompleted ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Terminal error detected</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-error" ${notifyOnError ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding:4px 0">
            <div class="setting-label">Claude task completed</div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-notify-claude-finished" ${notifyOnClaudeFinished ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:10px">
            <div class="setting-row-inline">
              <div>
                <div class="setting-label">Sound</div>
                <div class="setting-description">Play the system notification sound</div>
              </div>
              <label class="setting-switch">
                <input type="checkbox" id="pref-notify-sound" ${notifySound ? 'checked' : ''} />
                <span class="setting-switch-slider"></span>
              </label>
            </div>
          </div>

          <div style="margin-top:12px">
            <button class="setting-browse-btn" id="notify-test-btn" style="width:auto;padding:6px 16px">
              Send test notification
            </button>
            <span class="notify-test-msg" id="notify-test-msg" style="margin-left:8px;font-size:var(--font-size-xs);color:var(--text-muted)"></span>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <div class="setting-section-title">Mascot</div>
        <div class="setting-row-stacked">
          <div class="setting-row-inline">
            <div>
              <div class="setting-label">Show robot mascot</div>
              <div class="setting-description">Toggle the animated robot companion that walks across your screen</div>
            </div>
            <label class="setting-switch">
              <input type="checkbox" id="pref-robot" ${robotEnabled ? 'checked' : ''} />
              <span class="setting-switch-slider"></span>
            </label>
          </div>

          <div class="setting-row-inline" style="padding-top:8px">
            <div>
              <div class="setting-label">Animation frequency</div>
              <div class="setting-description">How often the mascot moves, animates, and reacts to your terminals</div>
            </div>
            <select id="pref-robot-frequency" class="form-input" style="width:auto;min-width:100px">
              <option value="low" ${robotFrequency === 'low' ? 'selected' : ''}>Low</option>
              <option value="medium" ${robotFrequency === 'medium' ? 'selected' : ''}>Medium</option>
              <option value="high" ${robotFrequency === 'high' ? 'selected' : ''}>High</option>
            </select>
          </div>
        </div>
      </div>

      <button class="settings-save-btn" id="general-save">Save &amp; Apply</button>
      <span class="settings-save-msg" id="general-msg"></span>
    `;

    // Font size range + number input with live preview
    const rangeEl = container.querySelector('#pref-font-size');
    const numberEl = container.querySelector('#font-size-input');
    const previewEl = container.querySelector('#font-preview');
    rangeEl.addEventListener('input', () => {
      numberEl.value = rangeEl.value;
      previewEl.style.fontSize = rangeEl.value + 'px';
    });
    numberEl.addEventListener('input', () => {
      const val = Math.min(24, Math.max(10, parseInt(numberEl.value) || 14));
      rangeEl.value = val;
      previewEl.style.fontSize = val + 'px';
    });

    // Populate shell dropdown
    const shellSelect = container.querySelector('#pref-shell');
    invoke('detect_shells').then(shells => {
      shells.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.path;
        opt.textContent = `${s.name} — ${s.path}`;
        if (s.path === shell) opt.selected = true;
        shellSelect.appendChild(opt);
      });
      // If saved shell doesn't match any detected option, add it as custom
      if (shell && !shells.some(s => s.path === shell)) {
        const opt = document.createElement('option');
        opt.value = shell;
        opt.textContent = `Custom — ${shell}`;
        opt.selected = true;
        shellSelect.appendChild(opt);
      }
    });

    // Git poll interval range
    const gitPollEl = container.querySelector('#pref-git-poll');
    const gitPollValueEl = container.querySelector('#git-poll-value');
    gitPollEl.addEventListener('input', () => {
      gitPollValueEl.textContent = gitPollEl.value + 's';
    });

    // Browse button for default directory
    container.querySelector('#browse-dir').onclick = async () => {
      try {
        const result = await invoke('plugin:dialog|open', {
          options: {
            directory: true,
            multiple: false,
            title: 'Choose Default Directory',
          },
        });
        if (result) {
          container.querySelector('#pref-default-dir').value = result;
        }
      } catch (err) {
        console.warn('Folder picker failed:', err);
      }
    };

    // Save button
    container.querySelector('#general-save').onclick = () => {
      localStorage.setItem('ps-font-size', rangeEl.value);
      localStorage.setItem('ps-shell', container.querySelector('#pref-shell').value);
      localStorage.setItem('ps-default-dir', container.querySelector('#pref-default-dir').value);
      localStorage.setItem('ps-git-show-branch', container.querySelector('#pref-git-branch').checked);
      localStorage.setItem('ps-git-show-worktree', container.querySelector('#pref-git-worktree').checked);
      localStorage.setItem('ps-git-show-dirty', container.querySelector('#pref-git-dirty').checked);
      localStorage.setItem('ps-git-poll', gitPollEl.value);
      localStorage.setItem('ps-notifications', container.querySelector('#pref-notifications').checked);
      localStorage.setItem('ps-notify-waiting', container.querySelector('#pref-notify-waiting').checked);
      localStorage.setItem('ps-notify-permission', container.querySelector('#pref-notify-permission').checked);
      localStorage.setItem('ps-notify-exited', container.querySelector('#pref-notify-exited').checked);
      localStorage.setItem('ps-notify-completed', container.querySelector('#pref-notify-completed').checked);
      localStorage.setItem('ps-notify-error', container.querySelector('#pref-notify-error').checked);
      localStorage.setItem('ps-notify-claude-finished', container.querySelector('#pref-notify-claude-finished').checked);
      localStorage.setItem('ps-notify-sound', container.querySelector('#pref-notify-sound').checked);
      const robotChecked = container.querySelector('#pref-robot').checked;
      localStorage.setItem('ps-robot-enabled', robotChecked);
      localStorage.setItem('ps-robot-frequency', container.querySelector('#pref-robot-frequency').value);
      window.dispatchEvent(new CustomEvent('robot-toggle', { detail: robotChecked }));
      window.dispatchEvent(new CustomEvent('settings-changed', {
        detail: { fontSize: parseInt(rangeEl.value) }
      }));
      settingsDirty = false;
      savedSettingsSnapshot = captureSettingsSnapshot();
      const msg = container.querySelector('#general-msg');
      msg.textContent = 'Saved! Settings applied.';
      msg.style.color = 'var(--status-idle)';
      setTimeout(() => { msg.textContent = ''; }, 3000);
    };

    // Notifications master toggle enables/disables sub-settings
    const notifToggle = container.querySelector('#pref-notifications');
    const notifSub = container.querySelector('.notify-sub-settings');
    notifToggle.addEventListener('change', () => {
      notifSub.style.opacity = notifToggle.checked ? '' : '0.4';
      notifSub.style.pointerEvents = notifToggle.checked ? '' : 'none';
    });

    // Test notification button
    container.querySelector('#notify-test-btn').addEventListener('click', async () => {
      const msgEl = container.querySelector('#notify-test-msg');
      try {
        const permCheck = await invoke('plugin:notification|is_permission_granted');
        console.log('[notify-test] is_permission_granted:', permCheck);

        let granted = permCheck;
        if (!granted) {
          const result = await invoke('plugin:notification|request_permission');
          console.log('[notify-test] request_permission result:', result);
          granted = result === 'granted' || result === true;
        }

        console.log('[notify-test] granted:', granted, '— sending...');

        const result = await invoke('plugin:notification|notify', {
          options: { title: 'PaneStreet', body: 'This is a test notification. Looking good!' },
        });
        console.log('[notify-test] notify result:', result);

        msgEl.textContent = `Sent! Check Notification Center (banners only show when app is unfocused).`;
        msgEl.style.color = 'var(--status-idle)';
      } catch (err) {
        console.error('[notify-test] error:', err);
        msgEl.textContent = 'Failed: ' + err;
        msgEl.style.color = 'var(--status-exited)';
      }
      setTimeout(() => { msgEl.textContent = ''; }, 8000);
    });

    // Track dirty state
    savedSettingsSnapshot = captureSettingsSnapshot();
    settingsDirty = false;
    attachDirtyListeners(container);

  } else if (tab === 'auth') {
    container.innerHTML = '<div class="empty-state">Loading...</div>';

    try {
      const status = await invoke('get_auth_status');

      if (status.has_key) {
        container.innerHTML = `
          <div class="auth-status">
            <span class="status-dot" style="background:var(--status-idle)"></span>
            <span class="setting-label">API key configured</span>
          </div>
          <div class="setting-description" style="margin-bottom:12px">Key: ${status.key_hint}</div>
          <div class="api-key-row">
            <input type="password" class="form-input" id="auth-new-key" placeholder="Replace with new key..." />
            <button class="save-btn" id="auth-save">Save</button>
            <button class="delete-btn" id="auth-delete">Delete</button>
          </div>
          <div id="auth-message" style="margin-top:8px;font-size:var(--font-size-xs)"></div>
        `;
      } else {
        container.innerHTML = `
          <div class="auth-status">
            <span class="status-dot" style="background:var(--text-muted)"></span>
            <span class="setting-label">No API key configured</span>
          </div>
          <div class="setting-description" style="margin-bottom:12px">Enter your Anthropic API key to use with Claude sessions.</div>
          <div class="api-key-row">
            <input type="password" class="form-input" id="auth-new-key" placeholder="sk-ant-..." />
            <button class="save-btn" id="auth-save">Save</button>
          </div>
          <div id="auth-message" style="margin-top:8px;font-size:var(--font-size-xs)"></div>
        `;
      }

      container.querySelector('#auth-save').onclick = async () => {
        const key = container.querySelector('#auth-new-key').value.trim();
        const msg = container.querySelector('#auth-message');
        if (!key) { msg.textContent = 'Please enter a key.'; msg.style.color = 'var(--status-exited)'; return; }
        try {
          await invoke('save_api_key', { key });
          msg.textContent = 'Key saved to Keychain.';
          msg.style.color = 'var(--status-idle)';
          setTimeout(() => renderSettingsTab('auth'), 1000);
        } catch (err) {
          msg.textContent = `Error: ${err}`;
          msg.style.color = 'var(--status-exited)';
        }
      };

      const deleteBtn = container.querySelector('#auth-delete');
      if (deleteBtn) {
        deleteBtn.onclick = async () => {
          const msg = container.querySelector('#auth-message');
          try {
            await invoke('delete_api_key');
            msg.textContent = 'Key deleted.';
            msg.style.color = 'var(--status-idle)';
            setTimeout(() => renderSettingsTab('auth'), 1000);
          } catch (err) {
            msg.textContent = `Error: ${err}`;
            msg.style.color = 'var(--status-exited)';
          }
        };
      }

    } catch (err) {
      container.innerHTML = `<div class="empty-state">Failed to check auth status: ${err}</div>`;
    }

  } else if (tab === 'keys') {
    renderKeysTab(container);

  } else if (tab === 'theme') {
    renderThemeTab(container);

  } else if (tab === 'about') {
    let version = '0.1.0';
    try {
      const app = window.__TAURI__.app;
      if (app?.getVersion) version = await app.getVersion();
    } catch {}

    container.innerHTML = `
      <div class="settings-group">
        <div class="setting-row">
          <div class="setting-label">Version</div>
          <div class="setting-value">${version}</div>
        </div>
        <div class="setting-row">
          <div class="setting-label">Platform</div>
          <div class="setting-value">${navigator.platform.indexOf('Win') >= 0 ? 'Windows' : navigator.platform.indexOf('Mac') >= 0 ? 'macOS' : 'Linux'}</div>
        </div>
      </div>

      <div class="settings-group">
        <div class="setting-section-title">Updates</div>
        <div class="setting-row-stacked">
          <div id="update-status-msg" class="setting-description">Check if a newer version is available.</div>
          <div id="update-actions" style="margin-top:8px;display:flex;align-items:center;gap:12px">
            <button class="setting-browse-btn" id="check-update-btn" style="width:auto;padding:6px 16px">
              Check for Updates
            </button>
          </div>
          <div id="update-progress" style="display:none;margin-top:10px">
            <div style="background:var(--bg-pane);border-radius:4px;height:6px;overflow:hidden">
              <div id="update-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
            </div>
            <div id="update-progress-text" style="font-size:var(--font-size-xs);color:var(--text-muted);margin-top:4px"></div>
          </div>
        </div>
      </div>

      <div class="settings-group" style="margin-top:12px">
        <div class="setting-section-title">What's New</div>
        <div id="changelog-content" style="margin-top:8px">
          <div class="setting-description" style="color:var(--text-muted)">Loading release notes...</div>
        </div>
      </div>

      <div style="margin-top:12px">
        <div class="setting-description">Pane Street — Multi-session Claude Code terminal manager</div>
      </div>
    `;

    // Load changelog from GitHub releases
    (async () => {
      const el = container.querySelector('#changelog-content');
      if (!el) return;
      try {
        const res = await fetch('https://api.github.com/repos/ben4mn/PaneStreetWindows/releases?per_page=5');
        if (!res.ok) throw new Error('fetch failed');
        const releases = await res.json();
        if (!releases.length) { el.innerHTML = '<div class="setting-description" style="color:var(--text-muted)">No releases found.</div>'; return; }
        el.innerHTML = releases.map(r => {
          const date = new Date(r.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
          const safeTag = escapeForHtml(r.tag_name);
          const safeDate = escapeForHtml(date);
          const body = r.body ? formatChangelogBody(r.body) : '<span style="color:var(--text-muted)">No notes.</span>';
          return `
            <div class="changelog-entry">
              <div class="changelog-header">
                <span class="changelog-version">${safeTag}</span>
                <span class="changelog-date">${safeDate}</span>
              </div>
              <div class="changelog-body">${body}</div>
            </div>`;
        }).join('');
      } catch {
        el.innerHTML = '<div class="setting-description" style="color:var(--text-muted)">Could not load release notes.</div>';
      }
    })();

    container.querySelector('#check-update-btn').addEventListener('click', async () => {
      const msgEl = container.querySelector('#update-status-msg');
      const actionsEl = container.querySelector('#update-actions');
      const progressEl = container.querySelector('#update-progress');
      const progressBar = container.querySelector('#update-progress-bar');
      const progressText = container.querySelector('#update-progress-text');

      msgEl.textContent = 'Checking for updates...';
      msgEl.style.color = 'var(--text-muted)';

      try {
        // Try the native updater plugin first (requires signed releases)
        const update = await invoke('plugin:updater|check', {});

        if (update) {
          msgEl.textContent = 'New version ' + update.version + ' available!';
          msgEl.style.color = 'var(--status-waiting)';

          // Show release notes if available
          if (update.body) {
            msgEl.textContent += ' ' + update.body.split('\n')[0];
          }

          // Replace "Check" button with "Install Update" button
          actionsEl.innerHTML = `
            <button class="setting-browse-btn" id="install-update-btn" style="width:auto;padding:6px 16px;background:var(--accent);color:var(--accent-fg)">
              Install Update
            </button>
            <span style="font-size:var(--font-size-xs);color:var(--text-muted)">v${version} → v${update.version}</span>
          `;

          container.querySelector('#install-update-btn').addEventListener('click', async () => {
            const installBtn = container.querySelector('#install-update-btn');
            installBtn.disabled = true;
            installBtn.textContent = 'Downloading...';
            progressEl.style.display = '';

            let totalBytes = 0;
            let downloadedBytes = 0;

            try {
              await window.__panestreet.downloadAndInstallUpdate(update, {
                onProgress: (chunkLen, contentLen) => {
                  if (contentLen > 0) totalBytes = contentLen;
                  downloadedBytes += chunkLen;
                  if (totalBytes > 0) {
                    const pct = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
                    progressBar.style.width = pct + '%';
                    progressText.textContent = pct + '% (' + Math.round(downloadedBytes / 1024) + ' KB)';
                  } else {
                    progressText.textContent = Math.round(downloadedBytes / 1024) + ' KB downloaded';
                  }
                },
                onFinished: () => {
                  progressBar.style.width = '100%';
                  progressText.textContent = 'Installing...';
                  installBtn.textContent = 'Restarting...';
                  msgEl.textContent = 'Update installed! Restarting...';
                  msgEl.style.color = 'var(--status-idle)';
                },
                onRestart: () => {
                  msgEl.textContent = 'Update installed. Please restart the app manually.';
                },
              });
            } catch (err) {
              msgEl.textContent = 'Download failed: ' + err;
              msgEl.style.color = 'var(--status-exited)';
              installBtn.textContent = 'Retry';
              installBtn.disabled = false;
              progressEl.style.display = 'none';
            }
          });

        } else {
          msgEl.textContent = "You're up to date! (v" + version + ')';
          msgEl.style.color = 'var(--status-idle)';
        }

      } catch (pluginErr) {
        // Fallback: manual GitHub API check (for builds without signed releases)
        console.warn('[updater] Plugin check failed, falling back to GitHub API:', pluginErr);
        try {
          const resp = await fetch('https://api.github.com/repos/ben4mn/PaneStreet/releases/latest');
          if (!resp.ok) throw new Error('GitHub API returned ' + resp.status);
          const data = await resp.json();

          const latestTag = data.tag_name.replace(/^v/, '');
          const currentParts = version.split('.').map(Number);
          const latestParts = latestTag.split('.').map(Number);

          let isNewer = false;
          for (let i = 0; i < 3; i++) {
            const c = currentParts[i] || 0;
            const l = latestParts[i] || 0;
            if (l > c) { isNewer = true; break; }
            if (l < c) break;
          }

          if (isNewer) {
            msgEl.textContent = 'New version ' + latestTag + ' available!';
            msgEl.style.color = 'var(--status-waiting)';
            actionsEl.innerHTML = `
              <a href="#" id="update-download-link" style="color:var(--accent);font-size:var(--font-size-sm);text-decoration:underline;cursor:pointer">
                Download v${latestTag} from GitHub
              </a>
            `;
            container.querySelector('#update-download-link').onclick = (e) => {
              e.preventDefault();
              try { window.__TAURI__.opener.openUrl(data.html_url); }
              catch { window.open(data.html_url, '_blank'); }
            };
          } else {
            msgEl.textContent = "You're up to date! (v" + version + ')';
            msgEl.style.color = 'var(--status-idle)';
          }
        } catch (fallbackErr) {
          msgEl.textContent = 'Failed to check: ' + fallbackErr.message;
          msgEl.style.color = 'var(--status-exited)';
        }
      }
    });
  }
}

// --- Keyboard Shortcuts ---

const DEFAULT_SHORTCUTS = [
  { id: 'close-panel',      label: 'Close panel / file viewer',    key: 'Escape',  meta: false, shift: false, category: 'Navigation' },
  { id: 'settings',         label: 'Open settings',                key: ',',       meta: true,  shift: false, category: 'Navigation' },
  { id: 'sidebar-toggle',   label: 'Toggle sidebar',               key: 'b',       meta: true,  shift: false, category: 'Navigation' },
  { id: 'file-viewer',      label: 'Toggle file viewer',           key: 'e',       meta: true,  shift: true,  category: 'Navigation' },
  { id: 'new-terminal',     label: 'New terminal',                 key: 'n',       meta: true,  shift: false, category: 'Sessions' },
  { id: 'close-terminal',   label: 'Close terminal',               key: 'w',       meta: true,  shift: false, category: 'Sessions' },
  { id: 'focus-1',          label: 'Focus terminal 1–9',           key: '1-9',     meta: true,  shift: false, category: 'Sessions' },
  { id: 'maximize',         label: 'Maximize / restore pane',      key: 'Enter',   meta: true,  shift: true,  category: 'Windows' },
  { id: 'minimize',         label: 'Minimize pane',                key: 'm',       meta: true,  shift: false, category: 'Windows' },
  { id: 'restore-all',      label: 'Restore all minimized',        key: 'm',       meta: true,  shift: true,  category: 'Windows' },
  { id: 'layout-mode',      label: 'Toggle grid / free-form',      key: 'g',       meta: true,  shift: true,  category: 'Windows' },
  { id: 'prev-pane',        label: 'Previous pane',                key: '[',       meta: true,  shift: true,  category: 'Windows' },
  { id: 'next-pane',        label: 'Next pane',                    key: ']',       meta: true,  shift: true,  category: 'Windows' },
];

function loadShortcuts() {
  const saved = localStorage.getItem('ps-shortcuts');
  if (!saved) return DEFAULT_SHORTCUTS.map(s => ({ ...s }));
  try {
    const parsed = JSON.parse(saved);
    // Merge saved with defaults (in case new shortcuts added)
    return DEFAULT_SHORTCUTS.map(def => {
      const override = parsed.find(s => s.id === def.id);
      return override ? { ...def, key: override.key, meta: override.meta, shift: override.shift } : { ...def };
    });
  } catch { return DEFAULT_SHORTCUTS.map(s => ({ ...s })); }
}

function saveShortcuts(shortcuts) {
  localStorage.setItem('ps-shortcuts', JSON.stringify(shortcuts));
  window.dispatchEvent(new CustomEvent('shortcuts-changed', { detail: shortcuts }));
}

function formatShortcut(s) {
  const parts = [];
  if (s.meta) parts.push(_isMac ? '\u2318' : 'Ctrl');
  if (s.shift) parts.push('\u21E7');
  if (s.key === 'Enter') parts.push('\u23CE');
  else if (s.key === 'Escape') parts.push('Esc');
  else if (s.key === '[') parts.push('[');
  else if (s.key === ']') parts.push(']');
  else if (s.key === ',') parts.push(',');
  else if (s.key === '1-9') parts.push('1\u20139');
  else parts.push(s.key.toUpperCase());
  return parts.join('');
}

function renderKeysTab(container) {
  const shortcuts = loadShortcuts();
  const categories = [...new Set(shortcuts.map(s => s.category))];

  let html = `
    <div class="keys-header">
      <div class="keys-header-text">
        <div class="setting-section-title" style="margin-bottom:4px">Keyboard Shortcuts</div>
        <div class="setting-description">Click any shortcut to rebind it. Press Escape to cancel.</div>
      </div>
      <button class="keys-reset-btn" id="keys-reset" title="Reset all to defaults">Reset All</button>
    </div>
  `;

  categories.forEach(cat => {
    const catShortcuts = shortcuts.filter(s => s.category === cat);
    html += `<div class="keys-category">
      <div class="keys-category-label">${cat}</div>
      <div class="keys-list">`;

    catShortcuts.forEach(s => {
      const isCustom = (() => {
        const def = DEFAULT_SHORTCUTS.find(d => d.id === s.id);
        return def && (def.key !== s.key || def.meta !== s.meta || def.shift !== s.shift);
      })();

      html += `
        <div class="keys-row" data-id="${s.id}">
          <div class="keys-row-info">
            <span class="keys-row-label">${s.label}</span>
            ${isCustom ? '<span class="keys-modified-badge">modified</span>' : ''}
          </div>
          <div class="keys-row-binding">
            <button class="keys-binding-btn" data-id="${s.id}" title="Click to rebind">
              <span class="keys-binding-text">${formatShortcut(s)}</span>
            </button>
            ${isCustom ? `<button class="keys-revert-btn" data-id="${s.id}" title="Revert to default">\u21BA</button>` : ''}
          </div>
        </div>`;
    });

    html += `</div></div>`;
  });

  container.innerHTML = html;

  // Bind click handlers
  container.querySelectorAll('.keys-binding-btn').forEach(btn => {
    btn.addEventListener('click', () => startRebind(btn, shortcuts, container));
  });

  container.querySelectorAll('.keys-revert-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const def = DEFAULT_SHORTCUTS.find(d => d.id === id);
      const shortcut = shortcuts.find(s => s.id === id);
      if (def && shortcut) {
        shortcut.key = def.key;
        shortcut.meta = def.meta;
        shortcut.shift = def.shift;
        saveShortcuts(shortcuts);
        renderKeysTab(container);
      }
    });
  });

  container.querySelector('#keys-reset')?.addEventListener('click', () => {
    localStorage.removeItem('ps-shortcuts');
    saveShortcuts(DEFAULT_SHORTCUTS);
    renderKeysTab(container);
  });
}

function startRebind(btn, shortcuts, container) {
  const id = btn.dataset.id;
  const shortcut = shortcuts.find(s => s.id === id);
  if (!shortcut || shortcut.id === 'focus-1') return; // Can't rebind 1-9

  const textEl = btn.querySelector('.keys-binding-text');
  const originalText = textEl.textContent;
  textEl.textContent = 'Press keys\u2026';
  btn.classList.add('recording');
  btn.closest('.keys-row').classList.add('recording');

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();

    // Ignore lone modifier keys
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(e.key)) return;

    // Escape cancels
    if (e.key === 'Escape' && !_modActive(e) && !e.shiftKey) {
      cleanup();
      textEl.textContent = originalText;
      btn.classList.remove('recording');
      btn.closest('.keys-row').classList.remove('recording');
      return;
    }

    // Check for conflict
    const newKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const conflict = shortcuts.find(s =>
      s.id !== id && s.key === newKey && s.meta === _modActive(e) && s.shift === e.shiftKey
    );

    if (conflict) {
      textEl.textContent = `Conflict: ${conflict.label}`;
      textEl.style.color = 'var(--status-exited)';
      setTimeout(() => {
        textEl.textContent = 'Press keys\u2026';
        textEl.style.color = '';
      }, 1500);
      return;
    }

    shortcut.key = newKey;
    shortcut.meta = _modActive(e);
    shortcut.shift = e.shiftKey;
    saveShortcuts(shortcuts);
    cleanup();
    renderKeysTab(container);
  }

  function cleanup() {
    document.removeEventListener('keydown', onKey, true);
  }

  document.addEventListener('keydown', onKey, true);
}

// --- Theme System ---

const PRESET_THEMES = {
  dark: {
    name: 'Dark',
    colors: {
      '--bg-app': '#1a1a1a', '--bg-sidebar': '#1e1e1e', '--bg-pane': '#111111', '--bg-header': '#1a1a1a',
      '--bg-footer': '#1a1a1a', '--bg-card': '#2a2a2a', '--text-primary': '#e0e0e0', '--text-secondary': '#b0b0b0',
      '--text-bright': '#ffffff', '--text-muted': '#888888', '--accent': '#2a6df0', '--accent-light': '#a8c8ff',
    },
    terminal: {
      background: '#111111', foreground: '#cccccc', cursor: '#cccccc',
      black: '#1a1a1a', red: '#ef4444', green: '#4ade80', yellow: '#f59e0b',
      blue: '#2a6df0', magenta: '#c084fc', cyan: '#22d3ee', white: '#cccccc',
      brightBlack: '#555555', brightRed: '#f87171', brightGreen: '#86efac', brightYellow: '#fbbf24',
      brightBlue: '#60a5fa', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#ffffff',
    },
  },
  midnight: {
    name: 'Midnight Blue',
    colors: {
      '--bg-app': '#0d1117', '--bg-sidebar': '#0f1419', '--bg-pane': '#0a0e14', '--bg-header': '#0d1117',
      '--bg-footer': '#0d1117', '--bg-card': '#161b22', '--text-primary': '#c9d1d9', '--text-secondary': '#8b949e',
      '--text-bright': '#f0f6fc', '--text-muted': '#7d8590', '--accent': '#58a6ff', '--accent-light': '#79c0ff',
    },
    terminal: {
      background: '#0a0e14', foreground: '#c9d1d9', cursor: '#58a6ff',
      black: '#0d1117', red: '#ff7b72', green: '#7ee787', yellow: '#ffa657',
      blue: '#58a6ff', magenta: '#d2a8ff', cyan: '#79c0ff', white: '#c9d1d9',
      brightBlack: '#484f58', brightRed: '#ffa198', brightGreen: '#aff5b4', brightYellow: '#ffdf5d',
      brightBlue: '#a5d6ff', brightMagenta: '#e2c5ff', brightCyan: '#a5d6ff', brightWhite: '#f0f6fc',
    },
  },
  dracula: {
    name: 'Dracula',
    colors: {
      '--bg-app': '#282a36', '--bg-sidebar': '#21222c', '--bg-pane': '#1e1f29', '--bg-header': '#282a36',
      '--bg-footer': '#282a36', '--bg-card': '#343746', '--text-primary': '#f8f8f2', '--text-secondary': '#6272a4',
      '--text-bright': '#ffffff', '--text-muted': '#7970a9', '--accent': '#bd93f9', '--accent-light': '#d6bcfa',
    },
    terminal: {
      background: '#1e1f29', foreground: '#f8f8f2', cursor: '#f8f8f2',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  nord: {
    name: 'Nord',
    colors: {
      '--bg-app': '#2e3440', '--bg-sidebar': '#2b303b', '--bg-pane': '#272c36', '--bg-header': '#2e3440',
      '--bg-footer': '#2e3440', '--bg-card': '#3b4252', '--text-primary': '#d8dee9', '--text-secondary': '#81a1c1',
      '--text-bright': '#eceff4', '--text-muted': '#7b88a1', '--accent': '#88c0d0', '--accent-light': '#8fbcbb',
      '--accent-fg': '#2e3440',
    },
    terminal: {
      background: '#272c36', foreground: '#d8dee9', cursor: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#d08770', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  solarized: {
    name: 'Solarized Dark',
    colors: {
      '--bg-app': '#002b36', '--bg-sidebar': '#003440', '--bg-pane': '#001e26', '--bg-header': '#002b36',
      '--bg-footer': '#002b36', '--bg-card': '#073642', '--text-primary': '#93a1a1', '--text-secondary': '#7c8f8f',
      '--text-bright': '#fdf6e3', '--text-muted': '#7c9198', '--accent': '#268bd2', '--accent-light': '#2aa198',
    },
    terminal: {
      background: '#001e26', foreground: '#839496', cursor: '#839496',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
      brightBlue: '#268bd2', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#fdf6e3',
    },
  },
  gruvbox: {
    name: 'Gruvbox Dark',
    colors: {
      '--bg-app': '#282828', '--bg-sidebar': '#1d2021', '--bg-pane': '#1d2021', '--bg-header': '#282828',
      '--bg-footer': '#282828', '--bg-card': '#3c3836', '--text-primary': '#ebdbb2', '--text-secondary': '#a89984',
      '--text-bright': '#fbf1c7', '--text-muted': '#928374', '--accent': '#fe8019', '--accent-light': '#fabd2f',
      '--accent-fg': '#1d2021',
    },
    terminal: {
      background: '#1d2021', foreground: '#ebdbb2', cursor: '#ebdbb2',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
      blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  },
  tokyoNight: {
    name: 'Tokyo Night',
    colors: {
      '--bg-app': '#1a1b26', '--bg-sidebar': '#16161e', '--bg-pane': '#13131a', '--bg-header': '#1a1b26',
      '--bg-footer': '#1a1b26', '--bg-card': '#24283b', '--text-primary': '#c0c8e8', '--text-secondary': '#7982ab',
      '--text-bright': '#c0caf5', '--text-muted': '#737aa2', '--accent': '#7aa2f7', '--accent-light': '#bb9af7',
    },
    terminal: {
      background: '#13131a', foreground: '#a9b1d6', cursor: '#c0caf5',
      black: '#1a1b26', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
      brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  oneDark: {
    name: 'One Dark',
    colors: {
      '--bg-app': '#282c34', '--bg-sidebar': '#21252b', '--bg-pane': '#1e2127', '--bg-header': '#282c34',
      '--bg-footer': '#282c34', '--bg-card': '#2c313c', '--text-primary': '#bcc3cf', '--text-secondary': '#7a8290',
      '--text-bright': '#d7dae0', '--text-muted': '#7f848e', '--accent': '#61afef', '--accent-light': '#56b6c2',
    },
    terminal: {
      background: '#1e2127', foreground: '#abb2bf', cursor: '#528bff',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#be5046', brightGreen: '#98c379', brightYellow: '#d19a66',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#d7dae0',
    },
  },
  catppuccin: {
    name: 'Catppuccin Mocha',
    colors: {
      '--bg-app': '#1e1e2e', '--bg-sidebar': '#181825', '--bg-pane': '#11111b', '--bg-header': '#1e1e2e',
      '--bg-footer': '#1e1e2e', '--bg-card': '#313244', '--text-primary': '#cdd6f4', '--text-secondary': '#a6adc8',
      '--text-bright': '#ffffff', '--text-muted': '#7f849c', '--accent': '#cba6f7', '--accent-light': '#f5c2e7',
      '--accent-fg': '#1e1e2e',
    },
    terminal: {
      background: '#11111b', foreground: '#cdd6f4', cursor: '#f5e0dc',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  },
  rosePine: {
    name: 'Rose Pine',
    colors: {
      '--bg-app': '#191724', '--bg-sidebar': '#1f1d2e', '--bg-pane': '#13111e', '--bg-header': '#191724',
      '--bg-footer': '#191724', '--bg-card': '#26233a', '--text-primary': '#e0def4', '--text-secondary': '#908caa',
      '--text-bright': '#ffffff', '--text-muted': '#908caa', '--accent': '#ebbcba', '--accent-light': '#f6c177',
      '--accent-fg': '#191724',
    },
    terminal: {
      background: '#13111e', foreground: '#e0def4', cursor: '#524f67',
      black: '#26233a', red: '#eb6f92', green: '#31748f', yellow: '#f6c177',
      blue: '#9ccfd8', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
      brightBlack: '#6e6a86', brightRed: '#eb6f92', brightGreen: '#31748f', brightYellow: '#f6c177',
      brightBlue: '#9ccfd8', brightMagenta: '#c4a7e7', brightCyan: '#ebbcba', brightWhite: '#e0def4',
    },
  },
  kanagawa: {
    name: 'Kanagawa',
    colors: {
      '--bg-app': '#1f1f28', '--bg-sidebar': '#1a1a22', '--bg-pane': '#16161d', '--bg-header': '#1f1f28',
      '--bg-footer': '#1f1f28', '--bg-card': '#2a2a37', '--text-primary': '#dcd7ba', '--text-secondary': '#a09f95',
      '--text-bright': '#f2ecbc', '--text-muted': '#727169', '--accent': '#7e9cd8', '--accent-light': '#7fb4ca',
    },
    terminal: {
      background: '#16161d', foreground: '#dcd7ba', cursor: '#c8c093',
      black: '#16161d', red: '#c34043', green: '#76946a', yellow: '#c0a36e',
      blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384',
      brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
    },
  },
  everforest: {
    name: 'Everforest',
    colors: {
      '--bg-app': '#2d353b', '--bg-sidebar': '#272e33', '--bg-pane': '#232a2e', '--bg-header': '#2d353b',
      '--bg-footer': '#2d353b', '--bg-card': '#374145', '--text-primary': '#d3c6aa', '--text-secondary': '#9da9a0',
      '--text-bright': '#e6ddc4', '--text-muted': '#7a8478', '--accent': '#a7c080', '--accent-light': '#83c092',
      '--accent-fg': '#272e33',
    },
    terminal: {
      background: '#232a2e', foreground: '#d3c6aa', cursor: '#d3c6aa',
      black: '#343f44', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f',
      blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#4d5960', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f',
      brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#e6ddc4',
    },
  },
  synthwave: {
    name: 'Synthwave 84',
    colors: {
      '--bg-app': '#262335', '--bg-sidebar': '#211e2e', '--bg-pane': '#1b182a', '--bg-header': '#262335',
      '--bg-footer': '#262335', '--bg-card': '#312c42', '--text-primary': '#e0d8f0', '--text-secondary': '#a599c4',
      '--text-bright': '#ffffff', '--text-muted': '#8673a8', '--accent': '#ff7edb', '--accent-light': '#36f9f6',
      '--accent-fg': '#2b1e3b',
    },
    terminal: {
      background: '#1b182a', foreground: '#e0d8f0', cursor: '#ff7edb',
      black: '#262335', red: '#fe4450', green: '#72f1b8', yellow: '#fede5d',
      blue: '#36f9f6', magenta: '#ff7edb', cyan: '#36f9f6', white: '#f0e8ff',
      brightBlack: '#614d85', brightRed: '#fe4450', brightGreen: '#72f1b8', brightYellow: '#f3e70f',
      brightBlue: '#03edf9', brightMagenta: '#ff7edb', brightCyan: '#03edf9', brightWhite: '#ffffff',
    },
  },
  ayu: {
    name: 'Ayu Dark',
    colors: {
      '--bg-app': '#0b0e14', '--bg-sidebar': '#0d1017', '--bg-pane': '#090c10', '--bg-header': '#0b0e14',
      '--bg-footer': '#0b0e14', '--bg-card': '#131721', '--text-primary': '#bfbdb6', '--text-secondary': '#8b8a85',
      '--text-bright': '#e6e1cf', '--text-muted': '#6c6f75', '--accent': '#e6b450', '--accent-light': '#ffb454',
      '--accent-fg': '#0a0e14',
    },
    terminal: {
      background: '#090c10', foreground: '#bfbdb6', cursor: '#e6b450',
      black: '#0b0e14', red: '#d95757', green: '#7fd962', yellow: '#e6b450',
      blue: '#59c2ff', magenta: '#d2a6ff', cyan: '#95e6cb', white: '#bfbdb6',
      brightBlack: '#475258', brightRed: '#f07178', brightGreen: '#aad94c', brightYellow: '#ffb454',
      brightBlue: '#73b8ff', brightMagenta: '#dfbfff', brightCyan: '#95e6cb', brightWhite: '#e6e1cf',
    },
  },
  horizon: {
    name: 'Horizon',
    colors: {
      '--bg-app': '#1c1e26', '--bg-sidebar': '#1a1c23', '--bg-pane': '#16171d', '--bg-header': '#1c1e26',
      '--bg-footer': '#1c1e26', '--bg-card': '#232530', '--text-primary': '#d5d8e0', '--text-secondary': '#9da0a8',
      '--text-bright': '#ffffff', '--text-muted': '#6c6f93', '--accent': '#e95678', '--accent-light': '#fab795',
    },
    terminal: {
      background: '#16171d', foreground: '#d5d8e0', cursor: '#e95678',
      black: '#1c1e26', red: '#e95678', green: '#29d398', yellow: '#fab795',
      blue: '#26bbd9', magenta: '#ee64ac', cyan: '#59e3e3', white: '#d5d8e0',
      brightBlack: '#6c6f93', brightRed: '#ec6a88', brightGreen: '#3fdaa4', brightYellow: '#fbc3a7',
      brightBlue: '#3fc6de', brightMagenta: '#f075b7', brightCyan: '#6be6e6', brightWhite: '#ffffff',
    },
  },
  moonlight: {
    name: 'Moonlight',
    colors: {
      '--bg-app': '#1e2030', '--bg-sidebar': '#191a2a', '--bg-pane': '#141526', '--bg-header': '#1e2030',
      '--bg-footer': '#1e2030', '--bg-card': '#2b2d42', '--text-primary': '#c8d3f5', '--text-secondary': '#a0a8cd',
      '--text-bright': '#e4f0fb', '--text-muted': '#7a7e9e', '--accent': '#82aaff', '--accent-light': '#c3e88d',
    },
    terminal: {
      background: '#141526', foreground: '#c8d3f5', cursor: '#82aaff',
      black: '#1e2030', red: '#ff757f', green: '#c3e88d', yellow: '#ffc777',
      blue: '#82aaff', magenta: '#c099ff', cyan: '#86e1fc', white: '#c8d3f5',
      brightBlack: '#545c7e', brightRed: '#ff98a4', brightGreen: '#c3e88d', brightYellow: '#ffc777',
      brightBlue: '#82aaff', brightMagenta: '#c099ff', brightCyan: '#86e1fc', brightWhite: '#e4f0fb',
    },
  },
  eg: {
    name: 'EG',
    colors: {
      '--bg-app': '#0e1a2b', '--bg-sidebar': '#0b1524', '--bg-pane': '#091220', '--bg-header': '#0e1a2b',
      '--bg-footer': '#0e1a2b', '--bg-card': '#162640', '--text-primary': '#d4dce8', '--text-secondary': '#8a9bb5',
      '--text-bright': '#f0f4f8', '--text-muted': '#5e7491', '--accent': '#fddb32', '--accent-light': '#ffe680',
      '--accent-fg': '#0e1a2b',
    },
    terminal: {
      background: '#091220', foreground: '#d4dce8', cursor: '#fddb32',
      black: '#0e1a2b', red: '#e05252', green: '#5cb85c', yellow: '#fddb32',
      blue: '#3b82d4', magenta: '#a87fd4', cyan: '#4db8c7', white: '#d4dce8',
      brightBlack: '#3d5272', brightRed: '#ef6b6b', brightGreen: '#7ed67e', brightYellow: '#ffe680',
      brightBlue: '#5a9de5', brightMagenta: '#c0a0e8', brightCyan: '#6dcdd9', brightWhite: '#f0f4f8',
    },
  },
};

let saveThemeTimeout = null;

function getCurrentTheme() {
  try {
    const saved = localStorage.getItem('ps-theme');
    if (saved) return JSON.parse(saved);
  } catch {}
  return { ...PRESET_THEMES.dark, name: 'dark' };
}

export function applyTheme(themeData) {
  // Apply CSS variables
  if (themeData.colors) {
    for (const [prop, value] of Object.entries(themeData.colors)) {
      document.documentElement.style.setProperty(prop, value);
    }
    // Titlebar follows header color for theme consistency
    if (themeData.colors['--bg-header']) {
      document.documentElement.style.setProperty('--bg-titlebar', themeData.colors['--bg-header']);
    }
    // Default accent foreground to white if theme doesn't specify
    if (!themeData.colors['--accent-fg']) {
      document.documentElement.style.setProperty('--accent-fg', '#ffffff');
    }
  }
  // Dispatch terminal theme update event
  if (themeData.terminal) {
    window.dispatchEvent(new CustomEvent('theme-terminal-changed', { detail: themeData.terminal }));
  }
}

export function loadSavedTheme() {
  const theme = getCurrentTheme();
  if (theme.name !== 'dark') {
    applyTheme(theme);
  }
}

function saveTheme(themeData) {
  clearTimeout(saveThemeTimeout);
  saveThemeTimeout = setTimeout(() => {
    localStorage.setItem('ps-theme', JSON.stringify(themeData));
  }, 200);
}

function renderThemeTab(container) {
  const theme = getCurrentTheme();

  const colorRow = (label, prop, value) =>
    `<div class="theme-color-item">
      <input type="color" value="${value}" data-prop="${prop}" />
      <label>${label}</label>
    </div>`;

  const termColorRow = (label, key, value) =>
    `<div class="theme-color-item">
      <input type="color" value="${value}" data-term="${key}" />
      <label>${label}</label>
    </div>`;

  const currentPreset = PRESET_THEMES[theme.name];
  const currentLabel = currentPreset ? currentPreset.name : 'Custom';

  container.innerHTML = `
    <div class="theme-selector">
      <div class="theme-selector-current" id="theme-selector-toggle">
        <div class="theme-preview-swatch" style="background: linear-gradient(135deg, ${theme.colors['--bg-app']} 50%, ${theme.colors['--accent']} 50%)"></div>
        <span class="theme-selector-name">${currentLabel}</span>
        <span class="theme-selector-arrow">&#9662;</span>
      </div>
      <div class="theme-selector-dropdown" id="theme-dropdown">
        ${Object.entries(PRESET_THEMES).map(([key, p]) =>
          `<div class="theme-option ${theme.name === key ? 'active' : ''}" data-preset="${key}">
            <div class="theme-preview-swatch" style="background: linear-gradient(135deg, ${p.colors['--bg-app']} 50%, ${p.colors['--accent']} 50%)"></div>
            <span class="theme-option-name">${p.name}</span>
          </div>`
        ).join('')}
      </div>
    </div>

    <div class="theme-layout">
    <div class="theme-controls">

    <div class="theme-section">
      <h3>App Colors</h3>
      <div class="theme-color-grid">
        ${colorRow('Background', '--bg-app', theme.colors['--bg-app'])}
        ${colorRow('Sidebar', '--bg-sidebar', theme.colors['--bg-sidebar'])}
        ${colorRow('Pane', '--bg-pane', theme.colors['--bg-pane'])}
        ${colorRow('Header', '--bg-header', theme.colors['--bg-header'])}
        ${colorRow('Card', '--bg-card', theme.colors['--bg-card'])}
      </div>
    </div>

    <div class="theme-section">
      <h3>Text Colors</h3>
      <div class="theme-color-grid">
        ${colorRow('Primary', '--text-primary', theme.colors['--text-primary'])}
        ${colorRow('Secondary', '--text-secondary', theme.colors['--text-secondary'])}
        ${colorRow('Bright', '--text-bright', theme.colors['--text-bright'])}
      </div>
    </div>

    <div class="theme-section">
      <h3>Accent</h3>
      <div class="theme-color-grid">
        ${colorRow('Accent', '--accent', theme.colors['--accent'])}
        ${colorRow('Accent Light', '--accent-light', theme.colors['--accent-light'])}
      </div>
    </div>

    <div class="theme-section">
      <h3>Terminal — Background &amp; Text</h3>
      <div class="theme-color-grid">
        ${termColorRow('Background', 'background', theme.terminal.background)}
        ${termColorRow('Foreground', 'foreground', theme.terminal.foreground)}
        ${termColorRow('Cursor', 'cursor', theme.terminal.cursor)}
        ${termColorRow('Selection', 'selectionBackground', theme.terminal.selectionBackground || '#2a6df044')}
      </div>
    </div>

    <div class="theme-section">
      <h3>Terminal — Normal Colors (0-7)</h3>
      <div class="theme-color-grid">
        ${termColorRow('Black', 'black', theme.terminal.black)}
        ${termColorRow('Red', 'red', theme.terminal.red)}
        ${termColorRow('Green', 'green', theme.terminal.green)}
        ${termColorRow('Yellow', 'yellow', theme.terminal.yellow)}
        ${termColorRow('Blue', 'blue', theme.terminal.blue)}
        ${termColorRow('Magenta', 'magenta', theme.terminal.magenta)}
        ${termColorRow('Cyan', 'cyan', theme.terminal.cyan)}
        ${termColorRow('White', 'white', theme.terminal.white)}
      </div>
    </div>

    <div class="theme-section">
      <h3>Terminal — Bright Colors (8-15)</h3>
      <div class="theme-color-grid">
        ${termColorRow('Bright Black', 'brightBlack', theme.terminal.brightBlack)}
        ${termColorRow('Bright Red', 'brightRed', theme.terminal.brightRed)}
        ${termColorRow('Bright Green', 'brightGreen', theme.terminal.brightGreen)}
        ${termColorRow('Bright Yellow', 'brightYellow', theme.terminal.brightYellow)}
        ${termColorRow('Bright Blue', 'brightBlue', theme.terminal.brightBlue)}
        ${termColorRow('Bright Magenta', 'brightMagenta', theme.terminal.brightMagenta)}
        ${termColorRow('Bright Cyan', 'brightCyan', theme.terminal.brightCyan)}
        ${termColorRow('Bright White', 'brightWhite', theme.terminal.brightWhite)}
      </div>
    </div>

    <button class="theme-reset-btn" id="theme-reset">Reset to Default</button>
    </div>

    <div class="theme-preview-panel">
      <div class="theme-terminal-preview" id="theme-preview">
        <div class="ttp-titlebar" style="background:${theme.colors['--bg-header']}">
          <span class="ttp-dot" style="background:#ff5f57"></span>
          <span class="ttp-dot" style="background:#febc2e"></span>
          <span class="ttp-dot" style="background:#28c840"></span>
          <span class="ttp-title" style="color:${theme.colors['--text-muted']}">Terminal</span>
        </div>
        <div class="ttp-body" style="background:${theme.terminal.background};color:${theme.terminal.foreground}">
          <div><span style="color:${theme.terminal.green}">~</span> <span style="color:${theme.terminal.blue}">main</span> <span style="color:${theme.terminal.yellow}">✦</span> npm run build</div>
          <div style="color:${theme.terminal.brightBlack}">  vite v5.4.2 building for production...</div>
          <div style="color:${theme.terminal.brightBlack}">  transforming...</div>
          <div>  <span style="color:${theme.terminal.cyan}">dist/index.html</span>  <span style="color:${theme.terminal.brightBlack}">0.45 kB │ gzip: 0.30 kB</span></div>
          <div>  <span style="color:${theme.terminal.cyan}">dist/app.js</span>     <span style="color:${theme.terminal.brightBlack}">142.8 kB │ gzip: 45.2 kB</span></div>
          <div style="color:${theme.terminal.green}">  ✓ built in 1.82s</div>
          <div><span style="color:${theme.terminal.red}">error</span><span style="color:${theme.terminal.brightBlack}">:</span> <span style="color:${theme.terminal.white}">Missing export 'render'</span></div>
          <div><span style="color:${theme.terminal.magenta}">warning</span><span style="color:${theme.terminal.brightBlack}">:</span> <span style="color:${theme.terminal.yellow}">Unused variable 'count'</span></div>
          <div><span style="color:${theme.terminal.green}">~</span> <span style="color:${theme.terminal.blue}">main</span> <span style="color:${theme.colors['--accent']}">▊</span></div>
        </div>
      </div>
    </div>
    </div>
  `;

  // Theme dropdown
  const toggle = container.querySelector('#theme-selector-toggle');
  const dropdown = container.querySelector('#theme-dropdown');

  toggle.onclick = (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  };

  // Close dropdown on outside click
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && !toggle.contains(e.target)) {
      dropdown.classList.remove('open');
      document.removeEventListener('click', closeDropdown);
    }
  };
  document.addEventListener('click', closeDropdown);

  container.querySelectorAll('.theme-option').forEach(opt => {
    opt.onclick = () => {
      const preset = PRESET_THEMES[opt.dataset.preset];
      const newTheme = { ...preset, name: opt.dataset.preset };
      applyTheme(newTheme);
      localStorage.setItem('ps-theme', JSON.stringify(newTheme));
      dropdown.classList.remove('open');
      renderThemeTab(container);
    };
  });

  // Refresh the fake terminal preview with current theme values
  function refreshPreview() {
    const t = getCurrentTheme();
    const p = container.querySelector('#theme-preview');
    if (!p) return;
    const tb = p.querySelector('.ttp-titlebar');
    const bd = p.querySelector('.ttp-body');
    tb.style.background = t.colors['--bg-header'];
    tb.querySelector('.ttp-title').style.color = t.colors['--text-muted'];
    bd.style.background = t.terminal.background;
    bd.style.color = t.terminal.foreground;
    // Re-render body content with updated colors
    bd.innerHTML = `
      <div><span style="color:${t.terminal.green}">~</span> <span style="color:${t.terminal.blue}">main</span> <span style="color:${t.terminal.yellow}">✦</span> npm run build</div>
      <div style="color:${t.terminal.brightBlack}">  vite v5.4.2 building for production...</div>
      <div style="color:${t.terminal.brightBlack}">  transforming...</div>
      <div>  <span style="color:${t.terminal.cyan}">dist/index.html</span>  <span style="color:${t.terminal.brightBlack}">0.45 kB │ gzip: 0.30 kB</span></div>
      <div>  <span style="color:${t.terminal.cyan}">dist/app.js</span>     <span style="color:${t.terminal.brightBlack}">142.8 kB │ gzip: 45.2 kB</span></div>
      <div style="color:${t.terminal.green}">  ✓ built in 1.82s</div>
      <div><span style="color:${t.terminal.red}">error</span><span style="color:${t.terminal.brightBlack}">:</span> <span style="color:${t.terminal.white}">Missing export 'render'</span></div>
      <div><span style="color:${t.terminal.magenta}">warning</span><span style="color:${t.terminal.brightBlack}">:</span> <span style="color:${t.terminal.yellow}">Unused variable 'count'</span></div>
      <div><span style="color:${t.terminal.green}">~</span> <span style="color:${t.terminal.blue}">main</span> <span style="color:${t.colors['--accent']}">▊</span></div>`;
  }

  // CSS variable color pickers (live preview)
  container.querySelectorAll('input[data-prop]').forEach(input => {
    input.addEventListener('input', () => {
      const prop = input.dataset.prop;
      document.documentElement.style.setProperty(prop, input.value);
      const theme = getCurrentTheme();
      theme.colors[prop] = input.value;
      theme.name = 'custom';
      saveTheme(theme);
      refreshPreview();
    });
  });

  // Terminal color pickers (live preview)
  container.querySelectorAll('input[data-term]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.term;
      const theme = getCurrentTheme();
      theme.terminal[key] = input.value;
      theme.name = 'custom';
      saveTheme(theme);
      window.dispatchEvent(new CustomEvent('theme-terminal-changed', { detail: theme.terminal }));
      refreshPreview();
    });
  });

  // Reset button
  container.querySelector('#theme-reset').onclick = () => {
    const defaultTheme = { ...PRESET_THEMES.dark, name: 'dark' };
    // Clear inline styles to restore CSS defaults
    for (const prop of Object.keys(defaultTheme.colors)) {
      document.documentElement.style.removeProperty(prop);
    }
    applyTheme(defaultTheme);
    localStorage.removeItem('ps-theme');
    renderThemeTab(container);
  };
}

// --- Plugins Panel ---

async function renderPluginsPanel() {
  const panel = document.getElementById('plugins-panel');
  panel.innerHTML = `
    <div class="config-panel-header">
      <button class="config-back-btn">\u2190 Back</button>
      <h1>Plugins</h1>
    </div>
    <div id="plugins-list"><div class="empty-state">Loading...</div></div>
  `;

  panel.querySelector('.config-back-btn').onclick = hidePanel;

  try {
    const config = await invoke('read_claude_config', { projectPath: null });
    const list = panel.querySelector('#plugins-list');

    if (config.plugins.length === 0) {
      list.innerHTML = '<div class="empty-state">No plugins installed.</div>';
      return;
    }

    list.innerHTML = config.plugins.map(p => `
      <div class="plugin-card" data-plugin="${p.name}">
        <div>
          <div class="plugin-name">${p.name.split('@')[0]}</div>
          <div class="plugin-meta">${p.scope} \u00b7 v${p.version}</div>
        </div>
        <label class="form-toggle">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} />
          <span>${p.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
    `).join('');

    // Wire toggle handlers
    list.querySelectorAll('.plugin-card input[type="checkbox"]').forEach(checkbox => {
      checkbox.onchange = async () => {
        const card = checkbox.closest('.plugin-card');
        const pluginName = card.dataset.plugin;
        const enabled = checkbox.checked;
        const label = card.querySelector('.form-toggle span');
        label.textContent = enabled ? 'Enabled' : 'Disabled';

        // Patch settings.json
        try {
          const config = await invoke('read_claude_config', { projectPath: null });
          const settings = config.settings_raw;
          if (!settings.enabledPlugins) settings.enabledPlugins = {};
          settings.enabledPlugins[pluginName] = enabled;
          await invoke('save_claude_settings', { settingsJson: JSON.stringify(settings, null, 2) });
        } catch (err) {
          console.error('Failed to save plugin toggle:', err);
          checkbox.checked = !enabled;
          label.textContent = !enabled ? 'Enabled' : 'Disabled';
        }
      };
    });

  } catch (err) {
    panel.querySelector('#plugins-list').innerHTML = `<div class="empty-state">Failed to load: ${err}</div>`;
  }
}

// --- MCPs Panel ---

async function renderMcpsPanel() {
  const panel = document.getElementById('mcps-panel');
  panel.innerHTML = `
    <div class="config-panel-header">
      <button class="config-back-btn">\u2190 Back</button>
      <h1>MCP Servers</h1>
    </div>
    <div id="mcps-list"><div class="empty-state">Loading...</div></div>
  `;

  panel.querySelector('.config-back-btn').onclick = hidePanel;

  try {
    const config = await invoke('read_claude_config', { projectPath: null });
    const list = panel.querySelector('#mcps-list');

    if (config.mcp_servers.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          No MCP servers configured.<br>
          <span class="setting-description">Add servers in ~/.claude/settings.json under the "mcpServers" key.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = config.mcp_servers.map(s => `
      <div class="mcp-card">
        <div>
          <div class="plugin-name">${s.name}</div>
          <div class="plugin-meta">${s.command} ${s.args.join(' ')}</div>
        </div>
      </div>
    `).join('');

  } catch (err) {
    panel.querySelector('#mcps-list').innerHTML = `<div class="empty-state">Failed to load: ${err}</div>`;
  }
}

// --- Memory Panel ---

async function renderMemoryPanel() {
  const panel = document.getElementById('memory-panel');
  panel.innerHTML = `
    <div class="config-panel-header">
      <button class="config-back-btn">\u2190 Back</button>
      <h1>Memory</h1>
    </div>
    <div id="memory-content"><div class="empty-state">Loading...</div></div>
  `;

  panel.querySelector('.config-back-btn').onclick = hidePanel;

  const cwd = focusedSessionCwd;
  const content = panel.querySelector('#memory-content');

  if (!cwd) {
    content.innerHTML = `<div class="empty-state">No active terminal directory. Open a terminal first.</div>`;
    return;
  }

  try {
    const mem = await invoke('read_project_memories', { projectPath: cwd });

    const projectLabel = mem.project_name || cwd.split(/[\\/]/).pop();

    // Build memory file list
    let memoryFilesHtml = '';
    if (mem.memory_files.length > 0) {
      memoryFilesHtml = mem.memory_files.map((f, i) => {
        // Parse frontmatter for description
        const descMatch = f.content.match(/^---[\s\S]*?description:\s*(.+)$/m);
        const typeMatch = f.content.match(/^---[\s\S]*?type:\s*(.+)$/m);
        const desc = descMatch ? descMatch[1].trim() : '';
        const type = typeMatch ? typeMatch[1].trim() : '';
        const typeLabel = type ? `<span class="memory-type-badge memory-type-${type}">${type}</span>` : '';
        return `
          <div class="memory-file-card" data-idx="${i}">
            <div class="memory-file-header">
              <span class="memory-file-name">${escapeForHtml(f.name)}</span>
              ${typeLabel}
            </div>
            ${desc ? `<div class="memory-file-desc">${escapeForHtml(desc)}</div>` : ''}
          </div>
        `;
      }).join('');
    }

    content.innerHTML = `
      <div class="memory-project-header">
        <span class="memory-project-icon">\u{1F4C1}</span>
        <span class="memory-project-name">${escapeForHtml(projectLabel)}</span>
        <span class="memory-project-path">${escapeForHtml(cwd)}</span>
      </div>

      <div class="memory-section">
        <div class="memory-section-header">
          <h3>Project CLAUDE.md</h3>
          ${mem.claude_md_path ? `<span class="memory-file-path-hint">${escapeForHtml(mem.claude_md_path)}</span>` : ''}
        </div>
        <textarea class="memory-editor" id="memory-project" placeholder="No CLAUDE.md found for this project. Create one to give Claude project-specific instructions.">${escapeForHtml(mem.claude_md || '')}</textarea>
        <div class="memory-editor-actions">
          <button class="memory-save-btn" id="memory-save-project">Save</button>
        </div>
      </div>

      ${mem.memory_files.length > 0 ? `
        <div class="memory-section">
          <h3>Claude Memories (${mem.memory_files.length})</h3>
          <div class="setting-description" style="margin-bottom:8px">Memories Claude has saved about this project, your preferences, and context.</div>
          <div class="memory-file-list">${memoryFilesHtml}</div>
        </div>
      ` : `
        <div class="memory-section">
          <h3>Claude Memories</h3>
          <div class="empty-state" style="padding:12px 0">No memories saved for this project yet. Claude creates these automatically as you work together.</div>
        </div>
      `}

      ${mem.memory_index ? `
        <div class="memory-section">
          <h3>Memory Index</h3>
          <pre class="memory-index-view">${escapeForHtml(mem.memory_index)}</pre>
        </div>
      ` : ''}

      <div class="memory-section memory-section-global">
        <h3>Global CLAUDE.md</h3>
        <div class="setting-description" style="margin-bottom:6px">Instructions that apply to all projects (~/.claude/CLAUDE.md)</div>
        <textarea class="memory-editor" id="memory-global" placeholder="No global CLAUDE.md found.">${escapeForHtml(mem.global_claude_md || '')}</textarea>
        <div class="memory-editor-actions">
          <button class="memory-save-btn" id="memory-save-global">Save</button>
        </div>
      </div>
    `;

    // Expand memory file cards to show full content
    content.querySelectorAll('.memory-file-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.idx);
        const file = mem.memory_files[idx];
        if (!file) return;
        // Toggle expanded view
        const existing = card.querySelector('.memory-file-content');
        if (existing) {
          existing.remove();
          card.classList.remove('expanded');
        } else {
          const pre = document.createElement('pre');
          pre.className = 'memory-file-content';
          pre.textContent = file.content;
          card.appendChild(pre);
          card.classList.add('expanded');
        }
      });
    });

    // Save project CLAUDE.md
    content.querySelector('#memory-save-project').onclick = async () => {
      const text = content.querySelector('#memory-project').value;
      const savePath = mem.claude_md_path || (cwd + '/CLAUDE.md');
      try {
        await invoke('save_memory_file', { path: savePath, content: text });
        flashButton(content.querySelector('#memory-save-project'));
      } catch (err) {
        console.error('Failed to save project memory:', err);
      }
    };

    // Save global CLAUDE.md
    content.querySelector('#memory-save-global').onclick = async () => {
      const text = content.querySelector('#memory-global').value;
      try {
        const home = await getHomePath();
        await invoke('save_memory_file', { path: home + '/.claude/CLAUDE.md', content: text });
        flashButton(content.querySelector('#memory-save-global'));
      } catch (err) {
        console.error('Failed to save global memory:', err);
      }
    };

  } catch (err) {
    content.innerHTML = `<div class="empty-state">Failed to load: ${err}</div>`;
  }
}

function flashButton(btn) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = 'Saved!';
  btn.style.background = 'var(--status-idle)';
  setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 1500);
}

function escapeForHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatChangelogBody(md) {
  return md
    .split('\n')
    .filter(l => l.trim())
    .map(l => {
      const t = l.trim();
      if (/^#{1,3}\s/.test(t)) return ''; // skip sub-headers
      if (/^[-*]\s/.test(t)) {
        const safe = escapeForHtml(t.slice(2));
        const text = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        return `<div class="changelog-item">\u2022 ${text}</div>`;
      }
      return `<div class="changelog-item" style="color:var(--text-muted)">${escapeForHtml(t)}</div>`;
    })
    .filter(Boolean)
    .join('');
}

async function getHomePath() {
  try {
    const path = window.__TAURI__.path;
    if (path?.homeDir) return (await path.homeDir()).replace(/[\\/]$/, '');
  } catch {}
  // Fallback for platforms
  const isWinPlat = navigator.platform.indexOf('Win') >= 0;
  if (isWinPlat) return 'C:\\Users\\' + (navigator.userAgent.match(/Windows/)?.[0] ? 'user' : 'user');
  return '/Users/user';
}

// --- Scheduled Panel ---

let scheduledRefreshTimer = null;

async function renderScheduledPanel() {
  const panel = document.getElementById('scheduled-panel');

  panel.innerHTML = `
    <div class="config-panel-header">
      <h2>Scheduled</h2>
      <div class="config-panel-actions">
        <button id="scheduled-refresh" class="config-action-btn" title="Refresh">Refresh</button>
      </div>
    </div>
    <div id="scheduled-content" class="config-panel-body">
      <div class="fv-loading">Loading...</div>
    </div>
  `;

  document.getElementById('scheduled-refresh').addEventListener('click', () => renderScheduledContent());

  await renderScheduledContent();

  // Auto-refresh every 30s while panel is visible
  if (scheduledRefreshTimer) clearInterval(scheduledRefreshTimer);
  scheduledRefreshTimer = setInterval(() => {
    if (activePanel === 'scheduled') renderScheduledContent();
    else { clearInterval(scheduledRefreshTimer); scheduledRefreshTimer = null; }
  }, 30000);
}

async function renderScheduledContent() {
  const container = document.getElementById('scheduled-content');
  if (!container) return;

  try {
    const data = await invoke('read_scheduled_tasks');
    container.innerHTML = '';

    // Active Sessions section
    const sessionsSection = document.createElement('div');
    sessionsSection.className = 'config-section';

    const sessionsHeader = document.createElement('h3');
    sessionsHeader.className = 'config-section-title';
    sessionsHeader.textContent = 'Active Claude Sessions';
    sessionsSection.appendChild(sessionsHeader);

    const aliveSessions = data.sessions.filter(s => s.alive);
    const deadSessions = data.sessions.filter(s => !s.alive);

    if (aliveSessions.length === 0 && deadSessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scheduled-empty';
      empty.textContent = 'No Claude sessions found.';
      sessionsSection.appendChild(empty);
    } else {
      for (const session of aliveSessions) {
        sessionsSection.appendChild(createSessionCard(session));
      }
      if (deadSessions.length > 0) {
        const staleLabel = document.createElement('div');
        staleLabel.className = 'scheduled-stale-label';
        staleLabel.textContent = `${deadSessions.length} stale session${deadSessions.length > 1 ? 's' : ''}`;
        sessionsSection.appendChild(staleLabel);
      }
    }

    container.appendChild(sessionsSection);

    // Scheduled Tasks section
    const tasksSection = document.createElement('div');
    tasksSection.className = 'config-section';

    const tasksHeader = document.createElement('h3');
    tasksHeader.className = 'config-section-title';
    tasksHeader.textContent = 'Scheduled Tasks';
    tasksSection.appendChild(tasksHeader);

    if (data.scheduled_tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scheduled-empty';
      empty.innerHTML = 'No scheduled tasks found.<br><span class="scheduled-hint">Use <code>/schedule</code> in Claude Code to create scheduled tasks.</span>';
      tasksSection.appendChild(empty);
    } else {
      for (const task of data.scheduled_tasks) {
        tasksSection.appendChild(createTaskCard(task));
      }
    }

    container.appendChild(tasksSection);
  } catch (err) {
    container.innerHTML = `<div class="fv-error">Failed to load: ${err}</div>`;
  }
}

function createSessionCard(session) {
  const card = document.createElement('div');
  card.className = 'scheduled-session-card';

  const now = Date.now();
  const startedMs = session.started_at;
  const elapsed = now - startedMs;
  const timeStr = formatElapsed(elapsed);

  const cwdShort = session.cwd
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~');
  const nameStr = session.name || cwdShort.split(/[\\/]/).pop() || 'Claude';

  card.innerHTML = `
    <div class="session-card-header">
      <span class="session-status-dot ${session.alive ? 'alive' : 'dead'}"></span>
      <span class="session-card-name">${escHtml(nameStr)}</span>
      <span class="session-card-time">${timeStr}</span>
    </div>
    <div class="session-card-cwd">${escHtml(cwdShort)}</div>
    <div class="session-card-meta">
      <span class="session-kind-badge">${escHtml(session.kind)}</span>
      <span class="session-pid">PID ${session.pid}</span>
    </div>
  `;

  return card;
}

function createTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'scheduled-task-card';

  const cronStr = task.cron || '—';
  const promptStr = task.prompt || task.name || 'No prompt';
  const recurring = task.recurring ? 'Recurring' : 'One-time';

  card.innerHTML = `
    <div class="task-card-header">
      <span class="cron-badge">${escHtml(cronStr)}</span>
      <span class="task-recurring-badge">${recurring}</span>
    </div>
    <div class="task-card-prompt">${escHtml(promptStr)}</div>
  `;

  return card;
}

function formatElapsed(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function escHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
