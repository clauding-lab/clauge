# Desktop Alerts + Tray (Sub-Project B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clauge warns you with OS notifications — even with no window open — when you approach a limit (80/95%), are on pace to run out before reset, or hit the limit; configurable per-type in the dashboard, with a macOS menu-bar warning cue + quick toggle.

**Architecture:** The always-on sidecar decides which alerts are due (`lib/alert-engine.js`, reusing sub-project A's projection) against persisted fired-state (`lib/alert-state.js`); a new always-on cross-platform Rust 30s poller (`src-tauri/src/alerts.rs`) GETs `/api/alerts/pending`, fires each via the already-present `tauri-plugin-notification`, and POSTs `/api/alerts/ack`. Alert prefs live in the sidecar-owned `~/.clauge/config.json` (config-store read-merge-write refactor). No new dependency.

**Tech Stack:** Node sidecar (Hono, ESM, node:test), Rust/Tauri 2 (`tauri-plugin-notification`, already a dep), vanilla-JS dashboard.

**Spec:** `docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md` (authoritative; adversarially reviewed — forward-looking severity-collapse + stale-exempt limitReached).

---

## PR / branch structure

| PR | Branch | Tasks | Contents |
|---|---|---|---|
| 1 | `feat/alerts-engine` | 1–2 | `lib/alert-engine.js` (pure) + `lib/alert-state.js` + `configPaths.alertStateFile()` |
| 2 | `feat/alerts-wiring` | 3–5 | config-store read-merge-write + alert prefs; `/api/config/alerts` + `/api/alerts/pending` + `/api/alerts/ack`; dashboard Settings "Alerts" section |
| 3 | `feat/alerts-rust` | 6–7 | `src-tauri/src/alerts.rs` cross-platform poller/firer; macOS tray ⚠ cue + NSMenu "Alerts: On/Off" toggle |

Each PR: branch from fresh `main` after the previous merges → full `npm run check` locally (needs `npm run build:sidecar`; PR 3 also compiles Rust) → `gh pr create` → `gh pr checks --watch` (branch protection requires `check`; auto-merge NOT enabled — never merge right after create) → `gh pr merge --squash`.

**Sequencing:** PR 2 depends on PR 1 (`evaluate`, `AlertState`, `configPaths.alertStateFile()`). PR 3 depends on PR 2's endpoints (`/api/alerts/pending`, `/api/alerts/ack`, `/api/config/alerts`). Tasks within a PR are sequential.

**Key cross-task contracts (pinned):** `evaluate({usage, projection, prefs, fired, nowMs}) → {due, retire}` · `AlertState.load(nowMs) → Set<string>` (prune folded in) / `markFired(iterable)` · `effectiveAlertPrefs() → {alertsEnabled, types}` / `setAlertPrefs(partial)` · `spawn_alert_poller(app)` · `tray_warning_prefix(five, seven) → &'static str`.

---
## PR 1 — `feat/alerts-engine` (Tasks 1-2)

> Two pure ESM lib modules: the alert decision engine (Task 1) and the fired-key state store (Task 2). No I/O in the engine; the state store mirrors `lib/config-store.js`'s atomic tmp+rename + `configPaths` path resolution. House rules in force: `"type":"module"`; `nowMs` is always a parameter (never `Date.now()` inside `lib/`); no `console.log` in `lib/`; JS tests run with `node --test <file>` and live at `test/*.test.js` (landmine #14 — NOT a new directory). No new dependencies. Conventional Commits.

---

### Task 1: `lib/alert-engine.js` — pure desktop alert engine + table-driven tests

**Files**
- Create: `/Users/adnanrashid/Projects/clauge/lib/alert-engine.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/alert-engine.test.js`

**Pinned contract (do not deviate):**
- Exports: `WATCHED_WINDOWS = ["fiveHour","sevenDay"]`, `APPROACHING_LEVELS = [95, 80]` (descending), `SEVERITY` rank map (`limitReached:4`, `willHit:3`, `approaching95:2`, `approaching80:1`), `windowLabel(w)` → `"5-hour"` | `"weekly"`, and `evaluate({ usage, projection, prefs, fired, nowMs })` → `{ due: [...], retire: [...] }`.
- `usage` = normalized plan `{ fiveHour:{pct,resetsAt}, sevenDay:{pct,resetsAt}, ... }` (the `lib/usage-store.js` shape — `pct` 0..100, `resetsAt` ISO string or null).
- `projection` = `buildProjection(...)` result: reads `projection.windows[w].state` and `projection.freshness.stale`.
- `prefs` = `{ alertsEnabled: bool, types: { approaching: bool, willHit: bool, limitReached: bool } }`.
- `fired` = `Set<string>` of dedup keys already fired.
- Dedup keys: `limitReached:{w}:{resetsAt}`, `willHit:{w}:{resetsAt}`, `approaching:{w}:{level}:{resetsAt}`.
- `due` alert shape: `{ id, type, window, level?, title, body }` (`level` present only on `approaching`).
- Bodies use local time: `new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`.

**Forward-looking severity collapse + stale gate (exact):**
- Per watched window `w` with `usage[w].resetsAt` as the instance id. `resetsAt` null/absent → skip the window entirely.
- A type is a **candidate** only if its `prefs.types.*` flag is on. A disabled type is neither a firing candidate nor counted in the "below H" retire set.
- **Condition met:** `limitReached` ⟺ `pct >= 100`; `willHit` ⟺ `projection.windows[w].state === 'will_hit'`; `approaching95` ⟺ `pct >= 95`; `approaching80` ⟺ `pct >= 80`. (`limitReached` is `pct >= 100`, **load-bearing — NOT** `state === 'exhausted'`.)
- **Stale gate** (`projection.freshness.stale === true`): `willHit` and `approaching` are suppressed (not eligible). `limitReached` is EXEMPT and stays eligible **only when** `pct >= 100` AND `resetsAt > nowMs` (a stale post-reset 100 must not fire).
- **H** = the highest-severity candidate that is (condition met) AND (unfired: key not in `fired`) AND (eligible under the stale gate). If H exists: `due += H`; `retire +=` every **unfired** key of that window of severity **strictly below H** — regardless of whether its condition is currently met (forward-looking) — **excluding disabled types**. Strictly-higher keys stay armed (never retired). If no H: nothing due, nothing retired for that window.
- `prefs.alertsEnabled === false` → `{ due: [], retire: [] }` (whole-engine short-circuit).

**Steps**

- [ ] **Step 1: Write the failing test file `test/alert-engine.test.js`.**
  Build realistic `projection` inputs via `buildProjection` from `lib/projection.js` so `state`/`stale` are real, and pin one `nowMs`. Complete file:

  ```js
  // Unit tests for lib/alert-engine.js — pure desktop alert engine
  // (Component 1, docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md).
  // Clock pinned via NOW_MS; projection built through the real buildProjection
  // so window state + freshness.stale come from the actual A engine.

  import { describe, it } from 'node:test';
  import assert from 'node:assert/strict';
  import { buildProjection } from '../lib/projection.js';
  import {
    WATCHED_WINDOWS,
    APPROACHING_LEVELS,
    SEVERITY,
    windowLabel,
    evaluate,
  } from '../lib/alert-engine.js';

  // 2026-06-12T10:00:00.000Z — same clock family as projection.test.js.
  const NOW_MS = 1781258400000;

  // resetsAt strings (all FUTURE relative to NOW_MS unless noted).
  const FIVE_RESET = '2026-06-12T14:20:00+00:00'; // ~4h20m out
  const SEVEN_RESET = '2026-06-14T12:24:00+00:00'; // ~2d out
  const PAST_RESET = '2026-06-12T05:00:00+00:00'; // already reset

  const ALL_ON = {
    alertsEnabled: true,
    types: { approaching: true, willHit: true, limitReached: true },
  };

  // Build a fresh (non-stale) projection from a normalized plan. ingestedAt =
  // now keeps freshness.stale false; no history => window_avg basis, which is
  // all the engine needs (it only reads .state + .stale).
  function freshProjection(normalized) {
    return buildProjection({
      normalized,
      ingestedAt: new Date(NOW_MS).toISOString(),
      history: null,
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 0,
      subscriptionCost: 200,
    });
  }

  // Force every window stale by making the ingest old.
  function staleProjection(normalized) {
    return buildProjection({
      normalized,
      ingestedAt: '2026-06-12T09:00:00+00:00', // 60 min old > 10 min
      history: null,
      nowMs: NOW_MS,
      apiEquivalentSpendTrailing: 0,
      subscriptionCost: 200,
    });
  }

  function evalWith({ usage, prefs = ALL_ON, fired = new Set() }) {
    const projection = freshProjection(usage);
    return evaluate({ usage, projection, prefs, fired, nowMs: NOW_MS });
  }

  function ids(alerts) {
    return alerts.map((a) => a.id);
  }

  describe('exports — pinned contract', () => {
    it('WATCHED_WINDOWS is the two hero windows', () => {
      assert.deepEqual(WATCHED_WINDOWS, ['fiveHour', 'sevenDay']);
    });
    it('APPROACHING_LEVELS descending', () => {
      assert.deepEqual(APPROACHING_LEVELS, [95, 80]);
    });
    it('SEVERITY ranks', () => {
      assert.equal(SEVERITY.limitReached, 4);
      assert.equal(SEVERITY.willHit, 3);
      assert.equal(SEVERITY.approaching95, 2);
      assert.equal(SEVERITY.approaching80, 1);
    });
    it('windowLabel maps the two windows', () => {
      assert.equal(windowLabel('fiveHour'), '5-hour');
      assert.equal(windowLabel('sevenDay'), 'weekly');
    });
  });

  describe('approaching thresholds — inclusive boundaries', () => {
    it('pct exactly 80 fires approaching:80', () => {
      const usage = { fiveHour: { pct: 80, resetsAt: FIVE_RESET } };
      const { due, retire } = evalWith({ usage });
      assert.deepEqual(ids(due), [`approaching:fiveHour:80:${FIVE_RESET}`]);
      assert.equal(due[0].type, 'approaching');
      assert.equal(due[0].level, 80);
      assert.equal(due[0].window, 'fiveHour');
      assert.deepEqual(retire, []);
    });

    it('pct just under 80 fires nothing', () => {
      const usage = { fiveHour: { pct: 79.9, resetsAt: FIVE_RESET } };
      const { due, retire } = evalWith({ usage });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });

    it('pct exactly 95 fires approaching:95 and retires the unfired :80', () => {
      const usage = { fiveHour: { pct: 95, resetsAt: FIVE_RESET } };
      const { due, retire } = evalWith({ usage });
      assert.deepEqual(ids(due), [`approaching:fiveHour:95:${FIVE_RESET}`]);
      assert.equal(due[0].level, 95);
      assert.deepEqual(retire, [`approaching:fiveHour:80:${FIVE_RESET}`]);
    });
  });

  describe('limitReached — pct >= 100 (inclusive), not state===exhausted', () => {
    it('pct exactly 100 fires limitReached and retires all lower keys', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const { due, retire } = evalWith({ usage });
      assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
      assert.equal(due[0].type, 'limitReached');
      assert.deepEqual(retire.sort(), [
        `approaching:fiveHour:80:${FIVE_RESET}`,
        `approaching:fiveHour:95:${FIVE_RESET}`,
        `willHit:fiveHour:${FIVE_RESET}`,
      ].sort());
    });

    it('past-resetsAt at 100 still fires limitReached via the pct clause (projection state unavailable)', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: PAST_RESET } };
      const projection = freshProjection(usage);
      // projection.windows.fiveHour.state is 'unavailable' (resetsAt <= nowMs),
      // NOT 'exhausted' — limitReached must still fire off the pct clause.
      assert.equal(projection.windows.fiveHour.state, 'unavailable');
      const { due } = evaluate({
        usage,
        projection,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(due), [`limitReached:fiveHour:${PAST_RESET}`]);
    });
  });

  describe('willHit', () => {
    it('fires when projection state is will_hit and retires the unfired approaching keys', () => {
      // pct 90, 5h window, no history -> window_avg rate projects past 100
      // before reset => state will_hit.
      const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
      const projection = freshProjection(usage);
      assert.equal(projection.windows.fiveHour.state, 'will_hit');
      const { due, retire } = evaluate({
        usage,
        projection,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(due), [`willHit:fiveHour:${FIVE_RESET}`]);
      assert.deepEqual(retire.sort(), [
        `approaching:fiveHour:80:${FIVE_RESET}`,
        `approaching:fiveHour:95:${FIVE_RESET}`,
      ].sort());
    });
  });

  describe('dedup — key already in fired does not re-fire', () => {
    it('approaching:80 in fired -> nothing due', () => {
      const usage = { fiveHour: { pct: 82, resetsAt: FIVE_RESET } };
      const fired = new Set([`approaching:fiveHour:80:${FIVE_RESET}`]);
      const { due, retire } = evalWith({ usage, fired });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });
  });

  describe('re-arm on changed resetsAt (new window instance)', () => {
    it('the OLD resetsAt key in fired does not suppress the NEW instance', () => {
      const NEW_RESET = '2026-06-12T19:20:00+00:00';
      const usage = { fiveHour: { pct: 82, resetsAt: NEW_RESET } };
      const fired = new Set([`approaching:fiveHour:80:${FIVE_RESET}`]); // old
      const { due } = evalWith({ usage, fired });
      assert.deepEqual(ids(due), [`approaching:fiveHour:80:${NEW_RESET}`]);
    });
  });

  describe('forward-looking collapse across ticks (intra-instance)', () => {
    it('willHit fires + retires approaching keys; a later 96% tick yields due=[] while limitReached stays armed', () => {
      // Tick 1: willHit at pct 90.
      const usage1 = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
      const proj1 = freshProjection(usage1);
      const r1 = evaluate({
        usage: usage1,
        projection: proj1,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(r1.due), [`willHit:fiveHour:${FIVE_RESET}`]);

      // Persist what Rust would ack: due ids + retired ids -> fired set.
      const fired = new Set([...ids(r1.due), ...r1.retire]);

      // Tick 2: pct climbs to 96 (>=95). approaching:95 is already retired,
      // so it must NOT fire; limitReached was never retired -> stays armed
      // (condition not yet met at 96, so nothing due).
      const usage2 = { fiveHour: { pct: 96, resetsAt: FIVE_RESET } };
      const proj2 = freshProjection(usage2);
      const r2 = evaluate({
        usage: usage2,
        projection: proj2,
        prefs: ALL_ON,
        fired,
        nowMs: NOW_MS,
      });
      assert.deepEqual(r2.due, []);
      assert.deepEqual(r2.retire, []);

      // Tick 3: pct 100 -> limitReached still armed, so it fires.
      const usage3 = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const proj3 = freshProjection(usage3);
      const r3 = evaluate({
        usage: usage3,
        projection: proj3,
        prefs: ALL_ON,
        fired,
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(r3.due), [`limitReached:fiveHour:${FIVE_RESET}`]);
    });
  });

  describe('stale gate', () => {
    it('stale + pct 100 + future resetsAt -> limitReached due (+ lower retired)', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const projection = staleProjection(usage);
      assert.equal(projection.freshness.stale, true);
      const { due, retire } = evaluate({
        usage,
        projection,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
      // willHit + both approaching keys are suppressed-but-retired.
      assert.deepEqual(retire.sort(), [
        `approaching:fiveHour:80:${FIVE_RESET}`,
        `approaching:fiveHour:95:${FIVE_RESET}`,
        `willHit:fiveHour:${FIVE_RESET}`,
      ].sort());
    });

    it('stale + pct 100 + PAST resetsAt -> nothing (stale post-reset 100 is not live)', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: PAST_RESET } };
      const projection = staleProjection(usage);
      const { due, retire } = evaluate({
        usage,
        projection,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });

    it('stale suppresses willHit + approaching (pct 90, future reset, not at 100)', () => {
      const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
      const projection = staleProjection(usage);
      const { due, retire } = evaluate({
        usage,
        projection,
        prefs: ALL_ON,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });
  });

  describe('gating', () => {
    it('master off -> empty', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const prefs = {
        alertsEnabled: false,
        types: { approaching: true, willHit: true, limitReached: true },
      };
      const { due, retire } = evalWith({ usage, prefs });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });

    it('a disabled type is NOT retired by a higher fire', () => {
      // approaching OFF; limitReached fires at 100. approaching:80/:95 must
      // NOT appear in retire (the user turned them off — not "spent").
      const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const prefs = {
        alertsEnabled: true,
        types: { approaching: false, willHit: true, limitReached: true },
      };
      const { due, retire } = evalWith({ usage, prefs });
      assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
      assert.deepEqual(retire, [`willHit:fiveHour:${FIVE_RESET}`]);
    });

    it('disabled limitReached: the next type down (willHit) becomes H', () => {
      const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
      const prefs = {
        alertsEnabled: true,
        types: { approaching: true, willHit: true, limitReached: false },
      };
      const projection = freshProjection(usage);
      assert.equal(projection.windows.fiveHour.state, 'will_hit');
      const { due } = evaluate({
        usage,
        projection,
        prefs,
        fired: new Set(),
        nowMs: NOW_MS,
      });
      assert.deepEqual(ids(due), [`willHit:fiveHour:${FIVE_RESET}`]);
    });
  });

  describe('both watched windows in one pass', () => {
    it('each window evaluated independently', () => {
      const usage = {
        fiveHour: { pct: 100, resetsAt: FIVE_RESET },
        sevenDay: { pct: 82, resetsAt: SEVEN_RESET },
      };
      const { due } = evalWith({ usage });
      assert.deepEqual(ids(due).sort(), [
        `approaching:sevenDay:80:${SEVEN_RESET}`,
        `limitReached:fiveHour:${FIVE_RESET}`,
      ].sort());
    });
  });

  describe('null / missing window -> skipped', () => {
    it('resetsAt null skips the window', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: null } };
      const { due, retire } = evalWith({ usage });
      assert.deepEqual(due, []);
      assert.deepEqual(retire, []);
    });

    it('window entirely absent is skipped', () => {
      const usage = { sevenDay: { pct: 82, resetsAt: SEVEN_RESET } };
      const { due } = evalWith({ usage });
      assert.deepEqual(ids(due), [`approaching:sevenDay:80:${SEVEN_RESET}`]);
    });
  });

  describe('alert bodies use local time', () => {
    it('body contains the local-time string for resetsAt', () => {
      const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
      const { due } = evalWith({ usage });
      const expected = new Date(FIVE_RESET).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      assert.ok(
        due[0].body.includes(expected),
        `body "${due[0].body}" should contain "${expected}"`
      );
      assert.ok(due[0].title.includes('5-hour'));
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/alert-engine.test.js`
  Expected: failure with `Cannot find module '../lib/alert-engine.js'` (or `ERR_MODULE_NOT_FOUND`) — the engine file does not exist yet.

- [ ] **Step 3: Implement `lib/alert-engine.js` (minimal, pure).**
  Complete file:

  ```js
  /**
   * Pure desktop alert engine (Active-Guardrail Sub-Project B, Component 1).
   * Spec: docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md
   *
   * Consumes Sub-Project A's projection (lib/projection.js::buildProjection)
   * plus the normalized usage plan and the user's alert prefs, and decides
   * which OS notifications are DUE and which dedup keys to RETIRE (mark spent
   * without firing). No I/O, no DOM, no clock: nowMs is a parameter (house
   * convention — no Date.now() in lib/). The /api/alerts/pending endpoint
   * wires this to the stores; the Rust poller fires + acks the result.
   */

  /** The two hero windows we watch (fixed). */
  export const WATCHED_WINDOWS = ['fiveHour', 'sevenDay'];

  /** Approaching levels, highest first (drives the descending key order). */
  export const APPROACHING_LEVELS = [95, 80];

  /**
   * Severity rank — higher fires first and retires everything strictly below
   * it for the same window (forward-looking collapse).
   */
  export const SEVERITY = {
    limitReached: 4,
    willHit: 3,
    approaching95: 2,
    approaching80: 1,
  };

  /** Human label for a watched window. */
  export function windowLabel(w) {
    return w === 'fiveHour' ? '5-hour' : 'weekly';
  }

  function parseMs(iso) {
    if (typeof iso !== 'string' || iso === '') return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  function localTime(iso) {
    return new Date(iso).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function dedupKey(type, w, level, resetsAt) {
    if (type === 'approaching') return `approaching:${w}:${level}:${resetsAt}`;
    return `${type}:${w}:${resetsAt}`;
  }

  function buildAlert(type, w, level, resetsAt) {
    const label = windowLabel(w);
    const id = dedupKey(type, w, level, resetsAt);
    const reset = parseMs(resetsAt) != null ? localTime(resetsAt) : '';
    if (type === 'limitReached') {
      return {
        id,
        type,
        window: w,
        title: `Clauge — ${label} limit reached`,
        body: `You've hit your ${label} limit. Resets ~${reset}.`,
      };
    }
    if (type === 'willHit') {
      return {
        id,
        type,
        window: w,
        title: 'Clauge — on pace to run out',
        body: `At this rate your ${label} limit runs out before it resets.`,
      };
    }
    return {
      id,
      type,
      window: w,
      level,
      title: `Clauge — ${label} limit at ${level}%`,
      body: `You're past ${level}% of your ${label} window. Resets ~${reset}.`,
    };
  }

  /**
   * The enumerable candidate set for one window, in DESCENDING severity, each
   * tagged with its rank, dedup key, condition-met flag, and whether prefs
   * enable it. resetsAt is the live window instance id.
   */
  function candidatesFor(w, usage, projection, prefs, nowMs) {
    const win = usage?.[w];
    const resetsAt = win?.resetsAt ?? null;
    if (resetsAt == null) return []; // null/absent window -> skipped entirely
    const resetsAtMs = parseMs(resetsAt);
    const pct = Number.isFinite(win?.pct) ? win.pct : null;
    const state = projection?.windows?.[w]?.state ?? null;
    const stale = projection?.freshness?.stale === true;
    const types = prefs?.types ?? {};

    // limitReached: pct >= 100 (load-bearing, NOT state===exhausted). Under
    // stale data it is EXEMPT from suppression, but only when resetsAt is
    // still in the future (a stale post-reset 100 must not fire).
    const limitMet = pct != null && pct >= 100;
    const limitStaleEligible =
      !stale || (limitMet && resetsAtMs != null && resetsAtMs > nowMs);

    return [
      {
        rank: SEVERITY.limitReached,
        key: dedupKey('limitReached', w, null, resetsAt),
        type: 'limitReached',
        level: null,
        enabled: types.limitReached !== false ? true : false,
        met: limitMet,
        eligible: limitStaleEligible,
      },
      {
        rank: SEVERITY.willHit,
        key: dedupKey('willHit', w, null, resetsAt),
        type: 'willHit',
        level: null,
        enabled: types.willHit !== false ? true : false,
        met: state === 'will_hit',
        eligible: !stale, // forecast suppressed when stale
      },
      {
        rank: SEVERITY.approaching95,
        key: dedupKey('approaching', w, 95, resetsAt),
        type: 'approaching',
        level: 95,
        enabled: types.approaching !== false ? true : false,
        met: pct != null && pct >= 95,
        eligible: !stale,
      },
      {
        rank: SEVERITY.approaching80,
        key: dedupKey('approaching', w, 80, resetsAt),
        type: 'approaching',
        level: 80,
        enabled: types.approaching !== false ? true : false,
        met: pct != null && pct >= 80,
        eligible: !stale,
      },
    ];
  }

  /**
   * Decide which alerts fire now and which lesser keys are retired (spent
   * without firing) via the forward-looking severity collapse + stale gate.
   *
   * @param {{
   *   usage: object, projection: object,
   *   prefs: { alertsEnabled: boolean,
   *     types: { approaching: boolean, willHit: boolean, limitReached: boolean } },
   *   fired: Set<string>, nowMs: number,
   * }} args
   * @returns {{ due: Array<object>, retire: string[] }}
   */
  export function evaluate({ usage, projection, prefs, fired, nowMs }) {
    if (!prefs || prefs.alertsEnabled === false) return { due: [], retire: [] };
    const firedSet = fired instanceof Set ? fired : new Set();

    const due = [];
    const retire = [];

    for (const w of WATCHED_WINDOWS) {
      const candidates = candidatesFor(w, usage, projection, prefs, nowMs);
      if (candidates.length === 0) continue; // skipped window

      // H = highest-severity candidate that is enabled, condition-met,
      // unfired, and stale-eligible.
      const H = candidates.find(
        (c) => c.enabled && c.met && c.eligible && !firedSet.has(c.key)
      );
      if (!H) continue;

      due.push(buildAlert(H.type, w, H.level, usage[w].resetsAt));

      // Retire every ENABLED, UNFIRED key of strictly-lower severity for this
      // window — regardless of whether its condition is currently met.
      for (const c of candidates) {
        if (c.rank < H.rank && c.enabled && !firedSet.has(c.key)) {
          retire.push(c.key);
        }
      }
    }

    return { due, retire };
  }
  ```

- [ ] **Step 4: Run the test — verify it PASSES.**
  Command: `node --test test/alert-engine.test.js`
  Expected: all tests pass (`# pass` count > 0, `# fail 0`).

