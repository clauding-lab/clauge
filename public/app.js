// Clauge V2.1 dashboard — warm-dark palette, hero metric, denser layout.
// Vanilla JS, no build step, no Chart.js — all sparklines and bar charts
// rendered as inline SVG / CSS.

const state = { period: '7d', project: '' };

const PERIOD_LABELS = {
  today: 'Today',
  '7d': '7d',
  '30d': '30d',
  month: 'Month',
  all: 'All',
};

// ─── formatters ───────────────────────────────────────────
const fmtUSD = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(n);
const fmtUSDLong = fmtUSD;

const fmtInt = (n) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n));

const fmtPct = (frac, digits = 0) =>
  frac == null ? '—' : `${(frac * 100).toFixed(digits)}%`;

const fmtTokens = (n) => {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
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
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `in ${d}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m % 60}m`;
  return `in ${m}m`;
};

// ─── api ──────────────────────────────────────────────────
async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}
function commonParams() {
  const p = { period: state.period };
  if (state.project) p.project = state.project;
  return p;
}

// ─── helpers ──────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function totalTokensOf(t) {
  return (
    (t?.inputTokens || 0) +
    (t?.outputTokens || 0) +
    (t?.cacheRead || 0) +
    (t?.cacheCreate5m || 0) +
    (t?.cacheCreate1h || 0)
  );
}

function modelClass(model) {
  if (!model) return '';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return '';
}

