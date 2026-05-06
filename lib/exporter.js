/**
 * CSV / JSON export per PRD v3.1 §2.9.
 *
 * Default export shape: one row per summarized session, with the columns
 * you'd expect to see in the sessions table. Period and project filtering
 * are applied upstream (see period.js / session-store.js).
 */

const SESSION_COLUMNS = [
  'sessionId',
  'project',
  'startedAt',
  'endedAt',
  'durationMin',
  'turnCount',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheCreate5m',
  'cacheCreate1h',
  'totalTokens',
  'costUSD',
  'cacheHitRatePct',
  'netCacheSavingsUSD',
  'primaryTask',
  'gitBranch',
  'cwd',
];

function totalTokens(t) {
  return (
    (t.inputTokens ?? 0) +
    (t.outputTokens ?? 0) +
    (t.cacheRead ?? 0) +
    (t.cacheCreate5m ?? 0) +
    (t.cacheCreate1h ?? 0)
  );
}

export function sessionToRow(s) {
  return {
    sessionId: s.sessionId,
    project: s.project ?? '',
    startedAt: s.startedAt ?? '',
    endedAt: s.endedAt ?? '',
    durationMin: s.durationMs ? Math.round(s.durationMs / 60000) : '',
    turnCount: s.turnCount ?? 0,
    inputTokens: s.tokens?.inputTokens ?? 0,
    outputTokens: s.tokens?.outputTokens ?? 0,
    cacheReadTokens: s.tokens?.cacheRead ?? 0,
    cacheCreate5m: s.tokens?.cacheCreate5m ?? 0,
    cacheCreate1h: s.tokens?.cacheCreate1h ?? 0,
    totalTokens: totalTokens(s.tokens ?? {}),
    costUSD: Number((s.cost ?? 0).toFixed(6)),
    cacheHitRatePct:
      s.cacheHitRate != null ? Number((s.cacheHitRate * 100).toFixed(2)) : '',
    netCacheSavingsUSD: Number((s.netCacheSavings ?? 0).toFixed(6)),
    primaryTask: s.tasks?.primary ?? '',
    gitBranch: s.gitBranch ?? '',
    cwd: s.cwd ?? '',
  };
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function toCsv(sessions) {
  const rows = (sessions ?? []).map(sessionToRow);
  const header = SESSION_COLUMNS.join(',');
  const body = rows
    .map((r) => SESSION_COLUMNS.map((c) => csvEscape(r[c])).join(','))
    .join('\n');
  return rows.length === 0 ? `${header}\n` : `${header}\n${body}\n`;
}

export function toJson(sessions) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sessionCount: sessions?.length ?? 0,
      sessions: (sessions ?? []).map(sessionToRow),
    },
    null,
    2
  );
}

export const EXPORT_COLUMNS = SESSION_COLUMNS;
