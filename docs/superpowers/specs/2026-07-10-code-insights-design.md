# Code Insights — richer Claude Code analytics + a reflection view — Design

**Date:** 2026-07-10
**Status:** Approved in brainstorm (Adnan, 2026-07-10). Build deferred to a separate session (see handoff `docs/superpowers/handoffs/2026-07-10-code-insights-handoff.md`).
**Scope:** Desktop-first (Mac + Windows dashboard + Mac snapshot publish). iOS surfacing is **Phase 4**, a separate `clauge-ios` release.

---

## Why this exists

Anthropic ships two analytics surfaces Adnan wanted mirrored in Clauge: the **Claude Code usage analytics** dashboard and the new **Reflect** dashboard (launched 2026-07-09). Research on both (this session) established what is *reachable* from Clauge's data and what is not — the honest constraint that shapes the whole feature.

**Two hard realities:**
1. **Claude Code usage analytics is org-only** — Anthropic's docs state it is "not available to individual Pro or Max plans." It's a Team/Enterprise/Console dashboard (active *users*, per-*member* lines, GitHub-connected PRs), and its data lives server-side, multi-user. Clauge cannot read it. But its **single-user-relevant metrics** can be reconstructed from local Claude Code logs.
2. **Reflect is about chat, from server-side memory** — it visualizes topics, usage patterns, task types, and (soon) time-spent, drawn from Claude's server-side memory across *all* of Claude, plus proprietary layers (the "4D Fluency" framework, LLM-generated reflective prompts). Clauge sees only local Claude Code `~/.claude` logs — no chat memory, no LLM. Most of Reflect is not reconstructable; the **time/task/pattern** slice is.

**What Clauge already has** (do not rebuild): sessions, tokens, cost, per-model, daily, hours, tools/shell/MCP, activity heatmap, streaks, ROI, projection. This feature adds only the *genuinely new, locally-derivable* metrics on top.

## What this ships

A new **Code Insights** area in the desktop dashboard with two sections:

- **Code Output** — how much you produced and how long it took:
  - **Lines written** (added / removed / net) from `Edit` / `Write` / `MultiEdit` tool calls in the session logs. An honest local analogue of Anthropic's "lines accepted" (Clauge measures *lines Claude wrote via tools*, not IDE-acceptance — labeled as such, never as "accepted").
  - **Time spent in Claude Code** — session active duration (already computed as `durationMs`), aggregated per day/project/period.
  - **Cost-per-commit / lines committed / commits-during-sessions** (Phase 2, opt-in) — from a read-only git correlation.
- **How you use Claude Code** (the Reflect-style layer, heuristic + local, no LLM):
  - **Task mix over time** — the existing task classifier, bucketed by period.
  - **When you work** — time-of-day pattern (existing `rollupByHour`), as a rhythm view.
  - **Historical lookback** — 1 / 3 / 6 / 12-month windows on the above (extends the period selector).
  - **Time-spent trend** — duration aggregated over the lookback window.

Both sections' data is also published into the Mac→iPhone snapshot as **additive optional keys**, so Phase 4 (iOS) can surface them without a schema bump.

### Decisions locked in the brainstorm

| Fork | Decision |
|---|---|
| Direction | **Both** the Code-Analytics parity layer AND the Reflect-style reflection layer. |
| Reflection engine | **Heuristic + local only.** No LLM calls, no API key, no topic-mining of prompt text, no "4D Fluency." Computed metrics, not inferred insights. |
| Git access | **Read-only git allowed** (Adnan approved). Unlocks the "Value" metrics. Opt-in, feature-flagged; Clauge never writes git. |
| Wellbeing nudges | **Deferred.** Visualization only for now; break-reminders / quiet-hours are a later phase (reuse the alert infra). |
| iOS | **Desktop-first.** Mac publishes new metrics as optional snapshot keys (cheap, safe); iOS display is Phase 4, a separate App Store release. |
| Commit attribution | **Correlation, not per-line attribution** (YAGNI). "Commits made during Claude Code sessions in this repo/window," never "these N lines were Claude's." |

## Feasibility map (authoritative)

