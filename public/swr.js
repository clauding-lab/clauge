// public/swr.js
//
// Pure SWR (stale-while-revalidate) decision helper for the dashboard plan
// card. Given when the last refresh SUCCEEDED, whether the last refresh
// FAILED, and now, decide:
//   - the "synced … ago" line (recomputed every tick so it keeps AGING even
//     across failed refreshes — it must not freeze at the last success time)
//   - the .dot-live state: live (pulsing green) only while refreshes succeed,
//     not-live (grey, animation:none) once a refresh fails so it stops lying.
//
// Loaded as a classic browser script BEFORE app.js (see public/index.html) so
// window.ClaugeDashSwr is defined when refreshAll() runs. Same browser-IIFE
// shape as popover/lib/swr.js / popover/heatmap.js / popover/lib/copy.js:
// window-only, NO ESM `export` and NO CommonJS `module.exports` (a classic
// <script> throws a SyntaxError on either, and this repo is `"type": "module"`).
// node:test loads it by evaluating the file in a vm with a fake `window` — see
// test/dashboard-swr.test.js.

(function () {
  'use strict';

  // Internal: relative "Ns/Nm/Nh/Nd ago" — mirrors app.js fmtAgo's buckets so
  // the wired call and this pure helper agree.
  function ago(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function syncMeta({ lastSuccessAt, lastRefreshFailed, nowMs }) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!Number.isFinite(lastSuccessAt)) {
      return { live: false, text: 'not synced' };
    }
    const live = !lastRefreshFailed;
    const text = `synced ${ago(Math.max(0, now - lastSuccessAt))} · auto-refresh 60s`;
    return { live, text };
  }

  // Refresh overlap guard: skip this interval tick if a prior refresh is still
  // in flight, so a slow refresh can't stack on the next tick.
  function shouldSkipTick(inFlight) {
    return inFlight === true;
  }

  if (typeof window !== 'undefined') {
    window.ClaugeDashSwr = { syncMeta, shouldSkipTick };
  }
})();
