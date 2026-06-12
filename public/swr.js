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

  // ── On-device projection display mapping (sub-project A) ────────────────
  // Pure: one /api/projection window → the plan-card forecast line text.
  // Times are formatted by the INJECTED fmtClock (app.js passes its
  // fmtResetClock) so this stays clock-free and vm-testable. Returns null =
  // line hidden (warming_up / stale / unavailable / missing window — a
  // forecast from thin or stale data is suppressed, never caveated). The
  // dashboard is deliberately outside the popover copy registry (the
  // validator scans popover/ only), so these strings live inline here.
  function projectionLine(win, fmtClock) {
    if (!win || typeof win !== 'object') return null;
    if (win.state === 'will_hit') {
      return `At this pace → 100% ~${fmtClock(win.etaAt)}`;
    }
    if (win.state === 'safe' && Number.isFinite(win.projectedEndPct)) {
      return `On pace to end at ~${win.projectedEndPct}%`;
    }
    if (win.state === 'exhausted') {
      return `Limit reached — resets ${fmtClock(win.resetsAt)}`;
    }
    return null; // warming_up | stale | unavailable
  }

  // "+15 pts vs last week" / "-3 pts vs last week". The server already gates
  // weekOverWeek to will_hit/safe states; absence (null) hides the line.
  function wowLine(weekOverWeek) {
    if (!weekOverWeek || !Number.isFinite(weekOverWeek.deltaPts)) return null;
    const d = weekOverWeek.deltaPts;
    return `${d > 0 ? `+${d}` : String(d)} pts vs last week`;
  }

  // "Monthly pace: 21.2×" from /api/projection.roiPace. roiPace is null when
  // there are no sessions in the trailing 7 days or no valid subscription
  // cost — hide rather than render a zero-data verdict (phantom-bucket rule).
  function paceLine(roiPace) {
    if (!roiPace || !Number.isFinite(roiPace.paceMultiple)) return null;
    return `Monthly pace: ${roiPace.paceMultiple.toFixed(1)}×`;
  }

  if (typeof window !== 'undefined') {
    window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine };
  }
})();
