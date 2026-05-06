// Clauge dashboard — V1.1 dense grid

const state = { period: '7d', project: '' };

// ─── formatters ───────────────────────────────────────────
const fmtUSD = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(n);

// Detail formatter — same 0-decimal rule for the dashboard. CSV/JSON
// exports keep full precision (see lib/exporter.js).
const fmtUSDLong = fmtUSD;

const fmtInt = (n) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n));

const fmtPct = (frac, digits = 1) =>
  frac == null ? '—' : `${(frac * 100).toFixed(digits)}%`;

const fmtTokens = (n) => {
  if (n == null) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
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

// ─── chart instances ──────────────────────────────────────
let dailyChart, hoursChart;

const COLORS = {
  opus: '#a78bfa',
  sonnet: '#378add',
  haiku: '#34c759',
  unknown: '#6c7787',
};
const colorFor = (model) => {
  if (!model) return COLORS.unknown;
  if (model.includes('opus')) return COLORS.opus;
  if (model.includes('sonnet')) return COLORS.sonnet;
  if (model.includes('haiku')) return COLORS.haiku;
  return COLORS.unknown;
};
const modelClassFor = (m) => {
  if (!m) return '';
  if (m.includes('opus')) return 'model-opus';
  if (m.includes('sonnet')) return 'model-sonnet';
  if (m.includes('haiku')) return 'model-haiku';
  return '';
};

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

function setHl(key, value) {
  const el = document.querySelector(`[data-hl="${key}"]`);
  if (el) el.textContent = value;
}

function tbody(name) {
  return document.querySelector(`[data-tbl="${name}"] tbody`);
}

function barCell(value, max, opts = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) * 100 : 0;
  const cls = opts.modelClass ? `bar-fill ${opts.modelClass}` : 'bar-fill';
  const cellClass = opts.subtle ? 'bar-cell subtle' : 'bar-cell';
  return `<td class="${cellClass}">
    <div class="bar-track"><div class="${cls}" style="width:${pct.toFixed(2)}%"></div></div>
  </td>`;
}

