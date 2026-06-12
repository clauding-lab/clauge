# On-Device Usage Projection (Sub-Project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clauge forecasts instead of just displaying — "at this pace you hit 100% at ~3:40 PM", "+15 pts vs last week", "monthly pace: 22×" — computed in the sidecar, shown in the popover and dashboard, gated by data freshness.

**Architecture:** Pure projection math in `lib/projection.js` (clock-injected, paired with shared cross-platform test vectors that clauge-ios later vendors), a downsampled JSONL usage-history recorder hooked into the existing 1/min ingest, a request-driven `GET /api/projection` endpoint, and an editable subscription cost persisted in a sidecar-owned `~/.clauge/config.json` (deliberately NOT the tauri-store-contended `settings.json`). Frontends only format absolute times.

**Tech Stack:** Node sidecar (Hono, ESM, node:test), vanilla-JS popover + dashboard, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-on-device-projection-design.md` (authoritative; adversarially reviewed 2026-06-12).

---

## PR / branch structure

| PR | Branch | Tasks | Contents |
|---|---|---|---|
| 1 | `feat/projection-engine` | 1–2 | `lib/projection.js` + shared vectors; `lib/usage-history.js` recorder |
| 2 | `feat/projection-wiring` | 3–4 | `lib/config-store.js` + cost setting + `POST /api/config/subscription-cost`; `GET /api/projection` + ingest hook + prune wiring |
| 3 | `feat/projection-display` | 5–6 | Popover forecast/wow lines + copy; dashboard forecasts + monthly-pace + editable cost field |

Each PR: branch from fresh `main` after the previous PR merges → run the FULL `npm run check` locally (needs `npm run build:sidecar` on fresh checkouts) → `gh pr create` → `gh pr checks --watch` (branch protection requires `check`; auto-merge is NOT enabled — never merge immediately after create) → `gh pr merge --squash`.

**Sequencing constraints:** Task 4 depends on Task 1+2 (pinned interfaces: `buildProjection` takes `history` as a MAP `{ [windowKey]: samples[] }`; `UsageHistory.record/samplesFor/prune`). Tasks 5–6 depend on PR 2's endpoints. Tasks within a PR are sequential; PR 3's two tasks touch disjoint surfaces (popover vs dashboard).

**Release-notes line for the eventual release:** `SUBSCRIPTION_COST` env is now read live through the config store (was: once at startup) — same effective value, now overridable at runtime by the Settings field.

---
### Task 1: `lib/projection.js` — pure projection engine + shared cross-platform vectors (TDD)

The engine is the cross-platform algorithm source: `lib/projection.js` paired with `test/fixtures/projection-vectors.json`. clauge-ios later vendors a byte-identical copy of both (duplicate-and-pin, the landmine-#37 practice — `vectorsVersion` asserted on both sides). Pure ESM, no I/O, no DOM, no clock — `nowMs` is always a parameter (house rule; same convention as `lib/activity.js`, which never reads the clock). All vector arithmetic below was machine-verified: fiveHour 42% burning 34.8 pct/h hits 100% at exactly `2026-06-12T11:40:00.000Z`; sevenDay 59% at f=0.70 projects to 84%; roiPace 1034.55 → 4433.79 / 21.2×.

**Files:**
- Create: `test/fixtures/projection-vectors.json` (fixtures dir already exists — holds `sample-session.jsonl`; outside the npm `files` allowlist in `package.json:10-15`, so it never ships)
- Create: `test/projection.test.js` (directly in `test/` — the npm-test glob `test/*.test.js test/cli/*.test.js` at `package.json:19` skips subdirectories, landmine #14)
- Create: `lib/projection.js`
- Test: `node --test test/projection.test.js`

- [ ] **Step 1: Create the branch**

  ```bash
  cd /Users/adnanrashid/Projects/clauge
  git checkout main && git pull && git checkout -b feat/projection-engine
  ```

- [ ] **Step 2: Write the shared vector fixture** — create `test/fixtures/projection-vectors.json` with exactly this content (30 cases: every state including both spec examples, the min(99) cap boundary, rate≤0, the exact-5% warm-up boundary, 5 unavailable variants, exhausted, all 4 recent-rate degradation paths + the ±5 min drift-tolerance acceptance, weekOverWeek normal/missing-prior/state-gated/too-far, isStale ×5, roiPace ×4). `nowMs` 1781258400000 = `2026-06-12T10:00:00.000Z`.

  ```json
  {
    "vectorsVersion": 1,
    "description": "Shared cross-platform vectors for lib/projection.js. clauge-ios vendors a byte-identical copy (duplicate-and-pin; both sides assert vectorsVersion). Spec: docs/superpowers/specs/2026-06-12-on-device-projection-design.md",
    "units": {
      "nowMs": "Unix epoch milliseconds, UTC",
      "pct": "percent of window quota used, 0-100, may be fractional",
      "resetsAt": "ISO 8601 timestamp string (claude.ai resets_at passthrough)",
      "windowMs": "window duration in milliseconds (fiveHour=18000000, weekly=604800000)",
      "history": "array of { at: ISO 8601 string, pct: percent, resetsAt: ISO 8601 string } samples for ONE window key, oldest-first",
      "ingestedAt": "ISO 8601 timestamp string of the latest ingest, or null",
      "etaAt": "ISO 8601 string rounded to the whole second, UTC",
      "projectedEndPct": "integer percent, capped at 99",
      "recentRatePctPerHour": "percent per hour, rounded to 1 decimal",
      "deltaPts": "integer percentage points (current minus previous week)",
      "prevPctAtSamePoint": "integer percent",
      "apiEquivalentSpendTrailing": "US dollars over the trailing 7 days (per-token cost pipeline)",
      "subscriptionCost": "US dollars per month",
      "monthlyEquivalentValue": "US dollars, rounded to 2 decimals",
      "paceMultiple": "dimensionless multiple, rounded to 1 decimal"
    },
    "cases": [
      {
        "name": "projectWindow: fiveHour spec example - recent rate wins, will_hit at 11:40Z",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:30:00.000Z", "pct": 24.6, "resetsAt": "2026-06-12T14:20:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "recent",
          "etaAt": "2026-06-12T11:40:00.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": 34.8
        }
      },
      {
        "name": "projectWindow: sevenDay spec example - window-average fallback, safe ending at 84%",
        "fn": "projectWindow",
        "input": {
          "pct": 59,
          "resetsAt": "2026-06-14T12:24:00+00:00",
          "windowMs": 604800000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 59,
          "resetsAt": "2026-06-14T12:24:00+00:00",
          "state": "safe",
          "basis": "window_avg",
          "etaAt": null,
          "projectedEndPct": 84,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: safe projection that rounds to 100 is capped at 99",
        "fn": "projectWindow",
        "input": {
          "pct": 79.7,
          "resetsAt": "2026-06-12T11:00:00.000Z",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 79.7,
          "resetsAt": "2026-06-12T11:00:00.000Z",
          "state": "safe",
          "basis": "window_avg",
          "etaAt": null,
          "projectedEndPct": 99,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: zero rate (pct 0) - safe with projectedEndPct equal to current pct",
        "fn": "projectWindow",
        "input": {
          "pct": 0,
          "resetsAt": "2026-06-12T14:00:00.000Z",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 0,
          "resetsAt": "2026-06-12T14:00:00.000Z",
          "state": "safe",
          "basis": "window_avg",
          "etaAt": null,
          "projectedEndPct": 0,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: 14 minutes elapsed of a 5h window is warming_up",
        "fn": "projectWindow",
        "input": {
          "pct": 3,
          "resetsAt": "2026-06-12T14:46:00.000Z",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 3,
          "resetsAt": "2026-06-12T14:46:00.000Z",
          "state": "warming_up",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: exactly 5% elapsed is NOT warming_up (boundary is strict less-than)",
        "fn": "projectWindow",
        "input": {
          "pct": 1,
          "resetsAt": "2026-06-12T14:45:00.000Z",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 1,
          "resetsAt": "2026-06-12T14:45:00.000Z",
          "state": "safe",
          "basis": "window_avg",
          "etaAt": null,
          "projectedEndPct": 20,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: null pct is unavailable",
        "fn": "projectWindow",
        "input": {
          "pct": null,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": null,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "unavailable",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: null resetsAt is unavailable",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": null,
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 42,
          "resetsAt": null,
          "state": "unavailable",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: unparseable resetsAt is unavailable",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "not-a-timestamp",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 42,
          "resetsAt": "not-a-timestamp",
          "state": "unavailable",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: resetsAt in the past (data predates a reset) is unavailable",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T09:00:00.000Z",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T09:00:00.000Z",
          "state": "unavailable",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: unknown windowMs is unavailable (never guess a duration)",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": null,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "unavailable",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: pct 100 is exhausted with resetsAt passthrough",
        "fn": "projectWindow",
        "input": {
          "pct": 100,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": []
        },
        "expected": {
          "pct": 100,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "exhausted",
          "basis": null,
          "etaAt": null,
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: no sample within the 60-minute span falls back to window average",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T08:30:00.000Z", "pct": 10, "resetsAt": "2026-06-12T14:20:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "window_avg",
          "etaAt": "2026-06-12T10:55:14.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: span under 15 minutes falls back to window average",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:50:00.000Z", "pct": 41, "resetsAt": "2026-06-12T14:20:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "window_avg",
          "etaAt": "2026-06-12T10:55:14.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: negative pct delta (reset slipped through) falls back to window average",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:30:00.000Z", "pct": 55, "resetsAt": "2026-06-12T14:20:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "window_avg",
          "etaAt": "2026-06-12T10:55:14.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: sample from a different window (resetsAt beyond 5-minute tolerance) is excluded",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:30:00.000Z", "pct": 24.6, "resetsAt": "2026-06-12T09:20:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "window_avg",
          "etaAt": "2026-06-12T10:55:14.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": null
        }
      },
      {
        "name": "projectWindow: resetsAt drift within the 5-minute tolerance still groups as the same window",
        "fn": "projectWindow",
        "input": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "windowMs": 18000000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:30:00.000Z", "pct": 24.6, "resetsAt": "2026-06-12T14:16:00+00:00" }
          ]
        },
        "expected": {
          "pct": 42,
          "resetsAt": "2026-06-12T14:20:00+00:00",
          "state": "will_hit",
          "basis": "recent",
          "etaAt": "2026-06-12T11:40:00.000Z",
          "projectedEndPct": null,
          "recentRatePctPerHour": 34.8
        }
      },
      {
        "name": "weekOverWeek: interpolated midpoint of the previous week gives +15 pts",
        "fn": "weekOverWeek",
        "input": {
          "pct": 59,
          "resetsAt": "2026-06-14T12:24:00+00:00",
          "windowMs": 604800000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-05T08:00:00.000Z", "pct": 42, "resetsAt": "2026-06-07T12:24:00+00:00" },
            { "at": "2026-06-05T12:00:00.000Z", "pct": 46, "resetsAt": "2026-06-07T12:24:00+00:00" },
            { "at": "2026-06-12T09:55:00.000Z", "pct": 58.8, "resetsAt": "2026-06-14T12:24:00+00:00" }
          ]
        },
        "expected": { "deltaPts": 15, "prevPctAtSamePoint": 44 }
      },
      {
        "name": "weekOverWeek: no prior-week history yields null",
        "fn": "weekOverWeek",
        "input": {
          "pct": 59,
          "resetsAt": "2026-06-14T12:24:00+00:00",
          "windowMs": 604800000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-12T09:55:00.000Z", "pct": 58.8, "resetsAt": "2026-06-14T12:24:00+00:00" }
          ]
        },
        "expected": null
      },
      {
        "name": "weekOverWeek: gated by warming_up state even when prior history exists",
        "fn": "weekOverWeek",
        "input": {
          "pct": 1,
          "resetsAt": "2026-06-19T08:00:00+00:00",
          "windowMs": 604800000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-11T10:00:00.000Z", "pct": 80, "resetsAt": "2026-06-12T08:00:00+00:00" }
          ]
        },
        "expected": null
      },
      {
        "name": "weekOverWeek: prior week exists but no sample within 6h of the target point yields null",
        "fn": "weekOverWeek",
        "input": {
          "pct": 59,
          "resetsAt": "2026-06-14T12:24:00+00:00",
          "windowMs": 604800000,
          "nowMs": 1781258400000,
          "history": [
            { "at": "2026-06-04T20:00:00.000Z", "pct": 40, "resetsAt": "2026-06-07T12:24:00+00:00" }
          ]
        },
        "expected": null
      },
      {
        "name": "isStale: ingest 5 minutes old is fresh",
        "fn": "isStale",
        "input": { "ingestedAt": "2026-06-12T09:55:00.000Z", "nowMs": 1781258400000 },
        "expected": false
      },
      {
        "name": "isStale: ingest 11 minutes old is stale",
        "fn": "isStale",
        "input": { "ingestedAt": "2026-06-12T09:49:00.000Z", "nowMs": 1781258400000 },
        "expected": true
      },
      {
        "name": "isStale: exactly at the 10-minute threshold is NOT stale (boundary is strict greater-than)",
        "fn": "isStale",
        "input": { "ingestedAt": "2026-06-12T09:50:00.000Z", "nowMs": 1781258400000 },
        "expected": false
      },
      {
        "name": "isStale: never ingested is stale",
        "fn": "isStale",
        "input": { "ingestedAt": null, "nowMs": 1781258400000 },
        "expected": true
      },
      {
        "name": "isStale: unparseable ingestedAt is stale",
        "fn": "isStale",
        "input": { "ingestedAt": "garbage", "nowMs": 1781258400000 },
        "expected": true
      },
      {
        "name": "roiPace: spec example numbers",
        "fn": "roiPace",
        "input": { "apiEquivalentSpendTrailing": 1034.55, "subscriptionCost": 200 },
        "expected": {
          "trailingDays": 7,
          "apiEquivalentSpendTrailing": 1034.55,
          "monthlyEquivalentValue": 4433.79,
          "subscriptionCost": 200,
          "paceMultiple": 21.2
        }
      },
      {
        "name": "roiPace: zero subscription cost yields null (no division by zero, no infinity)",
        "fn": "roiPace",
        "input": { "apiEquivalentSpendTrailing": 1034.55, "subscriptionCost": 0 },
        "expected": null
      },
      {
        "name": "roiPace: negative subscription cost yields null",
        "fn": "roiPace",
        "input": { "apiEquivalentSpendTrailing": 1034.55, "subscriptionCost": -50 },
        "expected": null
      },
      {
        "name": "roiPace: zero trailing spend yields null (no -1x verdict from zero data)",
        "fn": "roiPace",
        "input": { "apiEquivalentSpendTrailing": 0, "subscriptionCost": 200 },
        "expected": null
      }
    ]
  }
  ```

- [ ] **Step 3: Write the failing test** — create `test/projection.test.js` (fixture-loading pattern mirrors `test/parser.test.js:3-14`; one dynamic subtest per vector case, plus direct `buildProjection` assembly tests):

  ```javascript
  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { readFile } from 'node:fs/promises';
  import { fileURLToPath } from 'node:url';
  import { dirname, resolve } from 'node:path';
  import {
    WINDOW_MS,
    PROJECTION_STALE_AFTER_MS,
    RECENT_SPAN_MS,
    MIN_RECENT_SPAN_MS,
    WARMUP_FRACTION,
    SAME_WINDOW_TOLERANCE_MS,
    isStale,
    projectWindow,
    weekOverWeek,
    roiPace,
    buildProjection,
  } from '../lib/projection.js';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const VECTORS_PATH = resolve(__dirname, 'fixtures/projection-vectors.json');

  const FN_TABLE = { projectWindow, weekOverWeek, roiPace, isStale };

  // nowMs used across the direct buildProjection tests = the vectors' clock.
  const NOW_MS = 1781258400000; // 2026-06-12T10:00:00.000Z

  describe('projection constants (pinned cross-platform contract)', () => {
    it('WINDOW_MS covers exactly the six resolved window keys', () => {
      assert.deepEqual(WINDOW_MS, {
        fiveHour: 18000000,
        sevenDay: 604800000,
        sevenDaySonnet: 604800000,
        sevenDayOpus: 604800000,
        claudeDesign: 604800000,
        dailyRoutines: 604800000,
      });
    });

    it('thresholds match the spec', () => {
      assert.equal(PROJECTION_STALE_AFTER_MS, 600000);
      assert.equal(RECENT_SPAN_MS, 3600000);
      assert.equal(MIN_RECENT_SPAN_MS, 900000);
      assert.equal(WARMUP_FRACTION, 0.05);
      assert.equal(SAME_WINDOW_TOLERANCE_MS, 300000);
    });
  });

  describe('projection-vectors.json (shared cross-platform fixtures)', async () => {
    const fixture = JSON.parse(await readFile(VECTORS_PATH, 'utf8'));

    it('vectorsVersion is 1 (iOS asserts the same pin)', () => {
      assert.equal(fixture.vectorsVersion, 1);
    });

    it('every case names a known function', () => {
      for (const c of fixture.cases) {
        assert.ok(FN_TABLE[c.fn], `unknown fn "${c.fn}" in case "${c.name}"`);
      }
    });

    for (const c of fixture.cases) {
      it(`[${c.fn}] ${c.name}`, () => {
        const actual = FN_TABLE[c.fn](c.input);
        assert.deepEqual(actual, c.expected);
      });
    }
  });

  describe('buildProjection — assembly', () => {
    const normalized = {
      fiveHour: { pct: 42, resetsAt: '2026-06-12T14:20:00+00:00' },
      sevenDay: { pct: 59, resetsAt: '2026-06-14T12:24:00+00:00' },
      sevenDaySonnet: { pct: 31, resetsAt: '2026-06-14T12:24:00+00:00' },
      sevenDayOpus: null,
      claudeDesign: null,
      dailyRoutines: null,
      // Fields the recorder/projection must IGNORE:
      sevenDayOmelette: { pct: 9, resetsAt: '2026-06-14T12:24:00+00:00' },
      sevenDayCowork: { pct: 7, resetsAt: '2026-06-14T12:24:00+00:00' },
      unknownSevenDayKeys: [],
      extraUsage: null,
    };

    it('emits all six window keys; null buckets pass through as null', () => {
      const out = buildProjection({
        normalized,
        ingestedAt: '2026-06-12T09:59:00.000Z',
        history: {},
        nowMs: NOW_MS,
        apiEquivalentSpendTrailing: 1034.55,
        subscriptionCost: 200,
      });
      assert.deepEqual(Object.keys(out.windows), [
        'fiveHour',
        'sevenDay',
        'sevenDaySonnet',
        'sevenDayOpus',
        'claudeDesign',
        'dailyRoutines',
      ]);
      assert.equal(out.windows.sevenDayOpus, null);
      assert.equal(out.windows.claudeDesign, null);
      assert.equal(out.windows.dailyRoutines, null);
      assert.equal(out.freshness.ingested, true);
      assert.equal(out.freshness.stale, false);
      assert.equal(out.windows.fiveHour.state, 'will_hit');
      assert.equal(out.windows.fiveHour.basis, 'window_avg');
      assert.equal(out.windows.fiveHour.etaAt, '2026-06-12T10:55:14.000Z');
      assert.equal(out.windows.sevenDay.state, 'safe');
      assert.equal(out.windows.sevenDay.projectedEndPct, 84);
    });

    it('attaches weekOverWeek ONLY on the sevenDay window', () => {
      const out = buildProjection({
        normalized,
        ingestedAt: '2026-06-12T09:59:00.000Z',
        history: {
          sevenDay: [
            { at: '2026-06-05T08:00:00.000Z', pct: 42, resetsAt: '2026-06-07T12:24:00+00:00' },
            { at: '2026-06-05T12:00:00.000Z', pct: 46, resetsAt: '2026-06-07T12:24:00+00:00' },
          ],
        },
        nowMs: NOW_MS,
        apiEquivalentSpendTrailing: 1034.55,
        subscriptionCost: 200,
      });
      assert.deepEqual(out.windows.sevenDay.weekOverWeek, {
        deltaPts: 15,
        prevPctAtSamePoint: 44,
      });
      assert.equal('weekOverWeek' in out.windows.fiveHour, false);
      assert.equal('weekOverWeek' in out.windows.sevenDaySonnet, false);
    });

    it('stale ingest suppresses every forecast but passes pct/resetsAt through', () => {
      const out = buildProjection({
        normalized,
        ingestedAt: '2026-06-12T09:30:00.000Z', // 30 min old > 10 min threshold
        history: {},
        nowMs: NOW_MS,
        apiEquivalentSpendTrailing: 1034.55,
        subscriptionCost: 200,
      });
      assert.equal(out.freshness.stale, true);
      for (const key of ['fiveHour', 'sevenDay', 'sevenDaySonnet']) {
        assert.equal(out.windows[key].state, 'stale');
        assert.equal(out.windows[key].etaAt, null);
        assert.equal(out.windows[key].projectedEndPct, null);
        assert.equal(out.windows[key].basis, null);
        assert.equal(out.windows[key].recentRatePctPerHour, null);
      }
      assert.equal(out.windows.fiveHour.pct, 42);
      assert.equal(out.windows.fiveHour.resetsAt, '2026-06-12T14:20:00+00:00');
      assert.equal(out.windows.sevenDay.weekOverWeek, null);
    });

    it('roiPace is NOT staleness-gated (session logs, not extension data)', () => {
      const out = buildProjection({
        normalized,
        ingestedAt: null, // never ingested
        history: {},
        nowMs: NOW_MS,
        apiEquivalentSpendTrailing: 1034.55,
        subscriptionCost: 200,
      });
      assert.equal(out.freshness.stale, true);
      assert.deepEqual(out.roiPace, {
        trailingDays: 7,
        apiEquivalentSpendTrailing: 1034.55,
        monthlyEquivalentValue: 4433.79,
        subscriptionCost: 200,
        paceMultiple: 21.2,
      });
    });

    it('never-ingested (normalized null) yields all-null windows + stale freshness', () => {
      const out = buildProjection({
        normalized: null,
        ingestedAt: null,
        history: null,
        nowMs: NOW_MS,
        apiEquivalentSpendTrailing: 0,
        subscriptionCost: 200,
      });
      assert.deepEqual(out.freshness, {
        ingested: false,
        ingestedAt: null,
        stale: true,
      });
      for (const key of Object.keys(WINDOW_MS)) {
        assert.equal(out.windows[key], null);
      }
      assert.equal(out.roiPace, null);
    });
  });
  ```

- [ ] **Step 4: Run the test and verify it FAILS** (module doesn't exist yet):

  ```bash
  node --test test/projection.test.js
  ```

  Expected output (RED — exit code 1):

  ```text
  # Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/adnanrashid/Projects/clauge/lib/projection.js' imported from /Users/adnanrashid/Projects/clauge/test/projection.test.js
  # pass 0
  # fail 1
  ```

- [ ] **Step 5: Implement the engine** — create `lib/projection.js` with exactly this content (pure ESM, `console`-free, clock injected; the header declares the iOS-vendoring pairing):

  ```javascript
  /**
   * On-device usage projection — pure forecast math for the active guardrail.
   *
   * CROSS-PLATFORM ALGORITHM SOURCE. This module is the single source of truth
   * for the projection state machine, paired with the shared vector file at
   * test/fixtures/projection-vectors.json. clauge-ios vendors a byte-identical
   * copy of BOTH (the Swift port asserts the same vectorsVersion) — change the
   * algorithm here and you must regenerate/extend the vectors in the same
   * commit, never edit one without the other.
   *
   * No I/O, no DOM, no clock: every function takes `nowMs` as a parameter
   * (house convention — no Date.now() in lib/). The /api/projection endpoint
   * wires these functions to the stores; frontends only format the output.
   *
   * Spec: docs/superpowers/specs/2026-06-12-on-device-projection-design.md
   */

  /**
   * Per-bucket window durations in milliseconds (exhaustive allowlist).
   * `dailyRoutines` is a WEEKLY quota bucket despite the feature's name — it
   * resolves from seven_day_* raw keys (see lib/usage-store.js ROUTINES_KEYS).
   * Any bucket whose duration is unknown is reported `unavailable`, never
   * given a guessed duration.
   */
  export const WINDOW_MS = {
    fiveHour: 18000000,
    sevenDay: 604800000,
    sevenDaySonnet: 604800000,
    sevenDayOpus: 604800000,
    claudeDesign: 604800000,
    dailyRoutines: 604800000,
  };

  /** Ingest older than this (or never ingested) => every window is `stale`. */
  export const PROJECTION_STALE_AFTER_MS = 600000; // 10 min

  /** Recent-burn-rate lookback: samples older than this are ignored. */
  export const RECENT_SPAN_MS = 3600000; // 60 min

  /** Minimum age of the oldest qualifying sample for a usable recent rate. */
  export const MIN_RECENT_SPAN_MS = 900000; // 15 min

  /** Window younger than this fraction of its duration => `warming_up`. */
  export const WARMUP_FRACTION = 0.05;

  /** Two resetsAt values within this delta belong to the same window. */
  export const SAME_WINDOW_TOLERANCE_MS = 300000; // 5 min

  /** Week-over-week: nearest prior-week sample must be within this of the
   *  same-fraction target point, else weekOverWeek is null. */
  const WOW_NEIGHBOR_TOLERANCE_MS = 21600000; // 6 h

  const WEEK_OVER_WEEK_KEY = 'sevenDay';

  function parseMs(value) {
    if (typeof value !== 'string' || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  function isoAtSecond(ms) {
    return new Date(Math.round(ms / 1000) * 1000).toISOString();
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * True when the latest ingest is too old to forecast from (or never
   * happened). Pure so iOS ports it with the same vectors; the endpoint
   * merely wires it.
   *
   * @param {{ ingestedAt: string | null | undefined, nowMs: number }} args
   * @returns {boolean}
   */
  export function isStale({ ingestedAt, nowMs }) {
    const ingestedMs = parseMs(ingestedAt);
    if (ingestedMs == null) return true;
    return nowMs - ingestedMs > PROJECTION_STALE_AFTER_MS;
  }

  function emptyForecast(pct, resetsAt, state) {
    return {
      pct: pct ?? null,
      resetsAt: resetsAt ?? null,
      state,
      basis: null,
      etaAt: null,
      projectedEndPct: null,
      recentRatePctPerHour: null,
    };
  }

  /**
   * Recent burn rate in pct/ms, or null when no qualifying history sample
   * exists. The latest ingested record is represented by (pct, nowMs);
   * qualifying samples share the current window's resetsAt (±5 min), are at
   * most RECENT_SPAN_MS old, and at least MIN_RECENT_SPAN_MS old. The oldest
   * qualifying sample anchors the rate. Negative Δpct (a reset slipped past
   * the grouping) falls back to null — belt-and-braces.
   */
  function computeRecentRate({ pct, resetsAtMs, nowMs, history }) {
    if (!Array.isArray(history)) return null;
    let oldest = null;
    let oldestAtMs = null;
    for (const sample of history) {
      const atMs = parseMs(sample?.at);
      const sampleResetMs = parseMs(sample?.resetsAt);
      if (atMs == null || sampleResetMs == null) continue;
      if (!Number.isFinite(sample?.pct)) continue;
      if (Math.abs(sampleResetMs - resetsAtMs) > SAME_WINDOW_TOLERANCE_MS) continue;
      const age = nowMs - atMs;
      if (age > RECENT_SPAN_MS || age < MIN_RECENT_SPAN_MS) continue;
      if (oldestAtMs == null || atMs < oldestAtMs) {
        oldest = sample;
        oldestAtMs = atMs;
      }
    }
    if (oldest == null) return null;
    const deltaPct = pct - oldest.pct;
    if (deltaPct < 0) return null;
    return deltaPct / (nowMs - oldestAtMs);
  }

  /**
   * Forecast one usage window. State machine (spec order, do not reorder):
   * unavailable -> exhausted -> warming_up -> will_hit | safe.
   *
   * @param {{
   *   pct: number | null,
   *   resetsAt: string | null,
   *   windowMs: number | null,
   *   nowMs: number,
   *   history: Array<{ at: string, pct: number, resetsAt: string }>,
   * }} args  history = samples for THIS window key only, oldest-first.
   * @returns {{
   *   pct: number | null, resetsAt: string | null,
   *   state: 'unavailable' | 'exhausted' | 'warming_up' | 'will_hit' | 'safe',
   *   basis: 'recent' | 'window_avg' | null,
   *   etaAt: string | null, projectedEndPct: number | null,
   *   recentRatePctPerHour: number | null,
   * }}
   */
  export function projectWindow({ pct, resetsAt, windowMs, nowMs, history }) {
    const resetsAtMs = parseMs(resetsAt);
    if (
      pct == null ||
      !Number.isFinite(pct) ||
      resetsAtMs == null ||
      resetsAtMs <= nowMs ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0
    ) {
      return emptyForecast(pct, resetsAt, 'unavailable');
    }
    if (pct >= 100) return emptyForecast(pct, resetsAt, 'exhausted');

    const windowStartMs = resetsAtMs - windowMs;
    const elapsedMs = Math.min(Math.max(nowMs - windowStartMs, 0), windowMs);
    if (elapsedMs < WARMUP_FRACTION * windowMs) {
      return emptyForecast(pct, resetsAt, 'warming_up');
    }

    const recentRate = computeRecentRate({ pct, resetsAtMs, nowMs, history });
    const rate = recentRate ?? pct / elapsedMs;
    const basis = recentRate != null ? 'recent' : 'window_avg';
    const recentRatePctPerHour =
      recentRate != null ? round1(recentRate * 3600000) : null;

    if (rate <= 0) {
      return {
        pct,
        resetsAt,
        state: 'safe',
        basis,
        etaAt: null,
        projectedEndPct: Math.min(99, Math.round(pct)),
        recentRatePctPerHour,
      };
    }

    const etaMs = nowMs + (100 - pct) / rate;
    if (etaMs <= resetsAtMs) {
      return {
        pct,
        resetsAt,
        state: 'will_hit',
        basis,
        etaAt: isoAtSecond(etaMs),
        projectedEndPct: null,
        recentRatePctPerHour,
      };
    }
    return {
      pct,
      resetsAt,
      state: 'safe',
      basis,
      etaAt: null,
      projectedEndPct: Math.min(
        99,
        Math.round(pct + rate * (resetsAtMs - nowMs))
      ),
      recentRatePctPerHour,
    };
  }

  /**
   * Week-over-week context: how today's pct compares with the previous
   * window's pct at the same elapsed fraction. Non-null ONLY when the
   * window's own state is will_hit | safe (rides the same suppression gates
   * as the forecast). Null whenever the previous window has no usable
   * history — first week after install, sparse data, etc.
   *
   * @param {{ pct, resetsAt, windowMs, nowMs, history }} args — same shape
   *   as projectWindow; history = samples for this window key, oldest-first.
   * @returns {{ deltaPts: number, prevPctAtSamePoint: number } | null}
   */
  export function weekOverWeek({ pct, resetsAt, windowMs, nowMs, history }) {
    const forecast = projectWindow({ pct, resetsAt, windowMs, nowMs, history });
    if (forecast.state !== 'will_hit' && forecast.state !== 'safe') return null;
    if (!Array.isArray(history)) return null;

    const resetsAtMs = parseMs(resetsAt);

    // Previous-window cluster: newest sample whose resetsAt precedes the
    // current window beyond the same-window tolerance anchors the cluster;
    // members sit within ±tolerance of that anchor.
    let anchor = null;
    let anchorAtMs = null;
    const prior = [];
    for (const sample of history) {
      const atMs = parseMs(sample?.at);
      const sampleResetMs = parseMs(sample?.resetsAt);
      if (atMs == null || sampleResetMs == null) continue;
      if (!Number.isFinite(sample?.pct)) continue;
      if (sampleResetMs >= resetsAtMs - SAME_WINDOW_TOLERANCE_MS) continue;
      prior.push({ atMs, pct: sample.pct, resetMs: sampleResetMs });
      if (anchorAtMs == null || atMs > anchorAtMs) {
        anchor = sample;
        anchorAtMs = atMs;
      }
    }
    if (anchor == null) return null;
    const anchorResetMs = parseMs(anchor.resetsAt);
    const cluster = prior
      .filter((s) => Math.abs(s.resetMs - anchorResetMs) <= SAME_WINDOW_TOLERANCE_MS)
      .sort((a, b) => a.atMs - b.atMs);

    // Same-fraction target point inside the previous window.
    const elapsedMs = Math.min(
      Math.max(nowMs - (resetsAtMs - windowMs), 0),
      windowMs
    );
    const targetMs = anchorResetMs - windowMs + elapsedMs;

    let nearestDist = Infinity;
    for (const s of cluster) {
      nearestDist = Math.min(nearestDist, Math.abs(s.atMs - targetMs));
    }
    if (nearestDist > WOW_NEIGHBOR_TOLERANCE_MS) return null;

    let lower = null;
    let upper = null;
    for (const s of cluster) {
      if (s.atMs <= targetMs) lower = s;
      if (s.atMs >= targetMs && upper == null) upper = s;
    }
    let prevPct;
    if (lower != null && upper != null) {
      prevPct =
        lower.atMs === upper.atMs
          ? lower.pct
          : lower.pct +
            ((upper.pct - lower.pct) * (targetMs - lower.atMs)) /
              (upper.atMs - lower.atMs);
    } else {
      prevPct = (lower ?? upper).pct;
    }

    return {
      deltaPts: Math.round(pct - prevPct),
      prevPctAtSamePoint: Math.round(prevPct),
    };
  }

  /**
   * ROI run-rate pace: trailing-7-day API-equivalent spend scaled to 30 days,
   * compared with the subscription cost (same net-value semantics as the
   * dashboard multiplier). Null when subscriptionCost is unset/<=0 or when
   * there were no sessions in the trailing window (phantom-bucket lesson:
   * hide, never render a "-1x" zero-data verdict). NOT staleness-gated —
   * spend comes from local session logs, not extension ingest.
   *
   * @param {{ apiEquivalentSpendTrailing: number, subscriptionCost: number }} args
   * @returns {{ trailingDays: 7, apiEquivalentSpendTrailing: number,
   *   monthlyEquivalentValue: number, subscriptionCost: number,
   *   paceMultiple: number } | null}
   */
  export function roiPace({ apiEquivalentSpendTrailing, subscriptionCost }) {
    if (!Number.isFinite(subscriptionCost) || subscriptionCost <= 0) return null;
    if (
      !Number.isFinite(apiEquivalentSpendTrailing) ||
      apiEquivalentSpendTrailing === 0
    ) {
      return null;
    }
    const monthlyEquivalentValue = (apiEquivalentSpendTrailing / 7) * 30;
    return {
      trailingDays: 7,
      apiEquivalentSpendTrailing,
      monthlyEquivalentValue: round2(monthlyEquivalentValue),
      subscriptionCost,
      paceMultiple: round1(
        (monthlyEquivalentValue - subscriptionCost) / subscriptionCost
      ),
    };
  }

  function staleWindow(win, withWeekOverWeek) {
    const out = {
      pct: win.pct ?? null,
      resetsAt: win.resetsAt ?? null,
      state: 'stale',
      basis: null,
      etaAt: null,
      projectedEndPct: null,
      recentRatePctPerHour: null,
    };
    return withWeekOverWeek ? { ...out, weekOverWeek: null } : out;
  }

  /**
   * Assemble the full projection payload for /api/projection.
   *
   * @param {{
   *   normalized: object | null,         // UsageStore record's `normalized`
   *   ingestedAt: string | null,         // UsageStore record's `ingestedAt`
   *   history: { [windowKey: string]: Array<{ at, pct, resetsAt }> } | null,
   *   nowMs: number,
   *   apiEquivalentSpendTrailing: number, // dollars, per-token cost pipeline
   *   subscriptionCost: number,           // dollars
   * }} args
   * @returns {{ freshness: { ingested: boolean, ingestedAt: string | null,
   *   stale: boolean }, windows: object, roiPace: object | null }}
   */
  export function buildProjection({
    normalized,
    ingestedAt,
    history,
    nowMs,
    apiEquivalentSpendTrailing,
    subscriptionCost,
  }) {
    const stale = isStale({ ingestedAt, nowMs });
    const freshness = {
      ingested: parseMs(ingestedAt) != null,
      ingestedAt: ingestedAt ?? null,
      stale,
    };

    const windows = {};
    for (const key of Object.keys(WINDOW_MS)) {
      const win = normalized?.[key] ?? null;
      const wantsWow = key === WEEK_OVER_WEEK_KEY;
      if (win == null || typeof win !== 'object') {
        windows[key] = null; // phantom-bucket lesson: data-gate, no zeros
        continue;
      }
      if (stale) {
        windows[key] = staleWindow(win, wantsWow);
        continue;
      }
      const samples = Array.isArray(history?.[key]) ? history[key] : [];
      const args = {
        pct: win.pct ?? null,
        resetsAt: win.resetsAt ?? null,
        windowMs: WINDOW_MS[key],
        nowMs,
        history: samples,
      };
      const forecast = projectWindow(args);
      windows[key] = wantsWow
        ? { ...forecast, weekOverWeek: weekOverWeek(args) }
        : forecast;
    }

    return {
      freshness,
      windows,
      roiPace: roiPace({ apiEquivalentSpendTrailing, subscriptionCost }),
    };
  }
  ```

- [ ] **Step 6: Run the test and verify it PASSES**:

  ```bash
  node --test test/projection.test.js
  ```

  Expected output tail (GREEN — exit code 0):

  ```text
  # tests 39
  # suites 3
  # pass 39
  # fail 0
  ```

- [ ] **Step 7: Run the full JS suite** (no existing file was modified, so no regressions are possible — but verify):

  ```bash
  npm test
  ```

  Expected: summary ends with `# fail 0` (the run now includes the 39 new projection tests).

- [ ] **Step 8: Commit**:

  ```bash
  git add lib/projection.js test/projection.test.js test/fixtures/projection-vectors.json
  git commit -m "feat(projection): pure cross-platform projection engine + shared test vectors"
  ```

---

### Task 2: `lib/usage-history.js` — downsampled JSONL recorder with prune + drift tripwire (TDD)

Append-only recorder feeding the projection engine's history. Default path mirrors `lib/usage-store.js::defaultPath` (`lib/usage-store.js:13-15` — `join(homedir(), '.clauge', ...)`); file is `~/.clauge/usage-history.jsonl` beside `usage.json`. The drift tripwire follows the pure log-injectable pattern of `lib/usage-store.js::unknownKeysWarning` (`lib/usage-store.js:105-116`). `console.warn` only — `scripts/validate-no-console-log.cjs` scans `lib/` and forbids `console.log`. Wiring into `POST /api/usage/ingest` + startup prune is deliberately NOT in this task (it lands with the `/api/projection` endpoint task so `server.js` is touched once).

**Files:**
- Create: `test/usage-history.test.js` (directly in `test/` — glob landmine #14)
- Create: `lib/usage-history.js`
- Test: `node --test test/usage-history.test.js`

- [ ] **Step 1: Write the failing test** — create `test/usage-history.test.js` (node:test + `mkdtemp` in `os.tmpdir()`; fixed injected clock, never `Date.now()`):

  ```javascript
  import { describe, it, before, after } from 'node:test';
  import assert from 'node:assert/strict';
  import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import {
    SAMPLE_INTERVAL_MS,
    RETENTION_DAYS,
    UsageHistory,
    resetsAtDriftWarning,
  } from '../lib/usage-history.js';

  let TMP;

  before(async () => {
    TMP = await mkdtemp(join(tmpdir(), 'clauge-usage-history-'));
  });
  after(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  // Fixed, injected clock — never Date.now() (house rule).
  const T0_ISO = '2026-06-12T10:00:00.000Z';
  const T0_MS = Date.parse(T0_ISO);
  const atIso = (offsetMs) => new Date(T0_MS + offsetMs).toISOString();

  const NORMALIZED = {
    fiveHour: { pct: 13, resetsAt: '2026-06-12T14:20:00+00:00' },
    sevenDay: { pct: 59, resetsAt: '2026-06-17T23:00:00+00:00' },
    sevenDaySonnet: { pct: 31, resetsAt: '2026-06-17T23:00:00+00:00' },
    sevenDayOpus: { pct: 12, resetsAt: '2026-06-17T23:00:00+00:00' },
    claudeDesign: null,
    dailyRoutines: null,
    // Everything below must be EXCLUDED from the written line:
    sevenDayOmelette: { pct: 9, resetsAt: '2026-06-17T23:00:00+00:00' },
    sevenDayCowork: { pct: 7, resetsAt: '2026-06-17T23:00:00+00:00' },
    unknownSevenDayKeys: ['seven_day_aubergine'],
    extraUsage: { enabled: true, limitDollars: 20, usedDollars: 3 },
  };

  async function readLines(filePath) {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').filter((l) => l.trim() !== '');
  }

  describe('constants', () => {
    it('pins the spec values', () => {
      assert.equal(SAMPLE_INTERVAL_MS, 300000);
      assert.equal(RETENTION_DAYS, 90);
    });
  });

  describe('UsageHistory.record — downsample gate', () => {
    it('always appends the first record', async () => {
      const file = join(TMP, 'first.jsonl');
      const h = new UsageHistory({ filePath: file });
      assert.equal(await h.record(NORMALIZED, T0_ISO), true);
      const lines = await readLines(file);
      assert.equal(lines.length, 1);
      const obj = JSON.parse(lines[0]);
      assert.equal(obj.v, 1);
      assert.equal(obj.at, T0_ISO);
      assert.equal(obj.w.fiveHour.pct, 13);
      assert.equal(obj.w.fiveHour.resetsAt, '2026-06-12T14:20:00+00:00');
    });

    it('skips a second record within 5 minutes', async () => {
      const file = join(TMP, 'gate.jsonl');
      const h = new UsageHistory({ filePath: file });
      assert.equal(await h.record(NORMALIZED, T0_ISO), true);
      assert.equal(await h.record(NORMALIZED, atIso(4 * 60000)), false);
      assert.equal((await readLines(file)).length, 1);
    });

    it('appends again at exactly 5 minutes (gate is strict less-than)', async () => {
      const file = join(TMP, 'gate-eq.jsonl');
      const h = new UsageHistory({ filePath: file });
      assert.equal(await h.record(NORMALIZED, T0_ISO), true);
      assert.equal(await h.record(NORMALIZED, atIso(SAMPLE_INTERVAL_MS)), true);
      assert.equal((await readLines(file)).length, 2);
    });

    it('cold start reads the last line from disk (restart within 5 min stays gated)', async () => {
      const file = join(TMP, 'cold.jsonl');
      const a = new UsageHistory({ filePath: file });
      assert.equal(await a.record(NORMALIZED, T0_ISO), true);
      // Fresh instance, same file — simulates a sidecar restart.
      const b = new UsageHistory({ filePath: file });
      assert.equal(await b.record(NORMALIZED, atIso(2 * 60000)), false);
      assert.equal(await b.record(NORMALIZED, atIso(6 * 60000)), true);
      assert.equal((await readLines(file)).length, 2);
    });
  });

  describe('UsageHistory.record — window allowlist', () => {
    it('writes only the resolved non-null windows; codenames + non-window fields excluded', async () => {
      const file = join(TMP, 'allowlist.jsonl');
      const h = new UsageHistory({ filePath: file });
      await h.record(NORMALIZED, T0_ISO);
      const obj = JSON.parse((await readLines(file))[0]);
      assert.deepEqual(Object.keys(obj.w).sort(), [
        'fiveHour',
        'sevenDay',
        'sevenDayOpus',
        'sevenDaySonnet',
      ]);
      // null windows omitted:
      assert.equal('claudeDesign' in obj.w, false);
      assert.equal('dailyRoutines' in obj.w, false);
      // legacy codenames + non-window fields NEVER written:
      assert.equal('sevenDayOmelette' in obj.w, false);
      assert.equal('sevenDayCowork' in obj.w, false);
      assert.equal('extraUsage' in obj.w, false);
      assert.equal('unknownSevenDayKeys' in obj.w, false);
      assert.equal('unknownSevenDayKeys' in obj, false);
    });
  });

  describe('UsageHistory.record — never throws', () => {
    it('resolves false and console.warn-s on an unwritable directory', async (t) => {
      const lockedDir = join(TMP, 'locked');
      await mkdir(lockedDir, { recursive: true });
      await chmod(lockedDir, 0o500); // r-x: appendFile will EACCES
      t.after(async () => chmod(lockedDir, 0o700)); // so cleanup can rm it
      const warn = t.mock.method(console, 'warn', () => {});
      const h = new UsageHistory({ filePath: join(lockedDir, 'h.jsonl') });
      const appended = await h.record(NORMALIZED, T0_ISO); // must not throw
      assert.equal(appended, false);
      assert.ok(warn.mock.callCount() >= 1, 'console.warn fired');
      assert.match(
        String(warn.mock.calls[0].arguments[0]),
        /usage-history: failed to record/
      );
    });
  });

  describe('UsageHistory.samplesFor', () => {
    it('returns oldest-first {at, pct, resetsAt} for a key; [] for unknown keys', async () => {
      const file = join(TMP, 'samples.jsonl');
      const h = new UsageHistory({ filePath: file });
      await h.record(NORMALIZED, T0_ISO);
      await h.record(
        { ...NORMALIZED, fiveHour: { pct: 21, resetsAt: '2026-06-12T14:20:00+00:00' } },
        atIso(10 * 60000)
      );
      const samples = await h.samplesFor('fiveHour');
      assert.deepEqual(samples, [
        { at: T0_ISO, pct: 13, resetsAt: '2026-06-12T14:20:00+00:00' },
        { at: atIso(10 * 60000), pct: 21, resetsAt: '2026-06-12T14:20:00+00:00' },
      ]);
      assert.deepEqual(await h.samplesFor('sevenDayOmelette'), []);
      assert.deepEqual(await h.samplesFor('nonsense'), []);
    });

    it('returns [] for a missing file', async () => {
      const h = new UsageHistory({ filePath: join(TMP, 'no-such-file.jsonl') });
      assert.deepEqual(await h.samplesFor('fiveHour'), []);
    });

    it('skips corrupt lines and wrong-v lines, keeps valid ones', async () => {
      const file = join(TMP, 'tolerant.jsonl');
      const good1 = JSON.stringify({
        v: 1,
        at: T0_ISO,
        w: { fiveHour: { pct: 10, resetsAt: '2026-06-12T14:20:00+00:00' } },
      });
      const corrupt = '{"v":1,"at":"2026-06-12T10:0'; // truncated mid-write
      const wrongV = JSON.stringify({
        v: 2,
        at: atIso(5 * 60000),
        w: { fiveHour: { pct: 11, resetsAt: '2026-06-12T14:20:00+00:00' } },
      });
      const good2 = JSON.stringify({
        v: 1,
        at: atIso(10 * 60000),
        w: { fiveHour: { pct: 12, resetsAt: '2026-06-12T14:20:00+00:00' } },
      });
      await writeFile(file, [good1, corrupt, wrongV, good2].join('\n') + '\n');
      const samples = await (new UsageHistory({ filePath: file })).samplesFor('fiveHour');
      assert.deepEqual(
        samples.map((s) => s.pct),
        [10, 12]
      );
    });
  });

  describe('UsageHistory.prune', () => {
    it('drops >90-day-old lines via atomic rewrite and leaves no .tmp file', async () => {
      const file = join(TMP, 'prune.jsonl');
      const oldLine = JSON.stringify({
        v: 1,
        at: new Date(T0_MS - 100 * 86400000).toISOString(), // 100 days old
        w: { fiveHour: { pct: 5, resetsAt: '2026-03-04T14:20:00+00:00' } },
      });
      const freshLine = JSON.stringify({
        v: 1,
        at: new Date(T0_MS - 1 * 86400000).toISOString(), // 1 day old
        w: { fiveHour: { pct: 50, resetsAt: '2026-06-11T14:20:00+00:00' } },
      });
      await writeFile(file, oldLine + '\n' + freshLine + '\n');
      const h = new UsageHistory({ filePath: file });
      await h.prune(T0_MS);
      const lines = await readLines(file);
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]).w.fiveHour.pct, 50);
      await assert.rejects(access(file + '.tmp'), 'no .tmp leftover after rename');
    });

    it('is a no-op when nothing is older than the retention window', async () => {
      const file = join(TMP, 'prune-noop.jsonl');
      const freshLine = JSON.stringify({
        v: 1,
        at: T0_ISO,
        w: { fiveHour: { pct: 50, resetsAt: '2026-06-12T14:20:00+00:00' } },
      });
      await writeFile(file, freshLine + '\n');
      const h = new UsageHistory({ filePath: file });
      await h.prune(T0_MS);
      assert.equal((await readLines(file)).length, 1);
      await assert.rejects(access(file + '.tmp'));
    });

    it('silently returns when the file does not exist', async () => {
      const h = new UsageHistory({ filePath: join(TMP, 'prune-missing.jsonl') });
      await h.prune(T0_MS); // must not throw
    });
  });

  describe('resetsAtDriftWarning (pure tripwire)', () => {
    it('fires when resetsAt moved 5min<delta<1h while pct rose', () => {
      const calls = [];
      const fired = resetsAtDriftWarning(
        'fiveHour',
        { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
        { pct: 45, resetsAt: '2026-06-12T14:50:00+00:00' }, // +30 min
        (msg) => calls.push(msg)
      );
      assert.equal(fired, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /\[Clauge] resetsAt-drift/);
      assert.match(calls[0], /"fiveHour"/);
    });

    it('does NOT fire when the delta is within the 5-minute tolerance', () => {
      const calls = [];
      const fired = resetsAtDriftWarning(
        'fiveHour',
        { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
        { pct: 45, resetsAt: '2026-06-12T14:22:00+00:00' }, // +2 min
        (msg) => calls.push(msg)
      );
      assert.equal(fired, false);
      assert.equal(calls.length, 0);
    });

    it('does NOT fire when the delta is 1h or more (real window change)', () => {
      const calls = [];
      const fired = resetsAtDriftWarning(
        'fiveHour',
        { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
        { pct: 45, resetsAt: '2026-06-12T19:20:00+00:00' }, // +5 h
        (msg) => calls.push(msg)
      );
      assert.equal(fired, false);
    });

    it('does NOT fire when pct fell (a reset, not drift)', () => {
      const calls = [];
      const fired = resetsAtDriftWarning(
        'fiveHour',
        { pct: 90, resetsAt: '2026-06-12T14:20:00+00:00' },
        { pct: 3, resetsAt: '2026-06-12T14:50:00+00:00' },
        (msg) => calls.push(msg)
      );
      assert.equal(fired, false);
    });
  });

  describe('UsageHistory drift tripwire — once per window per process', () => {
    it('warns on the first ambiguous-zone pair only', async (t) => {
      const file = join(TMP, 'drift.jsonl');
      const warn = t.mock.method(console, 'warn', () => {});
      const h = new UsageHistory({ filePath: file });
      const win = (pct, resetsAt) => ({
        ...NORMALIZED,
        fiveHour: { pct, resetsAt },
      });
      await h.record(win(40, '2026-06-12T14:20:00+00:00'), T0_ISO);
      // +30 min resetsAt drift while pct rose -> ambiguous zone -> warn
      await h.record(win(45, '2026-06-12T14:50:00+00:00'), atIso(5 * 60000));
      // Another ambiguous pair for the SAME window -> must NOT warn again
      await h.record(win(50, '2026-06-12T15:20:00+00:00'), atIso(10 * 60000));
      const driftCalls = warn.mock.calls.filter((c) =>
        String(c.arguments[0]).includes('resetsAt-drift')
      );
      assert.equal(driftCalls.length, 1);
      assert.match(String(driftCalls[0].arguments[0]), /"fiveHour"/);
    });
  });
  ```

- [ ] **Step 2: Run the test and verify it FAILS** (module doesn't exist yet):

  ```bash
  node --test test/usage-history.test.js
  ```

  Expected output (RED — exit code 1):

  ```text
  # Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/adnanrashid/Projects/clauge/lib/usage-history.js' imported from /Users/adnanrashid/Projects/clauge/test/usage-history.test.js
  # pass 0
  # fail 1
  ```

- [ ] **Step 3: Implement the recorder** — create `lib/usage-history.js` with exactly this content:

  ```javascript
  /**
   * Downsampled usage-history recorder for the on-device projection engine.
   *
   * POST /api/usage/ingest calls record() fire-and-forget AFTER normalizeUsage
   * — a recorder failure must NEVER fail an ingest (record catches everything
   * and console.warn's). Samples land in ~/.clauge/usage-history.jsonl beside
   * usage.json, append-only JSON Lines: a crash mid-write loses at most one
   * line. lib/projection.js consumes samplesFor(key) per window.
   *
   * Line shape (v1): {"v":1,"at":"<ISO>","w":{<only non-null resolved windows>}}
   *
   * Spec: docs/superpowers/specs/2026-06-12-on-device-projection-design.md
   */

  import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
  import { homedir } from 'node:os';
  import { join, dirname } from 'node:path';

  /** Append at most one sample per this interval (extension posts ~1/min). */
  export const SAMPLE_INTERVAL_MS = 300000; // 5 min

  /** prune() drops samples older than this many days. */
  export const RETENTION_DAYS = 90;

  const RETENTION_MS = RETENTION_DAYS * 86400000;

  // Exhaustive allowlist: exactly the six RESOLVED window keys. The legacy
  // raw-codename duplicates normalizeUsage also emits (sevenDayOmelette,
  // sevenDayCowork — same windows as the resolved pair) and the non-window
  // fields (extraUsage, unknownSevenDayKeys) are EXCLUDED. Mirrors
  // WINDOW_MS in lib/projection.js — keep the two key lists in sync.
  const WINDOW_KEYS = [
    'fiveHour',
    'sevenDay',
    'sevenDaySonnet',
    'sevenDayOpus',
    'claudeDesign',
    'dailyRoutines',
  ];

  // Drift-tripwire ambiguous zone: resetsAt moved by MORE than the projection
  // engine's same-window tolerance (5 min) but LESS than a real window change
  // would move it (hours/days — 1 h is the conservative floor), while pct
  // kept rising (so it was NOT a reset). Mirrors SAME_WINDOW_TOLERANCE_MS in
  // lib/projection.js.
  const DRIFT_ZONE_MIN_MS = 300000; // 5 min
  const DRIFT_ZONE_MAX_MS = 3600000; // 1 h

  function defaultPath() {
    return join(homedir(), '.clauge', 'usage-history.jsonl');
  }

  function parseMs(value) {
    if (typeof value !== 'string' || value === '') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Emit a drift warning when two consecutive samples of one window land in
   * the ambiguous resetsAt zone (delta between 5 min and 1 h) while pct rose
   * — evidence the ±5 min same-window tolerance in lib/projection.js may be
   * too tight, which would silently degrade forecasts. Pure + log-injectable
   * (pattern: lib/usage-store.js::unknownKeysWarning). Returns true iff a
   * warning was emitted.
   *
   * @param {string} key  window key (e.g. 'fiveHour')
   * @param {{ pct: number | null, resetsAt: string | null }} prev
   * @param {{ pct: number | null, resetsAt: string | null }} next
   * @param {(message: string) => void} log
   * @returns {boolean}
   */
  export function resetsAtDriftWarning(key, prev, next, log) {
    const prevResetMs = parseMs(prev?.resetsAt);
    const nextResetMs = parseMs(next?.resetsAt);
    if (prevResetMs == null || nextResetMs == null) return false;
    if (!Number.isFinite(prev?.pct) || !Number.isFinite(next?.pct)) return false;
    const delta = Math.abs(nextResetMs - prevResetMs);
    if (delta <= DRIFT_ZONE_MIN_MS || delta >= DRIFT_ZONE_MAX_MS) return false;
    if (next.pct <= prev.pct) return false;
    log(
      `[Clauge] resetsAt-drift: window "${key}" resetsAt moved ` +
        `${Math.round(delta / 60000)} min between consecutive samples while ` +
        `pct rose (${prev.pct} -> ${next.pct}). The 5-min same-window ` +
        `tolerance in lib/projection.js may be too tight — forecasts could ` +
        `silently degrade.`
    );
    return true;
  }

  export class UsageHistory {
    constructor({ filePath = defaultPath() } = {}) {
      this.filePath = filePath;
      // undefined = cold start (must read the file's last line once);
      // null = known-empty file; otherwise { atMs, w }.
      this.lastSample = undefined;
      // Drift tripwire fires once per window per process.
      this.driftWarnedKeys = new Set();
    }

    /** Cold-start downsample gate: read the last valid line from disk. */
    async #lastSampleFromDisk() {
      let raw;
      try {
        raw = await readFile(this.filePath, 'utf8');
      } catch {
        return null; // missing file = empty history
      }
      const lines = raw.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line === '') continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // corrupt line — skip, never fatal
        }
        if (!obj || obj.v !== 1) continue;
        const atMs = parseMs(obj.at);
        if (atMs == null) continue;
        return { atMs, w: obj.w && typeof obj.w === 'object' ? obj.w : {} };
      }
      return null;
    }

    /**
     * Append one sample if >= SAMPLE_INTERVAL_MS since the last appended
     * sample. Never throws to the caller — any failure console.warn's and
     * resolves false. Returns true iff a line was appended.
     *
     * @param {object | null} normalized  normalizeUsage output
     * @param {string} atIso  sample timestamp (ISO) — injected, never Date.now()
     * @returns {Promise<boolean>}
     */
    async record(normalized, atIso) {
      try {
        if (!normalized || typeof normalized !== 'object') return false;
        const atMs = parseMs(atIso);
        if (atMs == null) return false;

        const w = {};
        for (const key of WINDOW_KEYS) {
          const win = normalized[key];
          if (win && typeof win === 'object') {
            w[key] = { pct: win.pct ?? null, resetsAt: win.resetsAt ?? null };
          }
        }
        if (Object.keys(w).length === 0) return false; // nothing to record

        if (this.lastSample === undefined) {
          this.lastSample = await this.#lastSampleFromDisk();
        }
        if (this.lastSample && atMs - this.lastSample.atMs < SAMPLE_INTERVAL_MS) {
          return false; // downsample gate
        }

        if (this.lastSample) {
          for (const key of WINDOW_KEYS) {
            if (this.driftWarnedKeys.has(key)) continue;
            const prev = this.lastSample.w?.[key];
            const next = w[key];
            if (prev && next && resetsAtDriftWarning(key, prev, next, console.warn)) {
              this.driftWarnedKeys.add(key);
            }
          }
        }

        const line =
          JSON.stringify({ v: 1, at: new Date(atMs).toISOString(), w }) + '\n';
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        await appendFile(this.filePath, line, { mode: 0o600 });
        this.lastSample = { atMs, w };
        return true;
      } catch (err) {
        console.warn(
          `[Clauge] usage-history: failed to record sample — ${err?.message ?? err}`
        );
        return false;
      }
    }

    /**
     * All samples for one window key, oldest-first (file order). Unparseable
     * and wrong-v lines are skipped; missing file = []. Unknown key = [].
     *
     * @param {string} key
     * @returns {Promise<Array<{ at: string, pct: number | null, resetsAt: string | null }>>}
     */
    async samplesFor(key) {
      let raw;
      try {
        raw = await readFile(this.filePath, 'utf8');
      } catch {
        return [];
      }
      const out = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let obj;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          continue; // corrupt line — skip
        }
        if (!obj || obj.v !== 1 || typeof obj.at !== 'string') continue;
        const win = obj.w?.[key];
        if (!win || typeof win !== 'object') continue;
        out.push({ at: obj.at, pct: win.pct ?? null, resetsAt: win.resetsAt ?? null });
      }
      return out;
    }

    /**
     * Drop samples older than RETENTION_DAYS via atomic rewrite (tmp +
     * rename). Unparseable lines are dropped too (their age is unknowable
     * and the read path skips them anyway). No-op when nothing to drop.
     * Never throws.
     *
     * @param {number} nowMs  injected clock — never Date.now()
     * @returns {Promise<void>}
     */
    async prune(nowMs) {
      try {
        let raw;
        try {
          raw = await readFile(this.filePath, 'utf8');
        } catch {
          return; // missing file — nothing to prune
        }
        const cutoffMs = nowMs - RETENTION_MS;
        const kept = [];
        let dropped = 0;
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          let obj;
          try {
            obj = JSON.parse(trimmed);
          } catch {
            dropped++;
            continue;
          }
          const atMs = obj && obj.v === 1 ? parseMs(obj.at) : null;
          if (atMs != null && atMs >= cutoffMs) {
            kept.push(trimmed);
          } else {
            dropped++;
          }
        }
        if (dropped === 0) return;
        const tmpPath = this.filePath + '.tmp';
        await writeFile(tmpPath, kept.length ? kept.join('\n') + '\n' : '', {
          mode: 0o600,
        });
        await rename(tmpPath, this.filePath);
      } catch (err) {
        console.warn(
          `[Clauge] usage-history: prune failed — ${err?.message ?? err}`
        );
      }
    }
  }
  ```

- [ ] **Step 4: Run the test and verify it PASSES**:

  ```bash
  node --test test/usage-history.test.js
  ```

  Expected output tail (GREEN — exit code 0):

  ```text
  # tests 18
  # suites 8
  # pass 18
  # fail 0
  ```

- [ ] **Step 5: Run the full JS suite + the lib validators** (the new lib file must clear `validate-no-console-log` — it uses `console.warn` only, which is allowed):

  ```bash
  npm test && node scripts/validate-no-console-log.cjs
  ```

  Expected: npm-test summary ends with `# fail 0`, then `[validate-no-console-log] OK - scanned N JS files in lib/ + popover/`.

- [ ] **Step 6: Commit**:

  ```bash
  git add lib/usage-history.js test/usage-history.test.js
  git commit -m "feat(usage-history): downsampled JSONL recorder with 90-day prune and resetsAt drift tripwire"
  ```
### Task 3: Subscription cost becomes a persisted setting — `lib/config-store.js` + server wiring + `POST /api/config/subscription-cost`

**Files:**
- Create: `lib/config-store.js`
- Create: `test/config-store.test.js`
- Modify: `server.js` — import block (after line 39 `import { buildSnapshot } from './lib/snapshot.js';`), the `SUBSCRIPTION_COST` const (line 67), its four consumers (`/api/health` line 245, `/api/roi` line 532, `/api/snapshot` line 547, `/api/config` line 557), and a new POST route after the providers handler (line 582)
- Test (extend): `test/server-additions.test.js` — append a new `describe` block after line 210 (end of file)

`lib/snapshot.js` is **unchanged** — `buildSnapshot` already receives `subscriptionCost` as a parameter (`lib/snapshot.js:215`); only the `server.js` call site changes.

- [ ] **Step 1: Write the failing unit test for ConfigStore.**

Create `test/config-store.test.js`:

```js
// Unit tests for lib/config-store.js (Component 4 of the on-device
// projection spec, docs/superpowers/specs/2026-06-12-on-device-projection-design.md).
//
// Precedence under test: file value -> SUBSCRIPTION_COST env -> 200, with
// read-side validation at EVERY tier (non-finite, <= 0, or wrong-typed
// values are treated as ABSENT and fall through to the next tier).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore } from '../lib/config-store.js';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clauge-config-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(env = {}) {
  return new ConfigStore({ filePath: join(dir, 'config.json'), env });
}

async function writeConfig(contents) {
  await writeFile(join(dir, 'config.json'), contents);
}

describe('effectiveSubscriptionCost — default tier', () => {
  it('returns 200 when no file and no env', async () => {
    assert.equal(await makeStore({}).effectiveSubscriptionCost(), 200);
  });
});

describe('effectiveSubscriptionCost — env tier', () => {
  it('uses a valid numeric env string', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('treats a non-numeric env string as absent (falls to 200)', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'abc' }).effectiveSubscriptionCost(), 200);
  });

  it('treats env "0" as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '0' }).effectiveSubscriptionCost(), 200);
  });

  it('treats a negative env value as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '-5' }).effectiveSubscriptionCost(), 200);
  });

  it('treats env "Infinity" as absent (non-finite)', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'Infinity' }).effectiveSubscriptionCost(), 200);
  });

  it('treats an empty env string as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '' }).effectiveSubscriptionCost(), 200);
  });
});

describe('effectiveSubscriptionCost — file tier', () => {
  it('file value beats env and default', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 120 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 120);
  });

  it('file 0 is treated absent — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 0 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file negative is treated absent — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: -3 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file STRING "250" is treated absent (no coercion of hand-edits) — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: '250' }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file with missing key falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('corrupt JSON file is treated absent — falls to env', async () => {
    await writeConfig('{ this is not json');
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('invalid file AND invalid env fall all the way to 200', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: -1 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'nope' }).effectiveSubscriptionCost(), 200);
  });
});

describe('setSubscriptionCost', () => {
  it('rejects non-finite, non-positive, and non-number values', async () => {
    const store = makeStore({});
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '150', null, undefined]) {
      await assert.rejects(
        () => store.setSubscriptionCost(bad),
        /finite number > 0/,
        `expected rejection for ${String(bad)}`
      );
    }
  });

  it('writes {"v":1,"subscriptionCost":n} and a fresh instance rereads it (file beats env)', async () => {
    const store = makeStore({ SUBSCRIPTION_COST: '150' });
    await store.setSubscriptionCost(120);

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk, { v: 1, subscriptionCost: 120 });

    assert.equal(await store.effectiveSubscriptionCost(), 120, 'same instance');
    assert.equal(
      await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(),
      120,
      'fresh instance rereads the persisted value'
    );
  });

  it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
    await makeStore({}).setSubscriptionCost(99);
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['config.json']);
  });

  it('creates the parent directory when missing', async () => {
    const nested = new ConfigStore({
      filePath: join(dir, 'deeper', '.clauge', 'config.json'),
      env: {},
    });
    await nested.setSubscriptionCost(42);
    assert.equal(await nested.effectiveSubscriptionCost(), 42);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails for the right reason.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/config-store.test.js
```

Expected: the file fails to even load —

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/adnanrashid/Projects/clauge/lib/config-store.js' imported from /Users/adnanrashid/Projects/clauge/test/config-store.test.js
...
# fail 1
```

- [ ] **Step 3: Implement `lib/config-store.js` (minimal, pure file/env logic — no clock, no console.log).**

Create `lib/config-store.js`:

```js
/**
 * Sidecar-owned persistent config (~/.clauge/config.json).
 *
 * Holds the user's subscription cost (Component 4 of the on-device
 * projection spec). DELIBERATELY a sidecar-owned file, NOT the shared Tauri
 * settings.json: since v1.1.0 the Rust iCloud publish loop calls
 * store.save() at least every 300s and tauri-plugin-store rewrites the
 * whole file from its in-memory map — any key the sidecar wrote after the
 * store loaded would be silently erased within minutes. This file has
 * exactly one writer: the sidecar.
 *
 * Read precedence for the subscription cost:
 *   1. file value (~/.clauge/config.json :: subscriptionCost)
 *   2. SUBSCRIPTION_COST env var
 *   3. 200 (default)
 * Read-side validation at EVERY tier: a value that is not a finite number
 * > 0 is treated as ABSENT and falls through to the next tier — a
 * hand-edited 0, negative, or string never reaches the ROI math.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_SUBSCRIPTION_COST = 200;

function defaultPath() {
  return join(homedir(), '.clauge', 'config.json');
}

/**
 * Read-side validation: returns the value when it is a finite number > 0,
 * otherwise null (treated as absent — caller falls through to next tier).
 * Strict typeof check: a JSON string "250" in the file is NOT coerced.
 * @param {unknown} value
 * @returns {number|null}
 */
function validCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export class ConfigStore {
  constructor({ filePath = defaultPath(), env = process.env } = {}) {
    this.filePath = filePath;
    this.env = env;
  }

  /**
   * Effective subscription cost: file -> env -> 200. Reads the file per
   * call (no cache) so a hand edit or another instance's write is picked
   * up immediately; the file is tiny and the endpoints are low-traffic.
   * @returns {Promise<number>}
   */
  async effectiveSubscriptionCost() {
    let fileValue = null;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      fileValue = validCost(parsed?.subscriptionCost);
    } catch {
      // Missing or corrupt file — treated as absent, fall through.
    }
    if (fileValue != null) return fileValue;

    // Env vars are strings — coerce with Number() THEN validate. A
    // non-numeric, empty, zero, negative, or non-finite env value is
    // treated as absent (Number('') === 0 and Number('abc') is NaN;
    // both fail validCost).
    const envValue = validCost(Number(this.env?.SUBSCRIPTION_COST));
    if (envValue != null) return envValue;

    return DEFAULT_SUBSCRIPTION_COST;
  }

  /**
   * Persist a new subscription cost. Validates (finite number > 0, strict
   * type) and writes atomically (tmp + rename) so a crash mid-write can
   * never leave a torn config.json.
   * @param {number} n
   * @returns {Promise<number>} the persisted value
   */
  async setSubscriptionCost(n) {
    if (validCost(n) == null) {
      throw new Error(
        `subscriptionCost must be a finite number > 0, got: ${String(n)}`
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(
      tmpPath,
      JSON.stringify({ v: 1, subscriptionCost: n }, null, 2),
      { mode: 0o600 }
    );
    await rename(tmpPath, this.filePath);
    return n;
  }
}
```

- [ ] **Step 4: Run the unit test and verify it passes.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/config-store.test.js
```

Expected:

```
# tests 18
# pass 18
# fail 0
```

- [ ] **Step 5: Commit the ConfigStore cycle.**

```bash
cd /Users/adnanrashid/Projects/clauge && git add lib/config-store.js test/config-store.test.js && git commit -m "feat(config): ConfigStore — persisted subscription cost, file->env->200 precedence with read-side validation"
```

- [ ] **Step 6: Write the failing server-level test (append to `test/server-additions.test.js`).**

Append this block at the end of `test/server-additions.test.js` (after line 210, the closing `});` of the `SIGTERM graceful shutdown` describe). The file already imports `mkdtemp`, `readFile`, `rm`, and `tmpdir` — no import changes needed:

```js
// Component 4 of the on-device projection spec: the subscription cost is a
// persisted sidecar-owned setting (~/.clauge/config.json) with precedence
// file -> SUBSCRIPTION_COST env -> 200, editable at runtime via
// POST /api/config/subscription-cost (no sidecar restart needed).
// HOME-redirect caveat: os.homedir() reads USERPROFILE (not HOME) on
// Windows, so the sandbox redirect is silently ignored there — skip, same
// rationale as the SIGTERM suite above.
describe('subscription-cost setting (POST /api/config/subscription-cost)', {
  skip: process.platform === 'win32'
    ? 'HOME redirect ignored on Windows (os.homedir() uses USERPROFILE)'
    : false,
}, () => {
  let server, home;
  const PORT = '3505';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-config-`);
    // Pin the env tier explicitly so an ambient SUBSCRIPTION_COST (.env or
    // shell) can't make the precedence assertions flaky.
    server = await startServer({ PORT, HOME: home, SUBSCRIPTION_COST: '175' });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('serves the env-tier cost when nothing is persisted', async () => {
    const res = await fetch(`${BASE}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscriptionCost, 175);
  });

  it('rejects invalid bodies with 400 and leaves the effective cost unchanged', async () => {
    const badBodies = [
      'not json at all',
      '{}',
      '{"subscriptionCost":0}',
      '{"subscriptionCost":-5}',
      '{"subscriptionCost":"150"}',
      '{"subscriptionCost":null}',
    ];
    for (const body of badBodies) {
      const res = await fetch(`${BASE}/api/config/subscription-cost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, `expected 400 for body: ${body}`);
    }
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert.equal(cfg.subscriptionCost, 175, 'effective cost untouched by rejected posts');
  });

  it('persists a valid cost and every consumer reflects it without a restart', async () => {
    const res = await fetch(`${BASE}/api/config/subscription-cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionCost: 120 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subscriptionCost: 120 });

    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert.equal(cfg.subscriptionCost, 120, '/api/config reflects the persisted value');

    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(health.subscriptionCost, 120, '/api/health reflects the persisted value');

    const roi = await (await fetch(`${BASE}/api/roi`)).json();
    assert.equal(roi.subscriptionCost, 120, '/api/roi computes against the persisted value');

    const snapshot = await (await fetch(`${BASE}/api/snapshot`)).json();
    assert.equal(snapshot.roi.subscriptionCost, 120, '/api/snapshot ROI block uses the persisted value');

    const persisted = JSON.parse(await readFile(`${home}/.clauge/config.json`, 'utf8'));
    assert.deepEqual(persisted, { v: 1, subscriptionCost: 120 });
  });
});
```

- [ ] **Step 7: Run the server-level test and verify the new block fails for the right reason.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/server-additions.test.js
```

Expected: the 5 pre-existing tests pass and the first new test passes too (the startup const already reads the env), but the two POST-dependent tests fail because the route doesn't exist — Hono falls through to `serveStatic` and returns 404:

```
✖ rejects invalid bodies with 400 ...   AssertionError ... 404 !== 400
✖ persists a valid cost ...             AssertionError ... 404 !== 200
# pass 6
# fail 2
```

- [ ] **Step 8: Wire `server.js` — seven surgical edits.**

**Edit 8a — import (server.js:38–39).** Old:

```js
import { apiReplacementValue, sumSessionCosts } from './lib/roi-calculator.js';
import { buildSnapshot } from './lib/snapshot.js';
```

New:

```js
import { apiReplacementValue, sumSessionCosts } from './lib/roi-calculator.js';
import { buildSnapshot } from './lib/snapshot.js';
import { ConfigStore } from './lib/config-store.js';
```

**Edit 8b — replace the startup const (server.js:67).** Old:

```js
const SUBSCRIPTION_COST = Number(process.env.SUBSCRIPTION_COST ?? 200);
```

New:

```js
// Subscription cost is a persisted setting (projection spec Component 4):
// ~/.clauge/config.json value -> SUBSCRIPTION_COST env -> 200, validated
// read-side at every tier. Resolved per request via the getter so a
// POST /api/config/subscription-cost applies without a sidecar restart.
const configStore = new ConfigStore({
  filePath: join(homedir(), '.clauge', 'config.json'),
  env: process.env,
});
```

(`join` and `homedir` are already imported at server.js:13–14.)

**Edit 8c — `/api/health` (server.js:245, inside the handler at 237–248).** Old:

```js
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: SUBSCRIPTION_COST,
    extensionLastSeenAt: record?.ingestedAt ?? null,
```

New:

```js
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    extensionLastSeenAt: record?.ingestedAt ?? null,
```

**Edit 8d — `/api/roi` (server.js:532, inside the handler at 524–536).** Old:

```js
    ...apiReplacementValue({
      apiEquivalentSpend,
      subscriptionCost: SUBSCRIPTION_COST,
      extraUsageSpend: 0,
    }),
```

New:

```js
    ...apiReplacementValue({
      apiEquivalentSpend,
      subscriptionCost: await configStore.effectiveSubscriptionCost(),
      extraUsageSpend: 0,
    }),
```

**Edit 8e — `/api/snapshot` (server.js:547, inside the handler at 542–551; `lib/snapshot.js` itself unchanged).** Old:

```js
  const snapshot = await buildSnapshot({
    store,
    usageStore,
    subscriptionCost: SUBSCRIPTION_COST,
    tz,
  });
```

New:

```js
  const snapshot = await buildSnapshot({
    store,
    usageStore,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    tz,
  });
```

**Edit 8f — `/api/config` (server.js:557, inside the handler at 553–561).** Old:

```js
  return c.json({
    claudeDir: CLAUDE_DIR,
    subscriptionCost: SUBSCRIPTION_COST,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    providers,
  });
```

New:

```js
  return c.json({
    claudeDir: CLAUDE_DIR,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    providers,
  });
```

**Edit 8g — new POST route.** Insert after the closing `});` of `app.post('/api/config/providers/:name', ...)` (server.js:582) and before `app.post('/api/usage/ingest', ...)` (server.js:584):

```js
// Component 4 (projection spec): editable subscription cost. Mirrors the
// providers handler above: same-origin dashboard POST, no CORS middleware
// (READ_ONLY_API_PATHS' '/api/config' entry does not match this subpath,
// and the dashboard is served from this same origin). Validation matches
// ConfigStore.setSubscriptionCost: finite number > 0, strict type.
app.post('/api/config/subscription-cost', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const cost = body?.subscriptionCost;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return c.json({ error: 'expected body: { subscriptionCost: <number > 0> }' }, 400);
  }
  await configStore.setSubscriptionCost(cost);
  return c.json({ subscriptionCost: await configStore.effectiveSubscriptionCost() });
});
```

After these edits, `grep -n "SUBSCRIPTION_COST" server.js` must show ZERO remaining references to the old const (the only hit is the `env` doc comment / ConfigStore wiring) — the const identifier is gone.

- [ ] **Step 9: Run the server-level suite and verify it passes, then the full JS suite.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/server-additions.test.js
```

Expected:

```
# pass 8
# fail 0
```

Then the whole JS suite (catches any consumer regression — `test/cors-allowlist.test.js`, `test/snapshot.test.js`, etc.):

```bash
cd /Users/adnanrashid/Projects/clauge && npm test
```

Expected: `# fail 0` across all suites.

- [ ] **Step 10: Commit the server wiring cycle.**

```bash
cd /Users/adnanrashid/Projects/clauge && git add server.js test/server-additions.test.js && git commit -m "feat(server): serve subscription cost via ConfigStore getter + POST /api/config/subscription-cost"
```

---

### Task 4: `GET /api/projection` endpoint + usage-history ingest hook

**Files:**
- Create: `test/server-projection.test.js`
- Modify: `server.js` — import block (extends Task 3's Edit 8a), `usageHistory` instantiation after `await usageStore.load()` (line 86 pre-Task-3), `READ_ONLY_API_PATHS` (line 176 pre-Task-3, the `'/api/activity',` entry), ingest hook inside `POST /api/usage/ingest` (between lines 612 and 613 pre-Task-3), and the new GET route after `/api/roi` (line 536 pre-Task-3)

Line anchors below are against current main; after Task 3's edits they shift by roughly +25 lines — every edit quotes its exact surrounding code, so locate by the quoted context. Depends on PR 1 (`lib/projection.js`, `lib/usage-history.js`) being merged: pinned interfaces `buildProjection({normalized, ingestedAt, history, nowMs, apiEquivalentSpendTrailing, subscriptionCost})`, `WINDOW_MS` (keys: `fiveHour`, `sevenDay`, `sevenDaySonnet`, `sevenDayOpus`, `claudeDesign`, `dailyRoutines`), `UsageHistory { record(normalized, atIso), samplesFor(key), prune(nowMs) }`.

- [ ] **Step 1: Write the failing endpoint + ingest-hook test.**

Create `test/server-projection.test.js`:

```js
// Integration tests for GET /api/projection + the usage-history ingest hook
// (on-device projection spec, Components 2 + 3). Spawns the real Hono server
// as a subprocess (server-additions style). The projection MATH is covered by
// test/projection.test.js — these tests assert only the wrapper plumbing:
// READ_ONLY_API_PATHS membership (ACAO reflection — the silent-CORS-denial
// failure mode), top-level response shape, and the ingest-side recorder.
//
// HOME is redirected to a tmp dir so ~/.clauge/{usage.json,usage-history.jsonl,
// config.json} and ~/.claude all resolve inside the sandbox. os.homedir()
// reads USERPROFILE (not HOME) on Windows, so these suites skip there — same
// pattern as the SIGTERM persistence suite in server-additions.test.js.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

const WINDOW_KEYS = [
  'fiveHour',
  'sevenDay',
  'sevenDaySonnet',
  'sevenDayOpus',
  'claudeDesign',
  'dailyRoutines',
];

const SKIP_WIN = process.platform === 'win32'
  ? 'HOME redirect ignored on Windows (os.homedir() uses USERPROFILE)'
  : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(envOverrides = {}) {
  const child = spawn(SERVER_BIN, SERVER_ARGS, {
    env: { ...process.env, NO_OPEN: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
      const onData = (buf) => {
        if (buf.toString().includes('Listening on')) {
          child.stdout.off('data', onData);
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });
    return child;
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
}

// GET with an explicit Origin header (cors-allowlist.test.js pattern — node
// http.request, not fetch, so the Origin header is fully under our control).
// Resolves { status, acao, body } where body is parsed JSON or null.
function getWithOrigin(port, path, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), path, method: 'GET', headers: { Origin: origin } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (b) => { buf += b; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(buf); } catch { /* non-JSON (e.g. 404 page) */ }
          resolve({
            status: res.statusCode,
            acao: res.headers['access-control-allow-origin'] ?? null,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/projection — nothing ingested', { skip: SKIP_WIN }, () => {
  let server, home;
  const PORT = '3530';

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-projection-`);
    server = await startServer({ PORT, HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('reflects the loopback Origin (proves READ_ONLY_API_PATHS membership)', async () => {
    const origin = `http://127.0.0.1:${PORT}`;
    const r = await getWithOrigin(PORT, '/api/projection', origin);
    assert.equal(r.status, 200);
    assert.equal(r.acao, origin, 'loopback origin echoed as ACAO');
  });

  it('denies a foreign website origin (no ACAO echo)', async () => {
    const r = await getWithOrigin(PORT, '/api/projection', 'https://evil.example');
    assert.notEqual(r.acao, 'https://evil.example');
    assert.notEqual(r.acao, '*');
  });

  it('returns never-ingested freshness with every window suppressed', async () => {
    const r = await getWithOrigin(PORT, '/api/projection', `http://127.0.0.1:${PORT}`);
    assert.equal(r.status, 200);
    const body = r.body;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['freshness', 'generatedAt', 'roiPace', 'windows'],
      'top-level keys are exactly {generatedAt, freshness, windows, roiPace}'
    );
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(body.freshness.ingested, false);
    assert.equal(body.freshness.ingestedAt, null);
    assert.equal(body.freshness.stale, true);
    for (const key of WINDOW_KEYS) {
      assert.ok(key in body.windows, `windows.${key} key present`);
      const w = body.windows[key];
      assert.ok(
        w === null || w.state === 'stale',
        `windows.${key} suppressed when never ingested, got ${JSON.stringify(w)}`
      );
    }
    // roiPace is NOT staleness-gated; it is null HERE because the sandboxed
    // HOME has zero sessions (apiEquivalentSpendTrailing === 0 -> null).
    assert.equal(body.roiPace, null);
  });
});

describe('POST /api/usage/ingest records a usage-history sample', { skip: SKIP_WIN }, () => {
  let server, home;
  const PORT = '3531';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-projection-ingest-`);
    server = await startServer({ PORT, HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  const resetsFiveHour = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const resetsSevenDay = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  it('creates a usage-history.jsonl line after a successful ingest', async () => {
    const res = await fetch(`${BASE}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage: {
          five_hour: { utilization: 20, resets_at: resetsFiveHour },
          seven_day: { utilization: 50, resets_at: resetsSevenDay },
        },
      }),
    });
    assert.equal(res.status, 200);

    // The recorder is fire-and-forget — poll briefly for the line to land.
    const historyPath = `${home}/.clauge/usage-history.jsonl`;
    let raw = null;
    for (let i = 0; i < 20; i++) {
      try {
        raw = await readFile(historyPath, 'utf8');
        if (raw.trim()) break;
      } catch { /* not written yet */ }
      await sleep(100);
    }
    assert.ok(raw && raw.trim(), 'usage-history.jsonl written within 2s of ingest');

    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one sample line');
    const sample = JSON.parse(lines[0]);
    assert.equal(sample.v, 1);
    assert.match(sample.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(sample.w.fiveHour.pct, 20);
    assert.equal(sample.w.fiveHour.resetsAt, resetsFiveHour);
    assert.equal(sample.w.sevenDay.pct, 50);
    assert.equal(sample.w.sevenDay.resetsAt, resetsSevenDay);
    assert.ok(!('sevenDayOpus' in sample.w), 'null windows omitted from the line');
    assert.ok(!('extraUsage' in sample.w), 'non-window fields excluded from the allowlist');
  });

  it('GET /api/projection reflects the ingested record', async () => {
    const origin = `http://127.0.0.1:${PORT}`;
    const r = await getWithOrigin(PORT, '/api/projection', origin);
    assert.equal(r.status, 200);
    assert.equal(r.acao, origin);
    const body = r.body;
    assert.equal(body.freshness.ingested, true);
    assert.equal(body.freshness.stale, false, 'ingested seconds ago -> not stale');
    assert.match(body.freshness.ingestedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.windows.sevenDay.pct, 50, 'pct passthrough from the ingested record');
    assert.ok(
      ['will_hit', 'safe'].includes(body.windows.sevenDay.state),
      `forecastable state for a mid-window fresh sample, got ${body.windows.sevenDay.state}`
    );
    assert.equal(body.windows.claudeDesign, null, 'never-ingested bucket stays null (phantom-bucket lesson)');
    // Sandbox HOME has no ~/.claude sessions -> trailing spend 0 -> null.
    assert.equal(body.roiPace, null);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails for the right reason.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/server-projection.test.js
```

Expected: the route doesn't exist, so Hono falls through to `serveStatic` and returns 404; the recorder doesn't exist, so the history file never appears:

```
✖ reflects the loopback Origin ...                AssertionError ... 404 !== 200
✔ denies a foreign website origin (no ACAO echo)   (passes vacuously — 404 has no ACAO)
✖ returns never-ingested freshness ...             AssertionError ... 404 !== 200
✖ creates a usage-history.jsonl line ...           AssertionError: usage-history.jsonl written within 2s of ingest
✖ GET /api/projection reflects the ingested ...    AssertionError ... 404 !== 200
# pass 1
# fail 4
```

- [ ] **Step 3: Wire `server.js` — five surgical edits.**

**Edit 3a — imports.** Extend the import added in Task 3 (after `import { buildSnapshot } from './lib/snapshot.js';`). Old:

```js
import { buildSnapshot } from './lib/snapshot.js';
import { ConfigStore } from './lib/config-store.js';
```

New:

```js
import { buildSnapshot } from './lib/snapshot.js';
import { ConfigStore } from './lib/config-store.js';
import { UsageHistory } from './lib/usage-history.js';
import { buildProjection, WINDOW_MS } from './lib/projection.js';
```

**Edit 3b — instantiate the recorder next to the UsageStore (server.js:84–86 pre-Task-3).** Old:

```js
const store = new SessionStore({ claudeDir: CLAUDE_DIR, priceTable, envFallback });
const usageStore = new UsageStore();
await usageStore.load();
```

New:

```js
const store = new SessionStore({ claudeDir: CLAUDE_DIR, priceTable, envFallback });
const usageStore = new UsageStore();
await usageStore.load();
const usageHistory = new UsageHistory({
  filePath: join(homedir(), '.clauge', 'usage-history.jsonl'),
});
// Startup prune (90-day retention, projection spec Component 2).
// Fire-and-forget: a prune failure must never block server boot;
// UsageHistory tolerates corrupt/missing files internally.
usageHistory.prune(Date.now()).catch((err) => {
  console.warn(`[Clauge] usage-history prune failed: ${err?.message ?? err}`);
});
```

**Edit 3c — CORS allowlist membership (server.js:175–177 pre-Task-3).** Without this the popover/dashboard cross-origin fetch is silently CORS-denied. Old:

```js
  '/api/export',
  '/api/activity',
];
```

New:

```js
  '/api/export',
  '/api/activity',
  '/api/projection',
];
```

**Edit 3d — ingest hook (server.js:610–614 pre-Task-3, inside `app.post('/api/usage/ingest', ...)`, immediately AFTER the awaited `usageStore.save` and before the response).** Old:

```js
    rawOverageSpendLimit: body.overageSpendLimit ?? null,
    normalized,
  });
  return c.json({
    ok: true,
```

New:

```js
    rawOverageSpendLimit: body.overageSpendLimit ?? null,
    normalized,
  });
  // Projection spec Component 2: record a downsampled history sample,
  // fire-and-forget — a recorder failure must never fail an ingest.
  // UsageHistory.record never rejects by contract; the .catch is
  // belt-and-braces against unhandled-rejection if that ever drifts.
  // Guarded on normalized: normalizeUsage returns null for non-object
  // usage payloads, and a null record has no windows to sample.
  if (normalized) {
    usageHistory.record(normalized, record.ingestedAt).catch(() => {});
  }
  return c.json({
    ok: true,
```

**Edit 3e — the endpoint.** Insert after the closing `});` of `app.get('/api/roi', ...)` (server.js:536 pre-Task-3) and before the `// Phase ②b: one compact, curated analytics snapshot...` comment (server.js:538):

