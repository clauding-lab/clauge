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
});

// v1.3.6 scoped-limits: parse claude.ai's `limits[]` array into a generic
// `scopedWindows` list (labels are DATA from the wire, never schema) plus a
// hero fallback that synthesizes fiveHour/sevenDay from limits when the legacy
// flat keys are gone. Live-verified schema (Adnan's org, 2026-07-18).
describe('normalizeUsage — scopedWindows + hero fallback (limits[])', () => {
  const LIVE_LIMITS = [
    {
      kind: 'session', group: 'session', percent: 66, severity: 'normal',
      resets_at: '2026-07-18T18:09:59.667774+00:00', scope: null, is_active: true,
    },
    {
      kind: 'weekly_all', group: 'weekly', percent: 59, severity: 'normal',
      resets_at: '2026-07-22T23:00:00.667795+00:00', scope: null, is_active: false,
    },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 65, severity: 'normal',
      resets_at: '2026-07-22T22:59:59.668082+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false,
    },
  ];

  const scoped = (over = {}) => ({
    kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: 'r',
    scope: { model: { display_name: 'Model' } }, is_active: false, ...over,
  });

  it('parses the live 3-entry fixture into exactly one scoped window (Fable)', () => {
    const out = normalizeUsage({ limits: LIVE_LIMITS });
    assert.deepEqual(out.scopedWindows, [
      {
        label: 'Fable', pct: 65, resetsAt: '2026-07-22T22:59:59.668082+00:00',
        isActive: false, group: 'weekly', source: 'model',
      },
    ]);
  });

  it('scopedWindows is [] when limits is absent/null/non-array/object', () => {
    assert.deepEqual(normalizeUsage({ five_hour: null }).scopedWindows, []);
    assert.deepEqual(normalizeUsage({ limits: null }).scopedWindows, []);
    assert.deepEqual(normalizeUsage({ limits: 'junk' }).scopedWindows, []);
    assert.deepEqual(normalizeUsage({ limits: {} }).scopedWindows, []);
  });

  it('keeps multiple scoped entries in wire order', () => {
    const out = normalizeUsage({
      limits: [
        scoped({ percent: 65, resets_at: 'r1', scope: { model: { display_name: 'Fable' } } }),
        scoped({ percent: 40, resets_at: 'r2', is_active: true, scope: { model: { display_name: 'Opus' } } }),
      ],
    });
    assert.deepEqual(out.scopedWindows.map((w) => w.label), ['Fable', 'Opus']);
    assert.equal(out.scopedWindows[1].pct, 40);
    assert.equal(out.scopedWindows[1].isActive, true);
  });

  it('resolves surface-scoped entries with source=surface', () => {
    const out = normalizeUsage({
      limits: [
        scoped({ scope: { model: null, surface: { id: 'cowork', display_name: 'Cowork' } } }),
      ],
    });
    assert.equal(out.scopedWindows.length, 1);
    assert.equal(out.scopedWindows[0].label, 'Cowork');
    assert.equal(out.scopedWindows[0].source, 'surface');
  });

  it('drops entries with null scope, non-finite percent, or unusable labels', () => {
    const out = normalizeUsage({
      limits: [
        { kind: 'session', group: 'session', percent: 66, resets_at: 'r', scope: null, is_active: true },
        { kind: 'weekly_all', group: 'weekly', percent: 59, resets_at: 'r', scope: null, is_active: false },
        scoped({ percent: 'NaNish', scope: { model: { display_name: 'Fable' } } }),
        scoped({ percent: undefined, scope: { model: { display_name: 'Fable' } } }),
        scoped({ scope: { model: { display_name: '   ' } } }),
        scoped({ scope: { model: { display_name: 123 } } }),
      ],
    });
    assert.deepEqual(out.scopedWindows, []);
  });

  it('clamps pct to 0..100', () => {
    const out = normalizeUsage({
      limits: [
        scoped({ percent: 250, scope: { model: { display_name: 'Hi' } } }),
        scoped({ percent: -5, scope: { model: { display_name: 'Lo' } } }),
      ],
    });
    assert.equal(out.scopedWindows[0].pct, 100);
    assert.equal(out.scopedWindows[1].pct, 0);
  });

  it('trims whitespace and truncates labels to 40 chars', () => {
    const long = 'A'.repeat(60);
    const out = normalizeUsage({
      limits: [
        scoped({ scope: { model: { display_name: '  Fable  ' } } }),
        scoped({ scope: { model: { display_name: long } } }),
      ],
    });
    assert.equal(out.scopedWindows[0].label, 'Fable');
    assert.equal(out.scopedWindows[1].label, 'A'.repeat(40));
    assert.equal(out.scopedWindows[1].label.length, 40);
  });

  it('strips C0/C1 control characters from labels', () => {
    // Built via fromCharCode so the SOURCE file never holds literal control bytes.
    const dirty =
      'Fa' + String.fromCharCode(0x00, 0x1f) + 'b' + String.fromCharCode(0x7f, 0x9f) + 'le';
    const out = normalizeUsage({ limits: [scoped({ scope: { model: { display_name: dirty } } })] });
    assert.equal(out.scopedWindows[0].label, 'Fable');
  });

  it('caps scopedWindows at the first 8 qualifying entries (wire order)', () => {
    const limits = Array.from({ length: 10 }, (_, i) =>
      scoped({ percent: i, scope: { model: { display_name: `M${i}` } } }),
    );
    const out = normalizeUsage({ limits });
    assert.equal(out.scopedWindows.length, 8);
    assert.deepEqual(
      out.scopedWindows.map((w) => w.label),
      ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
    );
  });

  it('synthesizes hero fiveHour/sevenDay from limits when flat keys are absent', () => {
    const out = normalizeUsage({ limits: LIVE_LIMITS });
    assert.equal(out.fiveHour.pct, 66);
    assert.equal(out.fiveHour.resetsAt, '2026-07-18T18:09:59.667774+00:00');
    assert.equal(out.sevenDay.pct, 59);
    assert.equal(out.sevenDay.resetsAt, '2026-07-22T23:00:00.667795+00:00');
  });

  it('flat five_hour/seven_day win over limits synthesis when present', () => {
    const out = normalizeUsage({
      five_hour: { utilization: 78, resets_at: '2026-05-06T10:00:00Z' },
      seven_day: { utilization: 32, resets_at: '2026-05-13T01:00:00Z' },
      limits: LIVE_LIMITS,
    });
    assert.equal(out.fiveHour.pct, 78);
    assert.equal(out.sevenDay.pct, 32);
  });

  it('falls back to scope.model.id when display_name is null, and model wins over surface', () => {
    const out = normalizeUsage({
      limits: [
        scoped({
          percent: 12,
          scope: { model: { id: 'fable-id', display_name: null }, surface: { display_name: 'Cowork' } },
        }),
      ],
    });
    assert.equal(out.scopedWindows[0].label, 'fable-id');
    assert.equal(out.scopedWindows[0].source, 'model');
  });

  it('maps a missing resets_at to null', () => {
    const out = normalizeUsage({
      limits: [scoped({ resets_at: undefined, scope: { model: { display_name: 'Fable' } } })],
    });
    assert.equal(out.scopedWindows[0].resetsAt, null);
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