| Dashboard metric | Status in Clauge | This feature |
|---|---|---|
| Sessions, tokens, cost, models, daily, tools, heatmap, streaks, ROI, hours | ✅ already has | — reuse |
| **Lines written** (add/remove/net) | ❌ | ✅ Phase 1 — new `lib/code-output.js`, parse-time |
| **Time spent** | ~ (`durationMs` exists per session, unsurfaced) | ✅ Phase 1 — aggregate + display |
| **Top commands** | ~ (tools/shell/MCP exist) | reuse existing tool analytics; slash-commands too sparse in logs (11 / 286k lines) to headline |
| **Cost-per-commit, lines committed, commits/session** | ❌ | ✅ Phase 2 — `lib/git-value.js`, read-only git, opt-in |
| **Task mix over time, time-of-day, lookback** | ~ (`classifyAll`, `rollupByHour`, `rollupByTask` exist) | ✅ Phase 3 — `lib/reflection.js` combines them + period extension |
| Suggestion accept-rate, active *users*, per-user lines, PRs merged, 4D Fluency, LLM topics | ❌ | **OUT** — not in local data / needs GitHub / proprietary / needs LLM |

## Architecture

```
sidecar (Node)                                     dashboard (public/)                snapshot → iOS (Phase 4)
  session-store → summarizeSession(turns)            NEW "Code Output" section          optional keys added:
    + NEW lib/code-output.js  (lines written)  ──▶   GET /api/code-output          ──▶    codeOutput
    + durationMs (EXISTS)                                                                  gitValue?  (if enabled)
  NEW lib/git-value.js (read-only git, opt-in) ──▶   NEW "Value" panel                     reflection
    correlate commits↔sessions by repo+window  ──▶   GET /api/git-value
  NEW lib/reflection.js (classifyAll+hour+day) ──▶   NEW "How you use Claude Code"   ──▶  (schemaVersion STAYS 1 —
    task-mix-over-time + rhythm + lookback     ──▶   GET /api/reflection                   additive optional keys only)
```

