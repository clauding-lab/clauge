/**
 * Persistent store for claude.ai plan-usage snapshots.
 *
 * Snapshots arrive via POST /api/usage/ingest from the bookmarklet
 * running on claude.ai. We persist to ~/.clauge/usage.json so the
 * dashboard survives server restarts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

function defaultPath() {
  return join(homedir(), '.clauge', 'usage.json');
}

export class UsageStore {
  constructor({ path = defaultPath() } = {}) {
    this.path = path;
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = null;
    }
    return this.cache;
  }

  async save(snapshot) {
    const record = {
      ingestedAt: new Date().toISOString(),
      ...snapshot,
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(record, null, 2), { mode: 0o600 });
    this.cache = record;
    return record;
  }

  async clear() {
    try {
      await writeFile(this.path, '', { mode: 0o600 });
    } catch {
      /* ignore */
    }
    this.cache = null;
  }
}

/**
 * Normalize the raw claude.ai usage response into a simpler dashboard shape.
 * Defensive: any field may be missing/null.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = (m) =>
    m && typeof m === 'object'
      ? { pct: m.utilization ?? null, resetsAt: m.resets_at ?? null }
      : null;
  const extra = raw.extra_usage;
  return {
    fiveHour: metric(raw.five_hour),
    sevenDay: metric(raw.seven_day),
    sevenDaySonnet: metric(raw.seven_day_sonnet),
    sevenDayOpus: metric(raw.seven_day_opus),
    sevenDayOmelette: metric(raw.seven_day_omelette),
    sevenDayCowork: metric(raw.seven_day_cowork),
    extraUsage:
      extra && typeof extra === 'object'
        ? {
            enabled: extra.is_enabled === true,
            limitCents: extra.monthly_limit ?? null,
            usedCents: extra.used_credits ?? null,
            limitDollars:
              extra.monthly_limit != null ? extra.monthly_limit / 100 : null,
            usedDollars:
              extra.used_credits != null ? extra.used_credits / 100 : null,
            pct: extra.utilization ?? null,
            currency: extra.currency ?? 'USD',
            disabledReason: extra.disabled_reason ?? null,
          }
        : null,
  };
}

/**
 * Extract a balance summary from a heterogeneous billing/credits/account
 * payload. Handles the claude.ai /prepaid/credits shape:
 *   { amount, currency, auto_reload_settings, ... }
 * plus other candidate field names from probed endpoints.
 */
export function normalizeBalance(rawBalance, org) {
  const sources = [];
  if (rawBalance && typeof rawBalance === 'object') sources.push(rawBalance);
  if (org && typeof org === 'object') {
    sources.push(org);
    if (org.billing) sources.push(org.billing);
    if (org.credits) sources.push(org.credits);
    if (org.account) sources.push(org.account);
  }

  for (const s of sources) {
    // Cents-form fields, in order of likelihood
    const cents =
      s.amount ??                 // claude.ai /prepaid/credits
      s.current_balance_cents ??
      s.balance_cents ??
      s.credits_cents ??
      null;

    // Dollar-form fields (rare — sometimes APIs return precomputed dollars)
    const explicitDollars =
      s.current_balance_dollars ??
      s.balance_dollars ??
      null;

    let dollars = null;
    if (explicitDollars != null) {
      dollars = explicitDollars;
    } else if (cents != null && Number.isFinite(cents)) {
      dollars = cents / 100;
    }

    if (dollars == null) continue;

    // auto_reload_settings: claude.ai uses null when off; an object when on.
    const reload =
      s.auto_reload_settings ??
      s.auto_reload ??
      s.autoReload ??
      null;
    const enabled =
      reload != null && typeof reload === 'object'
        ? reload.enabled !== false
        : reload === true || s.auto_reload_enabled === true;
    const reloadAmount =
      reload && typeof reload === 'object'
        ? (reload.amount_cents != null ? reload.amount_cents / 100
           : reload.amount != null ? reload.amount
           : null)
        : null;

    return {
      currentBalance: dollars,
      currency: s.currency ?? 'USD',
      autoReloadEnabled: enabled,
      autoReloadAmount: reloadAmount,
    };
  }
  return null;
}