// ─── sparklines (SVG) ─────────────────────────────────────
function renderSparkline(svg, values, opts = {}) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (!values || values.length === 0) return;
  const W = 120, H = 32, P = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = (W - P * 2) / Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = P + i * step;
    const y = H - P - ((v - min) / range) * (H - P * 2);
    return [x, y];
  });
  const ns = 'http://www.w3.org/2000/svg';
  const stroke = opts.color || '#ff9500';
  const fill = opts.fill || 'rgba(255, 149, 0, 0.10)';

  const path = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${path} L${P + (values.length - 1) * step},${H} L${P},${H} Z`;

  const areaEl = document.createElementNS(ns, 'path');
  areaEl.setAttribute('d', area);
  areaEl.setAttribute('fill', fill);
  areaEl.setAttribute('stroke', 'none');
  svg.appendChild(areaEl);

  const lineEl = document.createElementNS(ns, 'path');
  lineEl.setAttribute('d', path);
  lineEl.setAttribute('fill', 'none');
  lineEl.setAttribute('stroke', stroke);
  lineEl.setAttribute('stroke-width', '1.5');
  lineEl.setAttribute('stroke-linecap', 'round');
  lineEl.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(lineEl);
}

// ─── refresh sections ─────────────────────────────────────

async function refreshHeadline() {
  const [summary, cache, sessions] = await Promise.all([
    api('/api/summary', commonParams()),
    api('/api/cache', commonParams()),
    api('/api/sessions', commonParams()),
  ]);
  setHl('cost', fmtUSD(summary.cost));
  setHl('messages', fmtInt(summary.messageCount));
  setHl('toolCalls', fmtInt(summary.toolCallCount));
  setHl('sessions', fmtInt(summary.sessionCount));
  setHl('subagents', fmtInt(summary.subagentTurnCount));
  setHl('cacheHit', fmtPct(cache.hitRate));
  setHl('totalTokens', fmtTokens(summary.totalTokens));
  if (summary.primaryModel) {
    setHl('primaryModelLabel', summary.primaryModel.replace('claude-', ''));
    setHl('primaryModel', `${fmtTokens(summary.primaryModelTokens)} tokens`);
  } else {
    setHl('primaryModelLabel', 'Primary model');
    setHl('primaryModel', '—');
  }
  setHl('inputTokens', fmtTokens(summary.tokens.inputTokens));
  setHl('outputTokens', fmtTokens(summary.tokens.outputTokens));
  setHl('cacheRead', fmtTokens(summary.tokens.cacheRead));
  setHl('cache5m', fmtTokens(summary.tokens.cacheCreate5m));
  setHl('cache1h', fmtTokens(summary.tokens.cacheCreate1h));
  setHl('netCacheSavings', fmtUSD(cache.netSavingsUSD));
  return { sessions, summary, cache };
}

async function refreshSparklines(daily) {
  const days = daily.days;
  const dailyCost = days.map((d) => d.totalCost);
  const dailyCalls = days.map((d) => d.sessionCount); // approx — could be turn count if exposed
  const dailySessions = days.map((d) => d.sessionCount);
  const cacheTrend = await api('/api/cache', commonParams());
  const dailyHit = cacheTrend.dailyTrend.map((d) => (d.hitRate ?? 0) * 100);

  const avgCost = dailyCost.length === 0 ? 0 : dailyCost.reduce((a, b) => a + b, 0) / dailyCost.length;
  const avgCalls = dailyCalls.length === 0 ? 0 : Math.round(dailyCalls.reduce((a, b) => a + b, 0) / dailyCalls.length);
  const avgSessions = avgCalls;
  const avgHit = dailyHit.length === 0 ? 0 : dailyHit.reduce((a, b) => a + b, 0) / dailyHit.length;

  document.querySelector('[data-spark="cost"] [data-spark-value]').textContent = fmtUSD(avgCost);
  document.querySelector('[data-spark="calls"] [data-spark-value]').textContent = fmtInt(avgCalls);
  document.querySelector('[data-spark="sessions"] [data-spark-value]').textContent = fmtInt(avgSessions);
  document.querySelector('[data-spark="hitRate"] [data-spark-value]').textContent = `${avgHit.toFixed(1)}%`;

  renderSparkline(document.querySelector('[data-spark="cost"] svg'), dailyCost, { color: '#ff9500', fill: 'rgba(255,149,0,0.12)' });
  renderSparkline(document.querySelector('[data-spark="calls"] svg'), dailyCalls, { color: '#378add', fill: 'rgba(55,138,221,0.12)' });
  renderSparkline(document.querySelector('[data-spark="sessions"] svg'), dailySessions, { color: '#a78bfa', fill: 'rgba(167,139,250,0.12)' });
  renderSparkline(document.querySelector('[data-spark="hitRate"] svg'), dailyHit, { color: '#34c759', fill: 'rgba(52,199,89,0.12)' });
}

async function refreshRoi(cacheStats) {
  const roi = await api('/api/roi', commonParams());
  document.getElementById('roi-replacement').textContent = fmtUSD(roi.apiReplacementValue);
  document.getElementById('roi-subscription').textContent = fmtUSD(roi.subscriptionCost);
  document.getElementById('roi-api').textContent = fmtUSD(roi.apiEquivalentSpend);
  document.getElementById('roi-cache-savings').textContent = fmtUSD(cacheStats.netSavingsUSD);
  const card = document.getElementById('roi-card');
  const badge = document.getElementById('roi-badge');
  if (roi.apiReplacementValue >= 0) {
    card.classList.remove('negative');
    badge.textContent = roi.roiPct == null ? '—' : `+${roi.roiPct.toFixed(0)}%`;
  } else {
    card.classList.add('negative');
    badge.textContent = roi.roiPct == null ? '—' : `${roi.roiPct.toFixed(0)}%`;
  }
}

async function refreshDailyChart(daily) {
  const days = daily.days;
  const labels = days.map((d) => d.date);
  const projects = new Set();
  for (const d of days) for (const p of Object.keys(d.byProject)) projects.add(p);
  const projectList = [...projects].sort();
  const palette = ['#ff9500', '#ffd60a', '#378add', '#34c759', '#a78bfa', '#ff3b30', '#5ac8fa', '#af52de'];
  const datasets = projectList.map((p, i) => ({
    label: p,
    backgroundColor: palette[i % palette.length],
    borderRadius: 2,
    data: days.map((d) => d.byProject[p] ?? 0),
  }));
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(document.getElementById('daily-chart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: {
          position: 'bottom',
          align: 'start',
          labels: { color: '#98a2b0', boxWidth: 10, boxHeight: 10, padding: 10, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#0d1217',
          titleColor: '#e8ecf0',
          bodyColor: '#98a2b0',
          borderColor: '#232c36',
          borderWidth: 1,
          padding: 10,
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtUSDLong(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: {
          stacked: true,
          ticks: { color: '#6c7787', font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            color: '#6c7787', font: { size: 11 },
            callback: (v) => (v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`),
          },
          grid: { color: '#1c2330', drawTicks: false },
          border: { display: false },
        },
      },
    },
  });
  document.getElementById('daily-period').textContent =
    `${days.length} day${days.length === 1 ? '' : 's'}`;
}

