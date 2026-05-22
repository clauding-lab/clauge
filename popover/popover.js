// Clauge popover (v0.9.1 redesign).
//
// Loads inside the native NSPopover's WKWebView, served by the SEA sidecar at
// http://127.0.0.1:{port}/popover/index.html. /api/* fetches are same-origin.
// JS → Rust messages (open_dashboard, resize, quit) go through
// window.webkit.messageHandlers.clauge (see native_popover.rs::ClaugeScriptHandler).

// ────────────────────────────────────────────────────────────
// State + constants
// ────────────────────────────────────────────────────────────
let serverPort = 3456;
let serverVersion = '0.5.0';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BURN_FAST_THRESHOLD = 10;       // usage% > time_elapsed% + 10 = burning_fast
const HEADROOM_THRESHOLD = 10;        // time_elapsed% > usage% + 10 = headroom
const ROUTINES_DAILY_CAP = 15;

// ────────────────────────────────────────────────────────────
// Pure helpers — exposed on window for testing in the dev console
// ────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUSD(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCompact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - nowMs;
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/**
 * Compute how much of a fixed-duration window has elapsed, as a 0..100
 * percentage. `resetsAt` is the END of the window; subtracting `windowMs`
 * gives the start. Returns 100 when the reset is past or unknown
 * (treat as fully-elapsed so the needle pins to the right rather than
 * snapping to 0 unexpectedly).
 */
function timeElapsedPct(resetsAtIso, windowMs, nowMs = Date.now()) {
  if (!resetsAtIso) return 100;
  const resetsAt = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAt)) return 100;
  const startedAt = resetsAt - windowMs;
  const elapsed = nowMs - startedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= windowMs) return 100;
  return (elapsed / windowMs) * 100;
}

/**
 * Format the "X of Y elapsed" label for the Session/Weekly gauges.
 * Returns "Xh Ym of 5h elapsed" for sessions, "Day X of 7 elapsed" for weekly.
 */