- [ ] **Step 5: Commit.**
  ```bash
  git add lib/alert-engine.js test/alert-engine.test.js
  git commit -m "feat(alerts): pure alert-engine — forward-looking severity collapse + stale gate"
  ```

---

### Task 2: `lib/alert-state.js` — fired-key persistence (atomic, pruned) + tests

**Files**
- Create: `/Users/adnanrashid/Projects/clauge/lib/alert-state.js`
- Test: `/Users/adnanrashid/Projects/clauge/test/alert-state.test.js`

**Pinned contract:**
- `class AlertState { constructor({ filePath }); async load(nowMs); async markFired(keys); }`.
- `load(nowMs)` → `Set<string>`, pruned of every key whose embedded `resetsAt` is `<= nowMs` (window already reset) **and** of any key whose `resetsAt` segment is unparseable. Missing file or corrupt JSON → empty `Set`. Never throws.
- `markFired(keys)` → unions `keys` into the persisted fired set, atomic tmp + rename (the `lib/config-store.js` pattern — see `config-store.js:92-100`).
- File `~/.clauge/alert-state.json`, shape `{ "v": 1, "fired": [...] }`.
- Default path resolves like `lib/config-store.js` resolves `config.json`: through `configPaths` (a NEW `configPaths.alertStateFile()` helper alongside `configFile()`, honoring `CLAUGE_HOME`). The `resetsAt` is the **last colon-joined ISO segment** of a key — parse it for pruning.
- The embedded `resetsAt` is an ISO-8601 string that itself contains colons (e.g. `...80:2026-06-12T14:20:00+00:00`). Recover it by stripping the leading non-ISO segments: split on `:`, the timestamp is everything from the segment that begins with a 4-digit year onward. Use a regex anchor (`/:(\d{4}-\d{2}-\d{2}T.*)$/`) to lift it.

**Steps**

