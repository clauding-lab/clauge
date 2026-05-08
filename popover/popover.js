// Clauge popover (v0.4.0).
//
// All sidecar fetches go through Tauri's `proxy_fetch` IPC, NOT native fetch.
// See src-tauri/src/ipc.rs::proxy_fetch for the rationale — short version:
// WKWebView's mixed-content guard (popover loads from tauri://localhost or
// https://tauri.localhost; sidecar serves http://127.0.0.1:port) silently
// drops fetch responses, even though the wire-level request succeeds with
// CORS headers attached. Routing the request through Rust skips the entire
// browser fetch layer.
//
// The dashboard window doesn't need this — it loads via WebviewUrl::External
// pointed at the sidecar root, so its fetches are same-origin.

const { invoke } = window.__TAURI__.core;

// Track the popover state so we can repaint on data updates without a
// re-fetch (e.g. tab switch or warning-state transition).
let serverPort = 3456;
let serverVersion = '0.4.3';

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

// ─── proxy fetch (replaces native fetch) ──────────────────
async function fetchJson(path) {
  return await invoke('proxy_fetch', { path });
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
  // Mapping decision (v0.4.0 fixup): the design mock had four rings
  // (Session / Weekly / Sonnet / Design). v0.3.x rendered FIVE rings — the
  // design's set plus Opus. Auto-updating from v0.3.x to v0.4.0 silently
  // dropped Opus visibility, which is a regression for Opus-heavy users
  // (Adnan's profile: Opus is the user's primary working model). We
  // therefore extend the design's 4-ring grid to 5 columns to preserve
  // capacity parity. CSS handles the tighter 5-column layout via
  // `.po-rings { grid-template-columns: repeat(5, 1fr); }`.
  const gauges = [
    { label: 'Session', pctFrac: (plan.fiveHour?.pct ?? 0) / 100, reset: fmtRelative(plan.fiveHour?.resetsAt) },
    { label: 'Weekly',  pctFrac: (plan.sevenDay?.pct ?? 0) / 100, reset: fmtRelative(plan.sevenDay?.resetsAt) },
    { label: 'Sonnet',  pctFrac: (plan.sevenDaySonnet?.pct ?? 0) / 100, reset: fmtRelative(plan.sevenDaySonnet?.resetsAt) },
    { label: 'Opus',    pctFrac: (plan.sevenDayOpus?.pct ?? 0) / 100, reset: fmtRelative(plan.sevenDayOpus?.resetsAt) },
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

async function refresh() {
  let healthOk = false;
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
  }
}

// ─── prefs panel ──────────────────────────────────────────
function showPreferences() { document.getElementById('prefs').hidden = false; }
function hidePreferences() { document.getElementById('prefs').hidden = true; }

async function openDashboard() {
  await invoke('open_dashboard').catch((err) => console.error('open_dashboard failed:', err));
}

// ─── init ─────────────────────────────────────────────────
async function init() {
  try {
    serverPort = await invoke('get_server_port');
  } catch (err) {
    // Sidecar not yet bound — refresh's /api/health will set healthOk=false
    // and we'll keep retrying on the 10s interval.
    console.warn('[Clauge popover] get_server_port failed; using fallback:', err);
  }

  // Wire footer + prefs + dashboard buttons.
  document.getElementById('footer-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    openDashboard();
  });
  document.getElementById('prefs-back').addEventListener('click', hidePreferences);
  document.getElementById('check-updates-btn').addEventListener('click', () => {
    invoke('check_for_updates').catch((err) => console.error('check_for_updates failed:', err));
  });
  document.getElementById('prefs-dashboard-btn').addEventListener('click', openDashboard);

  // Autostart toggle wiring (preserved from v0.3.x).
  const autoToggle = document.getElementById('autostart-toggle');
  autoToggle.checked = await invoke('get_autostart').catch((err) => {
    console.warn('get_autostart failed; defaulting to off:', err);
    return false;
  });
  autoToggle.addEventListener('change', async () => {
    const desired = autoToggle.checked;
    try {
      await invoke('set_autostart', { enabled: desired });
    } catch (err) {
      console.error('set_autostart failed; reverting toggle:', err);
      autoToggle.checked = !desired;
    }
  });

  // External event from native menu (Cmd+, or tray's Preferences menu).
  // tray.rs and lib.rs both dispatch this CustomEvent on the popover webview.
  window.addEventListener('show-preferences', showPreferences);

  // Keyboard shortcuts inside the popover. ⌘D opens the dashboard, ⌘R refreshes.
  // (Cmd+, is handled at the native-menu level via menu.rs.)
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

  // Read the running server version once for the about-line.
  fetchJson('/api/health')
    .then((h) => {
      const el = document.getElementById('about-version');
      if (el && h?.version) el.textContent = `v${h.version}`;
    })
    .catch(() => {
      // Best-effort; the periodic refresh will pick it up later anyway.
    });

  await refresh();
  setInterval(refresh, 10_000);
}

document.addEventListener('DOMContentLoaded', init);
