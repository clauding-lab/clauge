// Clauge dashboard v0.4.0 — Liquid Glass.
//
// Vanilla JS, no framework, no build step. Mock data from the design handoff
// has been replaced with live calls to the existing /api/* endpoints. The
// initial-load retry-with-backoff (v0.3.1's Bug #5 fix, T32) is preserved
// because the WebView still races the SEA sidecar bind during cold start.

// ─── State ────────────────────────────────────────────────
const state = {
  period: '7d',
  tab: 'overview',
  // Cached so tab switches don't re-fetch when the user just toggled tabs.
  // refreshAll() repopulates these on every period switch / refresh.
  data: {
    summary: null,
    cache: null,
    sessions: null,
    daily: null,
    hours: null,
    projects: null,
    activity: null,
    tools: null,
    models: null,
    usage: null,
    expensive: null,
    health: null,
    roi: null,
  },
};

const PERIOD_LABELS = {
  today: 'Today',
  '7d': '7d',
  '30d': '30d',
  month: 'Month',
  all: 'All',
};

// ─── Formatters ───────────────────────────────────────────
const fmtUSD = (n) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);

const fmtInt = (n) =>
  n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n));

const fmtPct = (frac, digits = 0) =>
  frac == null || !Number.isFinite(frac) ? '—' : `${(frac * 100).toFixed(digits)}%`;

const fmtTokens = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const fmtAgo = (iso) => {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

const fmtRelative = (iso) => {
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
};

const TZ_LABEL = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  } catch {
    return 'local';
  }
})();

// ─── API ──────────────────────────────────────────────────
async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
function commonParams() { return { period: state.period }; }

// ─── HTML helpers ─────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function modelClass(model) {
  if (!model) return '';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return '';
}
function modelColorVar(cls) {
  return cls === 'opus' ? 'var(--opus)'
       : cls === 'haiku' ? 'var(--haiku)'
       : 'var(--sonnet)';
}

function totalTokensOf(t) {
  return (t?.inputTokens || 0) + (t?.outputTokens || 0)
       + (t?.cacheRead || 0) + (t?.cacheCreate5m || 0) + (t?.cacheCreate1h || 0);
}

// ─── Big rings (overview plan-hero) ──────────────────────
function bigRingHtml({ label, sub, metric, gradId }) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const pctFrac = metric?.pct == null ? 0 : Math.max(0, Math.min(100, metric.pct)) / 100;
  const offset = c - pctFrac * c;
  const tone = pctFrac >= 0.85 ? 'crit'
             : pctFrac >= 0.6  ? 'amber'
             : pctFrac >= 0.05 ? 'healthy'
             : 'cool';
  const pctNum = metric?.pct == null ? '—' : Math.round(metric.pct);
  const reset = fmtRelative(metric?.resetsAt);
  return `
    <div class="ring-card">
      <div class="big-ring ${tone}">
        <svg viewBox="0 0 132 132" aria-hidden="true">
          <defs>
            <linearGradient id="${escapeHtml(gradId)}" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#e89478"/>
              <stop offset="100%" stop-color="#b45c41"/>
            </linearGradient>
          </defs>
          <circle cx="66" cy="66" r="${r}" fill="none"
            stroke="rgba(255,240,230,0.06)" stroke-width="9"/>
          <circle cx="66" cy="66" r="${r}" fill="none"
            stroke="url(#${escapeHtml(gradId)})" stroke-width="9" stroke-linecap="round"
            stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
        </svg>
        <div class="ring-pct"><span class="big">${pctNum}</span><span class="pct-sym">%</span></div>
      </div>
      <div class="ring-meta">
        <div class="ring-label">${escapeHtml(label)} <span class="ring-window">${escapeHtml(sub)}</span></div>
        <div class="ring-reset">resets in ${escapeHtml(reset)}</div>
      </div>
    </div>`;
}