- [ ] **Step 1: Write the failing test file `test/alert-state.test.js`.**
  Uses `mkdtemp` temp dirs (mirrors `config-store.test.js`). Complete file:

  ```js
  // Unit tests for lib/alert-state.js — sidecar-owned fired-key store
  // (Component 2, docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md).
  // Atomic tmp+rename persistence (mirrors lib/config-store.js); load() prunes
  // keys whose embedded resetsAt has already passed; missing/corrupt -> empty.

  import { describe, it, beforeEach, afterEach } from 'node:test';
  import assert from 'node:assert/strict';
  import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  import { AlertState } from '../lib/alert-state.js';

  // 2026-06-12T10:00:00.000Z
  const NOW_MS = 1781258400000;
  const FUTURE = '2026-06-12T14:20:00+00:00'; // > NOW
  const PAST = '2026-06-12T05:00:00+00:00'; // < NOW

  const FUTURE_KEY = `approaching:fiveHour:80:${FUTURE}`;
  const PAST_KEY = `approaching:fiveHour:80:${PAST}`;
  const FUTURE_LIMIT_KEY = `limitReached:sevenDay:${FUTURE}`;

  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'clauge-alert-state-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeState() {
    return new AlertState({ filePath: join(dir, 'alert-state.json') });
  }

  async function writeRaw(contents) {
    await writeFile(join(dir, 'alert-state.json'), contents);
  }

  describe('load — missing / corrupt tolerance', () => {
    it('missing file -> empty Set', async () => {
      const fired = await makeState().load(NOW_MS);
      assert.ok(fired instanceof Set);
      assert.equal(fired.size, 0);
    });

    it('corrupt JSON -> empty Set (never throws)', async () => {
      await writeRaw('{ not json at all');
      const fired = await makeState().load(NOW_MS);
      assert.equal(fired.size, 0);
    });

    it('non-array fired field -> empty Set', async () => {
      await writeRaw(JSON.stringify({ v: 1, fired: 'oops' }));
      const fired = await makeState().load(NOW_MS);
      assert.equal(fired.size, 0);
    });
  });

  describe('load — prune by embedded resetsAt', () => {
    it('drops keys whose resetsAt <= nowMs, keeps future ones', async () => {
      await writeRaw(
        JSON.stringify({ v: 1, fired: [FUTURE_KEY, PAST_KEY, FUTURE_LIMIT_KEY] })
      );
      const fired = await makeState().load(NOW_MS);
      assert.ok(fired.has(FUTURE_KEY));
      assert.ok(fired.has(FUTURE_LIMIT_KEY));
      assert.ok(!fired.has(PAST_KEY));
      assert.equal(fired.size, 2);
    });

    it('drops a key with an unparseable resetsAt segment', async () => {
      const bad = 'approaching:fiveHour:80:not-a-date';
      await writeRaw(JSON.stringify({ v: 1, fired: [FUTURE_KEY, bad] }));
      const fired = await makeState().load(NOW_MS);
      assert.ok(fired.has(FUTURE_KEY));
      assert.ok(!fired.has(bad));
      assert.equal(fired.size, 1);
    });
  });

  describe('markFired — union + atomic persistence', () => {
    it('persists the union and a re-load reflects it', async () => {
      const state = makeState();
      await state.markFired([FUTURE_KEY]);
      await state.markFired([FUTURE_LIMIT_KEY, FUTURE_KEY]); // dup + new

      const onDisk = JSON.parse(
        await readFile(join(dir, 'alert-state.json'), 'utf8')
      );
      assert.equal(onDisk.v, 1);
      assert.deepEqual([...onDisk.fired].sort(), [FUTURE_KEY, FUTURE_LIMIT_KEY].sort());

      const fired = await makeState().load(NOW_MS);
      assert.ok(fired.has(FUTURE_KEY));
      assert.ok(fired.has(FUTURE_LIMIT_KEY));
      assert.equal(fired.size, 2);
    });

    it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
      await makeState().markFired([FUTURE_KEY]);
      const entries = await readdir(dir);
      assert.deepEqual(entries, ['alert-state.json']);
    });

    it('creates the parent directory when missing', async () => {
      const nested = new AlertState({
        filePath: join(dir, 'deeper', '.clauge', 'alert-state.json'),
      });
      await nested.markFired([FUTURE_KEY]);
      const fired = await nested.load(NOW_MS);
      assert.ok(fired.has(FUTURE_KEY));
    });

    it('markFired with an empty array still produces a valid empty file', async () => {
      const state = makeState();
      await state.markFired([]);
      const onDisk = JSON.parse(
        await readFile(join(dir, 'alert-state.json'), 'utf8')
      );
      assert.deepEqual(onDisk, { v: 1, fired: [] });
    });
  });
  ```