// ─── inline SVG sparklines ────────────────────────────────
function pathFor(values, w, h, padX = 0, padY = 2) {
  if (!values || values.length === 0) return { line: '', area: '' };
  const max = Math.max(...values, 1);
  const min = Math.min(0, ...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? (w - padX * 2) / (values.length - 1) : w;
  const pts = values.map((v, i) => {
    const x = padX + i * stepX;
    const y = h - padY - ((v - min) / range) * (h - padY * 2);
    return [x, y];
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
  const area = `${line} L${(padX + (values.length - 1) * stepX).toFixed(2)},${h} L${padX},${h} Z`;
  return { line, area };
}

function renderSpark(svg, values, opts = {}) {
  if (!svg) return;
  const w = Number(svg.getAttribute('viewBox')?.split(' ')[2] ?? 100);
  const h = Number(svg.getAttribute('viewBox')?.split(' ')[3] ?? 28);
  const color = opts.color ?? 'var(--brand)';
  const fillOn = opts.fill !== false;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!values || values.length === 0) return;
  const ns = 'http://www.w3.org/2000/svg';
  const id = 'sp_' + Math.random().toString(36).slice(2, 8);
  const { line, area } = pathFor(values, w, h);

  if (fillOn) {
    const defs = document.createElementNS(ns, 'defs');
    const grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', id);
    grad.setAttribute('x1', '0');
    grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0');
    grad.setAttribute('y2', '1');
    const s1 = document.createElementNS(ns, 'stop');
    s1.setAttribute('offset', '0%');
    s1.setAttribute('stop-color', color);
    s1.setAttribute('stop-opacity', '0.35');
    const s2 = document.createElementNS(ns, 'stop');
    s2.setAttribute('offset', '100%');
    s2.setAttribute('stop-color', color);
    s2.setAttribute('stop-opacity', '0');
    grad.appendChild(s1);
    grad.appendChild(s2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const ap = document.createElementNS(ns, 'path');
    ap.setAttribute('d', area);
    ap.setAttribute('fill', `url(#${id})`);
    svg.appendChild(ap);
  }

  const lp = document.createElementNS(ns, 'path');
  lp.setAttribute('d', line);
  lp.setAttribute('fill', 'none');
  lp.setAttribute('stroke', color);
  lp.setAttribute('stroke-width', '1.4');
  lp.setAttribute('stroke-linecap', 'round');
  lp.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(lp);
}

// ─── ring gauge for plan card ─────────────────────────────
function gaugeColor(pct) {
  if (pct == null) return 'var(--ok)';
  if (pct >= 85) return 'var(--crit)';
  if (pct >= 60) return 'var(--warn)';
  return 'var(--brand)';
}

function gaugeHtml({ label, sub, metric }) {
  if (!metric) return '';
  const pct = metric.pct;
  const r = 38;
  const c = 2 * Math.PI * r;
  const dash = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100 * c;
  const color = gaugeColor(pct);
  const reset = fmtRelative(metric.resetsAt);
  return `
    <div class="gauge">
      <div class="ring-wrap">
        <svg viewBox="0 0 92 92">
          <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="8"/>
          <circle cx="46" cy="46" r="${r}" fill="none"
            stroke="${color}" stroke-width="8" stroke-linecap="round"
            stroke-dasharray="${dash} ${c - dash}" />
        </svg>
        <div class="ring-text">
          <span class="ring-pct">
            ${pct == null ? '—' : Math.round(pct) + '<span class="pct-sign">%</span>'}
          </span>
          <span class="ring-sub">${escapeHtml(sub ?? '')}</span>
        </div>
      </div>
      <div class="ring-label-block">
        <div class="ring-label">${escapeHtml(label)}</div>
        <div class="ring-reset">${escapeHtml(reset || '')}</div>
      </div>
    </div>`;
}

// ─── plan card ────────────────────────────────────────────
async function refreshPlanUsage() {
  const data = await api('/api/usage');
  const status = document.getElementById('plan-status');
  const updated = document.getElementById('plan-updated');
  const grid = document.getElementById('plan-grid');
  const onboard = document.getElementById('plan-onboard');
  const syncPill = document.getElementById('sync-pill');
  const syncText = document.getElementById('sync-pill-text');

  if (!data.ingested) {
    status.textContent = 'Not synced — install the auto-sync extension below';
    updated.textContent = '';
    grid.innerHTML = '';
    onboard.hidden = false;
    syncPill.className = 'sync-pill off';
    syncText.textContent = 'not synced';
    await renderInstallPanel();
    return;
  }

  const isStale = Date.now() - Date.parse(data.ingestedAt) > 10 * 60_000;
  syncPill.className = `sync-pill ${isStale ? 'stale' : ''}`;
  syncText.textContent = isStale ? `stale · ${fmtAgo(data.ingestedAt)}` : `synced ${fmtAgo(data.ingestedAt)}`;

  status.textContent = data.org?.name ? data.org.name : 'synced';
  updated.textContent = `updated ${fmtAgo(data.ingestedAt)}`;

  const plan = data.plan ?? {};
  const gaugeDefs = [
    { label: 'Session', sub: '5h', metric: plan.fiveHour },
    { label: 'Weekly all', sub: '7d', metric: plan.sevenDay },
    { label: 'Sonnet', sub: '7d', metric: plan.sevenDaySonnet },
    { label: 'Opus', sub: '7d', metric: plan.sevenDayOpus },
    { label: 'Design', sub: '7d', metric: plan.sevenDayOmelette },
  ].filter((g) => g.metric);

  let html = gaugeDefs.map(gaugeHtml).join('');
  if (plan.extraUsage && plan.extraUsage.enabled) {
    const e = plan.extraUsage;
    // claude.ai returns utilization=null when extra_usage is at $0 — compute it
    // from used/limit so the cap-percent line and bar always have a value.
    let computedPct = e.pct;
    if (computedPct == null && e.limitDollars && Number.isFinite(e.limitDollars) && e.limitDollars > 0) {
      computedPct = ((e.usedDollars ?? 0) / e.limitDollars) * 100;
    }
    const pct = Math.max(0, Math.min(100, computedPct ?? 0));
    html += `
      <div class="extra-usage-cell">
        <div class="lbl">Extra usage</div>
        <div class="row">
          <span class="val">${fmtUSD(e.usedDollars)}</span>
          <span class="cap">of ${fmtUSD(e.limitDollars)}</span>
        </div>
        <div style="margin-top: 10px;">
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="foot">
          <span>${computedPct == null ? '—' : computedPct.toFixed(1) + '%'} of cap</span>
          <span>${e.currency || 'USD'}</span>
        </div>
      </div>`;
  } else {
    html += `<div class="extra-usage-cell" style="opacity:.5">
      <div class="lbl">Extra usage</div>
      <div class="row" style="margin-top:6px"><span class="val mono" style="font-size:14px;color:var(--text-3)">none configured</span></div>
    </div>`;
  }

  // claude.ai current balance (the consumer-app balance — endpoint TBD)
  const claudeBal = plan.claudeBalance;
  if (claudeBal && claudeBal.currentBalance != null) {
    html += `
      <div class="balance-cell claude-balance">
        <span class="lbl">claude.ai balance</span>
        <span class="val">${fmtUSD(claudeBal.currentBalance)}</span>
        <div class="meta">
          <span>${escapeHtml(claudeBal.currency || 'USD')}</span>
        </div>
      </div>`;
  } else {
    html += `
      <div class="balance-cell claude-balance empty">
        <span class="lbl">claude.ai balance</span>
        <span class="val">—</span>
        <div class="meta">
          <span>endpoint not yet identified</span>
        </div>
      </div>`;
  }

  // API console balance (console.anthropic.com prepaid credits)
  const bal = plan.balance;
  if (bal && bal.currentBalance != null) {
    const reloadCls = bal.autoReloadEnabled ? 'reload-on' : 'reload-off';
    const reloadTxt = bal.autoReloadEnabled ? `auto-reload ${fmtUSD(bal.autoReloadAmount)}` : 'auto-reload off';
    html += `
      <div class="balance-cell api-balance">
        <span class="lbl">API console balance</span>
        <span class="val">${fmtUSD(bal.currentBalance)}</span>
        <div class="meta">
          <span class="${reloadCls}">${escapeHtml(reloadTxt)}</span>
          <span>${escapeHtml(bal.currency || 'USD')}</span>
        </div>
      </div>`;
  } else {
    html += `
      <div class="balance-cell api-balance empty">
        <span class="lbl">API console balance</span>
        <span class="val">—</span>
        <div class="meta">
          <span>platform.claude.com not connected</span>
        </div>
      </div>`;
  }
  grid.innerHTML = html;

  onboard.hidden = !isStale;
  if (!onboard.hidden) await renderInstallPanel();
}

// ─── install panel ────────────────────────────────────────
const CWS_URL = '';
let _installPanelReady = false;
async function renderInstallPanel() {
  if (_installPanelReady) return;
  const installBtn = document.getElementById('install-extension');
  const installMeta = document.getElementById('install-meta');
  if (CWS_URL) {
    installBtn.setAttribute('href', CWS_URL);
    installBtn.setAttribute('target', '_blank');
    installMeta.textContent = 'Chrome Web Store';
  } else {
    installMeta.textContent = 'see install options below';
    installBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const details = document.querySelector('.plan-alternates');
      if (details) {
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }
  const link = document.getElementById('bookmarklet-link');
  if (link) {
    const data = await api('/api/bookmarklet');
    link.setAttribute('href', data.href);
  }
  _installPanelReady = true;
}

// ─── headline ─────────────────────────────────────────────
async function refreshHeadline() {
  const isToday = state.period === 'today';
  const [summary, cache, sessions, daily, hours] = await Promise.all([
    api('/api/summary', commonParams()),
    api('/api/cache', commonParams()),
    api('/api/sessions', commonParams()),
    api('/api/daily', commonParams()),
    isToday ? api('/api/hours', commonParams()) : Promise.resolve(null),
  ]);

  // Hero
  const roi = await api('/api/roi', commonParams());
  document.getElementById('hero-cost').textContent = fmtUSD(summary.cost);
  document.getElementById('hero-period').textContent = PERIOD_LABELS[state.period] ?? state.period;
  document.getElementById('hero-sub-cost').textContent = `${fmtUSD(roi.subscriptionCost)}/mo`;
  document.getElementById('hero-net-savings').textContent =
    cache.netSavingsUSD != null
      ? ` Net cache savings ${fmtUSD(cache.netSavingsUSD)}.`
      : '';

  // Hero spark — hourly when 'today', else daily
  const heroSeries = isToday
    ? (hours?.hours ?? []).map((h) => h.cost)
    : daily.days.map((d) => d.totalCost);
  renderSpark(document.getElementById('hero-spark'), heroSeries);
  document.getElementById('hero-spark-start').textContent = isToday
    ? '00:00'
    : (daily.days[0]?.date ?? 'start');

  // Secondary: messages / sessions / cache hit
  document.getElementById('sec-messages').textContent = fmtInt(summary.messageCount);
  document.getElementById('sec-messages-sub').textContent =
    `${fmtInt(summary.toolCallCount)} tool calls`;
  renderSpark(
    document.querySelector('[data-spark="messages"]'),
    daily.days.map((d) => d.sessionCount),
    { color: 'var(--text-3)', fill: false }
  );

  document.getElementById('sec-sessions').textContent = fmtInt(summary.sessionCount);
  document.getElementById('sec-sessions-sub').textContent =
    `${fmtInt(summary.subagentTurnCount)} subagents`;
  renderSpark(
    document.querySelector('[data-spark="sessions"]'),
    daily.days.map((d) => d.sessionCount),
    { color: 'var(--text-3)', fill: false }
  );

  document.getElementById('sec-cachehit').textContent = fmtPct(cache.hitRate, 1);
  document.getElementById('sec-cachehit-sub').textContent =
    `${fmtTokens(summary.tokens.cacheRead)} cached reads`;
  renderSpark(
    document.querySelector('[data-spark="cachehit"]'),
    cache.dailyTrend.map((d) => (d.hitRate ?? 0) * 100),
    { color: 'var(--ok)' }
  );

  // Token tier breakdown
  const tk = summary.tokens || {};
  document.querySelector('[data-tok="input"]').textContent = fmtTokens(tk.inputTokens);
  document.querySelector('[data-tok="output"]').textContent = fmtTokens(tk.outputTokens);
  document.querySelector('[data-tok="cacheRead"]').textContent = fmtTokens(tk.cacheRead);
  document.querySelector('[data-tok="cache5m"]').textContent = fmtTokens(tk.cacheCreate5m);
  document.querySelector('[data-tok="cache1h"]').textContent = fmtTokens(tk.cacheCreate1h);
  document.querySelector('[data-tok="netSavings"]').textContent = fmtUSD(cache.netSavingsUSD);

  return { sessions, daily, hours, isToday };
}

// ─── cost over time chart (daily or hourly) ───────────────
function renderCostChart({ daily, hours, isToday }) {
  const wrap = document.getElementById('daily-chart');
  const ticks = document.getElementById('daily-ticks');
  const meta = document.getElementById('daily-meta');

  if (isToday) {
    const list = utcHoursToLocal(hours?.hours);
    meta.textContent = `24 hours (${TZ_LABEL})`;
    if (list.every((h) => h.cost === 0)) {
      wrap.innerHTML = `<div class="empty" style="width:100%">no data</div>`;
      ticks.innerHTML = '';
      return;
    }
    const max = Math.max(...list.map((h) => h.cost), 0.0001);
    const nowHour = new Date().getHours();
    let html = '<div class="gridlines"><div></div><div></div><div></div><div></div></div>';
    for (const h of list) {
      const heightPct = (h.cost / max) * 100;
      const cls = h.hour === nowHour ? 'now' : h.hour > nowHour ? 'future' : '';
      html += `
        <div class="bar-col ${cls}" title="${String(h.hour).padStart(2,'0')}:00 ${TZ_LABEL} — ${fmtUSDLong(h.cost)}">
          <div class="bar" style="height:${Math.max(heightPct, 0.5).toFixed(1)}%"></div>
        </div>`;
    }
    wrap.innerHTML = html;
    ticks.innerHTML = `
      <span style="flex:1;text-align:left">00</span>
      <span style="flex:1;text-align:center">06</span>
      <span style="flex:1;text-align:center">12</span>
      <span style="flex:1;text-align:center">18</span>
      <span style="flex:1;text-align:right">23</span>`;
    return;
  }

  const days = daily.days ?? [];
  meta.textContent = `${days.length} day${days.length === 1 ? '' : 's'}`;
  if (days.length === 0) {
    wrap.innerHTML = `<div class="empty" style="width:100%">no data</div>`;
    ticks.innerHTML = '';
    return;
  }
  const max = Math.max(...days.map((d) => d.totalCost), 1);
  const todayDate = new Date().toISOString().slice(0, 10);
  let html = '<div class="gridlines"><div></div><div></div><div></div><div></div></div>';
  for (const d of days) {
    const h = (d.totalCost / max) * 100;
    const cls = d.date === todayDate ? 'now' : '';
    html += `
      <div class="bar-col ${cls}" title="${d.date}: ${fmtUSDLong(d.totalCost)}">
        <div class="bar" style="height:${h.toFixed(1)}%"></div>
      </div>`;
  }
  wrap.innerHTML = html;
  const tickLabels = pickTicks(days.map((d) => d.date), 5);
  ticks.innerHTML = tickLabels
    .map((t) => `<span style="flex:1;text-align:${t.align}">${escapeHtml(t.label)}</span>`)
    .join('');
}

function pickTicks(labels, count) {
  if (labels.length === 0) return [];
  if (labels.length <= count) {
    return labels.map((l, i) => ({
      label: shortDate(l),
      align: i === 0 ? 'left' : i === labels.length - 1 ? 'right' : 'center',
    }));
  }
  const step = (labels.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const idx = Math.round(i * step);
    return {
      label: shortDate(labels[idx]),
      align: i === 0 ? 'left' : i === count - 1 ? 'right' : 'center',
    };
  });
}

function shortDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return m && d ? `${m}/${d}` : iso;
}

// ─── timezone helpers ────────────────────────────────────
// /api/hours returns 24 buckets indexed by UTC hour. Remap to the user's
// local timezone so the chart's hour-0 column = user's local midnight.
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

const TZ_LABEL = (() => {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z || 'local';
  } catch {
    return 'local';
  }
})();

// ─── peak hours ───────────────────────────────────────────
async function refreshPeakHours() {
  const data = await api('/api/hours', commonParams());
  const hours = utcHoursToLocal(data.hours);
  const wrap = document.getElementById('peak-chart');
  const sub = document.getElementById('peak-sub');
  if (sub) sub.textContent = `distribution by hour (${TZ_LABEL})`;
  if (hours.length === 0 || hours.every((h) => h.calls === 0)) {
    wrap.innerHTML = `<div class="empty" style="width:100%">no data</div>`;
    return;
  }
  const max = Math.max(...hours.map((h) => h.calls), 1);
  wrap.innerHTML = hours
    .map((h) => {
      const pct = (h.calls / max) * 100;
      const isPeak = pct > 70;
      return `<div class="pcol ${isPeak ? 'peak' : ''}" style="height:${Math.max(3, pct)}%" title="${String(h.hour).padStart(2,'0')}:00 ${TZ_LABEL} — ${h.calls} calls"></div>`;
    })
    .join('');
}

// ─── tables ───────────────────────────────────────────────
function barCellHtml(value, max, color) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<td class="bar-cell">
    <div class="bar-track">
      <div class="bar-fill" style="width:${pct.toFixed(1)}%${color ? `;background:${color}` : ''}"></div>
    </div>
  </td>`;
}

async function refreshProjectsTable() {
  const data = await api('/api/projects', commonParams());
  const list = data.projects ?? [];
  const tb = document.querySelector('[data-tbl="projects"] tbody');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="8" class="empty">no projects</td></tr>`;
    return;
  }
  const max = Math.max(...list.map((p) => p.totalCost), 1);
  tb.innerHTML = list
    .map((p) => `<tr>
      <td class="mono">${escapeHtml(p.project ?? '—')}</td>
      ${barCellHtml(p.totalCost, max)}
      <td class="num">${fmtUSDLong(p.totalCost)}</td>
      <td class="num muted">${fmtInt(p.sessionCount)}</td>
      <td class="num muted">${fmtInt(p.messageCount)}</td>
      <td class="num muted">${fmtInt(p.toolCallCount)}</td>
      <td class="num muted">${fmtTokens(p.totalTokens)}</td>
      <td class="num ${p.cacheHitRate > 0.7 ? 'ok' : 'muted'}">${fmtPct(p.cacheHitRate, 0)}</td>
    </tr>`)
    .join('');
}

