/**
 * Pure helpers for the v0.9.4 activity heatmap.
 *
 * Input shape: [{ date: 'YYYY-MM-DD', sessions: number, tokens: number, cost: number, ... }]
 * Array is assumed sorted ascending by date. "Active" = sessions > 0.
 *
 * No I/O, no DOM, no time — `today` is always passed in by the caller so the
 * library stays testable.
 */

const isActive = (day) => Number.isFinite(day?.sessions) && day.sessions > 0;

export function countActiveDays(days) {
  if (!Array.isArray(days)) return 0;
  let n = 0;
  for (const d of days) if (isActive(d)) n++;
  return n;
}

/**
 * Per-day intensity bucket:
 *   0 — zero / inactive
 *   1..4 — quartiles of the non-zero days for `metric` (default 'sessions')
 *
 * Returns a new array; input is not mutated.
 *
 * Single non-zero day collapses every quartile to the same value, which lands
 * in bucket 1 by `<= q1` — that's fine, the acceptance criterion is "no crash",
 * not a specific bucket.
 */
export function computeBuckets(days, opts = {}) {
  if (!Array.isArray(days) || days.length === 0) return [];
  const metric = opts.metric ?? 'sessions';

  const sortedNonZero = days
    .map((d) => d[metric])
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (sortedNonZero.length === 0) {
    return days.map((d) => ({ ...d, intensity: 0 }));
  }

  const quantile = (frac) => {
    const idx = frac * (sortedNonZero.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedNonZero[lo];
    return sortedNonZero[lo] + (sortedNonZero[hi] - sortedNonZero[lo]) * (idx - lo);
  };
  const q1 = quantile(0.25);
  const q2 = quantile(0.5);
  const q3 = quantile(0.75);

  return days.map((d) => {
    const v = d[metric];
    if (!Number.isFinite(v) || v <= 0) return { ...d, intensity: 0 };
    let intensity;
    if (v <= q1) intensity = 1;
    else if (v <= q2) intensity = 2;
    else if (v <= q3) intensity = 3;
    else intensity = 4;
    return { ...d, intensity };
  });
}

/**
 * Consecutive active days ending at `today`. Returns 0 if today is not in
 * the array or if today's cell is inactive.
 */
export function computeCurrentStreak(days, today) {
  if (!Array.isArray(days) || days.length === 0) return 0;
  const idx = days.findIndex((d) => d.date === today);
  if (idx === -1) return 0;
  if (!isActive(days[idx])) return 0;
  let n = 1;
  for (let i = idx - 1; i >= 0; i--) {
    if (!isActive(days[i])) break;
    n++;
  }
  return n;
}

/**
 * Longest run of consecutive active days anywhere in the array.
 */
export function computeLongestStreak(days) {
  if (!Array.isArray(days) || days.length === 0) return 0;
  let best = 0;
  let run = 0;
  for (const d of days) {
    if (isActive(d)) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

export function summarizeActivity(days, today) {
  return {
    days: computeBuckets(days),
    activeDays: countActiveDays(days),
    currentStreak: computeCurrentStreak(days, today),
    longestStreak: computeLongestStreak(days),
  };
}

// ─── /api/activity helpers ─────────────────────────────────

const TOTAL_TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheRead', 'cacheCreate5m', 'cacheCreate1h'];

function totalTokens(t) {
  if (!t || typeof t !== 'object') return 0;
  let sum = 0;
  for (const k of TOTAL_TOKEN_FIELDS) sum += Number.isFinite(t[k]) ? t[k] : 0;
  return sum;
}

/**
 * Format an ISO timestamp as YYYY-MM-DD in the given IANA timezone.
 * en-CA locale always produces YYYY-MM-DD regardless of host locale.
 */
function dateInTz(iso, tz) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Date arithmetic over YYYY-MM-DD strings. All work happens in UTC so DST
 * never shifts the calendar — these are pure calendar-date manipulations.
 */
function shiftDay(yyyymmdd, deltaDays) {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startYYYYMMDD, endYYYYMMDD) {
  const out = [];
  let cur = startYYYYMMDD;
  while (cur <= endYYYYMMDD) {
    out.push(cur);
    cur = shiftDay(cur, 1);
  }
  return out;
}

/**
 * Bucket a sessions array into a dense per-day record array suitable for the
 * /api/activity response (and the heatmap renderer).
 *
 *   sessions: [{ startedAt, tokens, cost, ... }]
 *   opts:
 *     today      — 'YYYY-MM-DD' in the user's TZ (caller computes; required)
 *     periodDays — number (e.g. 180, 365) OR the string 'all'
 *     tz         — IANA TZ name (e.g. 'Asia/Dhaka'). Default 'UTC'.
 *
 * Returns an array of `{ date, sessions, tokens, costUSD, claudeAiMessages,
 * intensity }` covering [today − periodDays + 1, today] inclusive. For
 * 'all', the range starts at the earliest session's TZ-local day (or today
 * if there are no sessions).
 *
 * `claudeAiMessages` is 0 for every day in v0.9.4 — the UsageStore only
 * persists the latest ingest, no per-day claude.ai history. Hooked up
 * properly when storage gains history (tracked for v0.9.5+).
 */
export function aggregateDailyActivity(sessions, opts = {}) {
  const today = opts.today;
  const tz = opts.tz ?? 'UTC';
  const periodDays = opts.periodDays;
  if (!today) throw new Error("aggregateDailyActivity: 'today' is required");

  const byDay = new Map();
  for (const s of sessions ?? []) {
    if (!s?.startedAt) continue;
    const dateKey = dateInTz(s.startedAt, tz);
    if (!dateKey) continue;
    const bucket = byDay.get(dateKey) ?? { sessions: 0, tokens: 0, costUSD: 0 };
    bucket.sessions += 1;
    bucket.tokens += totalTokens(s.tokens);
    bucket.costUSD += Number.isFinite(s.cost) ? s.cost : 0;
    byDay.set(dateKey, bucket);
  }

  let rangeStart;
  if (periodDays === 'all') {
    let earliest = today;
    for (const key of byDay.keys()) if (key < earliest) earliest = key;
    rangeStart = earliest;
  } else {
    const n = Number(periodDays);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(`aggregateDailyActivity: invalid periodDays ${periodDays}`);
    }
    rangeStart = shiftDay(today, -(n - 1));
  }

  const allDays = daysBetween(rangeStart, today);
  const denseRaw = allDays.map((date) => {
    const b = byDay.get(date);
    return {
      date,
      sessions: b?.sessions ?? 0,
      tokens: b?.tokens ?? 0,
      costUSD: b?.costUSD ?? 0,
      claudeAiMessages: 0,
    };
  });

  return computeBuckets(denseRaw);
}
