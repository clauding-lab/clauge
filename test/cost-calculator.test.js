import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  costForTurn,
  envFallbackRates,
  resolveModelRates,
  loadPriceTable,
} from '../lib/cost-calculator.js';

const opusRates = {
  input_cost_per_token: 0.000005,
  output_cost_per_token: 0.000025,
  cache_read_input_token_cost: 5e-7,
  cache_creation_input_token_cost: 0.00000625,
  cache_creation_input_token_cost_above_1hr: 0.00001,
  search_context_cost_per_query: { search_context_size_medium: 0.01 },
};

const sonnetNo1hRates = {
  input_cost_per_token: 0.000003,
  output_cost_per_token: 0.000015,
  cache_read_input_token_cost: 3e-7,
  cache_creation_input_token_cost: 0.00000375,
  // no _above_1hr — must fall back to default cache_create rate
};

const usage = {
  inputTokens: 100,
  outputTokens: 1000,
  cacheRead: 50000,
  cacheCreate5m: 200,
  cacheCreate1h: 800,
  webSearches: 2,
  webFetches: 1,
};

describe('costForTurn — model-aware, two-tier cache', () => {
  it('charges 1h cache writes at the premium rate when set', () => {
    const result = costForTurn(usage, 'claude-opus-4-7', { 'claude-opus-4-7': opusRates }, envFallbackRates({}));
    // expected breakdown
    const expected = {
      input: 100 * 0.000005,
      output: 1000 * 0.000025,
      cacheRead: 50000 * 5e-7,
      cache5m: 200 * 0.00000625,
      cache1h: 800 * 0.00001,
      search: 3 * 0.01,
    };
    assert.equal(result.source, 'litellm');
    for (const k of Object.keys(expected)) {
      assert.ok(
        Math.abs(result.breakdown[k] - expected[k]) < 1e-9,
        `${k}: got ${result.breakdown[k]}, expected ${expected[k]}`
      );
    }
    const expTotal = Object.values(expected).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(result.total - expTotal) < 1e-9);
  });

  it('falls back to default cache rate for 1h when no above_1hr field', () => {
    const result = costForTurn(usage, 'claude-sonnet-4-6', { 'claude-sonnet-4-6': sonnetNo1hRates }, envFallbackRates({}));
    const expected1h = 800 * 0.00000375; // default cache_create rate
    assert.ok(Math.abs(result.breakdown.cache1h - expected1h) < 1e-9);
  });

  it('uses env fallback rates when model not in price table', () => {
    const env = envFallbackRates({
      RATE_INPUT: '3.00',
      RATE_OUTPUT: '15.00',
      RATE_CACHE_READ: '0.30',
      RATE_CACHE_CREATE: '3.75',
      RATE_CACHE_CREATE_1H: '6.00',
    });
    const result = costForTurn(usage, 'unknown-future-model', {}, env);
    assert.equal(result.source, 'env-fallback');
    // 100 input × $3/1M + 1000 output × $15/1M
    assert.ok(Math.abs(result.breakdown.input - 100 * 3 / 1e6) < 1e-12);
    assert.ok(Math.abs(result.breakdown.output - 1000 * 15 / 1e6) < 1e-12);
    assert.ok(Math.abs(result.breakdown.cache1h - 800 * 6 / 1e6) < 1e-12);
  });

  it('returns zero cost when usage is null', () => {
    const result = costForTurn(null, 'claude-opus-4-7', {}, envFallbackRates({}));
    assert.equal(result.total, 0);
    assert.equal(result.source, 'no-usage');
  });
});

describe('envFallbackRates — per-1M conversion', () => {
  it('divides .env per-1M rates by 1,000,000', () => {
    const r = envFallbackRates({ RATE_INPUT: '3.00' });
    assert.ok(Math.abs(r.input_cost_per_token - 3 / 1e6) < 1e-12);
  });

  it('1h fallback chains: own → 5m → 0', () => {
    const r1 = envFallbackRates({ RATE_CACHE_CREATE_1H: '6.00' });
    assert.ok(Math.abs(r1.cache_creation_input_token_cost_above_1hr - 6 / 1e6) < 1e-12);
    const r2 = envFallbackRates({ RATE_CACHE_CREATE: '3.75' });
    assert.ok(Math.abs(r2.cache_creation_input_token_cost_above_1hr - 3.75 / 1e6) < 1e-12);
    const r3 = envFallbackRates({});
    assert.equal(r3.cache_creation_input_token_cost_above_1hr, 0);
  });
});

describe('resolveModelRates', () => {
  it('returns LiteLLM rates when model present', () => {
    const rates = resolveModelRates('claude-opus-4-7', { 'claude-opus-4-7': opusRates }, envFallbackRates({}));
    assert.equal(rates.input_cost_per_token, opusRates.input_cost_per_token);
  });

  it('returns env fallback when model missing', () => {
    const env = envFallbackRates({ RATE_INPUT: '1.50' });
    const rates = resolveModelRates('does-not-exist', {}, env);
    assert.ok(Math.abs(rates.input_cost_per_token - 1.5 / 1e6) < 1e-12);
  });
});

describe('loadPriceTable — bundled fallback', () => {
  it('loads bundled fallback when the URL is unreachable', async () => {
    const result = await loadPriceTable({
      url: 'https://localhost:1/does-not-exist-clauge-test',
      cachePath: '/tmp/clauge-test-cache-does-not-exist.json',
    });
    assert.equal(result.source, 'fallback');
    assert.ok(result.prices['claude-opus-4-7']);
    assert.ok(result.prices['claude-sonnet-4-6']);
  });
});
