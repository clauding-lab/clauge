/**
 * On-device usage projection — pure forecast math for the active guardrail.
 *
 * CROSS-PLATFORM ALGORITHM SOURCE. This module is the single source of truth
 * for the projection state machine, paired with the shared vector file at
 * test/fixtures/projection-vectors.json. clauge-ios vendors a byte-identical
 * copy of BOTH (the Swift port asserts the same vectorsVersion) — change the
 * algorithm here and you must regenerate/extend the vectors in the same
 * commit, never edit one without the other.
 *
 * No I/O, no DOM, no clock: every function takes `nowMs` as a parameter
 * (house convention — no Date.now() in lib/). The /api/projection endpoint
 * wires these functions to the stores; frontends only format the output.
 *
 * Spec: docs/superpowers/specs/2026-06-12-on-device-projection-design.md
 */

/**
 * Per-bucket window durations in milliseconds (exhaustive allowlist).
 * `dailyRoutines` is a WEEKLY quota bucket despite the feature's name — it
 * resolves from seven_day_* raw keys (see lib/usage-store.js ROUTINES_KEYS).
 * Any bucket whose duration is unknown is reported `unavailable`, never
 * given a guessed duration.
 */
export const WINDOW_MS = {
  fiveHour: 18000000,
  sevenDay: 604800000,
  sevenDaySonnet: 604800000,
  sevenDayOpus: 604800000,
  claudeDesign: 604800000,
  dailyRoutines: 604800000,
};

/**
 * The exhaustive set of resolved window keys, in WINDOW_MS order. The single
 * source of truth — the usage-history recorder imports this so adding a window
 * here automatically extends sampling (no comment-coupled second copy).
 */
export const WINDOW_KEYS = Object.keys(WINDOW_MS);

/** Ingest older than this (or never ingested) => every window is `stale`. */
export const PROJECTION_STALE_AFTER_MS = 600000; // 10 min

/** Recent-burn-rate lookback: samples older than this are ignored. */
export const RECENT_SPAN_MS = 3600000; // 60 min

/** Minimum age of the oldest qualifying sample for a usable recent rate. */
export const MIN_RECENT_SPAN_MS = 900000; // 15 min

/** Window younger than this fraction of its duration => `warming_up`. */
export const WARMUP_FRACTION = 0.05;

/** Two resetsAt values within this delta belong to the same window. */
export const SAME_WINDOW_TOLERANCE_MS = 300000; // 5 min

/** Week-over-week: nearest prior-week sample must be within this of the
 *  same-fraction target point, else weekOverWeek is null. */
const WOW_NEIGHBOR_TOLERANCE_MS = 21600000; // 6 h

const WEEK_OVER_WEEK_KEY = 'sevenDay';

