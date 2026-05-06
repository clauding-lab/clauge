// Clauge dashboard — V1
//
// Vanilla module, no build step. Consumes the Hono REST API exposed by
// server.js. Designed to remain readable end-to-end.

const state = {
  period: '7d',
  project: '',
};

const fmtUSD = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(n);

const fmtUSDLong = (n) =>
  n == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      }).format(n);

const fmtInt = (n) =>
  n == null ? '—' : new Intl.NumberFormat('en-US').format(Math.round(n));

const fmtPct = (frac, digits = 1) =>
  frac == null ? '—' : `${(frac * 100).toFixed(digits)}%`;

const fmtTokens = (n) => {
  if (n == null) return '—';
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

async function api(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${path}?${qs}` : path;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

let dailyChart, modelChart;

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

function setMetric(key, value) {
  const card = document.querySelector(`[data-metric="${key}"]`);
  if (!card) return;
  card.querySelector('.value').textContent = value;
}

async function refreshSummary() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const summary = await api('/api/summary', params);
  setMetric('totalCost', fmtUSD(summary.cost));
  setMetric('totalTokens', fmtTokens(summary.totalTokens));
  setMetric('sessionCount', fmtInt(summary.sessionCount));
  setMetric('avgCostPerSession', fmtUSD(summary.avgCostPerSession));
  const denom =
    (summary.tokens.cacheRead || 0) +
    (summary.tokens.cacheCreate5m || 0) +
    (summary.tokens.cacheCreate1h || 0) +
    (summary.tokens.inputTokens || 0);
  const hit = denom === 0 ? null : summary.tokens.cacheRead / denom;
  setMetric('cacheHitRate', fmtPct(hit));
}

async function refreshRoi() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const roi = await api('/api/roi', params);
  document.getElementById('roi-replacement').textContent = fmtUSD(roi.apiReplacementValue);
  document.getElementById('roi-subscription').textContent = fmtUSD(roi.subscriptionCost);
  document.getElementById('roi-api').textContent = fmtUSD(roi.apiEquivalentSpend);
  const card = document.getElementById('roi-card');
  const badge = document.getElementById('roi-badge');
  if (roi.apiReplacementValue >= 0) {
    card.classList.remove('negative');
    badge.textContent =
      roi.roiPct == null ? '—' : `+${roi.roiPct.toFixed(0)}%`;
  } else {
    card.classList.add('negative');
    badge.textContent =
      roi.roiPct == null ? '—' : `${roi.roiPct.toFixed(0)}%`;
  }
}

async function refreshDailyChart() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const data = await api('/api/daily', params);
  const labels = data.days.map((d) => d.date);
  // Stack by project. Project name list = union across days.
  const projects = new Set();
  for (const d of data.days) for (const p of Object.keys(d.byProject)) projects.add(p);
  const projectList = [...projects].sort();
  const palette = ['#378add', '#34c759', '#ff9500', '#a78bfa', '#ff3b30', '#5ac8fa', '#af52de'];
  const datasets = projectList.map((p, i) => ({
    label: p,
    backgroundColor: palette[i % palette.length],
    data: data.days.map((d) => d.byProject[p] ?? 0),
  }));
  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(document.getElementById('daily-chart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#98a2b0', boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtUSDLong(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { stacked: true, ticks: { color: '#6c7787' }, grid: { display: false } },
        y: {
          stacked: true,
          ticks: { color: '#6c7787', callback: (v) => fmtUSD(v) },
          grid: { color: '#1c2330' },
        },
      },
    },
  });
  document.getElementById('daily-period').textContent =
    `${data.days.length} day${data.days.length === 1 ? '' : 's'}`;
}

async function refreshModelChart() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const data = await api('/api/models', params);
  const labels = data.models.map((m) => m.model);
  const values = data.models.map((m) => m.cost);
  const colors = labels.map(colorFor);
  if (modelChart) modelChart.destroy();
  modelChart = new Chart(document.getElementById('model-chart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#98a2b0', font: { size: 11 } } },
        tooltip: {
          callbacks: { label: (ctx) => `${ctx.label}: ${fmtUSDLong(ctx.parsed)}` },
        },
      },
    },
  });
}

async function refreshSessions() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const data = await api('/api/sessions', params);
  const expensive = await api('/api/sessions/expensive', { ...params, limit: 5 });
  const expensiveIds = new Set(expensive.top.map((t) => t.sessionId));
  const tbody = document.querySelector('#sessions-table tbody');
  document.getElementById('sessions-count').textContent =
    `${data.count} session${data.count === 1 ? '' : 's'}`;
  if (data.sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">No sessions for this period and project filter.</td></tr>`;
    return;
  }
  const sorted = [...data.sessions].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  const top = sorted.slice(0, 60);
  tbody.innerHTML = top
    .map((s) => {
      const totalTokens =
        (s.tokens.inputTokens || 0) +
        (s.tokens.outputTokens || 0) +
        (s.tokens.cacheRead || 0) +
        (s.tokens.cacheCreate5m || 0) +
        (s.tokens.cacheCreate1h || 0);
      const cls = expensiveIds.has(s.sessionId) ? 'expensive' : '';
      const dur = s.durationMs ? `${Math.round(s.durationMs / 60000)}m` : '—';
      return `<tr class="${cls}">
        <td>${fmtTime(s.startedAt)}</td>
        <td>${escapeHtml(s.project ?? '')}</td>
        <td>${escapeHtml(s.byModel?.[0]?.model ?? '—')}</td>
        <td>${escapeHtml(s.tasks?.primary ?? '—')}</td>
        <td class="num">${dur}</td>
        <td class="num">${fmtTokens(totalTokens)}</td>
        <td class="num">${fmtPct(s.cacheHitRate, 0)}</td>
        <td class="num">${fmtUSDLong(s.cost)}</td>
      </tr>`;
    })
    .join('');
}

