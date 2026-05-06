/**
 * Clauge Sync — content script for platform.claude.com.
 *
 * The platform's Next.js app embeds the user's organization UUID in many
 * places: the document URL, internal links, fetch URLs, RSC payloads,
 * inline scripts, etc. Most of those are reachable from page-context,
 * but extension service-worker fetches see only the public API surface,
 * which doesn't expose a uuid-listing endpoint.
 *
 * This script runs in the page after load, scans the rendered DOM and
 * any inline JSON for a UUID inside `/api/console/organizations/{uuid}/`,
 * and forwards it to the extension's background worker for use in the
 * credits fetch.
 */

(() => {
  const UUID_RE = /\/api\/console\/organizations\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

  function findUuid() {
    // 1. Check document.documentElement.innerHTML for any URL with the pattern
    try {
      const html = document.documentElement.innerHTML;
      const match = html.match(UUID_RE);
      if (match) return match[1];
    } catch { /* swallow */ }

    // 2. Check anchor hrefs
    for (const a of document.querySelectorAll('a[href*="/api/console/organizations/"]')) {
      const m = a.getAttribute('href').match(UUID_RE);
      if (m) return m[1];
    }

    // 3. Check meta / data attributes
    for (const el of document.querySelectorAll('[data-organization-uuid], [data-org-uuid]')) {
      const v = el.getAttribute('data-organization-uuid') || el.getAttribute('data-org-uuid');
      if (v && /^[a-f0-9-]{36}$/i.test(v)) return v;
    }

    return null;
  }

  function send(uuid) {
    if (!uuid) return;
    try {
      chrome.runtime.sendMessage({ type: 'CL_PLATFORM_UUID', uuid }, () => {
        // Suppress lastError if popup isn't listening — we only care that the
        // background SW received it.
        void chrome.runtime.lastError;
      });
    } catch { /* swallow */ }
  }

  // Run immediately, then again after the SPA fully hydrates (Next.js apps
  // sometimes mount the URL into the DOM only after a tick or two).
  send(findUuid());
  setTimeout(() => send(findUuid()), 1500);
  setTimeout(() => send(findUuid()), 5000);
})();
