const { invoke } = window.__TAURI__.core;

const _isWin = navigator.platform.indexOf('Win') >= 0;
const _sep = _isWin ? '\\' : '/';
// Split path on both / and \ for cross-platform support
function _splitPath(p) { return p.split(/[\\/]/).filter(Boolean); }
// Join path parts with platform separator, preserving drive letter or root
function _joinPath(parts, original) {
  if (_isWin) {
    // Preserve drive letter (e.g. "C:")
    return parts.join('\\');
  }
  return '/' + parts.join('/');
}

let currentPath = null;
let expandedDirs = new Set();
let viewerVisible = false;
let selectedFile = null;
let rawMode = false;
let diffStats = new Map(); // abs_path -> {additions, deletions, status}
let currentDiffHunks = []; // hunks for currently viewed file

// --- Public API ---

export function initFileViewer() {
  document.getElementById('fv-close').addEventListener('click', hideFileViewer);
  const finderBtn = document.getElementById('fv-finder');
  const isWin = navigator.platform.indexOf('Win') >= 0;
  finderBtn.textContent = isWin ? 'Explorer' : 'Finder';
  finderBtn.title = isWin ? 'Open in Explorer' : 'Open in Finder';
  finderBtn.addEventListener('click', () => {
    if (currentPath) invoke('open_in_finder', { path: currentPath });
  });
  document.getElementById('fv-back').addEventListener('click', navigateUp);
  document.getElementById('fv-toggle-view').addEventListener('click', toggleRawMode);
  document.getElementById('fv-toggle-btn').addEventListener('click', () => toggleFileViewer());
  document.getElementById('fv-open-default').addEventListener('click', () => {
    const target = selectedFile || currentPath;
    if (target) invoke('open_with_default', { path: target });
  });

  // Keyboard navigation
  document.getElementById('file-viewer').addEventListener('keydown', handleFileViewerKeydown);
}

export function toggleFileViewer(latestCwd) {
  if (viewerVisible) { hideFileViewer(); return; }
  window.dispatchEvent(new CustomEvent('panel-opening', { detail: 'file-viewer' }));
  showFileViewer(latestCwd || currentPath);
}

export function showFileViewer(cwd) {
  const viewer = document.getElementById('file-viewer');
  // Slide in from right
  viewer.classList.add('closing');
  viewer.style.display = 'flex';
  // Force reflow so the closing position registers before we animate in
  viewer.offsetHeight; // eslint-disable-line no-unused-expressions
  viewer.classList.remove('closing');
  viewerVisible = true;
  document.getElementById('fv-toggle-btn').classList.add('active');

  if (cwd && cwd !== currentPath) {
    currentPath = cwd;
    selectedFile = null;
  }

  // Always render the tree when opening — fetch fresh CWD first if possible
  if (currentPath) {
    refreshDiffStats(currentPath);
    showTree();
  } else {
    const tree = document.getElementById('fv-tree');
    tree.innerHTML = '<div class="fv-empty">Waiting for terminal directory...</div>';
    tree.style.display = '';
    document.getElementById('fv-content').style.display = 'none';
  }

  // Dispatch event so app.js can push fresh CWD
  window.dispatchEvent(new CustomEvent('file-viewer-opened'));
}

export function hideFileViewer() {
  const viewer = document.getElementById('file-viewer');
  viewerVisible = false;
  document.getElementById('fv-toggle-btn').classList.remove('active');

  // Slide out to right
  viewer.classList.add('closing');
  let handled = false;
  const hide = () => {
    if (handled) return;
    handled = true;
    viewer.removeEventListener('transitionend', onEnd);
    if (!viewerVisible) viewer.style.display = 'none';
  };
  const onEnd = (e) => {
    if (e.target === viewer) hide();
  };
  viewer.addEventListener('transitionend', onEnd);
  // Fallback if transition doesn't fire
  setTimeout(hide, 350);
}

export function updateFileViewerCwd(cwd) {
  if (!viewerVisible) {
    currentPath = cwd;
    return;
  }
  if (cwd && cwd !== currentPath) {
    currentPath = cwd;
    selectedFile = null;
    expandedDirs.clear();
    showTree();
  }
}

export function isFileViewerVisible() {
  return viewerVisible;
}

export async function refreshDiffStats(cwd) {
  if (!cwd) return;
  try {
    const stats = await invoke('get_git_diff_stats', { cwd });
    diffStats.clear();
    for (const stat of stats) {
      diffStats.set(stat.abs_path, stat);
    }
    // Re-render tree if visible and showing tree view
    if (viewerVisible && document.getElementById('fv-tree').style.display !== 'none') {
      renderDirectory(currentPath, document.getElementById('fv-tree'), 0);
    }
  } catch {
    // Not a git repo or other error — clear diff stats
    diffStats.clear();
  }
}

