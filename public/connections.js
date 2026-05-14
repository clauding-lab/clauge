// v0.7.0: Connections panel live updates.
// Polls get_connection_status IPC every 30s + on connections-updated event.

const STATE_LABELS = {
  claude_code: {
    authenticated: 'Authenticated via macOS Keychain (Claude Code-credentials)',
    not_installed: 'Claude Code CLI not installed or not logged in',
    expired: 'OAuth token expired — re-run `claude /login`',
  },
  claude_ai: {
    signed_in: 'Signed in to claude.ai',
    not_connected: 'Sign in to see plan-ring data even without Claude Code.',
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
  not_installed: 'not connected',
  not_connected: 'not connected',
  not_detected: 'not connected',
};

async function refreshConnections() {
  if (!window.__TAURI__?.core?.invoke) return; // npx-clauge browser surface — Tauri IPC unavailable.
  let status;
  try {
    status = await window.__TAURI__.core.invoke('get_connection_status');
  } catch (e) {
    console.warn('[connections] failed to fetch status', e);
    return;
  }
  applyStatus(status);
}

function applyStatus(status) {
  applyRow('conn-claude-code', status.claude_code, STATE_LABELS.claude_code);
  applyRow('conn-claude-ai', status.claude_ai, STATE_LABELS.claude_ai);
  applyRow('conn-extension', status.extension, STATE_LABELS.extension);

  // claude.ai sign-in / sign-out button visibility.
  const signinBtn = document.getElementById('signin-claude-ai');
  const signoutBtn = document.getElementById('signout-claude-ai');
  if (signinBtn) signinBtn.hidden = status.claude_ai === 'signed_in';
  if (signoutBtn) signoutBtn.hidden = status.claude_ai !== 'signed_in';

  // Extension "Install Clauge Sync" CTA visibility — hide when active.
  // (Task 11 reviewer's Important #2 fix.)
  const extRow = document.getElementById('conn-extension');
  if (extRow) {
    const installCta = extRow.querySelector('.conn-cta');
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
      await window.__TAURI__?.core?.invoke?.('open_claude_ai_login');
    });
  }
  const signoutBtn = document.getElementById('signout-claude-ai');
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      await window.__TAURI__?.core?.invoke?.('signout_claude_ai');
      refreshConnections();
    });
  }
  // v0.7.2: manual refresh button on the Claude Code row.
  // Lets the user re-trigger the keychain read after `claude /login`
  // rotates the token, or after dismissing the macOS prompt by mistake.
  const refreshBtn = document.getElementById('refresh-claude-code');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      if (!window.__TAURI__?.core?.invoke) return;
      refreshBtn.disabled = true;
      refreshBtn.classList.add('spinning');
      try {
        await window.__TAURI__.core.invoke('refresh_credentials');
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
