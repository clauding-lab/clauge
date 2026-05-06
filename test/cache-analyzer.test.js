import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheHitRate,
  netCacheSavings,
  aggregateUsage,
} from '../lib/cache-analyzer.js';

describe('cacheHitRate — denominator includes cache_creation (PRD §2.4)', () => {
  it('matches the corrected formula', () => {
    const usage = {
      cacheRead: 90,
      cacheCreate5m: 5,
      cacheCreate1h: 5,
      inputTokens: 0,
    };
    // 90 / (90 + 5 + 5 + 0) = 0.9
    assert.equal(cacheHitRate(usage), 0.9);
  });

  it('returns null when no input-side activity', () => {
    assert.equal(
      cacheHitRate({ cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 0, inputTokens: 0 }),
      null
    );
    assert.equal(cacheHitRate(null), null);
  });

  it('would NOT inflate by ignoring cache_creation (regression vs old formula)', () => {
    const usage = {
      cacheRead: 90,
      cacheCreate5m: 100,
      cacheCreate1h: 0,
      inputTokens: 10,
    };
    const correct = 90 / (90 + 100 + 0 + 10); // 0.45
    const oldWrong = 90 / (90 + 10); // 0.9
    assert.equal(cacheHitRate(usage), correct);
    assert.notEqual(cacheHitRate(usage), oldWrong);
  });
});

describe('netCacheSavings — accounts for write overhead (PRD §2.4)', () => {
  const opusRates = {
    input_cost_per_token: 0.000005,         // 5 / 1M
    cache_read_input_token_cost: 5e-7,      // 0.5 / 1M
    cache_creation_input_token_cost: 0.00000625,  // 6.25 / 1M (5m write)
    cache_creation_input_token_cost_above_1hr: 0.00001, // 10 / 1M (1h write)
  };

  it('rewards reads, penalises writes that cost more than uncached input', () => {
    const usage = {
      cacheRead: 1_000_000,    // saves (5 - 0.5) / 1M × 1M = $4.50
      cacheCreate5m: 1_000_000, // overhead (6.25 - 5) / 1M × 1M = -$1.25
      cacheCreate1h: 1_000_000, // overhead (10 - 5) / 1M × 1M = -$5.00
    };
    const got = netCacheSavings(usage, opusRates);
    const expected = 4.5 - 1.25 - 5;
    assert.ok(Math.abs(got - expected) < 1e-9, `got ${got}, expected ${expected}`);
  });

  it('write-heavy session can produce NEGATIVE savings (correct, not a bug)', () => {
    const usage = {
      cacheRead: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 1_000_000,
    };
    const got = netCacheSavings(usage, opusRates);
    assert.ok(got < 0, `expected negative, got ${got}`);
  });

  it('returns 0 for null inputs', () => {
    assert.equal(netCacheSavings(null, opusRates), 0);
    assert.equal(netCacheSavings({ cacheRead: 100 }, null), 0);
  });

  it('falls back to default cache_create rate when 1h rate absent', () => {
    const sonnetNo1h = {
      input_cost_per_token: 0.000003,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 0.00000375,
    };
    const usage = { cacheRead: 0, cacheCreate5m: 0, cacheCreate1h: 1000 };
    const got = netCacheSavings(usage, sonnetNo1h);
    // 1h treated as 5m rate: -(0.00000375 - 0.000003) × 1000 = -0.00075
    const expected = -((0.00000375 - 0.000003) * 1000);
    assert.ok(Math.abs(got - expected) < 1e-12);
  });
});

describe('aggregateUsage', () => {
  it('sums tokens across turns', () => {
    const turns = [
      { usage: { inputTokens: 10, outputTokens: 20, cacheRead: 100, cacheCreate5m: 5, cacheCreate1h: 1, webSearches: 1, webFetches: 0 } },
      { usage: { inputTokens: 5, outputTokens: 5, cacheRead: 50, cacheCreate5m: 0, cacheCreate1h: 2, webSearches: 0, webFetches: 1 } },
    ];
    const out = aggregateUsage(turns);
    assert.equal(out.inputTokens, 15);
    assert.equal(out.outputTokens, 25);
    assert.equal(out.cacheRead, 150);
    assert.equal(out.cacheCreate5m, 5);
    assert.equal(out.cacheCreate1h, 3);
    assert.equal(out.webSearches, 1);
    assert.equal(out.webFetches, 1);
  });

  it('handles missing usage gracefully', () => {
    const out = aggregateUsage([{ usage: null }, {}]);
    assert.equal(out.inputTokens, 0);
  });
});
