// Shared port-file reader for CLI subcommands. The sidecar writes its bound
// port to configPaths.portFile() (never hardcode 3456 — fallback binding
// shifts ports to 3457-3460). Extracted from config-get.js for reuse by
// the Clauge Widget (`clauge status`).

import { readFile } from 'node:fs/promises';
import { configPaths } from '../config-paths.js';

/**
 * Read the sidecar's active port from the port file.
 * @returns {Promise<number|null>} the port, or null when absent/garbage.
 */
export async function readActivePort() {
  try {
    const raw = await readFile(configPaths.portFile(), 'utf8');
    const port = parseInt(raw.trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}
