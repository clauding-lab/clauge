/**
 * Clauge Sync — background service worker.
 *
 * Periodically fetches claude.ai plan usage from the user's authenticated
 * session and POSTs the snapshot to the local Clauge instance running at
 * http://localhost:{port}/api/usage/ingest.
 *
 * The fetch happens from the extension's privileged origin which has
 * host_permissions for claude.ai — so cookies (sessionKey, __cf_bm) are
 * automatically included by the browser, and Cloudflare allows the call
 * because it's coming from a real, authenticated browser context.
 */

const ALARM_NAME = 'clauge-sync';
const DEFAULT_PORT = 3456;
const DEFAULT_INTERVAL_MIN = 1;
const STORAGE_KEYS = {
  port: 'cl_port',
  intervalMin: 'cl_interval_min',
  lastResult: 'cl_last_result',
  // v0.1.9: last-good cache for balance fetches that fail transiently.
  lastGoodClaudeBalance: 'cl_last_good_claude_balance',
  lastGoodApiBalance: 'cl_last_good_api_balance',
};
// v0.1.9: a last-good balance is considered usable for this long after the
// fetch that produced it. Past this, a continuing fetch failure means the
// stored value is too stale to be trusted, and we let the server overwrite
// with null. 6h covers normal day-of-use windows + overnight outages.
const LAST_GOOD_TTL_MS = 6 * 60 * 60 * 1000;
// v0.1.9: retry-once on non-2xx with a short backoff. Most transient
// Cloudflare/Anthropic blips clear in under 1s — a single retry catches
// the common case without slowing successful syncs.
const RETRY_BACKOFF_MS = 500;

async function fetchWithRetry(url, init, probeLog, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, init);
      probeLog.push(`${label} → ${r.status} ${r.statusText}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      if (r.ok) return { ok: true, response: r };
      if (attempt === 1 && r.status >= 500) {
        // Server-side transient — back off briefly and retry once.
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        continue;
      }
      return { ok: false, response: r };
    } catch (e) {
      probeLog.push(`${label} threw: ${String(e?.message ?? e)}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
        continue;
      }
      return { ok: false, error: e };
    }
  }
  return { ok: false };
}

async function readLastGood(storageKey) {
  try {
    const stored = await chrome.storage.local.get(storageKey);
    const cached = stored?.[storageKey];
    if (!cached || !cached.data || !cached.fetchedAt) return null;
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age > LAST_GOOD_TTL_MS) return null;
    return { data: cached.data, fetchedAt: cached.fetchedAt };
  } catch {
    return null;
  }
}

async function writeLastGood(storageKey, data) {
  try {
    await chrome.storage.local.set({
      [storageKey]: { data, fetchedAt: new Date().toISOString() },
    });
  } catch {
    /* ignore — best-effort cache */
  }
}

async function getSettings() {
  const all = await chrome.storage.local.get([
    STORAGE_KEYS.port,
    STORAGE_KEYS.intervalMin,
  ]);
  return {
    port: Number(all[STORAGE_KEYS.port] ?? DEFAULT_PORT),
    intervalMin: Number(all[STORAGE_KEYS.intervalMin] ?? DEFAULT_INTERVAL_MIN),
  };
}

async function setLastResult(record) {
  await chrome.storage.local.set({ [STORAGE_KEYS.lastResult]: record });
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* ignore */
  }
}

