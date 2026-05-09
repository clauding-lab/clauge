// Clauge popover (v0.5.0).
//
// Loads inside the native NSPopover's WKWebView, served by the SEA sidecar at
// http://127.0.0.1:{port}/popover/index.html — so /api/* fetches are
// same-origin and the v0.4.x `proxy_fetch` IPC workaround is no longer needed.
// JS → Rust messages (open_dashboard, resize) go through
// window.webkit.messageHandlers.clauge (see native_popover.rs::ClaugeScriptHandler).

// Track the popover state so we can repaint on data updates without a
// re-fetch (e.g. tab switch or warning-state transition).
let serverPort = 3456;
let serverVersion = '0.5.0';

// ─── helpers ──────────────────────────────────────────────
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

function fmtAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

// ─── fetch ────────────────────────────────────────────────
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return await res.json();
}

// ─── ring HTML helpers ────────────────────────────────────
// Mini ring (48px, four-up grid). pctFrac is 0..1.
function miniRingHtml({ label, pctFrac, reset, gradId }) {
  const r = 20;
  const c = 2 * Math.PI * r;
  const offset = c - Math.max(0, Math.min(1, pctFrac)) * c;
  const pctNum = Math.round(pctFrac * 100);
  const tone = pctFrac >= 0.85 ? 'crit' : pctFrac >= 0.6 ? 'amber' : pctFrac >= 0.05 ? 'healthy' : 'cool';
  // Each ring needs a unique gradient id so SVG stops don't collide when the
  // markup is reused. The gradId is supplied by the caller.
  return `
    <div class="po-ring-card">
      <div class="mini-ring ${tone}">
        <svg viewBox="0 0 48 48" aria-hidden="true">
          <defs>
            <linearGradient id="${escapeHtml(gradId)}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#e89478"/>
              <stop offset="100%" stop-color="#b45c41"/>
            </linearGradient>
          </defs>
          <circle cx="24" cy="24" r="${r}" fill="none"
            stroke="rgba(255,240,230,0.06)" stroke-width="3.5"/>
          <circle cx="24" cy="24" r="${r}" fill="none"
            stroke="url(#${escapeHtml(gradId)})" stroke-width="3.5" stroke-linecap="round"
            stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
        </svg>
        <div class="pct">
          <span class="num">${pctNum}</span><span class="sym">%</span>
        </div>
      </div>
      <div class="po-ring-label">${escapeHtml(label)}</div>
      <div class="po-ring-reset mono">${escapeHtml(reset)}</div>
    </div>`;
}

// Big ring (80px, warning state). Same shape, larger.
function bigWarnRingHtml(pctFrac) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const offset = c - Math.max(0, Math.min(1, pctFrac)) * c;
  const pctNum = Math.round(pctFrac * 100);
  return `
    <svg viewBox="0 0 80 80" aria-hidden="true">
      <defs>
        <linearGradient id="warnring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f0c780"/>
          <stop offset="100%" stop-color="#c88840"/>
        </linearGradient>
      </defs>
      <circle cx="40" cy="40" r="${r}" fill="none"
        stroke="rgba(255,240,230,0.06)" stroke-width="4.5"/>
      <circle cx="40" cy="40" r="${r}" fill="none"
        stroke="url(#warnring)" stroke-width="4.5" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
    </svg>
    <div class="pct">
      <span class="num">${pctNum}</span><span class="sym">%</span>
    </div>`;
}

// ─── render: header / status pill ─────────────────────────
function renderHeader({ ingestedAt, healthOk }) {
  document.getElementById('po-meta').textContent = `v${serverVersion} · :${serverPort}`;
  const pill = document.getElementById('po-status');
  const text = document.getElementById('po-status-text');
  if (!healthOk) {
    pill.className = 'po-status off';
    text.textContent = 'offline';
    return;
  }
  if (!ingestedAt) {
    pill.className = 'po-status';
    text.textContent = 'live';
    return;
  }
  const ageMs = Date.now() - Date.parse(ingestedAt);
  if (ageMs > 10 * 60_000) {
    pill.className = 'po-status stale';
    text.textContent = `stale ${fmtAgo(ingestedAt)}`;
  } else {
    pill.className = 'po-status';
    text.textContent = `synced ${fmtAgo(ingestedAt)}`;
  }
}