// --- Navigation ---

function navigateUp() {
  if (!currentPath) return;
  const parent = currentPath.replace(/[\\/][^\\/]+[\\/]?$/, '') || (_isWin ? currentPath.slice(0, 3) : '/');
  if (parent !== currentPath) {
    currentPath = parent;
    selectedFile = null;
    expandedDirs.clear();
    showTree();
  }
}

function showTree() {
  const tree = document.getElementById('fv-tree');
  const content = document.getElementById('fv-content');
  tree.style.display = '';
  content.style.display = 'none';
  document.getElementById('fv-toggle-view').style.display = 'none';
  updateOpenButton();
  updatePathDisplay();
  renderDirectory(currentPath, tree, 0);
}

function updatePathDisplay() {
  const pathEl = document.getElementById('fv-path');
  pathEl.innerHTML = '';
  if (!currentPath) return;

  // Detect home directory for ~ shortening
  let home = '';
  if (_isWin) {
    const m = currentPath.match(/^[A-Za-z]:\\Users\\[^\\]+/);
    if (m) home = m[0];
  } else {
    home = (typeof process !== 'undefined' && process.env?.HOME) || currentPath.match(/^\/Users\/[^/]+/)?.[0] || '';
  }
  const display = home ? currentPath.replace(home, '~') : currentPath;
  const parts = _splitPath(display);
  const fullParts = _splitPath(currentPath);

  parts.forEach((part, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'fv-breadcrumb-sep';
      sep.textContent = ' \u203A ';
      pathEl.appendChild(sep);
    }
    const crumb = document.createElement('span');
    crumb.className = 'fv-breadcrumb';
    crumb.textContent = part;
    crumb.title = _joinPath(fullParts.slice(0, i + 1), currentPath);
    crumb.addEventListener('click', () => {
      currentPath = _joinPath(fullParts.slice(0, i + 1), currentPath);
      selectedFile = null;
      expandedDirs.clear();
      updateOpenButton();
      showTree();
    });
    pathEl.appendChild(crumb);
  });
  pathEl.title = currentPath;
}

function updateOpenButton() {
  const btn = document.getElementById('fv-open-default');
  if (btn) btn.style.display = selectedFile ? '' : 'none';
}

// --- Directory Tree ---

async function renderDirectory(path, container, depth) {
  container.innerHTML = '<div class="fv-loading">Loading...</div>';

  try {
    const entries = await invoke('read_directory', { path });
    container.innerHTML = '';

    if (entries.length === 0) {
      container.innerHTML = '<div class="fv-empty">Empty directory</div>';
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'fv-entry' + (entry.is_dir ? ' fv-dir' : ' fv-file');
      if (selectedFile === entry.path) row.classList.add('selected');
      row.style.paddingLeft = (8 + depth * 16) + 'px';

      const icon = document.createElement('span');
      icon.className = 'fv-entry-icon';

      if (entry.is_dir) {
        const isExpanded = expandedDirs.has(entry.path);
        icon.textContent = isExpanded ? '\u25BE' : '\u25B8';
      } else {
        icon.textContent = getFileIcon(entry.extension);
      }

      const name = document.createElement('span');
      name.className = 'fv-entry-name';
      name.textContent = entry.name;

      if (entry.is_symlink) {
        name.style.fontStyle = 'italic';
      }

      row.appendChild(icon);
      row.appendChild(name);

      // Add diff indicator for files
      if (!entry.is_dir && diffStats.has(entry.path)) {
        const stat = diffStats.get(entry.path);
        const diffInd = document.createElement('span');
        diffInd.className = 'fv-diff-indicator';
        if (stat.additions > 0) {
          const addSpan = document.createElement('span');
          addSpan.className = 'fv-diff-add';
          addSpan.textContent = `+${stat.additions}`;
          diffInd.appendChild(addSpan);
        }
        if (stat.deletions > 0) {
          const delSpan = document.createElement('span');
          delSpan.className = 'fv-diff-del';
          delSpan.textContent = `-${stat.deletions}`;
          diffInd.appendChild(delSpan);
        }
        row.appendChild(diffInd);
        row.classList.add('fv-changed');
      }

      if (entry.is_dir) {
        const childContainer = document.createElement('div');
        childContainer.className = 'fv-subtree';

        if (expandedDirs.has(entry.path)) {
          renderDirectory(entry.path, childContainer, depth + 1);
        }

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedDirs.has(entry.path)) {
            expandedDirs.delete(entry.path);
            icon.textContent = '\u25B8';
            childContainer.innerHTML = '';
          } else {
            expandedDirs.add(entry.path);
            icon.textContent = '\u25BE';
            renderDirectory(entry.path, childContainer, depth + 1);
          }
        });

        // Double-click to navigate into directory
        row.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          currentPath = entry.path;
          selectedFile = null;
          expandedDirs.clear();
          showTree();
        });

        container.appendChild(row);
        container.appendChild(childContainer);
      } else {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          selectedFile = entry.path;
          // Update selection styling
          container.closest('#fv-tree').querySelectorAll('.fv-entry').forEach(el => el.classList.remove('selected'));
          row.classList.add('selected');
          updateOpenButton();
          loadFileContent(entry.path, entry.extension);
        });

        container.appendChild(row);
      }
    }
  } catch (err) {
    container.innerHTML = `<div class="fv-error">Error: ${err}</div>`;
  }
}