- [ ] **Step 2: Run the test — verify it FAILS.**
  Command: `node --test test/alert-state.test.js`
  Expected: failure with `Cannot find module '../lib/alert-state.js'` (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Add the `alertStateFile()` path helper to `lib/config-paths.js`.**
  Anchor: inside the `configPaths` object literal, immediately after the `configFile:` entry (`config-paths.js:89`). Add this property:

  ```js
    // Sidecar-owned fired-alert state (~/.clauge/alert-state.json), beside
    // config.json. Same homeRoot() resolution so CLAUGE_HOME sandboxes it
    // cross-platform (landmine #14 / #40 — sidecar-owned, never settings.json).
    alertStateFile: () => path.join(homeRoot(), '.clauge', 'alert-state.json'),
  ```

  So the block reads:

  ```js
    configFile: () => path.join(homeRoot(), '.clauge', 'config.json'),
    // Sidecar-owned fired-alert state (~/.clauge/alert-state.json), beside
    // config.json. Same homeRoot() resolution so CLAUGE_HOME sandboxes it
    // cross-platform (landmine #14 / #40 — sidecar-owned, never settings.json).
    alertStateFile: () => path.join(homeRoot(), '.clauge', 'alert-state.json'),
    preferencesFile: () => preferencesFileInternal(),
  ```

- [ ] **Step 4: Implement `lib/alert-state.js`.**
  Complete file:

  ```js
  /**
   * Sidecar-owned fired-alert state (~/.clauge/alert-state.json).
   * Spec: docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md
   *
   * Records which alert dedup keys have already fired so an alert fires once
   * per window-instance even across restarts. DELIBERATELY a sidecar-owned
   * dotfile beside config.json (NOT the shared Tauri settings.json — landmine
   * #40: the Rust iCloud-publish loop rewrites settings.json and would clobber
   * any sidecar-written key). Exactly one writer: the sidecar.
   *
   * Atomic tmp+rename persistence (the lib/config-store.js pattern). load()
   * prunes keys whose embedded resetsAt has already passed (bounds the file)
   * and tolerates a missing/corrupt file (-> empty set, never throws). No
   * clock in lib/: load() takes nowMs as a parameter.
   *
   * Shape: { "v": 1, "fired": ["approaching:fiveHour:80:<iso>", ...] }.
   */

  import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
  import { dirname } from 'node:path';

  import { configPaths } from './config-paths.js';

  function defaultPath() {
    return configPaths.alertStateFile();
  }

  /**
   * Recover the embedded resetsAt (ISO-8601, itself colon-bearing) from a
   * dedup key. Anchors on the first 4-digit-year date segment to the end.
   * Returns the parsed epoch ms, or null when no ISO timestamp is present.
   * @param {string} key
   * @returns {number|null}
   */
  function resetsAtMsFromKey(key) {
    if (typeof key !== 'string') return null;
    const m = key.match(/:(\d{4}-\d{2}-\d{2}T.*)$/);
    if (m == null) return null;
    const ms = Date.parse(m[1]);
    return Number.isFinite(ms) ? ms : null;
  }

  export class AlertState {
    constructor({ filePath = defaultPath() } = {}) {
      this.filePath = filePath;
    }

    /**
     * Load the fired-key set, pruned of keys whose embedded resetsAt is <=
     * nowMs (or unparseable). Missing/corrupt file -> empty Set. Never throws.
     * @param {number} nowMs
     * @returns {Promise<Set<string>>}
     */
    async load(nowMs) {
      let keys = [];
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
        if (Array.isArray(parsed?.fired)) keys = parsed.fired;
      } catch {
        // Missing or corrupt — treated as no alerts fired.
        return new Set();
      }
      const live = new Set();
      for (const key of keys) {
        const ms = resetsAtMsFromKey(key);
        if (ms == null || ms <= nowMs) continue; // reset already passed / bad
        live.add(key);
      }
      return live;
    }

    /**
     * Union `keys` into the persisted fired set and write atomically (tmp +
     * rename) so a crash mid-write can never leave a torn file. Reads the
     * current set first so concurrent markers don't lose each other's keys.
     * @param {Iterable<string>} keys
     * @returns {Promise<void>}
     */
    async markFired(keys) {
      let existing = [];
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
        if (Array.isArray(parsed?.fired)) existing = parsed.fired;
      } catch {
        // Missing or corrupt — start fresh.
      }
      const union = new Set(existing);
      for (const k of keys) union.add(k);

      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(
        tmpPath,
        JSON.stringify({ v: 1, fired: [...union] }, null, 2),
        { mode: 0o600 }
      );
      await rename(tmpPath, this.filePath);
    }
  }
  ```

- [ ] **Step 5: Run the test — verify it PASSES.**
  Command: `node --test test/alert-state.test.js`
  Expected: all tests pass (`# fail 0`).

- [ ] **Step 6: Run the existing config-paths test (no regression on the path helper).**
  Command: `node --test test/config-paths.test.js`
  Expected: still green (the new `alertStateFile` property is additive). If `test/config-paths.test.js` does not exist, skip this step.

- [ ] **Step 7: Commit.**
  ```bash
  git add lib/alert-state.js lib/config-paths.js test/alert-state.test.js
  git commit -m "feat(alerts): alert-state store — atomic fired-key persistence + resetsAt prune"
  ```
## PR 2 — branch `feat/alerts-wiring` (after PR 1 merges)

> **Preconditions (PR 1 deliverables, must be on `main` before this branch):** `lib/alert-engine.js` (exports `WATCHED_WINDOWS`, `APPROACHING_LEVELS`, `SEVERITY`, `windowLabel`, `evaluate`) and `lib/alert-state.js` (`class AlertState { constructor({filePath}); async load(nowMs); async markFired(keys) }`). Tasks 4 imports both; Task 3 is independent of them. Verified absent on the current branch (`lib/alert-engine.js`, `lib/alert-state.js` do not exist yet — they arrive with PR 1).
>
> **House rules in force:** ESM (`"type":"module"`); `lib/` modules pure with clock injection (`nowMs` always a param, never `Date.now()` in `lib/`); no `console.log` in `lib/` (`console.warn/error/info` OK); `npm test` glob is ONLY `test/*.test.js test/cli/*.test.js`; run a single JS test file with `node --test <file>`; full gate is `npm run check`. NO new dependencies. Conventional Commits, no `Co-Authored-By` line.

---

### Task 3: Refactor `lib/config-store.js` to read-merge-write + add alert prefs

**Why:** Today `setSubscriptionCost` rewrites the whole file as `{v:1, subscriptionCost:n}`. The moment alert prefs land in the same `~/.clauge/config.json`, that whole-file rewrite would clobber the `alerts` block (and a future `setAlertPrefs` would clobber `subscriptionCost`). The fix is a private read-merge-write pair so unrelated keys survive every write. Pinned interface (used verbatim by the other agents and the server): `effectiveAlertPrefs() -> {alertsEnabled:bool, types:{approaching:bool,willHit:bool,limitReached:bool}}` (defaults ALL true; missing/corrupt `alerts` block = all-on; non-boolean flag → default true); `setAlertPrefs(partial)` merges into the `alerts` block, validates booleans, atomic write, returns effective prefs. `config.json` shape: `{"v":1,"subscriptionCost":200,"alerts":{"enabled":true,"types":{"approaching":true,"willHit":true,"limitReached":true}}}`.

**Files**
- Modify: `lib/config-store.js` — current file is 103 lines. Add private `readAll()` (anchor: insert after the `validCost` helper, before `export class ConfigStore` at line 47) and `writeAll(obj)`; rewrite `setSubscriptionCost` (lines 86–101) to read-merge-write; add `effectiveAlertPrefs()` and `setAlertPrefs(partial)` as new methods inside the class.
- Modify/Test: `test/config-store.test.js` — extend (current file is 143 lines; append new `describe` blocks after the existing `setSubscriptionCost` block at line 142).

**Steps**

- [ ] **Step 1: Write failing tests for the refactor + new methods.** Append the following to `test/config-store.test.js` (after the closing of the `setSubscriptionCost` describe block, i.e. after line 142). It adds three new describe blocks: read-merge-write coexistence, `effectiveAlertPrefs`, and `setAlertPrefs`.

```javascript
// ── Read-merge-write refactor: subscriptionCost and alerts must coexist ──
// Today setSubscriptionCost rewrites the whole file ({v:1,subscriptionCost}).
// After the refactor, a write to either key must preserve the other.
describe('read-merge-write — subscriptionCost and alerts coexist', () => {
  it('setSubscriptionCost preserves an existing alerts block', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        subscriptionCost: 200,
        alerts: { enabled: false, types: { approaching: false, willHit: true, limitReached: true } },
      })
    );
    const store = makeStore({});
    await store.setSubscriptionCost(120);

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.subscriptionCost, 120, 'cost updated');
    assert.deepEqual(
      onDisk.alerts,
      { enabled: false, types: { approaching: false, willHit: true, limitReached: true } },
      'alerts block untouched by a cost write'
    );
  });

  it('setAlertPrefs preserves an existing subscriptionCost', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 150 }));
    const store = makeStore({ SUBSCRIPTION_COST: '999' });
    await store.setAlertPrefs({ enabled: false });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.subscriptionCost, 150, 'cost preserved by an alerts write');
    assert.equal(await store.effectiveSubscriptionCost(), 150, 'file cost still wins over env');
  });
});

describe('effectiveAlertPrefs — defaults all-on', () => {
  it('returns all-on when no file exists', async () => {
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('returns all-on when the file has no alerts block', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 200 }));
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('returns all-on when the file is corrupt JSON', async () => {
    await writeConfig('{ not json at all');
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('reflects a fully specified alerts block', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        subscriptionCost: 200,
        alerts: { enabled: false, types: { approaching: false, willHit: false, limitReached: true } },
      })
    );
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: false,
      types: { approaching: false, willHit: false, limitReached: true },
    });
  });

  it('coerces a non-boolean flag to the default true (per-flag)', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        alerts: { enabled: 'yes', types: { approaching: 1, willHit: false, limitReached: null } },
      })
    );
    // enabled 'yes' -> non-boolean -> default true; approaching 1 -> true;
    // willHit false -> false (a real boolean is honored); limitReached null -> true.
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });
  });

  it('fills missing per-type flags with true', async () => {
    await writeConfig(
      JSON.stringify({ v: 1, alerts: { enabled: true, types: { willHit: false } } })
    );
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });
  });
});

describe('setAlertPrefs — merge, validate, return effective', () => {
  it('toggling one type preserves the others', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        alerts: { enabled: true, types: { approaching: true, willHit: true, limitReached: true } },
      })
    );
    const store = makeStore({});
    const eff = await store.setAlertPrefs({ types: { willHit: false } });
    assert.deepEqual(eff, {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.alerts.types, { approaching: true, willHit: false, limitReached: true });
  });

  it('a fresh instance rereads the persisted alert prefs', async () => {
    await makeStore({}).setAlertPrefs({ enabled: false });
    const eff = await makeStore({}).effectiveAlertPrefs();
    assert.equal(eff.alertsEnabled, false);
  });

  it('rejects a non-boolean enabled', async () => {
    await assert.rejects(
      () => makeStore({}).setAlertPrefs({ enabled: 'on' }),
      /boolean/,
      'enabled must be a boolean'
    );
  });

  it('rejects a non-boolean type flag', async () => {
    await assert.rejects(
      () => makeStore({}).setAlertPrefs({ types: { approaching: 1 } }),
      /boolean/,
      'type flags must be booleans'
    );
  });

  it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
    await makeStore({}).setAlertPrefs({ enabled: true });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['config.json']);
  });
});
```

- [ ] **Step 2: Run the new tests and confirm they FAIL.** Command: `node --test test/config-store.test.js`. Expected: failures on the new blocks — `TypeError: store.effectiveAlertPrefs is not a function` / `store.setAlertPrefs is not a function`, and the `setSubscriptionCost preserves an existing alerts block` case failing because the current `setSubscriptionCost` writes `{v:1,subscriptionCost}` (no `alerts` key). The original `effectiveSubscriptionCost` / `setSubscriptionCost` describe blocks (lines 32–142) MUST still pass — except the one on-disk-shape assertion noted in Step 4.

- [ ] **Step 3: Add `ALERT_TYPE_KEYS` + `coerceBool` + `readAll`/`writeAll` to `lib/config-store.js`.** Insert this block immediately after the `validCost` function (after line 45, before `export class ConfigStore`):

```javascript
// The three per-type alert flags, in a fixed order so reads/writes are
// deterministic. Mirrors the alert-engine's WATCHED types.
const ALERT_TYPE_KEYS = ['approaching', 'willHit', 'limitReached'];

/**
 * Coerce one alert flag to a boolean. A real boolean is honored; anything
 * else (missing, string, number, null) falls back to the default — which is
 * always `true` (all-on). Mirrors validCost's "invalid -> absent" stance.
 * @param {unknown} value
 * @returns {boolean}
 */
function coerceBool(value) {
  return typeof value === 'boolean' ? value : true;
}
```

- [ ] **Step 4: Add the private `readAll()` / `writeAll(obj)` helpers and migrate `setSubscriptionCost`.** Replace the existing `setSubscriptionCost` method (lines 86–101) with the three methods below. `readAll()` is the single corruption-tolerant reader (returns `{}` on missing/corrupt so callers always merge into an object); `writeAll(obj)` is the single atomic writer. `setSubscriptionCost` now reads the existing object, sets one key, and writes the merged whole.

```javascript
  /**
   * Read the whole config object, tolerant of a missing or corrupt file.
   * Returns a plain object ({} when absent/corrupt) so callers can always
   * spread-merge into it. Never throws.
   * @returns {Promise<Record<string, unknown>>}
   */
  async readAll() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  /**
   * Atomically persist the whole config object (tmp + rename), stamping
   * v:1. The single writer for config.json — every mutating method funnels
   * through here so a partial write can never leave a torn file.
   * @param {Record<string, unknown>} obj
   * @returns {Promise<void>}
   */
  async writeAll(obj) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ v: 1, ...obj }, null, 2), {
      mode: 0o600,
    });
    await rename(tmpPath, this.filePath);
  }

  /**
   * Persist a new subscription cost via read-merge-write so unrelated keys
   * (the alerts block) survive. Validates (finite number > 0, strict type).
   * @param {number} n
   * @returns {Promise<number>} the persisted value
   */
  async setSubscriptionCost(n) {
    if (validCost(n) == null) {
      throw new Error(
        `subscriptionCost must be a finite number > 0, got: ${String(n)}`
      );
    }
    const current = await this.readAll();
    await this.writeAll({ ...current, subscriptionCost: n });
    return n;
  }
```

  > NOTE for the implementer: the existing test `writes {"v":1,"subscriptionCost":n} and a fresh instance rereads it` (line 113) asserts `assert.deepEqual(onDisk, { v: 1, subscriptionCost: 120 })`. With read-merge-write over a previously empty file, `readAll()` returns `{}` so the write is still exactly `{v:1, subscriptionCost:120}` — that assertion stays green (no `alerts` key is added unless one already exists). Confirm this passes unchanged; do not edit that test.

- [ ] **Step 5: Add `effectiveAlertPrefs()` and `setAlertPrefs(partial)` methods.** Insert both inside the class, immediately after the new `setSubscriptionCost` (before the closing `}` of `ConfigStore`):

```javascript
  /**
   * Effective alert prefs: the file's `alerts` block with every field
   * defaulted to true. A missing/corrupt file or missing block = all-on.
   * Each flag is coerced (non-boolean -> default true). Shape matches what
   * lib/alert-engine.js's evaluate() expects as `prefs`.
   * @returns {Promise<{alertsEnabled: boolean, types: {approaching: boolean, willHit: boolean, limitReached: boolean}}>}
   */
  async effectiveAlertPrefs() {
    const all = await this.readAll();
    const block = all.alerts && typeof all.alerts === 'object' ? all.alerts : {};
    const rawTypes = block.types && typeof block.types === 'object' ? block.types : {};
    const types = {};
    for (const key of ALERT_TYPE_KEYS) {
      types[key] = coerceBool(rawTypes[key]);
    }
    return { alertsEnabled: coerceBool(block.enabled), types };
  }

  /**
   * Merge a partial alert-prefs update into the file's `alerts` block via
   * read-merge-write (preserving subscriptionCost). Validates that every
   * provided flag is a real boolean (throws otherwise — a bad write must not
   * silently no-op). Returns the effective prefs after the merge.
   * @param {{enabled?: boolean, types?: {approaching?: boolean, willHit?: boolean, limitReached?: boolean}}} partial
   * @returns {Promise<{alertsEnabled: boolean, types: object}>}
   */
  async setAlertPrefs(partial = {}) {
    if ('enabled' in partial && typeof partial.enabled !== 'boolean') {
      throw new Error(`alerts.enabled must be a boolean, got: ${String(partial.enabled)}`);
    }
    const partialTypes = partial.types && typeof partial.types === 'object' ? partial.types : {};
    for (const key of ALERT_TYPE_KEYS) {
      if (key in partialTypes && typeof partialTypes[key] !== 'boolean') {
        throw new Error(`alerts.types.${key} must be a boolean, got: ${String(partialTypes[key])}`);
      }
    }
    // Merge against the CURRENT effective prefs so toggling one flag
    // preserves the others (the merge base is the resolved, defaulted view).
    const current = await this.effectiveAlertPrefs();
    const merged = {
      enabled: 'enabled' in partial ? partial.enabled : current.alertsEnabled,
      types: { ...current.types },
    };
    for (const key of ALERT_TYPE_KEYS) {
      if (key in partialTypes) merged.types[key] = partialTypes[key];
    }
    const all = await this.readAll();
    await this.writeAll({ ...all, alerts: merged });
    return { alertsEnabled: merged.enabled, types: merged.types };
  }
```

- [ ] **Step 6: Run the tests and confirm they PASS.** Command: `node --test test/config-store.test.js`. Expected: all tests pass (original 17 + the new blocks). Then run the JS suite to confirm no regressions: `npm test` (expected: all green).

- [ ] **Step 7: Commit.** `git add lib/config-store.js test/config-store.test.js` then:

```
git commit -m "refactor(config-store): read-merge-write + alert prefs

setSubscriptionCost now merges instead of rewriting the whole file, so
alert prefs and subscription cost coexist in ~/.clauge/config.json. Adds
private readAll()/writeAll(), effectiveAlertPrefs() (defaults all-on,
per-flag boolean coercion), and setAlertPrefs(partial) (merge + validate)."
```

---

### Task 4: `server.js` — alert config + pending + ack endpoints

**Why:** The Rust alert poller (PR 2 Task 6, separate agent) drives notifications entirely over loopback HTTP. It needs: `POST /api/config/alerts` to flip prefs (also used by the macOS NSMenu toggle), `GET /api/config` to report current `alerts`, `GET /api/alerts/pending` (pure read → `{due, retire}`), and `POST /api/alerts/ack` (marks fired). The pending handler must capture ONE `nowMs` and thread it through `buildProjection` + `AlertState.load(nowMs)` (prune) + `evaluate` so the freshness boundary, the prune cutoff, and the body's local-time strings can't straddle a tick — exactly the single-stamp pattern the `/api/projection` handler already uses (`server.js:566`). Crucial: `/api/alerts/pending` must NOT be added to `READ_ONLY_API_PATHS` (it's a loopback-only, `Origin`-less Rust request — the webview never reads it, so it stays off the CORS allowlist).

**Files**
- Modify: `server.js` —
  - import `AlertState` next to the existing `ConfigStore` import (line 40);
  - instantiate `alertState` next to `usageStore` (after line 97);
  - add `POST /api/config/alerts` after the `POST /api/config/subscription-cost` handler (line 653);
  - extend `GET /api/config` (lines 604–612) to report `alerts`;
  - add `GET /api/alerts/pending` and `POST /api/alerts/ack` (place after the `/api/projection` handler, after line 587 — they share that handler's store + projection wiring).
- Modify/Test: `test/server-additions.test.js` — append a describe block for `POST /api/config/alerts` validation + `GET /api/config` alerts reflection (server-spawn style; the file ends at line 292).
- Create/Test: `test/server-alerts.test.js` — `GET /api/alerts/pending` shape + side-effect-free (two GETs same `due`) + `POST /api/alerts/ack` (a fresh GET omits acked ids) + malformed-body 400s.

> **Sandboxing note (load-bearing):** server tests redirect `~/.clauge` via the `CLAUGE_HOME` env var (`configPaths` honors it cross-platform, including Windows where a raw `HOME` redirect is ignored — see the subscription-cost suite at `server-additions.test.js:219`). The alert-state file resolves under `~/.clauge` too, so `CLAUGE_HOME` sandboxes it as well. Use `CLAUGE_HOME`, not `HOME`, for the alerts suites.

**Steps**

- [ ] **Step 1: Write the failing `POST /api/config/alerts` + `GET /api/config` tests in `test/server-additions.test.js`.** Append after line 292:

```javascript
// PR 2 (alerts): per-type alert prefs are a persisted sidecar-owned setting
// in the SAME ~/.clauge/config.json as subscriptionCost (read-merge-write).
// POST /api/config/alerts flips them; GET /api/config reports them. Sandbox
// via CLAUGE_HOME (cross-platform, unlike a raw HOME redirect).
describe('alert prefs (POST /api/config/alerts + GET /api/config)', () => {
  let server, home;
  const PORT = '3506';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-alerts-config-`);
    server = await startServer({ PORT, CLAUGE_HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('GET /api/config reports all-on alert prefs by default', async () => {
    const body = await (await fetch(`${BASE}/api/config`)).json();
    assert.deepEqual(body.alerts, {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('POST /api/config/alerts flips the master toggle and returns effective prefs', async () => {
    const res = await fetch(`${BASE}/api/config/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 200);
    const eff = await res.json();
    assert.equal(eff.alertsEnabled, false);

    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert.equal(cfg.alerts.alertsEnabled, false, 'GET reflects the persisted toggle');
  });

  it('toggling one type preserves the others (merge, not replace)', async () => {
    const res = await fetch(`${BASE}/api/config/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: { willHit: false } }),
    });
    assert.equal(res.status, 200);
    const eff = await res.json();
    assert.equal(eff.types.willHit, false);
    assert.equal(eff.types.approaching, true, 'untouched type stays on');
    assert.equal(eff.types.limitReached, true, 'untouched type stays on');
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const res = await fetch(`${BASE}/api/config/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'on' }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a non-boolean type flag with 400', async () => {
    const res = await fetch(`${BASE}/api/config/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ types: { approaching: 1 } }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-JSON with 400', async () => {
    const res = await fetch(`${BASE}/api/config/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert.equal(res.status, 400);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL.** Command: `node --test test/server-additions.test.js`. Expected: the new `alert prefs` describe block fails — `GET /api/config` returns no `alerts` key (so `body.alerts` is `undefined`, `deepEqual` throws) and `POST /api/config/alerts` 404s (no route → not 200/400 as asserted). All pre-existing describe blocks stay green.

- [ ] **Step 3: Import + instantiate `AlertState` in `server.js`.** Add the import beside the `ConfigStore` import. Replace line 40 (`import { ConfigStore } from './lib/config-store.js';`) with:

```javascript
import { ConfigStore } from './lib/config-store.js';
import { AlertState } from './lib/alert-state.js';
```

Then add the instantiation immediately after `await usageStore.load();` (line 97). The file path resolves under `~/.clauge` like `config.json`; use `configPaths` so `CLAUGE_HOME` sandboxes it (already imported at line 43):

```javascript
// Alert fired-key state (~/.clauge/alert-state.json). Sidecar-owned, atomic
// tmp+rename, pruned of expired keys on each load — drives the once-per-
// window-instance dedup for the desktop-alerts poller (active-guardrail B).
const alertState = new AlertState({ filePath: configPaths.alertStateFile() });
```

  > NOTE for the implementer: `configPaths.alertStateFile()` is the path helper PR 1 adds to `lib/config-paths.js` (sibling of `configFile()`, resolving `~/.clauge/alert-state.json` under the `CLAUGE_HOME` override). If PR 1 named it differently, match that name. If PR 1 did not add a path helper and instead resolves the path inside `AlertState`, drop the `filePath` arg and instantiate `new AlertState({})` per PR 1's signature. Confirm against the merged `lib/alert-state.js` before writing — the pinned interface is `constructor({filePath})` resolving the path "like lib/config-store.js resolves config.json (configPaths)".

- [ ] **Step 4: Extend `GET /api/config` to report `alerts`.** Replace the `GET /api/config` handler (lines 604–612) with:

```javascript
app.get('/api/config', async (c) => {
  const providers = await listProviders();
  return c.json({
    claudeDir: CLAUDE_DIR,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
    alerts: await configStore.effectiveAlertPrefs(),
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    providers,
  });
});
```

- [ ] **Step 5: Add `POST /api/config/alerts`.** Insert immediately after the `POST /api/config/subscription-cost` handler (after line 653). Validation: every provided flag must be a real boolean; `setAlertPrefs` itself throws on a bad flag, but validate at the boundary first so we return a clean 400 instead of a 500:

```javascript
// Per-type alert prefs (active-guardrail sub-project B). Same-origin dashboard
// POST + loopback NSMenu toggle; no CORS middleware (the '/api/config' entry in
// READ_ONLY_API_PATHS does not match this subpath). Body: { enabled?: boolean,
// types?: { approaching?, willHit?, limitReached? } }. 400 on any non-boolean
// field. Merges into the existing alerts block (toggling one preserves others).
app.post('/api/config/alerts', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'expected body: { enabled?: boolean, types?: {...} }' }, 400);
  }
  if ('enabled' in body && typeof body.enabled !== 'boolean') {
    return c.json({ error: 'alerts.enabled must be a boolean' }, 400);
  }
  if ('types' in body) {
    if (!body.types || typeof body.types !== 'object') {
      return c.json({ error: 'alerts.types must be an object' }, 400);
    }
    for (const key of ['approaching', 'willHit', 'limitReached']) {
      if (key in body.types && typeof body.types[key] !== 'boolean') {
        return c.json({ error: `alerts.types.${key} must be a boolean` }, 400);
      }
    }
  }
  const effective = await configStore.setAlertPrefs(body);
  return c.json(effective);
});
```

- [ ] **Step 6: Run and confirm the config-alerts tests PASS.** Command: `node --test test/server-additions.test.js`. Expected: all green, including the new `alert prefs` block.

- [ ] **Step 7: Write the failing `test/server-alerts.test.js` for pending + ack.** Create the file. It seeds a deterministic over-limit usage record by ingesting `seven_day` at 100% with a FUTURE `resets_at` (so the `limitReached` alert is eligible — `pct>=100 AND resetsAt>nowMs` — even under the stale gate; the just-ingested record is fresh anyway). The test asserts shape, side-effect-freedom (two GETs return the same `due`), ack effect (after ack a fresh GET no longer returns those ids), and 400 on malformed ack bodies.

```javascript
// Integration tests for GET /api/alerts/pending + POST /api/alerts/ack
// (active-guardrail sub-project B). Spawns the real Hono server (server-
// additions style). The engine MATH is covered by test/alert-engine.test.js;
// these assert only the endpoint plumbing: {due, retire} shape, side-effect-
// freedom of the GET (a Rust crash before ack must re-fire next tick), ack
// marks fired (a subsequent GET omits them), and malformed-body 400s.
//
// /api/alerts/pending is deliberately NOT in READ_ONLY_API_PATHS — it is a
// loopback-only Rust request with no Origin header, so it never needs the CORS
// echo and the webview never reads it. Sandbox ~/.clauge via CLAUGE_HOME.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

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

// Ingest a seven_day window at 100% with a FUTURE reset, so limitReached is
// eligible (pct>=100 AND resetsAt>nowMs) regardless of the stale gate. The
// just-ingested record is fresh, so willHit/approaching are not suppressed —
// but limitReached (rank 4) is the highest-severity alert, so it is the sole
// `due` and the lower approaching keys are retired.
async function ingestSevenDayAt100(base) {
  const resetsSevenDay = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${base}/api/usage/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usage: { seven_day: { utilization: 100, resets_at: resetsSevenDay } },
    }),
  });
  assert.equal(res.status, 200, 'ingest seeds the over-limit window');
}