async function refreshLists() {
  const params = { period: state.period };
  if (state.project) params.project = state.project;
  const [projects, tools] = await Promise.all([
    api('/api/projects', params),
    api('/api/tools', params),
  ]);
  document.getElementById('top-projects').innerHTML = projects.projects
    .slice(0, 8)
    .map(
      (p) => `<li>
        <span class="name">${escapeHtml(p.project)}</span>
        <span class="meta">${fmtUSDLong(p.totalCost)} · ${p.sessionCount}s</span>
      </li>`
    )
    .join('') || '<li class="empty">no projects</li>';
  document.getElementById('top-tools').innerHTML = tools.coreTools
    .slice(0, 8)
    .map(
      (t) => `<li>
        <span class="name">${escapeHtml(t.name)}</span>
        <span class="meta">${fmtInt(t.count)}</span>
      </li>`
    )
    .join('') || '<li class="empty">no tools</li>';
  document.getElementById('top-shell').innerHTML = tools.shellCommands
    .slice(0, 8)
    .map(
      (t) => `<li>
        <span class="name">${escapeHtml(t.name)}</span>
        <span class="meta">${fmtInt(t.count)}</span>
      </li>`
    )
    .join('') || '<li class="empty">no shell commands</li>';
}

function setExportLinks() {
  const params = new URLSearchParams({ period: state.period });
  if (state.project) params.set('project', state.project);
  document
    .getElementById('export-csv')
    .setAttribute('href', `/api/export?format=csv&${params.toString()}`);
  document
    .getElementById('export-json')
    .setAttribute('href', `/api/export?format=json&${params.toString()}`);
}

async function refreshAll() {
  document.body.classList.add('loading');
  try {
    setExportLinks();
    await Promise.all([
      refreshSummary(),
      refreshRoi(),
      refreshDailyChart(),
      refreshModelChart(),
      refreshSessions(),
      refreshLists(),
    ]);
  } catch (err) {
    console.error(err);
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
  let projectTimer;
  document.getElementById('project-filter').addEventListener('input', (e) => {
    clearTimeout(projectTimer);
    projectTimer = setTimeout(() => {
      state.project = e.target.value.trim();
      refreshAll();
    }, 220);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

bindControls();
refreshAll();
