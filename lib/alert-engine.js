/**
 * Pure desktop alert engine (Active-Guardrail Sub-Project B, Component 1).
 * Spec: docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md
 *
 * Consumes Sub-Project A's projection (lib/projection.js::buildProjection)
 * plus the normalized usage plan and the user's alert prefs, and decides
 * which OS notifications are DUE and which dedup keys to RETIRE (mark spent
 * without firing). No I/O, no DOM, no clock: nowMs is a parameter (house
 * convention — no Date.now() in lib/). The /api/alerts/pending endpoint
 * wires this to the stores; the Rust poller fires + acks the result.
 */

import { SAME_WINDOW_TOLERANCE_MS } from './projection.js';

/** The two hero windows we watch (fixed). */
export const WATCHED_WINDOWS = ['fiveHour', 'sevenDay'];

/**
 * The canonical alert-type names — the keys `prefs.types` carries and that
 * `candidatesFor` reads (`types.approaching` / `willHit` / `limitReached`).
 * The single source of truth for the type list; config-store imports this so a
 * future type addition flows to both modules (no comment-coupled duplicate).
 */
export const ALERT_TYPES = ['approaching', 'willHit', 'limitReached'];

/** Approaching levels, highest first (drives the descending key order). */
export const APPROACHING_LEVELS = [95, 80];

/**
 * Severity rank — higher fires first and retires everything strictly below
 * it for the same window (forward-looking collapse).
 */
export const SEVERITY = {
  limitReached: 4,
  willHit: 3,
  approaching95: 2,
  approaching80: 1,
};

/** Human label for a watched window. */
export function windowLabel(w) {
  return w === 'fiveHour' ? '5-hour' : 'weekly';
}

