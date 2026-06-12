# On-Device Usage Projection (Active-Guardrail Sub-Project A) — Design

**Date:** 2026-06-12
**Status:** Approved in brainstorm (Adnan, 2026-06-12). Parent: `2026-06-12-clauge-active-guardrail-roadmap.md` (merged PR #36).
**Scope:** Desktop (Mac + Windows) — the Node sidecar + popover + dashboard. iOS implements the same algorithm later from the shared test vectors; **no iOS code and no iCloud-snapshot schema change in this sub-project.**

---

## What this ships

Clauge stops being a rear-view mirror and starts forecasting:

1. **Window forecasts** — *"At this pace → 100% ~3:40 PM"* / *"On pace to end at ~62%"* under the popover's two hero gauges and on the dashboard plan card.
2. **Week-over-week context** — *"+15 pts vs last week at this point"* on the weekly window, once enough local history exists.
3. **ROI pace** — *"Monthly pace: 22×"* on the dashboard ROI strip, computed as a run-rate (trailing 7-day value scaled to 30 days) against a **now-editable subscription cost**.

Sub-project B (desktop alerts + tray) will consume the same `/api/projection` endpoint; nothing here fires notifications.

### Decisions locked in the brainstorm

| Fork | Decision |
|---|---|
| A's scope | Engine **and** visible UI (popover + dashboard), not engine-only. |
| Where the math lives | **Sidecar-computed** (`lib/projection.js` pure module + `GET /api/projection`). Frontends only format. No browser-side math, no new served JS. |
| ROI pace anchor | **Run-rate, no anchor**: trailing 7d → 30d equivalent. No calendar month, no billing-day setting. |
| ROI pace denominator | The **user's actual subscription cost** — a new editable, persisted setting (default $200). Not the hardcoded env value. |
| Trend (b) meaning | **Both**: recent-burn-rate sharpens the ETA *and* a week-over-week context line. Degrades silently to whole-window linear when history is thin. |

---

## Architecture

```
Chrome extension ──POST /api/usage/ingest (≈1/min)──▶ sidecar
                                            │
                                            ├─ usage-store.js  (latest record → ~/.clauge/usage.json, unchanged)
                                            └─ usage-history.js (NEW: ≤1 sample/5min → ~/.clauge/usage-history.jsonl)

popover (10s tick) ──┐
dashboard (60s tick) ─┴─GET /api/projection──▶ projection.js (pure math, clock injected)
                                                 ├─ reads: usage-store latest + usage-history + session costs (ROI)
                                                 └─ returns: absolute times + states; frontends format only
```

The sidecar stays **request-driven** (zero background timers, as today). All "now"-dependent math takes `nowMs` as a parameter (house convention — no `Date.now()` in lib code).

---

## Component 1 — `lib/projection.js` (new, pure ESM module)

No I/O, no DOM, no clock. Exports pure functions; the endpoint wires them to stores.

### Window identity and elapsed time

**Per-bucket `windowMs` (exhaustive):** `fiveHour` = 5 h; `sevenDay`, `sevenDaySonnet`, `sevenDayOpus`, `claudeDesign`, `dailyRoutines` = 7 d. The last two resolve from `seven_day_*` raw keys — `dailyRoutines` is a *weekly* quota bucket despite the feature's name. Any future bucket whose duration is unknown is reported `unavailable`, never given a guessed duration.

For a window with `{ pct, resetsAt }`:

- `windowStartMs = parse(resetsAt) − windowMs`
- `elapsedMs = clamp(nowMs − windowStartMs, 0, windowMs)`
- **Window grouping is anchored:** a history sample belongs to the *current* window iff its `resetsAt` is within 5 minutes of the **latest ingested record's** `resetsAt` (claude.ai recomputes `resets_at` per response; small drift is expected, a new window moves it by hours/days). For *previous* windows, samples are clustered greedily newest-first with the same ±5 min anchor per cluster. Accepted consequence: if real drift accumulates past 5 min across a 7-day window, the oldest samples fall out of the group — and a **drift tripwire** (the sevenDay schema-drift pattern) `console.warn`s when consecutive samples land in the ambiguous zone (`resetsAt` delta between 5 min and 1 h with continuously rising `pct`), so a wrong tolerance surfaces in logs instead of silently degrading forecasts. The 5-min constant gets verified against real recorded data during implementation (no in-repo evidence of actual drift magnitude exists today).

### (a) Within-window linear forecast

Inputs: `pct` (0–100), `resetsAt`, `windowMs`, `nowMs`, optional `recentRate` from (b).

State machine, evaluated in order:

| Condition | State | Payload |
|---|---|---|
| `pct == null` or `resetsAt` null/unparseable | `unavailable` | — (line hidden) |
| `parse(resetsAt) ≤ nowMs` (data predates a reset) | `unavailable` | — |
| `pct ≥ 100` | `exhausted` | `resetsAt` (show reset time) |
| `elapsedMs < 0.05 × windowMs` | `warming_up` | — (too young to call) |
| else | `will_hit` or `safe` | see below |

Rate selection: `rate = recentRate ?? (pct / elapsedMs)` (pct per ms); `basis = 'recent' | 'window_avg'`.

- If `rate ≤ 0` → `safe` with `projectedEndPct = min(99, round(pct))` (same rounding/cap as below).
- `etaMs = nowMs + (100 − pct) / rate`.
- If `etaMs ≤ parse(resetsAt)` → **`will_hit`**, `etaAt = ISO(etaMs)`.
- Else → **`safe`**, `projectedEndPct = min(99, round(pct + rate × (parse(resetsAt) − nowMs)))` — capped at 99 because a projection that reaches 100 before reset is definitionally `will_hit`; the cap keeps the rounding seam (99.5 → 100) from displaying "on pace to end at ~100%" under a `safe` state. This exact boundary case goes in the fixture vectors.

### (b) Trend layer

**Recent burn rate** (sharpens the ETA). Usable points = the **latest ingested record** plus history samples whose `resetsAt` matches it within 5 min (the anchored grouping above) and whose `at` is within `RECENT_SPAN_MS = 60 min` of `nowMs`. Require **≥ 1 such history sample** whose age vs the latest record spans ≥ `MIN_RECENT_SPAN_MS = 15 min`; take the oldest qualifying sample and compute `recentRate = Δpct / Δt` against the latest record. Fall back to window-average when: no qualifying sample, span too short, or `Δpct < 0` (a reset slipped through — the grouping should prevent this; the guard is belt-and-braces).

**Week-over-week** (sevenDay window only): let `f = elapsedMs / windowMs` (how far through the week we are). Find the *previous* window's samples (the most recent window group whose `resetsAt` precedes the current one). Interpolate the previous window's `pct` at the same fraction `f` (linear interpolation between the bracketing samples; require at least one sample within ±6 h of the target point, else `null`). Output:

```json
"weekOverWeek": { "deltaPts": 15, "prevPctAtSamePoint": 44 }
```

`deltaPts = round(pctNow − prevPctAtSamePoint)`. **Gating: `weekOverWeek` is non-null only when the window's state is `will_hit` or `safe`** — it rides the same suppression gates as the forecast (`stale`, `warming_up`, `exhausted`, `unavailable` all null it), which also prevents a meaningless "+n pts" line minutes after a weekly reset. Omitted (`null`) whenever the previous window has no usable history — first week after install, sparse data, etc. **(b) never blocks (a):** every degradation path silently lands on the window-average forecast.

### (c) ROI run-rate pace

- `apiEquivalentSpendTrailing` = existing `sumSessionCosts` over the trailing 7 days (the established per-token cost pipeline — never `tokens × flat rate`).
- `monthlyEquivalentValue = apiEquivalentSpendTrailing / 7 × 30`.
- `paceMultiple = (monthlyEquivalentValue − subscriptionCost) / subscriptionCost` — **the same net-value semantics as the existing dashboard multiplier** (`apiReplacementValue / subscriptionCost`), so "22×" means the same thing everywhere.
- `subscriptionCost ≤ 0` or unset → `roiPace: null` (line hidden). No division by zero, no `∞×`.
- `apiEquivalentSpendTrailing === 0` (no sessions in the trailing 7 days) → `roiPace: null` as well — otherwise the formula yields a confusing "−1×". Same phantom-bucket lesson: hide, don't render a zero-data verdict. Both null cases go in the fixtures.

---

## Component 2 — `lib/usage-history.js` (new recorder)

- **Hook:** called from `POST /api/usage/ingest` after `normalizeUsage`, fire-and-forget (a recorder failure must never fail an ingest — log `console.warn` and continue).
- **File:** `~/.clauge/usage-history.jsonl` (beside `usage.json`). Append-only JSON Lines; a crash mid-write loses at most one line.
- **Sample format** (one line, nulls omitted):

```json
{"v":1,"at":"2026-06-12T09:31:37.034Z","w":{"fiveHour":{"pct":13,"resetsAt":"2026-06-12T14:20:00.800955+00:00"},"sevenDay":{"pct":59,"resetsAt":"2026-06-17T23:00:00.800976+00:00"},"sevenDaySonnet":{"pct":31,"resetsAt":"..."},"sevenDayOpus":{"pct":12,"resetsAt":"..."}}}
```

  The key list is an **exhaustive allowlist**: exactly the six *resolved* window keys (`fiveHour`, `sevenDay`, `sevenDaySonnet`, `sevenDayOpus`, `claudeDesign`, `dailyRoutines`). The legacy raw-codename duplicates `normalizeUsage` also emits (`sevenDayOmelette`, `sevenDayCowork` — same windows as the resolved pair) and the non-window fields (`extraUsage`, `unknownSevenDayKeys`) are **excluded**. Only non-null windows are written.
- **Downsample:** append only if ≥ `SAMPLE_INTERVAL_MS = 5 min` since the last appended sample (in-memory last-sample cache; on cold start, read the file's last line). At the extension's 1/min cadence → ≤ 288 samples/day.
- **Retention:** `RETENTION_DAYS = 90` — deliberately more than week-over-week needs (~14 d): the headroom is for future monthly-trend views at a cost of ~1–2 MB, and shrinking later is a one-constant change while regrowing lost data is impossible. Prune on sidecar startup and lazily at most once per 24 h thereafter: filter lines older than 90 days, atomic rewrite (tmp + rename).
- **Read tolerance:** unparseable or wrong-`v` lines are skipped, never fatal. Missing file = empty history.

---

## Component 3 — `GET /api/projection` (new endpoint)

Registered in `server.js` + appended to `READ_ONLY_API_PATHS` (the loopback CORS allowlist — without this the webview fetch is CORS-denied). Computes on request.

### Response shape

```json
{
  "generatedAt": "2026-06-12T10:00:00.000Z",
  "freshness": { "ingested": true, "ingestedAt": "2026-06-12T09:59:37.034Z", "stale": false },
  "windows": {
    "fiveHour": {
      "pct": 42, "resetsAt": "2026-06-12T14:20:00+00:00",
      "state": "will_hit", "basis": "recent",
      "etaAt": "2026-06-12T11:40:00.000Z",
      "projectedEndPct": null,
      "recentRatePctPerHour": 34.8
    },
    "sevenDay": {
      "pct": 59, "resetsAt": "2026-06-14T12:24:00+00:00",
      "state": "safe", "basis": "window_avg",
      "etaAt": null, "projectedEndPct": 84,
      "recentRatePctPerHour": null,
      "weekOverWeek": { "deltaPts": 15, "prevPctAtSamePoint": 44 }
    },
    "sevenDaySonnet": { "...": "same shape, no weekOverWeek" },
    "sevenDayOpus": null,
    "claudeDesign": null,
    "dailyRoutines": null
  },
  "roiPace": {
    "trailingDays": 7,
    "apiEquivalentSpendTrailing": 1034.55,
    "monthlyEquivalentValue": 4433.79,
    "subscriptionCost": 200,
    "paceMultiple": 21.2
  }
}
```

The example's numbers are **mutually consistent under the Component 1 formulas** (fiveHour: 42% at 34.8 pct/h → 100% at 11:40 Z, before the 14:20 Z reset; sevenDay: 59% at f = 0.70 → window-average 0.50 pct/h → ends at ~84%) and may be reused as a fixture vector.

- `state ∈ { will_hit, safe, exhausted, warming_up, stale, unavailable }`. `etaAt` is non-null iff `will_hit`; `projectedEndPct` non-null iff `safe`.
- `recentRatePctPerHour` is kept in the response (not displayed in A) for sub-project B's alert copy ("burning n%/h") and debuggability; `basis` alone says *which* rate won, not how fast.
- **The staleness check is itself a pure function in `lib/projection.js`** taking `(nowMs, ingestedAt)` — so `stale` is producible from the pure module, vector-testable, and ports to iOS with the same fixtures. The endpoint merely wires it.
- Null ingested buckets stay `null` (phantom-bucket lesson: data-gate, don't render zeros).
- The API computes for **every non-null window** (cheap; sub-project B will want them all); the UI in this sub-project displays only the hero pair (fiveHour, sevenDay).
- All money fields in **dollars** (consistent with `/api/roi` and the snapshot).

### Staleness gate

`PROJECTION_STALE_AFTER_MS = 10 min` (≈10 missed extension posts; a new named constant — the v1.2.0 SWR module reports *age*, it has no suppression cliff, so projection defines its own). When `nowMs − parse(ingestedAt) > threshold`, or nothing was ever ingested: `freshness.stale = true` and every window reports `state: "stale"` (pct/resetsAt passed through, no forecast numbers). **A forecast from stale data is a lie with a timestamp — suppress, don't caveat.**

---

## Component 4 — subscription cost becomes a real setting

Today: `SUBSCRIPTION_COST = Number(process.env.SUBSCRIPTION_COST ?? 200)` — env-only, read once at startup; the dashboard Settings field is read-only.

- **Persistence: a new sidecar-owned file `~/.clauge/config.json`** (beside `usage.json`; atomic tmp + rename; `{ "v": 1, "subscriptionCost": 200 }`). **Deliberately NOT the shared `settings.json`:** since v1.1.0 the Rust iCloud publish loop calls `store.save()` at least every 300 s, and tauri-plugin-store rewrites the whole file from its in-memory map — any key the sidecar wrote after the store loaded would be silently erased within minutes on every iCloud-signed-in Mac. A sidecar-owned file has exactly one writer. *(Flag, separate from this spec: the existing provider-toggle writes via `settings-writer.js` carry this same exposure — the in-code "implausible race" note predates the v1.1.0 recurring writer. Worth its own follow-up.)*
- **Precedence:** `~/.clauge/config.json` value → `SUBSCRIPTION_COST` env → `200`. **Read-side validation:** a persisted or env value that is not a finite number > 0 is treated as absent and falls through to the next tier — a hand-edited `0`/negative/string never reaches the ROI math.
- **Endpoint:** `POST /api/config/subscription-cost` with body `{ "subscriptionCost": <number > 0> }` (400 on anything else); `GET /api/config` continues to report the effective value. The startup-const becomes a getter so a change applies without sidecar restart.
- **Consumers:** `/api/roi`, `/api/snapshot` (ROI block — value change only, **no schema change**), `/api/health`, and the new `roiPace`.
- **UI:** the dashboard Settings field becomes an editable number input (USD, min 1, step 1), saved on change, ROI strip re-renders.
- **Forward-compat:** sub-project D's plan-tier auto-detect later *pre-fills this same setting* — no rework.

---

## Component 5 — display

**Popover** (Mac; 10s tick; strings via `popover/copy.json` + `window.t()` — landmine #16):

- Under each hero gauge's existing reset caption (`#session-reset` / `#weekly-reset`), one forecast line keyed by state: `will_hit` → "At this pace → 100% ~{time}" · `safe` → "On pace to end at ~{pct}%" · `exhausted` → "Limit reached — resets {time}" · `warming_up` / `stale` / `unavailable` → line hidden.
- Weekly gauge additionally shows "{±n} pts vs last week" when `weekOverWeek` is non-null.
- Times formatted in the user's local timezone, short style ("3:40 PM"). The existing burn badge (`burnState`) stays untouched.
- Popover height stays within the existing 200–1200 clamp (two extra meta lines; no constant change expected — landmine #11 watched, not waived).

**Dashboard** (Mac + Windows; 60s tick):

- Plan-card ring sub-labels gain the same per-state forecast line, and the weekly ring the week-over-week line — **via the surgical-update path** (`setTextIfChanged`; structural innerHTML only on shape transitions — landmine #22, the v0.9.9 flicker lesson).
- ROI metric strip gains "Monthly pace: {n}×" beside the existing multiplier. **Note:** today's 60s tick fetches only `/api/usage` and never re-renders the metric strip — the tick's fetch widens to include `/api/projection`, and its render scope extends to the pace line (leaf-text updates only, honoring #22).
- Settings: the subscription-cost field becomes editable (Component 4).

**Not touched:** tray title (B), notifications (B), iCloud snapshot fields (landmine #37 — additive projection fields deliberately deferred until iOS is ready to consume them).

---

## Data flow (end to end)

1. Extension POSTs usage (≈1/min) → ingest normalizes (unchanged) → history recorder appends a sample if ≥5 min since the last.
2. Popover (10s) / dashboard (60s) fetch `/api/projection` alongside their existing calls. The popover already fetches 7 endpoints per cycle (6 batched + `/api/activity`) with 5s per-fetch timeouts — this is #8. Keep-last-good currently exists only for `/api/usage` (`lastGoodUsage` + `ClaugeSwr.pickUsage`); projection gets **its own `lastGoodProjection` cache** through the same generic `pickUsage` helper, not a free ride on an endpoint-wide mechanism (none exists).
3. Sidecar computes: latest usage record + history + (for ROI) the session-cost pipeline, with `nowMs` injected at the endpoint boundary.
4. Frontends map states to copy and format absolute ISO times into local strings. Between ticks the displayed ETA stays valid (it's an absolute time, not a countdown).

## Error handling (consolidated)

| Failure | Behavior |
|---|---|
| Window just reset (<5% elapsed) | `warming_up`, no ETA shown |
| Already at 100% | `exhausted`, reset time shown |
| Extension silent >10 min / never ingested | `stale`, all forecasts suppressed |
| Null/absent bucket, null/past/invalid `resetsAt` | `unavailable`, line hidden |
| Reset between samples | window grouping by `resetsAt` (±5 min tolerance) isolates the new window; negative-Δpct guard as backstop |
| History file corrupt line / missing | skip line / start fresh — never fatal, never blocks ingest |
| Recorder write failure | `console.warn`, ingest still succeeds |
| Subscription cost ≤ 0 / unset / non-numeric | treated absent on read → falls to env → $200 default (so unreachable on desktop; the pure-function `≤0 → null` guard remains for vector/iOS use) |
| No sessions in the trailing 7 days | `roiPace: null`, pace line hidden (no "−1×") |
| `/api/projection` fetch fails frontend-side | SWR keep-last-good + the existing stale cue; no blank wipe |

## Testing

- **`test/projection.test.js`** — table-driven node:test over the pure module, clock pinned: every state, rate selection (recent vs window-average), (b)→(a) degradation paths, week-over-week interpolation incl. missing-prior-week, ROI pace incl. zero-cost.
- **`test/fixtures/projection-vectors.json`** — the **shared cross-platform vectors** (versioned: `{ "vectorsVersion": 1, "cases": [...] }`; each case = inputs (window snapshot, history samples, nowMs, subscriptionCost) + expected outputs (state/etaAt/projectedEndPct/deltaPts/paceMultiple)). Desktop asserts against it now; clauge-ios vendors a byte-identical copy later (duplicate-and-pin, the landmine-37 practice — version asserted on both sides). Units stated explicitly per field inside the fixture.
- **`test/usage-history.test.js`** — downsample threshold, 90-day prune, window grouping across resets, corrupt-line tolerance, last-line cold-start.
- **Existing suites extended:** ROI tests for the settable cost + precedence (incl. read-side rejection of non-finite/≤0 values); a config-endpoint test for POST validation.
- **Endpoint-level test** (the `server-additions.test.js` style): boot the server, `GET /api/projection` with a loopback Origin, assert the ACAO reflection (proving `READ_ONLY_API_PATHS` membership — the silent-CORS-denial failure mode) plus the top-level response keys.
- Files live **directly in `test/`** (the npm-test glob skips subdirectories — landmine #14). The fixture lives in `test/fixtures/` (outside the npm files allowlist — never ships).
- **Manual smokes:** popover + dashboard lines on this Mac (after `npm run build:sidecar` so the gitignored `public/popover/` mirror regenerates — landmine #30); **Windows smoke pass** for the dashboard (popover is Mac-only); `npm run test:sea` still run pre-release as standard hygiene (no new served files expected, so no manifest edits — landmine #39 should stay dormant).

## Landmines actively respected

#11 (popover height clamp pair) · #14 (test glob) · #16/#20 (copy registry + facade loads) · #22 (surgical updates) · #30 (popover mirror) · #37 (snapshot schema — explicitly untouched) · #38 (no browser-side shared math at all — sidesteps the seam) · #39 (no new served JS) · data-contract #4 (cost from the per-token pipeline only) · house rule: clock injection everywhere.

## Out of scope

Notifications/tray/thresholds (B) · iOS implementation + vector vendoring (later, with C/T) · iCloud snapshot projection fields (deferred with iOS) · plan-tier auto-detect (D — pre-fills Component 4's setting) · tray-title forecast (B) · LAN/GDrive transport (T).

**Roadmap note:** the roadmap defines A as "desktop sidecar + iOS"; this spec deliberately ships A **desktop-first**, with the iOS implementation re-homed to the C/T cycle (the shared vectors preserve the specify-once intent). The roadmap doc is amended alongside this spec so a future fresh session doesn't read A as shipped-incomplete.