async function syncOnce() {
  const startedAt = new Date().toISOString();
  const { port } = await getSettings();
  const ingestUrl = `http://localhost:${port}/api/usage/ingest`;

  let result;
  try {
    const orgsRes = await fetch('https://claude.ai/api/organizations', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!orgsRes.ok) throw new Error(`orgs ${orgsRes.status}`);
    const orgs = await orgsRes.json();
    if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('no orgs');
    const org = orgs[0];

    const usageRes = await fetch(
      `https://claude.ai/api/organizations/${encodeURIComponent(org.uuid)}/usage`,
      { credentials: 'include', cache: 'no-store' }
    );
    if (!usageRes.ok) throw new Error(`usage ${usageRes.status}`);
    const usage = await usageRes.json();

    // claude.ai prepaid balance — confirmed endpoint:
    //   GET /api/organizations/{uuid}/prepaid/credits
    //   { amount, currency, auto_reload_settings, ... }
    //
    // v0.1.9: retry-once on non-2xx, fall back to last-good cache within
    // 6h on persistent failure. Eliminates the transient-null-overwrite
    // problem that left the dashboard's CLAUDE.AI BALANCE card empty
    // between successful syncs in v0.1.7.
    const ouuid = encodeURIComponent(org.uuid);
    let claudeBalance = null;
    let claudeBalanceStale = false;
    const prepaidProbeLog = [];
    const prepaidUrl = `https://claude.ai/api/organizations/${ouuid}/prepaid/credits`;
    prepaidProbeLog.push(`prepaid GET ${prepaidUrl}`);
    const prepaidResult = await fetchWithRetry(
      prepaidUrl,
      { credentials: 'include', cache: 'no-store' },
      prepaidProbeLog,
      'prepaid'
    );
    if (prepaidResult.ok) {
      try {
        claudeBalance = await prepaidResult.response.json();
        prepaidProbeLog.push(
          `prepaid amount: ${claudeBalance?.amount ?? 'missing'} ${claudeBalance?.currency ?? ''}`
        );
        if (claudeBalance && claudeBalance.amount != null) {
          await writeLastGood(STORAGE_KEYS.lastGoodClaudeBalance, claudeBalance);
        }
      } catch (parseErr) {
        prepaidProbeLog.push(`prepaid JSON parse error: ${String(parseErr?.message ?? parseErr)}`);
      }
    } else if (prepaidResult.response) {
      try {
        const bodySnippet = (await prepaidResult.response.text()).slice(0, 300);
        prepaidProbeLog.push(`prepaid body (first 300): ${bodySnippet}`);
      } catch {
        /* ignore */
      }
    }
    // Fall back to last-good if fetch didn't yield a balance this sync.
    if (!claudeBalance) {
      const cached = await readLastGood(STORAGE_KEYS.lastGoodClaudeBalance);
      if (cached) {
        claudeBalance = cached.data;
        claudeBalanceStale = true;
        prepaidProbeLog.push(
          `prepaid using last-good from ${cached.fetchedAt} (age ${Math.round((Date.now() - new Date(cached.fetchedAt).getTime()) / 1000)}s)`
        );
      } else {
        prepaidProbeLog.push('prepaid no last-good available (no cache or older than 6h)');
      }
    }

    // API console balance — confirmed endpoint shape:
    //   GET https://platform.claude.com/api/console/organizations/{platform-uuid}/credits
    //   { amount, currency, auto_reload_settings, ... }
    // The platform org UUID is *different* from claude.ai's. The extension's
    // content-platform.js extracts it from any page the user visits on
    // platform.claude.com and stores it in chrome.storage.local under
    // cl_platform_uuid. We use that first; fallback to API discovery.
    let balance = null;
    const balanceProbeLog = [];
    let platformUuid = null;

    try {
      const stored = await chrome.storage.local.get('cl_platform_uuid');
      if (stored?.cl_platform_uuid) {
        platformUuid = stored.cl_platform_uuid;
        balanceProbeLog.push(`uuid (from content script): ${platformUuid}`);
      }
    } catch { /* swallow */ }

    if (!platformUuid) {
      const discoveryPaths = [
        'https://platform.claude.com/api/console/organizations',
        'https://platform.claude.com/api/console/me',
        'https://platform.claude.com/api/console/account/me',
        'https://platform.claude.com/api/me',
        'https://platform.claude.com/api/organizations',
      ];
      for (const path of discoveryPaths) {
        try {
          const r = await fetch(path, { credentials: 'include', cache: 'no-store' });
          balanceProbeLog.push(`${path} → ${r.status}`);
          if (!r.ok) continue;
          const data = await r.json();
          const found =
            (Array.isArray(data) && data[0]?.uuid) ||
            data?.uuid ||
            data?.organization?.uuid ||
            data?.organizations?.[0]?.uuid ||
            data?.org_uuid ||
            null;
          if (found) {
            platformUuid = found;
            balanceProbeLog.push(`uuid: ${platformUuid}`);
            break;
          }
          balanceProbeLog.push(`(no uuid in response — keys: ${Object.keys(data || {}).join(',')})`);
        } catch (e) {
          balanceProbeLog.push(`${path} → error: ${String(e?.message || e)}`);
        }
      }
    }
    if (!platformUuid) {
      balanceProbeLog.push('no uuid — visit platform.claude.com once to populate');
    }

    if (platformUuid) {
      const url = `https://platform.claude.com/api/console/organizations/${encodeURIComponent(platformUuid)}/credits`;
      try {
        const cr = await fetch(url, { credentials: 'include', cache: 'no-store' });
        balanceProbeLog.push(`${url} → ${cr.status}`);
        if (cr.ok) {
          balance = await cr.json();
          balance.__source = url;
        }
      } catch (e) {
        balanceProbeLog.push(`credits fetch error: ${String(e?.message || e)}`);
      }
    }
    // expose probe trail to popup for debugging. v0.1.8: prepend the
    // prepaid probe so the popup's "Balance probe log" shows BOTH the
    // claude.ai prepaid fetch and the platform.claude.com balance fetch.
    const combinedProbeLog = [
      ...prepaidProbeLog,
      '--- platform.claude.com ---',
      ...balanceProbeLog,
    ];
    await chrome.storage.local.set({ cl_balance_probe: combinedProbeLog });
    console.log('[Clauge Sync] balance probe:', combinedProbeLog);

    const post = await fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org, usage, claudeBalance, balance }),
    });
    if (!post.ok) throw new Error(`ingest ${post.status}`);

    const sessionPct = usage?.five_hour?.utilization;
    result = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      orgName: org.name ?? null,
      orgUuid: org.uuid ?? null,
      sessionPct: typeof sessionPct === 'number' ? sessionPct : null,
    };
    if (result.sessionPct != null) {
      await setBadge(`${Math.round(result.sessionPct)}%`, '#34c759');
    } else {
      await setBadge('OK', '#34c759');
    }
  } catch (err) {
    result = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: String(err?.message ?? err),
    };
    await setBadge('!', '#ff3b30');
  }

  await setLastResult(result);
  return result;
}