```js
// On-device projection (active-guardrail sub-project A). ALL math lives in
// lib/projection.js (pure, clock-injected); this handler only wires the
// stores to the pure module and stamps generatedAt. nowMs is injected HERE
// — Date.now() is allowed in server.js, never in lib/ (house rule).
app.get('/api/projection', async (c) => {
  const nowMs = Date.now();
  const record = await usageStore.load();
  // Per-window history, keyed by the same resolved window keys WINDOW_MS
  // enumerates (fiveHour, sevenDay, sevenDaySonnet, sevenDayOpus,
  // claudeDesign, dailyRoutines). samplesFor returns oldest-first.
  const history = {};
  for (const key of Object.keys(WINDOW_MS)) {
    history[key] = await usageHistory.samplesFor(key);
  }
  // ROI pace input: the SAME trailing-7d session filter /api/roi uses
  // (filterSessions period '7d' over loadAllSummaries + sumSessionCosts —
  // the established per-token cost pipeline, data contract #4).
  const all = await store.loadAllSummaries();
  const trailing = filterSessions(all, { period: '7d', project: '', now: new Date(nowMs) });
  const apiEquivalentSpendTrailing = sumSessionCosts(trailing);
  const result = buildProjection({
    normalized: record?.normalized ?? null,
    ingestedAt: record?.ingestedAt ?? null,
    history,
    nowMs,
    apiEquivalentSpendTrailing,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
  });
  return c.json({ generatedAt: new Date(nowMs).toISOString(), ...result });
});
```

