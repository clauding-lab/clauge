import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiReplacementValue, sumSessionCosts } from '../lib/roi-calculator.js';

describe('apiReplacementValue', () => {
  it('computes replacement vs subscription correctly', () => {
    const r = apiReplacementValue({
      apiEquivalentSpend: 547.40,
      subscriptionCost: 200,
      extraUsageSpend: 0,
    });
    assert.equal(r.totalSubscriptionOutlay, 200);
    assert.ok(Math.abs(r.apiReplacementValue - 347.40) < 1e-9);
    assert.ok(Math.abs(r.roiPct - (347.40 / 200) * 100) < 1e-9);
  });

  it('includes extra usage in subscription outlay', () => {
    const r = apiReplacementValue({
      apiEquivalentSpend: 100,
      subscriptionCost: 50,
      extraUsageSpend: 25,
    });
    assert.equal(r.totalSubscriptionOutlay, 75);
    assert.equal(r.apiReplacementValue, 25);
  });

  it('returns null roiPct when subscription outlay is zero', () => {
    const r = apiReplacementValue({ apiEquivalentSpend: 100, subscriptionCost: 0 });
    assert.equal(r.roiPct, null);
  });

  it('handles missing inputs as zero', () => {
    const r = apiReplacementValue({});
    assert.equal(r.totalSubscriptionOutlay, 0);
    assert.equal(r.apiReplacementValue, 0);
    assert.equal(r.roiPct, null);
  });
});

describe('sumSessionCosts', () => {
  it('sums cost across sessions', () => {
    assert.equal(sumSessionCosts([{ cost: 1.1 }, { cost: 2.2 }, { cost: 0.7 }]), 4);
  });
  it('treats missing cost as 0', () => {
    assert.equal(sumSessionCosts([{}, { cost: 5 }]), 5);
  });
  it('handles null/undefined gracefully', () => {
    assert.equal(sumSessionCosts(null), 0);
    assert.equal(sumSessionCosts(undefined), 0);
  });
});
