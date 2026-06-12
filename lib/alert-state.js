/**
 * Sidecar-owned fired-alert state (~/.clauge/alert-state.json).
 * Spec: docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md
 *
 * Records which alert dedup keys have already fired so an alert fires once
 * per window-instance even across restarts. DELIBERATELY a sidecar-owned
 * dotfile beside config.json (NOT the shared Tauri settings.json — landmine
 * #40: the Rust iCloud-publish loop rewrites settings.json and would clobber
 * any sidecar-written key). Exactly one writer: the sidecar.
 *
 * Atomic tmp+rename persistence (the lib/config-store.js pattern). load()
 * prunes keys whose embedded resetsAt has already passed (bounds the file)
 * and tolerates a missing/corrupt file (-> empty set, never throws). No
 * clock in lib/: load() takes nowMs as a parameter.
 *
 * Shape: { "v": 1, "fired": ["approaching:fiveHour:80:<iso>", ...] }.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { configPaths } from './config-paths.js';

function defaultPath() {
  return configPaths.alertStateFile();
}

/**
 * Recover the embedded resetsAt (ISO-8601, itself colon-bearing) from a
 * dedup key. Anchors on the first 4-digit-year date segment to the end.
 * Returns the parsed epoch ms, or null when no ISO timestamp is present.
 * @param {string} key
 * @returns {number|null}
 */
function resetsAtMsFromKey(key) {
  if (typeof key !== 'string') return null;
  const m = key.match(/:(\d{4}-\d{2}-\d{2}T.*)$/);
  if (m == null) return null;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

export class AlertState {
  constructor({ filePath = defaultPath() } = {}) {
    this.filePath = filePath;
  }

  /**
   * Load the fired-key set, pruned of keys whose embedded resetsAt is <=
   * nowMs (or unparseable). Missing/corrupt file -> empty Set. Never throws.
   * @param {number} nowMs
   * @returns {Promise<Set<string>>}
   */
  async load(nowMs) {
    let keys = [];
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.fired)) keys = parsed.fired;
    } catch {
      // Missing or corrupt — treated as no alerts fired.
      return new Set();
    }
    const live = new Set();
    for (const key of keys) {
      const ms = resetsAtMsFromKey(key);
      if (ms == null || ms <= nowMs) continue; // reset already passed / bad
      live.add(key);
    }
    return live;
  }

  /**
   * Union `keys` into the persisted fired set and write atomically (tmp +
   * rename) so a crash mid-write can never leave a torn file. Reads the
   * current set first so concurrent markers don't lose each other's keys.
   * @param {Iterable<string>} keys
   * @returns {Promise<void>}
   */
  async markFired(keys) {
    let existing = [];
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.fired)) existing = parsed.fired;
    } catch {
      // Missing or corrupt — start fresh.
    }
    const union = new Set(existing);
    for (const k of keys) union.add(k);

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify({ v: 1, fired: [...union] }, null, 2),
      { mode: 0o600 }
    );
    await rename(tmpPath, this.filePath);
  }
}
