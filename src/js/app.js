import { TerminalSession } from './terminal.js';
import { togglePanel, hidePanel, isAnyPanelActive, setOnHide, loadSavedTheme, setFocusedCwd } from './config-panels.js';
import { initFileViewer, toggleFileViewer, updateFileViewerCwd, hideFileViewer, isFileViewerVisible, refreshDiffStats } from './file-viewer.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// Platform detection: use Ctrl on Windows/Linux, Cmd on macOS
const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const isWin = navigator.platform.indexOf('Win') >= 0;
const modSymbol = isMac ? '\u2318' : 'Ctrl+';
const modShiftSymbol = isMac ? '\u2318\u21E7' : 'Ctrl+Shift+';
function modActive(e) { return isMac ? e.metaKey : e.ctrlKey; }

// Cross-platform path utilities
const SEP = isWin ? '\\' : '/';
function splitPath(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean); }
function shortenCwd(cwd) {
  const parts = splitPath(cwd);
  return parts.length > 2 ? `\u2026${SEP}${parts.slice(-2).join(SEP)}` : cwd;
}

const sessions = [];
const closedSessionStack = []; // For Ctrl+Z undo-close
const MAX_CLOSED_SESSIONS = 10;
let focusedIndex = 0;
let maximizedIndex = null;
let contextMenu = null;
let layoutMode = 'freeform'; // 'auto' | 'freeform'
let snapToGrid = true;
let freeformZCounter = 1;
const SNAP_INCREMENT = 20;
const PANE_MIN_WIDTH = 200;
const PANE_MIN_HEIGHT = 120;

// --- Throttle / Debounce utilities ---
function throttle(fn, ms) {
  let last = 0, timer = null;
  return function(...args) {
    const now = Date.now();
    clearTimeout(timer);
    if (now - last >= ms) {
      last = now;
      fn.apply(this, args);
    } else {
      timer = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, ms - (now - last));
    }
  };
}

