// v0.7.0: Connections panel live updates.
// Polls get_connection_status IPC every 30s + on connections-updated event.

// Platform-conditional copy. On Windows the OAuth blob lives in a
// per-user JSON file (%USERPROFILE%\.claude\.credentials.json) rather
// than Keychain Services, so the "Authenticated via" tagline differs.
const IS_WINDOWS = /windows/i.test(navigator.userAgent || '');

// v0.8.1: Clauge Sync Web Store URL — same value as wizard step 4.
const CLAUGE_SYNC_WEB_STORE =
  'https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga';

const STATE_LABELS = {
  claude_code: {
    authenticated: IS_WINDOWS
      ? 'Authenticated via Claude Code credentials file'
      : 'Authenticated via macOS Keychain (Claude Code-credentials)',
    not_installed: 'Claude Code CLI not installed or not logged in',
    expired: 'OAuth token expired — re-run `claude /login`',
  },
  claude_ai: {
    signed_in: 'Signed in to claude.ai',
    not_connected: IS_WINDOWS
      ? 'Not yet supported on Windows — install Clauge Sync below for plan-ring data.'
      : 'Sign in to see plan-ring data even without Claude Code.',
    optional: 'Optional — plan data is flowing via Clauge Sync',
    expired: 'Sign-in expired. Click to re-authenticate.',
  },
  extension: {
    active: 'Clauge Sync active — last sync recently',
    not_detected: 'Optional. Useful for browser-only setups.',
  },
};

// State name shown to assistive tech via aria-label on .conn-dot
// (Task 11 reviewer's WCAG 1.4.1 fix: dot must not be color-only.)
const A11Y_DOT_LABEL = {
  authenticated: 'connected',
  signed_in: 'connected',
  active: 'connected',
  expired: 'expired',
  optional: 'optional',
  not_installed: 'not connected',
  not_connected: 'not connected',
  not_detected: 'not connected',
};

async function refreshConnections() {
  if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return; // npx-clauge browser surface — Tauri IPC unavailable.
  let status;
  try {
    status = await ClaugeBridge.getConnectionStatus();
  } catch (e) {
    console.warn('[connections] failed to fetch status', e);
    return;
  }
  applyStatus(status);
}

function applyStatus(status) {
  applyRow('conn-claude-code', status.claude_code, STATE_LABELS.claude_code);

  // v0.8.1: claude.ai row visibility + state override when extension is active.
  // Windows: hide the row entirely (sign-in is deferred there; row has no useful
  //   controls when the extension is providing data).
  // Mac:    when extension active AND user not signed in to claude.ai, render
  //   with neutral gray dot + "Optional — plan data is flowing via Clauge Sync"
  //   instead of the alarm-colored not_connected state. Preserves sign-in/out
  //   buttons for users who DO want to sign in.
  var claudeAiRow = document.getElementById('conn-claude-ai');
  var extActive = status.extension === 'active';
  var hideOnWindows = IS_WINDOWS && extActive;
  if (claudeAiRow) claudeAiRow.hidden = hideOnWindows;
  if (!hideOnWindows) {
    var claudeAiState = status.claude_ai;
    if (!IS_WINDOWS && extActive && claudeAiState === 'not_connected') {
      claudeAiState = 'optional';
    }
    applyRow('conn-claude-ai', claudeAiState, STATE_LABELS.claude_ai);
  }

  applyRow('conn-extension', status.extension, STATE_LABELS.extension);

  // claude.ai sign-in / sign-out button visibility.
  // On Windows the Architecture A path is deferred to a future release —
  // hide both buttons entirely; the row's state text explains the situation.
  var signinBtn = document.getElementById('signin-claude-ai');
  var signoutBtn = document.getElementById('signout-claude-ai');
  if (signinBtn) signinBtn.hidden = IS_WINDOWS || status.claude_ai === 'signed_in';
  if (signoutBtn) signoutBtn.hidden = IS_WINDOWS || status.claude_ai !== 'signed_in';

  // Extension "Install Clauge Sync" CTA visibility — hide when active.
  var extRow = document.getElementById('conn-extension');
  if (extRow) {
    var installCta = extRow.querySelector('.conn-cta');
    if (installCta) installCta.hidden = status.extension === 'active';
  }
}

function applyRow(rowId, state, labelMap) {
  const row = document.getElementById(rowId);
  if (!row) return;
  row.setAttribute('data-state', state);
  const statusEl = row.querySelector('.conn-status');
  if (statusEl) statusEl.textContent = labelMap[state] || '';

  // Set aria-label on the dot reflecting state (Task 11 reviewer's WCAG fix).
  const dot = row.querySelector('.conn-dot');
  if (dot) {
    const label = A11Y_DOT_LABEL[state] || state;
    dot.setAttribute('aria-label', label);
    dot.removeAttribute('aria-hidden');
  }
}

