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
