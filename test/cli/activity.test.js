import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBuckets,
  countActiveDays,
  computeCurrentStreak,
  computeLongestStreak,
  summarizeActivity,
} from '../../lib/activity.js';

// ─── computeBuckets ─────────────────────────────────────────

test('computeBuckets returns [] for empty input', () => {
  assert.deepEqual(computeBuckets([]), []);
});

test('computeBuckets returns intensity=0 for all-zero days', () => {
  const days = [
    { date: '2026-05-23', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-24', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-25', sessions: 0, tokens: 0, cost: 0 },
  ];
  const out = computeBuckets(days);
  assert.equal(out.length, 3);
  for (const d of out) assert.equal(d.intensity, 0);
});

test('computeBuckets does not mutate input', () => {
  const days = [
    { date: '2026-05-24', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-25', sessions: 3, tokens: 1000, cost: 1 },
  ];
  const out = computeBuckets(days);
  assert.equal(days[0].intensity, undefined);
  assert.equal(days[1].intensity, undefined);
  assert.ok('intensity' in out[0]);
  assert.ok('intensity' in out[1]);
});

test('computeBuckets handles single non-zero day without crashing', () => {
  const days = [
    { date: '2026-05-23', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-24', sessions: 5, tokens: 5000, cost: 5 },
    { date: '2026-05-25', sessions: 0, tokens: 0, cost: 0 },
  ];
  const out = computeBuckets(days);
  assert.equal(out[0].intensity, 0);
  assert.ok(out[1].intensity >= 1 && out[1].intensity <= 4);
  assert.equal(out[2].intensity, 0);
});

test('computeBuckets distributes non-zero values across buckets 1-4', () => {
  const days = Array.from({ length: 8 }, (_, i) => ({
    date: `2026-05-${String(18 + i).padStart(2, '0')}`,
    sessions: i + 1,
    tokens: (i + 1) * 1000,
    cost: i + 1,
  }));
  const out = computeBuckets(days);
  const intensities = out.map((d) => d.intensity);
  for (const i of intensities) {
    assert.ok(i >= 1 && i <= 4, `intensity ${i} out of range`);
  }
  assert.ok(intensities[0] <= intensities[7], 'lowest value should be ≤ highest');
});

test('computeBuckets respects custom metric option (tokens)', () => {
  const days = [
    { date: '2026-05-24', sessions: 10, tokens: 100, cost: 0.1 },
    { date: '2026-05-25', sessions: 1, tokens: 10000, cost: 1 },
  ];
  const out = computeBuckets(days, { metric: 'tokens' });
  // by tokens, day 2 outranks day 1
  assert.ok(out[1].intensity > out[0].intensity);
});

// ─── countActiveDays ────────────────────────────────────────

test('countActiveDays returns 0 for empty input', () => {
  assert.equal(countActiveDays([]), 0);
});

test('countActiveDays counts days with sessions > 0', () => {
  const days = [
    { date: '2026-05-23', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-24', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-25', sessions: 3, tokens: 300, cost: 0.3 },
  ];
  assert.equal(countActiveDays(days), 2);
});

// ─── computeCurrentStreak ───────────────────────────────────

test('computeCurrentStreak: 0 when today has no activity', () => {
  const days = [
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 2, tokens: 200, cost: 0.2 },
    { date: '2026-05-25', sessions: 0, tokens: 0, cost: 0 },
  ];
  assert.equal(computeCurrentStreak(days, '2026-05-25'), 0);
});

test('computeCurrentStreak: walks backwards from active today', () => {
  const days = [
    { date: '2026-05-22', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 2, tokens: 200, cost: 0.2 },
    { date: '2026-05-25', sessions: 1, tokens: 100, cost: 0.1 },
  ];
  assert.equal(computeCurrentStreak(days, '2026-05-25'), 3);
});

test('computeCurrentStreak: streak ends at first gap', () => {
  const days = [
    { date: '2026-05-21', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-22', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-25', sessions: 1, tokens: 100, cost: 0.1 },
  ];
  assert.equal(computeCurrentStreak(days, '2026-05-25'), 3);
});

test('computeCurrentStreak: 0 when today is not in the days array', () => {
  const days = [
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 1, tokens: 100, cost: 0.1 },
  ];
  assert.equal(computeCurrentStreak(days, '2026-05-25'), 0);
});

// ─── computeLongestStreak ───────────────────────────────────

test('computeLongestStreak: 0 for empty input', () => {
  assert.equal(computeLongestStreak([]), 0);
});

test('computeLongestStreak: 0 for all-empty days', () => {
  const days = [
    { date: '2026-05-23', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-24', sessions: 0, tokens: 0, cost: 0 },
  ];
  assert.equal(computeLongestStreak(days), 0);
});

test('computeLongestStreak: simple unbroken run', () => {
  const days = [
    { date: '2026-05-21', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-22', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
  ];
  assert.equal(computeLongestStreak(days), 3);
});

test('computeLongestStreak: picks longest of multiple runs', () => {
  const days = [
    { date: '2026-05-19', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-20', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-21', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-22', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-25', sessions: 0, tokens: 0, cost: 0 },
  ];
  assert.equal(computeLongestStreak(days), 3);
});

// ─── summarizeActivity ──────────────────────────────────────

test('summarizeActivity returns { days, activeDays, currentStreak, longestStreak }', () => {
  const days = [
    { date: '2026-05-23', sessions: 1, tokens: 100, cost: 0.1 },
    { date: '2026-05-24', sessions: 0, tokens: 0, cost: 0 },
    { date: '2026-05-25', sessions: 2, tokens: 200, cost: 0.2 },
  ];
  const out = summarizeActivity(days, '2026-05-25');
  assert.equal(out.activeDays, 2);
  assert.equal(out.currentStreak, 1);
  assert.equal(out.longestStreak, 1);
  assert.equal(out.days.length, 3);
  assert.ok('intensity' in out.days[0]);
});
