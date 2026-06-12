import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// public/swr.js ships as a classic browser IIFE (same convention as
// popover/lib/swr.js / popover/heatmap.js / popover/lib/copy.js): it only
// assigns window.ClaugeDashSwr, with no ESM `export` or CommonJS
// `module.exports` — a classic <script> would throw a SyntaxError on either,
// and this repo is `"type": "module"`, so we cannot `require()` it. Instead
// evaluate the real shipped source in THIS realm with a local `window`, then
// read back the same object app.js consumes at runtime. runInThisContext (not
// runInNewContext) so returned objects share this realm's prototypes.
function loadDashSwr() {
  const path = join(import.meta.dirname, '..', 'public', 'swr.js');
  const src = readFileSync(path, 'utf8');
  const factory = vm.runInThisContext(
    `(function (window) {\n${src}\nreturn window.ClaugeDashSwr;\n})`,
    { filename: path },
  );
  return factory({});
}

const { syncMeta, shouldSkipTick, alertPrefsView } = loadDashSwr();

describe('syncMeta — dashboard SWR sync-line + dot state', () => {
  const T0 = Date.parse('2026-06-12T10:00:00Z');

  it('is live and "synced just now" right after a successful refresh', () => {
    const m = syncMeta({ lastSuccessAt: T0, lastRefreshFailed: false, nowMs: T0 });
    assert.equal(m.live, true);
    assert.equal(m.text, 'synced 0s ago · auto-refresh 60s');
  });

  it('keeps AGING the timestamp on a successful tick (5m later)', () => {
    const m = syncMeta({ lastSuccessAt: T0, lastRefreshFailed: false, nowMs: T0 + 5 * 60_000 });
    assert.equal(m.live, true);
    assert.equal(m.text, 'synced 5m ago · auto-refresh 60s');
  });

  it('greys the dot (not live) but KEEPS AGING when the last refresh failed', () => {
    const m = syncMeta({ lastSuccessAt: T0, lastRefreshFailed: true, nowMs: T0 + 6 * 60_000 });
    assert.equal(m.live, false);
    assert.equal(m.text, 'synced 6m ago · auto-refresh 60s');
  });

  it('the failure timestamp advances tick over tick (6m → 7m), never frozen', () => {
    const a = syncMeta({ lastSuccessAt: T0, lastRefreshFailed: true, nowMs: T0 + 6 * 60_000 });
    const b = syncMeta({ lastSuccessAt: T0, lastRefreshFailed: true, nowMs: T0 + 7 * 60_000 });
    assert.equal(a.text, 'synced 6m ago · auto-refresh 60s');
    assert.equal(b.text, 'synced 7m ago · auto-refresh 60s');
  });

  it('reports not-synced + not-live when there has never been a successful refresh', () => {
    const m = syncMeta({ lastSuccessAt: null, lastRefreshFailed: true, nowMs: T0 });
    assert.equal(m.live, false);
    assert.equal(m.text, 'not synced');
  });
});

describe('shouldSkipTick — refresh overlap guard', () => {
  it('runs the tick when no refresh is in flight', () => {
    assert.equal(shouldSkipTick(false), false);
  });
  it('skips the tick when a refresh is already in flight', () => {
    assert.equal(shouldSkipTick(true), true);
  });
});

describe('alertPrefsView — /api/config alerts -> checkbox state', () => {
  it('maps a full all-on alerts block to checked flags', () => {
    const v = alertPrefsView({
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
    assert.deepEqual(v, {
      enabled: true,
      approaching: true,
      willHit: true,
      limitReached: true,
      disabled: false,
    });
  });

  it('marks per-type checkboxes disabled when the master toggle is off', () => {
    const v = alertPrefsView({
      alertsEnabled: false,
      types: { approaching: true, willHit: false, limitReached: true },
    });
    assert.equal(v.enabled, false);
    assert.equal(v.disabled, true, 'per-type checkboxes greyed when master off');
    // the underlying per-type values are still reflected (so flipping master
    // back on restores them visually)
    assert.equal(v.approaching, true);
    assert.equal(v.willHit, false);
  });

  it('defaults to all-on + enabled when given null/garbage', () => {
    for (const bad of [null, undefined, 42, 'x', {}]) {
      const v = alertPrefsView(bad);
      assert.deepEqual(v, {
        enabled: true,
        approaching: true,
        willHit: true,
        limitReached: true,
        disabled: false,
      });
    }
  });

  it('coerces non-boolean type flags to true (mirrors the server default)', () => {
    const v = alertPrefsView({ alertsEnabled: true, types: { willHit: false } });
    assert.equal(v.approaching, true, 'missing type -> default on');
    assert.equal(v.willHit, false, 'explicit false honored');
    assert.equal(v.limitReached, true, 'missing type -> default on');
  });
});