async function refreshHoursChart() {
  const data = await api('/api/hours', commonParams());
  const labels = data.hours.map((h) => `${h.hour}`.padStart(2, '0'));
  const calls = data.hours.map((h) => h.calls);
  if (hoursChart) hoursChart.destroy();
  hoursChart = new Chart(document.getElementById('hours-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Calls',
        data: calls,
        backgroundColor: '#ff9500',
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1217',
          titleColor: '#e8ecf0',
          bodyColor: '#98a2b0',
          borderColor: '#232c36',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title: (ctx) => `${ctx[0].label}:00 UTC`,
            label: (ctx) => `${ctx.parsed.y} calls`,
          },
        },
      },
      scales: {
        x: { ticks: { color: '#6c7787', font: { size: 10 } }, grid: { display: false }, border: { display: false } },
        y: { beginAtZero: true, ticks: { color: '#6c7787', font: { size: 11 } }, grid: { color: '#1c2330' }, border: { display: false } },
      },
    },
  });
}

async function refreshDailyActivityTable(daily) {
  const days = [...daily.days].reverse(); // most recent first
  const max = Math.max(0, ...days.map((d) => d.totalCost));
  const tb = tbody('daily-activity');
  if (days.length === 0) {
    tb.innerHTML = `<tr><td colspan="5" class="empty">no activity</td></tr>`;
    return;
  }
  // estimate calls per day from session count (true call count would require new endpoint)
  tb.innerHTML = days
    .map((d) => {
      return `<tr>
        <td class="name">${escapeHtml(d.date)}</td>
        ${barCell(d.totalCost, max)}
        <td class="num">${fmtUSDLong(d.totalCost)}</td>
        <td class="num">${fmtInt(d.sessionCount * 0)}</td>
        <td class="num">${fmtInt(d.sessionCount)}</td>
      </tr>`;
    })
    .join('');
  // patch calls column from sessions data via per-day rollup of turnCount
  // (we'll use the sessions list passed in by caller via a side channel below)
}

async function refreshByProjectTable() {
  const data = await api('/api/projects', commonParams());
  const list = data.projects ?? [];
  const max = Math.max(0, ...list.map((p) => p.totalCost));
  const tb = tbody('by-project');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="8" class="empty">no projects</td></tr>`;
    return;
  }
  tb.innerHTML = list
    .map((p) => `<tr>
      <td class="name">${escapeHtml(p.project)}</td>
      ${barCell(p.totalCost, max)}
      <td class="num">${fmtUSDLong(p.totalCost)}</td>
      <td class="num">${fmtInt(p.sessionCount)}</td>
      <td class="num">${fmtInt(p.messageCount)}</td>
      <td class="num">${fmtInt(p.toolCallCount)}</td>
      <td class="num">${fmtTokens(p.totalTokens)}</td>
      <td class="num">${fmtPct(p.cacheHitRate, 1)}</td>
    </tr>`)
    .join('');
}

async function refreshByActivityTable() {
  const data = await api('/api/tasks', commonParams());
  const list = data.tasks ?? [];
  const max = Math.max(0, ...list.map((x) => x.turns));
  const tb = tbody('by-activity');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="4" class="empty">no activity</td></tr>`;
    return;
  }
  tb.innerHTML = list
    .map((x) => `<tr>
      <td class="name">${escapeHtml(x.category)}</td>
      ${barCell(x.turns, max, { subtle: true })}
      <td class="num">${fmtInt(x.turns)}</td>
      <td class="num">${fmtPct(x.pctOfTotal, 1)}</td>
    </tr>`)
    .join('');
}

async function refreshByModelTable() {
  const data = await api('/api/models', commonParams());
  const list = data.models ?? [];
  const max = Math.max(0, ...list.map((m) => m.cost));
  const tb = tbody('by-model');
  if (list.length === 0) {
    tb.innerHTML = `<tr><td colspan="5" class="empty">no models</td></tr>`;
    return;
  }
  tb.innerHTML = list
    .map((m) => `<tr>
      <td class="name">${escapeHtml(m.model)}</td>
      ${barCell(m.cost, max, { modelClass: modelClassFor(m.model) })}
      <td class="num">${fmtUSDLong(m.cost)}</td>
      <td class="num">${fmtInt(m.turnCount)}</td>
      <td class="num">${fmtPct(m.cacheHitRate, 1)}</td>
    </tr>`)
    .join('');
}