(`filterSessions` is already imported at server.js:29; `sumSessionCosts` at server.js:38.)

- [ ] **Step 4: Run the projection test and verify it passes.**

```bash
cd /Users/adnanrashid/Projects/clauge && node --test test/server-projection.test.js
```

Expected:

```
# tests 5
# pass 5
# fail 0
```

- [ ] **Step 5: Run the full JS suite (the ingest hook touches a hot path — `server-additions`, `cors-allowlist`, and the SWR suites must stay green).**

```bash
cd /Users/adnanrashid/Projects/clauge && npm test
```

Expected: `# fail 0` across all suites. Before raising the PR, also run the canonical gate exactly as CI does:

```bash
cd /Users/adnanrashid/Projects/clauge && npm run check
```

Expected: validators OK, cargo fmt/clippy/test clean, `npm test` green.

- [ ] **Step 6: Commit.**

```bash
cd /Users/adnanrashid/Projects/clauge && git add server.js test/server-projection.test.js && git commit -m "feat(server): GET /api/projection endpoint + fire-and-forget usage-history ingest hook"
```

- [ ] **Step 7: Lazy 24-hour re-prune (spec Component 2: "prune on startup and lazily at most once per 24 h")**

The startup prune (Step 3) covers restarts, but the sidecar can run for weeks. Add a module-level prune clock next to the `usageHistory` instantiation in `server.js` (directly under the startup-prune block added in Step 3):