function getFileIcon(ext) {
  if (!ext) return '\u25A1'; // empty square
  const icons = {
    js: '\u25C9', ts: '\u25C9', jsx: '\u25C9', tsx: '\u25C9',
    rs: '\u25C8', go: '\u25C8', py: '\u25C8', rb: '\u25C8',
    md: '\u25C7', mdx: '\u25C7', txt: '\u25C7',
    json: '\u25CB', yaml: '\u25CB', yml: '\u25CB', toml: '\u25CB',
    css: '\u25CA', html: '\u25CA', svg: '\u25CA',
    png: '\u25A3', jpg: '\u25A3', gif: '\u25A3', ico: '\u25A3',
    lock: '\u25A0',
  };
  return icons[ext.toLowerCase()] || '\u25A1';
}

// --- File Content ---

async function loadFileContent(filePath, ext) {
  const tree = document.getElementById('fv-tree');
  const content = document.getElementById('fv-content');
  const toggleBtn = document.getElementById('fv-toggle-view');

  try {
    const result = await invoke('read_file_content', { path: filePath });

    if (result.is_binary) {
      content.innerHTML = `<div class="fv-binary">${result.content}</div>`;
      content.style.display = '';
      tree.style.display = 'none';
      toggleBtn.style.display = 'none';
      return;
    }

    const extension = ext || filePath.split('.').pop() || '';
    rawMode = false;

    if (isMarkdown(extension)) {
      toggleBtn.style.display = '';
      toggleBtn.textContent = 'Raw';
      renderMarkdownContent(result.content, content);
    } else {
      toggleBtn.style.display = 'none';
      renderCodeContent(result.content, extension, content);
    }

    content.style.display = '';
    tree.style.display = 'none';
  } catch (err) {
    content.innerHTML = `<div class="fv-error">Failed to load: ${err}</div>`;
    content.style.display = '';
    tree.style.display = 'none';
    toggleBtn.style.display = 'none';
  }
}

function toggleRawMode() {
  if (!selectedFile) return;
  rawMode = !rawMode;

  const content = document.getElementById('fv-content');
  const toggleBtn = document.getElementById('fv-toggle-view');

  if (rawMode) {
    toggleBtn.textContent = 'Rendered';
    // Re-load as raw code
    invoke('read_file_content', { path: selectedFile }).then(result => {
      renderCodeContent(result.content, 'md', content);
    });
  } else {
    toggleBtn.textContent = 'Raw';
    invoke('read_file_content', { path: selectedFile }).then(result => {
      renderMarkdownContent(result.content, content);
    });
  }
}

function isMarkdown(ext) {
  return ['md', 'mdx', 'markdown'].includes((ext || '').toLowerCase());
}

// --- Renderers ---