async function refreshToolTables() {
  const data = await api('/api/tools', commonParams());
  function fill(tblName, items) {
    const tb = tbody(tblName);
    if (!items || items.length === 0) {
      tb.innerHTML = `<tr><td colspan="3" class="empty">none</td></tr>`;
      return;
    }
    const max = Math.max(0, ...items.map((x) => x.count));
    tb.innerHTML = items
      .slice(0, 30)
      .map((x) => `<tr>
        <td class="name">${escapeHtml(x.name)}</td>
        ${barCell(x.count, max, { subtle: true })}
        <td class="num">${fmtInt(x.count)}</td>
      </tr>`)
      .join('');
  }
  fill('core-tools', data.coreTools);
  fill('shell-commands', data.shellCommands);
  fill('mcp-servers', data.mcpServers);
}

async function refreshSessionsTable(sessions) {
  const expensive = await api('/api/sessions/expensive', { ...commonParams(), limit: 5 });
  const expensiveIds = new Set(expensive.top.map((t) => t.sessionId));
  document.getElementById('sessions-count').textContent =
    `${sessions.count} session${sessions.count === 1 ? '' : 's'}`;
  const sorted = [...sessions.sessions].sort((a, b) =>
    (b.startedAt || '').localeCompare(a.startedAt || '')
  );
  const top = sorted.slice(0, 80);
  const tb = document.querySelector('#sessions-table tbody');
  if (top.length === 0) {
    tb.innerHTML = `<tr><td colspan="9" class="empty">No sessions for this period and project filter.</td></tr>`;
    return;
  }
  tb.innerHTML = top
    .map((s) => {
      const cls = expensiveIds.has(s.sessionId) ? 'expensive' : '';
      const dur = s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : '—';
      return `<tr class="${cls}">
        <td>${fmtTime(s.startedAt)}</td>
        <td>${escapeHtml(s.project ?? '')}</td>
        <td>${escapeHtml(s.byModel?.[0]?.model ?? '—')}</td>
        <td>${escapeHtml(s.tasks?.primary ?? '—')}</td>
        <td class="num">${dur}</td>
        <td class="num">${fmtInt(s.turnCount)}</td>
        <td class="num">${fmtTokens(totalTokensOf(s.tokens))}</td>
        <td class="num">${fmtPct(s.cacheHitRate, 0)}</td>
        <td class="num">${fmtUSDLong(s.cost)}</td>
      </tr>`;
    })
    .join('');
}

async function refreshDailyActivityCalls(sessions) {
  // patch the calls column with real turn-count rollup by day
  const byDay = new Map();
  for (const s of sessions.sessions) {
    const day = (s.startedAt ?? '').slice(0, 10);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + (s.turnCount ?? 0));
  }
  const tb = tbody('daily-activity');
  for (const tr of tb.querySelectorAll('tr')) {
    const date = tr.querySelector('.name')?.textContent;
    if (!date) continue;
    const calls = byDay.get(date) ?? 0;
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 5) {
      cells[3].textContent = fmtInt(calls);
    }
  }
}

function setExportLinks() {
  const params = new URLSearchParams({ period: state.period });
  if (state.project) params.set('project', state.project);
  document.getElementById('export-csv').setAttribute('href', `/api/export?format=csv&${params}`);
  document.getElementById('export-json').setAttribute('href', `/api/export?format=json&${params}`);
}

async function refreshAll() {
  document.body.classList.add('loading');
  try {
    setExportLinks();
    const daily = await api('/api/daily', commonParams());
    const headlinePack = await refreshHeadline();
    await Promise.all([
      refreshPlanUsage(),
      refreshSparklines(daily),
      refreshRoi(headlinePack.cache),
      refreshDailyChart(daily),
      refreshHoursChart(),
      refreshDailyActivityTable(daily),
      refreshByProjectTable(),
      refreshByActivityTable(),
      refreshByModelTable(),
      refreshToolTables(),
      refreshSessionsTable(headlinePack.sessions),
    ]);
    await refreshDailyActivityCalls(headlinePack.sessions);
  } catch (err) {
    console.error('refreshAll failed', err);
  } finally {
    document.body.classList.remove('loading');
  }
}

