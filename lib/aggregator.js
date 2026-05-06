/**
 * Session / project / daily / model rollups per PRD v3.1 §2.4.
 *
 * Operates on deduped turns from parser.js. Combines cost-calculator,
 * classifier, cache-analyzer, and tool-analyzer outputs into a single
 * session summary.
 */

import { resolveProjectName } from './parser.js';
import {
  costForTurn,
  resolveModelRates,
  envFallbackRates,
} from './cost-calculator.js';
import { classifyAll, CATEGORIES } from './classifier.js';
import {
  cacheHitRate,
  netCacheSavings,
  aggregateUsage,
} from './cache-analyzer.js';
import { analyzeTools } from './tool-analyzer.js';

/**
 * Summarize a single session.
 *
 * @param {Array} turns deduped turns from parser.parseSession
 * @param {object} options
 * @param {object} options.priceTable from cost-calculator.loadPriceTable
 * @param {object} options.envFallback from cost-calculator.envFallbackRates
 * @param {string} [options.encodedDirName]
 */
export function summarizeSession(turns, options) {
  const { priceTable, envFallback, encodedDirName } = options;
  const assistantTurns = turns.filter((t) => t.type === 'assistant');

  if (assistantTurns.length === 0) {
    return null;
  }

  const sessionId = assistantTurns[0].sessionId;
  const cwd = assistantTurns[0].cwd;
  const gitBranch = assistantTurns[0].gitBranch;
  const version = assistantTurns[0].version;
  const startedAt = assistantTurns[0].timestamp;
  const endedAt = assistantTurns[assistantTurns.length - 1].timestamp;
  const project = resolveProjectName(assistantTurns[0], encodedDirName);

  const tokens = aggregateUsage(assistantTurns);

  const userTurnCount = turns.filter((t) => t.type === 'user').length;
  let toolCallCount = 0;
  let subagentLaunches = 0;
  for (const t of assistantTurns) {
    for (const b of t.contentBlocks ?? []) {
      if (b?.type !== 'tool_use') continue;
      toolCallCount += 1;
      if (b.name === 'Agent' || b.name === 'Task') subagentLaunches += 1;
    }
  }
  // Backward-compat alias: also surface as subagentTurnCount in returned object
  const subagentTurnCount = subagentLaunches;

  const byModel = new Map();
  const byHour = new Array(24).fill(0).map(() => ({ calls: 0, cost: 0 }));
  let totalCost = 0;
  let totalNetCacheSavings = 0;

  for (const turn of assistantTurns) {
    const cost = costForTurn(turn.usage, turn.model, priceTable.prices, envFallback);
    totalCost += cost.total;
    const rates = resolveModelRates(turn.model, priceTable.prices, envFallback);
    totalNetCacheSavings += netCacheSavings(turn.usage, rates);

    const modelKey = turn.model ?? 'unknown';
    const bucket = byModel.get(modelKey) ?? {
      model: modelKey,
      turnCount: 0,
      tokens: aggregateUsage([]),
      cost: 0,
    };
    bucket.turnCount += 1;
    addUsageInPlace(bucket.tokens, turn.usage);
    bucket.cost += cost.total;
    byModel.set(modelKey, bucket);

    const ts = Date.parse(turn.timestamp);
    if (Number.isFinite(ts)) {
      const h = new Date(ts).getUTCHours();
      byHour[h].calls += 1;
      byHour[h].cost += cost.total;
    }
  }

  // attach cacheHitRate per model
  const byModelEnriched = [...byModel.values()]
    .map((m) => ({ ...m, cacheHitRate: cacheHitRate(m.tokens) }))
    .sort((a, b) => b.cost - a.cost);

  const classifications = classifyAll(turns);
  const taskBreakdown = buildTaskBreakdown(classifications);
  const tools = analyzeTools(turns);

  const durationMs = computeDurationMs(startedAt, endedAt);
  const burnRate = computeBurnRate(tokens, durationMs);

  return {
    sessionId,
    project,
    cwd,
    gitBranch,
    version,
    startedAt,
    endedAt,
    durationMs,
    turnCount: assistantTurns.length,
    userTurnCount,
    messageCount: assistantTurns.length + userTurnCount,
    toolCallCount,
    subagentTurnCount,
    tokens,
    cost: totalCost,
    burnRateTokensPerHour: burnRate,
    cacheHitRate: cacheHitRate(tokens),
    netCacheSavings: totalNetCacheSavings,
    byModel: byModelEnriched,
    byHour,
    tasks: taskBreakdown,
    tools,
  };
}

function addUsageInPlace(target, usage) {
  if (!usage) return;
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheCreate5m += usage.cacheCreate5m ?? 0;
  target.cacheCreate1h += usage.cacheCreate1h ?? 0;
  target.webSearches += usage.webSearches ?? 0;
  target.webFetches += usage.webFetches ?? 0;
}

