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

/** The two hero windows we watch (fixed). */
export const WATCHED_WINDOWS = ['fiveHour', 'sevenDay'];

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

function dedupKey(type, w, level, resetsAt) {
  if (type === 'approaching') return `approaching:${w}:${level}:${resetsAt}`;
  return `${type}:${w}:${resetsAt}`;
}

function buildAlert(type, w, level, resetsAt) {
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
    return {
      id,
      type,
      window: w,
      title: 'Clauge — on pace to run out',
      body: `At this rate your ${label} limit runs out before it resets.`,
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
  const pct = Number.isFinite(win?.pct) ? win.pct : null;
  const state = projection?.windows?.[w]?.state ?? null;
  const stale = projection?.freshness?.stale === true;
  const types = prefs?.types ?? {};

  // limitReached: pct >= 100 (load-bearing, NOT state===exhausted). Under
  // stale data it is EXEMPT from suppression, but only when resetsAt is
  // still in the future (a stale post-reset 100 must not fire).
  const limitMet = pct != null && pct >= 100;
  const limitStaleEligible =
    !stale || (limitMet && resetsAtMs != null && resetsAtMs > nowMs);

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
    // unfired, and stale-eligible.
    const H = candidates.find(
      (c) => c.enabled && c.met && c.eligible && !firedSet.has(c.key)
    );
    if (!H) continue;

    due.push(buildAlert(H.type, w, H.level, usage[w].resetsAt));

    // Retire every ENABLED, UNFIRED key of strictly-lower severity for this
    // window — regardless of whether its condition is currently met.
    for (const c of candidates) {
      if (c.rank < H.rank && c.enabled && !firedSet.has(c.key)) {
        retire.push(c.key);
      }
    }
  }

  return { due, retire };
}