describe('GET /api/alerts/pending — shape + side-effect-free', () => {
  let server, home;
  const PORT = '3540';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-alerts-pending-`);
    server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    await ingestSevenDayAt100(BASE);
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('returns a {due, retire} object of the right shape', async () => {
    const res = await fetch(`${BASE}/api/alerts/pending`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['due', 'retire'], 'exactly {due, retire}');
    assert.ok(Array.isArray(body.due), 'due is an array');
    assert.ok(Array.isArray(body.retire), 'retire is an array');
    assert.ok(body.due.length >= 1, 'a 100% window yields at least one due alert');
    const a = body.due[0];
    for (const k of ['id', 'type', 'window', 'title', 'body']) {
      assert.ok(k in a, `due alert carries ${k}`);
    }
    assert.equal(a.type, 'limitReached', 'pct=100 -> limitReached is the highest-severity due alert');
    assert.equal(a.window, 'sevenDay');
  });

  it('is side-effect-free: a second GET returns the SAME due set (no firing on read)', async () => {
    const a = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const b = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    assert.deepEqual(
      a.due.map((x) => x.id).sort(),
      b.due.map((x) => x.id).sort(),
      'two reads without an ack return identical due ids'
    );
  });
});

describe('POST /api/alerts/ack — marks fired + idempotent + validation', () => {
  let server, home;
  const PORT = '3541';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-alerts-ack-`);
    server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    await ingestSevenDayAt100(BASE);
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('after acking the due ids, a fresh GET no longer returns them', async () => {
    const pending = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const firedIds = pending.due.map((x) => x.id);
    assert.ok(firedIds.length >= 1, 'precondition: at least one due alert');

    const ackRes = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: firedIds, retired: pending.retire }),
    });
    assert.equal(ackRes.status, 200);

    const after = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const stillDue = after.due.map((x) => x.id);
    for (const id of firedIds) {
      assert.ok(!stillDue.includes(id), `acked id ${id} is no longer due`);
    }
  });

  it('is idempotent: re-acking the same ids 200s and changes nothing', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: ['limitReached:sevenDay:2099-01-01T00:00:00+00:00'], retired: [] }),
    });
    assert.equal(res.status, 200);
    const again = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: ['limitReached:sevenDay:2099-01-01T00:00:00+00:00'], retired: [] }),
    });
    assert.equal(again.status, 200);
  });

  it('rejects a non-array fired with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: 'not-an-array', retired: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a non-array retired with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: [], retired: 42 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-JSON with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'garbage',
    });
    assert.equal(res.status, 400);
  });
});
```

  > NOTE for the implementer: both `CLAUGE_HOME` and `HOME` are set to the tmp dir. `CLAUGE_HOME` sandboxes `~/.clauge` (config + alert-state + usage); `HOME` additionally redirects `~/.claude` sessions so the ROI/projection trailing-spend path reads an empty sessions tree (matches the projection suite's sandbox). On Windows `HOME` is ignored by `os.homedir()` — but the `limitReached` path under test does not depend on session data, and `CLAUGE_HOME` (the one that matters for alert-state + usage) IS honored on Windows. These suites need NO `skip` guard; if a future cross-platform flake appears tied to the `HOME` redirect, add the same `SKIP_WIN` guard the projection suite uses.

- [ ] **Step 8: Run and confirm `server-alerts` tests FAIL.** Command: `node --test test/server-alerts.test.js`. Expected: failures — `GET /api/alerts/pending` and `POST /api/alerts/ack` both 404 (routes not yet defined), so the shape and status assertions fail.

- [ ] **Step 9: Add `GET /api/alerts/pending` + `POST /api/alerts/ack`.** Insert immediately after the `GET /api/projection` handler (after line 587). The pending handler reuses the projection handler's exact store wiring (the same `record`, `history`, trailing-spend, `buildProjection` call) under a SINGLE `nowMs`, then layers prefs + fired-state + `evaluate`. The `evaluate` import is added at the top alongside the others.

  First, add the `evaluate` import beside the existing projection import. Replace line 42 (`import { buildProjection } from './lib/projection.js';`) with:

```javascript
import { buildProjection } from './lib/projection.js';
import { evaluate } from './lib/alert-engine.js';
```

  Then insert the two handlers after line 587:

```javascript
// Desktop-alerts decision endpoint (active-guardrail sub-project B). Consumed
// ONLY by the Rust alert poller over loopback (LOCAL_CLIENT, Origin-less) — so
// it is deliberately NOT in READ_ONLY_API_PATHS (the webview never reads it).
// Capture nowMs ONCE and thread the SAME value into buildProjection, the
// alert-state prune (AlertState.load(nowMs)), and evaluate — so the freshness
// boundary, the prune cutoff, and the body's local-time strings can't straddle
// a tick. PURE READ: nothing is marked fired here; all mutation is in the ack,
// so a Rust crash before firing re-fires next tick (at-least-once).
app.get('/api/alerts/pending', async (c) => {
  const nowMs = Date.now();
  const record = await usageStore.load();
  const history = await usageHistory.samplesByWindow();
  const all = await store.loadAllSummaries();
  const trailing = filterSessions(all, { period: '7d', project: '', now: new Date(nowMs) });
  const apiEquivalentSpendTrailing = sumSessionCosts(trailing);
  const projection = buildProjection({
    normalized: record?.normalized ?? null,
    ingestedAt: record?.ingestedAt ?? null,
    history,
    nowMs,
    apiEquivalentSpendTrailing,
    subscriptionCost: await configStore.effectiveSubscriptionCost(),
  });
  const prefs = await configStore.effectiveAlertPrefs();
  const fired = await alertState.load(nowMs);
  const { due, retire } = evaluate({
    usage: record?.normalized ?? null,
    projection,
    prefs,
    fired,
    nowMs,
  });
  return c.json({ due, retire });
});

// Mark the union of {fired, retired} keys as fired in alert-state (one atomic
// write). `fired` = alerts Rust attempted to show; `retired` = the severity-
// collapsed lesser keys Rust never shows but that are spent. Idempotent. 400
// on a non-array field. Loopback-only (not in READ_ONLY_API_PATHS).
app.post('/api/alerts/ack', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'expected body: { fired: [...], retired: [...] }' }, 400);
  }
  const fired = body.fired ?? [];
  const retired = body.retired ?? [];
  if (!Array.isArray(fired) || !Array.isArray(retired)) {
    return c.json({ error: 'fired and retired must be arrays' }, 400);
  }
  await alertState.markFired([...fired, ...retired]);
  return c.json({ ok: true });
});
```

  > NOTE for the implementer: confirm `evaluate`'s `usage` param accepts the `record.normalized` shape directly. The pinned interface says `usage = normalized plan {fiveHour:{pct,resetsAt},...}`, which is exactly `record.normalized` (`lib/usage-store.js::normalizeUsage` returns `{fiveHour:{pct,resetsAt}, sevenDay:{...}, ...}`). When nothing has been ingested, `record?.normalized` is `null` — `evaluate` must tolerate a null `usage` (return `{due:[], retire:[]}`); this is a PR 1 contract, but the test's "nothing ingested" implicit case (a fresh server before `ingestSevenDayAt100`) would exercise it — the suites here ingest first, so the null path is covered by the engine's own unit tests in PR 1.

- [ ] **Step 10: Run all affected JS tests and confirm PASS.** Commands: `node --test test/server-alerts.test.js` (expected: all green), then `node --test test/server-additions.test.js` and `node --test test/server-projection.test.js` (expected: still green — confirm the new handlers didn't disturb the projection/CORS wiring). Then `npm test` for the full JS suite.

- [ ] **Step 11: Confirm `/api/alerts/pending` is NOT in `READ_ONLY_API_PATHS`.** This is a guard, not a code change: grep `server.js` for `READ_ONLY_API_PATHS` (line 180) and verify neither `/api/alerts/pending` nor `/api/alerts/ack` appears in the array. They are loopback-only and must stay off the CORS allowlist (a webview reading the alert decision stream is not a feature). Run `npm run check:validators` to confirm no validator (CORS/console-log/port) regressed.

- [ ] **Step 12: Commit.** `git add server.js test/server-additions.test.js test/server-alerts.test.js` then:

```
git commit -m "feat(alerts): server endpoints for alert prefs + pending/ack

POST /api/config/alerts (flip per-type prefs, 400 on non-boolean) + GET
/api/config now reports alerts. GET /api/alerts/pending captures one nowMs,
threads it through buildProjection + AlertState prune + evaluate, returns
{due, retire} (pure read, loopback-only, NOT in READ_ONLY_API_PATHS).
POST /api/alerts/ack marks the fired+retired union (atomic, idempotent)."
```

---

### Task 5: Dashboard Settings "Alerts" section

**Why:** Component 2 of the spec puts the full alert config in the dashboard Settings: a master "Alerts" toggle plus a checkbox per type (Approaching, Will-hit, Limit-reached). It reads current state from `GET /api/config` (the `alerts` block Task 4 added) on load and POSTs `/api/config/alerts` on change, with inline status feedback — mirroring the existing subscription-cost control (`initSubCostControl`, `app.js:996`; status element `#set-sub-cost-status`). This is webview wiring on the existing served `public/app.js` + `public/index.html`, both already SEA-registered, so landmine #39 ("new served JS needs BOTH SEA manifests") stays dormant — NO new served file is created. The dashboard is outside the popover copy registry (`scripts/validate-copy-registry.cjs` scans `popover/` only — confirmed `SCAN_DIRS = ['popover']`), so inline English strings are fine here. The one pure, testable seam is a mapping helper added to `public/swr.js` (the established vm-testable IIFE pattern, `test/dashboard-swr.test.js`).

**Files**
- Modify: `public/index.html` — add the Alerts rows inside the `data-set-panel="pricing"` section (anchor: after the `set-pricing-source` row, before its closing `</div>` at line 437), OR as a sibling row group; place them in the "Plan & ROI" panel alongside the sub-cost control so all forecast/alert config lives together.
- Modify: `public/swr.js` — add a pure `alertPrefsView(alerts)` helper to the IIFE and export it on `window.ClaugeDashSwr` (anchor: after `paceLine`, line 87; extend the export object at line 90).
- Modify: `public/app.js` — extend `renderSettings()` (line 938) to call a new `initAlertControls()`; add `initAlertControls()` after `initSubCostControl()` (after line 1037). It fetches `/api/config`, applies `alertPrefsView`, wires change handlers that POST `/api/config/alerts`.
- Modify/Test: `test/dashboard-swr.test.js` — extend with `alertPrefsView` cases (vm-loads the real `public/swr.js`, line 25 destructure).

**Steps**

- [ ] **Step 1: Write the failing `alertPrefsView` test in `test/dashboard-swr.test.js`.** First extend the destructure at line 25 to pull the new helper, then append a describe block. Replace line 25 (`const { syncMeta, shouldSkipTick } = loadDashSwr();`) with:

```javascript
const { syncMeta, shouldSkipTick, alertPrefsView } = loadDashSwr();
```

  Then append after the `shouldSkipTick` describe block (after line 69):

```javascript
describe('alertPrefsView — /api/config alerts -> checkbox state', () => {
  it('maps a full all-on alerts block to checked flags', () => {
    const v = alertPrefsView({
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
    assert.deepEqual(v, {
      enabled: true,
      approaching: true,
      willHit: true,
      limitReached: true,
      disabled: false,
    });
  });

  it('marks per-type checkboxes disabled when the master toggle is off', () => {
    const v = alertPrefsView({
      alertsEnabled: false,
      types: { approaching: true, willHit: false, limitReached: true },
    });
    assert.equal(v.enabled, false);
    assert.equal(v.disabled, true, 'per-type checkboxes greyed when master off');
    // the underlying per-type values are still reflected (so flipping master
    // back on restores them visually)
    assert.equal(v.approaching, true);
    assert.equal(v.willHit, false);
  });

  it('defaults to all-on + enabled when given null/garbage', () => {
    for (const bad of [null, undefined, 42, 'x', {}]) {
      const v = alertPrefsView(bad);
      assert.deepEqual(v, {
        enabled: true,
        approaching: true,
        willHit: true,
        limitReached: true,
        disabled: false,
      });
    }
  });

  it('coerces non-boolean type flags to true (mirrors the server default)', () => {
    const v = alertPrefsView({ alertsEnabled: true, types: { willHit: false } });
    assert.equal(v.approaching, true, 'missing type -> default on');
    assert.equal(v.willHit, false, 'explicit false honored');
    assert.equal(v.limitReached, true, 'missing type -> default on');
  });
});
```

- [ ] **Step 2: Run and confirm FAIL.** Command: `node --test test/dashboard-swr.test.js`. Expected: `alertPrefsView` is `undefined` (not yet exported), so the destructure yields `undefined` and every new case throws `TypeError: alertPrefsView is not a function`. The existing `syncMeta`/`shouldSkipTick` blocks stay green.

- [ ] **Step 3: Add `alertPrefsView` to `public/swr.js`.** Insert after the `paceLine` function (after line 87), before the `if (typeof window !== 'undefined')` export:

