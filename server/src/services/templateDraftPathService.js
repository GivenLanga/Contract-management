'use strict';

const path = require('path');
const fs = require('fs');

// Replace chars that are unsafe in filenames on any OS.
function sanitizeFilename(name) {
  return String(name || '')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled';
}

// Find a non-colliding draft filename in destDir.
// Pattern: "{safeTitle} - Draft v1{ext}", then v2, v3, …
// Returns { filename, filePath }.
function resolveDraftFilename(destDir, safeTitle, ext) {
  for (let v = 1; v <= 99; v++) {
    const fn = `${safeTitle} - Draft v${v}${ext}`;
    const fp = path.join(destDir, fn);
    if (!fs.existsSync(fp)) return { filename: fn, filePath: fp };
  }
  // Rare: 99 versions already exist — append a time-based suffix.
  const fn = `${safeTitle} - Draft-${Date.now().toString(36)}${ext}`;
  return { filename: fn, filePath: path.join(destDir, fn) };
}

module.exports = { sanitizeFilename, resolveDraftFilename };