function formatElapsed(resetsAtIso, windowMs, mode, nowMs = Date.now()) {
  if (!resetsAtIso) return mode === 'weekly' ? 'Day — of 7 elapsed' : '— of 5h elapsed';
  const resetsAt = Date.parse(resetsAtIso);
  if (!Number.isFinite(resetsAt)) return '— elapsed';
  const startedAt = resetsAt - windowMs;
  const elapsedMs = Math.max(0, Math.min(windowMs, nowMs - startedAt));
  if (mode === 'weekly') {
    const day = Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1;
    return `Day ${day} of 7 elapsed`;
  }
  // session mode: hours + minutes
  const h = Math.floor(elapsedMs / 3600000);
  const m = Math.floor((elapsedMs % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m of 5h elapsed`;
  return `${m}m of 5h elapsed`;
}

/**
 * Compare usage vs time-elapsed to classify burn rate.
 * 'burning_fast' → usage outpacing time by >10pp (over-burn red tint applies)
 * 'headroom'     → time outpacing usage by >10pp
 * 'on_pace'      → within 10pp either way
 */
function burnState(usagePct, timeElapsedPctValue) {
  if (!Number.isFinite(usagePct) || !Number.isFinite(timeElapsedPctValue)) return 'on_pace';
  if (usagePct > timeElapsedPctValue + BURN_FAST_THRESHOLD) return 'burning_fast';
  if (timeElapsedPctValue > usagePct + HEADROOM_THRESHOLD) return 'headroom';
  return 'on_pace';
}

// ────────────────────────────────────────────────────────────
// Fetch
// ────────────────────────────────────────────────────────────
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return await res.json();
}

// ────────────────────────────────────────────────────────────
// Render: circle gauge (Session — hero)
// ────────────────────────────────────────────────────────────
function renderSessionGauge(usagePct, timeElapsedPctValue) {
  const el = document.getElementById('session-gauge');
  if (!el) return;
  const usage = Math.max(0, Math.min(100, usagePct ?? 0));
  const elapsed = Math.max(0, Math.min(100, timeElapsedPctValue ?? 0));
  const burn = burnState(usage, elapsed);

  // Geometry: SVG 110x110, ring centered, stroke 8px, r=46 → circumference 289.03.
  const r = 46;
  const c = 2 * Math.PI * r;
  const usageArc = (usage / 100) * c;
  const usageOffset = c - usageArc;

  // Needle position (time-elapsed): on the outer rim at elapsed% around from
  // 12 o'clock clockwise. Angle in radians from +Y axis going clockwise.
  const angleRad = (elapsed / 100) * 2 * Math.PI - Math.PI / 2;
  const needleX = 55 + r * Math.cos(angleRad);
  const needleY = 55 + r * Math.sin(angleRad);

  // Over-burn segment: arc from the needle position to the usage end (only
  // visible when usage > elapsed). Tints the over-burn portion red.
  const overflowVisible = burn === 'burning_fast';
  const overflowStartPct = elapsed;
  const overflowArc = Math.max(0, (usage - overflowStartPct) / 100) * c;
  const overflowOffset = c - overflowArc;
  // Rotate the overflow stroke so it starts where the needle sits (rather
  // than 12 o'clock).
  const overflowRotation = (elapsed / 100) * 360;

  el.innerHTML = `
    <svg viewBox="0 0 110 110" aria-hidden="true">
      <!-- Track -->
      <circle cx="55" cy="55" r="${r}" fill="none" stroke="rgba(244, 236, 228, 0.10)" stroke-width="8"/>
      <!-- Usage arc (orange, sweeping from 12 clockwise) -->
      <circle cx="55" cy="55" r="${r}" fill="none"
        stroke="${overflowVisible ? '#d97757' : '#d97757'}"
        stroke-width="8"
        stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}"
        stroke-dashoffset="${usageOffset.toFixed(2)}"
        transform="rotate(-90 55 55)"
        opacity="${overflowVisible ? '1' : '1'}"/>
      ${overflowVisible ? `
        <!-- Over-burn red segment (past the needle) -->
        <circle cx="55" cy="55" r="${r}" fill="none"
          stroke="#c97a7a"
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray="${c.toFixed(2)}"
          stroke-dashoffset="${overflowOffset.toFixed(2)}"
          transform="rotate(${(-90 + overflowRotation).toFixed(2)} 55 55)"/>
      ` : ''}
      <!-- Needle dot at time-elapsed position on the outer rim -->
      <circle cx="${needleX.toFixed(2)}" cy="${needleY.toFixed(2)}" r="3.5"
        fill="rgba(244, 236, 228, 0.92)"
        stroke="rgba(0, 0, 0, 0.4)"
        stroke-width="0.5"/>
    </svg>
    <div class="gauge-center">
      <div>
        <span class="gauge-pct">${Math.round(usage)}</span><span class="gauge-pct-suffix">%</span>
      </div>
      <div class="gauge-sub-label">Session</div>
    </div>
  `;
}

// ────────────────────────────────────────────────────────────
// Render: needle bar (Weekly)
// ────────────────────────────────────────────────────────────
function renderNeedleBar({ wrapId, needleId, fillId, overflowId, usagePct, timeElapsedPctValue }) {
  const usage = Math.max(0, Math.min(100, usagePct ?? 0));
  const elapsed = Math.max(0, Math.min(100, timeElapsedPctValue ?? 0));
  const burn = burnState(usage, elapsed);

  const needle = document.getElementById(needleId);
  const fill = document.getElementById(fillId);
  const overflow = document.getElementById(overflowId);

  if (needle) needle.style.left = `${elapsed.toFixed(1)}%`;

  if (burn === 'burning_fast') {
    // Orange fill stops at elapsed%; red overflow takes over from there to usage%.
    if (fill) fill.style.width = `${elapsed.toFixed(1)}%`;
    if (overflow) {
      overflow.style.left = `${elapsed.toFixed(1)}%`;
      overflow.style.width = `${(usage - elapsed).toFixed(1)}%`;
    }
  } else {
    if (fill) fill.style.width = `${usage.toFixed(1)}%`;
    if (overflow) overflow.style.width = '0%';
  }
}

// ────────────────────────────────────────────────────────────
// Render: simple bar (Sonnet only, Claude Design, Daily Routines, Extra)
// ────────────────────────────────────────────────────────────
function renderSimpleBar({ fillId, overflowId, usagePct, capPct = 100 }) {
  const usage = Math.max(0, usagePct ?? 0);
  const fill = document.getElementById(fillId);
  const overflow = document.getElementById(overflowId);

  // Normal portion (up to capPct, e.g. 100). Overflow is anything past capPct.
  const fillPct = Math.min(capPct, usage);
  if (fill) fill.style.width = `${fillPct.toFixed(1)}%`;

  if (overflow) {
    if (usage > capPct) {
      // Show overflow segment to the right of the cap, clamped to visible bar.
      overflow.style.left = `${capPct.toFixed(1)}%`;
      const visibleOverflow = Math.min(100 - capPct, usage - capPct);
      overflow.style.width = `${visibleOverflow.toFixed(1)}%`;
    } else {
      overflow.style.width = '0%';
    }
  }
}

// ────────────────────────────────────────────────────────────
// Render: full popover from /api/usage payload
// ────────────────────────────────────────────────────────────
function renderPlanBadge(plan) {
  // Extract a plan name. Without a dedicated server field, best-effort
  // from common signals: extraUsage.enabled + non-zero limit suggests "Max"
  // or similar paid tier; otherwise show "—".
  const extra = plan?.extraUsage;
  const el = document.getElementById('po-plan-badge');
  if (!el) return;
  // Default to Max (most Clauge users); future: surface a real subscription
  // tier field from the server.
  el.textContent = extra && extra.enabled ? 'Max' : '—';
}

function renderSession(plan, nowMs) {
  const fiveHour = plan?.fiveHour;
  const usagePct = fiveHour?.pct ?? 0;
  const resetsAt = fiveHour?.resetsAt;
  const elapsed = timeElapsedPct(resetsAt, FIVE_HOURS_MS, nowMs);
  renderSessionGauge(usagePct, elapsed);
  document.getElementById('session-elapsed').textContent = formatElapsed(resetsAt, FIVE_HOURS_MS, 'session', nowMs);
  document.getElementById('session-reset').textContent = `resets in ${fmtRelative(resetsAt, nowMs)}`;
}

function renderWeekly(plan, nowMs) {
  const sevenDay = plan?.sevenDay;
  const usagePct = sevenDay?.pct ?? 0;
  const resetsAt = sevenDay?.resetsAt;
  const elapsed = timeElapsedPct(resetsAt, SEVEN_DAYS_MS, nowMs);
  renderNeedleBar({
    needleId: 'weekly-needle',
    fillId: 'weekly-fill',
    overflowId: 'weekly-overflow',
    usagePct,
    timeElapsedPctValue: elapsed,
  });
  document.getElementById('weekly-pct').textContent = `${Math.round(usagePct)}% used`;
  document.getElementById('weekly-elapsed').textContent = formatElapsed(resetsAt, SEVEN_DAYS_MS, 'weekly', nowMs);
  document.getElementById('weekly-reset').textContent = `resets in ${fmtRelative(resetsAt, nowMs)}`;
}

function renderSonnet(plan, nowMs) {
  const sonnet = plan?.sevenDaySonnet;
  const pct = sonnet?.pct ?? 0;
  renderSimpleBar({ fillId: 'sonnet-fill', usagePct: pct });
  document.getElementById('sonnet-pct').textContent = `${Math.round(pct)}% used`;
  document.getElementById('sonnet-reset').textContent = sonnet?.resetsAt
    ? `resets in ${fmtRelative(sonnet.resetsAt, nowMs)}`
    : '';
}

function renderDesign(plan, nowMs) {
  const design = plan?.claudeDesign;
  const pct = design?.pct ?? 0;
  renderSimpleBar({ fillId: 'design-fill', usagePct: pct });
  document.getElementById('design-pct').textContent = `${Math.round(pct)}% used`;
  document.getElementById('design-reset').textContent = design?.resetsAt
    ? `resets in ${fmtRelative(design.resetsAt, nowMs)}`
    : '';
}

function renderRoutines(plan, nowMs) {
  const r = plan?.dailyRoutines;
  // Routines is a daily count, capped at 15. The pct field is the upstream's
  // utilization. If we have raw count later, swap to count/15 directly.
  const pct = r?.pct ?? 0;
  const count = Math.round((pct / 100) * ROUTINES_DAILY_CAP);
  renderSimpleBar({ fillId: 'routines-fill', usagePct: pct });
  document.getElementById('routines-count').textContent = `${count} of ${ROUTINES_DAILY_CAP} runs today`;
  document.getElementById('routines-reset').textContent = r?.resetsAt
    ? `resets in ${fmtRelative(r.resetsAt, nowMs)}`
    : '';
}

function renderExtra(plan, nowMs) {
  const extra = plan?.extraUsage;
  const balance = plan?.claudeBalance;

  if (extra && extra.enabled) {
    const used = extra.usedDollars ?? 0;
    const limit = extra.limitDollars ?? 0;
    let pctNum = extra.pct;
    if ((pctNum == null || !Number.isFinite(pctNum)) && limit > 0) {
      pctNum = (used / limit) * 100;
    }
    const pct = pctNum ?? 0;
    renderSimpleBar({
      fillId: 'extra-fill',
      overflowId: 'extra-overflow',
      usagePct: pct,
      capPct: 100,
    });
    document.getElementById('extra-pct').textContent = `$${fmtUSD(used)} / $${limit.toFixed(0)} limit`;
    document.getElementById('extra-pct-used').textContent = `${Math.round(pct)}% used`;
  } else {
    renderSimpleBar({ fillId: 'extra-fill', overflowId: 'extra-overflow', usagePct: 0 });
    document.getElementById('extra-pct').textContent = 'not configured';
    document.getElementById('extra-pct-used').textContent = '';
  }

  // Balance + auto-reload status line.
  const balEl = document.getElementById('extra-balance');
  if (balance && Number.isFinite(balance.currentBalance)) {
    const auto = balance.autoReload === true ? 'on' : 'off';
    balEl.textContent = `Balance: $${fmtUSD(balance.currentBalance)} · Auto-reload ${auto}`;
  } else {
    balEl.textContent = 'Balance: — · Auto-reload —';
  }

  // Extra usage reset (calendar month — use 1st of next month if no signal).
  const resetEl = document.getElementById('extra-reset');
  if (extra?.resetsAt) {
    resetEl.textContent = `resets ${fmtRelative(extra.resetsAt, nowMs)}`;
  } else {
    resetEl.textContent = '';
  }
}

function renderStats({ summary, cache, period30d }) {
  document.getElementById('stat-today-cost').textContent =
    summary?.cost != null ? `$${fmtUSD(summary.cost)}` : '—';

  document.getElementById('stat-30d-cost').textContent =
    period30d?.cost != null ? `$${fmtUSD(period30d.cost)}` : '—';

  document.getElementById('stat-30d-tokens').textContent =
    period30d?.tokens?.total != null ? fmtCompact(period30d.tokens.total) : '—';

  // Latest tokens = most recent session's tokens, best-effort
  document.getElementById('stat-latest-tokens').textContent =
    summary?.tokens?.total != null ? fmtCompact(summary.tokens.total) : '—';
}

function renderSpendChart(period30d) {
  const el = document.getElementById('spend-chart');
  if (!el) return;
  // Without a real daily-buckets API, render a placeholder mini-chart with
  // 30 cells representing relative spend if we have it, otherwise hide.
  const buckets = period30d?.dailySpend;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const max = Math.max(...buckets, 0.01);
  const todayIdx = buckets.length - 1;
  el.innerHTML = buckets
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * 100));
      const cls = i === todayIdx ? 'spend-chart-bar today' : 'spend-chart-bar';
      return `<div class="${cls}" style="height:${h}%"></div>`;
    })
    .join('');
}

function renderDisclaimer({ topModel }) {
  const el = document.getElementById('disclaimer');
  if (!el) return;
  if (topModel) {
    el.textContent = `Top model: ${escapeHtml(topModel)} · Estimated from local Claude logs`;
  } else {
    el.textContent = 'Estimated from local Claude logs';
  }
}

function renderHeaderSubhead(ingestedAt, healthOk) {
  const el = document.getElementById('po-subhead');
  if (!el) return;
  if (!healthOk) {
    el.textContent = 'Offline';
    return;
  }
  if (!ingestedAt) {
    el.textContent = 'Updated just now';
    return;
  }
  const ageMs = Date.now() - Date.parse(ingestedAt);
  if (!Number.isFinite(ageMs) || ageMs < 60000) {
    el.textContent = 'Updated just now';
  } else {
    const minutes = Math.floor(ageMs / 60000);
    el.textContent = `Updated ${minutes}m ago`;
  }
}

function renderStatusAction(healthOk) {
  const el = document.getElementById('action-status-label');
  if (!el) return;
  el.textContent = healthOk ? 'Status: All systems normal' : 'Status: Offline';
}

// ────────────────────────────────────────────────────────────
// Orchestration
// ────────────────────────────────────────────────────────────
function showLoading() {
  const el = document.getElementById('po-loading');
  if (!el) return;
  el.removeAttribute('hidden');
  el.classList.remove('fading');
}

async function refresh() {
  let healthOk = false;
  let loadingHidden = false;
  const hideLoading = () => {
    if (loadingHidden) return;
    loadingHidden = true;
    const el = document.getElementById('po-loading');
    if (!el) return;
    el.classList.add('fading');
    setTimeout(() => el.setAttribute('hidden', ''), 220);
  };
  try {
    const [health, summary, cache, usage, period30d] = await Promise.all([
      fetchJson('/api/health').catch(() => null),
      fetchJson('/api/summary?period=today').catch(() => null),
      fetchJson('/api/cache?period=today').catch(() => null),
      fetchJson('/api/usage').catch(() => null),
      fetchJson('/api/summary?period=30d').catch(() => null),
    ]);
    if (health?.version) serverVersion = health.version;
    healthOk = !!health;

    const plan = usage?.plan ?? {};
    const nowMs = Date.now();

    renderHeaderSubhead(usage?.ingestedAt, healthOk);
    renderPlanBadge(plan);
    renderSession(plan, nowMs);
    renderWeekly(plan, nowMs);
    renderSonnet(plan, nowMs);
    renderDesign(plan, nowMs);
    renderRoutines(plan, nowMs);
    renderExtra(plan, nowMs);
    renderStats({ summary, cache, period30d });
    renderSpendChart(period30d);
    renderDisclaimer({ topModel: summary?.topModel });
    renderStatusAction(healthOk);

    // Update footer version label.
    const aboutEl = document.getElementById('footer-about-version');
    if (aboutEl) aboutEl.textContent = `v${serverVersion}`;
    const aboutEl2 = document.getElementById('about-version');
    if (aboutEl2) aboutEl2.textContent = `v${serverVersion}`;
  } catch (err) {
    console.error('[Clauge popover] refresh failed:', err);
    renderHeaderSubhead(null, false);
    renderStatusAction(false);
  } finally {
    hideLoading();
    resizeToContent();
  }
}

function resizeToContent() {
  if (!window.webkit?.messageHandlers?.clauge) return;
  requestAnimationFrame(() => {
    try {
      const root = document.getElementById('root');
      if (!root) return;
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const height = Math.ceil(root.offsetHeight * zoom);
      if (height < 200 || height > 1200) return;
      window.webkit.messageHandlers.clauge.postMessage({ cmd: 'resize', height });
    } catch (err) {
      console.warn('[Clauge popover] resizeToContent failed:', err);
    }
  });
}

function openDashboard() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'open_dashboard' });
  } catch (err) {
    console.error('open_dashboard postMessage failed:', err);
  }
}

function openSettings() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'open_settings' });
  } catch (err) {
    // Fallback: open dashboard if no settings handler.
    openDashboard();
  }
}

function quitApp() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'quit' });
  } catch (err) {
    console.error('quit postMessage failed:', err);
  }
}

// ────────────────────────────────────────────────────────────
// Init
// ────────────────────────────────────────────────────────────
async function init() {
  const locPort = parseInt(window.location.port, 10);
  if (Number.isFinite(locPort) && locPort > 0) serverPort = locPort;

  // Action items
  document.getElementById('action-add-account')?.addEventListener('click', openSettings);
  document.getElementById('action-dashboard')?.addEventListener('click', openDashboard);
  document.getElementById('action-status')?.addEventListener('click', openDashboard);

  // Footer
  document.getElementById('footer-refresh')?.addEventListener('click', () => refresh());
  document.getElementById('footer-settings')?.addEventListener('click', openSettings);
  document.getElementById('footer-about')?.addEventListener('click', () => {
    // Open prefs panel (legacy About flow).
    document.getElementById('prefs')?.removeAttribute('hidden');
    resizeToContent();
  });
  document.getElementById('footer-quit')?.addEventListener('click', quitApp);

  // Prefs panel back button
  document.getElementById('prefs-back')?.addEventListener('click', () => {
    document.getElementById('prefs')?.setAttribute('hidden', '');
    resizeToContent();
  });
  document.getElementById('prefs-dashboard-btn')?.addEventListener('click', openDashboard);
  document.getElementById('check-updates-btn')?.addEventListener('click', () => {
    // Triggered via the Tauri IPC layer in the dashboard window; in the
    // popover we just open the dashboard to its Updates pane.
    openDashboard();
  });

  // Native-side popover-show entry points dispatch this event via webview.eval.
  window.addEventListener('show-loading', () => {
    showLoading();
    refresh();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      openDashboard();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      refresh();
    } else if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      quitApp();
    } else if (e.key === ',') {
      e.preventDefault();
      openSettings();
    }
  });

  await refresh();
  setInterval(refresh, 10_000);
}

// Expose pure helpers on window for ad-hoc testing in the dev console.
if (typeof window !== 'undefined') {
  window.__clauge = {
    timeElapsedPct,
    formatElapsed,
    burnState,
    fmtUSD,
    fmtCompact,
    fmtRelative,
  };
}

document.addEventListener('DOMContentLoaded', init);
