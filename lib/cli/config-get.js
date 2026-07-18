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

import { listProviders } from '../providers.js';
import { fetchWithTimeout } from '../http.js';
import { readActivePort } from './active-port.js';

const HTTP_TIMEOUT_MS = 2000;

async function fetchLiveConfig(port, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/config`, {}, HTTP_TIMEOUT_MS, fetchImpl);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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
