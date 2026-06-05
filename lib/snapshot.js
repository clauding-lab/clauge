/**
 * Phone analytics snapshot assembly (Phase ②b).
 *
 * Produces ONE compact, curated JSON object the Mac publishes into its iCloud
 * Drive container for the companion iOS app to read. This is a trimmed mirror
 * of the desktop dashboard's `/api/*` surface — NOT a concatenation of the full
 * responses — sized for a phone (~6–10 KB target):
 *   - top-N caps on tools and projects,
 *   - per-day activity trimmed to {date, sessions, intensity},
 *   - monetary values rounded to cents,
 *   - nested per-project/per-model breakdowns dropped from `daily`.
 *
 * Freshness metadata (`seq`, `writerId`) is DELIBERATELY NOT set here. The
 * Tauri parent — the single authoritative writer — stamps those immediately
 * before the coordinated iCloud write, so they stay monotonic across sidecar
 * respawns. Adding them here would let two assembled snapshots collide on `seq`.
 */

import { filterSessions } from './period.js';
import { rollupByProject, rollupByDay } from './aggregator.js';
import {
  aggregateDailyActivity,
  countActiveDays,
  computeCurrentStreak,
  computeLongestStreak,
} from './activity.js';
import { apiReplacementValue, sumSessionCosts } from './roi-calculator.js';

/** Bump when the on-wire shape changes so the iOS reader can branch. */
const SNAPSHOT_SCHEMA_VERSION = 1;
/** Window for the headline breakdowns (summary/projects/daily/models/tools/roi). */
const DEFAULT_PERIOD = '30d';
/** Window for the activity heatmap (independent of DEFAULT_PERIOD). */
const ACTIVITY_PERIOD_DAYS = 180;
const MAX_PROJECTS = 10;
const MAX_TOOLS_PER_GROUP = 15;

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheRead', 'cacheCreate5m', 'cacheCreate1h'];

/** Round to 2 decimal places (cents). */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Sum the cost-bearing token fields of a tokens object. */
function totalTokens(t) {
  if (!t || typeof t !== 'object') return 0;
  let sum = 0;
  for (const k of TOKEN_FIELDS) sum += t[k] ?? 0;
  return sum;
}