```javascript
  // ── Alert prefs display mapping (sub-project B) ─────────────────────────
  // Pure: the /api/config `alerts` block → the Settings checkbox view model.
  // Defaults everything ON when the block is absent/garbage (mirrors the
  // server's all-on default). `disabled` flags the per-type checkboxes as
  // non-interactive while the master toggle is off (they still reflect their
  // stored values so flipping master back on restores the visual state).
  function alertPrefsView(alerts) {
    const block = alerts && typeof alerts === 'object' ? alerts : {};
    const types = block.types && typeof block.types === 'object' ? block.types : {};
    const bool = (v) => (typeof v === 'boolean' ? v : true);
    const enabled = bool(block.alertsEnabled);
    return {
      enabled,
      approaching: bool(types.approaching),
      willHit: bool(types.willHit),
      limitReached: bool(types.limitReached),
      disabled: !enabled,
    };
  }
```

  Then extend the export object. Replace line 90 (`window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine };`) with:

```javascript
    window.ClaugeDashSwr = { syncMeta, shouldSkipTick, projectionLine, wowLine, paceLine, alertPrefsView };
```

- [ ] **Step 4: Run and confirm the `alertPrefsView` tests PASS.** Command: `node --test test/dashboard-swr.test.js`. Expected: all green (existing + new). Note `public/swr.js` is loaded by the dashboard as a classic browser script BEFORE `app.js` (no SEA manifest change — it is an existing served asset).

- [ ] **Step 5: Add the Alerts markup to `public/index.html`.** Insert these rows inside the `data-set-panel="pricing"` section, immediately after the `API rate source` row's closing `</div>` (after line 436), before the section's closing `</div>` (line 437). The master toggle reuses the existing `.toggle-wrap`/`.toggle-slider` style (the "Launch at login" row, lines 388–391); the three per-type checkboxes are plain checkboxes grouped under a sub-label:

```html
          <div class="set-row">
            <div>
              <div class="set-label">Desktop alerts</div>
              <div class="set-help">Get a notification when a usage limit is near, on pace to run out, or reached. Fires even with no window open.</div>
              <div class="set-help mono" id="set-alerts-status"></div>
            </div>
            <label class="toggle-wrap">
              <input type="checkbox" id="set-alerts-enabled">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="set-row" id="set-alerts-types-row">
            <div>
              <div class="set-label">Which alerts</div>
              <div class="set-help">Choose which events notify you.</div>
            </div>
            <div class="set-alerts-types">
              <label class="set-alert-type"><input type="checkbox" id="set-alert-approaching"> Approaching a limit (80% / 95%)</label>
              <label class="set-alert-type"><input type="checkbox" id="set-alert-willhit"> On pace to run out</label>
              <label class="set-alert-type"><input type="checkbox" id="set-alert-limitreached"> Limit reached (100%)</label>
            </div>
          </div>
```

  > NOTE for the implementer: add minimal CSS for `.set-alerts-types` (vertical stack) and `.set-alert-type` (row with gap) to the dashboard stylesheet if those class names aren't already styled — grep the served CSS (`public/*.css`) for `.set-row`/`.toggle-wrap` to find the file and match its conventions. Keep it a simple flex column; no new design tokens needed.

- [ ] **Step 6: Wire `initAlertControls()` in `public/app.js`.** First call it from `renderSettings()` — add the call beside `initSubCostControl();` (line 983). Replace lines 983–984:

```javascript
  initSubCostControl();
  initAlertControls();
  initSettingsGeneralControls();
```

  Then add the `initAlertControls` function immediately after `initSubCostControl` (after line 1037). It fetches `/api/config`, applies `alertPrefsView`, sets the four checkboxes, and wires change handlers that POST `/api/config/alerts` and re-apply the returned effective prefs (so the master toggle disables/enables the per-type boxes live). Same init-once + transient-status pattern as `initSubCostControl`:

```javascript
// Sub-project B: desktop-alert prefs are editable from Settings. On load,
// GET /api/config and paint the master toggle + 3 per-type checkboxes via the
// pure ClaugeDashSwr.alertPrefsView mapping. On change, POST /api/config/alerts
// and re-apply the effective prefs the server returns (so flipping the master
// toggle live-greys the per-type boxes). USER-ACTION path, not the 60s auto-
// refresh path. Plain fetch (same-origin, must work in browser mode too).
let __alertsInitialized = false;
const ALERTS_STATUS_CLEAR_MS = 4000;
function initAlertControls() {
  if (__alertsInitialized) return;
  const enabledEl = document.getElementById('set-alerts-enabled');
  if (!enabledEl) return;
  __alertsInitialized = true;

  const approachingEl = document.getElementById('set-alert-approaching');
  const willHitEl = document.getElementById('set-alert-willhit');
  const limitReachedEl = document.getElementById('set-alert-limitreached');
  const status = document.getElementById('set-alerts-status');
  let statusTimer = null;
  const showStatus = (text) => {
    if (!status) return;
    status.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.textContent = ''; }, ALERTS_STATUS_CLEAR_MS);
  };

  const view = (window.ClaugeDashSwr && window.ClaugeDashSwr.alertPrefsView) || ((a) => a);
  const paint = (alerts) => {
    const v = view(alerts);
    enabledEl.checked = v.enabled;
    approachingEl.checked = v.approaching;
    willHitEl.checked = v.willHit;
    limitReachedEl.checked = v.limitReached;
    for (const el of [approachingEl, willHitEl, limitReachedEl]) el.disabled = v.disabled;
  };

  const post = async (partial) => {
    try {
      const res = await fetch('/api/config/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial),
      });
      if (!res.ok) throw new Error(`POST /api/config/alerts → ${res.status}`);
      paint(await res.json());
      showStatus('Saved');
    } catch (err) {
      console.error('alert prefs save failed:', err);
      showStatus('Save failed — not stored');
    }
  };

  enabledEl.addEventListener('change', () => post({ enabled: enabledEl.checked }));
  approachingEl.addEventListener('change', () => post({ types: { approaching: approachingEl.checked } }));
  willHitEl.addEventListener('change', () => post({ types: { willHit: willHitEl.checked } }));
  limitReachedEl.addEventListener('change', () => post({ types: { limitReached: limitReachedEl.checked } }));

  // Initial load: GET /api/config for the current alerts block, then paint.
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg && cfg.alerts) paint(cfg.alerts); })
    .catch((err) => console.error('alert prefs load failed:', err));
}
```

  > NOTE for the implementer: `renderSettings()` runs on every 60s tick while the Settings tab is open (line 1376), but `initAlertControls` is init-once-guarded by `__alertsInitialized`, so the change-listeners are wired exactly once and the 60s tick is a no-op for this control — matching `initSubCostControl`'s `__subCostInitialized` guard. The control reads its truth from `/api/config` once on init, so a stale `state.data` never clobbers a mid-session toggle. This deliberately does NOT touch the auto-refresh surgical-render path (landmine #22) — these checkboxes are user-action elements, never rewritten by a tick.

- [ ] **Step 7: Run the JS suite + validators.** Command: `node --test test/dashboard-swr.test.js` (green), then `npm run check:validators` (expected: `validate-no-console-log`, `validate-copy-registry`, `validate-html-facade-loads` all pass — the dashboard uses `console.error` not `console.log` in the new code; copy-registry scans `popover/` only so the inline English strings are out of scope; no new facade introduced). Then `npm test` for the full JS suite.

