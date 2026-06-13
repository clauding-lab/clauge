import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot } from '../lib/snapshot.js';
import { RECENT_SPAN_MS } from '../lib/projection.js';

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
    // schemaVersion stays 1 — landmine #37: bumping it before a matching iOS
    // build is LIVE blanks every iPhone's Analytics tab (cross-repo contract).
    // The C1.5 forecast blocks ship as OPTIONAL keys UNDER schemaVersion 1, so
    // old iOS ignores them and the version must NOT move.
    assert.equal(snap.schemaVersion, 1);
    assert.ok(
      'forecast' in snap && 'forecastHistory' in snap,
      'new C1.5 blocks ship as OPTIONAL keys under schemaVersion 1 — no bump',
    );
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

// C1.5 desktop snapshot enrichment: forecastHistory is a bounded recent slice
// of the two HERO windows' raw usage-history samples, threaded in via opts.history.
// `pct` is engine-unit 0–100 and passes through UNCHANGED (no rescale). The bound
// is the 60-min RECENT_SPAN_MS time filter — NOT a hardcoded sample-count cap.
describe('buildSnapshot — forecastHistory recent slice', () => {
  const NOW_MS = NOW.getTime();
  const atIso = (offsetMs) => new Date(NOW_MS - offsetMs).toISOString();
  const RESETS = '2026-06-05T15:00:00Z';

  // A history map shaped exactly like UsageHistory.samplesByWindow(): one
  // oldest-first array of { at, pct, resetsAt } per window key.
  const makeHistory = () => ({
    fiveHour: [{ at: atIso(10 * 60 * 1000), pct: 47, resetsAt: RESETS }],
    sevenDay: [{ at: atIso(20 * 60 * 1000), pct: 12, resetsAt: RESETS }],
    sevenDaySonnet: [{ at: atIso(5 * 60 * 1000), pct: 30, resetsAt: RESETS }],
    dailyRoutines: [{ at: atIso(5 * 60 * 1000), pct: 5, resetsAt: RESETS }],
  });

  it('publishes ONLY the two hero windows (fiveHour, sevenDay), ignoring other window keys', async () => {
    const snap = await build([makeSession()], null, { history: makeHistory() });
    assert.deepEqual(Object.keys(snap.forecastHistory).sort(), ['fiveHour', 'sevenDay']);
  });

  it('keeps only samples within RECENT_SPAN_MS of now (<= boundary), oldest-first', async () => {
    const history = {
      fiveHour: [
        { at: atIso(RECENT_SPAN_MS + 60000), pct: 5, resetsAt: RESETS }, // dropped (older than 60 min)
        { at: atIso(RECENT_SPAN_MS), pct: 10, resetsAt: RESETS }, // kept (exactly 60 min, <=)
        { at: atIso(RECENT_SPAN_MS - 1), pct: 20, resetsAt: RESETS }, // kept (just inside)
      ],
      sevenDay: [],
    };
    const snap = await build([makeSession()], null, { history });
    // Two recent survive; oldest-first order is preserved (file order, no re-sort).
    assert.deepEqual(
      snap.forecastHistory.fiveHour.map((s) => s.pct),
      [10, 20],
    );
  });

  it('passes pct through UNCHANGED (engine units 0–100; no /100, no scaling)', async () => {
    const snap = await build([makeSession()], null, { history: makeHistory() });
    assert.equal(snap.forecastHistory.fiveHour[0].pct, 47);
    assert.equal(snap.forecastHistory.sevenDay[0].pct, 12);
  });

  it('bounds by the time filter, NOT a hardcoded count cap (30 recent samples all survive)', async () => {
    const fiveHour = Array.from({ length: 30 }, (_, i) => ({
      // spread across the last ~58 min so all are within RECENT_SPAN_MS
      at: atIso(i * 60 * 1000),
      pct: i,
      resetsAt: RESETS,
    }));
    const snap = await build([makeSession()], null, { history: { fiveHour, sevenDay: [] } });
    assert.equal(snap.forecastHistory.fiveHour.length, 30, 'no count cap — all 30 in-window samples kept');
  });

  it('degrades to empty arrays when history is null, and per-window when a hero window is absent', async () => {
    const nullSnap = await build([makeSession()], null, { history: null });
    assert.deepEqual(nullSnap.forecastHistory, { fiveHour: [], sevenDay: [] });

    const partial = await build([makeSession()], null, {
      history: { fiveHour: [{ at: atIso(60000), pct: 9, resetsAt: RESETS }] },
    });
    assert.deepEqual(partial.forecastHistory.sevenDay, [], 'absent hero window -> []');
  });

  it('emits each sample with EXACTLY {at, pct, resetsAt} (no added/renamed fields)', async () => {
    const snap = await build([makeSession()], null, { history: makeHistory() });
    for (const sample of snap.forecastHistory.fiveHour) {
      assert.deepEqual(Object.keys(sample).sort(), ['at', 'pct', 'resetsAt']);
    }
  });
});

