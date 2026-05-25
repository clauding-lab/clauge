#!/usr/bin/env node
// Architecture guardrail (v0.9.4 Phase B.7).
//
// Forbid `console.log` in lib/ and popover/. These are user-facing surfaces
// — debug noise from console.log clutters the dashboard's DevTools console
// and ships in production builds with no log-level filter.
//
// What's allowed:
//   - console.error / console.warn / console.info — intentional reporting
//   - console.log in server.js — startup banner is parsed by the Tauri
//     shell ("Listening on http://...") and is load-bearing
//   - console.log in scripts/ + test/ — those are build/CI surfaces
//   - console.log on a comment line (// or *) — documentation reference

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT
  ? path.resolve(process.env.CLAUGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
const SCAN_DIRS = ['lib', 'popover'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (/\.(js|cjs|mjs)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(path.join(REPO_ROOT, d)));

  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\bconsole\.log\s*\(/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      hits.push(`${path.relative(REPO_ROOT, f)}:${i + 1}: ${trimmed}`);
    }
  }

  if (hits.length > 0) {
    console.error('[validate-no-console-log] FAIL — console.log in production JS:\n');
    for (const h of hits) console.error('  ' + h);
    console.error('\nUse console.warn / console.error / console.info instead, ' +
                  'or rip it out if it was for debugging.');
    process.exit(1);
  }

  process.stdout.write(`[validate-no-console-log] OK - scanned ${files.length} JS files in lib/ + popover/\n`);
}

main();
