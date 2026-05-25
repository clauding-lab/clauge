#!/usr/bin/env node
// Architecture guardrail (v0.9.4 Phase B.7).
//
// Forbid hardcoded `:3456` (and other port literals) in URL strings under
// popover/. The default port lives in server.js's PORT env handling; every
// other consumer must read it from one of:
//   - `window.location.port` (popover served by the local sidecar)
//   - `serverPort` derived from the above (popover.js state)
//   - `/api/health` (live runtime check)
//   - `configPaths.portFile()` (CLI / dashboard cold start)
//
// Hardcoded literals are dangerous because the sidecar falls back to 3457+
// when 3456 is busy (crash-respawn, two Clauge instances, port collision
// with the dev tools). A literal `:3456` will fail silently in those cases.
//
// What's allowed:
//   - Bare numeric `3456` as a fallback (e.g. `let serverPort = 3456`)
//   - `:3456` inside comments / doc strings
//   - `:3456` in test fixtures (test/ is not scanned)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT
  ? path.resolve(process.env.CLAUGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
const SCAN_DIRS = ['popover'];

// Match :NNNN where NNNN is 4-5 digits and looks like a port literal in a
// URL or host:port context. Skip bare numbers without the colon prefix —
// those are likely defaults or non-URL values.
const PORT_RE = /:(3456|3457|3458|3459|3460)\b/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (/\.(js|cjs|mjs|html|css)$/.test(e.name)) {
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
      if (!PORT_RE.test(line)) continue;
      const trimmed = line.trim();
      // Skip comment lines (JS // or /* */; HTML/CSS comment markers are
      // sloppier but a leading * still indicates a JSDoc-style comment).
      if (trimmed.startsWith('//') || trimmed.startsWith('*') ||
          trimmed.startsWith('<!--') || trimmed.startsWith('/*')) continue;
      hits.push(`${path.relative(REPO_ROOT, f)}:${i + 1}: ${trimmed}`);
    }
  }

  if (hits.length > 0) {
    console.error('[validate-no-hardcoded-port] FAIL — hardcoded port literal in popover/:\n');
    for (const h of hits) console.error('  ' + h);
    console.error('\nUse window.location.port (relative URLs in popover) or /api/health for live discovery.');
    process.exit(1);
  }

  process.stdout.write(`[validate-no-hardcoded-port] OK - scanned ${files.length} files in popover/\n`);
}

main();