// C1.5: the `forecast` block re-publishes weekOverWeek + roiPace VERBATIM from
// the projection (never recomputed in snapshot.js — that is the no-drift guard).
// Both null when unpaired/no-data; the block is always present (never omitted).
describe('buildSnapshot — forecast block (weekOverWeek + roiPace passthrough)', () => {
  it('publishes weekOverWeek + roiPace verbatim (no recompute, no mutation)', async () => {
    const weekOverWeek = { deltaPts: -8, prevPctAtSamePoint: 20 };
    const roiPace = {
      trailingDays: 7,
      apiEquivalentSpendTrailing: 312.4,
      monthlyEquivalentValue: 1338.86,
      subscriptionCost: 200,
      paceMultiple: 5.7,
    };
    const snap = await build([makeSession()], null, { weekOverWeek, roiPace });
    assert.deepEqual(snap.forecast, { weekOverWeek, roiPace });
  });

  it('degrades to { weekOverWeek: null, roiPace: null } when unpaired/no-data (block present)', async () => {
    const snap = await build([makeSession()], null);
    assert.deepEqual(snap.forecast, { weekOverWeek: null, roiPace: null });
  });
});

// C1.5: payload-size tripwire. This is a SYNC-CHURN TIGHTNESS GOAL (smaller
// iCloud writes), NOT a correctness gate — bump the ceiling DELIBERATELY if the
// payload legitimately grows. The number is anchored to the REAL Mac payload
// (~12.4 KB today) + the documented forecast add (~1.3–3.3 KB) -> 18 KB ceiling
// with headroom. The fixture below builds a far smaller snapshot; the ceiling
// guards against a future change that balloons the real-world payload.
describe('buildSnapshot — payload size tripwire (sync-churn tightness, not correctness)', () => {
  it('serializes under the 18KB iCloud-write ceiling with both hero windows + non-null forecast', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      makeSession({ sessionId: `s${i}`, project: `proj${i}`, cost: i + 1 }),
    );
    const NOW_MS = NOW.getTime();
    const at = (ageMs) => new Date(NOW_MS - ageMs).toISOString();
    const resets = '2026-06-05T15:00:00Z';
    const history = {
      fiveHour: Array.from({ length: 12 }, (_, i) => ({ at: at(i * 5 * 60 * 1000), pct: i, resetsAt: resets })),
      sevenDay: Array.from({ length: 12 }, (_, i) => ({ at: at(i * 5 * 60 * 1000), pct: i, resetsAt: resets })),
    };
    const snap = await build(sessions, { ingestedAt: '2026-06-05T00:00:00Z', normalized: { tier: 'max' } }, {
      history,
      weekOverWeek: { deltaPts: -8, prevPctAtSamePoint: 20 },
      roiPace: {
        trailingDays: 7,
        apiEquivalentSpendTrailing: 312.4,
        monthlyEquivalentValue: 1338.86,
        subscriptionCost: 200,
        paceMultiple: 5.7,
      },
    });
    const bytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
    assert.ok(bytes < 18 * 1024, `snapshot ${bytes}B exceeds 18KB iCloud-write ceiling`);
  });
});
