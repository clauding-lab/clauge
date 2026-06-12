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
import { dirname } from 'node:path';

import { configPaths } from './config-paths.js';
import { ALERT_TYPES } from './alert-engine.js';

const DEFAULT_SUBSCRIPTION_COST = 200;

function defaultPath() {
  // Single source of truth for the on-disk path; honors CLAUGE_HOME so
  // tests can sandbox under a tmpdir (AGENTS.md landmine #14).
  return configPaths.configFile();
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

// The per-type alert flags, in a fixed order so reads/writes are
// deterministic. These are the type names evaluate() reads via prefs.types
// (lib/alert-engine.js candidatesFor: types.approaching/willHit/limitReached) —
// imported as the single source of truth so a new type flows to both modules.
const ALERT_TYPE_KEYS = ALERT_TYPES;

/**
 * Resolve a raw config object into the defaulted alert-prefs view evaluate()
 * expects. Pure (no I/O) so effectiveAlertPrefs and setAlertPrefs can share one
 * file read. Missing/corrupt block or flags default all-on (per-flag coercion).
 * @param {Record<string, unknown>} all
 * @returns {{alertsEnabled: boolean, types: {approaching: boolean, willHit: boolean, limitReached: boolean}}}
 */
function resolveAlertPrefs(all) {
  const block = all.alerts && typeof all.alerts === 'object' ? all.alerts : {};
  const rawTypes = block.types && typeof block.types === 'object' ? block.types : {};
  const types = {};
  for (const key of ALERT_TYPE_KEYS) {
    types[key] = coerceBool(rawTypes[key]);
  }
  return { alertsEnabled: coerceBool(block.enabled), types };
}

/**
 * Coerce one alert flag to a boolean. A real boolean is honored; anything
 * else (missing, string, number, null) falls back to the default — which is
 * always `true` (all-on). Mirrors validCost's "invalid -> absent" stance.
 * @param {unknown} value
 * @returns {boolean}
 */
function coerceBool(value) {
  return typeof value === 'boolean' ? value : true;
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
   * Read the whole config object, tolerant of a missing or corrupt file.
   * Returns a plain object ({} when absent/corrupt) so callers can always
   * spread-merge into it. Never throws.
   * @returns {Promise<Record<string, unknown>>}
   */
  async readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  /**
   * Atomically persist the whole config object (tmp + rename), stamping
   * v:1. The single writer for config.json — every mutating method funnels
   * through here so a partial write can never leave a torn file.
   * @param {Record<string, unknown>} obj
   * @returns {Promise<void>}
   */
  async writeAll(obj) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ v: 1, ...obj }, null, 2), {
      mode: 0o600,
    });
    await rename(tmpPath, this.filePath);
  }

  /**
   * Persist a new subscription cost via read-merge-write so unrelated keys
   * (the alerts block) survive. Validates (finite number > 0, strict type).
   * @param {number} n
   * @returns {Promise<number>} the persisted value
   */
  async setSubscriptionCost(n) {
    if (validCost(n) == null) {
      throw new Error(
        `subscriptionCost must be a finite number > 0, got: ${String(n)}`
      );
    }
    const current = await this.readAll();
    await this.writeAll({ ...current, subscriptionCost: n });
    return n;
  }

  /**
   * Effective alert prefs: the file's `alerts` block with every field
   * defaulted to true. A missing/corrupt file or missing block = all-on.
   * Each flag is coerced (non-boolean -> default true). Shape matches what
   * lib/alert-engine.js's evaluate() expects as `prefs`.
   * @returns {Promise<{alertsEnabled: boolean, types: {approaching: boolean, willHit: boolean, limitReached: boolean}}>}
   */
  async effectiveAlertPrefs() {
    return resolveAlertPrefs(await this.readAll());
  }

  /**
   * Merge a partial alert-prefs update into the file's `alerts` block via
   * read-merge-write (preserving subscriptionCost). Validates that every
   * provided flag is a real boolean (throws otherwise — a bad write must not
   * silently no-op). Returns the effective prefs after the merge.
   * @param {{enabled?: boolean, types?: {approaching?: boolean, willHit?: boolean, limitReached?: boolean}}} partial
   * @returns {Promise<{alertsEnabled: boolean, types: object}>}
   */
  async setAlertPrefs(partial = {}) {
    if ('enabled' in partial && typeof partial.enabled !== 'boolean') {
      throw new Error(`alerts.enabled must be a boolean, got: ${String(partial.enabled)}`);
    }
    const partialTypes = partial.types && typeof partial.types === 'object' ? partial.types : {};
    for (const key of ALERT_TYPE_KEYS) {
      if (key in partialTypes && typeof partialTypes[key] !== 'boolean') {
        throw new Error(`alerts.types.${key} must be a boolean, got: ${String(partialTypes[key])}`);
      }
    }
    // Read once: merge base and write base share the same snapshot. Merge
    // against the CURRENT effective prefs so toggling one flag preserves the
    // others (the merge base is the resolved, defaulted view).
    const all = await this.readAll();
    const current = resolveAlertPrefs(all);
    const merged = {
      enabled: 'enabled' in partial ? partial.enabled : current.alertsEnabled,
      types: { ...current.types },
    };
    for (const key of ALERT_TYPE_KEYS) {
      if (key in partialTypes) merged.types[key] = partialTypes[key];
    }
    await this.writeAll({ ...all, alerts: merged });
    return { alertsEnabled: merged.enabled, types: merged.types };
  }
}
