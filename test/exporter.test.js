import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, toJson, sessionToRow, EXPORT_COLUMNS } from '../lib/exporter.js';

const sample = {
  sessionId: 'sess-1',
  project: 'notifyr',
  startedAt: '2026-05-06T10:00:00Z',
  endedAt: '2026-05-06T10:30:00Z',
  durationMs: 30 * 60 * 1000,
  turnCount: 12,
  tokens: {
    inputTokens: 100,
    outputTokens: 1000,
    cacheRead: 50000,
    cacheCreate5m: 0,
    cacheCreate1h: 800,
  },
  cost: 0.123456,
  cacheHitRate: 0.985,
  netCacheSavings: 1.5,
  tasks: { primary: 'Coding' },
  gitBranch: 'main',
  cwd: '/Users/x/Projects/notifyr',
};

describe('sessionToRow', () => {
  it('flattens nested fields and rounds cost / pct', () => {
    const row = sessionToRow(sample);
    assert.equal(row.sessionId, 'sess-1');
    assert.equal(row.project, 'notifyr');
    assert.equal(row.durationMin, 30);
    assert.equal(row.totalTokens, 51900);
    assert.equal(row.cacheHitRatePct, 98.5);
    assert.equal(row.primaryTask, 'Coding');
    assert.equal(row.costUSD, 0.123456);
  });
});

describe('toCsv', () => {
  it('emits header + row', () => {
    const out = toCsv([sample]);
    const lines = out.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(lines[0], EXPORT_COLUMNS.join(','));
    assert.ok(lines[1].includes('sess-1'));
  });

  it('escapes commas / quotes / newlines', () => {
    const tricky = {
      ...sample,
      project: 'my, "fun" project',
      cwd: '/tmp/with\nnewline',
    };
    const out = toCsv([tricky]);
    assert.ok(out.includes('"my, ""fun"" project"'));
    assert.ok(out.includes('"/tmp/with\nnewline"'));
  });

  it('emits header-only for empty input', () => {
    const out = toCsv([]);
    assert.equal(out.trim(), EXPORT_COLUMNS.join(','));
  });
});

describe('toJson', () => {
  it('returns parseable JSON envelope', () => {
    const out = toJson([sample]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.sessionCount, 1);
    assert.ok(parsed.generatedAt);
    assert.equal(parsed.sessions[0].project, 'notifyr');
  });
});