function parseMs(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isoAtSecond(ms) {
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * True when the latest ingest is too old to forecast from (or never
 * happened). Pure so iOS ports it with the same vectors; the endpoint
 * merely wires it.
 *
 * @param {{ ingestedAt: string | null | undefined, nowMs: number }} args
 * @returns {boolean}
 */
export function isStale({ ingestedAt, nowMs }) {
  const ingestedMs = parseMs(ingestedAt);
  if (ingestedMs == null) return true;
  return nowMs - ingestedMs > PROJECTION_STALE_AFTER_MS;
}

function emptyForecast(pct, resetsAt, state) {
  return {
    pct: pct ?? null,
    resetsAt: resetsAt ?? null,
    state,
    basis: null,
    etaAt: null,
    projectedEndPct: null,
    recentRatePctPerHour: null,
  };
}

/**
 * Recent burn rate in pct/ms, or null when no qualifying history sample
 * exists. The latest ingested record is represented by (pct, nowMs);
 * qualifying samples share the current window's resetsAt (±5 min), are at
 * most RECENT_SPAN_MS old, and at least MIN_RECENT_SPAN_MS old. The oldest
 * qualifying sample anchors the rate. Negative Δpct (a reset slipped past
 * the grouping) falls back to null — belt-and-braces.
 */
function computeRecentRate({ pct, resetsAtMs, nowMs, history }) {
  if (!Array.isArray(history)) return null;
  let oldest = null;
  let oldestAtMs = null;
  for (const sample of history) {
    const atMs = parseMs(sample?.at);
    const sampleResetMs = parseMs(sample?.resetsAt);
    if (atMs == null || sampleResetMs == null) continue;
    if (!Number.isFinite(sample?.pct)) continue;
    if (Math.abs(sampleResetMs - resetsAtMs) > SAME_WINDOW_TOLERANCE_MS) continue;
    const age = nowMs - atMs;
    if (age > RECENT_SPAN_MS || age < MIN_RECENT_SPAN_MS) continue;
    if (oldestAtMs == null || atMs < oldestAtMs) {
      oldest = sample;
      oldestAtMs = atMs;
    }
  }
  if (oldest == null) return null;
  const deltaPct = pct - oldest.pct;
  if (deltaPct < 0) return null;
  return deltaPct / (nowMs - oldestAtMs);
}

/**
 * Forecast one usage window. State machine (spec order, do not reorder):
 * unavailable -> exhausted -> warming_up -> will_hit | safe.
 *
 * @param {{
 *   pct: number | null,
 *   resetsAt: string | null,
 *   windowMs: number | null,
 *   nowMs: number,
 *   history: Array<{ at: string, pct: number, resetsAt: string }>,
 * }} args  history = samples for THIS window key only, oldest-first.
 * @returns {{
 *   pct: number | null, resetsAt: string | null,
 *   state: 'unavailable' | 'exhausted' | 'warming_up' | 'will_hit' | 'safe',
 *   basis: 'recent' | 'window_avg' | null,
 *   etaAt: string | null, projectedEndPct: number | null,
 *   recentRatePctPerHour: number | null,
 * }}
 */
export function projectWindow({ pct, resetsAt, windowMs, nowMs, history }) {
  const resetsAtMs = parseMs(resetsAt);
  if (
    pct == null ||
    !Number.isFinite(pct) ||
    resetsAtMs == null ||
    resetsAtMs <= nowMs ||
    !Number.isFinite(windowMs) ||
    windowMs <= 0
  ) {
    return emptyForecast(pct, resetsAt, 'unavailable');
  }
  if (pct >= 100) return emptyForecast(pct, resetsAt, 'exhausted');

  const windowStartMs = resetsAtMs - windowMs;
  const elapsedMs = Math.min(Math.max(nowMs - windowStartMs, 0), windowMs);
  if (elapsedMs < WARMUP_FRACTION * windowMs) {
    return emptyForecast(pct, resetsAt, 'warming_up');
  }

  const recentRate = computeRecentRate({ pct, resetsAtMs, nowMs, history });
  const rate = recentRate ?? pct / elapsedMs;
  const basis = recentRate != null ? 'recent' : 'window_avg';
  const recentRatePctPerHour =
    recentRate != null ? round1(recentRate * 3600000) : null;

  if (rate <= 0) {
    return {
      pct,
      resetsAt,
      state: 'safe',
      basis,
      etaAt: null,
      projectedEndPct: Math.min(99, Math.round(pct)),
      recentRatePctPerHour,
    };
  }

  const etaMs = nowMs + (100 - pct) / rate;
  if (etaMs <= resetsAtMs) {
    return {
      pct,
      resetsAt,
      state: 'will_hit',
      basis,
      etaAt: isoAtSecond(etaMs),
      projectedEndPct: null,
      recentRatePctPerHour,
    };
  }
  return {
    pct,
    resetsAt,
    state: 'safe',
    basis,
    etaAt: null,
    projectedEndPct: Math.min(
      99,
      Math.round(pct + rate * (resetsAtMs - nowMs))
    ),
    recentRatePctPerHour,
  };
}

/**
 * Week-over-week context: how today's pct compares with the previous
 * window's pct at the same elapsed fraction. Non-null ONLY when the
 * window's own state is will_hit | safe (rides the same suppression gates
 * as the forecast). Null whenever the previous window has no usable
 * history — first week after install, sparse data, etc.
 *
 * @param {{ pct, resetsAt, windowMs, nowMs, history }} args — same shape
 *   as projectWindow; history = samples for this window key, oldest-first.
 * @returns {{ deltaPts: number, prevPctAtSamePoint: number } | null}
 */
export function weekOverWeek({ pct, resetsAt, windowMs, nowMs, history }) {
  const forecast = projectWindow({ pct, resetsAt, windowMs, nowMs, history });
  if (forecast.state !== 'will_hit' && forecast.state !== 'safe') return null;
  if (!Array.isArray(history)) return null;

  const resetsAtMs = parseMs(resetsAt);

  // Previous-window cluster: newest sample whose resetsAt precedes the
  // current window beyond the same-window tolerance anchors the cluster;
  // members sit within ±tolerance of that anchor.
  let anchor = null;
  let anchorAtMs = null;
  const prior = [];
  for (const sample of history) {
    const atMs = parseMs(sample?.at);
    const sampleResetMs = parseMs(sample?.resetsAt);
    if (atMs == null || sampleResetMs == null) continue;
    if (!Number.isFinite(sample?.pct)) continue;
    if (sampleResetMs >= resetsAtMs - SAME_WINDOW_TOLERANCE_MS) continue;
    prior.push({ atMs, pct: sample.pct, resetMs: sampleResetMs });
    if (anchorAtMs == null || atMs > anchorAtMs) {
      anchor = sample;
      anchorAtMs = atMs;
    }
  }
  if (anchor == null) return null;
  const anchorResetMs = parseMs(anchor.resetsAt);
  const cluster = prior
    .filter((s) => Math.abs(s.resetMs - anchorResetMs) <= SAME_WINDOW_TOLERANCE_MS)
    .sort((a, b) => a.atMs - b.atMs);

  // Same-fraction target point inside the previous window.
  const elapsedMs = Math.min(
    Math.max(nowMs - (resetsAtMs - windowMs), 0),
    windowMs
  );
  const targetMs = anchorResetMs - windowMs + elapsedMs;

  let nearestDist = Infinity;
  for (const s of cluster) {
    nearestDist = Math.min(nearestDist, Math.abs(s.atMs - targetMs));
  }
  if (nearestDist > WOW_NEIGHBOR_TOLERANCE_MS) return null;

  let lower = null;
  let upper = null;
  for (const s of cluster) {
    if (s.atMs <= targetMs) lower = s;
    if (s.atMs >= targetMs && upper == null) upper = s;
  }
  let prevPct;
  if (lower != null && upper != null) {
    prevPct =
      lower.atMs === upper.atMs
        ? lower.pct
        : lower.pct +
          ((upper.pct - lower.pct) * (targetMs - lower.atMs)) /
            (upper.atMs - lower.atMs);
  } else {
    prevPct = (lower ?? upper).pct;
  }

  return {
    deltaPts: Math.round(pct - prevPct),
    prevPctAtSamePoint: Math.round(prevPct),
  };
}

/**
 * ROI run-rate pace: trailing-7-day API-equivalent spend scaled to 30 days,
 * compared with the subscription cost (same net-value semantics as the
 * dashboard multiplier). Null when subscriptionCost is unset/<=0 or when
 * there were no sessions in the trailing window (phantom-bucket lesson:
 * hide, never render a "-1x" zero-data verdict). NOT staleness-gated —
 * spend comes from local session logs, not extension ingest.
 *
 * @param {{ apiEquivalentSpendTrailing: number, subscriptionCost: number }} args
 * @returns {{ trailingDays: 7, apiEquivalentSpendTrailing: number,
 *   monthlyEquivalentValue: number, subscriptionCost: number,
 *   paceMultiple: number } | null}
 */
export function roiPace({ apiEquivalentSpendTrailing, subscriptionCost }) {
  if (!Number.isFinite(subscriptionCost) || subscriptionCost <= 0) return null;
  if (
    !Number.isFinite(apiEquivalentSpendTrailing) ||
    apiEquivalentSpendTrailing <= 0
  ) {
    return null;
  }
  const monthlyEquivalentValue = (apiEquivalentSpendTrailing / 7) * 30;
  return {
    trailingDays: 7,
    apiEquivalentSpendTrailing,
    monthlyEquivalentValue: round2(monthlyEquivalentValue),
    subscriptionCost,
    paceMultiple: round1(
      (monthlyEquivalentValue - subscriptionCost) / subscriptionCost
    ),
  };
}

function staleWindow(win, withWeekOverWeek) {
  const out = {
    pct: win.pct ?? null,
    resetsAt: win.resetsAt ?? null,
    state: 'stale',
    basis: null,
    etaAt: null,
    projectedEndPct: null,
    recentRatePctPerHour: null,
  };
  return withWeekOverWeek ? { ...out, weekOverWeek: null } : out;
}

/**
 * Assemble the full projection payload for /api/projection.
 *
 * @param {{
 *   normalized: object | null,         // UsageStore record's `normalized`
 *   ingestedAt: string | null,         // UsageStore record's `ingestedAt`
 *   history: { [windowKey: string]: Array<{ at, pct, resetsAt }> } | null,
 *   nowMs: number,
 *   apiEquivalentSpendTrailing: number, // dollars, per-token cost pipeline
 *   subscriptionCost: number,           // dollars
 * }} args
 * @returns {{ freshness: { ingested: boolean, ingestedAt: string | null,
 *   stale: boolean }, windows: object, roiPace: object | null }}
 */
export function buildProjection({
  normalized,
  ingestedAt,
  history,
  nowMs,
  apiEquivalentSpendTrailing,
  subscriptionCost,
}) {
  const stale = isStale({ ingestedAt, nowMs });
  const freshness = {
    ingested: parseMs(ingestedAt) != null,
    ingestedAt: ingestedAt ?? null,
    stale,
  };

  const windows = {};
  for (const key of Object.keys(WINDOW_MS)) {
    const win = normalized?.[key] ?? null;
    const wantsWow = key === WEEK_OVER_WEEK_KEY;
    if (win == null || typeof win !== 'object') {
      windows[key] = null; // phantom-bucket lesson: data-gate, no zeros
      continue;
    }
    if (stale) {
      windows[key] = staleWindow(win, wantsWow);
      continue;
    }
    const samples = Array.isArray(history?.[key]) ? history[key] : [];
    const args = {
      pct: win.pct ?? null,
      resetsAt: win.resetsAt ?? null,
      windowMs: WINDOW_MS[key],
      nowMs,
      history: samples,
    };
    const forecast = projectWindow(args);
    windows[key] = wantsWow
      ? { ...forecast, weekOverWeek: weekOverWeek(args) }
      : forecast;
  }

  return {
    freshness,
    windows,
    roiPace: roiPace({ apiEquivalentSpendTrailing, subscriptionCost }),
  };
}