function parseMs(iso) {
  if (typeof iso !== 'string' || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function localTime(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ETA for the will-hit body: local time, with a weekday prefix when the ETA
// falls on a different day than now (the weekly window can run out days out, so
// a bare "9 PM" would be ambiguous). nowMs injected — no clock read here.
function localEta(iso, nowMs) {
  const ms = parseMs(iso);
  if (ms == null) return null;
  const eta = new Date(ms);
  const time = eta.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (eta.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${eta.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function dedupKey(type, w, level, resetsAt) {
  if (type === 'approaching') return `approaching:${w}:${level}:${resetsAt}`;
  return `${type}:${w}:${resetsAt}`;
}

/**
 * Recover the embedded resetsAt (ISO-8601, itself colon-bearing) from a dedup
 * key. Anchors on the first 4-digit-year date segment to the end — the inverse
 * of dedupKey's resetsAt embedding. Returns the parsed epoch ms, or null when
 * no ISO timestamp is present. Lives here (the pure engine) so alert-state.js
 * can import it without pulling clock/IO into this module; the parsing contract
 * is the on-disk key-format compatibility guarantee.
 * @param {string} key
 * @returns {number|null}
 */
export function resetsAtMsFromKey(key) {
  if (typeof key !== 'string') return null;
  const m = key.match(/:(\d{4}-\d{2}-\d{2}T.*)$/);
  if (m == null) return null;
  const ms = Date.parse(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

// The `type:window[:level]` prefix of a dedup key — everything before the
// embedded resetsAt (anchored on the same first-year segment as
// resetsAtMsFromKey). Null when no ISO timestamp is present.
function keyPrefix(key) {
  if (typeof key !== 'string') return null;
  const m = key.match(/^(.*?):\d{4}-\d{2}-\d{2}T.*$/);
  return m == null ? null : m[1];
}

// #08: a candidate key counts as already-fired when the fired set holds an
// exact match OR any key with the SAME type:window[:level] prefix whose
// embedded resetsAt is within SAME_WINDOW_TOLERANCE_MS of the candidate's (the
// projection's same-window rule) — so a resets_at micro-drift on one still-open
// window does not re-fire or re-retire. Exact string match is a subset.
function isAlreadyFired(firedSet, candidateKey) {
  if (firedSet.has(candidateKey)) return true;
  const prefix = keyPrefix(candidateKey);
  const candMs = resetsAtMsFromKey(candidateKey);
  if (prefix == null || candMs == null) return false;
  for (const key of firedSet) {
    if (keyPrefix(key) !== prefix) continue;
    const ms = resetsAtMsFromKey(key);
    if (ms != null && Math.abs(ms - candMs) <= SAME_WINDOW_TOLERANCE_MS) {
      return true;
    }
  }
  return false;
}

function buildAlert(type, w, level, resetsAt, etaAt, nowMs) {
  const label = windowLabel(w);
  const id = dedupKey(type, w, level, resetsAt);
  const reset = parseMs(resetsAt) != null ? localTime(resetsAt) : '';
  if (type === 'limitReached') {
    return {
      id,
      type,
      window: w,
      title: `Clauge — ${label} limit reached`,
      body: `You've hit your ${label} limit. Resets ~${reset}.`,
    };
  }
  if (type === 'willHit') {
    const eta = localEta(etaAt, nowMs);
    return {
      id,
      type,
      window: w,
      title: 'Clauge — on pace to run out',
      body: eta
        ? `At this rate your ${label} limit runs out ~${eta}, before it resets.`
        : `At this rate your ${label} limit runs out before it resets.`,
    };
  }
  return {
    id,
    type,
    window: w,
    level,
    title: `Clauge — ${label} limit at ${level}%`,
    body: `You're past ${level}% of your ${label} window. Resets ~${reset}.`,
  };
}

/**
 * The enumerable candidate set for one window, in DESCENDING severity, each
 * tagged with its rank, dedup key, condition-met flag, and whether prefs
 * enable it. resetsAt is the live window instance id.
 */
function candidatesFor(w, usage, projection, prefs, nowMs) {
  const win = usage?.[w];
  const resetsAt = win?.resetsAt ?? null;
  if (resetsAt == null) return []; // null/absent window -> skipped entirely
  const resetsAtMs = parseMs(resetsAt);
  // #05: a window whose resetsAt has already passed (or doesn't parse) is a
  // DEAD window instance — the data describing it is by definition outdated, so
  // alerting on it is always wrong (the reset-boundary notification storm). Skip
  // it entirely; the NEXT real window (fresh future resetsAt) alerts normally.
  if (resetsAtMs == null || resetsAtMs <= nowMs) return [];
  const pct = Number.isFinite(win?.pct) ? win.pct : null;
  const state = projection?.windows?.[w]?.state ?? null;
  const stale = projection?.freshness?.stale === true;
  const types = prefs?.types ?? {};

  // limitReached: pct >= 100 (load-bearing, NOT state===exhausted). Under
  // stale data it is EXEMPT from suppression when its condition is met (the
  // future-resetsAt guard is now redundant — the dead-window skip above already
  // guarantees resetsAtMs > nowMs here).
  const limitMet = pct != null && pct >= 100;
  const limitStaleEligible = !stale || limitMet;

  return [
    {
      rank: SEVERITY.limitReached,
      key: dedupKey('limitReached', w, null, resetsAt),
      type: 'limitReached',
      level: null,
      enabled: types.limitReached !== false,
      met: limitMet,
      eligible: limitStaleEligible,
    },
    {
      rank: SEVERITY.willHit,
      key: dedupKey('willHit', w, null, resetsAt),
      type: 'willHit',
      level: null,
      enabled: types.willHit !== false,
      met: state === 'will_hit',
      eligible: !stale, // forecast suppressed when stale
    },
    {
      rank: SEVERITY.approaching95,
      key: dedupKey('approaching', w, 95, resetsAt),
      type: 'approaching',
      level: 95,
      enabled: types.approaching !== false,
      met: pct != null && pct >= 95,
      eligible: !stale,
    },
    {
      rank: SEVERITY.approaching80,
      key: dedupKey('approaching', w, 80, resetsAt),
      type: 'approaching',
      level: 80,
      enabled: types.approaching !== false,
      met: pct != null && pct >= 80,
      eligible: !stale,
    },
  ];
}

/**
 * Decide which alerts fire now and which lesser keys are retired (spent
 * without firing) via the forward-looking severity collapse + stale gate.
 *
 * @param {{
 *   usage: object, projection: object,
 *   prefs: { alertsEnabled: boolean,
 *     types: { approaching: boolean, willHit: boolean, limitReached: boolean } },
 *   fired: Set<string>, nowMs: number,
 * }} args
 * @returns {{ due: Array<object>, retire: string[] }}
 */
export function evaluate({ usage, projection, prefs, fired, nowMs }) {
  if (!prefs || prefs.alertsEnabled === false) return { due: [], retire: [] };
  const firedSet = fired instanceof Set ? fired : new Set();

  const due = [];
  const retire = [];

  for (const w of WATCHED_WINDOWS) {
    const candidates = candidatesFor(w, usage, projection, prefs, nowMs);
    if (candidates.length === 0) continue; // skipped window

    // H = highest-severity candidate that is enabled, condition-met,
    // unfired (tolerant of resets_at drift), and stale-eligible.
    const H = candidates.find(
      (c) => c.enabled && c.met && c.eligible && !isAlreadyFired(firedSet, c.key)
    );
    if (!H) continue;

    due.push(
      buildAlert(H.type, w, H.level, usage[w].resetsAt, projection?.windows?.[w]?.etaAt ?? null, nowMs)
    );

    // Retire every ENABLED, UNFIRED key of strictly-lower severity for this
    // window — regardless of whether its condition is currently met. Tolerant
    // of drift so a drifted lesser key already fired/retired is not re-retired
    // as "new" (and must not resurrect).
    for (const c of candidates) {
      if (c.rank < H.rank && c.enabled && !isAlreadyFired(firedSet, c.key)) {
        retire.push(c.key);
      }
    }
  }

  return { due, retire };
}
