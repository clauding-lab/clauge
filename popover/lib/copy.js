// User-facing copy registry lookup (v0.9.4 Phase B.1).
//
// Loaded as a classic script BEFORE popover.js / heatmap.js so window.t is
// available when the renderers run:
//   <script src="lib/copy.js" defer></script>
//   <script src="heatmap.js" defer></script>
//   <script src="popover.js" defer></script>
//
// Usage:
//   t('session.elapsedOf5h', { hours: 3, minutes: 12 })  → "3h 12m of 5h"
//   t('extra.autoReloadOff')                              → "off"
//
// Behavior:
//   - Dot-separated key path into popover/copy.json.
//   - Missing key returns the key itself (so a typo's visible at runtime) +
//     warns to console.error.
//   - {param} placeholders are substituted from the params object. Missing
//     params render as the literal {param} text (visible failure).
//
// Loading model: copy.json is fetched once at script-init via the popover's
// same-origin path. The popover is served by the local sidecar, so the fetch
// is fast and synchronous-feeling. Returns a Promise from t() until the
// fetch settles? No — instead we block the popover render until copy is
// ready via window.__claugeCopyReady (a Promise that callers await once).

(function () {
  'use strict';

  let registry = null;
  let registryPromise = null;

  function fetchCopy() {
    if (registryPromise) return registryPromise;
    registryPromise = fetch('copy.json', { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error('copy.json HTTP ' + res.status);
        return res.json();
      })
      .then((obj) => {
        registry = obj;
        return obj;
      })
      .catch((err) => {
        console.error('[Clauge copy] copy.json load failed; keys will fall back to their dotted paths:', err);
        registry = {};
        return registry;
      });
    return registryPromise;
  }

  function lookup(key) {
    if (!registry || typeof key !== 'string') return key;
    let cur = registry;
    for (const seg of key.split('.')) {
      if (cur && typeof cur === 'object' && seg in cur) cur = cur[seg];
      else return key;
    }
    return typeof cur === 'string' ? cur : key;
  }

  function format(template, params) {
    if (!params || typeof template !== 'string') return template;
    return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, name) => {
      if (Object.prototype.hasOwnProperty.call(params, name)) return String(params[name]);
      return m;
    });
  }

  function t(key, params) {
    if (!registry) {
      console.error('[Clauge copy] t() called before copy.json loaded — key:', key);
      return key;
    }
    return format(lookup(key), params);
  }

  if (typeof window !== 'undefined') {
    window.t = t;
    window.__claugeCopyReady = fetchCopy();
  }
})();