```js
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastPruneAtMs = Date.now();
```

Then extend the ingest hook (the `usageHistory.record(...)` line added in Step 3 inside `POST /api/usage/ingest`) to:

```js
    usageHistory.record(normalized, record.ingestedAt).catch(() => {});
    if (Date.now() - lastPruneAtMs > PRUNE_INTERVAL_MS) {
      lastPruneAtMs = Date.now();
      usageHistory.prune(Date.now()).catch((err) => {
        console.warn(`[Clauge] usage-history prune failed: ${err?.message ?? err}`);
      });
    }
```

Fire-and-forget like the record call: a prune failure must never fail an ingest. No new test — `prune()` itself is covered by `test/usage-history.test.js` (Task 2), and the 24 h gate is a two-line clock check exercised implicitly by the ingest-hook test (it must NOT fire on a fresh process, since `lastPruneAtMs` starts at boot time).

Run: `node --test test/server-projection.test.js`
Expected: PASS (unchanged behavior on fresh process)

```bash
git add server.js
git commit -m "feat(projection): lazy 24h usage-history re-prune in the ingest hook"
```
### Task 5: Popover forecast + week-over-week lines (PR 3, branch `feat/projection-display`)

**Files:**
- Create: `test/popover-projection-copy.test.js` (copy + markup contract test; lives directly in `test/` — landmine #14, npm-test glob is `test/*.test.js test/cli/*.test.js`)
- Modify: `popover/copy.json` (insert a `projection` section after the `weekly` section, currently lines 27–31)
- Modify: `popover/index.html` (the two `.gauge-meta-stack` blocks, lines 47–51 and 58–62)
- Modify: `popover/popover.css` (after `.gauge-meta-clock:empty { display: none; }`, line 302)
- Modify: `popover/popover.js` (state block line 13–14; new mapping/render functions after `fmtResetClock`, line 119; `refresh()` Promise.all lines 696–703; pick/render block lines 707–716)
- Test: `node --test test/popover-projection-copy.test.js`, `node scripts/validate-copy-registry.cjs`, `npm test`

- [ ] **Step 1: Write the failing contract test.** Create `test/popover-projection-copy.test.js` with exactly:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract test for the popover projection display (sub-project A, PR 3).
// popover.js is a classic browser script with no vm seam (only
// popover/lib/swr.js has one — test/popover-swr.test.js), so the render
// logic itself is covered by the projection fixtures + manual smoke. What
// CAN be locked down headlessly is the display contract: the copy registry
// templates (exact strings, exact {param} names the t() calls rely on) and
// the hero-gauge mount points the renderer writes into.

const ROOT = join(import.meta.dirname, '..');
const copy = JSON.parse(readFileSync(join(ROOT, 'popover', 'copy.json'), 'utf8'));
const indexHtml = readFileSync(join(ROOT, 'popover', 'index.html'), 'utf8');

test('copy.json defines the four projection strings with exact templates', () => {
  assert.deepEqual(copy.projection, {
    willHit: 'At this pace → 100% ~{time}',
    safe: 'On pace to end at ~{pct}%',
    exhausted: 'Limit reached — resets {time}',
    wow: '{delta} pts vs last week',
  });
});

test('popover index.html mounts the forecast lines under both hero gauges', () => {
  for (const id of ['session-forecast', 'weekly-forecast', 'weekly-wow']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `missing #${id} in popover/index.html`);
  }
});
```

- [ ] **Step 2: Run the test and verify it FAILS.** Run:

```bash
node --test test/popover-projection-copy.test.js
```

Expected: `# fail 2` — the first test fails with `AssertionError` (`copy.projection` is `undefined`), the second with `missing #session-forecast in popover/index.html`.

