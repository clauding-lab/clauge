# Design: Auto-detect Claude plan tier + auto-fill the ROI cost field

- **Status:** Designed (brainstorm complete). **DEFERRED INDEFINITELY** — owner decision 2026-06-02 (no monetization/pricing push near-term; revisit only if that reopens). Committed for the record 2026-06-10.
- **Date:** 2026-05-30
- **Owner:** Adnan (vibe-direct) / Claude
- **Branch when built:** `feat/plan-autodetect` (NOT part of the MAS resubmission PR #11)

## Problem

The ROI calculation needs the user's monthly Claude plan cost. Today it's a static value
(`SUBSCRIPTION_COST`, default `200`, env-sourced at `server.js:65`) shown in a **read-only**
field labelled "Subscription cost (monthly)" (`public/index.html:409-412`). Users on Pro / Max 5×
see a wrong number and can't tell where it came from. We want Clauge to detect the user's actual
plan and pre-fill a sensible, **editable** cost — without making the UI read like a subscription
the app sells (App Store Guideline 3.1.1 sensitivity).

## Key finding (grounded)

The plan tier is **already local and already parsed** — no OAuth session or browser extension needed:

- `src-tauri/src/keychain.rs:66` → `subscription_type: Option<String>` — `"max"` / `"pro"` / `"free"`
- `src-tauri/src/keychain.rs:69` → `rate_limit_tier: Option<String>` — e.g. `"default_claude_max_20x"`, `"default_claude_max_5x"`

These come from the Claude Code keychain credential Clauge already reads for auth, on **both flavors**
(DMG reads Keychain directly; MAS reads via the granted `~/.claude` bookmark / Keychain fallback —
`keychain.rs:131-143`). They are **not** surfaced to the UI today (the popover badge *guesses* "Max" at
`popover/popover.js:330-340`).

What Anthropic does **not** give us is the dollar price — that stays a small Clauge-maintained
tier→price table. The claude.ai OAuth `/api/oauth/usage` endpoint has **no** tier field (confirmed:
`PlanUsage` / `UtilizationWindow` in `anthropic_oauth.rs` carry only utilization % + reset times).

## Tier → default monthly price map  ← CONFIRM these values with Adnan

Keyed primarily off `rate_limit_tier`, falling back to `subscription_type`:

| subscription_type | rate_limit_tier (contains) | Plan label | Default $/mo (USD) |
|---|---|---|---|
| `free` | — | Free | 0 (ROI undefined) |
| `pro` | `pro` / absent | Claude Pro | 20 |
| `max` | `max_5x` | Claude Max 5× | 100 |
| `max` | `max_20x` | Claude Max 20× | 200 |
| `team`/`enterprise`/unknown | * | (unknown) | → manual fallback, no auto-fill |

> Exact `rate_limit_tier` strings to verify against live creds: Max 20× is confirmed
> `default_claude_max_20x` (keychain.rs test fixture); Max 5× assumed `default_claude_max_5x`;
> Pro string unconfirmed — match on `subscription_type == "pro"` as the safety net.

## UX (chosen: "Show plan, auto-fill, editable")

Settings → **Plan & ROI** (renamed from "Pricing & ROI"):

```
Your Claude plan          Max 20×  (detected)
What you pay Anthropic — used only for ROI math.

Monthly plan cost         [ $200.00 ]  edit
Detected from your Claude Code login.
Clauge never sells plans or processes payments.
```

- Detected plan name + mapped price shown; price **auto-fills but is editable** (field becomes
  editable — drop the current `readonly`).
- **Manual override persists:** if the user edits the value, a `subscription_cost_overridden` flag is
  set; subsequent re-detection does NOT overwrite their value (it still updates the *displayed plan name*).
- **Fallback** (no login / Team / unknown tier): no plan line; field shows the manual default ($200),
  fully editable — i.e. today's behavior.

## Data flow / plumbing

1. **Rust:** expose `subscription_type` + `rate_limit_tier` from the read credential. Either via the
   existing connection/health path or a small dedicated IPC (`get_plan_tier`) — prefer threading into
   the existing `/api/health` or connection payload to avoid a new IPC + the triple-registration
   landmine (lib.rs invoke_handler + build.rs APP_COMMANDS + capabilities/main.json).
2. **Sidecar (`server.js`):** add a `planTier` field (label + rawTier + mappedDefaultCost) to the
   health/usage payload. Keep `SUBSCRIPTION_COST` env as the ultimate fallback. Map lives in a new
   `lib/plan-pricing.js` (pure, unit-tested).
3. **Frontend (`public/app.js` ~835, `public/index.html` Plan & ROI panel):** render the detected plan
   line; auto-fill the (now editable) cost input unless `subscription_cost_overridden`. Persist
   override + custom cost (store).
4. **Popover:** opportunistically replace the `renderPlanBadge` guess (`popover.js:330`) with the real
   tier label (same source). Nice-to-have, same PR.

## Units / isolation

- `lib/plan-pricing.js` — pure function `tierToPlan({ subscriptionType, rateLimitTier }) → { label, defaultCostUsd } | null`. Independently testable; no I/O.
- Keychain field surfacing — Rust, reuses the existing read; no new keychain prompt.
- Frontend render + override persistence — isolated in the Plan & ROI panel logic.

## Testing

- Unit: `plan-pricing.js` — every tier string → correct label/price; unknown → null; Max 5× vs 20×.
- Unit: override-persistence — edited value survives a re-detection; non-edited value tracks detection.
- Manual: real Mac with a Max 20× login → field shows "Max 20× · $200, detected"; Pro login → $20.

## Out of scope (YAGNI)

- Live price scraping from anthropic.com (prices change rarely; a static map is fine).
- Team/Enterprise per-seat math (manual fallback).
- Currency conversion (Anthropic bills USD; field stays USD).

## 3.1.1 note

Showing "your existing Claude plan, detected from your login" + "Clauge never sells plans or
processes payments" *strengthens* the "passive observer of an externally-purchased subscription"
framing. It must never present a buy/upgrade CTA.
