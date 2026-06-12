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
 * Atomic tmp+rename persistence (the lib/config-store.js pattern). Both
 * load() (in-memory) and markFired() (on write) prune keys whose embedded
 * resetsAt has already passed — the on-write prune is what actually bounds the
 * file on disk. Tolerates a missing/corrupt file (-> empty set, never throws).
 * No clock in lib/: both methods take nowMs as a parameter.
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

// Keys whose window has NOT yet reset (embedded resetsAt > nowMs). Drops
// unparseable keys and any whose reset has passed. Shared by load (in-memory
// prune of the returned Set) and markFired (prune-on-write that bounds disk).
function liveKeys(keys, nowMs) {
  const live = new Set();
  for (const key of keys) {
    const ms = resetsAtMsFromKey(key);
    if (ms == null || ms <= nowMs) continue;
    live.add(key);
  }
  return live;
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
    return liveKeys(keys, nowMs);
  }

  /**
   * Union `keys` into the persisted fired set, PRUNE keys whose window has
   * already reset (or are unparseable), and write atomically (tmp + rename) so
   * a crash mid-write can never leave a torn file. Pruning on write is what
   * actually bounds the file on disk — load() only prunes the in-memory result.
   * The read-then-write is NOT lost-update-safe on its own; safety comes from
   * the single-writer invariant (landmine #40 — the sidecar is the sole writer
   * and its alert loop marks sequentially). nowMs injected (no clock read here).
   * @param {Iterable<string>} keys
   * @param {number} nowMs
   * @returns {Promise<void>}
   */
  async markFired(keys, nowMs) {
    let existing = [];
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed?.fired)) existing = parsed.fired;
    } catch {
      // Missing or corrupt — start fresh.
    }
    const union = new Set(existing);
    for (const k of keys) union.add(k);
    // Prune the union before persisting so expired/garbage keys never
    // accumulate on disk (bounds the file; the comment above is now true).
    const live = liveKeys(union, nowMs);

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify({ v: 1, fired: [...live] }, null, 2),
      { mode: 0o600 }
    );
    await rename(tmpPath, this.filePath);
  }
}
