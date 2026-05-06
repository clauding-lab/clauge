/**
 * Period and project filtering for V1 dashboard.
 *
 * Period values: today, 7d, 30d, month, all
 *  - today  = last 24h from now
 *  - 7d     = last 7 days
 *  - 30d    = last 30 days
 *  - month  = current calendar month (UTC)
 *  - all    = no filter
 *
 * Comparisons use ISO timestamps (lexicographic order matches chronological).
 */

export const PERIODS = Object.freeze(['today', '7d', '30d', 'month', 'all']);

export function isValidPeriod(period) {
  return PERIODS.includes(period);
}

/**
 * Returns the inclusive lower bound (ISO string) for the given period,
 * or null when there is no lower bound (period === 'all').
 *
 * @param {string} period
 * @param {Date} [now] for testability
 */
export function periodStart(period, now = new Date()) {
  switch (period) {
    case 'today': return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case '7d':   return new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString();
    case '30d':  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'month': {
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth();
      return new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
    }
    case 'all':
    default:
      return null;
  }
}

/**
 * True iff the session's startedAt falls inside the period.
 */
export function withinPeriod(session, period, now = new Date()) {
  if (!session?.startedAt) return false;
  const lower = periodStart(period, now);
  if (lower == null) return true;
  return session.startedAt >= lower;
}

/**
 * Case-insensitive substring match on project name.
 */
export function matchesProject(session, projectFilter) {
  if (!projectFilter) return true;
  const name = (session?.project ?? '').toLowerCase();
  return name.includes(projectFilter.toLowerCase());
}

/**
 * Combined session filter for period + project.
 */
export function filterSessions(sessions, { period = '7d', project = '', now = new Date() } = {}) {
  return (sessions ?? []).filter(
    (s) => withinPeriod(s, period, now) && matchesProject(s, project)
  );
}