// ─── render: rings ────────────────────────────────────────
function renderRings(usage) {
  const plan = usage?.plan ?? {};
  // 4 rings: Session / Weekly / Sonnet / Design. Opus was removed in v0.4.4
  // because the user has no Opus quota plan, so the ring rendered as `—`.
  const gauges = [
    { label: 'Session', pctFrac: (plan.fiveHour?.pct ?? 0) / 100, reset: fmtRelative(plan.fiveHour?.resetsAt) },
    { label: 'Weekly',  pctFrac: (plan.sevenDay?.pct ?? 0) / 100, reset: fmtRelative(plan.sevenDay?.resetsAt) },
    { label: 'Design',  pctFrac: (plan.sevenDayOmelette?.pct ?? 0) / 100, reset: fmtRelative(plan.sevenDayOmelette?.resetsAt) },
  ];
  const root = document.getElementById('po-rings');
  root.innerHTML = gauges
    .map((g, i) => miniRingHtml({ ...g, gradId: `pop-rg-${i}` }))
    .join('');

  // Update plan-status aux label.
  const status = document.getElementById('plan-status');
  const maxPct = Math.max(...gauges.map((g) => g.pctFrac));
  if (maxPct >= 0.85) {
    status.textContent = 'critical';
    status.className = 'sect-aux mono crit';
  } else if (maxPct >= 0.6) {
    status.textContent = 'warn';
    status.className = 'sect-aux mono warn';
  } else {
    status.textContent = 'healthy';
    status.className = 'sect-aux mono';
  }
}

// ─── render: warning state ────────────────────────────────
function renderWarnState(usage) {
  const fiveHour = usage?.plan?.fiveHour;
  if (!fiveHour) return;
  const ringWrap = document.getElementById('warn-ring');
  ringWrap.innerHTML = bigWarnRingHtml((fiveHour.pct ?? 0) / 100);
  document.getElementById('warn-reset').textContent =
    `resets in ${fmtRelative(fiveHour.resetsAt)}`;
}

// ─── render: finance ──────────────────────────────────────
function renderFinance(usage) {
  const plan = usage?.plan ?? {};
  const ingestedAt = usage?.ingestedAt;

  // Extra usage card. Server returns enabled=false when the user hasn't
  // configured an extra-usage cap; in that case show a tasteful placeholder.
  const extra = plan.extraUsage;
  const extraUsedEl = document.getElementById('extra-used');
  const extraOfEl = document.getElementById('extra-of');
  const extraBarEl = document.getElementById('extra-bar');
  const extraFootEl = document.getElementById('extra-foot');
  if (extra && extra.enabled) {
    const used = extra.usedDollars ?? 0;
    const limit = extra.limitDollars ?? 0;
    extraUsedEl.textContent = fmtUSD(used);
    extraOfEl.textContent = limit > 0 ? `/ $${limit.toFixed(0)}` : '';
    // Match the dashboard's extra-usage logic: claude.ai sometimes returns
    // utilization=null at $0 — recompute from used/limit so the bar moves.
    let pctNum = extra.pct;
    if ((pctNum == null || !Number.isFinite(pctNum)) && limit > 0) {
      pctNum = (used / limit) * 100;
    }
    const pct = Math.max(0, Math.min(100, pctNum ?? 0));
    extraBarEl.style.width = `${pct.toFixed(1)}%`;
    extraFootEl.textContent = `${pct.toFixed(0)}% of cap`;
  } else {
    extraUsedEl.textContent = '0.00';
    extraOfEl.textContent = '';
    extraBarEl.style.width = '0%';
    extraFootEl.textContent = 'not configured';
  }

  // Balance card. Data wiring decision (v0.4.0): claude.ai consumer balance
  // arrives via the bookmarklet/extension as plan.claudeBalance. When the
  // user hasn't synced (or claude.ai's prepaid endpoint isn't found), we
  // render an em-dash with the sync status as foot text, rather than
  // inventing a fake number.
  const bal = plan.claudeBalance;
  const balValEl = document.getElementById('bal-val');
  const balBarEl = document.getElementById('bal-bar');
  const balFootEl = document.getElementById('bal-foot');
  const balCurrencyEl = document.getElementById('bal-currency');
  if (bal && Number.isFinite(bal.currentBalance)) {
    balValEl.textContent = fmtUSD(bal.currentBalance);
    balCurrencyEl.textContent = bal.currency === 'USD' || !bal.currency ? '$' : bal.currency;
    // No published cap from claude.ai, so show a fixed bar at 60% as a
    // visual anchor (matches the design mock; it's purely cosmetic).
    balBarEl.style.width = '60%';
    balFootEl.textContent = ingestedAt ? `refreshed ${fmtAgo(ingestedAt)} ago` : 'refreshed —';
  } else {
    balValEl.textContent = '—';
    balCurrencyEl.textContent = '$';
    balBarEl.style.width = '0%';
    balFootEl.textContent = 'sync to view';
  }
}