All new `lib/` modules are **pure** (no I/O except `git-value` which spawns read-only git; clock injected via `nowMs` params — house rule). New routes follow the existing Hono `/api/*` pattern in `server.js`. New dashboard sections follow the existing `public/app.js` render + auto-refresh pattern (surgical updates — landmine #22). Snapshot additions follow `lib/snapshot.js`'s optional-key rule (landmine #37 / #42).

## Components

### `lib/code-output.js` (new, pure) — Phase 1
- `analyzeCodeOutput(turns) → { linesAdded, linesRemoved, linesNet, byTool: {Edit, Write, MultiEdit}, editCount }`
- Walks `turn.contentBlocks` for `tool_use` blocks named `Edit` / `Write` / `MultiEdit` (same walk shape as `tool-analyzer.js:47-51`). Line math:
  - `Write`: `+lineCount(input.content)` added.
  - `Edit`: `+lineCount(input.new_string)` added, `+lineCount(input.old_string)` removed (net = new − old).
  - `MultiEdit`: sum over `input.edits[]` of the Edit rule.
  - `lineCount(s)` = `s ? s.split('\n').length : 0`. Guard non-strings → 0.
- Added to `summarizeSession` (`aggregator.js`) as `session.codeOutput`, cached with the summary (parse-time, one extra pass over the same turns).
- **Verified feasible** (this session): real logs show `Edit` carries `old_string`/`new_string`, `Write` carries `content`.

### `lib/git-value.js` (new) — Phase 2, opt-in
- `correlateCommits({ sessions, nowMs, run }) → { commits, linesCommitted, costPerCommit, byProject, commitsWithSession }`
- For each distinct `project` path (`session.project` → cwd) with sessions in the window: run **read-only** `git -C <cwd> log --numstat --no-merges --since=<earliest> --until=<latest> --format=...` via an injected `run` fn (spawn seam, testable). Correlate commits whose author-time falls inside any session's `[startedAt, endedAt]` window for that repo → "commits during Claude Code sessions." `costPerCommit = sessionCostInWindow / commitCount`.
- **Read-only only** — allowlist git subcommands (`log`, `rev-parse`); never `commit`/`checkout`/anything mutating. Reject if cwd isn't a git repo (graceful skip).
- **Opt-in** via a new config flag `gitValueEnabled` (default false) in `config-store` — off, the route returns `{ enabled: false }` and no git runs.
- Honest correlation: it counts commits in the time window, NOT per-line Claude attribution. Documented in the UI copy.

### `lib/reflection.js` (new, pure) — Phase 3
- `buildReflection(sessions, { period, nowMs, tz }) → { taskMixOverTime, rhythm, durationTrend, lookbackPeriod }`
- Reuses `classifyAll` (task categories), `rollupByHour` (time-of-day rhythm), `rollupByDay` (trend buckets), and `durationMs`. "Over time" = task-category counts bucketed by day/week within the lookback window.
- Lookback extends the existing period vocabulary to `1mo / 3mo / 6mo / 12mo` (`lib/period.js`).

### Routes (`server.js`)
- `GET /api/code-output?period=` → aggregated `{ linesAdded, linesRemoved, linesNet, byDay[], byProject[], timeSpentMs, byToolBreakdown }`.
- `GET /api/git-value?period=` → `{ enabled, commits, linesCommitted, costPerCommit, byProject[] }` (or `{enabled:false}`).
- `GET /api/reflection?period=` → `{ taskMixOverTime, rhythm, durationTrend }`.
- `POST /api/config/git-value` → `{ enabled: bool }` (opt-in toggle; mirrors `/api/config/alerts`).

### Dashboard (`public/app.js`, `public/index.html`, `public/styles.css`)
- Two new sections under a **Code Insights** area. Follow the existing section render pattern; **surgical value updates on auto-refresh** (landmine #22 — no `innerHTML=` on animated regions). Empty states for new/light installs (ties to review finding #09 — no scary negatives; a "start using Claude Code" empty state).

### Snapshot (`lib/snapshot.js`) — additive
- Add optional top-level keys `codeOutput`, `gitValue` (only when enabled), `reflection`. **schemaVersion STAYS 1** (landmine #37 — additive optional keys; old iOS ignores them). New keys must never emit bare `null` sub-fields that the iOS decoder would choke on (review finding #26 — Phase 4 hardens the decoder; Phase 1-3 publishers must omit-or-default, never null-in-a-typed-slot).

## Phasing (each phase = its own PR(s), buildable independently)

1. **Phase 1 — Code Output (desktop).** `lib/code-output.js` + `summarizeSession` field + `/api/code-output` + dashboard "Code Output" section + snapshot `codeOutput` key. The concrete parity core. No git, no new deps.
2. **Phase 2 — Git Value (desktop, opt-in).** `lib/git-value.js` + config flag + `/api/git-value` + `POST /api/config/git-value` + dashboard "Value" panel + snapshot `gitValue` key. Read-only git.
3. **Phase 3 — Reflection (desktop).** `lib/reflection.js` + period extension + `/api/reflection` + dashboard "How you use Claude Code" section + snapshot `reflection` key.
4. **Phase 4 — iOS surfacing (separate `clauge-ios` release).** iOS reads the three optional keys, adds cards to the Analytics tab. **Bundles the review's P1 #26 fix** (tolerant snapshot decode: optional/lenient forecast-sample fields) since this phase touches that exact contract. Gets its own spec+plan at build time (cross-repo, App Store).

## Out of scope (explicit, with reason)
- **Suggestion accept-rate** — acceptance/rejection is not in the local JSONL. Unreachable.
- **Active users / per-user lines** — single-user tool; org-only concept.
- **PRs merged/opened** — needs GitHub API + the Claude GitHub App. Out.
- **LLM topic-mining / "4D Fluency"** — needs an LLM + Anthropic's proprietary framework. Violates the local/keyless principle.
- **Wellbeing nudges / quiet hours** — deferred (own phase later; reuse alert infra).
- **Per-line Claude-vs-human attribution** — YAGNI; correlation only.

## Testing
- Each new `lib/` module is pure (git-value takes an injected `run`) and unit-tested against JSONL fixtures under `test/`, matching the existing `node --test` pattern (landmine #14 — `test/*.test.js`, not a new dir; landmine #38 — ESM test helpers). 
- `code-output`: fixtures with known Edit/Write/MultiEdit blocks → asserted line counts (incl. non-string/absent guards).
- `git-value`: injected `run` returns canned `git log --numstat` output → asserted correlation; a non-repo cwd → graceful skip; assert no mutating subcommand is ever constructed.
- `reflection`: fixture sessions across days/categories → asserted task-mix-over-time + rhythm buckets.
- Snapshot: extend `test/snapshot*.test.js` to assert new keys present + schemaVersion still 1 + no bare-null typed slots.
- Full gate before each merge: `npm run check` (landmine #29 — validators are a subset; the gate is the full command). New served assets (if any) → both SEA manifests (landmine #2/#39).

## Risks / landmines to honor
- **#22** auto-refresh must not destroy animated children — surgical updates in the new sections.
- **#37 / #42** snapshot schema is a cross-repo contract — additive optional keys only, schemaVersion stays 1, forecast/verbatim rules unchanged.
- **Review #26** (P1) — iOS decode is intolerant of null in typed forecast slots; Phase 1-3 publishers must not introduce new null-in-typed-slot keys, and Phase 4 fixes the decoder.
- **#41** `loadAllSummaries` concurrency cap — the new parse-time field rides the existing bounded walk; don't add an unbounded pass.
- **git-value** spawns a subprocess — read-only subcommand allowlist, per-repo error isolation, timeout; never let a slow/huge repo hang the route (bound it).
