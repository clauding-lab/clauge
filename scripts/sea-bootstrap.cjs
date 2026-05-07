// SEA bootstrap — loads the bundled ESM server out of the SEA blob.
//
// Why this exists: Node 22's SEA loader loads the `main` entry as CommonJS.
// Our server uses top-level await + import.meta, so it must run as ESM.
// We bundle server.js + lib/ to dist/server.bundle.mjs (ESM) and embed it
// as a SEA asset. This bootstrap (CJS) extracts the asset to a temp file
// and dynamic-imports it. The temp file is required because import() refuses
// to load very large data: URLs reliably across Node versions.

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

const bundle = sea.getAsset('dist/server.bundle.mjs');
const buf = Buffer.from(bundle);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauge-sea-'));
const tmpFile = path.join(tmpDir, 'server.bundle.mjs');
fs.writeFileSync(tmpFile, buf);

// Best-effort cleanup. Errors here are non-fatal — the OS reaps temp files.
const cleanup = () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

import(tmpFile).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[clauge] Failed to load embedded ESM server:', err);
  cleanup();
  process.exit(1);
});
