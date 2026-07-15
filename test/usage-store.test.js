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

  // claudeDesign + dailyRoutines: multi-key resolver covering Anthropic's
  // codename → public-name renames (omelette → Claude Design, cowork →
  // Daily Routines). Mirrors src-tauri/src/anthropic_oauth.rs resolver tests.

  it('claudeDesign prefers public name over codename', () => {
    const out = normalizeUsage({
      seven_day_design: { utilization: 42, resets_at: null },
      seven_day_omelette: { utilization: 99, resets_at: null },
    });
    assert.equal(out.claudeDesign.pct, 42, 'public name should win');
  });

  it('claudeDesign falls back to codename when public name absent', () => {
    const out = normalizeUsage({
      seven_day_omelette: { utilization: 12.5, resets_at: null },
    });
    assert.equal(out.claudeDesign.pct, 12.5);
  });

  it('claudeDesign returns null when no candidate is present', () => {
    const out = normalizeUsage({ five_hour: null });
    assert.equal(out.claudeDesign, null);
  });

  it('dailyRoutines prefers public name over codename', () => {
    const out = normalizeUsage({
      seven_day_routines: { utilization: 33, resets_at: null },
      seven_day_cowork: { utilization: 77, resets_at: null },
    });
    assert.equal(out.dailyRoutines.pct, 33, 'public name should win');
  });

  it('dailyRoutines falls back to codename when public name absent', () => {
    const out = normalizeUsage({
      seven_day_cowork: { utilization: 5, resets_at: null },
    });
    assert.equal(out.dailyRoutines.pct, 5);
  });

  it('dailyRoutines returns null when no candidate is present', () => {
    const out = normalizeUsage({ five_hour: null });
    assert.equal(out.dailyRoutines, null);
  });

  it('unknownSevenDayKeys catches schema drift', () => {
    const out = normalizeUsage({
      five_hour: null,
      seven_day_aubergine: { utilization: 8, resets_at: null },
      seven_day_quokka: { utilization: 1, resets_at: null },
    });
    const sorted = [...out.unknownSevenDayKeys].sort();
    assert.deepEqual(sorted, ['seven_day_aubergine', 'seven_day_quokka']);
  });

  it('unknownSevenDayKeys is empty when only known keys are present', () => {
    const out = normalizeUsage({
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_omelette: null,
      seven_day_cowork: null,
    });
    assert.deepEqual(out.unknownSevenDayKeys, []);
  });

  // Ingest validation gateway (finding #03): garbage utilization must not
  // reach the tray/history/snapshot. metric() sanitizes pct via sanitizePct
  // and resetsAt via sanitizeResetsAt.

  it('sanitizes out-of-range and non-numeric utilization to null through normalizeUsage', () => {
    const out = normalizeUsage({
      five_hour: { utilization: 99999, resets_at: '2026-05-06T10:00:00Z' },
      seven_day: { utilization: 'lots', resets_at: 'garbage' },
      seven_day_sonnet: { utilization: -5, resets_at: null },
    });
    assert.equal(out.fiveHour.pct, null, '99999 is unit-drift garbage → null');
    assert.equal(out.fiveHour.resetsAt, '2026-05-06T10:00:00Z', 'valid resets_at survives');
    assert.equal(out.sevenDay.pct, null, 'non-numeric string → null');
    assert.equal(out.sevenDay.resetsAt, null, 'unparseable resets_at → null');
    assert.equal(out.sevenDaySonnet.pct, null, 'negative pct → null');
  });

  it('clamps a plausible over-100 overshoot to 100 through normalizeUsage', () => {
    const out = normalizeUsage({ five_hour: { utilization: 150, resets_at: null } });
    assert.equal(out.fiveHour.pct, 100);
  });

  it('leaves normal in-range utilization untouched through normalizeUsage', () => {
    const out = normalizeUsage({ five_hour: { utilization: 55.5, resets_at: null } });
    assert.equal(out.fiveHour.pct, 55.5);
  });

  it('sanitizes garbage extra_usage.utilization to null', () => {
    const out = normalizeUsage({
      five_hour: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 1826,
        utilization: 99999,
        currency: 'USD',
      },
    });
    assert.equal(out.extraUsage.pct, null);
    assert.equal(out.extraUsage.limitDollars, 20, 'cents→dollars math is untouched');
  });
});

