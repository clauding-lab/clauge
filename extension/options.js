const $ = (id) => document.getElementById(id);

async function load() {
  const all = await chrome.storage.local.get(['cl_port', 'cl_interval_min']);
  $('port').value = all.cl_port ?? 3456;
  $('interval').value = all.cl_interval_min ?? 1;
}

async function save() {
  const port = Number($('port').value) || 3456;
  const interval = Math.max(1, Math.min(60, Number($('interval').value) || 1));
  await chrome.storage.local.set({
    cl_port: port,
    cl_interval_min: interval,
  });
  // Recreate the alarm with the new period.
  await chrome.alarms.clear('clauge-sync');
  await chrome.alarms.create('clauge-sync', {
    delayInMinutes: 0.1,
    periodInMinutes: interval,
  });
  $('saved-msg').textContent = '✓ Saved';
  setTimeout(() => ($('saved-msg').textContent = ''), 1500);
}

$('save').addEventListener('click', save);
load();