- [ ] **Step 3: Add the copy keys.** In `popover/copy.json`, replace:

```json
  "weekly": {
    "label": "Weekly",
    "dayOf7": "Day {day} of 7",
    "dayUnknown": "Day — of 7"
  },
```

with:

```json
  "weekly": {
    "label": "Weekly",
    "dayOf7": "Day {day} of 7",
    "dayUnknown": "Day — of 7"
  },
  "projection": {
    "willHit": "At this pace → 100% ~{time}",
    "safe": "On pace to end at ~{pct}%",
    "exhausted": "Limit reached — resets {time}",
    "wow": "{delta} pts vs last week"
  },
```

- [ ] **Step 4: Add the mount points.** In `popover/index.html`, replace the Session meta stack (lines 47–51):

```html
        <div class="gauge-meta-stack">
          <span class="mono" id="session-elapsed">— of 5h</span>
          <span class="mono gauge-meta-sub" id="session-reset">resets in —</span>
          <span class="mono gauge-meta-clock" id="session-reset-clock"></span>
        </div>
```

with:

```html
        <div class="gauge-meta-stack">
          <span class="mono" id="session-elapsed">— of 5h</span>
          <span class="mono gauge-meta-sub" id="session-reset">resets in —</span>
          <span class="mono gauge-meta-clock" id="session-reset-clock"></span>
          <div class="mono gauge-forecast" id="session-forecast"></div>
        </div>
```