const ACT_COLORS = [
  'var(--act-1)', 'var(--act-2)', 'var(--act-3)', 'var(--act-4)',
  'var(--act-5)', 'var(--act-6)', 'var(--act-7)', 'var(--act-8)',
];

async function refreshActivityTable() {
  const data = await api('/api/tasks', commonParams());
  const list = data.tasks ?? [];
  const tb = document.querySelector('[data-tbl="activity"] tbody');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="4" class="empty">no activity</td></tr>`;
    return;
  }
  const total = list.reduce((s, x) => s + x.turns, 0);
  tb.innerHTML = list
    .map((x, i) => {
      const color = ACT_COLORS[i] ?? 'var(--act-8)';
      const pct = total === 0 ? 0 : (x.turns / total) * 100;
      return `<tr>
        <td><span class="dot-tag" style="background:${color}"></span>${escapeHtml(x.category)}</td>
        <td class="bar-cell-thin">
          <div class="bar-track" style="height:4px">
            <div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
          </div>
        </td>
        <td class="num">${fmtInt(x.turns)}</td>
        <td class="num muted">${fmtPct(x.pctOfTotal, 1)}</td>
      </tr>`;
    })
    .join('');
}

async function refreshModelsTable() {
  const data = await api('/api/models', commonParams());
  const list = data.models ?? [];
  const tb = document.querySelector('[data-tbl="models"] tbody');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="5" class="empty">no models</td></tr>`;
    return;
  }
  const totalCost = list.reduce((s, m) => s + m.cost, 0) || 1;
  tb.innerHTML = list
    .map((m) => {
      const cls = modelClass(m.model);
      const color = cls === 'opus' ? 'var(--opus)' : cls === 'haiku' ? 'var(--haiku)' : 'var(--sonnet)';
      return `<tr>
        <td class="mono"><span class="dot-tag" style="background:${color}"></span>${escapeHtml(m.model)}</td>
        ${barCellHtml(m.cost, totalCost, color)}
        <td class="num">${fmtUSDLong(m.cost)}</td>
        <td class="num muted">${fmtInt(m.turnCount)}</td>
        <td class="num muted">${fmtPct(m.cacheHitRate, 0)}</td>
      </tr>`;
    })
    .join('');
}

