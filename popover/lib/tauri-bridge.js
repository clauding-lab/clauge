// Tauri ↔ Web bridge (v0.9.4 Phase B.6).
//
// Single facade for every tauri.invoke() call across the dashboard, popover,
// onboarding wizard, and splash screens. The goal is to make AGENTS.md
// landmine #1 trivially auditable: one file lists every command consumed
// from JS, and `scripts/validate-ipc-triple-register.cjs` already asserts
// each backend command is correctly registered.
//
// Loaded as a classic script BEFORE any consumer:
//   <script src="/popover/lib/tauri-bridge.js" defer></script>   (dashboard)
//   <script src="lib/tauri-bridge.js" defer></script>             (popover)
//
// Exposes window.ClaugeBridge with one method per command. Each method
// returns a Promise that resolves to the command's return value, or
// rejects with the underlying error. If the Tauri runtime isn't injected
// (running the dashboard in a plain browser at http://127.0.0.1:3457),
// methods reject with a friendly "Tauri unavailable" error so callers can
// fall through to a non-native code path.

(function () {
  'use strict';

  function tauriCore() {
    if (typeof window === 'undefined') return null;
    const t = window.__TAURI__;
    if (!t || !t.core || typeof t.core.invoke !== 'function') return null;
    return t.core;
  }

  function unavailableError(cmd) {
    return new Error(`Tauri runtime unavailable; cannot invoke '${cmd}'`);
  }

  async function call(cmd, args) {
    const core = tauriCore();
    if (!core) throw unavailableError(cmd);
    return await core.invoke(cmd, args);
  }

  const ClaugeBridge = {
    isTauriAvailable: () => tauriCore() !== null,

    // ── App-level commands (must be in src-tauri/build.rs APP_COMMANDS) ──
    getServerPort: () => call('get_server_port'),
    getConnectionStatus: () => call('get_connection_status'),
    openClaudeAiLogin: () => call('open_claude_ai_login'),
    signoutClaudeAi: () => call('signout_claude_ai'),
    hasClaudeAiSession: () => call('has_claude_ai_session'),
    refreshCredentials: () => call('refresh_credentials'),
    wizardComplete: () => call('wizard_complete'),
    wizardSkip: () => call('wizard_skip'),
    restartApp: () => call('restart_app'),
    checkForUpdates: () => call('check_for_updates'),
    takePendingFocusConnections: () => call('take_pending_focus_connections'),
    installCliSymlink: () => call('install_cli_symlink'),

    // ── API key paste flow (v1.0.0+) ──
    setAnthropicApiKey: (key) => call('set_anthropic_api_key', { key }),
    getAnthropicApiKey: () => call('get_anthropic_api_key'),
    clearAnthropicApiKey: () => call('clear_anthropic_api_key'),
    testAnthropicApiKey: (key) => call('test_anthropic_api_key', { key }),

    // ── Popover-only commands (no APP_COMMANDS entry; tauri:// origin) ──
    openDashboard: () => call('open_dashboard'),
    quitApp: () => call('quit_app'),
    proxyFetch: (req) => call('proxy_fetch', req),
    setAutostartLegacy: (enabled) => call('set_autostart', { enabled }),
    getAutostartLegacy: () => call('get_autostart'),

    // ── Plugin commands ──
    // Autostart plugin — current canonical path (not the legacy set_autostart).
    autostartIsEnabled: () => call('plugin:autostart|is_enabled'),
    autostartEnable: () => call('plugin:autostart|enable'),
    autostartDisable: () => call('plugin:autostart|disable'),
    autostartSetEnabled: (enabled) => call(enabled ? 'plugin:autostart|enable' : 'plugin:autostart|disable'),

    // Shell plugin — opens external URLs via the OS launcher (defense-in-depth
    // scheme allowlist in src-tauri/src/windows.rs::on_new_window).
    shellOpen: (path) => call('plugin:shell|open', { path }),
  };

  if (typeof window !== 'undefined') {
    window.ClaugeBridge = ClaugeBridge;
  }
})();
