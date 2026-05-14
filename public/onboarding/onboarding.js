// Clauge first-launch wizard (v0.7.2).
// 4-step flow culminating in either wizard_complete (triggers keychain read)
// or wizard_skip (closes window without read). Both flag onboarding_completed = true
// so the wizard doesn't re-appear on next launch.

(function () {
  'use strict';

  const TOTAL_STEPS = 4;
  let currentStep = 1;

  function showStep(n) {
    if (n < 1 || n > TOTAL_STEPS) return;
    document.querySelectorAll('.wizard-step').forEach(function (s) {
      s.classList.remove('active');
    });
    var target = document.querySelector('[data-step="' + n + '"]');
    if (target) target.classList.add('active');
    var progress = document.getElementById('wizard-progress');
    if (progress) progress.value = n;
    currentStep = n;
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
    // triggering the keychain read. Frontend doesn't need to call .close().
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches('[data-next]')) showStep(currentStep + 1);
    else if (t.matches('[data-back]')) showStep(currentStep - 1);
    else if (t.matches('[data-skip]')) invokeAndClose('wizard_skip');
    else if (t.matches('[data-connect]')) invokeAndClose('wizard_complete');
  });

  // Keyboard nav: Enter advances on Steps 1-3.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && currentStep < TOTAL_STEPS) {
      showStep(currentStep + 1);
    }
  });
})();
