import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERIODS,
  isValidPeriod,
  periodStart,
  withinPeriod,
  matchesProject,
  filterSessions,
} from '../lib/period.js';

const NOW = new Date('2026-05-06T12:00:00.000Z');

describe('isValidPeriod', () => {
  it('accepts canonical values', () => {
    for (const p of PERIODS) assert.ok(isValidPeriod(p), p);
  });
  it('rejects garbage', () => {
    assert.equal(isValidPeriod('quarter'), false);
    assert.equal(isValidPeriod(''), false);
    assert.equal(isValidPeriod(null), false);
  });
});

describe('periodStart', () => {
  it('today = now - 24h', () => {
    assert.equal(periodStart('today', NOW), '2026-05-05T12:00:00.000Z');
  });
  it('7d = now - 7d', () => {
    assert.equal(periodStart('7d', NOW), '2026-04-29T12:00:00.000Z');
  });
  it('30d = now - 30d', () => {
    assert.equal(periodStart('30d', NOW), '2026-04-06T12:00:00.000Z');
  });
  it('month = first day of current UTC month', () => {
    assert.equal(periodStart('month', NOW), '2026-05-01T00:00:00.000Z');
  });
  it('all = null', () => {
    assert.equal(periodStart('all', NOW), null);
  });
});

describe('withinPeriod', () => {
  const session = (startedAt, project) => ({ startedAt, project });

  it('includes sessions inside window', () => {
    assert.equal(withinPeriod(session('2026-05-06T10:00:00Z'), '7d', NOW), true);
  });
  it('excludes sessions before window', () => {
    assert.equal(withinPeriod(session('2026-04-01T10:00:00Z'), '7d', NOW), false);
  });
  it('all = always true', () => {
    assert.equal(withinPeriod(session('2025-01-01T00:00:00Z'), 'all', NOW), true);
  });
  it('returns false for sessions without timestamp', () => {
    assert.equal(withinPeriod({}, '7d', NOW), false);
  });
});

describe('matchesProject', () => {
  it('case-insensitive substring match', () => {
    assert.equal(matchesProject({ project: 'Notifyr' }, 'noti'), true);
    assert.equal(matchesProject({ project: 'cibxray' }, 'CIB'), true);
  });
  it('empty filter matches all', () => {
    assert.equal(matchesProject({ project: 'anything' }, ''), true);
  });
});

describe('filterSessions composition', () => {
  it('applies both filters', () => {
    const sessions = [
      { startedAt: '2026-05-06T10:00:00Z', project: 'notifyr' },
      { startedAt: '2026-05-06T10:00:00Z', project: 'other' },
      { startedAt: '2025-01-01T00:00:00Z', project: 'notifyr' },
    ];
    const out = filterSessions(sessions, { period: '7d', project: 'notifyr', now: NOW });
    assert.equal(out.length, 1);
  });
});