// Grid split ratios — stored as percentages for columns and rows
// Reset when pane count changes; keyed by layout count
let gridSplitRatios = {};
function nextTerminalNumber() {
  const used = new Set();
  for (const s of sessions) {
    const m = s.name.match(/^Terminal (\d+)$/);
    if (m) used.add(parseInt(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return n;
}
let windowFocused = true;
let pendingTerminalSettings = null;
// Track app window focus via both JS and Tauri events for reliability.
// Debounce blur to prevent notification-triggered focus flicker on Windows:
// Windows briefly unfocuses the app when a toast notification appears, then
// re-focuses it, which can create a blur->notify->blur loop.
let _blurTimer = null;
function setFocused(val) {
  if (val) {
    if (_blurTimer) { clearTimeout(_blurTimer); _blurTimer = null; }
    windowFocused = true;
  } else {
    // Delay blur by 200ms — if focus returns within that window, ignore the blur
    if (_blurTimer) clearTimeout(_blurTimer);
    _blurTimer = setTimeout(() => { windowFocused = false; _blurTimer = null; }, 200);
  }
}
window.addEventListener('focus', () => setFocused(true));
window.addEventListener('blur', () => setFocused(false));
document.addEventListener('visibilitychange', () => {
  setFocused(!document.hidden);
  document.body.classList.toggle('app-hidden', document.hidden);
});
// Tauri native window focus events (most reliable for OS-level app switching)
listen('tauri://focus', () => setFocused(true));
listen('tauri://blur', () => setFocused(false));

// --- Grid Layout ---

function updateGridLayout() {
  const grid = document.getElementById('pane-grid');

  // Remove all panes and gutters from grid
  sessions.forEach(s => {
    if (s.pane.parentNode === grid) {
      grid.removeChild(s.pane);
    }
  });
  grid.querySelectorAll('.grid-gutter').forEach(g => g.remove());

  if (layoutMode === 'freeform') {
    applyFreeformLayout();
    return;
  }

  grid.classList.remove('freeform');
  grid.style.gridTemplateColumns = '';
  grid.style.gridTemplateRows = '';
  // Clear any inline freeform styles
  sessions.forEach(s => {
    s.pane.style.cssText = '';
    removeFreeformHandles(s.pane);
  });

  if (maximizedIndex !== null && maximizedIndex < sessions.length) {
    grid.className = 'layout-maximized';
    grid.appendChild(sessions[maximizedIndex].pane);
  } else {
    maximizedIndex = null;
    const visible = sessions.filter(s => !s.minimized);
    const count = Math.min(visible.length, 6);
    grid.className = count > 0 ? `layout-${count}` : '';
    visible.forEach(s => grid.appendChild(s.pane));

    // Apply saved split ratios if any
    if (gridSplitRatios[count]) {
      const r = gridSplitRatios[count];
      if (r.cols) grid.style.gridTemplateColumns = r.cols;
      if (r.rows) grid.style.gridTemplateRows = r.rows;
    }

    // Insert grid gutters for resizable splits (skip layout-5 — complex spanning)
    if (count >= 2 && count !== 5) {
      insertGridGutters(grid, count);
    }
  }

  requestAnimationFrame(() => requestAnimationFrame(() => fitVisibleTerminals()));
}

// --- Grid Gutters (in-grid resize) ---

function getGridLayoutInfo(count) {
  // Returns { cols, rows } describing the grid structure
  switch (count) {
    case 2: return { cols: 2, rows: 1 };
    case 3: return { cols: 2, rows: 2 }; // triptych
    case 4: return { cols: 2, rows: 2 };
    case 5: return { cols: 3, rows: 2 }; // special: top 3, bottom 2
    case 6: return { cols: 3, rows: 2 };
    default: return { cols: 1, rows: 1 };
  }
}

function insertGridGutters(grid, count) {
  const info = getGridLayoutInfo(count);
  const gridRect = grid.getBoundingClientRect();
  const saved = gridSplitRatios[count];

  // Parse saved ratios to get gutter positions
  let colPositions = [];
  let rowPositions = [];
  if (saved?.cols) {
    const parts = parseGridTemplate(saved.cols, info.cols, gridRect.width);
    let cumulative = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      cumulative += parts[i];
      colPositions.push(cumulative);
    }
  }
  if (saved?.rows) {
    const parts = parseGridTemplate(saved.rows, info.rows, gridRect.height);
    let cumulative = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      cumulative += parts[i];
      rowPositions.push(cumulative);
    }
  }

  // Double-click any gutter to reset to equal splits
  function resetSplits() {
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    delete gridSplitRatios[count];
    fitVisibleTerminals();
    saveSessionState();
    // Reposition gutters
    grid.querySelectorAll('.grid-gutter-v').forEach((g, i) => {
      g.style.left = `${((i + 1) / info.cols) * 100}%`;
    });
    grid.querySelectorAll('.grid-gutter-h').forEach((g, i) => {
      g.style.top = `${((i + 1) / info.rows) * 100}%`;
    });
  }

  // Vertical gutter(s) — between columns
  if (info.cols >= 2) {
    for (let c = 1; c < info.cols; c++) {
      const gutter = document.createElement('div');
      gutter.className = 'grid-gutter grid-gutter-v';
      const pos = colPositions[c - 1] ?? (c / info.cols) * 100;
      gutter.style.left = `${pos}%`;
      gutter.dataset.col = c;
      gutter.dataset.totalCols = info.cols;
      gutter.dataset.count = count;
      gutter.addEventListener('dblclick', resetSplits);
      grid.appendChild(gutter);
    }
  }

  // Horizontal gutter(s) — between rows
  if (info.rows >= 2) {
    for (let r = 1; r < info.rows; r++) {
      const gutter = document.createElement('div');
      gutter.className = 'grid-gutter grid-gutter-h';
      const pos = rowPositions[r - 1] ?? (r / info.rows) * 100;
      gutter.style.top = `${pos}%`;
      gutter.dataset.row = r;
      gutter.dataset.totalRows = info.rows;
      gutter.dataset.count = count;
      gutter.addEventListener('dblclick', resetSplits);
      grid.appendChild(gutter);
    }
  }
}

function setupGridGutterDrag() {
  let dragging = null;

  function startGutterDrag(e, gutter) {
    e.preventDefault();
    const grid = document.getElementById('pane-grid');
    const gridRect = grid.getBoundingClientRect();
    const isVertical = gutter.classList.contains('grid-gutter-v');

    dragging = {
      gutter,
      grid,
      gridRect,
      isVertical,
      col: parseInt(gutter.dataset.col) || 0,
      row: parseInt(gutter.dataset.row) || 0,
      totalCols: parseInt(gutter.dataset.totalCols) || 1,
      totalRows: parseInt(gutter.dataset.totalRows) || 1,
      count: parseInt(gutter.dataset.count) || 2,
    };

    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    gutter.classList.add('active');
  }

  document.addEventListener('mousedown', (e) => {
    if (layoutMode !== 'auto') return;

    // Direct gutter click
    const gutter = e.target.closest('.grid-gutter');
    if (gutter) {
      startGutterDrag(e, gutter);
      return;
    }

    // Pane edge click → find nearest gutter
    const edge = e.target.closest('.pane-edge');
    if (edge && maximizedIndex === null) {
      const pane = edge.closest('.pane');
      const grid = document.getElementById('pane-grid');
      const paneRect = pane.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();

      let nearestGutter = null;
      let bestDist = Infinity;
      const isVEdge = edge.classList.contains('pane-edge-right') || edge.classList.contains('pane-edge-corner');
      const isHEdge = edge.classList.contains('pane-edge-bottom') || edge.classList.contains('pane-edge-corner');

      // Prefer vertical gutter if dragging a right edge
      if (isVEdge) {
        grid.querySelectorAll('.grid-gutter-v').forEach(g => {
          const gLeft = gridRect.left + (parseFloat(g.style.left) / 100) * gridRect.width;
          const dist = Math.abs(gLeft - paneRect.right);
          if (dist < bestDist) { bestDist = dist; nearestGutter = g; }
        });
      }
      // Prefer horizontal gutter if dragging a bottom edge
      if (isHEdge && (!nearestGutter || bestDist > 50)) {
        grid.querySelectorAll('.grid-gutter-h').forEach(g => {
          const gTop = gridRect.top + (parseFloat(g.style.top) / 100) * gridRect.height;
          const dist = Math.abs(gTop - paneRect.bottom);
          if (dist < bestDist) { bestDist = dist; nearestGutter = g; }
        });
      }

      if (nearestGutter && bestDist < 60) {
        startGutterDrag(e, nearestGutter);
      }
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const { grid, gridRect, isVertical, col, row, totalCols, totalRows, count } = dragging;

    if (isVertical) {
      const pct = ((e.clientX - gridRect.left) / gridRect.width) * 100;
      const clamped = Math.max(15, Math.min(85, pct));
      // Build column template
      if (totalCols === 2) {
        grid.style.gridTemplateColumns = `${clamped}% ${100 - clamped}%`;
      } else if (totalCols === 3) {
        // For 3 columns, adjust the one being dragged
        const current = grid.style.gridTemplateColumns || '1fr 1fr 1fr';
        const parts = parseGridTemplate(current, totalCols, gridRect.width);
        if (col === 1) {
          const remaining = parts[1] + parts[2];
          parts[0] = clamped;
          const ratio = parts[2] / (parts[1] + parts[2]) || 0.5;
          parts[1] = (100 - clamped) * (1 - ratio);
          parts[2] = (100 - clamped) * ratio;
        } else {
          const beforeTotal = parts[0] + parts[1];
          parts[2] = 100 - clamped;
          const ratio = parts[0] / beforeTotal || 0.5;
          parts[0] = clamped * ratio;
          parts[1] = clamped * (1 - ratio);
        }
        grid.style.gridTemplateColumns = parts.map(p => `${Math.max(10, p)}%`).join(' ');
      }
      // Update gutter position
      dragging.gutter.style.left = clamped + '%';
    } else {
      const pct = ((e.clientY - gridRect.top) / gridRect.height) * 100;
      const clamped = Math.max(15, Math.min(85, pct));
      grid.style.gridTemplateRows = `${clamped}% ${100 - clamped}%`;
      dragging.gutter.style.top = clamped + '%';
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    document.body.style.cursor = '';
    dragging.gutter.classList.remove('active');

    // Save ratios
    const count = dragging.count;
    const grid = dragging.grid;
    gridSplitRatios[count] = {
      cols: grid.style.gridTemplateColumns || null,
      rows: grid.style.gridTemplateRows || null,
    };

    fitVisibleTerminals();
    saveSessionState();
    dragging = null;
  });
}

function parseGridTemplate(template, count, totalPx) {
  // Parse a grid template string into percentage values
  if (template.includes('fr')) {
    // Equal distribution
    const pct = 100 / count;
    return Array(count).fill(pct);
  }
  return template.split(/\s+/).map(v => {
    if (v.endsWith('%')) return parseFloat(v);
    if (v.endsWith('px')) return (parseFloat(v) / totalPx) * 100;
    return 100 / count;
  });
}

// --- Freeform Layout ---

function snapValue(v) {
  return snapToGrid ? Math.round(v / SNAP_INCREMENT) * SNAP_INCREMENT : v;
}

function snapshotCurrentPositions() {
  const grid = document.getElementById('pane-grid');
  const gridRect = grid.getBoundingClientRect();
  sessions.forEach(s => {
    if (s.minimized || !s.pane.parentNode) return;
    const r = s.pane.getBoundingClientRect();
    s.freeformRect = {
      x: r.left - gridRect.left,
      y: r.top - gridRect.top,
      width: r.width,
      height: r.height,
    };
  });
}

function applyFreeformLayout() {
  const grid = document.getElementById('pane-grid');
  grid.className = 'freeform';

  if (maximizedIndex !== null && maximizedIndex < sessions.length) {
    // Show only the maximized pane at full size
    const s = sessions[maximizedIndex];
    s.pane.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;z-index:9;';
    grid.appendChild(s.pane);
    addFreeformHandles(s.pane);
    requestAnimationFrame(() => fitVisibleTerminals());
    return;
  }

  const visible = sessions.filter(s => !s.minimized);
  const gridRect = grid.getBoundingClientRect();

  visible.forEach((s, i) => {
    // Assign a default rect if none exists — start small, cascaded
    if (!s.freeformRect) {
      const defaultW = Math.min(600, gridRect.width * 0.5);
      const defaultH = Math.min(450, gridRect.height * 0.55);
      const cascade = i * 30;
      const x = Math.min(cascade + 20, gridRect.width - defaultW);
      const y = Math.min(cascade + 20, gridRect.height - defaultH);
      s.freeformRect = { x, y, width: defaultW, height: defaultH };
    }

    const r = s.freeformRect;
    s.pane.style.cssText = `position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;z-index:${s === sessions[focusedIndex] ? freeformZCounter : 1};`;
    grid.appendChild(s.pane);
    addFreeformHandles(s.pane);
  });

  requestAnimationFrame(() => fitVisibleTerminals());
}

function addFreeformHandles(pane) {
  if (pane.querySelector('.pane-resize-handle')) return; // already has handles
  const directions = ['e', 's', 'se'];
  directions.forEach(dir => {
    const handle = document.createElement('div');
    handle.className = `pane-resize-handle pane-resize-${dir}`;
    handle.dataset.direction = dir;
    pane.appendChild(handle);
  });
  // Make header draggable
  const header = pane.querySelector('.pane-header');
  if (header) header.classList.add('pane-header-draggable');
}

function removeFreeformHandles(pane) {
  pane.querySelectorAll('.pane-resize-handle').forEach(h => h.remove());
  const header = pane.querySelector('.pane-header');
  if (header) header.classList.remove('pane-header-draggable');
}

function toggleLayoutMode() {
  const grid = document.getElementById('pane-grid');

  if (layoutMode === 'auto') {
    // Snapshot current positions before switching
    snapshotCurrentPositions();
    layoutMode = 'freeform';
  } else {
    layoutMode = 'auto';
    // Clear freeform rects so auto layout takes over
    sessions.forEach(s => { s.pane.style.cssText = ''; });
  }

  updateGridLayout();
  updateLayoutToggleUI();
  saveSessionState();
}

function toggleSnapToGrid() {
  snapToGrid = !snapToGrid;
  updateLayoutToggleUI();
  saveSessionState();
}

function updateLayoutToggleUI() {
  const toggle = document.getElementById('toolbar-layout-toggle');
  if (!toggle) return;

  const autoBtn = toggle.querySelector('[data-mode="auto"]');
  const freeBtn = toggle.querySelector('[data-mode="freeform"]');
  const snapBtn = toggle.querySelector('[data-mode="snap"]');
  const divider = toggle.querySelector('.mode-divider');

  if (autoBtn) autoBtn.classList.toggle('active', layoutMode === 'auto');
  if (freeBtn) freeBtn.classList.toggle('active', layoutMode === 'freeform');
  if (divider) divider.style.display = layoutMode === 'freeform' ? '' : 'none';
  if (snapBtn) {
    snapBtn.style.display = layoutMode === 'freeform' ? '' : 'none';
    snapBtn.classList.toggle('active', snapToGrid);
  }
}

function createLayoutToggle() {
  const container = document.getElementById('toolbar-layout-toggle');
  if (!container) return;

  // SVG icons for each mode
  const gridSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="9.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/></svg>';
  const freeSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="7" height="6" rx="1"/><rect x="6" y="8" width="9" height="6" rx="1"/></svg>';
  const snapSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 4V1h3M13 1h2v3M1 12v3h3M15 13v2h-2"/><rect x="4" y="4" width="8" height="8" rx="1" stroke-dasharray="2 1.5"/></svg>';

  const autoBtn = document.createElement('button');
  autoBtn.className = 'mode-btn';
  autoBtn.dataset.mode = 'auto';
  autoBtn.innerHTML = gridSvg + '<span class="mode-label">Grid</span>';
  autoBtn.title = 'Auto grid layout (\u2318\u21E7G)';
  autoBtn.addEventListener('click', () => {
    if (layoutMode !== 'auto') toggleLayoutMode();
  });

  const freeBtn = document.createElement('button');
  freeBtn.className = 'mode-btn';
  freeBtn.dataset.mode = 'freeform';
  freeBtn.innerHTML = freeSvg + '<span class="mode-label">Free</span>';
  freeBtn.title = 'Free-form layout (\u2318\u21E7G)';
  freeBtn.addEventListener('click', () => {
    if (layoutMode !== 'freeform') toggleLayoutMode();
  });

  const divider = document.createElement('div');
  divider.className = 'mode-divider';

  const snapBtn = document.createElement('button');
  snapBtn.className = 'mode-btn';
  snapBtn.dataset.mode = 'snap';
  snapBtn.innerHTML = snapSvg + '<span class="mode-label">Snap</span>';
  snapBtn.title = 'Snap to grid when dragging';
  snapBtn.style.display = 'none';
  snapBtn.addEventListener('click', () => toggleSnapToGrid());

  container.appendChild(autoBtn);
  container.appendChild(freeBtn);
  container.appendChild(divider);
  container.appendChild(snapBtn);

  // Set initial active state
  updateLayoutToggleUI();
}

function setupFreeformDrag() {
  let dragging = null;
  let snapPreview = null;
  const SNAP_EDGE = 8; // px from edge to trigger snap zone

  function getSnapZone(x, y, gridRect, r) {
    // Returns a snap zone descriptor or null
    if (x <= SNAP_EDGE) {
      return { zone: 'left', x: 0, y: 0, width: gridRect.width / 2, height: gridRect.height };
    }
    if (x + r.width >= gridRect.width - SNAP_EDGE) {
      return { zone: 'right', x: gridRect.width / 2, y: 0, width: gridRect.width / 2, height: gridRect.height };
    }
    if (y <= SNAP_EDGE) {
      return { zone: 'top', x: 0, y: 0, width: gridRect.width, height: gridRect.height / 2 };
    }
    if (y + r.height >= gridRect.height - SNAP_EDGE) {
      return { zone: 'bottom', x: 0, y: gridRect.height / 2, width: gridRect.width, height: gridRect.height / 2 };
    }
    return null;
  }

  function showSnapPreview(snap, grid) {
    if (!snapPreview) {
      snapPreview = document.createElement('div');
      snapPreview.className = 'snap-preview';
      grid.appendChild(snapPreview);
    }
    snapPreview.style.left = snap.x + 'px';
    snapPreview.style.top = snap.y + 'px';
    snapPreview.style.width = snap.width + 'px';
    snapPreview.style.height = snap.height + 'px';
    snapPreview.style.display = '';
  }

  function hideSnapPreview() {
    if (snapPreview) {
      snapPreview.style.display = 'none';
    }
  }

  document.addEventListener('mousedown', (e) => {
    if (layoutMode !== 'freeform') return;
    if (maximizedIndex !== null) return;

    const header = e.target.closest('.pane-header-draggable');
    if (!header) return;
    if (e.target.closest('button')) return;

    const pane = header.closest('.pane');
    const session = sessions.find(s => s.pane === pane);
    if (!session || !session.freeformRect) return;

    e.preventDefault();
    dragging = {
      session,
      startX: e.clientX,
      startY: e.clientY,
      origX: session.freeformRect.x,
      origY: session.freeformRect.y,
      origWidth: session.freeformRect.width,
      origHeight: session.freeformRect.height,
      snapZone: null,
    };

    freeformZCounter++;
    pane.style.zIndex = freeformZCounter;
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    const r = dragging.session.freeformRect;
    const grid = document.getElementById('pane-grid');
    const gridRect = grid.getBoundingClientRect();

    let newX = snapValue(dragging.origX + dx);
    let newY = snapValue(dragging.origY + dy);

    newX = Math.max(0, Math.min(newX, gridRect.width - r.width));
    newY = Math.max(0, Math.min(newY, gridRect.height - r.height));

    r.x = newX;
    r.y = newY;
    dragging.session.pane.style.left = r.x + 'px';
    dragging.session.pane.style.top = r.y + 'px';

    // Check snap zones
    const snap = getSnapZone(newX, newY, gridRect, r);
    dragging.snapZone = snap;
    if (snap) {
      showSnapPreview(snap, grid);
    } else {
      hideSnapPreview();
    }
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;

    // Apply snap zone if active
    if (dragging.snapZone) {
      const snap = dragging.snapZone;
      const r = dragging.session.freeformRect;
      const PAD = 4;
      r.x = snap.x + PAD;
      r.y = snap.y + PAD;
      r.width = snap.width - PAD * 2;
      r.height = snap.height - PAD * 2;
      const pane = dragging.session.pane;
      pane.style.left = r.x + 'px';
      pane.style.top = r.y + 'px';
      pane.style.width = r.width + 'px';
      pane.style.height = r.height + 'px';
    }

    hideSnapPreview();
    fitVisibleTerminals();
    saveSessionState();
    dragging = null;
  });
}

function findAdjacentPanes(session, direction) {
  // Find panes whose edges are close to this pane's resize edge
  const r = session.freeformRect;
  const PROXIMITY = 20;
  const neighbors = [];

  sessions.forEach(s => {
    if (s === session || s.minimized || !s.freeformRect) return;
    const sr = s.freeformRect;

    if (direction.includes('e')) {
      // Right edge of session near left edge of neighbor
      if (Math.abs((r.x + r.width) - sr.x) < PROXIMITY) {
        // Vertically overlapping
        if (r.y < sr.y + sr.height && r.y + r.height > sr.y) {
          neighbors.push({ session: s, axis: 'h', origX: sr.x, origWidth: sr.width });
        }
      }
    }
    if (direction.includes('s')) {
      // Bottom edge of session near top edge of neighbor
      if (Math.abs((r.y + r.height) - sr.y) < PROXIMITY) {
        // Horizontally overlapping
        if (r.x < sr.x + sr.width && r.x + r.width > sr.x) {
          neighbors.push({ session: s, axis: 'v', origY: sr.y, origHeight: sr.height });
        }
      }
    }
  });
  return neighbors;
}

function setupFreeformResize() {
  let resizing = null;

  document.addEventListener('mousedown', (e) => {
    if (layoutMode !== 'freeform') return;

    const handle = e.target.closest('.pane-resize-handle');
    if (!handle) return;

    const pane = handle.closest('.pane');
    const session = sessions.find(s => s.pane === pane);
    if (!session || !session.freeformRect) return;

    e.preventDefault();
    const r = session.freeformRect;
    const dir = handle.dataset.direction;

    resizing = {
      session,
      direction: dir,
      startX: e.clientX,
      startY: e.clientY,
      origWidth: r.width,
      origHeight: r.height,
      origX: r.x,
      origY: r.y,
      neighbors: findAdjacentPanes(session, dir),
    };

    freeformZCounter++;
    pane.style.zIndex = freeformZCounter;
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - resizing.startX;
    const dy = e.clientY - resizing.startY;
    const r = resizing.session.freeformRect;
    const dir = resizing.direction;
    const grid = document.getElementById('pane-grid');
    const gridRect = grid.getBoundingClientRect();

    if (dir.includes('e')) {
      const maxW = gridRect.width - r.x;
      const newW = Math.max(PANE_MIN_WIDTH, Math.min(maxW, snapValue(resizing.origWidth + dx)));
      const delta = newW - resizing.origWidth;
      r.width = newW;

      // Push adjacent panes
      resizing.neighbors.forEach(n => {
        if (n.axis === 'h') {
          const nr = n.session.freeformRect;
          nr.x = n.origX + delta;
          nr.width = Math.max(PANE_MIN_WIDTH, n.origWidth - delta);
          n.session.pane.style.left = nr.x + 'px';
          n.session.pane.style.width = nr.width + 'px';
        }
      });
    }
    if (dir.includes('s')) {
      const maxH = gridRect.height - r.y;
      const newH = Math.max(PANE_MIN_HEIGHT, Math.min(maxH, snapValue(resizing.origHeight + dy)));
      const delta = newH - resizing.origHeight;
      r.height = newH;

      // Push adjacent panes
      resizing.neighbors.forEach(n => {
        if (n.axis === 'v') {
          const nr = n.session.freeformRect;
          nr.y = n.origY + delta;
          nr.height = Math.max(PANE_MIN_HEIGHT, n.origHeight - delta);
          n.session.pane.style.top = nr.y + 'px';
          n.session.pane.style.height = nr.height + 'px';
        }
      });
    }

    resizing.session.pane.style.width = r.width + 'px';
    resizing.session.pane.style.height = r.height + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    // Refit all affected terminals
    resizing.session.terminal.fit();
    resizing.neighbors.forEach(n => n.session.terminal.fit());
    saveSessionState();
    resizing = null;
  });
}

const fitVisibleTerminals = throttle(function() {
  if (maximizedIndex !== null && maximizedIndex < sessions.length) {
    sessions[maximizedIndex].terminal.fit();
  } else {
    sessions.filter(s => !s.minimized).forEach(s => s.terminal.fit());
  }
}, 50);

// --- Focus ---

function setFocus(index) {
  if (index < 0 || index >= sessions.length) return;
  if (sessions[index].minimized) return;

  // If a different pane is maximized, switch maximize to the new target
  if (maximizedIndex !== null && maximizedIndex !== index) {
    maximizedIndex = index;
    // Update maximize button icons
    sessions.forEach((s, i) => {
      const btn = s.pane.querySelector('.pane-maximize-btn');
      if (btn) {
        btn.innerHTML = (maximizedIndex === i) ? '\u29C9' : '\u25A1';
        btn.title = (maximizedIndex === i) ? 'Restore (\u2318\u21E7Enter)' : 'Maximize (\u2318\u21E7Enter)';
      }
    });
    updateGridLayout();
  }

  focusedIndex = index;

  sessions.forEach((s, i) => {
    s.pane.classList.toggle('focused', i === index);
    // Dismiss notification ring on the newly focused pane
    if (i === index) {
      s.pane.classList.remove('notify-ring');
    }
  });

  // Z-index management in freeform mode
  if (layoutMode === 'freeform') {
    freeformZCounter++;
    sessions[index].pane.style.zIndex = freeformZCounter;
  }

  document.querySelectorAll('.session-card').forEach((c, i) => {
    c.classList.toggle('active', i === index);
    if (i === index) c.classList.remove('notify-badge');
  });

  sessions[index].terminal.focus();
  updateGitInfo();
  updateMascot(sessions[index].status || 'Idle', Math.random() > 0.2);
  updateFileViewerCwd(sessions[index].cwd);
  setFocusedCwd(sessions[index].cwd);
}

function navigateDirection(direction) {
  if (sessions.length <= 1) return;
  if (maximizedIndex !== null) return;

  const visible = sessions.filter(s => !s.minimized);
  if (visible.length <= 1) return;

  const current = sessions[focusedIndex];
  if (!current) return;

  const currentRect = current.pane.getBoundingClientRect();
  const cx = currentRect.left + currentRect.width / 2;
  const cy = currentRect.top + currentRect.height / 2;

  let bestIdx = -1;
  let bestDist = Infinity;

  for (let i = 0; i < sessions.length; i++) {
    if (i === focusedIndex || sessions[i].minimized) continue;

    const rect = sessions[i].pane.getBoundingClientRect();
    const px = rect.left + rect.width / 2;
    const py = rect.top + rect.height / 2;
    const dx = px - cx;
    const dy = py - cy;

    // Check if this pane is in the correct direction
    let valid = false;
    switch (direction) {
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10;  break;
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10;  break;
    }
    if (!valid) continue;

    // Use weighted distance: primary axis is more important
    let dist;
    if (direction === 'up' || direction === 'down') {
      dist = Math.abs(dy) + Math.abs(dx) * 2; // Penalize off-axis
    } else {
      dist = Math.abs(dx) + Math.abs(dy) * 2;
    }

    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  if (bestIdx >= 0) {
    setFocus(bestIdx);
  }
}

function focusNextVisible(fromIndex, direction) {
  if (sessions.length === 0) return;
  const len = sessions.length;
  for (let i = 1; i <= len; i++) {
    const idx = (fromIndex + direction * i + len) % len;
    if (!sessions[idx].minimized) {
      setFocus(idx);
      return;
    }
  }
}

// --- Pane Creation ---

function createPane(name) {
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.dataset.status = 'Idle';

  const header = document.createElement('div');
  header.className = 'pane-header';

  const statusDot = document.createElement('span');
  statusDot.className = 'status-dot';
  statusDot.style.background = 'var(--status-idle)';

  const title = document.createElement('span');
  title.className = 'pane-title';
  title.textContent = name;

  const controls = document.createElement('span');
  controls.className = 'pane-controls';

  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'pane-minimize-btn';
  minimizeBtn.innerHTML = '\u2013'; // en dash
  minimizeBtn.title = `Minimize (${modSymbol}M)`;
  minimizeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const idx = sessions.findIndex(s => s.pane === pane);
    if (idx >= 0) minimizeSession(idx);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'pane-close-btn';
  closeBtn.innerHTML = '\u00d7';
  closeBtn.title = `Close (${modSymbol}W)`;
  closeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const idx = sessions.findIndex(s => s.pane === pane);
    if (idx >= 0) removeSession(idx);
  });

  const maximizeBtn = document.createElement('button');
  maximizeBtn.className = 'pane-maximize-btn';
  maximizeBtn.innerHTML = '\u25A1'; // □ square
  maximizeBtn.title = `Maximize (${modShiftSymbol}Enter)`;
  maximizeBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const idx = sessions.findIndex(s => s.pane === pane);
    if (idx >= 0) toggleMaximize(idx);
  });

  controls.appendChild(minimizeBtn);
  controls.appendChild(maximizeBtn);
  controls.appendChild(closeBtn);
  header.appendChild(statusDot);
  header.appendChild(title);
  header.appendChild(controls);

  // Double-click header to maximize/restore
  header.addEventListener('dblclick', () => {
    const idx = sessions.findIndex(s => s.pane === pane);
    if (idx >= 0) toggleMaximize(idx);
  });

  const body = document.createElement('div');
  body.className = 'pane-body';

  // Edge resize zones (for grid gutter interaction)
  const edgeRight = document.createElement('div');
  edgeRight.className = 'pane-edge pane-edge-right';
  const edgeBottom = document.createElement('div');
  edgeBottom.className = 'pane-edge pane-edge-bottom';
  const edgeCorner = document.createElement('div');
  edgeCorner.className = 'pane-edge pane-edge-corner';

  pane.appendChild(header);
  pane.appendChild(body);
  pane.appendChild(edgeRight);
  pane.appendChild(edgeBottom);
  pane.appendChild(edgeCorner);

  // Click to focus
  pane.addEventListener('mousedown', () => {
    const idx = sessions.findIndex(s => s.pane === pane);
    if (idx >= 0) setFocus(idx);
  });

  return { pane, body, statusDot, title };
}

