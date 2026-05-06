#!/usr/bin/env node
/**
 * Clauge — Claude Code token analytics + subscription value dashboard.
 *
 * Routes wire the lib modules over a Hono server. PRD v3.1 §2.9 endpoints.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config';
import open from 'open';

import { SessionStore } from './lib/session-store.js';
import { loadPriceTable, envFallbackRates } from './lib/cost-calculator.js';
import { filterSessions, isValidPeriod } from './lib/period.js';
import {
  rollupByProject,
  rollupByDay,
  topExpensiveSessions,
} from './lib/aggregator.js';
import { apiReplacementValue, sumSessionCosts } from './lib/roi-calculator.js';
import { CATEGORIES } from './lib/classifier.js';
import { toCsv, toJson } from './lib/exporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT ?? 3456);
const CLAUDE_DIR = (process.env.CLAUDE_DIR ?? join(homedir(), '.claude'))
  .replace(/^~(?=\/)/, homedir());
const SUBSCRIPTION_COST = Number(process.env.SUBSCRIPTION_COST ?? 200);

const envFallback = envFallbackRates(process.env);
const priceTable = await loadPriceTable();
console.log(`[Clauge] Pricing source: ${priceTable.source}`);

const store = new SessionStore({ claudeDir: CLAUDE_DIR, priceTable, envFallback });

function parseFilters(c) {
  const period = c.req.query('period') ?? '7d';
  const project = c.req.query('project') ?? '';
  if (!isValidPeriod(period)) {
    return { error: `invalid period: ${period}` };
  }
  return { period, project };
}

async function loadFiltered(c) {
  const { period, project, error } = parseFilters(c);
  if (error) return { error };
  const all = await store.loadAllSummaries();
  return { sessions: filterSessions(all, { period, project }), period, project };
}

function aggregateUsageOf(sessions) {
  const acc = {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    webSearches: 0,
    webFetches: 0,
  };
  for (const s of sessions) {
    const t = s.tokens ?? {};
    acc.inputTokens += t.inputTokens ?? 0;
    acc.outputTokens += t.outputTokens ?? 0;
    acc.cacheRead += t.cacheRead ?? 0;
    acc.cacheCreate5m += t.cacheCreate5m ?? 0;
    acc.cacheCreate1h += t.cacheCreate1h ?? 0;
    acc.webSearches += t.webSearches ?? 0;
    acc.webFetches += t.webFetches ?? 0;
  }
  return acc;
}

function totalTokens(t) {
  return (t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreate5m ?? 0) + (t.cacheCreate1h ?? 0);
}

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    status: 'ok',
    version: '0.1.0',
    claudeDir: CLAUDE_DIR,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: SUBSCRIPTION_COST,
  })
);

app.get('/api/summary', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const { sessions, period, project } = filtered;
  const tokens = aggregateUsageOf(sessions);
  const total = sumSessionCosts(sessions);
  const sessionCount = sessions.length;
  const avgCostPerSession = sessionCount === 0 ? 0 : total / sessionCount;
  return c.json({
    period,
    project,
    sessionCount,
    tokens,
    totalTokens: totalTokens(tokens),
    cost: total,
    avgCostPerSession,
  });
});

app.get('/api/sessions', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  return c.json({
    period: filtered.period,
    project: filtered.project,
    count: filtered.sessions.length,
    sessions: filtered.sessions,
  });
});

app.get('/api/sessions/expensive', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') ?? 5)));
  return c.json({
    period: filtered.period,
    project: filtered.project,
    top: topExpensiveSessions(filtered.sessions, limit),
  });
});

app.get('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const all = await store.loadAllSummaries();
  const match = all.find((s) => s.sessionId === sessionId);
  if (!match) return c.json({ error: 'not found' }, 404);
  return c.json(match);
});

app.get('/api/projects', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  return c.json({
    period: filtered.period,
    projects: rollupByProject(filtered.sessions),
  });
});

app.get('/api/daily', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  return c.json({
    period: filtered.period,
    days: rollupByDay(filtered.sessions),
  });
});

app.get('/api/models', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const map = new Map();
  let totalCost = 0;
  for (const s of filtered.sessions) {
    for (const m of s.byModel ?? []) {
      const b = map.get(m.model) ?? { model: m.model, turnCount: 0, tokens: 0, cost: 0 };
      b.turnCount += m.turnCount;
      b.tokens += totalTokens(m.tokens);
      b.cost += m.cost;
      map.set(m.model, b);
      totalCost += m.cost;
    }
  }
  const items = [...map.values()]
    .map((b) => ({ ...b, pctOfTotal: totalCost === 0 ? 0 : b.cost / totalCost }))
    .sort((a, b) => b.cost - a.cost);
  return c.json({ period: filtered.period, models: items });
});

app.get('/api/tasks', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, { turns: 0, cost: 0 }]));
  let totalTurns = 0;
  let totalCost = 0;
  for (const s of filtered.sessions) {
    for (const item of s.tasks?.breakdown ?? []) {
      counts[item.category] ??= { turns: 0, cost: 0 };
      counts[item.category].turns += item.turns;
      // cost-per-task isn't computed per-turn (heuristic primary intent
      // doesn't decompose costs cleanly); leave as 0 for now.
      totalTurns += item.turns;
    }
    totalCost += s.cost ?? 0;
  }
  const items = CATEGORIES
    .map((cat) => ({
      category: cat,
      turns: counts[cat].turns,
      pctOfTotal: totalTurns === 0 ? 0 : counts[cat].turns / totalTurns,
    }))
    .filter((it) => it.turns > 0);
  return c.json({ period: filtered.period, totalTurns, totalCost, tasks: items });
});

app.get('/api/tools', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const core = new Map();
  const shell = new Map();
  const mcp = new Map();
  for (const s of filtered.sessions) {
    for (const x of s.tools?.coreTools ?? []) core.set(x.name, (core.get(x.name) ?? 0) + x.count);
    for (const x of s.tools?.shellCommands ?? []) shell.set(x.name, (shell.get(x.name) ?? 0) + x.count);
    for (const x of s.tools?.mcpServers ?? []) mcp.set(x.name, (mcp.get(x.name) ?? 0) + x.count);
  }
  const sortedArr = (m) =>
    [...m.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return c.json({
    period: filtered.period,
    coreTools: sortedArr(core),
    shellCommands: sortedArr(shell),
    mcpServers: sortedArr(mcp),
  });
});

app.get('/api/cache', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const { sessions } = filtered;
  const tokens = aggregateUsageOf(sessions);
  const denom = (tokens.cacheRead ?? 0) + (tokens.cacheCreate5m ?? 0) + (tokens.cacheCreate1h ?? 0) + (tokens.inputTokens ?? 0);
  const hitRate = denom === 0 ? null : tokens.cacheRead / denom;
  let netSavings = 0;
  for (const s of sessions) netSavings += s.netCacheSavings ?? 0;
  // Daily hit rate trend
  const byDay = new Map();
  for (const s of sessions) {
    const day = (s.startedAt ?? '').slice(0, 10);
    if (!day) continue;
    const b = byDay.get(day) ?? {
      date: day, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, inputTokens: 0,
    };
    const t = s.tokens ?? {};
    b.cacheRead += t.cacheRead ?? 0;
    b.cacheCreate5m += t.cacheCreate5m ?? 0;
    b.cacheCreate1h += t.cacheCreate1h ?? 0;
    b.inputTokens += t.inputTokens ?? 0;
    byDay.set(day, b);
  }
  const dailyTrend = [...byDay.values()]
    .map((b) => {
      const d = b.cacheRead + b.cacheCreate5m + b.cacheCreate1h + b.inputTokens;
      return { date: b.date, hitRate: d === 0 ? null : b.cacheRead / d };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return c.json({ period: filtered.period, hitRate, netSavingsUSD: netSavings, dailyTrend });
});

app.get('/api/roi', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const apiEquivalentSpend = sumSessionCosts(filtered.sessions);
  return c.json({
    period: filtered.period,
    ...apiReplacementValue({
      apiEquivalentSpend,
      subscriptionCost: SUBSCRIPTION_COST,
      extraUsageSpend: 0,
    }),
  });
});

app.get('/api/config', (c) =>
  c.json({
    claudeDir: CLAUDE_DIR,
    subscriptionCost: SUBSCRIPTION_COST,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
  })
);

app.get('/api/export', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const format = (c.req.query('format') ?? 'csv').toLowerCase();
  if (format === 'csv') {
    return new Response(toCsv(filtered.sessions), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="clauge-${filtered.period}.csv"`,
      },
    });
  }
  if (format === 'json') {
    return new Response(toJson(filtered.sessions), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="clauge-${filtered.period}.json"`,
      },
    });
  }
  return c.json({ error: `unsupported format: ${format}` }, 400);
});

app.use('/*', serveStatic({ root: join(__dirname, 'public') }));

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`[Clauge] Listening on ${url}`);
  console.log(`[Clauge] CLAUDE_DIR=${CLAUDE_DIR}`);
  if (process.env.NO_OPEN !== '1') {
    open(url).catch(() => {
      console.log('[Clauge] (could not auto-open browser; visit URL manually)');
    });
  }
});

const shutdown = (signal) => {
  console.log(`\n[Clauge] ${signal} received — shutting down`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
