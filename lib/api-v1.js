// /v1 — Clauge's PUBLIC, versioned loopback JSON API.
//
// External local consumers (the Clauge Widget's `clauge status`, Mission
// Control, shell scripts) read this instead of re-parsing ~/.claude JSONL or
// coupling to the churny internal /api/* routes. The schema is adopted from
// aiusage's normalized provider envelope (spec:
// docs/superpowers/specs/2026-07-16-v1-usage-local-api-design.md §3):
// consumers render blindly on `type` + `label`, so new lines cost nothing.
//
// Contract rules (frozen at apiVersion 1):
// - Envelope is camelCase (providerId, displayName, fetchedAt); line fields
//   are aiusage-compatible (resets_at) for drop-in interop.
// - Every field that would be null is OMITTED from lines (None-dropping),
//   and the snapshot-level `error` key is omitted entirely when absent.
// - GET /v1/usage → 200 array ([] when usage has NEVER been ingested).
// - GET /v1/usage/claude → 200 snapshot | 204 never-ingested |
//   404 {error:"provider_not_found"} for unknown providers.
// - Stale-but-shown: old data is still served, with a `Note` text line
//   stating its age — never a blank response once data has existed.
// - Host check (MANDATORY, not defense-in-depth): /v1 is not in the CORS
//   read allowlist, so a DNS-rebinding page (evil.com → 127.0.0.1) issues
//   what the browser treats as a SAME-ORIGIN request — CORS never engages.
//   Validating the Host header is therefore the primary and only
//   anti-rebinding control for these routes.

import { Hono } from 'hono';

export const V1_API_VERSION = 1;

// Spend/ROI window served on the snapshot — matches /api/roi's default
// (`parseFilters` in server.js) so /v1 can never disagree with the dashboard.
export const V1_ROI_PERIOD = '7d';

// Second, additive ROI window (owner decision, PR-C 2026-07-18): realized
// last-30-days value vs the monthly plan cost — month against month, the
// figure the Clauge Widget renders. Additive per the frozen-contract rules;
// the 7d 'ROI' line above is untouched.
export const V1_ROI_MONTHLY_PERIOD = '30d';

// Data older than this gets the stale `Note` line. The Clauge Sync extension
// posts continuously while a claude.ai tab is open; a longer gap means the
// browser (or the extension) is closed and the reader should know.
const STALE_AFTER_MS = 15 * 60_000;

/**
 * True when the HTTP Host header names the loopback origins this server
 * binds ('127.0.0.1' or 'localhost', optional port). Everything else —
 * including IPv6 forms the server never binds — is rejected.
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || host === '') return false;
  // Host matching is case-insensitive and a single trailing dot is a valid
  // root-anchored FQDN — normalize both, then EXACT-match the loopback names.
  const bare = host
    .replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return bare === '127.0.0.1' || bare === 'localhost';
}

function formatAge(ageMs) {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

/**
 * Pure snapshot builder. Injected inputs, no I/O, no clock reads:
 * - record: the usage-store record ({ ingestedAt, normalized }) or null
 * - roi:    apiReplacementValue() output for the V1_ROI_PERIOD window, or null
 * - roi30d: apiReplacementValue() output for the V1_ROI_MONTHLY_PERIOD
 *           window, or null/omitted (legacy callers) — emits 'ROI (30d)'
 * - nowMs:  caller-injected clock (Date.now() lives in server.js only)
 *
 * Returns the /v1/usage array: [] when usage has never been ingested,
 * else exactly one `claude` provider snapshot.
 */
export function buildV1Usage({ record, roi, roi30d, nowMs }) {
  if (!record) return [];
  const normalized = record.normalized ?? {};
  const lines = [];

  const windows = [
    ['Session', normalized.fiveHour],
    ['Weekly', normalized.sevenDay],
    ['Weekly (Opus)', normalized.sevenDayOpus],
    ['Weekly (Sonnet)', normalized.sevenDaySonnet],
  ];
  for (const [label, window] of windows) {
    if (!window || window.pct == null) continue;
    const line = {
      type: 'progress',
      label,
      used: window.pct,
      limit: 100,
      format: { kind: 'percent' },
    };
    if (window.resetsAt != null) line.resets_at = window.resetsAt;
    lines.push(line);
  }

  // Generic scoped-limit lines (v1.3.6, Task 1's `scopedWindows` parser).
  // Additive per the frozen /v1 contract: dedupe against the legacy
  // per-model emitters above (and against duplicate scoped labels) via the
  // label Set, so a wire label matching an existing metric name (e.g.
  // 'Sonnet') never produces a second 'Weekly (Sonnet)' line.
  const scopedWindows = Array.isArray(normalized.scopedWindows) ? normalized.scopedWindows : [];
  const emittedLabels = new Set(lines.map((line) => line.label));
  for (const entry of scopedWindows) {
    const prefix = entry.group === 'session' ? 'Session' : 'Weekly';
    const label = `${prefix} (${entry.label})`;
    if (emittedLabels.has(label)) continue;
    if (entry.pct == null) continue;
    const line = {
      type: 'progress',
      label,
      used: entry.pct,
      limit: 100,
      format: { kind: 'percent' },
    };
    if (entry.resetsAt != null) line.resets_at = entry.resetsAt;
    lines.push(line);
    emittedLabels.add(label);
  }

  if (roi && roi.apiEquivalentSpend != null) {
    lines.push({
      type: 'text',
      label: 'Spend',
      value: `$${Math.round(roi.apiEquivalentSpend)} this window`,
    });
    if (roi.roiPct != null) {
      // House convention (shared with the iOS snapshot): multiple = roiPct/100.
      lines.push({
        type: 'text',
        label: 'ROI',
        value: `${(roi.roiPct / 100).toFixed(1)}x vs API`,
      });
    }
  }

  // Independent of the 7d block: the monthly line renders even when the
  // weekly roi input is absent.
  if (roi30d && roi30d.roiPct != null) {
    lines.push({
      type: 'text',
      label: 'ROI (30d)',
      value: `${(roi30d.roiPct / 100).toFixed(1)}x vs API`,
    });
  }

  const ingestedMs = record.ingestedAt ? Date.parse(record.ingestedAt) : NaN;
  const ageMs = nowMs - ingestedMs;
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    lines.push({
      type: 'text',
      label: 'Note',
      value: `Data ${formatAge(ageMs)} — Clauge Sync not reporting`,
    });
  }

  return [
    {
      apiVersion: V1_API_VERSION,
      providerId: 'claude',
      displayName: 'Claude',
      plan: null,
      lines,
      fetchedAt: record.ingestedAt ?? null,
    },
  ];
}

/**
 * The /v1 Hono sub-app. `getSnapshots` is injected by server.js (it owns the
 * stores and the clock); this module owns the contract and the Host check.
 */
export function createV1App({ getSnapshots }) {
  const v1 = new Hono();

  v1.use('*', async (c, next) => {
    if (!isLoopbackHost(c.req.header('host'))) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    await next();
  });

  v1.get('/usage', async (c) => c.json(await getSnapshots()));

  v1.get('/usage/:provider', async (c) => {
    if (c.req.param('provider') !== 'claude') {
      return c.json({ error: 'provider_not_found' }, 404);
    }
    const snapshots = await getSnapshots();
    if (snapshots.length === 0) return c.body(null, 204);
    return c.json(snapshots[0]);
  });

  return v1;
}
