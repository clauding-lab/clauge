import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore, normalizeUsage } from '../lib/usage-store.js';

const TMP = join(tmpdir(), 'clauge-usage-store-test-' + Date.now());

describe('UsageStore', () => {
  before(async () => { await mkdir(TMP, { recursive: true }); });
  after(async () => { await rm(TMP, { recursive: true, force: true }); });

  it('returns null when no snapshot exists', async () => {
    const s = new UsageStore({ path: join(TMP, 'a.json') });
    assert.equal(await s.load(), null);
  });

  it('persists and retrieves a snapshot', async () => {
    const s = new UsageStore({ path: join(TMP, 'b.json') });
    const saved = await s.save({
      org: { uuid: 'u1', name: 'Org' },
      raw: { five_hour: { utilization: 50, resets_at: '2026-05-06T10:00:00Z' } },
      normalized: { fiveHour: { pct: 50, resetsAt: '2026-05-06T10:00:00Z' } },
    });
    assert.ok(saved.ingestedAt);
    const fresh = new UsageStore({ path: join(TMP, 'b.json') });
    const loaded = await fresh.load();
    assert.equal(loaded.org.uuid, 'u1');
    assert.equal(loaded.normalized.fiveHour.pct, 50);
  });
});

describe('normalizeUsage', () => {
  it('returns null for null/garbage input', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage('string'), null);
  });

  it('extracts five_hour, seven_day, seven_day_sonnet metrics', () => {
    const out = normalizeUsage({
      five_hour: { utilization: 78, resets_at: '2026-05-06T10:00:00Z' },
      seven_day: { utilization: 32, resets_at: '2026-05-13T01:00:00Z' },
      seven_day_sonnet: { utilization: 5, resets_at: null },
    });
    assert.equal(out.fiveHour.pct, 78);
    assert.equal(out.sevenDay.pct, 32);
    assert.equal(out.sevenDaySonnet.pct, 5);
    assert.equal(out.sevenDayOpus, null);
  });

  it('converts extra_usage cents to dollars', () => {
    const out = normalizeUsage({
      five_hour: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 1826,
        utilization: 91.3,
        currency: 'USD',
      },
    });
    assert.equal(out.extraUsage.enabled, true);
    assert.equal(out.extraUsage.limitDollars, 20);
    assert.equal(out.extraUsage.usedDollars, 18.26);
    assert.equal(out.extraUsage.pct, 91.3);
  });

  it('handles missing extra_usage gracefully', () => {
    const out = normalizeUsage({ five_hour: { utilization: 10, resets_at: null } });
    assert.equal(out.extraUsage, null);
  });

  it('propagates disabled_reason when extra_usage is disabled', () => {
    const out = normalizeUsage({
      five_hour: null,
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
        disabled_reason: 'org_level_disabled_until',
      },
    });
    assert.equal(out.extraUsage.enabled, false);
    assert.equal(out.extraUsage.disabledReason, 'org_level_disabled_until');
  });

  it('omits disabledReason when extra_usage is enabled', () => {
    const out = normalizeUsage({
      five_hour: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 1826,
        utilization: 91.3,
        currency: 'USD',
      },
    });
    assert.equal(out.extraUsage.enabled, true);
    assert.equal(out.extraUsage.disabledReason, null);
  });

  it('treats missing disabled_reason as null when extra_usage is disabled', () => {
    const out = normalizeUsage({
      five_hour: null,
      extra_usage: {
        is_enabled: false,
      },
    });
    assert.equal(out.extraUsage.enabled, false);
    assert.equal(out.extraUsage.disabledReason, null);
  });
});
