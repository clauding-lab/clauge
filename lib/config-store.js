/**
 * Sidecar-owned persistent config (~/.clauge/config.json).
 *
 * Holds the user's subscription cost (Component 4 of the on-device
 * projection spec). DELIBERATELY a sidecar-owned file, NOT the shared Tauri
 * settings.json: since v1.1.0 the Rust iCloud publish loop calls
 * store.save() at least every 300s and tauri-plugin-store rewrites the
 * whole file from its in-memory map — any key the sidecar wrote after the
 * store loaded would be silently erased within minutes. This file has
 * exactly one writer: the sidecar.
 *
 * Read precedence for the subscription cost:
 *   1. file value (~/.clauge/config.json :: subscriptionCost)
 *   2. SUBSCRIPTION_COST env var
 *   3. 200 (default)
 * Read-side validation at EVERY tier: a value that is not a finite number
 * > 0 is treated as ABSENT and falls through to the next tier — a
 * hand-edited 0, negative, or string never reaches the ROI math.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_SUBSCRIPTION_COST = 200;

function defaultPath() {
  return join(homedir(), '.clauge', 'config.json');
}

/**
 * Read-side validation: returns the value when it is a finite number > 0,
 * otherwise null (treated as absent — caller falls through to next tier).
 * Strict typeof check: a JSON string "250" in the file is NOT coerced.
 * @param {unknown} value
 * @returns {number|null}
 */
function validCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export class ConfigStore {
  constructor({ filePath = defaultPath(), env = process.env } = {}) {
    this.filePath = filePath;
    this.env = env;
  }

  /**
   * Effective subscription cost: file -> env -> 200. Reads the file per
   * call (no cache) so a hand edit or another instance's write is picked
   * up immediately; the file is tiny and the endpoints are low-traffic.
   * @returns {Promise<number>}
   */
  async effectiveSubscriptionCost() {
    let fileValue = null;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      fileValue = validCost(parsed?.subscriptionCost);
    } catch {
      // Missing or corrupt file — treated as absent, fall through.
    }
    if (fileValue != null) return fileValue;

    // Env vars are strings — coerce with Number() THEN validate. A
    // non-numeric, empty, zero, negative, or non-finite env value is
    // treated as absent (Number('') === 0 and Number('abc') is NaN;
    // both fail validCost).
    const envValue = validCost(Number(this.env?.SUBSCRIPTION_COST));
    if (envValue != null) return envValue;

    return DEFAULT_SUBSCRIPTION_COST;
  }

  /**
   * Persist a new subscription cost. Validates (finite number > 0, strict
   * type) and writes atomically (tmp + rename) so a crash mid-write can
   * never leave a torn config.json.
   * @param {number} n
   * @returns {Promise<number>} the persisted value
   */
  async setSubscriptionCost(n) {
    if (validCost(n) == null) {
      throw new Error(
        `subscriptionCost must be a finite number > 0, got: ${String(n)}`
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify({ v: 1, subscriptionCost: n }, null, 2),
      { mode: 0o600 }
    );
    await rename(tmpPath, this.filePath);
    return n;
  }
}