// --- Session Lifecycle ---

async function createSession(restoreCwd, restoreScrollback) {
  const sessionName = `Terminal ${nextTerminalNumber()}`;

  // Cap at 6 visible — auto-minimize oldest visible if needed
  const visibleCount = sessions.filter(s => !s.minimized).length;
  if (visibleCount >= 6) {
    const oldestVisible = sessions.findIndex(s => !s.minimized);
    if (oldestVisible >= 0) {
      sessions[oldestVisible].minimized = true;
    }
  }

  const { pane, body, statusDot, title } = createPane(sessionName);

  const terminal = new TerminalSession(body);
  terminal.open();

  const effectiveCwd = restoreCwd || localStorage.getItem('ps-default-dir') || null;

  // Restore scrollback content before connecting PTY
  if (restoreScrollback) {
    terminal.restoreScrollback(restoreScrollback);
  }

  const sessionId = await terminal.connect(effectiveCwd);

  // Watch for /rename command output from Claude Code
  terminal.onOutput((chunk, buffer) => {
    // Claude Code /rename outputs the new conversation name
    // Look for patterns like "Renamed conversation to: xxx" or similar
    const renameMatch = buffer.match(/(?:Renamed (?:conversation )?to|Session renamed to)[:\s]+["']?([^\n"']+?)["']?\s*$/);
    if (renameMatch) {
      const newName = renameMatch[1].trim();
      if (newName && newName !== session.name) {
        session.name = newName;
        session.pane.querySelector('.pane-title').textContent = newName;
        rebuildSidebar();
        updateFooterPills();
        saveSessionState();
        terminal._outputBuffer = ''; // Clear to avoid re-matching
      }
    }
  });

  const session = {
    id: sessionId,
    name: sessionName,
    terminal,
    pane,
    statusDot,
    minimized: false,
    cwd: effectiveCwd || null,
    freeformRect: null,
  };

  // Refit terminal whenever the pane body actually changes size (e.g. grid gutter drags)
  const paneResizeObserver = new ResizeObserver(() => {
    if (!session.minimized) terminal.fit();
  });
  paneResizeObserver.observe(body);
  session._resizeObserver = paneResizeObserver;

  sessions.push(session);
  rebuildSidebar();

  // Exit maximize mode when adding a new session
  maximizedIndex = null;

  updateGridLayout();
  updateFooterPills();
  saveSessionState();

  requestAnimationFrame(() => {
    setFocus(sessions.length - 1);
  });

  return session;
}

async function removeSession(index) {
  if (index < 0 || index >= sessions.length) return;

  const session = sessions[index];

  // Handle maximize state
  if (maximizedIndex === index) {
    maximizedIndex = null;
  } else if (maximizedIndex !== null && maximizedIndex > index) {
    maximizedIndex--;
  }

  // Save session info for undo-close (Ctrl+Shift+Z)
  try {
    const scrollback = session.terminal.getScrollback(500);
    const cleanBuffer = (session.terminal._outputBuffer || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const wasClaude = cleanBuffer.includes('Claude Code') || cleanBuffer.includes('Total cost:') || cleanBuffer.includes('claude-opus') || cleanBuffer.includes('claude-sonnet');
    closedSessionStack.push({
      name: session.name,
      cwd: session.cwd,
      scrollback,
      wasClaude,
      closedAt: Date.now(),
    });
    if (closedSessionStack.length > MAX_CLOSED_SESSIONS) closedSessionStack.shift();
  } catch {}

  if (session._resizeObserver) session._resizeObserver.disconnect();
  await session.terminal.destroy();
  if (session.pane.parentNode) session.pane.remove();
  sessions.splice(index, 1);

  rebuildSidebar();
  updateGridLayout();
  updateFooterPills();
  updateGitInfo();
  saveSessionState();

  if (sessions.length > 0) {
    // Find nearest visible session for focus
    let target = Math.min(index, sessions.length - 1);
    if (sessions[target].minimized) {
      target = sessions.findIndex(s => !s.minimized);
      if (target < 0) {
        // All remaining minimized — restore the first one
        sessions[0].minimized = false;
        target = 0;
        updateGridLayout();
        updateFooterPills();
      }
    }
    requestAnimationFrame(() => setFocus(target));
  }
}

async function reopenLastClosed() {
  if (closedSessionStack.length === 0) return;
  const closed = closedSessionStack.pop();
  await createSession(closed.cwd, closed.scrollback);
  // Rename the new session to the old name
  const newSession = sessions[sessions.length - 1];
  if (newSession && closed.name) {
    newSession.name = closed.name;
    newSession.pane.querySelector('.pane-title').textContent = closed.name;
    rebuildSidebar();
    updateFooterPills();
  }
  setFocus(sessions.length - 1);
  // Auto-resume Claude Code session (--resume picks up the most recent conversation)
  if (closed.wasClaude && newSession) {
    setTimeout(() => {
      const encoder = new TextEncoder();
      invoke('write_to_pty', {
        sessionId: newSession.id,
        data: Array.from(encoder.encode('claude --resume\n')),
      });
    }, 500);
  }
}

// --- Minimize / Restore / Maximize ---

function minimizeSession(index) {
  if (index < 0 || index >= sessions.length) return;

  sessions[index].minimized = true;

  // Exit maximize mode if minimizing the maximized session
  if (maximizedIndex === index) {
    maximizedIndex = null;
  }

  // Move focus to next visible, or leave unfocused if all minimized
  if (focusedIndex === index) {
    const nextVisible = sessions.findIndex((s, i) => i !== index && !s.minimized);
    if (nextVisible >= 0) {
      focusNextVisible(index, 1);
    }
  }

  rebuildSidebar();
  updateGridLayout();
  updateFooterPills();
  saveSessionState();
}

function restoreSession(index) {
  if (index < 0 || index >= sessions.length) return;
  sessions[index].minimized = false;

  // Exit maximize mode when restoring
  maximizedIndex = null;

  rebuildSidebar();
  updateGridLayout();
  updateFooterPills();
  setFocus(index);
  saveSessionState();
}

function toggleMaximize(index) {
  if (index < 0 || index >= sessions.length) return;

  if (maximizedIndex === index) {
    maximizedIndex = null;
  } else {
    sessions[index].minimized = false;
    maximizedIndex = index;
  }

  // Update all maximize button icons
  sessions.forEach((s, i) => {
    const btn = s.pane.querySelector('.pane-maximize-btn');
    if (btn) {
      btn.innerHTML = (maximizedIndex === i) ? '\u29C9' : '\u25A1'; // ⧉ vs □
      btn.title = (maximizedIndex === i) ? `Restore (${modShiftSymbol}Enter)` : `Maximize (${modShiftSymbol}Enter)`;
    }
  });

  updateGridLayout();
  updateFooterPills();
  setFocus(index);
  saveSessionState();
}

// --- Footer Pills ---

function restoreAllSessions() {
  sessions.forEach(s => { s.minimized = false; });
  maximizedIndex = null;
  rebuildSidebar();
  updateGridLayout();
  updateFooterPills();
  saveSessionState();
}

function updateFooterPills() {
  const container = document.getElementById('footer-pills');
  const footer = document.getElementById('footer');
  const robot = document.getElementById('robot-overlay');
  container.innerHTML = '';

  const minimized = sessions.filter(s => s.minimized);

  if (minimized.length > 0) {
    // Count label
    const countLabel = document.createElement('span');
    countLabel.className = 'minimized-count';
    countLabel.textContent = `${minimized.length} minimized`;
    container.appendChild(countLabel);
  }

  minimized.forEach((s) => {
    const i = sessions.indexOf(s);
    const pill = document.createElement('button');
    pill.className = 'footer-pill';
    // Status-colored left border
    if (s.statusDot.style.background) {
      pill.style.borderLeftColor = s.statusDot.style.background;
    }

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    dot.style.background = s.statusDot.style.background;

    const name = document.createElement('span');
    name.textContent = s.name;

    const restore = document.createElement('span');
    restore.className = 'pill-restore';
    restore.textContent = '\u2191';

    pill.appendChild(dot);
    pill.appendChild(name);
    pill.appendChild(restore);
    pill.title = `Restore ${s.name}`;
    pill.addEventListener('click', () => restoreSession(i));

    container.appendChild(pill);
  });

  // Restore all button when multiple minimized
  if (minimized.length > 1) {
    const restoreAll = document.createElement('button');
    restoreAll.className = 'restore-all-btn';
    restoreAll.textContent = 'Restore all';
    restoreAll.addEventListener('click', () => restoreAllSessions());
    container.appendChild(restoreAll);
  }

  // Collapse footer only when no pills AND no git info
  updateFooterVisibility();
}

function updateFooterVisibility() {
  const footer = document.getElementById('footer');
  const robot = document.getElementById('robot-overlay');
  const hasGit = !!document.getElementById('footer-git')?.textContent;
  const hasPills = sessions.some(s => s.minimized);
  const isExpanded = footer.classList.contains('expanded');
  const isEmpty = !hasGit && !hasPills && !isExpanded;
  footer.classList.toggle('empty', isEmpty);
  if (robot) {
    if (isExpanded) {
      const footerEl = document.getElementById('footer');
      robot.style.bottom = footerEl.getBoundingClientRect().height + 'px';
    } else {
      robot.style.bottom = isEmpty ? '0' : 'var(--footer-height)';
    }
  }
}

// --- Sidebar ---

function rebuildSidebar() {
  const list = document.getElementById('session-list');
  list.innerHTML = '';
  sessions.forEach((s, i) => addSessionToSidebar(s.name, i, s.minimized));
}

function addSessionToSidebar(name, index, minimized) {
  const list = document.getElementById('session-list');

  const card = document.createElement('div');
  card.className = 'session-card';
  if (minimized) card.classList.add('minimized-card');
  if (index === focusedIndex) card.classList.add('active');
  card.dataset.index = index;
  card.dataset.status = sessions[index]?.status || 'Idle';
  card.draggable = true;

  const dot = document.createElement('span');
  dot.className = 'status-dot';
  dot.style.background = sessions[index]
    ? sessions[index].statusDot.style.background
    : 'var(--status-idle)';

  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = name;

  // Metadata container (CWD, ports, PR)
  const meta = document.createElement('div');
  meta.className = 'session-meta';
  meta.appendChild(nameEl);

  // CWD row
  const session = sessions[index];
  if (session?.cwd) {
    const cwdRow = document.createElement('div');
    cwdRow.className = 'session-meta-row session-cwd';
    cwdRow.textContent = shortenCwd(session.cwd);
    cwdRow.title = session.cwd;
    meta.appendChild(cwdRow);
  }

  // Ports row (populated async)
  const portsRow = document.createElement('div');
  portsRow.className = 'session-meta-row session-ports';
  portsRow.style.display = 'none';
  meta.appendChild(portsRow);

  // PR status row (populated async)
  const prRow = document.createElement('div');
  prRow.className = 'session-meta-row session-pr';
  prRow.style.display = 'none';
  meta.appendChild(prRow);

  // Shortcut badge
  const shortcut = document.createElement('span');
  shortcut.className = 'session-shortcut';
  if (index < 9) {
    shortcut.textContent = isMac ? `\u2318${index + 1}` : `^${index + 1}`;
  }

  const badge = document.createElement('span');
  badge.className = 'session-badge';
  badge.textContent = index + 1;

  card.appendChild(dot);
  card.appendChild(meta);
  card.appendChild(shortcut);
  card.appendChild(badge);

  // Click to focus
  card.addEventListener('click', () => {
    if (isAnyPanelActive()) hidePanel();
    const idx = parseInt(card.dataset.index);
    if (sessions[idx].minimized) {
      restoreSession(idx);
    } else {
      setFocus(idx);
    }
  });

  // Double-click to rename
  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    promptRename(parseInt(card.dataset.index));
  });

  // Right-click context menu
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, parseInt(card.dataset.index));
  });

  // Drag-and-drop reordering
  card.addEventListener('dragstart', (e) => {
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.index);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.session-card').forEach(c => c.classList.remove('drag-over'));
  });

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });

  card.addEventListener('dragleave', () => {
    card.classList.remove('drag-over');
  });

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
    const toIdx = parseInt(card.dataset.index);
    if (fromIdx !== toIdx) {
      reorderSession(fromIdx, toIdx);
    }
  });

  list.appendChild(card);
}