// ─── claude.ai plan usage ──────────────────────────────────

const GAUGE_COLORS = {
  safe: '#34c759',
  caution: '#ff9500',
  critical: '#ff3b30',
};

function gaugeColor(pct) {
  if (pct == null) return GAUGE_COLORS.safe;
  if (pct >= 85) return GAUGE_COLORS.critical;
  if (pct >= 60) return GAUGE_COLORS.caution;
  return GAUGE_COLORS.safe;
}

function fmtRelative(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `resets in ${d}d ${h % 24}h`;
  if (h > 0) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${m}m`;
}

function ringSvg(pct, color) {
  const r = 38;
  const C = 2 * Math.PI * r;
  const dash = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100 * C;
  return `
    <svg viewBox="0 0 96 96">
      <circle cx="48" cy="48" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
      <circle cx="48" cy="48" r="${r}" fill="none"
        stroke="${color}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${dash} ${C - dash}" />
    </svg>`;
}

function gaugeHtml({ label, metric }) {
  if (!metric) return '';
  const pct = metric.pct;
  const color = gaugeColor(pct);
  return `
    <div class="plan-gauge">
      <div class="ring">
        ${ringSvg(pct, color)}
        <div class="pct">${pct == null ? '—' : pct.toFixed(0) + '%'}</div>
      </div>
      <div class="label">${escapeHtml(label)}</div>
      <div class="reset">${escapeHtml(fmtRelative(metric.resetsAt))}</div>
    </div>`;
}

// CWS URL — left empty until the extension is approved. When empty, the
// install button expands the "alternates" section instead of navigating.
const CWS_URL = '';

async function refreshPlanUsage() {
  const data = await api('/api/usage');
  const status = document.getElementById('plan-status');
  const gauges = document.getElementById('plan-gauges');
  const extra = document.getElementById('plan-extra-usage');
  const onboard = document.getElementById('plan-onboard');

  const isStale = data.ingested
    ? Date.now() - Date.parse(data.ingestedAt) > 10 * 60_000
    : true;

  if (!data.ingested) {
    status.textContent = 'Not synced — install the auto-sync extension below';
    gauges.innerHTML = '';
    extra.innerHTML = '';
    onboard.hidden = false;
    await renderInstallPanel();
    return;
  }

  const plan = data.plan ?? {};
  const ago = fmtAgo(data.ingestedAt);
  const orgName = data.org?.name ?? data.org?.uuid ?? '';
  const staleNote = isStale ? ' · last sync was a while ago' : '';
  status.textContent = `Synced ${ago}${orgName ? ` · ${orgName}` : ''}${staleNote}`;

  const gaugeDefs = [
    { label: 'Session (5h)', metric: plan.fiveHour },
    { label: 'All models (7d)', metric: plan.sevenDay },
    { label: 'Sonnet (7d)', metric: plan.sevenDaySonnet },
    { label: 'Opus (7d)', metric: plan.sevenDayOpus },
    { label: 'Claude Design', metric: plan.sevenDayOmelette },
  ].filter((g) => g.metric);
  gauges.innerHTML = gaugeDefs.map(gaugeHtml).join('') ||
    `<div class="empty">no gauges in this snapshot</div>`;

  if (plan.extraUsage && plan.extraUsage.enabled) {
    const e = plan.extraUsage;
    extra.innerHTML = `
      <div class="item">
        <span class="label">Extra usage</span>
        <span class="value">${fmtUSD(e.usedDollars)} <span class="muted">of ${fmtUSD(e.limitDollars)}</span></span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${Math.max(0, Math.min(100, e.pct ?? 0))}%"></div>
      </div>
      <div class="item">
        <span class="label">Cap</span>
        <span class="value">${e.pct == null ? '—' : e.pct.toFixed(1) + '%'}</span>
      </div>`;
  } else {
    extra.innerHTML = '';
  }

  // Hide the onboarding panel when sync is fresh.
  onboard.hidden = !isStale;
  if (!onboard.hidden) await renderInstallPanel();
}

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

function fmtAgo(iso) {
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

// Auto-refresh the plan-usage card every 60s so it mirrors the extension's
// polling cadence without requiring a full dashboard reload.
setInterval(() => {
  refreshPlanUsage().catch((err) => console.error('plan refresh', err));
}, 60_000);
