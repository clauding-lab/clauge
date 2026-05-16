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

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches('[data-next]')) showStep(currentStep + 1);
    else if (t.matches('[data-back]')) showStep(currentStep - 1);
    else if (t.matches('[data-skip]')) invokeAndClose('wizard_skip');
    else if (t.matches('[data-skip-step]')) showStep(currentStep + 1);
    else if (t.matches('[data-install-extension]')) {
      setInstallStatus('waiting', 'Waiting for installation…');
      openWebStore();
      startExtensionPoll();
    }
    else if (t.matches('[data-connect]')) connectWithFeedback(t);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && currentStep < TOTAL_STEPS) {
      showStep(currentStep + 1);
    }
  });
})();
