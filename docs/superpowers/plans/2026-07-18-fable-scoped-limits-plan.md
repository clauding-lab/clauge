# v1.3.6 — Generic `limits[]` parsing → dynamic scoped-window surfaces ("the Fable fix")

**Date:** 2026-07-18 · **Branch:** `feat/limits-scoped-windows` · **Target release:** v1.3.6 (then MAS b13)

## Why

Anthropic generalized model-scoped quotas on claude.ai. `GET /api/organizations/{uuid}/usage`
now carries a `limits[]` array; the old flat keys (`seven_day_sonnet`, `seven_day_opus`, codename
variants) are permanently null. Clauge's surfaces render from the dead flat keys, so today the
dashboard shows a phantom "Sonnet —" ring and the popover an empty "Sonnet only" bar while
claude.ai shows "Fable 65%". Fix: parse `limits[]` generically — **the label is DATA from the
wire, never schema** (the Claude-Design phantom-bucket lesson).

Live verified schema (Adnan's org, 2026-07-18, in `~/.clauge/usage.json` under `.raw.limits`):

```json
[
  { "kind": "session",      "group": "session", "percent": 66, "severity": "normal",
    "resets_at": "2026-07-18T18:09:59.667774+00:00", "scope": null, "is_active": true },
  { "kind": "weekly_all",   "group": "weekly",  "percent": 59, "severity": "normal",
    "resets_at": "2026-07-22T23:00:00.667795+00:00", "scope": null, "is_active": false },
  { "kind": "weekly_scoped","group": "weekly",  "percent": 65, "severity": "normal",
    "resets_at": "2026-07-22T22:59:59.668082+00:00",
    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
    "is_active": false }
]
```

Assume multiple scoped entries can appear at once, and that `scope.surface` (surface-scoped
limits, e.g. Cowork) may appear later.

## Scope decisions (locked by owner, 2026-07-18 session)

- Parse `limits[]` **generically**; labels come from the wire.
- Legacy normalized fields stay unchanged (old stored records must keep rendering — data-gated).
- Scoped windows are **display-only** in v1.3.6: alerts, projection, and usage-history are untouched.
- `/v1` changes are **additive only** (landmine #47 — frozen contract).
- iCloud snapshot: no snapshot.js change needed — it republishes `normalized` verbatim; current
  iOS deliberately does not decode `usage`, so `SNAPSHOT_SCHEMA_VERSION` **stays 1**.
- iOS app changes ship separately (clauge-ios session). Rust code untouched (both ingest sources
  already pass `limits` through raw).

## Global constraints (binding on every task)

1. **Labels are data.** No hardcoded model names in new code paths. Dashboard inserts labels
   only through `escapeHtml(...)`; popover inserts labels only via `textContent`/`Text.data` —
   never string-built HTML.
2. **`/v1` is a frozen public contract** (AGENTS.md landmine #47): never remove/rename existing
   fields, labels, or line types. Existing output for a record without `scopedWindows` must stay
   **byte-identical**.
3. **Defensive parsing.** PR #63 (ingest clamping) is NOT merged — validate here: `percent` must
   be a finite number (clamp to 0..100), labels trimmed / control-chars stripped / length-capped,
   entry count capped. Malformed entries are dropped, never thrown on.
4. **No new served frontend files** (avoids the SEA manifest landmines #2/#39). Edit existing
   files only. No new dependencies (AGENTS.md out-of-scope list).
5. **Data-gate everything**: zero scoped windows → the surface hides (no phantom "0%" — landmine
   from the Claude-Design bucket). Old records with a real `sevenDaySonnet` metric keep rendering
   via an explicit legacy fallback.
6. **Tests:** TDD (RED first). Pure unit tests only — do NOT spawn new servers (test ports
   3493–3551 are taken, landmine #46). New strings in the popover go through `copy.json` +
   `t()` (landmine #16); validators run in `npm run check`.
7. Conventional Commits, no `Co-Authored-By` lines. ESM style, match surrounding code.

## The normalized contract added by this release

`normalizeUsage(raw)` output gains ONE new key (all legacy keys unchanged):

```js
scopedWindows: [
  {
    label: 'Fable',        // string — scope.model.display_name ?? scope.model.id
                           //          ?? scope.surface.display_name ?? scope.surface.id;
                           //          trimmed, C0/C1 control chars stripped, max 40 chars
    pct: 65,               // limits[].percent — required finite number, clamped to 0..100
    resetsAt: '2026-...',  // limits[].resets_at ?? null
    isActive: false,       // limits[].is_active === true
    group: 'weekly',       // limits[].group ?? null (expected 'session' | 'weekly')
    source: 'model',       // 'model' if the label came from scope.model, else 'surface'
  },
]
```

Inclusion rule: entries of `raw.limits` (must be an array; anything else = treated as absent)
whose `scope` is a non-null object AND that yield a usable non-empty label AND whose `percent`
is a finite number. Order preserved from the wire. Cap: first **8** qualifying entries
(`SCOPED_WINDOWS_MAX = 8` — defense vs hostile ingest; popover height is bounded).
`scopedWindows` is ALWAYS present as an array (`[]` when none). Consumers must tolerate the key
being absent entirely (old stored records ingested before this release).

Fallback synthesis (future-proofing — flat keys win when present): when `raw.five_hour` is
missing/null, `fiveHour` is synthesized from the first `limits[]` entry with `kind === 'session'`
(same pct/resetsAt mapping, clamped); likewise `sevenDay` from `kind === 'weekly_all'`.

---

## Task 1: `normalizeUsage` — parse `limits[]` into `scopedWindows` (+ hero fallback)

**Files:** `lib/usage-store.js`, `test/usage-store.test.js`, `test/snapshot.test.js` (one
pass-through pin test).

TDD. Implement the contract above in `normalizeUsage`. Specifics:

- New module-level constant `SCOPED_WINDOWS_MAX = 8`.
- Label resolution order: `scope.model?.display_name` → `scope.model?.id` →
  `scope.surface?.display_name` → `scope.surface?.id`. Non-string / empty-after-trim → entry
  dropped. Strip control characters (ranges U+0000-U+001F and U+007F-U+009F) using BACKSLASH-u
  escaped character classes in the JS source - never literal control bytes (an Edit-tool
  incident wrote literal bytes and corrupted a file to binary on 2026-07-18).
  Truncate to 40 chars after trim.
- `source`: `'model'` when the label came from `scope.model`, `'surface'` when from
  `scope.surface`.
- `pct`: `Number.isFinite(entry.percent)` required, then `Math.min(100, Math.max(0, percent))`.
- Hero fallback: only when the flat key produced null (`metric(raw.five_hour)` etc. — keep the
  existing `metric()` helper for flat keys). Synthesized shape is the same `{ pct, resetsAt }`
  metric shape (clamped pct). First matching kind wins. A `limits` entry used for hero fallback
  must still have finite `percent`.
- Existing outputs (fiveHour/sevenDay when flat keys present, sevenDaySonnet/Opus, resolved
  design/routines, unknownSevenDayKeys, extraUsage) are byte-for-byte unchanged — the existing
  test suite must pass untouched.

Required RED-first test cases (`test/usage-store.test.js`):
1. The live 3-entry fixture above → `scopedWindows` has exactly one entry
   `{ label:'Fable', pct:65, resetsAt:<wire value>, isActive:false, group:'weekly', source:'model' }`.
2. No `limits` key / `limits: null` / `limits: 'junk'` / `limits: {}` → `scopedWindows: []`.
3. Two scoped entries (add an Opus-style `display_name:'Opus'` entry) → both, wire order.
4. Surface-scoped entry (`scope: { model: null, surface: { id:'cowork', display_name:'Cowork' } }`)
   → `label:'Cowork'`, `source:'surface'`.
5. Dropped entries: scope null (session/weekly_all rows never appear in scopedWindows);
   `percent: 'NaNish string'` / missing percent; label empty/whitespace; label non-string.
6. Clamps: `percent: 250` → `pct: 100`; `percent: -5` → `pct: 0`.
7. Label hygiene: `display_name: '  Fable  '` → `'Fable'`; a 60-char name → 40 chars.
8. Cap: 10 qualifying scoped entries → first 8 kept, wire order.
9. Hero fallback: raw with NO `five_hour`/`seven_day` flat keys but session/weekly_all limits →
   `fiveHour.pct === 66`, `sevenDay.pct === 59` with the wire resets_at; AND flat keys win:
   raw with both flat `five_hour` and a session limit → flat value.
10. `scope.model.id` fallback when display_name null; model wins over surface when both present.
11. `resets_at` missing on a scoped entry → `resetsAt: null`.

Snapshot pin (`test/snapshot.test.js`, one test): a usageStore record whose `normalized`
contains `scopedWindows` → `buildSnapshot(...).usage.plan.scopedWindows` deep-equals it
(verbatim pass-through; schemaVersion still 1 in the same assertion).

Commit: `feat(usage): parse claude.ai limits[] into generic scopedWindows (labels from the wire)`

## Task 2: `/v1` — additive scoped progress lines

**Files:** `lib/api-v1.js`, plus the existing /v1 unit test file (locate the `buildV1Usage`
tests; extend — do not spawn servers).

TDD. In `buildV1Usage`, after the existing legacy `windows` loop and BEFORE the ROI block:

- For each entry of `normalized.scopedWindows` (tolerate the key being absent — default `[]`):
  - `prefix = entry.group === 'session' ? 'Session' : 'Weekly'` (null/unknown group → `'Weekly'`).
  - `label = `${prefix} (${entry.label})``.
  - Skip when that exact label was already emitted by THIS snapshot's progress lines (dedupe vs
    the legacy `Weekly (Opus)` / `Weekly (Sonnet)` emitters and vs duplicate scoped labels —
    track emitted labels in a `Set`).
  - Guard `entry.pct != null` (same null-guard shape as the legacy loop); emit
    `{ type:'progress', label, used: entry.pct, limit: 100, format:{ kind:'percent' } }` and add
    `resets_at` only when `entry.resetsAt != null`.
- Frozen-contract proof: existing tests pass untouched; add a test asserting a record WITHOUT
  `scopedWindows` produces exactly the same lines as before the change.

Required RED-first tests:
1. Record with the Fable scopedWindows fixture → a `Weekly (Fable)` progress line with
   `used: 65`, `limit: 100`, `resets_at` = wire value, positioned after the legacy window lines
   and before any ROI/Note lines.
2. `group: 'session'` entry → `Session (<label>)` line.
3. Dedupe: normalized with BOTH `sevenDaySonnet` metric AND a scoped entry labeled `Sonnet` →
   exactly ONE `Weekly (Sonnet)` line (the legacy one).
4. Absent `scopedWindows` key (old record) → byte-identical lines vs current behavior.
5. Scoped entry with `resetsAt: null` → line has NO `resets_at` key (None-dropping rule).

Commit: `feat(v1): additive Weekly/Session scoped-limit lines from scopedWindows`

## Task 3: Popover — dynamic scoped-limit bars replace the static "Sonnet only" section

**Files:** `popover/index.html`, `popover/popover.js`, `popover/copy.json` (+ the popover CSS
file ONLY if spacing needs it).

- `popover/index.html`: replace the whole static "Sonnet only" section (the `sect` containing
  `#sonnet-fill` / `#sonnet-pct` / `#sonnet-reset` / `#sonnet-reset-clock`) with:

  ```html
  <!-- ── Scoped limits (model/surface, e.g. "Fable") — dynamic; hidden when none ── -->
  <section class="sect" id="scoped-section" hidden>
    <div id="scoped-bars"></div>
  </section>
  ```

- `popover/popover.js`: replace `renderSonnet(plan, nowMs)` with `renderScoped(plan, nowMs)`
  (update the call site in the render pipeline):
  - Window list: `Array.isArray(plan?.scopedWindows) && plan.scopedWindows.length > 0`
    → `plan.scopedWindows`; else legacy fallback → `plan?.sevenDaySonnet?.pct != null`
    ? `[{ label: t('sonnet.label'), pct, resetsAt, group: 'weekly' }]` : `[]`.
  - `#scoped-section` hidden ⟺ list empty (mirror `renderDesign`'s gate style).
  - Build each bar with `document.createElement` + `textContent` ONLY (labels are wire data —
    no innerHTML with interpolated strings). Per window render, reusing existing classes so
    current CSS applies: a `sect-label` line showing the label plus a window qualifier
    (`group === 'session'` → `t('scoped.windowSession')` else `t('scoped.windowWeekly')`), a
    `simple-bar` with fill width `pct%` (reuse the width-set pattern from `renderSimpleBar` —
    fine to set style.width directly on the created fill), a `bar-meta` row with
    `t('sonnet.percentUsed', { percent: Math.round(pct) })` and, when `resetsAt`,
    `t('session.resetsIn', { duration: fmtRelative(resetsAt, nowMs) })`, and the
    `fmtResetClock(resetsAt, nowMs)` sub-row.
  - Rebuilding `#scoped-bars` children every 10s tick is acceptable (no long-lived CSS-animated
    children inside — landmine #22 documented exception for the popover).
- `popover/copy.json`: add `scoped.windowWeekly` (`"7d"`) and `scoped.windowSession` (`"5h"`).
  Keep the `sonnet.*` keys (percentUsed/resets still used; `sonnet.label` is the legacy-fallback
  label). `scripts/validate-copy-registry.cjs` must stay green.
- Total popover height stays far under `MAX_POPOVER_HEIGHT` (1200) — normalize caps at 8 bars.

Tests: `npm run check` (validators + suites). There is no DOM test harness for popover.js —
correctness here is covered by Task 5's live verification. Keep the diff surgical.

Commit: `feat(popover): dynamic scoped-limit bars (labels from the wire) replace hardcoded Sonnet`

## Task 4: Dashboard — dynamic scoped rings replace the hardcoded Sonnet ring

**Files:** `public/app.js`.

In `renderPlanCapacity` (and the placeholder branch just above it):

- Placeholder labels (`['Session', 'Weekly', 'Sonnet']`) → `['Session', 'Weekly', 'Model']`.
- Gauges array: keep Session + Weekly all; then:

  ```js
  const scoped = Array.isArray(plan.scopedWindows) ? plan.scopedWindows : [];
  if (scoped.length > 0) {
    for (const w of scoped) {
      gauges.push({
        label: w.label,
        sub: w.group === 'session' ? '5h' : '7d',
        metric: { pct: w.pct, resetsAt: w.resetsAt },
      });
    }
  } else if (plan.sevenDaySonnet) {
    gauges.push({ label: 'Sonnet', sub: '7d', metric: plan.sevenDaySonnet }); // legacy records
  }
  ```

  (Note this also kills today's phantom "Sonnet —" ring: with `sevenDaySonnet: null` and no
  scopedWindows, only 2 rings render. Design ring logic unchanged.)
- Shape tracking: `__planGaugeShape` becomes a string signature
  `gauges.map((g) => `${g.label}|${g.sub}`).join('§')` — a label OR count change triggers the
  structural rebuild (labels are dynamic now; `updateBigRings` never rewrites labels). Update
  both places that read/write it (`shapeChanged`, the assignment at the end). Update the JSDoc
  /comment.
- Topbar inline mini rings: replace the hardcoded Sonnet mini
  (`inlineMiniRingHtml({ pct: plan.sevenDaySonnet?.pct, label: 'Sonnet' })`) with the same
  scoped-else-legacy mapping (`inlineMiniRingHtml({ pct: w.pct, label: w.label })` per scoped
  window). Keep Session/Weekly/Design minis as they are. `updatePlanInline` zips `gauges` to
  `.mini-ring` nodes by index — the mini set must stay index-aligned with `gauges` exactly as
  today (Session, Weekly, <scoped-or-legacy...>, Design-mini-when-present).
- Labels flow through `escapeHtml` in `bigRingHtml`/`inlineMiniRingHtml` already — do not add a
  second escape layer.
- `updateRingForecasts` (hero cards[0]/[1] only) and the maxPct status-tone logic need no
  changes — confirm, don't refactor.

Tests: `npm run check`. Dashboard rendering is verified live in Task 5 (WKWebView is the layout
truth — landmine #43; content assertions in Chromium are fine).

Commit: `feat(dashboard): scoped-limit rings render dynamically from scopedWindows`

## Task 5 (controller): live end-to-end verification

Not a subagent brief. After Tasks 1–4 are approved:

1. `npm run check` — full gate, exit code + counts cited.
2. `npm run test:sea` — index.html/popover asset changes ride the SEA bundle.
3. Spawn `node server.js` on a FREE port (census first — 3493–3551 taken) with `HOME`+
   `USERPROFILE` pointed at a scratch dir (landmine #46), POST the REAL raw payload (from
   `~/.clauge/usage.json` `.raw`) to `/api/usage/ingest`, then:
   - `GET /api/usage` → `plan.scopedWindows[0].label === 'Fable'`,
   - `GET /v1/usage` → a `Weekly (Fable)` progress line (Host header loopback),
   - dashboard + popover page screenshots (Playwright vs the dev server) showing the Fable ring/bar.
4. Popover/dashboard in the real app (WKWebView): rebuild sidecar, `npm run tauri:dev` eyeball
   if feasible in-session; otherwise flag for Adnan's post-release eyeball (content logic is
   engine-independent; layout classes unchanged).

## Task 6 (controller): review, ship, release, MAS b13

1. Final whole-branch review: 3 Opus lanes (contract/regression, completeness vs this plan,
   security) + fix loop.
2. PR via /ship; CI green; **STOP for Adnan's merge approval** (house rule).
3. Release PR: version bump 4 files in lockstep (landmine #21) 1.3.5 → 1.3.6 +
   `cargo check --locked` + CHANGELOG `## [1.3.6]` section; merge approval; tag push only with
   Adnan's explicit sign-off (out-of-scope list); watch release.yml; post-release artifact smoke
   (the v1.3.5 full-verb pattern).
4. MAS: bump `tauri.mas.conf.json` bundleVersion 12 → 13 (b12 was never uploaded — superseded),
   `./scripts/build-mas-clean.sh`, pkgutil expand-verify (1.3.6/b13, helper + entitlements +
   wrapper), hand off to Adnan for Transporter upload.