async function ensureAlarm() {
  const { intervalMin } = await getSettings();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== intervalMin) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.1,
      periodInMinutes: intervalMin,
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarm();
  syncOnce();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncOnce();
});

// Popup or options page can request an immediate sync.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CLAUGE_SYNC_NOW') {
    syncOnce().then(sendResponse);
    return true;
  }
  if (message?.type === 'CLAUGE_GET_LAST') {
    chrome.storage.local
      .get([STORAGE_KEYS.lastResult, STORAGE_KEYS.port, STORAGE_KEYS.intervalMin])
      .then((all) =>
        sendResponse({
          last: all[STORAGE_KEYS.lastResult] ?? null,
          port: all[STORAGE_KEYS.port] ?? DEFAULT_PORT,
          intervalMin: all[STORAGE_KEYS.intervalMin] ?? DEFAULT_INTERVAL_MIN,
        })
      );
    return true;
  }
  // Content script reports the platform.claude.com org UUID it discovered
  // by scanning the page DOM. Persist it so background syncs can reach the
  // credits endpoint without trying to discover the UUID via the API.
  if (message?.type === 'CL_PLATFORM_UUID' && message.uuid) {
    chrome.storage.local.set({ cl_platform_uuid: message.uuid }).then(() => {
      // Trigger a fresh sync so the balance card populates immediately
      // instead of waiting for the next 1-min tick.
      syncOnce();
    });
    return false;
  }
});
