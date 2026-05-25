// `clauge config get` — print Clauge config as JSON.
//
// Resolution order:
//   1. Read port file (configPaths.portFile()). If present + the port
//      responds to /api/config, return the live payload merged with
//      { running: true, port }.
//   2. Otherwise fall back to settings.json on disk + the static
//      provider catalogue. Returned as { running: false, providers }.
//
// Network failure modes (no port file, connection refused, server
// down, 5xx, timeout) all fall through to the disk path with no
// noise on stderr — `running: false` is the explicit signal.

import { readFile } from 'node:fs/promises';
import { configPaths } from '../config-paths.js';
import { listProviders } from '../providers.js';

const HTTP_TIMEOUT_MS = 2000;

async function readActivePort() {
  try {
    const raw = await readFile(configPaths.portFile(), 'utf8');
    const port = parseInt(raw.trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function fetchLiveConfig(port, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/config`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compose the config object the CLI prints. Pure aside from the IO
 * helpers, so tests can swap in a stub fetch.
 *
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<object>}
 */
export async function buildConfigOutput(opts = {}) {
  const port = await readActivePort();
  if (port !== null) {
    const live = await fetchLiveConfig(port, opts.fetchImpl);
    if (live) return { running: true, port, ...live };
  }
  // Offline fallback.
  const providers = await listProviders();
  return { running: false, providers };
}

/**
 * Dispatcher entrypoint. Returns process exit code.
 */
export async function run(_parsed) {
  const out = await buildConfigOutput();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}
