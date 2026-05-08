// Popover JS. Wires UI to clauge-server via fetch.
// Reference: docs/design/menubar.jsx (port to vanilla here).

const { invoke } = window.__TAURI__.core;

let serverPort = 3456;

async function init() {
  try {
    serverPort = await invoke('get_server_port');
  } catch (e) {
    console.warn('Server port not yet available, falling back to 3456', e);
  }

  document.getElementById('btn-prefs').addEventListener('click', showPreferences);
  document.getElementById('prefs-back').addEventListener('click', hidePreferences);
  document.getElementById('btn-dashboard').addEventListener('click', openDashboard);
  document.getElementById('footer-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    openDashboard();
  });
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('check-updates-btn').addEventListener('click', () => {
    invoke('check_for_updates').catch((err) => console.error('Update error:', err));
  });
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
      console.error('set_autostart failed:', err);
      autoToggle.checked = !desired;
      // TODO(v0.3.0.x): surface inline error state in status badge or footer.
    }
  });

  window.addEventListener('show-preferences', showPreferences);

  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  await refresh();
  setInterval(refresh, 10_000);
}

function showPreferences() { document.getElementById('prefs').hidden = false; }
function hidePreferences() { document.getElementById('prefs').hidden = true; }

async function openDashboard() {
  await invoke('open_dashboard').catch(console.error);
}