// Wire button handlers.
document.addEventListener('DOMContentLoaded', () => {
  const signinBtn = document.getElementById('signin-claude-ai');
  if (signinBtn) {
    signinBtn.addEventListener('click', async () => {
      if (window.ClaugeBridge && ClaugeBridge.isTauriAvailable()) {
        await ClaugeBridge.openClaudeAiLogin();
      }
    });
  }
  const signoutBtn = document.getElementById('signout-claude-ai');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      if (window.ClaugeBridge && ClaugeBridge.isTauriAvailable()) {
        await ClaugeBridge.signoutClaudeAi();
      }
      refreshConnections();
    });
  }
  // v0.7.2: manual refresh button on the Claude Code row.
  // Lets the user re-trigger the keychain read after `claude /login`
  // rotates the token, or after dismissing the macOS prompt by mistake.
  const refreshBtn = document.getElementById('refresh-claude-code');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;
      refreshBtn.disabled = true;
      refreshBtn.classList.add('spinning');
      try {
        await ClaugeBridge.refreshCredentials();
        // The Rust handler emits `connections-updated` on success; the existing
        // event listener (around line 100) will re-fetch and re-render.
      } catch (err) {
        console.warn('[connections] refresh_credentials failed', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Refresh failed: ' + err, 'error');
        }
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('spinning');
      }
    });
  }

  // v0.8.1: Wire the existing "Install Clauge Sync" CTA in the extension row
  // to actually open the Web Store. The CTA is an <a target="_blank"> in
  // index.html, which would normally route through Tauri's on_new_window
  // handler. We preventDefault and explicitly invoke shell.open so the URL
  // lives canonically in this file (CLAUGE_SYNC_WEB_STORE constant) — no
  // double-open from the anchor's target="_blank" racing the IPC call.
  var extRow = document.getElementById('conn-extension');
  var installCta = extRow ? extRow.querySelector('.conn-cta') : null;
  if (installCta) {
    installCta.addEventListener('click', async function (e) {
      e.preventDefault();
      if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;
      try {
        await ClaugeBridge.shellOpen(CLAUGE_SYNC_WEB_STORE);
      } catch (err) {
        console.warn('[connections] failed to open Web Store:', err);
      }
    });
  }

  // v1.0.0: API key paste handlers
  const apiKeyRow = document.getElementById('conn-api-key');
  const apiKeyInput = document.getElementById('api-key-input');
  const apiKeySave = document.getElementById('api-key-save');
  const apiKeyClear = document.getElementById('api-key-clear');
  const apiKeyStatus = document.getElementById('api-key-status');
  const apiKeyBanner = document.getElementById('api-key-banner');

  function setApiKeyState(state, message) {
    if (!apiKeyRow) return;
    apiKeyRow.setAttribute('data-state', state);
    if (apiKeyStatus && message) apiKeyStatus.textContent = message;
    if (apiKeyBanner) apiKeyBanner.hidden = (state === 'valid');
    const dot = apiKeyRow.querySelector('.conn-dot');
    if (dot) {
      const label = state === 'valid' ? 'connected'
        : state === 'invalid' ? 'expired'
        : state === 'validating' ? 'connecting'
        : 'not connected';
      dot.setAttribute('aria-label', label);
    }
  }

  // On load, check if a key is already saved
  if (window.ClaugeBridge && ClaugeBridge.isTauriAvailable()) {
    ClaugeBridge.getAnthropicApiKey().then((key) => {
      if (key) {
        setApiKeyState('valid', 'API key configured. Plan-ring data flowing.');
        if (apiKeyInput) apiKeyInput.placeholder = 'sk-ant-api03-•••• (saved)';
        if (apiKeyClear) apiKeyClear.hidden = false;
        if (apiKeySave) apiKeySave.textContent = 'Update';
      } else {
        setApiKeyState('not_set');
      }
    }).catch(() => setApiKeyState('not_set'));
  }

  if (apiKeySave) {
    apiKeySave.addEventListener('click', async () => {
      const key = apiKeyInput.value.trim();
      if (!key) {
        setApiKeyState('invalid', 'Paste a key first.');
        return;
      }
      setApiKeyState('validating', 'Validating...');
      try {
        await ClaugeBridge.testAnthropicApiKey(key);
        await ClaugeBridge.setAnthropicApiKey(key);
        setApiKeyState('valid', 'API key validated and saved.');
        apiKeyInput.value = '';
        apiKeyInput.placeholder = 'sk-ant-api03-•••• (saved)';
        if (apiKeyClear) apiKeyClear.hidden = false;
        apiKeySave.textContent = 'Update';
        // Trigger dashboard refresh
        if (window.__TAURI__?.event?.emit) {
          window.__TAURI__.event.emit('connections-updated');
        }
      } catch (err) {
        setApiKeyState('invalid', String(err));
      }
    });
  }

  if (apiKeyClear) {
    apiKeyClear.addEventListener('click', async () => {
      if (!confirm('Clear the saved API key? Plan-ring data will stop.')) return;
      await ClaugeBridge.clearAnthropicApiKey();
      setApiKeyState('not_set', 'Paste an Anthropic API key to enable plan-ring data.');
      apiKeyInput.placeholder = 'sk-ant-api03-...';
      apiKeyClear.hidden = true;
      apiKeySave.textContent = 'Save';
    });
  }

  refreshConnections();
});

// Refresh on Tauri event from Rust side.
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('connections-updated', () => refreshConnections());
}

// v0.7.2: surface Architecture A login timeouts so the user knows the
// flow failed instead of just seeing the window close silently.
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('cookie-capture-timeout', () => {
    console.warn('[connections] claude.ai login timed out (60s without cookie capture)');
    // Show a non-blocking toast if the helper exists; otherwise log only.
    if (typeof window.showToast === 'function') {
      window.showToast('Sign-in didn\'t complete. Please try again.', 'error');
    }
  });
}

// Periodic poll.
setInterval(refreshConnections, 30000);

// Refresh on focus.
window.addEventListener('focus', refreshConnections);

export { refreshConnections, applyStatus };