- [ ] **Step 8: Manual smoke (webview wiring — no E2E on macOS, landmine #9).** Per the house rule, the Settings UI is verified by a manual smoke, not Tauri E2E. Document the smoke in the commit/PR body: with the app running (`pkill -f clauge && npm run build:sidecar && npm run tauri:dev` — note the served `public/` assets are embedded in the SEA, so a rebuild is required for the HTML/JS/swr changes to appear, per AGENTS.md "cargo tauri dev does NOT re-run the sidecar build"), open Settings → Plan & ROI: (1) the master "Desktop alerts" toggle + 3 checkboxes reflect the persisted `/api/config` alerts block on load; (2) flipping the master OFF greys the 3 per-type boxes and shows "Saved"; (3) toggling one type OFF persists across a tab switch and a full app restart (read back from `~/.clauge/config.json`); (4) `subscriptionCost` in the same file is unchanged after an alert toggle (read-merge-write proof). Capture a screenshot for the PR.

- [ ] **Step 9: Commit.** `git add public/index.html public/swr.js public/app.js test/dashboard-swr.test.js` then:

```
git commit -m "feat(dashboard): Alerts section in Settings

Master 'Desktop alerts' toggle + 3 per-type checkboxes (approaching,
will-hit, limit-reached) in Settings → Plan & ROI. Reads /api/config alerts
on load, POSTs /api/config/alerts on change, inline status. Pure mapping
helper ClaugeDashSwr.alertPrefsView (vm-tested). No new served file."
```

- [ ] **Step 10: Run the full gate before opening the PR.** Command: `npm run check` (the canonical CI gate — validators + cargo fmt + clippy -D warnings + cargo test + npm test). Expected: all green. Only after this passes, open the PR for `feat/alerts-wiring`. Per the "run the full check command verbatim before claiming green" learning, do NOT substitute "the validators passed" for the full gate.
## PR 3 — `feat/alerts-rust` (branch from `main` after PR 2 merges)

> Rust side of Sub-Project B: the cross-platform notification firer + the macOS tray ⚠ cue and "Alerts" toggle. PR 2 (the JS engine + `/api/alerts/pending` + `/api/alerts/ack` + `/api/config/alerts`) is assumed merged — these tasks consume those endpoints over loopback HTTP via `LOCAL_CLIENT`. No new IPC commands (landmine #1 does not apply: the Rust↔sidecar contract here is HTTP, not `#[tauri::command]`). No new dependencies: `tauri-plugin-notification` is already a dep and already used at `src-tauri/src/ipc.rs:300-327`; `serde_json` and `reqwest` (with the `json` feature) are already deps.

---

### Task 6: Cross-platform alert poller/firer (`src-tauri/src/alerts.rs`)

**Files**
- **Create:** `src-tauri/src/alerts.rs`
- **Modify:** `src-tauri/src/lib.rs`
  - module declarations block (anchor: the `mod ipc;` / `mod native_popover;` cluster at lines 9-14) — add `mod alerts;`
  - `.setup(|app| { ... })` closure (anchor: the `#[cfg(target_os = "macos")]` iCloud-publish sibling-spawn block at lines 362-368) — add the cross-platform `alerts::spawn_alert_poller(...)` call **after** it, NOT gated on macOS
- **Test:** `#[cfg(test)]` module inside `src-tauri/src/alerts.rs` (pure URL-builder + `serde_json` due-list parser; the poller loop itself is manual-smoke per landmine #9)

**Context (verified against live files):**
- The existing 30s tray poller (`native_popover.rs:667-704`) is the template: `tokio::time::interval(Duration::from_secs(30))` + `interval.set_missed_tick_behavior(MissedTickBehavior::Delay)`, server-port resolution via `app_handle.try_state::<crate::ipc::AppState>().and_then(|s| s.server_port.lock().ok().and_then(|g| *g))` (`native_popover.rs:676-679`), loopback GET via `crate::http_client::LOCAL_CLIENT.get(&url).send().await` (`native_popover.rs:681`).
- `AppState.server_port` is `Arc<Mutex<Option<u16>>>` (`ipc.rs:40`).
- The notification firing pattern is `app.notification().builder().title(...).body(...).show()` with `use tauri_plugin_notification::NotificationExt;` in scope (`ipc.rs:242`, `ipc.rs:300-327`); `notification:default` capability is already granted.
- `LOCAL_CLIENT` is a `reqwest::Client` (`http_client.rs:17`) with a 5s default timeout; `reqwest` has the `json` feature (`Cargo.toml:61`), so `.post(url).json(&body).send()` is available. `serde_json` is a dep (`Cargo.toml:57`).

**Steps**

- [ ] **Step 1: Failing test — the pure helpers (`pending_url`, `parse_due`, `parse_retire`) don't exist yet.**
  Create `src-tauri/src/alerts.rs` with ONLY the `#[cfg(test)]` module (the helpers are referenced but not yet defined, so this must fail to compile):

  ```rust
  //! Cross-platform alert poller/firer (Sub-Project B).
  //!
  //! Polls the always-on sidecar's `GET /api/alerts/pending` every 30s, fires
  //! each due alert as an OS notification (`tauri-plugin-notification`, the
  //! `ipc.rs:300` pattern), then `POST /api/alerts/ack`s the attempted ids +
  //! the severity-collapsed `retire` keys so a key fires once per window
  //! instance. NOT macOS-gated — Windows needs notifications too.
  //!
  //! The decision (thresholds + forecast collapse) lives in the sidecar's
  //! `lib/alert-engine.js`; this file is a thin firer. Clock is owned by the
  //! sidecar endpoint (it captures one `Date.now()` per tick); the Rust side
  //! only drives the 30s cadence.

  #[cfg(test)]
  mod tests {
      use super::*;

      #[test]
      fn pending_url_targets_loopback_alerts_pending() {
          assert_eq!(
              pending_url(3456),
              "http://127.0.0.1:3456/api/alerts/pending"
          );
      }

      #[test]
      fn ack_url_targets_loopback_alerts_ack() {
          assert_eq!(ack_url(51123), "http://127.0.0.1:51123/api/alerts/ack");
      }

      #[test]
      fn parse_due_extracts_id_title_body_in_order() {
          let json: serde_json::Value = serde_json::json!({
              "due": [
                  { "id": "approaching:fiveHour:80:2026-06-12T14:20:00+00:00",
                    "type": "approaching", "window": "fiveHour",
                    "title": "Clauge — 5-hour limit at 82%",
                    "body": "You're past 80% of your 5-hour window. Resets ~3:40 PM." },
                  { "id": "limitReached:sevenDay:2026-06-19T00:00:00+00:00",
                    "title": "Clauge — weekly limit reached",
                    "body": "You've hit your weekly limit." }
              ],
              "retire": []
          });
          let due = parse_due(&json);
          assert_eq!(due.len(), 2);
          assert_eq!(due[0].id, "approaching:fiveHour:80:2026-06-12T14:20:00+00:00");
          assert_eq!(due[0].title, "Clauge — 5-hour limit at 82%");
          assert_eq!(due[0].body, "You're past 80% of your 5-hour window. Resets ~3:40 PM.");
          assert_eq!(due[1].id, "limitReached:sevenDay:2026-06-19T00:00:00+00:00");
      }

      #[test]
      fn parse_due_skips_entries_missing_required_fields() {
          // An entry missing `id` (or title/body) is dropped — we never fire a
          // notification we can't ack by id.
          let json: serde_json::Value = serde_json::json!({
              "due": [
                  { "title": "no id", "body": "x" },
                  { "id": "willHit:fiveHour:2026-06-12T14:20:00+00:00",
                    "title": "Clauge — on pace to run out",
                    "body": "At this rate your 5-hour limit runs out before it resets." }
              ],
              "retire": []
          });
          let due = parse_due(&json);
          assert_eq!(due.len(), 1);
          assert_eq!(due[0].id, "willHit:fiveHour:2026-06-12T14:20:00+00:00");
      }

      #[test]
      fn parse_due_empty_or_absent_yields_empty() {
          assert!(parse_due(&serde_json::json!({ "retire": [] })).is_empty());
          assert!(parse_due(&serde_json::json!({ "due": [] })).is_empty());
          assert!(parse_due(&serde_json::json!({})).is_empty());
      }

      #[test]
      fn parse_retire_extracts_string_keys_only() {
          let json: serde_json::Value = serde_json::json!({
              "due": [],
              "retire": [
                  "approaching:fiveHour:95:2026-06-12T14:20:00+00:00",
                  "approaching:fiveHour:80:2026-06-12T14:20:00+00:00",
                  42
              ]
          });
          let retire = parse_retire(&json);
          // The non-string `42` is dropped defensively.
          assert_eq!(
              retire,
              vec![
                  "approaching:fiveHour:95:2026-06-12T14:20:00+00:00".to_string(),
                  "approaching:fiveHour:80:2026-06-12T14:20:00+00:00".to_string(),
              ]
          );
      }

      #[test]
      fn parse_retire_absent_yields_empty() {
          assert!(parse_retire(&serde_json::json!({ "due": [] })).is_empty());
      }
  }
  ```

- [ ] **Step 2: Run the test, verify it FAILS (does not compile).**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml alerts
  ```
  Expected: compile error — `cannot find function pending_url in this scope` (and `ack_url`, `parse_due`, `parse_retire`, plus the unresolved `super::*` `DueAlert` type). This confirms the test references the not-yet-written impl.

- [ ] **Step 3: Minimal implementation — the pure helpers + `DueAlert`.**
  Insert ABOVE the `#[cfg(test)]` module in `src-tauri/src/alerts.rs`:

  ```rust
  /// One alert the sidecar says is due to fire now. Mirrors the JS payload's
  /// `{ id, type, window, title, body }`; the Rust firer only needs id (to ack),
  /// title, and body (to show).
  struct DueAlert {
      id: String,
      title: String,
      body: String,
  }

  /// Loopback URL for the side-effect-free pending read.
  fn pending_url(port: u16) -> String {
      format!("http://127.0.0.1:{port}/api/alerts/pending")
  }

  /// Loopback URL for the fired/retired ack write.
  fn ack_url(port: u16) -> String {
      format!("http://127.0.0.1:{port}/api/alerts/ack")
  }

  /// Parse the `due` array into `DueAlert`s. An entry missing `id`, `title`,
  /// or `body` is dropped — we must never fire a notification we can't ack.
  fn parse_due(json: &serde_json::Value) -> Vec<DueAlert> {
      let Some(arr) = json.get("due").and_then(|d| d.as_array()) else {
          return Vec::new();
      };
      arr.iter()
          .filter_map(|a| {
              let id = a.get("id")?.as_str()?.to_string();
              let title = a.get("title")?.as_str()?.to_string();
              let body = a.get("body")?.as_str()?.to_string();
              Some(DueAlert { id, title, body })
          })
          .collect()
  }

  /// Parse the `retire` array into dedup keys. Non-string entries are dropped.
  fn parse_retire(json: &serde_json::Value) -> Vec<String> {
      let Some(arr) = json.get("retire").and_then(|r| r.as_array()) else {
          return Vec::new();
      };
      arr.iter()
          .filter_map(|v| v.as_str().map(|s| s.to_string()))
          .collect()
  }
  ```

- [ ] **Step 4: Run the test, verify it PASSES.**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml alerts
  ```
  Expected: all 7 tests in `alerts::tests` pass (`pending_url_targets...`, `ack_url_targets...`, `parse_due_extracts...`, `parse_due_skips...`, `parse_due_empty_or_absent...`, `parse_retire_extracts...`, `parse_retire_absent...`). Note: `DueAlert`'s `title`/`body` fields are read only by the not-yet-written `spawn_alert_poller`, so clippy may warn `field is never read` until Step 5 — that is expected at this checkpoint; do not silence it with `#[allow(dead_code)]` (Step 5 removes the warning by using the fields).

- [ ] **Step 5: Implement `spawn_alert_poller` (the manual-smoke loop — no automated test per landmine #9).**
  Insert BELOW the helpers and ABOVE the `#[cfg(test)]` module in `src-tauri/src/alerts.rs`:

  ```rust
  /// Spawn the always-on alert poller. Every 30s: GET `/api/alerts/pending`,
  /// fire each due alert as an OS notification, then POST `/api/alerts/ack`
  /// with the ids it ATTEMPTED (fired OR errored — a permission-denied
  /// notification must not retry-spam every 30s) plus the severity-collapsed
  /// `retire` keys. A tick with empty `due` AND empty `retire` skips the ack.
  ///
  /// Cross-platform: Windows needs notifications too, so this is NOT
  /// `#[cfg(target_os = "macos")]`. The mutation (marking fired) lives entirely
  /// in the ack POST, so a crash before firing re-fires next tick
  /// (at-least-once for real notifications).
  pub fn spawn_alert_poller(app: tauri::AppHandle) {
      use tauri::Manager;
      use tauri_plugin_notification::NotificationExt;

      tauri::async_runtime::spawn(async move {
          let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
          interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
          loop {
              interval.tick().await;

              // Server-port resolution mirrors native_popover.rs:676-679.
              let port = app
                  .try_state::<crate::ipc::AppState>()
                  .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
              let Some(port) = port else { continue };

              // 1. Pending read (side-effect-free on the sidecar).
              let json = match crate::http_client::LOCAL_CLIENT
                  .get(pending_url(port))
                  .send()
                  .await
              {
                  Ok(resp) => match resp.json::<serde_json::Value>().await {
                      Ok(json) => json,
                      Err(e) => {
                          log::warn!("alerts: pending json parse failed: {e}");
                          continue;
                      }
                  },
                  Err(e) => {
                      log::warn!("alerts: pending fetch failed: {e}");
                      continue;
                  }
              };

              let due = parse_due(&json);
              let retire = parse_retire(&json);

              // 2. Fire each due alert; collect the ids ATTEMPTED (fired or
              //    errored). A failed show() is still acked so it can't
              //    retry-spam every 30s.
              let mut attempted: Vec<String> = Vec::with_capacity(due.len());
              for alert in &due {
                  if let Err(e) = app
                      .notification()
                      .builder()
                      .title(&alert.title)
                      .body(&alert.body)
                      .show()
                  {
                      log::warn!("alerts: notification show() failed for {}: {e}", alert.id);
                  }
                  attempted.push(alert.id.clone());
              }

              // 3. Ack. Skip entirely if nothing was due and nothing retired.
              if attempted.is_empty() && retire.is_empty() {
                  continue;
              }
              let ack_body = serde_json::json!({ "fired": attempted, "retired": retire });
              match crate::http_client::LOCAL_CLIENT
                  .post(ack_url(port))
                  .json(&ack_body)
                  .send()
                  .await
              {
                  Ok(resp) if resp.status().is_success() => {}
                  Ok(resp) => {
                      log::warn!("alerts: ack POST returned status {}", resp.status());
                  }
                  Err(e) => {
                      log::warn!("alerts: ack POST failed: {e}");
                  }
              }
          }
      });
  }
  ```

- [ ] **Step 6: Register the module + spawn the poller in `lib.rs` (NOT macOS-gated).**
  In `src-tauri/src/lib.rs`, in the module-declaration cluster (anchor: the `mod ipc;` line, currently line 10), add the module declaration in alphabetical position (immediately after `pub mod connections;` at line 8 / before `mod http_client;` at line 9):

  ```rust
  mod alerts;
  ```

  Then in the `.setup(|app| { ... })` closure, AFTER the macOS-gated iCloud-publish sibling-spawn block (anchor: lines 362-368, the block ending with the closing `}` of `#[cfg(target_os = "macos")] { let publish_handle = ...; }`) and BEFORE the `#[cfg(not(feature = "mas"))]` updater block at line 375, add:

  ```rust
              // Sub-Project B: always-on alert poller/firer. Cross-platform —
              // Windows gets every notification too (only the tray cue + toggle
              // are Mac-first). Sibling spawn beside the iCloud publish loop;
              // NOT macOS-gated, NOT inside the sidecar supervisor.
              {
                  let alert_handle = app.handle().clone();
                  crate::alerts::spawn_alert_poller(alert_handle);
              }
  ```

- [ ] **Step 7: Verify the full build + tests + lint are clean.**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml alerts
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  ```
  Expected: alerts tests pass; clippy emits no warnings (the `DueAlert` `title`/`body` fields are now read by `spawn_alert_poller`, so the Step-4 dead-field warning is gone); fmt reports no diff.

- [ ] **Step 8: Commit.**
  ```bash
  git add src-tauri/src/alerts.rs src-tauri/src/lib.rs
  git commit -m "feat(alerts): cross-platform alert poller/firer (Sub-Project B)

Polls GET /api/alerts/pending every 30s, fires each due alert via
tauri-plugin-notification, then POSTs /api/alerts/ack with the attempted
ids + severity-collapsed retire keys. Not macOS-gated — Windows fires
notifications too. Pure URL-builder + due/retire parsers unit-tested; the
poll loop is manual-smoke per landmine #9."
  ```

---

### Task 7: macOS tray ⚠ cue + "Alerts: On/Off" NSMenu toggle (`src-tauri/src/native_popover.rs`)

**Files**
- **Modify:** `src-tauri/src/native_popover.rs`
  - imports cluster (anchor: line 26, `use objc2_app_kit::{NSMenu, NSMenuItem, NSPopover, NSStatusItem};`) — add the control-state statics
  - `spawn_tray_title_poller` (anchor: lines 667-704) — fetch `sevenDay.pct` too and prefix the title at line 699
  - `ClaugeMenuTarget` `define_class!` impl block (anchor: lines 267-301) — add the `menuToggleAlerts:` action method
  - `build_menu` (anchor: lines 305-353) — add the "Alerts: On/Off" item with a checkmark reflecting `alerts.enabled`
- **Test:** `#[cfg(test)]` module inside `src-tauri/src/native_popover.rs` for the pure `tray_warning_prefix` helper (the precedent is `sync_health.rs`'s pure unit tests; the poller + NSMenu action are manual-smoke per landmine #9)

**Context (verified against live files):**
- The poller currently reads only `plan.fiveHour.pct` (`native_popover.rs:684-687`) and builds the title at `native_popover.rs:699` as `format!(" {}%", pct.round() as i64)` — **the leading space is load-bearing** (it's the chiclet gap from the status icon). The ⚠ prefix must come BEFORE that space-padded percent.
- The NSMenu is built in `build_menu` (`native_popover.rs:305-353`): a `[(label, selector, key); 3]` array (`Open Dashboard`, `Preferences…`, `Check for Updates`) at lines 316-320, each item `setTarget(Some(target.as_ref()))`, then a separator, then `Quit Clauge`.
- Menu actions are methods on `ClaugeMenuTarget` (`define_class!` at lines 257-302). The async-from-action pattern is `menuCheckUpdates:` (lines 282-293): grab `APP_HANDLE_REF.get()`, clone the `AppHandle`, `tauri::async_runtime::spawn(async move { ... })`. This is the canonical "NSMenu action runs on the main thread → dispatch the async HTTP via `async_runtime::spawn`" pattern to mirror.
- `NSMenuItem::setState(NSControlStateValue)` exists (`objc2-app-kit-0.3.2/src/generated/NSMenuItem.rs:273-275`); `NSControlStateValueOn = 1` / `NSControlStateValueOff = 0` are statics in `objc2_app_kit` (`NSCell.rs:156-159`).
- `LOCAL_CLIENT.post(url).json(&body).send()` is available (same as Task 6). The toggle reads current `alerts.enabled` via `GET /api/config` (which PR 2's endpoint extends to report `alerts`) and writes via `POST /api/config/alerts { enabled: !current }`.

**Steps**

- [ ] **Step 1: Failing test — `tray_warning_prefix` doesn't exist yet.**
  Add a `#[cfg(test)]` module at the END of `src-tauri/src/native_popover.rs` (after the final `#[cfg(not(target_os = "macos"))]` stub region). Gate it on macOS since the helper is macOS-only:

  ```rust
  #[cfg(all(test, target_os = "macos"))]
  mod tests {
      use super::*;

      #[test]
      fn warning_prefix_empty_when_both_below_80() {
          assert_eq!(tray_warning_prefix(Some(79.0), Some(50.0)), "");
      }

      #[test]
      fn warning_prefix_set_when_five_hour_at_or_past_80() {
          assert_eq!(tray_warning_prefix(Some(80.0), Some(10.0)), "\u{26a0} ");
          assert_eq!(tray_warning_prefix(Some(95.0), None), "\u{26a0} ");
          assert_eq!(tray_warning_prefix(Some(100.0), Some(0.0)), "\u{26a0} ");
      }

      #[test]
      fn warning_prefix_set_when_seven_day_at_or_past_80() {
          assert_eq!(tray_warning_prefix(Some(10.0), Some(80.0)), "\u{26a0} ");
          assert_eq!(tray_warning_prefix(None, Some(99.0)), "\u{26a0} ");
      }

      #[test]
      fn warning_prefix_empty_when_both_none() {
          assert_eq!(tray_warning_prefix(None, None), "");
      }

      #[test]
      fn warning_prefix_empty_just_below_threshold() {
          // 79.99 is below 80 — no cue. The boundary is inclusive at 80.0.
          assert_eq!(tray_warning_prefix(Some(79.99), Some(79.99)), "");
      }
  }
  ```

- [ ] **Step 2: Run the test, verify it FAILS (does not compile).**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml tray_warning
  ```
  Expected: compile error — `cannot find function tray_warning_prefix in this scope`. Confirms the test references the not-yet-written pure helper.

- [ ] **Step 3: Minimal implementation — the pure `tray_warning_prefix` helper.**
  Insert ABOVE `spawn_tray_title_poller` (immediately before line 663's doc comment) in `src-tauri/src/native_popover.rs`:

  ```rust
  /// The 80% "approaching" threshold for the menu-bar ⚠ cue. Mirrors
  /// `APPROACHING_LEVELS` (the 80 floor) in `lib/alert-engine.js`.
  #[cfg(target_os = "macos")]
  const TRAY_WARN_PCT: f64 = 80.0;

  /// Pure: returns the warning-glyph prefix (`"⚠ "`) when EITHER watched
  /// window is at or past 80%, else `""`. `None` (window absent / no data) is
  /// treated as below-threshold. Unit-tested; the poller that calls it is
  /// manual-smoke (landmine #9).
  #[cfg(target_os = "macos")]
  fn tray_warning_prefix(five_pct: Option<f64>, seven_pct: Option<f64>) -> &'static str {
      let hot = |p: Option<f64>| p.map(|v| v >= TRAY_WARN_PCT).unwrap_or(false);
      if hot(five_pct) || hot(seven_pct) {
          "\u{26a0} " // ⚠ + a single trailing space before the percent chiclet
      } else {
          ""
      }
  }
  ```

- [ ] **Step 4: Run the test, verify it PASSES.**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml tray_warning
  ```
  Expected: all 5 tests in `tests` pass (`warning_prefix_empty_when_both_below_80`, `warning_prefix_set_when_five_hour...`, `warning_prefix_set_when_seven_day...`, `warning_prefix_empty_when_both_none`, `warning_prefix_empty_just_below_threshold`).

- [ ] **Step 5: Wire the ⚠ prefix into the poller (read `sevenDay.pct` too, preserve the leading-space convention).**
  In `spawn_tray_title_poller`, replace the single-window fetch + title build (anchor: lines 681-701, from `let pct = match crate::http_client::LOCAL_CLIENT.get(&url).send().await {` through the `if let Some(pct) = pct { ... }` block) with a two-window read. Replace this block:

  ```rust
          let pct = match crate::http_client::LOCAL_CLIENT.get(&url).send().await {
              Ok(resp) => match resp.json::<serde_json::Value>().await {
                  Ok(json) => json
                      .get("plan")
                      .and_then(|p| p.get("fiveHour"))
                      .and_then(|f| f.get("pct"))
                      .and_then(|p| p.as_f64()),
                  Err(e) => {
                      log::debug!("usage json parse failed: {}", e);
                      None
                  }
              },
              Err(e) => {
                  log::debug!("usage fetch failed: {}", e);
                  None
              }
          };
          if let Some(pct) = pct {
              let title = format!(" {}%", pct.round() as i64);
              update_tray_title(&app_handle, title);
          }
  ```

  with:

  ```rust
          let plan = match crate::http_client::LOCAL_CLIENT.get(&url).send().await {
              Ok(resp) => match resp.json::<serde_json::Value>().await {
                  Ok(json) => json.get("plan").cloned(),
                  Err(e) => {
                      log::debug!("usage json parse failed: {}", e);
                      None
                  }
              },
              Err(e) => {
                  log::debug!("usage fetch failed: {}", e);
                  None
              }
          };
          let window_pct = |plan: &serde_json::Value, window: &str| {
              plan.get(window)
                  .and_then(|w| w.get("pct"))
                  .and_then(|p| p.as_f64())
          };
          if let Some(plan) = plan {
              let five_pct = window_pct(&plan, "fiveHour");
              let seven_pct = window_pct(&plan, "sevenDay");
              if let Some(pct) = five_pct {
                  // PRESERVE the leading-space chiclet gap; the ⚠ prefix (if any)
                  // sits BEFORE the space-padded percent.
                  let prefix = tray_warning_prefix(five_pct, seven_pct);
                  let title = format!("{} {}%", prefix.trim_end(), pct.round() as i64);
                  update_tray_title(&app_handle, title);
              }
          }
  ```

  > Note: `format!("{} {}%", prefix.trim_end(), pct)` yields `"⚠ 82%"` when hot (prefix `"⚠ "` → trimmed `"⚠"` + the existing single space + `82%`) and `" 82%"` when not (prefix `""` → `"" + " " + 82%`), preserving the exact pre-existing `" {pct}%"` leading-space shape when no warning. The `tray_warning_prefix` trailing space exists for the helper's standalone semantics; the `trim_end()` here re-uses the poller's own single space rather than double-spacing.

- [ ] **Step 6: Add the `menuToggleAlerts:` action to `ClaugeMenuTarget`.**
  In the `define_class!` block, inside `impl ClaugeMenuTarget`, add a new method AFTER `menu_check_updates` (anchor: line 293, before `menuQuit:` at line 295). It mirrors the `menuCheckUpdates:` async-from-action pattern but does a GET-then-POST flip + refreshes the checkmark:

  ```rust
          #[unsafe(method(menuToggleAlerts:))]
          fn menu_toggle_alerts(&self, sender: &NSMenuItem) {
              let Some(app) = APP_HANDLE_REF.get() else {
                  return;
              };
              let app = app.clone();
              // Optimistic local checkmark flip: read the current state, toggle,
              // then reconcile from the server response below.
              let current_on = sender.state() == objc2_app_kit::NSControlStateValueOn;
              let next = !current_on;
              tauri::async_runtime::spawn(async move {
                  use tauri::Manager;
                  let port = app
                      .try_state::<crate::ipc::AppState>()
                      .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
                  let Some(port) = port else {
                      log::warn!("alerts toggle: no server port yet");
                      return;
                  };
                  let url = format!("http://127.0.0.1:{port}/api/config/alerts");
                  let body = serde_json::json!({ "enabled": next });
                  let enabled = match crate::http_client::LOCAL_CLIENT
                      .post(&url)
                      .json(&body)
                      .send()
                      .await
                  {
                      Ok(resp) => match resp.json::<serde_json::Value>().await {
                          Ok(json) => json
                              .get("alertsEnabled")
                              .and_then(|v| v.as_bool())
                              .unwrap_or(next),
                          Err(e) => {
                              log::warn!("alerts toggle: response parse failed: {e}");
                              next
                          }
                      },
                      Err(e) => {
                          log::warn!("alerts toggle: POST failed: {e}");
                          return; // leave the checkmark as-is; server unchanged
                      }
                  };
                  set_alerts_menu_checkmark(&app, enabled);
              });
          }
  ```

  > `POST /api/config/alerts` returns the effective prefs `{ alertsEnabled, types }` (PR 2's contract), so `alertsEnabled` is the authoritative new state to paint.

- [ ] **Step 7: Add the menu item in `build_menu` + the checkmark setter, and seed the initial state.**
  In `build_menu`, AFTER the 3-item loop and BEFORE the `separatorItem` (anchor: between line 334's `}` closing the `for` loop and line 336's `let separator = ...`), add the "Alerts" item (it defaults to checked since prefs default all-on; a poll below reconciles it to the real value):

  ```rust
      // "Alerts: On/Off" toggle. Checkmark reflects alerts.enabled; the action
      // POSTs /api/config/alerts { enabled: !current }. Starts checked (prefs
      // default all-on); seed_alerts_menu_state() reconciles to the real value.
      let alerts_title = NSString::from_str("Alerts");
      let empty_key = NSString::from_str("");
      let alerts_item = unsafe {
          NSMenuItem::initWithTitle_action_keyEquivalent(
              mtm.alloc::<NSMenuItem>(),
              &alerts_title,
              Some(objc2::sel!(menuToggleAlerts:)),
              &empty_key,
          )
      };
      unsafe {
          alerts_item.setTarget(Some(target.as_ref()));
          alerts_item.setState(objc2_app_kit::NSControlStateValueOn);
      }
      menu.addItem(&alerts_item);
  ```

  Then add the checkmark setter + a one-shot state seeder as free functions AFTER `build_menu` (anchor: after line 353's closing `}` of `build_menu`):

  ```rust
  /// Set the "Alerts" menu item checkmark. The NSMenuItem is the FIRST item
  /// whose action selector is `menuToggleAlerts:` — re-resolved each call from
  /// MENU_REF so we never store a raw item pointer. Main-thread-only (NSMenu
  /// mutation), so hopped via `run_on_main_thread`.
  #[cfg(target_os = "macos")]
  fn set_alerts_menu_checkmark(app: &tauri::AppHandle, enabled: bool) {
      let _ = app.run_on_main_thread(move || {
          use objc2::MainThreadMarker;
          if MainThreadMarker::new().is_none() {
              return;
          }
          let Some(menu) = MENU_REF
              .get()
              .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
          else {
              return;
          };
          let count = unsafe { menu.numberOfItems() };
          let toggle_sel = objc2::sel!(menuToggleAlerts:);
          for i in 0..count {
              let Some(item) = (unsafe { menu.itemAtIndex(i) }) else {
                  continue;
              };
              if unsafe { item.action() } == Some(toggle_sel) {
                  let state = if enabled {
                      objc2_app_kit::NSControlStateValueOn
                  } else {
                      objc2_app_kit::NSControlStateValueOff
                  };
                  unsafe { item.setState(state) };
                  break;
              }
          }
      });
  }

  /// One-shot reconcile of the Alerts checkmark to the real `alerts.enabled`
  /// after the sidecar binds its port. Spawned from `init` beside the title
  /// poller; retries until the port is known, reads GET /api/config once, sets
  /// the checkmark, and exits.
  #[cfg(target_os = "macos")]
  fn seed_alerts_menu_state(app: tauri::AppHandle) {
      use tauri::Manager;
      tauri::async_runtime::spawn(async move {
          let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
          interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
          loop {
              interval.tick().await;
              let port = app
                  .try_state::<crate::ipc::AppState>()
                  .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
              let Some(port) = port else { continue };
              let url = format!("http://127.0.0.1:{port}/api/config");
              match crate::http_client::LOCAL_CLIENT.get(&url).send().await {
                  Ok(resp) => {
                      if let Ok(json) = resp.json::<serde_json::Value>().await {
                          let enabled = json
                              .get("alerts")
                              .and_then(|a| a.get("enabled"))
                              .and_then(|v| v.as_bool())
                              .unwrap_or(true);
                          set_alerts_menu_checkmark(&app, enabled);
                      }
                      return; // one-shot: succeeded (or got a parseable response)
                  }
                  Err(e) => {
                      log::debug!("alerts seed: config fetch failed: {e}");
                      // keep retrying until the sidecar answers
                  }
              }
          }
      });
  }
  ```

  Finally, kick off the seeder from `init` next to the existing `spawn_tray_title_poller(app.clone());` call (anchor: line 658). Add immediately after it:

  ```rust
      seed_alerts_menu_state(app.clone());
  ```

  > Confirm during implementation that `NSMenu::numberOfItems`, `NSMenu::itemAtIndex`, and `NSMenuItem::action` are exposed by the pinned `objc2-app-kit 0.3.2`; the generated `NSMenuItem.rs` already exposes `setState`/`action`. If `itemAtIndex`/`numberOfItems` are not surfaced, fall back to storing the alerts `NSMenuItem` in a `static ALERTS_ITEM_REF: OnceLock<Mutex<Option<MainThreadCell<NSMenuItem>>>>` set in `build_menu` (mirroring `MENU_REF` at line 100) and read it in `set_alerts_menu_checkmark` — same `MainThreadCell` storage discipline.

- [ ] **Step 8: Add the control-state import.**
  At the imports cluster, the `objc2_app_kit::NSControlStateValueOn` / `...Off` statics are referenced via fully-qualified paths above, so no new `use` is strictly required. Confirm by checking line 26's `use objc2_app_kit::{NSMenu, NSMenuItem, NSPopover, NSStatusItem};` still compiles. (No edit needed unless clippy prefers a `use` — keep fully-qualified to match the file's `objc2_app_kit::NSControlStateValue` usage at line 544's sibling `NSVisualEffectState::Active` style which is fully-qualified.)

- [ ] **Step 9: Verify build + tests + lint are clean.**
  ```bash
  cargo test --manifest-path src-tauri/Cargo.toml native_popover
  cargo test --manifest-path src-tauri/Cargo.toml tray_warning
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  cargo fmt --manifest-path src-tauri/Cargo.toml --check
  ```
  Expected: the `tray_warning_prefix` tests pass; clippy emits no warnings (all new fns are `#[cfg(target_os = "macos")]` and reachable on macOS, so no dead-code warnings; on a Windows compile they're cfg'd out cleanly — and `tray_warning_prefix`/`TRAY_WARN_PCT`/the seeder/setter are all macOS-gated so no Windows unused-fn warning per landmine #17); fmt reports no diff.

- [ ] **Step 10: Commit.**
  ```bash
  git add src-tauri/src/native_popover.rs
  git commit -m "feat(alerts): macOS tray warning cue + Alerts on/off NSMenu toggle

Title poller now reads sevenDay.pct too and prefixes the chiclet with a
warning glyph when either watched window is past 80% (pure
tray_warning_prefix, unit-tested). New NSMenu item Alerts flips
alerts.enabled via POST /api/config/alerts and reflects current state via
a checkmark seeded from GET /api/config. macOS-only; Windows tray cue +
toggle are a tracked follow-up (notifications already fire on Windows)."
  ```

> **Windows tray = explicit out-of-scope (per spec §"Out of scope" and §5):** the ⚠ cue and the "Alerts: On/Off" toggle ship macOS-first. Windows still receives every notification via the cross-platform `spawn_alert_poller` (Task 6) — only the tray-surface affordances (which on macOS use NSStatusItem/NSMenu/objc2) are deferred. Do NOT attempt a Windows system-tray equivalent in this PR; it is a tracked follow-up.

---

## Final verification (after PR 3 merges)

- [ ] **Full gate on main:** `npm run build:sidecar && npm run check` → validators + cargo fmt/clippy/test + npm test all PASS.
- [ ] **SEA smoke:** `npm run test:sea` → packaged sidecar serves all assets (no new served files expected — dashboard edits ride `public/app.js`).
- [ ] **Manual smoke (Mac):** `npm run build:sidecar`, launch the app. Induce a watched window to 80% → "approaching" notification; to 95% → notification; force a will-hit window → notification; hit 100% → "limit reached". Toggle the master Alerts switch off (dashboard or tray) → silence. Confirm the ⚠ appears on the menu-bar title when a watched window is ≥80% and clears below. Toggle via the NSMenu item → persists (dashboard checkbox reflects it after refresh) and the checkmark is honest on next launch.
- [ ] **Dedup/anti-spam smoke:** stay over a threshold across multiple 30s ticks → the notification fires ONCE per window-instance (not every tick); a will-hit followed by crossing 95% does NOT produce a later lower-severity ping.
- [ ] **Windows smoke pass** (spec requirement; notifications only — tray cue/toggle are Mac-first): the three notifications fire on Windows.
- [ ] **No release/tag in this plan** — B accumulates on main alongside A; Adnan picks the release point.
