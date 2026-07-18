// Tests for lib/api-v1.js — the /v1 public contract's pure pieces.
// Named after contract rules (spec: docs/superpowers/specs/
// 2026-07-16-v1-usage-local-api-design.md §3/§5/§6), not functions.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildV1Usage, isLoopbackHost, V1_API_VERSION } from '../lib/api-v1.js';

const NOW = Date.parse('2026-07-18T12:00:00Z');
const FRESH_AT = new Date(NOW - 60_000).toISOString(); // 1 min old
const STALE_AT = new Date(NOW - 3 * 3600_000).toISOString(); // 3 h old

function record({ ingestedAt = FRESH_AT, normalized = {} } = {}) {
  return {
    ingestedAt,
    org: { uuid: 'u-1', name: 'Org' },
    normalized: {
      fiveHour: { pct: 20, resetsAt: '2026-07-18T14:00:00Z' },
      sevenDay: { pct: 9, resetsAt: '2026-07-23T12:00:00Z' },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      ...normalized,
    },
  };
}

const ROI = {
  apiEquivalentSpend: 664.2,
  subscriptionCost: 200,
  extraUsageSpend: 0,
  totalSubscriptionOutlay: 200,
  apiReplacementValue: 464.2,
  roiPct: 232.1,
};

describe('buildV1Usage — envelope contract', () => {
  test('never-ingested (null record) returns the empty array, not a snapshot', () => {
    assert.deepEqual(buildV1Usage({ record: null, roi: ROI, nowMs: NOW }), []);
  });

  test('envelope: apiVersion, providerId claude, displayName, fetchedAt = ingestedAt', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    assert.equal(snap.apiVersion, V1_API_VERSION);
    assert.equal(snap.providerId, 'claude');
    assert.equal(snap.displayName, 'Claude');
    assert.equal(snap.fetchedAt, FRESH_AT);
    assert.equal(snap.plan, null);
  });

  test('error key is OMITTED entirely when there is no error (None-dropping)', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    assert.ok(!('error' in snap));
  });
});

describe('buildV1Usage — line vocabulary', () => {
  test('Session and Weekly are progress lines: used=pct, limit=100, percent format, resets_at', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    const session = snap.lines.find((l) => l.label === 'Session');
    assert.deepEqual(session, {
      type: 'progress',
      label: 'Session',
      used: 20,
      limit: 100,
      format: { kind: 'percent' },
      resets_at: '2026-07-18T14:00:00Z',
    });
    const weekly = snap.lines.find((l) => l.label === 'Weekly');
    assert.equal(weekly.type, 'progress');
    assert.equal(weekly.used, 9);
    assert.equal(weekly.resets_at, '2026-07-23T12:00:00Z');
  });

  test('a window with no data produces NO line (Opus/Sonnet omitted when null)', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    assert.ok(!snap.lines.some((l) => l.label === 'Weekly (Opus)'));
    assert.ok(!snap.lines.some((l) => l.label === 'Weekly (Sonnet)'));
  });

  test('model-scoped weekly windows appear as their own progress lines when present', () => {
    const [snap] = buildV1Usage({
      record: record({
        normalized: { sevenDayOpus: { pct: 41, resetsAt: '2026-07-23T12:00:00Z' } },
      }),
      roi: ROI,
      nowMs: NOW,
    });
    const opus = snap.lines.find((l) => l.label === 'Weekly (Opus)');
    assert.equal(opus.type, 'progress');
    assert.equal(opus.used, 41);
  });

  test('resets_at is omitted (not null) when the window has no reset time', () => {
    const [snap] = buildV1Usage({
      record: record({ normalized: { fiveHour: { pct: 20, resetsAt: null } } }),
      roi: ROI,
      nowMs: NOW,
    });
    const session = snap.lines.find((l) => l.label === 'Session');
    assert.ok(!('resets_at' in session));
  });

  test('Spend and ROI are text lines; ROI multiple = roiPct/100 (house convention)', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    const spend = snap.lines.find((l) => l.label === 'Spend');
    assert.equal(spend.type, 'text');
    assert.equal(spend.value, '$664 this window');
    const roi = snap.lines.find((l) => l.label === 'ROI');
    assert.equal(roi.type, 'text');
    assert.equal(roi.value, '2.3x vs API');
  });

  test('Spend and ROI lines are omitted when roi input is null', () => {
    const [snap] = buildV1Usage({ record: record(), roi: null, nowMs: NOW });
    assert.ok(!snap.lines.some((l) => l.label === 'Spend'));
    assert.ok(!snap.lines.some((l) => l.label === 'ROI'));
  });
});