// ─── render: today snapshot ───────────────────────────────
function renderToday({ summary, cache }) {
  // Aux ("3 sessions · 2h 12m").
  const aux = document.getElementById('today-aux');
  const sessCount = summary?.sessionCount ?? 0;
  // We don't have a duration sum on /api/summary; derive a rough total from
  // assistantTurnCount as a stand-in. Future API polish can add a real
  // duration field. For now, omit the time so we never display a wrong number.
  aux.textContent = sessCount > 0 ? `${sessCount} session${sessCount === 1 ? '' : 's'}` : 'no sessions';

  document.getElementById('today-cost').textContent = `$${fmtUSD(summary?.cost ?? 0)}`;
  document.getElementById('today-cost-sub').textContent =
    summary?.avgCostPerSession != null
      ? `$${fmtUSD(summary.avgCostPerSession)} avg/sess`
      : '';
  document.getElementById('today-msgs').textContent = fmtInt(summary?.messageCount);
  document.getElementById('today-msgs-sub').textContent = `${fmtInt(summary?.toolCallCount)} tools`;

  const hit = cache?.hitRate;
  document.getElementById('today-cache').textContent = hit == null ? '—' : `${Math.round(hit * 100)}%`;
  // cacheRead is in tokens — abbreviate to the M/B unit for compactness.
  const reads = summary?.tokens?.cacheRead;
  let readsLabel = '—';
  if (Number.isFinite(reads)) {
    if (reads >= 1e9) readsLabel = `${(reads / 1e9).toFixed(1)}B`;
    else if (reads >= 1e6) readsLabel = `${(reads / 1e6).toFixed(1)}M`;
    else if (reads >= 1e3) readsLabel = `${(reads / 1e3).toFixed(1)}k`;
    else readsLabel = String(Math.round(reads));
  }
  document.getElementById('today-cache-sub').textContent = `${readsLabel} reads`;
}

// ─── orchestration ────────────────────────────────────────
let lastUsage = null;

// Reveal the loading overlay (clears `hidden` + `.fading` set by a previous
// hide cycle). Called on every popover show via the `show-loading` event so
// the user actually sees the overlay (without this the overlay was hidden
// during the cold-start hydration of the invisible webview, before any
// click). See lib.rs / tray.rs for the dispatch sites.
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
    const [health, summary, cache, usage] = await Promise.all([
      fetchJson('/api/health').catch(() => null),
      fetchJson('/api/summary?period=today').catch(() => null),
      fetchJson('/api/cache?period=today').catch(() => null),
      fetchJson('/api/usage').catch(() => null),
    ]);
    if (health?.version) serverVersion = health.version;
    healthOk = !!health;
    lastUsage = usage;

    // Set state BEFORE rendering so CSS hides the right sections.
    const pct = usage?.plan?.fiveHour?.pct ?? 0;
    const isWarn = pct >= 85;
    document.getElementById('root').dataset.state = isWarn ? 'warn' : 'default';

    renderHeader({ ingestedAt: usage?.ingestedAt, healthOk });
    if (isWarn) {
      renderWarnState(usage);
    } else {
      renderRings(usage);
      renderFinance(usage);
      renderToday({ summary, cache });
    }
  } catch (err) {
    // Hard failure — keep the static shell but flip the status pill.
    console.error('[Clauge popover] refresh failed:', err);
    renderHeader({ ingestedAt: null, healthOk: false });
  } finally {
    hideLoading();
    resizeToContent();
  }
}

// Resize the NSPopover's contentSize to match the rendered #root height. The
// width stays 360pt; only height tracks content so the popover never shows
// the v0.4.x "ghost outline" of empty vibrancy below the footer. The Rust
// handler clamps the same MIN/MAX bounds (see native_popover.rs).
function resizeToContent() {
  if (!window.webkit?.messageHandlers?.clauge) return;
  requestAnimationFrame(() => {
    try {
      const root = document.getElementById('root');
      if (!root) return;
      // CSS `zoom` on <html> visually scales content but offsetHeight returns
      // the UNZOOMED dimension. Multiply by the active zoom factor so the OS
      // popover matches the rendered (post-zoom) content height.
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const height = Math.ceil(root.offsetHeight * zoom);
      if (height < 200 || height > 800) return;
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

// ─── init ─────────────────────────────────────────────────
async function init() {
  // Popover loads same-origin from the SEA sidecar
  // (http://127.0.0.1:{port}/popover/index.html), so the live port is
  // already in window.location.
  const locPort = parseInt(window.location.port, 10);
  if (Number.isFinite(locPort) && locPort > 0) serverPort = locPort;


  // Wire footer dashboard link.
  document.getElementById('footer-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    openDashboard();
  });

  // Native-side popover-show entry points (tray icon left-click, single-instance
  // re-launch) dispatch this event from Rust via webview.eval. Rationale: the
  // webview hydrates while the popover is hidden, so the original first-fetch
  // hideLoading() runs before the user ever sees the surface. Re-showing the
  // overlay on each open + kicking a fresh refresh gives the user a real
  // hydration tell every time. See tray.rs::toggle_popover and lib.rs's
  // single-instance handler for the dispatch sites.
  window.addEventListener('show-loading', () => {
    showLoading();
    refresh();
  });

  // Keyboard shortcuts inside the popover. ⌘D opens the dashboard, ⌘R refreshes.
  // (Cmd+, is handled at the native-menu level via menu.rs and now opens the
  // dashboard's Settings tab — see tray.rs::show_dashboard_with_settings.)
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey) return;
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      openDashboard();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      refresh();
    }
  });

  await refresh();
  setInterval(refresh, 10_000);
}

document.addEventListener('DOMContentLoaded', init);