// ─── Topbar plan-inline mini rings ────────────────────────
function inlineMiniRingHtml({ pct, label }) {
  const r = 8.5;
  const c = 2 * Math.PI * r;
  const pctFrac = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100;
  const offset = c - pctFrac * c;
  const num = pct == null ? '—' : Math.round(pct);
  return `
    <div class="mini-ring" title="${escapeHtml(label)} ${num}%">
      <svg viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="${r}" fill="none" stroke="rgba(255,240,230,0.10)" stroke-width="2.5"/>
        <circle cx="11" cy="11" r="${r}" fill="none" stroke="var(--brand)" stroke-width="2.5"
          stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"/>
      </svg>
      <div class="lbl">${num}</div>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
//  Refresh: plan capacity + finance
// ═══════════════════════════════════════════════════════════
function renderPlanCapacity() {
  const usage = state.data.usage;
  const planMeta = document.getElementById('plan-meta');
  const planTag = document.getElementById('plan-status-tag');
  const body = document.getElementById('plan-body');
  const inline = document.getElementById('plan-inline');

  if (!usage || !usage.ingested) {
    planMeta.innerHTML = `<span class="dot-live" style="background:var(--text-3);box-shadow:none;animation:none"></span>not synced`;
    planTag.textContent = '○ Awaiting sync';
    planTag.style.background = 'var(--glass-2)';
    planTag.style.color = 'var(--text-3)';
    // Render four placeholder rings so the layout doesn't collapse.
    body.innerHTML = ['Session', 'Weekly', 'Sonnet', 'Design']
      .map((label, i) => bigRingHtml({ label, sub: i === 0 ? '5h' : '7d', metric: null, gradId: `dash-rg-${i}` }))
      .join('');
    inline.hidden = true;
    return;
  }

  const plan = usage.plan ?? {};
  const gauges = [
    { label: 'Session',    sub: '5h', metric: plan.fiveHour },
    { label: 'Weekly all', sub: '7d', metric: plan.sevenDay },
    { label: 'Sonnet',     sub: '7d', metric: plan.sevenDaySonnet },
    { label: 'Design',     sub: '7d', metric: plan.sevenDayOmelette },
  ];
  body.innerHTML = gauges.map((g, i) => bigRingHtml({ ...g, gradId: `dash-rg-${i}` })).join('');

  // Status tag based on the highest pct.
  const maxPct = Math.max(...gauges.map((g) => g.metric?.pct ?? 0));
  if (maxPct >= 85) {
    planTag.textContent = '● Critical';
    planTag.style.background = 'rgba(224,123,110,0.14)';
    planTag.style.color = 'var(--crit)';
  } else if (maxPct >= 60) {
    planTag.textContent = '● Warming';
    planTag.style.background = 'var(--warn-tint)';
    planTag.style.color = 'var(--warn)';
  } else {
    planTag.textContent = '● Healthy';
    planTag.style.background = 'var(--ok-tint)';
    planTag.style.color = 'var(--ok)';
  }

  // Sync line
  planMeta.innerHTML = `<span class="dot-live"></span>synced ${escapeHtml(fmtAgo(usage.ingestedAt))} · auto-refresh 60s`;

  // Topbar inline plan summary
  const sevenDayCost = state.data.summary?.cost;
  const balance = plan.claudeBalance?.currentBalance;
  inline.hidden = false;
  inline.innerHTML = `
    ${inlineMiniRingHtml({ pct: plan.fiveHour?.pct, label: 'Session' })}
    ${inlineMiniRingHtml({ pct: plan.sevenDay?.pct, label: 'Weekly' })}
    ${inlineMiniRingHtml({ pct: plan.sevenDaySonnet?.pct, label: 'Sonnet' })}
    ${inlineMiniRingHtml({ pct: plan.sevenDayOmelette?.pct, label: 'Design' })}
    <span class="sep"></span>
    <span class="num-lbl">${escapeHtml(PERIOD_LABELS[state.period] ?? state.period)}</span>
    <span class="num">${escapeHtml(sevenDayCost != null ? fmtUSD(sevenDayCost) : '—')}</span>
    ${balance != null ? `<span class="sep"></span><span class="num-lbl">bal</span><span class="num">${escapeHtml(fmtUSD(balance))}</span>` : ''}
  `;
}

function renderFinanceSide() {
  const usage = state.data.usage;
  const plan = usage?.plan ?? {};
  const extra = plan.extraUsage;
  const usedEl = document.getElementById('extra-used');
  const capEl = document.getElementById('extra-cap');
  const barEl = document.getElementById('extra-bar');
  const pctEl = document.getElementById('extra-pct');
  const currEl = document.getElementById('extra-currency');

  if (extra && extra.enabled) {
    const used = extra.usedDollars ?? 0;
    const limit = extra.limitDollars ?? 0;
    usedEl.textContent = used.toFixed(2);
    capEl.textContent = limit > 0 ? `/ $${limit.toFixed(2)}` : '';
    let pct = extra.pct;
    if ((pct == null || !Number.isFinite(pct)) && limit > 0) pct = (used / limit) * 100;
    pct = Math.max(0, Math.min(100, pct ?? 0));
    barEl.style.width = `${pct.toFixed(1)}%`;
    pctEl.textContent = `${pct.toFixed(1)}% of cap`;
    currEl.textContent = extra.currency || 'USD';
  } else {
    usedEl.textContent = '0.00';
    capEl.textContent = '';
    barEl.style.width = '0%';
    pctEl.textContent = 'not configured';
    currEl.textContent = 'USD';
  }

  // claude.ai balance side card
  const bal = plan.claudeBalance;
  const valEl = document.getElementById('claude-balance-val');
  const ccyEl = document.getElementById('claude-balance-currency');
  const footEl = document.getElementById('claude-balance-foot');
  if (bal && Number.isFinite(bal.currentBalance)) {
    valEl.textContent = bal.currentBalance.toFixed(2);
    ccyEl.textContent = bal.currency || 'USD';
    footEl.textContent = usage?.ingestedAt ? `refreshed ${fmtAgo(usage.ingestedAt)}` : '';
  } else {
    valEl.textContent = '—';
    ccyEl.textContent = 'USD';
    footEl.textContent = 'sync to view';
  }
}

// ═══════════════════════════════════════════════════════════
//  Refresh: code analytics digest strip
// ═══════════════════════════════════════════════════════════
function renderMetricStrip() {
  const summary = state.data.summary;
  const cache = state.data.cache;
  const sessions = state.data.sessions;
  const roi = state.data.roi;
  const health = state.data.health;

  document.getElementById('ms-period-chip').textContent = PERIOD_LABELS[state.period] ?? state.period;

  document.getElementById('ms-cost').textContent = fmtUSD(summary?.cost);
  const subCost = roi?.subscriptionCost ?? health?.subscriptionCost ?? 200;
  document.getElementById('ms-sub-cost').textContent = `${fmtUSD(subCost)}/mo`;

  const savings = cache?.netSavingsUSD;
  document.getElementById('ms-savings').textContent =
    savings != null ? `${fmtUSD(savings)} cache savings` : '—';

  document.getElementById('ms-messages').textContent = fmtInt(summary?.messageCount);
  document.getElementById('ms-tools').textContent = `${fmtInt(summary?.toolCallCount)} tool calls`;

  document.getElementById('ms-sessions').textContent = fmtInt(summary?.sessionCount ?? sessions?.count);
  document.getElementById('ms-subagents').textContent = `${fmtInt(summary?.subagentTurnCount)} subagents`;

  document.getElementById('ms-cachehit').textContent = fmtPct(cache?.hitRate, 1);
  const reads = summary?.tokens?.cacheRead;
  document.getElementById('ms-cachereads').textContent = `${fmtTokens(reads)} cached reads`;

  const totalTok = summary?.totalTokens ?? totalTokensOf(summary?.tokens ?? {});
  document.getElementById('ms-tokens').textContent = fmtTokens(totalTok);
  const inTok = summary?.tokens?.inputTokens;
  const outTok = summary?.tokens?.outputTokens;
  document.getElementById('ms-token-split').textContent =
    `${fmtTokens(inTok)} in · ${fmtTokens(outTok)} out`;

  // ROI: API returns roiPct + apiReplacementValue + subscriptionCost (see
  // server.js /api/roi). Show the percentage in the strip with a multiplier
  // sub-line. Frontend used to read roi.netValue/multiplier but the API
  // never exposed those names — fixed in v0.5.0.
  if (
    roi &&
    Number.isFinite(roi.apiReplacementValue) &&
    Number.isFinite(roi.subscriptionCost) &&
    roi.subscriptionCost > 0
  ) {
    document.getElementById('ms-roi').textContent = `${Math.round(roi.roiPct)}%`;
    const mult = roi.apiReplacementValue / roi.subscriptionCost;
    document.getElementById('ms-roi-sub').textContent =
      `${mult.toFixed(1)}× · ${fmtUSD(roi.apiReplacementValue)} net value`;
  } else {
    document.getElementById('ms-roi').textContent = '—';
    document.getElementById('ms-roi-sub').textContent = '—';
  }
}

// ═══════════════════════════════════════════════════════════
//  Refresh: cost over time chart
// ═══════════════════════════════════════════════════════════
function utcHoursToLocal(hours) {
  const out = new Array(24).fill(null).map((_, i) => ({ hour: i, calls: 0, cost: 0 }));
  for (const h of hours ?? []) {
    const d = new Date();
    d.setUTCHours(h.hour, 0, 0, 0);
    const localH = d.getHours();
    out[localH] = { hour: localH, calls: h.calls ?? 0, cost: h.cost ?? 0 };
  }
  return out;
}

function pickTicks(labels, count) {
  if (labels.length === 0) return [];
  if (labels.length <= count) {
    return labels.map((l) => shortDate(l));
  }
  const step = (labels.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => shortDate(labels[Math.round(i * step)]));
}

function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return m && d ? `${m}/${d}` : iso;
}

function renderCostChart() {
  const wrap = document.getElementById('cost-chart');
  const ticks = document.getElementById('cost-ticks');
  const meta = document.getElementById('cost-meta');
  const isToday = state.period === 'today';

  if (isToday) {
    const list = utcHoursToLocal(state.data.hours?.hours);
    meta.textContent = `24 hours (${TZ_LABEL})`;
    if (list.every((h) => h.cost === 0)) {
      wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
      ticks.innerHTML = '';
      return;
    }
    const max = Math.max(...list.map((h) => h.cost), 0.0001);
    const nowHour = new Date().getHours();
    let html = '<div class="gridline" style="bottom:25%"></div><div class="gridline" style="bottom:50%"></div><div class="gridline" style="bottom:75%"></div>';
    for (const h of list) {
      const heightPct = (h.cost / max) * 100;
      const cls = h.hour === nowHour ? 'now' : h.hour > nowHour ? 'dim' : '';
      html += `<div class="bar ${cls}" style="height:${Math.max(heightPct, 0.5).toFixed(1)}%" title="${String(h.hour).padStart(2,'0')}:00 — ${fmtUSD(h.cost)}"></div>`;
    }
    wrap.innerHTML = html;
    ticks.innerHTML = '<span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>';
    return;
  }

  const days = state.data.daily?.days ?? [];
  meta.textContent = `${days.length} day${days.length === 1 ? '' : 's'}`;
  if (days.length === 0) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    ticks.innerHTML = '';
    return;
  }
  const max = Math.max(...days.map((d) => d.totalCost), 1);
  const todayDate = new Date().toISOString().slice(0, 10);
  let html = '<div class="gridline" style="bottom:25%"></div><div class="gridline" style="bottom:50%"></div><div class="gridline" style="bottom:75%"></div>';
  for (const d of days) {
    const h = (d.totalCost / max) * 100;
    const cls = d.date === todayDate ? 'now' : '';
    html += `<div class="bar ${cls}" style="height:${h.toFixed(1)}%" title="${escapeHtml(d.date)}: ${fmtUSD(d.totalCost)}"></div>`;
  }
  wrap.innerHTML = html;
  const labels = pickTicks(days.map((d) => d.date), 5);
  ticks.innerHTML = labels.map((l) => `<span>${escapeHtml(l)}</span>`).join('');
}

function renderPeakHours() {
  const data = state.data.hours;
  const wrap = document.getElementById('peak-chart');
  const meta = document.getElementById('peak-meta');
  meta.textContent = TZ_LABEL;
  if (!data) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    return;
  }
  const hours = utcHoursToLocal(data.hours);
  if (hours.every((h) => h.calls === 0)) {
    wrap.innerHTML = '<div class="empty" style="width:100%">no data</div>';
    return;
  }
  const max = Math.max(...hours.map((h) => h.calls), 1);
  wrap.innerHTML = hours
    .map((h) => {
      const pct = (h.calls / max) * 100;
      const hot = pct > 55;
      return `<div class="bar ${hot ? 'hot' : ''}" style="height:${Math.max(2, pct).toFixed(1)}%" title="${String(h.hour).padStart(2,'0')}:00 — ${h.calls} calls"></div>`;
    })
    .join('');
}

// ═══════════════════════════════════════════════════════════
//  Refresh: tables
// ═══════════════════════════════════════════════════════════
function renderProjectsTable() {
  const list = state.data.projects?.projects ?? [];
  document.getElementById('tab-badge-projects').textContent = String(list.length);
  const tb = document.getElementById('proj-body');
  const fullTb = document.getElementById('proj-full-body');
  document.getElementById('projects-count').textContent = `${list.length} project${list.length === 1 ? '' : 's'}`;

  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">no projects</td></tr>';
    fullTb.innerHTML = '<tr><td colspan="8" class="empty">no projects</td></tr>';
    return;
  }
  const max = Math.max(...list.map((p) => p.totalCost), 1);
  const rowFor = (p) => {
    const proj = p.project ?? '—';
    const slashIdx = proj.indexOf('/');
    const projHtml = slashIdx > 0
      ? `${escapeHtml(proj.slice(0, slashIdx))}<span class="slash">/</span>${escapeHtml(proj.slice(slashIdx + 1))}`
      : escapeHtml(proj);
    const pct = (p.totalCost / max) * 100;
    return `<tr>
      <td class="proj">${projHtml}</td>
      <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div></td>
      <td class="num">${escapeHtml(fmtUSD(p.totalCost))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.sessionCount))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.messageCount))}</td>
      <td class="num dim">${escapeHtml(fmtInt(p.toolCallCount))}</td>
      <td class="num dim">${escapeHtml(fmtTokens(p.totalTokens))}</td>
      <td class="num ${p.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(p.cacheHitRate, 0))}</td>
    </tr>`;
  };
  tb.innerHTML = list.slice(0, 6).map(rowFor).join('');
  fullTb.innerHTML = list.map(rowFor).join('');
}

function renderActivityTable() {
  const list = state.data.activity?.tasks ?? [];
  const tb = document.getElementById('act-body');
  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">no activity</td></tr>';
    return;
  }
  const total = list.reduce((s, x) => s + x.turns, 0);
  const colors = ['var(--act-1)', 'var(--act-2)', 'var(--act-3)', 'var(--act-4)', 'var(--act-5)', 'var(--act-6)', 'var(--act-7)', 'var(--act-8)'];
  tb.innerHTML = list
    .map((x, i) => {
      const c = colors[i] ?? colors[colors.length - 1];
      const pct = total === 0 ? 0 : (x.turns / total) * 100;
      return `<tr>
        <td><span class="dot" style="background:${c}"></span>${escapeHtml(x.category)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${c}"></div></div></td>
        <td class="num">${escapeHtml(fmtInt(x.turns))}</td>
        <td class="num dim-2">${escapeHtml(fmtPct(x.pctOfTotal, 1))}</td>
      </tr>`;
    })
    .join('');
}

function renderModelsTable() {
  const list = state.data.models?.models ?? [];
  const tb = document.getElementById('models-body');
  if (list.length === 0) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">no models</td></tr>';
    return;
  }
  const totalCost = list.reduce((s, m) => s + m.cost, 0) || 1;
  tb.innerHTML = list
    .map((m) => {
      const cls = modelClass(m.model);
      const c = modelColorVar(cls);
      const avg = m.turnCount > 0 ? m.cost / m.turnCount : null;
      const pct = (m.cost / totalCost) * 100;
      return `<tr>
        <td class="proj"><span class="dot" style="background:${c}"></span>${escapeHtml(m.model)}</td>
        <td><div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${c}"></div></div></td>
        <td class="num">${escapeHtml(fmtUSD(m.cost))}</td>
        <td class="num dim">${escapeHtml(fmtInt(m.turnCount))}</td>
        <td class="num ${m.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(m.cacheHitRate, 0))}</td>
        <td class="num dim">${avg == null ? '—' : escapeHtml(fmtUSD(avg))}</td>
      </tr>`;
    })
    .join('');
}

function renderSessionsTable() {
  const sessions = state.data.sessions;
  const expensive = state.data.expensive;
  if (!sessions) return;
  const all = sessions.sessions ?? [];
  const expensiveIds = new Set((expensive?.top ?? []).map((t) => t.sessionId));
  document.getElementById('tab-badge-sessions').textContent = String(all.length);
  document.getElementById('sessions-count').textContent =
    `${all.length} session${all.length === 1 ? '' : 's'}`;

  const sorted = [...all].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const rowFor = (s) => {
    const hot = expensiveIds.has(s.sessionId);
    const dur = s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : '—';
    const model = s.byModel?.[0]?.model ?? '—';
    const cls = modelClass(model);
    return `<tr>
      <td class="dim">${hot ? '<span class="hot-mark">★</span>' : ''}<span class="mono" style="font-size:11px">${escapeHtml(fmtTime(s.startedAt))}</span></td>
      <td class="proj">${escapeHtml(s.project ?? '—')}</td>
      <td class="proj model-color ${cls}" style="font-size:11px">${escapeHtml(model)}</td>
      <td><span class="tag">${escapeHtml(s.tasks?.primary ?? '—')}</span></td>
      <td class="num dim">${escapeHtml(dur)}</td>
      <td class="num dim">${escapeHtml(fmtInt(s.turnCount))}</td>
      <td class="num ${s.cacheHitRate > 0.7 ? 'ok' : 'dim'}">${escapeHtml(fmtPct(s.cacheHitRate, 0))}</td>
      <td class="num" style="font-weight:600">${escapeHtml(fmtUSD(s.cost))}</td>
    </tr>`;
  };
  // Full table: top 80 by recency (matches v0.3.x cap to avoid jank at 5000 rows)
  document.getElementById('sess-full-body').innerHTML = sorted.length
    ? sorted.slice(0, 80).map(rowFor).join('')
    : '<tr><td colspan="9" class="empty">no sessions in this period</td></tr>';
}

function renderToolLists() {
  const data = state.data.tools;
  function fill(key, items) {
    const wrap = document.getElementById(`${key}-tools`);
    if (!items || items.length === 0) {
      wrap.innerHTML = '<div class="empty">none</div>';
      return;
    }
    const max = Math.max(...items.map((x) => x.count), 1);
    wrap.innerHTML = items
      .slice(0, 12)
      .map((x) => {
        const pct = (x.count / max) * 100;
        return `<div class="tool-row">
          <span class="tool-name">${escapeHtml(x.name)}</span>
          <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="tool-count">${escapeHtml(fmtInt(x.count))}</span>
        </div>`;
      })
      .join('');
  }
  fill('core', data?.coreTools);
  fill('shell', data?.shellCommands);
  fill('mcp', data?.mcpServers);
}

// ═══════════════════════════════════════════════════════════
//  Settings tab — read-only mirror of /api/health + /api/usage
// ═══════════════════════════════════════════════════════════
function renderSettings() {
  const health = state.data.health;
  const usage = state.data.usage;
  if (health) {
    document.getElementById('set-port').value = String(health.pid ? location.port || 3456 : 3456);
    if (health.subscriptionCost != null) {
      document.getElementById('set-sub-cost').value = `$${Number(health.subscriptionCost).toFixed(2)}`;
    }
    if (health.pricing?.source) {
      const tag = document.getElementById('set-pricing-source');
      tag.textContent = health.pricing.source;
      tag.style.background = 'var(--ok-tint)';
      tag.style.color = 'var(--ok)';
    }
  }
  const syncTag = document.getElementById('set-sync-status');
  const lastSync = document.getElementById('set-last-sync');
  if (usage?.ingested) {
    const stale = Date.now() - Date.parse(usage.ingestedAt) > 10 * 60_000;
    syncTag.textContent = stale ? '● Stale' : '● Active';
    syncTag.style.background = stale ? 'var(--warn-tint)' : 'var(--ok-tint)';
    syncTag.style.color = stale ? 'var(--warn)' : 'var(--ok)';
    lastSync.textContent = new Date(usage.ingestedAt).toLocaleString();
  } else {
    syncTag.textContent = '○ Not connected';
    syncTag.style.background = 'var(--glass-2)';
    syncTag.style.color = 'var(--text-3)';
    lastSync.textContent = 'never';
  }
  // About version line — populate from /api/health.
  const aboutVersion = document.getElementById('set-about-version');
  if (aboutVersion && health?.version) aboutVersion.textContent = `v${health.version}`;
  initSettingsGeneralControls();
}

// Tauri 2 ACL: dashboard is loaded via WebviewUrl::External (HTTP), so
// custom invoke commands defined in src/ipc.rs are blocked with "Plugin not
// found". We call the underlying tauri-plugin-autostart and tauri-plugin-updater
// commands directly instead — those plugin permissions ARE listed in
// capabilities/main.json (autostart:allow-* and updater:default).
function getTauriInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
}

let settingsGeneralInitialized = false;

async function initSettingsGeneralControls() {
  const invoke = getTauriInvoke();
  const autoToggle = document.getElementById('set-autostart-toggle');
  const updatesBtn = document.getElementById('set-check-updates-btn');
  const updatesStatus = document.getElementById('set-updates-status');
  if (!autoToggle || !updatesBtn) return;

  if (!invoke) {
    // Browser mode (no Tauri host) — disable IPC-backed controls.
    autoToggle.disabled = true;
    autoToggle.title = 'Available in the desktop app';
    updatesBtn.disabled = true;
    updatesBtn.title = 'Available in the desktop app';
    if (updatesStatus) updatesStatus.textContent = 'desktop only';
    return;
  }

  try {
    autoToggle.checked = !!(await invoke('plugin:autostart|is_enabled'));
  } catch (err) {
    console.warn('autostart is_enabled failed; defaulting toggle off:', err);
    autoToggle.checked = false;
  }

  if (settingsGeneralInitialized) return;
  settingsGeneralInitialized = true;

  autoToggle.addEventListener('change', async () => {
    const desired = autoToggle.checked;
    try {
      await invoke(desired ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
    } catch (err) {
      console.error('autostart toggle failed; reverting:', err);
      autoToggle.checked = !desired;
    }
  });

  updatesBtn.addEventListener('click', async () => {
    if (updatesBtn.disabled) return;
    updatesBtn.disabled = true;
    if (updatesStatus) updatesStatus.textContent = 'Checking…';
    try {
      const update = await invoke('plugin:updater|check');
      if (updatesStatus) {
        updatesStatus.textContent = update && update.available
          ? `v${update.version} available — restart app to apply`
          : 'Up to date';
      }
    } catch (err) {
      console.error('updater check failed:', err);
      if (updatesStatus) updatesStatus.textContent = 'Check failed';
    } finally {
      updatesBtn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  Tab + period segmented control morphing indicator
// ═══════════════════════════════════════════════════════════
function moveIndicator(seg, indId) {
  const ind = document.getElementById(indId);
  const sel = seg.querySelector('[aria-selected="true"]');
  if (!sel || !ind) return;
  const segRect = seg.getBoundingClientRect();
  const r = sel.getBoundingClientRect();
  ind.style.left = (r.left - segRect.left) + 'px';
  ind.style.width = r.width + 'px';
}

function bindSegments() {
  const periodSeg = document.getElementById('period-seg');
  periodSeg.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      periodSeg.querySelectorAll('button').forEach((b) => b.removeAttribute('aria-selected'));
      btn.setAttribute('aria-selected', 'true');
      state.period = btn.dataset.period;
      moveIndicator(periodSeg, 'period-ind');
      refreshAll();
    });
  });

  const tabs = document.getElementById('tabs');
  function switchTab(name) {
    state.tab = name;
    tabs.querySelectorAll('button').forEach((b) => {
      b.removeAttribute('aria-selected');
      if (b.dataset.tab === name) b.setAttribute('aria-selected', 'true');
    });
    document.querySelectorAll('[data-panel]').forEach((p) => {
      p.hidden = p.dataset.panel !== name;
    });
    moveIndicator(tabs, 'tab-ind');
    if (name === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  tabs.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-jump]').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.jump));
  });

  // Settings sub-nav
  document.querySelectorAll('.set-side button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.set-side button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      document.querySelectorAll('[data-set-panel]').forEach((p) => {
        p.hidden = p.dataset.setPanel !== b.dataset.set;
      });
    });
  });

  // Native menu (tray right-click "Preferences…", App menu Settings, Cmd+,)
  // dispatches this event via webview.eval — switch to the Settings tab.
  window.addEventListener('show-settings', () => {
    const settingsBtn = document.querySelector('[data-tab="settings"]');
    if (settingsBtn) settingsBtn.click();
  });

  // Initialize indicator positions after layout settles. Two passes — once
  // immediately so the user sees something, once after fonts have loaded so
  // tab widths are correct on first paint.
  requestAnimationFrame(() => {
    moveIndicator(periodSeg, 'period-ind');
    moveIndicator(tabs, 'tab-ind');
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      moveIndicator(periodSeg, 'period-ind');
      moveIndicator(tabs, 'tab-ind');
    });
  }
  window.addEventListener('resize', () => {
    moveIndicator(periodSeg, 'period-ind');
    moveIndicator(tabs, 'tab-ind');
  });
}

// ═══════════════════════════════════════════════════════════
//  Export link
// ═══════════════════════════════════════════════════════════
function setExportLinks() {
  const params = new URLSearchParams({ period: state.period });
  document.getElementById('export-csv').setAttribute('href', `/api/export?format=csv&${params}`);
}

// ═══════════════════════════════════════════════════════════
//  Header version
// ═══════════════════════════════════════════════════════════
function renderHeaderMeta() {
  const v = state.data.health?.version ?? '0.4.0';
  document.getElementById('brand-meta').textContent = `v${v} · localhost:${location.port || 3456}`;
  document.getElementById('about-version').textContent = `v${v} · MIT · clauding-lab`;
  document.getElementById('foot-version').textContent = `v${v}`;
}

// ═══════════════════════════════════════════════════════════
//  Refresh orchestration (preserves v0.3.1 retry-with-backoff)
// ═══════════════════════════════════════════════════════════
async function refreshAll() {
  document.body.classList.add('loading');
  try {
    setExportLinks();
    const isToday = state.period === 'today';
    const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi] =
      await Promise.all([
        api('/api/health'),
        api('/api/summary', commonParams()),
        api('/api/cache', commonParams()),
        api('/api/sessions', commonParams()),
        api('/api/daily', commonParams()),
        // peak-hours panel always shows today's hour distribution; the
        // cost-over-time chart re-uses /api/hours when state.period === 'today'.
        api('/api/hours', commonParams()),
        api('/api/projects', commonParams()),
        api('/api/tasks', commonParams()),
        api('/api/tools', commonParams()),
        api('/api/models', commonParams()),
        api('/api/usage'),
        api('/api/sessions/expensive', { ...commonParams(), limit: 5 }),
        api('/api/roi', commonParams()),
      ]);

    state.data = { health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi };

    renderHeaderMeta();
    renderPlanCapacity();
    renderFinanceSide();
    renderMetricStrip();
    renderCostChart();
    renderPeakHours();
    renderProjectsTable();
    renderActivityTable();
    renderModelsTable();
    renderSessionsTable();
    renderToolLists();
    if (state.tab === 'settings') renderSettings();
    return true;
  } catch (err) {
    console.error('refreshAll failed', err);
    return false;
  } finally {
    document.body.classList.remove('loading');
  }
}

/**
 * Initial load helper (preserved from v0.3.1, Bug #5 fix / T32).
 *
 * The Tauri dashboard window opens before the SEA sidecar is guaranteed to
 * have parsed all JSONL files and bound its port (a 100–500ms race in v0.3.0
 * smoke testing). The first refreshAll() therefore frequently threw
 * `Failed to fetch`, the dashboard stayed blank, and the user had to manually
 * reload.
 *
 * Strategy: keep retrying initial load with exponential backoff
 * (300ms, 600ms, 1.2s, 2.4s, capped at 4s) for up to 30s. Once the first
 * refresh succeeds, switch to the normal user-driven model. Subsequent
 * user-triggered refreshes (period switch, refresh button) DO NOT retry —
 * the user would rather see an obvious empty state than a silently-frozen UI.
 */
async function initialLoad() {
  const MAX_TOTAL_MS = 30_000;
  const start = Date.now();
  let delay = 300;
  while (true) {
    const ok = await refreshAll();
    if (ok) {
      // (Stripped success-log: DevTools ships in v0.4.0, but routine
      // success messages were just noise. Failures still warn below.)
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= MAX_TOTAL_MS) {
      console.warn(
        `[Clauge] Dashboard could not reach the API after ${Math.round(elapsed / 1000)}s. ` +
        'Check that clauge-server is running on the expected port.'
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(Math.round(delay * 2), 4_000);
  }
}

// ═══════════════════════════════════════════════════════════
//  Boot
// ═══════════════════════════════════════════════════════════
function bindControls() {
  document.getElementById('btn-refresh').addEventListener('click', () => {
    refreshAll();
  });
  // Reuse the sync settings button as a manual-refresh shortcut.
  const syncRefresh = document.getElementById('set-sync-refresh');
  if (syncRefresh) {
    syncRefresh.addEventListener('click', () => refreshAll());
  }
}

bindSegments();
bindControls();
initialLoad();

// Auto-refresh the plan-usage card every 60s — picks up new bookmarklet/
// extension ingest without a full dashboard refresh.
setInterval(async () => {
  try {
    state.data.usage = await api('/api/usage');
    renderPlanCapacity();
    renderFinanceSide();
    if (state.tab === 'settings') renderSettings();
  } catch (err) {
    console.error('plan auto-refresh', err);
  }
}, 60_000);