function reorderSession(fromIdx, toIdx) {
  const [session] = sessions.splice(fromIdx, 1);
  sessions.splice(toIdx, 0, session);

  // Adjust focusedIndex
  if (focusedIndex === fromIdx) {
    focusedIndex = toIdx;
  } else if (fromIdx < focusedIndex && toIdx >= focusedIndex) {
    focusedIndex--;
  } else if (fromIdx > focusedIndex && toIdx <= focusedIndex) {
    focusedIndex++;
  }

  // Adjust maximizedIndex
  if (maximizedIndex !== null) {
    if (maximizedIndex === fromIdx) {
      maximizedIndex = toIdx;
    } else if (fromIdx < maximizedIndex && toIdx >= maximizedIndex) {
      maximizedIndex--;
    } else if (fromIdx > maximizedIndex && toIdx <= maximizedIndex) {
      maximizedIndex++;
    }
  }

  rebuildSidebar();
  updateGridLayout();
  updateFooterPills();
  saveSessionState();
}

function updateSidebarMeta() {
  const cards = document.querySelectorAll('.session-card');
  sessions.forEach((s, i) => {
    const card = cards[i];
    if (!card) return;

    // Update CWD
    const cwdEl = card.querySelector('.session-cwd');
    if (cwdEl && s.cwd) {
      cwdEl.textContent = shortenCwd(s.cwd);
      cwdEl.title = s.cwd;
      cwdEl.style.display = '';
    } else if (cwdEl) {
      cwdEl.style.display = 'none';
    }

    // Update ports (skip DOM work if unchanged)
    const portsEl = card.querySelector('.session-ports');
    if (portsEl) {
      const ports = s._ports || [];
      const portsKey = ports.join(',');
      if (ports.length > 0) {
        if (portsEl.dataset.ports !== portsKey) {
          portsEl.dataset.ports = portsKey;
          portsEl.textContent = '';
          ports.forEach(p => {
            const badge = document.createElement('span');
            badge.className = 'session-port-badge';
            badge.textContent = ':' + p;
            portsEl.appendChild(badge);
          });
        }
        portsEl.style.display = '';
      } else {
        if (portsEl.dataset.ports) {
          portsEl.dataset.ports = '';
          portsEl.textContent = '';
        }
        portsEl.style.display = 'none';
      }
    }

    // Update PR status (skip DOM work if unchanged)
    const prEl = card.querySelector('.session-pr');
    if (prEl) {
      const pr = s._pr;
      const prKey = pr ? `${pr.number}-${pr.state}` : '';
      if (prEl.dataset.prKey !== prKey) {
        prEl.dataset.prKey = prKey;
        if (pr) {
          const state = pr.state || '';
          const num = pr.number || '';
          const cls = state === 'MERGED' ? 'pr-merged' : state === 'CLOSED' ? 'pr-closed' : '';
          prEl.textContent = '';
          const badge = document.createElement('span');
          badge.className = 'session-pr-badge ' + cls;
          badge.textContent = '#' + num + ' ' + state.toLowerCase();
          prEl.appendChild(badge);
        } else {
          prEl.textContent = '';
        }
      }
      prEl.style.display = pr ? '' : 'none';
    }
  });
}

// --- New Session ---

function setupNewSessionButton() {
  document.getElementById('new-session-btn').addEventListener('click', () => {
    createSession();
  });
}

// --- Context Menu ---

function showContextMenu(x, y, sessionIndex) {
  hideContextMenu();

  contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu';
  contextMenu.innerHTML = `
    <div class="context-item" data-action="rename">Rename</div>
    <div class="context-item" data-action="minimize">Minimize</div>
    <div class="context-item" data-action="close">Close</div>
  `;

  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
  document.body.appendChild(contextMenu);

  contextMenu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action === 'rename') promptRename(sessionIndex);
    else if (action === 'minimize') minimizeSession(sessionIndex);
    else if (action === 'close') removeSession(sessionIndex);
    hideContextMenu();
  });

  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
  }, 0);
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
}

function promptRename(index) {
  const session = sessions[index];
  const cards = document.querySelectorAll('.session-card');
  if (!cards[index]) return;

  const nameEl = cards[index].querySelector('.session-name');

  const input = document.createElement('input');
  input.className = 'form-input';
  input.value = session.name;
  input.style.width = '100%';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim() || session.name;
    session.name = newName;

    const span = document.createElement('span');
    span.className = 'session-name';
    span.textContent = newName;
    input.replaceWith(span);

    // Update pane header
    session.pane.querySelector('.pane-title').textContent = newName;
    updateFooterPills();
    saveSessionState();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); e.preventDefault(); }
    if (e.key === 'Escape') { input.value = session.name; commit(); }
  });
}

// --- Git Info ---

let _gitInfoRunning = false;
async function updateGitInfo() {
  if (_gitInfoRunning) return;
  _gitInfoRunning = true;
  try {
    const el = document.getElementById('footer-git');
    if (sessions.length === 0 || focusedIndex >= sessions.length) {
      el.textContent = '';
      el.dataset.branch = '';
      return;
    }

    const session = sessions[focusedIndex];
    const cwd = session.cwd;
    if (!cwd) {
      // No CWD tracked — can't detect git info
      el.textContent = '';
      el.dataset.branch = '';
      return;
    }

    try {
      const showBranch = localStorage.getItem('ps-git-show-branch') !== 'false';
      const showWorktree = localStorage.getItem('ps-git-show-worktree') !== 'false';

      if (!showBranch) {
        el.textContent = '';
        el.dataset.branch = '';
        return;
      }

      const summary = await invoke('get_git_info', { cwd });
      if (!summary) {
        el.textContent = '';
        el.dataset.branch = '';
        return;
      }

      let text = `git: ${summary.info.branch}`;
      if (summary.info.is_worktree) {
        text += ' (worktree)';
      }
      if (showWorktree && summary.active_worktree_count > 0) {
        text += ` | worktrees: ${summary.active_worktree_count}`;
      }

      el.textContent = text;
      el.dataset.branch = summary.info.branch;

      // Show chevron when git info is available
      document.getElementById('footer-expand-toggle').style.display = '';
    } catch {
      el.textContent = '';
      el.dataset.branch = '';
      document.getElementById('footer-expand-toggle').style.display = 'none';
    }
    updateFooterVisibility();
  } finally {
    _gitInfoRunning = false;
  }
}

function setupGitInfoClick() {
  document.getElementById('footer-git').addEventListener('click', () => {
    const branch = document.getElementById('footer-git').dataset.branch;
    if (branch) {
      navigator.clipboard.writeText(branch);
      const el = document.getElementById('footer-git');
      const original = el.textContent;
      el.textContent = 'Copied!';
      setTimeout(() => { el.textContent = original; }, 1000);
    }
  });
}

// --- Footer Expand / Branch Graph ---

let branchGraphCache = null;
let footerExpandedHeight = null; // user-dragged height, persisted in localStorage

function setupFooterExpand() {
  document.getElementById('footer-expand-toggle').addEventListener('click', toggleFooterExpand);
  setupFooterResize();

  // Restore saved height
  const saved = localStorage.getItem('ps-footer-expanded-height');
  if (saved) footerExpandedHeight = parseInt(saved, 10);
}

function setupFooterResize() {
  const footer = document.getElementById('footer');
  const handle = document.getElementById('footer-resize-handle');
  if (!handle) return;

  let startY, startHeight;

  handle.addEventListener('mousedown', (e) => {
    if (!footer.classList.contains('expanded')) return;
    e.preventDefault();
    startY = e.clientY;
    startHeight = footer.getBoundingClientRect().height;
    handle.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const delta = startY - e.clientY; // dragging up = positive
      const minH = 60;
      const maxH = Math.floor(window.innerHeight * 0.6);
      const newHeight = Math.max(minH, Math.min(maxH, startHeight + delta));
      footer.style.height = newHeight + 'px';
      footer.style.minHeight = newHeight + 'px';
      footerExpandedHeight = newHeight;
      updateFooterVisibility();
      fitVisibleTerminals();
    }

    function onUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (footerExpandedHeight) {
        localStorage.setItem('ps-footer-expanded-height', String(footerExpandedHeight));
      }
      fitVisibleTerminals();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

async function toggleFooterExpand() {
  const footer = document.getElementById('footer');
  const graph = document.getElementById('footer-branch-graph');
  const isExpanded = footer.classList.contains('expanded');

  if (isExpanded) {
    footer.classList.remove('expanded');
    footer.style.height = '';
    footer.style.minHeight = '';
    graph.style.display = 'none';
    graph.innerHTML = '';
    branchGraphCache = null;
    updateFooterVisibility();
    fitVisibleTerminals();
    return;
  }

  // Expand and fetch data
  footer.classList.add('expanded');
  if (footerExpandedHeight) {
    footer.style.height = footerExpandedHeight + 'px';
    footer.style.minHeight = footerExpandedHeight + 'px';
  }
  graph.style.display = '';
  graph.innerHTML = '<span class="branch-graph-loading">Loading...</span>';
  updateFooterVisibility();
  fitVisibleTerminals();

  try {
    const session = sessions[focusedIndex];
    if (!session?.cwd) return;
    const data = await invoke('get_branch_graph', { cwd: session.cwd });
    if (!data) {
      graph.innerHTML = '<span class="branch-graph-empty">Not a git repository</span>';
      return;
    }
    branchGraphCache = data;
    renderBranchGraph(data, data.branches.find(b => b.is_current)?.name);
  } catch {
    graph.innerHTML = '<span class="branch-graph-empty">Failed to load branch data</span>';
  }
}

function renderBranchGraph(data, selectedBranch) {
  const graph = document.getElementById('footer-branch-graph');
  graph.innerHTML = '';

  // Left: branch list
  const branchList = document.createElement('div');
  branchList.className = 'branch-list';

  for (const branch of data.branches) {
    const node = document.createElement('div');
    node.className = 'branch-node' + (branch.name === selectedBranch ? ' current' : '');

    const dot = document.createElement('span');
    dot.className = 'branch-dot';

    const label = document.createElement('span');
    label.className = 'branch-label';
    label.textContent = branch.name;

    const badges = document.createElement('span');
    badges.className = 'branch-badges';
    if (branch.ahead > 0) {
      const ahead = document.createElement('span');
      ahead.className = 'branch-badge badge-ahead';
      ahead.textContent = `+${branch.ahead}`;
      badges.appendChild(ahead);
    }
    if (branch.behind > 0) {
      const behind = document.createElement('span');
      behind.className = 'branch-badge badge-behind';
      behind.textContent = `-${branch.behind}`;
      badges.appendChild(behind);
    }

    node.appendChild(dot);
    node.appendChild(label);
    node.appendChild(badges);

    node.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Fetch commits for this branch and re-render
      if (branchGraphCache) {
        renderBranchGraph(branchGraphCache, branch.name);
      }
    });

    branchList.appendChild(node);
  }

  // Right: commit timeline for selected branch
  const timeline = document.createElement('div');
  timeline.className = 'commit-timeline';

  // Find the selected branch's commits — if it's the current branch, use recent_commits
  // Otherwise show just the tip commit info
  const selectedBranchData = data.branches.find(b => b.name === selectedBranch);
  const isCurrentBranch = selectedBranchData?.is_current;

  const commits = isCurrentBranch
    ? data.recent_commits
    : selectedBranchData
      ? [{
          sha: selectedBranchData.commit_sha,
          message: selectedBranchData.commit_message,
          author: selectedBranchData.commit_author,
          time: selectedBranchData.commit_time,
        }]
      : [];

  // Draw the connecting line
  const line = document.createElement('div');
  line.className = 'timeline-line';
  timeline.appendChild(line);

  const now = Math.floor(Date.now() / 1000);

  for (const commit of commits) {
    const dot = document.createElement('div');
    dot.className = 'commit-dot';
    dot.title = `${commit.sha} — ${commit.message}`;

    const timeLabel = document.createElement('span');
    timeLabel.className = 'commit-time';
    timeLabel.textContent = formatRelativeTime(commit.time, now);

    const msgLabel = document.createElement('span');
    msgLabel.className = 'commit-msg';
    msgLabel.textContent = commit.message.length > 20 ? commit.message.slice(0, 20) + '...' : commit.message;

    dot.appendChild(timeLabel);
    dot.appendChild(msgLabel);

    // Click to show tooltip then collapse
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle tooltip
      const existing = dot.querySelector('.commit-tooltip');
      if (existing) {
        existing.remove();
        return;
      }
      // Remove other tooltips
      graph.querySelectorAll('.commit-tooltip').forEach(t => t.remove());

      const tooltip = document.createElement('div');
      tooltip.className = 'commit-tooltip';
      tooltip.innerHTML = `<strong>${commit.sha}</strong><br>${escapeHtml(commit.message)}<br><span class="commit-tooltip-meta">${escapeHtml(commit.author)} · ${formatRelativeTime(commit.time, now)}</span>`;
      dot.appendChild(tooltip);
    });

    timeline.appendChild(dot);
  }

  graph.appendChild(branchList);
  graph.appendChild(timeline);
}

