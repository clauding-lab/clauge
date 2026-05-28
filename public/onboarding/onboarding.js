// Clauge first-launch wizard (v0.8.1).
// 5-step flow culminating in either wizard_complete (triggers keychain read)
// or wizard_skip (closes window without read). Both flag onboarding_completed = true
// so the wizard doesn't re-appear on next launch.
// Step 4 (v0.8.1): Install Clauge Sync browser extension with auto-advance on heartbeat.

(function () {
  'use strict';

  const TOTAL_STEPS = 5;
  let currentStep = 1;

  // Platform detection — drives platform-only sections in the HTML.
  // Mac is the default; Windows toggles `is-windows` on the body, which
  // CSS uses to show .platform-win elements and hide .platform-mac ones.
  const ua = (navigator.userAgent || '').toLowerCase();
  const isWindows = ua.indexOf('windows') !== -1;
  if (isWindows) {
    document.body.classList.add('is-windows');
  } else {
    document.body.classList.add('is-mac');
  }

  // v0.9.0: flavor detection — drives the .flavor-mas vs .flavor-dmg-nsis
  // copy split in steps 2 and 5. The is_mas_flavor IPC is registered by
  // BOTH flavors (returns true on MAS, false on DMG/NSIS); the CSS default
  // hides .flavor-mas so if the IPC fails (defensive: shouldn't, but),
  // DMG/NSIS copy still shows. Fire-and-forget: step 1 is the inert
  // "Welcome" screen so the IPC has the user's read time to complete
  // before step 2 (the first flavor-conditional surface) is reached.
  //
  // Use direct __TAURI__.core.invoke here — ClaugeBridge isn't loaded in
  // the onboarding window (separate WebviewWindow with its own asset graph).
  async function initFlavorGate() {
    try {
      if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) {
        return;
      }
      const isMas = await window.__TAURI__.core.invoke('is_mas_flavor');
      if (isMas) {
        document.body.classList.add('is-flavor-mas');
        // Cheap insurance against a slow IPC: if the user has already
        // navigated to a flavor-aware step (2 or 5) before the IPC
        // resolved, re-render that step now so they see the MAS copy
        // instead of the default DMG/NSIS copy.
        if (currentStep === 2 || currentStep === 5) {
          showStep(currentStep);
        }
      }
    } catch (e) {
      // IPC failed — defensive default (CSS hides .flavor-mas) keeps the
      // DMG/NSIS copy visible. Log so we can spot regressions.
      console.warn('[wizard] is_mas_flavor IPC failed; defaulting to non-MAS:', e);
    }
  }
  initFlavorGate();

  // v0.8.1: Clauge Sync Web Store URL — used by the install step.
  const CLAUGE_SYNC_WEB_STORE =
    'https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga';

  // Poll interval while step 4 (Install Clauge Sync) is active. The extension's
  // first heartbeat after Add-to-Chrome typically arrives within 5-10s.
  const EXTENSION_POLL_INTERVAL_MS = 5000;
  let extensionPollId = null;

  function showStep(n) {
    if (n < 1 || n > TOTAL_STEPS) return;
    // Stop step-4 polling if we're leaving step 4.
    if (currentStep === 4 && n !== 4) stopExtensionPoll();

    document.querySelectorAll('.wizard-step').forEach(function (s) {
      s.classList.remove('active');
    });
    var target = document.querySelector('[data-step="' + n + '"]');
    if (target) target.classList.add('active');
    var progress = document.getElementById('wizard-progress');
    if (progress) progress.value = n;
    currentStep = n;

    // Step entry hook: start extension detection when user lands on step 4.
    if (n === 4) onEnterInstallStep();
  }

  function setInstallStatus(status, text) {
    var el = document.getElementById('install-status');
    if (!el) return;
    el.setAttribute('data-status', status);
    el.textContent = text;
  }

  async function checkExtensionStatus() {
    if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) return null;
    try {
      var status = await window.__TAURI__.core.invoke('get_connection_status');
      return status && status.extension === 'active';
    } catch (e) {
      console.warn('[wizard] get_connection_status failed:', e);
      return null;
    }
  }

  function startExtensionPoll() {
    if (extensionPollId !== null) return;
    extensionPollId = setInterval(async function () {
      var active = await checkExtensionStatus();
      if (active) {
        stopExtensionPoll();
        setInstallStatus('installed', 'Installed ✓ Continuing…');
        setTimeout(function () { showStep(5); }, 1000);
      }
    }, EXTENSION_POLL_INTERVAL_MS);
  }

  function stopExtensionPoll() {
    if (extensionPollId !== null) {
      clearInterval(extensionPollId);
      extensionPollId = null;
    }
  }

  async function onEnterInstallStep() {
    // Already-installed shortcut: check once on entry.
    var active = await checkExtensionStatus();
    if (active) {
      setInstallStatus('already-installed', 'Already installed ✓ Continuing…');
      setTimeout(function () { showStep(5); }, 1000);
      return;
    }
    // Not yet — show idle state and wait for user click.
    setInstallStatus('idle', 'Not yet installed.');
  }

  async function invokeAndClose(commandName) {
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        await window.__TAURI__.core.invoke(commandName);
      } else {
        console.warn('[wizard] Tauri IPC unavailable; cannot invoke ' + commandName);
      }
    } catch (err) {
      console.error('[wizard] ' + commandName + ' failed:', err);
    }
    // Rust side closes the window after marking the flag + (optionally)
    // triggering the keychain/credential read. Frontend doesn't need to
    // call .close().
  }

  /**
   * Transitions the Connect button to a "Connecting…" → "Connected ✓" state
   * before firing wizard_complete. Provides visible confirmation that the
   * click was registered + the credential read succeeded, then yields to the
   * Rust-side window close. ~500ms total — fast enough not to feel slow.
   *
   * @param {HTMLButtonElement} btn
   */
  async function connectWithFeedback(btn) {
    // Disable both Connect and Skip while in flight so a double-click
    // doesn't fire wizard_complete + wizard_skip in sequence.
    var skipBtn = document.querySelector('[data-skip]');
    btn.disabled = true;
    if (skipBtn) skipBtn.disabled = true;
    var originalText = btn.textContent;
    btn.textContent = 'Connecting…';
    btn.classList.add('wizard-btn-connecting');

    await invokeAndClose('wizard_complete');

    // Brief success flash before the Rust-side close lands. If the IPC
    // failed (rare on Windows: credentials file missing/unreadable), we
    // still show success — the wizard's job is to mark onboarding_completed;
    // dashboard's Connections panel surfaces any real credential error
    // afterward.
    btn.textContent = 'Connected ✓';
    btn.classList.remove('wizard-btn-connecting');
    btn.classList.add('wizard-btn-connected');
    // No further action — the window closes from the Rust side via
    // wizard_complete's WebviewWindow.close() call. The text flash is
    // visible for the ~100-200ms it takes that close to actually fire.
    void originalText; // keep variable in scope for clarity even if unused
  }

  async function openWebStore() {
    if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) return;
    try {
      // shell:allow-open already granted in v0.8.0 iter 8 capabilities/main.json.
      await window.__TAURI__.core.invoke('plugin:shell|open', { path: CLAUGE_SYNC_WEB_STORE });
    } catch (err) {
      console.error('[wizard] failed to open Web Store:', err);
    }
  }

  // v0.9.0: MAS step-2 Grant Access handler. Calls grant_claude_dir_access
  // IPC, which opens NSOpenPanel pre-pointed at ~/.claude and stores the
  // security-scoped bookmark on Choose. On success advance to step 3; on
  // failure keep the user on step 2 so they can retry. Disable the button
  // while the IPC is in flight to prevent double-grant.
  async function grantFolderAccess(btn) {
    btn.disabled = true;
    try {
      if (!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)) {
        console.warn('[wizard] Tauri IPC unavailable; cannot invoke grant_claude_dir_access');
        return;
      }
      await window.__TAURI__.core.invoke('grant_claude_dir_access');
      // Success: clear any prior dismiss marker (user has now granted) +
      // advance to step 3 (Other Settings).
      try {
        localStorage.removeItem('clauge.claude_dir_grant_dismissed_at');
      } catch (_) { /* localStorage may be unavailable in rare contexts; non-fatal. */ }
      showStep(currentStep + 1);
    } catch (err) {
      console.error('[wizard] grant_claude_dir_access failed:', err);
      // TODO(v0.9.x): surface error in UI. For v0.9.0 MVP, log + leave user
      // on step 2 so they can click Grant Access again or Skip.
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches('[data-next]')) showStep(currentStep + 1);
    else if (t.matches('[data-back]')) showStep(currentStep - 1);
    else if (t.matches('[data-skip]')) invokeAndClose('wizard_skip');
    else if (t.matches('[data-skip-step]')) showStep(currentStep + 1);
    // v0.9.0: data-skip-grant is the MAS step-2 "Skip for now" button. It
    // stores a dismiss marker (so the dashboard's Connections row surfaces
    // the missing grant) then advances. Distinct from data-skip-step
    // because the marker side-effect is grant-specific.
    else if (t.matches('[data-skip-grant]')) {
      try {
        localStorage.setItem('clauge.claude_dir_grant_dismissed_at', Date.now().toString());
      } catch (err) {
        console.warn('[wizard] localStorage.setItem failed for dismiss marker:', err);
      }
      showStep(currentStep + 1);
    }
    // v0.9.0: MAS step-2 Grant Access button. Async — pass the element so
    // the handler can disable/re-enable it.
    else if (t.matches('[data-grant-folder]')) grantFolderAccess(t);
    else if (t.matches('[data-install-extension]')) {
      setInstallStatus('waiting', 'Waiting for installation…');
      openWebStore();
      startExtensionPoll();
    }
    else if (t.matches('[data-connect]')) connectWithFeedback(t);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || currentStep >= TOTAL_STEPS) return;
    // v0.9.0: on MAS step 2, Enter should NOT silently bypass the explicit
    // Grant Access / Skip decision (which sets the dismiss marker on Skip).
    // Force the user to click one of the two buttons. DMG/NSIS step 2 keeps
    // the default Enter-to-advance behavior.
    if (currentStep === 2 && document.body.classList.contains('is-flavor-mas')) return;
    showStep(currentStep + 1);
  });
})();
