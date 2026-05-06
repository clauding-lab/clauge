/**
 * Generate a bookmarklet for syncing claude.ai usage to the local
 * Clauge instance. The bookmarklet runs in the user's claude.ai tab,
 * fetches usage from the same origin (so Cloudflare allows it), and
 * POSTs the result to http://localhost:{port}/api/usage/ingest.
 */

const RAW = `
(async () => {
  const ENDPOINT = 'http://localhost:__PORT__/api/usage/ingest';
  try {
    const orgsRes = await fetch('/api/organizations', { credentials: 'include' });
    if (!orgsRes.ok) throw new Error('orgs ' + orgsRes.status);
    const orgs = await orgsRes.json();
    if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('no orgs');
    const org = orgs[0];
    const usageRes = await fetch('/api/organizations/' + org.uuid + '/usage', { credentials: 'include' });
    if (!usageRes.ok) throw new Error('usage ' + usageRes.status);
    const usage = await usageRes.json();
    // claude.ai prepaid balance — confirmed endpoint shape:
    //   GET /api/organizations/{uuid}/prepaid/credits
    //   { amount, currency, auto_reload_settings, ... }
    let claudeBalance = null;
    try {
      const r = await fetch('/api/organizations/' + org.uuid + '/prepaid/credits', { credentials: 'include' });
      if (r.ok) claudeBalance = await r.json();
    } catch {}

    // API console (platform.claude.com / console.anthropic.com) — endpoint TBD
    let balance = null;
    const apiCandidates = [
      'https://platform.claude.com/api/organizations/' + org.uuid + '/prepaid/credits',
      'https://platform.claude.com/api/organizations/' + org.uuid + '/billing',
      'https://platform.claude.com/api/organizations/' + org.uuid + '/credits',
    ];
    for (const p of apiCandidates) {
      try {
        const r = await fetch(p, { credentials: 'include' });
        if (r.ok) { balance = await r.json(); balance.__source = p; break; }
      } catch {}
    }
    const post = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, usage, claudeBalance, balance }),
    });
    if (!post.ok) throw new Error('ingest ' + post.status);
    alert('✓ Synced ' + (org.name || org.uuid) + ' to Clauge.');
  } catch (e) {
    alert('Clauge sync failed: ' + (e && e.message ? e.message : e));
  }
})();
`.trim();

/**
 * Returns the bookmarklet as a `javascript:` href.
 */
export function bookmarkletHref(port) {
  const code = RAW.replace('__PORT__', String(port));
  return 'javascript:' + encodeURIComponent(code);
}

/**
 * Returns the readable source for display in the install instructions.
 */
export function bookmarkletSource(port) {
  return RAW.replace('__PORT__', String(port));
}