function formatRelativeTime(unixSec, nowSec) {
  const diff = nowSec - unixSec;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / 604800)}w`;
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

// --- Config Panel Buttons ---

function setupConfigButtons() {
  document.getElementById('config-scheduled-btn').onclick = () => togglePanel('scheduled');
  document.getElementById('config-plugins-btn').onclick = () => togglePanel('plugins');
  document.getElementById('config-mcps-btn').onclick = () => togglePanel('mcps');
  document.getElementById('config-memory-btn').onclick = () => togglePanel('memory');
  document.getElementById('settings-btn').onclick = () => togglePanel('settings');

  // Re-fit terminals when panel is hidden
  setOnHide(() => {
    requestAnimationFrame(() => fitVisibleTerminals());
  });
}

// --- Sidebar Toggle ---

function setupSidebarToggle() {
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  const robotOverlay = document.getElementById('robot-overlay');

  // Restore from localStorage
  if (localStorage.getItem('ps-sidebar-collapsed') === 'true') {
    sidebar.classList.add('collapsed');
    robotOverlay?.classList.add('sidebar-collapsed');
  }

  toggleBtn.addEventListener('click', () => {
    const isCollapsing = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed');
    robotOverlay?.classList.toggle('sidebar-collapsed', isCollapsing);
    // Clear inline width so CSS class takes effect
    if (isCollapsing) {
      sidebar._savedWidth = sidebar.style.width || '';
      sidebar.style.width = '';
    } else {
      // Restore dragged width if there was one
      if (sidebar._savedWidth) {
        sidebar.style.width = sidebar._savedWidth;
      }
    }
    localStorage.setItem('ps-sidebar-collapsed', isCollapsing);
  });

  // Re-fit terminals after sidebar transition completes
  sidebar.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'width') {
      fitVisibleTerminals();
    }
  });
}

// --- Keyboard Shortcuts ---

function getShortcutBindings() {
  const saved = localStorage.getItem('ps-shortcuts');
  if (!saved) return null;
  try {
    const arr = JSON.parse(saved);
    const map = {};
    arr.forEach(s => { map[s.id] = s; });
    return map;
  } catch { return null; }
}

function matchesShortcut(e, id, bindings) {
  const b = bindings?.[id];
  if (!b) return false;
  const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return keyLower === b.key && modActive(e) === b.meta && e.shiftKey === b.shift;
}

function setupShortcuts() {
  // Shift+Enter is handled by xterm's attachCustomKeyEventHandler in terminal.js.
  // This ensures the CSI u sequence reaches the PTY without xterm's default \r handling.

  // Default bindings (used as fallback)
  const DEFAULTS = {
    'close-panel':    { key: 'Escape',  meta: false, shift: false },
    'settings':       { key: ',',       meta: true,  shift: false },
    'sidebar-toggle': { key: 'b',       meta: true,  shift: false },
    'file-viewer':    { key: 'e',       meta: true,  shift: true  },
    'new-terminal':   { key: 'n',       meta: true,  shift: false },
    'close-terminal': { key: 'w',       meta: true,  shift: false },
    'maximize':       { key: 'Enter',   meta: true,  shift: true  },
    'minimize':       { key: 'm',       meta: true,  shift: false },
    'restore-all':    { key: 'm',       meta: true,  shift: true  },
    'layout-mode':    { key: 'g',       meta: true,  shift: true  },
    'prev-pane':      { key: '[',       meta: true,  shift: true  },
    'next-pane':      { key: ']',       meta: true,  shift: true  },
    'notifications':  { key: 'i',       meta: true,  shift: false },
    'nav-up':         { key: 'ArrowUp',    meta: true,  shift: false, alt: true },
    'nav-down':       { key: 'ArrowDown',  meta: true,  shift: false, alt: true },
    'nav-left':       { key: 'ArrowLeft',  meta: true,  shift: false, alt: true },
    'nav-right':      { key: 'ArrowRight', meta: true,  shift: false, alt: true },
    'reopen-closed':  { key: 'z',       meta: true,  shift: true  },
  };

  const ACTIONS = {
    'close-panel':    () => { if (notifPanelVisible) { hideNotificationPanel(); return true; } if (isAnyPanelActive()) hidePanel(); else if (isFileViewerVisible()) hideFileViewer(); else return false; return true; },
    'settings':       () => { togglePanel('settings'); return true; },
    'sidebar-toggle': () => { document.getElementById('sidebar-toggle').click(); return true; },
    'file-viewer':    () => { toggleFileViewer(sessions[focusedIndex]?.cwd); return true; },
    'new-terminal':   () => { createSession(); return true; },
    'close-terminal': () => { if (sessions.length > 0) removeSession(focusedIndex); return true; },
    'maximize':       () => { if (sessions.length > 0) toggleMaximize(focusedIndex); return true; },
    'minimize':       () => { if (sessions.length > 0) minimizeSession(focusedIndex); return true; },
    'restore-all':    () => { restoreAllSessions(); return true; },
    'layout-mode':    () => { toggleLayoutMode(); return true; },
    'prev-pane':      () => { if (isAnyPanelActive()) hidePanel(); focusNextVisible(focusedIndex, -1); return true; },
    'next-pane':      () => { if (isAnyPanelActive()) hidePanel(); focusNextVisible(focusedIndex, 1); return true; },
    'notifications':  () => { toggleNotificationPanel(); return true; },
    'reopen-closed':  () => { reopenLastClosed(); return true; },
    'nav-up':         () => { navigateDirection('up'); return true; },
    'nav-down':       () => { navigateDirection('down'); return true; },
    'nav-left':       () => { navigateDirection('left'); return true; },
    'nav-right':      () => { navigateDirection('right'); return true; },
  };

  document.addEventListener('keydown', (e) => {
    const bindings = getShortcutBindings() || DEFAULTS;

    // Mod+1-9 — always hardcoded (can't rebind per-number)
    if (modActive(e) && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      const idx = parseInt(e.key) - 1;
      if (idx < sessions.length) {
        // Close any open panel first to return to terminal view
        if (isAnyPanelActive()) hidePanel();
        if (sessions[idx].minimized) restoreSession(idx);
        else setFocus(idx);
      }
      return;
    }

    // Check all configurable shortcuts
    for (const [id, action] of Object.entries(ACTIONS)) {
      const binding = bindings[id] || DEFAULTS[id];
      if (!binding) continue;
      const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const altMatch = binding.alt ? e.altKey : !e.altKey;
      if (keyLower === binding.key && modActive(e) === binding.meta && e.shiftKey === binding.shift && altMatch) {
        e.preventDefault();
        if (action() !== false) return;
      }
    }
  });

  // Reload when shortcuts change from settings
  window.addEventListener('shortcuts-changed', () => {
    // Bindings are read fresh on each keydown, so no action needed
  });
}

// --- Notification History ---

const notificationHistory = [];
let unreadNotificationCount = 0;

function addNotification(sessionName, status, sessionIndex) {
  notificationHistory.unshift({
    sessionName,
    status,
    sessionIndex,
    timestamp: Date.now(),
  });
  // Cap at 100 entries
  if (notificationHistory.length > 100) notificationHistory.length = 100;
  unreadNotificationCount++;
  updateNotificationBadge();
}

function updateNotificationBadge() {
  const badge = document.getElementById('notification-count-badge');
  if (!badge) return;
  if (unreadNotificationCount > 0) {
    badge.textContent = unreadNotificationCount > 99 ? '99+' : unreadNotificationCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

let notifPanelVisible = false;

function renderNotificationPanel() {
  const content = document.getElementById('notif-content');
  if (!content) return;

  if (notificationHistory.length === 0) {
    content.innerHTML = '<p style="color:var(--text-muted);font-size:var(--font-size-sm);padding:4px;">No notifications yet. Alerts appear here when terminals need attention.</p>';
    return;
  }

  const items = notificationHistory.map((n, i) => {
    const time = new Date(n.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const statusClass = n.status.startsWith('OSC:') ? 'WaitingForInput' : n.status;
    const statusLabel = n.status.startsWith('OSC:') ? n.status : {
      WaitingForInput: 'Needs attention',
      NeedsPermission: 'Needs approval',
      ClaudeNeedsInput: 'Claude needs input',
      Exited: 'Finished',
      CommandCompleted: 'Command done',
      Error: 'Something went wrong',
      ClaudeFinished: 'Claude is done',
    }[n.status] || n.status;
    const dotColorMap = { WaitingForInput: 'waiting', NeedsPermission: 'waiting', ClaudeNeedsInput: 'waiting', Exited: 'exited', Error: 'exited', ClaudeFinished: 'idle', CommandCompleted: 'idle' };
    const dotColor = dotColorMap[statusClass] || 'working';
    return `<div class="notif-item" data-index="${n.sessionIndex}">
      <span class="notif-dot" style="background:var(--status-${dotColor})"></span>
      <span class="notif-session">${n.sessionName}</span>
      <span class="notif-status">${statusLabel}</span>
      <span class="notif-time">${timeStr}</span>
    </div>`;
  }).join('');

  content.innerHTML = `<div class="notif-list">${items}</div>`;

  // Click to jump to session
  content.querySelectorAll('.notif-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      if (idx >= 0 && idx < sessions.length) {
        hideNotificationPanel();
        if (sessions[idx].minimized) restoreSession(idx);
        else setFocus(idx);
      }
    });
  });
}

function showNotificationPanel() {
  const panel = document.getElementById('notification-panel');
  panel.classList.add('closing');
  panel.style.display = 'flex';
  panel.offsetHeight; // force reflow
  panel.classList.remove('closing');
  notifPanelVisible = true;
  document.getElementById('notification-toggle-btn').classList.add('active');
  unreadNotificationCount = 0;
  updateNotificationBadge();
  renderNotificationPanel();
}

function hideNotificationPanel() {
  const panel = document.getElementById('notification-panel');
  notifPanelVisible = false;
  document.getElementById('notification-toggle-btn').classList.remove('active');
  panel.classList.add('closing');
  const onEnd = () => {
    panel.removeEventListener('transitionend', onEnd);
    if (!notifPanelVisible) panel.style.display = 'none';
  };
  panel.addEventListener('transitionend', onEnd);
  setTimeout(() => { if (!notifPanelVisible) panel.style.display = 'none'; }, 300);
}

function toggleNotificationPanel() {
  if (notifPanelVisible) { hideNotificationPanel(); return; }
  if (isFileViewerVisible()) hideFileViewer();
  showNotificationPanel();
}

// --- Status Detection ---

const STATUS_COLORS = {
  Working: 'var(--status-working)',
  Idle: 'var(--status-idle)',
  WaitingForInput: 'var(--status-waiting)',
  NeedsPermission: 'var(--status-permission)',
  ClaudeNeedsInput: 'var(--status-waiting)',
  Error: 'var(--status-exited)',
  ClaudeFinished: 'var(--status-idle)',
  Exited: 'var(--status-exited)',
};

// Throttle native desktop notifications to prevent taskbar flash spam on Windows
let _lastNativeNotifyTime = 0;
const NATIVE_NOTIFY_COOLDOWN = 5000; // 5 seconds between native notifications

async function maybeNotify(session, status) {
  console.log('[notify]', status, 'windowFocused:', windowFocused);
  if (windowFocused) {
    // If in-app but on a different terminal, have the mascot relay the notification
    const idx = sessions.indexOf(session);
    if (idx >= 0 && idx !== focusedIndex && localStorage.getItem('ps-robot-enabled') !== 'false') {
      const friendlyStatus = {
        WaitingForInput: 'needs attention',
        NeedsPermission: 'needs approval',
        ClaudeNeedsInput: 'needs your input',
        Error: 'has a problem',
        ClaudeFinished: 'Claude is done',
      }[status];
      if (friendlyStatus) showSpeech(`${session.name} ${friendlyStatus}`, 4000);
    }
    return;
  }
  if (localStorage.getItem('ps-notifications') === 'false') return;

  // Check per-status toggles
  const statusToggleMap = {
    WaitingForInput: 'ps-notify-waiting',
    NeedsPermission: 'ps-notify-permission',
    ClaudeNeedsInput: 'ps-notify-claude-input',
    Exited: 'ps-notify-exited',
    CommandCompleted: 'ps-notify-completed',
    Error: 'ps-notify-error',
    ClaudeFinished: 'ps-notify-claude-finished',
  };
  const toggleKey = statusToggleMap[status];
  if (!toggleKey) return;
  // CommandCompleted defaults to off (opt-in); others default to on
  if (status === 'CommandCompleted') {
    if (localStorage.getItem(toggleKey) !== 'true') return;
  } else {
    if (localStorage.getItem(toggleKey) === 'false') return;
  }

  const messages = {
    WaitingForInput: 'needs your attention',
    NeedsPermission: 'is asking for your approval',
    ClaudeNeedsInput: 'Claude needs your input',
    Exited: 'has finished',
    CommandCompleted: 'finished running a command',
    Error: 'ran into a problem',
    ClaudeFinished: 'Claude finished working',
  };
  const msg = messages[status];
  if (!msg) return;

  // Throttle native notifications to prevent Windows taskbar flash spam
  const now = Date.now();
  if (now - _lastNativeNotifyTime < NATIVE_NOTIFY_COOLDOWN) {
    console.log('[notify] Throttled (cooldown)');
    return;
  }

  try {
    let granted = await invoke('plugin:notification|is_permission_granted');
    if (!granted) {
      const result = await invoke('plugin:notification|request_permission');
      granted = result === 'granted';
    }
    if (granted) {
      _lastNativeNotifyTime = now;
      const options = { title: 'PaneStreet', body: `${session.name} ${msg}` };
      if (localStorage.getItem('ps-notify-sound') !== 'false') options.sound = 'default';
      await invoke('plugin:notification|notify', { options });
      console.log('[notify] Sent native notification');
    } else {
      console.log('[notify] Permission not granted');
    }
  } catch (err) {
    console.warn('[notify] Failed:', err);
  }
}

function setupStatusListener() {
  listen('session-status-changed', (event) => {
    const { session_id, status } = event.payload;
    const session = sessions.find(s => s.id === session_id);
    if (!session) return;

    const previousStatus = session.status || 'Idle';
    session.status = status;
    const color = STATUS_COLORS[status] || 'var(--status-idle)';

    // Update pane header dot + border
    session.statusDot.style.background = color;
    session.pane.dataset.status = status;

    // Update sidebar card dot + border
    const cards = document.querySelectorAll('.session-card');
    const idx = sessions.indexOf(session);
    if (cards[idx]) {
      const dot = cards[idx].querySelector('.status-dot');
      if (dot) dot.style.background = color;
      cards[idx].dataset.status = status;
    }

    // Update mascot if this is the focused session
    if (sessions.indexOf(session) === focusedIndex) {
      updateMascot(status);
    }

    // Apply pending terminal settings when session becomes idle
    if (pendingTerminalSettings && (status === 'Idle' || status === 'WaitingForInput')) {
      session.terminal.applySettings(pendingTerminalSettings);
    }

    // Notification ring on unfocused panes that need attention
    const needsAttention = ['WaitingForInput', 'NeedsPermission', 'ClaudeNeedsInput', 'Exited', 'Error', 'ClaudeFinished'].includes(status);
    const commandCompleted = (previousStatus === 'Working' && status === 'Idle');
    const isFocused = idx === focusedIndex;

    if (needsAttention && !isFocused) {
      session.pane.classList.add('notify-ring');
      const card = document.querySelectorAll('.session-card')[idx];
      if (card) card.classList.add('notify-badge');
    } else if (!needsAttention) {
      session.pane.classList.remove('notify-ring');
      const card = document.querySelectorAll('.session-card')[idx];
      if (card) card.classList.remove('notify-badge');
    }

    // Add to notification history and send push notification (only for unfocused panes)
    const shouldNotify = (needsAttention || commandCompleted) && !isFocused;
    if (shouldNotify) {
      const notifStatus = commandCompleted ? 'CommandCompleted' : status;
      const completedEnabled = notifStatus !== 'CommandCompleted' || localStorage.getItem('ps-notify-completed') === 'true';
      if (completedEnabled) {
        addNotification(session.name, notifStatus, idx);
        maybeNotify(session, notifStatus);
      }
    }

    triggerMascotBounce();
  });
}

// --- Update Helpers ---

// Shared download+install+restart flow used by both startup banner and Settings page
async function downloadAndInstallUpdate(update, { onProgress, onFinished, onError, onRestart } = {}) {
  const channel = new window.__TAURI__.core.Channel();
  channel.onmessage = (event) => {
    if (event.event === 'Started' && onProgress) onProgress(0, event.data.contentLength || 0);
    else if (event.event === 'Progress' && onProgress) onProgress(event.data.chunkLength, 0);
    else if (event.event === 'Finished' && onFinished) onFinished();
  };

  await invoke('plugin:updater|download_and_install', { rid: update.rid, onEvent: channel });

  setTimeout(async () => {
    try { await invoke('plugin:process|restart'); }
    catch (e) { if (onRestart) onRestart(e); }
  }, 1500);
}

// Make available to config-panels.js
window.__panestreet = window.__panestreet || {};
window.__panestreet.downloadAndInstallUpdate = downloadAndInstallUpdate;

async function checkForUpdateOnStartup() {
  try {
    const update = await invoke('plugin:updater|check', {});
    if (!update) return;

    const dismissed = localStorage.getItem('ps-update-dismissed');
    if (dismissed === update.version) return;

    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = `
      <span>Version ${update.version} is available.</span>
      <button id="update-banner-install">Update now</button>
      <button id="update-banner-dismiss">&times;</button>
    `;
    const main = document.getElementById('main');
    main.insertBefore(banner, main.children[1]);

    banner.querySelector('#update-banner-dismiss').addEventListener('click', () => {
      localStorage.setItem('ps-update-dismissed', update.version);
      banner.remove();
    });

    banner.querySelector('#update-banner-install').addEventListener('click', async () => {
      const installBtn = banner.querySelector('#update-banner-install');
      installBtn.disabled = true;
      installBtn.textContent = 'Downloading...';

      try {
        await downloadAndInstallUpdate(update, {
          onFinished: () => { installBtn.textContent = 'Restarting...'; },
          onRestart: () => { installBtn.textContent = 'Restart manually'; },
        });
      } catch (err) {
        console.warn('[update] Install failed:', err);
        installBtn.textContent = 'Failed — try Settings';
        installBtn.disabled = false;
      }
    });
  } catch (err) {
    console.log('[update] Startup check skipped:', err);
  }
}

// --- Robot Mascot (JS state machine) ---

const ACTIVITIES = [
  { name: 'stand',   cls: 'act-stand',   duration: [20, 40] },
  { name: 'look',    cls: 'act-look',    duration: [8, 14] },
  { name: 'wave',    cls: 'act-wave',    duration: [4, 6],  speech: 'Hi!' },
  { name: 'sleep',   cls: 'act-sleep',   duration: [30, 60] },
  { name: 'stretch', cls: 'act-stretch', duration: [5, 8] },
  { name: 'nod',     cls: 'act-nod',     duration: [4, 6] },
  { name: 'think',   cls: 'act-think',   duration: [15, 25] },
  { name: 'dance',   cls: 'act-dance',   duration: [4, 7] },
  { name: 'type',    cls: 'act-type',    duration: [10, 18] },
  { name: 'bounce',  cls: 'act-bounce',  duration: [3, 5] },
  { name: 'sweep',   cls: 'act-sweep',   duration: [8, 14],  speech: 'Tidying up...' },
  { name: 'phone',   cls: 'act-phone',   duration: [10, 20], speech: 'Mhm... mhm...' },
  { name: 'code',    cls: 'act-code',    duration: [12, 22], speech: 'Coding...' },
  { name: 'mop',     cls: 'act-mop',     duration: [8, 14] },
];

const APP_TIPS = [
  `${isMac ? 'Cmd' : 'Ctrl'}+N for a new terminal`,
  `${isMac ? 'Cmd' : 'Ctrl'}+1-9 to switch sessions`,
  'Double-click a header to maximize',
  `${isMac ? 'Cmd' : 'Ctrl'}+Shift+E opens the file viewer`,
  `${isMac ? 'Cmd' : 'Ctrl'}+, opens settings`,
  'Drag sidebar cards to reorder',
  'Right-click a session to rename',
  'Up to 6 terminals visible at once',
  'Click me for a greeting!',
  'Minimize sessions to the footer bar',
  'File viewer tracks your terminal\'s directory',
  'Custom themes in Settings > Theme',
  `${isMac ? 'Cmd' : 'Ctrl'}+I opens the notification panel`,
  `${isMac ? 'Cmd+Opt' : 'Ctrl+Alt'}+Arrows to navigate between panes`,
  'Terminals emit OSC 9 for notifications',
];

const SPEECH_WORKING = ['On it!', 'Working...', 'Give me a sec.', 'Processing...', 'Crunching...', 'On the case.'];
const SPEECH_WAITING = ['Your move.', 'Over to you.', 'Whenever you\'re ready.', 'Your turn.', 'Need input!'];
const SPEECH_DONE = ['Done.', 'There you go.', 'All set.', 'Finished.', 'Easy.', 'That\'s a wrap.'];
const SPEECH_CLICK = ['Hey.', 'Oh, hi.', 'You need something?', 'I\'m here.', 'What\'s the word?', 'In the flesh. Mostly.', 'Ready when you are.', 'Mm?', 'Right here.', 'As you were.', 'Still here.', 'Yep?'];

// Contextual quips based on terminal output patterns
const CONTEXTUAL_QUIPS = [
  { patterns: [/npm install|npm i |yarn add|pnpm add/i], quips: ['Package time.', 'Dependencies inbound.', 'npm doing its thing.', 'Grabbing packages...'] },
  { patterns: [/npm run build|cargo build|vite build|webpack/i], quips: ['Building...', 'Compiling.', 'Build in progress.', 'Fingers crossed.'] },
  { patterns: [/npm test|pytest|cargo test|vitest|jest/i], quips: ['Running tests...', 'Here we go.', 'Let\'s see how this goes.', 'Tests incoming.'] },
  { patterns: [/git push/i], quips: ['Sending it.', 'Up she goes.', 'Shipped.', 'Off it goes.'] },
  { patterns: [/git commit/i], quips: ['Committing to the bit.', 'History is being made.', 'Saved.', 'Good commit.'] },
  { patterns: [/git merge|git rebase/i], quips: ['Merging...', 'Here we go.', 'May the conflicts be few.'] },
  { patterns: [/git pull|git fetch/i], quips: ['Pulling latest.', 'Syncing up.', 'What\'d I miss?'] },
  { patterns: [/docker compose|docker build|docker run/i], quips: ['Containers, containers everywhere.', 'Docker time.', 'Spinning up...'] },
  { patterns: [/pip install|poetry add/i], quips: ['Python packages incoming.', 'pip doing its thing.'] },
  { patterns: [/Total cost:|Total tokens:/i], quips: ["I'd have asked Claude too.", 'Claude delivered.', 'Nice work, Claude.', 'Tokens well spent.'] },
  { patterns: [/error\[|Error:|SyntaxError|TypeError|panic:/i], quips: ['Oof.', 'That\'s not ideal.', 'We\'ve seen worse.', 'Hmm.'] },
  { patterns: [/✓ built|Successfully compiled|Build succeeded|Tests passed/i], quips: ['Green across the board.', 'Clean build.', 'Ship it.', 'Looking good.'] },
  { patterns: [/Downloading|downloading/], quips: ['Downloading...', 'Fetching...'] },
  { patterns: [/deploy|Deploy|DEPLOY/], quips: ['Going live.', 'Launch sequence.', 'Deploying...'] },
  { patterns: [/lint|eslint|prettier/i], quips: ['Keeping it clean.', 'Linting...'] },
  { patterns: [/migration|migrate/i], quips: ['Schema changes incoming.', 'Migrating...'] },
  { patterns: [/claude |Claude /], quips: ['Let Claude cook.', 'AI at work.', 'Claude\'s on it.'] },
  { patterns: [/warning|Warning/], quips: ['Heads up.', 'Worth a look.', 'A warning or two.'] },
  { patterns: [/fatal|FATAL|killed|Killed/i], quips: ['Yikes.', 'That\'s not great.', 'F.'] },
];

// Animation frequency settings: [idlePauseMin, idlePauseMax, contextInterval, walkChance]
const FREQUENCY_SETTINGS = {
  low:    { idleMin: 200, idleMax: 300, contextInterval: 60000, walkChance: 0.1 },
  medium: { idleMin: 60,  idleMax: 100, contextInterval: 35000, walkChance: 0.2 },
  high:   { idleMin: 30,  idleMax: 60,  contextInterval: 20000, walkChance: 0.3 },
};

let robotEl = null;
let robotTimer = null;
let robotFacingLeft = false;
let robotOverride = null; // status override (working/waiting/exited)
let lastActivityIndex = -1;
let lastContextQuip = '';
let contextScanTimer = null;

// Boredom tracking
let robotLastInteraction = Date.now();
function touchInteraction() { robotLastInteraction = Date.now(); }
function idleMs() { return Date.now() - robotLastInteraction; }
const BOREDOM_IDLE_QUIPS = ['Still here.', 'Just vibing.', '...', 'Hello?', 'Anybody home?', 'Waiting patiently.'];
const BOREDOM_WALK_QUIPS = ['Right. Going for a walk.', 'Stretching my legs.', 'Be right back.'];

// Theme reaction cooldown
let themeReactionCooldown = 0;

function getFrequency() {
  return FREQUENCY_SETTINGS[localStorage.getItem('ps-robot-frequency') || 'medium'];
}

function robotInit() {
  robotEl = document.getElementById('footer-mascot');
  if (!robotEl) return;

  const overlay = document.getElementById('robot-overlay');

  // Check saved preference
  if (localStorage.getItem('ps-robot-enabled') === 'false') {
    overlay?.classList.add('hidden');
    return;
  }

  // Start at a random spot — disable transition so it doesn't slide from default position
  robotEl.style.transition = 'none';
  const overlayWidth = overlay ? overlay.clientWidth : 400;
  robotEl.style.left = Math.floor(4 + Math.random() * Math.max(100, overlayWidth - 80)) + 'px';
  // Force layout before re-enabling transition
  void robotEl.offsetLeft;

  // Click interaction — easter egg on rapid clicks
  let clickCount = 0;
  let clickResetTimer = null;

  // --- Hold-to-secret ---
  const SECRET_REACTIONS = [
    () => { robotEl.classList.add('act-dance'); showSpeech('You found me.', 4000); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 5000); },
    () => { robotEl.classList.add('act-wave'); showSpeech('This is between us.', 4000); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
    () => { robotEl.classList.add('act-bounce'); showSpeech("I wasn't expecting that.", 4000); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
    () => { robotEl.classList.add('act-think'); showSpeech("Nobody's ever held on that long before.", 5000); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 6000); },
    () => { robotEl.classList.add('act-sleep'); showSpeech('Zzz...', 1200); robotTimer = setTimeout(() => { robotClearActivity(); showSpeech("I wasn't sleeping.", 3000); robotNext(); }, 2200); },
    () => { robotEl.classList.add('act-stretch'); showSpeech('Okay fine, you caught me.', 4000); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 5000); },
  ];
  let lastSecretIndex = -1;
  function triggerSecretReaction() {
    clearTimeout(robotTimer);
    robotClearActivity();
    let idx;
    do { idx = Math.floor(Math.random() * SECRET_REACTIONS.length); } while (idx === lastSecretIndex && SECRET_REACTIONS.length > 1);
    lastSecretIndex = idx;
    SECRET_REACTIONS[idx]();
  }

  // --- Drag handling (pick up above line, drop back down) ---
  let isDragging = false;
  let hasDragged = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartLeft = 0;
  let holdTimer = null;
  let secretFired = false;

  overlay?.addEventListener('mousedown', (e) => {
    const rect = robotEl.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    if (Math.abs(dx) > 40 || Math.abs(dy) > 50) return;

    isDragging = true;
    hasDragged = false;
    secretFired = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = parseInt(robotEl.style.left) || 0;

    clearTimeout(robotTimer);
    robotClearActivity();
    robotEl.style.transition = 'none';
    robotEl.style.bottom = '0px';
    robotEl.classList.add('dragging');
    e.preventDefault();

    // Hold-to-secret: if held still for 2s without dragging, trigger a surprise
    holdTimer = setTimeout(() => {
      if (!hasDragged) {
        secretFired = true;
        isDragging = false;
        robotEl.classList.remove('dragging');
        triggerSecretReaction();
      }
    }, 2000);
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - dragStartX;
    const deltaY = dragStartY - e.clientY; // up = positive
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      hasDragged = true;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }
    const ow = overlay ? overlay.clientWidth : window.innerWidth;
    const newLeft = Math.max(4, Math.min(ow - 72, dragStartLeft + deltaX));
    robotEl.style.left = newLeft + 'px';
    const liftY = Math.max(0, deltaY);
    robotEl.style.bottom = liftY + 'px';
  });

  const DROP_QUOTES = [
    'AAAAAH!', 'Not again!', 'I can fly! ...nope.', 'Mayday!',
    'Wheeeee!', 'Put me down!', 'I regret everything!', 'Gravity wins again.',
    'My antenna!', 'Told you I\'d land it.', 'Stuck the landing!', '10/10 landing.',
    'That was fun!', 'Do NOT do that again.', 'I think I left my stomach up there.',
  ];

  document.addEventListener('mouseup', () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!isDragging) return;
    isDragging = false;
    robotEl.classList.remove('dragging');
    touchInteraction();
    const currentBottom = parseInt(robotEl.style.bottom) || 0;
    if (currentBottom > 20) {
      // Falling! Wave arms and speak
      robotEl.classList.add('act-falling');
      const fallDuration = Math.min(2.2, 0.9 + currentBottom * 0.006);
      robotEl.style.transition = `bottom ${fallDuration}s cubic-bezier(0.33, 0, 0.66, 1)`;
      robotEl.style.bottom = '0px';
      showSpeech(DROP_QUOTES[Math.floor(Math.random() * DROP_QUOTES.length)], 2500);
      setTimeout(() => {
        robotEl.style.transition = '';
        robotEl.classList.remove('act-falling');
        robotEl.classList.add('act-bounce');
        setTimeout(() => { robotEl.classList.remove('act-bounce'); if (!robotOverride) robotNext(); }, 600);
      }, fallDuration * 1000);
    } else if (currentBottom > 0) {
      robotEl.style.transition = 'bottom 0.3s ease-out';
      robotEl.style.bottom = '0px';
      setTimeout(() => { robotEl.style.transition = ''; }, 350);
      if (hasDragged) {
        showSpeech(['New spot, nice.', 'I like it here.', 'Cozy.', 'Good enough.'][Math.floor(Math.random() * 4)], 2000);
        setTimeout(() => { if (!robotOverride) robotNext(); }, 2000);
      } else {
        if (!robotOverride) robotNext();
      }
    } else {
      if (hasDragged) {
        showSpeech(['New spot, nice.', 'I like it here.', 'Fine by me.', 'This works.'][Math.floor(Math.random() * 4)], 2000);
        setTimeout(() => { if (!robotOverride) robotNext(); }, 2000);
      } else {
        if (!robotOverride) robotNext();
      }
    }
  });

  overlay?.addEventListener('click', (e) => {
    const rect = robotEl.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    if (Math.abs(dx) > 40 || Math.abs(dy) > 50) return;

    if (hasDragged || secretFired) { hasDragged = false; secretFired = false; return; }
    touchInteraction();
    clickCount++;
    clearTimeout(clickResetTimer);
    clickResetTimer = setTimeout(() => { clickCount = 0; }, 1500);

    if (clickCount >= 8) {
      clickCount = 0;
      clearTimeout(robotTimer);
      robotClearActivity();
      // Exasperated tier
      const reactions = [
        () => { showSpeech('I\'m filing a complaint.', 4000); robotWalk(); },
        () => { showSpeech('Fine. You win.', 3000); robotWalk(); },
        () => { showSpeech('I need a vacation.', 4000); robotEl.classList.add('act-sleep'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 8000); },
        () => { showSpeech('That\'s it, I\'m unionizing.', 4000); robotWalk(); },
      ];
      reactions[Math.floor(Math.random() * reactions.length)]();
    } else if (clickCount >= 5) {
      clearTimeout(robotTimer);
      robotClearActivity();
      // Animated tier
      const reactions = [
        () => { showSpeech('Seriously?!', 3000); robotEl.classList.add('act-dance'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 5000); },
        () => { showSpeech('I\'m not a button, you know.', 4000); robotEl.classList.add('act-bounce'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
        () => { showSpeech('Careful, I bite.', 3000); robotEl.classList.add('act-look'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
        () => { showSpeech('Do you mind??', 3000); robotDoActivity(); },
      ];
      reactions[Math.floor(Math.random() * reactions.length)]();
    } else if (clickCount >= 3) {
      clearTimeout(robotTimer);
      robotClearActivity();
      // Mild annoyance tier
      const reactions = [
        () => { showSpeech('Ok ok, stop poking me!', 3000); robotEl.classList.add('act-bounce'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
        () => { showSpeech('That tickles!', 3000); robotDoActivity(); },
        () => { showSpeech('I\'m working here!', 3000); robotEl.classList.add('act-type'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 4000); },
        () => { showSpeech('Personal space, please!', 3000); robotWalk(); },
        () => { showSpeech('Alright alright, dance break!', 4000); robotEl.classList.add('act-dance'); robotTimer = setTimeout(() => { robotClearActivity(); robotNext(); }, 5000); },
        () => { showSpeech('You\'re persistent, I\'ll give you that.', 4000); robotDoActivity(); },
      ];
      reactions[Math.floor(Math.random() * reactions.length)]();
    } else {
      showSpeech(SPEECH_CLICK[Math.floor(Math.random() * SPEECH_CLICK.length)]);
    }
  });

  // If window resizes and robot is off-screen, walk back into view
  window.addEventListener('resize', () => {
    if (!robotEl || !overlay) return;
    const overlayWidth = overlay.clientWidth;
    const currentLeft = parseInt(robotEl.style.left) || 0;
    if (currentLeft > overlayWidth - 60) {
      // Robot is off-screen — walk back in
      clearTimeout(robotTimer);
      robotClearActivity();
      const dest = Math.floor(overlayWidth * 0.5 + Math.random() * (overlayWidth * 0.3));
      const safeDest = Math.min(dest, overlayWidth - 80);
      robotFacingLeft = true;
      robotEl.classList.add('face-left');
      robotEl.classList.add('walking');
      const duration = Math.max(2, (currentLeft - safeDest) * 0.04);
      robotEl.style.transition = `left ${duration}s linear`;
      robotEl.style.left = safeDest + 'px';
      robotTimer = setTimeout(() => {
        robotEl.classList.remove('walking', 'face-left');
        robotNext();
      }, duration * 1000);
    }
  });

  // --- Environment Detection ---

  // Online / offline
  window.addEventListener('offline', () => {
    if (robotEl && localStorage.getItem('ps-robot-enabled') !== 'false') showSpeech('We lost the connection.', 4000);
  });
  window.addEventListener('online', () => {
    if (robotEl && localStorage.getItem('ps-robot-enabled') !== 'false') showSpeech('Back online.', 3000);
  });

  // Window focus / blur — comment on long absences
  let blurTime = null;
  window.addEventListener('blur', () => { blurTime = Date.now(); });
  window.addEventListener('focus', () => {
    if (!blurTime) return;
    const away = Date.now() - blurTime;
    blurTime = null;
    touchInteraction(); // reset boredom clock when user returns
    if (away > 5 * 60 * 1000 && robotEl && localStorage.getItem('ps-robot-enabled') !== 'false') {
      const msgs = ['Welcome back.', 'Oh, you\'re back.', 'Miss me?', 'There you are.', 'I waited.'];
      setTimeout(() => showSpeech(msgs[Math.floor(Math.random() * msgs.length)], 3500), 600);
    }
  });

  // Battery (where supported)
  if ('getBattery' in navigator) {
    navigator.getBattery().then(battery => {
      let batteryAlertSent = false;
      const checkBattery = () => {
        if (!batteryAlertSent && battery.level < 0.2 && !battery.charging && robotEl && localStorage.getItem('ps-robot-enabled') !== 'false') {
          batteryAlertSent = true;
          showSpeech('Low battery. Save your work.', 5000);
        }
      };
      checkBattery();
      battery.addEventListener('levelchange', checkBattery);
      battery.addEventListener('chargingchange', () => { if (battery.charging) batteryAlertSent = false; });
    }).catch(() => {});
  }

  // Theme changes
  window.addEventListener('theme-terminal-changed', () => {
    if (!robotEl || localStorage.getItem('ps-robot-enabled') === 'false') return;
    if (Date.now() - themeReactionCooldown < 30000) return;
    themeReactionCooldown = Date.now();
    const msgs = ['New look.', 'Nice theme.', 'Bold choice.', 'I like it.', 'Stylish.'];
    setTimeout(() => showSpeech(msgs[Math.floor(Math.random() * msgs.length)], 3000), 500);
  });

  // Just stand still on startup — the idle hover animation handles the rest
  // First real action after a long pause
  robotNext();
  startContextScanning();
}

function toggleRobot(enabled) {
  const overlay = document.getElementById('robot-overlay');
  if (!overlay) return;
  if (enabled) {
    overlay.classList.remove('hidden');
    localStorage.setItem('ps-robot-enabled', 'true');
    if (!robotOverride) robotNext();
  } else {
    overlay.classList.add('hidden');
    localStorage.setItem('ps-robot-enabled', 'false');
    clearTimeout(robotTimer);
  }
}

function robotNext() {
  if (!robotEl || robotOverride) return;
  const freq = getFrequency();
  const idlePause = (freq.idleMin + Math.random() * (freq.idleMax - freq.idleMin)) * 1000;
  robotTimer = setTimeout(() => {
    if (!robotEl || robotOverride) return;
    if (Math.random() < freq.walkChance) {
      robotWalk();
    } else {
      robotDoActivity();
    }
  }, idlePause);
}

function robotWalk() {
  if (robotOverride) return;
  robotClearActivity();

  // Pick a random destination within the overlay (which starts after sidebar)
  const overlay = document.getElementById('robot-overlay');
  const overlayWidth = overlay ? overlay.clientWidth : window.innerWidth;
  const minX = 4;
  const maxX = Math.max(minX + 100, overlayWidth - 80);
  const dest = Math.floor(minX + Math.random() * (maxX - minX));
  const currentLeft = parseInt(robotEl.style.left) || 4;
  const distance = Math.abs(dest - currentLeft);
  const duration = Math.max(4, distance * 0.08); // ~0.08s per px, min 4s

  // Face the right direction
  robotFacingLeft = dest < currentLeft;
  robotEl.classList.toggle('face-left', robotFacingLeft);

  // Anticipation crouch before walking
  robotEl.classList.add('walk-anticipate');
  robotTimer = setTimeout(() => {
    robotEl.classList.remove('walk-anticipate');

    // Start walking
    robotEl.classList.add('walking');
    robotEl.style.transition = `left ${duration}s linear`;
    robotEl.style.left = dest + 'px';

    // After arriving, settle then do an activity
    robotTimer = setTimeout(() => {
      robotEl.classList.remove('walking');

      // Follow-through settle animation
      robotEl.classList.add('walk-arrive');
      robotTimer = setTimeout(() => {
        robotEl.classList.remove('walk-arrive');
        // Rest after walking (respects frequency)
        const f = getFrequency();
        robotTimer = setTimeout(() => robotNext(), (f.idleMin + Math.random() * (f.idleMax - f.idleMin)) * 1000);
      }, 300);
    }, duration * 1000);
  }, 200);
}

function robotDoActivity() {
  if (robotOverride) return;
  robotClearActivity();

  const idle = idleMs();
  const boredLevel = idle > 12 * 60000 ? 3 : idle > 8 * 60000 ? 2 : idle > 3 * 60000 ? 1 : 0;

  // Boredom level 3 (12+ min idle): force sleep
  if (boredLevel >= 3) {
    const sleepAct = ACTIVITIES.find(a => a.name === 'sleep');
    robotEl.classList.add(sleepAct.cls);
    showSpeech('Zzz...', 5000);
    const dur = sleepAct.duration[0] + Math.random() * (sleepAct.duration[1] - sleepAct.duration[0]);
    robotTimer = setTimeout(() => {
      robotClearActivity();
      robotNext();
    }, dur * 1000);
    return;
  }

  // Boredom level 2 (8+ min idle): 40% chance to wander with quip
  if (boredLevel >= 2 && Math.random() < 0.4) {
    showSpeech(BOREDOM_WALK_QUIPS[Math.floor(Math.random() * BOREDOM_WALK_QUIPS.length)], 2500);
    setTimeout(() => robotWalk(), 500);
    return;
  }

  // Pick activity — bias toward boring ones when idle
  let idx;
  const boringNames = ['stand', 'look', 'nod', 'think'];
  if (boredLevel >= 1 && Math.random() < 0.65) {
    const boringActs = ACTIVITIES.filter(a => boringNames.includes(a.name));
    const candidate = boringActs[Math.floor(Math.random() * boringActs.length)];
    idx = ACTIVITIES.indexOf(candidate);
  } else {
    do {
      idx = Math.floor(Math.random() * ACTIVITIES.length);
    } while (idx === lastActivityIndex && ACTIVITIES.length > 1);
  }
  lastActivityIndex = idx;

  const act = ACTIVITIES[idx];
  robotEl.classList.add(act.cls);

  if (act.speech) {
    showSpeech(act.speech);
  }
  if (act.name === 'sleep') {
    showSpeech('Zzz...');
  }

  // Occasional boredom quip while doing a boring activity
  const dur = act.duration[0] + Math.random() * (act.duration[1] - act.duration[0]);
  if (boredLevel >= 1 && boringNames.includes(act.name) && Math.random() < 0.3) {
    setTimeout(() => {
      if (!robotOverride) showSpeech(BOREDOM_IDLE_QUIPS[Math.floor(Math.random() * BOREDOM_IDLE_QUIPS.length)], 3000);
    }, (dur * 0.5) * 1000);
  }

  // Stay in this activity for its duration, then move on
  robotTimer = setTimeout(() => {
    robotClearActivity();
    // 50/50: walk somewhere or do another activity
    robotNext();
  }, dur * 1000);
}

function robotClearActivity() {
  if (!robotEl) return;
  robotEl.classList.remove('walking', 'face-left', 'walk-anticipate', 'walk-arrive', 'dragging', 'act-falling');
  for (const act of ACTIVITIES) {
    robotEl.classList.remove(act.cls);
  }
  robotEl.style.transition = 'none';
}

// --- Contextual Terminal Awareness ---

function sampleTerminalContext() {
  if (!robotEl || robotOverride) return;
  if (localStorage.getItem('ps-robot-enabled') === 'false') return;
  if (sessions.length === 0) return;

  // Sample the focused session's output buffer
  const session = sessions[focusedIndex];
  if (!session?.terminal?._outputBuffer) return;

  const buffer = session.terminal._outputBuffer;
  // Only look at the last 300 chars (recent output)
  const tail = buffer.slice(-300);

  for (const entry of CONTEXTUAL_QUIPS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(tail)) {
        const quip = entry.quips[Math.floor(Math.random() * entry.quips.length)];
        // Don't repeat the same quip
        if (quip === lastContextQuip) continue;
        lastContextQuip = quip;
        showSpeech(quip, 4000);
        return;
      }
    }
  }

  // Fallback: check multi-session awareness
  const workingCount = sessions.filter(s => s.status === 'Working').length;
  if (workingCount >= 3 && Math.random() < 0.3) {
    const multi = ['Busy day.', 'All hands on deck.', 'Full steam ahead.', `${workingCount} sessions cooking...`];
    const q = multi[Math.floor(Math.random() * multi.length)];
    if (q !== lastContextQuip) { lastContextQuip = q; showSpeech(q, 4000); }
    return;
  }

  // Long idle — suggest a break
  const idleSessions = sessions.filter(s => s.status === 'Idle').length;
  if (idleSessions === sessions.length && sessions.length > 0 && Math.random() < 0.15) {
    const idle = ['Coffee break?', 'All quiet.', 'Nice and calm.', 'Taking it easy...'];
    const q = idle[Math.floor(Math.random() * idle.length)];
    if (q !== lastContextQuip) { lastContextQuip = q; showSpeech(q, 3500); }
  }
}

function startContextScanning() {
  if (contextScanTimer) clearInterval(contextScanTimer);
  const freq = getFrequency();
  contextScanTimer = setInterval(sampleTerminalContext, freq.contextInterval);
}

function updateMascot(status, silent = false) {
  if (!robotEl) return;

  // Clear previous override
  robotEl.classList.remove('working', 'waiting', 'exited');

  if (status === 'Working') {
    robotOverride = 'working';
    clearTimeout(robotTimer);
    robotClearActivity();
    robotEl.classList.add('working');
    if (!silent) showSpeech(SPEECH_WORKING[Math.floor(Math.random() * SPEECH_WORKING.length)]);
  } else if (status === 'WaitingForInput' || status === 'NeedsPermission' || status === 'ClaudeNeedsInput') {
    robotOverride = 'waiting';
    clearTimeout(robotTimer);
    robotClearActivity();
    robotEl.classList.add('waiting', 'act-look');
    // Always speak for attention-needed statuses, even on tab switch
    showSpeech(SPEECH_WAITING[Math.floor(Math.random() * SPEECH_WAITING.length)]);
  } else if (status === 'Exited') {
    robotOverride = 'exited';
    clearTimeout(robotTimer);
    robotClearActivity();
    robotEl.classList.add('exited');
    if (!silent) showSpeech(SPEECH_DONE[Math.floor(Math.random() * SPEECH_DONE.length)]);
  } else {
    // Back to idle — resume autonomous behavior
    if (robotOverride) {
      robotOverride = null;
      robotNext();
    }
  }
}

function triggerMascotBounce() {
  // no-op now, status changes handled by updateMascot
}

function showSpeech(text, duration = 3000) {
  const el = document.getElementById('mascot-speech');
  if (!el) return;
  el.textContent = text;
  el.style.left = '50%';
  el.style.transform = 'translateX(-50%)';
  el.classList.add('visible');

  // Auto-reposition if clipped at viewport edges
  requestAnimationFrame(() => {
    const rect = el.getBoundingClientRect();
    if (rect.left < 8) {
      el.style.left = `calc(50% + ${8 - rect.left}px)`;
    } else if (rect.right > window.innerWidth - 8) {
      el.style.left = `calc(50% - ${rect.right - window.innerWidth + 8}px)`;
    }
  });

  setTimeout(() => el.classList.remove('visible'), duration);
}

function setupMascotSpeech() {
  robotInit();
  startTipTimer();
}

let lastTipIndex = -1;

function startTipTimer() {
  // Show a tip every 3-5 minutes
  function scheduleTip() {
    const delay = (3 + Math.random() * 2) * 60 * 1000; // 3-5 min
    setTimeout(() => {
      if (localStorage.getItem('ps-robot-enabled') === 'false') {
        scheduleTip();
        return;
      }
      // Pick a random tip, avoid repeating the last one
      let idx;
      do {
        idx = Math.floor(Math.random() * APP_TIPS.length);
      } while (idx === lastTipIndex && APP_TIPS.length > 1);
      lastTipIndex = idx;

      showSpeech('Tip: ' + APP_TIPS[idx], 6000);
      scheduleTip();
    }, delay);
  }
  scheduleTip();
}

// --- Welcome Message ---

async function showWelcomeMessage() {
  if (localStorage.getItem('ps-robot-enabled') === 'false') return;

  // Time and day awareness
  const hour = new Date().getHours();
  const day = new Date().getDay();
  let timeGreeting = null;
  if (hour >= 0 && hour < 5) {
    timeGreeting = ['Working this late? Respect.', 'Night owl mode.', 'Still at it.'][Math.floor(Math.random() * 3)];
  } else if (hour < 9) {
    timeGreeting = ['Good morning.', 'Early start.', 'Rise and code.'][Math.floor(Math.random() * 3)];
  } else if (hour >= 20) {
    timeGreeting = ['Burning the midnight oil.', 'Late session.', 'Still going.'][Math.floor(Math.random() * 3)];
  } else if (hour >= 17) {
    timeGreeting = ['Evening shift.', 'Almost done for the day.'][Math.floor(Math.random() * 2)];
  }

  let dayGreeting = null;
  if (day === 1) dayGreeting = 'Monday. Let\'s get it.';
  else if (day === 5) dayGreeting = 'Friday. Finish strong.';
  else if (day === 0 || day === 6) dayGreeting = 'Weekend dev? Dedication.';

  // Get the focused session's CWD for project context
  const session = sessions[focusedIndex];
  const cwd = session?.cwd;

  let projectName = null;
  let hint = null;

  if (cwd) {
    // Extract project name from path
    const parts = splitPath(cwd);
    projectName = parts[parts.length - 1];

    // Try to read Claude memories for this project
    try {
      const config = await invoke('read_claude_config', { projectPath: cwd });
      if (config.project_memory) {
        hint = extractHint(config.project_memory, projectName);
      }
    } catch {}
  }

  // Build the welcome message — time/day greetings take priority
  if (timeGreeting) {
    showSpeech(timeGreeting, 4000);
  } else if (dayGreeting) {
    showSpeech(dayGreeting, 4000);
  } else if (hint) {
    showSpeech(hint, 6000);
  } else if (projectName && projectName !== '~') {
    showSpeech(`Welcome back to ${projectName}.`, 4000);
  } else {
    const greetings = ['Ready to code.', 'Let\'s build something.', 'Standing by.', 'At your service.'];
    showSpeech(greetings[Math.floor(Math.random() * greetings.length)], 4000);
  }
}

function extractHint(memoryContent, projectName) {
  // Look for actionable context in the memory content
  const lines = memoryContent.split('\n').filter(l => l.trim());

  // Look for project description or current work items
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#>\s]+/, '').trim();
    if (!trimmed || trimmed.length < 10 || trimmed.length > 80) continue;

    // Skip metadata lines, links, and headers that are just titles
    if (/^(name:|description:|type:|---|\[.*\]\(.*\))/.test(trimmed)) continue;

    // Look for lines that describe the project or current work
    if (/stack|built with|uses|running|deploy|TODO|current|working on/i.test(trimmed)) {
      return trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed;
    }
  }

  // Fall back to first meaningful content line
  for (const line of lines) {
    const trimmed = line.replace(/^[-*#>\s]+/, '').trim();
    if (trimmed.length >= 15 && trimmed.length <= 70 &&
        !/^(name:|description:|type:|---|\[.*\]\(.*\)|```|#{1,3}\s)/.test(trimmed)) {
      return trimmed;
    }
  }

  return projectName ? `Working on ${projectName}` : null;
}

