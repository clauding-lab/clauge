// v0.7.0: Connections panel live updates.
// Polls get_connection_status IPC every 30s + on connections-updated event.

// Platform-conditional copy. On Windows the OAuth blob lives in a
// per-user JSON file (%USERPROFILE%\.claude\.credentials.json) rather
// than Keychain Services, so the "Authenticated via" tagline differs.
const IS_WINDOWS = /windows/i.test(navigator.userAgent || '');

// v0.8.1: Clauge Sync Web Store URL — same value as wizard step 4.
const CLAUGE_SYNC_WEB_STORE =
  'https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga';

// v0.9.0 MAS (Task 12b): cached flavor flag for the claude.ai row 2 branch.
// `app.js::initFlavorGate` fires the `is_mas_flavor` IPC at module load and
// adds `body.is-flavor-mas` if true. We mirror that signal here by reading
// the class instead of re-firing the IPC — keeps the two modules' flavor
// state in lockstep without a second IPC round-trip. The class is set
// before DOMContentLoaded (initFlavorGate runs at module-load), so reading
// it inside refreshConnections/applyStatus is reliable.
function isMasFlavor() {
  return document.body && document.body.classList.contains('is-flavor-mas');
}

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
  // v0.9.0 MAS: Claude Code logs grant row. Only rendered when the payload
  // includes `claude_code_logs` (cfg(feature="mas") gates the Rust field).
  claude_code_logs: {
    granted: 'Granted — Clauge can read ~/.claude/ credentials + transcripts.',
    not_granted: 'Not granted — Clauge cannot read transcripts until you re-select the folder.',
  },
};

// State name shown to assistive tech via aria-label on .conn-dot
// (Task 11 reviewer's WCAG 1.4.1 fix: dot must not be color-only.)
const A11Y_DOT_LABEL = {
  authenticated: 'connected',
  signed_in: 'connected',
  active: 'connected',
  granted: 'connected',
  expired: 'expired',
  optional: 'optional',
  not_installed: 'not connected',
  not_connected: 'not connected',
  not_detected: 'not connected',
  not_granted: 'not connected',
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
  // v0.9.0 MAS (Task 12b): the direct webview-cookie flow (claude_ai_session
  //   module) is cfg-gated out on MAS to stop the ~30s keychain-prompt loop.
  //   Backend always reports `claude_ai: "not_connected"` on MAS, so we override
  //   the row's status text + hide the Sign in button — the user routes through
  //   the Clauge Sync browser extension instead (covered by row 3).
  var claudeAiRow = document.getElementById('conn-claude-ai');
  var extActive = status.extension === 'active';
  var hideOnWindows = IS_WINDOWS && extActive;
  var isMas = isMasFlavor();
  if (claudeAiRow) claudeAiRow.hidden = hideOnWindows;
  if (!hideOnWindows) {
    var claudeAiState = status.claude_ai;
    if (!IS_WINDOWS && extActive && claudeAiState === 'not_connected') {
      claudeAiState = 'optional';
    }
    applyRow('conn-claude-ai', claudeAiState, STATE_LABELS.claude_ai);
    // MAS-flavor override: replace the "Sign in to see plan-ring data" copy
    // with the Clauge Sync explanation when the user isn't already covered
    // by the extension's optional state above.
    if (isMas && claudeAiState !== 'signed_in' && claudeAiState !== 'optional' && claudeAiRow) {
      var statusEl = claudeAiRow.querySelector('.conn-status');
      if (statusEl) {
        statusEl.textContent = 'Use the Clauge Sync browser extension (see below) for plan-ring data on Mac App Store.';
      }
    }
  }

  applyRow('conn-extension', status.extension, STATE_LABELS.extension);

  // v0.9.0 MAS: Claude Code logs grant row. Payload field is gated by the
  // `mas` Cargo feature on the Rust side (skip_serializing_if = "Option::is_none"),
  // so DMG/NSIS payloads omit it entirely. Field-absence → hide the row
  // (defense-in-depth against the CSS gate, which already hides `.flavor-mas`
  // unless `body.is-flavor-mas` is set). Field-presence → render the grant
  // state and unhide the row so it shows alongside the other 3.
  applyClaudeCodeLogsRow(status.claude_code_logs);

  // claude.ai sign-in / sign-out button visibility.
  // - Windows: hide both buttons entirely; Architecture A path deferred there.
  // - MAS: hide both buttons; backend's open_claude_ai_login IPC returns an
  //   error pointing at Clauge Sync, so showing the button would surface a
  //   meaningless dialog. The row's status text (set above) directs the user
  //   to the extension.
  // - DMG: show Sign in when not signed_in; show Sign out when signed_in.
  var signinBtn = document.getElementById('signin-claude-ai');
  var signoutBtn = document.getElementById('signout-claude-ai');
  var hideClaudeAiButtons = IS_WINDOWS || isMas;
  if (signinBtn) signinBtn.hidden = hideClaudeAiButtons || status.claude_ai === 'signed_in';
  if (signoutBtn) signoutBtn.hidden = hideClaudeAiButtons || status.claude_ai !== 'signed_in';

  // Extension "Install Clauge Sync" CTA visibility — hide when active.
  var extRow = document.getElementById('conn-extension');
  if (extRow) {
    var installCta = extRow.querySelector('.conn-cta');
    if (installCta) installCta.hidden = status.extension === 'active';
  }
}