function buildTaskBreakdown(classifications) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const { category } of classifications) {
    counts[category] = (counts[category] ?? 0) + 1;
  }
  const total = classifications.length;
  const items = CATEGORIES.map((c) => ({
    category: c,
    turns: counts[c],
    pct: total === 0 ? 0 : counts[c] / total,
  }))
    .filter((it) => it.turns > 0)
    .sort((a, b) => b.turns - a.turns);
  const primary = items[0]?.category ?? null;
  return { primary, total, breakdown: items };
}

function computeDurationMs(start, end) {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

function computeBurnRate(tokens, durationMs) {
  if (!durationMs || durationMs <= 0) return null;
  const totalTokens =
    (tokens.inputTokens ?? 0) +
    (tokens.outputTokens ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheCreate5m ?? 0) +
    (tokens.cacheCreate1h ?? 0);
  const hours = durationMs / 3_600_000;
  return totalTokens / hours;
}

/**
 * Roll up many session summaries by project.
 */
export function rollupByProject(sessions) {
  const map = new Map();
  for (const s of sessions ?? []) {
    if (!s) continue;
    const key = s.project ?? 'unknown';
    const bucket = map.get(key) ?? {
      project: key,
      sessionCount: 0,
      totalTokens: 0,
      totalCost: 0,
      turnCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      subagentTurnCount: 0,
      tokens: aggregateUsage([]),
      lastActive: null,
    };
    bucket.sessionCount += 1;
    bucket.totalTokens +=
      (s.tokens.inputTokens ?? 0) +
      (s.tokens.outputTokens ?? 0) +
      (s.tokens.cacheRead ?? 0) +
      (s.tokens.cacheCreate5m ?? 0) +
      (s.tokens.cacheCreate1h ?? 0);
    bucket.totalCost += s.cost ?? 0;
    bucket.turnCount += s.turnCount ?? 0;
    bucket.messageCount += s.messageCount ?? 0;
    bucket.toolCallCount += s.toolCallCount ?? 0;
    bucket.subagentTurnCount += s.subagentTurnCount ?? 0;
    addUsageInPlace(bucket.tokens, s.tokens);
    if (!bucket.lastActive || s.endedAt > bucket.lastActive) {
      bucket.lastActive = s.endedAt;
    }
    map.set(key, bucket);
  }
  return [...map.values()]
    .map((b) => ({
      ...b,
      avgCostPerSession: b.sessionCount === 0 ? 0 : b.totalCost / b.sessionCount,
      cacheHitRate: cacheHitRate(b.tokens),
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

/**
 * Aggregate hourly call/cost distribution across many sessions.
 * Returns [{hour, calls, cost}] for hours 0..23 (UTC).
 */
export function rollupByHour(sessions) {
  const out = new Array(24).fill(0).map((_, h) => ({ hour: h, calls: 0, cost: 0 }));
  for (const s of sessions ?? []) {
    for (let h = 0; h < 24; h++) {
      out[h].calls += s.byHour?.[h]?.calls ?? 0;
      out[h].cost += s.byHour?.[h]?.cost ?? 0;
    }
  }
  return out;
}

/**
 * Aggregate task counts across sessions.
 */
export function rollupByTask(sessions) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let totalTurns = 0;
  for (const s of sessions ?? []) {
    for (const item of s.tasks?.breakdown ?? []) {
      counts[item.category] = (counts[item.category] ?? 0) + item.turns;
      totalTurns += item.turns;
    }
  }
  return CATEGORIES
    .map((cat) => ({
      category: cat,
      turns: counts[cat],
      pct: totalTurns === 0 ? 0 : counts[cat] / totalTurns,
    }))
    .filter((x) => x.turns > 0)
    .sort((a, b) => b.turns - a.turns);
}

/**
 * Roll up sessions by UTC calendar day. (Locale-aware variants are a
 * dashboard-side concern; the API stays in UTC for stability.)
 */
export function rollupByDay(sessions) {
  const map = new Map();
  for (const s of sessions ?? []) {
    if (!s?.startedAt) continue;
    const day = s.startedAt.slice(0, 10); // YYYY-MM-DD UTC
    const bucket = map.get(day) ?? {
      date: day,
      sessionCount: 0,
      totalTokens: 0,
      totalCost: 0,
      byProject: {},
      byModel: {},
    };
    bucket.sessionCount += 1;
    bucket.totalTokens +=
      (s.tokens.inputTokens ?? 0) +
      (s.tokens.outputTokens ?? 0) +
      (s.tokens.cacheRead ?? 0) +
      (s.tokens.cacheCreate5m ?? 0) +
      (s.tokens.cacheCreate1h ?? 0);
    bucket.totalCost += s.cost ?? 0;
    const proj = s.project ?? 'unknown';
    bucket.byProject[proj] = (bucket.byProject[proj] ?? 0) + (s.cost ?? 0);
    for (const m of s.byModel ?? []) {
      bucket.byModel[m.model] = (bucket.byModel[m.model] ?? 0) + m.cost;
    }
    map.set(day, bucket);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Top N most expensive sessions across the input set.
 */
export function topExpensiveSessions(sessions, limit = 5) {
  return [...(sessions ?? [])]
    .filter(Boolean)
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .slice(0, limit)
    .map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      cost: s.cost,
      tokens: s.tokens,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
}
