/**
 * Downsampled usage-history recorder for the on-device projection engine.
 *
 * POST /api/usage/ingest calls record() fire-and-forget AFTER normalizeUsage
 * — a recorder failure must NEVER fail an ingest (record catches everything
 * and console.warn's). Samples land in ~/.clauge/usage-history.jsonl beside
 * usage.json, append-only JSON Lines: a crash mid-write loses at most one
 * line. lib/projection.js consumes samplesFor(key) per window.
 *
 * Line shape (v1): {"v":1,"at":"<ISO>","w":{<only non-null resolved windows>}}
 *
 * Spec: docs/superpowers/specs/2026-06-12-on-device-projection-design.md
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/** Append at most one sample per this interval (extension posts ~1/min). */
export const SAMPLE_INTERVAL_MS = 300000; // 5 min

/** prune() drops samples older than this many days. */
export const RETENTION_DAYS = 90;

const RETENTION_MS = RETENTION_DAYS * 86400000;

// Exhaustive allowlist: exactly the six RESOLVED window keys. The legacy
// raw-codename duplicates normalizeUsage also emits (sevenDayOmelette,
// sevenDayCowork — same windows as the resolved pair) and the non-window
// fields (extraUsage, unknownSevenDayKeys) are EXCLUDED. Mirrors
// WINDOW_MS in lib/projection.js — keep the two key lists in sync.
const WINDOW_KEYS = [
  'fiveHour',
  'sevenDay',
  'sevenDaySonnet',
  'sevenDayOpus',
  'claudeDesign',
  'dailyRoutines',
];

// Drift-tripwire ambiguous zone: resetsAt moved by MORE than the projection
// engine's same-window tolerance (5 min) but LESS than a real window change
// would move it (hours/days — 1 h is the conservative floor), while pct
// kept rising (so it was NOT a reset). Mirrors SAME_WINDOW_TOLERANCE_MS in
// lib/projection.js.
const DRIFT_ZONE_MIN_MS = 300000; // 5 min
const DRIFT_ZONE_MAX_MS = 3600000; // 1 h

function defaultPath() {
  return join(homedir(), '.clauge', 'usage-history.jsonl');
}

function parseMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Emit a drift warning when two consecutive samples of one window land in
 * the ambiguous resetsAt zone (delta between 5 min and 1 h) while pct rose
 * — evidence the ±5 min same-window tolerance in lib/projection.js may be
 * too tight, which would silently degrade forecasts. Pure + log-injectable
 * (pattern: lib/usage-store.js::unknownKeysWarning). Returns true iff a
 * warning was emitted.
 *
 * @param {string} key  window key (e.g. 'fiveHour')
 * @param {{ pct: number | null, resetsAt: string | null }} prev
 * @param {{ pct: number | null, resetsAt: string | null }} next
 * @param {(message: string) => void} log
 * @returns {boolean}
 */
export function resetsAtDriftWarning(key, prev, next, log) {
  const prevResetMs = parseMs(prev?.resetsAt);
  const nextResetMs = parseMs(next?.resetsAt);
  if (prevResetMs == null || nextResetMs == null) return false;
  if (!Number.isFinite(prev?.pct) || !Number.isFinite(next?.pct)) return false;
  const delta = Math.abs(nextResetMs - prevResetMs);
  if (delta <= DRIFT_ZONE_MIN_MS || delta >= DRIFT_ZONE_MAX_MS) return false;
  if (next.pct <= prev.pct) return false;
  log(
    `[Clauge] resetsAt-drift: window "${key}" resetsAt moved ` +
      `${Math.round(delta / 60000)} min between consecutive samples while ` +
      `pct rose (${prev.pct} -> ${next.pct}). The 5-min same-window ` +
      `tolerance in lib/projection.js may be too tight — forecasts could ` +
      `silently degrade.`
  );
  return true;
}

export class UsageHistory {
  constructor({ filePath = defaultPath() } = {}) {
    this.filePath = filePath;
    // undefined = cold start (must read the file's last line once);
    // null = known-empty file; otherwise { atMs, w }.
    this.lastSample = undefined;
    // Drift tripwire fires once per window per process.
    this.driftWarnedKeys = new Set();
  }