function applyClaudeCodeLogsRow(logs) {
  const row = document.getElementById('conn-claude-code-logs');
  if (!row) return;
  // Field absent → DMG/NSIS payload; CSS keeps the row hidden via .flavor-mas
  // unless body.is-flavor-mas is set. Be doubly defensive: explicit hidden.
  if (!logs) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  // logs.status is "granted" | "not_granted" per ClaudeDirGrantStatus enum.
  const state = logs.status;
  row.setAttribute('data-state', state);
  const statusEl = row.querySelector('.conn-status');
  if (statusEl) {
    const baseText = STATE_LABELS.claude_code_logs[state] || '';
    // When granted and the path is resolved, append it so the user sees the
    // concrete folder path. Falsy logs.path → just the label (the user hasn't
    // re-grant'd this session or MAS_CLAUDE_DIR isn't populated yet).
    statusEl.textContent =
      state === 'granted' && logs.path
        ? `${baseText} (${logs.path})`
        : baseText;
  }
  const dot = row.querySelector('.conn-dot');
  if (dot) {
    const label = A11Y_DOT_LABEL[state] || state;
    dot.setAttribute('aria-label', label);
    dot.removeAttribute('aria-hidden');
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

  // v0.9.0 MAS: Re-select folder button on the Claude Code logs row. Calls
  // grant_claude_dir_access (no-op on DMG/NSIS — IPC returns Ok(()) there),
  // which opens NSOpenPanel pre-pointed at ~/.claude and persists a new
  // security-scoped bookmark on Choose. After grant, re-fetch the connection
  // status so the row re-renders with the new state. We deliberately keep
  // the button enabled on DMG/NSIS too — the row is CSS-hidden there, so the
  // user can't click it anyway, and not gating the handler keeps the wiring
  // identical to the other rows' click handlers.
  const regrantLogsBtn = document.getElementById('regrant-claude-code-logs');
  if (regrantLogsBtn) {
    regrantLogsBtn.addEventListener('click', async () => {
      if (!window.ClaugeBridge || !ClaugeBridge.isTauriAvailable()) return;
      regrantLogsBtn.disabled = true;
      try {
        await ClaugeBridge.grantClaudeDirAccess();
        // Re-fetch the connection status so the row picks up the new state
        // (Granted + path resolved on Mac, or unchanged on cancel).
        await refreshConnections();
      } catch (err) {
        console.warn('[connections] grant_claude_dir_access failed', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Folder grant failed: ' + err, 'error');
        }
      } finally {
        regrantLogsBtn.disabled = false;
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