// --- Session Persistence ---

// --- Resizable Panels ---

function setupResizeHandles() {
  setupResize('sidebar-resize', document.getElementById('sidebar'), 'right');
  setupResize('fv-resize', document.getElementById('file-viewer'), 'left');
}

function setupResize(handleId, panel, side) {
  const handle = document.getElementById(handleId);
  if (!handle || !panel) return;

  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const delta = side === 'right' ? e.clientX - startX : startX - e.clientX;
      const newWidth = Math.max(140, Math.min(700, startWidth + delta));
      panel.style.width = newWidth + 'px';
      // Re-fit terminals as panel resizes
      fitVisibleTerminals();
    }

    function onUp() {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      fitVisibleTerminals();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function saveSessionState() {
  const data = {
    version: 3,
    layoutMode,
    snapToGrid,
    gridSplitRatios,
    sessions: sessions.map(s => ({
      name: s.name,
      cwd: s.cwd,
      minimized: s.minimized,
      freeformRect: s.freeformRect,
      scrollback: s.terminal.getScrollback(500), // Save last 500 lines
    })),
    focused_index: focusedIndex,
  };
  invoke('save_sessions', { json: JSON.stringify(data) }).catch(err => {
    console.warn('Failed to save session state:', err);
  });
}

// --- Init ---

document.addEventListener('DOMContentLoaded', async () => {
  setupNewSessionButton();
  setupShortcuts();
  setupResizeHandles();
  setupSidebarToggle();
  setupGitInfoClick();
  setupFooterExpand();
  setupConfigButtons();
  setupStatusListener();
  initFileViewer();
  loadSavedTheme();
  setupFreeformDrag();
  setupFreeformResize();
  setupGridGutterDrag();
  createLayoutToggle();

  // Listen for terminal theme changes from the theme designer
  window.addEventListener('theme-terminal-changed', (e) => {
    sessions.forEach(s => s.terminal.updateTheme(e.detail));
  });

  // Re-fit terminals when file viewer opens/closes
  window.addEventListener('file-viewer-changed', () => {
    requestAnimationFrame(() => fitVisibleTerminals());
  });

  // Refit terminals on app window resize
  window.addEventListener('resize', () => {
    if (layoutMode === 'freeform' && maximizedIndex === null) {
      const grid = document.getElementById('pane-grid');
      const gridRect = grid.getBoundingClientRect();
      sessions.forEach(s => {
        if (s.minimized || !s.freeformRect) return;
        const r = s.freeformRect;
        // Clamp position within grid bounds
        r.x = Math.max(0, Math.min(r.x, gridRect.width - r.width));
        r.y = Math.max(0, Math.min(r.y, gridRect.height - r.height));
        // If pane is larger than grid, shrink it
        if (r.width > gridRect.width) r.width = gridRect.width;
        if (r.height > gridRect.height) r.height = gridRect.height;
        s.pane.style.left = r.x + 'px';
        s.pane.style.top = r.y + 'px';
        s.pane.style.width = r.width + 'px';
        s.pane.style.height = r.height + 'px';
      });
    }
    // Refit all visible terminals — throttle coalesces rapid resize events
    fitVisibleTerminals();
  });

  // When file viewer opens, push fresh CWD immediately
  window.addEventListener('file-viewer-opened', async () => {
    const session = sessions[focusedIndex];
    if (!session?.id) return;
    try {
      const cwd = await invoke('get_process_cwd', { sessionId: session.id });
      if (cwd) {
        session.cwd = cwd;
        updateFileViewerCwd(cwd);
      }
    } catch (err) {
      console.warn('CWD fetch on viewer open:', err);
      // Fall back to session's stored CWD
      if (session.cwd) updateFileViewerCwd(session.cwd);
    }
  });

  // Listen for settings changes and apply to idle terminals
  window.addEventListener('settings-changed', (e) => {
    pendingTerminalSettings = e.detail;
    sessions.forEach(s => {
      if (s.status === 'Idle' || s.status === 'WaitingForInput' || !s.status) {
        s.terminal.applySettings(pendingTerminalSettings);
      }
    });
  });

  // Listen for robot toggle from settings
  window.addEventListener('robot-toggle', (e) => toggleRobot(e.detail));

  // Notification permission is handled by tauri-plugin-notification on first use

  // Socket API events
  listen('socket-notification', (event) => {
    const { title, body } = event.payload;
    addNotification(title || 'External', body || '', -1);
    // Also send desktop notification
    if (!windowFocused && localStorage.getItem('ps-notifications') !== 'false') {
      invoke('plugin:notification|is_permission_granted').then(granted => {
        if (granted) {
          const options = { title: title || 'PaneStreet', body: body || '' };
          if (localStorage.getItem('ps-notify-sound') !== 'false') options.sound = 'default';
          invoke('plugin:notification|notify', { options });
        }
      }).catch(() => {});
    }
  });

  listen('socket-focus', (event) => {
    const { session_id } = event.payload;
    const idx = sessions.findIndex(s => s.id === session_id);
    if (idx >= 0) {
      if (sessions[idx].minimized) restoreSession(idx);
      else setFocus(idx);
    }
  });

  // Window drag via Tauri startDragging — skip interactive elements only
  document.getElementById('toolbar').addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('a')) return;
    e.preventDefault();
    invoke('plugin:window|start_dragging');
  });

  // Close notification panel when file viewer opens
  window.addEventListener('panel-opening', (e) => {
    if (e.detail === 'file-viewer' && notifPanelVisible) hideNotificationPanel();
  });

  // Notification panel toggle
  document.getElementById('notification-toggle-btn').addEventListener('click', () => {
    toggleNotificationPanel();
  });
  document.getElementById('notif-close-btn').addEventListener('click', () => {
    hideNotificationPanel();
  });
  document.getElementById('notif-clear-btn').addEventListener('click', () => {
    notificationHistory.length = 0;
    unreadNotificationCount = 0;
    updateNotificationBadge();
    renderNotificationPanel();
  });

  // Listen for OSC terminal notifications (OSC 9/99/777)
  window.addEventListener('terminal-notification', (e) => {
    const { sessionId, title, body } = e.detail;
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return;
    const idx = sessions.indexOf(session);

    // Add notification ring if not focused
    if (idx !== focusedIndex) {
      session.pane.classList.add('notify-ring');
      const card = document.querySelectorAll('.session-card')[idx];
      if (card) card.classList.add('notify-badge');
    }

    // Add to notification history
    addNotification(session.name, `OSC: ${body}`, idx);

    // Send desktop notification if window not focused
    if (!windowFocused && localStorage.getItem('ps-notifications') !== 'false') {
      invoke('plugin:notification|is_permission_granted').then(granted => {
        if (granted) {
          const options = { title: title || 'PaneStreet', body: `${session.name}: ${body}` };
          if (localStorage.getItem('ps-notify-sound') !== 'false') options.sound = 'default';
          invoke('plugin:notification|notify', { options });
        }
      }).catch(() => {});
    }
  });

  // Initialize mascot
  setupMascotSpeech();

  // Try to restore sessions
  let restored = false;
  try {
    const json = await invoke('load_sessions');
    if (json) {
      const data = JSON.parse(json);
      if ((data.version === 1 || data.version === 2 || data.version === 3) && data.sessions?.length > 0) {
        // Restore layout mode from v2+ data
        if (data.version >= 2) {
          layoutMode = data.layoutMode || 'auto';
          snapToGrid = data.snapToGrid !== false;
          if (data.gridSplitRatios) gridSplitRatios = data.gridSplitRatios;
        }

        for (const saved of data.sessions) {
          // Restore scrollback before creating session
          const scrollback = saved.scrollback || null;
          await createSession(saved.cwd, scrollback);
          const idx = sessions.length - 1;
          if (saved.name) {
            sessions[idx].name = saved.name;
            sessions[idx].pane.querySelector('.pane-title').textContent = saved.name;
          }
          if (saved.minimized) {
            sessions[idx].minimized = true;
          }
          if (saved.freeformRect) {
            sessions[idx].freeformRect = saved.freeformRect;
          }
        }
        rebuildSidebar();
        updateGridLayout();
        updateFooterPills();
        updateLayoutToggleUI();
        if (data.focused_index >= 0 && data.focused_index < sessions.length) {
          setFocus(data.focused_index);
        }
        restored = true;
      }
    }
  } catch (err) {
    console.warn('Session restore failed:', err);
  }

  if (!restored) {
    await createSession();
  }

  // Welcome message after a brief delay (let CWD resolve)
  setTimeout(() => showWelcomeMessage(), 1500);

  // Check for updates on startup (non-blocking, dismissible)
  setTimeout(() => checkForUpdateOnStartup(), 3000);

  setInterval(() => {
    if (!windowFocused) return;
    updateGitInfo();
    if (isFileViewerVisible()) {
      const session = sessions[focusedIndex];
      if (session?.cwd) refreshDiffStats(session.cwd);
    }
  }, 5000);

  // Poll CWD for the focused session
  setInterval(async () => {
    if (!windowFocused) return;
    if (sessions.length === 0) return;
    const session = sessions[focusedIndex];
    if (!session?.id) return;
    try {
      const cwd = await invoke('get_process_cwd', { sessionId: session.id });
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        updateFileViewerCwd(cwd);
        setFocusedCwd(cwd);
        updateGitInfo();
        updateSidebarMeta();
      }
    } catch (err) {
      console.warn('CWD poll error:', err);
    }
  }, 2000);

  // Poll listening ports for all sessions (less frequent)
  setInterval(async () => {
    if (!windowFocused) return;
    for (const session of sessions) {
      if (!session?.id) continue;
      try {
        const ports = await invoke('get_listening_ports', { sessionId: session.id });
        session._ports = ports || [];
      } catch {
        session._ports = [];
      }
    }
    updateSidebarMeta();
  }, 5000);

  // Poll PR status for focused session (infrequent, uses gh CLI)
  setInterval(async () => {
    if (!windowFocused) return;
    const session = sessions[focusedIndex];
    if (!session?.cwd) return;
    try {
      const pr = await invoke('get_pr_status', { cwd: session.cwd });
      session._pr = pr;
    } catch {
      session._pr = null;
    }
    updateSidebarMeta();
  }, 30000); // Every 30s — gh CLI is slow

  // Initial PR fetch after a delay
  setTimeout(async () => {
    const session = sessions[focusedIndex];
    if (!session?.cwd) return;
    try {
      const pr = await invoke('get_pr_status', { cwd: session.cwd });
      session._pr = pr;
      updateSidebarMeta();
    } catch {}
  }, 3000);
});
