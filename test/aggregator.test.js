import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSession,
  rollupByProject,
  rollupByDay,
  topExpensiveSessions,
} from '../lib/aggregator.js';
import { envFallbackRates } from '../lib/cost-calculator.js';

const opusRates = {
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000025,
  cache_read_input_token_cost: 5e-7,
  cache_creation_input_token_cost: 0.00000625,
  cache_creation_input_token_cost_above_1hr: 0.00001,
  search_context_cost_per_query: { search_context_size_medium: 0.01 },
};

const priceTable = {
  source: 'litellm',
  prices: { 'claude-opus-4-7': opusRates },
};
const env = envFallbackRates({});

const t = (name, input = {}) => ({ type: 'tool_use', name, input });

function makeSession({ tokens, project = 'demo', startedAt, durationMs = 60_000 }) {
  const start = startedAt;
  const end = new Date(Date.parse(start) + durationMs).toISOString();
  return [
    {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'fix the bug' },
      timestamp: start,
    },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      requestId: 'req_1',
      sessionId: `session-${project}`,
      timestamp: start,
      cwd: `/Users/x/Projects/${project}`,
      gitBranch: 'main',
      version: '2.1.121',
      model: 'claude-opus-4-7',
      usage: { ...tokens, webSearches: 0, webFetches: 0 },
      contentBlocks: [t('Edit'), t('Bash', { command: 'pytest' })],
    },
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u1',
      requestId: 'req_2',
      sessionId: `session-${project}`,
      timestamp: end,
      cwd: `/Users/x/Projects/${project}`,
      gitBranch: 'main',
      version: '2.1.121',
      model: 'claude-opus-4-7',
      usage: {
        inputTokens: 5,
        outputTokens: 50,
        cacheRead: 1000,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        webSearches: 0,
        webFetches: 0,
      },
      contentBlocks: [t('Read')],
    },
  ];
}

describe('summarizeSession', () => {
  it('rolls up tokens, cost, model breakdown, tasks, tools', () => {
    const turns = makeSession({
      tokens: {
        inputTokens: 100,
        outputTokens: 1000,
        cacheRead: 10000,
        cacheCreate5m: 0,
        cacheCreate1h: 5000,
      },
      startedAt: '2026-05-06T10:00:00.000Z',
    });
    const summary = summarizeSession(turns, { priceTable, envFallback: env });

    assert.equal(summary.sessionId, 'session-demo');
    assert.equal(summary.project, 'demo');
    assert.equal(summary.gitBranch, 'main');
    assert.equal(summary.version, '2.1.121');
    assert.equal(summary.turnCount, 2);
    assert.equal(summary.tokens.inputTokens, 105);
    assert.equal(summary.tokens.cacheCreate1h, 5000);
    assert.ok(summary.cost > 0);
    assert.equal(summary.byModel.length, 1);
    assert.equal(summary.byModel[0].model, 'claude-opus-4-7');
    assert.ok(summary.cacheHitRate > 0 && summary.cacheHitRate <= 1);
    assert.equal(summary.tasks.primary, 'Testing');
    assert.ok(summary.tools.coreTools.find((x) => x.name === 'Edit'));
  });

  it('returns null for sessions with no assistant turns', () => {
    assert.equal(
      summarizeSession([{ type: 'user', uuid: 'u1' }], { priceTable, envFallback: env }),
      null
    );
  });

  it('computes burn rate (tokens/hour) when duration > 0', () => {
    const turns = makeSession({
      tokens: {
        inputTokens: 0,
        outputTokens: 3600,
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
      },
      startedAt: '2026-05-06T10:00:00.000Z',
      durationMs: 3_600_000, // exactly 1 hour
    });
    const summary = summarizeSession(turns, { priceTable, envFallback: env });
    // total tokens = 3600 + (5 input + 50 output + 1000 cacheRead from second turn) = 4655
    // over 1h → 4655 tokens/hr
    assert.ok(summary.burnRateTokensPerHour > 4000 && summary.burnRateTokensPerHour < 5000);
  });
});

describe('rollupByProject', () => {
  it('groups sessions by project, sums cost, computes avg', () => {
    const sessions = [
      buildSummary({ project: 'a', cost: 10, tokens: 1000 }),
      buildSummary({ project: 'a', cost: 30, tokens: 3000 }),
      buildSummary({ project: 'b', cost: 5, tokens: 500 }),
    ];
    const out = rollupByProject(sessions);
    assert.equal(out[0].project, 'a');
    assert.equal(out[0].sessionCount, 2);
    assert.equal(out[0].totalCost, 40);
    assert.equal(out[0].avgCostPerSession, 20);
    assert.equal(out[0].totalTokens, 4000);
    assert.equal(out[1].project, 'b');
  });
});

describe('rollupByDay', () => {
  it('buckets by UTC date prefix', () => {
    const sessions = [
      buildSummary({ project: 'a', cost: 1, tokens: 100, startedAt: '2026-05-05T23:30:00Z' }),
      buildSummary({ project: 'a', cost: 2, tokens: 200, startedAt: '2026-05-06T00:30:00Z' }),
      buildSummary({ project: 'b', cost: 3, tokens: 300, startedAt: '2026-05-06T15:00:00Z' }),
    ];
    const out = rollupByDay(sessions);
    assert.equal(out.length, 2);
    assert.equal(out[0].date, '2026-05-05');
    assert.equal(out[0].totalCost, 1);
    assert.equal(out[1].date, '2026-05-06');
    assert.equal(out[1].totalCost, 5);
    assert.equal(out[1].sessionCount, 2);
    assert.equal(out[1].byProject.a, 2);
    assert.equal(out[1].byProject.b, 3);
  });
});

describe('topExpensiveSessions', () => {
  it('returns the N highest-cost sessions sorted desc', () => {
    const sessions = [
      buildSummary({ project: 'a', cost: 1 }),
      buildSummary({ project: 'b', cost: 100 }),
      buildSummary({ project: 'c', cost: 50 }),
    ];
    const top = topExpensiveSessions(sessions, 2);
    assert.equal(top.length, 2);
    assert.equal(top[0].project, 'b');
    assert.equal(top[1].project, 'c');
  });
});

function buildSummary({ project, cost, tokens = 0, startedAt = '2026-05-06T10:00:00Z' }) {
  return {
    sessionId: `s-${project}-${cost}`,
    project,
    cost,
    startedAt,
    endedAt: startedAt,
    tokens: {
      inputTokens: tokens,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
    },
    byModel: [{ model: 'claude-opus-4-7', cost }],
  };
}