async function refreshSessionsTable(sessions) {
  const tb = document.querySelector('[data-tbl="sessions"] tbody');
  const expensive = await api('/api/sessions/expensive', { ...commonParams(), limit: 5 });
  const expensiveIds = new Set(expensive.top.map((t) => t.sessionId));
  document.getElementById('sessions-count').textContent =
    `${sessions.count} session${sessions.count === 1 ? '' : 's'}`;
  const sorted = [...sessions.sessions].sort((a, b) =>
    (b.startedAt || '').localeCompare(a.startedAt || '')
  );
  const top = sorted.slice(0, 80);
  if (top.length === 0) {
    tb.innerHTML = `<tr><td colspan="9" class="empty">no sessions in this period</td></tr>`;
    return;
  }
  tb.innerHTML = top
    .map((s) => {
      const hot = expensiveIds.has(s.sessionId);
      const dur = s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : '—';
      const model = s.byModel?.[0]?.model ?? '—';
      const cls = modelClass(model);
      return `<tr>
        <td class="muted mono">${hot ? '<span class="hot-mark">★</span>' : ''}${escapeHtml(fmtTime(s.startedAt))}</td>
        <td class="mono">${escapeHtml(s.project ?? '—')}</td>
        <td class="mono model-color ${cls}">${escapeHtml(model)}</td>
        <td><span class="task-pill">${escapeHtml(s.tasks?.primary ?? '—')}</span></td>
        <td class="num muted">${dur}</td>
        <td class="num muted">${fmtInt(s.turnCount)}</td>
        <td class="num muted">${fmtTokens(totalTokensOf(s.tokens))}</td>
        <td class="num ${s.cacheHitRate > 0.7 ? 'ok' : 'muted'}">${fmtPct(s.cacheHitRate, 0)}</td>
        <td class="num" style="font-weight:600">${fmtUSDLong(s.cost)}</td>
      </tr>`;
    })
    .join('');
}

