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
    invoke('check_for_updates').catch((err) => alert(`Update error: ${err}`));
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
      // TODO(T18): surface inline error state instead of silent revert.
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
  // TODO Task 17: invoke a Tauri command that creates/shows the dashboard window
  alert('Dashboard window — wired in Task 17 of plan');
}

async function refresh() {
  // TODO(T18, spec §6.1/§8.5): switch endpoint to `/api/summary?period=7d`
  // and additionally fetch `/api/usage` for balance card. The current
  // `/api/sessions?period=today` is a T16 scaffold stub.
  const url = `http://127.0.0.1:${serverPort}/api/sessions?period=today`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderHero(data);
  } catch (e) {
    console.error('refresh failed', e);
  }
}

function renderHero(data) {
  const total = data?.totals?.cost ?? 0;
  document.getElementById('hero-amount').textContent =
    `$${total.toFixed(2)}`;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  // Tab content rendering stubbed; expanded in Task 18.
  document.getElementById('tab-content').textContent =
    `Tab "${name}" content — Task 18`;
}

document.addEventListener('DOMContentLoaded', init);
