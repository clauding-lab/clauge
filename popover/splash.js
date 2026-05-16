// Splash bridge — listens for the Rust-side "sidecar-ready" event, then
// redirects the webview to the dashboard URL. Falls back to polling
// get_server_port IPC if the event doesn't arrive (defense-in-depth).
// Shows an error state with a Restart button if the sidecar never comes
// up within 30 seconds.

(function () {
  'use strict';

  const TIMEOUT_MS = 30000;
  const POLL_INTERVAL_MS = 500;
  const EVENT_WAIT_BEFORE_POLL_MS = 5000;

  const statusEl = document.getElementById('splash-status');
  const errorEl = document.getElementById('splash-error');
  const errorDetailEl = document.getElementById('splash-error-detail');
  const retryBtn = document.getElementById('splash-retry-btn');

  let navigated = false;
  let timeoutId = null;
  let pollIntervalId = null;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function navigateToDashboard(port) {
    if (navigated) return;
    navigated = true;
    clearTimeout(timeoutId);
    if (pollIntervalId) clearInterval(pollIntervalId);
    const url = 'http://127.0.0.1:' + port + '/';
    setStatus('Loading dashboard…');
    window.location.href = url;
  }

  function showError(message) {
    if (navigated) return;
    if (errorEl) errorEl.hidden = false;
    if (errorDetailEl && message) errorDetailEl.textContent = message;
    setStatus('');
  }

  // Primary path: Tauri event from Rust supervisor.
  if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
    window.__TAURI__.event.listen('sidecar-ready', function (event) {
      const port = event && event.payload && event.payload.port;
      if (typeof port === 'number') navigateToDashboard(port);
    }).catch(function (err) {
      console.warn('[splash] sidecar-ready subscribe failed:', err);
    });
  }

  // Fallback path: after 5s without the event, poll get_server_port IPC.
  // Handles edge cases where event subscription races the emit (rare but
  // possible on a slow Windows VM first launch).
  setTimeout(function pollPortFallback() {
    if (navigated) return;
    if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) return;
    pollIntervalId = setInterval(async function () {
      if (navigated) return;
      try {
        const port = await window.__TAURI__.core.invoke('get_server_port');
        if (typeof port === 'number') navigateToDashboard(port);
      } catch (_err) {
        // "server port not yet set" — keep waiting.
      }
    }, POLL_INTERVAL_MS);
  }, EVENT_WAIT_BEFORE_POLL_MS);

  // Hard timeout: show error UI.
  timeoutId = setTimeout(function () {
    if (!navigated) showError('The local server didn\'t respond within 30 seconds.');
  }, TIMEOUT_MS);

  // Restart button — invokes the existing restart_app IPC.
  if (retryBtn) {
    retryBtn.addEventListener('click', async function () {
      retryBtn.disabled = true;
      try {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
          await window.__TAURI__.core.invoke('restart_app');
        }
      } catch (err) {
        console.error('[splash] restart_app failed:', err);
        if (errorDetailEl) {
          errorDetailEl.textContent = 'Could not restart automatically. Quit and relaunch Clauge from your menubar / Start menu.';
        }
        retryBtn.disabled = false;
      }
    });
  }
})();
