import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot } from '../lib/snapshot.js';

// Fixed "now" so period filtering + activity windows are deterministic.
const NOW = new Date('2026-06-05T12:00:00Z');

/** Build a session summary with only the fields buildSnapshot reads. */
function makeSession(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? 's1',
    project: overrides.project ?? 'proj',
    startedAt: overrides.startedAt ?? '2026-06-01T10:00:00Z',
    endedAt: overrides.endedAt ?? '2026-06-01T11:00:00Z',
    cost: overrides.cost ?? 1,
    turnCount: overrides.turnCount ?? 0,
    messageCount: overrides.messageCount ?? 0,
    toolCallCount: overrides.toolCallCount ?? 0,
    subagentTurnCount: overrides.subagentTurnCount ?? 0,
    tokens: overrides.tokens ?? { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0 },
    byModel: overrides.byModel ?? [{ model: 'claude-sonnet-4-6', turnCount: 1, cost: overrides.cost ?? 1, tokens: { inputTokens: 10, outputTokens: 5 } }],
    tools: overrides.tools ?? { coreTools: [], shellCommands: [], mcpServers: [] },
  };
}

function fakeStores(sessions, usageRecord = null) {
  return {
    store: { loadAllSummaries: async () => sessions },
    usageStore: { load: async () => usageRecord },
  };
}

const build = (sessions, usageRecord = null, opts = {}) =>
  buildSnapshot({
    ...fakeStores(sessions, usageRecord),
    subscriptionCost: 200,
    now: NOW,
    tz: 'UTC',
    ...opts,
  });

describe('buildSnapshot — phone analytics snapshot', () => {
  it('caps shellCommands to the top 15 by count to keep the phone snapshot small', async () => {
    const shellCommands = Array.from({ length: 25 }, (_, i) => ({ name: `cmd${i}`, count: 25 - i }));
    const snap = await build([makeSession({ tools: { coreTools: [], shellCommands, mcpServers: [] } })]);
    assert.equal(snap.tools.shellCommands.length, 15);
    // Highest-count command survives the trim; lowest does not.
    assert.equal(snap.tools.shellCommands[0].name, 'cmd0');
    assert.ok(!snap.tools.shellCommands.some((x) => x.name === 'cmd24'));
  });

  it('caps projects to the top 10 by cost', async () => {
    const sessions = Array.from({ length: 14 }, (_, i) =>
      makeSession({ sessionId: `s${i}`, project: `proj${i}`, cost: i + 1 }),
    );
    const snap = await build(sessions);
    assert.equal(snap.projects.length, 10);
    // Sorted by cost desc → most expensive project (proj13, cost 14) is first.
    assert.equal(snap.projects[0].project, 'proj13');
  });

  it('rounds monetary values to 2 decimal places', async () => {
    const snap = await build([makeSession({ cost: 1.23456 })]);
    assert.equal(snap.summary.cost, 1.23);
    assert.equal(snap.models[0].cost, 1.23);
    // No money field carries more than 2 decimals.
    const decimals = (n) => (String(n).split('.')[1] ?? '').length;
    assert.ok(decimals(snap.summary.cost) <= 2);
    assert.ok(decimals(snap.summary.avgCostPerSession) <= 2);
  });

  it('omits seq and writerId — the parent stamps freshness metadata, not the sidecar', async () => {
    const snap = await build([makeSession()]);
    assert.equal(snap.seq, undefined);
    assert.equal(snap.writerId, undefined);
  });

  it('returns a SPARSE activity heatmap (only active days, each {date, sessions, intensity}) plus window bounds', async () => {
    const snap = await build([makeSession()]);
    assert.equal(snap.activity.periodDays, 180);
    assert.ok(snap.activity.rangeStart <= snap.activity.today, 'rangeStart precedes today');
    assert.ok(Array.isArray(snap.activity.days));
    assert.ok(snap.activity.days.length > 0);
    for (const day of snap.activity.days) {
      assert.deepEqual(Object.keys(day).sort(), ['date', 'intensity', 'sessions']);
      assert.ok(day.sessions > 0, 'sparse: every emitted day has activity (no zero-filled days)');
    }
  });

  it('carries a stable schema version and a generated timestamp', async () => {
    const snap = await build([makeSession()]);
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.generatedAt, NOW.toISOString());
    assert.equal(snap.period, '30d');
  });

  it('reports the plan when usage has been ingested, and ingested:false otherwise', async () => {
    const withUsage = await build([makeSession()], { ingestedAt: '2026-06-05T00:00:00Z', normalized: { tier: 'max' } });
    assert.equal(withUsage.usage.ingested, true);
    assert.deepEqual(withUsage.usage.plan, { tier: 'max' });

    const without = await build([makeSession()], null);
    assert.equal(without.usage.ingested, false);
  });
});