async function renderCodeContent(text, ext, container) {
  const pre = document.createElement('pre');
  pre.className = 'fv-code-view';

  const lang = (ext || '').toLowerCase();
  const lines = text.split('\n');
  const gutterWidth = String(lines.length).length;

  // Load diff hunks for this file if it has changes
  let addedLines = new Set();
  let deletedInserts = new Map(); // line number -> array of deleted content
  currentDiffHunks = [];

  if (selectedFile && diffStats.has(selectedFile)) {
    try {
      const detail = await invoke('get_file_diff', { cwd: currentPath, filePath: selectedFile });
      if (detail) {
        currentDiffHunks = detail.hunks;
        for (const hunk of detail.hunks) {
          for (const line of hunk.lines) {
            if (line.kind === 'add' && line.new_lineno) {
              addedLines.add(line.new_lineno);
            }
            if (line.kind === 'delete' && line.old_lineno) {
              // Insert deleted lines before the next add or context line
              const insertAt = hunk.lines.find(l => l.kind !== 'delete' && l.new_lineno)?.new_lineno || hunk.new_start;
              if (!deletedInserts.has(insertAt)) deletedInserts.set(insertAt, []);
              deletedInserts.get(insertAt).push(line.content);
            }
          }
        }
      }
    } catch { /* not in git or other error */ }
  }

  let html = '';
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;

    // Insert deleted lines before this line
    if (deletedInserts.has(lineNo)) {
      for (const delContent of deletedInserts.get(lineNo)) {
        html += `<span class="fv-line fv-line-deleted"><span class="fv-line-num"> -</span>${highlightLine(escapeHtml(delContent.replace(/\n$/, '')), lang)}\n</span>`;
      }
    }

    const lineNum = String(lineNo).padStart(gutterWidth, ' ');
    const lineClass = addedLines.has(lineNo) ? ' fv-line-added' : '';
    const highlighted = highlightLine(escapeHtml(lines[i]), lang);
    html += `<span class="fv-line${lineClass}"><span class="fv-line-num">${lineNum}</span>${highlighted}\n</span>`;
  }

  pre.innerHTML = html;
  pre.dataset.lang = lang;

  container.innerHTML = '';

  // Back-to-tree button
  const backBtn = document.createElement('button');
  backBtn.className = 'fv-back-to-tree';
  backBtn.textContent = '\u2190 Back to files';
  backBtn.addEventListener('click', () => {
    selectedFile = null;
    currentDiffHunks = [];
    showTree();
  });
  container.appendChild(backBtn);

  // Diff navigation bar if there are changes
  if (currentDiffHunks.length > 0) {
    const diffNav = document.createElement('div');
    diffNav.className = 'fv-diff-nav';

    const label = document.createElement('span');
    label.className = 'fv-diff-nav-label';
    label.textContent = `${currentDiffHunks.length} change${currentDiffHunks.length > 1 ? 's' : ''}`;

    const prevBtn = document.createElement('button');
    prevBtn.className = 'fv-action-btn';
    prevBtn.textContent = '\u2191 Prev';
    prevBtn.addEventListener('click', () => jumpToDiffHunk(pre, -1));

    const nextBtn = document.createElement('button');
    nextBtn.className = 'fv-action-btn';
    nextBtn.textContent = '\u2193 Next';
    nextBtn.addEventListener('click', () => jumpToDiffHunk(pre, 1));

    diffNav.appendChild(label);
    diffNav.appendChild(prevBtn);
    diffNav.appendChild(nextBtn);
    container.appendChild(diffNav);
  }

  container.appendChild(pre);
}

let currentHunkIndex = -1;

