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

  const byModel = new Map();
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
  }

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
    tokens,
    cost: totalCost,
    burnRateTokensPerHour: burnRate,
    cacheHitRate: cacheHitRate(tokens),
    netCacheSavings: totalNetCacheSavings,
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
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
    if (!bucket.lastActive || s.endedAt > bucket.lastActive) {
      bucket.lastActive = s.endedAt;
    }
    map.set(key, bucket);
  }
  return [...map.values()]
    .map((b) => ({
      ...b,
      avgCostPerSession: b.sessionCount === 0 ? 0 : b.totalCost / b.sessionCount,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
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
