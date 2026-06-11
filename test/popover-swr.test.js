import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// popover/lib/swr.js ships as a classic browser IIFE (same convention as
// popover/heatmap.js / popover/lib/copy.js): it only assigns window.ClaugeSwr,
// with no ESM `export` or CommonJS `module.exports` — a classic <script> would
// throw a SyntaxError on either. This repo is `"type": "module"`, so we cannot
// `require()` it. Instead evaluate the real shipped source in THIS realm with a
// local `window`, then read back the same object the popover consumes at
// runtime. runInThisContext (not runInNewContext) so the helpers' returned
// objects share this realm's prototypes — otherwise strict deepEqual rejects
// structurally-identical cross-realm objects.
function loadSwr() {
  const path = join(import.meta.dirname, '..', 'popover', 'lib', 'swr.js');
  const src = readFileSync(path, 'utf8');
  const factory = vm.runInThisContext(
    `(function (window) {\n${src}\nreturn window.ClaugeSwr;\n})`,
    { filename: path },
  );
  return factory({});
}

const { pickUsage, subheadState, fetchTimeoutSignal } = loadSwr();

describe('pickUsage — popover keep-last-good substitution', () => {
  it('returns the fresh usage and caches it when the fetch succeeded', () => {
    const fresh = { plan: { fiveHour: { pct: 42 } }, ingestedAt: '2026-06-12T10:00:00Z' };
    const r = pickUsage(fresh, null);
    assert.deepEqual(r.usage, fresh);
    assert.equal(r.fetchFailed, false);
    assert.deepEqual(r.lastGood, fresh);
  });

  it('falls back to last-good (no 0% wipe) when the fetch returned null', () => {
    const lastGood = { plan: { fiveHour: { pct: 42 } }, ingestedAt: '2026-06-12T10:00:00Z' };
    const r = pickUsage(null, lastGood);
    assert.deepEqual(r.usage, lastGood);
    assert.equal(r.fetchFailed, true);
    assert.deepEqual(r.lastGood, lastGood);
  });

  it('returns null usage only when both fresh and last-good are absent (cold first failure)', () => {
    const r = pickUsage(null, null);
    assert.equal(r.usage, null);
    assert.equal(r.fetchFailed, true);
    assert.equal(r.lastGood, null);
  });
});

describe('subheadState — honest freshness, never "just now" after a failed fetch', () => {
  const NOW = Date.parse('2026-06-12T10:05:00Z');

  it('shows fresh "just now" when the fetch succeeded and data is < 60s old', () => {
    const s = subheadState({ ingestedAt: '2026-06-12T10:04:30Z', fetchFailed: false, nowMs: NOW });
    assert.deepEqual(s, { key: 'header.updatedJustNow', params: undefined, stale: false });
  });

  it('shows minutes-ago when the fetch succeeded and data is older than 60s', () => {
    const s = subheadState({ ingestedAt: '2026-06-12T10:00:00Z', fetchFailed: false, nowMs: NOW });
    assert.deepEqual(s, { key: 'header.updatedMinutes', params: { minutes: 5 }, stale: false });
  });

  it('keeps the real data age but flags stale when the LAST fetch failed (never "just now")', () => {
    const s = subheadState({ ingestedAt: '2026-06-12T10:04:30Z', fetchFailed: true, nowMs: NOW });
    assert.equal(s.stale, true);
    assert.notEqual(s.key, 'header.updatedJustNow');
    assert.deepEqual(s, { key: 'header.updatedStale', params: undefined, stale: true });
  });

  it('flags stale and shows the aged minutes when the fetch failed on older data', () => {
    const s = subheadState({ ingestedAt: '2026-06-12T10:00:00Z', fetchFailed: true, nowMs: NOW });
    assert.deepEqual(s, { key: 'header.updatedStale', params: { minutes: 5 }, stale: true });
  });

  it('is stale with no data age when the fetch failed and there is no ingestedAt', () => {
    const s = subheadState({ ingestedAt: null, fetchFailed: true, nowMs: NOW });
    assert.deepEqual(s, { key: 'header.updatedStale', params: undefined, stale: true });
  });
});

describe('fetchTimeoutSignal — frontend abort budget', () => {
  it('returns a signal that is not aborted before the budget elapses', () => {
    const { signal, clear } = fetchTimeoutSignal(5000);
    assert.equal(signal.aborted, false);
    clear();
  });

  it('aborts the signal once the budget elapses', async () => {
    const { signal } = fetchTimeoutSignal(10);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(signal.aborted, true);
  });

  it('clear() cancels the pending abort so a fast fetch is never aborted', async () => {
    const { signal, clear } = fetchTimeoutSignal(10);
    clear();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(signal.aborted, false);
  });
});
