// SEA bootstrap — extracts embedded assets and loads the bundled ESM server.
//
// Why this exists: Node 22's SEA loader loads the `main` entry as CommonJS.
// Our server uses top-level await + import.meta, so it must run as ESM.
// We bundle server.js + lib/ to dist/server.bundle.mjs (ESM) and embed it
// (plus public/ static assets and the LiteLLM fallback JSON) as SEA assets.
// This bootstrap (CJS) extracts all assets to a temp dir, preserving the
// relative paths the bundle expects, then dynamic-imports the bundle. The
// temp file is required because import() refuses to load very large data:
// URLs reliably across Node versions.
//
// Asset key layout (must match scripts/sea-config.json):
//   server.bundle.mjs              → <tmpDir>/server.bundle.mjs
//   litellm-prices.fallback.json   → <tmpDir>/litellm-prices.fallback.json
//   public/<file>                  → <tmpDir>/public/<file>
//
// The bundled code's `__dirname` resolves to <tmpDir> (where the bundle lives),
// so `join(__dirname, 'public')` and `join(__dirname, 'litellm-prices.fallback.json')`
// both find their assets at the expected location.

'use strict';

const sea = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!sea.isSea()) {
  // eslint-disable-next-line no-console
  console.error('[clauge] SEA bootstrap was invoked outside an SEA build.');
  process.exit(1);
}

// Hardcoded asset list. Must mirror sea-config.json's `assets` keys.
// Kept hardcoded (not auto-discovered) so any drift is loud, not silent.
const ASSETS = [
  'server.bundle.mjs',
  'litellm-prices.fallback.json',
  'package.json',
  'public/index.html',
  'public/app.js',
  'public/connections.js',
  'public/styles.css',
  'public/clauge-icon-1024.svg',
  'public/clauge-icon-512.svg',
  'public/clauge-icon-fallback.png',
  'public/clauge-menubar-18px.svg',
  'public/popover/index.html',
  'public/popover/popover.js',
  'public/popover/popover.css',
  'public/popover/fonts/inter-latin-variable.woff2',
  'public/popover/fonts/jetbrains-mono-latin-variable.woff2',
];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauge-sea-'));

for (const key of ASSETS) {
  const buf = Buffer.from(sea.getAsset(key));
  const dest = path.join(tmpDir, key);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// Best-effort cleanup. Errors here are non-fatal — the OS reaps temp files.
// We register only on `exit` (fires regardless of how the process ends).
// SIGINT/SIGTERM are deliberately NOT handled here: the bundled server has
// its own SIGINT/SIGTERM handlers that call `server.close()` to drain
// in-flight requests. If we also called process.exit() here, it would race
// with — and likely kill — that drain.
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

const bundlePath = path.join(tmpDir, 'server.bundle.mjs');
import(bundlePath).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[clauge] Failed to load embedded ESM server:', err);
  process.exit(1);
});
