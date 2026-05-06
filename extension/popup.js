const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString();
}

async function refresh() {
  const data = await chrome.runtime.sendMessage({ type: 'CLAUGE_GET_LAST' });
  const last = data?.last ?? null;
  if (!last) {
    $('status').textContent = 'Pending first sync';
    $('status').className = 'muted';
    return;
  }
  if (last.ok) {
    $('status').textContent = 'Synced';
    $('status').className = 'ok';
    $('last').textContent = fmtTime(last.finishedAt);
    $('org').textContent = last.orgName ?? last.orgUuid ?? '—';
    $('session').textContent =
      last.sessionPct != null ? `${last.sessionPct.toFixed(1)}%` : '—';
  } else {
    $('status').textContent = 'Error';
    $('status').className = 'err';
    $('last').textContent = fmtTime(last.finishedAt);
    $('org').textContent = last.error ?? '';
    $('session').textContent = '—';
  }
  const port = data?.port ?? 3456;
  $('open-dashboard').href = `http://localhost:${port}/`;
}

$('sync-now').addEventListener('click', async () => {
  $('status').textContent = 'Syncing…';
  $('status').className = 'muted';
  await chrome.runtime.sendMessage({ type: 'CLAUGE_SYNC_NOW' });
  await refresh();
});

$('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

refresh();
