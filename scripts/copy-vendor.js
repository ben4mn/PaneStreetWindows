#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const vendor = path.join(root, 'src', 'vendor');

function copyRecursive(src, dest) {
  if (fs.statSync(src).isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// xterm.js core
const xtermSrc = path.join(nm, '@xterm', 'xterm');
const xtermDest = path.join(vendor, 'xterm');
fs.mkdirSync(xtermDest, { recursive: true });
fs.copyFileSync(path.join(xtermSrc, 'lib', 'xterm.mjs'), path.join(xtermDest, 'xterm.mjs'));
fs.copyFileSync(path.join(xtermSrc, 'css', 'xterm.css'), path.join(xtermDest, 'xterm.css'));

// xterm addons
const addons = ['addon-fit', 'addon-webgl', 'addon-web-links', 'addon-search'];
for (const addon of addons) {
  const src = path.join(nm, '@xterm', addon, 'lib', `${addon}.mjs`);
  const dest = path.join(vendor, 'xterm', `${addon}.mjs`);
  fs.copyFileSync(src, dest);
}

// Tauri API — copy the whole package (it has internal relative imports)
const tauriSrc = path.join(nm, '@tauri-apps', 'api');
const tauriDest = path.join(vendor, 'tauri-api');
fs.mkdirSync(tauriDest, { recursive: true });

// Copy all .js files and the external directory
for (const entry of fs.readdirSync(tauriSrc)) {
  const srcPath = path.join(tauriSrc, entry);
  const destPath = path.join(tauriDest, entry);
  if (entry.endsWith('.js') || entry === 'external') {
    copyRecursive(srcPath, destPath);
  }
}

console.log('Vendor files copied to src/vendor/');