and the Weekly meta stack (lines 58–62):

```html
        <div class="gauge-meta-stack">
          <span class="mono" id="weekly-elapsed">Day — of 7</span>
          <span class="mono gauge-meta-sub" id="weekly-reset">resets in —</span>
          <span class="mono gauge-meta-clock" id="weekly-reset-clock"></span>
        </div>
```

with:

```html
        <div class="gauge-meta-stack">
          <span class="mono" id="weekly-elapsed">Day — of 7</span>
          <span class="mono gauge-meta-sub" id="weekly-reset">resets in —</span>
          <span class="mono gauge-meta-clock" id="weekly-reset-clock"></span>
          <div class="mono gauge-forecast" id="weekly-forecast"></div>
          <div class="mono gauge-wow" id="weekly-wow"></div>
        </div>
```

(No script-tag changes: `popover/index.html` already loads `lib/copy.js` (line 213) and `lib/swr.js` (line 214) before `popover.js` (line 217), so the `t()` and `ClaugeSwr` facades are defined — landmine #20 satisfied with zero edits.)

- [ ] **Step 5: Run the contract test and verify it PASSES.** Run:

```bash
node --test test/popover-projection-copy.test.js
```

Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 6: Style the new lines.** In `popover/popover.css`, replace:

```css
.gauge-meta-clock:empty { display: none; }
```

with:

```css
.gauge-meta-clock:empty { display: none; }

/* Forecast + week-over-week lines under the hero gauges (on-device
 * projection, sub-project A). Keyed by /api/projection state; empty text =
 * hidden (warming_up / stale / unavailable suppress the line — a forecast
 * from thin or stale data is suppressed, never caveated). */
.gauge-meta-stack .gauge-forecast {
  color: var(--brand);
  font-size: 9.5px;
}
.gauge-meta-stack .gauge-wow {
  color: var(--text-3);
  font-size: 9.5px;
}
.gauge-forecast:empty,
.gauge-wow:empty { display: none; }
```

- [ ] **Step 7: Add the keep-last-good cache slot.** In `popover/popover.js`, replace (lines 13–14):

```js
let lastGoodUsage = null;       // SWR keep-last-good cache for /api/usage
let refreshInFlight = false;    // overlap guard: skip a tick if a refresh is still running
```

with:

```js
let lastGoodUsage = null;       // SWR keep-last-good cache for /api/usage
let lastGoodProjection = null;  // SWR keep-last-good cache for /api/projection (own cache; pickUsage is payload-agnostic)
let refreshInFlight = false;    // overlap guard: skip a tick if a refresh is still running
```

- [ ] **Step 8: Add the state→copy mapping + render functions.** In `popover/popover.js`, replace the end of `fmtResetClock` (lines 117–119):

```js
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
```

with:

```js
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/**
 * Map one /api/projection window to a forecast copy line.
 * Returns { key, params } for will_hit / safe / exhausted, or null when the
 * line must be hidden (warming_up / stale / unavailable / missing window).
 * Times reuse fmtResetClock so the forecast clock matches the reset captions
 * (local short time, weekday prefix when the moment is not today).
 */
function projectionLineCopy(win, nowMs = Date.now()) {
  if (!win || typeof win !== 'object') return null;
  switch (win.state) {
    case 'will_hit':
      return { key: 'projection.willHit', params: { time: fmtResetClock(win.etaAt, nowMs) } };
    case 'safe':
      return Number.isFinite(win.projectedEndPct)
        ? { key: 'projection.safe', params: { pct: win.projectedEndPct } }
        : null;
    case 'exhausted':
      return { key: 'projection.exhausted', params: { time: fmtResetClock(win.resetsAt, nowMs) } };
    default:
      return null; // warming_up | stale | unavailable — line hidden
  }
}

/**
 * "+15" / "-3" sign formatting for the week-over-week delta. Returns null
 * (line hidden) when weekOverWeek is absent — the server already gates it to
 * will_hit/safe states, so absence covers stale/warming_up/exhausted too.
 */
function wowLineCopy(weekOverWeek) {
  if (!weekOverWeek || !Number.isFinite(weekOverWeek.deltaPts)) return null;
  const d = weekOverWeek.deltaPts;
  return { key: 'projection.wow', params: { delta: d > 0 ? `+${d}` : String(d) } };
}

function renderForecastLine(elId, copy) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = copy ? t(copy.key, copy.params) : '';
}

// Render the hero-pair forecast lines from /api/projection. Only fiveHour +
// sevenDay are displayed in sub-project A; null projection (cold-start fetch
// failure with no last-good) empties all three lines (CSS :empty hides them).
function renderProjection(projection, nowMs) {
  const windows = projection?.windows ?? {};
  renderForecastLine('session-forecast', projectionLineCopy(windows.fiveHour, nowMs));
  renderForecastLine('weekly-forecast', projectionLineCopy(windows.sevenDay, nowMs));
  renderForecastLine('weekly-wow', wowLineCopy(windows.sevenDay?.weekOverWeek));
}
```

- [ ] **Step 9: Widen the batched fetch + wire the render.** In `popover/popover.js`, replace (lines 696–703):

```js
    const [health, summary, cache, usage, period30d, daily30d] = await Promise.all([
      fetchJson('/api/health').catch(() => null),
      fetchJson('/api/summary?period=today').catch(() => null),
      fetchJson('/api/cache?period=today').catch(() => null),
      fetchJson('/api/usage').catch(() => null),
      fetchJson('/api/summary?period=30d').catch(() => null),
      fetchJson('/api/daily?period=30d').catch(() => null),
    ]);
```

with:

```js
    const [health, summary, cache, usage, period30d, daily30d, projection] = await Promise.all([
      fetchJson('/api/health').catch(() => null),
      fetchJson('/api/summary?period=today').catch(() => null),
      fetchJson('/api/cache?period=today').catch(() => null),
      fetchJson('/api/usage').catch(() => null),
      fetchJson('/api/summary?period=30d').catch(() => null),
      fetchJson('/api/daily?period=30d').catch(() => null),
      fetchJson('/api/projection').catch(() => null),
    ]);
```

then replace (lines 707–716):

```js
    const picked = window.ClaugeSwr.pickUsage(usage, lastGoodUsage);
    lastGoodUsage = picked.lastGood;
    const effectiveUsage = picked.usage;
    const plan = effectiveUsage?.plan ?? {};
    const nowMs = Date.now();

    renderHeaderSubhead(effectiveUsage?.ingestedAt, healthOk, picked.fetchFailed);
    renderPlanBadge(plan);
    renderSession(plan, nowMs);
    renderWeekly(plan, nowMs);
```

with:

```js
    const picked = window.ClaugeSwr.pickUsage(usage, lastGoodUsage);
    lastGoodUsage = picked.lastGood;
    const effectiveUsage = picked.usage;
    // /api/projection gets its OWN keep-last-good cache through the same
    // generic pickUsage helper (it is payload-agnostic — null-or-not is all
    // it inspects). A failed projection fetch must not blank the lines.
    const pickedProjection = window.ClaugeSwr.pickUsage(projection, lastGoodProjection);
    lastGoodProjection = pickedProjection.lastGood;
    const plan = effectiveUsage?.plan ?? {};
    const nowMs = Date.now();

    renderHeaderSubhead(effectiveUsage?.ingestedAt, healthOk, picked.fetchFailed);
    renderPlanBadge(plan);
    renderSession(plan, nowMs);
    renderWeekly(plan, nowMs);
    renderProjection(pickedProjection.usage, nowMs);
```

(`resizeToContent()` already runs in `refresh()`'s `finally` (line 736), so the two new meta lines are measured every tick — landmine #11 watched: the 200–1200 clamp stays untouched, ~24px of new content is far inside headroom.)

- [ ] **Step 10: Run the validators + full JS suite, verify green.** Run:

```bash
node scripts/validate-copy-registry.cjs && node scripts/validate-html-facade-loads.cjs && npm test
```

Expected: `[validate-copy-registry] OK - <n> keys defined, <m> unique t() references resolve` (the four new `projection.*` t() calls resolve), the facade validator passes (no new facade usage was added), and `npm test` ends `# fail 0` (includes the new contract test plus PR 1's `test/projection.test.js` fixtures).

- [ ] **Step 11: Rebuild the served mirror BEFORE any manual look (landmine #30).** `popover/` is the source; the sidecar serves the gitignored `public/popover/` mirror, which only `npm run build:sidecar` regenerates. Run:

```bash
pkill -f clauge || true
npm run build:sidecar
node server.js
```

Then open `http://127.0.0.1:3456/popover/index.html` in a browser. Expected: with a live extension ingest, a forecast line appears under each hero gauge's reset clock (e.g. Session: "At this pace → 100% ~3:40 PM" or "On pace to end at ~62%"); Weekly additionally shows "{±n} pts vs last week" once ≥1 week of history exists (fresh installs: line absent — correct); kill the extension/ingest for >10 min and the lines disappear (stale suppression). For the native surface run the canonical cycle `pkill -f clauge && npm run build:sidecar && npm run tauri:dev` and confirm the popover bottom is not clipped (resizeToContent re-measures; clamp pair unchanged — landmine #11).

- [ ] **Step 12: Commit.**

```bash
git add test/popover-projection-copy.test.js popover/copy.json popover/index.html popover/popover.css popover/popover.js
git commit -m "feat(popover): forecast + week-over-week lines under the hero gauges from /api/projection"
```

### Task 6: Dashboard forecasts, monthly-pace line + editable subscription cost (PR 3, branch `feat/projection-display`)

**Files:**
- Create: `test/dashboard-projection-line.test.js` (vm-seam test — follows the `test/dashboard-swr.test.js` → `public/swr.js` precedent)
- Modify: `public/swr.js` (new pure helpers before the `window.ClaugeDashSwr` export, lines 51–53)
- Modify: `public/index.html` (ROI metric-strip cell lines 132–136; Settings plan-cost row lines 421–427)
- Modify: `public/styles.css` (after `.ring-reset-clock:empty`, line 1016)
- Modify: `public/app.js` (state.data lines 24–28; `bigRingHtml` lines 238–243; after the structural/surgical branch in `renderPlanCapacity` lines 343–349; new `updateRingForecasts` after `updateBigRings` line 529; `renderMetricStrip` tail line 640; `renderSettings` lines 895–897 and 928; `refreshAll` lines 1227–1246; the 60s tick lines 1373–1391)
- Test: `node --test test/dashboard-projection-line.test.js`, `npm test`, `npm run check`

No SEA manifest edits: `public/app.js`, `public/swr.js`, `public/index.html`, `public/styles.css` are all already registered in BOTH manifests (`scripts/sea-config.json` lines 11–15, `scripts/sea-bootstrap.cjs` ASSETS lines 41–43) — no NEW served file, landmine #39 dormant.

- [ ] **Step 1: Write the failing vm-seam test.** Create `test/dashboard-projection-line.test.js` with exactly:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Same vm seam as test/dashboard-swr.test.js: public/swr.js is a classic
// browser IIFE (window-only, no export/module.exports — the repo is
// "type":"module"), so evaluate the real shipped source in THIS realm with a
// local `window` and read back window.ClaugeDashSwr.
function loadDashSwr() {
  const path = join(import.meta.dirname, '..', 'public', 'swr.js');
  const src = readFileSync(path, 'utf8');
  const factory = vm.runInThisContext(
    `(function (window) {\n${src}\nreturn window.ClaugeDashSwr;\n})`,
    { filename: path },
  );
  return factory({});
}

const { projectionLine, wowLine, paceLine } = loadDashSwr();

// Clock formatter is INJECTED (house clock-injection convention) so the
// mapping stays pure; app.js passes its real fmtResetClock at the callsite.
const fmtClockStub = (iso) => `LOCAL(${iso})`;

describe('projectionLine — plan-card forecast text per /api/projection window state', () => {
  it('will_hit → "At this pace → 100% ~{local time}" via the injected clock formatter', () => {
    const line = projectionLine(
      { state: 'will_hit', etaAt: '2026-06-12T11:40:00.000Z', projectedEndPct: null },
      fmtClockStub,
    );
    assert.equal(line, 'At this pace → 100% ~LOCAL(2026-06-12T11:40:00.000Z)');
  });

  it('safe → "On pace to end at ~{pct}%"', () => {
    const line = projectionLine({ state: 'safe', etaAt: null, projectedEndPct: 84 }, fmtClockStub);
    assert.equal(line, 'On pace to end at ~84%');
  });

  it('exhausted → "Limit reached — resets {time}" from the payload resetsAt', () => {
    const line = projectionLine(
      { state: 'exhausted', resetsAt: '2026-06-12T14:20:00.800955+00:00' },
      fmtClockStub,
    );
    assert.equal(line, 'Limit reached — resets LOCAL(2026-06-12T14:20:00.800955+00:00)');
  });

  it('hides the line (null) for warming_up / stale / unavailable / missing window', () => {
    for (const state of ['warming_up', 'stale', 'unavailable']) {
      assert.equal(projectionLine({ state }, fmtClockStub), null);
    }
    assert.equal(projectionLine(null, fmtClockStub), null);
    assert.equal(projectionLine(undefined, fmtClockStub), null);
  });
});

describe('wowLine — week-over-week delta sign formatting', () => {
  it('positive delta gets an explicit plus sign', () => {
    assert.equal(wowLine({ deltaPts: 15, prevPctAtSamePoint: 44 }), '+15 pts vs last week');
  });
  it('negative delta keeps its minus sign', () => {
    assert.equal(wowLine({ deltaPts: -3, prevPctAtSamePoint: 62 }), '-3 pts vs last week');
  });
  it('null weekOverWeek (no prior-week history / gated state) hides the line', () => {
    assert.equal(wowLine(null), null);
    assert.equal(wowLine(undefined), null);
  });
});

describe('paceLine — ROI strip monthly run-rate pace', () => {
  it('renders "Monthly pace: {n}×" to one decimal', () => {
    assert.equal(paceLine({ paceMultiple: 21.2, subscriptionCost: 200 }), 'Monthly pace: 21.2×');
  });
  it('null roiPace (no trailing sessions / no valid cost) hides the line', () => {
    assert.equal(paceLine(null), null);
  });
});
```

- [ ] **Step 2: Run the test and verify it FAILS.** Run:

```bash
node --test test/dashboard-projection-line.test.js
```

Expected: every subtest fails with `TypeError: projectionLine is not a function` (and `wowLine` / `paceLine` likewise) — `window.ClaugeDashSwr` currently exports only `{ syncMeta, shouldSkipTick }` (public/swr.js:52).

- [ ] **Step 3: Implement the pure helpers.** In `public/swr.js`, replace (lines 45–54):

```js
  // Refresh overlap guard: skip this interval tick if a prior refresh is still
  // in flight, so a slow refresh can't stack on the next tick.
  function shouldSkipTick(inFlight) {
    return inFlight === true;
  }

  if (typeof window !== 'undefined') {
    window.ClaugeDashSwr = { syncMeta, shouldSkipTick };
  }
})();
```

with:

```js
  // Refresh overlap guard: skip this interval tick if a prior refresh is still
  // in flight, so a slow refresh can't stack on the next tick.
  function shouldSkipTick(inFlight) {
    return inFlight === true;
  }

  // ── On-device projection display mapping (sub-project A) ────────────────
  // Pure: one /api/projection window → the plan-card forecast line text.
  // Times are formatted by the INJECTED fmtClock (app.js passes its
  // fmtResetClock) so this stays clock-free and vm-testable. Returns null =
  // line hidden (warming_up / stale / unavailable / missing window — a
  // forecast from thin or stale data is suppressed, never caveated). The
  // dashboard is deliberately outside the popover copy registry (the
  // validator scans popover/ only), so these strings live inline here.
  function projectionLine(win, fmtClock) {
    if (!win || typeof win !== 'object') return null;
    if (win.state === 'will_hit') {
      return `At this pace → 100% ~${fmtClock(win.etaAt)}`;
    }
    if (win.state === 'safe' && Number.isFinite(win.projectedEndPct)) {
      return `On pace to end at ~${win.projectedEndPct}%`;
    }
    if (win.state === 'exhausted') {
      return `Limit reached — resets ${fmtClock(win.resetsAt)}`;
    }
    return null; // warming_up | stale | unavailable
  }

  // "+15 pts vs last week" / "-3 pts vs last week". The server already gates
  // weekOverWeek to will_hit/safe states; absence (null) hides the line.
  function wowLine(weekOverWeek) {
    if (!weekOverWeek || !Number.isFinite(weekOverWeek.deltaPts)) return null;
    const d = weekOverWeek.deltaPts;
    return `${d > 0 ? `+${d}` : String(d)} pts vs last week`;
  }

  // "Monthly pace: 21.2×" from /api/projection.roiPace. roiPace is null when
  // there are no sessions in the trailing 7 days or no valid subscription
  // cost — hide rather than render a zero-data verdict (phantom-bucket rule).
  function paceLine(roiPace) {
    if (!roiPace || !Number.isFinite(roiPace.paceMultiple)) return null;
    return `Monthly pace: ${roiPace.paceMultiple.toFixed(1)}×`;
  }

  if (typeof window !== 'undefined') {
    window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine };
  }
})();
```

- [ ] **Step 4: Run the test and verify it PASSES.** Run:

```bash
node --test test/dashboard-projection-line.test.js
```

Expected: `# pass 9`, `# fail 0`. Also run `node --test test/dashboard-swr.test.js` — still `# fail 0` (the existing export names are unchanged).