/** YYYY-MM-DD for `now` in the given IANA timezone (en-CA always YYYY-MM-DD). */
function todayInTz(now, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Headline totals across the period-filtered sessions (mirrors /api/summary, trimmed). */
function buildSummary(sessions) {
  let messageCount = 0;
  let toolCallCount = 0;
  let subagentTurnCount = 0;
  let assistantTurnCount = 0;
  let tokenSum = 0;
  const modelTokens = new Map();
  for (const s of sessions) {
    messageCount += s.messageCount ?? 0;
    toolCallCount += s.toolCallCount ?? 0;
    subagentTurnCount += s.subagentTurnCount ?? 0;
    assistantTurnCount += s.turnCount ?? 0;
    tokenSum += totalTokens(s.tokens);
    for (const m of s.byModel ?? []) {
      modelTokens.set(m.model, (modelTokens.get(m.model) ?? 0) + totalTokens(m.tokens));
    }
  }
  let primaryModel = null;
  let primaryModelTokens = 0;
  for (const [model, t] of modelTokens) {
    if (t > primaryModelTokens) {
      primaryModel = model;
      primaryModelTokens = t;
    }
  }
  const cost = sumSessionCosts(sessions);
  const sessionCount = sessions.length;
  return {
    sessionCount,
    totalTokens: tokenSum,
    cost: round2(cost),
    avgCostPerSession: sessionCount === 0 ? 0 : round2(cost / sessionCount),
    messageCount,
    toolCallCount,
    subagentTurnCount,
    assistantTurnCount,
    primaryModel,
    primaryModelTokens,
  };
}

/** Per-model cost/usage breakdown (mirrors /api/models, trimmed). */
function buildModels(sessions) {
  const map = new Map();
  let totalCost = 0;
  for (const s of sessions) {
    for (const m of s.byModel ?? []) {
      const b = map.get(m.model) ?? { model: m.model, turnCount: 0, cost: 0, tokens: 0 };
      b.turnCount += m.turnCount ?? 0;
      b.cost += m.cost ?? 0;
      b.tokens += totalTokens(m.tokens);
      map.set(m.model, b);
      totalCost += m.cost ?? 0;
    }
  }
  return [...map.values()]
    .map((b) => ({
      model: b.model,
      turnCount: b.turnCount,
      tokens: b.tokens,
      cost: round2(b.cost),
      pctOfTotal: totalCost === 0 ? 0 : round2(b.cost / totalCost),
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** Top-N tool usage per group (mirrors /api/tools, capped). */
function buildTools(sessions) {
  const core = new Map();
  const shell = new Map();
  const mcp = new Map();
  for (const s of sessions) {
    for (const x of s.tools?.coreTools ?? []) core.set(x.name, (core.get(x.name) ?? 0) + x.count);
    for (const x of s.tools?.shellCommands ?? []) shell.set(x.name, (shell.get(x.name) ?? 0) + x.count);
    for (const x of s.tools?.mcpServers ?? []) mcp.set(x.name, (mcp.get(x.name) ?? 0) + x.count);
  }
  const topN = (m) =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, MAX_TOOLS_PER_GROUP);
  return {
    coreTools: topN(core),
    shellCommands: topN(shell),
    mcpServers: topN(mcp),
  };
}

/** Top projects by cost (rollupByProject, trimmed). */
function buildProjects(sessions) {
  // rollupByProject already sorts by totalCost desc.
  return rollupByProject(sessions)
    .slice(0, MAX_PROJECTS)
    .map((p) => ({
      project: p.project,
      sessionCount: p.sessionCount,
      totalTokens: p.totalTokens,
      totalCost: round2(p.totalCost),
      lastActive: p.lastActive,
    }));
}

/** Per-day cost/sessions over the period window (rollupByDay, trimmed). */
function buildDaily(sessions) {
  return rollupByDay(sessions).map((d) => ({
    date: d.date,
    sessionCount: d.sessionCount,
    totalTokens: d.totalTokens,
    totalCost: round2(d.totalCost),
  }));
}

/**
 * Activity heatmap over the last ACTIVITY_PERIOD_DAYS (uses ALL sessions).
 *
 * SPARSE on purpose: a dense 180-day array is ~85% zeros (~7 KB of
 * `{date,sessions:0,intensity:0}`), which dominated the payload. We emit only
 * days WITH activity plus the window bounds (`rangeStart`..`today`); the iOS
 * reader reconstructs the dense grid, defaulting missing dates to zero.
 * `intensity` is still computed over the full dense window, so its scaling is
 * unchanged — we filter after bucketing, never before.
 */
function buildActivity(allSessions, today, tz) {
  const days = aggregateDailyActivity(allSessions, { today, periodDays: ACTIVITY_PERIOD_DAYS, tz });
  return {
    periodDays: ACTIVITY_PERIOD_DAYS,
    rangeStart: days[0]?.date ?? today,
    today,
    activeDays: countActiveDays(days),
    currentStreak: computeCurrentStreak(days, today),
    longestStreak: computeLongestStreak(days),
    days: days
      .filter((d) => d.sessions > 0)
      .map((d) => ({ date: d.date, sessions: d.sessions, intensity: d.intensity })),
  };
}

/**
 * Assemble the compact analytics snapshot.
 *
 * @param {object}  args
 * @param {{ loadAllSummaries: () => Promise<object[]> }} args.store
 * @param {{ load: () => Promise<object|null> }}          args.usageStore
 * @param {number}  [args.subscriptionCost=200]  monthly plan cost for ROI
 * @param {string}  [args.period='30d']          window for the headline breakdowns
 * @param {string}  [args.tz='UTC']              IANA timezone for day bucketing
 * @param {Date}    [args.now=new Date()]        injectable clock (tests)
 * @returns {Promise<object>} the snapshot (WITHOUT seq/writerId — parent stamps those)
 */
export async function buildSnapshot({
  store,
  usageStore,
  subscriptionCost = 200,
  period = DEFAULT_PERIOD,
  tz = 'UTC',
  now = new Date(),
}) {
  const allSessions = await store.loadAllSummaries();
  const sessions = filterSessions(allSessions, { period, now });
  const today = todayInTz(now, tz);

  const usageRecord = await usageStore.load();
  const usage = usageRecord
    ? { ingested: true, ingestedAt: usageRecord.ingestedAt ?? null, plan: usageRecord.normalized ?? null }
    : { ingested: false };

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    period,
    summary: buildSummary(sessions),
    projects: buildProjects(sessions),
    daily: buildDaily(sessions),
    models: buildModels(sessions),
    tools: buildTools(sessions),
    activity: buildActivity(allSessions, today, tz),
    roi: apiReplacementValue({
      apiEquivalentSpend: sumSessionCosts(sessions),
      subscriptionCost,
      extraUsageSpend: 0,
    }),
    usage,
  };
}
