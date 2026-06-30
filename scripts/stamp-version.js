#!/usr/bin/env node
'use strict';

// Updates every hardcoded version string in the repo to match the given
// version. Run before a release or called by CI via:
//   node scripts/stamp-version.js 0.7.0
//
// Files updated:
//   server/src/server.js      — const VERSION = '...'
//   server/package.json       — "version": "..."
//   desktop/package.json      — "version": "..."

const fs = require('fs');
const path = require('path');

const ver = process.argv[2];
if (!ver || !/^\d+\.\d+\.\d+/.test(ver)) {
  console.error('Usage: node scripts/stamp-version.js <version>  e.g. 0.7.0');
  process.exit(1);
}

const root = path.join(__dirname, '..');

function stampJson(file) {
  const full = path.join(root, file);
  const obj = JSON.parse(fs.readFileSync(full, 'utf8'));
  obj.version = ver;
  fs.writeFileSync(full, JSON.stringify(obj, null, 2) + '\n');
  console.log(`  ${file}  →  ${ver}`);
}

function stampJs(file, pattern, replacement) {
  const full = path.join(root, file);
  const before = fs.readFileSync(full, 'utf8');
  const after = before.replace(pattern, replacement);
  if (before === after) { console.warn(`  WARNING: no match in ${file}`); return; }
  fs.writeFileSync(full, after);
  console.log(`  ${file}  →  ${ver}`);
}

console.log(`Stamping version ${ver}...`);
stampJson('server/package.json');
stampJson('desktop/package.json');
stampJs('server/src/server.js', /const VERSION = '[^']*';/, `const VERSION = '${ver}';`);
console.log('Done.');
