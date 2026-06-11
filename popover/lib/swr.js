// popover/lib/swr.js
//
// Pure SWR (stale-while-revalidate) decision helpers for the popover. Two
// concerns, both side-effect-free so node:test can exercise them directly:
//   - pickUsage:     which usage object to render this tick (fresh vs last-good)
//   - subheadState:  what the freshness subhead should say (honest after a fail)
//
// Loaded as a classic browser script BEFORE popover.js (see popover/index.html)
// so window.ClaugeSwr is defined when refresh() runs. Same browser-IIFE shape
// as popover/heatmap.js / popover/lib/copy.js: window-only, NO ESM `export` and
// NO CommonJS `module.exports` (a classic <script> throws a SyntaxError on
// either, and this repo is `"type": "module"`). node:test loads it by
// evaluating the file in a vm sandbox with a fake `window` — see
// test/popover-swr.test.js.

(function () {
  'use strict';

  // Decide which usage payload the popover renders this tick.
  //   fresh    — the just-fetched /api/usage object, or null if the fetch failed
  //   lastGood — the previously cached good usage object, or null if none yet
  // Returns { usage, fetchFailed, lastGood } — usage is what to render,
  // fetchFailed flags whether this tick's fetch failed (drives the stale cue),
  // lastGood is the cache to carry forward.
  function pickUsage(fresh, lastGood) {
    if (fresh != null) {
      return { usage: fresh, fetchFailed: false, lastGood: fresh };
    }
    return { usage: lastGood ?? null, fetchFailed: true, lastGood: lastGood ?? null };
  }

  // Decide the freshness subhead. Two orthogonal honest signals:
  //   - data age (ingestedAt) — how old the underlying usage data is
  //   - fetchFailed           — did THIS tick's fetch fail (the live/stale cue)
  // Never returns "just now" after a failed fetch: a failed fetch always maps
  // to the muted header.updatedStale treatment, carrying the real aged minutes
  // when the data is older than 60s.
  function subheadState({ ingestedAt, fetchFailed, nowMs }) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const ageMs = ingestedAt ? now - Date.parse(ingestedAt) : NaN;
    const minutes = Number.isFinite(ageMs) && ageMs >= 60000 ? Math.floor(ageMs / 60000) : null;
    if (fetchFailed) {
      return { key: 'header.updatedStale', params: minutes == null ? undefined : { minutes }, stale: true };
    }
    if (minutes == null) {
      return { key: 'header.updatedJustNow', params: undefined, stale: false };
    }
    return { key: 'header.updatedMinutes', params: { minutes }, stale: false };
  }

  // Frontend fetch timeout: an AbortController that fires after budgetMs. The
  // caller wires signal into fetch(...) and MUST call clear() in finally so a
  // fast fetch never trips the abort. Shared by popover fetchJson; the
  // dashboard duplicates the same ~4 lines inline (the facade boundary makes a
  // cross-surface shared helper not worth it — spec Item 6).
  function fetchTimeoutSignal(budgetMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), budgetMs);
    return { signal: ctrl.signal, clear: () => clearTimeout(id) };
  }

  if (typeof window !== 'undefined') {
    window.ClaugeSwr = { pickUsage, subheadState, fetchTimeoutSignal };
  }
})();