import { sanitizePct, sanitizeResetsAt } from '../lib/usage-store.js';

describe('sanitizePct', () => {
  it('rejects non-numeric, implausible, and NaN/Infinity values as null', () => {
    assert.equal(sanitizePct(99999), null);
    assert.equal(sanitizePct(-5), null);
    assert.equal(sanitizePct('lots'), null);
    assert.equal(sanitizePct({}), null);
    assert.equal(sanitizePct([]), null);
    assert.equal(sanitizePct(true), null);
    assert.equal(sanitizePct(NaN), null);
    assert.equal(sanitizePct(Infinity), null);
    assert.equal(sanitizePct(null), null);
    assert.equal(sanitizePct(undefined), null);
  });

  it('coerces numeric strings to numbers', () => {
    assert.equal(sanitizePct('87'), 87);
  });

  it('clamps a plausible overshoot (100, 200] down to 100', () => {
    assert.equal(sanitizePct(100.5), 100);
    assert.equal(sanitizePct(150), 100);
    assert.equal(sanitizePct(200), 100);
  });

  it('rejects values above the plausibility ceiling as null', () => {
    assert.equal(sanitizePct(200.1), null);
    assert.equal(sanitizePct(250), null);
  });

  it('passes normal in-range values through unchanged', () => {
    assert.equal(sanitizePct(0), 0);
    assert.equal(sanitizePct(100), 100);
    assert.equal(sanitizePct(55.5), 55.5);
  });
});

describe('sanitizeResetsAt', () => {
  it('rejects non-strings and unparseable strings as null', () => {
    assert.equal(sanitizeResetsAt({}), null);
    assert.equal(sanitizeResetsAt('garbage'), null);
    assert.equal(sanitizeResetsAt(123), null);
    assert.equal(sanitizeResetsAt(null), null);
    assert.equal(sanitizeResetsAt(undefined), null);
  });

  it('passes a valid ISO string through unchanged (string identity, not re-serialized)', () => {
    const iso = '2026-05-06T10:00:00+06:00';
    assert.equal(sanitizeResetsAt(iso), iso);
  });
});

import { unknownKeysWarning } from '../lib/usage-store.js';

describe('unknownKeysWarning', () => {
  it('fires the log once when unknownSevenDayKeys is non-empty', () => {
    const calls = [];
    const fired = unknownKeysWarning(
      { unknownSevenDayKeys: ['seven_day_aubergine', 'seven_day_quokka'] },
      (msg) => calls.push(msg)
    );
    assert.equal(fired, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[Clauge] schema-drift/);
    assert.match(calls[0], /seven_day_aubergine/);
    assert.match(calls[0], /seven_day_quokka/);
  });

  it('does NOT fire when unknownSevenDayKeys is empty', () => {
    const calls = [];
    const fired = unknownKeysWarning({ unknownSevenDayKeys: [] }, (msg) => calls.push(msg));
    assert.equal(fired, false);
    assert.equal(calls.length, 0);
  });

  it('does NOT fire when normalized is null (no usage ingested)', () => {
    const calls = [];
    const fired = unknownKeysWarning(null, (msg) => calls.push(msg));
    assert.equal(fired, false);
    assert.equal(calls.length, 0);
  });

  it('does NOT fire when the field is absent (older snapshot shape)', () => {
    const calls = [];
    const fired = unknownKeysWarning({ fiveHour: null }, (msg) => calls.push(msg));
    assert.equal(fired, false);
    assert.equal(calls.length, 0);
  });
});

import { unknownKeysNoticeText } from '../lib/usage-store.js';

describe('unknownKeysNoticeText', () => {
  it('returns null when there are no unknown keys', () => {
    assert.equal(unknownKeysNoticeText([]), null);
  });

  it('returns null for a null/absent field', () => {
    assert.equal(unknownKeysNoticeText(null), null);
    assert.equal(unknownKeysNoticeText(undefined), null);
  });

  it('uses the singular form for exactly one unknown key', () => {
    assert.equal(
      unknownKeysNoticeText(['seven_day_aubergine']),
      '1 unrecognized usage category — an update may track it'
    );
  });

  it('uses the plural form for two or more unknown keys', () => {
    assert.equal(
      unknownKeysNoticeText(['seven_day_aubergine', 'seven_day_quokka']),
      '2 unrecognized usage categories — an update may track it'
    );
  });
});
