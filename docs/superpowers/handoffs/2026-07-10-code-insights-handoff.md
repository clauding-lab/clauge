# Code Insights — build handoff (for a fresh session)

**Date:** 2026-07-10 · **Status:** spec + plan written, NOT built. Build deferred to a separate session (this is that session's start-here).

## What you're building (30-second version)

New **Code Insights** area in the Clauge desktop dashboard with two sections:
- **Code Output** — lines written (from Edit/Write/MultiEdit tool calls), time spent, and (opt-in) git commit "value".
- **How you use Claude Code** — task-mix over time, when-you-work rhythm, historical lookback. Heuristic + local, **no LLM**.

It mirrors the *locally-reachable* subset of Anthropic's org-only Claude Code analytics dashboard + the new Reflect dashboard. Most of those two surfaces is NOT reachable (org data, server-side chat memory, LLM) — the spec's feasibility map is the authoritative what's-in/what's-out.

## Read these first (in order)
1. **Spec (authoritative):** `docs/superpowers/specs/2026-07-10-code-insights-design.md` — why, decisions locked, feasibility map, architecture, out-of-scope, risks.
2. **Plan (task-by-task):** `docs/superpowers/plans/2026-07-10-code-insights.md` — bite-sized TDD tasks, PR/branch structure, pinned contracts.
3. **AGENTS.md** (repo root) — the 44 landmines. The ones this feature touches: #14 (tests are `test/*.test.js`, not a new dir), #22 (auto-refresh surgical updates), #29 (`npm run check` is the gate), #37/#42 (snapshot cross-repo contract), #41 (bounded parse), #2/#39 (SEA manifests if a new served JS file is added).

## Current repo state
- Branch `feat/code-insights-spec` holds the spec + plan + this handoff (docs only). Baseline was green at write time: `npm test` 475 pass, `cargo test` all pass.
- Nothing in `lib/`, `server.js`, `public/`, or `src-tauri/` has been touched — this is greenfield on top of the existing analytics engine.

## How to execute
- Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans**.
- Build **phase by phase, desktop-first**. Each phase is independent and shippable:
  1. **Phase 1 — Code Output** (no deps, no new libs) — start here.
  2. **Phase 2 — Git Value** (opt-in, read-only git) — depends on Phase 1's dashboard area existing.
  3. **Phase 3 — Reflection** (heuristic, reuses classifier/hour/day rollups).
  4. **Phase 4 — iOS surfacing** — SEPARATE repo (`clauge-ios`) + App Store release; gets its own spec+plan at build time. Bundles the review's P1 #26 snapshot-decode fix.
- Per PR: branch from fresh `main` → implement task-by-task (TDD) → `npm run build:sidecar` → **full `npm run check`** (never claim green off a subset — landmine #29) → `gh pr create` → `gh pr checks --watch` → per-PR merge approval → squash. Never push/merge main directly.

## Decisions already locked (do not re-litigate)
- Both layers, phased. Read-only git allowed. **Heuristic-only, no LLM, no topic-mining.** Nudges deferred. iOS is Phase 4. Commit *correlation*, not per-line attribution.

## The one thing that's easy to get wrong
The Mac→iPhone snapshot (`lib/snapshot.js`) is a **cross-repo contract**. Add the new metrics ONLY as additive optional keys — **schemaVersion stays 1** — and never emit a bare `null` in a slot the iOS decoder types as non-optional (that's the live P1 bug the review found: one null blanks the whole iOS Analytics tab). Phases 1-3 publish the keys; Phase 4 hardens the iOS decoder.

## Verification per phase
Each new `lib/` module is pure and unit-tested against `test/*.test.js` fixtures. After the dashboard section lands, exercise it in a real browser/build (view-layer changes aren't done until seen — the Code Output numbers should match a hand-count on a known session). Snapshot tests assert new keys present + schemaVersion still 1 + no bare-null typed slots.
