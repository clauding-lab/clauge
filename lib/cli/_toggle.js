// Shared helper for enable/disable subcommands. Tries HTTP-first
// (POST /api/config/providers/:name) against a running Clauge, falls
// back to a direct settings.json write when offline.
//
// Returns process exit code. Errors go to stderr.

import { readFile } from 'node:fs/promises';
import { configPaths } from '../config-paths.js';
import { PROVIDERS, listProviders } from '../providers.js';
import { setProviderEnabled } from '../settings-writer.js';
import { fetchWithTimeout } from '../http.js';

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

async function postLive(port, name, enabled, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/api/config/providers/${name}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
      HTTP_TIMEOUT_MS,
      fetchImpl,
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Toggle a provider's enabled state. Validates name, then writes via
 * HTTP (if running) or disk (offline). Prints a one-line confirmation
 * including the via-path (live / disk) so the user knows which
 * mechanism took effect.
 *
 * @param {{ name: string, enabled: boolean, fetchImpl?: typeof fetch }} args
 * @returns {Promise<number>} exit code
 */
export async function toggleProvider({ name, enabled, fetchImpl }) {
  const known = new Set(PROVIDERS.map((p) => p.name));
  if (!known.has(name)) {
    process.stderr.write(`unknown provider: ${name}\n`);
    process.stderr.write(`known: ${[...known].join(', ')}\n`);
    return 2;
  }

  const port = await readActivePort();
  if (port !== null) {
    const live = await postLive(port, name, enabled, fetchImpl);
    if (live && live.provider) {
      const status = live.provider.enabled ? 'enabled' : 'disabled';
      process.stdout.write(`${name}: ${status} (live, via running Clauge on port ${port})\n`);
      return 0;
    }
    // Fall through to disk path; running Clauge unreachable or returned an error.
  }

  await setProviderEnabled(name, enabled);
  const refreshed = await listProviders();
  const entry = refreshed.find((p) => p.name === name);
  const status = entry?.enabled ? 'enabled' : 'disabled';
  const note = port === null ? 'disk write — Clauge not running' : 'disk write — running Clauge unreachable';
  process.stdout.write(`${name}: ${status} (${note})\n`);
  return 0;
}
