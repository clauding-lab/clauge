# Desktop Alerts + Tray (Active-Guardrail Sub-Project B) — Design

**Date:** 2026-06-12
**Status:** Approved in brainstorm (Adnan, 2026-06-12). Parent: `2026-06-12-clauge-active-guardrail-roadmap.md` (merged PR #36). Builds on Sub-Project A (`2026-06-12-on-device-projection-design.md`, merged — `GET /api/projection`).
**Scope:** Desktop. Notifications ship on **Mac AND Windows**; the tray cue + quick-toggle ship **Mac-first** (Windows tray = tracked follow-up).

---

## What this ships

Clauge becomes an *active* guardrail — it warns you without a window open:

1. **Local OS notifications** on three usage events, fired by an always-on background timer:
   - **Approaching a limit** — a watched window crosses **80%** then **95%**.
   - **Will hit before reset** — the projection says you're on pace to run out before the window resets.
   - **Limit reached** — a window hits 100%.
2. **Per-type config** in the dashboard Settings — a master "Alerts" toggle plus a checkbox per alert type. Defaults: all on.
3. **Menu-bar cue + quick toggle** (macOS) — a ⚠ prefix on the tray title when a watched window is past its threshold, and an "Alerts: On/Off" menu item.

Watched windows = the two hero windows: **fiveHour** and **sevenDay**.

### Decisions locked in the brainstorm

| Fork | Decision |
|---|---|
| Alert set | Approaching (80/95) + will-hit + limit-reached. **ROI-pace<1× deferred** (noisiest, least urgent). |
| Config depth | Master toggle + per-type toggles. Fixed thresholds (80/95), fixed watched windows. No editable thresholds, no quiet hours. |
| Tray role | Quick toggle **and** ⚠ warning cue (macOS). Full config in the dashboard. |
| Platform reach | Notifications Mac **+** Windows. Tray cue + toggle **Mac-first**; Windows tray deferred. |
| Where the brain lives | **Sidecar decides, Rust fires** (Approach 1). Threshold + forecast logic stays in JS next to the projection engine; cross-platform for free; the Rust side is a thin firer. |

No new dependency: `tauri-plugin-notification` is already a dep (`src-tauri/Cargo.toml:48`) and already used (`src-tauri/src/ipc.rs:300-327`); `notification:default` is granted (`capabilities/main.json:18`).

---

## Architecture

```
sidecar (always-on)                              Rust parent (always-on)
  ingest → usage-store + buildProjection (A)        NEW cross-platform alert timer (30s)
        │                                                 │
  lib/alert-engine.js (NEW, pure)  ◀─prefs── config-store  │
    evaluate({usage, projection, prefs, fired, nowMs})     │
        │                                                  │
  GET  /api/alerts/pending  ───────────────────────▶  fire each via
  POST /api/alerts/ack      ◀───────────────────────  app.notification() (ipc.rs pattern)
        │                                                  │
  ~/.clauge/alert-state.json (NEW, fired markers)    macOS title poller (existing) + ⚠ cue
                                                     macOS NSMenu "Alerts: On/Off" (NEW)
```

Both the sidecar and the Rust parent run continuously regardless of open windows; only the webview is ephemeral. The decision lives in the always-on sidecar; the firing in the always-on Rust parent. Clock injected (`nowMs` a parameter in lib/, `Date.now()` only at the sidecar endpoint + Rust timer boundary).

---

## Component 1 — `lib/alert-engine.js` (new, pure ESM module)

No I/O, no DOM, no clock. `evaluate({ usage, projection, prefs, fired, nowMs })` returns `{ due: Alert[], retire: string[] }`:
- `usage` — the normalized plan (`{ fiveHour:{pct,resetsAt}, sevenDay:{...}, ... }`) from the usage store.
- `projection` — the `buildProjection` result (windows + freshness).
- `prefs` — `{ alertsEnabled, types:{ approaching, willHit, limitReached } }`.
- `fired` — `Set<string>` of dedup keys already fired (from alert-state).
- Returns `due` (alerts to fire now) and `retire` (keys to mark fired WITHOUT firing — the severity-collapsed lesser alerts).

### Alert types, watched windows, dedup keys

For each watched window `w ∈ { fiveHour, sevenDay }`, with the window's `resetsAt` as the instance id:

| Type | Condition | Levels | Dedup key |
|---|---|---|---|
| `limitReached` | `pct ≥ 100` or projection `state === 'exhausted'` | — | `limitReached:{w}:{resetsAt}` |
| `willHit` | projection `state === 'will_hit'` | — | `willHit:{w}:{resetsAt}` |
| `approaching` | `pct ≥ level` | 95, 80 | `approaching:{w}:{level}:{resetsAt}` |

Because every key embeds `resetsAt`, a **new window instance re-arms all alerts automatically** — no cooldown timers. `resetsAt` null/absent for a window → that window is skipped entirely.

### Severity collapse (anti-spam)

Per window, order due candidates by severity: `limitReached > willHit > approaching:95 > approaching:80`. **At most one fires per window per evaluation** — the highest-severity due-and-unfired one goes in `due`; every *lower* due-and-unfired candidate for that window goes in `retire` (marked fired so it never trickles out later). Once warned at a higher severity, the lesser alerts for that window are spent.

### Gating

- `prefs.alertsEnabled === false` → return `{ due: [], retire: [] }` (nothing, nothing retired — flipping back on still works).
- A disabled type is neither fired nor retired (it simply doesn't participate).
- **Stale data** (`projection.freshness.stale === true`) → `{ due: [], retire: [] }`. A forecast or pct from >10-min-old data is unreliable; mirrors A's display suppression.

### Alert payload

Each `due` alert: `{ id (the dedup key), type, window, title, body }`. Bodies are built here with **local-time** strings (the sidecar runs on the user's machine, so `new Date(etaAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})` is the user's local time). Examples:
- approaching: title `"Clauge — 5-hour limit at 82%"`, body `"You're past 80% of your 5-hour window. Resets ~3:40 PM."`
- willHit: title `"Clauge — on pace to run out"`, body `"At this rate your weekly limit runs out ~Thu 9 PM, before it resets."`
- limitReached: title `"Clauge — 5-hour limit reached"`, body `"You've hit your 5-hour limit. Resets ~3:40 PM."`

(Window labels: fiveHour → "5-hour", sevenDay → "weekly".)

---

## Component 2 — `~/.clauge/alert-state.json` (new, sidecar-owned)

The fired-key set, so an alert fires once per window-instance even across restarts.

- **Shape:** `{ "v": 1, "fired": ["approaching:fiveHour:80:2026-06-12T14:20:00+00:00", ...] }`.
- **Persistence:** atomic tmp + rename (the config-store pattern). Sidecar-owned → no `settings.json` clobber (landmine #40).
- **Prune:** on each load/evaluate, drop keys whose embedded `resetsAt` is in the past (window already reset) — bounds the file. A key with an unparseable `resetsAt` is dropped defensively.
- **Read tolerance:** missing/corrupt file → empty set (no alert ever fired). Never throws to the caller.
- A small wrapper class `AlertState { load(), markFired(keys), prune(nowMs) }` in `lib/alert-state.js`.

---

## Component 3 — alert prefs in `lib/config-store.js` (extended)

The config file gains alert prefs **alongside** subscription cost. **`ConfigStore` is refactored to read-merge-write** — today `setSubscriptionCost` rewrites the whole file (`{v:1, subscriptionCost}`), which would clobber alert prefs (and vice-versa). New private `readAll()` / `writeAll(obj)` merge so unrelated keys survive every write.

- **Shape:** `{ "v": 1, "subscriptionCost": 200, "alerts": { "enabled": true, "types": { "approaching": true, "willHit": true, "limitReached": true } } }`.
- **Reads:** `effectiveAlertPrefs()` → `{ alertsEnabled, types }`, defaulting every field to `true` (a missing/corrupt `alerts` block = all-on). Validation: each flag coerced to boolean; non-boolean → default `true`.
- **Writes:** `setAlertPrefs(partial)` merges into the existing `alerts` block (so toggling one type preserves the others), validates booleans, atomic write. `setSubscriptionCost` is migrated to the same merge path (preserving `alerts`).
- **Endpoint:** `POST /api/config/alerts` with body `{ enabled?: boolean, types?: { approaching?, willHit?, limitReached? } }` (400 on a non-boolean field); returns the effective prefs. `GET /api/config` additionally reports `alerts`.

---

## Component 4 — two endpoints + the Rust firer

### `GET /api/alerts/pending` (pure read)

Consumed only by the Rust `LOCAL_CLIENT` (an `Origin`-less loopback request, so CORS never applies — it does **not** need to be in `READ_ONLY_API_PATHS`; the webview never reads it). Internally: read usage store + `buildProjection` (same inputs `/api/projection` uses) + `effectiveAlertPrefs()` + `AlertState.load()` (pruned), call `evaluate(...)`, and return `{ due: Alert[], retire: string[] }`. **No side effect** — nothing is marked fired on this read; all mutation happens in the ack, so a Rust crash before firing re-fires next tick (at-least-once for real notifications).

### `POST /api/alerts/ack`

Body `{ "fired": ["<id>", ...], "retired": ["<id>", ...] }`. Marks both sets fired in alert-state in one atomic write (`fired` = alerts Rust attempted to show; `retired` = the severity-collapsed lesser keys Rust never shows but that are spent). 400 on a non-array field. Idempotent. Splitting read (GET) from mutation (POST ack) keeps the GET pure; the cost is that a Rust crash between GET and ack also drops the retires, so a lesser alert could fire after a higher one once — a rare, still-valid extra warning (acceptable).

### The Rust firer — `spawn_alert_poller` (new, cross-platform)

A new `tauri::async_runtime::spawn` timer (every 30s, `MissedTickBehavior::Delay`), **not** `#[cfg(target_os = "macos")]` (Windows needs it). Each tick: GET `/api/alerts/pending` via `LOCAL_CLIENT` → `{ due, retire }`; for each `due` alert, `app.notification().builder().title(a.title).body(a.body).show()` (the `ipc.rs:300` pattern), collecting the ids it **attempted** (fired or errored — a permission-denied notification must not retry-spam every 30s; log failures via `log::warn!`); then POST `/api/alerts/ack { fired: attemptedDueIds, retired: retire }`. A tick with an empty `due` **and** empty `retire` skips the ack POST entirely. Server-port resolution mirrors the existing title poller (`AppState.server_port`). Lives in a new cross-platform `src-tauri/src/alerts.rs` with the spawn fn, called from `lib.rs` setup (NOT gated on macOS).

---

## Component 5 — tray cue + quick toggle (macOS-first)

- **⚠ cue:** the existing macOS title poller (`native_popover.rs::spawn_tray_title_poller`, reads `plan.fiveHour.pct`) is extended to also read `sevenDay.pct`, and prefix the title with `⚠ ` when **either watched window's `pct ≥ 80`** (the approaching zone). A pure helper `fn tray_warning_prefix(five_pct, seven_pct) -> &'static str` (returns `"⚠ "` or `""`) is `#[cfg(test)]`-unit-tested (the `sync_health.rs` precedent). The title becomes e.g. `"⚠ 82%"`.
- **Quick toggle:** the macOS NSMenu gains an "Alerts: On/Off" item (checkmark reflects current `alerts.enabled`). Its action POSTs `/api/config/alerts { enabled: !current }` via `LOCAL_CLIENT` and refreshes the checkmark. Menu construction lives where the existing NSMenu items (Quit, Open Dashboard) are built in `native_popover.rs`.
- **Windows:** the system-tray equivalents (cue + toggle) are a **tracked follow-up** — Windows still gets every notification via the cross-platform firer.

---

## Data flow (end to end)

1. Extension ingest (≈1/min) keeps usage + projection current (sub-project A, unchanged).
2. Every 30s the Rust alert poller GETs `/api/alerts/pending`. The sidecar evaluates and returns due alerts; spent lesser alerts are persisted as retired immediately.
3. Rust fires each notification, then acks the attempted ids → sidecar marks them fired.
4. Next tick the fired keys suppress repeats; a new window (new `resetsAt`) re-arms.
5. The macOS title poller independently paints `pct` + ⚠ cue; the NSMenu toggle flips the master pref.

## Error handling (consolidated)

| Failure | Behavior |
|---|---|
| Stale data (>10 min) | no alerts fire (engine returns empty) |
| Window `resetsAt` null/absent | that window skipped |
| Several alerts due at once (same window) | only the highest severity fires; lesser ones retired |
| Notification `show()` fails (permission denied / OS) | ack anyway (logged) — no 30s retry-spam; can't deliver regardless |
| Rust crashes between GET and ack | due alerts re-fire next tick (at-least-once); retires also drop, so a lesser alert may fire after a higher one once — rare, still a valid warning |
| `alert-state.json` missing/corrupt | empty fired set; nothing double-suppressed |
| `/api/alerts/pending` fetch fails (Rust side) | tick logs + skips; next tick retries (no state change) |
| `config.json` corrupt | prefs default to all-on (alerts enabled) |
| Master toggle off | engine returns empty; nothing fires or retires |

## Testing

- **`test/alert-engine.test.js`** — table-driven, clock pinned: each type at its exact threshold; dedup (a key in `fired` doesn't re-fire); re-arm on changed `resetsAt`; severity collapse (one due + correct retires); stale suppression; master-off and per-type-off gating; both watched windows; null-window skip.
- **`test/alert-state.test.js`** — fired-key persistence, stale-`resetsAt` prune, corrupt/missing tolerance, atomic write (no `.tmp` left).
- **`test/config-store.test.js` (extend)** — the read-merge-write refactor: setting alert prefs preserves `subscriptionCost` and vice-versa; `effectiveAlertPrefs` defaults all-on; per-field boolean validation; `POST /api/config/alerts` validation + `GET /api/config` reflection (in the `server-additions` style).
- **Endpoint test (`test/server-alerts.test.js`)** — `GET /api/alerts/pending` returns `{ due, retire }` of the right shape and is side-effect-free (a second GET returns the same due set); `POST /api/alerts/ack { fired, retired }` marks both (a subsequent GET no longer returns them); a malformed ack body 400s.
- **Rust** — `#[cfg(test)]` for `tray_warning_prefix` (pure, table tests). The poller/firer + NSMenu action are manual-smoke per house rule (no Tauri E2E on macOS).
- All new JS tests in `test/` root (landmine #14). No new served frontend JS file (the dashboard Settings markup edits ride existing `public/app.js` + `public/index.html`, already SEA-registered — landmine #39 dormant).
- **Manual smokes:** induce 80%/95% → notifications; force a will-hit window → notification; hit 100% → limit-reached; toggle master off → silence; ⚠ appears/clears on the title; NSMenu toggle flips and persists. **Windows smoke:** notifications fire on both threshold + will-hit.

## Landmines respected

#14 (test glob) · #22 (dashboard Settings updates — alert checkboxes are user-action renders, not the auto-refresh path, but any tick-touched element uses the surgical path) · #37 (snapshot untouched — no projection/alert fields added to `/api/snapshot`) · #38 (no browser-side shared-math seam needed — the engine is sidecar-side) · #39 (no new served JS) · #40 (alert prefs + state in sidecar-owned files, never `settings.json`) · house rule: clock injection; Rust prefers pure unit tests over Tauri E2E. New IPC: **none** — the Rust↔sidecar contract is HTTP (the alert poller uses `LOCAL_CLIENT`), so no `#[tauri::command]` triple-registration (landmine #1) is involved.

## Out of scope

ROI-pace<1× alert (deferred) · Windows tray cue + quick-toggle (Mac-first; tracked follow-up) · iOS alerts (sub-project C — scheduled-local, different mechanism) · editable thresholds / quiet hours (config-depth decision) · shared cross-platform alert vectors (iOS alert model differs; YAGNI) · snapshot/iCloud changes (none).