function jumpToDiffHunk(pre, direction) {
  const changedLines = pre.querySelectorAll('.fv-line-added, .fv-line-deleted');
  if (changedLines.length === 0) return;

  // Find groups of consecutive changed lines (hunks)
  const hunkStarts = [changedLines[0]];
  for (let i = 1; i < changedLines.length; i++) {
    const prev = changedLines[i - 1];
    const curr = changedLines[i];
    if (prev.nextElementSibling !== curr) {
      hunkStarts.push(curr);
    }
  }

  currentHunkIndex += direction;
  if (currentHunkIndex < 0) currentHunkIndex = hunkStarts.length - 1;
  if (currentHunkIndex >= hunkStarts.length) currentHunkIndex = 0;

  hunkStarts[currentHunkIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// --- Syntax Highlighting ---

const SYN_KEYWORDS_JS = '\\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|class|extends|super|import|export|from|default|async|await|try|catch|finally|throw|this|null|undefined|true|false|yield)\\b';
const SYN_KEYWORDS_RUST = '\\b(fn|let|mut|const|pub|use|mod|struct|enum|impl|trait|where|for|while|loop|if|else|match|return|break|continue|as|in|ref|self|Self|super|crate|type|static|async|await|move|unsafe|extern|true|false|None|Some|Ok|Err)\\b';
const SYN_KEYWORDS_PY = '\\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|yield|lambda|pass|del|global|nonlocal|assert|True|False|None|in|not|and|or|is|async|await|self)\\b';
const SYN_KEYWORDS_CSS = '\\b(import|media|keyframes|from|to)\\b';
const SYN_KEYWORDS_GO = '\\b(func|var|const|type|struct|interface|map|chan|go|select|case|default|if|else|for|range|return|break|continue|switch|package|import|defer|nil|true|false|make|len|append|cap)\\b';

function getKeywordsPattern(lang) {
  if (['js', 'jsx', 'ts', 'tsx', 'mjs'].includes(lang)) return SYN_KEYWORDS_JS;
  if (lang === 'rs') return SYN_KEYWORDS_RUST;
  if (lang === 'py') return SYN_KEYWORDS_PY;
  if (lang === 'css' || lang === 'scss') return SYN_KEYWORDS_CSS;
  if (lang === 'go') return SYN_KEYWORDS_GO;
  // Fallback: common keywords across languages
  return '\\b(function|return|if|else|for|while|class|import|export|const|let|var|true|false|null|def|fn|pub|use)\\b';
}

function highlightLine(escaped, lang) {
  const kw = getKeywordsPattern(lang);

  // Order matters: comments first, then strings, then keywords, then numbers
  let result = escaped;

  // Single-line comments (// or #)
  result = result.replace(/(\/\/.*$|#.*$)/gm, '<span class="syn-comment">$1</span>');

  // Strings (double and single quoted) — simple, non-greedy
  result = result.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)/g, '<span class="syn-string">$1</span>');
  result = result.replace(/(&#39;(?:[^&]|&(?!#39;))*?&#39;)/g, '<span class="syn-string">$1</span>');
  // Backtick strings for JS
  result = result.replace(/(`[^`]*`)/g, '<span class="syn-string">$1</span>');

  // Keywords (only if not inside a comment/string span already)
  result = result.replace(new RegExp(kw, 'g'), (m) => {
    return `<span class="syn-keyword">${m}</span>`;
  });

  // Numbers
  result = result.replace(/\b(\d+\.?\d*)\b/g, '<span class="syn-number">$1</span>');

  // Function calls: word followed by (
  result = result.replace(/\b([a-zA-Z_]\w*)\s*(?=\()/g, '<span class="syn-func">$1</span>');

  return result;
}

function renderMarkdownContent(text, container) {
  container.innerHTML = '';

  const rendered = document.createElement('div');
  rendered.className = 'fv-markdown-view';

  // Simple markdown parser (no external deps)
  rendered.innerHTML = parseMarkdown(text);

  // Find and render mermaid blocks
  rendered.querySelectorAll('pre > code.lang-mermaid').forEach(block => {
    const wrapper = document.createElement('div');
    wrapper.className = 'fv-mermaid';
    wrapper.textContent = 'Mermaid diagram (rendering not available without mermaid.js)';
    wrapper.style.color = 'var(--text-muted)';
    wrapper.style.fontStyle = 'italic';
    wrapper.style.padding = '12px';
    wrapper.style.background = 'var(--bg-pane)';
    wrapper.style.borderRadius = 'var(--radius-sm)';
    block.parentElement.replaceWith(wrapper);
  });

  container.appendChild(rendered);

  // Add back-to-tree button
  const backBtn = document.createElement('button');
  backBtn.className = 'fv-back-to-tree';
  backBtn.textContent = '\u2190 Back to files';
  backBtn.addEventListener('click', () => {
    selectedFile = null;
    showTree();
  });
  container.prepend(backBtn);
}

// Lightweight markdown parser
function parseMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');

  // Blockquotes
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Paragraphs (double newlines)
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs and paragraphs wrapping block elements
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1');
  html = html.replace(/<p>(<li>)/g, '<ul>$1');
  html = html.replace(/(<\/li>)<\/p>/g, '$1</ul>');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');

  return html;
}

function handleFileViewerKeydown(e) {
  // Diff hunk navigation when viewing file content
  const content = document.getElementById('fv-content');
  if (content.style.display !== 'none') {
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      const pre = content.querySelector('.fv-code-view');
      if (pre) jumpToDiffHunk(pre, e.key === ']' ? 1 : -1);
      return;
    }
  }

  const tree = document.getElementById('fv-tree');
  if (tree.style.display === 'none') return;

  const entries = Array.from(tree.querySelectorAll('.fv-entry'));
  if (entries.length === 0) return;

  const selectedIdx = entries.findIndex(el => el.classList.contains('selected'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.min(selectedIdx + 1, entries.length - 1);
    entries.forEach(el => el.classList.remove('selected'));
    entries[next].classList.add('selected');
    entries[next].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = Math.max(selectedIdx - 1, 0);
    entries.forEach(el => el.classList.remove('selected'));
    entries[prev].classList.add('selected');
    entries[prev].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedIdx >= 0) entries[selectedIdx].click();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    navigateUp();
  }
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