// ─── tool lists ──────────────────────────────────────────
async function refreshToolLists() {
  const data = await api('/api/tools', commonParams());
  function fill(key, items) {
    const wrap = document.querySelector(`[data-tools="${key}"]`);
    if (!items || items.length === 0) {
      wrap.innerHTML = `<div class="empty">none</div>`;
      return;
    }
    const max = Math.max(...items.map((x) => x.count), 1);
    wrap.innerHTML = items
      .slice(0, 12)
      .map((x) => {
        const pct = (x.count / max) * 100;
        return `<div class="tool-row">
          <span class="name">${escapeHtml(x.name)}</span>
          <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <span class="calls">${fmtInt(x.count)}</span>
        </div>`;
      })
      .join('');
  }
  fill('core', data.coreTools);
  fill('shell', data.shellCommands);
  fill('mcp', data.mcpServers);
}

// ─── exports ─────────────────────────────────────────────
function setExportLinks() {
  const params = new URLSearchParams({ period: state.period });
  if (state.project) params.set('project', state.project);
  document.getElementById('export-csv').setAttribute('href', `/api/export?format=csv&${params}`);
  document.getElementById('export-json').setAttribute('href', `/api/export?format=json&${params}`);
}

// ─── orchestrate ─────────────────────────────────────────
async function refreshAll() {
  document.body.classList.add('loading');
  try {
    setExportLinks();
    const headlinePack = await refreshHeadline();
    await Promise.all([
      refreshPlanUsage(),
      refreshPeakHours(),
      refreshProjectsTable(),
      refreshActivityTable(),
      refreshModelsTable(),
      refreshToolLists(),
      refreshSessionsTable(headlinePack.sessions),
    ]);
    renderCostChart(headlinePack);
  } catch (err) {
    console.error('refreshAll failed', err);
  } finally {
    document.body.classList.remove('loading');
  }
}

function bindControls() {
  for (const btn of document.querySelectorAll('.period-switcher button')) {
    btn.addEventListener('click', () => {
      for (const b of document.querySelectorAll('.period-switcher button'))
        b.removeAttribute('aria-selected');
      btn.setAttribute('aria-selected', 'true');
      state.period = btn.dataset.period;
      refreshAll();
    });
  }
  let tmr;
  document.getElementById('project-filter').addEventListener('input', (e) => {
    clearTimeout(tmr);
    tmr = setTimeout(() => {
      state.project = e.target.value.trim();
      refreshAll();
    }, 220);
  });
}

bindControls();
refreshAll();

// Auto-refresh the plan-usage card every 60s.
setInterval(() => {
  refreshPlanUsage().catch((err) => console.error('plan refresh', err));
}, 60_000);