// ROI (30d) — additive line (PR-C, owner decision 2026-07-18): realized
// last-30-days net multiple, month of value vs the monthly plan cost.
// Additive per the frozen-contract rules (AGENTS.md landmine #47): the
// existing 7d 'ROI' line is untouched; consumers that want the monthly
// framing select on the new label.
const ROI_30D = {
  apiEquivalentSpend: 3957.0,
  subscriptionCost: 200,
  extraUsageSpend: 0,
  totalSubscriptionOutlay: 200,
  apiReplacementValue: 3757.0,
  roiPct: 1878.5,
};

describe('buildV1Usage — ROI (30d) additive line', () => {
  test('roi30d input adds a text line labeled ROI (30d), same x-vs-API convention', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, roi30d: ROI_30D, nowMs: NOW });
    const monthly = snap.lines.find((l) => l.label === 'ROI (30d)');
    assert.equal(monthly.type, 'text');
    assert.equal(monthly.value, '18.8x vs API');
  });

  test('the frozen 7d ROI line is unchanged when roi30d is also supplied', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, roi30d: ROI_30D, nowMs: NOW });
    const weekly = snap.lines.find((l) => l.label === 'ROI');
    assert.equal(weekly.value, '2.3x vs API');
  });

  test('omitting roi30d (legacy caller) produces no ROI (30d) line', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    assert.ok(!snap.lines.some((l) => l.label === 'ROI (30d)'));
  });

  test('roi30d with null roiPct is omitted (None-dropping)', () => {
    const [snap] = buildV1Usage({
      record: record(),
      roi: ROI,
      roi30d: { ...ROI_30D, roiPct: null },
      nowMs: NOW,
    });
    assert.ok(!snap.lines.some((l) => l.label === 'ROI (30d)'));
  });

  test('ROI (30d) emits even when the 7d roi input is null (independent blocks)', () => {
    const [snap] = buildV1Usage({ record: record(), roi: null, roi30d: ROI_30D, nowMs: NOW });
    assert.ok(!snap.lines.some((l) => l.label === 'ROI'));
    const monthly = snap.lines.find((l) => l.label === 'ROI (30d)');
    assert.equal(monthly.value, '18.8x vs API');
  });
});

describe('buildV1Usage — stale-but-shown', () => {
  test('fresh data carries no staleness note', () => {
    const [snap] = buildV1Usage({ record: record(), roi: ROI, nowMs: NOW });
    assert.ok(!snap.lines.some((l) => l.label === 'Note'));
  });

  test('stale data is STILL served, with a text note stating the age', () => {
    const [snap] = buildV1Usage({
      record: record({ ingestedAt: STALE_AT }),
      roi: ROI,
      nowMs: NOW,
    });
    assert.ok(snap.lines.some((l) => l.label === 'Session'), 'quota lines still served');
    const note = snap.lines.find((l) => l.label === 'Note');
    assert.equal(note.type, 'text');
    assert.match(note.value, /3h old/);
  });
});

describe('isLoopbackHost — the mandatory /v1 Host check (anti DNS-rebinding)', () => {
  test('accepts loopback hosts with and without port', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:3456', 'localhost', 'localhost:3460']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });

  test('accepts case variants and root-anchored FQDN forms (both are valid HTTP)', () => {
    for (const h of ['LOCALHOST', 'LocalHost:3456', 'localhost.', 'localhost.:3456', '127.0.0.1.']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
  });

  test('rejects everything else, including rebinding lookalikes', () => {
    for (const h of [
      'evil.com',
      'evil.com:3456',
      '127.0.0.1.evil.com',
      'localhost.evil.com',
      'sub.localhost',
      '[::1]:3456', // server never binds ::1 — a v6 Host is not ours
      '',
      undefined,
      null,
    ]) {
      assert.equal(isLoopbackHost(h), false, String(h));
    }
  });
});