  /** Cold-start downsample gate: read the last valid line from disk. */
  async #lastSampleFromDisk() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return null; // missing file = empty history
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === '') continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // corrupt line — skip, never fatal
      }
      if (!obj || obj.v !== 1) continue;
      const atMs = parseMs(obj.at);
      if (atMs == null) continue;
      return { atMs, w: obj.w && typeof obj.w === 'object' ? obj.w : {} };
    }
    return null;
  }

  /**
   * Append one sample if >= SAMPLE_INTERVAL_MS since the last appended
   * sample. Never throws to the caller — any failure console.warn's and
   * resolves false. Returns true iff a line was appended.
   *
   * @param {object | null} normalized  normalizeUsage output
   * @param {string} atIso  sample timestamp (ISO) — injected, never Date.now()
   * @returns {Promise<boolean>}
   */
  async record(normalized, atIso) {
    try {
      if (!normalized || typeof normalized !== 'object') return false;
      const atMs = parseMs(atIso);
      if (atMs == null) return false;

      const w = {};
      for (const key of WINDOW_KEYS) {
        const win = normalized[key];
        if (win && typeof win === 'object') {
          w[key] = { pct: win.pct ?? null, resetsAt: win.resetsAt ?? null };
        }
      }
      if (Object.keys(w).length === 0) return false; // nothing to record

      if (this.lastSample === undefined) {
        this.lastSample = await this.#lastSampleFromDisk();
      }
      if (this.lastSample && atMs - this.lastSample.atMs < SAMPLE_INTERVAL_MS) {
        return false; // downsample gate
      }

      if (this.lastSample) {
        for (const key of WINDOW_KEYS) {
          if (this.driftWarnedKeys.has(key)) continue;
          const prev = this.lastSample.w?.[key];
          const next = w[key];
          if (prev && next && resetsAtDriftWarning(key, prev, next, console.warn)) {
            this.driftWarnedKeys.add(key);
          }
        }
      }

      const line =
        JSON.stringify({ v: 1, at: new Date(atMs).toISOString(), w }) + '\n';
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, line, { mode: 0o600 });
      this.lastSample = { atMs, w };
      return true;
    } catch (err) {
      console.warn(
        `[Clauge] usage-history: failed to record sample — ${err?.message ?? err}`
      );
      return false;
    }
  }

  /**
   * All samples for one window key, oldest-first (file order). Unparseable
   * and wrong-v lines are skipped; missing file = []. Unknown key = [].
   *
   * @param {string} key
   * @returns {Promise<Array<{ at: string, pct: number | null, resetsAt: string | null }>>}
   */
  async samplesFor(key) {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue; // corrupt line — skip
      }
      if (!obj || obj.v !== 1 || typeof obj.at !== 'string') continue;
      const win = obj.w?.[key];
      if (!win || typeof win !== 'object') continue;
      out.push({ at: obj.at, pct: win.pct ?? null, resetsAt: win.resetsAt ?? null });
    }
    return out;
  }

  /**
   * Drop samples older than RETENTION_DAYS via atomic rewrite (tmp +
   * rename). Unparseable lines are dropped too (their age is unknowable
   * and the read path skips them anyway). No-op when nothing to drop.
   * Never throws.
   *
   * @param {number} nowMs  injected clock — never Date.now()
   * @returns {Promise<void>}
   */
  async prune(nowMs) {
    try {
      let raw;
      try {
        raw = await readFile(this.filePath, 'utf8');
      } catch {
        return; // missing file — nothing to prune
      }
      const cutoffMs = nowMs - RETENTION_MS;
      const kept = [];
      let dropped = 0;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          dropped++;
          continue;
        }
        const atMs = obj && obj.v === 1 ? parseMs(obj.at) : null;
        if (atMs != null && atMs >= cutoffMs) {
          kept.push(trimmed);
        } else {
          dropped++;
        }
      }
      if (dropped === 0) return;
      const tmpPath = this.filePath + '.tmp';
      await writeFile(tmpPath, kept.length ? kept.join('\n') + '\n' : '', {
        mode: 0o600,
      });
      await rename(tmpPath, this.filePath);
    } catch (err) {
      console.warn(
        `[Clauge] usage-history: prune failed — ${err?.message ?? err}`
      );
    }
  }
}
