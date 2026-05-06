/**
 * Integration smoke: parse + summarize a real session, dump to console.
 */

import { parseSession } from '../lib/parser.js';
import { summarizeSession } from '../lib/aggregator.js';
import { loadPriceTable, envFallbackRates } from '../lib/cost-calculator.js';
import { resolve } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node test/smoke-aggregator.js /path/to/session.jsonl');
  process.exit(1);
}
const file = resolve(arg);

const t0 = performance.now();
const turns = await parseSession(file);
const priceTable = await loadPriceTable();
const env = envFallbackRates();
const summary = summarizeSession(turns, { priceTable, envFallback: env });
const elapsed = (performance.now() - t0).toFixed(1);

console.log(`File: ${file}`);
console.log(`Parsed + summarized in ${elapsed}ms`);
console.log(`Price source: ${priceTable.source}`);

const display = {
  sessionId: summary.sessionId,
  project: summary.project,
  gitBranch: summary.gitBranch,
  version: summary.version,
  startedAt: summary.startedAt,
  endedAt: summary.endedAt,
  durationMin: summary.durationMs ? Math.round(summary.durationMs / 60000) : null,
  turnCount: summary.turnCount,
  tokensTotal:
    (summary.tokens.inputTokens || 0) +
    (summary.tokens.outputTokens || 0) +
    (summary.tokens.cacheRead || 0) +
    (summary.tokens.cacheCreate5m || 0) +
    (summary.tokens.cacheCreate1h || 0),
  tokens: summary.tokens,
  costUSD: Number(summary.cost.toFixed(4)),
  burnRateTokensPerHour: summary.burnRateTokensPerHour
    ? Math.round(summary.burnRateTokensPerHour)
    : null,
  cacheHitRatePct: summary.cacheHitRate != null
    ? Number((summary.cacheHitRate * 100).toFixed(1))
    : null,
  netCacheSavingsUSD: Number(summary.netCacheSavings.toFixed(4)),
  primaryTask: summary.tasks.primary,
  taskBreakdown: summary.tasks.breakdown,
  byModel: summary.byModel.map((m) => ({
    model: m.model,
    turns: m.turnCount,
    cost: Number(m.cost.toFixed(4)),
  })),
  topTools: summary.tools.coreTools.slice(0, 5),
  topShell: summary.tools.shellCommands.slice(0, 5),
  topMcp: summary.tools.mcpServers.slice(0, 5),
};

console.log(JSON.stringify(display, null, 2));