- [ ] **Step 5: Add the markup.** In `public/index.html`, replace the ROI metric-strip cell (lines 132–136):

```html
    <div class="ms-cell">
      <div class="ms-lbl">Return on plan <span class="chip">approx</span></div>
      <div class="ms-val ok" id="ms-roi">—</div>
      <div class="ms-sub" id="ms-roi-sub">—</div>
    </div>
```

with:

```html
    <div class="ms-cell">
      <div class="ms-lbl">Return on plan <span class="chip">approx</span></div>
      <div class="ms-val ok" id="ms-roi">—</div>
      <div class="ms-sub" id="ms-roi-sub">—</div>
      <div class="ms-sub" id="ms-pace" hidden></div>
    </div>
```

and replace the Settings plan-cost row (lines 421–427):

```html
          <div class="set-row">
            <div>
              <div class="set-label">Your Claude plan cost (monthly)</div>
              <div class="set-help">What you already pay Anthropic for your Claude plan — used only to estimate how much the same usage would cost on the pay-as-you-go API. Clauge never sells plans or processes payments.</div>
            </div>
            <input class="input" id="set-sub-cost" value="$200.00" readonly />
          </div>
```

with:

```html
          <div class="set-row">
            <div>
              <div class="set-label">Your Claude plan cost (monthly)</div>
              <div class="set-help">What you already pay Anthropic for your Claude plan — used only to estimate how much the same usage would cost on the pay-as-you-go API. Clauge never sells plans or processes payments.</div>
              <div class="set-help mono" id="set-sub-cost-status"></div>
            </div>
            <input class="input" id="set-sub-cost" type="number" min="1" step="1" value="200" />
          </div>
```

(`#set-sub-cost-status` reuses the exact transient-feedback shape Settings already uses for `#set-updates-status` at index.html:398 — a `set-help mono` element whose textContent is set then cleared.)

