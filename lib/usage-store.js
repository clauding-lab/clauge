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

// Candidate field-name lists for Anthropic features that have been or may be
// renamed between internal codenames and public names. Order: public names
// first, codenames last. First non-null match wins. Mirrors the resolver in
// src-tauri/src/anthropic_oauth.rs (PlanUsage::claude_design, daily_routines).
const DESIGN_KEYS = [
  'seven_day_design',
  'seven_day_claude_design',
  'claude_design',
  'design',
  'seven_day_omelette',
  'omelette',
  'omelette_promotional',
];

const ROUTINES_KEYS = [
  'seven_day_routines',
  'seven_day_claude_routines',
  'claude_routines',
  'routines',
  'routine',
  'seven_day_cowork',
  'cowork',
];

// seven_day_* keys we recognize. Anything seven_day_* NOT here lands in
// unknownSevenDayKeys and signals an Anthropic API schema drift.
const KNOWN_SEVEN_DAY_KEYS = new Set([
  'seven_day',
  'seven_day_oauth_apps',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_design',
  'seven_day_claude_design',
  'seven_day_omelette',
  'seven_day_routines',
  'seven_day_claude_routines',
  'seven_day_cowork',
]);

/**
 * Emit a structured schema-drift warning when a normalized usage object
 * carries unrecognized seven_day_* keys (a new Anthropic weekly bucket the
 * dashboard does not yet support — as "Claude Design" once was). Pure +
 * log-injectable so the ingest path can wire console.warn and tests can
 * assert fire/no-fire. Returns true iff a warning was emitted.
 *
 * @param {{ unknownSevenDayKeys?: string[] } | null} normalized
 * @param {(message: string) => void} log
 * @returns {boolean}
 */
export function unknownKeysWarning(normalized, log) {
  const keys = normalized && Array.isArray(normalized.unknownSevenDayKeys)
    ? normalized.unknownSevenDayKeys
    : [];
  if (keys.length === 0) return false;
  log(
    `[Clauge] schema-drift: ${keys.length} unrecognized seven_day_* key(s) ` +
      `from Anthropic — ${keys.join(', ')}. Dashboard may be incomplete until ` +
      `Clauge adds support.`
  );
  return true;
}

/**
 * Build the quiet Settings notice for unrecognized usage categories, or null
 * when there are none (so the caller hides the row). Pure + node-testable;
 * the dashboard (public/app.js) duplicates this 3-line rule inline because
 * public/ is served over HTTP and cannot import from lib/.
 *
 * @param {string[] | null | undefined} unknownSevenDayKeys
 * @returns {string | null}
 */
export function unknownKeysNoticeText(unknownSevenDayKeys) {
  const n = Array.isArray(unknownSevenDayKeys) ? unknownSevenDayKeys.length : 0;
  if (n === 0) return null;
  const noun = n === 1 ? 'category' : 'categories';
  return `${n} unrecognized usage ${noun} — an update may track it`;
}

function resolveFirstWindow(raw, keys) {
  for (const k of keys) {
    const v = raw[k];
    if (v && typeof v === 'object') return v;
  }
  return null;
}

// A real utilization is a percentage. claude.ai occasionally emits a slight
// overshoot of a limit (e.g. 102%), which we clamp to 100. Anything above this
// ceiling is unit-drift garbage (a live probe saw 99999): clamping it to 100
// would fire a FALSE "limit reached" notification, so it must degrade to null
// instead — a state every consumer already handles (engine skips null pct, the
// tray shows a placeholder).
const MAX_PLAUSIBLE_PCT = 200;

/**
 * Coerce and range-check a raw `utilization` value into a plausible percentage.
 * Accepts finite numbers and numeric strings; values in [0, 100] pass through,
 * (100, MAX_PLAUSIBLE_PCT] clamp to 100, and everything else → null.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function sanitizePct(value) {
  const n =
    typeof value === 'number' ? value
    : typeof value === 'string' ? Number(value)
    : NaN;
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > MAX_PLAUSIBLE_PCT) return null;
  return n > 100 ? 100 : n;
}

/**
 * Keep a `resets_at` value only when it is a string that parses to a real date.
 * Returns the string unchanged (identity — downstream dedup keys embed the exact
 * string) or null for non-strings and unparseable strings.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function sanitizeResetsAt(value) {
  if (typeof value !== 'string') return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * Normalize the raw claude.ai usage response into a simpler dashboard shape.
 * Defensive: any field may be missing/null.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = (m) =>
    m && typeof m === 'object'
      ? { pct: sanitizePct(m.utilization), resetsAt: sanitizeResetsAt(m.resets_at) }
      : null;
  const extra = raw.extra_usage;
  const unknownSevenDayKeys = Object.keys(raw).filter(
    (k) => k.startsWith('seven_day_') && !KNOWN_SEVEN_DAY_KEYS.has(k)
  );
  return {
    fiveHour: metric(raw.five_hour),
    sevenDay: metric(raw.seven_day),
    sevenDaySonnet: metric(raw.seven_day_sonnet),
    sevenDayOpus: metric(raw.seven_day_opus),
    // Legacy raw-codename fields preserved for callers that still read them.
    sevenDayOmelette: metric(raw.seven_day_omelette),
    sevenDayCowork: metric(raw.seven_day_cowork),
    // Resolved fields — popover should prefer these. They walk the candidate
    // list (public name first, codenames last) so the bar keeps rendering
    // when Anthropic renames the underlying field.
    claudeDesign: metric(resolveFirstWindow(raw, DESIGN_KEYS)),
    dailyRoutines: metric(resolveFirstWindow(raw, ROUTINES_KEYS)),
    // Non-empty list = Anthropic added a new seven_day_* window we don't
    // recognize. Surface in the dashboard's debug pane (or warn-log) so we
    // know to add support before users notice silent breakage.
    unknownSevenDayKeys,
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
            pct: sanitizePct(extra.utilization),
            currency: extra.currency ?? 'USD',
            disabledReason: extra.disabled_reason ?? null,
          }
        : null,
  };
}

/**
 * Normalize claude.ai's `overage_spend_limit` payload (consumer Usage credits
 * — the $X spent / $Y monthly limit shown at claude.ai/settings/usage). This
 * is SEPARATE from OAuth-API extra_usage (which is per-org API spend).
 *
 * Endpoint: GET https://claude.ai/api/organizations/{uuid}/overage_spend_limit
 * Shape: { monthly_credit_limit, currency, used_credits, is_enabled }
 *
 * Empirically verified against Adnan's account: values are in CENTS
 * (e.g. 1000 = $10.00, 1960 = $19.60). We divide by 100 to surface dollars.
 *
 * Returns null when no usable data is present.
 */
export function normalizeOverageSpendLimit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const limitCents = Number(raw.monthly_credit_limit);
  const usedCents = Number(raw.used_credits);
  const hasLimit = Number.isFinite(limitCents);
  const hasUsed = Number.isFinite(usedCents);
  if (!hasLimit && !hasUsed) return null;

  const usedDollars = hasUsed ? usedCents / 100 : null;
  const limitDollars = hasLimit ? limitCents / 100 : null;
  let pct = null;
  if (usedDollars != null && limitDollars != null && limitDollars > 0) {
    pct = (usedDollars / limitDollars) * 100;
  }
  return {
    enabled: raw.is_enabled === true,
    usedDollars,
    limitDollars,
    usedCents: hasUsed ? usedCents : null,
    limitCents: hasLimit ? limitCents : null,
    pct,
    currency: raw.currency ?? 'USD',
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
