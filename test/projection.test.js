import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  WINDOW_MS,
  PROJECTION_STALE_AFTER_MS,
  RECENT_SPAN_MS,
  MIN_RECENT_SPAN_MS,
  WARMUP_FRACTION,
  SAME_WINDOW_TOLERANCE_MS,
  isStale,
  projectWindow,
  weekOverWeek,
  roiPace,
  buildProjection,
} from '../lib/projection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VECTORS_PATH = resolve(__dirname, 'fixtures/projection-vectors.json');

const FN_TABLE = { projectWindow, weekOverWeek, roiPace, isStale };

// nowMs used across the direct buildProjection tests = the vectors' clock.
const NOW_MS = 1781258400000; // 2026-06-12T10:00:00.000Z

describe('projection constants (pinned cross-platform contract)', () => {
  it('WINDOW_MS covers exactly the six resolved window keys', () => {
    assert.deepEqual(WINDOW_MS, {
      fiveHour: 18000000,
      sevenDay: 604800000,
      sevenDaySonnet: 604800000,
      sevenDayOpus: 604800000,
      claudeDesign: 604800000,
      dailyRoutines: 604800000,
    });
  });

  it('thresholds match the spec', () => {
    assert.equal(PROJECTION_STALE_AFTER_MS, 600000);
    assert.equal(RECENT_SPAN_MS, 3600000);
    assert.equal(MIN_RECENT_SPAN_MS, 900000);
    assert.equal(WARMUP_FRACTION, 0.05);
    assert.equal(SAME_WINDOW_TOLERANCE_MS, 300000);
  });
});

describe('projection-vectors.json (shared cross-platform fixtures)', async () => {
  const fixture = JSON.parse(await readFile(VECTORS_PATH, 'utf8'));

  it('vectorsVersion is 1 (iOS asserts the same pin)', () => {
    assert.equal(fixture.vectorsVersion, 1);
  });

  it('every case names a known function', () => {
    for (const c of fixture.cases) {
      assert.ok(FN_TABLE[c.fn], `unknown fn "${c.fn}" in case "${c.name}"`);
    }
  });

  for (const c of fixture.cases) {
    it(`[${c.fn}] ${c.name}`, () => {
      const actual = FN_TABLE[c.fn](c.input);
      assert.deepEqual(actual, c.expected);
    });
  }
});

describe('buildProjection — assembly', () => {
  const normalized = {
    fiveHour: { pct: 42, resetsAt: '2026-06-12T14:20:00+00:00' },
    sevenDay: { pct: 59, resetsAt: '2026-06-14T12:24:00+00:00' },
    sevenDaySonnet: { pct: 31, resetsAt: '2026-06-14T12:24:00+00:00' },
    sevenDayOpus: null,
    claudeDesign: null,
    dailyRoutines: null,
    // Fields the recorder/projection must IGNORE:
    sevenDayOmelette: { pct: 9, resetsAt: '2026-06-14T12:24:00+00:00' },
    sevenDayCowork: { pct: 7, resetsAt: '2026-06-14T12:24:00+00:00' },
    unknownSevenDayKeys: [],
    extraUsage: null,
  };

  it('emits all six window keys; null buckets pass through as null', () => {
    const out = buildProjection({
      normalized,
      ingestedAt: '2026-06-12T09:59:00.000Z',
      history: {},
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 1034.55,
      subscriptionCost: 200,
    });
    assert.deepEqual(Object.keys(out.windows), [
      'fiveHour',
      'sevenDay',
      'sevenDaySonnet',
      'sevenDayOpus',
      'claudeDesign',
      'dailyRoutines',
    ]);
    assert.equal(out.windows.sevenDayOpus, null);
    assert.equal(out.windows.claudeDesign, null);
    assert.equal(out.windows.dailyRoutines, null);
    assert.equal(out.freshness.ingested, true);
    assert.equal(out.freshness.stale, false);
    assert.equal(out.windows.fiveHour.state, 'will_hit');
    assert.equal(out.windows.fiveHour.basis, 'window_avg');
    assert.equal(out.windows.fiveHour.etaAt, '2026-06-12T10:55:14.000Z');
    assert.equal(out.windows.sevenDay.state, 'safe');
    assert.equal(out.windows.sevenDay.projectedEndPct, 84);
  });

  it('attaches weekOverWeek ONLY on the sevenDay window', () => {
    const out = buildProjection({
      normalized,
      ingestedAt: '2026-06-12T09:59:00.000Z',
      history: {
        sevenDay: [
          { at: '2026-06-05T08:00:00.000Z', pct: 42, resetsAt: '2026-06-07T12:24:00+00:00' },
          { at: '2026-06-05T12:00:00.000Z', pct: 46, resetsAt: '2026-06-07T12:24:00+00:00' },
        ],
      },
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 1034.55,
      subscriptionCost: 200,
    });
    assert.deepEqual(out.windows.sevenDay.weekOverWeek, {
      deltaPts: 15,
      prevPctAtSamePoint: 44,
    });
    assert.equal('weekOverWeek' in out.windows.fiveHour, false);
    assert.equal('weekOverWeek' in out.windows.sevenDaySonnet, false);
  });

  it('stale ingest suppresses every forecast but passes pct/resetsAt through', () => {
    const out = buildProjection({
      normalized,
      ingestedAt: '2026-06-12T09:30:00.000Z', // 30 min old > 10 min threshold
      history: {},
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 1034.55,
      subscriptionCost: 200,
    });
    assert.equal(out.freshness.stale, true);
    for (const key of ['fiveHour', 'sevenDay', 'sevenDaySonnet']) {
      assert.equal(out.windows[key].state, 'stale');
      assert.equal(out.windows[key].etaAt, null);
      assert.equal(out.windows[key].projectedEndPct, null);
      assert.equal(out.windows[key].basis, null);
      assert.equal(out.windows[key].recentRatePctPerHour, null);
    }
    assert.equal(out.windows.fiveHour.pct, 42);
    assert.equal(out.windows.fiveHour.resetsAt, '2026-06-12T14:20:00+00:00');
    assert.equal(out.windows.sevenDay.weekOverWeek, null);
  });

  it('roiPace is NOT staleness-gated (session logs, not extension data)', () => {
    const out = buildProjection({
      normalized,
      ingestedAt: null, // never ingested
      history: {},
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 1034.55,
      subscriptionCost: 200,
    });
    assert.equal(out.freshness.stale, true);
    assert.deepEqual(out.roiPace, {
      trailingDays: 7,
      apiEquivalentSpendTrailing: 1034.55,
      monthlyEquivalentValue: 4433.79,
      subscriptionCost: 200,
      paceMultiple: 21.2,
    });
  });

  it('never-ingested (normalized null) yields all-null windows + stale freshness', () => {
    const out = buildProjection({
      normalized: null,
      ingestedAt: null,
      history: null,
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 0,
      subscriptionCost: 200,
    });
    assert.deepEqual(out.freshness, {
      ingested: false,
      ingestedAt: null,
      stale: true,
    });
    for (const key of Object.keys(WINDOW_MS)) {
      assert.equal(out.windows[key], null);
    }
    assert.equal(out.roiPace, null);
  });
});