- [ ] **Step 6: Style the ring forecast lines.** In `public/styles.css`, replace:

```css
.ring-reset-clock:empty { display: none; }
```

with:

```css
.ring-reset-clock:empty { display: none; }
/* On-device projection forecast + week-over-week sub-labels (sub-project A).
 * Present (empty) in EVERY ring card so the DOM shape never changes across
 * 60s ticks (landmine #22); only Session/Weekly ever receive text. */
.ring-forecast {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--brand);
  margin-top: 2px;
}
.ring-wow {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 1px;
}
.ring-forecast:empty,
.ring-wow:empty { display: none; }
```

- [ ] **Step 7: Wire `public/app.js` — state slot, structural divs, surgical fill.** Three edits.

(7a) In the `state` block, replace (lines 24–28):

```js
    usage: null,
    expensive: null,
    health: null,
    roi: null,
    heatmap: null,
```

with:

```js
    usage: null,
    expensive: null,
    health: null,
    roi: null,
    projection: null,
    heatmap: null,
```

(7b) In `bigRingHtml`, replace (lines 238–243):

```js
      <div class="ring-meta">
        <div class="ring-label">${escapeHtml(label)} <span class="ring-window">${escapeHtml(sub)}</span></div>
        <div class="ring-reset">resets in ${escapeHtml(reset)}</div>
        <div class="ring-reset-clock">${escapeHtml(fmtResetClock(metric?.resetsAt))}</div>
      </div>
    </div>`;
```

with:

```js
      <div class="ring-meta">
        <div class="ring-label">${escapeHtml(label)} <span class="ring-window">${escapeHtml(sub)}</span></div>
        <div class="ring-reset">resets in ${escapeHtml(reset)}</div>
        <div class="ring-reset-clock">${escapeHtml(fmtResetClock(metric?.resetsAt))}</div>
        <div class="ring-forecast" data-role="forecast"></div>
        <div class="ring-wow" data-role="wow"></div>
      </div>
    </div>`;
```

(Built EMPTY on purpose: the structural phase keeps an identical card shape on every build; only the surgical phase writes text — landmine #22, the v0.9.9 flicker lesson.)

(7c) In `renderPlanCapacity`, replace (lines 343–349):

```js
  const shapeChanged = __planGaugeShape !== gauges.length;
  if (__planCardMode !== 'ingested' || shapeChanged) {
    body.innerHTML = gauges.map((g, i) => bigRingHtml({ ...g, gradId: `dash-rg-${i}` })).join('');
    __planCardMode = 'ingested';
  } else {
    updateBigRings(body, gauges);
  }
```

with:

```js
  const shapeChanged = __planGaugeShape !== gauges.length;
  if (__planCardMode !== 'ingested' || shapeChanged) {
    body.innerHTML = gauges.map((g, i) => bigRingHtml({ ...g, gradId: `dash-rg-${i}` })).join('');
    __planCardMode = 'ingested';
  } else {
    updateBigRings(body, gauges);
  }
  // Forecast sub-labels ride both paths: a structural rebuild leaves them
  // empty, then this surgical fill writes the leaf text (landmine #22).
  updateRingForecasts(body);
```

then add the new function immediately after `updateBigRings`'s closing brace (line 529):

```js
// Surgical fill for the plan-card forecast lines (on-device projection,
// sub-project A). Leaf Text.data writes only via setTextIfChanged — never
// innerHTML on the auto-refresh path (landmine #22). Card order is fixed by
// the gauges array in renderPlanCapacity: [0]=Session→fiveHour,
// [1]=Weekly all→sevenDay. Sonnet/Design forecast divs stay empty in
// sub-project A (the UI displays only the hero pair).
function updateRingForecasts(body) {
  const cards = body.querySelectorAll('.ring-card');
  if (cards.length < 2) return;
  const windows = state.data.projection?.windows ?? {};
  const sessionLine = window.ClaugeDashSwr.projectionLine(windows.fiveHour, fmtResetClock);
  const weeklyLine = window.ClaugeDashSwr.projectionLine(windows.sevenDay, fmtResetClock);
  const weeklyWow = window.ClaugeDashSwr.wowLine(windows.sevenDay?.weekOverWeek);
  setTextIfChanged(cards[0].querySelector('[data-role="forecast"]'), sessionLine ?? '');
  setTextIfChanged(cards[1].querySelector('[data-role="forecast"]'), weeklyLine ?? '');
  setTextIfChanged(cards[1].querySelector('[data-role="wow"]'), weeklyWow ?? '');
}
```

- [ ] **Step 8: Wire `public/app.js` — pace line, fetch widening, tick.** Three edits.

(8a) In `renderMetricStrip`, replace the tail (lines 627–641):

```js
  if (
    roi &&
    Number.isFinite(roi.apiReplacementValue) &&
    Number.isFinite(roi.subscriptionCost) &&
    roi.subscriptionCost > 0
  ) {
    document.getElementById('ms-roi').textContent = `${Math.round(roi.roiPct)}%`;
    const mult = roi.apiReplacementValue / roi.subscriptionCost;
    document.getElementById('ms-roi-sub').textContent =
      `${mult.toFixed(1)}× · ${fmtUSD(roi.apiReplacementValue)} net value`;
  } else {
    document.getElementById('ms-roi').textContent = '—';
    document.getElementById('ms-roi-sub').textContent = '—';
  }
}
```

with:

```js
  if (
    roi &&
    Number.isFinite(roi.apiReplacementValue) &&
    Number.isFinite(roi.subscriptionCost) &&
    roi.subscriptionCost > 0
  ) {
    document.getElementById('ms-roi').textContent = `${Math.round(roi.roiPct)}%`;
    const mult = roi.apiReplacementValue / roi.subscriptionCost;
    document.getElementById('ms-roi-sub').textContent =
      `${mult.toFixed(1)}× · ${fmtUSD(roi.apiReplacementValue)} net value`;
  } else {
    document.getElementById('ms-roi').textContent = '—';
    document.getElementById('ms-roi-sub').textContent = '—';
  }
  updatePaceLine();
}

// Monthly run-rate pace from /api/projection.roiPace ("Monthly pace: 21.2×").
// Shared by renderMetricStrip (load / user-action path) and the 60s tick
// (auto-refresh path) — leaf Text.data write via setTextIfChanged, plus a
// hidden toggle so a null roiPace shows NOTHING (landmine #22 + the
// phantom-bucket rule: hide, don't render a zero-data verdict).
function updatePaceLine() {
  const el = document.getElementById('ms-pace');
  if (!el) return;
  const line = window.ClaugeDashSwr.paceLine(state.data.projection?.roiPace);
  if (el.hidden !== (line == null)) el.hidden = line == null;
  setTextIfChanged(el, line ?? '');
}
```

(8b) In `refreshAll`, replace (lines 1227–1246):

```js
    const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi] =
      await Promise.all([
        api('/api/health'),
        api('/api/summary', commonParams()),
        api('/api/cache', commonParams()),
        api('/api/sessions', commonParams()),
        api('/api/daily', commonParams()),
        // peak-hours panel always shows today's hour distribution; the
        // cost-over-time chart re-uses /api/hours when state.period === 'today'.
        api('/api/hours', commonParams()),
        api('/api/projects', commonParams()),
        api('/api/tasks', commonParams()),
        api('/api/tools', commonParams()),
        api('/api/models', commonParams()),
        api('/api/usage'),
        api('/api/sessions/expensive', { ...commonParams(), limit: 5 }),
        api('/api/roi', commonParams()),
      ]);

    state.data = { health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi };
```

with:

```js
    const [health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi, projection] =
      await Promise.all([
        api('/api/health'),
        api('/api/summary', commonParams()),
        api('/api/cache', commonParams()),
        api('/api/sessions', commonParams()),
        api('/api/daily', commonParams()),
        // peak-hours panel always shows today's hour distribution; the
        // cost-over-time chart re-uses /api/hours when state.period === 'today'.
        api('/api/hours', commonParams()),
        api('/api/projects', commonParams()),
        api('/api/tasks', commonParams()),
        api('/api/tools', commonParams()),
        api('/api/models', commonParams()),
        api('/api/usage'),
        api('/api/sessions/expensive', { ...commonParams(), limit: 5 }),
        api('/api/roi', commonParams()),
        // Best-effort + keep-last-good: a projection failure must not fail
        // the whole refresh (the other 13 are all-or-nothing by design).
        api('/api/projection').catch(() => null),
      ]);

    state.data = {
      health, summary, cache, sessions, daily, hours, projects, activity, tools, models, usage, expensive, roi,
      projection: projection ?? state.data.projection,
    };
```

(8c) Replace the 60s tick (lines 1373–1391):

```js
let __autoRefreshInFlight = false;
setInterval(async () => {
  if (window.ClaugeDashSwr.shouldSkipTick(__autoRefreshInFlight)) return;
  __autoRefreshInFlight = true;
  try {
    state.data.usage = await api('/api/usage');
    __lastSuccessAt = Date.now();
    __lastRefreshFailed = false;
    renderPlanCapacity();
    renderFinanceSide();
    if (state.tab === 'settings') renderSettings();
  } catch (err) {
    console.error('plan auto-refresh', err);
    __lastRefreshFailed = true;
    renderPlanCapacity();
  } finally {
    __autoRefreshInFlight = false;
  }
}, 60_000);
```

with:

```js
let __autoRefreshInFlight = false;
setInterval(async () => {
  if (window.ClaugeDashSwr.shouldSkipTick(__autoRefreshInFlight)) return;
  __autoRefreshInFlight = true;
  try {
    // /api/projection is best-effort with keep-last-good: a failed projection
    // fetch returns null and state.data.projection keeps its previous value —
    // the same implicit pattern the catch-block gives /api/usage (the throw
    // happens before assignment, so the old usage survives a failed tick).
    const [usage, projection] = await Promise.all([
      api('/api/usage'),
      api('/api/projection').catch(() => null),
    ]);
    state.data.usage = usage;
    if (projection) state.data.projection = projection;
    __lastSuccessAt = Date.now();
    __lastRefreshFailed = false;
    renderPlanCapacity();
    renderFinanceSide();
    updatePaceLine();
    if (state.tab === 'settings') renderSettings();
  } catch (err) {
    console.error('plan auto-refresh', err);
    __lastRefreshFailed = true;
    renderPlanCapacity();
  } finally {
    __autoRefreshInFlight = false;
  }
}, 60_000);
```

- [ ] **Step 9: Wire `public/app.js` — editable subscription cost in Settings.** Two edits.

(9a) In `renderSettings`, replace (lines 895–897):

```js
    if (health.subscriptionCost != null) {
      document.getElementById('set-sub-cost').value = `$${Number(health.subscriptionCost).toFixed(2)}`;
    }
```

with:

```js
    if (health.subscriptionCost != null) {
      const subCostEl = document.getElementById('set-sub-cost');
      // type="number" input now — plain numeric value, no "$" prefix. Skip
      // the write while the field has focus: renderSettings re-runs on every
      // 60s tick when the Settings tab is open (the tick at the bottom of
      // this file), and a mid-typing clobber would eat the user's input.
      if (subCostEl && document.activeElement !== subCostEl) {
        subCostEl.value = String(Number(health.subscriptionCost));
      }
    }
```

and replace the end of `renderSettings` (line 928):

```js
  initSettingsGeneralControls();
}
```

with:

```js
  initSubCostControl();
  initSettingsGeneralControls();
}

// On-device projection Component 4: the subscription-cost field is editable.
// change → POST /api/config/subscription-cost (persisted sidecar-side in
// ~/.clauge/config.json); on success re-fetch /api/roi + /api/projection and
// re-render the metric strip. This is the USER-ACTION path, not the 60s
// auto-refresh path, so a structural renderMetricStrip() re-render is fine.
// Plain fetch (no ClaugeBridge): the dashboard is served by the sidecar
// itself, so the POST is same-origin and must work in browser mode too.
let __subCostInitialized = false;
const SUB_COST_STATUS_CLEAR_MS = 4000;
function initSubCostControl() {
  if (__subCostInitialized) return;
  const input = document.getElementById('set-sub-cost');
  const status = document.getElementById('set-sub-cost-status');
  if (!input) return;
  __subCostInitialized = true;
  let statusTimer = null;
  const showStatus = (text) => {
    if (!status) return;
    status.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, SUB_COST_STATUS_CLEAR_MS);
  };
  input.addEventListener('change', async () => {
    const n = Number(input.value);
    if (!Number.isFinite(n) || n <= 0) {
      showStatus('Enter a number above 0');
      return;
    }
    try {
      const res = await fetch('/api/config/subscription-cost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionCost: n }),
      });
      if (!res.ok) throw new Error(`POST /api/config/subscription-cost → ${res.status}`);
      // Re-fetch the two strip consumers so the new cost shows now, not at
      // the next manual refresh. Each is best-effort keep-last-good.
      const [roi, projection] = await Promise.all([
        api('/api/roi', commonParams()).catch(() => null),
        api('/api/projection').catch(() => null),
      ]);
      if (roi) state.data.roi = roi;
      if (projection) state.data.projection = projection;
      renderMetricStrip();
      showStatus('Saved');
    } catch (err) {
      console.error('subscription-cost save failed:', err);
      showStatus('Save failed — value not stored');
    }
  });
}
```

- [ ] **Step 10: Run the full gate, verify green.** Run:

```bash
npm run check
```

Expected: all five validators OK (no new console.log; no copy-registry change — the dashboard is outside the registry by design; facade validator unaffected), `cargo fmt`/`clippy`/Rust tests untouched-green, and `npm test` ends `# fail 0` including `test/dashboard-projection-line.test.js`, `test/dashboard-swr.test.js`, and PR 1/2's projection + endpoint suites.

- [ ] **Step 11: Manual smoke (Mac) + Windows pass note.** Browser smoke first (dashboard files are served from disk `public/` by the standalone server — no rebuild needed for these edits):

```bash
node server.js
```

Open `http://127.0.0.1:3456/` and verify: (1) Session + Weekly rings show the forecast sub-label (and Weekly the wow line when ≥1 week of history exists; Sonnet/Design rings show nothing); (2) the ROI cell shows "Monthly pace: {n}×" (hidden if no sessions in the trailing 7 days); (3) Settings → Plan & ROI: edit the cost field to `100`, blur → "Saved" appears, the strip's `$100.00/mo` and pace line update; enter `0` → "Enter a number above 0", nothing POSTed; verify the 400 path with `curl -s -X POST http://127.0.0.1:3456/api/config/subscription-cost -H 'Content-Type: application/json' -d '{"subscriptionCost":-5}'` → HTTP 400. (4) Flicker check (landmine #22): leave the Overview open ≥2 ticks (2+ min) — no visible snap on the `.dot-live` pulse and the forecast text updates in place. Then the native pass:

```bash
pkill -f clauge || true
npm run build:sidecar
npm run tauri:dev
```

(`npm run build:sidecar` re-embeds `public/` into the SEA binary — without it the native app serves the OLD app.js; landmine #18b/#30.) Finally, note for the release checklist: the **Windows smoke pass** from the spec (dashboard is the only Windows surface — forecast lines, pace line, editable cost) runs pre-tag per `docs/RELEASE_CHECKLIST.md`; record it there, it is not a blocker for this PR's merge.

- [ ] **Step 12: Commit.**

```bash
git add test/dashboard-projection-line.test.js public/swr.js public/index.html public/styles.css public/app.js
git commit -m "feat(dashboard): ring forecasts, monthly-pace line + editable subscription cost from /api/projection"
```

---

## Final verification (after PR 3 merges)

- [ ] **Full gate on main:** `npm run build:sidecar && npm run check` → all validators + cargo fmt/clippy/test + npm test PASS.
- [ ] **SEA smoke:** `npm run test:sea` → packaged sidecar serves all assets (no new served files expected — this proves it).
- [ ] **Manual smoke (Mac):** `npm run build:sidecar`, launch the app: popover shows forecast lines under both hero gauges (and wow line once ≥1 week of history exists); dashboard plan card + ROI strip show forecast/pace lines; Settings cost field edits persist across an app restart (`cat ~/.clauge/config.json`); `~/.clauge/usage-history.jsonl` grows ≤1 line/5 min.
- [ ] **Staleness smoke:** disable the Clauge Sync extension for >10 min → forecast lines disappear (stale gate); re-enable → they return.
- [ ] **Windows smoke pass** (spec requirement; dashboard only — popover is Mac-only): dashboard forecast + pace lines render; Settings cost field works.
- [ ] **No release/tag in this plan** — sub-project A accumulates on main; Adnan decides the release point (likely after sub-project B).
