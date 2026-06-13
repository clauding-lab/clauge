#!/usr/bin/env node
/**
 * Clauge — Claude Code token analytics + subscription value dashboard.
 *
 * Routes wire the lib modules over a Hono server. PRD v3.1 §2.9 endpoints.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import 'dotenv/config';
import open from 'open';

import { SessionStore } from './lib/session-store.js';
import {
  UsageStore,
  normalizeUsage as normalizePlanUsage,
  normalizeBalance,
  normalizeOverageSpendLimit,
  unknownKeysWarning,
} from './lib/usage-store.js';
import { bookmarkletHref, bookmarkletSource } from './lib/bookmarklet.js';
import { loadPriceTable, envFallbackRates } from './lib/cost-calculator.js';
import { filterSessions, isValidPeriod } from './lib/period.js';
import {
  rollupByProject,
  rollupByDay,
  rollupByHour,
  rollupByTask,
  topExpensiveSessions,
} from './lib/aggregator.js';
import { aggregateUsage } from './lib/cache-analyzer.js';
import { apiReplacementValue, sumSessionCosts } from './lib/roi-calculator.js';
import { buildSnapshot } from './lib/snapshot.js';
import { ConfigStore } from './lib/config-store.js';
import { AlertState } from './lib/alert-state.js';
import { UsageHistory } from './lib/usage-history.js';
import { buildProjection } from './lib/projection.js';
import { evaluate } from './lib/alert-engine.js';
import { configPaths } from './lib/config-paths.js';
import { CATEGORIES } from './lib/classifier.js';
import { toCsv, toJson } from './lib/exporter.js';
import { listProviders, PROVIDERS } from './lib/providers.js';
import { setProviderEnabled } from './lib/settings-writer.js';
import { runCli } from './lib/cli/index.js';
import {
  aggregateDailyActivity,
  countActiveDays,
  computeCurrentStreak,
  computeLongestStreak,
} from './lib/activity.js';

// CLI mode short-circuit. ANY argv past the script name routes through the
// CLI dispatcher (which prints usage + exit 2 on unknown verbs). This way
// typos like `clauge confg get` get a clean error instead of a confusing
// server startup. Plain `node server.js` (no extra args) falls through
// to the Hono setup below — preserves the legacy npx-clauge entry point.
if (process.argv.length > 2) {
  process.exit(await runCli(process.argv.slice(2)));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT ?? 3456);
const CLAUDE_DIR = (process.env.CLAUDE_DIR ?? join(homedir(), '.claude'))
  .replace(/^~(?=\/)/, homedir());
// Subscription cost is a persisted setting (projection spec Component 4):
// ~/.clauge/config.json value -> SUBSCRIPTION_COST env -> 200, validated
// read-side at every tier. Resolved per request via the getter so a
// POST /api/config/subscription-cost applies without a sidecar restart.
const configStore = new ConfigStore({
  filePath: configPaths.configFile(),
  env: process.env,
});

let APP_VERSION = '0.0.0-unknown';
try {
  APP_VERSION = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8')
  ).version;
} catch {
  // SEA bundle path: package.json may not be co-located with the bundle.
  // The SEA bootstrap extracts it as an asset; in the unlikely case the
  // extraction is missing, fall through to the placeholder.
}

const envFallback = envFallbackRates(process.env);
const priceTable = await loadPriceTable();
console.log(`[Clauge] Pricing source: ${priceTable.source}`);

const store = new SessionStore({ claudeDir: CLAUDE_DIR, priceTable, envFallback });
const usageStore = new UsageStore();
await usageStore.load();
// Alert fired-key state (~/.clauge/alert-state.json). Sidecar-owned, atomic
// tmp+rename, pruned of expired keys on each load — drives the once-per-
// window-instance dedup for the desktop-alerts poller (active-guardrail B).
const alertState = new AlertState({ filePath: configPaths.alertStateFile() });
const usageHistory = new UsageHistory({
  filePath: join(homedir(), '.clauge', 'usage-history.jsonl'),
});
// Startup prune (90-day retention, projection spec Component 2).
// Fire-and-forget: a prune failure must never block server boot;
// UsageHistory tolerates corrupt/missing files internally.
usageHistory.prune(Date.now()).catch((err) => {
  console.warn(`[Clauge] usage-history prune failed: ${err?.message ?? err}`);
});
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPruneAtMs = Date.now();

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

// CORS strategy:
//   - READ-ONLY endpoints use a REFLECTING ALLOWLIST limited to Clauge's own
//     loopback origins: protocol `http`, host `127.0.0.1` or `localhost`, ANY
//     port (the sidecar can crash-respawn onto a fallback port). See
//     `isAllowedReadOrigin` / `readOnlyCors` below. The matched origin is
//     echoed back as `Access-Control-Allow-Origin`; everything else is denied,
//     so a website you visit can't read your local usage data. The Tauri
//     popover loads from one of those loopback origins and fetches
//     `http://127.0.0.1:<port>/api/...`, so it stays allowed.
//   - The explicit `127.0.0.1` bind is STILL load-bearing on its own: it keeps
//     the listener off the LAN (see the `hostname: '127.0.0.1'` arg passed to
//     `serve()` in `listenWithRetry` below). Without it, @hono/node-server
//     would default to 0.0.0.0 (all interfaces) and expose the server to the
//     local network regardless of CORS. The allowlist + the bind are
//     independent defences — keep both.
//   - TIGHTER, SEPARATE per-route allowlist for `/api/usage/ingest` (the only
//     write endpoint exposed to other origins). Defined later in this file via
//     its own `app.use('/api/usage/ingest', …)` middleware — it permits only
//     claude.ai + browser-extension origins, not loopback.
//
// Implementation note: we list the read-only paths explicitly rather than
// using `app.use('*', cors(...))` because a global matcher would override
// the ingest-specific OPTIONS handler (Hono short-circuits OPTIONS in the
// cors() middleware — the per-route OPTIONS handler never runs once the
// global one fires).
const READ_ONLY_API_PATHS = [
  '/api/health',
  '/api/summary',
  '/api/sessions/*',
  '/api/sessions',
  '/api/projects',
  '/api/daily',
  '/api/models',
  '/api/hours',
  '/api/tasks',
  '/api/tools',
  '/api/cache',
  '/api/roi',
  '/api/snapshot',
  '/api/config',
  '/api/usage',          // GET + DELETE — reading or wiping local usage
  '/api/bookmarklet',
  '/api/export',
  '/api/activity',
  '/api/projection',
];
// Read-only endpoints are reachable cross-origin ONLY by Clauge's own webviews,
// which load from http://127.0.0.1:<port> or http://localhost:<port> (any port —
// the sidecar can land on a crash-respawn fallback). Reflect those origins;
// deny everything else (a website you visit can no longer read local data).
function isAllowedReadOrigin(origin) {
  if (!origin) return false; // same-origin simple GET: no ACAO needed
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}
const readOnlyCors = cors({
  origin: (origin) => (isAllowedReadOrigin(origin) ? origin : null),
  allowMethods: ['GET', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
});
for (const path of READ_ONLY_API_PATHS) {
  app.use(path, readOnlyCors);
}

// CORS for the ingest endpoint.
//   - claude.ai (bookmarklet)
//   - chrome-extension://* (the Clauge Sync extension)
const STATIC_INGEST_ORIGINS = new Set([
  'https://claude.ai',
  'https://www.claude.ai',
]);
function isAllowedIngestOrigin(origin) {
  if (!origin) return false;
  if (STATIC_INGEST_ORIGINS.has(origin)) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('moz-extension://')) return true;
  return false;
}

app.use('/api/usage/ingest', async (c, next) => {
  const origin = c.req.header('origin');
  const allow = isAllowedIngestOrigin(origin) ? origin : '';
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      },
    });
  }
  await next();
  if (allow) {
    c.res.headers.set('Access-Control-Allow-Origin', allow);
    c.res.headers.set('Vary', 'Origin');
  }
});

app.get('/api/health', async (c) => {
  const record = await usageStore.load();
  return c.json({
    service: 'clauge',
    status: 'ok',
    version: APP_VERSION,
    pid: process.pid,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    extensionLastSeenAt: record?.ingestedAt ?? null,
  });
});

app.get('/api/summary', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const { sessions, period, project } = filtered;
  const tokens = aggregateUsageOf(sessions);
  const total = sumSessionCosts(sessions);
  const sessionCount = sessions.length;
  const avgCostPerSession = sessionCount === 0 ? 0 : total / sessionCount;
  let messageCount = 0;
  let toolCallCount = 0;
  let subagentTurnCount = 0;
  let assistantTurnCount = 0;
  let primaryModel = null;
  let primaryModelTokens = 0;
  const modelTokens = new Map();
  for (const s of sessions) {
    messageCount += s.messageCount ?? 0;
    toolCallCount += s.toolCallCount ?? 0;
    subagentTurnCount += s.subagentTurnCount ?? 0;
    assistantTurnCount += s.turnCount ?? 0;
    for (const m of s.byModel ?? []) {
      const t = totalTokens(m.tokens);
      modelTokens.set(m.model, (modelTokens.get(m.model) ?? 0) + t);
    }
  }
  for (const [model, t] of modelTokens) {
    if (t > primaryModelTokens) {
      primaryModel = model;
      primaryModelTokens = t;
    }
  }
  return c.json({
    period,
    project,
    sessionCount,
    tokens,
    totalTokens: totalTokens(tokens),
    cost: total,
    avgCostPerSession,
    messageCount,
    toolCallCount,
    subagentTurnCount,
    assistantTurnCount,
    primaryModel,
    primaryModelTokens,
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
      const b = map.get(m.model) ?? {
        model: m.model,
        turnCount: 0,
        cost: 0,
        tokens: aggregateUsage([]),
      };
      b.turnCount += m.turnCount;
      b.cost += m.cost;
      const t = m.tokens ?? {};
      b.tokens.inputTokens += t.inputTokens ?? 0;
      b.tokens.outputTokens += t.outputTokens ?? 0;
      b.tokens.cacheRead += t.cacheRead ?? 0;
      b.tokens.cacheCreate5m += t.cacheCreate5m ?? 0;
      b.tokens.cacheCreate1h += t.cacheCreate1h ?? 0;
      map.set(m.model, b);
      totalCost += m.cost;
    }
  }
  const items = [...map.values()]
    .map((b) => {
      const denom =
        (b.tokens.cacheRead ?? 0) +
        (b.tokens.cacheCreate5m ?? 0) +
        (b.tokens.cacheCreate1h ?? 0) +
        (b.tokens.inputTokens ?? 0);
      return {
        model: b.model,
        turnCount: b.turnCount,
        tokens: totalTokens(b.tokens),
        cost: b.cost,
        cacheHitRate: denom === 0 ? null : b.tokens.cacheRead / denom,
        pctOfTotal: totalCost === 0 ? 0 : b.cost / totalCost,
      };
    })
    .sort((a, b) => b.cost - a.cost);
  return c.json({ period: filtered.period, models: items });
});

app.get('/api/hours', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  return c.json({ period: filtered.period, hours: rollupByHour(filtered.sessions) });
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

// Activity heatmap (v0.9.4 Phase A). Returns a dense per-day record array
// suitable for the GitHub-style heatmap renderer in both the dashboard and
// the popover. Heavy lifting lives in lib/activity.js; this handler is a
// thin wrapper over store.loadAllSummaries() + the pure aggregator.
app.get('/api/activity', async (c) => {
  const periodParam = c.req.query('period') ?? '365d';
  const tz = c.req.query('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  let periodDays;
  if (periodParam === 'all') {
    periodDays = 'all';
  } else if (periodParam === '120d') {
    periodDays = 120;
  } else if (periodParam === '180d') {
    periodDays = 180;
  } else if (periodParam === '365d') {
    periodDays = 365;
  } else {
    return c.json({ error: `unsupported period '${periodParam}' — expected 120d, 180d, 365d, or all` }, 400);
  }

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const all = await store.loadAllSummaries();
  const days = aggregateDailyActivity(all, { today, periodDays, tz });
  const rangeStart = days[0]?.date ?? today;

  return c.json({
    period: periodParam,
    tz,
    today,
    rangeStart,
    totalDays: days.length,
    activeDays: countActiveDays(days),
    currentStreak: computeCurrentStreak(days, today),
    longestStreak: computeLongestStreak(days),
    days,
  });
});

app.get('/api/roi', async (c) => {
  const filtered = await loadFiltered(c);
  if (filtered.error) return c.json(filtered, 400);
  const apiEquivalentSpend = sumSessionCosts(filtered.sessions);
  return c.json({
    period: filtered.period,
    ...apiReplacementValue({
      apiEquivalentSpend,
      subscriptionCost: await configStore.effectiveSubscriptionCost(),
      extraUsageSpend: 0,
    }),
  });
});

// On-device projection (active-guardrail sub-project A). ALL math lives in
// lib/projection.js (pure, clock-injected); this handler only wires the
// stores to the pure module and stamps generatedAt. nowMs is injected HERE
// — Date.now() is allowed in server.js, never in lib/ (house rule).
// Assemble the live projection from the current usage record + per-window
// history (single-pass JSONL read, canonical WINDOW_KEYS so a new window flows
// through automatically) + the trailing-7d spend (the same filterSessions '7d'
// + sumSessionCosts pipeline /api/roi uses — data contract #4). Single source
// of truth for the projection inputs so /api/projection and /api/alerts/pending
// can't drift. Returns the raw usage record too (the alert engine reads
// record.normalized for the observed pct). Caller injects ONE nowMs.
async function buildLiveProjection(nowMs) {
  const record = await usageStore.load();
  const history = await usageHistory.samplesByWindow();
  const all = await store.loadAllSummaries();
  const trailing = filterSessions(all, { period: '7d', project: '', now: new Date(nowMs) });
  const projection = buildProjection({
    normalized: record?.normalized ?? null,
    ingestedAt: record?.ingestedAt ?? null,
    history,
    nowMs,
    apiEquivalentSpendTrailing: sumSessionCosts(trailing),
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
  });
  // `history` is returned too (additive — /api/projection + /api/alerts/pending
  // destructure only what they use) so /api/snapshot can re-publish the hero
  // windows' recent samples (forecastHistory) on the SAME nowMs + JSONL read.
  return { record, projection, history };
}

app.get('/api/projection', async (c) => {
  const nowMs = Date.now();
  const { projection } = await buildLiveProjection(nowMs);
  return c.json({ generatedAt: new Date(nowMs).toISOString(), ...projection });
});

// Desktop-alerts decision endpoint (active-guardrail sub-project B). Consumed
// ONLY by the Rust alert poller over loopback (LOCAL_CLIENT, Origin-less) — so
// it is deliberately NOT in READ_ONLY_API_PATHS (the webview never reads it).
// Capture nowMs ONCE and thread the SAME value into buildProjection, the
// alert-state prune (AlertState.load(nowMs)), and evaluate — so the freshness
// boundary, the prune cutoff, and the body's local-time strings can't straddle
// a tick. PURE READ: nothing is marked fired here; all mutation is in the ack,
// so a Rust crash before firing re-fires next tick (at-least-once).
app.get('/api/alerts/pending', async (c) => {
  const nowMs = Date.now();
  const { record, projection } = await buildLiveProjection(nowMs);
  const prefs = await configStore.effectiveAlertPrefs();
  const fired = await alertState.load(nowMs);
  const { due, retire } = evaluate({
    usage: record?.normalized ?? null,
    projection,
    prefs,
    fired,
    nowMs,
  });
  return c.json({ due, retire });
});

// Mark the union of {fired, retired} keys as fired in alert-state (one atomic
// write). `fired` = alerts Rust attempted to show; `retired` = the severity-
// collapsed lesser keys Rust never shows but that are spent. Idempotent. 400
// on a non-array field. Loopback-only (not in READ_ONLY_API_PATHS).
app.post('/api/alerts/ack', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'expected body: { fired: [...], retired: [...] }' }, 400);
  }
  const fired = body.fired ?? [];
  const retired = body.retired ?? [];
  if (!Array.isArray(fired) || !Array.isArray(retired)) {
    return c.json({ error: 'fired and retired must be arrays' }, 400);
  }
  await alertState.markFired([...fired, ...retired], Date.now());
  return c.json({ ok: true });
});

// Phase ②b: one compact, curated analytics snapshot the Tauri parent fetches
// over loopback, stamps with seq+writerId, and writes (coordinated) into the
// app's iCloud container for the companion iOS app. Read-only; covered by the
// same loopback CORS allowlist as the other GET endpoints.
app.get('/api/snapshot', async (c) => {
  const tz = c.req.query('tz') ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  // ONE clock for the whole snapshot: the same nowMs feeds buildLiveProjection
  // (forecast values) and the forecastHistory 60-min slice, so the two can't
  // straddle a tick. The forecast block is re-published VERBATIM from the
  // projection — never recomputed here (no-drift with /api/projection).
  const nowMs = Date.now();
  const { projection, history } = await buildLiveProjection(nowMs);
  const snapshot = await buildSnapshot({
    store,
    usageStore,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    tz,
    now: new Date(nowMs),
    history,
    weekOverWeek: projection.windows?.sevenDay?.weekOverWeek ?? null,
    roiPace: projection.roiPace ?? null,
  });
  return c.json(snapshot);
});

app.get('/api/config', async (c) => {
  const providers = await listProviders();
  return c.json({
    claudeDir: CLAUDE_DIR,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    alerts: await configStore.effectiveAlertPrefs(),
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    providers,
  });
});

app.post('/api/config/providers/:name', async (c) => {
  const name = c.req.param('name');
  const known = new Set(PROVIDERS.map((p) => p.name));
  if (!known.has(name)) {
    return c.json({ error: `unknown provider: ${name}` }, 404);
  }
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body.enabled !== 'boolean') {
    return c.json({ error: 'expected body: { enabled: boolean }' }, 400);
  }
  await setProviderEnabled(name, body.enabled);
  const providers = await listProviders();
  const updated = providers.find((p) => p.name === name);
  return c.json({ provider: updated });
});

// Component 4 (projection spec): editable subscription cost. Mirrors the
// providers handler above: same-origin dashboard POST, no CORS middleware
// (READ_ONLY_API_PATHS' '/api/config' entry does not match this subpath,
// and the dashboard is served from this same origin). Validation matches
// ConfigStore.setSubscriptionCost: finite number > 0, strict type.
app.post('/api/config/subscription-cost', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const cost = body?.subscriptionCost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return c.json({ error: 'expected body: { subscriptionCost: <number > 0> }' }, 400);
  }
  await configStore.setSubscriptionCost(cost);
  return c.json({ subscriptionCost: await configStore.effectiveSubscriptionCost() });
});

// Per-type alert prefs (active-guardrail sub-project B). Same-origin dashboard
// POST + loopback NSMenu toggle; no CORS middleware (the '/api/config' entry in
// READ_ONLY_API_PATHS does not match this subpath). Body: { enabled?: boolean,
// types?: { approaching?, willHit?, limitReached? } }. 400 on any non-boolean
// field. Merges into the existing alerts block (toggling one preserves others).
app.post('/api/config/alerts', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'expected body: { enabled?: boolean, types?: {...} }' }, 400);
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    return c.json({ error: 'alerts.enabled must be a boolean' }, 400);
  }
  if ('types' in body) {
    if (!body.types || typeof body.types !== 'object') {
      return c.json({ error: 'alerts.types must be an object' }, 400);
    }
    for (const key of ['approaching', 'willHit', 'limitReached']) {
      if (key in body.types && typeof body.types[key] !== 'boolean') {
        return c.json({ error: `alerts.types.${key} must be a boolean` }, 400);
      }
    }
  }
  const effective = await configStore.setAlertPrefs(body);
  return c.json(effective);
});

app.post('/api/usage/ingest', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || !body.usage) {
    return c.json({ error: 'expected { org, usage }' }, 400);
  }
  const normalized = normalizePlanUsage(body.usage);
  unknownKeysWarning(normalized, (msg) => console.warn(msg));
  const claudeBalance = normalizeBalance(body.claudeBalance, null);
  const apiBalance = normalizeBalance(body.balance, null);
  const consumerOverage = normalizeOverageSpendLimit(body.overageSpendLimit);
  if (normalized) {
    if (claudeBalance) normalized.claudeBalance = claudeBalance;
    if (apiBalance) normalized.balance = apiBalance;
    if (consumerOverage) normalized.consumerOverage = consumerOverage;
  }
  const record = await usageStore.save({
    org: body.org ? { uuid: body.org.uuid, name: body.org.name } : null,
    rawOrg: body.org ?? null,
    raw: body.usage,
    rawClaudeBalance: body.claudeBalance ?? null,
    rawBalance: body.balance ?? null,
    rawOverageSpendLimit: body.overageSpendLimit ?? null,
    normalized,
  });
  // Projection spec Component 2: record a downsampled history sample,
  // fire-and-forget — a recorder failure must never fail an ingest.
  // UsageHistory.record never rejects by contract; the .catch is
  // belt-and-braces against unhandled-rejection if that ever drifts.
  // Guarded on normalized: normalizeUsage returns null for non-object
  // usage payloads, and a null record has no windows to sample.
  if (normalized) {
    usageHistory.record(normalized, record.ingestedAt).catch(() => {});
    if (Date.now() - lastPruneAtMs > PRUNE_INTERVAL_MS) {
      lastPruneAtMs = Date.now();
      usageHistory.prune(Date.now()).catch((err) => {
        console.warn(`[Clauge] usage-history prune failed: ${err?.message ?? err}`);
      });
    }
  }
  return c.json({
    ok: true,
    ingestedAt: record.ingestedAt,
    claudeBalanceFound: !!claudeBalance,
    apiBalanceFound: !!apiBalance,
    consumerOverageFound: !!consumerOverage,
  });
});

app.get('/api/usage', async (c) => {
  const record = await usageStore.load();
  if (!record) return c.json({ ingested: false }, 200);
  return c.json({
    ingested: true,
    ingestedAt: record.ingestedAt,
    org: record.org,
    plan: record.normalized,
  });
});

app.delete('/api/usage', async (c) => {
  await usageStore.clear();
  return c.json({ cleared: true });
});

app.get('/api/bookmarklet', (c) =>
  c.json({
    href: bookmarkletHref(PORT),
    source: bookmarkletSource(PORT),
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

const PORT_RETRY_LIMIT = 5;

// Stderr contract with Tauri sidecar parser (T9). Do not change format.
// See src-tauri/src/sidecar.rs (T9, not yet written) — Rust side will grep
// stderr for this exact prefix to discover the bound port.
const PORT_MARKER_PREFIX = 'CLAUGE_BOUND_PORT=';

async function listenWithRetry(startPort) {
  for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt++) {
    const tryPort = startPort + attempt;
    let ss;
    try {
      const s = await new Promise((resolve, reject) => {
        // hostname: '127.0.0.1' is LOAD-BEARING — it keeps the server off the
        // LAN independently of CORS. Defaulting to 0.0.0.0 (all interfaces)
        // would expose every dashboard read to anyone on the local network,
        // since the loopback CORS allowlist only governs cross-origin browser
        // reads, not direct network reachability.
        ss = serve({ fetch: app.fetch, port: tryPort, hostname: '127.0.0.1' }, () => resolve(ss));
        // @hono/node-server returns the http.Server directly; bind error
        // event for EADDRINUSE detection.
        ss.once('error', reject);
      });
      return { server: s, port: tryPort };
    } catch (err) {
      try { ss?.close(); } catch {}
      if (err.code !== 'EADDRINUSE') throw err;
      if (attempt < PORT_RETRY_LIMIT - 1) {
        console.log(`[Clauge] Port ${tryPort} in use; trying ${tryPort + 1}`);
      }
    }
  }
  throw new Error(
    `[Clauge] All ports ${startPort}..${startPort + PORT_RETRY_LIMIT - 1} in use`
  );
}

const { server, port: BOUND_PORT } = await listenWithRetry(PORT);
const url = `http://localhost:${BOUND_PORT}`;

// Install signal handlers BEFORE announcing the listening port. Otherwise a
// fast caller (test harness, Tauri parent) can SIGTERM us between the log line
// and the handler install, and Node's default action (terminate by signal)
// runs — leaving the file dirty (no graceful close, possibly partial writes).
const shutdown = (signal) => {
  console.log(`\n[Clauge] ${signal} received — shutting down`);
  // Order matters: server.close(cb) first so the callback is queued and we
  // stop accepting new connections; then closeAllConnections() destroys idle
  // keep-alive sockets, which lets the close() callback fire promptly instead
  // of waiting ~5s for the HTTP keep-alive drain. Available since Node 18.2;
  // optional-chained for safety against future @hono/node-server changes.
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`[Clauge] Listening on ${url}`);
console.log(`[Clauge] CLAUDE_DIR=${CLAUDE_DIR}`);
console.error(`${PORT_MARKER_PREFIX}${BOUND_PORT}`);  // for Tauri sidecar parser

if (process.env.NO_OPEN !== '1') {
  open(url).catch(() => {
    console.log('[Clauge] (could not auto-open browser; visit URL manually)');
  });
}