async function refresh() {
  try {
    const [today, plan, hours] = await Promise.all([
      fetchJson(`/api/sessions?period=today`),
      fetchJson(`/api/usage`),
      fetchJson(`/api/hours?period=today`),
    ]);
    renderHero(today);
    renderRings(plan);
    renderHeroSpark(hours);
    renderActiveTab();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

async function fetchJson(path) {
  const r = await fetch(`http://127.0.0.1:${serverPort}${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

let lastData = { today: null, plan: null, hours: null };

function renderHero(today) {
  lastData.today = today;
  const total = today?.totals?.cost ?? 0;
  document.getElementById('hero-amount').textContent = `$${total.toFixed(2)}`;
}

function renderHeroSpark(hours) {
  lastData.hours = hours;
  const arr = (hours?.hours ?? []).map((h) => h.cost ?? 0);
  if (arr.length === 0) return;
  const max = Math.max(...arr, 0.01);
  const now = new Date().getHours();
  const el = document.getElementById('hero-spark');
  el.innerHTML = arr
    .map((v, i) => {
      const h = (v / max) * 100;
      const dim = i > now;
      const isNow = i === now;
      const bg = isNow ? 'var(--brand)' : 'var(--surface-3)';
      return `<div style="flex:1;height:${h}%;background:${bg};opacity:${dim ? 0.3 : 1};border-radius:1px"></div>`;
    })
    .join('');
}

function renderRings(plan) {
  lastData.plan = plan;
  const gauges = [
    { label: 'Session', pct: plan?.session_5h ?? 0, sub: '5h', reset: plan?.session_reset ?? '—' },
    { label: 'Weekly', pct: plan?.seven_day ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
    { label: 'Sonnet', pct: plan?.seven_day_sonnet ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
    { label: 'Opus', pct: plan?.seven_day_opus ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
  ];
  const root = document.getElementById('rings');
  root.innerHTML = gauges.map(ringHtml).join('');
}

function ringHtml(g) {
  const size = 56, stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - g.pct * c;
  const state = g.pct >= 0.85 ? 'crit' : g.pct >= 0.60 ? 'warn' : 'ok';
  const colorMap = { ok: 'var(--brand)', warn: 'var(--warn)', crit: 'var(--crit)' };
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
      <div style="position:relative;width:${size}px;height:${size}px">
        <svg width="${size}" height="${size}" style="transform:rotate(-90deg)">
          <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none"
                  stroke="var(--surface-3)" stroke-width="${stroke}"></circle>
          <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none"
                  stroke="${colorMap[state]}" stroke-width="${stroke}" stroke-linecap="round"
                  stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
        </svg>
        <div style="position:absolute;inset:0;display:grid;place-items:center">
          <span class="mono" style="font-size:12px;font-weight:600;letter-spacing:-0.02em">
            ${Math.round(g.pct*100)}<span style="font-size:8px;color:var(--text-3)">%</span>
          </span>
        </div>
      </div>
      <div style="text-align:center;line-height:1.15">
        <div style="font-size:10.5px;color:var(--text);font-weight:500">${g.label}</div>
        <div class="mono" style="font-size:9.5px;color:var(--text-3);margin-top:1px">${g.reset}</div>
      </div>
    </div>`;
}

let activeTab = 'today';
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  renderActiveTab();
}

function renderActiveTab() {
  const root = document.getElementById('tab-content');
  if (activeTab === 'today') root.innerHTML = renderTodayTab(lastData.today);
  else if (activeTab === 'recent') root.innerHTML = renderRecentTab(lastData.today);
  else if (activeTab === 'models') root.innerHTML = renderModelsTab(lastData.today);
}

function renderTodayTab(today) {
  if (!today) return '<div class="prefs-meta">Loading…</div>';
  const items = [
    { label: 'Messages', value: today?.totals?.messageCount ?? 0 },
    { label: 'Tool calls', value: today?.totals?.toolCallCount ?? 0 },
    { label: 'Sessions', value: today?.sessions?.length ?? 0 },
    { label: 'Cache hit', value: `${Math.round((today?.totals?.cacheHitRate ?? 0) * 100)}%`, accent: 'var(--ok)' },
  ];
  return `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
      ${items.map((i) => `
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--hairline);border-radius:8px">
          <div style="font-size:9px;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-3)">${i.label}</div>
          <div class="mono" style="font-size:15px;font-weight:600;margin-top:2px;color:${i.accent || 'var(--text)'};letter-spacing:-0.01em">${i.value}</div>
        </div>`).join('')}
    </div>`;
}

function renderRecentTab(today) {
  const sessions = (today?.sessions ?? []).slice(0, 5);
  if (sessions.length === 0) return '<div class="prefs-meta">No sessions today.</div>';
  return `<div style="display:flex;flex-direction:column;gap:1px">
    ${sessions.map((s, i, a) => `
      <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center;padding:8px 4px;border-bottom:${i < a.length-1 ? '1px solid var(--hairline)' : 'none'};font-size:11.5px">
        <span class="mono" style="color:var(--text-3);font-size:11px">${formatTime(s.start)}</span>
        <span class="mono">${s.project ?? '—'}</span>
        <span style="font-size:9.5px;padding:1px 5px;border-radius:3px;color:${modelColor(s.model)};background:var(--surface-2);font-family:var(--mono)">${shortModel(s.model)}</span>
        <span class="mono" style="font-weight:600">$${(s.cost ?? 0).toFixed(2)}</span>
      </div>`).join('')}
  </div>`;
}

function renderModelsTab(today) {
  const models = (today?.byModel ?? []);
  if (models.length === 0) return '<div class="prefs-meta">No model data today.</div>';
  const total = models.reduce((s, m) => s + (m.cost ?? 0), 0) || 1;
  return `
    <div style="display:flex;height:6px;border-radius:999px;overflow:hidden;margin-bottom:14px;background:var(--surface-3)">
      ${models.map((m) => `<div style="width:${(m.cost/total)*100}%;background:${modelColor(m.model)}"></div>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${models.map((m) => `
        <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center">
          <span style="width:8px;height:8px;border-radius:2px;background:${modelColor(m.model)}"></span>
          <span class="mono" style="font-size:11.5px">${m.model}</span>
          <span class="mono" style="font-size:10.5px;color:var(--text-3)">${Math.round((m.cost/total)*100)}%</span>
          <span class="mono" style="font-size:11.5px;font-weight:600;min-width:48px;text-align:right">$${(m.cost ?? 0).toFixed(2)}</span>
        </div>`).join('')}
    </div>`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function shortModel(m) {
  if (!m) return '—';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return m;
}
function modelColor(m) {
  if (!m) return 'var(--text-3)';
  if (m.includes('opus')) return 'var(--opus)';
  if (m.includes('sonnet')) return 'var(--sonnet)';
  if (m.includes('haiku')) return 'var(--haiku)';
  return 'var(--text-3)';
}

document.addEventListener('DOMContentLoaded', init);
